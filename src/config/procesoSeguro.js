// Red de seguridad a nivel proceso.
//
// POR QUE: este gateway sostiene TODAS las llamadas activas en un solo proceso.
// Una excepcion originada en una sesion, si escala hasta el runtime, se lleva
// puestas las 15 llamadas en curso — el mismo daño masivo del 16-jul pero
// disparado por software. La defensa principal es el try/catch por sesion en
// geminiEngine (que cierra solo la sesion que fallo); esto es la red para lo que
// no previmos.
//
// Ademas, hoy un crash es MUDO: sin estos handlers no queda ni el stack, asi que
// el valor grande de este modulo es diagnostico.
//
// Vive en un modulo propio y no inline en index.js para poder testearlo
// (index.js levanta el servidor al requerirse). Ver test/procesoSeguro.test.js.
const logger = require("./logger.js");

// Node 20 imprime el objeto crudo si no es Error; normalizamos para que el log
// siempre traiga algo util.
function detalle(e) {
  if (e instanceof Error) return e.stack || `${e.name}: ${e.message}`;
  try {
    return typeof e === "object" ? JSON.stringify(e) : String(e);
  } catch (_) {
    return String(e);
  }
}

function instalarRedDeSeguridad({ salir = (code) => process.exit(code) } = {}) {
  // NO se sale del proceso. Una promesa fire-and-forget que rechaza no justifica
  // matar 15 llamadas vivas. Node 20 por default SI tumbaria el proceso aca, asi
  // que sobreescribirlo mejora la disponibilidad.
  process.on("unhandledRejection", (razon) => {
    logger.error(`[proceso] unhandledRejection (la llamada sigue): ${detalle(razon)}`);
  });

  // Aca SI se sale. Seguir despues de una excepcion no capturada es operar sobre
  // estado posiblemente corrupto, y Node lo documenta como inseguro. El proceso
  // hoy ya muere en este caso: lo unico que agregamos es el diagnostico.
  // OJO: depende de que la plataforma reinicie el contenedor (el Dockerfile no
  // declara politica de reinicio y el default de Docker es "no").
  process.on("uncaughtException", (e) => {
    logger.error(`[proceso] uncaughtException, saliendo: ${detalle(e)}`);
    salir(1);
  });
}

module.exports = { instalarRedDeSeguridad, detalle };
