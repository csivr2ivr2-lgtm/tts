import { createRequire } from "node:module";
import { RtmpPublisher } from "./rtmp-client.js";
import { encodeStaticBackground } from "./mp4-h264.js";

const require=createRequire(import.meta.url);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

class StreamingResampler{
  constructor(sourceRate,targetRate=44100){this.sourceRate=sourceRate;this.targetRate=targetRate;this.ratio=sourceRate/targetRate;this.data=new Int16Array(0);this.position=0;}
  push(buffer){
    const frames=Math.floor(buffer.length/2),incoming=new Int16Array(frames);for(let i=0;i<frames;i++)incoming[i]=buffer.readInt16LE(i*2);
    if(this.data.length){const merged=new Int16Array(this.data.length+incoming.length);merged.set(this.data);merged.set(incoming,this.data.length);this.data=merged;}else this.data=incoming;
    const output=[];while(this.position+1<this.data.length){const left=Math.floor(this.position),frac=this.position-left,a=this.data[left],b=this.data[left+1];output.push(Math.max(-32768,Math.min(32767,Math.round(a+(b-a)*frac))));this.position+=this.ratio;}
    const consumed=Math.floor(this.position);if(consumed>0){this.data=this.data.slice(consumed);this.position-=consumed;}
    return Int16Array.from(output);
  }
}

class Mp3FrameSplitter{
  constructor(){this.buffer=Buffer.alloc(0);}
  push(input){if(input?.length)this.buffer=this.buffer.length?Buffer.concat([this.buffer,Buffer.from(input)]):Buffer.from(input);const out=[];let p=0;while(p+4<=this.buffer.length){if(this.buffer[p]!==0xff||(this.buffer[p+1]&0xe0)!==0xe0){p++;continue;}const b1=this.buffer[p+1],b2=this.buffer[p+2];const versionBits=(b1>>3)&3,layerBits=(b1>>1)&3;if(versionBits===1||layerBits!==1){p++;continue;}const bitrateIndex=(b2>>4)&15,srIndex=(b2>>2)&3,padding=(b2>>1)&1;if(!bitrateIndex||bitrateIndex===15||srIndex===3){p++;continue;}const mpeg1=versionBits===3;const rates=[44100,48000,32000];const divisor=mpeg1?1:(versionBits===2?2:4);const sampleRate=rates[srIndex]/divisor;const table=mpeg1?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];const kbps=table[bitrateIndex];const length=Math.floor((mpeg1?144000:72000)*kbps/sampleRate)+padding;if(length<4){p++;continue;}if(p+length>this.buffer.length)break;out.push({data:Buffer.from(this.buffer.subarray(p,p+length)),samples:mpeg1?1152:576,sampleRate});p+=length;}
    this.buffer=this.buffer.subarray(p);return out;
  }
}

function appendInt16(a,b){if(!a?.length)return b;if(!b?.length)return a;const out=new Int16Array(a.length+b.length);out.set(a);out.set(b,a.length);return out;}
function signed24(n){let v=Math.round(n);if(v<0)v=0x1000000+v;return Buffer.from([(v>>>16)&255,(v>>>8)&255,v&255]);}
function safeError(error,streamKey){let text=error instanceof Error?`${error.name}: ${error.message}`:String(error);if(error?.rtmpPhase&&!text.includes("phase="))text+=` [phase=${error.rtmpPhase}]`;if(streamKey)text=text.split(streamKey).join("[redacted]");return text.slice(0,500);}

export function createYouTubePublisher({broadcast,options={}}={}){
  if(!broadcast?.subscribePcm)throw new Error("Broadcast engine does not support subscribePcm");
  const config={
    enabled:options.enabled===true,url:options.url||"rtmps://a.rtmps.youtube.com/live2",streamKey:String(options.streamKey||"").trim(),backgroundFile:String(options.backgroundFile||"").trim(),width:Math.max(320,Number(options.width||1280)),height:Math.max(240,Number(options.height||720)),fps:Math.max(1,Math.min(60,Number(options.fps||30))),gopSeconds:Math.max(1,Math.min(4,Number(options.gopSeconds||2))),videoBitrateKbps:Math.max(300,Number(options.videoBitrateKbps||2500)),audioBitrateKbps:128,reconnectMs:Math.max(1000,Number(options.reconnectMs||5000)),connectTimeoutMs:Math.max(5000,Number(options.connectTimeoutMs||process.env.YOUTUBE_CONNECT_TIMEOUT_MS||30000)),
  };
  let desired=false,runner=null,client=null,video=null,videoTimer=null,unsubscribePcm=null,resampler=null,audioSourceRate=null,pendingAudio=new Int16Array(0),mp3Encoder=null,mp3Splitter=null,audioSamplesSent=0,videoTimestamp=0,videoIndex=0,mediaEpoch=0;
  const state={status:"idle",connected:false,startedAt:null,lastConnectedAt:null,lastDisconnectedAt:null,lastError:null,reconnects:0,videoPrepared:false,videoSamples:0,connectionPhase:"idle",lastRtmpStatusCode:null,lastRtmpWarning:null};

  function info(){return{publisherRevision:"rtmp-control-v2",enabled:desired,autoStartEnabled:config.enabled,configured:Boolean(config.streamKey&&config.backgroundFile),status:state.status,connected:state.connected,desired,startedAt:state.startedAt,lastConnectedAt:state.lastConnectedAt,lastDisconnectedAt:state.lastDisconnectedAt,lastError:state.lastError,reconnects:state.reconnects,backgroundConfigured:Boolean(config.backgroundFile),streamKeyConfigured:Boolean(config.streamKey),resolution:`${config.width}x${config.height}`,fps:config.fps,videoBitrateKbps:config.videoBitrateKbps,audioCodec:"mp3",audioSampleRate:44100,audioBitrateKbps:config.audioBitrateKbps,connectTimeoutMs:config.connectTimeoutMs,connectionPhase:state.connectionPhase,lastRtmpStatusCode:state.lastRtmpStatusCode,lastRtmpWarning:state.lastRtmpWarning,videoPrepared:state.videoPrepared,videoSamples:state.videoSamples};}

  async function prepareVideo(){if(video)return video;state.status="preparing";video=await encodeStaticBackground({file:config.backgroundFile,width:config.width,height:config.height,fps:config.fps,gopSeconds:config.gopSeconds,bitrateKbps:config.videoBitrateKbps});state.videoPrepared=true;state.videoSamples=video.samples.length;return video;}

  function resetAudio(){const lame=require("@breezystack/lamejs");const Mp3Encoder=lame.Mp3Encoder||lame.default?.Mp3Encoder;if(!Mp3Encoder)throw new Error("MP3 encoder unavailable");mp3Encoder=new Mp3Encoder(2,44100,config.audioBitrateKbps);mp3Splitter=new Mp3FrameSplitter();pendingAudio=new Int16Array(0);resampler=null;audioSourceRate=null;audioSamplesSent=0;}
  function onPcm(buffer,sourceRate){
    if(!client?.publishing||!Buffer.isBuffer(buffer)||!buffer.length)return;
    if(!resampler||audioSourceRate!==sourceRate){audioSourceRate=sourceRate;resampler=new StreamingResampler(sourceRate,44100);pendingAudio=new Int16Array(0);}
    pendingAudio=appendInt16(pendingAudio,resampler.push(buffer));
    while(pendingAudio.length>=1152){const block=pendingAudio.slice(0,1152);pendingAudio=pendingAudio.slice(1152);const encoded=mp3Encoder.encodeBuffer(block,block);for(const frame of mp3Splitter.push(encoded)){const timestamp=audioSamplesSent*1000/44100;audioSamplesSent+=frame.samples;try{client.sendAudio(Buffer.concat([Buffer.from([0x2f]),frame.data]),Math.round(timestamp));}catch(error){state.lastError=safeError(error,config.streamKey);client.close();return;}}}
  }

  function sendVideoSequence(){const payload=Buffer.concat([Buffer.from([0x17,0x00,0,0,0]),video.avcC]);client.sendVideo(payload,0);}
  function pumpVideo(){
    if(!desired||!client?.publishing||!video)return;const sample=video.samples[videoIndex];const header=Buffer.concat([Buffer.from([sample.key?0x17:0x27,0x01]),signed24(sample.compositionMs||0)]);try{client.sendVideo(Buffer.concat([header,sample.data]),Math.round(videoTimestamp));}catch(error){state.lastError=safeError(error,config.streamKey);client.close();return;}
    videoTimestamp+=sample.durationMs;videoIndex=(videoIndex+1)%video.samples.length;const due=mediaEpoch+videoTimestamp,delay=Math.max(0,Math.min(1000,due-Date.now()));videoTimer=setTimeout(pumpVideo,delay);videoTimer.unref?.();
  }
  function startMedia(){
    resetAudio();videoTimestamp=0;videoIndex=0;mediaEpoch=Date.now();client.sendMetadata({width:config.width,height:config.height,framerate:config.fps,videocodecid:7,audiocodecid:2,videodatarate:config.videoBitrateKbps,audiodatarate:config.audioBitrateKbps,stereo:true,audiosamplerate:44100});sendVideoSequence();unsubscribePcm=broadcast.subscribePcm(onPcm);pumpVideo();
  }
  function stopMedia(){if(videoTimer){clearTimeout(videoTimer);videoTimer=null;}if(unsubscribePcm){unsubscribePcm();unsubscribePcm=null;}resampler=null;pendingAudio=new Int16Array(0);mp3Encoder=null;mp3Splitter=null;}

  async function run(){
    try{await prepareVideo();}catch(error){state.status="error";state.lastError=safeError(error,config.streamKey);desired=false;runner=null;return;}
    while(desired){
      state.status="connecting";state.connectionPhase="tls-connecting";client=new RtmpPublisher({url:config.url,streamKey:config.streamKey,connectTimeoutMs:config.connectTimeoutMs});let closedResolve;const closed=new Promise(resolve=>{closedResolve=resolve;});
      client.on("phase",event=>{state.connectionPhase=String(event?.phase||"unknown");});
      client.on("status",info=>{state.lastRtmpStatusCode=typeof info?.code==="string"?info.code:null;});
      client.on("warning",info=>{state.lastRtmpWarning=String(info?.code||info?.description||"optional-command-rejected").slice(0,160);});
      client.on("error",error=>{state.lastError=safeError(error,config.streamKey);});client.on("close",()=>closedResolve());
      try{await client.connect();if(!desired){client.close();break;}state.status="live";state.connected=true;state.connectionPhase="live";state.lastError=null;state.lastConnectedAt=Date.now();if(!state.startedAt)state.startedAt=state.lastConnectedAt;startMedia();await closed;}catch(error){state.lastError=safeError(error,config.streamKey);}finally{stopMedia();state.connected=false;state.lastDisconnectedAt=Date.now();client?.close();client=null;}
      if(desired){state.status="reconnecting";state.reconnects+=1;await sleep(config.reconnectMs);}
    }
    if(state.status!=="error")state.status="stopped";runner=null;
  }

  function start(){if(!config.streamKey)throw new Error("YOUTUBE_STREAM_KEY is not configured");if(!config.backgroundFile)throw new Error("YOUTUBE_BACKGROUND_FILE is not configured");desired=true;if(!runner)runner=run();return info();}
  function stop(){desired=false;stopMedia();client?.close();state.connected=false;state.status="stopped";return info();}
  return{start,stop,info};
}
