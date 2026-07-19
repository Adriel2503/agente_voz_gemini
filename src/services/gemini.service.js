// Cliente del motor de voz Gemini Live.
//
// NO hay paso HTTP previo que devuelva un joinUrl: la sesion Gemini se abre
// recien cuando el integrador conecta su WSS (ws/geminiEngine.js hace
// ai.live.connect). Aqui solo se valida config y se arma el contexto que el
// engine necesita.
const crypto = require("crypto");
const env = require("../config/env.js");
const store = require("../sessions/store.js");
const logger = require("../config/logger.js");

// Crea la "llamada" Gemini: resuelve la key efectiva, genera un callId propio y
// devuelve la config para el engine. `selectedTools` (ya procesadas por
// processTools) viajan en geminiConfig: el engine las traduce a
// functionDeclarations y ejecuta sus toolCalls (ver tools/geminiTools.js).
// Devuelve { callId, joinUrl: null, geminiConfig }.
async function crearLlamadaServerWs({
  geminiApiKey = null, // key de Gemini de la empresa; null = fallback a la global del gateway
  systemPrompt,
  voice = null,
  selectedTools = [],
  sampleRate = env.audioSampleRate,
}) {
  // Key efectiva: la de la empresa si esta cargada, si no la global del gateway.
  // Ver docs/keys-gemini-por-empresa.md.
  const keyEfectiva = geminiApiKey || env.gemini.apiKey;
  if (!keyEfectiva) {
    // Mensaje con "Gemini respondio 503" para que clasificarError lo mapee a "caido".
    throw new Error("Gemini respondio 503: la empresa no tiene gemini_api_key y falta GEMINI_API_KEY global");
  }

  const callId = `gem_${crypto.randomBytes(8).toString("hex")}`;
  return {
    callId,
    joinUrl: null, // Gemini no tiene URL de sesion previa; el engine conecta directo
    geminiConfig: {
      model: env.gemini.model,
      apiKey: keyEfectiva, // key real (empresa o global) que usa el engine para conectar
      systemPrompt: systemPrompt || "",
      voice: voice && String(voice).trim() ? voice : env.gemini.voice,
      sampleRate, // 8000 (mulaw_8k) o 16000 (pcm_s16le_16k): decide el resampleo del engine
      selectedTools, // el engine las traduce y ejecuta (geminiTools.js)
    },
  };
}

// Inyecta texto a una sesion Gemini viva. La sesion vive en este mismo proceso,
// asi que se resuelve via el store: el engine expone sesion.engineEnviarTexto al
// conectar. El store indexa por session_id; buscamos la sesion por su callId.
async function sendDataMessage(callId, { text }) {
  if (!text) return;
  const sesion = store.buscar((s) => s.callId === callId);
  if (!sesion || typeof sesion.engineEnviarTexto !== "function") {
    logger.warn(`[gemini] sendDataMessage sin sesion viva callId=${callId}`);
    return;
  }
  sesion.engineEnviarTexto(text);
}

// Clasifica un error para decidir el HTTP:
//   "caido"     -> 503 + Retry-After (transitorio: red, 5xx, cuota)
//   "rechazado" -> 502 (4xx: no ayuda reintentar)
//   null        -> 500 generico
function clasificarError(error) {
  const msg = String(error?.message || "");
  const m = msg.match(/Gemini respondio (\d{3})/) || msg.match(/\b(\d{3})\b.*(?:INTERNAL|UNAVAILABLE|RESOURCE_EXHAUSTED|PERMISSION_DENIED|INVALID_ARGUMENT)/);
  if (m) {
    const status = Number(m[1]);
    if (status >= 500 || status === 429) return "caido";
    if (status >= 400) return "rechazado";
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed/i.test(msg)) return "caido";
  return null;
}

module.exports = { crearLlamadaServerWs, sendDataMessage, clasificarError };
