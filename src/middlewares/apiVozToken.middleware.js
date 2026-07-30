const ApiVozModel = require("../models/apiVoz.model.js");
const logger = require("../config/logger.js");

// Autentica por Bearer (REST) o ?token= (igual que el WSS). Resuelve la empresa
// dueña del token y la expone en req.apiVozEmpresa.
const apiVozTokenAuth = async (req, res, next) => {
  try {
    const header = req.headers["authorization"] || "";
    const rawToken = header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : (req.query.token || "").trim();

    // Los dos 401 dejan rastro: un token rotado o mal copiado devolvia 401 en
    // silencio absoluto y no habia con que empezar a mirar.
    //
    // Se usa req.path y NUNCA req.originalUrl: cuando se autentica por query
    // string, originalUrl CONTIENE el token, y filtrar la credencial en la linea
    // que agrego justamente para diagnosticar credenciales seria absurdo. El
    // token no se loguea, ni un fragmento (leccion de 621f770).
    if (!rawToken) {
      logger.warn(`[auth] RECHAZADO 401 sin token ${req.method} ${req.path}`);
      return res.status(401).json({ codigo: "auth_invalida", msg: "Token no proporcionado" });
    }

    const idEmpresa = await new ApiVozModel().getEmpresaByToken(rawToken);
    if (idEmpresa === null) {
      logger.warn(`[auth] RECHAZADO 401 token desconocido ${req.method} ${req.path}`);
      return res.status(401).json({ codigo: "auth_invalida", msg: "Token invalido" });
    }

    req.apiVozEmpresa = idEmpresa;
    next();
  } catch (error) {
    logger.error(`[apiVozToken.middleware] ${error.message}`);
    return res.status(500).json({ codigo: "error_interno", msg: "Error al validar token" });
  }
};

// Variante para el handshake del WebSocket: valida ?token= y devuelve idEmpresa o null.
const resolveEmpresaFromToken = async (rawToken) => {
  if (!rawToken) return null;
  return new ApiVozModel().getEmpresaByToken(rawToken.trim());
};

module.exports = { apiVozTokenAuth, resolveEmpresaFromToken };
