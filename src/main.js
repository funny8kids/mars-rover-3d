import * as THREE from 'three';
import { QUALITIES, ZONES, START, RIM } from './config.js';
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
import { createLaunch } from './fx/launch.js';
import { StormField, createStormWall, placeStormWall } from './world/storm.js';
import { createRimVeil } from './world/rim_veil.js';
import { createPost } from './fx/post.js';
import { createSkidMarks } from './fx/skids.js';
import { GameAudio } from './audio/audio.js';
import { UI, fmtTime } from './ui.js';
import { createMapChart } from './ui/chart.js';
import { t, getLang, mountLangButton, onChange } from './i18n.js';
import { STREETS } from './world/plan.js';

const $ = id => document.getElementById(id);
const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.4, 9000);

const input = createInput(canvas);
const audio = new GameAudio();

let quality, qKey, post, fx, env, sky, terrain, base, rover, phys, chase, skids;
let stormField = null, stormWall = null, lastWind = null, rimVeil = null;
const _viewDir = new THREE.Vector3();
// The wall's own two poles: dust in shadow is a maroon screen, dust backlit by the sun blazes.
// The shadow pole has to be *far* darker than the sky the wall stands against. Measured 2026-09-22:
// at (0.40, 0.20, 0.105) linear the ACES curve put the wall's own tone within a whisker of the
// dust-lit sky behind it, so the front had no silhouette at all — hiding the mesh changed the frame
// by one histogram bin. Unlit dust a kilometre deep is close to soot.
const STORM_TINT = new THREE.Color(0.055, 0.021, 0.010);
// The lit pole sets the hue of the whole front, and it is a *linear* value: after the composer's
// ACES curve (1.0, 0.60, 0.28) lands at about sRGB 232/191/138 — cream. Measured 2026-09-22 on the
// framed 150 m shot, the wall's mid band came out at 151/91/64 with a mean light value of 0.55, and
// a cream-lit dust sheet reads as sunlit cloud, not as a wall of soil crossing the plain. Backlit
// dust is amber and it is *saturated*: the green channel has to fall faster than the red.
const STORM_GLOW = new THREE.Color(1.0, 0.46, 0.15);
let started = false, paused = false;
let startedAt = 0;       // performance.now() at the moment the world became interactive
let elapsed = 0;
const clock = new THREE.Clock();
const tmpV = new THREE.Vector3();

// ───────────────────────── game state ─────────────────────────
// One dark district per teleport pad outside the hub — derived from ZONES so props.js can never
// drift away from the mission text.
const GRID_COUNT = Object.values(ZONES).filter(z => z.teleport).length - 1;
// Four steps, one verb each: drive onto a pad, hold E, drive into a glow, drive home. The chain used
// to carry a fifth — 巡检轨道发射台 — which was a drive with no input in it at all, and players read
// the silence as the game having frozen. Every line names the control on its face, and the counter is
// a placeholder inside the sentence rather than a string the code rebuilds, so switching language only
// has to re-render the list.
const missions = [
  { id: 'grid', text: '重启基地电网 {n}/{total} · 开上各区光台并保持', n: 0, total: GRID_COUNT, done: false },
  { id: 'leak', text: '修复储罐区泄漏 · 靠近白雾长按 E', done: false },
  { id: 'samples', text: '采集火星样本 {n}/{total} · 驶近发光晶体，沙暴会改写样本点', n: 0, total: 0, done: false },
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
// The dust a front actually leaves behind, per surface — see 沙尘作为账本 below.
let roverFilm = 0;
const stormPlay = { lance: false, events: 0, phase: 'calm' };
// `y`/`t`/`tilt`/`intensity` mirror what the flight module integrates, so everything that already
// reads them keeps reading the same numbers the meshes moved by. `flight` is the module's own object,
// built when the count reaches zero — before that the stack is props.js's, untouched.
const launch = { phase: 'idle', t: 0, cd: 11, y: 0, tilt: 0, intensity: 0, flash: 0,
  doneAt: 0, held: false, flight: null };
let showOn = 0;          // night light-show timer
let demoPin = null;      // demo cinematic: hold the rover parked
const race = { active: false, idx: 0, t: 0, gates: [], rings: [] };
const photo = { on: false, yaw: 0, pitch: 0.25, dist: 14, dragging: false, lx: 0, ly: 0 };
let degradeLevel = 0;

// ───────────────────────── teleport network ─────────────────────────
let padHere = null, teleOpen = false, teleEl = null, chart = null, teleHint = null;
let lastPadShown = false;
function buildTeleportUI() {
  teleEl = document.createElement('div');
  teleEl.id = 'teleport-ui'; teleEl.className = 'hidden';
  teleEl.innerHTML = `
    <div class="tp-head"><span class="tp-title">${t('✦ 传送网络 · TELEPORT NETWORK')}</span>
      <button class="tp-close" aria-label="close">✕</button></div>
    <div class="tp-body"><div class="tp-plate"></div><div class="tp-list"></div></div>
    <div class="tp-tip">${t('数字键 1-7 直接跃迁 · 按 G 在光台上就地开启 · M 全区地图')}</div>`;
  document.body.appendChild(teleEl);
  chart = createMapChart({ side: 400 });
  teleEl.querySelector('.tp-plate').appendChild(chart.canvas);
  teleEl.querySelector('.tp-close').onclick = closeTeleport;
  teleHint = document.createElement('div');
  teleHint.id = 'tele-hint'; teleHint.className = 'hidden';
  document.body.appendChild(teleHint);
  const fab = document.createElement('button');
  fab.id = 'tele-fab'; fab.className = 'hidden'; fab.textContent = t('✦ 传送 · MAP');
  fab.onclick = () => { if (teleOpen) closeTeleport(); else openTeleport(); };
  document.body.appendChild(fab);
  teleHint._fab = fab;
  const mute = document.createElement('button');
  mute.id = 'mute-fab'; mute.className = 'hidden';
  const draw = () => { mute.textContent = t(audio.muted ? '音效 关' : '音效 开'); };
  draw(); mute._draw = draw;
  mute.onclick = () => { audio.setMuted(!audio.muted); draw(); };
  document.body.appendChild(mute);
  teleHint._mute = mute;
  // The chart is square and metric now, so a click resolves in metres instead of on a
  // normalised spoke diagram: nearest pad within 15 m wins, offline or not, and an offline pad
  // answers with the reason rather than nothing happening.
  chart.canvas.addEventListener('click', e => {
    const p = chart.toWorld(e.clientX, e.clientY);
    let best = null, bd = 15;
    for (const tp of base.teleports) {
      const d = Math.hypot(tp.x - p.x, tp.z - p.z);
      if (d < bd) { bd = d; best = tp; }
    }
    if (!best) return;
    if (best.online === false) UI.toast('⛔ 该区电网未恢复 — 光台无法成像');
    else teleportTo(best);
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
    b.innerHTML = `<kbd>${i + 1}</kbd><span class="tp-name">${live ? '' : '⛔ '}${t(tp.name)}</span><span class="tp-dist">${onPad ? t('你在这里') : live ? Math.round(dist) + ' m' : t('无电')}</span>`;
    b.disabled = onPad || !live;
    b.onclick = () => teleportTo(tp);
    list.appendChild(b);
  });
}
function closeTeleport() { teleOpen = false; teleEl?.classList.add('hidden'); }
// Writing phys.x/z by hand is a claim that nothing is standing there, and until now nothing checked
// it. The physics loop pads every collider by the rover's half-width, so an unchecked pose lands the
// rover *inside* a wall and the very next substep fires it out — the hub charger sat 0.87 m buried
// in a service deck, and the battery tow threw the rover 62 m across the plaza on the frame it
// "saved" it. So every pose the game writes now goes through the same body-ring oracle the unstick
// glide already used.
function freeLanding(x, z, maxR = 6) {
  const solids = (base?.colliders || []).filter(c => c.floor === undefined);
  const ok = (px, pz) => gapFrom(solids, px, pz) >= 0.3;
  if (ok(x, z)) return [x, z];
  for (let r = 0.75; r <= maxR; r += 0.75) {
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8;
      const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
      if (ok(px, pz)) return [px, pz];
    }
  }
  return [x, z];
}
function teleportTo(tp, opt = {}) {
  // atPad ends up standing on the charger (the battery tow has to leave the rover connected to it);
  // a normal warp arrives just off it and faces back, so the node reads as a place you came to.
  const aim = opt.atPad ? [tp.x, tp.z] : [tp.x + 4.6, tp.z + 4.6];
  const [x, z] = freeLanding(aim[0], aim[1], opt.atPad ? 3.4 : 6);
  phys.x = x; phys.z = z; phys.y = platformAt(base.colliders, x, z) + 0.9;
  phys.vx = phys.vy = phys.vz = 0; phys.speed = 0; phys.trauma = 0.3;
  if (Math.hypot(tp.x - x, tp.z - z) > 1) phys.yaw = Math.atan2(tp.x - x, tp.z - z);
  demoPin = null;
  closeTeleport();
  const fl = document.createElement('div'); fl.className = 'tp-flash';
  document.body.appendChild(fl);
  setTimeout(() => fl.remove(), 620);
  if (!opt.silent) UI.toast(t('✦ 跃迁完成 — {name}').replace('{name}', t(tp.name)));
  if (opt.silent) audio.radio('bad'); else if (audio.play) audio.play('warp', 0.4); else audio.radio('good');
}
// objectiveTarget() hands back a Vector3 and this runs every frame the panel is open, so the
// map mutates one plain object rather than allocating on the HUD's behalf.
const mapObjective = { x: 0, z: 0 };
function drawTeleMap() {
  const o = objectiveTarget();
  let obj = null;
  if (o && !nav.blind) { obj = mapObjective; obj.x = o.x; obj.z = o.z; }
  // The map is drawn from the same optical fix as the arrow, so a blind rover loses its pins too —
  // but not its plate. The contours, streets, district lettering and the hazard ring are surveyed
  // ground truth, not something the sky can scramble, and dropping them would punish the player with
  // information the fiction says they still have.
  chart.draw({
    x: phys.x, z: phys.z, yaw: phys.yaw, time: elapsed,
    teleports: base.teleports, padHere, objective: obj, samples: nav.blind ? [] : liveSamples(),
    danger: leakFixed ? null : { x: base.leakPoint.x, z: base.leakPoint.z, r: 15 },
  });
}

// ───────────────────────── loading ─────────────────────────
function setBar(p, text) {
  $('load-bar').style.width = `${p}%`;
  if (text) $('load-text').textContent = t(text);
}
// yield one frame, with a timeout fallback so loading never stalls in hidden/background tabs
const raf = () => Promise.race([
  new Promise(r => requestAnimationFrame(r)),
  new Promise(r => setTimeout(r, 30)),
]);

// Two tiers, so the probe only has one question to answer: does this device have pixels to spare?
// Anything that can drive 1.75× at 3.6 Mpx gets 高质量; a phone or an older laptop gets 标准, and
// the auto-degrade inside that tier does the rest.
function autoDetect() {
  const touch = 'ontouchstart' in window;
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
  const cores = navigator.hardwareConcurrency || 4;
  if (touch && cores <= 6) return 'std';
  if (/RTX 4|RTX 5|RX 7[9]|RX 9|Apple M[3-4]/i.test(gpu)) return 'hi';
  if (touch) return 'std';
  return cores >= 8 ? 'hi' : 'std';
}

async function boot() {
  setBar(4, '校准地形高度场…'); await raf(); await raf();
  sky = createSky(scene);
  setBar(22, ' sculpting 火星孤岛 · 300m 程序化沙丘…'); await raf();
  terrain = createTerrain(scene);
  setBar(44, '撞击坑与岩石风化场…'); await raf();
  setBar(56, '载入 Blender 建模的星舰基地资产…'); await raf();
  base = await buildBase(scene, { particles: 1 });
  // The site plan cuts its footings into the analytic ground as props are placed, which happens
  // after the terrain mesh was built. Re-survey the mesh now so what is drawn matches what physics
  // and the props were seated on — otherwise every graded lot shows a slab of dune under it.
  terrain.regrade();
  // Boulders and gravel come after that survey for the same reason: `pavedAt` and `surfaceAt` only
  // describe the engineered ground once the plan exists, and a rock's seat has to be the ground the
  // player sees. Their measured footprints then join the collision set here — a boulder you can
  // drive through is scenery, not an obstacle.
  base.colliders.push(...await createRocks(scene, base.colliders));
  createStones(scene);
  // the hub tap is the always-live mains feed; every other district starts blacked out
  for (const r of base.gridRigs) { r.online = r.key === 'hub'; r.power = r.online ? 1 : 0; r.tp.online = r.online; }
  // The sample mission's denominator is however many crystals the world actually left above ground at
  // boot — the storm ledger adds to it later. Counting them beats keeping a constant in sync with the
  // site list by hand: nine anchors are authored, three are deliberately buried, and a hard-coded
  // total would go stale the first time a masked site surfaces.
  missions[2].total = liveSamples().length;
  // A buried site is dressed, not switched off: its sand mound has to be in the very first frame,
  // because the mound is what the player later watches the wind take away.
  base.samples.forEach(dressSample);
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
  $('auto-tip').textContent = `${t('已根据设备自动推荐：')}${t(QUALITIES[rec].label)} ${t('画质')} · ${t('自适应')}`;
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
  // The field and its wall are weather, not quality: rebuilding them on a mode switch would drop
  // a storm halfway across the island and start a new one.
  stormField ||= new StormField(surfaceAt);
  stormWall ||= createStormWall(scene);
  // The boundary's visible half, and like the wall it is weather rather than a quality setting: it is
  // lofted from the terrain once, so a mode switch must not rebuild it mid-frame.
  rimVeil ||= createRimVeil(scene, { groundAt: surfaceAt });
  env = new Environment(scene, sky, quality, stormField);
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
  const arr = missions.map((m, i) => ({ ...m, active: i === activeMission && !m.done }));
  UI.renderMissions(arr);
}
// ───────────────────────── 沙暴作为任务链的变量 ─────────────────────────
// A front is no longer weather that happens *to* the chain, it is a step *of* it, and there are two
// places it earns its keep. The first is the sample mission: a crossing is the only thing that rewrites
// the sample map, and a mechanic the player might finish the game without ever seeing is a mechanic
// that does not exist. The second is the road home — the launch stack does not light into a dust front,
// so the last beat sends one across the pad and the countdown waits for it.
// `lead` is the seconds of warning the top bar counts down before the wall commits, and it is generous
// on purpose: the player has to be able to *choose* to be somewhere when it arrives.
const STORM_BEAT = {
  samples: { lead: 165, text: '▸ 气象预警：一场沙暴将在 {time} 后穿过基地 — 它会改写样本点' },
  launch: { lead: 120, text: '▸ 最后一场沙暴 {time} 后压过基地 — 等天空转晴，星舰才会点火' },
};
const stormBeat = { fired: [], at: 0 };
function fireStormBeat(name) {
  const beat = STORM_BEAT[name];
  if (!beat) return;
  stormBeat.fired.push(name);
  stormBeat.at = elapsed;
  stormField.arm(beat.lead);
  // Two toasts cannot share one slot, so the forecast waits out the objective line it follows.
  setTimeout(() => UI.toast(
    t(beat.text).replace('{time}', mmss(beat.lead)), 5200), 3600);
}

function advanceMission() {
  while (activeMission < missions.length && missions[activeMission].done) activeMission++;
  renderMissions();
  const id = mAct();
  if (id === 'leak') { UI.toast('▸ 新任务：储罐区检测到推进剂泄漏，靠近白雾长按 E'); audio.radio('beep'); }
  if (id === 'samples') {
    UI.toast(t('▸ 新任务：采集 {total} 块火星样本（发光晶体处）').replace('{total}', missions[2].total));
    audio.radio('beep');
    fireStormBeat('samples');
  }
  if (id === 'watch') {
    launchArmed = true;
    UI.toast('▸ 任务链完成 — 发射窗口开启，返回观礼台');
    audio.radio('good');
    fireStormBeat('launch');
  }
  if (activeMission >= missions.length) UI.arrowAngle(phys, null);
}
function objectiveTarget() {
  const id = mAct();
  if (id === 'grid') {
    const r = base.gridRigs.find(r => r.power < 0.99 && r.key !== 'hub');
    return r ? new THREE.Vector3(r.x, surfaceAt(r.x, r.z) + 2, r.z) : null;
  }
  if (id === 'leak' && !leakFixed) return base.leakPoint;
  if (id === 'samples') {
    // The nearest site you can actually work, not the first one in the list: a front can put a drift
    // over whichever crystal the chain would otherwise walk you to, and an arrow that parks you on a
    // drift for two minutes is an arrow that is wrong. Buried ones stay in the running as a fallback,
    // because uncovering one is a drive, not a wait.
    const open = liveSamples().filter(s => !s.taken);
    const nearest = list => list.reduce((a, s) => !a ||
      Math.hypot(phys.x - s.x, phys.z - s.z) < Math.hypot(phys.x - a.x, phys.z - a.z) ? s : a, null);
    const s = nearest(open.filter(x => x.buried < SAND.DEAD)) || nearest(open);
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
    if (mAct() === 'grid') { missions[0].n = online; renderMissions(); }
  }

  // ── drain: the drivetrain, the lamps and the relay are all the same battery
  let use = 0.0015 + 0.006 * phys.enginePower + 0.00012 * phys.speed;
  if (st.nightF > 0.05) use += 0.0025 * st.nightF;
  if (grid.target && grid.linkT > 0) use += LINK_DRAIN;
  grid.battery = Math.max(0, grid.battery - use * dt);

  // ── charge: the hub tap is mains power, the outer pads are solar and die with the dust
  const pad = padHere && padHere.online ? padHere : null;
  if (pad && phys.speed < 1.4 && !grid.dead) {
    // st.stormF alone was the dust sitting *on top of the panel*, which is zero while a front is
    // still a kilometre out — so an array in full view of a wall of dust kept generating at noon.
    // sunShade is the column between the panel and the sun, which is what actually sets the yield.
    const air = 1 - Math.max(st.stormF, st.sunShade) * 0.8;
    // The film is the term that makes a storm cost something *after* it has gone. Measured before
    // this line existed: the sky cleared, and the array was back at rated output while still drawn
    // ochre — the picture and the rules disagreed, and nothing in the game ever asked the player to
    // do anything about weather. An array coated by a passed front throws away most of its yield
    // under a perfectly blue sky, and only the rover's lance takes it back.
    const rig = pad.key === 'hub' ? null : base.gridRigs.find(r => r.tp === pad);
    const film = 1 - (rig ? rig.film : 0) * FILM.YIELD;
    const sun = Math.max(0, st.dayF) * air * film;
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
      // atPad because a towed rover has to end up *on* the charger, not 6.5 m past it. The pose
      // itself is validated inside teleportTo now, so the old raw phys.x/z write — which dropped
      // the rover blind onto the pad centre, 0.87 m inside a service deck, and let the collision
      // solver evict it 62 m across the plaza on the frame it "saved" it — is gone.
      teleportTo(hub, { silent: true, atPad: true });
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
    if (tgt !== grid.link && !tgt.announced) { grid.link = tgt; tgt.announced = true; UI.toast(t('◈ 开始并网 — 停在{name}反应桩旁保持不动 4 秒').replace('{name}', t(tgt.name))); }
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
      UI.toast(t('✔ {name}已复电 — 光台跃迁解锁（{n}/{total}）').replace('{name}', t(tgt.name)).replace('{n}', done).replace('{total}', GRID_COUNT));
      if (mAct() === 'grid') { missions[0].n = done; renderMissions(); }
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
    // A coated installation is a dimmer, browner installation. The deck hex and the night shaft are
    // the two things about a tap you can read from 60 m, so clouding them from cyan to dust-ochre is
    // both the cost of a storm and the feedback for having washed it away — no number needed, and no
    // new geometry to look like programmer art.
    const f = r.film, clear = 1 - f * 0.62;
    r.mats[1].color.copy(RIG_PLATE).lerp(RIG_DUST, f);
    r.mats[2].color.copy(RIG_BEAM).lerp(RIG_DUST, f);
    // The rotor is the one part of a tap that owns its own material, so the coating lands on it
    // too: iron dulled to a matte, dust-brown film. Without this the daytime read of a choked
    // district was nothing at all — the plate and the shaft are both dusk-only by design.
    r.mats[0].color.copy(RIG_CORE).lerp(RIG_DUST, f * 0.62);
    r.mats[0].roughness = 0.2 + f * 0.55;
    r.core.material.emissiveIntensity = p * (0.10 + st.nightF * 5.3) * beat * clear;
    r.core.rotation.y += dt * (0.4 + p * 2.6) * clear;   // the rotor slows when the array is choked
    r.mats[1].opacity = p * (0.02 + 0.73 * st.nightF) * beat * clear;
    r.mats[2].opacity = p * (0.012 + 0.05 * st.nightF) * (1 - st.stormF * 0.6) * clear;
    if (r === grid.target && grid.linkT > 0) {
      // the tap you are currently welding flickers in amber so the hold has a target
      r.mats[1].opacity = 0.25 + 0.6 * Math.abs(Math.sin(elapsed * 7));
    }
  }
  const pct = {}; for (const r of base.gridRigs) pct[r.key] = r.power;
  UI.setBattery(grid.battery);
  UI.setGridStatus(pct);
}

function onGridComplete() {
  missions[0].done = true;
  UI.toast('✦ 全区复电 — 基地电网满载，灯光亮度全开');
  audio.radio('good');
  advanceMission();
}

// ═════════════════════════════ 沙尘作为账本：沉积 → 出力 → 吹扫 ═════════════════════════════
// A front that only changes the fog is a screensaver. What a Martian storm actually does is leave
// its fine fraction settling on every surface it passed over, and that film is what the base keeps
// paying for long after the sky is blue again.
//
// Measured before this block existed, none of that was true in the rules: solar yield lerped on
// *airborne* dust alone (main.js's `st.stormF` term), so the instant the front moved on the array was
// back at rated output while still drawn ochre — the picture said one thing and the simulation
// charged you another, and no weather event in the game ever asked the player to do anything about
// it. `StormField.dustLoad` already integrated an island-wide deposit, but it had exactly one
// consumer (a wind-softness term) and no way to be reduced: its own `wash()` was dead code.
//
// So deposition is now per surface and integrated from the field's reading *at that surface's own
// coordinates*: a tap the fingers reached cakes faster than one the front broke around, the ranking
// survives the storm, and the only thing that clears it is the rover driving there and spending
// charge on its dust-off lance. That is the loop the art direction wanted — weather that writes a
// bill, and a vehicle that pays it.
const FILM = {
  // Was 0.050: measured 2026-09-22, one natural front carried every array from 6 % to 100 % and left
  // them there, so the ledger could only ever read 0 or 100 — it could not say which taps had been
  // under the wall longest, and the whole grid at 15 % output is a bigger chore than a storm is worth.
  // The first retune to 0.022 still overshot: one pass ended at 78-92 %, the same dead grid wearing a
  // different number. At this rate the worst tap finishes a storm at two thirds, so one storm is a bill
  // you may defer and the second one is the visit you cannot.
  DEPOSIT: 0.016,
  RIDE: 0.075,        // 1/s onto the rover's own paint while it stands in the dust
  SCOUR: 0.0075,      // per m/s·s the airflow over the bodywork takes back off
  LANCE_R: 9,         // m — the lance's reach; deliberately a tap's own link ring, one idiom
  LANCE_TAP: 0.30,    // 1/s of film blown off an array inside the reach
  LANCE_SELF: 0.55,   // 1/s off the rover's own panels
  LANCE_DRAIN: 0.011, // battery/s — the act of cleaning spends the resource cleaning protects
  LANCE_MIN: 0.02,
  YIELD: 0.85,        // how much of a fully coated array's output the film takes away
  WARN: 0.35,         // below this an array's losses are noise; above it, say so once
};
// The tap's two readouts at distance, and the colour of the dust that buries them — the same ochre
// the particle pools and the rover's paint film use, so one storm cannot tint three ways.
const RIG_PLATE = new THREE.Color(0x4fe2ff), RIG_BEAM = new THREE.Color(0x6fe8ff);
const RIG_CORE = new THREE.Color(0x101a1f);   // the rotor's authored iron, before a front buries it
const RIG_DUST = new THREE.Color(0xb98a5c);

const filmGauge = () => base.gridRigs.reduce((a, r) => Math.max(a, r.film), 0);

const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// The top bar used to pick one of three words, which meant a storm could never be *seen coming*:
// the wall sits on the horizon for forty seconds before a single mote reaches you, and the HUD said
// 晴朗 through all of it. It now carries the field's own countdown, and after the front has gone it
// carries the bill — the deposited film is the part of a storm that is still costing the base.
function weatherLabel(st) {
  const o = stormField.outlook(phys);
  const film = Math.round(filmGauge() * 100);
  const sky = st.stormF > 0.5 ? t('沙尘暴') : st.nightF > 0.5 ? t('夜晚') : t('晴朗');
  const cost = film > 3 ? ` · ${t('阵列积尘')} ${film}%` : '';
  // The veto comes first: a countdown is a promise about the future, and dust already falling on your
  // head outranks any promise. It fires for a point near the upwind rim that is under the wall while
  // the field still calls the event `watch`, and for the seconds after a truthful `front in 0:0X` has
  // run out — the front has arrived, so say that instead of holding a clock at zero.
  if (o.on && (o.phase === 'watch' || o.phase === 'front' || o.phase === 'calm')) return `◈ ${t('沙暴过境')}${cost}`;
  // Two words because the slot promises two different things, and the field knows which one it is on:
  // the build-up counts to the launch, the launch counts to the wall's own leading face.
  if (o.phase === 'watch') return `⚠ ${t('沙暴逼近')} ${mmss(o.in)}${cost}`;
  if (o.phase === 'front') return `⚠ ${t('沙暴前沿')} ${mmss(o.in)}${cost}`;
  if (o.phase === 'peak' || o.phase === 'clearing') return `◈ ${t('沙暴过境')}${cost}`;
  if (o.phase === 'aftermath') return `${t('暴后降尘')}${cost}`;
  // In the calm gap the same slot counts down to the next alarm, so weather is something you plan a
  // drive around instead of something that happens to you mid-mission. The chain's own storms are
  // counted down from the moment they are announced — a player told 「165 秒后过境」 by the objective
  // line must be able to watch that promise, not only the last 70 s of it. `holdSky` holds `Infinity`,
  // which is the honest answer of "nothing scheduled" and must not be formatted as a clock.
  if (o.phase === 'calm' && Number.isFinite(o.in) && (o.scheduled || o.in < 70)) return `${sky} · ${t('下一场沙暴')} ${mmss(o.in)}`;
  return sky + cost;
}

// ───────────────────────── 覆沙账本：the storm rewrites the sample map ─────────────────────────
// The second thing a front moves is not dust on a panel, it is the ground itself. A wall of wind
// carrying sand does not drop it evenly. The island is a 240 m dome, and a dome is an obstacle: the
// flow is squeezed against the flank it hits and accelerates there, so that face is stripped
// (deflation); behind the crest the flow separates into a wake and loses its grip, so it lays its
// load down (deposition) — which is why every dune on Mars has a falldeposit on its downwind side.
//
// So one crossing takes sand off the windward flank and piles it on the leeward one, and because
// every event draws a new heading, which flank is which rotates with the weather.
//
// That is the whole mechanic: sample sites the fingers passed over get buried and stop yielding, and
// sites the storm scoured clean come out of the sand — including three that were never on the map at
// all, which is how a front can hand the mission *more* science than it hides. The rover is the only
// thing that can move the sand on purpose, so driving fast around a buried site is the dig.
// The first version of this ledger keyed its transport on the *derivative* of the airborne load —
// rising dust meant scour, falling dust meant settle. A full 125 s crossing measured it as a dead
// mechanism: every site ended at exactly the burial it started with. The two halves could never both
// apply to one site, so each was pinned to whichever direction its own starting value allowed (0 can
// only scour, 1 can only settle) and the clamp held it there. Keying on the load itself, not its
// slope, removes the lock — and one front then buries and exposes at the same time. It did, but only
// in the ledger: the *side* test was a two-point difference of the terrain over 13 m, and measured
// across the nine sites at eight headings that pinned whole sites to one direction for every wind
// there is — six could never be buried, two could never be uncovered. At that range the difference is
// local pits and the cuts under graded pads, not weather; and once the clamp saturates the sign goes
// binary, so a bad reading becomes a permanent sentence.
const SAND = {
  DEFLATE: 0.015, // per (unit of airborne load · s) on ground taking the wind
  AGGRADE: 0.019, // per (unit of airborne load · s) in the island's lee — sand is quicker to drop than
                  // to lift, which is why drifts win over ripples on a calm afternoon
  WAKE: 100,      // m from the centreline of the island for the sheltering to be total. The dome radius
                  // is 118, and the sample sites sit at 95–110: at this scale the commitment spreads
                  // over the sites instead of saturating all of them, so one front buries a couple,
                  // scours a couple, and leaves the crosswind pair roughly where they were.
  DRIVE: 0.10,    // per (m/s of rover · s) of wheels passing, scaled by proximity
  R: 9,           // m — the same reach as the dust lance; one idiom for "the rover works on this"
  DEAD: 0.5,      // burial past this and the crystal is under the drift: no sample, and no map pin glow
  SHOW: 0.05,     // below this a lens is thinner than the ripples it sits on, so it is not drawn
};
// Which flank of the island this ground is on, as −1…1 for the way the wind is blowing right now:
// +1 is the face taking the weather, −1 is dead centre of the wake behind it, 0 is the crosswind
// line through the middle where neither applies. One dot product against the storm's own axis, so the
// test is monotone and every heading commits roughly half the island to each direction — which is the
// property the terrain-difference version was measured not to have.
function exposure(x, z) {
  return THREE.MathUtils.clamp(-stormField.along(x, z) / SAND.WAKE, -1, 1);
}
// Put a site where its ledger says it should be: sunk into its own drift by that drift's height.
function dressSample(s) {
  const k = THREE.MathUtils.smoothstep(s.buried, 0.03, 0.85);
  s.crystal.position.y = s.seatY - k * s.rise;
  s.ring.material.opacity = 0.10 * (1 - k);
  s.lens.visible = s.buried > SAND.SHOW;
  // The lens mesh is authored at one front's mature deposit — a 4 m cap, 0.47 m of crest over a 0.43 m
  // skirt — so this is only a growth curve. Plan and section do not scale together: a front that is
  // still creeping over a rock veils it wide and low, and only the mature one plumps into a cap.
  const foot = s.spread * (0.45 + 0.55 * k);
  s.lens.scale.set(foot, 0.30 + 0.70 * k, foot);
  // A deposition landform points with its weather: the crown sits downwind of the rock it buries, so
  // the cap turns to whatever heading built it instead of keeping the yaw it was authored with. The
  // ripple on it does not follow — terrain.js samples that in world space, which is the whole point.
  // Until the first front has been drawn there is no wind to point with, and the site keeps the
  // bearing it was built at; the world is dressed at boot, several steps before the weather exists.
  if (stormField) s.lens.rotation.y = -stormField.heading + s.yawJit;
  // Sand covers the rubble before it covers the crystal, so the site's own scree goes under the same
  // front. Left at ground level it survives the burial as a collar of dark boulders on the flank of a
  // mound, which reads as gravel somebody dumped rather than as the foot of a drift.
  s.rubble.position.y = s.footY - 0.30 * k;
}
function updateSand(dt) {
  for (const s of base.samples) {
    if (s.taken) continue;
    let b = s.buried;
    // Wind strong enough to carry sand, at this exact ground: the storm's own finger pattern, so the
    // same crossing scours one site and drops load on the next one hundred metres along.
    const wind = stormField.local(s.x, s.z);
    if (wind > 0.02) {
      // Which side of the island's own wake this ground is on, for the way the wind is blowing right
      // now. The dome shelters its leeward half, so any heading buries some sites and scours others:
      // one front is always both a hiding and a revealing.
      const p = exposure(s.x, s.z);
      b += wind * dt * (p > 0 ? -SAND.DEFLATE * p : SAND.AGGRADE * -p);
    }
    // The wheels are the player's shovel. A rover driving past a lens kicks the loose cover off it,
    // and does it faster the faster it goes — which is why the fix is a lap, not a wait.
    const d = Math.hypot(phys.x - s.x, phys.z - s.z);
    if (d < SAND.R && phys.speed > 1) b -= (1 - d / SAND.R) * phys.speed * dt * SAND.DRIVE;
    s.buried = THREE.MathUtils.clamp(b, 0, 1);
    dressSample(s);
    if (!s.seen) {
      // An emerged site joins the mission rather than the map: the count on the board has to be the
      // number of sites the field can actually yield, or the last leg is unreachable by definition.
      if (s.buried < SAND.DEAD) {
        s.seen = true;
        if (!missions[2].done) { missions[2].total++; renderMissions(); }
        UI.toast(t('✦ 沙暴刮开了{site}的覆沙 — 新的样本点露头了').replace('{site}', siteName(s)));
        audio.radio('good');
      }
      continue;
    }
    if (s.buried >= SAND.DEAD && !s.buriedWarned) {
      s.buriedWarned = true;
      UI.toast(t('⚠ 沙暴把{site}的样本埋住了 — 驶近绕几圈，用车轮把覆沙刮开').replace('{site}', siteName(s)));
      audio.radio('bad');
    } else if (s.buried < SAND.DEAD * 0.6) s.buriedWarned = false;
  }
}
// Sites the player can see and drive to. An unemerged one is neither, and must not become a
// navigation target or a connectivity obligation.
const liveSamples = () => base.samples.filter(s => s.seen);
// Named for the landmark it sits beside, never a compass word: config.js and the chart disagree about
// which way is north, so "east rim" would be a coin flip. Chinese runs its words together, so only the
// English join gets the space.
const siteName = s => [t(s.near), t('外缘')].join(getLang() === 'zh' ? '' : ' ');

function updateStormPlay(dt, st, inp) {
  // The moment the wall commits to walking is when a warning stops being about someday and starts
  // being about now, and the top bar is a small place to notice it. One line per front, where the
  // player is already looking; the countdown itself stays in the bar. No arrival number here — for a
  // rover parked near the upwind rim the front is already on it, and a toast cannot be wrong about
  // the weather it is announcing.
  const ph = stormField.phase;
  if (ph !== stormPlay.phase) {
    if (ph === 'front') {
      stormPlay.events++;
      UI.toast(t('▸ 沙暴前沿已启动 — 驶近的光台是唯一的参照，信标即将失锁'));
      audio.radio('bad');
    }
    stormPlay.phase = ph;
  }

  for (const r of base.gridRigs) {
    const here = stormField.local(r.x, r.z);
    if (here > 0) r.film = Math.min(1, r.film + here * dt * FILM.DEPOSIT);
    if (r.film > FILM.WARN && !r.filmWarned) {
      r.filmWarned = true;
      UI.toast(t('⚠ {name}：阵列积尘 {pct}% — 出力下降，驶近光台长按 F 吹扫')
        .replace('{name}', t(r.name)).replace('{pct}', Math.round(r.film * 100)));
      audio.radio('bad');
    } else if (r.film < FILM.WARN * 0.3) r.filmWarned = false;
  }
  roverFilm = THREE.MathUtils.clamp(
    roverFilm + st.stormF * dt * FILM.RIDE - phys.speed * dt * FILM.SCOUR, 0, 1);
  updateSand(dt);

  const open = !!inp.keys.has('KeyF') && !photo.on && !paused && grid.battery > FILM.LANCE_MIN;
  stormPlay.lance = open;
  if (!open) { stormPlay.aim = null; return; }

  grid.battery = Math.max(0, grid.battery - FILM.LANCE_DRAIN * dt);
  roverFilm = Math.max(0, roverFilm - FILM.LANCE_SELF * dt);
  let best = null, bd = FILM.LANCE_R;
  for (const r of base.gridRigs) {
    const d = Math.hypot(phys.x - r.x, phys.z - r.z);
    if (d < bd && r.film > 0.001) { bd = d; best = r; }
  }
  stormPlay.aim = best;
  if (best) {
    best.film = Math.max(0, best.film - FILM.LANCE_TAP * dt);
    if (best.film < 0.02 && !best.cleaned) {
      best.cleaned = true;
      UI.toast(t('✔ {name}：阵列已吹净 — 出力恢复，光台重新亮起来').replace('{name}', t(best.name)));
      audio.radio('good');
    } else if (best.film > 0.05) best.cleaned = false;
  }
  // The lance is a jet of gas, so it shows the thing it is doing: the dust coming *off* the target,
  // thrown downwind of the beam. Emitting at the far end rather than the muzzle keeps the plume on
  // the array you are cleaning instead of in your own face.
  const yaw = phys.yaw;
  const mx = phys.x + Math.sin(yaw) * 1.5, mz = phys.z + Math.cos(yaw) * 1.5;
  const tx = best ? best.x : mx + Math.sin(yaw) * 7, tz = best ? best.z : mz + Math.cos(yaw) * 7;
  const ty = best ? surfaceAt(best.x, best.z) + 1.4 : 1.2;
  const dx = tx - mx, dz = tz - mz, dl = Math.max(0.001, Math.hypot(dx, dz));
  for (let i = 0; i < 3; i++) {
    const s = 7 + Math.random() * 5;
    fx.dust.emit(mx + (Math.random() - .5) * .6, 0.9 + Math.random() * .5, mz + (Math.random() - .5) * .6,
      (dx / dl) * s * 0.55, 1.4 + Math.random() * 1.6, (dz / dl) * s * 0.55, 0.55, 2.2);
    if (best && Math.random() < 0.5) {
      const a = Math.random() * 6.283;
      fx.dust.emit(tx + Math.cos(a) * 1.4, ty + Math.random() * 2.2, tz + Math.sin(a) * 1.4,
        Math.cos(a) * 2.6, 0.8 + Math.random() * 1.4, Math.sin(a) * 2.6, 0.9, 3.0);
    }
  }
}

// ═══════════════════════════ 信标失锁：沙尘打回"按地标驾驶" ═══════════════════════════
// The storm's second tax is on the cockpit, not the paint. Suspended fines are what scrambles the
// rover's optical fix, so the objective arrow degrades with the dust *at the rover* rather than with
// a global "storm on" flag — skirt around the leading edge and you keep your navigation, which makes
// reading the front a driving skill instead of a waiting game.
// Re-acquiring is not a timer either: the solution needs fixes, and the only fixes the rover can
// take are the lit tap columns it can actually see. That is what welds this to the dust ledger above —
// let a district's array silt up, its column dims, its landmark range shrinks, and the base stops
// being able to tell you where anything is. Cleaning an array is therefore also restoring your map.
const NAV = {
  LOSS: 0.30,        // local airborne dust above which the fix starts sliding
  DECAY: 0.62,       // lock/s shed at a fully loaded front
  HOLD: 1.8,         // s of breathable air before the solution re-runs at all
  REACQ: 0.34,       // lock/s regained with two or more landmarks in sight…
  LAND_MIN: 0.30,    // …and the fraction of that rate you get with none (you can always crawl back)
  LAND_R: 58,        // m — how far off a tap column still reads as a landmark
  BLIND: 0.34,       // below this the arrow is worse than no arrow, so stop drawing it
};
// One derived flag, three consumers (arrow, map, chip). The threshold is a gameplay decision and
// lives with the rest of them, so no HUD element gets to invent its own idea of "blind".
const nav = { lock: 1, wait: 0, landmarks: 0, homing: 0, blind: false, lost: false };

function updateNav(dt, st) {
  const dust = Math.max(stormField.local(phys.x, phys.z), st.stormF * 0.55);
  let lm = 0;
  // A thicker sky reaches less far, and a silted array is a dimmer column — both shorten the set of
  // things the rover can recognise, with no new geometry and no new number to read.
  const reach = NAV.LAND_R * (1 - Math.min(0.5, st.stormF * 0.45));
  for (const r of base.gridRigs) {
    if (!r.online || r.power < 0.2) continue;
    if (Math.hypot(phys.x - r.x, phys.z - r.z) < reach * (1 - r.film * 0.45)) lm++;
  }
  nav.landmarks = lm;

  const load = THREE.MathUtils.clamp((dust - NAV.LOSS) / (1 - NAV.LOSS), 0, 1);
  if (load > 0.02) {
    nav.wait = 0; nav.homing = 0;
    nav.lock = Math.max(0, nav.lock - dt * NAV.DECAY * load);
  } else {
    nav.wait += dt;
    const rate = NAV.REACQ * (NAV.LAND_MIN + (1 - NAV.LAND_MIN) * Math.min(1, lm / 2));
    if (nav.wait >= NAV.HOLD) nav.lock = Math.min(1, nav.lock + dt * rate);
    nav.homing = nav.lock >= 1 ? 0 : Math.max(0, NAV.HOLD - nav.wait) + (1 - nav.lock) / rate;
  }
  nav.blind = nav.lock < NAV.BLIND;
  // Announce the loss, not the recovery: the recovery is the arrow visibly steadying, which needs no
  // permission slip, while the loss is the one moment the player's whole plan changes.
  if (nav.blind && !nav.lost) {
    nav.lost = true;
    UI.toast(t('⊘ 光学导航失锁 — 按地标驾驶，驶近亮着的光台才能重新定位'));
    audio.radio('bad');
  } else if (nav.lock > NAV.BLIND + 0.18) nav.lost = false;
}


// ───────────────────────── launch sequence ─────────────────────────
// A stack does not light into a dust front, and the chain's last beat now sends one across the pad on
// purpose — so the deck needs to say why nothing is counting down yet, with the same clock the top bar
// carries. Two conditions, because they are two different facts: the sky over the range has to be out
// of the front's way (including a wall the chain armed but has not launched, which is what makes the
// beat a deadline rather than a surprise), and the pad itself has to be free of hanging dust.
// Seconds come from the field analytically, so the number the deck counts cannot disagree with the
// wall on the horizon.
const LAUNCH_DUST_LIMIT = 0.12;
function launchWeatherHold() {
  const pad = base.launchPadPos;
  const clear = stormField.timeToClear();
  if (clear <= 0 && stormField.local(pad.x, pad.z) < LAUNCH_DUST_LIMIT) return null;
  return `⚠ ${t('发射窗口 · 等待沙暴过境')}${clear > 0 ? ' ' + mmss(clear) : ''}`;
}
function startCountdown() {
  if (race.active) { race.active = false; UI.raceShow(false); race.rings.forEach(r => r.visible = false); }
  // One slot, one line: the weather note rides along inside the launch notice instead of overwriting it.
  UI.toast(launch.held ? '✦ 天空转晴 — 发射程序启动 · 请留在观礼台安全区' : '⚠ 发射程序启动 · 请留在观礼台安全区');
  launch.held = false;
  launch.phase = 'countdown'; launch.cd = 10.0;
}
// The finale fires two beats inside half a second of each other (boost MECO, then ship ignition), and
// there is one toast slot. Showing them as they land would silently drop one, so the text goes through
// a queue with a fixed gap while each beat's rings, flash and radio cue still fire the instant the
// flight module reports it. The event log the HUD will read is unaffected either way.
const launchQueue = [];
let launchGap = 0;
function updateLaunch(dt) {
  if (launchGap > 0) {
    launchGap -= dt;
  } else if (launchQueue.length) {
    UI.toast(launchQueue.shift(), 3600);
    launchGap = 6;
  }
  if (launch.phase === 'countdown') {
    launch.cd -= dt;
    const n = Math.ceil(launch.cd);
    if (n !== launch.lastCd && n > 0) { launch.lastCd = n; UI.countdown(n); audio.cue(); }
    if (n <= 0) {
      UI.countdown(t('升空')); audio.radio('good');
      launch.phase = 'flight';
      // From here the flight module owns where the two vehicles are. What still lives down here is
      // everything the game *does* about a launch: the notices, the rings, the particles, the shake.
      launch.flight = createLaunch(base.launchRig, launch);
      launch.flight.start();
    }
    return;
  }
  const F = launch.flight;
  if (!F || launch.phase !== 'flight') return;
  F.update(dt);
  for (const b of F.drain()) launchBeat(b);
  if (F.done) finishLaunch();
  else {
    seedPlumes(F);
    const prox = THREE.MathUtils.clamp(1 - Math.hypot(phys.x - base.launchPadPos.x, phys.z - base.launchPadPos.z) / 140, 0.12, 1);
    chase.trauma = Math.max(chase.trauma, 0.25 + prox * 0.75 * launch.intensity);
    audio.updateLaunch?.(launch.intensity);
    launch.audioLevel = launch.intensity * prox;
  }
  if (launch.flash > 0) launch.flash = Math.max(0, launch.flash - dt * 0.85);
}

const _bp = new THREE.Vector3();
function launchBeat(b) {
  const F = launch.flight, rig = base.launchRig;
  const line = getLang() === 'en' ? b.en : b.zh;
  launchQueue.push(`◦ ${line} · T+${b.t.toFixed(0)}s`);
  if (b.id === 'liftoff') {
    // The deck's own beat: the overpressure ring that used to be keyed to a timer is now the moment
    // the thrust actually beats the weight, so it fires when the stack leaves, not when the clock says.
    UI.countdown(null);
    launch.flash = 1;
    const ring = shockWave(base.launchPadPos.x, surfaceAt(...ZONES.launch.pos) + 2, base.launchPadPos.z, 0xffd8a0, 10);
    if (ring) ring.userData.grow = 9;
    audio.cue();
  } else if (b.id === 'staging') {
    const s = F.point(_bp, rig.seam - 0.5);
    const ring = shockWave(s.x, s.y, s.z, 0xffc46a, 6);
    if (ring) ring.userData.grow = 5;
    launch.flash = Math.max(launch.flash, 0.45);
    audio.cue();
  } else if (b.id === 'boosterlanding') {
    // Two vehicles, two returns: the booster coming home to the deck it left is the beat the whole
    // guided descent exists to produce, so it gets the pad ring and the good news on the radio.
    const s = F.point(_bp.set(0, 0, 0), 2);
    const ring = shockWave(s.x, surfaceAt(...ZONES.launch.pos) + 1.5, s.z, 0x9fe8ff, 7);
    if (ring) ring.userData.grow = 7;
    launchQueue.unshift(`✦ ${t('助推级回到发射台')}`);
    audio.radio('good');
  } else if (b.id === 'seco') {
    // The old sequence ended by declaring the ship out of the atmosphere at 2600 m; SECO is the same
    // fact, said by the engine that stops pushing rather than by a height the camera can't resolve.
    launchQueue.unshift(t('✦ 星舰已离开大气层 — 「愿它在群星间找到家」'));
    missions[3].done = true; renderMissions(); stormField.freeSky(); audio.radio('good');
  }
}
function finishLaunch() {
  launch.phase = 'done'; launch.doneAt = elapsed;
  // Only the ship leaves. The booster came home, and a booster standing on its own pad with the
  // engines cold is the picture the whole sequence was built to arrive at — hiding the mount, as the
  // old code did, erased it along with the vehicle that had already flown away.
  base.launchRig.upper.visible = false;
}

const _pq = new THREE.Vector3(), _pr = new THREE.Vector3(), _pt = new THREE.Vector3(), _pv = new THREE.Vector3();
function seedPlumes(F) {
  for (const p of F.plumes) {
    if (p.power <= 0) continue;
    // A vehicle crossing the sky covers tens of metres in one frame on a slow machine, so the trail
    // has to be seeded along the swept path instead of at one point or it becomes a dotted chain.
    const reach = _pq.copy(p.pos).sub(p.prev).length();
    const steps = THREE.MathUtils.clamp(1 + Math.floor(reach / 6), 1, 8);
    const n = Math.max(1, Math.round(2.0 * p.engines * quality.particles * (0.4 + p.power) / steps));
    // The ring of particles is laid out in the plane normal to that vehicle's own exhaust axis, so
    // the plume follows the lean instead of assuming the rocket is standing up.
    _pr.set(0, 1, 0);
    if (Math.abs(p.axis.y) > 0.98) _pr.set(1, 0, 0);
    _pt.crossVectors(p.axis, _pr).normalize();
    _pr.crossVectors(_pt, p.axis).normalize();
    for (let s = 0; s < steps; s++) {
      _pq.copy(p.prev).lerp(p.pos, (s + 1) / steps);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283, r = 0.3 + Math.random() * 2.2;
        _pv.copy(_pt).multiplyScalar(Math.cos(a) * r).addScaledVector(_pr, Math.sin(a) * r);
        fx.flame.emit(
          _pq.x + _pv.x + p.axis.x * 0.6, _pq.y + _pv.y + p.axis.y * 0.6, _pq.z + _pv.z + p.axis.z * 0.6,
          p.axis.x * (15 + Math.random() * 8) + _pv.x * 1.4,
          p.axis.y * (15 + Math.random() * 8) + _pv.y * 1.4,
          p.axis.z * (15 + Math.random() * 8) + _pv.z * 1.4,
          0.7 + Math.random() * 0.5, 3 + Math.random() * 3
        );
        if (Math.random() < 0.5) {
          const rr = 3 + Math.random() * 4;
          _pv.copy(_pt).multiplyScalar(Math.cos(a) * rr).addScaledVector(_pr, Math.sin(a) * rr);
          fx.smoke.emit(
            _pq.x + _pv.x, _pq.y + _pv.y + Math.random() * 2, _pq.z + _pv.z,
            _pv.x * 2, 2 + Math.random() * 2.5, _pv.z * 2,
            2.6 + Math.random() * 2, 6 + Math.random() * 6
          );
        }
      }
    }
  }
}
const shockRings = [];
function shockWave(x, y, z, color = 0x8fe8ff, r = 5) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.14, 8, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  ring.rotation.x = Math.PI / 2; ring.position.set(x, y, z);
  scene.add(ring); ring.userData.born = elapsed; ring.userData.grow = 1.7;
  shockRings.push(ring);
  return ring;
}
let launchCamW = 0;                       // 0..1 blend into the launch framing
const launchAim = new THREE.Vector3();
const launchAir = { x: 0, y: 0, z: 0, w: 0 };   // held camera station for the ascent tracking shot

// park the rover somewhere flat — used by the demo URLs and by the headless checks
function warpTo(wx, wz, facePad = false, search = 8) {
  let bx = wx, bz = wz, bs = Infinity;
  const solids = (base?.colliders || []).filter(c => c.floor === undefined);
  for (let dx = -search; dx <= search; dx += 2) for (let dz = -search; dz <= search; dz += 2) {
    // Flatness alone used to pick the pose: a demo URL asking for the launch apron could be parked
    // inside a gantry, and the rover then had no controls left to push itself out with.
    const s = surfaceSlope(wx + dx, wz + dz) + (gapFrom(solids, wx + dx, wz + dz) >= 0.3 ? 0 : 9);
    if (s < bs) { bs = s; bx = wx + dx; bz = wz + dz; }
  }
  [bx, bz] = freeLanding(bx, bz);
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
      saveBoard({ name: `${t('漫游车')} ${new Date().toLocaleDateString('zh-CN')}`, time: fmtTime(race.t), ms, ts: Date.now() });
      UI.toast(t('✦ 计时赛完成 {time} — 已记入排行榜').replace('{time}', fmtTime(race.t)));
      UI.raceShow(false);
      race.rings.forEach(r => r.visible = false);
      return;
    }
  }
  race.rings.forEach((r, i) => {
    r.children[0].material.opacity = i === race.idx ? 0.9 : 0.15;
    r.rotation.z += dt * (i === race.idx ? 1.2 : 0.2);
  });
  UI.raceShow(true, fmtTime(race.t), `${t('检查点')} ${race.idx}/${race.gates.length}`);
}

// ───────────────────────── runtime unstick ─────────────────────────
// A2's scan says the base has no wedges left in it, so whatever still pins a rover is a case the
// scan cannot see: a prop moved by a later commit, a slope that grabs the wheels, two discs whose
// push-out normals cancel between substeps. The player must never be left holding keys against
// static geometry — that is the exact report this replaces ("WASD 失效") — so `update` watches for
// the state and drives the rover out of it itself:
//   back-out  real throttle, away from the deepest contact, aimed at whichever heading has the
//             daylight. Same grip, same slope, same collision response: it is a drive, not a rescue.
//   jack      if 1.8 s of throttle moved nothing, raise the chassis on its recovery rams and glide
//             to the nearest legal surface. The collider discs are 2D, so lifting alone frees
//             nothing — the horizontal glide is the escape and the lift is what stops the wheels
//             dragging through the ground on the way.
// Nothing teleports and nothing clips: `jack` interpolates over 1.15 s with a smoothstep, so
// velocity starts and ends at zero and the rover never moves further in a frame than it drives,
// and a glide path is rejected unless every half metre of it is clear of props the rover was not
// ALREADY touching. Control is never taken away either — the raw key set is watched separately
// from the synthesised pedals, so tapping S or Space hands the rover straight back.
const BODY_R = 1.6;                 // physics.js pads every collider disc by this for the body ring
const rescue = {
  phase: '', t0: 0, cool: 0, tries: 0, markT: 0, markX: 0, markZ: 0,
  ax: 0, az: 0, heading: 0, reverse: false, from: null, to: null, near: [], maxStep: 0,
  heldBrake: false, heldDrift: false, events: [],
};
const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));

// Distance from the body ring at (x,z) to the nearest solid disc; negative once it is inside.
// `ignore` carries the discs the rover is already wedged between — those are the pocket it is
// leaving, not a wall it would clip.
function gapFrom(list, x, z, ignore) {
  let gap = 99;
  for (const c of list) {
    if (ignore && ignore.has(c)) continue;
    const d = Math.hypot(x - c.x, z - c.z) - c.r - BODY_R;
    if (d < gap) gap = d;
  }
  return gap;
}

// Every half metre of the line must sit outside the body ring of every prop not already touched.
function glideClear(list, x0, z0, x1, z1, ignore) {
  const d = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(2, Math.ceil(d / 0.5));
  for (let i = 1; i <= n; i++) {
    const f = i / n;
    if (gapFrom(list, x0 + (x1 - x0) * f, z0 + (z1 - z0) * f, ignore) < 0) return false;
  }
  return true;
}

// The nearest point the rover could legally be parked: outside every body ring, on ground it can
// actually sit on, and reachable along such a line. Rings grow outward, so the first ring with any
// answer holds the nearest one; onward daylight breaks ties.
//
// `PLAYFIELD_R` is the same test seen from the other side. The island is a disc: past its radius the
// ground climbs the crater wall and then drops 30 m into a void the terrain mesh does not even cover,
// so a legal surface out there is a lie the rescue can keep acting on — carrying the rover onto flat
// nothing, which is precisely how A5's permanent stuck read. It reads `RIM.face` rather than deriving
// its own margin, because that is the radius the barrier's discs actually stop a rover's skin at and
// the radius the dust veil draws on: three consumers, one circle, so the rescue can never park a
// rover past the wall the player can see.
const PLAYFIELD_R = RIM.face;
function nearestLegalSurface(list, maxR = 13) {
  const wedged = new Set(list.filter(c => Math.hypot(phys.x - c.x, phys.z - c.z) < c.r + BODY_R + 0.35));
  for (let r = 2.5; r <= maxR; r += 1.25) {
    let best = null;
    for (let k = 0; k < 24; k++) {
      const a = ((k + (Math.round(r / 1.25) % 2)) / 24) * Math.PI * 2;
      const x = phys.x + Math.sin(a) * r, z = phys.z + Math.cos(a) * r;
      if (Math.hypot(x, z) > PLAYFIELD_R || surfaceSlope(x, z) > 0.55) continue;
      if (gapFrom(list, x, z) < 0.3) continue;
      if (!glideClear(list, phys.x, phys.z, x, z, wedged)) continue;
      const onward = Math.min(3, Math.max(0, gapFrom(list, x + Math.sin(a) * 3, z + Math.cos(a) * 3)));
      const score = r - onward;
      if (!best || score < best.score) best = { x, z, r, a, score };
    }
    if (best) return best;
  }
  return null;
}

function startRescue(cause, inp) {
  rescue.near = base.colliders.filter(c => c.floor === undefined &&
    Math.hypot(phys.x - c.x, phys.z - c.z) < c.r + BODY_R + 26);
  // a pedal already down when the rescue fires is the player's own attempt, not a takeover
  rescue.heldBrake = inp.brake > 0.5;
  rescue.heldDrift = inp.drift > 0.5;
  rescue.tries++;
  const vf = phys.vx * Math.sin(phys.yaw) + phys.vz * Math.cos(phys.yaw);
  const rec = { t: +elapsed.toFixed(1), cause, pos: [+phys.x.toFixed(1), +phys.z.toFixed(1)],
    yaw: +phys.yaw.toFixed(2), vf: +vf.toFixed(2), slope: +surfaceSlope(phys.x, phys.z).toFixed(2),
    grounded: phys.grounded, onFloor: phys.onFloor, discs: rescue.near.length, out: '' };
  // Outside the playfield there is nothing to back out of, and the back-out cannot even fail: it
  // calls itself done after 1.9 m of movement, which a rover leaning on the rampart gets for free
  // every time it is nudged off the wall. Measured — seven rescues in 60 s at r=118.4, each recorded
  // as "drove out" with 10 m of daylight behind it, and the carry never once being asked for. The
  // only exit from out there is the one a ring search can't answer, so go straight to it.
  if (Math.hypot(phys.x, phys.z) > PLAYFIELD_R) {
    rec.open = null;
    rescue.events.push(rec);
    return escalate('outside-playfield');
  }
  if (!rescue.near.length) {
    // no prop within 26 m: this is terrain holding the wheels, so skip the drive-out
    rec.open = null;
    rescue.events.push(rec);
    return escalate('terrain');
  }
  let best = null;
  for (let k = 0; k < 16; k++) {
    const a = phys.yaw + (k / 16) * Math.PI * 2;
    let d = 0;
    while (d < 10 && gapFrom(rescue.near, phys.x + Math.sin(a) * (d + 0.5), phys.z + Math.cos(a) * (d + 0.5)) >= 0) d += 0.5;
    if (!best || d > best.d) best = { a, d };
  }
  rescue.phase = 'back-out';
  rescue.t0 = elapsed;
  rescue.ax = phys.x; rescue.az = phys.z;
  rescue.heading = best.a;
  rescue.reverse = Math.abs(wrapPi(best.a - phys.yaw)) > Math.PI / 2;
  rescue.maxStep = 0;
  Object.assign(rec, { open: +best.d.toFixed(1), reverse: rescue.reverse, heading: +best.a.toFixed(2) });
  rescue.events.push(rec);
  if (rescue.events.length > 24) rescue.events.shift();
  // No heading has half a metre of daylight: the body ring is inside overlapping props, so there is
  // nothing to drive toward and throttle only leans on the pile. A carry is the only exit — going
  // through the back-out first just lets the collision solver throw the rover out blind.
  if (!best.d) return escalate('buried');
  UI.toast('⟲ 探测到卡死 — 自动脱困程序介入，倒出夹缝');
  audio.radio('beep');
}

// A rover outside the playfield has an answer a ring search can never produce, because it is not
// nearby — it is inward. Same `jack` glide as an ordinary carry, so it still comes down on its own
// rams onto ground `surfaceAt` covers, at a bearing it can drive away from; only the destination
// rule differs. The radii step inboard until the landing is clear of every prop's body ring.
function returnToPlateau() {
  const a = Math.atan2(phys.x, phys.z);                 // the rover's own bearing out from the hub
  let to = null;
  for (let k = 0; k < 4 && !to; k++) {
    const r = PLAYFIELD_R - 10 - k * 11;
    const p = { x: Math.sin(a) * r, z: Math.cos(a) * r };
    if (gapFrom(base.colliders, p.x, p.z) > 0.6) to = { ...p, r, a };
  }
  if (!to) return false;
  to.slip = Math.hypot(to.x - phys.x, to.z - phys.z);
  rescue.phase = 'jack'; rescue.t0 = elapsed; rescue.maxStep = 0;
  rescue.from = { x: phys.x, z: phys.z }; rescue.to = to;
  const rec = rescue.events[rescue.events.length - 1];
  if (rec && rec.out === '') Object.assign(rec, { out: 'returned', slip: +to.slip.toFixed(1), cause: 'outside-playfield' });
  UI.toast('⟲ 已越出环形山壁 — 回收程序把漫游车送回台地');
  audio.radio('beep');
  return true;
}

function escalate(cause) {
  // Each failed attempt looks wider: a pocket the first 13 m cannot answer is a deep one.
  const outside = Math.hypot(phys.x, phys.z) > PLAYFIELD_R;
  const to = outside ? null : nearestLegalSurface(rescue.near, Math.min(25, 13 + 4 * (rescue.tries - 1)));
  if (!to) {
    if (outside && returnToPlateau()) return;
    const rec = rescue.events[rescue.events.length - 1];
    if (rec && rec.out === '') rec.out = 'unresolved';
    rescue.phase = ''; rescue.cool = 4;
    UI.toast('⚠ 自动脱困找不到落点 — 请按 S 倒车离开这里');
    return;
  }
  rescue.phase = 'jack'; rescue.t0 = elapsed; rescue.maxStep = 0;
  rescue.from = { x: phys.x, z: phys.z }; rescue.to = to;
  const rec = rescue.events[rescue.events.length - 1];
  if (rec && rec.out === '') Object.assign(rec, { out: 'jack', slip: +to.r.toFixed(1), cause });
  UI.toast('⟲ 自动脱困 — 抬升车体，滑向最近净空路面');
}

function endRescue(out) {
  const rec = rescue.events[rescue.events.length - 1];
  if (rec) Object.assign(rec, { out, gotOut: +Math.hypot(phys.x - rec.pos[0], phys.z - rec.pos[1]).toFixed(1),
    at: +elapsed.toFixed(1), maxStep: +rescue.maxStep.toFixed(2) });
  rescue.phase = ''; rescue.cool = 3;
  if (out === 'drove out' || out === 'carried') rescue.tries = 0;
  rescue.markT = 0;
}

// The pedals the physics receives. Outside a rescue these are exactly the player's.
function rescuePedals(inp) {
  const cmd = { gas: inp.gas, brake: inp.brake, steer: inp.steer, drift: inp.drift };
  if (rescue.phase !== 'back-out') return cmd;
  const nose = rescue.reverse ? wrapPi(rescue.heading + Math.PI) : rescue.heading;
  const err = wrapPi(nose - phys.yaw);
  cmd.gas = rescue.reverse ? 0 : 0.8;
  cmd.brake = rescue.reverse ? 1 : 0;
  cmd.drift = 0;
  // positive steer rotates yaw downwards, so closing a positive error takes a negative pedal
  cmd.steer = Math.abs(inp.steer) > 0.25 ? inp.steer : -Math.sign(err) * Math.min(1, Math.abs(err) * 1.6);
  return cmd;
}

// The recovery carry itself: a smoothstep slide, lifted clear of the surface it leaves.
function rescueGlide(dt) {
  const T = 1.15;
  const f = Math.min(1, (elapsed - rescue.t0) / T);
  const e = f * f * (3 - 2 * f);
  const x = THREE.MathUtils.lerp(rescue.from.x, rescue.to.x, e);
  const z = THREE.MathUtils.lerp(rescue.from.z, rescue.to.z, e);
  rescue.maxStep = Math.max(rescue.maxStep, Math.hypot(x - phys.x, z - phys.z));
  const gy = platformAt(base.colliders, x, z);
  phys.x = x; phys.z = z;
  phys.groundY = gy; phys.onFloor = gy > surfaceAt(x, z) + 0.05;
  phys.prevGroundH = gy + 0.46;
  phys.y = gy + 0.46 + 0.55 * Math.sin(Math.PI * e);   // up on the rams, down onto the new surface
  phys.vx = 0; phys.vy = 0; phys.vz = 0; phys.speed = 0; phys.lateral = 0; phys.grounded = true;
  phys.pitch += (0 - phys.pitch) * Math.min(1, dt * 4);
  phys.roll += (0 - phys.roll) * Math.min(1, dt * 4);
  if (f >= 1) endRescue('carried');
}

// "Stuck" is the audit's own bar, so the game can never claim it recovered something the test
// would still file as a deadlock: throttle held, and less than a metre of NET ground in 2.2 s.
function rescueWatch(inp, dt) {
  if (rescue.cool > 0) rescue.cool = Math.max(0, rescue.cool - dt);
  const push = Math.max(inp.gas, inp.brake);
  if (rescue.phase === 'back-out') {
    const moved = Math.hypot(phys.x - rescue.ax, phys.z - rescue.az);
    if (moved > 1.9 || (phys.speed > 1.6 && moved > 1.0)) return endRescue('drove out');
    // S / Space is the "I will get out myself" gesture, and the rescue never uses either pedal,
    // so a fresh press hands the rover back inside the same frame
    if ((inp.brake > 0.5 && !rescue.heldBrake) || (inp.drift > 0.5 && !rescue.heldDrift)) {
      return endRescue('player took over');
    }
    if (elapsed - rescue.t0 > 1.8) return escalate('back-out failed');
    return;
  }
  if (rescue.phase || rescue.cool > 0 || teleOpen || demoPin || photo.on || grid.dead || paused) {
    rescue.markT = 0;
    return;
  }
  if (push < 0.15) { rescue.markT = 0; return; }
  if (push < 0.35) return;
  // the window only counts while the pedal is genuinely buried, so an anchor set at the moment
  // the press began is what makes "no net ground in 2.2 s" mean the same thing here as in `drive`
  if (!rescue.markT) { rescue.markT = elapsed; rescue.markX = phys.x; rescue.markZ = phys.z; return; }
  if (elapsed - rescue.markT >= 2.2) {
    const net = Math.hypot(phys.x - rescue.markX, phys.z - rescue.markZ);
    if (net < 0.9 && phys.grounded) startRescue('no-net-progress', inp);
    rescue.markT = elapsed; rescue.markX = phys.x; rescue.markZ = phys.z;
  }
}

// ───────────────────────── main update ─────────────────────────
let lastInfoZone = null;
function update(dt) {
  elapsed += dt;
  // Read once at the top: the HUD, the lamps and the post pass all need the day/night state, and
  // an info-zone line that used `st` before its old declaration point threw straight out of
  // tick() — which skipped the render call and froze the canvas for the rest of the session.
  const st = env.state;
  const inp = input.read();
  if (teleOpen) { inp.gas = inp.brake = inp.steer = inp.drift = inp.interact = 0; }
  // Deposition, the lance and their battery bill run before the sag is read, so the frame the
  // player spends charge cleaning is the same frame the motors notice it.
  updateStormPlay(dt, st, inp);
  updateNav(dt, st);
  // drive physics — a flat battery kills the motors, and the last 20 % sags so that running
  // dry is a slow, obvious slide into trouble rather than a sudden loss of control
  const sag = grid.dead ? 0 : THREE.MathUtils.clamp((grid.battery - 0.06) / 0.16, 0.42, 1);
  // What the weather hands the vehicle. The air velocity is passed as velocity, never as a force:
  // ½ρCdA/m on a 260 kg boxy chassis in 0.020 kg/m³ air is 7.3e-5, so the force is the physics
  // module's own arithmetic and the mass and area stay next to the wheels that pay them. The storm
  // reaches the driver through `soft` — dust bedded under the tyres, which is a surface effect on
  // Mars and the only place a 0.02 kg/m³ atmosphere can legally be felt. The gust term doubles as
  // the camera buffeting amplitude a frame later, so nothing has to agree with the weather by hand.
  const _wHere = st.stormF;
  const _wGust = 0.55 + 0.45 * (st.stormGust || 0);
  const wind = {
    vx: stormField.wx * stormField.speed, vz: stormField.wz * stormField.speed,
    soft: THREE.MathUtils.clamp(0.8 * _wHere + 0.4 * stormField.dustLoad, 0, 1),
    gust: _wGust * _wHere,
  };
  lastWind = wind;
  if (rescue.phase === 'jack') {
    rescueGlide(dt);
  } else {
    const cmd = rescuePedals(inp);
    phys.update(dt, { gas: cmd.gas * sag, brake: cmd.brake, steer: cmd.steer, drift: cmd.drift * (grid.dead ? 0 : 1) }, base.colliders, wind);
  }
  rescueWatch(inp, dt);
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
  // A storm's deposit is only believable if it lands on the thing you are sitting in. Driving
  // scours the windward body panels, so the film climbs with deposition load but is rubbed back
  // down by ground speed — the same balance that leaves the panels clean after a run and filthy
  // after an hour parked in the front. It is now its own accumulator rather than a copy of the
  // island-wide load, which is what lets the lance take it off and the paint stay clean afterwards.
  rover.setDust(roverFilm);
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
  let zone = null, bestD = 1e9, nearSite = null;
  for (const z of base.infoZones) {
    if (z.r > 9000) continue;
    const d = Math.hypot(phys.x - z.pos[0], phys.z - z.pos[1]);
    if (d < z.r && d < bestD) { bestD = d; zone = z; }
  }
  const samplesZone = liveSamples().length ? base.infoZones.find(z => z.key === 'samples') : null;
  for (const s of liveSamples()) {
    const d = Math.hypot(phys.x - s.x, phys.z - s.z);
    if (!s.taken && d < 10 && (!nearSite || d < nearSite.d)) nearSite = { s, d };
  }
  // A site under a drift outranks whatever pad it happens to stand beside. Six of the nine sit on a
  // zone's outer edge, and the launch mount's circle swallows one of them: measured 2026-09-22, parked
  // 5.2 m from a 70 %-buried crystal the card read 「星舰总装塔」 and said nothing about the refusal —
  // which is the exact silence this slot exists to prevent. Nothing else may steal the panel, because
  // an unburied site yields on contact and never needed the card at all.
  if (nearSite && samplesZone) {
    if (nearSite.s.buried >= SAND.DEAD) zone = samplesZone;
    else if (!zone) zone = samplesZone;
  }
  // The action slot is written *before* the card is painted. `showInfo` caches the card body by zone
  // key and only repaints when the zone changes, so a hudAction assigned after that call lands a frame
  // late — which is to say never, for a player who stands still. Measured 2026-09-22: the 修复 prompt at
  // the tanks and the 灯光秀 prompt at the pad were both invisible while parked inside their own zones.
  if (zone?.key === 'tanks' && !leakFixed) zone.hudAction = `${t('靠近白色雾流，按住')} ${input.isTouch ? t('「交互」') : 'E'} ${t('修复')}`;
  // The light show was a discoverable-by-accident feature; it is the one thing to do at the pad
  // after dark, so the panel says so in the same slot the repair instruction uses.
  if (zone?.key === 'launch' && st.nightF > 0.5 && showOn <= 0 && launch.phase === 'idle')
    zone.hudAction = `${t('按住')} ${input.isTouch ? t('「交互」') : 'E'} ${t('点亮星舰灯光秀')}`;
  if (zone !== lastInfoZone) { lastInfoZone = zone; UI.showInfo(zone); }
  // Two slots hold a number that changes while the player does not move, so they cannot ride the
  // cached paint and hand `showInfo` a fresh object instead.
  //
  // The buried site is the one case where nothing is supposed to happen on contact: it reports the
  // cover depth rather than the reward, and names the verb that fixes it, so the mechanic reads as
  // weather and not as a broken trigger.
  if (zone?.key === 'samples' && nearSite && nearSite.s.buried >= SAND.DEAD) {
    UI.showInfo({ ...zone, key: 'samples', hudAction: `${t('覆沙')} ${Math.round(nearSite.s.buried * 100)}% · ${siteName(nearSite.s)} — ${t('绕圈开快些，用车轮把沙刮开')}` });
  }
  // The deck is where the chain's weather has to be legible: parked inside the countdown ring with
  // nothing happening, the player must be able to read the reason and its clock.
  if (zone?.key === 'watch' && launchArmed && launch.phase === 'idle') {
    UI.showInfo({ ...zone, key: 'watch', hudAction: launchWeatherHold() || t('★ 已抵达观礼台 — 发射程序即将启动') });
  }

  // missions
  const nearLeak = Math.hypot(phys.x - base.leakPoint.x, phys.z - base.leakPoint.z) < 12;
  if (mAct() === 'leak' && !leakFixed) {
    if (nearLeak && inp.interact > 0 && phys.speed < 1.5) {
      repairHold += dt;
      UI.showInfo({ ...lastInfoZone || base.infoZones.find(z => z.key === 'tanks'), hudAction: `${t('密封中…')} ${Math.min(100, Math.round(repairHold / 3 * 100))}%`, key: 'tanks' });
      if (repairHold >= 3) {
        leakFixed = true; missions[1].done = true;
        UI.toast('✔ 泄漏已封堵 — 推进剂压力恢复'); audio.radio('good'); advanceMission();
      }
    } else if (!nearLeak) repairHold = 0;
  }
  if (mAct() === 'samples') {
    for (const s of liveSamples()) {
      // Under a drift the crystal is not where the map put it, it is half a metre down the sand the
      // front just dropped. It does not yield here — but the panel says why (see 覆沙 below), because
      // the one thing that must never happen is the game going quiet on a player parked on the objective.
      if (s.taken || s.buried >= SAND.DEAD || Math.hypot(phys.x - s.x, phys.z - s.z) >= 4.2) continue;
      s.taken = true; s.group.visible = false; samplesTaken++;
      missions[2].n = samplesTaken;
      renderMissions(); audio.radio('beep');
      UI.toast(t('✦ 样本 {n}/{total} 已入库').replace('{n}', samplesTaken).replace('{total}', missions[2].total));
      for (let i = 0; i < 40; i++) fx.spark.emit(s.x, 1, s.z, (Math.random() - .5) * 8, 3 + Math.random() * 5, (Math.random() - .5) * 8, 0.8, 2);
      if (samplesTaken >= missions[2].total) { missions[2].done = true; advanceMission(); }
    }
  }
  if (launchArmed && launch.phase === 'idle' && mAct() === 'watch') {
    // Ignition waits for the sky, and the gate sits on the trigger rather than only on the card: the
    // countdown ring is 26 m wide while the info zone is smaller, so a player who drives through the
    // deck during a front would otherwise start the sequence with dust still on the pad. `held` is
    // recorded here because this is where the game actually knows it said no.
    if (Math.hypot(phys.x - base.watchPos.x, phys.z - base.watchPos.z) < 26) {
      if (launchWeatherHold()) launch.held = true;
      else startCountdown();
    }
  }
  updateLaunch(dt);
  updateRace(dt);
  UI.arrowAngle(phys, objectiveTarget(), nav, elapsed);

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
  // `st` was hoisted to the top of update(); re-declaring it here is what froze the canvas.
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
      ? `◈ ${t(padHere.name)} ${t('光台已就绪 — 按')} <kbd>G</kbd> ${t('跃迁')}（<kbd>M</kbd> ${t('全区地图')}）`
      : `⛔ ${t(padHere.name)} ${t('光台无电 — 复电后才能成像跃迁')}`;
  } else if (grid.target && phys.speed < 1.6 && !teleOpen) {
    teleHint.classList.remove('hidden');
    const pct = Math.round(grid.target.power * 100);
    teleHint.innerHTML = grid.battery > LINK_MIN
      ? `◈ ${t('并网中')} · ${t(grid.target.name)} <b>${pct}%</b> — ${t('保持停车直到反应桩亮起')}`
      : `⚡ ${t('电量不足')}（${Math.round(grid.battery * 100)}%）— ${t('无法并网，先回光台补电')}`;
  }
  teleHint._fab.classList.toggle('hidden', teleOpen || photo.on);
  teleHint._mute.classList.toggle('hidden', photo.on);
  if (teleOpen) drawTeleMap();

  // environment — the sightline is what the fog's direction-dependent density is sampled along
  camera.getWorldDirection(_viewDir);
  env.update(dt, rover.group.position, elapsed, renderer, _viewDir);
  const stormF = st.stormF;
  placeStormWall(stormWall, stormField, camera.position, dt, st.sunDir, STORM_TINT, STORM_GLOW, camera.position, env.fog);
  // The boundary haze rides the same wind the storm does — same vector, same gust envelope — so the
  // ring cannot be calm while the weather blowing across it is not. Its colour comes from `env.fog`,
  // which is where the storm's own tint already landed.
  rimVeil.advance(dt, {
    windX: stormField.wx, windZ: stormField.wz,
    shear: Math.min(1, stormField.gustEnv * 0.6 + stormF * 0.5),
    night: st.nightF, storm: stormF,
    camPos: camera.position, fog: env.fog, sunDir: st.sunDir,
  });
  // particles
  updateStorm(fx, dt, camera.position, stormField, surfaceAt);
  // Ambient smoke and steam now lean down the actual wind vector instead of a sine, so a plume
  // and a storm cannot disagree about which way the weather is blowing.
  const breezeX = stormField.wx * stormField.speed * 0.13, breezeZ = stormField.wz * stormField.speed * 0.13;
  fx.dust.update(dt, breezeX, breezeZ, aLvl * 0.4);
  fx.driftSmoke.update(dt, 0, 0, aLvl * 0.5);
  fx.spark.update(dt, 0, 0, 0);
  fx.flame.update(dt, 0, 0, aLvl);
  fx.smoke.update(dt, breezeX * 6, breezeZ * 6, 0);
  fx.steam.update(dt, breezeX * 8, breezeZ * 8, 0);

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
      // A real point on the real vehicle. The mount the camera used to chase has not moved since the
      // pad was built — the flight module moves the two bodies inside it — so following it would park
      // the view above an empty tower. Before the count clears there is no flight object yet, and the
      // stack is still the asset props.js authored, so the +15 m lift is what frames it.
      const F = launch.flight;
      const sp = F ? F.shipAim : base.shipGroup.position;
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
      launchAim.set(sp.x, sp.y + (F ? 0 : 15) - 6 * climb, sp.z);
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
    // Chassis buffeting. A rover in a front is hammered by a gust envelope that repeats on no
    // period the eye can lock onto, so the shake rides the weather's own two incommensurate
    // sines (φ = 2.3T and 0.7T) instead of the frame timer — the noise `physics` just spent on
    // the body, handed straight to the camera. Bounded to 0.34: a frame that shakes harder than
    // a kerb strike stops reading as wind and starts reading as a broken rig.
    if (wind.gust > 0.02 && phys.grounded) {
      const buff = 0.20 * wind.gust * (0.45 + 0.30 * Math.sin(elapsed * 2.3) + 0.25 * Math.sin(elapsed * 0.7 + 1.9));
      phys.trauma = Math.min(0.34, Math.max(phys.trauma, buff));
    }
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

  // audio — `windLoad` is the pressure the front is standing on right now: wind speed × the dust
  // fraction at the rover. It rises through `watch` before a single mote arrives, which is the
  // warning you hear with the radio off.
  audio.update(dt, {
    speed01: Math.min(1, phys.speed / 28), rpm: 0.3 + phys.enginePower * 0.7, power: phys.enginePower,
    stormF, windLoad: Math.min(1, stormField.speed / 26) * _wHere, windGust: wind.gust,
    nightF: st.nightF, camPos: camera.position,
    camFwd: camera.getWorldDirection(tmpV.set(0, 0, 1)), camUp: camera.up,
    roverPos: rover.group.position, leakActive: !leakFixed, launchIntensity: launch.audioLevel || 0,
    padPos: base.launchPadPos, blast: stormPlay.lance ? 1 : 0,
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
  fu.uStorm.value = stormF;
  // Suspended dust is the *medium* god rays need — a clear sky has no volume to light up. The old
  // `(1 - stormF)` deleted the one thing a low sun through a storm should do, so storms lost their
  // shafts entirely and the frame went flat. They now fade to a third instead of to zero.
  fu.uGodRay.value = quality.godrays && sunOnFrame ? (1 - stormF * 0.66) * st.dayF * THREE.MathUtils.clamp(camDir.dot(st.sunDir) * 2.2, 0, 1) : 0;
  fu.uCA.value = 0.12 + Math.min(0.5, phys.speed / 60) + stormF * 0.2 + launch.flash * 0.9;
  fu.uNight.value = st.nightF;
  fu.uGrain.value = 0.028 + st.nightF * 0.006 + stormF * 0.03;
  // 0.55 put the corners at 26% brightness, which turned any dark prop near the frame edge into
  // a black hole. The tunnelling is now carried by the wall mesh and the layered fog, so the
  // vignette only has to add the pressure on top of what is already in the frame.
  fu.uVignette.value = 0.26 + stormF * 0.22;
  // Lens grit reads as the storm passing *over* you, and the film that survives is the deposition
  // the array and the paint are wearing — a clear sky after a peak should still be dirty.
  fu.uDirt.value = Math.min(1, stormF * 0.62 + roverFilm * 0.55);
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
  // The storm's own lift is small and deliberate: the key is down 68%, so the exposure opens up
  // for the midtones, but the wall and the sun aureole are already near clipping and a wide
  // exposure there reintroduces the flat orange field the layering was meant to replace.
  renderer.toneMappingExposure = 1.02 - st.nightF * 0.20 + stormF * 0.11;

  // HUD
  UI.setSpeed(phys.speed * 3.6);
  if (Math.floor(elapsed * 4) !== Math.floor((elapsed - dt) * 4)) {
    UI.setTop(st.clock, weatherLabel(st),
      // A tier name that no longer describes what is on screen is a lie in the corner of the HUD,
      // so the auto-degrade says so where the player chose the tier.
      quality.label + (degradeLevel ? ' · 已降档' : ''), Math.round(fpsAvg));
    // The gauge is the base's own bill for the last front: the dirtiest array out of the six. While
    // the lance is on a target the bar narrows to *that* array and names it, because a gauge pinned
    // at the fleet maximum reports nothing at the one moment it is being watched.
    const aim = stormPlay.aim;
    UI.setFilm({
      value: aim ? aim.film : filmGauge(),
      self: roverFilm,
      worst: filmGauge(),
      lancing: stormPlay.lance,
      warn: filmGauge() >= FILM.WARN,
      tag: aim ? `${t('阵列积尘')} · ${t(aim.name)}` : t('阵列积尘'),
    });
    UI.setNav(nav);
  }
}

// ───────────────────────── loop & degrade ─────────────────────────
let fpsSamples = [], fpsAvg = 60, lastTs = performance.now(), degradeChecked = 0, updateFaults = 0;
function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTs) / 1000);
  lastTs = now;
  fpsSamples.push(1 / Math.max(dt, 1e-4));
  if (fpsSamples.length > 60) fpsSamples.shift();
  fpsAvg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
  // A thrown HUD line used to escape from here and skip the render call at the bottom of tick,
  // which froze a perfectly drivable game. The frame is still reported, just never fatal.
  if (started && !paused) {
    try { update(dt); }
    catch (e) { if (updateFaults++ === 0) console.error('UPDATE_FAIL', e); }
  } else { elapsed += 0; }
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
  if (teleOpen && /^Digit[1-9]$/.test(e.code)) { const tp = base.teleports[+e.code.slice(5) - 1]; if (tp && tp.online !== false) teleportTo(tp); else if (tp) UI.toast('⛔ 该区电网未恢复 — 光台无法成像'); return; }
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
  // The island keeps a clear sky until the mission chain asks for weather. A random front during the
  // grid restart would take the sun away from the one thing the tutorial is teaching, and the first
  // storm lands better as a deadline the objective line names than as something that happened to be
  // due. `freeSky()` hands the dice back once the ship has gone.
  stormField.holdSky();
  renderMissions();
  UI.toast('欢迎来到 RED STARBASE — 基地断电中，驾驶漫游车重启电网');
  audio.radio('beep');
};

boot().catch(e => { console.error('BOOT_FAIL', e); $('load-text').textContent = t('启动失败：') + (e && e.message || e); });
renderer.setAnimationLoop(tick);

// ───────────────────────── test / demo hooks (URL params) ─────────────────────────
// The autopilot audit is longer than any tool call may block for, so its state lives out here
// between calls rather than inside one.
let qaDrive = null;
let qaTrace = [];
// Every place the game ever asks a player to steer, with the exact radius the game itself uses to
// decide "you have arrived" (the pad trigger, the link radius, the sample pickup, the repair range,
// the deck's countdown ring). Both connectivity instruments read this one list, so the driving audit
// and the geometry scan cannot quietly disagree about what "reachable" means.
function interactivePoints() {
  const at = (kind, x, z, r, label) => ({ kind, name: `${kind}:${label}`, x, z, r });
  return [
    ...base.teleports.map(p => at('pad', p.x, p.z, 3.9, p.key)),
    ...(base.gridRigs || []).map(r0 => at('tap', r0.x, r0.z, LINK_RADIUS, r0.key)),
    ...liveSamples().map((s0, i) => at('sample', s0.x, s0.z, 4.2, s0.id ?? i)),
    at('leak', base.leakPoint.x, base.leakPoint.z, 12, 'tanks'),
    at('watch', base.watchPos.x, base.watchPos.z, 26, 'deck'),
  ];
}

window.__RSB = {
  chart: () => chart, openMap: () => openTeleport(),
  get state() { return { started, paused, bootMs: Math.round(startedAt), pos: [phys?.x, phys?.y, phys?.z], speed: phys?.speed, yaw: phys?.yaw, fps: fpsAvg, mission: activeMission, launch: launch.phase, launchY: launch.y, samples: samplesTaken, leak: leakFixed, quality: qKey, battery: grid.battery, gridOnline: grid.online, gridDead: grid.dead, faults: updateFaults, rescue: rescue.phase, rescueEvents: rescue.events.length }; },
  skipMissions: () => {
    base.gridRigs.forEach(r => { r.online = true; r.power = 1; r.tp.online = true; });
    grid.online = GRID_COUNT; grid.battery = 1; grid.dead = false;
    missions.forEach(m => { if (m.id !== 'watch') m.done = true; });
    missions[0].n = GRID_COUNT;
    samplesTaken = missions[2].total; missions[2].n = samplesTaken;
    advanceMission();
  },
  startStorm: () => { env?.toggleWeather(); },
  // Hold one storm phase in place for a screenshot pair: the wind axis is aimed so the front sits
  // in front of the current view, which is the framing the wall mesh was built for. Pass a heading
  // to aim the wind somewhere else — putting the front between the view and the sun is a different
  // picture entirely, and the one the sun-path extinction term exists to be judged on.
  pinStorm: (phase = 'front', standoff = 150, heading = null) => {
    const d = camera.getWorldDirection(tmpV.set(0, 0, 1));
    return stormField.pin(phase, camera.position, standoff, heading ?? Math.atan2(-d.z, -d.x)).state;
  },
  unpinStorm: () => stormField.unpin().state,
  storm: () => stormField?.state,
  // Queue a front with a chosen warning window instead of waiting for the dice. E3's mission chain
  // schedules storms through this, so a front can be pointed at a beat of the chain rather than
  // landing in the middle of the one run that must not be interrupted.
  armStorm: (lead = 100) => stormField.arm(lead).state,
  outlook: () => stormField.outlook(phys),
  // E3's variable under test: which beats of the chain have fired, and what the launch gate says
  // right now. The whole point of the workstream is that a front belongs to a mission, so the
  // instrument reports the pairing rather than leaving it to be inferred from the horizon.
  stormBeats: () => ({ fired: stormBeat.fired.slice(), at: +stormBeat.at.toFixed(1),
    hold: launchWeatherHold(), armed: launchArmed }),
  // Take the sky back off the schedule. The launch gate is honest about weather, which means a
  // screenshot rig that wants the ignition has to say so here rather than wait out a front it did not
  // ask for — and `?demo=launch` is exactly that rig.
  clearSky: () => stormField.holdSky().state,
  // The dust ledger as the simulation sees it: each array's own coverage, the rover's film, whether
  // the lance is running, and what the worst-covered array is currently paying in yield.
  film: () => ({ arrays: base.gridRigs.map(r => [r.key, +r.film.toFixed(3)]),
    worst: +filmGauge().toFixed(3), rover: +roverFilm.toFixed(3),
    lance: !!stormPlay.lance, aim: stormPlay.aim?.key || null,
    lost: +(filmGauge() * FILM.YIELD * 100).toFixed(1) }),
  setFilm: (array, self) => { base.gridRigs.forEach(r => { r.film = array; r.cleaned = false; }); roverFilm = self; },
  // The sample map as the storm is rewriting it. `p` is which side of the island's wake the site sits
  // on for the current heading — the number that decides whether the front scours there or drops its
  // load — and `dust` is what the air currently holds over it. Together they are the whole ledger:
  // with `buried` beside them, a verification can tell whether a site went under because the physics
  // said so or in spite of it. `total` is the mission denominator, so growth is visible in the same read.
  sites: () => base.samples.map(s => ({
    id: s.id, at: [Math.round(s.x), Math.round(s.z)], site: siteName(s), buried: +s.buried.toFixed(3),
    seen: s.seen, taken: s.taken, visible: s.group.visible, p: +exposure(s.x, s.z).toFixed(2),
    dust: +stormField.local(s.x, s.z).toFixed(3), lens: s.lens.visible,
    total: missions[2].total, n: samplesTaken })),
  // Set the cover on one site (or every site) by hand. Two uses: framing the buried lens and the
  // emerging crystal for a screenshot pair, and proving the collect gate and the wheel-scour are
  // actually reading `buried` rather than tripping over something else.
  bury(v, id = null) {
    for (const s of base.samples) if ((id === null || s.id === id) && !s.taken) {
      s.buried = THREE.MathUtils.clamp(v, 0, 1);
      if (s.buried < SAND.DEAD) s.seen = true;
      dressSample(s);
    }
    return this.sites();
  },
  // The optical fix as the cockpit sees it *and* as the HUD says it: the chip's own text is the only
  // proof that a state reached the player rather than only the simulation, and the arrow's opacity is
  // the difference between "locked out" and "the arrow simply has no target yet".
  nav: () => {
    const chip = document.getElementById('nav-chip'), arrow = document.getElementById('objective-arrow');
    return { lock: +nav.lock.toFixed(3), landmarks: nav.landmarks, homing: +nav.homing.toFixed(2),
      blind: nav.blind, chip: chip.classList.contains('show') ? chip.textContent.trim() : null,
      unstable: arrow.classList.contains('unstable'), opacity: +getComputedStyle(arrow).opacity };
  },
  lance: (v) => { input.inp.keys[v ? 'add' : 'delete']('KeyF'); },
  // What the weather is actually paying the rover this frame: the air speed out there, the tiny
  // force it buys on a 260 kg chassis, the dust read through the tyres, the deposited film on the
  // paint, and the wind band's live gain. A wind effect you cannot read a number off is a wind
  // effect you cannot prove is not moving the rover into a wall.
  windNow: () => ({ air: lastWind ? +Math.hypot(lastWind.vx, lastWind.vz).toFixed(2) : 0,
    load: +phys.windLoad.toFixed(4), soft: +phys.windSoft.toFixed(3),
    gust: +(lastWind?.gust || 0).toFixed(3), trauma: +phys.trauma.toFixed(3),
    speed: +phys.speed.toFixed(2), yaw: +phys.yaw.toFixed(3),
    deposit: +stormField.dustLoad.toFixed(4), windG: +((audio.windG?.gain.value || 0) * 1000).toFixed(1) }),
  startNight: () => { env?.forceNight(); },
  // the field itself, not its readout: a 300 s drive needs the slab widened past the island,
  // which no phase-pinning standoff can do from outside the object
  stormRef: () => stormField,
  phys: () => phys, env: () => env, launchRef: launch,
  // The stack as two vehicles. The merge pass is allowed to collapse each body to a handful of
  // meshes, so "how many nodes" proves nothing; what the separation depends on is that every part
  // rides with exactly one body. `stray` holds anything welded at the seam instead — it has to come
  // back empty, and a non-empty list means a merge pass got in front of the body split again.
  launchRig: () => {
    const r = base?.launchRig;
    if (!r) return null;
    const body = (o) => {
      const b = new THREE.Box3().setFromObject(o);
      const v = new THREE.Vector3(); o.getWorldPosition(v);
      let m = 0, verts = 0;
      o.traverse(x => { if (x.isMesh) { m++; verts += x.geometry.attributes.position.count; } });
      return { y: [+b.min.y.toFixed(1), +b.max.y.toFixed(1)], world: v.y.toFixed(1),
        meshes: m, verts, off: o.position.toArray().map(n => +n.toFixed(2)) };
    };
    // The invariant is not "two nodes exist", it is "no visible thing is left outside them": a mesh
    // under the shared trunk is welded across the seam and will shear or hang in mid-air at staging.
    // Measured from the bodies' own parent, because the instance's outer node is the glTF wrapper.
    const trunk = r.booster.parent;
    const stray = [];
    trunk.traverse(o => {
      if (!o.isMesh) return;
      for (let p = o; p && p !== trunk; p = p.parent) if (p === r.booster || p === r.upper) return;
      stray.push(`${o.name || 'mesh'}:${o.geometry.attributes.position.count}v`);
    });
    return { seam: r.seam, pad: r.pad.map(v => +v.toFixed(2)), engines: r.engines,
      booster: body(r.booster), upper: body(r.upper), stray };
  },
  // The flight, as the integrator sees it. `log` is the same record the telemetry panel will render
  // and `touch` is what the booster's return actually cost, so a claim about the sequence can be
  // checked against numbers the sim produced rather than against the code that was meant to produce them.
  flight: () => {
    const F = launch.flight;
    if (!F) return null;
    const t = F.tel, r3 = v => v.toArray().map(n => +n.toFixed(1));
    return { phase: launch.phase, done: F.done, separated: F.separated, landed: F.landed,
      tel: { met: +t.met.toFixed(1), alt: +t.alt.toFixed(0), vel: +t.vel.toFixed(1), accel: +t.accel.toFixed(1),
        down: +t.down.toFixed(0), mach: +t.mach.toFixed(2), gamma: +t.gamma.toFixed(3),
        litBooster: t.litBooster, litUpper: t.litUpper },
      bodies: { booster: r3(F.plumes[0].body.node.position), ship: r3(F.plumes[1].body.node.position) },
      mouths: F.plumes.map(p => +p.mouth.toFixed(1)),
      touch: F.touch, log: F.log.map(e => [e.met.toFixed(1), e.id, e.alt, e.vel]) };
  },
  warp: (x, z, face, search) => warpTo(x, z, face, search ?? 8),
  pois: () => interactivePoints(),
  sampleList: () => (base?.samples || []).map(s => [Math.round(s.x), Math.round(s.z), !!s.taken]),
  taps: () => (base?.gridRigs || []).map(r => [r.key, +r.x.toFixed(1), +r.z.toFixed(1), +r.power.toFixed(2), !!r.online]),
  // the raw collision set — the pin/unstick audit needs to see the cylinders the physics loop reads
  colliders: () => (base?.colliders || []).map(c => [+c.x.toFixed(2), +c.z.toFixed(2), +c.r.toFixed(2), c.floor === undefined ? 0 : +c.floor.toFixed(2)]),
  solids: () => base?.colliders,
  plan: () => base?.plan ? base.plan() : null,
  path: () => qaTrace,
  // The unstick's own view: is the body ring buried right now, and what has the rescue done so far.
  // `forceUnstick` fires the state machine by hand so a verification can watch it work instead of
  // waiting 2.2 s for a wedge that may not exist.
  unstick: () => ({ phase: rescue.phase, tries: rescue.tries, cool: +rescue.cool.toFixed(2),
    gap: +gapFrom(base.colliders.filter(c => c.floor === undefined), phys.x, phys.z).toFixed(2),
    window: rescue.markT ? +(elapsed - rescue.markT).toFixed(2) : null,
    windowNet: rescue.markT ? +Math.hypot(phys.x - rescue.markX, phys.z - rescue.markZ).toFixed(2) : null,
    guards: { teleOpen, demo: !!demoPin, photo: !!photo.on, gridDead: grid.dead, paused,
      grounded: phys.grounded, gas: +input.inp.gas.toFixed(2) },
    events: rescue.events.slice(-8) }),
  forceUnstick: () => startRescue('forced', input.inp),
  setBattery: (v) => { grid.battery = v; grid.dead = false; grid.lowWarned = false; },
  post: () => post,
  camera: () => camera,
  scene: () => scene,
  // run one full game frame by hand — lets QA drive the sim while the tab is hidden
  frame: (dt = 1 / 60) => update(dt),
  input: () => input.inp,
  // Autopilot audit. The drive-through that decides whether the base is actually playable cannot be
  // done by eye: a rover that wedges itself at 03:47 in a corner nobody thought to try is exactly
  // the report a player gives, and no screenshot of a parked rover catches it. So QA holds the real
  // controls down, steps the real game loop by hand, and files every stretch where throttle was in
  // and the ground did not move — plus every discontinuity the sim teleports the rover through.
  // A stall is NET progress over a window, not distance from an anchor. The first version of this
  // detector re-armed itself every time the rover moved 2.5 m away — which a rover pinning itself
  // against a collider does in its sleep, thrashing back and forth at 0 m/s average. The audit has
  // to be stricter than the player's patience, so the bar is "did not get anywhere in 4 seconds".
  // The driver is also given the collision map: an autopilot that steers into every wall would
  // report the base as unnavigable when the only thing wedged is the test itself.
  // Resumable by design. A 5-minute audit cannot be one function call — the harness caps a call at
  // 15 s but the page carries on looping after the timeout, so a second call would inherit a rover
  // the first one left face-down in a collider and the trace would be nonsense. So the session lives
  // in qaDrive: each call advances it, and a fresh session parks the rover back at spawn first.
  drive: (opts = {}) => {
    const dt = 1 / 60;
    const CLEAR = 1.6 + 0.4, CELL = 24;   // body clearance + a little respect, and the hash cell size
    const cellKey = (cx, cz) => cx * 8192 + cz;
    const keys = ['KeyW'];
    // Two kinds of per-point state, deliberately split. `best`, `bestAt`, `dwell` and `retried` are
    // the run's evidence — the closest the wheel ever came, which the acceptance bar reads — so they
    // only ever improve. `lapBest`, `since`, `held` and `park` are the *current lap's* arrival state
    // and must be re-armed when the loop recycles. They used to be one field, so from lap 2 on every
    // point was already "arrived" the frame it became the target: `s.wp++` then fired once per frame,
    // burning all 46 waypoint indices in 0.77 s. A run that reported `laps: 175` had not driven 175
    // laps — it had stopped driving and kept counting.
    const armLap = p => { p.lapBest = 1e9; p.since = null; p.held = 0; p.park = undefined; };
    let s = qaDrive;
    if (!s || opts.reset) {
      const ride = phys.y - phys.groundY;
      phys.x = START.pos[0]; phys.z = START.pos[1];
      phys.groundY = surfaceAt(phys.x, phys.z);
      phys.y = phys.groundY + ride;
      phys.yaw = START.heading;
      phys.vx = 0; phys.vz = 0; phys.vy = 0; phys.speed = 0; phys.lateral = 0;
      phys.wheelAngle = 0; phys.grounded = true; phys.onFloor = false;

      // the runtime unstick is part of what the audit measures, so its log starts with the run
      rescue.events.length = 0; rescue.phase = ''; rescue.cool = 0; rescue.tries = 0; rescue.markT = 0;
      phys.pitch = 0; phys.roll = 0; phys.susp = 0; phys.suspV = 0;

      // every waypoint a player is ever asked to steer to, plus the carriageway itself walked end
      // to end: covering the districts proves the shortcuts work, covering the streets proves the
      // grid has no pinch points between the landmarks. `poisOnly` drops the street nodes so a run
      // can spend its whole budget pressing on the interactive points instead.
      const spots = interactivePoints();
      if (!opts.poisOnly) {
        for (const st of STREETS) {
          const n = Math.round(Math.hypot(st.b[0] - st.a[0], st.b[1] - st.a[1]) / 40);
          for (let i = 0; i <= n; i++) {
            const f = i / n;
            spots.push({ kind: 'street', name: `${st.id}:${i}`, x: st.a[0] + (st.b[0] - st.a[0]) * f,
                         z: st.a[1] + (st.b[1] - st.a[1]) * f, r: 11 });
          }
        }
      }
      for (const p of spots) { p.best = 1e9; p.bestAt = null; p.dwell = 0; p.retried = false; armLap(p); }
      const route = [];
      let at = [phys.x, phys.z];
      const pending = spots.slice();
      while (pending.length) {
        pending.sort((a, b) => Math.hypot(a.x - at[0], a.z - at[1]) - Math.hypot(b.x - at[0], b.z - at[1]));
        const nxt = pending.shift();
        route.push(nxt); at = [nxt.x, nxt.z];
      }

      // clearance oracle over the solid discs, hashed so 18k frames of raycast stays cheap
      const cells = new Map();
      for (const c of base.colliders) {
        if (c.floor !== undefined) continue;
        const reach = Math.ceil((c.r + CLEAR) / CELL);
        const cx = Math.floor(c.x / CELL), cz = Math.floor(c.z / CELL);
        for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) {
          const k = cellKey(cx + i, cz + j);
          const a = cells.get(k);
          if (a) a.push(c); else cells.set(k, [c]);
        }
      }
      s = qaDrive = {
        route, spots, cells, budget: opts.seconds ?? 300, stallCells: new Map(), events: [], samples: [],
        wp: 0, dist: 0, t: 0, gated: 0, peakSpeed: 0, retries: 0,
        prevPos: [phys.x, phys.z], prevDead: grid.dead,
        markT: 0, markX: phys.x, markZ: phys.z, recoverUntil: -9, holdUntil: -9, aim: phys.yaw, turnDir: 0,
        runFrames: 0,
        // the acceptance bar wants "zero clipping" measured, not eyeballed: how deep the body ring
        // ever sat inside a solid, and how far the hull ever sank under its own surface
        loop: !!opts.loop, laps: 1, worstPen: 0, penPos: null, penFrames: 0,
        worstSink: 0, sinkPos: null, sinkFrames: 0, maxStep: 0, visited: new Set(),
        clipLog: [], trace: [],
        // The wind pushes the rover, so two runs of the same route are not the same drive. The
        // audit does not reset the weather (resetting it would hide a real failure mode) — it
        // reports how much storm the run drove through, so a missed point can be read honestly.
        stormMax: 0, windMax: 0, stormFrames: 0,
      };
    }
    const NONE = [];
    const blockedAt = (x, z) => {
      const list = s.cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) || NONE;
      for (const c of list) if (Math.hypot(x - c.x, z - c.z) < c.r + CLEAR) return true;
      return false;
    };
    // How far the 1.6 m body ring is buried in a solid right now — 0 means clean contact. This is
    // the "穿模" the acceptance bar forbids, so it has to be sampled every frame, not guessed from
    // a screenshot taken after the rover has already been pushed out.
    const penAt = (x, z) => {
      const list = s.cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) || NONE;
      let p = 0, who = null;
      for (const c of list) {
        const v = c.r + 1.6 - Math.hypot(x - c.x, z - c.z);
        if (v > p) { p = v; who = c; }
      }
      return { p, who };
    };
    const rangeOf = (x, z, a, max = 18) => {
      const sx = Math.sin(a), sz = Math.cos(a);
      for (let d = 1.5; d <= max; d += 1.5) if (blockedAt(x + sx * d, z + sz * d)) return d - 1.5;
      return max;
    };
    const wrap = v => Math.atan2(Math.sin(v), Math.cos(v));
    const OFF = [24, -24, 48, -48, 72, -72, 100, -100, 135, -135, 180].map(d => d * Math.PI / 180);
    // Point at the waypoint; only go hunting for another bearing once the carriageway ahead is
    // actually closing. The first version scored every whisker against a self-referential heading
    // that it then overwrote, so "straight on" earned a permanent bonus and the audit drove itself
    // to the rim of the map while chasing a waypoint behind it.
    const pick = (tx, tz) => {
      const goal = Math.atan2(tx - phys.x, tz - phys.z);
      const look = 6 + Math.min(11, phys.speed * 0.7);
      const rg = rangeOf(phys.x, phys.z, goal);
      if (rg >= look) return { a: goal, r: rg };
      let best = null;
      for (const o of OFF) {
        const a = goal + o;
        const r = rangeOf(phys.x, phys.z, a);
        const score = Math.min(r, 14) - Math.abs(o) * 1.1 - Math.abs(wrap(a - phys.yaw)) * 0.3;
        if (!best || score > best.score) best = { a, r, score };
      }
      return best && best.r > rg ? best : { a: goal, r: rg };
    };
    const touched = () => base.colliders
      .map((c, i) => ({ c, i, d: Math.hypot(phys.x - c.x, phys.z - c.z) }))
      .filter(o => o.c.floor === undefined && o.d < o.c.r + 1.75)
      .sort((a, b) => a.d - b.d).slice(0, 4)
      .map(o => `${o.c.prop || o.i}@${o.c.x.toFixed(1)},${o.c.z.toFixed(1)},r${o.c.r.toFixed(1)} gap${(o.d - o.c.r - 1.6).toFixed(2)}`);

    // How much room the body ring has at a spot: distance to the nearest solid disc, minus that
    // disc's radius, minus the 1.6 m hull. Negative means the spot is inside a wall.
    const marginAt = (x, z) => {
      const list = s.cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) || NONE;
      let m = 99;
      for (const c of list) m = Math.min(m, Math.hypot(x - c.x, z - c.z) - c.r - 1.6);
      return m;
    };
    // The trigger circle is a working area, not a pin. Every light pad has its reactor rig standing
    // on the 3.9 m ring itself (measured: grid:grid-rig at 3.90 m, 6 cm of body clearance), so the
    // centre is only worth driving at from the side that is open. A player reads the pad and stops
    // in the gap they can see; the audit does the same — it takes, once per waypoint, the standable
    // point inside the circle that has the most clearance and a straight approach from where the
    // rover is, and falls back to the centre if the whole circle is walled in.
    const parkSpot = tgt => {
      let best = null;
      for (let ring = 0; ring <= Math.max(0.1, tgt.r - 0.5); ring += 0.5) {
        const n = ring < 0.1 ? 1 : Math.max(12, Math.round(ring * 8));
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const x = tgt.x + Math.sin(a) * ring, z = tgt.z + Math.cos(a) * ring;
          const m = marginAt(x, z);
          // 0.4 m of hull clearance is what a driver actually settles for on a pad half-occupied by
          // its own reactor rig; demanding a full metre instead leaves no legal point inside the
          // circle, and then the audit aims straight through the rig and earns an unstick.
          if (m < 0.4) continue;
          const d = Math.hypot(x - phys.x, z - phys.z);
          if (rangeOf(phys.x, phys.z, Math.atan2(x - phys.x, z - phys.z)) < d) continue;
          const score = m - ring * 0.25;   // room to sit in, and deep enough to register the pad
          if (!best || score > best.score) best = { x, z, d, m, score };
        }
      }
      return best ? { x: best.x, z: best.z } : null;
    };

    input.inp.keys.add('KeyW');
    const wall = performance.now();
    const frames = Math.round(Math.min(s.budget - s.t, opts.chunk ?? 100) / dt);
    let f = 0;
    for (; f < frames && (s.loop || s.wp < s.route.length); f++) {
      const tgt = s.route[s.wp];
      const recovering = s.t < s.recoverUntil;
      const holding = s.t < s.holdUntil;
      if (recovering) {
        input.inp.gas = 0;
        input.inp.brake = 1;                    // back out, swinging toward whichever side is open
        const openLeft = rangeOf(phys.x, phys.z, phys.yaw - Math.PI / 2);
        const openRight = rangeOf(phys.x, phys.z, phys.yaw + Math.PI / 2);
        s.turnDir = openLeft >= openRight ? 1 : -1;
        input.inp.steer = s.turnDir;
      } else if (holding) {                     // parked: brake on, hands off the wheel
        input.inp.gas = 0; input.inp.brake = 1; input.inp.steer = 0;
      } else {
        input.inp.brake = 0;
        // The last approach is a parking manoeuvre, not an avoidance problem. Every light pad has its
        // reactor rig standing on the 3.9 m trigger ring itself (surf 2.06 m), so the whisker planner
        // steers around the rig, reads "missed by one metre", and reports a working pad as dead. Aimed
        // straight in at crawl speed the real collision response slides the hull off the disc, which
        // is exactly what a player does with the wheel.
        const dNow = Math.hypot(phys.x - tgt.x, phys.z - tgt.z);
        const parking = dNow < 9;
        if (parking && tgt.park === undefined) tgt.park = parkSpot(tgt);
        // The parking spot is picked from where the rover stood when it entered the circle. An
        // unstick puts the rover somewhere else entirely, and then it grinds toward a spot it can no
        // longer see: the losing run of pad:industry ended 6.1 m out on the far side of its own ring
        // point. Re-pick whenever the chosen spot has fallen behind a wall.
        if (parking && tgt.park && s.runFrames % 20 === 0) {
          const pa = Math.atan2(tgt.park.x - phys.x, tgt.park.z - phys.z);
          if (rangeOf(phys.x, phys.z, pa) < Math.hypot(phys.x - tgt.park.x, phys.z - tgt.park.z)) {
            tgt.park = parkSpot(tgt) || tgt.park;
          }
        }
        const park = parking && tgt.park ? tgt.park : { x: tgt.x, z: tgt.z };
        const b = parking ? { a: Math.atan2(park.x - phys.x, park.z - phys.z),
                              r: Math.hypot(park.x - phys.x, park.z - phys.z) } : pick(tgt.x, tgt.z);
        s.aim = b.a;
        const err = wrap(b.a - phys.yaw);
        // The wheel model is inverted relative to bearing math: positive steer rotates yaw
        // downwards, so closing a negative heading error takes positive pedal. Commanding
        // sign(err) instead makes the autopilot fight its own target and wander off the map.
        if (Math.abs(err) < 1.6 || !s.turnDir) s.turnDir = -Math.sign(err) || 1;
        input.inp.steer = s.turnDir * Math.min(1, Math.abs(err) * (parking ? 2.2 : 1.2));
        input.inp.gas = (parking || b.r < 3) ? 0.35 : Math.abs(err) > 1.2 ? 0.45 : 1;
      }
      const before = [phys.x, phys.z];
      const throttle = input.inp.gas;
      update(dt);
      s.t += dt;
      // A connectivity audit measures the roads, not the power mission. A dead cell force-teleports
      // the rover back to the hub, and that discontinuity eats the clock and shows up as "never
      // reached" — so `keepPower` tops the cell up every quarter-second for the whole run. The
      // 5-minute full-route regression is deliberately NOT given this: it drains for real.
      if (opts.keepPower && s.runFrames % 15 === 0) { grid.battery = 1; grid.dead = false; grid.lowWarned = false; }
      input.inp.brake = (recovering || holding) ? 1 : 0;   // read() re-derives pedals from the key set
      const step = Math.hypot(phys.x - before[0], phys.z - before[1]);
      // A frame that starts with the rover here and ends 50 m down the map is not driving, and the
      // sim owns exactly one legitimate way to do it: the teleport network, which force-homes the
      // rover to the hub the moment the cell dies. The hop is therefore measured against where the
      // *last frame* ended, classified, and only a frame the wheels actually cover is allowed into
      // the metrics that claim to describe the road. Counting a hand-off as a stride made
      // `maxStepMetres` read 57.64 — indistinguishable from a collision blow-through — while the
      // ring-depth and sink counters, which only ever see real contact, stayed at zero; and the
      // odometer quietly added the jump to the distance driven.
      const hop = Math.hypot(phys.x - s.prevPos[0], phys.z - s.prevPos[1]);
      const teleported = hop > 8;
      if (teleported) {
        s.events.push({ t: +s.t.toFixed(1), kind: 'teleport', from: s.prevPos.map(v => +v.toFixed(1)),
                        to: [phys.x, phys.z].map(v => +v.toFixed(1)), metres: +hop.toFixed(1),
                        battery: +grid.battery.toFixed(3) });
      } else {
        s.dist += step;
        s.maxStep = Math.max(s.maxStep, step);
      }
      s.peakSpeed = Math.max(s.peakSpeed, phys.speed);
      const _sf = env.state.stormF;
      if (_sf > s.stormMax) s.stormMax = _sf;
      if (stormField.speed > s.windMax) s.windMax = stormField.speed;
      if (_sf > 0.15) s.stormFrames++;
      const pen = penAt(phys.x, phys.z);
      if (pen.p > 0.05) {
        s.penFrames++;
        if (s.clipLog.length < 12) s.clipLog.push({
          t: +s.t.toFixed(1), pen: +pen.p.toFixed(2), pos: [+phys.x.toFixed(1), +phys.z.toFixed(1)],
          step: +step.toFixed(2), speed: +phys.speed.toFixed(1), rescue: rescue.phase || null,
          solid: `${pen.who.prop || pen.who.name || 'disc'}@${pen.who.x.toFixed(1)},${pen.who.z.toFixed(1)}r${pen.who.r.toFixed(1)}` });
      }
      if (pen.p > s.worstPen) { s.worstPen = pen.p; s.penPos = [+phys.x.toFixed(1), +phys.z.toFixed(1), tgt.name]; }
      const sink = phys.y - 0.46 - surfaceAt(phys.x, phys.z);
      if (sink < -0.1 && !phys.onFloor) s.sinkFrames++;
      if (sink < s.worstSink) { s.worstSink = sink; s.sinkPos = [+phys.x.toFixed(1), +phys.z.toFixed(1)]; }
      if (teleOpen) s.gated++;
      s.prevPos = [phys.x, phys.z];
      if (grid.dead !== s.prevDead) {
        s.events.push({ t: +s.t.toFixed(1), kind: grid.dead ? 'battery-dead' : 'battery-restored',
                        pos: [phys.x, phys.z].map(v => +v.toFixed(1)), battery: +grid.battery.toFixed(3) });
        s.prevDead = grid.dead;
      }
      if (s.t - s.markT >= 4) {
        const prog = Math.hypot(phys.x - s.markX, phys.z - s.markZ);
        if (prog < 1.5 && throttle > 0.4 && !grid.dead) {
          // file by pocket, not by frame: one wedge visited 20 times is one defect, and a 5-minute
          // run has to fit its whole report in one tool result
          const ck = `${Math.round(phys.x / 6)},${Math.round(phys.z / 6)}`;
          const old = s.stallCells.get(ck);
          if (old) { old.n++; old.lastT = +s.t.toFixed(1); }
          else s.stallCells.set(ck, { pos: [+phys.x.toFixed(1), +phys.z.toFixed(1)], n: 1, firstT: +s.t.toFixed(1), lastT: +s.t.toFixed(1),
                        wp: tgt.name, metresIn4s: +prog.toFixed(2),
                        yaw: +phys.yaw.toFixed(2), speed: +phys.speed.toFixed(2),
                        vf: +(phys.vx * Math.sin(phys.yaw) + phys.vz * Math.cos(phys.yaw)).toFixed(2),
                        vxz: [+phys.vx.toFixed(2), +phys.vz.toFixed(2)],
                        grounded: phys.grounded, onFloor: phys.onFloor,
                        y: +phys.y.toFixed(2), groundY: +phys.groundY.toFixed(2),
                        slope: +surfaceSlope(phys.x, phys.z).toFixed(2),
                        enginePower: +phys.enginePower.toFixed(2),
                        pickRange: +rangeOf(phys.x, phys.z, phys.yaw).toFixed(1),
                        touching: touched(), battery: +grid.battery.toFixed(3),
                        teleOpen, demoPin: !!demoPin });
          s.recoverUntil = s.t + 1.4;
        }
        s.markT = s.t; s.markX = phys.x; s.markZ = phys.z;
      }
      if (s.runFrames++ % 120 === 0) s.samples.push([+s.t.toFixed(0), +phys.speed.toFixed(1), s.wp,
        Math.round(Math.hypot(phys.x - tgt.x, phys.z - tgt.z)),
        Math.round(Math.atan2(tgt.x - phys.x, tgt.z - phys.z) * 57.3),
        Math.round(phys.yaw * 57.3), Math.round(s.aim * 57.3),
        Math.round(rangeOf(phys.x, phys.z, Math.atan2(tgt.x - phys.x, tgt.z - phys.z))),
        +input.inp.gas.toFixed(2), +input.inp.steer.toFixed(2)]);
      // "Reached" is the game's own trigger radius, not "came vaguely near": a light pad needs 3.9 m
      // and a sample 4.2 m, so an audit that counts a 10 m fly-past as a visit would prove nothing.
      // A point the driver cannot line up is abandoned after GRACE seconds — it then shows in the
      // report as a miss with its closest approach, instead of stalling the rest of the route.
      const dT = Math.hypot(phys.x - tgt.x, phys.z - tgt.z);
      if (dT < tgt.best) { tgt.best = dT; tgt.bestAt = [+phys.x.toFixed(1), +phys.z.toFixed(1)]; }
      if (dT < tgt.lapBest) tgt.lapBest = dT;
      if (tgt.since === null) tgt.since = s.t;
      // Dwell is the second half of the proof. Touching a circle for one frame at 14 m/s is not a
      // stop the player can act on — the game only offers the pad prompt and the link below walking
      // speed — so every point gets its own seconds spent inside its radius while slow enough.
      if (phys.speed < 2.5) for (const p of s.spots)
        if (Math.hypot(phys.x - p.x, phys.z - p.z) <= p.r) p.dwell += dt;
      if (tgt.best <= tgt.r) s.visited.add(tgt.name);
      // A fly-through only proves the road exists. `pause` parks the rover inside the trigger circle
      // with the brake on — the state a player actually has to reach to work a pad or lift a sample —
      // and it turns the dwell column into measured standing time instead of one frame of a pass.
      const arrived = tgt.lapBest <= tgt.r || s.t - tgt.since > (opts.grace ?? 25);
      if (arrived && !tgt.held) { tgt.held = +opts.pause || 0; s.holdUntil = s.t + tgt.held; }
      if (arrived && s.t >= s.holdUntil) {
        // Running out of patience on a point is not evidence that the map is broken: an unstick can
        // carry the rover off-route and spend the whole grace window on the detour. So a missed point
        // goes back on the tail of the route once, aimed at from wherever the rover now stands. Two
        // misses is a real defect, and the report labels which points needed the second try.
        if (tgt.lapBest > tgt.r && !tgt.retried && s.t < s.budget - 90) {
          tgt.retried = true; tgt.since = null; tgt.held = 0; tgt.park = undefined;
          s.route.push(tgt); s.retries++;
        }
        s.wp++;
      }
      if (s.runFrames % 15 === 0) s.trace.push([+phys.x.toFixed(1), +phys.z.toFixed(1)]);
      // A five-minute run is longer than one lap of the map. Recycling the waypoint list keeps the
      // rover rolling instead of parking it at the finish line, and it never teleports: the next lap
      // starts from wherever the last one ended. Re-arming the arrival state is what makes the next
      // lap an actual lap; `retried` is deliberately not cleared, so a point that needed a second try
      // once is a defect named in the report, not one charged again against every later lap.
      if (s.loop && s.wp >= s.route.length) { s.wp = 0; s.laps++; s.spots.forEach(armLap); }
      if (f % 900 === 899 && performance.now() - wall > 9000) break;  // never outlive the call budget
    }
    // Release the pedal between chunks: the real animation loop keeps running while QA thinks,
    // and a rover left accelerating between two measurements is a rover that arrives at chunk 2
    // somewhere chunk 1 never drove it.
    keys.forEach(k => input.inp.keys.delete(k));
    input.inp.gas = 0; input.inp.steer = 0; input.inp.brake = 0;
    const done = s.t >= s.budget || (!s.loop && s.wp >= s.route.length);
    qaTrace = s.trace;
    if (done) qaDrive = null;
    const stalls = [...s.stallCells.values()].sort((a, b) => b.n - a.n);
    // D1's acceptance bar reads this block: every interactive point, the closest the wheel ever got,
    // against the radius that point actually needs. `never` means the budget ran out before the route
    // reached it — not a wall, just a short clock. `laps` counts *driven* laps: the arrival state is
    // re-armed at every recycle, so a lap is 46 points steered to, not 46 indices skipped.
    const pois = s.spots.filter(p => p.kind !== 'street');
    const hit = pois.filter(p => p.best <= p.r).length;
    return { done, simSeconds: +s.t.toFixed(1), metres: Math.round(s.dist), laps: s.laps,
             frames: s.runFrames, retries: s.retries,
             connectivity: { points: pois.length, touched: hit,
               trace: s.trace.length,
               detail: pois.map(p => `${p.name} ${p.best === 1e9 ? 'never' : p.best.toFixed(1)}/${p.r}m` +
                 ` dwell${(p.dwell || 0).toFixed(1)}s${p.retried ? ' retried' : ''} parkΔ` +
                 (p.park ? Math.hypot(p.park.x - p.x, p.park.z - p.z).toFixed(1) : 'none') +
                 `${p.best <= p.r ? '' : ' ✕@' + (p.bestAt || []).join(',') + '→park' + Object.values(p.park || []).join(',')}`) },
             mps: s.t > 0 ? +(s.dist / s.t).toFixed(2) : 0, peakSpeed: +s.peakSpeed.toFixed(1),
             weather: { stormMax: +s.stormMax.toFixed(2), windMax: +s.windMax.toFixed(1),
               stormPct: Math.round(100 * s.stormFrames / Math.max(1, s.runFrames)) },
             reached: [...s.visited], of: s.route.length,
             stuckPockets: stalls.length,
             stuckFrames: stalls.reduce((a, b) => a + b.n, 0),
             inputGatedFrames: s.gated,
             // zero clipping means both halves of it: never inside a wall, never under the ground.
             // `maxStepMetres` is the largest ground span the *wheels* covered in one frame — at
             // 15.2 m/s peak that is well under 30 cm — with teleport hand-offs excluded, so a jump
             // here now means the solver moved the rover, not the game.
             clip: { bodyPenMax: +s.worstPen.toFixed(2), bodyPenAt: s.penPos, bodyClipFrames: s.penFrames,
               sinkMax: +s.worstSink.toFixed(2), sinkAt: s.sinkPos, sinkFrames: s.sinkFrames,
               maxStepMetres: +s.maxStep.toFixed(2), events: s.clipLog },
             teleports: s.events.filter(e => e.kind === 'teleport').map(e => `${e.metres}m@${e.t}s batt${e.battery}`),
             batteryEvents: s.events.filter(e => /battery/.test(e.kind)).length,
             battery: +grid.battery.toFixed(3), gridOnline: grid.online, realFps: Math.round(fpsAvg),
             stalls: stalls.slice(0, 8), events: s.events.slice(0, 12),
             rescues: rescue.events.length, rescueLog: rescue.events.slice(-6),
             samples: s.samples.slice(-40) };
  },
  // Deadlock scan. The autopilot only reports the wedges it happens to drive into; this one is
  // exhaustive over the collision map, so a pocket nobody aimed at still shows up. The model is
  // RoverPhysics.step's own: every solid disc is inflated by the 1.6 m body radius, and the tightest
  // arc the rover can steer is WHEELBASE/tan(lock) = 4.24 m.
  // So a slot between two solids is judged twice: wide enough that the body fits (gap >= 2*1.6), too
  // tight to turn inside (gap < 2*1.6 + 2*4.24). Walking such a pinch from the mouth in both
  // directions separates the two real cases — a lane that opens up at both ends, which you drive
  // through, and a slot that closes into a wall, which swallows the rover and gives it back only in
  // reverse, straight out the way it came. Those are the "跑了一会就卡住" spots.
  // The (x, z, heading) BFS below is deliberately symmetric, because reverse gear follows the same
  // arcs: pure geometry can never make a cell "in but not out", and a flood fill that claims
  // otherwise is measuring the wrong thing. The BFS answers the other question — can the rover drive
  // from spawn to every interactive point without ever clipping (goal D3).
  scan: (opts = {}) => {
    const CLEAR = 1.6, TURN = 2.9 / Math.tan(0.60), CELL = 2, NH = 16, STEP = Math.PI * 2 / NH;
    const solids = base.colliders.filter(c => c.floor === undefined);
    const cname = c => c.prop || c.name || `${Math.round(c.x)},${Math.round(c.z)}r${c.r}`;
    const pois = interactivePoints();
    const wrapA = v => Math.atan2(Math.sin(v), Math.cos(v));

    // ── clearance oracle: metres between the body's skin and the nearest solid (>0 free, <0 buried)
    const B = 32, buckets = new Map();
    const bkey = (i, j) => i * 4096 + j;
    let maxR = 0;
    for (const c of solids) {
      maxR = Math.max(maxR, c.r);
      const k = bkey(Math.floor(c.x / B), Math.floor(c.z / B));
      const a = buckets.get(k); if (a) a.push(c); else buckets.set(k, [c]);
    }
    const scanDiscs = (x, z, range, cb) => {
      const bi = Math.floor(x / B), bj = Math.floor(z / B);
      const reach = Math.ceil((range + Math.max(0, maxR)) / B);
      for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) {
        const list = buckets.get(bkey(bi + i, bj + j));
        if (list) for (const c of list) cb(c);
      }
    };
    const clearAt = (x, z) => {
      let best = 99;
      scanDiscs(x, z, CLEAR + TURN, c => {
        const d = Math.hypot(x - c.x, z - c.z) - c.r - CLEAR;
        if (d < best) best = d;
      });
      return best;
    };

    // ── pinch wedges: solid pairs whose slot admits the body but not a turn
    const SLOT = 2 * CLEAR + 2 * TURN;
    const found = new Map();
    for (let i = 0; i < solids.length; i++) {
      const a = solids[i];
      for (let j = i + 1; j < solids.length; j++) {
        const b = solids[j];
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
        if (d > a.r + b.r + SLOT) continue;
        const gap = d - a.r - b.r;
        if (gap < 2 * CLEAR || gap >= SLOT) continue;
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const key = Math.round(mx / 4) + ':' + Math.round(mz / 4);
        const prev = found.get(key);
        if (prev && gap >= prev.gap) continue;
        const ux = -dz / d, uz = dx / d;
        // naming what closes the end is the difference between re-siting one prop and guessing at three
        const capAt = (x, z) => { let best = 1e9, hit = null; scanDiscs(x, z, CLEAR + TURN, c => {
          const dd = Math.hypot(x - c.x, z - c.z) - c.r - CLEAR; if (dd < best) { best = dd; hit = c; } });
          return hit ? `${cname(hit)} r${hit.r.toFixed(1)}` : null; };
        const run = (sgn) => {
          for (let k = 1; k <= 40; k++) {
            const px = mx + ux * sgn * k, pz = mz + uz * sgn * k;
            const c = clearAt(px, pz);
            if (c < 0) return { len: k - 1, open: false, cap: capAt(px, pz) };   // dead-end slot
            if (c >= TURN) return { len: k, open: true };     // room to pivot: a lane, not a trap
          }
          return { len: 40, open: true };
        };
        const fwd = run(1), back = run(-1);
        const dead = Math.max(fwd.open ? 0 : fwd.len, back.open ? 0 : back.len);
        // under 3 m of dead-end there is no slot to swallow the rover, the two discs are merely
        // neighbours along the same wall; with both ends open it is an ordinary aisle
        if (dead < 3 || (fwd.open && back.open)) continue;
        found.set(key, { a: cname(a), b: cname(b), gap: +gap.toFixed(2),
          margin: +(gap / 2 - CLEAR).toFixed(2),
          at: [Math.round(mx * 10) / 10, Math.round(mz * 10) / 10],
          axis: [+ux.toFixed(4), +uz.toFixed(4)],
          runs: [fwd.len, back.len], dead, caps: [fwd.cap, back.cap] });
      }
    }
    const wedges = [...found.values()].sort((x, y) => x.gap - y.gap);

    // ── grid over the built area (open desert outside it can never trap a rover)
    let x0 = START.pos[0], x1 = x0, z0 = START.pos[1], z1 = z0;
    const grow = (x, z, r) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r); };
    for (const c of solids) grow(c.x, c.z, c.r);
    for (const p of pois) grow(p.x, p.z, 8);
    x0 -= TURN + 6; x1 += TURN + 6; z0 -= TURN + 6; z1 += TURN + 6;
    const W = Math.ceil((x1 - x0) / CELL) + 1, H = Math.ceil((z1 - z0) / CELL) + 1;
    const GX = i => x0 + i * CELL, GZ = j => z0 + j * CELL;
    const slack = new Float32Array(W * H);
    const free = new Uint8Array(W * H);
    for (let i = 0; i < W; i++) for (let j = 0; j < H; j++) {
      const c = clearAt(GX(i), GZ(j));
      slack[i * H + j] = c;
      free[i * H + j] = c >= 0 ? 1 : 0;
    }

    // ── configuration-space BFS: one node per (cell, heading), edges are arcs the rover can steer
    const OFF = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (di || dj) OFF.push([di, dj, Math.atan2(di, dj)]);
    }
    const EDGES = [];
    for (let h = 0; h < NH; h++) {
      const list = [];
      for (let dh = -1; dh <= 1; dh++) {
        const h2 = (h + dh + NH) % NH;
        // a steered step follows the arc's chord, which points halfway between the two headings.
        // One 22.5° kink over a 2 m step is a 5.1 m radius — wider than the 4.24 m the rover can
        // actually hold, so the model never promises a turn the physics would refuse.
        const chord = (h + dh * 0.5) * STEP;
        for (const [di, dj, b] of OFF) {
          if (Math.abs(wrapA(b - chord)) <= STEP / 2 + 1e-6) list.push([di, dj, h2]);
        }
      }
      EDGES.push(list);
    }
    const seen = new Uint8Array(W * H * NH);
    const queue = new Int32Array(W * H * NH);
    let qh = 0, qt = 0;
    const si = Math.round((START.pos[0] - x0) / CELL), sj = Math.round((START.pos[1] - z0) / CELL);
    if (free[si * H + sj]) for (let h = 0; h < NH; h++) {
      const c = (si * H + sj) * NH + h; seen[c] = 1; queue[qt++] = c;
    }
    while (qh < qt) {
      const c = queue[qh++], h = c % NH, cell = (c - h) / NH;
      const i = (cell / H) | 0, j = cell % H;
      for (const [di, dj, h2] of EDGES[h]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const ncell = ni * H + nj;
        if (!free[ncell]) continue;
        const n = ncell * NH + h2;
        if (!seen[n]) { seen[n] = 1; queue[qt++] = n; }
      }
    }
    const reached = new Uint8Array(W * H);
    for (let c = 0; c < seen.length; c++) if (seen[c]) reached[(c / NH) | 0] = 1;
    const verdicts = pois.map(p => {
      const pi = Math.round((p.x - x0) / CELL), pj = Math.round((p.z - z0) / CELL);
      let best = null, bd = 13;
      for (let di = -6; di <= 6; di++) for (let dj = -6; dj <= 6; dj++) {
        const i = pi + di, j = pj + dj;
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        const d = Math.hypot(GX(i) - p.x, GZ(j) - p.z);
        if (d < bd && free[i * H + j] && reached[i * H + j]) { bd = d; best = [Math.round(GX(i)), Math.round(GZ(j))]; }
      }
      return { poi: p.name, at: [Math.round(p.x), Math.round(p.z)], r: p.r,
        slack: +slack[pi * H + pj].toFixed(2), park: best ? Math.round(bd) : null };
    });

    // ── terrain: the grade the wheels have to hold, and dune crests that would hang them.
    // Beyond r=105 the world is the boundary dune ring: too steep to climb is the point of it, so it
    // is not a defect and is kept out of the report.
    let maxSlope = 0, maxAt = null, steep = 0;
    const steepList = [], bumpSeen = new Map();
    for (let i = 1; i < W - 1; i++) for (let j = 1; j < H - 1; j++) {
      const cell = i * H + j;
      if (!free[cell] || !reached[cell]) continue;
      const x = GX(i), z = GZ(j);
      if (Math.hypot(x, z) > 105) continue;
      const s = surfaceSlope(x, z);
      if (s > maxSlope) { maxSlope = s; maxAt = [Math.round(x), Math.round(z)]; }
      if (s > 0.70) { steep++; if (steepList.length < 8) steepList.push({ at: [Math.round(x), Math.round(z)], deg: Math.round(Math.atan(s) * 180 / Math.PI) }); }
      const h0 = surfaceAt(x, z);
      let ring = -1e9;
      for (const [ox, oz] of [[1.45, 0], [-1.45, 0], [0, 1.45], [0, -1.45]]) ring = Math.max(ring, surfaceAt(x + ox, z + oz));
      const crest = h0 - ring;
      if (crest > 0.2) {
        const k = Math.round(x / 6) + ':' + Math.round(z / 6);
        const prev = bumpSeen.get(k);
        if (!prev || crest > prev.lift) { bumpSeen.set(k, { at: [Math.round(x), Math.round(z)], lift: +crest.toFixed(2) }); }
      }
    }
    const bumpList = [...bumpSeen.values()].sort((a, b) => b.lift - a.lift);

    // A pocket is a defect by how far it makes you back out, not by how tight it is. Reverse gear
    // works out of every wedge in this world — all 17 were driven into and out of with the real
    // physics on 2026-09-21, and the tightest of them (0.28 m of side slack, both faces touching)
    // still walked out under power at 9.6 m/s. The rule this replaced — "tight enough that both
    // push-out normals cancel ⇒ throttle buys nothing" — was a guess that measurement falsified,
    // so it is gone. What is left is the thing a player actually reports as stuck: a long blind
    // alley. Measured reverse speed is 3–6 m/s, so under ALLEY metres of dead run the escape is a
    // one-second tap on the brake pedal and not worth re-siting a landmark for.
    const ALLEY = 15;
    // And an alley has to be walked, not extrapolated. The axis probe above flies straight out of
    // the pinch, so on a bending aisle it wanders into a wall a driver never touches: three hub
    // wedges reported 16–19 m of dead run that way, and driving a rover into all three with the
    // real physics cleared two of them outright — it coasted through into open ground without
    // ever jamming. So a candidate over the threshold is re-measured along the aisle's spine: step
    // a metre, then keep whichever of straight-on, left-of-it or right-of-it has the most
    // daylight, which is what a driver does. Only that number is allowed to call a trap.
    const spineBlind = (w) => {
      let worst = 0;
      for (const sgn of [1, -1]) {
        let px = w.at[0], pz = w.at[1], ax = w.axis[0] * sgn, az = w.axis[1] * sgn;
        let len = 0, open = false;
        while (len <= 40) {
          let bx = px + ax, bz = pz + az, bc = clearAt(bx, bz);
          for (const [nx, nz] of [[-az, ax], [az, -ax]]) for (const f of [0.6, 1.2]) {
            const cx = px + ax + nx * f, cz = pz + az + nz * f, c = clearAt(cx, cz);
            if (c > bc + 0.05) { bc = c; bx = cx; bz = cz; }
          }
          if (bc >= TURN) { open = true; break; }        // room to pivot: the aisle let out
          if (bc < 0) break;                             // this step is the wall; stop short of it
          const st = Math.hypot(bx - px, bz - pz);
          if (st < 0.25) break;                          // no way forward on any bearing
          ax = (bx - px) / st; az = (bz - pz) / st; px = bx; pz = bz; len += st;
        }
        if (!open) worst = Math.max(worst, Math.round(len));
      }
      return worst;
    };
    for (const w of wedges) {
      const ci = Math.round((w.at[0] - x0) / CELL), cj = Math.round((w.at[1] - z0) / CELL);
      let inReach = false;
      for (let di = -2; di <= 2 && !inReach; di++) for (let dj = -2; dj <= 2; dj++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        if (reached[i * H + j]) { inReach = true; break; }
      }
      w.entered = inReach;
      w.blind = w.dead >= ALLEY ? spineBlind(w) : w.dead;
      w.trap = w.entered && w.blind >= ALLEY;
    }
    const traps = wedges.filter(w => w.trap);
    const slivers = [];
    for (let c = 0; c < free.length; c++) if (free[c] && !reached[c]) {
      const i = (c / H) | 0, j = c % H;
      slivers.push([Math.round(GX(i)), Math.round(GZ(j))]);
    }

    return { cell: CELL, turn: +TURN.toFixed(2), solids: solids.length, pois: pois.length,
      grid: [W, H], configs: qt, reachedCells: reached.reduce((a, v) => a + v, 0),
      freeCells: free.reduce((a, v) => a + v, 0),
      slotCount: wedges.length, trapCount: traps.length, traps,
      slots: wedges.filter(w => !w.trap && w.entered).slice(0, 12),
      // "Too far to touch" is the only reachability defect a point of interest can have: the nearest
      // legal parking cell sits outside the radius the game itself needs. A marker whose centre is
      // buried in its own prop — every reactor tap IS a solid rig, and the pads carry a pedestal —
      // is not a defect, you park beside those, so `slack` is reported per verdict and not judged.
      unreachable: verdicts.filter(v => v.park === null),
      tight: verdicts.filter(v => v.park && v.park > v.r + 2),
      slivers: slivers.slice(0, 10),
      terrain: { maxSlopeDeg: Math.round(Math.atan(maxSlope) * 180 / Math.PI), maxAt,
        steepCells: steep, steepList, bumpCount: bumpList.length, bumps: bumpList.slice(0, 12) } };
  },
  audio: () => ({ ready: audio.ready, state: audio.ctx?.state || 'none', lp: Math.round(audio.lowpass?.frequency.value || 0), lvl: +(audio.level?.() || 0).toFixed(3), eng: +(audio.engineG?.gain.value || 0).toFixed(3) }),
  audioCtx: () => audio.ctx,
  hold: (v) => { input.inp.keys[v ? 'add' : 'delete']('KeyE'); },
  photo: (v) => togglePhoto(v),
  // QA frame capture. A hidden tab never runs Environment.update, so the sun stays parked straight
  // overhead and every vertical face in the base reads black — the shot has to place the sun itself
  // before it means anything. The histogram comes back with the frame so a blown highlight is
  // visible in numbers instead of only in taste.
  shot: async (name, at, look, sunAt = [-150, 120, 95]) => {
    let sun = null;
    scene.traverse(o => { if (!sun && o.isDirectionalLight) sun = o; });
    if (sun) { sun.position.set(...sunAt); sun.target.position.set(0, 0, 0); sun.target.updateMatrixWorld(); }
    camera.position.set(...at);
    camera.lookAt(...look);
    post.composer.render();
    const cv = renderer.domElement;
    const c2 = document.createElement('canvas');
    c2.width = 160; c2.height = 100;
    const g2 = c2.getContext('2d');
    g2.drawImage(cv, 0, 0, 160, 100);
    const q = g2.getImageData(0, 0, 160, 100).data;
    const bins = new Array(10).fill(0);
    for (let i = 0; i < q.length; i += 4)
      bins[Math.min(9, (0.2126 * q[i] + 0.7152 * q[i + 1] + 0.0722 * q[i + 2]) >> 5)]++;
    const r = await fetch('http://127.0.0.1:8123/' + name, { method: 'POST', body: cv.toDataURL('image/jpeg', 0.85) });
    return { name, status: r.status, bins: bins.map(b => Math.round(b / 1600 * 100)), clip: +(bins[8] / 16 + bins[9] / 16).toFixed(1) };
  },
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
      fov: camera.fov, vis: base.launchRig ? base.launchRig.upper.visible : base.shipGroup.visible,
      phase: launch.phase,
      ly: +launch.y.toFixed(1), lt: +launch.t.toFixed(1),
      tel: launch.flight ? launch.flight.tel : null,
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
  // Every graded footing, with what the drawn mesh does at its own centre. `deck` and `drawn` have
  // to agree to within the mesh's 1.36 m interpolation, or the regrade survey missed the plan.
  footings: async () => (await import('./world/height.js')).listLots().map(l => ({
    id: l.id, x: +l.x.toFixed(1), z: +l.z.toFixed(1), w: +(l.hw * 2).toFixed(1),
    d: +(l.hd * 2).toFixed(1), deck: +l.h.toFixed(2), skirt: +l.skirt.toFixed(1),
    drawn: +surfaceAt(l.x, l.z).toFixed(2),
  })),
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
    // Fractions of the stack that is actually there, not metres typed in for the rocket this
    // replaced — two of those probes used to sit above the nose entirely. Each one asks the flight
    // where that point on the vehicle is, so after staging the high probes track the ship away and
    // the low ones track the booster coming home.
    const rig = base.launchRig, F = launch.flight;
    for (const f of [0.05, 0.35, 0.65, 0.95]) {
      const h = f * rig.h;
      const target = F && launch.phase !== 'countdown' ? F.point(new THREE.Vector3(), h)
        : new THREE.Vector3(ZONES.launch.pos[0], rig.y + 2.9 + h, ZONES.launch.pos[1]);
      const dir = target.clone().sub(camera.position);
      const dist = dir.length();
      rc.set(camera.position, dir.normalize());
      rc.far = dist - 1;
      const hits = rc.intersectObjects(scene.children, true).filter(x => x.object.visible);
      const p = target.clone().project(camera);
      out.push({
        h: +h.toFixed(1),
        px: [Math.round((p.x * 0.5 + 0.5) * 1280), Math.round((-p.y * 0.5 + 0.5) * 720)], onScreen: p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1,
        blocked: hits.length ? (hits[0].object.name || `${hits[0].object.type}/${hits[0].object.material?.name || '?'}`) : null,
        bd: hits.length ? +hits[0].distance.toFixed(1) : null,
      });
    }
    return out;
  },
  cam: () => ({ pos: camera.position.toArray().map(n => +n.toFixed(1)), rover: rover ? rover.group.position.toArray().map(n => +n.toFixed(1)) : null, dist: rover ? +camera.position.distanceTo(rover.group.position).toFixed(1) : null, scale: rover ? rover.group.scale.x : null, vis: rover ? rover.group.visible : null, rot: rover ? rover.group.rotation.toArray().slice(0, 3).map(n => +(n * 57.3).toFixed(1)) : null }),
};
// The language control lives outside the scene, so it is reachable on the menu, before the world
// finishes building, and after a boot failure. Everything it changes is re-rendered rather than
// reloaded — the base took sixteen seconds to build and none of it is language-dependent.
mountLangButton();
onChange(() => {
  renderMissions();
  UI.relabel();
  // The teleport panel and the two floating buttons are built once, so a language change has to
  // rewrite them where they stand — and repaint the map canvas, whose labels are drawn, not DOM.
  const q = s => document.querySelector(s);
  if (q('.tp-title')) q('.tp-title').textContent = t('✦ 传送网络 · TELEPORT NETWORK');
  if (q('.tp-tip')) q('.tp-tip').textContent = t('数字键 1-7 直接跃迁 · 按 G 在光台上就地开启 · M 全区地图');
  const fab = q('#tele-fab'); if (fab) fab.textContent = t('✦ 传送 · MAP');
  teleHint?._mute?._draw();
  chart?.invalidate();
  if (teleOpen) { closeTeleport(); openTeleport(); }
});

{
  const qp = new URLSearchParams(location.search);
  if (qp.get('auto')) {
    const tryStart = () => {
      if (document.getElementById('menu').classList.contains('hidden')) { setTimeout(tryStart, 120); return; }
      qKey = QUALITIES[qp.get('auto')] ? qp.get('auto') : autoDetect();
      $('start-btn').onclick();
      const demo = qp.get('demo');
      setTimeout(() => {
        // park the rover on the viewing deck, on the side away from the pad, so the shot reads
        // rover → deck → tower → stack instead of a vehicle hidden behind a concrete lip
        const [dwx, dwz] = ZONES.watch.pos;
        if (demo === 'launch') { window.__RSB.skipMissions(); window.__RSB.clearSky(); warpTo(dwx + 6, dwz - 4, true); }
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
