// Cola de audio para re-trocear el stream en frames uniformes (port de
// asterisk-bridge/bridge.go::audioQueue).
//
// Gemini entrega el audio en chunks de tamaño variable; Asterisk/el integrador
// espera frames exactos de 20 ms. Esta cola acumula bytes y entrega frames de
// tamaño fijo (o null si aun no hay uno completo).
//
// Diseño de memoria (leccion del Go): usamos un puntero de lectura `head` en
// vez de recortar el buffer (`buf = buf.subarray(n)` dejaria vivo el buffer
// padre y creceria sin liberar en llamadas largas). Solo compactamos cuando el
// prefijo muerto pesa mas que lo pendiente, asi la memoria queda acotada al
// audio "en vuelo".
class AudioQueue {
  constructor() {
    this.chunks = []; // Buffers encolados pendientes de fusionar
    this.buf = Buffer.alloc(0); // buffer plano de lectura
    this.head = 0; // offset de lectura dentro de buf
  }

  // Bytes pendientes de leer.
  get length() {
    let n = this.buf.length - this.head;
    for (const c of this.chunks) n += c.length;
    return n;
  }

  push(bytes) {
    if (!bytes || bytes.length === 0) return;
    this.chunks.push(bytes);
  }

  // Fusiona los chunks pendientes al buffer plano, compactando el prefijo
  // muerto si conviene (mismo criterio que el Go: head >= pendiente).
  _consolidar() {
    if (this.chunks.length === 0) return;
    const pendiente = this.buf.length - this.head;
    const nuevos = this.chunks.reduce((n, c) => n + c.length, 0);
    if (this.head > 0 && this.head >= pendiente) {
      // Compactar: copiar solo lo pendiente al inicio de un buffer nuevo.
      const merged = Buffer.allocUnsafe(pendiente + nuevos);
      this.buf.copy(merged, 0, this.head);
      let off = pendiente;
      for (const c of this.chunks) { c.copy(merged, off); off += c.length; }
      this.buf = merged;
      this.head = 0;
    } else {
      const merged = Buffer.allocUnsafe(this.buf.length + nuevos);
      this.buf.copy(merged, 0);
      let off = this.buf.length;
      for (const c of this.chunks) { c.copy(merged, off); off += c.length; }
      this.buf = merged;
    }
    this.chunks.length = 0;
  }

  // Devuelve exactamente n bytes (copia propia) o null si aun no hay un frame
  // completo. La copia evita alias sobre un buffer que luego se compacta.
  popFrame(n) {
    if (this.buf.length - this.head < n) this._consolidar();
    if (this.buf.length - this.head < n) return null;
    const frame = Buffer.allocUnsafe(n);
    this.buf.copy(frame, 0, this.head, this.head + n);
    this.head += n;
    if (this.head === this.buf.length) {
      // Cola vacia: reiniciar sin realojar.
      this.buf = Buffer.alloc(0);
      this.head = 0;
    }
    return frame;
  }

  // Vacia la cola (barge-in): descarta el audio pendiente.
  clear() {
    this.chunks.length = 0;
    this.buf = Buffer.alloc(0);
    this.head = 0;
  }
}

module.exports = { AudioQueue };
