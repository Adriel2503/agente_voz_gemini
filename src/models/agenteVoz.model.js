// Resuelve las entidades AiYou que componen un Agente de Voz, scoped a la empresa
// dueña del token. Columnas tomadas del esquema real (modelo.sql).
const { pool } = require("../config/db.js");

class AgenteVozModel {
  constructor(dbConnection = null) {
    this.connection = dbConnection || pool;
  }

  // empresa: key Ultravox (por empresa), gate de voz y tool por defecto.
  async getEmpresa(idEmpresa) {
    const [rows] = await this.connection.execute(
      `SELECT id, ultravox_api_key, api_voz_activo, id_tool
       FROM empresa WHERE id = ? AND estado_registro = 1`,
      [idEmpresa]
    );
    return rows[0] || null;
  }

  // plantilla -> prompt + id_formato. Limitada a la empresa del token.
  async getPlantilla(idEmpresa, idPlantilla) {
    const [rows] = await this.connection.execute(
      `SELECT id, id_formato, nombre, prompt, prompt_resultado
       FROM plantilla
       WHERE id = ? AND id_empresa = ? AND estado_registro = 1`,
      [idPlantilla, idEmpresa]
    );
    return rows[0] || null;
  }

  // Campos del formato (definen las variables exigidas por la plantilla).
  async getFormatoCampos(idFormato) {
    const [rows] = await this.connection.execute(
      `SELECT nombre_campo, etiqueta, tipo_dato, requerido, longitud
       FROM formato_campo
       WHERE id_formato = ? AND estado_registro = 1
       ORDER BY orden ASC`,
      [idFormato]
    );
    return rows;
  }

  // voz -> voice_code de Ultravox. La empresa solo puede usar voces globales
  // (id_empresa NULL) o las suyas propias.
  async getVoz(idVoz, idEmpresa = null) {
    const [rows] = await this.connection.execute(
      `SELECT id, voice_code FROM voz
       WHERE id = ? AND estado_registro = 1 AND (id_empresa IS NULL OR id_empresa = ?)`,
      [idVoz, idEmpresa ?? null]
    );
    return rows[0] || null;
  }

  // tool -> ruta + tipo. Debe ser tipo 'llamada' (catalogo global).
  async getTool(idTool) {
    const [rows] = await this.connection.execute(
      `SELECT id, nombre, ruta, tipo FROM tool WHERE id = ? AND estado_registro = 1`,
      [idTool]
    );
    return rows[0] || null;
  }

  // Catalogo de tipificaciones de la empresa (para mapear los eventos de Ultravox).
  async getTipificaciones(idEmpresa) {
    const [rows] = await this.connection.execute(
      `SELECT id, nombre, equivalencia, nivel, id_padre
       FROM tipificacion_llamada
       WHERE id_empresa = ? AND estado_registro = 1
       ORDER BY orden ASC`,
      [idEmpresa]
    );
    return rows;
  }

  // Valida las variables enviadas contra los formato_campo requeridos.
  // Devuelve { ok, faltantes } sin lanzar.
  static validarVariables(campos, variables = {}) {
    const faltantes = campos
      .filter((c) => Number(c.requerido) === 1)
      .filter((c) => {
        const v = variables[c.nombre_campo];
        return v === undefined || v === null || v === "";
      })
      .map((c) => c.nombre_campo);
    return { ok: faltantes.length === 0, faltantes };
  }
}

module.exports = AgenteVozModel;
