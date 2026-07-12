const test = require("node:test");
const assert = require("node:assert");
const { AudioQueue } = require("../src/lib/audioQueue.js");

test("FIFO: los frames salen en el orden en que entraron", () => {
  const q = new AudioQueue();
  q.push(Buffer.from([1, 2, 3, 4]));
  q.push(Buffer.from([5, 6, 7, 8]));
  assert.deepStrictEqual([...q.popFrame(4)], [1, 2, 3, 4]);
  assert.deepStrictEqual([...q.popFrame(4)], [5, 6, 7, 8]);
  assert.strictEqual(q.popFrame(4), null);
});

test("popFrame parcial: null hasta completar el frame, re-trocea chunks desiguales", () => {
  const q = new AudioQueue();
  q.push(Buffer.from([1, 2, 3])); // 3 bytes: no alcanza para un frame de 4
  assert.strictEqual(q.popFrame(4), null);
  q.push(Buffer.from([4, 5, 6, 7, 8, 9])); // ahora hay 9
  assert.deepStrictEqual([...q.popFrame(4)], [1, 2, 3, 4]);
  assert.deepStrictEqual([...q.popFrame(4)], [5, 6, 7, 8]);
  assert.strictEqual(q.popFrame(4), null); // queda 1 byte suelto
  assert.strictEqual(q.length, 1);
});

test("clear (barge-in) descarta todo lo pendiente", () => {
  const q = new AudioQueue();
  q.push(Buffer.alloc(1000, 7));
  q.popFrame(320);
  q.clear();
  assert.strictEqual(q.length, 0);
  assert.strictEqual(q.popFrame(1), null);
  // Sigue usable despues del clear.
  q.push(Buffer.from([9, 9]));
  assert.deepStrictEqual([...q.popFrame(2)], [9, 9]);
});

test("el frame devuelto es copia propia (no alias del buffer interno)", () => {
  const q = new AudioQueue();
  q.push(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  const f = q.popFrame(4);
  q.push(Buffer.alloc(10000, 0xff)); // fuerza consolidacion/compactacion
  q.popFrame(4);
  assert.deepStrictEqual([...f], [1, 2, 3, 4]); // f sigue intacto
});

test("stress: muchos push/pop mantienen integridad y memoria acotada", () => {
  const q = new AudioQueue();
  let escrito = 0;
  let leido = 0;
  let sec = 0; // byte secuencial 0..255 ciclico para verificar orden
  let esperado = 0;
  for (let ronda = 0; ronda < 2000; ronda++) {
    // push de tamaño variable (simula chunks de Gemini)
    const tam = 100 + (ronda % 700);
    const chunk = Buffer.allocUnsafe(tam);
    for (let i = 0; i < tam; i++) chunk[i] = sec++ & 0xff;
    q.push(chunk);
    escrito += tam;
    // pop de frames fijos de 320 (como el bridge)
    let f;
    while ((f = q.popFrame(320)) !== null) {
      for (const b of f) {
        assert.strictEqual(b, esperado & 0xff, `byte ${leido} corrupto`);
        esperado++;
        leido++;
      }
    }
  }
  assert.strictEqual(q.length, escrito - leido);
  // El buffer interno no debe retener mas que lo pendiente + el head vivo
  // (compactacion funcionando): cota holgada de 2 frames + head maximo.
  assert.ok(q.buf.length < 320 * 8 + 4096, `buffer interno crecio: ${q.buf.length}`);
});
