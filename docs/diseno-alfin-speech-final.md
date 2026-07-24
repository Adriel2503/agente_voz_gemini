# Alfin — alineación con `Speech Alfin final.md` (jul 2026)

Diseño del reemplazo. Reemplaza la referencia de `Speech Alfin.md` (rev. anterior)
por `Speech Alfin final.md`, que el cliente confirmó como la versión vigente.

Fuente: `docs/Speech Alfin final.md`. Fecha: 2026-07-24.
Estado: DISEÑADO, pendiente de implementar.

---

## 1. Principio de orden

Los ocho cambios se implementan de menor a mayor riesgo. Los primeros cinco son
ajustes de texto o de estructura menor, reversibles sin tocar reglas de negocio.
Los últimos tres **revierten decisiones que tomamos esta semana a partir de
correcciones tuyas** (la hora abierta, el cierre unificado, el SMS) — van al
final para que cada uno se apruebe con el contexto de qué se está deshaciendo.

## 2. Los ocho cambios, en orden

### D1 — Vocabulario: sin "excelente", sin nombrar el banco en el pitch

**Hoy** (4.1, puerta 2): *"informarle de un **excelente** beneficio"*.
**Speech final:** *"informarle sobre un beneficio"* — sin adjetivo.

**Hoy** (4.3): la presentación nombra *"crédito preaprobado"* pero no dice
"Banco Alfin" explícitamente en el cuerpo — esto ya está bien. Verificar que
4.7 tampoco lo repita de más.

Cambio: quitar "excelente" de la puerta 2. Sin impacto estructural.

### D2 — Quitar "libre disponibilidad", "evaluación al toque", "36 meses" del pitch

Ninguna de las dos versiones del Speech (ni la vieja ni la final) las trae —
las agregamos nosotros en la alineación anterior. El Speech final es aún más
austero que el viejo. Se recortan de 4.3 y, si corresponde, de 4.7.

### D3 — Separar "¿información detallada?" de la pregunta de franja

**Hoy** (4.3): una sola frase fusiona *"¿le agradaría info detallada?"* +
*"¿mañana o tarde?"* en el mismo turno — optimización que hicimos para ir "al
grano".
**Speech final:** son dos gates separados, con su propio camino de
aceptación/rechazo cada uno:
1. Presentación → *"¿le gustaría conocer más detalle?"* → sí/no
2. Solo si sí → urgencia de 4 días + *"¿hoy o mañana?"* + hora

Esto **agrega un turno** a cambio de fidelidad al guion del cliente. 4.3 se
divide en dos frases con su propio guardrail de clasificación cada una.

### D4 — Día: "hoy o mañana" explícito, no solo anclar en mañana

**Hoy** (4.5): ancla siempre en MAÑANA; “hoy” se acepta solo si el cliente lo
pide espontáneamente.
**Speech final:** ofrece los dos de entrada: *"¿hoy o mañana?"*.

Cambia el guion de 4.3/4.5: la pregunta de día dejará de anclar y pasa a
alternativa cerrada de dos opciones, consistente con el estilo "closer"
(alternativa cerrada, no pregunta abierta).

### D5 — Los 4 días como vigencia de campaña, dichos siempre (no solo en objeción)

**Hoy**: "4 días hábiles para desembolsar" (versión del correo), mencionados
solo si el cliente propone un día posterior o pone la objeción "ahora no".
**Speech final:** *"Su crédito preaprobado estará vigente solo por 4 días"* —
framing de vigencia, dicho **proactivamente** en el turno de fecha/hora, para
todo cliente, no solo el que dilata.

Esto resuelve a favor de "vigencia" el TBD abierto entre correo y Speech.
Recomendación: preguntarle al cliente si esto reemplaza definitivamente la
lectura del correo, o si ambas conviven (desembolso E, vigencia F). Mientras
tanto se implementa como dice el documento más reciente.

### D6 — Puerta 1 negativa: finalizar directo

**Hoy** (4.0): rama adicional — *"¿en qué horario puedo ubicar al titular?"*
antes de cerrar con Tercero.
**Speech final:** *"Finalizar la llamada"*, sin rama intermedia.

Se simplifica 4.0: se quita la pregunta de horario de contacto, cierre directo.
Nota: esto reduce dato útil para el cliente (no sabremos cuándo recontactar),
pero es lo que pide el documento. Marcar como downgrade deliberado si se
implementa tal cual.

### D7 — Cierre único para toda llamada

**Hoy**: dos despedidas distintas — con cita (cálida, sin tipificar) / sin cita
(corta, tipifica antes).
**Speech final:** una sola frase para ambos casos: *"Muchas gracias por su
tiempo. Que tenga un excelente día."*

Cambio estructural: se **unifica** el cierre. El agendamiento y la
tipificación (mecánica interna, tools) no cambian — solo la frase hablada final
pasa a ser una sola, independiente del resultado. Riesgo: perder el tono
cálido diferenciado post-cita que el propio cliente pidió ("cerradora, cálida")
en la ronda anterior. Se marca para confirmación antes de aplicar tal cual.

### D8 — La hora deja de proponerse, se pregunta abierta 🔴

**Hoy** (4.5, regla explícita): *"Elegida la franja no preguntes la hora:
proponla ya dentro de la confirmación de 4.6. Nunca '¿a qué hora le queda
mejor?'"*.
**Speech final:** *"¿En qué horario le resulta más conveniente?"* — pregunta
abierta.

**Este es el cambio de mayor riesgo.** Revierte una regla que se corrigió
explícitamente a pedido del cliente/usuario esta misma semana (evitar que Lili
pregunte la hora en vez de proponerla, para sonar más "cerradora"). Antes de
tocar 4.5/4.6:

- Si se implementa tal cual, 4.6 deja de proponer *"¿le agendo a las cuatro de
  la tarde?"* y pasa a preguntar *"¿en qué horario?"* abierto, y luego confirma
  lo que diga el cliente.
- Esto es **compatible** con el resto de la arquitectura (agendar_cita sigue
  validando), pero contradice el ángulo "cerradora, sin rodeos" que se pidió
  reforzar en la ronda anterior — una pregunta abierta agrega fricción y un
  turno más de negociación de horario.

**Recomendación:** confirmar explícitamente con el cliente si esto es
intencional (volver a pregunta abierta) o si el documento simplemente no
detalla la mecánica fina y el "closer" sigue aplicando debajo. Implementar solo
tras esa confirmación, dado que es un revert de una corrección reciente.

## 3. Balance de riesgo

| # | Cambio | Tipo | Reversión de qué |
|---|---|---|---|
| D1 | Sin "excelente" | Texto | — |
| D2 | Sin relleno de pitch | Texto | Nuestra alineación anterior |
| D3 | Separar gate de info | Estructural, +1 turno | Fusión "ir al grano" |
| D4 | Hoy o mañana explícito | Estructural | Ancla en mañana |
| D5 | 4 días como vigencia, proactivo | Estructural | Framing del correo (desembolso) |
| D6 | Puerta 1 sin rama de horario | Simplificación | Rama agregada en C1 |
| D7 | Cierre único | Estructural | Separación con/sin cita |
| D8 | Hora abierta | 🔴 Conductual | Regla explícita de 4.5, corregida a pedido reciente |

## 4. Pendiente de confirmación antes de implementar D5, D7, D8

Los tres tocan decisiones ya validadas con el usuario. Se implementan en ese
orden (D1→D8) pero D5, D7 y D8 requieren luz verde explícita — en particular
D8, que es un revert directo de una corrección de esta semana.
