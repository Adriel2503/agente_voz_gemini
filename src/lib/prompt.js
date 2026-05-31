// Inyecta las variables de la sesion en el prompt de la plantilla.
// TODO: confirmar la sintaxis real de placeholders que usa app-api (prompt_resultado).
// Por ahora soporta {{nombre_campo}} y {nombre_campo}.
function renderPrompt(prompt, variables = {}) {
  if (!prompt) return "";
  return prompt.replace(/\{\{?\s*([\w.]+)\s*\}?\}/g, (match, clave) => {
    const v = variables[clave];
    return v === undefined || v === null ? match : String(v);
  });
}

module.exports = { renderPrompt };
