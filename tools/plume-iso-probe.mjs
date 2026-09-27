// usage: node tools/plume-iso-probe.mjs [url] [port] [capMet] [full|fast] [strideSec]
// The screen-space census task #63 was edited against but no tool could produce. The question it
// answers is narrow and pixel-free: at tracking range, do the *drawn* smoke puffs of one plume
// column overlap each other on the frame, or do they sit as separate visible dots with dark air
// between them? `cdp-plume-pearl.mjs` answers a different question — whether the flame's near-axis
// sprite chain reaches past its column tip, which is a *world-space* ruler — and that is the file
// this one completes, not replaces: no number about puff isolation or pool occupancy may be
// asserted in a src comment unless a row printed by THIS tool backs it.
//
// What is measured per sample, per firing plume (window = the sheath's own cylinder, `rr <= col`,
// `along > -2`, main.js's sheath() uses the same window for `aReach`):
//   win      alive smoke sprites inside that cylinder (pool slot not expired: life < 1, particles.js:128)
//   on       of those, in front of the lens and with their CENTRE inside the drawing buffer
//   vis      of those, alpha above the fragment shader's own discard line (particles.js:31):
//            op·(1−t)·smoothstep(0,fadeIn,t)·vNear > 0.001, every factor read from the live uniforms
//   iso      of the visible set, puffs with NO overlapping visible neighbour, where two puffs
//            overlap when |c1−c2| <= (d1+d2)/2 in DEVICE pixels — disc tangency under the vertex
//            shader's exact law (particles.js:17): d = min(aSize·uFocal/dist, uMaxSize)·uPixelRatio,
//            dist = max(−mv.z, 1), uFocal written from the real camera every frame (main.js:2419).
//            No fixed pixel radius is invented anywhere; the radii ARE the draw.
//   darkGap  px, max over isolated puffs of (nearest visible neighbour centre distance − the two radii)
//   axBrk    along-axis: sort the same visible set by `along`, a consecutive pair BREAKS when the
//            metre gap exceeds the sum of their birth-to-now world radii (size/2 each); axGap/axGapPx
//            are the widest such break in metres and at that depth in device px (focal·pr/dist px per m).
//   occ      the whole smoke pool: alive slots / ring capacity, so a "pinned at the cap" claim is checkable.
// Why it steps the real render loop (`__QA.step`) instead of `__RSB.fly(t)`: `fly` fast-forwards the
// physics WITHOUT emitting (main.js:1076 skips F.update while qaFly holds, and seedPlumes rides the
// real dt), so a census after a teleport would describe a trail no frame ever drew. Same trap both
// plume probes document. Needs a Chrome already listening:
//   google-chrome --headless=new --remote-debugging-port=9333
// with the app served on :5173 (http.server serves the repo ROOT; qa_boot.html loads /src/main.js
// through an import map, so src edits need no build). Boot is slow on a cold profile; the run prints
// streamed MET lines so it can be judged by progress, not silence. `fast` patches the composer's
// render out for the sweep — nothing here reads pixels, only the live buffers and the camera
// matrices — but the camera matrices then come from this probe's own updateMatrixWorld/
// updateProjectionMatrix, and a `fast` run is only evidence once it reproduces the same build's
// `full` readings, so the mode is printed in every verdict line.
//
// This is an INSTRUMENT, not a gate: exit 0 means the census completed with at least one lit-row
// sample, exit 2 means the run could not be trusted (never booted, pool not resolvable, MET stalled,
// socket dropped). It never exits 1 — no threshold is asserted here; the next attempt at #63 sets
// its own bar against these numbers. One CDP client at a time, as in cdp-plume-pearl.mjs: a second
// script calling __QA.step between these samples makes the stride claim false for the run.
import fs from 'fs';
const [,, urlArg, portStr, capStr, modeArg, strideStr] = process.argv;
const url = urlArg || 'http://127.0.0.1:5173/qa_boot.html?auto=std&demo=launch';
const port = Number(portStr || 9333);
const capMet = Number(capStr || 46);            // the pearl sweep's flame-out ceiling
const strideSec = Math.max(1, Number(strideStr || 2));
const mode = modeArg === 'fast' ? 'fast' : 'full';
const startedAt = Date.now();
const clock = () => `${((Date.now() - startedAt) / 1000).toFixed(0)}s`;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /qa_boot/.test(t.url))
  || list.find(t => t.type === 'page') || list.find(t => t.url);
if (!page) { console.log('NO_PAGE_TARGET'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
let finished = false;
const done = (code, why) => {
  if (finished) return;
  finished = true;
  if (why) console.log(why);
  try { ws.close(); } catch { }
  process.exit(code);
};
const send = (method, params = {}, timeoutMs = 600000) => new Promise((res, rej) => {
  const mid = ++id;
  const timer = setTimeout(() => {
    if (pending.delete(mid)) rej(new Error(`${method} #${mid}: no CDP response within ${timeoutMs} ms`));
  }, timeoutMs);
  pending.set(mid, {
    res: v => { clearTimeout(timer); res(v); },
    rej: e => { clearTimeout(timer); rej(e); },
  });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    console.log('[EXCEPTION] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
};
ws.onclose = () => done(2, `[${clock()}] CDP_CLOSED`);
ws.onerror = e => done(2, `[${clock()}] CDP_ERROR ` + (e?.message || e?.error || ''));
const evaluate = async expr => {
  try {
    return (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
  } catch (e) {
    return done(2, `[${clock()}] ` + e.message), undefined;
  }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Which build a reading describes — the same byte-for-byte proof cdp-plume-pearl.mjs demands before
// it trusts a verdict, and for the same reason: `http.server` sends no Cache-Control, and a census of
// yesterday's seeding constants printed under today's filename is exactly the fake evidence #63 died of.
const MODULES = ['../src/main.js', '../src/fx/plume.js', '../src/fx/particles.js']
  .map(p => [new URL(p, import.meta.url), p.replace(/^\.\.\/src\//, '/src/')]);
const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };

await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url });

const deadline = Date.now() + 600000;
let booted = false;
while (Date.now() < deadline) {
  await sleep(2000);
  if (await evaluate(`!!(window.__RSB && __RSB.state && __RSB.state.started)`) === true) { booted = true; break; }
}
if (!booted) done(2, `[${clock()}] BOOT_TIMEOUT ${url}`);
console.log(`[${clock()}] booted`);
// `?demo=launch` fires its skipMissions/clearSky/setDay/warp 3 s AFTER the auto-start click
// (main.js:5397-5413); sampling the ignition before that lands measures a different rig than the
// one the frames are judged on. Wait it out, then settle one more second.
if (/demo=launch/.test(url)) { await sleep(6000); console.log(`[${clock()}] demo=launch warp window elapsed`); }

process.on('uncaughtException', e => done(2, `[${clock()}] CRASH ${e?.stack || e}`));
process.on('unhandledRejection', e => done(2, `[${clock()}] REJECT ${e?.stack || e}`));

const stale = [];
const verified = [];
for (const [file, path] of MODULES) {
  const onDisk = fnv(fs.readFileSync(file, 'utf8'));
  verified.push(`${path} ${onDisk}`);
  const served = await evaluate(`(async () => {
    const fnv = ${fnv.toString()};
    const r = await fetch(${JSON.stringify(path)}, { cache: 'no-store' });
    return r.ok ? fnv(await r.text()) : 'HTTP_' + r.status;
  })()`);
  if (served !== onDisk) stale.push(`${path} disk=${onDisk} served=${served}`);
}
if (stale.length) done(2, `[${clock()}] MODULE_STALE ` + stale.join('   '));
console.log(`[${clock()}] served bytes match disk: ` + verified.join('   '));

// `fly(0)` builds the flight and puts the game's own launch camera on it; `fly(null)` releases the
// hold so the next stepped frame runs the real loop (physics + seedPlumes + pool update).
await evaluate(`__QA.pause(); __RSB.fly(0); __RSB.fly(null); 1`);

if (mode === 'fast') {
  const patched = await evaluate(`(() => {
    const c = __RSB.post().composer;
    if (!c) return 'NO_COMPOSER';
    if (c.__rsbNoRender) return 'already';
    c.__realRender = c.render; c.render = () => {}; c.__rsbNoRender = 1;
    return 'patched';
  })()`);
  if (patched !== 'patched' && patched !== 'already') done(2, `[${clock()}] FAST_MODE_FAILED ${patched}`);
}
console.log(`[${clock()}] mode=${mode} stride=${strideSec}s capMet=${capMet} url=${url}`);
console.log('CRITERION  overlap = |c1-c2| <= (d1+d2)/2 in DEVICE px (d = shader law: min(aSize·uFocal/dist, uMaxSize)·uPixelRatio);'
  + ' visible = op·(1-t)·ss(0,fadeIn,t)·ss(0.3·nearFade,nearFade,dist) > 0.001 (FS discard at disc centre);'
  + ' isolated = visible on-screen puff with no overlapping visible neighbour IN THE SAME PLUME WINDOW (rr<=col, along>-2);'
  + ' darkGap = max over isolated of min over others (dist - r1 - r2) px;'
  + ' axBreak = along-axis consecutive pair whose metre gap exceeds (s1+s2)/2 world m; on-screen = centre inside the drawing buffer.');

const CENSUS = (frames) => `(() => {
  __QA.step(${frames});
  const R = window.__RSB, L = R.launchRef, F = L.flight;
  if (!F) return { met: null, why: 'NO_FLIGHT' };
  const pm = R.plume();                       // also re-shows the four deck pools (hide=null)
  const cam = R.camera();
  // In 'fast' mode no renderer runs, so the world->camera and projection maths are refreshed here;
  // in 'full' mode this is what the renderer would have done anyway — identical inputs, one source.
  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  cam.updateProjectionMatrix();
  const cv = document.getElementById('scene');   // renderer.domElement (main.js:30-31)
  const bufW = cv.width, bufH = cv.height;
  // Find the smoke pool's THREE.Points WITHOUT any new src handle: the pool is added to the scene in
  // its constructor (particles.js:94) and is the ONLY Points carrying aLife whose capacity AND alive
  // count match the occupancy __RSB.plume() already reports for 'smoke' (main.js:3445-3446). Its
  // geometry buffers ARE the pool's Float32Arrays (particles.js:47-49,95), so this reads the same
  // bytes the vertex shader uploads.
  let pool = null, hits = 0;
  R.scene().traverse(o => {
    if (!o.isPoints || !o.geometry || !o.geometry.attributes.aLife) return;
    if (o.geometry.attributes.position.count !== pm.cap.smoke) return;
    const lf = o.geometry.attributes.aLife.array;
    let n = 0; for (let i = 0; i < lf.length; i++) if (lf[i] < 1) n++;
    if (n === pm.alive.smoke) { hits++; pool = o; }
  });
  if (hits !== 1) return { met: F.met, why: 'SMOKE_POOL_MATCH_' + hits };
  const g = pool.geometry.attributes, pos = g.position.array, sz = g.aSize.array, life = g.aLife.array;
  const u = pool.material.uniforms;
  const focal = u.uFocal.value, capPx = u.uMaxSize.value, pr = u.uPixelRatio.value;
  const op = u.uOpacity.value, fi = u.uFadeIn.value, nf = u.uNearFade.value;
  const me = cam.matrixWorldInverse.elements, ce = cam.projectionMatrix.elements, cp = cam.position;
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / ((b - a) || 1e-9))); return t * t * (3 - 2 * t); };
  const rows = [];
  for (let i = 0; i < F.plumes.length; i++) {
    const p = F.plumes[i];
    if (p.power <= 0) continue;
    const mr = 1.30 * Math.sqrt(Math.max(1, p.engines));
    const col = mr * (4.0 + 4.2 * p.power);      // plume.js:186 / main.js:1217-1218, the shell's own law
    const rng = cp.distanceTo(p.pos);
    const colPx = col * ce[5] * (bufH / 2) / Math.max(1e-6, rng);   // sheath's colPx ruler, main.js:3174
    const ax = p.axis, mx = p.pos.x, my = p.pos.y, mz = p.pos.z;
    let nWin = 0;
    const w = [];
    for (let s = 0; s < pm.cap.smoke; s++) {
      if (life[s] >= 1) continue;
      const i3 = s * 3;
      const dx = pos[i3] - mx, dy = pos[i3 + 1] - my, dz = pos[i3 + 2] - mz;
      const along = dx * ax.x + dy * ax.y + dz * ax.z;
      if (along <= -2) continue;
      const rx = dx - ax.x * along, ry = dy - ax.y * along, rz = dz - ax.z * along;
      if (Math.hypot(rx, ry, rz) > col) continue;
      nWin++;
      // particles.js:13-17 verbatim: camera space, dist = max(-mv.z, 1), point size in device px.
      const wx = pos[i3], wy = pos[i3 + 1], wz = pos[i3 + 2];
      const cx = me[0] * wx + me[4] * wy + me[8] * wz + me[12];
      const cy = me[1] * wx + me[5] * wy + me[9] * wz + me[13];
      const cz = me[2] * wx + me[6] * wy + me[10] * wz + me[14];
      if (cz >= 0) continue;
      const dist = Math.max(-cz, 1.0);
      const nx = (ce[0] * cx + ce[4] * cy + ce[8] * cz + ce[12]) / (-cz);
      const ny = (ce[1] * cx + ce[5] * cy + ce[9] * cz + ce[13]) / (-cz);
      const pxX = (nx * 0.5 + 0.5) * bufW, pxY = (0.5 - ny * 0.5) * bufH;
      if (pxX < 0 || pxX > bufW || pxY < 0 || pxY > bufH) continue;
      const dpx = Math.min(sz[s] * focal / dist, capPx) * pr;
      const t = life[s];
      const alpha = op * (1 - t) * ss(0, fi, t) * ss(nf * 0.3, nf, dist);
      w.push({ along, dpx, m: sz[s], dist, px: pxX, py: pxY, vis: alpha > 0.001 });
    }
    const v = w.filter(q => q.vis);
    const overlap = new Array(v.length).fill(false);
    let iso = 0, darkGap = 0;
    for (let a = 0; a < v.length; a++) {
      let nearest = Infinity;
      for (let b = 0; b < v.length; b++) {
        if (a === b) continue;
        const d = Math.hypot(v[a].px - v[b].px, v[a].py - v[b].py);
        const g = d - (v[a].dpx + v[b].dpx) / 2;
        if (g < nearest) nearest = g;
        if (d <= (v[a].dpx + v[b].dpx) / 2) { overlap[a] = true; overlap[b] = true; }
      }
      if (!overlap[a]) { iso++; if (nearest > darkGap) darkGap = nearest; }
    }
    let dSum = 0, dMax = 0;
    for (const q of v) { dSum += q.dpx; if (q.dpx > dMax) dMax = q.dpx; }
    // Along-axis chain on the SAME visible set, ordered by 'along' (world m spacing of the drawn column).
    v.sort((a, b) => a.along - b.along);
    let axPairs = 0, axBreaks = 0, axGapM = 0, axGapPx = 0;
    for (let a = 1; a < v.length; a++) {
      const P = v[a - 1], Q = v[a];
      axPairs++;
      const gap = Q.along - P.along - (P.m + Q.m) / 2;   // metres of clear air along the axis
      if (gap > 0) {
        axBreaks++;
        if (gap > axGapM) {
          axGapM = gap;
          axGapPx = gap * focal * pr / Math.max(P.dist, Q.dist);   // at the FARTHER end: the conservative px
        }
      }
    }
    rows.push({
      i, lit: true, power: +p.power.toFixed(2), engines: p.engines,
      rng: +rng.toFixed(1), col: +col.toFixed(1), colPx: +colPx.toFixed(1),
      nWin, nOn: w.length, nVis: v.length, iso,
      isoFrac: v.length ? +(iso / v.length).toFixed(3) : null,
      darkGapPx: +darkGap.toFixed(1),
      dMean: v.length ? +(dSum / v.length).toFixed(1) : null, dMax: +dMax.toFixed(1),
      axPairs, axBreaks, axGapM: +axGapM.toFixed(2), axGapPx: +axGapPx.toFixed(1),
    });
  }
  return {
    met: +F.met.toFixed(2), alt: +F.alt.toFixed(1), done: !!F.done,
    buf: [bufW, bufH], focal: Math.round(focal), pr: +pr.toFixed(3), maxSize: capPx,
    fadeIn: fi, nearFade: nf, opacity: op,
    occ: { alive: pm.alive.smoke, cap: pm.cap.smoke },
    rows,
  };
})()`;

const pad = (v, n) => String(v ?? '-').padStart(n);
const line = (met, w) => `MET${pad(met, 6)}  i${w.i} p${w.power}  rng${pad(w.rng, 5)}m col${pad(w.col, 5)}m colPx${pad(w.colPx, 6)}`
  + `  win${pad(w.nWin, 4)} on${pad(w.nOn, 4)} vis${pad(w.nVis, 4)}  iso${pad(w.iso, 4)} (${pad(w.isoFrac === null ? '-' : (100 * w.isoFrac).toFixed(0), 3)}%)`
  + `  darkGap${pad(w.darkGapPx, 6)}px  disc${pad(w.dMean, 5)}/${pad(w.dMax, 5)}px`
  + `  axBrk${pad(w.axBreaks, 3)}/${pad(w.axPairs, 4)}  axGap${pad(w.axGapM, 5)}m/${pad(w.axGapPx, 6)}px`;

const samples = [];
let stalled = 0, prevMet = -1;
for (let k = 0; k < 200 && !finished; k++) {
  const frames = k === 0 ? 60 : strideSec * 60;   // first read ~1 s after ignition, then every stride
  const r = await evaluate(CENSUS(frames));
  if (finished) break;
  if (!r || r.met === null) break;
  if (r.why) done(2, `[${clock()}] UNTRUSTED ${r.why} at MET ${r.met}`);
  if (r.met > prevMet + 0.5) stalled = 0; else if (++stalled > 3) break;
  prevMet = r.met;
  samples.push(r);
  console.log(`[${clock()}] occ ${r.occ.alive}/${r.occ.cap}  focal ${r.focal} px  buf ${r.buf.join('x')}`);
  for (const w of r.rows) console.log(line(r.met, w));
  if (r.done || r.met >= capMet) break;
}

const lit = samples.filter(s => s.rows.some(w => w.nVis > 3));
if (!lit.length) done(2, 'NO_LIT_PUFF_SAMPLES (every frame had <= 3 visible in-frame puffs, or none booted into flight)');
let maxFrac = 0, maxGap = 0, maxOcc = 0, maxAx = 0, maxAxPx = 0;
for (const s of lit) {
  maxOcc = Math.max(maxOcc, s.occ.alive / s.occ.cap);
  for (const w of s.rows) {
    if (w.isoFrac != null) maxFrac = Math.max(maxFrac, w.isoFrac);
    maxGap = Math.max(maxGap, w.darkGapPx);
    maxAx = Math.max(maxAx, w.axGapM); maxAxPx = Math.max(maxAxPx, w.axGapPx);
  }
}
console.log('\nISO_RESULTS_BEGIN');
for (const s of samples) console.log('ISO_JSON ' + JSON.stringify(s));
console.log('ISO_RESULTS_END');
console.log(`[${clock()}] samples: ${samples.length} (judged on ${lit.length} with >3 visible puffs)`
  + `   worst isoFrac ${(100 * maxFrac).toFixed(1)}%   worst darkGap ${maxGap.toFixed(1)} px`
  + `   worst along-axis break ${maxAx.toFixed(2)} m = ${maxAxPx.toFixed(1)} px`
  + `   peak smoke occupancy ${(100 * maxOcc).toFixed(0)}%`);
done(0, `PLUME_ISO_CENSUS_DONE mode=${mode} stride=${strideSec}s (instrument: no threshold asserted; exit 2 would have meant the run itself was untrusted)`);
