import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/*
 * Kestrel K3 — procedural reverse-trike that converts into a three-fan hover craft.
 *
 * Axes (vehicle-local): +X forward, +Y up, +Z right. Ground is y = 0.
 *
 * Scene graph:
 *   vehicle (position/heading from the sim)
 *    └ pivot (y = PIVOT, carries roll/pitch/bob so the car tilts about its middle)
 *       └ rig (y = -PIVOT + hover lift)
 *          ├ body parts …
 *          ├ front[L|R]: slide → steer → flip → { spin (tire, rim, tread), rotor, shroud }
 *          └ rearPivot (swingarm) → flip → { spin, rotor, shroud }
 *
 * Conversion progress t ∈ [0,1]:
 *   0.00–0.35  front hubs slide outward 240 mm
 *   0.20–0.60  swingarm tucks up
 *   0.25–0.75  every wheel rolls 90° flat → its spokes become a lift fan
 *   0.55–1.00  the whole craft climbs 450 mm
 */

export const PIVOT = 0.55;
const WHEEL_R = 0.32;          // outer tire radius
const HUB_Y = WHEEL_R;
const FRONT_X = 0.78;
const REAR_X = -1.02;
const TRACK_ROAD = 0.56;       // hub |z| on the road
const TRACK_AIR = 0.86;        // hub |z| in the air
const POD = { x0: -0.72, x1: 1.12, y: 0.54, r: 0.32, sy: 0.85, sz: 0.95 };

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** fraction of max radius of the fuselage pod at length position x */
function podFrac(x) {
  const t = (x - POD.x0) / (POD.x1 - POD.x0);
  if (t <= 0 || t >= 1) return 0;
  if (t < 0.4) return 0.55 + 0.45 * Math.sin((Math.PI / 2) * (t / 0.4));
  return Math.pow(Math.cos((Math.PI / 2) * ((t - 0.4) / 0.6)), 0.6);
}
/** half-width (|z|) of the pod surface at (x, y) */
function podZ(x, y) {
  const r = POD.r * podFrac(x);
  const ry = r * POD.sy, rz = r * POD.sz;
  const dy = (y - POD.y) / ry;
  return dy >= 1 ? 0 : rz * Math.sqrt(1 - dy * dy);
}
function podTop(x) { return POD.y + POD.r * podFrac(x) * POD.sy; }

export class Vehicle {
  constructor(mats) {
    this.m = mats;
    this.root = new THREE.Group();
    this.root.name = 'K3';
    this.pivot = new THREE.Group();
    this.pivot.position.y = PIVOT;
    this.pivot.rotation.order = 'YXZ';
    this.rig = new THREE.Group();
    this.rig.position.y = -PIVOT;
    this.root.add(this.pivot);
    this.pivot.add(this.rig);

    this.explodables = [];   // { o, base, v }
    this.rotors = [];        // { o, dir }
    this.spinners = [];      // wheel spin groups
    this.hubs = [];          // { side, flip, steer?, slide? }
    this.contacts = [];      // objects whose world position marks a wheel/fan center
    this.shrouds = [];
    this.state = { t: -1, lift: 0, flip: 0 };

    this.buildBody();
    this.buildFront(-1);
    this.buildFront(1);
    this.buildRear();

    this.root.traverse((o) => {
      if (o.isMesh) {
        const decal = o.material.name.startsWith('decal');
        o.castShadow = !decal && o.material !== mats.glass;
        o.receiveShadow = true;
      }
    });
    this.setConversion(0);
  }

  /* ---------- helpers ---------- */
  part(geo, mat, parent, name, pos = V(), explode = V(), rot) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.position.copy(pos);
    if (rot) mesh.rotation.set(rot.x, rot.y, rot.z);
    parent.add(mesh);
    this.explodables.push({ o: mesh, base: mesh.position.clone(), v: explode });
    return mesh;
  }
  group(parent, name, pos = V(), explode) {
    const g = new THREE.Group();
    g.name = name;
    g.position.copy(pos);
    parent.add(g);
    if (explode) this.explodables.push({ o: g, base: g.position.clone(), v: explode, group: true });
    return g;
  }

  /* ---------- fuselage ---------- */
  buildBody() {
    const { m } = this;
    const body = this.group(this.rig, 'body');

    // Pod: lathe profile revolved around its long axis, then squashed into an oval section.
    const pts = [new THREE.Vector2(0, POD.x0)];
    for (let i = 0; i <= 64; i++) {
      const x = POD.x0 + ((POD.x1 - POD.x0) * i) / 64;
      pts.push(new THREE.Vector2(Math.max(0.0001, POD.r * podFrac(x + (i === 0 ? 0.0001 : 0))), x));
    }
    pts.push(new THREE.Vector2(0, POD.x1));
    const pod = new THREE.LatheGeometry(pts, 48);
    pod.rotateZ(-Math.PI / 2);            // lathe Y → vehicle +X
    pod.scale(1, POD.sy, POD.sz);
    pod.translate(0, POD.y, 0);
    pod.computeVertexNormals();
    this.part(pod, m.paint, body, 'pod');

    // drafting section lines on the hull: stations every 150 mm plus waterline and keel line.
    // Hidden in the shaded view; shown in wireframe and in the projection views.
    const sec = [];
    const ring = (x) => {
      const r = POD.r * podFrac(x); if (r < 0.01) return;
      for (let i = 0; i < 48; i++) {
        const a0 = (i / 48) * Math.PI * 2, a1 = ((i + 1) / 48) * Math.PI * 2;
        sec.push(x, POD.y + Math.sin(a0) * r * POD.sy, Math.cos(a0) * r * POD.sz, x, POD.y + Math.sin(a1) * r * POD.sy, Math.cos(a1) * r * POD.sz);
      }
    };
    for (let x = -0.6; x <= 1.06; x += 0.15) ring(x);
    for (const [fy, fz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      for (let x = POD.x0; x < POD.x1 - 0.02; x += 0.03) {
        const xs = [x, x + 0.03];
        for (const xx of xs) { const r = POD.r * podFrac(Math.min(POD.x1, xx)); sec.push(xx, POD.y + fy * r * POD.sy, fz * r * POD.sz); }
      }
    }
    const secGeo = new THREE.BufferGeometry();
    secGeo.setAttribute('position', new THREE.Float32BufferAttribute(sec, 3));
    this.sections = new THREE.LineSegments(secGeo, new THREE.LineBasicMaterial({ color: 0xe0f1ff, transparent: true, opacity: 0.55, toneMapped: false }));
    this.sections.visible = false;
    this.sections.raycast = () => {};
    body.add(this.sections);

    // Belly pan + nose splitter
    this.part(rbox(1.15, 0.035, 0.26, 0.012), m.gunmetal, body, 'belly', V(0.18, POD.y - 0.215, 0), V(0, -0.22, 0));
    this.part(rbox(0.32, 0.02, 0.36, 0.008), m.gunmetal, body, 'splitter', V(0.98, 0.43, 0), V(0.3, -0.12, 0));

    // Accent spine stripe: a thin ribbon following the top of the pod
    const spine = [];
    for (let x = -0.55; x <= 0.95; x += 0.05) spine.push(V(x, podTop(x) + 0.002, 0));
    this.part(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(spine), 60, 0.012, 6), m.accent, body, 'spine', V(), V(0, 0.08, 0));

    // Seat — tandem saddle, extruded side profile
    const s = new THREE.Shape();
    s.moveTo(-0.6, 0.68); s.lineTo(0.2, 0.7); s.lineTo(0.26, 0.79);
    s.quadraticCurveTo(0.14, 0.845, 0.04, 0.835); s.lineTo(-0.22, 0.83);
    s.quadraticCurveTo(-0.34, 0.835, -0.4, 0.9); s.lineTo(-0.56, 0.91);
    s.quadraticCurveTo(-0.66, 0.9, -0.62, 0.74); s.closePath();
    const seat = new THREE.ExtrudeGeometry(s, { depth: 0.24, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 4, curveSegments: 16 });
    seat.translate(0, 0.04, -0.12);
    this.part(seat, m.seat, body, 'seat', V(), V(0, 0.42, 0));
    // seat piping
    for (const z of [-0.152, 0.152]) {
      const pipe = [V(-0.58, 0.945, z), V(-0.4, 0.94, z), V(-0.3, 0.88, z), V(0.05, 0.88, z), V(0.22, 0.83, z)];
      this.part(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pipe), 30, 0.006, 5), m.accent, body, 'piping', V(), V(0, 0.42, 0));
    }

    // Tail cap with light bar and plate
    const tail = this.group(body, 'tail', V(-0.68, 0.58, 0), V(-0.3, 0.1, 0));
    this.part(rbox(0.12, 0.2, 0.3, 0.025), m.satin, tail, 'tailcap');
    this.part(new THREE.BoxGeometry(0.012, 0.026, 0.27), m.tail, tail, 'taillight', V(-0.062, 0.06, 0));
    const plate = this.part(new THREE.PlaneGeometry(0.2, 0.0625), m.decalPlate, tail, 'plate', V(-0.0615, -0.03, 0));
    plate.rotation.y = -Math.PI / 2;

    // Tail fin
    const f = new THREE.Shape();
    f.moveTo(0, 0); f.lineTo(0.34, 0); f.lineTo(0.12, 0.27); f.lineTo(0.0, 0.27); f.closePath();
    const fin = new THREE.ExtrudeGeometry(f, { depth: 0.018, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2 });
    fin.translate(0, 0, -0.009);
    this.part(fin, m.accent, body, 'fin', V(-0.74, 0.66, 0), V(-0.25, 0.4, 0));
    this.part(new THREE.BoxGeometry(0.02, 0.01, 0.024), m.amber, body, 'beacon', V(-0.72, 0.935, 0), V(-0.25, 0.42, 0));

    // Windscreen — a sheet bent around the rider and raked back
    const ws = new THREE.BufferGeometry();
    const U = 18, W = 8, pos = [], idx = [];
    for (let j = 0; j <= W; j++) for (let i = 0; i <= U; i++) {
      const u = (i / U) * 2 - 1, v = j / W;
      pos.push(0.6 - v * 0.2 - u * u * 0.09, 0.755 + v * 0.27, u * 0.21 * (1 - 0.25 * v));
    }
    for (let j = 0; j < W; j++) for (let i = 0; i < U; i++) {
      const a = j * (U + 1) + i, b = a + 1, c = a + U + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    ws.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ws.setIndex(idx);
    ws.computeVertexNormals();
    this.part(ws, m.glass, body, 'windscreen', V(), V(0.3, 0.5, 0));
    // screen frame
    const wf = [];
    for (let i = 0; i <= U; i++) { const u = (i / U) * 2 - 1; wf.push(V(0.6 - 0.2 - u * u * 0.09, 1.025, u * 0.21 * 0.75)); }
    this.part(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(wf), 30, 0.008, 6), m.satin, body, 'screen-lip', V(), V(0.3, 0.5, 0));

    // Dash + display
    const dash = this.group(body, 'dash', V(0.5, 0.83, 0), V(0.18, 0.32, 0));
    this.part(rbox(0.12, 0.06, 0.26, 0.02), m.satin, dash, 'dash-housing');
    const scr = this.part(new THREE.PlaneGeometry(0.17, 0.05), m.screen, dash, 'display', V(-0.045, 0.034, 0));
    scr.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    scr.rotateX(0.5);

    // Handlebar yoke
    const bar = this.group(body, 'handlebar', V(0.41, 0.94, 0), V(0.12, 0.36, 0));
    this.part(cyl(0.012, 0.6, 'z'), m.gunmetal, bar, 'bar');
    for (const z of [-0.255, 0.255]) this.part(cyl(0.019, 0.1, 'z'), m.satin, bar, 'grip', V(0, 0, z));
    for (const z of [-0.07, 0.07]) this.part(cyl(0.014, 0.16, 'y'), m.frame, bar, 'riser', V(0.02, -0.08, z));

    // Headlights
    for (const z of [-0.085, 0.085]) {
      const h = this.part(new THREE.CapsuleGeometry(0.018, 0.06, 4, 10), m.led, body, 'headlight', V(1.03, 0.6, z), V(0.25, 0.05, z * 2));
      h.rotation.set(0, z > 0 ? -0.5 : 0.5, Math.PI / 2);
    }

    // Side details per side
    for (const sd of [-1, 1]) {
      // wordmark
      const word = this.part(new THREE.PlaneGeometry(0.34, 0.085), m.decalWord, body, 'wordmark', V(0.12, 0.5, sd * (podZ(0.12, 0.5) + 0.004)), V(0, 0, sd * 0.2));
      word.rotation.y = sd > 0 ? 0 : Math.PI;
      // louvers
      for (let i = 0; i < 5; i++) {
        const x = 0.3 + i * 0.045;
        this.part(rbox(0.024, 0.075, 0.03, 0.006), m.satin, body, 'louver', V(x, 0.615, sd * podZ(x, 0.615)), V(0, 0.05, sd * 0.24));
      }
      // battery pod
      const bat = this.group(body, 'battery', V(-0.06, 0.37, sd * 0.31), V(0, -0.05, sd * 0.36));
      const cap = this.part(new THREE.CapsuleGeometry(0.075, 0.6, 6, 18), m.gunmetal, bat, 'battery-shell');
      cap.rotation.z = Math.PI / 2;
      for (const x of [-0.22, 0, 0.22]) this.part(cyl(0.079, 0.018, 'x'), m.satin, bat, 'battery-band', V(x, 0, 0));
      const warn = this.part(new THREE.PlaneGeometry(0.16, 0.035), m.decalWarn, bat, 'hazard', V(0.11, 0, sd * 0.0765));
      warn.rotation.y = sd > 0 ? 0 : Math.PI;
      // footpeg
      this.part(cyl(0.012, 0.12, 'z'), m.frame, body, 'footpeg', V(-0.1, 0.34, sd * 0.42), V(0, -0.05, sd * 0.3));
      // front arm inner tube (fixed to body)
      this.part(cyl(0.022, 0.34, 'z'), m.frame, body, 'arm-inner', V(FRONT_X, HUB_Y, sd * 0.25), V(0, -0.08, sd * 0.1));
      // drop bracket tying the arm to the pod
      this.part(rbox(0.06, 0.12, 0.04, 0.01), m.frame, body, 'arm-bracket', V(FRONT_X, HUB_Y + 0.06, sd * 0.1), V(0, -0.08, sd * 0.05));
      // amber side marker
      this.part(new THREE.BoxGeometry(0.035, 0.016, 0.01), m.amber, body, 'marker', V(0.86, 0.56, sd * (podZ(0.86, 0.56) + 0.004)), V(0.1, 0, sd * 0.2));
    }

    // Roundel on the nose
    const rd = this.part(new THREE.CircleGeometry(0.06, 40), m.decalRoundel, body, 'roundel', V(0.86, podTop(0.86) + 0.004, 0), V(0.2, 0.25, 0));
    rd.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
    rd.rotateX(0.32);

    this.body = body;
  }

  /* ---------- wheel / fan assembly (shared by all three corners) ---------- */
  wheelAssembly(parent, side, wide, isRear) {
    const { m } = this;
    const out = side === 0 ? 1 : side;   // outward along local wheel axis
    const tube = wide ? 0.115 : 0.095;     // half-width of the tire
    const RI = 0.2, RO = WHEEL_R - 0.012;  // tire bead / tread radii

    const spin = this.group(parent, 'spin');
    this.spinners.push(spin);
    // tire: rounded-rectangle section revolved around the axle
    const prof = [];
    const cr = 0.045;
    prof.push(new THREE.Vector2(RI, -tube * 0.8));
    for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + (i / 8) * (Math.PI / 2); prof.push(new THREE.Vector2(RO - cr + Math.cos(a) * cr, -tube + cr + Math.sin(a) * cr)); }
    for (let i = 0; i <= 8; i++) { const a = (i / 8) * (Math.PI / 2); prof.push(new THREE.Vector2(RO - cr + Math.cos(a) * cr, tube - cr + Math.sin(a) * cr)); }
    prof.push(new THREE.Vector2(RI, tube * 0.8));
    prof.push(new THREE.Vector2(RI - 0.004, 0));
    prof.push(new THREE.Vector2(RI, -tube * 0.8));
    const tire = new THREE.LatheGeometry(prof, 56);
    tire.rotateX(Math.PI / 2);
    this.part(tire, m.rubber, spin, 'tire', V(), V(0, 0, out * 0.22));
    // tread blocks: merged into one mesh so wireframe/explode treat them as one part
    const blocks = [];
    const N = 30;
    for (let i = 0; i < N; i++) for (const row of [-1, 1]) {
      const a = (i / N) * Math.PI * 2 + (row > 0 ? Math.PI / N : 0);
      const b = new THREE.BoxGeometry(0.055, 0.028, tube * 0.85);
      b.rotateZ(a - Math.PI / 2);
      b.translate(Math.cos(a) * (WHEEL_R - 0.004), Math.sin(a) * (WHEEL_R - 0.004), row * tube * 0.42);
      blocks.push(b);
    }
    this.part(mergeGeometries(blocks), m.rubber, spin, 'tread', V(), V(0, 0, out * 0.3));
    // rim band (sits just inside the tire bead)
    const rimPts = [[0.155, -0.07], [0.19, -0.07], [0.203, -0.05], [0.203, 0.05], [0.19, 0.07], [0.155, 0.07], [0.15, 0]]
      .map(([r, y]) => new THREE.Vector2(r, y * (wide ? 1.2 : 1)));
    rimPts.push(rimPts[0].clone());
    const rim = new THREE.LatheGeometry(rimPts, 48);
    rim.rotateX(Math.PI / 2);
    this.part(rim, m.gunmetal, spin, 'rim', V(), V(0, 0, out * 0.12));

    // rotor: spokes on the road, lift fan in the air
    const rotor = this.group(parent, 'rotor', V(), V(0, 0, out * 0.04));
    this.rotors.push({ o: rotor, dir: side === 0 ? 1 : side });
    this.part(cyl(0.05, 0.13, 'z'), m.frame, rotor, 'hub');
    this.part(cyl(0.028, 0.15, 'z'), m.satin, rotor, 'hub-cap');
    const blades = [];
    for (let i = 0; i < 7; i++) {
      const b = new THREE.BoxGeometry(0.105, 0.006, 0.05);
      b.rotateX(0.42);
      b.translate(0.1, 0, 0);
      b.rotateZ((i / 7) * Math.PI * 2);
      blades.push(b);
    }
    this.part(mergeGeometries(blades), m.blade, rotor, 'blades');
    // glow ring that lights up when the fans run
    this.part(new THREE.TorusGeometry(0.152, 0.005, 6, 48), m.fan, parent, 'fan-ring');

    // shroud: a partial shell over the top of the wheel — becomes the fan duct once flat
    const arc = Math.PI * 0.82;
    const shell = new THREE.CylinderGeometry(0.385, 0.385, tube * 2 + 0.05, 48, 1, true, Math.PI - arc / 2, arc);
    shell.rotateX(Math.PI / 2);
    const shroud = this.group(parent, 'shroud', V(), V(0, 0.22, 0));
    this.shrouds.push({ o: shroud, turn: isRear ? Math.PI / 2 : Math.PI });
    this.part(shell, m.paint, shroud, 'shroud-shell');
    const lip = new THREE.TorusGeometry(0.385, 0.012, 6, 48, arc);
    lip.rotateZ(Math.PI / 2 - arc / 2);
    this.part(lip, m.accent, shroud, 'shroud-lip', V(0, 0, out * (tube + 0.025)));
    this.part(lip.clone(), m.satin, shroud, 'shroud-lip-in', V(0, 0, -out * (tube + 0.025)));
    if (!isRear) {
      this.part(new THREE.BoxGeometry(0.05, 0.018, 0.012), m.amber, shroud, 'shroud-marker',
        V(Math.cos(Math.PI / 2 - arc / 2) * 0.385 * 0.95, Math.sin(Math.PI / 2 - arc / 2) * 0.385 * 0.95, out * (tube + 0.03)));
    }
    return spin;
  }

  /*
   * Each wheel hinges about a knuckle at the tip of its arm, KNUCKLE metres inboard of the
   * wheel centre. Rolling the wheel 90° about that knuckle lifts the disc straight up over
   * the arm, so the arm never cuts through the spinning fan.
   */
  buildFront(sd) {
    const { m } = this;
    const K = 0.13;
    // slide position is owned by setConversion; the inner group carries the explode offset
    const slide = this.group(this.rig, 'front-slide', V(FRONT_X, 0, sd * TRACK_ROAD));
    const ex = this.group(slide, 'front-ex', V(), V(0.05, 0, sd * 0.25));
    // telescoping sleeve that rides on the fixed inner tube
    this.part(cyl(0.03, 0.36, 'z'), m.gunmetal, ex, 'sleeve', V(0, HUB_Y, -sd * (K + 0.18)), V(0, 0, -sd * 0.06));
    this.part(cyl(0.035, 0.03, 'z'), m.accent, ex, 'sleeve-collar', V(0, HUB_Y, -sd * (K + 0.35)), V(0, 0, -sd * 0.06));
    this.part(cyl(0.012, 0.3, 'z'), m.satin, ex, 'sleeve-boot', V(0, HUB_Y + 0.045, -sd * (K + 0.17)), V(0, 0.04, -sd * 0.06));
    // knuckle: steering pivots here, and the wheel hinges flat about it
    const steer = this.group(ex, 'steer', V(0, HUB_Y, -sd * K));
    this.part(rbox(0.07, 0.09, 0.05, 0.012), m.frame, steer, 'knuckle', V(), V(0, 0, -sd * 0.08));
    this.part(cyl(0.014, 0.13, 'y'), m.accent, steer, 'kingpin', V(), V(0, 0.08, -sd * 0.08));
    const flip = this.group(steer, 'flip');
    this.part(cyl(0.022, K - 0.05, 'z'), m.gunmetal, flip, 'stub-axle', V(0, 0, sd * (K - 0.05) / 2), V(0, 0, sd * 0.05));
    const holder = this.group(flip, 'holder', V(0, 0, sd * K));
    this.wheelAssembly(holder, sd, false, false);
    const contact = new THREE.Object3D(); holder.add(contact); this.contacts.push(contact);
    this.hubs.push({ slide, steer, flip, sd });
  }

  buildRear() {
    const { m } = this;
    const K = 0.19;                         // single-sided arm on the left, K inboard of the wheel centre
    const pivotPos = V(-0.42, 0.42, -K);
    const swing = this.group(this.rig, 'swingarm', pivotPos, V(-0.12, -0.04, -0.12));
    const hubLocal = V(REAR_X - pivotPos.x, HUB_Y - pivotPos.y, 0);
    const len = hubLocal.length();
    const arm = this.part(rbox(len, 0.06, 0.035, 0.014), m.frame, swing, 'swingarm-arm', V(hubLocal.x / 2, hubLocal.y / 2, 0));
    arm.rotation.z = Math.atan2(hubLocal.y, hubLocal.x);
    this.part(cyl(0.04, 0.12, 'z'), m.gunmetal, swing, 'swing-pivot', V(0, 0, 0.04));
    // in-arm drive motor
    this.part(cyl(0.075, 0.09, 'z'), m.gunmetal, swing, 'motor', V(hubLocal.x * 0.45, hubLocal.y * 0.45, 0), V(0, 0.15, -0.05));
    this.part(cyl(0.078, 0.018, 'z'), m.accent, swing, 'motor-band', V(hubLocal.x * 0.45, hubLocal.y * 0.45, -0.035), V(0, 0.15, -0.08));
    // shock from arm to body
    const shock = this.part(cyl(0.016, 0.26, 'y'), m.accent, swing, 'shock', V(-0.2, 0.12, 0.03), V(0, 0.22, 0));
    shock.rotation.z = -0.75;
    const flip = this.group(swing, 'flip', hubLocal);
    this.part(cyl(0.024, K - 0.06, 'z'), m.gunmetal, flip, 'stub-axle', V(0, 0, (K - 0.06) / 2), V(0, 0, 0.05));
    const holder = this.group(flip, 'holder', V(0, 0, K));
    this.wheelAssembly(holder, 0, true, true);
    const contact = new THREE.Object3D(); holder.add(contact); this.contacts.push(contact);
    this.rear = { swing, flip };
  }

  /* ---------- animation ---------- */
  /** conversion progress 0 (road) → 1 (air). Returns hover lift in metres. */
  setConversion(t) {
    if (t === this.state.t) return this.state.lift;
    const slide = sstep(0, 0.35, t);
    const flip = sstep(0.25, 0.75, t);
    const swing = sstep(0.45, 0.85, t);
    const lift = sstep(0.3, 1, t) * 0.45;
    for (const h of this.hubs) {
      h.slide.position.z = h.sd * (TRACK_ROAD + (TRACK_AIR - TRACK_ROAD) * slide);
      h.flip.rotation.x = -h.sd * flip * (Math.PI / 2);
    }
    // the rear arm drops so the tail fan hangs clear of the body
    this.rear.swing.rotation.z = 0.5 * swing;
    this.rear.flip.rotation.x = -flip * (Math.PI / 2);
    // shrouds swing round the rim so they end up outboard (front) / aft (rear) of each fan
    for (const s of this.shrouds) s.o.rotation.z = flip * s.turn;
    this.rig.position.y = -PIVOT + lift;
    this.state = { t, lift, flip };
    return lift;
  }

  setSteer(a) { for (const h of this.hubs) h.steer.rotation.y = a; }

  /** wheelAngle: rolling angle; fanAngle: extra fan rotation */
  setSpin(wheelAngle, fanAngle) {
    for (const s of this.spinners) s.rotation.z = wheelAngle;
    for (const r of this.rotors) r.o.rotation.z = wheelAngle + r.dir * fanAngle;
  }

  setExplode(e) {
    for (const x of this.explodables) x.o.position.copy(x.base).addScaledVector(x.v, e);
  }

  setPaint(p) {
    this.m.paint.color.set(p.body);
    this.m.accent.color.set(p.accent);
  }

  /** world positions of the three wheel/fan centres */
  contactPoints(out) {
    this.contacts.forEach((c, i) => c.getWorldPosition(out[i]));
    return out;
  }
}

/* ---------- small geometry helpers ---------- */
function cyl(r, len, axis = 'y', seg = 20) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  return g;
}
function rbox(w, h, d, r = 0.01) {
  // rounded box via a beveled extrude
  const s = new THREE.Shape();
  const x = -w / 2 + r, y = -h / 2 + r, W = w - 2 * r, H = h - 2 * r;
  s.moveTo(x, y); s.lineTo(x + W, y); s.lineTo(x + W, y + H); s.lineTo(x, y + H); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.0005, d - 2 * r), bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: 3 });
  g.translate(0, 0, -(d - 2 * r) / 2);
  return g;
}
