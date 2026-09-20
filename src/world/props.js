import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { surfaceAt } from './height.js';
import { ZONES, SHIP_POS, LEAK_POS, SAMPLE_COUNT } from '../config.js';
import { mulberry32, fbm } from '../utils/noise.js';
import { loadModel, cloneModel, cloneMaterials } from './assets.js';

const G = new THREE.Group();
function box(w, h, d, mat, x, y, z, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  (parent || G).add(m); return m;
}
function cyl(rt, rb, h, mat, x, y, z, seg = 20, parent, open = false) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  (parent || G).add(m); return m;
}
function at(zone, dx, dz) { const p = ZONES[zone].pos; return [p[0] + dx, p[1] + dz]; }

// Canvas-drawn telemetry panel: a flat emissive quad on a 512px board reads as a green-screen
// card in a screenshot, which is exactly the placeholder look this project has to avoid.
function boardTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 236;
  const g = c.getContext('2d');
  g.fillStyle = '#05090c'; g.fillRect(0, 0, 512, 236);
  g.fillStyle = 'rgba(255,255,255,.05)';
  for (let y = 0; y < 236; y += 4) g.fillRect(0, y, 512, 1);
  const text = (t, x, y, col, size) => { g.font = `bold ${size}px monospace`; g.fillStyle = col; g.fillText(t, x, y); };
  text('LC-39-M · VEHICLE READY', 20, 42, '#ffb066', 24);
  text('T-00:04:31', 20, 92, '#8ff0ff', 38);
  text('LOX  1.92 bar', 20, 134, '#cfe6ee', 22);
  text('CH4  2.04 bar', 20, 164, '#cfe6ee', 22);
  text('WIND  9.4 m/s', 20, 194, '#cfe6ee', 22);
  for (let i = 0; i < 8; i++) {
    const h = 16 + ((i * 37) % 76);
    g.fillStyle = i > 5 ? '#ff7a3c' : '#3fd0c9';
    g.fillRect(306 + i * 24, 206 - h, 15, h);
  }
  g.strokeStyle = 'rgba(143,240,255,.45)'; g.lineWidth = 3; g.strokeRect(7, 7, 498, 222);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function pipeAt(x1, z1, x2, z2, y, mat, rr = 0.5, parent) {
  const len = Math.hypot(x2 - x1, z2 - z1);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, len, 10), mat);
  m.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
  m.rotation.z = Math.PI / 2;
  m.rotation.y = Math.atan2(z2 - z1, x2 - x1) + Math.PI / 2;
  m.castShadow = true; (parent || G).add(m); return m;
}

export async function buildBase(scene, quality) {
  G.clear();
  const MODEL_NAMES = ['habitat_dome', 'greenhouse', 'launch_tower', 'starship',
    'solar_array', 'comm_dish', 'cryo_tank', 'lamp', 'crystal', 'lander'];
  const models = {};
  await Promise.all(MODEL_NAMES.map(async (n) => { models[n] = await loadModel(n); }));
  const M = {
    concrete: new THREE.MeshStandardMaterial({ color: 0x6a6357, roughness: 0.97, metalness: 0.02 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x24221f, roughness: 0.7, metalness: 0.5 }),
    struct: new THREE.MeshStandardMaterial({ color: 0x4a4640, roughness: 0.55, metalness: 0.75 }),
    white: new THREE.MeshStandardMaterial({ color: 0xd8d5cd, roughness: 0.5, metalness: 0.2 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xb9bec4, metalness: 1.0, roughness: 0.22, envMapIntensity: 1.6 }),
    steelDull: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.9, roughness: 0.45, envMapIntensity: 1.2 }),
    // Cryo shells under one warm key light + bloom band a mirror-polished cylinder straight to
    // white, so the tank body is deliberately darker and much rougher than the ship's steel.
    cryo: new THREE.MeshStandardMaterial({ color: 0x84898f, metalness: 0.62, roughness: 0.68, envMapIntensity: 0.55 }),
    insul: new THREE.MeshStandardMaterial({ color: 0x5e6469, metalness: 0.25, roughness: 0.92 }),
    blackTile: new THREE.MeshStandardMaterial({ color: 0x12100f, roughness: 0.85, metalness: 0.15 }),
    blue: new THREE.MeshStandardMaterial({ color: 0x2b6a9e, roughness: 0.4, metalness: 0.4 }),
    redBand: new THREE.MeshStandardMaterial({ color: 0xa03028, roughness: 0.5, metalness: 0.3 }),
    orange: new THREE.MeshStandardMaterial({ color: 0xd96a1a, roughness: 0.5, metalness: 0.4 }),
    panelGlass: new THREE.MeshStandardMaterial({ color: 0x101828, roughness: 0.15, metalness: 0.85, envMapIntensity: 1.5 }),
    warmWin: new THREE.MeshStandardMaterial({ color: 0xffdca0, emissive: 0xffb050, emissiveIntensity: 2.2 }),
    beacon: new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 4 }),
    goldLight: new THREE.MeshStandardMaterial({ color: 0xffcf80, emissive: 0xffb040, emissiveIntensity: 1.15 }),
    shipLightRing: new THREE.MeshStandardMaterial({ color: 0x66ccff, emissive: 0x3399ff, emissiveIntensity: 2.5, transparent: true, opacity: 0.9 }),
    crystal: new THREE.MeshStandardMaterial({ color: 0xbaf5ee, emissive: 0x3fd9c4, emissiveIntensity: 1.25, roughness: 0.12, metalness: 0.35 }),
  };
  const colliders = [];
  const infoZones = [];
  const sparkPoints = [];
  const beacons = [];
  const lightStrips = [];
  const lightRings = [];
  const showBeamMats = [];
  let showBeams = null;
  const shipMats = [];
  let shipGroup = null;

  // ══════════ LAUNCH ZONE — pad + Mechazilla + Starship/SuperHeavy ══════════
  {
    const [px, pz] = ZONES.launch.pos;
    // pad ground
    const pad = cyl(60, 64, 2, M.concrete, px, 0.4, pz, 48);
    pad.receiveShadow = true;
    // flame trench + OLM deck
    box(26, 3, 26, M.dark, px, 1.6, pz);
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * Math.PI * 2 + 0.78;
      box(3, 12, 3, M.struct, px + Math.cos(a) * 10, 7, pz + Math.sin(a) * 10); // hold-down towers
    }
    // deluge water ring
    const ring = new THREE.Mesh(new THREE.TorusGeometry(13, 0.5, 8, 40), M.blue);
    ring.rotation.x = Math.PI / 2; ring.position.set(px, 2.6, pz); G.add(ring);
    // Mechazilla tower — Blender-modeled lattice gantry (launch_tower.glb)
    const [tx, tz] = [px + 42, pz];
    const towerTopY = surfaceAt(tx, tz) + 122;
    const tower = cloneModel(models.launch_tower);
    tower.scale.setScalar(2.45);
    tower.position.set(tx, surfaceAt(tx, tz) - 0.3, tz);
    tower.rotation.y = Math.PI;      // chopstick service arm reaches west, over the pad
    G.add(tower);
    // service blocks at tower base
    box(24, 12, 14, M.white, tx + 20, 6, tz + 24);
    box(16, 8, 10, M.white, tx + 20, 4, tz - 24);
    colliders.push({ x: tx, z: tz, r: 14 }, { x: tx + 20, z: tz + 24, r: 14 }, { x: tx + 20, z: tz - 24, r: 11 });
    beacons.push(box(1.2, 1.2, 1.2, M.beacon, tx, towerTopY + 1, tz));
    // ---- Starship (Blender-modeled starship.glb on the pad) ----
    const ship = new THREE.Group();
    ship.position.set(px, 2.2, pz);
    const hull = cloneModel(models.starship);
    const shipMatMap = cloneMaterials(hull);
    hull.scale.setScalar(2.78);       // ~121 m nose to engine
    ship.add(hull);
    const seenMats = new Set();
    hull.traverse(o => {
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!seenMats.has(m)) { seenMats.add(m); shipMats.push(m); }
      }
    });
    // Light-show rings. The trigger radius is 90 m, and from there a 121 m stack never fits in a
    // 60° frame — only the booster is on screen — so most rings sit low, on the visible band.
    const RING_HUES = [0x3fd9ff, 0xff8a3c, 0xa05cff, 0x3fffc9, 0xff4d6d, 0x8fb4ff, 0xffd166, 0xff7ad9];
    for (const [i, f] of [0.05, 0.12, 0.21, 0.32, 0.45, 0.59, 0.72, 0.86].entries()) {
      const tr = new THREE.Mesh(new THREE.TorusGeometry(8.75, 0.3, 6, 40), M.shipLightRing.clone());
      tr.material.color.setHex(RING_HUES[i]); tr.material.emissive.setHex(RING_HUES[i]);
      tr.rotation.x = Math.PI / 2; tr.position.y = f * 121; tr.visible = false; ship.add(tr);
      lightStrips.push(tr.material); lightRings.push(tr);
    }
    // the ship's modeled window strip + logo band join the show with their own cloned materials
    for (const m of shipMatMap.values()) {
      if (m.name === 'light_amber' || m.name === 'light_cyan') lightStrips.push(m);
    }
    // Pad-edge wash ring: the one element of the show that is guaranteed to be on screen from the
    // trigger distance, so the ground itself reads as lit rather than a distant dot. Kept well
    // inside the pad and dim — at r=56 its near arc passed 16 m from the lens and bloomed out.
    const wash = new THREE.Mesh(new THREE.TorusGeometry(38, 0.32, 8, 64), M.shipLightRing.clone());
    wash.material.color.setHex(0x9ff0ff); wash.material.emissive.setHex(0x2fbfe0);
    wash.rotation.x = Math.PI / 2; wash.position.set(px, 2.7, pz); wash.visible = false; G.add(wash);
    lightStrips.push(wash.material); lightRings.push(wash);
    // Light-show searchlights: five steep additive shafts ringing the pad. Kept near-vertical and
    // narrow on purpose — a wide cone tilted toward the camera fills the frame with a hard-edged
    // translucent polygon, which reads as geometry, not as light.
    showBeams = new THREE.Group();
    showBeams.position.set(px, 0, pz);
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2 + 0.6;
      const bm = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 5.5, 210, 14, 1, true), new THREE.MeshBasicMaterial({
        color: [0x8fd4ff, 0xffb066, 0xc79cff, 0x8fffe0, 0xff9ab0][i], transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      bm.position.set(Math.cos(a) * 34, 104, Math.sin(a) * 34);
      bm.rotation.z = -Math.cos(a) * 0.17;
      bm.rotation.x = Math.sin(a) * 0.17;
      showBeams.add(bm); showBeamMats.push(bm.material);
    }
    G.add(showBeams);
    ship.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    G.add(ship);
    shipGroup = ship;
    colliders.push({ x: px, z: pz, r: 16 });
    infoZones.push({
      key: 'launch', pos: [px, pz], r: 75, tag: 'LC-39-M · ORBITAL LAUNCH MOUNT',
      name: '轨道发射台 & Mechazilla', params: ['发射塔高度 146 m · 筷子臂跨距 52 m', '星舰总高 121 m · 起飞推力 ~75 MN', '推进剂：液态甲烷 / 液氧（火星原位制备）'],
      fact: '筷子夹臂可以在助推器返回时将它从空中夹住回收——在火星，这座塔同样为星际飞船加油。',
      objective: 'drive: 驶近发射台完成巡检',
    });
  }

  // ══════════ PRODUCTION — High Bay / Mid Bay / prototype / sparks ══════════
  {
    const [hx, hz] = at('production', 0, 0);
    // Panel courses and column bays are merged into one mesh per bay: a facade this
    // detailed would otherwise cost ~40 draw calls each.
    const bay = (x, z, w, h, d, doorFrac = 0) => {
      const g2 = new THREE.Group(); g2.position.set(x, 0, z);
      box(w, h, 1.2, M.struct, 0, h / 2, -d / 2, g2);                       // back
      box(1.2, h, d, M.struct, -w / 2, h / 2, 0, g2);                       // sides
      box(1.2, h, d, M.struct, w / 2, h / 2, 0, g2);
      box(w + 1.5, 1.2, d + 1.5, M.struct, 0, h, 0, g2);                    // roof
      box(w * 0.36, 0.6, d * 0.5, M.dark, -w * 0.32, h - 2.5, 0, g2);       // crane
      box(w + 1.8, 1, d + 1.8, M.dark, 0, 0.5, 0, g2);                      // plinth
      box(w + 1.6, 0.5, d + 1.6, M.redBand, 0, 1.25, 0, g2);                // hazard band
      const ribs = [];
      const rib = (rw, rh, rd, rx, ry, rz) => {
        const g3 = new THREE.BoxGeometry(rw, rh, rd); g3.translate(rx, ry, rz); ribs.push(g3);
      };
      for (let y = 4; y < h - 2; y += 5.4) {                                // corrugated courses
        rib(w - 0.6, 0.6, 0.55, 0, y, -d / 2 - 0.85);
        rib(0.55, 0.6, d - 0.6, -w / 2 - 0.85, y, 0);
        rib(0.55, 0.6, d - 0.6, w / 2 + 0.85, y, 0);
      }
      for (let i = 0; i <= 5; i++) {                                        // structural columns
        const cx2 = -w / 2 + (i / 5) * w;
        rib(1.5, h - 1.5, 1.1, cx2, (h - 1.5) / 2, -d / 2 - 0.9);
      }
      for (let i = 0; i <= 3; i++) {                                        // door tracks framing the opening
        const cz2 = -d / 2 + (i / 3) * d;
        rib(1.1, h - 1.5, 1.1, -w / 2 - 0.9, (h - 1.5) / 2, cz2);
        rib(1.1, h - 1.5, 1.1, w / 2 + 0.9, (h - 1.5) / 2, cz2);
      }
      const skin = new THREE.Mesh(mergeGeometries(ribs), M.steelDull);
      skin.castShadow = true; skin.receiveShadow = true; g2.add(skin);

      // Open front staged as a real assembly hall: the backdrop sits against the inside of
      // the back wall, so the opening reads as depth instead of a flat black panel.
      box(w - 3, h - 3, 0.2, M.dark, 0, (h - 3) / 2, -d / 2 + 1.7, g2);
      box(w - 3, 0.4, d - 3, M.concrete, 0, 0.3, 0, g2);                    // shop floor
      box(w - 7, 0.55, 1, M.warmWin, 0, h * 0.32, -d / 2 + 2.3, g2);        // mezzanine light lines
      box(w - 11, 0.45, 1, M.warmWin, 0, h * 0.62, -d / 2 + 2.3, g2);
      for (let i = 0; i < 4; i++) {                                         // high-bay luminaires
        box(0.6, 3.2, 0.6, M.goldLight, -w * 0.34 + (i / 3) * w * 0.68, h * 0.47, -d * 0.06, g2);
      }
      const rigN = doorFrac ? 2 : 3;                                        // hulls under assembly
      for (let i = 0; i < rigN; i++) {
        const rr = Math.min(w, d) * 0.16, rx = -w * 0.26 + (i / Math.max(1, rigN - 1)) * w * 0.5;
        cyl(rr, rr, h * (0.34 + 0.1 * i), i % 2 ? M.steel : M.steelDull, rx, h * (0.17 + 0.05 * i), -d * 0.02, 18, g2);
        box(rr * 2.3, 0.5, rr * 2.3, M.struct, rx, h * (0.34 + 0.1 * i) + 0.25, -d * 0.02, g2);
      }
      if (doorFrac) box(w - 3, h * doorFrac, 0.7, M.steelDull, 0, (h * doorFrac) / 2, d / 2 - 1.2, g2);
      return g2;
    };
    G.add(bay(hx, hz, 42, 46, 34));
    G.add(bay(hx + 66, hz - 8, 28, 26, 22, 0.55));
    colliders.push({ x: hx, z: hz, r: 26 }, { x: hx + 66, z: hz - 8, r: 18 });
    // prototype SN inside open front, half-clad
    const proto = new THREE.Group(); proto.position.set(hx + 4, 0, hz + 26);
    cyl(4.5, 4.5, 30, M.steelDull, 0, 15, 0, 24, proto);
    const bare = cyl(4.2, 4.2, 12, M.dark, 0, 22, 0, 24, proto, true);
    for (let i = 0; i < 6; i++) box(0.5, 10, 2.6, M.steel, Math.cos(i / 6 * 6.283) * 5.1, 6, Math.sin(i / 6 * 6.283) * 5.1, proto);
    proto.traverse(o => { if (o.isMesh) o.castShadow = true; });
    G.add(proto);
    colliders.push({ x: hx + 4, z: hz + 26, r: 6 });
    // gantry + spark points on hulls
    box(2, 18, 2, M.struct, hx - 14, 9, hz + 14);
    sparkPoints.push({ x: hx - 6, y: 6, z: hz + 17, rate: 0.8 }, { x: hx + 10, y: 3, z: hz - 22, rate: 0.5 }, { x: hx + 66, y: 4, z: hz + 4, rate: 0.65 });
    beacons.push(box(1, 1, 1, M.beacon, hx, 47.5, hz));
    infoZones.push({
      key: 'highbay', pos: [hx, hz], r: 55, tag: 'PRODUCTION · HIGH BAY / MID BAY',
      name: '星舰总装厂 High Bay', params: ['厂房净高 46 m · 桥式起重机 2×40 t', '焊接机器人阵列 96 台', '不锈钢壁板 4 mm · 氩弧焊 + 激光焊'],
      fact: '每一枚星舰由上万片不锈钢壁板焊接而成。夜间这里的焊花像一簇簇绿色小烟火。',
    });
  }

  // ══════════ TANK FARM — LOX / CH4 / pipes / leak ══════════
  {
    const [cx, cz] = at('tanks', 0, 0);
    const rand = mulberry32(99);
    // Blender-modeled cryo tank (cryo_tank.glb): shell, domed cap, amber/cyan hoop lights,
    // legs, outlet stub and hazard label in one stylized asset.
    const tank = (x, z, rr, h, bandMat) => {
      const t = cloneModel(models.cryo_tank);
      t.scale.set(rr / 2.0, h / 9.6, rr / 2.0);
      t.position.set(x, 0, z);
      t.rotation.y = (x * 0.37 + z * 0.71) % 6.283;
      G.add(t);
      colliders.push({ x, z, r: rr + 2 });
      return { x, z };
    };
    for (let i = 0; i < 4; i++) tank(cx - 24 + i * 16, cz - 16, 5.5, 22, M.blue);     // LOX
    for (let i = 0; i < 3; i++) tank(cx - 16 + i * 16, cz + 14, 4.6, 16, M.redBand);  // CH4
    tank(cx + 34, cz - 16, 7, 26, M.blue);                                            // big LOX
    // pipe racks
    const pipe = (x1, z1, x2, z2, y, rr = 0.5) => {
      const len = Math.hypot(x2 - x1, z2 - z1);
      const p = cyl(rr, rr, len, M.steelDull, (x1 + x2) / 2, y, (z1 + z2) / 2, 10);
      p.rotation.z = Math.PI / 2; p.rotation.y = Math.atan2(z2 - z1, x2 - x1) + Math.PI / 2;
      return p;
    };
    for (let i = 0; i < 3; i++) pipe(cx - 26, cz - 2 + i * 1.6, cx + 36, cz - 2 + i * 1.6, 3.5 + i * 1.2, 0.45);
    pipe(cx - 26, cz + 14, cx - 26, cz - 2, 4, 0.5);
    // ── leak manifold: this is the mission's focal point, so it has to read as a serviceable
    // valve skid the player can park next to, not a crate sitting in the open ──
    {
      const mx = LEAK_POS[0], mz = LEAK_POS[1] + 6;
      box(13, 0.5, 9, M.concrete, mx, 0.25, mz);
      // dust-coated grey, not M.dark: a near-black slab 8 m from the camera reads as a hole
      // in an orange haze frame instead of a building
      box(4.4, 3.2, 3, M.insul, mx, 1.9, mz + 2.6);                       // instrument shelter
      box(4.8, 0.35, 3.4, M.concrete, mx, 3.62, mz + 2.6);                // roof slab
      box(2.4, 1.3, 0.16, M.warmWin, mx - 0.7, 2.1, mz + 1.14);          // lit rack behind it
      box(1.1, 0.7, 0.16, M.blue, mx + 1.5, 2.4, mz + 1.14);             // switch panel
      pipe(mx - 3.6, mz - 2.5, mx + 3.6, mz - 2.5, 4.9, 0.42);           // cross header
      for (const s of [-1, 1]) {
        const vx2 = mx + s * 3.6, vz2 = mz - 2.5;                        // risers sit in the fog
        cyl(0.62, 0.62, 5.4, M.steel, vx2, 2.7, vz2, 14);
        cyl(0.98, 0.98, 1.2, M.blue, vx2, 5.7, vz2, 14);                 // actuator head
        cyl(1.5, 1.7, 0.9, M.struct, vx2, 0.7, vz2, 14);                 // valve body
        const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.14, 6, 18), M.redBand);
        wheel.position.set(vx2, 3.7, vz2 + 0.8); G.add(wheel);
        pipe(mx + s * 3.6, mz - 2.5, mx + s * 3.6, cz - 2, 4.2, 0.4);
      }
      // posts every ~3 m plus a lower rail: two corner posts and one thin top bar read as
      // orange planks lying in the sand rather than a guard rail
      {
        const postG = [];
        for (const q of [-1, 1]) for (const px of [-6.1, -3, 0, 3, 6.1]) postG.push(new THREE.BoxGeometry(0.2, 1.3, 0.2).translate(mx + px, 0.65, mz + q * 4.1));
        for (const s of [-1, 1]) for (const pz of [-1.4, 1.4]) postG.push(new THREE.BoxGeometry(0.2, 1.3, 0.2).translate(mx + s * 6.1, 0.65, mz + pz));
        G.add(new THREE.Mesh(mergeGeometries(postG), M.orange));
      }
      for (const ry of [1.25, 0.62]) {
        box(12.5, 0.14, 0.14, M.orange, mx, ry, mz + 4.1);
        box(12.5, 0.14, 0.14, M.orange, mx, ry, mz - 4.1);
      }
      for (const s of [-1, 1]) for (const ry of [1.25, 0.62]) box(0.14, 0.14, 8.4, M.orange, mx + s * 6.1, ry, mz);
      // a bare emissive cube hovering over the roof reads as a placeholder; give it a mast
      // and a sun hood so the lens has a fixture around it
      cyl(0.09, 0.09, 1.1, M.struct, mx, 4.15, mz + 1.1, 8);
      beacons.push(box(0.8, 0.8, 0.8, M.beacon, mx, 4.75, mz + 1.1));
      box(1.1, 0.14, 1.1, M.struct, mx, 5.25, mz + 1.1);
      colliders.push({ x: mx, z: mz - 0.5, r: 7 });
    }
    // seated on the dome apexes — floating 1 m cubes 27 m up were the same defect at scale
    beacons.push(box(0.75, 0.75, 0.75, M.beacon, cx - 24, 27.9, cz - 16), box(0.8, 0.8, 0.8, M.beacon, cx + 34, 33.4, cz - 16));
    infoZones.push({
      key: 'tanks', pos: [cx, cz], r: 55, tag: 'PROPELLER FARM · LOX / LCH4',
      name: '推进剂储罐区', params: ['LOX 储罐 ×5 · 单罐 400 t', '液态甲烷储罐 ×3 · 单罐 240 t', 'BOG 回收管线 3 路 · 真空夹套'],
      fact: '火星大气中的 CO₂ 与地下冰，经过萨巴蒂尔反应就能再造甲烷与氧气——这座储罐区就是星际燃料站的雏形。',
      objective: '靠近红色警报处的阀门组 · 按住交互键（键盘 E / 触屏「交互」）约 3 秒',
    });
  }

  // ══════════ HABITAT — Blender-modeled dome village / greenhouse / solar farm ══════════
  {
    const [vx, vz] = at('habitat', 0, 0);
    const put = (model, x, z, s, ry) => {
      const o = cloneModel(model);
      o.scale.setScalar(s);
      o.position.set(x, surfaceAt(x, z) - 0.15, z);
      o.rotation.y = ry || 0;
      G.add(o); return o;
    };
    put(models.habitat_dome, vx - 16, vz - 6, 1.15, 0.4);
    put(models.habitat_dome, vx + 10, vz - 18, 0.9, 2.4);
    put(models.habitat_dome, vx + 18, vz + 6, 1.05, -1.1);
    put(models.greenhouse, vx - 6, vz + 18, 1.2, 0.7);
    colliders.push({ x: vx - 16, z: vz - 6, r: 8 }, { x: vx + 10, z: vz - 18, r: 7 },
      { x: vx + 18, z: vz + 6, r: 8 }, { x: vx - 6, z: vz + 18, r: 6 });
    // pressurized walkways between the domes
    pipeAt(vx - 16, vz - 6, vx + 10, vz - 18, surfaceAt(vx - 3, vz - 12) + 2.4, M.steelDull, 1.1);
    pipeAt(vx + 10, vz - 18, vx + 18, vz + 6, surfaceAt(vx + 14, vz - 6) + 2.4, M.steelDull, 1.0);
    // solar farm — 15 tracked arrays
    for (let gx = 0; gx < 5; gx++) for (let gz = 0; gz < 3; gz++) {
      const x = vx + 36 + gx * 11, z = vz - 16 + gz * 11;
      put(models.solar_array, x, z, 1.15, 0.25);
      if (gz === 1) colliders.push({ x, z, r: 3.2 });
    }
    // comm dishes
    put(models.comm_dish, vx - 28, vz + 14, 1.0, 2.1);
    put(models.comm_dish, vx - 20, vz + 27, 0.7, 0.6);
    colliders.push({ x: vx - 28, z: vz + 14, r: 3.5 }, { x: vx - 20, z: vz + 27, r: 2.6 });
    // a lone research dome out on the night-overlook hill, its warm windows facing the galaxy
    put(models.habitat_dome, ...ZONES.night.pos.map((v, i) => i === 0 ? v + 26 : v + 10), 0.8, 1.7);
    infoZones.push({
      key: 'habitat', pos: [vx, vz], r: 46, tag: 'SETTLEMENT · MODULE A-D',
      name: '火星生活舱段', params: ['加压体积 4×920 m³ · 气闸 ×2', '温室穹顶 生物量 ~2.1 t', '光伏阵列 310 kW + 甲烷备电'],
      fact: '暖光从舷窗透出来的时候，四亿公里外的家也不过如此。这里住着 24 名工程师与植物学家。',
    });
  }

  // ══════════ WATCH DECK — launch viewing point ══════════
  {
    const [wx, wz] = at('watch', 0, 0);
    // seat the slab on the highest dune inside its own footprint, or the terrain pokes through it
    let deckY = -Infinity;
    for (let i = 0; i < 36; i++) {
      const a = i / 36 * 6.283, rr = (i % 3) / 2 * 13.5;
      deckY = Math.max(deckY, surfaceAt(wx + Math.cos(a) * rr, wz + Math.sin(a) * rr));
    }
    const deckTop = deckY + 0.55;
    cyl(14, 14, 1.4, M.concrete, wx, deckTop - 0.7, wz, 32);
    for (let i = 0; i < 20; i++) {
      const a = i / 20 * 6.283;
      box(0.15, 1.3, 0.15, M.struct, wx + Math.cos(a) * 13.4, deckTop + 0.65, wz + Math.sin(a) * 13.4);
    }
    const rail = new THREE.Mesh(new THREE.TorusGeometry(13.5, 0.09, 6, 40), M.struct);
    rail.rotation.x = Math.PI / 2; rail.position.set(wx, deckTop + 1.3, wz); G.add(rail);
    // LED board: off to the deck's east edge and yawed back at the crowd. It used to stand at
    // wx-10/wz-4, which is exactly where the chase camera parks, so every photo-mode frame from
    // the deck was 2/3 filled by the panel.
    const boardX = wx + 13, boardZ = wz + 2;
    const board = new THREE.Group(); board.position.set(boardX, deckTop + 4.6, boardZ);
    board.rotation.y = Math.atan2(wx - boardX, wz - boardZ);   // the plane's normal is +z
    box(8, 4, 0.4, M.dark, 0, 0, 0, board);
    const lcdTex = boardTexture();
    const lcd = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 3.4), new THREE.MeshStandardMaterial({
      map: lcdTex, emissiveMap: lcdTex, emissive: 0xffffff, emissiveIntensity: 0.85, roughness: 0.45,
    }));
    lcd.position.set(0, 0, 0.25); board.add(lcd);
    box(0.6, 5.4, 0.6, M.struct, 0, -2.8, 0, board);
    cyl(1.4, 1.6, 0.4, M.concrete, boardX, deckTop + 0.2, boardZ, 12);
    G.add(board);
    // flat pad you drive and stand on — `floor` makes it real ground to the rover, `top` tells
    // the chase camera it may fly over it
    colliders.push({ x: wx, z: wz, r: 15, top: deckTop + 0.3, floor: deckTop });
    colliders.push({ x: boardX, z: boardZ, r: 1.8 });
    infoZones.push({
      key: 'watch', pos: [wx, wz], r: 26, tag: 'VIEWING DECK · SAFE DIST 180 m',
      name: '发射观礼台', params: ['视角方位 37° · 俯仰 +8°', '冲击波抵达延迟 ~0.55 s', '声压级（无防护）~118 dB'],
      fact: '任务完成后回到这里，系好安全带——星舰点火时，火星的大气会把你轻轻推回座椅。',
      objective: 'drive: 等待发射窗口（完成任务线后触发）',
    });
  }

  // ══════════ WILD — samples, arches, wreck, roadster easter egg ══════════
  const samples = [];
  let wreckPos = null;
  {
    const rand = mulberry32(1234);
    const placed = [];
    let tries = 0;
    while (samples.length < SAMPLE_COUNT && tries++ < 500) {
      const a = rand() * Math.PI * 2;
      const r = 300 + rand() * 500;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(z) < 60 && x < -150) continue;
      let ok = true;
      for (const k of Object.values(ZONES)) if (Math.hypot(x - k.pos[0], z - k.pos[1]) < k.radius + 30) ok = false;
      for (const p of placed) if (Math.hypot(x - p[0], z - p[1]) < 120) ok = false;
      if (!ok) continue;
      placed.push([x, z]);
      const g4 = new THREE.Group();
      const y = surfaceAt(x, z);
      g4.position.set(x, y, z);
      // Blender-modeled alien crystal shard (crystal.glb)
      const c = cloneModel(models.crystal);
      c.scale.setScalar(1.1 + rand() * 0.6);
      g4.add(c);
      // A fat additive cone at 0.16 reads as a video-game pickup beam; keep the hint thin and
      // let the crystal itself carry the glow, with a soft ground ring for legibility at speed.
      const halo = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 1.1, 4.4, 14, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xa8ece0, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
      halo.position.y = 2.3; g4.add(halo);
      const pad = new THREE.Mesh(new THREE.CircleGeometry(1.5, 22),
        new THREE.MeshBasicMaterial({ color: 0x8fdccf, transparent: true, opacity: 0.11, blending: THREE.AdditiveBlending, depthWrite: false }));
      pad.rotation.x = -Math.PI / 2; pad.position.y = 0.07; g4.add(pad);
      G.add(g4);
      samples.push({ group: g4, crystal: c, x, z, taken: false });
    }
    infoZones.push({
      key: 'samples', pos: [0, 420], r: 9999, tag: 'FIELD SCIENCE',
      name: '火星矿物样本', params: ['撞击玻璃 / 层状硅酸盐 / 橄榄石', '驾驶驶近即可自动采集', '集齐 6 块解锁发射窗口'],
      fact: '每块岩石都是一页未读的书。好奇号在盖尔坑读了十年。',
    });
    // rock arch
    {
      const [ax, az] = [300, -380];
      const ay = surfaceAt(ax, az);
      const arch = new THREE.Mesh(new THREE.TorusGeometry(12, 2.2, 8, 24, Math.PI), new THREE.MeshStandardMaterial({ color: 0x7a4a30, roughness: 0.95 }));
      arch.position.set(ax, ay - 2, az); arch.rotation.y = 0.9; arch.castShadow = true; G.add(arch);
    }
    // wreck — storm zone marker
    {
      // offset from the zone centre: parked on top of a 26 m hull the rover has no
      // clean shot, and 14 m of un-fogged dark metal reads as a hole in the frame
      const [yx, yz] = at('storm', -66, 44);
      const wy = surfaceAt(yx, yz);
      wreckPos = new THREE.Vector3(yx, wy, yz);
      // the freight lander "Dawn-7", down on its side — Blender-modeled lander.glb
      const w = cloneModel(models.lander);
      w.scale.setScalar(4.6);
      w.position.set(yx, wy + 3.2, yz);
      w.rotation.set(1.45, 0.6, 0.25);
      G.add(w);
      const pole = cyl(0.4, 0.4, 14, M.struct, yx - 14, wy + 7, yz - 8);
      beacons.push(cyl(0.9, 0.9, 1.4, M.beacon, yx - 14, wy + 14, yz - 8, 10));
      colliders.push({ x: yx, z: yz, r: 12 });
      infoZones.push({
        key: 'storm', pos: [yx, yz], r: 60, tag: 'HAZARD ZONE · AEOLIS FIELD',
        name: '沙尘暴区 · 残骸场', params: ['能见度 < 40 m · 风速 22 m/s', '上次事件：全球性沙尘暴 Sol 388', '残骸：货运飞船 “黎明号” B-7'],
        fact: '火星的沙尘暴可以持续数月、覆盖整个星球。太阳能板蒙上沙尘的那个冬天，机遇号结束了它的工作。',
      });
    }
    // night overlook props
    {
      const [nx, nz] = at('night', 0, 0);
      const ny = surfaceAt(nx, nz);
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * 2.6 + 2.4;
        box(0.25, 3.2, 0.25, M.struct, nx + Math.cos(a) * 18, ny + 1.6, nz + Math.sin(a) * 18);
        const lb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), M.goldLight);
        lb.position.set(nx + Math.cos(a) * 18, ny + 3.4, nz + Math.sin(a) * 18); G.add(lb);
      }
      // pier + tilted scope — a bare tilted cylinder floating above the dune reads as a black monolith
      cyl(0.55, 0.8, 3.2, M.struct, nx + 13, ny + 1.6, nz - 15, 10);
      const scope = cyl(0.8, 1.1, 5, M.white, nx + 13, ny + 4.9, nz - 15, 12);
      scope.rotation.x = -0.7;
      colliders.push({ x: nx + 13, z: nz - 15, r: 2.5 });
      infoZones.push({
        key: 'night', pos: [nx, nz], r: 40, tag: 'OBSERVATION HILL',
        name: '夜空观赏丘', params: ['目视极限星等 6.4（无沙尘时）', '夜晚：按 N 快进到午夜', '灯光秀：夜晚靠近星舰按 E'],
        fact: '火星的夜晚没有光污染。银河像一道旧伤疤横贯天顶，地球只是其中一颗不特别亮的星。',
      });
    }
    // ---- hidden Roadster easter egg ----
    {
      const [rx, rz] = [470, 420];
      const ry = surfaceAt(rx, rz);
      const car = new THREE.Group(); car.position.set(rx, ry, rz); car.rotation.y = -0.7;
      // A squash-ball silhouette doesn't read as a Roadster at 6 m, so build the profile:
      // long nose, cockpit tub, flat rear deck, separate fenders, seated Starman facing forward.
      const paint = new THREE.MeshPhysicalMaterial({ color: 0xa81414, roughness: 0.26, metalness: 0.5, clearcoat: 0.85, clearcoatRoughness: 0.15, envMapIntensity: 1.2 });
      const glassDark = new THREE.MeshPhysicalMaterial({ color: 0x0d1620, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.6 });
      const suitMat = new THREE.MeshStandardMaterial({ color: 0xe6e2d8, roughness: 0.62, metalness: 0.05 });
      box(1.9, 0.4, 4.4, paint, 0, 0.66, 0, car);          // floor pan / sill
      box(1.62, 0.42, 1.5, paint, 0, 0.72, -1.75, car);    // bonnet
      box(1.5, 0.34, 1.25, paint, 0, 0.78, 1.7, car);      // rear deck
      box(1.42, 0.56, 1.35, paint, 0, 0.98, 0.35, car);    // cockpit tub
      box(1.24, 0.5, 0.1, glassDark, 0, 1.16, -0.42, car).rotation.x = -0.5;
      for (const s of [-1, 1]) {
        box(0.5, 0.5, 1.45, paint, s * 0.86, 0.72, -1.5, car).rotation.z = s * 0.16;   // front fender
        box(0.5, 0.46, 1.3, paint, s * 0.86, 0.72, 1.55, car).rotation.z = s * 0.16;   // rear fender
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), M.goldLight);
        lamp.position.set(s * 0.6, 0.86, -2.48); car.add(lamp);
      }
      const tyre = new THREE.MeshStandardMaterial({ color: 0x14120f, roughness: 0.95 });
      for (const [wxp, wzp] of [[-1.06, -1.5], [1.06, -1.5], [-1.06, 1.55], [1.06, 1.55]]) {
        cyl(0.58, 0.58, 0.38, tyre, wxp, 0.58, wzp, 16, car).rotation.z = Math.PI / 2;
        cyl(0.3, 0.3, 0.4, M.steel, wxp, 0.58, wzp, 12, car).rotation.z = Math.PI / 2;
      }
      const star = new THREE.Group(); star.position.set(0, 0.78, 0.42);
      const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.29, 0.4, 6, 12), suitMat);
      torso.position.y = 0.42; star.add(torso);
      const helm = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), suitMat);
      helm.position.y = 0.9; star.add(helm);
      const visor = new THREE.Mesh(new THREE.SphereGeometry(0.225, 16, 12), new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 1, roughness: 0.12, envMapIntensity: 1.5 }));
      visor.position.set(0, 0.92, -0.1); visor.scale.set(0.95, 0.8, 0.5); star.add(visor);
      box(0.52, 0.52, 0.24, suitMat, 0, 0.46, 0.3, star);   // life-support pack
      for (const s of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.42, 4, 8), suitMat);
        arm.position.set(s * 0.33, 0.42, 0.02); arm.rotation.x = 0.55; star.add(arm);
        const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.46, 4, 8), suitMat);
        leg.position.set(s * 0.16, 0.1, -0.32); leg.rotation.x = 1.45; star.add(leg);
      }
      car.add(star);
      car.traverse(o => { if (o.isMesh) o.castShadow = true; });
      G.add(car);
      colliders.push({ x: rx, z: rz, r: 3.5 });
      infoZones.push({
        key: 'roadster', pos: [rx, rz], r: 14, tag: 'EASTER EGG · DO NOT TOUCH',
        name: '隐藏彩蛋：午夜公路', params: ['2018 年发射 · 飞行 8 年后…迫降火星', '里程表：∞ km', '乘客：Starman'],
        fact: '“Don’t Panic.” —— 他终于到站了。',
      });
    }
  }

  // ══════════ road lamps along roads — Blender-modeled lamp.glb clones ══════════
  {
    const rand = mulberry32(55);
    const pts = [];
    const pairs = [[ZONES.launch.pos, ZONES.watch.pos], [ZONES.watch.pos, ZONES.habitat.pos], [ZONES.watch.pos, ZONES.tanks.pos], [ZONES.tanks.pos, ZONES.production.pos], [ZONES.production.pos, ZONES.launch.pos]];
    for (const [a, b] of pairs) {
      const n = 7;
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
        pts.push([x + dz / l * 12, z - dx / l * 12], [x - dz / l * 12, z + dx / l * 12]);
      }
    }
    pts.forEach(([x, z], i) => {
      const l = cloneModel(models.lamp);
      l.position.set(x, surfaceAt(x, z) - 0.1, z);
      l.rotation.y = (i % 2 ? 1 : -1) * Math.PI / 2 + rand() * 0.2;
      G.add(l);
    });
  }

  G.traverse(o => { if (o.isMesh && o.castShadow === false && o.geometry?.type?.includes('Box')) o.castShadow = true; });
  scene.add(G);
  const flamePoint = new THREE.Vector3(SHIP_POS[0], 2.4, SHIP_POS[1]);
  return {
    group: G, colliders, infoZones, samples, sparkPoints, beacons, lightStrips, lightRings, showBeams, showBeamMats, shipMats, shipGroup,
    leakPoint: new THREE.Vector3(LEAK_POS[0], 2.2, LEAK_POS[1] + 4),
    flamePoint,
    launchPadPos: new THREE.Vector3(...ZONES.launch.pos),
    wreckPos,
    watchPos: new THREE.Vector3(ZONES.watch.pos[0], surfaceAt(...ZONES.watch.pos), ZONES.watch.pos[1]),
  };
}
