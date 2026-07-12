const test = require("node:test");
const assert = require("node:assert");
const { renderPrompt, variablesSinResolver, saludoPorHora, fechasLima } = require("../src/lib/prompt.js");

test("saludoPorHora: manana / tarde / noche", () => {
  assert.strictEqual(saludoPorHora("06:00"), "Que tenga buen día");
  assert.strictEqual(saludoPorHora("11:59"), "Que tenga buen día");
  assert.strictEqual(saludoPorHora("12:00"), "Que tenga buenas tardes");
  assert.strictEqual(saludoPorHora("18:59"), "Que tenga buenas tardes");
  assert.strictEqual(saludoPorHora("19:00"), "Que tenga buenas noches");
  assert.strictEqual(saludoPorHora("03:30"), "Que tenga buenas noches"); // madrugada
});

test("fechasLima entrega saludo_horario ya resuelto", () => {
  const f = fechasLima();
  assert.strictEqual(f.saludo_horario, saludoPorHora(f.hora_actual));
});

// El bug de produccion: renderPrompt DEJA el {{...}} literal si no hay valor, y
// el agente se lo lee al cliente ("Que tenga buenas tardes, nombre corto").
test("variablesSinResolver detecta lo que quedo literal tras el render", () => {
  const render = renderPrompt("Hola {{nombre_corto}}, le esperamos en {{tienda_x}}.", {
    nombre_corto: "julio",
  });
  assert.strictEqual(render, "Hola julio, le esperamos en {{tienda_x}}.");
  assert.deepStrictEqual(variablesSinResolver(render), ["tienda_x"]);
});

test("prompt sin huerfanas -> lista vacia", () => {
  const render = renderPrompt("Hola {{nombre_corto}}.", { nombre_corto: "julio" });
  assert.deepStrictEqual(variablesSinResolver(render), []);
});

// Por que los slots del agente NO pueden escribirse con llaves: renderPrompt
// tambien sustituye la llave simple, asi que {direccion_limpia} usado como slot
// se rellenaba con la direccion de la tienda #1 (dato equivocado, no un hueco).
test("la llave simple TAMBIEN se sustituye (por eso los slots van con <>)", () => {
  const render = renderPrompt("Le esperamos en {direccion_limpia}.", {
    direccion_limpia: "Av. Tupac Amaru 1070",
  });
  assert.strictEqual(render, "Le esperamos en Av. Tupac Amaru 1070.");
  assert.deepStrictEqual(variablesSinResolver("Le esperamos en <direccion_encontrada>."), []);
});
