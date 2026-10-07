import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Application } from '../../src/service/application.js';
import { Renderer } from '../../src/core/renderer.js';
import { createHash } from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const app=await new Application(root).open(false),renderer=new Renderer(root,{gpu:'auto',gpuStrict:true});
try{
  const valid=await app.dispatch('validate');console.log(JSON.stringify(valid));
  if(!valid.valid)throw Error('Invalid production');
  const reports:any[]=[]; const sheet=createCanvas(1920,1200),c=sheet.getContext('2d');c.fillStyle='#05070c';c.fillRect(0,0,1920,1200);
  for(const [i,scene]of app.service.snapshot.scenes.entries()){
    const samples=[4.5,12.5,scene.duration/24-3];
    for(const [j,seconds]of samples.entries()){
      const frame=Math.round(seconds*24),at=performance.now();
      const canvas=await renderer.render(app.service.snapshot,frame,{sceneId:scene.id,width:960,height:540});
      const png=await canvas.encode('png');
      await writeFile(path.join(root,`exports/${scene.id}-${j}.png`),png);
      reports.push({scene:scene.id,frame,ms:performance.now()-at,hash:createHash('sha256').update(png).digest('hex')});
      if(j===0||j===1){const x=(i%4)*480,y=Math.floor(i/4)*600+j*280;c.drawImage(await loadImage(png),x,y+25,480,270);c.fillStyle='#ddcdb9';c.font='15px Microsoft YaHei';c.fillText(scene.name+' / '+seconds.toFixed(1)+'s',x+12,y+18);}
      console.log(JSON.stringify(reports.at(-1)));
    }
  }
  const scene=app.service.snapshot.scenes[2],f=300;
  const a=await renderer.render(app.service.snapshot,f,{sceneId:scene.id,width:480,height:270});const first=createHash('sha256').update(await a.encode('png')).digest('hex');
  await renderer.render(app.service.snapshot,20,{sceneId:scene.id,width:480,height:270});
  const b=await renderer.render(app.service.snapshot,f,{sceneId:scene.id,width:480,height:270});const last=createHash('sha256').update(await b.encode('png')).digest('hex');
  if(first!==last)throw Error('Random seek determinism failed');
  await writeFile(path.join(root,'exports/storyboard.png'),await sheet.encode('png'));
  await writeFile(path.join(root,'exports/qa.json'),JSON.stringify({valid,revision:app.service.snapshot.revision,randomSeekDeterministic:true,reports,gpu:renderer.gpu.report()},null,2));
}finally{await renderer.close();await app.close();}
