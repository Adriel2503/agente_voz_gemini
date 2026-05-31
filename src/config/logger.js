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

module.exports = logger;
