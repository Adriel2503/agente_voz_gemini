// Envia webhooks firmados con HMAC-SHA256, segun la seccion 7 del HTML.
// El secret y la url son por empresa (configuracion_api_voz).
const crypto = require("crypto");
const axios = require("axios");
const logger = require("../config/logger.js");

// Firma sobre el body crudo (sin timestamp). El header lleva el hex pelado.
function firmar(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

// event: session.created | session.connected | session.tipificacion |
//        session.tool_call | session.ended | session.error
async function enviarWebhook({ webhookUrl, webhookSecret }, event, payload) {
  if (!webhookUrl) return; // empresa sin webhook configurado
  const timestamp = Math.floor(Date.now() / 1000);
  const body = { event, ...payload, ts: timestamp };
  // Serializamos nosotros para que la firma cubra exactamente el byte-string enviado.
  const rawBody = JSON.stringify(body);

  const headers = {
    "Content-Type": "application/json",
    "X-AiYou-Event": event,
    "X-AiYou-Timestamp": String(timestamp),
  };
  if (webhookSecret) {
    headers["X-AiYou-Signature"] = firmar(webhookSecret, rawBody);
  }

  try {
    await axios.post(webhookUrl, rawBody, { headers, timeout: 8000, validateStatus: () => true });
  } catch (error) {
    // No reventar la sesion por un webhook fallido; el integrador puede reintentar via GET.
    logger.warn(`[webhook] fallo ${event} -> ${webhookUrl}: ${error.message}`);
  }
}

module.exports = { enviarWebhook, firmar };
