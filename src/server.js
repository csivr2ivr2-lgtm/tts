import express from "express";
import crypto from "node:crypto";
import { defaultProfilePath, buildVoiceProfile, inspectVoiceProfile, loadVoiceProfile } from "./voice-profile.js";
import { encodeTelephony } from "./telephony.js";
import { createSipController } from "./sip.js";
import { createBroadcastEngine, float32ToPcm16 } from "./broadcast.js";
import { createBroadcastJob, getBroadcastJob, patchBroadcastJob, recoverableBroadcastJobs, pruneBroadcastJobs, broadcastJobStoreInfo } from "./broadcast-job-store.js";

for (const k of ["OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "ORT_NUM_THREADS"]) process.env[k] ||= "1";
const VERSION = "0.8.1";
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TTS_API_KEY || "";
const LANGUAGE = process.env.TTS_LANGUAGE || "hebrew";
const MODELS_URL = process.env.TTS_MODELS_URL || "";
const VOICE_NAME = process.env.TTS_VOICE_NAME || "ari";
const VOICE_FILE = process.env.TTS_VOICE_FILE || "voices/ari.wav";
const VOICE_PROFILE_FILE = process.env.TTS_VOICE_PROFILE_FILE || defaultProfilePath(VOICE_NAME);
const KEEP_ENCODER = process.env.TTS_KEEP_ENCODER !== "false";
const REQUIRE_CUSTOM_VOICE = process.env.TTS_REQUIRE_CUSTOM_VOICE !== "false";
const MAX_TEXT_LENGTH = Number(process.env.TTS_MAX_TEXT_LENGTH || 1200);
const CACHE_MAX_ITEMS = Number(process.env.TTS_CACHE_MAX_ITEMS || 100);
const STT_MAX_AUDIO_BYTES = Number(process.env.STT_MAX_AUDIO_BYTES || 8 * 1024 * 1024);
const STT_MAX_AUDIO_SECONDS = Number(process.env.STT_MAX_AUDIO_SECONDS || 120);
const TELEPHONY_CODEC = String(process.env.TELEPHONY_CODEC || "pcmu").toLowerCase();
const TELEPHONY_SAMPLE_RATE = Number(process.env.TELEPHONY_SAMPLE_RATE || 8000);
const BROADCAST_TTS_DECODE_STEPS = process.env.BROADCAST_TTS_DECODE_STEPS ? Math.max(1, Number(process.env.BROADCAST_TTS_DECODE_STEPS)) : null;
const BROADCAST_STREAM_BATCH_FRAMES = Math.max(1, Number(process.env.BROADCAST_STREAM_BATCH_FRAMES || 10));
const BROADCAST_PREBUFFER_SECONDS = Math.max(0.8, Number(process.env.BROADCAST_PREBUFFER_SECONDS || 3.2));
const BROADCAST_MIN_GENERATION_RT_RATIO = Math.max(1.05, Number(process.env.BROADCAST_MIN_GENERATION_RT_RATIO || 1.5));
const BROADCAST_JOB_RECOVERY_LIMIT = Math.max(1, Number(process.env.BROADCAST_JOB_RECOVERY_LIMIT || 50));
const PROCESS_STARTED_AT = Date.now();
const app = express(); app.disable("x-powered-by"); app.use(express.json({ limit: "64kb" }));
const sip = createSipController();
const broadcast = createBroadcastEngine();
let tts=null,encodeWav=null,ttsLoadPromise=null,ttsStatus="idle",ttsStage="idle",ttsError=null,ttsInfo={},queueTail=Promise.resolve(),broadcastJobTail=Promise.resolve(),voiceBuildStatus="idle",voiceBuildStage="idle",voiceBuildError=null,voiceBuildInfo={};
const broadcastJobs={active:0,completed:0,failed:0,recovered:0,lastId:null,lastStatus:null,lastError:null,lastStartedAt:null,lastFinishedAt:null};
const scheduledBroadcastJobs=new Set();
const customVoices=new Map(),wavCache=new Map(); let stt=null,sttModule=null,sttImportPromise=null,sttImportError=null;
function sttInfo(){if(stt)return stt.info();return{status:sttImportError?"error":"idle",stage:sttImportError?"module-import-error":"idle",error:sttImportError||null,model:process.env.STT_MODEL||"Xenova/whisper-tiny",dtype:process.env.STT_DTYPE||"q8",language:process.env.STT_LANGUAGE||"hebrew",sampleRate:16000,loaded:false,idleUnloadMs:Number(process.env.STT_IDLE_UNLOAD_MS||60000)};}
async function ensureStt(){if(stt&&sttModule)return{stt,mod:sttModule};if(sttImportPromise)return sttImportPromise;sttImportPromise=import("./stt.js").then(mod=>{sttModule=mod;stt=mod.createSttEngine();sttImportError=null;return{stt,mod};}).catch(error=>{stt=null;sttModule=null;sttImportError=error instanceof Error?`${error.name}: ${error.message}`:String(error);console.error("[STT] module import failed; TTS remains available:",error);throw error;}).finally(()=>{sttImportPromise=null;});return sttImportPromise;}
function auth(req,res,next){if(!API_KEY)return next();const a=Buffer.from(req.get("authorization")||""),b=Buffer.from(`Bearer ${API_KEY}`);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({ok:false,error:"unauthorized"});next();}
function enqueue(task){const run=queueTail.then(task,task);queueTail=run.catch(()=>{});return run;}
function cacheSet(key,value){if(CACHE_MAX_ITEMS<=0)return;wavCache.set(key,value);while(wavCache.size>CACHE_MAX_ITEMS)wavCache.delete(wavCache.keys().next().value);}
function voices(){const builtIn=Array.isArray(tts?.voices)?tts.voices:[];return[...new Set([...customVoices.keys(),...builtIn])];}
function resolveVoice(name){const requested=name||ttsInfo.defaultVoice||tts?.defaultVoice;if(customVoices.has(requested))return{name:requested,value:customVoices.get(requested)};if(tts?.voices?.includes(requested))return{name:requested,value:requested};throw new Error(`Unknown voice '${requested}'. Available: ${voices().join(", ")}`);}
async function initTts(onEvent){if(tts)return tts;if(ttsLoadPromise)return ttsLoadPromise;ttsStatus="loading";ttsStage="importing-package";ttsError=null;onEvent?.({stage:"load-start",pid:process.pid});ttsLoadPromise=(async()=>{try{const mod=await import("pocket-tts-onnx");encodeWav=mod.encodeWav;ttsStage="loading-model";const options={language:LANGUAGE,onProgress:(stage,p={})=>{const total=Number(p.total||0),loaded=Number(p.loaded||0),percent=total?Math.floor(loaded/total*100):-1;if(percent<0||percent%10===0||percent===100)onEvent?.({stage:`model:${stage}`,loaded,total,percent});}};if(MODELS_URL)options.modelsUrl=MODELS_URL;tts=await mod.load(options);let defaultVoice=tts.defaultVoice;try{const prepared=await loadVoiceProfile(VOICE_PROFILE_FILE);customVoices.set(VOICE_NAME,prepared);defaultVoice=VOICE_NAME;}catch(e){if(REQUIRE_CUSTOM_VOICE)throw e;}ttsStatus="ready";ttsStage="ready";ttsInfo={sampleRate:tts.sampleRate,defaultVoice,customVoiceLoaded:customVoices.has(VOICE_NAME),voices:voices(),defaultDecodeSteps:Number(tts?.defaults?.decodeSteps||0)||null,defaultTemperature:Number(tts?.defaults?.temperature||0)||null};broadcast.setSampleRate(tts.sampleRate);onEvent?.({stage:"ready",...ttsInfo});console.log(`[TTS] ready sampleRate=${tts.sampleRate} defaultVoice=${defaultVoice}`);return tts;}catch(e){tts=null;customVoices.clear();ttsLoadPromise=null;ttsStatus="error";ttsStage="error";ttsError=e instanceof Error?`${e.name}: ${e.message}`:String(e);throw e;}})();return ttsLoadPromise;}
function ndjson(res){res.status(200).set({"Content-Type":"application/x-ndjson; charset=utf-8","Cache-Control":"no-cache, no-store","X-Accel-Buffering":"no"});res.flushHeaders();return event=>{if(!res.writableEnded&&!res.destroyed){res.write(`${JSON.stringify({ok:event.stage!=="error",...event})}\n`);res.flush?.();}};}
app.get("/health",(_req,res)=>{const mem=process.memoryUsage();res.json({ok:true,service:"aharon-voice-ai",version:VERSION,pid:process.pid,startedAt:PROCESS_STARTED_AT,uptimeSec:Math.floor(process.uptime()),memoryMb:{rss:Number((mem.rss/1048576).toFixed(1)),heapUsed:Number((mem.heapUsed/1048576).toFixed(1)),external:Number((mem.external/1048576).toFixed(1))},tts:{status:ttsStatus,stage:ttsStage,error:ttsError,...ttsInfo},stt:sttInfo(),voiceBuild:{status:voiceBuildStatus,stage:voiceBuildStage,error:voiceBuildError},sip:sip.info(),broadcast:broadcast.info(),broadcastJobs:{...broadcastJobs,store:broadcastJobStoreInfo()}})});
app.get("/ready",(_req,res)=>ttsStatus==="ready"?res.json({ok:true,ready:true,language:LANGUAGE,...ttsInfo}):res.status(503).json({ok:false,ready:false,status:ttsStatus,stage:ttsStage,error:ttsError||undefined}));
app.get("/v1/voices",auth,(_req,res)=>ttsStatus==="ready"?res.json({ok:true,defaultVoice:ttsInfo.defaultVoice,customVoiceLoaded:ttsInfo.customVoiceLoaded,voices:ttsInfo.voices}):res.status(503).json({ok:false,error:"tts_not_ready",status:ttsStatus}));
async function warmTts(_req,res){if(ttsStatus==="ready")return res.json({ok:true,ready:true,...ttsInfo});const write=ndjson(res);write({stage:"accepted",pid:process.pid});try{await initTts(write);write({stage:"complete",ready:true,...ttsInfo});}catch(e){write({stage:"error",error:e instanceof Error?`${e.name}: ${e.message}`:String(e)});}finally{if(!res.writableEnded)res.end();}}
app.post(["/admin/warmup","/admin/warmup/"],auth,warmTts);
app.get("/admin/voice-status",auth,async(_req,res)=>{try{const profile=await inspectVoiceProfile(VOICE_PROFILE_FILE);res.json({ok:voiceBuildStatus!=="error",status:profile.exists?"ready":voiceBuildStatus,stage:profile.exists?"profile-saved":voiceBuildStage,profilePath:VOICE_PROFILE_FILE,profile,...voiceBuildInfo});}catch(e){res.status(500).json({ok:false,error:String(e)});}});
async function buildVoice(req,res){if(ttsStatus==="loading"||ttsStatus==="ready")return res.status(409).json({ok:false,error:"tts_model_loaded",message:"Restart app and build voice before loading TTS."});const write=ndjson(res);voiceBuildStatus="building";voiceBuildStage="accepted";voiceBuildError=null;voiceBuildInfo={};write({stage:"accepted",pid:process.pid,profilePath:VOICE_PROFILE_FILE});try{const result=await buildVoiceProfile({voiceFile:VOICE_FILE,voiceName:VOICE_NAME,profilePath:VOICE_PROFILE_FILE,modelsUrl:MODELS_URL,force:req.query.force==="1"||req.query.force==="true",keepEncoder:KEEP_ENCODER,onProgress:event=>{voiceBuildStage=event.stage;write(event);}});voiceBuildStatus="ready";voiceBuildStage="ready";voiceBuildInfo=result;write({stage:"ready",...result});write({stage:"complete",ready:true});}catch(e){voiceBuildStatus="error";voiceBuildStage="error";voiceBuildError=e instanceof Error?`${e.name}: ${e.message}`:String(e);write({stage:"error",error:voiceBuildError});}finally{if(!res.writableEnded)res.end();}}
app.post(["/admin/build-voice","/admin/build-voice/"],auth,buildVoice);
app.get("/admin/stt/status",auth,(_req,res)=>res.json({ok:!sttImportError,...sttInfo()}));
async function warmStt(_req,res){const write=ndjson(res);write({...sttInfo(),stage:"accepted",pid:process.pid});try{const{stt:engine}=await ensureStt();await engine.load(write);write({stage:"complete",ready:true,...engine.info()});}catch(e){write({stage:"error",error:e instanceof Error?`${e.name}: ${e.message}`:String(e),stt:sttInfo()});}finally{if(!res.writableEnded)res.end();}}
app.post(["/admin/stt/warmup","/admin/stt/warmup/"],auth,warmStt);
app.post("/admin/stt/unload",auth,async(_req,res)=>{try{if(!stt)return res.json({ok:true,unloaded:false,...sttInfo()});const unloaded=await stt.unload();res.json({ok:true,unloaded,...stt.info()});}catch(e){res.status(500).json({ok:false,error:String(e),stt:sttInfo()});}});
app.get("/admin/sip/status",auth,(_req,res)=>res.json({ok:true,pid:process.pid,uptimeSec:Math.floor(process.uptime()),...sip.info()}));
app.post("/admin/sip/probe",auth,async(_req,res)=>{try{const result=await sip.probe();res.status(result.ok?200:502).json(result);}catch(e){res.status(500).json({ok:false,error:"sip_probe_failed",message:e instanceof Error?e.message:String(e),sip:sip.info()});}});
app.post("/admin/sip/diagnostics",auth,async(_req,res)=>{try{const result=await sip.diagnostics();res.status(result.ok?200:502).json(result);}catch(e){res.status(500).json({ok:false,error:"sip_diagnostics_failed",message:e instanceof Error?e.message:String(e),sip:sip.info()});}});
app.post("/admin/sip/connect",auth,async(_req,res)=>{try{const state=await sip.connect();res.status(state.registered?200:202).json({ok:true,accepted:!state.registered,...state});}catch(e){const code=e?.code==="SIP_NOT_CONFIGURED"?503:500;res.status(code).json({ok:false,error:e?.code||"sip_connect_failed",message:e instanceof Error?e.message:String(e),sip:sip.info()});}});
app.post("/admin/sip/disconnect",auth,async(_req,res)=>{try{res.json({ok:true,...(await sip.disconnect())});}catch(e){res.status(500).json({ok:false,error:"sip_disconnect_failed",message:e instanceof Error?e.message:String(e),sip:sip.info()});}});
const rawAudio=express.raw({type:["audio/wav","audio/x-wav","audio/wave","application/octet-stream"],limit:STT_MAX_AUDIO_BYTES});
app.post("/v1/stt",auth,rawAudio,async(req,res)=>{if(!Buffer.isBuffer(req.body))return res.status(415).json({ok:false,error:"unsupported_media_type"});let engine,mod,audio;try{({stt:engine,mod}=await ensureStt());const type=(req.get("content-type")||"").split(";")[0].toLowerCase();audio=mod.decodeSttAudio(req.body,{encoding:type.includes("wav")?"wav":String(req.query.encoding||"s16le"),sampleRate:Number(req.query.sample_rate||TELEPHONY_SAMPLE_RATE)});const simulateCodec=String(req.query.simulate_telephony||"").toLowerCase();if(simulateCodec){const encoded=encodeTelephony(audio.samples,audio.sampleRate,simulateCodec,TELEPHONY_SAMPLE_RATE);audio=mod.decodeSttAudio(encoded,{encoding:simulateCodec,sampleRate:TELEPHONY_SAMPLE_RATE});audio.simulatedTelephony={codec:simulateCodec,sampleRate:TELEPHONY_SAMPLE_RATE,bytes:encoded.length};}}catch(e){const message=e instanceof Error?`${e.name}: ${e.message}`:String(e),importFailure=Boolean(sttImportError);return res.status(importFailure?503:400).json({ok:false,error:importFailure?"stt_unavailable":"invalid_audio",message,stt:sttInfo()});}if(audio.durationSec>STT_MAX_AUDIO_SECONDS)return res.status(413).json({ok:false,error:"audio_too_long",maxSeconds:STT_MAX_AUDIO_SECONDS});try{const result=await enqueue(()=>engine.transcribe(audio.samples,{language:String(req.query.language||process.env.STT_LANGUAGE||"hebrew"),timestamps:req.query.timestamps!=="0"&&req.query.timestamps!=="false"}));res.json({ok:true,text:result.text,chunks:result.chunks,language:String(req.query.language||process.env.STT_LANGUAGE||"hebrew"),model:engine.info().model,durationSec:Number(audio.durationSec.toFixed(3)),sourceSampleRate:audio.sourceSampleRate,sampleRate:audio.sampleRate,simulatedTelephony:audio.simulatedTelephony,processingMs:result.processingMs});}catch(e){res.status(500).json({ok:false,error:"stt_failed",message:e instanceof Error?`${e.name}: ${e.message}`:String(e),stt:sttInfo()});}});
app.get("/v1/broadcast/status",auth,(_req,res)=>res.json({ok:true,...broadcast.info(),jobs:{...broadcastJobs}}));

function publicJob(job){
  if(!job)return null;
  const copy={...job};
  delete copy.text;
  copy.textPreview=typeof job.text==="string"?job.text.slice(0,160):undefined;
  return copy;
}

function sanitizeBroadcastPayload(body,text,id){
  const speakerId=typeof body?.speaker?.id==="string"?body.speaker.id:null;
  const requestedVoice=typeof body?.voice==="string"&&body.voice.trim()?body.voice.trim():(typeof body?.speaker?.voice==="string"?body.speaker.voice.trim():"");
  return{id,text,type:typeof body?.type==="string"?body.type:"news",priority:Number.isFinite(body?.priority)?Number(body.priority):50,voice:requestedVoice,speakerId,eventId:typeof body?.source?.eventId==="string"?body.source.eventId:null,language:typeof body?.content?.language==="string"?body.content.language:null,status:"pending",attempts:0,chunksQueued:0,playedChunks:0,totalChunks:0,lastError:null};
}

function noteJob(job){
  if(!job)return;
  broadcastJobs.lastId=job.id;
  broadcastJobs.lastStatus=job.status;
  broadcastJobs.lastError=job.lastError||null;
  if(job.startedAt)broadcastJobs.lastStartedAt=job.startedAt;
  if(job.finishedAt||job.playedAt)broadcastJobs.lastFinishedAt=job.finishedAt||job.playedAt;
}

async function processBroadcastJob(job){
  const id=job.id;
  const started=Date.now();
  broadcastJobs.active+=1;
  broadcastJobs.lastId=id;
  broadcastJobs.lastStatus="generating";
  broadcastJobs.lastError=null;
  broadcastJobs.lastStartedAt=started;
  let current=patchBroadcastJob(id,{status:"generating",startedAt:started,attempts:Number(job.attempts||0)+1,lastError:null,pid:process.pid,chunksQueued:0,playedChunks:0,totalChunks:0,firstAudioAt:null,timeToFirstAudioMs:null,ttsStatus:"starting",playbackReleased:false,generatedAudioSec:0,generationRtRatio:0});
  try{
    if(ttsStatus!=="ready")await initTts();
    const voice=resolveVoice(current?.voice||"");
    const baseMeta={type:current?.type||"news",priority:Number.isFinite(current?.priority)?Number(current.priority):50,voice:voice.name,speakerId:current?.speakerId||null,eventId:current?.eventId||null,parentJobId:id};
    const decodeSteps=BROADCAST_TTS_DECODE_STEPS||Number(tts?.defaults?.decodeSteps||0)||undefined;
    let buffers=[];
    let pendingParts=[];
    let audioParts=0;
    let frameCount=0;
    let generatedSamples=0;
    let firstFrameAt=null;
    let playbackReleased=false;

    const enqueuePart=(part)=>{
      audioParts+=1;
      const segmentId=id+"::audio-"+audioParts;
      const queued=broadcast.enqueueSegment({id:segmentId,pcm:part.pcm,sampleRate:tts.sampleRate,meta:{...baseMeta,streamPart:audioParts,finalJobPart:false,gapMs:0}});
      const existing=getBroadcastJob(id)||current;
      const status=existing?.status==="playing"?"playing":"streaming";
      current=patchBroadcastJob(id,{status,chunksQueued:audioParts,lastChunkQueuedAt:Date.now(),firstAudioAt:firstFrameAt,timeToFirstAudioMs:firstFrameAt?firstFrameAt-started:null,ttsStatus:"streaming",playbackReleased:true});
      noteJob(current);
      console.log("[BROADCAST] audio queued job="+id+" part="+audioParts+" sec="+part.durationSec.toFixed(2)+" queue="+queued.queueLength+" elapsedMs="+(Date.now()-started));
    };

    const releasePending=(reason)=>{
      if(playbackReleased)return;
      playbackReleased=true;
      const parts=pendingParts;
      pendingParts=[];
      for(const part of parts)enqueuePart(part);
      current=patchBroadcastJob(id,{playbackReleased:true,playbackReleaseReason:reason,playbackReleasedAt:Date.now(),prebufferedParts:parts.length});
      noteJob(current);
      console.log("[BROADCAST] playback released job="+id+" reason="+reason+" parts="+parts.length+" generatedSec="+(generatedSamples/tts.sampleRate).toFixed(2));
    };

    const storeAudioPart=()=>{
      if(!buffers.length)return;
      const pcm=Buffer.concat(buffers);
      buffers=[];
      const part={pcm,durationSec:pcm.length/(tts.sampleRate*2)};
      if(playbackReleased){
        enqueuePart(part);
        return;
      }
      pendingParts.push(part);
      const generatedAudioSec=generatedSamples/tts.sampleRate;
      const elapsedSec=Math.max(0.001,(Date.now()-started)/1000);
      const rtRatio=generatedAudioSec/elapsedSec;
      current=patchBroadcastJob(id,{generatedAudioSec:Number(generatedAudioSec.toFixed(3)),generationRtRatio:Number(rtRatio.toFixed(3)),prebufferedParts:pendingParts.length,ttsStatus:"prebuffering"});
      noteJob(current);
      if(generatedAudioSec>=BROADCAST_PREBUFFER_SECONDS&&rtRatio>=BROADCAST_MIN_GENERATION_RT_RATIO){
        releasePending("producer-fast-enough");
      }
    };

    const streamOptions={
      voice:voice.value,
      ...(decodeSteps?{decodeSteps}:{}),
      onStatus:(status)=>{
        const existing=getBroadcastJob(id);
        if(existing&&!["completed","failed"].includes(existing.status))current=patchBroadcastJob(id,{ttsStatus:String(status||"")});
        console.log("[BROADCAST] tts status job="+id+" status="+String(status||""));
      },
      onProgress:(stage,progress={})=>{
        const total=Number(progress.total||0),loaded=Number(progress.loaded||0);
        const percent=total?Math.floor(loaded/total*100):-1;
        if(percent<0||percent===100||percent%25===0)console.log("[BROADCAST] tts progress job="+id+" stage="+stage+" percent="+percent);
      }
    };

    if(typeof tts.stream==="function"){
      await enqueue(async()=>{
        for await(const frame of tts.stream(current?.text||job.text,streamOptions)){
          if(!(frame instanceof Float32Array)||frame.length===0)continue;
          if(firstFrameAt===null){
            firstFrameAt=Date.now();
            current=patchBroadcastJob(id,{firstFrameAt,timeToFirstAudioMs:firstFrameAt-started,ttsStatus:"first-frame",decodeSteps:decodeSteps||null});
            noteJob(current);
            console.log("[BROADCAST] first TTS frame job="+id+" ms="+(firstFrameAt-started)+" samples="+frame.length+" decodeSteps="+String(decodeSteps||"model-default"));
          }
          buffers.push(float32ToPcm16(frame));
          generatedSamples+=frame.length;
          frameCount+=1;
          if(buffers.length>=BROADCAST_STREAM_BATCH_FRAMES)storeAudioPart();
        }
      });
      storeAudioPart();
    }else{
      console.warn("[BROADCAST] tts.stream unavailable; falling back to buffered speak job="+id);
      const speakOptions={voice:voice.value,...(decodeSteps?{decodeSteps}:{})};
      const samples=await enqueue(()=>tts.speak(current?.text||job.text,speakOptions));
      firstFrameAt=Date.now();
      generatedSamples=samples.length;
      buffers=[float32ToPcm16(samples)];
      frameCount=1;
      storeAudioPart();
    }

    if(!playbackReleased)releasePending("generation-complete");
    if(audioParts===0)throw new Error("TTS stream produced no audio");

    const markerFrames=Math.max(1,Math.round(tts.sampleRate*0.1));
    const marker=broadcast.enqueueSegment({id:id+"::final",pcm:Buffer.alloc(markerFrames*2),sampleRate:tts.sampleRate,meta:{...baseMeta,streamPart:audioParts+1,finalJobPart:true,finalMarker:true,gapMs:0}});
    const existing=getBroadcastJob(id)||current;
    const finalStatus=existing?.status==="playing"?"playing":"queued";
    current=patchBroadcastJob(id,{status:finalStatus,chunksQueued:audioParts,totalChunks:audioParts,generationFinishedAt:Date.now(),generationMs:Date.now()-started,generatedAudioSec:Number((generatedSamples/tts.sampleRate).toFixed(3)),ttsStatus:"complete",decodeSteps:decodeSteps||null});
    noteJob(current);
    console.log("[BROADCAST] generation complete id="+id+" voice="+voice.name+" ms="+(Date.now()-started)+" audioParts="+audioParts+" frames="+frameCount+" audioSec="+(generatedSamples/tts.sampleRate).toFixed(2)+" queue="+marker.queueLength);
  }catch(e){
    const error=e instanceof Error?e.name+": "+e.message:String(e);
    broadcastJobs.failed+=1;
    current=patchBroadcastJob(id,{status:"failed",lastError:error,finishedAt:Date.now(),ttsStatus:"failed"});
    noteJob(current);
    console.error("[BROADCAST] job failed id="+id+":",error);
  }finally{
    broadcastJobs.active=Math.max(0,broadcastJobs.active-1);
    scheduledBroadcastJobs.delete(id);
  }
}

function scheduleBroadcastJob(job,{recovered=false}={}){
  if(!job?.id||scheduledBroadcastJobs.has(job.id))return false;
  scheduledBroadcastJobs.add(job.id);
  if(recovered){
    const previousStatus=job.status;
    broadcastJobs.recovered+=1;
    const reset=patchBroadcastJob(job.id,{status:"pending",recoveredAt:Date.now(),lastError:null});
    if(reset)job=reset;
    console.log("[BROADCAST] recovering job id="+job.id+" previousStatus="+previousStatus);
  }
  const run=()=>processBroadcastJob(job);
  broadcastJobTail=broadcastJobTail.then(run,run);
  return true;
}

broadcast.subscribe((event)=>{
  const parentId=event?.segment?.meta?.parentJobId;
  if(!parentId)return;
  const existing=getBroadcastJob(parentId);
  if(!existing)return;
  if(event.type==="started"){
    noteJob(patchBroadcastJob(parentId,{status:"playing",lastPlaybackStartedAt:event.at}));
    return;
  }
  if(event.type==="finished"){
    const isMarker=event?.segment?.meta?.finalMarker===true;
    const played=Number(existing.playedChunks||0)+(isMarker?0:1);
    const done=event?.segment?.meta?.finalJobPart===true;
    const patch={playedChunks:played,status:done?"completed":"playing",lastPlaybackFinishedAt:event.at};
    if(done){patch.playedAt=event.at;patch.finishedAt=event.at;}
    const updated=patchBroadcastJob(parentId,patch);
    if(done){
      broadcastJobs.completed+=1;
      pruneBroadcastJobs();
      console.log("[BROADCAST] job completed id="+parentId+" audioParts="+played);
    }
    noteJob(updated);
  }
});

app.get("/v1/broadcast/jobs/:id",auth,(req,res)=>{
  const job=getBroadcastJob(String(req.params.id||""));
  if(!job)return res.status(404).json({ok:false,error:"broadcast_job_not_found"});
  res.json({ok:true,job:publicJob(job)});
});

app.post("/v1/broadcast/segment",auth,(req,res)=>{
  const text=typeof req.body?.text==="string"?req.body.text.trim():(typeof req.body?.content?.text==="string"?req.body.content.text.trim():"");
  if(!text)return res.status(400).json({ok:false,error:"text is required"});
  if(text.length>MAX_TEXT_LENGTH)return res.status(413).json({ok:false,error:"text is too long; max "+MAX_TEXT_LENGTH});
  const id=typeof req.body?.id==="string"&&req.body.id.trim()?req.body.id.trim():"segment_"+crypto.randomUUID();
  if(id.length>200)return res.status(400).json({ok:false,error:"id is too long"});
  const payload=sanitizeBroadcastPayload(req.body||{},text,id);
  const created=createBroadcastJob(payload);
  if(!created.created){
    const existing=created.job;
    if(existing.text!==text)return res.status(409).json({ok:false,error:"broadcast_job_id_conflict",id,status:existing.status});
    if(existing.status==="failed"){
      const retry=patchBroadcastJob(id,{status:"pending",lastError:null,playedChunks:0,chunksQueued:0,totalChunks:0});
      scheduleBroadcastJob(retry);
      return res.status(202).json({ok:true,accepted:true,retried:true,id,status:"pending",job:publicJob(retry),broadcast:broadcast.info()});
    }
    return res.status(existing.status==="completed"?200:202).json({ok:true,accepted:existing.status!=="completed",duplicate:true,id,status:existing.status,job:publicJob(existing),broadcast:broadcast.info()});
  }
  scheduleBroadcastJob(created.job);
  res.status(202).json({ok:true,accepted:true,id,status:"pending",job:publicJob(created.job),broadcast:broadcast.info()});
});

app.post("/v1/broadcast/test-tone",auth,(req,res)=>{const info=broadcast.info();const rate=Number(info.sampleRate||24000);const seconds=Math.max(0.5,Math.min(5,Number(req.body?.seconds||2)));const frequency=Math.max(220,Math.min(2000,Number(req.body?.frequency||880)));const frames=Math.round(rate*seconds);const pcm=Buffer.allocUnsafe(frames*2);for(let i=0;i<frames;i++){const fade=Math.min(1,i/(rate*0.02),(frames-i-1)/(rate*0.02));const sample=Math.sin(2*Math.PI*frequency*i/rate)*0.22*Math.max(0,fade);pcm.writeInt16LE(Math.round(sample*32767),i*2);}const id=`tone_${Date.now()}`;const queued=broadcast.enqueueSegment({id,pcm,sampleRate:rate,meta:{type:"test-tone",priority:100,voice:null,speakerId:"diagnostic",eventId:null,textPreview:`${frequency}Hz test tone`}});res.status(202).json({ok:true,accepted:true,id,seconds,frequency,sampleRate:rate,queued,broadcast:broadcast.info()});});
app.get("/live.wav",async(_req,res)=>{try{if(ttsStatus!=="ready")await initTts();broadcast.attach(res);}catch(e){if(!res.headersSent)res.status(503).json({ok:false,error:"broadcast_unavailable",message:e instanceof Error?`${e.name}: ${e.message}`:String(e)});else try{res.end();}catch{}}});
app.get("/live.pcm",async(_req,res)=>{try{if(ttsStatus!=="ready")await initTts();broadcast.attachRaw(res);}catch(e){if(!res.headersSent)res.status(503).json({ok:false,error:"broadcast_unavailable",message:e instanceof Error?`${e.name}: ${e.message}`:String(e)});else try{res.end();}catch{}}});
app.get("/radio",(_req,res)=>res.type("html").send("<!doctype html><html lang=\"he\" dir=\"rtl\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Aharon AI Radio</title><style>body{font-family:system-ui;background:#111;color:#eee;max-width:760px;margin:50px auto;padding:20px}main{background:#1c1c1c;padding:28px;border-radius:18px}button{font:inherit;padding:12px 20px;border:0;border-radius:12px;cursor:pointer}#state{margin:14px 0}pre{background:#090909;padding:14px;border-radius:12px;white-space:pre-wrap;overflow:auto}</style></head><body><main><h1>📻 Aharon AI Radio</h1><p>שידור AI חי באמצעות PCM ישיר לדפדפן, עם חיבור מחדש אוטומטי.</p><button id=\"play\">▶ התחל שידור</button><div id=\"state\">מוכן להתחבר</div><pre id=\"s\">טוען מצב...</pre></main><script>\nlet ctx=null,processor=null,running=false,aborter=null;\nlet chunks=[],chunkOffset=0,bufferedSamples=0,inputRate=24000;\nconst sleep=ms=>new Promise(r=>setTimeout(r,ms));\nconst play=document.getElementById('play'),state=document.getElementById('state'),statusBox=document.getElementById('s');\nfunction enqueueSamples(arr){if(!arr.length)return;chunks.push(arr);bufferedSamples+=arr.length;const max=Math.max(inputRate*5,inputRate);while(bufferedSamples>max&&chunks.length>1){const first=chunks.shift();bufferedSamples-=Math.max(0,first.length-chunkOffset);chunkOffset=0;}}\nfunction pullInput(){while(chunks.length){const c=chunks[0];if(chunkOffset<c.length){const v=c[chunkOffset++];bufferedSamples--;if(chunkOffset>=c.length){chunks.shift();chunkOffset=0}return v;}chunks.shift();chunkOffset=0;}return 0;}\nfunction installProcessor(){if(processor)return;processor=ctx.createScriptProcessor(4096,0,1);let a=0,b=0,have=false,phase=0;processor.onaudioprocess=e=>{const out=e.outputBuffer.getChannelData(0);const ratio=inputRate/ctx.sampleRate;for(let i=0;i<out.length;i++){if(!have){a=pullInput();b=pullInput();have=true}out[i]=a+(b-a)*phase;phase+=ratio;while(phase>=1){phase-=1;a=b;b=pullInput();}}};processor.connect(ctx.destination);}\nasync function status(){try{const r=await fetch('/health',{cache:'no-store'});const j=await r.json();statusBox.textContent=JSON.stringify({...j.broadcast,broadcastJobs:j.broadcastJobs,browserSampleRate:ctx?.sampleRate||null,bufferedMs:inputRate?Math.round(bufferedSamples/inputRate*1000):0},null,2)}catch(e){statusBox.textContent=String(e)}}\nasync function consume(response){inputRate=Number(response.headers.get('X-Audio-Sample-Rate'))||24000;installProcessor();const reader=response.body.getReader();let carry=null;state.textContent='מחובר • מאזין לשידור';play.textContent='● מחובר';while(running){const part=await reader.read();if(part.done)throw new Error('stream ended');let bytes=part.value;if(carry!==null){const merged=new Uint8Array(bytes.length+1);merged[0]=carry;merged.set(bytes,1);bytes=merged;carry=null}if(bytes.length%2){carry=bytes[bytes.length-1];bytes=bytes.subarray(0,bytes.length-1)}if(!bytes.length)continue;const frames=bytes.length/2;const samples=new Float32Array(frames);const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let i=0;i<frames;i++)samples[i]=view.getInt16(i*2,true)/32768;enqueueSamples(samples);}}\nasync function start(){if(running)return;running=true;play.disabled=true;ctx=new (window.AudioContext||window.webkitAudioContext)();await ctx.resume();installProcessor();while(running){try{state.textContent='מתחבר לשידור...';aborter=new AbortController();const response=await fetch('/live.pcm?ts='+Date.now(),{cache:'no-store',signal:aborter.signal});if(!response.ok||!response.body)throw new Error('stream HTTP '+response.status);await consume(response);}catch(e){if(!running)break;state.textContent='החיבור נותק • מתחבר מחדש...';chunks=[];chunkOffset=0;bufferedSamples=0;await sleep(1000);}}play.disabled=false;play.textContent='▶ התחל שידור';}\nplay.addEventListener('click',()=>start().catch(e=>{running=false;state.textContent='שגיאת שידור: '+e.message;play.disabled=false;play.textContent='נסה שוב'}));\nstatus();setInterval(status,3000);\n</script></body></html>"));
app.post("/v1/tts",auth,async(req,res)=>{const text=typeof req.body?.text==="string"?req.body.text.trim():"";if(!text)return res.status(400).json({ok:false,error:"text is required"});if(text.length>MAX_TEXT_LENGTH)return res.status(413).json({ok:false,error:`text is too long; max ${MAX_TEXT_LENGTH}`});try{if(ttsStatus!=="ready")await initTts();}catch(e){return res.status(503).json({ok:false,error:"tts_unavailable",message:e instanceof Error?`${e.name}: ${e.message}`:String(e)});}let voice;try{voice=resolveVoice(typeof req.body?.voice==="string"?req.body.voice.trim():"");}catch(e){return res.status(400).json({ok:false,error:"unknown_voice",message:e.message});}const temperature=Number.isFinite(req.body?.temperature)?Number(req.body.temperature):undefined,decodeSteps=Number.isInteger(req.body?.decodeSteps)?Number(req.body.decodeSteps):undefined,seed=Number.isInteger(req.body?.seed)?Number(req.body.seed):undefined,format=String(req.body?.format||"wav").toLowerCase(),outputRate=Number(req.body?.sampleRate||(format==="wav"?tts.sampleRate:TELEPHONY_SAMPLE_RATE));if(!["wav","pcmu","mulaw","ulaw","pcma","alaw"].includes(format))return res.status(400).json({ok:false,error:"unsupported_output_format",formats:["wav","pcmu","pcma"]});if(format!=="wav"&&outputRate!==8000&&outputRate!==16000)return res.status(400).json({ok:false,error:"unsupported_telephony_sample_rate",sampleRates:[8000,16000]});const normalizedFormat=["mulaw","ulaw"].includes(format)?"pcmu":(format==="alaw"?"pcma":format),key=crypto.createHash("sha256").update(JSON.stringify({text,voice:voice.name,temperature,decodeSteps,seed,format:normalizedFormat,outputRate,LANGUAGE,VERSION})).digest("hex"),hit=wavCache.get(key),headersFor=(buffer,cacheState)=>({"Content-Type":normalizedFormat==="wav"?"audio/wav":"application/octet-stream","Content-Length":String(buffer.length),"Content-Disposition":normalizedFormat==="wav"?'inline; filename="speech.wav"':`inline; filename="speech.${normalizedFormat}"`,"Cache-Control":"no-store","X-TTS-Cache":cacheState,"X-TTS-Voice":voice.name,"X-Audio-Codec":normalizedFormat,"X-Audio-Sample-Rate":String(normalizedFormat==="wav"?tts.sampleRate:outputRate)});if(hit)return res.set(headersFor(hit,"HIT")).end(hit);try{const audio=await enqueue(async()=>{const options={voice:voice.value};if(temperature!==undefined)options.temperature=temperature;if(decodeSteps!==undefined)options.decodeSteps=decodeSteps;if(seed!==undefined)options.seed=seed;const samples=await tts.speak(text,options);if(normalizedFormat==="wav")return Buffer.from(encodeWav(samples,tts.sampleRate));return encodeTelephony(samples,tts.sampleRate,normalizedFormat,outputRate);});cacheSet(key,audio);res.set(headersFor(audio,"MISS")).end(audio);}catch(e){res.status(500).json({ok:false,error:"tts_generation_failed",message:e instanceof Error?`${e.name}: ${e.message}`:String(e)});}});
app.use((err,_req,res,_next)=>{console.error(err);if(err?.type==="entity.parse.failed")return res.status(400).json({ok:false,error:"invalid_json"});if(err?.type==="entity.too.large")return res.status(413).json({ok:false,error:"payload_too_large"});res.status(500).json({ok:false,error:"internal_server_error"});});
app.listen(PORT,"0.0.0.0",()=>{
  console.log("Aharon Voice AI v"+VERSION+" listening on 0.0.0.0:"+PORT+" pid="+process.pid);
  const si=sttInfo();
  console.log("TTS="+LANGUAGE+"/"+VOICE_NAME+"; STT="+si.model+"/"+si.dtype+"/"+si.language+" (lazy)");
  console.log("Voice profile: "+VOICE_PROFILE_FILE);
  console.log("Telephony="+TELEPHONY_CODEC+"/"+TELEPHONY_SAMPLE_RATE+"Hz; SIP="+(sip.info().configured?"configured":"disabled"));
  const recoverable=recoverableBroadcastJobs(BROADCAST_JOB_RECOVERY_LIMIT);
  for(const job of recoverable)scheduleBroadcastJob(job,{recovered:true});
  if(recoverable.length)console.log("[BROADCAST] scheduled "+recoverable.length+" persisted job(s) for recovery");
  if(sip.info().autoConnect&&sip.info().configured){sip.connect().catch(error=>console.error("[SIP] auto-connect failed:",error instanceof Error?error.message:String(error)));}
});