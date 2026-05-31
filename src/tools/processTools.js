// Resuelve placeholders en las tools antes de mandarlas a Ultravox.
// Portado de ultravoxapi.service.js (processTools): reemplaza {{id_empresa}} y
// {{provider_call_id}} en staticParameters; opcionalmente reescribe el host
// ai-you.io de baseUrlPattern por un backend dinámico (default: dejar tal cual).
function replaceParams(params, { idEmpresa, providerCallId }) {
  if (!Array.isArray(params)) return params;
  return params.map((p) => {
    if (p?.name === "id_empresa" && p?.value === "{{id_empresa}}") {
      return { ...p, value: parseInt(idEmpresa ?? 0, 10) };
    }
    if (p?.value === "{{provider_call_id}}") {
      return { ...p, value: providerCallId };
    }
    return p;
  });
}

// toolsList: array de tools (ej. require('./generica.js'))
// opts: { idEmpresa, providerCallId, backendUrl }
function processTools(toolsList, { idEmpresa, providerCallId, backendUrl = null } = {}) {
  if (!Array.isArray(toolsList)) return [];

  return toolsList.map((tool) => {
    let updated = tool;

    if (tool.temporaryTool?.staticParameters) {
      updated = {
        ...updated,
        temporaryTool: {
          ...updated.temporaryTool,
          staticParameters: replaceParams(tool.temporaryTool.staticParameters, { idEmpresa, providerCallId }),
        },
      };
    }

    // Reescritura de host solo si se configura backendUrl (single-backend).
    if (backendUrl && updated.temporaryTool?.http?.baseUrlPattern) {
      const original = updated.temporaryTool.http.baseUrlPattern;
      if (original.includes("ai-you.io")) {
        const path = new URL(original).pathname;
        updated = {
          ...updated,
          temporaryTool: {
            ...updated.temporaryTool,
            http: { ...updated.temporaryTool.http, baseUrlPattern: `${backendUrl}${path}` },
          },
        };
      }
    }

    return updated;
  });
}

module.exports = { processTools };
