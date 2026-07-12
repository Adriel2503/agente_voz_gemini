const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const http = require("node:http");
const logger = require("../src/config/logger.js");
const { enviarWebhook, firmar } = require("../src/services/webhook.service.js");

// Captura los warn del logger (singleton mutable, sin libreria de mocks).
function espiarWarn() {
  const llamadas = [];
  const original = logger.warn;
  logger.warn = (msg) => llamadas.push(msg);
  return { llamadas, restaurar: () => { logger.warn = original; } };
}

function levantarServidor(handler) {
  return new Promise((ok) => {
    const srv = http.createServer(handler);
    srv.listen(0, () => ok(srv));
  });
}

test("firma HMAC-SHA256 sobre el body crudo, verificable por el integrador", () => {
  const secret = "shh";
  const body = JSON.stringify({ event: "session.created", session_id: "ses_1", ts: 1 });
  const firma = firmar(secret, body);
  const esperada = crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.strictEqual(firma, esperada);
});

test("payload plano: sin objeto data, con ts unix (no timestamp ISO)", async () => {
  let recibido = null;
  const srv = await levantarServidor((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      recibido = { headers: req.headers, body: JSON.parse(raw) };
      res.writeHead(200);
      res.end();
    });
  });
  try {
    await enviarWebhook(
      { webhookUrl: `http://127.0.0.1:${srv.address().port}/x`, webhookSecret: "shh" },
      "session.created",
      { session_id: "ses_1", variables: { nombre: "Juan" } }
    );
    assert.strictEqual(recibido.body.event, "session.created");
    assert.strictEqual(recibido.body.session_id, "ses_1");
    assert.deepStrictEqual(recibido.body.variables, { nombre: "Juan" });
    assert.strictEqual(typeof recibido.body.ts, "number");
    assert.strictEqual(recibido.body.data, undefined);
    assert.strictEqual(recibido.body.timestamp, undefined);
    assert.strictEqual(recibido.headers["x-aiyou-event"], "session.created");
    assert.strictEqual(recibido.headers["x-aiyou-timestamp"], String(recibido.body.ts));
    assert.ok(recibido.headers["x-aiyou-signature"]);
  } finally {
    srv.close();
  }
});

test("sin webhookSecret: no se manda X-AiYou-Signature", async () => {
  let headers = null;
  const srv = await levantarServidor((req, res) => {
    headers = req.headers;
    res.writeHead(200);
    res.end();
  });
  try {
    await enviarWebhook({ webhookUrl: `http://127.0.0.1:${srv.address().port}/x` }, "session.connected", { session_id: "ses_1" });
    assert.strictEqual(headers["x-aiyou-signature"], undefined);
  } finally {
    srv.close();
  }
});

test("sin webhookUrl: no intenta red, resuelve de inmediato", async () => {
  const espia = espiarWarn();
  try {
    await enviarWebhook({}, "session.ended", { session_id: "ses_1" });
    assert.strictEqual(espia.llamadas.length, 0);
  } finally {
    espia.restaurar();
  }
});

// Regresion del hueco #1: un 500/404 del integrador NO lanzaba excepcion
// (validateStatus:true) y quedaba invisible — sin log, sin rastro.
test("HTTP >= 300 del integrador SI queda logueado (antes era invisible)", async () => {
  const srv = await levantarServidor((req, res) => {
    res.writeHead(500);
    res.end();
  });
  const espia = espiarWarn();
  try {
    await enviarWebhook({ webhookUrl: `http://127.0.0.1:${srv.address().port}/x` }, "session.tool_call", { session_id: "ses_1" });
    assert.strictEqual(espia.llamadas.length, 1);
    assert.match(espia.llamadas[0], /session\.tool_call/);
    assert.match(espia.llamadas[0], /HTTP 500/);
  } finally {
    espia.restaurar();
    srv.close();
  }
});

test("2xx no genera ningun warning", async () => {
  const srv = await levantarServidor((req, res) => {
    res.writeHead(204);
    res.end();
  });
  const espia = espiarWarn();
  try {
    await enviarWebhook({ webhookUrl: `http://127.0.0.1:${srv.address().port}/x` }, "session.ended", { session_id: "ses_1" });
    assert.strictEqual(espia.llamadas.length, 0);
  } finally {
    espia.restaurar();
    srv.close();
  }
});

test("falla de red (host inexistente): se loguea como fallo, no revienta la sesion", async () => {
  const espia = espiarWarn();
  try {
    await enviarWebhook({ webhookUrl: "http://127.0.0.1:1/x" }, "session.error", { session_id: "ses_1" });
    assert.strictEqual(espia.llamadas.length, 1);
    assert.match(espia.llamadas[0], /fallo session\.error/);
  } finally {
    espia.restaurar();
  }
});
