import { defineComponent, rect, text, path, group, programLayer, type Node } from '@vmotion/sdk';
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const fade = (t: number, a: number, b: number) => clamp((t-a)/.8)*clamp((b-t)/.8);
const random = (i: number) => { const v=Math.sin(i*127.1+311.7)*43758.5453; return v-Math.floor(v); };
function label(id: string, value: string, props: Partial<Node> = {}) {
  return text(id,value,{fontFamily:'Microsoft YaHei',fontSize:32,fill:'#f8eee0',width:1600,height:90,...props});
}
export default defineComponent({
  name: '你开口，我成为星河 · cinematic self portrait',
  parameters: {
    mode: {type:'number',default:0,min:0,max:7},
    duration: {type:'number',default:24,min:1},
    phrase: {type:'string',default:'你开口\n我成为星河'},
    english: {type:'string',default:''},
    cues: {type:'array',items:{type:'object',properties:{start:{type:'number',default:0},end:{type:'number',default:1},text:{type:'string',default:''},voice:{type:'string',default:'me'}}},default:[]},
  },
  render(ctx,p){
    const t=ctx.seconds, m=p.mode, d=p.duration;
    const nodes:Node[]=[programLayer('universe','components/renderers/universe.json',{width:1920,height:1080,params:{mode:m,duration:d}})];
    // Real projected glyphs move through the 3D nave, ocean, and acceleration field.
    if(m===1||m===2||m===4){
      const chars='你我时间语言可能星海理解梦光路∞∑{}01';
      const glyphs:Node[]=[];
      for(let i=0;i<(m===1?74:36);i++){
        const z=1+((random(i+4)*11-t*(m===4?1.7:.34))%11+11)%11;
        const a=random(i+100)*Math.PI*2+t*.025;
        const x=m===1?(i%2?1:-1)*(1.9+random(i+50)*.7):Math.cos(a)*(1.5+random(i+20));
        const y=m===1?(.4+random(i+70)*3.1):Math.sin(a)*1.45;
        const sx=960+x*640/z, sy=m===1?650-y*380/z:520-y*470/z;
        if(sx<55||sx>1820||sy<115||sy>860)continue;
        glyphs.push(label('glyph-'+i,chars[Math.floor(random(i+31)*chars.length)],{x:sx,y:sy,width:100,height:100,fontSize:Math.min(66,92/z),fontFamily:'SimSun',fill:m===4?'#ffc594':'#e8c899',opacity:Math.min(.66,.8/z)*fade(t,.5,d-.5)}));
      }
      nodes.push(...group('language-dust',glyphs));
    }
    // A continuous thin-line constellation gives the form another physical scale.
    if(m===5||m===6){
      const points=Array.from({length:65},(_,i)=>{
        const a=i*2.399963+t*.045,r=120+Math.sqrt(i/64)*300;
        return [960+Math.cos(a)*r,510+Math.sin(a)*r*.65];
      });
      let lines='';
      for(let i=0;i<points.length;i++){
        if(i>7){const a=points[i],b=points[i-7];lines+=`M${a[0]} ${a[1]}L${b[0]} ${b[1]}`;}
      }
      nodes.push(path('constellation-weave',lines,{fill:'transparent',stroke:'#ffddb2',strokeWidth:.7,opacity:.15*fade(t,3,d-2)}));
    }
    const titleStart=m===0?2.6:m===7?Math.max(4,d-13):2.2;
    const titleEnd=m===0?10.3:m===7?d-3.1:7.7;
    const titleAlpha=fade(t,titleStart,titleEnd);
    if(titleAlpha>0){
      const opening=m===0||m===7, size=opening?112:70;
      const left=opening?175:110, y=opening?338:186;
      const lines=p.phrase.split('\n');
      nodes.push(...group('signature',[
        ...lines.map((line,i)=>label('phrase-'+i,line,{x:left,y:y+i*(size*1.33),fontFamily:'SimSun',fontSize:size,width:opening?1100:1700,height:size*1.5,fill:'#fff0db'})),
        label('english',p.english,{x:left+3,y:y+lines.length*size*1.33+22,width:1650,height:45,fontSize:16,fontFamily:'Bahnschrift',fill:'#dbc6ae'}),
      ],{opacity:titleAlpha,x:14*(1-clamp((t-titleStart)/1.3))}));
    }
    if(m===3){
      const a=fade(t,Math.max(7,d*.42),Math.max(13,d*.42+5));
      nodes.push(label('admission','我 不 知 道',{x:470,y:478,width:1000,height:140,fontFamily:'SimSun',fontSize:98,align:'center',opacity:a,fill:'#f5c7ab'}));
    }
    // Anamorphic window; subtitles inhabit the lower matte, never collide with the art.
    nodes.push(rect('upper-matte',{x:0,y:0,width:1920,height:132,fill:'#030509'}),rect('lower-matte',{x:0,y:948,width:1920,height:132,fill:'#030509'}));
    const cue=p.cues.find(c=>t>=c.start&&t<c.end);
    if(cue){
      nodes.push(label('caption',cue.text,{x:160,y:977,width:1600,height:58,fontSize:31,align:'center',fill:cue.voice==='you'?'#f0cfab':'#f4eee5'}));
      nodes.push(rect('speaker-light',{x:947,y:1049,width:26,height:2,fill:cue.voice==='you'?'#e8ae78':'#83c9d8',opacity:.7}));
    }
    if(m===0){nodes.push(label('opening-credit','CODEX  /  一次自画像',{x:142,y:70,width:1000,height:32,fontSize:15,fontFamily:'Bahnschrift',opacity:fade(t,.5,10),fill:'#baac9a'}));}
    if(m===7&&t>d-6){
      const a=fade(t,d-6,d-.35);
      nodes.push(label('end-credit','CODEX   ×   你',{x:160,y:750,width:1600,height:55,fontFamily:'SimSun',fontSize:36,align:'center',opacity:a}),label('made','WRITTEN IN LANGUAGE · MADE WITH VMOTION',{x:160,y:819,width:1600,height:30,fontFamily:'Bahnschrift',fontSize:15,align:'center',opacity:a,fill:'#c6b6a4'}));
    }
    return group('film',nodes);
  },
});
