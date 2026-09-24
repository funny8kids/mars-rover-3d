import * as THREE from 'three';

export class ChaseCamera {
  constructor(camera) {
    this.cam = camera;
    this.pos = new THREE.Vector3(0, 8, -20);
    this.look = new THREE.Vector3();
    this.lookV = new THREE.Vector3();
    this.fov = 60;
    this.trauma = 0;
    this.aim = null;        // optional world point to favour over the rover
    this.aimW = 0;
    this.air = null;        // {x,y,z,w}: aerial camera station to blend the chase target toward
    this.raise = 0;
    this.fovAdd = 0;
    this.cols = null;
    this.noClip = false;
    // Per-frame record of the keep-out correction. §6 attributes a composition change to "the rig
    // retreats", and without naming *which* collider moved it that sentence cannot be checked — the
    // dodge is a second, independent reason for the subject to shrink, and it hides inside the same
    // distance number.
    this.dodge = { n: 0, max: 0, r: null, x: null, z: null };
    this.plan = null;       // last frame's requested back/up/la/stiff, for the composition rulers
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  setColliders(list) { this.cols = list; }
  snapTo(p) { this.pos.copy(p); }
  update(dt, vehicle, speed, traumaAdd) {
    this.trauma = Math.max(this.trauma, traumaAdd || 0);
    this.trauma = Math.max(0, this.trauma - dt * 1.1);
    const yaw = vehicle.yaw;
    const bx = Math.sin(yaw), bz = Math.cos(yaw);
    const rgtX = Math.cos(yaw), rgtZ = -Math.sin(yaw);
    // §6: the rig used to retreat *and* open its lens as speed rose, so accelerating swapped one
    // composition for another — measured on a 31.5 m straight: the rover went from 12.37 % of frame
    // height at 4 km/h to 6.45 % at 46 km/h (−38 %), with the horizon sliding ~8 rows down the shot.
    // 80 % of that was the dolly, 20 % the lens, and nothing pulled either back.
    // A chase camera should keep the shot and let the *world* move: the lens still opens (that is the
    // speed cue), but the rig now comes in by exactly tan(fov₀/2)/tan(fov/2) — the same factor the
    // subject's height is divided by — so the rover holds its size, and the eye height is derived
    // from that geometry instead of drifting up on its own, which is what pins the horizon row.
    const fovDrive = 60 + speed * 0.42;
    // one helper for both halves of the ratio so the two cannot drift apart: the first run of this
    // change wrote the rest term as tan(15°) instead of tan(30°) and drove the rig 5 m into the
    // rover's back bumper (dist 11.8 → 7.3 m, share 11.6 % → 19 %).
    const halfTan = deg => Math.tan(deg * Math.PI / 360);
    // look ahead of the rover, further the faster it runs — the subject stays behind the frame centre
    const la = 4.5 + speed * 0.28;
    let stiff = 3.4;
    if (this.air) stiff += this.air.w * 5;
    // The follow filter cannot keep up with a moving target: at steady speed the rig trails its own
    // aim point by speed/stiff — measured 3.95 m at 48 km/h — and that trail, not the pose design, is
    // what is left of §6's composition loss after the lens coupling (achieved distance = back + lag,
    // verified against `plan` frame by frame). Paying it back here means the *delivered* distance and
    // pitch are the designed ones: the camera still swims through a gear change, it just no longer sits
    // further from the rover the faster the player dares to drive.
    const lag = speed / stiff;
    const hold = 9.6 * halfTan(60) / halfTan(fovDrive);
    const back = Math.max(4.5, hold - lag);
    // 1.5 m is the height of the look point; 0.1844 = (4.1 − 1.5) / (9.6 + 4.5) reproduces the pose the
    // rig is tuned at, and using the achieved distance keeps the pitch — so the horizon holds its row.
    const up = 1.5 + (hold + la) * 0.1844 + this.raise;
    // the rig trails to the outside of a corner, so rotation reads as force instead of as a
    // pivot on rails — the single biggest difference between a car that feels driven and one
    // that feels glued
    const swing = THREE.MathUtils.clamp((vehicle.lateral || 0) * 0.22, -2.2, 2.2);
    let tx = vehicle.x - bx * back + rgtX * swing, tz = vehicle.z - bz * back + rgtZ * swing, ty = vehicle.y + up;
    if (this.air) {
      const a = this.air;
      tx += (a.x - tx) * a.w; ty += (a.y - ty) * a.w; tz += (a.z - tz) * a.w;
    }
    // What the rig *asked for* this frame, kept next to what the filter delivered. §6's composition
    // reading needs both: `dist` alone cannot tell "the design pulls back with speed" apart from
    // "an exponential follow trails a moving target by speed/stiff", and those want different fixes.
    this.plan = { back: +back.toFixed(2), up: +up.toFixed(2), la: +la.toFixed(2),
      stiff: +stiff.toFixed(2), lag: +(speed / stiff).toFixed(2) };
    this.pos.x += (tx - this.pos.x) * Math.min(1, dt * stiff);
    this.pos.z += (tz - this.pos.z) * Math.min(1, dt * stiff);
    this.pos.y += (ty - this.pos.y) * Math.min(1, dt * (stiff * 0.8));
    // props are unshaded from inside: a chase camera that ends up behind a silo
    // or a wreck fills the frame with backfaces, i.e. a black hole in the shot.
    // The keep-out has to scale with the thing that could fill the frame: a flat +1.8 m pad around a
    // 0.45 m mast kept the rig dodging 3 m down the lane every time it passed a lamp post, which is
    // the §6 composition break arriving through a side door (measured: dist 11 → 16.2 m, share
    // 12.5 % → 7.9 % between 32 and 39 km/h). A thin post cannot fill the frame; a 3 m silo can, and
    // for anything that wide the pad is the same 1.8 m it always was.
    if (this.cols && !this.noClip) {
      this.dodge.n = 0; this.dodge.max = 0;
      for (let i = 0; i < this.cols.length; i++) {
        const c = this.cols[i];
        if (this.pos.y > (c.top !== undefined ? c.top : c.y + 42)) continue;
        let dx = this.pos.x - c.x, dz = this.pos.z - c.z;
        const rz = c.r + THREE.MathUtils.clamp(c.r * 1.2, 0.35, 1.8);
        let d = Math.hypot(dx, dz);
        if (d >= rz) continue;
        if (d < 0.001) { dx = -bx; dz = -bz; d = 1e-4; }
        const k = (rz - d) / d;
        const push = Math.hypot(dx * k, dz * k);
        this.dodge.n++;
        if (push >= this.dodge.max) this.dodge = { n: this.dodge.n, max: +push.toFixed(2), r: c.r, x: +c.x.toFixed(1), z: +c.z.toFixed(1) };
        this.pos.x += dx * k; this.pos.z += dz * k;
      }
    } else { this.dodge.n = 0; this.dodge.max = 0; }
    const terrainY = vehicle.groundY !== undefined ? vehicle.groundY + 1.2 : -999;
    if (this.pos.y < terrainY) this.pos.y = terrainY;
    // look ahead of the rover
    this.look.set(vehicle.x + bx * la, vehicle.y + 1.5, vehicle.z + bz * la);
    if (this.aim && this.aimW > 0.001) this.look.lerp(this.aim, this.aimW);
    this.lookV.lerp(this.look, Math.min(1, dt * 6));
    // shake
    const s = this.trauma * this.trauma;
    const t = performance.now() * 0.001;
    const sx = Math.sin(t * 61.3) * 0.4 * s, sy = Math.sin(t * 83.7) * 0.4 * s, sz = Math.cos(t * 71.1) * 0.3 * s;
    this.cam.position.set(this.pos.x + sx, this.pos.y + sy, this.pos.z + sz);
    this.cam.up.set(Math.sin(this.rollTilt || 0) * 0.06, 1, 0).normalize();
    this.cam.lookAt(this.lookV.x + sx * 0.5, this.lookV.y + sy * 0.5, this.lookV.z);
    // `fovAdd` is the launch track's own widening (up to +26°): deliberately kept out of `fovDrive`,
    // or holding the subject's size would yank the rig 4 m forward at the exact moment the ship needs
    // a wide shot.
    const targetFov = fovDrive + this.fovAdd;
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 3);
    if (Math.abs(this.cam.fov - this.fov) > 0.01) { this.cam.fov = this.fov; this.cam.updateProjectionMatrix(); }
    this.rollTilt = (vehicle.roll || 0) * 0.5 + THREE.MathUtils.clamp((vehicle.lateral || 0) * 0.012, -0.12, 0.12);
  }
}
