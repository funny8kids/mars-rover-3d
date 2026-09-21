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

// name may carry a subfolder prefix, e.g. 'kenney/space/hangar_largeA'
export function loadModel(name) {
  if (!cache.has(name)) {
    cache.set(name, loader.loadAsync(`./assets/${name}.glb`).then((gltf) => {
      const root = gltf.scenes[0];
      unstub(root);
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
