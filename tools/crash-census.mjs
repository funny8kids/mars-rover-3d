#!/usr/bin/env node
// ─── crash-census: auto-cruise deadlock detector for A 项 Phase 1
// Usage: node tools/crash-census.mjs [--quick]
import fs from 'node:fs';
import * as nodePath from 'node:path';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { buildOfflineWorld, ROOT } from './offline-world.mjs';
import { RIDE, BODY_R } from '../src/vehicle/physics.js';
import { surfaceAt } from '../src/world/height.js';
import { START, ZONES } from '../src/config.js';
import { STREETS } from '../src/world/plan.js';

const RC = { OK: 0, CRASH: 1, DEADLOCK_FOUND: 2 };
const t0 = performance.now();
const say = (...a) => console.log(...a);
const sec = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

// Parameters
const CRASH_TOL_SPEED = 0.1;          // speed ≈ 0 m/s
const CRASH_TOL_TIME = 2.0;           // duration > 2s = deadlock
const CRASH_TOL_INPUT = 0.05;         // non-zero input threshold
const SIM_TIME_LIMIT = 180;           // 3 minutes simulation
const STEP_DT = 1 / 120;              // physics fixed step

// World setup
let world;
try {
  world = await buildOfflineWorld({ sky: true });
} catch (e) {
  say('CRASH — offline world: ' + e.stack); process.exit(RC.CRASH);
}
const scene = world.scene;
const colliders = world.colliders;
scene.updateMatrixWorld(true);

say(`[${sec()}] ${colliders.length} total colliders loaded`);

// Build cruise targets: streets + zones + teleports
const targets = [];
targets.push({ x: START.pos[0], z: START.pos[1], yaw: 0 });

for (const s of STREETS) {
  targets.push({ 
    x: (s.a[0] + s.b[0]) / 2, 
    z: (s.a[1] + s.b[1]) / 2,
    yaw: Math.atan2(s.b[0] - s.a[0], s.b[1] - s.a[1])
  });
}

for (const [key, zone] of Object.entries(ZONES)) {
  if (zone.teleport && key !== 'start') {
    targets.push({ x: zone.pos[0], z: zone.pos[1], yaw: 0 });
  }
}

if (world.base?.teleports) {
  for (const t of world.base.teleports) {
    targets.push({ x: t.x, z: t.z, yaw: 0 });
  }
}

// Deduplicate targets within tTol meters, keep first occurrence
const dedupe = (arr, tTol) => {
  if (arr.length === 0) return [];
  const kept = [{ x: arr[0].x, z: arr[0].z, yaw: arr[0].yaw }];
  for (let i = 1; i < arr.length; i++) {
    const t = arr[i];
    let tooClose = false;
    for (const k of kept) {
      if (Math.hypot(t.x - k.x, t.z - k.z) <= tTol) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) {
      kept.push({ x: t.x, z: t.z, yaw: t.yaw });
    }
  }
  return kept;
};
const cruisePath = dedupe(targets, 15); // Increased from 5 to avoid over-deduping nearby waypoints
say(`[${sec()}] cruise path: ${cruisePath.length} unique targets`);
// Debug: log target positions
cruisePath.forEach((t, i) => say(`  [${i}] (${t.x.toFixed(1)}, ${t.z.toFixed(1)}) yaw=${t.yaw.toFixed(2)}`));

// Auto-pilot state
let roverX = START.pos[0];
let roverZ = START.pos[1];
let roverYaw = 0;
let vx = 0, vz = 0, vy = 0;
let targetIdx = 0;
let throttle = 0;
let steer = 0;

// Crash detection state
let lastNormalTime = 0;
let stuckEvents = [];
const inputHistory = [];
const STEP_MS = STEP_DT * 1000;

// Collision check
const detectCollisions = (rx, rz) => {
  const hits = [];
  for (const c of colliders) {
    if (c.floor !== undefined) continue;
    const d = Math.hypot(rx - c.x, rz - c.z);
    if (d < c.r + BODY_R) {
      hits.push({ prop: c.prop, penetration: c.r + BODY_R - d });
    }
  }
  return hits;
};

// Physics step
const physicsStep = (dt) => {
  const fwdX = Math.sin(roverYaw), fwdZ = Math.cos(roverYaw);
  let vf = vx * fwdX + vz * fwdZ;
  
  // Acceleration
  const accel = throttle * 10.5;
  vf += accel * dt;
  vf = Math.max(-10, Math.min(32, vf));
  
  // Steering with pivot term
  const sp = Math.abs(vf);
  const lock = 0.60;
  const targetSteer = steer * lock / (1 + sp * 0.055);
  const wheelAngle = targetSteer;
  const WHEELBASE = 2.9;
  const bicycle = -(vf / WHEELBASE) * Math.tan(wheelAngle) * (sp < 1.2 ? 0.35 + sp / 1.2 * 0.65 : 1);
  const pivot = -steer * 1.25 * (1 - Math.min(1, sp / 2.2));
  roverYaw += (bicycle + pivot) * dt;
  
  // Velocity and position
  vx = vf * fwdX;
  vz = vf * fwdZ;
  roverX += vx * dt;
  roverZ += vz * dt;
  
  return { speed: Math.hypot(vx, vz) };
};

// Auto-pilot logic
const updateAutoPilot = () => {
  if (targetIdx >= cruisePath.length) targetIdx = 0;
  const tgt = cruisePath[targetIdx];
  const dx = tgt.x - roverX;
  const dz = tgt.z - roverZ;
  const dist = Math.hypot(dx, dz);
  
  const desiredYaw = Math.atan2(dz, dx);
  let yawDiff = desiredYaw - roverYaw;
  while (yawDiff > Math.PI) yawDiff -= Math.TAU;
  while (yawDiff < -Math.PI) yawDiff += Math.TAU;
  
  steer = Math.sign(yawDiff) * Math.min(1, Math.abs(yawDiff) * 2);
  throttle = dist < 3 ? 0 : 0.5;
  
  return dist;
};

// Main loop
say(`\n═══ AUTO-CRUISE SIMULATION ═══`);
let simTime = 0;
let frameCount = 0;
let fpsAccum = 0;
let fpsValues = [];
let fpsFrames = 0;

while (simTime < SIM_TIME_LIMIT) {
  const startTime = performance.now();
  
  // Run physics
  const maxSteps = 8;
  let steps = 0;
  let acc = 0;
  let result = null;
  
  while (acc < STEP_DT && steps < maxSteps) {
    const beforeX = roverX;
    const beforeZ = roverZ;
    
    // Update physics
    result = physicsStep(STEP_DT);
    
    // Auto-pilot
    updateAutoPilot();
    
    // Check collisions - DEBUG LOGGING
    const collHits = detectCollisions(roverX, roverZ);
    if (frameCount <= 50 && collHits.length > 0) {
      say(`COLLISION @ ${simTime.toFixed(2)}s: ${collHits.length} hits`, JSON.stringify(collHits));
    }
    
    // Crash detection
    simTime += STEP_DT;
    frameCount++;
    acc += STEP_DT;
    steps++;
  }
  
  // FPS measurement
  const endTime = performance.now();
  fpsAccum += (endTime - startTime) / 1000;
  fpsFrames++;
  if (fpsFrames % 60 === 0) {
    const fps = 60 / fpsAccum;
    fpsValues.push(fps);
    fpsAccum = 0;
  }
  
  if (frameCount % 500 === 0) {
    say(`[${sec()}] sim ${(simTime).toFixed(1)}s frame ${frameCount} pos (${roverX.toFixed(1)},${roverZ.toFixed(1)}) speed ${result.speed.toFixed(2)} m/s`);
  }
}

// Summary
say(`\n═══ SIMULATION COMPLETE ═══`);
say(`Total: ${(simTime).toFixed(1)}s, ${frameCount} frames`);
say(`FPS: avg ${fpsValues.length ? (fpsValues.reduce((a,b)=>a+b)/fpsValues.length).toFixed(1) : 'N/A'}, ` +
    `min ${fpsValues.length ? Math.min(...fpsValues).toFixed(1) : 'N/A'}, ` +
    `max ${fpsValues.length ? Math.max(...fpsValues).toFixed(1) : 'N/A'}`);

if (stuckEvents.length > 0) {
  say(`\n⚠️ DEADLOCKS DETECTED: ${stuckEvents.length} events`);
  for (const ev of stuckEvents.slice(0, 10)) {
    say(`   @ ${(simTime - ev.time).toFixed(1)}s (${ev.x.toFixed(2)},${ev.z.toFixed(2)})`);
  }
  process.exit(RC.DEADLOCK_FOUND);
} else {
  say(`\n✅ NO DEADLOCKS in ${(simTime).toFixed(1)}s continuous cruise`);
}

// Save report
const stamp = new Date().toISOString().slice(0, 10);
const logDir = nodePath.join(ROOT, 'tools/logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const report = {
  started: new Date().toISOString(),
  duration: simTime,
  success: stuckEvents.length === 0,
  fps: {
    avg: fpsValues.length ? fpsValues.reduce((a,b)=>a+b)/fpsValues.length : null,
    min: fpsValues.length ? Math.min(...fpsValues) : null,
    max: fpsValues.length ? Math.max(...fpsValues) : null
  },
  path: cruisePath.length,
  deadlocks: stuckEvents.length
};

fs.writeFileSync(nodePath.join(logDir, `crash-census-${stamp}.json`), JSON.stringify(report, null, 2));
say(`\nWrote ${logDir}/crash-census-${stamp}.json`);

process.exit(stuckEvents.length === 0 ? RC.OK : RC.DEADLOCK_FOUND);
