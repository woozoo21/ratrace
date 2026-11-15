// ============================================================
// BOT.JS — benchmark run planner (pure: no THREE / DOM)
//
// 1. Route:  exact shortest cheese order (Held-Karp dynamic programming).
// 2. Line:   each leg's cell path is pulled taut inside the corridor.
// 3. Driver: pure-pursuit steering + brake-distance speed planning, run
//            through the *same* stepVehicle() physics as the player.
// 4. Tuning: a seeded search over driver parameters keeps the fastest run.
//
// The result is a recording ({time, frames, splits}) that is replayed like a
// ghost, so it is frame-rate independent and a human could match it.
// ============================================================

import {
  TURN_RATE, MAX_SPEED, FIXED_DT, RAT_RADIUS, CHEESE_RADIUS, GATE_RADIUS,
  makeRNG, bfs, pathTo, isOpen, blocked, cellX, cellZ, colOf, rowOf,
  makeVehicle, stepVehicle, wrapAngle,
} from './core.js';

const MAX_SIM_TIME = 240;   // seconds of simulated racing before a candidate is abandoned
const STALL_TIME   = 45;    // …or this long without collecting anything
const RECORD_EVERY = 2;     // ticks between recorded frames
const SEARCH_RUNS  = 140;   // driver-parameter candidates tried per plan

const DEFAULTS = {   // medians of the best parameters found across many mazes
  look0: 2, lookV: 0.15, kp: 7, cornerK: 11, brake: 31, tipDead: 15, tipOpen: 7,
  revIn: 2.25, revOut: 1.35, margin: 0.34, iters: 26, errK: 0.17,
};
const RANGES = {
  look0: [1.5, 5], lookV: [0, 0.25], kp: [2, 10], cornerK: [1.5, 16], brake: [15, 40],
  tipDead: [3, 24], tipOpen: [2, 14], revIn: [1.6, 3.3], revOut: [0.5, 1.5],
  margin: [0.05, 0.5], iters: [5, 60], errK: [0, 0.6],
};

// ── Route: optimal visiting order ────────────────────────────
// cost is (n+2)×(n+2): index 0 = start, 1..n = cheeses, n+1 = finish.
function bestOrder(n, cost) {
  if (n === 0) return [];
  if (n > 15) return greedyOrder(n, cost);
  const full = 1 << n;
  const dp  = new Float64Array(full * n).fill(Infinity);
  const par = new Int8Array(full * n).fill(-1);
  for (let j = 0; j < n; j++) dp[(1 << j) * n + j] = cost[0][j + 1];
  for (let mask = 1; mask < full; mask++) {
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = dp[mask * n + j];
      if (cur === Infinity) continue;
      const row = cost[j + 1];
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const idx = (mask | (1 << k)) * n + k, val = cur + row[k + 1];
        if (val < dp[idx]) { dp[idx] = val; par[idx] = j; }
      }
    }
  }
  let end = 0, best = Infinity;
  for (let j = 0; j < n; j++) {
    const val = dp[(full - 1) * n + j] + cost[j + 1][n + 1];
    if (val < best) { best = val; end = j; }
  }
  const order = [];
  for (let mask = full - 1, j = end; j !== -1;) {
    order.push(j);
    const p = par[mask * n + j];
    mask ^= 1 << j; j = p;
  }
  return order.reverse();
}

function greedyOrder(n, cost) {
  const order = [], used = new Uint8Array(n);
  let cur = 0;
  for (let step = 0; step < n; step++) {
    let best = -1;
    for (let k = 0; k < n; k++) if (!used[k] && (best === -1 || cost[cur][k + 1] < cost[cur][best + 1])) best = k;
    used[best] = 1; order.push(best); cur = best + 1;
  }
  return order;
}

function countTurns(cells) {
  let turns = 0;
  for (let i = 2; i < cells.length; i++) {
    if (cells[i].r - cells[i - 1].r !== cells[i - 1].r - cells[i - 2].r ||
        cells[i].c - cells[i - 1].c !== cells[i - 1].c - cells[i - 2].c) turns++;
  }
  return turns;
}

// ── Planner ──────────────────────────────────────────────────
/**
 * @param maze         core.js maze
 * @param cheeseCells  [{r,c}, …] cheeses to collect before the finish
 * @param seed         makes the parameter search repeatable (same maze → same bot)
 * @returns {{time:number, frames:Array, splits:number[]}|null}
 */
export function planBotRun(maze, cheeseCells, seed = 1) {
  const n = cheeseCells.length;
  const { gw } = maze;
  const cheeseX = cheeseCells.map(p => cellX(maze, p.c));
  const cheeseZ = cheeseCells.map(p => cellZ(maze, p.r));
  const finX = cellX(maze, maze.finish.c), finZ = cellZ(maze, maze.finish.r);

  const searches = new Map();
  const searchFrom = (r, c) => {
    const key = r * gw + c;
    let s = searches.get(key);
    if (!s) { s = bfs(maze, r, c); searches.set(key, s); }
    return s;
  };
  const route = (a, b) => pathTo(maze, searchFrom(a.r, a.c), b.r, b.c);

  // Candidate orders: shortest by distance, and with corners costed as extra cells.
  const waypoints = [maze.start, ...cheeseCells, maze.finish];
  const legs = waypoints.map(a => waypoints.map(b => route(a, b)));
  if (legs[0].some(p => !p)) return null;                    // something is unreachable
  const orders = new Map();
  for (const turnCost of [0, 1, 2.5]) {
    const cost = legs.map(row => row.map(p => p.length - 1 + turnCost * countTurns(p)));
    const order = bestOrder(n, cost);
    orders.set(order.join(','), order);
  }

  // ── Leg path: taut line through the corridor ───────────────
  function buildPath(v, P, target, next, tx, tz) {
    const here = { r: rowOf(maze, v.z), c: colOf(maze, v.x) };
    const a = route(here, target);
    if (!a) return null;
    let cells = a, reversal = false;
    if (next) {
      const b = route(target, next);
      reversal = b.length > 1 && a.length > 1 &&
                 b[1].r === a[a.length - 2].r && b[1].c === a[a.length - 2].c;
      if (!reversal) cells = a.concat(b.slice(1));
    }

    // Raw polyline: current position, then cell centres, subdivided to ~1 unit.
    const px = [v.x], pz = [v.z];
    let pin = -1;                                            // point that must stay on the cheese
    const push = (x, z) => {
      const lx = px[px.length - 1], lz = pz[pz.length - 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, z - lz)));
      for (let k = 1; k <= steps; k++) { px.push(lx + (x - lx) * k / steps); pz.push(lz + (z - lz) * k / steps); }
    };
    if (cells.length === 1) push(cellX(maze, cells[0].c), cellZ(maze, cells[0].r));
    for (let i = 1; i < cells.length; i++) {
      push(cellX(maze, cells[i].c), cellZ(maze, cells[i].r));
      if (i === a.length - 1 && cells !== a) pin = px.length - 1;
    }

    const N = px.length, rad = RAT_RADIUS + P.margin, pinR = CHEESE_RADIUS - 0.6;
    for (let it = 0; it < P.iters; it++) {
      for (let i = 1; i < N - 1; i++) {
        const nx = px[i] + 0.5 * ((px[i - 1] + px[i + 1]) / 2 - px[i]);
        const nz = pz[i] + 0.5 * ((pz[i - 1] + pz[i + 1]) / 2 - pz[i]);
        if (i === pin && Math.hypot(nx - tx, nz - tz) > pinR) continue;
        if (!blocked(maze, nx, nz, rad)) { px[i] = nx; pz[i] = nz; }
      }
    }

    // Arc length + a speed cap per point from how sharply the line bends there.
    const s = new Float64Array(N), vmax = new Float64Array(N).fill(MAX_SPEED);
    for (let i = 1; i < N; i++) s[i] = s[i - 1] + Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]);
    for (let i = 1; i < N - 1; i++) {
      const bend = Math.abs(wrapAngle(
        Math.atan2(px[i + 1] - px[i], pz[i + 1] - pz[i]) - Math.atan2(px[i] - px[i - 1], pz[i] - pz[i - 1])));
      const ds = (s[i + 1] - s[i - 1]) / 2;
      if (bend > 1e-3 && ds > 1e-6) vmax[i] = Math.min(MAX_SPEED, P.cornerK * TURN_RATE * ds / bend);
    }
    if (reversal) {
      // The next leg doubles back: arrive at the pickup point slow enough to turn round.
      let open = 0;
      for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) if (isOpen(maze, target.r + dr, target.c + dc)) open++;
      const tip = open === 1 ? P.tipDead : P.tipOpen;
      for (let i = 0; i < N; i++) {
        if (Math.hypot(px[i] - tx, pz[i] - tz) <= CHEESE_RADIUS - 0.1) { vmax[i] = Math.min(vmax[i], tip); break; }
      }
    }
    return { px, pz, s, vmax, N, idx: 0 };
  }

  // ── One simulated run ──────────────────────────────────────
  function simulate(order, P, record) {
    const v = makeVehicle(maze);
    const input = { throttle: 0, turn: 0 };
    const got = new Uint8Array(n);
    const pickups = [], frames = record ? [{ t: 0, x: v.x, z: v.z, yaw: v.yaw }] : null;
    let left = n, oi = 0, path = null, rev = false, t = 0, tick = 0, lastEvent = 0;

    while (t < MAX_SIM_TIME) {
      while (oi < n && got[order[oi]]) { oi++; path = null; }
      if (!path) {
        const ci = oi < n ? order[oi] : -1;
        let ni = oi + 1;
        while (ni < n && got[order[ni]]) ni++;
        const target = ci === -1 ? maze.finish : cheeseCells[ci];
        const next   = ci === -1 ? null : (ni < n ? cheeseCells[order[ni]] : maze.finish);
        path = buildPath(v, P, target, next, ci === -1 ? finX : cheeseX[ci], ci === -1 ? finZ : cheeseZ[ci]);
        if (!path) return null;
      }

      // Progress: nearest path point, only ever moving forward.
      const { px, pz, s, vmax, N } = path;
      let idx = path.idx, bestD = (px[idx] - v.x) ** 2 + (pz[idx] - v.z) ** 2;
      for (let j = idx + 1; j < N && j <= path.idx + 5; j++) {
        const d = (px[j] - v.x) ** 2 + (pz[j] - v.z) ** 2;
        if (d <= bestD) { bestD = d; idx = j; }
      }
      path.idx = idx;

      // Steering target: a point `look` units further along the line.
      const look = P.look0 + P.lookV * Math.abs(v.speed);
      let aim = idx;
      while (aim < N - 1 && s[aim] - s[idx] < look) aim++;
      const yawErr = wrapAngle(Math.atan2(px[aim] - v.x, pz[aim] - v.z) - v.yaw);
      const absErr = Math.abs(yawErr);

      // Speed target: fastest speed from which every cap ahead is still reachable by braking.
      let vT = MAX_SPEED * Math.max(0.15, 1 - P.errK * absErr);
      for (let j = idx; j < N && s[j] - s[idx] < 16; j++) {
        const lim = Math.sqrt(vmax[j] * vmax[j] + 2 * P.brake * (s[j] - s[idx]));
        if (lim < vT) vT = lim;
      }

      // Facing mostly the wrong way → back out while swinging the nose round (3-point turn).
      if (!rev && absErr > P.revIn) rev = true;
      else if (rev && absErr < P.revOut) rev = false;

      let rate;
      if (rev) { input.throttle = -1; rate = Math.sign(yawErr); }
      else {
        input.throttle = v.speed > vT + 0.5 ? -1 : v.speed > vT ? 0 : 1;
        rate = Math.max(-1, Math.min(1, P.kp * yawErr));
      }
      input.turn = v.speed < -0.3 ? -rate : rate;            // steering flips in reverse

      stepVehicle(v, input, maze, FIXED_DT);
      t += FIXED_DT; tick++;

      for (let i = 0; i < n; i++) {
        if (!got[i] && Math.hypot(cheeseX[i] - v.x, cheeseZ[i] - v.z) < CHEESE_RADIUS) {
          got[i] = 1; left--; pickups.push(t); lastEvent = t;
        }
      }
      const done = left === 0 && Math.hypot(finX - v.x, finZ - v.z) < GATE_RADIUS;
      if (record && (done || tick % RECORD_EVERY === 0)) {
        frames.push({ t: round3(t), x: round3(v.x), z: round3(v.z), yaw: round3(v.yaw) });
      }
      if (done) {
        const marks = [...pickups, t];
        return { time: t, frames, splits: marks.map((m, i) => m - (i ? marks[i - 1] : 0)) };
      }
      if (t - lastEvent > STALL_TIME) return null;
    }
    return null;
  }

  const timeOf = (order, P) => { const r = simulate(order, P, false); return r ? r.time : Infinity; };

  // Pick the order that actually drives fastest, then tune the driver on it.
  let order = null, best = Infinity, bestP = DEFAULTS;
  for (const cand of orders.values()) {
    const time = timeOf(cand, DEFAULTS);
    if (time < best || !order) { best = time; order = cand; }
  }
  const rand = makeRNG(seed ^ 0x51ED270B);
  const keys = Object.keys(RANGES);
  for (let i = 0; i < SEARCH_RUNS; i++) {
    const P = {};
    const explore = i < SEARCH_RUNS * 0.4 || best === Infinity;
    for (const k of keys) {
      const [lo, hi] = RANGES[k];
      const val = explore ? lo + rand() * (hi - lo)                      // wide sample
                          : bestP[k] + (rand() - 0.5) * (hi - lo) * 0.25; // refine around the best
      P[k] = Math.max(lo, Math.min(hi, val));
    }
    P.iters = Math.round(P.iters);
    const time = timeOf(order, P);
    if (time < best) { best = time; bestP = P; }
  }
  return best === Infinity ? null : simulate(order, bestP, true);
}

const round3 = (x) => Math.round(x * 1000) / 1000;
