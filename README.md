# Kestrel K3

An interactive engineering drawing of an original reverse-trike that folds its three wheels flat and flies on them. Plain Vite + Three.js, no framework, and no binary assets: the vehicle, decals and textures are all generated in code.

## Run

```bash
npm install
npm run dev            # local dev server
npm run build          # production build → dist/
npm run build:single   # one self-contained HTML → dist-single/index.html
```

## Controls

| Key | Action |
| --- | --- |
| W A S D / arrows | Drive (ground) · thrust and yaw (sky) |
| Space | Convert ground ↔ sky (3.4 s) |
| Q / E | Strafe (sky only) |
| R | Recenter |
| Drag / scroll | Orbit / zoom |

## How it's built

| File | What it does |
| --- | --- |
| `src/vehicle.js` | Procedural model, about 150 parts: lathe hull, extruded seat, revolved tires, merged tread and blades. Defines the conversion rig, explode vectors and hull section lines. |
| `src/materials.js` | PBR material set. An `onBeforeCompile` patch adds noise-based roughness break-up and world-space road grime. Decals are drawn on canvases. Also holds the paint presets. |
| `src/main.js` | Renderer, lighting, sim, HUD and camera. See the breakdown below. |
| `src/style.css` | Cyanotype drawing-sheet layout. Responsive down to phone width. |

What `src/main.js` handles:

- Renderer and lighting.
- A world-fixed fading ground grid, which makes motion readable.
- The drive and fly sim: a bicycle model on the road, and damped thrust plus strafe in the air.
- Wheel trails and fan downwash.
- The HUD.
- The live third-angle projection: plan, side and front views, rendered each frame into scissored viewports with orthographic cameras and line art.
- Wireframe and explode modes.
- The camera follow and tween.

### Conversion timeline (`Vehicle.setConversion(t)`)

| t | What moves |
| --- | --- |
| 0.00–0.35 | Front arms telescope out 300 mm per side. |
| 0.25–0.75 | Each wheel hinges 90° about the knuckle at the end of its arm. The disc lifts clear of the arm, and its spokes become a lift fan. Shrouds swing round the rim to sit outboard of the front fans and aft of the rear fan. |
| 0.45–0.85 | The rear swingarm drops so the tail fan clears the hull. |
| 0.30–1.00 | The hull climbs 450 mm. |

## Swapping in your own model

`Vehicle` exposes a small surface that `main.js` relies on. Replace it with a GLB-backed class that implements the same members and the rest keeps working:

- `root`, `pivot`, `state`, `sections`
- `setConversion`, `setSteer`, `setSpin`, `setExplode`, `setPaint`, `contactPoints`
