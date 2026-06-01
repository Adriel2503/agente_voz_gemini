const axios = require("axios");
const env = require("../config/env.js");
const logger = require("../config/logger.js");

// Feriados del Peru. Portado de aiyou-voice-backend/src/services/feriados.service.js.
// Trae los proximos feriados del CRM (GET /api/feriados/proximos?dias=N) con cache
// en memoria + fallback a cache stale (mejor data vieja que vacia). Sin hardcode.
// El resultado se inyecta en {{feriados_proximos}} del prompt.

let cache = null;
let cachedAt = 0;

async function getFeriadosProximos() {
  const ahora = Date.now();
  if (cache && ahora - cachedAt < env.feriados.cacheTtlMs) return cache;

  const url = `${env.feriados.crmUrl}/api/feriados/proximos?dias=${env.feriados.diasAdelante}`;
  try {
    const { data } = await axios.get(url, { timeout: 5000 });
    if (!data?.ok || !Array.isArray(data.data)) throw new Error("respuesta_invalida");
    cache = data.data;
    cachedAt = ahora;
    logger.info(`[feriados] Fresh del CRM: ${cache.length} feriados proximos`);
    return cache;
  } catch (error) {
    if (cache) {
      logger.warn(`[feriados] CRM fallo (${error.message}), usando cache stale (${cache.length} feriados)`);
      return cache;
    }
    logger.error(`[feriados] CRM fallo (${error.message}) y sin cache previo. Devolviendo lista vacia.`);
    return [];
  }
}

function formatearParaPrompt(lista) {
  if (!Array.isArray(lista) || lista.length === 0) {
    return "_(no hay feriados proximos en los siguientes dias)_";
  }
  return lista.map((f) => `- **${f.fecha}** — ${f.nombre}`).join("\n");
}

async function getFeriadosTextoPrompt() {
  return formatearParaPrompt(await getFeriadosProximos());
}

module.exports = { getFeriadosProximos, formatearParaPrompt, getFeriadosTextoPrompt };
