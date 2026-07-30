// Guardia de tasa por empresa: balde de tokens (docs/guardias-anti-runaway.md).
// Modulo puro: se testea sin BD ni WS, con reloj inyectado para no dormir.
//
// Los dos parametros que la ventana deslizante anterior fundia en uno:
//   rafaga = capacidad (cuanto entra DE GOLPE), rpm = refill (cuanto SOSTENIDO).
const test = require("node:test");
const assert = require("node:assert");
const tasa = require("../src/lib/tasaSesiones.js");

const T0 = 1_700_000_000_000; // instante base fijo (Date.now no se usa en los tests)
const s = (n) => T0 + n * 1000;

test.beforeEach(() => tasa._reset());

test("rafaga: admite la capacidad de golpe y rebota la siguiente", () => {
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(tasa.admitir(8, 15, 5, s(0)).ok, true, `apertura ${i + 1}`);
  }
  const r = tasa.admitir(8, 15, 5, s(0));
  assert.strictEqual(r.ok, false, "la sexta en el mismo instante rebota");
  assert.ok(r.tokens < 1, `sin token disponible (tokens=${r.tokens})`);
});

test("refill: con rpm=15 se repone 1 token cada 4s exactos", () => {
  for (let i = 0; i < 5; i++) tasa.admitir(8, 15, 5, s(0)); // balde vacio

  assert.strictEqual(tasa.admitir(8, 15, 5, s(3.9)).ok, false, "a los 3.9s aun no hay token entero");
  assert.strictEqual(tasa.admitir(8, 15, 5, s(4)).ok, true, "a los 4s hay exactamente 1");
  assert.strictEqual(tasa.admitir(8, 15, 5, s(4)).ok, false, "y era solo 1");
});

test("el balde no acumula mas que la capacidad por mucho idle que haya", () => {
  tasa.admitir(8, 15, 5, s(0)); // existe desde T0
  // Una hora idle devengaria 900 tokens; el tope es la capacidad.
  const hora = 3600;
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(tasa.admitir(8, 15, 5, s(hora)).ok, true, `apertura ${i + 1} tras idle`);
  }
  assert.strictEqual(tasa.admitir(8, 15, 5, s(hora)).ok, false, "la capacidad sigue siendo 5");
});

// EL TEST CABECERA — el escenario exacto del 16-jul que la ventana deslizante
// NO frenaba: 15 llegadas en 8 segundos. La ventana (limite 15/min) las admitia
// TODAS porque arrancaba vacia. El balde admite la rafaga (5) mas lo devengado
// hasta la ultima llegada (7.47s * 0.25 tokens/s = 1 token entero) y rebota el
// resto.
test("rafaga del 16-jul: 15 llegadas en 8s -> 6 admitidas, 9 rebotadas", () => {
  let admitidas = 0;
  let rebotadas = 0;
  for (let i = 0; i < 15; i++) {
    // llegadas repartidas parejo en 8s, como el marcador remarcando
    const r = tasa.admitir(8, 15, 5, s((i * 8) / 15));
    if (r.ok) admitidas++;
    else rebotadas++;
  }
  assert.strictEqual(admitidas, 6, "5 de rafaga + 1 de refill");
  assert.strictEqual(rebotadas, 9);
});

test("regimen sostenido: al ritmo nominal (1 cada 4s) nunca rebota", () => {
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(tasa.admitir(8, 15, 5, s(i * 4)).ok, true, `llamada ${i + 1}`);
  }
});

// Config no positiva/NaN es config invalida (el env nunca deberia producirla:
// sin setear son 15 y 5). Debe FALLAR ABIERTO — dejar pasar — porque quedarse
// sin guardia es preferible a dejar a la empresa sin atender llamadas.
test("config invalida deja pasar y no registra estado", () => {
  for (const roto of [0, -5, NaN, undefined]) {
    assert.strictEqual(tasa.admitir(8, roto, 5, s(0)).ok, true, `rpm=${roto}`);
    assert.strictEqual(tasa.admitir(8, 15, roto, s(0)).ok, true, `rafaga=${roto}`);
  }
  // Nada de eso creo un balde: la primera admision real arranca con el lleno.
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(tasa.admitir(8, 15, 5, s(0)).ok, true, "el balde nace lleno");
  }
});

// Decision D1 del diseno: el limite es POR EMPRESA, no global.
test("empresas independientes: una sin tokens no afecta a la otra", () => {
  for (let i = 0; i < 5; i++) tasa.admitir(8, 15, 5, s(0));
  assert.strictEqual(tasa.admitir(8, 15, 5, s(0)).ok, false, "la 8 quedo sin tokens");

  for (let i = 0; i < 5; i++) {
    assert.strictEqual(tasa.admitir(40, 15, 5, s(0)).ok, true, "la 40 tiene su propio balde");
  }
  assert.strictEqual(tasa.admitir(40, 15, 5, s(0)).ok, false, "y su propio limite");
});

test("el rechazo no consume: un bucle de reintentos no atrasa el refill", () => {
  for (let i = 0; i < 5; i++) tasa.admitir(8, 15, 5, s(0)); // vacio

  // 39 rebotes en los proximos 3.9s (reintento cada 100ms)
  for (let i = 1; i < 40; i++) {
    assert.strictEqual(tasa.admitir(8, 15, 5, s(i / 10)).ok, false, `rebote ${i}`);
  }
  // El token de los 4s llega igual, como si los rebotes no hubieran existido.
  assert.strictEqual(tasa.admitir(8, 15, 5, s(4)).ok, true);
});

test("reloj que retrocede: no descuenta ni infla tokens", () => {
  tasa.admitir(8, 15, 5, s(10)); // quedan 4, ts=s(10)

  const r = tasa.admitir(8, 15, 5, s(5)); // NTP corrigio 5s hacia atras
  assert.strictEqual(r.ok, true, "no rompe");
  assert.ok(r.tokens >= 3 && r.tokens <= 4, `el delta negativo se trata como 0 (tokens=${r.tokens})`);
});

test("purgar descarta los baldes llenos y conserva los consumidos", () => {
  tasa.admitir(8, 15, 5, s(0)); // 4 tokens: en 4s vuelve a 5 (lleno)
  for (let i = 0; i < 5; i++) tasa.admitir(40, 15, 5, s(0)); // 0 tokens

  tasa.purgar(s(10)); // la 8 ya repuso su token; la 40 apenas lleva 2.5

  // La 8 purgada = como nueva: puede volver a meter la rafaga entera.
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(tasa.admitir(8, 15, 5, s(10)).ok, true, "balde nuevo, lleno");
  }
  // La 40 conserva su deuda: solo tiene lo devengado en 10s (2.5 -> admite 2).
  assert.strictEqual(tasa.admitir(40, 15, 5, s(10)).ok, true);
  assert.strictEqual(tasa.admitir(40, 15, 5, s(10)).ok, true);
  assert.strictEqual(tasa.admitir(40, 15, 5, s(10)).ok, false, "no se le perdono el consumo");
});
