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
    for (const mt of mats) {
      if (!mt) continue;
      if (mt.metalness >= 0.99 && mt.roughness >= 0.99 && !mt.metalnessMap && !mt.roughnessMap) {
        const b = BRDF[mt.name] || [0.06, 0.6];
        mt.metalness = b[0];
        mt.roughness = b[1];
      }
      desun(mt);
    }
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
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
