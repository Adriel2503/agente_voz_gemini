// Logger minimalista (sin dependencias). El gateway no necesita el winston de app-api.
const ts = () => new Date().toISOString();

const logger = {
  info: (msg) => console.log(`${ts()} [INFO] ${msg}`),
  warn: (msg) => console.warn(`${ts()} [WARN] ${msg}`),
  error: (msg) => console.error(`${ts()} [ERROR] ${msg}`),
  debug: (msg) => {
    if (process.env.LOG_DEBUG === "1") console.log(`${ts()} [DEBUG] ${msg}`);
  },
};

// Logger con contexto fijo, que se agrega al final de cada mensaje.
//
// POR QUE: repetir `sesion=${...}` a mano en 40 lugares garantiza que en la
// mitad se olvide, y eso ya paso: 14 lineas del motor no decian a que llamada
// pertenecian. Con 15 llamadas en paralelo, "[gemini] asterisk error:
// ECONNRESET" es texto sin informacion. Agregar `empresa=` a mano en esos mismos
// 40 lugares habria repetido el error a mayor escala; con esto hay UN solo lugar
// que emite la identidad y es imposible que una linea nueva se la olvide.
//
// El contexto va al FINAL a proposito: el `[gemini]` inicial es por donde se
// grepea hoy y no se mueve. Y con el sufijo uniforme, un grep por sesion=ses_xxx
// devuelve la llamada completa, que es todo el punto.
function conContexto(ctx) {
  const suf = ctx ? ` ${ctx}` : "";
  return {
    info: (msg) => logger.info(msg + suf),
    warn: (msg) => logger.warn(msg + suf),
    error: (msg) => logger.error(msg + suf),
    debug: (msg) => logger.debug(msg + suf),
  };
}

module.exports = logger;
module.exports.conContexto = conContexto;
