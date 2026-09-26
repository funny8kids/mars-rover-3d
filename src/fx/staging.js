import * as THREE from 'three';

// The separation event, drawn as the object it actually is: a collar of gas thrown radially off the
// interstage, riding the vehicle that made it.
//
// What stood here before was one `TorusGeometry` parked in the world at the height the bolts went, and
// the instrumented flight measured four separate failures in it. The ring stayed put while the stack
// climbed, so its gap to the vehicle grew from 87 m to 270 m across its own 2.2 s of life; it left the
// bottom of the frame at MET 23.0 while still at 40 % of its own opacity, so the event was off-screen
// for most of the time it was happening. It grew by uniform scale, which fattens the tube along with
// the radius — 0.35 m to 9.87 m — and it ended as a solid hoop instead of a dispersing sheet. It lay in
// the *world's* horizontal plane while the vehicle leaned 0.15 rad, so it never lined up with the seam
// it came out of. And it had no structure at all: one flat additive colour, no profile across the
// band, nothing breaking it up.
//
// So this is built under the same three rules `plume.js` and `beams.js` were written under: the mesh is
// posed off the body that carries it, every frame; the shader does the falloffs a real volume needs
// (grazing at the silhouette, a peaked profile across the band, noise that tears the sheet into
// filaments); and extinction is applied by hand and *subtracts*, because a raw ShaderMaterial is
// invisible to the scene fog and an additive cloud crossing a dust column loses light to it rather
// than taking on its colour.

const TAU = Math.PI * 2;

// A (ring × band) parameter grid, and nothing more: every vertex is rebuilt analytically from `uv` in
// the vertex shader, in metres, so the collar's radius and its tube thickness can be driven
// independently. That decoupling is the point of the file — scaling a torus instead is exactly how the
// ring it replaces ended up 9.87 m thick. The radii below are therefore not the shape of anything;
// only the segment counts matter (160 around the vehicle, 14 around the band).
// RETAINED RUNTIME PRIMITIVE — a parameter grid, not a shape: only its segment counts are used (160
// around the vehicle, 14 around the band), because every vertex is re-derived from `uv` in the vertex
// shader in metres. That is the whole point of the file — the collar's radius and its tube thickness
// have to move independently, and scaling a torus is exactly how the ring this replaced fattened its
// tube from 0.35 m to 9.87 m while it grew.
const GRID = new THREE.TorusGeometry(1, 0.17, 14, 160);

const NOISE = `
float h31(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vn3(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(h31(i + vec3(0.0, 1.0, 0.0)), h31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(h31(i + vec3(0.0, 0.0, 1.0)), h31(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(h31(i + vec3(0.0, 1.0, 1.0)), h31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}`;

const VS = `
uniform float uTime;
uniform float uRing;
uniform float uTube;
uniform float uFlat;
uniform float uLobe;
uniform float uBolts;
varying float vLead;
varying float vTh;
varying float vPh;
varying vec3 vN;
varying vec3 vP;
varying vec3 vW;
${NOISE}
void main(){
  float th = uv.x * 6.28318530718;
  float ph = uv.y * 6.28318530718;
  vec3 rad = vec3(cos(th), 0.0, sin(th));
  vec3 up = vec3(0.0, 1.0, 0.0);
  vTh = th; vPh = ph;

  // Pyrotechnic bolts are spaced, not continuous: the front they throw is lumpier than a circle, and
  // eight lobes is the spacing a real interstage uses. Measured honestly, this one is small — uLobe
  // is a fraction of the ring radius, so the gas layer's 0.075 is 0.4 m at its birth radius and 0.8 m
  // at its end radius, which at the terminal framing (1 px ≈ 0.6 m) is barely a pixel and a half. The
  // compass-drawn look is actually broken by the tube breathing and the filaments below; this is the
  // third octave, not the fix. A hairline flash at 5 m cannot carry a lobe at all, hence its zero.
  float R = uRing * (1.0 + uLobe * (0.5 + 0.5 * sin(th * uBolts + uTime * 0.9)));

  // The band breathes. Sampled on (cos th, sin th) rather than on th, so the tear closes on the far
  // side of the collar instead of leaving a seam at th = 0.
  float tube = uTube * (0.62 + 0.78 * vn3(vec3(rad.xz * 5.5, ph * 1.6 + uTime * 2.2)));

  vec3 P = rad * R + (rad * cos(ph) + up * (sin(ph) * uFlat)) * tube;
  // An ellipse's normal is its position divided by the square of its own semi-axis, so the squashed
  // axis is the one whose term blows up. Getting this backwards is invisible face-on and obvious at
  // the grazing angles the whole file exists to handle.
  vec3 N = normalize(rad * cos(ph) + up * (sin(ph) / max(uFlat, 0.06)));

  vec4 mv = modelViewMatrix * vec4(P, 1.0);
  vP = mv.xyz;
  vN = normalMatrix * N;
  vW = (modelMatrix * vec4(P, 1.0)).xyz;
  vLead = cos(ph);
  gl_Position = projectionMatrix * mv;
}`;

const FS = `
uniform float uTime;
uniform float uLevel;
uniform float uCool;
uniform float uPeaked;
uniform float uEdge;
uniform float uAshF;
uniform float uFil;
uniform float uFogDen;
uniform vec3 uCam;
uniform vec3 uHot;
uniform vec3 uWarm;
uniform vec3 uAsh;
varying float vLead;
varying float vTh;
varying float vPh;
varying vec3 vN;
varying vec3 vP;
varying vec3 vW;
${NOISE}
void main(){
  // A grazing section carries the least gas per pixel, and that is the only reason this shell has no
  // visible outline. A constant-alpha additive band draws a hoop with an edge — the defect this replaces.
  vec3 N = normalize(vN), V = normalize(-vP);
  float edge = pow(abs(dot(N, V)), uEdge);

  // Almost all of the emission is on the lip the bolts just threw; the wrap round the back of the band
  // is a faint collar. uPeaked sets how much of the tube counts as lip.
  float lead = pow(max(0.0, 0.5 + 0.5 * vLead), uPeaked);

  // The sheet is not smooth, and it is not uniformly torn either. Two octaves, because one octave of
  // value noise at this frequency reads as a checkered pattern rather than as filaments, and the
  // faster-drifting octave is what makes the collar read as something moving rather than a decal on
  // the air. The mean of this product is ~0.52, so a layer's own opacity is set knowing it.
  float f1 = vn3(vec3(cos(vTh) * 3.4, sin(vTh) * 3.4, vPh * 2.3 - uTime * 1.9));
  float f2 = vn3(vec3(cos(vTh) * 8.1, sin(vTh) * 8.1, vPh * 5.0 - uTime * 3.1));
  float fil = 0.06 + 1.06 * f1 * (0.45 + 0.85 * f2);

  float a = uLevel * edge * (0.07 + 0.93 * lead) * mix(1.0, fil, uFil);
  if (a < 0.002) discard;

  vec3 col = mix(uWarm, uHot, pow(max(0.0, 0.5 + 0.5 * vLead), 2.0));
  // Expanding gas cools, and on Mars it picks up the dust column it is pushing through. Both are the
  // same fade as far as the eye is concerned, so one ramp carries them.
  col = mix(col, uAsh, uCool * uAshF);

  float ext = 1.0 - exp(-pow(length(vW - uCam) * uFogDen, 2.0));
  a *= 1.0 - ext;
  gl_FragColor = vec4(col, a);
}`;

// The three things one separation actually shows, in the order the eye meets them. `r` and `tube` are
// in *vehicle radii* (`rig.r` is 5.1 m), so the collar stays the size of the thing that made it if the
// asset is ever re-lofted.
//   · flash — the bolts themselves: a hairline round the split line, gone before the eye can find its
//     outline, so the first frame of the event is not a plain ring.
//   · front — the overpressure sheet. It outruns the gas it carries and it is thin, hence the squash
//     across the vehicle axis.
//   · gas   — the column the front is sitting in: slower, rounder, and the layer that survives an
//     edge-on view because it is the only one with any height.
//
// `fil` is how much of the layer's alpha the filament noise is allowed to eat. The flash is a solid
// arc and wants almost none of it; the gas is a torn sheet and is made of nothing else.
//
// The first version of this table had the emphasis backwards, and only the captured frames said so:
// the fast outer front carried `opacity` 0.95 in white while the cloud actually sitting on the seam
// glowed at 0.46, so at 0.6-1.4 s into the event the picture was a bright hairline circle hanging in
// clear air two vehicle-lengths off the booster — a halo, which is the compass-drawn look this file
// exists to remove. Footage has it the other way round: the bright, bulky stuff stays at the split and
// the outrunning front is a faint, fast bubble. So the front is now the faint layer, the gas is the
// bright one, and the gas's tube ends at 4.3 m thick rather than 2.1 m so it covers screen area
// instead of drawing a line. The `edge` exponents went up with the front's whiteness coming down,
// because a thin additive shell at uEdge ≈ 1 is exactly what prints an outline.
const LAYERS = [
  { name: 'flash', life: 0.45, r: [1.015, 1.34], tube: [0.26, 0.09], flat: 0.42, opacity: 0.92,
    peaked: 1.1, edge: 1.5, lobe: 0.0, fil: 0.25, hot: 0xfffdf7, warm: 0xffe0ac, ash: 0xff9c50,
    ashF: 0.20 },
  { name: 'front', life: 1.70, r: [1.05, 3.45], tube: [0.09, 0.34], flat: 0.26, opacity: 0.38,
    peaked: 2.2, edge: 1.9, lobe: 0.045, fil: 0.85, hot: 0xfffaf0, warm: 0xffd9a0, ash: 0x9a6a44,
    ashF: 0.72 },
  { name: 'gas', life: 1.70, r: [1.02, 2.15], tube: [0.07, 0.85], flat: 0.72, opacity: 0.80,
    peaked: 1.5, edge: 0.85, lobe: 0.075, fil: 1.0, hot: 0xffe6bd, warm: 0xff9a44, ash: 0x7a5140,
    ashF: 0.75 },
];

// A free front does not expand at a constant rate — it is running into the air it has not yet pushed
// out of the way. This is the decay constant of that slowdown, in units of the layer's own life,
// normalised so the layer still lands exactly on its stated end radius.
const EXPANSION_TAU = 0.30;
const EASE = (1 - Math.exp(-1 / EXPANSION_TAU));
// How long the collar takes to come up to full brightness. Shorter than one frame at 30 fps on
// purpose: a separation is an event, not a fade-in.
const ATTACK = 0.045;
// As the booster slows and the ship speeds away, the gas — which is neither — coasts forward relative
// to the stage it came off. Riding it up the booster's own axis by this much (in vehicle radii, over
// the layer's life) keeps the collar in the gap that is opening instead of pinned to a rim that has
// left it behind. The gap itself reaches ~11 m by MET 23.4 at the flight's actual 5 m/s² of relative
// acceleration, so this is the smaller half of that, not a claim about where the middle is.
const RIDE = 0.85;

const UP = new THREE.Vector3(0, 1, 0);

export function createStageCollars(scene) {
  // Two events' worth of slots. There is never a second staging in flight while this one is still
  // glowing in practice — a relaunch costs a whole task chain — but the slot table means the answer to
  // "what if" is 40 lines rather than a per-event allocation.
  const slots = [];
  for (const L of LAYERS) {
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VS,
        fragmentShader: FS,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 },
          uRing: { value: 1 },
          uTube: { value: 1 },
          uFlat: { value: L.flat },
          uLobe: { value: L.lobe },
          uBolts: { value: 8 },
          uLevel: { value: 0 },
          uCool: { value: 0 },
          uPeaked: { value: L.peaked },
          uEdge: { value: L.edge },
          uAshF: { value: L.ashF },
          uFil: { value: L.fil },
          uFogDen: { value: 0 },
          uCam: { value: new THREE.Vector3() },
          uHot: { value: new THREE.Color(L.hot) },
          uWarm: { value: new THREE.Color(L.warm) },
          uAsh: { value: new THREE.Color(L.ash) },
        },
      });
      const mesh = new THREE.Mesh(GRID, mat);
      // The collar is a unit grid whose shape is built in the vertex shader, so the geometry's own
      // bounding sphere is a lie about where the light actually is.
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      mesh.visible = false;
      scene.add(mesh);
      slots.push({ L, mat, mesh, u: mat.uniforms, age: -1, seq: -1, R: 0, tube: 0, level: 0 });
    }
  }

  // One sequence number per separation, so a launch that starts while the last one's collar is still
  // alive retires the old slots instead of having them follow the new vehicle.
  let seq = 0;
  const _axis = new THREE.Vector3();
  const _c = new THREE.Vector3();
  const _ndc = new THREE.Vector3();
  const _lean = new THREE.Vector3();

  const kill = (s) => { s.age = -1; s.mesh.visible = false; };

  return {
    // Called from the `staging` beat, i.e. from inside the frame that already ran the split, so the
    // bodies are already two vehicles and `booster` already carries its own pivot.
    spawn(F, rig) {
      seq++;
      for (const s of slots) if (s.seq !== seq) kill(s);
      const live = [];
      for (const L of LAYERS) {
        const s = slots.find((x) => x.L === L && x.age < 0);
        if (!s) continue;
        s.age = 0; s.seq = seq; s.mesh.visible = true;
        live.push(L.name);
      }
      return { seq, live };
    },
    // `F` is the live flight; the collar has no state of its own beyond its age, because everything
    // about where it is comes off the body that threw it.
    update(dt, time, camera, fog, F, rig) {
      const booster = F && F.plumes[0].body;
      for (const s of slots) {
        if (s.age < 0) continue;
        if (!booster) { kill(s); continue; }
        s.age += dt;
        const L = s.L;
        if (s.age > L.life) { kill(s); continue; }
        const t = s.age / L.life;
        const ease = (1 - Math.exp(-t / EXPANSION_TAU)) / EASE;
        const R = rig.r * (L.r[0] + (L.r[1] - L.r[0]) * ease);
        const tube = rig.r * (L.tube[0] + (L.tube[1] - L.tube[0]) * ease);
        // The collar's own frame: local +Y is the vehicle's axis, so the band sits normal to it at any
        // lean, and `at()` keeps it in stack metres like everything else the flight exports.
        booster.axis(_axis);
        s.mesh.position.copy(booster.at(_c, rig.seam + rig.r * RIDE * t * t));
        s.mesh.quaternion.setFromUnitVectors(UP, _axis);
        const u = s.u;
        u.uTime.value = time;
        u.uRing.value = R;
        u.uTube.value = Math.max(0.02, tube);
        u.uCool.value = t;
        u.uLevel.value = L.opacity * Math.min(1, s.age / ATTACK) * Math.pow(1 - t, 1.5);
        u.uCam.value.copy(camera.position);
        u.uFogDen.value = fog ? fog.density : 0;
        s.R = R; s.tube = tube; s.level = u.uLevel.value;
      }
    },
    hide() { for (const s of slots) kill(s); },
    // Where the light actually is, in metres and in screen units, because every defect this file fixes
    // was one that only a number caught: a ring can be "there" and still be 270 m under the vehicle
    // and out of the frame. `on` is the whole point of the readout — an event that is off-screen for
    // most of its own life is an event the player never sees.
    // `anchor`, when given, is the seam the collar came out of in the same world metres, so a caller
    // can read the drift directly instead of diffing two position arrays by hand.
    probe(camera, anchor) {
      return slots.filter((s) => s.age >= 0 && s.mesh.visible).map((s) => {
        _ndc.copy(s.mesh.position).project(camera);
        // Degrees the collar's own axis is off vertical — the number that says whether the band is
        // lining up with the seam it came out of or lying in the world's weather-vane flat plane.
        _lean.set(0, 1, 0).applyQuaternion(s.mesh.quaternion);
        return {
          layer: s.L.name, age: +s.age.toFixed(3),
          R: +s.R.toFixed(1), tube: +s.tube.toFixed(2), flat: s.L.flat,
          level: +s.level.toFixed(3),
          lean: +(Math.acos(THREE.MathUtils.clamp(_lean.y, -1, 1)) * 57.2958).toFixed(2),
          gap: anchor ? +s.mesh.position.distanceTo(anchor).toFixed(1) : null,
          ndc: [+_ndc.x.toFixed(3), +_ndc.y.toFixed(3)],
          on: Math.abs(_ndc.x) < 1 && Math.abs(_ndc.y) < 1 && _ndc.z < 1,
          at: s.mesh.position.toArray().map((v) => +v.toFixed(1)),
        };
      });
    },
  };
}
