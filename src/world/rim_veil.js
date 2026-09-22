import * as THREE from 'three';
import { RIM } from '../config.js';

// ═════════════════════════════════════════════════════════════════════════════
// The playfield's edge, drawn as weather.
//
// The boundary used to be a wall of a hundred basalt clasts, and it worked: nothing could drive
// through it, and the rocks were the crater's own talus, so it never looked like level design. What
// it did do is turn the whole horizon into a repeating boulder fence, which is the first thing a
// visitor sees from the plaza and the last thing they see when they back into it. The collision is
// now an invisible ring of discs (`rim:border` in props.js) at the same radius, so the drive limit is
// exactly where it always was.
//
// The ring still has to be *seen*, or it is a rubber wall and the player is right to hate it. What
// sells it is the thing a crater rim actually does on Mars: saltation. Sand skipping along a surface
// piles up into a moving haze a metre or two thick at the ground, and the rim is where the wind
// coming off the plain has nowhere left to go.
//
// The first build of this failed, and the frames say how: a 19 m sheet whose density varied along the
// ring and almost not at all with height drew as a flat-topped hoarding — vertical brush streaks, a
// hard straight crest, opaque enough to erase the crater wall behind it. It read as level design
// wearing a texture, which is the exact thing the boulders were removed for. Four rules came out of
// looking at it, and they are what this shader is built on:
//
//   * Height must be a *noise axis*, not a multiplier. If the third coordinate of the field carries
//     no frequency, every column holds one value from deck to crest, and the sheet is stripes.
//   * The silhouette belongs to the alpha, not to the mesh. A vertex-displaced crest stair-steps at
//     2.75 m per column; a per-fragment crest that fades over metres of its own height is smooth at
//     every distance, and lets the geometry's top edge sit in air that discards.
//   * A veil you cannot see through is a wall. The mass sits at the ground; the loft stays thin
//     enough that the dunes and the crater rim read through it.
//   * Dust scatters forward. It glows toward the sun and nearly silhouettes with its back turned, and
//     a sheet lit the other way round is uniformly bright — uniform brightness is what made the first
//     build look painted rather than lit.
//
// Two properties still do most of the orientation work:
//   * it is drawn at `RIM.face`, which is the radius where a rover's *skin* contacts the barrier —
//     not the disc centre, which sits 3.6 m further out. Drive up to it and the nose meets the dust.
//   * the density is grazing-angle weighted. A scattering sheet passes more light the more directly
//     you look through it, so facing the wall it is a faint shimmer, and where the ring curves away
//     at either side of your view it thickens. Run straight at it and the bright arcs close in around
//     the frame before the crest resolves — which is what it feels like to be stopped by it.
// ═════════════════════════════════════════════════════════════════════════════

const COLS = 256;              // 2.75 m of ring per column
const ROWS = 13;               // one buried skirt row + twelve lofted
const DECK = 0.10;             // uv.y of the ground line: everything under it hides the seam
// Metres of veil sunk below its own ground line. The columns are 2.75 m apart and the mesh they sit on
// is a 1.36 m lattice, so between two samples the foot is a chord across a slope; at the 27° the
// terrain's own readability cap allows that is 0.74 m of step, and this is what hides it.
const SINK = 1.9;

function veilGeometry(groundAt, radius, tall) {
  const cols = COLS + 1, rows = ROWS;
  const pos = new Float32Array(cols * rows * 3);
  const uvs = new Float32Array(cols * rows * 2);
  for (let k = 0; k < cols; k++) {
    const th = (k / COLS) * Math.PI * 2;
    const x = Math.cos(th) * radius, z = Math.sin(th) * radius;
    const g = groundAt(x, z);
    for (let j = 0; j < rows; j++) {
      const i = (k * rows + j) * 3;
      const t = j === 0 ? 0 : (j - 1) / (rows - 2);
      pos[i] = x; pos[i + 1] = j === 0 ? g - SINK : g + tall * t; pos[i + 2] = z;
      const q = (k * rows + j) * 2;
      uvs[q] = k / COLS;
      uvs[q + 1] = j === 0 ? 0 : DECK + (1 - DECK) * t;
    }
  }
  const idx = new Uint16Array(COLS * (rows - 1) * 6);
  let o = 0;
  for (let k = 0; k < COLS; k++) {
    for (let j = 0; j < rows - 1; j++) {
      const a = k * rows + j, b = a + rows, c = b + 1, d = a + 1;
      idx[o++] = a; idx[o++] = b; idx[o++] = c;
      idx[o++] = a; idx[o++] = c; idx[o++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

export function createRimVeil(scene, { groundAt, radius = RIM.face, tall = RIM.tall } = {}) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 }, uAmt: { value: 0.3 }, uDeck: { value: DECK },
      uShear: { value: 0 }, uNight: { value: 0 },
      uWind: { value: new THREE.Vector2(1, 0) },
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uCam: { value: new THREE.Vector3() },
      uTint: { value: new THREE.Color(0.36, 0.24, 0.17) },
      uGlow: { value: new THREE.Color(0.92, 0.68, 0.44) },
      uDusk: { value: new THREE.Color(0.10, 0.11, 0.16) },
      uFogCol: { value: new THREE.Color(0.4, 0.25, 0.15) },
      uFogDen: { value: 0.0014 },
    },
    vertexShader: `
uniform float uTime;
uniform float uDeck;
uniform float uShear;
uniform vec2 uWind;
varying float vHy; varying float vAng; varying float vWind;
varying vec3 vWorld; varying vec3 vNrm;
void main(){
  vHy = (uv.y - uDeck) / (1.0 - uDeck);
  vAng = uv.x * 6.28318530718;
  vec3 p = position;
  vec2 rd = normalize(vec2(p.x, p.z));
  vNrm = vec3(rd, 0.0);
  // +1 on the arc the wind is travelling toward, −1 on the arc it comes off of. Normalised, because
  // the position itself is 112 m out: feeding that raw into a 0..1 term throws the crest hundreds of
  // metres into the sky the first time a front lifts the shear.
  vWind = dot(rd, uWind);
  // The loft leans. The foot stays exactly on RIM.face — that circle is the drive limit, and this
  // sheet is its picture — but the crest drifts downwind and wanders across the ring, so the boundary
  // is never the dead-straight cylinder the eye can name in one glance. Integer harmonics of vAng, so
  // it still closes on itself where uv.x wraps.
  float up = max(vHy, 0.0);
  p.xz += rd * (1.7 * sin(vAng * 11.0 + uTime * 0.07) + 1.1 * sin(vAng * 27.0 - uTime * 0.12)) * up;
  p.xz += uWind * (2.4 * uShear * up);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
    fragmentShader: `
uniform float uTime, uAmt, uShear, uNight, uFogDen;
uniform vec3 uSun, uTint, uGlow, uDusk, uCam, uFogCol;
varying float vHy; varying float vAng; varying float vWind;
varying vec3 vWorld; varying vec3 vNrm;
float h31(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vn3(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(h31(i + vec3(0.0, 1.0, 0.0)), h31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(h31(i + vec3(0.0, 0.0, 1.0)), h31(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(h31(i + vec3(0.0, 1.0, 1.0)), h31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
float fb(vec3 p){ return vn3(p) * 0.56 + vn3(p * 2.31) * 0.28 + vn3(p * 5.4) * 0.16; }
void main(){
  float hy = max(vHy, 0.0);
  // The ring's angle is carried around a CIRCLE in noise space rather than along an axis, so the sheet
  // has no seam where uv wraps. The downwind half rides the advection faster than the arc the wind
  // comes off of, which is what makes the drift read as directional instead of as wallpaper.
  float ph = vAng + uTime * (0.042 + 0.085 * (vWind * 0.5 + 0.5)) * (0.45 + uShear);
  // x/y are the ring, z is height — and height has to carry its own frequency or the whole sheet
  // collapses into vertical stripes. ~20 noise units walked per turn puts the billows 25–45 m apart
  // along 735 m of boundary; 3.4 units over the loft breaks the same field every couple of metres.
  float rr = 2.55 + hy * 0.85;
  vec3 q = vec3(cos(ph), sin(ph), 0.0) * rr;
  q.z = hy * 3.4 - uTime * 0.13;
  float n = fb(q);
  // A second, finer field drifting faster: parallax between the two is most of what stands in for
  // volume once the veil is one cylinder thick.
  float n2 = fb(q * 2.15 + vec3(0.0, 0.0, uTime * 0.21 + 11.0));
  float body = clamp(n * 0.64 + n2 * 0.36, 0.0, 1.0);
  // The same field a little further along: the difference is the slope across each billow, and a slope
  // is the only thing that can light one. Without it the veil is painted marbling, not tumbling sand.
  float slope = clamp((n - fb(q + vec3(0.0, 0.0, 0.075))) * 9.0, -1.0, 1.0);
  // Silhouette, per fragment. It tops out around 0.75 of the loft, so the mesh's own top edge is never
  // seen and the crest can be as ragged as the field wants at any distance.
  float lobe = fb(vec3(cos(ph), sin(ph), 1.9) * rr * 1.3);
  float edge = 0.21 + 0.30 * lobe + 0.14 * n + 0.11 * uShear;
  float prof = (1.0 - smoothstep(edge * 0.28, edge, hy)) * exp(-hy * 1.25);
  // Cat's paws: fingers of skipping sand peeled off the deck and running ahead of the sheet. Same
  // field at another height, so they stay periodic where the ring closes.
  float paw = exp(-pow((hy - 0.09) * 4.6, 2.0)) * smoothstep(0.50, 0.94, fb(vec3(cos(ph), sin(ph), 4.1) * rr * 2.0));
  vec3 vd = normalize(vWorld - uCam);
  // Grazing light paths are longer through the sheet, so the haze is densest where the ring turns
  // away from you and thinnest dead ahead. Clamped, because the facing section still has to be seen.
  float fres = 1.0 - abs(dot(normalize(vNrm), vd));
  float a = prof * (0.05 + 0.60 * body) * (1.0 + 0.85 * pow(fres, 1.6)) + paw * 0.13;
  a *= uAmt * (1.0 - uNight * 0.55);
  // The scene's own fog, applied by hand: a raw ShaderMaterial is invisible to it, and a veil that
  // keeps its contrast at 110 m while the dunes in front of it are already gone reads as a decal.
  float ext = 1.0 - exp(-pow(length(vWorld - uCam) * uFogDen, 2.0));
  a *= 1.0 - ext * 0.35;
  if (a < 0.004) discard;
  // Forward scatter. vd runs from the eye into the sheet, so cosθ near 1 means looking *toward* the
  // sun — and that is the one direction from which a dust sheet glows instead of blocking.
  float cosT = clamp(dot(vd, normalize(uSun)), -1.0, 1.0);
  float fwd = pow(max(cosT, 0.0), 2.1);
  float shoulder = pow(clamp(slope, 0.0, 1.0), 1.6) * (0.35 + 0.65 * fwd);
  float depth = 0.45 + 0.55 * smoothstep(0.02, 0.45, hy);
  float lit = clamp(0.09 + fwd * (0.26 + 0.50 * body) + shoulder * 0.45, 0.0, 1.0) * depth;
  vec3 tint = mix(uTint, uDusk, uNight);
  vec3 glow = mix(uGlow, uDusk, uNight * 0.8);
  gl_FragColor = vec4(mix(mix(tint, glow, lit), uFogCol, ext * 0.75), a);
}`,
  });
  // `groundAt` is the *mesh* height (surfaceAt), not the analytic field the terrain was authored
  // from — the veil is a sheet standing on the ground a player drives on, and the two disagree by the
  // lattice's own error.
  const mesh = new THREE.Mesh(veilGeometry(groundAt, radius, tall), mat);
  mesh.name = 'rim-veil';
  mesh.frustumCulled = false;
  // Before the storm wall (renderOrder 4): when a front crosses the rim, the front is the nearer
  // mass of dust and the boundary haze belongs behind it.
  mesh.renderOrder = 3;
  scene.add(mesh);

  return {
    mesh,
    advance(dt, o) {
      const u = mat.uniforms;
      u.uTime.value += dt;
      u.uWind.value.set(o.windX, o.windZ);
      u.uShear.value = o.shear;
      u.uNight.value = o.night;
      // Calm it is a legible band of drifting dust; a front buries the boundary in its own weather,
      // which is honest — you cannot see the rim through a haboob, and you should not be able to.
      u.uAmt.value = 0.30 + 0.12 * o.shear + 0.55 * o.storm;
      u.uSun.value.set(o.sunDir.x, o.sunDir.y, o.sunDir.z);
      u.uCam.value.copy(o.camPos);
      if (o.tint) u.uTint.value.copy(o.tint);
      if (o.glow) u.uGlow.value.copy(o.glow);
      if (o.fog) {
        u.uFogCol.value.copy(o.fog.color);
        u.uFogDen.value = o.fog.density;
      }
    },
  };
}
