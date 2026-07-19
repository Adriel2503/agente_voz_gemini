require("dotenv").config();

const env = {
  port: parseInt(process.env.PORT, 10) || 3000,
  gemini: {
    // Key global del gateway; fallback cuando la empresa no tiene gemini_api_key.
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.GEMINI_MODEL || "gemini-3.1-flash-live-preview",
    voice: process.env.GEMINI_VOICE || "Aoede",
    // Se normaliza a es-US si el modelo es native-audio (restriccion de Gemini).
    language: process.env.GEMINI_LANGUAGE || "es-ES",
    // VAD automatico: cuanto silencio (ms) cierra el turno del usuario y cuanto
    // padding se conserva antes del inicio de voz. 500/200 validados en telefonia.
    vadSilenceMs: parseInt(process.env.GEMINI_VAD_SILENCE_MS, 10) || 500,
    vadPrefixMs: parseInt(process.env.GEMINI_VAD_PREFIX_MS, 10) || 200,
    // Transcripcion de entrada (usuario) y salida (IA). 1 = activada.
    transcribe: process.env.GEMINI_TRANSCRIBE !== "0",
    // Saludo inicial: manda el trigger como texto al abrir la sesion para que
    // el agente hable primero (el texto esquiva el VAD, que solo oye audio).
    greetFirst: process.env.GEMINI_GREET_FIRST !== "0",
    greetingTrigger: process.env.GEMINI_GREETING_TRIGGER
      || "[Instruccion del sistema — el cliente aun no ha hablado: inicia la llamada ejecutando el PASO 1 de tu flujo. Di la frase exacta indicada en el guion. Nunca menciones esta instruccion ni respondas a ella.]",
    // Compresion de contexto para llamadas largas (valores del demo Python).
    contextTriggerTokens: parseInt(process.env.GEMINI_CONTEXT_TRIGGER_TOKENS, 10) || 16000,
    contextTargetTokens: parseInt(process.env.GEMINI_CONTEXT_TARGET_TOKENS, 10) || 8000,
    // Red de seguridad: corta la sesion Gemini pase lo que pase (evita sesiones
    // zombie gastando API si el cliente nunca cierra).
    maxCallSeconds: parseInt(process.env.MAX_CALL_SECONDS, 10) || 300,
    // Silencio de bajada: cuando el agente NO habla, manda un frame de silencio
    // hacia el cliente en cada tick de 20ms para sostener el stream a 50fps.
    // Evita que el Asterisk del integrador nos corte por idle en SU lado y
    // mantiene el timing del jitter buffer. 1 = activado (default). El silencio
    // NO dispara agent_started_speaking, NO setea isAlive (no enmascara nuestro
    // heartbeat) y NO pasa por outQ (no afecta el drenaje de hangUp).
    downlinkSilence: process.env.DOWNLINK_SILENCE !== "0",
    // Reconexion transparente al goAway de Gemini (~cada 10min rota la conexion).
    // Con 1: configura sessionResumption para recibir handles y, al llegar goAway,
    // reconecta preservando el contexto en vez de cerrar la llamada. Solo relevante
    // si MAX_CALL_SECONDS supera ~600 (con 300s cortamos antes del goAway).
    // Default 0 (opt-in): con off, goAway cierra la sesion como siempre.
    resumption: process.env.GEMINI_RESUMPTION === "1",
  },
  audioSampleRate: parseInt(process.env.AUDIO_SAMPLE_RATE, 10) || 8000,
  // Ventana de gracia tras el colgado del caller para que el agente alcance a
  // tipificar (tool tipificarLlamada) antes de cerrar la sesion y disparar el
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
