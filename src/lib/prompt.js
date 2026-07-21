// Inyecta las variables de la sesion en el prompt de la plantilla.
// Soporta {{nombre_campo}} y {nombre_campo}.
//
// Ademas precarga placeholders reservados de fecha/hora (zona Peru, America/Lima,
// es-PE), igual que aiyou-voice-backend ultravoxapi.service.js:189-211:
//   {{fecha_hoy}}, {{hora_actual}} (HH:MM 24h), {{dia_semana}}, {{fecha_manana}}
//
// {{feriados_proximos}} NO se computa aqui: requiere fetch async al CRM
// (ver feriados.service.js); se inyecta con renderPromptConFeriados.
//
// 🚨 DOS NOTACIONES, NO UNA (leccion de produccion):
//   {{variable}}  -> la sustituye el gateway. Si no hay valor, renderPrompt DEJA
//                    el {{...}} literal y el modelo se lo lee al cliente
//                    ("Que tenga buenas tardes, nombre corto"). Por eso existe
//                    variablesSinResolver(): que se vea en el log, no al aire.
//   <slot>        -> lo calcula el AGENTE en runtime (la hora que sugiere, el
//                    dia de la semana hablado, la tienda que eligio el cliente).
//                    NO son variables: el gateway no las toca. Van sin llaves
//                    justamente para que el modelo no las confunda con las de
//                    arriba — que es lo que pasaba cuando se escribian {{asi}}.
//
// Cuidado: el regex de abajo tambien matchea llave simple {variable}, asi que
// tampoco sirve como notacion de slot.

const { getFeriadosTextoPrompt } = require("../services/feriados.service.js");

const TZ = "America/Lima";
const LOCALE = "es-PE";

function fmtFechaLarga(d) {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

function diaSemanaLima(d) {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, weekday: "long" })
    .format(d)
    .toLowerCase();
}

// El saludo de despedida depende SOLO de la hora: es determinista, no hay razon
// para que lo derive el modelo (era un slot mas que le llegaba como {{...}}).
function saludoPorHora(hora24) {
  const h = Number(String(hora24).slice(0, 2));
  if (h >= 6 && h < 12) return "Que tenga buen día";
  if (h >= 12 && h < 19) return "Que tenga buenas tardes";
  return "Que tenga buenas noches";
}

function fechasLima() {
  const ahora = new Date();
  const manana = new Date(ahora.getTime() + 24 * 60 * 60 * 1000);
  const hora24 = new Intl.DateTimeFormat(LOCALE, {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ahora);
  return {
    fecha_hoy: fmtFechaLarga(ahora),
    hora_actual: hora24,
    dia_semana: diaSemanaLima(ahora),
    fecha_manana: fmtFechaLarga(manana),
    saludo_horario: saludoPorHora(hora24),
  };
}

// Catalogo de tipificaciones recortado a lo que el MODELO necesita para elegir.
// equivalencia y codigo_homologacion_api_agente NO los lee el prompt: los lee
// geminiEngine desde sesion.tipificaciones para armar el webhook.
//
// El peso no eran los datos sino los NOMBRES DE LAS CLAVES repetidos una vez por
// hoja: la suma de todos los `nombre` de Alfin son 855 chars, pero el JSON
// entero pesaba 3731 ("codigo_homologacion_api_agente" solo son 30 x 27 = 810).
//
// id_padre SE CONSERVA aunque el prompt no lo mencione. El catalogo de Alfin
// tiene 9 hojas con nombre repetido que solo se distinguen por su rama
// ("SOLICITO NO SER CONTACTADO" es 598 y 599; "EXPRESO QUE NO AUTORIZO USO DE
// DATOS" es 590, 600 y 603). Sin id_padre el modelo ve entradas identicas y
// elige al azar justo en la familia de "no me contacten". Cuesta ~350 chars de
// los ~2250 que ahorra el recorte; se puede quitar cuando el prompt hardcodee
// los ids de sus salidas terminales, como ya hace el de Credicash.
//
// Devuelve objetos NUEVOS a proposito. Si en vez del map se recortara el
// catalogo en sitio (un delete, un reasignar), sesion.tipificaciones perderia
// codigo_homologacion_api_agente y el webhook saldria sin codigo para las
// empresas que lo tienen poblado. Ver tipificacionesPrompt.test.js.
function tipificacionesParaPrompt(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.map(({ id, nombre, id_padre }) => ({ id, nombre, id_padre }));
}

// Placeholders que quedaron SIN resolver tras el render. renderPrompt deja el
// {{...}} literal cuando no hay valor, y el modelo termina pronunciandolo al
// cliente ("Que tenga buenas tardes, nombre corto"). Esto lo hace visible en el
// log en vez de que se descubra en una llamada real.
function variablesSinResolver(prompt) {
  if (!prompt) return [];
  const encontradas = new Set();
  for (const m of prompt.matchAll(/\{\{?\s*([\w.]+)\s*\}?\}/g)) encontradas.add(m[1]);
  return [...encontradas];
}

function renderPrompt(prompt, variables = {}) {
  if (!prompt) return "";
  // Las fechas computadas mandan sobre las del integrador (claves reservadas).
  const todas = { ...variables, ...fechasLima() };
  return prompt.replace(/\{\{?\s*([\w.]+)\s*\}?\}/g, (match, clave) => {
    const v = todas[clave];
    return v === undefined || v === null ? match : String(v);
  });
}

// Igual que renderPrompt pero ademas inyecta {{feriados_proximos}} (fetch async al CRM).
// Best-effort: si el CRM falla, deja el bloque vacio en vez de romper la llamada.
async function renderPromptConFeriados(prompt, variables = {}) {
  const resultado = renderPrompt(prompt, variables);
  if (!resultado.includes("{{feriados_proximos}}")) return resultado;
  let texto = "";
  try {
    texto = await getFeriadosTextoPrompt();
  } catch (e) {
    texto = "";
  }
  return resultado.replace(/\{\{\s*feriados_proximos\s*\}\}/g, texto);
}

module.exports = {
  renderPrompt,
  renderPromptConFeriados,
  fechasLima,
  variablesSinResolver,
  saludoPorHora,
  tipificacionesParaPrompt,
};
