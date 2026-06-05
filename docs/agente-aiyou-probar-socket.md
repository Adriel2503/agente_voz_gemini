# Probar el socket del Agente de Voz (agente.ai-you.io)

Guía para **verificar de punta a punta** la conexión del socket de audio, igual a
como se prueba en integración. Sirve como smoke test antes de un despliegue o para
diagnosticar una sesión que "no habla".

No se necesita un teléfono ni Asterisk: el socket de `agente.ai-you.io` acepta audio
en crudo, así que un script de Node basta para abrir una sesión, enviar audio y
recibir la respuesta del agente.

---

## 1. Qué vamos a probar

El contrato público tiene dos superficies:

- **REST** `https://agente.ai-you.io/v1/agente-voz` — crear/terminar/consultar sesión.
- **WSS** `wss://agente.ai-you.io/v1/sesiones/{session_id}?token=<token>` — audio
  bidireccional.

El happy path completo:

```
POST /sesiones  →  { session_id, ws_url, codec_acordado, sample_rate_hz }
       │
       ▼
conectar ws_url  →  enviar audio (frames binarios)  →  recibir audio del agente
       │                                                   + JSON de control
       ▼
POST /sesiones/{id}/terminar   (o el agente cuelga solo)
```

---

## 2. Prerrequisitos

1. Un **token** `aiyou_live_...` de una empresa con `api_voz_activo = 1`
   (pestaña *Credenciales* en el panel `Configuración → API Agente de Voz`).
2. Un `id_plantilla` válido de esa empresa.
3. Las `variables` requeridas por el formato de esa plantilla.
4. Node 20+.

> El `ws_url` que devuelve `POST /sesiones` **expira a los 30 s** si no te conectas.
> Conéctate inmediatamente después de crear la sesión.

---

## 3. Prueba mínima (curl) — crear y terminar sesión

Valida solo la capa REST y la auth (sin audio):

```bash
TOKEN="aiyou_live_xxx"

# Crear sesión
curl -sS -X POST https://agente.ai-you.io/v1/agente-voz/sesiones \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id_plantilla": 12,
    "codec": "pcm_s16le_16k",
    "variables": { "nombre": "Juan", "telefono": "999888777" }
  }'
# → { "session_id": "ses_...", "ws_url": "wss://.../v1/sesiones/ses_...?token=...",
#     "expira_en": "...", "codec_acordado": "pcm_s16le_16k", "sample_rate_hz": 16000, "channels": 1 }
```

Si esto responde `201` con `ws_url`, la auth, la plantilla y el motor de voz están
operativos. Errores típicos:

| HTTP | `codigo`                | Significado |
|------|-------------------------|-------------|
| 400  | `plantilla_invalida`    | falta o no existe `id_plantilla` |
| 400  | `variables_incompletas` | faltan campos requeridos (ver `faltantes`) |
| 401  | `auth_invalida`         | token inválido/empresa no encontrada |
| 503  | `agente_indisponible`   | API de voz inactiva, o motor no disponible (reintentar) |

---

## 4. Prueba completa del socket (script Node)

Crea la sesión, conecta el WSS, envía un WAV/PCM de prueba y guarda lo que responde
el agente. Guárdalo como `probar-socket.js` y ejecútalo con
`node probar-socket.js <ruta-audio-pcm>`.

```js
// probar-socket.js — smoke test del socket de agente.ai-you.io
// Uso: node probar-socket.js entrada-16k-mono-s16le.raw
const fs = require("fs");
const WebSocket = require("ws");

const TOKEN = process.env.AIYOU_TOKEN;            // aiyou_live_...
const REST = "https://agente.ai-you.io/v1/agente-voz";
const ID_PLANTILLA = Number(process.env.ID_PLANTILLA || 12);
const CODEC = "pcm_s16le_16k";                    // 16 kHz, 16-bit, mono
const CHUNK = 640;                                 // 20 ms @ 16 kHz/16-bit (320 muestras)

async function main() {
  const audioPath = process.argv[2];
  if (!TOKEN || !audioPath) {
    console.error("Faltan AIYOU_TOKEN o ruta de audio. Uso: AIYOU_TOKEN=... node probar-socket.js audio.raw");
    process.exit(1);
  }

  // 1) Crear sesión
  const r = await fetch(`${REST}/sesiones`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      id_plantilla: ID_PLANTILLA,
      codec: CODEC,
      variables: { nombre: "Prueba", telefono: "999000111" },
    }),
  });
  const ses = await r.json();
  if (!r.ok) { console.error("Error al crear sesión:", ses); process.exit(1); }
  console.log("Sesión creada:", ses.session_id, "sample_rate:", ses.sample_rate_hz);

  // 2) Conectar el WSS (¡inmediatamente, expira en 30 s!)
  const ws = new WebSocket(ses.ws_url);
  const salida = fs.createWriteStream("respuesta-agente.raw"); // audio del agente
  let recibidoBytes = 0;

  ws.on("open", () => {
    console.log("WS conectado. Enviando audio…");
    const pcm = fs.readFileSync(audioPath);
    let i = 0;
    // Enviar a ritmo de 20 ms por frame (simula tiempo real)
    const timer = setInterval(() => {
      if (i >= pcm.length) {
        clearInterval(timer);
        console.log("Audio enviado. Esperando respuesta del agente…");
        return;
      }
      ws.send(pcm.subarray(i, i + CHUNK));
      i += CHUNK;
    }, 20);
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      recibidoBytes += data.length;        // audio del agente
      salida.write(data);
    } else {
      console.log("CONTROL:", data.toString());  // state, transcript, etc.
    }
  });

  ws.on("close", () => {
    salida.end();
    console.log(`WS cerrado. Audio del agente recibido: ${recibidoBytes} bytes → respuesta-agente.raw`);
    process.exit(0);
  });

  ws.on("error", (e) => { console.error("WS error:", e.message); process.exit(1); });

  // Corte de seguridad: terminar la sesión a los 30 s
  setTimeout(async () => {
    await fetch(`${REST}/sesiones/${ses.session_id}/terminar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }, 30000);
}

main();
```

Para escuchar la respuesta del agente, convierte el `.raw` a WAV:

```bash
ffmpeg -f s16le -ar 16000 -ac 1 -i respuesta-agente.raw respuesta-agente.wav
```

Y para generar un audio de entrada de prueba (di algo y conviértelo a PCM crudo):

```bash
ffmpeg -i mi-voz.mp3 -f s16le -ar 16000 -ac 1 entrada-16k-mono-s16le.raw
```

---

## 5. Qué deberías observar (señales de éxito)

- **`open`** del WS sin `401/404` → token y `session_id` correctos.
- Mensajes **CONTROL** con `type: "state"` alternando `listening` / `speaking`.
- Mensajes **binarios** (bytes de audio) → el agente está hablando; `respuesta-agente.raw` crece.
- `transcript` con texto coherente en español.
- Al terminar: `close` limpio y la transcripción disponible en
  `GET /sesiones/{id}/transcripcion` (solo tras finalizar).

---

## 6. Diagnóstico rápido

| Síntoma | Causa probable |
|---------|----------------|
| WS cierra con `401` | token ausente/!`aiyou_live_` o no coincide la empresa |
| WS cierra con `404` | `session_id` expiró (pasaron >30 s) o no pertenece al token |
| Conecta pero no llega audio del agente | sample rate del audio enviado ≠ `codec_acordado`; o no estás enviando frames |
| Audio del agente acelerado/grave | desajuste de sample rate (enviaste 8 k declarando 16 k o viceversa) |
| `transcript` vacío | el audio de entrada no tiene voz / nivel muy bajo |
| `503 agente_indisponible` al crear | API de voz inactiva para la empresa, o motor de voz caído (reintentar con `Retry-After`) |

---

## 7. Limpieza

El script ya termina la sesión a los 30 s. Si pruebas a mano, **siempre** cierra:

```bash
curl -X POST https://agente.ai-you.io/v1/agente-voz/sesiones/<id>/terminar \
  -H "Authorization: Bearer $TOKEN"
```

Dejar sesiones colgadas consume conexiones del motor de voz y descriptores de
archivo del gateway.
