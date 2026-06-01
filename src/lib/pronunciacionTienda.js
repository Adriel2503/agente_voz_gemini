// Pronunciacion de tiendas. Portado de
// aiyou-voice-backend/src/config/pronunciacion-tienda.js (CommonJS).
//
// El nombre crudo de BD (sucursal.nombre) tiene formato "MARCA_ZONA"
// (ej. "CARSA_ATE PORVENIR", "GMG_VES"). Para que el TTS lo diga natural se
// transforma a "CARSA Ate Porvenir" / "Gallo Mas Gallo Villa El Salvador".

const PRONUNCIACION_MARCA = {
  CARSA: "CARSA",
  "CARSA MOTOS": "CARSA Motos",
  "CARSA EXPRESS": "CARSA Express",
  "CARSA MOTOS EXPRESS": "CARSA Motos Express",
  GMG: "Gallo Más Gallo",
  MARCIMEX: "MARCIMEX",
  MXM: "MARCIMEX",
  "MOTO GO": "MOTO GO",
};

const SIGLA_ZONA = {
  VES: "Villa El Salvador",
  VMT: "Villa María del Triunfo",
  SJL: "San Juan de Lurigancho",
  SJM: "San Juan de Miraflores",
  SMP: "San Martín de Porres",
};

const TILDES_AUTO = {
  JAEN: "Jaén",
  CHEPEN: "Chepén",
  BOLIVAR: "Bolívar",
  MARIA: "María",
  JUNIN: "Junín",
  HUANUCO: "Huánuco",
  TUPAC: "Túpac",
  MARIATEGUI: "Mariátegui",
  ANCON: "Ancón",
  CANETE: "Cañete",
  CONCEPCION: "Concepción",
  ATAHUALPA: "Atahualpa",
  CESAR: "César",
  JOSE: "José",
  ANGEL: "Ángel",
  GERONIMO: "Gerónimo",
  NAZCA: "Nazca",
  PIURA: "Piura",
  CUSCO: "Cusco",
};

function _titleCase(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .split(" ")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

function _expandirZona(zona) {
  if (!zona) return "";
  const upper = zona.trim().toUpperCase();
  if (SIGLA_ZONA[upper]) return SIGLA_ZONA[upper];
  return zona
    .split(" ")
    .map((palabra) => {
      const u = palabra.toUpperCase().trim();
      if (!u) return palabra;
      if (TILDES_AUTO[u]) return TILDES_AUTO[u];
      return _titleCase(palabra);
    })
    .join(" ");
}

function _detectarMarca(prefijo) {
  const upper = String(prefijo || "").trim().toUpperCase();
  const ordenados = Object.keys(PRONUNCIACION_MARCA).sort((a, b) => b.length - a.length);
  for (const k of ordenados) {
    if (upper === k) return PRONUNCIACION_MARCA[k];
  }
  return _titleCase(prefijo);
}

// "CARSA_ATE PORVENIR" -> { marca, zonaLimpia, nombreCompleto }
function parsearNombreTienda(nombreRaw) {
  if (!nombreRaw) return { marca: "", zonaLimpia: "", nombreCompleto: "" };
  const raw = String(nombreRaw);
  const idx = raw.indexOf("_");
  if (idx === -1) {
    const z = _expandirZona(raw);
    return { marca: "", zonaLimpia: z, nombreCompleto: z };
  }
  const prefijo = raw.slice(0, idx);
  const resto = raw.slice(idx + 1).replace(/_/g, " ");
  const marca = _detectarMarca(prefijo);
  const zonaLimpia = _expandirZona(resto);
  return { marca, zonaLimpia, nombreCompleto: marca ? `${marca} ${zonaLimpia}` : zonaLimpia };
}

module.exports = { parsearNombreTienda, PRONUNCIACION_MARCA, SIGLA_ZONA, TILDES_AUTO };
