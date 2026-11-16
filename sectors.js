// ============================================================
// SECTORS.JS — F1-style split timing (the rows of the timing tower)
//
// A run has one sector per cheese plus a final sector to the gate. Sector k is
// the time between your (k-1)th and kth pickup. Each sector is coloured against
// the same sector of your best finished run on this maze:
//   purple = also faster than anyone on today's leaderboard
//   green  = faster than your best run (or there is no best run yet)
//   yellow = slower than your best run
// Comparing against one real run (not a mix of best-ever sectors) means beating
// your best time always shows up as green somewhere.
// ============================================================

let count = 0;              // sectors in a run (cheeses + 1)
let current = 0;            // sector being driven
let lastMark = 0;           // race time when the current sector began
let run = [];               // this run's finished sector times
let reference = null;       // sector times of the best run, or null
let overallBest = [];       // best per sector across today's leaderboard

const el = (id) => document.getElementById(id);
const signed = (d) => (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toFixed(3);
const label = (i) => (i < count - 1 ? `S${i + 1}` : 'FIN');

/** Build the rows for a maze with `cheeseCount` cheeses. */
export function initSplits(cheeseCount) {
  count = cheeseCount + 1;
  overallBest = [];
  reference = null;
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<li id="split-${i}"><span class="swatch"></span><span class="lbl">${label(i)}</span>` +
            '<span class="time"></span><span class="delta"></span></li>';
  }
  if (el('splits')) el('splits').innerHTML = html;
  // The same sectors again as a strip of segments under the centre timer.
  let strip = '';
  for (let i = 0; i < count; i++) strip += `<span id="seg-${i}">${count <= 8 ? label(i) : ''}</span>`;
  if (el('qStrip')) el('qStrip').innerHTML = strip;
  resetSplits();
}

/** Start a new run on the same maze. */
export function resetSplits() {
  current = 0; lastMark = 0; run = [];
  for (let i = 0; i < count; i++) {
    const row = el(`split-${i}`);
    if (!row) continue;
    row.className = i === 0 ? 'active' : '';
    row.children[2].textContent = '0.000';
    row.children[3].textContent = '';
  }
  for (let i = 0; i < count; i++) if (el(`seg-${i}`)) el(`seg-${i}`).className = i === 0 ? 'active' : '';
}

/**
 * Close the current sector at `raceTime` (call on every cheese pickup and at the finish).
 * @returns {{label:string, time:number, delta:string, color:string}|null} what just happened, for the HUD
 */
export function markSplit(raceTime) {
  if (current >= count) return null;
  const idx = current++, t = raceTime - lastMark;
  lastMark = raceTime;
  run.push(t);

  const ref = reference ? reference[idx] : undefined;
  const overall = overallBest[idx] > 0 ? overallBest[idx] : Infinity;
  const faster = !(ref > 0) || t < ref + 0.0005;            // matching the best run to the millisecond counts
  const color = faster && t < overall && overall !== Infinity ? 'purple' : faster ? 'green' : 'yellow';

  const delta = color === 'purple' ? 'BEST' : ref > 0 ? signed(t - ref) : '';
  const row = el(`split-${idx}`);
  if (row) {
    row.className = `sec-${color}`;
    row.children[2].textContent = t.toFixed(3);
    row.children[3].textContent = delta;
    if (el(`split-${idx + 1}`)) el(`split-${idx + 1}`).className = 'active';
  }
  if (el(`seg-${idx}`)) el(`seg-${idx}`).className = `sec-${color}`;
  if (el(`seg-${idx + 1}`)) el(`seg-${idx + 1}`).className = 'active';
  return { label: label(idx), time: t, delta, color };
}

/** Sector times of the current run so far. */
export const getRunSplits = () => run.slice();

/** Sector times of the run to colour against (your best run), or null. */
export function setReference(splits) {
  reference = splits && splits.length === count ? splits : null;
}

/** Best sector times across the leaderboard, for purple sectors. */
export function setOverallBest(times) { overallBest = times || []; }

export function setSplitsVisible(on) {
  if (el('splits')) el('splits').style.display = on ? '' : 'none';
}
