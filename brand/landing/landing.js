(() => {
  const { arms, wordmark } = window.PERPETO_MARKS;
  // Arm order, stagger index and separation vectors match ../motion/selected/*.svg.
  const meta = [[0,-16.82,-62.79],[7,-56.29,-32.5],[1,32.5,-56.29],[2,62.79,-16.82],[6,-62.79,16.82],[3,56.29,32.5],[4,16.82,62.79],[5,-32.5,56.29]];

  const spindle = motion => {
    const g = arms.map((d, n) => {
      const [i, dx, dy] = meta[n];
      return `<g class="arm" style="--i:${i};--dx:${dx}px;--dy:${dy}px;--bx:${(dx * .277).toFixed(2)}px;--by:${(dy * .277).toFixed(2)}px"><g transform="translate(0 1254) scale(.1 -.1)"><path d="${d}"/></g></g>`;
    }).join('');
    return `<svg viewBox="219 186 816 816" class="loader${motion ? ' motion-' + motion : ''}" aria-hidden="true" focusable="false"><g class="rotor" fill="currentColor">${g}</g></svg>`;
  };
  document.querySelectorAll('.spindle').forEach(el => { el.innerHTML = spindle(el.dataset.motion); });
  document.querySelectorAll('.wordmark').forEach(el => {
    el.innerHTML = `<svg viewBox="0 0 3480 853" aria-hidden="true" focusable="false"><path fill="currentColor" transform="translate(-54 672)" d="${wordmark}"/></svg>`;
  });

  // Flywheel: tangential pointer speed drives spin, friction slows it, a spring settles it home.
  const fly = document.querySelector('.flywheel');
  const rotor = fly.querySelector('.rotor');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const TAU = Math.PI * 2;
  let angle = 0, omega = 0, last = 0, px = 0, py = 0, pt = 0;
  const local = e => { const r = fly.getBoundingClientRect(); return { x: (e.clientX - r.left - r.width / 2) / (r.width / 2), y: (e.clientY - r.top - r.height / 2) / (r.height / 2) }; };
  fly.addEventListener('pointerenter', e => { const p = local(e); px = p.x; py = p.y; pt = e.timeStamp; });
  fly.addEventListener('pointermove', e => {
    const p = local(e), dt = Math.max(.008, Math.min(.08, (e.timeStamp - pt) / 1000)), rr = Math.hypot(p.x, p.y);
    if (!reduce.matches && pt && rr > .12 && rr < 1.1) {
      const vx = (p.x - px) / dt, vy = (p.y - py) / dt;
      const target = Math.max(-18, Math.min(18, (p.x * vy - p.y * vx) / Math.max(rr * rr, .1)));
      const contact = Math.max(0, 1 - Math.abs(rr - .6) / .6);
      omega += (target - omega) * contact * (1 - Math.exp(-14 * dt));
    }
    px = p.x; py = p.y; pt = e.timeStamp;
  });
  fly.addEventListener('pointerleave', () => { pt = 0; });
  fly.addEventListener('keydown', e => {
    if (reduce.matches) return;
    if (e.key === 'ArrowRight') omega += 4;
    if (e.key === 'ArrowLeft') omega -= 4;
    if (e.key === 'Escape') omega = 0;
  });
  const frame = now => {
    const dt = Math.min((now - last) / 1000, .032); last = now;
    if (Math.abs(omega) > 1.4) omega *= Math.exp(-.55 * dt);
    else {
      const home = Math.round(angle / TAU) * TAU;
      omega += ((home - angle) * 22 - omega * 7) * dt;
      if (Math.abs(home - angle) < .0008 && Math.abs(omega) < .01) { angle = home; omega = 0; }
    }
    angle += omega * dt;
    rotor.style.transform = `rotate(${angle}rad)`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(t => { last = t; frame(t); });

})();
