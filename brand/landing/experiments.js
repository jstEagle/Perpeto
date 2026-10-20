// Texture lab: grain, dithering and ASCII experiments, each off by default and set independently.
(() => {
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const KEY = 'perpeto-texture-lab';

  const SCHEMA = [
    { group: 'Grain', controls: [
      { key: 'grain', label: 'Style', options: ['off', 'fine', 'coarse', 'paper', 'scratch'] },
      { key: 'grainWhere', label: 'Where', options: ['page', 'dark', 'both'] },
      { key: 'grainAmount', label: 'Amount', range: [4, 60] },
      { key: 'grainMove', label: 'Motion', options: ['still', 'jitter'] }
    ] },
    { group: 'Dither photos', controls: [
      { key: 'photos', label: 'Method', options: ['off', 'atkinson', 'floyd', 'bayer', 'halftone'] },
      { key: 'photoTones', label: 'Tones', options: ['2', '4'] },
      { key: 'photoPx', label: 'Pixel', range: [1, 5] }
    ] },
    { group: 'Dither dark panels', controls: [
      { key: 'panels', label: 'Pattern', options: ['off', 'bayer', 'dots', 'lines'] },
      { key: 'panelPx', label: 'Pixel', range: [1, 6] }
    ] },
    { group: 'ASCII', controls: [
      { key: 'spindle', label: 'Hero mark', options: ['off', 'classic', 'blocks', 'dots', 'binary'] },
      { key: 'spindleMotion', label: 'Motion', options: ['spin', 'still', 'follow'] },
      { key: 'spindleTone', label: 'Tone', options: ['silver', 'graphite', 'ink'] },
      { key: 'floor', label: 'Floor', options: ['off', 'blocks', 'arrows'] },
      { key: 'scramble', label: 'Headings', options: ['off', 'scramble'] }
    ] }
  ];
  const DEFAULTS = { grain: 'off', grainWhere: 'page', grainAmount: 18, grainMove: 'still', photos: 'off', photoTones: '2', photoPx: 2, panels: 'off', panelPx: 3, spindle: 'off', spindleMotion: 'spin', spindleTone: 'graphite', floor: 'off', scramble: 'off' };
  let cfg = { ...DEFAULTS };
  try { cfg = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {} };

  /* ---------- Panel UI ---------- */

  const lab = document.querySelector('.lab');
  lab.innerHTML = `<div class="lab-head"><button type="button" class="lab-toggle" aria-expanded="true">Texture lab</button><button type="button" class="lab-reset">Reset</button></div>
    <div class="lab-body">${SCHEMA.map(g => `<fieldset><legend>${g.group}</legend>${g.controls.map(c => c.range
      ? `<label class="lab-row"><span>${c.label}</span><input type="range" min="${c.range[0]}" max="${c.range[1]}" data-key="${c.key}"><output></output></label>`
      : `<div class="lab-row"><span>${c.label}</span><div class="seg" role="group" aria-label="${g.group} ${c.label}">${c.options.map(o => `<button type="button" data-key="${c.key}" data-val="${o}">${o}</button>`).join('')}</div></div>`).join('')}</fieldset>`).join('')}</div>`;
  const sync = () => {
    lab.querySelectorAll('button[data-key]').forEach(b => b.setAttribute('aria-pressed', String(cfg[b.dataset.key]) === b.dataset.val));
    lab.querySelectorAll('input[data-key]').forEach(i => { i.value = cfg[i.dataset.key]; i.nextElementSibling.textContent = cfg[i.dataset.key]; });
  };
  lab.addEventListener('click', e => {
    const b = e.target.closest('button[data-key]');
    if (b) set(b.dataset.key, b.dataset.val);
  });
  lab.addEventListener('input', e => { if (e.target.dataset.key) set(e.target.dataset.key, +e.target.value); });
  lab.querySelector('.lab-reset').addEventListener('click', () => { cfg = { ...DEFAULTS }; applyAll(); });
  lab.querySelector('.lab-toggle').addEventListener('click', e => {
    const open = lab.classList.toggle('closed');
    e.target.setAttribute('aria-expanded', String(!open));
  });

  const set = (key, val) => {
    cfg[key] = val;
    if (key.startsWith('grain')) applyGrain();
    if (key.startsWith('photo')) applyPhotos();
    if (key.startsWith('panel')) applyPanels();
    if (key.startsWith('spindle') || key === 'floor') applyAscii();
    if (key === 'scramble' && val === 'scramble') scrambleVisible();
    save(); sync();
  };

  /* ---------- Grain ---------- */

  // Grain tiles are transparent with specks: dark specks for white surfaces, light specks for rich black.
  const SPECK = { dark: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -2.6 0 0 0 1.35', light: '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  2.6 0 0 0 -1.25' };
  const noise = (freq, octaves, tone) => `url("data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n' x='0' y='0' color-interpolation-filters='sRGB'><feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='${octaves}' seed='7' stitchTiles='stitch'/><feColorMatrix type='matrix' values='${SPECK[tone]}'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`)}")`;
  const GRAINS = { fine: ['.95', 2], coarse: ['.42', 2], paper: ['.05', 5], scratch: ['.9 .012', 2] };
  const applyGrain = () => {
    const on = cfg.grain !== 'off';
    root.classList.toggle('grain-page', on && cfg.grainWhere !== 'dark');
    root.classList.toggle('grain-dark', on && cfg.grainWhere !== 'page');
    root.classList.toggle('grain-move', on && cfg.grainMove === 'jitter' && !reduce);
    if (on) {
      const [f, o] = GRAINS[cfg.grain];
      root.style.setProperty('--grain-on-light', noise(f, o, 'dark'));
      root.style.setProperty('--grain-on-dark', noise(f, o, 'light'));
    }
    root.style.setProperty('--grain-op', Math.min(1, cfg.grainAmount / 40));
  };

  /* ---------- Dithering ---------- */

  const INK = 18, PAPER = 255;
  const levelsFor = tones => tones === '4' ? [INK, 92, 172, PAPER] : [INK, PAPER];
  const nearest = (v, lv) => lv.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);
  const bayer = (() => {
    let b = [[0]];
    for (let n = 1; n < 8; n *= 2) b = [...b.map(r => [...r.map(v => v * 4), ...r.map(v => v * 4 + 2)]), ...b.map(r => [...r.map(v => v * 4 + 3), ...r.map(v => v * 4 + 1)])];
    return b.map(r => r.map(v => (v + .5) / 64));
  })();
  const KERNELS = {
    atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
    floyd: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]
  };
  const tint = v => v === INK ? [18, 19, 22] : [v, v, v + (v < 250 ? 3 : 0)];

  const ditherImage = (img, method, tones, px) => {
    const box = img.parentElement.getBoundingClientRect();
    const w = Math.max(8, Math.round(box.width / px)), h = Math.max(8, Math.round(box.height / px));
    const c = document.createElement('canvas'); c.className = 'dithered';
    const ctx = c.getContext('2d');
    // Cover-crop the source into the tile's aspect ratio.
    const sr = img.naturalWidth / img.naturalHeight, dr = w / h;
    const sw = sr > dr ? img.naturalHeight * dr : img.naturalWidth, sh = sr > dr ? img.naturalHeight : img.naturalWidth / dr;
    const sx = (img.naturalWidth - sw) / 2, sy = (img.naturalHeight - sh) / 2;
    const lv = levelsFor(tones);
    if (method === 'halftone') {
      const cell = 4, hw = Math.ceil(w / cell), hh = Math.ceil(h / cell);
      const s = document.createElement('canvas'); s.width = hw; s.height = hh;
      const sc = s.getContext('2d'); sc.drawImage(img, sx, sy, sw, sh, 0, 0, hw, hh);
      const g = sc.getImageData(0, 0, hw, hh).data;
      c.width = w * 2; c.height = h * 2;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = 'rgb(18,19,22)';
      const R = cell;
      for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
        const i = (y * hw + x) * 4, lum = (g[i] * .299 + g[i + 1] * .587 + g[i + 2] * .114) / 255;
        const r = R * .78 * Math.sqrt(1 - lum);
        if (r > .2) { ctx.beginPath(); ctx.arc((x + .5) * cell * 2, (y + .5) * cell * 2, r * 2, 0, Math.PI * 2); ctx.fill(); }
      }
      return c;
    }
    c.width = w; c.height = h;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h), p = d.data, g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = (p[i * 4] * .299 + p[i * 4 + 1] * .587 + p[i * 4 + 2] * .114) * 1.06 - 4;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, old = g[i];
      let v;
      if (method === 'bayer') {
        const step = 255 / (lv.length - 1), t = old / step, lo = Math.floor(t);
        v = lv[Math.max(0, Math.min(lv.length - 1, lo + (t - lo > bayer[y % 8][x % 8] ? 1 : 0)))];
      } else {
        v = nearest(old, lv);
        const err = old - v;
        for (const [dx, dy, f] of KERNELS[method]) { const xx = x + dx, yy = y + dy; if (xx >= 0 && xx < w && yy < h) g[yy * w + xx] += err * f; }
      }
      g[i] = v;
    }
    for (let i = 0; i < w * h; i++) { const [r, gg, b] = tint(g[i]); p[i * 4] = r; p[i * 4 + 1] = gg; p[i * 4 + 2] = b; p[i * 4 + 3] = 255; }
    ctx.putImageData(d, 0, 0);
    return c;
  };
  const applyPhotos = () => {
    document.querySelectorAll('.collage canvas.dithered').forEach(c => c.remove());
    root.classList.toggle('dither-photos', cfg.photos !== 'off');
    if (cfg.photos === 'off') return;
    document.querySelectorAll('.collage img').forEach(img => {
      const go = () => { if (getComputedStyle(img.parentElement).display !== 'none') img.after(ditherImage(img, cfg.photos, cfg.photoTones, cfg.photoPx)); };
      img.complete && img.naturalWidth ? go() : img.addEventListener('load', go, { once: true });
    });
  };

  // Dark panels: a metallic light falloff rendered as a dither pattern between rich-black grays.
  const METAL = [[14, 15, 17], [24, 25, 29], [38, 40, 45], [60, 62, 68]];
  const panelPattern = (w, h, pattern, light) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'), d = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x / w - light[0], dy = y / h - light[1];
      let t = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy * 1.6) * 1.2);
      t = t * t * (METAL.length - 1);
      const lo = Math.floor(t), f = t - lo;
      let thr;
      if (pattern === 'bayer') thr = bayer[y % 8][x % 8];
      else if (pattern === 'dots') { const u = (x % 6) - 2.5, v = (y % 6) - 2.5; thr = Math.min(1, Math.sqrt(u * u + v * v) / 3.6); }
      else thr = ((y + Math.floor(x / 3)) % 4) / 4 + .12;
      const col = METAL[Math.min(METAL.length - 1, lo + (f > thr ? 1 : 0))], i = (y * w + x) * 4;
      d.data[i] = col[0]; d.data[i + 1] = col[1]; d.data[i + 2] = col[2]; d.data[i + 3] = 255;
    }
    ctx.putImageData(d, 0, 0);
    return c.toDataURL();
  };
  const PANELS = [['.window', [.15, -.2]], ['.flywheel', [.25, .1]], ['.cta-box', [.5, -.15]]];
  const applyPanels = () => {
    const on = cfg.panels !== 'off';
    root.classList.toggle('dither-panels', on);
    if (!on) return;
    for (const [sel, light] of PANELS) document.querySelectorAll(sel).forEach(el => {
      const r = el.getBoundingClientRect(), px = cfg.panelPx, w = Math.ceil(r.width / px), h = Math.ceil(r.height / px);
      el.style.setProperty('--dither-bg', `url(${panelPattern(w, h, cfg.panels, light)})`);
      el.style.setProperty('--dither-size', `${w * px}px ${h * px}px`);
    });
  };
  let resizeTimer;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { applyPanels(); applyPhotos(); }, 200); });

  /* ---------- ASCII hero mark ---------- */

  const pre = document.querySelector('.ascii-spindle');
  const paths = window.PERPETO_MARKS.arms.map(d => new Path2D(d));
  const COLS = 84, ROWS = 42, CW = 4, CH = 8;
  const cv = document.createElement('canvas'); cv.width = COLS * CW; cv.height = ROWS * CH;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const RAMPS = { classic: " .'`:-=+*#%@", blocks: ' ░░▒▒▓▓██', dots: ' ·.:•●', binary: ' 00110101' };
  let spin = 0, pointer = null;
  addEventListener('pointermove', e => {
    const r = pre.getBoundingClientRect();
    pointer = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  });
  const drawSpindle = t => {
    const S = cv.width, ramp = RAMPS[cfg.spindle];
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.clearRect(0, 0, S, S);
    cx.translate(S / 2, S / 2);
    cx.rotate(spin);
    const k = S / 816 * .92;
    cx.scale(k, k);
    cx.translate(-627, -594);
    cx.transform(.1, 0, 0, -.1, 0, 1254);
    paths.forEach(p => cx.fill(p));
    const data = cx.getImageData(0, 0, S, S).data;
    let out = '';
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        let a = 0;
        for (let y = 0; y < CH; y += 2) for (let x = 0; x < CW; x += 2) a += data[((r * CH + y) * S + c * CW + x) * 4 + 3];
        a /= 8 * 255;
        const band = cfg.spindleMotion === 'still' ? 0 : Math.max(0, Math.cos((c / COLS + r / ROWS) * 5 - t * 1.4)) ** 6;
        let glow = 0;
        if (pointer) { const dx = c / COLS - pointer.x, dy = r / ROWS - pointer.y; glow = Math.exp(-(dx * dx + dy * dy) * 40) * .5; }
        const v = a > .02 ? Math.min(1, .45 + a * .3 + band * .3 + glow) : 0;
        out += ramp[Math.round(v * (ramp.length - 1))];
      }
      out += '\n';
    }
    pre.textContent = out;
  };

  /* ---------- ASCII factory floor ---------- */

  const screen = document.querySelector('.floor-screen');
  const W = 54;
  const lanes = ['mbp-14', 'build-01', 'build-02', 'runner-03'].map(name => ({ name, up: true, down: 0 }));
  let packets = [], seq = 4810, verified = 0, handoffs = 0, failed = 0, tick = 0;
  const log = [];
  const clock = () => `20:${String((4 + Math.floor(tick / 40)) % 60).padStart(2, '0')}`;
  const say = s => { log.unshift(`${clock()}  ${s}`); log.length = Math.min(log.length, 5); };
  const spawn = () => {
    const live = lanes.map((l, i) => i).filter(i => lanes[i].up);
    const lane = live[Math.floor(Math.random() * live.length)];
    packets.push({ lane, x: 0, id: ++seq, speed: .5 + Math.random() * .5 });
    say(`assigned   wi-${seq} → ${lanes[lane].name}`);
  };
  for (let i = 0; i < 4; i++) { spawn(); packets[i].x = Math.random() * W * .7; }
  const step = () => {
    tick++;
    if (Math.random() < .07 && packets.length < 9) spawn();
    // Every so often a worker drops out; its work moves to the next lane.
    if (tick % 140 === 70) {
      const l = lanes[0];
      l.up = false; l.down = 34;
      say(`lost       ${l.name}, progress saved`);
      packets.filter(p => p.lane === 0).forEach(p => { p.lane = 1; handoffs++; say(`handoff    wi-${p.id} → ${lanes[1].name}`); });
    }
    lanes.forEach(l => { if (!l.up && --l.down <= 0) { l.up = true; say(`rejoined   ${l.name}`); } });
    packets.forEach(p => { p.x += p.speed; });
    packets = packets.filter(p => {
      if (p.x < W) return true;
      if (Math.random() < .12) { failed++; say(`failed     wi-${p.id}  check output`); }
      else { verified++; say(`verified   wi-${p.id}  4/4 checks`); }
      return false;
    });
  };
  const renderFloor = () => {
    const arrows = cfg.floor === 'arrows';
    const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
    const lines = [`  ${pad('worker', 11)}┌${'─'.repeat(W)}┐  status`];
    lanes.forEach((l, i) => {
      const row = Array.from({ length: W }, (_, x) => arrows ? ((x + tick) % 4 === 0 ? '-' : ' ') : ((x + tick) % 6 === 0 ? '·' : ' '));
      if (!l.up) for (let x = 0; x < W; x++) row[x] = x % 2 ? '╳' : ' ';
      packets.filter(p => p.lane === i).forEach(p => {
        const x = Math.floor(p.x), put = (o, ch) => { if (x - o >= 0) row[x - o] = ch; };
        if (arrows) { put(2, '='); put(1, '='); put(0, '\u0001'); } else { put(2, '░'); put(1, '▒'); put(0, '█'); }
      });
      const status = !l.up ? 'lost' : packets.some(p => p.lane === i) ? 'running' : 'idle';
      lines.push(`  ${pad(l.name, 11)}│${row.join('')}│  ${status}`);
    });
    lines.push(`  ${pad('', 11)}└${'─'.repeat(W)}┘`, '');
    lines.push(`  verified ${String(verified).padStart(3)}    running ${String(packets.length).padStart(2)}    handoffs ${String(handoffs).padStart(2)}    failed ${String(failed).padStart(2)}`, '');
    log.forEach(s => lines.push('  ' + s));
    screen.innerHTML = lines.join('\n')
      .replace(/verified(?=\s+wi-)/g, '<b class="v">verified</b>')
      .replace(/(failed|lost)(?=\s{2,}|\s*$|,)/gm, '<b class="f">$1</b>')
      .replace(/█/g, '<b class="p">█</b>')
      .replace(/\u0001/g, '<b class="p">&gt;</b>');
  };

  const applyAscii = () => {
    root.classList.toggle('ascii-mark', cfg.spindle !== 'off');
    root.classList.toggle('ascii-floor', cfg.floor !== 'off');
    root.dataset.asciiTone = cfg.spindleTone;
    if (cfg.spindle !== 'off') drawSpindle(0);
    if (cfg.floor !== 'off') renderFloor();
  };

  /* ---------- Scrambled headings ---------- */

  const GLYPHS = '#%@*+=:-./\\|<>[]';
  const scramble = el => {
    const text = el.dataset.text || (el.dataset.text = el.textContent);
    let frame = 0;
    const total = 26;
    const run = () => {
      el.textContent = [...text].map((ch, i) => ch === ' ' || frame / total > i / text.length ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join('');
      if (++frame <= total) setTimeout(run, 32); else el.textContent = text;
    };
    run();
  };
  const visible = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  const scrambleVisible = () => { if (!reduce) document.querySelectorAll('.scramble').forEach(el => visible(el) && scramble(el)); };
  const io = new IntersectionObserver(entries => entries.forEach(e => {
    if (e.isIntersecting && cfg.scramble === 'scramble' && !reduce) scramble(e.target);
  }), { threshold: .6 });
  document.querySelectorAll('.scramble').forEach(el => io.observe(el));

  /* ---------- Loop ---------- */

  let last = 0, acc = 0;
  const loop = now => {
    const dt = Math.min((now - last) / 1000, .05); last = now;
    if (cfg.spindle !== 'off' && !reduce) {
      if (cfg.spindleMotion === 'spin') spin += .18 * dt;
      if (cfg.spindleMotion === 'follow' && pointer) {
        const target = Math.atan2(pointer.y - .5, pointer.x - .5);
        spin += Math.atan2(Math.sin(target - spin), Math.cos(target - spin)) * Math.min(1, dt * 3);
      }
      drawSpindle(now / 1000);
    }
    if (cfg.floor !== 'off' && !reduce && (acc += dt) > .11) { acc = 0; step(); renderFloor(); }
    requestAnimationFrame(loop);
  };

  const applyAll = () => { applyGrain(); applyPhotos(); applyPanels(); applyAscii(); save(); sync(); };
  applyAll();
  requestAnimationFrame(t => { last = t; loop(t); });
})();
