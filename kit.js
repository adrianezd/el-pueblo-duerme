'use strict';

/* =========================================================================
   Party Kit — piezas compartidas por los juegos de fiesta de adrianezd
   (¿Quién es el Impostor?, Dibujo Impostor y El Dato Falso).

   Nombres de jugadores, cronómetro con anillo, sonidos sintetizados,
   vibración, pantalla siempre encendida, votación (a mano alzada o secreta),
   marcador entre rondas, confeti, avisos y modo sin conexión.

   Los tres juegos viven en adrianezd.github.io, así que comparten
   localStorage: los nombres y las preferencias se recuerdan entre juegos.
   Nada secreto (palabras, roles, datos) pasa nunca por localStorage.
   ========================================================================= */

const Kit = (() => {
  const NAMES_KEY = 'party-kit-names-v1';
  const PREFS_KEY = 'party-kit-prefs-v1';
  const RING_LENGTH = 2 * Math.PI * 54; // r=54 en el SVG del cronómetro

  /* ------------------------------- Utilidades ------------------------------- */

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const pick = (array) => array[Math.floor(Math.random() * array.length)];
  const $ = (id) => document.getElementById(id);

  /** Fisher-Yates, no muta el array original. */
  function shuffled(array) {
    const copy = array.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      // localStorage no disponible (modo privado, etc.): se sigue sin recordar.
    }
  }

  /** Elige `count` índices al azar entre 0 y total-1. */
  function pickIndices(total, count) {
    const all = Array.from({ length: total }, (_, i) => i);
    return new Set(shuffled(all).slice(0, count));
  }

  /* ------------------------------ Preferencias ------------------------------ */

  const prefs = Object.assign({ sound: true, vibrate: true }, load(PREFS_KEY, {}));

  function bindPrefToggle(input, key) {
    if (!input) return;
    input.checked = Boolean(prefs[key]);
    input.addEventListener('change', () => {
      prefs[key] = input.checked;
      save(PREFS_KEY, prefs);
      if (key === 'sound' && input.checked) sfx.tap();
      if (key === 'vibrate' && input.checked) buzz(40);
    });
  }

  /* --------------------------------- Sonido --------------------------------- */

  let audioCtx = null;

  function tone(freq, duration, opts) {
    const { type = 'sine', volume = 0.16, delay = 0 } = opts || {};
    if (!prefs.sound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t0 = audioCtx.currentTime + delay;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.03);
    } catch (err) {
      // Audio no disponible: el juego funciona igual en silencio.
    }
  }

  const sfx = {
    tap: () => tone(660, 0.05, { type: 'triangle', volume: 0.07 }),
    reveal: () => {
      tone(420, 0.09, { type: 'triangle' });
      tone(630, 0.14, { type: 'triangle', delay: 0.07 });
    },
    tick: () => tone(880, 0.06, { type: 'square', volume: 0.05 }),
    alarm: () => [0, 0.2, 0.4].forEach((d) => tone(990, 0.15, { type: 'square', volume: 0.1, delay: d })),
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, { type: 'triangle', delay: i * 0.09 })),
    lose: () => [392, 330, 262].forEach((f, i) => tone(f, 0.24, { type: 'sawtooth', volume: 0.07, delay: i * 0.15 }))
  };

  function buzz(pattern) {
    if (!prefs.vibrate || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (err) { /* sin vibración */ }
  }

  /* ------------------------- Pantalla siempre encendida ---------------------- */

  let wakeLock = null;
  let wantAwake = false;

  async function keepAwake(on) {
    wantAwake = on;
    try {
      if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (err) {
      wakeLock = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wantAwake) keepAwake(true);
  });

  /* --------------------------------- Confeti -------------------------------- */

  function confetti(colors) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    const palette = colors || ['#8b5cf6', '#ec4899', '#facc15', '#22c55e', '#38bdf8', '#f97316'];
    const parts = Array.from({ length: 160 }, () => ({
      x: W / 2 + (Math.random() - 0.5) * W * 0.4,
      y: H * 0.38,
      vx: (Math.random() - 0.5) * 13,
      vy: -Math.random() * 13 - 5,
      size: Math.random() * 7 + 5,
      color: pick(palette),
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35
    }));
    const DURATION = 2800;
    const start = performance.now();
    function frame(now) {
      const t = now - start;
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = Math.max(0, 1 - t / DURATION);
      parts.forEach((p) => {
        p.vy += 0.36;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      });
      if (t < DURATION) requestAnimationFrame(frame);
      else canvas.remove();
    }
    requestAnimationFrame(frame);
  }

  /* --------------------------------- Avisos --------------------------------- */

  let toastTimer = null;

  function toast(message) {
    let node = document.querySelector('.toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'toast';
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('is-visible'), 2400);
  }

  /* ---------------------------------- Pantallas ------------------------------ */

  /**
   * Muestra la pantalla `name` (secciones .screen con data-screen) y oculta
   * el resto. La cabecera solo se ve en la pantalla de ajustes; la barra de
   * partida (con «Salir») en todas las demás.
   */
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((section) => {
      const active = section.dataset.screen === name;
      section.hidden = !active;
      if (active) {
        section.classList.remove('screen-enter');
        void section.offsetWidth; // reinicia la animación de entrada
        section.classList.add('screen-enter');
      }
    });
    const inSetup = name === 'setup';
    document.querySelectorAll('.hide-in-game').forEach((node) => { node.hidden = !inSetup; });
    const bar = $('game-bar');
    if (bar) bar.hidden = inSetup;
    document.body.dataset.screen = name;
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  /* ----------------------------- Mantener pulsado ---------------------------- */

  /**
   * Llama a onDown mientras el dedo/ratón/tecla está pulsado y a onUp al
   * soltar. Nunca revela nada con un simple «click».
   */
  function bindHold(node, onDown, onUp) {
    let held = false;
    const down = (e) => {
      if (e && e.cancelable) e.preventDefault();
      if (held) return;
      held = true;
      onDown();
    };
    const up = () => {
      if (!held) return;
      held = false;
      onUp();
    };
    node.addEventListener('pointerdown', down);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => node.addEventListener(t, up));
    node.addEventListener('touchstart', down, { passive: false });
    node.addEventListener('touchend', up);
    node.addEventListener('touchcancel', up);
    node.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) down(e);
    });
    node.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') up();
    });
    node.addEventListener('blur', up);
    node.addEventListener('contextmenu', (e) => e.preventDefault());
    node.addEventListener('dragstart', (e) => e.preventDefault());
  }

  /* -------------------------------- Cronómetro ------------------------------- */

  /**
   * Cronómetro con anillo de progreso. `display` muestra mm:ss, `ring` es el
   * <circle> que se va vaciando y `toggleBtn` el botón de pausa.
   */
  function createTimer({ display, ring, toggleBtn, onEnd }) {
    let seconds = 0;
    let total = 1;
    let running = false;
    let intervalId = null;

    function render() {
      display.textContent = formatTime(seconds);
      display.classList.toggle('is-finished', seconds === 0);
      display.classList.toggle('is-urgent', seconds > 0 && seconds <= 10);
      if (ring) {
        ring.style.strokeDasharray = String(RING_LENGTH);
        ring.style.strokeDashoffset = String(RING_LENGTH * (1 - (total > 0 ? seconds / total : 0)));
        ring.classList.toggle('is-urgent', seconds <= 10);
      }
      if (toggleBtn) {
        toggleBtn.textContent = seconds === 0 ? '¡Tiempo!' : (running ? 'Pausar' : 'Reanudar');
        toggleBtn.disabled = seconds === 0;
      }
    }

    function tick() {
      if (!running || seconds <= 0) return;
      seconds -= 1;
      if (seconds > 0 && seconds <= 5) sfx.tick();
      if (seconds === 0) {
        running = false;
        sfx.alarm();
        buzz([300, 120, 300, 120, 500]);
        if (onEnd) onEnd();
      }
      render();
    }

    function ensureInterval() {
      if (intervalId === null) intervalId = setInterval(tick, 1000);
    }

    function stop() {
      if (intervalId !== null) clearInterval(intervalId);
      intervalId = null;
      running = false;
    }

    function start(s) {
      stop();
      seconds = Math.max(0, s);
      total = Math.max(1, s);
      running = seconds > 0;
      ensureInterval();
      render();
    }

    function adjust(delta) {
      seconds = clamp(seconds + delta, 0, 3600);
      if (seconds > total) total = seconds;
      ensureInterval();
      render();
    }

    function toggle() {
      if (seconds === 0) return;
      running = !running;
      render();
    }

    function skip() {
      stop();
      seconds = 0;
      render();
    }

    return { start, stop, adjust, toggle, skip, get seconds() { return seconds; } };
  }

  /* --------------------------------- Nombres --------------------------------- */

  let names = load(NAMES_KEY, []);
  if (!Array.isArray(names)) names = [];
  names = names.map((n) => (typeof n === 'string' ? n.slice(0, 20) : ''));

  function playerName(i) {
    const n = (names[i] || '').trim();
    return n || `Jugador ${i + 1}`;
  }

  function playerNames(count) {
    return Array.from({ length: count }, (_, i) => playerName(i));
  }

  /** Pinta (o recorta) un campo de nombre por jugador sin perder el foco. */
  function renderNameInputs(container, count) {
    while (container.children.length > count) container.lastElementChild.remove();
    for (let i = container.children.length; i < count; i++) {
      const field = document.createElement('label');
      field.className = 'name-field';
      const num = document.createElement('span');
      num.className = 'name-num';
      num.textContent = String(i + 1);
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 20;
      input.placeholder = `Jugador ${i + 1}`;
      input.value = names[i] || '';
      input.autocomplete = 'off';
      input.setAttribute('autocapitalize', 'words');
      input.setAttribute('enterkeyhint', 'next');
      input.setAttribute('aria-label', `Nombre del jugador ${i + 1}`);
      input.addEventListener('input', () => {
        names[i] = input.value;
        save(NAMES_KEY, names);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const next = field.nextElementSibling && field.nextElementSibling.querySelector('input');
        if (next) next.focus(); else input.blur();
      });
      field.append(num, input);
      container.appendChild(field);
    }
  }

  /** Cambia el orden de los primeros `count` nombres (para sentarse distinto). */
  function shuffleNames(container, count) {
    const subset = Array.from({ length: count }, (_, i) => names[i] || '');
    const mixed = shuffled(subset);
    mixed.forEach((n, i) => { names[i] = n; });
    save(NAMES_KEY, names);
    container.innerHTML = '';
    renderNameInputs(container, count);
  }

  /* --------------------------------- Opciones -------------------------------- */

  /**
   * Pinta una lista de botones seleccionables (tarjetas de modo o pastillas
   * de categoría). `items`: [{ key, label, sub, emoji, disabled }].
   */
  function renderOptions(container, items, { isSelected, onSelect, multi = false, className = 'option-pill' }) {
    container.innerHTML = '';
    items.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = className;
      const selected = isSelected(item.key);
      btn.classList.toggle('is-selected', selected);
      btn.setAttribute('role', multi ? 'checkbox' : 'radio');
      btn.setAttribute('aria-checked', String(selected));
      if (item.disabled) btn.disabled = true;
      btn.innerHTML =
        (item.emoji ? `<span class="option-emoji" aria-hidden="true">${item.emoji}</span>` : '') +
        `<span class="option-text"><span class="option-label">${esc(item.label)}</span>` +
        (item.sub ? `<span class="option-sub">${esc(item.sub)}</span>` : '') +
        '</span>';
      btn.addEventListener('click', () => {
        sfx.tap();
        onSelect(item.key);
      });
      container.appendChild(btn);
    });
  }

  /* --------------------------------- Votación -------------------------------- */

  /**
   * Votación en `container`.
   *  - secret=false: a mano alzada, se tocan los nombres para sumar votos.
   *  - secret=true: el móvil pasa de mano en mano y cada uno vota en privado.
   * Llama a onDone({ votes: number[], none: number }).
   */
  function runVote(container, { names: voteNames, secret, allowNone = false, noneLabel = 'Nadie', onDone }) {
    const n = voteNames.length;
    const votes = new Array(n).fill(0);
    let none = 0;

    if (!secret) {
      renderOpen();
    } else {
      renderSecretIntro(0);
    }

    function totalVotes() {
      return votes.reduce((a, b) => a + b, 0) + none;
    }

    function renderOpen() {
      container.innerHTML = `
        <p class="vote-help">Votad en voz alta o a mano alzada y tocad a quien recibe cada voto. Con <strong>−</strong> se corrige.</p>
        <div class="vote-grid"></div>
        <p class="vote-total" aria-live="polite"></p>
        <button type="button" class="btn btn-primary btn-large vote-done">Ver resultado</button>`;
      const grid = container.querySelector('.vote-grid');
      const total = container.querySelector('.vote-total');
      const done = container.querySelector('.vote-done');

      const entries = voteNames.map((name, i) => ({ name, i }));
      if (allowNone) entries.push({ name: noneLabel, i: -1 });

      entries.forEach(({ name, i }) => {
        const card = document.createElement('div');
        card.className = 'vote-card' + (i === -1 ? ' is-none' : '');
        card.innerHTML = `
          <button type="button" class="vote-main"><span class="vote-name">${esc(name)}</span><span class="vote-count">0</span></button>
          <button type="button" class="vote-minus" aria-label="Quitar un voto a ${esc(name)}">−</button>`;
        const count = card.querySelector('.vote-count');
        const update = () => {
          const v = i === -1 ? none : votes[i];
          count.textContent = String(v);
          card.classList.toggle('has-votes', v > 0);
          const t = totalVotes();
          total.textContent = t === 1 ? '1 voto' : `${t} votos`;
          done.disabled = t === 0;
        };
        card.querySelector('.vote-main').addEventListener('click', () => {
          if (i === -1) none += 1; else votes[i] += 1;
          sfx.tap();
          buzz(15);
          card.classList.remove('bump');
          void card.offsetWidth;
          card.classList.add('bump');
          update();
        });
        card.querySelector('.vote-minus').addEventListener('click', () => {
          if (i === -1) none = Math.max(0, none - 1); else votes[i] = Math.max(0, votes[i] - 1);
          update();
        });
        grid.appendChild(card);
        update();
      });

      done.addEventListener('click', () => onDone({ votes, none }));
    }

    function renderSecretIntro(voter) {
      container.innerHTML = `
        <p class="vote-progress">Votación secreta · ${voter + 1} de ${n}</p>
        <p class="vote-pass">Pasa el móvil a</p>
        <p class="vote-voter">${esc(voteNames[voter])}</p>
        <button type="button" class="btn btn-primary btn-large vote-ready">Soy ${esc(voteNames[voter])}, votar</button>`;
      container.querySelector('.vote-ready').addEventListener('click', () => renderSecretBallot(voter));
    }

    function renderSecretBallot(voter) {
      container.innerHTML = `
        <p class="vote-progress">Votación secreta · ${voter + 1} de ${n}</p>
        <p class="vote-help"><strong>${esc(voteNames[voter])}</strong>, ¿a quién votas? Nadie más debe mirar.</p>
        <div class="vote-grid is-ballot"></div>`;
      const grid = container.querySelector('.vote-grid');
      const options = voteNames.map((name, i) => ({ name, i })).filter((o) => o.i !== voter);
      if (allowNone) options.push({ name: noneLabel, i: -1 });
      options.forEach(({ name, i }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vote-ballot' + (i === -1 ? ' is-none' : '');
        btn.textContent = name;
        btn.addEventListener('click', () => {
          if (i === -1) none += 1; else votes[i] += 1;
          sfx.tap();
          buzz(25);
          if (voter + 1 < n) {
            renderSecretIntro(voter + 1);
            toast('Voto guardado 🤫');
          } else {
            onDone({ votes, none });
          }
        });
        grid.appendChild(btn);
      });
    }
  }

  /**
   * A partir de los votos decide a quién se expulsa: los `slots` más votados.
   * Si hay empate en el corte, no se expulsa a los empatados.
   * Devuelve { accused: number[], tie: boolean, noneWins: boolean, max: number }.
   */
  function tally({ votes, none }, slots) {
    const ranked = votes
      .map((v, i) => ({ v, i }))
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v);
    const max = ranked.length ? ranked[0].v : 0;
    const noneWins = none > 0 && none >= max;
    if (noneWins || !ranked.length) return { accused: [], tie: false, noneWins, max };
    const cut = ranked[Math.min(slots, ranked.length) - 1].v;
    const above = ranked.filter((x) => x.v > cut);
    const atCut = ranked.filter((x) => x.v === cut);
    const free = slots - above.length;
    const tie = atCut.length > free;
    const accused = (tie ? above : above.concat(atCut)).map((x) => x.i);
    return { accused, tie, noneWins, max };
  }

  /* --------------------------------- Marcador -------------------------------- */

  /** Marcador en memoria, indexado por nombre (sobrevive a cambios de orden). */
  function createScores() {
    let points = {};
    let rounds = 0;
    let lastDelta = {};

    return {
      get rounds() { return rounds; },
      startRound() { lastDelta = {}; },
      add(name, pts) {
        if (!pts) return;
        points[name] = (points[name] || 0) + pts;
        lastDelta[name] = (lastDelta[name] || 0) + pts;
      },
      endRound() { rounds += 1; },
      reset() { points = {}; lastDelta = {}; rounds = 0; },
      render(container, currentNames) {
        const rows = currentNames
          .map((name) => ({ name, pts: points[name] || 0, delta: lastDelta[name] || 0 }))
          .sort((a, b) => b.pts - a.pts || b.delta - a.delta);
        const best = Math.max(1, ...rows.map((r) => r.pts));
        const top = rows.length ? rows[0].pts : 0;
        container.innerHTML = rows.map((r, idx) => `
          <li class="score-row${top > 0 && r.pts === top ? ' is-leader' : ''}">
            <span class="score-rank">${top > 0 && r.pts === top ? '👑' : idx + 1}</span>
            <span class="score-name">${esc(r.name)}</span>
            ${r.delta ? `<span class="score-delta">+${r.delta}</span>` : ''}
            <span class="score-pts">${r.pts}</span>
            <span class="score-bar" style="--w:${Math.round((r.pts / best) * 100)}%"></span>
          </li>`).join('');
      }
    };
  }

  /* -------------------------------- Sin conexión ----------------------------- */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* sin modo offline */ });
    });
  }

  registerServiceWorker();

  return {
    clamp, pick, shuffled, formatTime, esc, load, save, pickIndices, $,
    prefs, bindPrefToggle, sfx, buzz, keepAwake, confetti, toast,
    showScreen, bindHold, createTimer,
    playerName, playerNames, renderNameInputs, shuffleNames,
    renderOptions, runVote, tally, createScores
  };
})();
