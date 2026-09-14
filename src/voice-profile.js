import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { loadMonoWav } from "./audio.js";

const MAGIC = Buffer.from("AHRTTSV1", "ascii");
const HEADER_BYTES = MAGIC.length + 4;
const DEFAULT_MODELS_BASE = "https://huggingface.co/thewh1teagle/pocket-tts-onnx/resolve/main/he/";

function withSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function persistentStorageDir() {
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

export function defaultProfilePath(voiceName = "ari") {
  return path.join(persistentStorageDir(), `${voiceName}.voice`);
}

export function defaultEncoderPath() {
  return path.join(persistentStorageDir(), "encoder.onnx");
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.json();
}

async function downloadFile(url, destination, expectedBytes, onProgress) {
  if (await exists(destination)) {
    const info = await stat(destination);
    if (!expectedBytes || info.size === expectedBytes) {
      onProgress?.({ stage: "encoder-cache-hit", loaded: info.size, total: expectedBytes || info.size, percent: 100 });
      return;
    }
    await rm(destination, { force: true });
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  let existing = 0;
  try {
    existing = (await stat(partial)).size;
  } catch {
    existing = 0;
  }
  if (expectedBytes && existing > expectedBytes) {
    await rm(partial, { force: true });
    existing = 0;
  }

  const headers = existing > 0 ? { Range: `bytes=${existing}-` } : {};
  let response = await fetch(url, { redirect: "follow", headers });
  if ((!response.ok && response.status !== 206) || !response.body) {
    throw new Error(`HTTP ${response.status} downloading encoder`);
  }

  let append = existing > 0 && response.status === 206;
  if (existing > 0 && !append) {
    existing = 0;
    await rm(partial, { force: true });
  }

  const responseLength = Number(response.headers.get("content-length") || 0);
  const total = Number(expectedBytes || (responseLength ? existing + responseLength : 0));
  let loaded = existing;
  let lastPercent = total > 0 ? Math.floor((loaded / total) * 100) - 10 : -10;
  if (existing > 0) {
    onProgress?.({
      stage: "encoder-resume",
      loaded,
      total,
      percent: total > 0 ? Math.floor((loaded / total) * 100) : -1
    });
  }

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      loaded += chunk.length;
      const percent = total > 0 ? Math.floor((loaded / total) * 100) : -1;
      if (percent < 0 || percent >= lastPercent + 10 || percent === 100) {
        lastPercent = percent;
        onProgress?.({ stage: "encoder-download", loaded, total, percent });
      }
      callback(null, chunk);
    }
  });

  await streamPipeline(
    Readable.fromWeb(response.body),
    meter,
    createWriteStream(partial, { flags: append ? "a" : "w" })
  );

  const info = await stat(partial);
  if (expectedBytes && info.size !== expectedBytes) {
    throw new Error(`Encoder download incomplete: got ${info.size}, expected ${expectedBytes}`);
  }
  await rename(partial, destination);
}

function padAudio(samples, frameSize) {
  if (!frameSize || frameSize <= 0) return samples;
  const remainder = samples.length % frameSize;
  if (!remainder) return samples;
  const padded = new Float32Array(samples.length + frameSize - remainder);
  padded.set(samples);
  return padded;
}

export async function saveVoiceProfile(filePath, values) {
  const floats = values instanceof Float32Array ? values : new Float32Array(values);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(floats.length, MAGIC.length);
  const payload = Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.part`;
  await writeFile(tmp, Buffer.concat([header, payload]));
  await rename(tmp, filePath);
}

export async function loadVoiceProfile(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.length < HEADER_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error(`Invalid Aharon voice profile: ${filePath}`);
  }
  const count = bytes.readUInt32LE(MAGIC.length);
  const payload = bytes.subarray(HEADER_BYTES);
  if (payload.length !== count * 4) {
    throw new Error(`Corrupt Aharon voice profile: expected ${count * 4} bytes, got ${payload.length}`);
  }
  const copy = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  return new Float32Array(copy);
}

export async function buildVoiceProfile({
  voiceFile,
  voiceName = "ari",
  profilePath = defaultProfilePath(voiceName),
  encoderPath = defaultEncoderPath(),
  modelsUrl = "",
  force = false,
  keepEncoder = true,
  onProgress
}) {
  if (!force && (await exists(profilePath))) {
    const voice = await loadVoiceProfile(profilePath);
    onProgress?.({ stage: "profile-exists", profilePath, floats: voice.length });
    return { profilePath, floats: voice.length, alreadyExisted: true };
  }

  const base = withSlash(modelsUrl || DEFAULT_MODELS_BASE);
  onProgress?.({ stage: "manifest", base });
  const manifest = await fetchJson(`${base}manifest.json`);
  if (!manifest.encoder?.file) throw new Error("Hebrew model manifest has no voice encoder");
  const assets = await fetchJson(`${base}${manifest.assets.file}`);
  const sampleRate = Number(manifest.sampleRate || assets?.config?.sample_rate || 24000);
  const frameSize = Number(assets?.config?.frame_size || 0);

  await downloadFile(
    `${base}${manifest.encoder.file}`,
    encoderPath,
    Number(manifest.encoder.bytes || 0),
    onProgress
  );

  onProgress?.({ stage: "voice-decode", sampleRate });
  let resolvedVoiceFile = path.resolve(process.cwd(), voiceFile);
  let removeBootstrapVoice = false;
  let decoded = null;

  if (!(await exists(resolvedVoiceFile))) {
    const dir = path.dirname(resolvedVoiceFile);
    const baseName = path.basename(resolvedVoiceFile);

    const readBootstrapText = async (singleSuffix, partPrefix) => {
      const single = `${resolvedVoiceFile}${singleSuffix}`;
      if (await exists(single)) return (await readFile(single, "utf8")).trim();

      let parts = [];
      try {
        parts = (await readdir(dir)).filter((name) => name.startsWith(`${baseName}${partPrefix}`)).sort();
      } catch {
        parts = [];
      }
      if (!parts.length) return "";
      return (await Promise.all(parts.map((name) => readFile(path.join(dir, name), "utf8"))))
        .join("")
        .trim();
    };

    const encodedGzip = await readBootstrapText(".gz.b64", ".gz.b64.part");
    if (encodedGzip) {
      const bytes = gunzipSync(Buffer.from(encodedGzip, "base64"));
      resolvedVoiceFile = path.join(path.dirname(profilePath), `${voiceName}.bootstrap.wav`);
      await mkdir(path.dirname(resolvedVoiceFile), { recursive: true });
      await writeFile(resolvedVoiceFile, bytes);
      removeBootstrapVoice = true;
      onProgress?.({ stage: "voice-bootstrap-decoded", format: "wav-gzip", bytes: bytes.length, voiceFile: resolvedVoiceFile });
    } else {
      const encodedOpus = await readBootstrapText(".opus.b64", ".opus.b64.part");
      if (encodedOpus) {
        const oggBytes = Buffer.from(encodedOpus, "base64");
        const { OggOpusDecoder } = await import("ogg-opus-decoder");
        const decoder = new OggOpusDecoder({ sampleRate });
        try {
          await decoder.ready;
          const result = await decoder.decodeFile(new Uint8Array(oggBytes));
          if (!result?.channelData?.length || !result.samplesDecoded) {
            throw new Error("Ogg Opus bootstrap decoded no audio samples");
          }

          let samples;
          if (result.channelData.length === 1) {
            samples = new Float32Array(result.channelData[0]);
          } else {
            samples = new Float32Array(result.samplesDecoded);
            for (const channel of result.channelData) {
              for (let i = 0; i < samples.length; i += 1) samples[i] += channel[i] / result.channelData.length;
            }
          }

          decoded = {
            samples,
            sourceSampleRate: Number(result.sampleRate || sampleRate),
            durationSec: samples.length / Number(result.sampleRate || sampleRate)
          };
          onProgress?.({
            stage: "voice-bootstrap-decoded",
            format: "ogg-opus",
            bytes: oggBytes.length,
            samples: samples.length,
            sampleRate: decoded.sourceSampleRate,
            durationSec: decoded.durationSec,
            decodeErrors: Array.isArray(result.errors) ? result.errors.length : 0
          });
        } finally {
          decoder.free();
        }
      }
    }
  }

  if (!decoded) decoded = await loadMonoWav(resolvedVoiceFile, sampleRate);
  if (decoded.durationSec < 2) throw new Error("Custom voice sample must be at least 2 seconds");
  const audio = padAudio(decoded.samples, frameSize);
  onProgress?.({
    stage: "voice-decoded",
    durationSec: decoded.durationSec,
    sourceSampleRate: decoded.sourceSampleRate,
    sampleRate,
    samples: audio.length,
    frameSize
  });

  onProgress?.({ stage: "encoder-session-create", encoderPath });
  const ort = await import("onnxruntime-node");
  let session;
  try {
    session = await ort.InferenceSession.create(encoderPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: 1,
      interOpNumThreads: 1
    });
    onProgress?.({ stage: "encoder-run" });
    const input = new ort.Tensor("float32", audio, [1, 1, audio.length]);
    const output = await session.run({ audio: input });
    const tensor = output.cond || output[session.outputNames[0]];
    if (!tensor?.data) throw new Error("Voice encoder returned no conditioning tensor");
    const voice = new Float32Array(tensor.data);
    await saveVoiceProfile(profilePath, voice);
    onProgress?.({ stage: "profile-saved", profilePath, floats: voice.length, bytes: voice.byteLength + HEADER_BYTES });
    return {
      profilePath,
      floats: voice.length,
      bytes: voice.byteLength + HEADER_BYTES,
      durationSec: decoded.durationSec,
      sampleRate,
      alreadyExisted: false
    };
  } finally {
    if (session) {
      try {
        await session.release();
      } catch {
      }
    }
    if (!keepEncoder) {
      try {
        await rm(encoderPath, { force: true });
      } catch {
      }
    }
    if (removeBootstrapVoice) {
      try {
        await rm(resolvedVoiceFile, { force: true });
        onProgress?.({ stage: "voice-bootstrap-deleted", voiceFile: resolvedVoiceFile });
      } catch {
      }
    }
  }
}

export async function inspectVoiceProfile(filePath) {
  try {
    const voice = await loadVoiceProfile(filePath);
    return { exists: true, floats: voice.length, bytes: voice.byteLength + HEADER_BYTES };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, floats: 0, bytes: 0 };
    throw error;
  }
}
