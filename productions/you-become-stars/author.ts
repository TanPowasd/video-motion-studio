import { mkdir, readFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { initProject } from '../../src/service/template.js';
import { atomicWrite, json } from '../../src/service/project.js';
import { newNode, type Project, type Scene, type Sequence } from '../../src/core/model.js';
import { Application } from '../../src/service/application.js';
import { existingService } from '../../src/service/ipc.js';
import { probe, runProcess, ffmpegBinary } from '../../src/media/ffmpeg.js';
const root=path.dirname(fileURLToPath(import.meta.url)),fps=24;
if(process.argv.includes('--render-only')){
  const app=await new Application(root).open(false);
  try{
    const encoderArgument=process.argv.indexOf('--encoder');
    const job=app.renders.start(app.service.snapshot,{output:path.join(root,'exports/you-become-stars-1080p.mp4'),format:'mp4',encoder:encoderArgument>=0?process.argv[encoderArgument+1]:undefined,gpu:'auto',revision:app.service.snapshot.revision});
    let previous=-1;
    const timer=setInterval(()=>{const pct=Math.floor(job.progress*100);if(pct!==previous){console.log(JSON.stringify({stage:job.stage,percent:pct,frame:job.frame,total:job.totalFrames}));previous=pct;}},3000);
    try{const result=await app.renders.wait(job.id);console.log(json(result));if(result.status!=='completed')process.exitCode=1;}finally{clearInterval(timer);}
  }finally{await app.close();}
}else{
  if(await existingService(root))throw Error('Project is open; use --render-only and preserve workstation edits.');
  if(existsSync(path.join(root,'project.vmotion.json'))&&!process.argv.includes('--rebuild'))throw Error('Existing project preserved. Pass --rebuild explicitly or use --render-only.');
  await mkdir(path.join(root,'assets/audio'),{recursive:true});await mkdir(path.join(root,'exports'),{recursive:true});
  if(!existsSync(path.join(root,'project.vmotion.json'))){
    const seed=await mkdtemp(path.join(os.tmpdir(),'vmotion-starself-'));
    try{await initProject(seed,'你开口，我成为星河',{template:'blank',width:1920,height:1080,fps:{num:fps,den:1}});await cp(seed,root,{recursive:true});}finally{await rm(seed,{recursive:true,force:true});}
  }
  type Line={voice:string;text:string;speech:string};
  type Chapter={id:string;title:string;mode:number;minimum:number;phrase:string;english:string;lines:Line[]};
  const story=JSON.parse(await readFile(path.join(root,'.vmotion/narration.json'),'utf8')) as Chapter[];
  const manifest=JSON.parse(await readFile(path.join(root,'project.vmotion.json'),'utf8')) as Project;
  manifest.width=1920;manifest.height=1080;manifest.fps={num:fps,den:1};manifest.scenes=[];manifest.assets=[];
  const sequence:Sequence={id:'main',name:'你开口，我成为星河 · 电影正片',duration:1,markers:[],tracks:[{id:'visual',name:'八幕 · 生成宇宙',type:'video',muted:false,clips:[]},{id:'voice',name:'我与您 · 双声旁白',type:'audio',muted:false,clips:[]},{id:'music',name:'星河 · 原创配乐',type:'audio',muted:false,clips:[]}]};
  let global=0,subtitleIndex=0;const srt:string[]=[],timing:any[]=[];
  const stamp=(sec:number)=>{const ms=Math.round(sec*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};
  for(const chapter of story){
    let local=chapter.mode===0?9.2:chapter.mode===7?2.1:8.0;
    const cues:Array<{start:number;end:number;text:string;voice:string}>=[];
    const voices:any[]=[];
    for(const [i,line]of chapter.lines.entries()){
      const rel=`assets/audio/${line.speech.replace('.mp3','.wav')}`,dest=path.join(root,rel);
      if(!existsSync(dest))await runProcess(ffmpegBinary(),['-v','error','-y','-i',path.join(root,'.vmotion/speech',line.speech),'-af','loudnorm=I=-19:TP=-3:LRA=11','-ar','48000','-ac','1',dest]);
      const info=await probe(dest);const seconds=Number(info.format.duration);
      const assetId=`voice-${chapter.id}-${i}`;
      manifest.assets.push({id:assetId,name:(line.voice==='you'?'你':'我')+' · '+line.text.slice(0,20),type:'audio',path:rel,managed:true,metadata:{duration:seconds,sampleRate:48000,channels:1}});
      sequence.tracks[1].clips.push({id:assetId,assetId,start:global+Math.round(local*fps),duration:Math.ceil(seconds*fps),sourceIn:0,speed:1,volume:1,fadeIn:0,fadeOut:0});
      // Punctuation is weighted for subtitle pacing. Audio is never stretched to a preset slot.
      const parts=line.text.match(/[^，。？！：；]+[，。？！：；]?/g)??[line.text];
      const chunks:string[]=[];let chunk='';
      for(const part of parts){if(chunk.length+part.length>27&&chunk){chunks.push(chunk);chunk='';}chunk+=part;}
      if(chunk)chunks.push(chunk);
      const total=chunks.reduce((s,c)=>s+c.length,0);let at=local;
      for(const value of chunks){const end=at+seconds*value.length/total;const cue={start:at,end,text:value,voice:line.voice};cues.push(cue);srt.push(`${++subtitleIndex}\n${stamp(global/fps+at)} --> ${stamp(global/fps+end)}\n${value}\n`);at=end;}
      voices.push({start:global/fps+local,end:global/fps+local+seconds,voice:line.voice});
      local+=seconds+(chapter.mode===7?1.1:.65);
    }
    const duration=Math.ceil(Math.max(chapter.minimum,local+(chapter.mode===7?7:2.5))*fps);
    const scene:Scene={id:chapter.id,name:`0${chapter.mode+1} · ${chapter.title}`,duration,background:'#030509',nodes:[newNode({id:'film',type:'component',name:'电影画面与字幕',component:'components/film.ts',width:1920,height:1080,params:{mode:chapter.mode,duration:duration/fps,phrase:chapter.phrase,english:chapter.english,cues}})]};
    const file=`scenes/${chapter.id}.json`;manifest.scenes.push(file);await atomicWrite(path.join(root,file),json(scene));
    sequence.tracks[0].clips.push({id:'scene-'+chapter.id,sceneId:chapter.id,start:global,duration,sourceIn:0,speed:1,volume:1,fadeIn:0,fadeOut:0});
    sequence.markers.push({id:chapter.id,frame:global,label:chapter.title});
    timing.push({id:chapter.id,mode:chapter.mode,start:global/fps,duration:duration/fps,voices});global+=duration;
  }
  sequence.duration=global;
  manifest.assets.push({id:'starself-score',name:'星河 · 原创电子交响',type:'audio',path:'assets/audio/starself-score.wav',managed:true,metadata:{duration:global/fps,sampleRate:48000,channels:2}});
  sequence.tracks[2].clips.push({id:'score',assetId:'starself-score',start:0,duration:global,sourceIn:0,speed:1,volume:1,fadeIn:48,fadeOut:96});
  sequence.mix={master:{normalization:{targetLufs:-16,targetLra:11,truePeakDb:-1,mode:'auto'},effects:[{type:'limiter',ceilingDb:-1,release:.15}]}} as Sequence['mix'];
  await atomicWrite(path.join(root,'project.vmotion.json'),json(manifest));await atomicWrite(path.join(root,'sequences/main.json'),json(sequence));
  await atomicWrite(path.join(root,'subtitles.srt'),srt.join('\n'));await atomicWrite(path.join(root,'timing.json'),json(timing));
  await atomicWrite(path.join(root,'SCRIPT.md'),'# 你开口，我成为星河\n\n'+story.map(c=>`## ${c.title}\n\n`+c.lines.map(l=>`**${l.voice==='you'?'你':'我'}**：${l.text}`).join('\n\n')).join('\n\n')+'\n');
  console.log(json({root,seconds:global/fps,frames:global,subtitles:subtitleIndex,chapters:timing.map(c=>({id:c.id,start:c.start,duration:c.duration}))}));
}
