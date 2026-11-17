// ============================================================
// CORE.JS — pure game rules: maze, collision, vehicle physics.
// No THREE / DOM, so the player, the bot and tests share one model.
// ============================================================

export const CELL          = 4;
export const ACCEL         = 40;
export const FRICTION      = 20;
export const TURN_RATE     = 3;
export const MAX_SPEED     = 24;
export const REVERSE_SPEED = 7;
export const FIXED_DT      = 1 / 60;
export const RAT_RADIUS    = 1.1;
export const CHEESE_RADIUS = 2.0;   // horizontal distance
export const GATE_RADIUS   = 2.4;
export const START_YAW     = Math.PI / 2;

const DIRS = [[0, 1], [0, -1], [1, 0], [-1, 0]];

export function makeRNG(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Local calendar day as YYYYMMDD — the daily maze seed. */
export function dateSeed(d = new Date()) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// ── Maze ─────────────────────────────────────────────────────
// maze = { gw, gh, wall: Uint8Array(gw*gh), start:{r,c}, finish:{r,c} }

export function generateMaze(cw, ch, seed) {
  const gw = 2 * cw + 1, gh = 2 * ch + 1;
  const wall = new Uint8Array(gw * gh).fill(1);
  const rand = makeRNG(seed);
  const stack = [[1, 1]];
  wall[gw + 1] = 0;
  const dirs = [[0, -2], [0, 2], [-2, 0], [2, 0]];
  while (stack.length) {
    const [r, c] = stack[stack.length - 1];
    const opts = [];
    for (const [dr, dc] of dirs) {
      const nr = r + dr, nc = c + dc;
      if (nr > 0 && nr < gh - 1 && nc > 0 && nc < gw - 1 && wall[nr * gw + nc]) opts.push([nr, nc, dr, dc]);
    }
    if (opts.length) {
      const [nr, nc, dr, dc] = opts[(rand() * opts.length) | 0];
      wall[(r + dr / 2) * gw + c + dc / 2] = 0;
      wall[nr * gw + nc] = 0;
      stack.push([nr, nc]);
    } else stack.pop();
  }
  return { gw, gh, wall, start: { r: 1, c: 1 }, finish: { r: gh - 2, c: gw - 2 } };
}

/** Knock out a share of the interior walls so the maze has loops (several viable routes). */
export function braidMaze(maze, seed, fraction = 0.1) {
  const { gw, gh, wall } = maze;
  const rand = makeRNG(seed);
  for (let r = 1; r < gh - 1; r++) for (let c = 1; c < gw - 1; c++) {
    if (!wall[r * gw + c] || (r % 2) === (c % 2)) continue;   // only walls between two cells
    if (rand() < fraction) wall[r * gw + c] = 0;
  }
}

export const cellX = (maze, c) => (c - (maze.gw - 1) / 2) * CELL;
export const cellZ = (maze, r) => (r - (maze.gh - 1) / 2) * CELL;
export const colOf = (maze, x) => Math.round(x / CELL + (maze.gw - 1) / 2);
export const rowOf = (maze, z) => Math.round(z / CELL + (maze.gh - 1) / 2);
export const isOpen = (maze, r, c) =>
  r >= 0 && r < maze.gh && c >= 0 && c < maze.gw && !maze.wall[r * maze.gw + c];

export function isWallAt(maze, x, z) {
  return !isOpen(maze, rowOf(maze, z), colOf(maze, x));
}
export function blocked(maze, x, z, rad = RAT_RADIUS) {
  return isWallAt(maze, x + rad, z + rad) || isWallAt(maze, x - rad, z + rad) ||
         isWallAt(maze, x + rad, z - rad) || isWallAt(maze, x - rad, z - rad);
}

function openNeighbours(maze, r, c) {
  let n = 0;
  for (const [dr, dc] of DIRS) if (isOpen(maze, r + dr, c + dc)) n++;
  return n;
}

/**
 * Breadth-first search from (sr, sc).
 * Returns { dist, prev } as flat arrays indexed r*gw+c (dist -1 = unreachable).
 */
export function bfs(maze, sr, sc) {
  const { gw, gh } = maze;
  const dist = new Int16Array(gw * gh).fill(-1);
  const prev = new Int32Array(gw * gh).fill(-1);
  const queue = new Int32Array(gw * gh);
  let head = 0, tail = 0;
  queue[tail++] = sr * gw + sc;
  dist[sr * gw + sc] = 0;
  while (head < tail) {
    const cur = queue[head++];
    const r = (cur / gw) | 0, c = cur % gw;
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc, ni = nr * gw + nc;
      if (isOpen(maze, nr, nc) && dist[ni] === -1) {
        dist[ni] = dist[cur] + 1; prev[ni] = cur; queue[tail++] = ni;
      }
    }
  }
  return { dist, prev };
}

/** Cells [{r,c}, …] from the BFS origin to (er, ec), inclusive. null if unreachable. */
export function pathTo(maze, search, er, ec) {
  const { gw } = maze;
  let cur = er * gw + ec;
  if (search.dist[cur] === -1) return null;
  const path = [];
  while (cur !== -1) { path.push({ r: (cur / gw) | 0, c: cur % gw }); cur = search.prev[cur]; }
  return path.reverse();
}

// ── Cheese placement ─────────────────────────────────────────
function freeCells(maze) {
  const { gw, gh, start, finish } = maze;
  const cells = [];
  for (let r = 1; r < gh - 1; r++) for (let c = 1; c < gw - 1; c++) {
    if (!isOpen(maze, r, c)) continue;
    if ((r === start.r && c === start.c) || (r === finish.r && c === finish.c)) continue;
    cells.push({ r, c });
  }
  return cells;
}

/** Solo: `spread` distributes cheese evenly by distance from the start, else a seeded shuffle. */
export function soloCheeseCells(maze, seed, count, spread) {
  const open = freeCells(maze);
  if (spread) {
    const { dist } = bfs(maze, maze.start.r, maze.start.c);
    const reach = open.filter(p => dist[p.r * maze.gw + p.c] !== -1);
    reach.sort((a, b) => dist[b.r * maze.gw + b.c] - dist[a.r * maze.gw + a.c]);
    const step = Math.max(1, Math.ceil(reach.length / count));
    const chosen = [];
    for (let i = 0; i < reach.length && chosen.length < count; i += step) chosen.push(reach[i]);
    for (const cell of reach) {
      if (chosen.length >= count) break;
      if (!chosen.includes(cell)) chosen.push(cell);
    }
    return chosen;
  }
  const rand = makeRNG(seed + 777);
  for (let i = open.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    [open[i], open[j]] = [open[j], open[i]];
  }
  return open.slice(0, count);
}

/**
 * Multiplayer: one cheese, off the shortest start→finish route and late in the
 * race, so grabbing it is a real detour-versus-payoff decision.
 */
export function multiCheeseCell(maze) {
  const { gw, start, finish } = maze;
  const fromStart = bfs(maze, start.r, start.c);
  const fromFin   = bfs(maze, finish.r, finish.c);
  const total     = fromStart.dist[finish.r * gw + finish.c];
  const onRoute   = new Set((pathTo(maze, fromStart, finish.r, finish.c) || []).map(p => p.r * gw + p.c));

  const all = freeCells(maze)
    .filter(p => fromStart.dist[p.r * gw + p.c] !== -1 && !onRoute.has(p.r * gw + p.c))
    .map(p => ({
      ...p,
      ds: fromStart.dist[p.r * gw + p.c],
      df: fromFin.dist[p.r * gw + p.c],
      open: openNeighbours(maze, p.r, p.c),
    }));
  const late = all.filter(p => p.ds >= total * 0.7 && p.df >= total * 0.2);
  const pool = late.length ? late : all;
  if (!pool.length) return null;
  const score = p => Math.abs(p.ds - total * 0.7);
  const rank  = p => (p.open === 2 ? 0 : p.open === 1 ? 1 : 2);   // corridor, then dead end, then junction
  pool.sort((a, b) => rank(a) - rank(b) || score(a) - score(b) || a.r - b.r || a.c - b.c);
  return { r: pool[0].r, c: pool[0].c };
}

// ── Vehicle ──────────────────────────────────────────────────
// v = { x, z, yaw, speed };  input = { throttle: -1..1, turn: -1..1 } (turn > 0 = left)

/** Spawn facing the start cell's open exit: east if open, else south (start is the top-left corner). */
export function startYaw(maze) {
  const { r, c } = maze.start;
  if (isOpen(maze, r, c + 1)) return Math.PI / 2;   // +x
  if (isOpen(maze, r + 1, c)) return 0;             // +z
  return START_YAW;
}

export function makeVehicle(maze) {
  return { x: cellX(maze, maze.start.c), z: cellZ(maze, maze.start.r), yaw: startYaw(maze), speed: 0 };
}

export function stepVehicle(v, input, maze, dt, maxSpeed = MAX_SPEED, frozen = false) {
  if (frozen) {
    v.speed = 0;
  } else if (Math.abs(input.throttle) > 0.01) {
    v.speed += ACCEL * dt * input.throttle;
  } else {
    v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), FRICTION * dt);
  }
  if (v.speed > maxSpeed) v.speed = maxSpeed;
  else if (v.speed < -REVERSE_SPEED) v.speed = -REVERSE_SPEED;

  // Steering reverses with direction of travel (like a car); slower when pivoting on the spot.
  if (Math.abs(v.speed) > 0.3) v.yaw += input.turn * TURN_RATE * dt * Math.sign(v.speed);
  else                         v.yaw += input.turn * TURN_RATE * 0.6 * dt;

  const dx = Math.sin(v.yaw) * v.speed * dt, dz = Math.cos(v.yaw) * v.speed * dt;
  if (!blocked(maze, v.x + dx, v.z)) v.x += dx; else v.speed *= 0.9;
  if (!blocked(maze, v.x, v.z + dz)) v.z += dz; else v.speed *= 0.9;
}

// ── Recorded runs (ghost / bot replay) ───────────────────────
export function wrapAngle(a) {
  while (a >  Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Interpolate frames [{t,x,z,yaw}] at time t into `out`. Returns false if there is nothing to show. */
export function sampleRun(frames, t, out) {
  if (!frames || frames.length < 2) return false;
  let lo = 0, hi = frames.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (frames[mid].t <= t) lo = mid; else hi = mid; }
  const a = frames[lo], b = frames[hi];
  const span = b.t - a.t;
  const k = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
  out.x = a.x + (b.x - a.x) * k;
  out.z = a.z + (b.z - a.z) * k;
  out.yaw = a.yaw + wrapAngle(b.yaw - a.yaw) * k;
  return true;
}

// ── Text ─────────────────────────────────────────────────────
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Player names come from other people — never put them in innerHTML unescaped. */
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
/** Trimmed display name that is also safe as a database key. */
export const cleanName = (s) => String(s || '').replace(/[\/\\.#$\[\]\x00-\x1f]/g, '').trim().slice(0, 14) || 'Anon';
