// Resampling PCM16 LE mono para el motor Gemini (port de
// asterisk-bridge/resample.go).
//
// Gemini Live fija sus sample rates: entrada 16 kHz, salida 24 kHz. El cliente
// telefonico trabaja a 8 kHz (mulaw_8k) y el navegador a 16 kHz
// (pcm_s16le_16k), asi que:
//   subida  8k -> 16k : upsample x2 con interpolacion lineal
//   bajada 24k ->  8k : promedio de cada 3 muestras (con carry)
//   bajada 24k -> 16k : de cada 3 muestras salen 2 (con carry)
//
// Los downsamplers guardan estado (`carry`): los chunks de Gemini no vienen
// alineados al tamaño de grupo, y descartar el resto de cada chunk produciria
// clicks y drift acumulado. Una instancia por sesion.

// 8 kHz -> 16 kHz, x2 con interpolacion lineal:
//   out[2i]   = in[i]
//   out[2i+1] = (in[i] + in[i+1]) / 2   (la ultima muestra se repite)
function upsample8to16(pcm8k) {
  const n = pcm8k.length >> 1; // muestras int16
  const out = Buffer.allocUnsafe(n * 4);
  for (let i = 0; i < n; i++) {
    const s = pcm8k.readInt16LE(i * 2);
    const sig = i + 1 < n ? pcm8k.readInt16LE((i + 1) * 2) : s;
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(((s + sig) / 2) | 0, i * 4 + 2);
  }
  return out;
}

// Base de los downsamplers con carry: procesa grupos completos de
// `groupSamples` muestras y guarda los bytes sobrantes (0..groupBytes-1)
// para anteponerlos al siguiente chunk.
class _DownsamplerConCarry {
  constructor(groupSamples, outSamplesPorGrupo) {
    this.groupBytes = groupSamples * 2;
    this.outBytesPorGrupo = outSamplesPorGrupo * 2;
    this.carry = null; // Buffer de 0..groupBytes-1 bytes
  }

  process(pcmIn) {
    let data = pcmIn;
    if (this.carry && this.carry.length > 0) {
      data = Buffer.concat([this.carry, pcmIn]);
    }
    const grupos = Math.floor(data.length / this.groupBytes);
    const out = Buffer.allocUnsafe(grupos * this.outBytesPorGrupo);
    for (let g = 0; g < grupos; g++) {
      this._grupo(data, g * this.groupBytes, out, g * this.outBytesPorGrupo);
    }
    const rem = data.length - grupos * this.groupBytes;
    // Copia propia del sobrante: `data` puede ser el buffer del caller.
    this.carry = rem > 0 ? Buffer.from(data.subarray(data.length - rem)) : null;
    return out;
  }

  /* eslint-disable-next-line no-unused-vars */
  _grupo(inBuf, inOff, outBuf, outOff) {
    throw new Error("no implementado");
  }
}

// 24 kHz -> 8 kHz: promedio de cada 3 muestras (low-pass rudimentario antes
// de decimar, igual que el Go).
class Downsampler24a8 extends _DownsamplerConCarry {
  constructor() {
    super(3, 1);
  }

  _grupo(inBuf, inOff, outBuf, outOff) {
    const s0 = inBuf.readInt16LE(inOff);
    const s1 = inBuf.readInt16LE(inOff + 2);
    const s2 = inBuf.readInt16LE(inOff + 4);
    outBuf.writeInt16LE(((s0 + s1 + s2) / 3) | 0, outOff);
  }
}

// 24 kHz -> 16 kHz: ratio 3:2. De cada 3 muestras de entrada salen 2:
//   out0 = s0
//   out1 = (s1 + s2) / 2
class Downsampler24a16 extends _DownsamplerConCarry {
  constructor() {
    super(3, 2);
  }

  _grupo(inBuf, inOff, outBuf, outOff) {
    const s0 = inBuf.readInt16LE(inOff);
    const s1 = inBuf.readInt16LE(inOff + 2);
    const s2 = inBuf.readInt16LE(inOff + 4);
    outBuf.writeInt16LE(s0, outOff);
    outBuf.writeInt16LE(((s1 + s2) / 2) | 0, outOff + 2);
  }
}

module.exports = { upsample8to16, Downsampler24a8, Downsampler24a16 };
