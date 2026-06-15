const axios = require("axios");
const env = require("../config/env.js");
const logger = require("../config/logger.js");

const { baseUrl, timeoutMs, reintentos } = env.ultravox;

// Rango valido de speed por provider (segun docs Ultravox). Fuera de rango,
// Ultravox responde 400, asi que clampeamos al rango del provider.
const RANGOS_SPEED = {
  elevenlabs: [0.7, 1.2],
  cartesia: [0.6, 1.5],
  google: [0.25, 2],
  lmnt: [0.25, 2],
  inworld: [0.5, 1.5],
};

// "Eleven Labs" / "elevenLabs" -> "elevenlabs"
function normalizarProvider(p) {
  return String(p || "").toLowerCase().replace(/[^a-z]/g, "");
}

// Construye el voiceOverrides de velocidad para una voz integrada. El provider
// del override DEBE coincidir con el de la voz; cada provider usa su propio campo.
// Devuelve null cuando no hay que aplicar override (velocidad 1/normal, provider
// desconocido o velocidad invalida) para no arriesgar un 400 de Ultravox.
function construirVoiceOverrides(provider, velocidad) {
  if (velocidad == null) return null;
  let speed = Number(velocidad);
  if (!Number.isFinite(speed)) return null;
  const p = normalizarProvider(provider);
  const rango = RANGOS_SPEED[p];
  if (!rango) return null; // provider desconocido: no override
  speed = Math.min(rango[1], Math.max(rango[0], speed)); // clamp al rango
  if (speed === 1) return null; // 1 = normal, sin override
  switch (p) {
    case "elevenlabs": return { elevenLabs: { speed } };
    case "cartesia": return { cartesia: { generationConfig: { speed } } };
    case "google": return { google: { speakingRate: speed } };
    case "lmnt": return { lmnt: { speed } };
    case "inworld": return { inworld: { speakingRate: speed } };
    default: return null;
  }
}

// Crea una llamada en Ultravox con medium serverWebSocket. Payload alineado con
// el voice-backend real (aiyou/aiyou-voice-backend ultravoxapi.service.js:240-284).
// Devuelve { callId, joinUrl }.
async function crearLlamadaServerWs({
  apiKey,
  systemPrompt,
  voice = null,
  selectedTools = [],
  sampleRate = env.audioSampleRate,
  languageHint = "es",
  temperature = 0.85,
  voiceProvider = null,
  velocidad = null,
}) {
  if (!apiKey) throw new Error("Falta ultravox_api_key de la empresa");

  const payload = {
    systemPrompt,
    languageHint,
    temperature,
    transcriptOptional: true,
    initialOutputMedium: "MESSAGE_MEDIUM_VOICE",
    vadSettings: { turnEndpointDelay: "0.35s" },
    firstSpeakerSettings: {
      agent: { uninterruptible: true },
    },
    inactivityMessages: [
      { duration: "30s", message: "¿Sigue ahí?", endBehavior: "END_BEHAVIOR_HANG_UP_SOFT" },
    ],
    medium: {
      serverWebSocket: {
        inputSampleRate: sampleRate,
        outputSampleRate: sampleRate,
        clientBufferSizeMs: 60000,
        dataMessages: {
          userStartedSpeaking: true,
          userStoppedSpeaking: true,
          toolUsed: true,
        },
      },
    },
    selectedTools: [{ toolName: "hangUp" }, ...selectedTools],
  };
  if (voice) payload.voice = voice;

  const voiceOverrides = construirVoiceOverrides(voiceProvider, velocidad);
  if (voiceOverrides) payload.voiceOverrides = voiceOverrides;

  const resp = await axios.post(`${baseUrl}/calls`, payload, {
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    timeout: timeoutMs,
    validateStatus: () => true,
  });

  if (resp.status !== 200 && resp.status !== 201) {
    const detalle = typeof resp.data === "object" ? JSON.stringify(resp.data) : String(resp.data);
    throw new Error(`Ultravox respondio ${resp.status}: ${detalle}`);
  }

  const { callId, joinUrl } = resp.data || {};
  if (!joinUrl) throw new Error("Ultravox no devolvio joinUrl");
  return { callId, joinUrl };
}

// Clasifica un error capturado al hablar con Ultravox para decidir el HTTP que
// devuelve el gateway. El gateway es un facade sin proveedor de respaldo, asi
// que distinguimos:
//   "caido"     -> Ultravox no disponible (red/timeout/5xx/respuesta invalida).
//                  El gateway responde 503 (reintentable).
//   "rechazado" -> Ultravox respondio 4xx (la solicitud era invalida, ej. voz
//                  inexistente). No es una caida: reintentar no ayuda -> 502.
//   null        -> error no atribuible a Ultravox (bug interno) -> 500.
function clasificarError(error) {
  const msg = String(error?.message || "");
  const m = msg.match(/^Ultravox respondio (\d{3})/);
  if (m) return Number(m[1]) >= 500 ? "caido" : "rechazado";
  if (/no devolvio joinUrl/.test(msg)) return "caido";
  const code = String(error?.code || "");
  if (["ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET"].includes(code)) return "caido";
  if (/timeout|network|socket hang up/i.test(msg)) return "caido";
  return null;
}

// POST /api/calls/{id}/send_data_message — inyecta texto en la llamada activa
// (ej. avisar "el usuario colgó, tipifica y cuelga"). Ver external-media:1077.
async function sendDataMessage(apiKey, callId, { type = "user_text_message", text, urgency = "now" }) {
  try {
    await axios.post(
      `${baseUrl}/calls/${callId}/send_data_message`,
      { type, text, urgency },
      { headers: { "X-API-Key": apiKey, "Content-Type": "application/json" }, timeout: 8000, validateStatus: () => true }
    );
  } catch (error) {
    logger.warn(`[ultravox] send_data_message ${callId}: ${error.message}`);
  }
}

// GET /api/voices — voces disponibles en la cuenta Ultravox de la empresa.
// Diagnostico: para saber que voice_code poblar en la tabla `voz` / DEFAULT_VOICE_CODE.
async function listarVoces(apiKey) {
  if (!apiKey) throw new Error("Falta ultravox_api_key de la empresa");
  const all = [];
  let nextUrl = `${baseUrl}/voices`;
  while (nextUrl) {
    const resp = await axios.get(nextUrl, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    if (resp.status !== 200) {
      const detalle = typeof resp.data === "object" ? JSON.stringify(resp.data) : String(resp.data);
      throw new Error(`Ultravox GET voices ${resp.status}: ${detalle}`);
    }
    const data = resp.data || {};
    if (Array.isArray(data.results)) all.push(...data.results);
    else if (Array.isArray(data)) all.push(...data);
    nextUrl = data.next || null;
  }
  return all;
}

async function getCall(apiKey, callId) {
  const resp = await axios.get(`${baseUrl}/calls/${callId}`, {
    headers: { "X-API-Key": apiKey, Accept: "application/json" },
    timeout: timeoutMs,
    validateStatus: () => true,
  });
  if (resp.status !== 200) throw new Error(`Ultravox GET call ${resp.status}`);
  return resp.data;
}

async function obtenerMensajes(apiKey, callId) {
  const headers = { "X-API-Key": apiKey, Accept: "application/json" };
  for (let intento = 1; intento <= reintentos; intento++) {
    try {
      const all = [];
      let nextUrl = `${baseUrl}/calls/${callId}/messages`;
      while (nextUrl) {
        const resp = await axios.get(nextUrl, { headers, timeout: timeoutMs, validateStatus: () => true });
        if (resp.status !== 200) return { estado: `ERROR_HTTP_${resp.status}`, mensajes: [] };
        const data = resp.data || {};
        if (data.results?.length) all.push(...data.results);
        nextUrl = data.next || null;
      }
      return { estado: "OK", mensajes: all };
    } catch (error) {
      if (intento === reintentos) {
        logger.warn(`[ultravox] fallo mensajes ${callId}: ${error.message}`);
        return { estado: `ERROR: ${error.message}`, mensajes: [] };
      }
    }
  }
  return { estado: "ERROR_DESCONOCIDO", mensajes: [] };
}

module.exports = { crearLlamadaServerWs, sendDataMessage, listarVoces, getCall, obtenerMensajes, clasificarError, construirVoiceOverrides };
