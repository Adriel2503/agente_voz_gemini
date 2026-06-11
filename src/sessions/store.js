// Registro en memoria de sesiones activas. Mapea session_id -> contexto necesario
// para que el WSS resuelva la sesion al conectarse Asterisk.
// NOTA: en memoria = una sola instancia. Si se escala a N replicas en EasyPanel,
// migrar a Redis (el ws_url tiene ventana de 30s, asi que el sticky por ahora basta).
const crypto = require("crypto");

const sesiones = new Map();

function nuevoSessionId() {
  return `ses_${crypto.randomBytes(8).toString("hex")}`;
}

function crear(ctx) {
  const session_id = ctx.session_id || nuevoSessionId();
  const registro = {
    creada_en: Date.now(),
    estado: "pendiente",
    conectado: false,
    ...ctx, // idEmpresa, apiKey, callId, joinUrl, idPlantilla, codec, metadata, tipificaciones, webhook
    session_id,
  };
  sesiones.set(session_id, registro);
  return registro;
}

const obtener = (id) => sesiones.get(id) || null;

function actualizar(id, patch) {
  const s = sesiones.get(id);
  if (!s) return null;
  Object.assign(s, patch);
  return s;
}

const eliminar = (id) => sesiones.delete(id);

// Limpia sesiones pendientes que nunca conectaron (ventana de 30s del HTML).
function purgarExpiradas(maxEdadMs = 30000) {
  const ahora = Date.now();
  for (const [id, s] of sesiones) {
    if (!s.conectado && ahora - s.creada_en > maxEdadMs) sesiones.delete(id);
  }
}

module.exports = { crear, obtener, actualizar, eliminar, purgarExpiradas, nuevoSessionId };
