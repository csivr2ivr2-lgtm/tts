import { readFile } from "node:fs/promises";

function fourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function readPcmSample(view, offset, bitsPerSample) {
  if (bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128;
  if (bitsPerSample === 16) return view.getInt16(offset, true) / 32768;
  if (bitsPerSample === 24) {
    let value =
      view.getUint8(offset) |
      (view.getUint8(offset + 1) << 8) |
      (view.getUint8(offset + 2) << 16);
    if (value & 0x800000) value |= 0xff000000;
    return value / 8388608;
  }
  if (bitsPerSample === 32) return view.getInt32(offset, true) / 2147483648;
  throw new Error(`Unsupported PCM bit depth: ${bitsPerSample}`);
}

function resampleLinear(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input;
  const outputLength = Math.max(1, Math.round((input.length * targetRate) / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = sourceRate / targetRate;

  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[i] = input[left] + (input[right] - input[left]) * fraction;
  }
  return output;
}

export async function loadMonoWav(filePath, targetSampleRate) {
  const bytes = await readFile(filePath);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes.length < 44 || fourCC(view, 0) !== "RIFF" || fourCC(view, 8) !== "WAVE") {
    throw new Error("Voice file is not a valid RIFF/WAVE file");
  }

  let format = null;
  let dataOffset = -1;
  let dataSize = 0;
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt ") {
      if (size < 16 || body + size > bytes.length) throw new Error("Invalid WAV fmt chunk");
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true)
      };
    } else if (id === "data") {
      dataOffset = body;
      dataSize = Math.min(size, bytes.length - body);
    }

    offset = body + size + (size % 2);
  }

  if (!format || dataOffset < 0) throw new Error("WAV file is missing fmt or data chunk");
  if (format.channels < 1 || format.channels > 8) throw new Error("Unsupported WAV channel count");
  if (![1, 3].includes(format.audioFormat)) {
    throw new Error(`Unsupported WAV encoding: ${format.audioFormat}; use PCM or IEEE float`);
  }

  const bytesPerSample = format.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) {
    throw new Error(`Invalid WAV bit depth: ${format.bitsPerSample}`);
  }

  const frameCount = Math.floor(dataSize / format.blockAlign);
  const mono = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = dataOffset + frame * format.blockAlign;
    let sum = 0;

    for (let channel = 0; channel < format.channels; channel += 1) {
      const sampleOffset = frameOffset + channel * bytesPerSample;
      let sample;
      if (format.audioFormat === 3 && format.bitsPerSample === 32) {
        sample = view.getFloat32(sampleOffset, true);
      } else if (format.audioFormat === 3 && format.bitsPerSample === 64) {
        sample = view.getFloat64(sampleOffset, true);
      } else {
        sample = readPcmSample(view, sampleOffset, format.bitsPerSample);
      }
      sum += Number.isFinite(sample) ? sample : 0;
    }

    mono[frame] = Math.max(-1, Math.min(1, sum / format.channels));
  }

  const samples = resampleLinear(mono, format.sampleRate, targetSampleRate);
  return {
    samples,
    sourceSampleRate: format.sampleRate,
    targetSampleRate,
    durationSec: samples.length / targetSampleRate,
    channels: format.channels
  };
}
