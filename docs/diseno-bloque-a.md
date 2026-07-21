# Bloque A — mover al código lo que hoy le pedimos al modelo

Diseño. Continuación de `diseno-horario-por-empresa.md`, mismo principio: lo
determinista lo hace el código, el prompt se queda con lo conversacional.

Fecha: 2026-07-21 · Estado: propuesto, sin implementar

---

## 1. Por qué

El prompt de Alfin gasta ~1,000 caracteres enseñándole al modelo a expandir
abreviaturas y a decir números en palabras, y recibe ~4,200 caracteres de
catálogo JSON del que usa cinco entradas. Nada de eso necesita un LLM.

Ya hicimos este movimiento una vez: la aritmética de fechas y horarios salió del
prompt y entró a `validarCita`. Bloque A es el mismo recorte aplicado al texto
que el agente pronuncia y al contexto que recibe.

## 2. Restricción que manda sobre todo el diseño

El gateway es **compartido**. Cuatro empresas tienen `api_voz_activo = 1`:

| Empresa | id | Plantilla activa | Chars |
|---|---|---|---|
| prueba | 2 | varias | — |
| Target_Credicash | 8 | 139 `CREDICASH_PRINCIPAL_COMPACTADO` | 28,810 |
| Target_alfin_banca | 40 | 75 `alfin_banca` | 43,890 |
| Target_efectiva_consumo | 73 | 172 `Efectiva_consumo` | 27,846 |

Las tres plantillas reales consumen las mismas variables de tienda y dirección.
**Cambiar el valor de una variable existente le cambia el habla a las tres.**

Peor: Credicash y Alfin tienen reglas **opuestas** para el mismo dato.

- Alfin (`alfinbanca_v2.txt:25`): *"antepón SIEMPRE agencia con coma antes del nombre"*
- Credicash (plantilla 139): *"dilos tal cual, **sin anteponer** tienda — la marca ya está dentro"*

De ahí las dos reglas de este diseño:

> **R1 — Aditivo, nunca destructivo.** Una variable nueva; las existentes se
> quedan exactamente como están. Es el mismo `NULL` = comportamiento histórico
> que usamos en `empresa.horario_agencia`, aplicado a variables de prompt.
>
> **R2 — Opt-in por plantilla.** El valor se calcula solo si la plantilla lo
> nombra, siguiendo el gate que ya existe en `sesiones.controller.js:79`
> (`if (promptPlantilla.includes("tienda_cercana"))`). Quien no la nombra no
> paga el costo ni nota el cambio.

---

## 3. A1 — recortar `{{tipificaciones}}` a `{id, nombre}`

**El ítem que más pesa, y el único que beneficia a las tres empresas.**

### Situación

`getTipificaciones()` (`agenteVoz.model.js:59`) devuelve 6 columnas por hoja y
`sesiones.controller.js:72` las serializa enteras al prompt. Medido en producción:

| Empresa | Hojas | Hoy | Con `{id, nombre}` | Ahorro |
|---|---|---|---|---|
| Credicash (8) | 27 | 4,213 | 1,638 | −2,575 |
| Alfin (40) | 27 | 4,216 | 1,638 | −2,578 |
| Efectiva (73) | 31 | 4,708 | 1,509 | −3,199 |

El grueso no son los datos: la suma de todos los `nombre` de Alfin es 855 chars.
Lo que pesa son **los nombres de las claves JSON repetidos 27 veces**
(`codigo_homologacion_api_agente` son 30 chars × 27 = 810 por sí solo).

El prompt solo dice *"los ids exactos salen de aquí; manda el id como INTEGER"*.
Verificado: ninguna de las 3 plantillas activas referencia `equivalencia`,
`id_padre`, `nivel` ni `codigo_homologacion_api_agente`.

### Diseño

El array se bifurca en dos consumidores independientes:

```
getTipificaciones(idEmpresa)                    ← 6 campos, sesiones.controller.js:56
   ├─ :72  varsPrompt.tipificaciones → PROMPT           ← A1 toca SOLO esta rama
   └─ :122 store.crear({ tipificaciones }) → sesion.tipificaciones
             ├─ geminiEngine.js:178  capturarTipificacion (camino normal)
             └─ geminiEngine.js:289  respaldo leyendo el id desde BD
                  └─ ambos: cat.codigo_homologacion_api_agente
                       → sesion.tipificacionFinal.codigo_homologacion
                            → webhook (:326, :349) y REST (:244)
```

Ningún camino de homologación lee el prompt. El cambio es una línea:

```js
// El prompt solo necesita elegir un id. Los campos de homologacion viajan
// aparte en sesion.tipificaciones, que es de donde los lee geminiEngine para
// el webhook: si se recortaran ahi, el webhook saldria sin codigo.
varsPrompt.tipificaciones = JSON.stringify(
  (tipificaciones || []).map(({ id, nombre }) => ({ id, nombre }))
);
```

**`.map()` que construye objetos nuevos, jamás `delete` sobre los originales.**
Un `delete t.equivalencia` rompería la homologación de Credicash y Alfin, que
la tienen poblada en las 27 hojas. Ese es el error que el test debe cazar.

---

## 4. A2 — direcciones habladas

### Situación

`sucursales.service.js:79-81` ya lo confiesa:

```js
// El prompt usa {{direccion_limpia}}; la entregamos como alias de la cruda
// (el agente la preprocesa al hablar segun la seccion de pronunciacion).
direccion_limpia: t1.direccion || "",
```

La variable existe pero no limpia nada. El prompt hace el trabajo.

### Lo que dice producción

319 sucursales activas. La tabla de abreviaturas del prompt **no coincide con
los datos**:

| Token | Ocurrencias | ¿En el prompt de Alfin? |
|---|---|---|
| `Av.` | 129 | sí |
| `N°` / `Nro.` | 74 | sí |
| `Jr.` | 68 | sí |
| separadores `-` `/` `:` | 55 | sí |
| `Mz.` | 26 | sí |
| **`CAL.`** | **23** | **no — ni en Alfin ni en Credicash** |
| rangos `524-526` | 22 | no |
| `Lt.` | 20 | sí |
| `Urb.` | 15 | sí |
| paréntesis | 6 | sí |
| `C.C.` | 5 | no |
| `Ca.` | 3 | sí |
| `Cdra.` | 2 | solo Credicash |
| `Esq.`, ordinales `1°`/`1ER` | 2 c/u | no |
| `Tda.`, `Lte.`, basura final | 1 c/u | no |
| **`AA.HH.`** | **0** | sí — regla muerta |
| **`Pj.`** | **0** | sí — regla muerta |

Dos hallazgos: **`CAL.` afecta al 7% de las sucursales y ningún prompt lo
cubre** (hoy el modelo improvisa), y `AA.HH.`/`Pj.` son reglas que ocupan
espacio sin aplicar nunca.

Casos reales que rompen una implementación ingenua:

```
AV. MARIANO IGNACIO PRADO 353 -            → guión colgando al final
Av Carlos Izaguirre 524-526                → rango, no separador
CAL. ATAHUALPA MZ X LOTE 36A1              → CAL. + lote alfanumérico raro
Urb. Santo Domingo Mz. C Lte. 8            → Lte., variante de Lt.
Av. Emancipacion N° 184 - Tda. 104 1° piso → Tda. + ordinal
AV. 28 DE JULIO 271                        → "28" es NOMBRE de vía, no número
```

### Diseño

Nuevo `src/lib/pronunciacionDireccion.js`, función pura `direccionHablada(raw)`:

1. Expandir abreviaturas (tabla ampliada: la del prompt **menos** `AA.HH.` y
   `Pj.`, **más** `CAL.`, `Lte.`, `Tda.`, `C.C.`, `Esq.`, ordinales).
2. Paréntesis fuera, contenido dentro.
3. Separadores `-` `/` `:` → coma. Rangos `524-526` → *"quinientos veinticuatro,
   quinientos veintiséis"* (aceptable). Basura final (`- ` colgando) se recorta.
4. Números a palabras vía `numeroAPalabras` (§5). Alfanuméricos se deletrean:
   `36A1` → *"treinta y seis A uno"*, `F1` → *"F uno"*, `C5` → *"C cinco"*.

**Regla de seguridad: lo que no reconoce, pasa tal cual.** Nunca inventar. Una
dirección mal normalizada es peor que la cruda, porque hoy el modelo al menos
aplica criterio.

Claves **nuevas** en `sucursales.service.js` (R1): `direccion_hablada`,
`tienda_2_direccion_hablada`, `tienda_3_direccion_hablada`. Se agregan también a
`CLAVES_VACIAS`. `direccion_limpia`, `direccion_tienda` y `*_direccion_limpia`
**no se tocan** → Credicash y Efectiva no se enteran.

Alfin cambia `<dirección #1 hablada>` por `{{direccion_hablada}}` y borra el
bloque de reglas (`alfinbanca_v2.txt:24`, ~750 chars).

### Validación

Correr `direccionHablada` sobre las **319 direcciones reales** y revisar la
salida a ojo. Es un set chico y acotado; no hay excusa para validar con
ejemplos inventados.

---

## 5. A3 — montos en palabras

`{{OFERTA_MAX}}` llega como cifra y `alfinbanca_v2.txt:21` enseña a decirla.

Nuevo `src/lib/numeroHablado.js` con `numeroAPalabras(n)` para enteros hasta
millones. Trampas del español a cubrir en tests: `21` → *veintiuno*, `100` →
*cien* pero `101` → *ciento uno*, `500` → *quinientos*, `700` → *setecientos*,
`900` → *novecientos*, `1000` → *mil* (no *un mil*).

Se calcula bajo el gate de R2, solo si la plantilla nombra `oferta_max_hablada`.
Credicash usa `{{OFERTA_CREDICASH}}` — otro nombre, otra variable, intacta.

En el prompt **se queda** la corrección de pares confundibles (*"no son setenta
mil — son sie-te mil"*): eso es reacción a lo que dice el cliente, no formateo.

Ahorro: ~300 chars.

## 6. A4 — horario desde `empresa.horario_agencia`

El gateway tiene `pg` y `src/config/db.js`, así que lo lee directo.

Hoy el horario vive hardcodeado en `alfinbanca_v2.txt:48` **y** en el JSONB que
poblamos en la fase anterior. **Si alguien edita el JSONB, el prompt le miente
al cliente.** Este ítem vale por corrección, no por tamaño (~200 chars).

`horarioHablado(json)` → *"lunes a viernes de 9 de la mañana a 7 de la noche;
sábado de 9 de la mañana a 6 de la tarde; domingo cerrado"*. Con `NULL` devuelve
el texto histórico. Gate R2 sobre `horario_agencia`.

## 7. A5 — quitar `{{feriados_proximos}}`

Sin código. `renderPromptConFeriados` (`prompt.js:98`) hace early-return si el
placeholder no está, así que borrarlo del prompt **también ahorra un fetch HTTP
al CRM por sesión**.

Justificación: `agendar_cita` ya valida feriados y devuelve `sugerencia` — es el
`cierraFeriados: true` de la empresa 40. La "segunda red" que documenté en
`horarioAgencia.service.js:23` sobra ahora que la primera funciona.

## 8. Descartado — prefijo `"agencia, "` al código

Rompería Credicash (regla opuesta, §2). Son ~450 chars y es estilo de habla
genuinamente por cliente. Se queda en el prompt.

---

## 9. Matriz de impacto

| Ítem | Credicash (8) | Alfin (40) | Efectiva (73) | Riesgo |
|---|---|---|---|---|
| A1 tipificaciones | −2,575 | −2,578 | −3,199 | bajo, misma forma para todas |
| A2 direcciones | sin cambio | −750 | sin cambio | nulo (variable nueva) |
| A3 montos | sin cambio | −300 | sin cambio | nulo (variable distinta) |
| A4 horario | sin cambio | −200 | sin cambio | nulo (`NULL` = histórico) |
| A5 feriados | sin cambio | −bloque + 1 HTTP | sin cambio | nulo |

**Total para Alfin: ~4,300 chars menos de prompt renderizado.**

Ojo con la distinción: A1 y A5 no achican `alfinbanca_v2.txt`, achican lo que
Gemini **recibe**, que es lo que paga latencia y lo que hace sobre-analizar al
modelo.

## 10. Tests

Puras, sin BD:

- `numeroAPalabras`: casos frontera del español (§5).
- `direccionHablada`: los 6 casos reales de §4 + las 319 de producción a ojo.
- `horarioHablado`: JSON de Alfin, `NULL`, y JSON malformado.

De no-regresión, el que importa:

- **Tras armar `varsPrompt`, el array original conserva los 6 campos.**
  Afirma que `codigo_homologacion_api_agente` y `equivalencia` siguen presentes
  en todos los elementos. Es el test que impide que alguien "optimice" con un
  `delete` y deje el webhook sin código.
- `cargarTiendas` sigue devolviendo `direccion_limpia` idéntica a la cruda.

## 11. Orden de despliegue

Dos fases, igual que con el horario:

1. Código + tests → deploy.
2. Verificar en vivo que Credicash sigue hablando igual (A1 le cambia el prompt:
   es la única empresa además de Alfin con tráfico real).
3. Recién ahí subir el prompt recortado de Alfin a la plantilla 75.

**Nota:** la plantilla 75 sigue en 43,890 chars, actualizada el 2026-06-25 — es
la v1. Los 28,572 del Bloque B están en git pero **no en producción**. Hasta que
se suban, Alfin corre el prompt viejo y nada de esto tiene efecto.

## 12. Riesgos

| Riesgo | Mitigación |
|---|---|
| Normalizar mal una dirección y que suene peor que hoy | Pass-through de lo no reconocido + revisar las 319 |
| Romper la homologación al recortar | Test de no-regresión (§10); `.map()` nunca `delete` |
| A1 cambia el prompt de Credicash | Es un subconjunto estricto; verificado que no usa esos campos |
| Efectiva arranca a mitad del cambio | Hoy tiene cero tráfico; su horario sigue en `NULL` |

## 13. Hallazgo colateral, fuera de alcance

**Efectiva (73) tiene `codigo_homologacion_api_agente` NULL en sus 31 hojas.**
`geminiEngine.js:182` hace `cat?.codigo_homologacion_api_agente ?? null`, así que
cuando le abran tráfico **todas sus tipificaciones llegarán al webhook sin
código**. Es un problema de datos, previo a este diseño, y A1 ni lo causa ni lo
arregla. Requiere decisión de negocio: poblar el catálogo o aceptar el `null`.
