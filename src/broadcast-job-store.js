import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function createJobStore({ directory = process.env.BROADCAST_JOB_DIR || path.join(os.homedir(), '.cache', 'aharon-tts', 'broadcast-jobs'), maxFiles = Number(process.env.BROADCAST_JOB_MAX_FILES || 200), now = Date.now } = {}) {
  const terminal = new Set(['completed', 'failed', 'expired', 'interrupted']);
  const ensure = () => fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = (id, ext = '.json') => path.join(directory, crypto.createHash('sha256').update(String(id)).digest('hex') + ext);
  function atomic(file, bytes) {
    ensure();
    const tmp = file + '.' + crypto.randomUUID() + '.tmp';
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, file);
      const dirFd = fs.openSync(directory, 'r'); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch {} }
  }
  function get(id) { try { const j = JSON.parse(fs.readFileSync(filename(id), 'utf8')); return j.id === id ? j : null; } catch (e) { if (e.code === 'ENOENT') return null; throw new Error('job_state_unreadable'); } }
  function save(job) { const t = now(), value = { ...job, createdAt: job.createdAt ?? t, updatedAt: t }; atomic(filename(job.id), JSON.stringify(value)); return value; }
  function patch(id, changes) { const job = get(id); return job ? save({ ...job, ...changes, id }) : null; }
  function all() {
    ensure();
    return fs.readdirSync(directory).filter(n => n.endsWith('.json')).map(n => {
      try { return JSON.parse(fs.readFileSync(path.join(directory, n), 'utf8')); } catch { throw new Error('job_state_unreadable'); }
    });
  }
  function prune() {
    // Retain idempotency tombstones forever; only remove terminal audio, never active jobs.
    const jobs = all().filter(j => terminal.has(j.status)).sort((a,b) => b.updatedAt - a.updatedAt);
    for (const j of jobs.slice(Math.max(1, maxFiles))) { try { fs.unlinkSync(filename(j.id, '.pcm')); } catch {} }
  }
  function create(job) { const old = get(job.id); return old ? {created:false,job:old} : {created:true,job:save(job)}; }
  function saveAudio(id, pcm, sampleRate, metrics = {}) {
    if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error('invalid_pcm');
    const record = { ...metrics, id, audioBytes: pcm.length, sampleRate, audioSha256: crypto.createHash('sha256').update(pcm).digest('hex') };
    const header=Buffer.from(JSON.stringify(record)),size=Buffer.alloc(4);size.writeUInt32LE(header.length);
    // One atomic file contains both the completion descriptor and all PCM. Recovery
    // never needs to guess whether an orphaned raw audio file was complete.
    atomic(filename(id, '.pcm'), Buffer.concat([size,header,pcm]));
    return record;
  }
  function readAudioRecord(id) {
    let data;try{data=fs.readFileSync(filename(id,'.pcm'))}catch(e){if(e.code==='ENOENT')return null;throw e}
    if(data.length<4)throw new Error('audio_integrity_failed');
    const length=data.readUInt32LE(0);if(length>65536||length+4>=data.length)throw new Error('audio_integrity_failed');
    let record;try{record=JSON.parse(data.toString('utf8',4,4+length))}catch{throw new Error('audio_integrity_failed')}
    const pcm=data.subarray(4+length);
    if(record.id!==id||!Number.isInteger(record.sampleRate)||record.sampleRate<8000||record.sampleRate>192000||!pcm.length||pcm.length%2||pcm.length!==record.audioBytes||crypto.createHash('sha256').update(pcm).digest('hex')!==record.audioSha256)throw new Error('audio_integrity_failed');
    return { ...record, pcm };
  }
  function readAudio(job) {
    const record=readAudioRecord(job.id);if(!record)return null;
    if(job.audioSha256&&(job.audioSha256!==record.audioSha256||job.audioBytes!==record.audioBytes))throw new Error('audio_integrity_failed');
    return record.pcm;
  }
  return {get,save,patch,all,prune,create,saveAudio,readAudio,readAudioRecord,
    recoverable: (limit=Infinity) => all().filter(j=>!terminal.has(j.status)).sort((a,b)=>a.createdAt-b.createdAt).slice(0,limit),
    info: () => ({files:all().length,maxFiles,audioRetention:'terminal-audio-only',persistent:true})};
}
const store = createJobStore();
export const getBroadcastJob = store.get, saveBroadcastJob = store.save, patchBroadcastJob = store.patch;
export const createBroadcastJob = store.create, recoverableBroadcastJobs = store.recoverable;
export const pruneBroadcastJobs = store.prune, broadcastJobStoreInfo = store.info;
export const saveBroadcastAudio = store.saveAudio, readBroadcastAudio = store.readAudio;

export const readBroadcastAudioRecord = store.readAudioRecord;
