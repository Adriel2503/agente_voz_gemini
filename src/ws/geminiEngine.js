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
const { traducirTools, ejecutarTool, debeColgar, TOOL_HANGUP, HANGUP_MAX_MS } = require("../tools/geminiTools.js");
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
// `functionDeclarations` (opcional): tools traducidas por geminiTools.js.
function construirLiveConfig(geminiConfig, functionDeclarations = []) {
  return {
    ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {}),
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
  // Tools: declaraciones para Gemini + mapa de ejecucion HTTP (Fase 2).
  // hangUp se inyecta aparte: es local (sin HTTP) y va siempre, como hacia
  // ultravox.service.js. Sin ella el agente se despide y la llamada queda
  // abierta hasta que cuelgue el cliente o venza MAX_CALL_SECONDS.
  const { functionDeclarations, ejecutables } = traducirTools(cfg.selectedTools || []);
  functionDeclarations.push(TOOL_HANGUP);
  const esMulaw = sesion.codec === "mulaw_8k";
  // Frame de 20 ms del lado cliente: 320 B @ 8 kHz o 640 B @ 16 kHz.
  const frameBytes = sesion.sampleRate === 8000 ? 320 : 640;
  const SILENCIO = Buffer.alloc(frameBytes);
  // Silencio de bajada precomputado EN EL CODEC DEL CLIENTE. OJO: en mulaw el
  // silencio NO es 0x00 (eso decodifica a fondo de escala = zumbido); es
  // pcm16ToMuLaw(ceros) = 0xFF. En PCM crudo los ceros ya son silencio real.
  // Se calcula una sola vez (no reencodear 50 veces/seg).
  const bajadaSilencio = env.gemini.downlinkSilence;
  const SILENCIO_BAJADA = esMulaw ? pcm16ToMuLaw(SILENCIO) : SILENCIO;

  const inQ = new AudioQueue(); // cliente -> Gemini (PCM al rate del cliente)
  const outQ = new AudioQueue(); // Gemini -> cliente (PCM ya al rate del cliente)
  const downsampler = sesion.sampleRate === 8000 ? new Downsampler24a8() : new Downsampler24a16();

  let session = null; // sesion Live del SDK (la conexion activa)
  let genConn = 0; // generacion de la conexion activa: los callbacks capturan su
                   // id y se ignoran si dejaron de ser la activa (guard de reconexion).
  let reconectando = false; // swap de reconexion en curso: pausa la subida.
  let listo = false; // setupComplete recibido: arrancan las bombas
  let cerrado = false;
  let finalizando = false;
  let hangupAvisado = false;
  let agenteHablando = false;
  let tickTimer = null;
  let maxCallTimer = null;

  // Colgado pedido por el agente (tool hangUp): no se cierra en el acto, se
  // drena outQ para no cortarle la despedida al cliente (ver debeColgar).
  let colgarPendiente = false;
  let colgarLimite = 0;
  let ultimoAudioEn = 0;

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
  let framesSilencioBajada = 0;
  let reconexiones = 0;
  // Detalle crudo del ultimo cierre/error de Gemini (code + reason del WS, o
  // message del onerror). Se persiste en metadata para diagnosticar el motivo
  // real del gemini_close (p.ej. RESOURCE_EXHAUSTED / TPM) sin depender de los
  // logs. Ver docs/keys-gemini-por-empresa.md ("Observabilidad para decidir").
  let cierreDetalle = null;

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

  // Captura la tipificacion elegida por el agente (mismo criterio que el
  // camino Ultravox): el catalogo sesion.tipificaciones mapea id -> nombre.
  const capturarTipificacion = (args) => {
    const idTip = Number(args?.id_tipificacion_llamada);
    if (!Number.isInteger(idTip) || idTip <= 0) {
      logger.warn(`[gemini] tipificarLlamada sin id valido sesion=${sesion.session_id} args=${JSON.stringify(args)}`);
      return;
    }
    const cat = (sesion.tipificaciones || []).find((t) => Number(t.id) === idTip) || null;
    sesion.tipificacionFinal = {
      id: idTip,
      nombre: cat?.nombre || null,
      equivalencia: cat?.equivalencia ?? null,
      codigo_homologacion: cat?.codigo_homologacion_api_agente ?? null,
    };
    logger.info(`[gemini] tipificacion capturada sesion=${sesion.session_id} id=${idTip} nombre="${cat?.nombre || ""}"`);
  };

  // Captura la cita agendada (tool agendar_cita). La persistencia en BD la
  // hace app-api al ejecutarse la tool; aqui solo estado en memoria para el
  // webhook session.ended y la transcripcion REST.
  const capturarAgendamiento = (args) => {
    const tienda = (args?.tienda ?? "").toString().trim() || null;
    const fecha = (args?.fecha ?? "").toString().trim() || null;
    const hora = (args?.hora ?? "").toString().trim() || null;
    const agencia = (args?.agencia ?? "").toString().trim() || null;
    if (!tienda || !fecha || !hora) {
      logger.warn(`[gemini] agendar_cita incompleto sesion=${sesion.session_id} args=${JSON.stringify(args)}`);
      return;
    }
    sesion.agendamientoFinal = { tienda, agencia, fecha, hora };
    logger.info(`[gemini] agendamiento capturado sesion=${sesion.session_id} tienda="${tienda}" ${fecha} ${hora}`);
  };

  // Ejecuta los toolCalls del modelo: el gateway hace el HTTP (a diferencia de
  // Ultravox, que lo ejecutaba por su cuenta) y devuelve el resultado con
  // sendToolResponse para que el agente continue hablando.
  const manejarToolCalls = async (calls) => {
    const functionResponses = [];
    for (const c of calls) {
      const nombre = c.name;
      const args = c.args || {};
      logger.info(`[gemini] tool del agente sesion=${sesion.session_id} name=${nombre} args=${JSON.stringify(args)}`);
      enviarAsterisk({ type: "tool_call", name: nombre, args });
      if (sesion.webhook) {
        enviarWebhook(sesion.webhook, "session.tool_call", {
          session_id: sesion.session_id,
          variables: sesion.variables || {},
          tool: { name: nombre, args },
        });
      }
      if (nombre === "tipificarLlamada") capturarTipificacion(args);
      if (nombre === "agendar_cita") capturarAgendamiento(args);

      // hangUp: tool LOCAL, no hay HTTP que ejecutar. Se marca y la bomba
      // cierra cuando termine de entregar la despedida (debeColgar).
      // A PROPOSITO no se responde el functionCall: un {ok:true} arrancaria un
      // turno nuevo del modelo ("listo, gracias"), llegaria audio nuevo y el
      // drenaje no convergeria nunca. Sin respuesta, el modelo se calla.
      if (nombre === "hangUp") {
        colgarPendiente = true;
        colgarLimite = Date.now() + HANGUP_MAX_MS;
        logger.info(`[gemini] hangUp del agente sesion=${sesion.session_id}: drenando audio antes de cerrar`);
        continue;
      }

      const ejecutable = ejecutables.get(nombre);
      const response = ejecutable
        ? await ejecutarTool(ejecutable, nombre, args)
        : { ok: false, error: `tool desconocida: ${nombre}` };
      if (!ejecutable) logger.warn(`[gemini] toolCall a tool no declarada: ${nombre}`);
      functionResponses.push({ id: c.id, name: nombre, response });
    }
    // Vacio = el batch era solo hangUp: no hay nada que responder.
    if (cerrado || !session || functionResponses.length === 0) return;
    try {
      session.sendToolResponse({ functionResponses });
    } catch (e) {
      logger.warn(`[gemini] sendToolResponse: ${e.message}`);
    }
  };

  const cerrar = (motivo) => {
    if (cerrado) return;
    cerrado = true;
    const duracionSegundos = Math.max(0, Math.round((Date.now() - iniciadoEn) / 1000));
    logger.info(
      `[gemini] cerrando sesion=${sesion.session_id} motivo=${motivo} duracion=${duracionSegundos}s ` +
      `RESUMEN frames_subida=${framesUp} silencio_relleno=${silenceUp} audio_msgs_gemini=${audioMsgsDown} ` +
      `bytes_gemini=${bytesDown} frames_a_cliente=${framesWritten} silencio_bajada=${framesSilencioBajada} ` +
      `reconexiones=${reconexiones}`
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
      const apiVoz = new ApiVozModel();

      // Respaldo: la tool tipificarLlamada persiste en BD via app-api; si el
      // toolCall no llego a capturarse en memoria, la leemos de ahi (mismo
      // mecanismo que el camino Ultravox).
      if (!sesion.tipificacionFinal) {
        try {
          const idTip = await apiVoz.getIdTipificacionBySession(sesion.session_id);
          if (idTip) {
            const cat = (sesion.tipificaciones || []).find((t) => Number(t.id) === Number(idTip)) || null;
            sesion.tipificacionFinal = {
              id: Number(idTip),
              nombre: cat?.nombre || null,
              equivalencia: cat?.equivalencia ?? null,
              codigo_homologacion: cat?.codigo_homologacion_api_agente ?? null,
            };
            logger.info(`[gemini] tipificacion recuperada de BD sesion=${sesion.session_id} id=${idTip}`);
          }
        } catch (e) {
          logger.warn(`[gemini] leer tipificacion BD: ${e.message}`);
        }
      }
      if (!sesion.agendamientoFinal) {
        try {
          const cita = await apiVoz.getAgendamientoBySession(sesion.session_id);
          if (cita) {
            sesion.agendamientoFinal = {
              tienda: cita.tienda ?? null,
              agencia: cita.agencia ?? null,
              fecha: cita.fecha ?? null,
              hora: cita.hora ?? null,
            };
            logger.info(`[gemini] agendamiento recuperado de BD sesion=${sesion.session_id}`);
          }
        } catch (e) {
          logger.warn(`[gemini] leer agendamiento BD: ${e.message}`);
        }
      }

      try {
        await apiVoz.upsertSesion(sesion.idEmpresa, {
          session_id: sesion.session_id,
          estado: "ended",
          motivo_fin: motivo,
          duracion_segundos: duracionSegundos,
          id_tipificacion: sesion.tipificacionFinal?.id || null,
          tipificacion: sesion.tipificacionFinal || null,
          // Trazabilidad del motor sin cambio de schema (columna metadata jsonb).
          // cierre_detalle guarda el code/reason crudo de Gemini para diagnosticar
          // los gemini_close (TPM/quota) desde la BD; reconexiones cuenta los swaps
          // por goAway. Ambos son opcionales: se omiten si no aplican.
          metadata: {
            ...(sesion.metadata || {}),
            motor: "gemini",
            ...(cierreDetalle ? { cierre_detalle: cierreDetalle } : {}),
            ...(reconexiones ? { reconexiones } : {}),
          },
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
          resumen: {
            duracion_segundos: duracionSegundos,
            tipificacion: sesion.tipificacionFinal || null,
            agendamiento: sesion.agendamientoFinal || null,
          },
        });
      }
      store.eliminar(sesion.session_id);
    })();
  };

  // Al colgar el caller, avisa al agente para que tipifique antes del cierre.
  // El relleno de silencio mantiene vivo el stream aunque el cliente ya no
  // mande audio, asi Gemini puede responder y disparar tipificarLlamada.
  const avisarHangup = () => {
    if (hangupAvisado || !session) return;
    hangupAvisado = true;
    try {
      session.sendRealtimeInput({
        text: "El usuario ha colgado la llamada. Tipifica la llamada con la informacion recopilada.",
      });
    } catch (e) {
      logger.warn(`[gemini] avisarHangup: ${e.message}`);
    }
  };

  // Cierre por colgado del caller con ventana de gracia (port del camino
  // Ultravox): espera a que el agente tipifique (memoria o BD) o a que se
  // agote GRACIA_TIPIFICACION_MS. Sin tools declaradas no hay nada que
  // esperar: cierre directo.
  const finalizarConGracia = (motivo) => {
    if (cerrado || finalizando) return;
    finalizando = true;
    const graciaMs = ejecutables.size > 0 ? env.graciaTipificacionMs || 0 : 0;
    if (graciaMs <= 0) {
      cerrar(motivo);
      return;
    }
    avisarHangup();
    logger.info(`[gemini] esperando tipificacion (gracia ${graciaMs}ms) sesion=${sesion.session_id} motivo=${motivo}`);
    const apiVoz = new ApiVozModel();
    const limite = Date.now() + graciaMs;
    const tick = async () => {
      if (cerrado) return;
      let listoTip = !!sesion.tipificacionFinal || Date.now() >= limite;
      if (!listoTip) {
        try {
          if (await apiVoz.getIdTipificacionBySession(sesion.session_id)) listoTip = true;
        } catch (_) {}
      }
      if (cerrado) return;
      if (listoTip) {
        cerrar(motivo);
        return;
      }
      setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
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
      // Durante un swap de reconexion se PAUSA la subida: la conexion vieja
      // esta muriendo y la nueva aun no dio setupComplete. La bajada sigue
      // (silencio de relleno) para no dejar hueco en el stream del cliente.
      if (!reconectando) {
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
      }
      // BAJADA: un frame por tick. Si hay audio del agente se manda; si no y
      // DOWNLINK_SILENCE esta activo, se rellena con silencio para sostener el
      // stream a 50fps (evita corte por idle del lado del integrador y mantiene
      // el timing). El silencio de relleno respeta 3 invariantes:
      //   - NO toca agenteHablando ni emite agent_started_speaking (turnos exactos).
      //   - NO setea isAlive: si lo hiciera, un socket realmente muerto nunca
      //     lo detectaria el heartbeat (index.js). El silencio es para el
      //     heartbeat del integrador, no para el nuestro.
      //   - NO pasa por outQ ni toca ultimoAudioEn (no afecta debeColgar).
      const out = outQ.popFrame(frameBytes);
      if (asteriskWs.readyState === WebSocket.OPEN) {
        if (out) {
          asteriskWs.isAlive = true;
          asteriskWs.send(esMulaw ? pcm16ToMuLaw(out) : out);
          framesWritten++;
        } else if (bajadaSilencio) {
          asteriskWs.send(SILENCIO_BAJADA);
          framesSilencioBajada++;
        }
      }

      // El agente pidio colgar: cerrar recien cuando termino de sonar su
      // despedida (outQ vacia y Gemini dejo de mandar audio), o al tope duro.
      if (colgarPendiente) {
        const cerrarYa = debeColgar({
          colgarPendiente,
          outQPendiente: outQ.length,
          ultimoAudioEn,
          ahora: Date.now(),
          limite: colgarLimite,
        });
        if (cerrarYa) cerrar("hangup_agente");
      }
    }, TICK_MS);
  };

  // ---- Eventos de Gemini (port de events.py + pump_down del server Python) ----
  const onMensajeGemini = (msg) => {
    if (cerrado) return;

    if (msg.setupComplete) {
      listo = true;
      if (reconectando) {
        // La conexion nueva de una reconexion quedo lista: reanudar la subida.
        reconectando = false;
        logger.info(`[gemini] reconexion lista sesion=${sesion.session_id} gen=${genConn}`);
      } else {
        logger.info(`[gemini] sesion lista sesion=${sesion.session_id} model=${cfg.model} tools=${functionDeclarations.length}`);
      }
      arrancarBombas();
      return;
    }

    // El modelo invoco tools: el gateway las ejecuta y le responde (async,
    // sin bloquear el resto de eventos).
    if (msg.toolCall?.functionCalls?.length) {
      manejarToolCalls(msg.toolCall.functionCalls);
      return;
    }
    if (msg.toolCallCancellation?.ids?.length) {
      // Barge-in mientras habia tools en vuelo: Gemini las cancela solo.
      logger.info(`[gemini] toolCallCancellation ids=${msg.toolCallCancellation.ids.join(",")}`);
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
        ultimoAudioEn = Date.now(); // el drenaje de hangUp espera a que esto se aquiete
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
      // Con GEMINI_RESUMPTION=1: reconectar de forma transparente preservando el
      // contexto, sin cortar la llamada. Sin el flag: cerrar como siempre.
      if (env.gemini.resumption && !cerrado) {
        reconectar();
      } else {
        cerrar("gemini_go_away");
      }
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
        logger.info(`[gemini] session_end del cliente sesion=${sesion.session_id} payload=${JSON.stringify(ctrl)}`);
        finalizarConGracia(ctrl.motivo || "hangup_caller");
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

  asteriskWs.on("close", () => finalizarConGracia("asterisk_close"));
  asteriskWs.on("error", (e) => { logger.warn(`[gemini] asterisk error: ${e.message}`); cerrar("asterisk_error"); });

  // Abre una conexion Live a Gemini y cablea sus callbacks con un GUARD DE
  // GENERACION: cada conexion reclama un id (genConn) al abrirse; los callbacks
  // que capturan un id viejo se ignoran tras un swap de reconexion, para que el
  // onclose/onerror de la conexion saliente NO tumbe la llamada. `esReconexion`
  // salta el saludo y el webhook session.connected (van solo en la 1ra conexion).
  const conectarGemini = (resumptionHandle, esReconexion) => {
    const miGen = ++genConn;
    // Import perezoso: si ENGINE=ultravox este modulo nunca carga el SDK.
    const { GoogleGenAI } = require("@google/genai");
    // Key por empresa (la resolvio gemini.service con fallback a la global).
    // El `|| env.gemini.apiKey` es red de seguridad por si cfg no la trae.
    const ai = new GoogleGenAI({ apiKey: cfg.apiKey || env.gemini.apiKey });
    const cfgLive = construirLiveConfig(cfg, functionDeclarations);
    // sessionResumption solo con el flag: sin handle abre limpio; con handle
    // restaura el contexto de la conversacion (deuda #7, doc oficial de Gemini).
    if (env.gemini.resumption) {
      cfgLive.sessionResumption = resumptionHandle ? { handle: resumptionHandle } : {};
    }
    return ai.live.connect({
      model: cfg.model,
      config: cfgLive,
      callbacks: {
        onopen: () => {
          if (miGen !== genConn) return; // conexion vieja: ignorar
          store.actualizar(sesion.session_id, { estado: "en_curso" });
          if (!esReconexion && sesion.webhook) {
            enviarWebhook(sesion.webhook, "session.connected", {
              session_id: sesion.session_id,
              variables: sesion.variables || {},
            });
          }
        },
        onmessage: (m) => { if (miGen === genConn) onMensajeGemini(m); },
        onerror: (e) => {
          if (miGen !== genConn) return;
          cierreDetalle = { error: e?.message || String(e) };
          logger.warn(`[gemini] error WS: ${e?.message || e}`);
          cerrar("gemini_error");
        },
        onclose: (e) => {
          if (miGen !== genConn) return;
          // El code/reason del WS suele traer el motivo real (RESOURCE_EXHAUSTED,
          // quota, etc.). Se guarda para metadata ademas de loguearlo.
          cierreDetalle = { code: e?.code ?? null, reason: e?.reason || null };
          if (!cerrado) logger.info(`[gemini] WS cerrado code=${e?.code ?? "?"} (${e?.reason || "sin motivo"})`);
          cerrar("gemini_close");
        },
      },
    });
  };

  // Reconexion transparente al goAway (solo con GEMINI_RESUMPTION=1): abre una
  // conexion nueva con el resumption handle, intercambia `session` y cierra la
  // vieja. WS#1 (Asterisk) queda intacto; la bomba sigue viva; el silencio de
  // bajada tapa el hueco; maxCallTimer NO se reinicia (el tope corre desde el
  // inicio de la llamada). `reconectando` pausa la subida hasta el setupComplete
  // de la nueva conexion. Red de seguridad: si no llega, se cierra a los 8s.
  const reconectar = async () => {
    if (reconectando || cerrado) return;
    reconectando = true;
    const handle = sesion.geminiResumptionHandle || null;
    const vieja = session;
    try {
      const nueva = await conectarGemini(handle, true); // sube genConn: la vieja queda ignorada
      if (cerrado) { try { nueva.close(); } catch (_) {} return; }
      session = nueva; // swap: la bomba usa la conexion nueva
      inQ.clear(); // descarta el backlog del swap (una rafaga rompe el VAD)
      reconexiones++;
      try { if (vieja) vieja.close(); } catch (_) {}
      logger.info(`[gemini] reconectado sesion=${sesion.session_id} handle=${handle ? "si" : "no"} gen=${genConn}`);
    } catch (e) {
      reconectando = false;
      logger.error(`[gemini] reconexion fallo sesion=${sesion.session_id}: ${e.message}`);
      cerrar("gemini_reconnect_error");
      return;
    }
    // Si la conexion nueva nunca da setupComplete, no dejar la llamada muda.
    setTimeout(() => {
      if (!cerrado && reconectando) {
        logger.error(`[gemini] reconexion sin setupComplete sesion=${sesion.session_id}`);
        cerrar("gemini_reconnect_timeout");
      }
    }, 8000);
  };

  // ---- Abrir la sesion Gemini Live (conexion inicial) ----
  try {
    session = await conectarGemini(null, false);
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
