import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, resolve } from "node:path";

const require=createRequire(import.meta.url);

function readType(buffer,offset){return buffer.toString("ascii",offset,offset+4);}
function boxes(buffer,start=0,end=buffer.length){
  const out=[];let p=start;
  while(p+8<=end){
    let size=buffer.readUInt32BE(p);const type=readType(buffer,p+4);let header=8;
    if(size===1){if(p+16>end)break;const big=buffer.readBigUInt64BE(p+8);if(big>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("MP4 box too large");size=Number(big);header=16;}
    else if(size===0)size=end-p;
    if(size<header||p+size>end)break;
    out.push({type,start:p,size,header,bodyStart:p+header,end:p+size});p+=size;
  }
  return out;
}
function child(buffer,parent,type){return boxes(buffer,parent.bodyStart,parent.end).find(b=>b.type===type)||null;}
function children(buffer,parent,type){return boxes(buffer,parent.bodyStart,parent.end).filter(b=>!type||b.type===type);}
function path(buffer,root,...types){let b=root;for(const type of types){b=child(buffer,b,type);if(!b)return null;}return b;}
function mdhdTimescale(buffer,box){const version=buffer[box.bodyStart];const p=box.bodyStart+(version===1?20:12);if(p+4>box.end)throw new Error("Invalid mdhd");return buffer.readUInt32BE(p);}
function handlerType(buffer,box){const p=box.bodyStart+8;return p+4<=box.end?readType(buffer,p):"";}

function parseStsz(buffer,box){let p=box.bodyStart+4;if(p+8>box.end)throw new Error("Invalid stsz");const fixed=buffer.readUInt32BE(p);p+=4;const count=buffer.readUInt32BE(p);p+=4;if(fixed)return Array(count).fill(fixed);const out=[];for(let i=0;i<count;i++){if(p+4>box.end)throw new Error("Truncated stsz");out.push(buffer.readUInt32BE(p));p+=4;}return out;}
function parseChunkOffsets(buffer,box){let p=box.bodyStart+4;if(p+4>box.end)throw new Error("Invalid "+box.type);const count=buffer.readUInt32BE(p);p+=4;const out=[];for(let i=0;i<count;i++){if(box.type==="stco"){if(p+4>box.end)throw new Error("Truncated stco");out.push(buffer.readUInt32BE(p));p+=4;}else{if(p+8>box.end)throw new Error("Truncated co64");const n=buffer.readBigUInt64BE(p);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("MP4 offset too large");out.push(Number(n));p+=8;}}return out;}
function parseStsc(buffer,box){let p=box.bodyStart+4;if(p+4>box.end)throw new Error("Invalid stsc");const count=buffer.readUInt32BE(p);p+=4;const out=[];for(let i=0;i<count;i++){if(p+12>box.end)throw new Error("Truncated stsc");out.push({firstChunk:buffer.readUInt32BE(p),samplesPerChunk:buffer.readUInt32BE(p+4),sampleDescriptionIndex:buffer.readUInt32BE(p+8)});p+=12;}return out;}
function expandTiming(buffer,box,sampleCount,signed=false){let p=box.bodyStart+4;if(p+4>box.end)throw new Error("Invalid "+box.type);const entries=buffer.readUInt32BE(p);p+=4;const out=[];for(let i=0;i<entries;i++){if(p+8>box.end)throw new Error("Truncated "+box.type);const count=buffer.readUInt32BE(p);const value=signed?buffer.readInt32BE(p+4):buffer.readUInt32BE(p+4);p+=8;for(let j=0;j<count&&out.length<sampleCount;j++)out.push(value);}while(out.length<sampleCount)out.push(0);return out;}
function parseStss(buffer,box){if(!box)return null;let p=box.bodyStart+4;if(p+4>box.end)return null;const count=buffer.readUInt32BE(p);p+=4;const set=new Set();for(let i=0;i<count&&p+4<=box.end;i++,p+=4)set.add(buffer.readUInt32BE(p));return set;}
function parseAvcC(buffer,stsd){
  let p=stsd.bodyStart+8;if(p+8>stsd.end)throw new Error("Invalid stsd");const entrySize=buffer.readUInt32BE(p),entryType=readType(buffer,p+4);if(entryType!=="avc1"&&entryType!=="avc3")throw new Error("Expected AVC sample entry, got "+entryType);const entryEnd=p+entrySize;const childStart=p+8+78;if(childStart>entryEnd)throw new Error("Invalid AVC sample entry");const avc=boxes(buffer,childStart,entryEnd).find(b=>b.type==="avcC");if(!avc)throw new Error("MP4 avcC not found");return Buffer.from(buffer.subarray(avc.bodyStart,avc.end));
}
function sampleIsKey(data){let p=0;while(p+4<=data.length){const n=data.readUInt32BE(p);p+=4;if(n<=0||p+n>data.length)break;const type=data[p]&31;if(type===5)return true;p+=n;}return false;}

export function parseAvcMp4(input){
  const buffer=Buffer.from(input);const root={bodyStart:0,end:buffer.length};const moov=child(buffer,root,"moov");if(!moov)throw new Error("MP4 moov not found");
  let trak=null;for(const t of children(buffer,moov,"trak")){const h=path(buffer,t,"mdia","hdlr");if(h&&handlerType(buffer,h)==="vide"){trak=t;break;}}
  if(!trak)throw new Error("MP4 video track not found");const mdia=child(buffer,trak,"mdia"),mdhd=child(buffer,mdia,"mdhd"),stbl=path(buffer,mdia,"minf","stbl");if(!mdhd||!stbl)throw new Error("Invalid MP4 video track");
  const timescale=mdhdTimescale(buffer,mdhd);const stsd=child(buffer,stbl,"stsd"),stsz=child(buffer,stbl,"stsz"),stsc=child(buffer,stbl,"stsc"),stco=child(buffer,stbl,"stco")||child(buffer,stbl,"co64"),stts=child(buffer,stbl,"stts");if(!stsd||!stsz||!stsc||!stco||!stts)throw new Error("MP4 sample table incomplete");
  const avcC=parseAvcC(buffer,stsd),sizes=parseStsz(buffer,stsz),chunkOffsets=parseChunkOffsets(buffer,stco),sc=parseStsc(buffer,stsc),durations=expandTiming(buffer,stts,sizes.length,false);const ctts=child(buffer,stbl,"ctts"),composition=ctts?expandTiming(buffer,ctts,sizes.length,buffer[ctts.bodyStart]===1):Array(sizes.length).fill(0);const sync=parseStss(buffer,child(buffer,stbl,"stss"));
  const offsets=[];let sampleIndex=0;for(let chunkIndex=1;chunkIndex<=chunkOffsets.length&&sampleIndex<sizes.length;chunkIndex++){
    let entry=sc[0];for(const candidate of sc){if(candidate.firstChunk<=chunkIndex)entry=candidate;else break;}if(!entry)throw new Error("MP4 stsc has no entry for chunk "+chunkIndex);let pos=chunkOffsets[chunkIndex-1];for(let j=0;j<entry.samplesPerChunk&&sampleIndex<sizes.length;j++){offsets.push(pos);pos+=sizes[sampleIndex++];}
  }
  if(offsets.length!==sizes.length)throw new Error("MP4 sample map mismatch "+offsets.length+"/"+sizes.length);
  const samples=sizes.map((size,i)=>{const start=offsets[i],end=start+size;if(start<0||end>buffer.length)throw new Error("MP4 sample outside file");const data=Buffer.from(buffer.subarray(start,end));return{data,durationMs:durations[i]*1000/timescale,compositionMs:composition[i]*1000/timescale,key:sync?sync.has(i+1):sampleIsKey(data)};});
  if(!samples.length)throw new Error("MP4 contains no video samples");if(!samples[0].key)samples[0].key=true;
  return{avcC,timescale,samples,durationMs:samples.reduce((n,s)=>n+s.durationMs,0)};
}

function resizeCoverRgba(source,sourceWidth,sourceHeight,width,height){
  const scale=Math.max(width/sourceWidth,height/sourceHeight);
  const cropWidth=width/scale,cropHeight=height/scale;
  const offsetX=(sourceWidth-cropWidth)/2,offsetY=(sourceHeight-cropHeight)/2;
  const out=Buffer.allocUnsafe(width*height*4);
  for(let y=0;y<height;y++){
    const sy=Math.max(0,Math.min(sourceHeight-1,Math.floor(offsetY+(y+0.5)/scale)));
    for(let x=0;x<width;x++){
      const sx=Math.max(0,Math.min(sourceWidth-1,Math.floor(offsetX+(x+0.5)/scale)));
      const si=(sy*sourceWidth+sx)*4,di=(y*width+x)*4;out[di]=source[si];out[di+1]=source[si+1];out[di+2]=source[si+2];out[di+3]=255;
    }
  }
  return out;
}

function stripBase64Whitespace(value){
  return String(value).split(" ").join("").split(String.fromCharCode(10)).join("").split(String.fromCharCode(13)).join("").split(String.fromCharCode(9)).join("");
}

async function readBackgroundBytes(file){
  const location=String(file||"");
  if(location.endsWith(".parts.json")){
    const manifest=JSON.parse(await readFile(location,"utf8"));
    if(manifest?.encoding!=="base64"||!Array.isArray(manifest.parts)||manifest.parts.length===0)throw new Error("Invalid YouTube background parts manifest");
    let encoded="";
    for(const rawName of manifest.parts){
      const name=String(rawName||"").trim();
      if(!name||name.includes("..")||name.includes("/")||name.includes(String.fromCharCode(92)))throw new Error("Invalid YouTube background part name");
      encoded+=await readFile(resolve(dirname(location),name),"utf8");
    }
    const bytes=Buffer.from(stripBase64Whitespace(encoded),"base64");
    if(!bytes.length)throw new Error("Bundled YouTube background decoded to an empty file");
    return bytes;
  }
  const stored=await readFile(location);
  return location.endsWith(".b64")?Buffer.from(stripBase64Whitespace(stored.toString("ascii")),"base64"):stored;
}

async function readBackgroundRgba(file,width,height){
  const bytes=await readBackgroundBytes(file);
  let decoded;
  if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){const {PNG}=require("pngjs");decoded=PNG.sync.read(bytes);}
  else if(bytes.length>=2&&bytes[0]===0xff&&bytes[1]===0xd8){const jpeg=require("jpeg-js");decoded=jpeg.decode(bytes,{useTArray:true,formatAsRGBA:true});}
  else throw new Error("Unsupported YouTube background image; use PNG or JPEG");
  if(!decoded?.width||!decoded?.height||!decoded?.data)throw new Error("Failed to decode YouTube background image");
  return resizeCoverRgba(decoded.data,decoded.width,decoded.height,width,height);
}

export function preencodedBackgroundPath(file,{width=1280,height=720,fps=30,gopSeconds=2,bitrateKbps=2500}={}){
  const exactDefault=width===1280&&height===720&&fps===30&&gopSeconds===2&&bitrateKbps===2500;
  if(!exactDefault||!file)return null;
  const configured=String(process.env.YOUTUBE_PREENCODED_BACKGROUND_FILE||"").trim();
  if(configured)return configured;
  const location=String(file);
  const ext=extname(location);
  const stem=basename(location,ext);
  return resolve(dirname(location),stem+"-1280x720-30fps.mp4");
}

export async function encodeStaticBackground({file,width=1280,height=720,fps=30,gopSeconds=2,bitrateKbps=2500}={}){
  if(!file)throw new Error("YouTube background image file is required");
  const preencoded=preencodedBackgroundPath(file,{width,height,fps,gopSeconds,bitrateKbps});
  if(preencoded){
    try{
      const parsed=parseAvcMp4(await readBackgroundBytes(preencoded));
      return {...parsed,preencoded:true,preencodedFile:preencoded};
    }catch(error){
      if(error?.code!=="ENOENT")console.warn("[YOUTUBE] preencoded background unavailable, falling back to runtime encoder:",error instanceof Error?error.message:String(error));
    }
  }
  const HME=require("h264-mp4-encoder");
  const rgba=await readBackgroundRgba(file,width,height);
  if(rgba.length!==width*height*4)throw new Error("Unexpected RGBA background size");
  const encoder=await HME.createH264MP4Encoder();const frameCount=Math.max(1,Math.round(fps*gopSeconds));const output="youtube-"+crypto.randomUUID()+".mp4";
  try{
    encoder.outputFilename=output;encoder.width=width;encoder.height=height;encoder.frameRate=fps;encoder.kbps=bitrateKbps;encoder.speed=10;encoder.groupOfPictures=frameCount;encoder.initialize();
    for(let i=0;i<frameCount;i++)encoder.addFrameRgba(rgba);
    encoder.finalize();const mp4=Buffer.from(encoder.FS.readFile(output));return {...parseAvcMp4(mp4),preencoded:false};
  }finally{try{encoder.FS.unlink(output);}catch{}encoder.delete();}
}