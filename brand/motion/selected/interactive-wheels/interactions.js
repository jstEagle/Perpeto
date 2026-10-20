const media=matchMedia('(prefers-reduced-motion: reduce)'),toggle=document.querySelector('#motion');toggle.checked=media.matches;
const clamp=(v,m)=>Math.max(-m,Math.min(m,v));
const home=a=>Math.round(a/(Math.PI*2))*(Math.PI*2);
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const states=[...document.querySelectorAll('.card')].map(card=>{
 const button=card.querySelector('.stage'),svg=card.querySelector('svg'),rotor=card.querySelector('.rotor');
 const arms=[...card.querySelectorAll('.arm')].map(el=>({el,dx:parseFloat(el.style.getPropertyValue('--dx'))/65,dy:parseFloat(el.style.getPropertyValue('--dy'))/65}));
 const s={button,svg,rotor,arms,mode:card.dataset.mode,angle:0,omega:0,down:false,inside:false,px:0,py:0,time:0,dragAngle:0,rest:0,target:null};
 const point=e=>{const r=svg.getBoundingClientRect();return{x:e.clientX-r.left-r.width/2,y:e.clientY-r.top-r.height/2};};
 button.addEventListener('pointerenter',e=>{const p=point(e);s.px=p.x;s.py=p.y;s.time=e.timeStamp;s.inside=true;});
 button.addEventListener('pointerleave',()=>{s.inside=false;s.time=0;});
 button.addEventListener('pointerdown',e=>{if(e.button!==0)return;const p=point(e);s.px=p.x;s.py=p.y;s.time=e.timeStamp;s.down=true;s.dragAngle=Math.atan2(p.y,p.x);s.rest=home(s.angle);s.target=null;button.setPointerCapture(e.pointerId);button.classList.add('dragging');});
 button.addEventListener('pointermove',e=>{
  const p=point(e),dt=Math.max(.008,Math.min(.08,(e.timeStamp-s.time)/1000)),vx=clamp((p.x-s.px)/dt,2400),vy=clamp((p.y-s.py)/dt,2400),r=Math.hypot(p.x,p.y);
  if(!toggle.checked){
   if(s.down&&['crank','windup'].includes(s.mode)&&r>16){const a=Math.atan2(p.y,p.x),delta=wrap(a-s.dragAngle);s.angle+=delta;s.omega=clamp(s.omega*.55+delta/dt*.45,18);s.dragAngle=a;}
   else if(!['crank','windup'].includes(s.mode)&&s.time&&r>18&&r<100&&!(s.mode==='clutch'&&s.down)){
    const tangent=(p.x*vy-p.y*vx)/Math.max(r,18);const contact=Math.max(0,1-Math.abs(r-58)/55);
    s.omega=clamp(s.omega+(tangent/60-s.omega)*contact*(1-Math.exp(-18*dt)),18);s.target=null;
   }
  }
  s.px=p.x;s.py=p.y;s.time=e.timeStamp;
 });
 const release=()=>{s.down=false;button.classList.remove('dragging');};
 for(const event of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(event,release);
 button.addEventListener('keydown',e=>{
  if(e.key==='Escape'){s.omega=0;s.target=null;s.rest=home(s.angle);release();return;}
  if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();if(toggle.checked)return;const d=e.key==='ArrowRight'?1:-1;
   if(s.mode==='windup'){if(!s.down)s.rest=home(s.angle);s.down=true;s.angle+=d*.65;s.omega=0;}else{s.omega=clamp(s.omega+d*3,18);s.target=null;}
  }
 });
 button.addEventListener('click',e=>{if(e.detail===0){if(s.mode==='windup')release();else{s.omega=0;s.target=null;}}});
 button.addEventListener('blur',release);return s;
});
function reset(){for(const s of states){s.angle=s.omega=s.rest=0;s.target=null;s.down=false;s.button.classList.remove('dragging');s.rotor.style.transform='rotate(0rad)';for(const a of s.arms)a.el.style.transform='translate(0px,0px)';}}
document.querySelector('#reset').onclick=reset;toggle.onchange=reset;media.addEventListener('change',e=>{toggle.checked=e.matches;reset();});
document.querySelector('#theme').onclick=e=>{e.target.textContent=document.body.classList.toggle('dark')?'Light background':'Dark background';};
let last=performance.now();
function frame(now){const dt=Math.min((now-last)/1000,.032);last=now;
 for(const s of states){
  if(toggle.checked){s.angle=s.omega=0;}else if(!(s.down&&['crank','windup'].includes(s.mode))){
   if(s.mode==='windup'){s.target=s.rest;s.omega+=(-22*(s.angle-s.target)-7*s.omega)*dt;}
   else if(s.target!==null||Math.abs(s.omega)<1.1){if(s.target===null)s.target=home(s.angle);s.omega+=(35*(s.target-s.angle)-11*s.omega)*dt;}
   else{s.omega*=Math.exp(-(s.mode==='clutch'&&s.down?18:.65)*dt);if(Math.abs(s.omega)<.003)s.omega=0;}
   s.angle+=s.omega*dt;
   if(s.target!==null&&Math.abs(s.angle-s.target)<.0005&&Math.abs(s.omega)<.003){s.angle=s.target;s.omega=0;}
  }
  s.rotor.style.transform=`rotate(${s.angle}rad)`;
  if(s.mode==='turbine'){const expansion=toggle.checked?0:Math.min(Math.abs(s.omega)*6,70);for(const a of s.arms)a.el.style.transform=`translate(${a.dx*expansion}px,${a.dy*expansion}px)`;}
 }
 requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
