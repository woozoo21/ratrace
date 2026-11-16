// ============================================================
// MENU.JS — home screen: one fixed, pre-planned bot run played in slow motion
// behind the menu, filmed as a looping reel of six shots (two still, four of the run)
// ============================================================

import * as THREE from 'three';
import {
  initEngine, startLoop, stopLoop, setMaze, setCheeses, removeCheese, touchedCheese, cheeses,
  setGateOpen, setCameraDirector, player,
} from './engine.js';
import { generateMaze, soloCheeseCells, sampleRun, blocked } from './core.js';
import { planBotRun } from './bot.js';

// The reel always films the same maze (not the daily one), so it looks the same every day.
// Seed 12 has a long straight out of the start and no dead end in the stretch the reel covers.
const REEL_SEED  = 12;
const MAZE_CELLS = 6, CHEESE = 6;
const NARROW     = 700;       // px; below this the menu is a bottom sheet, so the subject moves up instead of right
const SLOW       = 0.32;      // the run plays in slow motion
const STILL_SHOTS = 2;        // the rat waits at the start for the first shots, then runs
const END_MARGIN = 12;        // world units before the finish where the run holds (the lead camera needs path ahead)
const HEAD_Y     = 1.1;
const LOOK_RATE  = 10, OFFSET_RATE = 7, LIFT_RATE = 14;   // height eases faster, so the camera clears a wall before it crosses it
const MIN_GAP    = 6.5;       // a corridor-level camera never gets closer to the rat than this
const CHEESE_CLEAR = 3.5;     // cheeses this close to a corridor-level camera are hidden so they can't fill the lens
const REDUCED    = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const mix  = (a, b, k) => a + (b - a) * k;

let on = false, booted = false, hooks = {};
let maze = null, cells = null;
let frames = null, cum = null, total = 0;                  // the bot's run and distance travelled at each frame
let t = 0, shot = 0, shotT = 0, snap = true, craneFrom = 0;
const want = new THREE.Vector3(), look = new THREE.Vector3(), lookNow = new THREE.Vector3();
const off = new THREE.Vector3(), offNow = new THREE.Vector3();   // camera position relative to the rat
const ahead = { x: 0, z: 0 };

// ── The bot's path, addressed by distance ────────────────────
function prepRun(run) {
  cum = new Float32Array(run.frames.length);
  for (let i = 1; i < run.frames.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(run.frames[i].x - run.frames[i - 1].x, run.frames[i].z - run.frames[i - 1].z);
  }
  total = cum[cum.length - 1];
  frames = run.frames;
}

function distAt(time) {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (frames[mid].t <= time) lo = mid; else hi = mid; }
  const span = frames[hi].t - frames[lo].t;
  const k = span > 0 ? Math.min(1, Math.max(0, (time - frames[lo].t) / span)) : 0;
  return mix(cum[lo], cum[hi], k);
}

function pointAt(s, out) {
  s = Math.min(total, Math.max(0, s));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const span = cum[hi] - cum[lo], k = span > 0 ? (s - cum[lo]) / span : 0;
  out.x = mix(frames[lo].x, frames[hi].x, k);
  out.z = mix(frames[lo].z, frames[hi].z, k);
  return out;
}

// ── Shots ────────────────────────────────────────────────────
/**
 * Put the camera `d` units in front of the rat, looking back at its face.
 * Normally that point is on the rat's own route, which is always inside a corridor. Where the route
 * doubles back (a dead end) it would land behind the rat, so the camera goes straight out along the
 * nose instead — and up over the wall if there is no room in front.
 * `side` slides it across the corridor (keep within ±1.3).
 */
function lead(view, s, yaw, d, y, side = 0) {
  pointAt(s + d, ahead);
  let dx = ahead.x - view.x, dz = ahead.z - view.z, len = Math.hypot(dx, dz);
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  if (len < d * 0.6 || dx * fx + dz * fz < 0) {
    let f = 0;
    while (f < d && !blocked(maze, view.x + fx * (f + 0.5), view.z + fz * (f + 0.5), 0.5)) f += 0.5;
    if (f < MIN_GAP) { f = 2.6; y = Math.max(y, 8); }      // nose to a wall: look down on the face from over it
    dx = fx * f; dz = fz * f; len = f;
  }
  want.set(view.x + dx - dz / len * side, y, view.z + dz + dx / len * side);
}

/** The wide shot: high over the maze, swinging round in front of the rat and coming down toward it. */
function crane(e, v, s, yaw) {
  if (snap) craneFrom = Math.atan2(Math.cos(yaw), Math.sin(yaw));   // start out in front of wherever the rat is heading
  const a = craneFrom - 0.45 + e * 0.9, r = mix(20, 12, e);
  want.set(v.x + Math.cos(a) * r, mix(32, 15, e), v.z + Math.sin(a) * r);
  return 40;
}

// Each shot: (e = eased 0→1, view, s = distance run, yaw) → sets `want`, returns the field of view.
// The first STILL_SHOTS are filmed with the rat standing at the start; the rest follow the run.
const SHOTS = [
  { name: 'still front', dur: 4.6, fn: (e, v, s, yaw) => { lead(v, s, yaw, 9.5, mix(1.7, 1.4, e), mix(-1.2, 1.2, e));             return 44; } },
  { name: 'still drop',  dur: 4.6, fn: (e, v, s, yaw) => { lead(v, s, yaw, mix(8, 9.5, e), mix(7.5, 1.6, e), mix(0.5, 0, e));     return 42; } },
  { name: 'run lead',    dur: 4.6, fn: (e, v, s, yaw) => { lead(v, s, yaw, mix(8.5, 7.5, e), mix(2.3, 1.5, e));                   return 50; } },
  { name: 'run low',     dur: 4.2, fn: (e, v, s, yaw) => { lead(v, s, yaw, mix(8.2, 7.4, e), 0.4, 0.6);                           return 52; } },
  { name: 'run above',   dur: 4.4, fn: (e, v, s, yaw) => { lead(v, s, yaw, mix(7, 8, e), mix(9, 7, e));                           return 46; } },
  { name: 'run crane',   dur: 4.2, fn: crane },
];
const WIDE = SHOTS.length - 1;
export const SHOT_COUNT = SHOTS.length;

function nextShot() {
  shot = (shot + 1) % SHOTS.length;
  shotT = 0;
  snap = true;                                             // a cut: jump, don't glide
  if (shot === 0) resetRun();                              // every loop of the reel is the same footage
  hooks.cut?.(shot);
}

/** Shift the picture so the subject sits clear of the menu (a lens shift: no change in perspective). */
function frameSubject(cam) {
  const w = window.innerWidth, h = window.innerHeight;
  if (w > NARROW) cam.setViewOffset(w, h, -w * 0.16, 0, w, h);
  else cam.setViewOffset(w, h, 0, h * 0.16, w, h);
}

function direct(dt, view, yaw, cam) {
  const still = REDUCED || !frames;                        // one calm wide shot
  const def = still ? SHOTS[WIDE] : SHOTS[shot];
  shotT += dt;
  if (!still && shotT >= def.dur) { nextShot(); return direct(0, view, yaw, cam); }
  const u = still ? 0.5 + Math.sin(shotT * 0.15) * 0.5 : shotT / def.dur;
  cam.fov = def.fn(ease(u), view, frames ? distAt(t) : 0, yaw);
  look.set(view.x + Math.sin(yaw) * 0.5, HEAD_Y, view.z + Math.cos(yaw) * 0.5);
  // Ease the camera's offset from the rat, not its position: it glides between placements without falling behind.
  off.set(want.x - view.x, want.y, want.z - view.z);
  if (snap) { offNow.copy(off); lookNow.copy(look); snap = false; }
  else {
    const k = 1 - Math.exp(-OFFSET_RATE * dt);
    offNow.x += (off.x - offNow.x) * k;
    offNow.z += (off.z - offNow.z) * k;
    offNow.y += (off.y - offNow.y) * (1 - Math.exp(-LIFT_RATE * dt));
    lookNow.lerp(look, 1 - Math.exp(-LOOK_RATE * dt));
  }
  const gap = Math.hypot(offNow.x, offNow.z);
  if (offNow.y < 3 && gap < MIN_GAP && gap > 0.01) { offNow.x *= MIN_GAP / gap; offNow.z *= MIN_GAP / gap; }
  cam.position.set(view.x + offNow.x, offNow.y, view.z + offNow.z);
  // Hide a cheese that would fill the lens or sit between the lens and the face; it comes back as the rat reaches it.
  const cx = cam.position.x, cz = cam.position.z, sx = view.x - cx, sz = view.z - cz, sLen2 = sx * sx + sz * sz || 1;
  for (const ch of cheeses) {
    const k = Math.min(1, Math.max(0, ((ch.x - cx) * sx + (ch.z - cz) * sz) / sLen2));
    const offLine = Math.hypot(ch.x - (cx + sx * k), ch.z - (cz + sz * k));
    const nearRat = Math.hypot(ch.x - view.x, ch.z - view.z) < 3;
    ch.mesh.visible = cam.position.y > 4 || nearRat ||
      (offLine > 1.8 && Math.hypot(ch.x - cx, ch.z - cz) > CHEESE_CLEAR);
  }
  frameSubject(cam);
  cam.lookAt(lookNow);
  if (!still) hooks.shot?.(shot, u);
}

// ── The run ──────────────────────────────────────────────────
function resetRun() {
  t = 0;
  setCheeses(cells);
  setGateOpen(false);
}

function fixed(dt) {
  if (!frames) return;
  const running = !REDUCED && shot >= STILL_SHOTS && distAt(t) < total - END_MARGIN;
  if (running) t += dt * SLOW;
  sampleRun(frames, t, player);
  player.speed = running ? 10 : 0;                         // the running bob only while it runs
  for (let i; (i = touchedCheese()) !== -1;) removeCheese(i);
  if (!cheeses.length) setGateOpen(true);
}

// ── Entry points ─────────────────────────────────────────────
/**
 * @param h optional UI hooks: progress(0..1) and ready() during the first load,
 *          cut(shotIndex) on every camera cut, shot(shotIndex, 0..1) every frame.
 */
export function startHome(gameScreen, h = {}) {
  if (on) return;
  on = true;
  hooks = h;

  let loaded = false, planned = false, told = false;
  const settle = () => { if (loaded && planned && !told) { told = true; hooks.ready?.(); } };
  if (!booted) {
    THREE.DefaultLoadingManager.onProgress = (url, n, of) => hooks.progress?.(n / of);
    THREE.DefaultLoadingManager.onLoad = () => { loaded = true; settle(); };
    setTimeout(() => { loaded = true; settle(); }, 8000);  // never leave the cover up over a slow asset
  }
  initEngine(gameScreen);
  if (!maze) {
    maze = generateMaze(MAZE_CELLS, MAZE_CELLS, REEL_SEED);
    cells = soloCheeseCells(maze, REEL_SEED, CHEESE, false);
  }
  setMaze(maze);
  resetRun();
  player.speed = 0;
  shot = 0; shotT = 0; snap = true;
  setCameraDirector(direct);
  startLoop(fixed, () => {});
  hooks.cut?.(0);

  if (!booted) {
    booted = true;
    setTimeout(() => {                                     // plan after the cover has painted
      const run = planBotRun(maze, cells, REEL_SEED);
      if (run && run.frames.length > 2) { prepRun(run); if (total <= END_MARGIN * 2) frames = null; }
      shotT = 0; snap = true;
      planned = true;
      settle();
    }, 60);
  }
}

export function stopHome() {
  if (!on) return;
  on = false;
  stopLoop();
  setCameraDirector(null);
}
