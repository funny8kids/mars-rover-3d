// tools/cdp-subject-fraction-probe.mjs — the ruler #57 was missing: how big is the thing being filmed.
//
//   node tools/cdp-subject-fraction-probe.mjs <url> [label] [port]
//
// Why a new ruler instead of another band on `__RSB.shot()`: the histogram answers "which luminances and
// hues occupy how many pixels", never "which object those pixels are". On 2026-09-28 that gap produced a
// wrong sentence in the audit doc — a launch frame's cool shadow band was read as shaded ground, and
// opening the PNG showed no ground in any of the four captures; the cool pixels were the violet top of the
// sky gradient. The defect that survived was scale: at MET 30.0 the booster is roughly 2 % of the frame
// height. Nothing in the harness can see that, so nothing in the harness could have failed it.
//
// 口径, stated so a future reader can disagree with it rather than have to rediscover it:
//   hFrac = (maxY - minY)/2 over the subject's projected vertices — the fraction of *frame height* its
//           screen-space bounding box spans. wFrac likewise. aFrac = hFrac * wFrac.
//   A bounding box overestimates a slender vehicle (empty corners), and it is the box, not the pixels:
//   a rocket 2 % of frame height has a box of 2 %, and so does a sphere of the same extent. This is
//   deliberate — the question is "does the lens hold the subject", not "what share of pixels are metal".
//   Attribution is *discovered*, not assumed: the subject is every visible mesh whose material is one of
//   the stack's authored skins (`rocket_struct` / `rocket_skin` / `rocket_nozzle` / `rocket_burnt` /
//   `rocket_wordmark` / `rocket_glass`, the list main.js's double-sided census keeps at
//   src/world/assets.js:120-123). The matched material names and each part's ancestor path are printed
//   with the reading, so the attribution can be checked rather than trusted. Mesh *names* were the first
//   guess and returned nothing — the GLB nodes are unnamed wrappers, the materials are the labelled faces.
//   If no seed material is found the run says NO_SEED with the visible-mesh denominator instead of
//   quietly reporting zero, because a zero from an empty denominator is exactly the failure this tool
//   exists to catch.
//   The frame is the canvas, not the page: `shot()` samples `renderer.domElement`, and the capture
//   surface on this harness is wider than the canvas (RED_STARBASE_COMPLETION_AUDIT.md, 「抓帧件里那 67 %
//   的黑」), so NDC -1..1 here is the drawing buffer. Readings stay at the harness's 0.92 viewport.
//
// The ruler carries its own controls, per the discipline that a gauge which cannot move cannot fail:
//   polarity — the same frame measured with fov × 1.5 must give a *smaller* hFrac;
//   reset    — after restoring fov, hFrac must equal the primary reading bit for bit.
// Both run at every capture, so a silent no-op cannot pass as a pass.
import fs from 'node:fs';
import crypto from 'node:crypto';

const [,, url, LABEL = 'x', portStr] = process.argv;
const PORT = Number(portStr || 9333);
const DT = 1 / 60;
const STAGE = 22;
// The same four offsets the flip probe paints, so the two rulers describe the same frames. Each is
// labelled against SHOT_FADE = 2.6 (src/main.js:1542-1546): with 4 s between beats the middle 2.6 s
// around a boundary is a blend, so a capture 0.6 s after a beat is inside the previous blend.
const CAPTURES = [[0.6, 'a', 'blend'], [2.5, 'b', 'beat'], [5.0, 'c', 'blend'], [8.0, 'd', 'beat']];
const SEEDS = ['rocket_struct', 'rocket_skin', 'rocket_nozzle', 'rocket_burnt', 'rocket_burnt_tex',
  'rocket_wordmark', 'rocket_glass'];

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /qa_boot/.test(t.url))
  || list.find(t => t.type === 'page' && /^http/.test(t.url));
if (!page) { console.log('NO_PAGE_TARGET ' + JSON.stringify(list.map(t => t.url))); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown')
    console.log('[EXCEPTION] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
};
await new Promise(r => ws.onopen = r);
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'EVAL_ERROR');
  return r.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Runtime.enable');
await send('Page.enable');

// Name the bytes being measured, same self-check the flip probe runs: this page is served without cache
// headers by a persistent-profile Chrome, and a stale module reproduces the previous run exactly.
const origin = new URL(url).origin;
const MODS = ['src/main.js', 'src/fx/launch.js'];
for (const m of MODS) {
  const served = await (await fetch(`${origin}/${m}`, { cache: 'no-store' })).text();
  const h = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
  console.log(`  bytes    ${m} local=${h(fs.readFileSync(m, 'utf8'))} served=${h(served)} served_is_local=${served === fs.readFileSync(m, 'utf8')}`);
}

await send('Page.navigate', { url });
const deadline = Date.now() + 420000;
let ready = false;
while (Date.now() < deadline) {
  await sleep(1000);
  try { if (await evaluate(`!!(window.__RSB && window.__QA && __RSB.state && __RSB.state.started)`) === true) { ready = true; break; } } catch { }
}
if (!ready) { console.log('BOOT_TIMEOUT'); process.exit(2); }

console.log(`PROBE subject-fraction [${LABEL}]  port=${PORT}`);

// The measure, in-page. Matrices are refreshed explicitly because nothing renders between captures here
// (the sim is pumped by hand), and a stale matrixWorldInverse would quietly project the previous frame's
// camera pose.
const measure = (fovMul = 1) => evaluate(`(() => {
  const cam = __RSB.camera();
  if (!cam) return { err: 'NO_CAMERA' };
  // The camera is not a child of the scene in this app, so cam.parent is null; __RSB.scene() is the
  // handle main.js already publishes (src/main.js:3589) for exactly this.
  const scene = (__RSB.scene && __RSB.scene()) || cam.parent;
  if (!scene || !scene.children) return { err: 'NO_SCENE' };
  scene.updateMatrixWorld(true);
  cam.updateMatrixWorld(true);
  const fov0 = cam.fov;
  if (${fovMul} !== 1) { cam.fov = fov0 * ${fovMul}; cam.updateProjectionMatrix(); }
  const e = cam.projectionMatrix.elements, mwi = cam.matrixWorldInverse.elements;
  const SEEDS = ${JSON.stringify(SEEDS)};
  const fresh = () => ({ mnX: 1e9, mxX: -1e9, mnY: 1e9, mxY: -1e9, near: 1e9, pts: 0,
    wMnY: 1e9, wMaxY: -1e9 });
  const acc = (a) => {
    if (!a.pts || a.mxX < a.mnX) return null;
    const h = (a.mxY - a.mnY) / 2, wd = (a.mxX - a.mnX) / 2;
    return { hFrac: +h.toFixed(4), wFrac: +wd.toFixed(4), aFrac: +(h * wd).toFixed(5),
      inH: +(Math.max(0, Math.min(1, a.mxY) - Math.max(-1, a.mnY)) / 2).toFixed(3),
      inW: +(Math.max(0, Math.min(1, a.mxX) - Math.max(-1, a.mnX)) / 2).toFixed(3),
      near: +a.near.toFixed(1), worldY: [+a.wMnY.toFixed(1), +a.wMaxY.toFixed(1)], pts: a.pts };
  };
  const merge = (a, b) => { a.mnX = Math.min(a.mnX,b.mnX); a.mxX = Math.max(a.mxX,b.mxX);
    a.mnY = Math.min(a.mnY,b.mnY); a.mxY = Math.max(a.mxY,b.mxY); a.near = Math.min(a.near,b.near);
    a.wMnY = Math.min(a.wMnY,b.wMnY); a.wMaxY = Math.max(a.wMaxY,b.wMaxY); a.pts += b.pts; };
  let visible = 0, subject = 0, missed = 0, named = 0;
  const namedList = [], byRoot = new Map(), parts = [], mats = new Set();
  scene.traverse(o => {
    if (!o.isMesh || !o.visible) return;
    visible++;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    const hit = ms.map(m => m && m.name).filter(Boolean).filter(n => SEEDS.indexOf(n) >= 0);
    if (!hit.length) return;
    const at = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
    if (!at || !at.count) { missed++; return; }
    subject++;
    // Naming census runs over the FULL subject set, not the parts that survive the top-6 slice, because
    // the claim "node names cannot label a whole body" needs its own denominator to be checkable.
    if (o.name) { named++; namedList.push(o.name); }
    hit.forEach(n => mats.add(n));
    // The ancestor path is the attribution evidence printed with every reading, so a booster-vs-ship
    // claim can be checked against the scene graph instead of argued.
    const path = [];
    for (let p = o; p && p !== scene; p = p.parent) path.unshift(p.name || '(anon)');
    // Clustering is by the nearest named ancestor below the glTF wrapper, not by scene.children: every
    // instance is wrapped in a node literally named "Scene", so that name is shared and cannot separate
    // the bodies, and a box over the shared root spans the empty 650 m between them after staging — it
    // reads as a subject that is mostly nothing.
    let key = null;
    for (let p = o.parent; p && p !== scene; p = p.parent) {
      if (p.name && p.name !== 'Scene') { key = p.name; break; }
    }
    const m = o.matrixWorld.elements;
    const a = fresh();
    const step = Math.max(1, Math.floor(at.count / 64));
    for (let i = 0; i < at.count; i += step) {
      const px = at.getX(i), py = at.getY(i), pz = at.getZ(i);
      // model -> world -> view, by hand, so no temporary Vector3 is churned per vertex
      const wx = m[0]*px + m[4]*py + m[8]*pz + m[12];
      const wy = m[1]*px + m[5]*py + m[9]*pz + m[13];
      const wz = m[2]*px + m[6]*py + m[10]*pz + m[14];
      const vx = mwi[0]*wx + mwi[4]*wy + mwi[8]*wz + mwi[12];
      const vy = mwi[1]*wx + mwi[5]*wy + mwi[9]*wz + mwi[13];
      const vz = mwi[2]*wx + mwi[6]*wy + mwi[10]*wz + mwi[14];
      if (vz > -0.5) continue;
      const w = -vz;
      const nx = (e[0]*vx + e[4]*vy + e[8]*vz + e[12]) / w;
      const ny = (e[1]*vx + e[5]*vy + e[9]*vz + e[13]) / w;
      if (nx < a.mnX) a.mnX = nx; if (nx > a.mxX) a.mxX = nx;
      if (ny < a.mnY) a.mnY = ny; if (ny > a.mxY) a.mxY = ny;
      const d = Math.sqrt(vx*vx + vy*vy + vz*vz);
      if (d < a.near) a.near = d;
      if (wy < a.wMnY) a.wMnY = wy; if (wy > a.wMaxY) a.wMaxY = wy;
      a.pts++;
    }
    const one = acc(a);
    if (!one) return;
    const ckey = key || '(no named ancestor)';
    if (!byRoot.has(ckey)) byRoot.set(ckey, { n: ckey, meshes: 0, seeds: new Set(), a: fresh() });
    const g = byRoot.get(ckey);
    g.meshes++; g.seeds.add(hit[0]); merge(g.a, a);
    parts.push({ p: path.slice(-2).join('/'), ...one });
  });
  cam.fov = fov0; cam.updateProjectionMatrix();
  const clusters = [...byRoot.values()].map(g => ({ n: g.n, meshes: g.meshes,
    seeds: [...g.seeds], ...acc(g.a) })).filter(g => g.hFrac !== null);
  clusters.sort((a, b) => b.aFrac - a.aFrac);
  parts.sort((a, b) => b.aFrac - a.aFrac);
  return { err: null, fov: +fov0.toFixed(1), visible, subject, missed, named,
    namedList: namedList.sort(),
    mats: [...mats].sort(), clusters, parts: parts.slice(0, 6) };
})()`);


await evaluate(`__QA.pause(); __RSB.skipMissions(); __RSB.fly(0); __RSB.fly(null);
window.__F = 0;
window.__step = (maxMet) => {
  const R = window.__RSB;
  for (let i = 0; i < 4000; i++) {
    R.frame(${DT});
    const met = ++window.__F * ${DT};
    const f = R.flight();
    if (met >= maxMet || (f && f.done)) return { met: +met.toFixed(2), done: !!(f && f.done) };
  }
  return { met: null, done: false };
};`);

const lead = await evaluate(`__step(${(STAGE + 0.1).toFixed(2)})`);
let rc = 0;
const rows = [];
for (const [off, tag, kind] of CAPTURES) {
  const r = await evaluate(`__step(${(STAGE + off).toFixed(2)})`);
  if (r.met === null) { console.log(`  ${tag}@sep+${off}: STEP_STUCK`); rc = 1; continue; }
  const m = await measure(1);
  if (m.err) { console.log(`  ${tag}@sep+${off}: ${m.err}`); rc = 1; continue; }
  const pol = await measure(1.5);
  const back = await measure(1);
  const sub = m.clusters;
  const hMax = sub.length ? Math.max(...sub.map(g => g.hFrac)) : null;
  const hPol = pol.clusters.length ? Math.max(...pol.clusters.map(g => g.hFrac)) : null;
  const hBack = back.clusters.length ? Math.max(...back.clusters.map(g => g.hFrac)) : null;
  const polarity = hMax !== null && hPol !== null && hPol < hMax;
  const reset = JSON.stringify(back.clusters) === JSON.stringify(sub);
  if (!sub.length) {
    console.log(`  ${tag}@sep+${off}: NO_SEED — ${m.subject}/${m.visible} visible meshes carry a `
      + `rocket_* material (mats=${JSON.stringify(m.mats)}, geomless=${m.missed})`);
    rc = 1; continue;
  }
  // Which body the lens is actually holding is the nearest cluster — the framing question is about the
  // filmed subject, not the largest thing in the scene, and after staging both bodies are in frame.
  const held = sub.reduce((a, b) => (b.near < a.near ? b : a));
  rows.push({ tag, off, kind, met: r.met, fov: m.fov, visible: m.visible, subjectMeshes: m.subject,
    namedMeshes: m.named, namedList: m.namedList,
    mats: m.mats, clusters: sub, parts: m.parts, polarity, reset, hMax,
    held: held.n, hHeld: held.hFrac });
  console.log(`  ${tag}@sep+${off} MET=${r.met} [${kind}] fov=${m.fov} `
    + `subject=${m.subject}/${m.visible} visible meshes  held=${held.n} hFrac=${(held.hFrac * 100).toFixed(2)}%`
    // The naming denominator is printed with the reading: a claim that node names cannot label a body is
    // only checkable if the full subject count is visible, not just the top-6 parts below.
    + `  node-named=${m.named}/${m.subject} ${JSON.stringify(m.namedList)}`);
  for (const g of sub)
    console.log(`      subj ${g.n}  hFrac=${(g.hFrac * 100).toFixed(2)}%  wFrac=${(g.wFrac * 100).toFixed(2)}%  aFrac=${(g.aFrac * 100).toFixed(2)}%  inside h=${g.inH} w=${g.inW}  near=${g.near}m  worldY=${JSON.stringify(g.worldY)}  meshes=${g.meshes}  seeds=${JSON.stringify(g.seeds)}`);
  for (const p of m.parts.slice(0, 3))
    console.log(`        part ${p.p}  hFrac=${(p.hFrac * 100).toFixed(2)}%  near=${p.near}m  worldY=${JSON.stringify(p.worldY)}  pts=${p.pts}`);
  console.log(`      ctrl fov×1.5 -> hFrac ${(hPol * 100).toFixed(2)} %  polarity(smaller)=${polarity}  reset(identical)=${reset}`);
  if (!polarity || !reset) rc = 1;
}
fs.writeFileSync(`tools/logs/subject-fraction-${LABEL}.json`, JSON.stringify({ label: LABEL, lead, rows }, null, 1));
console.log(`  wrote   tools/logs/subject-fraction-${LABEL}.json`);
const beats = rows.filter(r => r.kind === 'beat');
if (beats.length === 2) {
  const [x, y] = beats;
  console.log(`  spread  beat b held ${x.held} at ${(x.hHeld * 100).toFixed(2)} % vs beat d held `
    + `${y.held} at ${(y.hHeld * 100).toFixed(2)} %  ratio ${(x.hHeld / y.hHeld).toFixed(2)}×  `
    + `(largest-subject hMax ${(x.hMax * 100).toFixed(2)} / ${(y.hMax * 100).toFixed(2)} %)`);
}
console.log(`  VERDICT ${rc ? 'FAIL' : 'PASS'}  bars: subject found in every capture, polarity control moves, reset is bit-identical`);
console.log('PROBE_RC=' + rc);
ws.close();
process.exit(rc);
