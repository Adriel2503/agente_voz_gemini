// Se fija la key global ANTES de requerir el modulo: dotenv (en env.js) no
// sobreescribe una var ya presente en process.env, asi el fallback es determinista.
process.env.GEMINI_API_KEY = "GLOBAL_TEST_KEY";

const test = require("node:test");
const assert = require("node:assert");
const { crearLlamadaServerWs } = require("../src/services/gemini.service.js");

// I1: la key de la empresa gana; si es null, fallback a la global.
test("usa la key de la empresa cuando esta cargada", async () => {
  const r = await crearLlamadaServerWs({ apiKey: "gemini:8", geminiApiKey: "AIza-EMPRESA", systemPrompt: "x" });
  assert.strictEqual(r.geminiConfig.apiKey, "AIza-EMPRESA");
});

test("fallback a la key global cuando la empresa la tiene en null", async () => {
  const r = await crearLlamadaServerWs({ apiKey: "gemini:8", geminiApiKey: null, systemPrompt: "x" });
  assert.strictEqual(r.geminiConfig.apiKey, "GLOBAL_TEST_KEY");
});

test("fallback tambien cuando no se pasa geminiApiKey (undefined)", async () => {
  const r = await crearLlamadaServerWs({ apiKey: "gemini:8", systemPrompt: "x" });
  assert.strictEqual(r.geminiConfig.apiKey, "GLOBAL_TEST_KEY");
});

test("la key real viaja en geminiConfig, no en el callId ni fuera de la config", async () => {
  const r = await crearLlamadaServerWs({ apiKey: "gemini:8", geminiApiKey: "AIza-SECRETA", systemPrompt: "x" });
  assert.ok(r.callId.startsWith("gem_"));
  assert.ok(!r.callId.includes("AIza"), "la key no debe filtrarse al callId");
  assert.strictEqual(r.joinUrl, null);
});
