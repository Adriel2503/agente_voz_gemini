// crearSesion: que un fallo de BD al registrar la sesion no fugue el canal.
//
// store.crear reserva el cupo ANTES de los awaits que faltan (a proposito: es lo
// que hace atomico el chequeo del tope). Todo await posterior que pueda fallar
// tiene que devolver esa reserva. El upsert de creacion era el unico que no lo
// hacia: la sesion quedaba ocupando canal hasta que purgarExpiradas la barriera
// (TTL 30s, corre cada 15s => hasta 45s de canal fantasma) pese a que el
// integrador recibia error y nunca iba a conectar.
//
// El controller construye sus models adentro (new AgenteVozModel()), asi que no
// hay inyeccion posible: se sustituyen por require.cache antes de requerirlo.
// Efecto lateral util: db.js no llega a cargarse, y ese modulo hace exit(1) si
// faltan las DB_*.
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "TEST_KEY";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const EMPRESA = 8;

function stub(rel, exports) {
  const filename = require.resolve(rel);
  require.cache[filename] = {
    id: filename,
    filename,
    path: path.dirname(filename),
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
}

class AgenteVozStub {
  static validarVariables() {
    return { ok: true, faltantes: [] };
  }
  async getEmpresa() {
    // canal 0 = sin tope, para que el rechazo del test sea el de BD y nada mas.
    return { id: EMPRESA, gemini_api_key: null, canal: 0, api_voz_activo: 1, id_tool: null };
  }
  async getPlantilla() {
    return { id: 5, prompt: "Hola {{nombre}}" };
  }
  async getFormatoCampos() {
    return [];
  }
  async getTipificaciones() {
    return [];
  }
}

let fallaUpsert = false;
let upserts = [];

class ApiVozStub {
  async getWebhookConfig() {
    return null; // sin webhook: no dispara enviarWebhook
  }
  async upsertSesion(_idEmpresa, payload) {
    upserts.push(payload);
    if (fallaUpsert) throw new Error("connection terminated unexpectedly");
    return 1;
  }
}

stub("../src/models/agenteVoz.model.js", AgenteVozStub);
stub("../src/models/apiVoz.model.js", ApiVozStub);
// El CRM de feriados es una llamada HTTP real: se corta aca para que el test sea
// determinista (y no espere los 5s del timeout de axios).
stub("../src/services/feriados.service.js", { getFeriadosTextoPrompt: async () => "" });

const { crearSesion } = require("../src/controllers/sesiones.controller.js");
const store = require("../src/sessions/store.js");

function reqFake() {
  return {
    apiVozEmpresa: EMPRESA,
    body: { id_plantilla: 5, variables: { nombre: "Ana", telefono: "999" } },
    headers: { host: "agente.test", authorization: "Bearer tok" },
    query: {},
  };
}

function resFake() {
  const r = { statusCode: null, body: null, headers: {} };
  r.set = (k, v) => ((r.headers[k] = v), r);
  r.status = (c) => ((r.statusCode = c), r);
  r.json = (b) => ((r.body = b), r);
  return r;
}

test.beforeEach(() => {
  fallaUpsert = false;
  upserts = [];
});

test("si falla el upsert de creacion, no queda canal ocupado", async () => {
  fallaUpsert = true;
  const res = resFake();

  await crearSesion(reqFake(), res);

  assert.strictEqual(store.contarActivasPorEmpresa(EMPRESA), 0, "el cupo reservado se devolvio");
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.codigo, "agente_indisponible");
  // 503 + Retry-After, no 500: un blip de BD es transitorio y el reintento lo
  // recupera. Un 500 le diria al integrador que no reintente.
  assert.strictEqual(res.headers["Retry-After"], "30");
});

test("camino feliz: la sesion queda registrada, ocupa canal y devuelve 201", async () => {
  const res = resFake();

  await crearSesion(reqFake(), res);

  assert.strictEqual(res.statusCode, 201);
  assert.ok(res.body.session_id.startsWith("ses_"));
  assert.ok(res.body.ws_url.includes(res.body.session_id));
  assert.strictEqual(store.contarActivasPorEmpresa(EMPRESA), 1);
  assert.strictEqual(upserts[0].estado, "created");
  // La fila de creacion es la que lleva la atribucion de campana: el upsert de
  // cierre no manda id_plantilla ni codec ni fecha_inicio. Por eso se aborta la
  // sesion si esta escritura falla, en vez de degradar como con el webhook.
  assert.strictEqual(upserts[0].id_plantilla, 5);
  assert.ok(upserts[0].codec);
  assert.ok(upserts[0].fecha_inicio);

  store.eliminar(res.body.session_id);
});
