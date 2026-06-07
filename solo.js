// ============================================================
// SOLO.JS — daily solo game logic
// ============================================================

import * as THREE from 'three';
import {
  initEngine, onCheeseTemplateLoaded,
  renderer, scene, camera, orbitControls, skybox,
  rat, ghostRat, cheeses, cheeseTemplate, cheeseGeo, cheeseMat, cheeseMats,
  startPos, finishPos, finishGate,
  GW, GH, grid,
  speed, yaw, lastRat, clock, accumulator,
  nightMode, followCam, savedCamOffset, minimapOn,
  setSpeed, setYaw, setAccumulator, setNightMode, setFollowCam, setSavedCamOffset, setMinimapOn,
  FIXED_DT, CHEESE_GLOW, CELL, WALL_H,
  makeRNG, toWorldX, toWorldZ, toCol, toRow,
  generateMaze, placeCheeseAt, clearCheeses,
  drawMinimap, updateLighting, updateCamera, physicsTick, animateCheeses,
  ACCEL, FRICTION, TURN_RATE, MAX_SPEED,
} from './engine.js';
import { getFirestore, doc, getDoc, setDoc, getDocs, collection, query, where, orderBy, limit } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// ── Firebase ─────────────────────────────────────────────────
let db;
export function initSoloFirebase(fbApp) { db = getFirestore(fbApp); }

// ── Seeds ────────────────────────────────────────────────────
const now = new Date();
export const DAILY_SEED  = now.getFullYear() * 10000 + (now.getMonth()+1)*100 + now.getDate();
const dayOfWeek          = now.getDay();
const daysToMonday       = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
const monday             = new Date(now); monday.setDate(now.getDate() - daysToMonday);
export const WEEKLY_SEED = monday.getFullYear()*10000 + (monday.getMonth()+1)*100 + monday.getDate();
const GHOST_KEY          = `ratrace_ghost_v2_${DAILY_SEED}`;

export const SOLO_LEVELS = {
  easy:   { cw:6, ch:6, par:20, label:'Easy',   seed:DAILY_SEED,   cheeseCount:7  },
  medium: { cw:6, ch:6, par:35, label:'Medium', seed:DAILY_SEED+1, cheeseCount:14 },
  hard:   { cw:6, ch:6, par:55, label:'Hard',   seed:DAILY_SEED+2, cheeseCount:14 },
};

// ── State ────────────────────────────────────────────────────
let levelKey  = 'easy';
let collected = 0, total = 0, raceTime = 0;
let finished  = false, started = false;
let currentRun = [];
let ghostOn   = true, ghostRecording = null, ghostBestTime = null;
let myName    = localStorage.getItem('ratrace_username') || null;
let _acc      = 0;

// ── Ghost ─────────────────────────────────────────────────────
function ghostKey(lvl)  { return `${GHOST_KEY}_${lvl}`; }
function loadGhost(lvl) {
  try {
    const raw  = localStorage.getItem(ghostKey(lvl));
    if (!raw)  { ghostRecording = null; ghostBestTime = null; return; }
    const data = JSON.parse(raw);
    ghostRecording = data.frames; ghostBestTime = data.time;
  } catch { ghostRecording = null; ghostBestTime = null; }
}
function saveGhost(lvl, time, frames) {
  try { localStorage.setItem(ghostKey(lvl), JSON.stringify({ time, frames })); } catch {}
}
function updateGhostHud() {
  const el = document.getElementById('ghosthud');
  if (!el) return;
  el.textContent = !ghostOn ? '' : ghostBestTime !== null
    ? `Ghost: ${ghostBestTime.toFixed(2)}s` : 'Ghost: no best yet';
}
function tickGhost(t) {
  if (!ghostOn || !ghostRecording || ghostRecording.length < 2) { ghostRat.visible = false; return; }
  ghostRat.visible = true;
  let lo = 0, hi = ghostRecording.length - 1;
  while (lo < hi - 1) { const mid = (lo+hi)>>1; if (ghostRecording[mid].t <= t) lo=mid; else hi=mid; }
  const a = ghostRecording[lo], b = ghostRecording[hi];
  const span = b.t - a.t, alpha = span > 0 ? (t - a.t)/span : 0;
  ghostRat.position.x = a.x + (b.x - a.x)*alpha;
  ghostRat.position.z = a.z + (b.z - a.z)*alpha;
  ghostRat.position.y = 0;
  let dyaw = b.yaw - a.yaw;
  if (dyaw >  Math.PI) dyaw -= Math.PI*2;
  if (dyaw < -Math.PI) dyaw += Math.PI*2;
  ghostRat.rotation.y = a.yaw + dyaw*alpha;
}

// ── Cheese spawn ─────────────────────────────────────────────
function spawnCheese() {
  for (const c of cheeses) scene.remove(c);
  clearCheeses();
  const L     = SOLO_LEVELS[levelKey];
  const count = Math.min(L.cheeseCount, 99);

  if (levelKey === 'hard') {
    const dist = Array.from({length:GH}, ()=>Array(GW).fill(-1));
    const queue = [[1,1]]; dist[1][1] = 0;
    while (queue.length) {
      const [r,c] = queue.shift();
      for (const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nr=r+dr, nc=c+dc;
        if (nr>=0&&nr<GH&&nc>=0&&nc<GW&&!grid[nr][nc]&&dist[nr][nc]===-1) {
          dist[nr][nc] = dist[r][c]+1; queue.push([nr,nc]);
        }
      }
    }
    const open = [];
    for (let r=1;r<GH-1;r++) for (let c=1;c<GW-1;c++) {
      if (grid[r][c]||(r===1&&c===1)||(r===GH-2&&c===GW-2)||dist[r][c]===-1) continue;
      let nbrs = 0;
      for (const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]]) if (!grid[r+dr][c+dc]) nbrs++;
      open.push({r,c,d:dist[r][c],dead:nbrs===1});
    }
    open.sort((a,b) => b.d - a.d);
    const step = Math.ceil(open.length / count);
    const chosen = [];
    for (let i=0; i<open.length && chosen.length<count; i+=Math.max(1,step)) chosen.push(open[i]);
    if (chosen.length < count) for (const cell of open) { if (chosen.length>=count) break; if (!chosen.includes(cell)) chosen.push(cell); }
    for (const {r,c} of chosen) placeCheeseAt(r, c);
  } else {
    const open = [];
    for (let r=1;r<GH-1;r++) for (let c=1;c<GW-1;c++)
      if (!grid[r][c] && !(r===1&&c===1) && !(r===GH-2&&c===GW-2)) open.push([r,c]);
    const crand = makeRNG(L.seed + 777);
    for (let i=open.length-1; i>0; i--) { const j=(crand()*(i+1))|0; [open[i],open[j]]=[open[j],open[i]]; }
    for (let i=0; i<Math.min(count,open.length); i++) { const [r,c]=open[i]; placeCheeseAt(r,c); }
  }
  total = cheeses.length;
}

// ── Reset ────────────────────────────────────────────────────
function resetRace() {
  const L = SOLO_LEVELS[levelKey];
  generateMaze(L.cw, L.ch, L.seed);
  spawnCheese();
  rat.position.copy(startPos); rat.rotation.y = Math.PI/2;
  setSpeed(0); setYaw(Math.PI/2);
  collected=0; raceTime=0; finished=false; started=false; currentRun=[];
  ghostRat.visible = false;
  document.getElementById('win').style.display = 'none';
  lastRat.copy(rat.position);
  camera.position.set(startPos.x, 18, startPos.z+22);
  orbitControls.target.set(startPos.x, 1.5, startPos.z);
  orbitControls.update();
  updateHUD(); updateGhostHud();
}

function setLevel(key) {
  levelKey = key;
  const L  = SOLO_LEVELS[key];
  document.getElementById('level').textContent = `Level: ${L.label}  ·  Par: ${L.par}s`;
  loadGhost(key); updateGhostHud(); resetRace();
}

function updateHUD() {
  document.getElementById('hud').textContent = `🧀 ${collected}/${total}  |  ⏱ ${raceTime.toFixed(2)}s`;
}

// ── Leaderboard ───────────────────────────────────────────────
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
async function addScore(name, time, lvl, frames) {
  const docId    = `${WEEKLY_SEED}_${lvl}_${name}`;
  const ref      = doc(db, 'scores', docId);
  const existing = await getDoc(ref);
  if (existing.exists() && existing.data().time <= time) return;
  const sampled  = frames.filter((_,i) => i%5===0);
  await setDoc(ref, { name, time, lvl, weekSeed: WEEKLY_SEED, date: DAILY_SEED, frames: sampled });
}

async function renderBoard(lvl) {
  const boardList = document.getElementById('boardList');
  if (lvl === 'weekly') {
  boardList.innerHTML = '<p style="color:#aaa">Loading…</p>';

  // Fetch top 3 for each day
  const dayData = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    const seed = d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate();
    const dayName = DAY_NAMES[d.getDay()];
    const isToday = seed === DAILY_SEED;
    let entries = [];
    console.log('DAILY_SEED', DAILY_SEED, 'querying seed', seed);
    try {
      const q = query(collection(db,'scores'), where('date','==',seed), orderBy('time'), limit(3));
      const snap = await getDocs(q);
      snap.forEach(d => entries.push(d.data()));
    } catch(e) {}
    dayData.push({ dayName, isToday, entries });
  }

  // Build table: days as columns, ranks as rows
  let html = '<p style="color:#9fe;margin-bottom:10px">Weekly Top 3</p>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';

  // Header row
  html += '<tr>';
  html += '<td style="padding:4px 6px;color:#555"></td>';
  dayData.forEach(({ dayName, isToday }) => {
    html += `<th style="padding:4px 6px;color:${isToday?'#ffd35a':'#9fe'};text-align:center">${dayName}</th>`;
  });
  html += '</tr>';

  // Rows 1, 2, 3
  for (let rank = 0; rank < 3; rank++) {
    const medal = rank===0?'🥇':rank===1?'🥈':'🥉';
    html += '<tr>';
    html += `<td style="padding:4px 6px">${medal}</td>`;
    dayData.forEach(({ entries }) => {
      const e = entries[rank];
      html += `<td style="padding:4px 6px;text-align:center;color:${rank===0?'#ffd35a':'#fff'}">`;
      html += e ? `${e.name}<br><span style="color:#ffd35a;font-size:11px">${e.time.toFixed(2)}s</span>` : '<span style="color:#555">—</span>';
      html += '</td>';
    });
    html += '</tr>';
  }

  html += '</table>';
  boardList.innerHTML = html;
  return;
}

  // Daily top 10 for this level
  boardList.innerHTML = '<p style="color:#aaa">Loading…</p>';
  const q = query(collection(db,'scores'), where('lvl','==',lvl), where('date','==',DAILY_SEED), orderBy('time'), limit(10));
  let snap;
  try { snap = await getDocs(q); } catch(e) { boardList.innerHTML='<p style="color:red">Error — check console.</p>'; console.error(e); return; }
  const label = SOLO_LEVELS[lvl].label;
  if (snap.empty) { boardList.innerHTML=`<p>No times yet for <b>${label}</b> today. Be the first!</p>`; return; }
  let html = `<p style="color:#9fe">${label} — today's top 10</p><ol style="padding-left:20px;line-height:1.8">`;
  snap.forEach(d => {
    const s=d.data();
    html += `<li>${s.name} — ${s.time.toFixed(2)}s <button class="racebtn" data-id="${d.id}" style="font-size:11px;padding:2px 7px;background:#222;color:#9fe;border:1px solid #9fe;border-radius:4px;cursor:pointer">Ghost Race</button></li>`;
  });
  html += '</ol>';
  boardList.innerHTML = html;
  boardList.querySelectorAll('.racebtn').forEach(btn => {
    btn.onclick = async () => {
      const snap = await getDoc(doc(db,'scores',btn.dataset.id));
      if (!snap.exists()) return;
      const data = snap.data();
      ghostRecording=data.frames; ghostBestTime=data.time; ghostOn=true;
      document.getElementById('btnGhost').textContent='Ghost (G): On';
      updateGhostHud();
      document.getElementById('board').style.display='none';
      resetRace();
      alert(`Racing ghost of ${data.name} (${data.time.toFixed(2)}s)!`);
    };
  });
}

// ── Controls ─────────────────────────────────────────────────
function buildControls() {
  const ctrl = document.getElementById('controls');
  ctrl.innerHTML = '';
  [
    ['btnEasy','Easy (1)'], ['btnMedium','Medium (2)'], ['btnHard','Hard (3)'],
    ['btnBoard','Leaderboard (L)'], ['btnFollow','Follow Cam (F): On'],
    ['btnSaveCam','Save Cam'], ['btnGhost','Ghost (G): On'],
    ['btnNight','Night Mode (N): Off'], ['btnMinimap','Minimap (M): On'],
  ].forEach(([id,txt]) => {
    const b = document.createElement('button'); b.id = id; b.textContent = txt; ctrl.appendChild(b);
  });

  document.getElementById('btnEasy').onclick   = () => { setLevel('easy');   document.getElementById('board').style.display='none'; };
  document.getElementById('btnMedium').onclick = () => { setLevel('medium'); document.getElementById('board').style.display='none'; };
  document.getElementById('btnHard').onclick   = () => { setLevel('hard');   document.getElementById('board').style.display='none'; };
  document.getElementById('btnBoard').onclick  = () => { renderBoard(levelKey); document.getElementById('board').style.display='block'; };
  document.getElementById('boardClose').onclick= () => { document.getElementById('board').style.display='none'; };
  document.getElementById('board').querySelectorAll('.lvlbtns button').forEach(b => { b.onclick = () => renderBoard(b.dataset.lvl); });

  document.getElementById('btnGhost').onclick = (e) => {
    ghostOn = !ghostOn; e.target.textContent = 'Ghost: '+(ghostOn?'On':'Off');
    if (!ghostOn) ghostRat.visible = false; updateGhostHud();
  };
  document.getElementById('btnFollow').onclick = (e) => {
    setFollowCam(!followCam); e.target.textContent = 'Follow Cam: '+(followCam?'On':'Off');
  };
  document.getElementById('btnSaveCam').onclick = (e) => {
    if (savedCamOffset) { setSavedCamOffset(null); e.target.textContent='Save Cam'; }
    else { setSavedCamOffset(new THREE.Vector3().subVectors(camera.position, orbitControls.target)); e.target.textContent='✅ Cam Saved'; }
  };
  document.getElementById('btnNight').onclick = (e) => {
    setNightMode(!nightMode); e.target.textContent='Night Mode: '+(nightMode?'On':'Off');
    if (nightMode) { scene.background=new THREE.Color(0x000000); scene.environment=null; }
    else { scene.background=skybox; scene.environment=skybox; }
    cheeseMats.forEach(m => { m.emissiveIntensity = nightMode ? 0 : CHEESE_GLOW; });
  };
  document.getElementById('btnMinimap').onclick = () => {
    setMinimapOn(!minimapOn);
    document.getElementById('minimap').style.display = minimapOn?'block':'none';
    document.getElementById('btnMinimap').textContent = 'Minimap: '+(minimapOn?'On (M)':'Off (M)');
  };

  // Save score
  const nameInput = document.getElementById('nameInput');
  const saveBtn   = document.getElementById('saveBtn');
  const saveMsg   = document.getElementById('saveMsg');
  if (myName) { nameInput.value = myName; nameInput.disabled = true; }
  saveBtn.onclick = async () => {
    let nm = (nameInput.value||'Anon').trim()||'Anon';
    localStorage.setItem('ratrace_username', nm);
    myName = nm; nameInput.value = nm; nameInput.disabled = true;
    saveBtn.disabled = true; saveMsg.textContent = 'Saving…';
    await addScore(nm, raceTime, levelKey, currentRun);
    saveMsg.textContent = 'Saved! 🧀  Open 🏆 Leaderboard to see standings.';
  };
  nameInput.addEventListener('keydown', e => { if (e.key==='Enter') saveBtn.click(); });
}

function handleKeys(k) {
  if (k==='m') { setMinimapOn(!minimapOn); document.getElementById('minimap').style.display=minimapOn?'block':'none'; }
  if (k==='1') { setLevel('easy');   document.getElementById('board').style.display='none'; }
  if (k==='2') { setLevel('medium'); document.getElementById('board').style.display='none'; }
  if (k==='3') { setLevel('hard');   document.getElementById('board').style.display='none'; }
  if (k==='f') { const b=document.getElementById('btnFollow');   if(b) b.click(); }
  if (k==='g') { const b=document.getElementById('btnGhost');    if(b) b.click(); }
  if (k==='n') { const b=document.getElementById('btnNight');    if(b) b.click(); }
  if (k==='l') {
    const board=document.getElementById('board');
    if (board.style.display==='block') board.style.display='none';
    else { renderBoard(levelKey); board.style.display='block'; }
  }
}
window.addEventListener('keydown', e => { if (e.target.tagName!=='INPUT') handleKeys(e.key.toLowerCase()); });

// ── Entry point ───────────────────────────────────────────────
export function startSolo(gameScreen) {
  window._mpCanAccel = true;
  document.getElementById('info').style.display    = 'block';
  document.getElementById('mpHud').style.display   = 'none';
  document.getElementById('board').style.display   = 'none';

  initEngine(gameScreen, () => {
    buildControls();
    onCheeseTemplateLoaded(() => spawnCheese());
    loadGhost(levelKey);
    setLevel(levelKey);
    renderer.setAnimationLoop(soloLoop);
  });
}

// ── Loop ─────────────────────────────────────────────────────
let _soloAcc = 0;
function soloLoop() {
  const rawDt = Math.min(clock.getDelta(), 0.1);
  _soloAcc += rawDt;
  if (_soloAcc < FIXED_DT) { orbitControls.update(); renderer.render(scene, camera); return; }
  _soloAcc -= FIXED_DT;
  const dt = FIXED_DT;

  physicsTick(dt, 1);

  if (!started && Math.abs(speed) > 0.5) started = true;
  if (started && !finished) raceTime += dt;
  if (ghostOn && started && !finished) currentRun.push({ t:raceTime, x:rat.position.x, z:rat.position.z, yaw });
  if (ghostOn && started) tickGhost(raceTime);

  updateCamera(rat.position);
  animateCheeses(dt);

  // Collect cheese
  for (let i = cheeses.length-1; i>=0; i--) {
    if (cheeses[i].position.distanceTo(rat.position) < 1.6) {
      scene.remove(cheeses[i]); cheeses.splice(i,1); collected++;
    }
  }

  // Gate
  const gateOpen = total>0 && collected>=total;
  if (finishGate) {
    finishGate.rotation.z += dt*1.2;
    finishGate.material.color.set(gateOpen ? 0x33ff88 : 0xff5555);
    finishGate.material.emissive.set(gateOpen ? 0x0a5530 : 0x551414);
  }
  const nearGate = rat.position.distanceTo(finishPos) < 2.4;
  document.getElementById('gatehint').style.display = (nearGate&&!gateOpen&&!finished)?'block':'none';

  if (!finished && nearGate && gateOpen) {
    finished = true;
    ghostRat.visible = false;
    document.getElementById('gatehint').style.display = 'none';
    if (ghostOn && currentRun.length>0 && (ghostBestTime===null||raceTime<ghostBestTime)) {
      ghostBestTime = raceTime; ghostRecording = currentRun.slice();
      saveGhost(levelKey, ghostBestTime, ghostRecording);
    }
    updateGhostHud();
    const L   = SOLO_LEVELS[levelKey];
    const beat = raceTime <= L.par;
    const newBest = ghostBestTime!==null && raceTime===ghostBestTime;
    document.getElementById('winMsg').innerHTML =
      `🏁 Finished!<br><span style="font-size:15px">${L.label} &nbsp;·&nbsp; Time: ${raceTime.toFixed(2)}s &nbsp;·&nbsp; Par: ${L.par}s<br>`+
      (newBest?'NEW BEST TIME!! Ghost updated. ':'')+
      (beat?'You beat the par time!':'⏱ Just over par — try again!')+'</span>';
    const nameInput = document.getElementById('nameInput');
    nameInput.value = myName||''; nameInput.disabled = !!myName;
    document.getElementById('saveBtn').disabled = false;
    document.getElementById('saveMsg').textContent = '';
    document.getElementById('win').style.display = 'block';
  }

  updateHUD();
  if (minimapOn) drawMinimap(rat.position, yaw, null);
  updateLighting(dt, rat.position);
  orbitControls.update();
  renderer.render(scene, camera);
}