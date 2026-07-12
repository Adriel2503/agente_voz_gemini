// Puente de audio bidireccional: Asterisk (integrador) <-> Gemini Live.
// Rama de motor alternativa a audioBridge.js (Ultravox). Porta la logica
// validada en produccion del bridge Go (asterisk-bridge) y del demo Python.
//
//   Asterisk WSS ──mulaw/pcm──► [inQ]──tick 20ms──► PCM16 16k ──► Gemini Live
//   Asterisk WSS ◄──mulaw/pcm──[outQ]◄─tick 20ms◄── PCM16 24k ◄── Gemini Live
//
// Reglas de oro (lecciones del Go):
//  1. SUBIDA SIEMPRE a 50 frames/s: si el cliente calla (o su trunk suprime
//     silencio) se manda silencio digital. Sin stream continuo el VAD de
//     Gemini nunca cierra el turno y la IA no responde.
//  2. BAJADA con writer pautado: Gemini produce el audio en rafagas; se
//     re-trocea en frames de 20 ms para no saturar al cliente.
//  3. Barge-in = vaciar outQ al instante.
//  4. Cerrar SIEMPRE ambos extremos (fuga de sockets = fuga de FDs).
//
// El protocolo hacia el cliente NO cambia respecto de Ultravox: mismos JSON
// (transcript_partial/final, agent_started/stopped_speaking,
// playback_clear_buffer, pong) — el integrador no nota el cambio de motor.
const WebSocket = require("ws");
const { muLawToPcm16, pcm16ToMuLaw } = require("../lib/g711.js");
const { AudioQueue } = require("../lib/audioQueue.js");
const { upsample8to16, Downsampler24a8, Downsampler24a16 } = require("../lib/resample.js");
const { enviarWebhook } = require("../services/webhook.service.js");
const ApiVozModel = require("../models/apiVoz.model.js");
const store = require("../sessions/store.js");
const logger = require("../config/logger.js");
const env = require("../config/env.js");

const TICK_MS = 20; // 50 fps, igual que el bridge Go

// Cotas de las colas (red de seguridad de memoria, leccion de produccion:
// "cap de buffers por sesion"). outQ puede acumular varios segundos porque
// Gemini genera mas rapido que tiempo real; inQ deberia estar siempre drenada.
const OUT_Q_MAX_BYTES = 4 * 1024 * 1024; // ~2 min de audio 16k
const IN_Q_MAX_BYTES = 512 * 1024; // ~16 s de audio 16k

// Restriccion de Gemini: los modelos native-audio solo aceptan es-US para
// espanol (port de audio.py::normalize_language_code del demo Python).
function normalizarLenguaje(lang, model) {
  const l = String(lang || "es-ES").trim();
  if (/native-audio/.test(model) && /^es/i.test(l)) return "es-US";
  const alias = { es: "es-ES", en: "en-US", pt: "pt-BR" };
  return alias[l] || l;
}

// Config de la sesion Live (port de session.py::_build_config, mismos campos
// camelCase). VAD automatico con interrupcion (barge-in server-side),
// transcripcion en ambas direcciones y compresion de contexto.
function construirLiveConfig(geminiConfig) {
  return {
    systemInstruction: geminiConfig.systemPrompt,
    responseModalities: ["AUDIO"],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: geminiConfig.voice } },
      languageCode: normalizarLenguaje(env.gemini.language, geminiConfig.model),
    },
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        prefixPaddingMs: env.gemini.vadPrefixMs,
        silenceDurationMs: env.gemini.vadSilenceMs,
      },
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
    },
    ...(env.gemini.transcribe
      ? { inputAudioTranscription: {}, outputAudioTranscription: {} }
      : {}),
    contextWindowCompression: {
      triggerTokens: env.gemini.contextTriggerTokens,
      slidingWindow: { targetTokens: env.gemini.contextTargetTokens },
    },
  };
}

async function manejarConexion(asteriskWs, sesion) {
  const iniciadoEn = Date.now();
  store.actualizar(sesion.session_id, { conectado: true, estado: "conectada" });

  const cfg = sesion.geminiConfig || {};
  const esMulaw = sesion.codec === "mulaw_8k";
  // Frame de 20 ms del lado cliente: 320 B @ 8 kHz o 640 B @ 16 kHz.
  const frameBytes = sesion.sampleRate === 8000 ? 320 : 640;
  const SILENCIO = Buffer.alloc(frameBytes);

  const inQ = new AudioQueue(); // cliente -> Gemini (PCM al rate del cliente)
  const outQ = new AudioQueue(); // Gemini -> cliente (PCM ya al rate del cliente)
  const downsampler = sesion.sampleRate === 8000 ? new Downsampler24a8() : new Downsampler24a16();

  let session = null; // sesion Live del SDK
  let listo = false; // setupComplete recibido: arrancan las bombas
  let cerrado = false;
  let agenteHablando = false;
  let tickTimer = null;
  let maxCallTimer = null;

  // Transcripcion acumulada por turno (los fragmentos llegan incrementales).
  let turnoUser = "";
  let turnoIA = "";
  sesion.transcripcion = []; // para GET /transcripcion (Gemini no tiene REST de mensajes)

  // Contadores de diagnostico (mismos del RESUMEN del bridge Go).
  let framesUp = 0;
  let silenceUp = 0;
  let audioMsgsDown = 0;
  let bytesDown = 0;
  let framesWritten = 0;

  const enviarAsterisk = (obj) => {
    if (asteriskWs.readyState === WebSocket.OPEN) {
      asteriskWs.isAlive = true; // pumpear datos hacia el cliente = sigue viva
      asteriskWs.send(JSON.stringify(obj));
    }
  };

  const registrarTranscript = (rol, texto) => {
    if (!texto) return;
    logger.info(`[gemini] transcript final sesion=${sesion.session_id} rol=${rol} texto="${texto}"`);
    sesion.transcripcion.push({ rol, ts: (Date.now() - iniciadoEn) / 1000, texto });
    enviarAsterisk({ type: "transcript_final", rol, texto });
  };

  // El usuario termino su turno cuando el agente empieza a responder.
  const finalizarTurnoUsuario = () => {
    if (!turnoUser) return;
    registrarTranscript("usuario", turnoUser.trim());
    turnoUser = "";
  };

  const finalizarTurnoIA = () => {
    if (!turnoIA) return;
    registrarTranscript("agente", turnoIA.trim());
    turnoIA = "";
  };

  const cerrar = (motivo) => {
    if (cerrado) return;
    cerrado = true;
    const duracionSegundos = Math.max(0, Math.round((Date.now() - iniciadoEn) / 1000));
    logger.info(
      `[gemini] cerrando sesion=${sesion.session_id} motivo=${motivo} duracion=${duracionSegundos}s ` +
      `RESUMEN frames_subida=${framesUp} silencio_relleno=${silenceUp} audio_msgs_gemini=${audioMsgsDown} ` +
      `bytes_gemini=${bytesDown} frames_a_cliente=${framesWritten}`
    );
    store.actualizar(sesion.session_id, { estado: "finalizada", duracionSegundos });

    if (tickTimer) clearInterval(tickTimer);
    if (maxCallTimer) clearTimeout(maxCallTimer);
    finalizarTurnoUsuario();
    finalizarTurnoIA();
    // Cerrar SIEMPRE ambos extremos (leccion de produccion: fuga de FDs).
    try { asteriskWs.close(); } catch (_) {}
    try { if (session) session.close(); } catch (_) {}
    inQ.clear();
    outQ.clear();

    (async () => {
      try {
        await new ApiVozModel().upsertSesion(sesion.idEmpresa, {
          session_id: sesion.session_id,
          estado: "ended",
          motivo_fin: motivo,
          duracion_segundos: duracionSegundos,
          // Trazabilidad del motor sin cambio de schema (columna metadata jsonb).
          metadata: { ...(sesion.metadata || {}), motor: "gemini" },
          fecha_fin: new Date().toISOString(),
        });
      } catch (e) {
        logger.error(`[gemini] upsert ended: ${e.message}`);
      }
      if (sesion.webhook) {
        enviarWebhook(sesion.webhook, "session.ended", {
          session_id: sesion.session_id,
          metadata: sesion.metadata,
          variables: sesion.variables || {},
          resumen: { duracion_segundos: duracionSegundos, tipificacion: null, agendamiento: null },
        });
      }
      store.eliminar(sesion.session_id);
    })();
  };

  store.actualizar(sesion.session_id, { cerrar }); // para POST /terminar

  // ---- Bomba unica de 20 ms: subida (con silence-fill) + bajada (pautada) ----
  const arrancarBombas = () => {
    if (tickTimer || cerrado) return;
    // Descarta el backlog acumulado mientras Gemini abria (~1-3 s): mandarlo en
    // rafaga rompe el VAD (equivalente al drainConn del Go).
    inQ.clear();
    tickTimer = setInterval(() => {
      // `session` puede no estar asignada aun si setupComplete llego antes de
      // que resolviera el await de connect (carrera de microtasks): saltar tick.
      if (cerrado || !session) return;
      // SUBIDA: frame real o silencio digital, SIEMPRE (regla de oro #1).
      let frame = inQ.popFrame(frameBytes);
      if (frame === null) {
        frame = SILENCIO;
        silenceUp++;
      } else {
        framesUp++;
      }
      const audio16k = sesion.sampleRate === 8000 ? upsample8to16(frame) : frame;
      try {
        session.sendRealtimeInput({
          audio: { data: audio16k.toString("base64"), mimeType: "audio/pcm;rate=16000" },
        });
      } catch (e) {
        logger.warn(`[gemini] sendRealtimeInput: ${e.message}`);
        cerrar("gemini_send_error");
        return;
      }
      // BAJADA: un frame por tick; si no hay audio pendiente, nada (el cliente
      // no necesita stream continuo).
      const out = outQ.popFrame(frameBytes);
      if (out && asteriskWs.readyState === WebSocket.OPEN) {
        asteriskWs.isAlive = true;
        asteriskWs.send(esMulaw ? pcm16ToMuLaw(out) : out);
        framesWritten++;
      }
    }, TICK_MS);
  };

  // ---- Eventos de Gemini (port de events.py + pump_down del server Python) ----
  const onMensajeGemini = (msg) => {
    if (cerrado) return;

    if (msg.setupComplete) {
      listo = true;
      logger.info(`[gemini] sesion lista sesion=${sesion.session_id} model=${cfg.model}`);
      arrancarBombas();
      return;
    }

    const sc = msg.serverContent;
    if (sc) {
      // Barge-in: vaciar la cola de bajada YA + avisar al integrador que
      // vacie su propia cola de reproduccion.
      if (sc.interrupted) {
        logger.info(`[gemini] barge-in sesion=${sesion.session_id}; vaciando cola`);
        outQ.clear();
        enviarAsterisk({ type: "playback_clear_buffer" });
        finalizarTurnoIA();
        if (agenteHablando) {
          agenteHablando = false;
          enviarAsterisk({ type: "agent_stopped_speaking" });
        }
      }

      // Transcripcion del usuario (fragmentos incrementales).
      if (sc.inputTranscription?.text) {
        turnoUser += sc.inputTranscription.text;
        enviarAsterisk({ type: "transcript_partial", rol: "usuario", texto: turnoUser });
      }

      // Transcripcion de la IA. Su primer fragmento marca que el agente
      // empezo a responder => el turno del usuario quedo cerrado.
      if (sc.outputTranscription?.text) {
        finalizarTurnoUsuario();
        turnoIA += sc.outputTranscription.text;
        enviarAsterisk({ type: "transcript_partial", rol: "agente", texto: turnoIA });
      }

      // Audio de respuesta: 24 kHz -> rate del cliente -> outQ (writer pautado).
      const parts = sc.modelTurn?.parts || [];
      for (const p of parts) {
        if (!p.inlineData?.data) continue;
        finalizarTurnoUsuario();
        const pcm24k = Buffer.from(p.inlineData.data, "base64");
        audioMsgsDown++;
        bytesDown += pcm24k.length;
        outQ.push(downsampler.process(pcm24k));
        if (outQ.length > OUT_Q_MAX_BYTES) {
          logger.warn(`[gemini] outQ supero el tope (${outQ.length}B); vaciando sesion=${sesion.session_id}`);
          outQ.clear();
        }
        if (!agenteHablando) {
          agenteHablando = true;
          enviarAsterisk({ type: "agent_started_speaking" });
        }
      }

      if (sc.turnComplete || sc.generationComplete) {
        finalizarTurnoIA();
        if (agenteHablando) {
          agenteHablando = false;
          enviarAsterisk({ type: "agent_stopped_speaking" });
        }
      }
    }

    if (msg.goAway) {
      logger.warn(`[gemini] go_away sesion=${sesion.session_id} timeLeft=${msg.goAway.timeLeft || "?"}`);
      cerrar("gemini_go_away");
      return;
    }
    if (msg.sessionResumptionUpdate?.newHandle) {
      // Reconexion transparente = Fase 2; por ahora solo trazamos el handle.
      sesion.geminiResumptionHandle = msg.sessionResumptionUpdate.newHandle;
    }
  };

  // ---- Mensajes del cliente (mismo switch que el camino Ultravox) ----
  asteriskWs.on("message", (data, isBinary) => {
    if (cerrado) return;
    if (isBinary) {
      // Audio del caller al rate acordado; se encola y la bomba lo sube pautado.
      inQ.push(esMulaw ? muLawToPcm16(data) : data);
      if (inQ.length > IN_Q_MAX_BYTES) {
        logger.warn(`[gemini] inQ supero el tope; vaciando sesion=${sesion.session_id}`);
        inQ.clear();
      }
      return;
    }
    let ctrl;
    try { ctrl = JSON.parse(data.toString()); } catch { return; }
    switch (ctrl.type) {
      case "session_end":
        // Sin tools en el MVP no hay tipificacion que esperar: cierre directo.
        logger.info(`[gemini] session_end del cliente sesion=${sesion.session_id} payload=${JSON.stringify(ctrl)}`);
        cerrar(ctrl.motivo || "hangup_caller");
        break;
      case "ping":
        enviarAsterisk({ type: "pong" });
        break;
      case "user_text":
        if (session && ctrl.text) {
          try { session.sendRealtimeInput({ text: String(ctrl.text) }); } catch (e) {
            logger.warn(`[gemini] user_text: ${e.message}`);
          }
        }
        break;
      case "dtmf":
        // TODO: sin equivalente directo en Gemini Live (Fase 2 si se necesita).
        break;
      default:
        break;
    }
  });

  asteriskWs.on("close", () => cerrar("asterisk_close"));
  asteriskWs.on("error", (e) => { logger.warn(`[gemini] asterisk error: ${e.message}`); cerrar("asterisk_error"); });

  // ---- Abrir la sesion Gemini Live ----
  try {
    // Import perezoso: si ENGINE=ultravox este modulo nunca carga el SDK.
    const { GoogleGenAI } = require("@google/genai");
    const ai = new GoogleGenAI({ apiKey: env.gemini.apiKey });
    session = await ai.live.connect({
      model: cfg.model,
      config: construirLiveConfig(cfg),
      callbacks: {
        onopen: () => {
          store.actualizar(sesion.session_id, { estado: "en_curso" });
          if (sesion.webhook) {
            enviarWebhook(sesion.webhook, "session.connected", {
              session_id: sesion.session_id,
              variables: sesion.variables || {},
            });
          }
        },
        onmessage: onMensajeGemini,
        onerror: (e) => { logger.warn(`[gemini] error WS: ${e?.message || e}`); cerrar("gemini_error"); },
        onclose: (e) => { if (!cerrado) logger.info(`[gemini] WS cerrado (${e?.reason || "sin motivo"})`); cerrar("gemini_close"); },
      },
    });
  } catch (e) {
    logger.error(`[gemini] connect fallo sesion=${sesion.session_id}: ${e.message}`);
    cerrar("gemini_connect_error");
    return;
  }
  if (cerrado) { try { session.close(); } catch (_) {} return; }

  // Texto a mitad de sesion (contrato sendDataMessage del service).
  sesion.engineEnviarTexto = (text) => {
    if (cerrado || !session) return;
    try { session.sendRealtimeInput({ text: String(text) }); } catch (e) {
      logger.warn(`[gemini] engineEnviarTexto: ${e.message}`);
    }
  };

  // Saludo inicial: trigger como TEXTO (esquiva el VAD, que solo oye audio).
  if (env.gemini.greetFirst) {
    try { session.sendRealtimeInput({ text: env.gemini.greetingTrigger }); } catch (e) {
      logger.warn(`[gemini] greet: ${e.message}`);
    }
  }

  // Fallback por si el setupComplete no llega como mensaje separado en esta
  // version del SDK: arrancar igual a los 3 s de conectar.
  setTimeout(() => {
    if (!listo && !cerrado) {
      logger.warn(`[gemini] setupComplete no visto; arrancando bombas por fallback sesion=${sesion.session_id}`);
      arrancarBombas();
    }
  }, 3000);

  // Red de seguridad: corte duro por duracion maxima (evita sesiones zombie).
  maxCallTimer = setTimeout(() => cerrar("max_call_seconds"), env.gemini.maxCallSeconds * 1000);
}

module.exports = { manejarConexion, construirLiveConfig };
