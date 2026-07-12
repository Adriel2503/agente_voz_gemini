// Traduce las tools genericas (formato temporaryTool de Ultravox) al formato
// functionDeclarations de Gemini, y las ejecuta via HTTP.
//
// Diferencia de modelo entre motores: Ultravox ejecutaba el HTTP de cada tool
// por su cuenta (por eso la definicion trae baseUrlPattern/httpMethod y el
// gateway solo recibia el aviso toolUsed). Gemini emite un toolCall con los
// argumentos y ESTE gateway ejecuta el HTTP y le devuelve el resultado
// (sendToolResponse) para que el agente continue la conversacion.
const axios = require("axios");
const logger = require("../config/logger.js");

const TIMEOUT_DEFAULT_MS = 8000;

// "5s" -> 5000. Formato de timeout que usan las definiciones de Ultravox.
function parseTimeout(t) {
  const m = /^(\d+)s$/.exec(String(t || "").trim());
  return m ? Number(m[1]) * 1000 : TIMEOUT_DEFAULT_MS;
}

// De selectedTools (ya pasadas por processTools: placeholders {{session_id}} /
// {{id_empresa}} resueltos y host reescrito) arma:
//  - functionDeclarations: lo que se declara a Gemini. Solo los parametros
//    DINAMICOS (los que el modelo debe rellenar); los estaticos no se exponen.
//  - ejecutables: Map nombre -> { url, method, timeoutMs, staticParams } con
//    todo lo que el ejecutor necesita para hacer el HTTP.
// Las tools sin temporaryTool (built-ins de Ultravox como queryCorpus) no
// tienen equivalente HTTP y se omiten con un log.
function traducirTools(selectedTools = []) {
  const functionDeclarations = [];
  const ejecutables = new Map();

  for (const t of selectedTools) {
    const tt = t && t.temporaryTool;
    if (!tt) {
      logger.warn(`[geminiTools] tool sin equivalente HTTP omitida: ${t?.toolName || "?"}`);
      continue;
    }

    const properties = {};
    const required = [];
    for (const p of tt.dynamicParameters || []) {
      properties[p.name] = {
        type: String(p.schema?.type || "string").toUpperCase(),
        description: p.schema?.description || "",
      };
      if (p.required) required.push(p.name);
    }

    functionDeclarations.push({
      name: tt.modelToolName,
      description: tt.description || "",
      ...(Object.keys(properties).length
        ? { parameters: { type: "OBJECT", properties, ...(required.length ? { required } : {}) } }
        : {}),
    });

    const staticParams = {};
    for (const s of tt.staticParameters || []) staticParams[s.name] = s.value;

    ejecutables.set(tt.modelToolName, {
      url: tt.http?.baseUrlPattern,
      method: String(tt.http?.httpMethod || "POST").toUpperCase(),
      timeoutMs: parseTimeout(tt.timeout),
      staticParams,
    });
  }

  return { functionDeclarations, ejecutables };
}

// Ejecuta la tool contra su endpoint: merge de estaticos + args del modelo en
// el body (todas las tools genericas usan PARAMETER_LOCATION_BODY; en GET van
// como query params). NUNCA lanza: el modelo debe recibir siempre una
// respuesta, aunque sea de error, para poder continuar la conversacion.
async function ejecutarTool(ejecutable, nombre, args) {
  try {
    const body = { ...ejecutable.staticParams, ...(args || {}) };
    const cfg = { method: ejecutable.method, url: ejecutable.url, timeout: ejecutable.timeoutMs };
    if (ejecutable.method === "GET") cfg.params = body;
    else cfg.data = body;
    const { data } = await axios(cfg);
    return { ok: true, data };
  } catch (e) {
    const status = e.response?.status;
    logger.warn(`[geminiTools] ${nombre} fallo${status ? ` (HTTP ${status})` : ""}: ${e.message}`);
    return { ok: false, error: status ? `HTTP ${status}` : e.message };
  }
}

module.exports = { traducirTools, ejecutarTool, parseTimeout };
