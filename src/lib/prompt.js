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
// OJO: {{hora_sugerida_12h}} y {{proximo_dia_habil_hablado}} NO se pre-computan.
// En la plantilla LILI son SLOTS que el agente calcula en runtime y de forma
// contextual (la hora sugerida = hora_actual+1h redondeada y validada contra el
// cierre; el proximo dia habil depende de la fecha que pidio el cliente). Pre-
// rellenarlos con un valor fijo al inicio daria una hora/fecha equivocada.

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
  };
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

module.exports = { renderPrompt, renderPromptConFeriados, fechasLima };
