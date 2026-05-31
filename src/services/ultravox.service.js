const axios = require("axios");
const env = require("../config/env.js");
const logger = require("../config/logger.js");

const { baseUrl, timeoutMs, reintentos } = env.ultravox;

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

module.exports = { crearLlamadaServerWs, sendDataMessage, listarVoces, getCall, obtenerMensajes };
