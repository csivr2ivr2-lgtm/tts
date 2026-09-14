import path from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
import { WaveFile } from "wavefile";

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

function pcm16leToInt16(buffer) {
  if (buffer.length % 2 !== 0) throw new Error("PCM16 payload must contain an even number of bytes");
  const out = new Int16Array(buffer.length / 2);
  for (let i = 0, j = 0; i < buffer.length; i += 2, j += 1) out[j] = buffer.readInt16LE(i);
  return out;
}

function mergeChannels(samples) {
  if (!Array.isArray(samples)) return samples instanceof Float32Array ? samples : new Float32Array(samples);
  if (samples.length === 1) return new Float32Array(samples[0]);
  const length = Math.min(...samples.map((x) => x.length));
  const mono = new Float32Array(length);
  for (const channel of samples) {
    for (let i = 0; i < length; i += 1) mono[i] += channel[i] / samples.length;
  }
  return mono;
}

function normalizeWaveTo16k(wav) {
  if (wav.bitDepth === "8m") wav.fromMuLaw("16");
  if (wav.bitDepth === "8a") wav.fromALaw("16");
  if (wav.bitDepth === "4") wav.fromIMAADPCM("16");
  wav.toBitDepth("32f");
  if (Number(wav.fmt.sampleRate) !== TARGET_SAMPLE_RATE) wav.toSampleRate(TARGET_SAMPLE_RATE);
  const mono = mergeChannels(wav.getSamples());
  return { samples: mono, sourceSampleRate: Number(wav.fmt.sampleRate || TARGET_SAMPLE_RATE) };
}

export function decodeSttAudio(buffer, { encoding = "wav", sampleRate = 8000 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("Audio body is empty");
  const normalizedEncoding = String(encoding || "wav").toLowerCase();
  const sourceRate = Number(sampleRate || 8000);
  if (!Number.isFinite(sourceRate) || sourceRate < 4000 || sourceRate > 192000) throw new Error("Invalid sample_rate");

  let wav;
  if (normalizedEncoding === "wav" || buffer.subarray(0, 4).toString("ascii") === "RIFF") {
    wav = new WaveFile(buffer);
  } else if (["s16le", "pcm16", "pcm_s16le"].includes(normalizedEncoding)) {
    wav = new WaveFile();
    wav.fromScratch(1, sourceRate, "16", pcm16leToInt16(buffer));
  } else if (["mulaw", "mu-law", "ulaw", "pcmu"].includes(normalizedEncoding)) {
    wav = new WaveFile();
    wav.fromScratch(1, sourceRate, "8m", new Uint8Array(buffer));
    wav.fromMuLaw("16");
  } else if (["alaw", "a-law", "pcma"].includes(normalizedEncoding)) {
    wav = new WaveFile();
    wav.fromScratch(1, sourceRate, "8a", new Uint8Array(buffer));
    wav.fromALaw("16");
  } else {
    throw new Error(`Unsupported audio encoding '${encoding}'`);
  }

  const originalRate = Number(wav.fmt.sampleRate || sourceRate);
  const result = normalizeWaveTo16k(wav);
  return {
    samples: result.samples,
    sampleRate: TARGET_SAMPLE_RATE,
    sourceSampleRate: originalRate,
    durationSec: result.samples.length / TARGET_SAMPLE_RATE
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
        pipe = await pipeline("automatic-speech-recognition", model, {
          dtype,
          device: "cpu",
          cache_dir: cacheDir,
          progress_callback: (info) => {
            if (info?.status !== "progress_total" && info?.status !== "progress") return;
            const progress = Number(info.progress);
            if (info.status === "progress_total" || progress === 100 || (Number.isFinite(progress) && progress % 10 < 1)) {
              emit(onEvent, { stage: "model-progress", status: info.status, file: info.file, progress: Number.isFinite(progress) ? progress : undefined, loaded: info.loaded, total: info.total });
            }
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
