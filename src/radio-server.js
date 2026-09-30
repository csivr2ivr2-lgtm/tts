import express from "express";
import crypto from "node:crypto";
import { createBroadcastEngine, float32ToPcm16 } from "./broadcast.js";

for (const k of ["OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "ORT_NUM_THREADS"]) process.env[k] ||= "1";

const VERSION = "0.6.0-radio-mvp";
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TTS_API_KEY || "";
const LANGUAGE = process.env.TTS_LANGUAGE || "hebrew";
const MODELS_URL = process.env.TTS_MODELS_URL || "";
const MAX_TEXT_LENGTH = Number(process.env.TTS_MAX_TEXT_LENGTH || 1200);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

const broadcast = createBroadcastEngine();
let tts = null;
let encodeWav = null;
let loadPromise = null;
let status = "idle";
let lastError = null;
let queueTail = Promise.resolve();

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

async function initTts() {
  if (tts) return tts;
  if (loadPromise) return loadPromise;
  status = "loading";
  lastError = null;
  loadPromise = (async () => {
    try {
      const mod = await import("pocket-tts-onnx");
      encodeWav = mod.encodeWav;
      const options = { language: LANGUAGE };
      if (MODELS_URL) options.modelsUrl = MODELS_URL;
      tts = await mod.load(options);
      status = "ready";
      broadcast.setSampleRate(tts.sampleRate);
      console.log(`[RADIO] TTS ready sampleRate=${tts.sampleRate} voices=${(tts.voices || []).join(",")}`);
      return tts;
    } catch (error) {
      tts = null;
      status = "error";
      lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw error;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

function resolveVoice(name) {
  const requested = String(name || tts?.defaultVoice || "").trim();
  if (!requested) throw new Error("voice is required");
  if (!Array.isArray(tts?.voices) || !tts.voices.includes(requested)) {
    throw new Error(`Unknown voice '${requested}'. Available: ${(tts?.voices || []).join(", ")}`);
  }
  return requested;
}

app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "aharon-ai-radio",
  version: VERSION,
  pid: process.pid,
  uptimeSec: Math.floor(process.uptime()),
  tts: { status, error: lastError, sampleRate: tts?.sampleRate || null, voices: tts?.voices || [] },
  broadcast: broadcast.info(),
}));

app.get("/ready", async (_req, res) => {
  try {
    await initTts();
    res.json({ ok: true, ready: true, sampleRate: tts.sampleRate, defaultVoice: tts.defaultVoice, voices: tts.voices });
  } catch (error) {
    res.status(503).json({ ok: false, ready: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/v1/voices", auth, async (_req, res) => {
  try {
    await initTts();
    res.json({ ok: true, defaultVoice: tts.defaultVoice, voices: tts.voices });
  } catch (error) {
    res.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/v1/tts", auth, async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ ok: false, error: "text is required" });
  if (text.length > MAX_TEXT_LENGTH) return res.status(413).json({ ok: false, error: `text is too long; max ${MAX_TEXT_LENGTH}` });
  try {
    await initTts();
    const voice = resolveVoice(req.body?.voice);
    const samples = await enqueue(() => tts.speak(text, { voice }));
    const wav = Buffer.from(encodeWav(samples, tts.sampleRate));
    res.set({ "Content-Type": "audio/wav", "Content-Length": String(wav.length), "Cache-Control": "no-store", "X-TTS-Voice": voice }).end(wav);
  } catch (error) {
    res.status(500).json({ ok: false, error: "tts_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/v1/broadcast/status", auth, (_req, res) => res.json({ ok: true, ...broadcast.info() }));

app.post("/v1/broadcast/segment", auth, async (req, res) => {
  const text = typeof req.body?.text === "string"
    ? req.body.text.trim()
    : (typeof req.body?.content?.text === "string" ? req.body.content.text.trim() : "");
  if (!text) return res.status(400).json({ ok: false, error: "text is required" });
  if (text.length > MAX_TEXT_LENGTH) return res.status(413).json({ ok: false, error: `text is too long; max ${MAX_TEXT_LENGTH}` });

  try {
    await initTts();
    const voice = resolveVoice(req.body?.voice || req.body?.speaker?.voice);
    const samples = await enqueue(() => tts.speak(text, { voice }));
    const queued = broadcast.enqueueSegment({
      id: typeof req.body?.id === "string" ? req.body.id : undefined,
      pcm: float32ToPcm16(samples),
      sampleRate: tts.sampleRate,
      meta: {
        type: typeof req.body?.type === "string" ? req.body.type : "news",
        priority: Number.isFinite(req.body?.priority) ? Number(req.body.priority) : 50,
        voice,
        speakerId: typeof req.body?.speaker?.id === "string" ? req.body.speaker.id : null,
        eventId: typeof req.body?.source?.eventId === "string" ? req.body.source.eventId : null,
        textPreview: text.slice(0, 160),
      },
    });
    res.status(202).json({ ok: true, queued, broadcast: broadcast.info() });
  } catch (error) {
    res.status(500).json({ ok: false, error: "broadcast_segment_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/live.wav", async (_req, res) => {
  try {
    await initTts();
    broadcast.attach(res);
  } catch (error) {
    if (!res.headersSent) res.status(503).json({ ok: false, error: "broadcast_unavailable", message: error instanceof Error ? error.message : String(error) });
    else try { res.end(); } catch {}
  }
});

app.get("/radio", (_req, res) => res.type("html").send(`<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aharon AI Radio</title><style>body{font-family:system-ui;background:#111;color:#eee;max-width:760px;margin:50px auto;padding:20px}main{background:#1c1c1c;padding:28px;border-radius:18px}audio{width:100%;margin:20px 0}pre{background:#090909;padding:14px;border-radius:12px;white-space:pre-wrap}</style></head><body><main><h1>📻 Aharon AI Radio</h1><p>שידור AI חי. לחץ Play. כשאין קטע בתור, החיבור נשאר פתוח ומשודר שקט.</p><audio controls preload="none" src="/live.wav"></audio><pre id="s">טוען מצב...</pre></main><script>async function u(){try{const r=await fetch('/health',{cache:'no-store'});const j=await r.json();s.textContent=JSON.stringify(j.broadcast,null,2)}catch(e){s.textContent=String(e)}}u();setInterval(u,3000)</script></body></html>`));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Aharon AI Radio ${VERSION} listening on 0.0.0.0:${PORT}`);
});
