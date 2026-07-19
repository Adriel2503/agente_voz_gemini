// Tool genérica portada del voice-backend (aiyou/aiyou-voice-backend/src/tools/generica.js).
// CommonJS. Los placeholders {{id_empresa}} y {{provider_call_id}} los resuelve processTools.
//
// NOTA: `queryCorpus` se retiró. Era un built-in de Ultravox (RAG) sin
// `temporaryTool`, o sea sin endpoint HTTP: con Gemini se omitía en cada sesion
// (log "tool sin equivalente HTTP omitida") y nunca llegaba al modelo. Ninguna
// plantilla de las empresas con api_voz activo la usaba. Si se vuelve a
// ENGINE=ultravox y se necesita RAG, restaurar la entrada con su corpus_id.
//
// NOTA: `obtenerPlanesDisponibles` se retiró. Venía copiada de la tool de Bitel
// (tmp-server-mapping/tools/bitel.js) y apuntaba a GET /api/crm/tools/catalogo,
// ruta que NO existe en app-api: el catálogo se monta como /api/crm/catalogo
// detrás de authMiddleware, y saca el id_empresa del JWT (que las tools de voz
// no tienen). Devolvía 404 en todas las llamadas, con ambos motores.
const genericaTools = [
  {
    temporaryTool: {
      modelToolName: "tipificarLlamada",
      description: "Cambia la tipificacion de la persona con un id",
      http: {
        baseUrlPattern: "https://app-api.ai-you.io/api/crm/tools/llamadas/nuevaTipificacion",
        httpMethod: "PUT",
      },
      staticParameters: [
        { name: "session_id", location: "PARAMETER_LOCATION_BODY", value: "{{session_id}}" },
      ],
      dynamicParameters: [
        {
          name: "id_tipificacion_llamada",
          location: "PARAMETER_LOCATION_BODY",
          schema: { type: "integer", description: "ID de la tificación correspondiente a registrar a la persona" },
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
      modelToolName: "agendar_cita",
      description:
        "Registra la cita confirmada por el cliente. Llamar SOLO cuando el cliente confirmó explícitamente fecha, hora y tienda. Recibe: tienda (display name hablado al cliente, ej. 'CARSA Ate Porvenir'), agencia (nombre crudo de la sucursal del JSON de buscarSucursal o de la pre-cargada, ej. 'CARSA_ATE PORVENIR' — sirve para cruce con tabla brand), fecha en formato YYYY-MM-DD (ej. '2026-05-09') y hora en formato 24h HH:MM:SS (ej. '15:30:00'). El sistema valida horario de tienda y que la hora no haya pasado: si responde ok:false, la cita NO quedó registrada — dile al cliente el 'mensaje' y ofrécele la 'sugerencia' {fecha, hora}. La cita existe únicamente si respondió ok:true.",
      timeout: "5s",
      http: {
        baseUrlPattern: "https://app-api.ai-you.io/api/crm/tools/llamadas/agendarCita",
        httpMethod: "POST",
      },
      staticParameters: [
        { name: "session_id", location: "PARAMETER_LOCATION_BODY", value: "{{session_id}}" },
      ],
      dynamicParameters: [
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
