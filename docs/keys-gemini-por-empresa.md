# Keys de Gemini por empresa

Notas de diseño para mover la API key de Gemini de **global** (una para todo el
gateway) a **una por empresa**. Documenta la decisión tomada y las ideas de
escalado (el "punto 2") que quedan pendientes para el futuro.

## Contexto: por qué

En producción el gateway usaba **una sola key global** (`GEMINI_API_KEY` en el
env). Bajo carga, Gemini cerraba conexiones — `motivo_fin = gemini_close`.

Evidencia (tabla `api_voz_sesion`, empresa 8 = Target):

| Día | Volumen | `gemini_close` | avg duración |
|-----|---------|----------------|--------------|
| 14-jul | bajo | 0 | — |
| 15-jul | bajo | 1 | — |
| 16-jul | ~215 | **132** | 6 s |
| 18-jul | ~810 (792 en 1 hora) | **252** | 23 s |

El `gemini_close` **correlaciona con el volumen**: en días tranquilos casi no
aparece; en los blasts explota (~1 de cada 3 llamadas). Con una sola key global,
todas las empresas comparten el mismo presupuesto y se pisan.

**Gemini limita por tokens-por-minuto (TPM), no por sesiones concurrentes** (los
"canales" son efectivamente ilimitados). Así que el corte es por **exceder el
TPM** de la key (RESOURCE_EXHAUSTED), no por tope de conexiones simultáneas.

## Decisión tomada: una key por empresa

- **Cada empresa tiene su propia key de Gemini.** Aísla el presupuesto de TPM:
  el blast de Target consume *su* TPM, no el de las demás.
- **Columna nueva aditiva** `empresa.gemini_api_key` (`varchar(255)`, nullable).
  Se **deja intacto todo lo de Ultravox** (`empresa.ultravox_api_key`, la tabla
  `ultravox_api_key_adicional`, etc.) — no se renombra ni se dropea nada. Es el
  camino más seguro: agregar una columna nullable no rompe nada de lo que corre.
- **Sin pool.** Como Gemini no limita por canales sino por TPM, no hace falta
  repartir una empresa entre varias keys (a diferencia de Ultravox, donde Target
  usaba 3 keys / 12 canales). Si algún día una empresa satura su TPM, ver el
  punto 2.
- **Almacenamiento:** en texto plano (misma convención que `webhook_secret` en
  esa BD). Cifrado queda como mejora futura (ver abajo).
- **Rollout sin riesgo:** el gateway lee `empresa.gemini_api_key`; si es `NULL`,
  hace **fallback a la key global** (`env.gemini.apiKey`). Nada cambia hasta que
  se carga una key a una empresa. Se migra empresa por empresa.

## Punto 2: ideas de escalado (pendientes, NO implementadas)

Una key por empresa **aísla entre empresas**, pero si **una sola empresa de alto
volumen** supera el TPM de su propia key, el `gemini_close` puede volver para
esa empresa. Cuenta rápida para Target: ~792 llamadas/hora, picos en ráfagas.
Si su throughput de tokens supera el TPM del tier de la key → corta igual.

Opciones para ese caso (cuando/si aparece):

1. **Subir el TPM de la key** — pedir aumento de cuota en Google Cloud para el
   proyecto de esa empresa. Lo más simple si el tier lo permite.

2. **Pool de keys por empresa (TPM-weighted)** — recuperar la idea del
   `ultravox_api_key_adicional`, pero ponderando por **TPM disponible** en vez de
   por `canal`. El gateway repartiría llamadas entre las keys de la empresa para
   no saturar el TPM de ninguna. Es el mismo patrón que ya existía para Ultravox;
   el schema se puede extender de forma **aditiva** (tabla nueva
   `api_key_voz_adicional`) sin rehacer lo de una-key.

3. **Múltiples proyectos GCP** — cada key en un proyecto distinto multiplica el
   TPM total (los límites son por proyecto). Variante de (2).

### Observabilidad para decidir

- **Guardar el `reason` del cierre en `metadata`** al cerrar la sesión —
  **hecho**. `onclose`/`onerror` capturan `{ code, reason }` (o `error`) crudo de
  Gemini y `cerrar()` los persiste en `api_voz_sesion.metadata.cierre_detalle`
  (más `metadata.reconexiones`). Con eso se ve exactamente si fue
  RESOURCE_EXHAUSTED / TPM u otra cosa, sin depender de los logs de EasyPanel.
- **Monitorear `gemini_close` por empresa** para detectar quién está topando su
  TPM y necesita las opciones de arriba.

### Otras mejoras relacionadas

- **Reconexión en `gemini_close`** con backoff — hoy hay reconexión transparente
  solo para `goAway` (flag `GEMINI_RESUMPTION`). Ojo: si el corte es un TPM cap
  duro, reconectar de inmediato vuelve a chocar; solo ayuda si es transitorio.
- **Cifrado de las keys** en la BD (simétrico, clave maestra en el env) — mejora
  de seguridad sobre el almacenamiento en plano.

## Estado

- [x] Migración: `ALTER TABLE empresa ADD COLUMN gemini_api_key VARCHAR(255)` (aditiva, nullable) — hecho
- [x] Código: gateway lee `empresa.gemini_api_key` con fallback a `env.gemini.apiKey` — hecho
  - `getEmpresa` trae la columna · controller pasa `geminiApiKey` · `gemini.service` resuelve el fallback · `geminiEngine` conecta con esa key
- [ ] Cargar la key por empresa y probar (empezando por Target)
