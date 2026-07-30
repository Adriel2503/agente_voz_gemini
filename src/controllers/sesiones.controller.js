const AgenteVozModel = require("../models/agenteVoz.model.js");
const ApiVozModel = require("../models/apiVoz.model.js");
const gemini = require("../services/gemini.service.js");
const { enviarWebhook } = require("../services/webhook.service.js");
const store = require("../sessions/store.js");
const { renderPromptConFeriados, variablesSinResolver, tipificacionesParaPrompt } = require("../lib/prompt.js");
const { processTools } = require("../tools/processTools.js");
const tasaSesiones = require("../lib/tasaSesiones.js");
const { cargarTiendas } = require("../services/sucursales.service.js");
const genericaTools = require("../tools/generica.js");
const env = require("../config/env.js");
const logger = require("../config/logger.js");

// Ademas de responder, deja rastro: un rechazo silencioso aqui = llamada que
// suena sin IA del otro lado y nadie sabe por que.
const err = (res, http, codigo, msg) => {
  logger.warn(`[sesiones] RECHAZADO ${http} ${codigo}: ${msg}`);
  return res.status(http).json({ codigo, msg });
};

// POST /v1/agente-voz/sesiones
async function crearSesion(req, res) {
  const idEmpresa = req.apiVozEmpresa;
  const { id_plantilla, id_tool, variables = {}, codec = "pcm_s16le_16k", metadata = null } = req.body || {};

  // Traza de TODO intento de sesion: si el integrador lanza N llamadas y aqui
  // aparecen menos de N POSTs, la perdida esta de su lado (marcador/Asterisk),
  // no en el gateway. El telefono ayuda a cruzar contra su reporte de campana.
  logger.info(`[sesiones] POST /sesiones empresa=${idEmpresa} plantilla=${id_plantilla} telefono=${variables?.telefono || "?"} activas=${store.contarActivas()}`);

  if (!id_plantilla) return err(res, 400, "plantilla_invalida", "id_plantilla requerido");

  const agente = new AgenteVozModel();
  try {
    const empresa = await agente.getEmpresa(idEmpresa);
    if (!empresa) return err(res, 401, "auth_invalida", "Empresa no encontrada");
    if (Number(empresa.api_voz_activo) !== 1) return err(res, 503, "agente_indisponible", "API de voz inactiva para la empresa");

    const plantilla = await agente.getPlantilla(idEmpresa, id_plantilla);
    if (!plantilla) return err(res, 400, "plantilla_invalida", "Plantilla inexistente o ajena a la empresa");

    const campos = await agente.getFormatoCampos(plantilla.id_formato);
    const { ok, faltantes } = AgenteVozModel.validarVariables(campos, variables);
    if (!ok) {
      logger.warn(`[sesiones] RECHAZADO 400 variables_incompletas empresa=${idEmpresa} faltantes=${faltantes.join(",")}`);
      return res.status(400).json({ codigo: "variables_incompletas", msg: "Faltan campos requeridos", faltantes });
    }

    // Tool: validacion opcional del id_tool (tipo 'llamada'). El SET de funciones
    // que se envia al motor es el generico (decision del usuario: solo "generica").
    const idToolFinal = id_tool || empresa.id_tool;
    if (idToolFinal) {
      const tool = await agente.getTool(idToolFinal);
      if (!tool || tool.tipo !== "llamada") return err(res, 400, "tool_invalida", "id_tool inexistente o no es tipo llamada");
    }

    const tipificaciones = await agente.getTipificaciones(idEmpresa);

    // provider_call_id para las tools: el call_id del integrador si lo manda.
    const providerCallId = metadata?.external_call_id ?? null;

    // Enriquecer variables con los reservados que la plantilla espera pre-cargados
    // (replica aiyou-voice-backend):
    //  - nombre_corto: primer nombre en minuscula, auto-derivado de nombre.
    //  - tipificaciones: catalogo JSON que el agente lee para tipificarLlamada,
    //    recortado a {id, nombre} (lo unico que el modelo necesita para elegir).
    //    El catalogo COMPLETO viaja aparte en la sesion (linea de abajo) porque
    //    geminiEngine saca de ahi codigo_homologacion_api_agente para el webhook.
    //  - provider_call_id: el call_id del integrador (las tools lo reciben aparte
    //    via processTools, pero la plantilla tambien lo referencia en texto).
    const varsPrompt = { ...variables };
    const rawNombre = String(variables.nombre || variables.nombre_completo || "").trim();
    if (rawNombre && !varsPrompt.nombre_corto) {
      varsPrompt.nombre_corto = rawNombre.split(/\s+/)[0].toLowerCase();
    }
    varsPrompt.tipificaciones = JSON.stringify(tipificacionesParaPrompt(tipificaciones));
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

    // Tope de concurrencia por empresa (empresa.canal). Se repone la guardia que
    // se retiro en ba7e364 al migrar a Gemini: el razonamiento de entonces
    // ("Gemini limita por TPM, no por canales") era correcto, pero dejo al
    // gateway sin ninguna guardia y el 16-jul una campana abrio 63 llamadas/min
    // contra un techo de ~18 (ver docs/capacidad-gemini-live.html).
    // canal <= 0 o NULL = sin limite, igual que antes.
    //
    // OJO AL ORDEN: este chequeo y el store.crear de abajo tienen que quedar en
    // el mismo bloque SINCRONICO, sin ningun await en el medio. Node es
    // monohilo, asi que chequear-y-reservar solo es atomico si nada cede el
    // control entre ambos; si se chequeara mas arriba, una rafaga pasaria entera
    // antes de que la primera sesion se registre (el 16-jul entraron 17 sesiones
    // en 10 segundos, que es justo el caso que esto tiene que frenar).
    const canal = Number(empresa.canal) || 0;
    if (canal > 0) {
      const activas = store.contarActivasPorEmpresa(idEmpresa);
      if (activas >= canal) {
        // Nunca se loguea la api key ni un fragmento (leccion de 621f770): con
        // empresa y ocupacion alcanza para diagnosticar el rechazo.
        logger.warn(`[sesiones] RECHAZADO 503 sin canales empresa=${idEmpresa} ocupacion=${activas}/${canal}`);
        res.set("Retry-After", "30");
        return err(res, 503, "agente_indisponible", "Sin canales disponibles. Reintente en unos segundos.");
      }
    }

    // Limite de sesiones NUEVAS por minuto de esta empresa. Es la guardia que de
    // verdad corta el lazo de realimentacion: el tope de canales de arriba acota
    // el daño pero no frena un desbocamiento de tasa (el 16-jul los 15 canales
    // se reciclaron 63 veces por minuto). Un rechazo aca es gratis: no abre
    // sesion Gemini ni consume un token, a diferencia de un RESOURCE_EXHAUSTED
    // que ya pago los ~8.000 del setup.
    //
    // Va DESPUES del tope de canales a proposito: admitir() registra la apertura
    // al admitirla, asi que si se chequeara primero, un rechazo por canales
    // igual habria consumido un cupo de tasa.
    //
    // El limite se resuelve aca y se pasa ya listo: el modulo no lee config. El
    // dia que una empresa necesite un valor propio, esta linea pasa a ser
    // `empresa.max_rpm ?? env.maxRpmPorEmpresa` (con ??, no ||: un 0 en BD
    // significa "sin limite para esta empresa" y || lo pisaria con el del env).
    const limiteRpm = env.maxRpmPorEmpresa;
    if (limiteRpm > 0) {
      const tasa = tasaSesiones.admitir(idEmpresa, limiteRpm);
      if (!tasa.ok) {
        logger.warn(`[sesiones] RECHAZADO 503 tasa excedida empresa=${idEmpresa} aperturas=${tasa.usados}/${limiteRpm} en 60s`);
        res.set("Retry-After", "30");
        return err(res, 503, "tasa_excedida", "Limite de llamadas nuevas por minuto alcanzado. Reintente en unos segundos.");
      }
    }

    // Registro de la sesion ANTES de armar el motor: reserva el canal para que
    // dos POST concurrentes no pasen el mismo cupo, sirve para POST /terminar y
    // deja que purgarExpiradas la limpie si el integrador nunca conecta su WSS.
    const registro = store.crear({
      session_id: sessionId,
      idEmpresa,
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
      // Gemini no devuelve joinUrl: la sesion Live se abre recien cuando el
      // integrador conecta su WSS. geminiApiKey por empresa (null = fallback a
      // GEMINI_API_KEY global). Ver docs/keys-gemini-por-empresa.md.
      ({ callId, joinUrl, geminiConfig } = await gemini.crearLlamadaServerWs({
        geminiApiKey: empresa.gemini_api_key || null,
        systemPrompt,
        sampleRate,
        selectedTools,
      }));
    } catch (e) {
      store.eliminar(sessionId); // libera el registro reservado
      throw e;
    }

    const apiVoz = new ApiVozModel();
    // El webhook es una feature secundaria (notificar al integrador): un blip
    // de BD aca no debe tumbar la sesion cuando el motor de voz ya se armo
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

    // Ultimo await despues de la reserva del canal, y el unico que no tenia red:
    // si fallaba, el registro que store.crear reservo arriba quedaba vivo
    // ocupando un cupo hasta que purgarExpiradas lo barriera (hasta 45s de canal
    // fantasma). Misma limpieza que el catch de crearLlamadaServerWs.
    //
    // Se ABORTA la sesion en vez de degradar (que es lo que se hace con el
    // webhook, que si es secundario): la fila de creacion es la traza de la
    // llamada, y el upsert de cierre no manda id_plantilla ni codec ni
    // fecha_inicio, asi que degradar dejaria la fila naciendo al final y sin
    // atribucion de campana. Abortar sale gratis del lado del motor: la sesion
    // Live recien se abre cuando conecta el WSS, no hay nada remoto colgado.
    try {
      await apiVoz.upsertSesion(idEmpresa, {
        session_id: registro.session_id,
        id_plantilla: plantilla.id,
        estado: "created",
        codec,
        metadata,
        fecha_inicio: new Date().toISOString(),
      });
    } catch (e) {
      store.eliminar(sessionId); // libera el cupo de canal reservado
      logger.error(`[sesiones] upsert created fallo empresa=${idEmpresa}: ${e.message}`);
      // 503 y no 500 a proposito: 500 le dice al integrador "es un bug, no
      // reintentes"; 503 + Retry-After le dice "es transitorio, volve", que es
      // lo que hace que un blip de BD se recupere solo. Si la BD esta caida de
      // verdad, rebotan todas y la campana se frena sola — correcto: gastar
      // telefonia y TPM para un resultado que no vamos a poder guardar es peor
      // que no llamar. Se reusa agente_indisponible (el integrador ya lo maneja).
      // NOTA: el cupo de TASA ya se consumio y no se devuelve; con la BD caida
      // los reintentos queman RPM. Devolverlo abriria un agujero peor (doble
      // devolucion) por un caso de borde.
      res.set("Retry-After", "30");
      return err(res, 503, "agente_indisponible", "No se pudo registrar la sesion. Reintente en unos segundos.");
    }

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
    const fallo = gemini.clasificarError(error);
    if (fallo === "caido") {
      // Motor de voz no disponible. El gateway no tiene proveedor de respaldo,
      // asi que pide al integrador reintentar (503 + Retry-After).
      res.set("Retry-After", "30");
      return err(res, 503, "agente_indisponible", "El agente de voz no esta disponible temporalmente. Reintente en unos segundos.");
    }
    if (fallo === "rechazado") {
      // El motor rechazo la solicitud (4xx): reintentar no ayuda. Se conserva el
      // codigo "error_ultravox" por compatibilidad con integradores existentes
      // que ya lo manejan (es un identificador de contrato, no logica del motor).
      return err(res, 502, "error_ultravox", "El agente de voz rechazo la solicitud. Verifique los parametros (plantilla).");
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
  // memoria durante la llamada (sesion.transcripcion).
  const mensajes = s.transcripcion || [];
  return res.json({
    session_id: s.session_id,
    duracion_segundos: s.duracionSegundos || 0,
    tipificacion: s.tipificacionFinal || null,
    agendamiento: s.agendamientoFinal || null,
    variables_capturadas: s.variablesCapturadas || {},
    mensajes,
  });
}

module.exports = { crearSesion, estadoSesion, terminarSesion, transcripcionSesion };
