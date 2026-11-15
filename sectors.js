// ============================================================
// SECTORS.JS — F1-style split timing
//
// A run has one sector per cheese plus a final sector to the gate. Sector k is
// the time between your (k-1)th and kth pickup, whichever cheeses those were.
//   purple = fastest sector on today's leaderboard
//   green  = your personal best for that sector
//   yellow = slower than your personal best
// The optional rival row (ghost or bot) shows their sector time and the running
// gap to them at each checkpoint.
// ============================================================

import { escapeHtml } from './core.js';

const KEY_PREFIX = 'ratrace_splits_v2_';

let storageKey = '';
let count = 0;              // sectors in a run (cheeses + 1)
let current = 0;            // sector being driven
let lastMark = 0;           // race time when the current sector began
let run = [];               // this run's finished sector times
let personalBest = [];      // best time per sector, persisted per maze
let overallBest = [];       // best per sector across today's leaderboard
let rival = null;           // { label, splits } being raced, if any
let visible = true;

const el = (id) => document.getElementById(id);
const fmt = (t) => t.toFixed(3);
const signed = (d) => (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toFixed(3);

// ── Setup ────────────────────────────────────────────────────
/** @param key unique per maze (e.g. `${dailySeed}_${level}`) so bests never leak between mazes. */
export function initSplits(key, cheeseCount) {
  storageKey = KEY_PREFIX + key;
  count = cheeseCount + 1;
  overallBest = [];
  rival = null;
  personalBest = new Array(count).fill(Infinity);
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    for (let i = 0; i < count; i++) if (saved[i] > 0) personalBest[i] = saved[i];
  } catch { /* corrupt or unavailable storage: start fresh */ }
  buildRows();
  resetSplits();
}

/** Start a new run on the same maze. */
export function resetSplits() {
  current = 0; lastMark = 0; run = [];
  for (let i = 0; i < count; i++) {
    const box = el(`split-${i}`);
    if (!box) continue;
    box.className = 'split-box' + (i === 0 ? ' split-active' : '');
    box.children[1].textContent = '--.---';
    box.children[2].textContent = '';
  }
  renderRival();
  if (el('splitLast')) el('splitLast').textContent = '';
}

/** Drop stored bests (and ghosts) from other days so localStorage can't fill up. */
export function pruneStorage(prefixes, keep) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (prefixes.some(p => k.startsWith(p)) && !k.includes(keep)) localStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
}

// ── Timing ───────────────────────────────────────────────────
/** Close the current sector at `raceTime` (call on every cheese pickup and at the finish). */
export function markSplit(raceTime) {
  if (current >= count) return;
  const idx = current++, t = raceTime - lastMark;
  lastMark = raceTime;
  run.push(t);

  const before = personalBest[idx];
  const overall = overallBest[idx] > 0 ? overallBest[idx] : Infinity;
  const color = t < before && t < overall && overall !== Infinity ? 'purple' : t < before ? 'green' : 'yellow';
  if (t < before) {
    personalBest[idx] = t;
    try { localStorage.setItem(storageKey, JSON.stringify(personalBest.map(v => (v === Infinity ? 0 : v)))); } catch { /* full */ }
  }

  const delta = before === Infinity ? '' : signed(t - before);
  const box = el(`split-${idx}`);
  if (box) {
    box.className = `split-box split-${color}`;
    box.children[1].textContent = fmt(t);
    box.children[2].textContent = color === 'purple' ? 'BEST' : delta;
    el(`split-${idx + 1}`)?.classList.add('split-active');
  }
  let summary = `${sectorLabel(idx)} ${fmt(t)}` + (delta ? `  ${delta}` : '');

  if (rival && rival.splits[idx] != null) {
    let rivalAt = 0;
    for (let i = 0; i <= idx; i++) rivalAt += rival.splits[i] || 0;
    const gap = raceTime - rivalAt;                        // negative = ahead of the rival
    const rbox = el(`rival-${idx}`);
    if (rbox) {
      rbox.className = 'split-box ' + (gap <= 0 ? 'split-green' : 'split-red');
      rbox.children[2].textContent = signed(gap);
    }
    summary += `  ·  ${rival.label} ${signed(gap)}`;
  }
  if (el('splitLast')) el('splitLast').textContent = summary;
}

/** Sector times of the current run so far. */
export const getRunSplits = () => run.slice();

/** Best sector times across the leaderboard, for purple sectors. */
export function setOverallBest(times) { overallBest = times || []; }

/** Race against someone's sector times (`null` clears the rival row). */
export function setRival(label, splits) {
  rival = splits && splits.length === count ? { label, splits } : null;
  renderRival();
}

export function setSplitsVisible(on) {
  visible = on;
  if (el('splits')) el('splits').style.display = on ? 'flex' : 'none';
}

// ── DOM ──────────────────────────────────────────────────────
const sectorLabel = (i) => (i < count - 1 ? `🧀${i + 1}` : '🏁');

function boxHtml(id, label, time) {
  return `<div class="split-box" id="${id}"><span class="split-label">${label}</span>` +
         `<span class="split-time">${time}</span><span class="split-diff"></span></div>`;
}

function buildRows() {
  const root = el('splits');
  if (!root) return;
  let mine = '';
  for (let i = 0; i < count; i++) mine += boxHtml(`split-${i}`, sectorLabel(i), '--.---');
  root.innerHTML = `<div class="split-row">${mine}</div><div class="split-row" id="rivalRow"></div><div id="splitLast"></div>`;
  root.style.display = visible ? 'flex' : 'none';
}

function renderRival() {
  const row = el('rivalRow');
  if (!row) return;
  let html = '';
  if (rival) for (let i = 0; i < count; i++) html += boxHtml(`rival-${i}`, i ? '' : escapeHtml(rival.label), fmt(rival.splits[i] || 0));
  row.innerHTML = html;
}
