import * as THREE from 'three';
import { QUALITIES, ZONES, START, SAMPLE_COUNT } from './config.js';
import { createSky } from './world/sky.js';
import { createTerrain, createRocks, createStones } from './world/terrain.js';
import { Environment } from './world/environment.js';
import { buildBase } from './world/props.js';
import { surfaceAt, surfaceSlope } from './world/height.js';
import { createRover } from './vehicle/rover.js';
import { RoverPhysics, platformAt } from './vehicle/physics.js';
import { ChaseCamera } from './camera/chase.js';
import { createInput } from './input.js';
import { createFX, updateStorm } from './fx/particles.js';
import { createPost } from './fx/post.js';
import { createSkidMarks } from './fx/skids.js';
import { GameAudio } from './audio/audio.js';
import { UI, fmtTime } from './ui.js';

const $ = id => document.getElementById(id);
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.4, 9000);

const input = createInput(canvas);
const audio = new GameAudio();

let quality, qKey, post, fx, env, sky, base, rover, phys, chase, skids;
let started = false, paused = false;
let startedAt = 0;       // performance.now() at the moment the world became interactive
let elapsed = 0;
const clock = new THREE.Clock();
const tmpV = new THREE.Vector3();

// ───────────────────────── game state ─────────────────────────
// One dark district per teleport pad outside the hub — derived from ZONES so props.js can never
// drift away from the mission text.
const GRID_COUNT = Object.values(ZONES).filter(z => z.teleport).length - 1;
const missions = [
  { id: 'grid', text: `重启基地电网 0/${GRID_COUNT}`, done: false },
  { id: 'inspect', text: '巡检轨道发射台', done: false },
  { id: 'leak', text: '修复储罐区泄漏', done: false },
  { id: 'samples', text: `采集火星样本 0/${SAMPLE_COUNT}`, done: false },
  { id: 'watch', text: '返回发射观礼台 · 见证星舰升空', done: false },
];
let activeMission = 0, leakFixed = false, repairHold = 0, samplesTaken = 0;
let launchArmed = false;
const mAct = () => missions[activeMission]?.id;

// ─── rover battery + base grid ───
// bruno-simon.com has no objective beyond driving; this is the loop that has to beat it.
// Five districts are blacked out and the rover is the only mobile relay, so every link costs
// charge, every restored pad becomes both a charger and a jump gate, and the base visibly
// brightens district by district instead of all at once at the end.
const grid = { battery: 1, online: 0, target: null, linkT: 0, dead: false, recover: 0, lowWarned: false };
const LINK_RADIUS = 9, LINK_TIME = 4, LINK_DRAIN = 0.02, LINK_MIN = 0.12;
const launch = { phase: 'idle', t: 0, cd: 11, y: 0, vy: 0, tilt: 0, intensity: 0, flash: 0, doneAt: 0 };
let showOn = 0;          // night light-show timer
let demoPin = null;      // demo cinematic: hold the rover parked
const race = { active: false, idx: 0, t: 0, gates: [], rings: [] };
const photo = { on: false, yaw: 0, pitch: 0.25, dist: 14, dragging: false, lx: 0, ly: 0 };
let degradeLevel = 0;

// ───────────────────────── teleport network ─────────────────────────
let padHere = null, teleOpen = false, teleEl = null, teleMap = null, teleHint = null;
let lastPadShown = false;
function buildTeleportUI() {
  teleEl = document.createElement('div');
  teleEl.id = 'teleport-ui'; teleEl.className = 'hidden';
  teleEl.innerHTML = `
    <div class="tp-head"><span class="tp-title">✦ 传送网络 · TELEPORT NETWORK</span>
      <button class="tp-close" aria-label="close">✕</button></div>
    <div class="tp-body"><canvas class="tp-map" width="252" height="252"></canvas><div class="tp-list"></div></div>
    <div class="tp-tip">数字键 1-6 直接跃迁 · 按 G 在光台上就地开启 · M 全区地图</div>`;
  document.body.appendChild(teleEl);
  teleMap = teleEl.querySelector('.tp-map');
  teleEl.querySelector('.tp-close').onclick = closeTeleport;
  teleHint = document.createElement('div');
  teleHint.id = 'tele-hint'; teleHint.className = 'hidden';
  document.body.appendChild(teleHint);
  const fab = document.createElement('button');
  fab.id = 'tele-fab'; fab.className = 'hidden'; fab.textContent = '✦ 传送 · MAP';
  fab.onclick = () => { if (teleOpen) closeTeleport(); else openTeleport(); };
  document.body.appendChild(fab);
  teleHint._fab = fab;
  const mute = document.createElement('button');
  mute.id = 'mute-fab'; mute.className = 'hidden';
  const draw = () => { mute.textContent = audio.muted ? '音效 关' : '音效 开'; };
  draw(); mute._draw = draw;
  mute.onclick = () => { audio.setMuted(!audio.muted); draw(); };
  document.body.appendChild(mute);
  teleHint._mute = mute;
  teleMap.addEventListener('click', e => {
    const r = teleMap.getBoundingClientRect();
    const mx = (e.clientX - r.left) / r.width * 2 - 1, mz = (e.clientY - r.top) / r.height * 2 - 1;
    let best = null, bd = 0.22;
    for (const tp of base.teleports) {
      if (tp.online === false) continue;
      const d = Math.hypot(tp.x / 132 - mx, tp.z / 132 - mz);
      if (d < bd) { bd = d; best = tp; }
    }
    if (best) teleportTo(best); else UI.toast('⛔ 该区电网未恢复 — 光台无法成像');
  });
}
function openTeleport() {
  if (teleOpen) return;
  teleOpen = true;
  teleEl.classList.remove('hidden');
  const list = teleEl.querySelector('.tp-list');
  list.innerHTML = '';
  base.teleports.forEach((tp, i) => {
    const b = document.createElement('button');
    b.className = 'tp-item';
    const dist = Math.hypot(phys.x - tp.x, phys.z - tp.z);
    const onPad = padHere === tp;
    const live = tp.online !== false;
    b.innerHTML = `<kbd>${i + 1}</kbd><span class="tp-name">${live ? '' : '⛔ '}${tp.name}</span><span class="tp-dist">${onPad ? '你在这里' : live ? Math.round(dist) + ' m' : '无电'}</span>`;
    b.disabled = onPad || !live;
    b.onclick = () => teleportTo(tp);
    list.appendChild(b);
  });
}
function closeTeleport() { teleOpen = false; teleEl?.classList.add('hidden'); }
function teleportTo(tp, opt = {}) {
  const x = tp.x + 4.6, z = tp.z + 4.6;
  phys.x = x; phys.z = z; phys.y = platformAt(base.colliders, x, z) + 0.9;
  phys.vx = phys.vy = phys.vz = 0; phys.speed = 0; phys.trauma = 0.3;
  phys.yaw = Math.atan2(tp.x - x, tp.z - z);
  demoPin = null;
  closeTeleport();
  const fl = document.createElement('div'); fl.className = 'tp-flash';
  document.body.appendChild(fl);
  setTimeout(() => fl.remove(), 620);
  if (!opt.silent) UI.toast(`✦ 跃迁完成 — ${tp.name}`);
  if (opt.silent) audio.radio('bad'); else if (audio.play) audio.play('warp', 0.4); else audio.radio('good');
}
function drawTeleMap() {
  const g = teleMap.getContext('2d'), W = 252, c = W / 2, k = (W / 2 - 10) / 132;
  g.clearRect(0, 0, W, W);
  g.fillStyle = 'rgba(255,150,90,.08)';
  g.beginPath(); g.arc(c, c, 118 * k, 0, 7); g.fill();
  g.strokeStyle = 'rgba(255,170,110,.35)'; g.lineWidth = 1.5; g.stroke();
  g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 5;
  for (const tp of base.teleports) {
    g.beginPath(); g.moveTo(c, c); g.lineTo(c + tp.x * k, c + tp.z * k); g.stroke();
  }
  for (const tp of base.teleports) {
    const x = c + tp.x * k, y = c + tp.z * k;
    const live = tp.online !== false;
    g.fillStyle = padHere === tp ? '#7df2ff' : live ? '#38c7e0' : '#5b4f45';
    g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill();
    g.fillStyle = live ? '#e9e4da' : '#8a7d70';
    g.font = '11px sans-serif'; g.textAlign = 'center';
    g.fillText(tp.name, x, y - 10);
  }
  g.fillStyle = '#ffbe5c';
  g.beginPath(); g.arc(c + phys.x * k, c + phys.z * k, 4, 0, 7); g.fill();
}

// ───────────────────────── loading ─────────────────────────
function setBar(p, text) {
  $('load-bar').style.width = `${p}%`;
  if (text) $('load-text').textContent = text;
}
// yield one frame, with a timeout fallback so loading never stalls in hidden/background tabs
const raf = () => Promise.race([
  new Promise(r => requestAnimationFrame(r)),
  new Promise(r => setTimeout(r, 30)),
]);

function autoDetect() {
  const touch = 'ontouchstart' in window;
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
  const cores = navigator.hardwareConcurrency || 4;
  if (touch && cores <= 6) return 'low';
  if (touch) return 'med';
  if (/RTX|RX 7|Apple M[2-4]/i.test(gpu)) return 'ultra';
  if (/GTX|RTX|RX |Apple M/i.test(gpu)) return 'high';
  if (cores >= 8) return 'high';
  return 'med';
}

async function boot() {
  setBar(4, '校准地形高度场…'); await raf(); await raf();
  sky = createSky(scene);
  setBar(22, ' sculpting 火星孤岛 · 300m 程序化沙丘…'); await raf();
  createTerrain(scene);
  setBar(44, '撞击坑与岩石风化场…'); await raf();
  await createRocks(scene);
  createStones(scene);
  setBar(56, '载入 Blender 建模的星舰基地资产…'); await raf();
  base = await buildBase(scene, { particles: 1 });
  // the hub tap is the always-live mains feed; every other district starts blacked out
  for (const r of base.gridRigs) { r.online = r.key === 'hub'; r.power = r.online ? 1 : 0; r.tp.online = r.online; }
  UI.gridInit(base.teleports);
  setBar(74, '装配漫游车 RD-6 …'); await raf();
  rover = await createRover(scene);
  setBar(82, '启动火星大气模拟…'); await raf();
  phys = new RoverPhysics(START.pos[0], START.pos[1], START.heading);
  chase = new ChaseCamera(camera);
  // the camera needs the same footprint data as physics, plus ground height so it
  // may still fly over a low prop when the terrain lifts it
  chase.setColliders(base.colliders.map(c => ({ x: c.x, z: c.z, r: c.r, y: surfaceAt(c.x, c.z), top: c.top })));
  buildGates();
  addVolumetricCones();
  // Nothing in the frame may be a dead pixel. An albedo under the Mars sky's luminance renders as
  // a flat black cut-out, which is what turned the industrial frames into silhouettes. Lift every
  // opaque, unlit surface proportionally to how close to black it was, so rubber and soot stay
  // dark but never featureless — and do it scene-wide, because the props that needed it most were
  // never part of the GLB set.
  {
    const basalt = new THREE.Color(0.26, 0.19, 0.155);
    const done = new Set();
    scene.traverse(o => {
      if (!o.isMesh) return;
      // noMerge already means "this branch is authored on purpose" (animated rigs, the telescope's
      // matte lens) — the same escape hatch must exempt it here or every deliberate near-black lifts to brown
      for (let a = o; a; a = a.parent) if (a.userData.rsbNoMerge) return;
      for (const mt of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!mt || !mt.color || mt.transparent || done.has(mt.uuid)) continue;
        done.add(mt.uuid);
        if (mt.emissive && mt.emissive.getHex()) continue;
        const L = 0.299 * mt.color.r + 0.587 * mt.color.g + 0.114 * mt.color.b;
        if (L < 0.055) {
          mt.color.lerp(basalt, 1 - L / 0.055);
          mt.roughness = Math.max(mt.roughness ?? 0.6, 0.6);
        }
      }
    });
  }
  buildTeleportUI();
  setBar(92, '链路就绪 · 等待指令');
  await raf();
  $('loader').classList.add('hidden');
  $('menu').classList.remove('hidden');
  const rec = autoDetect();
  $('auto-tip').textContent = `已根据设备自动推荐：${QUALITIES[rec].label}画质 · GPU: ${(/NVIDIA|GeForce/i.test('x') ? 'NV' : '自适应')}`;
  document.querySelectorAll('.q-card').forEach(b => {
    if (b.dataset.q === rec) b.classList.add('rec');
    b.onclick = () => {
      document.querySelectorAll('.q-card').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel'); qKey = b.dataset.q;
      $('start-btn').disabled = false;
    };
    if (b.dataset.q === rec) { b.classList.add('sel'); qKey = b.dataset.q; $('start-btn').disabled = false; }
  });
}

// A frame costs pixels, not device ratios: 1.5× on a laptop and 1.5× on a 4K monitor differ by
// four times in area while the table only ever said "1.5". Solve for the ratio that fits the
// quality tier's pixel budget at this exact window size.
let renderCap = 1;
function solvePixelRatio() {
  const want = Math.min(devicePixelRatio, quality.pixelRatio * renderCap);
  const fit = Math.sqrt(quality.maxPixels * renderCap * renderCap / Math.max(1, innerWidth * innerHeight));
  return THREE.MathUtils.clamp(Math.min(want, fit), 0.55, 2);
}

function applyQuality() {
  quality = QUALITIES[qKey];
  renderCap = 1;
  degradeLevel = 0;
  renderer.setPixelRatio(solvePixelRatio());
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = quality.shadow > 0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  env = new Environment(scene, sky, quality);
  if (quality.shadow) env.sun.shadow.mapSize.set(quality.shadow, quality.shadow);
  fx = createFX(scene, quality);
  skids ??= createSkidMarks(scene);
  Object.values(fx).forEach(p => p.setPixelRatio(renderer.getPixelRatio()));
  post = createPost(renderer, scene, camera, quality, innerWidth, innerHeight);
  // Reflections are owned by Environment.update(): it captures the cube, runs it through
  // PMREMGenerator and publishes the result as scene.environment. Assigning the raw cube render
  // target here was the bug — MeshStandardMaterial has no IBL path for a non-PMREM map and reflects
  // literally nothing from one, so every metal in the base drew as a black silhouette on the sky.
  // The intensity below is split so dielectrics keep a whisper of sky fill and metals get a mirror.
  {
    const seen = new Set();
    scene.traverse(o => {
      if (!o.isMesh) return;
      for (const mt of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!mt || seen.has(mt.uuid) || mt.envMap) continue;
        seen.add(mt.uuid);
        // A step, not a switch. At a 0.25 cut-off the plaza's 'dark' panels (metalness 0.38) were
        // classed as mirrors and took the whole peach sky at 0.9, so the ground tiles rendered
        // periwinkle with white frames — the single loudest object in the arrival view. A
        // conductor's reflectance scales with its albedo and its metalness, so ramp it with both.
        mt.envMapIntensity = 0.22 + (mt.metalness ?? 0) * 0.7;
        mt.needsUpdate = true;
      }
    });
  }
  audio.leakPos = base.leakPoint;
  UI.setTop(env.state.clock, '晴朗', quality.label, 60);
  $('touch-ui').classList.toggle('hidden', !input.isTouch);
  document.body.classList.toggle('touch', input.isTouch);
  if (input.isTouch) input.bindStick();
}

// ───────────────────────── race gates & cones ─────────────────────────
function buildGates() {
  const ring = ['launch', 'watch', 'comms', 'industry', 'science', 'habitat'].map(k => ZONES[k].pos);
  const pts = ring.map((a, i) => {
    const b = ring[(i + 1) % ring.length];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  });
  const mat = new THREE.MeshBasicMaterial({ color: 0x33ff99, transparent: true, opacity: 0.65 });
  for (const [x, z] of pts) {
    const g = new THREE.Group();
    const rin = new THREE.Mesh(new THREE.TorusGeometry(6, 0.35, 8, 30), mat.clone());
    g.add(rin);
    g.position.set(x, surfaceAt(x, z) + 6.5, z);
    g.rotation.y = Math.random() * 3;
    g.visible = false;
    scene.add(g);
    race.gates.push({ x, z });
    race.rings.push(g);
  }
}
const cones = [];
function addVolumetricCones() {
  const [px, pz] = ZONES.launch.pos;
  const mat = new THREE.MeshBasicMaterial({ color: 0xa8c8ff, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  for (const [x, z, h, r] of [[px + 11, pz - 6, 44, 7], [px + 11, pz + 6, 44, 7], [ZONES.watch.pos[0], ZONES.watch.pos[1], 9, 4]]) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.4, r, h, 20, 1, true), mat.clone());
    c.position.set(x, h / 2, z);
    scene.add(c); cones.push(c);
  }
}

// ───────────────────────── missions UI ─────────────────────────
function renderMissions() {
  const arr = missions.map((m, i) => ({ text: m.text, done: m.done, active: i === activeMission && !m.done, extra: '' }));
  UI.renderMissions(arr);
}
function advanceMission() {
  while (activeMission < missions.length && missions[activeMission].done) activeMission++;
  renderMissions();
  const id = mAct();
  if (id === 'inspect') { UI.toast('▸ 新任务：电网恢复，巡检轨道发射台'); audio.radio('beep'); }
  if (id === 'leak') { UI.toast('▸ 新任务：储罐区检测到推进剂泄漏，前往修复'); audio.radio('beep'); }
  if (id === 'samples') { UI.toast(`▸ 新任务：采集 ${SAMPLE_COUNT} 块火星样本（发光信标处）`); audio.radio('beep'); }
  if (id === 'watch') { launchArmed = true; UI.toast('▸ 任务链完成 — 发射窗口开启，返回观礼台'); audio.radio('good'); }
  if (activeMission >= missions.length) UI.arrowAngle(phys, null);
}
function objectiveTarget() {
  const id = mAct();
  if (id === 'grid') {
    const r = base.gridRigs.find(r => r.power < 0.99 && r.key !== 'hub');
    return r ? new THREE.Vector3(r.x, surfaceAt(r.x, r.z) + 2, r.z) : null;
  }
  if (id === 'inspect') return base.launchPadPos;
  if (id === 'leak' && !leakFixed) return base.leakPoint;
  if (id === 'samples') {
    const s = base.samples.find(s => !s.taken);
    return s ? new THREE.Vector3(s.x, surfaceAt(s.x, s.z) + 1, s.z) : null;
  }
  if (id === 'watch') return base.watchPos;
  return null;
}

// ───────────────────────── battery + grid simulation ─────────────────────────
function districtRigs() { return base.gridRigs.filter(r => r.key !== 'hub'); }

function updateGrid(dt, st) {
  const rigs = districtRigs();
  const online = rigs.filter(r => r.online).length;
  if (online !== grid.online) {
    grid.online = online;
    if (mAct() === 'grid') { missions[0].text = `重启基地电网 ${online}/${GRID_COUNT}`; renderMissions(); }
  }

  // ── drain: the drivetrain, the lamps and the relay are all the same battery
  let use = 0.0015 + 0.006 * phys.enginePower + 0.00012 * phys.speed;
  if (st.nightF > 0.05) use += 0.0025 * st.nightF;
  if (grid.target && grid.linkT > 0) use += LINK_DRAIN;
  grid.battery = Math.max(0, grid.battery - use * dt);

  // ── charge: the hub tap is mains power, the outer pads are solar and die with the dust
  const pad = padHere && padHere.online ? padHere : null;
  if (pad && phys.speed < 1.4 && !grid.dead) {
    const sun = Math.max(0, st.dayF) * (1 - st.stormF * 0.8);
    const rate = pad.key === 'hub' ? 0.155 : 0.05 + 0.09 * sun;
    grid.battery = Math.min(1, grid.battery + rate * dt);
  }

  if (grid.battery <= 0 && !grid.dead) {
    grid.dead = true; grid.recover = 3; grid.linkT = 0;
    UI.toast('⚡ 电力耗尽 — 自动回收程序已呼叫，3 秒后拖回中央广场');
    audio.radio('bad');
  }
  if (grid.dead) {
    grid.recover -= dt;
    if (grid.recover <= 0) {
      const hub = base.teleports.find(tp => tp.key === 'hub') || base.teleports[0];
      teleportTo(hub, { silent: true });
      // teleportTo parks the rover beside the pad; a towed rover has to end up on the charger
      phys.x = hub.x; phys.z = hub.z; phys.y = platformAt(base.colliders, hub.x, hub.z) + 0.9;
      phys.vx = phys.vy = phys.vz = 0; phys.speed = 0;
      grid.battery = 0.38; grid.dead = false;
      UI.toast('◂ 拖回中央广场 — 光台补电中，电量 38%');
    }
  } else {
    if (!grid.lowWarned && grid.battery < 0.22) {
      grid.lowWarned = true;
      UI.toast('⚠ 电量低于 22% — 返回任一亮起的光台补电');
      audio.radio('bad');
    }
    if (grid.battery > 0.35) grid.lowWarned = false;
  }

  // ── linking: park beside a dark tap and hold; walking away bleeds the progress back
  let tgt = null, bd = LINK_RADIUS;
  for (const r of rigs) {
    if (r.online) continue;
    const d = Math.hypot(phys.x - r.x, phys.z - r.z);
    if (d < bd) { bd = d; tgt = r; }
  }
  grid.target = tgt;
  const canHold = !grid.dead && !!tgt && phys.speed < 1.6 && grid.battery > LINK_MIN;
  if (canHold) {
    grid.linkT = Math.min(LINK_TIME, grid.linkT + dt);
    tgt.power = Math.max(tgt.power, grid.linkT / LINK_TIME);
    if (tgt !== grid.link && !tgt.announced) { grid.link = tgt; tgt.announced = true; UI.toast(`◈ 开始并网 — 停在 ${tgt.name} 反应桩旁保持不动 4 秒`); }
    if (grid.linkT >= LINK_TIME) {
      tgt.online = true; tgt.power = 1; tgt.announced = false; grid.linkT = 0; grid.link = null;
      tgt.tp.online = true;   // the rig lights the district's jump gate — the pad reads its state off tp.online
      const done = rigs.filter(r => r.online).length;
      audio.radio('good');
      for (let i = 0; i < 26; i++) {
        const a = Math.random() * 6.283, s = 3 + Math.random() * 6;
        fx.spark.emit(tgt.x, 0.8, tgt.z, Math.sin(a) * s, 2 + Math.random() * 4, Math.cos(a) * s, 0.9, 2);
      }
      shockWave(tgt.x, surfaceAt(tgt.x, tgt.z) + 0.5, tgt.z);
      UI.toast(`✔ ${tgt.name} 已复电 — 光台跃迁解锁（${done}/${GRID_COUNT}）`);
      if (mAct() === 'grid') { missions[0].text = `重启基地电网 ${done}/${GRID_COUNT}`; renderMissions(); }
      if (done >= GRID_COUNT) onGridComplete();
    }
  } else {
    grid.linkT = Math.max(0, grid.linkT - dt * 1.6);
    grid.link = null;
    for (const r of rigs) if (!r.online) { r.power = Math.max(0, r.power - dt * 0.28); if (r.power < 0.05) r.announced = false; }
  }

  // ── rig visuals: dark iron by day, a lit column you can navigate by at night
  // The first day gate (0.45) still failed: a 1.2 m emissive octahedron at ei≈0.4 renders as a
  // flat saturated cyan diamond even below the bloom threshold — pure hue, no glow involved.
  // By day the core has to sit near-black inside its cage (0.10, same floor as the plaza studs),
  // and the additive hex plate under it must stop tinting the pad disc until dusk.
  for (const r of base.gridRigs) {
    const p = r.power, beat = 0.72 + 0.28 * Math.sin(elapsed * 2.6 + r.x * 0.3);
    r.core.material.emissiveIntensity = p * (0.10 + st.nightF * 5.3) * beat;
    r.core.rotation.y += dt * (0.4 + p * 2.6);
    r.mats[1].opacity = p * (0.02 + 0.73 * st.nightF) * beat;
    r.mats[2].opacity = p * (0.012 + 0.05 * st.nightF) * (1 - st.stormF * 0.6);
    if (r === grid.target && grid.linkT > 0) {
      // the tap you are currently welding flickers in amber so the hold has a target
      r.mats[1].opacity = 0.25 + 0.6 * Math.abs(Math.sin(elapsed * 7));
    }
  }
  const pct = {}; for (const r of base.gridRigs) pct[r.key] = r.power;
  UI.setBattery(grid.battery);
  UI.setGridStatus(pct, grid.target ? `并网 ${Math.round(grid.target.power * 100)}%` : '');
}

function onGridComplete() {
  missions[0].done = true;
  UI.toast('✦ 全区复电 — 基地电网满载，灯光亮度全开');
  audio.radio('good');
  advanceMission();
}


// ───────────────────────── launch sequence ─────────────────────────
function startCountdown() {
  if (race.active) { race.active = false; UI.raceShow(false); race.rings.forEach(r => r.visible = false); }
  launch.phase = 'countdown'; launch.cd = 10.0;
  UI.toast('⚠ 发射程序启动 · 请留在观礼台安全区');
}
function updateLaunch(dt) {
  const ship = base.shipGroup;
  if (launch.phase === 'countdown') {
    launch.cd -= dt;
    const n = Math.ceil(launch.cd);
    if (n !== launch.lastCd && n > 0) { launch.lastCd = n; UI.countdown(n); audio.cue(); }
    if (n <= 0) { UI.countdown('升空'); audio.radio('good'); launch.phase = 'ignition'; launch.t = 0; }
  } else if (launch.phase === 'ignition' || launch.phase === 'ascent' || launch.phase === 'fly') {
    launch.t += dt;
    const prox = THREE.MathUtils.clamp(1 - Math.hypot(phys.x - base.launchPadPos.x, phys.z - base.launchPadPos.z) / 140, 0.12, 1);
    if (launch.phase === 'ignition') {
      launch.intensity = Math.min(1, launch.t / 2.2);
      if (launch.t > 4.2 && !launch.shockDone) {
        launch.shockDone = true;
        launch.phase = 'ascent';
        launch.flash = 1;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(10, 1.4, 8, 40), new THREE.MeshBasicMaterial({ color: 0xffd8a0, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
        ring.rotation.x = Math.PI / 2; ring.position.set(base.launchPadPos.x, surfaceAt(...ZONES.launch.pos) + 2, base.launchPadPos.z);
        scene.add(ring); ring.userData.born = elapsed;
        shockRings.push(ring);
        UI.countdown(null);
      }
    } else if (launch.phase === 'ascent') {
      launch.vy += (14 - launch.vy * 0.05) * dt;
      launch.y += launch.vy * dt;
      launch.intensity = 1;
      if (launch.y > 34) launch.tilt = Math.min(0.42, launch.tilt + dt * 0.09);
      if (launch.y > 420) launch.phase = 'fly';
    } else if (launch.phase === 'fly') {
      launch.vy += 22 * dt; launch.y += launch.vy * dt;
      launch.intensity = Math.max(0.35, launch.intensity - dt * 0.08);
      if (launch.y > 2600) { ship.visible = false; launch.phase = 'done'; launch.doneAt = elapsed; UI.toast('✦ 星舰已离开大气层 — 「愿它在群星间找到家」', 6000); missions[3].done = true; renderMissions(); audio.radio('good'); }
    }
    if (launch.phase !== 'done') {
      ship.position.y = 2.2 + launch.y;
      ship.position.x = ZONES.launch.pos[0] + Math.sin(launch.tilt) * launch.y * 0.3;
      ship.rotation.z = -launch.tilt;
      // plume particles — the stack crosses tens of metres per frame on a slow machine,
      // so seed along the swept path instead of at one point or the trail becomes a dotted chain
      const climb = launch.vy * dt;
      const steps = THREE.MathUtils.clamp(1 + Math.floor(climb / 6), 1, 8);
      const n = Math.max(1, Math.round(26 * quality.particles * (0.4 + launch.intensity) / steps));
      for (let s = 0; s < steps; s++) {
        const ey = ship.position.y - climb * (1 - s / steps);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * 6.283, r = 0.3 + Math.random() * 2.2;
          fx.flame.emit(
            ship.position.x + Math.cos(a) * r, ey + 0.5, ship.position.z + Math.sin(a) * r,
            Math.cos(a) * 3, -15 - Math.random() * 8, Math.sin(a) * 3,
            0.7 + Math.random() * 0.5, 3 + Math.random() * 3
          );
          if (Math.random() < 0.5) fx.smoke.emit(
            ship.position.x + Math.cos(a) * (3 + Math.random() * 4), ey + Math.random() * 2, ship.position.z + Math.sin(a) * (3 + Math.random() * 4),
            Math.cos(a) * 6, 2 + Math.random() * 2.5, Math.sin(a) * 6, 2.6 + Math.random() * 2, 6 + Math.random() * 6
          );
        }
      }
      chase.trauma = Math.max(chase.trauma, 0.25 + prox * 0.75 * launch.intensity);
      audio.updateLaunch?.(launch.intensity);
      launch.audioLevel = launch.intensity * prox;
    }
    if (launch.flash > 0) launch.flash = Math.max(0, launch.flash - dt * 0.85);
  }
}
const shockRings = [];
function shockWave(x, y, z, color = 0x8fe8ff, r = 5) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.14, 8, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  ring.rotation.x = Math.PI / 2; ring.position.set(x, y, z);
  scene.add(ring); ring.userData.born = elapsed; ring.userData.grow = 1.7;
  shockRings.push(ring);
}
let launchCamW = 0;                       // 0..1 blend into the launch framing
const launchAim = new THREE.Vector3();
const launchAir = { x: 0, y: 0, z: 0, w: 0 };   // held camera station for the ascent tracking shot

// park the rover somewhere flat — used by the demo URLs and by the headless checks
function warpTo(wx, wz, facePad = false, search = 8) {
  let bx = wx, bz = wz, bs = Infinity;
  for (let dx = -search; dx <= search; dx += 2) for (let dz = -search; dz <= search; dz += 2) {
    const s = surfaceSlope(wx + dx, wz + dz);
    if (s < bs) { bs = s; bx = wx + dx; bz = wz + dz; }
  }
  phys.x = bx; phys.z = bz; phys.y = platformAt(base.colliders, bx, bz) + 0.8;
  phys.vx = phys.vz = phys.vy = 0;
  // facePad: true → look at the launch pad, [x,z] → look at that landmark
  const ft = facePad === true ? ZONES.launch.pos : Array.isArray(facePad) ? facePad : null;
  if (ft) phys.yaw = Math.atan2(ft[0] - bx, ft[1] - bz);
  demoPin = { x: bx, z: bz, yaw: phys.yaw };
}

// ───────────────────────── photo mode ─────────────────────────
function togglePhoto(on) {
  photo.on = on ?? !photo.on;
  $('photo-ui').classList.toggle('hidden', !photo.on);
  UI.setHudVisible(!photo.on);
  if (photo.on) { photo.yaw = phys.yaw; photo.pitch = 0.22; photo.dist = 14; }
}
addEventListener('pointerdown', e => { if (photo.on) { photo.dragging = true; photo.lx = e.clientX; photo.ly = e.clientY; } });
addEventListener('pointerup', () => photo.dragging = false);
addEventListener('pointermove', e => {
  if (photo.on && photo.dragging) {
    photo.yaw -= (e.clientX - photo.lx) * 0.005;
    photo.pitch = THREE.MathUtils.clamp(photo.pitch + (e.clientY - photo.ly) * 0.004, -0.35, 1.35);
    photo.lx = e.clientX; photo.ly = e.clientY;
  }
});
addEventListener('wheel', e => { if (photo.on) photo.dist = THREE.MathUtils.clamp(photo.dist + e.deltaY * 0.02, 4, 120); });
function updatePhotoCam(dt) {
  const t = phys.pose();
  const cx = t.x + Math.sin(photo.yaw) * Math.cos(photo.pitch) * photo.dist;
  const cz = t.z + Math.cos(photo.yaw) * Math.cos(photo.pitch) * photo.dist;
  const cy = Math.max(surfaceAt(cx, cz) + 1.2, t.y + 1 + Math.sin(photo.pitch) * photo.dist);
  camera.position.lerp(tmpV.set(cx, cy, cz), Math.min(1, dt * 5));
  camera.lookAt(t.x, t.y + 1.3, t.z);
  if (Math.abs(camera.fov - 55) > 0.05) { camera.fov += (55 - camera.fov) * dt * 4; camera.updateProjectionMatrix(); }
}
function shoot() {
  const fl = document.createElement('div');
  fl.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:99;transition:opacity .4s';
  document.body.appendChild(fl);
  requestAnimationFrame(() => { fl.style.opacity = 0; setTimeout(() => fl.remove(), 450); });
  post.composer.render();
  const url = renderer.domElement.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url; a.download = `RED-STARBASE-${Date.now()}.png`; a.click();
  photo.lastShot = url;
  UI.toast('✦ 已保存截图');
}
$('photo-share').onclick = async () => {
  if (!photo.lastShot) { shoot(); }
  try {
    const blob = await (await fetch(photo.lastShot)).blob();
    if (navigator.canShare && navigator.canShare({ files: [new File([blob], 'shot.png', { type: 'image/png' })] })) {
      await navigator.share({ files: [new File([blob], 'shot.png', { type: 'image/png' })], title: 'RED STARBASE', text: '我在火星开漫游车' });
    } else { UI.toast('当前浏览器不支持直接分享 · 已下载图片'); }
  } catch { /* user cancelled */ }
};

// ───────────────────────── leaderboard ─────────────────────────
function loadBoard() { try { return JSON.parse(localStorage.getItem('rsb_board') || '[]'); } catch { return []; } }
function saveBoard(score) {
  const b = loadBoard(); b.push(score);
  b.sort((x, y) => x.ms - y.ms);
  localStorage.setItem('rsb_board', JSON.stringify(b.slice(0, 8)));
}
$('race-board-btn').onclick = () => UI.boardOpen(loadBoard());
$('board-close').onclick = () => UI.boardClose();
function updateRace(dt) {
  if (!race.active) return;
  race.t += dt;
  const g = race.gates[race.idx];
  if (g && Math.hypot(phys.x - g.x, phys.z - g.z) < 9) {
    race.idx++; audio.radio('good');
    if (race.idx >= race.gates.length) {
      race.active = false;
      const ms = race.t * 1000;
      saveBoard({ name: `漫游车 ${new Date().toLocaleDateString('zh-CN')}`, time: fmtTime(race.t), ms, ts: Date.now() });
      UI.toast(`✦ 计时赛完成 ${fmtTime(race.t)} — 已记入排行榜`);
      UI.raceShow(false);
      race.rings.forEach(r => r.visible = false);
      return;
    }
  }
  race.rings.forEach((r, i) => {
    r.children[0].material.opacity = i === race.idx ? 0.9 : 0.15;
    r.rotation.z += dt * (i === race.idx ? 1.2 : 0.2);
  });
  UI.raceShow(true, fmtTime(race.t), `检查点 ${race.idx}/${race.gates.length}`);
}

// ───────────────────────── main update ─────────────────────────
let lastInfoZone = null;
function update(dt) {
  elapsed += dt;
  const inp = input.read();
  if (teleOpen) { inp.gas = inp.brake = inp.steer = inp.drift = inp.interact = 0; }
  // drive physics — a flat battery kills the motors, and the last 20 % sags so that running
  // dry is a slow, obvious slide into trouble rather than a sudden loss of control
  const sag = grid.dead ? 0 : THREE.MathUtils.clamp((grid.battery - 0.06) / 0.16, 0.42, 1);
  phys.update(dt, { gas: inp.gas * sag, brake: inp.brake, steer: inp.steer, drift: inp.drift * (grid.dead ? 0 : 1) }, base.colliders);
  // a demo warp parks the rover for the cinematic shot; the moment someone touches the
  // controls they own it again, otherwise ?demo=… leaves a player with a dead throttle
  if (demoPin && (inp.gas || inp.brake || inp.steer || inp.drift)) demoPin = null;
  if (demoPin) {
    // pin at the exact settled ride height — any higher and a demo shot shows the rover hovering
    phys.x = demoPin.x; phys.z = demoPin.z; phys.y = platformAt(base.colliders, phys.x, phys.z) + 0.46;
    phys.vx = phys.vy = phys.vz = 0; phys.speed = 0; phys.yaw = demoPin.yaw;
  }
  const pose = phys.pose();
  rover.group.position.set(pose.x, pose.y + 0.12, pose.z);
  rover.group.rotation.order = 'YXZ';
  rover.group.rotation.set(pose.pitch, pose.yaw, -pose.roll);
  // wheels
  const omega = (phys.speed * Math.sign(phys.vx * Math.sin(pose.yaw) + phys.vz * Math.cos(pose.yaw) || 1)) / 0.46;
  // the modelled wheels show the angle the physics is actually using, so the tyres and the
  // arc through the corner agree instead of the wheels lagging a smoothed copy of the key
  const wa = phys.wheelAngle;
  const track = [];
  for (const w of rover.wheels) {
    const d = w.userData;
    w.rotation.y = d.row === 0 ? wa : (d.row === 2 ? -wa * 0.45 : 0);
    d.spin.rotation.x += omega * dt;
    track.push(w.getWorldPosition(tmpV.set(0, 0, 0)));
  }
  skids.update(dt, track, Math.abs(phys.lateral) + (inp.drift > 0.5 ? 2.2 : 0), pose.yaw);
  // driving dust from wheels
  if (phys.speed > 2 && phys.grounded) {
    const rate = Math.min(6, phys.speed * 0.25) * quality.particles;
    for (let i = 0; i < rate; i++) {
      const d = rover.wheels[Math.floor(Math.random() * 6)].getWorldPosition(tmpV.set(0, 0, 0));
      fx.dust.emit(d.x + (Math.random() - .5), d.y - 0.1, d.z + (Math.random() - .5),
        -phys.vx * 0.25 + (Math.random() - .5) * 2, 1.2 + Math.random(), -phys.vz * 0.25 + (Math.random() - .5) * 2,
        1.4 + Math.random(), 1.7 + Math.random() * 1.3);
    }
  }
  if (phys.drifting) {
    const lvl = audio.level();
    for (let i = 0; i < 4 * quality.particles; i++) {
      const d = rover.wheels[5].getWorldPosition(tmpV.set(0, 0, 0));
      fx.driftSmoke.emit(d.x, 0.4, d.z, (Math.random() - .5) * 4, 1.4, (Math.random() - .5) * 4, 2.6, 3.6 + lvl * 6);
    }
  }
  // audio-reactive engine glow dust
  const aLvl = audio.level();

  // info zones
  let zone = null, bestD = 1e9;
  for (const z of base.infoZones) {
    if (z.r > 9000) continue;
    const d = Math.hypot(phys.x - z.pos[0], phys.z - z.pos[1]);
    if (d < z.r && d < bestD) { bestD = d; zone = z; }
  }
  if (!zone) {
    for (const s of base.samples) if (!s.taken && Math.hypot(phys.x - s.x, phys.z - s.z) < 10) zone = base.infoZones.find(z => z.key === 'samples');
  }
  if (zone !== lastInfoZone) { lastInfoZone = zone; UI.showInfo(zone); }
  if (zone?.key === 'tanks' && !leakFixed) zone.hudAction = `靠近白色雾流，按住 ${input.isTouch ? '「交互」' : 'E'} 修复`;
  if (zone?.key === 'watch' && launchArmed && launch.phase === 'idle') zone.hudAction = '★ 已抵达观礼台 — 发射程序即将启动';

  // missions
  if (mAct() === 'inspect' && Math.hypot(phys.x - ZONES.launch.pos[0], phys.z - ZONES.launch.pos[1]) < 48) {
    missions[1].done = true; UI.toast('✔ 发射台巡检完成 — 结构读数正常'); audio.radio('good'); advanceMission();
  }
  const nearLeak = Math.hypot(phys.x - base.leakPoint.x, phys.z - base.leakPoint.z) < 12;
  if (mAct() === 'leak' && !leakFixed) {
    if (nearLeak && inp.interact > 0 && phys.speed < 1.5) {
      repairHold += dt;
      UI.showInfo({ ...lastInfoZone || base.infoZones.find(z => z.key === 'tanks'), hudAction: `密封中… ${Math.min(100, Math.round(repairHold / 3 * 100))}%`, key: 'tanks' });
      if (repairHold >= 3) {
        leakFixed = true; missions[2].done = true;
        UI.toast('✔ 泄漏已封堵 — 推进剂压力恢复'); audio.radio('good'); advanceMission();
      }
    } else if (!nearLeak) repairHold = 0;
  }
  if (mAct() === 'samples') {
    for (const s of base.samples) {
      if (!s.taken && Math.hypot(phys.x - s.x, phys.z - s.z) < 4.2) {
        s.taken = true; s.group.visible = false; samplesTaken++;
        missions[3].text = `采集火星样本 ${samplesTaken}/${SAMPLE_COUNT}`;
        renderMissions(); audio.radio('beep'); UI.toast(`✦ 样本 ${samplesTaken}/${SAMPLE_COUNT} 已入库`);
        for (let i = 0; i < 40; i++) fx.spark.emit(s.x, 1, s.z, (Math.random() - .5) * 8, 3 + Math.random() * 5, (Math.random() - .5) * 8, 0.8, 2);
        if (samplesTaken >= SAMPLE_COUNT) { missions[3].done = true; advanceMission(); }
      }
    }
  }
  if (launchArmed && launch.phase === 'idle' && mAct() === 'watch') {
    if (Math.hypot(phys.x - base.watchPos.x, phys.z - base.watchPos.z) < 26) startCountdown();
  }
  updateLaunch(dt);
  updateRace(dt);
  UI.arrowAngle(phys, objectiveTarget());

  // leak steam
  if (!leakFixed) {
    const lp = base.leakPoint;
    for (let i = 0; i < 2 * quality.particles; i++) {
      fx.steam.emit(lp.x + (Math.random() - .5), lp.y, lp.z + (Math.random() - .5),
        2.5 + Math.random() * 2, 2.2 + Math.random(), (Math.random() - .5) * 2, 2.2 + Math.random(), 2.6);
    }
  }
  // welding sparks
  for (const sp of base.sparkPoints) {
    if (Math.random() < 0.016 * sp.rate * 60 * dt) {
      for (let i = 0; i < 22; i++) {
        fx.spark.emit(sp.x, sp.y, sp.z, (Math.random() - .5) * 9, -2 + Math.random() * 3, (Math.random() - .5) * 9, 0.55 + Math.random() * 0.5, 1.1);
      }
    }
  }
  // A mineral outcrop does not spin in place or hover a metre off the deck — that levitating loot-gem
  // animation was the most obviously "gamey" thing on the island, and it unseated every crystal from
  // the scree ring built around it. They stay put and breathe with light instead; the halo beam does
  // the long-range signalling. The glow has to stay under the sun, not over it: at emissive ~1.0 the
  // self-light dominated the shading and a 798-triangle faceted cluster drew as three flat mint
  // pillows. By day it is stone catching the sun; only after dark does the light inside show.
  const cnight = Math.max(env.state.nightF, env.state.stormF * 0.6);
  // The 0.13 day floor still failed at mid-range: a ~1 m cluster of #36d8bd at any emissive above
  // ~0.1 draws as a flat mint chip — pure hue, below bloom, exactly the grid-core lesson. Day now
  // sits at 0.04 so the dark stone body and the sun highlight carry it; dusk restores the glow.
  // Night ceiling trimmed 1.48→1.05 so the faceted silhouette survives the bloom instead of
  // collapsing into a flat white blob (V11 forensics).
  base.crystalMat.emissiveIntensity = 0.04 + cnight * 1.01 + Math.sin(elapsed * 1.9) * (0.02 + cnight * 0.12);
  // beacon blink + night lamps + light cones
  const st = env.state;
  // An aviation beacon exists to be seen against darkness, so its drive belongs to the night: at a
  // flat 1.5–4.0 it was a hot pink blob on every mast in the day views, the single brightest
  // saturated object in the industry zone. Full blink after dusk, a faint confirmation by day.
  // The blink is shaped (0.5+0.5·sin) so the value never dips below its floor — the old ± form went
  // NEGATIVE at the trough (0.06+1.28 − 1.89 < 0) and the lamp drew as a black square in the sky (X3).
  const bnight = Math.max(st.nightF, st.stormF * 0.7);
  const blink = 0.5 + 0.5 * Math.sin(elapsed * 5);
  for (const b of base.beacons) b.material.emissiveIntensity = 0.06 + bnight * (0.22 + 1.55 * blink);
  const spots = rover.group.userData.spots;
  if (spots) for (const sp of spots) sp.intensity = st.nightF * 46 + st.stormF * 22;
  // the lens quads must follow the beam: at full emissive in clear daylight they bloom the whole deck
  rover.lampMat.emissiveIntensity = 0.18 + Math.max(st.nightF, st.stormF * 0.7) * 1.6;
  const night = Math.max(st.nightF, st.stormF * 0.6);
  // The assets' authored emissive strips are thin tubes; at full strength under the sun they
  // alias into bright scribbles. They read as painted trim by day and only become lamps after dusk.
  // 0.42 by day still tripped the bloom threshold on the cyan fittings — a vertical flare off every
  // deck lamp in the noon frames — so the daytime drive comes down to a glow that reads as lit
  // glass without feeding the bloom; the night term rises to keep the after-dark levels identical.
  // A material may ask for a lower daytime floor via userData.dimDay (the saturated cyan studs);
  // the night end stays at the same 1.92 either way.
  for (const m of base.heroLights) {
    const d = m.userData?.dimDay ?? 0.26;
    m.emissiveIntensity = d + night * (1.92 - d);
  }
  for (const c of cones) c.material.opacity = st.nightF * 0.045 * (1 - st.stormF);
  // pad discs: a flat read-able ring by day, an armed portal at night. The whole base is dimmer
  // until the rover re-links the districts, so progress is legible from anywhere on the map.
  const gp = 0.34 + 0.66 * (grid.online / GRID_COUNT);
  const padPulse = (0.12 + night * (1.05 + Math.sin(elapsed * 2.2) * 0.35)) * gp;
  for (const m of base.padGlow) m.emissiveIntensity = padPulse;
  // night light show on ship rings
  if (showOn > 0) {
    showOn -= dt;
    const beat = Math.sin(elapsed * 6) > 0 ? 5.5 : 1.2;
    base.lightStrips.forEach((m, i) => { m.emissiveIntensity = beat * gp * (0.5 + 0.5 * Math.sin(elapsed * 4 + i * 1.7)); });
    base.lightRings.forEach(r => r.visible = true);
    base.showBeams.rotation.y += dt * 0.6;
    const beamA = (0.016 + 0.012 * Math.sin(elapsed * 2.4)) * st.nightF;
    base.showBeamMats.forEach((m, i) => { m.opacity = beamA * (0.55 + 0.45 * Math.sin(elapsed * 5 + i * 2.1)); });
    if (showOn <= 0) {
      base.lightStrips.forEach(m => m.emissiveIntensity = 2.5 * gp);
      base.lightRings.forEach(r => r.visible = false);
      base.showBeamMats.forEach(m => { m.opacity = 0; });
    }
  }
  // E at ship at night = light show
  if (inp.interact > 0 && st.nightF > 0.5 && Math.hypot(phys.x - ZONES.launch.pos[0], phys.z - ZONES.launch.pos[1]) < 42 && showOn <= 0 && launch.phase === 'idle' && !padHere) {
    if (!photo.on) { showOn = 14; UI.toast('✦ 星舰灯光秀开始'); audio.radio('good'); }
  }

  // teleport pad presence — the pads are the map's fast-travel skeleton
  padHere = base.teleports.find(tp => Math.hypot(phys.x - tp.x, phys.z - tp.z) < 3.9) || null;
  updateGrid(dt, st);
  const padHint = !!padHere && phys.speed < 2.5 && !teleOpen;
  teleHint.classList.toggle('hidden', !padHint);
  if (padHint) {
    teleHint.innerHTML = padHere.online
      ? `◈ ${padHere.name} 光台已就绪 — 按 <kbd>G</kbd> 跃迁（<kbd>M</kbd> 全区地图）`
      : `⛔ ${padHere.name} 光台无电 — 复电后才能成像跃迁`;
  } else if (grid.target && phys.speed < 1.6 && !teleOpen) {
    teleHint.classList.remove('hidden');
    const pct = Math.round(grid.target.power * 100);
    teleHint.innerHTML = grid.battery > LINK_MIN
      ? `◈ 并网中 · ${grid.target.name} <b>${pct}%</b> — 保持停车直到反应桩亮起`
      : `⚡ 电量不足（${Math.round(grid.battery * 100)}%）— 无法为 ${grid.target.name} 并网，先回光台补电`;
  }
  teleHint._fab.classList.toggle('hidden', teleOpen || photo.on);
  teleHint._mute.classList.toggle('hidden', photo.on);
  if (teleOpen) drawTeleMap();

  // environment
  env.update(dt, rover.group.position, elapsed, renderer);
  const localStorm = 1 - THREE.MathUtils.clamp((Math.hypot(phys.x - ZONES.storm.pos[0], phys.z - ZONES.storm.pos[1]) - 26) / 70, 0, 1);
  const stormF = Math.max(st.stormF, localStorm * 0.85);
  env.fog.density += localStorm * 0.010;
  const windT = elapsed * 0.4;
  // particles
  updateStorm(fx, dt, { x: pose.x, y: pose.y + 2, z: pose.z }, stormF, windT, aLvl);
  fx.dust.update(dt, Math.sin(windT) * 2, Math.cos(windT), aLvl * 0.4);
  fx.driftSmoke.update(dt, 0, 0, aLvl * 0.5);
  fx.spark.update(dt, 0, 0, 0);
  fx.flame.update(dt, 0, 0, aLvl);
  fx.smoke.update(dt, Math.sin(windT * 0.5) * 1.5, 0, 0);
  fx.steam.update(dt, Math.sin(windT) * 2, Math.cos(windT), 0);

  // shockwave rings fade
  for (let i = shockRings.length - 1; i >= 0; i--) {
    const r = shockRings[i];
    const age = elapsed - r.userData.born;
    r.scale.setScalar(1 + age * (r.userData.grow ?? 22));
    r.material.opacity = Math.max(0, 0.8 - age * 0.5);
    if (age > 2.2) { scene.remove(r); shockRings.splice(i, 1); }
  }

  // camera
  if (!photo.on) {
    // the 120m stack only fits the frame if the chase cam lifts and tilts up for it
    const launching = launch.phase !== 'idle' && launch.phase !== 'done';
    // Standing at the pad for the light show has the same framing problem as the launch: the
    // chase cam looks at the rover and the 121 m stack leaves the top of the frame.
    const showFraming = !launching && showOn > 0;
    launchCamW = THREE.MathUtils.clamp(launchCamW + ((launching || showFraming) ? dt * 0.9 : -dt * 1.6), 0, 1);
    chase.aimW = launchCamW;
    chase.raise = 5 * launchCamW;
    chase.fovAdd = 14 * launchCamW;
    if (launching) {
      const sp = base.shipGroup.position;
      const padX = base.launchPadPos.x, padZ = base.launchPadPos.z;
      // Two-stage launch rig. A: a crane station pulled back off the deck, so the rover, the
      // tower and the whole stack share one frame. B: an aerial chase that climbs WITH
      // the ship. `climb` cross-fades A into B.
      const climb = THREE.MathUtils.clamp((launch.y - 30) / 90, 0, 1);
      const az = Math.atan2(pose.x - padX, pose.z - padZ);
      const s = Math.sin(az), cz = Math.cos(az);
      const gy = surfaceAt(pose.x, pose.z);
      const d = 52 + climb * 70;
      const ax = pose.x + s * 26, ay = gy + 8.5, az2 = pose.z + cz * 26;
      const bx = sp.x + s * d, bz = sp.z + cz * d;
      const by = Math.max(surfaceAt(bx, bz) + 6, sp.y - 0.22 * d);
      launchAir.x = ax + (bx - ax) * climb;
      launchAir.y = ay + (by - ay) * climb;
      launchAir.z = az2 + (bz - az2) * climb;
      launchAir.w = launchCamW;
      launchAim.set(sp.x, sp.y + 15 - 6 * climb, sp.z);
      chase.aim = launchAim;
      chase.aimW = launchCamW;
      chase.fovAdd = 12 * launchCamW + 8 * climb;
    } else if (showFraming) {
      // aim at the lit booster section: high enough that the stack reads as the subject,
      // low enough that the rover still sits at the bottom of the frame
      const sp = base.shipGroup.position;
      launchAim.set(sp.x, sp.y + 15, sp.z);
      chase.aim = launchAim;
      chase.aimW = 0.82 * launchCamW;
      launchAir.w = Math.max(0, launchAir.w - dt * 1.1);
    } else {
      chase.aim = null;
      // hold the station while its weight ramps out, or the camera crash-dives back to the rover
      launchAir.w = Math.max(0, launchAir.w - dt * 1.1);
    }
    chase.air = launchAir.w > 0.001 ? launchAir : null;
    chase.update(dt, { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw, roll: pose.roll, lateral: phys.lateral, wheelAngle: phys.wheelAngle, groundY: phys.groundY }, phys.speed, phys.trauma);
  } else updatePhotoCam(dt);

  // Slender masts and lamp posts are not colliders, so the rig still parks behind them and the
  // whole frame turns into a black slab. Ghost anything sitting on the camera→rover line.
  {
    const cp = camera.position, dx = pose.x - cp.x, dz = pose.z - cp.z;
    const len2 = dx * dx + dz * dz;
    for (const oc of base.occluders) {
      let want = 1;
      if (len2 > 1) {
        const t = THREE.MathUtils.clamp(((oc.x - cp.x) * dx + (oc.z - cp.z) * dz) / len2, 0, 1);
        const d = Math.hypot(cp.x + dx * t - oc.x, cp.z + dz * t - oc.z);
        const camD = Math.hypot(oc.x - cp.x, oc.z - cp.z);
        if (t > 0.03 && t < 0.97 && camD < 26 && d < oc.r * 2.6) {
          want = 0.10 + 0.90 * THREE.MathUtils.smoothstep(d, oc.r * 0.5, oc.r * 2.6);
        }
      }
      oc.f += (want - oc.f) * Math.min(1, dt * 7);
      if (Math.abs(oc.f - (oc.shown ?? 2)) < 0.004) continue;
      oc.shown = oc.f;
      oc.inst.visible = oc.f > 0.03;
      for (const m of oc.mats) {
        m.transparent = oc.f < 0.995;
        m.opacity = oc.f;
        m.depthWrite = oc.f > 0.5;
      }
    }
  }

  // audio
  audio.update(dt, {
    speed01: Math.min(1, phys.speed / 28), rpm: 0.3 + phys.enginePower * 0.7, power: phys.enginePower,
    stormF, nightF: st.nightF, camPos: camera.position,
    camFwd: camera.getWorldDirection(tmpV.set(0, 0, 1)), camUp: camera.up,
    roverPos: rover.group.position, leakActive: !leakFixed, launchIntensity: launch.audioLevel || 0,
    padPos: base.launchPadPos,
  });

  // post uniforms
  const fu = post.final.uniforms;
  fu.uTime.value = elapsed;
  const sunWorld = tmpV.copy(st.sunDir).multiplyScalar(2000).add(camera.position);
  const camDir = camera.getWorldDirection(new THREE.Vector3());
  // `camDir.dot(sunDir) > 0.08` is an 85° cone, but a 60° camera only sees ~43° horizontally, so
  // the sun was routinely being projected far outside the frame. The march then clamped every tap
  // onto one edge pixel — see the guard in the FINAL shader — so gate on the screen position too.
  let sunOnFrame = false;
  if (camDir.dot(st.sunDir) > 0.08 && st.sunDir.y > -0.02) {
    const p = sunWorld.clone().project(camera);
    sunOnFrame = Math.abs(p.x) < 1.25 && Math.abs(p.y) < 1.25;
    if (sunOnFrame) fu.uSunUV.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
  }
  fu.uGodRay.value = quality.godrays && sunOnFrame ? (1 - stormF) * st.dayF * THREE.MathUtils.clamp(camDir.dot(st.sunDir) * 2.2, 0, 1) : 0;
  fu.uCA.value = 0.12 + Math.min(0.5, phys.speed / 60) + stormF * 0.2 + launch.flash * 0.9;
  fu.uNight.value = st.nightF;
  fu.uGrain.value = 0.028 + st.nightF * 0.006 + stormF * 0.03;
  // 0.55 put the corners at 26% brightness, which turned any dark prop near the frame edge into
  // a black hole. Storms still want the heavy tunnel; calm daylight wants barely a hint.
  fu.uVignette.value = 0.26 + stormF * 0.45;
  fu.uDirt.value = stormF * 0.9;
  fu.uFlash.value = launch.flash;
  // at night a full-strength bloom turns every lamp into a disc that lifts the whole
  // sky and erases the stars, so the night frames get a tighter bloom budget
  post.bloom.strength = (quality.bloomStrength + (launch.audioLevel || 0) * 0.5) * (1 - st.nightF * 0.35);
  // Bloom threshold is read against raw linear radiance. By day sunlit hull sits near 3.0
  // and must stay under it; by night the lamps are the whole picture and must clear it.
  // The rim crest also reaches ~3.0, and blooming it veiled the whole horizon in a flat orange
  // wash, so the day gate now sits above the brightest thing the sun can light.
  post.bloom.threshold = THREE.MathUtils.lerp(2.9, 0.42, st.nightF) * (1 - stormF * 0.45);
  // Daylight frames were crushing to 43% near-black silhouette; night was already balanced
  // at 0.97 by the lamp pass, so the lift tracks the sun rather than the whole clock.
  renderer.toneMappingExposure = 1.02 - st.nightF * 0.20;

  // HUD
  UI.setSpeed(phys.speed * 3.6);
  if (Math.floor(elapsed * 2) !== Math.floor((elapsed - dt) * 2)) {
    UI.setTop(st.clock, stormF > 0.5 ? '沙尘暴' : st.nightF > 0.5 ? '夜晚' : '晴朗', quality.label, Math.round(fpsAvg));
  }
}

// ───────────────────────── loop & degrade ─────────────────────────
let fpsSamples = [], fpsAvg = 60, lastTs = performance.now(), degradeChecked = 0;
function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTs) / 1000);
  lastTs = now;
  fpsSamples.push(1 / Math.max(dt, 1e-4));
  if (fpsSamples.length > 60) fpsSamples.shift();
  fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
  if (started && !paused) update(dt); else { elapsed += 0; }
  // auto-degrade after 8s of low fps
  if (started && !paused && now - degradeChecked > 8000) {
    degradeChecked = now;
    if (fpsAvg < 30 && degradeLevel < 2) {
      degradeLevel++;
      if (degradeLevel === 1) {
        renderCap = 0.72;
        renderer.setPixelRatio(solvePixelRatio());
        Object.values(fx).forEach(p => p.setPixelRatio(renderer.getPixelRatio()));
        post.setSize(innerWidth, innerHeight);
        UI.toast('⚠ 检测到帧率偏低 — 已自动降采样');
      } else {
        if (post.ssao) post.ssao.enabled = false;
        post.bloom.strength *= 0.7;
        UI.toast('⚠ 已自动关闭部分特效以保证流畅');
      }
    }
  }
  if (post) post.composer.render();
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(solvePixelRatio());
  renderer.setSize(innerWidth, innerHeight);
  post?.setSize(innerWidth, innerHeight);
  Object.values(fx).forEach(p => p.setPixelRatio(renderer.getPixelRatio()));
});

addEventListener('keydown', e => {
  if (!started) return;
  if (teleOpen && /^Digit[1-6]$/.test(e.code)) { const tp = base.teleports[+e.code.slice(5) - 1]; if (tp && tp.online !== false) teleportTo(tp); else if (tp) UI.toast('⛔ 该区电网未恢复 — 光台无法成像'); return; }
  if (e.code === 'KeyG') {
    if (teleOpen) closeTeleport();
    else if (padHere) openTeleport();
    else UI.toast('驶上传送光台后再按 G — 或按 M 打开全区地图直接跃迁');
  }
  if (e.code === 'KeyM' && !photo.on) { if (teleOpen) closeTeleport(); else openTeleport(); }
  if (e.code === 'KeyP') togglePhoto();
  if (e.code === 'KeyC' && photo.on) shoot();
  if (e.code === 'KeyT') { env.toggleWeather(); UI.toast(env.weather === 'storm' ? '⚠ 沙尘暴来袭…' : '沙尘消散 · 天空恢复'); }
  if (e.code === 'KeyN') { env.forceNight(); UI.toast('时间快进至深夜 — 银河可见'); }
  if (e.code === 'KeyR' && !race.active) {
    race.active = true; race.idx = 0; race.t = 0;
    race.rings.forEach(r => r.visible = true);
    UI.toast('环基地计时赛开始 — 依次穿越绿色星环（再按 R 取消）');
  } else if (e.code === 'KeyR') {
    race.active = false; UI.raceShow(false); race.rings.forEach(r => r.visible = false);
  }
  if (e.code === 'Escape') {
    if (teleOpen) { closeTeleport(); return; }
    paused = !paused;
    UI.toast(paused ? '⏸ 已暂停（Esc 继续）' : '▶ 继续');
  }
});

$('start-btn').onclick = async () => {
  $('menu').classList.add('hidden');
  setBar(96, '载入渲染管线…');
  $('loader').classList.remove('hidden');
  $('load-bar').style.width = '96%';
  await raf();
  applyQuality();
  try { await Promise.race([audio.init(), new Promise(r => setTimeout(r, 2000))]); } catch { /* audio unavailable */ }
  try { if (localStorage.getItem('rsb_muted') === '1') { audio.setMuted(true); } } catch { /* private mode */ }
  teleHint._mute._draw();
  // autoplay policy can leave the context suspended even after init resolved
  const unlock = () => { if (audio.ctx?.state === 'suspended') audio.ctx.resume().catch(() => { }); };
  addEventListener('pointerdown', unlock, { once: true });
  addEventListener('keydown', unlock, { once: true });
  $('loader').classList.add('hidden');
  $('hud').classList.remove('hidden');
  started = true;
  startedAt = performance.now();
  renderMissions();
  UI.toast('欢迎来到 RED STARBASE — 基地断电中，驾驶漫游车重启电网');
  audio.radio('beep');
};

boot().catch(e => { console.error('BOOT_FAIL', e); $('load-text').textContent = '启动失败：' + (e && e.message || e); });
renderer.setAnimationLoop(tick);

// ───────────────────────── test / demo hooks (URL params) ─────────────────────────
window.__RSB = {
  get state() { return { started, paused, bootMs: Math.round(startedAt), pos: [phys?.x, phys?.y, phys?.z], speed: phys?.speed, yaw: phys?.yaw, fps: fpsAvg, mission: activeMission, launch: launch.phase, launchY: launch.y, samples: samplesTaken, leak: leakFixed, quality: qKey, battery: grid.battery, gridOnline: grid.online, gridDead: grid.dead }; },
  skipMissions: () => {
    base.gridRigs.forEach(r => { r.online = true; r.power = 1; r.tp.online = true; });
    grid.online = GRID_COUNT; grid.battery = 1; grid.dead = false;
    missions.forEach(m => { if (m.id !== 'watch') m.done = true; });
    missions[0].text = `重启基地电网 ${GRID_COUNT}/${GRID_COUNT}`;
    samplesTaken = SAMPLE_COUNT; missions[3].text = `采集火星样本 ${SAMPLE_COUNT}/${SAMPLE_COUNT}`;
    advanceMission();
  },
  startStorm: () => { env?.toggleWeather(); },
  startNight: () => { env?.forceNight(); },
  phys: () => phys, env: () => env, launchRef: launch,
  warp: (x, z, face, search) => warpTo(x, z, face, search ?? 8),
  sampleList: () => (base?.samples || []).map(s => [Math.round(s.x), Math.round(s.z), !!s.taken]),
  taps: () => (base?.gridRigs || []).map(r => [r.key, +r.x.toFixed(1), +r.z.toFixed(1), +r.power.toFixed(2), !!r.online]),
  // the raw collision set — the pin/unstick audit needs to see the cylinders the physics loop reads
  colliders: () => (base?.colliders || []).map(c => [+c.x.toFixed(2), +c.z.toFixed(2), +c.r.toFixed(2), c.floor === undefined ? 0 : +c.floor.toFixed(2)]),
  solids: () => base?.colliders,
  plan: () => base?.plan ? base.plan() : null,
  setBattery: (v) => { grid.battery = v; grid.dead = false; grid.lowWarned = false; },
  post: () => post,
  camera: () => camera,
  scene: () => scene,
  // run one full game frame by hand — lets QA drive the sim while the tab is hidden
  frame: (dt = 1 / 60) => update(dt),
  audio: () => ({ ready: audio.ready, state: audio.ctx?.state || 'none', lp: Math.round(audio.lowpass?.frequency.value || 0), lvl: +(audio.level?.() || 0).toFixed(3), eng: +(audio.engineG?.gain.value || 0).toFixed(3) }),
  audioCtx: () => audio.ctx,
  hold: (v) => { input.inp.keys[v ? 'add' : 'delete']('KeyE'); },
  photo: (v) => togglePhoto(v),
  // what is actually in front of the lens — finds blown-out emitters by screen position
  nearby: (r = 60) => {
    const w = new THREE.Vector3(), out = [];
    const q = camera.quaternion, right = new THREE.Vector3(1, 0, 0).applyQuaternion(q), up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    scene.traverse(o => {
      if (!o.visible || !(o.isMesh || o.isPoints || o.isSprite) || !o.material) return;
      o.getWorldPosition(w);
      const d = w.clone().sub(camera.position); const dist = d.length();
      if (dist > r || dist < 0.2) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const em = m.emissive ? m.emissive.r + m.emissive.g + m.emissive.b : 0;
      const col = m.color ? m.color.r + m.color.g + m.color.b : 0;
      const lum = (col / 3) * (1 + (m.emissiveIntensity || 0) * (em / 3 > 0.05 ? 1 : 0));
      if (lum < 0.12) return;
      const dn = d.clone().normalize(), cl = x => THREE.MathUtils.clamp(x, -1, 1);
      const p = w.clone().project(camera);
      out.push({
        n: o.name || (o.geometry ? `${o.geometry.type}:${JSON.stringify(o.geometry.parameters || {}).slice(0, 46)}` : o.type),
        mat: `${(m.color ? m.color.getHexString() : '?')}/${m.emissive ? m.emissive.getHexString() : '-'}/e${m.emissiveIntensity ?? ''}${m.transparent ? `/a${m.opacity.toFixed(2)}` : ''}`,
        wp: [Math.round(w.x), Math.round(w.y), Math.round(w.z)],
        lum: +lum.toFixed(2), dist: +dist.toFixed(1),
        px: [Math.round((p.x * .5 + .5) * 1280), Math.round((-p.y * .5 + .5) * 720)],
        inFrame: p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1,
        azDeg: +(Math.asin(cl(dn.dot(right))) * 57.3).toFixed(0), elDeg: +(Math.asin(cl(dn.dot(up))) * 57.3).toFixed(0),
      });
    });
    return out.sort((a, b) => b.lum - a.lum).slice(0, 14);
  },
  // where is the ship on screen? az/el are signed angles from the camera's view axis (deg)
  diag: () => {
    const v = o => o.toArray().map(n => +n.toFixed(1));
    const sp = new THREE.Vector3(); base.shipGroup.getWorldPosition(sp);
    const d = sp.clone().sub(camera.position);
    const dn = d.clone().normalize();
    const q = camera.quaternion;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const cl = x => THREE.MathUtils.clamp(x, -1, 1);
    return {
      ship: v(sp), shipH: +sp.y.toFixed(1), camPos: v(camera.position), dist: +d.length().toFixed(1),
      azDeg: +(Math.asin(cl(dn.dot(right))) * 57.3).toFixed(1),
      elDeg: +(Math.asin(cl(dn.dot(up))) * 57.3).toFixed(1),
      fov: camera.fov, vis: base.shipGroup.visible, phase: launch.phase,
      ly: +launch.y.toFixed(1), lt: +launch.t.toFixed(1),
    };
  },
  // ground truth for the no-clipping check: the height the drawn mesh actually puts
  // under a point, versus the height the rover and camera are standing on
  ground: (x, z) => {
    const t = scene.getObjectByName('terrain');
    const rc = new THREE.Raycaster(new THREE.Vector3(x, 500, z), new THREE.Vector3(0, -1, 0), 0, 1000);
    const hit = t && rc.intersectObject(t, false)[0];
    return { drawn: hit ? +hit.point.y.toFixed(2) : null, surface: +surfaceAt(x, z).toFixed(2),
      stand: +platformAt(base.colliders, x, z).toFixed(2) };
  },
  // name whatever the camera is actually drawing at a screen pixel (px,py in 1280x720 space)
  pick: (px = 640, py = 360) => {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((px / 1280) * 2 - 1, -(py / 720) * 2 + 1), camera);
    return rc.intersectObjects(scene.children, true).filter(h => h.object.visible).slice(0, 3).map(h => ({
      n: h.object.name || h.object.type,
      g: JSON.stringify(h.object.geometry?.parameters || {}).slice(0, 70),
      col: h.object.material?.color ? h.object.material.color.getHexString() : '?',
      d: +h.distance.toFixed(1),
      at: [Math.round(h.point.x), Math.round(h.point.y), Math.round(h.point.z)],
    }));
  },
  // line-of-sight probe: which ship heights are on screen, and what blocks them
  los: () => {
    const rc = new THREE.Raycaster();
    const out = [];
    for (const h of [3, 40, 80, 120]) {
      const target = new THREE.Vector3(ZONES.launch.pos[0], 2.2 + launch.y + h, ZONES.launch.pos[1]);
      const dir = target.clone().sub(camera.position);
      const dist = dir.length();
      rc.set(camera.position, dir.normalize());
      rc.far = dist - 1;
      const hits = rc.intersectObjects(scene.children, true).filter(x => x.object.visible);
      const p = target.clone().project(camera);
      out.push({
        h, px: [Math.round((p.x * 0.5 + 0.5) * 1280), Math.round((-p.y * 0.5 + 0.5) * 720)], onScreen: p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1,
        blocked: hits.length ? (hits[0].object.name || `${hits[0].object.type}/${hits[0].object.material?.name || '?'}`) : null,
        bd: hits.length ? +hits[0].distance.toFixed(1) : null,
      });
    }
    return out;
  },
  cam: () => ({ pos: camera.position.toArray().map(n => +n.toFixed(1)), rover: rover ? rover.group.position.toArray().map(n => +n.toFixed(1)) : null, dist: rover ? +camera.position.distanceTo(rover.group.position).toFixed(1) : null, scale: rover ? rover.group.scale.x : null, vis: rover ? rover.group.visible : null, rot: rover ? rover.group.rotation.toArray().slice(0, 3).map(n => +(n * 57.3).toFixed(1)) : null }),
};
{
  const qp = new URLSearchParams(location.search);
  if (qp.get('auto')) {
    const tryStart = () => {
      if (document.getElementById('menu').classList.contains('hidden')) { setTimeout(tryStart, 120); return; }
      qKey = qp.get('auto') === '1' ? (autoDetect()) : qp.get('auto');
      $('start-btn').onclick();
      const demo = qp.get('demo');
      setTimeout(() => {
        // park the rover on the viewing deck, on the side away from the pad, so the shot reads
        // rover → deck → tower → stack instead of a vehicle hidden behind a concrete lip
        const [dwx, dwz] = ZONES.watch.pos;
        if (demo === 'launch') { window.__RSB.skipMissions(); warpTo(dwx + 6, dwz - 4, true); }
        // the weather demos have to be standing in their zone or the local storm/night
        // terms never show up in a frame — and the storm one has to face the wreck,
        // otherwise the shot is empty haze with a hull filling the lens from behind
        if (demo === 'storm') { warpTo(base.wreckPos.x + 62, base.wreckPos.z, [base.wreckPos.x, base.wreckPos.z]); window.__RSB.startStorm(); }
        if (demo === 'night') { warpTo(ZONES.night.pos[0] - 12, ZONES.night.pos[1] + 10, [ZONES.night.pos[0], ZONES.night.pos[1]]); window.__RSB.startNight(); }
        if (demo === 'warp') warpTo(dwx + 6, dwz - 4, true);
      }, 3000);
    };
    setTimeout(tryStart, 400);
  }
  const shot = qp.get('shot');
  if (shot) {
    const afterMs = Number(qp.get('after') || 12) * 1000;
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (!started || performance.now() - t0 < afterMs) return;
      clearInterval(iv);
      try {
        fetch(`http://localhost:8123/${encodeURIComponent(shot)}.png`, {
          method: 'POST', body: renderer.domElement.toDataURL('image/png'),
        }).then(() => console.log('SHOT_UPLOADED ' + shot))
          .catch(e => console.log('SHOT_FAIL ' + e.message));
      } catch (e) { console.log('SHOT_FAIL ' + e.message); }
    }, 500);
  }
}
