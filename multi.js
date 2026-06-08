// ============================================================
// MULTI.JS — multiplayer logic
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  initEngine, onCheeseTemplateLoaded,
  renderer, scene, camera, orbitControls,
  rat, ghostRat, cheeses, cheeseTemplate, cheeseGeo, cheeseMat,
  startPos, finishPos, finishGate,
  GW, GH, grid,
  speed, yaw, lastRat, clock,
  followCam, savedCamOffset, minimapOn,
  setSpeed, setYaw, setFollowCam, setMinimapOn,
  FIXED_DT, CELL, MODEL_URL, MODEL_SCALE, MODEL_Y, MODEL_FACE, CHEESE_SCALE, CHEESE_Y,
  makeRNG, toWorldX, toWorldZ, toCol, toRow,
  generateMaze, placeCheeseAt, clearCheeses, makeNameLabel,
  drawMinimap, updateLighting, updateCamera, physicsTick, animateCheeses, getGW, getGH, getGrid, getYaw, getSpeed,
} from './engine.js';
import { getDatabase, ref, set, get, onValue, off, update, remove } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js';

let rtdb;
export function initMultiFirebase(fbApp) { rtdb = getDatabase(fbApp); }

// ── Constants ─────────────────────────────────────────────────
const PLAYER_COLORS = ['#ff4444','#44aaff','#ff44ff','#ffaa00','#00ffaa','#ff8844','#44ffff','#ffff44','#aa44ff','#44ff44'];

const now        = new Date();
const DAILY_SEED = now.getFullYear()*10000 + (now.getMonth()+1)*100 + now.getDate();
const MP_LEVELS  = {
  easy:   { cw:9, ch:9, label:'Easy',   seed:DAILY_SEED+10 },
  medium: { cw:9, ch:9, label:'Medium', seed:DAILY_SEED+11 },
  hard:   { cw:9, ch:9, label:'Hard',   seed:DAILY_SEED+12 },
};

// ── State ─────────────────────────────────────────────────────
let myPlayerId     = null;
let myRoom         = null;
let myColor        = PLAYER_COLORS[0];
let myName         = localStorage.getItem('ratrace_username') || 'Anon';
let isHost         = false;
let mpLevelKey     = 'easy';
let mpGameStarted  = false;
let mpRaceTime     = 0;
let mpFinished     = false;
let mpCheeseCollected = false;
let mySpeedPenalty = 1.0;
let mpCheeseWinner = null;
let mpMazeWinner   = null;
let mpResults      = {}; // pid -> {name, time, hasCheese, finished}
let mpListeners    = [];
let mpPlayers      = {};
let mpOtherRats    = {};
let mpCheeseObj    = null;
let _mpAcc         = 0;
let mpStarted      = false;
let mpGameScreen   = null;

let currentRound = 1;
const TOTAL_ROUNDS = 3;
let roundPoints = {}; // pid -> total points across rounds
let roundResults = []; // array of round result objects
let numPlayers = 1;
let mpResultsShown = false;   // guard so the results board shows once per round
let _finishFallback = null;   // fallback timer so a never-finishing player can't hang the round

// ── Helpers ───────────────────────────────────────────────────
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i=0; i<4; i++) code += chars[(Math.random()*chars.length)|0];
  return code;
}

function askName(cb) {
  const modal = document.getElementById('nameModal');
  const input = document.getElementById('nameModalInput');
  const btn   = document.getElementById('nameModalBtn');
  const current = localStorage.getItem('ratrace_username') || '';
  input.value = current;
  modal.style.display = 'flex';
  input.focus();

  const done = () => {
    const nm = input.value.trim().slice(0,14) || 'Anon';
    myName = nm;
    localStorage.setItem('ratrace_username', nm);
    modal.style.display = 'none';
    cb(nm);
  };
  const cancel = () => {
    modal.style.display = 'none';
  };

  btn.onclick = done;
  input.onkeydown = (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') cancel(); };

  // Add cancel button if not already there
  let cancelBtn = document.getElementById('nameModalCancel');
  if (!cancelBtn) {
    cancelBtn = document.createElement('button');
    cancelBtn.id = 'nameModalCancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'margin-top:8px;font-family:monospace;font-size:14px;padding:8px 24px;border-radius:6px;border:1px solid #555;background:none;color:#aaa;cursor:pointer;width:100%';
    btn.parentNode.appendChild(cancelBtn);
  }
  document.getElementById('nameModalCancel').onclick = cancel;
}

function showCheeseNotif(name) {
  const el = document.getElementById('cheeseNotif');
  el.innerHTML = `🧀 ${name} CUT THE CHEESE!<br><small>PLAYERS AFFECTED BY THE STANK!</small>`;
  el.style.display = 'block';
  setTimeout(() => el.style.display='none', 4000);
}

function showMpStatus(msg) {
  document.getElementById('mpStatus').textContent = msg;
}

// ── End of game leaderboard ───────────────────────────────────
function showMpResults() {
  if (mpResultsShown) return;          // already shown this round
  mpResultsShown = true;
  if (_finishFallback) { clearTimeout(_finishFallback); _finishFallback = null; }

  // Tally points for this round
  const allPlayers = { ...mpResults };
  // Add players from mpPlayers, using their REAL finish state (the old code
  // marked everyone here as DNF / time 0, which broke the winner ranking).
  Object.entries(mpPlayers).forEach(([pid, p]) => {
    if (!allPlayers[pid]) allPlayers[pid] = { pid, name:p.name, time:p.finishTime||0, hasCheese:p.hasCheese||false, finished:!!p.finished };
  });
  if (!allPlayers[myPlayerId]) allPlayers[myPlayerId] = { pid:myPlayerId, name:myName, time:mpRaceTime, hasCheese:mpCheeseCollected, finished:mpFinished };

  const finished = Object.values(allPlayers).filter(p=>p.finished).sort((a,b)=>a.time-b.time);
  const dnf      = Object.values(allPlayers).filter(p=>!p.finished);
  const cheeseBonus = Math.ceil(numPlayers / 2);

  // Award points
  finished.forEach((p, i) => {
    const pts = (numPlayers - i);
    roundPoints[p.pid] = (roundPoints[p.pid]||0) + pts;
    if (p.hasCheese) roundPoints[p.pid] += cheeseBonus;
  });
  dnf.forEach(p => {
    roundPoints[p.pid] = roundPoints[p.pid] || 0;
    if (p.hasCheese) roundPoints[p.pid] += cheeseBonus;
  });

  roundResults.push({ finished, dnf, cheeseBonus });

  const isFinal = currentRound >= TOTAL_ROUNDS;
  const modal   = document.getElementById('mpResultsModal');
  const list    = document.getElementById('mpResultsList');

  // Sort by total points for standings
  const standings = Object.entries(roundPoints)
    .map(([pid, pts]) => ({ pid, pts, name: allPlayers[pid]?.name || pid }))
    .sort((a,b) => b.pts - a.pts);

  let html = `<h2 style="color:#ffd35a;margin-bottom:4px">${isFinal ? '🏆 Final Results' : `Round ${currentRound} Results`}</h2>`;
  html += `<p style="color:#aaa;font-size:12px;margin-bottom:16px">${isFinal ? 'Game over!' : `Round ${currentRound} of ${TOTAL_ROUNDS}`}</p>`;

  // Round finishers
  html += `<p style="color:#9fe;margin-bottom:6px">This round</p>`;
  html += '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">';
  finished.forEach((p, i) => {
    const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`;
    const pts   = numPlayers - i;
    html += `<tr>
      <td style="padding:4px 8px">${medal}</td>
      <td style="padding:4px 8px">${p.name}${p.pid===myPlayerId?' (you)':''}</td>
      <td style="padding:4px 8px;color:#ffd35a">${p.time.toFixed(2)}s</td>
      <td style="padding:4px 8px;color:#9fe">+${pts}pts${p.hasCheese?` +${cheeseBonus}🧀`:''}</td>
    </tr>`;
  });
  if (dnf.length) {
    dnf.forEach(p => {
      html += `<tr><td style="padding:4px 8px;color:#555">DNF</td><td style="padding:4px 8px;color:#555">${p.name}</td><td></td><td style="padding:4px 8px;color:#9fe">${p.hasCheese?`+${cheeseBonus}🧀`:'0pts'}</td></tr>`;
    });
  }
  html += '</table>';

  // Overall standings
  html += '<p style="color:#9fe;margin-bottom:6px">Overall Standings</p>';
  html += '<table style="width:100%;border-collapse:collapse;margin-bottom:20px">';
  standings.forEach((p, i) => {
    const isMe = p.pid === myPlayerId;
    html += `<tr style="${isMe?'background:#1a2a10':''}">
      <td style="padding:4px 8px">${i+1}.</td>
      <td style="padding:4px 8px">${p.name}${isMe?' (you)':''}</td>
      <td style="padding:4px 8px;color:#ffd35a;font-weight:bold">${p.pts} pts</td>
    </tr>`;
  });
  html += '</table>';

  if (isFinal) {
    const winner = standings[0];
    html += `<p style="font-size:20px;color:#ffd35a;margin-bottom:16px">🎉 ${winner.name} wins!</p>`;
    html += `<button onclick="document.getElementById('mpResultsModal').style.display='none'" style="font-family:monospace;font-size:14px;padding:10px 20px;border-radius:8px;border:2px solid #555;background:#222;color:#fff;cursor:pointer">Close</button>`;
  } else if (isHost) {
    html += `<button id="nextRoundBtn" style="font-family:monospace;font-size:16px;padding:12px 28px;border-radius:8px;border:2px solid #ffd35a;background:#2a2410;color:#ffd35a;cursor:pointer">▶ Start Round ${currentRound+1}</button>`;
  } else {
    html += `<p style="color:#aaa;font-size:13px">Waiting for host to start next round…</p>`;
  }

  list.innerHTML = html;
  modal.style.display = 'block';

  if (!isFinal && isHost) {
    document.getElementById('nextRoundBtn').onclick = async () => {
      currentRound++;
      await update(ref(rtdb, `rooms/${myRoom}`), { currentRound, roundStarted: Date.now() });
      document.getElementById('mpResultsModal').style.display = 'none';
      Object.values(mpOtherRats).forEach(r => scene.remove(r));
      mpOtherRats = {};
      _startRound(myRoom, mpLevelKey, mpGameScreen);
    };
  }

  // Non-hosts listen for next round
  if (!isFinal && !isHost) {
    const nextRef = ref(rtdb, `rooms/${myRoom}/currentRound`);
    onValue(nextRef, snap => {
      if (snap.val() > currentRound) {
        currentRound = snap.val();
        off(nextRef, 'value');
        modal.style.display = 'none';
        Object.values(mpOtherRats).forEach(r => scene.remove(r));
        mpOtherRats = {};
        _startRound(myRoom, mpLevelKey, mpGameScreen);
      }
    });
  }
}

// ── Join / Leave ──────────────────────────────────────────────
export function leaveRoom() {
  if (myRoom && myPlayerId) {
    remove(ref(rtdb, `rooms/${myRoom}/players/${myPlayerId}`));
    myRoom = null; myPlayerId = null;
  }
  mpListeners.forEach(fn => fn()); mpListeners = [];
  mpGameStarted = false;
  mySpeedPenalty = 1.0;
  mpCheeseWinner = null;
  mpMazeWinner = null;
  mpFinished = false;
  mpCheeseCollected = false;
  mpResultsShown = false;
  if (_finishFallback) { clearTimeout(_finishFallback); _finishFallback = null; }
  currentRound = 1;
  roundPoints = {};
  roundResults = [];
  window._mpCanAccel = true;
  if (scene) Object.values(mpOtherRats).forEach(r => scene.remove(r));
  mpOtherRats = {}; mpPlayers = {};
  if (renderer) renderer.setAnimationLoop(null);
}

export function createRoom(onLobby) {
  askName((name) => {
    myName = name;
    const code  = genRoomCode();
    myPlayerId  = 'p_'+Math.random().toString(36).slice(2,8);
    myColor     = PLAYER_COLORS[0];
    isHost      = true;
    myRoom      = code;
    _writePlayer(code, name, true, onLobby);
  });
}

export function joinRoom(code, onLobby, onError) {
  code = code.toUpperCase();
  askName(async (name) => {
    myName = name;
    const snap    = await get(ref(rtdb, `rooms/${code}`));
    const existing = snap.val();
    if (!existing) { onError('Room not found!'); return; }
    const playerCount = Object.keys(existing.players||{}).length;
    if (playerCount >= 10) { onError('Room is full!'); return; }
    const usedColors = Object.values(existing.players||{}).map(p=>p.color);
    myColor     = PLAYER_COLORS.find(c=>!usedColors.includes(c)) || PLAYER_COLORS[playerCount%PLAYER_COLORS.length];
    myPlayerId  = 'p_'+Math.random().toString(36).slice(2,8);
    isHost      = false;
    myRoom      = code;
    _writePlayer(code, name, false, onLobby);
  });
}

async function _writePlayer(code, name, hosting, onLobby) {
  const L = MP_LEVELS[mpLevelKey];
  const startX = (1 - (2*(L.cw)+1-1)/2) * 4;
  const startZ = (1 - (2*(L.ch)+1-1)/2) * 4;
  await update(ref(rtdb, `rooms/${code}/players/${myPlayerId}`), {
    name, color: myColor, x:startX, z:startZ, yaw:Math.PI/2,
    finished:false, hasCheese:false, joinedAt:Date.now(), finishTime:0
  });
  if (hosting) {
    await update(ref(rtdb, `rooms/${code}`), { host:myPlayerId, level:mpLevelKey, started:false });
  }
  window.addEventListener('beforeunload', leaveRoom);
  onLobby(code, hosting);
}

// ── Lobby listeners ───────────────────────────────────────────
export function listenLobby(code, onPlayersChange, onRoomChange) {
  const playersRef = ref(rtdb, `rooms/${code}/players`);
  const roomRef    = ref(rtdb, `rooms/${code}`);
  onValue(playersRef, snap => onPlayersChange(snap.val()||{}));
  onValue(roomRef,    snap => onRoomChange(snap.val()||{}));
  mpListeners.push(() => off(playersRef,'value'));
  mpListeners.push(() => off(roomRef,'value'));
}

export async function setRoomLevel(code, lvl) {
  mpLevelKey = lvl;
  await update(ref(rtdb, `rooms/${code}`), { level: lvl });
}

export async function triggerStart(code) {
  await update(ref(rtdb, `rooms/${code}`), { started:true, startTime:Date.now()+3500 });
}

// ── Start game ────────────────────────────────────────────────
export function startMpGame(code, lvlKey, gameScreen, playerCount) {
  mpGameScreen  = gameScreen;
  mpLevelKey    = lvlKey;
  mpGameStarted = true;
  numPlayers    = playerCount || 2;
  currentRound  = 1;
  roundPoints   = {};
  roundResults  = [];

  _startRound(code, lvlKey, gameScreen);
}

function _startRound(code, lvlKey, gameScreen) {
// Clear old listeners before adding new ones each round
    mpListeners.forEach(fn => fn()); 
    mpListeners = [];  
    mpRaceTime        = 0;
  mpFinished        = false;
  mpCheeseCollected = false;
  mySpeedPenalty    = 1.0;
  mpCheeseWinner    = null;
  mpMazeWinner      = null;
  mpResults         = {};
  _mpAcc            = 0;
  mpStarted         = false;
  mpResultsShown    = false;
  if (_finishFallback) { clearTimeout(_finishFallback); _finishFallback = null; }
  window._mpCanAccel = false;

  document.getElementById('info').style.display  = 'none';
  document.getElementById('mpHud').style.display = 'block';
  document.getElementById('controls').innerHTML  = '';
  document.getElementById('mpResultsModal').style.display = 'none';

  // Different seed each round
  const L = MP_LEVELS[mpLevelKey];
  const roundSeed = L.seed + (currentRound * 100);

  update(ref(rtdb, `rooms/${code}`), { cheeseCollected: false, roundFinishCount: 0 });

  initEngine(gameScreen, () => {
    generateMaze(L.cw, L.ch, roundSeed);
    rat.position.copy(startPos); rat.rotation.y = Math.PI/2;
    setSpeed(0); setYaw(Math.PI/2);
    lastRat.copy(rat.position);
    camera.position.set(startPos.x, 18, startPos.z+22);
    orbitControls.target.set(startPos.x, 1.5, startPos.z);
    orbitControls.update();

    if (cheeseTemplate) spawnMpCheese();
    else onCheeseTemplateLoaded(() => spawnMpCheese());

    document.getElementById('mpStatus').textContent = `Round ${currentRound} of ${TOTAL_ROUNDS}`;

    window._mpCanAccel = false;
    const cd = document.getElementById('countdown');
    cd.style.display = 'block';
    let count = 7;
    cd.textContent = count;
    const iv = setInterval(() => {
      count--;
      if (count > 0)        { cd.textContent = count; }
      else if (count === 0) { cd.textContent = 'GO!'; }
      else { cd.style.display='none'; clearInterval(iv); mpStarted=true; window._mpCanAccel=true; }
    }, 1000);

    renderer.setAnimationLoop(mpLoop);
    listenPlayers(code);

    // Reset player finished flags in Firebase for this round
    update(ref(rtdb, `rooms/${code}/players/${myPlayerId}`), {
      finished: false, hasCheese: false, finishTime: 0
    });
    update(ref(rtdb, `rooms/${code}`), { cheeseCollected: false, roundFinishCount: 0 });
  });
}

function spawnMpCheese() {  
  const GW = getGW(), GH = getGH(), grid = getGrid();
  for (const c of cheeses) scene.remove(c);
  clearCheeses();

  // BFS to find shortest path from start to finish
  const startR = 1, startC = 1;
  const finR = GH-2, finC = GW-2;
  const prev = Array.from({length:GH}, ()=>Array(GW).fill(null));
  const queue = [[startR, startC]];
  prev[startR][startC] = [-1,-1];
  while (queue.length) {
    const [r,c] = queue.shift();
    for (const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nr=r+dr, nc=c+dc;
      if (nr>=0&&nr<GH&&nc>=0&&nc<GW&&!grid[nr][nc]&&!prev[nr][nc]) {
        prev[nr][nc]=[r,c]; queue.push([nr,nc]);
      }
    }
  }

  // Mark cells on the shortest path
  const onPath = Array.from({length:GH}, ()=>Array(GW).fill(false));
  let cur = [finR, finC];
  while (cur[0]!==startR || cur[1]!==startC) {
    onPath[cur[0]][cur[1]] = true;
    cur = prev[cur[0]][cur[1]];
    if (!cur) break;
  }
  onPath[startR][startC] = true;

  // BFS from start for actual maze distances
  const distFromStart = Array.from({length:GH}, ()=>Array(GW).fill(-1));
  const q1 = [[startR,startC]]; distFromStart[startR][startC]=0;
  while(q1.length){ const [r,c]=q1.shift(); for(const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]]){ const nr=r+dr,nc=c+dc; if(nr>=0&&nr<GH&&nc>=0&&nc<GW&&!grid[nr][nc]&&distFromStart[nr][nc]===-1){ distFromStart[nr][nc]=distFromStart[r][c]+1; q1.push([nr,nc]); } } }

  // BFS from finish for actual maze distances
  const distFromFin = Array.from({length:GH}, ()=>Array(GW).fill(-1));
  const q2 = [[finR,finC]]; distFromFin[finR][finC]=0;
  while(q2.length){ const [r,c]=q2.shift(); for(const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]]){ const nr=r+dr,nc=c+dc; if(nr>=0&&nr<GH&&nc>=0&&nc<GW&&!grid[nr][nc]&&distFromFin[nr][nc]===-1){ distFromFin[nr][nc]=distFromFin[r][c]+1; q2.push([nr,nc]); } } }

  const totalDist = distFromStart[finR][finC];

  const candidates = [];
  for (let r=1;r<GH-1;r++) for (let c=1;c<GW-1;c++) {
    if (grid[r][c] || onPath[r][c]) continue;
    if (r===startR&&c===startC) continue;
    if (r===finR&&c===finC) continue;
    if (distFromStart[r][c]===-1||distFromFin[r][c]===-1) continue;
    // Must be at least 50% of path length from start, and 20% from finish
    if (distFromStart[r][c] < totalDist*0.5) continue;
    if (distFromFin[r][c] < totalDist*0.2) continue;
    let openN = 0;
    for (const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]])
      if (!grid[r+dr][c+dc]) openN++;
    const score = Math.abs(distFromStart[r][c] - totalDist*0.65);
    candidates.push({r, c, dead: openN===1, score});
  }

  const deadEnds = candidates.filter(x=>x.dead).sort((a,b)=>a.score-b.score);
  const pick = deadEnds.length > 0 ? deadEnds[0] : candidates.sort((a,b)=>a.score-b.score)[0];

  if (pick) {
    mpCheeseObj = placeCheeseAt(pick.r, pick.c);
  }
}

// ── Listen players ────────────────────────────────────────────
function listenPlayers(code) {
  const playersRef = ref(rtdb, `rooms/${code}/players`);
  onValue(playersRef, snap => {
    const players = snap.val() || {};
    mpPlayers = {};

    Object.entries(players).forEach(([pid, p]) => {
      if (pid === myPlayerId) return;
      mpPlayers[pid] = p;

      // Create rat mesh
      if (!mpOtherRats[pid] && scene) {
        const g = new THREE.Group();
        // Name label
        g.add(makeNameLabel(p.name, p.color||'#ff4444'));
        new GLTFLoader().load(MODEL_URL, (gltf) => {
          const m = gltf.scene;
          m.scale.setScalar(MODEL_SCALE); m.rotation.y = MODEL_FACE; m.position.y = MODEL_Y;
          m.traverse(o => {
            if (o.isMesh) {
                if (Array.isArray(o.material)) {
                o.material = o.material.map(mat => {
                    const m2 = mat.clone();
                    m2.color.lerp(new THREE.Color(p.color||'#ff4444'), 0.6);
                    m2.side = THREE.DoubleSide;
                    return m2;
                });
                } else {
                o.material = o.material.clone();
                o.material.color.lerp(new THREE.Color(p.color||'#ff4444'), 0.6);
                o.material.side = THREE.DoubleSide;
                }
                o.castShadow = true;
            }
            });
          g.add(m);
        }, undefined, () => {
          const fb = new THREE.Mesh(
            new THREE.SphereGeometry(0.8,12,12),
            new THREE.MeshStandardMaterial({ color: new THREE.Color(p.color||'#ff4444') })
          );
          g.add(fb);
        });
        scene.add(g);
        mpOtherRats[pid] = g;
      }

      // Update position
      if (mpOtherRats[pid]) {
        mpOtherRats[pid].position.set(p.x||0, 0, p.z||0);
        mpOtherRats[pid].rotation.y = p.yaw||0;
        // Keep label facing camera
        const label = mpOtherRats[pid].children[0];
        if (label && camera) label.lookAt(camera.position);
      }

      // Cheese stolen by someone else (notify only — penalty is handled by
      // the room listener so it has a single source and resets cleanly)
      if (p.hasCheese && !mpCheeseWinner && p.name !== myName) {
        mpCheeseWinner = p.name;
        showCheeseNotif(p.name);
      }

      // Maze winner (someone else finished)
      if (p.finished && !mpMazeWinner) {
        mpMazeWinner = p.name;
        showMpStatus(`🏁 ${p.name} escaped the maze first!`);
      }

      // Track results
      if (p.finished) {
        mpResults[pid] = { pid, name:p.name, time:p.finishTime||0, hasCheese:p.hasCheese, finished:true };
      }
    });

    // Remove rats for players who left
    Object.keys(mpOtherRats).forEach(pid => {
      if (!players[pid]) { scene.remove(mpOtherRats[pid]); delete mpOtherRats[pid]; }
    });

    // Only show results once EVERYONE has finished, so a fast finisher
    // doesn't pop the board early and wrongly mark still-racing players DNF.
    if (mpStarted && !mpResultsShown) {
      const ids = Object.keys(players);
      if (ids.length > 0 && ids.every(id => players[id] && players[id].finished)) {
        showMpResults();
      }
    }
  });
  mpListeners.push(() => off(playersRef,'value'));
  const roomRef = ref(rtdb, `rooms/${code}`);
onValue(roomRef, snap => {
    const data = snap.val() || {};
    if (data.cheeseCollected && cheeses.length > 0) {
        scene.remove(cheeses[0]); cheeses.splice(0,1);
    }
    // Derive the penalty fresh on every update: slowed only while the cheese
    // is collected AND I'm not the one who got it. When the round resets
    // (cheeseCollected back to false) this returns to full speed on its own,
    // so it can't get stuck slow across rounds.
    mySpeedPenalty = (data.cheeseCollected && !mpCheeseCollected) ? 0.55 : 1.0;
});
    mpListeners.push(() => off(roomRef, 'value'));
}

// ── MP loop ───────────────────────────────────────────────────
function mpLoop() {
  const rawDt = Math.min(clock.getDelta(), 0.1);
  const dt = FIXED_DT;

  // Run physics enough times to keep up with real time. The old version
  // capped at one step per frame, which made the rat AND the race timer
  // run slow whenever the frame rate dipped below 60fps.
  _mpAcc += rawDt;
  let _steps = 0;
  while (_mpAcc >= FIXED_DT && _steps < 8) {
    physicsTick(FIXED_DT * mySpeedPenalty);
    if (mpStarted && !mpFinished) mpRaceTime += FIXED_DT;
    animateCheeses(FIXED_DT); 
    _mpAcc -= FIXED_DT;
    _steps++;
  }

  if (mpStarted) {
    document.getElementById('mpTimer').textContent = `⏱ ${mpRaceTime.toFixed(2)}s`;

    // Broadcast position
    if (myRoom && myPlayerId) {
      update(ref(rtdb, `rooms/${myRoom}/players/${myPlayerId}`), {
        x: rat.position.x, z: rat.position.z, yaw: getYaw(), finished: mpFinished
      });
    }
  }

  updateCamera(rat.position);

  // Cheese collection
  if (cheeses.length > 0 && cheeses[0].position.distanceTo(rat.position) < 1.6 && !mpCheeseCollected) {
    mpCheeseCollected = true;
    mpCheeseWinner    = myName;
    showCheeseNotif(myName + ' (you)');
    showMpStatus('🧀 You cut the cheese! Others are slowed!');
    update(ref(rtdb, `rooms/${myRoom}`), { cheeseCollected: true });
    update(ref(rtdb, `rooms/${myRoom}/players/${myPlayerId}`), { hasCheese:true });
    mpResults[myPlayerId] = { ...mpResults[myPlayerId], hasCheese:true };
    }

  // Finish line
  if (finishGate) { finishGate.rotation.z += dt*1.2; }
  if (!mpFinished && mpStarted && rat.position.distanceTo(finishPos) < 2.4) {
    mpFinished = true;
    update(ref(rtdb, `rooms/${myRoom}/players/${myPlayerId}`), {
      finished:true, finishTime: mpRaceTime
    });
    mpResults[myPlayerId] = { pid:myPlayerId, name:myName, time:mpRaceTime, hasCheese:mpCheeseCollected, finished:true };
    if (!mpMazeWinner) {
      mpMazeWinner = myName;
      showMpStatus(`🏁 You escaped first! Time: ${mpRaceTime.toFixed(2)}s`);
    } else {
      showMpStatus(`🏁 You finished! Time: ${mpRaceTime.toFixed(2)}s`);
    }
    if (mpStarted && !mpFinished) {
        document.getElementById('mpTimer').textContent = `⏱ ${mpRaceTime.toFixed(2)}s`;
    }
}

  if (minimapOn) drawMinimap(rat.position, yaw, Object.values(mpPlayers));
  updateLighting(dt, rat.position);
  orbitControls.update();
  renderer.render(scene, camera);
}