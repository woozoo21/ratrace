// ============================================================
// ENGINE.JS — shared Three.js scene, models, camera, minimap and game loop
// ============================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
  CELL, FIXED_DT, MAX_SPEED, CHEESE_RADIUS, GATE_RADIUS, START_YAW,
  cellX, cellZ, stepVehicle, wrapAngle,
} from './core.js';
import { initControls, readInput } from './controls.js';

const ASSETS      = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples';
const RAT_URL     = './rat.glb';
const CHEESE_URL  = './cheese.glb';
const WALL_H      = 3;
const CHEESE_Y    = 1;
const CHEESE_GLOW = 0.18;
const CAM_BACK    = 14, CAM_HEIGHT = 10, CAM_FOLLOW_RATE = 5;

// ── Shared state ─────────────────────────────────────────────
export let renderer, scene, camera, orbit;
export let maze = null;
export const settings = { night: false, followCam: true, minimap: true, camOffset: null };
/** The local rat's physics state. */
export const player = { x: 0, z: 0, yaw: 0, speed: 0 };
/** Live cheeses: { r, c, x, z, mesh }. */
export const cheeses = [];
/** Extra dots for the minimap: { x, z, color }. Owned by the active game mode. */
export const minimapDots = [];
export let rat;

let skybox, sun, ambient, hemi, pointLamp, spot;
let walls = null, wallGeo, wallMat, gate, gateOpen = null;
let ratModel = null, cheeseModel = null;
let cheeseFallbackGeo, cheeseFallbackMat;
const cheeseMats = [];
const clock = new THREE.Clock();
const input = { throttle: 0, turn: 0 };
const prev = { x: 0, z: 0, yaw: 0 };              // state one physics step ago, for render interpolation
const view = new THREE.Vector3();                 // where the rat is drawn this frame
const lastView = new THREE.Vector3();
const camGoal = new THREE.Vector3();
let acc = 0, ready = false;

// ── Init ─────────────────────────────────────────────────────
export function initEngine(container) {
  if (ready) return;
  ready = true;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.prepend(renderer.domElement);

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x9bc4e2, 200, 900);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.06;
  orbit.maxPolarAngle = Math.PI * 0.49;
  orbit.minDistance = 8;
  orbit.maxDistance = 70;

  const hideLoading = () => { document.getElementById('loading').style.display = 'none'; };
  skybox = new THREE.CubeTextureLoader()
    .setPath(`${ASSETS}/textures/cube/SwedishRoyalCastle/`)
    .load(['px.jpg', 'nx.jpg', 'py.jpg', 'ny.jpg', 'pz.jpg', 'nz.jpg'], hideLoading, undefined, () => {
      skybox = new THREE.Color(0x87b6e8);
      if (!settings.night) { scene.background = skybox; scene.environment = null; }
      hideLoading();
    });
  skybox.colorSpace = THREE.SRGBColorSpace;

  ambient = new THREE.AmbientLight(0xffffff, 0.4);
  hemi    = new THREE.HemisphereLight(0xbfd9ff, 0x4a6b2a, 0.6);
  sun     = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { near: 1, far: 200, left: -70, right: 70, top: 70, bottom: -70 });
  pointLamp = new THREE.PointLight(0xffaa55, 0, 60);
  spot = new THREE.SpotLight(0xfff4d6, 60, 70, Math.PI / 6, 0.4, 1);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  scene.add(ambient, hemi, sun, sun.target, pointLamp, spot, spot.target);
  applyLighting();

  const tex = new THREE.TextureLoader();
  const grass = tex.load(`${ASSETS}/textures/terrain/grasslight-big.jpg`);
  grass.colorSpace = THREE.SRGBColorSpace;
  grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
  grass.repeat.set(60, 60);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ map: grass }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const crate = tex.load(`${ASSETS}/textures/crate.gif`);
  crate.colorSpace = THREE.SRGBColorSpace;
  wallMat = new THREE.MeshStandardMaterial({ map: crate });
  wallGeo = new THREE.BoxGeometry(CELL, WALL_H, CELL);

  gate = new THREE.Mesh(
    new THREE.TorusGeometry(1.6, 0.3, 16, 40),
    new THREE.MeshStandardMaterial({ metalness: 0.4 })
  );
  gate.rotation.x = Math.PI / 2;
  gate.visible = false;
  scene.add(gate);
  setGateOpen(true);

  cheeseFallbackGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
  cheeseFallbackMat = new THREE.MeshStandardMaterial({ color: 0xffd21e, roughness: 0.5, emissive: 0x3a2a00 });

  // Each model is downloaded and parsed once; every rat / cheese is a clone of it.
  const loader = new GLTFLoader();
  ratModel = loader.loadAsync(RAT_URL).then(g => g.scene).catch(e => { console.error('rat.glb failed to load', e); return null; });
  loader.loadAsync(CHEESE_URL).then((g) => {
    cheeseModel = g.scene;
    cheeseModel.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      for (const m of [].concat(o.material)) {
        if (m.color) m.color.lerp(new THREE.Color(0xffffff), 0.18);
        if ('emissive' in m) { m.emissive = m.color.clone(); m.emissiveIntensity = settings.night ? 0 : CHEESE_GLOW; }
        cheeseMats.push(m);
      }
    });
    for (const ch of cheeses) swapCheeseMesh(ch);          // upgrade placeholders already in the maze
  }).catch(e => console.error('cheese.glb failed to load (using cubes)', e));

  rat = makeRat();
  scene.add(rat);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  initControls(renderer.domElement);
}

// ── Rats ─────────────────────────────────────────────────────
/**
 * A rat that fills in once the shared model has loaded.
 * @param {{tint?:string, opacity?:number, label?:string}} [opts]
 */
export function makeRat({ tint = null, opacity = 1, label = null } = {}) {
  const group = new THREE.Group();
  const owned = group.userData.owned = [];                 // materials / textures to free with the rat
  if (label) group.add(makeNameSprite(label, tint || '#ffffff', owned));
  ratModel.then((src) => {
    if (!src) {
      const mat = new THREE.MeshStandardMaterial({ color: tint || 0xaaaaaa, transparent: opacity < 1, opacity });
      owned.push(mat);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 12), mat);
      ball.position.y = 0.8;
      group.add(ball);
      return;
    }
    const model = cloneSkinned(src);
    const tintColor = tint ? new THREE.Color(tint) : null;
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = opacity === 1;
      const restyle = (m) => {
        const c = m.clone();
        c.side = THREE.DoubleSide;
        if (tintColor) c.color.lerp(tintColor, 0.65);
        if (opacity < 1) { c.transparent = true; c.opacity = opacity; c.depthWrite = false; }
        owned.push(c);
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(restyle) : restyle(o.material);
    });
    group.add(model);
  });
  return group;
}

export function disposeRat(group) {
  if (!group) return;
  scene.remove(group);
  for (const res of group.userData.owned) res.dispose();
}

function makeNameSprite(name, color, owned) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 36px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText(name, 128, 32);
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 32);
  const map = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map, depthWrite: false });
  owned.push(map, mat);
  const sprite = new THREE.Sprite(mat);                    // sprites always face the camera
  sprite.scale.set(3, 0.75, 1);
  sprite.position.y = 3.2;
  return sprite;
}

// ── Maze ─────────────────────────────────────────────────────
/** Show a core.js maze and put the player on its start cell. */
export function setMaze(m) {
  maze = m;
  if (walls) { scene.remove(walls); walls.dispose(); }
  let count = 0;
  for (let i = 0; i < m.wall.length; i++) count += m.wall[i];
  walls = new THREE.InstancedMesh(wallGeo, wallMat, count);
  walls.receiveShadow = true;
  const mat4 = new THREE.Matrix4();
  for (let r = 0, i = 0; r < m.gh; r++) for (let c = 0; c < m.gw; c++) {
    if (!m.wall[r * m.gw + c]) continue;
    walls.setMatrixAt(i++, mat4.makeTranslation(cellX(m, c), WALL_H / 2, cellZ(m, r)));
  }
  walls.instanceMatrix.needsUpdate = true;
  scene.add(walls);

  gate.position.set(cellX(m, m.finish.c), 2, cellZ(m, m.finish.r));
  gate.visible = true;
  drawMinimapBase();
  resetPlayer();
}

export function resetPlayer() {
  player.x = cellX(maze, maze.start.c);
  player.z = cellZ(maze, maze.start.r);
  player.yaw = START_YAW;
  player.speed = 0;
  Object.assign(prev, player);
  view.set(player.x, 0, player.z);
  lastView.copy(view);
  rat.position.copy(view);
  rat.rotation.y = player.yaw;
  camera.position.set(player.x, 18, player.z + 22);
  orbit.target.set(player.x, 1.5, player.z);
  orbit.update();
}

export function setGateOpen(open) {
  if (open === gateOpen) return;
  gateOpen = open;
  gate.material.color.set(open ? 0x33ff88 : 0xff5555);
  gate.material.emissive.set(open ? 0x0a5530 : 0x551414);
}

export const atGate = () =>
  Math.hypot(player.x - cellX(maze, maze.finish.c), player.z - cellZ(maze, maze.finish.r)) < GATE_RADIUS;

// ── Cheese ───────────────────────────────────────────────────
function swapCheeseMesh(ch) {
  if (ch.mesh) scene.remove(ch.mesh);
  ch.mesh = cheeseModel ? cheeseModel.clone(true) : new THREE.Mesh(cheeseFallbackGeo, cheeseFallbackMat);
  ch.mesh.castShadow = true;
  ch.mesh.position.set(ch.x, CHEESE_Y, ch.z);
  scene.add(ch.mesh);
}

/** Replace all cheeses with one per cell in `cells` ([{r,c}, …]). */
export function setCheeses(cells) {
  for (const ch of cheeses) scene.remove(ch.mesh);
  cheeses.length = 0;
  for (const { r, c } of cells) {
    const ch = { r, c, x: cellX(maze, c), z: cellZ(maze, r), mesh: null, phase: Math.random() * Math.PI * 2 };
    swapCheeseMesh(ch);
    cheeses.push(ch);
  }
}

export function removeCheese(i) {
  scene.remove(cheeses[i].mesh);
  cheeses.splice(i, 1);
}

/** Index of a cheese the player is touching, or -1. */
export function touchedCheese() {
  for (let i = 0; i < cheeses.length; i++) {
    if (Math.hypot(cheeses[i].x - player.x, cheeses[i].z - player.z) < CHEESE_RADIUS) return i;
  }
  return -1;
}

// ── Player physics ───────────────────────────────────────────
/** Advance the local rat one fixed step from keyboard / joystick input. */
export function stepPlayer(dt, speedFactor = 1, frozen = false) {
  stepVehicle(player, readInput(input), maze, dt, MAX_SPEED * speedFactor, frozen);
}

// ── Lighting ─────────────────────────────────────────────────
const SUN_ANGLE = Math.PI / 2.3;

export function setNight(on) {
  settings.night = on;
  applyLighting();
}

function applyLighting() {
  const night = settings.night;
  scene.background  = night ? new THREE.Color(0x000000) : skybox;
  scene.environment = night || !skybox.isTexture ? null : skybox;
  for (const m of cheeseMats) m.emissiveIntensity = night ? 0 : CHEESE_GLOW;
  if (night) {
    sun.intensity = 0; ambient.intensity = 0.05; hemi.intensity = 0.03;
    spot.angle = Math.PI / 10; spot.intensity = 420;
    pointLamp.color.set(0xffe2b0); pointLamp.intensity = 18; pointLamp.distance = 14;
    scene.fog.color.set(0x000000); scene.fog.near = 6; scene.fog.far = 30;
  } else {
    const daylight = Math.max(0, Math.sin(SUN_ANGLE)), dusk = 1 - daylight;
    sun.intensity = 0.6 + daylight * 2.4;
    sun.color.setHSL(0.09 + daylight * 0.04, 1.0, 0.45 + daylight * 0.2);
    ambient.intensity = 0.25 + daylight * 0.25;
    hemi.intensity = 0.3 + daylight * 0.5;
    spot.angle = Math.PI / 6; spot.intensity = 50 + dusk * 70;
    pointLamp.color.set(0xffaa55); pointLamp.intensity = dusk * 50; pointLamp.distance = 60;
    scene.fog.color.set(0x0a0f25).lerp(new THREE.Color(0x9bc4e2), daylight);
    scene.fog.near = 200; scene.fog.far = 900;
  }
}

function followLights() {
  sun.position.set(view.x + Math.cos(SUN_ANGLE) * 60, Math.max(8, Math.sin(SUN_ANGLE) * 60), view.z + 25);
  sun.target.position.set(view.x, 0, view.z);
  pointLamp.position.set(view.x, settings.night ? 3 : 12, view.z);
  spot.position.set(view.x, 16, view.z);
  spot.target.position.set(view.x, 0, view.z);
}

// ── Camera ───────────────────────────────────────────────────
function updateCamera(dt, yaw) {
  if (settings.followCam) {
    camGoal.set(view.x - Math.sin(yaw) * CAM_BACK, CAM_HEIGHT, view.z - Math.cos(yaw) * CAM_BACK);
    camera.position.lerp(camGoal, 1 - Math.exp(-CAM_FOLLOW_RATE * dt));
  } else if (settings.camOffset) {
    camera.position.set(view.x + settings.camOffset.x, 1.5 + settings.camOffset.y, view.z + settings.camOffset.z);
  } else {
    camera.position.x += view.x - lastView.x;
    camera.position.z += view.z - lastView.z;
  }
  orbit.target.set(view.x, 1.5, view.z);
  lastView.copy(view);
  orbit.update();
}

let director = null;
/**
 * Hand the camera to `fn(dt, view, yaw, camera)` each frame (home-screen reel); null gives it back
 * to the follow / orbit camera.
 */
export function setCameraDirector(fn) {
  director = fn;
  orbit.enabled = !fn;
  if (!fn) {
    camera.clearViewOffset();
    camera.fov = 60;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
}

/** Offset from the rat to the camera right now (for "save camera"). */
export const currentCamOffset = () => new THREE.Vector3().subVectors(camera.position, orbit.target);

// ── Minimap ──────────────────────────────────────────────────
const miniCanvas = document.getElementById('minimap');
const mctx = miniCanvas.getContext('2d');
const miniBase = document.createElement('canvas');
let miniScale = 1, miniOx = 0, miniOy = 0;

function drawMinimapBase() {
  const W = miniBase.width = miniCanvas.width, H = miniBase.height = miniCanvas.height;
  const ctx = miniBase.getContext('2d');
  const s = miniScale = Math.min(W / maze.gw, H / maze.gh);
  miniOx = (W - s * maze.gw) / 2; miniOy = (H - s * maze.gh) / 2;
  for (let r = 0; r < maze.gh; r++) for (let c = 0; c < maze.gw; c++) {
    ctx.fillStyle = maze.wall[r * maze.gw + c] ? '#3a2f25' : '#2e7d32';
    ctx.fillRect(miniOx + c * s, miniOy + r * s, s + 0.5, s + 0.5);
  }
}

function drawMinimap() {
  const W = miniCanvas.width, H = miniCanvas.height, s = miniScale;
  const mx = (x) => miniOx + (x / CELL + (maze.gw - 1) / 2) * s + s / 2;
  const my = (z) => miniOy + (z / CELL + (maze.gh - 1) / 2) * s + s / 2;
  const dot = (x, z, rad) => { mctx.beginPath(); mctx.arc(mx(x), my(z), rad, 0, Math.PI * 2); mctx.fill(); };
  mctx.setTransform(-1, 0, 0, -1, W, H);                   // the map is shown turned half a turn
  mctx.clearRect(0, 0, W, H);
  mctx.drawImage(miniBase, 0, 0);

  mctx.fillStyle = gateOpen ? '#33ff88' : '#ff5555';
  mctx.fillRect(miniOx + maze.finish.c * s, miniOy + maze.finish.r * s, s, s);
  mctx.fillStyle = '#ffd21e';
  for (const ch of cheeses) dot(ch.x, ch.z, Math.max(1.5, s * 0.3));
  for (const d of minimapDots) { mctx.fillStyle = d.color || '#ff4444'; dot(d.x, d.z, Math.max(2, s * 0.4)); }

  mctx.translate(mx(view.x), my(view.z));
  mctx.rotate(Math.PI - rat.rotation.y);
  mctx.fillStyle = '#ffffff';
  mctx.beginPath(); mctx.moveTo(0, -s); mctx.lineTo(-s * 0.6, s * 0.7); mctx.lineTo(s * 0.6, s * 0.7);
  mctx.closePath(); mctx.fill();
}

export function setMinimap(on) {
  settings.minimap = on;
  miniCanvas.style.display = on ? 'block' : 'none';
}

// ── Game loop ────────────────────────────────────────────────
/**
 * @param fixed (dt) → game rules, called at exactly 60 Hz of game time
 * @param frame (dt) → per-rendered-frame visuals (ghosts, other players, HUD)
 */
export function startLoop(fixed, frame) {
  clock.getDelta();
  acc = 0;
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);            // a long stall slows the game rather than teleporting it
    acc += dt;
    while (acc >= FIXED_DT) {
      prev.x = player.x; prev.z = player.z; prev.yaw = player.yaw;
      fixed(FIXED_DT);
      acc -= FIXED_DT;
    }
    // Draw the rat between its last two physics states so motion is smooth at any refresh rate.
    const a = acc / FIXED_DT, t = clock.elapsedTime;
    view.set(prev.x + (player.x - prev.x) * a, 0, prev.z + (player.z - prev.z) * a);
    const yaw = prev.yaw + wrapAngle(player.yaw - prev.yaw) * a;
    rat.position.set(view.x, Math.abs(player.speed) > 0.5 ? Math.abs(Math.sin(t * 14)) * 0.12 : 0, view.z);
    rat.rotation.y = yaw;

    for (const ch of cheeses) {
      ch.mesh.rotation.y += dt * 1.6;
      ch.mesh.position.y = CHEESE_Y + Math.sin(t * 2 + ch.phase) * 0.2;
    }
    gate.rotation.z += dt * 1.2;

    frame(dt);
    if (director) director(dt, view, yaw, camera);
    else updateCamera(dt, yaw);
    followLights();
    if (settings.minimap) drawMinimap();
    renderer.render(scene, camera);
  });
}

export function stopLoop() {
  if (renderer) renderer.setAnimationLoop(null);
}
