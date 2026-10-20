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

  // Directions: copy, collage photos and default title face.
  const fonts = {
    'Geist': '"Geist", var(--font-ui)',
    'Plus Jakarta Sans': '"Plus Jakarta Sans", var(--font-ui)',
    'Archivo': '"Archivo", var(--font-ui)',
    'Instrument Sans': '"Instrument Sans", var(--font-ui)',
    'Inter Tight': '"Inter Tight", var(--font-ui)',
    'Host Grotesk': '"Host Grotesk", var(--font-ui)',
    'Inter Display': '"Inter", var(--font-ui)'
  };
  const brands = {
    paper: {
      font: 'Geist',
      title: 'Built to keep building, with agents on every machine',
      sub: 'Perpeto is an open-source software factory. It coordinates agents across your machines and keeps a record of what actually passed verification.',
      photos: { strip: 'plate', right: 'card', left: 'tee', right2: 'jacket', right3: 'banner', left2: 'cap' }
    },
    cobalt: {
      font: 'Plus Jakarta Sans',
      title: 'Coordinate agents across all of your machines',
      sub: 'Give every project a durable home. Perpeto plans the work, hands it to agents on your machines, and shows what passed.',
      photos: { strip: 'tee', right: 'card', left: 'plate', right2: 'tee', right3: 'jacket', left2: 'card' }
    },
    industrial: {
      font: 'Archivo',
      title: 'Intent into working software<b class="accent-text">.</b>',
      sub: 'The open-source software factory for coordinated agents. Goals, requirements, context and feedback in one place, with evidence behind every result.',
      photos: { strip: 'console', right: 'cap', left: 'jacket', right2: 'banner', right3: 'plate', left2: 'console' }
    },
    grid: {
      font: 'Instrument Sans',
      title: 'Turn project intent into verified software',
      sub: 'Plan, build and verify with agents across your machines. Every change traces back to a requirement and the checks behind it.',
      photos: { strip: 'card', right: 'card', left: 'plate', right2: 'card', right3: 'tee', left2: 'plate' }
    }
  };

  const select = document.getElementById('title-font');
  select.innerHTML = Object.keys(fonts).map(f => `<option>${f}</option>`).join('');
  const root = document.documentElement;
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  const setFont = name => {
    root.style.setProperty('--font-title', fonts[name]);
    root.dataset.font = name.toLowerCase().replace(/ /g, '-');
    select.value = name;
  };
  const setBrand = (name, keepFont) => {
    const b = brands[name] || brands.paper;
    name = brands[name] ? name : 'paper';
    root.dataset.brand = name;
    document.querySelector('[data-copy="title"]').innerHTML = b.title;
    document.querySelector('[data-copy="sub"]').textContent = b.sub;
    document.querySelectorAll('img[data-slot]').forEach(img => { img.src = `assets/${b.photos[img.dataset.slot]}.jpg`; });
    document.querySelectorAll('[data-set]').forEach(btn => btn.setAttribute('aria-pressed', btn.dataset.set === name));
    setFont(keepFont && fonts[keepFont] ? keepFont : b.font);
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
    store.set('perpeto-landing-brand', name);
  };

  document.querySelectorAll('[data-set]').forEach(btn => btn.addEventListener('click', () => setBrand(btn.dataset.set)));
  select.addEventListener('change', () => setFont(select.value));
  addEventListener('hashchange', () => { if (brands[location.hash.slice(1)]) setBrand(location.hash.slice(1)); });
  setBrand(location.hash.slice(1) || store.get('perpeto-landing-brand') || 'paper');

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

  // ASCII dot clouds for the Grid direction.
  const cloud = (w, h, seed) => {
    let s = seed, out = '';
    const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - w / 2) / (w / 2), dy = (y - h / 2) / (h / 2), d = dx * dx + dy * dy * 1.4;
        const v = rnd() * (1.25 - d);
        out += v > .75 ? 'X' : v > .55 ? '+' : v > .35 ? ':' : v > .22 ? '.' : ' ';
      }
      out += '\n';
    }
    return out;
  };
  document.querySelector('.ascii.a1').textContent = cloud(30, 18, 7);
  document.querySelector('.ascii.a2').textContent = cloud(28, 16, 31);
})();
