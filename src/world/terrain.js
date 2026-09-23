import * as THREE from 'three';
import { heightAt, installSurfaceGrid, surfaceAt, surfaceSlope, pavedAt, roadAt, gradedAt, paveGeometry, deckAt, lotAt } from './height.js';
import { TERRAIN, ISLAND } from '../config.js';
import { fbm, vnoise, mulberry32, smoothstep } from '../utils/noise.js';
import { loadModel, cloneModel } from './assets.js';
import { RIM_ROCK } from './rim_rock.js';
import { mergeInto } from './merge.js';

// The dune field is one 512² tile repeated SAND_TILES× over 300 m, so at 2.2 cm per texel it carries
// every grain the player drives through. A normal map alone was not enough: on a roughness-0.94
// diffuse surface under a near-overhead sun, ripple normals barely change the shading, so the ground
// still read as a painted sheet. Real sand ripples show up because the crests are dry, coarse and
// sun-bleached while the troughs hold finer, darker, wind-scoured material — an *albedo* signal.
// Both maps are derived from one height field so the light and the colour always agree.
//
// The wave trains use integer wave-vector components over the tile, which is what makes the field
// exactly periodic: a non-tiling *seam* repeated 26× across the world shows up as dead-straight
// lines, and an albedo seam is far more visible than a normal one. Note the tension this creates —
// a tile that repeats perfectly also repeats its pattern perfectly, which is a different artifact
// with the same symptom. It is broken downstream by addressing the tile from world space instead of
// from the mesh uv; see SAND_WARP.
const SAND_TILES = 26;
// One tile of the ripple field, in metres. Anything that wants to *continue* the desert's pattern —
// a storm drift, a scoured bank — has to sample at this spacing, and with its v axis running along
// −z, because the terrain plane is rotated about X and that is the direction its uv ends up in.
export const SAND_TILE_M = TERRAIN.size / SAND_TILES;

// ─── the tile is laid down in world space ───
// One 512² tile repeated 26×26 is 676 copies of the same grain, and every copy resumes at exactly the
// same phase on its seam, so the crest trains ran dead-straight and unbroken from one side of the
// island to the other. That is the corduroy in every driving frame. The `bend` field inside
// makeSandDetail was written to stop this and cannot: its coarsest lattice is 3 cells wide *within one
// tile*, so the meander repeats on the 11.54 m grid too and the tiles wander in lockstep.
//
// Proven by experiment rather than inference — zeroing the terrain material's normalScale removed the
// bands entirely, while the sampled mesh height along a 71 m cross-grain chord came back as a single
// monotone ramp with no periodicity. The ribs were 100% shader and 0% geometry.
//
// So the tile is no longer sampled at its own uv. Both maps are addressed through a world-space frame:
//
//   1. `rsbSandUv` drags the tile sideways by up to half a metre on ~26/31/53 m waves. Nothing inside
//      the tile changes — its *placement* becomes aperiodic, which is what breaks seam-to-seam
//      alignment and bends the crest lines. The summed warp gradient is 0.10, so local ridge spacing
//      shifts by under 12%: ridges wander instead of folding into moiré.
//   2. `rsbRipEnv` lets the grain thin out and return over 20-50 m patches. What the eye reads as
//      wind-laid is not curvature but *termination* — real ripples end, fork and restart, and a band
//      that never dies is a drawn line. Its mean is ~0.85, so the field keeps the grain it has: the
//      frames being replaced here were too smooth, not too busy.
//
// Both are shared with the drift material, which is the only way a storm mound stays in register with
// the desert it was blown off of while neither one is allowed to repeat.
const TILE_SCALE = (1 / SAND_TILE_M).toFixed(6);
const SAND_WARP = /* glsl */`
vec2 rsbSandUv( vec2 w ){
  vec2 o = vec2(
    sin( w.y * 0.2013 + 1.7 ) * 0.31 + sin( w.y * 0.1181 - 4.2 ) * 0.19 + sin( w.x * 0.2404 + 2.9 ) * 0.07,
    sin( w.x * 0.1860 - 0.6 ) * 0.27 + sin( w.x * 0.1042 + 3.3 ) * 0.16 + sin( w.y * 0.2233 - 1.1 ) * 0.06 );
  return ( w + o ) * ${TILE_SCALE};
}
float rsbGr( vec2 q ){ return fract( sin( dot( q, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
float rsbGn( vec2 p ){
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( rsbGr( i ), rsbGr( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( rsbGr( i + vec2( 0.0, 1.0 ) ), rsbGr( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float rsbRipEnv( vec2 w ){
  return 0.55 + 0.45 * clamp( rsbGn( w * 0.052 + 7.3 ) * 0.9 + rsbGn( w * 0.019 - 3.1 ) * 0.9, 0.0, 1.0 );
}
`;

// ─── ripples only lie on ground that can hold them ───
// Aeolian ripples are a feature of a *depositional* surface. Loose sand stops stacking at the angle
// of repose — 32..34° on Mars, where the grain is dry and cohesionless — and above it the face is an
// active slip plane or bare scarp, which is smooth or blocky but never combed. The ripple tile was
// being laid on every facet regardless, so the crater rampart read as corduroy right up to its crest.
// Proven by ablation on the same camera: forcing this gate to 1.0 (72b_nogate_87.5) sends the comb
// climbing to the top of the wall, while the live build (72a_875) stops it partway up. The 160x100
// histogram sees it too — the darkest luminance bin drops from 81 px to 7 px, which is the ripple
// troughs leaving. (The earlier frames that looked identical were `rsbSweep`, which is mean-preserving
// by construction; a stripe field is only visible in a histogram when it carries albedo.)
//
// The gate is the facet's own steepness, read from the world position's derivatives. That is the
// mesh's ~1.4 m triangle normal, i.e. the macroscopic slope, and deliberately not the ripple-laden
// shading normal — feeding the shading normal back in would make every trough flatter than its
// crest and let the comb survive by grading itself.
//
// 28..36° (cos 0.883..0.809), open below and shut above. Calibrated against per-facet normals
// measured off the drawn terrain mesh (96 800 triangles), which is the statistic this function
// consumes. Binned into 2 m radial bands, each band reporting its median facet slope and the slope of
// its steepest decile:
//   r <= 90 m   median <= 3.6°, steepest decile <= 12.9°  -> gate is exactly 1.00 on all 27 392 facets
//   r 118..128  median 19..25°, steepest decile 34.5..36.8° -> the crest-side third goes bare
//   r 134..140  median 67..72° (the outer scarp, +8.9 m down to -22 m) -> fully bare
// So the sand apron at the wall's foot keeps its grain, the flank loses it only where the flank is
// actually over the repose angle, and the far side loses it entirely.
//
// Do not set this window from the "~38.9°" figure in height.js's `rimWall` note. That is a per-bearing
// number about the wall's rising face; the same ground measured facet-by-facet, which is what a pixel
// here sits on, is 19..25° median. A gate keyed to the larger statistic would strip the comb off
// ground that is nowhere near the angle of repose.
const RIP_SLOPE = /* glsl */`
float rsbRipSlope( vec3 p ){
  return smoothstep( 0.809, 0.883, abs( normalize( cross( dFdx( p ), dFdy( p ) ) ).y ) );
}
`;

export function makeSandDetail(size = 512) {
  // All six trains run within ±6° of one another. Crossing them at wide angles — the obvious
  // thing to reach for — weaves a diamond lattice that reads as carpet, not sand; wind lays ripples
  // near-parallel, with the variety coming from spacing and from crests that wander.
  // Spacing comes from the tile, not from taste. One tile spans 300/26 = 11.54 m, so a train of
  // wave-vector magnitude k has wavelength 11.54/k metres. The first pass ran [9,6] — 1.07 m — at
  // the *largest* amplitude of any train, and that alone is why the dune field looked like corduroy:
  // 1.07 m is not a ripple, it is a dune-scale ridge, and giving it the most contrast turned every
  // slope into a handful of fat parallel furrows a rover-width apart. Aeolian ripples measured by
  // Spirit and Opportunity sit at 20–40 cm, so the energy now peaks at 42 cm and the 1.07 m train
  // survives only as a weak swell that keeps the field from looking stamped.
  const WAVES = [[9, 6, 0.22], [17, 12, 0.62], [22, 16, 1.0], [29, 20, 0.80], [37, 25, 0.50], [47, 33, 0.28]];
  const TAU = Math.PI * 2;

  // Periodic value noise: lattice hashes wrap at P, so the field tiles by construction.
  const hsh = (a, b, P) => {
    const s = Math.sin((a * 127.1 + b * 311.7) + P * 0.017) * 43758.5453;
    return s - Math.floor(s);
  };
  const pnoise = (x, y, P) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const sx = x - xi, sy = y - yi;
    const u = sx * sx * (3 - 2 * sx), v = sy * sy * (3 - 2 * sy);
    const w = (i) => (i % P + P) % P;
    const x0 = w(xi), x1 = w(xi + 1), y0 = w(yi), y1 = w(yi + 1);
    const a = hsh(x0, y0, P), b = hsh(x1, y0, P), c = hsh(x0, y1, P), d = hsh(x1, y1, P);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  };
  // `pnoise` wraps its lattice at P, and x*P/size maps the texel range onto exactly [0,P], so any
  // integer P tiles seamlessly — a snap to powers of two buys nothing and shifts every feature
  // size by up to 11%. Measured with /tmp/probe_seam.mjs: the wrap step is 0.47 against an internal
  // maximum step of 0.55, i.e. the tile edge is not where the desert's grid lines came from.
  const pn = (x, y, P) => pnoise(x * P / size, y * P / size, P);

  const h = new Float32Array(size * size);    // relief + grain: drives albedo
  const hr = new Float32Array(size * size);   // relief alone: drives the normal map
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const bend = (pn(x, y, 3) - 0.5) * 1.5 + (pn(x, y, 8) - 0.5) * 0.9;
      let v = 0;
      for (const [kx, ky, amp] of WAVES) {
        const kmag = Math.hypot(kx, ky);
        // Shifting each train's phase by its own wavenumber keeps the crest spacing locally
        // constant — real ridges meander around dune faces rather than marching in straight lines.
        // Crests meander by a roughly constant *phase*, not a constant multiple of wavenumber. At
        // kmag*0.16 the 20 cm train drifted ±4.6 rad, which folds a ridge back onto itself and reads
        // as noise instead of as a crest line wandering down a dune face.
        const s = 0.5 + 0.5 * Math.sin((kx * x + ky * y) * TAU / size + Math.min(1.7, kmag * 0.16) * bend);
        v += amp * Math.pow(s, 1.75);          // peaked crests, flat troughs — aeolian, not sinusoidal
      }
      hr[y * size + x] = v;
      const grain = pn(x, y, 460) * 0.55 + pn(x, y, 120) * 0.45;
      h[y * size + x] = v * 0.66 + (grain - 0.5) * 0.34 + 0.17;
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < h.length; i++) { if (h[i] < lo) lo = h[i]; if (h[i] > hi) hi = h[i]; }
  const inv = 1 / (hi - lo);

  const mk = (fill) => {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    fill(img.data);
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(SAND_TILES, SAND_TILES);
    t.anisotropy = 8;
    return t;
  };

  const wrap = (i) => ((i % size) + size) % size;
  const atR = (x, y) => hr[wrap(y) * size + wrap(x)];

  // The slope is calibrated against its own distribution, not hand-gained. The old builder differenced
  // the grain-included field and multiplied by a fixed 2.6, which saturated the encoding: measured on
  // the finished texture, the *median* texel normal sat 35.9° off flat with a 44.5° ceiling, so the map
  // was nearly all noise floor and had no headroom left for ripples. Under a low sun that produces the
  // exact artifact it was meant to cure — half the texels face away from the light and go to dot(N,L)=0,
  // and the anisotropic mip filter lays those dead rows down as metre-spaced black bands across every
  // grazing view. Both halves of that measurement are fixed here.
  //
  // Grain is out of the normal field entirely: its 460-cell lattice is 1.1 texels wide, well under the
  // 4-texel differencing baseline, so it cannot encode a slope at all — only noise. It stays in the
  // albedo, where the eye does read it as grit.
  //
  // What is left is pure relief, and its steepest flanks are pinned to 24° at the 99.5th percentile.
  // Real aeolian stoss faces run up to the ~30° angle of repose, so 24° keeps the crests reading as
  // sculpted sand without ever turning a texel fully away from the sun.
  const gx = new Float32Array(size * size), gy = new Float32Array(size * size);
  const mag = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // 2-px taps: the 1-px gradient of a field this fine is dominated by whichever train happens to
    // cross a texel boundary, and the ripples the eye actually reads need the wider baseline.
    const i = y * size + x;
    gx[i] = atR(x - 2, y) - atR(x + 2, y);
    gy[i] = atR(x, y - 2) - atR(x, y + 2);
    mag[i] = Math.hypot(gx[i], gy[i]);
  }
  const p995 = Float32Array.from(mag).sort()[size * size - 1 - Math.floor(size * size * 0.005)];
  const gain = Math.tan(24 * Math.PI / 180) / (p995 || 1);

  const normalMap = mk((d) => {
    for (let i = 0; i < size * size; i++) {
      const nx = gx[i] * gain, ny = gy[i] * gain;
      const len = Math.hypot(nx, ny, 1);
      const k = i * 4;
      d[k] = (nx / len * 0.5 + 0.5) * 255;
      d[k + 1] = (ny / len * 0.5 + 0.5) * 255;
      d[k + 2] = (1 / len * 0.5 + 0.5) * 255;
      d[k + 3] = 255;
    }
  });

  const map = mk((d) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const k = (h[y * size + x] - lo) * inv;
      const i = (y * size + x) * 4;
      // Crest: bleached, coarse, bright. Trough: finer rust that has been swept clean.
      // Two passes of failure behind these three numbers. The first swung ~65% crest-to-trough and
      // banding-moiréed into hard stripes; the second cut the swing to 30% but kept the same
      // *offset*, so the ramp ran 0.80→1.04 and every crest above 1.0 was clamped to pure white.
      // A clipped top is not a soft highlight, it is a plateau with a step off the end of it — which
      // is what the zebra bands on the dune faces actually were. So the swing is now 15% and the
      // ramp is centred on the same mean the shader fades toward, which puts its ceiling at 0.985
      // and means nothing in this map is clipped at all.
      d[i] = (0.855 + 0.13 * k) * 255;
      d[i + 1] = (0.8275 + 0.135 * k) * 255;
      d[i + 2] = (0.8075 + 0.145 * k) * 255;
      d[i + 3] = 255;
    }
  });
  map.colorSpace = THREE.SRGBColorSpace;
  return { map, normalMap };
}

// The tile is forged once and handed to everything made of the same sand — the dune field, and any
// drift a storm piles up. Two independent calls would upload a second 512² pair and the two would
// fall out of register the moment either builder was touched.
let sandTile;
export function sandDetail() { return sandTile || (sandTile = makeSandDetail()); }

// ─── a drift is the desert's own sand, moved ───
// Storm cover used to be a flat-shaded sphere in a hand-picked ochre, and it read as programmer art
// for two independent reasons, both fixed in the shading. The colour sat ~0.48 linear against a
// terrain palette whose brightest crest is 0.178, so a mound rendered as a glaring pancake three
// stops above the desert it was made of. And it carried none of the ripple language, so the ground's
// crest lines simply stopped dead at the mound's edge — a pile of sand with no grain is a sticker.
// Sampling the terrain's tile in WORLD space continues those lines across the junction, and it is the
// only way to do it here: main.js dresses every lens by scaling the mesh from its cover depth, so a
// UV baked into the geometry would stretch along with the drift.
export function makeDriftMaterial() {
  const { map, normalMap } = sandDetail();
  const mat = new THREE.MeshStandardMaterial({
    // A *pile* of fresh dust is not brighter than the desert it came from. The airborne film is: a
    // coat of fines catching the sun head-on reads pale, and that ochre is correct for panels and
    // for the particle pools. Volume is a different object, and it has to live in the ground's range.
    color: SAND_C.clone().multiplyScalar(1.06),
    roughness: 0.97, metalness: 0.0, map, normalMap,
  });
  mat.name = 'drift_sand';   // surface_detail.js: no panel seams and no rivets on a sandpile
  mat.normalScale.set(1, 1);
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 rsbDriftF;\n' + SAND_WARP)
      // uv_vertex runs *before* begin_vertex, so `transformed` does not exist yet here; `position`
      // already does, and a drift is never instanced.
      .replace('#include <uv_vertex>', `#include <uv_vertex>
  vec3 rsbDrift = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  rsbDriftF = rsbDrift;
  #ifdef USE_MAP
    vMapUv = rsbSandUv( vec2( rsbDrift.x, -rsbDrift.z ) );
  #endif
  #ifdef USE_NORMALMAP
    vNormalMapUv = rsbSandUv( vec2( rsbDrift.x, -rsbDrift.z ) );
  #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 rsbDriftF;\n' + SAND_WARP + RIP_SLOPE + '\nfloat gDrift = 1.0;')
      .replace('#include <map_fragment>', `vec3 rsbDriftBase = diffuseColor.rgb;
  #include <map_fragment>
  // The same Nyquist window the terrain fades its ripples with, so a drift never keeps grain after
  // the desert beside it has lost theirs to the mip chain — and the same world-space envelope, so a
  // mound crossing into a scoured patch loses grain at exactly the same line the ground does. And
  // the same slope gate: a mound parked on the rampart's flank would otherwise stay combed while
  // the slope it sits on went bare, which is the one seam this material exists to hide.
  gDrift = ( 1.0 - smoothstep( 0.0028, 0.0095, fwidth( vMapUv.x ) + fwidth( vMapUv.y ) ) )
         * rsbRipEnv( rsbDriftF.xz ) * rsbRipSlope( rsbDriftF );
  diffuseColor.rgb = mix( rsbDriftBase * vec3( 0.92, 0.895, 0.88 ), diffuseColor.rgb, gDrift );`)
      .replace('#include <normal_fragment_maps>', `#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale * gDrift;
  normal = normalize( tbn * mapN );
#endif`);
  };
  mat.customProgramCacheKey = () => 'rsb-drift-sand-2';
  return mat;
}

// ─── paved ground: pads and roads are engineering surfaces, not sand with a tint ───
// The dune ripple is a single tile repeated over the island, so it cannot be masked out by
// hand-editing the texture. Instead the terrain shader recomputes the exact same pad/road falloff
// the height field uses, in world space, and swaps the sand's language for concrete's: ripple
// albedo and normals off, 2.6 m deck slabs with shadowed joints on, and a lower roughness so the
// rolled surface catches the sun differently from the dunes beside it.
const PARS = /* glsl */`
uniform vec4 uPads[10];
uniform vec4 uRoads[6];
uniform float uRoadW[6];
uniform int uPadN;
uniform int uRoadN;
varying float vPave;
varying float vTrack;
varying vec3 vWP;
// Paint has to be resolved per pixel. The terrain mesh is vertex-coloured on a ~1.4 m lattice, so
// anything narrower than that — a 0.5 m taxi line, a joint, a hazard chevron — falls between
// vertices and simply does not exist when it is computed in the vertex stage.
// The deck's own edge: a plaza is paved to its rim, a carriageway to its shoulder.
//
// This is deliberately NOT how far the ground has been levelled, and the shader used to use the
// levelling falloff for both. Measured 2026-09-22 against the live fields: with pads then fading out
// at a fixed r+20 and roads at hw*2.6, 100% of the ground inside r<40 and 92% of everything inside
// r<75 carried a deck weight above 0.5. The rover was not driving on a dune field with a base in it
// — it was driving on a sintered concrete field with a 2.6 m joint lattice, and the sand only
// survived in 5% of the map. gradedAt in height.js owns the wide blend; this owns the paint. (That
// r+20 is retired: the collar is now each pad's own measured batter, so don't grep for it here.)
float rsbDeckPad(vec2 p, vec4 pd){
  return 1.0 - smoothstep( pd.z * 0.78, pd.z * 1.06, distance( p, pd.xy ) );
}
// Where a point sits on the street grid, in the street's own frame. A carriageway's whole surface
// history is written along its axis — ruts, washboards, spoil berms, the churn where two cross — so
// a distance field alone cannot draw one; this returns the direction as well as the offset.
//   .xy unit vector along the winning street, .z signed metres across it, .w metres along from its
//   start. best is that street's deck weight, other the best weight of every *other* street, so
//   the caller can tell a straight run from a junction without a second loop; hw is the half-width
//   the winning street was graded at.
vec4 rsbRoadFrame(vec2 p, out float best, out float other, out float hw){
  best = 0.0;
  other = 0.0;
  hw = 6.0;
  vec4 fr = vec4( 1.0, 0.0, 0.0, 0.0 );
  for ( int i = 0; i < 6; i++ ) {
    if ( i >= uRoadN ) break;
    vec4 rd = uRoads[ i ];
    vec2 ab = rd.zw - rd.xy;
    float ll = max( dot( ab, ab ), 1e-4 );
    vec2 dir = ab / sqrt( ll );
    vec2 c = rd.xy + ab * clamp( dot( p - rd.xy, ab ) / ll, 0.0, 1.0 );
    float k = 1.0 - smoothstep( uRoadW[ i ] * 0.90, uRoadW[ i ] * 1.14, distance( p, c ) );
    if ( k > best ) { other = max( other, best ); best = k; hw = uRoadW[ i ]; fr = vec4( dir, dot( p - c, vec2( -dir.y, dir.x ) ), dot( p - rd.xy, dir ) ); }
    else if ( k > other ) other = k;
  }
  return fr;
}
void rsbMark(vec2 p, out float line, out float edge){
  line = 0.0;
  edge = 0.0;
  for ( int i = 0; i < 10; i++ ) {
    if ( i >= uPadN ) break;
    vec4 pd = uPads[ i ];
    float d = distance( p, pd.xy );
    float k = rsbDeckPad( p, pd );
    // a crisp painted border sits just inside the rim of the deck; 4 % of the pad radius is about
    // a metre of paint, and anything softer than that disappears at driving distance
    float rr = d / pd.z;
    float band = smoothstep( 0.880, 0.902, rr ) * ( 1.0 - smoothstep( 0.940, 0.962, rr ) );
    edge = max( edge, band * smoothstep( 0.20, 0.45, k ) );
  }
  // The streets used to be marked here: a thermoplastic taxi centreline and a shoulder stripe each
  // side, drawn 180 m down four avenues. That paint was load-bearing for a deck that no longer
  // exists — a carriageway of compacted regolith has no reason to carry a painted line, and the
  // ruts the TRACK block carves are a better route cue than a stripe ever was, because they only
  // exist where something actually drove.
}
float rsbMask(vec2 p){
  float w = 0.0;
  for ( int i = 0; i < 10; i++ ) {
    if ( i >= uPadN ) break;
    w = max( w, rsbDeckPad( p, uPads[ i ] ) );
  }
  return w;
}
float rsbHash(vec2 q){ return fract( sin( dot( q, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
float rsbNoise(vec2 p){
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( rsbHash( i ), rsbHash( i + vec2( 1.0, 0.0 ) ), u.x ),
              mix( rsbHash( i + vec2( 0.0, 1.0 ) ), rsbHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
// A unit-height bump profile, evaluated from a signed offset in metres and a half-width in metres.
// exp() rather than a smoothstep so a rut has no flat bottom and no hard shoulder — the way a wheel
// actually presses, and the reason a smoothstep rut reads as a painted stripe instead of a dent.
float rsbBump( float off, float halfW ){ float t = off / max( halfW, 1e-4 ); return exp( -t * t ); }
float gPave;
vec2 gPaveN = vec2( 0.0 );
float gPaveR = 0.0;
// Carriageway, kept separate from the plate all the way to the shading: a plaza is sintered panel
// with sawn joints, a street is pressed-down Martian ground, and only the pads get the deck.
float gTrack;
vec2 gTrackN = vec2( 0.0 );
float gTrackR = 0.0;
// Ripple survival factor: 1 right under the lens, 0 once the tile is denser than the pixels.
float gRipple = 1.0;
// Sand blows across the edge of every deck. The height field's pad falloff is a perfect circle, and
// a mathematically round boundary between paving and dune is the most obviously synthetic line in
// the world — so the outer band loses the deck wherever a drift has crossed it.
float rsbPave(vec2 p, float v){
  float fringe = smoothstep( 0.02, 0.40, v ) * ( 1.0 - smoothstep( 0.52, 0.99, v ) );
  float drift = smoothstep( 0.40, 0.72, rsbNoise( p * 0.34 ) );
  return clamp( v - drift * fringe * 1.2, 0.0, 1.0 );
}
// Sin-free, unlike rsbHash: this one runs five times per ground fragment across the whole horizon,
// and twenty transcendentals per fragment is not something an iGPU hands out for free.
float rsbHash12(vec2 q){
  vec3 p3 = fract( vec3( q.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
float rsbVnoise(vec2 p){
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( rsbHash12( i ), rsbHash12( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( rsbHash12( i + vec2( 0.0, 1.0 ) ), rsbHash12( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
// The desert between the ripple tile and the horizon, 0..1 with mean 0.5 at every scale.
//
// The ripple map is derivative-faded to nothing by 5.5 cm per pixel, and what replaces it is a flat
// constant — so above a few metres the ground had no surface left at all, just the smooth 1.36 m
// vertex tint, which is exactly the "painted sheet" a nadir shot used to show. Grain and plate are
// both accounted for either side of that gap; nothing covered the middle. Four octaves do: each one
// is alive only while its own wavelength still spans a few pixels, so the sum hands the eye a band
// of detail instead of dropping it off a cliff.
//
// Mean-preserved on purpose. The caller modulates brightness by ( s - 0.5 ), so a field whose mean
// drifted with camera altitude would tint the entire planet darker every time someone pulled back.
//
// Streaked, not spotted: ground at this scale is laid down by a prevailing wind, so the same field
// sampled 3.6:1 along and across one fixed bearing reads as a dune field, while the square lattice
// an isotropic noise actually produces reads as a leopard. The bearing is off the street grid on
// purpose — detail that runs along x and z is indistinguishable from the carriageways it sits next
// to, and the eye files it as more road.
vec2 rsbStreak(vec2 w, float f){
  vec2 ax = vec2( 0.9063, 0.4226 );
  return vec2( dot( w, ax ), dot( w, vec2( -ax.y, ax.x ) ) ) * vec2( f, f * 3.6 );
}
float rsbSweep(vec2 w, float px){
  float wx = rsbVnoise( rsbStreak( w, 0.062 ) );
  float wy = rsbVnoise( rsbStreak( w + 31.0, 0.045 ) );
  // Warped before the fine octaves are read, or several value noises on the same square grid stack
  // into a lattice the eye reads as a texture, not as ground. wx doubles as the coarsest octave.
  vec2 q = w + vec2( wx, wy ) * 6.0;
  vec4 n = vec4( rsbVnoise( rsbStreak( q, 1.818 ) + 3.0 ),
                 rsbVnoise( rsbStreak( q, 0.5714 ) - 7.0 ),
                 rsbVnoise( rsbStreak( q, 0.1852 ) + 17.0 ),
                 wx );
  vec4 g = 1.0 - smoothstep( vec4( 0.110, 0.350, 1.080, 3.300 ),
                             vec4( 0.468, 1.488, 4.590, 14.025 ), vec4( px ) );
  vec4 wa = g * vec4( 0.34, 0.28, 0.22, 0.16 );
  float t = wa.x + wa.y + wa.z + wa.w;
  return mix( 0.5, dot( wa, n ) / max( t, 1e-4 ), smoothstep( 0.0, 0.10, t ) );
}
`;

// A deck is laid plate, not a printed grid. The first pass only darkened a mathematically straight
// line every 2.6 m, which read as graph paper: the plaza had no relief, no tilt and no history.
// This offsets alternate rows into running bond, varies every seam's width and tone, sits each
// slab a hair off-level, and pushes a real groove normal into the shading so the joints catch the
// sun on one lip and go black on the other. Silt, oil and wear patches break up the flat field.
const SLABS = /* glsl */`
if ( gPave > 0.004 ) {
  vec2 g = vWP.xz / 2.6;
  g.x += floor( g.y ) * 0.5;                       // running bond
  vec2 id = floor( g );
  vec2 f = fract( g ) - 0.5;
  vec2 a = abs( f );
  // A sawn joint is 12 mm, not 200 mm. At 0.034 slabs the seam ate a tenth of every plate and, once
  // the filler went dark, the plaza read as a lattice of floating dashes instead of a continuous
  // deck — the eye needs a run of unbroken surface before it accepts the joints as grooves.
  //
  // That first cut only fixed a tenth of the error, because w is a HALF-width in cell units: 0.013
  // was not a 12 mm seam, it was a 68 mm trench, and the ±hw window below took the drawn band out to
  // ~110 mm. Measured at a 50-pixel plate that is a 3-pixel black stripe at 55 % contrast — which is
  // why every wide shot still read as dashes rather than lines, and why no amount of amplitude fading
  // made it go away. A real sawn joint is 6..12 mm of half-width, so the groove now covers under two
  // percent of a plate instead of under five.
  float w = 0.0024 + 0.0018 * rsbHash( id + 3.7 );    // no two seams are the same width
  // The seam is drawn at whatever width the pixel can actually resolve. A fixed transition collapses
  // to a hard step the moment one pixel spans more ground than that — and from the rover seat a plaza
  // pixel spans tens of centimetres — so every joint degenerated into a single-pixel black line that
  // the eye stitched into long streaks raking across the deck. Growing the window with the screen-space
  // derivative keeps what a sub-pixel groove can honestly report, which is its coverage, not its shape.
  vec2 d = fwidth( vWP.xz ) / 2.6;                    // one pixel, in slab units
  vec2 hw = max( vec2( 0.0012 ), d * 0.9 );
  // Coverage, not just a soft edge. Widening the window with the pixel keeps the joint's *boundary*
  // from aliasing, but the band it draws is then 2(w+hw) wide while the groove it stands for is 2w.
  // Drawing the full filler colour across all of that paints a two-pixel black line where the truth is
  // a tenth of a pixel, so what survives once the joint is thinner than the pixel is its coverage:
  // the amplitude falls as w/(w+hw) while the window keeps growing.
  vec2 jAmp = w / ( w + hw );
  float jx = ( 1.0 - smoothstep( w - hw.x, w + hw.x, a.x ) ) * jAmp.x;
  float jy = ( 1.0 - smoothstep( w - hw.y, w + hw.y, a.y ) ) * jAmp.y;
  float joint = max( jx, jy );
  // Past a few pixels per plate even that stops resolving, and what remains is not a groove but
  // slightly darker, slightly rougher concrete. So the seam's contrast eases to a floor instead of
  // continuing to bite: 0.02 is a 5 cm pixel, 0.16 is a 42 cm one.
  float gSeam = 1.0 - smoothstep( 0.02, 0.16, max( d.x, d.y ) );

  // plate faces: two-tone sintered grey, a few slabs laid down as darker repair stock
  float tone = rsbHash( id );
  float repair = step( 0.86, rsbHash( id + 11.3 ) );
  vec3 slabCell = mix( vec3( 0.86, 0.88, 0.96 ), vec3( 1.10, 1.05, 0.99 ), tone );
  slabCell *= mix( 1.0, 0.72, repair );
  // Everything above is keyed to the plate's cell id, so it is a hard-edged random mosaic on a 2.6 m
  // axis-aligned lattice — and until now it was the one slab term with no distance falloff at all.
  // Measured for this frame: the rover's own ground spanned 0.10..0.29 m per pixel out to 40 m, so a
  // plate was 9..26 pixels wide, and at that size the eye stops seeing grooves and sees only the
  // mosaic — a field of floating tiles, which is what the whole paved interior read as. A real deck
  // 30 m away is one surface whose tone is the *mean* of its plates, so the mosaic converges to that
  // mean (0.98 * the 14 % repair stock's 0.96) as gSeam closes, and the deck keeps its colour.
  slabCell = mix( vec3( 0.941 ), slabCell, gSeam );
  vec3 slab = slabCell;
  // Diamond tread, faint, only legible at driving distance — and it has to be *told* that. A hard step()
  // on a 0.76 m lattice is about the most alias-primitive thing a shader can write: unresolved, it beats
  // against the pixel grid into moiré exactly like the sand ripple did. Resolved the same way, and
  // switched off entirely once a pixel is more than half a plate wide.
  float te = clamp( max( hw.x, hw.y ) * 3.4, 0.02, 0.5 );
  float tread = smoothstep( 0.5 - te, 0.5 + te, fract( ( g.x + g.y ) * 3.4 ) )
              * smoothstep( 0.5 - te, 0.5 + te, fract( ( g.x - g.y ) * 3.4 ) );
  slab *= 0.97 + tread * 0.05 * gSeam;
  float grit = rsbNoise( vWP.xz * 2.9 );
  float drift = rsbNoise( vWP.xz * 0.13 );
  slab *= 0.90 + 0.18 * grit;
  slab *= 0.92 + 0.16 * drift;
  // oil and coolant: dark, and glossier than the plate around it
  float stain = smoothstep( 0.60, 0.86, rsbNoise( vWP.xz * 0.30 + 4.0 ) ) * ( 1.0 - joint );
  slab *= 1.0 - stain * 0.34;
  slab *= 1.0 - joint * 0.30;
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * slab, gPave );

  // regolith blows back into every groove, so a joint is warmer and redder than the panel face —
  // and darker. When the deck came down to sintered grey this had to come down with it: at 0.46 it
  // sat a stop *above* the new plate faces, and every paved field in the wide shot rendered as a
  // grid of glowing orange dashes rather than shadowed seams.
  float silt = smoothstep( 0.30, 0.62, rsbNoise( vWP.xz * 1.1 ) );
  vec3 siltC = vec3( 0.072, 0.046, 0.032 );
  // The floor here used to be 0.55, so a groove kept more than half its contrast after gSeam had
  // decided it could no longer be drawn — which is how an unresolved joint lattice ends up reading as
  // permanent grout. What is left below is a deliberate, small aggregate darkening: a deck covered in
  // sawn joints really is a little darker and dustier than a monolithic slab.
  diffuseColor.rgb = mix( diffuseColor.rgb, siltC, joint * gPave * ( 0.42 + silt * 0.34 ) * mix( 0.16, 1.0, gSeam ) );
  // dust drifts in off the dunes and lies along the downwind edge of each plate — pale, unlike the
  // joint filler, which is scoured regolith packed into a shadowed groove. Cell-keyed like the plate
  // tone, so it fades with it: a band that sits at a fixed offset inside a 2.6 m square is a tell at
  // any range where the square itself is only a few pixels.
  float edge = smoothstep( 0.30, 0.47, f.y * 0.7 + f.x * 0.3 + 0.35 ) * ( 1.0 - joint ) * gSeam;
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.26, 0.185, 0.125 ), edge * gPave * silt * 0.34 );

  // Painted deck furniture: a taxi centreline and shoulder stripes down every road, and an
  // amber/black hazard border just inside each pad rim. Thermoplastic marking is brighter, flatter
  // and much smoother than the deck around it, it wears away inside the joints, and it spalls.
  float vLine, vEdge;
  rsbMark( vWP.xz, vLine, vEdge );
  float de = clamp( fwidth( vWP.x + vWP.z ) * 0.55 * 0.9, 0.01, 0.5 );
  float dash = smoothstep( 0.5 - de, 0.5 + de, fract( ( vWP.x + vWP.z ) * 0.55 ) );
  float wear = 0.70 + 0.30 * rsbNoise( vWP.xz * 2.6 );
  float paint = clamp( max( vLine, vEdge ) * ( 1.0 - joint * 0.8 ) * gPave * wear * 1.7, 0.0, 1.0 );
  vec3 markC = mix( vec3( 0.52, 0.465, 0.345), vec3( 0.045, 0.034, 0.028 ), 1.0 - dash );
  markC = mix( markC, vec3( 0.52, 0.465, 0.345 ), 1.0 - clamp( vEdge * 9.0, 0.0, 1.0 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, markC, paint * 0.92 );

  // relief: tilt each slab a hair off-level, then fold the bevelled groove walls into the normal.
  // The slope lives where the joint smoothstep transitions, not in its centre, so the wall term
  // peaks mid-bevel and the plate faces stay flat.
  float tx = clamp( ( a.x - ( w - hw.x ) ) / ( 0.005 + 2.0 * hw.x ), 0.0, 1.0 );
  float ty = clamp( ( a.y - ( w - hw.y ) ) / ( 0.005 + 2.0 * hw.y ), 0.0, 1.0 );
  vec2 wall = vec2( 6.0 * tx * ( 1.0 - tx ) * sign( f.x ) * jAmp.x, 6.0 * ty * ( 1.0 - ty ) * sign( f.y ) * jAmp.y );
  vec2 tilt = vec2( rsbHash( id + 1.7 ), rsbHash( id + 8.3 ) ) - 0.5;
  // The old single 0.30 floor applied to both terms, and the tilt term is the one that must not have
  // it: a per-plate random normal offset held at 30 % strength is literally the shading of a plate
  // lattice, and it is the last thing standing once the albedo has converged. The groove wall keeps a
  // floor — a deck of sawn plates really is a slightly broken surface at range — but the tilt goes.
  gPaveN = ( wall * 0.62 * mix( 0.30, 1.0, gSeam ) + tilt * 0.055 * gSeam * gSeam ) * gPave;
  gPaveR = clamp( ( joint * 0.55 + stain * -0.45 + grit * 0.10 ) * gPave - paint * 0.34, -0.5, 0.6 );
}
`;

// A street in a base this size is not paved, it is *graded*. The loose fluff gets dragged aside and
// what is left is the same Martian ground everything else is made of — pressed denser, coarser,
// darker, and shaped by the axles that use it. So this is written as multipliers on the sand already
// sitting in diffuseColor, not as a mix toward a colour: mixing toward a colour is precisely how the
// plate read as a foreign sheet laid on top of the desert, which is the thing being fixed.
//
// Everything here is keyed to the street's own axis. Ruts and washboards run along it, spoil berms
// and the encroaching drift sit across it, and none of that is expressible as a distance field —
// hence rsbRoadFrame rather than another falloff.
const TRACKSURF = /* glsl */`
if ( gTrack > 0.004 ) {
  float trkW, jctW, hw;
  vec4 fr = rsbRoadFrame( vWP.xz, trkW, jctW, hw );
  vec2 dir = fr.xy;
  vec2 perp = vec2( -dir.y, dir.x );
  float across = fr.z;
  float along = fr.w;
  float px = fwidth( vWP.x ) + fwidth( vWP.z );          // metres of ground behind one pixel
  // Anything narrower than a handful of pixels cannot be shaded, only averaged. Every relief term
  // below is gated on this: an unresolved rut is not a faint rut, it is a band of speckle.
  float reslv = 1.0 - smoothstep( 0.012, 0.055, px );
  // The rover's own wheel gauge, measured off the shipped rig: its six pivots sit 1.1 m either side
  // of its centreline. A rut is not a decorative stripe, it is the track that axle left behind.
  float gauge = 1.10;
  float rw = 0.30 + px * 0.8;
  float bA = rsbBump( across - gauge, rw );
  float bB = rsbBump( across + gauge, rw );
  float ruts = clamp( bA + bB, 0.0, 1.0 );
  // The wheels have to put the spoil somewhere: fines get thrown out past their own shoulders, and
  // the ground between and beside the ruts rides high with dust nothing has scoured off yet.
  float berms = rsbBump( abs( across ) - ( gauge + rw * 1.8 ), 0.40 + px );
  float crown = rsbBump( across, gauge * 0.58 );
  // The travelled band, tapering into the graded shoulder rather than ending on a line.
  float band = 1.0 - smoothstep( hw * 0.42, hw * 1.02, abs( across ) );
  // Where two streets cross, neither set of ruts survives the other. What is left has no axis at
  // all — churned, coarser and darker rubble — so the directional terms have to hand over to noise.
  float jct = smoothstep( 0.22, 0.70, jctW );
  float churn = rsbNoise( vWP.xz * 1.35 + 7.0 ) * 0.55 + rsbNoise( vWP.xz * 4.6 ) * 0.45;
  // Coarse aggregate worked up to the surface. Only while a pixel is finer than the clasts: past
  // that it aliases into the same fake grain the dune ripple had before it was derivative-faded.
  float agg = smoothstep( 0.44, 0.84, rsbNoise( vWP.xz * 3.6 ) ) * reslv;
  // Pale dust settling in patches at dune scale, so the strip never degenerates into a bright lane.
  float fines = smoothstep( 0.50, 0.86, rsbNoise( vWP.xz * 0.38 + 12.0 ) );

  // Compacted regolith is not just darker than the fluff beside it, it is cooler: the wind has taken
  // the iron-stained fines out of the travelled band and what is left is coarser, basalt-heavier
  // ground. A brightness-only step of 0.795 was tried first and a street in a driving shot still
  // read as more sand, because everything in this palette is the same hue — the separation has to be
  // chromatic, and a chromatic cue survives all the way to the horizon where every rut has faded.
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.780, 0.802, 0.852 ), gTrack * ( 0.40 + 0.60 * band ) );
  diffuseColor.rgb *= 1.0 - ruts * gTrack * ( 1.0 - jct * 0.75 ) * 0.19;
  diffuseColor.rgb *= 1.0 + ( berms * 0.085 + crown * 0.045 ) * gTrack;
  diffuseColor.rgb *= 1.0 - agg * gTrack * ( 0.12 + jct * 0.15 );
  diffuseColor.rgb *= 1.0 - jct * gTrack * churn * 0.20;
  diffuseColor.rgb *= 1.0 + fines * gTrack * ( 1.0 - band * 0.5 ) * 0.16;

  // Relief. A wheel dent is read almost entirely from its two lips, which catch a low sun in
  // opposite ways; the dent floor itself contributes nearly nothing. dh/d(across) for a sum of
  // gaussians is their analytic derivative, so the ridge lands exactly where the albedo says it
  // does instead of drifting off by half a rut.
  float rutSlope = ( bA * ( across - gauge ) + bB * ( across + gauge ) ) * ( 0.11 / ( rw * rw ) );
  // Washboard: ridges perpendicular to travel at ~0.42 m, the classic self-excited pattern of a
  // vehicle crossing soft ground repeatedly. Small enough that it is only ever shading, never shape.
  float wash = cos( along * 14.96 ) * 0.075 * band * ( 1.0 - jct ) * reslv;
  gTrackN += ( -perp * rutSlope - dir * wash ) * gTrack * reslv;
  // Packed ground is smoother than fluff, the ruts most packed of all, and the worked-up aggregate
  // back the other way. Sign matters here: this is what stops a track reading as a wet ribbon.
  gTrackR = ( -0.11 * band - 0.07 * ruts + 0.06 * agg ) * gTrack;
}
`;

function applyPaving(mat) {
  const { pads, roads } = paveGeometry();
  const P = new Array(10).fill(null).map(() => new THREE.Vector4());
  for (let i = 0; i < P.length; i++) if (pads[i]) P[i].set(pads[i][0], pads[i][1], pads[i][2], 0);
  const R = new Array(6).fill(null).map(() => new THREE.Vector4());
  const RW = new Array(6).fill(0);
  roads.forEach((r, i) => { R[i].set(r[0], r[1], r[2], r[3]); RW[i] = r[4]; });
  const u = { uPads: { value: P }, uRoads: { value: R }, uRoadW: { value: RW }, uPadN: { value: pads.length }, uRoadN: { value: roads.length } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aDeck;\nvarying float vDeck;\n' + PARS + SAND_WARP)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
  // The mesh uv *is* the world frame here: a 300 m plane on 26 tiles puts tile 13.0 at x=z=0, so
  // re-deriving the coordinate from the vertex position lands on the same grid the geometry would
  // have produced, and only the warp is new. That is what lets a drift use this exact expression and
  // stay in register with the ground it is sitting on.
  vec3 rsbVW = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  #ifdef USE_MAP
    vMapUv = rsbSandUv( vec2( rsbVW.x, -rsbVW.z ) );
  #endif
  #ifdef USE_NORMALMAP
    vNormalMapUv = rsbSandUv( vec2( rsbVW.x, -rsbVW.z ) );
  #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vPave = rsbMask( vWP.xz );
  { float trk, jct, hw; rsbRoadFrame( vWP.xz, trk, jct, hw ); vTrack = trk; }
  // A graded building deck is per-vertex data, not a shader loop: the site plan is not finished
  // until props are placed, and dozens of rect SDFs evaluated for 48 000 vertices every frame is
  // the sort of thing that costs an iGPU its frame budget.
  vDeck = aDeck;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vDeck;\n' + PARS + SAND_WARP + RIP_SLOPE)
      .replace('#include <map_fragment>', `#include <map_fragment>
  // The 512² ripple tile spans 11.5 m, so its trains run from 0.94 to 5.0 cycles per metre and the
  // 20 cm one falls below Nyquist as soon as a pixel covers more than half of it. Past that point
  // anisotropic sampling stops saving the map and the whole dune face moirées into hard parallel
  // stripes in every driving shot. Fade the detail map toward its own mean with texture density —
  // grain under the lens, flat rust on the horizon, which is exactly how a real dune field resolves.
  // The window is the Nyquist limit of the *fastest* train, not a taste cutoff: 3.2 cm per pixel in,
  // 11 cm out. The old 4.6–18.5 cm window was tuned to a spectrum whose coarsest ridge was 1.07 m.
  gRipple = ( 1.0 - smoothstep( 0.0028, 0.0095, fwidth( vMapUv.x ) + fwidth( vMapUv.y ) ) )
          * rsbRipEnv( vWP.xz ) * rsbRipSlope( vWP );
  gPave = rsbPave( vWP.xz, max( vPave, vDeck ) );
  // Where an avenue meets a district apron the plate wins, so the grading terminates at the rim of
  // the pad it serves instead of stitching a dirt seam straight through a landing pad.
  gTrack = rsbPave( vWP.xz, vTrack ) * ( 1.0 - gPave );
  // (no vColor here — color_fragment multiplies the vertex tint in *after* this chunk)
  // A graded street has no dune trains left in it: whatever the map says, the surface has been
  // pressed flat and dragged. It keeps a third of the grain, because compacted regolith is still
  // regolith and a perfectly featureless strip is the other tell of a texture-stamped road.
  diffuseColor.rgb = mix( vec3( 0.92, 0.895, 0.88 ), diffuseColor.rgb, gRipple * ( 1.0 - gTrack * 0.66 ) );
  // Scoured hollows keep coarse lag gravel — darker, and flatter in hue than the iron-stained fines
  // blown off them; the raised patches hold a skin of pale dust. Both ride rsbSweep, and both are
  // multipliers on the map rather than a mix toward a colour: the vertex tint is multiplied in
  // *after* this chunk, so mixing toward dark here would crush the rust straight to black.
  float sweepPx = fwidth( vWP.x ) + fwidth( vWP.z );
  float sweepT = ( rsbSweep( vWP.xz, sweepPx ) - 0.5 ) * 2.0;
  // A deck is sintered and a street is dragged, so neither keeps its own mid-frequency ground tone —
  // but the carriageway is still Martian soil and goes only three quarters of the way.
  float sweepOpen = ( 1.0 - gPave ) * ( 1.0 - gTrack * 0.72 );
  float lag = clamp( -sweepT, 0.0, 1.0 );  lag = lag * lag * ( 3.0 - 2.0 * lag );
  float pale = clamp( sweepT, 0.0, 1.0 );  pale = pale * pale * ( 3.0 - 2.0 * pale );
  // Per channel, not scalar. A brightness-only field makes darker and lighter *rust*, which is how
  // the first pass read as stains on one colour; what separates scoured basalt from a dust skin is
  // hue as much as value, so the lag loses red and the pallings keep it.
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.845, 0.880, 0.950 ), lag * sweepOpen );
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.140, 1.095, 0.980 ), pale * sweepOpen );
  float sweepLum = dot( diffuseColor.rgb, vec3( 0.333 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( sweepLum ), lag * sweepOpen * 0.16 );
  // Sintered regolith, not poured concrete. The deck has to sit *inside* the sand's value range:
  // the first pass mixed toward pure white and made a glaring apron, and even the grey that
  // replaced it was two stops brighter and fully desaturated, so under a peach sky every plaza
  // rendered as pink bathroom tile floating on an orange desert. Scoured compacted regolith is
  // darker than the loose sand beside it, not lighter — and a plaza reads as paving from its hue
  // and its joints, not from its brightness. The frame had no pixels below 0.2 luminance left.
  // One stop above the sand, though, not below it: level with the dunes and the whole paved field
  // lost its edges, leaving a lattice of dark seams on orange that read as unmodelled ground.
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.232, 0.206, 0.182 ), gPave * 0.9 );` + SLABS + TRACKSURF)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.80, gPave );
  // Sintered dust is matte. The old floor of 0.05 turned every pad into a sky mirror at grazing
  // angles — south of the gate the whole apron blew out to a white sheet with a dark grid in it,
  // because the only thing still rough was the joint filler.
  roughnessFactor = clamp( roughnessFactor + gPaveR + gTrackR, 0.58, 1.0 );`)
      .replace('#include <normal_fragment_maps>', `#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale * ( 1.0 - gPave * 0.95 ) * ( 1.0 - gTrack * 0.72 ) * gRipple;
  mapN.xy += gPaveN + gTrackN;
  normal = normalize( tbn * mapN );
#endif`);
  };
  // three keys its program cache on the shader source; a patched material must not share one
  mat.customProgramCacheKey = () => 'rsb-paved-terrain-2';
  return u;
}

// These are linear values, so 0.8 read as sRGB 230 — pale coral that a 3.4 sun blew straight to
// cream and cost the island its hue. Real Mars regolith is iron-oxide rust: dark, saturated, and
// it only looks sun-bleached where the crest faces the light. Halved again: the ground is the
// largest surface in every driving frame, and at 0.30 the sun put it above ACES' desaturation
// knee, so the bottom half of the picture rendered as unsaturated cream and the base lost all
// contrast against it. Below ~0.17 linear the oxide hue survives the key light.
const SAND_A = new THREE.Color(0.150, 0.047, 0.023);  // rust dune field
const SAND_B = new THREE.Color(0.098, 0.028, 0.015);  // deeper terracotta in troughs
const SAND_C = new THREE.Color(0.178, 0.060, 0.028);  // sun-lit crest
const PAVE   = new THREE.Color(0.150, 0.112, 0.090);  // dust-covered pads & roads
const TRACK  = new THREE.Color(0.085, 0.046, 0.028);  // compacted wheel lanes
const SPECK  = new THREE.Color(0.060, 0.026, 0.016);  // grit crust
const GRAVEL = new THREE.Color(0.075, 0.032, 0.021);  // dark scree drifts

export function createTerrain(scene) {
  const { size, seg } = TERRAIN;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const decks = new Float32Array(pos.count);
  const nodes = new Float32Array(pos.count);
  const col = new THREE.Color();
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aDeck', new THREE.BufferAttribute(decks, 1));

  // One pass of the ground survey: height, deck cover, and every colour term that follows from
  // them. Run once for the natural surface and again after the site plan has claimed its footings,
  // because the graded lots are laid by props.js and the mesh has to match the analytic field.
  function survey() {
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const y = heightAt(x, z);
      nodes[i] = y;
      pos.setY(i, y);
      decks[i] = deckAt(x, z);
      const tint = fbm(x * 0.02 + 11, z * 0.02 + 5, 3);
      col.copy(SAND_A).lerp(SAND_B, smoothstep(0.35, 0.95, tint));
      col.lerp(SAND_C, smoothstep(2.2, 7.5, y) * 0.45);           // bright rim crest
      col.lerp(SAND_B, smoothstep(-1, -4, y) * 0.6);              // darker beyond the cliff
      const plate = pavedAt(x, z);
      const road = roadAt(x, z);
      if (plate > 0) col.lerp(PAVE, plate * 0.85);             // cream aprons and building decks
      // A carriageway is the same ground it was cut through, pressed down — so it darkens toward
      // TRACK instead of lightening toward PAVE, and keeps its rust hue rather than losing it to
      // concrete grey. This is the vertex half of the shader's gTrack; the two must agree or the
      // tint and the painted surface separate along the shoulder.
      if (road > 0) col.lerp(TRACK, road * 0.62);
      const eng = Math.max(plate, road);
      // soft dune banding so large flats never read as a dead sheet
      col.multiplyScalar(0.94 + 0.12 * vnoise(x * 0.35, z * 0.35));
      // gravel drifts and wind-scoured lighter bands — the mid-scale reading that survives
      // the 1.4 m vertex spacing
      // A pad used to zero all of this out (`* (1 - pave)`), which is why every plaza in the world
      // looked like a painted sheet. Compacted ground is *more* varied than dune sand, not less:
      // traffic lanes, spilled fines and a darker crust where vehicles have turned it over.
      const gravel = smoothstep(0.58, 0.82, fbm(x * 0.055 + 31, z * 0.055 + 17, 3));
      col.lerp(GRAVEL, gravel * 0.42 * (1 - eng * 0.4));
      col.lerp(SAND_C, Math.pow(smoothstep(0.55, 0.95, vnoise(x * 0.12, z * 0.12 + 40)), 2) * 0.20);
      if (plate > 0.15) {
        const lane = smoothstep(0.62, 0.94, vnoise(x * 0.09 + 3, z * 0.09 + 71));
        col.lerp(TRACK, lane * plate * 0.5);                   // worn, compacted darker strips
        col.lerp(SAND_C, smoothstep(0.7, 0.97, vnoise(x * 0.5, z * 0.5)) * plate * 0.22);
      }
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
    }
    installSurfaceGrid(nodes, seg, size);
    geo.attributes.color.needsUpdate = true;
    geo.attributes.aDeck.needsUpdate = true;
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  survey();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.94, metalness: 0.0,
  });
  const detail = sandDetail();
  mat.map = detail.map;
  mat.normalMap = detail.normalMap;
  // The map now arrives with its slopes already calibrated, so the scale is a taste knob rather than
  // a damage-limit: 1.0 lets the 24° crests through at full tilt, and the distance fade in the shader
  // is what removes them before they can alias. The old 0.45 existed to mute a saturated map; muting a
  // saturated map by half still leaves a saturated map, which is why the banding survived it.
  mat.normalScale.set(1, 1);
  applyPaving(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  scene.add(mesh);
  // props.js claims a graded footing per building *while it places* the models, i.e. after this
  // mesh was built. The height field is the analytic truth, so one after-the-plan survey puts the
  // ground, the deck mask and the rover's `surfaceAt` back in agreement with what it drew.
  mesh.regrade = () => {
    survey();
    geo.computeBoundingSphere();
  };
  return mesh;
}

// The open-desert boulders, built from the same `rim_rock` kit as the rampart.
//
// Four things this used to get wrong, all of them measured.
//
// Bound: the scatter reached r=211 while the terrain mesh is a 300 m square, so 49 of the 64 boulders
// were laid on analytic ground past the last drawn triangle — invisible from the plateau, hanging in
// mid-air from any view over the rim. The bound is now the mesh's shortest half-extent minus a
// margin, so every rock sits on ground that exists.
//
// Solidity: none of them were solid. A boulder you can drive through is scenery, not an obstacle, so
// the footprints go back to the caller for the collision set — the same 碰撞体与外观 mismatch the
// rampart was built to end.
//
// Siting: it kept rocks out of every zone circle plus 12 m, and with twelve zones that blanket the
// island. Surveyed on the finished site plan, 0% of the ground inside r=112 passed and 100% of what
// was left was the 12 m band at the foot of the rim wall — every boulder in the world parked in one
// ring, and none on the dunes the player drives across. The test is now the one the plan itself
// answers: engineered ground (a zone pad, a roadway, a building deck) stays clear, everything else is
// desert. Which is also why this runs after buildBase and terrain.regrade() rather than before.
//
// Material: even after those three were fixed, a frame off the dune was a bright yellow stone wearing
// a teal cap. The Kenney Nature Kit glbs are the island's only untextured assets — `rock_largeA`
// ships 0 textures, 146 verts and two flat colour factors, #f2be9e and #73eddd. That saturated
// cartoon-Earth palette sits in no Martian light, and a saturated rock is precisely the programmer
// art the rest of this pass exists to remove. The rim kit is already forged with `rock_basalt` maps,
// so the dunes now use it too: same stone as the rampart, one merged batch for all the basalt on the
// island, and — because that kit's footprint *is* the disc table in rim_rock.js rather than a guess
// at it — the scatter inherits C3 for free instead of approximating a silhouette with a box.
// Gravel's domain, which reaches over the rampart: a 0.4 m chip on the scarp is scree, and no frame
// reads it as a floating boulder. The boulders are bounded by SAND_R below instead.
const SCATTER_R = ISLAND.rim + 12;   // 144 m: past the crest, inside the mesh's 150 m half-width
// Where a boulder is allowed to stand, which is not the same question as where a chip of gravel is.
// The rampart's toe is `ISLAND.radius - 5.5 ± 2.5`, so 110 m is the nearest ground the wall starts
// on, and everything outside it is scarp the rover can never reach. Measured before this line
// existed: 37 of the 64 stones drawn out to SCATTER_R landed at r >= 108 — 29 of them on the upper
// flank and crest, 7 on the far-side scarp 15..26 m *below* the island. Every one of them was seated
// correctly (worst sole-to-ground standoff 0.47 m), and every one of them still read as a rock
// floating against the sky, because a low eye on the sand sheet looks over the concave lower flank
// and sees nothing under the stone. A boulder cannot be a silhouette prop on ground nobody can
// stand on; it is only ever an artifact there.
const SAND_R = ISLAND.radius - 8;    // 110 m: the sand sheet, and the whole domain of the scatter
// Checked again after the line above landed, off the collider set the finished build exports: 30
// stones, centres spanning r 53.3..107.1, and the widest body — centre plus its own footprint —
// reaching 108.74, with none past 110. The old frame's artifact is gone by construction, not by luck.
export async function createRocks(scene, avoid = []) {
  const kit = await loadModel('rim_rock');   // already fetched by buildBase's hero list
  // A weighted bag rather than a uniform pick. Six archetypes also means six silhouettes — with the
  // ring's three alone, a dune frame came back as 64 copies of one shape.
  //
  // The weights are set from the field, not from intuition. Measured on the first six-archetype
  // scatter, 47 of the 64 stones came out flatter than 0.45 height-to-width and the median was 0.37:
  // the three flat families (cobble/slab/ledge, authored at 0.23–0.38) owned two thirds of the bag,
  // so a backlit frame showed a row of identical tortoise shells and the angular clasts that carry
  // the read were rare. Basalt fields really are dominated by chips, so the chips stay the single
  // most common pick — but the blocky families now outnumber them, because what a player judges the
  // island by is the mid-field, and the mid-field was all pancake.
  const BAG = ['cobble', 'cobble', 'cobble', 'cobble', 'slab', 'slab', 'ledge',
    'block', 'block', 'block', 'shard', 'shard', 'shard', 'mega', 'mega'];
  const clast = {};
  for (const name of new Set(BAG)) clast[name] = kit.getObjectByName(name);
  const rand = mulberry32(777);
  const group = new THREE.Group();
  group.name = 'rock-scatter';
  const placed = [], solids = [];
  const n = new THREE.Vector3(), v = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const qTilt = new THREE.Quaternion(), qYaw = new THREE.Quaternion();
  let guard = 0;
  // Rejection is the cost of doing business here — paved ground and steep faces are most of the
  // island — so the budget has to be far above the count it is chasing.
  //
  // 30, not the 64 this ran at when its domain was the whole mesh. The count is set by the ground
  // the stones are now allowed to sit on: 28 of the old 64 fell inside r = 110, so keeping the
  // sand sheet at roughly the density the island was accepted at means ~30 stones over that disc,
  // and the other 34 were only ever standing on the rampart. 30 is what the build actually places —
  // the rejection budget is not the binding constraint, so the domain is a bound and not a wish.
  while (placed.length < 30 && guard++ < 8000) {
    const a = rand() * Math.PI * 2;
    const r = 26 + Math.pow(rand(), 0.62) * (SAND_R - 26);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (gradedAt(x, z) > 0.02) continue;             // no boulder on engineered ground
    if (surfaceSlope(x, z) > 0.5) continue;          // one clinging to a 27° face reads as a mistake
    const name = BAG[Math.floor(rand() * BAG.length)];
    const spec = RIM_ROCK[name];
    // Size comes from the archetype first and the draw second. The kit already spans a 0.94 m cobble
    // to a 4.4 m shard, so the runtime scale only has to keep that spread from collapsing; the
    // earlier 0.22–0.84 range turned every one of the six into the same pebble anyway.
    const s = 0.42 + Math.pow(rand(), 1.6) * 0.62;
    // Y is drawn from its own range, not from s. Coupling them (±18%) meant a stone's height-to-width
    // ratio was fixed by its archetype, so the bag's flat families could only ever produce flat
    // stones; ±37% around s lets a cobble sit up as a chip and a block slump as a slab. Purely
    // cosmetic — the exported discs are laid at local y=0, so a Y scale cannot move the collision.
    const sy = s * (0.70 + rand() * 0.75);
    // Uniform in XZ and independent in Y is the whole constraint: the exported discs are circles in
    // the plan, so any anisotropic horizontal scale would make this table a lie again.
    const rad = spec.discs.reduce((m, [dx, dz, dr]) =>
      Math.max(m, Math.hypot(dx, dz) * s + dr * s), 0);
    // The *body* sorts inside the toe, not the centre: the largest clast measured 3.32 m across, so
    // one landing with its middle at 107 still has most of itself standing on the scarp. Rejecting
    // here is what makes the line above a rule rather than a suggestion.
    if (r + rad > SAND_R) continue;
    let ok = true;
    // What has to be spaced is the gap, not the centres: two discs 2 m apart still hold the 3.2 m
    // body between them, and the deadlock scan calls that a slot.
    for (const p of placed) if (Math.hypot(x - p[0], z - p[1]) < p[2] + rad + 3.6) ok = false;
    for (const c of avoid) {
      if (c.floor === undefined && Math.hypot(x - c.x, z - c.z) < c.r + rad + 2.6) { ok = false; break; }
    }
    if (!ok) continue;
    const o = cloneModel(clast[name]);
    o.scale.set(s, sy, s);
    qYaw.setFromAxisAngle(UP, rand() * Math.PI * 2);
    // Match the sole to the slope it stands on, sampled at the rock's own width — a 0.6 m chord
    // (normalAt's) is weather noise under a 6 m clast. Surface-grid truth, not the analytic field,
    // because the mesh is what the rover drives on and what these discs are drawn to agree with.
    const e = Math.max(1.2, spec.reachT * s);
    n.set(
      -(surfaceAt(x + e, z) - surfaceAt(x - e, z)) / (2 * e), 1,
      -(surfaceAt(x, z + e) - surfaceAt(x, z - e)) / (2 * e)
    ).normalize();
    o.quaternion.copy(qTilt.setFromUnitVectors(UP, n)).multiply(qYaw);
    o.position.set(x, surfaceAt(x, z), z);
    o.updateMatrixWorld(true);
    // Measured seating, not a constant: aim the lowest point of the transformed stone a little under
    // the surveyed surface, so the sole seals into the sand at any tilt instead of standing off it at
    // its corners the way a flat chord does.
    //
    // The residual that correction cannot reach, measured on the finished 30 by raycasting the drawn
    // terrain up through each stone's own lowest 0.3 m band of vertices: worst standoff 0.357 m, and
    // at those points the drawn mesh and the sampled grid are the same height to within the 0.01 m
    // the readout reports, so the number does not belong to whichever of the two is a lie. It is not
    // the seating missing the ground it was aimed at either — it is a rigid sole spanning the flanks
    // of ripple dunes, which is what a metre-scale block does in the field, and the only way to
    // remove it is to deform the stone, i.e. to stop using the kit that carries the silhouette.
    const bb = new THREE.Box3().setFromObject(o);
    o.position.y += (surfaceAt(x, z) - 0.045 * spec.h * sy) - bb.min.y;
    o.updateMatrixWorld(true);
    group.add(o);
    placed.push([x, z, rad]);
    // Same discipline as the rampart: the discs go through the clone's world matrix, so whatever
    // transform drew this stone is the transform that stops the rover — scale, tilt, yaw and all.
    // They share one `prop` name the way the rampart's four do, so grouping colliders by prop is
    // grouping them by the boulder they belong to.
    for (const [dx, dz, dr] of spec.discs) {
      v.set(dx, 0, dz).applyMatrix4(o.matrixWorld);
      solids.push({ x: +v.x.toFixed(2), z: +v.z.toFixed(2), zone: 'scatter',
        prop: `scatter:rock#${placed.length - 1}`, r: +(dr * s).toFixed(2) });
    }
  }
  scene.add(group);
  // Every stone would be its own mesh in both the main and the shadow pass, and the measured cost of
  // the scatter was almost entirely that submission, not its triangles. The rocks never move, so they
  // go through the same collapsing as the rest of the static base. Reproduce with: hide and show
  // `rock-scatter` across two otherwise identical composer frames with info.autoReset off, camera at
  // spawn — the 30 stones come to one mesh on one material and cost 2 of a frame's 1 556 draw calls
  // and 93 960 of its 2 055 529 triangles, i.e. 46 980 drawn once and again into the shadow map.
  mergeInto(group);
  return solids;
}

// The terrain mesh samples the surface every 1.4 m and a normal map can only fake relief per
// pixel, so at driving height the island was a painted sheet with nothing standing on it. Real
// stones — one instanced draw call, colour and silhouette variation for free, and they catch the
// low sun along the whole dune field.
export function createStones(scene, count = 3600) {
  const rand = mulberry32(0x5c0ffee);
  // Detail 1, not 0: at the base of a dune a 20-face chip is a handful of triangles, and mid-way
  // out it was the one object in the frame that read as unmodelled geometry. The extra facet loop
  // costs 4x the verts of a single instanced draw call and gives the noise something to chew on.
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    // A chip broken off a basalt slab is flat-ish and angular, not a ball: squash Y and push each
    // vertex out by its own noise value so no two silhouettes match.
    const k = 0.55 + vnoise(p.getX(i) * 2.7 + 5, p.getZ(i) * 2.7 + 9) * 0.9;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.55, p.getZ(i) * k);
  }
  geo.computeVertexNormals();
  // Smooth-shaded. Flat shading on top of the jitter made every stone a cut gem that caught the
  // low sun as 20 hard bright facets — real scoria chips are dust-coated and read matte.
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.04 });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
  const e = new THREE.Euler(), col = new THREE.Color();
  let n = 0, guard = 0;
  while (n < count && guard++ < count * 4) {
    const a = rand() * Math.PI * 2;
    const r = 5 + Math.pow(rand(), 0.6) * (SCATTER_R - 5);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    // Gravel belongs on the dune, not on engineered ground: a chip sitting on a sawn level reads as
    // litter, and every footing the site plan cuts changes the height under a previously placed one.
    // The analytic field is used rather than the mesh because the plan is not complete when this runs.
    const lot = lotAt(x, z);
    if (lot && lot.sd < 0) continue;
    const sc = 0.07 + Math.pow(rand(), 2.3) * 0.5;
    e.set(rand() * 6.283, rand() * 6.283, rand() * 6.283);
    q.setFromEuler(e);
    v.set(x, heightAt(x, z) - sc * 0.28, z);
    s.set(sc * (0.75 + rand() * 0.7), sc * (0.7 + rand() * 0.6), sc * (0.75 + rand() * 0.7));
    mesh.setMatrixAt(n, m4.compose(v, q, s));
    col.copy(SPECK).lerp(GRAVEL, rand()).lerp(SAND_C, rand() * 0.5);
    mesh.setColorAt(n, col);
    n++;
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.frustumCulled = true;
  scene.add(mesh);
  return mesh;
}
