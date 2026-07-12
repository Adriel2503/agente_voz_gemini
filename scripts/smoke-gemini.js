// Smoke test del motor Gemini SIN telefonia ni DB: abre una sesion Live con
// la MISMA config que usa geminiEngine, manda el saludo por texto y silencio
// digital a 50 fps (como la bomba real), y verifica que Gemini devuelva audio
// y transcripcion.
//
// Uso:  GEMINI_API_KEY=... node scripts/smoke-gemini.js
// Exit: 0 = OK (audio + transcripcion recibidos) / 1 = fallo.
//
// NOTA: requiere una GEMINI_API_KEY real en el entorno o el .env. No usa la
// base de datos: carga geminiEngine solo por construirLiveConfig.
process.env.DB_HOST = process.env.DB_HOST || "smoke";
process.env.DB_USER = process.env.DB_USER || "smoke";
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "smoke";
process.env.DB_NAME = process.env.DB_NAME || "smoke";

const env = require("../src/config/env.js");
const { construirLiveConfig } = require("../src/ws/geminiEngine.js");
const { Downsampler24a8 } = require("../src/lib/resample.js");

const TIMEOUT_MS = 30000;

async function main() {
  if (!env.gemini.apiKey) {
    console.error("FALTA GEMINI_API_KEY (env o .env)");
    process.exit(1);
  }

  const { GoogleGenAI } = require("@google/genai");
  const ai = new GoogleGenAI({ apiKey: env.gemini.apiKey });

  const cfg = {
    model: env.gemini.model,
    systemPrompt:
      "Eres un agente de prueba. Cuando te saluden, responde exactamente: " +
      "'Hola, la prueba del motor funciona correctamente.' y nada mas.",
    voice: env.gemini.voice,
    sampleRate: 8000,
  };

  console.log(`[smoke] modelo=${cfg.model} voz=${cfg.voice} vad=${env.gemini.vadSilenceMs}/${env.gemini.vadPrefixMs}ms`);

  const downsampler = new Downsampler24a8();
  let bytes24k = 0;
  let bytes8k = 0;
  let transcripcion = "";
  let listo = false;
  let terminado = false;
  let session = null;
  let tick = null;

  const finalizar = (ok, motivo) => {
    if (terminado) return;
    terminado = true;
    if (tick) clearInterval(tick);
    try { if (session) session.close(); } catch (_) {}
    console.log(`\n[smoke] ${motivo}`);
    console.log(`[smoke] audio recibido: ${bytes24k}B @24k -> ${bytes8k}B @8k (${(bytes8k / 16000).toFixed(1)}s de audio telefonico)`);
    console.log(`[smoke] transcripcion IA: "${transcripcion.trim()}"`);
    console.log(ok ? "[smoke] RESULTADO: OK" : "[smoke] RESULTADO: FALLO");
    process.exit(ok ? 0 : 1);
  };

  const timeout = setTimeout(() => finalizar(false, `timeout ${TIMEOUT_MS}ms sin completar el turno`), TIMEOUT_MS);
  timeout.unref?.();

  const SILENCIO_16K = Buffer.alloc(640); // frame de 20 ms @ 16 kHz (lo que sube la bomba)

  session = await ai.live.connect({
    model: cfg.model,
    config: construirLiveConfig(cfg),
    callbacks: {
      onopen: () => console.log("[smoke] WS abierto"),
      onerror: (e) => finalizar(false, `error WS: ${e?.message || e}`),
      onclose: (e) => { if (!terminado) finalizar(false, `WS cerrado: ${e?.reason || "sin motivo"}`); },
      onmessage: (msg) => {
        // OJO: setupComplete puede llegar ANTES de que el await de connect()
        // asigne `session` (carrera de microtasks). No usar session aca; solo
        // marcar la bandera — el arranque real va despues del await.
        if (msg.setupComplete && !listo) {
          listo = true;
          console.log("[smoke] setupComplete recibido");
          return;
        }
        const sc = msg.serverContent;
        if (!sc) return;
        for (const p of sc.modelTurn?.parts || []) {
          if (!p.inlineData?.data) continue;
          const pcm24k = Buffer.from(p.inlineData.data, "base64");
          bytes24k += pcm24k.length;
          bytes8k += downsampler.process(pcm24k).length;
          process.stdout.write(".");
        }
        if (sc.outputTranscription?.text) transcripcion += sc.outputTranscription.text;
        if (sc.turnComplete || sc.generationComplete) {
          clearTimeout(timeout);
          const ok = bytes24k > 0 && (!env.gemini.transcribe || transcripcion.length > 0);
          finalizar(ok, "turno completo");
        }
      },
    },
  });

  // Ya con `session` asignada: saludo + bomba de silencio a 50 fps (lo mismo
  // que hace geminiEngine en una llamada real).
  console.log("[smoke] mandando saludo + silencio 50fps");
  session.sendRealtimeInput({ text: env.gemini.greetingTrigger });
  tick = setInterval(() => {
    if (terminado) return;
    try {
      session.sendRealtimeInput({
        audio: { data: SILENCIO_16K.toString("base64"), mimeType: "audio/pcm;rate=16000" },
      });
    } catch (_) {}
  }, 20);
}

main().catch((e) => {
  console.error(`[smoke] excepcion: ${e.message}`);
  process.exit(1);
});
