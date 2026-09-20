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
    // elastic chase: offset behind heading, rises & pulls back with speed
    const back = 9.6 + speed * 0.16, up = 4.1 + speed * 0.045 + this.raise;
    // the rig trails to the outside of a corner, so rotation reads as force instead of as a
    // pivot on rails — the single biggest difference between a car that feels driven and one
    // that feels glued
    const swing = THREE.MathUtils.clamp((vehicle.lateral || 0) * 0.22, -2.2, 2.2);
    let tx = vehicle.x - bx * back + rgtX * swing, tz = vehicle.z - bz * back + rgtZ * swing, ty = vehicle.y + up;
    let stiff = 3.4;
    if (this.air) {
      const a = this.air;
      tx += (a.x - tx) * a.w; ty += (a.y - ty) * a.w; tz += (a.z - tz) * a.w;
      stiff += a.w * 5;
    }
    this.pos.x += (tx - this.pos.x) * Math.min(1, dt * stiff);
    this.pos.z += (tz - this.pos.z) * Math.min(1, dt * stiff);
    this.pos.y += (ty - this.pos.y) * Math.min(1, dt * (stiff * 0.8));
    // props are unshaded from inside: a chase camera that ends up behind a silo
    // or a wreck fills the frame with backfaces, i.e. a black hole in the shot
    if (this.cols && !this.noClip) {
      for (let i = 0; i < this.cols.length; i++) {
        const c = this.cols[i];
        if (this.pos.y > (c.top !== undefined ? c.top : c.y + 42)) continue;
        let dx = this.pos.x - c.x, dz = this.pos.z - c.z;
        const rz = c.r + 1.8;
        let d = Math.hypot(dx, dz);
        if (d >= rz) continue;
        if (d < 0.001) { dx = -bx; dz = -bz; d = 1e-4; }
        const k = (rz - d) / d;
        this.pos.x += dx * k; this.pos.z += dz * k;
      }
    }
    const terrainY = vehicle.groundY !== undefined ? vehicle.groundY + 1.2 : -999;
    if (this.pos.y < terrainY) this.pos.y = terrainY;
    // look ahead of the rover
    const la = 4.5 + speed * 0.28;
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
    const targetFov = 60 + speed * 0.42 + this.fovAdd;
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 3);
    if (Math.abs(this.cam.fov - this.fov) > 0.01) { this.cam.fov = this.fov; this.cam.updateProjectionMatrix(); }
    this.rollTilt = (vehicle.roll || 0) * 0.5 + THREE.MathUtils.clamp((vehicle.lateral || 0) * 0.012, -0.12, 0.12);
  }
}
