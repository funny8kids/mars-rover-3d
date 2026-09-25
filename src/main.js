import * as THREE from 'three';
import { QUALITIES, ZONES, START, RIM } from './config.js';
import { createSky } from './world/sky.js';
import { createTerrain, createRocks, createStones } from './world/terrain.js';
import { Environment } from './world/environment.js';
import { buildBase } from './world/props.js';
import { surfaceAt, surfaceSlope } from './world/height.js';
import { createRover } from './vehicle/rover.js';
import { RoverPhysics, platformAt, BODY_R, RIDE } from './vehicle/physics.js';
import { ChaseCamera } from './camera/chase.js';
import { createInput } from './input.js';
import { createFX, updateStorm } from './fx/particles.js';
import { createLaunch } from './fx/launch.js';
import { createJetPlumes } from './fx/plume.js';
import { createPadBeams } from './fx/beams.js';
import { createStageCollars } from './fx/staging.js';
import { StormField, createStormWall, placeStormWall } from './world/storm.js';
import { createRimVeil } from './world/rim_veil.js';
import { createShadowBudget } from './world/shadow_budget.js';
import { createPost } from './fx/post.js';
import { createSkidMarks } from './fx/skids.js';
import { GameAudio } from './audio/audio.js';
import { UI, fmtTime } from './ui.js';
import { createMapChart } from './ui/chart.js';
import { mountTelemetry } from './ui/telemetry.js';
import { t, getLang, mountLangButton, onChange } from './i18n.js';
import { STREETS, MOUTH } from './world/plan.js';

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
let stormField = null, stormWall = null, lastWind = null, rimVeil = null, shadowBudget = null;
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
  // Proximity defaults to standing at the pad, because the countdown returns before the flight
  // branch ever computes it — a zero here would quiet the ignition itself, the loudest beat.
  audioLevel: 0, audioProx: 1, audioAlt: 0, audioThrust: 0,
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
  addPadBeams();
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
  // Who is worth a depth-map draw. Rebuilt per tier because the cut is a picture decision, and the
  // std tier buys frame time that the hi tier can afford to spend on shadows instead.
  shadowBudget = createShadowBudget(scene, {
    big: quality.shadowBig, tall: quality.shadowTall,
    near: quality.shadowNear, far: quality.shadowNear + 10, eye: camera.position,
  });
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
// The pad's flood shafts. `fx/beams.js` poses them off the deck's own ring of lenses; what lives
// here is only the coupling, because whether a beam is lit at all is a weather question and the
// weather is this file's. Clean night air carries a faint column, and a sandstorm is the weather that
// makes a pad's floods actually show — the shafts are scatter, so they have to answer to how much is
// airborne rather than to how clear the air is. (The driver this replaced multiplied by
// `(1 - stormF)`, which snuffed them out during the one weather they exist for.)
const BEAM_CLEAN = new THREE.Color(0x9fc4ff);   // an LED bank's blue-white across clear air
const BEAM_DUST = new THREE.Color(0xffab63);    // the same lamp after the light crossed a dust column
const BEAM_TINT = new THREE.Color();
let beams = null;
function addPadBeams() {
  beams = createPadBeams(scene, base.launchRig);
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
  launch: { lead: 120, text: '▸ 最后一场沙暴 {time} 后压过基地 — 等发射窗口（晴空＋日落）开启，星舰才会点火' },
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
    r.mats[2].uniforms.uColor.value.copy(RIG_BEAM).lerp(RIG_DUST, f);
    // The rotor is the one part of a tap that owns its own material, so the coating lands on it
    // too: iron dulled to a matte, dust-brown film. Without this the daytime read of a choked
    // district was nothing at all — the plate and the shaft are both dusk-only by design.
    r.mats[0].color.copy(RIG_CORE).lerp(RIG_DUST, f * 0.62);
    r.mats[0].roughness = 0.2 + f * 0.55;
    // 5.3 at dusk put the rotor's own radiance ~12x over the night bloom gate (0.42), so bloom took
    // the cyan 0x4fe2ff and rendered it as a white disc with six spikes: the lamp lost its colour at
    // exactly the moment it was supposed to be the thing you navigate by. 2.1 still clears the gate
    // by five times, so the shaft keeps blooming, and what comes back through the bloom is the hue.
    r.mats[0].emissiveIntensity = p * (0.10 + st.nightF * 2.1) * beat * clear;
    r.core.rotation.y += dt * (0.4 + p * 2.6) * clear;   // the rotor slows when the array is choked
    r.mats[1].opacity = p * (0.02 + 0.73 * st.nightF) * beat * clear;
    const bu = r.mats[2].uniforms;
    bu.uLevel.value = p * (0.012 + 0.05 * st.nightF) * (1 - st.stormF * 0.6) * clear;
    bu.uTime.value = elapsed;
    bu.uCam.value.copy(camera.position);
    bu.uFogDen.value = scene.fog ? scene.fog.density : 0;
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
// Is a site's spire standing inside the rover's band right now? Two things take it out of the band:
// the drift it is buried under (the taller `k`, the deeper the same rock sits) and the sample having
// been collected, which hides the group. Written as one predicate because both of them change it, in
// two different places, and a wall with no geometry behind it is the defect — not a detail to be
// remembered at each call site separately. Read off the *measured* crown, not the sink depth: the
// drift's hiding depth has a 0.9 m floor so a short spire still vanishes, and a predicate borrowed
// from it would wall a rock out taller than it stands. `rise` and `sink` are re-sampled in props.js
// against the finished ground for the same reason — a seat taken mid-build goes stale under every
// footing claimed afterwards, and a stale one reported this line true over a crown already at
// 0.358 m, i.e. under the hull floor at RIDE 0.46. tools/site-wall-probe.js is the ruler.
const siteK = s => THREE.MathUtils.smoothstep(s.buried, 0.03, 0.85);
const siteWallUp = s => s.group.visible && s.rise - s.sink * siteK(s) > RIDE;
// Put the site's own discs in or out of the list the solver reads, by object identity. Membership
// rather than a flag on the disc: then the physics step, the unstick planner, the tour and seam
// drivers and the audit probe all see the wall that is actually there without any of them having to
// learn a new field, and a forgotten `if` cannot put the invisible ring back.
function syncSiteWall(s) {
  const up = siteWallUp(s);
  if (s.wallUp === up) return;
  s.wallUp = up;
  for (const d of s.discs) {
    const i = base.colliders.indexOf(d);
    if (up && i < 0) base.colliders.push(d);
    else if (!up && i >= 0) base.colliders.splice(i, 1);
  }
}
// Put a site where its ledger says it should be: sunk into its own drift by that drift's height.
function dressSample(s) {
  const k = siteK(s);
  s.crystal.position.y = s.seatY - k * s.sink;
  syncSiteWall(s);
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
// The window has two conditions, and the second is not a taste preference — it is measured. The pad's
// own rule already treats a launch as a night event (both the 灯光秀 prompt and the pad's interact are
// gated on `nightF > 0.5`), and the deck cloud under each sky is not the same picture: at dayT 0.3072
// (sun 23 deg up, key 3.40) 450 smoke sprites are a tan smear with no edge, lost against a pink sky;
// at dayT 0.76 (nightF 0.736, key 1.28 moonlight, fog 0.00378) 915 of the same sprites read as a lit,
// rolling mass under the gantry with the stack rim-lit against stars. Same camera, same MET 4.02.
//
// `LAUNCH_DUSK_AT` is where the gate's own `nightF` crosses 0.5 on the way down: `nightF` is
// smoothstep(0.05, -0.12, el), which is 0.5 at el = -0.035, and el = sin((dayT - 0.25)·2pi) puts that
// on the descending branch at dayT 0.75 + asin(0.035)/2pi = 0.7556.
const LAUNCH_DUSK_AT = 0.7556;
function launchWindowHold() {
  const pad = base.launchPadPos;
  const clear = stormField.timeToClear();
  if (clear > 0 || stormField.local(pad.x, pad.z) >= LAUNCH_DUST_LIMIT)
    return `⚠ ${t('发射窗口 · 等待沙暴过境')}${clear > 0 ? ' ' + mmss(clear) : ''}`;
  if (env.state.nightF < 0.5)
    return `⚠ ${t('发射窗口 · 等待日落')}${' ' + mmss(((LAUNCH_DUSK_AT - env.dayT + 1) % 1) * env.dayLength)}`;
  return null;
}
// The instrument panel the finale is read from. It mounts its own DOM into the HUD and stays dark
// until the count starts; `launchDeck` is the one thing the game has to do beyond feeding it numbers —
// while a vehicle is flying, the rover's speed and its battery have nothing to contribute to the frame.
const telemetry = mountTelemetry();
let launchDeckOn = false;
function launchDeck(on) {
  if (launchDeckOn === on) return;
  launchDeckOn = on;
  document.body.classList.toggle('launching', on);
}
function startCountdown() {
  if (race.active) { race.active = false; UI.raceShow(false); race.rings.forEach(r => r.visible = false); }
  // One slot, one line: the weather note rides along inside the launch notice instead of overwriting it.
  UI.toast(launch.held ? '✦ 发射窗口开启 — 星舰点火 · 请留在观礼台安全区' : '⚠ 发射程序启动 · 请留在观礼台安全区');
  launch.held = false;
  launch.phase = 'countdown'; launch.cd = 10.0;
  // Hold the sun where it is for the rest of the finale. The cycle is 300 s long, so left running it
  // climbs ~56 deg of elevation across the 46 s to SECO (see `dayHold` in world/environment.js for
  // the measurement) — the tower would be backlit at T-5 and front-lit at MECO, and the deck cloud
  // the whole sequence is lit by would change colour under its own smoke. The launch is gated on the
  // sky it is standing in, so the honest fix is to keep that sky, not to pick a prettier one.
  env.dayHold = true;
  launchDeck(true);
  telemetry?.countdown(launch.cd, 1);
}
// The finale fires two beats inside half a second of each other (boost MECO, then ship ignition), and
// there is one toast slot. Showing them as they land would silently drop one, so the text goes through
// a queue with a fixed gap while each beat's rings, flash and radio cue still fire the instant the
// flight module reports it. The event log the HUD will read is unaffected either way.
const launchQueue = [];
let launchGap = 0;
// Set by the QA hook `fly(t)`: the mission clock stops at that MET and stays there while the world
// keeps running, so a frame of staging is the same state on every capture instead of whatever the wall
// clock happened to be passing through.
let qaFly = null;
function updateLaunch(dt) {
  if (launchGap > 0) {
    launchGap -= dt;
  } else if (launchQueue.length) {
    UI.toast(launchQueue.shift(), 3600);
    launchGap = 6;
  }
  if (launch.phase === 'countdown') {
    launch.cd -= dt;
    telemetry?.countdown(launch.cd, dt);
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
  if (launch.phase === 'done') {
    // Hold the last of the numbers on the panel for five seconds — apoapsis, the touch-down offset —
    // and then give the frame back to the rover, because from here on the player is driving again.
    if (launchDeckOn && elapsed - launch.doneAt > 5) { launchDeck(false); telemetry?.hide(); }
    return;
  }
  const F = launch.flight;
  if (!F || launch.phase !== 'flight') return;
  if (qaFly === null) F.update(dt);
  for (const b of F.drain()) launchBeat(b);
  telemetry?.update(F, dt);
  if (F.done) finishLaunch();
  else {
    seedPlumes(F, dt);
    const prox = THREE.MathUtils.clamp(1 - Math.hypot(phys.x - base.launchPadPos.x, phys.z - base.launchPadPos.z) / 140, 0.12, 1);
    chase.trauma = Math.max(chase.trauma, 0.25 + prox * 0.75 * launch.intensity);
    launch.audioLevel = launch.intensity * prox;
    // The ear needs the bell count, not the throttle of whichever vehicle happens to burn harder:
    // sixteen bells at half throttle and three bells at full both read `intensity` = 0.5, and only
    // one of them is a launch. Summed per lit engine, then given back the booster's full rig as 1.
    // The height is averaged over those same weights, because after the split the two vehicles are
    // kilometres apart: the ship's altitude alone would voice the booster's 16-bell landing burn as
    // though it were still on the stack, and the booster's alone would mute the ship clearing the weather.
    // `node.position.y` needs no datum removed: the stack group rests on the pad, so a body's local y
    // *is* its height above the deck — the carry-over subtraction from the `launchPadPos` bug made the
    // channel read exactly the pad's own 0.6 m low (MET 0.5: −0.6 against a true 0; MET 4: 2.95 against 3.6).
    let thr = 0, thrAlt = 0;
    for (const p of F.plumes) {
      const c = p.engines * p.power;
      thr += c;
      thrAlt += c * p.body.node.position.y;
    }
    launch.audioThrust = Math.min(1, thr / F.engines.booster);
    launch.audioAlt = thr > 0.02 ? thrAlt / thr : F.alt;
    launch.audioProx = prox;
  }
  if (launch.flash > 0) launch.flash = Math.max(0, launch.flash - dt * 0.85);
}

const _bp = new THREE.Vector3();
let launchJets = null;
let stageCollars = null;
// One sound per beat, declared in a single place. The flight used to announce MECO, SECO, the ship's
// own ignition and the three dramatic events with the same 880 Hz countdown pip — five different
// moments of a launch, one UI blip, which is the tell that the audio was never written for this.
const LAUNCH_BEAT_SFX = {
  ignition: 'ignition', liftoff: 'liftoff', staging: 'staging',
  meco: 'meco', shipignition: 'relight', boostback: 'relight', seco: 'seco',
  boosterlanding: 'landing',
};
function launchBeat(b) {
  const F = launch.flight, rig = base.launchRig;
  const line = getLang() === 'en' ? b.en : b.zh;
  launchQueue.push(`◦ ${line} · T+${b.label}s`);
  const sfx = LAUNCH_BEAT_SFX[b.id];
  // A beat that belongs to one vehicle is thinned by that vehicle's own height, not by the blended
  // one the rumble uses: the blend weights by thrust, and at SECO the ship's throttle is already zero,
  // so it reported `air` 0.90 — a shutdown at nine kilometres voiced like it happened on the deck.
  if (sfx) audio.launchEvent(sfx, (b.id === 'seco' || b.id === 'shipignition') && F ? F.alt : undefined);
  if (b.id === 'ignition') {
    // The shock front, not the cloud. Overpressure crosses the deck faster than the condensed
    // vapour it pushes, so this ring deliberately outruns `blast` in seedPlumes — the two reading
    // at the same speed is what made the old deck effects look like one expanding disc.
    const ring = shockWave(base.launchPadPos.x, surfaceAt(...ZONES.launch.pos) + 2.2, base.launchPadPos.z, 0xffe0b0, 12);
    if (ring) ring.userData.grow = 20;
    launch.flash = Math.max(launch.flash, 0.34);
  } else if (b.id === 'liftoff') {
    // The deck's own beat: the overpressure ring that used to be keyed to a timer is now the moment
    // the thrust actually beats the weight, so it fires when the stack leaves, not when the clock says.
    UI.countdown(null);
    launch.flash = 1;
    const ring = shockWave(base.launchPadPos.x, surfaceAt(...ZONES.launch.pos) + 2, base.launchPadPos.z, 0xffd8a0, 10);
    if (ring) ring.userData.grow = 9;
  } else if (b.id === 'staging') {
    // The split's own light show, and deliberately not a `shockWave`: a deck ring stands where it was
    // put, and the vehicle that made it is 270 m gone by the time the ring fades. `fx/staging.js` poses
    // the collar off the booster's own rim every frame, normal to its own axis, and expands the band
    // without fattening it.
    stageCollars = stageCollars || createStageCollars(scene);
    stageCollars.spawn(F, rig);
    launch.flash = Math.max(launch.flash, 0.45);
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
  // The hold was taken for the ascent, not for good. `startCountdown` freezes the sky so the climb
  // keeps the light it was gated on; once the ship is gone the base has to keep living its own sol,
  // otherwise the whole game stays permanently at dusk after the one event that used it.
  env.dayHold = false;
  // Only the ship leaves. The booster came home, and a booster standing on its own pad with the
  // engines cold is the picture the whole sequence was built to arrive at — hiding the mount, as the
  // old code did, erased it along with the vehicle that had already flown away.
  base.launchRig.upper.visible = false;
}

const _pq = new THREE.Vector3(), _pr = new THREE.Vector3(), _pt = new THREE.Vector3(), _pv = new THREE.Vector3();
const _pu = new THREE.Vector3();
// Two roles, two pools, and each one sized to what the pool can actually hold.
//
// The flame pool used to *be* the plume: forty-odd sprites a frame, three to six metres across, laid
// down along the swept path. That is two and a half times what the pool holds, and a ring buffer that
// wraps under live particles does not simply get dimmer — it strobes, because the slots it recycles
// are the oldest still-drawn puffs, so the trail came out as a string of pearls spaced on the wrap
// cadence. The continuous column is fx/plume.js's job now. What sprites do better than any analytic
// shell is flicker, so that is all they are asked for: short life, small disc, and no swept path —
// which the last of those used to be a claim rather than a law, because the sprites were given the
// exhaust's speed and not the vehicle's, so the vehicle swept the path anyway. See `_pu` below.
//
// The smoke is the thing genuinely left behind. Its rate is set from the pool (cap ÷ mean lifetime
// ÷ 60) rather than from the bell count, which is the difference between a column and a banded wall
// of overlapping discs.
function seedPlumes(F, dt) {
  // Below the pad's own dust cloud the exhaust is digging through gas thick enough to entrain
  // something; by a few hundred metres there is nothing left to lift, and a trail that keeps its
  // density all the way up is why the vehicle looked like it was towing a plume of fog.
  const padF = THREE.MathUtils.clamp(1 - (F.alt - 12) / 120, 0, 1);
  // Guard on the ratio, not the frame: two rAF callbacks can land on the same timestamp, and an
  // infinite velocity would fling every flame sprite out of the scene in one frame.
  const invDt = dt > 1e-4 ? 1 / dt : 0;
  for (const p of F.plumes) {
    if (p.power <= 0) continue;
    // The ring of particles is laid out in the plane normal to that vehicle's own exhaust axis, so
    // the plume follows the lean instead of assuming the rocket is standing up.
    _pr.set(0, 1, 0);
    if (Math.abs(p.axis.y) > 0.98) _pr.set(1, 0, 0);
    _pt.crossVectors(p.axis, _pr).normalize();
    _pr.crossVectors(_pt, p.axis).normalize();
    // What the bell is doing to the air around it, in m/s, from the flight's own per-frame mouth
    // positions. `emit` takes world velocities, so without this the sprite is born standing still
    // over the pad and the vehicle climbs away from it: the chain it draws is then spaced on the
    // *vehicle's* speed, which is a number nothing about a flame should depend on. Exhaust velocity
    // is relative to the engine, so the carrier has to be added before the jet is.
    _pu.copy(p.pos).sub(p.prev).multiplyScalar(invDt);
    // The shell's own two numbers, from the law fx/plume.js poses with: the mouth radius scales on
    // the cluster, the column length on the throttle. Everything seeded below is a fraction of these
    // rather than a fixed number of metres — see the note above the trail.
    const mouth = 1.30 * Math.sqrt(Math.max(1, p.engines));
    const flame = mouth * (4.0 + 4.2 * p.power);
    const n = Math.max(1, Math.round(0.55 * p.engines * quality.particles * (0.4 + p.power)));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, r = mouth * (0.30 + Math.random() * 0.55);
      _pv.copy(_pt).multiplyScalar(Math.cos(a) * r).addScaledVector(_pr, Math.sin(a) * r);
      fx.flame.emit(
        p.pos.x + _pv.x + p.axis.x * 0.6, p.pos.y + _pv.y + p.axis.y * 0.6, p.pos.z + _pv.z + p.axis.z * 0.6,
        _pu.x + p.axis.x * (9 + Math.random() * 5) + _pv.x * 1.4,
        _pu.y + p.axis.y * (9 + Math.random() * 5) + _pv.y * 1.4,
        _pu.z + p.axis.z * (9 + Math.random() * 5) + _pv.z * 1.4,
        0.16 + Math.random() * 0.12, mouth * (0.45 + Math.random() * 0.55)
      );
    }
    // Two different clouds, because the exhaust makes two different clouds. While the jet still
    // reaches the deck it is turned sideways by the ground, and the visible mass rolls outward along
    // the pad from the strike point — it does not rise with the vehicle. Once the deck is out of
    // reach the only smoke left is the column the vehicle drags behind it.
    const deckY = surfaceAt(p.pos.x, p.pos.z);
    // The apron expands through its own *birth radius*, not through the velocity given to it. The
    // old seeding threw sprites outward at 8–16 m/s and expected them to travel; the pool damps
    // velocity by `drag^(dt·60)` = 0.975, which is ×0.22 a second, so a sprite's entire lifetime
    // travel is v/1.51 — five to ten metres. A cloud whose front covers ten metres in seven seconds
    // is a puddle, and that is why the hold-down read as a mist behind the tower legs. A blast front
    // is a decelerating current, so the edge follows `R·(1 − e^(−age/τ))`.
    // R is set by the camera, and this time the camera was measured rather than assumed. `framing()`
    // on a real `demo=launch` run: the rig sits 165 m out at MET 0.3, closes to 98 m through the
    // hold-down (MET 3.4-4.5), and pulls back to 137 m by MET 10 — at y 6-7 m through the whole
    // hold-down, so the deck is framed from near ground level. With the rig's own 78.3° vertical fov
    // that is 3.9 px per metre on a 696 px frame, and the 42.6 m stack spans 143 px of it. So a 48 m
    // front was never "a 35 px smudge" — it is 376 px, 59 % of the frame. The wisp was density, not
    // radius, and the previous note here got the radius wrong by sizing off a 147 m range that the
    // camera never holds while the jet is on the deck.
    // The upper bound is the camera itself. Sized at R = 120 with the sand outrunning it, the curtain
    // reached 129 m — past the rig's own 98 m — and the launch camera ended up *inside* the cloud it
    // was framing: 5 sand sprites over 8 m within 60 m of the lens, nearest at 35 m, and the frame
    // came back a flat tan field. 54 m keeps the front at half the closest range, so the camera
    // always watches the bank from outside it. A decelerating current, so the edge follows
    // `R·(1 − e^(−age/τ))`.
    const blast = 54 * (1 - Math.exp(-F.met / 6.4));
    // The bank is the other half of the same defect and it was the worse one: the apron was at most
    // ~8 m tall at the mount, and the launch camera frames the deck from y 6-7 m, so it was looking
    // *along* an 8 m slab — a line on the sand, not a mass. Height is seeded directly for the same
    // reason radius is (the pool's buoyancy tops out at gravity/drag = 1.06 m/s, ~8 m over a life),
    // and it grows with the front because the column is fed continuously while its edge spreads.
    // 34 m of bank over 54 m of front is the ~0.6 aspect an ignition cloud actually holds.
    const bank = 8 + 26 * (1 - Math.exp(-F.met / 7));
    const mPad = Math.round(7.0 * quality.particles * padF * (0.25 + 0.75 * p.power));
    for (let k = 0; k < mPad; k++) {
      const a = Math.random() * 6.283;
      // Biased toward the mount, not spread evenly over the area. A uniform-in-area fill spends
      // most of a fixed particle budget on the widening outer ring, and what the frame got was a
      // handful of isolated lobes out by the gantries with bare sand between them. The opaque mass
      // of a real launch sits on the mount; only its fingers reach out. The exponent loosens from
      // 1.8 to 1.4 with the new radius: at R = 48 an `r^1.8` fill still landed half its sprites
      // inside 15 m, which starved everything past the tower legs.
      const rr = 6 + Math.pow(Math.random(), 1.4) * Math.max(0, blast - 6);
      const ux = Math.cos(a), uz = Math.sin(a);
      // Measured from the mount, not from the pad centre: `rr` never goes below the mount radius,
      // so `rr/blast` would call the sprite 27% of the way to the front while it is still sitting on
      // the hold-down ring, and the wedge below would flatten out exactly where it should be tallest.
      const edge = blast > 6 ? Math.min(1, (rr - 6) / (blast - 6)) : 0;
      // It boils up out of the trench by the mount and flattens to a skirt as it rolls: the cloud
      // is a wedge, not a slab. The wedge steepens with age, because the jet keeps feeding the mount
      // while the front is out on the sand. `r^1.7` keeps most of the mass in the lower third of the
      // bank — a uniform fill would put the deck's own smoke at 30 m and the column would read as
      // fog, not as a launch.
      // The height is measured off the ground the sprite is actually sitting on, not off the pad.
      // `deckY` is the graded fill under the mount, and the apron now reaches 60-90 m out, past the
      // fill and down to the dune sand; seeding every sprite from the pad's datum drew the far half
      // of the bank as a slab hanging several metres above the terrain it had rolled out over — the
      // flat-bottomed-mushroom silhouette in the MET 4 wide frame.
      const px = p.pos.x + ux * rr, pz = p.pos.z + uz * rr;
      const y = surfaceAt(px, pz) + 0.7 + Math.pow(Math.random(), 1.7) * bank * (1.15 - 0.55 * edge);
      // Birth sizes; the pool's `sizeGrow` 2.6 multiplies them by the end of life, so the mount band
      // runs 4.5-8 m at birth → 12-21 m as it dies, and the front 8-17 m → 21-44 m. Puffs at the
      // leading edge are the big ones: a current that has entrained 100× its own volume of air does
      // not stay the size it was at the throat, and a 5 m sprite out at 50 m is the isolated-lobes
      // defect again. The ceiling is the camera: the near side of the ring is 56 m from the lens at
      // this radius, and a puff that projects over ~25° there is one disc covering a third of the
      // frame — which is how the previous, larger fill blanked it. The largest puffs are also the
      // dimmest, since they are late in life's clock and `fade` is already taking them.
      const s = 4.5 + Math.random() * 3.5 + edge * (3.5 + Math.random() * 5.5);
      fx.smoke.emit(
        px, y, pz,
        ux * (2 + 9 * edge), 1.5 + Math.random() * 3.5, uz * (2 + 9 * edge),
        5.5 + Math.random() * 4.5, s
      );
    }
    // The apron is one of three masses the deck makes, and it was the only one seeded. What the frame
    // was missing at the moment of maximum drama — hold-down, jet on the pad, tower legs full of
    // exhaust — was the white boil-off at the mount and the brown curtain running out ahead of the
    // grey. Both ride the same `blast` clock as the apron, because all three are one event at three
    // grain sizes: the trench boiling, the condensate rolling, the sand it sweeps.
    // Water the deluge floods the trench with, turned to steam by a jet that is still hitting the
    // deck. It is born *at* the mount and rises, so its radius stays a few mouths wide while the
    // smoke is already out at the gantries — the two masses separate in the frame the way they do on
    // a pad, instead of one grey blob doing both jobs.
    const mDel = Math.round(2.4 * quality.particles * padF * (0.2 + 0.8 * p.power));
    for (let k = 0; k < mDel; k++) {
      const a = Math.random() * 6.283;
      // Measured on the previous fill: `rMax 30.2 m` for a mass that is supposed to sit on a mount
      // whose own radius is `mouth` = 1.3·√n ≈ 3 m, and 11.3 m after the band below. The old band
      // reached 2.4·mouth plus a term that grew with `blast`, so the steam was sprayed to the same
      // radius as the smoke apron — and the two masses, which were supposed to separate in the frame,
      // just averaged into one veil. A boiled-off column leaves the trench within a couple of mount
      // widths and only *rises* from there, which is what the buoyancy in the pool already does for
      // it.
      const rr = mouth * (0.35 + Math.pow(Math.random(), 2.2) * 1.25);
      const ux = Math.cos(a), uz = Math.sin(a);
      // Sizes span ~5× (2.5 → 12 m at birth, and the pool's `sizeGrow` 2.0 takes them to 5–24 m as
      // they die) rather than the old 2:1 band, and the distribution is skewed by `rand^1.6` so the
      // small end carries most of the count. The reason is structural, not stylistic: a volume reads
      // as a volume only where *adjacent* puffs differ in optical depth, and two same-size puffs
      // overlapping at any offset average to a flat wash, while a 3 m puff sitting inside a 12 m one
      // leaves a visible core. What the buffer actually holds now is the reproducible number —
      // `__RSB.plume().deck.deluge.size` reads the alive sprites' aSize quantiles as 3.76 / 7.38 /
      // 12.14 / 15.37 m over 180 live sprites at MET 4 and 4.08 / 8.74 / 14.88 / 21.83 m over 262 at
      // MET 8 (quality 'std', the launch camera at its 98 m closest and 130 m pulled back). Against
      // the old fill's ~2:1 band that is a 4.1× spread at the mount and 5.4× by MET 8; re-sampling
      // the same sequence moved each digit by under a metre and the counts by seven sprites, so the
      // claim being made is the ratio, not the digits.
      const s = 2.5 + Math.pow(Math.random(), 1.6) * 9.5;
      fx.deluge.emit(
        p.pos.x + ux * rr, deckY + 0.4 + Math.random() * 1.8, p.pos.z + uz * rr,
        ux * (2.0 + 5.0 * Math.random()), 1.4 + 2.6 * Math.random(), uz * (2.0 + 5.0 * Math.random()),
        2.6 + Math.random() * 2.2, s
      );
    }
    // Sand outruns smoke: the blast front is a shallow, fast current and the condensate cloud behind
    // it is deep and slow, which is why a real launch reads as a brown ring with a white wall inside
    // it. So the front reaches further than `blast` (1.25x) and the fill is biased *outward*
    // (`rand^0.55`, against the apron's inward `rand^1.4`) — the curtain is the leading edge, and the
    // ground inside it has already been scoured. Height follows the same logic: shallow off the deck
    // at the front, taller where the current is still turning the corner out of the mount.
    // 1.25 rather than the 1.55 first written here, because that multiplier is what put the curtain
    // outside the launch camera: 1.55 over a 54 m front is 80 m of radius, and the outrunning term on
    // top of a 120 m `blast` reached 129 m — past the rig's own closest 98 m, so the camera was
    // standing in the sand it was supposed to be filming.
    const sFront = 6 + Math.max(0, blast - 6) * 1.25;
    // The curtain's own depth, on the same decelerating clock: a wall of suspended grains is thin at
    // the front and taller where the current is still turning out of the mount. The ceiling is the
    // camera again — it frames the deck from y 6-7 m, so a 11 m wall standing between it and the pad
    // occupies the whole lower third of the frame, which is the dramatic reading, and anything much
    // taller starts hiding the stack itself.
    const sandH = 2.2 + 9 * (1 - Math.exp(-F.met / 9));
    const mSand = Math.round(3.5 * quality.particles * padF * (0.3 + 0.7 * p.power));
    for (let k = 0; k < mSand; k++) {
      const a = Math.random() * 6.283;
      const rr = 6 + Math.pow(Math.random(), 0.55) * Math.max(0, sFront - 6);
      const edge = sFront > 6 ? Math.min(1, (rr - 6) / (sFront - 6)) : 0;
      const ux = Math.cos(a), uz = Math.sin(a);
      // Same multi-scale spread as the steam, and the same reason, plus one that only shows up at
      // range: a 3 m grain cloud out at 80 m projects to ~12 px at the launch camera and the curtain
      // reads as a dotted line of specks. Sand grows as it is carried — the current picks up the
      // whole surface it runs over — so size rides `edge` from 1.2-4.7 m at the mount to 3.2-10.2 m at
      // the front. The front's ceiling is the near side of the ring, which at this radius is ~30 m
      // from the lens: a 19 m puff there (the previous band's top) is one disc across a quarter of
      // the frame, and five of them blanked it.
      const s = 1.2 + Math.pow(Math.random(), 1.5) * 3.5 + edge * (2 + Math.random() * 5);
      const px = p.pos.x + ux * rr, pz = p.pos.z + uz * rr;
      fx.sandblast.emit(
        px, surfaceAt(px, pz) + 0.25 + Math.pow(Math.random(), 2.2) * sandH * (1.2 - 0.5 * edge), pz,
        ux * (3 + 12 * edge), 0.3 + 1.3 * Math.random(), uz * (3 + 12 * edge),
        1.8 + Math.random() * 1.5, s
      );
    }
    // The wake is born past the flame's tip, not at the mouth. It used to be seeded between `prev`
    // and `pos` — one frame of travel, 1.2 m at 70 m/s — so every sprite appeared in the same annulus
    // around the throat, and since a sprite is brightest at birth the vehicle flew with a luminous
    // collar welded to its base in every frame of the ascent. Physically the exhaust only becomes
    // smoke once the column has slowed and entrained enough to condense, which is downstream of where
    // the shell's own emission has already died. `axis` is the path direction to within the few degrees
    // of attack a rocket ever flies at, retrograde burns included, so it does not need the finite
    // difference to know which way is behind.
    const mTrail = Math.max(1, Math.round(quality.particles * (0.9 + 1.7 * (1 - padF)) * (0.4 + p.power)));
    // Lifetime, not count, is what makes a trail continuous. The puffs are laid down at the vehicle's
    // own speed, so the spacing between neighbours is fixed by that speed and no number of extra
    // puffs buys it back — the doubled-rate experiment moved `plume().cover.trail.hole` only
    // 0.38 → 0.31 and left `pmin` at 0, then saturated the shared pool at MET 8 (1 641 / 1 680),
    // which is the wrap-strobing failure mode this file already documents. What closes a gap is each
    // puff outliving the interval until the next one arrives, and the honest version of that is
    // altitude-dependent: on the deck the smoke is a ground-hugging cloud that dissipates against the
    // pad (1.4-2.4 s, unchanged), and high up it is a trail hanging in still air (3.4-5.8 s at
    // padF 0). The side frame at MET 14 is what set the target — discrete 20 px balls with dark air
    // between them for the whole lower two thirds of the column, i.e. a two-second ribbon of path at
    // 60 m/s. Equilibrium at the far end is 3 puffs/frame × 5.8 s × 60 ≈ 1 040, inside the 1 680 cap.
    const trailLife = (1.4 + Math.random()) * (1 + 1.4 * (1 - padF));
    // The drawn flame is not the shell's length. `plume.js` stacks a core layer at 0.40 of the column
    // and a barrel at 1.00, and the shell's own fragment shader multiplies its alpha by
    // `1 - smoothstep(0.50, 1.0, s)`, so every layer stops emitting at half of its own length: the
    // bright column the eye sees is 0.20 of the nominal one, and even the faint barrel is gone by 0.50.
    // The offset below is measured from `core` for that reason. It used to be `flame * (0.52 + rand·0.72)`
    // under a comment saying "born past the flame's tip" — but `flame` is the nominal length, so the
    // first puff of the sheath appeared 2.6 flame tips below the last pixel of flame. That gap is the
    // pearl chain: a bright stub, ~14 m of clear sky, then a string of grey puffs hanging underneath,
    // which is what the MET 15 ascent frame actually showed.
    const core = flame * 0.20;
    for (let k = 0; k < mTrail; k++) {
      const d = core * (1 + Math.random() * 4.6), dn = d / flame;
      // Both of these are fractions of the mouth radius, and that is the fix: anything wrapped
      // around a rocket has to be sized by the rocket. They used to be absolute metres, so one
      // literal set of constants wrapped a 42.6 m booster column and an 18.5 m upper-stage column
      // at the same scale. The numbers below are what `__RSB.plume().sheath` prints as
      // `pctMean · pctMax` — the drawn pixel size of a live smoke puff, as a share of the drawn
      // pixel length of the flame column it wraps. Same ruler for both bodies because the ratio is
      // size/col at any camera range:
      //   booster MET 15  absolute metres (was)   29 ·  97 %   ship MET 24    67 · 229 %
      //   1.3–2.2 mouth   "                       44 · 118 %   "              44 · 146 %
      //   0.6–1.15 mouth  "                       21 ·  74 %   "              22 ·  74 %
      //   0.6–1.15 mouth  + focal build (now)     20 ·  36 % (colPx 94.7)   · 20 · 37 % (colPx 45.7)
      // Proportional scaling alone only made the two bodies *equally* wrong, and the booster had
      // been the tolerable one by luck: its 5.2 m mouth happened to sit near the old literal metres.
      // The second line is what that change is for — until then one sheath puff could be drawn
      // longer than the whole flame behind it. `pctMax` is a single oldest sprite, and the pool's
      // `(1-t)` fade has that one near a tenth of its birth opacity, so `pctMean` is what carries.
      // The last line is the same seeding re-read after the pool started drawing in its own metres
      // (`uFocal`, see fx.smoke). It is the row that matters: the two bodies now agree to within a
      // point of each other, which is what sizing by the mouth is supposed to produce, and the
      // `pctMax` that used to reach 229 % is 37 %. The three rows above it are void as evidence —
      // that ruler was the shader's `160` fudge, which shrank every puff by 3.8x against its own
      // metres while leaving the column length projected correctly, so they were comparing a
      // mis-scaled numerator to a correct denominator.
      // The band broadens with distance because that is what an entraining plume does, and because the
      // silhouette it has to cover broadens too: the core layer ends at 0.40 mouths of radius, the
      // barrel at 1.00.
      const a = Math.random() * 6.283, rr = mouth * (0.30 + Math.random() * (0.55 + 0.85 * dn));
      _pv.copy(_pt).multiplyScalar(Math.cos(a) * rr).addScaledVector(_pr, Math.sin(a) * rr);
      _pq.copy(p.pos).addScaledVector(p.axis, d);
      if (_pq.y < deckY + 1) continue;
      fx.smoke.emit(
        _pq.x + _pv.x, _pq.y + _pv.y, _pq.z + _pv.z,
        _pv.x * 0.7 + p.axis.x * 2, 0.6 + Math.random() * 1.4, _pv.z * 0.7 + p.axis.z * 2,
        // Two numbers, two different failures. The lifetime is what makes the column continuous (see
        // `trailLife` above); this band is what stops the continuous column reading as a stack of
        // cotton balls. The close side frame at MET 14 said that exactly: no dark air between the
        // puffs any more, but a scalloped silhouette, because `0.6-1.15 mouth` only lets a puff
        // differ from its neighbour by 1.9×, and same-size puffs overlapping at any offset average to
        // one flat mass. A volume needs a 2 m puff inside a 9 m one to leave a core at all, so the
        // band is now a power law over 0.30-1.55 mouths — neighbours differ by up to 5×, and the mean
        // birth size drops a little rather than a lot, which keeps `pctMax` (the drawn puff against
        // the drawn flame column, 21 % here) well inside the ceiling the sheath was sized against.
        trailLife, mouth * (0.30 + Math.pow(Math.random(), 1.7) * 1.25)
      );
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
const _lshot = new THREE.Vector3();
const _laim = new THREE.Vector3();

// ─── the launch shot list ────────────────────────────────────────────────────
// The rig used to hold exactly one station — 122 m off the vehicle, 27 m below it — from the
// hold-down to SECO. Measured against the real flight, the ship subtended 92–100 px of a 696 px
// frame for fifty straight seconds and the booster left the frame at MET 24 and never came back,
// so the flight happened *to* the camera rather than past it. Scale and subject are the only two
// things a launch can move, and this table now moves both: each beat owns its own stand-off and
// its own vehicle, and the numbers are the frame heights the flight actually reaches.
//   t     mission second
//   r     horizontal stand-off from the subject's own ground track, m
//   drop  how far below `ref` the station hangs; large reads as a spectator on the deck
//   ref   stack-local height whose world Y anchors the station (0 = the deck the subject stands on)
//   aim   stack-local height the lens centres on
//   pad   0..1 pull toward the pad, so the deck stays in frame while the subject comes to it
const SHOTS = [
  { t: 0, r: 165, drop: 4, ref: 0, aim: 40, pad: 1 },     // 全景：坪面、塔架、整枚组合体立在那里
  { t: 4, r: 98, drop: 6, ref: 0, aim: 30, pad: 1 },      // 推近：离塔，发动机与导流槽压满下半幅
  { t: 9, r: 132, drop: 30, ref: 0, aim: 36, pad: 0 },    // 拉开：箭体开始穿过画面而不是停在里面
  { t: 15, r: 205, drop: 68, ref: 0, aim: 38, pad: 0 },   // 穿云：满屏收成三分之一，高度终于看得见
  { t: 20, r: 120, drop: 22, ref: 0, aim: 38, pad: 0 },   // MECO：压回级间段，等分离那一下
  { t: 24, r: 152, drop: 36, ref: 20, aim: 54, pad: 0 },  // 分离：两级同框，中间那段空的就是事件本身
  { t: 30, r: 115, drop: 32, ref: 0, aim: 19, pad: 0 },   // 归航：跟住助推器的翻转和反推点火
  { t: 41, r: 92, drop: 7, ref: 0, aim: 15, pad: 1 },     // 落台：回到坪面高度，看它自己站住
  // 入轨。The lens stays on the booster and lifts off it, rather than tilting up to chase the ship.
  // Measured: at SECO the ship is 8.1 km out and the dust column between it and the deck erases it
  // completely (`erase` = 1.000 at ground density), so the first version of this beat — `aim: 66`,
  // the ship's own nose — photographed five flat seconds of empty haze with the landed booster 81°
  // out of frame. What the deck can actually show at that second is the half that came back, sitting
  // under the whole sky the other half left.
  { t: 46, r: 108, drop: 3, ref: 0, aim: 27, pad: 1 },    // 入轨：助推器压在画面下方，上面整片是它空出来的天
];
const SHOT_FADE = 2.6;       // s of cross-fade between beats — shorter and the camera snaps between
                             // stations faster than the smoothing in `chase` can follow it
// The highest the launch rig may lift. The sky dome is a 7 km sphere standing still at the world
// origin and the camera's far plane is 9 km, so past ~2 km of AGL the dome's own far side crosses
// that plane and the horizon becomes an arc sliced clean across the frame — which is precisely what
// the first instrumented flight photographed at MET 44, with the chase cam at 7.1 km.
const SHOT_CEIL = 1800;
// How fast the dust column thins with height. `FogExp2` has one density for the whole scene, so a
// camera that has climbed out of the column would still be told the far end of a 7 km line of sight
// is opaque — the ship's last beat came back as a flat field of sky colour. The scale length is the
// column, not the atmosphere: above ~1.5 km of AGL there is essentially no dust left underneath.
const DUST_SCALE_HEIGHT = 900;
function launchShot(t, top) {
  const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let i = 0;
  while (i < SHOTS.length - 1 && t >= SHOTS[i + 1].t) i++;
  const a = SHOTS[i], b = SHOTS[Math.min(i + 1, SHOTS.length - 1)];
  const span = b.t - a.t;
  // Cross-fade centred on the boundary, so a beat is fully itself for the middle of its own span
  // and only the hand-off between two is a move.
  const w = span > 0 ? cl((t - a.t - (span - SHOT_FADE) / 2) / SHOT_FADE, 0, 1) : 1;
  const e = w * w * (3 - 2 * w);
  const mix = (k) => a[k] + (b[k] - a[k]) * e;
  return { r: mix('r'), drop: mix('drop'), ref: mix('ref'), pad: mix('pad'),
    aim: cl(mix('aim'), 0.2, top) };
}

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
//   detect    a pedal buried and the hull going nowhere for 2.2 s — see the measurements behind
//             `STALL_V`. Net ground alone is not the state: a brake-and-reverse shuffle ends where it
//             started with 7 m/s on the speedometer, and taking the wheel from a rover that is
//             driving is the same lost-control report in a different costume.
//   back-out  real throttle, away from the deepest contact. Same grip, same slope, same collision
//             response: it is a drive, not a rescue. Which heading, in what order, is decided by what
//             a wedged hull can actually execute — see `rescuePlans`. It is done when the faces that
//             held it have let go, not when the odometer has ticked over — see `outOfPocket`.
//   jack      once the ranked headings have each had their 1.8 s and none of them released the
//             pocket, raise the chassis on its recovery rams and glide to the nearest legal surface.
//             The collider discs are 2D, so lifting alone frees
//             nothing — the horizontal glide is the escape and the lift is what stops the wheels
//             dragging through the ground on the way.
// Nothing teleports and nothing clips: `jack` interpolates over 1.15 s with a smoothstep, so
// velocity starts and ends at zero and the rover never moves further in a frame than it drives,
// and a glide path is rejected unless every half metre of it is clear of props the rover was not
// ALREADY touching. Control is never taken away either — the raw key set is watched separately
// from the synthesised pedals, so tapping S or Space hands the rover straight back.
// BODY_R is imported from physics.js: the rescue planner and the physics solver must agree on how
// far a disc reaches, and a locally-typed 1.6 would silently let the planner park the rover inside
// a collider it thought it was avoiding.
const rescue = {
  phase: '', t0: 0, cool: 0, tries: 0, markT: 0, markX: 0, markZ: 0, markV: 0,
  stillT: 0, stillX: 0, stillZ: 0,
  ax: 0, az: 0, heading: 0, reverse: false, from: null, to: null, near: [], maxStep: 0,
  heldBrake: false, heldDrift: false, events: [],
  // The back-out is aimed at one entry from `rescue.plans` at a time. A heading that has already
  // had its 1.8 s and bought nothing is not retried — the next one is — so a pocket with three
  // plausible corridors gets three drives before anything is lifted.
  plans: [], plan: 0, planX: 0, planZ: 0, straight: false, wedged: null,
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

// The discs holding the hull right now: the body ring overlaps them, with the same 0.35 m of slack
// the ring search in `nearestLegalSurface` has always used. One rule, three readers — the glide
// path may cross these, the escape test is measured against these, and the back-out is aimed
// relative to these.
function wedgedFaces(list) {
  return new Set(list.filter(c => Math.hypot(phys.x - c.x, phys.z - c.z) < c.r + BODY_R + 0.35));
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
  const wedged = wedgedFaces(list);
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

// The headings a back-out can try, best first.
//
// Ranking by straight-line daylight alone was the bug. At the chopstick-tower/cargo-booster joint the
// widest corridor (10 m of daylight) runs 90° off the hull; the rescue steered toward it, and a hull
// already jammed between two discs cannot pivot — physics.js's turn authority is scaled by speed,
// and the speed is zero — so the drive scraped 1.1 m and called it done. Reversing with no steering
// from the identical stance walked 41.6 m out and never tripped the detector at all. So an
// along-the-hull heading (fore or aft, either executes as a straight line) beats any amount of
// daylight off the axis, and daylight only breaks ties among equals.
function rescuePlans() {
  const list = [];
  for (let k = 0; k < 16; k++) {
    const a = phys.yaw + (k / 16) * Math.PI * 2;
    let d = 0;
    while (d < 10 && gapFrom(rescue.near, phys.x + Math.sin(a) * (d + 0.5), phys.z + Math.cos(a) * (d + 0.5)) >= 0) d += 0.5;
    const off = Math.abs(wrapPi(a - phys.yaw));
    list.push({ a, d, straight: Math.min(off, Math.PI - off) < 0.25 });
  }
  // zero daylight is never executable, whatever the alignment — an entry that cannot leave the spot
  // it stands on ranks below one that can, so `!pick.d` below means "no heading works", not
  // "the best-aligned heading happens to be a wall".
  const rank = p => (p.d > 0 ? 2 : 0) + (p.straight ? 1 : 0);
  return list.sort((x, y) => (rank(y) - rank(x)) || (y.d - x.d));
}

// The solids that could be holding the hull: every non-floor disc within one survey sweep. Both the
// detector's contact test and `startRescue`'s back-out survey read this, so the two cannot disagree
// about what is around the rover.
const nearSolids = () => base.colliders.filter(c => c.floor === undefined &&
  Math.hypot(phys.x - c.x, phys.z - c.z) < c.r + BODY_R + 26);

// Out of the pocket, which is not the same as out in the open. The old exit test was "1.9 m of
// movement", and a rover nose-down on one wall clears that by lurching sideways off it — the rescue
// then stood down, the player pressed W again, and the wedge caught it again. That loop, repeated at
// 2.2 s intervals, is what reads as "WASD 失效". The escape is measured against the specific faces
// that were holding the hull: every one of them must be released.
function outOfPocket() {
  if (!rescue.wedged) return true;
  for (const c of rescue.wedged)
    if (Math.hypot(phys.x - c.x, phys.z - c.z) - c.r - BODY_R < 0.25) return false;
  return true;
}

// "Stuck" is the report's own sentence, measured in one window: the hull sits still for over two
// seconds while a pedal is buried. Anything looser has been falsified by measurement.
//
// Net ground alone filed brake-and-reverse shuffles as deadlocks (three spots, hull touching
// nothing, every heading with 10 m of daylight, 1.6-7.2 m/s at the instant the rescue took the
// wheel; re-driven from the same pose they covered 18-40 m). Requiring contact instead let a
// driving rover arm the rescue the moment one disc entered the body ring: (-8.6, 10.4) in a 420 s
// soak, a 6.5 s window that wandered at up to 14.7 m/s and came back inside a metre of its own
// anchor, armed with one bearing face at 3.5 m/s and released itself after 1.9 m of a loop. A wall
// brush is not a wedge. What separates the two is not what the hull touches but what it does — a
// real wedge is a hull the throttle cannot move, so the detector now measures exactly that, and
// `held`/`pocket` stay in the record as diagnosis rather than gate.
//
// The anchor slides: any excursion to `STALL_V`, or a metre of ground covered, restarts the count
// (`rescueWatch`). That is what keeps a rover grinding up a steep slope (0.5 m/s, and climbing) out
// of it, and why no separate speed maximum over a wider window is needed — a terrain pin with no
// discs in reach arms on the same rule as a prop wedge, which was the only case the old contact test
// could not see at all.
const STALL_V = 1.0;   // m/s — the speedometer's own rounding floor: below this the hull reads 0
const STALL_T = 2.2;   // s   — "持续 >2s", the same bar the audit files a stall with
const PIN_NET = 0.9;   // m   — the same "less than a metre of ground" the audit measures a window by

// One line in the audit trail. `out: ''` marks a still-running attempt, which is how `escalate` and
// `returnToPlateau` know which record their phase change belongs to.
function rescueRec(cause) {
  const vf = phys.vx * Math.sin(phys.yaw) + phys.vz * Math.cos(phys.yaw);
  const rec = { t: +elapsed.toFixed(1), cause, pos: [+phys.x.toFixed(1), +phys.z.toFixed(1)],
    yaw: +phys.yaw.toFixed(2), vf: +vf.toFixed(2), slope: +surfaceSlope(phys.x, phys.z).toFixed(2),
    grounded: phys.grounded, onFloor: phys.onFloor, discs: rescue.near.length,
    winV: rescue.markT ? +rescue.markV.toFixed(2) : null, held: wedgedFaces(nearSolids()).size,
    // what the gate actually saw: how long the hull has been neither moving nor covering ground
    still: rescue.stillT ? +(elapsed - rescue.stillT).toFixed(2) : null,
    stillNet: rescue.stillT ? +Math.hypot(phys.x - rescue.stillX, phys.z - rescue.stillZ).toFixed(2) : null,
    out: '' };
  rescue.events.push(rec);
  if (rescue.events.length > 24) rescue.events.shift();
  return rec;
}

// How many of the ranked headings get driven before the chassis is lifted. Each costs 1.8 s, so three
// is already 5.4 s of the player's time; a pocket that will not release down any of them is not a
// survey problem but a real wedge, and `escalate`'s ring search is wider than the heading set.
const PLAN_TRIES = 3;

// Arm the back-out on `rescue.plans[rescue.plan]` — the heading, whether it runs along the hull, and
// the faces the body ring has to release before the attempt counts as an escape.
function usePlan(rec) {
  const p = rescue.plans[Math.min(rescue.plan, rescue.plans.length - 1)];
  rescue.phase = 'back-out';
  rescue.t0 = elapsed;
  rescue.ax = phys.x; rescue.az = phys.z;
  rescue.heading = p.a;
  rescue.straight = p.straight;
  rescue.reverse = Math.abs(wrapPi(p.a - phys.yaw)) > Math.PI / 2;
  rescue.wedged = wedgedFaces(rescue.near);
  rescue.maxStep = 0;
  Object.assign(rec, { open: +p.d.toFixed(1), plan: rescue.plan, straight: p.straight,
    reverse: rescue.reverse, heading: +p.a.toFixed(2),
    pocket: [...rescue.wedged].map(c => c.prop || c.name).slice(0, 4) });
  return p;
}

function startRescue(cause, inp) {
  rescue.near = nearSolids();
  // a pedal already down when the rescue fires is the player's own attempt, not a takeover
  rescue.heldBrake = inp.brake > 0.5;
  rescue.heldDrift = inp.drift > 0.5;
  rescue.tries++;
  // Outside the playfield there is nothing to back out of, and the back-out cannot even fail: it
  // calls itself done after 1.9 m of movement, which a rover leaning on the rampart gets for free
  // every time it is nudged off the wall. Measured — seven rescues in 60 s at r=118.4, each recorded
  // as "drove out" with 10 m of daylight behind it, and the carry never once being asked for. The
  // only exit from out there is the one a ring search can't answer, so go straight to it.
  if (Math.hypot(phys.x, phys.z) > PLAYFIELD_R) {
    rescueRec(cause).open = null;
    return escalate('outside-playfield');
  }
  if (!rescue.near.length) {
    // no prop within 26 m: this is terrain holding the wheels, so skip the drive-out
    rescueRec(cause).open = null;
    return escalate('terrain');
  }
  // Plan once, then walk the list. The detector can re-fire on the same pocket after a back-out that
  // released the hull only to catch it on the next prop over, so the cache is keyed to where it was
  // measured — more than 4 m on and the corridor it ranked is not the corridor in front of the nose.
  if (!rescue.plans.length || Math.hypot(phys.x - rescue.planX, phys.z - rescue.planZ) > 4) {
    rescue.plans = rescuePlans();
    rescue.plan = 0;
    rescue.planX = phys.x; rescue.planZ = phys.z;
  }
  const pick = usePlan(rescueRec(cause));
  // No heading has half a metre of daylight: the body ring is inside overlapping props, so there is
  // nothing to drive toward and throttle only leans on the pile. A carry is the only exit — going
  // through the back-out first just lets the collision solver throw the rover out blind.
  if (!pick.d) return escalate('buried');
  // Say what the rescue is about to do. "探测到卡死" alone is what made players report dead keys:
  // the wedge has a direction it can leave in, and the one thing that does not work is pushing
  // forward — so the correction is the message, not just the animation.
  UI.toast(pick.straight && rescue.reverse
    ? '⟲ 车头被顶死在夹缝里 — 自动倒车驶出，按 S 自己倒出来也行'
    : '⟲ 探测到卡死 — 自动脱困程序介入，倒出夹缝');
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
  // The survey belongs to the pocket, not to the run. Once the hull is free, the next wedge is a
  // different geometry and gets its own ranking.
  rescue.plans = []; rescue.plan = 0; rescue.wedged = null; rescue.straight = false;
  if (out === 'drove out' || out === 'carried') rescue.tries = 0;
  rescue.markT = 0; rescue.stillT = 0;
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
  // positive steer rotates yaw downwards, so closing a positive error takes a negative pedal.
  // Except on an along-the-hull plan: steering there is the failure. A wedge pins the hull so hard
  // that physics.js's speed-scaled turn authority cannot rotate it, so the steer pedal buys scrub
  // instead of heading — the drive grinds sideways against the faces it is trying to leave.
  cmd.steer = rescue.straight ? 0
    : Math.abs(inp.steer) > 0.25 ? inp.steer : -Math.sign(err) * Math.min(1, Math.abs(err) * 1.6);
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

// The detector's bar is the report's own sentence — throttle buried, the hull going nowhere, for over
// two seconds — so the game can never claim it recovered something the audit would not still file as
// a deadlock, and never steal the wheel from a rover that is driving. See `STALL_V` for the
// measurements that retired both the net-only rule and the contact rule.
function rescueWatch(inp, dt) {
  if (rescue.cool > 0) rescue.cool = Math.max(0, rescue.cool - dt);
  const push = Math.max(inp.gas, inp.brake);
  if (rescue.phase === 'back-out') {
    const moved = Math.hypot(phys.x - rescue.ax, phys.z - rescue.az);
    // An escape is the pocket letting go, not the odometer ticking over: see `outOfPocket`.
    if (moved > 1.9 && outOfPocket()) return endRescue('drove out');
    // S / Space is the "I will get out myself" gesture, and the rescue never uses either pedal,
    // so a fresh press hands the rover back inside the same frame
    if ((inp.brake > 0.5 && !rescue.heldBrake) || (inp.drift > 0.5 && !rescue.heldDrift)) {
      return endRescue('player took over');
    }
    if (elapsed - rescue.t0 > 1.8) {
      // The hull did not move, so this heading is spent — but the survey found up to sixteen of
      // them, and a wedge usually has one working exit the daylight ranking did not put first.
      // Walk the list before anything is lifted; each entry is its own line in the audit trail.
      if (rescue.plan + 1 < Math.min(PLAN_TRIES, rescue.plans.length)) {
        rescue.plan++;
        usePlan(rescueRec('next-heading'));
        return;
      }
      return escalate('back-out failed');
    }
    return;
  }
  if (rescue.phase || rescue.cool > 0 || teleOpen || demoPin || photo.on || grid.dead || paused) {
    rescue.markT = 0; rescue.stillT = 0;
    return;
  }
  if (push < 0.15) { rescue.markT = 0; rescue.stillT = 0; return; }
  if (push < 0.35) return;
  // the wider window is what the record reports (`winV`, `windowNet`): how long the pedal has been
  // buried, how much ground it bought, and how fast the hull was going while it did
  if (!rescue.markT) { rescue.markT = elapsed; rescue.markX = phys.x; rescue.markZ = phys.z; rescue.markV = 0; }
  if (phys.speed > rescue.markV) rescue.markV = phys.speed;
  if (elapsed - rescue.markT >= STALL_T) { rescue.markT = elapsed; rescue.markX = phys.x; rescue.markZ = phys.z; }
  // The anchor is one sliding mark, not a tally: walking speed or a metre of ground restarts the
  // count, so what survives to `STALL_T` is a hull a buried throttle cannot move — the wedge, the
  // wall that has it nose-down, and the wheels in a hollow all read the same way, discs or no discs.
  if (!rescue.stillT || phys.speed >= STALL_V ||
      Math.hypot(phys.x - rescue.stillX, phys.z - rescue.stillZ) >= PIN_NET) {
    rescue.stillT = elapsed; rescue.stillX = phys.x; rescue.stillZ = phys.z;
  }
  if (elapsed - rescue.stillT >= STALL_T && phys.grounded) startRescue('no-net-progress', inp);
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
    UI.showInfo({ ...zone, key: 'watch', hudAction: launchWindowHold() || t('★ 已抵达观礼台 — 发射程序即将启动') });
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
      s.taken = true; s.group.visible = false; syncSiteWall(s); samplesTaken++;
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
      if (launchWindowHold()) launch.held = true;
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
  // beacon blink + night lamps (the pad's flood shafts are driven below, with the exhaust shells)
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
  // 46 → 90 is not a brightness change — with the decay fix in rover.js the beam got *dimmer*. The
  // spots used to run at decay 1.05, which barely dims with distance, so a parked rover washed the
  // whole plaza: measured 16 m down the beam at the gate channel, 3.4 % of the frame sat at 224–255
  // with 100 % of it hueless, and the paving's seams, colour and texture were gone under a flat white
  // sheet. Widening the cone made it worse (3.8 %, more area lit), softening the penumbra did nothing
  // (3.2 %); only the falloff law moved it — at decay 1.05 this intensity blows 7.7 % of the channel
  // and empties the bottom two histogram buckets entirely, at decay 2 the same frame is 0.4 %. The
  // driving image is not what pays for it: from the chase camera the two decays are 0.8 % vs 1.0 %
  // clip and 408 vs 465 per-mille mid-band. The constants are the old ones times 90/46, so the
  // night/storm mix ratio is untouched.
  if (spots) for (const sp of spots) sp.intensity = st.nightF * 90 + st.stormF * 43;
  // the lens quads must follow the beam: at full emissive in clear daylight they bloom the whole deck
  rover.lampMat.emissiveIntensity = 0.18 + Math.max(st.nightF, st.stormF * 0.7) * 1.6;
  const night = Math.max(st.nightF, st.stormF * 0.6);
  // The assets' authored emissive strips are thin tubes; at full strength under the sun they
  // alias into bright scribbles. They read as painted trim by day and only become lamps after dusk.
  // 0.42 by day still tripped the bloom threshold on the cyan fittings — a vertical flare off every
  // deck lamp in the noon frames — so the daytime drive comes down to a glow that reads as lit
  // glass without feeding the bloom; the night term rises to keep the after-dark levels identical.
  // A material may ask for a lower daytime floor via userData.dimDay (the saturated cyan studs);
  // the night end stays at the same 1.92 either way — unless it declares a ceiling of its own.
  // The shared 1.92 was tuned against the thin authored tubes in the asset packs; a wide emitter
  // (the gate's leg channels) carries a far larger solid angle at the same drive and has to be
  // capped by area, not by taste. See props.js for the measurement behind `nightCap`.
  for (const m of base.heroLights) {
    const d = m.userData?.dimDay ?? 0.26;
    const e = m.userData?.nightCap ?? 1.92;
    m.emissiveIntensity = d + night * (e - d);
  }
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
      ? input.isTouch
        ? `◈ ${t(padHere.name)} ${t('光台已就绪 — 点左下的')}「${t('✦ 传送 · MAP')}」`
        : `◈ ${t(padHere.name)} ${t('光台已就绪 — 按')} <kbd>G</kbd> ${t('跃迁')}（<kbd>M</kbd> ${t('全区地图')}）`
      : `⛔ ${t(padHere.name)} ${t('光台无电 — 复电后才能成像跃迁')}`;
  } else if (grid.target && phys.speed < 1.6 && !teleOpen) {
    teleHint.classList.remove('hidden');
    const pct = Math.round(grid.target.power * 100);
    teleHint.innerHTML = grid.battery > LINK_MIN
      ? `◈ ${t('并网中')} · ${t(grid.target.name)} <b>${pct}%</b> — ${t('保持停车直到反应桩亮起')}`
      : `⚡ ${t('电量不足')}（${Math.round(grid.battery * 100)}%）— ${t('无法并网，先回光台补电')}`;
  }
  // One call to action per frame: the pad hint already names the way in (`按 G 跃迁（M 全区地图）`), so
  // the teleport pill — which says 「✦ 传送 · MAP」 and does the same thing — steps back. It is keyed on
  // *this* hint, not on "any hint": the grid-link hint below asks the player to stay parked, and there
  // the pill is the map door rather than a duplicate. Touch keeps the pill either way — G is a keydown
  // listener (`addEventListener` above), so on a phone it is the *only* door, and the hint is worded to
  // point at it instead.
  teleHint._fab.classList.toggle('hidden', teleOpen || photo.on || (padHint && !input.isTouch));
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
  // A pool that draws in its own metres has to be told what the camera's focal length is, and the
  // driving fov animates (55 cruise, `chase.fovAdd` up to +26 on the launch track), so it is a
  // per-frame float rather than a resize-time constant. CSS px here: the shader multiplies its own
  // result by `uPixelRatio` to reach the framebuffer, so feeding it device px would double-count.
  for (const k in fx) if (fx[k].phys) fx[k].mat.uniforms.uFocal.value = camera.projectionMatrix.elements[5] * (innerHeight / 2);
  fx.smoke.update(dt, breezeX * 6, breezeZ * 6, 0);
  fx.steam.update(dt, breezeX * 8, breezeZ * 8, 0);
  // Both deck pools ride the weather too, but a third of the smoke's coupling: the deluge steam is
  // rising under its own buoyancy and the sand is a ground current, so neither gets carried as far as
  // a puff that is already aloft.
  fx.deluge.update(dt, breezeX * 2, breezeZ * 2, 0);
  fx.sandblast.update(dt, breezeX * 2, breezeZ * 2, 0);

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
      // stack is still the asset props.js authored, so the mount is what the shot list reads from.
      const F = launch.flight;
      const top = base.launchRig.h;
      const padX = base.launchPadPos.x, padZ = base.launchPadPos.z;
      const sh = launchShot(F ? F.met : 0, top);
      // One bearing for the whole sequence: the far side of the rover, so whoever is watching from the
      // deck has the pad between them and the lens rather than the lens buried in their own rover.
      const az = Math.atan2(pose.x - padX, pose.z - padZ);
      const s = Math.sin(az), cz = Math.cos(az);
      const anchor = F ? F.point(_lshot.set(0, 0, 0), sh.ref) : base.shipGroup.position;
      const aim = F ? F.point(_laim.set(0, 0, 0), sh.aim) : base.shipGroup.position;
      // The station stands `r` off the subject's own ground track, except that `pad` drags that track
      // back onto the launch mount. That pull is what keeps the deck in the bottom of the frame while
      // the booster comes down onto it, and what turns the last beat into a spectator on the pad
      // craning their neck instead of a chase cam 8 km up.
      const gx = anchor.x + (padX - anchor.x) * sh.pad;
      const gz = anchor.z + (padZ - anchor.z) * sh.pad;
      const cx = gx + s * sh.r, cz2 = gz + cz * sh.r;
      const gy = surfaceAt(cx, cz2);
      launchAir.x = cx;
      launchAir.z = cz2;
      launchAir.y = Math.min(gy + SHOT_CEIL, Math.max(gy + 6, anchor.y - sh.drop));
      launchAir.w = launchCamW;
      launchAim.copy(aim);
      chase.aim = launchAim;
      chase.aimW = launchCamW;
      // Wide where the vehicle is close. A 60° lens at 98 m makes the stack overhang the frame on
      // purpose; the same lens at 205 m is what lets the eye read that it has gone a long way.
      chase.fovAdd = 12 * launchCamW + 14 * THREE.MathUtils.clamp(1 - sh.r / 205, 0, 1);
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
    // The dust is a column a few hundred metres thick sitting on the surface, but `FogExp2` charges
    // for it at one rate no matter where the camera is. So the last beat of the launch — a spectator
    // on the pad looking up at a vehicle 8 km gone — came back as a flat field of sky colour, because
    // the model said 8 km of ground-density air was between them. Attenuate by how much column is
    // actually *under* the lens. Measured on the surface it changes nothing: AGL is ~0 and the factor
    // is 1. It has to run after `chase.update`, since the height that matters is the one the camera
    // ended the frame at, and `Environment` rewrites the density from scratch every frame anyway.
    if (launchCamW > 0.001 && scene.fog) {
      const agl = camera.position.y - surfaceAt(camera.position.x, camera.position.z);
      if (agl > 0) scene.fog.density *= Math.exp(-(agl * agl) / (DUST_SCALE_HEIGHT * DUST_SCALE_HEIGHT));
    }
  } else updatePhotoCam(dt);

  // The jet shells are posed after the camera block, not with the rest of the launch effects: their
  // extinction is computed in the shader from the fog density, and the density the frame actually
  // renders with is the height-attenuated one written just above. Reading the ground value instead
  // would snuff a 1.4 km plume out at the exact moment the camera has climbed above the dust it is
  // flying through, which is the one shot where the plume is the subject.
  if (launch.phase === 'flight' && launch.flight) {
    launchJets = launchJets || createJetPlumes(scene, base.launchRig);
    launchJets.update(launch.flight.plumes, elapsed, camera, scene.fog);
    // Same frame, same reason: the collar is extinguished by the air it is sitting in, and after the
    // split the vehicle is high enough that the height-attenuated density written above is several
    // times smaller than the ground value.
    if (stageCollars) stageCollars.update(dt, elapsed, camera, scene.fog, launch.flight, base.launchRig);
  }
  // Same reason as the shells directly above: a beam is extinguished by the air it is crossing, so it
  // has to read the density the frame actually renders with, not the ground value. `beams.js` poses
  // the shafts off the pad's own flood lenses; the only number here is how much light is in them.
  // 0.165 is measured, not chosen by eye. Two framings, each a paused frame with only this level
  // varying, and the layer's light read as a delta against the same frame with the shafts hidden:
  //   a third (0.055) — +0.27/255 of whole-frame light looking at the stack from the plaza 99 m off
  //     the pad axis, peak pixel +31. The shafts are simply not there.
  //   shipped (0.165) — that same view touches 4.1 % of its pixels at a mean +16.5/255 and +0.71
  //     whole-frame; from the deck 22 m out it lifts the frame by 7.3/255 with the booster's own
  //     panel lines still readable through the nearest shaft. Neither clips.
  //   double (0.33) — the long view survives it (peak +102, clip 0), but from the deck the shafts
  //     merge into one blue-grey veil over the vehicle's lower third, brighter than the sky behind
  //     it. The ceiling is set by standing next to the pad, not by the view across the base.
  // The dust term is deliberately smaller than the clear-air one:
  // a beam does brighten as the air carries more to scatter, but the same air is also taking the
  // light back off, and the shader's own extinction grows with the fog the storm writes.
  if (beams) {
    BEAM_TINT.copy(BEAM_CLEAN).lerp(BEAM_DUST, Math.min(1, st.stormF * 1.4));
    beams.update(elapsed, camera, scene.fog, st.nightF * (0.165 + 0.10 * st.stormF), BEAM_TINT);
  }

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

  // Shadow casters are budgeted against the lens, not the rover: the picture is what has to pay.
  if (shadowBudget) shadowBudget.update(camera.position);

  // audio — `windLoad` is the pressure the front is standing on right now: wind speed × the dust
  // fraction at the rover. It rises through `watch` before a single mote arrives, which is the
  // warning you hear with the radio off.
  audio.update(dt, {
    speed01: Math.min(1, phys.speed / 28), rpm: 0.3 + phys.enginePower * 0.7, power: phys.enginePower,
    stormF, windLoad: Math.min(1, stormField.speed / 26) * _wHere, windGust: wind.gust,
    nightF: st.nightF, camPos: camera.position,
    camFwd: camera.getWorldDirection(tmpV.set(0, 0, 1)), camUp: camera.up,
    roverPos: rover.group.position, leakActive: !leakFixed,
    // Every launch channel is gated on the flight actually running. `updateLaunch` returns early
    // outside it, so the numbers left in `launch` are whatever SECO's last frame happened to write,
    // and a drone that outlives the engine is not a quiet bug — it is the pad rumbling forever.
    launchIntensity: launch.phase === 'flight' ? launch.audioLevel : 0,
    launchThrust: launch.phase === 'flight' ? launch.audioThrust : 0,
    launchAlt: launch.phase === 'flight' ? launch.audioAlt : 0,
    launchProx: launch.audioProx,
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
  // The night term used to be −0.20, i.e. the grade got *darker* exactly when the scene's whole
  // dynamic range had moved into the shadows. Measured 2026-09-24 at four night vantages: 40.6 % and
  // 50.7 % of the plaza and street frames sat in the bottom histogram bin, and the lamp band of the
  // `cast` ruler came back null at three of the four — there was nothing bright enough in frame to
  // be the reason for the restraint. The lamps are already held by the bloom gate above, which is
  // night-aware on its own, so the exposure now gives back most of that dip.
  renderer.toneMappingExposure = 1.02 - st.nightF * 0.09 + stormF * 0.11;

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
  // A launch rumble is a filter cutoff and a gain, not a sprite anyone can photograph, so judging it
  // means reading the AudioParams the flight wrote last frame. Without this the voicing is unfalsifiable.
  sound: () => audio.ready && {
    rumbleLowpass: +audio.rumbleF.frequency.value.toFixed(1),
    rumbleTone: +audio.rumbleTone.frequency.value.toFixed(2),
    rumbleGain: +audio.rumbleG.gain.value.toFixed(4),
    toneGain: +audio.rumbleToneG.gain.value.toFixed(4),
    prox: audio._launchProx, eventAlt: Math.round(audio._lastEventAlt || 0), lastEvent: audio._lastEvent,
    channel: { level: launch.audioLevel, thrust: launch.audioThrust, alt: launch.audioAlt },
    phase: launch.phase, muted: audio.muted,
  },
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
    hold: launchWindowHold(), armed: launchArmed }),
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
  // said so or in spite of it. `total` is the mission denominator, so growth is visible in the same
  // read. `wall`/`live` are the collider half of that sentence: the discs the site owns, and how many
  // of them are in the list the solver reads right now. A buried site with `live > 0` is an invisible
  // wall; an emerged one with `live < discs` is a rock you drive through.
  sites: () => base.samples.map(s => ({
    id: s.id, at: [Math.round(s.x), Math.round(s.z)], site: siteName(s), buried: +s.buried.toFixed(3),
    seen: s.seen, taken: s.taken, visible: s.group.visible, p: +exposure(s.x, s.z).toFixed(2),
    dust: +stormField.local(s.x, s.z).toFixed(3), lens: s.lens.visible,
    wall: !!s.wallUp, live: s.discs.filter(d => base.colliders.includes(d)).length, discs: s.discs.length,
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
  // Set and hold the clock. `?demo=launch` needs this for the same reason the flight needs `dayHold`:
  // the cycle is 300 s long, so a page that sat open for four minutes before the capture is lit by a
  // sun 29 deg away from one that sat for one, and two frames of the same MET are not two views of
  // the same effect. Holding on write is the point — a pin the next frame drifts off of is not a pin.
  setDay: (v) => { if (!env) return null; env.dayT = v; env.dayHold = true; return { dayT: +env.dayT.toFixed(4), held: env.dayHold }; },
  // the field itself, not its readout: a 300 s drive needs the slab widened past the island,
  // which no phase-pinning standoff can do from outside the object
  stormRef: () => stormField,
  phys: () => phys, env: () => env, launchRef: launch,
  // The chase rig's per-frame keep-out correction. §6's composition reading needs it: a distance that
  // grew can mean "the camera design pulls back" or "the rig just dodged a lamp post", and only the
  // second one is a prop-layout bug.
  camDodge: () => chase && chase.dodge,
  camPlan: () => chase && chase.plan,
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
      // All three of these are world metres. `off` is the exception and has to say so: it is the node's
      // own position, which `fx/launch.js` writes in *stack* space, so it reads (0,0,0)-ish while the
      // mount it hangs off sits 60 m out at the pad. Comparing one against the other without that label
      // is how a correct scene got reported as a 60 m offset.
      return { y: [+b.min.y.toFixed(1), +b.max.y.toFixed(1)],
        world: v.toArray().map(n => +n.toFixed(1)),
        meshes: m, verts, off: o.position.toArray().map(n => +n.toFixed(2)), offFrame: 'stack' };
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
      floods: r.floods.length, booster: body(r.booster), upper: body(r.upper), stray };
  },
  // The pad's flood shafts and what each one is bolted to. A beam is only believable if its foot is a
  // lamp, so the falsifiable claim is right here: every `axisR` has to read the ring radius the floods
  // were cast at, and every `foot` y has to be the lens height above the pad deck. The three cones
  // this replaced were a hand-typed coordinate list and could not answer the question at all.
  // `hide` takes the shafts out of the render so the same framing can be shot with and without them —
  // which is how much of a night frame they are actually carrying. It has to be the module's own
  // `lit` flag rather than a write to `mesh.visible`: `update` derives visibility from the weather
  // every frame, so writing the mesh is undone by the very step meant to photograph the difference,
  // and the pair then compares one render against itself.
  beams: (hide = false) => {
    beams?.setLit(!hide);
    return beams?.probe(camera) ?? null;
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
        litBooster: t.litBooster, litUpper: t.litUpper,
        // Whether the return's field is actually burning, and both throttles. The whole point of the
        // burn windows is that the fire in the frame and the lamps on the panel answer to the same
        // clock, and a claim about that is only checkable if the frame carries the state out.
        bBurn: F.bBurn, thr: [+F.bThr.toFixed(2), +F.uThr.toFixed(2)], bVs: +t.bVs.toFixed(1) },
      // Stack-local, and it has to be said: `fx/launch.js` poses each body's `node.position` inside the
      // stack, which itself hangs off the mount at the pad. Anything that wants the world has to call
      // `body.at()` — comparing these against a world-space readout is a 60 m phantom.
      bodies: { frame: 'stack', booster: r3(F.plumes[0].body.node.position), ship: r3(F.plumes[1].body.node.position) },
      // Degrees off vertical, per body. A landed booster's position says nothing about whether it is
      // standing up, and the one thing that makes a parked first stage read wrong is the lean.
      lean: { booster: +(F.plumes[0].body.phi * 57.2958).toFixed(1), ship: +(F.plumes[1].body.phi * 57.2958).toFixed(1) },
      mouths: F.plumes.map(p => +p.mouth.toFixed(1)),
      // The panel's plot is drawn off `F.track`, so the claim "the curve has a booster arc in it" is a
      // claim about this. Counts and extremes rather than the samples: the arrays run to hundreds of
      // pairs, and the thing worth checking across the wire is whether the line exists and spans.
      track: { ship: F.track.ship.length / 2, booster: F.track.booster.length / 2,
        maxAlt: +F.track.maxAlt.toFixed(0), maxT: +F.track.maxT.toFixed(1),
        sep: F.track.sep && F.track.sep.map(n => +n.toFixed(1)) },
      touch: F.touch, log: F.log.map(e => [e.met.toFixed(1), e.id, e.alt, e.vel]) };
  },
  // E1's 「分层密度与视差」 as the frame actually holds it. The seeding table in fx/particles.js cannot
  // prove that clause: between birth and the photographed frame the sprites advect, fall, bounce off
  // the deck and die, so what a layer *is* is the distribution of its live sprites. This walks the
  // three storm pools' buffers and reports per live sprite — height above the deck it is over,
  // along-wind m/s, drawn device px, and the px/s it sweeps across the lens (projected at the
  // sprite's own velocity over 0.05 s, which is the instantaneous angular rate without the arc a
  // whole second of wind would bend it through). Deliberately no verdict here:
  // tools/storm-layer-probe.js judges these against a permutation null, which is exactly the
  // "one sheet of static" hypothesis the three layers were built to refute.
  stormLayers: (want = 200) => {
    if (!fx?.salt) return null;
    const cp = camera.position, dev = renderer.domElement;
    camera.updateMatrixWorld();
    const inv = camera.matrixWorldInverse, proj = camera.projectionMatrix;
    const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    // Camera space first, because that is where the shader does its arithmetic: `gl_PointSize` uses
    // the depth along the view axis (`max(-mv.z, 1)`), not the range to the lens, and a point behind
    // the camera has a negative one. Projecting such a point and differencing the pair would report
    // the sprite's own position reflected through the lens as a "drift".
    const cam = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(inv);
    const scr = v => {
      const p = v.clone().applyMatrix4(proj);
      return [(p.x * 0.5 + 0.5) * dev.width, (-p.y * 0.5 + 0.5) * dev.height];
    };
    const rows = {};
    for (const key of ['salt', 'susp', 'haze']) {
      const pool = fx[key], u = pool.mat.uniforms;
      const focal = u.uFocal.value, capPx = u.uMaxSize.value, pr = u.uPixelRatio.value, op = u.uOpacity.value;
      const nearFade = u.uNearFade.value, fadeIn = u.uFadeIn.value;
      const live = [];
      for (let i = 0; i < pool.count; i++) if (pool.life[i] < 1) live.push(i);
      // Fixed stride, not a random pick: the same frame read twice must give the same samples, or a
      // regression in the probe is indistinguishable from a regression in the storm.
      const stride = Math.max(1, Math.ceil(live.length / want));
      const m = [];
      for (let j = 0; j < live.length; j += stride) {
        const i = live[j], i3 = i * 3;
        const x = pool.pos[i3], y = pool.pos[i3 + 1], z = pool.pos[i3 + 2];
        const vx = pool.vel[i3], vy = pool.vel[i3 + 1], vz = pool.vel[i3 + 2];
        const c = cam(x, y, z), zc = -c.z;
        const d = Math.hypot(x - cp.x, y - cp.y, z - cp.z);
        const px = Math.min(pool.sizeArr[i] * focal / Math.max(zc, 1), capPx) * pr;
        const t = pool.life[i];
        // The fragment shader's own alpha at the centre of the disc, so a sprite the pass is about to
        // dissolve costs the census nothing. All three storm pools share `inner` 0.14, so the ratio
        // between their covers is exact even though this is the peak rather than the profile integral.
        const a = op * ss(nearFade * 0.3, nearFade, Math.max(zc, 1)) * (1 - t) * ss(0, fadeIn, t);
        const onLens = zc > 0;
        const p0 = onLens && scr(c), p1 = onLens && scr(cam(x + vx * 0.05, y + vy * 0.05, z + vz * 0.05));
        m.push({
          h: +(y - surfaceAt(x, z)).toFixed(3),
          va: +(vx * stormField.wx + vz * stormField.wz).toFixed(2),
          s: +pool.sizeArr[i].toFixed(2),
          px: +px.toFixed(1), a: +a.toFixed(4),
          cw: +(0.25 * Math.PI * px * px * a).toFixed(1),
          dps: p0 ? +(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 0.05).toFixed(1) : null,
          d: +d.toFixed(1), zc: +zc.toFixed(1), t: +t.toFixed(3),
        });
      }
      rows[key] = {
        alive: live.length, drawn: m.length, stride, cap: pool.count, op, focal, capPx, pr,
        nearFade, fadeIn,
        // The pool's own integration constants, printed beside the census they produced: a distribution
        // of sprite speeds only means something if the reader knows which skid law made it.
        physics: { advect: pool.advect, drag: pool.drag, grav: pool.grav, bounce: pool.bounce, skid: pool.skid, floor: !!pool.floorAt },
        m,
      };
    }
    return {
      wind: [+stormField.wx.toFixed(3), +stormField.wz.toFixed(3)],
      speed: +stormField.speed.toFixed(2), gust: +stormField.gustEnv.toFixed(3),
      amp: +stormField.amplitude.toFixed(3), cam: [cp.x, cp.y, cp.z].map(n => +n.toFixed(1)),
      frame: [dev.width, dev.height], rows,
    };
  },
  // Fills the storm's particle buffers without rendering a single frame. `__QA.step()` hands out
  // real rAF slices, so warming the pools past the longest sprite life costs one full render per
  // 1/60 s — 800 of them is minutes, and the QA rig patches `performance.now` onto its virtual
  // clock, so a probe cannot even see that coming. The dust simulation itself is plain JS
  // (`updateStorm` → `ParticlePool.update`), and this drives exactly the line the frame loop drives
  // (main.js's `updateStorm(fx, dt, camera.position, stormField, surfaceAt)`) with the field left
  // where `pinStorm` put it: the emitter's `field.local()` therefore sees one fixed finger pattern,
  // which is the steady state a layer census is supposed to describe.
  stormStep: (n = 600, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) updateStorm(fx, dt, camera.position, stormField, surfaceAt);
    return { n, dt, sim: +(n * dt).toFixed(2) };
  },
  // Which layer of the exhaust is on screen. The geometric jet and the particle pools are drawn in the
  // same tens of metres under the vehicle, so a frame that still reads as a string of pearls cannot be
  // fixed by tuning the shell until the shell is proven to be there — and the three ways it can fail
  // (never posed, too short, too faint at that range) look identical from a screenshot. `hide` takes
  // one layer out of the render so the pair of frames says which layer was doing the drawing.
  plume: (hide = null) => {
    const count = (pool) => {
      if (!pool) return 0;
      let n = 0;
      for (let i = 0; i < pool.count; i++) if (pool.life[i] < 1) n++;
      return n;
    };
    // What the particle sheath is *on screen*, read off the live pool instead of off the seeding
    // formula. A claim like "one puff is smaller than the flame it sheathes" cannot be checked against
    // the emit() arguments, because the pool multiplies every sprite's size after birth — so this walks
    // the slots that are actually alive and reports their drawn pixel size under the vertex shader's own
    // law, plus how far off the jet's axis each one sits. The window is the column itself: anything
    // outside it is the deck cloud or an older flight's leftovers, not the sheath.
    // Does the smoke sheath still read as a sheath. `pctMean` / `pctMax` answer it directly: the
    // drawn pixel size of a live puff, as a share of the drawn pixel length of the flame column it
    // wraps, over the sprites currently inside that column. Read the `lit` row — after staging, the
    // other entry's `col` and `at` are whatever the shell last held, so its window catches the
    // surviving particles at a range the eye is not looking at.
    const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    const sheath = () => {
      const F = launch.flight;
      if (!launchJets || !F) return null;
      const jets = launchJets.probe(camera), cp = camera.position, out = [];
      // The sprite's radial profile, read from the pool that owns it. Copying the shader's constants
      // into this probe is how it ended up measuring a render that no longer existed.
      const smokeInner = fx.smoke.mat.uniforms.uInner.value;
      const smokeOp = fx.smoke.mat.uniforms.uOpacity.value;
      const smokeFi = fx.smoke.mat.uniforms.uFadeIn.value;
      for (let i = 0; i < F.plumes.length; i++) {
        const p = F.plumes[i], mouth = p.pos, ax = p.axis, col = jets[i].len;
        // The column's drawn length is the ruler the puffs are measured against, so it has to be in the
        // same unit as the puff sizes — real device pixels off the camera's own projection matrix. The
        // `160` in the vertex shader is a point-sprite fudge for motes a metre across, not a focal
        // length; using it here made a 42.6 m column read as 50 px when it projects to 168, i.e. every
        // "the sheath is bigger than the flame" ratio this row produced was off by 3.3x.
        const colPx = col * camera.projectionMatrix.elements[5] * (renderer.domElement.height / 2)
          / cp.distanceTo(mouth);
        const row = { col, at: jets[i].at, colPx: +colPx.toFixed(1), lit: jets[i].visible };
        const mr = 1.30 * Math.sqrt(Math.max(1, p.engines));
        const puffs = [];
        // Which other bell sits further down this row's own axis, past its mouth. No far bound is
        // applied: the chain is sampled without one, and the contamination this exists to catch sits
        // exactly beyond the column window. While the stack is joined the two axes coincide, so the
        // along-axis order of the mouths is the only thing that tells one vehicle's exhaust from the
        // other's.
        const other = F.plumes.map((q, k) => {
          if (k === i) return null;
          const vx = q.pos.x - mouth.x, vy = q.pos.y - mouth.y, vz = q.pos.z - mouth.z;
          return { q, at: vx * ax.x + vy * ax.y + vz * ax.z,
            mr: 1.30 * Math.sqrt(Math.max(1, q.engines)) * 1.3 };
        }).filter(o => o && o.at > 0);
        // Is this sprite the neighbour's after all: another bell lies between this mouth and the sprite,
        // the sprite has left that bell's own throat, and it sits inside that bell's sheath — the same
        // radius this row's own chain is cut at, so neither vehicle gets a wider excuse than the
        // other's. The bound must be the neighbour's radius, not "as close to that axis as to this
        // one": while the stack is joined both axes are one line, that test degenerates to `d <= d`
        // and float noise decides which half of a 42 m column gets charged back — measured on the
        // fixed build at MET 20.000 as 13 claimed against 14 left in this row's chain, on a row that
        // reads lineOver 0.36 a quarter second later.
        // The along side takes the same treatment: the throat is the neighbour's mouth plane widened
        // by the sprite's own radius, not the plane itself. While the stack is joined `axisDot` reads
        // 1.0000 and the bells are collinear, so the two columns are one cylinder and the mouth order
        // is the only separator there is; measured at MET 20.02, all 62 sprites past 15 m on this row's
        // axis sat within 6 m of the *booster's* bell at that same radius from it, and some sat 0.5 m
        // above that bell because it moved after they were born. A boundary tighter than the disc it
        // judges is not something the frame can show either way.
        // Only the pearl chain is charged this way — the window's size and coverage readings below
        // still see the whole cylinder, which is what their own comments say they are measuring.
        const borrowed = (px, py, pz, along, size) => {
          for (const o of other) {
            if (along + size / 2 <= o.at) continue;
            const q = o.q;
            const dx = px - q.pos.x, dy = py - q.pos.y, dz = pz - q.pos.z;
            const al2 = dx * q.axis.x + dy * q.axis.y + dz * q.axis.z;
            if (al2 < -size / 2) continue;
            if (Math.hypot(dx - q.axis.x * al2, dy - q.axis.y * al2, dz - q.axis.z * al2) <= o.mr) return true;
          }
          return false;
        };
        for (const key of ['flame', 'smoke']) {
          const pool = fx[key], u = pool.mat.uniforms, cap = u.uMaxSize.value, pr = u.uPixelRatio.value;
          // Same rule as the alpha envelope: the focal comes from the uniform, because a pool can be
          // drawing in its own metres while a copied `160` still reports it 5.2x too small.
          const focal = u.uFocal.value;
          // The alpha envelope has to come from the pool's own uniforms. A hardcoded copy of the shader
          // is how this probe ended up disagreeing with the frame it was measuring.
          const fi = u.uFadeIn.value, op = u.uOpacity.value;
          let n = 0, pxSum = 0, pxMax = 0, rrSum = 0, rrMax = 0, alSum = 0, aReach = -Infinity, stolen = 0;
          const line = [], sizes = [], lineIn = [];
          for (let s = 0; s < pool.count; s++) {
            if (pool.life[s] >= 1) continue;
            const i3 = s * 3;
            const vx = pool.pos[i3] - mouth.x, vy = pool.pos[i3 + 1] - mouth.y, vz = pool.pos[i3 + 2] - mouth.z;
            const along = vx * ax.x + vy * ax.y + vz * ax.z;
            const rr = Math.hypot(vx - ax.x * along, vy - ax.y * along, vz - ax.z * along);
            // `aReach` is the one reading taken from *outside* the window below. The window's far bound
            // is 1.8 columns, and the sprite fall-behind this ruler exists to measure starts at about
            // that much, so a max clipped by the window would pin at the clip and read as a pass — an
            // instrument reporting its own blind spot. Only the along-axis reach is sampled this
            // broadly; the pixel sizes and coverage stay inside the column they are ratios against.
            if (rr <= col && along > -2) {
              if (along > aReach) aReach = along;
              // The pearl line is collected from the same outside-the-window sample: the chain this
              // measures is the part that hangs *past* the column's tip, so a windowed sample would
              // report a clean line for the only stretch that is visibly dotted.
              if (key === 'flame' && rr <= mr * 1.3) {
                if (borrowed(pool.pos[i3], pool.pos[i3 + 1], pool.pos[i3 + 2], along,
                  pool.sizeArr[s])) stolen++;
                else {
                  line.push(along); sizes.push(pool.sizeArr[s]);
                  if (along <= col * 1.8) lineIn.push(along);
                }
              }
              if (along > col * 1.8) continue;
            } else continue;
            const d = Math.hypot(pool.pos[i3] - cp.x, pool.pos[i3 + 1] - cp.y, pool.pos[i3 + 2] - cp.z);
            const px = Math.min(pool.sizeArr[s] * focal / d, cap) * pr;
            n++; pxSum += px; rrSum += rr; alSum += along;
            if (px > pxMax) pxMax = px;
            if (rr > rrMax) rrMax = rr;
            if (key === 'smoke') {
              const t = pool.life[s];
              puffs.push({ along, rr, size: pool.sizeArr[s], a: op * (1 - t) * ss(0, fi, t) });
            }
          }
          // Is this pool a line or a row of dots. The spacing between neighbouring sprites is fixed by
          // whatever carries each birth point away from the bell, so the defect is measurable without
          // a camera and without a unit argument: neighbour gaps over the mean drawn diameter, all in
          // live sprite metres. The median is reported because it is *not* that reading: several
          // sprites are born at the same bell in the same frame, so at 12 births/frame the median sits
          // inside a cluster (booster MET 10: median 0.05 m, widest gap 2 m) and only the max sees the
          // chain. `beyond` counts the near-axis sprites sitting past the far window at all.
          // Which of these numbers decides is argued once, at the verdict below.
          let pearl = null;
          if (line.length > 3) {
            line.sort((a, b) => a - b);
            const gaps = [];
            for (let s = 1; s < line.length; s++) gaps.push(line[s] - line[s - 1]);
            gaps.sort((a, b) => a - b);
            const szMean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
            pearl = { ln: line.length, puff: +szMean.toFixed(2),
              beyond: line.length - lineIn.length,
              // What `borrowed` took out of the chain, and the chain itself. A reach the reader cannot
              // open is a number, not evidence: every RED this file reports has to be inspectable
              // without re-instrumenting the probe.
              stolen, line: line.map(v => +v.toFixed(1)),
              gap: +gaps[gaps.length >> 1].toFixed(2),
              gmean: +((line[line.length - 1] - line[0]) / (line.length - 1)).toFixed(2),
              gmax: +gaps[gaps.length - 1].toFixed(2) };
            pearl.dots = +(pearl.gmax / szMean).toFixed(2);
            // metres ÷ metres × pixels: the widest break, and the part of the *near-axis* chain
            // hanging past the column's tip, both on the screen.
            pearl.gmaxPx = +(pearl.gmax * colPx / col).toFixed(1);
            pearl.lineOver = +(line[line.length - 1] / col).toFixed(2);
            pearl.overPx = +(Math.max(0, line[line.length - 1] - col) * colPx / col).toFixed(1);
          }
          // The verdict, and the one condition under which this instrument is allowed to give it.
          // `lineOver` is the reach of the near-axis chain against its own column and `overPx` puts
          // that overhang on the screen, so the two together say "the flame ends past the flame".
          // `amb` is the coarse half of the condition: while a *second firing bell* sits inside this
          // row's own cylinder the window is full of the other vehicle's column. `borrowed` above is the
          // fine half, and it is the one that has to exist — it charges each sprite of the chain to
          // whichever bell it actually left, and while the stack is joined the two axes coincide, so
          // the along-axis order of the two mouths is the only thing that tells them apart. Measured on
          // the fixed build at MET 20.00: the booster's bell sat at perp 0 / along 38.6 on the ship's
          // axis with `power` already 0, this row's own chain was 25 sprites reaching 7.8 m, and the 34
          // sprites out past 38 m were the booster's 42.6 m column still fading — a firing-bell test
          // cannot see a trail that outlives its engine by a quarter second, so `amb` alone left that
          // row on trial for its neighbour's flame. `amb` is reported rather than applied silently for
          // the same reason the rest of this probe reports what it cannot see.
          // What the gate is *not*: `dots` (widest of ~25 gaps ÷ a puff) cannot decide anything,
          // because for sprites born at a steady rate that statistic sits near 1 even for a continuum
          // — the fixed build's MET 20-24 rows read `gmean` 0.20-0.25 of a puff against `dots`
          // 0.86-1.20, and the broken build's against `dots` 1.35-5.97: the ranges meet at 1, where
          // the reach test is at 0.4 against 1.5.
          // The gate's polarity is measured rather than assumed, on the whole flight and in fast mode
          // (`tools/cdp-plume-pearl.mjs`). Fixed build: 68 rows sampled, 14 read `amb`, 0 fail, and
          // the upper-stage seconds this exists for (MET 20-24, plume #1, `amb` false) reach
          // lineOver 0.38-0.45 at overPx 0 — a cone ending inside itself. With `_pu` zeroed (the
          // pre-fix seeding) the same 68 rows give 22 named failures, all on plume #1, lineOver
          // 1.50-5.28 at overPx 3.9-50.3. Nothing about the two states overlaps, which is why a reach,
          // and not a spacing statistic, is what decides. The second reading is also what bounds the
          // slack `borrowed` is given: the broken build's far reach still walks past the neighbour's
          // bell and out of its own column *after* the attribution runs, so the sprite-radius give is
          // not a threshold wide enough to hand the verdict away.
          const amb = F.plumes.some((q, k) => {
            if (k === i || q.power <= 0) return false;
            const vx = q.pos.x - mouth.x, vy = q.pos.y - mouth.y, vz = q.pos.z - mouth.z;
            const al = vx * ax.x + vy * ax.y + vz * ax.z;
            return al > -2 && Math.hypot(vx - ax.x * al, vy - ax.y * al, vz - ax.z * al) < col;
          });
          const fail = !!pearl && !amb && pearl.lineOver > 1 && pearl.overPx >= 3;
          row[key] = n ? { n, pctMean: +(100 * pxSum / n / colPx).toFixed(0),
            pctMax: +(100 * pxMax / colPx).toFixed(0),
            ...(pearl || {}),
            amb, fail,
            pxMean: +(pxSum / n).toFixed(1), pxMax: +pxMax.toFixed(1),
            rrMean: +(rrSum / n).toFixed(1), rrMax: +rrMax.toFixed(1),
            // How far down the axis anything in the column-width window reaches, in metres, against
            // the column it is supposed to be inside. A sprite born at the bell and left in still air
            // falls behind the vehicle by `speed x lifetime`, so this is the number that separates
            // "flicker on the flame" from "a string of pearls laid along the flight path" — and
            // unlike the frame it says which of the two it is at *any* speed, not only at the one
            // being screenshotted. Sampled over the wide band, so after staging it reads the other
            // vehicle's trail; `lineOver` above is the narrow-band one the verdict uses.
            aMean: +(alSum / n).toFixed(1),
            aMax: +(aReach === -Infinity ? 0 : aReach).toFixed(1),
            aOver: +(aReach === -Infinity ? 0 : aReach / col).toFixed(2) } : { n: 0, amb, fail };
        }
        // Is the sheath one envelope or a chain of dots. Peak alpha on the 0.4-mouth ring is the
        // detector that earned its keep: it caught every gap the frames showed, and the band it walks
        // comes from the seeding law itself (`y0`/`y1`) because the first 0.20 of the column is shell
        // only and past 1.12 columns the trail cannot reach — a probe that sampled those and called the
        // zeros a defect is an instrument reading its own blind spot.
        // Deleted alongside it: the *integrated* density profile and its coefficient of variation. They
        // saturate. At the ~1,800 live puffs the MET 8 frame actually carries, `1-exp(-Σa)` reads 1.00 at
        // every sample while the frame still shows a dotted line, so the number cannot gate anything and
        // a passing reading from it is not evidence.
        // The gate is a share of the pool's own brightest possible pixel, not an absolute alpha.
        // `q.a` peaks at `opacity · (1 - fadeIn)`, so lowering either constant moves the ceiling: at
        // 0.62 / 0.14 the peak was 0.53 and the old absolute 0.35 meant "two thirds lit", but after
        // the opacity went to 0.26 the ceiling is 0.22 and a 0.35 gate sits above every value the pool
        // can produce — `hole` then pinned at its maximum on a frame that was merely dimmer, not
        // emptier, and the detector was measuring the opacity constant instead of the coverage.
        const ceil = smokeOp * (1 - smokeFi);
        const cover = (filt, y0, y1, r0) => {
          const N = 24, R0 = r0;
          const peak = [];
          for (let k = 0; k < N; k++) {
            const y = y0 + (y1 - y0) * (k + 0.5) / N;
            let m = 0;
            for (const q of puffs) {
              if (!filt(q)) continue;
              const d = Math.hypot(q.rr - R0, q.along - y) / q.size;
              if (d >= 0.5) continue;
              const h = q.a * ss(0.5, smokeInner, d);
              if (h > m) m = h;
            }
            peak.push(m / ceil);
          }
          let hole = 0, run = 0;
          for (const v of peak) { if (v >= 0.66) run = 0; else if (++run > hole) hole = run; }
          return { pmin: +Math.min(...peak).toFixed(2),
            hole: +(hole / N * (y1 - y0) / col).toFixed(2) };
        };
        // The deck cloud only exists inside the jet window while the stack is still on the pad; once the
        // vehicle has climbed, every sprite from the trench is at `along` ≈ −70 and the ring's own filters
        // discard it. Reporting that as zero coverage would be an instrument reading its own blind spot.
        // Each row's ring sits where that row's mass actually is: the sheath hugs the axis, so it samples
        // at 0.4 mouths, while the apron's own filter throws away everything inside 1.4 mouths, so it
        // samples at that edge rather than asking for light at a radius the row had excluded.
        // Read the apron row with care: it is NOT evidence about the pad cloud. Moving the ring from
        // 0.4 to 1.4 mouths on a frame carrying 1,394 live puffs moved `hole` only 0.60 → 0.55, which is
        // what ruled the ring out as the cause. The rest of it is the band: `cover` sweeps `along`, the
        // axis the jet points down, while the apron is a skirt lying on the deck out to `blast`, so
        // above ~8 m of `along` there is no apron to find and every one of those samples is the
        // instrument walking past empty sky. The pad is judged on its frame, not on this row.
        row.cover = {
          trail: cover((q) => q.rr <= mr * 1.4, col * 0.20, col * 1.12, mr * 0.4),
          apron: F.met < 5 ? cover((q) => q.rr > mr * 1.4, 0, col * 0.6, mr * 1.4) : null,
          mr: +mr.toFixed(2),
        };
        out.push(row);
      }
      return out;
    };
    const DECK_POOLS = ['flame', 'smoke', 'deluge', 'sandblast'];
    for (const k of DECK_POOLS) if (fx?.[k]) fx[k].points.visible = hide !== k;
    // The deck census: what the four pools actually hold *right now*, in metres and device pixels,
    // and how close each sprite comes to the lens. Two things make this a reading rather than a
    // re-derivation of the seeding code. `sizeArr` is the grown size (the CPU update rewrites it every
    // frame), so the quantiles are the multi-scale contract's test: a single-scale fill cannot produce
    // a spread. And the pixel size comes from the vertex shader's own uniforms (`uFocal`, `uMaxSize`,
    // `uPixelRatio`) against each sprite's real distance, so the ceiling — no puff large enough to
    // veil the frame — is checkable without a screenshot.
    const deck = {};
    for (const k of DECK_POOLS) {
      const pool = fx?.[k];
      if (!pool) { deck[k] = { n: 0 }; continue; }
      const u = pool.mat.uniforms, focal = u.uFocal.value, cap = u.uMaxSize.value, pr = u.uPixelRatio.value;
      const sz = [];
      let nearest = Infinity, lt60 = 0, pxMax = 0, yMax = -Infinity;
      for (let i = 0; i < pool.count; i++) {
        if (pool.life[i] >= 1) continue;
        const x = pool.pos[i * 3], y = pool.pos[i * 3 + 1], z = pool.pos[i * 3 + 2];
        sz.push(pool.sizeArr[i]);
        const d = Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z);
        if (d < nearest) nearest = d;
        if (d < 60) lt60++;
        pxMax = Math.max(pxMax, Math.min(pool.sizeArr[i] * focal / d, cap) * pr);
        if (y > yMax) yMax = y;
      }
      if (!sz.length) { deck[k] = { n: 0 }; continue; }
      sz.sort((a, b) => a - b);
      const q = (p) => +sz[Math.min(sz.length - 1, Math.floor(p * sz.length))].toFixed(2);
      deck[k] = {
        n: sz.length,
        size: [q(0.1), q(0.5), q(0.9), +sz[sz.length - 1].toFixed(2)],
        nearest: +nearest.toFixed(1), lt60, pxMax: +pxMax.toFixed(0), yMax: +yMax.toFixed(1),
      };
    }
    return {
      hidden: hide, jets: launchJets ? launchJets.probe(camera) : null,
      // The anchor for every row below: the deck census is meaningless without the MET it was read at,
      // because `blast`, `bank` and `sandH` all grow on that clock.
      met: launch.flight ? +launch.flight.met.toFixed(2) : null,
      alive: Object.fromEntries(DECK_POOLS.map(k => [k, count(fx?.[k])])),
      cap: Object.fromEntries(DECK_POOLS.map(k => [k, fx?.[k]?.count ?? 0])),
      deck,
      sheath: sheath(),
    };
  },
  // Is the vehicle actually in the frame the player is looking at, and how much of it is there.
  // Range alone cannot answer that: a camera that tracks the wrong point can sit 200 m from a rocket
  // and still be aimed at the ground, which is precisely what a range-only probe reported at MET 36.
  // So this reads the projection, not the distance — each body's own two ends in NDC, the angle off
  // the view axis, and the FogExp2 extinction the camera's live fog value gives at that range.
  // Per body, because after staging the "vehicle" is two things 9 km apart: a probe that spans both
  // reports the falling booster as a framing failure when it is only the weather working correctly.
  framing: () => {
    const F = launch.flight;
    if (!F) return null;
    const seam = base.launchRig.seam, top = base.launchRig.h;
    const px = renderer.domElement.height / 2;
    const body = (a, b) => {
      const pa = F.point(new THREE.Vector3(), a), pb = F.point(new THREE.Vector3(), b);
      const na = pa.clone().project(camera), nb = pb.clone().project(camera);
      const to = pa.clone().sub(camera.position), range = to.length();
      return { range: +range.toFixed(0), spanPx: +(Math.abs(nb.y - na.y) * px).toFixed(0),
        off: +(camera.getWorldDirection(new THREE.Vector3()).angleTo(to.normalize()) * 57.2958).toFixed(1),
        in: Math.abs(na.x) < 1 && Math.abs(na.y) < 1 && Math.abs(nb.x) < 1 && Math.abs(nb.y) < 1,
        erase: +(1 - Math.exp(-Math.pow(range * scene.fog.density, 2))).toFixed(3) };
    };
    return { met: +F.met.toFixed(1), alt: +F.alt.toFixed(0), camY: +camera.position.y.toFixed(0),
      fov: +camera.fov.toFixed(1), fog: +scene.fog.density.toFixed(5), w: +launchCamW.toFixed(2),
      airW: +launchAir.w.toFixed(2), sep: F.separated,
      booster: body(0.4, seam - 0.1), ship: body(seam + 0.1, top),
      // How far the separation collar has drifted from the seam it was thrown out of, in metres. Read
      // against the *booster's* own seam rather than `F.point(seam)`: that call hands a height to
      // whichever half owns it, and above the seam line that is the ship — so what it measures is the
      // stage gap opening between two vehicles (0 → 71 m across one collar's life, measured), which
      // says nothing about whether the band rides its own body or lies in the world where it was born.
      // The old world-parked ring failed the second reading: 87 m at birth, 270 m by the frame it faded.
      collar: stageCollars ? stageCollars.probe(camera, F.plumes[0].body.at(new THREE.Vector3(), seam)) : null };
  },
  // Park the real flight at a chosen mission-clock second, then hold it there. It steps the actual
  // integrator in fixed 1/60 s increments instead of writing a pose, so what a frame captures at
  // MET 22 is the state the flight flies into at MET 22 — including the guidance the booster is under
  // and the event log it has built to get there. `fly(null)` hands the clock back to wall time.
  fly: (t) => {
    if (t === null) { qaFly = null; return { held: null }; }
    if (launch.phase !== 'flight' || !launch.flight) {
      launch.phase = 'flight';
      // `startCountdown` is what normally holds the sky, and this bypasses it, so the rig that writes
      // the flight's clock has to write the sun's too.
      env.dayHold = true;
      launch.flight = createLaunch(base.launchRig, launch);
      base.launchRig.upper.visible = true;
      launch.flight.start();
    }
    const F = launch.flight;
    for (let i = 0; F.met < t && !F.done && i < 7000; i++) { F.update(1 / 60); F.drain(); }
    qaFly = t;
    const pad = base.launchPadPos;
    return { met: +F.met.toFixed(2), alt: +F.alt.toFixed(1), vel: +F.v.toFixed(1), down: +F.down.toFixed(1),
      separated: F.separated, landed: F.landed, lit: [F.litBooster, F.litUpper],
      camDist: +camera.position.distanceTo(F.shipAim).toFixed(1),
      // Where a spectator standing 40 m off the deck would actually have the vehicle, so a capture can
      // aim at the real line of sight instead of at a guess about which body is uppermost.
      aim: F.shipAim.toArray().map(n => +n.toFixed(1)),
      deck: [+pad.x.toFixed(1), +(surfaceAt(pad.x, pad.z) + 2).toFixed(1), +pad.z.toFixed(1)],
      fog: +scene.fog.density.toFixed(5) };
  },
  warp: (x, z, face, search) => warpTo(x, z, face, search ?? 8),
  // `warp` searches for a legal stance and de-penetrates, which is right for "stand me over there"
  // and useless for reproducing a pose: the wedge filed at (6.1, -59) could not be re-entered, the
  // warp landed the hull clear of the collider pair that pinned it (one attempt surfaced 80 m from
  // the target). `place` writes the pose verbatim — no search, no push-out, no rescue of its own —
  // so a reported stall can be re-driven from the frame it was filed, and the game's 2.2 s detector
  // can be watched rather than inferred from the audit's counters.
  place: (x, z, yaw = phys.yaw) => {
    phys.x = x; phys.z = z; phys.yaw = yaw;
    phys.groundY = surfaceAt(x, z); phys.y = phys.groundY + 0.46;   // RIDE, same reference as the sink metric
    phys.vx = 0; phys.vz = 0; phys.vy = 0; phys.speed = 0; phys.lateral = 0; phys.wheelAngle = 0;
    phys.pitch = 0; phys.roll = 0; phys.susp = 0; phys.suspV = 0;
    phys.grounded = true; phys.onFloor = false;
    rescue.markT = 0; rescue.stillT = 0;   // the detector's clock starts on this pose, not the last one's
    const ring = (base?.colliders || []).filter(c => c.floor === undefined
      && Math.hypot(c.x - x, c.z - z) < c.r + 1.6);
    return { pos: [+phys.x.toFixed(2), +phys.z.toFixed(2)], yaw: +phys.yaw.toFixed(3), y: +phys.y.toFixed(2),
      touching: ring.map(c => `${c.prop || c.name}@${c.x.toFixed(1)},${c.z.toFixed(1)}r${c.r.toFixed(1)}`),
      rescuePhase: rescue.phase || null };
  },
  pois: () => interactivePoints(),
  sampleList: () => (base?.samples || []).map(s => [Math.round(s.x), Math.round(s.z), !!s.taken]),
  taps: () => (base?.gridRigs || []).map(r => [r.key, +r.x.toFixed(1), +r.z.toFixed(1), +r.power.toFixed(2), !!r.online]),
  // the raw collision set — the pin/unstick audit needs to see the cylinders the physics loop reads
  colliders: () => (base?.colliders || []).map(c => [+c.x.toFixed(2), +c.z.toFixed(2), +c.r.toFixed(2), c.floor === undefined ? 0 : +c.floor.toFixed(2)]),
  solids: () => base?.colliders,
  // the site plan's own lot rectangles (props.js `lots`). A merged prop mesh has no name of its own,
  // so an exposure audit that groups by mesh name reports one giant `Mesh` bucket; the lot a stray
  // face falls inside is what names the prop it belongs to.
  lots: () => base?.lots || [],
  // the emitter's own census: how many drawn faces the authored discs did not already cover, and
  // which families the pass therefore had to stand walls up for. A non-empty `top` is the worklist —
  // each name is a prop that drew geometry without declaring it, so the real fix is a measured
  // `lot()` at its placement site, not another disc from this pass.
  solid: () => base?.solidReport || null,
  // the player's own vehicle as a scene object, so an audit can exclude it by identity: the rover
  // carries ~12 k triangles of its own, and a sweep that excludes it by proximity also hides every
  // prop standing within that radius of wherever it happens to be parked.
  roverRoot: () => rover?.group || null,
  plan: () => base?.plan ? base.plan() : null,
  path: () => qaTrace,
  // The unstick's own view: is the body ring buried right now, and what has the rescue done so far.
  // `forceUnstick` fires the state machine by hand so a verification can watch it work instead of
  // waiting 2.2 s for a wedge that may not exist.
  unstick: () => ({ phase: rescue.phase, tries: rescue.tries, cool: +rescue.cool.toFixed(2),
    plan: rescue.plan, plans: rescue.plans.length, straight: rescue.straight,
    pocket: rescue.wedged ? [...rescue.wedged].map(c => c.prop || c.name) : [],
    gap: +gapFrom(base.colliders.filter(c => c.floor === undefined), phys.x, phys.z).toFixed(2),
    window: rescue.markT ? +(elapsed - rescue.markT).toFixed(2) : null,
    windowNet: rescue.markT ? +Math.hypot(phys.x - rescue.markX, phys.z - rescue.markZ).toFixed(2) : null,
    windowMaxV: rescue.markT ? +rescue.markV.toFixed(2) : null,
    still: rescue.stillT ? +(elapsed - rescue.stillT).toFixed(2) : null,
    stillNet: rescue.stillT ? +Math.hypot(phys.x - rescue.stillX, phys.z - rescue.stillZ).toFixed(2) : null,
    stall: { v: STALL_V, t: STALL_T, net: PIN_NET },
    held: wedgedFaces(nearSolids()).size,
    guards: { teleOpen, demo: !!demoPin, photo: !!photo.on, gridDead: grid.dead, paused,
      grounded: phys.grounded, gas: +input.inp.gas.toFixed(2) },
    events: rescue.events.slice(-8) }),
  forceUnstick: () => startRescue('forced', input.inp),
  setBattery: (v) => { grid.battery = v; grid.dead = false; grid.lowWarned = false; },
  post: () => post,
  camera: () => camera,
  scene: () => scene,
  // The shadow budget, as the caster counts it currently holds. A QA reader, not a control: the
  // number that decides whether a frame fix is still there is `lit`, and it has to be readable
  // without reaching into module scope.
  shadowBudget: () => shadowBudget?.stats ?? null,
  shadowReclassify: () => shadowBudget?.classify() ?? 0,
  // Sweep the thresholds on the ruler that picked them: one page, one pinned sun, one pose.
  shadowRetune: (opts) => shadowBudget?.retune(opts) ?? 0,
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
      rescue.events.length = 0; rescue.phase = ''; rescue.cool = 0; rescue.tries = 0;
      rescue.markT = 0; rescue.stillT = 0;
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
      // `best` is the closest the hull ever came to this point while the audit drove anywhere;
      // `aimBest` is the closest it came while this point was the one being steered at, and `aimed`
      // says whether that ever happened at all. The pair is what separates the two ways a point can
      // be missing from the map: a road that stops short of it (`aimed`, big `aimBest`) and a clock
      // that ran out before the tour got there (`!aimed`). Collapsing them into one number made a
      // five-minute run report 43/46 with no way to tell which of the three were walls.
      for (const p of spots) {
        p.best = 1e9; p.bestAt = null; p.aimBest = 1e9; p.aimed = false;
        p.dwell = 0; p.retried = false; armLap(p);
      }
      const route = [];
      let at = [phys.x, phys.z];
      const pending = spots.slice();
      while (pending.length) {
        pending.sort((a, b) => Math.hypot(a.x - at[0], a.z - at[1]) - Math.hypot(b.x - at[0], b.z - at[1]));
        const nxt = pending.shift();
        route.push(nxt); at = [nxt.x, nxt.z];
      }
      // Greedy nearest-neighbour leaves crossings in the walk, and on a fixed five-minute budget a
      // crossing is not a rounding error — it is a waypoint the clock never reaches. The run this was
      // written for drove 1677 m and covered 43 of 46 points; the three it did not are named by
      // `coverage.*Missing` below, with `never aimed at` on each one that the tour never even steered
      // for. Untangling the walk (2-opt over the open path, start pinned to the spawn) is the
      // difference between the audit proving the map is covered and it running out of clock.
      const seg = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
      const spawn = { x: phys.x, z: phys.z };
      const tourLen = list => list.reduce((m, p, i) => m + seg(i ? list[i - 1] : spawn, p), 0);
      const nnMetres = tourLen(route);
      for (let swept = true, pass = 0; swept && pass < 30; pass++) {
        swept = false;
        for (let i = -1; i + 2 < route.length; i++) {
          for (let j = i + 2; j + 1 < route.length; j++) {
            const a = i < 0 ? spawn : route[i], b = route[i + 1], c = route[j], d = route[j + 1];
            if (seg(a, c) + seg(b, d) + 1e-6 >= seg(a, b) + seg(c, d)) continue;
            const turn = route.slice(i + 1, j + 1).reverse();
            route.splice(i + 1, turn.length, ...turn);
            swept = true;
          }
        }
      }
      const tourMetres = tourLen(route);

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
        tourMetres, nnMetres,
        wp: 0, dist: 0, t: 0, gated: 0, peakSpeed: 0, retries: 0,
        prevPos: [phys.x, phys.z], prevDead: grid.dead,
        markT: 0, markX: phys.x, markZ: phys.z, recoverUntil: -9, holdUntil: -9, aim: phys.yaw, turnDir: 0,
        // Is the *current* 4 s window still a window in which the throttle never lifted? See the
        // stall bar below. `glimpses` counts the near-misses the bar refused to file, and
        // `glimpseLog` names the lever that refused them — a count alone is a reading with no address.
        windowClean: true, glimpses: 0, windowBreak: null, glimpseLog: [],
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
    // The stall window is re-anchored at every chunk start. The real animation loop keeps driving
    // between chunks — the harness needs seconds to think, and the pedals are released for exactly
    // that reason — so a window that straddled a seam would be scored on ground the audit never
    // watched. Losing up to 4 s of window per seam is cheap: a 100 s chunk holds twenty-four of them,
    // and a genuine wedge files on the next one.
    s.markT = s.t; s.markX = phys.x; s.markZ = phys.z; s.windowClean = true;
    // Re-anchor the odometer too. The rover coasts while the harness thinks between chunks, and a
    // 1.2 s coast off a 7 m/s entry covered 8.2 m — which the hop test then filed as a teleport the
    // sim never performed (measured: one "teleport 8.2m@50s" at exactly a chunk seam, with the cell
    // at 0.717 and grid.dead false, i.e. nothing that could have teleported anything). A seam is the
    // same kind of seam as the stall window's.
    s.prevPos = [phys.x, phys.z];
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
      // A stall is a *continuous* condition, so the window that measures one has to be continuous
      // too. The bar used to test the throttle on the filing frame alone, and every other lever the
      // audit owns moves that frame: the whisker planner creeps a final approach at gas 0.35, the
      // audit's own 1.4 s back-out (`recovering`) and its parks (`holding`) take the foot off the
      // pedal, and the pedals are released outright between chunks. The detector the player actually
      // depends on, `rescueWatch`, erases its clock whenever push < 0.15 — so a window threaded
      // through a recovery files `stalls: 1, rescues: 0`, a reading that cannot tell a broken unstick
      // from a test that measured its own brake lights. Now only an unbroken window files, and the
      // near-misses it refuses are counted, so tightening the bar cannot hide anything.
      const breakWhy = throttle <= 0.4 ? `gas ${throttle.toFixed(2)}`
                     : recovering ? 'audit back-out' : holding ? 'audit park'
                     : grid.dead ? 'battery dead' : null;
      if (breakWhy) { s.windowClean = false; if (s.windowBreak === null) s.windowBreak = breakWhy; }
      if (s.t - s.markT >= 4) {
        const prog = Math.hypot(phys.x - s.markX, phys.z - s.markZ);
        if (prog < 1.5) {
          // A refused window is not evidence of nothing — it is a near-miss the bar could not
          // adjudicate, so it stays in the report where a 0 would otherwise read as "never happened".
          // And it names the lever that refused it: "the ground did not move for 4 s, but a park was
          // inside the window" only answers the next question if the park has a name and a time.
          if (!s.windowClean && throttle > 0.4 && !grid.dead) {
            s.glimpses++;
            if (s.glimpseLog.length < 6) s.glimpseLog.push({
              t: +s.t.toFixed(1), broke: s.windowBreak, wp: tgt.name,
              pos: [+phys.x.toFixed(1), +phys.z.toFixed(1)], metresIn4s: +prog.toFixed(2),
              speed: +phys.speed.toFixed(2), gas: +throttle.toFixed(2), y: +phys.y.toFixed(2),
              grounded: phys.grounded, battery: +grid.battery.toFixed(3), touching: touched() });
          }
        }
        if (prog < 1.5 && s.windowClean) {
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
                        teleOpen, demoPin: !!demoPin,
                        // The unstick's own reading at the instant the audit files. "Stuck" is one
                        // condition and two implementations of it (the audit's 4 s net bar, the
                        // rescue's 2.2 s net bar), and a stall the game leaves unrescued is only a
                        // defect if the two disagree about the *same* frames. Without this the
                        // report says `stalls: 1, rescues: 0` and the next question — did the rover
                        // ever sit still with the throttle buried, or did the audit's own 1.4 s
                        // brake-out cancel its net progress while the wheels were free? — has no
                        // answer in the data.
                        unstick: { win: rescue.markT ? +(elapsed - rescue.markT).toFixed(2) : null,
                          net: rescue.markT ? +Math.hypot(phys.x - rescue.markX, phys.z - rescue.markZ).toFixed(2) : null,
                          winV: rescue.markT ? +rescue.markV.toFixed(2) : null,
                          push: +Math.max(input.inp.gas, input.inp.brake).toFixed(2),
                          phase: rescue.phase, cool: +rescue.cool.toFixed(2) } });
          s.recoverUntil = s.t + 1.4;
        }
        s.markT = s.t; s.markX = phys.x; s.markZ = phys.z; s.windowClean = true;
        // the new window starts on this very frame, so it inherits this frame's lever rather than
        // getting a free clean second that the next frame would have to spend again
        s.windowBreak = breakWhy;
      }
      if (s.runFrames++ % 120 === 0) s.samples.push([+s.t.toFixed(0), +phys.speed.toFixed(1), s.wp,
        Math.round(Math.hypot(phys.x - tgt.x, phys.z - tgt.z)),
        Math.round(Math.atan2(tgt.x - phys.x, tgt.z - phys.z) * 57.3),
        Math.round(phys.yaw * 57.3), Math.round(s.aim * 57.3),
        Math.round(rangeOf(phys.x, phys.z, Math.atan2(tgt.x - phys.x, tgt.z - phys.z))),
        +input.inp.gas.toFixed(2), +input.inp.steer.toFixed(2)]);
      // "Reached" is the game's own trigger radius, not "came vaguely near": a light pad needs 3.9 m
      // and a sample 4.2 m. A point inside that circle for one frame at 14 m/s is on the road but not
      // worked, and the report says so itself — `dwell` is the seconds spent inside the circle below
      // walking speed, which is the only speed at which the game offers the pad prompt or the lift.
      // A point the driver cannot line up is abandoned after GRACE seconds — it then shows in the
      // report as a miss with its closest approach, instead of stalling the rest of the route.
      const dT = Math.hypot(phys.x - tgt.x, phys.z - tgt.z);
      tgt.aimed = true;
      if (dT < tgt.aimBest) tgt.aimBest = dT;
      if (dT < tgt.lapBest) tgt.lapBest = dT;
      if (tgt.since === null) tgt.since = s.t;
      // Every point is measured on every frame, not only the one being steered at: the hull coming
      // within a pad's own circle is the physical fact the acceptance bar is made of, and it happens
      // whether or not the tour happened to name that point next. `aimed`/`aimBest` above hold the
      // separate, stronger claim that the audit drove to it on purpose.
      for (const p of s.spots) {
        const d = Math.hypot(phys.x - p.x, phys.z - p.z);
        if (d < p.best) { p.best = d; p.bestAt = [+phys.x.toFixed(1), +phys.z.toFixed(1)]; }
        if (d > p.r) continue;
        s.visited.add(p.name);
        // Dwell is the second half of the proof. Touching a circle for one frame at 14 m/s is not a
        // stop the player can act on — the game only offers the pad prompt and the link below walking
        // speed — so every point gets its own seconds spent inside its radius while slow enough.
        if (phys.speed < 2.5) p.dwell += dt;
      }
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
    // D1's acceptance bar reads this block: every interactive point, the closest the hull ever came,
    // against the radius that point actually needs. `laps` counts *driven* laps: the arrival state is
    // re-armed at every recycle, so a lap is 46 points steered to, not 46 indices skipped.
    //
    // A4's line is "covers all six districts and every street", and a bare fraction cannot be signed
    // off — the bar needs the names, and it needs the reason. A district counts as covered when the
    // run stood on both its light pad and its grid tap. A missing point is labelled `aimed, closest
    // X` when the tour really did steer at it and the road stopped short, and `never aimed` when the
    // clock ran out first. Those two read the same in a count and are entirely different defects.
    const pois = s.spots.filter(p => p.kind !== 'street');
    const streets = s.spots.filter(p => p.kind === 'street');
    const inReach = p => p.best <= p.r;
    const hit = pois.filter(inReach).length;
    const why = p => `${p.name} ${p.best === 1e9 ? 'never-driven' : p.best.toFixed(1) + '/' + p.r + 'm'}` +
                     (p.aimed ? ` aimed, closest-while-aimed ${p.aimBest === 1e9 ? '–' : p.aimBest.toFixed(1)}m`
                              : ' never aimed at');
    const zoneKeys = pois.filter(p => p.kind === 'pad').map(p => p.name.slice(4));
    const zoneOff = zoneKeys.filter(k => !(s.visited.has(`pad:${k}`) && s.visited.has(`tap:${k}`)));
    return { done, simSeconds: +s.t.toFixed(1), metres: Math.round(s.dist), laps: s.laps,
             frames: s.runFrames, retries: s.retries,
             coverage: {
               zones: `${zoneKeys.length - zoneOff.length}/${zoneKeys.length}`, zonesMissing: zoneOff,
               streets: `${streets.filter(inReach).length}/${streets.length}`,
               streetsMissing: streets.filter(p => !inReach(p)).map(why),
               points: `${hit}/${pois.length}`,
               pointsMissing: pois.filter(p => !inReach(p)).map(why),
               tourMetres: Math.round(s.tourMetres), greedyMetres: Math.round(s.nnMetres),
               driven: s.wp, of: s.route.length },
             connectivity: { points: pois.length, touched: hit,
               trace: s.trace.length,
               detail: pois.map(p => `${p.name} ${p.best === 1e9 ? 'never' : p.best.toFixed(1)}/${p.r}m` +
                 ` dwell${(p.dwell || 0).toFixed(1)}s${p.retried ? ' retried' : ''} parkΔ` +
                 (p.park ? Math.hypot(p.park.x - p.x, p.park.z - p.z).toFixed(1) : 'none') +
                 `${inReach(p) ? '' : ' ✕@' + (p.bestAt || []).join(',') + '→park' + Object.values(p.park || []).join(',')}`) },
             mps: s.t > 0 ? +(s.dist / s.t).toFixed(2) : 0, peakSpeed: +s.peakSpeed.toFixed(1),
             weather: { stormMax: +s.stormMax.toFixed(2), windMax: +s.windMax.toFixed(1),
               stormPct: Math.round(100 * s.stormFrames / Math.max(1, s.runFrames)) },
             reached: [...s.visited], of: s.route.length,
             stuckPockets: stalls.length,
             stuckFrames: stalls.reduce((a, b) => a + b.n, 0),
             // Near-misses the continuous-window bar refused: the ground did not move for 4 s, but a
             // crawl, a park or one of the audit's own brake-outs was inside the window, so it proves
             // nothing about a wedge. Non-zero with zero pockets is the honest "look here next" flag.
             stallGlimpses: s.glimpses,
             glimpseDetail: s.glimpseLog,
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
    // How much hull daylight makes a mouth driveable is `MOUTH`, in src/world/plan.js — the file that
    // also owns `CORRIDOR`, because the two have to be read against each other: CORRIDOR is 2*BODY_R,
    // so a pair that merely clears it leaves the hull no daylight at all, and the placement rules that
    // lay runs of posts need the same number this scan judges seams by. A second copy here would be a
    // second host for a number whose whole job is to be agreed about.
    // A seam is a joint between two *different* structures that is too narrow to drive through and
    // too wide to read as a wall. The body's stances against such a pair touch both faces at once,
    // so the only way out of the bay is a reverse along the mouth's axis — which a driver arriving
    // crooked does not have. The bar used to stop at 2*CLEAR of raw gap, and that is the exact
    // arithmetic the leak cordon slipped through: ten hazard stakes 3.39 m apart each got an emitted
    // r 0.05 disc, every pair read `gap 3.29 ≥ CORRIDOR` and so was legal ground to the placement
    // rules, while 3.29/2 − 1.6 = 0.045 m of daylight made the ring a closed invisible fence. Under
    // the old bar the pair was excluded from the seam list *because* it passed the corridor, which
    // is how a scan reads green and a soak spends 56 s pinned in one place.
    const seamCand = new Map();
    const found = new Map();
    for (let i = 0; i < solids.length; i++) {
      const a = solids[i];
      for (let j = i + 1; j < solids.length; j++) {
        const b = solids[j];
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
        if (d > a.r + b.r + SLOT) continue;
        const gap = d - a.r - b.r;
        if (gap >= SLOT) continue;
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const ux = -dz / d, uz = dx / d;
        // Whether a pair admits the hull is settled by geometry, not by the width measured along the
        // line of centres. A gap under 2*CLEAR still leaves crescents *beside* the axis where a body
        // touches both faces, and the acceptance soak used one at 03:21: 3.15 m between the spaceport
        // gate and ring-315, nose in, reverse blocked because the arrival heading was 76° off the
        // mouth's axis, and only the rescue's carry got it out. The old `gap < 2*CLEAR ⇒ the rover
        // cannot get in, so it cannot be a pocket` inference missed exactly that stance — and the
        // first fix for it, sampling probes along the perpendicular, over-reported, because a probe
        // 3 m off the axis finds daylight in open ground that has nothing to do with the pinch. The
        // exact statement: the hull's centre must clear each face by CLEAR, so it must lie outside
        // both inflated circles (r + CLEAR each). Those cross iff |ra−rb| ≤ d ≤ ra+rb, and where
        // they cross is precisely the stance that touches both faces.
        const ra = a.r + CLEAR, rb = b.r + CLEAR;
        const mouth = gap / 2 - CLEAR;      // hull daylight along the line of centres
        let stance = null, pinch = 0;
        if (gap > 2 * CLEAR) { stance = [mx, mz]; pinch = 2 * mouth; }  // axis stands free: both faces bind equally there
        else if (d < Math.abs(ra - rb)) continue;  // one disc shadows the other: there is no pinch
        else {
          // The pair's cusp: where the hull touches both faces at once. It is where the pocket is,
          // but a third solid can cover it — which is exactly why this joint resisted two rounds of
          // analysis. So the stance kept is the nearest *standable* point that still has both faces
          // binding, chosen by minimising the two slacks over a 1.5 m neighbourhood of the cusp.
          const t = (d * d + ra * ra - rb * rb) / (2 * d);
          const h = Math.sqrt(Math.max(0, ra * ra - t * t));
          const cx = a.x + dx * (t / d), cz = a.z + dz * (t / d);
          for (const sgn of [1, -1]) for (let rr = 0; rr <= 1.5; rr += 0.3) {
            for (let k = 0; k < (rr ? 8 : 1); k++) {
              const px = cx + (ux * h + Math.cos(k * Math.PI / 4) * rr) * sgn;
              const pz = cz + (uz * h + Math.sin(k * Math.PI / 4) * rr) * sgn;
              const fa = Math.hypot(px - a.x, pz - a.z) - a.r - CLEAR;
              const fb = Math.hypot(px - b.x, pz - b.z) - b.r - CLEAR;
              if (fa < 0 || fb < 0 || clearAt(px, pz) < 0) continue;
              if (!stance || fa + fb < pinch) { stance = [px, pz]; pinch = fa + fb; }
            }
          }
        }
        if (!stance) continue;
        // Two discs of ONE structure is a corner, not a joint — the `#n` suffix counts the footprint
        // discs a sign board or a substation is laid out with. A seam is where two *structures* meet.
        const root = c => cname(c).replace(/#\d+$/, '');
        if (gap > 0 && mouth < MOUTH && root(a) !== root(b)) {
          const key = root(a) + '|' + root(b) + '|' + Math.round(mx / 4) + ':' + Math.round(mz / 4);
          const prev = seamCand.get(key);
          const e = { a: cname(a), b: cname(b), gap: +gap.toFixed(2),
            daylight: +mouth.toFixed(2),
            slack: +pinch.toFixed(2),
            at: [Math.round(stance[0] * 10) / 10, Math.round(stance[1] * 10) / 10],
            axis: [+ux.toFixed(3), +uz.toFixed(3)] };
          if (!prev || e.gap < prev.gap) seamCand.set(key, e);
        }
        const key = Math.round(mx / 4) + ':' + Math.round(mz / 4);
        const prev = found.get(key);
        if (prev && gap >= prev.gap) continue;
        // naming what closes the end is the difference between re-siting one prop and guessing at three
        const capAt = (x, z) => { let best = 1e9, hit = null; scanDiscs(x, z, CLEAR + TURN, c => {
          const dd = Math.hypot(x - c.x, z - c.z) - c.r - CLEAR; if (dd < best) { best = dd; hit = c; } });
          return hit ? `${cname(hit)} r${hit.r.toFixed(1)}` : null; };
        const run = (sgn) => {
          for (let k = 1; k <= 40; k++) {
            const px = stance[0] + ux * sgn * k, pz = stance[1] + uz * sgn * k;
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
          at: [Math.round(stance[0] * 10) / 10, Math.round(stance[1] * 10) / 10],
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
    // works out of every wedge in this world *that the rover is lined up with* — all 17 were driven
    // into and out of with the real physics on 2026-09-21, and the tightest of them (0.28 m of side
    // slack, both faces touching) still walked out under power at 9.6 m/s. The rule this replaced —
    // "tight enough that both push-out normals cancel ⇒ throttle buys nothing" — was a guess that
    // measurement falsified, so it is gone. What is left is the thing a player actually reports as
    // stuck: a long blind alley. Measured reverse speed is 3–6 m/s, so under ALLEY metres of dead
    // run the escape is a one-second tap on the brake pedal and not worth re-siting a landmark for.
    // The same 2026-09-21 experiment is what the `seams` report below exists to catch, though: its
    // premise ("reverse works out of every wedge") held for all 17 samples and did not hold for a
    // seam entered 76° off its axis, where the back-out phase failed and only the rescue's carry
    // cleared it. Length is the right bar for alleys; it is silently the wrong bar for seams.
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
    // A pocket you can never drive into is scenery, not a defect — so every candidate is tested
    // against the configuration-space BFS before it may be reported. Five cells of slack either way,
    // because the BFS quantises headings to 22.5° and positions to 2 m.
    const nearReach = (x, z) => {
      const ci = Math.round((x - x0) / CELL), cj = Math.round((z - z0) / CELL);
      for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        if (reached[i * H + j]) return true;
      }
      return false;
    };
    for (const w of wedges) {
      w.entered = nearReach(w.at[0], w.at[1]);
      w.blind = w.dead >= ALLEY ? spineBlind(w) : w.dead;
      w.trap = w.entered && w.blind >= ALLEY;
    }
    const traps = wedges.filter(w => w.trap);
    // Reachability here is the loose test on purpose. The BFS quantises positions to 2 m cells, and
    // a seam's standable crescent is narrower than a cell — the gate↔ring-315 joint that pinned the
    // soak's rover was invisible to `reached`, so a bar built on it filters out the defect class it
    // is meant to catch. What the analytic list can promise is that ground this tight exists next to
    // a drive-reached cell; whether a driver actually gets caught in it is the driven test's job.
    const seamList = [...seamCand.values()].filter(s => nearReach(s.at[0], s.at[1]))
      .sort((x, y) => y.daylight - x.daylight);
    const slivers = [];
    for (let c = 0; c < free.length; c++) if (free[c] && !reached[c]) {
      const i = (c / H) | 0, j = c % H;
      slivers.push([Math.round(GX(i)), Math.round(GZ(j))]);
    }

    // ── enclosure census: every rule above blames one mouth at a time, but a cordon is a compound
    // object — ten stakes that each pass their neighbour can still shut a room, and the room is the
    // defect. So the built area is flooded at a resolution finer than the hull (0.5 m against the 2 m
    // the reachability BFS quantises to; a 4.5 cm slit is invisible at 2 m, which is how the leak
    // ring stayed off every list while a soak rover lost 56 s inside it), using physics' own keep-out
    // — a disc's r plus CLEAR, and CLEAR is BODY_R, so this is the same wall the collision resolves
    // against rather than a second opinion of it. Any connected ground the hull may stand on but
    // nowhere pivot is a cup: you leave along the axis you arrived on, or not at all.
    const EC = 0.5;
    const EW = Math.ceil((x1 - x0) / EC) + 1, EH = Math.ceil((z1 - z0) / EC) + 1;
    const esc = new Float32Array(EW * EH);
    for (let i = 0; i < EW; i++) for (let j = 0; j < EH; j++) esc[i * EH + j] = clearAt(x0 + i * EC, z0 + j * EC);
    const cid = new Int32Array(EW * EH).fill(-1);
    const comps = [];
    // 4-neighbour, not 8: a diagonal hop would clear a corner the hull cannot pass. What the
    // orthogonal fill can still miss is the sagitta of a 0.5 m chord across a 1.6 m keep-out — under
    // 2 cm — and every pocket this reports is driven before it is called a defect.
    for (let s = 0; s < esc.length; s++) {
      if (esc[s] < 0 || cid[s] >= 0) continue;
      const id = comps.length, st = [s];
      const rec = { cells: 0, pivot: 0, maxClear: -99, at: [0, 0], wx: 1e9, ex: -1e9, wz: 1e9, ez: -1e9, edge: false, pois: [] };
      cid[s] = id;
      while (st.length) {
        const c = st.pop(), i = (c / EH) | 0, j = c % EH;
        const px = x0 + i * EC, pz = z0 + j * EC;
        rec.cells++;
        if (esc[c] >= TURN) rec.pivot++;
        if (esc[c] > rec.maxClear) { rec.maxClear = esc[c]; rec.at = [px, pz]; }
        if (px < rec.wx) rec.wx = px; if (px > rec.ex) rec.ex = px;
        if (pz < rec.wz) rec.wz = pz; if (pz > rec.ez) rec.ez = pz;
        if (i === 0 || j === 0 || i === EW - 1 || j === EH - 1) rec.edge = true;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || nj < 0 || ni >= EW || nj >= EH) continue;
          const n = ni * EH + nj;
          if (esc[n] >= 0 && cid[n] < 0) { cid[n] = id; st.push(n); }
        }
      }
      comps.push(rec);
    }
    for (const p of pois) {
      const i = Math.round((p.x - x0) / EC), j = Math.round((p.z - z0) / EC);
      if (i < 0 || j < 0 || i >= EW || j >= EH) continue;
      const c = i * EH + j;
      if (cid[c] >= 0) comps[cid[c]].pois.push(p.name);
    }
    // 10 m² is two hull lengths of standing room. Below that a no-pivot patch is the gap between a
    // prop's own foot discs, and no rover fits inside one to get stuck in. A patch holding a point of
    // interest is reported however small: the mission must not be the thing that traps you.
    const pockets = comps.filter(r => !r.edge && r.pivot === 0 && (r.cells * EC * EC >= 10 || r.pois.length))
      .map(r => ({ at: [Math.round(r.at[0] * 10) / 10, Math.round(r.at[1] * 10) / 10],
        area: Math.round(r.cells * EC * EC), maxClear: +r.maxClear.toFixed(2),
        span: [Math.round(r.ex - r.wx), Math.round(r.ez - r.wz)],
        pois: r.pois, entered: nearReach(r.at[0], r.at[1]) }))
      .sort((a, b) => b.area - a.area);

    return { cell: CELL, turn: +TURN.toFixed(2), solids: solids.length, pois: pois.length,
      grid: [W, H], configs: qt, reachedCells: reached.reduce((a, v) => a + v, 0),
      freeCells: free.reduce((a, v) => a + v, 0),
      slotCount: wedges.length, trapCount: traps.length, traps,
      slots: wedges.filter(w => !w.trap && w.entered).slice(0, 12),
      // The acceptance bar for seams is 0. Unlike traps these are not long blind alleys — the
      // gate↔ring-315 joint that swallowed the soak's rover had under 3 m of dead run either way
      // and would have passed the ALLEY bar comfortably. What made it a defect is that its only
      // exit is a reverse along an axis the arriving driver did not choose to be on.
      // Every seam is handed over, not a window of the widest ones: the driven test is the consumer
      // now, and a census truncated at 12 silently excuses the 20 joints nobody got to check.
      seamCount: seamList.length, seams: seamList,
      // Enclosed ground with nowhere to pivot, from the 0.5 m census. This is the field the leak
      // cordon would have failed at even if every one of its pairs had passed the mouth bar, because
      // a loop of legal gaps is still a room — the acceptance bar is 0 here too.
      pocketCount: pockets.length, pockets: pockets.slice(0, 12),
      census: { cell: EC, grid: [EW, EH], regions: comps.length },
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
    // A null `at`/`look` leaves the camera to the game: some framings are the camera rig's own work,
    // and the only way to check whether the launch sequence keeps the ship in frame is to shoot it
    // the way the player sees it. Same for the sun — pass null to keep whatever the sky is doing.
    let sun = null;
    if (sunAt) scene.traverse(o => { if (!sun && o.isDirectionalLight) sun = o; });
    if (sun) { sun.position.set(...sunAt); sun.target.position.set(0, 0, 0); sun.target.updateMatrixWorld(); }
    if (at) camera.position.set(...at);
    if (look) camera.lookAt(...look);
    post.composer.render();
    // Which key actually lit the frame, read off the light itself rather than from the argument list.
    // This was missing, and it cost an afternoon: the plaza's night `bin0` was filed as a regression
    // from 1 ‰ (recorded in `8d610a2`) to 23 ‰, and the two numbers are not the same sky. `shot()`
    // parks a directional light at [-150, 120, 95] aimed at the origin unless handed null, so every
    // reading taken through the default argument is a *sunlit* frame — and the vantage under test was
    // chosen for night. Measured tonight at one vantage with one set of bytes: real moon 22 ‰, forced
    // key 6 ‰, and the un-graded render underneath both 496 ‰. So the 1 ‰ baseline was never the
    // night the player sees, and the "23 ‰ of dead black" it was being compared against is sand at
    // luminance 28–31 with RGB [41.7, 28.4, 23.9] — dark and warm and lit by a gate flood 1.4 m away,
    // not black. A histogram row that cannot say which lamp produced it will keep producing findings
    // like that, so the ruler now ships its own lighting conditions with every frame.
    let key = null;
    scene.traverse(o => { if (!key && o.isDirectionalLight) key = o; });
    const keyState = key ? {
      forced: !!sunAt,
      pos: [+key.position.x.toFixed(0), +key.position.y.toFixed(0), +key.position.z.toFixed(0)],
      tgt: [+key.target.position.x.toFixed(0), +key.target.position.y.toFixed(0), +key.target.position.z.toFixed(0)],
      i: +key.intensity.toFixed(2),
    } : null;
    const cv = renderer.domElement;
    const c2 = document.createElement('canvas');
    c2.width = 160; c2.height = 100;
    const g2 = c2.getContext('2d');
    g2.drawImage(cv, 0, 0, 160, 100);
    const q = g2.getImageData(0, 0, 160, 100).data;
    // Eight buckets of 32, not ten: `>> 5` on a 0–255 luminance tops out at index 7, so a ten-wide
    // array shipped two permanent zeros and the old `clip` read exactly those. Length now says what the
    // resolution is, and `bins[7]` is the blown band.
    const bins = new Array(8).fill(0);
    for (let i = 0; i < q.length; i += 4)
      bins[(0.2126 * q[i] + 0.7152 * q[i + 1] + 0.0722 * q[i + 2]) >> 5]++;
    // `clip` used to be `bins[8]/16 + bins[9]/16`, and that was dead on arrival: the histogram above
    // buckets with `>> 5`, so the highest reachable index is 7 (224–255) and bins[8] and bins[9] are
    // empty by construction. Every frame ever accepted on "clip=0" was accepted by a ruler that cannot
    // read nonzero — including the gate close-up that this very change then measured at 3.4 % of pixels
    // blown. Count the blown band directly against a stated threshold instead of against a slot in an
    // array whose length lies about its resolution. Percent, one decimal, so it reads next to `burn`.
    let blown = 0;
    // `bins` is a luminance histogram, so a uniformly violet frame and a neutral one can score
    // identically — the "no single-hue cast" half of the acceptance check had no ruler at all and was
    // being settled by taste. This is it: mean channel values per luminance band, each divided by the
    // mean of the three, so a neutral band reads [1,1,1] and a cast one pushes its dominant channel
    // past 1.15. Banding is the point, not polish — a night frame is *supposed* to hold saturated
    // colour in the lamps, and the defect lives in the shadow band, where every fill source in
    // `world/environment.js` was independently picking a near-identical blue-violet.
    // The mean alone cannot tell two frames apart: one where every pixel in the band is a single
    // hue, and one where two opposing populations cancel in the average. Measured 2026-09-24 on the
    // dune vantage, split by rows and labelled by what the centre column raycasts there: the sky
    // rows read [1.006, 0.901, 1.093] and the regolith rows [1.269 → 1.323, 0.89, 0.83 → 0.79] —
    // cool above, warm below — and the whole-frame average came out [1.169, 0.896, 0.935], a number
    // belonging to neither surface. Averaging them even *understates* both, so the frame-average
    // goes softest exactly when a picture holds the most colour separation.
    // So the band also reports how many of its pixels are warm-dominant and how many cool-dominant.
    // A band with one hue has one share near 1; a band holding both has two, and its mean chroma
    // must not be read as "neutral" — nor, on the other side, is a warm share a cast when the warm
    // thing filling it is the ground. `8d610a2` named the defect as the base having no second hue;
    // this is the half of that check the mean could not make.
    //
    // Two controls, so the shares are known to answer rather than to sit at a half: a night frame
    // aimed straight up reads warm 0.005 / cool 0.995 (one surface, one hue, not flagged), and the
    // settlement plaza reads 0.53 / 0.47. The dune reads 0.646 / 0.353 — and its chroma holds at
    // 1.164–1.168 across a 2.4× change in the key-to-fill ratio, with the whole night fill zeroed
    // moving the ground 2.5 of its 50 levels. So the dune's red is the regolith's own albedo, which
    // no light setting can cancel, and the frame's 1.169 was the sky's cool and the sand's warm
    // averaging each other out. That is the second hue the grade was asked for, not its absence.
    const band = (lo, hi) => {
      let r = 0, g = 0, b = 0, n = 0, warm = 0, cool = 0;
      for (let i = 0; i < q.length; i += 4) {
        const y = 0.2126 * q[i] + 0.7152 * q[i + 1] + 0.0722 * q[i + 2];
        if (y < lo || y >= hi) continue;
        r += q[i]; g += q[i + 1]; b += q[i + 2]; n++;
        if (q[i] >= q[i + 1] && q[i] >= q[i + 2]) warm++;
        else if (q[i + 2] >= q[i + 1]) cool++;
      }
      // 2 % of the sample. A band thinner than that is a couple of lamp filaments, and averaging its
      // chromaticity says nothing about the frame — report the share so a reader sees what was measured.
      if (n < 160) return null;
      const m = (r + g + b) / (3 * n);
      return [+(r / n / m).toFixed(3), +(g / n / m).toFixed(3), +(b / n / m).toFixed(3),
        +(n / (q.length / 4)).toFixed(3), +(warm / n).toFixed(3), +(cool / n).toFixed(3)];
    };
    const cast = { shadow: band(40, 104), mid: band(104, 176), lamp: band(176, 256) };
    // A lamp band can average neutral for two opposite reasons: the frame genuinely holds cyan *and*
    // amber lights that cancel out, or every one of them has been bleached to white. `cast` cannot
    // tell those apart, so this counts the second case directly — blown pixels that carry no hue at
    // all. A fitting that still reads as a fitting contributes a chromatic core; one sitting far over
    // the bloom gate contributes a white disc, and the lamp stops being the thing you navigate by at
    // exactly the moment it is the only thing lit.
    // The threshold has to be the blown band, not merely "bright". The first version of this cut at
    // 200 and was proven to be measuring the wrong thing: zeroing every emissive material in the scene
    // left the count unmoved (3.4 % of the gate frame in the top bin before and after) because at 200
    // the population is the sky — a broad, dim, near-neutral surface that has no emissive in it at all.
    // A ruler that answers to the sky is worse than none, because it looks like a reading.
    let burn = 0;
    for (let i = 0; i < q.length; i += 4) {
      const r = q[i], g = q[i + 1], b = q[i + 2];
      if (0.2126 * r + 0.7152 * g + 0.0722 * b < 224) continue;
      blown++;
      if (Math.max(r, g, b) - Math.min(r, g, b) <= 12) burn++;
    }
    const clip = +(blown / (q.length / 4) * 100).toFixed(1);
    const burnPct = blown ? Math.round(burn / blown * 100) : null;
    // Lossless, deliberately. The old `toDataURL('image/jpeg', 0.85)` put an 8 px lattice in the
    // frames the acceptance check is supposed to read: measured 2026-09-24 with
    // tools/codec_control.py, the same sky straight off the canvas scores blockiness 1.00 in
    // luminance and 1.00 in R-B, and once re-encoded at that quality it scores 1.34 and 1.89 — the
    // chroma axis is where 4:2:0 does its worst damage. That lattice is what looked like programmed
    // art in the storm sky, and it tracked the codec, not the weather: the *calm* frame carried the
    // strongest version of it (1.82). A capture that manufactures a weave cannot be used to clear a
    // shader of one, so the QA rig writes PNG and the check measures the render.
    const r = await fetch('http://127.0.0.1:8123/' + name, { method: 'POST', body: cv.toDataURL('image/png') });
    return { name, status: r.status, key: keyState, bins: bins.map(b => Math.round(b / 1600 * 100)), clip, burn: +(burn / (q.length / 4) * 100).toFixed(1), burnPct, cast };
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
        // Pin the sky as well as the schedule. The cycle is 300 s, so a page left open four minutes
        // before the capture is lit by a sun 23 deg away from one opened a minute ago, and two frames
        // of the same MET stop being two views of the same effect — that is how a correct deck cloud
        // was nearly filed as a missing one. 0.76 is the band the launch gate now guarantees (dusk,
        // nightF 0.736, key down to moonlight), which is where the cloud reads as a mass.
        if (demo === 'launch') { window.__RSB.skipMissions(); window.__RSB.clearSky(); window.__RSB.setDay(0.76); warpTo(dwx + 6, dwz - 4, true); }
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
