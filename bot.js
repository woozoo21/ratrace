// ============================================================
// BOT.JS — Hierarchical RL agent
// High-level: Q-learning learns optimal cheese-visit order
// Low-level: BFS computes shortest path between waypoints
// Movement: Same physics as player (accel, max speed, turn rate)
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  scene, rat, MODEL_URL, MODEL_SCALE, MODEL_Y, MODEL_FACE,
  getGW, getGH, getGrid, cheeses,
  toWorldX, toWorldZ,
  ACCEL, TURN_RATE, MAX_SPEED, FRICTION,
  blocked,
} from './engine.js';

// ── Hyperparameters for high-level routing Q-learning ─────────
const LR        = 0.15;
const DISCOUNT  = 0.95;
const EPSILON_START = 1.0;
const EPSILON_END   = 0.05;
const EPSILON_DECAY = 0.997;
const EPISODES  = 2000;

// ── BFS: returns shortest path (array of [r,c]) between two cells ──
function bfs(grid, gw, gh, sr, sc, er, ec) {
  const prev = Array.from({length:gh}, ()=>Array(gw).fill(null));
  const queue = [[sr, sc]];
  prev[sr][sc] = [-1, -1];
  while (queue.length) {
    const [r, c] = queue.shift();
    if (r === er && c === ec) break;
    for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nr = r+dr, nc = c+dc;
      if (nr>=0 && nr<gh && nc>=0 && nc<gw && !grid[nr][nc] && !prev[nr][nc]) {
        prev[nr][nc] = [r, c];
        queue.push([nr, nc]);
      }
    }
  }
  if (!prev[er][ec]) return null;
  // Reconstruct
  const path = [];
  let cur = [er, ec];
  while (cur[0] !== sr || cur[1] !== sc) {
    path.unshift(cur);
    cur = prev[cur[0]][cur[1]];
    if (!cur) break;
  }
  path.unshift([sr, sc]);
  return path;
}

// ── Compute distance matrix between all waypoints ─────────────
function buildDistanceMatrix(waypoints, grid, gw, gh) {
  const n = waypoints.length;
  const dist = Array.from({length:n}, () => new Array(n).fill(Infinity));
  const paths = Array.from({length:n}, () => new Array(n).fill(null));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) { dist[i][j] = 0; continue; }
      const p = bfs(grid, gw, gh, waypoints[i].r, waypoints[i].c, waypoints[j].r, waypoints[j].c);
      if (p) { dist[i][j] = p.length - 1; paths[i][j] = p; }
    }
  }
  return { dist, paths };
}

// ── Q-learning: learn optimal cheese visit order ──────────────
// State: (currentWaypointIndex, bitmaskOfVisitedCheeses)
// Action: which cheese (or finish) to visit next
function trainRoutingQ(numCheese, dist) {
  // Indices: 0 = start, 1..numCheese = cheeses, numCheese+1 = finish
  const startIdx  = 0;
  const finishIdx = numCheese + 1;
  const fullMask  = (1 << numCheese) - 1; // all cheese collected
  const numActions = numCheese + 2; // can choose any waypoint (we'll mask invalid ones)

  // State key: `${currentIdx}_${mask}`
  const Q = new Map();
  const qGet = (s, a) => {
    const arr = Q.get(s);
    return arr ? arr[a] : 0;
  };
  const qSet = (s, a, v) => {
    if (!Q.has(s)) Q.set(s, new Float32Array(numActions));
    Q.get(s)[a] = v;
  };

  // Valid actions: any cheese not yet visited, or finish if all cheeses visited
  const validActions = (cur, mask) => {
    const acts = [];
    for (let i = 1; i <= numCheese; i++) {
      if (i === cur) continue;
      if (!(mask & (1 << (i-1)))) acts.push(i);
    }
    if (mask === fullMask) acts.push(finishIdx);
    return acts;
  };

  let epsilon = EPSILON_START;

  for (let ep = 0; ep < EPISODES; ep++) {
    let cur = startIdx;
    let mask = 0;
    let totalReward = 0;

    while (true) {
      const acts = validActions(cur, mask);
      if (acts.length === 0) break;

      let a;
      const stateKey = `${cur}_${mask}`;
      if (Math.random() < epsilon) {
        a = acts[(Math.random() * acts.length) | 0];
      } else {
        // Best valid action
        let best = acts[0], bestQ = qGet(stateKey, acts[0]);
        for (const act of acts) {
          const v = qGet(stateKey, act);
          if (v > bestQ) { bestQ = v; best = act; }
        }
        a = best;
      }

      // Reward = strongly penalize travel time + cheese bonus + finish bonus
      // Heavily weight travel cost so the agent goes for nearest cheese first
      const travel = dist[cur][a];
      let reward = -travel * 2;  // double travel penalty
      if (a >= 1 && a <= numCheese) reward += 30;
      if (a === finishIdx) reward += 200;       // reached the finish

      let newMask = mask;
      if (a >= 1 && a <= numCheese) newMask = mask | (1 << (a-1));

      const nextStateKey = `${a}_${newMask}`;
      const nextActs = validActions(a, newMask);
      let maxNextQ = 0;
      if (nextActs.length) {
        maxNextQ = qGet(nextStateKey, nextActs[0]);
        for (const na of nextActs) {
          const v = qGet(nextStateKey, na);
          if (v > maxNextQ) maxNextQ = v;
        }
      }

      const oldQ = qGet(stateKey, a);
      qSet(stateKey, a, oldQ + LR * (reward + DISCOUNT * maxNextQ - oldQ));

      totalReward += reward;
      cur = a;
      mask = newMask;
      if (a === finishIdx) break;
    }
    epsilon = Math.max(EPSILON_END, epsilon * EPSILON_DECAY);
  }

  // Extract greedy policy
  const order = [];
  let cur = startIdx, mask = 0;
  while (true) {
    const acts = validActions(cur, mask);
    if (acts.length === 0) break;
    let best = acts[0], bestQ = qGet(`${cur}_${mask}`, acts[0]);
    for (const a of acts) {
      const v = qGet(`${cur}_${mask}`, a);
      if (v > bestQ) { bestQ = v; best = a; }
    }
    order.push(best);
    if (best >= 1 && best <= numCheese) mask |= (1 << (best-1));
    cur = best;
    if (best === finishIdx) break;
  }
  return order;
}

// ── Build full cell-by-cell path through chosen waypoint order ─
function buildFullPath(order, waypoints, paths) {
  let cur = 0; // start
  const full = [];
  for (const next of order) {
    const segment = paths[cur][next];
    if (!segment) continue;
    if (full.length > 0) full.push(...segment.slice(1));
    else full.push(...segment);
    cur = next;
  }
  return full;
}

// ── Bot state ─────────────────────────────────────────────────
let botRat = null;
let botPath = [];        // array of [r, c] cells to walk through
let botPathIdx = 0;
let botPos = new THREE.Vector3();
let botYaw = 0;
let botSpeed = 0;
let botRunning = false;
let botStarted = false;
let botCheesePositions = []; // world positions of cheese collected
let trainedCount = 0;

// ── Train and get path ────────────────────────────────────────
export function trainBot() {
  const gw = getGW(), gh = getGH(), grid = getGrid();
  const cheeseCells = cheeses.map(c => {
    return {
      r: Math.round(c.position.z / 4 + (gh - 1) / 2),
      c: Math.round(c.position.x / 4 + (gw - 1) / 2),
    };
  });

  // Waypoints: [start, ...cheeses, finish]
  const waypoints = [
    { r: 1, c: 1 },
    ...cheeseCells,
    { r: gh-2, c: gw-2 },
  ];

  console.log('Bot waypoints:', waypoints.length, '(1 start +', cheeseCells.length, 'cheese + 1 finish)');

  // Build distance matrix using BFS
  const { dist, paths } = buildDistanceMatrix(waypoints, grid, gw, gh);

  // Train Q-learning to find optimal visit order
  const order = trainRoutingQ(cheeseCells.length, dist);
  console.log('Optimal order:', order);

  // Build full cell-by-cell path
  botPath = buildFullPath(order, waypoints, paths);
  console.log('Full path length:', botPath.length);
  trainedCount++;
  return botPath;
}

// ── Create bot rat model ──────────────────────────────────────
export function createBotRat(color = '#ff4444') {
  if (botRat) { scene.remove(botRat); botRat = null; }
  botRat = new THREE.Group();
  new GLTFLoader().load(MODEL_URL, (gltf) => {
    const m = gltf.scene;
    m.scale.setScalar(MODEL_SCALE); m.rotation.y = MODEL_FACE; m.position.y = MODEL_Y;
    m.traverse(o => {
      if (o.isMesh) {
        if (Array.isArray(o.material)) {
          o.material = o.material.map(mat => {
            const m2 = mat.clone();
            m2.color.lerp(new THREE.Color(color), 0.7);
            m2.side = THREE.DoubleSide;
            return m2;
          });
        } else {
          o.material = o.material.clone();
          o.material.color.lerp(new THREE.Color(color), 0.7);
          o.material.side = THREE.DoubleSide;
        }
        o.castShadow = true;
      }
    });
    botRat.add(m);
  });
  scene.add(botRat);
}

export function startBot() {
  trainBot();
  botPathIdx = 0;
  botRunning = true;
  botStarted = false;
  botSpeed = 0;
  if (botRat && botPath.length > 0) {
    const first = botPath[0];
    botPos.set(toWorldX(first[1]), 0, toWorldZ(first[0]));
    botRat.position.copy(botPos);
    botYaw = Math.PI/2;
    botRat.rotation.y = botYaw;
    botRat.visible = true;
  }
}

export function stopBot() {
  botRunning = false;
  if (botRat) botRat.visible = false;
}

export function isBotRunning() { return botRunning; }

// ── Tick: physics-based movement matching player ─────────────
export function tickBot(dt, playerStarted) {
  if (!botRunning || !botRat || botPath.length === 0) return;

  if (!playerStarted) {
    // Hold at start
    if (botPath.length > 0) {
      const first = botPath[0];
      botPos.set(toWorldX(first[1]), 0, toWorldZ(first[0]));
      botRat.position.copy(botPos);
    }
    return;
  }
  botStarted = true;

  // Skip cells that are very close, to advance to the next meaningful target
  if (botPathIdx >= botPath.length - 1) {
    // Reached end, decelerate
    botSpeed -= FRICTION * dt * Math.sign(botSpeed);
    if (Math.abs(botSpeed) < 0.1) botSpeed = 0;
    if (botSpeed > 0) {
      botPos.x += Math.sin(botYaw) * botSpeed * dt;
      botPos.z += Math.cos(botYaw) * botSpeed * dt;
    }
    botRat.position.copy(botPos);
    return;
  }

  // Aim at the next cell (look ahead 2 cells for smoother turning)
  // Blend between current target and next for smooth steering without cutting walls
  const immediateTarget = botPath[Math.min(botPathIdx + 1, botPath.length - 1)];
  const nextTarget = botPath[Math.min(botPathIdx + 2, botPath.length - 1)];
  // Use immediate target as primary, blend ~20% toward next for smoothness
  // Reduce lookahead when close to immediate target (avoid cutting corners)
  const immDist = Math.sqrt(
    (toWorldX(immediateTarget[1])-botPos.x)**2 +
    (toWorldZ(immediateTarget[0])-botPos.z)**2
  );
  const blendNext = immDist > 3 ? 0.28 : 0.05; // when close, follow exact path
  const blendImm = 1 - blendNext;
  const tx = toWorldX(immediateTarget[1]) * blendImm + toWorldX(nextTarget[1]) * blendNext;
  const tz = toWorldZ(immediateTarget[0]) * blendImm + toWorldZ(nextTarget[0]) * blendNext;
  const dx = tx - botPos.x;
  const dz = tz - botPos.z;
  const distToTarget = Math.sqrt(dx*dx + dz*dz);

  // Compute desired yaw to face target
  const desiredYaw = Math.atan2(dx, dz);
  let yawDiff = desiredYaw - botYaw;
  while (yawDiff > Math.PI) yawDiff -= 2*Math.PI;
  while (yawDiff < -Math.PI) yawDiff += 2*Math.PI;

  // Turn toward target — faster turn rate when needed to avoid overshooting
  const turnSpeed = TURN_RATE * 1.5; // bot can turn slightly faster than the cap
  const turnAmount = Math.sign(yawDiff) * Math.min(Math.abs(yawDiff), turnSpeed * dt);
  botYaw += turnAmount;

  // Current target cell (needed for both slowdown and advance logic)
  const curTarget = botPath[botPathIdx + 1];
  const ctx = toWorldX(curTarget[1]);
  const ctz = toWorldZ(curTarget[0]);
  const dCur = Math.sqrt((ctx-botPos.x)**2 + (ctz-botPos.z)**2);

  
  // Slow down before corners - look ahead to see if next cell requires a turn
  const turnSharpness = Math.abs(yawDiff);
  // Look ahead at the next several cells to see if a sharp turn is coming
  let targetSpeed = MAX_SPEED;
  let cornerAngle = 0;
  let cornerDist = Infinity;
  for (let i = 1; i <= 4 && botPathIdx + i + 1 < botPath.length; i++) {
    const p0 = botPath[botPathIdx + i - 1];
    const p1 = botPath[botPathIdx + i];
    const p2 = botPath[botPathIdx + i + 1];
    // Vectors p0->p1 and p1->p2
    const v1x = p1[1] - p0[1], v1z = p1[0] - p0[0];
    const v2x = p2[1] - p1[1], v2z = p2[0] - p1[0];
    // Angle between them
    const a1 = Math.atan2(v1x, v1z);
    const a2 = Math.atan2(v2x, v2z);
    let angDiff = Math.abs(a2 - a1);
    if (angDiff > Math.PI) angDiff = 2*Math.PI - angDiff;
    if (angDiff > cornerAngle) {
      cornerAngle = angDiff;
      // Distance from bot to that corner
      const cx = toWorldX(p1[1]);
      const cz = toWorldZ(p1[0]);
      cornerDist = Math.sqrt((cx-botPos.x)**2 + (cz-botPos.z)**2);
    }
  }

  // Brake based on how sharp the upcoming corner is and how close it is
  // The closer + sharper the corner, the more we slow down
  if (cornerAngle > 1.2) {
    // 90° corner ahead
    if (cornerDist < 6)      targetSpeed = MAX_SPEED * 0.4;
    else if (cornerDist < 10) targetSpeed = MAX_SPEED * 0.65;
  } else if (cornerAngle > 0.7) {
    // ~45° corner ahead
    if (cornerDist < 5) targetSpeed = MAX_SPEED * 0.7;
  }
  // Extra slowdown when very close to current target cell (about to turn)
  if (dCur < 3.0 && botPathIdx + 2 < botPath.length) {
    const nextCell = botPath[botPathIdx + 2];
    const ndx = toWorldX(nextCell[1]) - ctx;
    const ndz = toWorldZ(nextCell[0]) - ctz;
    const nextDir = Math.atan2(ndx, ndz);
    let nextYawDiff = nextDir - botYaw;
    while (nextYawDiff > Math.PI) nextYawDiff -= 2*Math.PI;
    while (nextYawDiff < -Math.PI) nextYawDiff += 2*Math.PI;
    if (Math.abs(nextYawDiff) > 0.5) targetSpeed = Math.min(targetSpeed, MAX_SPEED * 0.4);
  }

  // Accelerate / decelerate toward target speed
  if (botSpeed < targetSpeed) {
    botSpeed = Math.min(botSpeed + ACCEL * dt, targetSpeed);
  } else if (botSpeed > targetSpeed) {
    botSpeed = Math.max(botSpeed - FRICTION * dt, targetSpeed);
  }

  // Move forward with wall collision
  const dxMove = Math.sin(botYaw) * botSpeed * dt;
  const dzMove = Math.cos(botYaw) * botSpeed * dt;
  if (!blocked(botPos.x + dxMove, botPos.z)) botPos.x += dxMove; else botSpeed *= 0.5;
  if (!blocked(botPos.x, botPos.z + dzMove)) botPos.z += dzMove; else botSpeed *= 0.5;

  // Advance path index when we get close to the current target
  if (dCur < 2.0) {
    botPathIdx++;
  }

  // Update model position + rotation
  botRat.position.copy(botPos);
  botRat.rotation.y = botYaw;

  // Bobbing
  const t = performance.now() * 0.001;
  botRat.position.y = Math.abs(botSpeed) > 0.5 ? Math.abs(Math.sin(t * 14)) * 0.12 : 0;
}