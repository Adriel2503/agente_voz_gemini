// Copiado de app-api (decision: opcion 1). Mantener el algoritmo de hash en sync:
// si app-api cambia hashToken, este archivo debe cambiar igual.
const crypto = require("crypto");
const { pool } = require("../config/db.js");

class ApiVozModel {
  constructor(dbConnection = null) {
    this.connection = dbConnection || pool;
  }

  // SHA-256 simple (sin sal): el token tiene 192 bits de entropia.
  static hashToken(rawToken) {
    return crypto.createHash("sha256").update(rawToken).digest("hex");
  }

  // token (aiyou_live_...) -> id_empresa. Null si no existe o esta inactivo.
  async getEmpresaByToken(rawToken) {
    if (!rawToken || typeof rawToken !== "string") return null;
    const tokenHash = ApiVozModel.hashToken(rawToken);
    const [rows] = await this.connection.execute(
      `SELECT id_empresa FROM configuracion_api_voz
       WHERE token_hash = ? AND estado_registro = 1`,
      [tokenHash]
    );
    return rows[0]?.id_empresa ?? null;
  }

  // Config de webhook por empresa (url + secret para firmar HMAC).
  async getWebhookConfig(idEmpresa) {
    const [rows] = await this.connection.execute(
      `SELECT webhook_url, webhook_secret
       FROM configuracion_api_voz
       WHERE id_empresa = ? AND estado_registro = 1`,
      [idEmpresa]
    );
    return rows[0] || null;
  }

  // Inserta/actualiza una sesion por session_id (idempotente).
  async upsertSesion(idEmpresa, payload) {
    const {
      session_id,
      id_plantilla = null,
      estado = "created",
      codec = null,
      duracion_segundos = 0,
      id_tipificacion = null,
      tipificacion = null,
      variables_capturadas = null,
      metadata = null,
      motivo_fin = null,
      fecha_inicio = null,
      fecha_fin = null,
    } = payload;

    const [result] = await this.connection.execute(
      `INSERT INTO api_voz_sesion
          (session_id, id_empresa, id_plantilla, estado, codec, duracion_segundos,
           id_tipificacion, tipificacion, variables_capturadas, metadata, motivo_fin,
           fecha_inicio, fecha_fin, fecha_registro)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (session_id) DO UPDATE SET
          estado = EXCLUDED.estado,
          codec = COALESCE(EXCLUDED.codec, api_voz_sesion.codec),
          duracion_segundos = GREATEST(EXCLUDED.duracion_segundos, api_voz_sesion.duracion_segundos),
          id_plantilla = COALESCE(EXCLUDED.id_plantilla, api_voz_sesion.id_plantilla),
          id_tipificacion = COALESCE(EXCLUDED.id_tipificacion, api_voz_sesion.id_tipificacion),
          tipificacion = COALESCE(EXCLUDED.tipificacion, api_voz_sesion.tipificacion),
          variables_capturadas = COALESCE(EXCLUDED.variables_capturadas, api_voz_sesion.variables_capturadas),
          metadata = COALESCE(EXCLUDED.metadata, api_voz_sesion.metadata),
          motivo_fin = COALESCE(EXCLUDED.motivo_fin, api_voz_sesion.motivo_fin),
          fecha_inicio = COALESCE(api_voz_sesion.fecha_inicio, EXCLUDED.fecha_inicio),
          fecha_fin = COALESCE(EXCLUDED.fecha_fin, api_voz_sesion.fecha_fin),
          fecha_actualizacion = CURRENT_TIMESTAMP
       RETURNING id`,
      [
        session_id,
        idEmpresa,
        id_plantilla,
        estado,
        codec,
        duracion_segundos,
        id_tipificacion,
        tipificacion ? JSON.stringify(tipificacion) : null,
        variables_capturadas ? JSON.stringify(variables_capturadas) : null,
        metadata ? JSON.stringify(metadata) : null,
        motivo_fin,
        fecha_inicio,
        fecha_fin,
      ]
    );
    return result.rows?.[0]?.id ?? result.insertId ?? null;
  }

  // Registra la cita que el agente agenda durante una sesion de voz.
  // Analogo a agendamiento_llamada: desactiva el agendamiento activo previo de
  // la misma sesion (historial) y luego inserta el nuevo.
  async crearAgendamiento({ session_id, idEmpresa, tienda, agencia, fecha, hora }) {
    await this.connection.execute(
      `UPDATE agendamiento_agente_voz
          SET estado_registro = 0, fecha_actualizacion = CURRENT_TIMESTAMP
        WHERE session_id = ? AND estado_registro = 1`,
      [session_id]
    );

    const [result] = await this.connection.execute(
      `INSERT INTO agendamiento_agente_voz
          (session_id, id_empresa, tienda, agencia, fecha, hora, usuario_registro)
       VALUES (?, ?, ?, ?, ?, ?, 'agente_voz')
       RETURNING id`,
      [session_id, idEmpresa ?? null, tienda || null, agencia || null, fecha || null, hora || null]
    );
    return result.rows?.[0]?.id ?? result.insertId ?? null;
  }
}

module.exports = ApiVozModel;
