# Motor Gemini Live — Agente de Voz (agente.ai-you.io)

Este documento describe la integración de **Gemini Live** como motor de voz
del gateway, en reemplazo de Ultravox. Porta la lógica ya validada en
producción telefónica de dos proyectos previos: el demo Python
(`gemini_live`, configuración de la sesión Live) y el puente Go
(`asterisk-bridge`, bombeo de audio y control de turnos).

**Alcance MVP (sin tools):** conversación + transcripción + barge-in +
saludo inicial. Las tools (tipificar, agendar, buscarSucursal, queryCorpus)
quedan para la Fase 2 — la llamada conversa pero **no tipifica ni ejecuta
acciones**.

---

## 1. Cómo se activa

El motor se elige por entorno, **no por base de datos**:

```ini
ENGINE=gemini          # "ultravox" (default) | "gemini"
GEMINI_API_KEY=...     # key GLOBAL del gateway (Ultravox la lee por empresa)
```

Kill-switch: volver a `ENGINE=ultravox` restaura el flujo anterior sin ningún
otro cambio (el código Ultravox queda intacto). No hubo migración de DB:
`empresa.ultravox_api_key`, las keys adicionales y la tabla `voz`
(ElevenLabs) quedan sin uso con Gemini; `empresa.canal` se sigue respetando
como tope de sesiones concurrentes por empresa.

**El contrato público NO cambia**: mismo `POST /sesiones`, mismo `ws_url`,
mismos JSON hacia el integrador (`transcript_partial/final`,
`agent_started/stopped_speaking`, `playback_clear_buffer`, `pong`). El
integrador telefónico no nota el cambio de motor.

---

## 2. Arquitectura

```
   Cliente (Asterisk de 3ro          agente_voz (Node)
   o navegador)                            │
        │  WSS /v1/sesiones/:id?token=     │
        ▼                                  ▼
  ┌────────────────────────────────────────────────────────┐
  │ index.js (upgrade + auth)            [sin cambios]     │
  │ sesiones.controller.js ──switch ENGINE──┐              │
  │      │ ultravox.service.js (intacto)    │              │
  │      │ gemini.service.js ◄──────────────┘              │
  │      ▼                                                 │
  │ audioBridge.js ── if engine=gemini ──► geminiEngine.js │
  │                                             │          │
  │      lib/resample.js   lib/audioQueue.js    │          │
  └─────────────────────────────────────────────┼──────────┘
                                                │ @google/genai
                                                ▼ ai.live.connect
                                          Gemini Live API
                                   (sube PCM16 16 kHz / baja 24 kHz)
```

### Diferencia clave con Ultravox

Con Ultravox había un paso HTTP previo (`POST /calls`) que devolvía un
`joinUrl` al que luego se conectaba el bridge. **Gemini no tiene ese paso**:
`gemini.service.crearLlamadaServerWs` solo valida la key, genera un `callId`
propio (`gem_<hex>`) y devuelve `{ callId, joinUrl: null, geminiConfig }`.
La sesión Live se abre recién cuando el integrador conecta su WSS
(`geminiEngine.js` hace `ai.live.connect`).

---

## 3. Flujo de audio

Gemini fija sus sample rates: **entrada 16 kHz, salida 24 kHz** (PCM16 LE
mono). El gateway resamplea para ajustarse al codec del cliente:

| Codec del cliente | Subida (→ Gemini 16k) | Bajada (Gemini 24k →) |
|---|---|---|
| `mulaw_8k` (telefonía) | mulaw→PCM 8k → **upsample 8→16** | **downsample 24→8** → PCM→mulaw |
| `pcm_s16le_16k` (navegador) | directo (ya está a 16k) | **downsample 24→16** |

Una bomba única de **20 ms** (50 fps) maneja ambos sentidos por sesión:

```
SUBIDA  (cada tick):
  frame = inQ.popFrame(frameBytes) ?? SILENCIO   ← relleno de silencio ⚠️
  session.sendRealtimeInput({ audio: base64(upsample(frame)), rate=16000 })

BAJADA  (cada tick):
  frame = outQ.popFrame(frameBytes)              ← writer pautado
  si hay → convertir a mulaw si aplica → asteriskWs.send(frame)
```

### ⚠️ Relleno de silencio (la regla de oro)

**La subida SIEMPRE manda 50 frames/s.** Si el cliente no envió audio en ese
tick (el caller calló, su trunk suprime silencio, microcorte), se sube un
frame de ceros. Sin stream continuo el VAD de Gemini nunca acumula el
silencio que necesita para cerrar el turno y **la IA no responde** — bug ya
vivido y resuelto en producción con el bridge Go. El relleno vive en el
gateway (el último salto antes de Gemini) porque no se puede depender del
comportamiento del Asterisk del tercero; si el integrador sí manda stream
continuo, el relleno simplemente no se activa (`silencio_relleno=0` en el
log RESUMEN).

### Piezas de soporte (`src/lib/`)

- **`audioQueue.js`** — re-trocea el stream en frames uniformes. Puntero de
  lectura `head` + compactación diferida: la memoria queda acotada al audio
  "en vuelo" sin importar la duración de la llamada. `clear()` = barge-in.
- **`resample.js`** — `upsample8to16` (x2, interpolación lineal),
  `Downsampler24a8` y `Downsampler24a16` (promedio por grupos **con carry**:
  los chunks de Gemini no vienen alineados; sin carry habría clicks y drift).
  Una instancia de downsampler por sesión.

Ambas portadas del Go con sus tests (`npm test`, 14 casos: FIFO, carry con
cortes a mitad de muestra, compactación, tasa 3:1 exacta).

---

## 4. Sesión Live (config)

`geminiEngine.construirLiveConfig()` — port de `_build_config` del demo
Python, mismos campos camelCase:

| Campo | Valor |
|---|---|
| `systemInstruction` | prompt de la **plantilla** ya renderizado (multi-empresa, igual que con Ultravox) |
| `responseModalities` | `["AUDIO"]` |
| `speechConfig` | voz `GEMINI_VOICE` + `languageCode` normalizado (es→`es-US` si el modelo es native-audio) |
| `realtimeInputConfig` | VAD automático: `silenceDurationMs`/`prefixPaddingMs` de env, `START_OF_ACTIVITY_INTERRUPTS` (barge-in server-side) |
| `inputAudioTranscription` / `outputAudioTranscription` | activadas si `GEMINI_TRANSCRIBE=1` |
| `contextWindowCompression` | trigger 16000 / target 8000 tokens (llamadas largas) |

### Saludo inicial

Equivalente al `firstSpeakerSettings.agent.prompt` de Ultravox, emulado:
al abrir la sesión se manda `GEMINI_GREETING_TRIGGER` como **texto**
(esquiva el VAD, que solo reacciona a audio) y el agente habla primero.
El default instruye ejecutar el PASO 1 del guion sin mencionar la
instrucción. Configurable por env.

### Eventos de Gemini → acciones del bridge

| Evento (`serverContent`) | Acción |
|---|---|
| `modelTurn.parts[].inlineData` | audio 24k → downsampler → `outQ` (+ `agent_started_speaking` al primer chunk) |
| `outputTranscription.text` | acumula turno IA → `transcript_partial` rol agente |
| `inputTranscription.text` | acumula turno usuario → `transcript_partial` rol usuario |
| `interrupted` | **barge-in**: `outQ.clear()` + `playback_clear_buffer` al cliente |
| `turnComplete` / `generationComplete` | `transcript_final` + `agent_stopped_speaking` |
| `goAway` | cierre (`gemini_go_away`) |
| `sessionResumptionUpdate` | se traza el handle (reconexión = Fase 2) |

La transcripción se acumula en memoria (`sesion.transcripcion`) y la sirve
`GET /sesiones/:id/transcripcion` — Gemini no tiene REST de mensajes como
Ultravox.

### Mensajes del cliente (mismo switch que Ultravox)

`session_end` → cierre directo (sin ventana de gracia: no hay tipificación
en el MVP) · `ping` → `pong` · `user_text` → `sendRealtimeInput({text})` ·
`dtmf` → no-op.

---

## 5. Cierre y seguridad

- `cerrar(motivo)` **idempotente**: para la bomba, cierra **ambos** sockets
  (lección de producción: fuga de sockets = fuga de file descriptors),
  persiste `estado=ended` con `metadata.motor="gemini"` (trazabilidad sin
  cambio de schema), dispara webhook `session.ended` y libera el store.
- Dispara el cierre: close/error de cualquiera de los dos lados, `goAway`,
  `session_end`, o el corte duro `MAX_CALL_SECONDS` (default 300 s — evita
  sesiones zombie gastando API).
- Colas con tope (`inQ` 512 KB / `outQ` 4 MB): si se exceden se vacían y se
  loguea, la memoria por sesión queda acotada.
- Log RESUMEN al cerrar (mismos contadores del bridge Go):
  `frames_subida`, `silencio_relleno`, `audio_msgs_gemini`, `bytes_gemini`,
  `frames_a_cliente`.

---

## 6. Variables de entorno

```ini
ENGINE=gemini                                # motor activo (default ultravox)
GEMINI_API_KEY=                              # obligatoria con ENGINE=gemini
GEMINI_MODEL=gemini-3.1-flash-live-preview   # validado en telefonía
GEMINI_VOICE=Aoede
GEMINI_LANGUAGE=es-ES                        # es-US automatico si native-audio
GEMINI_VAD_SILENCE_MS=500                    # silencio que cierra el turno
GEMINI_VAD_PREFIX_MS=200                     # padding previo a la voz
GEMINI_TRANSCRIBE=1
GEMINI_GREET_FIRST=1
# GEMINI_GREETING_TRIGGER=...               # ver default en config/env.js
GEMINI_CONTEXT_TRIGGER_TOKENS=16000
GEMINI_CONTEXT_TARGET_TOKENS=8000
MAX_CALL_SECONDS=300
```

Notas:
- Los sample rates de Gemini (16k/24k) y el tick de 20 ms **no** son
  configurables: son constantes del protocolo/telefonía.
- Con `ENGINE=gemini` la tabla `voz` se ignora (es de ElevenLabs/Ultravox);
  la voz sale de `GEMINI_VOICE`.

---

## 7. Verificación

```bash
npm test              # unit: audioQueue + resample (14 casos)
npm run smoke:gemini  # sesion Live real: config + saludo + audio + transcripcion
```

El smoke (`scripts/smoke-gemini.js`) no necesita DB ni telefonía: abre una
sesión con la misma config del engine, manda el saludo y silencio a 50 fps,
y verifica que vuelvan audio (pasado por el downsampler real) y
transcripción. `RESULTADO: OK` = el motor funciona; cualquier falla posterior
está en el cableado (DB, WSS, integrador), no en el motor.

Prueba end-to-end: crear sesión vía `POST /v1/agente-voz/sesiones` con
`ENGINE=gemini` y conectar el WSS (ver `docs/agente-aiyou-probar-socket.md`,
el flujo público es idéntico).

---

## 8. Mapa de archivos

| Responsabilidad | Archivo |
|---|---|
| Contrato del motor (crear "llamada", texto, clasificar errores) | `src/services/gemini.service.js` |
| Bridge de audio + sesión Live + eventos | `src/ws/geminiEngine.js` |
| Cola de frames (head-offset + compactación) | `src/lib/audioQueue.js` |
| Resampling 8↔16 / 24→8 / 24→16 (con carry) | `src/lib/resample.js` |
| Switch de motor (creación de sesión) | `src/controllers/sesiones.controller.js` |
| Rama de motor en el WSS | `src/ws/audioBridge.js` (primera línea de `manejarConexion`) |
| Config | `src/config/env.js` (bloque `engine` + `gemini`) |
| Tests unitarios | `test/audioQueue.test.js`, `test/resample.test.js` |
| Smoke contra Gemini real | `scripts/smoke-gemini.js` |

## 9. Fase 2 (pendiente)

- **Tools**: traducir `temporaryTool` → `functionDeclarations`; con Gemini el
  gateway **ejecuta** el HTTP de la tool (`toolCall` → fetch → `toolResponse`),
  a diferencia de Ultravox que lo ejecutaba él. Incluye `tipificarLlamada` y
  `agendar_cita` (hoy la llamada no tipifica) y la ventana de gracia.
- **Reconexión** con `sessionResumptionUpdate.newHandle` (sesiones > límite
  de Gemini) saltando el greet al reanudar.
- **`queryCorpus`** (RAG nativo de Ultravox) no tiene equivalente directo:
  requiere solución aparte.
- **Voces por empresa**: mapear `voz.provider='gemini'` si se necesita
  granularidad (hoy la voz es global).
