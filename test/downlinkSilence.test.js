const test = require("node:test");
const assert = require("node:assert");
const { pcm16ToMuLaw, muLawToPcm16 } = require("../src/lib/g711.js");

// Blindaje de la "trampa del mulaw" del silencio de bajada (geminiEngine.js).
// El silencio de relleno se precomputa como `esMulaw ? pcm16ToMuLaw(SILENCIO) : SILENCIO`.
// En mulaw el silencio NO es 0x00 (eso decodifica a fondo de escala = zumbido),
// es 0xFF. Estos tests fijan ese contrato para que nadie lo rompa al refactorizar.

test("silencio mulaw: pcm16ToMuLaw(ceros) es todo 0xFF, no 0x00", () => {
  const frameBytes = 320; // frame telefonico de 20ms @ 8kHz en PCM16
  const SILENCIO = Buffer.alloc(frameBytes); // PCM16 en ceros
  const bajada = pcm16ToMuLaw(SILENCIO);
  assert.strictEqual(bajada.length, 160, "320B PCM16 -> 160B mulaw");
  assert.ok(bajada.every((b) => b === 0xff), "cada byte de silencio mulaw debe ser 0xFF");
});

test("la trampa: mandar ceros crudos como mulaw NO es silencio (seria zumbido)", () => {
  // Demostracion de POR QUE hay que codificar: 0x00 interpretado como mulaw
  // decodifica a una amplitud enorme (fondo de escala), no a silencio.
  const crudo = Buffer.alloc(160); // 0x00 crudos, sin codificar
  const decodificado = muLawToPcm16(crudo);
  const amplitud = Math.abs(decodificado.readInt16LE(0));
  assert.ok(amplitud > 30000, `0x00 como mulaw = tono fuerte (amplitud ${amplitud}), no silencio`);
});

test("silencio mulaw round-trip: decodifica a ~0 (silencio real)", () => {
  const SILENCIO = Buffer.alloc(320);
  const bajada = pcm16ToMuLaw(SILENCIO); // lo que realmente mandamos al cliente
  const decodificado = muLawToPcm16(bajada);
  for (let i = 0; i < decodificado.length; i += 2) {
    assert.ok(Math.abs(decodificado.readInt16LE(i)) <= 8, "silencio mulaw debe decodificar a ~0");
  }
});

test("silencio PCM crudo (16k): los ceros ya son silencio real, sin codificar", () => {
  const frameBytes = 640; // frame de 20ms @ 16kHz en PCM16
  const SILENCIO = Buffer.alloc(frameBytes);
  // En el camino pcm_s16le_16k SILENCIO_BAJADA = SILENCIO tal cual (sin mulaw).
  assert.ok(SILENCIO.every((b) => b === 0x00), "PCM16 en ceros es silencio real por construccion");
});
