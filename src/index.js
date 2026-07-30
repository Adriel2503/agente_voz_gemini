const http = require("http");
const { URL } = require("url");
const express = require("express");
const { WebSocketServer } = require("ws");

const env = require("./config/env.js");
const logger = require("./config/logger.js");
const { testConnection } = require("./config/db.js");
const { instalarRedDeSeguridad } = require("./config/procesoSeguro.js");
const { resolveEmpresaFromToken } = require("./middlewares/apiVozToken.middleware.js");
const sesionesRoutes = require("./routes/sesiones.routes.js");
const { manejarConexion } = require("./ws/geminiEngine.js");
const store = require("./sessions/store.js");

// Lo primero de todo: sin esto un error no capturado se lleva puestas TODAS las
// llamadas activas y no deja ni el stack.
instalarRedDeSeguridad();

// Validaciones de config al arrancar: fallos de configuracion que de otro modo
// solo se notan en produccion, bajo trafico real (o llamadas largas).
if (!env.gemini.apiKey) {
  logger.warn("[index] GEMINI_API_KEY no esta seteada: solo funcionaran empresas con gemini_api_key propia en BD");
}
// Gemini corta la conexion WS por goAway a los ~10 min (600s), avisando unos
// 60s antes. Sin GEMINI_RESUMPTION, ese goAway cierra la llamada en vez de
// reconectar: si MAX_CALL_SECONDS se acerca o supera esa ventana, las llamadas
// mas largas se cortan a mitad de conversacion sin que nadie lo haya pedido.
const GOAWAY_MARGEN_S = 60;
if (!env.gemini.resumption && env.gemini.maxCallSeconds >= 600 - GOAWAY_MARGEN_S) {
  logger.warn(
    `[index] MAX_CALL_SECONDS=${env.gemini.maxCallSeconds}s se acerca o supera el limite de conexion ` +
    `de Gemini (~10min) y GEMINI_RESUMPTION esta apagado: las llamadas que lleguen a esa duracion se ` +
    `cortaran por goAway sin reconectar. Active GEMINI_RESUMPTION=1 o baje MAX_CALL_SECONDS.`
  );
}

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
  // Fuera del try para que el catch de abajo pueda decir de que sesion hablaba.
  let sessionId = "?";
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const match = url.pathname.match(/^\/v1\/sesiones\/([^/]+)$/);
    if (!match) {
      logger.warn(`[upgrade] RECHAZADO ruta desconocida path=${url.pathname}`);
      return socket.destroy();
    }

    sessionId = match[1];
    const token = url.searchParams.get("token");

    const idEmpresa = await resolveEmpresaFromToken(token);
    if (idEmpresa === null) {
      // El rechazo mas dificil de diagnosticar de todos: si el POST funciono
      // pero el WS rebota 401, el token se manco en el camino. Ya paso una vez
      // (el slice(7) que dejaba token= vacio, ver sesiones.controller.js) y se
      // persiguio a ciegas porque no habia una sola linea. El token NO se
      // loguea, ni un fragmento (leccion de 621f770).
      logger.warn(`[upgrade] RECHAZADO 401 token ${token ? "desconocido" : "ausente"} sesion=${sessionId}`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }

    const sesion = store.obtener(sessionId);
    const motivo = store.motivoRechazoConexion(sesion, idEmpresa);
    if (motivo) {
      // Hasta ahora estos rechazos eran mudos: no habia forma de saber si el
      // integrador estaba reconectando sesiones ya terminadas o duplicando WS.
      // Esta linea es a la vez el fix y el sensor.
      logger.warn(`[upgrade] RECHAZADO ${motivo} sesion=${sessionId} empresa=${idEmpresa}`);
      // 404 para los dos casos que ya existian (no cambia nada de lo actual);
      // 409 para los nuevos: la sesion existe, pero no admite conexion.
      const http = motivo === "sesion_finalizada" || motivo === "sesion_ya_conectada"
        ? "409 Conflict"
        : "404 Not Found";
      socket.write(`HTTP/1.1 ${http}\r\n\r\n`);
      return socket.destroy();
    }

    // Reclamo SINCRONICO, antes de handleUpgrade: su callback corre despues, y
    // `conectado` recien se marca dentro de manejarConexion. Sin esto, dos
    // upgrades que resumen a la vez de su await a la BD pasarian los dos.
    // Es un flag aparte de `conectado` a proposito: purgarExpiradas purga por
    // !conectado, asi que si marcaramos conectado aca y el handshake fallara, la
    // sesion no se purgaria nunca y retendria un cupo de canal para siempre.
    store.actualizar(sessionId, { wsReclamado: true });

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._sesionId = sessionId;
      logger.info(`[upgrade] WS conectado sesion=${sessionId} empresa=${idEmpresa}`);
      // noServer + handleUpgrade NO emite "connection" solo: hay que emitirlo a
      // mano para que se enganchen isAlive y el listener de pong (heartbeat).
      wss.emit("connection", ws, req);
      manejarConexion(ws, sesion);
    });
  } catch (error) {
    logger.error(`[upgrade] ${error.message} sesion=${sessionId}`);
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
