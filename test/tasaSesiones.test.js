// Guardia de tasa de apertura (docs/guardias-anti-runaway.md). Modulo puro: se
// testea sin BD ni WS, con reloj inyectado para no dormir 60s.
const test = require("node:test");
const assert = require("node:assert");
const tasa = require("../src/lib/tasaSesiones.js");

const T0 = 1_700_000_000_000; // instante base fijo (Date.now no se usa en los tests)
const s = (n) => T0 + n * 1000;

test.beforeEach(() => tasa._reset());

test("admite hasta el limite y rechaza el siguiente", () => {
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(tasa.admitir(8, 3, s(i)).ok, true, `apertura ${i + 1}`);
  }
  const r = tasa.admitir(8, 3, s(3));
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual({ usados: r.usados, limite: r.limite }, { usados: 3, limite: 3 });
});

test("la ventana DESLIZA: a los 59s sigue rechazando, a los 61s admite", () => {
  tasa.admitir(8, 1, s(0));

  assert.strictEqual(tasa.admitir(8, 1, s(59)).ok, false, "59s: la apertura sigue vigente");
  assert.strictEqual(tasa.admitir(8, 1, s(61)).ok, true, "61s: ya salio de la ventana");
});

// El test que justifica la ventana deslizante frente a una de minuto de reloj.
// Con ventana fija, 5 aperturas al final de un minuto + 5 al principio del
// siguiente pasan las dos tandas: 10 aperturas en ~2 segundos con limite 5.
// Es exactamente el patron del 16-jul (17 sesiones en 10 segundos).
test("rafaga a caballo del borde de minuto NO permite 2x el limite", () => {
  // 5 aperturas en el segundo 58, 59 del "minuto 1"
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(tasa.admitir(8, 5, s(58) + i).ok, true);
  }
  // el reloj cruza a un minuto nuevo: una ventana fija reiniciaria el contador
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(
      tasa.admitir(8, 5, s(60) + i).ok,
      false,
      "cruzar el borde del minuto no debe devolver cupo"
    );
  }
  assert.strictEqual(tasa.usados(8, s(60)), 5, "siguen contando las 5 de la ventana");
});

test("limite 0 desactiva la guardia (y no acumula estado)", () => {
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(tasa.admitir(8, 0, s(i)).ok, true);
  }
  assert.strictEqual(tasa.usados(8, s(50)), 0, "con la guardia off no se registra nada");
});

// Verifica la decision D1 del diseno: el limite es POR EMPRESA, no global.
test("empresas independientes: una en su limite no afecta a la otra", () => {
  for (let i = 0; i < 2; i++) tasa.admitir(8, 2, s(i));
  assert.strictEqual(tasa.admitir(8, 2, s(2)).ok, false, "la 8 esta en su limite");

  assert.strictEqual(tasa.admitir(40, 2, s(2)).ok, true, "la 40 tiene su propio cupo");
  assert.strictEqual(tasa.admitir(40, 2, s(3)).ok, true);
  assert.strictEqual(tasa.admitir(40, 2, s(4)).ok, false, "y su propio limite");

  assert.strictEqual(tasa.usados(8, s(4)), 2);
  assert.strictEqual(tasa.usados(40, s(4)), 2);
});

test("el rechazo en bucle no acumula timestamps viejos", () => {
  tasa.admitir(8, 1, s(0));
  for (let i = 1; i <= 30; i++) tasa.admitir(8, 1, s(i)); // 30 rechazos

  // Solo la apertura admitida sigue contando; los rechazos no se registran.
  assert.strictEqual(tasa.usados(8, s(30)), 1);
  assert.strictEqual(tasa.admitir(8, 1, s(61)).ok, true, "pasada la ventana vuelve a admitir");
});

test("purgar descarta las empresas sin aperturas vigentes", () => {
  tasa.admitir(8, 5, s(0));
  tasa.admitir(40, 5, s(30));

  tasa.purgar(s(70)); // la 8 quedo fuera de ventana, la 40 no
  assert.strictEqual(tasa.usados(8, s(70)), 0);
  assert.strictEqual(tasa.usados(40, s(70)), 1);
});
