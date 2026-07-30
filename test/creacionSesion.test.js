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
const tasaSesiones = require("../src/lib/tasaSesiones.js");

function reqFake(extra = {}) {
  return {
    apiVozEmpresa: EMPRESA,
    body: { id_plantilla: 5, variables: { nombre: "Ana", telefono: "999" }, ...extra },
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
  // Sin esto, el balde de tokens (rafaga default 5) se agota con las creaciones
  // exitosas acumuladas de la suite y el 6to test rebotaria 503 tasa_excedida
  // de forma nada obvia.
  tasaSesiones._reset();
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

// Un POST exitoso no dejaba ningun rastro: se logueaba el intento y los
// rechazos, pero no el resultado. Esta linea es la unica donde el
// external_call_id del integrador y nuestro session_id aparecen juntos, o sea el
// unico punto por donde cruzar su reporte de campana con nuestros logs.
test("el POST exitoso loguea CREADA con las claves de correlacion", async () => {
  const res = resFake();
  const salida = [];
  const orig = console.log;
  console.log = (m) => salida.push(m);
  try {
    await crearSesion(reqFake({ metadata: { external_call_id: "EXT-9911" } }), res);
  } finally {
    console.log = orig;
  }

  const creada = salida.find((l) => l.includes("CREADA"));
  assert.ok(creada, "falta la linea CREADA");
  assert.match(creada, new RegExp(`sesion=${res.body.session_id}`));
  assert.match(creada, /empresa=8/);
  assert.match(creada, /call=EXT-9911/, "el id del integrador es la mitad de la correlacion");

  store.eliminar(res.body.session_id);
});

// --- whitelist de codec ---
//
// El ternario que habia antes (codec === "mulaw_8k" ? 8000 : 16000) aceptaba
// cualquier cosa y la trataba como PCM16 16k. Un typo del integrador ("mulaw_8000")
// no daba error: daba una llamada que sonaba, quemaba canal y tokens, y del otro
// lado solo se escuchaba ruido blanco, sin una sola linea de log que dijera codec.

test("codec desconocido: 400 y no llega a reservar canal", async () => {
  const res = resFake();

  await crearSesion(reqFake({ codec: "mulaw_8000" }), res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.codigo, "codec_invalido");
  assert.match(res.body.msg, /pcm_s16le_16k/, "el mensaje enumera los validos");
  assert.strictEqual(store.contarActivasPorEmpresa(EMPRESA), 0, "rechaza antes de reservar");
  assert.strictEqual(upserts.length, 0, "ni siquiera toca la BD");
});

// El caso que un objeto literal dejaria pasar: CODECS["toString"] seria una
// funcion (truthy). Con Map.get es undefined.
test("un nombre del prototipo de Object no se cuela por la whitelist", async () => {
  const res = resFake();

  await crearSesion(reqFake({ codec: "toString" }), res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.codigo, "codec_invalido");
});

test("mulaw_8k: 201 con sample rate 8000", async () => {
  const res = resFake();

  await crearSesion(reqFake({ codec: "mulaw_8k" }), res);

  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.body.sample_rate_hz, 8000);
  assert.strictEqual(res.body.codec_acordado, "mulaw_8k");

  store.eliminar(res.body.session_id);
});

// null tiene que seguir contando como "no lo mando": el default de destructuring
// solo cubre undefined, y romper por una diferencia de serializacion seria
// gratuito.
test("codec null o ausente cae al default de 16k", async () => {
  for (const body of [{ codec: null }, {}]) {
    const res = resFake();
    await crearSesion(reqFake(body), res);

    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.sample_rate_hz, 16000);
    assert.strictEqual(res.body.codec_acordado, "pcm_s16le_16k");

    store.eliminar(res.body.session_id);
  }
});
