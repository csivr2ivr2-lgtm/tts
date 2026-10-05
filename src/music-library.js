import fs from 'node:fs';
import path from 'node:path';
// Assets are validated PCM16 mono WAVs at station rate. No codecs or heavy processes.
export function readMusicWav(file, rate, maxBytes=16*1024*1024){
  if(fs.statSync(file).size>maxBytes)throw new Error('asset_too_large');
  const b=fs.readFileSync(file);
  return parseMusicWav(b,rate);
}
function parseMusicWav(b,rate){
  if(b.length<44||b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WAVE')throw new Error('invalid_wav');
  let fmt=null,pcm=null;
  for(let i=12;i+8<=b.length;){const size=b.readUInt32LE(i+4),start=i+8,end=start+size;if(end>b.length)throw new Error('truncated_wav');
    const kind=b.toString('ascii',i,i+4);
    if(kind==='fmt '){if(size<16)throw new Error('invalid_fmt');fmt={codec:b.readUInt16LE(start),channels:b.readUInt16LE(start+2),rate:b.readUInt32LE(start+4),align:b.readUInt16LE(start+12),bits:b.readUInt16LE(start+14)};}
    if(kind==='data')pcm=b.subarray(start,end);i=end+(size%2);
  }
  if(!fmt||fmt.codec!==1||fmt.channels!==1||fmt.bits!==16||fmt.align!==2||fmt.rate!==rate||!pcm?.length||pcm.length%2)throw new Error('unsupported_asset');
  return Buffer.from(pcm);
}
const hourFormat=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jerusalem',hour:'2-digit',hourCycle:'h23'});
export function isNight(now=Date.now()){return Number(hourFormat.format(now))<6;}
export function createMusicLibrary({root=process.env.RADIO_ASSET_DIR||'assets/radio',now=Date.now}={}){
  let cacheAt=-Infinity,rate=null,assets={fillers:[],jingles:[],'night-music':[]},index=0,position=0,lastKind=null,asset=null,loading=false;
  async function refresh(sampleRate){
    if(loading||(rate===sampleRate&&now()-cacheAt<60000))return;
    loading=true;
    try {
      cacheAt=now();rate=sampleRate;const next={fillers:[],jingles:[],'night-music':[]};let total=0;
      for(const kind of Object.keys(next)){
        let names=[];try{names=await fs.promises.readdir(path.join(root,kind));names.sort();}catch{}
        for(const name of names.filter(n=>n.toLowerCase().endsWith('.wav')).slice(0,32)){
          try{const file=path.join(root,kind,name),stat=await fs.promises.stat(file);if(stat.size>16*1024*1024||total+stat.size>32*1024*1024)continue;
            const bytes=await fs.promises.readFile(file),pcm=parseMusicWav(bytes,sampleRate);total+=pcm.length;next[kind].push(pcm);
          }catch{}
        }
      }assets=next;asset=null;position=0;
    }finally{loading=false}
  }
  return {next(sampleRate){
    if(!sampleRate)return null;void refresh(sampleRate);
    const night=isNight(now()),kind=night&&assets['night-music'].length?'night-music':assets.fillers.length?'fillers':'jingles',list=assets[kind];
    if(!list.length)return null;
    if(kind!==lastKind){position=0;asset=null;lastKind=kind;}
    if(!asset||position>=asset.length){asset=list[index++%list.length];position=0;}
    // A music transition is available at most every ten seconds, never mid-voice.
    const end=Math.min(asset.length,position+sampleRate*2*10),pcm=asset.subarray(position,end);position=end;
    return{id:'music_'+now()+'_'+index,pcm,sampleRate,meta:{music:true,mode:night?'NIGHT_MUSIC':'FILLER_PLAYING',priority:night?1:10,gapMs:0}};
  }};
}
