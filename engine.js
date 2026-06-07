// ============================================================
// ENGINE.JS — shared Three.js setup, maze, physics, minimap
// ============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const ASSETS = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples';
export const MODEL_URL   = './rat.glb';
export const CHEESE_URL  = './cheese.glb';
export const MODEL_SCALE = 1;
export const MODEL_Y     = 0;
export const MODEL_FACE  = 0;
export const CHEESE_SCALE = 1;
export const CHEESE_Y    = 1;
export const CHEESE_GLOW = 0.18;
export const CELL        = 4;
export const WALL_H      = 3;
export const ACCEL       = 38;
export const FRICTION    = 20;
export const TURN_RATE   = 3;
export const MAX_SPEED   = 24;
export const FIXED_DT    = 1 / 60;

// ── State ────────────────────────────────────────────────────
export let renderer, scene, camera, orbitControls, skybox;
export let sun, ambient, hemi, pointLamp, spot;
export let wallGeo, wallMat;
export let cheeseMat, cheeseGeo;
export let rat, ghostRat;
export let cheeseTemplate = null;
export let cheeseMats = [];
export let mazeGroup;

export let GW, GH, grid;
export let startPos = new THREE.Vector3();
export let finishPos = new THREE.Vector3();
export let finishGate;
export let cheeses = [];

export let speed = 0, yaw = 0;
export let lastRat = new THREE.Vector3();
export const fwd = new THREE.Vector3();
export const clock = new THREE.Clock();
export let accumulator = 0;

export let nightMode = false;
export let followCam = true;
export let savedCamOffset = null;
export let minimapOn = true;

let _engineReady = false;
let _onCheeseLoaded = null;

// ── Setters (modules can't reassign exported primitives directly) ──
export function setSpeed(v)          { speed = v; }
export function setYaw(v)            { yaw = v; }
export function setAccumulator(v)    { accumulator = v; }
export function setNightMode(v)      { nightMode = v; }
export function setFollowCam(v)      { followCam = v; }
export function setSavedCamOffset(v) { savedCamOffset = v; }
export function setMinimapOn(v)      { minimapOn = v; }
export function setGW(v)             { GW = v; }
export function setGH(v)             { GH = v; }
export function setGrid(v)           { grid = v; }
export function setFinishGate(v)     { finishGate = v; }
export function clearCheeses()       { cheeses.length = 0; }
export function addCheese(c)         { cheeses.push(c); }
export function removeCheese(i)      { cheeses.splice(i, 1); }

export function makeRNG(seed) {
  let s = seed >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const toWorldX = (c) => (c - (GW - 1) / 2) * CELL;
export const toWorldZ = (r) => (r - (GH - 1) / 2) * CELL;
export const toCol    = (x) => Math.round(x / CELL + (GW - 1) / 2);
export const toRow    = (z) => Math.round(z / CELL + (GH - 1) / 2);

export function isWall(x, z) {
  const c = toCol(x), r = toRow(z);
  if (r < 0 || r >= GH || c < 0 || c >= GW) return true;
  return grid[r][c];
}
export function blocked(x, z) {
  const rad = 1.1;
  return isWall(x+rad,z+rad) || isWall(x-rad,z+rad) ||
         isWall(x+rad,z-rad) || isWall(x-rad,z-rad);
}

// ── Init ─────────────────────────────────────────────────────
export function initEngine(container, onReady) {
  if (_engineReady) { onReady(); return; }
  _engineReady = true;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x9bc4e2, 200, 900);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 18, 22);

  orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.enableDamping  = true;
  orbitControls.dampingFactor  = 0.06;
  orbitControls.maxPolarAngle  = Math.PI * 0.49;
  orbitControls.minDistance    = 8;
  orbitControls.maxDistance    = 70;

  // Skybox
  const cubeLoader = new THREE.CubeTextureLoader();
  cubeLoader.setPath(`${ASSETS}/textures/cube/SwedishRoyalCastle/`);
  skybox = cubeLoader.load(
    ['px.jpg','nx.jpg','py.jpg','ny.jpg','pz.jpg','nz.jpg'],
    () => { document.getElementById('loading').style.display = 'none'; },
    undefined,
    () => { scene.background = new THREE.Color(0x87b6e8); }
  );
  skybox.colorSpace = THREE.SRGBColorSpace;
  scene.background = skybox;
  scene.environment = skybox;

  // Lights
  ambient = new THREE.AmbientLight(0xffffff, 0.4); scene.add(ambient);
  hemi    = new THREE.HemisphereLight(0xbfd9ff, 0x4a6b2a, 0.6); scene.add(hemi);
  sun     = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.position.set(30, 50, 20); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { near:1, far:200, left:-70, right:70, top:70, bottom:-70 });
  scene.add(sun); scene.add(sun.target);
  pointLamp = new THREE.PointLight(0xffaa55, 0, 60);
  pointLamp.position.set(0, 12, 0); scene.add(pointLamp);
  spot = new THREE.SpotLight(0xfff4d6, 60, 70, Math.PI/6, 0.4, 1);
  spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024);
  scene.add(spot); scene.add(spot.target);

  // Ground
  const texLoader = new THREE.TextureLoader();
  const grass = texLoader.load(`${ASSETS}/textures/terrain/grasslight-big.jpg`);
  grass.colorSpace = THREE.SRGBColorSpace;
  grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
  grass.repeat.set(60, 60);
  const groundMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ map: grass })
  );
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  const crateTex = texLoader.load(`${ASSETS}/textures/crate.gif`);
  crateTex.colorSpace = THREE.SRGBColorSpace;
  wallMat = new THREE.MeshStandardMaterial({ map: crateTex });
  wallGeo = new THREE.BoxGeometry(CELL, WALL_H, CELL);

  cheeseMat = new THREE.MeshStandardMaterial({ color: 0xffd21e, roughness: 0.5, emissive: 0x3a2a00 });
  cheeseGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);

  mazeGroup = new THREE.Group(); scene.add(mazeGroup);

  rat      = new THREE.Group(); scene.add(rat);
  ghostRat = new THREE.Group(); ghostRat.visible = false; scene.add(ghostRat);

  const loader = new GLTFLoader();

  // Player rat
  loader.load(MODEL_URL, (gltf) => {
    const m = gltf.scene;
    m.scale.setScalar(MODEL_SCALE); m.rotation.y = MODEL_FACE; m.position.y = MODEL_Y;
    m.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(mat => {
          if (mat) mat.side = THREE.DoubleSide;
        });
      }
    });
    rat.add(m);
  });

  // Ghost rat
  loader.load(MODEL_URL, (gltf) => {
    const m = gltf.scene;
    m.scale.setScalar(MODEL_SCALE); m.rotation.y = MODEL_FACE; m.position.y = MODEL_Y;
    m.traverse(o => {
      if (o.isMesh) {
        if (Array.isArray(o.material)) {
          o.material = o.material.map(mat => {
            const g = mat.clone();
            g.transparent = true; g.opacity = 0.35; g.depthWrite = false; g.side = THREE.DoubleSide;
            return g;
          });
        } else {
          o.material = o.material.clone();
          o.material.transparent = true; o.material.opacity = 0.35;
          o.material.depthWrite = false; o.material.side = THREE.DoubleSide;
        }
      }
    });
    ghostRat.add(m);
  }, undefined, () => {
    ghostRat.add(new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0xaaddff, transparent: true, opacity: 0.35, depthWrite: false })
    ));
  });

  // Cheese model
  loader.load(CHEESE_URL, (g) => {
    cheeseTemplate = g.scene;
    cheeseTemplate.traverse(o => {
      if (o.isMesh && o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
          if (m.color) m.color.lerp(new THREE.Color(0xffffff), 0.18);
          if ('emissive' in m) { m.emissive = m.color.clone(); m.emissiveIntensity = CHEESE_GLOW; }
          cheeseMats.push(m);
        });
      }
    });
    if (_onCheeseLoaded) _onCheeseLoaded();
  }, undefined, () => {});

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  onReady();
}

export function onCheeseTemplateLoaded(fn) { _onCheeseLoaded = fn; }

// ── Maze generation ──────────────────────────────────────────
export function generateMaze(cw, ch, seed) {
  GW = 2 * cw + 1; GH = 2 * ch + 1;
  const rand = makeRNG(seed);
  grid = Array.from({ length: GH }, () => Array(GW).fill(true));
  const stack = [[1, 1]]; grid[1][1] = false;
  const dirs = [[0,-2],[0,2],[-2,0],[2,0]];
  while (stack.length) {
    const [r, c] = stack[stack.length - 1];
    const opts = [];
    for (const [dr, dc] of dirs) {
      const nr = r+dr, nc = c+dc;
      if (nr>0 && nr<GH-1 && nc>0 && nc<GW-1 && grid[nr][nc]) opts.push([nr, nc, dr, dc]);
    }
    if (opts.length) {
      const [nr, nc, dr, dc] = opts[(rand() * opts.length) | 0];
      grid[r+dr/2][c+dc/2] = false; grid[nr][nc] = false;
      stack.push([nr, nc]);
    } else stack.pop();
  }

  scene.remove(mazeGroup);
  mazeGroup = new THREE.Group();
  for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) {
    if (grid[r][c]) {
      const w = new THREE.Mesh(wallGeo, wallMat);
      w.position.set(toWorldX(c), WALL_H / 2, toWorldZ(r));
      w.receiveShadow = true;
      mazeGroup.add(w);
    }
  }
  scene.add(mazeGroup);

  startPos.set(toWorldX(1), 0, toWorldZ(1));
  finishPos.set(toWorldX(GW-2), 0, toWorldZ(GH-2));

  if (finishGate) scene.remove(finishGate);
  finishGate = new THREE.Mesh(
    new THREE.TorusGeometry(1.6, 0.3, 16, 40),
    new THREE.MeshStandardMaterial({ color: 0x33ff88, emissive: 0x0a5530, metalness: 0.4 })
  );
  finishGate.position.set(finishPos.x, 2, finishPos.z);
  finishGate.rotation.x = Math.PI / 2;
  scene.add(finishGate);
}

// ── Cheese helpers ───────────────────────────────────────────
export function placeCheeseAt(r, c) {
  let item;
  if (cheeseTemplate) {
    item = cheeseTemplate.clone(true);
    item.scale.setScalar(CHEESE_SCALE);
    item.traverse(o => { if (o.isMesh) o.castShadow = true; });
  } else {
    item = new THREE.Mesh(cheeseGeo, cheeseMat);
    item.castShadow = true;
  }
  item.position.set(toWorldX(c), CHEESE_Y, toWorldZ(r));
  item.userData.phase = Math.random() * Math.PI * 2;
  item.userData.baseY = CHEESE_Y;
  scene.add(item);
  cheeses.push(item);
  return item;
}

// ── Player label (name above rat) ────────────────────────────
export function makeNameLabel(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color || '#ffffff';
  ctx.font = 'bold 36px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name.slice(0, 14), 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 0.75),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
  );
  label.position.y = 3.2;
  return label;
}

// ── Minimap ──────────────────────────────────────────────────
const miniCanvas = document.getElementById('minimap');
const mctx = miniCanvas.getContext('2d');

export function drawMinimap(ratPos, ratYaw, otherPlayers) {
  if (!grid) return;
  const W = miniCanvas.width, H = miniCanvas.height;
  mctx.clearRect(0, 0, W, H);
  mctx.save();
  mctx.translate(W/2, H/2); mctx.rotate(-Math.PI/2); mctx.translate(-W/2, -H/2);
  const s = Math.min(W/GW, H/GH);
  const ox = (W - s*GW)/2, oy = (H - s*GH)/2;

  for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) {
    mctx.fillStyle = grid[r][c] ? '#3a2f25' : '#2e7d32';
    mctx.fillRect(ox + c*s, oy + r*s, s+0.5, s+0.5);
  }

  // Finish
  mctx.fillStyle = '#33ff88';
  mctx.fillRect(ox + toCol(finishPos.x)*s, oy + toRow(finishPos.z)*s, s, s);

  // Cheeses
  mctx.fillStyle = '#ffd21e';
  for (const ch of cheeses) {
    mctx.beginPath();
    mctx.arc(
      ox + (ch.position.x/CELL + (GW-1)/2)*s + s/2,
      oy + (ch.position.z/CELL + (GH-1)/2)*s + s/2,
      Math.max(1.5, s*0.3), 0, Math.PI*2
    );
    mctx.fill();
  }

  // Other players
  if (otherPlayers) {
    for (const p of otherPlayers) {
      mctx.fillStyle = p.color || '#ff4444';
      mctx.beginPath();
      mctx.arc(
        ox + (p.x/CELL + (GW-1)/2)*s + s/2,
        oy + (p.z/CELL + (GH-1)/2)*s + s/2,
        Math.max(2, s*0.4), 0, Math.PI*2
      );
      mctx.fill();
    }
  }

  // My arrow
  const rx = ox + (ratPos.x/CELL + (GW-1)/2)*s;
  const ry = oy + (ratPos.z/CELL + (GH-1)/2)*s;
  mctx.save();
  mctx.translate(rx, ry); mctx.rotate(Math.PI - ratYaw);
  mctx.fillStyle = '#ffffff';
  mctx.beginPath(); mctx.moveTo(0,-s); mctx.lineTo(-s*0.6,s*0.7); mctx.lineTo(s*0.6,s*0.7);
  mctx.closePath(); mctx.fill();
  mctx.restore();
  mctx.restore();
}

// ── Lighting update ──────────────────────────────────────────
const dayFog   = new THREE.Color(0x9bc4e2);
const nightFog = new THREE.Color(0x0a0f25);
const tmpC     = new THREE.Color();
let sunAngle   = Math.PI / 2.3;

export function updateLighting(dt, ratPos) {
  if (nightMode) {
    sun.intensity = 0; ambient.intensity = 0.05; hemi.intensity = 0.03;
    spot.angle = Math.PI/10; spot.penumbra = 0.4; spot.intensity = 420;
    pointLamp.color.set(0xffe2b0); pointLamp.intensity = 18; pointLamp.distance = 14;
    pointLamp.position.set(ratPos.x, 3, ratPos.z);
    scene.fog.color.set(0x000000); scene.fog.near = 6; scene.fog.far = 30;
  } else {
    scene.fog.near = 200; scene.fog.far = 900;
    spot.angle = Math.PI/6; spot.penumbra = 0.4; spot.distance = 70;
    pointLamp.color.set(0xffaa55);
    sun.position.set(Math.cos(sunAngle)*60, Math.max(8, Math.sin(sunAngle)*60), 25);
    sun.target.position.set(ratPos.x, 0, ratPos.z);
    const daylight = Math.max(0, Math.sin(sunAngle)), night = 1 - daylight;
    sun.intensity = 0.6 + daylight*2.4;
    sun.color.setHSL(0.09 + daylight*0.04, 1.0, 0.45 + daylight*0.2);
    ambient.intensity = 0.25 + daylight*0.25;
    hemi.intensity = 0.3 + daylight*0.5;
    pointLamp.intensity = night*50; pointLamp.position.set(ratPos.x, 12, ratPos.z);
    spot.intensity = 50 + night*70;
    tmpC.copy(nightFog).lerp(dayFog, daylight); scene.fog.color.copy(tmpC);
  }
}

// ── Camera update ────────────────────────────────────────────
export function updateCamera(ratPos) {
  if (followCam) {
    const camX = ratPos.x - Math.sin(yaw) * 14;
    const camZ = ratPos.z - Math.cos(yaw) * 14;
    camera.position.lerp(new THREE.Vector3(camX, 10, camZ), 0.08);
  } else if (savedCamOffset) {
    camera.position.set(
      orbitControls.target.x + savedCamOffset.x,
      orbitControls.target.y + savedCamOffset.y,
      orbitControls.target.z + savedCamOffset.z
    );
  } else {
    const mdx = ratPos.x - lastRat.x, mdz = ratPos.z - lastRat.z;
    camera.position.x += mdx; camera.position.z += mdz;
  }
  orbitControls.target.set(ratPos.x, 1.5, ratPos.z);
  lastRat.copy(ratPos);
  spot.position.set(ratPos.x, 16, ratPos.z);
  spot.target.position.copy(ratPos);
}

// ── Physics tick ─────────────────────────────────────────────
export function physicsTick(dt, speedMultiplier) {
  const maxSpd = MAX_SPEED * (speedMultiplier || 1);
  const keys = window._keys || {};

  if (!window._mpCanAccel) {
  speed = 0;
} else {
  if (keys['w'] || keys['arrowup'])        speed += ACCEL * dt;
  else if (keys['s'] || keys['arrowdown']) speed -= ACCEL * dt;
  else speed -= Math.sign(speed) * Math.min(Math.abs(speed), FRICTION * dt);
  speed = THREE.MathUtils.clamp(speed, -7, maxSpd);
}

  if (!window._mpCanAccel) {
  // Allow turning only during countdown
  yaw += ((keys['a']||keys['arrowleft']?1:0) - (keys['d']||keys['arrowright']?1:0)) * TURN_RATE * 0.6 * dt;
} else {
  if (Math.abs(speed) > 0.3) {
    const turn = (keys['a']||keys['arrowleft'] ? 1:0) - (keys['d']||keys['arrowright'] ? 1:0);
    yaw += turn * TURN_RATE * dt * Math.sign(speed === 0 ? 1 : speed);
  } else {
    yaw += ((keys['a']||keys['arrowleft']?1:0) - (keys['d']||keys['arrowright']?1:0)) * TURN_RATE * 0.6 * dt;
  }
}
rat.rotation.y = yaw;

  fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
  const t = clock.getElapsedTime();
  const dx = fwd.x * speed * dt, dz = fwd.z * speed * dt;
  if (!blocked(rat.position.x + dx, rat.position.z)) rat.position.x += dx; else speed *= 0.9;
  if (!blocked(rat.position.x, rat.position.z + dz)) rat.position.z += dz; else speed *= 0.9;
  rat.position.y = Math.abs(speed) > 0.5 ? Math.abs(Math.sin(t * 14)) * 0.12 : 0;
}

// ── Cheese animation ─────────────────────────────────────────
export function animateCheeses(dt) {
  const t = clock.getElapsedTime();
  for (const c of cheeses) {
    c.rotation.y += dt * 1.6;
    c.position.y = c.userData.baseY + Math.sin(t * 2 + c.userData.phase) * 0.2;
  }
}

// ── Keyboard ─────────────────────────────────────────────────
window._keys = {};
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  window._keys[e.key.toLowerCase()] = true;
  if (['arrowup','arrowdown','arrowleft','arrowright',' '].includes(e.key.toLowerCase())) e.preventDefault();
});
window.addEventListener('keyup', e => { window._keys[e.key.toLowerCase()] = false; });