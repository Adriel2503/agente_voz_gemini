require("dotenv").config();

const env = {
  port: parseInt(process.env.PORT, 10) || 3000,
  ultravox: {
    baseUrl: process.env.ULTRAVOX_BASE_URL || "https://api.ultravox.ai/api",
    timeoutMs: parseInt(process.env.ULTRAVOX_TIMEOUT_MS, 10) || 30000,
    reintentos: parseInt(process.env.ULTRAVOX_REINTENTOS, 10) || 2,
  },
  defaultVoiceCode: process.env.DEFAULT_VOICE_CODE || null,
  // Provider de la voz por defecto (para construir voiceOverrides de velocidad
  // cuando no se manda id_voz). "Eleven Labs" se normaliza a "elevenlabs".
  defaultVoiceProvider: process.env.DEFAULT_VOICE_PROVIDER || "elevenlabs",
  // Velocidad de habla global por defecto. null = no aplicar override (normal).
  defaultVoiceSpeed: process.env.DEFAULT_VOICE_SPEED ? parseFloat(process.env.DEFAULT_VOICE_SPEED) : null,
  audioSampleRate: parseInt(process.env.AUDIO_SAMPLE_RATE, 10) || 8000,
  // Ventana de gracia tras el colgado del caller para que el agente alcance a
  // tipificar (tool tipificarLlamada) antes de cerrar Ultravox y disparar el
  // webhook session.ended. 0 = cerrar inmediato (comportamiento anterior).
  graciaTipificacionMs: parseInt(process.env.GRACIA_TIPIFICACION_MS, 10) || 6000,
  // Si se setea, processTools reescribe los hosts ai-you.io de las tools a esta URL.
  // null = dejar las URLs de las tools genéricas tal cual (app-api.ai-you.io).
  toolsBackendUrl: process.env.TOOLS_BACKEND_URL || null,
  feriados: {
    // CRM que sirve GET /api/feriados/proximos?dias=N (mismo que usa el voice-backend).
    crmUrl: process.env.CRM_FERIADOS_URL || "https://app-api.ai-you.io",
    cacheTtlMs: parseInt(process.env.FERIADOS_CACHE_TTL_MS, 10) || 10 * 60 * 1000,
    diasAdelante: parseInt(process.env.FERIADOS_DIAS_ADELANTE, 10) || 60,
  },
  sucursales: {
    // CRM que sirve POST /api/crm/tools/llamadas/buscarSucursal (mismo endpoint
    // que usa la tool buscarSucursal). Precarga las 3 tiendas mas cercanas.
    baseUrl: process.env.CRM_SUCURSALES_URL || "https://app-api.ai-you.io",
    timeoutMs: parseInt(process.env.SUCURSALES_TIMEOUT_MS, 10) || 8000,
  },
};

module.exports = env;
