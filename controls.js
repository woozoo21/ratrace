window._joyAxis = { x: 0, y: 0 };

let joyTouchId = null;
let joyOriginX = 0, joyOriginY = 0;
const JOY_RADIUS = 80;
const JOY_DEAD = 0.1;

let _orbitRef = null;
export function attachOrbitControls(ctrl) { _orbitRef = ctrl; }

function isMobile() {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

let base, thumb;

function ensureDom() {
  if (base) return;
  base = document.createElement('div');
  base.style.position = 'fixed';
  base.style.display = 'none';
  base.style.pointerEvents = 'none';
  base.style.width = (JOY_RADIUS*2) + 'px';
  base.style.height = (JOY_RADIUS*2) + 'px';
  base.style.borderRadius = '50%';
  base.style.background = 'rgba(255,255,255,0.15)';
  base.style.border = '2px solid rgba(255,255,255,0.4)';
  base.style.zIndex = '60';
  base.style.marginLeft = (-JOY_RADIUS) + 'px';
  base.style.marginTop = (-JOY_RADIUS) + 'px';

  thumb = document.createElement('div');
  thumb.style.position = 'absolute';
  thumb.style.left = '50%';
  thumb.style.top = '50%';
  thumb.style.width = (JOY_RADIUS * 0.5) + 'px';
  thumb.style.height = (JOY_RADIUS * 0.5) + 'px';
  thumb.style.borderRadius = '50%';
  thumb.style.background = 'rgba(255,211,90,0.7)';
  thumb.style.border = '2px solid #ffd35a';
  thumb.style.marginLeft = (-JOY_RADIUS * 0.25) + 'px';
  thumb.style.marginTop = (-JOY_RADIUS * 0.25) + 'px';

  base.appendChild(thumb);
  // Reverse line indicator
  const revLine = document.createElement('div');
  revLine.style.position = 'absolute';
  revLine.style.left = '15%';
  revLine.style.right = '15%';
  revLine.style.top = '70%';
  revLine.style.height = '2px';
  revLine.style.background = 'rgba(255,80,80,0.7)';
  revLine.style.pointerEvents = 'none';
  revLine.style.zIndex = '2';
  base.appendChild(revLine);

  const revLabel = document.createElement('div');
  revLabel.textContent = '↓ reverse';
  revLabel.style.position = 'absolute';
  revLabel.style.left = '50%';
  revLabel.style.top = '78%';
  revLabel.style.transform = 'translateX(-50%)';
  revLabel.style.color = 'rgba(255,80,80,0.9)';
  revLabel.style.fontSize = '10px';
  revLabel.style.fontFamily = 'monospace';
  revLabel.style.pointerEvents = 'none';
  revLabel.style.zIndex = '2';
  base.appendChild(revLabel);
  
  document.body.appendChild(base);
}

function shouldCaptureTouch(touch) {
  const target = document.elementFromPoint(touch.clientX, touch.clientY);
  if (target && (target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.closest('button'))) return false;
  if (target && (target.id === 'minimap' || target.closest('#info') || target.closest('#mpHud') || target.closest('#mobileMenu'))) return false;
  return touch.clientX < window.innerWidth / 2;
}

function showJoy(x, y) {
  base.style.display = 'block';
  base.style.left = x + 'px';
  base.style.top = y + 'px';
  thumb.style.left = '50%';
  thumb.style.top = '50%';
}

function hideJoy() {
  base.style.display = 'none';
}

function updateJoy(dx, dy) {
  const len = Math.sqrt(dx*dx + dy*dy);
  const clampLen = Math.min(len, JOY_RADIUS);
  let tx = 0, ty = 0;
  if (len > 0) {
    tx = (dx / len) * clampLen;
    ty = (dy / len) * clampLen;
  }
  thumb.style.left = `calc(50% + ${tx}px)`;
  thumb.style.top  = `calc(50% + ${ty}px)`;

  const norm = clampLen / JOY_RADIUS;
  if (norm < JOY_DEAD) {
    window._joyAxis = { x: 0, y: 0 };
    return;
  }
  // Separate deadzone for X axis so going forward doesn't trigger small turns
  let normX = dx / JOY_RADIUS;
  let normY = dy / JOY_RADIUS;
  const X_DEAD = 0.25;
  if (Math.abs(normX) < X_DEAD) normX = 0;
  else normX = Math.sign(normX) * (Math.abs(normX) - X_DEAD) / (1 - X_DEAD);
  window._joyAxis = {
    x: Math.max(-1, Math.min(1, normX)),
    y: Math.max(-1, Math.min(1, normY)),
  };
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
      showJoy(joyOriginX, joyOriginY);
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
      updateJoy(touch.clientX - joyOriginX, touch.clientY - joyOriginY);
      e.preventDefault();
      break;
    }
  }, { passive: false });

  function endTouch(e) {
    if (joyTouchId === null) return;
    for (const touch of e.changedTouches) {
      if (touch.identifier !== joyTouchId) continue;
      joyTouchId = null;
      window._joyAxis = { x: 0, y: 0 };
      hideJoy();
      if (_orbitRef) _orbitRef.enabled = true;
      break;
    }
  }
  window.addEventListener('touchend', endTouch, { passive: true });
  window.addEventListener('touchcancel', endTouch, { passive: true });
}

export function initControls(orbitControls) {
  attachOrbitControls(orbitControls);
  initJoystick();
}