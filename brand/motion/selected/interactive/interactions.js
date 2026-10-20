/* Perpeto interactive motion. Translation only; no dependencies. */
const media = matchMedia('(prefers-reduced-motion: reduce)');
const toggle = document.querySelector('#motion');
toggle.checked = media.matches;
media.addEventListener('change', e => { toggle.checked = e.matches; resetAll(); });
const states = [...document.querySelectorAll('.card')].map(card => {
  const button = card.querySelector('.stage');
  const arms = [...card.querySelectorAll('.arm')].map(el => {
    const dx = parseFloat(el.style.getPropertyValue('--dx')) / 65;
    const dy = parseFloat(el.style.getPropertyValue('--dy')) / 65;
    return {el, dx, dy, i: +el.style.getPropertyValue('--i'), x:0,y:0,vx:0,vy:0};
  });
  const s = {button, arms, mode:card.dataset.mode, inside:false, down:false, px:0,py:0,ox:0,oy:0,kick:-10000};
  const point = e => {const r=button.getBoundingClientRect();return {x:(e.clientX-r.left-r.width/2)*5.1,y:(e.clientY-r.top-r.height/2)*5.1};};
  button.addEventListener('pointerenter', () => {s.inside=true;if(s.mode==='hover')s.kick=performance.now();});
  button.addEventListener('pointermove', e => {const p=point(e);s.px=p.x;s.py=p.y;});
  button.addEventListener('pointerleave', () => {s.inside=false;if(!s.down){s.px=0;s.py=0;}});
  button.addEventListener('pointerdown', e => {
    if(e.button!==0)return;
    const p=point(e);s.px=p.x;s.py=p.y;s.inside=true;
    if(['drag','tension'].includes(s.mode)){s.down=true;s.ox=p.x;s.oy=p.y;button.setPointerCapture(e.pointerId);button.classList.add('dragging');}
    else if(s.mode==='click')s.kick=performance.now();
  });
  const release = () => {s.down=false;button.classList.remove('dragging');};
  button.addEventListener('pointerup',release);button.addEventListener('pointercancel',release);button.addEventListener('lostpointercapture',release);
  button.addEventListener('click',e=>{if(e.detail===0){s.kick=performance.now();if(['attract','repel'].includes(s.mode)){s.inside=true;s.px=240;s.py=-120;}if(['drag','tension'].includes(s.mode)){s.down=!s.down;s.ox=0;s.oy=0;s.px=190;s.py=-80;}}});
  button.addEventListener('keydown',e=>{
    if(e.key==='Escape'){release();s.inside=false;s.px=s.py=0;return;}
    const offsets={ArrowLeft:[-80,0],ArrowRight:[80,0],ArrowUp:[0,-80],ArrowDown:[0,80]};
    if(offsets[e.key]){e.preventDefault();s.inside=true;if(['drag','tension'].includes(s.mode))s.down=true;s.px+=offsets[e.key][0];s.py+=offsets[e.key][1];if(s.mode==='hover'||s.mode==='click')s.kick=performance.now();}
  });
  button.addEventListener('blur',()=>{release();s.inside=false;s.px=s.py=0;});
  return s;
});
function resetAll(){for(const s of states){s.down=s.inside=false;s.px=s.py=0;s.kick=-10000;s.button.classList.remove('dragging');for(const a of s.arms){a.x=a.y=a.vx=a.vy=0;a.el.style.transform='translate(0px,0px)';}}}
document.querySelector('#reset').onclick=resetAll;
toggle.onchange=resetAll;
document.querySelector('#theme').onclick=e=>{const dark=document.body.classList.toggle('dark');e.target.textContent=dark?'Light background':'Dark background';};
const clamp=(n,max)=>Math.max(-max,Math.min(max,n));
let last=performance.now();
function frame(now){
  const dt=Math.min((now-last)/1000,.032);last=now;
  for(const s of states)for(const a of s.arms){
    let tx=0,ty=0;
    if(!toggle.checked){
      if(s.mode==='attract'&&s.inside){tx=clamp(s.px*.18,85);ty=clamp(s.py*.18,85);}
      if(s.mode==='repel'&&s.inside){const x=a.dx*230-s.px,y=a.dy*230-s.py,d=Math.hypot(x,y),force=Math.max(0,1-d/440)*100;tx=x/(d||1)*force;ty=y/(d||1)*force;}
      if(['hover','click'].includes(s.mode)){const age=(now-s.kick-a.i*45)/1000;if(age>=0&&age<.35){const amount=Math.sin(age/.35*Math.PI)*95;tx=a.dx*amount;ty=a.dy*amount;}}
      if(s.down&&s.mode==='tension'){const x=clamp(s.px-s.ox,400),y=clamp(s.py-s.oy,400),projection=Math.max(-45,(a.dx*x+a.dy*y)*.38);tx=a.dx*projection;ty=a.dy*projection;}
      if(s.down&&s.mode==='drag'){tx=clamp(s.px-s.ox,330);ty=clamp(s.py-s.oy,330);}
    }
    const stiffness=s.mode==='drag'?100+a.i*10:150, damping=s.mode==='drag'?15:16;
    a.vx+=(stiffness*(tx-a.x)-damping*a.vx)*dt;a.vy+=(stiffness*(ty-a.y)-damping*a.vy)*dt;
    a.x+=a.vx*dt;a.y+=a.vy*dt;
    if(toggle.checked){a.x=a.y=a.vx=a.vy=0;}
    a.el.style.transform=`translate(${a.x.toFixed(3)}px,${a.y.toFixed(3)}px)`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
