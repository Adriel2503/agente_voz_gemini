// Red de seguridad a nivel proceso (src/config/procesoSeguro.js).
//
// Se testea lanzando procesos HIJO de verdad: es la unica forma honesta de
// verificar handlers de proceso, porque registrarlos en el runner contaminaria
// al resto de la suite y `process.exit` la mataria.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const MODULO = path.join(__dirname, "..", "src", "config", "procesoSeguro.js").replace(/\\/g, "/");

function correr(cuerpo) {
  const src = `
    const { instalarRedDeSeguridad } = require(${JSON.stringify(MODULO)});
    instalarRedDeSeguridad();
    ${cuerpo}
  `;
  return spawnSync(process.execPath, ["-e", src], { encoding: "utf8" });
}

test("unhandledRejection: loguea y NO mata el proceso", () => {
  // Un rechazo suelto no justifica tumbar las 15 llamadas activas. Node 20 por
  // default SI mataria el proceso: el handler existe para evitar justamente eso.
  const r = correr(`
    Promise.reject(new Error("rechazo suelto"));
    setTimeout(() => { console.log("SIGO VIVO"); }, 120);
  `);

  assert.strictEqual(r.status, 0, "no debe terminar por el rechazo");
  assert.match(r.stdout, /SIGO VIVO/, "el proceso siguio corriendo");
  assert.match(r.stdout + r.stderr, /unhandledRejection/);
  assert.match(r.stdout + r.stderr, /rechazo suelto/, "el motivo queda en el log");
});

test("uncaughtException: loguea el stack y sale con codigo 1", () => {
  // Aca si se sale: seguir despues de una excepcion no capturada es operar sobre
  // estado posiblemente corrupto. Hoy el proceso ya moria; lo que suma el handler
  // es el diagnostico, que antes no quedaba en ningun lado.
  const r = correr(`
    setTimeout(() => { throw new Error("explosion no capturada"); }, 10);
    setTimeout(() => { console.log("NO DEBERIA LLEGAR"); }, 300);
  `);

  assert.strictEqual(r.status, 1, "debe salir con codigo 1");
  assert.doesNotMatch(r.stdout, /NO DEBERIA LLEGAR/, "no sigue ejecutando");
  assert.match(r.stdout + r.stderr, /uncaughtException/);
  assert.match(r.stdout + r.stderr, /explosion no capturada/);
  assert.match(r.stdout + r.stderr, /procesoSeguro\.test|at /, "incluye stack");
});

test("un rechazo con valor no-Error tambien deja algo util en el log", () => {
  // Node imprime el objeto crudo si no es Error; detalle() lo normaliza para que
  // el log no quede en "[object Object]".
  const r = correr(`
    Promise.reject({ codigo: "RESOURCE_EXHAUSTED", detalle: "quota" });
    setTimeout(() => {}, 80);
  `);

  assert.strictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /RESOURCE_EXHAUSTED/, "no debe quedar como [object Object]");
});
