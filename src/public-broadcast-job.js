// Explicit allowlist: never reflect request metadata, credentials or internal paths.
const fields = ['id','type','priority','voice','speakerId','eventId','status','attempts','createdAt','updatedAt',
'chunksQueued','playedChunks','totalChunks','ttsStatus','generationStartedAt','generationFinishedAt','generationMs',
'generatedAudioSec','generationRtRatio','audioBytes','readyAt','queueWaitMs','playbackStartedAt','playbackFinishedAt',
'queuedAt','finishedAt','playedAt','playbackReleased','prepareOnly','notBefore','validUntil','lastError'];
export function publicBroadcastJob(job) {
  if(!job)return null;
  return Object.fromEntries(fields.filter(key=>Object.hasOwn(job,key)).map(key=>[key,key==='lastError'?(job[key]?'broadcast_job_failed':null):job[key]]));
}
