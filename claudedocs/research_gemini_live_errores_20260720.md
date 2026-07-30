# Investigación: Errores, cierres de conexión y límites de la Gemini Live API

**Fecha:** 2026-07-20
**Alcance:** `@google/genai` v2.11.0 · `ai.live.connect(...)` · modelo `gemini-3.1-flash-live-preview` · bridge de telefonía con audio PCM16 (16kHz in / 24kHz out), VAD automático, tools, `contextWindowCompression`, `sessionResumption` (flag `GEMINI_RESUMPTION`, off por defecto).
**Contexto del problema:** bajo alto volumen de llamadas concurrentes se observan cierres `onclose`/`onerror` correlacionados con volumen, motivo interno `gemini_close` (nombre local del proyecto, no un término de Google), sospecha de límite TPM / `RESOURCE_EXHAUSTED`.

---

## 1. Resumen ejecutivo

- **La documentación oficial de Google sobre errores y cierres de la Live API es incompleta y fragmentada.** Existe buena documentación sobre `GoAway` y `SessionResumption` (mecanismos de ciclo de vida normal de la sesión), pero **no hay ninguna tabla oficial de códigos de cierre WebSocket** (1000–1015) específicos de la Live API, ni una tabla de errores gRPC/HTTP contextualizada para sesiones bidireccionales (solo existe para la API REST clásica).
- **Los límites de capacidad (TPM/RPM/sesiones concurrentes) para modelos Live/native-audio no están publicados en tablas públicas.** Google remite sistemáticamente a la página personalizada `aistudio.google.com/rate-limit`, que requiere login y varía por proyecto/tier. Un ingeniero de Google confirmó explícitamente en el foro oficial (julio 2026) que **no hay límite de sesiones concurrentes garantizado**: el control real es por **TPM (tokens por minuto)**, no por cantidad de sesiones.
- **`gemini-3.1-flash-live-preview` es un modelo "preview"** y, según reportes (incluido un reconocimiento parcial de un ingeniero de Google en el foro oficial el 9 de julio de 2026), **los endpoints `-live-preview` son "materialmente menos estables"** que los modelos GA, con una tasa reportada de hasta ~80% de errores 1011 mid-turn en algunos casos de uso intensivo (audio+video). Google confirmó haber desplegado mitigaciones, sin comprometer una fecha de estabilización ni SLA.
- **El caso de uso del proyecto (telefonía, alto volumen concurrente, solo audio) es precisamente el escenario que más golpea el límite de TPM**, porque el consumo de tokens de audio es constante (~25 tokens/seg por sesión activa) y escala linealmente con el número de llamadas simultáneas — no hay forma de reducirlo salvo bajar tasa de muestreo/calidad o excluir modalidades (video/imagen) que no se usan aquí.
- **Gap más importante para producción:** no existe documentación oficial que diga "a partir de N sesiones concurrentes con modelo X en tier Y, esperá `RESOURCE_EXHAUSTED`". Hay que instrumentar y medir empíricamente, y pedir aumento de cuota a Google vía formulario (mencionado en el foro, sin URL pública verificada en esta investigación).
- `sessionResumption` está bien documentado (handle válido 2 horas tras terminar la sesión, modo transparente con buffer de mensajes cliente), pero la comunidad reporta **casos donde reanudar el handle produce una sesión que vuelve a caer casi inmediatamente** (loop de reconexión), especialmente en combinaciones audio+video — no confirmado si aplica igual a audio-only puro (nuestro caso), pero es una señal de alerta a monitorear si se activa `GEMINI_RESUMPTION`.

---

## 2. Tabla de códigos/motivos de cierre de WebSocket

RFC 6455 define los códigos estándar 1000–1015; Google Live API los reutiliza (no define códigos custom fuera de este rango, según toda la evidencia recolectada — ni la documentación oficial ni los issues de GitHub muestran códigos fuera del rango estándar). El **motivo textual** (`reason` en el `CloseEvent`) es lo que aporta el contexto específico de Google.

| Código | Nombre RFC 6455 | Observado en Live API / contexto Google | Recuperable | Acción recomendada |
|---|---|---|---|---|
| **1000** | Normal Closure | Cierre normal esperado (fin de turno, `goAway` consumado, cliente cierra explícitamente). También reportado en algún caso como cierre **inesperado** con reason vacío (`google.genai.errors.APIError: 1000 None`) en `google-adk` — posible bug/edge-case, no necesariamente "todo OK". | Sí, si fue iniciado por el cliente o precedido de `goAway`. Si es inesperado (sin `goAway` previo, sin haber llamado `close()`), tratarlo como fallo y reconectar. | Verificar si hubo `goAway` antes; si no, loguear como anómalo y reconectar con backoff. |
| **1001** | Going Away | Semánticamente el que correspondería a un cierre proactivo del servidor (aunque Google prefiere el mensaje de aplicación `GoAway` + luego cierre, no necesariamente código 1001). No confirmado como el código real que usa Google en la práctica — no hay evidencia directa en la investigación de que Google emita 1001 tras `GoAway`. | Sí | Reconectar (usar handle de resumption si está disponible y no expiró). |
| **1006** | Abnormal Closure | Reportado por la comunidad en cortes de red / timeouts de inactividad (~2–3 min) **sin** `GoAway` previo, contradiciendo el SLA documentado de ~10 min de conexión. Google (representante en foro, enero 2026) dijo que "el timeout y el goAway funcionan correctamente de nuestro lado" y pidió repro — no reconoció el bug. | Depende — puede ser red del cliente o comportamiento no documentado del servidor. | Reconectar con backoff; si es sistemático, es candidato a abrir ticket/issue con evidencia. |
| **1007** | Invalid Frame Payload Data | Confirmado en GitHub Issue `googleapis/js-genai#1212`: ocurre con reason *"Request contains an invalid argument"* cuando la config de `responseModalities` es inválida (p.ej. incluir `Modality.TEXT` en combinaciones no soportadas por `gemini-2.5-flash-native-audio`). Equivale a un `INVALID_ARGUMENT` de setup. | **No** (error de configuración del cliente) | No reintentar sin corregir la config; validar `responseModalities`/schema antes de conectar. |
| **1008** | Policy Violation | Reportado en foros asociado a problemas de autenticación/API key inválida o política de uso. | **No** hasta corregir credenciales | Verificar API key / permisos antes de reintentar. |
| **1011** | Internal Error | **El más reportado en producción bajo carga y con el modelo `-live-preview`.** Causas reportadas: error interno server-side durante procesamiento de turno, ejecución de tool calls, combinación audio+video (~90–120s), y **sobrecarga/rate-limit** (`extensible_stubs::OVERLOADED_TOO_MANY_RETRIES_PER_REQUEST` visto en el reason en un caso de LiveKit). Google reconoció (9-jul-2026, foro oficial) que están desplegando fixes para reducir su frecuencia. | Sí, en general — es la categoría "reintentable" por excelencia (análogo a 5xx transitorio), pero ojo con el patrón de "resumption que vuelve a caer en <1s" reportado por la comunidad. | Reconectar con backoff exponencial + jitter; usar `sessionResumption` si el handle sigue siendo `resumable`; si el ciclo de reconexión falla repetidamente en <2s, **descartar el handle** y crear sesión nueva en vez de insistir con el mismo handle (workaround reportado por la comunidad). |
| **1015** | TLS Handshake Failure | No reportado específicamente en el contexto Live API en la investigación. | Sí (problema de red/TLS) | Reconectar. |

**Nota importante:** ni la documentación oficial (`ai.google.dev/api/live`) ni la guía de mejores prácticas contienen una tabla explícita de "close codes". La referencia oficial de WebSockets (`https://ai.google.dev/api/live`) documenta el mensaje de aplicación `GoAway` (campo `timeLeft`) como el mecanismo *documentado* de aviso de cierre, pero **no formaliza qué código de cierre WebSocket sigue al `GoAway`**. Todo lo de la tabla de códigos proviene de reportes de la comunidad (GitHub issues, foro oficial de desarrolladores), no de documentación autoritativa — está marcado explícitamente donde corresponde.

---

## 3. Tabla de errores de API durante una sesión Live

Estos son los códigos gRPC/HTTP documentados para la Gemini API en general (`ai.google.dev/gemini-api/docs/troubleshooting`). La documentación **no distingue explícitamente** entre errores en el mensaje de `setup` (inicio de sesión) vs. errores mid-session; la distinción de columna "cuándo ocurre" es una inferencia razonada combinando la doc general + reportes de Live API específicamente.

| Código HTTP | Status gRPC | Causa típica | Cuándo en una sesión Live (inferido) | Acción recomendada |
|---|---|---|---|---|
| 400 | `INVALID_ARGUMENT` | Solicitud malformada, typo, campo faltante o incompatible (p.ej. `responseModalities` inválidas — ver issue #1212). | **Setup** (al enviar `BidiGenerateContentSetup`), o en un mensaje de turno malformado. | No reintentar sin corregir el payload; validar config contra el esquema antes de conectar. |
| 400 | `FAILED_PRECONDITION` | Free tier no disponible en el país / falta de facturación habilitada. | **Setup** | Habilitar facturación en el proyecto de Google AI Studio / Cloud. |
| 403 | `PERMISSION_DENIED` | API key sin permisos, key revocada, modelo no habilitado para el proyecto. | **Setup** | Verificar key/credenciales antes de reintentar; no reintentar automáticamente sin corregir. |
| 404 | `NOT_FOUND` | Modelo o recurso no encontrado (typo en el nombre del modelo, versión no disponible en la región). | **Setup** | Confirmar nombre exacto del modelo y disponibilidad regional. |
| 429 | `RESOURCE_EXHAUSTED` | Excede RPM, TPM o RPD. **Es el sospechoso principal del problema reportado en producción.** | Puede darse en **setup** (rechazo de nueva conexión) o **mid-session** (cierre abrupto cuando el consumo acumulado de tokens del proyecto supera el TPM disponible, con muchas sesiones concurrentes consumiendo el mismo pool). | Reintentar con backoff exponencial + jitter; implementar control de admisión (rate limiting propio) antes de abrir nuevas sesiones cuando se acerque al límite; solicitar aumento de cuota a Google. |
| 499 | `CANCELLED` | Cliente cerró la conexión antes de que el servidor completara. | Cualquier momento | Revisar lógica de cierre del lado cliente (timeouts propios, etc.). |
| 500 | `INTERNAL` | Error inesperado del lado de Google — corresponde en Live API al patrón de cierre 1011. | **Mid-session**, predominantemente | Reintentar con backoff; si es recurrente con un modelo `-preview`, considerar fallback a modelo GA si existe. |
| 503 | `UNAVAILABLE` | Servicio temporalmente saturado (sobrecarga general del backend, no específica de tu cuota). | **Setup** o **mid-session** | Reintentar con backoff; considerar circuit breaker si es sostenido. |
| 504 | `DEADLINE_EXCEEDED` | El servicio no pudo procesar dentro del plazo. | Mid-session (turnos largos, tool calls lentos) | Aumentar timeout del lado cliente si aplica; reintentar. |

**Estrategia general documentada** (`ai.google.dev/gemini-api/docs/troubleshooting` + guía de reintentos de Google Cloud): reintentar solo errores transitorios (429, 408, 5xx) con **backoff exponencial con jitter** — ejemplo dado: primer reintento ~1s, luego 2s, 4s, 8s…, con un máximo de intentos definido para evitar loops infinitos. Esta guía es genérica para la Gemini API (no específica de Live API vía WebSocket), pero es la única guía cuantitativa que Google publica y es razonable aplicarla al reconectar el WebSocket.

---

## 4. Límites conocidos

| Límite | Valor | Fuente | Confianza |
|---|---|---|---|
| Duración de conexión WebSocket | ~10 minutos (luego `GoAway` + cierre forzado) | `ai.google.dev/gemini-api/docs/live-session`, Firebase AI Logic docs | **Alta** (documentación oficial, consistente entre fuentes) |
| Aviso `GoAway` | Se envía **60 segundos** antes del cierre (constatado en un resumen de fuente secundaria) con campo `timeLeft` (Duration) que indica el tiempo restante; nunca menor a un mínimo específico del modelo | `ai.google.dev/api/live` (referencia oficial) | **Alta** para el mecanismo; **media** para el valor exacto de "60s" (visto en una síntesis, no en cita textual directa de la referencia oficial revisada) |
| Sesión audio-only sin `contextWindowCompression` | 15 minutos máx. | `ai.google.dev/gemini-api/docs/live-api/best-practices`, Firebase docs | **Alta** |
| Sesión audio+video sin `contextWindowCompression` | 2 minutos máx. | Idem | **Alta** |
| Consumo de tokens de audio | ~25 tokens/segundo por sesión | `ai.google.dev/gemini-api/docs/live-api/best-practices` | **Alta** (cita textual) |
| Ventana de contexto | 128k tokens (todos los modelos Live) | Firebase AI Logic docs, best-practices | **Alta** |
| Duración de sesión con `contextWindowCompression` activo | Teóricamente ilimitada (ventana deslizante server-side que trunca turnos antiguos) | `ai.google.dev/gemini-api/docs/live-session` | **Alta** para el mecanismo, aplica ya en el proyecto |
| Validez del handle de `sessionResumption` | 2 horas después de terminada la última sesión | `ai.google.dev/gemini-api/docs/live-session`, foro de desarrolladores | **Alta** (repetido consistentemente en múltiples fuentes oficiales) |
| Reutilización del handle | El handle es de un solo uso lógico por reconexión — el servidor emite un `newHandle` en cada `SessionResumptionUpdate`; no hay documentación de un límite de "cuántas veces" se puede resumir en cadena, pero la comunidad reporta loops de fallo al reutilizar un handle tras un 1011 en escenarios audio+video | `ai.google.dev/api/live` + foro (`live-api-gemini-3-1-flash-live-preview...175234`) | Mecanismo: **alta** / Límite de reintentos en cadena: **no documentado, evidencia solo comunitaria** |
| Sesiones concurrentes por proyecto | **No hay límite oficial documentado para `gemini-3.1-flash-live-preview` / `gemini-3-flash-live`.** Para `gemini-live-2.5-flash` se reportó (fuente secundaria, no verificada en doc oficial) un límite de 5,000 solicitudes bidireccionales concurrentes por proyecto/región/modelo base. Google confirmó en el foro que **no garantiza** un número de sesiones concurrentes: el control real es TPM. | Foro oficial `discuss.ai.google.dev` (respuesta de empleada de Google, Alisa Fortin) | **Media-alta** para la declaración de "no hay garantía, es TPM-based" (viene de un empleado de Google); **baja** para el número puntual de 5,000 (no verificado contra doc oficial primaria) |
| TPM Free tier, `gemini-3.1-flash-live-preview` | ~65,000 TPM (reportado por usuarios como notablemente más bajo que modelos anteriores, que llegaban a 1M TPM) | Foro de desarrolladores (`...doesnt-have-enough-free-tpm-quota/138097`) | **Media** (reporte de usuario, no tabla oficial; puede haber cambiado) |
| TPM/RPM por tier pagos (Tier 1/2/3) para modelos Live | **No publicado en tabla pública.** Google remite a `aistudio.google.com/rate-limit` (requiere login, personalizado por proyecto). | `ai.google.dev/gemini-api/docs/rate-limits` | **Alta confianza en que NO está publicado** — confirmado explícitamente por la propia página oficial |
| Concurrencia en Vertex AI (vía Firebase AI Logic) | 1,000 sesiones concurrentes por proyecto Firebase; 4M TPM (Vertex AI backend) | `firebase.google.com/docs/ai-logic/live-api/limits-and-specs` | **Alta** — pero **ojo: esto es Vertex AI / Firebase, no necesariamente el mismo pool que la Gemini Developer API** que usa el proyecto (`@google/genai` con API key directa vs. Vertex AI con proyecto GCP). Hay que confirmar cuál backend usa el proyecto actualmente. |
| Límites por gasto en ventana de 10 min | Free: N/A · Tier 1: $10 · Tier 2: $200 · Tier 3: $200 | `ai.google.dev/gemini-api/docs/rate-limits` | **Alta** (cita textual de tabla oficial) |
| Priority inference | 0.3x del rate limit estándar del modelo/tier | `ai.google.dev/gemini-api/docs/rate-limits` | **Alta** (mecanismo confirmado, sin cifras absolutas) |

---

## 5. Mejores prácticas de reconexión recomendadas por Google

De `ai.google.dev/gemini-api/docs/live-api/best-practices`, `ai.google.dev/gemini-api/docs/live-session`, `ai.google.dev/api/live`, y la guía de reintentos de Google Cloud (Gemini Enterprise / Vertex AI):

1. **Escuchar el mensaje de aplicación `GoAway`** (no un evento de WebSocket nativo, sino un mensaje dentro del protocolo Live) y usar el campo `timeLeft` para iniciar reconexión proactiva *antes* de que el servidor corte la conexión — evita perder audio o cortar al usuario en plena llamada.
2. **Activar `sessionResumption`** en la config de sesión (`BidiGenerateContentSetup.sessionResumption`). El servidor emite periódicamente `SessionResumptionUpdate { newHandle, resumable }`. Guardar el `newHandle` más reciente; el flag `resumable` indica si en ese punto exacto la sesión puede reanudarse (p.ej. **no** es resumible mientras el modelo está ejecutando una tool call o generando — punto relevante para el proyecto, que usa `functionCalls`).
3. **Modo "transparente"** (`SessionResumptionConfig(transparent=True)`, documentado en la variante Vertex AI/Cloud de la guía): el cliente mantiene un buffer de los mensajes enviados; el servidor devuelve `last_consumed_client_message_index` en el `SessionResumptionUpdate`, permitiendo al cliente descartar del buffer lo ya procesado y reenviar solo lo no confirmado tras reconectar — pensado para no perder ni un chunk de audio en la reconexión. (Esta variante "transparente" con buffer de reenvío está documentada del lado Vertex AI / Cloud; no se confirmó su disponibilidad idéntica en la Gemini Developer API / `@google/genai` en esta investigación — a verificar contra el changelog del SDK si se quiere usar.)
4. **Activar `contextWindowCompression`** con ventana deslizante (`slidingWindow`) y `triggerTokens` configurado, para permitir sesiones de duración arbitraria sin toparse con el límite de 15 min audio-only — el proyecto ya lo hace.
5. **Backoff exponencial con jitter** para reconexión: ~1s → 2s → 4s → 8s…, con un máximo de intentos, y reintentar **solo** en errores transitorios (429, 408, 5xx / equivalentes 1011, 1006 en WebSocket). No reintentar automáticamente ante errores de configuración (400/1007) o de credenciales (403/1008).
6. **Enviar audio en chunks de 20–40ms** para latencia óptima (best practice general, no de error-handling, pero relevante al pipeline de audio del proyecto).
7. **Sobre escalar de tier de quota:** no hay una guía oficial "cómo pedir más TPM para Live API" con pasos concretos encontrada en esta investigación más allá de la mención en el foro de un formulario de solicitud de aumento de cuota. Se recomienda validar directamente en `aistudio.google.com/rate-limit` (panel autenticado del proyecto) y contactar soporte de Google Cloud/AI Studio para el caso puntual de telefonía de alto volumen.

---

## 6. Evidencia no oficial / reportes de comunidad

**Marcado explícitamente como NO oficial — reportes de foros y GitHub issues, no documentación de Google:**

- **GitHub `googleapis/js-genai#1212`**: cierre código 1007, reason *"Request contains an invalid argument"*, con `gemini-2.5-flash-native-audio` al incluir `Modality.TEXT` en `responseModalities` en combinaciones no soportadas.
- **GitHub `googleapis/python-genai#2238`**: `response_modalities=[TEXT]` causa 1011 en `gemini-3.1-flash-live-preview` — mismo modelo que usa el proyecto, indica que ciertas combinaciones de modalidad rompen el server-side incluso en el modelo actual.
- **GitHub `googleapis/js-genai#1578`**: en `gemini-3.1-flash-live-preview` con TTS nativo, `temperature: 0` explícito puede producir salida de audio "runaway"/sin audio y cierre 1011.
- **GitHub `google/adk-python#4587`, `#3918`, `#3035`**: cierres intermitentes 1000 y 1011 durante ejecución de tool calls, y timeouts de conexión — patrón consistente con lo que reporta el proyecto en producción.
- **GitHub `livekit/agents#1679`** (cerrado como "not planned"): bajo conexión WebSocket sin rate-limiting propio del lado cliente, aparece `extensible_stubs::OVERLOADED_TOO_MANY_RETRIES_PER_REQUEST` seguido de cierre 1011 — **directamente relevante**: sugiere que abrir/reintentar conexiones agresivamente sin control de admisión propio puede *agravar* el problema de cuota, no solo sufrirlo.
- **Foro oficial, hilo "Official concurrent session / RPS limits... where are they documented?"** (`discuss.ai.google.dev/t/174664`, julio 2026): usuario con caso de uso muy similar al del proyecto (telefonía, 10k+ llamadas simultáneas planeadas) pregunta exactamente lo mismo que motivó esta investigación. Respuesta de Google (Alisa Fortin): **no hay garantía de sesiones concurrentes, el control es por TPM**, con formulario para pedir aumento de cuota según consumo de tokens necesario. Sin números concretos publicados para `gemini-3-flash-live`.
- **Foro oficial, hilo sobre 1011 mid-call** (`discuss.ai.google.dev/t/171560`): empleado de Google (Jon Matthews, 9-jul-2026) confirma que desplegaron cambios para reducir frecuencia de 1011 y que deberían venir con mejor explicación en el reason, pero niega que los modelos preview fallen sistemáticamente más — contradicho por otros reportes de la misma discusión que señalan justamente que los endpoints `-live-preview` son "materialmente menos estables".
- **Foro oficial, hilo `gemini-3.1-flash-live-preview` audio+video 1011 + resumption en loop** (`discuss.ai.google.dev/t/175234`): patrón grave — reanudar un handle tras un 1011 en sesión audio+video hace que la nueva sesión vuelva a caer en <1s, entrando en loop irrecuperable hasta descartar el handle. No hay confirmación de que esto ocurra en sesiones audio-only puras (el caso del proyecto), pero es una señal a monitorear de cerca si se activa `GEMINI_RESUMPTION=true` en producción.
- **Foro oficial, hilo sobre cierre a los 2–3 min sin `GoAway`** (`discuss.ai.google.dev/t/112241`): Google (Pooja Kapse, 12-ene-2026) respondió que "el timeout y el goAway funcionan correctamente de nuestro lado" y pidió repro — sin confirmar el bug, pero sin descartarlo tampoco. Otros usuarios en el mismo hilo reportan variantes (5 min, 170s).
- **Foro sobre TPM insuficiente en `gemini-3.1-flash-live-preview` free tier** (`discuss.ai.google.dev/t/138097`): usuario reporta 65K TPM en free tier (vs. 1M TPM de modelos previos), agotado rápidamente con imágenes de alta resolución; solución fue bajar resolución de imágenes — no aplica directamente al proyecto (solo audio), pero confirma que el modelo actual tiene un presupuesto de TPM notablemente más ajustado que generaciones anteriores.

---

## 7. Fuentes citadas

**Documentación oficial:**
- Live API — Session management: https://ai.google.dev/gemini-api/docs/live-session
- Live API — Best practices: https://ai.google.dev/gemini-api/docs/live-api/best-practices
- Live API — WebSockets API reference: https://ai.google.dev/api/live
- Live API — Capabilities guide: https://ai.google.dev/gemini-api/docs/live-guide
- Gemini API — Rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- Gemini API — Troubleshooting guide: https://ai.google.dev/gemini-api/docs/troubleshooting
- Firebase AI Logic — Manage sessions for the Live API: https://firebase.google.com/docs/ai-logic/live-api/sessions
- Firebase AI Logic — Limits and specifications of the Live API: https://firebase.google.com/docs/ai-logic/live-api/limits-and-specs
- Firebase AI Logic — Rate limits and quotas: https://firebase.google.com/docs/ai-logic/quotas
- Google Cloud (Gemini Enterprise Agent Platform) — Start and manage live sessions: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/start-manage-session
- Google Cloud (Vertex AI) — Start and manage live sessions: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api/start-manage-session
- Google Cloud — Retry strategy (Gemini Enterprise Agent Platform): https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/retry-strategy
- Google Cloud — Generative AI quotas and system limits: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/quotas
- `js-genai` SDK reference — clase `Live`: https://googleapis.github.io/js-genai/release_docs/classes/live.Live.html

**GitHub issues / repos:**
- googleapis/js-genai #1212 — cierre 1007 con modalidad TEXT inválida: https://github.com/googleapis/js-genai/issues/1212
- googleapis/python-genai #2238 — 1011 con `response_modalities=[TEXT]` en `gemini-3.1-flash-live-preview`: https://github.com/googleapis/python-genai/issues/2238
- googleapis/js-genai #1578 — 1011 con TTS y `temperature: 0`: https://github.com/googleapis/js-genai/issues/1578
- google/adk-python #4587 — cierre intermitente 1000: https://github.com/google/adk-python/issues/4587
- google/adk-python #3918 — 1011 durante tool execution: https://github.com/google/adk-python/issues/3918
- google/adk-python #3035 — timeout de conexión: https://github.com/google/adk-python/issues/3035
- livekit/agents #1679 — sobrecarga de WebSocket, `OVERLOADED_TOO_MANY_RETRIES_PER_REQUEST` + 1011: https://github.com/livekit/agents/issues/1679
- google-gemini/live-api-web-console (repo de referencia oficial de Google para Live API sobre WebSockets): https://github.com/google-gemini/live-api-web-console

**Foro oficial de desarrolladores (discuss.ai.google.dev):**
- Límites oficiales de sesiones concurrentes/RPS — no documentados, respuesta de Google: https://discuss.ai.google.dev/t/official-concurrent-session-rps-limits-for-gemini-live-api-where-are-they-documented/174664
- Sesión cae con 1011 "Internal error" mid-call: https://discuss.ai.google.dev/t/gemini-live-realtime-session-drops-mid-call-with-1011-internal-error-websocket-closed-by-google/171560
- `gemini-3.1-flash-live-preview` audio+video muere con 1011 y loop de resumption: https://discuss.ai.google.dev/t/live-api-gemini-3-1-flash-live-preview-audio-video-sessions-die-with-1011-internal-error-encountered-2-min-in-resuming-the-handle-then-kills-every-next-session/175234
- Conexión cierra a los 2–3 min sin `GoAway`: https://discuss.ai.google.dev/t/google-live-api-connection-closes-after-2-3-minutes-of-inactivity-without-goaway-notice/112241
- TPM insuficiente en free tier para `gemini-3.1-flash-live-preview`: https://discuss.ai.google.dev/t/gemini-3-1-flash-live-preview-doesnt-have-enough-free-tpm-quota/138097
- Issues varios 1008/1011, costo por sesión, function calling: https://discuss.ai.google.dev/t/gemini-live-api-issues-1008-1011-disconnects-per-session-cost-function-calling-api-logs/116509

---

## 8. Gaps identificados (para seguimiento)

1. No se pudo confirmar con cifras oficiales el TPM/RPM exacto por tier pago (Tier 1/2/3) para `gemini-3.1-flash-live-preview` — requiere login en `aistudio.google.com/rate-limit` con las credenciales del proyecto real.
2. No se confirmó si el proyecto usa la Gemini Developer API (API key) o Vertex AI (proyecto GCP) — los límites de concurrencia y TPM son pools distintos y esto cambia la interpretación de varios hallazgos (en particular el dato de "1,000 sesiones concurrentes / 4M TPM" es específico de Vertex AI vía Firebase, no necesariamente aplicable si el proyecto usa API key directa).
3. No hay confirmación oficial de qué código de cierre WebSocket sigue exactamente al mensaje `GoAway` (se documenta el mensaje de aplicación, no el código de cierre subyacente).
4. El comportamiento de `sessionResumption` en loop de fallo tras 1011 está reportado solo para audio+video; no hay evidencia directa (ni a favor ni en contra) de que ocurra en sesiones audio-only puras como las del proyecto — ameritaría prueba controlada antes de activar `GEMINI_RESUMPTION=true` en producción a gran escala.
5. No se encontró el formulario oficial de solicitud de aumento de cuota mencionado en el foro; se recomienda buscarlo directamente en la consola de Google Cloud / AI Studio del proyecto.
