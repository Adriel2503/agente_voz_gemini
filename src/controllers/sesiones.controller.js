const AgenteVozModel = require("../models/agenteVoz.model.js");
const ApiVozModel = require("../models/apiVoz.model.js");
const ultravox = require("../services/ultravox.service.js");
const gemini = require("../services/gemini.service.js");
const { enviarWebhook } = require("../services/webhook.service.js");
const store = require("../sessions/store.js");
const { renderPromptConFeriados, variablesSinResolver } = require("../lib/prompt.js");
const { processTools } = require("../tools/processTools.js");
const { cargarTiendas } = require("../services/sucursales.service.js");
const genericaTools = require("../tools/generica.js");
const env = require("../config/env.js");
const logger = require("../config/logger.js");

const err = (res, http, codigo, msg) => res.status(http).json({ codigo, msg });

// Motor de voz activo del gateway (env ENGINE). El codigo Ultravox queda
// intacto como kill-switch: ENGINE=ultravox restaura el flujo anterior.
const esGemini = () => env.engine === "gemini";
const motorActivo = () => (esGemini() ? gemini : ultravox);

// Elige el primer candidato con cupo libre. `candidatos` viene ordenado por
// prioridad (principal primero, luego adicionales) y cada uno ya trae el
// `voiceCode` valido en su cuenta Ultravox. `canal <= 0` = sin limite. `conteo` es
// el mapa apiKey -> canales ocupados (store en memoria). Devuelve el candidato
// elegido { apiKey, voiceCode } o null si todos estan al tope.
function elegirCandidato(candidatos, conteo) {
  for (const c of candidatos) {
    if (!c.apiKey) continue;
    const usados = conteo.get(c.apiKey) || 0;
    if (c.canal <= 0 || usados < c.canal) return c;
  }
  return null;
}

// POST /v1/agente-voz/sesiones
async function crearSesion(req, res) {
  const idEmpresa = req.apiVozEmpresa;
  const { id_plantilla, id_voz, id_tool, variables = {}, codec = "pcm_s16le_16k", metadata = null, velocidad: velocidadBody = null } = req.body || {};

  if (!id_plantilla) return err(res, 400, "plantilla_invalida", "id_plantilla requerido");

  const agente = new AgenteVozModel();
  try {
    const empresa = await agente.getEmpresa(idEmpresa);
    if (!empresa) return err(res, 401, "auth_invalida", "Empresa no encontrada");
    if (Number(empresa.api_voz_activo) !== 1) return err(res, 503, "agente_indisponible", "API de voz inactiva para la empresa");
    // Con Gemini la key es global del gateway (GEMINI_API_KEY); la de Ultravox
    // (por empresa) solo se exige en su propio motor.
    if (!esGemini() && !empresa.ultravox_api_key) return err(res, 503, "agente_indisponible", "Empresa sin ultravox_api_key");

    const plantilla = await agente.getPlantilla(idEmpresa, id_plantilla);
    if (!plantilla) return err(res, 400, "plantilla_invalida", "Plantilla inexistente o ajena a la empresa");

    const campos = await agente.getFormatoCampos(plantilla.id_formato);
    const { ok, faltantes } = AgenteVozModel.validarVariables(campos, variables);
    if (!ok) return res.status(400).json({ codigo: "variables_incompletas", msg: "Faltan campos requeridos", faltantes });

    // Voz: del body o default por env. (TODO: decidir si la voz vive en la plantilla/empresa.)
    // Velocidad del habla: override por llamada (body.velocidad) > config de la voz
    // (voz.velocidad) > default global (env.defaultVoiceSpeed). El provider se usa
    // para construir el voiceOverrides correcto en Ultravox.
    let voiceCode = env.defaultVoiceCode;
    let voiceProvider = env.defaultVoiceProvider;
    let velocidad = env.defaultVoiceSpeed;
    if (id_voz) {
      const voz = await agente.getVoz(id_voz, idEmpresa);
      if (!voz) return err(res, 400, "voz_invalida", "id_voz inexistente o inactiva");
      voiceCode = voz.voice_code;
      if (voz.provider) voiceProvider = voz.provider;
      if (voz.velocidad != null) velocidad = Number(voz.velocidad);
    }
    if (velocidadBody != null && velocidadBody !== "") {
      const v = Number(velocidadBody);
      if (!Number.isFinite(v)) return err(res, 400, "velocidad_invalida", "velocidad debe ser numerica");
      velocidad = v;
    }

    // Tool: validación opcional del id_tool (tipo 'llamada'). El SET de funciones
    // que se envía a Ultravox es el genérico (decisión del usuario: solo "generica").
    const idToolFinal = id_tool || empresa.id_tool;
    if (idToolFinal) {
      const tool = await agente.getTool(idToolFinal);
      if (!tool || tool.tipo !== "llamada") return err(res, 400, "tool_invalida", "id_tool inexistente o no es tipo llamada");
    }

    const tipificaciones = await agente.getTipificaciones(idEmpresa);

    // provider_call_id para las tools: el call_id del integrador si lo manda.
    const providerCallId = metadata?.external_call_id ?? null;

    // Enriquecer variables con los reservados que la plantilla espera pre-cargados
    // (replica aiyou-voice-backend ultravoxapi.service.js):
    //  - nombre_corto: primer nombre en minuscula, auto-derivado de nombre.
    //  - tipificaciones: catalogo JSON que el agente lee para tipificarLlamada.
    //  - provider_call_id: el call_id del integrador (las tools lo reciben aparte
    //    via processTools, pero la plantilla tambien lo referencia en texto).
    const varsPrompt = { ...variables };
    const rawNombre = String(variables.nombre || variables.nombre_completo || "").trim();
    if (rawNombre && !varsPrompt.nombre_corto) {
      varsPrompt.nombre_corto = rawNombre.split(/\s+/)[0].toLowerCase();
    }
    varsPrompt.tipificaciones = JSON.stringify(tipificaciones || []);
    if (providerCallId) varsPrompt.provider_call_id = providerCallId;

    const promptPlantilla = plantilla.prompt || plantilla.prompt_resultado || "";

    // Precarga de las 3 tiendas mas cercanas (solo si la plantilla las usa), para
    // que el agente ofrezca agencia sin llamar buscarSucursal al inicio.
    if (promptPlantilla.includes("tienda_cercana")) {
      const tiendas = await cargarTiendas(idEmpresa, variables);
      Object.assign(varsPrompt, tiendas);
    }

    const systemPrompt = await renderPromptConFeriados(promptPlantilla, varsPrompt);

    // Los {{...}} que no se resolvieron quedan LITERALES en el prompt y el
    // agente termina pronunciandolos ("Que tenga buenas tardes, nombre corto").
    // No se rompe la llamada por esto, pero tiene que verse en el log.
    const huerfanas = variablesSinResolver(systemPrompt);
    if (huerfanas.length) {
      logger.warn(
        `[sesiones] plantilla con ${huerfanas.length} variable(s) sin resolver ` +
          `(el agente puede leerlas en voz alta) empresa=${idEmpresa}: ${huerfanas.join(", ")}`
      );
    }

    const sampleRate = codec === "mulaw_8k" ? 8000 : 16000;

    // Generamos el session_id aqui para inyectarlo como static param de las tools.
    // Asi las tools (tipificarLlamada / agendar_cita) lo mandan a app-api y la
    // persistencia no depende del evento WS toolUsed.
    const sessionId = store.nuevoSessionId();
    const selectedTools = processTools(genericaTools, {
      idEmpresa,
      providerCallId,
      sessionId,
      backendUrl: env.toolsBackendUrl, // null = dejar URLs ai-you.io tal cual
    });

    // Elegir la key Ultravox segun canales libres: principal primero, luego las
    // adicionales. Como las voces de Ultravox son por cuenta, cada candidato lleva
    // el voice_code valido en SU cuenta: la principal usa `voiceCode`; cada adicional
    // usa su mapeo en voz_adicional si existe, y si esa voz no esta mapeada en la
    // cuenta adicional cae al voice_code base (`voiceCode`). Cuando no se pidio
    // id_voz se usa la voz default para todas las cuentas.
    // Con Gemini no hay pool de cuentas: la key es global. Se conserva el tope
    // de canales por empresa (empresa.canal) usando una clave sintetica
    // "gemini:{idEmpresa}" para que contarPorApiKey no mezcle empresas.
    let candidatos;
    if (esGemini()) {
      candidatos = [{ apiKey: `gemini:${idEmpresa}`, canal: Number(empresa.canal) || 0, voiceCode }];
    } else {
      const adicionales = await agente.getApiKeysAdicionales(idEmpresa);
      const mapaVozAdic = id_voz
        ? new Map((await agente.getVozAdicionalPorVoz(id_voz, idEmpresa)).map((f) => [f.apikey_adicional_id, f.voice_code]))
        : null;

      candidatos = [{ apiKey: empresa.ultravox_api_key, canal: Number(empresa.canal) || 0, voiceCode }];
      for (const a of adicionales) {
        const codeAdic = (mapaVozAdic && mapaVozAdic.get(a.id)) || voiceCode;
        candidatos.push({ apiKey: a.api_key, canal: Number(a.canal) || 0, voiceCode: codeAdic });
      }
    }

    // Se elige lo mas tarde posible (justo antes de crear la llamada) para que el
    // conteo en memoria sea el mas fresco.
    const elegido = elegirCandidato(candidatos, store.contarPorApiKey());
    if (!elegido) {
      const conteo = store.contarPorApiKey();
      const detalle = candidatos.map((c) => `${String(c.apiKey).slice(0, 12)}…=${conteo.get(c.apiKey) || 0}/${c.canal}`).join(" ");
      logger.warn(`[sesiones] RECHAZADO 503 sin canales empresa=${idEmpresa} ocupacion: ${detalle}`);
      res.set("Retry-After", "30");
      return err(res, 503, "agente_indisponible", "Sin canales disponibles. Reintente en unos segundos.");
    }
    const { apiKey, voiceCode: voiceCodeFinal } = elegido;

    // Reserva del canal: registramos la sesion como pendiente ANTES del await a
    // Ultravox para que contarPorApiKey ya la incluya y dos requests concurrentes no
    // elijan la misma key por encima de su cupo. purgarExpiradas la limpia si nunca
    // conecta; si Ultravox falla la eliminamos aqui mismo.
    const registro = store.crear({
      session_id: sessionId,
      idEmpresa,
      apiKey,
      engine: env.engine, // el WSS ramifica el bridge por este campo
      idPlantilla: plantilla.id,
      codec,
      sampleRate,
      metadata,
      variables, // las variables originales que mando el cliente, para devolverlas en los webhooks
      tipificaciones,
      idTool: idToolFinal,
    });

    let callId, joinUrl, geminiConfig;
    try {
      // Mismo contrato en ambos motores: { callId, joinUrl }. Gemini ademas
      // devuelve geminiConfig (no hay joinUrl: la sesion Live se abre recien
      // cuando el integrador conecta su WSS). La voz de la tabla `voz` es de
      // ElevenLabs/Ultravox: con Gemini se ignora y manda GEMINI_VOICE.
      ({ callId, joinUrl, geminiConfig } = await motorActivo().crearLlamadaServerWs({
        apiKey,
        systemPrompt,
        voice: esGemini() ? null : voiceCodeFinal,
        sampleRate,
        selectedTools,
        voiceProvider,
        velocidad,
      }));
    } catch (e) {
      store.eliminar(sessionId); // libera el canal reservado
      throw e;
    }

    const apiVoz = new ApiVozModel();
    // El webhook es una feature secundaria (notificar al integrador): un blip
    // de BD acá no debe tumbar la sesion cuando el motor de voz ya se armo
    // bien. Se degrada a "sin webhook" y se sigue.
    let webhook = null;
    try {
      webhook = await apiVoz.getWebhookConfig(idEmpresa);
    } catch (e) {
      logger.warn(`[sesiones] getWebhookConfig fallo (empresa=${idEmpresa}), sesion continua sin webhook: ${e.message}`);
    }

    store.actualizar(sessionId, {
      callId,
      joinUrl,
      geminiConfig: geminiConfig || null,
      webhook: webhook ? { webhookUrl: webhook.webhook_url, webhookSecret: webhook.webhook_secret } : null,
    });

    await apiVoz.upsertSesion(idEmpresa, {
      session_id: registro.session_id,
      id_plantilla: plantilla.id,
      estado: "created",
      codec,
      metadata,
      fecha_inicio: new Date().toISOString(),
    });

    if (registro.webhook) {
      enviarWebhook(registro.webhook, "session.created", { session_id: registro.session_id, metadata, variables });
    }

    const host = req.headers["x-forwarded-host"] || req.headers.host;
    // Mismo criterio que apiVozToken.middleware: Bearer o ?token=. Si el POST
    // autentico por query, el slice(7) del header vacio dejaba ws_url con
    // token= vacio y el WS rebotaba 401.
    const header = req.headers["authorization"] || "";
    const rawToken = header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : (req.query.token || "").trim();
    const wsUrl = `wss://${host}/v1/sesiones/${registro.session_id}?token=${rawToken}`;

    return res.status(201).json({
      session_id: registro.session_id,
      ws_url: wsUrl,
      expira_en: new Date(registro.creada_en + 30000).toISOString(),
      codec_acordado: codec,
      sample_rate_hz: sampleRate,
      channels: 1,
    });
  } catch (error) {
    logger.error(`[crearSesion] ${error.message}`);
    const fallo = motorActivo().clasificarError(error);
    if (fallo === "caido") {
      // Motor de voz no disponible. El gateway no tiene proveedor de respaldo,
      // asi que pide al integrador reintentar (503 + Retry-After).
      res.set("Retry-After", "30");
      return err(res, 503, "agente_indisponible", "El agente de voz no esta disponible temporalmente. Reintente en unos segundos.");
    }
    if (fallo === "rechazado") {
      // El motor rechazo la solicitud (4xx): reintentar no ayuda. Se conserva
      // el codigo "error_ultravox" por compatibilidad con integradores.
      return err(res, 502, "error_ultravox", "El agente de voz rechazo la solicitud. Verifique los parametros (voz, plantilla).");
    }
    return err(res, 500, "error_interno", "No se pudo crear la sesion");
  }
}

// GET /v1/agente-voz/sesiones/:id
async function estadoSesion(req, res) {
  const s = store.obtener(req.params.id);
  if (!s || s.idEmpresa !== req.apiVozEmpresa) return err(res, 404, "sesion_no_encontrada", "Sesion desconocida o expirada");
  return res.json({ session_id: s.session_id, estado: s.estado, conectado: s.conectado });
}

// POST /v1/agente-voz/sesiones/:id/terminar
async function terminarSesion(req, res) {
  const s = store.obtener(req.params.id);
  if (!s || s.idEmpresa !== req.apiVozEmpresa) return err(res, 404, "sesion_no_encontrada", "Sesion desconocida");
  s.estado = "finalizada";
  if (s.cerrar) s.cerrar("terminar_rest"); // cierra el WSS si esta abierto
  await new ApiVozModel().upsertSesion(req.apiVozEmpresa, {
    session_id: s.session_id,
    estado: "ended",
    motivo_fin: "terminar_rest",
    fecha_fin: new Date().toISOString(),
  });
  return res.json({ session_id: s.session_id, estado: "finalizada" });
}

// GET /v1/agente-voz/sesiones/:id/transcripcion
async function transcripcionSesion(req, res) {
  const s = store.obtener(req.params.id);
  if (!s || s.idEmpresa !== req.apiVozEmpresa) return err(res, 404, "sesion_no_encontrada", "Sesion desconocida");
  if (s.estado !== "finalizada") return err(res, 409, "sesion_no_terminada", "La sesion aun no termina");

  // Gemini no tiene REST de mensajes: el bridge acumula la transcripcion en
  // memoria durante la llamada (sesion.transcripcion). Ultravox se consulta
  // por REST como siempre.
  const mensajes = s.engine === "gemini"
    ? (s.transcripcion || [])
    : (await ultravox.obtenerMensajes(s.apiKey, s.callId)).mensajes
        .map((m) => ({ rol: m.role, ts: m.timespan?.start ?? null, texto: m.text }));
  return res.json({
    session_id: s.session_id,
    duracion_segundos: s.duracionSegundos || 0,
    tipificacion: s.tipificacionFinal || null,
    agendamiento: s.agendamientoFinal || null,
    variables_capturadas: s.variablesCapturadas || {},
    mensajes,
  });
}

// GET /v1/agente-voz/voces  (diagnostico)
// Lista las voces de la cuenta Ultravox de la empresa del token. Sirve para saber
// que voice_code poblar en la tabla `voz` o en DEFAULT_VOICE_CODE.
async function listarVoces(req, res) {
  const agente = new AgenteVozModel();
  try {
    const empresa = await agente.getEmpresa(req.apiVozEmpresa);
    if (!empresa) return err(res, 401, "auth_invalida", "Empresa no encontrada");
    if (!empresa.ultravox_api_key) return err(res, 503, "agente_indisponible", "Empresa sin ultravox_api_key");

    const voces = await ultravox.listarVoces(empresa.ultravox_api_key);
    return res.json({
      total: voces.length,
      voces: voces.map((v) => ({
        voice_code: v.voiceId ?? v.id ?? v.voice_id ?? null,
        nombre: v.name ?? null,
        idioma: v.language ?? v.languageCode ?? null,
      })),
    });
  } catch (error) {
    logger.error(`[listarVoces] ${error.message}`);
    return err(res, 502, "error_ultravox", "No se pudieron listar las voces");
  }
}

module.exports = { crearSesion, estadoSesion, terminarSesion, transcripcionSesion, listarVoces };
