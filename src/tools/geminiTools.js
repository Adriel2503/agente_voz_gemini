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

// Tool LOCAL: no tiene HTTP, su efecto es sobre la sesion (colgar). Por eso no
// vive en generica.js (catalogo de tools HTTP) sino que el engine la inyecta.
// Paridad con ultravox.service.js:86, que hacia lo mismo para todas las
// empresas: selectedTools: [{ toolName: "hangUp" }, ...selectedTools].
// Sin `parameters`: Gemini rechaza un functionDeclaration con parameters vacio.
const COLA_MS = 300; // silencio tras el ultimo audio para dar por drenada la cola
const HANGUP_MAX_MS = 10000; // tope duro del drenaje

const TOOL_HANGUP = {
  name: "hangUp",
  description:
    "Finaliza la llamada telefonica. Invocala DESPUES de decir la frase de " +
    "despedida y, si corresponde, despues de tipificar la llamada. Cuelga de " +
    "verdad y es irreversible: no la uses para pausar ni para cambiar de tema.",
};

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
    // Si el backend explico el rechazo, ese body VA al modelo: un 422 de
    // agendar_cita trae {motivo, mensaje, sugerencia} y el agente se corrige
    // con eso ("esa hora ya paso, ofrecele las 3 de la tarde"). Tirarlo y
    // devolver "HTTP 422" pelado deja al modelo sin nada con que reaccionar.
    const detalle = e.response?.data;
    if (detalle && typeof detalle === "object") {
      return { ok: false, error: `HTTP ${status}`, ...detalle };
    }
    return { ok: false, error: status ? `HTTP ${status}` : e.message };
  }
}

// Decide si ya se puede cerrar tras un hangUp del agente. El modelo dice la
// despedida y EMITE el toolCall enseguida, pero ese audio todavia esta en outQ
// saliendo pautado a 50 fps: cerrar en el instante del toolCall le corta la
// frase al cliente a mitad de palabra. Se drena primero.
//   - `outQPendiente`: bytes que quedan en outQ.
//   - `ultimoAudioEn`: ts del ultimo chunk que mando Gemini (puede seguir
//     llegando audio despues del toolCall).
//   - `limite`: tope duro, por si Gemini nunca deja de hablar.
// Funcion pura para poder testearla sin levantar un WebSocket.
function debeColgar({ colgarPendiente, outQPendiente, ultimoAudioEn, ahora, limite }) {
  if (!colgarPendiente) return false;
  if (ahora >= limite) return true; // tope duro: se cierra igual
  if (outQPendiente > 0) return false; // todavia queda despedida por entregar
  return ahora - ultimoAudioEn >= COLA_MS; // silencio sostenido = drenado
}

module.exports = { traducirTools, ejecutarTool, parseTimeout, debeColgar, TOOL_HANGUP, COLA_MS, HANGUP_MAX_MS };
