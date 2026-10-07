import { fileURLToPath } from "node:url";
import { createYouTubePublisher } from "./youtube/youtube-publisher.js";

const DEFAULT_CHUNK_MS = Number(process.env.BROADCAST_CHUNK_MS || 100);
const DEFAULT_GAP_MS = Number(process.env.BROADCAST_GAP_MS || 120);
const MAX_QUEUE_SEGMENTS = Number(process.env.BROADCAST_MAX_QUEUE_SEGMENTS || 250);
const DEFAULT_YOUTUBE_BACKGROUND = fileURLToPath(new URL("../assets/youtube/poto.png", import.meta.url));

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
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0xffffffff, 40);
  return header;
}

export function createBroadcastEngine(options = {}) {
  const chunkMs = Math.max(20, Number(options.chunkMs || DEFAULT_CHUNK_MS));
  const gapMs = Math.max(0, Number(options.gapMs ?? DEFAULT_GAP_MS));
  const maxQueueSegments = Math.max(1, Number(options.maxQueueSegments || MAX_QUEUE_SEGMENTS));
  const now = options.now || Date.now;
  const maxQueueBytes = Number(options.maxQueueBytes || 64 * 1024 * 1024);
  let beforeStart = () => true;
  let beforeDefer = () => false;
  let fillerProvider = null;
  let sampleRate = Number(options.sampleRate || 0) || null;
  const listeners = new Set();
  const rawListeners = new Set();
  const pcmListeners = new Set();
  const eventListeners = new Set();
  const queue = [];
  let current = null;
  let currentOffset = 0;
  let timer = null;
  let playedSegments = 0;
  let droppedSegments = 0;
  let bytesSent = 0;
  let lastStartedAt = null;
  let lastFinishedAt = null;
  let api = null;
  let youtube = null;
  let youtubeStartRequested = false;

  function youtubeOptions() {
    return {
      enabled: process.env.YOUTUBE_LIVE_ENABLED === "true",
      url: process.env.YOUTUBE_RTMPS_URL || "rtmps://a.rtmps.youtube.com/live2",
      streamKey: process.env.YOUTUBE_STREAM_KEY || "",
      backgroundFile: process.env.YOUTUBE_BACKGROUND_FILE || DEFAULT_YOUTUBE_BACKGROUND,
      width: Math.max(320, Number(process.env.YOUTUBE_WIDTH || 1280)),
      height: Math.max(240, Number(process.env.YOUTUBE_HEIGHT || 720)),
      fps: Math.max(1, Math.min(60, Number(process.env.YOUTUBE_FPS || 30))),
      gopSeconds: Math.max(1, Math.min(4, Number(process.env.YOUTUBE_GOP_SECONDS || 2))),
      videoBitrateKbps: Math.max(300, Number(process.env.YOUTUBE_VIDEO_BITRATE_KBPS || 2500)),
      reconnectMs: Math.max(1000, Number(process.env.YOUTUBE_RECONNECT_MS || 5000)),
    };
  }

  function ensureYouTube() {
    if (!youtube) youtube = createYouTubePublisher({ broadcast: api, options: youtubeOptions() });
    return youtube;
  }

  function maybeStartYouTube() {
    if (process.env.YOUTUBE_LIVE_ENABLED !== "true" || youtubeStartRequested) return;
    youtubeStartRequested = true;
    queueMicrotask(() => {
      try {
        ensureYouTube().start();
        console.log("[YOUTUBE] direct publisher auto-start requested");
      } catch (error) {
        youtubeStartRequested = false;
        console.error("[YOUTUBE] auto-start failed:", error instanceof Error ? error.message : String(error));
      }
    });
  }

  function bytesPerTick() {
    if (!sampleRate) return 0;
    const frames = Math.max(1, Math.round((sampleRate * chunkMs) / 1000));
    return frames * 2;
  }

  function writeTo(set, buffer) {
    for (const res of [...set]) {
      if (res.destroyed || res.writableEnded) {
        set.delete(res);
        continue;
      }
      try {
        res.write(buffer);
        bytesSent += buffer.length;
      } catch {
        set.delete(res);
        try { res.destroy(); } catch {}
      }
    }
  }

  function broadcast(buffer) {
    writeTo(listeners, buffer);
    writeTo(rawListeners, buffer);
    for (const listener of [...pcmListeners]) {
      try { listener(buffer, sampleRate); } catch {}
    }
  }

  function publicItem(item) {
    if (!item) return null;
    return {
      id: item.id,
      sampleRate: item.sampleRate,
      durationSec: item.durationSec,
      priority: item.priority,
      meta: item.meta,
      queuedAt: item.queuedAt,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
    };
  }

  function emit(event) {
    for (const listener of [...eventListeners]) {
      try { listener(event); } catch {}
    }
  }

  function queuedBytes() { return queue.reduce((sum,item)=>sum+item.pcm.length,0)+(current?.pcm.length||0); }
  function displacementPlan(bytes, priority = -Infinity) {
    let total=queuedBytes()+bytes,count=queue.length+1;const displaced=[];
    if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>maxQueueBytes)return null;
    for(const item of [...queue].reverse()){
      if(total<=maxQueueBytes&&count<=maxQueueSegments)break;
      if(item.meta?.parentJobId&&item.priority<priority){displaced.push(item);total-=item.pcm.length;count--;}
    }
    return total<=maxQueueBytes&&count<=maxQueueSegments?displaced:null;
  }
  function canEnqueue(bytes, priority = -Infinity) { return displacementPlan(bytes,priority)!==null; }
  function startNext() {
    currentOffset=0;
    for(let i=0;i<queue.length;){
      const item=queue[i];
      if(item.meta.validUntil && item.meta.validUntil<=now()) {
        queue.splice(i,1);emit({type:'expired',segment:publicItem(item),at:now()});continue;
      }
      if(item.meta.notBefore && item.meta.notBefore>now()){i++;continue;}
      queue.splice(i,1);
      try { if(!beforeStart(publicItem(item)))continue; }
      catch { emit({type:'start-blocked',segment:publicItem(item),at:now()});queue.splice(i,0,item);return; }
      current=item;break;
    }
    if(!current && fillerProvider){
      const filler=fillerProvider(now());
      if(filler?.pcm?.length && filler.sampleRate===sampleRate)current={...filler,priority:filler.meta?.priority??1,queuedAt:now(),durationSec:filler.pcm.length/(sampleRate*2),gapAppended:true};
    }
    if(current){current.startedAt=now();lastStartedAt=current.startedAt;emit({type:'started',segment:publicItem(current),at:current.startedAt});}
  }

  function finishCurrent() {
    if (!current) return;
    current.finishedAt = now();
    lastFinishedAt = current.finishedAt;
    playedSegments += 1;
    emit({ type: "finished", segment: publicItem(current), at: current.finishedAt });
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
        const segmentGapMs = Number.isFinite(Number(current.meta?.gapMs)) ? Math.max(0, Number(current.meta.gapMs)) : gapMs;
        const gapBytes = Math.round((sampleRate * segmentGapMs) / 1000) * 2;
        current.gapAppended = true;
        if (gapBytes > 0) current.pcm = Buffer.concat([current.pcm, Buffer.alloc(gapBytes)]);
      }
      if (currentOffset >= current.pcm.length) finishCurrent();
    }
  }

  function ensureTimer() {
    if (timer || options.manual === true) return;
    timer = setInterval(tick, chunkMs);
    timer.unref?.();
  }

  function setSampleRate(nextRate) {
    const rate = Number(nextRate);
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) throw new Error(`Invalid broadcast sample rate: ${nextRate}`);
    if (sampleRate && sampleRate !== rate) throw new Error(`Broadcast sample rate already locked to ${sampleRate}, got ${rate}`);
    sampleRate = rate;
    ensureTimer();
    maybeStartYouTube();
    return sampleRate;
  }

  function enqueueSegment({ id, pcm, sampleRate: segmentRate, meta = {} }) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2) throw new Error("Broadcast segment PCM is empty");
    setSampleRate(segmentRate);
    if (id && (current?.id === id || queue.some(item=>item.id===id))) throw new Error("duplicate_segment");
    const priority = meta?.priority !== null && meta?.priority !== undefined && Number.isFinite(Number(meta.priority)) ? Number(meta.priority) : 50;
    const segmentGapMs = Number.isFinite(Number(meta.gapMs)) ? Math.max(0,Number(meta.gapMs)) : gapMs;
    const gapBytes=Math.round(sampleRate*segmentGapMs/1000)*2;
    const displaced=displacementPlan(pcm.length+gapBytes,priority);
    if(!displaced)throw new Error("broadcast_queue_full");
    for(const queued of displaced){
      if(!beforeDefer(publicItem(queued)))throw new Error("broadcast_queue_full");
      queue.splice(queue.indexOf(queued),1);emit({type:'deferred',segment:publicItem(queued),at:now()});
    }
    const item = {
      id: id || `seg_${now()}_${Math.random().toString(36).slice(2, 8)}`,
      pcm: Buffer.from(pcm),
      sampleRate,
      durationSec: pcm.length / (sampleRate * 2),
      meta,
      queuedAt: now(),
      startedAt: null,
      finishedAt: null,
      gapAppended: true,
    };
    if(gapBytes>0)item.pcm=Buffer.concat([item.pcm,Buffer.alloc(gapBytes)]);
    item.priority = priority;
    const index = queue.findIndex((queued) => Number(queued.priority ?? 50) < priority);
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

  function attachRaw(res) {
    if (!sampleRate) throw new Error("Broadcast sample rate is not initialized");
    res.status(200).set({
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "X-Audio-Format": "pcm_s16le",
      "X-Audio-Sample-Rate": String(sampleRate),
      "X-Audio-Channels": "1",
    });
    res.flushHeaders?.();
    rawListeners.add(res);
    const cleanup = () => rawListeners.delete(res);
    res.on("close", cleanup);
    res.on("error", cleanup);
    ensureTimer();
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new Error("Broadcast listener must be a function");
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  }

  function subscribePcm(listener) {
    if (typeof listener !== "function") throw new Error("PCM listener must be a function");
    pcmListeners.add(listener);
    ensureTimer();
    return () => pcmListeners.delete(listener);
  }

  function info() {
    return {
      sampleRate,
      format: "pcm_s16le_wav_stream",
      chunkMs,
      gapMs,
      listeners: listeners.size + rawListeners.size + pcmListeners.size,
      wavListeners: listeners.size,
      rawListeners: rawListeners.size,
      internalPcmListeners: pcmListeners.size,
      queuedSegments: queue.length,
      readyAudioSec: queue.filter(x=>!x.meta.notBefore||x.meta.notBefore<=now()).reduce((sum,x)=>sum+x.durationSec,0),
      coverageUntil: now()+queue.filter(x=>!x.meta.notBefore||x.meta.notBefore<=now()).reduce((sum,x)=>sum+x.durationSec*1000,0),
      mode: current ? (current.meta?.music ? current.meta.mode : 'VOICE_PLAYING') : (queue.length ? 'VOICE_READY' : 'WAITING_FOR_READY_PROGRAM'),
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
      youtube: youtube ? youtube.info() : {
        enabled: process.env.YOUTUBE_LIVE_ENABLED === "true",
        configured: Boolean(process.env.YOUTUBE_STREAM_KEY),
        status: process.env.YOUTUBE_LIVE_ENABLED === "true" ? "waiting-for-tts" : "disabled",
        connected: false,
      },
    };
  }

  api = {
    attach,
    attachRaw,
    enqueueSegment,
    canEnqueue,
    hasSegment: id => current?.id === id || queue.some(item=>item.id===id),
    setBeforeStart: fn => { beforeStart=fn; },
    setBeforeDefer: fn => { beforeDefer=fn; },
    setFillerProvider: fn => { fillerProvider=fn; },
    tick,
    close: () => { if(timer)clearInterval(timer); timer=null; youtube?.stop(); },
    info,
    setSampleRate,
    subscribe,
    subscribePcm,
    startYouTube: () => ensureYouTube().start(),
    stopYouTube: () => youtube ? youtube.stop() : null,
    youtubeInfo: () => youtube ? youtube.info() : null,
  };
  return api;
}
