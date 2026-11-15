// ============================================================
// MULTI.JS — real-time multiplayer over Firebase Realtime Database
//
// rooms/{code}
//   host, level, createdAt
//   race:   { match, round, seed, level, startAt }   ← single source of truth for a round
//   cheese: { rk, pid, name }                        ← claimed with a transaction
//   players/{pid}: { name, color, joinedAt, x, z, yaw, rk, finished, finishTime }
//
// `rk` ("match_round") tags per-round data, so nothing has to be reset between
// rounds and stale values from an earlier round are simply ignored.
// Every clock here is server time, so all players see the same start and timer.
// ============================================================

import {
  initEngine, startLoop, stopLoop, setMaze, setCheeses, removeCheese, cheeses, touchedCheese, atGate,
  setGateOpen, stepPlayer, makeRat, disposeRat, player, scene, minimapDots,
} from './engine.js';
import { generateMaze, braidMaze, multiCheeseCell, wrapAngle, escapeHtml, cleanName } from './core.js';
import {
  getDatabase, ref, get, set, update, remove, onValue, onDisconnect, runTransaction, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';

const COLORS = ['#ff4444', '#44aaff', '#ff44ff', '#ffaa00', '#00ffaa', '#ff8844', '#44ffff', '#ffff44', '#aa44ff', '#44ff44'];
const LEVELS = {
  easy:   { label: 'Easy',   cells: 7  },
  medium: { label: 'Medium', cells: 9  },
  hard:   { label: 'Hard',   cells: 11 },
};
const TOTAL_ROUNDS = 3;
const MAX_PLAYERS  = 10;
const COUNTDOWN_MS = 5000;    // lobby/results → GO
const GRACE_S      = 30;      // seconds the rest get after the first rat finishes
const SEND_MS      = 80;      // position broadcast interval
const SLOW_FACTOR  = 0.55;    // top speed while someone else holds the cheese
const NAME_KEY     = 'ratrace_username';

// ── State ────────────────────────────────────────────────────
let rtdb, serverOffset = 0, clockSynced = false, connected = false;
const me = { id: null, name: 'Anon', color: COLORS[0], joinedAt: 0 };
let room = null;              // room code while in a room
let hostId = null, level = 'easy';
let players = {};             // latest snapshot of rooms/{code}/players
let race = null, rk = '';     // current round and its tag
let cheeseRaw = null;         // latest rooms/{code}/cheese (may belong to an older round)
let myFinish = null;          // my finish time this round
let resultsShown = false, cheeseNotified = false, claiming = false, starting = false;
let points = {}, pointNames = {}, pointsMatch = 0;
let statusBase = '', lastStatus = '', lastTimer = '', lastCount = '';
let lastSend = 0;
const sent = { x: NaN, z: NaN, yaw: NaN };
const others = {};            // pid → { mesh, x, z, yaw, tx, tz, tyaw, dot }
let unsubs = [];
let handlers = {};            // lobby UI callbacks

const $ = (id) => document.getElementById(id);
const show = (id, on, mode = 'block') => { $(id).style.display = on ? mode : 'none'; };
const serverNow = () => Date.now() + serverOffset;
const roomRef   = (path = '') => ref(rtdb, `rooms/${room}${path}`);
const playerRef = () => roomRef(`/players/${me.id}`);
const present   = () => Object.entries(players).filter(([, p]) => p && p.name);
const cheeseOwner = () => (cheeseRaw && cheeseRaw.rk === rk ? cheeseRaw : null);
const raceClock = () => (serverNow() - race.startAt) / 1000;

export function initMultiFirebase(fbApp) {
  rtdb = getDatabase(fbApp);
  // Rough estimate until syncClock() has measured a proper one.
  onValue(ref(rtdb, '.info/serverTimeOffset'), (s) => { if (!clockSynced) serverOffset = s.val() || 0; });
  // On every (re)connect: re-arm the disconnect cleanup and restore our record,
  // which the server deleted if the connection had dropped.
  onValue(ref(rtdb, '.info/connected'), (s) => {
    connected = !!s.val();
    if (connected && room) register();
  });
  window.addEventListener('pagehide', () => leaveRoom());
}

function register() {
  onDisconnect(playerRef()).remove();
  return update(playerRef(), {
    name: me.name, color: me.color, joinedAt: me.joinedAt,
    x: round2(player.x), z: round2(player.z), yaw: round2(player.yaw),
    rk, finished: myFinish !== null, finishTime: myFinish || 0,
  });
}

/**
 * Measure the offset to server time with a few timed round trips, keeping the
 * fastest (least delayed) sample. Firebase's own estimate is taken once while
 * the page is still loading and can be off by far more than a race is won by.
 */
async function syncClock() {
  const probe = roomRef(`/sync/${me.id}`);
  let bestTrip = Infinity;
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    await set(probe, serverTimestamp());
    const t1 = Date.now();
    const stamp = (await get(probe)).val();
    if (typeof stamp === 'number' && t1 - t0 < bestTrip) {
      bestTrip = t1 - t0;
      serverOffset = stamp - (t0 + t1) / 2;
      clockSynced = true;
    }
  }
  remove(probe);
}

/** The room's host, falling back to the longest-present player if the host has left. */
function effectiveHost() {
  if (players[hostId]?.name) return hostId;
  const list = present().sort((a, b) => (a[1].joinedAt - b[1].joinedAt) || (a[0] < b[0] ? -1 : 1));
  return list.length ? list[0][0] : null;
}
const amHost = () => effectiveHost() === me.id;

// ── Name prompt ──────────────────────────────────────────────
function askName() {
  return new Promise((resolve) => {
    const input = $('nameModalInput');
    input.value = localStorage.getItem(NAME_KEY) || '';
    show('nameModal', true, 'flex');
    input.focus();
    const close = (name) => { show('nameModal', false); resolve(name); };
    const ok = () => {
      const name = cleanName(input.value);
      localStorage.setItem(NAME_KEY, name);
      close(name);
    };
    $('nameModalBtn').onclick = ok;
    $('nameModalCancel').onclick = () => close(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') ok(); else if (e.key === 'Escape') close(null); };
  });
}

// ── Rooms ────────────────────────────────────────────────────
function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[(Math.random() * chars.length) | 0];
  return code;
}
const hasPlayers = (data) => !!data && Object.values(data.players || {}).some(p => p && p.name);

/** @returns the room code, or null if the player cancelled. Throws Error with a readable message. */
export async function createRoom() {
  const name = await askName();
  if (!name) return null;
  let code = randomCode();
  for (let tries = 0; tries < 6 && hasPlayers((await get(ref(rtdb, `rooms/${code}`))).val()); tries++) code = randomCode();
  me.id = newId(); me.name = name; me.color = COLORS[0];
  room = code;
  await set(roomRef(), { host: me.id, level, createdAt: serverNow() });   // also clears any abandoned room
  await enter();
  return code;
}

export async function joinRoom(code) {
  code = code.toUpperCase();
  const name = await askName();
  if (!name) return null;
  const data = (await get(ref(rtdb, `rooms/${code}`))).val();
  if (!hasPlayers(data)) throw new Error('Room not found!');
  const list = Object.values(data.players).filter(p => p && p.name);
  if (list.length >= MAX_PLAYERS) throw new Error('Room is full!');
  if (data.race) throw new Error('That game has already started.');
  const used = list.map(p => p.color);
  me.id = newId(); me.name = name;
  me.color = COLORS.find(c => !used.includes(c)) || COLORS[list.length % COLORS.length];
  room = code;
  await enter();
  return code;
}
const newId = () => 'p_' + Math.random().toString(36).slice(2, 10);

async function enter() {
  await syncClock();
  me.joinedAt = serverNow();
  race = null; rk = ''; cheeseRaw = null; myFinish = null; players = {};
  points = {}; pointNames = {}; pointsMatch = 0;
  await register();
  unsubs = [
    onValue(roomRef('/host'),    (s) => { hostId = s.val(); onPlayers(); }),
    onValue(roomRef('/level'),   (s) => { if (s.val()) { level = s.val(); handlers.onLevel?.(level); } }),
    onValue(roomRef('/players'), (s) => { players = s.val() || {}; onPlayers(); }),
    onValue(roomRef('/cheese'),  (s) => { cheeseRaw = s.val(); applyCheese(); }),
    onValue(roomRef('/race'),    (s) => {
      const r = s.val();
      if (r && `${r.match}_${r.round}` !== rk) beginRound(r);
    }),
  ];
}

export function leaveRoom() {
  if (!room) return;
  unsubs.forEach(off => off()); unsubs = [];
  onDisconnect(playerRef()).cancel();
  // Last one out deletes the room; otherwise just remove ourselves.
  if (present().some(([pid]) => pid !== me.id)) remove(playerRef());
  else remove(roomRef());
  for (const pid of Object.keys(others)) dropOther(pid);
  minimapDots.length = 0;
  if (race) stopLoop();
  room = null; race = null; rk = ''; players = {}; cheeseRaw = null; starting = false;
  for (const id of ['mpHud', 'countdown', 'cheeseNotif', 'mpResultsModal']) show(id, false);
}

/** Lobby UI hooks: onPlayers(list, isHost), onLevel(level), onRaceStart(). */
export function setLobbyHandlers(h) { handlers = h; }

export function setRoomLevel(lvl) {
  if (room && amHost() && LEVELS[lvl]) update(roomRef(), { level: lvl });
}

/** Host only: start round 1 of a new match. */
export function startMatch() {
  return launch({ match: (race?.match || 0) + 1, round: 1, seed: (Math.random() * 2 ** 31) | 0, level });
}
function launch(next) {
  if (!room || !amHost() || starting) return Promise.resolve();
  starting = true;
  return update(roomRef(), { host: me.id, race: { ...next, startAt: serverNow() + COUNTDOWN_MS } })
    .finally(() => { starting = false; });
}

// ── Players ──────────────────────────────────────────────────
function onPlayers() {
  handlers.onPlayers?.(present().map(([pid, p]) => ({ pid, name: p.name, color: p.color, me: pid === me.id })), amHost());

  for (const [pid, p] of present()) {
    if (pid === me.id) continue;
    let o = others[pid];
    if (!o && race) {                                     // rats only exist once a race is on screen
      o = others[pid] = { mesh: makeRat({ tint: p.color, label: p.name }), x: p.x || 0, z: p.z || 0, yaw: p.yaw || 0,
                          dot: { x: 0, z: 0, color: p.color } };
      scene.add(o.mesh);
      minimapDots.push(o.dot);
    }
    if (o) { o.tx = p.x || 0; o.tz = p.z || 0; o.tyaw = p.yaw || 0; }
  }
  for (const pid of Object.keys(others)) if (!players[pid]?.name) dropOther(pid);

  if (race && !resultsShown && myFinish === null) {
    const first = finishers()[0];
    if (first && !statusBase.startsWith('🏁')) statusBase = `🏁 ${first.name} escaped the maze first!`;
  }
  if (resultsShown) renderResultsFooter();
}

function dropOther(pid) {
  const o = others[pid];
  disposeRat(o.mesh);
  const i = minimapDots.indexOf(o.dot);
  if (i !== -1) minimapDots.splice(i, 1);
  delete others[pid];
}

/** Players who have finished the current round, fastest first. */
function finishers() {
  return present()
    .filter(([, p]) => p.rk === rk && p.finished)
    .map(([pid, p]) => ({ pid, name: p.name, time: p.finishTime || 0 }))
    .sort((a, b) => a.time - b.time);
}

// ── Round ────────────────────────────────────────────────────
function beginRound(r) {
  race = r; rk = `${r.match}_${r.round}`;
  if (r.match !== pointsMatch) { points = {}; pointNames = {}; pointsMatch = r.match; }
  myFinish = null; resultsShown = false; cheeseNotified = false; claiming = false;
  statusBase = `Round ${r.round} of ${TOTAL_ROUNDS}`;
  lastTimer = lastCount = lastStatus = '';

  handlers.onRaceStart?.();
  initEngine($('gameScreen'));
  show('mpHud', true);
  show('mpResultsModal', false);
  show('cheeseNotif', false);

  // Everyone derives the identical maze from the shared seed.
  const cells = (LEVELS[r.level] || LEVELS.easy).cells, seed = (r.seed + r.round * 101) | 0;
  const maze = generateMaze(cells, cells, seed);
  braidMaze(maze, seed + 7, 0.08);
  setMaze(maze);
  const cheese = multiCheeseCell(maze);
  setCheeses(cheese ? [cheese] : []);
  setGateOpen(true);
  applyCheese();
  onPlayers();

  sent.x = NaN;
  update(playerRef(), { rk, finished: false, finishTime: 0, x: round2(player.x), z: round2(player.z), yaw: round2(player.yaw) });
  startLoop(fixedStep, frame);
}

function applyCheese() {
  const owner = cheeseOwner();
  if (!owner || !race) return;
  if (cheeses.length) removeCheese(0);
  if (cheeseNotified) return;
  cheeseNotified = true;
  const mine = owner.pid === me.id;
  $('cheeseNotif').innerHTML = `🧀 ${escapeHtml(mine ? 'You' : owner.name)} CUT THE CHEESE!<br><small>` +
    (mine ? 'Everyone else is slowed!' : 'You are slowed by the stank!') + '</small>';
  show('cheeseNotif', true);
  setTimeout(() => show('cheeseNotif', false), 4000);
}

function claimCheese() {
  claiming = true;
  const tag = rk, claim = { rk: tag, pid: me.id, name: me.name };
  // A transaction makes the server pick exactly one winner if two rats arrive together.
  runTransaction(roomRef('/cheese'), (cur) => (cur && cur.rk === tag ? undefined : claim))
    .catch(e => console.error('cheese claim failed', e))
    .finally(() => { claiming = false; });
}

function fixedStep(dt) {
  const live = serverNow() >= race.startAt;
  const owner = cheeseOwner();
  stepPlayer(dt, owner && owner.pid !== me.id ? SLOW_FACTOR : 1, !live);
  if (!live || myFinish !== null) return;

  if (!owner && !claiming && touchedCheese() !== -1) claimCheese();
  if (atGate()) {
    myFinish = raceClock();
    update(playerRef(), { rk, finished: true, finishTime: myFinish });
    const first = finishers().every(f => f.pid === me.id);
    statusBase = `🏁 You ${first ? 'escaped first' : 'finished'}! Time: ${myFinish.toFixed(2)}s`;
  }
}

function frame(dt) {
  const now = serverNow(), toStart = race.startAt - now;

  const count = toStart > 0 ? String(Math.ceil(toStart / 1000)) : toStart > -900 ? 'GO!' : '';
  if (count !== lastCount) { $('countdown').textContent = lastCount = count; show('countdown', !!count); }

  const clockNow = Math.max(0, -toStart / 1000);
  const timer = `⏱ ${(myFinish ?? clockNow).toFixed(2)}s`;
  if (timer !== lastTimer) $('mpTimer').textContent = lastTimer = timer;

  // Ease the other rats toward their latest reported positions.
  const k = 1 - Math.exp(-14 * dt);
  for (const o of Object.values(others)) {
    o.x += (o.tx - o.x) * k; o.z += (o.tz - o.z) * k; o.yaw += wrapAngle(o.tyaw - o.yaw) * k;
    o.mesh.position.set(o.x, 0, o.z); o.mesh.rotation.y = o.yaw;
    o.dot.x = o.x; o.dot.z = o.z;
  }

  if (now - lastSend >= SEND_MS) {
    const x = round2(player.x), z = round2(player.z), yaw = round2(player.yaw);
    if (x !== sent.x || z !== sent.z || yaw !== sent.yaw) {
      lastSend = now; sent.x = x; sent.z = z; sent.yaw = yaw;
      update(playerRef(), { x, z, yaw });
    }
  }

  // Round ends when everyone is home, or GRACE_S after the first finisher.
  let status = statusBase;
  if (!resultsShown && toStart <= 0) {
    const done = finishers(), all = present();
    if (all.length && done.length === all.length) showResults();
    else if (done.length) {
      const left = done[0].time + GRACE_S - clockNow;
      if (left <= 0) showResults();
      else status += `\nRound ends in ${Math.ceil(left)}s`;
    }
  }
  if (status !== lastStatus) $('mpStatus').textContent = lastStatus = status;
}

// ── Results ──────────────────────────────────────────────────
function showResults() {
  resultsShown = true;
  const owner = cheeseOwner();
  const done = finishers(), doneIds = new Set(done.map(f => f.pid));
  const dnf = present().filter(([pid]) => !doneIds.has(pid)).map(([pid, p]) => ({ pid, name: p.name }));
  const n = done.length + dnf.length, cheeseBonus = Math.ceil(n / 2);

  const award = (p, pts) => {
    p.pts = pts;
    p.cheese = !!owner && owner.pid === p.pid;
    points[p.pid] = (points[p.pid] || 0) + pts + (p.cheese ? cheeseBonus : 0);
    pointNames[p.pid] = p.name;
  };
  done.forEach((p, i) => award(p, n - i));
  dnf.forEach(p => award(p, 0));

  const final = race.round >= TOTAL_ROUNDS;
  const you = (pid) => (pid === me.id ? ' (you)' : '');
  const bonus = (p) => (p.cheese ? ` +${cheeseBonus}🧀` : '');
  let html = `<h2>${final ? '🏆 Final Results' : `Round ${race.round} Results`}</h2>` +
             `<p class="sub">${final ? 'Game over!' : `Round ${race.round} of ${TOTAL_ROUNDS}`}</p>` +
             '<p class="head">This round</p><table>';
  done.forEach((p, i) => {
    html += `<tr><td>${['🥇', '🥈', '🥉'][i] || `${i + 1}.`}</td><td>${escapeHtml(p.name)}${you(p.pid)}</td>` +
            `<td class="gold">${p.time.toFixed(2)}s</td><td class="mint">+${p.pts}pts${bonus(p)}</td></tr>`;
  });
  for (const p of dnf) {
    html += `<tr class="dnf"><td>DNF</td><td>${escapeHtml(p.name)}${you(p.pid)}</td><td></td>` +
            `<td class="mint">${p.cheese ? bonus(p) : '0pts'}</td></tr>`;
  }
  html += '</table><p class="head">Overall standings</p><table>';
  const standings = Object.entries(points).map(([pid, pts]) => ({ pid, pts, name: pointNames[pid] })).sort((a, b) => b.pts - a.pts);
  standings.forEach((p, i) => {
    html += `<tr${p.pid === me.id ? ' class="me"' : ''}><td>${i + 1}.</td><td>${escapeHtml(p.name)}${you(p.pid)}</td>` +
            `<td class="gold"><b>${p.pts} pts</b></td></tr>`;
  });
  html += '</table>';
  if (final && standings.length) {
    const tied = standings.filter(p => p.pts === standings[0].pts);
    html += `<p class="winner">🎉 ${tied.length > 1 ? `Tie: ${tied.map(p => escapeHtml(p.name)).join(' & ')}` : `${escapeHtml(standings[0].name)} wins`}!</p>`;
  }
  $('mpResultsList').innerHTML = html + '<div id="mpResultsFooter"></div>';
  show('mpResultsModal', true);
  renderResultsFooter();
}

/** Buttons under the results; redrawn when the host changes (e.g. the host left). */
function renderResultsFooter() {
  const foot = $('mpResultsFooter');
  if (!foot || !race) return;
  const final = race.round >= TOTAL_ROUNDS, host = amHost();
  foot.innerHTML =
    (host ? `<button id="mpNext" class="primary">${final ? '🔁 Rematch' : `▶ Start Round ${race.round + 1}`}</button>`
          : `<p class="sub">Waiting for the host to ${final ? 'start a rematch' : 'start the next round'}…</p>`) +
    '<button id="mpQuit">← Leave</button>';
  $('mpQuit').onclick = () => { leaveRoom(); window.showScreen('start'); };
  if (host) {
    $('mpNext').onclick = () => (final ? startMatch() : launch({ ...race, round: race.round + 1 }));
  }
}

const round2 = (x) => Math.round(x * 100) / 100;
