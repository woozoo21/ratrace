// ============================================================
// CONTROLS.JS — keyboard + touch joystick → { throttle, turn }
// ============================================================

const JOY_RADIUS  = 64;     // px of thumb travel for full deflection
const DEAD        = 0.12;   // radial dead zone (fraction of radius)
const TURN_DEAD   = 0.15;   // extra sideways dead zone so "straight ahead" stays straight
const REVERSE_AT  = 0.45;   // pull down past this fraction to reverse
const ZONE        = 0.5;    // left share of the screen that drives; the rest orbits the camera

const keys = new Set();
const joy  = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
let base = null, thumb = null, surface = null;

// ── Keyboard ─────────────────────────────────────────────────
const isTyping = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
const SCROLL_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ']);

window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return;
  const k = e.key.toLowerCase();
  keys.add(k);
  if (SCROLL_KEYS.has(k)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
// A key released while the tab is hidden never sends keyup — don't leave it stuck down.
window.addEventListener('blur', () => { keys.clear(); releaseJoy(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { keys.clear(); releaseJoy(); } });

// ── Joystick ─────────────────────────────────────────────────
function buildJoystick() {
  base = document.createElement('div');
  base.id = 'joyBase';
  base.innerHTML = '<div id="joyReverse"></div><div id="joyThumb"></div>';
  thumb = base.lastChild;
  const style = document.createElement('style');
  style.textContent = `
    #joyBase { position:fixed; left:${JOY_RADIUS + 28}px; bottom:${JOY_RADIUS + 28}px; top:auto;
      width:${JOY_RADIUS * 2}px; height:${JOY_RADIUS * 2}px; margin:${-JOY_RADIUS}px;
      border-radius:50%; background:rgba(255,255,255,0.12); border:2px solid rgba(255,255,255,0.4);
      z-index:15; pointer-events:none; opacity:0.45; transition:opacity 0.15s; }
    #joyBase.live { opacity:1; }
    #joyThumb { position:absolute; left:50%; top:50%; width:${JOY_RADIUS * 0.8}px; height:${JOY_RADIUS * 0.8}px;
      margin:${-JOY_RADIUS * 0.4}px; border-radius:50%; background:rgba(45,224,192,0.7); border:2px solid #2de0c0; }
    #joyReverse { position:absolute; left:18%; right:18%; top:${50 + REVERSE_AT * 50}%; height:2px;
      background:rgba(255,80,80,0.7); }
    #joyReverse::after { content:'reverse'; position:absolute; left:0; right:0; top:3px; text-align:center;
      color:rgba(255,120,120,0.9); font:10px monospace; }`;
  document.head.appendChild(style);
  surface.parentNode.appendChild(base);
}

function placeThumb(dx, dy) { thumb.style.transform = `translate(${dx}px, ${dy}px)`; }

function releaseJoy() {
  if (joy.id === null) return;
  joy.id = null; joy.x = joy.y = 0;
  base.classList.remove('live');
  base.style.left = base.style.top = base.style.bottom = '';   // back to its resting corner
  placeThumb(0, 0);
}

function onDown(e) {
  if (e.pointerType === 'mouse' || joy.id !== null) return;
  if (e.target !== surface || e.clientX > window.innerWidth * ZONE) return;
  if (!base) buildJoystick();
  joy.id = e.pointerId; joy.ox = e.clientX; joy.oy = e.clientY; joy.x = joy.y = 0;
  base.classList.add('live');
  base.style.left = e.clientX + 'px'; base.style.top = e.clientY + 'px'; base.style.bottom = 'auto';
  placeThumb(0, 0);
  claim(e);
}

function onMove(e) {
  if (e.pointerId !== joy.id) return;
  let dx = e.clientX - joy.ox, dy = e.clientY - joy.oy;
  const len = Math.hypot(dx, dy);
  if (len > JOY_RADIUS) { dx *= JOY_RADIUS / len; dy *= JOY_RADIUS / len; }
  placeThumb(dx, dy);
  joy.x = dx / JOY_RADIUS; joy.y = dy / JOY_RADIUS;
  claim(e);
}

function onUp(e) {
  if (e.pointerId !== joy.id) return;
  releaseJoy();
  claim(e);
}

// The driving finger must never reach OrbitControls, or it would also swing the camera.
function claim(e) { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }

/** @param canvas the game canvas — touches that start on its left side drive the rat. */
export function initControls(canvas) {
  surface = canvas;
  const opts = { capture: true, passive: false };
  window.addEventListener('pointerdown', onDown, opts);
  window.addEventListener('pointermove', onMove, opts);
  window.addEventListener('pointerup', onUp, opts);
  window.addEventListener('pointercancel', onUp, opts);
  // Show the resting joystick straight away on touch-first devices so it is discoverable.
  if (window.matchMedia('(pointer: coarse)').matches) buildJoystick();
}

export const isKeyDown = (k) => keys.has(k);

/** Fill `out` with the current driving input. */
export function readInput(out) {
  let throttle = 0, turn = 0;
  if (keys.has('w') || keys.has('arrowup')) throttle = 1;
  else if (keys.has('s') || keys.has('arrowdown')) throttle = -1;
  if (keys.has('a') || keys.has('arrowleft'))  turn += 1;
  if (keys.has('d') || keys.has('arrowright')) turn -= 1;

  const mag = Math.hypot(joy.x, joy.y);
  if (joy.id !== null && mag > DEAD) {
    // Any push drives forward at full throttle (so steering never costs speed);
    // pulling down past the red line reverses, harder the further you pull.
    throttle = joy.y > REVERSE_AT ? -(joy.y - REVERSE_AT) / (1 - REVERSE_AT) * 0.6 - 0.4 : 1;
    const ax = Math.abs(joy.x);
    const t = ax <= TURN_DEAD ? 0 : Math.min(1, (ax - TURN_DEAD) / (0.85 - TURN_DEAD));
    turn = -Math.sign(joy.x) * Math.pow(t, 1.4);          // gentle near centre, full lock at the rim
  }
  out.throttle = throttle; out.turn = turn;
  return out;
}
