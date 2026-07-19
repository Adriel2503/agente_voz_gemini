const test = require("node:test");
const assert = require("node:assert");

// construirLiveConfig se importa desde geminiEngine.js, que arrastra db.js.
// db.js hace process.exit(1) si faltan las env de BD -> seteamos dummies antes
// de requerir (crea el Pool pero no conecta hasta la primera query).
process.env.DB_HOST = process.env.DB_HOST || "localhost";
process.env.DB_USER = process.env.DB_USER || "test";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "test";
process.env.DB_NAME = process.env.DB_NAME || "test";

const { construirLiveConfig } = require("../src/ws/geminiEngine.js");

const cfgBase = { systemPrompt: "hola", voice: "Aoede", model: "gemini-3.1-flash-live-preview" };

// Invariante I1 (parte config): la reconexion agrega sessionResumption SOLO en
// conectarGemini bajo el flag. El builder base compartido NO debe incluirlo,
// para que con GEMINI_RESUMPTION=0 el config sea identico a antes del feature.
test("I1: construirLiveConfig NO incluye sessionResumption (config base intacto)", () => {
  const cfg = construirLiveConfig(cfgBase, []);
  assert.strictEqual("sessionResumption" in cfg, false);
});

test("construirLiveConfig conserva las claves base esperadas", () => {
  const cfg = construirLiveConfig(cfgBase, []);
  assert.ok(cfg.systemInstruction, "systemInstruction");
  assert.deepStrictEqual(cfg.responseModalities, ["AUDIO"]);
  assert.ok(cfg.speechConfig?.voiceConfig, "speechConfig.voiceConfig");
  assert.ok(cfg.realtimeInputConfig?.automaticActivityDetection, "realtimeInputConfig");
  assert.ok(cfg.contextWindowCompression, "contextWindowCompression");
});

test("sin tools, construirLiveConfig no agrega la clave tools", () => {
  const cfg = construirLiveConfig(cfgBase, []);
  assert.strictEqual("tools" in cfg, false);
});

// Contrato del shape que agrega conectarGemini bajo el flag (replicado como
// funcion pura para documentar y fijar la forma esperada por el SDK de Gemini).
function shapeResumption(handle) {
  return handle ? { handle } : {};
}

test("shape de sessionResumption: con handle -> {handle}; sin handle -> {}", () => {
  assert.deepStrictEqual(shapeResumption("abc123"), { handle: "abc123" });
  assert.deepStrictEqual(shapeResumption(null), {});
});
