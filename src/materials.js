import * as THREE from 'three';

/*
 * Material library for the K3.
 *
 * Every "surface" material gets a small shader patch (onBeforeCompile) that adds:
 *   - roughness break-up from 3D value noise (so big panels don't read as plastic)
 *   - road grime that creeps up from the ground plane, in world space
 * The grime height is a uniform so the car looks cleaner once it is airborne.
 */

const shared = {
  uGrime: { value: 1 },       // 0..1 overall grime strength
  uGround: { value: 0 },      // world-space Y of the ground under the car
};

const NOISE = /* glsl */ `
varying vec3 vKWorld;
uniform float uGrime;
uniform float uGround;
uniform float uBreakup;
uniform vec3  uGrimeColor;
float kHash(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float kNoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(kHash(i),               kHash(i+vec3(1,0,0)), f.x),
                 mix(kHash(i+vec3(0,1,0)),   kHash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(kHash(i+vec3(0,0,1)),   kHash(i+vec3(1,0,1)), f.x),
                 mix(kHash(i+vec3(0,1,1)),   kHash(i+vec3(1,1,1)), f.x), f.y), f.z);
}
float kFbm(vec3 p){ return kNoise(p)*0.55 + kNoise(p*2.7)*0.3 + kNoise(p*7.1)*0.15; }
`;

function patch(mat, { breakup = 0.18, grime = 1, grimeColor = 0x2a2620 } = {}) {
  const local = {
    uBreakup: { value: breakup },
    uGrimeColor: { value: new THREE.Color(grimeColor) },
    uGrimeAmt: { value: grime },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, local);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vKWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvKWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE + '\nuniform float uGrimeAmt;\nfloat kGrimeMask;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float h = vKWorld.y - uGround;
          float n = kFbm(vKWorld * 9.0);
          kGrimeMask = (1.0 - smoothstep(0.05, 0.42, h + (n - 0.5) * 0.22)) * uGrime * uGrimeAmt;
          diffuseColor.rgb = mix(diffuseColor.rgb, uGrimeColor, kGrimeMask * 0.55);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (kFbm(vKWorld * 23.0) - 0.5) * uBreakup + kGrimeMask * 0.3, 0.04, 1.0);`);
  };
  mat.customProgramCacheKey = () => 'k3-' + mat.name;
  return mat;
}

export function createMaterials() {
  const m = {};

  m.paint = patch(new THREE.MeshPhysicalMaterial({
    name: 'paint', color: 0xeeeae2, roughness: 0.42, metalness: 0,
    clearcoat: 0.6, clearcoatRoughness: 0.28, side: THREE.DoubleSide,
  }), { breakup: 0.12 });

  m.accent = patch(new THREE.MeshPhysicalMaterial({
    name: 'accent', color: 0xffb02e, roughness: 0.38, metalness: 0,
    clearcoat: 0.5, clearcoatRoughness: 0.3,
  }), { breakup: 0.12 });

  m.frame = patch(new THREE.MeshStandardMaterial({
    name: 'frame', color: 0x8d939b, roughness: 0.34, metalness: 1,
  }), { breakup: 0.22 });

  m.gunmetal = patch(new THREE.MeshStandardMaterial({
    name: 'gunmetal', color: 0x4d535b, roughness: 0.3, metalness: 1,
  }), { breakup: 0.25 });

  m.satin = patch(new THREE.MeshStandardMaterial({
    name: 'satin', color: 0x1b1d21, roughness: 0.62, metalness: 0.1,
  }), { breakup: 0.16 });

  m.rubber = patch(new THREE.MeshStandardMaterial({
    name: 'rubber', color: 0x161616, roughness: 0.9, metalness: 0,
  }), { breakup: 0.1, grimeColor: 0x3a342b });

  m.seat = patch(new THREE.MeshStandardMaterial({
    name: 'seat', color: 0x26282c, roughness: 0.78, metalness: 0,
  }), { breakup: 0.2, grime: 0 });

  m.glass = new THREE.MeshPhysicalMaterial({
    name: 'glass', color: 0x2c3a46, roughness: 0.06, metalness: 0,
    transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide,
    envMapIntensity: 1.4,
  });

  m.led = new THREE.MeshStandardMaterial({ name: 'led', color: 0xffffff, emissive: 0xf4fbff, emissiveIntensity: 3.2 });
  m.tail = new THREE.MeshStandardMaterial({ name: 'tail', color: 0x550a08, emissive: 0xff2a1a, emissiveIntensity: 2.6 });
  m.amber = new THREE.MeshStandardMaterial({ name: 'amber', color: 0x5a3300, emissive: 0xffa21f, emissiveIntensity: 2 });
  m.screen = new THREE.MeshStandardMaterial({ name: 'screen', color: 0x041018, emissive: 0x39d0ff, emissiveIntensity: 1.1 });
  m.fan = new THREE.MeshStandardMaterial({ name: 'fan', color: 0x0c1c24, emissive: 0x6fdcff, emissiveIntensity: 0, roughness: 0.4 });
  m.blade = patch(new THREE.MeshStandardMaterial({
    name: 'blade', color: 0xb7bcc2, roughness: 0.25, metalness: 1, side: THREE.DoubleSide,
  }), { breakup: 0.2, grime: 0 });

  m.decalWord = decal('word');
  m.decalRoundel = decal('roundel');
  m.decalPlate = decal('plate');
  m.decalWarn = decal('warn');

  m.shared = shared;
  return m;
}

/* ---------- decals, drawn on canvases so the project ships zero image files ---------- */

function decal(kind) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  if (kind === 'word') {
    c.width = 512; c.height = 128;
    g.font = '800 92px "Instrument Sans", Arial, sans-serif';
    g.fillStyle = '#16181c';
    g.textBaseline = 'middle';
    g.fillText('KESTREL', 14, 66);
    g.fillStyle = '#ffb02e';
    g.fillRect(14, 112, 120, 8);
  } else if (kind === 'roundel') {
    c.width = c.height = 256;
    g.fillStyle = '#16181c'; g.beginPath(); g.arc(128, 128, 118, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#f2f0ea'; g.beginPath(); g.arc(128, 128, 100, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#16181c';
    g.font = '800 104px "Instrument Sans", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('K3', 128, 136);
  } else if (kind === 'plate') {
    c.width = 512; c.height = 160;
    g.fillStyle = '#f4f1e6'; g.fillRect(0, 0, 512, 160);
    g.strokeStyle = '#16181c'; g.lineWidth = 10; g.strokeRect(8, 8, 496, 144);
    g.fillStyle = '#16181c';
    g.font = '700 84px "IBM Plex Mono", monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('KS·K3·01', 256, 86);
  } else {
    c.width = 256; c.height = 64;
    for (let i = -4; i < 20; i++) {
      g.fillStyle = i % 2 ? '#16181c' : '#ffb02e';
      g.beginPath();
      g.moveTo(i * 22, 0); g.lineTo(i * 22 + 22, 0); g.lineTo(i * 22 - 10, 64); g.lineTo(i * 22 - 32, 64);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return new THREE.MeshStandardMaterial({
    name: 'decal-' + kind, map: tex, transparent: kind !== 'plate' && kind !== 'warn',
    alphaTest: 0.4, roughness: 0.5, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
}

/* ---------- paint schemes ---------- */
export const PAINTS = [
  { name: 'Signal', body: '#eeeae2', accent: '#ffb02e', mark: '#ffb02e' },
  { name: 'Cyanotype', body: '#c9dcea', accent: '#1d3f6e', mark: '#7cc4ff' },
  { name: 'Ember', body: '#33363b', accent: '#ff5a2a', mark: '#ff7a4f' },
  { name: 'Moss', body: '#6f7552', accent: '#e9e1c8', mark: '#cfe08a' },
  { name: 'Arctic', body: '#b8bec4', accent: '#18b6a6', mark: '#3fe0cf' },
];
