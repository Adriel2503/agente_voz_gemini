// Validacion de estado en el handshake WS (store.motivoRechazoConexion).
//
// Cubre el agujero que encontro la auditoria: el upgrade solo miraba que la
// sesion existiera y fuera de la empresa, asi que una sesion ya conectada -o ya
// terminada por el integrador- aceptaba un upgrade nuevo y abria un SEGUNDO
// puente Gemini invisible para contarActivasPorEmpresa (o sea, saltandose el
// tope de canales y el limite de tasa).
//
// Predicado puro: se testea sin levantar el servidor, sin BD y sin WS.
const test = require("node:test");
const assert = require("node:assert");
const store = require("../src/sessions/store.js");

const EMPRESA = 8;

test("sesion valida y pendiente: puede conectar", () => {
  const s = store.crear({ idEmpresa: EMPRESA });
  assert.strictEqual(store.motivoRechazoConexion(s, EMPRESA), null);
  store.eliminar(s.session_id);
});

test("sesion inexistente", () => {
  assert.strictEqual(store.motivoRechazoConexion(null, EMPRESA), "sesion_desconocida");
  assert.strictEqual(store.motivoRechazoConexion(undefined, EMPRESA), "sesion_desconocida");
});

test("sesion de otra empresa: no se puede conectar con el token ajeno", () => {
  const s = store.crear({ idEmpresa: 40 });
  assert.strictEqual(store.motivoRechazoConexion(s, EMPRESA), "empresa_ajena");
  store.eliminar(s.session_id);
});

// El escenario exacto del hallazgo: el integrador llama POST /terminar antes de
// que Asterisk complete el WS. terminarSesion NO borra el registro (la
// transcripcion se lee de ahi despues), asi que sigue vivo hasta la purga.
// Antes de este fix, conectar en esa ventana resucitaba la sesion.
test("sesion finalizada: no puede resucitar por un upgrade tardio", () => {
  const s = store.crear({ idEmpresa: EMPRESA });
  store.actualizar(s.session_id, { estado: "finalizada" });
  assert.strictEqual(store.motivoRechazoConexion(s, EMPRESA), "sesion_finalizada");
  store.eliminar(s.session_id);
});

test("sesion ya conectada: rechaza el segundo WS", () => {
  const s = store.crear({ idEmpresa: EMPRESA });
  store.actualizar(s.session_id, { conectado: true, estado: "conectada" });
  assert.strictEqual(store.motivoRechazoConexion(s, EMPRESA), "sesion_ya_conectada");
  store.eliminar(s.session_id);
});

// La parte que un chequeo ingenuo (solo `conectado`) dejaria abierta: entre que
// se acepta el upgrade y que manejarConexion marca conectado, hay una ventana en
// la que dos upgrades simultaneos pasarian los dos.
test("reclamado pero todavia sin conectar: tambien rechaza (ventana del handshake)", () => {
  const s = store.crear({ idEmpresa: EMPRESA });
  store.actualizar(s.session_id, { wsReclamado: true });
  assert.strictEqual(s.conectado, false, "todavia no completo el handshake");
  assert.strictEqual(store.motivoRechazoConexion(s, EMPRESA), "sesion_ya_conectada");
  store.eliminar(s.session_id);
});

// Quien define si hay un WS vivo son los flags, no la etiqueta de estado: no hay
// que bloquear por un estado que quedo desactualizado.
test("estado 'conectada' sin flags no bloquea", () => {
  const s = store.crear({ idEmpresa: EMPRESA });
  store.actualizar(s.session_id, { estado: "conectada" });
  assert.strictEqual(store.motivoRechazoConexion(s, EMPRESA), null);
  store.eliminar(s.session_id);
});

// El reclamo NO debe romper la purga: purgarExpiradas mira !conectado, asi que un
// handshake que quedo a medias se limpia igual y libera el cupo de canal.
test("un handshake que nunca completo se purga igual y libera el cupo", () => {
  const s = store.crear({ idEmpresa: EMPRESA });
  store.actualizar(s.session_id, { wsReclamado: true, creada_en: Date.now() - 60000 });
  assert.strictEqual(store.contarActivasPorEmpresa(EMPRESA), 1);

  store.purgarExpiradas();
  assert.strictEqual(store.obtener(s.session_id), null, "se purgo pese al reclamo");
  assert.strictEqual(store.contarActivasPorEmpresa(EMPRESA), 0);
});
