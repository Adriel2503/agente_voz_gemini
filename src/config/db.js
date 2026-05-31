// Conexión a Aurora Postgres. Replica el wrapper de app-api (pg + compat `?`->`$n`)
// para que el ApiVozModel copiado funcione sin cambios.
const { Pool, types } = require("pg");
const logger = require("./logger.js");

// TIMESTAMP WITHOUT TIMEZONE (OID 1114): devolver ISO sin Z (hora local Lima).
types.setTypeParser(1114, (str) => (str ? str.replace(" ", "T") : null));

const requiredEnvVars = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"];
const missing = requiredEnvVars.filter((v) => !process.env[v]);
if (missing.length > 0) {
  logger.error(`[db.js] Faltan variables de entorno requeridas: ${missing.join(", ")}`);
  process.exit(1);
}

const pgPool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
  max: 10,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 10000,
  options: "-c timezone=America/Lima",
  ssl: { rejectUnauthorized: false }, // RDS
});

pgPool.on("error", (err) => {
  logger.error(`[db.js] Error en conexión idle del pool: ${err.message}`);
});

const testConnection = async () => {
  const client = await pgPool.connect();
  await client.query("SELECT 1");
  client.release();
  logger.info(`[db.js] Conexion a Postgres OK (BD: ${process.env.DB_NAME})`);
};

// Wrapper compatible con la interfaz mysql2 que usan los models (execute -> [rows]).
const executeQuery = async (sql, params = [], retries = 1) => {
  let paramIndex = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++paramIndex}`);

  let result;
  try {
    result = await pgPool.query(pgSql, params);
  } catch (error) {
    if (
      retries > 0 &&
      /connection terminated/i.test(error.message || "")
    ) {
      logger.warn("[db.js] Conexion perdida, reintentando query...");
      return executeQuery(sql, params, retries - 1);
    }
    throw error;
  }

  const compat = {
    ...result,
    affectedRows: result.rowCount,
    insertId: result.rows?.[0]?.id ?? null,
  };

  const isSelect = /^\s*(SELECT|WITH)\b/i.test(sql);
  return isSelect ? [result.rows, compat] : [compat, undefined];
};

const pool = {
  query: executeQuery,
  execute: executeQuery,
  connect: pgPool.connect.bind(pgPool),
  end: pgPool.end.bind(pgPool),
  on: pgPool.on.bind(pgPool),
};

module.exports = { pool, testConnection };
