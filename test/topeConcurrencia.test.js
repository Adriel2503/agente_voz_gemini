// Contador del tope de concurrencia por empresa (empresa.canal).
// Ver docs/guardias-anti-runaway.md. El store es puro/en memoria: se testea sin
// BD ni WS. El riesgo que cubren estos tests es que el conteo mezcle empresas
// (contarActivas() SI las mezcla: es global, solo sirve para la traza del log).
const test = require("node:test");
const assert = require("node:assert");
const store = require("../src/sessions/store.js");

// El store es un singleton de modulo: cada test limpia lo que crea para no
// contaminar al siguiente.
function limpiar(ids) {
  for (const id of ids) store.eliminar(id);
}

test("no mezcla empresas: las sesiones de una no ocupan el cupo de la otra", () => {
  const a = store.crear({ idEmpresa: 8 });
  const b = store.crear({ idEmpresa: 8 });
  const c = store.crear({ idEmpresa: 40 });

  assert.strictEqual(store.contarActivasPorEmpresa(8), 2);
  assert.strictEqual(store.contarActivasPorEmpresa(40), 1);
  assert.strictEqual(store.contarActivasPorEmpresa(73), 0, "empresa sin sesiones");

  limpiar([a.session_id, b.session_id, c.session_id]);
});

test("cuenta los estados vivos y descuenta finalizada", () => {
  // pendiente (el default de store.crear) + los estados que setea geminiEngine.
  const pendiente = store.crear({ idEmpresa: 8 });
  const conectada = store.crear({ idEmpresa: 8, estado: "conectada" });
  const enCurso = store.crear({ idEmpresa: 8, estado: "en_curso" });
  assert.strictEqual(store.contarActivasPorEmpresa(8), 3);

  // cerrar() marca finalizada de forma sincrona (geminiEngine.js): el cupo se
  // libera ahi, antes de que el bloque async borre la sesion del store.
  store.actualizar(enCurso.session_id, { estado: "finalizada" });
  assert.strictEqual(store.contarActivasPorEmpresa(8), 2);

  limpiar([pendiente.session_id, conectada.session_id, enCurso.session_id]);
});

test("el cupo se libera al eliminar la sesion", () => {
  const s = store.crear({ idEmpresa: 8 });
  assert.strictEqual(store.contarActivasPorEmpresa(8), 1);

  // Camino de crearSesion cuando el motor falla: store.eliminar libera la reserva.
  store.eliminar(s.session_id);
  assert.strictEqual(store.contarActivasPorEmpresa(8), 0);
});

test("purgarExpiradas libera el cupo de la sesion que nunca conecto", () => {
  const s = store.crear({ idEmpresa: 8 });
  store.actualizar(s.session_id, { creada_en: Date.now() - 60000 }); // vencida
  assert.strictEqual(store.contarActivasPorEmpresa(8), 1);

  store.purgarExpiradas();
  assert.strictEqual(store.contarActivasPorEmpresa(8), 0);
});

test("contarActivas sigue siendo global (traza), contarActivasPorEmpresa no", () => {
  const a = store.crear({ idEmpresa: 8 });
  const b = store.crear({ idEmpresa: 40 });

  assert.strictEqual(store.contarActivas(), 2, "global suma las dos empresas");
  assert.strictEqual(store.contarActivasPorEmpresa(8), 1, "por empresa no");

  limpiar([a.session_id, b.session_id]);
});
