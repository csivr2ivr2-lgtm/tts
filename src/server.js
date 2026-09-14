import express from "express";
import crypto from "node:crypto";
import { defaultProfilePath, buildVoiceProfile, inspectVoiceProfile, loadVoiceProfile } from "./voice-profile.js";

process.env.OMP_NUM_THREADS ||= "1";
process.env.MKL_NUM_THREADS ||= "1";
process.env.OPENBLAS_NUM_THREADS ||= "1";
process.env.ORT_NUM_THREADS ||= "1";

const VERSION = "0.2.6";
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

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

let engineStatus = "idle";
let engineStage = "idle";
let engineError = null;
let engineInfo = {};
let pipeline = null;
let encodeWav = null;
let initPromise = null;
let queueTail = Promise.resolve();
let voiceBuildStatus = "idle";
let voiceBuildStage = "idle";
let voiceBuildError = null;
let voiceBuildInfo = {};
const wavCache = new Map();
const customVoices = new Map();

function requireAuth(req, res, next) {
  if (!API_KEY) return next();
  const header = req.get("authorization") || "";
  const expected = `Bearer ${API_KEY}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

function enqueue(task) {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => {});
  return run;
}

function cacheKey({ text, voiceName, temperature, decodeSteps, seed }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ text, voiceName, temperature, decodeSteps, seed, LANGUAGE, VERSION }))
    .digest("hex");
}

function cacheGet(key) {
  const value = wavCache.get(key);
  if (!value) return null;
  wavCache.delete(key);
  wavCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (CACHE_MAX_ITEMS <= 0) return;
  wavCache.set(key, value);
  while (wavCache.size > CACHE_MAX_ITEMS) {
    const oldest = wavCache.keys().next().value;
    wavCache.delete(oldest);
  }
}

function availableVoiceNames() {
  const builtIn = Array.isArray(pipeline?.voices) ? pipeline.voices : [];
  return [...new Set([...customVoices.keys(), ...builtIn])];
}

function resolveVoice(requested) {
  const name = requested || engineInfo.defaultVoice || pipeline.defaultVoice;
  if (customVoices.has(name)) return { name, value: customVoices.get(name), custom: true };
  if (pipeline.voices.includes(name)) return { name, value: name, custom: false };
  const error = new Error(`Unknown voice '${name}'. Available: ${availableVoiceNames().join(", ")}`);
  error.code = "UNKNOWN_VOICE";
  throw error;
}

function progressLogger(prefix, onEvent) {
  const seen = new Map();
  return (stage, progress = {}) => {
    const total = Number(progress.total || 0);
    const loaded = Number(progress.loaded || 0);
    const percent = total > 0 ? Math.floor((loaded / total) * 100) : -1;
    const previous = seen.get(stage) ?? -25;
    if (percent < 0 || percent >= previous + 10 || percent === 100) {
      seen.set(stage, percent);
      const suffix = percent >= 0 ? ` ${percent}%` : "";
      console.log(`[TTS] ${prefix}:${stage}${suffix}`);
      onEvent?.({ stage: `${prefix}:${stage}`, loaded, total, percent });
    }
  };
}

async function loadConfiguredVoiceProfile(tts, onEvent) {
  if (!VOICE_PROFILE_FILE) return null;
  engineStage = "loading-voice-profile";
  console.log(`[TTS] loading prepared voice '${VOICE_NAME}' from ${VOICE_PROFILE_FILE}`);
  onEvent?.({ stage: "loading-voice-profile", voice: VOICE_NAME });

  try {
    const voice = await loadVoiceProfile(VOICE_PROFILE_FILE);
    customVoices.set(VOICE_NAME, voice);
    console.log(`[TTS] prepared voice '${VOICE_NAME}' loaded floats=${voice.length}`);
    onEvent?.({ stage: "custom-voice-ready", voice: VOICE_NAME, floats: voice.length });
    return VOICE_NAME;
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error(
        `Prepared voice profile not found at ${VOICE_PROFILE_FILE}. Run POST /admin/build-voice/ first.`
      );
      missing.code = "VOICE_PROFILE_MISSING";
      throw missing;
    }
    throw error;
  }
}

async function initTts(onEvent) {
  if (pipeline) return pipeline;
  if (initPromise) return initPromise;

  engineStatus = "loading";
  engineStage = "importing-package";
  engineError = null;
  console.log(`[TTS] load starting pid=${process.pid}`);
  onEvent?.({ stage: "load-start", pid: process.pid });

  initPromise = (async () => {
    try {
      console.log("[TTS] importing pocket-tts-onnx");
      onEvent?.({ stage: "importing-package" });
      const mod = await import("pocket-tts-onnx");
      encodeWav = mod.encodeWav;

      engineStage = "loading-model";
      console.log("[TTS] package imported; loading ONNX model/assets");
      onEvent?.({ stage: "loading-model" });
      const options = {
        language: LANGUAGE,
        onProgress: progressLogger("model", onEvent)
      };
      if (MODELS_URL) options.modelsUrl = MODELS_URL;

      const tts = await mod.load(options);
      pipeline = tts;

      let selectedDefault = tts.defaultVoice;
      try {
        const preparedName = await loadConfiguredVoiceProfile(tts, onEvent);
        if (preparedName) selectedDefault = preparedName;
      } catch (error) {
        console.error("[TTS] custom voice failed:", error);
        if (REQUIRE_CUSTOM_VOICE) throw error;
        console.warn(`[TTS] falling back to built-in voice '${tts.defaultVoice}'`);
      }

      engineStatus = "ready";
      engineStage = "ready";
      engineInfo = {
        sampleRate: tts.sampleRate,
        defaultVoice: selectedDefault,
        customVoiceLoaded: customVoices.has(VOICE_NAME),
        voices: availableVoiceNames()
      };
      console.log(
        `[TTS] ready sampleRate=${tts.sampleRate} defaultVoice=${selectedDefault} ` +
          `customVoiceLoaded=${engineInfo.customVoiceLoaded}`
      );
      onEvent?.({ stage: "ready", ...engineInfo });
      return tts;
    } catch (error) {
      pipeline = null;
      customVoices.clear();
      initPromise = null;
      engineStatus = "error";
      engineStage = "error";
      engineError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error("[TTS] load failed:", error);
      onEvent?.({ stage: "error", error: engineError });
      throw error;
    }
  })();

  return initPromise;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "aharon-tts",
    version: VERSION,
    ttsStatus: engineStatus,
    stage: engineStage,
    language: LANGUAGE,
    workerThreads: false,
    cacheItems: wavCache.size,
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
    voiceBuildStatus,
    voiceBuildStage
  });
});

app.get("/ready", (_req, res) => {
  if (engineStatus === "ready") {
    return res.json({ ok: true, ready: true, language: LANGUAGE, ...engineInfo });
  }
  return res.status(503).json({
    ok: false,
    ready: false,
    status: engineStatus,
    stage: engineStage,
    error: engineError || undefined,
    hint: engineStatus === "idle" ? "POST /v1/tts can cold-start automatically; /admin/warmup/ is optional" : undefined
  });
});

app.get("/v1/voices", requireAuth, (_req, res) => {
  if (engineStatus !== "ready") {
    return res.status(503).json({ ok: false, error: "warming_up", status: engineStatus, stage: engineStage });
  }
  return res.json({
    ok: true,
    defaultVoice: engineInfo.defaultVoice,
    customVoiceLoaded: engineInfo.customVoiceLoaded,
    voices: engineInfo.voices
  });
});

async function warmupHandler(_req, res) {
  if (engineStatus === "ready") {
    return res.json({ ok: true, ready: true, status: engineStatus, ...engineInfo });
  }
  if (engineStatus === "loading") {
    return res.status(202).json({ ok: true, accepted: true, status: engineStatus, stage: engineStage });
  }

  res.status(200);
  res.set({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();

  const writeEvent = (event) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify({ ok: event.stage !== "error", ...event })}\n`);
    if (typeof res.flush === "function") res.flush();
  };

  console.log("[TTS] streaming warmup request opened");
  writeEvent({ stage: "accepted", status: engineStatus, pid: process.pid });
  await new Promise((resolve) => setImmediate(resolve));

  try {
    await initTts(writeEvent);
    writeEvent({ stage: "complete", ready: true, ...engineInfo });
  } catch (error) {
    writeEvent({
      stage: "error",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

async function buildVoiceHandler(req, res) {
  if (engineStatus === "loading" || engineStatus === "ready") {
    return res.status(409).json({
      ok: false,
      error: "tts_model_loaded",
      message: "Build the voice profile before warming the TTS model. Restart the app if needed."
    });
  }
  if (voiceBuildStatus === "building") {
    return res.status(202).json({ ok: true, accepted: true, status: voiceBuildStatus, stage: voiceBuildStage });
  }

  res.status(200);
  res.set({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();

  const writeEvent = (event) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify({ ok: event.stage !== "error", ...event })}\n`);
    if (typeof res.flush === "function") res.flush();
  };

  voiceBuildStatus = "building";
  voiceBuildStage = "accepted";
  voiceBuildError = null;
  voiceBuildInfo = {};
  console.log(`[VOICE] build request opened pid=${process.pid}`);
  writeEvent({ stage: "accepted", pid: process.pid, profilePath: VOICE_PROFILE_FILE });
  await new Promise((resolve) => setImmediate(resolve));

  try {
    const result = await buildVoiceProfile({
      voiceFile: VOICE_FILE,
      voiceName: VOICE_NAME,
      profilePath: VOICE_PROFILE_FILE,
      modelsUrl: MODELS_URL,
      force: req.query.force === "1" || req.query.force === "true",
      keepEncoder: KEEP_ENCODER,
      onProgress: (event) => {
        voiceBuildStage = event.stage;
        const suffix = Number.isFinite(event.percent) && event.percent >= 0 ? ` ${event.percent}%` : "";
        console.log(`[VOICE] ${event.stage}${suffix}`);
        writeEvent(event);
      }
    });
    voiceBuildStatus = "ready";
    voiceBuildStage = "ready";
    voiceBuildInfo = result;
    console.log(`[VOICE] profile ready ${result.profilePath} floats=${result.floats}`);
    writeEvent({ stage: "ready", ...result });
    writeEvent({ stage: "complete", ready: true, next: "POST /admin/warmup/" });
  } catch (error) {
    voiceBuildStatus = "error";
    voiceBuildStage = "error";
    voiceBuildError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error("[VOICE] build failed:", error);
    writeEvent({ stage: "error", error: voiceBuildError });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

app.get("/admin/voice-status", requireAuth, async (_req, res) => {
  try {
    const profile = await inspectVoiceProfile(VOICE_PROFILE_FILE);
    res.json({
      ok: voiceBuildStatus !== "error",
      status: profile.exists ? "ready" : voiceBuildStatus,
      stage: profile.exists ? "profile-saved" : voiceBuildStage,
      error: voiceBuildError || undefined,
      profilePath: VOICE_PROFILE_FILE,
      profile,
      ...voiceBuildInfo
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post("/admin/build-voice", requireAuth, buildVoiceHandler);
app.post("/admin/build-voice/", requireAuth, buildVoiceHandler);
app.post("/admin/warmup", requireAuth, warmupHandler);
app.post("/admin/warmup/", requireAuth, warmupHandler);

app.post("/v1/tts", requireAuth, async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ ok: false, error: "text is required" });
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(413).json({ ok: false, error: `text is too long; max ${MAX_TEXT_LENGTH} characters` });
  }

  if (engineStatus !== "ready") {
    console.log(`[TTS] /v1/tts cold start status=${engineStatus} stage=${engineStage} pid=${process.pid}`);
    try {
      await initTts();
    } catch (error) {
      return res.status(503).json({
        ok: false,
        error: "tts_unavailable",
        status: engineStatus,
        stage: engineStage,
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      });
    }
  }

  const requestedVoice = typeof req.body?.voice === "string" ? req.body.voice.trim() : "";
  const temperature = Number.isFinite(req.body?.temperature) ? Number(req.body.temperature) : undefined;
  const decodeSteps = Number.isInteger(req.body?.decodeSteps) ? Number(req.body.decodeSteps) : undefined;
  const seed = Number.isInteger(req.body?.seed) ? Number(req.body.seed) : undefined;

  let resolvedVoice;
  try {
    resolvedVoice = resolveVoice(requestedVoice || undefined);
  } catch (error) {
    return res.status(400).json({ ok: false, error: "unknown_voice", message: error.message });
  }

  const key = cacheKey({ text, voiceName: resolvedVoice.name, temperature, decodeSteps, seed });
  const cached = cacheGet(key);
  if (cached) {
    res.set({
      "Content-Type": "audio/wav",
      "Content-Length": String(cached.length),
      "Content-Disposition": "inline; filename=\"speech.wav\"",
      "Cache-Control": "no-store",
      "X-TTS-Cache": "HIT",
      "X-TTS-Voice": resolvedVoice.name
    });
    return res.end(cached);
  }

  try {
    const wav = await enqueue(async () => {
      const options = { voice: resolvedVoice.value };
      if (temperature !== undefined) options.temperature = temperature;
      if (decodeSteps !== undefined) options.decodeSteps = decodeSteps;
      if (seed !== undefined) options.seed = seed;

      const samples = await pipeline.speak(text, options);
      const encoded = encodeWav(samples, pipeline.sampleRate);
      return Buffer.from(encoded);
    });

    cacheSet(key, wav);
    res.set({
      "Content-Type": "audio/wav",
      "Content-Length": String(wav.length),
      "Content-Disposition": "inline; filename=\"speech.wav\"",
      "Cache-Control": "no-store",
      "X-TTS-Cache": "MISS",
      "X-TTS-Voice": resolvedVoice.name
    });
    return res.end(wav);
  } catch (error) {
    console.error("[TTS] generation failed:", error);
    return res.status(500).json({
      ok: false,
      error: "tts_generation_failed",
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }
  return res.status(500).json({ ok: false, error: "internal_server_error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Aharon TTS v${VERSION} listening on 0.0.0.0:${PORT}`);
  console.log(`Language: ${LANGUAGE}`);
  console.log(`Configured custom voice: ${VOICE_NAME} (${VOICE_FILE})`);
  console.log(`Prepared voice profile: ${VOICE_PROFILE_FILE}`);
  console.log("First run: POST /admin/build-voice/ once. /v1/tts auto-loads the TTS model on cold processes.");
});
