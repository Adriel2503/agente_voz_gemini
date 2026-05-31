require("dotenv").config();

const env = {
  port: parseInt(process.env.PORT, 10) || 3000,
  ultravox: {
    baseUrl: process.env.ULTRAVOX_BASE_URL || "https://api.ultravox.ai/api",
    timeoutMs: parseInt(process.env.ULTRAVOX_TIMEOUT_MS, 10) || 30000,
    reintentos: parseInt(process.env.ULTRAVOX_REINTENTOS, 10) || 2,
  },
  defaultVoiceCode: process.env.DEFAULT_VOICE_CODE || null,
  audioSampleRate: parseInt(process.env.AUDIO_SAMPLE_RATE, 10) || 8000,
  // Si se setea, processTools reescribe los hosts ai-you.io de las tools a esta URL.
  // null = dejar las URLs de las tools genéricas tal cual (app-api.ai-you.io).
  toolsBackendUrl: process.env.TOOLS_BACKEND_URL || null,
};

module.exports = env;
