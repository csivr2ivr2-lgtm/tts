import express from "express";
import crypto from "node:crypto";
import { defaultProfilePath, buildVoiceProfile, inspectVoiceProfile, loadVoiceProfile } from "./voice-profile.js";
import { encodeTelephony } from "./telephony.js";
import { createSipController } from "./sip.js";

for (const k of ["OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "ORT_NUM_THREADS"]) process.env[k] ||= "1";

const VERSION = "0.5.2";
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TTS_API_KEY || "";
const LANGUAGE = process.env.TTS_LANGUAGE || "hebrew";
const MODELS_URL = process.env.TTS_MODELS_URL || "";
const VOICE_NAME = process.env.TTS_VOICE_NAME || "ari";
const VOICE_FILE = process.env.TTS_VOICE_FILE || "voices/ari.wav";
const VOICE_PROFILE_FILE = process.env.TTS_VOICE_PROFILE_FILE || defaultProfilePath(VOICE_NAME);
const KEEP_ENCODER = process.env.TTS_KEEP_ENCODER !== "false";
const REQUIRE_CUSTOM_VOICE = process.env.TTS_REQUIRE_CUSTOM_VOICE !== "false";
const MAX_TEXT_LENGTH = Number(process.env.TTS_MAX_TEXT_LENGTH || 1200);
const CACHE_MAX_ITEMS = Number(process.env.TTS_CACHE_MAX_ITEMS || 100);
const STT_MAX_AUDIO_BYTES = Number(process.env.STT_MAX_AUDIO_BYTES || 8 * 1024 * 1024);
const STT_MAX_AUDIO_SECONDS = Number(process.env.STT_MAX_AUDIO_SECONDS || 120);
const TELEPHONY_CODEC = String(process.env.TELEPHONY_CODEC || "pcmu").toLowerCase();
const TELEPHONY_SAMPLE_RATE = Number(process.env.TELEPHONY_SAMPLE_RATE || 8000);
const sip = createSipController();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

let tts = null;
let encodeWav = null;
let ttsLoadPromise = null;
let ttsStatus = "idle";
let ttsStage = "idle";
let ttsError = null;
let ttsInfo = {};
let queueTail = Promise.resolve();
let voiceBuildStatus = "idle";
let voiceBuildStage = "idle";
let voiceBuildError = null;
let voiceBuildInfo = {};
const customVoices = new Map();
const wavCache = new Map();
let stt = null;
let sttModule = null;
let sttImportPromise = null;
let sttImportError = null;

function sttInfo() {
  if (stt) return stt.info();
  return {
    status: sttImportError ? "error" : "idle",
    stage: sttImportError ? "module-import-error" : "idle",
    error: sttImportError || null,
    model: process.env.STT_MODEL || "Xenova/whisper-tiny",
    dtype: process.env.STT_DTYPE || "q8",
    language: process.env.STT_LANGUAGE || "hebrew",
    sampleRate: 16000,
    loaded: false,
    idleUnloadMs: Number(process.env.STT_IDLE_UNLOAD_MS || 60000)
  };
}

async function ensureStt() {
  if (stt && sttModule) return { stt, mod: sttModule };
  if (sttImportPromise) return sttImportPromise;
  sttImportPromise = import("./stt.js")
    .then((mod) => {
      sttModule = mod;
      stt = mod.createSttEngine();
      sttImportError = null;
      return { stt, mod };
    })
    .catch((error) => {
      stt = null;
      sttModule = null;
      sttImportError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error("[STT] module import failed; TTS remains available:", error);
      throw error;
    })
    .finally(() => { sttImportPromise = null; });
  return sttImportPromise;
}

function auth(req, res, next) {
  if (!API_KEY) return next();
  const a = Buffer.from(req.get("authorization") || "");
  const b = Buffer.from(`Bearer ${API_KEY}`);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

function enqueue(task) {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => {});
  return run;
}

function cacheSet(key, value) {
  if (CACHE_MAX_ITEMS <= 0) return;
  wavCache.set(key, value);
  while (wavCache.size > CACHE_MAX_ITEMS) wavCache.delete(wavCache.keys().next().value);
}

function voices() {
  const builtIn = Array.isArray(tts?.voices) ? tts.voices : [];
  return [...new Set([...customVoices.keys(), ...builtIn])];
}

function resolveVoice(name) {
  const requested = name || ttsInfo.defaultVoice || tts?.defaultVoice;
  if (customVoices.has(requested)) return { name: requested, value: customVoices.get(requested) };
  if (tts?.voices?.includes(requested)) return { name: requested, value: requested };
  throw new Error(`Unknown voice '${requested}'. Available: ${voices().join(", ")}`);
}

async function initTts(onEvent) {
  if (tts) return tts;
  if (ttsLoadPromise) return ttsLoadPromise;
  ttsStatus = "loading";
  ttsStage = "importing-package";
  ttsError = null;
  onEvent?.({ stage: "load-start", pid: process.pid });

  ttsLoadPromise = (async () => {
    try {
      const mod = await import("pocket-tts-onnx");
      encodeWav = mod.encodeWav;
      ttsStage = "loading-model";
      const options = {
        language: LANGUAGE,
        onProgress: (stage, p = {}) => {
          const total = Number(p.total || 0), loaded = Number(p.loaded || 0);
          const percent = total ? Math.floor((loaded / total) * 100) : -1;
          if (percent < 0 || percent % 10 === 0 || percent === 100) onEvent?.({ stage: `model:${stage}`, loaded, total, percent });
        }
      };
      if (MODELS_URL) options.modelsUrl = MODELS_URL;
      tts = await mod.load(options);

      let defaultVoice = tts.defaultVoice;
      try {
        const prepared = await loadVoiceProfile(VOICE_PROFILE_FILE);
        customVoices.set(VOICE_NAME, prepared);
        defaultVoice = VOICE_NAME;
      } catch (e) {
        if (REQUIRE_CUSTOM_VOICE) throw e;
      }

      ttsStatus = "ready";
      ttsStage = "ready";
      ttsInfo = { sampleRate: tts.sampleRate, defaultVoice, customVoiceLoaded: customVoices.has(VOICE_NAME), voices: voices() };
      onEvent?.({ stage: "ready", ...ttsInfo });
      console.log(`[TTS] ready sampleRate=${tts.sampleRate} defaultVoice=${defaultVoice}`);
      return tts;
    } catch (e) {
      tts = null;
      customVoices.clear();
      ttsLoadPromise = null;
      ttsStatus = "error";
      ttsStage = "error";
      ttsError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw e;
    }
  })();
  return ttsLoadPromise;
}

function ndjson(res) {
  res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  return (event) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`${JSON.stringify({ ok: event.stage !== "error", ...event })}\n`);
      res.flush?.();
    }
  };
}

app.get("/health", (_req, res) => res.json({
  ok: true, service: "aharon-voice-ai", version: VERSION, pid: process.pid, uptimeSec: Math.floor(process.uptime()),
  tts: { status: ttsStatus, stage: ttsStage, error: ttsError, ...ttsInfo }, stt: sttInfo(),
  voiceBuild: { status: voiceBuildStatus, stage: voiceBuildStage, error: voiceBuildError }, sip: sip.info()
}));

app.get("/ready", (_req, res) => ttsStatus === "ready"
  ? res.json({ ok: true, ready: true, language: LANGUAGE, ...ttsInfo })
  : res.status(503).json({ ok: false, ready: false, status: ttsStatus, stage: ttsStage, error: ttsError || undefined }));

app.get("/v1/voices", auth, (_req, res) => ttsStatus === "ready"
  ? res.json({ ok: true, defaultVoice: ttsInfo.defaultVoice, customVoiceLoaded: ttsInfo.customVoiceLoaded, voices: ttsInfo.voices })
  : res.status(503).json({ ok: false, error: "tts_not_ready", status: ttsStatus }));

async function warmTts(_req, res) {
  if (ttsStatus === "ready") return res.json({ ok: true, ready: true, ...ttsInfo });
  const write = ndjson(res);
  write({ stage: "accepted", pid: process.pid });
  try { await initTts(write); write({ stage: "complete", ready: true, ...ttsInfo }); }
  catch (e) { write({ stage: "error", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }); }
  finally { if (!res.writableEnded) res.end(); }
}
app.post(["/admin/warmup", "/admin/warmup/"], auth, warmTts);

app.get("/admin/voice-status", auth, async (_req, res) => {
  try {
    const profile = await inspectVoiceProfile(VOICE_PROFILE_FILE);
    res.json({ ok: voiceBuildStatus !== "error", status: profile.exists ? "ready" : voiceBuildStatus, stage: profile.exists ? "profile-saved" : voiceBuildStage, profilePath: VOICE_PROFILE_FILE, profile, ...voiceBuildInfo });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

async function buildVoice(req, res) {
  if (ttsStatus === "loading" || ttsStatus === "ready") return res.status(409).json({ ok: false, error: "tts_model_loaded", message: "Restart app and build voice before loading TTS." });
  const write = ndjson(res);
  voiceBuildStatus = "building"; voiceBuildStage = "accepted"; voiceBuildError = null; voiceBuildInfo = {};
  write({ stage: "accepted", pid: process.pid, profilePath: VOICE_PROFILE_FILE });
  try {
    const result = await buildVoiceProfile({
      voiceFile: VOICE_FILE, voiceName: VOICE_NAME, profilePath: VOICE_PROFILE_FILE, modelsUrl: MODELS_URL,
      force: req.query.force === "1" || req.query.force === "true", keepEncoder: KEEP_ENCODER,
      onProgress: (event) => { voiceBuildStage = event.stage; write(event); }
    });
    voiceBuildStatus = "ready"; voiceBuildStage = "ready"; voiceBuildInfo = result;
    write({ stage: "ready", ...result }); write({ stage: "complete", ready: true });
  } catch (e) {
    voiceBuildStatus = "error"; voiceBuildStage = "error"; voiceBuildError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    write({ stage: "error", error: voiceBuildError });
  } finally { if (!res.writableEnded) res.end(); }
}
app.post(["/admin/build-voice", "/admin/build-voice/"], auth, buildVoice);

app.get("/admin/stt/status", auth, (_req, res) => res.json({ ok: !sttImportError, ...sttInfo() }));
async function warmStt(_req, res) {
  const write = ndjson(res);
  write({ ...sttInfo(), stage: "accepted", pid: process.pid });
  try {
    const { stt: engine } = await ensureStt();
    await engine.load(write);
    write({ stage: "complete", ready: true, ...engine.info() });
  } catch (e) {
    write({ stage: "error", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), stt: sttInfo() });
  } finally { if (!res.writableEnded) res.end(); }
}
app.post(["/admin/stt/warmup", "/admin/stt/warmup/"], auth, warmStt);
app.post("/admin/stt/unload", auth, async (_req, res) => {
  try {
    if (!stt) return res.json({ ok: true, unloaded: false, ...sttInfo() });
    const unloaded = await stt.unload();
    res.json({ ok: true, unloaded, ...sttInfo() });
  } catch (e) { res.status(500).json({ ok: false, error: String(e), stt: sttInfo() }); }
});

app.get("/admin/sip/status", auth, (_req, res) => res.json({ ok: true, ...sip.info() }));
app.post("/admin/sip/probe", auth, async (_req, res) => {
  try {
    const result = await sip.probe();
    res.status(result.ok ? 200 : 502).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: "sip_probe_failed", message: e instanceof Error ? e.message : String(e), sip: sip.info() });
  }
});
app.post("/admin/sip/diagnostics", auth, async (_req, res) => {
  try {
    const result = await sip.diagnoseTransport();
    res.status(result.ok ? 200 : 502).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: "sip_diagnostics_failed", message: e instanceof Error ? e.message : String(e), sip: sip.info() });
  }
});
app.post("/admin/sip/connect", auth, async (_req, res) => {
  try {
    const state = await sip.connect();
    res.status(state.registered ? 200 : 202).json({ ok: true, accepted: !state.registered, ...state });
  } catch (e) {
    const code = e?.code === "SIP_NOT_CONFIGURED" ? 503 : 500;
    res.status(code).json({ ok: false, error: e?.code || "sip_connect_failed", message: e instanceof Error ? e.message : String(e), sip: sip.info() });
  }
});
app.post("/admin/sip/disconnect", auth, async (_req, res) => {
  try { res.json({ ok: true, ...(await sip.disconnect()) }); }
  catch (e) { res.status(500).json({ ok: false, error: "sip_disconnect_failed", message: e instanceof Error ? e.message : String(e), sip: sip.info() }); }
});

const rawAudio = express.raw({ type: ["audio/wav", "audio/x-wav", "audio/wave", "application/octet-stream"], limit: STT_MAX_AUDIO_BYTES });
app.post("/v1/stt", auth, rawAudio, async (req, res) => {
  if (!Buffer.isBuffer(req.body)) return res.status(415).json({ ok: false, error: "unsupported_media_type" });
  let engine, mod, audio;
  try {
    ({ stt: engine, mod } = await ensureStt());
    const type = (req.get("content-type") || "").split(";")[0].toLowerCase();
    audio = mod.decodeSttAudio(req.body, { encoding: type.includes("wav") ? "wav" : String(req.query.encoding || "s16le"), sampleRate: Number(req.query.sample_rate || TELEPHONY_SAMPLE_RATE) });
    const simulateCodec = String(req.query.simulate_telephony || "").toLowerCase();
    if (simulateCodec) {
      const encoded = encodeTelephony(audio.samples, audio.sampleRate, simulateCodec, TELEPHONY_SAMPLE_RATE);
      audio = mod.decodeSttAudio(encoded, { encoding: simulateCodec, sampleRate: TELEPHONY_SAMPLE_RATE });
      audio.simulatedTelephony = { codec: simulateCodec, sampleRate: TELEPHONY_SAMPLE_RATE, bytes: encoded.length };
    }
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const importFailure = Boolean(sttImportError);
    return res.status(importFailure ? 503 : 400).json({ ok: false, error: importFailure ? "stt_unavailable" : "invalid_audio", message, stt: sttInfo() });
  }
  if (audio.durationSec > STT_MAX_AUDIO_SECONDS) return res.status(413).json({ ok: false, error: "audio_too_long", maxSeconds: STT_MAX_AUDIO_SECONDS });
  try {
    const result = await enqueue(() => engine.transcribe(audio.samples, { language: String(req.query.language || process.env.STT_LANGUAGE || "hebrew"), timestamps: req.query.timestamps !== "0" && req.query.timestamps !== "false" }));
    res.json({ ok: true, text: result.text, chunks: result.chunks, language: String(req.query.language || process.env.STT_LANGUAGE || "hebrew"), model: engine.info().model, durationSec: Number(audio.durationSec.toFixed(3)), sourceSampleRate: audio.sourceSampleRate, sampleRate: audio.sampleRate, simulatedTelephony: audio.simulatedTelephony, processingMs: result.processingMs });
  } catch (e) { res.status(500).json({ ok: false, error: "stt_failed", message: e instanceof Error ? `${e.name}: ${e.message}` : String(e), stt: sttInfo() }); }
});

app.post("/v1/tts", auth, async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ ok: false, error: "text is required" });
  if (text.length > MAX_TEXT_LENGTH) return res.status(413).json({ ok: false, error: `text is too long; max ${MAX_TEXT_LENGTH}` });
  try { if (ttsStatus !== "ready") await initTts(); }
  catch (e) { return res.status(503).json({ ok: false, error: "tts_unavailable", message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }); }
  let voice;
  try { voice = resolveVoice(typeof req.body?.voice === "string" ? req.body.voice.trim() : ""); }
  catch (e) { return res.status(400).json({ ok: false, error: "unknown_voice", message: e.message }); }
  const temperature = Number.isFinite(req.body?.temperature) ? Number(req.body.temperature) : undefined;
  const decodeSteps = Number.isInteger(req.body?.decodeSteps) ? Number(req.body.decodeSteps) : undefined;
  const seed = Number.isInteger(req.body?.seed) ? Number(req.body.seed) : undefined;
  const format = String(req.body?.format || "wav").toLowerCase();
  const outputRate = Number(req.body?.sampleRate || (format === "wav" ? tts.sampleRate : TELEPHONY_SAMPLE_RATE));
  if (!["wav", "pcmu", "mulaw", "ulaw", "pcma", "alaw"].includes(format)) {
    return res.status(400).json({ ok: false, error: "unsupported_output_format", formats: ["wav", "pcmu", "pcma"] });
  }
  if (format !== "wav" && outputRate !== 8000 && outputRate !== 16000) {
    return res.status(400).json({ ok: false, error: "unsupported_telephony_sample_rate", sampleRates: [8000, 16000] });
  }
  const normalizedFormat = ["mulaw", "ulaw"].includes(format) ? "pcmu" : (format === "alaw" ? "pcma" : format);
  const key = crypto.createHash("sha256").update(JSON.stringify({ text, voice: voice.name, temperature, decodeSteps, seed, format: normalizedFormat, outputRate, LANGUAGE, VERSION })).digest("hex");
  const hit = wavCache.get(key);
  const headersFor = (buffer, cacheState) => ({
    "Content-Type": normalizedFormat === "wav" ? "audio/wav" : "application/octet-stream",
    "Content-Length": String(buffer.length),
    "Content-Disposition": normalizedFormat === "wav" ? 'inline; filename="speech.wav"' : `inline; filename="speech.${normalizedFormat}"`,
    "Cache-Control": "no-store",
    "X-TTS-Cache": cacheState,
    "X-TTS-Voice": voice.name,
    "X-Audio-Codec": normalizedFormat,
    "X-Audio-Sample-Rate": String(normalizedFormat === "wav" ? tts.sampleRate : outputRate)
  });
  if (hit) return res.set(headersFor(hit, "HIT")).end(hit);
  try {
    const audio = await enqueue(async () => {
      const options = { voice: voice.value };
      if (temperature !== undefined) options.temperature = temperature;
      if (decodeSteps !== undefined) options.decodeSteps = decodeSteps;
      if (seed !== undefined) options.seed = seed;
      const samples = await tts.speak(text, options);
      if (normalizedFormat === "wav") return Buffer.from(encodeWav(samples, tts.sampleRate));
      return encodeTelephony(samples, tts.sampleRate, normalizedFormat, outputRate);
    });
    cacheSet(key, audio);
    res.set(headersFor(audio, "MISS")).end(audio);
  } catch (e) { res.status(500).json({ ok: false, error: "tts_generation_failed", message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.type === "entity.parse.failed") return res.status(400).json({ ok: false, error: "invalid_json" });
  if (err?.type === "entity.too.large") return res.status(413).json({ ok: false, error: "payload_too_large" });
  res.status(500).json({ ok: false, error: "internal_server_error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Aharon Voice AI v${VERSION} listening on 0.0.0.0:${PORT}`);
  const si = sttInfo();
  console.log(`TTS=${LANGUAGE}/${VOICE_NAME}; STT=${si.model}/${si.dtype}/${si.language} (lazy)`);
  console.log(`Voice profile: ${VOICE_PROFILE_FILE}`);
  if (sip.info().autoConnect && sip.info().configured) {
    sip.connect().catch((error) => console.error("[SIP] auto-connect failed:", error instanceof Error ? error.message : String(error)));
  }
});