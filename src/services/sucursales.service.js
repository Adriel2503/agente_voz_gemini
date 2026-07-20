const axios = require("axios");
const env = require("../config/env.js");
const logger = require("../config/logger.js");
const { parsearNombreTienda } = require("../lib/pronunciacionTienda.js");

// Precarga las 3 sucursales mas cercanas y devuelve los placeholders que la
// plantilla espera ya resueltos. Portado de aiyou-voice-backend
// external-media.service.js (prefetchSucursal) + ultravoxapi.service.js (mapeo).
//
// Best-effort: si faltan datos de ubicacion o el CRM falla, devuelve las 11
// claves en "" (la plantilla detecta agencia vacia y enruta a su fallback).

const VARIANTES_LIMA = ["cercado de lima", "centro de lima", "cercado", "el cercado"];

const CLAVES_VACIAS = {
  tienda_cercana: "",
  tienda_cercana_limpia: "",
  marca_tienda: "",
  direccion_tienda: "",
  direccion_limpia: "",
  telefono_tienda: "",
  tienda_2_nombre: "",
  tienda_2_nombre_limpia: "",
  tienda_2_direccion: "",
  tienda_2_direccion_limpia: "",
  tienda_3_nombre: "",
  tienda_3_nombre_limpia: "",
  tienda_3_direccion: "",
  tienda_3_direccion_limpia: "",
};

function leer(variables, ...claves) {
  for (const c of claves) {
    const v = variables?.[c];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

async function cargarTiendas(idEmpresa, variables = {}) {
  const dpto = leer(variables, "DEPARTAMENTO", "departamento").toLowerCase();
  const prov = leer(variables, "PROVINCIA", "provincia").toLowerCase();
  let dist = leer(variables, "DISTRITO", "distrito").toLowerCase();
  if (VARIANTES_LIMA.includes(dist)) dist = "lima";

  if (!dpto || !prov || !dist) {
    logger.info(`[sucursales] Ubicacion incompleta (dpto='${dpto}' prov='${prov}' dist='${dist}'), sin prefetch`);
    return { ...CLAVES_VACIAS };
  }

  const termino = `${dpto}-${prov}-${dist}`;
  const url = `${env.sucursales.baseUrl.replace(/\/$/, "")}/api/crm/tools/llamadas/buscarSucursal`;
  try {
    const { data } = await axios.post(
      url,
      { termino, numero: 3, id_empresa: idEmpresa },
      { timeout: env.sucursales.timeoutMs }
    );
    const tiendas = Array.isArray(data?.data) ? data.data : [];
    if (tiendas.length === 0) {
      logger.warn(`[sucursales] Sin resultados para termino='${termino}' empresa=${idEmpresa}`);
      return { ...CLAVES_VACIAS };
    }

    const t1 = tiendas[0] || {};
    const t2 = tiendas[1] || {};
    const t3 = tiendas[2] || {};
    const p1 = parsearNombreTienda(t1.nombre);
    const p2 = parsearNombreTienda(t2.nombre);
    const p3 = parsearNombreTienda(t3.nombre);

    logger.debug(`[sucursales] OK ${tiendas.length} para '${termino}': #1=${t1.nombre || "-"}, #2=${t2.nombre || "-"}, #3=${t3.nombre || "-"}`);

    return {
      tienda_cercana: t1.nombre || "",
      tienda_cercana_limpia: p1.nombreCompleto || "",
      marca_tienda: p1.marca || "",
      direccion_tienda: t1.direccion || "",
      // El prompt usa {{direccion_limpia}}; la entregamos como alias de la cruda
      // (el agente la preprocesa al hablar segun la seccion de pronunciacion).
      direccion_limpia: t1.direccion || "",
      telefono_tienda: t1.telefono || "",
      tienda_2_nombre: t2.nombre || "",
      tienda_2_nombre_limpia: p2.nombreCompleto || "",
      tienda_2_direccion: t2.direccion || "",
      tienda_2_direccion_limpia: t2.direccion || "",
      tienda_3_nombre: t3.nombre || "",
      tienda_3_nombre_limpia: p3.nombreCompleto || "",
      tienda_3_direccion: t3.direccion || "",
      tienda_3_direccion_limpia: t3.direccion || "",
    };
  } catch (error) {
    logger.error(`[sucursales] buscarSucursal fallo (${error.message}) para '${termino}'`);
    return { ...CLAVES_VACIAS };
  }
}

module.exports = { cargarTiendas };
