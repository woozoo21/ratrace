// ============================================================
// SOLO.JS — daily solo mode: timed cheese runs, ghosts, bot, leaderboard
// ============================================================

import {
  initEngine, startLoop, setMaze, setCheeses, removeCheese, touchedCheese, atGate, setGateOpen,
  resetPlayer, stepPlayer, makeRat, setNight, setMinimap, currentCamOffset,
  scene, player, settings,
} from './engine.js';
import {
  dateSeed, generateMaze, soloCheeseCells, sampleRun, escapeHtml, cleanName,
} from './core.js';
import { planBotRun } from './bot.js';
import {
  initSplits, resetSplits, markSplit, getRunSplits, setReference, setOverallBest, setSplitsVisible,
} from './sectors.js';
import {
  getFirestore, doc, getDoc, setDoc, getDocs, collection, query, where, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

let db;
export function initSoloFirebase(fbApp) { db = getFirestore(fbApp); }

// ── Daily mazes ──────────────────────────────────────────────
const TODAY  = dateSeed();
const MONDAY = (() => { const d = new Date(); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return d; })();
const LEVELS = {
  easy:   { label: 'Easy',   par: 20, seed: TODAY,     cheese: 7,  spread: false },
  medium: { label: 'Medium', par: 35, seed: TODAY + 1, cheese: 14, spread: false },
  hard:   { label: 'Hard',   par: 55, seed: TODAY + 2, cheese: 14, spread: true  },
};
const MAZE_CELLS    = 6;
const GHOST_PREFIX  = 'ratrace_ghost_v2_';
const NAME_KEY      = 'ratrace_username';
const RECORD_EVERY  = 3;      // physics ticks between recorded frames (20 Hz)
const BOARD_TTL_MS  = 30000;
const PAR_FACTOR    = 1.5;    // par = the bot's time on today's maze × this, rounded up

// ── State ────────────────────────────────────────────────────
let active = false, built = false;
let levelKey = 'easy', maze = null, cheeseCells = [];
let collected = 0, total = 0, raceTime = 0, tick = 0, started = false, finished = false;
let recording = [], lastRun = null;
let best = null;              // my best run today on this level: { time, frames, splits }
let ghost = null;             // the run being raced: best, or a leaderboard entry { name, … }
let bot = null;               // planned bot run, when the bot is on
let ghostOn = true, splitsOn = true, botOn = false;
let ghostMesh = null, botMesh = null;
let hudText = '', cheeseText = '', notice = '';
let par = 0;                  // seconds; from the bot's run, or the level's fallback until that is planned
const botPlans = {};          // level → planned run (same maze all day)
const boards = {};            // level → { at, rows }
const sample = { x: 0, z: 0, yaw: 0 };

const $ = (id) => document.getElementById(id);
const show = (id, on, mode = 'block') => { $(id).style.display = on ? mode : 'none'; };
const round3 = (x) => Math.round(x * 1000) / 1000;

// ── Ghost storage ────────────────────────────────────────────
const ghostKey = (lvl) => `${GHOST_PREFIX}${TODAY}_${lvl}`;

function loadBest(lvl) {
  try {
    const data = JSON.parse(localStorage.getItem(ghostKey(lvl)));
    return data && data.frames ? { time: data.time, frames: data.frames, splits: data.splits || [] } : null;
  } catch { return null; }
}
function saveBest(lvl, run) {
  try { localStorage.setItem(ghostKey(lvl), JSON.stringify(run)); }
  catch (e) { console.warn('Could not save ghost', e); }
}

// ── HUD ──────────────────────────────────────────────────────
function updateHud() {
  const text = raceTime.toFixed(2);
  if (text !== hudText) $('timer').textContent = hudText = text;
  const cheese = `${collected}/${total}`;
  if (cheese !== cheeseText) $('cheeseCount').textContent = cheeseText = cheese;
}

/** Seconds behind (+) or ahead (−) of `run` at my last checkpoint, or null before the first one. */
function gapTo(run) {
  const mine = getRunSplits();
  if (!mine.length || !run.splits || run.splits.length !== total + 1) return null;
  let me = 0, them = 0;
  for (let i = 0; i < mine.length; i++) { me += mine[i]; them += run.splits[i]; }
  return me - them;
}

/** The rows under the sectors: who you are racing and how far apart you are. */
function updateSideHud() {
  const row = (name, run) => {
    const gap = gapTo(run);
    const cls = gap === null ? '' : gap <= 0 ? 'ahead' : 'behind';
    const txt = gap === null ? '' : (gap <= 0 ? '−' : '+') + Math.abs(gap).toFixed(2);
    return `<div class="cmp"><span>${escapeHtml(name)}</span><span>${run.time.toFixed(2)} <b class="${cls}">${txt}</b></span></div>`;
  };
  let html = '';
  if (ghostOn) html += ghost ? row(ghost.name || 'Ghost', ghost) : '<div class="cmp"><span>Ghost</span><span>no best yet</span></div>';
  if (bot) html += row('Bot', bot);
  if (notice) html += `<div class="cmp note">${escapeHtml(notice)}</div>`;
  $('ghosthud').innerHTML = html;

  // Centre box: the one rival that matters right now (the bot if it is on, else the ghost) and the gap to it.
  const rival = bot || (ghostOn ? ghost : null);
  const rivalName = bot ? 'Bot' : rival ? (rival.name || 'Ghost') : 'Par';
  $('qRivalName').textContent = rivalName;
  $('qRivalTime').textContent = (rival ? rival.time : par).toFixed(2);
  show('qGap', !!rival, 'flex');
  if (rival) {
    const gap = gapTo(rival);
    $('qGapName').textContent = rivalName;
    $('qGapVal').textContent = gap === null ? '' : (gap <= 0 ? '−' : '+') + Math.abs(gap).toFixed(3);
    $('qGapVal').className = gap === null ? '' : gap <= 0 ? 'ahead' : 'behind';
  }
}

/** Show the sector just completed under the gap (e.g. "S3 1.067 +0.250"). */
function showLastSector(info) {
  $('qLast').textContent = info ? `${info.label} ${info.time.toFixed(3)} ${info.delta}` : '';
  $('qLast').className = info ? `sec-${info.color}` : '';
}

// ── Race lifecycle ───────────────────────────────────────────
function showPar() {
  $('level').textContent = `${LEVELS[levelKey].label} · Daily`;
  $('parLabel').textContent = `Par ${par}s`;
  $('qLevel').textContent = LEVELS[levelKey].label;
  updateSideHud();
}

/** The bot's run for today's maze on this level (planned once, then cached). */
function botPlan(key) {
  if (!(key in botPlans)) botPlans[key] = planBotRun(maze, cheeseCells, LEVELS[key].seed);
  return botPlans[key];
}

function setLevel(key) {
  const rival = key === levelKey && ghost && ghost.name ? ghost : null;   // keep a leaderboard ghost across restarts
  levelKey = key;
  const L = LEVELS[key];
  maze = generateMaze(MAZE_CELLS, MAZE_CELLS, L.seed);
  cheeseCells = soloCheeseCells(maze, L.seed, L.cheese, L.spread);
  setMaze(maze);
  par = L.par;
  showPar();
  setTimeout(() => {                                       // plan after the maze has painted
    const plan = levelKey === key && botPlan(key);
    if (plan) { par = Math.ceil(plan.time * PAR_FACTOR); showPar(); }
  }, 0);
  best = loadBest(key);
  ghost = rival || best;
  bot = botOn ? botPlan(key) : null;                       // the bot stays on across restarts and levels
  if (!rival) notice = '';
  initSplits(cheeseCells.length);
  show('board', false);
  restart();
  syncButtons();
  // Purple sectors need today's leaderboard; fetch it in the background.
  loadBoard(key).then(rows => { if (levelKey === key) setOverallBest(bestSectors(rows)); }).catch(() => {});
}

function restart() {
  setCheeses(cheeseCells);
  resetPlayer();
  collected = 0; total = cheeseCells.length; raceTime = 0; tick = 0;
  started = false; finished = false;
  recording = [{ t: 0, x: round3(player.x), z: round3(player.z), yaw: round3(player.yaw) }];
  setGateOpen(total === 0);
  setReference(best ? best.splits : null);                 // sectors are coloured against my best run
  resetSplits();
  showLastSector(null);
  ghostMesh.visible = false;
  show('win', false);
  updateHud();
  updateSideHud();
}

function finish() {
  finished = true;
  recordFrame();
  showLastSector(markSplit(raceTime));
  lastRun = { time: raceTime, frames: recording, splits: getRunSplits() };
  const rivalRun = ghostOn ? ghost : null;                 // who we were racing, before a new best replaces it
  const newBest = !best || raceTime < best.time;
  if (newBest) {
    const wasOwnGhost = ghost === best;
    best = lastRun;
    saveBest(levelKey, best);
    if (wasOwnGhost) ghost = best;
  }
  updateSideHud();

  // Result card: one line per thing you raced, with the margin.
  const line = (name, time, unit = '') => {
    const d = raceTime - time;
    return `<div class="cmp"><span>${escapeHtml(name)} ${unit ? time + unit : time.toFixed(2)}</span>` +
           `<b class="${d <= 0 ? 'ahead' : 'behind'}">${Math.abs(d).toFixed(2)} ${d <= 0 ? 'ahead' : 'behind'}</b></div>`;
  };
  let rows = line('Par', par, 's');
  if (bot) rows += line('Bot', bot.time);
  if (rivalRun) rows += line(rivalRun.name || 'Your best', rivalRun.time);
  if (newBest) rows += '<div class="cmp note">New best time. Ghost updated</div>';
  $('winTime').textContent = raceTime.toFixed(2);
  $('winRows').innerHTML = rows;
  $('nameInput').value = localStorage.getItem(NAME_KEY) || '';
  $('saveBtn').disabled = false;
  $('saveMsg').textContent = '';
  show('win', true, 'flex');
}

function recordFrame() {
  recording.push({ t: round3(raceTime), x: round3(player.x), z: round3(player.z), yaw: round3(player.yaw) });
}

// ── Leaderboard ──────────────────────────────────────────────
const scoreId = (lvl, name) => `${TODAY}_${lvl}_${name}`;

/** Today's top 10 for a level (cached briefly; each row carries its ghost frames). */
async function loadBoard(lvl, fresh = false) {
  const hit = boards[lvl];
  if (!fresh && hit && Date.now() - hit.at < BOARD_TTL_MS) return hit.rows;
  const snap = await getDocs(query(collection(db, 'scores'),
    where('lvl', '==', lvl), where('date', '==', TODAY), orderBy('time'), limit(10)));
  const rows = snap.docs.map(d => d.data());
  boards[lvl] = { at: Date.now(), rows };
  return rows;
}

function bestSectors(rows) {
  const out = [];
  for (const row of rows) (row.splits || []).forEach((t, i) => { if (t > 0 && !(t >= out[i])) out[i] = t; });
  return out;
}

/** @returns 'saved' | 'kept' (an equal or better time was already on the board) */
async function submitScore(name, run, lvl) {
  const ref = doc(db, 'scores', scoreId(lvl, name));
  const existing = await getDoc(ref);
  if (existing.exists() && existing.data().time <= run.time) return 'kept';
  const frames = run.frames.filter((_, i) => i % 2 === 0 || i === run.frames.length - 1);
  await setDoc(ref, { name, time: run.time, lvl, date: TODAY, frames, splits: run.splits });
  delete boards[lvl];
  return 'saved';
}

async function saveScore() {
  const run = lastRun, lvl = levelKey;
  if (!run) return;
  const name = cleanName($('nameInput').value);
  const say = (msg) => { $('saveMsg').textContent = msg; };
  $('saveBtn').disabled = true;
  try {
    if (name !== localStorage.getItem(NAME_KEY)) {
      say('Checking name…');
      if ((await getDoc(doc(db, 'scores', scoreId(lvl, name)))).exists()) {
        say('❌ Name already taken today. Choose another.');
        $('saveBtn').disabled = false;
        return;
      }
    }
    localStorage.setItem(NAME_KEY, name);
    $('nameInput').value = name;
    say('Saving…');
    const result = await submitScore(name, run, lvl);
    say(result === 'saved' ? 'Saved. Open the leaderboard to see standings.'
                           : 'Your earlier time today is still your best.');
  } catch (e) {
    console.error(e);
    say('❌ Could not save. Check your connection.');
    $('saveBtn').disabled = false;
  }
}

async function renderBoard(view) {
  const list = $('boardList');
  list.innerHTML = '<p style="color:#aaa">Loading…</p>';
  try {
    if (view === 'weekly') list.innerHTML = await weeklyHtml();
    else renderDaily(list, view, await loadBoard(view, true));
  } catch (e) {
    console.error(e);
    list.innerHTML = '<p style="color:#f66">Could not load the leaderboard.</p>';
  }
}

function renderDaily(list, lvl, rows) {
  const label = LEVELS[lvl].label;
  if (!rows.length) { list.innerHTML = `<p>No times yet for <b>${label}</b> today. Be the first!</p>`; return; }
  list.innerHTML = `<p style="color:#9fe">${label}: today's top 10</p><ol>` + rows.map((s, i) =>
    `<li>${escapeHtml(s.name)} <span style="color:#2de0c0">${s.time.toFixed(2)}s</span> <button class="racebtn" data-i="${i}">Ghost Race</button></li>`
  ).join('') + '</ol>';
  list.querySelectorAll('.racebtn').forEach((btn) => {
    btn.onclick = () => {
      const s = rows[btn.dataset.i];
      if (!active) window.playSolo(lvl);                    // opened from the home menu
      else if (lvl !== levelKey) setLevel(lvl);
      ghost = { name: s.name, time: s.time, frames: s.frames || [], splits: s.splits || [] };
      ghostOn = true;
      notice = `Racing ${s.name}'s ghost`;
      show('board', false);
      restart();
      syncButtons();
    };
  });
}

async function weeklyHtml() {
  const days = await Promise.all(Array.from({ length: 7 }, async (_, i) => {
    const d = new Date(MONDAY); d.setDate(MONDAY.getDate() + i);
    const seed = dateSeed(d);
    let rows = [];
    try {
      const snap = await getDocs(query(collection(db, 'scores'), where('date', '==', seed), orderBy('time'), limit(3)));
      rows = snap.docs.map(x => x.data());
    } catch (e) { console.error(e); }
    return { name: d.toLocaleDateString(undefined, { weekday: 'short' }), today: seed === TODAY, rows };
  }));
  let html = '<p style="color:#9fe;margin-bottom:10px">This week: top 3 each day</p><table class="weekTable"><tr><td></td>';
  for (const d of days) html += `<th style="color:${d.today ? '#2de0c0' : '#9fe'}">${d.name}</th>`;
  html += '</tr>';
  ['🥇', '🥈', '🥉'].forEach((medal, rank) => {
    html += `<tr><td>${medal}</td>`;
    for (const d of days) {
      const e = d.rows[rank];
      html += '<td>' + (e ? `${escapeHtml(e.name)}<br><span style="color:#2de0c0;font-size:11px">${e.time.toFixed(2)}s</span>`
                          : '<span style="color:#555">·</span>') + '</td>';
    }
    html += '</tr>';
  });
  return html + '</table>';
}

function toggleBoard() {
  const open = $('board').style.display === 'block';
  show('board', !open);
  if (!open) renderBoard(levelKey);
}

// ── Bot ──────────────────────────────────────────────────────
function toggleBot() {
  if (botOn) { botOn = false; bot = null; botMesh.visible = false; restart(); syncButtons(); return; }
  botOn = true;
  $('btn-bot').firstChild.textContent = 'Planning…';
  const key = levelKey;
  setTimeout(() => {                                       // let the label paint before the planner runs
    if (key !== levelKey) return;
    bot = botPlan(key);
    notice = bot ? '' : 'Bot could not solve this maze';
    restart();
    syncButtons();
  }, 30);
}

// ── Controls ─────────────────────────────────────────────────
const onOff = (v) => (v ? 'On' : 'Off');
// [id, key, label(), action, main] — `main` buttons sit on the bottom bar, the rest behind "More".
const BUTTONS = [
  ['easy',    '1', () => 'Easy',    () => setLevel('easy'),   true],
  ['medium',  '2', () => 'Medium',  () => setLevel('medium'), true],
  ['hard',    '3', () => 'Hard',    () => setLevel('hard'),   true],
  ['board',   'l', () => 'Leaderboard', toggleBoard, true],
  ['ghost',   'g', () => `Ghost ${onOff(ghostOn).toLowerCase()}`, () => { ghostOn = !ghostOn; if (!ghostOn) ghostMesh.visible = false; updateSideHud(); }, true],
  ['bot',     'b', () => `Bot ${onOff(botOn).toLowerCase()}`, toggleBot, true],
  ['follow',  'f', () => `Follow cam: ${onOff(settings.followCam)}`, () => { settings.followCam = !settings.followCam; }],
  ['savecam', '',  () => (settings.camOffset ? 'Camera saved' : 'Save camera'),
                   () => { settings.camOffset = settings.camOffset ? null : currentCamOffset(); }],
  ['night',   'n', () => `Night: ${onOff(settings.night)}`, () => setNight(!settings.night)],
  ['minimap', 'm', () => `Minimap: ${onOff(settings.minimap)}`, () => setMinimap(!settings.minimap)],
  ['splits',  't', () => `Sectors: ${onOff(splitsOn)}`, () => { splitsOn = !splitsOn; setSplitsVisible(splitsOn); }],
  ['menu',    '',  () => 'Main menu', () => window.showScreen('start')],
];

function syncButtons() {
  for (const [id, key, label] of BUTTONS) {
    const b = $(`btn-${id}`);
    if (!b) continue;
    b.textContent = label();
    if (key) {                                             // show the hotkey as a key cap on the button
      const cap = document.createElement('kbd');
      cap.textContent = key.toUpperCase();
      b.appendChild(cap);
      b.setAttribute('aria-keyshortcuts', key.toUpperCase());
    }
    b.classList.toggle('active', id === levelKey || (id === 'ghost' && ghostOn) || (id === 'bot' && botOn));
  }
}

function buildControls() {
  $('barMain').innerHTML = $('controls').innerHTML = '';
  for (const [id, , , action, main] of BUTTONS) {
    const b = document.createElement('button');
    b.id = `btn-${id}`;
    b.onclick = () => { action(); syncButtons(); document.body.classList.remove('menu-open'); b.blur(); };
    $(main ? 'barMain' : 'controls').appendChild(b);
  }
  syncButtons();
}

function bindOnce() {
  $('boardClose').onclick = () => show('board', false);
  $('board').querySelectorAll('.lvlbtns button').forEach((b) => { b.onclick = () => renderBoard(b.dataset.lvl); });
  $('saveBtn').onclick = saveScore;
  $('againBtn').onclick = () => restart();
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveScore(); });
  window.addEventListener('keydown', (e) => {
    if (!active || e.repeat || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const hit = BUTTONS.find(b => b[1] && b[1] === e.key.toLowerCase());
    if (hit) { hit[3](); syncButtons(); }
  });
  ghostMesh = makeRat({ opacity: 0.35 });
  botMesh   = makeRat({ tint: '#ff4444' });
  ghostMesh.visible = botMesh.visible = false;
  scene.add(ghostMesh, botMesh);
  // Drop ghosts (and old split data) from other days so localStorage can't fill up.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k.startsWith('ratrace_splits_') || (k.startsWith(GHOST_PREFIX) && !k.includes(`_${TODAY}_`))) localStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
}

// ── Loop ─────────────────────────────────────────────────────
function fixedStep(dt) {
  stepPlayer(dt);
  if (!started && Math.abs(player.speed) > 0.5) started = true;
  if (!started || finished) return;

  raceTime += dt;
  if (++tick % RECORD_EVERY === 0) recordFrame();
  for (let i; (i = touchedCheese()) !== -1;) {
    removeCheese(i);
    collected++;
    showLastSector(markSplit(raceTime));
    updateSideHud();
    if (collected >= total) setGateOpen(true);
  }
  if (collected >= total && atGate()) finish();
}

function place(mesh, frames, t) {
  mesh.visible = sampleRun(frames, t, sample);
  if (mesh.visible) { mesh.position.set(sample.x, 0, sample.z); mesh.rotation.y = sample.yaw; }
}

function frame() {
  if (ghostOn && ghost && started && !finished) place(ghostMesh, ghost.frames, raceTime);
  else ghostMesh.visible = false;
  if (bot) place(botMesh, bot.frames, raceTime);
  else botMesh.visible = false;

  show('gatehint', collected < total && !finished && atGate());
  updateHud();
}

// ── Entry points ─────────────────────────────────────────────
/** Settings the home menu can change before a run starts. */
export const soloPrefs = {
  get ghost() { return ghostOn; },   set ghost(v) { ghostOn = !!v; },
  get splits() { return splitsOn; }, set splits(v) { splitsOn = !!v; },
};

/** Today's fastest run for the home screen: { name, time, level } from the first level with a time, or null. */
export async function topRunToday() {
  for (const lvl of Object.keys(LEVELS)) {
    const rows = await loadBoard(lvl);
    if (rows.length) return { name: rows[0].name, time: rows[0].time, level: LEVELS[lvl].label };
  }
  return null;
}

/** Open the leaderboard without a run in progress (home menu). The engine must already be up. */
export function openBoard(lvl = levelKey) {
  if (!built) { built = true; bindOnce(); }
  show('board', true);
  renderBoard(lvl);
}

export function startSolo(gameScreen, level = levelKey) {
  initEngine(gameScreen);
  if (!built) { built = true; bindOnce(); }
  active = true;
  document.body.classList.add('solo');
  show('info', true);
  show('centerHud', true, 'flex');
  show('mpHud', false);
  buildControls();
  setSplitsVisible(splitsOn);
  setLevel(level);
  startLoop(fixedStep, frame);
}

/** Hide everything solo-specific so another mode can use the scene. */
export function stopSolo() {
  if (!built) return;
  active = false;
  document.body.classList.remove('solo', 'menu-open');
  ghostMesh.visible = botMesh.visible = false;
  for (const id of ['info', 'centerHud', 'win', 'board', 'gatehint']) show(id, false);
  setSplitsVisible(false);
  $('barMain').innerHTML = $('controls').innerHTML = '';
}
