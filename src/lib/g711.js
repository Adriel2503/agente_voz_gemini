// Codec G.711 mu-law (ITU-T). Asterisk usa mulaw_8k; Ultravox serverWebSocket
// intercambia PCM s16le. Conversion deterministica, sin dependencias.
const BIAS = 0x84;
const CLIP = 32635;

function muLawEncodeSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function muLawDecodeSample(uVal) {
  uVal = ~uVal & 0xff;
  const sign = uVal & 0x80;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign !== 0 ? -sample : sample;
}

// Buffer mu-law (8-bit) -> Buffer PCM s16le.
function muLawToPcm16(muBuf) {
  const out = Buffer.alloc(muBuf.length * 2);
  for (let i = 0; i < muBuf.length; i++) out.writeInt16LE(muLawDecodeSample(muBuf[i]), i * 2);
  return out;
}

// Buffer PCM s16le -> Buffer mu-law (8-bit).
function pcm16ToMuLaw(pcmBuf) {
  const out = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = muLawEncodeSample(pcmBuf.readInt16LE(i * 2));
  return out;
}

module.exports = { muLawToPcm16, pcm16ToMuLaw };
