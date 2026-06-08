// Puente de audio bidireccional: Asterisk (integrador) <-> Ultravox (joinUrl).
//
//   Asterisk WSS  ──audio mulaw/pcm──►  [bridge]  ──PCM s16le──►  Ultravox joinUrl
//   Asterisk WSS  ◄──audio mulaw/pcm──  [bridge]  ◄──PCM s16le──  Ultravox joinUrl
//
// Audio Ultravox = PCM s16le al sampleRate acordado. Si el integrador usa
// mulaw_8k convertimos con G.711. Los data-messages JSON usan los `type` reales
// del voice-backend: transcript / state / user_started_speaking /
// user_stopped_speaking / playback_clear_buffer / toolUsed.
const WebSocket = require("ws");
const { muLawToPcm16, pcm16ToMuLaw } = require("../lib/g711.js");
const { enviarWebhook } = require("../services/webhook.service.js");
const ultravox = require("../services/ultravox.service.js");
const ApiVozModel = require("../models/apiVoz.model.js");
const store = require("../sessions/store.js");
const logger = require("../config/logger.js");

function manejarConexion(asteriskWs, sesion) {
  const iniciadoEn = Date.now();
  store.actualizar(sesion.session_id, { conectado: true, estado: "conectada" });

  const ultravoxWs = new WebSocket(sesion.joinUrl);
  const esMulaw = sesion.codec === "mulaw_8k";
  let cerrado = false;
  let agenteHablando = false;
  let hangupAvisado = false;

  const enviarAsterisk = (obj) => {
    if (asteriskWs.readyState === WebSocket.OPEN) {
      asteriskWs.isAlive = true; // pumpear audio/datos hacia el cliente = sigue viva
      asteriskWs.send(JSON.stringify(obj));
    }
  };

  // Pide a Ultravox que tipifique y cuelgue cuando el caller corta (external-media:1077).
  const avisarHangup = () => {
    if (hangupAvisado || !sesion.callId) return;
    hangupAvisado = true;
    ultravox.sendDataMessage(sesion.apiKey, sesion.callId, {
      type: "user_text_message",
      text: "El usuario ha colgado la llamada. Tipifica la llamada con la información recopilada y cuelga.",
      urgency: "now",
    });
  };

  const cerrar = (motivo) => {
    if (cerrado) return;
    cerrado = true;
    const duracionSegundos = Math.max(0, Math.round((Date.now() - iniciadoEn) / 1000));
    logger.info(`[bridge] cerrando sesion=${sesion.session_id} motivo=${motivo} duracion=${duracionSegundos}s`);
    store.actualizar(sesion.session_id, { estado: "finalizada", duracionSegundos });
    try { asteriskWs.close(); } catch (_) {}
    try { ultravoxWs.close(); } catch (_) {}

    new ApiVozModel()
      .upsertSesion(sesion.idEmpresa, {
        session_id: sesion.session_id,
        estado: "ended",
        motivo_fin: motivo,
        duracion_segundos: duracionSegundos,
        fecha_fin: new Date().toISOString(),
      })
      .catch((e) => logger.error(`[bridge] upsert ended: ${e.message}`));

    if (sesion.webhook) {
      enviarWebhook(sesion.webhook, "session.ended", {
        session_id: sesion.session_id,
        metadata: sesion.metadata,
        resumen: { duracion_segundos: duracionSegundos, tipificacion: sesion.tipificacionFinal || null },
      });
    }
    store.eliminar(sesion.session_id);
  };
  store.actualizar(sesion.session_id, { cerrar }); // para POST /terminar

  // --- Ultravox -> Asterisk ---
  ultravoxWs.on("open", () => {
    store.actualizar(sesion.session_id, { estado: "en_curso" });
    if (sesion.webhook) enviarWebhook(sesion.webhook, "session.connected", { session_id: sesion.session_id });
  });

  ultravoxWs.on("message", (data, isBinary) => {
    if (isBinary) {
      const salida = esMulaw ? pcm16ToMuLaw(data) : data;
      if (asteriskWs.readyState === WebSocket.OPEN) {
        asteriskWs.isAlive = true; // audio del agente saliendo = sigue viva
        asteriskWs.send(salida);
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case "transcript": {
        const rol = (msg.role === "agent" || /AGENT/i.test(msg.role)) ? "agente" : "usuario";
        enviarAsterisk(
          msg.final
            ? { type: "transcript_final", rol, texto: msg.text, ts: msg.timespan?.start }
            : { type: "transcript_partial", rol, texto: msg.text }
        );
        break;
      }
      case "state": {
        const hablando = msg.state === "speaking";
        if (hablando !== agenteHablando) {
          agenteHablando = hablando;
          enviarAsterisk({ type: hablando ? "agent_started_speaking" : "agent_stopped_speaking" });
        }
        break;
      }
      case "playback_clear_buffer":
        // Barge-in: el integrador debe vaciar su cola de reproducción hacia el caller.
        enviarAsterisk({ type: "playback_clear_buffer" });
        break;
      case "toolUsed":
      case "tool":
        enviarAsterisk({ type: "tool_call", name: msg.toolName || msg.name, args: msg.parameters || msg.args });
        if (sesion.webhook) {
          enviarWebhook(sesion.webhook, "session.tool_call", {
            session_id: sesion.session_id,
            tool: { name: msg.toolName || msg.name, args: msg.parameters || msg.args },
          });
        }
        break;
      case "user_started_speaking":
      case "user_stopped_speaking":
      default:
        break;
    }
  });

  ultravoxWs.on("close", () => cerrar("ultravox_close"));
  ultravoxWs.on("error", (e) => { logger.warn(`[bridge] ultravox error: ${e.message}`); cerrar("ultravox_error"); });

  // --- Asterisk -> Ultravox ---
  asteriskWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (ultravoxWs.readyState !== WebSocket.OPEN) return;
      ultravoxWs.send(esMulaw ? muLawToPcm16(data) : data);
      return;
    }
    let ctrl;
    try { ctrl = JSON.parse(data.toString()); } catch { return; }
    switch (ctrl.type) {
      case "session_end":
        avisarHangup();
        cerrar(ctrl.motivo || "hangup_caller");
        break;
      case "ping":
        enviarAsterisk({ type: "pong" });
        break;
      case "user_text":
        ultravox.sendDataMessage(sesion.apiKey, sesion.callId, { type: "user_text_message", text: ctrl.text });
        break;
      case "dtmf":
        // TODO: mapear DTMF a Ultravox si se requiere.
        break;
      default:
        break;
    }
  });

  asteriskWs.on("close", () => { avisarHangup(); cerrar("asterisk_close"); });
  asteriskWs.on("error", (e) => { logger.warn(`[bridge] asterisk error: ${e.message}`); cerrar("asterisk_error"); });
}

module.exports = { manejarConexion };
