import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { OggOpusDecoder } from "ogg-opus-decoder";

function homeRoot() {
  for (const value of [process.cwd(), process.env.HOME, homedir()].filter(Boolean)) {
    const match = path.resolve(String(value)).match(/^(\/home\/[^/]+)(?:\/|$)/);
    if (match) return match[1];
  }
  return homedir();
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function encodePcm16Wav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.allocUnsafe(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), 44 + i * 2);
  }
  return buffer;
}

async function prepareTemporaryVoiceSource() {
  const cacheDir = path.join(homeRoot(), ".cache", "aharon-tts");
  const profilePath = process.env.TTS_VOICE_PROFILE_FILE || path.join(cacheDir, "ari.voice");
  if (await exists(profilePath)) {
    console.log(`[BOOTSTRAP] prepared profile already exists: ${profilePath}`);
    return;
  }

  const configuredSource = String(process.env.TTS_VOICE_FILE || "").trim();
  if (configuredSource) {
    const absolute = path.resolve(process.cwd(), configuredSource);
    if (await exists(absolute)) {
      console.log(`[BOOTSTRAP] configured voice source exists: ${absolute}`);
      return;
    }
  }

  const encodedPart00 = path.resolve(process.cwd(), "voices/ari.wav.opus.b64.part00");
  const encodedPart01 = path.resolve(process.cwd(), "voices/ari.wav.opus.b64.part01");
  if (!(await exists(encodedPart00)) || !(await exists(encodedPart01))) {
    console.warn(`[BOOTSTRAP] temporary voice bootstrap parts are missing`);
    return;
  }

  await mkdir(cacheDir, { recursive: true });
  const tempWav = path.join(cacheDir, "ari-bootstrap.wav");
  const encoded = `${(await readFile(encodedPart00, "utf8")).trim()}${(await readFile(encodedPart01, "utf8")).trim()}`;
  const oggBytes = new Uint8Array(Buffer.from(encoded, "base64"));
  const decoder = new OggOpusDecoder({ sampleRate: 24000 });
  try {
    await decoder.ready;
    const result = await decoder.decodeFile(oggBytes);
    const samples = result.channelData?.[0];
    const sampleRate = Number(result.sampleRate || 24000);
    if (!samples?.length) throw new Error("Temporary Opus voice decoded no audio samples");
    await writeFile(tempWav, encodePcm16Wav(samples, sampleRate));
    process.env.TTS_VOICE_FILE = tempWav;
    const info = await stat(tempWav);
    console.log(
      `[BOOTSTRAP] temporary voice ready: ${tempWav} ` +
        `duration=${(samples.length / sampleRate).toFixed(3)}s bytes=${info.size}`
    );
  } finally {
    decoder.free();
  }
}

await prepareTemporaryVoiceSource();
await import("./server.js");
