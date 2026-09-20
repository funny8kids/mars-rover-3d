// glTF asset registry — hero pieces authored in Blender
// (tools/blender/build_heroes.py, tools/blender/build_assets.py) plus the CC0
// Kenney Space Kit / Nature Kit packs vendored under public/assets/kenney/.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const cache = new Map();

// name may carry a subfolder prefix, e.g. 'kenney/space/hangar_largeA'
export function loadModel(name) {
  if (!cache.has(name)) {
    cache.set(name, loader.loadAsync(`./assets/${name}.glb`).then((gltf) => {
      const root = gltf.scenes[0];
      root.traverse((o) => {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      });
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
