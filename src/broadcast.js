const DEFAULT_CHUNK_MS = Number(process.env.BROADCAST_CHUNK_MS || 100);
const DEFAULT_GAP_MS = Number(process.env.BROADCAST_GAP_MS || 120);
const MAX_QUEUE_SEGMENTS = Number(process.env.BROADCAST_MAX_QUEUE_SEGMENTS || 50);

function clampPcm16(sample) {
  const x = Math.max(-1, Math.min(1, Number(sample) || 0));
  return x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
}

export function float32ToPcm16(samples) {
  const input = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
  const out = Buffer.allocUnsafe(input.length * 2);
  for (let i = 0; i < input.length; i += 1) out.writeInt16LE(clampPcm16(input[i]), i * 2);
  return out;
}

export function streamingWavHeader(sampleRate, channels = 1, bitsPerSample = 16) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(0xffffffff, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0xffffffff, 40);
  return header;
}

export function createBroadcastEngine(options = {}) {
  const chunkMs = Math.max(20, Number(options.chunkMs || DEFAULT_CHUNK_MS));
  const gapMs = Math.max(0, Number(options.gapMs ?? DEFAULT_GAP_MS));
  const maxQueueSegments = Math.max(1, Number(options.maxQueueSegments || MAX_QUEUE_SEGMENTS));
  let sampleRate = Number(options.sampleRate || 0) || null;
  const listeners = new Set();
  const queue = [];
  let current = null;
  let currentOffset = 0;
  let timer = null;
  let playedSegments = 0;
  let droppedSegments = 0;
  let bytesSent = 0;
  let lastStartedAt = null;
  let lastFinishedAt = null;

  function bytesPerTick() {
    if (!sampleRate) return 0;
    const frames = Math.max(1, Math.round((sampleRate * chunkMs) / 1000));
    return frames * 2;
  }

  function broadcast(buffer) {
    for (const res of [...listeners]) {
      if (res.destroyed || res.writableEnded) {
        listeners.delete(res);
        continue;
      }
      try {
        res.write(buffer);
        bytesSent += buffer.length;
      } catch {
        listeners.delete(res);
        try { res.destroy(); } catch {}
      }
    }
  }

  function startNext() {
    current = queue.shift() || null;
    currentOffset = 0;
    if (current) {
      current.startedAt = Date.now();
      lastStartedAt = current.startedAt;
    }
  }

  function finishCurrent() {
    if (!current) return;
    current.finishedAt = Date.now();
    lastFinishedAt = current.finishedAt;
    playedSegments += 1;
    current = null;
    currentOffset = 0;
  }

  function tick() {
    const chunkBytes = bytesPerTick();
    if (!chunkBytes) return;
    if (!current) startNext();

    if (!current) {
      broadcast(Buffer.alloc(chunkBytes));
      return;
    }

    const end = Math.min(currentOffset + chunkBytes, current.pcm.length);
    const part = current.pcm.subarray(currentOffset, end);
    currentOffset = end;
    if (part.length) broadcast(part);

    if (part.length < chunkBytes) broadcast(Buffer.alloc(chunkBytes - part.length));

    if (currentOffset >= current.pcm.length) {
      if (!current.gapAppended) {
        const gapBytes = Math.round((sampleRate * gapMs) / 1000) * 2;
        current.gapAppended = true;
        if (gapBytes > 0) current.pcm = Buffer.concat([current.pcm, Buffer.alloc(gapBytes)]);
      }
      if (currentOffset >= current.pcm.length) finishCurrent();
    }
  }

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(tick, chunkMs);
    timer.unref?.();
  }

  function setSampleRate(nextRate) {
    const rate = Number(nextRate);
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) throw new Error(`Invalid broadcast sample rate: ${nextRate}`);
    if (sampleRate && sampleRate !== rate) throw new Error(`Broadcast sample rate already locked to ${sampleRate}, got ${rate}`);
    sampleRate = rate;
    ensureTimer();
    return sampleRate;
  }

  function enqueueSegment({ id, pcm, sampleRate: segmentRate, meta = {} }) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) throw new Error("Broadcast segment PCM is empty");
    setSampleRate(segmentRate);
    if (queue.length >= maxQueueSegments) {
      queue.shift();
      droppedSegments += 1;
    }
    const item = {
      id: id || `seg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      pcm,
      sampleRate,
      durationSec: pcm.length / (sampleRate * 2),
      meta,
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      gapAppended: false,
    };
    const priority = Number.isFinite(Number(meta?.priority)) ? Number(meta.priority) : 50;
    item.priority = priority;
    const index = queue.findIndex((queued) => Number(queued.priority || 50) < priority);
    if (index === -1) queue.push(item); else queue.splice(index, 0, item);
    return { ...item, pcm: undefined };
  }

  function attach(res) {
    if (!sampleRate) throw new Error("Broadcast sample rate is not initialized");
    res.status(200).set({
      "Content-Type": "audio/wav",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    res.flushHeaders?.();
    res.write(streamingWavHeader(sampleRate));
    listeners.add(res);
    const cleanup = () => listeners.delete(res);
    res.on("close", cleanup);
    res.on("error", cleanup);
    ensureTimer();
  }

  function info() {
    return {
      sampleRate,
      format: "pcm_s16le_wav_stream",
      chunkMs,
      gapMs,
      listeners: listeners.size,
      queuedSegments: queue.length,
      current: current ? {
        id: current.id,
        durationSec: Number(current.durationSec.toFixed(3)),
        progressSec: sampleRate ? Number((currentOffset / (sampleRate * 2)).toFixed(3)) : 0,
        priority: current.priority,
        meta: current.meta,
        queuedAt: current.queuedAt,
        startedAt: current.startedAt,
      } : null,
      next: queue.slice(0, 5).map((item) => ({
        id: item.id,
        durationSec: Number(item.durationSec.toFixed(3)),
        priority: item.priority,
        meta: item.meta,
        queuedAt: item.queuedAt,
      })),
      playedSegments,
      droppedSegments,
      bytesSent,
      lastStartedAt,
      lastFinishedAt,
    };
  }

  return { attach, enqueueSegment, info, setSampleRate };
}
