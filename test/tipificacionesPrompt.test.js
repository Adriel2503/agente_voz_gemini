const test = require("node:test");
const assert = require("node:assert");
const { tipificacionesParaPrompt } = require("../src/lib/prompt.js");

// Forma real de lo que devuelve AgenteVozModel.getTipificaciones(): 6 columnas
// por hoja. Datos calcados de produccion (empresa 40, Alfin): equivalencia casi
// siempre NULL, codigo_homologacion_api_agente poblado en todas.
const CATALOGO = [
  { id: 311, nombre: "No Interesado", equivalencia: null, nivel: 2, id_padre: 305, codigo_homologacion_api_agente: "NI" },
  { id: 312, nombre: "Tercero", equivalencia: null, nivel: 2, id_padre: 305, codigo_homologacion_api_agente: "TER" },
  { id: 313, nombre: "audio_corrupto", equivalencia: "AC", nivel: 2, id_padre: 306, codigo_homologacion_api_agente: "AUD" },
  { id: 314, nombre: "Fecha Inválida", equivalencia: null, nivel: 2, id_padre: 306, codigo_homologacion_api_agente: "FI" },
  { id: 315, nombre: "Sin Cobertura", equivalencia: null, nivel: 2, id_padre: 306, codigo_homologacion_api_agente: "SC" },
];

test("al prompt van id, nombre e id_padre; nada mas", () => {
  assert.deepStrictEqual(tipificacionesParaPrompt(CATALOGO), [
    { id: 311, nombre: "No Interesado", id_padre: 305 },
    { id: 312, nombre: "Tercero", id_padre: 305 },
    { id: 313, nombre: "audio_corrupto", id_padre: 306 },
    { id: 314, nombre: "Fecha Inválida", id_padre: 306 },
    { id: 315, nombre: "Sin Cobertura", id_padre: 306 },
  ]);
});

// Por que id_padre sobrevive al recorte: el catalogo real de Alfin tiene 9 hojas
// con nombre repetido en ramas distintas. Sin id_padre son entradas identicas y
// el modelo elige al azar, justo en la familia "no me contacten".
test("id_padre mantiene distinguibles los nombres duplicados", () => {
  const duplicados = [
    { id: 598, nombre: "SOLICITÓ NO SER CONTACTADO", equivalencia: null, nivel: 3, id_padre: 577, codigo_homologacion_api_agente: "90" },
    { id: 599, nombre: "SOLICITÓ NO SER CONTACTADO", equivalencia: null, nivel: 3, id_padre: 578, codigo_homologacion_api_agente: "92" },
  ];
  const [a, b] = tipificacionesParaPrompt(duplicados);
  assert.strictEqual(a.nombre, b.nombre);
  assert.notStrictEqual(a.id_padre, b.id_padre, "quedaron indistinguibles salvo por el id");
});

// EL TEST QUE IMPORTA.
//
// El catalogo tiene DOS consumidores: sesiones.controller lo serializa recortado
// al prompt (:72) y lo pasa entero a la sesion (:122). geminiEngine lee de
// sesion.tipificaciones el codigo_homologacion_api_agente para el webhook
// (:178 camino normal, :289 respaldo desde BD).
//
// Si alguien "optimiza" esto recortando en sitio -- un delete, un
// Object.assign, un forEach que reasigne -- el webhook empieza a salir sin
// codigo de homologacion y no se nota hasta que el integrador reclama.
test("recortar para el prompt NO toca el catalogo que va a la sesion", () => {
  const original = JSON.parse(JSON.stringify(CATALOGO));

  tipificacionesParaPrompt(CATALOGO);

  assert.deepStrictEqual(CATALOGO, original, "el catalogo original fue mutado");
  for (const t of CATALOGO) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(t, "codigo_homologacion_api_agente"),
      `la hoja ${t.id} perdio codigo_homologacion_api_agente`
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(t, "equivalencia"),
      `la hoja ${t.id} perdio equivalencia`
    );
  }
});

test("los objetos devueltos son nuevos, no referencias al catalogo", () => {
  const recortado = tipificacionesParaPrompt(CATALOGO);
  recortado[0].nombre = "MUTADO";
  assert.strictEqual(CATALOGO[0].nombre, "No Interesado");
});

// getTipificaciones puede devolver [] (empresa sin catalogo) y el controller
// llamaba antes con `tipificaciones || []`. No debe reventar el arranque.
test("tolera vacio, null y no-array", () => {
  assert.deepStrictEqual(tipificacionesParaPrompt([]), []);
  assert.deepStrictEqual(tipificacionesParaPrompt(null), []);
  assert.deepStrictEqual(tipificacionesParaPrompt(undefined), []);
  assert.deepStrictEqual(tipificacionesParaPrompt({ id: 1 }), []);
});

// El motivo de todo esto: el peso no son los datos, son los nombres de clave
// repetidos una vez por hoja. Medido en produccion sobre las 27 hojas de Alfin:
// 3731 chars entero vs 1830 recortado.
test("el recorte reduce el JSON a menos de la mitad", () => {
  const antes = JSON.stringify(CATALOGO).length;
  const despues = JSON.stringify(tipificacionesParaPrompt(CATALOGO)).length;
  assert.ok(despues < antes * 0.6, `esperaba menos del 60%: ${despues} vs ${antes}`);
});
