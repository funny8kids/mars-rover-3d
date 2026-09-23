import * as THREE from 'three';

// Shafts of light across a floodlit pad — geometry again rather than particles, for the same reason
// the exhaust is (`fx/plume.js`): a beam is one continuous object, and what replaced it here before
// was three `MeshBasicMaterial` cones.
//
// The old set was wrong twice over. Its coordinates were hand-typed next to the pad rather than
// derived from anything on it — two 44 m shafts standing 11 m off the pad axis with no luminaire at
// their feet, and a third whose base sat 2.5 m inside the watch deck's floor plate — and being flat
// additive shells they drew their own silhouette, so every beam ended in a 20-metre straight edge
// instead of running out of light. `plume.js` had already named that defect in prose; this is the
// fix for the object it named.
//
// So the shafts here are posed off the pad's own ring of flood lenses (`world/props.js` exports them
// as `launchRig.floods`), and the shader does the three things a beam actually needs: it thins at
// grazing angles so the silhouette dissolves, it brightens toward the lens because the same light is
// crossing a smaller section there, and it fades out at the far end rather than being capped. It is
// extinguished by hand and *subtracts*, because a raw ShaderMaterial is invisible to the scene fog
// and an additive beam crossing a dust column loses light to it rather than taking on its colour.

// One unit shaft: lens at local y = 0, far end at y = 1, radius 1 there and a twentieth of that at
// the lens, so the caller scales it in metres. Open-ended — a capped cone would show its own lid.
const UNIT_BEAM = new THREE.CylinderGeometry(1, 0.05, 1, 22, 14, true);
UNIT_BEAM.translate(0, 0.5, 0);

const VS = `
uniform float uTime;
uniform float uWander;
varying float vS;
varying float vA;
varying vec3 vN;
varying vec3 vP;
varying vec3 vW;
void main(){
  float a = atan(position.x, position.z);
  vA = a;
  vS = position.y;
  vec3 p = position;
  // The air a lamp shaft crosses is not still, but a beam is not a jet either: there is nothing to
  // shed vortices at the lens, so the shear only appears well down the column — hence s squared, and
  // a rate an order of magnitude slower than the exhaust's.
  float w = uWander * vS * vS;
  p.x += w * sin(vS * 4.4 + uTime * 0.62 + a * 2.0);
  p.z += w * cos(vS * 3.7 - uTime * 0.48 + a * 1.7);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vP = mv.xyz;
  vN = normalMatrix * normal;
  vW = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * mv;
}`;

const FS = `
uniform float uTime;
uniform float uLevel;
uniform float uFogDen;
uniform vec3 uCam;
uniform vec3 uColor;
varying float vS;
varying float vA;
varying vec3 vN;
varying vec3 vP;
varying vec3 vW;

float h31(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vn3(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(h31(i + vec3(0.0, 1.0, 0.0)), h31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(h31(i + vec3(0.0, 0.0, 1.0)), h31(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(h31(i + vec3(0.0, 1.0, 1.0)), h31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}

void main(){
  float s = vS;

  // A grazing section scatters the least light per pixel, and that is the whole reason this shell has
  // no visible outline. Without it an additive cone is a paper cut-out of a beam. 2.6 rather than the
  // 0.8 a flat volume would want: at 0.8 the section across the column is a broad plateau, so the
  // shaft keeps enough of its own silhouette to read as frosted glass over the vehicle it crosses.
  // Both sides measured twice on the same paused frame, only the exponent varying, with the stack
  // viewed from the plaza 99 m off the pad axis: 0.8 touches 4.38 % of the frame at a mean +20.9/255
  // and 0.91/255 of whole-frame light, 2.6 touches 4.13 % at +16.5 and 0.68. A quarter of the layer's
  // light is the price, and what it buys back is the booster's own panel lines through the beam.
  vec3 N = normalize(vN), V = normalize(-vP);
  float edge = pow(abs(dot(N, V)), 2.6);

  // Divergence does the falling off: the same flux through a widening section, plus the aerosol
  // settling out of the lowest part of the beam.
  float dens = exp(-s * 1.15);

  // Sampled on (cos a, sin a) rather than on the angle itself, so the shimmer closes on the far side
  // of the column instead of leaving a seam down one face.
  float turb = 0.82 + 0.32 * vn3(vec3(cos(vA) * 1.7, sin(vA) * 1.7, s * 3.4 - uTime * 0.32));

  float a = edge * dens * turb * uLevel;
  // Nothing caps the far end. The column runs out of light and dissolves instead of ending in a ring.
  a *= 1.0 - smoothstep(0.58, 0.98, s);
  if (a < 0.0015) discard;

  float ext = 1.0 - exp(-pow(length(vW - uCam) * uFogDen, 2.0));
  a *= 1.0 - ext;
  gl_FragColor = vec4(uColor, a);
}`;

// Six of the ring's twenty-four lenses, evenly spaced. Every lamp throwing a shaft would be a solid
// drum of light across the whole pad; a vehicle is floodlit from a few towers, not from its own
// perimeter studs.
const LAMPS = 6;
// [reach m, inboard lean m over that reach] per lamp. A pad aims its floods at different bands of the
// stack — booster base, interstage, ship body, tower top — and this is the reason the table exists
// rather than one shared aim: with every lens set on the same point the six shafts cross at a single
// knot on the axis, which is both the most obviously geometric thing in the frame and, being additive,
// the brightest. The +124/255 was measured on the crossing pixels of the shared aim this replaced.
// What the table leaves behind is checkable off `probe()` without an A/B: its six tips land at 30.4,
// 37.8, 44.0, 34.2, 40.4 and 48.7 m, at axis distances of 5.0, 0.7, 3.0, 3.1, 1.2 and 7.0 m, so there
// is no longer one point every shaft passes through. Of the two framings measured here the layer's
// brightest pixel is +90/255 over the same frame with the shafts hidden (standing 22 m from the axis),
// and neither frame clips.
//
// The lens ring is 9.5 m about the axis, so a lean of 9.5 puts a tip on the axis and the vehicle
// (4.5 m radius) swallows the shaft before then; `reach` 48 with a lean of 2.5 is the one lamp kept
// nearly vertical so the group does not read as a single funnel.
const AIM = [
  [30, 4.5], [38, 9.0], [45, 13.0], [34, 6.5], [41, 11.0], [48, 2.5],
];
const FLARE_PER_METRE = 0.133; // 7.6° half-angle — a flood's cone, held constant so every shaft diverges at the same rate
const WANDER = 0.05; // unit radii of shear at the far end, i.e. ~0.3 m of visible drift

export function createPadBeams(scene, rig) {
  const [px, , pz] = rig.pad;
  const UP = new THREE.Vector3(0, 1, 0);
  // The QA knob, and it has to live here rather than on the meshes: `update` rewrites visibility from
  // `level` every frame, so a caller that only set `mesh.visible` would have it undone by the very step
  // it meant to photograph — which is exactly how the first A/B of this layer's contribution came back
  // as pure grain noise, the "with" and "without" frames being the same render.
  let lit = true;
  const beams = [];
  const n = Math.min(LAMPS, rig.floods.length);
  for (let i = 0; i < n; i++) {
    // One lens in every four, so the shafts stand where a lamp actually is rather than between them.
    const [fx, fy, fz] = rig.floods[Math.floor(i * rig.floods.length / n)];
    const [reach, lean] = AIM[i % AIM.length];
    const foot = new THREE.Vector3(fx, fy, fz);
    const dir = new THREE.Vector3(px - fx, 0, pz - fz).normalize().multiplyScalar(lean / reach);
    dir.y = 1;
    dir.normalize();
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uWander: { value: WANDER },
        uLevel: { value: 0 },
        uFogDen: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uColor: { value: new THREE.Color(0xa8c8ff) },
      },
    });
    const mesh = new THREE.Mesh(UNIT_BEAM, mat);
    mesh.frustumCulled = false;
    // Under the exhaust shells' 6, so a plume crossing a beam is the thing drawn on top.
    mesh.renderOrder = 5;
    mesh.position.copy(foot);
    mesh.quaternion.setFromUnitVectors(UP, dir);
    const flare = reach * FLARE_PER_METRE;
    mesh.scale.set(flare, reach, flare);
    scene.add(mesh);
    beams.push({ mesh, mat, foot, dir, len: reach, flare,
      axisR: Math.hypot(fx - px, fz - pz) });
  }

  return {
    // `level` and `color` are the weather's business, not this module's: whether a shaft is lit at all
    // is a question about how much is airborne, and the answer lives in the environment driver.
    // Whether they exist in the render at all is the QA's business, and that is `setLit` — the only
    // visibility input that survives the frame loop, because `update` derives `visible` from it below
    // instead of being overwritten by it.
    update(time, camera, fog, level, color) {
      for (const b of beams) {
        b.mesh.visible = lit && level > 0.0015;
        if (!b.mesh.visible) continue;
        const u = b.mat.uniforms;
        u.uTime.value = time;
        u.uLevel.value = level;
        u.uCam.value.copy(camera.position);
        u.uFogDen.value = fog ? fog.density : 0;
        u.uColor.value.copy(color);
      }
    },
    setLit(v) {
      lit = !!v;
      return lit;
    },
    // Where each shaft is bolted, and how far that is from the pad axis. The claim being checkable is
    // the one the old cones could not answer: every foot here is a lamp's own position, so `axisR` has
    // to read the ring radius for all six, and a beam that leaned off the deck would show up as a foot
    // at some other distance.
    probe(camera) {
      return beams.map((b) => ({
        visible: b.mesh.visible,
        // `update` bails before writing uniforms on a shell it has hidden, so everything below this
        // line is whatever the last visible frame left behind. Reading `level: 0.165` off a dark
        // pad and concluding the lamps are lit is exactly the mistake this flag exists to prevent.
        stale: !b.mesh.visible,
        foot: b.foot.toArray().map(v => +v.toFixed(2)),
        axisR: +b.axisR.toFixed(2),
        tip: b.foot.clone().addScaledVector(b.dir, b.len).toArray().map(v => +v.toFixed(1)),
        len: b.len, flare: b.flare,
        level: +b.mat.uniforms.uLevel.value.toFixed(4),
        ext: camera ? +(1 - Math.exp(-Math.pow(b.foot.distanceTo(camera.position)
          * b.mat.uniforms.uFogDen.value, 2))).toFixed(3) : null,
        frame: 'world',
      }));
    },
  };
}
