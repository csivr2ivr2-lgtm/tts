import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJobStore} from '../src/broadcast-job-store.js';
import {createBroadcastEngine,float32ToPcm16} from '../src/broadcast.js';
import {createBufferedJobs} from '../src/buffered-broadcast-jobs.js';
import {generateFullSegment} from '../src/full-segment.js';
import {publicBroadcastJob} from '../src/public-broadcast-job.js';
import {createMusicLibrary,isNight} from '../src/music-library.js';
const flush=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise}};
function fixture(t,{engine,maxBytes,maxQueueBytes}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'radio-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let now=1000;const clock=()=>now;
 const store=createJobStore({directory,now:clock,maxFiles:1}),broadcast=createBroadcastEngine({sampleRate:8000,chunkMs:100,gapMs:0,manual:true,now:clock,maxQueueBytes});
 const output=[];broadcast.subscribePcm(b=>output.push(Buffer.from(b)));
 const jobs=createBufferedJobs({store,broadcast,initialize:async()=>engine||{sampleRate:8000,speak:async()=>new Float32Array(3200).fill(.5)},resolveVoice:()=>({name:'michael',value:'michael'}),enqueueInference:fn=>fn(),toPcm:float32ToPcm16,now:clock,maxBytes});
 const add=(id,extra={})=>{const j=store.create({id,text:'שלום',voice:'michael',status:'pending',priority:25,...extra}).job;jobs.schedule(j);return j};
 const tick=()=>{now+=100;broadcast.tick()};
 return{directory,store,broadcast,jobs,add,tick,output,now:clock};
}
test('no samples released before generator EOF, even after many fast frames',async t=>{
 const gate=deferred();let ended=false;
 const f=fixture(t,{engine:{sampleRate:8000,async *stream(){yield new Float32Array(8000).fill(.25);await gate.promise;yield new Float32Array(8000).fill(.5);ended=true;}}});
 f.add('A');await flush();assert.equal(f.broadcast.info().queuedSegments,0);f.tick();assert.ok(f.output[0].every(v=>v===0));assert.equal(f.store.get('A').status,'generating');
 gate.resolve();await flush();assert.ok(ended);assert.equal(f.broadcast.info().queuedSegments,1);assert.equal(f.store.get('A').audioBytes,32000);assert.equal(f.store.get('A').status,'queued');
 for(let i=0;i<20;i++)f.tick();assert.equal(f.store.get('A').status,'completed');
 const pcm=Buffer.concat(f.output.slice(1));assert.deepEqual(pcm,Buffer.concat([float32ToPcm16(new Float32Array(8000).fill(.25)),float32ToPcm16(new Float32Array(8000).fill(.5))]));
});
test('playback A overlaps generation B; concurrency stays one; B has no partial playback',async t=>{
 const gate=deferred();let calls=0,active=0,max=0;
 const f=fixture(t,{engine:{sampleRate:8000,async *stream(){active++;max=Math.max(max,active);calls++;yield new Float32Array(3200).fill(.5);if(calls===2)await gate.promise;active--;}}});
 f.add('A');await flush();f.add('B');f.add('C');await flush();f.tick();assert.equal(f.store.get('A').status,'playing');assert.equal(f.store.get('B').status,'generating');assert.equal(f.store.get('C').status,'pending');
 for(let i=0;i<3;i++)f.tick();assert.equal(f.store.get('A').status,'completed');gate.resolve();await flush();assert.equal(max,1);
});
test('throw after first frame releases nothing',async t=>{
 const f=fixture(t,{engine:{sampleRate:8000,async *stream(){yield new Float32Array(1000);throw Error('secret-token');}}});f.add('fail');await flush();assert.equal(f.broadcast.info().queuedSegments,0);assert.equal(f.store.get('fail').status,'failed');assert.ok(!JSON.stringify(f.jobs.info()).includes('secret-token'));
});
test('bounded memory rejects oversized or NaN generated audio',async()=>{
 for(const samples of [new Float32Array(100),new Float32Array([NaN])])await assert.rejects(generateFullSegment({engine:{sampleRate:8000,speak:async()=>samples},text:'x',options:{},toPcm:float32ToPcm16,maxBytes:100}));
});
test('Breaking queued while A plays starts at A boundary, ahead of ordinary B',async t=>{
 const f=fixture(t);f.add('A');await flush();f.tick();f.add('B');f.add('break',{priority:100});await flush();for(let i=0;i<3;i++)f.tick();assert.equal(f.store.get('A').status,'completed');f.tick();assert.equal(f.broadcast.info().current.id,'break');assert.equal(f.store.get('B').status,'queued');
});
test('pending generation selects Breaking ahead of background',async t=>{
 const order=[];const f=fixture(t,{engine:{sampleRate:8000,speak:async text=>{order.push(text);return new Float32Array(800)}}});f.add('low',{text:'low',priority:20});f.add('high',{text:'high',priority:100});await flush();assert.deepEqual(order,['high','low']);
});
test('audio-ready survives new store and does not regenerate',async t=>{
 const f=fixture(t);f.add('held',{prepareOnly:true});await flush();assert.equal(f.store.get('held').status,'audio-ready');
 const store=createJobStore({directory:f.directory}),b=createBroadcastEngine({sampleRate:8000,manual:true,gapMs:0});let generated=0;
 const j=createBufferedJobs({store,broadcast:b,initialize:()=>{generated++;throw Error()},resolveVoice:()=>{},enqueueInference:fn=>fn(),toPcm:float32ToPcm16});
 j.schedule(store.get('held'),{recovered:true});await flush();assert.equal(generated,0);assert.equal(b.info().queuedSegments,0);j.release('held');assert.equal(b.info().queuedSegments,1);j.release('held');assert.equal(b.info().queuedSegments,1);
});
test('restart never replays a claimed playing job or legacy streaming job',async t=>{
 const f=fixture(t);for(const status of ['playing','streaming']){const job=f.store.create({id:status,status}).job;assert.equal(f.jobs.schedule(job,{recovered:true}),false);assert.equal(f.store.get(status).status,'interrupted');}assert.equal(f.broadcast.info().queuedSegments,0);
});
test('completed tombstones survive retention pruning and duplicate request',async t=>{
 const f=fixture(t);for(let i=0;i<5;i++)f.store.create({id:String(i),status:'completed',updatedAt:i});f.store.prune();assert.equal(f.store.create({id:'0',status:'pending'}).created,false);assert.equal(f.store.recoverable().length,0);
});
test('corrupt persisted PCM fails closed without regeneration',async t=>{
 const f=fixture(t);f.add('held',{prepareOnly:true});await flush();const file=fs.readdirSync(f.directory).find(n=>n.endsWith('.pcm'));fs.writeFileSync(path.join(f.directory,file),Buffer.alloc(2));assert.throws(()=>f.jobs.release('held'),/audio_integrity/);assert.equal(f.broadcast.info().queuedSegments,0);
});
test('full queue retains audio-ready job and refills after current completes',async t=>{
 const f=fixture(t,{maxQueueBytes:6400});f.add('A');f.add('B');await flush();assert.equal(f.store.get('B').status,'audio-ready');for(let i=0;i<4;i++)f.tick();await flush();assert.equal(f.store.get('B').status,'queued');assert.equal(f.broadcast.info().droppedSegments,0);
});
test('expiration and notBefore checked at actual playback boundary',async t=>{
 const f=fixture(t);f.add('expire',{validUntil:1050});await flush();f.tick();assert.equal(f.store.get('expire').status,'expired');assert.equal(f.broadcast.info().current,null);
 f.add('future',{notBefore:1500});await flush();f.tick();assert.equal(f.broadcast.info().current,null);f.tick();f.tick();f.tick();assert.equal(f.broadcast.info().current.id,'future');
});
test('music fills gap; Breaking begins only at safe music boundary',async t=>{
 const f=fixture(t);f.broadcast.setFillerProvider(()=>({id:'music',pcm:float32ToPcm16(new Float32Array(1600).fill(.1)),sampleRate:8000,meta:{music:true,mode:'FILLER_PLAYING',priority:10}}));
 f.tick();assert.equal(f.broadcast.info().mode,'FILLER_PLAYING');f.add('news',{priority:100});await flush();f.tick();f.tick();assert.equal(f.broadcast.info().current.id,'news');assert.notEqual(f.output[0].readInt16LE(0),0);
});
test('missing assets remain healthy without busy waiting',()=>{const m=createMusicLibrary({root:'/no-such-assets'});for(let i=0;i<100;i++)assert.equal(m.next(8000),null)});
test('Jerusalem night boundaries and DST',()=>{
 for(const [iso,expected] of [['2026-10-05T20:59:59Z',false],['2026-10-05T21:00:00Z',true],['2026-10-06T02:59:59Z',true],['2026-10-06T03:00:00Z',false],['2026-10-25T03:59:59Z',true],['2026-10-25T04:00:00Z',false],['2026-03-27T00:59:59Z',true],['2026-03-27T03:00:00Z',false]])assert.equal(isNight(Date.parse(iso)),expected,iso);
});
test('public job status excludes arbitrary secrets and raw errors',()=>{const out=publicBroadcastJob({id:'a',token:'SECRET',text:'SECRET',audioPath:'SECRET',authorization:'SECRET',lastError:'SECRET'});assert.ok(!JSON.stringify(out).includes('SECRET'))});
test('failed durable start cannot emit voice',async t=>{
 const f=fixture(t);f.add('A');await flush();f.broadcast.setBeforeStart(()=>{throw Error('disk full')});f.tick();assert.ok(f.output[0].every(v=>v===0));assert.equal(f.broadcast.info().current,null);assert.equal(f.broadcast.info().queuedSegments,1);
});

test('atomic complete audio file recovers crash before audio-ready JSON commit',async t=>{
 const f=fixture(t);const job=f.store.create({id:'crash',text:'x',status:'generating',priority:25}).job;
 f.store.saveAudio('crash',float32ToPcm16(new Float32Array(1600).fill(.4)),8000,{generationFinishedAt:900,generatedAudioSec:.2,generationMs:100});
 f.jobs.schedule(job,{recovered:true});await flush();assert.equal(f.store.get('crash').status,'queued');assert.equal(f.store.get('crash').audioBytes,3200);assert.equal(f.store.get('crash').generationFinishedAt,900);
});

test('Breaking bypasses a memory-full ordinary queue without dropping durable jobs',async t=>{
 const f=fixture(t,{maxQueueBytes:12800});f.add('A');await flush();f.tick();f.add('B');await flush();f.add('breaking',{priority:100});await flush();
 assert.equal(f.broadcast.info().current.id,'A');assert.equal(f.broadcast.info().next[0].id,'breaking');assert.equal(f.store.get('B').status,'audio-ready');
 for(let i=0;i<3;i++)f.tick();await flush();f.tick();assert.equal(f.broadcast.info().current.id,'breaking');
 for(let i=0;i<3;i++)f.tick();await flush();for(let i=0;i<4;i++)f.tick();assert.equal(f.store.get('B').status,'completed');assert.equal(f.broadcast.info().droppedSegments,0);
});
test('stale ready-memory entry cannot resurrect a terminal job',async t=>{
 const f=fixture(t,{maxQueueBytes:6400});f.add('A');f.add('B');await flush();assert.equal(f.store.get('B').status,'audio-ready');f.store.patch('B',{status:'failed'});
 for(let i=0;i<4;i++)f.tick();await flush();f.jobs.refill();assert.equal(f.store.get('B').status,'failed');assert.equal(f.broadcast.info().queuedSegments,0);
});
test('durable store outage pauses generation and retries with bounded backoff',async t=>{
 const f=fixture(t);const patch=f.store.patch;f.store.patch=()=>{throw Error('private-disk-path')};f.add('outage');await flush();assert.equal(f.broadcast.info().queuedSegments,0);assert.equal(f.jobs.info().lastError,'broadcast_storage_unavailable');
 f.store.patch=patch;f.jobs.refill();await flush();assert.equal(f.store.get('outage').status,'pending');for(let i=0;i<50;i++)f.tick();f.jobs.refill();await flush();assert.equal(f.store.get('outage').status,'queued');
});

test('music cache refresh preserves cursor in a long unchanged night track',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'music-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'night-music'));
 const pcm=Buffer.alloc(8000*2*30);for(let i=0;i<pcm.length/2;i++)pcm.writeInt16LE(i<80000?1000:i<160000?2000:3000,i*2);
 const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(8000,24);header.writeUInt32LE(16000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
 fs.writeFileSync(path.join(dir,'night-music','test.wav'),Buffer.concat([header,pcm]));let now=Date.parse('2026-10-05T22:00:00Z');const music=createMusicLibrary({root:dir,now:()=>now});await music.refresh(8000);assert.equal(music.next(8000).pcm.readInt16LE(0),1000);now+=61000;await music.refresh(8000);assert.equal(music.next(8000).pcm.readInt16LE(0),2000);assert.equal(music.next(8000).pcm.readInt16LE(0),3000);
});
