// Invariante del heartbeat: `isAlive` solo lo levanta evidencia ENTRANTE.
//
// El heartbeat de index.js es un detector de vida DEL CLIENTE: cada 25s pone el
// flag en false y manda ping; si al ciclo siguiente sigue en false, mata el
// socket. Marcar isAlive al ESCRIBIR lo apaga por completo, porque la bajada
// corre a 50fps: el flag se levantaba cada 20ms y el chequeo de 25s no podia
// encontrarlo en false nunca. Un socket muerto sin FIN (red partida, host
// congelado, NAT que dropea) retenia entonces canal y TPM hasta
// MAX_CALL_SECONDS (300s) en vez de morir en ~50s.
//
// POR QUE UN TEST SOBRE EL FUENTE Y NO DE COMPORTAMIENTO: la regla vive dentro
// del closure de manejarConexion, que necesita un WS y una conexion Gemini
// reales. Y no es una regla hipotetica: geminiEngine YA la tenia escrita en un
// comentario mientras la violaba siete lineas mas abajo. Esto es lo unico que
// impide que vuelva a pasar.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", "src", ...p), "utf8");
// Los comentarios explican la regla justamente nombrandola: no deben contar.
const sinComentarios = (src) => src.replace(/^\s*\/\/.*$/gm, "");

test("geminiEngine no asigna isAlive en ningun lado", () => {
  const src = sinComentarios(leer("ws", "geminiEngine.js"));
  assert.doesNotMatch(
    src,
    /isAlive\s*=/,
    "escribir hacia el cliente no prueba que el cliente siga vivo: solo pong y message pueden levantar el flag"
  );
});

// Sin esto el test de arriba pasaria vacio si alguien borrara el heartbeat
// entero: hay que verificar que los setters legitimos siguen existiendo.
test("index.js conserva los dos setters entrantes del heartbeat", () => {
  const src = leer("index.js");
  assert.match(src, /on\("pong"[\s\S]{0,60}?isAlive\s*=\s*true/, "el pong del protocolo");
  assert.match(
    src,
    /on\("message"[\s\S]{0,60}?isAlive\s*=\s*true/,
    "el fallback por frame entrante, para clientes que no contestan pong"
  );
  assert.match(src, /isAlive\s*=\s*false/, "el ciclo que arma el chequeo");
});
