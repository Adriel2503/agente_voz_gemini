# Alfin — requisitos del cliente (jul 2026): cambios de prompt

Diseño de los puntos 1 a 5, todos prompt puro. Los puntos 6 a 8 (filtro de
tools, apellido, agencia asignada) quedan fuera: son código o dato del cliente.

Fuentes: correo del cliente + `Speech Alfin.md` (rev. jul 2026).
Fecha: 2026-07-21 · Estado: IMPLEMENTADO (C1-C5). Ver §7 para el resultado real.

---

## 1. Principio

El pedido del cliente **restringe** el flujo: valida antes de hablar, no ofrezcas
nada antes del consentimiento, y una sola agencia. Casi todo se implementa
**borrando**, no agregando. El único agregado real es un turno de validación de
identidad, y se paga reutilizando el clasificador que ya existe en 4.2 en vez de
escribir uno nuevo.

Balance estimado: **−1,150 caracteres**.

## 2. Los cinco cambios

### C1 — Validación de titular como paso previo

**Hoy** (`4.1:99`) el prompt dice exactamente lo contrario a lo pedido:

> *"Asume que hablas con el titular (el sistema confía en el CRM); recién si lo
> niega aplica la regla de 4.0."*

**Requisito:** *"el BOT debe validar que está hablando con el titular antes de
continuar con la conversación"*. El Speech lo separa en dos turnos.

**Diseño — dos puertas, un solo clasificador:**

```
PUERTA 1 (identidad)      "Le saluda Lili, ¿me comunico con {{nombre}}?"
                          sí → PUERTA 2
                          no → Tercero (regla ya existente en 4.0)
                          ambigua → repregunta de consideración

PUERTA 2 (autorización)   "¿Me permite un minuto de su tiempo para informarle
                           de un beneficio que tenemos para usted?"
                          sí → 4.3
                          no → 4.8, sin objeciones
                          ambigua → repregunta de consideración
```

La tabla de 4.2 (SÍ / negación / pregunta / ambigua) pasa a ser **el clasificador
de ambas puertas**, no de una. Eso evita duplicar ~600 caracteres de casuística.

Se usa `{{nombre}}` (nombre completo tal como viene) y no `{{nombre_corto}}`,
porque la pregunta es de identificación.

**Costo real:** +1 turno en toda llamada. Ver riesgos (§4).

### C2 — Ninguna oferta comercial antes del consentimiento

**Hoy**, antes de cualquier sí, el prompt dice:

- `4.1:97` — *"te estoy llamando por un **CRÉDITO PRE APROBADO**"*
- `4.2:114` — *"— **tiene un crédito preaprobado a su nombre**"* (Salidas A/B/C)
- `5` — el guardrail **autoriza explícitamente** decir *"crédito preaprobado a su
  nombre"* antes del SÍ

**Requisito:** *"no debe realizarse ninguna oferta comercial antes de que el
cliente otorgue su consentimiento"* (Ley de Protección de Datos Personales).

Afirmarle a alguien que tiene un crédito preaprobado **es la oferta**. El Speech
usa una fórmula deliberadamente vaga: *"un excelente beneficio que tenemos para
ustedes"*.

**Diseño:**

- El saludo pierde "crédito pre aprobado" y queda en la puerta de identidad.
- La puerta 2 pide autorización en genérico: *"un beneficio"* / *"un producto
  financiero"*. Nunca "preaprobado", nunca un monto.
- Las Salidas A/B/C dejan de afirmar que tiene un crédito. Pasan a describir la
  llamada, no el producto.
- **El guardrail de la sección 5 se invierte**: lo único decible antes del SÍ es
  el nombre (Lili), el rol genérico (*"asesora financiera"*) y que se trata de
  *"un beneficio"*. Queda prohibido "preaprobado", "crédito", monto, cuotas,
  tasa, agencia y "Banco Alfin".

Nota: decir el nombre del cliente en la puerta 1 no es oferta comercial — es la
validación de identidad que el propio cliente exige.

### C3 — Una sola agencia

**Requisito:** *"El desembolso solo podrá efectuarse en la agencia asignada en la
base de datos, por lo que no será posible realizarlo en una agencia distinta."*

**Hoy el prompt hace exactamente lo contrario.** Se elimina:

| Qué | Dónde | Chars |
|---|---|---|
| CASO B completo (ofrecer #2 y #3, elegir, buscar otra zona) | `4.4:144-147` | ~700 |
| Agencias #2 y #3 de la sesión | `2:45-46` | ~250 |
| Spec de `buscarSucursal` | `3:76` | ~350 |
| Respuesta "¿hay agencia en otra zona?" | `4.7` | ~100 |
| "Banco Alfin tiene agencias en todo el país: si el cliente pide otra zona, se la buscas" | `4.4:137` | ~90 |

**Diseño del nuevo 4.4:** se ofrece la agencia y punto. Si el cliente la
rechaza, **no se busca otra**: se le explica que su crédito está habilitado solo
en esa agencia y se le pregunta si aun así quiere la cita. Si insiste en otra →
**No Interesado**.

`buscarSucursal` sigue declarada en el motor (el set de tools es global, ver §5),
así que en lugar de su spec queda **una línea que prohíbe usarla** — más barato
que documentarla y más claro que omitirla.

CASO A y CASO D no cambian.

### C4 — Los 4 días hábiles

Resuelve el TBD que estaba marcado en `4.8`. **Ojo: los dos documentos dicen
cosas distintas.**

- Speech: *"su campaña solo está vigente 4 días"* → vigencia de campaña
- Correo: *"4 días **hábiles** para realizar el desembolso de su crédito"* →
  ventana de desembolso

Se toma **la del correo** por ser posterior y más específica. Entra como cierre
de urgencia en la objeción "Llámame después" y en la confirmación final de 4.6.
Pendiente de confirmar con el cliente.

### C5 — Corregir la justificación de tasa y cuota

**Hoy** `2:39` y `4.7` afirman: *"La sesión NO trae tasa ni cuota mensual"*.
**Es falso.** Las sesiones reales de Alfin traen ambos poblados:

```
nombre: EVA SANDRA   OFERTA_MAX: 6200    PLAZO: 36   CUOTA: 368.35   Tasa_1: 74
nombre: MERCEDES     OFERTA_MAX: 11400   PLAZO: 36   CUOTA: 642.48   Tasa_1: 69
```

No se propone empezar a decirlos — una tasa de 74% por teléfono mata la llamada,
y es decisión de Alfin. Lo que cambia es **el motivo**: pasa de "no lo tenemos"
(mentira) a "no se cotiza por teléfono, se valida en agencia" (política). Un
prompt que miente sobre sus propios datos es un prompt que el modelo puede
contradecir si algún día esos campos entran al contexto.

## 3. Balance de tamaño

| Cambio | Δ |
|---|---|
| C1 puerta de identidad (reusando el clasificador) | +100 |
| C2 saludo y A/B/C en genérico | ~0 |
| C3 eliminar CASO B, agencias #2/#3, spec de buscarSucursal, 4.7 | **−1,400** |
| C4 los 4 días hábiles | +150 |
| C5 reescribir la justificación | ~0 |
| **Neto** | **≈ −1,150** |

De 28,572 a ~27,400.

## 4. Riesgos

| Riesgo | Mitigación |
|---|---|
| **+1 turno en toda llamada** sube el abandono antes de la oferta | Puerta 1 corta y sin fricción; la ambigua asume sí vía repregunta, no corta |
| El modelo llama `buscarSucursal` igual porque sigue declarada | Prohibición explícita en §3. Garantía real = punto 6 (código) |
| La agencia que mostramos es "la más cercana", no "la asignada" | **Abierto** — ver §6 |
| Sin "preaprobado" el gancho de apertura pierde fuerza | Es exigencia regulatoria, no negociable. Se compensa en 4.3, ya con consentimiento |

## 5. Lo que NO entra en este diseño

- **Punto 6 — filtro de tools por empresa.** `genericaTools` es un set único
  global cableado en `sesiones.controller.js:106`. Sacar `buscarSucursal` solo
  para Alfin es código y necesita deploy. El prompt cubre el 95% del riesgo;
  esto es endurecimiento.
- **Punto 7 — `apellido`.** No existe en el formato ni en ninguna sesión: el
  campo `nombre` trae solo nombres de pila (*"EVA SANDRA"*, *"MERCEDES"*). El
  Speech pide *"Sr. (Apellido del cliente)"* — **imposible hoy**. El TBD del
  prompt se actualiza para reflejar el hallazgo en vez de quedar abierto.
- **Punto 8 — agencia asignada.** Ninguno de los 46 campos del formato es
  agencia, sucursal ni oficina. Lo que mostramos lo calcula `cargarTiendas`
  buscando la más cercana al distrito. Si Alfin asigna agencia por cliente, no
  nos la está mandando.

## 6. Preguntas abiertas para el cliente

1. **Agencia:** ¿hay una agencia asignada por cliente en su base, o vale la más
   cercana y solo hay que dejar de ofrecer alternativas? Si es lo primero,
   necesitamos **nombre + dirección + nombre RAW** en el payload; con solo el
   nombre hace falta código para resolver la dirección.
2. **Apellido:** ¿lo agregan al payload, o se usa el nombre de pila?
3. **Los 4 días:** ¿hábiles para desembolsar (correo) o vigencia de campaña
   (Speech)?
4. **SMS con la dirección** (TBD previo, reconfirmado en el Speech): no existe
   tool de SMS. ¿Se implementa o se descarta de la promesa?


---

## 7. Resultado real

Implementado. **28,572 → 28,028 (−544)**, no los −1,150 estimados. La diferencia:
las podas salieron como se diseñaron (−1,279), pero lo que se agregó pesó más de
lo previsto — 4.1 creció +556 contra los +100 estimados, y el primer intento
metió un guardrail "Una sola agencia" en la sección 5 cuando esa regla ya vivía
en 2, 3, 4.4 y 4.7. Seis lugares para lo mismo: se eliminó.

### El Speech reordenó el flujo, y eso ahorró más que el recorte

Hallazgo al implementar: **en el Speech no existe un paso separado de "ofrecer
agencia"**. La agencia y su dirección van dentro de la presentación, y el paso
siguiente salta directo a la cita. Nuestro 4.4 era un paso inventado.

- 4.3 absorbe agencia + dirección + "DNI vigente", y cierra con la pregunta del
  Speech (*"¿Le agradaría recibir información detallada de su crédito?"*).
- 4.4 dejó de ser un paso del flujo: es "solo si el cliente pide otra". Perdió la
  Regla de oro, el Ofrecimiento y el CASO A entero.
- 4.5 abre con la alternativa cerrada del Speech (*"¿mañana — mañana o tarde?"*)
  en vez de una pregunta abierta de hora.

Seguir el documento salió más barato que nuestra versión previa.

### Decisiones cerradas con el cliente

| Punto | Resolución |
|---|---|
| Dirección en la presentación | **Sí**, como el Speech |
| Cierre *"¿información detallada?"* | **Sí**, como el Speech. Con salvaguarda: ese sí NO es pedido de envío, no hay canal |
| Franja mañana/tarde | **Sí**, como el Speech |
| Ancla del día | **Mañana**, como el Speech. Si el cliente pide hoy, se acepta |
| *"S/ 18,000"* | **Es un ejemplo del Speech.** Rige `{{OFERTA_MAX}}` del payload |

Evidencia del último punto: de 12 sesiones reales de Alfin, mínimo S/ 100,
promedio S/ 4,550, máximo S/ 11,400. **Ningún cliente tiene 18,000 ni más.**
Además `OFERTA_MAX` es campo obligatorio del formato: no se mandaría por cliente
si la idea fuera decir el mismo número a todos.

### Bug corregido de paso

La regla de qué hora proponer calculaba *"al menos una hora después de
{{hora_actual}}"* aunque la cita fuera para otro día. Ahora esa condición aplica
solo cuando la cita es para hoy.

### Sigue bloqueado

- **`Sr. + apellido`** — la base solo trae nombres de pila.
- **SMS con la dirección** — no existe la tool. El prompt no lo promete.
