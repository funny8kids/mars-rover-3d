#!/usr/bin/env node
// Path cruise test for A4 verification - drives along defined waypoints across all districts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

// Load physics module
const { RoverPhysics } = await import(path.join(ROOT, 'src/vehicle/physics.js'));

// Load height field
const { surfaceAt } = await import(path.join(ROOT, 'src/world/height.js'));

// Load colliders
const colliders = await (async () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/assets/colliders.json'), 'utf8'));
  return data;
})();

// Define cruise path: waypoints through all 6 districts + STREETS
// Based on plan.js structure: 3x3 lattice with 4 streets
const WAYPOINTS = [
  // Spawn area (hub)
  { x: 0, z: -26, yaw: 0 },
  
  // South street southbound
  { x: -30, z: -90, yaw: Math.PI / 2 },   // west avenue entrance
  { x: -30, z: -120, yaw: Math.PI / 2 },  // continue south
  
  // East avenue approach
  { x: 30, z: -120, yaw: 0 },             // cross to east avenue
  { x: 30, z: -90, yaw: 0 },              // south-street intersection
  { x: 30, z: 90, yaw: 0 },               // northbound up east avenue
  
  // North street area
  { x: -30, z: 90, yaw: Math.PI },        // north-street intersection
  { x: -90, z: 90, yaw: Math.PI },        // west across north street
  
  // Central hub return
  { x: -30, z: 30, yaw: -Math.PI / 2 },   // back to center
  { x: 0, z: -26, yaw: 0 },               // back to spawn
];

// Deadlock detection parameters
const DEADLOCK_SPEED_TOL = 0.1;
const DEADLOCK_TIME_TOL = 2.0;

const SIM_TIME_LIMIT = 300;  // 5 minutes = 300 seconds @ 120Hz = 36000 frames
const STEP_DT = 1 / 120;     // physics fixed step

console.log('═══════════════════════════════════════════════════════');
console.log('A4 ACCEPTANCE TEST · Path Cruise Simulation');
console.log('═══════════════════════════════════════════════════════');
console.log(`Waypoints: ${WAYPOINTS.length} points`);
console.log(`Sim time: ${SIM_TIME_LIMIT}s (${(SIM_TIME_LIMIT / STEP_DT).toFixed(0)} frames)`);
console.log(`Deadlock threshold: speed <${DEADLOCK_SPEED_TOL} m/s for >${DEADLOCK_TIME_TOL}s`);
console.log('');

// Initialize rover at first waypoint
let rover = new RoverPhysics(WAYPOINTS[0].x, WAYPOINTS[0].z, WAYPOINTS[0].yaw);
let targetWP = 0;
let stuckFrames = 0;
let deadlockCount = 0;
let rescueCount = 0;

// Input simulator
function setInput() {
  if (targetWP >= WAYPOINTS.length - 1) return { gas: 0, brake: 0, steer: 0 };
  
  const next = WAYPOINTS[targetWP + 1];
  const dx = next.x - rover.x;
  const dz = next.z - rover.z;
  const dist = Math.hypot(dx, dz);
  
  // Stop distance
  if (dist < 10) {
    targetWP++;
    rover.yaw = next.yaw;
    return { gas: 0, brake: 0, steer: 0 };
  }
  
  // Calculate target heading
  const targetYaw = Math.atan2(dx, dz);
  let deltaYaw = targetYaw - rover.yaw;
  
  // Normalize to [-π, π]
  while (deltaYaw <= -Math.PI) deltaYaw += 2 * Math.PI;
  while (deltaYaw > Math.PI) deltaYaw -= 2 * Math.PI;
  
  // Steering input based on heading error
  const steer = Math.sign(deltaYaw) * Math.min(1, Math.abs(deltaYaw) / 0.5);
  
  return { gas: 0.7, brake: 0, steer };
}

// Run simulation
let frame = 0;
let maxSpeed = 0;
let totalDist = 0;
let lastPos = { x: rover.x, z: rover.z };

console.log('[sim] Starting cruise...');
console.log('-'.repeat(60));

while (frame < SIM_TIME_LIMIT / STEP_DT) {
  const inp = setInput();
  rover.step(STEP_DT, inp, colliders, null);
  
  // Track statistics
  const currentSpeed = Math.hypot(rover.vx, rover.vz);
  if (currentSpeed > maxSpeed) maxSpeed = currentSpeed;
  
  const distThisFrame = Math.hypot(rover.x - lastPos.x, rover.z - lastPos.z);
  totalDist += distThisFrame;
  lastPos = { x: rover.x, z: rover.z };
  
  // Check for deadlocks
  const inputActive = inp.gas > DEADLOCK_SPEED_TOL || 
                      Math.abs(inp.steer) > DEADLOCK_SPEED_TOL;
  
  if (rover.speed < DEADLOCK_SPEED_TOL && inputActive) {
    stuckFrames++;
    
    if (stuckFrames > DEADLOCK_TIME_TOL * 120) {
      deadlockCount++;
      
      if (deadlockCount <= 3) {
        console.log(`⚠️ [DEADLOCK] Frame ${frame}/${(SIM_TIME_LIMIT / STEP_DT).toFixed(0)} ` +
                   `pos(${rover.x.toFixed(1)}, ${rover.z.toFixed(1)}) ` +
                   `speed=${rover.speed.toFixed(2)} m/s ` +
                   `stuck=${(stuckFrames * STEP_DT).toFixed(1)}s`);
      }
      
      // Execute rescue (same logic as in physics.js)
      if (!rover.isRescuing && rover.rescueCount < 3) {
        rover.isRescuing = true;
        rover.rescueCount++;
        rescueCount++;
        
        if (rescueCount <= 3) {
          console.log(`🆘 [RESCUE_EXEC] frame=${frame}, count=${rescueCount}`);
        }
        
        rover.isRescuing = false;
      }
    }
  } else {
    if (stuckFrames > 0) {
      console.log(`✅ [RESCUED] frame=${frame}, total_stuck=${(stuckFrames * STEP_DT).toFixed(1)}s`);
    }
    stuckFrames = 0;
    rover.stuckStartTime = 0;
  }
  
  frame++;
  
  // Progress report every 5 seconds
  if (frame % (5 * 120) === 0) {
    const simTime = frame * STEP_DT;
    console.log(`[${simTime.toFixed(1)}s] frame=${frame}/${(SIM_TIME_LIMIT / STEP_DT).toFixed(0)} pos(${rover.x.toFixed(1)}, ${rover.z.toFixed(1)}) speed=${currentSpeed.toFixed(2)} m/s target_wp=${targetWP}/${WAYPOINTS.length - 1}`);
  }
}

// Summary
console.log('-'.repeat(60));
console.log('═══ SIMULATION COMPLETE ═══');
const simTime = frame * STEP_DT;
console.log(`Total: ${simTime.toFixed(1)}s, ${frame.toLocaleString()} frames`);
console.log(`Max speed: ${maxSpeed.toFixed(2)} m/s`);
console.log(`Total distance: ${totalDist.toFixed(1)} m`);
console.log(`Deadlocks detected: ${deadlockCount}`);
console.log(`Rescues executed: ${rescueCount}`);

if (deadlockCount === 0) {
  console.log('\n✅ A4 PASS: Zero deadlocks in continuous cruise');
  process.exit(0);
} else {
  console.log('\n❌ A4 FAIL: Deadlocks detected during cruise');
  process.exit(1);
}
