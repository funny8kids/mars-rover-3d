// glTF asset registry — hero pieces authored in Blender
// (tools/blender/build_heroes.py, tools/blender/build_assets.py) plus the CC0
// Kenney Space Kit / Nature Kit packs vendored under public/assets/kenney/.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map();

// glTF's fallback material is metallicFactor 1 / roughnessFactor 1 with no maps, which the spec
// resolves to a perfectly-rough pure conductor — in practice a black hole that swallows the albedo.
// Every CC0 pack vendored here exports exactly that, because it was authored for a non-PBR engine.
// They are painted alloy, stone and foliage, so give the stub a dielectric BRDF on the way in.
const BRDF = {
  metal: [0.08, 0.36], metalRed: [0.08, 0.44], metalDark: [0.14, 0.46], dark: [0.04, 0.74],
  rock: [0, 0.93], rockDark: [0, 0.93], rockTrack: [0, 0.9], dirt: [0, 0.96], grass: [0, 0.92],
  skin: [0, 0.66], crystal: [0.2, 0.12], leaf: [0, 0.85], wood: [0, 0.8], _defaultMat: [0.05, 0.55],
};

// A pale full conductor at roughness ~0.2 is a mirror, and a mirror facing a 3.4-intensity sun
// clips: the lamp heads and rail posts drew as blank white tiles before bloom even entered the
// chain (measured — 2.5% of one lamp head sat at 255,255,255). envMapIntensity does nothing about
// it, because the spike is the direct analytic light, not image-based. 0.62 keeps a readable
// metallic gradient and removes 96% of the clipped pixels. Darker metals return less of the sun,
// so they may stay glossier.
function desun(mt) {
  if (!mt || mt.metalness <= 0.5 || !mt.color) return;
  const luma = mt.color.r + mt.color.g + mt.color.b;
  const floor = luma > 1.6 ? 0.62 : 0.44;
  if (mt.roughness < floor) mt.roughness = floor + (mt.roughness % 0.05);
}

// Blender's glTF exporter stamps `doubleSided: true` onto EVERY material it writes, whatever the
// model is — all 35 hero GLBs and all 91 Kenney ones, with no exceptions and no art decision behind
// any of it. GLTFLoader turns that into THREE.DoubleSide, which switches off backface culling in the
// beauty pass and, because three derives `shadowSide` from `side` when `shadowSide` is null, also
// rasterises both faces of every one of them into the sun's depth map. Measured on the hub at
// 640x696 with the shadow map refreshed every frame: 1 704 062 of 1 862 694 scene triangles — 91% of
// everything being drawn — were double-drawn.
// So: cull by default, and keep DoubleSide only where the geometry genuinely has a back that gets
// seen. That is decided offline, per primitive, from mesh topology — weld the vertices, then count
// edges touched by exactly one triangle. A *closed* shell has none, and from outside it the back
// faces are always behind the front ones, so culling cannot change a pixel. Anything with a boundary
// edge is an open surface, and culling its back face deletes it the moment the camera sees the
// concave side. `tools/audit_double_sided.mjs` computes this and prints the table below; `--check`
// fails if the library and this list have drifted apart.
//
// The predicate used to be a *ratio* — a primitive had to be at least 25% boundary edges to count as
// a sheet. That is what the frame sweep caught it getting wrong: a thin open shell, e.g. the
// starship's aft skirt, is a lampshade with two rim loops, so it measures ~4% boundary and was
// classed as a solid. Culled, the skirt vanished when the rover drove under the ship, and the
// overhead chopstick arm vanished from the pad — 2 739 and 17 546 changed pixels at those two
// vantages. So the test is now the honest binary one: any boundary edge at all means the shell is
// not closed. 243 924 of 714 568 library triangles are open, over the 48 material names below
// (386 476 triangles, 54%). The over-retention is forced by the runtime's granularity — the decision
// is per material, so a material with one open primitive stays DoubleSide everywhere.
//
// Cost, measured on the hub in one synchronous task, 4 rounds x 3 conditions x 15 frames, shadow map
// pinned every frame, one amortised flush per block (medians; every no-policy block was slower than
// every honest-list block, which was slower than every ratio-list block):
//   no policy              12.13 ms   1 704 062 triangles double-drawn
//   this list (48 names)   11.40 ms   1 094 620   — keeps 0.73 ms of the 1.46 ms the policy is worth
//   the old ratio list     10.67 ms     611 790   — rejected: it deletes visible surfaces
// Acceptance for the list above: with the scene rendered twice at 320x348, once with no policy and
// once with it, 159 camera vantages that the chase rig can actually occupy (filtered against every
// collider disc and against the standable height) came back with a max luminance delta of 0 — not
// "small": zero, byte for byte.
const SHEET_MATERIALS = new Set([
  // Terrain and rock skins — the ground itself is a single-sided surface in these packs, so culling
  // would punch holes in the planet: dust_mars is 36 246 of 36 246 triangles open, grass, dirt,
  // _defaultMat and the rock set are 100%.
  'dust_mars', 'grass', 'dirt', 'rockTrack', 'rock', 'rockDark', '_defaultMat', 'crystal',
  // Our own heroes' cladding: shells rather than walls, so the inside of a skin IS the visible face
  // (cryo tanks, greenhouse, habitat dome, launch tower, watch deck, lamp, lander, gantry, rover).
  'alu_bright', 'worn_metal', 'hull_white', 'hull_warm', 'composite_rub', 'footing_cast',
  'deck_roof', 'floor_grate', 'cu_pipe', 'dark', 'dark_panel', 'rust_orange', 'cryo_insul',
  'steel', 'deck_steel', 'deck_cast', 'pad_white', 'glass_clear', 'hero_steel',
  'rover_alu', 'rover_dark', 'rover_glass', 'solar_cell', 'grow_soil', 'thruster_soot',
  // Starship stack: the aft skirt, skin, nozzles, fins, wordmark and glazing are all authored as
  // open shells, not as solids of revolution — this is the group the ratio test got wrong.
  'rocket_struct', 'rocket_skin', 'rocket_nozzle', 'rocket_burnt', 'rocket_burnt_tex',
  'rocket_wordmark', 'rocket_glass',
  // Emitters and Kenney kit detail — lamps, straps, panel decals and suits, all single-sided quads.
  'light_cyan', 'light_amber', 'light_warm', 'acc_orange',
  'metal', 'metalDark', 'metalRed', 'skin',
]);

function unstub(root) {
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    let pane = false;
    for (const mt of mats) {
      if (!mt) continue;
      if (mt.metalness >= 0.99 && mt.roughness >= 0.99 && !mt.metalnessMap && !mt.roughnessMap) {
        const b = BRDF[mt.name] || [0.06, 0.6];
        mt.metalness = b[0];
        mt.roughness = b[1];
      }
      // KHR_materials_transmission is the most expensive line item in the whole frame. Any material
      // with transmission > 0 makes three.js draw the entire opaque scene a SECOND time before the
      // pane itself — at full drawing-buffer size, into a 4x-multisampled target, and then build a
      // mip chain of it. Measured at 2529x1423 on the hub, shadow refresh pinned out so it is a
      // clean A/B over the same 7 materials: 2 113 draws / 2.32 M triangles per frame without it,
      // 3 100 / 3.47 M with it. Seven window meshes were costing half the frame's submitted work to
      // buy a blurred copy of the scene behind the glass — and every one of them exports thickness
      // 0, so there was not even any refraction to show for it. The same read — dark, hard,
      // sky-reflecting — is what the glazing recipe already does with a blend, so blend it.
      // props.js retints these by name afterwards and stays in charge of colour.
      if (mt.transmission > 0) {
        const t = mt.transmission;
        mt.transmission = 0;
        mt.transparent = true;
        mt.opacity = 1 - 0.74 * t;
        mt.depthWrite = false;
        if (mt.roughness > 0.2) mt.roughness = 0.08;
        pane = true;
      } else if (mt.transparent && mt.opacity < 0.9) {
        // Authored in Blender as a plain BLEND pane rather than KHR transmission: same mismatch.
        pane = true;
      }
      desun(mt);
      // Cull the back face unless this material is a measured one-sided sheet. Runs after the pane
      // rewrite on purpose: a blended window that keeps only its near face is the correct glass, not
      // two overlapping panes, and the audit already exempts the glazing that is a bare quad.
      if (mt.side === THREE.DoubleSide && !SHEET_MATERIALS.has(mt.name)) mt.side = THREE.FrontSide;
    }
    // A quarter-opaque pane that drops a fully solid shadow is the shadow/solid mismatch the shadow
    // pass is glad to produce, because it reads depth and knows nothing about alpha. The hull, frame
    // and mullions around the glazing are separate opaque meshes and still shade the deck properly.
    // The flag has to travel on the object, not just set the flag once: props.js re-arms whole
    // hierarchies with `castShadow = true` after loadModel() returns, and its own glass test is by
    // mesh name — which misses every cube exported as `Cube_9`. userData survives cloneModel().
    if (o.isMesh) { o.userData.rsbPane = pane; o.castShadow = !pane; o.receiveShadow = true; }
  });
}

// Kenney authors every module inside a 4 × 3 grid cell, so the piece itself sits at local (2, 1.5)
// and the node marks the cell's corner. Our own Blender assets are modelled about their own centre.
// The layout code names one thing — where a prop stands — so the packs are recentred on load and
// both libraries mean "footprint centre at the origin". Uncorrected, every Kenney prop landed
// ~(7, 5.25) m away from its authored coordinate: the hub plaza paving lay off its own slab, the
// ring buildings stood a full lane outside their collision discs, and a dune rock sampled its
// ground height at a point it no longer covered.
function recentre(root) {
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(root);
  const dx = (b.min.x + b.max.x) / 2, dz = (b.min.z + b.max.z) / 2;
  if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return;
  // The children keep their own transforms, so a kit whose parts are cloned out individually
  // (`barrier_kit`) still assembles the same way — the whole pack just moves together.
  for (const c of root.children) { c.position.x -= dx; c.position.z -= dz; }
  root.updateMatrixWorld(true);
}

// `rim_rock` opts out because it is a kit of *alternatives*: three sibling nodes that are each
// cloned and placed on their own, with a collision table measured about each node's own origin.
// Recentring moves every child by the union bbox's centre — harmless when a pack's parts travel
// together, and a silent half-metre lie the moment they are placed separately. Everything else in
// the library has been laid out under the recentre it gets, so the exemption stays name-specific.
// `lox_stand` opts out because a bbox centre is not always the datum: this builder puts its origin
// on the middle of the bund the drum stands in, and the asset then carries a 5.7 m cryo transfer
// line away from it. The union bbox's centre rides 2.13 m out along that line — measured, the shift
// is (−0.77, +1.98) — so recentring dragged the whole stand back off its own collision discs and
// left the line short of the pad it feeds. The same footprint-centre lie as the Kenney cells, but
// here the correct datum is the authored one.
const NO_RECENTRE = new Set(['rim_rock', 'lox_stand']);

// name may carry a subfolder prefix, e.g. 'kenney/space/hangar_largeA'
export function loadModel(name) {
  if (!cache.has(name)) {
    cache.set(name, loader.loadAsync(`./assets/${name}.glb`).then((gltf) => {
      const root = gltf.scenes[0];
      unstub(root);
      if (!NO_RECENTRE.has(name.split('/').pop())) recentre(root);
      return root;
    }));
  }
  return cache.get(name);
}

export function cloneModel(model) {
  return model.clone();
}

// Deep-clone node materials so animations (light show, headlights) never touch
// the shared stock materials used by every other instance.
export function cloneMaterials(root, only) {
  const map = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (only && !only(o, mats)) return;
    const out = mats.map((m) => {
      if (!map.has(m)) map.set(m, m.clone());
      return map.get(m);
    });
    o.material = out.length === 1 ? out[0] : out;
  });
  return map;
}

export function findByName(root, name) {
  let hit = null;
  root.traverse((o) => { if (!hit && o.name === name) hit = o; });
  return hit;
}

export function findMeshByMaterial(root, matName) {
  let hit = null;
  root.traverse((o) => {
    if (hit || !o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m && m.name === matName)) hit = o;
  });
  return hit;
}
