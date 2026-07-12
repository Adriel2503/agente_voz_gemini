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

module.exports = { renderPrompt, renderPromptConFeriados, fechasLima, variablesSinResolver, saludoPorHora };
