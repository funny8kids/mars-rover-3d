import * as THREE from 'three';

const VS = `
attribute float aLife; attribute float aSize;
uniform float uPixelRatio, uMaxSize, uNearFade;
varying float vLife;
varying float vNear;
void main(){
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position,1.0);
  float dist = max(-mv.z, 1.0);
  // Uncapped, a mote 1 m from the lens covers the whole screen; the DOF pass then smears it
  // into a flat orange disc that dominates the frame. Clamp the sprite and dissolve it near.
  gl_PointSize = min(aSize * (160.0 / dist), uMaxSize) * uPixelRatio;
  vNear = smoothstep(uNearFade * 0.3, uNearFade, dist);
  gl_Position = projectionMatrix * mv;
}`;
const FS = `
precision mediump float;
varying float vLife;
varying float vNear;
uniform vec3 uColor0, uColor1;
uniform float uOpacity, uFadeIn;
void main(){
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  float a = smoothstep(0.5, 0.14, d) * vNear;
  if (a <= 0.001 || vLife >= 1.0 || vLife < 0.0) discard;
  float t = vLife;
  vec3 c = mix(uColor0, uColor1, t);
  float fade = mix(smoothstep(0.0, uFadeIn, t), 1.0 - t, step(0.0, uFadeIn - 0.5) * 0.0 + 1.0);
  fade = (1.0 - t) * smoothstep(0.0, 0.05, t);
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
        uFadeIn: { value: 0 },
        uPixelRatio: { value: 1 },
        uMaxSize: { value: opts.maxSize ?? 52 },
        uNearFade: { value: opts.nearFade ?? 2.6 },
      },
      transparent: true, depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = opts.renderOrder || 5;
    scene.add(this.points);
    this.pos = pos; this.life = life; this.sizeArr = size;
    this.vel = new Float32Array(count * 3);
    this.ttl = new Float32Array(count);
    this.age = new Float32Array(count);
    this.grav = opts.gravity ?? -3.0;
    this.drag = opts.drag ?? 0.98;
    this.sizeGrow = opts.sizeGrow ?? 1;
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
    this.ttl[i] = ttl; this.age[i] = 0; this.sizeArr[i] = size; this.life[i] = 0;
  }
  update(dt, windX = 0, windZ = 0, audioBoost = 0) {
    const { pos, vel, life, age, ttl, sizeArr, grav, drag, count, sizeGrow, advect, floorAt, bounce } = this;
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
      sizeArr[i] *= 1 + (sizeGrow - 1) * dt;
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
  fx.dust = new ParticlePool(scene, Math.round(700 * P), { color0: 0xb98a5c, color1: 0x8a5c38, opacity: 0.26, gravity: -0.6, drag: 0.94, sizeGrow: 1.25, maxSize: 15, nearFade: 4.0 });
  fx.driftSmoke = new ParticlePool(scene, Math.round(400 * P), { color0: 0xa08264, color1: 0x6a4a34, opacity: 0.30, gravity: 0.2, drag: 0.95, sizeGrow: 1.5, maxSize: 20, nearFade: 4.0 });
  fx.spark = new ParticlePool(scene, Math.round(600 * P), { color0: 0xfff2b0, color1: 0xff5a10, opacity: 1, gravity: -9.8, drag: 0.985, additive: true, sizeGrow: 0.9 });
  fx.flame = new ParticlePool(scene, Math.round(1400 * P), { color0: 0xfff8e0, color1: 0xff4400, opacity: 1, gravity: 1.0, drag: 0.97, additive: true, sizeGrow: 1.25 });
  fx.smoke = new ParticlePool(scene, Math.round(1200 * P), { color0: 0xd8c8bc, color1: 0x5a4a42, opacity: 0.5, gravity: 1.6, drag: 0.975, sizeGrow: 1.9 });
  // A near-white puff at 0.45 opacity over a dark deck drew as a cotton ball with a visible
  // polygon outline. Vapour off a cryo leak is loaded with suspended dust, so it is dim, warm-grey
  // and much larger by the time it leaves the plume.
  fx.steam = new ParticlePool(scene, Math.round(500 * P), { color0: 0xd9cabb, color1: 0x8d7f74, opacity: 0.20, gravity: 0.4, drag: 0.96, sizeGrow: 2.9 });
  // Three layers, not one sheet of static. A real dust storm is sorted by grain size: sand hopping
  // centimetres off the deck, silt in suspension, and fines high up moving slowly. Each layer gets
  // its own sprite scale, opacity and life so they separate in the frame instead of averaging into
  // one flat orange wash, and their wind multipliers follow the boundary layer — faster with height.
  const SP = quality.stormParticles;
  fx.salt = new ParticlePool(scene, Math.round(SP * 0.50), { color0: 0xdca869, color1: 0xa06f3c, opacity: 0.5, gravity: -2.4, drag: 0.996, sizeGrow: 1.01, maxSize: 26, nearFade: 1.1, advect: 1.0, bounce: 0.32 });
  fx.susp = new ParticlePool(scene, Math.round(SP * 0.34), { color0: 0xc08a52, color1: 0x8a5a2c, opacity: 0.30, gravity: -0.3, drag: 0.998, sizeGrow: 1.06, maxSize: 54, nearFade: 1.9, advect: 1.25 });
  fx.haze = new ParticlePool(scene, Math.round(SP * 0.16), { color0: 0xb27c48, color1: 0x8d6034, opacity: 0.10, gravity: -0.02, drag: 0.999, sizeGrow: 1.14, maxSize: 210, nearFade: 3.4, advect: 1.55 });
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
