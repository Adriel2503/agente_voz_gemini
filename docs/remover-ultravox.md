# Remover Ultravox — diseño

Plan para sacar toda la lógica de Ultravox del gateway y dejar **Gemini como
único motor**. Decisión del usuario: full Gemini, una API key de Gemini por
empresa (ver [keys-gemini-por-empresa.md](keys-gemini-por-empresa.md)).

> **Alcance: solo código.** NO se tocan columnas ni tablas de BD en este cambio
> (`empresa.ultravox_api_key`, `ultravox_api_key_adicional`, `voz_adicional`
> quedan intactas). Limpieza de schema = paso aparte, posterior, más riesgoso.

## Efecto arquitectónico

Al irse Ultravox, colapsa todo el andamiaje del **pool de keys**: `candidatos`,
`elegirCandidato`, keys adicionales, mapeo de voces por cuenta. Gemini no reparte
llamadas entre cuentas (no limita por canales sino por TPM), así que queda **un
solo "candidato" por empresa**. La ramificación de motor (`esGemini`,
`motorActivo`, `ENGINE`) también desaparece: hay un solo camino.

## Borrados (archivos enteros)

| Archivo | Qué es |
|---------|--------|
| `src/services/ultravox.service.js` | Cliente HTTP de Ultravox (crear llamada, voces, mensajes) |
| `src/ws/audioBridge.js` | Motor Ultravox **+ dispatcher** de motor. La responsabilidad de dispatch se mueve: `index.js` importa `manejarConexion` directo de `geminiEngine.js` |

## Ediciones

### `src/index.js`
- L11: importar `manejarConexion` de `./ws/geminiEngine.js` (no de `audioBridge.js`).

### `src/controllers/sesiones.controller.js`
- Quitar `require("../services/ultravox.service.js")`, `esGemini`, `motorActivo`.
- `crearSesion`: colapsar el bloque `candidatos`/`elegirCandidato` a **un solo
  chequeo de concurrencia** por empresa (ver decisión A). Llamar
  `gemini.crearLlamadaServerWs(...)` directo. `voice: null` (Gemini usa `GEMINI_VOICE`).
- `transcripcionSesion`: siempre `s.transcripcion` (se va la rama `ultravox.obtenerMensajes`).
- `listarVoces` + ruta `/voces`: eliminar (ver decisión B) — hoy solo llaman a Ultravox.
- Código de error `error_ultravox` (502): renombrar o mantener por compatibilidad
  con integradores (ver decisión B).

### `src/models/agenteVoz.model.js`
- Quitar `getApiKeysAdicionales` y `getVozAdicionalPorVoz`.
- `getEmpresa`: se puede sacar `ultravox_api_key` del SELECT (opcional, inofensivo dejarlo).
- `getVoz`: mantener/quitar según decisión B.

### `src/config/env.js`
- Quitar el bloque `ultravox: {...}`.
- `engine`: dejar de leer `ENGINE`; Gemini es el único motor (ver decisión C).
- `defaultVoiceCode` / `defaultVoiceProvider` / `defaultVoiceSpeed`: eran para los
  `voiceOverrides` de Ultravox — quitar según decisión B.

### `src/sessions/store.js`
- `contarPorApiKey` se **conserva**: reusada como guardia de concurrencia por
  empresa vía la clave sintética `gemini:{idEmpresa}` (ver decisión A). Solo se
  actualizan comentarios que dicen "Ultravox".

### `src/routes/sesiones.routes.js`
- Quitar `router.get("/voces", ...)` (ver decisión B).

### `.env.example`
- Quitar `ULTRAVOX_*` y `ENGINE`. Quitar `DEFAULT_VOICE_*` si aplica decisión B.

### Comentarios históricos (NO bloquean)
Varios archivos citan Ultravox solo en comentarios de linaje (`geminiEngine.js`,
`gemini.service.js`, `g711.js`, `prompt.js`, `geminiTools.js`, `generica.js`,
`processTools.js`, `sucursales.service.js`). Son inofensivos y documentan de dónde
viene el código. Se pueden limpiar después; no son parte del borrado funcional.

## Decisiones (resueltas 2026-07-19)

**A. Tope de concurrencia por empresa (`empresa.canal`) → SACAR.**
Era concepto Ultravox (factura por canal concurrente). Gemini limita por TPM.
Se saca el tope: se van `elegirCandidato`, `candidatos`, la clave sintética
`gemini:{id}` y el `contarPorApiKey` como tope. Queda solo un contador simple de
sesiones activas para el log del POST.
- `empresa.canal` **queda en la BD** (huérfano, sin lector). Verificado el estado:
  Credicash(8)=15, alfin(40)=3, efectiva(73)=3. Reutilizable si a futuro se
  quiere reponer una guardia anti-runaway.
- *Trade-off aceptado:* sin tope, un integrador con bug podría abrir sesiones
  Gemini ilimitadas; solo lo frena el TPM (costo). `empresa.canal` sigue en BD
  para reponerlo trivialmente si hace falta.

**B. Endpoint `/voces` y resolución de voz → SACAR TODO.**
Eliminar `/voces`, `listarVoces`, `getVoz` y la plomería de velocidad/provider.
Gemini usa `GEMINI_VOICE`; todo eso era `voiceOverrides` de Ultravox.

**C. Kill-switch `ENGINE=ultravox` → SACAR.**
Gemini queda como único motor. Volver a Ultravox = `git revert`.

## Orden de implementación (seguro)

1. Ediciones de referencias (controller, model, env, index, routes) — con Gemini
   ya como único camino.
2. Borrar `ultravox.service.js` y `audioBridge.js`.
3. Correr la suite (`node --test`) + `node --check` de cada archivo tocado.
4. Actualizar `.env.example`.
5. Commit conventional (`refactor: remover motor Ultravox, Gemini unico motor`).

## Fuera de alcance (tracks posteriores)

- Limpieza de schema (dropear columnas/tablas Ultravox) — requiere confirmar que
  nada más las lee.
- Limpieza de comentarios de linaje.
- Refactor de `manejarConexion`/`crearSesion` (recién tiene sentido después de esto).
