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
  {
    temporaryTool: {
      modelToolName: "agendar_cita_target",
      description:
        "Registra la cita confirmada por el cliente en la tabla agendamiento_llamada. Llamar SOLO cuando el cliente confirmó explícitamente fecha, hora y tienda. Recibe: tienda (display name hablado al cliente, ej. 'CARSA Ate Porvenir'), agencia (nombre crudo de la sucursal del JSON de buscarSucursal o de la pre-cargada, ej. 'CARSA_ATE PORVENIR' — sirve para cruce con tabla brand), fecha en formato YYYY-MM-DD (ej. '2026-05-09') y hora en formato 24h HH:MM:SS (ej. '15:30:00'). El provider_call_id es el id de la llamada actual.",
      timeout: "5s",
      http: {
        baseUrlPattern: "https://app-api.ai-you.io/api/crm/tools/llamadas/agendarCitaTarget",
        httpMethod: "POST",
      },
      dynamicParameters: [
        {
          name: "provider_call_id",
          location: "PARAMETER_LOCATION_BODY",
          schema: { type: "string", description: "ID de la llamada actual (provider_call_id de la sesión)" },
          required: true,
        },
        {
          name: "tienda",
          location: "PARAMETER_LOCATION_BODY",
          schema: {
            type: "string",
            description:
              "Display name hablado de la tienda donde el cliente acudirá (ej: 'CARSA Ate Porvenir', 'Gallo Más Gallo Villa El Salvador'). Es el nombre tal cual se le dijo al cliente, sin anteponer 'tienda'.",
          },
          required: true,
        },
        {
          name: "agencia",
          location: "PARAMETER_LOCATION_BODY",
          schema: {
            type: "string",
            description:
              "Nombre RAW (crudo) de la sucursal tal cual viene en el JSON de buscarSucursal o en la variable pre-cargada {{tienda_cercana}}. Ejemplos: 'CARSA_ATE PORVENIR', 'GMG_VES', 'MOTO GO_CUSCO', 'MARCIMEX_TRUJILLO'. NO modifiques este valor — pásalo tal cual del backend para que cruce con la tabla de brand.",
          },
          required: true,
        },
        {
          name: "fecha",
          location: "PARAMETER_LOCATION_BODY",
          schema: {
            type: "string",
            description: "Fecha de la cita en formato YYYY-MM-DD (ej: '2026-05-09'). Convierte cualquier expresión natural ('mañana', 'el jueves') a este formato antes de llamar.",
          },
          required: true,
        },
        {
          name: "hora",
          location: "PARAMETER_LOCATION_BODY",
          schema: {
            type: "string",
            description: "Hora de la cita en formato 24h HH:MM:SS (ej: '15:30:00' para 3:30 de la tarde, '09:00:00' para 9 de la mañana). Si solo tienes HH:MM, agrega ':00' al final.",
          },
          required: true,
        },
      ],
    },
  },
];

module.exports = genericaTools;
