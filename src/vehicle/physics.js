import { surfaceAt } from '../world/height.js';

const G = 3.71;         // Mars gravity
const MAX_SPEED = 32;   // m/s (~115 km/h cinematic)
const RIDE = 0.46;      // wheel radius → body ground clearance reference
const RHO = 0.020;      // kg/m³ — mean Martian surface density, 1.6% of Earth's air
const CD_A = 1.9;       // m²·Cd for the boxy chassis and its mirror-flat solar deck
const MASS = 260;       // kg

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
    this.wheelAngle = 0;      // realised front-wheel angle (rad), driven toward a speed-scaled target
    this.longAcc = 0;         // m/s², feeds the visual nose dive/squat
    this.windLoad = 0;        // m/s² the air is actually paying the chassis this substep
    this.windSoft = 0;        // 0..1 dust under the wheels — the term the storm drives through
    this.bodyRoll = 0; this.bodyPitch = 0;   // chassis lean from lateral / longitudinal G
    this._acc = 0;            // fixed-step accumulator
  }
  // Fixed 120 Hz integration: the feel must not change between a 60 Hz laptop and a stuttering
  // frame, and a surface-locked rig that is stepped with a variable dt is exactly what makes an
  // arcade car twitch.
  update(dt, inp, colliders, wind) {
    this._acc += Math.min(dt, 0.25);
    const h = 1 / 120;
    let n = 0;
    while (this._acc >= h && n < 8) { this.step(h, inp, colliders, wind); this._acc -= h; n++; }
    if (n === 8) this._acc = 0;
    this.trauma = Math.max(0, this.trauma - Math.min(dt, 0.25) * 1.4);
    return this;
  }
  step(dt, inp, colliders, wind) {
    const fwdX = Math.sin(this.yaw), fwdZ = Math.cos(this.yaw);
    const rgtX = Math.cos(this.yaw), rgtZ = -Math.sin(this.yaw);
    let vf = this.vx * fwdX + this.vz * fwdZ;
    let vl = this.vx * rgtX + this.vz * rgtZ;

    // The weather hands the vehicle two things: the air load carried on the chassis, and the dust
    // bedded down under the wheels. The first is a force, so it is built from the *relative* air
    // velocity — which is why the mass, area and density live here and not in the caller.
    const soft = wind ? wind.soft : 0;
    let ax = 0, az = 0;
    if (wind) {
      const rx = wind.vx - this.vx, rz = wind.vz - this.vz;
      const q = 0.5 * RHO * CD_A / MASS * Math.hypot(rx, rz);   // ½ρ|v|CdA/m, ×v gives m/s²
      ax = q * rx; az = q * rz;
    }
    this.windLoad = Math.hypot(ax, az);
    this.windSoft = soft;

    // drive / brake
    const braking = inp.brake > 0.05 && vf > 0.6;
    let accel = 0;
    if (!braking) {
      const t = inp.gas > 0 ? inp.gas : (inp.brake > 0 ? -0.6 : 0);
      accel = t * (t > 0 ? 10.5 : 8) * Math.max(0.25, 1 - Math.abs(vf) / MAX_SPEED);
      // Rolling backwards is a state the collision response hands you, never a direction the
      // player selects, so throttle must RECOVER from it. The -14 this line used to carry turned
      // every bump into a permanent 10 m/s reverse that no key could cancel: hit a wall, hold W,
      // and the rover drove away from you at full lock with the steering mirrored.
      if (inp.gas > 0 && vf < -0.4) accel = 14;             // brake out of the slide, then drive
      if (inp.brake > 0 && vf > 0.6) accel = -16;           // service brake
    }
    this.enginePower = Math.abs(accel) / 10.5;
    this.longAcc = accel;
    vf += accel * dt;
    if (braking) vf = Math.max(0, vf - 18 * dt);
    // rolling drag. On Mars the air cannot slow a rover — see the load note below — but what a
    // storm does to the *surface* it rolls on can: suspended regolith and the film it leaves on the
    // dune faces is the same talc that made Opportunity's wheels spin in a dust-filled ripple. The
    // term is a rate on speed, so it costs nothing at rest and cannot park a rover on a slope.
    vf *= Math.exp(-(0.35 + 0.30 * soft) * dt);
    if (Math.abs(vf) < 0.02 && !accel) vf = 0;
    vf = Math.max(-10, Math.min(MAX_SPEED, vf));

    // steering: a realised wheel angle, not an instant yaw rate. Target angle narrows with
    // speed (so full lock still spins the rover in place) and yaw comes from the bicycle
    // equation, which is what makes the arc feel connected to the stick.
    const sp = Math.abs(vf);
    const lock = 0.60;
    const target = inp.steer * lock / (1 + sp * 0.055) * (sp < 4 ? 1 + (4 - sp) * 0.16 : 1);
    this.wheelAngle += (Math.max(-lock, Math.min(lock, target)) - this.wheelAngle) * Math.min(1, 9 * dt);
    const WHEELBASE = 2.9;
    // The bicycle term is proportional to forward speed, so a rover parked nose-first against a
    // collider has no yaw authority at all — the exact state a bump leaves you in. Below ~2.2 m/s
    // the tyres scrub instead of rolling, so steering is given a pivot term to keep A/D alive.
    const bicycle = -(vf / WHEELBASE) * Math.tan(this.wheelAngle) * (sp < 1.2 ? 0.35 + sp / 1.2 * 0.65 : 1);
    const pivot = -inp.steer * 1.25 * (1 - Math.min(1, sp / 2.2));
    let yawRate = bicycle + pivot;
    this.yaw += yawRate * dt;

    // lateral grip — low on Mars, lower with handbrake → drift, and lower still with dust under the
    // tyres: at full load the 4.6 s⁻¹ that sets the break-away line is down to 3.2, so a corner taken
    // at the same speed inside a front slides where the same corner outside one bites.
    const grip = (inp.drift > 0 ? 0.7 : 4.6) * (1 - 0.30 * soft);
    vl *= Math.exp(-grip * dt);
    if (inp.drift > 0) vl += -inp.steer * vf * 0.55 * dt;    // kick-slide
    this.drifting = Math.abs(vl) > 2.4 && Math.abs(vf) > 4;
    this.lateral = vl;

    // The air load, integrated as the force it is. Measured, not decorated: ½ρCdA/m at 0.020 kg/m³,
    // 1.9 m²·Cd and 260 kg is 7.3e-5, so a 25 m/s front reaches 0.046 m/s² — 0.4 % of the 10.5 m/s²
    // a throttle starts at, and a sixth of the rover's own rolling drag. That is the real number for
    // real Martian air, and the honest conclusion is that wind cannot push this rover anywhere: it
    // biases a coast downhill by a few metres over a minute and nothing more. So it is applied
    // straight, with no gain in front of it, and the storm's cost to the driver is paid through the
    // surface terms above. Measured against the parked-rover case this replaced: an earlier version
    // relaxed `vf` toward the wind's *velocity* at 1.9 s⁻¹, which reads to the driver as a 26 m/s
    // headwind being a handbrake, and capped full throttle at 4 m/s.
    vf += (ax * fwdX + az * fwdZ) * dt;
    vl += (ax * rgtX + az * rgtZ) * dt;

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
    // chassis lean that a surface normal alone cannot give: outside wheels unload in a corner,
    // the nose dives under braking and squats under throttle.
    const latG = yawRate * vf;
    this.bodyRoll += ((-latG * 0.028) - this.bodyRoll) * Math.min(1, dt * 6);
    this.bodyPitch += ((accel * 0.0075) - this.bodyPitch) * Math.min(1, dt * 5);

    // collisions (cylinders {x,z,r}); platforms are driveable, so they never shove you aside.
    // Two props standing closer than the rover's clearance leave overlapping clearance rings, and a
    // rover caught in that band used to be thrown from one ring to the other every substep — 1.3 m
    // of jitter with the speedometer pinned at zero, which is exactly what reads to the player as
    // "WASD stopped working". So each pass sums every violated normal into a single correction the
    // rover can follow, and hands the leftover penetration back as push-out velocity: a nose-in
    // rover in a crease squeezes itself out under throttle instead of standing still inside it.
    for (let pass = 0; pass < 3; pass++) {
      let mx = 0, mz = 0, deep = null;
      for (const c of colliders) {
        if (c.floor !== undefined) continue;
        const dx = this.x - c.x, dz = this.z - c.z;
        const d = Math.hypot(dx, dz), min = c.r + 1.6;
        if (d >= min) continue;
        if (d <= 0.001) { mx += min; continue; }
        const push = min - d, nx = dx / d, nz = dz / d;
        mx += nx * push; mz += nz * push;
        if (!deep || push > deep.push) deep = { push, nx, nz };
      }
      if (!deep && mx === 0) break;
      this.x += mx; this.z += mz;
      if (pass > 0) continue;
      if (deep) {
        const vn2 = this.vx * deep.nx + this.vz * deep.nz;
        // Restitution 0.18, not 0.6: the old factor handed back more speed than the rover brought,
        // so every contact fired it backwards at 1.6× impact — straight into the slide the
        // throttle then had to recover from. A thud and a slide along the tangent is what reads as
        // solid steel, and it keeps the rover under the player instead of launching it.
        if (vn2 < 0) { this.vx -= deep.nx * vn2 * 1.18; this.vz -= deep.nz * vn2 * 1.18; this.trauma = Math.min(1, this.trauma + Math.abs(vn2) * 0.04); }
        const l = Math.hypot(mx, mz);
        if (l > 0.02) { const s = Math.min(3.2, deep.push * 9) / l; this.vx += mx * s; this.vz += mz * s; }
      }
    }
    // world bounds
    const rr = Math.hypot(this.x, this.z);
    if (rr > 1180) { const s = 1180 / rr; this.x *= s; this.z *= s; this.vx *= 0.5; this.vz *= 0.5; }
  }
  // The mesh root sits at the contact point (wheel centres hang exactly one radius above it), so
  // the heave term may lift the body but must never drop the reference under the drawn ground.
  pose() { return { x: this.x, y: Math.max(this.y - RIDE + this.susp, this.groundY), z: this.z, yaw: this.yaw, pitch: this.pitch + this.bodyPitch, roll: this.roll + this.bodyRoll }; }
}
