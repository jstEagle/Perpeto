// Hero stage motion: a looping, scripted run of the app mockup, and photo tiles orbiting the window.
(() => {
  const stage = document.querySelector('.stage');
  if (!stage) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LOOP = 25;      // seconds per run of the mockup
  const REST = 21.5;    // the frame shown when motion is reduced

  /* ---------- Mockup timeline ---------- */

  const parse = s => s.split(',').map(p => { const i = p.indexOf(':'); return [+p.slice(0, i), p.slice(i + 1)]; });
  const latest = (list, t) => { let v = list[0][1]; for (const [at, val] of list) if (t >= at) v = val; return v; };
  const BADGES = { plan: ['', 'Planned'], run: ['run', 'Running'], ok: ['ok', 'Verified'], wait: ['warn', 'Waiting on handshake'] };

  const appear = [...stage.querySelectorAll('[data-at]')].map(el => ({ el, at: +el.dataset.at, on: null }));
  const states = [...stage.querySelectorAll('[data-states]')].map(el => ({ el, list: parse(el.dataset.states), badge: el.querySelector('.badge'), cur: null }));
  const texts = [...stage.querySelectorAll('[data-texts]')].map(el => ({ el, list: parse(el.dataset.texts), cur: null }));
  const typed = [...stage.querySelectorAll('[data-type]')].map(el => ({ el, at: +el.dataset.at, dur: +el.dataset.type, full: el.textContent, n: -1 }));
  const segs = [...stage.querySelectorAll('[data-seg]')].map(el => { const [s, e, run, done] = el.dataset.seg.split(','); return { el, s: +s, e: +e, run, done, key: '' }; });
  const cuts = [...stage.querySelectorAll('[data-cut]')].map(el => ({ el, at: +el.dataset.cut }));
  const clock = stage.querySelector('[data-clock]');
  const playhead = stage.querySelector('.playhead');
  const thread = stage.querySelector('.thread');
  const compose = stage.querySelector('[data-compose]');
  const placeholder = compose && compose.textContent;
  const SPAN = 22; // seconds of timeline drawn across the worker lanes (20:00 to 20:30)

  for (const s of segs) s.el.style.left = `${s.s / SPAN * 100}%`;
  for (const c of cuts) c.el.style.left = `${c.at / SPAN * 100}%`;

  const render = t => {
    for (const a of appear) { const on = t >= a.at; if (on !== a.on) { a.on = on; a.el.classList.toggle('in', on); } }
    for (const s of states) {
      const v = latest(s.list, t);
      if (v === s.cur) continue;
      s.el.dataset.state = v;
      if (s.badge) { const [cls, label] = BADGES[v] || ['', '']; s.badge.className = 'badge ' + cls; s.badge.textContent = label; }
      if (s.cur !== null) { s.el.classList.remove('changed'); void s.el.offsetWidth; s.el.classList.add('changed'); }
      s.cur = v;
    }
    for (const x of texts) { const v = latest(x.list, t); if (v !== x.cur) { x.cur = v; x.el.textContent = v; } }
    for (const y of typed) {
      const n = Math.round(Math.max(0, Math.min(1, (t - y.at) / y.dur)) * y.full.length);
      if (n !== y.n) { y.n = n; y.el.textContent = y.full.slice(0, n); y.el.classList.toggle('typing', n > 0 && n < y.full.length); }
    }
    for (const s of segs) {
      const p = Math.max(0, Math.min(1, (t - s.s) / (s.e - s.s)));
      const kind = p >= 1 ? s.done : s.run;
      const key = kind + Math.round(p * 200);
      if (key === s.key) continue;
      s.key = key;
      s.el.style.width = `${p * (s.e - s.s) / SPAN * 100}%`;
      s.el.className = `bar ${kind}${p > 0 && p < 1 ? ' live' : ''}`;
    }
    for (const c of cuts) c.el.classList.toggle('in', t >= c.at);
    const ct = Math.min(t, SPAN);
    if (clock) clock.textContent = `20:${String(Math.floor(ct / SPAN * 30)).padStart(2, '0')}`;
    if (playhead) { playhead.style.left = `calc(90px + (100% - 104px) * ${ct / SPAN})`; playhead.style.opacity = t < SPAN ? 1 : 0; }
    if (compose) {
      const full = compose.dataset.compose, p = (t - 21.6) / 1.8;
      compose.textContent = p > 0 ? full.slice(0, Math.round(Math.min(1, p) * full.length)) : placeholder;
      compose.classList.toggle('typed', p > 0);
    }
    stage.classList.toggle('rewind', t > LOOP - .9);
    // Keep the newest message in view as the thread grows.
    if (thread) {
      const target = Math.max(0, thread.scrollHeight - thread.clientHeight);
      thread.scrollTop += (target - thread.scrollTop) * (reduce ? 1 : .08);
    }
  };

  /* ---------- Orbiting tiles ---------- */

  const tiles = [...stage.querySelectorAll('.collage .tile')];
  // Seeded randomness so the orbit has character but stays the same on every load.
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const orbits = tiles.map((el, i) => ({
    el,
    phase: i / tiles.length * Math.PI * 2 + rnd() * .6,
    speed: (Math.PI * 2) / (80 + rnd() * 50) * (rnd() < .15 ? -1 : 1),
    rx: .5 + rnd() * .12,
    ry: .4 + rnd() * .12,
    tilt: (rnd() - .5) * .5,
    wob: [rnd() * 6, rnd() * 6, .2 + rnd() * .3, .15 + rnd() * .3],
    blink: [.05 + rnd() * .08, rnd() * 6],
    w: 0, h: 0
  }));
  const measure = () => { for (const o of orbits) { o.el.style.transform = 'none'; o.w = o.el.offsetWidth; o.h = o.el.offsetHeight; } };
  let orbiting = false;
  const setOrbiting = () => {
    const want = !reduce && innerWidth > 1180;
    if (want === orbiting) return;
    orbiting = want;
    stage.classList.toggle('orbiting', want);
    if (want) measure();
    else for (const o of orbits) o.el.removeAttribute('style');
  };
  const orbit = time => {
    const W = stage.clientWidth, H = stage.clientHeight, cx = W * .5, cy = H * .44;
    for (const o of orbits) {
      const th = o.phase + time * o.speed;
      const ex = Math.cos(th) * o.rx * W, ey = Math.sin(th) * o.ry * H;
      const x = cx + ex * Math.cos(o.tilt) - ey * Math.sin(o.tilt) + Math.sin(time * o.wob[2] + o.wob[0]) * 22;
      const y = cy + ex * Math.sin(o.tilt) + ey * Math.cos(o.tilt) + Math.sin(time * o.wob[3] + o.wob[1]) * 16;
      // Near the sides a tile swings toward the viewer; across the top and bottom it passes behind.
      const side = Math.abs(Math.cos(th)) ** 1.6;
      const drift = .5 + .5 * Math.sin(time * o.blink[0] * Math.PI * 2 + o.blink[1]);
      const focus = Math.max(0, Math.min(1, side * .6 + drift * .5 - .1));
      const scale = .62 + focus * .48;
      o.el.style.transform = `translate3d(${x - o.w / 2}px, ${y - o.h / 2}px, 0) scale(${scale.toFixed(3)})`;
      o.el.style.filter = `blur(${((1 - focus) ** 1.4 * 11).toFixed(2)}px)`;
      o.el.style.opacity = (.12 + .88 * focus ** 1.3).toFixed(3);
      o.el.style.zIndex = Math.round(focus * 10);
    }
  };

  /* ---------- Loop ---------- */

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(stage);
  addEventListener('resize', () => { setOrbiting(); if (orbiting) measure(); });
  setOrbiting();

  if (reduce) { render(REST); return; }
  const start = performance.now();
  const tick = now => {
    if (visible && !document.hidden) {
      const s = (now - start) / 1000;
      render(s % LOOP);
      if (orbiting) orbit(s);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
