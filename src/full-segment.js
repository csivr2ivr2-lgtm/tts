// Collect one complete utterance. No playout callback exists inside this loop.
export async function generateFullSegment({ engine, text, options, toPcm, maxBytes = 32 * 1024 * 1024, now = Date.now }) {
  maxBytes = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 32 * 1024 * 1024;
  const startedAt = now();
  const sampleRate = engine.sampleRate;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('invalid_sample_rate');
  const chunks = [];
  let bytes = 0, frames = 0, firstFrameAt = null;
  const accept = samples => {
    if (!(samples instanceof Float32Array)) throw new Error('invalid_tts_frame');
    if (!samples.length) return;
    for (const sample of samples) if (!Number.isFinite(sample)) throw new Error('invalid_tts_sample');
    bytes += samples.length * 2;
    if (bytes > maxBytes) throw new Error('segment_audio_limit');
    if (firstFrameAt === null) firstFrameAt = now();
    chunks.push(toPcm(samples));
    frames++;
  };
  if (typeof engine.stream === 'function') {
    for await (const frame of engine.stream(text, options)) accept(frame);
  } else accept(await engine.speak(text, options));
  if (!bytes || bytes % 2) throw new Error('empty_or_invalid_pcm');
  const finishedAt = now(), generationMs = Math.max(0, finishedAt - startedAt);
  const generatedAudioSec = bytes / (sampleRate * 2);
  return { pcm: Buffer.concat(chunks, bytes), sampleRate, audioBytes: bytes, frames, firstFrameAt,
    generationStartedAt: startedAt, generationFinishedAt: finishedAt, generationMs, generatedAudioSec,
    // Audio seconds produced per second spent generating; >1 means faster than playback.
    generationRtRatio: generatedAudioSec / Math.max(0.001, generationMs / 1000) };
}
