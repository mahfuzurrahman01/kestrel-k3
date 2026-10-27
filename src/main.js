import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createMaterials, PAINTS } from './materials.js';
import { Vehicle } from './vehicle.js';
import { inject } from '@vercel/analytics';

inject();

/* ======================================================================
 *  Kestrel K3 — interactive engineering drawing
 *  Scene, drive/fly simulation, HUD, and the live third-angle projection.
 * ====================================================================== */

const $ = (s) => document.querySelector(s);
const sheet = $('#sheet'), stage = $('#stage'), canvas = $('#c'), statusEl = $('#status');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const clamp = THREE.MathUtils.clamp;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const say = (msg) => { statusEl.hidden = false; statusEl.textContent = msg; };

const STORY = {
  ground: "On the ground it's a reverse trike. Drive it, then press Space and every wheel folds flat into a lift fan.",
  sky: 'Three ducted fans, no wings. Fly with W A S D, slide sideways with Q and E, press Space to land.',
  toSky: 'Converting. Front arms telescope out 300 mm, each wheel hinges flat, the hull climbs 450 mm.',
  toGround: 'Landing. Fans spool down, wheels hinge upright, arms draw back in.',
};

/* ---------------- renderer & scene ---------------- */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
} catch (e) {
  say('This browser could not start WebGL, so the drawing cannot be shown.');
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 120);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const key = new THREE.DirectionalLight(0xfff4e6, 2.6);
key.position.set(3, 6, 2.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -2.8, right: 2.8, top: 2.8, bottom: -2.8, near: 1, far: 18 });
key.shadow.bias = -0.0003;
key.shadow.normalBias = 0.02;
key.shadow.radius = 6;
scene.add(key, key.target);
const rim = new THREE.DirectionalLight(0xc6e4ff, 1.6);
rim.position.set(-4, 3, -3);
scene.add(rim);
scene.add(new THREE.HemisphereLight(0xe8f4ff, 0x0d2a44, 0.6));

// contact shadow
const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.ShadowMaterial({ color: 0x03111f, opacity: 0.3 }));
shadowPlane.rotation.x = -Math.PI / 2;
shadowPlane.receiveShadow = true;
scene.add(shadowPlane);

// world-fixed ground grid that fades around the car — it's what makes motion readable
const groundGrid = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uCenter: { value: new THREE.Vector2() }, uColor: { value: new THREE.Color(0xcfe6ff) }, uRadius: { value: 4.5 } },
    vertexShader: `varying vec2 vP; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vP = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      varying vec2 vP; uniform vec2 uCenter; uniform vec3 uColor; uniform float uRadius;
      float grid(vec2 p, float s){ vec2 q = p / s; vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q); return 1.0 - min(min(g.x, g.y), 1.0); }
      void main(){
        float fade = 1.0 - smoothstep(uRadius * 0.25, uRadius, distance(vP, uCenter));
        float a = grid(vP, 2.5) * 0.14 * fade;   // major lines only, faint, local to the car
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  }),
);
groundGrid.rotation.x = -Math.PI / 2;
groundGrid.position.y = -0.001;
groundGrid.renderOrder = -1;
scene.add(groundGrid);

/* ---------------- controls ---------------- */
const controls = new OrbitControls(camera, canvas);
Object.assign(controls, {
  enableDamping: true, dampingFactor: 0.08, minDistance: 1.2, maxDistance: 18,
  screenSpacePanning: true, zoomSpeed: 0.8, rotateSpeed: 0.7, maxPolarAngle: Math.PI * 0.495,
});
controls.addEventListener('start', () => { tween = null; dragging = true; sheet.classList.add('dragging'); });
controls.addEventListener('end', () => { dragging = false; sheet.classList.remove('dragging'); });

/* ---------------- state ---------------- */
const S = { x: 0, z: 0, h: 0, v: 0, vx: 0, vz: 0, steer: 0, yaw: 0, roll: 0, pitch: 0, accel: 0, side: 0, odo: 0, wheel: 0, fan: 0, fanRate: 0 };
const keys = new Set();
let conv = 0, convTarget = 0, explode = 0, explodeTarget = 0, wire = false;
let car = null, mats = null, tween = null, dragging = false;
let lastX = 0, lastZ = 0, lastLift = 0, storyNow = '';
const VIEW_DIR = new THREE.Vector3(-3.4, 1.6, 3.2).normalize();   // default camera: front‑left three‑quarter
const VIEW_TGT_Y = 0.5;

/* ---------------- trails & downwash ---------------- */
const TRAIL_MAX = 140;   // ~11 m of trail
const trailMat = new THREE.LineDashedMaterial({ vertexColors: true, transparent: true, depthWrite: false, dashSize: 0.16, gapSize: 0.08 });
const trails = [0, 1, 2].map(() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 4), 4));
  g.setDrawRange(0, 0);
  const line = new THREE.Line(g, trailMat);
  line.frustumCulled = false;
  line.renderOrder = 1;
  scene.add(line);
  return { g, line, pts: [] };
});
function clearTrails() { trails.forEach((t) => { t.pts.length = 0; t.g.setDrawRange(0, 0); }); }

const washTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 6, 128, 128, 127);
  grad.addColorStop(0, 'rgba(170,225,255,0)');
  grad.addColorStop(0.45, 'rgba(170,225,255,.22)');
  grad.addColorStop(0.62, 'rgba(215,242,255,.5)');
  grad.addColorStop(0.78, 'rgba(170,225,255,.14)');
  grad.addColorStop(1, 'rgba(170,225,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  // concentric pressure rings
  g.strokeStyle = 'rgba(215,242,255,.12)'; g.lineWidth = 2;
  for (let r = 40; r < 124; r += 14) { g.beginPath(); g.arc(128, 128, r, 0, Math.PI * 2); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const washes = [0, 1, 2].map(() => {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: washTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.003; m.renderOrder = 2;
  scene.add(m);
  return m;
});

/* ---------------- drawing modes (shaded / wireframe / ortho line art) ---------------- */
const fillMat = new THREE.MeshBasicMaterial({ color: 0x0f3a5c, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, toneMapped: false });
const wireLineMat = new THREE.LineBasicMaterial({ color: 0xe0f1ff, transparent: true, opacity: 0.92, toneMapped: false });
const orthoLineMat = new THREE.LineBasicMaterial({ color: 0xe0f1ff, transparent: true, opacity: 0.85, toneMapped: false });
const centerMat = new THREE.LineDashedMaterial({ color: 0xa6c6e2, transparent: true, opacity: 0.6, dashSize: 0.18, gapSize: 0.05, toneMapped: false });
const wireEdges = [], orthoEdges = [];
let meshes = [];
const isDecal = (o) => o.material && o.material.name && o.material.name.startsWith('decal');

function buildEdges(list, threshold, mat, skip) {
  for (const o of meshes) {
    if (isDecal(o) || (skip && skip(o))) continue;
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, threshold(o)), mat);
    l.raycast = () => {};
    l.visible = false;
    o.add(l);
    list.push(l);
  }
}
let wireBuilt = false;
function setWire(on) {
  wire = on;
  if (on && !wireBuilt) { buildEdges(wireEdges, (o) => (/tire|tread/.test(o.name) ? 40 : 28), wireLineMat); wireBuilt = true; }
  for (const o of meshes) {
    if (on) { o.userData.mat ??= o.material; o.material = fillMat; o.castShadow = false; }
    else if (o.userData.mat) { o.material = o.userData.mat; o.castShadow = !isDecal(o) && o.material !== mats.glass; }
    if (isDecal(o)) o.visible = !on;
  }
  wireEdges.forEach((l) => (l.visible = on));
  car.sections.visible = on;
  shadowPlane.visible = !on;
  updateViewName();
}

// centre/ground lines that only show in the projection views
const centerlines = new THREE.Group();
const dashLine = (a, b) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), centerMat); l.computeLineDistances(); return l; };
centerlines.add(dashLine(new THREE.Vector3(-1.9, 0.002, 0), new THREE.Vector3(1.9, 0.002, 0)));
centerlines.add(dashLine(new THREE.Vector3(0, 0.002, -1.35), new THREE.Vector3(0, 0.002, 1.35)));
centerlines.visible = false;
scene.add(centerlines);

const projViews = ['plan', 'side', 'end'].map((id) => ({ id, el: document.getElementById('v-' + id), cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 60) }));
const orthoEl = $('#ortho');
function setLineArt(on) {
  for (const o of meshes) {
    if (on) { o.userData.pm = o.material; o.material = fillMat; if (isDecal(o)) o.visible = false; }
    else { o.material = o.userData.pm; if (isDecal(o)) o.visible = !wire; }
  }
  wireEdges.forEach((l) => (l.visible = on ? false : wire));
  orthoEdges.forEach((l) => (l.visible = on));
  car.sections.visible = on || wire;
  shadowPlane.visible = !on && !wire;
  groundGrid.visible = !on;
  trails.forEach((t) => (t.line.visible = !on));
  washes.forEach((w) => { if (on) { w.userData.v = w.visible; w.visible = false; } else w.visible = w.userData.v; });
  centerlines.visible = on;
}
const fwd = (a, b, c) => { const ch = Math.cos(S.h), sh = Math.sin(S.h); return new THREE.Vector3(a * ch + c * sh, b, -a * sh + c * ch); };
function aimOrtho(v, w, h, center, offset, up) {
  const c = v.cam;
  c.left = -w / 2; c.right = w / 2; c.top = h / 2; c.bottom = -h / 2;
  c.updateProjectionMatrix();
  c.position.copy(center).add(offset);
  c.up.copy(up);
  c.lookAt(center);
}
let orthoFrame = 0;
function renderOrtho() {
  if (!car || getComputedStyle(orthoEl).display === 'none') return;
  const sr = stage.getBoundingClientRect();
  const rects = projViews.map((v) => v.el.getBoundingClientRect());
  if (rects[1].width < 20) return;
  const ppm = rects[1].width / 3.3;                       // pixels per metre, shared so all three views agree
  const midY = car.root.position.y + 0.55 + car.state.lift * 0.5;
  const ctr = new THREE.Vector3(S.x, midY, S.z);
  centerlines.position.set(S.x, 0, S.z);
  centerlines.rotation.y = S.h;
  setLineArt(true);
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;
  renderer.setScissorTest(true);
  projViews.forEach((v, i) => {
    const r = rects[i];
    const x = r.left - sr.left + 1, y = sr.bottom - r.bottom + 1, w = r.width - 2, h = r.height - 2;
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    renderer.clear(true, true, false);
    const W = w / ppm, H = h / ppm;
    if (v.id === 'plan') aimOrtho(v, W, H, new THREE.Vector3(S.x, 0, S.z), new THREE.Vector3(0, 20, 0), fwd(0, 0, -1));
    else if (v.id === 'side') aimOrtho(v, W, H, ctr, fwd(0, 0, 14), new THREE.Vector3(0, 1, 0));
    else aimOrtho(v, W, H, ctr, fwd(14, 0, 0), new THREE.Vector3(0, 1, 0));
    renderer.render(scene, v.cam);
  });
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, stage.clientWidth, stage.clientHeight);
  renderer.autoClear = true;
  renderer.shadowMap.autoUpdate = true;
  setLineArt(false);
}

/* ---------------- HUD ---------------- */
const setText = (id, t) => { const el = document.getElementById(id); if (el && el.textContent !== t) el.textContent = t; };
(function buildCompass() {
  const g = document.getElementById('compass'), NS = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 72; i++) {
    const a = (i * 5 * Math.PI) / 180;
    if (i % 18 === 0) {
      const t = document.createElementNS(NS, 'text');
      const x = 74 + Math.sin(a) * 60, y = 74 - Math.cos(a) * 60;
      t.setAttribute('x', x.toFixed(2)); t.setAttribute('y', y.toFixed(2));
      t.setAttribute('transform', `rotate(${i * 5} ${x.toFixed(2)} ${y.toFixed(2)})`);
      t.textContent = 'NESW'[i / 18];
      if (i === 0) t.setAttribute('class', 'n');
      g.appendChild(t);
    } else {
      const l = document.createElementNS(NS, 'line');
      const r0 = i % 6 === 0 ? 63 : 65.5;
      l.setAttribute('x1', (74 + Math.sin(a) * r0).toFixed(2)); l.setAttribute('y1', (74 - Math.cos(a) * r0).toFixed(2));
      l.setAttribute('x2', (74 + Math.sin(a) * 68).toFixed(2)); l.setAttribute('y2', (74 - Math.cos(a) * 68).toFixed(2));
      if (i % 6 === 0) l.setAttribute('class', 'major');
      g.appendChild(l);
    }
  }
})();
const ARC_FULL = 2 * Math.PI * 50, ARC_SPAN = ARC_FULL * 0.75;
const tmpPts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

function updateHud() {
  if (!car) return;
  const kmh = S.v * 3.6;
  const speedKmh = Math.hypot(S.vx, S.vz) * 3.6;
  setText('spd', String(Math.round(speedKmh)));
  document.getElementById('spd-arc').setAttribute('stroke-dasharray', `${(Math.min(1, speedKmh / 36) * ARC_SPAN).toFixed(1)} ${ARC_FULL.toFixed(1)}`);
  const hdg = ((-THREE.MathUtils.radToDeg(S.h) % 360) + 360) % 360;
  setText('hdg', 'HDG ' + String(Math.round(hdg) % 360).padStart(3, '0') + '°');
  document.getElementById('compass').setAttribute('transform', `rotate(${(-hdg).toFixed(1)} 74 74)`);
  car.contactPoints(tmpPts);
  setText('s-clear', Math.round((0.27 + car.state.lift + car.pivot.position.y - 0.55) * 1000) + ' mm');
  setText('s-span', Math.round(Math.hypot(tmpPts[0].x - tmpPts[1].x, tmpPts[0].z - tmpPts[1].z) * 1000) + ' mm');
  setText('s-rpm', (Math.round((S.fanRate * 286) / 10) * 10).toLocaleString('en-US'));
  setText('s-odo', S.odo < 1000 ? S.odo.toFixed(1) + ' m' : (S.odo / 1000).toFixed(2) + ' km');
  const pct = Math.round(conv * 100);
  document.getElementById('gfill').style.width = pct + '%';
  setText('gpct', conv <= 0.001 ? 'GROUND' : conv >= 0.999 ? 'SKY' : 'CONVERT ' + String(pct).padStart(2, '0') + '%');
  const story = conv <= 0.001 ? STORY.ground : conv >= 0.999 ? STORY.sky : convTarget > 0.5 ? STORY.toSky : STORY.toGround;
  if (story !== storyNow) { setText('story', story); storyNow = story; }
  const dx = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
  const dy = (keys.has('down') ? 1 : 0) - (keys.has('up') ? 1 : 0);
  document.getElementById('puck').style.transform = `translate(${dx * 16}px, ${dy * 16}px)`;
  document.getElementById('strafe').classList.toggle('off', conv < 0.95);
  void kmh;
}
function updateViewName() {
  setText('view-name', wire && explodeTarget ? 'Exploded wireframe' : wire ? 'Wireframe' : explodeTarget ? 'Exploded' : 'Shaded');
}

/* ---------------- camera framing ---------------- */
function frameDistance() {
  const narrow = stage.clientWidth < 900;
  const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
  const span = 2.0 + 0.45 * sstep(0.3, 1, conv) + 0.8 * explode;   // metres we want to fit across
  const fit = narrow ? 1.02 : 0.74;
  return Math.max(span / Math.tan(hfov / 2) / fit, 1.25 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (narrow ? 0.62 : 0.55));
}
function flyTo(pos, tgt, instant) {
  if (instant || reduceMotion) { tween = null; camera.position.copy(pos); controls.target.copy(tgt); controls.update(); return; }
  const d0 = camera.position.clone().sub(controls.target), d1 = pos.clone().sub(tgt);
  tween = { t0: controls.target.clone(), t1: tgt.clone(), d0: d0.clone().normalize(), d1: d1.clone().normalize(), l0: d0.length(), l1: d1.length(), start: performance.now(), dur: 1200 };
}
function stepTween(now) {
  if (!tween) return;
  const k = Math.min(1, (now - tween.start) / tween.dur), e = easeInOut(k);
  const q = new THREE.Quaternion().setFromUnitVectors(tween.d0, tween.d1);
  const dir = tween.d0.clone().applyQuaternion(new THREE.Quaternion().slerp(q, e));
  controls.target.lerpVectors(tween.t0, tween.t1, e);
  camera.position.copy(controls.target).addScaledVector(dir, tween.l0 + (tween.l1 - tween.l0) * e);
  if (k >= 1) tween = null;
}
function resetView(instant) {
  const tgt = new THREE.Vector3(S.x, VIEW_TGT_Y + (car ? car.state.lift : 0), S.z);
  const dir = VIEW_DIR.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), S.h);
  flyTo(tgt.clone().addScaledVector(dir, frameDistance()), tgt, instant);
}

/* ---------------- UI wiring ---------------- */
const modeBtns = document.querySelectorAll('[data-mode]');
function setMode(m) {
  convTarget = m;
  document.getElementById('switch').dataset.mode = String(m);
  modeBtns.forEach((b) => b.dataset.mode !== undefined && b.tagName === 'BUTTON' && b.setAttribute('aria-pressed', String(Number(b.dataset.mode) === m)));
}
modeBtns.forEach((b) => b.tagName === 'BUTTON' && b.addEventListener('click', () => setMode(Number(b.dataset.mode))));
$('#wire').addEventListener('click', (e) => { e.currentTarget.setAttribute('aria-pressed', String(!wire)); setWire(!wire); });
$('#explode').addEventListener('click', (e) => { explodeTarget = explodeTarget ? 0 : 1; e.currentTarget.setAttribute('aria-pressed', String(!!explodeTarget)); updateViewName(); });
$('#reset').addEventListener('click', () => resetView(false));

const KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyQ: 'q', KeyE: 'e' };
const kbdEls = document.querySelectorAll('.kbd[data-k], #pad button');
const syncKeys = () => kbdEls.forEach((el) => el.classList.toggle('on', keys.has(el.dataset.k)));
const flash = (k) => kbdEls.forEach((el) => { if (el.dataset.k === k) { el.classList.add('on'); setTimeout(() => el.classList.remove('on'), 180); } });
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
  const k = KEYMAP[e.code];
  if (k) { keys.add(k); e.preventDefault(); syncKeys(); return; }
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); setMode(convTarget > 0.5 ? 0 : 1); flash('space'); }
  } else if (e.code === 'KeyR' && !e.repeat) { recenter(); flash('r'); }
});
window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) { keys.delete(k); syncKeys(); } if (e.code === 'Space') e.preventDefault(); });
window.addEventListener('blur', () => { keys.clear(); syncKeys(); });
document.querySelectorAll('#pad button').forEach((b) => {
  const k = b.dataset.k;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); keys.add(k); syncKeys(); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => b.addEventListener(ev, () => { keys.delete(k); syncKeys(); }));
  b.addEventListener('contextmenu', (e) => e.preventDefault());
});
function recenter() {
  Object.assign(S, { x: 0, z: 0, h: 0, v: 0, vx: 0, vz: 0, steer: 0, yaw: 0, roll: 0, pitch: 0, accel: 0, side: 0 });
  lastX = 0; lastZ = 0;
  clearTrails();
  resetView(false);
}

let paint = PAINTS[0];
const swatchEls = PAINTS.map((p) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'swatch'; b.id = 'paint-' + p.name.toLowerCase();
  b.style.setProperty('--a', p.body); b.style.setProperty('--b', p.accent);
  b.setAttribute('aria-label', p.name + ' finish');
  b.setAttribute('aria-pressed', String(p === paint));
  b.addEventListener('click', () => applyPaint(p));
  document.getElementById('swatches').appendChild(b);
  return b;
});
function applyPaint(p) {
  paint = p;
  if (car) car.setPaint(p);
  document.documentElement.style.setProperty('--accent', p.mark);
  swatchEls.forEach((b, i) => b.setAttribute('aria-pressed', String(PAINTS[i] === p)));
  setText('paint-name', p.name);
}

/* ---------------- simulation ---------------- */
const WHEELBASE = 1.8;
function simulate(dt) {
  const fly = sstep(0.55, 0.95, conv);                     // 0 = rolling, 1 = flying
  const converting = conv > 0.02 && conv < 0.98;
  const up = keys.has('up') ? 1 : 0, dn = keys.has('down') ? 1 : 0;
  const lt = keys.has('left') ? 1 : 0, rt = keys.has('right') ? 1 : 0;
  const F = new THREE.Vector3(Math.cos(S.h), 0, -Math.sin(S.h));   // forward
  const R = new THREE.Vector3(Math.sin(S.h), 0, Math.cos(S.h));    // right
  const vel = new THREE.Vector3(S.vx, 0, S.vz);

  if (fly < 0.5) {
    // ---- road: kinematic bicycle model for a tadpole trike (both fronts steer)
    let v = vel.dot(F);
    const target = (lt - rt) * THREE.MathUtils.degToRad(28) * (1 - Math.min(0.65, Math.abs(v) / 15));
    S.steer += (target - S.steer) * Math.min(1, dt * 6);
    let a;
    if (converting) a = -Math.sign(v) * Math.min(Math.abs(v) / Math.max(dt, 1e-3), 6);
    else if (up) a = v < -0.05 ? 8 : 3.6;
    else if (dn) a = v > 0.05 ? -8 : -2.4;
    else a = -Math.sign(v) * Math.min(Math.abs(v) / Math.max(dt, 1e-3), 1.1 + 0.04 * v * v);
    v = clamp(v + a * dt, -3, 10);
    S.yaw = (v * Math.tan(S.steer)) / WHEELBASE;
    S.h += S.yaw * dt;
    vel.set(Math.cos(S.h), 0, -Math.sin(S.h)).multiplyScalar(v);
    S.v = v; S.accel = a; S.side = 0;
  } else {
    // ---- air: thrust + strafe with linear drag, yaw from A/D
    const strafe = (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0);
    const thrust = converting ? 0 : up - dn;
    vel.addScaledVector(F, thrust * 4.5 * dt).addScaledVector(R, (converting ? 0 : strafe) * 3.4 * dt);
    vel.multiplyScalar(Math.exp(-dt * (converting ? 3 : 0.8)));
    if (vel.length() > 9) vel.setLength(9);
    S.yaw += ((lt - rt) * 1.8 - S.yaw) * Math.min(1, dt * 4);
    S.h += S.yaw * dt;
    S.steer += (0 - S.steer) * Math.min(1, dt * 6);
    S.v = vel.dot(F); S.accel = thrust * 4.5; S.side = vel.dot(R);
  }
  S.vx = vel.x; S.vz = vel.z;
  S.x += vel.x * dt; S.z += vel.z * dt;
  S.odo += vel.length() * dt;

  // body attitude: roll outward in road turns, bank into air turns; squat/dive with acceleration
  const rollT = fly < 0.5 ? clamp(S.v * S.yaw * 0.022, -0.07, 0.07) : clamp(-S.yaw * 0.17 + S.side * 0.035, -0.3, 0.3);
  const pitchT = fly < 0.5 ? clamp(S.accel * 0.006, -0.045, 0.045) : clamp(-S.accel * 0.024, -0.12, 0.12);
  S.roll += (rollT - S.roll) * Math.min(1, dt * 4);
  S.pitch += (pitchT - S.pitch) * Math.min(1, dt * 3);

  S.wheel -= (S.v * (1 - fly) * dt) / 0.32;
  const fanOn = sstep(0.55, 1, conv);
  S.fanRate += ((14 + Math.hypot(S.vx, S.vz) * 2.4) * fanOn - S.fanRate) * Math.min(1, dt * 2.5);
  S.fan += S.fanRate * dt;
}

/* ---------------- frame ---------------- */
function frame(dt, now) {
  if (!car) return;
  // conversion (3.4 s end to end) and explode (1.1 s)
  if (conv !== convTarget) { const step = reduceMotion ? 1 : dt / 3.4; conv = convTarget > conv ? Math.min(convTarget, conv + step) : Math.max(convTarget, conv - step); }
  car.setConversion(conv);
  if (explode !== explodeTarget) { const step = reduceMotion ? 1 : dt / 1.1; explode = explodeTarget > explode ? Math.min(1, explode + step) : Math.max(0, explode - step); }
  car.setExplode(easeInOut(explode));

  simulate(dt);
  car.setSteer(S.steer * (1 - sstep(0.02, 0.3, conv)));
  car.setSpin(S.wheel, S.fan);

  const t = now * 0.001, hover = sstep(0.6, 1, conv);
  car.root.position.set(S.x, 0, S.z);
  car.root.rotation.y = S.h;
  car.pivot.position.y = 0.55 + hover * Math.sin(t * 1.7) * 0.014;
  car.pivot.rotation.x = S.roll + hover * Math.sin(t * 1.3 + 1) * 0.006;
  car.pivot.rotation.z = S.pitch + hover * Math.sin(t * 1.1) * 0.007;
  mats.fan.emissiveIntensity = hover * 3.4;
  mats.shared.uGrime.value = 1 - hover * 0.35;

  // camera rides along with the car
  const lift = car.state.lift;
  const dx = S.x - lastX, dz = S.z - lastZ, dy = dragging ? 0 : lift - lastLift;
  lastX = S.x; lastZ = S.z; lastLift = lift;
  if (dx || dz || dy) {
    const d = new THREE.Vector3(dx, dy, dz);
    camera.position.add(d); controls.target.add(d);
    if (tween) { tween.t0.add(d); tween.t1.add(d); }
  }

  key.position.set(S.x + 3, 6, S.z + 2.6);
  key.target.position.set(S.x, 0, S.z);
  shadowPlane.position.set(S.x, 0, S.z);
  groundGrid.position.set(S.x, -0.001, S.z);
  groundGrid.material.uniforms.uCenter.value.set(S.x, S.z);

  // downwash under each fan + trails at each contact
  car.contactPoints(tmpPts);
  tmpPts.forEach((p, i) => {
    const w = washes[i];
    w.position.x = p.x; w.position.z = p.z;
    const s = 0.9 + p.y * 0.9 + Math.sin(t * 3 + i) * 0.03;
    w.scale.set(s, s, 1);
    w.material.opacity = 0.45 * hover;
    w.visible = hover > 0.001 && !wire;
    w.userData.v = w.visible;
    addTrailPoint(trails[i], p);
  });
}
function addTrailPoint(tr, p) {
  const last = tr.pts[tr.pts.length - 1];
  if (last ? Math.hypot(p.x - last[0], p.z - last[1]) < 0.08 : Math.hypot(S.vx, S.vz) < 0.05) return;
  tr.pts.push([p.x, p.z]);
  if (tr.pts.length > TRAIL_MAX) tr.pts.shift();
  const pos = tr.g.attributes.position.array, col = tr.g.attributes.color.array, n = tr.pts.length;
  for (let i = 0; i < n; i++) {
    pos[i * 3] = tr.pts[i][0]; pos[i * 3 + 1] = 0.004; pos[i * 3 + 2] = tr.pts[i][1];
    col[i * 4] = 0.82; col[i * 4 + 1] = 0.92; col[i * 4 + 2] = 1; col[i * 4 + 3] = Math.pow(i / n, 2) * 0.45;
  }
  tr.g.attributes.position.needsUpdate = true;
  tr.g.attributes.color.needsUpdate = true;
  tr.g.setDrawRange(0, n);
  tr.line.computeLineDistances();
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // nudge the car left of centre when the projection panel is docked on the right
  if (getComputedStyle(orthoEl).display !== 'none') camera.setViewOffset(w, h, Math.round(w * 0.06), 0, w, h);
  else if (w < 900) camera.setViewOffset(w, h, 0, Math.round(h * 0.06), w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (document.hidden) return;
  frame(dt, now);
  stepTween(now);
  controls.update();
  // keep the orbit target near the car so panning can't lose it
  if (car) {
    const off = controls.target.clone().sub(new THREE.Vector3(S.x, 0, S.z)).clamp(new THREE.Vector3(-2, -0.2, -1.6), new THREE.Vector3(2, 2.4, 1.6));
    controls.target.set(S.x + off.x, off.y, S.z + off.z);
  }
  renderer.render(scene, camera);
  if (++orthoFrame % (reduceMotion ? 1 : 1) === 0) renderOrtho();
  updateHud();
}

/* ---------------- boot ---------------- */
camera.position.set(-5.5, 2.8, 5.5);
controls.target.set(0, VIEW_TGT_Y, 0);
requestAnimationFrame(loop);

(async function boot() {
  // decals are drawn with the page fonts, so give them a moment to arrive
  try {
    await Promise.race([
      Promise.all(['800 40px "Bricolage Grotesque"', '700 40px "IBM Plex Mono"'].map((f) => document.fonts.load(f))),
      new Promise((r) => setTimeout(r, 1800)),
    ]);
  } catch { /* fall back to system fonts */ }
  mats = createMaterials();
  car = new Vehicle(mats);
  scene.add(car.root);
  car.root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  buildEdges(orthoEdges, (o) => (/tire/.test(o.name) ? 70 : 45), orthoLineMat, (o) => /tread|blades|louver|piping/.test(o.name));
  fillMat.color.set(css('--fill') || '#0f3a5c');
  applyPaint(paint);
  statusEl.hidden = true;
  // opening move: the drawing assembles itself, then the camera settles in
  explode = reduceMotion ? 0 : 1;
  explodeTarget = 0;
  resetView(reduceMotion);
  if (!reduceMotion) { tween && (tween.dur = 1800); }
})().catch((e) => { console.error(e); say('The drawing could not be built: ' + (e?.message || 'unknown error') + '.'); });
