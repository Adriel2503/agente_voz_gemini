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

  // Ultravox manda los args de la tool como objeto o como string JSON.
  const parsearArgs = (raw) => {
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw); } catch { return {}; }
  };

  // Captura la tipificacion elegida por el agente y la persiste en la sesion.
  // El catalogo (sesion.tipificaciones) mapea el id a su nombre legible.
  const capturarTipificacion = (args) => {
    const idTip = Number(args?.id_tipificacion_llamada);
    if (!Number.isInteger(idTip) || idTip <= 0) {
      logger.warn(`[bridge] tipificarLlamada sin id valido sesion=${sesion.session_id} args=${JSON.stringify(args)}`);
      return;
    }
    const cat = (sesion.tipificaciones || []).find((t) => Number(t.id) === idTip) || null;
    sesion.tipificacionFinal = {
      id: idTip,
      nombre: cat?.nombre || null,
      equivalencia: cat?.equivalencia ?? null,
      codigo_homologacion: cat?.codigo_homologacion_api_agente ?? null,
    };
    logger.info(`[bridge] tipificacion capturada sesion=${sesion.session_id} id=${idTip} nombre="${cat?.nombre || ''}" homologacion="${cat?.codigo_homologacion_api_agente || ''}"`);

    new ApiVozModel()
      .upsertSesion(sesion.idEmpresa, {
        session_id: sesion.session_id,
        estado: sesion.estado || "en_curso",
        id_tipificacion: idTip,
        tipificacion: sesion.tipificacionFinal,
      })
      .catch((e) => logger.error(`[bridge] upsert tipificacion: ${e.message}`));
  };

  // Captura la cita que el agente agenda (tool agendar_cita_target) y la
  // persiste en agendamiento_agente_voz, ligada a la sesion de voz.
  const capturarAgendamiento = (args) => {
    const tienda = (args?.tienda ?? "").toString().trim() || null;
    const fecha = (args?.fecha ?? "").toString().trim() || null;
    const hora = (args?.hora ?? "").toString().trim() || null;
    const agencia = (args?.agencia ?? "").toString().trim() || null;
    if (!tienda || !fecha || !hora) {
      logger.warn(`[bridge] agendar_cita_target incompleto sesion=${sesion.session_id} args=${JSON.stringify(args)}`);
      return;
    }
    sesion.agendamientoFinal = { tienda, agencia, fecha, hora };
    new ApiVozModel()
      .crearAgendamiento({
        session_id: sesion.session_id,
        idEmpresa: sesion.idEmpresa,
        tienda,
        agencia,
        fecha,
        hora,
      })
      .then((id) => logger.info(`[bridge] agendamiento guardado sesion=${sesion.session_id} id=${id} tienda="${tienda}" agencia="${agencia || ''}" ${fecha} ${hora}`))
      .catch((e) => logger.error(`[bridge] crear agendamiento: ${e.message}`));
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
        id_tipificacion: sesion.tipificacionFinal?.id || null,
        tipificacion: sesion.tipificacionFinal || null,
        fecha_fin: new Date().toISOString(),
      })
      .catch((e) => logger.error(`[bridge] upsert ended: ${e.message}`));

    if (sesion.webhook) {
      enviarWebhook(sesion.webhook, "session.ended", {
        session_id: sesion.session_id,
        metadata: sesion.metadata,
        resumen: { duracion_segundos: duracionSegundos, tipificacion: sesion.tipificacionFinal || null, agendamiento: sesion.agendamientoFinal || null },
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
        if (msg.final) logger.info(`[bridge] transcript final sesion=${sesion.session_id} rol=${rol} texto="${msg.text}"`);
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
      case "tool": {
        const toolName = msg.toolName || msg.name;
        const toolArgs = parsearArgs(msg.parameters || msg.args);
        logger.info(`[bridge] tool del agente sesion=${sesion.session_id} name=${toolName} args=${JSON.stringify(toolArgs)}`);
        enviarAsterisk({ type: "tool_call", name: toolName, args: toolArgs });
        if (toolName === "tipificarLlamada") capturarTipificacion(toolArgs);
        if (toolName === "agendar_cita_target") capturarAgendamiento(toolArgs);
        if (sesion.webhook) {
          enviarWebhook(sesion.webhook, "session.tool_call", {
            session_id: sesion.session_id,
            tool: { name: toolName, args: toolArgs },
          });
        }
        break;
      }
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
        // PRUEBA: ignoramos el session_end del cliente para descartar que el corte
        // venga de la app puente. Dejamos solo el log para ver quien lo manda y cuando.
        // Si la llamada YA NO se corta, el origen es la app puente del integrador.
        logger.info(`[bridge] session_end recibido del cliente (IGNORADO en modo prueba) sesion=${sesion.session_id} payload=${JSON.stringify(ctrl)}`);
        // avisarHangup();
        // cerrar(ctrl.motivo || "hangup_caller");
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
