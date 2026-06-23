// ============================================================
// CONTROLS.JS — mobile floating joystick (CODM-style)
// ============================================================

// Joystick state stored in window so engine.js physicsTick can read it
// window._joyAxis = { x: -1..1, y: -1..1 }  where:
//   y < 0  = forward (push up)
//   y > 0  = backward (push down)
//   x < 0  = left turn
//   x > 0  = right turn

window._joyAxis = { x: 0, y: 0 };

let joyTouchId  = null;
let joyOriginX  = 0;
let joyOriginY  = 0;
const JOY_RADIUS = 40;   // visual radius of the joystick
const JOY_DEAD   = 0.12; // % of radius below which we register no input

let _orbitRef = null;
export function attachOrbitControls(ctrl) { _orbitRef = ctrl; }

function isMobile() {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

function ensureDom() {
  if (document.getElementById('joyBase')) return;
  const base = document.createElement('div');
  base.id = 'joyBase';
  base.style.cssText = `
    position:fixed; display:none; pointer-events:none;
    width:${JOY_RADIUS*2}px; height:${JOY_RADIUS*2}px;
    border-radius:50%; background:rgba(255,255,255,0.12);
    border:2px solid rgba(255,255,255,0.35);
    z-index:60; transform:translate(-50%,-50%);
  `;
  const thumb = document.createElement('div');
  thumb.id = 'joyThumb';
  thumb.style.cssText = `
    position:absolute; top:50%; left:50%;
    width:${JOY_RADIUS*0.8}px; height:${JOY_RADIUS*0.8}px;
    border-radius:50%; background:rgba(255,211,90,0.55);
    border:2px solid #ffd35a;
    transform:translate(-50%,-50%);
  `;
  base.appendChild(thumb);
  document.body.appendChild(base);
}

function showJoyAt(x, y) {
  const base = document.getElementById('joyBase');
  if (!base) return;
  base.style.display = 'block';
  base.style.left = x + 'px';
  base.style.top  = y + 'px';
  const thumb = document.getElementById('joyThumb');
  if (thumb) thumb.style.transform = 'translate(-50%,-50%)';
}

function moveThumbTo(dx, dy) {
  const thumb = document.getElementById('joyThumb');
  if (!thumb) return;
  const len = Math.sqrt(dx*dx + dy*dy);
  const clampedLen = Math.min(len, JOY_RADIUS);
  let tx = 0, ty = 0;
  if (len > 0) {
    tx = (dx / len) * clampedLen;
    ty = (dy / len) * clampedLen;
  }
  thumb.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`;
}

function hideJoy() {
  const base = document.getElementById('joyBase');
  if (base) base.style.display = 'none';
}

function setAxisFromDelta(dx, dy) {
  const len = Math.sqrt(dx*dx + dy*dy);
  const norm = Math.min(len / JOY_RADIUS, 1);
  if (norm < JOY_DEAD) {
    window._joyAxis = { x: 0, y: 0 };
    return;
  }
  const angle = Math.atan2(dy, dx);
  // Angle in degrees, 0=right, 90=down, 180=left, -90/270=up
  const deg = (angle * 180 / Math.PI + 360) % 360;
  // Only allow reverse if pulled straight down (240° to 300°)
  // Otherwise clamp Y to 0 (no reverse)
  const scaled = (norm - JOY_DEAD) / (1 - JOY_DEAD);
  window._joyAxis = {
    x: Math.cos(angle) * scaled,
    y: Math.sin(angle) * scaled,
  };
  console.log('joy:', window._joyAxis);
}

// Decide whether a touch should be captured by the joystick.
// CODM rule: only touches that start on the LEFT half of the screen.
function shouldCaptureTouch(touch) {
  // Don't capture touches on buttons or inputs
  const target = document.elementFromPoint(touch.clientX, touch.clientY);
  if (target && (target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.closest('button'))) return false;
  // Don't capture touches over UI like minimap, info, hud
  if (target && (target.id === 'minimap' || target.closest('#info') || target.closest('#mpHud') || target.closest('#mobileMenu'))) return false;
  // Only capture left half of screen
  return touch.clientX < window.innerWidth / 2;
}

function initJoystick() {
  if (!isMobile()) return;
  ensureDom();

  window.addEventListener('touchstart', (e) => {
    if (joyTouchId !== null) return;
    for (const touch of e.changedTouches) {
      if (!shouldCaptureTouch(touch)) continue;
      joyTouchId = touch.identifier;
      joyOriginX = touch.clientX;
      joyOriginY = touch.clientY;
      showJoyAt(joyOriginX, joyOriginY);
      window._joyAxis = { x: 0, y: 0 };
      if (_orbitRef) _orbitRef.enabled = false;
      e.preventDefault();
      break;
    }
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    if (joyTouchId === null) return;
    for (const touch of e.changedTouches) {
      if (touch.identifier !== joyTouchId) continue;
      const dx = touch.clientX - joyOriginX;
      const dy = touch.clientY - joyOriginY;
      moveThumbTo(dx, dy);
      setAxisFromDelta(dx, dy);
      e.preventDefault();
      break;
    }
  }, { passive: false });

  function endTouch(e) {
    if (joyTouchId === null) return;
    let ended = false;
    for (const touch of e.changedTouches) {
      if (touch.identifier === joyTouchId) { ended = true; break; }
    }
    if (!ended) return;
    joyTouchId = null;
    window._joyAxis = { x: 0, y: 0 };
    hideJoy();
    if (_orbitRef) _orbitRef.enabled = true;
  }
  window.addEventListener('touchend', endTouch, { passive: true });
  window.addEventListener('touchcancel', endTouch, { passive: true });
}

export function initControls(orbitControls) {
  attachOrbitControls(orbitControls);
  initJoystick();
}