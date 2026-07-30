// El 401 de REST tiene que dejar rastro SIN filtrar el token.
//
// Los dos 401 del middleware devolvian sin loguear: un token rotado o mal
// copiado no dejaba nada con que empezar a mirar. El riesgo de arreglarlo es
// obvio y es lo que cubre este test: la linea que agrego para diagnosticar
// credenciales no puede contener la credencial. En particular req.originalUrl
// SI la contiene cuando se autentica por ?token=, por eso se usa req.path.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const TOKEN = "aiyou_live_SECRETO_NO_DEBE_APARECER";

// Model sustituido por require.cache: sin BD, y de paso db.js no se carga (hace
// exit(1) si faltan las DB_*).
const modelPath = require.resolve("../src/models/apiVoz.model.js");
class ApiVozStub {
  async getEmpresaByToken() {
    return null; // token desconocido
  }
}
require.cache[modelPath] = {
  id: modelPath,
  filename: modelPath,
  path: path.dirname(modelPath),
  loaded: true,
  exports: ApiVozStub,
  children: [],
  paths: [],
};

const { apiVozTokenAuth } = require("../src/middlewares/apiVozToken.middleware.js");

// await adentro del try: el middleware es async, y con un `return fn()` pelado
// el finally restauraria console ANTES de que corriera el log que queremos ver.
async function capturar(fn) {
  const salida = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (m) => salida.push(m);
  console.warn = (m) => salida.push(m);
  console.error = (m) => salida.push(m);
  try {
    await fn();
  } finally {
    Object.assign(console, orig);
  }
  return salida;
}

function reqFake(query = {}) {
  return {
    headers: {},
    query,
    method: "POST",
    path: "/v1/agente-voz/sesiones",
    // Lo que NO hay que loguear: con auth por query string, originalUrl trae el
    // token completo.
    originalUrl: `/v1/agente-voz/sesiones?token=${TOKEN}`,
  };
}

function resFake() {
  const r = { statusCode: null, body: null };
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
}

test("token desconocido: 401 con log, y el token NO aparece", async () => {
  const res = resFake();
  const salida = await capturar(async () => {
    await apiVozTokenAuth(reqFake({ token: TOKEN }), res, () => {});
  });

  assert.strictEqual(res.statusCode, 401);
  const log = salida.join("\n");
  assert.match(log, /RECHAZADO 401 token desconocido/);
  assert.match(log, /\/v1\/agente-voz\/sesiones/, "la ruta si, para saber que endpoint rebota");
  assert.ok(!log.includes(TOKEN), "el token no se loguea, ni un fragmento");
  assert.ok(!log.includes("SECRETO"), "tampoco por pedazos");
});

test("sin token: 401 con log propio (se distingue del token invalido)", async () => {
  const res = resFake();
  const salida = await capturar(async () => {
    await apiVozTokenAuth(reqFake(), res, () => {});
  });

  assert.strictEqual(res.statusCode, 401);
  assert.match(salida.join("\n"), /RECHAZADO 401 sin token/);
});

test("token valido: pasa a next() y no loguea nada", async () => {
  ApiVozStub.prototype.getEmpresaByToken = async () => 8;
  const req = reqFake({ token: TOKEN });
  let siguio = false;

  const salida = await capturar(async () => {
    await apiVozTokenAuth(req, resFake(), () => {
      siguio = true;
    });
  });

  assert.ok(siguio);
  assert.strictEqual(req.apiVozEmpresa, 8);
  assert.strictEqual(salida.length, 0, "el camino feliz no ensucia el log");
});
