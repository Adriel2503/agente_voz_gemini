const AgenteVozModel = require("../models/agenteVoz.model.js");
const ApiVozModel = require("../models/apiVoz.model.js");
const ultravox = require("../services/ultravox.service.js");
const { enviarWebhook } = require("../services/webhook.service.js");
const store = require("../sessions/store.js");
const { renderPromptConFeriados } = require("../lib/prompt.js");
const { processTools } = require("../tools/processTools.js");
const { cargarTiendas } = require("../services/sucursales.service.js");
const genericaTools = require("../tools/generica.js");
const env = require("../config/env.js");
const logger = require("../config/logger.js");

const err = (res, http, codigo, msg) => res.status(http).json({ codigo, msg });

// POST /v1/agente-voz/sesiones
async function crearSesion(req, res) {
  const idEmpresa = req.apiVozEmpresa;
  const { id_plantilla, id_voz, id_tool, variables = {}, codec = "pcm_s16le_16k", metadata = null } = req.body || {};

  if (!id_plantilla) return err(res, 400, "plantilla_invalida", "id_plantilla requerido");

  const agente = new AgenteVozModel();
  try {
    const empresa = await agente.getEmpresa(idEmpresa);
    if (!empresa) return err(res, 401, "auth_invalida", "Empresa no encontrada");
    if (Number(empresa.api_voz_activo) !== 1) return err(res, 503, "agente_indisponible", "API de voz inactiva para la empresa");
    if (!empresa.ultravox_api_key) return err(res, 503, "agente_indisponible", "Empresa sin ultravox_api_key");

    const plantilla = await agente.getPlantilla(idEmpresa, id_plantilla);
    if (!plantilla) return err(res, 400, "plantilla_invalida", "Plantilla inexistente o ajena a la empresa");

    const campos = await agente.getFormatoCampos(plantilla.id_formato);
    const { ok, faltantes } = AgenteVozModel.validarVariables(campos, variables);
    if (!ok) return res.status(400).json({ codigo: "variables_incompletas", msg: "Faltan campos requeridos", faltantes });

    // Voz: del body o default por env. (TODO: decidir si la voz vive en la plantilla/empresa.)
    let voiceCode = env.defaultVoiceCode;
    if (id_voz) {
      const voz = await agente.getVoz(id_voz);
      if (!voz) return err(res, 400, "voz_invalida", "id_voz inexistente o inactiva");
      voiceCode = voz.voice_code;
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
    const sampleRate = codec === "mulaw_8k" ? 8000 : 16000;
    const selectedTools = processTools(genericaTools, {
      idEmpresa,
      providerCallId,
      backendUrl: env.toolsBackendUrl, // null = dejar URLs ai-you.io tal cual
    });

    const { callId, joinUrl } = await ultravox.crearLlamadaServerWs({
      apiKey: empresa.ultravox_api_key,
      systemPrompt,
      voice: voiceCode,
      sampleRate,
      selectedTools,
    });

    const apiVoz = new ApiVozModel();
    const webhook = await apiVoz.getWebhookConfig(idEmpresa);

    const registro = store.crear({
      idEmpresa,
      apiKey: empresa.ultravox_api_key,
      callId,
      joinUrl,
      idPlantilla: plantilla.id,
      codec,
      sampleRate,
      metadata,
      tipificaciones,
      idTool: idToolFinal,
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
      enviarWebhook(registro.webhook, "session.created", { session_id: registro.session_id, metadata });
    }

    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const rawToken = (req.headers["authorization"] || "").slice(7).trim();
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

  const { mensajes } = await ultravox.obtenerMensajes(s.apiKey, s.callId);
  return res.json({
    session_id: s.session_id,
    duracion_segundos: s.duracionSegundos || 0,
    tipificacion: s.tipificacionFinal || null,
    variables_capturadas: s.variablesCapturadas || {},
    mensajes: mensajes.map((m) => ({ rol: m.role, ts: m.timespan?.start ?? null, texto: m.text })),
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
