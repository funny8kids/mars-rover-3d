#!/usr/bin/env node
// Is the sky dome's 48 × 32 tessellation costing anything a player could see?
//
// The dome (src/world/sky.js) colours every fragment from `normalize(vDir)`, and SKY_VS builds that
// direction out of the interpolated vertex position. Flat triangles are chords, so the mesh can lie
// two different ways, and the census marker on the call needs them told apart:
//
//   parallax — the dome sits at the world origin and never moves, while the camera drives up to the
//     crater rim away from it. `normalize(hit)` is then a direction measured at the crater's centre,
//     not at the eye, so the whole sky (disc included) sits slightly off where an infinite-distance
//     sun would put it. This scales as offset / radius: only the 7000 moves it.
//   tessellation — the chord is inside the sphere, so the hit point is early by up to
//     R·(1 − cos(half-step)). This scales as step²: only the 48 × 32 moves it.
//
// So: cast rays from an off-centre camera, and compare the direction the shader gets off the real
// mesh against (a) the ray itself and (b) the direction a perfectly round dome of the same radius
// would have given. N points on a golden spiral — a search, not a proof.
//
// Usage: node tools/dome-direction-error.mjs
import * as THREE from 'three';

const R = 7000;
const DEG = 180 / Math.PI;
// The rover is bounded by the crater rim; photo mode adds a 120 m standoff (src/main.js:1581 clamps
// `photo.dist` to ≤ 120), so the furthest the eye can plausibly get from the dome's centre is the sum.
const OFFSETS = [[118, 'ISLAND.radius 118 — the flat playfield (src/config.js:32)'],
                 [132, 'ISLAND.rim 132 — the last ground the rover is allowed on'],
                 [250, '132 + photo mode 120 m — the worst reachable eye']];
const RES = [[12, 8], [24, 16], [48, 32], [96, 64]];
const N = 10000;

function goldig(n) {
  const pts = []; const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2, r = Math.sqrt(Math.max(0, 1 - y * y)), th = ga * i;
    pts.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r));
  }
  return pts;
}

// |cam + t·d| = R for a camera strictly inside the sphere: one positive root, no sign guessing.
const roundHit = (cam, d) => {
  const b = cam.dot(d);
  return cam.clone().addScaledVector(d, -b + Math.sqrt(b * b - cam.lengthSq() + R * R));
};

function scan(cam, segW, segH, pts) {
  const geo = new THREE.SphereGeometry(R, segW, segH);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.BackSide }));
  mesh.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  let maxTess = 0, sumTess = 0, maxPar = 0, sumPar = 0, hits = 0;
  for (const d of pts) {
    rc.set(cam, d);
    const h = rc.intersectObject(mesh, false)[0];
    if (!h) continue;
    hits++;
    const flat = h.point.normalize();                          // what the fragment actually gets
    const tess = flat.angleTo(roundHit(cam, d).normalize()) * DEG;
    const par = flat.angleTo(d) * DEG;
    maxTess = Math.max(maxTess, tess); sumTess += tess;
    maxPar = Math.max(maxPar, par); sumPar += par;
  }
  if (hits < pts.length * 0.999) {
    console.error(`PROBE_RC=1 — ${segW}×${segH}: only ${hits} of ${pts.length} rays hit the dome; the means below would average a hole`);
    process.exit(1);
  }
  return { verts: geo.attributes.position.count, tris: geo.index.count / 3, hits, maxTess, meanTess: sumTess / hits, maxPar, meanPar: sumPar / hits };
}

for (const [off, label] of OFFSETS) {
  const cam = new THREE.Vector3(off, 1.7, 0);
  const pts = goldig(N);
  console.log(`\neye ${cam.toArray().join(', ')} m from the dome's centre — ${label}`);
  for (const [w, h] of RES) {
    const r = scan(cam, w, h, pts);
    const flag = w === 48 && h === 32 ? '   ← shipped' : '';
    console.log(
      `  SphereGeometry(${R}, ${String(w).padStart(3)}, ${String(h).padStart(3)})  verts ${String(r.verts).padStart(6)}  tris ${String(r.tris).padStart(6)}  hits ${r.hits}` +
      `  | tessellation-only: max ${r.maxTess.toFixed(4)}°  mean ${r.meanTess.toFixed(5)}°` +
      `  | vs the true view direction: max ${r.maxPar.toFixed(3)}°  mean ${r.meanPar.toFixed(3)}°${flag}`
    );
  }
}
const ramp = Math.acos(0.99985) * DEG, edge = Math.acos(0.99993) * DEG;
console.log(`\nscale: the sun disc's ramp spans ${(ramp - edge).toFixed(3)}° (${edge.toFixed(2)}° → ${ramp.toFixed(2)}° half-angle, SKY_FS smoothstep 0.99985→0.99993).`);
console.log('the second column is the same number at every tessellation and shrinks as 1/radius — it is parallax, not the mesh; the first column is the mesh, and at the shipped 48 × 32 it is a ninety-eighth of the disc ramp quoted above.');
console.error('PROBE_RC=0');
