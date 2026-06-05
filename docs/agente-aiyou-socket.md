# Conexión del socket — Agente de Voz (agente.ai-you.io)

Este documento describe cómo el gateway del Agente de Voz conecta una sesión de
voz con **el motor de voz de AiYou** usando un canal WebSocket bidireccional. Es
la pieza interna del backend (`src/ws/audioBridge.js` + el cliente del motor de
voz en `src/services/`). El flujo público (lo que ve el integrador) está en
`agente-aiyou-frontend.md` y `agente-aiyou-cliente-navegador.md`.

---

## 1. Panorama general

El motor de voz no recibe el audio directamente del integrador. El gateway hace
de **puente de audio bidireccional** entre el cliente (integrador telefónico o
navegador) y el motor de voz de AiYou:

```
  Cliente  ──audio (mulaw/PCM)──►  [audioBridge]  ──PCM s16le──►  Motor de voz AiYou
  Cliente  ◄──audio (mulaw/PCM)──  [audioBridge]  ◄──PCM s16le──  Motor de voz AiYou
```

La conexión interna con el motor de voz se establece en **dos pasos**:

1. **Crear la sesión de voz** (HTTP, dentro de `POST /v1/agente-voz/sesiones`) →
   el motor devuelve un identificador de sesión y una **URL de sesión interna**.
2. **Conectar el WebSocket** a esa URL interna → audio binario en ambos sentidos +
   mensajes JSON de control.

La URL de sesión interna es **de un solo uso y efímera**: se genera por sesión, hay
que conectarse en seguida y no sirve para reconectar. Nunca se expone al cliente;
el cliente solo ve el `ws_url` público de `agente.ai-you.io`.

---

## 2. Paso 1 — Crear la sesión de voz

Archivo: el cliente del motor de voz en `src/services/` (`crearLlamadaServerWs`).

Se solicita una sesión al motor de voz con la **API key por empresa** (la credencial
del motor de voz vive por empresa en DB, no global) y un payload que indica que el
audio se entregará y recibirá por WebSocket en crudo. Los campos clave:

```jsonc
{
  "systemPrompt": "<prompt ya renderizado con variables {{...}}>",
  "voice": "<voice_code de la empresa/plantilla>",
  "languageHint": "es",
  "temperature": 0.85,
  "transcriptOptional": true,
  "initialOutputMedium": "MESSAGE_MEDIUM_VOICE",
  "vadSettings": { "turnEndpointDelay": "0.35s" },
  "firstSpeakerSettings": {
    "agent": { "prompt": "Inicia con el PASO 1...", "uninterruptible": true }
  },
  "inactivityMessages": [
    { "duration": "30s", "message": "¿Sigue ahí?", "endBehavior": "END_BEHAVIOR_HANG_UP_SOFT" }
  ],
  "medium": {
    "serverWebSocket": {
      "inputSampleRate": 8000,
      "outputSampleRate": 8000,
      "clientBufferSizeMs": 60000,
      "dataMessages": {
        "userStartedSpeaking": true,
        "userStoppedSpeaking": true,
        "toolUsed": true
      }
    }
  },
  "selectedTools": [ { "toolName": "hangUp" }, /* ...tools dinámicas... */ ]
}
```

Campos que más importan:

- **`inputSampleRate` / `outputSampleRate`**: deben coincidir con el sample rate del
  audio del cliente. `codec = "mulaw_8k"` → **8000 Hz**; `codec = "pcm_s16le_16k"` →
  **16000 Hz**. Si no coinciden, el audio se oye acelerado/distorsionado.
- **`dataMessages`**: activa los eventos JSON `userStartedSpeaking` /
  `userStoppedSpeaking` que el bridge usa para el control de turnos (barge-in).
- **`firstSpeakerSettings.agent.uninterruptible: true`**: el saludo inicial no se
  puede interrumpir (evita que ruido de línea corte el PASO 1).
- **`selectedTools`**: siempre incluye `hangUp` + las tools dinámicas de la
  plantilla. Las URLs `ai-you.io` se reescriben al backend correcto vía
  `processTools` (ver `TOOLS_BACKEND_URL`).

La respuesta trae el identificador de sesión interno y la URL de sesión interna. Si
no viene la URL, se considera fallo de creación y se aborta (el gateway responde
`503 agente_indisponible` con `Retry-After`).

---

## 3. Paso 2 — Conectar el WebSocket interno

Archivo: `src/ws/audioBridge.js`

```js
const motorWs = new WebSocket(sesion.joinUrl); // URL interna del motor de voz
```

Ciclo de vida del socket:

| Evento     | Qué hacer |
|------------|-----------|
| `open`     | Marcar sesión como conectada. Empezar a bombear audio del cliente → motor. |
| `message`  | Si `isBinary` → **bytes de audio** del agente, reenviar al cliente. Si es texto → **JSON de control** (ver §5). |
| `close`    | Cerrar el lado del cliente y limpiar la sesión. |
| `error`    | Loguear, cerrar ambos extremos, liberar recursos. |

El discriminante **binario vs. JSON** es la regla central del handler `message`:

```js
motorWs.on("message", (data, isBinary) => {
  if (isBinary) {
    // audio del agente → reenviar al cliente (convertir PCM→mulaw si aplica)
    if (clienteWs.readyState === WebSocket.OPEN) clienteWs.send(salida);
  } else {
    const msg = JSON.parse(data); // mensaje de control
    manejarJson(msg);
  }
});
```

---

## 4. El puente de audio (framing y estado)

### Dirección Cliente → Motor de voz (lo que dice el usuario)

- El cliente entrega audio en frames pequeños (~20 ms). Por cada frame: convertir si
  hace falta (`mulaw → PCM s16le`) y enviarlo al `motorWs`.
- Se envía en **chunks de tamaño fijo** a ritmo de **un frame cada 20 ms**. Si no hay
  audio acumulado, se puede enviar silencio (`Buffer` de ceros) para mantener el
  flujo constante — el motor espera un stream continuo.

### Dirección Motor de voz → Cliente (lo que dice el agente)

- Los bytes binarios que llegan del `motorWs` se acumulan en un buffer de salida y se
  drenan hacia el cliente también a ~20 ms por frame.
- Cuando el motor manda `playback_clear_buffer` (barge-in), **se vacía el buffer de
  salida de inmediato** para que el agente deje de hablar.

### Máquina de estados (turnos)

- **`listening`**: el agente escucha → se reenvía audio del usuario al motor.
- **`speaking`**: el agente habla → se **deja de** mandar audio del usuario y se
  reproduce el audio del agente en el cliente.

Esto evita eco y dobles turnos.

---

## 5. Mensajes JSON de control

Llegan como texto por el WebSocket. Los relevantes:

| `type`                  | Acción en el bridge |
|-------------------------|---------------------|
| `state`                 | Actualiza el estado (`listening` / `speaking`). Al pasar a `speaking`, corta el envío de audio del usuario. |
| `user_started_speaking` | Resetea contadores de silencio. |
| `user_stopped_speaking` | Corta el stream de audio hacia el motor (fin de turno del usuario). |
| `playback_clear_buffer` | Vacía el buffer de salida hacia el cliente (barge-in). |
| `transcript`            | Transcripción parcial/final (útil para logging). |

Para inyectar texto al agente a mitad de sesión se usa `sendDataMessage` del cliente
del motor de voz (HTTP), no el socket.

---

## 6. Cierre y limpieza

Cerrar **siempre ambos extremos** y liberar la sesión cuando ocurra cualquiera de:

- El cliente cierra el socket (colgó / cerró el navegador).
- El motor de voz emite `close` o `error`.
- Timeout de inactividad del socket de audio (~10 s sin frames del cliente → muerto).

Un cierre incompleto deja **sockets colgados** → fuga de descriptores de archivo
(file descriptors). Ver §7.

---

## 7. Lecciones de producción

1. **Sample rate alineado de punta a punta.** `codec` del cliente ⇄
   `inputSampleRate/outputSampleRate` del motor. Cualquier desajuste = audio
   distorsionado.
2. **Frames de 20 ms, ritmo constante** en ambas direcciones. Enviar a ráfagas
   genera latencia y cortes.
3. **Cap de buffers por sesión.** Si un buffer crece sin drenarse, recortarlo a un
   máximo para no consumir RAM sin límite.
4. **Cerrar sockets siempre.** Una fuga de conexiones agota los **file descriptors**
   del proceso. En producción esto tumbó el servidor con `Too many open files` y, de
   rebote, llenó el disco con decenas de GB de logs en minutos. Cada sesión que
   termina debe cerrar su socket del motor y el del cliente.
5. **Subir `LimitNOFILE`.** Con muchas sesiones concurrentes, el default de 1024
   descriptores es insuficiente.
6. **`hangUp` como tool siempre presente**, con `inactivityMessages` de respaldo,
   para que el agente cuelgue limpio.

---

## 8. Mapa rápido de archivos

| Responsabilidad                          | Archivo |
|------------------------------------------|---------|
| Crear sesión de voz (URL interna)        | cliente del motor de voz en `src/services/` → `crearLlamadaServerWs` |
| Inyectar texto/contexto a mitad de sesión | cliente del motor de voz → `sendDataMessage` |
| Puente de audio bidireccional + estados  | `src/ws/audioBridge.js` → `manejarConexion` |
| Crear/validar la sesión pública (REST)   | `src/controllers/sesiones.controller.js` → `crearSesion` |
| Registro en memoria de sesiones          | `src/sessions/store.js` |
| Procesar/reescribir tools dinámicas      | `src/tools/processTools.js` |
| Config de timeouts y sample rate         | `src/config/env.js` (`.env`: `AUDIO_SAMPLE_RATE`, etc.) |
