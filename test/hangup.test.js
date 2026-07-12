const test = require("node:test");
const assert = require("node:assert");
const { debeColgar, TOOL_HANGUP, COLA_MS, HANGUP_MAX_MS } = require("../src/tools/geminiTools.js");

const T0 = 1_000_000; // reloj fijo: los tests no dependen de Date.now()
const base = {
  colgarPendiente: true,
  outQPendiente: 0,
  ultimoAudioEn: T0,
  ahora: T0,
  limite: T0 + HANGUP_MAX_MS,
};

test("hangUp se declara sin 'parameters' (Gemini rechaza uno vacio)", () => {
  assert.strictEqual(TOOL_HANGUP.name, "hangUp");
  assert.strictEqual(TOOL_HANGUP.parameters, undefined);
  assert.ok(TOOL_HANGUP.description.length > 0);
});

test("sin hangUp pedido no se cuelga nunca", () => {
  assert.strictEqual(
    debeColgar({ ...base, colgarPendiente: false, ahora: T0 + 60_000 }),
    false
  );
});

test("no cuelga mientras quede despedida en outQ", () => {
  assert.strictEqual(
    debeColgar({ ...base, outQPendiente: 3200, ahora: T0 + 5000 }),
    false
  );
});

test("no cuelga con outQ vacia si Gemini todavia esta mandando audio", () => {
  // outQ momentaneamente vacia (la bomba va mas rapido que la red), pero llego
  // audio hace 50 ms: viene mas despedida en camino.
  assert.strictEqual(debeColgar({ ...base, ahora: T0 + 50 }), false);
});

test("cuelga con outQ vacia y silencio sostenido", () => {
  assert.strictEqual(debeColgar({ ...base, ahora: T0 + COLA_MS }), true);
});

test("tope duro: cuelga aunque siga llegando audio", () => {
  // Caso patologico: Gemini no para de hablar. Se cierra igual.
  const ahora = T0 + HANGUP_MAX_MS;
  assert.strictEqual(
    debeColgar({ ...base, outQPendiente: 64_000, ultimoAudioEn: ahora, ahora }),
    true
  );
});

test("sin audio pendiente ni previo, cuelga de una", () => {
  // hangUp sin despedida (ej. el modelo cuelga sin hablar): nada que drenar.
  assert.strictEqual(debeColgar({ ...base, ultimoAudioEn: 0 }), true);
});
