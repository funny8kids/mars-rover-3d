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
    const { pos, vel, life, age, ttl, sizeArr, grav, drag, count, sizeGrow } = this;
    for (let i = 0; i < count; i++) {
      if (life[i] >= 1) continue;
      age[i] += dt;
      const t = age[i] / ttl[i];
      if (t >= 1) { life[i] = 1; continue; }
      life[i] = t;
      const i3 = i * 3;
      vel[i3 + 1] += grav * dt * (1 + audioBoost);
      vel[i3] += windX * dt; vel[i3 + 2] += windZ * dt;
      const d = Math.pow(drag, dt * 60);
      vel[i3] *= d; vel[i3 + 1] *= d; vel[i3 + 2] *= d;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
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
  fx.storm = new ParticlePool(scene, Math.round(quality.stormParticles), { color0: 0xc88a52, color1: 0x96612f, opacity: 0.3, gravity: 0, drag: 0.999, sizeGrow: 1, maxSize: 12, nearFade: 5 });
  fx.storm2 = new ParticlePool(scene, Math.round(quality.stormParticles * 0.4), { color0: 0xa06a3a, color1: 0x7a4a26, opacity: 0.42, gravity: 0, drag: 0.999, sizeGrow: 1, maxSize: 18, nearFade: 5 });
  Object.values(fx).forEach(p => p.setPixelRatio(1));
  return fx;
}

// storm particles swirl around the camera
export function updateStorm(fx, dt, cam, stormF, windT, audioLevel) {
  if (stormF < 0.02) return;
  const N = Math.min(60, Math.round(40 * stormF));
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 46;
    fx.storm.emit(
      cam.x + Math.cos(a) * r, cam.y + 2 + Math.random() * 14 - stormF * 4, cam.z + Math.sin(a) * r,
      14 + Math.sin(windT) * 6, (Math.random() - 0.5) * 1.5, Math.cos(windT * 0.7) * 8,
      2.5 + Math.random() * 2, (0.3 + Math.random() * 0.5) * (1 + audioLevel)
    );
  }
  fx.storm.update(dt, 6 * stormF, 2, 0);
  fx.storm2.update(dt, 6 * stormF, 2, 0);
}
