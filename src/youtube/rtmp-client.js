import tls from "node:tls";
import { EventEmitter } from "node:events";

function u24be(n){const b=Buffer.allocUnsafe(3);b[0]=(n>>>16)&255;b[1]=(n>>>8)&255;b[2]=n&255;return b;}
function u32be(n){const b=Buffer.allocUnsafe(4);b.writeUInt32BE(n>>>0,0);return b;}
function u32le(n){const b=Buffer.allocUnsafe(4);b.writeUInt32LE(n>>>0,0);return b;}

function basicHeader(fmt,csid){
  if(csid>=2&&csid<=63)return Buffer.from([(fmt<<6)|csid]);
  if(csid>=64&&csid<=319)return Buffer.from([(fmt<<6),csid-64]);
  const v=csid-64;return Buffer.from([(fmt<<6)|1,v&255,(v>>>8)&255]);
}

export function amf0Encode(value){
  if(value===null||value===undefined)return Buffer.from([5]);
  if(typeof value==="number"){const b=Buffer.allocUnsafe(9);b[0]=0;b.writeDoubleBE(value,1);return b;}
  if(typeof value==="boolean")return Buffer.from([1,value?1:0]);
  if(typeof value==="string"){
    const s=Buffer.from(value,"utf8");
    if(s.length<65536){const h=Buffer.allocUnsafe(3);h[0]=2;h.writeUInt16BE(s.length,1);return Buffer.concat([h,s]);}
    const h=Buffer.allocUnsafe(5);h[0]=12;h.writeUInt32BE(s.length,1);return Buffer.concat([h,s]);
  }
  if(Array.isArray(value)){
    const h=Buffer.allocUnsafe(5);h[0]=10;h.writeUInt32BE(value.length,1);return Buffer.concat([h,...value.map(amf0Encode)]);
  }
  if(typeof value==="object"){
    const parts=[Buffer.from([3])];
    for(const [k,v] of Object.entries(value)){
      const kb=Buffer.from(k,"utf8"),kh=Buffer.allocUnsafe(2);kh.writeUInt16BE(kb.length,0);parts.push(kh,kb,amf0Encode(v));
    }
    parts.push(Buffer.from([0,0,9]));
    return Buffer.concat(parts);
  }
  throw new TypeError("Unsupported AMF0 type: "+typeof value);
}

function amf0DecodeOne(buffer,offset=0){
  if(offset>=buffer.length)throw new Error("AMF0 truncated");
  const type=buffer[offset++];
  if(type===0){if(offset+8>buffer.length)throw new Error("AMF0 number truncated");return{value:buffer.readDoubleBE(offset),offset:offset+8};}
  if(type===1){if(offset>=buffer.length)throw new Error("AMF0 bool truncated");return{value:buffer[offset]!==0,offset:offset+1};}
  if(type===2||type===12){const n=type===2?2:4;if(offset+n>buffer.length)throw new Error("AMF0 string truncated");const len=type===2?buffer.readUInt16BE(offset):buffer.readUInt32BE(offset);offset+=n;if(offset+len>buffer.length)throw new Error("AMF0 string data truncated");return{value:buffer.toString("utf8",offset,offset+len),offset:offset+len};}
  if(type===5||type===6)return{value:null,offset};
  if(type===7){if(offset+2>buffer.length)throw new Error("AMF0 reference truncated");return{value:null,offset:offset+2};}
  if(type===11){if(offset+10>buffer.length)throw new Error("AMF0 date truncated");const value=buffer.readDoubleBE(offset);return{value,offset:offset+10};}
  if(type===3||type===8){if(type===8){if(offset+4>buffer.length)throw new Error("AMF0 ECMA array truncated");offset+=4;}const obj={};while(offset+3<=buffer.length){const len=buffer.readUInt16BE(offset);offset+=2;if(len===0&&buffer[offset]===9){offset++;break;}if(offset+len>buffer.length)throw new Error("AMF0 object key truncated");const key=buffer.toString("utf8",offset,offset+len);offset+=len;const decoded=amf0DecodeOne(buffer,offset);obj[key]=decoded.value;offset=decoded.offset;}return{value:obj,offset};}
  if(type===10){if(offset+4>buffer.length)throw new Error("AMF0 array truncated");const count=buffer.readUInt32BE(offset);offset+=4;const arr=[];for(let i=0;i<count;i++){const d=amf0DecodeOne(buffer,offset);arr.push(d.value);offset=d.offset;}return{value:arr,offset};}
  throw new Error("Unsupported AMF0 type "+type);
}

export function amf0DecodeAll(buffer){const values=[];let offset=0;while(offset<buffer.length){const d=amf0DecodeOne(buffer,offset);values.push(d.value);if(d.offset<=offset)break;offset=d.offset;}return values;}

export class RtmpPublisher extends EventEmitter{
  constructor({url,streamKey,chunkSize=4096,connectTimeoutMs=30000}={}){
    super();
    if(!url)throw new Error("RTMP URL is required");
    if(!streamKey)throw new Error("RTMP stream key is required");
    this.url=new URL(url);
    if(this.url.protocol!=="rtmps:")throw new Error("Only rtmps:// is supported");
    this.streamKey=streamKey;
    this.outChunkSize=Math.max(128,Number(chunkSize)||4096);
    this.inChunkSize=128;
    this.connectTimeoutMs=connectTimeoutMs;
    this.socket=null;
    this.connected=false;
    this.publishing=false;
    this.streamId=0;
    this.buffer=Buffer.alloc(0);
    this.handshakeState="idle";
    this.chunkState=new Map();
    this.bytesReceived=0;
    this.lastAck=0;
    this.windowAckSize=2500000;
    this.sentWindowAckSize=0;
    this.peerBandwidth=0;
    this.peerBandwidthLimitType=null;
    this.phase="idle";
    this._connectResolve=null;this._connectReject=null;this._connectTimer=null;
  }

  get app(){const p=this.url.pathname.replace(/^\/+|\/+$/g,"");return p||"live2";}
  get host(){return this.url.hostname;}
  get port(){return Number(this.url.port||443);}
  get tcUrl(){return `rtmps://${this.host}:${this.port}/${this.app}`;}

  _setPhase(phase){if(this.phase===phase)return;this.phase=phase;this.emit("phase",{phase,at:Date.now()});}

  async connect(){
    if(this.publishing)return this;
    if(this.socket)throw new Error("RTMP connection already in progress");
    this.buffer=Buffer.alloc(0);this.chunkState.clear();this.inChunkSize=128;this.bytesReceived=0;this.lastAck=0;this.streamId=0;this.sentWindowAckSize=0;this.peerBandwidth=0;this.peerBandwidthLimitType=null;this.handshakeState="waiting-s0s1s2";this._setPhase("tls-connecting");
    return new Promise((resolve,reject)=>{
      this._connectResolve=resolve;this._connectReject=reject;
      this._connectTimer=setTimeout(()=>this._fail(new Error(`RTMP connect timeout during ${this.phase}`)),this.connectTimeoutMs);
      const socket=tls.connect({host:this.host,port:this.port,servername:this.host,rejectUnauthorized:true});
      this.socket=socket;
      socket.setNoDelay(true);socket.setKeepAlive(true,30000);
      socket.on("secureConnect",()=>{this._setPhase("rtmp-handshake");this._sendC0C1();});
      socket.on("data",chunk=>this._onData(chunk));
      socket.on("error",error=>this._fail(error));
      socket.on("close",()=>this._onClose());
    });
  }

  _sendC0C1(){
    const c1=Buffer.alloc(1536);c1.writeUInt32BE(Math.floor(Date.now()/1000)>>>0,0);c1.writeUInt32BE(0,4);for(let i=8;i<c1.length;i++)c1[i]=Math.floor(Math.random()*256);
    this.socket?.write(Buffer.concat([Buffer.from([3]),c1]));
  }

  _onData(chunk){
    this.bytesReceived+=chunk.length;
    this.buffer=this.buffer.length?Buffer.concat([this.buffer,chunk]):chunk;
    if(this.handshakeState!=="done"){
      if(this.handshakeState==="waiting-s0s1s2"&&this.buffer.length>=3073){
        const version=this.buffer[0];if(version!==3)return this._fail(new Error("Unsupported RTMP version "+version));
        const s1=this.buffer.subarray(1,1537);this.buffer=this.buffer.subarray(3073);this.socket?.write(s1);this.handshakeState="done";this.connected=true;this._setPhase("connect-command");this._sendConnect();
      }else return;
    }
    this._parseChunks();
    if(this.windowAckSize>0&&this.bytesReceived-this.lastAck>=this.windowAckSize/2){this.lastAck=this.bytesReceived;this._sendMessage({csid:2,typeId:3,streamId:0,timestamp:0,payload:u32be(this.bytesReceived)});}
  }

  _parseBasicHeader(offset){if(offset>=this.buffer.length)return null;const b=this.buffer[offset],fmt=b>>>6,id=b&63;if(id===0){if(offset+2>this.buffer.length)return null;return{fmt,csid:64+this.buffer[offset+1],size:2};}if(id===1){if(offset+3>this.buffer.length)return null;return{fmt,csid:64+this.buffer[offset+1]+(this.buffer[offset+2]<<8),size:3};}return{fmt,csid:id,size:1};}

  _parseChunks(){
    let offset=0;
    while(offset<this.buffer.length){
      const basic=this._parseBasicHeader(offset);if(!basic)break;let p=offset+basic.size;const prev=this.chunkState.get(basic.csid)||{};let state={...prev};
      let headerSize=basic.fmt===0?11:basic.fmt===1?7:basic.fmt===2?3:0;if(p+headerSize>this.buffer.length)break;
      let tsField=null;
      if(basic.fmt===0){tsField=this.buffer.readUIntBE(p,3);state.timestamp=tsField;state.timestampDelta=0;state.length=this.buffer.readUIntBE(p+3,3);state.typeId=this.buffer[p+6];state.streamId=this.buffer.readUInt32LE(p+7);state.received=0;state.parts=[];p+=11;}
      else if(basic.fmt===1){if(prev.streamId===undefined)break;tsField=this.buffer.readUIntBE(p,3);state.timestampDelta=tsField;state.timestamp=(prev.timestamp||0)+tsField;state.length=this.buffer.readUIntBE(p+3,3);state.typeId=this.buffer[p+6];state.received=0;state.parts=[];p+=7;}
      else if(basic.fmt===2){if(prev.length===undefined)break;tsField=this.buffer.readUIntBE(p,3);state.timestampDelta=tsField;state.timestamp=(prev.timestamp||0)+tsField;state.received=0;state.parts=[];p+=3;}
      else {if(prev.length===undefined)break;if((prev.received||0)>=(prev.length||0)){state.timestamp=(prev.timestamp||0)+(prev.timestampDelta||0);state.received=0;state.parts=[];}}
      const needsExt=(tsField===0xffffff)||(basic.fmt===3&&prev.extendedTimestamp===true);
      if(needsExt){if(p+4>this.buffer.length)break;const ext=this.buffer.readUInt32BE(p);p+=4;state.extendedTimestamp=true;if(basic.fmt===0)state.timestamp=ext;else if(basic.fmt===1||basic.fmt===2){state.timestampDelta=ext;state.timestamp=(prev.timestamp||0)+ext;}else if((prev.received||0)>=(prev.length||0))state.timestamp=(prev.timestamp||0)+(prev.timestampDelta||0);}else state.extendedTimestamp=false;
      const remaining=state.length-(state.received||0);const take=Math.min(this.inChunkSize,remaining);if(p+take>this.buffer.length)break;
      if(take>0){state.parts=[...(state.parts||[]),this.buffer.subarray(p,p+take)];state.received=(state.received||0)+take;p+=take;}
      this.chunkState.set(basic.csid,state);offset=p;
      if(state.received===state.length){const payload=Buffer.concat(state.parts,state.length);this._handleMessage({...state,payload,csid:basic.csid});state.parts=[];this.chunkState.set(basic.csid,state);}
    }
    if(offset>0)this.buffer=this.buffer.subarray(offset);
  }

  _handleMessage(msg){
    if(msg.typeId===1&&msg.payload.length>=4){this.inChunkSize=msg.payload.readUInt32BE(0)&0x7fffffff;return;}
    if(msg.typeId===5&&msg.payload.length>=4){this.windowAckSize=msg.payload.readUInt32BE(0);return;}
    if(msg.typeId===6&&msg.payload.length>=5){
      const size=msg.payload.readUInt32BE(0),limitType=msg.payload[4];
      this.peerBandwidth=size;this.peerBandwidthLimitType=limitType;
      if(size>0&&this.sentWindowAckSize!==size){this._sendMessage({csid:2,typeId:5,streamId:0,timestamp:0,payload:u32be(size)});this.sentWindowAckSize=size;}
      this.emit("bandwidth",{size,limitType});return;
    }
    if(msg.typeId===4&&msg.payload.length>=6){const event=msg.payload.readUInt16BE(0);if(event===6){const response=Buffer.allocUnsafe(6);response.writeUInt16BE(7,0);msg.payload.copy(response,2,2,6);this._sendMessage({csid:2,typeId:4,streamId:0,timestamp:0,payload:response});}return;}
    if(msg.typeId!==20&&msg.typeId!==17)return;
    let payload=msg.payload;if(msg.typeId===17&&payload[0]===0)payload=payload.subarray(1);
    let values;try{values=amf0DecodeAll(payload);}catch{return;}
    const command=values[0],transaction=Number(values[1]||0);
    if(command==="_error"){
      const info=values.find(v=>v&&typeof v==="object"&&(v.code||v.description));
      if(transaction===2||transaction===3){this.emit("warning",{transaction,code:String(info?.code||""),description:String(info?.description||"")});return;}
      return this._fail(new Error("RTMP command error: "+String(info?.code||info?.description||"unknown")));
    }
    if(command==="_result"&&transaction===1){this._setPhase("stream-creating");this._afterConnectResult();return;}
    if(command==="_result"&&transaction===4){const id=Number(values[3]||0);if(!id)return this._fail(new Error("RTMP createStream returned no stream id"));this.streamId=id;this._setPhase("publish-command");this._sendPublish();return;}
    if(command==="onStatus"){
      const info=values.find(v=>v&&typeof v==="object"&&typeof v.code==="string");const code=info?.code||"";this.emit("status",info||{});
      if(code==="NetStream.Publish.Start"){
        this.publishing=true;this._setPhase("live");clearTimeout(this._connectTimer);this._connectTimer=null;const r=this._connectResolve;this._connectResolve=null;this._connectReject=null;r?.(this);this.emit("publish");
      }else if(code.includes("Failed")||code.includes("BadName")||code.includes("Denied"))this._fail(new Error("RTMP publish rejected: "+code));
    }
  }

  _sendCommand(csid,streamId,...values){this._sendMessage({csid,typeId:20,streamId,timestamp:0,payload:Buffer.concat(values.map(amf0Encode))});}
  _sendConnect(){
    this._sendMessage({csid:2,typeId:1,streamId:0,timestamp:0,payload:u32be(this.outChunkSize)});
    this._sendCommand(3,0,"connect",1,{app:this.app,type:"nonprivate",tcUrl:this.tcUrl,flashVer:"FMLE/3.0 (compatible; AharonTTS/0.9)",fpad:false,capabilities:15,audioCodecs:3575,videoCodecs:252,videoFunction:1,objectEncoding:0});
  }
  _afterConnectResult(){
    const window=Math.max(1,this.peerBandwidth||this.windowAckSize||2500000);
    if(this.sentWindowAckSize!==window){this._sendMessage({csid:2,typeId:5,streamId:0,timestamp:0,payload:u32be(window)});this.sentWindowAckSize=window;}
    this._sendCommand(3,0,"releaseStream",2,null,this.streamKey);
    this._sendCommand(3,0,"FCPublish",3,null,this.streamKey);
    this._sendCommand(3,0,"createStream",4,null);
  }
  _sendPublish(){this._sendCommand(8,this.streamId,"publish",0,null,this.streamKey,"live");}

  _sendMessage({csid=3,typeId,streamId=0,timestamp=0,payload}){
    if(!this.socket||this.socket.destroyed)throw new Error("RTMP socket is not connected");
    payload=Buffer.from(payload||Buffer.alloc(0));const ts=Math.max(0,Math.floor(timestamp));const tsField=Math.min(ts,0xffffff);
    const mh=Buffer.concat([u24be(tsField),u24be(payload.length),Buffer.from([typeId]),u32le(streamId)]);const ext=ts>=0xffffff?u32be(ts):null;
    const parts=[];let offset=0;let first=true;
    while(first||offset<payload.length){parts.push(basicHeader(first?0:3,csid));if(first){parts.push(mh);if(ext)parts.push(ext);}else if(ext)parts.push(ext);const end=Math.min(payload.length,offset+this.outChunkSize);if(end>offset)parts.push(payload.subarray(offset,end));offset=end;first=false;if(payload.length===0)break;}
    this.socket.write(Buffer.concat(parts));
  }

  sendAudio(payload,timestamp){if(!this.publishing)return false;this._sendMessage({csid:4,typeId:8,streamId:this.streamId,timestamp,payload});return true;}
  sendVideo(payload,timestamp){if(!this.publishing)return false;this._sendMessage({csid:6,typeId:9,streamId:this.streamId,timestamp,payload});return true;}
  sendMetadata(metadata){if(!this.publishing)return false;const payload=Buffer.concat([amf0Encode("@setDataFrame"),amf0Encode("onMetaData"),amf0Encode(metadata)]);this._sendMessage({csid:5,typeId:18,streamId:this.streamId,timestamp:0,payload});return true;}

  close(){const socket=this.socket;this.socket=null;this.connected=false;this.publishing=false;clearTimeout(this._connectTimer);this._connectTimer=null;this._setPhase("closed");if(socket&&!socket.destroyed)socket.destroy();}
  _fail(error){if(!error)error=new Error("RTMP failure");if(error&&typeof error==="object"&&!error.rtmpPhase)error.rtmpPhase=this.phase;this._setPhase("failed");const reject=this._connectReject;this._connectResolve=null;this._connectReject=null;clearTimeout(this._connectTimer);this._connectTimer=null;if(reject)reject(error);this.emit("error",error);this.close();}
  _onClose(){const wasPublishing=this.publishing;this.socket=null;this.connected=false;this.publishing=false;clearTimeout(this._connectTimer);this._connectTimer=null;if(this._connectReject){const reject=this._connectReject;this._connectResolve=null;this._connectReject=null;reject(new Error(`RTMP socket closed before publish started during ${this.phase}`));}this.emit("close",{wasPublishing});}
}
