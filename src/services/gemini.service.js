// Cliente del motor de voz Gemini Live. Espejo del contrato de
// ultravox.service.js para que el controller ramifique con el minimo cambio.
//
// Diferencia clave con Ultravox: NO hay paso HTTP previo que devuelva un
// joinUrl. La sesion Gemini se abre recien cuando el integrador conecta su
// WSS (ws/geminiEngine.js hace ai.live.connect). Aqui solo se valida config
// y se arma el contexto que el engine necesita.
const crypto = require("crypto");
const env = require("../config/env.js");
const store = require("../sessions/store.js");
const logger = require("../config/logger.js");

// Crea la "llamada" Gemini: valida la key global, genera un callId propio y
// devuelve la config para el engine. `selectedTools` (ya procesadas por
// processTools) viajan en geminiConfig: el engine las traduce a
// functionDeclarations y ejecuta sus toolCalls (ver tools/geminiTools.js).
// Mismo shape de retorno que Ultravox: { callId, joinUrl } (joinUrl = null).
async function crearLlamadaServerWs({
  apiKey, // eslint-disable-line no-unused-vars -- clave sintetica de canal, la real es env.gemini.apiKey
  systemPrompt,
  voice = null,
  selectedTools = [],
  sampleRate = env.audioSampleRate,
  languageHint = "es", // eslint-disable-line no-unused-vars -- el idioma sale de env.gemini.language
  velocidad = null, // eslint-disable-line no-unused-vars -- sin equivalente en Gemini Live
}) {
  if (!env.gemini.apiKey) {
    // Mensaje con "Gemini respondio 503" para que clasificarError lo mapee a "caido".
    throw new Error("Gemini respondio 503: falta GEMINI_API_KEY en el gateway");
  }

  const callId = `gem_${crypto.randomBytes(8).toString("hex")}`;
  return {
    callId,
    joinUrl: null, // Gemini no tiene URL de sesion previa; el engine conecta directo
    geminiConfig: {
      model: env.gemini.model,
      systemPrompt: systemPrompt || "",
      voice: voice && String(voice).trim() ? voice : env.gemini.voice,
      sampleRate, // 8000 (mulaw_8k) o 16000 (pcm_s16le_16k): decide el resampleo del engine
      selectedTools, // el engine las traduce y ejecuta (geminiTools.js)
    },
  };
}

// Inyecta texto a una sesion viva. Ultravox lo hace por REST; en Gemini la
// sesion vive en este mismo proceso, asi que se resuelve via el store: el
// engine expone sesion.engineEnviarTexto al conectar.
async function sendDataMessage(apiKey, callId, { text }) {
  if (!text) return;
  // El store indexa por session_id; para respetar la firma (apiKey, callId)
  // de Ultravox buscamos la sesion por su callId.
  const sesion = store.buscar((s) => s.callId === callId);
  if (!sesion || typeof sesion.engineEnviarTexto !== "function") {
    logger.warn(`[gemini] sendDataMessage sin sesion viva callId=${callId}`);
    return;
  }
  sesion.engineEnviarTexto(text);
}

// Misma convencion que ultravox.clasificarError:
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
