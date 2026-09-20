import * as THREE from 'three';
import { surfaceAt } from './height.js';
import { ZONES, SHIP_POS, LEAK_POS, SAMPLE_COUNT } from '../config.js';
import { mulberry32 } from '../utils/noise.js';
import { loadModel, cloneModel, cloneMaterials } from './assets.js';

// ─── RED STARBASE · compact diorama ───
// One ~110 m island, six readable landmarks, everything hand-placed.
// Structures are Kenney Space Kit (CC0, 1-unit grid → scaled 3.5×); the hero
// pieces — the rover, the arch, the teleport pads, the ship, the domes — come
// from our own Blender builds so the silhouette language stays toy-soft.

const K = (name) => `kenney/space/${name}`;
const S = 3.5; // Kenney grid → diorama scale

const G = new THREE.Group();

export async function buildBase(scene, quality) {
  G.clear();
  const HERO = ['habitat_dome', 'greenhouse', 'launch_tower', 'starship', 'cryo_tank',
    'lamp', 'crystal', 'lander', 'arch', 'teleport_pad'];
  const KENNEY = ['hangar_roundA', 'hangar_largeA', 'hangar_smallA', 'corridor', 'corridor_corner',
    'corridor_end', 'platform_high', 'platform_low', 'platform_large', 'machine_generator',
    'machine_generatorLarge', 'machine_wireless', 'structure', 'structure_detailed', 'pipe_straight',
    'pipe_corner', 'satelliteDish', 'satelliteDish_detailed', 'rocket_baseB', 'rocket_finsA',
    'rover',
    'rocket_fuelA', 'rocket_sidesA', 'rocket_topA', 'barrels', 'barrel', 'craft_speederA',
    'astronautA', 'alien', 'desk_computer', 'terrain_roadStraight', 'rail', 'stairs',
    'supports_high', 'craterLarge'];
  const entries = [...HERO, ...KENNEY.map(K)];
  const models = {};
  await Promise.all(entries.map(async (n) => { models[n.split('/').pop()] = await loadModel(n); }));
  // glTF emissives arrive at full strength; under the sun + bloom band they blow out into
  // white discs. One art-direction pass over the shared hero materials fixes every instance.
  const padGlow = [], heroLights = [];
  for (const root of Object.values(models)) {
    root?.traverse(o => {
      // Glazing must not shadow: an opaque shadow map would black out the crops
      // the whole greenhouse exists to show off.
      if (o.isMesh && /glass_pane|_glass$/.test(o.name) ) o.castShadow = false;
      for (const mt of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
        const n = mt.name || '';
        if (n === 'glass_pane') { mt.transparent = true; mt.opacity = 0.30; mt.depthWrite = false; mt.roughness = 0.06; o.castShadow = false; }
        else if (n === 'pad_glow') { mt.emissiveIntensity = 0.12; padGlow.push(mt); }   // daylight: a read-able disc, not a bloom hole
        else if (/^light_/.test(n)) { mt.emissiveIntensity = 1.45; heroLights.push(mt); }
        else if (n === 'plant' || n === 'crystal_mat') mt.emissiveIntensity = 0.7;
      }
    });
  }
  const put = (name, x, z, s, ry, dy = -0.05) => {
    const o = cloneModel(models[name]);
    o.scale.setScalar(s);
    o.position.set(x, surfaceAt(x, z) + dy, z);
    o.rotation.y = ry || 0;
    G.add(o); return o;
  };
  const k = (name, x, z, ry, sc = 1) => put(name, x, z, S * sc, ry);

  // A wide deck seated on the centre height buries its downslope rim in the dune, so seat it on
  // the highest ground inside its own footprint instead.
  const rimY = (x, z, r) => {
    let y = surfaceAt(x, z);
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6;
      y = Math.max(y, surfaceAt(x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    return y;
  };
  const putDeck = (name, x, z, s, ry, bias = 0) => {
    const o = put(name, x, z, s, ry, 0);
    o.position.y = rimY(x, z, 2.7 * s) + bias;
    return o;
  };

  const M = {
    dark: new THREE.MeshStandardMaterial({ color: 0x33302c, roughness: 0.7, metalness: 0.4 }),
    struct: new THREE.MeshStandardMaterial({ color: 0x6b655c, roughness: 0.55, metalness: 0.7 }),
    white: new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.5, metalness: 0.15 }),
    orange: new THREE.MeshStandardMaterial({ color: 0xe07a2a, roughness: 0.5, metalness: 0.3 }),
    hazard: new THREE.MeshStandardMaterial({ color: 0xd94f35, roughness: 0.55, metalness: 0.25 }),
    warmWin: new THREE.MeshStandardMaterial({ color: 0xffdca0, emissive: 0xffb050, emissiveIntensity: 1.6 }),
    beacon: new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 4 }),
    goldLight: new THREE.MeshStandardMaterial({ color: 0xffcf80, emissive: 0xffb040, emissiveIntensity: 1.4 }),
    cyanLight: new THREE.MeshStandardMaterial({ color: 0x9ff0ff, emissive: 0x35c8e8, emissiveIntensity: 1.0 }),
    archStone: new THREE.MeshStandardMaterial({ color: 0x5c5148, roughness: 0.85, metalness: 0.1 }),
    shipLightRing: new THREE.MeshStandardMaterial({ color: 0x66ccff, emissive: 0x3399ff, emissiveIntensity: 2.5, transparent: true, opacity: 0.9 }),
    crystal: new THREE.MeshStandardMaterial({ color: 0xbaf5ee, emissive: 0x3fd9c4, emissiveIntensity: 1.25, roughness: 0.12, metalness: 0.35 }),
  };
  const box = (w, h, d, mat, x, y, z, parent) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    (parent || G).add(m); return m;
  };
  const cyl = (rt, rb, h, mat, x, y, z, seg = 18, parent) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    (parent || G).add(m); return m;
  };
  const colliders = [];
  const infoZones = [];
  const sparkPoints = [];
  const beacons = [];
  const lightStrips = [];
  const lightRings = [];
  const showBeamMats = [];
  const teleports = [];
  let showBeams = null;
  const shipMats = [];
  let shipGroup = null;

  const zoneY = (zz) => surfaceAt(zz.pos[0], zz.pos[1]);

  // ══════════ HUB — plaza, arch gate, flagpole, teleport ══════════
  {
    const [hx, hz] = ZONES.hub.pos;
    k('platform_large', hx, hz, 0, 1.9);              // 24 m plaza deck
    k('platform_high', hx - 11, hz + 9, 0.6);
    k('platform_high', hx + 11, hz + 9, -0.6);
    k('rail', hx, hz - 12.5, 0);
    // Blender-modeled welcome arch on the south approach (spawn side)
    const arch = put('arch', hx, hz - 13.5, 2.6, 0, -0.1);
    // the modeled black basalt reads as dead pixels against the orange sky; warm it up
    arch.traverse(o => { if (o.isMesh && o.material?.name === 'rover_dark') { o.material = M.archStone; } });
    // flag mast
    const my = zoneY(ZONES.hub);
    cyl(0.12, 0.16, 7, M.white, hx + 5.5, my + 3.5, hz + 4, 8);
    box(2.2, 1.3, 0.06, M.hazard, hx + 6.7, my + 6.3, hz + 4);
    k('barrel', hx - 6, hz + 6, 0.4); k('barrel', hx + 7, hz - 5, 1.2);
    putDeck('teleport_pad', hx - 8.5, hz + 11, 1.25, 0, -0.08);
    teleports.push({ key: 'hub', name: ZONES.hub.name, x: hx - 8.5, z: hz + 11 });
    k('astronautA', hx + 3, hz + 6, 2.4);
    k('craft_speederA', hx + 10, hz + 1, 0.9);
    colliders.push({ x: hx + 5.5, z: hz + 4, r: 0.8 });
    infoZones.push({
      key: 'hub', pos: [hx, hz], r: 22, tag: 'RED STARBASE · CENTRAL PLAZA',
      name: '中央广场', params: ['基地心脏 · 六条路线在此交汇', '传送平台：驶上光圈即可跃迁', '按 M 打开全区地图'],
      fact: '每一个火星基地都从一块平地开始。这块平地是用 240 台自动推土机铺出来的。',
    });
  }

  // ══════════ LAUNCH — pad, tower, starship & rocket stack ══════════
  {
    const [px, pz] = ZONES.launch.pos;
    k('platform_high', px, pz, 0, 2.4);               // raised launch deck
    k('platform_low', px + 13, pz + 9, 0.8);
    // the pad's glow ring
    const py = zoneY(ZONES.launch);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(9.5, 0.28, 8, 48), M.cyanLight.clone());
    ring.rotation.x = Math.PI / 2; ring.position.set(px, py + 0.35, pz); G.add(ring);
    lightStrips.push(ring.material);

    // ── Starship, our Blender hull, ~30 m toy-superhero scale ──
    const ship = new THREE.Group();
    ship.position.set(px, py + 0.3, pz);
    const hull = cloneModel(models['starship']);
    const shipMatMap = cloneMaterials(hull);
    hull.scale.setScalar(0.65);                       // seated 47.7 m hull → 31 m
    ship.add(hull);
    const seen = new Set();
    hull.traverse(o => {
      if (!o.isMesh) return;
      for (const mm of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!seen.has(mm)) { seen.add(mm); shipMats.push(mm); }
      }
    });
    const RING_HUES = [0x3fd9ff, 0xff8a3c, 0xa05cff, 0x3fffc9, 0xff4d6d, 0xffd166];
    for (const [i, f] of [0.06, 0.16, 0.3, 0.46, 0.64, 0.85].entries()) {
      const tr = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.1, 6, 32), M.shipLightRing.clone());
      tr.material.color.setHex(RING_HUES[i]); tr.material.emissive.setHex(RING_HUES[i]);
      tr.rotation.x = Math.PI / 2; tr.position.y = f * 31; tr.visible = false; ship.add(tr);
      lightStrips.push(tr.material); lightRings.push(tr);
    }
    for (const mm of shipMatMap.values()) {
      if (mm.name === 'light_amber' || mm.name === 'light_cyan') lightStrips.push(mm);
    }
    ship.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    G.add(ship); shipGroup = ship;
    colliders.push({ x: px, z: pz, r: 7 });

    // ── Chopstick tower, west of the ship: its six arms reach east to the hull
    // and the "RED STARBASE" board on its south face reads from the teleport pad.
    // Blender asset is 20.7 x 6.9 x 54.4 m with the flame trench 2.5 m below datum.
    put('launch_tower', px - 11, pz, 0.55, 0, 1.1);
    colliders.push({ x: px - 12.5, z: pz, r: 4 });
    const towerBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), M.beacon);
    towerBeacon.position.set(px - 11, py + 29.4, pz);
    G.add(towerBeacon); beacons.push(towerBeacon);

    // ── Kenney booster on a service stand, the base's cargo rocket ──
    {
      const bx2 = px - 15, bz2 = pz + 7, by = surfaceAt(bx2, bz2);
      const stack = new THREE.Group(); stack.position.set(bx2, by, bz2);
      const part = (name, y, ry) => { const o = cloneModel(models[name]); o.scale.setScalar(S); o.position.y = y; o.rotation.y = ry; stack.add(o); };
      part('rocket_baseB', 0.05, 0);
      part('rocket_finsA', 0.02, 0);
      part('rocket_fuelA', S * 1.0, 0.4);
      part('rocket_sidesA', S * 1.9, 0.2);
      part('rocket_topA', S * 2.9, 0);
      G.add(stack);
      colliders.push({ x: bx2, z: bz2, r: 4.5 });
      sparkPoints.push({ x: bx2 + 3, y: by + 2.2, z: bz2 + 1.5, rate: 0.5 });
    }
    // support gantries + FATO tanks around the pad
    k('supports_high', px + 6, pz - 12, 0.5);
    k('machine_generatorLarge', px - 8, pz - 10, 1.9);
    k('structure', px + 16, pz + 10, 2.6);
    k('barrels', px - 14, pz + 14, 0.7);
    colliders.push({ x: px - 8, z: pz - 10, r: 4 }, { x: px + 16, z: pz + 10, r: 4.5 }, { x: px - 14, z: pz + 14, r: 2.6 });

    // pad wash ring for the light show — guaranteed in-frame from the trigger distance
    const wash = new THREE.Mesh(new THREE.TorusGeometry(13.5, 0.22, 8, 56), M.shipLightRing.clone());
    wash.material.color.setHex(0x9ff0ff); wash.material.emissive.setHex(0x2fbfe0);
    wash.rotation.x = Math.PI / 2; wash.position.set(px, py + 0.5, pz); wash.visible = false; G.add(wash);
    lightStrips.push(wash.material); lightRings.push(wash);

    // light-show searchlights: five narrow, near-vertical shafts ringing the pad
    showBeams = new THREE.Group();
    showBeams.position.set(px, 0, pz);
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2 + 0.6;
      const bm = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 2.6, 56, 12, 1, true), new THREE.MeshBasicMaterial({
        color: [0x8fd4ff, 0xffb066, 0xc79cff, 0x8fffe0, 0xff9ab0][i], transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      bm.position.set(Math.cos(a) * 17, 28, Math.sin(a) * 17);
      bm.rotation.z = -Math.cos(a) * 0.14;
      bm.rotation.x = Math.sin(a) * 0.14;
      showBeams.add(bm); showBeamMats.push(bm.material);
    }
    G.add(showBeams);
    // teleport pad, clear of the blast ring
    putDeck('teleport_pad', px + 4, pz + 17, 1.1, 0, -0.08);
    teleports.push({ key: 'launch', name: ZONES.launch.name, x: px + 4, z: pz + 17 });

    infoZones.push({
      key: 'launch', pos: [px, pz], r: 34, tag: 'PAD ONE · ORBITAL LAUNCH MOUNT',
      name: '轨道发射台', params: ['星舰总高 31 m（1:4 纪念比例）', '筷子塔高 40 m', '任务代号：RED STARBASE'],
      fact: '在火星，这座塔不只是点火台——它是回家的门票。完成任务链后回到观礼台看它喷火。',
      objective: 'drive: 驶近发射台完成巡检',
    });
  }

  // ══════════ HABITAT — round hangar, domes, corridors, greenhouse ══════════
  {
    const [vx, vz] = ZONES.habitat.pos;
    k('hangar_roundA', vx - 7, vz - 4, 0.5, 1.4);     // the big living drum
    colliders.push({ x: vx - 7, z: vz - 4, r: 8 });
    // The seated 14.4 m domes used to sit where the corridors and the round hangar drum are;
    // coincident shells z-fight into a torn black blob, so the settlement is spread out.
    put('habitat_dome', vx + 18, vz + 14, 1.15, 0.6);      // seated 14.4 x 12.3 x 10.3 m
    put('habitat_dome', vx - 2, vz + 22, 0.85, 2.3);
    put('greenhouse', vx - 16, vz + 10, 1.25, -0.5, 0.05); // 13.7 x 12.0 x 5.0 m glasshouse
    // the greenhouse is a rectangle, not a disc — three overlapping circles keep
    // the rover out of the glass instead of letting it cut a corner off
    const ghA = -0.5, ghux = Math.cos(ghA), ghuz = -Math.sin(ghA);
    colliders.push({ x: vx + 18, z: vz + 14, r: 8.5 }, { x: vx - 2, z: vz + 22, r: 6.5 });
    for (const t of [-3.6, 0, 3.6]) {
      colliders.push({ x: vx - 16 + ghux * t, z: vz + 10 + ghuz * t, r: t === 0 ? 5.0 : 4.2 });
    }
    // pressurised corridors linking drum → domes → greenhouse
    k('corridor', vx + 3, vz + 3, 0.62, 1.1);
    k('corridor_corner', vx + 9, vz + 12, 1.35);
    k('corridor_end', vx - 8, vz + 9, 0.9);
    // front step, awning planters, life
    k('stairs', vx + 11, vz - 10, 0.1);
    k('barrel', vx - 2, vz - 8, 1.1);
    k('astronautA', vx + 7, vz + 15, -0.9);
    k('alien', vx - 13, vz + 14, 2.1);
    putDeck('teleport_pad', vx + 15, vz - 6, 1.05, 0, -0.08);
    teleports.push({ key: 'habitat', name: ZONES.habitat.name, x: vx + 15, z: vz - 6 });
    const vy = zoneY(ZONES.habitat);
    beacons.push(cyl(0.35, 0.35, 0.5, M.beacon, vx - 7, vy + 8.3, vz - 4, 10));   // seated on the hangar drum
    infoZones.push({
      key: 'habitat', pos: [vx, vz], r: 26, tag: 'SETTLEMENT · MODULE A-D',
      name: '火星生活舱区', params: ['加压体积 4×920 m³ · 气闸 ×2', '温室穹顶生物量 ~2.1 t', '住 here 的有 24 名工程师与植物学家'],
      fact: '暖光从舷窗透出来的时候，四亿公里外的家也不过如此。',
    });
  }

  // ══════════ INDUSTRY — fab, cryo tanks, pipe racks + the leak skid ══════════
  {
    const [ix, iz] = ZONES.industry.pos;
    k('hangar_largeA', ix - 6, iz - 8, 0.35, 0.35);   // the fab hall
    colliders.push({ x: ix - 6, z: iz - 8, r: 10 });
    k('machine_generatorLarge', ix + 11, iz - 4, 1.2);
    k('machine_generator', ix + 10, iz + 6, 2.6);
    k('machine_wireless', ix - 14, iz + 8, 0.9);
    k('structure_detailed', ix + 3, iz + 14, 2.2);
    colliders.push({ x: ix + 11, z: iz - 4, r: 4 }, { x: ix + 10, z: iz + 6, r: 4 }, { x: ix - 14, z: iz + 8, r: 4 }, { x: ix + 3, z: iz + 14, r: 4.5 });
    // cryo row: three Blender tanks with hazard stripes
    for (let i = 0; i < 3; i++) {
      const tx = ix + 17 - i * 0, tz = iz - 14 + i * 6.5;
      put('cryo_tank', tx + (i === 1 ? 3 : 0), tz, 0.95, 0.5 + i, 0.24);
      colliders.push({ x: tx + (i === 1 ? 3 : 0), z: tz, r: 3.0 });
      sparkPoints.push({ x: tx, y: surfaceAt(tx, tz) + 1.8, z: tz - 1.6, rate: 0.45 + i * 0.1 });
    }
    // pipe rack from tanks toward the fab
    for (let i = 0; i < 2; i++) {
      k('pipe_straight', ix + 10 - 6 * i, iz - 4 + 6 * i, 0.75, 0.9 + i * 0.1);
    }
    k('pipe_corner', ix + 6, iz - 10, 0.4);
    k('barrels', ix - 12, iz - 2, 2.0);               // crate of drums by the rail
    colliders.push({ x: ix - 12, z: iz - 2, r: 2.8 });
    k('rover', ix - 1, iz + 3, 1.8);                   // parked work rover
    putDeck('teleport_pad', ix - 3, iz + 20, 1.05, 0, -0.08);
    teleports.push({ key: 'industry', name: ZONES.industry.name, x: ix - 3, z: iz + 20 });
    infoZones.push({
      key: 'highbay', pos: [ix, iz], r: 26, tag: 'INDUSTRY · FAB & CRYO FARM',
      name: '工厂储罐区', params: ['总装车间净高 18 m', 'LOX/LCH4 低温储罐 ×3', '焊接机器人 96 台'],
      fact: '火星版的“工厂在门口”：推进剂在这里灌装，坏了的零件在这里重焊。',
    });
  }

  // ── leak skid at LEAK_POS — the repair mission's focal point ──
  {
    const [mx, mz] = LEAK_POS;
    const my2 = surfaceAt(mx, mz);
    k('machine_generator', mx, mz + 2.5, 1.4, 0.8);   // the valve housing
    k('pipe_straight', mx - 5, mz - 1.5, 0.2);
    k('pipe_corner', mx + 4.5, mz - 2.5, 2.4);
    colliders.push({ x: mx, z: mz + 2.5, r: 3.6 });
    // hazard ring + red beacon on a hooded mast
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * Math.PI * 2;
      cyl(0.07, 0.07, 0.9, M.orange, mx + Math.cos(a) * 5.4, my2 + 0.45, mz + Math.sin(a) * 5.4, 6);
    }
    cyl(0.09, 0.09, 1.6, M.struct, mx - 3.4, my2 + 0.8, mz - 3.4, 8);
    beacons.push(cyl(0.4, 0.4, 0.6, M.beacon, mx - 3.4, my2 + 1.85, mz - 3.4, 10));
    box(0.9, 0.12, 0.9, M.struct, mx - 3.4, my2 + 2.35, mz - 3.4);
    // warning board facing the approach road
    const board = new THREE.Group();
    board.position.set(mx + 0.5, my2 + 1.5, mz + 5.6);
    board.rotation.y = Math.atan2(mx - 20 - (mx + 0.5), mz - 6 - (mz + 5.6));
    box(2.4, 1.1, 0.1, M.dark, 0, 0, 0, board);
    box(2.0, 0.5, 0.06, M.hazard, 0, 0.05, 0.09, board);
    G.add(board);
    infoZones.push({
      key: 'tanks', pos: [mx, mz], r: 12, tag: 'ALERT · PROPULSION LEAK',
      name: '推进剂泄漏点', params: ['BOG 回收管线 3 路 · 真空夹套', '按住交互键（键盘 E / 触屏「交互」）约 3 秒'],
      fact: '萨巴蒂尔反应器把 CO₂ 变成甲烷——泄漏的每一口都是回家的燃料。',
      objective: '靠近红色警报阀门组 · 按住交互键约 3 秒',
    });
  }

  // ══════════ COMMS — dish knoll ══════════
  {
    const [cx2, cz2] = ZONES.comms.pos;
    k('platform_high', cx2, cz2, 0.2, 1.6);
    k('platform_low', cx2 - 6, cz2 + 8, 1.1, 1.2);
    k('satelliteDish_detailed', cx2 - 1, cz2, 0.15, 2.3);   // the big ear
    k('satelliteDish', cx2 + 9, cz2 - 6, 1.2);
    k('satelliteDish', cx2 + 4, cz2 + 9, 2.9, 0.75);
    k('machine_wireless', cx2 - 9, cz2 + 6, 0.5);
    k('supports_high', cx2 + 10, cz2 + 3, 1.9);
    k('hangar_smallA', cx2 - 10, cz2 + 11, 2.4);            // the listening post
    k('desk_computer', cx2 - 6, cz2 + 8, 1.9);              // outdoor console on the low deck
    k('rail', cx2 - 3, cz2 + 10, 0.35);
    k('astronautA', cx2 - 4, cz2 + 7, 2.6);                 // whoever is on shift, listening to Earth
    colliders.push({ x: cx2 - 1, z: cz2, r: 5 }, { x: cx2 + 9, z: cz2 - 6, r: 3 }, { x: cx2 + 4, z: cz2 + 9, r: 2.6 }, { x: cx2 - 10, z: cz2 + 11, r: 5 });
    putDeck('teleport_pad', cx2 - 9, cz2 - 8, 1.0, 0, -0.08);
    teleports.push({ key: 'comms', name: ZONES.comms.name, x: cx2 - 9, z: cz2 - 8 });
    const cy = zoneY(ZONES.comms);
    beacons.push(cyl(0.3, 0.3, 0.45, M.beacon, cx2 + 4.6, cy + 4.4, cz2 + 1.5, 10));  // on the big dish's rim
    infoZones.push({
      key: 'comms', pos: [cx2, cz2], r: 22, tag: 'DEEP SPACE NETWORK · NODE M1',
      name: '通讯阵列', params: ['主碟 7.3 m · X 波段', '与地球单程时延 4–24 分钟', '日出日落各一次全星通联'],
      fact: '和地球说话要等二十分钟回音。所以基地里的人，早就学会了自己解决问题。',
    });
  }

  // ══════════ SCIENCE — crystal grove & field lab ══════════
  {
    const [sx, sz] = ZONES.science.pos;
    k('platform_low', sx, sz + 2, 0.4, 1.7);
    // a big alien growth the whole zone orbits around
    const big = put('crystal', sx - 2, sz - 3, 2.6, 0.5, 0.6);
    big.traverse(o => { if (o.isMesh) o.material = M.crystal; });
    for (const [dx, dz, cs] of [[7, 4, 1.05], [-9, 5, 0.8], [3, 9, 0.62], [-5, -9, 0.9]]) {
      const c = put('crystal', sx + dx, sz + dz, cs, dx * dz, cs * 0.34);
      c.traverse(o => { if (o.isMesh) o.material = M.crystal; });
      colliders.push({ x: sx + dx, z: sz + dz, r: 1.2 });
    }
    colliders.push({ x: sx - 2, z: sz - 3, r: 2.6 });
    k('desk_computer', sx + 9, sz - 4, 2.2);
    k('craft_speederA', sx - 11, sz - 2, 1.1, 0.8);
    k('craterLarge', sx + 14, sz + 12, 0.7, 1.3);
    putDeck('teleport_pad', sx + 4, sz + 10, 1.0, 0, -0.08);
    teleports.push({ key: 'science', name: ZONES.science.name, x: sx + 4, z: sz + 10 });
    infoZones.push({
      key: 'science', pos: [sx, sz], r: 20, tag: 'FIELD SCIENCE · ANOMALY 07',
      name: '晶体科研区', params: ['撞击玻璃 / 层状硅酸盐 / 橄榄石', '大晶体形成年代：约 37 亿年前', '样本驾驶驶近即可自动采集'],
      fact: '每块岩石都是一页未读的书。好奇号在盖尔坑读了十年。',
    });
  }

  // ══════════ WATCH DECK — the grandstand for the launch ══════════
  {
    const [wx, wz] = ZONES.watch.pos;
    const wy = Math.max(...Array.from({ length: 24 }, (_, i) => {
      const a = i / 24 * 6.283, rr = (i % 3) / 2 * 7;
      return surfaceAt(wx + Math.cos(a) * rr, wz + Math.sin(a) * rr);
    }));
    const deckTop = wy + 0.5;
    cyl(8, 8.3, 1, M.white, wx, deckTop - 0.5, wz, 32);
    for (let i = 0; i < 14; i++) {
      const a = i / 14 * 6.283;
      cyl(0.05, 0.05, 1.1, M.struct, wx + Math.cos(a) * 7.6, deckTop + 0.55, wz + Math.sin(a) * 7.6, 6);
    }
    const rail = new THREE.Mesh(new THREE.TorusGeometry(7.7, 0.07, 6, 40), M.struct);
    rail.rotation.x = Math.PI / 2; rail.position.set(wx, deckTop + 1.1, wz); G.add(rail);
    // seats facing the pad + telemetry board angled back at the crowd
    k('stairs', wx - 3.5, wz + 2, -2.24, 0.9);
    const boardX = wx + 6.8, boardZ = wz + 1.5;
    const board = new THREE.Group(); board.position.set(boardX, deckTop + 2.3, boardZ);
    board.rotation.y = Math.atan2(wx - boardX, wz - boardZ);
    box(3.2, 1.7, 0.16, M.dark, 0, 0, 0, board);
    box(2.8, 1.2, 0.05, M.warmWin, 0, 0.05, 0.11, board);
    box(0.24, 2.2, 0.24, M.struct, 0, -1.3, 0, board);
    G.add(board);
    // `top` lets the chase camera fly over; the rover parks on the deck
    colliders.push({ x: wx, z: wz, r: 9, top: deckTop + 0.25, floor: deckTop });
    infoZones.push({
      key: 'watch', pos: [wx, wz], r: 20, tag: 'VIEWING DECK · SAFE DIST 60 m',
      name: '发射观礼台', params: ['视角方位直指 PAD ONE', '点火后 60 m 处会感到大气的轻推'],
      fact: '任务完成后回到这里——星舰点火时，火星的大气会把你轻轻推回座椅。',
      objective: 'drive: 等待发射窗口（完成任务线后触发）',
    });
  }

  // ══════════ NIGHT HILL — scope + lantern ring on the rim ══════════
  {
    const [nx, nz] = ZONES.night.pos;
    const ny = surfaceAt(nx, nz);
    put('habitat_dome', nx + 6, nz - 4, 0.7, 1.7);
    colliders.push({ x: nx + 6, z: nz - 4, r: 3.6 });
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * 2.6 + 2.4;
      const lx = nx + Math.cos(a) * 9, lz = nz + Math.sin(a) * 9;
      put('lamp', lx, lz, 1.3, a, 0);
    }
    cyl(0.3, 0.45, 1.8, M.struct, nx - 7, ny + 0.9, nz - 6, 10);
    const scope = cyl(0.45, 0.62, 2.8, M.white, nx - 7, ny + 2.8, nz - 6, 12);
    scope.rotation.x = -0.7;
    colliders.push({ x: nx - 7, z: nz - 6, r: 1.6 });
    infoZones.push({
      key: 'night', pos: [nx, nz], r: 18, tag: 'OBSERVATION HILL',
      name: '夜空观赏丘', params: ['夜晚：按 N 快进到午夜', '灯光秀：夜晚靠近星舰按 E'],
      fact: '火星的夜晚没有光污染。银河像一道旧伤疤横贯天顶，地球只是其中一颗不特别亮的星。',
    });
  }

  // ══════════ WRECK FIELD — the Dawn-7 freight lander ══════════
  let wreckPos = null;
  {
    const [yx, yz] = ZONES.storm.pos;
    const wy2 = surfaceAt(yx, yz);
    wreckPos = new THREE.Vector3(yx, wy2, yz);
    const w = put('lander', yx, yz, 1.15, 0.6, 0.45);
    w.rotation.z = 1.45; w.rotation.x = 0.25;         // down on its side
    colliders.push({ x: yx, z: yz, r: 7 });
    k('barrel', yx + 9, yz + 4, 1.9);
    k('barrel', yx + 11, yz + 1, -0.4);
    k('craft_speederA', yx - 8, yz + 8, 0.9, 0.7);    // the rescue craft that found it
    for (let i = 0; i < 5; i++) {
      const a = i * 1.7;
      k('terrain_roadStraight', yx - 14 + Math.cos(a) * (i * 3.5), yz - 6 + Math.sin(a) * (i * 2.8), a, 0.7); // scorch debris strip
    }
    cyl(0.25, 0.3, 6, M.struct, yx - 8, wy2 + 3, yz - 7, 8);
    beacons.push(cyl(0.55, 0.55, 0.9, M.beacon, yx - 8, wy2 + 6.4, yz - 7, 10));
    infoZones.push({
      key: 'storm', pos: [yx, yz], r: 24, tag: 'HAZARD ZONE · AEOLIS FIELD',
      name: '残骸场 · 货运飞船“黎明号”', params: ['上次事件：全球性沙尘暴 Sol 388', '太阳能板蒙尘之后，机遇号也这样安静下来'],
      fact: '火星的沙尘暴可以持续数月、覆盖整个星球。驶近时按 N 到午夜再来看它，灯笼会替你先亮着。',
    });
  }

  // ══════════ ROADSTER easter egg ══════════
  {
    const [rx, rz] = ZONES.roadster.pos;
    const ry = surfaceAt(rx, rz);
    const car = new THREE.Group(); car.position.set(rx, ry, rz); car.rotation.y = 2.55; // nose points out at the rim
    const paint = new THREE.MeshPhysicalMaterial({ color: 0xa81414, roughness: 0.26, metalness: 0.5, clearcoat: 0.85, clearcoatRoughness: 0.15, envMapIntensity: 1.2 });
    const glassDark = new THREE.MeshPhysicalMaterial({ color: 0x0d1620, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.6 });
    const suitMat = new THREE.MeshStandardMaterial({ color: 0xe6e2d8, roughness: 0.62, metalness: 0.05 });
    box(1.9, 0.4, 4.4, paint, 0, 0.66, 0, car);
    box(1.62, 0.42, 1.5, paint, 0, 0.72, -1.75, car);
    box(1.5, 0.34, 1.25, paint, 0, 0.78, 1.7, car);
    box(1.42, 0.56, 1.35, paint, 0, 0.98, 0.35, car);
    box(1.24, 0.5, 0.1, glassDark, 0, 1.16, -0.42, car).rotation.x = -0.5;
    for (const s of [-1, 1]) {
      box(0.5, 0.5, 1.45, paint, s * 0.86, 0.72, -1.5, car).rotation.z = s * 0.16;
      box(0.5, 0.46, 1.3, paint, s * 0.86, 0.72, 1.55, car).rotation.z = s * 0.16;
      const lampB = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), M.goldLight);
      lampB.position.set(s * 0.6, 0.86, -2.48); car.add(lampB);
    }
    const tyre = new THREE.MeshStandardMaterial({ color: 0x14120f, roughness: 0.95 });
    for (const [wxp, wzp] of [[-1.06, -1.5], [1.06, -1.5], [-1.06, 1.55], [1.06, 1.55]]) {
      cyl(0.58, 0.58, 0.38, tyre, wxp, 0.58, wzp, 16, car).rotation.z = Math.PI / 2;
      cyl(0.3, 0.3, 0.4, M.struct, wxp, 0.58, wzp, 12, car).rotation.z = Math.PI / 2;
    }
    const star = new THREE.Group(); star.position.set(0, 0.78, 0.42);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.29, 0.4, 6, 12), suitMat);
    torso.position.y = 0.42; star.add(torso);
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), suitMat);
    helm.position.y = 0.9; star.add(helm);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.225, 16, 12), new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 1, roughness: 0.12, envMapIntensity: 1.5 }));
    visor.position.set(0, 0.92, -0.1); visor.scale.set(0.95, 0.8, 0.5); star.add(visor);
    car.add(star);
    car.traverse(o => { if (o.isMesh) o.castShadow = true; });
    G.add(car);
    colliders.push({ x: rx, z: rz, r: 3.2 });
    // a small cairn of sample crates so the spot reads as visited
    k('desk_computer', rx + 4, rz - 3, 1.8, 0.7);
    infoZones.push({
      key: 'roadster', pos: [rx, rz], r: 12, tag: 'EASTER EGG · DO NOT TOUCH',
      name: '隐藏彩蛋：午夜公路', params: ['2018 年发射 · 飞行 8 年后迫降火星', '乘客：Starman'],
      fact: '“Don’t Panic.” —— 他终于到站了。',
    });
  }

  // ══════════ SAMPLES — six glowing crystals around the island ══════════
  const samples = [];
  {
    const rand = mulberry32(1234);
    const anchors = [[86, 60], [-80, 66], [95, -30], [-30, 95], [35, -92], [-90, -35]];
    for (const [ax2, az2] of anchors) {
      const x = ax2 + (rand() - 0.5) * 14, z = az2 + (rand() - 0.5) * 14;
      const y = surfaceAt(x, z);
      const g4 = new THREE.Group(); g4.position.set(x, y, z);
      const c = cloneModel(models['crystal']);
      c.scale.setScalar(0.6 + rand() * 0.35);
      c.position.y = 0.24 * c.scale.x;
      c.traverse(o => { if (o.isMesh) o.material = M.crystal; });
      g4.add(c);
      // thin beam + soft ground ring: legible at speed, not a video-game pillar
      const halo = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.9, 3.6, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xa8ece0, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }));
      halo.position.y = 1.9; g4.add(halo);
      const pad2 = new THREE.Mesh(new THREE.CircleGeometry(1.3, 20),
        new THREE.MeshBasicMaterial({ color: 0x8fdccf, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
      pad2.rotation.x = -Math.PI / 2; pad2.position.y = 0.07; g4.add(pad2);
      G.add(g4);
      samples.push({ group: g4, crystal: c, x, z, taken: false });
    }
    infoZones.push({
      key: 'samples', pos: [0, 0], r: 9999, tag: 'FIELD SCIENCE',
      name: '火星矿物样本', params: ['撞击玻璃 / 层状硅酸盐 / 橄榄石', '驾驶驶近即可自动采集', `集齐 ${SAMPLE_COUNT} 块解锁发射窗口`],
      fact: '每块岩石都是一页未读的书。',
    });
  }

  // ══════════ ROAD SETTING — lamps + centerline tiles between zones ══════════
  {
    const pairs = [
      [ZONES.hub.pos, ZONES.launch.pos], [ZONES.hub.pos, ZONES.habitat.pos],
      [ZONES.hub.pos, ZONES.industry.pos], [ZONES.hub.pos, ZONES.comms.pos],
      [ZONES.hub.pos, ZONES.science.pos], [ZONES.launch.pos, ZONES.watch.pos],
      [ZONES.watch.pos, ZONES.comms.pos],
    ];
    for (const [a, b] of pairs) {
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
      const n = Math.max(3, Math.round(l / 13));
      const yaw = Math.atan2(dx, dz);
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const x = a[0] + dx * t, z = a[1] + dz * t;
        k('terrain_roadStraight', x, z, yaw, 0.9);
        if (i % 2 === 0) {
          const ox = dz / l * 4.6, oz = -dx / l * 4.6;
          const side = (i % 4 === 2) ? 1 : -1;
          put('lamp', x + ox * side, z + oz * side, 1.05, yaw + (side > 0 ? Math.PI / 2 : -Math.PI / 2), 0);
        }
      }
    }
  }

  G.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // Thin masts, lamp posts and stanchions are not colliders, so the chase camera happily parks
  // itself directly behind one and the shot becomes a black slab. Give every slender vertical
  // instance its own materials so the rig can fade it out while it sits on the camera→rover line.
  const occluders = [];
  {
    const box = new THREE.Box3(), sz = new THREE.Vector3(), ctr = new THREE.Vector3();
    // cloning a material the per-frame rig still animates would silently disconnect it
    const animated = new Set([...padGlow, ...beacons.map(b => b.material), ...lightStrips, ...lightRings.map(r => r.material), ...showBeamMats, ...shipMats]);
    G.updateMatrixWorld(true);
    for (const inst of G.children) {
      if (!inst.isGroup || inst.children.length === 0) continue;
      box.setFromObject(inst);
      box.getSize(sz); box.getCenter(ctr);
      if (sz.y < 2.2 || Math.max(sz.x, sz.z) > 2.0) continue;
      let blocked = false;
      inst.traverse(o => {
        if (!o.isMesh) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (animated.has(m)) blocked = true;
      });
      if (blocked) continue;
      const mats = [];
      inst.traverse(o => {
        if (!o.isMesh) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        const cl = list.map(m => m.clone());
        o.material = Array.isArray(o.material) ? cl : cl[0];
        mats.push(...cl);
      });
      occluders.push({ inst, mats, x: ctr.x, z: ctr.z, r: Math.max(0.9, Math.hypot(sz.x, sz.z) * 0.5), f: 1 });
    }
  }

  // ══════════ BASE GRID — one reactor tap beside every teleport pad ══════════
  // Five outer districts start blacked out and the rover's battery is the only mobile relay,
  // so each tap needs its own materials: the base-wide emissive sets are shared and cannot be
  // dimmed per district. Deliberately emissive-only (no PointLight) — the whole scene is lit by
  // sun/hemi plus bloom, and six extra dynamic lights would recompile every standard shader.
  const gridRigs = [];
  {
    const iron = new THREE.MeshStandardMaterial({ color: 0x5a544b, roughness: 0.44, metalness: 0.86 });
    const soot = new THREE.MeshStandardMaterial({ color: 0x2a2825, roughness: 0.72, metalness: 0.5 });
    for (const tp of teleports) {
      const rad = Math.hypot(tp.x, tp.z) || 1;
      const rx = tp.x + (tp.x / rad) * 4.4, rz = tp.z + (tp.z / rad) * 4.4;
      const rig = new THREE.Group();
      rig.position.set(rx, rimY(rx, rz, 2.05) - 0.06, rz);
      rig.rotation.y = Math.atan2(tp.x - rx, tp.z - rz);
      G.add(rig);

      // ── the tap has to read as a substation you can drive up to and recognise from 100 m:
      // bolted plinth, finned transformer drum, insulator bushings, a braced lattice mast,
      // then the reactor core hung in a cage above the service deck.
      cyl(1.85, 2.05, 0.26, soot, 0, 0.13, 0, 8, rig);        // octagonal foundation
      cyl(1.42, 1.42, 0.14, iron, 0, 0.33, 0, 8, rig);        // bolted flange
      for (let i = 0; i < 8; i++) {
        const a = i * 0.7854 + 0.39;
        box(0.14, 0.13, 0.14, soot, Math.sin(a) * 1.42, 0.46, Math.cos(a) * 1.42, rig);
      }

      cyl(0.6, 0.62, 1.0, iron, 0, 0.92, 0, 12, rig);         // transformer drum
      for (let i = 0; i < 12; i++) {                          // cooling fins
        const a = i * 0.5236;
        const fin = box(0.045, 0.82, 0.24, soot, Math.sin(a) * 0.68, 0.92, Math.cos(a) * 0.68, rig);
        fin.rotation.y = -a;
      }
      cyl(0.44, 0.58, 0.16, soot, 0, 1.5, 0, 12, rig);        // conservator cap
      for (let i = 0; i < 3; i++) {                           // porcelain bushings
        const a = i * 2.094 + 0.5, bx = Math.sin(a) * 0.33, bz = Math.cos(a) * 0.33;
        for (let d = 0; d < 3; d++) cyl(0.145 - d * 0.015, 0.165 - d * 0.015, 0.05, soot, bx, 1.66 + d * 0.13, bz, 8, rig);
        cyl(0.03, 0.03, 0.46, iron, bx, 1.98, bz, 6, rig);
      }

      const MS = 0.6, Y0 = 2.2, Y1 = 4.7, TIER = (Y1 - Y0) / 3;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.1, Y1 - Y0 + 0.3, 0.1, iron, sx * MS, (Y0 + Y1) / 2, sz * MS, rig);
      const braceZ = Math.atan2(MS * 2, TIER);
      for (let k = 0; k < 4; k++) {
        const face = new THREE.Group();
        face.rotation.y = k * Math.PI / 2;
        rig.add(face);
        const at = (w, h, d, mat, x, y) => { const b = box(w, h, d, mat, x, y, MS, face); return b; };
        for (let t = 0; t <= 3; t++) at(MS * 2, 0.07, 0.06, iron, 0, Y0 + t * TIER);
        for (let t = 0; t < 3; t++) {
          const yc = Y0 + (t + 0.5) * TIER, L = Math.hypot(MS * 2, TIER) + 0.06;
          at(0.05, L, 0.05, soot, 0, yc).rotation.z = braceZ;
          at(0.05, L, 0.05, soot, 0, yc).rotation.z = -braceZ;
        }
      }
      box(1.5, 0.11, 1.5, iron, 0, Y1 + 0.06, 0, rig);       // service deck
      for (let k = 0; k < 4; k++) {
        const a = k * Math.PI / 2;
        const rail = box(1.44, 0.045, 0.045, soot, Math.sin(a) * 0.7, Y1 + 0.52, Math.cos(a) * 0.7, rig);
        rail.rotation.y = a;
      }
      // cable run back to the pad so the two read as one installation — the ground falls away
      // between the two bases, so each anchor has to be sampled where it actually lands
      for (let i = 1; i <= 4; i++) {
        const lz = -1.6 - (i / 5) * 2.0;
        const wx = rx + Math.sin(rig.rotation.y) * lz, wz = rz + Math.cos(rig.rotation.y) * lz;
        box(0.11, 0.13, 0.11, soot, 0, surfaceAt(wx, wz) + 0.06 - (rig.position.y), lz, rig);
      }

      const coreMat = new THREE.MeshStandardMaterial({ color: 0x101a1f, emissive: 0x4fe2ff, emissiveIntensity: 0, roughness: 0.2, metalness: 0.1 });
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 0), coreMat);
      core.position.y = 5.85; core.castShadow = true; rig.add(core);
      const yoke = new THREE.Mesh(new THREE.TorusGeometry(0.92, 0.055, 6, 20), iron);
      yoke.position.y = 5.85; yoke.rotation.x = Math.PI / 2; yoke.castShadow = true; rig.add(yoke);
      for (let i = 0; i < 4; i++) {                            // cage bars over the core
        const a = i * 1.5708;
        const bar = box(0.055, 1.5, 0.055, iron, Math.sin(a) * 0.72, 5.85, Math.cos(a) * 0.72, rig);
        bar.rotation.z = Math.sin(a) * 0.24; bar.rotation.x = -Math.cos(a) * 0.24;
      }
      cyl(0.1, 0.14, 0.9, iron, 0, 5.0, 0, 8, rig);           // hanger post off the deck
      const plateMat = new THREE.MeshBasicMaterial({ color: 0x4fe2ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const plate = new THREE.Mesh(new THREE.CircleGeometry(1.35, 6), plateMat);
      plate.rotation.x = -Math.PI / 2; plate.position.y = 0.42; rig.add(plate);
      const beamMat = new THREE.MeshBasicMaterial({ color: 0x6fe8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      // a shaft you navigate by at night, not a pole — shallow flare, and it dies away in daylight
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 0.14, 15, 6, 1, true), beamMat);
      beam.position.y = core.position.y + 7.5; rig.add(beam);
      // the additive halo meshes must not cast — a shadow-casting light shaft reads as a solid pole
      for (const o of rig.children) if (o !== beam && o !== plate) { o.castShadow = true; o.receiveShadow = true; }

      gridRigs.push({ key: tp.key, name: tp.name, tp, x: rx, z: rz, power: 0, shown: -1, core, beam, plate, mats: [coreMat, plateMat, beamMat] });
      colliders.push({ x: rx, z: rz, r: 2.2 });
    }
  }

  scene.add(G);
  const flamePoint = new THREE.Vector3(SHIP_POS[0], 1.6, SHIP_POS[1]);
  return {
    group: G, colliders, infoZones, samples, sparkPoints, beacons, lightStrips, lightRings, showBeams, showBeamMats, shipMats, shipGroup, teleports, padGlow, heroLights, occluders, gridRigs,
    leakPoint: new THREE.Vector3(LEAK_POS[0], surfaceAt(LEAK_POS[0], LEAK_POS[1]) + 1.8, LEAK_POS[1]),
    flamePoint,
    launchPadPos: new THREE.Vector3(...ZONES.launch.pos),
    wreckPos,
    watchPos: new THREE.Vector3(ZONES.watch.pos[0], surfaceAt(...ZONES.watch.pos), ZONES.watch.pos[1]),
  };
}
