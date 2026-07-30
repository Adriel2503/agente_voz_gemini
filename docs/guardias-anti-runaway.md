# Guardias anti-runaway — diseño

Diseño de las dos guardias que faltan en `crearSesion` para que el gateway no
pueda volver a entrar en la espiral del 16-jul-2026:

1. **Tope de concurrencia por empresa** (`empresa.canal`) — reponer el que se
   retiró en `ba7e364`.
2. **Límite de tasa de apertura de sesiones** — nuevo, no existió nunca.

Contexto y números: [capacidad-gemini-live.html](capacidad-gemini-live.html),
secciones 5 y 8. Resumen de lo que importa acá:

- El techo es **18,75 sesiones nuevas/minuto** (150.000 TPM ÷ ~8.000 tokens de
  setup por llamada).
- El colapso es un **lazo de realimentación**: una sesión rechazada muere a los
  3 s en vez de 56 s, el operador se libera antes y remarca → más aperturas →
  más rechazos.
- **Un tope de concurrencia NO corta ese lazo.** El 16-jul el tope de 15 estaba
  activo y funcionando: los 15 espacios se reciclaron 63 veces por minuto. Lo
  que corta el lazo es limitar la **tasa**, porque no depende de cuánto duren
  las llamadas.

> **Alcance: solo código.** No se crean ni modifican columnas de BD.
> `empresa.canal` ya existe con valores cargados (Credicash=15, alfin=3,
> efectiva=3) y se lee **tal cual está**. Bajar Credicash de 15 a 9 —lo que
> recomienda el análisis— es una decisión operativa **posterior y separada**,
> que además requiere verificar si otro consumidor de la tabla `empresa` sigue
> leyendo esa columna. Este cambio no depende de esa verificación.

## Por qué el límite de tasa es el que importa

Un rechazo nuestro (503 en el POST) es **gratis**: no abre sesión Gemini, no
manda prompt, no consume un solo token de TPM. Un rechazo de Gemini
(`RESOURCE_EXHAUSTED`) **ya pagó** los ~8.000 tokens del setup.

Esa asimetría es todo el diseño: aunque el marcador de Target ignore el
`Retry-After` y nos martille a 63 POST/min, absorbemos la ráfaga sin quemar
cuota, y las sesiones que sí admitimos se completan sanas. Sin esta guardia, esos
mismos 63 intentos se convierten en 504.000 tokens/min = 336 % de la cuota.

## Punto único de control

Ambas guardias van en **un solo bloque** dentro de `crearSesion`, inmediatamente
antes de `store.crear` (`sesiones.controller.js:117`).

```mermaid
flowchart TD
    A[POST /sesiones] --> B[auth · getEmpresa · api_voz_activo]
    B --> C[plantilla · campos · tools · tipificaciones]
    C --> D[render prompt · tiendas · feriados]
    D --> E{{GUARDIAS — bloque sincrónico}}
    E -->|concurrencia llena| R1[503 sin_canales + Retry-After]
    E -->|tasa excedida| R2[503 tasa_excedida + Retry-After]
    E -->|admitida| F[store.crear = reserva]
    F --> G[await gemini.crearLlamadaServerWs]
    G -->|error| H[store.eliminar → 502/503]
    G -->|ok| I[201 + ws_url]
```

**Por qué ahí y no antes.** El bloque tiene que ser **sincrónico y adyacente a
`store.crear`**, sin ningún `await` en el medio. Node es monohilo: mientras no
haya `await`, chequear-y-reservar es atómico. Si la guardia se evaluara temprano
(justo después de `getEmpresa`) y `store.crear` ocurriera varios `await` después,
N requests concurrentes pasarían todas el chequeo antes de que ninguna se
registrara — y el caso que nos importa es exactamente ése: **17 sesiones en
10 segundos**. La guardia se rompería justo en la ráfaga que debe frenar.

Es el mismo razonamiento que ya documentaba el código viejo: *"Reserva del canal:
registramos la sesión como pendiente ANTES del await"*.

**Costo aceptado:** un rechazo paga primero las queries de plantilla/campos/
tipificaciones y los fetch de tiendas/feriados (decenas de ms). A cambio, la
guardia es correcta bajo ráfaga, que es el único escenario que importa. Un
fast-fail temprano (chequeo no autoritativo apenas se tiene `empresa`) queda
como optimización posterior, **no** como reemplazo del chequeo atómico.

## Guardia 1 — tope de concurrencia (`empresa.canal`)

Cuántas sesiones simultáneas le aceptamos a una empresa.

| Aspecto | Decisión |
|---------|----------|
| Fuente del límite | `empresa.canal`, leído en `getEmpresa` (agregar la columna al SELECT) |
| Semántica de `0` / `NULL` | **Sin límite** — preserva la semántica del código viejo (`canal <= 0`) y hace el cambio inerte para empresas sin valor cargado |
| Qué se cuenta | Sesiones de **esa empresa** con `estado !== "finalizada"` en esta instancia |
| Liberación | `cerrar()` marca `finalizada` sincrónicamente (`geminiEngine.js:267`) y borra del store (`:354`) |

`store.contarActivas()` hoy es **global** (suma todas las empresas) y solo se usa
para la traza del log. Hace falta `contarActivasPorEmpresa(idEmpresa)`.

**Fuga acotada, por diseño.** Una sesión creada por POST cuyo integrador nunca
conecta el WSS ocupa un canal hasta que `purgarExpiradas` la limpia: ventana de
30 s, barrido cada 15 s → **hasta ~45 s**. Bajo ráfaga esto hace el tope
*más* conservador (rechaza antes), que es la dirección correcta del error. No se
toca.

## Guardia 2 — límite de tasa de apertura

Cuántas sesiones nuevas por minuto admitimos. **Ventana deslizante**, no minuto
de reloj: la cuota de Gemini es deslizante (el análisis lo midió — el minuto
15:53 marcó 80 % y aun así falló, porque entre 15:52:15 y 15:53:15 entraron
~21 sesiones = 112 %). Una ventana fija de reloj permite el doble del límite a
caballo del borde, que es justo el patrón de ráfaga que causó el incidente.

### Por qué el bucket es la API key, no la empresa

La cuota de TPM es **por key**. Con el rollout de keys por empresa a medio camino
([keys-gemini-por-empresa.md](keys-gemini-por-empresa.md)), agrupar por empresa
sería incorrecto: dos empresas todavía en el fallback global comparten una sola
cuota, y con 10/min cada una sumarían 20/min sobre la misma key = por encima del
techo de 18,75.

Bucketear por **key efectiva** (`empresa.gemini_api_key || env.gemini.apiKey`) da
el agrupamiento correcto en ambos casos y sigue siendo correcto a medida que
avanza el rollout, sin tocar nada. Es el mismo patrón que el viejo
`contarPorApiKey`.

La key se usa **solo como clave del Map en memoria y nunca se loguea** — el log
lleva `empresa=N`. Precedente explícito: commit `621f770` (*"no loguear fragmento
de la api key en el rechazo 503"*).

Para no duplicar la resolución del fallback, `gemini.service.js` exporta un
helper (`resolverKey`) que usan tanto `crearLlamadaServerWs` como el controller.

### Cuándo se consume un slot

Se registra el timestamp **en el momento de admitir**, en el mismo bloque
sincrónico, no antes.

- Un `400 variables_incompletas` **no** consume slot: nunca tocó Gemini.
- Una sesión admitida que después falla en `crearLlamadaServerWs` **sí** deja el
  slot consumido, aunque `store.eliminar` libere el canal. Es deliberado: ese
  intento **ya llegó a Gemini y ya pagó tokens**. Devolver el slot invitaría a
  reintentar exactamente en el escenario donde la cuota está saturada.

### Parámetro

`MAX_SESIONES_POR_MINUTO`, default **10** (~55 % del techo de 18,75, que es donde
el sistema tolera >60 % de fallo transitorio sin entrar en espiral). `0` =
desactivado, misma semántica de escape que `canal <= 0` — importante tener el
interruptor de apagado en una guardia que puede rechazar tráfico productivo.

Se decide por env global (aplicado por bucket) y no por columna en BD: hoy el
volumen real es de una empresa, y una columna nueva es una migración + rollout
que no hace falta para cerrar el riesgo. Una `empresa.max_sesiones_minuto`
aditiva y nullable queda como paso posterior si aparece una segunda empresa con
volumen, siguiendo el mismo patrón de `gemini_api_key`.

## Contrato HTTP

Ambos rechazos: **503 + `Retry-After: 30`**, distinguibles por el campo `codigo`
del body.

| Caso | HTTP | `codigo` | `msg` |
|------|------|----------|-------|
| Concurrencia llena | 503 | `agente_indisponible` | `Sin canales disponibles. Reintente en unos segundos.` |
| Tasa excedida | 503 | `tasa_excedida` | `Limite de llamadas nuevas por minuto alcanzado. Reintente en unos segundos.` |

> **Resuelto (guardia 1, implementada).** Se restauró el contrato **exacto** que
> se retiró en `ba7e364` — `agente_indisponible`, no un `codigo` nuevo — para no
> romper integradores que ya lo manejan. La guardia 2 sí estrena `tasa_excedida`
> porque es un caso que nunca existió.

**Por qué 503 y no 429.** 429 es semánticamente más correcto para la tasa, pero
el integrador ya maneja el camino 503 + `Retry-After` (era la respuesta del tope
viejo y es la del `agente_indisponible` actual). Introducir un status nuevo
arriesga que el marcador lo trate como error duro y **descarte el lead** en vez
de reintentar. El `codigo` en el body da la distinción máquina-legible sin tocar
el contrato de status codes. Revisar
[contrato-post-sesiones.html](contrato-post-sesiones.html) al implementar.

## Observabilidad

Sin BD, mismo criterio que `metricasCierre.js`: que se vea en el log.

```
[sesiones] RECHAZADO 503 sin_canales empresa=8 ocupacion=15/15
[sesiones] RECHAZADO 503 tasa_excedida empresa=8 aperturas=10/10 en 60s
```

Un rechazo silencioso acá es una llamada que suena sin IA del otro lado — el
comentario que ya encabeza el helper `err()`. Ambos rechazos pasan por `err()`,
que ya loguea, más la línea de detalle con ocupación/tasa.

Contador agregado periódico (estilo `metricasCierre`, resumen cada 5 min) queda
como opcional del mismo PR.

## Archivos tocados

| Archivo | Cambio |
|---------|--------|
| `src/lib/tasaSesiones.js` | **nuevo** — ventana deslizante en memoria |
| `src/sessions/store.js` | + `contarActivasPorEmpresa(idEmpresa)` |
| `src/models/agenteVoz.model.js` | `getEmpresa`: agregar `canal` al SELECT |
| `src/services/gemini.service.js` | exportar `resolverKey(geminiApiKey)`; `crearLlamadaServerWs` lo usa |
| `src/controllers/sesiones.controller.js` | bloque de guardias antes de `store.crear` |
| `src/config/env.js` | + `maxSesionesPorMinuto` |
| `.env.example` | + `MAX_SESIONES_POR_MINUTO=10` |

### API de `tasaSesiones.js`

```js
// Chequeo y registro en UNA operación: un caller no puede admitir y olvidarse
// de registrar. `ahora` inyectable para que los tests no duerman.
admitir(bucket, limite, ahora = Date.now()) -> { ok, usados, limite }
```

Guarda un array de timestamps por bucket, podando los > 60 s en cada consulta.
Acotado por el propio límite (~10-20 entradas por bucket); se eliminan los
buckets que quedan vacíos.

## Tests

Ambos módulos son puros: se testean sin BD ni WS, con reloj inyectado.

`test/tasaSesiones.test.js`
- admite hasta el límite y rechaza el siguiente
- la ventana **desliza**: rechazada en t=0..59 s, admitida en t=61 s
- ráfaga a caballo del borde de minuto **no** permite 2× el límite (el caso que
  falla con ventana fija — es el test que justifica el diseño)
- `limite = 0` desactiva la guardia
- buckets independientes no se pisan

`test/topeConcurrencia.test.js`
- `contarActivasPorEmpresa` no mezcla empresas
- `finalizada` no cuenta; `pendiente`/`conectada`/`en_curso` sí
- `canal = 0` / `NULL` = sin límite

## Límites conocidos

- **Una sola instancia.** Ambas guardias son en memoria y por proceso. Con N
  réplicas en EasyPanel el límite efectivo es N×. `store.js` ya arrastra esta
  nota; si se escala, ambas guardias se van a Redis junto con el store.
- **No reemplazan al backoff del marcador** (recomendación #6, lado Target). Sin
  él la recuperación es más lenta, pero nuestros rechazos son gratis, así que la
  espiral de TPM no se sostiene.
- **No reducen el consumo por llamada.** La palanca de mayor impacto sigue siendo
  compactar el prompt de la plantilla 139 (recomendación #3), que es trabajo de
  contenido, no de este repo.

## Orden de implementación

1. `tasaSesiones.js` + su test (aislado, sin dependencias).
2. `contarActivasPorEmpresa` en el store + su test.
3. `canal` en `getEmpresa`; `resolverKey` en `gemini.service`.
4. Bloque de guardias en el controller.
5. `env.js` + `.env.example`.
6. Suite completa (`node --test`) + `node --check` de cada archivo tocado.
7. Commit conventional: `feat(sesiones): guardias de concurrencia y tasa de apertura`.

## Decisiones abiertas (resolver antes de implementar la guardia 2)

- **Valor de `MAX_SESIONES_POR_MINUTO`**: 10 propuesto. Es el único parámetro que
  puede rechazar tráfico bueno si queda corto.

## Estado

- [x] **Guardia de concurrencia (`empresa.canal`)** — restauración fiel, hecha
      2026-07-30. `canal` vuelve al SELECT de `getEmpresa`; nuevo
      `store.contarActivasPorEmpresa` (el `contarActivas` existente es global y
      habría mezclado empresas); guardia en `crearSesion` pegada a `store.crear`.
      Tests en `test/topeConcurrencia.test.js`; suite 66/66.
      Los valores de BD **no se tocaron**: Credicash sigue en 15.
- [ ] Guardia de tasa (`MAX_SESIONES_POR_MINUTO`) ← **es la que corta el lazo**
- [ ] Actualizar `contrato-post-sesiones.html` con los códigos de rechazo
- [ ] *(operativo, aparte)* Bajar `empresa.canal` de Credicash 15 → 9, previa
      verificación de otros lectores de la columna
