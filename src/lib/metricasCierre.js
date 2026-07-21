// Contador en memoria de cierres de sesion Gemini, agregado por motivo/code/reason.
// Objetivo: ver en el log, sin tocar la BD, si el problema dominante es TPM
// (RESOURCE_EXHAUSTED via cierre 1011/onerror) u otra cosa. Vive todo el proceso
// (no hay reset entre sesiones); un restart del gateway reinicia el conteo.
// Ver docs/keys-gemini-por-empresa.md ("Observabilidad para decidir").
const logger = require("../config/logger.js");

const INTERVALO_MS = 5 * 60 * 1000; // 5 min

const conteos = new Map(); // clave "motivo|code|reason" -> cantidad
let arrancadoEn = null;

function clave({ motivo, code, reason }) {
  return `${motivo || "?"}|${code ?? "?"}|${reason || "?"}`;
}

function registrar(detalle) {
  if (!arrancadoEn) arrancadoEn = Date.now();
  const k = clave(detalle);
  conteos.set(k, (conteos.get(k) || 0) + 1);
}

function resumen() {
  return [...conteos.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
}

// Log periodico (solo si hubo al menos un cierre): motivo|code|reason=cantidad,
// ordenado de mas a menos frecuente. unref() para no mantener vivo el proceso
// (ni bloquear la salida de `node --test`, que requiere este modulo indirecto).
const timer = setInterval(() => {
  if (conteos.size === 0) return;
  const minutos = Math.round((Date.now() - arrancadoEn) / 60000);
  logger.info(`[gemini] RESUMEN cierres desde el arranque (hace ${minutos}min): ${resumen()}`);
}, INTERVALO_MS);
timer.unref();

module.exports = { registrar, resumen };
