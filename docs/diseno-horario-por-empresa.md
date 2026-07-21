# Diseño — Horario de atención por empresa (Fase B)

**Objetivo:** que `agendar_cita` valide el horario real de cada empresa (Alfin: L-V 9-19, Sáb 9-18, Dom y feriados cerrado) para poder eliminar las ~4.100 caracteres de aritmética del BLOQUE F en el prompt de Alfin.

**Restricción no negociable:** Credicash está en producción y no debe cambiar su comportamiento en absoluto.

---

## 1. Estado actual (as-is)

| Pieza | Ubicación | Estado |
|---|---|---|
| Validación de cita | `app-api/src/services/crm/agendamientoCita.service.js` | Función pura, ya recibe `horario` como parámetro |
| Horario | `HORARIO_TIENDA` en ese archivo | Hardcodeado 09:00-21:00, igual los 7 días, sin días cerrados |
| Call site agente de voz | `llamada.controller.js:854` | Resuelve zona horaria por `session_id`, llama `validarCita` |
| Call site campaña Asterisk | `llamada.controller.js:890` | Zona `America/Lima` fija |
| Catálogo de feriados | tabla `feriados_peru` + `feriadosPeru.service.js` | Existe, mantenido por cron; hoy **solo** alimenta `{{feriados_proximos}}` del prompt |
| Reenvío del rechazo al modelo | `agente_voz/src/tools/geminiTools.js:100-109` | Ya funciona: el body del 422 llega al modelo |
| Tests | `app-api/test/agendamientoCita.test.js` | 14 tests con el horario default |

El comentario en `agendamientoCita.service.js:13` ya anticipa este cambio:
`// TODO: mover a config por empresa cuando entre una con otro horario.`

---

## 2. Principio de diseño: el default ES el comportamiento actual

Toda la seguridad del cambio se apoya en una sola propiedad:

> Si una empresa no tiene horario configurado (`NULL`), se comporta **exactamente** como hoy.

Consecuencias:
- La migración no hace backfill. Todas las filas quedan en `NULL` → cero cambio el día del deploy.
- Credicash nunca configura nada → Credicash no cambia.
- Alfin es la única fila con valor.
- Los 14 tests existentes deben pasar **sin tocarse**. Esa es la prueba mecánica de no-regresión.

### El detalle crítico: feriados opt-in

Credicash **abre en feriados** — su prompt lo dice explícito: *"domingos y feriados no afectan, no valides el día de la semana"*.

Si la validación de feriados fuera global, el 28 de julio se le caerían todas las citas a Credicash. Por eso el horario lleva un flag `cierraFeriados` que **solo Alfin prende**. Sin ese flag, el servicio ni siquiera consulta la tabla de feriados.

---

## 3. Modelo de datos

### 3.1 Forma del horario

```js
{
  // Índice 0 = domingo … 6 = sábado (igual que Date.getUTCDay()).
  // null = ese día no se atiende.
  dias: [
    null,                                          // 0 domingo
    { apertura: "09:00:00", cierre: "19:00:00" },  // 1 lunes
    { apertura: "09:00:00", cierre: "19:00:00" },  // 2 martes
    { apertura: "09:00:00", cierre: "19:00:00" },  // 3 miércoles
    { apertura: "09:00:00", cierre: "19:00:00" },  // 4 jueves
    { apertura: "09:00:00", cierre: "19:00:00" },  // 5 viernes
    { apertura: "09:00:00", cierre: "18:00:00" }   // 6 sábado
  ],
  anticipacionMin: 60,      // la cita debe ser >= 1h después de "ahora"
  cierraFeriados: true      // consulta feriados_peru y los trata como cerrados
}
```

**Default (= Credicash, = comportamiento actual):**

```js
const HORARIO_DEFAULT = {
  dias: Array(7).fill({ apertura: "09:00:00", cierre: "21:00:00" }),
  anticipacionMin: 60,
  cierraFeriados: false,
};
```

Rango inclusivo en ambos extremos, igual que hoy (el comentario actual documenta que hay 5 citas a las 21:00:00 exactas en producción y el negocio las acepta).

### 3.2 Migración

Patrón idéntico al de `20260608_add_id_empresa_to_voz.sql` (Postgres, `public.`, idempotente):

```sql
-- migrations/2026XXXX_add_horario_agencia_to_empresa.sql
-- Horario de atención de las agencias/tiendas de la empresa, usado por
-- validarCita (tool agendar_cita) para rechazar citas imposibles.
-- NULL = horario por defecto (9-21 todos los días, feriados no afectan):
-- es el comportamiento histórico y el de Credicash. NO se hace backfill.

ALTER TABLE public.empresa
  ADD COLUMN IF NOT EXISTS horario_agencia jsonb NULL;

COMMENT ON COLUMN public.empresa.horario_agencia IS
  'Horario de atención por día de semana. {dias:[7 x null|{apertura,cierre}], anticipacionMin:int, cierraFeriados:bool}. Índice 0=domingo. NULL = default 9-21 todos los días.';
```

Fila de Alfin como paso de datos **separado** (no en la misma migración, para poder desplegar el código sin activar el cambio):

```sql
UPDATE public.empresa SET horario_agencia = '{
  "dias": [null,
    {"apertura":"09:00:00","cierre":"19:00:00"},
    {"apertura":"09:00:00","cierre":"19:00:00"},
    {"apertura":"09:00:00","cierre":"19:00:00"},
    {"apertura":"09:00:00","cierre":"19:00:00"},
    {"apertura":"09:00:00","cierre":"19:00:00"},
    {"apertura":"09:00:00","cierre":"18:00:00"}],
  "anticipacionMin": 60,
  "cierraFeriados": true
}'::jsonb
WHERE id = <ID_EMPRESA_ALFIN>;
```

**Ids confirmados contra la BD de producción:**

| id | razon_social | api_voz_activo | Rol |
|---|---|---|---|
| 8 | `Target_Credicash` | 1 | 125 citas. Horario 9-21 todos los días → queda en `NULL` (default) |
| 40 | `Target_alfin_banca` | 1 | **← el `UPDATE` va acá.** 814 sesiones, 20 citas |
| 73 | `Target_efectiva_consumo` | 1 | 0 sesiones, 0 citas. Configurada pero sin tráfico; queda en `NULL` hasta que se defina su horario |
| 2 | `prueba` | 1 | Empresa de pruebas, sin citas |

Todas las empresas activas usan `id_zona_horaria = 1` = `America/Lima`.

### Evidencia: el problema ya ocurrió en producción (Alfin)

De las 20 citas de Alfin, **2 son citas fantasma** que la validación actual dejó pasar:

| id | Fecha | Hora | Problema |
|---|---|---|---|
| 732 | mié 2026-06-24 | **20:00** | Alfin cierra 19:00 L-V. El backend la aceptó porque valida con 9-21 (horario Credicash) |
| 729 | lun 2026-06-29 | 10:00 | **Feriado** (Día de San Pedro y San Pablo). Agencia cerrada; hoy no se valida feriado |

10% de tasa de citas imposibles. Es exactamente el mismo tipo de bug que motivó crear `validarCita` (la cita de las 23:30 de Credicash, id=68), pero contra la dimensión que la función todavía no cubre.

### 3.3 Por qué columna en `empresa` y no tabla nueva

- La config operativa por empresa ya vive ahí (`id_zona_horaria` es el precedente directo).
- Sirve a los **dos** call sites: agente de voz (resuelve por `session_id`) y campaña Asterisk (resuelve por `provider_call_id`); ambos terminan en `id_empresa`.
- Una sola migración, sin tabla ni joins nuevos.
- El JSON tiene exactamente la forma del objeto JS — sin capa de mapeo.
- `NULL` como "usar default" es la semántica más segura posible para un deploy.

Contra: no es normalizado ni editable desde la UI con un formulario. Para 2 empresas es el trade-off correcto; si más adelante se vuelve config de cliente, se migra a tabla propia sin tocar la lógica (el servicio ya recibe el objeto armado).

---

## 4. Cambios en `agendamientoCita.service.js`

### 4.1 Contrato

```js
validarCita({
  fecha,      // "YYYY-MM-DD"
  hora,       // "HH:MM" | "HH:MM:SS"
  ahora,      // { fecha, hora } en la zona de la empresa
  horario,    // objeto sección 3.1; default HORARIO_DEFAULT
  feriados,   // Set<"YYYY-MM-DD">; default vacío. Solo se usa si horario.cierraFeriados
})
// -> { ok: true }
// -> { ok: false, success: false, motivo, mensaje, sugerencia: {fecha, hora} }
```

La función sigue siendo **pura**: los feriados entran como dato, no los consulta ella. Eso mantiene los tests sin BD ni reloj.

### 4.2 Orden de validación

```
1. formato_invalido     regex de fecha/hora
2. fecha_pasada         fecha < hoy
3. dia_cerrado    ←NUEVO   dias[diaSemana(fecha)] === null
4. feriado        ←NUEVO   cierraFeriados && feriados.has(fecha)
5. fuera_de_horario     hora fuera de [apertura, cierre] DE ESE DÍA
6. hora_pasada          es hoy && hora < ahora
7. muy_cerca            es hoy && hora < ahora + anticipacionMin
8. ok
```

**Por qué este orden no rompe Credicash:** los pasos 3 y 4 son inalcanzables con el default (ningún día es `null`, `cierraFeriados` es `false`), y el orden relativo de 5-6-7 queda idéntico al actual. Insertar reglas que nunca disparan no cambia el resultado.

**Por qué el día va antes que la hora:** comparar una hora contra el `cierre` de un día cerrado es indefinido — no hay cierre. Es el mismo bug de orden que se corrigió en la tabla F.3 del prompt.

### 4.3 Funciones nuevas / modificadas

| Función | Cambio |
|---|---|
| `diaSemana(fecha)` | **Nueva.** `new Date(Date.UTC(y, m-1, d)).getUTCDay()` — aritmética de calendario pura, sin TZ, mismo patrón que el `sumarDias` existente |
| `horarioDelDia(fecha, horario)` | **Nueva.** Devuelve `{apertura, cierre}` o `null` |
| `estaCerrado(fecha, horario, feriados)` | **Nueva.** `horarioDelDia() === null` o feriado con flag prendido |
| `proximoDiaAbierto(fecha, horario, feriados)` | **Nueva.** Avanza día a día hasta encontrar uno abierto. **Tope de 14 iteraciones** por si alguien configura los 7 días en `null`; si se agota, devuelve `null` y el caller cae al default con log de error |
| `sugerirAlternativa(ahora, horario, feriados)` | Modificada: si hoy está cerrado o ya no alcanza, salta al **próximo día abierto** a su apertura (hoy asume que mañana siempre sirve) |
| `sugerenciaMismoDia(...)` | Modificada: solo se llama para días abiertos (los cerrados se atajan en el paso 3-4), y usa el `apertura`/`cierre` **de ese día** |
| `hora12(hora)` | Sin cambios |

### 4.4 Mensajes

Los mensajes se arman con el horario del día concreto, no con constantes:

| motivo | mensaje |
|---|---|
| `dia_cerrado` | `Los domingos la agencia está cerrada. Ofrecele al cliente el lunes 3 de agosto a las 9 de la mañana.` |
| `feriado` | `Ese día es feriado nacional y la agencia está cerrada. Ofrecele al cliente el jueves 30 de julio a las 9 de la mañana.` |
| `fuera_de_horario` | `La agencia atiende de 9 de la mañana a 7 de la noche. Ofrecele al cliente …` |

El mensaje viaja al modelo tal cual y ya viene en formato hablado — el agente no convierte nada. Es el mismo contrato que credicash.txt §4.5 ya usa en producción.

---

## 5. Resolución de la configuración

### 5.1 Consulta

`getZonaHorariaBySession` ya hace `JOIN empresa`. Se extiende para traer las dos cosas en **una sola query** (sin roundtrip extra):

```js
// apiVoz.model.js — reemplaza getZonaHorariaBySession
async getContextoAgendamientoBySession(session_id) {
  const [rows] = await this.connection.execute(
    `SELECT COALESCE(z.codigo, 'America/Lima') AS zona_horaria,
            e.horario_agencia
       FROM api_voz_sesion s
       LEFT JOIN empresa e ON s.id_empresa = e.id
       LEFT JOIN zona_horaria z ON e.id_zona_horaria = z.id
      WHERE s.session_id = ?
      LIMIT 1`,
    [session_id]
  );
  return {
    zona: rows?.[0]?.zona_horaria || "America/Lima",
    horario: rows?.[0]?.horario_agencia || null,
  };
}
```

Para la rama de campaña Asterisk: análogo vía `llamada` → `id_empresa`.

Sin caché por ahora: `agendar_cita` se invoca una vez por llamada, el volumen no lo justifica y el estado en memoria agrega una superficie de bugs innecesaria.

### 5.2 Saneamiento del JSON

Nunca confiar en la columna. `normalizarHorario(raw)` valida forma y, ante cualquier anomalía, devuelve `HORARIO_DEFAULT` con `logger.warn`:

- `dias` no es arreglo de 7 → default
- alguna entrada no-null sin `apertura`/`cierre` válidos → default
- `apertura >= cierre` en algún día → default
- `anticipacionMin` no numérico → 60

Un JSON mal escrito degrada al comportamiento de hoy; nunca tumba la tool.

### 5.3 Feriados

Solo si `horario.cierraFeriados === true`:

```js
// Ventana suficiente para cubrir el bucle de proximoDiaAbierto (máx 14 días)
// más margen. ~15 filas.
SELECT fecha FROM feriados_peru
 WHERE activo = TRUE
   AND fecha >= CURRENT_DATE
   AND fecha <= CURRENT_DATE + INTERVAL '90 days'
```

**Política ante fallo de la consulta: fail-open** (se permite la cita, con `logger.error`).

Razonamiento: bloquear *todas* las citas porque la tabla de feriados no respondió es peor que dejar pasar una cita en feriado. Además hay una segunda red — `{{feriados_proximos}}` sigue inyectándose en el prompt, así que el modelo todavía puede atajar el caso. Por eso **esa parte del prompt no se elimina en la Fase B**: es defensa en profundidad, no redundancia.

---

## 6. Impacto en el prompt de Alfin

El BLOQUE F **no desaparece entero**. Lo que el backend no puede hacer es lo que ocurre *antes* de la llamada a la tool:

| Sección | Destino | Motivo |
|---|---|---|
| F.1 Definiciones | **Eliminar** | El backend es dueño del horario |
| F.2 Parseo (*"10 de la noche"* = 22:00) | **Conservar** | Si el modelo convierte mal, el backend valida correctamente una hora equivocada |
| F.3 Tabla de 8 casos | **Eliminar** | La reemplaza el `mensaje` + `sugerencia` de la tool |
| F.4 Auto-sugerencia | **Eliminar** | La calcula `sugerirAlternativa` |
| F.5 Día de la semana hablado | **Conservar** | Para decir *"viernes quince de mayo"* al confirmar |
| F.6 Última pasada | **Eliminar** | La tool es la validación |
| Regla de obediencia a `ok:false` | **Ya está** en 4.6 | Escrita en la ronda anterior |

**Resultado: 5.446 → ~1.300 caracteres.** Ahorro de ~4.100 (12% del prompt), y sobre todo se va la parte frágil: la aritmética.

Queda además una simplificación en 4.6 que hoy es un parche temporal: la instrucción *"ofrece la sugerencia solo si también pasa la tabla F.3"* existe porque hoy el backend sugiere con el horario de Credicash. Con Fase B desplegada, la sugerencia ya viene correcta para Alfin y esa condición se borra.

---

## 7. Plan de pruebas

### 7.1 Regresión (la garantía para Credicash)

Los 14 tests de `agendamientoCita.test.js` **pasan sin modificación**. Si alguno requiere tocarse, el diseño está mal y hay que parar.

### 7.2 Casos nuevos (horario Alfin)

Reloj fijo, misma técnica que los tests actuales:

| Caso | Esperado |
|---|---|
| Domingo a cualquier hora | `dia_cerrado`, sugerencia lunes 09:00 |
| Sábado 18:00 exacto | `ok` (borde inclusivo) |
| Sábado 18:30 | `fuera_de_horario` |
| L-V 19:00 exacto | `ok` |
| L-V 19:30 | `fuera_de_horario` |
| L-V 20:00, cliente pide "hoy" | sugerencia = mañana 09:00, no hoy |
| 28 de julio (feriado) | `feriado`, sugerencia 30 de julio (salta el 29, también feriado) |
| Viernes feriado | sugerencia **sábado** 09:00 (sábado sí atiende) |
| Domingo + lunes feriado | sugerencia martes 09:00 |
| `cierraFeriados: false` + fecha feriado | `ok` (Credicash abre en feriados) |
| Horario con los 7 días en `null` | no cuelga; cae al default con log |
| JSON malformado | usa default, log de warn |

### 7.3 Verificación en vivo (orden importa)

1. Deploy del código con la columna en `NULL` para todos → correr una cita de prueba de Credicash → debe comportarse idéntico.
2. Recién ahí, `UPDATE` de la fila de Alfin.
3. Cita de prueba de Alfin: domingo, feriado, y 20:00 un martes.

---

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| Romper Credicash | Default = comportamiento actual + 14 tests intactos + deploy en dos pasos (código antes que dato) |
| `id_empresa` de Alfin equivocado → se le aplica horario Alfin a otra empresa | Confirmar contra BD; el `UPDATE` es de una fila y reversible con `SET horario_agencia = NULL` |
| Tabla de feriados caída | Fail-open + `{{feriados_proximos}}` sigue en el prompt como segunda red |
| JSON malformado en la columna | `normalizarHorario` degrada a default con warn |
| Config con todos los días cerrados | Tope de 14 iteraciones en `proximoDiaAbierto` |
| Se recorta el prompt antes de que el backend esté listo | El recorte del BLOQUE F es el **último** paso y es independiente; si el backend falla, el prompt intacto sigue validando |

---

## 9. Orden de implementación

Cada paso es desplegable y reversible por separado:

1. ✅ **Migración** — `migrations/20260721_add_horario_agencia_to_empresa.sql`. Efecto: ninguno (todo `NULL`).
2. ✅ **Servicio** — `agendamientoCita.service.js` con horario por día + feriados + `normalizarHorario`; `horarioAgencia.service.js` para la resolución impura. Efecto: ninguno (nadie pasa horario aún).
3. ✅ **Tests** — 15 de regresión sin tocar + 23 nuevos = **38 verdes**.
4. ✅ **Call sites** — `llamada.controller.js` (ambas ramas) + `apiVoz.model.js`. Efecto: ninguno (todas las empresas en `NULL`).
5. ⬜ **Desplegar y verificar Credicash** en vivo.
6. ⬜ **`UPDATE` fila de Alfin** — `migrations/20260721_set_horario_agencia_alfin.sql`. ← acá recién cambia el comportamiento, para una sola empresa.
7. ⬜ **Verificar Alfin** en vivo (domingo, feriado, fuera de horario).
8. ⬜ **Recortar BLOQUE F** del prompt a F.2 + F.5 + obediencia, y quitar el parche de la sugerencia en 4.6.

El paso 8 solo se hace con los pasos 6-7 confirmados en producción.

### Decisión tomada durante la implementación

**Sugerencia para días cerrados: se respeta el día que pidió el cliente.** Si alguien pide el lunes 29 (feriado) estando a martes 23, la alternativa es el martes 30 — no "hoy". Es el mismo criterio que ya aplicaba `sugerenciaMismoDia` para horas fuera de rango en fechas futuras, y evita que el agente conteste algo que contradice la intención del cliente.

**`hora12` no se tocó.** Devuelve "7 de la tarde" para las 19:00 (corta la tarde en 19:59), mientras que la sección 2 del prompt de Alfin dice "7 de la noche". Cambiarla alteraría los mensajes de Credicash, que es justo lo que este diseño promete no hacer. Ambas formas se entienden, y cuando el prompt pase a repetir el mensaje de la tool, la inconsistencia desaparece sola.

---

## 10. Pendientes a confirmar

1. ~~`id_empresa` de Alfin~~ → **confirmado: 40**.
2. ¿El horario L-V 9-19 / Sáb 9-18 sigue vigente? Sale del prompt v1, no de un documento de negocio firmado. Los datos de producción no lo contradicen (ninguna cita de Alfin en domingo, una sola pasada de las 19:00), pero tampoco lo prueban.
3. ¿La anticipación de 1 hora aplica igual para Alfin, o el negocio quiere otra?
4. `Target_efectiva_consumo` (id 73) tiene `api_voz_activo = 1` pero cero tráfico. Cuando arranque, hay que definirle horario o dejarla en el default conscientemente.
5. Las 2 citas fantasma existentes (ids 732 y 729) ya pasaron — no hay nada que corregir en BD, pero conviene avisar a operaciones si alguien las está usando para llamar clientes.
