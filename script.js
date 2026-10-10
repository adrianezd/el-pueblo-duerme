'use strict';

/* =========================================================================
   El pueblo duerme — juego de fiesta de lobos y aldeanos
   Cada noche los lobos eligen a quién devorar, la vidente descubre si
   alguien es lobo y la curandera protege a alguien. De día el pueblo
   debate y vota a quién eliminar. Gana el pueblo si caen todos los lobos;
   ganan los lobos si llegan a ser tantos como el resto.

   Un único motor (newGame / act) para los dos modos:
   - «Mismo móvil»: el móvil se pasa de mano en mano; de noche, cada uno
     hace su acción en secreto (los aldeanos también tocan algo, para que
     nadie se delate por el tiempo que tarda).
   - «Con código de sala» (sala.js): cada uno juega con su móvil.
   La partida vive solo en memoria; en localStorage solo van los ajustes.
   ========================================================================= */

/* ------------------------------- Constantes ------------------------------- */

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 16;
const TIMER_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 8, 10]; // minutos de debate (0 = sin cronómetro)
const TIMER_STEP = 30;
const SETTINGS_KEY = 'pueblo-duerme-settings-v1';

const ROLES = {
  lobo: { name: 'Lobo', emoji: '🐺', team: 'lobos', goal: 'Cada noche, con tu manada, elegís a quién devorar. De día, disimula.' },
  vidente: { name: 'Vidente', emoji: '🔮', team: 'pueblo', goal: 'Cada noche descubres si alguien es lobo. Usa lo que sabes sin delatarte.' },
  curandera: { name: 'Curandera', emoji: '🌿', team: 'pueblo', goal: 'Cada noche proteges a alguien de los lobos. No puedes repetir dos noches seguidas.' },
  aldeano: { name: 'Aldeano', emoji: '🧑‍🌾', team: 'pueblo', goal: 'Sin poderes: escucha, sospecha y vota bien de día.' }
};

/* --------------------------------- Ajustes --------------------------------- */

let settings = {
  playerCount: 6,
  wolves: 1,
  seer: true,
  healer: true,
  timerMinutes: 3,
  reveal: true,
  secretVote: false
};
let wolvesManual = false;

function maxWolvesFor(n) { return Math.max(1, Math.floor((n - 1) / 3)); }
function suggestedWolves(n) { return Math.min(maxWolvesFor(n), n <= 6 ? 1 : n <= 10 ? 2 : 3); }

function loadSettings() {
  const p = Kit.load(SETTINGS_KEY, {}) || {};
  if (typeof p.playerCount === 'number') settings.playerCount = Kit.clamp(Math.round(p.playerCount), MIN_PLAYERS, MAX_PLAYERS);
  if (typeof p.wolves === 'number') {
    settings.wolves = Kit.clamp(Math.round(p.wolves), 1, maxWolvesFor(settings.playerCount));
    wolvesManual = true;
  } else {
    settings.wolves = suggestedWolves(settings.playerCount);
  }
  ['seer', 'healer', 'reveal', 'secretVote'].forEach((k) => { if (typeof p[k] === 'boolean') settings[k] = p[k]; });
  if (TIMER_OPTIONS.includes(p.timerMinutes)) settings.timerMinutes = p.timerMinutes;
}

function saveSettings() {
  // en una sala no se guarda su número de jugadores como el de «mismo móvil»
  Kit.save(SETTINGS_KEY, salaBackup ? Object.assign({}, settings, salaBackup) : settings);
}

/* ---------------------------------- Motor ----------------------------------- */

// Estado: { cfg, players: [{ role, alive }], day, phase, ready, night, lastHeal, dawn, votes, verdict, winner }
// Fases: reveal → night → dawn → day → vote → verdict → night… y end.

function newGame(n, cfg) {
  const roles = [];
  for (let k = 0; k < cfg.wolves; k++) roles.push('lobo');
  if (cfg.seer) roles.push('vidente');
  if (cfg.healer) roles.push('curandera');
  while (roles.length < n) roles.push('aldeano');
  return {
    cfg: { reveal: cfg.reveal, seconds: cfg.timerMinutes * 60 },
    players: Kit.shuffled(roles).map((role) => ({ role, alive: true })),
    day: 1, phase: 'reveal', ready: {}, night: null, lastHeal: null,
    dawn: null, votes: {}, verdict: null, winner: null
  };
}

const roleOf = (g, i) => g.players[i].role;
const aliveList = (g) => g.players.map((p, i) => (p.alive ? i : -1)).filter((i) => i >= 0);
const wolvesOf = (g) => g.players.map((p, i) => (p.role === 'lobo' ? i : -1)).filter((i) => i >= 0);

function checkWin(g) {
  const alive = aliveList(g);
  const wolves = alive.filter((i) => roleOf(g, i) === 'lobo').length;
  if (wolves === 0) return 'pueblo';
  if (wolves >= alive.length - wolves) return 'lobos';
  return null;
}

function startNight(g) {
  g.phase = 'night';
  g.night = { acts: {}, seer: null };
  g.votes = {};
  g.verdict = null;
}

function validTarget(g, i, t) {
  if (!(t >= 0 && t < g.players.length) || !g.players[t].alive) return false;
  const r = roleOf(g, i);
  if (r === 'lobo') return roleOf(g, t) !== 'lobo';
  if (r === 'curandera') return t !== g.lastHeal;
  return t !== i;
}

// Víctima: la más votada por los lobos vivos (empate: al azar entre las empatadas)
function resolveNight(g) {
  const acts = g.night.acts;
  const counts = {};
  wolvesOf(g).filter((i) => g.players[i].alive && acts[i] != null).forEach((i) => { counts[acts[i]] = (counts[acts[i]] || 0) + 1; });
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter((k) => counts[k] === max).map(Number);
  const victim = top.length ? Kit.pick(top) : null;
  const healer = g.players.findIndex((p) => p.role === 'curandera' && p.alive);
  const heal = healer !== -1 && acts[healer] != null ? acts[healer] : null;
  const died = victim != null && victim !== heal ? victim : null;
  if (died != null) g.players[died].alive = false;
  g.lastHeal = heal;
  g.dawn = { died, saved: victim != null && victim === heal, seer: g.night.seer };
  g.phase = 'dawn';
  g.winner = checkWin(g);
}

// Votación del día: votes = { votante: índice | 'none' }
function resolveVote(g, votes) {
  const counts = {};
  let none = 0;
  Object.keys(votes).forEach((k) => {
    const t = votes[k];
    if (t === 'none') none += 1; else counts[t] = (counts[t] || 0) + 1;
  });
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter((k) => counts[k] === max).map(Number);
  let out = null;
  let reason = 'novote';
  if (none > 0 && none >= max) reason = 'none';
  else if (top.length > 1) reason = 'tie';
  else if (top.length === 1) { out = top[0]; reason = 'out'; }
  if (out != null) g.players[out].alive = false;
  g.verdict = { out, reason, counts, none };
  g.phase = 'verdict';
  g.winner = checkWin(g);
}

/**
 * Acción del jugador i (o del anfitrión, host=true). Devuelve null si no
 * vale; si vale, un objeto (con timer: segundos | null para el cronómetro).
 */
function act(g, i, a, host) {
  const me = g.players[i];
  switch (a.t) {
    case 'ready':
      if (g.phase !== 'reveal' || !me) return null;
      g.ready[i] = true;
      if (aliveList(g).every((k) => g.ready[k])) startNight(g);
      return {};
    case 'night-start':
      if (!host || (g.phase !== 'reveal' && g.phase !== 'verdict') || g.winner) return null;
      if (g.phase === 'verdict') g.day += 1;
      startNight(g);
      return { timer: null };
    case 'night':
      if (g.phase !== 'night' || !me || !me.alive || g.night.acts[i] != null || !validTarget(g, i, a.target)) return null;
      g.night.acts[i] = a.target;
      if (me.role === 'vidente') g.night.seer = { i, t: a.target, wolf: roleOf(g, a.target) === 'lobo' };
      if (aliveList(g).every((k) => g.night.acts[k] != null)) resolveNight(g);
      return {};
    case 'dawn':
      if (!host || g.phase !== 'night') return null;
      resolveNight(g);
      return {};
    case 'day':
      if (!host || g.phase !== 'dawn' || g.winner) return null;
      g.phase = 'day';
      return { timer: g.cfg.seconds || null };
    case 'to-vote':
      if (!host || g.phase !== 'day') return null;
      g.phase = 'vote';
      g.votes = {};
      return { timer: null };
    case 'vote':
      if (g.phase !== 'vote' || !me || !me.alive) return null;
      if (a.target !== 'none' && (!(a.target >= 0 && a.target < g.players.length) || !g.players[a.target].alive || a.target === i)) return null;
      g.votes[i] = a.target;
      if (aliveList(g).every((k) => g.votes[k] != null)) resolveVote(g, g.votes);
      return {};
    case 'tally':
      if (!host || g.phase !== 'vote') return null;
      resolveVote(g, g.votes);
      return {};
    case 'end':
      if (!host || !g.winner) return null;
      g.phase = 'end';
      return { timer: null };
    default:
      return null;
  }
}

/* ------------------------------ Lo que se pinta ------------------------------ */
// Las mismas piezas para el modo de un móvil y para la sala. Los botones
// llevan data-act con la acción, que reparte quien juega (local o sala).

const actAttr = (a) => `data-act="${Kit.esc(JSON.stringify(a))}"`;
const nameList = (ids, names) => ids.map((k) => `<strong>${Kit.esc(names[k])}</strong>`).join(', ').replace(/, ([^,]*)$/, ' y $1');
const roleTag = (g, i) => `${ROLES[roleOf(g, i)].emoji} ${ROLES[roleOf(g, i)].name}`;

/** Carta de papel del jugador i (para la carta que se gira). */
function roleCard(g, i, names) {
  const role = ROLES[roleOf(g, i)];
  let extra = Kit.esc(role.goal);
  if (role === ROLES.lobo) {
    const pack = wolvesOf(g).filter((k) => k !== i);
    extra += `<br><strong>${pack.length ? `Tu manada: ${pack.map((k) => Kit.esc(names[k])).join(', ')}` : 'Eres el único lobo'}</strong>`;
  }
  return { label: role.team === 'lobos' ? 'Equipo de los lobos' : 'Equipo del pueblo', emoji: role.emoji, content: role.name, extra, alert: role.team === 'lobos', impostor: role.team === 'lobos' };
}

function targetButtons(g, i, names, ok, note) {
  return '<div class="sala-votes">' + aliveList(g).filter((k) => k !== i || roleOf(g, i) === 'curandera').map((k) => {
    const can = ok(k);
    return `<button type="button" class="sala-vote" ${can ? actAttr({ t: 'night', target: k }) : 'disabled'}>${Kit.esc(names[k])}${!can && note ? `<small>${note(k)}</small>` : ''}</button>`;
  }).join('') + '</div>';
}

/** Lo que hace de noche el jugador i. */
function nightPanel(g, i, names) {
  const me = g.players[i];
  if (!me.alive) return '<p class="screen-help">💀 Estás fuera de la partida. Cierra los ojos y no digas nada.</p>';
  const done = g.night.acts[i];
  const r = me.role;
  if (done != null) {
    if (r === 'lobo') return `<p class="screen-help">🐺 Has elegido a <strong>${Kit.esc(names[done])}</strong>. Cuando amanezca se sabrá…</p>`;
    if (r === 'vidente') {
      const wolf = roleOf(g, done) === 'lobo';
      return `<div class="night-result ${wolf ? 'is-wolf' : 'is-safe'}"><span>${wolf ? '🐺' : '🕊️'}</span><p><strong>${Kit.esc(names[done])}</strong> ${wolf ? '¡es un lobo!' : 'no es un lobo'}</p></div>` +
        '<p class="screen-help">Guárdatelo: si lo dices muy claro, irán a por ti.</p>';
    }
    if (r === 'curandera') return `<p class="screen-help">🌿 Esta noche proteges a <strong>${Kit.esc(names[done])}</strong>.</p>`;
    return '<p class="screen-help">😴 Duermes tranquilo… o eso crees.</p>';
  }
  if (r === 'lobo') {
    const pack = wolvesOf(g).filter((k) => k !== i && g.players[k].alive);
    const picks = pack.filter((k) => g.night.acts[k] != null).map((k) => `${Kit.esc(names[k])} → <strong>${Kit.esc(names[g.night.acts[k]])}</strong>`);
    return '<h3 class="night-title">🐺 ¿A quién devoráis esta noche?</h3>' +
      (pack.length ? `<p class="screen-help">Tu manada: ${nameList(pack, names)}.${picks.length ? `<br>Han elegido: ${picks.join(' · ')}` : ''}</p>` : '') +
      targetButtons(g, i, names, (k) => roleOf(g, k) !== 'lobo', () => 'lobo');
  }
  if (r === 'vidente') return '<h3 class="night-title">🔮 ¿De quién quieres saber si es lobo?</h3>' + targetButtons(g, i, names, () => true);
  if (r === 'curandera') {
    return '<h3 class="night-title">🌿 ¿A quién proteges esta noche?</h3>' +
      targetButtons(g, i, names, (k) => k !== g.lastHeal, () => 'anoche') +
      (g.lastHeal != null ? '<p class="setup-hint">No puedes proteger dos noches seguidas a la misma persona.</p>' : '');
  }
  return '<h3 class="night-title">😴 Eres aldeano: duermes</h3><p class="screen-help">Toca a quien te parece más sospechoso. No cambia nada: es para que nadie note quién tiene poderes.</p>' +
    targetButtons(g, i, names, () => true);
}

function newsHtml(g, names) {
  const d = g.dawn;
  const reveal = (k) => (g.cfg.reveal ? ` Era <strong>${roleTag(g, k)}</strong>.` : '');
  if (d.died != null) return `<div class="verdict is-lose"><span class="verdict-emoji" aria-hidden="true">🐺</span><h2 class="verdict-title">${Kit.esc(names[d.died])} no ha despertado</h2><p class="verdict-text">Los lobos atacaron durante la noche.${reveal(d.died)}</p></div>`;
  if (d.saved) return '<div class="verdict is-win"><span class="verdict-emoji" aria-hidden="true">🌿</span><h2 class="verdict-title">¡Nadie ha muerto!</h2><p class="verdict-text">Los lobos atacaron, pero la curandera salvó a su víctima.</p></div>';
  return '<div class="verdict"><span class="verdict-emoji" aria-hidden="true">🌄</span><h2 class="verdict-title">Noche tranquila</h2><p class="verdict-text">Esta noche nadie ha muerto.</p></div>';
}

function verdictHtml(g, names) {
  const v = g.verdict;
  if (v.out != null) {
    const wolf = roleOf(g, v.out) === 'lobo';
    const show = g.cfg.reveal ? ` Era <strong>${roleTag(g, v.out)}</strong>.` : '';
    return `<div class="verdict ${g.cfg.reveal ? (wolf ? 'is-win' : 'is-lose') : ''}"><span class="verdict-emoji" aria-hidden="true">⚖️</span><h2 class="verdict-title">El pueblo ha echado a ${Kit.esc(names[v.out])}</h2><p class="verdict-text">${show || 'Su papel queda en secreto.'}</p></div>`;
  }
  const text = v.reason === 'tie' ? 'Empate en la votación: nadie se va.' : v.reason === 'none' ? 'El pueblo decide no echar a nadie hoy.' : 'Nadie votó.';
  return `<div class="verdict"><span class="verdict-emoji" aria-hidden="true">🤝</span><h2 class="verdict-title">Nadie se va</h2><p class="verdict-text">${text}</p></div>`;
}

function voteSummary(g, names) {
  const v = g.verdict;
  const rows = Object.keys(v.counts).map(Number).sort((a, b) => v.counts[b] - v.counts[a]).map((k) => `${Kit.esc(names[k])} ${v.counts[k]}`);
  if (v.none) rows.push(`Nadie ${v.none}`);
  return rows.length ? `<p class="vote-summary">Votos: ${rows.join(' · ')}</p>` : '';
}

function endHtml(g, names) {
  const town = g.winner === 'pueblo';
  return `<div class="verdict ${town ? 'is-win' : 'is-lose'}"><span class="verdict-emoji" aria-hidden="true">${town ? '🌞' : '🐺'}</span>` +
    `<h2 class="verdict-title">${town ? '¡Gana el pueblo!' : '¡Ganan los lobos!'}</h2>` +
    `<p class="verdict-text">${town ? 'Han caído todos los lobos. El pueblo por fin duerme tranquilo.' : 'Los lobos ya son tantos como el resto. El pueblo es suyo.'}</p></div>` +
    '<div class="card reveal-box"><p class="results-label">Quién era quién</p><ul class="town-list">' +
    g.players.map((p, k) => `<li class="${p.role === 'lobo' ? 'is-wolf' : ''}${p.alive ? '' : ' is-dead'}"><span>${ROLES[p.role].emoji}</span><strong>${Kit.esc(names[k])}</strong><small>${ROLES[p.role].name}${p.alive ? '' : ' · 💀'}</small></li>`).join('') +
    '</ul></div>';
}

function aliveChips(g, names) {
  return `<ul class="town-chips">${g.players.map((p, k) => `<li class="${p.alive ? '' : 'is-dead'}">${p.alive ? '' : '💀 '}${Kit.esc(names[k])}</li>`).join('')}</ul>`;
}

function voteButtons(g, i, names) {
  const mine = g.votes[i];
  return '<div class="sala-votes">' + aliveList(g).filter((k) => k !== i).map((k) =>
    `<button type="button" class="sala-vote${mine === k ? ' is-selected' : ''}" ${actAttr({ t: 'vote', target: k })}>${Kit.esc(names[k])}</button>`).join('') +
    `<button type="button" class="sala-vote is-none${mine === 'none' ? ' is-selected' : ''}" ${actAttr({ t: 'vote', target: 'none' })}>🙅 Nadie</button></div>`;
}

/* --------------------------- Modo «Mismo móvil» ----------------------------- */

const el = {};
let game = null;    // estado del motor
let local = null;   // { names, reveal, order, pos, unlocked }
let timer = null;

function cacheDom() {
  [
    'player-count-value', 'btn-player-minus', 'btn-player-plus', 'wolf-count-value', 'btn-wolf-minus', 'btn-wolf-plus',
    'wolf-hint', 'names-grid', 'btn-shuffle-names', 'opt-seer', 'opt-healer', 'role-summary', 'time-value', 'timer-hint',
    'btn-time-minus', 'btn-time-plus', 'opt-reveal', 'opt-secret-vote', 'opt-sound', 'opt-vibrate', 'btn-start-game',
    'game-bar-title', 'btn-exit', 'play-root'
  ].forEach((id) => { el[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id); });
}

function renderSetup() {
  const n = settings.playerCount;
  const max = maxWolvesFor(n);
  settings.wolves = Kit.clamp(settings.wolves, 1, max);
  el.playerCountValue.textContent = String(n);
  el.btnPlayerMinus.disabled = n <= MIN_PLAYERS;
  el.btnPlayerPlus.disabled = n >= MAX_PLAYERS;
  el.wolfCountValue.textContent = String(settings.wolves);
  el.btnWolfMinus.disabled = settings.wolves <= 1;
  el.btnWolfPlus.disabled = settings.wolves >= max;
  el.wolfHint.textContent = `Máximo ${max} para ${n} jugadores`;
  Kit.renderNameInputs(el.namesGrid, n);
  el.optSeer.checked = settings.seer;
  el.optHealer.checked = settings.healer;
  el.optReveal.checked = settings.reveal;
  el.optSecretVote.checked = settings.secretVote;
  const villagers = n - settings.wolves - (settings.seer ? 1 : 0) - (settings.healer ? 1 : 0);
  el.roleSummary.textContent = `🐺 ${settings.wolves} · ${settings.seer ? '🔮 1 · ' : ''}${settings.healer ? '🌿 1 · ' : ''}🧑‍🌾 ${Math.max(0, villagers)}`;
  const idx = TIMER_OPTIONS.indexOf(settings.timerMinutes);
  el.timeValue.textContent = settings.timerMinutes ? `${settings.timerMinutes}′` : '—';
  el.timerHint.textContent = settings.timerMinutes ? 'Con cronómetro' : 'Sin cronómetro';
  el.btnTimeMinus.disabled = idx <= 0;
  el.btnTimePlus.disabled = idx >= TIMER_OPTIONS.length - 1;
}

function changePlayers(d) {
  settings.playerCount = Kit.clamp(settings.playerCount + d, MIN_PLAYERS, MAX_PLAYERS);
  if (!wolvesManual) settings.wolves = suggestedWolves(settings.playerCount);
  saveSettings();
  renderSetup();
}

function startLocalGame() {
  game = newGame(settings.playerCount, settings);
  local = { names: Kit.playerNames(settings.playerCount), reveal: 0 };
  Kit.keepAwake(true);
  Kit.showScreen('play');
  renderLocal();
}

// Noche en un móvil: se pasa por orden a cada vivo
function beginLocalNight() {
  local.order = aliveList(game);
  local.pos = 0;
  local.unlocked = false;
}

function holdCardHtml() {
  return '<button type="button" id="local-hold" class="hold-card"><span class="hold-inner"><span class="hold-face hold-front">' +
    '<span class="hold-icon" aria-hidden="true">👆</span><span class="hold-prompt">Mantén pulsado para ver tu papel</span>' +
    '<span class="hold-sub">Suelta para ocultarlo</span></span><span class="hold-face hold-back" id="local-role"></span></span></button>';
}

function localTimerHtml() {
  return '<div class="timer-block"><div class="timer-ring"><svg viewBox="0 0 120 120" aria-hidden="true">' +
    '<circle class="ring-bg" cx="60" cy="60" r="54"/><circle class="ring-fg" id="local-ring" cx="60" cy="60" r="54"/></svg>' +
    '<span class="timer-display" id="local-timer" role="timer"></span></div><div class="timer-controls">' +
    `<button type="button" class="btn btn-ghost" data-timer="-">−${TIMER_STEP}s</button>` +
    '<button type="button" class="btn btn-ghost" id="local-timer-toggle">Pausar</button>' +
    `<button type="button" class="btn btn-ghost" data-timer="+">+${TIMER_STEP}s</button></div></div>`;
}

function renderLocal() {
  const g = game;
  const names = local.names;
  let html = '';
  el.gameBarTitle.textContent = g.phase === 'reveal' ? 'Reparto de papeles' : `Día ${g.day}`;

  if (g.phase === 'reveal') {
    const i = local.reveal;
    html = `<ol class="progress-dots" aria-hidden="true">${names.map((_, k) => `<li class="${k < i ? 'is-done' : k === i ? 'is-current' : ''}"></li>`).join('')}</ol>` +
      `<p class="reveal-pass">Pasa el móvil a</p><h2 class="reveal-player">${Kit.esc(names[i])}</h2>` +
      '<p class="reveal-warning">🤫 Que nadie más mire la pantalla</p>' + holdCardHtml() +
      `<button type="button" class="btn btn-secondary btn-large" id="local-next" disabled>${i === names.length - 1 ? 'Ya lo vi, ¡llega la noche!' : 'Ya lo vi, pasar al siguiente'}</button>`;
  } else if (g.phase === 'night' || (local.order && local.pos < local.order.length && g.phase === 'dawn')) {
    const i = local.order[local.pos];
    if (!local.unlocked) {
      html = `<h2 class="screen-title">🌙 Noche ${g.day}</h2><p class="screen-help">El pueblo duerme. Pasad el móvil por orden: cada uno hace su acción en secreto, también los aldeanos.</p>` +
        `<p class="reveal-pass">Pasa el móvil a</p><h2 class="reveal-player">${Kit.esc(names[i])}</h2>` +
        `<button type="button" class="btn btn-primary btn-large" id="local-unlock">Soy ${Kit.esc(names[i])}</button>`;
    } else {
      // tras actuar el último, la noche ya se ha resuelto: se enseña lo que hizo
      // (y como seguía vivo durante la noche, no se le delata si era la víctima)
      const view = g.phase === 'night' ? g : Object.assign({}, g, {
        night: local.lastNight,
        players: g.players.map((p, k) => (k === i ? Object.assign({}, p, { alive: true }) : p))
      });
      html = `<p class="reveal-pass">${Kit.esc(names[i])} · ${roleTag(g, i)}</p>` + nightPanel(view, i, names) +
        (view.night.acts[i] != null ? `<button type="button" class="btn btn-secondary btn-large" id="local-pass">${local.pos === local.order.length - 1 ? 'Listo, ¡que amanezca!' : 'Listo, pasa el móvil'}</button>` : '');
    }
  } else if (g.phase === 'dawn') {
    html = `<h2 class="screen-title">☀️ Amanece · día ${g.day}</h2>` + newsHtml(g, names) +
      (g.winner ? `<button type="button" class="btn btn-primary btn-large" ${actAttr({ t: 'end' })}>Ver el final</button>`
        : `<button type="button" class="btn btn-primary btn-large" ${actAttr({ t: 'day' })}>Empezar el día 🗣️</button>`);
  } else if (g.phase === 'day') {
    html = `<h2 class="screen-title">🗣️ Debate · día ${g.day}</h2><p class="screen-help">¿Quién es lobo? Hablad, acusad y defendeos. Los que han caído no pueden hablar.</p>` +
      aliveChips(g, names) + (g.cfg.seconds ? localTimerHtml() : '') +
      `<button type="button" class="btn btn-primary btn-large" ${actAttr({ t: 'to-vote' })}>Votar 🗳️</button>`;
  } else if (g.phase === 'vote') {
    html = '<h2 class="screen-title">¿A quién echa el pueblo?</h2><div class="vote-area" id="local-vote"></div>';
  } else if (g.phase === 'verdict') {
    html = verdictHtml(g, names) + voteSummary(g, names) +
      (g.winner ? `<button type="button" class="btn btn-primary btn-large" ${actAttr({ t: 'end' })}>Ver el final</button>`
        : `<button type="button" class="btn btn-primary btn-large" ${actAttr({ t: 'night-start' })}>Llega la noche 🌙</button>`);
  } else if (g.phase === 'end') {
    html = endHtml(g, names) + '<div class="results-actions"><button type="button" class="btn btn-primary btn-large" id="local-again">Otra partida ▶</button>' +
      '<button type="button" class="btn btn-secondary btn-large" id="local-setup">Cambiar ajustes</button></div>';
  }

  el.playRoot.innerHTML = `<div class="center-wrap">${html}</div>`;
  bindLocal();
}

function localAct(a) {
  const before = game.phase;
  const res = act(game, -1, a, true);
  if (!res) return;
  Kit.sfx.tap();
  if (game.phase === 'night' && before !== 'night') beginLocalNight();
  if ('timer' in res) { if (res.timer) startTimerLater(res.timer); else if (timer) timer.stop(); }
  if (game.phase !== before) {
    if (game.phase === 'end') { if (game.winner === 'pueblo') { Kit.sfx.win(); Kit.confetti(); } else Kit.sfx.lose(); }
    else Kit.sfx.reveal();
  }
  renderLocal();
}
let pendingTimer = 0;
function startTimerLater(s) { pendingTimer = s; }

function bindLocal() {
  const root = el.playRoot;
  root.querySelectorAll('[data-act]').forEach((b) => {
    b.onclick = () => {
      let a;
      try { a = JSON.parse(b.dataset.act); } catch (err) { return; }
      if (a.t === 'night') {
        // acción de noche del jugador que tiene el móvil
        const i = local.order[local.pos];
        const wasNight = game.phase === 'night';
        local.lastNight = JSON.parse(JSON.stringify(game.night));
        if (!act(game, i, a, false)) return;
        if (wasNight && game.phase !== 'night') local.lastNight.acts[i] = a.target; // la noche se resolvió con él
        Kit.sfx.tap();
        Kit.buzz(20);
        renderLocal();
        return;
      }
      localAct(a);
    };
  });

  const hold = document.getElementById('local-hold');
  if (hold) {
    const back = document.getElementById('local-role');
    const next = document.getElementById('local-next');
    Kit.bindHold(hold, () => {
      const c = roleCard(game, local.reveal, local.names);
      back.classList.toggle('is-alert', Boolean(c.alert));
      back.innerHTML = `<span class="role-category-label">${Kit.esc(c.label)}</span><span class="role-emoji" aria-hidden="true">${c.emoji}</span>` +
        `<span class="role-content${c.impostor ? ' is-impostor' : ''}">${Kit.esc(c.content)}</span><span class="role-extra">${c.extra}</span>`;
      hold.classList.add('is-held');
      next.disabled = false;
      Kit.buzz(20);
    }, () => {
      hold.classList.remove('is-held');
      setTimeout(() => { if (!hold.classList.contains('is-held')) back.innerHTML = ''; }, 300);
    });
    next.onclick = () => {
      if (next.disabled) return;
      game.ready[local.reveal] = true;
      if (local.reveal < local.names.length - 1) { local.reveal += 1; Kit.sfx.tap(); renderLocal(); return; }
      startNight(game);
      beginLocalNight();
      Kit.sfx.reveal();
      renderLocal();
    };
  }

  const unlock = document.getElementById('local-unlock');
  if (unlock) unlock.onclick = () => { local.unlocked = true; local.lastNight = JSON.parse(JSON.stringify(game.night)); Kit.sfx.tap(); renderLocal(); };
  const pass = document.getElementById('local-pass');
  if (pass) {
    pass.onclick = () => {
      local.pos += 1;
      local.unlocked = false;
      if (local.pos >= local.order.length && game.phase === 'night') resolveNight(game);
      Kit.sfx.reveal();
      renderLocal();
    };
  }

  if (game.phase === 'day' && game.cfg.seconds) {
    timer = Kit.createTimer({
      display: document.getElementById('local-timer'),
      ring: document.getElementById('local-ring'),
      toggleBtn: document.getElementById('local-timer-toggle'),
      onEnd: () => Kit.toast('⏰ ¡Se acabó el tiempo! A votar')
    });
    timer.start(pendingTimer || game.cfg.seconds);
    pendingTimer = 0;
    document.getElementById('local-timer-toggle').onclick = () => timer.toggle();
    root.querySelectorAll('[data-timer]').forEach((b) => { b.onclick = () => timer.adjust(b.dataset.timer === '+' ? TIMER_STEP : -TIMER_STEP); });
  }

  if (game.phase === 'vote') {
    const alive = aliveList(game);
    Kit.runVote(document.getElementById('local-vote'), {
      names: alive.map((k) => local.names[k]),
      secret: settings.secretVote,
      allowNone: true,
      noneLabel: '🙅 Nadie',
      onDone: ({ votes, none }) => {
        const v = {};
        let n = 0;
        votes.forEach((c, j) => { for (let x = 0; x < c; x++) v[`v${n++}`] = alive[j]; });
        for (let x = 0; x < none; x++) v[`v${n++}`] = 'none';
        resolveVote(game, v);
        Kit.sfx.reveal();
        renderLocal();
      }
    });
  }

  const again = document.getElementById('local-again');
  if (again) again.onclick = () => { Kit.sfx.tap(); startLocalGame(); };
  const setup = document.getElementById('local-setup');
  if (setup) setup.onclick = backToSetup;
}

function backToSetup() {
  if (timer) timer.stop();
  game = null;
  local = null;
  Kit.keepAwake(false);
  renderSetup();
  Kit.showScreen('setup');
}

/* --------------------------- Con código de sala ------------------------------ */

// Mientras se configura una sala, los jugadores son los que han entrado:
// aquí se guarda el número de «mismo móvil» para devolverlo al salir.
let salaBackup = null;

function salaHosting(on, players) {
  if (on) {
    if (!salaBackup) salaBackup = { playerCount: settings.playerCount };
    settings.playerCount = Kit.clamp(players, MIN_PLAYERS, MAX_PLAYERS);
    settings.wolves = Kit.clamp(settings.wolves, 1, maxWolvesFor(settings.playerCount));
  } else if (salaBackup) {
    settings.playerCount = salaBackup.playerCount;
    salaBackup = null;
  }
  renderSetup();
}

function waitHost(ctx, text) { return `<p class="setup-hint sala-center">⏳ ${Kit.esc(text || `Esperando a ${ctx.hostName}`)}</p>`; }
function hostBtn(a, label) { return `<button type="button" class="btn btn-primary btn-large" ${actAttr(a)}>${label}</button>`; }

function salaRender(ctx) {
  const { g, me, host, names } = ctx;
  const inGame = me >= 0 && me < g.players.length;
  const alive = inGame && g.players[me].alive;
  const count = (obj) => aliveList(g).filter((k) => obj[k] != null).length;
  const spectator = '<p class="screen-help">👀 Has entrado con la partida empezada: mira y espera a la siguiente.</p>';
  const ghost = inGame && !alive ? '<p class="setup-hint sala-center">💀 Estás fuera: no hables ni des pistas.</p>' : '';

  switch (g.phase) {
    case 'reveal':
      return (inGame ? `<h2 class="reveal-player">${Kit.esc(names[me])}</h2><p class="reveal-warning">🤫 Que nadie más mire tu pantalla</p>${ctx.card}` +
          (g.ready[me] ? '<p class="screen-help">✅ Listo. Esperando a los demás…</p>'
            : `<button type="button" class="btn btn-secondary btn-large" ${actAttr({ t: 'ready' })}>Ya lo vi</button>`) : spectator) +
        `<p class="sala-count">Listos <strong>${count(g.ready)}</strong> de ${g.players.length}</p>` +
        (host ? hostBtn({ t: 'night-start' }, 'Empezar la noche 🌙') : '');
    case 'night':
      return `<h2 class="screen-title">🌙 Noche ${g.day}</h2>` +
        (inGame ? nightPanel(g, me, names) : spectator) +
        `<p class="sala-count">Han actuado <strong>${count(g.night.acts)}</strong> de ${aliveList(g).length}</p>` +
        (host ? `<button type="button" class="btn btn-text" ${actAttr({ t: 'dawn' })}>Que amanezca ya</button>` : '');
    case 'dawn': {
      const seer = g.dawn.seer;
      const vision = inGame && seer && seer.i === me
        ? `<p class="screen-help">🔮 Anoche viste que <strong>${Kit.esc(names[seer.t])}</strong> ${seer.wolf ? 'es un lobo 🐺' : 'no es un lobo'}.</p>` : '';
      return `<h2 class="screen-title">☀️ Amanece · día ${g.day}</h2>${newsHtml(g, names)}${vision}${ghost}` +
        (host ? (g.winner ? hostBtn({ t: 'end' }, 'Ver el final') : hostBtn({ t: 'day' }, 'Empezar el día 🗣️')) : waitHost(ctx));
    }
    case 'day':
      return `<h2 class="screen-title">🗣️ Debate · día ${g.day}</h2><p class="screen-help">¿Quién es lobo? Hablad, acusad y defendeos.</p>${ghost}` +
        aliveChips(g, names) + ctx.timer + (host ? hostBtn({ t: 'to-vote' }, 'Votar 🗳️') : waitHost(ctx, `${ctx.hostName} abrirá la votación`));
    case 'vote':
      return '<h2 class="screen-title">¿A quién echa el pueblo?</h2>' +
        (alive ? '<p class="screen-help">Vota desde tu móvil. Cuando vote todo el mundo se hace el recuento.</p>' + voteButtons(g, me, names) : ghost || spectator) +
        `<p class="sala-count">🗳️ Han votado <strong>${count(g.votes)}</strong> de ${aliveList(g).length}</p>` +
        (host ? `<button type="button" class="btn btn-text" ${actAttr({ t: 'tally' })}>Hacer el recuento ya</button>` : '');
    case 'verdict':
      return verdictHtml(g, names) + voteSummary(g, names) +
        (host ? (g.winner ? hostBtn({ t: 'end' }, 'Ver el final') : hostBtn({ t: 'night-start' }, 'Llega la noche 🌙')) : waitHost(ctx));
    case 'end':
      return endHtml(g, names) + (host
        ? '<div class="results-actions"><button type="button" class="btn btn-primary btn-large" data-sala="again">Otra partida ▶</button>' +
          '<button type="button" class="btn btn-secondary btn-large" data-sala="lobby">Cambiar ajustes</button></div>'
        : waitHost(ctx, `Esperando a que ${ctx.hostName} empiece otra partida`));
    default:
      return '';
  }
}

Sala.configure({
  id: 'pueblo',
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  timerStep: TIMER_STEP,
  holdPrompt: 'Mantén pulsado para ver tu papel',
  who: { one: 'lobo', many: 'lobos', One: 'Lobo', Many: 'Lobos', the: 'el lobo', The: 'El lobo' },
  hosting: salaHosting,
  custom: {
    start: (n) => newGame(n, settings),
    act,
    render: salaRender,
    card: (g, i, names) => (i >= 0 && i < g.players.length ? roleCard(g, i, names) : null),
    phaseKey: (g) => `${g.phase}-${g.day}`,
    phaseFx: (g, me) => {
      if (g.phase !== 'end') return null;
      const mine = me >= 0 && me < g.players.length ? ROLES[roleOf(g, me)].team : 'pueblo';
      return mine === g.winner ? 'win' : 'lose';
    }
  }
});

/* --------------------------------- Eventos ----------------------------------- */

function bindEvents() {
  el.btnPlayerMinus.addEventListener('click', () => changePlayers(-1));
  el.btnPlayerPlus.addEventListener('click', () => changePlayers(1));
  el.btnWolfMinus.addEventListener('click', () => { settings.wolves -= 1; wolvesManual = true; saveSettings(); renderSetup(); });
  el.btnWolfPlus.addEventListener('click', () => { settings.wolves += 1; wolvesManual = true; saveSettings(); renderSetup(); });
  el.btnTimeMinus.addEventListener('click', () => { settings.timerMinutes = TIMER_OPTIONS[Math.max(0, TIMER_OPTIONS.indexOf(settings.timerMinutes) - 1)]; saveSettings(); renderSetup(); });
  el.btnTimePlus.addEventListener('click', () => { settings.timerMinutes = TIMER_OPTIONS[Math.min(TIMER_OPTIONS.length - 1, TIMER_OPTIONS.indexOf(settings.timerMinutes) + 1)]; saveSettings(); renderSetup(); });
  el.btnShuffleNames.addEventListener('click', () => { Kit.shuffleNames(el.namesGrid, settings.playerCount); Kit.toast('Orden mezclado 🔀'); });
  [['optSeer', 'seer'], ['optHealer', 'healer'], ['optReveal', 'reveal'], ['optSecretVote', 'secretVote']].forEach(([node, key]) => {
    el[node].addEventListener('change', () => { settings[key] = el[node].checked; saveSettings(); renderSetup(); });
  });
  Kit.bindPrefToggle(el.optSound, 'sound');
  Kit.bindPrefToggle(el.optVibrate, 'vibrate');

  el.btnStartGame.addEventListener('click', () => {
    saveSettings();
    try { history.pushState({ inGame: true }, ''); } catch (err) { /* sin historial */ }
    startLocalGame();
  });
  el.btnExit.addEventListener('click', () => {
    if (!game || window.confirm('¿Salir de la partida? Se perderá la partida en curso.')) backToSetup();
  });
  window.addEventListener('popstate', () => {
    if (!game) return;
    if (window.confirm('¿Salir de la partida? Se perderá la partida en curso.')) backToSetup();
    else { try { history.pushState({ inGame: true }, ''); } catch (err) { /* sin historial */ } }
  });
}

function init() {
  cacheDom();
  loadSettings();
  bindEvents();
  renderSetup();
  Kit.showScreen('setup');
}

document.addEventListener('DOMContentLoaded', init);
