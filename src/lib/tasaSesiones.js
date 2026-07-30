// Limite de sesiones nuevas por minuto, POR EMPRESA. Es la guardia que corta el
// lazo de realimentacion del 16-jul-2026: el tope de concurrencia (empresa.canal)
// no alcanza porque no limita la TASA — ese dia los 15 canales estaban ocupados y
// aun asi se reciclaron 63 veces por minuto, porque las llamadas rechazadas
// morian a los 3s y el operador remarcaba enseguida.
// Ver docs/guardias-anti-runaway.md y docs/capacidad-gemini-live.html.
//
// VENTANA DESLIZANTE, no minuto de reloj: la cuota de Gemini tambien es
// deslizante. El 16-jul el minuto 15:53 marco 80% de reloj y aun asi fallo,
// porque entre 15:52:15 y 15:53:15 habian entrado ~21 sesiones = 112%. Una
// ventana fija dejaria pasar el doble del limite a caballo del borde, que es
// justo el patron de rafaga del incidente.
//
// NOTA: en memoria = conteo por instancia. Con N replicas el limite efectivo es
// N x limite (misma limitacion que el store de sesiones).

const VENTANA_MS = 60 * 1000;

// idEmpresa -> array de timestamps de las aperturas admitidas en la ventana.
const aperturas = new Map();

// Chequea y registra en UNA sola operacion: asi un caller no puede admitir la
// sesion y olvidarse de contarla. `ahora` es inyectable para que los tests no
// tengan que dormir 60s.
//
// El modulo NO lee configuracion a proposito: recibe el limite ya resuelto. Hoy
// sale del env y manana puede salir de empresa.max_rpm sin tocar este archivo
// (ver docs/guardias-anti-runaway.md, decision D2).
//
// limite <= 0 = desactivado, misma semantica de escape que canal <= 0.
function admitir(idEmpresa, limite, ahora = Date.now()) {
  if (!(limite > 0)) return { ok: true, usados: 0, limite: 0 };

  const desde = ahora - VENTANA_MS;
  const previas = (aperturas.get(idEmpresa) || []).filter((t) => t > desde);

  if (previas.length >= limite) {
    // Se reescribe el bucket ya podado: si la empresa queda rechazada en bucle,
    // igual no acumula timestamps viejos.
    aperturas.set(idEmpresa, previas);
    return { ok: false, usados: previas.length, limite };
  }

  previas.push(ahora);
  aperturas.set(idEmpresa, previas);
  return { ok: true, usados: previas.length, limite };
}

// Aperturas de la empresa dentro de la ventana, sin registrar nada. Para logs y
// tests; el camino de decision usa admitir().
function usados(idEmpresa, ahora = Date.now()) {
  const desde = ahora - VENTANA_MS;
  return (aperturas.get(idEmpresa) || []).filter((t) => t > desde).length;
}

// Descarta los buckets que quedaron sin aperturas vigentes. El Map esta acotado
// por la cantidad de empresas activas (chico), pero sin esto una empresa que
// dejo de operar se quedaria en memoria para siempre.
function purgar(ahora = Date.now()) {
  const desde = ahora - VENTANA_MS;
  for (const [id, ts] of aperturas) {
    const vigentes = ts.filter((t) => t > desde);
    if (vigentes.length === 0) aperturas.delete(id);
    else aperturas.set(id, vigentes);
  }
}

// Solo para tests: deja el contador en cero.
function _reset() {
  aperturas.clear();
}

module.exports = { admitir, usados, purgar, _reset, VENTANA_MS };
