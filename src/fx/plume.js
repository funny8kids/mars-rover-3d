import * as THREE from 'three';

// The visible core of a rocket exhaust, drawn as geometry rather than as particles.
//
// The particle system is still there, and still does what it is good at: the smoke sheath, the
// vapour collar, the debris the plume lifts off the deck. What it cannot do is be the flame. A jet
// is one continuous object a few tens of metres long, and a pool of sprites is a few hundred
// separate discs travelling down it at 15 m/s — so at any camera distance the plume resolved into a
// string of pearls, and the faster the vehicle flew the more obviously discrete it became. This
// shell is the missing continuous part: it is attached to the engine mouth, aimed down the vehicle's
// own exhaust axis, and it leans, throttles and stages with the body it belongs to.
//
// Three things make the difference between this and the flat additive cones it replaces:
//   · the emission falls off with the cosine of the view angle, so the silhouette dissolves instead
//     of ending in a line (a constant-alpha additive shell draws a hard edge — see the pad
//     searchlights, which still do);
//   · a standing shock cell runs down the column, which is the structure the eye actually reads as
//     "engine" at any distance;
//   · extinction is applied by hand and *subtracts*, because a raw ShaderMaterial is invisible to
//     the scene fog and an additive beam loses light to the dust column rather than taking on its
//     colour.

// One unit jet: mouth at local y = 0, tip at y = 1, radius 1 at the tip and a quarter of that at the
// throat, so the caller scales it in metres. Open-ended — a capped cone would show its own lid.
const UNIT_JET = new THREE.CylinderGeometry(1, 0.26, 1, 30, 26, true);
UNIT_JET.translate(0, 0.5, 0);

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
  // A jet is not a cone. The column sheds vortices, and the shedding only has room to grow once it
  // is well clear of the throat, hence the s squared.
  float w = uWander * vS * vS;
  p.x += w * sin(vS * 9.0 + uTime * 3.1 + a * 2.0);
  p.z += w * cos(vS * 7.7 - uTime * 2.6 + a * 1.7);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vP = mv.xyz;
  vN = normalMatrix * normal;
  vW = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * mv;
}`;

const FS = `
uniform float uTime;
uniform float uPower;
uniform float uOpacity;
uniform float uDisks;
uniform float uFogDen;
uniform vec3 uCam;
uniform vec3 uCore;
uniform vec3 uMid;
uniform vec3 uTip;
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

  // Grazing surfaces contribute the least gas per pixel, and that is the whole reason this shell has
  // no visible outline. Without it an additive cone is a paper cut-out of a rocket plume.
  vec3 N = normalize(vN), V = normalize(-vP);
  float edge = pow(abs(dot(N, V)), 0.85);

  // Overexpanded exhaust stands a lattice of shock cells in the column. They are convected
  // downstream, so the phase runs with s and against time.
  float disk = pow(0.5 + 0.5 * cos((s * uDisks - uTime * 0.38) * 6.28318530718), 5.0);
  float cell = 0.60 + 0.80 * disk * (1.0 - 0.66 * s);

  // Sampled on (cos a, sin a) rather than on the angle itself, so the flicker closes on the far
  // side of the column instead of leaving a seam down one face.
  float turb = 0.70 + 0.58 * vn3(vec3(cos(vA) * 1.9, sin(vA) * 1.9, s * 4.5 - uTime * 2.1));

  float dens = 0.30 + 0.92 * exp(-s * 1.55);
  float a = edge * cell * dens * turb * uPower * uOpacity;
  a *= 1.0 - smoothstep(0.50, 1.0, s);
  if (a < 0.002) discard;

  vec3 col = mix(uCore, uMid, smoothstep(0.0, 0.30, s));
  col = mix(col, uTip, smoothstep(0.26, 0.95, s));
  col *= 0.82 + 0.62 * disk;

  float ext = 1.0 - exp(-pow(length(vW - uCam) * uFogDen, 2.0));
  a *= 1.0 - ext;
  gl_FragColor = vec4(col, a);
}`;

// The two layers of one jet. The core is the shock-cell region: short, narrow, and the only part
// that is actually white. The barrel is the column it sits in, which is cooler, wider and much
// fainter per unit length. Drawn separately because they scale differently — the core keeps its
// diameter for several bell widths and only then lets go.
const LAYERS = [
  { name: 'core', rad: 0.40, len: 0.40, opacity: 1.00, disks: 7.5, wander: 0.05,
    core: 0xfffdf6, mid: 0xffd9a0, tip: 0xff8a34 },
  { name: 'barrel', rad: 1.00, len: 1.00, opacity: 0.34, disks: 4.2, wander: 0.13,
    core: 0xffe3b4, mid: 0xff9a44, tip: 0xb33a0c },
];

// Bell count to mouth radius: the engines sit in an annulus, so the plume that leaves them is as
// wide as the cluster, not as wide as the vehicle.
const mouthRadius = (engines) => 1.30 * Math.sqrt(Math.max(1, engines));

export function createJetPlumes(scene, rig) {
  const bodies = [
    { key: 'booster', engines: rig.engines.booster },
    { key: 'upper', engines: rig.engines.upper },
  ];
  const jets = [];

  for (const b of bodies) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = true;
    scene.add(group);
    const r = mouthRadius(b.engines);
    const layers = LAYERS.map((L) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VS,
        fragmentShader: FS,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uWander: { value: L.wander },
          uPower: { value: 0 },
          uOpacity: { value: L.opacity },
          uDisks: { value: L.disks },
          uFogDen: { value: 0.0014 },
          uCam: { value: new THREE.Vector3() },
          uCore: { value: new THREE.Color(L.core) },
          uMid: { value: new THREE.Color(L.mid) },
          uTip: { value: new THREE.Color(L.tip) },
        },
      });
      const mesh = new THREE.Mesh(UNIT_JET, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      mesh.scale.set(r * L.rad, 1, r * L.rad);
      group.add(mesh);
      return { mesh, mat, rad: L.rad, len: L.len };
    });
    jets.push({ group, layers, r });
  }

  const UP = new THREE.Vector3(0, 1, 0);

  return {
    // `plumes` is the flight's own array, in the same order as `bodies` above: the booster first.
    update(plumes, time, camera, fog) {
      for (let i = 0; i < jets.length; i++) {
        const j = jets[i], p = plumes[i];
        const power = p ? p.power : 0;
        j.group.visible = power > 0.004;
        if (!j.group.visible) continue;
        j.group.position.copy(p.pos);
        j.group.quaternion.setFromUnitVectors(UP, p.axis);
        // Throttled to the ramp the guidance is already running, so the jet starts with the engines
        // and goes out with them rather than lingering over a vehicle that has stopped pushing.
        const len = j.r * (4.0 + 4.2 * power);
        for (const l of j.layers) {
          l.mesh.scale.set(j.r * l.rad, len * l.len, j.r * l.rad);
          const u = l.mat.uniforms;
          u.uTime.value = time;
          u.uPower.value = power;
          u.uCam.value.copy(camera.position);
          u.uFogDen.value = fog ? fog.density : 0;
        }
      }
    },
    hide() { for (const j of jets) j.group.visible = false; },
    // What the shells are doing this frame, in metres. A frame that reads as a string of pearls can
    // mean the shell is too faint, too short, or not being posed at all, and only the last of those
    // is invisible to the eye — so the number has to be readable too.
    probe(camera) {
      return jets.map((j, i) => ({
        visible: j.group.visible, r: +j.r.toFixed(2),
        // `update` bails out on an invisible shell, so every number below that one is what the last
        // visible frame left behind. A dead stage's `power: 0.8` is not a readout, it is an artefact
        // of the sampling, and the only honest thing to do is say which of the two it is.
        stale: !j.group.visible,
        len: +j.layers[1].mesh.scale.y.toFixed(1),
        power: +j.layers[0].mat.uniforms.uPower.value.toFixed(3),
        ext: camera ? +(1 - Math.exp(-Math.pow(j.group.position.distanceTo(camera.position)
          * j.layers[0].mat.uniforms.uFogDen.value, 2))).toFixed(3) : null,
        at: j.group.position.toArray().map(v => +v.toFixed(1)),
      }));
    },
  };
}
