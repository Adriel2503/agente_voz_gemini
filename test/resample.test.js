const test = require("node:test");
const assert = require("node:assert");
const { upsample8to16, Downsampler24a8, Downsampler24a16 } = require("../src/lib/resample.js");

function pcm(muestras) {
  const b = Buffer.allocUnsafe(muestras.length * 2);
  muestras.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

function muestras(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

test("upsample8to16: x2 con interpolacion lineal y ultima repetida", () => {
  const out = upsample8to16(pcm([100, 200, -300]));
  // [100, (100+200)/2, 200, (200-300)/2, -300, -300]
  assert.deepStrictEqual(muestras(out), [100, 150, 200, -50, -300, -300]);
});

test("upsample8to16: frame telefonico 320B -> 640B", () => {
  const out = upsample8to16(Buffer.alloc(320));
  assert.strictEqual(out.length, 640);
});

test("Downsampler24a8: promedio de cada 3 muestras", () => {
  const ds = new Downsampler24a8();
  const out = ds.process(pcm([300, 600, 900, -30, -60, -90]));
  assert.deepStrictEqual(muestras(out), [600, -60]);
});

test("Downsampler24a8: carry entre chunks desalineados (sin perder muestras)", () => {
  const ds = new Downsampler24a8();
  // 7 muestras en el primer chunk: 2 grupos completos + 1 muestra al carry.
  const out1 = ds.process(pcm([3, 3, 3, 9, 9, 9, 30]));
  assert.deepStrictEqual(muestras(out1), [3, 9]);
  // El 30 del carry se completa con 30, 30 del segundo chunk.
  const out2 = ds.process(pcm([30, 30, 12, 12, 12]));
  assert.deepStrictEqual(muestras(out2), [30, 12]);
  // Nada quedo colgado.
  const out3 = ds.process(pcm([21, 21, 21]));
  assert.deepStrictEqual(muestras(out3), [21]);
});

test("Downsampler24a8: carry a nivel de BYTE impar (chunk cortado a mitad de muestra)", () => {
  const ds = new Downsampler24a8();
  const completo = pcm([300, 600, 900, -30, -60, -90]);
  // Cortamos en un offset impar: 7 bytes / resto.
  const out1 = ds.process(completo.subarray(0, 7));
  const out2 = ds.process(completo.subarray(7));
  const todas = [...muestras(out1), ...muestras(out2)];
  assert.deepStrictEqual(todas, [600, -60]);
});

test("Downsampler24a8: conserva la tasa 3:1 en volumen total", () => {
  const ds = new Downsampler24a8();
  let inBytes = 0;
  let outBytes = 0;
  // Chunks de tamaños arbitrarios (como los de Gemini).
  for (const tam of [1024, 962, 3000, 1, 5, 6144, 777]) {
    const chunk = Buffer.alloc(tam);
    inBytes += tam;
    outBytes += ds.process(chunk).length;
  }
  const pendienteCarry = ds.carry ? ds.carry.length : 0;
  assert.strictEqual(outBytes, ((inBytes - pendienteCarry) / 6) * 2);
  assert.ok(pendienteCarry >= 0 && pendienteCarry < 6);
});

test("Downsampler24a16: 3 muestras -> 2 (s0, promedio s1 s2)", () => {
  const ds = new Downsampler24a16();
  const out = ds.process(pcm([100, 200, 400, -100, -200, -400]));
  assert.deepStrictEqual(muestras(out), [100, 300, -100, -300]);
});

test("Downsampler24a16: carry entre chunks", () => {
  const ds = new Downsampler24a16();
  const out1 = ds.process(pcm([100, 200, 400, 500])); // 1 grupo + 1 al carry
  assert.deepStrictEqual(muestras(out1), [100, 300]);
  const out2 = ds.process(pcm([700, 900]));
  assert.deepStrictEqual(muestras(out2), [500, 800]);
});

test("cadena telefonica: 1s de audio 24k -> 8k produce exactamente 1s", () => {
  const ds = new Downsampler24a8();
  // 24000 muestras = 48000 bytes, entregadas en chunks irregulares.
  let out = 0;
  let restante = 48000;
  const tams = [1000, 1437, 962, 4096];
  let i = 0;
  while (restante > 0) {
    const tam = Math.min(tams[i++ % tams.length], restante);
    out += ds.process(Buffer.alloc(tam)).length;
    restante -= tam;
  }
  assert.strictEqual(out, 16000); // 8000 muestras = 1s @ 8kHz
});
