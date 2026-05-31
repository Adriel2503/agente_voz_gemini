// Tool genérica portada del voice-backend (aiyou/aiyou-voice-backend/src/tools/generica.js).
// CommonJS. Los placeholders {{id_empresa}} y {{provider_call_id}} los resuelve processTools.
const genericaTools = [
  {
    toolName: "queryCorpus",
    parameterOverrides: {
      corpus_id: "0d68b754-32d0-4c9d-966c-0e17aaeab8e5",
      max_results: 3,
    },
  },
  {
    temporaryTool: {
      modelToolName: "obtenerPlanesDisponibles",
      description: "Obtiene los planes disponibles",
      timeout: "5s",
      http: {
        baseUrlPattern: "https://app-api.ai-you.io/api/crm/tools/catalogo",
        httpMethod: "GET",
      },
    },
  },
  {
    temporaryTool: {
      modelToolName: "tipificarLlamada",
      description: "Cambia la tipificacion de la persona con un id",
      http: {
        baseUrlPattern: "https://app-api.ai-you.io/api/crm/tools/llamadas/nuevaTipificacion",
        httpMethod: "PUT",
      },
      dynamicParameters: [
        {
          name: "id_tipificacion_llamada",
          location: "PARAMETER_LOCATION_BODY",
          schema: { type: "integer", description: "ID de la tificación correspondiente a registrar a la persona" },
          required: true,
        },
        {
          name: "provider_call_id",
          location: "PARAMETER_LOCATION_BODY",
          schema: { type: "integer", description: "ID de la llamada a tipificar" },
          required: true,
        },
      ],
    },
  },
  {
    temporaryTool: {
      modelToolName: "buscarSucursal",
      description:
        "Devuelve las N sucursales más cercanas al cliente, ordenadas por distancia geodésica real (Haversine sobre lat/lon). Departamento, provincia y distrito son OBLIGATORIOS. Si el cliente no te dio alguno de los 3, pregúntale ANTES de llamar la tool — no llames con campos vacíos. Tolera typos (ej: 'comaz' matchea 'Comas'). Si nada matchea, devuelve un mensaje pidiendo verificación. Default 3 sucursales, configurable con 'numero' (1-10).",
      timeout: "5s",
      http: {
        baseUrlPattern: "https://app-api.ai-you.io/api/crm/tools/llamadas/buscarSucursal",
        httpMethod: "POST",
      },
      staticParameters: [
        { name: "id_empresa", location: "PARAMETER_LOCATION_BODY", value: "{{id_empresa}}" },
      ],
      dynamicParameters: [
        {
          name: "termino",
          location: "PARAMETER_LOCATION_BODY",
          schema: {
            type: "string",
            description:
              "Ubicación del cliente en formato 'departamento-provincia-distrito' (ej: 'lima-lima-comas'). Los 3 niveles son OBLIGATORIOS — si falta alguno, pregúntale al cliente antes de llamar.",
          },
          required: true,
        },
        {
          name: "numero",
          location: "PARAMETER_LOCATION_BODY",
          schema: { type: "integer", description: "Cantidad de sucursales a devolver. Opcional, default 3. Rango: 1-10." },
          required: false,
        },
      ],
    },
  },
  {
    temporaryTool: {
      modelToolName: "obtenerFechaHora",
      description:
        "Obtiene la fecha y hora actual del país objetivo. El input es el nombre del país (ej: 'Peru') o su código ISO de 2 letras (ej: 'PE').",
      timeout: "5s",
      http: {
        baseUrlPattern: "https://app-api.ai-you.io/api/crm/tools/utilidades/fechaHora",
        httpMethod: "POST",
      },
      dynamicParameters: [
        {
          name: "pais",
          location: "PARAMETER_LOCATION_BODY",
          schema: { type: "string", description: "Nombre del país objetivo o código ISO de 2 letras." },
          required: true,
        },
      ],
    },
  },
];

module.exports = genericaTools;
