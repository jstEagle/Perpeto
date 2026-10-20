const media=matchMedia('(prefers-reduced-motion: reduce)'),toggle=document.querySelector('#motion');toggle.checked=media.matches;
const clamp=(v,m)=>Math.max(-m,Math.min(m,v));
const states=[...document.querySelectorAll('.card')].map(card=>{
 const button=card.querySelector('.stage'),arms=[...card.querySelectorAll('.arm')].map(el=>({el,i:+el.style.getPropertyValue('--i'),dx:parseFloat(el.style.getPropertyValue('--dx'))/65,dy:parseFloat(el.style.getPropertyValue('--dy'))/65,x:0,y:0,vx:0,vy:0}));
 const s={button,arms,mode:card.dataset.mode,inside:false,down:false,px:0,py:0,ox:0,oy:0,chosen:0,started:0};
 const nearest=()=>arms.reduce((best,a)=>Math.hypot(a.dx*230+a.x-s.px,a.dy*230+a.y-s.py)<Math.hypot(best.dx*230+best.x-s.px,best.dy*230+best.y-s.py)?a:best).i;
 const point=e=>{const r=button.getBoundingClientRect();return{x:(e.clientX-r.left-r.width/2)*5.1,y:(e.clientY-r.top-r.height/2)*5.1};};
 function move(x,y){const mx=clamp(x-s.px,100),my=clamp(y-s.py,100);s.px=x;s.py=y;s.inside=true;if(toggle.checked)return;
  if(s.mode==='brush'||s.mode==='wake')for(const a of arms){const d=Math.hypot(a.dx*230+a.x-x,a.dy*230+a.y-y),w=Math.max(0,1-d/210),f=s.mode==='brush'?5:2.4;a.vx=clamp(a.vx+mx*w*f,850);a.vy=clamp(a.vy+my*w*f,850);}
 }
 button.addEventListener('pointerenter',e=>{const p=point(e);s.px=p.x;s.py=p.y;s.inside=true;});
 button.addEventListener('pointermove',e=>{const p=point(e);move(p.x,p.y);});
 button.addEventListener('pointerleave',()=>{s.inside=false;});
 button.addEventListener('pointerdown',e=>{if(e.button!==0)return;const p=point(e);s.px=p.x;s.py=p.y;s.ox=p.x;s.oy=p.y;s.chosen=nearest();s.down=true;s.started=performance.now();button.setPointerCapture(e.pointerId);button.classList.add('dragging');});
 const release=()=>{s.down=false;button.classList.remove('dragging');};
 for(const event of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(event,release);
 button.addEventListener('keydown',e=>{if(e.key==='Escape'){release();return;}const delta={ArrowLeft:[-65,0],ArrowRight:[65,0],ArrowUp:[0,-65],ArrowDown:[0,65]}[e.key];if(delta){e.preventDefault();if(!s.down){s.ox=s.px;s.oy=s.py;s.chosen=nearest();s.down=true;s.started=performance.now();}move(s.px+delta[0],s.py+delta[1]);}});
 button.addEventListener('click',e=>{if(e.detail===0){s.down=!s.down;s.started=performance.now();s.ox=0;s.oy=0;s.chosen=0;move(160,-100);}});
 button.addEventListener('blur',()=>{release();s.inside=false;});return s;
});
function reset(){for(const s of states){s.down=s.inside=false;s.px=s.py=0;s.button.classList.remove('dragging');for(const a of s.arms){a.x=a.y=a.vx=a.vy=0;a.el.style.transform='translate(0px,0px)';}}}
document.querySelector('#reset').onclick=reset;toggle.onchange=reset;media.addEventListener('change',e=>{toggle.checked=e.matches;reset();});
document.querySelector('#theme').onclick=e=>{e.target.textContent=document.body.classList.toggle('dark')?'Light background':'Dark background';};
let last=performance.now();
function frame(now){const dt=Math.min((now-last)/1000,.032);last=now;
 for(const s of states)for(const a of s.arms){let tx=0,ty=0;
  if(s.down&&!toggle.checked){const x=clamp(s.px-s.ox,280),y=clamp(s.py-s.oy,280),gap=Math.min((a.i-s.chosen+8)%8,(s.chosen-a.i+8)%8);
   if(s.mode==='pluck'&&a.i===s.chosen){tx=x;ty=y;}
   if(s.mode==='elastic'){const w=[1,.48,.16,.04,0][gap];tx=x*w;ty=y*w;}
   if(s.mode==='pressure'){const dx=a.dx*230-s.px,dy=a.dy*230-s.py,d=Math.hypot(dx,dy),power=Math.min(1,(now-s.started)/900)*150*Math.max(0,1-d/520);tx=dx/(d||1)*power;ty=dy/(d||1)*power;}
   if(s.mode==='squeeze'&&(a.i===s.chosen||gap===4)){const selected=s.arms.find(t=>t.i===s.chosen);const projection=clamp(x*selected.dx+y*selected.dy,200);tx=a.dx*projection;ty=a.dy*projection;}
  }
  const k=s.mode==='wake'?55:145,damping=s.mode==='wake'?7:15;
  a.vx+=(k*(tx-a.x)-damping*a.vx)*dt;a.vy+=(k*(ty-a.y)-damping*a.vy)*dt;a.x=clamp(a.x+a.vx*dt,300);a.y=clamp(a.y+a.vy*dt,300);
  if(toggle.checked)a.x=a.y=a.vx=a.vy=0;
  a.el.style.transform=`translate(${a.x.toFixed(3)}px,${a.y.toFixed(3)}px)`;
 }
 requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
