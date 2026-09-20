import * as THREE from 'three';
import { heightAt, installSurfaceGrid, surfaceAt, pavedAt, paveGeometry } from './height.js';
import { TERRAIN, ZONES, ISLAND } from '../config.js';
import { fbm, vnoise, mulberry32, smoothstep } from '../utils/noise.js';
import { loadModel, cloneModel } from './assets.js';

// The dune field is one 512² tile repeated 26× over 300 m, so at 2.2 cm per texel it carries every
// grain the player drives through. A normal map alone was not enough: on a roughness-0.94 diffuse
// surface under a near-overhead sun, ripple normals barely change the shading, so the ground still
// read as a painted sheet. Real sand ripples show up because the crests are dry, coarse and
// sun-bleached while the troughs hold finer, darker, wind-scoured material — an *albedo* signal.
// Both maps are derived from one height field so the light and the colour always agree.
//
// The wave trains use integer wave-vector components over the tile, which is what makes the field
// exactly periodic: a non-tiling seam repeated 26× across the world shows up as dead-straight
// lines, and an albedo seam is far more visible than a normal one.
export function makeSandDetail(size = 512) {
  // All five trains run within ±10° of one another. Crossing them at wide angles — the obvious
  // thing to reach for — weaves a diamond lattice that reads as carpet, not sand; wind lays ripples
  // near-parallel, with the variety coming from spacing and from crests that wander.
  const WAVES = [[9, 6, 1.0], [14, 8, 0.74], [19, 16, 0.56], [28, 19, 0.40], [40, 30, 0.26]];
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
  // pn() takes a lattice period in *tiles*, so it wraps exactly at the texture edge.
  const pn = (x, y, P) => pnoise(x * P / size, y * P / size, P);

  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const bend = (pn(x, y, 3) - 0.5) * 1.5 + (pn(x, y, 8) - 0.5) * 0.9;
      let v = 0;
      for (const [kx, ky, amp] of WAVES) {
        const kmag = Math.hypot(kx, ky);
        // Shifting each train's phase by its own wavenumber keeps the crest spacing locally
        // constant — real ridges meander around dune faces rather than marching in straight lines.
        const s = 0.5 + 0.5 * Math.sin((kx * x + ky * y) * TAU / size + kmag * bend * 0.16);
        v += amp * Math.pow(s, 2.2);          // peaked crests, flat troughs — aeolian, not sinusoidal
      }
      const grain = pn(x, y, 460) * 0.55 + pn(x, y, 120) * 0.45;
      v = v * 0.66 + (grain - 0.5) * 0.34 + 0.17;
      h[y * size + x] = v;
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
    t.repeat.set(26, 26);
    t.anisotropy = 8;
    return t;
  };

  const at = (x, y) => h[((y % size + size) % size) * size + (x % size + size) % size];

  const normalMap = mk((d) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      // 2-px taps: the 1-px gradient of a field this noisy is mostly grain, and the ripples — the
      // shape the eye actually reads — need the wider baseline to survive normalScale.
      const l = at(x - 2, y), r = at(x + 2, y), dn = at(x, y - 2), up = at(x, y + 2);
      let nx = (l - r) * 2.6, ny = (dn - up) * 2.6;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      d[i] = (nx / len * 0.5 + 0.5) * 255;
      d[i + 1] = (ny / len * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  });

  const map = mk((d) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const k = (h[y * size + x] - lo) * inv;
      const i = (y * size + x) * 4;
      // Crest: bleached, coarse, bright. Trough: finer rust that has been swept clean.
      d[i] = (0.66 + 0.42 * k) * 255;
      d[i + 1] = (0.60 + 0.44 * k) * 255;
      d[i + 2] = (0.55 + 0.47 * k) * 255;
      d[i + 3] = 255;
    }
  });
  map.colorSpace = THREE.SRGBColorSpace;
  return { map, normalMap };
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
varying vec3 vWP;
// Paint has to be resolved per pixel. The terrain mesh is vertex-coloured on a ~1.4 m lattice, so
// anything narrower than that — a 0.5 m taxi line, a joint, a hazard chevron — falls between
// vertices and simply does not exist when it is computed in the vertex stage.
void rsbMark(vec2 p, out float line, out float edge){
  line = 0.0;
  edge = 0.0;
  for ( int i = 0; i < 10; i++ ) {
    if ( i >= uPadN ) break;
    vec4 pd = uPads[ i ];
    float d = distance( p, pd.xy );
    float k = 1.0 - smoothstep( pd.z * 0.62, pd.z + 20.0, d );
    // a crisp painted border sits just inside the rim of the deck; 4 % of the pad radius is about
    // a metre of paint, and anything softer than that disappears at driving distance
    float rr = d / pd.z;
    float band = smoothstep( 0.880, 0.902, rr ) * ( 1.0 - smoothstep( 0.940, 0.962, rr ) );
    edge = max( edge, band * smoothstep( 0.20, 0.45, k ) );
  }
  for ( int i = 0; i < 6; i++ ) {
    if ( i >= uRoadN ) break;
    vec4 rd = uRoads[ i ];
    float hw = uRoadW[ i ];
    vec2 ab = rd.zw - rd.xy;
    float t = clamp( dot( p - rd.xy, ab ) / dot( ab, ab ), 0.02, 0.98 );
    float d = distance( p, rd.xy + ab * t );
    float inl = 1.0 - smoothstep( hw * 0.80, hw * 1.05, d );      // stop painting past the road ends
    // taxi centreline plus a shoulder stripe each side, the way an apron is actually marked
    float centre = 1.0 - smoothstep( 0.42, 0.60, d );
    float shoulder = 1.0 - smoothstep( 0.20, 0.36, abs( d - hw * 0.66 ) );
    line = max( line, max( centre, shoulder * 0.85 ) * inl );
  }
}
float rsbMask(vec2 p){
  float w = 0.0;
  for ( int i = 0; i < 10; i++ ) {
    if ( i >= uPadN ) break;
    vec4 pd = uPads[ i ];
    w = max( w, 1.0 - smoothstep( pd.z * 0.62, pd.z + 20.0, distance( p, pd.xy ) ) );
  }
  for ( int i = 0; i < 6; i++ ) {
    if ( i >= uRoadN ) break;
    vec4 rd = uRoads[ i ];
    vec2 ab = rd.zw - rd.xy;
    float t = clamp( dot( p - rd.xy, ab ) / dot( ab, ab ), 0.0, 1.0 );
    float d = distance( p, rd.xy + ab * t );
    w = max( w, 1.0 - smoothstep( uRoadW[ i ] * 0.8, uRoadW[ i ] * 2.6, d ) );
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
float gPave;
vec2 gPaveN = vec2( 0.0 );
float gPaveR = 0.0;
// Sand blows across the edge of every deck. The height field's pad falloff is a perfect circle, and
// a mathematically round boundary between paving and dune is the most obviously synthetic line in
// the world — so the outer band loses the deck wherever a drift has crossed it.
float rsbPave(vec2 p, float v){
  float fringe = smoothstep( 0.02, 0.40, v ) * ( 1.0 - smoothstep( 0.52, 0.99, v ) );
  float drift = smoothstep( 0.40, 0.72, rsbNoise( p * 0.34 ) );
  return clamp( v - drift * fringe * 1.2, 0.0, 1.0 );
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
  float w = 0.013 + 0.008 * rsbHash( id + 3.7 );    // no two seams are the same width
  float jx = 1.0 - smoothstep( w, w + 0.012, a.x );
  float jy = 1.0 - smoothstep( w, w + 0.012, a.y );
  float joint = max( jx, jy );

  // plate faces: two-tone sintered grey, a few slabs laid down as darker repair stock
  float tone = rsbHash( id );
  float repair = step( 0.86, rsbHash( id + 11.3 ) );
  vec3 slab = mix( vec3( 0.86, 0.88, 0.96 ), vec3( 1.10, 1.05, 0.99 ), tone );
  slab *= mix( 1.0, 0.72, repair );
  // diamond tread, faint, only legible at driving distance
  float tread = step( 0.5, fract( ( g.x + g.y ) * 3.4 ) ) * step( 0.5, fract( ( g.x - g.y ) * 3.4 ) );
  slab *= 0.97 + tread * 0.05;
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
  diffuseColor.rgb = mix( diffuseColor.rgb, siltC, joint * gPave * ( 0.42 + silt * 0.34 ) );
  // dust drifts in off the dunes and lies along the downwind edge of each plate — pale, unlike the
  // joint filler, which is scoured regolith packed into a shadowed groove
  float edge = smoothstep( 0.30, 0.47, f.y * 0.7 + f.x * 0.3 + 0.35 ) * ( 1.0 - joint );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.26, 0.185, 0.125 ), edge * gPave * silt * 0.34 );

  // Painted deck furniture: a taxi centreline and shoulder stripes down every road, and an
  // amber/black hazard border just inside each pad rim. Thermoplastic marking is brighter, flatter
  // and much smoother than the deck around it, it wears away inside the joints, and it spalls.
  float vLine, vEdge;
  rsbMark( vWP.xz, vLine, vEdge );
  float dash = step( 0.5, fract( ( vWP.x + vWP.z ) * 0.55 ) );
  float wear = 0.70 + 0.30 * rsbNoise( vWP.xz * 2.6 );
  float paint = clamp( max( vLine, vEdge ) * ( 1.0 - joint * 0.8 ) * gPave * wear * 1.7, 0.0, 1.0 );
  vec3 markC = mix( vec3( 0.52, 0.465, 0.345), vec3( 0.045, 0.034, 0.028 ), 1.0 - dash );
  markC = mix( markC, vec3( 0.52, 0.465, 0.345 ), 1.0 - clamp( vEdge * 9.0, 0.0, 1.0 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, markC, paint * 0.92 );

  // relief: tilt each slab a hair off-level, then fold the bevelled groove walls into the normal.
  // The slope lives where the joint smoothstep transitions, not in its centre, so the wall term
  // peaks mid-bevel and the plate faces stay flat.
  float tx = clamp( ( a.x - w ) / 0.030, 0.0, 1.0 );
  float ty = clamp( ( a.y - w ) / 0.030, 0.0, 1.0 );
  vec2 wall = vec2( 6.0 * tx * ( 1.0 - tx ) * sign( f.x ), 6.0 * ty * ( 1.0 - ty ) * sign( f.y ) );
  vec2 tilt = vec2( rsbHash( id + 1.7 ), rsbHash( id + 8.3 ) ) - 0.5;
  gPaveN = ( wall * 0.62 + tilt * 0.055 ) * gPave;
  gPaveR = clamp( ( joint * 0.55 + stain * -0.45 + grit * 0.10 ) * gPave - paint * 0.34, -0.5, 0.6 );
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
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vPave = rsbMask( vWP.xz );`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <map_fragment>', `#include <map_fragment>
  gPave = rsbPave( vWP.xz, vPave );
  // Sintered regolith, not poured concrete. The deck has to sit *inside* the sand's value range:
  // the first pass mixed toward pure white and made a glaring apron, and even the grey that
  // replaced it was two stops brighter and fully desaturated, so under a peach sky every plaza
  // rendered as pink bathroom tile floating on an orange desert. Scoured compacted regolith is
  // darker than the loose sand beside it, not lighter — and a plaza reads as paving from its hue
  // and its joints, not from its brightness. The frame had no pixels below 0.2 luminance left.
  // One stop above the sand, though, not below it: level with the dunes and the whole paved field
  // lost its edges, leaving a lattice of dark seams on orange that read as unmodelled ground.
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.232, 0.206, 0.182 ), gPave * 0.9 );` + SLABS)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.80, gPave );
  // Sintered dust is matte. The old floor of 0.05 turned every pad into a sky mirror at grazing
  // angles — south of the gate the whole apron blew out to a white sheet with a dark grid in it,
  // because the only thing still rough was the joint filler.
  roughnessFactor = clamp( roughnessFactor + gPaveR, 0.58, 1.0 );`)
      .replace('#include <normal_fragment_maps>', `#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale * ( 1.0 - gPave * 0.95 );
  mapN.xy += gPaveN;
  normal = normalize( tbn * mapN );
#endif`);
  };
  // three keys its program cache on the shader source; a patched material must not share one
  mat.customProgramCacheKey = () => 'rsb-paved-terrain';
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
  const nodes = new Float32Array(pos.count);
  const col = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = heightAt(x, z);
    nodes[i] = y;
    pos.setY(i, y);
    const r = Math.hypot(x, z);
    const tint = fbm(x * 0.02 + 11, z * 0.02 + 5, 3);
    col.copy(SAND_A).lerp(SAND_B, smoothstep(0.35, 0.95, tint));
    col.lerp(SAND_C, smoothstep(2.2, 7.5, y) * 0.45);           // bright rim crest
    col.lerp(SAND_B, smoothstep(-1, -4, y) * 0.6);              // darker beyond the cliff
    const pave = pavedAt(x, z);
    if (pave > 0) col.lerp(PAVE, pave * 0.85);                  // cream pads & roads
    // soft dune banding so large flats never read as a dead sheet
    col.multiplyScalar(0.94 + 0.12 * vnoise(x * 0.35, z * 0.35));
    // gravel drifts and wind-scoured lighter bands — the mid-scale reading that survives
    // the 1.4 m vertex spacing
    // A pad used to zero all of this out (`* (1 - pave)`), which is why every plaza in the world
    // looked like a painted sheet. Compacted ground is *more* varied than dune sand, not less:
    // traffic lanes, spilled fines and a darker crust where vehicles have turned it over.
    const gravel = smoothstep(0.58, 0.82, fbm(x * 0.055 + 31, z * 0.055 + 17, 3));
    col.lerp(GRAVEL, gravel * 0.42 * (1 - pave * 0.4));
    col.lerp(SAND_C, Math.pow(smoothstep(0.55, 0.95, vnoise(x * 0.12, z * 0.12 + 40)), 2) * 0.20);
    if (pave > 0.15) {
      const lane = smoothstep(0.62, 0.94, vnoise(x * 0.09 + 3, z * 0.09 + 71));
      col.lerp(TRACK, lane * pave * 0.5);                       // worn, compacted darker strips
      col.lerp(SAND_C, smoothstep(0.7, 0.97, vnoise(x * 0.5, z * 0.5)) * pave * 0.22);
    }
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  installSurfaceGrid(nodes, seg, size);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.94, metalness: 0.0,
  });
  const detail = makeSandDetail();
  mat.map = detail.map;
  mat.normalMap = detail.normalMap;
  // The ripple shape is now carried by albedo, so the normals only have to whisper; at full
  // strength the tiling field read as corduroy — perfectly parallel waves with no height behind them.
  mat.normalScale.set(0.62, 0.62);
  applyPaving(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  scene.add(mesh);
  return mesh;
}

// Kenney Nature Kit boulders — real modeled rocks instead of jagged icospheres.
export async function createRocks(scene) {  const names = ['rock_largeA', 'rock_largeB', 'rock_largeC', 'rock_smallA', 'rock_smallB',
    'rock_smallC', 'rock_smallD', 'rock_smallFlatA', 'rock_smallFlatB', 'rock_smallG'];
  const models = await Promise.all(names.map(n => loadModel(`kenney/nature/${n}`)));
  const rand = mulberry32(777);
  const group = new THREE.Group();
  const placed = [];
  let guard = 0;
  while (placed.length < 64 && guard++ < 900) {
    const a = rand() * Math.PI * 2;
    const r = 40 + Math.pow(rand(), 0.7) * (ISLAND.rim + 40);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    let ok = true;
    for (const zn of Object.values(ZONES)) {
      if (Math.hypot(x - zn.pos[0], z - zn.pos[1]) < zn.radius + 12) ok = false;
    }
    for (const p of placed) if (Math.hypot(x - p[0], z - p[1]) < 9) ok = false;
    if (!ok) continue;
    placed.push([x, z]);
    const m = cloneModel(models[Math.floor(rand() * models.length)]);
    const s = 0.8 + rand() * 2.6;
    m.scale.setScalar(s);
    m.position.set(x, surfaceAt(x, z) - 0.25, z);
    m.rotation.y = rand() * Math.PI * 2;
    group.add(m);
  }
  scene.add(group);
  return group;
}

// The terrain mesh samples the surface every 1.4 m and a normal map can only fake relief per
// pixel, so at driving height the island was a painted sheet with nothing standing on it. Real
// stones — one instanced draw call, colour and silhouette variation for free, and they catch the
// low sun along the whole dune field.
export function createStones(scene, count = 3600) {
  const rand = mulberry32(0x5c0ffee);
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    // A chip broken off a basalt slab is flat-ish and angular, not a ball: squash Y and push each
    // vertex out by its own noise value so no two silhouettes match.
    const k = 0.55 + vnoise(p.getX(i) * 2.7 + 5, p.getZ(i) * 2.7 + 9) * 0.9;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.55, p.getZ(i) * k);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.04, flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
  const e = new THREE.Euler(), col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const r = 5 + Math.pow(rand(), 0.6) * (ISLAND.rim + 30);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const sc = 0.07 + Math.pow(rand(), 2.3) * 0.5;
    e.set(rand() * 6.283, rand() * 6.283, rand() * 6.283);
    q.setFromEuler(e);
    v.set(x, surfaceAt(x, z) - sc * 0.28, z);
    s.set(sc * (0.75 + rand() * 0.7), sc * (0.7 + rand() * 0.6), sc * (0.75 + rand() * 0.7));
    mesh.setMatrixAt(i, m4.compose(v, q, s));
    col.copy(SPECK).lerp(GRAVEL, rand()).lerp(SAND_C, rand() * 0.5);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.frustumCulled = true;
  scene.add(mesh);
  return mesh;
}
