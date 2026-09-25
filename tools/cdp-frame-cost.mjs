// usage: node tools/cdp-frame-cost.mjs <url> [port=9333] [mode=map|probe|shadow|selftest] [x z yawDeg]
//
// The question this answers is the one the tour audit cannot: *why* a chunk draws at 44 fps when its
// neighbours draw at 63. `cdp-tour-audit.mjs` reports a frame rate at wherever the tour happened to
// be; this one separates the two candidate causes that produce that number —
//
//   map    : stand the rover at every interactive point, face four ways, and count what the camera
//            can actually see, grouped by the named prop group that owns it and banded by distance.
//            That is the frame-cost map, and it is the data a distance-LOD threshold has to be set
//            from rather than guessed at.
//   probe  : at one pose, re-measure the frame time under several conditions, interleaved and
//            repeated. Interleaving matters: this box drifts 63 → 56 fps across an eight-minute run
//            from heat alone, so a condition measured only at the end of the list would inherit that
//            drift and look like a win. Every condition is therefore run once per round, three rounds,
//            and the median of the three is the reading.
//   shadow : the same interleaved-rounds discipline, but for the shadow-caster budget's thresholds
//            and read off the game's own frame loop. See the mode's own comment for why it is not a
//            `probe` condition.
//
// Nothing here edits the build. Every mutation is a runtime toggle on the live scene graph and is
// restored in a `finally`, because the same page is the acceptance rig's page afterwards.
//
// Why the census is a hand-rolled frustum walk and not `renderer.info`: the composer auto-resets
// `info` after each pass, so by the time a tool can read it, it describes a fullscreen quad.
import { readFileSync, readdirSync } from 'node:fs';

const [,, url, portStr, modeArg, xStr, zStr, yawStr] = process.argv;
const port = Number(portStr || 9333);
const MODE = modeArg || 'map';
// A typo in the mode used to fall through to `map` and spend ten minutes census-ing the whole island
// while the operator believed they had asked for a probe.
if (!['map', 'probe', 'shadow', 'selftest'].includes(MODE)) {
  console.log(`BAD_MODE '${MODE}' — expected map | probe | shadow | selftest`);
  process.exit(1);
}
const BUF = { w: 1920, h: 1080 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PKG = readdirSync('/sys/class/thermal').filter(z => z.startsWith('thermal_zone')).map(z => `/sys/class/thermal/${z}`)
  .find(p => { try { return /x86_pkg_temp/.test(readFileSync(p + '/type', 'utf8')); } catch { return false; } });
const env = () => { let pkg = null;
  try { pkg = Math.round(Number(readFileSync(PKG + '/temp', 'utf8')) / 100 / 10); } catch { }
  return { pkg, load: Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) }; };

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /5173/.test(t.url)) || list.find(t => t.type === 'page');
if (!page) { console.log('NO_PAGE_TARGET'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); let exceptions = 0;
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
ws.onmessage = ev => { const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') { exceptions++;
    console.log('[EXCEPTION] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); } };
await new Promise(r => ws.onopen = r);
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url });
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'EVAL_THREW');
  return r.result.value; };
let ready = false; const deadline = Date.now() + 120000;
while (!ready && Date.now() < deadline) {
  ready = await evaluate(`!!(window.__RSB && window.__RSB.place && window.__RSB.state.started)`);
  if (!ready) await sleep(1000); }
if (!ready) { console.log('NEVER_READY'); process.exit(1); }
// Same pin as the acceptance harness: a frame cost measured at the wrong buffer size is not a cost.
await evaluate(`(()=>{const R=window.__RSB,c=R.post().composer,r=c.renderer;
  r.setPixelRatio(1);r.setSize(${BUF.w},${BUF.h},false);R.post().setSize(${BUF.w},${BUF.h});return 1})()`);

// The walk itself, in synchronous code with no frame waits: whatever view it is handed is the view it
// counts. `owner` is the nearest named ancestor — but note that every GLB imported by GLTFLoader
// arrives under a container literally named "Scene", so a `Scene` row is "the imported props", not one
// asset; the `Cube*` rows below it are per-mesh names inside a GLB. Distances are to each object's
// own world-space bounding sphere centre, and the bands are the ones an LOD scheme switches on.
const WALK = `sc.updateMatrixWorld(true);cam.updateMatrixWorld(true);
  const f=new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse));
  const owner=o=>{let p=o;while(p&&(!p.name||p===sc))p=p.parent;return (p&&p.name)||'('+o.type+')'};
  const groups={},band={'0-25':0,'25-50':0,'50-80':0,'80+':0},bt={'0-25':0,'25-50':0,'50-80':0,'80+':0};
  let draws=0,tris=0;
  sc.traverse(o=>{ if(!o.isMesh||!o.visible||!o.geometry)return;
    let hidden=false,q=o.parent;while(q){if(q.visible===false){hidden=true;break}q=q.parent}
    if(hidden)return;
    if(!o.geometry.boundingSphere)o.geometry.computeBoundingSphere();
    const s=o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld);
    if(!f.intersectsSphere(s))return;
    const g=o.geometry,t=(g.index?g.index.count:g.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);
    draws++;tris+=t;
    const d=cam.position.distanceTo(s.center);
    const k=owner(o);const e=groups[k]||(groups[k]={draws:0,tris:0,min:1e9});
    e.draws++;e.tris+=t;e.min=Math.min(e.min,d);
    const b=d<25?'0-25':d<50?'25-50':d<80?'50-80':'80+';
    band[b]++;bt[b]+=t; });
  const dir=cam.getWorldDirection(new T.Vector3());
  return JSON.stringify({draws,tris:Math.round(tris),
    // the eye and heading the count was taken from, not just the rover pose it was asked for. The
    // chase rig sits behind the rover at a distance of its own choosing (speed, trauma, a per-frame
    // collider keep-out), so two "identical" poses can look at the island from 8 m and 90 m — and
    // since the frame cost here is dominated by what is beyond 80 m, that difference *is* the
    // measurement. Run #1 printed 1 116 → 325 visible draws between conditions at one pose and had no
    // field to see it.
    cam:cam.position.toArray().map(v=>+v.toFixed(2)),hd:+(Math.atan2(dir.x,dir.z)*57.2958).toFixed(0),
    groups:Object.entries(groups).sort((a,b)=>b[1].draws-a[1].draws).slice(0,10)
      .map(([k,v])=>[k,v.draws,Math.round(v.tris),Math.round(v.min)]),
    band,trisByBand:Object.fromEntries(Object.entries(bt).map(([k,v])=>[k,Math.round(v)])),
    pose:[Math.round(R.state.pos[0]),Math.round(R.state.pos[2])],storm:R.storm&&R.storm().phase})`;

const HEAD = `const T=await import('three'),R=window.__RSB,sc=R.scene(),cam=R.camera();`;

// Map mode: drive the real chase rig to the pose and let it stop, then count what it sees.
const censusAt = (x, z, yawDeg) => `(async()=>{${HEAD}
  R.place(${x},${z},${(yawDeg ?? 0) * Math.PI / 180});
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  await new Promise(r=>setTimeout(r,700));
  return (()=>{${WALK}})()})()`;

// Probe mode: overwrite the camera with a recorded view and count that. Nothing between the write and
// the walk is a frame boundary, so the chase rig cannot move the eye underneath the measurement.
const viewBody = v => `cam.position.set(${v.cam.join(',')});cam.quaternion.set(${v.q.map(n => +n.toFixed(5)).join(',')});
  cam.fov=${v.fov};cam.updateProjectionMatrix();`;
const viewExpr = v => `(function(){const cam=window.__RSB.camera();${viewBody(v)}return 1})()`;
const censusNow = v => `(async()=>{${HEAD}${viewBody(v)}return (()=>{${WALK}})()})()`;

// `Date.now()`, not `performance.now()` — and that is a measured requirement, not a style choice. The
// first two runs of this ruler printed `0 ms` for every condition, including a busy-loop control that
// ran alongside it: in this headless build `performance.now()` does not advance within a task (3e7
// additions came back as 0.0 ms while `Date.now()` moved 20 ms), i.e. it ticks at frame boundaries and
// nothing finer. So anything timed inside one synchronous block reads as exactly zero — and for the
// same reason no rAF-interval ruler in this page can see below one frame, which is what made the first
// probe report "cull 96 % of the draws, saved 0 ms". The harness therefore drives the renders itself,
// and times the whole queue with a single `gl.finish()` at the end:
//   `full`   = (submit + GPU + flush) / n  — the number the fps≥55 bar is about
//   `submit` = the same loop up to the flush, i.e. the CPU side (JS, driver, per-object bookkeeping)
// Splitting them is the point: a draw-call fix can only buy `submit`, a triangle/fill fix buys the gap
// to `full`. Kept honest — when the GPU is the bottleneck the driver back-pressures once the command
// queue fills, so `submit` rises to meet `full`: it is a floor, not an independent reading.
// What neither half decides is the acceptance bar. fps≥55 is a property of the running loop, and a
// forced-render number has no loop in it; shadow-threshold claims in particular come from `shadow`
// mode below, which reads the game's own rAF cadence at a pinned sun.
//
// Deliberately no setPixelRatio/setSize in here: the loop pins the buffer once per condition via
// REVERT, and a ruler that resized the renderer on entry would silently cancel the `half-buffer`
// condition it is supposed to be measuring.
const sampleNow = (v, n) => `(async()=>{${HEAD}${viewBody(v)}
  const cen=(()=>{${WALK}})();
  const comp=R.post().composer,gl=comp.renderer.getContext();
  const t0=Date.now();for(let i=0;i<${n};i++)comp.render(1/60);const t1=Date.now();gl.finish();const t2=Date.now();
  return JSON.stringify({cen,cost:{submit:+((t1-t0)/${n}).toFixed(3),full:+((t2-t0)/${n}).toFixed(3)}})})()`;

// Stand the rover at the pose and let the chase rig stop: it is a follower (position, quaternion and
// fov are all smoothed), so for the first few hundred ms after `place` the eye is still swinging. The
// recorded view is then re-written before *every* reading, which is what makes the conditions
// comparable: run #1's census went 1 116 → 325 visible draws between conditions at one supposedly
// fixed pose, and a Δ table built on that is a description of the camera, not of the code.
// `settled:false` says the rig had not stopped after 60 frame pairs, and is printed rather than hidden.
const settle = (x, z, yawDeg) => `(async()=>{const R=window.__RSB,cam=R.camera();
  R.place(${x},${z},${(yawDeg ?? 0) * Math.PI / 180});
  let last=cam.position.clone(),still=0;
  for(let i=0;i<60;i++){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const d=cam.position.distanceTo(last);last=cam.position.clone();still=d<0.02?still+1:0;if(still>=4)break}
  return JSON.stringify({settled:still>=4,cam:cam.position.toArray(),q:cam.quaternion.toArray(),fov:cam.fov})})()`;

const CONDITIONS = {
  asis: `0`,
  // The shadow pass draws the casters of the *shadow* camera, which is not the view frustum: a
  // pose can be cheap in the census and expensive in the frame for exactly this reason.
  'no-shadow': `window.__RSB.scene().traverse(o=>{if(o.isDirectionalLight&&o.castShadow)o.userData.__k=o.castShadow,o.castShadow=false})`,
  // A stand-in for "props LOD": nothing beyond 50 m from the eye is drawn. This is not the fix, it
  // is the ceiling on what the fix can buy, and it is the number task #65 refused to give.
  // `.clone()` on the sphere is load-bearing, not tidiness: `geometry.boundingSphere` is shared by
  // every instance of that geometry and the renderer reads it as *local* space. Without the clone the
  // first cull pass left every sphere it touched in world space (and the second pass transformed it
  // again), the page's own frustum culling then started rejecting geometry on its own, and run #1's
  // census fell 1 116 → 325 between conditions at one pose. That is the `BOUNDS` line below.
  'cull50': `window.__RSB.scene().traverse(o=>{if(!o.isMesh)return;const b=o.geometry.boundingSphere||(o.geometry.computeBoundingSphere(),o.geometry.boundingSphere);
      if(b.clone().applyMatrix4(o.matrixWorld).center.distanceTo(window.__RSB.camera().position)>50){o.userData.__v=o.visible,o.visible=false}})`,
  'cull80': `window.__RSB.scene().traverse(o=>{if(!o.isMesh)return;const b=o.geometry.boundingSphere||(o.geometry.computeBoundingSphere(),o.geometry.boundingSphere);
      if(b.clone().applyMatrix4(o.matrixWorld).center.distanceTo(window.__RSB.camera().position)>80){o.userData.__v=o.visible,o.visible=false}})`,
  // Half the pixels at the same geometry separates "too much triangle" from "too much fill".
  'half-buffer': `(()=>{const c=window.__RSB.post().composer;c.renderer.setSize(${BUF.w / 2},${BUF.h / 2},false);window.__RSB.post().setSize(${BUF.w / 2},${BUF.h / 2})})()`,
};
const REVERT = `(function(){const R=window.__RSB,sc=R.scene(),c=R.post().composer;
  sc.traverse(o=>{ if(o.userData.__k!==undefined){o.castShadow=o.userData.__k;delete o.userData.__k}
    if(o.userData.__v!==undefined){o.visible=o.userData.__v;delete o.userData.__v} });
  c.renderer.setPixelRatio(1);c.renderer.setSize(${BUF.w},${BUF.h},false);R.post().setSize(${BUF.w},${BUF.h});return 1})()`;

// The self-check the first run lacked: the value of every geometry bounding sphere the probe could
// touch, keyed by geometry. Any mutation of them — the probe's job is to toggle `visible` and nothing
// else — shows up here as drift, and a run that drifts has measured a scene the game is not running.
//
// Diffed per geometry, not summed, and that distinction is what the first version got wrong: it
// printed `BOUNDS MOVED — readings void` on a run whose draw counts were perfectly stable, because
// `geoms` went 544 → 559. Those fifteen are spheres that did not exist yet and were computed lazily
// *by the census itself* (`if(!boundingSphere)computeBoundingSphere()`) — a value-adding read, not a
// mutation. A sum cannot tell "a sphere appeared" from "a shared sphere was moved into world space",
// which is the exact corruption run #1 suffered; only the per-uuid comparison can. So: a uuid present
// on both sides with different numbers is the only finding, and appeared/vanished are reported as
// their own counts.
const boundsMap = `(function(){const seen=new Set(),m={},who={};
  window.__RSB.scene().traverse(o=>{const g=o.geometry;if(!g||!g.boundingSphere||seen.has(g.uuid))return;seen.add(g.uuid);
    const b=g.boundingSphere;m[g.uuid]=[b.center.x,b.center.y,b.center.z,b.radius].map(n=>+n.toFixed(3));
    let p=o;while(p&&(!p.name||!p.parent))p=p.parent;who[g.uuid]=(p&&p.name)||o.name||o.type});
  return JSON.stringify({m,who})})()`;
// Read in node, not in the page: the page can only answer "what is the map now", and the question
// here is about two maps taken 15 seconds and 15 conditions apart.
const boundsVerdict = (a, b) => {
  const A = JSON.parse(a), B = JSON.parse(b);
  const shared = Object.keys(A.m).filter(k => k in B.m);
  const moved = shared.filter(k => A.m[k].join() !== B.m[k].join());
  return { ok: moved.length === 0 && Object.keys(A.m).length === shared.length,
    text: `moved ${moved.length} gone ${Object.keys(A.m).length - shared.length} appeared ${Object.keys(B.m).length - shared.length} shared ${shared.length}/${Object.keys(A.m).length}`,
    moved: moved.slice(0, 6).map(k => `${k} ${(B.who[k] || A.who[k])} ${A.m[k].join('/')}→${B.m[k].join('/')}`) };
};

// What the bar is actually written in. The forced-render ruler says what a frame *costs*; this says
// what the running game *delivers*, counted over a fixed wall-clock window with `Date.now()` — the
// only clock in this page that moves (see `sampleNow`). Two seconds, ~120 frames: enough to be a rate,
// short enough to sit inside one condition without the box heating up under it.
const liveFps = `(async()=>{const t0=Date.now();let n=0;
  while(Date.now()-t0<2000){await new Promise(r=>requestAnimationFrame(r));n++}
  return JSON.stringify({fps:+(n*1000/(Date.now()-t0)).toFixed(1),frames:n})})()`;

if (MODE === 'map') {
  const pts = JSON.parse(await evaluate(`JSON.stringify(window.__RSB.pois().map(p=>[Math.round(p.x),Math.round(p.z),p.id||p.key||p.name||'']))`));
  console.log(`MAP ${pts.length} interactive points × 4 headings, buffer ${BUF.w}x${BUF.h}`);
  const rows = [];
  for (const [x, z, name] of pts) for (const hd of [0, 90, 180, 270]) {
    const c = JSON.parse(await evaluate(censusAt(x, z, hd)));
    rows.push({ name, hd, ...c });
    console.log(`${name.padEnd(16)} hd${String(hd).padStart(3)} fps? draws=${String(c.draws).padStart(4)} tris=${String(c.tris).padStart(8)} ` +
      `band ${Object.entries(c.band).map(([k, v]) => `${k}:${v}`).join(' ')} ${c.storm} top ${c.groups.slice(0, 3).map(g => `${g[0]}:${g[1]}d/${g[3]}m`).join(' ')}`);
  }
  const w = rows.sort((a, b) => b.draws - a.draws).slice(0, 8);
  console.log('WORST ' + JSON.stringify(w.map(r => ({ p: r.name, hd: r.hd, draws: r.draws, tris: r.tris, pose: r.pose }))));
  console.log(`exceptions=${exceptions}`);
} else if (MODE === 'probe') {
  const x = Number(xStr), z = Number(zStr), yaw = Number(yawStr || 0);
  console.log(`PROBE pose ${x},${z} yaw ${yaw}° — 3 interleaved rounds of ${Object.keys(CONDITIONS).length} conditions`);
  const v = JSON.parse(await evaluate(settle(x, z, yaw)));
  if (!v.settled) console.log('SETTLE-FAILED the chase rig had not stopped in 60 frame pairs — readings below are at a moving eye');
  const VIEW = { cam: v.cam, q: v.q, fov: v.fov };
  console.log('VIEW eye ' + VIEW.cam.map(n => n.toFixed(1)).join(',') + ` fov ${VIEW.fov.toFixed(1)}°`);
  const base = JSON.parse(await evaluate(censusNow(VIEW)));
  console.log(`CENSUS draws=${base.draws} tris=${base.tris} band=${JSON.stringify(base.band)}`);
  console.log('GROUPS ' + JSON.stringify(base.groups));
  const acc = {};
  const b0 = await evaluate(boundsMap);
  for (let round = 0; round < 3; round++) {
    for (const [k, expr] of Object.entries(CONDITIONS)) {
      // revert → pin the eye → mutate, in one task, because the cull conditions measure their radius
      // from the camera and must see the pinned one. Then a wait, so any shader recompile this toggle
      // forces happens outside the timed block, and only then the sample, which re-pins and does the
      // census and the renders in one synchronous task.
      await evaluate(`${REVERT};${viewExpr(VIEW)};${expr}`);
      await sleep(450);
      const row = JSON.parse(await evaluate(sampleNow(VIEW, 15)));
      const cen = JSON.parse(row.cen);
      const live = JSON.parse(await evaluate(liveFps));      // the game's own loop, condition still on
      await evaluate(REVERT);
      (acc[k] ||= []).push({ ...row.cost, draws: cen.draws, tris: cen.tris, fps: live.fps });
      // Printed as it lands, not per round: a condition that recompiles every material in the scene
      // (shadow on→off) is the slow thing in this script, and without a live line there is no way to
      // tell that from a hung one.
      console.log(`  r${round + 1} ${k.padEnd(12)} full ${String(row.cost.full).padStart(6)} ms  submit ${String(row.cost.submit).padStart(6)}  ` +
        `live ${String(live.fps).padStart(5)} fps  draws ${String(cen.draws).padStart(4)}  tris ${String(cen.tris).padStart(7)}  hd ${String(cen.hd).padStart(4)}  ${env().pkg}C`);
    }
    console.log(`  round ${round + 1} ` + Object.entries(acc).map(([k, v2]) => `${k}:${v2[v2.length - 1].full}ms`).join(' ') +
      ` ${env().pkg}C load${env().load.toFixed(1)}`);
  }
  const med = (a, key) => a.map(r => r[key]).sort((p, q) => p - q)[a.length >> 1];
  const ref = med(acc.asis, 'full'), refFps = med(acc.asis, 'fps');
  const dlt = (a, b) => `${a - b >= 0 ? '+' : ''}${(a - b).toFixed(2)}`;
  const b1 = await evaluate(boundsMap);
  // A probe is only a measurement if the scene it measured is the scene that ships. `cull*` mutates
  // nothing but `visible` now; if this line ever names a geometry that moved, the conditions have been
  // writing to shared geometry and every Δ above is a description of a broken page.
  const bd = boundsVerdict(b0, b1);
  console.log(`BOUNDS ${bd.ok ? 'no shared sphere moved' : 'MOVED — readings void'} (${bd.text})` +
    (bd.moved.length ? ' ' + JSON.stringify(bd.moved) : ''));
  console.log('RESULT (median of 3 rounds at the pinned view; ms per forced composer render at 1920×1080, and the ' +
    'fps the live loop delivered with the same condition on)');
  for (const [k, v2] of Object.entries(acc)) {
    const ms = med(v2, 'full'), sub = med(v2, 'submit'), fps = med(v2, 'fps');
    console.log(`  ${k.padEnd(12)} full ${String(ms).padStart(6)} ms (${(1000 / ms).toFixed(0).padStart(4)} fps cap) Δ${dlt(ms, ref)} ms  ` +
      `submit ${String(sub).padStart(6)} ms  live ${String(fps).padStart(5)} fps Δ${(fps - refFps >= 0 ? '+' : '') + (fps - refFps).toFixed(1)}  ` +
      `draws ${v2.map(r => r.draws).join('/')}`);
  }
  console.log(`exceptions=${exceptions}`);
} else if (MODE === 'shadow') {
  // Reproduce the ladder that set the shadow-caster thresholds, so the numbers written into
  // src/world/shadow_budget.js can be re-derived from the repo instead of from a scratch file.
  //
  // Why this is its own mode and not a `probe` condition: the acceptance bar is written in fps, and
  // fps is what the game's own rAF loop delivers. `probe`'s forced loop hammers 15 composer renders
  // into one synchronous task with no vsync pacing and a saturated driver queue — right ruler for
  // "does removing draws remove work", wrong one for "does the player get 55". So the arms here are
  // scored by a live frame window, and the depth pass reports its own draw count next to it: an arm
  // whose fps moved while its shadow draws did not has not been measured, it has been drifted.
  //
  // The sun is pinned for the same reason the buffer is. Shadow cost is however many casters fall
  // inside the *shadow* camera's frustum, and that set changes as the sun moves: unpinned, one arm
  // measured two minutes apart drifted 1 213 → 437 shadow draws/tick, which is bigger than the entire
  // effect any of these thresholds is supposed to produce.
  const x = Number(xStr), z = Number(zStr), yaw = Number(yawStr || 0);
  const ROUNDS = 3, WIN_MS = 2200;
  console.log(`SHADOW pose ${x},${z} yaw ${yaw}° buffer ${BUF.w}×${BUF.h} window ${WIN_MS}ms × ${ROUNDS} interleaved rounds  ${env().pkg}C load${env().load.toFixed(1)}`);
  console.log('DAY ' + JSON.stringify(await evaluate(`window.__RSB.setDay(0.30)`)));
  const STATS = `JSON.stringify(window.__RSB.shadowBudget())`;
  const SNAP = `(function(){const rd=window.__RSB.post().composer.renderer;let sun=null,n=0;
    window.__RSB.scene().traverse(o=>{if(o.isDirectionalLight&&o.castShadow){n++;sun=o}});
    const s=sun&&sun.shadow;let elev=null;
    if(s){s.camera.updateMatrixWorld(true);const m=s.camera.matrixWorld.elements;
      elev=+(Math.asin(Math.max(-1,Math.min(1,m[9])))*180/Math.PI).toFixed(1)}
    return JSON.stringify({n,elev,enabled:rd.shadowMap.enabled,map:s&&[s.mapSize.x,s.mapSize.y],
      span:s&&[s.camera.left,s.camera.right,s.camera.top,s.camera.bottom,s.camera.near,s.camera.far].map(v=>+v.toFixed(1)),bias:s&&s.bias})})()`;
  // Two counts, deliberately different ones. `casters` is the scene-wide set the renderer is allowed
  // to draw into the depth map (the budget's own output); `draws` is what the *view* frustum holds.
  // A threshold change moves the first and need not move the second, and the whole point of the
  // height clause was that a prop can be off-camera in the beauty pass and still be in the shadow one.
  const CENSUS = `(async()=>{${HEAD}
    sc.updateMatrixWorld(true);cam.updateMatrixWorld(true);
    const f=new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(cam.projectionMatrix,cam.matrixWorldInverse));
    let draws=0,tris=0,casters=0;
    sc.traverse(o=>{ if(!o.isMesh||!o.visible||!o.geometry)return;
      let q=o.parent;while(q){if(q.visible===false)return;q=q.parent}
      if(!o.geometry.boundingSphere)o.geometry.computeBoundingSphere();
      const s=o.geometry.boundingSphere.clone().applyMatrix4(o.matrixWorld);
      if(o.castShadow&&s.radius>0.2)casters++;
      if(!f.intersectsSphere(s))return;
      const g=o.geometry;draws++;tris+=(g.index?g.index.count:g.attributes.position.count)/3*(o.isInstancedMesh?o.count:1)});
    return JSON.stringify({draws,tris:Math.round(tris),casters,cam:cam.position.toArray().map(v=>+v.toFixed(1))})})()`;
  // `renderer.info` per pass is the only way to see the depth pass at all (autoReset off, read and
  // zeroed inside the composer's own render), and `renderBufferDirect(scene===null)` is three.js's
  // signal for "this draw is going into a shadow map".
  const INSTALL = `(function(){const rd=window.__RSB.post().composer.renderer,c=window.__RSB.post().composer;
    if(window.__L){rd.renderBufferDirect=window.__L.orRBD;rd.shadowMap.render=window.__L.orSM;c.render=window.__L.orComp}
    const st=window.__L={marks:[],shadowPasses:0,shadowDraws:0,draws:[],tris:[]};
    rd.info.autoReset=false;
    st.orComp=c.render.bind(c);
    c.render=function(){const i=rd.info.render;st.draws.push(i.calls);st.tris.push(i.triangles);i.calls=0;i.triangles=0;
      st.marks.push(performance.now());return st.orComp.apply(c,arguments)};
    st.orSM=rd.shadowMap.render.bind(rd.shadowMap);
    rd.shadowMap.render=function(lights,scene,cam){st.shadowPasses++;return st.orSM(lights,scene,cam)};
    st.orRBD=rd.renderBufferDirect.bind(rd);
    rd.renderBufferDirect=function(cam,scene){if(scene===null)st.shadowDraws++;return st.orRBD.apply(rd,arguments)};
    return 'ok'})()`;
  // Frame intervals come from the marks, not from a counter: `frames` is n−1 spans, so a window that
  // caught 130 rAF callbacks says 129, and the median/p95 are per-frame milliseconds — the units the
  // bar is written in. `performance.now()` is fine *here* because every sample crosses a frame
  // boundary; it is only inside one synchronous task that this build cannot tick (see `sampleNow`).
  const WINDOW = `(async()=>{const L=window.__L;L.marks.length=0;L.draws.length=0;L.tris.length=0;L.shadowPasses=0;L.shadowDraws=0;
    await new Promise(r=>setTimeout(r,300));L.marks.length=0;L.draws.length=0;L.tris.length=0;
    const t0=performance.now();
    while(performance.now()-t0<${WIN_MS})await new Promise(r=>requestAnimationFrame(r));
    const m=L.marks,n=m.length;const iv=[];for(let i=1;i<n;i++)iv.push(m[i]-m[i-1]);iv.sort((a,b)=>a-b);
    const med=a=>a[a.length>>1]||0;
    return JSON.stringify({fps:+(((n-1)*1000)/(m[n-1]-m[0]||1)).toFixed(1),frames:n-1,
      med:+med(iv).toFixed(2),p95:+iv[Math.floor(iv.length*0.95)].toFixed(2),
      shadowPassesPerTick:+(L.shadowPasses/Math.max(1,n-1)).toFixed(2),
      shadowDrawsPerTick:+(L.shadowDraws/Math.max(1,n-1)).toFixed(1),
      draws:+med(L.draws),tris:+(med(L.tris)/1e6).toFixed(2)})})()`;
  const settle = `(async()=>{const R=window.__RSB,cam=R.camera();
    R.place(${x},${z},${yaw * Math.PI / 180});
    let last=cam.position.clone(),still=0;
    for(let i=0;i<60;i++){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const d=cam.position.distanceTo(last);last=cam.position.clone();still=d<0.02?still+1:0;if(still>=4)break}
    return still>=4})()`;
  const shipped = JSON.parse(await evaluate(STATS));
  // Only the five tunables go into the restore: an arm moves them with retune(), and without putting
  // them back the game loop's own update() would rebuild the caster set from the last arm's rule and
  // the page would ship the experiment.
  const SH = JSON.stringify({ big: shipped.big, tall: shipped.tall, near: shipped.near, far: shipped.far, step: shipped.step });
  const RESTORE = snap => { const o = JSON.parse(snap); return `(function(){
    const rd=window.__RSB.post().composer.renderer;rd.shadowMap.enabled=${o.enabled};
    window.__RSB.scene().traverse(x=>{if(!x.isDirectionalLight||!x.castShadow)return;const s=x.shadow;
      s.mapSize.set(${o.map[0]},${o.map[1]});
      if(s.map){s.map.dispose();s.map=null}
      Object.assign(s.camera,{left:${o.span[0]},right:${o.span[1]},top:${o.span[2]},bottom:${o.span[3]},near:${o.span[4]},far:${o.span[5]}});
      s.camera.updateProjectionMatrix();s.bias=${o.bias}});
    window.__RSB.shadowRetune(${SH});return 'restored'})()` };
  const RETUNE = o => `'retune ' + JSON.stringify(window.__RSB.shadowRetune(${JSON.stringify(o)})) + ' → ' + JSON.stringify(window.__RSB.shadowBudget())`;
  const ARMS = {
    asis: () => evaluate(`'stats ' + JSON.stringify(window.__RSB.shadowBudget())`),
    // `big:0, tall:0` is the no-budget scene, and NOT `tall` set high: `height >= 0` is true for every
    // mesh, so a zero threshold arms everything. Getting this backwards once scored the fully-armed
    // scene as the control and printed the effect as noise.
    'no-budget': () => evaluate(RETUNE({ big: 0, tall: 0 })),
    // The rule as it shipped before the height clause: girth unchanged, nothing passes the height
    // test, so every intent-caster is a distance-gated candidate again.
    'radius-only': () => evaluate(RETUNE({ tall: 1e9 })),
    'shadow-off': () => evaluate(`(window.__RSB.post().composer.renderer.shadowMap.enabled=false,'shadowMap.enabled=false')`),
  };
  console.log('HOOK ' + await evaluate(INSTALL));
  console.log('SHIPPED ' + await evaluate(STATS));
  const acc = {};
  let steady = null;   // the caster count every correct restore reproduces; see the check below
  for (let round = 0; round < ROUNDS; round++) {
    for (const [label, arm] of Object.entries(ARMS)) {
      const settled = await evaluate(settle);
      const before = await evaluate(SNAP);
      const c0 = JSON.parse(await evaluate(CENSUS));
      const note = await arm();
      const after = JSON.parse(await evaluate(SNAP));
      const c1 = JSON.parse(await evaluate(CENSUS));
      const w = JSON.parse(await evaluate(WINDOW));
      (acc[label] ||= []).push({ ...w, view: c0.draws, casters: c1.casters, elev: after.elev, cam: c1.cam.join(',') });
      console.log(`  r${round} ${label.padEnd(12)} fps ${String(w.fps).padStart(5)}  med ${String(w.med).padStart(5)}ms  p95 ${String(w.p95).padStart(5)}  ` +
        `shadow ${String(w.shadowPassesPerTick).padStart(4)}pass ${String(w.shadowDrawsPerTick).padStart(6)}draw/tick  ` +
        `frame ${String(w.draws).padStart(5)}draw ${String(w.tris).padStart(4)}Mtri  ` +
        `view ${c0.draws}→${c1.draws} cast ${c0.casters}→${c1.casters} el=${JSON.parse(before).elev}→${after.elev}°  ${env().pkg}C  s=${settled}  [${note}]`);
      await evaluate(RESTORE(before));
      const back = await evaluate(SNAP);
      if (back !== before) console.log(`  !! r${round} ${label} did not restore: ${back}`);
      // Two things must be true before the restored caster set means anything. It has to be read after a
      // game tick: retune() calls classify(), which nulls the budget's cached eye, so the set straight
      // after an arm is only the always-set and the near set has not been re-armed yet — which is also
      // why it cannot be the comparison. And the pre-arm count is not a fixed point either: it carries
      // hysteresis from wherever the rover was driven *before* this pose (props sitting between near and
      // far stay lit), which a forced re-classify cannot reproduce because it starts every mesh from
      // `false`. Measured: 561 before the first arm on hi, 531 after, 531 every time from then on. So
      // the invariant is the one that is actually reproducible — every restore must land the scene on
      // the same steady-state caster count as the first restore did, at the same pose and sun.
      await evaluate(`(async()=>{for(let i=0;i<3;i++)await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})()`);
      const c2 = JSON.parse(await evaluate(CENSUS));
      if (steady === null) steady = c2.casters;
      else if (c2.casters !== steady) console.log(`  !! r${round} ${label} restore drifted: steady ${steady} → ${c2.casters} after a tick`);
      const s2 = JSON.parse(await evaluate(STATS));
      if (s2.tall !== shipped.tall || s2.big !== shipped.big || s2.near !== shipped.near) console.log(`  !! r${round} ${label} params leaked: ${JSON.stringify(s2)}`);
    }
  }
  const med = (a, k) => a.map(r => r[k]).sort((p, q) => p - q)[a.length >> 1];
  const b = med(acc.asis, 'fps');
  console.log('RESULT median over rounds — casters is the scene-wide armed set, shadow draw/tick is what the depth pass submits');
  for (const [k, rows] of Object.entries(acc)) {
    console.log(`  ${k.padEnd(12)} fps ${String(med(rows, 'fps')).padStart(5)}  Δ${(med(rows, 'fps') - b >= 0 ? '+' : '') + (med(rows, 'fps') - b).toFixed(1)}  ` +
      `med ${med(rows, 'med')}ms  frame ${med(rows, 'draws')}draw ${med(rows, 'tris')}Mtri  shadow ${med(rows, 'shadowDrawsPerTick')}draw/tick  ` +
      `frames ${rows.map(r => r.frames).join('/')}  cast ${[...new Set(rows.map(r => r.casters))].join(' ')}  el ${[...new Set(rows.map(r => r.elev))].join(' ')}°`);
  }
  console.log('NOISE the same-arm spread is the floor: an arm that beats asis by less than its own round-to-round range has not been measured, only ordered.');
} else if (MODE === 'selftest') {
  // The guard has to have been seen red, or "no shared sphere moved" means nothing. This injects
  // precisely the bug the guard exists to catch — a world-space transform written back into a *shared*
  // local-space sphere, which is what run #1's `cull50` did without `clone()` — and then demands the
  // verdict report it. Both polarities are measured: a clean pair must say OK, and a single corrupted
  // geometry must name that geometry. Exits non-zero if either half fails, so a guard that stops
  // working cannot pass this and then go quiet over a real run.
  const corrupt = `(function(){const sc=window.__RSB.scene();let g=null;
    sc.traverse(o=>{ if(!g&&o.isMesh&&o.geometry.boundingSphere&&o.matrixWorld.elements[12]!==0)g=o.geometry});
    if(!g)return JSON.stringify({corrupted:null});
    g.boundingSphere.center.x+=7.5;g.boundingSphere.radius+=3.25;
    return JSON.stringify({corrupted:g.uuid})})()`;
  const x0 = await evaluate(boundsMap);
  const x1 = await evaluate(boundsMap);
  const clean = boundsVerdict(x0, x1);
  const victim = JSON.parse(await evaluate(corrupt));
  const x2 = await evaluate(boundsMap);
  const dirty = boundsVerdict(x1, x2);
  const found = victim.corrupted !== null && dirty.moved.length === 1 && dirty.moved[0].includes(victim.corrupted);
  console.log(`SELFTEST clean pair  → ${clean.ok ? 'OK      (want OK)' : 'MOVED   (want OK)'} ${clean.text}`);
  console.log(`SELFTEST injected    → ${found ? 'CAUGHT  (want CAUGHT)' : 'MISSED  (want CAUGHT)'} ${dirty.text} ${JSON.stringify(dirty.moved)}`);
  if (!(clean.ok && found)) process.exitCode = 1;
}
// The open WebSocket keeps node alive past the last log line, which makes a finished run look from
// the outside exactly like a hung one.
ws.close();
process.exit(0);
