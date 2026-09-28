// ============================================================
// SECTORS.JS — Cheese split timing (F1-style lap splits)
// Each split = time between cheese collections (and start/finish)
// ============================================================

const SPLIT_KEY = 'ratrace_splits_v1';

let splitTimes    = [];   // current run split times
let splitStarts   = [];   // race time when each split started
let currentSplit  = 0;
let totalCheese   = 0;
let personalBest  = [];   // best split times ever
let sessionBest   = [];   // best split times this session
let levelKey      = '';
let ghostSplitTimes = [];

// ── Init ──────────────────────────────────────────────────────
export function initSplits(lvlKey, cheeseCount) {
  levelKey     = lvlKey;
  totalCheese  = cheeseCount;
  currentSplit = 0;
  splitTimes   = new Array(cheeseCount + 1).fill(0);  // +1 for finish
  splitStarts  = new Array(cheeseCount + 1).fill(0);
  splitStarts[0] = 0; // starts at race start
  sessionBest  = new Array(cheeseCount + 1).fill(Infinity);
  loadPersonalBest(cheeseCount);
  renderSplitUI(cheeseCount);
  ghostSplitTimes = [];
}

export function resetSplits(lvlKey, cheeseCount) {
  levelKey     = lvlKey;
  totalCheese  = cheeseCount;
  currentSplit = 0;
  splitTimes   = new Array(cheeseCount + 1).fill(0);
  splitStarts  = new Array(cheeseCount + 1).fill(0);
  ghostSplitTimes = [];
  resetSplitDisplay();
}

// ── Personal best persistence ─────────────────────────────────
function splitStorageKey(lvl, count) { return `${SPLIT_KEY}_${lvl}_${count}`; }

function loadPersonalBest(count) {
  try {
    const raw = localStorage.getItem(splitStorageKey(levelKey, count));
    if (raw) {
      const parsed = JSON.parse(raw);
      personalBest = parsed.map(v => (!v || v === 0) ? Infinity : v);
    } else {
      personalBest = new Array(count + 1).fill(Infinity);
    }
  } catch { personalBest = new Array(count + 1).fill(Infinity); }
}

function savePersonalBest() {
  try { localStorage.setItem(splitStorageKey(levelKey, totalCheese), JSON.stringify(personalBest)); } catch {}
}

export function getSplitPersonalBest() { return personalBest; }

// ── Called every time a cheese is collected ───────────────────
export function onCheeseCollected(cheeseIdx, raceTime) {
  if (currentSplit !== cheeseIdx) return; // out of order, ignore
  completeSplit(cheeseIdx, raceTime);
  currentSplit++;
  splitStarts[currentSplit] = raceTime;
}

// ── Called when player crosses finish ─────────────────────────
export function onFinish(raceTime) {
  completeSplit(totalCheese, raceTime); // final split = last cheese → finish
  savePersonalBest();
}

function completeSplit(idx, raceTime) {
  const t = raceTime - splitStarts[idx];
  splitTimes[idx] = t;

  let color = 'yellow';
  if (t < personalBest[idx]) {
    personalBest[idx] = t;
    color = 'green';
  }
  if (leaderboardBest.length > idx && t < leaderboardBest[idx]) {
    leaderboardBest[idx] = t;
    color = 'purple';
  }
  if (t > personalBest[idx]) {
    color = 'yellow';
  }

  updateSplitBox(idx, t, color);
  if (ghostSplitTimes.length > idx && ghostSplitTimes[idx] !== null) {
    updateGhostComparison(idx, t);
  }
}

// ── UI ────────────────────────────────────────────────────────
function renderSplitUI(count) {
  const container = document.getElementById('splits');
  if (!container) return;
  container.innerHTML = '';
  container.style.display = window._splitsVisible !== false ? 'flex' : 'none';

  for (let i = 0; i <= count; i++) {
    const label = i < count ? `🧀${i + 1}` : '🏁';
    const box = document.createElement('div');
    box.className = 'split-box' + (i === 0 ? ' split-active' : '');
    box.id = `split-box-${i}`;
    box.innerHTML = `
      <span class="split-label">${label}</span>
      <span class="split-time" id="split-time-${i}">--.---</span>
      <span class="split-diff" id="split-diff-${i}"></span>
    `;
    container.appendChild(box);
  }
}

function updateSplitBox(idx, time, color) {
  const box     = document.getElementById(`split-box-${idx}`);
  const timeEl  = document.getElementById(`split-time-${idx}`);
  const diffEl  = document.getElementById(`split-diff-${idx}`);
  const nextBox = document.getElementById(`split-box-${idx + 1}`);
  if (!box || !timeEl) return;

  box.className   = `split-box split-${color}`;
  timeEl.textContent = time.toFixed(3);

  // Diff vs personal best
  const pb = personalBest[idx];
  if (color === 'purple') {
    diffEl.textContent = 'BEST';
    diffEl.style.color = '#9b30ff';
  } else if (pb !== Infinity) {
    const diff = time - pb;
    diffEl.textContent = (diff > 0 ? '+' : '') + diff.toFixed(3);
    diffEl.style.color = diff > 0 ? '#ffcc00' : '#00cc00';
  }

  // Flash
  box.style.transform = 'scale(1.1)';
  setTimeout(() => { box.style.transform = 'scale(1)'; }, 200);

  // Highlight next split as active
  if (nextBox) {
    nextBox.classList.remove('split-active');
    nextBox.classList.add('split-active');
  }
}

function resetSplitDisplay() {
  const container = document.getElementById('splits');
  if (!container) return;
  container.querySelectorAll('.split-box').forEach((box, i) => {
    box.className = 'split-box' + (i === 0 ? ' split-active' : '');
    const timeEl = box.querySelector('.split-time');
    const diffEl = box.querySelector('.split-diff');
    if (timeEl) timeEl.textContent = '--.---';
    if (diffEl) diffEl.textContent = '';
  });
}

// ── Ghost splits ──────────────────────────────────────────────
export function setGhostSplitTimes(times) {
  ghostSplitTimes = times || [];
  // Show ghost times in the ghost row
  const ghostRow = document.getElementById('ghostSplits');
  if (!ghostRow) return;
  ghostRow.innerHTML = '';
  ghostRow.style.display = ghostSplitTimes.length ? 'flex' : 'none';
  ghostSplitTimes.forEach((t, i) => {
    const label = i < ghostSplitTimes.length - 1 ? `G🧀${i+1}` : 'G🏁';
    const box = document.createElement('div');
    box.className = 'split-box';
    box.id = `ghost-split-box-${i}`;
    box.innerHTML = `
      <span class="split-label" style="color:#aef">${label}</span>
      <span class="split-time" id="ghost-split-time-${i}">${t !== null ? t.toFixed(3) : '--.---'}</span>
      <span class="split-diff" id="ghost-split-diff-${i}"></span>
    `;
    ghostRow.appendChild(box);
  });
}

function updateGhostComparison(idx, myTime) {
  const gt    = ghostSplitTimes[idx];
  const gbox  = document.getElementById(`ghost-split-box-${idx}`);
  const gdiff = document.getElementById(`ghost-split-diff-${idx}`);
  if (!gbox || gt === null || gt === undefined) return;
  const diff = gt - myTime; // positive = ghost slower
  if (diff > 0) {
    gbox.className = 'split-box split-yellow';
    gdiff.textContent = '+' + diff.toFixed(3);
    gdiff.style.color = '#ffcc00';
  } else {
    gbox.className = 'split-box split-purple';
    gdiff.textContent = diff.toFixed(3);
    gdiff.style.color = '#9b30ff';
  }
}
let leaderboardBest = [];

export async function loadLeaderboardBest(db, lvl, cheeseCount, DAILY_SEED, collection, query, where, orderBy, limit, getDocs) {
  try {
    const q = query(collection(db,'scores'), where('lvl','==',lvl), where('date','==',DAILY_SEED), orderBy('time'), limit(50));
    const snap = await getDocs(q);
    leaderboardBest = new Array(cheeseCount + 1).fill(Infinity);
    snap.forEach(d => {
      const splits = d.data().splits || [];
      splits.forEach((t, i) => {
        if (t !== null && t < leaderboardBest[i]) leaderboardBest[i] = t;
      });
    });
  } catch { leaderboardBest = []; }
}