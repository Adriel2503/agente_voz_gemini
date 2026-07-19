const http = require("http");
const { URL } = require("url");
const express = require("express");
const { WebSocketServer } = require("ws");

const env = require("./config/env.js");
const logger = require("./config/logger.js");
const { testConnection } = require("./config/db.js");
const { resolveEmpresaFromToken } = require("./middlewares/apiVozToken.middleware.js");
const sesionesRoutes = require("./routes/sesiones.routes.js");
const { manejarConexion } = require("./ws/geminiEngine.js");
const store = require("./sessions/store.js");

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Base REST. El HTML usa api.ai-you.io/v1/agente-voz; aqui todo va bajo el mismo
// dominio agente.ai-you.io para tener un solo deploy.
app.use("/v1/agente-voz", sesionesRoutes);

const server = http.createServer(app);

// WSS de audio en /v1/sesiones/:id?token=  (handshake con auth por query string).
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/v1\/sesiones\/([^/]+)$/);
    if (!match) return socket.destroy();

    const sessionId = match[1];
    const token = url.searchParams.get("token");

    const idEmpresa = await resolveEmpresaFromToken(token);
    if (idEmpresa === null) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }

    const sesion = store.obtener(sessionId);
    if (!sesion || sesion.idEmpresa !== idEmpresa) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._sesionId = sessionId;
      logger.info(`[upgrade] WS conectado sesion=${sessionId} empresa=${idEmpresa}`);
      // noServer + handleUpgrade NO emite "connection" solo: hay que emitirlo a
      // mano para que se enganchen isAlive y el listener de pong (heartbeat).
      wss.emit("connection", ws, req);
      manejarConexion(ws, sesion);
    });
  } catch (error) {
    logger.error(`[upgrade] ${error.message}`);
    socket.destroy();
  }
});

// Heartbeat a nivel WS: Traefik/EasyPanel cortan conexiones idle. Mantener vivo.
const interval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      logger.warn(`[heartbeat] terminando WS sin actividad (${ws._sesionId || "?"})`);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 25000);
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; logger.debug("[heartbeat] pong recibido"); });
  // Cualquier frame entrante (audio o control) tambien cuenta como vivo: algunos
  // clientes WS no responden el ping/pong de protocolo, asi que no dependemos solo
  // del pong para no matar una llamada con audio fluyendo.
  ws.on("message", () => { ws.isAlive = true; });
});
wss.on("close", () => clearInterval(interval));

// Purga sesiones que se crearon pero nunca conectaron (ventana 30s del HTML).
setInterval(() => store.purgarExpiradas(), 15000);

testConnection()
  .then(() => {
    server.listen(env.port, () => logger.info(`[index] Gateway escuchando en :${env.port}`));
  })
  .catch((e) => {
    logger.error(`[index] No se pudo iniciar: ${e.message}`);
    process.exit(1);
  });
