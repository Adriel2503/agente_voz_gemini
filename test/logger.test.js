// logger.conContexto: la identidad de la llamada se emite en UN solo lugar.
//
// El motor tenia 40 lineas de log y 14 no decian a que llamada pertenecian: con
// 15 llamadas en paralelo, "[gemini] asterisk error: ECONNRESET" no se puede
// atribuir a nada. Repetir el sesion= a mano es lo que produjo esos 14 olvidos,
// asi que lo importante de este helper es que sea imposible olvidarlo.
const test = require("node:test");
const assert = require("node:assert");
const logger = require("../src/config/logger.js");

// Se intercepta console.*, que es a donde escribe el logger (sin dependencias).
function capturar(fn) {
  const salida = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (m) => salida.push(m);
  console.warn = (m) => salida.push(m);
  console.error = (m) => salida.push(m);
  try {
    fn();
  } finally {
    Object.assign(console, orig);
  }
  return salida;
}

test("el contexto se agrega en los cuatro niveles", () => {
  process.env.LOG_DEBUG = "1"; // debug esta apagado por default
  const log = logger.conContexto("sesion=ses_abc empresa=8");

  const salida = capturar(() => {
    log.info("[gemini] arranco");
    log.warn("[gemini] ojo");
    log.error("[gemini] rompio");
    log.debug("[gemini] detalle");
  });
  delete process.env.LOG_DEBUG;

  assert.strictEqual(salida.length, 4);
  for (const linea of salida) {
    assert.match(linea, /sesion=ses_abc empresa=8$/, "el contexto va al final de cada linea");
  }
});

// El [gemini] inicial es por donde se grepea hoy: el contexto va al final
// justamente para no moverlo.
test("no toca el prefijo del mensaje", () => {
  const log = logger.conContexto("sesion=ses_abc");
  const [linea] = capturar(() => log.info("[gemini] asterisk error: ECONNRESET"));

  assert.match(linea, /\[INFO\] \[gemini\] asterisk error: ECONNRESET sesion=ses_abc$/);
});

test("sin contexto no ensucia el mensaje", () => {
  const log = logger.conContexto("");
  const [linea] = capturar(() => log.info("[x] hola"));

  assert.ok(linea.endsWith("[x] hola"), `no debe quedar espacio colgando: ${JSON.stringify(linea)}`);
});

test("el logger normal sigue funcionando igual", () => {
  const [linea] = capturar(() => logger.info("[x] sin contexto"));
  assert.match(linea, /\[INFO\] \[x\] sin contexto$/);
});
