import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ─── draw-call collapsing ───
// The base is authored as thousands of separate parts, and each part costs a draw call in the main
// pass and again in the shadow pass. That geometry submission, not the triangle count, is what ate
// the frame budget the rover's steering needed. Every static part sharing a material becomes one
// buffer. Two rules keep this safe:
//   * anything an animation still moves, hides or fades by OBJECT opts out with `noMerge`;
//   * transparent parts stay separate, because merging them would destroy per-piece depth sorting.

// `directOnly` limits the pass to `root`'s own meshes — for the loose struts and tiles placed
// straight onto the world group, where the templates never reached.
export function mergeInto(root, directOnly = false) {
  root.updateMatrixWorld(true);
  const meshes = [];
  collect(root, meshes, directOnly);
  if (meshes.length < 2) return 0;
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map();
  for (const o of meshes) {
    const mat = o.material;
    const key = `${mat.uuid}|${o.castShadow ? 1 : 0}|${o.receiveShadow ? 1 : 0}|${signature(o.geometry)}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, b = { mat, cast: o.castShadow, receive: o.receiveShadow, parts: [] });
    const geo = o.geometry.clone();
    geo.applyMatrix4(directOnly ? o.matrix : new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    b.parts.push({ geo, o });
  }
  const built = [];
  for (const b of buckets.values()) {
    if (b.parts.length < 2) continue;
    const geo = mergeGeometries(b.parts.map(p => p.geo), false);
    for (const p of b.parts) p.geo.dispose();
    if (geo) built.push({ geo, mat: b.mat, cast: b.cast, receive: b.receive, drop: b.parts.map(p => p.o) });
  }
  if (!built.length) return 0;
  // The parts being replaced can sit any depth below `root`, so detach them from whoever holds them.
  for (const m of built) for (const o of m.drop) o.parent?.remove(o);
  for (const m of built) {
    const mesh = new THREE.Mesh(m.geo, m.mat);
    mesh.castShadow = m.cast;
    mesh.receiveShadow = m.receive;
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
  }
  return built.length;
}

export function noMerge(obj) {
  obj.userData.rsbNoMerge = 1;
  return obj;
}

// mergeGeometries rejects the whole batch over one mismatched attribute, so parts are bucketed by
// everything it compares: index presence, morph targets, and each attribute's size and encoding.
function signature(geo) {
  const parts = [!!geo.index, Object.keys(geo.morphAttributes).length];
  for (const n of Object.keys(geo.attributes).sort()) {
    const a = geo.attributes[n];
    parts.push(`${n}:${a.itemSize}:${a.normalized ? 1 : 0}`);
  }
  return parts.join('|');
}

function collect(root, out, directOnly) {
  for (const child of root.children) {
    // the flag belongs to the whole branch: an animated rig keeps every one of its parts
    if (child.userData.rsbNoMerge) continue;
    if (child.isMesh) {
      const mat = child.material;
      if (!Array.isArray(mat) && mat && !mat.transparent && !child.isSkinnedMesh &&
          Object.keys(child.geometry.morphAttributes).length === 0) out.push(child);
    }
    if (!directOnly && child.children.length) collect(child, out, false);
  }
}
