import path from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";

const TARGET_SAMPLE_RATE = 16000;

function persistentRoot() {
  const override = String(process.env.TTS_PERSIST_DIR || "").trim();
  if (override) return path.resolve(override);
  const candidates = [process.cwd(), process.env.HOME, homedir()].filter(Boolean);
  for (const candidate of candidates) {
    const normalized = path.resolve(String(candidate));
    const match = normalized.match(/^(\/home\/[^/]+)(?:\/|$)/);
    if (match) return path.join(match[1], ".cache", "aharon-tts");
  }
  return path.join(homedir(), ".cache", "aharon-tts");
}

function clampSample(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function muLawToFloat(byte) {
  let value = (~byte) & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  if (sign) sample = -sample;
  return clampSample(sample / 32768);
}

function aLawToFloat(byte) {
  let value = (byte ^ 0x55) & 0xff;
  let sample = (value & 0x0f) << 4;
  const segment = (value & 0x70) >> 4;
  if (segment === 0) sample += 8;
  else if (segment === 1) sample += 0x108;
  else {
    sample += 0x108;
    sample <<= segment - 1;
  }
  if ((value & 0x80) === 0) sample = -sample;
  return clampSample(sample / 32768);
}

function decodeRaw(buffer, encoding) {
  const normalized = String(encoding || "").toLowerCase();
  if (["s16le", "pcm16", "pcm_s16le"].includes(normalized)) {
    if (buffer.length % 2) throw new Error("PCM16 payload must contain an even number of bytes");
    const samples = new Float32Array(buffer.length / 2);
    for (let i = 0, j = 0; i < buffer.length; i += 2, j += 1) samples[j] = buffer.readInt16LE(i) / 32768;
    return samples;
  }
  if (["mulaw", "mu-law", "ulaw", "pcmu"].includes(normalized)) {
    const samples = new Float32Array(buffer.length);
    for (let i = 0; i < buffer.length; i += 1) samples[i] = muLawToFloat(buffer[i]);
    return samples;
  }
  if (["alaw", "a-law", "pcma"].includes(normalized)) {
    const samples = new Float32Array(buffer.length);
    for (let i = 0; i < buffer.length; i += 1) samples[i] = aLawToFloat(buffer[i]);
    return samples;
  }
  throw new Error(`Unsupported audio encoding '${encoding}'`);
}

function readPcmSample(buffer, offset, bitsPerSample, formatTag) {
  if (formatTag === 3) {
    if (bitsPerSample === 32) return clampSample(buffer.readFloatLE(offset));
    if (bitsPerSample === 64) return clampSample(buffer.readDoubleLE(offset));
    throw new Error(`Unsupported IEEE-float WAV bit depth ${bitsPerSample}`);
  }
  if (formatTag !== 1) throw new Error(`Unsupported WAV format tag ${formatTag}`);
  if (bitsPerSample === 8) return (buffer.readUInt8(offset) - 128) / 128;
  if (bitsPerSample === 16) return buffer.readInt16LE(offset) / 32768;
  if (bitsPerSample === 24) {
    let value = buffer.readUIntLE(offset, 3);
    if (value & 0x800000) value -= 0x1000000;
    return value / 8388608;
  }
  if (bitsPerSample === 32) return buffer.readInt32LE(offset) / 2147483648;
  throw new Error(`Unsupported PCM WAV bit depth ${bitsPerSample}`);
}

function parseWav(buffer) {
  if (buffer.length < 44 || buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error("Invalid WAV/RIFF header");
  }
  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) throw new Error(`Corrupt WAV chunk '${id}'`);
    if (id === "fmt ") {
      if (size < 16) throw new Error("Invalid WAV fmt chunk");
      fmt = {
        formatTag: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      };
      if (fmt.formatTag === 0xfffe && size >= 40) fmt.formatTag = buffer.readUInt16LE(start + 24);
    } else if (id === "data") {
      data = buffer.subarray(start, end);
    }
    offset = end + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV is missing fmt or data chunk");
  if (!fmt.channels || fmt.channels > 8) throw new Error(`Unsupported WAV channel count ${fmt.channels}`);
  if (!fmt.sampleRate || fmt.sampleRate < 4000 || fmt.sampleRate > 192000) throw new Error("Invalid WAV sample rate");

  if (fmt.formatTag === 6 || fmt.formatTag === 7) {
    const bytesPerFrame = fmt.channels;
    const frames = Math.floor(data.length / bytesPerFrame);
    const mono = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < fmt.channels; channel += 1) {
        const byte = data[frame * bytesPerFrame + channel];
        sum += fmt.formatTag === 7 ? muLawToFloat(byte) : aLawToFloat(byte);
      }
      mono[frame] = sum / fmt.channels;
    }
    return { samples: mono, sampleRate: fmt.sampleRate };
  }

  const bytesPerSample = fmt.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) throw new Error("Invalid WAV bit depth");
  const blockAlign = fmt.blockAlign || bytesPerSample * fmt.channels;
  const frames = Math.floor(data.length / blockAlign);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const frameOffset = frame * blockAlign;
    for (let channel = 0; channel < fmt.channels; channel += 1) {
      sum += readPcmSample(data, frameOffset + channel * bytesPerSample, fmt.bitsPerSample, fmt.formatTag);
    }
    mono[frame] = clampSample(sum / fmt.channels);
  }
  return { samples: mono, sampleRate: fmt.sampleRate };
}

function resampleLinear(samples, sourceRate, targetRate = TARGET_SAMPLE_RATE) {
  if (sourceRate === targetRate) return samples instanceof Float32Array ? samples : new Float32Array(samples);
  if (!samples.length) return new Float32Array(0);
  const outLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const out = new Float32Array(outLength);
  const ratio = sourceRate / targetRate;
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const left = Math.min(samples.length - 1, Math.floor(pos));
    const right = Math.min(samples.length - 1, left + 1);
    const frac = pos - left;
    out[i] = samples[left] + (samples[right] - samples[left]) * frac;
  }
  return out;
}

export function decodeSttAudio(buffer, { encoding = "wav", sampleRate = 8000 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("Audio body is empty");
  const normalizedEncoding = String(encoding || "wav").toLowerCase();
  let sourceRate;
  let sourceSamples;
  if (normalizedEncoding === "wav" || buffer.subarray(0, 4).toString("ascii") === "RIFF") {
    const wav = parseWav(buffer);
    sourceRate = wav.sampleRate;
    sourceSamples = wav.samples;
  } else {
    sourceRate = Number(sampleRate || 8000);
    if (!Number.isFinite(sourceRate) || sourceRate < 4000 || sourceRate > 192000) throw new Error("Invalid sample_rate");
    sourceSamples = decodeRaw(buffer, normalizedEncoding);
  }
  const samples = resampleLinear(sourceSamples, sourceRate, TARGET_SAMPLE_RATE);
  return {
    samples,
    sampleRate: TARGET_SAMPLE_RATE,
    sourceSampleRate: sourceRate,
    durationSec: samples.length / TARGET_SAMPLE_RATE
  };
}

export function createSttEngine(options = {}) {
  const model = options.model || process.env.STT_MODEL || "Xenova/whisper-tiny";
  const dtype = options.dtype || process.env.STT_DTYPE || "q8";
  const language = options.language || process.env.STT_LANGUAGE || "hebrew";
  const idleUnloadMs = Number(options.idleUnloadMs ?? process.env.STT_IDLE_UNLOAD_MS ?? 60000);
  const cacheDir = path.resolve(options.cacheDir || process.env.STT_CACHE_DIR || path.join(persistentRoot(), "whisper"));
  let pipe = null;
  let loading = null;
  let status = "idle";
  let stage = "idle";
  let error = null;
  let unloadTimer = null;
  let lastUsedAt = null;
  const emit = (onEvent, event) => onEvent?.(event);

  function scheduleUnload() {
    if (unloadTimer) clearTimeout(unloadTimer);
    unloadTimer = null;
    if (!Number.isFinite(idleUnloadMs) || idleUnloadMs <= 0 || !pipe) return;
    unloadTimer = setTimeout(() => unload().catch((err) => console.error("[STT] idle unload failed:", err)), idleUnloadMs);
    unloadTimer.unref?.();
  }

  async function load(onEvent) {
    if (pipe) { scheduleUnload(); return pipe; }
    if (loading) return loading;
    status = "loading";
    stage = "importing-transformers";
    error = null;
    console.log(`[STT] load starting model=${model} dtype=${dtype} pid=${process.pid}`);
    emit(onEvent, { stage: "load-start", model, dtype, cacheDir, pid: process.pid });
    loading = (async () => {
      try {
        await mkdir(cacheDir, { recursive: true });
        const { pipeline } = await import("@huggingface/transformers");
        stage = "loading-model";
        emit(onEvent, { stage: "loading-model", model, dtype });
        let lastTotalBucket = -10;
        pipe = await pipeline("automatic-speech-recognition", model, {
          dtype,
          device: "cpu",
          cache_dir: cacheDir,
          progress_callback: (info) => {
            if (info?.status !== "progress_total") return;
            const progress = Number(info.progress);
            if (!Number.isFinite(progress)) return;
            const bucket = Math.min(100, Math.floor(progress / 10) * 10);
            if (bucket <= lastTotalBucket) return;
            lastTotalBucket = bucket;
            emit(onEvent, {
              stage: "model-progress",
              status: "progress_total",
              progress: Number(progress.toFixed(1)),
              loaded: info.loaded,
              total: info.total
            });
          }
        });
        status = "ready";
        stage = "ready";
        lastUsedAt = Date.now();
        console.log(`[STT] ready model=${model} dtype=${dtype} language=${language}`);
        emit(onEvent, { stage: "ready", model, dtype, language, cacheDir });
        scheduleUnload();
        return pipe;
      } catch (err) {
        pipe = null;
        status = "error";
        stage = "error";
        error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error("[STT] load failed:", err);
        emit(onEvent, { stage: "error", error });
        throw err;
      } finally { loading = null; }
    })();
    return loading;
  }

  async function transcribe(samples, options = {}) {
    const transcriber = await load(options.onEvent);
    if (!(samples instanceof Float32Array) || samples.length === 0) throw new Error("No decoded audio samples");
    stage = "transcribing";
    status = "busy";
    if (unloadTimer) clearTimeout(unloadTimer);
    unloadTimer = null;
    const started = Date.now();
    try {
      const result = await transcriber(samples, {
        language: options.language || language,
        task: "transcribe",
        return_timestamps: options.timestamps === false ? false : true,
        chunk_length_s: Number(options.chunkLengthSec || 25),
        stride_length_s: Number(options.strideLengthSec || 3)
      });
      lastUsedAt = Date.now();
      return { text: String(result?.text || "").trim(), chunks: Array.isArray(result?.chunks) ? result.chunks : undefined, processingMs: Date.now() - started };
    } finally {
      status = pipe ? "ready" : "idle";
      stage = pipe ? "ready" : "idle";
      scheduleUnload();
    }
  }

  async function unload() {
    if (unloadTimer) clearTimeout(unloadTimer);
    unloadTimer = null;
    if (!pipe) { status = loading ? "loading" : "idle"; if (!loading) stage = "idle"; return false; }
    const current = pipe;
    pipe = null;
    status = "unloading";
    stage = "unloading";
    try {
      if (typeof current.dispose === "function") await current.dispose();
      status = "idle";
      stage = "idle";
      console.log("[STT] unloaded from memory; disk cache retained");
      return true;
    } catch (err) {
      status = "error";
      stage = "error";
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw err;
    }
  }

  function info() {
    return { status, stage, error, model, dtype, language, sampleRate: TARGET_SAMPLE_RATE, cacheDir, loaded: Boolean(pipe), idleUnloadMs, lastUsedAt };
  }
  return { load, transcribe, unload, info };
}
