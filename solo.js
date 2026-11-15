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
  initSplits, resetSplits, markSplit, getRunSplits, setRival, setOverallBest, setSplitsVisible, pruneStorage,
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
let hudText = '', notice = '';
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
  const text = `🧀 ${collected}/${total}  |  ⏱ ${raceTime.toFixed(2)}s`;
  if (text !== hudText) $('hud').textContent = hudText = text;
}

function updateSideHud() {
  const lines = [];
  if (ghostOn) {
    lines.push(!ghost ? 'Ghost: no best yet'
      : `Ghost: ${ghost.time.toFixed(2)}s${ghost.name ? ` (${ghost.name})` : ''}`);
  }
  if (bot) lines.push(`🤖 Bot: ${bot.time.toFixed(2)}s`);
  if (notice) lines.push(notice);
  $('ghosthud').textContent = lines.join('\n');
  // The comparison row follows the bot when it is running, otherwise the ghost.
  if (bot) setRival('🤖', bot.splits);
  else if (ghostOn && ghost) setRival('👻', ghost.splits);
  else setRival('', null);
}

// ── Race lifecycle ───────────────────────────────────────────
function showPar() {
  $('level').textContent = `Level: ${LEVELS[levelKey].label}  ·  Par: ${par}s`;
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
  initSplits(`${TODAY}_${key}`, cheeseCells.length);
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
  resetSplits();
  ghostMesh.visible = false;
  show('win', false);
  updateHud();
  updateSideHud();
}

function finish() {
  finished = true;
  recordFrame();
  markSplit(raceTime);
  lastRun = { time: raceTime, frames: recording, splits: getRunSplits() };
  const newBest = !best || raceTime < best.time;
  if (newBest) {
    const wasOwnGhost = ghost === best;
    best = lastRun;
    saveBest(levelKey, best);
    if (wasOwnGhost) ghost = best;
  }
  updateSideHud();

  const L = LEVELS[levelKey];
  const lines = [
    `${L.label} &nbsp;·&nbsp; Time: ${raceTime.toFixed(2)}s &nbsp;·&nbsp; Par: ${par}s`,
    (newBest ? 'New best time! Ghost updated. ' : '') +
      (raceTime <= par ? 'You beat the par time!' : '⏱ Over par — try again!'),
  ];
  if (bot) {
    const gap = raceTime - bot.time;
    lines.push(gap <= 0 ? `🤖 You beat the bot by ${(-gap).toFixed(2)}s!` : `🤖 The bot was ${gap.toFixed(2)}s faster.`);
  }
  $('winMsg').innerHTML = `🏁 Finished!<br><span style="font-size:15px">${lines.join('<br>')}</span>`;
  $('nameInput').value = localStorage.getItem(NAME_KEY) || '';
  $('saveBtn').disabled = false;
  $('saveMsg').textContent = '';
  show('win', true);
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
        say('❌ Name already taken today — choose another.');
        $('saveBtn').disabled = false;
        return;
      }
    }
    localStorage.setItem(NAME_KEY, name);
    $('nameInput').value = name;
    say('Saving…');
    const result = await submitScore(name, run, lvl);
    say(result === 'saved' ? 'Saved! 🧀  Open the leaderboard to see standings.'
                           : 'Your earlier time today is still your best.');
  } catch (e) {
    console.error(e);
    say('❌ Could not save — check your connection.');
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
  list.innerHTML = `<p style="color:#9fe">${label} — today's top 10</p><ol>` + rows.map((s, i) =>
    `<li>${escapeHtml(s.name)} — ${s.time.toFixed(2)}s <button class="racebtn" data-i="${i}">Ghost Race</button></li>`
  ).join('') + '</ol>';
  list.querySelectorAll('.racebtn').forEach((btn) => {
    btn.onclick = () => {
      const s = rows[btn.dataset.i];
      if (lvl !== levelKey) setLevel(lvl);
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
  let html = '<p style="color:#9fe;margin-bottom:10px">This week — top 3 each day</p><table class="weekTable"><tr><td></td>';
  for (const d of days) html += `<th style="color:${d.today ? '#ffd35a' : '#9fe'}">${d.name}</th>`;
  html += '</tr>';
  ['🥇', '🥈', '🥉'].forEach((medal, rank) => {
    html += `<tr><td>${medal}</td>`;
    for (const d of days) {
      const e = d.rows[rank];
      html += '<td>' + (e ? `${escapeHtml(e.name)}<br><span style="color:#ffd35a;font-size:11px">${e.time.toFixed(2)}s</span>`
                          : '<span style="color:#555">—</span>') + '</td>';
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
  $('btn-bot').textContent = '⏳ Planning…';
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
// [id, key, label(), action]
const BUTTONS = [
  ['easy',    '1', () => 'Easy (1)',    () => setLevel('easy')],
  ['medium',  '2', () => 'Medium (2)',  () => setLevel('medium')],
  ['hard',    '3', () => 'Hard (3)',    () => setLevel('hard')],
  ['board',   'l', () => 'Leaderboard (L)', toggleBoard],
  ['follow',  'f', () => `Follow Cam (F): ${onOff(settings.followCam)}`, () => { settings.followCam = !settings.followCam; }],
  ['savecam', '',  () => (settings.camOffset ? '✅ Cam Saved' : 'Save Cam'),
                   () => { settings.camOffset = settings.camOffset ? null : currentCamOffset(); }],
  ['ghost',   'g', () => `Ghost (G): ${onOff(ghostOn)}`, () => { ghostOn = !ghostOn; if (!ghostOn) ghostMesh.visible = false; updateSideHud(); }],
  ['night',   'n', () => `Night (N): ${onOff(settings.night)}`, () => setNight(!settings.night)],
  ['minimap', 'm', () => `Minimap (M): ${onOff(settings.minimap)}`, () => setMinimap(!settings.minimap)],
  ['splits',  't', () => `Splits (T): ${onOff(splitsOn)}`, () => { splitsOn = !splitsOn; setSplitsVisible(splitsOn); }],
  ['bot',     'b', () => (botOn ? '🤖 Stop Bot (B)' : '🤖 Bot Race (B)'), toggleBot],
  ['menu',    '',  () => '🏠 Menu', () => window.showScreen('start')],
];

function syncButtons() {
  for (const [id, , label] of BUTTONS) {
    const b = $(`btn-${id}`);
    if (b) { b.textContent = label(); b.classList.toggle('active', id === levelKey); }
  }
}

function buildControls() {
  const ctrl = $('controls');
  ctrl.innerHTML = '';
  for (const [id, , , action] of BUTTONS) {
    const b = document.createElement('button');
    b.id = `btn-${id}`;
    b.onclick = () => { action(); syncButtons(); document.body.classList.remove('menu-open'); b.blur(); };
    ctrl.appendChild(b);
  }
  syncButtons();
}

function bindOnce() {
  $('boardClose').onclick = () => show('board', false);
  $('board').querySelectorAll('.lvlbtns button').forEach((b) => { b.onclick = () => renderBoard(b.dataset.lvl); });
  $('saveBtn').onclick = saveScore;
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
  pruneStorage([GHOST_PREFIX, 'ratrace_splits_'], `_${TODAY}_`);
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
    markSplit(raceTime);
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
export function startSolo(gameScreen) {
  initEngine(gameScreen);
  if (!built) { built = true; bindOnce(); }
  active = true;
  document.body.classList.add('solo');
  show('info', true);
  show('mpHud', false);
  buildControls();
  setSplitsVisible(splitsOn);
  setLevel(levelKey);
  startLoop(fixedStep, frame);
}

/** Hide everything solo-specific so another mode can use the scene. */
export function stopSolo() {
  if (!built) return;
  active = false;
  document.body.classList.remove('solo', 'menu-open');
  ghostMesh.visible = botMesh.visible = false;
  for (const id of ['info', 'win', 'board', 'gatehint']) show(id, false);
  setSplitsVisible(false);
  $('controls').innerHTML = '';
}
