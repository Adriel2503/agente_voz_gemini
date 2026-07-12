const test = require("node:test");
const assert = require("node:assert");
const { traducirTools, parseTimeout } = require("../src/tools/geminiTools.js");
const { processTools } = require("../src/tools/processTools.js");
const genericaTools = require("../src/tools/generica.js");

// Tools reales del gateway, con los placeholders resueltos como en produccion.
const resueltas = processTools(genericaTools, {
  idEmpresa: 7,
  providerCallId: "call-123",
  sessionId: "ses_abc",
  backendUrl: null,
});

test("traduce las 4 tools HTTP y omite queryCorpus (built-in sin HTTP)", () => {
  const { functionDeclarations, ejecutables } = traducirTools(resueltas);
  const nombres = functionDeclarations.map((f) => f.name).sort();
  assert.deepStrictEqual(nombres, [
    "agendar_cita",
    "buscarSucursal",
    "obtenerFechaHora",
    "tipificarLlamada",
  ]);
  assert.strictEqual(ejecutables.size, 4);
  assert.ok(!ejecutables.has("queryCorpus"));
});

// Regresion: apuntaba a /api/crm/tools/catalogo, ruta inexistente en app-api
// (el catalogo vive en /api/crm/catalogo, con JWT). Devolvia 404 siempre.
test("obtenerPlanesDisponibles ya no se declara al modelo", () => {
  const { functionDeclarations, ejecutables } = traducirTools(resueltas);
  assert.ok(!functionDeclarations.some((f) => f.name === "obtenerPlanesDisponibles"));
  assert.ok(!ejecutables.has("obtenerPlanesDisponibles"));
});

// hangUp es local: la declara el engine, y NO debe tener ejecutable HTTP (si
// alguien la agregara a generica.js por error, el ejecutor haria un request).
test("hangUp no sale de traducirTools: no es una tool HTTP", () => {
  const { functionDeclarations, ejecutables } = traducirTools(resueltas);
  assert.ok(!functionDeclarations.some((f) => f.name === "hangUp"));
  assert.ok(!ejecutables.has("hangUp"));
});

test("los parametros ESTATICOS no se exponen al modelo pero si al ejecutor", () => {
  const { functionDeclarations, ejecutables } = traducirTools(resueltas);
  const tipificar = functionDeclarations.find((f) => f.name === "tipificarLlamada");
  // El modelo solo ve el parametro dinamico:
  assert.deepStrictEqual(Object.keys(tipificar.parameters.properties), ["id_tipificacion_llamada"]);
  assert.deepStrictEqual(tipificar.parameters.required, ["id_tipificacion_llamada"]);
  // El ejecutor recibe el session_id ya resuelto por processTools:
  assert.strictEqual(ejecutables.get("tipificarLlamada").staticParams.session_id, "ses_abc");
  assert.strictEqual(ejecutables.get("buscarSucursal").staticParams.id_empresa, 7);
});

test("el ejecutor conserva URL, metodo y timeout de cada tool", () => {
  const { ejecutables } = traducirTools(resueltas);
  const tip = ejecutables.get("tipificarLlamada");
  assert.strictEqual(tip.method, "PUT");
  assert.ok(tip.url.includes("/llamadas/nuevaTipificacion"));
  const fechaHora = ejecutables.get("obtenerFechaHora");
  assert.strictEqual(fechaHora.method, "POST");
  assert.strictEqual(fechaHora.timeoutMs, 5000); // "5s"
  const cita = ejecutables.get("agendar_cita");
  assert.strictEqual(cita.method, "POST");
  assert.ok(cita.url.includes("/llamadas/agendarCita"));
});

test("agendar_cita declara sus 4 parametros dinamicos requeridos", () => {
  const { functionDeclarations } = traducirTools(resueltas);
  const cita = functionDeclarations.find((f) => f.name === "agendar_cita");
  assert.deepStrictEqual(Object.keys(cita.parameters.properties).sort(), ["agencia", "fecha", "hora", "tienda"]);
  assert.strictEqual(cita.parameters.required.length, 4);
  assert.strictEqual(cita.parameters.properties.fecha.type, "STRING");
});

test("buscarSucursal: 'numero' es opcional (no va en required)", () => {
  const { functionDeclarations } = traducirTools(resueltas);
  const buscar = functionDeclarations.find((f) => f.name === "buscarSucursal");
  assert.deepStrictEqual(buscar.parameters.required, ["termino"]);
  assert.ok(buscar.parameters.properties.numero);
  assert.strictEqual(buscar.parameters.properties.numero.type, "INTEGER");
});

test("parseTimeout: '5s' -> 5000, invalido -> default 8000", () => {
  assert.strictEqual(parseTimeout("5s"), 5000);
  assert.strictEqual(parseTimeout("30s"), 30000);
  assert.strictEqual(parseTimeout(undefined), 8000);
  assert.strictEqual(parseTimeout("rapido"), 8000);
});

// Ninguna tool generica cae hoy en este caso, pero la rama existe: Gemini
// rechaza un functionDeclaration con "parameters" vacio.
test("tool sin parametros dinamicos no declara 'parameters'", () => {
  const { functionDeclarations } = traducirTools([
    {
      temporaryTool: {
        modelToolName: "ping",
        description: "Sin parametros",
        http: { baseUrlPattern: "https://ejemplo/ping", httpMethod: "GET" },
      },
    },
  ]);
  assert.strictEqual(functionDeclarations[0].parameters, undefined);
});
