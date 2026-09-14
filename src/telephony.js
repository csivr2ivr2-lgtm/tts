const G711_SAMPLE_RATES = new Set([8000, 16000]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function resampleLinear(samples, sourceRate, targetRate) {
  if (!(samples instanceof Float32Array)) samples = new Float32Array(samples);
  if (!Number.isFinite(sourceRate) || !Number.isFinite(targetRate) || sourceRate <= 0 || targetRate <= 0) {
    throw new Error("Invalid sample rate");
  }
  if (sourceRate === targetRate) return samples;
  if (samples.length === 0) return new Float32Array(0);
  const length = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const output = new Float32Array(length);
  const ratio = sourceRate / targetRate;
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    output[i] = samples[left] + (samples[right] - samples[left]) * fraction;
  }
  return output;
}

function floatToPcm16(value) {
  const sample = clamp(Number(value) || 0, -1, 1);
  return sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
}

export function pcm16ToMuLaw(pcm) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sample = clamp(Math.trunc(pcm), -32768, 32767);
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  sample = Math.min(sample, CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; exponent -= 1, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function pcm16ToALaw(pcm) {
  let sample = clamp(Math.trunc(pcm), -32768, 32767);
  let sign;
  if (sample >= 0) {
    sign = 0x80;
  } else {
    sign = 0x00;
    sample = -sample - 1;
  }
  sample = Math.min(sample, 32635);
  let value;
  if (sample >= 256) {
    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; exponent -= 1, mask >>= 1) {}
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    value = (exponent << 4) | mantissa;
  } else {
    value = sample >> 4;
  }
  return (value ^ (sign ^ 0x55)) & 0xff;
}

export function encodeTelephony(samples, sourceRate, codec = "pcmu", targetRate = 8000) {
  const normalized = String(codec || "pcmu").toLowerCase();
  const kind = ["pcmu", "mulaw", "mu-law", "ulaw"].includes(normalized)
    ? "pcmu"
    : (["pcma", "alaw", "a-law"].includes(normalized) ? "pcma" : null);
  if (!kind) throw new Error(`Unsupported telephony codec '${codec}'`);
  if (!G711_SAMPLE_RATES.has(Number(targetRate))) throw new Error(`Unsupported G.711 sample rate ${targetRate}`);
  const mono = resampleLinear(samples, Number(sourceRate), Number(targetRate));
  const output = Buffer.allocUnsafe(mono.length);
  for (let i = 0; i < mono.length; i += 1) {
    const pcm = floatToPcm16(mono[i]);
    output[i] = kind === "pcmu" ? pcm16ToMuLaw(pcm) : pcm16ToALaw(pcm);
  }
  return output;
}
