#!/usr/bin/env node
// ─── the offline world harness: buildBase() + createRocks() in plain node ───
//
// Why this exists. `tools/disc-audit-probe.js` measures the island out of a live page, so every one
// of its readings is one browser-run away from being repeatable in CI, and a per-disc table with 695
// rows cannot be read out of a JSON blob printed by a GPU session. The collider records a probe needs
// for the phantom ruler — `prop`, `zone`, `x`, `z`, `r`, and above all the `lot`/`share` rectangle a
// disc was tiled from (props.js:513, terrain.js:1160) — are all *build-time* values: they exist the
// moment the emitter runs and never change afterwards. Nothing about them needs a GPU.
//
// So this file builds the world with no browser at all: it imports the shipped emitters
// (`src/world/props.js` `buildBase`, `src/world/terrain.js` `createTerrain`/`createRocks`/`createStones`)
// in the same order and with the same arguments `src/main.js` boot() uses (main.js:251-264, including
// the `terrain.regrade()` between the base and the scatter, which is what the boulders are seated on),
// and hands the caller the live `colliders`/`lots` arrays plus the scene graph.
//
// Two stubs make that possible, and both are checked for the thing they could silently break:
//   · a recording 2D canvas context — props.js/terrain.js paint albedo and normal maps for their
//     materials. The maps are texture payloads, never geometry inputs: the only pixel array written
//     in the world modules is `createImageData(...).data`, which the code fills itself in JS
//     (terrain.js:172-174), so a no-op context cannot move a vertex. `pixelsWritten` counts it.
//   · a disk-backed fetch for `./assets/*.glb`, so `GLTFLoader` gets real bytes.
//
// THE PROOF THAT THE STUBS DO NOT MOVE ANYTHING: `--selfcheck` re-derives the collider census and
// compares it, line for line, with the census a live page recorded (tools/logs/census-work.txt, the
// CDP probe result whose `census` array holds every disc as "id x z r kind"). Same ids, same centres
// to the millimetre the census prints, same radii. If the offline world and the shipped world
// disagree on a single disc, this file says so and exits 2 rather than measuring a different island.
//
// Usage:
//   node tools/offline-world.mjs --selfcheck [census-file]
//   import { buildOfflineWorld } from './offline-world.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── the DOM the world modules ask for, and nothing else ───
const stats = { canvasCreated: 0, ctxCalls: 0, pixelsWritten: 0, glbReads: 0, imageLoads: 0 };

function makeCtx2D(cv) {
  const gradient = { addColorStop() {} };
  const target = {
    canvas: cv,
    save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {},
    moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, ellipse() {},
    rect() {}, roundRect() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {}, clearRect() {},
    translate() {}, rotate() {}, scale() {}, transform() {}, setTransform() {}, resetTransform() {},
    drawImage() {}, fillText() {}, strokeText() {}, putImageData() {},
    createLinearGradient: () => gradient, createRadialGradient: () => gradient,
    createConicGradient: () => gradient, createPattern: () => null,
    measureText: () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createImageData: (w, h) => { stats.pixelsWritten++; return { width: w, height: h,
      data: new Uint8ClampedArray(w * h * 4) }; },
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    __props: {},
  };
  return new Proxy(target, {
    get(o, k) {
      if (k in o) { if (typeof o[k] === 'function') stats.ctxCalls++; return o[k]; }
      if (k === 'then') return undefined;                       // never let a ctx look thenable
      stats.ctxCalls++;
      return (...a) => { o['__set ' + String(k)]; return undefined; };
    },
    set(o, k, v) { o[k] = v; return true; },
  });
}

function makeCanvas() {
  stats.canvasCreated++;
  const cv = { width: 300, height: 150, style: {}, nodeType: 1 };
  cv.getContext = () => makeCtx2D(cv);
  cv.toDataURL = () => 'data:,';
  return cv;
}

function makeImage() {
  stats.imageLoads++;
  const img = { width: 0, height: 0, naturalWidth: 1, naturalHeight: 1, complete: false,
    style: {}, nodeType: 1, setAttribute() {}, addEventListener(t, f) { (img._h[t] ||= []).push(f); },
    removeEventListener() {}, dispatch() {}, _h: {} };
  // three sets `src` and waits for the load event; fire it on the next tick with a 1×1 stand-in.
  Object.defineProperty(img, 'src', { set(v) { img._src = v;
    queueMicrotask(() => { img.complete = true; img.width = img.naturalWidth = 1;
      img.height = img.naturalHeight = 1; for (const f of (img._h.load || [])) f({ target: img }); }); },
    get() { return img._src; } });
  return img;
}

export function installDomStub() {
  if (globalThis.__rsbOffline) return stats;
  globalThis.__rsbOffline = true;
  const doc = {
    createElement: tag => (tag === 'canvas' ? makeCanvas() : { tagName: tag, style: {},
      appendChild() {}, setAttribute() {}, addEventListener() {} }),
    createElementNS: (ns, tag) => (tag === 'img' ? makeImage() : doc.createElement(tag)),
    createElementNS_: undefined,
    addEventListener() {}, removeEventListener() {},
    body: { appendChild() {}, style: {} },
    documentElement: { style: {}, clientWidth: 1280, clientHeight: 720 },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    fonts: { ready: Promise.resolve(), add() {}, check: () => true },
    cookie: '', hidden: true, visibilityState: 'hidden',
  };
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  // Node 24 ships a real `globalThis.navigator` with only a getter, so it has to be redefined, not
  // assigned. Only the fields the world modules read are put back.
  if (!globalThis.navigator?.userAgent) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true,
      value: { userAgent: 'node', hardwareConcurrency: 8, maxTouchPoints: 0, language: 'en' } });
  }
  globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame ||
    (cb => setTimeout(() => cb(performance.now()), 0));
  // Node has a real fetch, which cannot resolve a bare path — the disk-backed one below always wins.
  {
    // three's FileLoader builds `new Request(url, …)` before it calls fetch, and the real Request
    // rejects a relative specifier in Node ("./assets/habitat_dome.glb" is a valid URL on a page and
    // an invalid one here). So Request is replaced by a lenient holder that keeps the string the
    // disk-backed fetch below resolves. Only the URL is read; the response object is hand-made.
    Object.defineProperty(globalThis, 'Request', { configurable: true, writable: true,
      value: class OfflineRequest { constructor(input) { this.url = String(input?.url ?? input); } } });
    globalThis.fetch = async (url, opt) => {
      const u = String(typeof url === 'object' ? url.url : url);
      let p = u.replace(/^https?:\/\/[^/]+/, '').replace(/^\.\//, '/').split('?')[0];
      const cand = [path.join(ROOT, 'public' + p), path.join(ROOT, p)];
      for (const c of cand) if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        if (c.endsWith('.glb')) stats.glbReads++;
        const buf = fs.readFileSync(c);
        return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(
          buf.byteOffset, buf.byteOffset + buf.byteLength),
          text: async () => buf.toString('utf8'), json: async () => JSON.parse(buf.toString('utf8')),
          headers: { get: () => null } };
      }
      throw new Error(`offline-fetch: no file for ${u} (tried ${cand.join(', ')})`);
    };
    globalThis.__rsbMissingAsset = new Set();
  }
  return stats;
}

// ─── the world, in the order main.js builds it ───
// `sky` is off by default because it costs nothing to add but changes the scene graph: with
// `sky: true` the build follows main.js:249-264 exactly (createSky BEFORE createTerrain), so the
// scene's own child indices — and therefore `tools/disc-audit-probe.js`'s root keys `Mesh#0`,
// `terrain#1`, `Group#2`, `rock-scatter#3`, `stone-field#4` — match a live page reading one for one.
export async function buildOfflineWorld({ rocks = true, stones = true, sky = false } = {}) {
  installDomStub();
  const THREE = await import('three');
  const { createSky } = await import('../src/world/sky.js');
  const { createTerrain, createRocks, createStones } = await import('../src/world/terrain.js');
  const { buildBase } = await import('../src/world/props.js');
  const scene = new THREE.Scene();
  if (sky) createSky(scene);
  const terrain = createTerrain(scene);
  const base = await buildBase(scene, { particles: 1 });
  terrain.regrade();
  const scatter = rocks ? await createRocks(scene, base.colliders) : [];
  if (stones) createStones(scene);
  if (rocks) base.colliders.push(...scatter);
  // main.js:274, one line after the scatter joins the collision set: the three deliberately buried
  // mineral sites are dressed for the first frame, and `syncSiteWall` (main.js:777) takes their discs
  // OUT of the list the solver reads while the spire is under its drift. The census probe runs against
  // that list, so a harness that stops at the build has ten discs the shipped page does not —
  // `samples:site6/7/8#N`. The membership rule is `base.siteWallUp`, the same function main.js calls,
  // so this line cannot drift from the page it copies.
  for (const s of base.samples) {
    s.wallUp = base.siteWallUp(s);
    // The other half of the same `k`. Taking only the membership above leaves the spire drawn at its
    // raised height over sand the page has buried it under, and the exposure census then counts the
    // faces of a rock this frame never renders: the run before this line existed filed 407 exposed
    // band faces under drawn root `Group`, and its two worst cells were both `crystal001`, at 8.63 m
    // and 8.57 m past (`tools/logs/phantom-census-2026-09-27-full.log:63,64,70`).
    s.crystal.position.y = base.siteSinkY(s);
    if (s.wallUp) continue;
    for (const d of s.discs) {
      const i = base.colliders.indexOf(d);
      if (i >= 0) base.colliders.splice(i, 1);
    }
  }
  scene.updateMatrixWorld(true);
  // `stone-field` is 88 THREE.LOD tiles, each holding the SAME 3 600 chips twice — once at 80 facets,
  // once at 20 (terrain.js:1268-1282). The renderer picks a level per frame in `LOD.update(camera)`; a
  // headless build has no camera and calls nothing, so both children stay `visible` and a sweep walks
  // 176 InstancedMeshes / 7 200 instances where the page drew 88 / 3 600: one pebble counted twice.
  // Resolve to the near level — the one a player at driving distance sees — and hand the hidden level
  // count to the caller. That choice has a consequence worth stating: this harness always takes level
  // 0, while the shipped page takes it only inside STONE_LOD_D (45 m, terrain.js:1281). So a face this
  // sweep flags inside a far tile is a triangle the page did not draw at the camera point it measured
  // from, and the census now says so per face instead of leaving the two readings to be argued apart
  // (`out.exposure.faces[].lod` / `out.exposure.ruler.notDrawnAtPageCam` in tools/phantom-census.mjs,
  // which is what disposed of the last 5 `stone-field` faces: 2 chips, 0.002-0.009 m into the hull's
  // swept volume, in tiles 71.9 m and 77 m out). Equal instance counts do not settle it — both levels
  // hold the same instances, only with different triangles per chip.
  let lodTiles = 0, lodLevelsHidden = 0;
  scene.traverse(o => {
    if (!o.isLOD || !o.levels?.length) return;
    lodTiles++;
    for (const lvl of o.levels.slice(1)) {
      if (lvl.object && lvl.object.visible) { lvl.object.visible = false; lodLevelsHidden++; }
    }
  });
  stats.lodTiles = lodTiles;
  stats.lodLevelsHidden = lodLevelsHidden;
  return { THREE, scene, terrain, base, colliders: base.colliders, lots: base.lots, stats };
}

// ─── self-check against the census a live page recorded ───
export async function selfcheck(censusFile = path.join(ROOT, 'tools/logs/census-work.txt')) {
  const w = await buildOfflineWorld();
  const raw = fs.readFileSync(censusFile, 'utf8');
  const i = raw.indexOf('RESULT "');
  if (i < 0) throw new Error(`no RESULT line in ${censusFile}`);
  const payload = JSON.parse(JSON.parse(raw.slice(i + 7).split('\n')[0]));
  const live = new Map();
  for (const line of payload.census) {
    const [id, x, z, r, kind] = line.split(/\s+/);
    const k = `${id}|${x}|${z}|${r}`;
    live.set(k, (live.get(k) || 0) + 1);
  }
  const mine = new Map();
  // The same population the probe enumerated, by the same test it used (tools/logs/probe-census.js:6,
  // `c.floor === undefined ? 'solid' : 'floor'`). Dropping the floored boxes on this side only was how
  // the first selfcheck reported the 9 m `watch:deck` drum as a live-only disc: the two sides were not
  // counting the same set, so the diff measured the harness rather than the world.
  for (const c of w.colliders) {
    const k = `${c.prop || '?'}|${(+c.x).toFixed(3)}|${(+c.z).toFixed(3)}|${(+c.r).toFixed(3)}`;
    mine.set(k, (mine.get(k) || 0) + 1);
  }
  const onlyLive = [], onlyMine = [];
  for (const [k, n] of live) { const m = mine.get(k) || 0;
    if (m < n) onlyLive.push(`${k} ×${n - m}`);
    if (m > n) onlyMine.push(`${k} ×${m - n}`); }
  for (const [k, n] of mine) if (!live.has(k)) onlyMine.push(`${k} ×${n}`);
  const count = m => [...m.values()].reduce((a, b) => a + b, 0);
  return { colliders: w.colliders.length, censusLines: payload.census.length,
    discs: count(mine), censusDiscs: count(live), distinct: live.size,
    onlyLive: onlyLive.length, onlyMine: onlyMine.length,
    onlyLiveSample: onlyLive.slice(0, 12), onlyMineSample: onlyMine.slice(0, 12),
    stats: w.stats };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (arg === '--selfcheck') {
    const r = await selfcheck(process.argv[3]);
    console.log(JSON.stringify(r, null, 1));
    process.exit(r.onlyLive === 0 && r.onlyMine === 0 ? 0 : 2);
  }
  console.log('usage: node tools/offline-world.mjs --selfcheck [census-file]');
}
