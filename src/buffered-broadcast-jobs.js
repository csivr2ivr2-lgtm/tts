import { generateFullSegment } from './full-segment.js';

export function createBufferedJobs({ store, broadcast, initialize, resolveVoice, enqueueInference, toPcm, now = Date.now, maxBytes, decodeSteps, onChange = () => {} }) {
  const pending = new Map(), ready = new Map();
  let active = null, pumping = false, sequence = 0, retryAt = 0;
  const stats = {completed:0,failed:0,recovered:0,lastId:null,lastStatus:null,lastError:null};
  function patch(id, changes) { const job = store.patch(id, changes); if (job) { Object.assign(stats,{lastId:id,lastStatus:job.status,lastError:job.lastError||null}); onChange(job); } return job; }
  function valid(job) { return !job.validUntil || job.validUntil > now(); }
  function queueReady(job) {
    job=store.get(job.id);
    if(!job||['failed','expired','interrupted','completed'].includes(job.status)){if(job)ready.delete(job.id);return job;}
    if (!valid(job)) {ready.delete(job.id);return patch(job.id,{status:'expired'});}
    ready.set(job.id,job);
    if (job.prepareOnly && !job.releaseRequested) return job;
    if (broadcast.hasSegment(job.id)) {ready.delete(job.id);return job;}
    if (!broadcast.canEnqueue(job.audioBytes,job.priority)) return job;
    const pcm = store.readAudio(job);
    if (!pcm) throw new Error('audio_missing');
    if (!broadcast.canEnqueue(pcm.length,job.priority)) return job;
    // Durable claim precedes insertion; restart can safely reinsert a queued, unstarted job.
    const queued = patch(job.id,{status:'queued',queuedAt:job.queuedAt??now(),ttsStatus:'complete',playbackReleased:true,chunksQueued:1,totalChunks:1});
    try {
      broadcast.enqueueSegment({id:job.id,pcm,sampleRate:job.sampleRate,meta:{parentJobId:job.id,type:job.type,priority:job.priority,voice:job.resolvedVoice||job.voice,speakerId:job.speakerId,eventId:job.eventId,gapMs:0,validUntil:job.validUntil,notBefore:job.notBefore}});
    } catch (e) { patch(job.id,{status:'audio-ready',playbackReleased:false}); throw e; }
    ready.delete(job.id);return queued;
  }
  async function produce(job) {
    if (!valid(job)) return patch(job.id,{status:'expired'});
    if (job.audioSha256) { queueReady(job); return; }
    const recovered=store.readAudioRecord?.(job.id);
    if(recovered){const {pcm,...metrics}=recovered;queueReady(patch(job.id,{...metrics,status:'audio-ready',ttsStatus:'complete',readyAt:job.readyAt??now()}));return;}
    patch(job.id,{status:'generating',startedAt:now(),attempts:Number(job.attempts||0)+1,lastError:null,ttsStatus:'generating',playbackReleased:false});
    const engine = await initialize(), voice = resolveVoice(job.voice||'');
    const audio = await enqueueInference(()=>generateFullSegment({engine,text:job.text,options:{voice:voice.value,...(decodeSteps?{decodeSteps}:{})},toPcm,maxBytes,now}));
    const {pcm,...metrics}=audio;
    const stored = store.saveAudio(job.id,pcm,audio.sampleRate,metrics);
    const ready = patch(job.id,{...metrics,...stored,status:'audio-ready',ttsStatus:'complete',resolvedVoice:voice.name,readyAt:now(),playbackReleased:false});
    queueReady(ready);
  }
  async function pump() {
    if(pumping||now()<retryAt)return; pumping=true;
    try {
      while(pending.size){
        const next=[...pending.values()].sort((a,b)=>(b.job.priority??50)-(a.job.priority??50)||a.sequence-b.sequence)[0];
        pending.delete(next.job.id); active=next.job.id;
        try { await produce(store.get(active)); }
        catch {
          ready.delete(active);
          try {stats.failed++;patch(active,{status:'failed',ttsStatus:'failed',lastError:'broadcast_generation_or_storage_failed',finishedAt:now()});}
          catch {pending.set(next.job.id,next);retryAt=now()+5000;stats.lastError='broadcast_storage_unavailable';break;}
        }
        finally { active=null; }
      }
    } finally { pumping=false; }
  }
  function schedule(job,{recovered=false}={}) {
    if(!job||active===job.id||pending.has(job.id)||['completed','expired','interrupted'].includes(job.status))return false;
    if(recovered){
      stats.recovered++;
      // Hardware output cannot be atomically committed with JSON. Choose at-most-once:
      // anything possibly already audible is interrupted, never replayed automatically.
      if(['playing','streaming'].includes(job.status)||job.playbackStartedAt||job.lastPlaybackStartedAt||(!job.audioSha256&&job.playbackReleased)){
        patch(job.id,{status:'interrupted',lastError:'restart_after_playback_claim',finishedAt:now()});return false;
      }
    }
    pending.set(job.id,{job,sequence:sequence++}); queueMicrotask(()=>{void pump().catch(()=>{retryAt=now()+5000;stats.lastError='broadcast_storage_unavailable'});});return true;
  }
  function release(id){
    const job=store.get(id);if(!job)return null;
    if(['queued','playing','completed','interrupted','expired','failed'].includes(job.status))return job;
    if(job.status!=='audio-ready')throw new Error('audio_not_ready');
    return queueReady(patch(id,{releaseRequested:true}));
  }
  function refill(){
    if(pending.size&&!pumping&&now()>=retryAt)void pump().catch(()=>{retryAt=now()+5000;stats.lastError='broadcast_storage_unavailable'});
    for(const j of [...ready.values()].sort((a,b)=>b.priority-a.priority||a.createdAt-b.createdAt)){
      try{queueReady(j)}catch{try{ready.delete(j.id);patch(j.id,{status:'failed',lastError:'audio_integrity_or_queue_failed'})}catch{ready.set(j.id,j);stats.lastError='broadcast_storage_unavailable'}}
    }
  }
  broadcast.setBeforeDefer(segment=>{
    const id=segment.meta?.parentJobId;if(!id)return false;
    const job=store.get(id);if(!job||job.status!=='queued'||job.playbackStartedAt)return false;
    const deferred=patch(id,{status:'audio-ready',playbackReleased:false});ready.set(id,deferred);return true;
  });
  // Called before the first byte is sent; a failed durable claim prevents playback.
  broadcast.setBeforeStart(segment=>{
    const id=segment.meta?.parentJobId;if(!id)return true;
    const job=store.get(id);if(!job||['completed','interrupted','expired','failed'].includes(job.status))return false;
    if(!valid(job)){patch(id,{status:'expired'});return false;}
    patch(id,{status:'playing',playbackStartedAt:now(),lastPlaybackStartedAt:now(),queueWaitMs:Math.max(0,now()-(job.queuedAt??now()))});return true;
  });
  broadcast.subscribe(event=>{
    const id=event.segment?.meta?.parentJobId;if(!id)return;
    if(event.type==='expired'){patch(id,{status:'expired'});return;}
    if(event.type==='finished'){
      patch(id,{status:'completed',playedChunks:1,playbackFinishedAt:event.at,lastPlaybackFinishedAt:event.at,finishedAt:event.at,playedAt:event.at});stats.completed++;
      store.prune();queueMicrotask(refill);
    }
  });
  return {schedule,release,refill,info:()=>({...stats,active:active?1:0,activeJob:active,queue:[...pending.keys()],concurrency:1,fullSegmentBuffering:true,retryAt:retryAt>now()?retryAt:null})};
}
