// Limite de sesiones nuevas POR EMPRESA. Es la guardia que corta el lazo de
// realimentacion del 16-jul-2026: el tope de concurrencia (empresa.canal) no
// alcanza porque no limita la TASA — ese dia los 15 canales estaban ocupados y
// aun asi se reciclaron 63 veces por minuto, porque las llamadas rechazadas
// morian a los 3s y el operador remarcaba enseguida.
// Ver docs/guardias-anti-runaway.md y docs/capacidad-gemini-live.html.
//
// BALDE DE TOKENS, no ventana deslizante. La ventana que hubo antes acotaba el
// sostenido (15/min) pero no la rafaga instantanea: 15 sesiones en 8 segundos
// entraban TODAS, porque la ventana arrancaba vacia — y eso fue literalmente el
// disparador del 16-jul (17 sesiones en 10 segundos). El balde separa las dos
// cosas que la ventana fundia en un solo numero:
//   - `rafaga`  = capacidad del balde: cuanto puede entrar DE GOLPE.
//   - `rpm`     = ritmo de reposicion: cuanto entra SOSTENIDO por minuto.
// Cada apertura consume 1 token; sin token, rebota. El refill es continuo
// (rpm/60 por segundo), asi que en cualquier lapso T entran como maximo
// rafaga + rpm*T/60. Con los defaults (5 y 15), el escenario del 16-jul da
// 5 + 1 de refill = 6 admitidas y 9 rebotadas donde la ventana admitia 15.
//
// NOTA: en memoria = conteo por instancia. Con N replicas el limite efectivo es
// N x limite (misma limitacion que el store de sesiones).

// idEmpresa -> { tokens, ts, rpm, rafaga }. Se guarda el rpm/rafaga con el que
// se opero por ultima vez para que purgar() pueda calcular el refill sin
// depender de config (el modulo no la lee).
const baldes = new Map();

// Refill lazy: nada de timers. Se repone lo devengado desde la ultima vez, con
// tope en `rafaga`. Math.max(0, ...) cubre un reloj que retrocede (NTP): un
// delta negativo no debe descontar tokens.
function reponer(b, ahora) {
  const delta = Math.max(0, ahora - b.ts);
  b.tokens = Math.min(b.rafaga, b.tokens + (delta * b.rpm) / 60000);
  b.ts = ahora;
}

// Chequea y consume en UNA sola operacion: asi un caller no puede admitir la
// sesion y olvidarse de contarla. `ahora` es inyectable para que los tests no
// tengan que dormir.
//
// El modulo NO lee configuracion a proposito: recibe rpm y rafaga ya resueltos.
// Hoy salen del env y manana pueden salir de empresa.max_rpm / empresa.max_rafaga
// sin tocar este archivo (ver docs/guardias-anti-runaway.md, decision D2).
//
// Config no positiva/NaN es config invalida, no una forma de configurar nada:
// se deja pasar sin registrar. Ante una config rota conviene quedarse sin
// guardia (el estado de antes del 30-jul) antes que dejar a la empresa sin
// atender llamadas.
function admitir(idEmpresa, rpm, rafaga, ahora = Date.now()) {
  if (!(rpm > 0) || !(rafaga > 0)) return { ok: true, tokens: 0, rpm: 0, rafaga: 0 };

  let b = baldes.get(idEmpresa);
  if (!b) {
    // El balde nace LLENO: una empresa que arranca puede abrir `rafaga` de
    // golpe. Es la unica deuda inicial que se concede; despues manda el refill.
    b = { tokens: rafaga, ts: ahora, rpm, rafaga };
    baldes.set(idEmpresa, b);
  } else {
    // Si la config cambio entre llamadas (deploy con otro env, o el dia que
    // venga de BD), rige la nueva desde ahora; el exceso se recorta en reponer().
    b.rpm = rpm;
    b.rafaga = rafaga;
  }

  reponer(b, ahora);

  if (b.tokens < 1) {
    // El rechazo NO consume ni registra: el refill sigue corriendo igual, asi
    // que un bucle de reintentos no atrasa la reposicion.
    return { ok: false, tokens: b.tokens, rpm, rafaga };
  }

  b.tokens -= 1;
  return { ok: true, tokens: b.tokens, rpm, rafaga };
}

// Descarta los baldes que ya estarian llenos: son indistinguibles de no existir
// (un balde nuevo nace lleno). El Map esta acotado por la cantidad de empresas
// activas (chico), pero sin esto una empresa que dejo de operar se quedaria en
// memoria para siempre.
function purgar(ahora = Date.now()) {
  for (const [id, b] of baldes) {
    reponer(b, ahora);
    if (b.tokens >= b.rafaga) baldes.delete(id);
  }
}

// Solo para tests: deja el estado en cero.
function _reset() {
  baldes.clear();
}

module.exports = { admitir, purgar, _reset };
