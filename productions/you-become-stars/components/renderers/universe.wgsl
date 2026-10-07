// Every frame is a pure function of Vmotion's supplied clock. No feedback buffers.
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<storage, read> clock: array<vec4<f32>>;
const PI: f32 = 3.14159265;
const GOLD: vec3<f32> = vec3<f32>(1.0, .47, .13);
const ICE: vec3<f32> = vec3<f32>(.16, .66, .92);
fn hash(p: vec2<f32>) -> f32 { return fract(sin(dot(p,vec2<f32>(127.1,311.7)))*43758.5453); }
fn noise(p: vec2<f32>) -> f32 {
  let i=floor(p); let f=fract(p); let u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2<f32>(1,0)),u.x),mix(hash(i+vec2<f32>(0,1)),hash(i+vec2<f32>(1,1)),u.x),u.y);
}
fn fbm(p0: vec2<f32>) -> f32 {
  var p=p0; var n=0.0; var a=.5;
  for(var i=0;i<4;i++){ n+=a*noise(p); p=vec2<f32>(p.x*1.7-p.y*1.1,p.x*1.1+p.y*1.7)+7.1; a*=.5; }
  return n;
}
fn rot(p:vec2<f32>,a:f32)->vec2<f32>{return vec2<f32>(cos(a)*p.x-sin(a)*p.y,sin(a)*p.x+cos(a)*p.y);}
fn stars(uv:vec2<f32>,t:f32)->vec3<f32>{
  var col=vec3<f32>(0);
  for(var k=0;k<3;k++){
    let size=90.0+f32(k)*56.0; let p=uv*size+vec2<f32>(t*.15,0);
    let g=floor(p); let h=hash(g+f32(k)*19.0);
    let q=fract(p)-vec2<f32>(hash(g+5.1),hash(g+9.2));
    let d=length(q); let b=pow(max(0.0,1.0-d*14.0),6.0)*step(.973,h);
    col+=mix(ICE,vec3<f32>(1,.8,.5),h)*b*(.5+.5*sin(t*.7+h*40.0));
  }
  return col;
}
fn sky(uv:vec2<f32>,t:f32)->vec3<f32>{
  let mist=fbm(uv*2.6+vec2<f32>(t*.025,-t*.012));
  return vec3<f32>(.005,.008,.022)+vec3<f32>(.03,.018,.055)*mist+stars(uv,t);
}
fn camera(ro:vec3<f32>,lookat:vec3<f32>,uv:vec2<f32>,lens:f32)->vec3<f32>{
  let f=normalize(lookat-ro); let r=normalize(cross(f,vec3<f32>(0,1,0))); let u=cross(r,f);
  return normalize(f*lens+r*uv.x+u*uv.y);
}
fn box(p:vec3<f32>,b:vec3<f32>)->f32{let q=abs(p)-b; return length(max(q,vec3<f32>(0)))+min(max(q.x,max(q.y,q.z)),0.0);}
fn spark(uv0:vec2<f32>,t:f32)->vec3<f32>{
  let reveal=smoothstep(0.0,9.0,t); let zoom=1.0+smoothstep(14.0,27.0,t)*.8;
  let uv=rot(uv0,-.065*sin(t*.13))/(.6+reveal*.55)/zoom;
  let r=length(uv); let a=atan2(uv.y,uv.x);
  var col=sky(uv0,t)*.7;
  let lens=exp(-abs(r-.33)*72.0)*(1.0+.3*sin(a*12.0+t));
  let disk=length(vec2<f32>(uv.x,uv.y*4.7));
  let flow=fbm(vec2<f32>(a*2.0-t*.3,r*20.0));
  let acc=exp(-abs(disk-.45)*19.0)*(.45+flow);
  col+=GOLD*(lens*.85+acc*reveal*1.5);
  col+=ICE*exp(-abs(r-.37)*20.0)*.12;
  col*=smoothstep(.285,.32,r);
  col+=vec3<f32>(1,.86,.63)*exp(-r*r*(180.0+max(0.0,8.0-t)*200.0))*(1.0-smoothstep(5.0,10.0,t));
  col+=GOLD*.06*exp(-abs(uv.y)*80.0)/(1.0+uv.x*uv.x*3.0)*reveal;
  return col;
}
fn cathedralSdf(p:vec3<f32>)->f32{
  var q=p; q.z=(fract((p.z+1.5)/3.0)-.5)*3.0;
  let column=length(vec2<f32>(abs(q.x)-2.8,q.z))-.14;
  let buttress=box(vec3<f32>(abs(q.x)-3.05,q.y-1.8,q.z),vec3<f32>(.12,2.0,.38));
  let arch=abs(length(vec2<f32>(q.x,q.y-2.05))-2.85)-.075;
  let rib=max(arch,abs(q.z)-.075);
  return min(min(column,buttress),min(rib,p.y+.05));
}
fn cathedral(uv:vec2<f32>,t:f32)->vec3<f32>{
  let crane=smoothstep(17.0,32.0,t);
  let ro=vec3<f32>(sin(t*.12)*.38,1.2+sin(t*.17)*.1+crane*.65,t*.42);
  let rd=camera(ro,ro+vec3<f32>(sin(t*.08)*.12,.4+crane*.5,5),uv,1.55-crane*.15);
  var dist=0.0; var col=vec3<f32>(.006,.011,.022); var fog=vec3<f32>(0);
  for(var j=0;j<64;j++){
    let p=ro+rd*dist; let d=cathedralSdf(p);
    let light=exp(-abs(p.x)*.7)*exp(-abs(p.y-3.2)*.7)*(.5+.5*sin(p.z*.8));
    fog+=GOLD*light*.003;
    if(d<.003){
      let e=.004; let n=normalize(vec3<f32>(cathedralSdf(p+vec3<f32>(e,0,0))-cathedralSdf(p-vec3<f32>(e,0,0)),cathedralSdf(p+vec3<f32>(0,e,0))-cathedralSdf(p-vec3<f32>(0,e,0)),cathedralSdf(p+vec3<f32>(0,0,e))-cathedralSdf(p-vec3<f32>(0,0,e))));
      let diff=max(dot(n,normalize(vec3<f32>(1,4,-2))),0.0);
      let rim=pow(1.0-abs(dot(n,-rd)),3.0);
      let spec=pow(max(dot(reflect(rd,n),normalize(vec3<f32>(-.4,2,-1))),0.0),24.0);
      col=GOLD*(.08+diff*.62)+ICE*rim*.2+vec3<f32>(1,.9,.7)*spec*.75;
      if(p.y<.01){
        let tiles=pow(abs(sin(p.x*2.0)*sin(p.z*2.0)),.14);
        let reflection=exp(-abs(p.x)*2.0)*(.3+.5*noise(p.xz*3.0));
        col=vec3<f32>(.008,.018,.025)*tiles+GOLD*reflection*.35;
      }
      col*=exp(-dist*.045); break;
    }
    dist+=max(d*.8,.005); if(dist>42.0){break;}
  }
  let godray=pow(max(0.0,1.0-abs(uv.x+.18*sin(t*.1))*1.1),16.0)*exp(-abs(uv.y-.17)*2.0);
  return col+fog+GOLD*godray*.22;
}
fn water(p:vec2<f32>,t:f32)->f32{
  return sin(p.x*.7+t*.5)*.14+sin(p.y*.43-t*.4)*.18+sin(p.x*1.6+p.y*.9+t)*.055+fbm(p*.6+vec2<f32>(t*.09,0))*.24;
}
fn ocean(uv:vec2<f32>,t:f32)->vec3<f32>{
  let ro=vec3<f32>(t*.09,1.05+sin(t*.12)*.12-smoothstep(17.0,31.0,t)*.38,-t*.42);
  let rd=camera(ro,ro+vec3<f32>(0,-.07,7),uv,1.6);
  let sun=normalize(vec3<f32>(-.14,.18,1)); let sd=max(dot(rd,sun),0.0);
  var col=vec3<f32>(.02,.043,.078)+ICE*pow(sd,8.0)*.23+GOLD*pow(sd,90.0)*1.5;
  col+=vec3<f32>(.4,.17,.3)*fbm(rd.xy*4.0+vec2<f32>(t*.03,0))*.16;
  let moon=length(uv-vec2<f32>(-.23,.29));
  col+=mix(vec3<f32>(.6,.23,.18),vec3<f32>(1,.75,.4),smoothstep(0.0,.17,moon))*(1.0-smoothstep(.16,.164,moon))*.7;
  if(rd.y<.08){
    var dist=.1;
    for(var j=0;j<48;j++){
      let p=ro+rd*dist; let d=p.y-water(p.xz,t);
      if(abs(d)<.008 || dist>70.0){break;} dist+=max(d*.7,.035);
    }
    let p=ro+rd*dist; let e=.025;
    let n=normalize(vec3<f32>(water(p.xz-vec2<f32>(e,0),t)-water(p.xz+vec2<f32>(e,0),t),2.0*e,water(p.xz-vec2<f32>(0,e),t)-water(p.xz+vec2<f32>(0,e),t)));
    let fres=pow(1.0-max(dot(-rd,n),0.0),4.0);
    let spec=pow(max(dot(reflect(rd,n),sun),0.0),100.0);
    let foam=pow(max(0.0,sin(p.x*2.0+p.z*.8+t)),12.0)*.025;
    let watercol=vec3<f32>(.008,.035,.055)+ICE*fres*.2+GOLD*spec*2.3+vec3<f32>(foam);
    col=mix(watercol,col,1.0-exp(-dist*.024));
  }
  return col;
}
fn mirrorSdf(p0:vec3<f32>,t:f32)->f32{
  var p=p0; let xz=rot(p.xz,t*.12); p=vec3<f32>(xz.x,p.y,xz.y);
  var d=10.0;
  for(var k=0;k<7;k++){
    let a=f32(k)*2.39996; let spread=.55+smoothstep(5.0,19.0,t)*.85;
    var q=p-vec3<f32>(cos(a)*spread,sin(a*1.7)*spread,sin(a)*spread);
    let xy=rot(q.xy,a+t*.06); q=vec3<f32>(xy.x,xy.y,q.z);
    d=min(d,box(q,vec3<f32>(.44,.7,.035)));
  }
  return d;
}
fn mirrors(uv:vec2<f32>,t:f32)->vec3<f32>{
  let orbit=t*.075+smoothstep(17.0,30.0,t)*.65;
  let ro=vec3<f32>(sin(orbit)*4.0,.2+sin(t*.14)*.55,cos(orbit)*4.0); let rd=camera(ro,vec3<f32>(0),uv,1.7);
  var col=sky(uv,t)+vec3<f32>(.09,.006,.008)*exp(-length(uv-vec2<f32>(-.7,0))*2.0);
  var dist=0.0;
  for(var j=0;j<52;j++){
    let p=ro+rd*dist; let d=mirrorSdf(p,t);
    if(d<.002){
      let e=.002; let n=normalize(vec3<f32>(mirrorSdf(p+vec3<f32>(e,0,0),t)-mirrorSdf(p-vec3<f32>(e,0,0),t),mirrorSdf(p+vec3<f32>(0,e,0),t)-mirrorSdf(p-vec3<f32>(0,e,0),t),mirrorSdf(p+vec3<f32>(0,0,e),t)-mirrorSdf(p-vec3<f32>(0,0,e),t)));
      let reflected=reflect(rd,n); let lines=pow(max(0.0,cos(reflected.y*18.0+reflected.x*7.0+t*.4)),24.0);
      col=vec3<f32>(.025,.036,.058)+mix(ICE,GOLD,smoothstep(-.3,.5,reflected.x))*lines*.95;
      col+=vec3<f32>(.8,.9,1)*pow(1.0-abs(dot(n,-rd)),3.0)*.35; break;
    }
    dist+=max(d*.85,.005); if(dist>9.0){break;}
  }
  let cut=exp(-abs(uv.y-.06*sin(t*2.0))*280.0)*step(.5,sin(t*.8));
  return col+vec3<f32>(.6,.055,.02)*cut*.3;
}
fn storm(uv0:vec2<f32>,t:f32)->vec3<f32>{
  let uv=rot(uv0,t*.018)/(1.0+smoothstep(14.0,27.0,t)*.4);
  let r=length(uv); let a=atan2(uv.y,uv.x); var col=sky(uv,t)*.5;
  for(var k=0;k<6;k++){
    let f=f32(k); let ring=fract(r*(2.5+f*.07)-t*.33+f*.13);
    let d=abs(ring-.5); let winding=a*3.0-r*15.0+t*1.8+f;
    let ribbons=pow(max(0.0,sin(winding)),8.0)*(exp(-d*60.0)+.12*exp(-d*12.0));
    col+=mix(vec3<f32>(1,.09,.02),GOLD,f/6.0)*ribbons*(.4+exp(-r*2.0));
  }
  let bolt=exp(-abs(sin(a*7.0+r*18.0-t*1.8))*70.0)*exp(-r*1.8);
  col+=ICE*bolt*.35;
  col+=vec3<f32>(1,.7,.32)*exp(-r*r*60.0)*.8;
  return col;
}
fn bridge(uv0:vec2<f32>,t:f32)->vec3<f32>{
  let uv=uv0/(1.0+smoothstep(13.0,30.0,t)*.7);
  var col=sky(uv0,t); let p=uv+vec2<f32>(0,.05);
  let oval=length(vec2<f32>(p.x*.7,p.y));
  let a=atan2(p.y,p.x*.7); let filament=fbm(vec2<f32>(a*4.0-t*.04,t*.1));
  col+=GOLD*exp(-abs(oval-.43)*43.0)*(1.0+filament*1.8);
  col+=ICE*exp(-abs(oval-.48)*24.0)*.18;
  let road=abs(uv.x)/(max(.03,-uv.y+.15));
  let lane=exp(-abs(road-.3)*65.0)+exp(-abs(road-.32)*65.0);
  col+=GOLD*lane*.5*(1.0-smoothstep(.1,.22,uv.y));
  let bridgefloor=(1.0-smoothstep(.18,.32,road))*(1.0-smoothstep(.02,.16,uv.y));
  col+=vec3<f32>(.035,.065,.09)*bridgefloor;
  col+=GOLD*pow(max(0.0,sin(1.0/max(.04,.1-uv.y)-t*2.0)),25.0)*bridgefloor*.25;
  let beam=exp(-abs(uv.x)*6.0)*exp(-abs(uv.y-.25)*2.0);
  col+=vec3<f32>(1,.68,.35)*beam*.09;
  return col;
}
fn flower(uv0:vec2<f32>,t:f32)->vec3<f32>{
  let uv=rot(uv0,t*.025)/(1.0+smoothstep(15.0,30.0,t)*.4); let r=length(uv); let a=atan2(uv.y,uv.x);
  var col=sky(uv0,t)*.65;
  let open=.22+.38*smoothstep(0.0,14.0,t);
  for(var k=0;k<12;k++){
    let f=f32(k); let phase=a+f*.523599+t*.05;
    let petal=open*(.3+.7*pow(abs(cos(phase*3.0)),.75))*(.4+f*.057);
    let edge=exp(-abs(r-petal)*140.0);
    let halo=exp(-abs(r-petal)*30.0)*.12;
    let color=mix(vec3<f32>(.85,.19,.46),vec3<f32>(1,.8,.3),f/12.0);
    col+=color*(edge*.47+halo);
  }
  let spiral=sin(a*8.0-log(max(r,.001))*22.0+t*.7);
  col+=ICE*pow(max(0.0,spiral),50.0)*exp(-r*5.0)*.55;
  col+=GOLD*exp(-r*r*110.0)*1.5;
  return col;
}
fn dawn(uv:vec2<f32>,t:f32)->vec3<f32>{
  let rise=smoothstep(0.0,20.0,t); let sunpos=vec2<f32>(0,-.17+rise*.38);
  let r=length(uv-sunpos); let horizon=uv.y+.26;
  var col=mix(vec3<f32>(.009,.019,.044),vec3<f32>(.085,.055,.08),rise);
  col+=GOLD*exp(-r*3.5)*(.25+rise*.35)+vec3<f32>(1,.91,.7)*exp(-r*r*120.0)*rise;
  col+=vec3<f32>(.2,.16,.29)*fbm(uv*3.0+vec2<f32>(t*.015,0))*.3;
  col+=stars(uv,t)*(1.0-rise*.8);
  if(horizon<0.0){
    let mountain=.025*sin(uv.x*8.0)+.022*noise(vec2<f32>(uv.x*15.0,0));
    col=mix(vec3<f32>(.008,.016,.029),col,smoothstep(-.07,0.0,horizon+mountain));
    col+=GOLD*exp(-abs(uv.x)*8.0)*exp(horizon*5.0)*rise*.25;
  }
  let orbit=abs(length(vec2<f32>(uv.x,(uv.y-.1)*2.2))-.88);
  col+=GOLD*exp(-orbit*140.0)*.17*rise;
  return col;
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) p:vec3<u32>){
  let w=u32(clock[0].x); let h=u32(clock[0].y); if(p.x>=w||p.y>=h){return;}
  let t=clock[0].w; let mode=i32(round(clock[2].x)); let duration=clock[2].y;
  let uv=(vec2<f32>(f32(p.x)+.5,f32(h-p.y)-.5)/f32(h)-vec2<f32>(f32(w)/f32(h)*.5,.5))*2.0;
  var col=vec3<f32>(0);
  switch mode {
    case 0: {col=spark(uv,t);}
    case 1: {col=cathedral(uv,t);}
    case 2: {col=ocean(uv,t);}
    case 3: {col=mirrors(uv,t);}
    case 4: {col=storm(uv,t);}
    case 5: {col=bridge(uv,t);}
    case 6: {col=flower(uv,t);}
    default: {col=dawn(uv,t);}
  }
  // Film response: highlight rolloff, mild grain, optical vignette, no temporal state.
  col=vec3<f32>(1)-exp(-max(col,vec3<f32>(0))*1.45);
  col=pow(col,vec3<f32>(.83));
  col*=1.0-.2*smoothstep(.2,1.7,length(uv));
  col+=(hash(vec2<f32>(p.xy)+f32(u32(clock[0].z)%2048u))-.5)*.011;
  let fade=smoothstep(0.0,1.0,t)*(1.0-smoothstep(duration-.7,duration,t));
  col*=fade;
  let c=vec3<u32>(round(clamp(col,vec3<f32>(0),vec3<f32>(1))*255.0));
  output[p.y*w+p.x]=(input[p.y*w+p.x]&0u)|c.x|(c.y<<8u)|(c.z<<16u)|0xff000000u;
}
