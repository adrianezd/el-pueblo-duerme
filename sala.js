'use strict';

/* =========================================================================
   Sala — jugar cada uno con su móvil, entrando con un código de sala.
   Es el mismo archivo en los tres juegos de fiesta (¿Quién es el Impostor?,
   Dibujo Impostor y El Dato Falso). Cada juego le pasa sus reglas con
   Sala.configure({...}) desde su script.js; usa las piezas de kit.js.

   - En los ajustes hay dos pestañas: «Mismo móvil» (lo de siempre) y
     «Con código de sala».
   - Quien crea la sala (el anfitrión) la configura con la pantalla de
     ajustes normal del juego (modo, categorías, impostores, tiempo…) y
     también juega. Los jugadores son los que entran con el código.
   - En cada ronda el anfitrión reparte con las reglas del juego y cada
     móvil enseña solo su carta. Se vota desde cada móvil y al revelar
     todos ven el resultado.

   Mensajes entre móviles: ntfy.sh (servicio gratuito, sin cuentas), un
   canal por sala. Se publican con cache=no: el servidor no los guarda,
   solo los reciben los móviles conectados. El anfitrión manda: guarda la
   partida entera y la reenvía a todos cuando cambia algo (y cada minuto,
   por si a alguien se le escapó un mensaje). Los demás solo envían
   «entro», «salgo» y su voto.

   Para que una recarga o un móvil que se duerme no saquen a nadie, la
   sesión (y en el anfitrión la sala) se guarda en sessionStorage, que se
   borra sola al cerrar la pestaña.
   ========================================================================= */

const Sala = (() => {
  const RELAY = 'https://ntfy.sh/';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_LEN = 5;
  let MIN_PLAYERS = 3;
  const NAME_KEY = 'party-sala-name-v1';
  const JOIN_RETRY_MS = 3000;
  const JOIN_TRIES = 5;
  const HEARTBEAT_MS = 60000;
  const BATCH_MS = 1200;
  const SILENCE_MS = 75000;    // el anfitrión reenvía cada minuto: más silencio que esto es raro       // cambios seguidos (votos, entradas) van en un solo envío
  const RING_LENGTH = 2 * Math.PI * 54;

  let G = null;                // reglas del juego
  let sessionKey = '';
  let modeKey = '';
  const ui = {};

  const S = {
    role: null,                // 'host' | 'guest' | null
    code: '', pid: '', name: '',
    es: null,
    room: null,                // anfitrión: la partida completa
    view: null,                // lo que se pinta (en el anfitrión, la propia sala)
    viewAt: 0, heardAt: 0,
    joined: false, joinTries: 0, joinTimer: null,
    sendTimer: null, beatTimer: null, tickTimer: null,
    lastHtml: '', lastPhase: ''
  };

  /* ------------------------------ utilidades ------------------------------ */

  const $ = (id) => document.getElementById(id);
  const esc = (s) => Kit.esc(s == null ? '' : s);
  function randId(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }
  const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
  const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16);
  const topic = (code) => `party-sala-${G.id}-${code}`;
  const isHost = () => S.role === 'host';

  function show(name) {
    Kit.showScreen(name);
    // la barra de partida del juego (con su «Salir») no sirve en la sala
    if (name === 'sala') { const bar = $('game-bar'); if (bar) bar.hidden = true; }
  }

  /* ------------------------------ sesión ------------------------------ */

  function saveSession() {
    try {
      if (!S.role) { sessionStorage.removeItem(sessionKey); return; }
      sessionStorage.setItem(sessionKey, JSON.stringify({
        role: S.role, code: S.code, pid: S.pid, name: S.name, room: isHost() ? S.room : null
      }));
    } catch (err) { /* sin almacenamiento: la sala sigue, pero no sobrevive a una recarga */ }
  }
  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(sessionKey) || 'null'); } catch (err) { return null; }
  }

  /* ------------------------------ red ------------------------------ */

  // si falla (sin red, o el servicio pide calma: unos 12 envíos por minuto
  // y conexión), se reintenta a los 5 y a los 10 segundos
  function send(msg, tries = 2) {
    msg.f = S.pid;
    const code = S.code;
    const body = JSON.stringify(msg);
    return fetch(`${RELAY}${topic(code)}?cache=no&firebase=no`, { method: 'POST', body })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
      .catch(() => {
        if (tries <= 0 || S.code !== code || !S.role) { Kit.toast('📡 Sin conexión'); return undefined; }
        Kit.toast('📡 Sin conexión, reintentando…');
        return new Promise((ok) => setTimeout(ok, tries === 2 ? 5000 : 10000)).then(() => send(msg, tries - 1));
      });
  }
  function subscribe() {
    unsubscribe();
    const es = new EventSource(`${RELAY}${topic(S.code)}/sse`);
    S.es = es;
    es.onopen = () => {
      if (S.role === 'guest') sendJoin();
      else if (isHost()) broadcast(true);
    };
    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(JSON.parse(e.data).message); } catch (err) { return; }
      if (!msg || msg.f === S.pid) return; // los propios mensajes vuelven: se ignoran
      if (isHost()) hostHandle(msg);
      else if (S.role === 'guest') guestHandle(msg);
    };
  }
  function unsubscribe() {
    if (!S.es) return;
    S.es.onopen = null;
    S.es.onmessage = null;
    S.es.close();
    S.es = null;
  }

  /* ------------------------------ anfitrión ------------------------------ */

  function createRoom() {
    const name = readName();
    if (!name) return;
    S.role = 'host';
    S.code = randId(CODE_LEN);
    S.pid = S.pid || randId(10);
    S.name = name;
    S.room = {
      rid: randId(8), seq: 0, host: S.pid, players: [{ id: S.pid, n: name }],
      ph: 'lobby', rn: 0, order: [], names: [], cards: [], sp: [], info: null, round: null,
      first: 0, dir: 1, votes: {}, tm: null, res: null
    };
    S.view = S.room;
    subscribe();
    saveSession();
    enterHosting();
  }
  function uniqueName(n, id) {
    const taken = S.room.players.filter((p) => p.id !== id).map((p) => p.n.toLowerCase());
    let out = n;
    let k = 2;
    while (taken.includes(out.toLowerCase())) out = `${n} ${k++}`;
    return out;
  }
  function hostHandle(msg) {
    const r = S.room;
    if (msg.k === 'join') {
      const n = cleanName(msg.n) || 'Jugador';
      const p = r.players.find((x) => x.id === msg.f);
      if (p) {
        p.n = uniqueName(n, p.id);
      } else {
        if (r.players.length >= G.maxPlayers) { send({ k: 'full', to: msg.f }); return; }
        r.players.push({ id: msg.f, n: uniqueName(n, msg.f) });
        Kit.sfx.tap();
        Kit.toast(`👋 ${r.players[r.players.length - 1].n} ha entrado`);
      }
      playersChanged();
      broadcast(true);
    } else if (msg.k === 'leave') {
      r.players = r.players.filter((p) => p.id !== msg.f);
      playersChanged();
      broadcast();
    } else if (msg.k === 'act') {
      const i = r.order.indexOf(msg.f);
      if (r.ph === 'game' && i !== -1) applyAct(i, msg.a, false);
    } else if (msg.k === 'vote') {
      const i = r.order.indexOf(msg.f);
      const t = msg.t === 'none' ? 'none' : Number(msg.t);
      if (r.ph !== 'vote' || i === -1) return;
      if (t !== 'none' && (!(t >= 0 && t < r.order.length) || t === i)) return;
      if (t === 'none' && !r.round.allowNone) return;
      r.votes[msg.f] = t;
      broadcast();
    }
  }
  // el juego ajusta sus límites (impostores máximos…) al número de jugadores de la sala
  function playersChanged() {
    if (S.room.ph === 'lobby') G.hosting(true, S.room.players.length);
    renderRoomPanel();
  }

  const timerLeft = (t) => (!t ? 0 : t.run ? Math.max(0, t.left - (Date.now() - t.at) / 1000) : t.left);
  // copia para enviar: el cronómetro va como «lo que queda ahora»
  function snapshot() {
    const r = S.room;
    const out = Object.assign({}, r);
    if (r.tm) out.tm = { left: timerLeft(r.tm), run: r.tm.run && timerLeft(r.tm) > 0, total: r.tm.total };
    return out;
  }
  // now: enviar ya; si no, los cambios seguidos se agrupan en un solo envío
  function broadcast(now) {
    const r = S.room;
    r.seq += 1;
    S.view = r;
    saveSession();
    render();
    clearTimeout(S.sendTimer);
    const go = () => {
      if (!isHost()) return;
      const body = { k: 'state', s: snapshot() };
      if (JSON.stringify(body).length > 3900) console.warn('Sala: mensaje grande, puede no llegar entero');
      send(body);
    };
    if (now) go(); else S.sendTimer = setTimeout(go, BATCH_MS);
    clearInterval(S.beatTimer);
    S.beatTimer = setInterval(go, HEARTBEAT_MS);
  }

  // Juegos por fases (G.custom): el juego decide qué hace cada acción y la sala la reparte
  function applyAct(i, a, fromHost) {
    const r = S.room;
    const before = G.custom.phaseKey(r.g);
    const res = G.custom.act(r.g, i, a || {}, fromHost);
    if (!res) return;
    if ('timer' in res) r.tm = res.timer ? { left: res.timer, total: res.timer, run: true, at: Date.now() } : null;
    // al cambiar de fase se envía ya; las acciones sueltas (votos, listos…) se agrupan
    broadcast(G.custom.phaseKey(r.g) !== before || 'timer' in res);
  }

  function startRound() {
    const r = S.room;
    if (r.players.length < MIN_PLAYERS) { Kit.toast(`Hacen falta al menos ${MIN_PLAYERS} jugadores`); return; }
    const order = Kit.shuffled(r.players.map((p) => p.id));
    if (G.custom) {
      const g = G.custom.start(order.length);
      if (!g || g.error) { Kit.toast(g && g.error ? g.error : 'No se pudo empezar'); return; }
      r.rn += 1;
      r.order = order;
      r.names = order.map((id) => r.players.find((p) => p.id === id).n);
      r.g = g;
      r.tm = null;
      r.ph = 'game';
      Kit.keepAwake(true);
      show('sala');
      broadcast(true);
      return;
    }
    const dealt = G.deal(order.length);
    if (!dealt || dealt.error) { Kit.toast(dealt && dealt.error ? dealt.error : 'No se pudo repartir'); return; }
    r.rn += 1;
    r.order = order;
    r.names = order.map((id) => r.players.find((p) => p.id === id).n);
    r.cards = dealt.cards;
    r.sp = dealt.special;
    r.info = dealt.info || null;
    r.round = {
      title: dealt.title || '', help: dealt.help || '', voteTitle: dealt.voteTitle || '¿Quién es?',
      allowNone: Boolean(dealt.allowNone), noneLabel: dealt.noneLabel || 'Nadie',
      who: dealt.who || G.who
    };
    r.first = Math.floor(Math.random() * order.length);
    r.dir = Math.random() < 0.5 ? 1 : -1;
    r.votes = {};
    r.res = null;
    r.tm = dealt.seconds ? { left: dealt.seconds, total: dealt.seconds, run: true, at: Date.now() } : null;
    r.ph = 'play';
    Kit.keepAwake(true);
    show('sala');
    broadcast(true);
  }
  function toVote() {
    const r = S.room;
    if (r.tm) r.tm = { left: timerLeft(r.tm), total: r.tm.total, run: false, at: Date.now() };
    r.ph = 'vote';
    broadcast(true);
  }
  function toResults() {
    const r = S.room;
    r.ph = 'res';
    r.tm = null;
    r.res = verdict(r);
    if (G.onRoundEnd) G.onRoundEnd(r.info);
    broadcast(true);
  }
  function toLobby() {
    Object.assign(S.room, { ph: 'lobby', order: [], names: [], cards: [], sp: [], info: null, round: null, votes: {}, tm: null, res: null, g: null });
    broadcast(true);
    enterHosting();
  }
  function closeRoom() {
    const r = S.room;
    r.ph = 'closed';
    r.seq += 1;
    clearTimeout(S.sendTimer);
    send({ k: 'state', s: snapshot() }).then(() => leaveLocal());
  }
  function kick(id) {
    if (id === S.pid) return;
    S.room.players = S.room.players.filter((p) => p.id !== id);
    playersChanged();
    broadcast(true);
  }
  function toggleTimer() {
    const t = S.room.tm;
    if (!t || timerLeft(t) <= 0) return;
    S.room.tm = { left: timerLeft(t), total: t.total, run: !t.run, at: Date.now() };
    broadcast(true);
  }
  function addTime(d) {
    const t = S.room.tm;
    if (!t) return;
    S.room.tm = { left: Kit.clamp(timerLeft(t) + d, 0, 3600), total: Math.max(t.total, timerLeft(t) + d), run: t.run, at: Date.now() };
    broadcast();
  }

  // Veredicto con el mismo criterio que la votación del juego (Kit.tally)
  function verdict(r) {
    const n = r.order.length;
    const k = r.sp.length;
    const votes = new Array(n).fill(0);
    let none = 0;
    Object.keys(r.votes).forEach((pid) => {
      const t = r.votes[pid];
      if (t === 'none') none += 1; else if (t >= 0 && t < n) votes[t] += 1;
    });
    const t = Kit.tally({ votes, none }, Kit.clamp(k, 1, n));
    const caught = t.accused.filter((i) => r.sp.includes(i));
    let kind;
    if (k === 0) kind = t.noneWins ? 'none-hit' : 'none-miss';
    else if (k === n) kind = 'all';
    else if (t.noneWins) kind = 'none-wrong';
    else if (t.tie) kind = 'tie';
    else if (caught.length === k) kind = 'hit';
    else kind = t.accused.length ? 'innocent' : 'novote';
    return { votes, none, accused: t.accused, kind };
  }

  /* ------------------------------ invitado ------------------------------ */

  function joinRoom(code) {
    const name = readName();
    if (!name) return;
    code = cleanCode(code);
    if (code.length !== CODE_LEN) { setMsg(`El código tiene ${CODE_LEN} letras o números.`); return; }
    S.role = 'guest';
    S.code = code;
    S.pid = S.pid || randId(10); // al reconectar se conserva: así se recupera la misma carta
    S.name = name;
    S.view = null;
    S.joined = false;
    S.joinTries = 0;
    setMsg(`🔎 Buscando la sala ${code}…`);
    subscribe();
    saveSession();
  }
  function sendJoin() {
    clearTimeout(S.joinTimer);
    send({ k: 'join', n: S.name });
    if (S.joined) return;
    S.joinTries += 1;
    S.joinTimer = setTimeout(() => {
      if (S.joined || S.role !== 'guest') return;
      if (S.joinTries >= JOIN_TRIES) {
        const code = S.code;
        leaveLocal();
        setMsg(`No encontramos la sala ${code}. Revisa el código y que quien la creó siga con ella abierta.`);
        return;
      }
      sendJoin();
    }, JOIN_RETRY_MS);
  }
  function guestHandle(msg) {
    if (msg.k === 'full' && msg.to === S.pid) {
      leaveLocal();
      setMsg('La sala está llena.');
      return;
    }
    if (msg.k !== 'state' || !msg.s) return;
    const s = msg.s;
    const v = S.view;
    if (v && v.rid === s.rid && s.seq <= v.seq) return; // repetido o atrasado
    if (s.ph === 'closed') {
      if (S.joined) endAsGuest('😴', 'Sala cerrada', 'Quien creó la sala la ha cerrado.');
      return;
    }
    if (!s.players.some((p) => p.id === S.pid)) {
      // aún no nos ha añadido (es el aviso de otro que entra) o nos ha quitado
      if (S.joined) endAsGuest('🚪', 'Fuera de la sala', 'Te han quitado de la sala.');
      return;
    }
    S.view = s;
    S.viewAt = Date.now();
    S.heardAt = S.viewAt;
    if (!S.joined) {
      S.joined = true;
      clearTimeout(S.joinTimer);
      setMsg('');
      Kit.keepAwake(true);
      Kit.sfx.tap();
      show('sala');
    }
    render();
  }
  function endAsGuest(emoji, title, text) {
    leaveLocal(true);
    show('sala');
    ui.root.innerHTML = `<div class="center-wrap"><div class="verdict"><span class="verdict-emoji" aria-hidden="true">${emoji}</span>` +
      `<h2 class="verdict-title">${esc(title)}</h2><p class="verdict-text">${esc(text)}</p></div>` +
      '<button type="button" class="btn btn-primary btn-large" data-sala="back">Volver</button></div>';
    S.lastHtml = '';
    bindRoot();
  }
  function vote(t) {
    const v = S.view;
    if (!v || v.ph !== 'vote') return;
    Kit.sfx.tap();
    Kit.buzz(15);
    if (isHost()) { hostHandle({ k: 'vote', f: S.pid, t }); return; }
    S.view = Object.assign({}, v, { votes: Object.assign({}, v.votes, { [S.pid]: t }) });
    render();
    send({ k: 'vote', t });
  }

  /* ------------------------------ salir ------------------------------ */

  // stay: no volver a los ajustes (para enseñar un aviso en la pantalla de la sala)
  function leaveLocal(stay) {
    unsubscribe();
    clearTimeout(S.joinTimer);
    clearTimeout(S.sendTimer);
    clearInterval(S.beatTimer);
    const wasHost = isHost();
    S.role = null;
    S.room = null;
    S.view = null;
    S.joined = false;
    S.lastHtml = '';
    saveSession();
    Kit.keepAwake(false);
    if (wasHost) exitHosting();
    if (!stay) { show('setup'); setMode('sala'); }
  }
  function leave() {
    if (isHost()) {
      if (!window.confirm('¿Cerrar la sala? Todos saldrán de la partida.')) return;
      closeRoom();
      return;
    }
    if (S.role === 'guest') send({ k: 'leave' }, 0);
    leaveLocal();
  }

  /* ------------------------------ pintar ------------------------------ */

  function readName() {
    const n = cleanName(ui.name.value);
    if (!n) {
      setMsg('Escribe tu nombre para que los demás sepan quién eres.');
      ui.name.focus();
      return '';
    }
    Kit.save(NAME_KEY, n);
    return n;
  }
  function setMsg(text) { ui.msg.textContent = text || ''; }
  const nameAt = (v, i) => v.names[i] || 'Jugador';
  const myIndex = (v) => v.order.indexOf(S.pid);

  function playersHtml(v, canKick) {
    return '<ul class="sala-players">' + v.players.map((p) =>
      `<li><span class="sala-pname">${esc(p.n)}</span>` +
      (p.id === v.host ? '<span class="sala-tag">👑 Anfitrión</span>' : '') +
      (p.id === S.pid && p.id !== v.host ? '<span class="sala-tag">Tú</span>' : '') +
      (canKick && p.id !== S.pid ? `<button type="button" class="mini-btn" data-kick="${esc(p.id)}" aria-label="Quitar a ${esc(p.n)}">Quitar</button>` : '') +
      '</li>').join('') + '</ul>';
  }
  function codeHtml() {
    return `<p class="results-label">Código de la sala</p><p class="sala-code">${esc(S.code)}</p>`;
  }

  // Anfitrión en la sala de espera: la pantalla de ajustes del juego, con la sala arriba
  function renderRoomPanel() {
    if (!isHost() || !S.room) return;
    const r = S.room;
    const n = r.players.length;
    ui.roomPanel.innerHTML = `<div class="card sala-room-card">${codeHtml()}` +
      '<button type="button" class="mini-btn sala-share" data-sala="share">📤 Compartir enlace</button>' +
      `<h3 class="card-title">👥 Jugadores <span class="card-aside">${n} de ${G.maxPlayers}</span></h3>` +
      playersHtml(r, true) +
      (n < MIN_PLAYERS ? `<p class="setup-hint">Hacen falta al menos ${MIN_PLAYERS}. Pasad el código a los demás.</p>` : '') +
      '</div>';
    ui.startBtn.disabled = n < MIN_PLAYERS;
    bindNode(ui.roomPanel);
  }

  function guestLobbyHtml(v) {
    return '<div class="center-wrap sala-wrap">' +
      `<div class="card sala-room-card">${codeHtml()}` +
      `<h3 class="card-title">👥 Jugadores <span class="card-aside">${v.players.length}</span></h3>${playersHtml(v, false)}</div>` +
      `<p class="screen-help">⏳ Esperando a que <strong>${esc(v.players[0] ? v.players.find((p) => p.id === v.host).n : '')}</strong> empiece la ronda.</p>` +
      leaveBtn() + '</div>';
  }
  const leaveBtn = () => `<button type="button" class="btn btn-text" data-sala="leave">${isHost() ? 'Cerrar sala' : 'Salir de la sala'}</button>`;
  const hostName = (v) => { const p = v.players.find((x) => x.id === v.host); return p ? p.n : 'el anfitrión'; };

  function cardHtml() {
    return '<button type="button" id="sala-hold" class="hold-card">' +
      '<span class="hold-inner"><span class="hold-face hold-front">' +
      '<span class="hold-icon" aria-hidden="true">👆</span>' +
      `<span class="hold-prompt">${esc(G.holdPrompt)}</span><span class="hold-sub">Suelta para ocultarlo</span></span>` +
      '<span class="hold-face hold-back" id="sala-role"></span></span></button>';
  }
  function timerHtml(v) {
    if (!v.tm) return '';
    const host = isHost();
    return '<div class="timer-block"><div class="timer-ring"><svg viewBox="0 0 120 120" aria-hidden="true">' +
      '<circle class="ring-bg" cx="60" cy="60" r="54"/><circle class="ring-fg" id="sala-ring" cx="60" cy="60" r="54"/></svg>' +
      '<span class="timer-display" id="sala-timer" role="timer"></span></div>' +
      (host ? `<div class="timer-controls"><button type="button" class="btn btn-ghost" data-sala="t-">−${G.timerStep}s</button>` +
        `<button type="button" class="btn btn-ghost" data-sala="tgo">${v.tm.run ? 'Pausar' : 'Reanudar'}</button>` +
        `<button type="button" class="btn btn-ghost" data-sala="t+">+${G.timerStep}s</button></div>` : '') + '</div>';
  }
  const notInRound = () => '<p class="screen-help">⏳ Has entrado con la ronda empezada. Jugarás en la siguiente.</p>';

  function customHtml(v) {
    const me = myIndex(v);
    return '<div class="center-wrap sala-wrap">' +
      `<p class="sala-round">Partida ${v.rn} · Sala ${esc(S.code)}</p>` +
      G.custom.render({
        g: v.g, me, host: isHost(), names: v.names, esc, hostName: hostName(v),
        timer: timerHtml(v), card: cardHtml()
      }) + leaveBtn() + '</div>';
  }

  function playHtml(v) {
    const me = myIndex(v);
    const head = `<p class="sala-round">Ronda ${v.rn}${v.round.title ? ` · ${esc(v.round.title)}` : ''} · Sala ${esc(S.code)}</p>`;
    return '<div class="center-wrap sala-wrap">' + head +
      (me !== -1 ? `<h2 class="reveal-player">${esc(S.name)}</h2><p class="reveal-warning">🤫 Que nadie más mire tu pantalla</p>${cardHtml()}` : notInRound()) +
      '<div class="starter-card"><span class="starter-emoji" aria-hidden="true">🎲</span><div><p>Empieza</p>' +
      `<strong>${esc(nameAt(v, v.first))}</strong><p>${v.dir > 0 ? 'y seguid en el sentido de las agujas del reloj ↻' : 'y seguid en sentido contrario a las agujas del reloj ↺'}</p></div></div>` +
      (v.round.help ? `<p class="screen-help">${v.round.help}</p>` : '') +
      timerHtml(v) +
      (isHost() ? '<button type="button" class="btn btn-primary btn-large" data-sala="vote">Votar 🗳️</button>'
        : `<p class="setup-hint sala-center">${esc(hostName(v))} abrirá la votación.</p>`) +
      leaveBtn() + '</div>';
  }

  function voteHtml(v) {
    const me = myIndex(v);
    const mine = v.votes[S.pid];
    const voted = Object.keys(v.votes).length;
    let body;
    if (me === -1) {
      body = notInRound();
    } else {
      body = '<p class="screen-help">Vota desde tu móvil. Puedes cambiar el voto hasta que se revele.</p><div class="sala-votes">' +
        v.names.map((n, i) => (i === me ? '' : `<button type="button" class="sala-vote${mine === i ? ' is-selected' : ''}" data-vote="${i}">${esc(n)}</button>`)).join('') +
        (v.round.allowNone ? `<button type="button" class="sala-vote is-none${mine === 'none' ? ' is-selected' : ''}" data-vote="none">${esc(v.round.noneLabel)}</button>` : '') +
        '</div>';
    }
    return `<div class="center-wrap sala-wrap"><h2 class="screen-title">${esc(v.round.voteTitle)}</h2>${body}` +
      `<p class="sala-count">🗳️ Han votado <strong>${voted}</strong> de ${v.order.length}</p>` +
      (isHost() ? `<button type="button" class="btn btn-primary btn-large" data-sala="reveal">Revelar ${esc(v.round.who.many)}</button>`
        : `<p class="setup-hint sala-center">${esc(hostName(v))} revelará el resultado.</p>`) +
      leaveBtn() + '</div>';
  }

  function verdictParts(v) {
    const w = v.round.who;
    const imps = v.sp.slice().sort((a, b) => a - b);
    const k = imps.length;
    const list = (ids) => ids.map((i) => `<strong>${esc(nameAt(v, i))}</strong>`).join(' y ');
    const one = k === 1;
    switch (v.res.kind) {
      case 'hit': return ['win', '🎉', `¡${one ? w.One : w.Many} descubierto${one ? '' : 's'}!`, `Bien jugado: ${list(imps)} no ${one ? 'pudo' : 'pudieron'} engañaros.`];
      case 'none-hit': return ['win', '😇', `¡No había ${w.one}!`, `Lo habéis clavado: esta ronda no había ningún ${w.one}.`];
      case 'none-miss': return ['lose', '😇', `No había ningún ${w.one}`, v.res.accused.length ? `Habéis acusado a ${list(v.res.accused)}… que era inocente.` : 'Y nadie se dio cuenta.'];
      case 'all': return ['lose', '🤯', `¡Todos erais ${w.many}!`, 'Y nadie se dio cuenta. Ronda para la historia.'];
      case 'none-wrong': return ['lose', '🙈', `¡Sí que había ${w.one}!`, `Votasteis que no había nadie, pero ${list(imps)} ${one ? `era ${w.the}` : `eran ${w.many}`}.`];
      case 'tie': return ['lose', '🤝', 'Empate en la votación', `No se expulsa a nadie y ${one ? `${w.the} se escapa` : `los ${w.many} se escapan`}.`];
      case 'innocent': {
        const inn = v.res.accused.filter((i) => !v.sp.includes(i));
        return ['lose', '😬', inn.length ? '¡Expulsasteis a un inocente!' : `${w.The} se ha librado`,
          (inn.length ? `${list(inn)} no ${inn.length > 1 ? 'eran' : 'era'} ${w.one}. ` : '') + `${list(imps)} se ${one ? 'libra' : 'libran'}.`];
      }
      default: return ['lose', '🤷', 'Nadie votó', `${list(imps)} ${one ? `era ${w.the}` : `eran ${w.many}`}.`];
    }
  }
  function resultsHtml(v) {
    const [type, emoji, title, text] = verdictParts(v);
    const ranked = v.res.votes.map((c, i) => ({ c, n: nameAt(v, i), sp: v.sp.includes(i) }))
      .filter((x) => x.c > 0).sort((a, b) => b.c - a.c);
    if (v.res.none) ranked.push({ c: v.res.none, n: v.round.noneLabel, sp: false });
    const votes = ranked.length ? 'Votos: ' + ranked.map((x) => `${x.n} ${x.c}`).join(' · ') : 'Nadie votó.';
    return '<div class="center-wrap sala-wrap">' +
      `<div class="verdict is-${type}"><span class="verdict-emoji" aria-hidden="true">${emoji}</span>` +
      `<h2 class="verdict-title">${esc(title)}</h2><p class="verdict-text">${text}</p></div>` +
      `<div class="card reveal-box">${G.resultsHtml(v.info, { names: v.names, special: v.sp, cards: v.cards, esc })}` +
      `<p class="vote-summary">${esc(votes)}</p></div>` +
      (isHost() ? '<div class="results-actions"><button type="button" class="btn btn-primary btn-large" data-sala="again">Siguiente ronda ▶</button>' +
        '<button type="button" class="btn btn-secondary btn-large" data-sala="lobby">Cambiar ajustes</button></div>'
        : `<p class="setup-hint sala-center">⏳ Esperando a que ${esc(hostName(v))} empiece otra ronda.</p>`) +
      leaveBtn() + '</div>';
  }

  function render() {
    const v = S.view;
    if (!v || !S.role) return;
    if (isHost()) renderRoomPanel();
    if (isHost() && v.ph === 'lobby') return; // el anfitrión espera en los ajustes
    const html = v.ph === 'lobby' ? guestLobbyHtml(v)
      : v.ph === 'game' ? customHtml(v)
      : v.ph === 'play' ? playHtml(v)
        : v.ph === 'vote' ? voteHtml(v)
          : v.ph === 'res' ? resultsHtml(v) : '';
    const phaseKey = v.ph === 'game' ? `game-${G.custom.phaseKey(v.g)}` : v.ph;
    if (phaseKey !== S.lastPhase && v.ph === 'game') {
      const fx = G.custom.phaseFx ? G.custom.phaseFx(v.g, myIndex(v)) : null;
      if (fx === 'win') { Kit.sfx.win(); Kit.confetti(); Kit.buzz([60, 40, 60]); }
      else if (fx === 'lose') { Kit.sfx.lose(); Kit.buzz(200); }
      else { Kit.sfx.reveal(); Kit.buzz(30); }
      S.lastPhase = phaseKey;
    }
    if (v.ph !== S.lastPhase && v.ph !== 'game') {
      // efectos al cambiar de fase
      if (v.ph === 'play') { Kit.sfx.reveal(); Kit.buzz(40); }
      if (v.ph === 'res') {
        const win = v.res && /hit/.test(v.res.kind);
        if (win) { Kit.sfx.win(); Kit.confetti(); } else { Kit.sfx.lose(); }
        Kit.buzz(win ? [60, 40, 60] : 200);
      }
      S.lastPhase = v.ph;
    }
    // solo se repinta si cambia algo: así no se corta a quien tiene pulsada su carta
    if (html === S.lastHtml) return;
    S.lastHtml = html;
    if (!isHost() || v.ph !== 'lobby') { if (document.body.dataset.screen !== 'sala') show('sala'); }
    ui.root.innerHTML = html;
    bindRoot();
    tick();
  }

  /* ------------------------------ eventos ------------------------------ */

  function bindNode(node) {
    node.querySelectorAll('[data-sala]').forEach((b) => { b.onclick = () => action(b.dataset.sala); });
    node.querySelectorAll('[data-kick]').forEach((b) => {
      b.onclick = () => {
        const p = S.room && S.room.players.find((x) => x.id === b.dataset.kick);
        if (p && window.confirm(`¿Quitar a ${p.n} de la sala?`)) kick(p.id);
      };
    });
    node.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        let a;
        try { a = JSON.parse(b.dataset.act); } catch (err) { return; }
        Kit.sfx.tap();
        Kit.buzz(15);
        if (isHost()) { applyAct(myIndex(S.room), a, true); return; }
        b.classList.add('is-sent');
        send({ k: 'act', a });
      };
    });
    node.querySelectorAll('[data-vote]').forEach((b) => {
      b.onclick = () => vote(b.dataset.vote === 'none' ? 'none' : Number(b.dataset.vote));
    });
  }
  function bindRoot() {
    bindNode(ui.root);
    const hold = $('sala-hold');
    if (!hold) return;
    const back = $('sala-role');
    Kit.bindHold(hold, () => {
      const v = S.view;
      const card = v && (v.ph === 'game' ? G.custom.card(v.g, myIndex(v), v.names) : v.cards[myIndex(v)]);
      if (!card) return;
      back.classList.toggle('is-alert', Boolean(card.alert));
      back.innerHTML = `<span class="role-category-label">${esc(card.label || '')}</span>` +
        `<span class="role-emoji" aria-hidden="true">${esc(card.emoji || '')}</span>` +
        `<span class="${G.contentClass}${card.impostor ? ' is-impostor' : ''}">${esc(card.content || '')}</span>` +
        `<span class="${G.extraClass}">${card.extra || ''}</span>`;
      hold.classList.add('is-held');
      Kit.buzz(20);
    }, () => {
      hold.classList.remove('is-held');
      // se vacía tras la animación de giro para no mostrar nada al soltar
      setTimeout(() => { if (!hold.classList.contains('is-held')) back.innerHTML = ''; }, 300);
    });
  }
  function action(a) {
    if (a === 'back') { show('setup'); setMode('sala'); return; }
    if (a === 'leave') { leave(); return; }
    if (a === 'share') { share(); return; }
    if (!isHost()) return;
    Kit.sfx.tap();
    if (a === 'start' || a === 'again') startRound();
    else if (a === 'vote') toVote();
    else if (a === 'reveal') toResults();
    else if (a === 'lobby') toLobby();
    else if (a === 'tgo') toggleTimer();
    else if (a === 't-') addTime(-G.timerStep);
    else if (a === 't+') addTime(G.timerStep);
  }
  function share() {
    const url = `${location.origin}${location.pathname}?sala=${S.code}`;
    if (navigator.share) {
      navigator.share({ title: document.title, text: `Entra en mi sala: ${S.code}`, url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => Kit.toast('🔗 Enlace copiado'), () => Kit.toast(url));
    } else {
      Kit.toast(url);
    }
  }

  // cronómetro: se pinta en todos los móviles (los invitados descuentan desde que llegó la sala)
  function tick() {
    // invitado sin noticias del anfitrión (se le escapó un mensaje): vuelve a pedir la sala
    if (S.role === 'guest' && S.joined && Date.now() - S.heardAt > SILENCE_MS) {
      S.heardAt = Date.now();
      sendJoin();
    }
    const v = S.view;
    const disp = $('sala-timer');
    if (!disp || !v || !v.tm || !S.role) return;
    const left = isHost() ? timerLeft(v.tm) : (v.tm.run ? Math.max(0, v.tm.left - (Date.now() - S.viewAt) / 1000) : v.tm.left);
    disp.textContent = Kit.formatTime(Math.ceil(left));
    disp.classList.toggle('is-finished', left <= 0);
    const ring = $('sala-ring');
    if (ring) {
      ring.style.strokeDasharray = String(RING_LENGTH);
      ring.style.strokeDashoffset = String(RING_LENGTH * (1 - left / Math.max(1, v.tm.total)));
    }
  }

  // al volver a la pestaña (el móvil se había dormido): reconectar y pedir la sala
  function onVisible() {
    if (document.hidden || !S.role) return;
    if (!S.es || S.es.readyState === 2) subscribe();
    else if (S.role === 'guest') sendJoin();
    else broadcast(true);
  }

  /* ------------------------------ montaje ------------------------------ */

  function setMode(m) {
    ui.tabs.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.body.classList.toggle('sala-join', m === 'sala' && !isHost());
    Kit.save(modeKey, m);
  }
  // el anfitrión configura con los ajustes del juego: se ocultan los de «mismo móvil»
  function enterHosting() {
    document.body.classList.add('sala-hosting');
    document.body.classList.remove('sala-join');
    G.hosting(true, S.room.players.length);
    renderRoomPanel();
    show('setup');
  }
  function exitHosting() {
    document.body.classList.remove('sala-hosting');
    G.hosting(false);
  }

  function mount() {
    const setup = document.querySelector('[data-screen="setup"]');
    const app = $('game-app');
    if (!setup || !app) return;

    ui.tabs = document.createElement('div');
    ui.tabs.className = 'sala-tabs';
    ui.tabs.setAttribute('role', 'tablist');
    ui.tabs.innerHTML = '<button type="button" role="tab" data-mode="local">📱 Mismo móvil</button>' +
      '<button type="button" role="tab" data-mode="sala">🔑 Con código de sala</button>';

    ui.join = document.createElement('div');
    ui.join.className = 'sala-join-panel';
    ui.join.innerHTML =
      '<div class="card"><h3 class="card-title">🔑 Cada uno con su móvil</h3>' +
      '<p class="setup-hint">Uno crea la sala, elige los ajustes y también juega. El resto entra con el código. Hace falta internet en todos los móviles.</p>' +
      '<label class="sala-label" for="sala-name">Tu nombre</label>' +
      '<input id="sala-name" class="text-input sala-input" maxlength="16" autocomplete="nickname" placeholder="Cómo te llamas">' +
      '<button type="button" class="btn btn-primary btn-large" id="sala-create">Crear sala</button>' +
      '<div class="sala-or"><span>o entra en una</span></div>' +
      '<label class="sala-label" for="sala-code">Código de sala</label>' +
      '<input id="sala-code" class="text-input sala-input sala-code-input" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE">' +
      '<button type="button" class="btn btn-secondary btn-large" id="sala-join">Unirse</button>' +
      '<p class="sala-msg" id="sala-msg" role="status"></p></div>';

    ui.roomPanel = document.createElement('div');
    ui.roomPanel.className = 'sala-room-panel';

    ui.startWrap = document.createElement('div');
    ui.startWrap.className = 'sala-start';
    ui.startWrap.innerHTML = '<button type="button" class="btn btn-primary btn-large btn-start" data-sala="start">Empezar ronda 🎲</button>' +
      '<button type="button" class="btn btn-text" data-sala="leave">Cerrar sala</button>';

    // lo que solo sirve en «mismo móvil»: número de jugadores, nombres, votación secreta, marcador y su botón
    [['#btn-player-minus', '.stepper-row'], ['#names-grid', 'details'], ['#opt-secret-vote', 'label'],
      ['#setup-scoreline'], ['#btn-start-game']].forEach(([sel, up]) => {
      const node = document.querySelector(sel);
      const target = node && (up ? node.closest(up) : node);
      if (target) target.classList.add('no-sala');
    });

    const title = setup.querySelector('.visually-hidden');
    setup.insertBefore(ui.tabs, title ? title.nextSibling : setup.firstChild);
    ui.tabs.after(ui.join, ui.roomPanel);
    setup.appendChild(ui.startWrap);
    ui.startBtn = ui.startWrap.querySelector('[data-sala="start"]');
    bindNode(ui.startWrap);

    const section = document.createElement('section');
    section.className = 'screen';
    section.dataset.screen = 'sala';
    section.hidden = true;
    section.innerHTML = '<div id="sala-root"></div>';
    app.appendChild(section);

    ui.root = $('sala-root');
    ui.name = $('sala-name');
    ui.code = $('sala-code');
    ui.msg = $('sala-msg');

    ui.tabs.querySelectorAll('button').forEach((b) => { b.onclick = () => { Kit.sfx.tap(); setMode(b.dataset.mode); }; });
    $('sala-create').onclick = createRoom;
    $('sala-join').onclick = () => joinRoom(ui.code.value);
    ui.code.addEventListener('input', () => { ui.code.value = cleanCode(ui.code.value); });
    ui.code.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(ui.code.value); });

    ui.name.value = Kit.load(NAME_KEY, '') || '';
    const fromLink = cleanCode(new URLSearchParams(location.search).get('sala'));
    if (fromLink) ui.code.value = fromLink;
    setMode(fromLink ? 'sala' : Kit.load(modeKey, 'local'));

    document.addEventListener('visibilitychange', onVisible);
    S.tickTimer = setInterval(tick, 500);
    // después de que el juego pinte sus ajustes: volver a la sala si se recargó la página
    setTimeout(restore, 0);
  }
  function restore() {
    const s = loadSession();
    if (!s || !s.role || !s.code) return;
    S.code = s.code;
    S.pid = s.pid;
    S.name = s.name;
    if (s.role === 'host' && s.room) {
      S.role = 'host';
      S.room = s.room;
      S.view = S.room;
      subscribe();
      if (S.room.ph === 'lobby') enterHosting();
      else { document.body.classList.add('sala-hosting'); show('sala'); render(); }
    } else if (s.role === 'guest') {
      ui.name.value = s.name;
      setMode('sala');
      joinRoom(s.code);
    }
  }

  return {
    /**
     * Reglas del juego:
     *  id, maxPlayers, who: { one, many, One, Many, the, The } (impostor/es…),
     *  holdPrompt, contentClass, extraClass, timerStep,
     *  hosting(on, players): el juego pinta sus ajustes para la sala (o vuelve a los suyos),
     *  deal(n): reparte con los ajustes actuales → { cards[], special[], info, title, help,
     *           seconds, voteTitle, allowNone, noneLabel, who } o { error },
     *  resultsHtml(info, { names, special, cards, esc }): lo que se revela,
     *  onRoundEnd(info): opcional.
     *  custom: juego por fases en vez de carta + votación (El pueblo duerme):
     *    { start(n) → estado, act(estado, jugador, acción, esAnfitrión) → null | { timer? },
     *      render({ g, me, host, names, esc, hostName, timer, card }) → html (botones con data-act),
     *      card(estado, jugador, names) → carta, phaseKey(estado), phaseFx(estado, jugador) }
     */
    configure(game) {
      G = Object.assign({ maxPlayers: 15, minPlayers: 3, timerStep: 30, contentClass: 'role-content', extraClass: 'role-extra' }, game);
      MIN_PLAYERS = G.minPlayers;
      sessionKey = `party-sala-session-${G.id}`;
      modeKey = `party-sala-mode-${G.id}`;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
      else mount();
    },
    isHosting: () => isHost()
  };
})();
