import * as THREE from 'three';

// Both shaders are JS template literals: a backtick inside either one ends the string early, which
// kills the whole module graph with a syntax error the browser only reports when it parses it.
// `node --check src/fx/particles.js` catches it in one second.
const VS = `
attribute float aLife; attribute float aSize;
uniform float uPixelRatio, uMaxSize, uNearFade, uFocal;
varying float vLife;
varying float vNear;
void main(){
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position,1.0);
  float dist = max(-mv.z, 1.0);
  // Uncapped, a mote 1 m from the lens covers the whole screen; the DOF pass then smears it
  // into a flat orange disc that dominates the frame. Clamp the sprite and dissolve it near.
  gl_PointSize = min(aSize * (uFocal / dist), uMaxSize) * uPixelRatio;
  vNear = smoothstep(uNearFade * 0.3, uNearFade, dist);
  gl_Position = projectionMatrix * mv;
}`;
const FS = `
precision mediump float;
varying float vLife;
varying float vNear;
uniform vec3 uColor0, uColor1;
uniform float uOpacity, uFadeIn, uInner;
void main(){
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  float a = smoothstep(0.5, uInner, d) * vNear;
  if (a <= 0.001 || vLife >= 1.0 || vLife < 0.0) discard;
  float t = vLife;
  vec3 c = mix(uColor0, uColor1, t);
  float fade = (1.0 - t) * smoothstep(0.0, uFadeIn, t);
  gl_FragColor = vec4(c, a * uOpacity * fade);
}`;

export class ParticlePool {
  constructor(scene, count, opts = {}) {
    this.count = count;
    const pos = new Float32Array(count * 3);
    const life = new Float32Array(count).fill(1);
    const size = new Float32Array(count);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4000);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS,
      uniforms: {
        uColor0: { value: new THREE.Color(opts.color0 || 0xffffff) },
        uColor1: { value: new THREE.Color(opts.color1 || 0x222222) },
        uOpacity: { value: opts.opacity ?? 0.8 },
        // A puff is brightest while it is still at its birth size, so a pool of growing sprites
        // draws as bright dots with the dim giants nobody notices between them. `fadeIn` holds a
        // puff invisible until it has grown that share of its life. Measured on the MET 8 ascent
        // frame: the smoke pool's default 0.05 leaves the exhaust trail a dotted line (37 of 102
        // rows along it carry no smoke at all), 0.14 makes it continuous (5 of 102). It does not,
        // on its own, stop the trail reading as separate puffs — see the note on the wake in
        // main.js's seedPlumes. 0.05 is the historical constant for every other pool.
        uFadeIn: { value: opts.fadeIn ?? 0.05 },
        uPixelRatio: { value: 1 },
        uMaxSize: { value: opts.maxSize ?? 52 },
        // Where the sprite's alpha stops being flat and starts ramping to the rim, in point-coord
        // units. 0.14 is the historical shape: a disc is solid out to 28 % of its radius, so a pile
        // of overlapping discs prints one crisp circle per puff — which is what made the launch cloud
        // read as balloons rather than smoke. Measured, not tasted: halving uOpacity left every
        // outline exactly as sharp (band contrast 21.5 against 33.0, correlation 0.956), so the
        // defect lives in the profile, not in the amplitude. A pool whose sprites are a *volume*
        // wants the ramp to start at the centre; a mote wants the flat dot.
        uInner: { value: opts.inner ?? 0.14 },
        uNearFade: { value: opts.nearFade ?? 2.6 },
        // Pixels-per-metre over focal length, in CSS pixels: `aSize * uFocal / dist` is a pinhole
        // camera, so a pool whose `aSize` really is metres draws at its real angular size. 160 is the
        // historical literal and it is *not* a focal length — this rig's is 837 at the driving fov —
        // so every pool left on the default draws each sprite 5.2x narrower than the metres it was
        // seeded with. For a mote that is a deliberate cheat (a 0.35 m grain of salt has to be visible
        // at 30 m or the storm is empty), and the sizes were frame-tuned under it, so it stays. For a
        // pool whose sprites are a volume it is the whole defect: a 4.5-10 m puff of exhaust drawn as a
        // 2 m dot over a 150 m pad is a scatter of specks, not a cloud, and no amount of re-seeding or
        // opacity fixes a size error by changing the count. `phys` opts the pool in; main.js then
        // writes the camera's actual focal every frame, because the fov animates.
        uFocal: { value: opts.focal ?? 160 },
      },
      transparent: true, depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = opts.renderOrder || 5;
    scene.add(this.points);
    this.pos = pos; this.life = life; this.sizeArr = size;
    this.size0 = new Float32Array(count);
    this.vel = new Float32Array(count * 3);
    this.ttl = new Float32Array(count);
    this.age = new Float32Array(count);
    this.grav = opts.gravity ?? -3.0;
    this.drag = opts.drag ?? 0.98;
    this.sizeGrow = opts.sizeGrow ?? 1;
    // Opted into a per-frame `uFocal` from the live camera — see the uniform's note.
    this.phys = opts.phys ?? false;
    // `advect` treats the wind argument as a target velocity in m/s rather than an
    // acceleration, which is what airborne dust actually does: it is carried, not pushed.
    this.advect = opts.advect ?? 0;
    this.floorAt = opts.floorAt || null;
    this.bounce = opts.bounce ?? 0;
    this.head = 0;
    this.geo = geo; this.mat = mat;
  }
  emit(x, y, z, vx, vy, vz, ttl, size) {
    const i = this.head; this.head = (this.head + 1) % this.count;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.ttl[i] = ttl; this.age[i] = 0; this.sizeArr[i] = size; this.size0[i] = size; this.life[i] = 0;
  }
  update(dt, windX = 0, windZ = 0, audioBoost = 0) {
    const { pos, vel, life, age, ttl, sizeArr, size0, grav, drag, count, sizeGrow, advect, floorAt, bounce } = this;
    for (let i = 0; i < count; i++) {
      if (life[i] >= 1) continue;
      age[i] += dt;
      const t = age[i] / ttl[i];
      if (t >= 1) { life[i] = 1; continue; }
      life[i] = t;
      const i3 = i * 3;
      vel[i3 + 1] += grav * dt * (1 + audioBoost);
      if (advect) {
        vel[i3] += (windX - vel[i3]) * advect * dt;
        vel[i3 + 2] += (windZ - vel[i3 + 2]) * advect * dt;
      } else {
        vel[i3] += windX * dt; vel[i3 + 2] += windZ * dt;
      }
      const d = Math.pow(drag, dt * 60);
      vel[i3] *= d; vel[i3 + 1] *= d; vel[i3 + 2] *= d;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      // Saltation is a hop, not a hover: the grain clips the dune, sheds its downward
      // velocity and skids on, which is the motion the eye reads as "sand rolling".
      if (floorAt) {
        const gy = floorAt(pos[i3], pos[i3 + 2]);
        if (pos[i3 + 1] < gy) {
          pos[i3 + 1] = gy;
          if (vel[i3 + 1] < 0) vel[i3 + 1] = -vel[i3 + 1] * bounce;
          vel[i3] *= 0.72; vel[i3 + 2] *= 0.72;
        }
      }
      // Growth is a share of the puff's own life, not of wall-clock seconds. The old line was
      // `sizeArr[i] *= 1 + (sizeGrow - 1) * dt`, which compounds once per *frame*, so a puff ended
      // at e^((sizeGrow-1)·ttl) times its birth size — and `ttl` spans 300× across the pools
      // (0.16 s for a spark, 10 s for the pad cloud). Measured live on the frame that reported this:
      // a 2.6 m cryo-steam puff (`sizeGrow: 2.9`, ttl 2.2-3.2 s) drew at up to 817 m across, and a
      // 4.5-10 m pad puff reached 14,857 m. Nothing looks like that; the vertex shader's pixel cap
      // clamps every one of them to exactly `uMaxSize`, so a cloud of long-lived sprites renders as
      // a set of identical discs — which is the string of pearls the MET 8 ascent frame showed under
      // the booster, and why no amount of re-seeding the trail removed it.
      sizeArr[i] = size0[i] * (1 + (sizeGrow - 1) * t);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aLife.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }
  setPixelRatio(r) { this.mat.uniforms.uPixelRatio.value = r; }
}

export function createFX(scene, quality) {
  const P = quality.particles;
  const fx = {};
  // `sizeGrow` reads as "how many times bigger a puff is when it dies", which is what every number
  // below is now. The pools whose look had already been frame-checked under the old per-second law
  // keep their old *end-of-life* size, converted as e^((sizeGrow-1)·ttl): dust 1.25@1.9 s → 1.6,
  // driftSmoke 1.5@2.6 s → 3.6, flame 1.25@0.22 s → 1.06, and the three storm layers 1.04 / 1.37 /
  // 3.1. `steam` and `smoke` are written literally instead, because converting them would have
  // preserved 173× and 1070× growth — the runaway the law produced for long-lived sprites.
  fx.dust = new ParticlePool(scene, Math.round(700 * P), { color0: 0xb98a5c, color1: 0x8a5c38, opacity: 0.26, gravity: -0.6, drag: 0.94, sizeGrow: 1.6, maxSize: 15, nearFade: 4.0 });
  fx.driftSmoke = new ParticlePool(scene, Math.round(400 * P), { color0: 0xa08264, color1: 0x6a4a34, opacity: 0.30, gravity: 0.2, drag: 0.95, sizeGrow: 3.6, maxSize: 20, nearFade: 4.0 });
  fx.spark = new ParticlePool(scene, Math.round(600 * P), { color0: 0xfff2b0, color1: 0xff5a10, opacity: 1, gravity: -9.8, drag: 0.985, additive: true, sizeGrow: 0.9 });
  // `phys`, and the reason is a reading off the probe rather than a taste: the launch camera sits
  // 98-130 m from the deck, the exhaust column it films projects 138 px (`plume().sheath[0].colPx`),
  // and this pool's 2.6-5.4 m sprites — sized off `mouth`, so already metres, like every other number
  // on the deck — drew 5-7 px through the 160 px-per-metre mote fudge. Three to five percent of the
  // column they are supposed to be flickering on, i.e. invisible; the identical defect that put
  // `fx.smoke` on `phys` ("11 px against a flame column that projects at 138"). On the real focal the
  // same sprites draw 14-21 px, 10-15 % of the column, which is the band where a puff reads as a
  // livening core rather than as a disc. `maxSize` 40 is above every reading the probe gives at the
  // launch range, so it is a guard for a camera that comes in close, not a clamp on this one, and
  // `nearFade` dissolves a sprite that gets within 2 m of the lens.
  fx.flame = new ParticlePool(scene, Math.round(1400 * P), { color0: 0xfff8e0, color1: 0xff4400, opacity: 1, gravity: 1.0, drag: 0.97, additive: true, sizeGrow: 1.06, phys: true, maxSize: 40, nearFade: 2.0 });
  // The launch spends this pool twice over at once: a wake behind the vehicle and an apron on the
  // deck under it. The old 1200·P cap (840 slots at standard quality) was already 67% consumed by
  // the wake alone — 567 live sprites measured at MET 15 — before the pad cloud asked for anything,
  // and a ring buffer that wraps under live particles strobes rather than dimming. The extra slots
  // cost tens of KB of attributes and one pass over idle entries per frame; nothing but the launch
  // fills them.
  // The one pool that is a *volume* rather than a mote, so it is the one pool whose sprites have to
  // overlap. Two measured numbers say they already do: along the exhaust trail the median gap between
  // neighbouring near-axis puffs is 0.52 m against a 10.8 px (about 9 m) drawn diameter, so 56 of 56
  // adjacent pairs overlap, and the MET 8 band averages 4.65 puffs deep. The cloud therefore was not
  // short of sprites — it was drawing each one as a flat-topped disc. Hence `inner: 0`, which takes
  // the plateau out of the profile, and *not* more opacity: halving `opacity` left every outline just
  // as crisp (band contrast 21.5 against 33.0, correlation 0.956). `fadeIn` 0.14 (against the 0.05
  // every other pool uses) is the other measured fix — at the default the same frame had 37 of 102
  // rows along the trail carrying no smoke at all; at 0.14 it has 5.
  // `phys` because every number this pool is seeded with is metres: a 4.5-10 m pad puff and a
  // mouth-fraction trail puff drawn through the mote fudge came out at 11 px against a flame column
  // that projects at 138, i.e. a 150 m pad carrying ~1,800 specks rather than one rolling mass. The
  // cap goes with it — the historical 52 px is a *mote* cap, and at the focal this pool now uses a
  // 26 m puff at the launch camera's widest measured range (165 m, read off `framing()` at MET 0.3)
  // wants 111 px. Left at 52 it would clamp the
  // whole cloud back to identical discs, which is the string-of-pearls defect the size law was
  // written to kill. 340 device px is half the frame's height: past that a puff is a fade, not a
  // shape, and `nearFade` dissolves what gets closer to the lens than that anyway.
  fx.smoke = new ParticlePool(scene, Math.round(2400 * P), { color0: 0xd8c8bc, color1: 0x5a4a42, opacity: 0.26, gravity: 1.6, drag: 0.975, sizeGrow: 2.6, fadeIn: 0.14, inner: 0, phys: true, maxSize: 340 });
  // A near-white puff at 0.45 opacity over a dark deck drew as a cotton ball with a visible
  // polygon outline. Vapour off a cryo leak is loaded with suspended dust, so it is dim, warm-grey
  // and much larger by the time it leaves the plume.
  fx.steam = new ParticlePool(scene, Math.round(500 * P), { color0: 0xd9cabb, color1: 0x8d7f74, opacity: 0.20, gravity: 0.4, drag: 0.96, sizeGrow: 2.9 });
  // Two pools the launch deck needs and nothing else asks for. They are *not* the two pools that
  // already have the right colours, because both of those are mote pools: `fx.steam` draws through the
  // 160 px-per-metre fudge with a 52 px cap and `fx.dust` with a 15 px cap, so a puff seeded at its
  // real metres would clamp to a disc the moment the launch camera pulled back to its 98-165 m range
  // — the identical specks-not-a-cloud defect that put `fx.smoke` on `phys` in the first place.
  // Re-tuning the leak's or the wheels' pools to serve that scene would un-tune them; the launch
  // gets its own, seeded in metres like every other number on this deck.
  // Water deluge: the trench is flooded before ignition and the jet turns it to steam, so this is the
  // white mass at the mount while the smoke is the grey mass rolling out past it. It rises (gravity
  // +0.9, the only pool besides `smoke` that is buoyant) and it is the one place a near-white puff is
  // correct, because it really is water vapour rather than soot.
  // Why these pools are multi-scale, stated as the reading that can actually be re-taken:
  // `__RSB.plume().deck.<pool>.size`, which walks the live buffer and returns the alive sprites'
  // `aSize` quantiles — the CPU update rewrites `aSize` every frame, so those are the *current*
  // metres, not the seeded ones. A single-scale fill cannot produce a spread, so p10/p50/p90/max over
  // the live buffer *is* the test. An earlier note here claimed a column-mean of "mean R 167-191
  // across all sixteen columns" and that reading is not reproducible — averaging a horizontal band
  // across the frame pulls the terrain into the same number as the cloud, so it scores a flat sheet
  // and a good one identically. What the buffers hold now (quality 'std', the launch camera at its
  // 98 m closest / 130 m pulled back): deluge 3.76 / 7.38 / 12.14 / 15.37 m over 180 live sprites at
  // MET 4 and 4.08 / 8.74 / 14.88 / 21.83 m over 262 at MET 8; sandblast 3.72 / 6.83 / 10.36 /
  // 13.14 m over 180 and 4.57 / 7.81 / 12.66 / 17.76 m over 221. That is 4.1× → 5.4× of spread on
  // the deluge and 3.5× → 3.9× on the sand, against the ~2:1 band they were first seeded with.
  // Re-sampling the same sequence moves each digit by under a metre and the counts by seven sprites —
  // the claim being made is the ratio, not the digits. The structure a volume needs is *adjacent*
  // puffs differing in optical depth: two same-size puffs overlapping at any offset average to a flat
  // wash, while a 3 m puff inside a 12 m one leaves a visible core.
  // The other half of the contract, and the one that was being violated before these pools were
  // re-sized: the launch camera closes to 98 m at y 6-7 m, so a deck puff that reaches the lens draws
  // as a flat veil over the whole frame. The same probe carries `.nearest`, `.lt60` and `.pxMax` for
  // that — MET 2.5-8, no live sprite of any deck pool is inside 60 m of the lens (`lt60` is 0 in all
  // four, nearest reading 64.7 m) and the largest single sprite is 103 px of a 696 px frame. Treat "a
  // sprite over ~150 px within 60 m of the camera" as the failure this ceiling guards.
  // `flame` was the one deck pool left on the 160 px-per-metre fudge, which put it at 5-7 px against a
  // 138 px exhaust column — the flicker it exists to add was below one pixel of contrast per frame. It
  // is on `phys: true` now, and re-probed at the same MET 4.02 and the same dusk light: `.pxMax` reads
  // 23-24 px, i.e. ~0.13 of the column, so a sprite is a mouthful of the flame it is supposed to be
  // boiling rather than a speck on it.
  fx.deluge = new ParticlePool(scene, Math.round(1200 * P), { color0: 0xf3f1ee, color1: 0x9fa9b0, opacity: 0.33, gravity: 0.9, drag: 0.968, sizeGrow: 2.0, fadeIn: 0.10, inner: 0, phys: true, maxSize: 300, nearFade: 3.0 });
  // Sand swept out by the blast front, not smoke: it is a thin curtain riding *ahead* of the cloud,
  // low over the deck, warm-brown, and short-lived because the sand it is made of runs out. `inner`
  // stays off zero here — a dust curtain is a wall of fine grains, so a flatter profile reads closer
  // than a soft volume does, and at 3-6 m it is smaller than any neighbouring smoke puff anyway.
  // The curtain's colour is a measured choice, not a taste one. In the wide frame the bare sand
  // behind the cloud reads (120, 56, 60) and the sand-lifted deck reads (151, 108, 99): lifted, but
  // only by desaturation, so the curtain printed as "the ground is paler here" instead of as a wall
  // moving across it. Suspended martian dust is *brighter* than the regolith it lifts off (the fine
  // fraction is less iron-stained than the surface), so color0 is now well above the ground's own
  // red and the pair straddles it, which gives the front an edge against both the sand and the smoke.
  fx.sandblast = new ParticlePool(scene, Math.round(700 * P), { color0: 0xe0b489, color1: 0x8a5f3e, opacity: 0.40, gravity: -1.6, drag: 0.962, sizeGrow: 1.9, fadeIn: 0.08, inner: 0.05, phys: true, maxSize: 200, nearFade: 2.2 });
  // Three layers, not one sheet of static. A real dust storm is sorted by grain size: sand hopping
  // centimetres off the deck, silt in suspension, and fines high up moving slowly. Each layer gets
  // its own sprite scale, opacity and life so they separate in the frame instead of averaging into
  // one flat orange wash, and their wind multipliers follow the boundary layer — faster with height.
  const SP = quality.stormParticles;
  fx.salt = new ParticlePool(scene, Math.round(SP * 0.50), { color0: 0xdca869, color1: 0xa06f3c, opacity: 0.5, gravity: -2.4, drag: 0.996, sizeGrow: 1.04, maxSize: 26, nearFade: 1.1, advect: 1.0, bounce: 0.32 });
  fx.susp = new ParticlePool(scene, Math.round(SP * 0.34), { color0: 0xc08a52, color1: 0x8a5a2c, opacity: 0.30, gravity: -0.3, drag: 0.998, sizeGrow: 1.37, maxSize: 54, nearFade: 1.9, advect: 1.25 });
  fx.haze = new ParticlePool(scene, Math.round(SP * 0.16), { color0: 0xb27c48, color1: 0x8d6034, opacity: 0.10, gravity: -0.02, drag: 0.999, sizeGrow: 3.1, maxSize: 210, nearFade: 3.4, advect: 1.55 });
  Object.values(fx).forEach(p => p.setPixelRatio(1));
  return fx;
}

// `r` is the half-extent of the sampling box, `up` how far it is shoved upwind, and `y` gives the
// height above the deck in metres — `h` shapes that band so saltation hugs the ground while haze
// fills the sky. Sizes are in sprite units: the vertex shader divides by distance, so a mote has to
// be scaled for the range it is meant to read at, which is why the old pool's 0.3-0.8 units vanished
// into one or two pixels by the time it was 40 m out.
const STORM_LAYERS = [
  { key: 'salt', r: 34, up: 0.55, ttl: 3.4, size: [0.35, 1.2], y: [0.03, 0.9, 2.2], jit: 0.35, floor: true },
  { key: 'susp', r: 54, up: 0.65, ttl: 5.2, size: [1.4, 4.2], y: [0.9, 7.5, 1.7], jit: 1.4, floor: true },
  { key: 'haze', r: 96, up: 0.5, ttl: 8.0, size: [9.0, 30.0], y: [8.0, 30.0, 1.0], jit: 3.0, floor: false },
];

// Motes are seeded where the storm field actually says there is dust, then advected by its wind.
// The previous emitter drew a ring around the camera at a hard-coded +x velocity, so it painted dust
// across a clear sky, left the front edge bare, and blew every sprite out of frame in one hop.
export function updateStorm(fx, dt, cam, field, floorAt) {
  const gust = 1 + field.gustEnv * 0.55;
  const speed = field.speed * gust;
  const windX = field.wx * speed, windZ = field.wz * speed;
  for (const L of STORM_LAYERS) {
    const pool = fx[L.key];
    pool.floorAt = L.floor ? floorAt : null;
    // Steady state: a pool holds `count` motes of life `ttl`, so it needs count/ttl seeds a second.
    pool.acc = (pool.acc || 0) + (pool.count / L.ttl) * dt;
    let want = Math.floor(pool.acc);
    pool.acc -= want;
    // Rejection sampling wastes attempts in clear air; the cap keeps a bad frame from being long.
    let tries = want * 5 + 10;
    while (want > 0 && tries > 0) {
      tries--;
      // Square in wind-aligned coordinates, slid upwind, so the dust walks into the frame
      // instead of orbiting the lens.
      const along = (Math.random() * (1 + L.up) - L.up) * L.r;
      const cross = (Math.random() * 2 - 1) * L.r * 0.9;
      const x = cam.x + field.wx * along - field.wz * cross;
      const z = cam.z + field.wz * along + field.wx * cross;
      const d = field.local(x, z);
      if (d <= 0.02 || Math.random() > d) continue;
      want--;
      const gy = floorAt ? floorAt(x, z) : 0;
      const h = L.y[0] + Math.random() ** L.y[2] * (L.y[1] - L.y[0]);
      pool.emit(
        x, gy + h + (Math.random() - 0.5) * L.jit, z,
        windX * (0.6 + Math.random() * 0.5), (Math.random() - 0.35) * 1.4, windZ * (0.6 + Math.random() * 0.5),
        L.ttl * (0.6 + Math.random() * 0.7), L.size[0] + Math.random() * (L.size[1] - L.size[0]),
      );
    }
    pool.update(dt, windX, windZ, 0);
  }
}
