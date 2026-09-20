import { surfaceAt } from '../world/height.js';

const G = 3.71;         // Mars gravity
const MAX_SPEED = 32;   // m/s (~115 km/h cinematic)
const RIDE = 0.46;      // wheel radius → body ground clearance reference

// Props may publish a driveable platform as a collider `{x, z, r, floor}`. The last 3 m of
// its radius ramp from terrain up to the deck, so a low pad reads as a curb you roll onto
// instead of a step you pop through.
export function platformAt(colliders, x, z) {
  const terrain = surfaceAt(x, z);
  if (!colliders) return terrain;
  let h = terrain;
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (c.floor === undefined) continue;
    const d = Math.hypot(x - c.x, z - c.z);
    if (d >= c.r) continue;
    const v = terrain + (c.floor - terrain) * Math.min(1, (c.r - d) / 3);
    if (v > h) h = v;
  }
  return h;
}

// Surface-locked arcade-sim vehicle: it rides the exact triangles the terrain mesh draws, so
// the wheels can never sink under the visible ground or float above it.
export class RoverPhysics {
  constructor(x, z, heading) {
    this.x = x; this.z = z;
    this.y = surfaceAt(x, z) + RIDE;
    this.vy = 0;
    this.yaw = heading;
    this.vx = 0; this.vz = 0;              // world-space horizontal velocity
    this.grounded = true;
    this.susp = 0; this.suspV = 0;         // body heave spring
    this.pitch = 0; this.roll = 0;
    this.speed = 0; this.lateral = 0; this.drifting = false;
    this.trauma = 0;
    this.enginePower = 0;
    this.groundY = this.y - RIDE;
    this.prevGroundH = this.y;
    this.onFloor = false;
  }
  update(dt, inp, colliders) {
    dt = Math.min(dt, 1 / 30);
    const fwdX = Math.sin(this.yaw), fwdZ = Math.cos(this.yaw);
    const rgtX = Math.cos(this.yaw), rgtZ = -Math.sin(this.yaw);
    let vf = this.vx * fwdX + this.vz * fwdZ;
    let vl = this.vx * rgtX + this.vz * rgtZ;

    // drive / brake
    const throttle = inp.gas - inp.brake * (vf > 0.5 ? 0 : 1) - Math.max(0, -inp.brake) * 0;
    const braking = inp.brake > 0 && vf > 0.5;
    let accel = 0;
    if (!braking) {
      const t = inp.gas > 0 ? inp.gas : (inp.brake > 0 ? -0.6 : 0);
      accel = t * (t > 0 ? 10.5 : 8) * Math.max(0.25, 1 - Math.abs(vf) / MAX_SPEED);
      if (inp.gas > 0 && vf < -0.5) accel = -14;            // brake while reversing
      if (inp.brake > 0 && vf > 0.5) accel = -16;           // service brake
    }
    this.enginePower = Math.abs(accel) / 10.5;
    vf += accel * dt;
    if (braking) vf = Math.max(0, vf - 18 * dt);
    // rolling drag
    vf *= Math.exp(-0.35 * dt);
    if (Math.abs(vf) < 0.02 && !accel) vf = 0;
    vf = Math.max(-10, Math.min(MAX_SPEED, vf));

    // steering (speed-scaled)
    const steerCap = Math.min(1, 5.5 / (Math.abs(vf) * 0.42 + 2.2));
    const dirSign = vf >= 0 ? 1 : -1;
    this.yaw += inp.steer * 1.75 * steerCap * dt * dirSign * (inp.drift > 0 ? 1.35 : 1);

    // lateral grip — low on Mars, lower with handbrake → drift
    const grip = inp.drift > 0 ? 0.7 : 4.6;
    vl *= Math.exp(-grip * dt);
    if (inp.drift > 0) vl += -inp.steer * vf * 0.55 * dt;    // kick-slide
    this.drifting = Math.abs(vl) > 2.4 && Math.abs(vf) > 4;
    this.lateral = vl;

    // slope gravity projection
    const e = 0.8;
    const sl = this.onFloor ? 0 : 1;   // a flat deck must not make the rover slide off itself
    const gx = ((surfaceAt(this.x + e, this.z) - surfaceAt(this.x - e, this.z)) / (2 * e)) * sl;
    const gz = ((surfaceAt(this.x, this.z + e) - surfaceAt(this.x, this.z - e)) / (2 * e)) * sl;
    // static friction: an unattended rover parks instead of creeping downhill into a wall
    const hold = this.grounded && !inp.gas && !inp.brake && Math.abs(inp.steer) < 0.06
      && this.speed < 1.4 && Math.hypot(gx, gz) < 0.6;
    const sg = hold ? 0 : G * 0.85 * dt;
    vf += (-gx * fwdX - gz * fwdZ) * sg;
    vl += (-gx * rgtX - gz * rgtZ) * sg;
    if (hold) { vf *= Math.exp(-7 * dt); vl *= Math.exp(-7 * dt); }

    // world velocity + integrate
    this.vx = vf * fwdX + vl * rgtX;
    this.vz = vf * fwdZ + vl * rgtZ;
    this.x += this.vx * dt; this.z += this.vz * dt;
    this.speed = Math.hypot(this.vx, this.vz);

    // vertical: grounded spring or ballistic
    this.groundY = platformAt(colliders, this.x, this.z);
    this.onFloor = this.groundY > surfaceAt(this.x, this.z) + 0.05;
    const groundH = this.groundY + RIDE;
    if (this.grounded) {
      if (this.y - groundH > 0.30 && this.vy <= 0) { this.grounded = false; }
      else {
        const k = 46, c = 8.5;
        // Damp the *relative* vertical velocity. Against a fixed target this spring feels the same,
        // but the ground under a moving rover is a ramp, and a spring tracking a ramp keeps a
        // steady-state lag of 2ζ·v/ω ≈ 0.19·v: at 14 m/s up a 15° crater wall (v≈3.6 m/s) that is
        // 0.6 m of chassis below the triangles the terrain actually draws.
        const gvy = Math.max(-8, Math.min(8, (groundH - this.prevGroundH) / dt));
        this.vy += (groundH - this.y) * k * dt - (this.vy - gvy) * c * dt;
        this.y += this.vy * dt;
        // hard guarantee, whatever the input does: the reference may chase the ground but never
        // cross it, because the wheels hang below this origin by exactly their own radius.
        if (this.y < groundH) { this.y = groundH; this.vy = Math.max(this.vy, gvy); }
        if (Math.abs(this.vy - gvy) > 2.2) this.trauma = Math.min(1, this.trauma + Math.abs(this.vy - gvy) * 0.04);
      }
    }
    this.prevGroundH = groundH;
    if (!this.grounded) {
      this.vy -= G * dt;
      this.y += this.vy * dt;
      if (this.y <= groundH) {
        this.y = groundH; this.grounded = true;
        if (this.vy < -4) this.trauma = Math.min(1, this.trauma + -this.vy * 0.06);
        this.vy = 0;
      }
    }
    // body heave visual wobble from terrain bumps
    this.suspV += ((-this.vy * 0.1) - this.susp) * 40 * dt - this.suspV * 6 * dt;
    this.susp += this.suspV * dt;

    // orientation follows terrain normal (pitch/roll), smoothed and clamped — a steep
    // dune wall must not tip the rover into a 40° lean that reads as a rollover
    const tiltX = -gz, tiltZ = gx;
    const cosY = Math.cos(this.yaw), sinY = Math.sin(this.yaw);
    const limb = a => Math.max(-0.40, Math.min(0.40, a));
    const targetPitch = limb(tiltZ * cosY - tiltX * sinY);
    const targetRoll = limb(-(tiltX * cosY + tiltZ * sinY));
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 7);
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 7);

    // collisions (cylinders {x,z,r}); platforms are driveable, so they never shove you aside
    for (const c of colliders) {
      if (c.floor !== undefined) continue;
      const dx = this.x - c.x, dz = this.z - c.z;
      const d = Math.hypot(dx, dz), min = c.r + 1.6;
      if (d < min && d > 0.001) {
        const push = (min - d);
        this.x += dx / d * push; this.z += dz / d * push;
        const vn2 = (this.vx * dx + this.vz * dz) / d;
        if (vn2 < 0) { this.vx -= dx / d * vn2 * 1.6; this.vz -= dz / d * vn2 * 1.6; this.trauma = Math.min(1, this.trauma + Math.abs(vn2) * 0.04); }
      }
    }
    // world bounds
    const rr = Math.hypot(this.x, this.z);
    if (rr > 1180) { const s = 1180 / rr; this.x *= s; this.z *= s; this.vx *= 0.5; this.vz *= 0.5; }
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    return this;
  }
  // The mesh root sits at the contact point (wheel centres hang exactly one radius above it), so
  // the heave term may lift the body but must never drop the reference under the drawn ground.
  pose() { return { x: this.x, y: Math.max(this.y - RIDE + this.susp, this.groundY), z: this.z, yaw: this.yaw, pitch: this.pitch, roll: this.roll }; }
}
