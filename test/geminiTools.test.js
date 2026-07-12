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

test("traduce las 5 tools HTTP y omite queryCorpus (built-in sin HTTP)", () => {
  const { functionDeclarations, ejecutables } = traducirTools(resueltas);
  const nombres = functionDeclarations.map((f) => f.name).sort();
  assert.deepStrictEqual(nombres, [
    "agendar_cita",
    "buscarSucursal",
    "obtenerFechaHora",
    "obtenerPlanesDisponibles",
    "tipificarLlamada",
  ]);
  assert.strictEqual(ejecutables.size, 5);
  assert.ok(!ejecutables.has("queryCorpus"));
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
  const planes = ejecutables.get("obtenerPlanesDisponibles");
  assert.strictEqual(planes.method, "GET");
  assert.strictEqual(planes.timeoutMs, 5000); // "5s"
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

test("tool sin parametros dinamicos no declara 'parameters' (obtenerPlanes)", () => {
  const { functionDeclarations } = traducirTools(resueltas);
  const planes = functionDeclarations.find((f) => f.name === "obtenerPlanesDisponibles");
  assert.strictEqual(planes.parameters, undefined);
});
