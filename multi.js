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
  drawMinimap, updateLighting, updateCamera, physicsTick, animateCheeses,
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

// ── Helpers ───────────────────────────────────────────────────
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i=0; i<4; i++) code += chars[(Math.random()*chars.length)|0];
  return code;
}

function askName(cb) {
  if (myName && myName !== 'Anon') { cb(myName); return; }
  const nm = prompt('Enter your name (max 14 chars):', '') || 'Anon';
  myName = nm.trim().slice(0,14) || 'Anon';
  localStorage.setItem('ratrace_username', myName);
  cb(myName);
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
  const sorted = Object.values(mpResults)
    .filter(p => p.finished)
    .sort((a,b) => a.time - b.time);

  const dnf = Object.values(mpResults).filter(p => !p.finished);

  let html = '<h2 style="color:#ffd35a;margin-bottom:16px">🏁 Race Results</h2>';
  html += '<table style="width:100%;border-collapse:collapse">';
  html += '<tr style="color:#9fe;border-bottom:1px solid #333"><th style="padding:6px 10px;text-align:left">#</th><th style="text-align:left;padding:6px 10px">Player</th><th style="text-align:left;padding:6px 10px">Time</th><th style="text-align:left;padding:6px 10px">🧀</th></tr>';

  sorted.forEach((p, i) => {
    const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`;
    html += `<tr style="${i===0?'background:#1a2a10':''}">
      <td style="padding:6px 10px;font-size:18px">${medal}</td>
      <td style="padding:6px 10px">${p.name}${p.pid===myPlayerId?' (you)':''}</td>
      <td style="padding:6px 10px;color:#ffd35a">${p.time.toFixed(2)}s</td>
      <td style="padding:6px 10px">${p.hasCheese?'✅ Cut it!':''}</td>
    </tr>`;
  });

  if (dnf.length) {
    html += `<tr><td colspan="4" style="padding:8px 10px;color:#555;font-size:12px">Did not finish: ${dnf.map(p=>p.name).join(', ')}</td></tr>`;
  }
  html += '</table>';
  html += `<button onclick="document.getElementById('mpResultsModal').style.display='none'" style="margin-top:16px;font-family:monospace;font-size:14px;padding:10px 20px;border-radius:8px;border:2px solid #ffd35a;background:#2a2410;color:#ffd35a;cursor:pointer">Close</button>`;

  const modal = document.getElementById('mpResultsModal');
  document.getElementById('mpResultsList').innerHTML = html;
  modal.style.display = 'block';
}

// ── Join / Leave ──────────────────────────────────────────────
export function leaveRoom() {
  if (myRoom && myPlayerId) {
    remove(ref(rtdb, `rooms/${myRoom}/players/${myPlayerId}`));
    myRoom = null; myPlayerId = null;
  }
  mpListeners.forEach(fn => fn()); mpListeners = [];
  mpGameStarted = false;
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
  await update(ref(rtdb, `rooms/${code}/players/${myPlayerId}`), {
    name, color: myColor, x:0, z:0, yaw:0,
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
export function startMpGame(code, lvlKey, gameScreen) {
  mpGameScreen  = gameScreen;
  mpLevelKey    = lvlKey;
  mpGameStarted = true;

  document.getElementById('info').style.display  = 'none';
  document.getElementById('mpHud').style.display = 'block';
  document.getElementById('controls').innerHTML  = '';

  initEngine(gameScreen, () => {
    const L = MP_LEVELS[mpLevelKey];
    generateMaze(L.cw, L.ch, L.seed);
    spawnMpCheese();
    rat.position.copy(startPos); rat.rotation.y = Math.PI/2;
    setSpeed(0); setYaw(Math.PI/2);
    lastRat.copy(rat.position);
    camera.position.set(startPos.x, 18, startPos.z+22);
    orbitControls.target.set(startPos.x, 1.5, startPos.z);
    orbitControls.update();

    onCheeseTemplateLoaded(() => spawnMpCheese());

    // Countdown
    const cd = document.getElementById('countdown');
    cd.style.display = 'block';
    let count = 3;
    cd.textContent = count;
    const iv = setInterval(() => {
      count--;
      if (count > 0)       { cd.textContent = count; }
      else if (count === 0){ cd.textContent = 'GO!'; }
      else { cd.style.display='none'; clearInterval(iv); mpStarted=true; }
    }, 1000);

    renderer.setAnimationLoop(mpLoop);
    listenPlayers(code);
  });
}

function spawnMpCheese() {
  for (const c of cheeses) scene.remove(c);
  clearCheeses();
  // Cheese near top-right corner (opposite of finish at bottom-right; start is top-left)
  let cr = 1, cc = GW-2;
  while (cr < GH-1 && grid[cr][cc]) { cr++; if (grid[cr][cc]) cc--; }
  mpCheeseObj = placeCheeseAt(cr, cc);
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
              const mats = Array.isArray(o.material) ? o.material : [o.material];
              mats.forEach(mat => {
                if (mat) { mat = mat.clone(); mat.color = new THREE.Color(p.color||'#ff4444'); o.material = mat; }
              });
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

      // Cheese stolen by someone else
      if (p.hasCheese && !mpCheeseWinner && p.name !== myName) {
        mpCheeseWinner = p.name;
        showCheeseNotif(p.name);
        mySpeedPenalty = 0.90;
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
  });
  mpListeners.push(() => off(playersRef,'value'));
}

// ── MP loop ───────────────────────────────────────────────────
function mpLoop() {
  const rawDt = Math.min(clock.getDelta(), 0.1);
  _mpAcc += rawDt;
  if (_mpAcc < FIXED_DT) { orbitControls.update(); renderer.render(scene,camera); return; }
  _mpAcc -= FIXED_DT;
  const dt = FIXED_DT;

  if (mpStarted) {
    physicsTick(dt, mySpeedPenalty);
    mpRaceTime += dt;
    document.getElementById('mpTimer').textContent = `⏱ ${mpRaceTime.toFixed(2)}s`;

    // Broadcast position
    if (myRoom && myPlayerId) {
      update(ref(rtdb, `rooms/${myRoom}/players/${myPlayerId}`), {
        x: rat.position.x, z: rat.position.z, yaw, finished: mpFinished
      });
    }
  }

  updateCamera(rat.position);
  animateCheeses(dt);

  // Cheese collection
  if (cheeses.length > 0 && cheeses[0].position.distanceTo(rat.position) < 1.6 && !mpCheeseCollected) {
    scene.remove(cheeses[0]); cheeses.splice(0,1);
    mpCheeseCollected = true;
    mpCheeseWinner    = myName;
    showCheeseNotif(myName + ' (you)');
    showMpStatus('🧀 You cut the cheese! Others are slowed!');
    // I don't slow down — others do via Firebase
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
    // Show results after short delay
    setTimeout(() => showMpResults(), 2000);
  }

  if (minimapOn) drawMinimap(rat.position, yaw, Object.values(mpPlayers));
  updateLighting(dt, rat.position);
  orbitControls.update();
  renderer.render(scene, camera);
}