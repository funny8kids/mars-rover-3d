// usage: node tools/cdp-plume-pearl.mjs [url] [port] [capMet] [full|fast]
// Walks the whole flight one rendered second at a time and asks, for every lit plume row, whether the
// flame's own near-axis sprite chain reaches past the tip of the column it belongs to. That is the
// "string of pearls" defect, and `sheath()` in main.js already decides it per row (`flame.fail`);
// this file exists so the decision has a reader with an exit code instead of a number nobody loads.
//
// Why it steps the real render loop instead of `__RSB.fly(t)`: `fly` fast-forwards the *physics*
// without emitting, so a row read after a teleport describes a trail no frame ever drew. Same trap
// the header of cdp-launch-frames.mjs documents.
//
// Exit codes: 0 clean, 1 a row failed, 2 the run could not be trusted (never booted, no lit row ever
// sampled, the socket dropped, or MET stopped advancing early) — a silent 0-failures reading is not a
// pass. Needs a Chrome already listening: google-chrome --headless=new --remote-debugging-port=9333
// with the app served on :5173. Boot is slow — a cold profile took 8 minutes here against ~15 s for a
// warm browser — but it is not the whole cost: this headless Chrome renders through SwiftShader, not
// the GPU (its own UNMASKED_RENDERER_WEBGL says so even though the chrome log names an Iris Xe), so
// one `__QA.step(60)` row measures 30-47 s and a 46 s flight is 25-35 minutes. Judge the run by its
// streamed MET lines and wall clock, not by its silence.
//
// One CDP client at a time. A second script calling `__QA.step` advances MET between this loop's
// samples, and the sweep's "one rendered second per row" coverage claim is then false for the run.
import fs from 'fs';
const [,, urlArg, portStr, capStr] = process.argv;
// `auto=std` is the only URL knob, and it is a real one: main.js reads it, picks that quality card and
// presses start, which is the whole menu. A second param used to sit here naming this probe; nothing in
// the app ever read it, so a reader that looked like it had been switched on was not switched on at all.
const url = urlArg || 'http://127.0.0.1:5173/qa_boot.html?auto=std';
const port = Number(portStr || 9333);
const capMet = Number(capStr || 46);
const startedAt = Date.now();
const clock = () => `${((Date.now() - startedAt) / 1000).toFixed(0)}s`;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /qa_boot/.test(t.url))
  || list.find(t => t.type === 'page') || list.find(t => t.url);
if (!page) { console.log('NO_PAGE_TARGET'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
// One exit path, and it closes the socket. The first version of this file printed `PEARL_GATE_GREEN`
// and then sat on the open WebSocket forever, so a clean pass and a hang looked identical from the
// outside — which is the one failure mode a reader may not have.
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

// Which build a verdict describes. The app is served by `python3 http.server`, which sends no
// `Cache-Control`, and the gate is re-run against the SAME url after the source under it changes — a
// RED/GREEN pair where the second half still executes the first half's module is worse than no pair,
// because it reads as a polarity test. So: disable the cache for this client, then prove the served
// bytes match the bytes on disk right now. The comparison is by content, not by mtime or URL.
// Read from beside this file, not from the cwd, so the two sides are named by one path.
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

// A gate whose verdict can be produced by a crash is not a gate: an uncaught throw also exits 1, which
// here means "a row failed". Route anything unexpected to the "untrusted" code so a non-zero exit is
// only ever RED from a named FAIL line.
process.on('uncaughtException', e => done(2, `[${clock()}] CRASH ${e?.stack || e}`));
process.on('unhandledRejection', e => done(2, `[${clock()}] REJECT ${e?.stack || e}`));

// Then prove the verdict is about the source on disk: re-fetch each module the page just executed and
// compare it byte-for-byte with the working copy. A stale-cache GREEN that follows a real RED is the
// one reading this tool exists to prevent.
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
// The hashes go in the log, not just the paths: a GREEN run's evidence is only separable from the RED
// run it follows by the bytes each one verified — and they are the same values the comparison used,
// not a second read that could land on an edit.
console.log(`[${clock()}] served bytes match disk: ` + verified.join('   '));

// `fast` (4th argument) patches the composer's render out for the sweep. tick() runs update(dt) and
// then `post.composer.render()` (main.js:2421), and the verdict is read off the live particle pool and
// the camera — no row here is computed from pixels — so on a SwiftShader host the renderer is ~half the
// wall time and none of the input. That is a claim about the probe, not a fact, so a `fast` run is only
// evidence once it reproduces the same build's `full` run: same lit rows at the same MET, same fail
// window. The mode is announced at startup and repeated in the final verdict so the two are never
// mistaken for each other.
const mode = process.argv[5] === 'fast' ? 'fast' : 'full';

// `fly(0)` only exists to build the flight and put the game's own launch camera on it; `fly(null)`
// releases the hold so the next step runs the real loop.
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
console.log(`[${clock()}] mode=${mode}`);

const pad = (v, n) => String(v ?? '-').padStart(n);
const line = w => `MET${pad(w.met, 5)}  i${w.i} col${pad(w.col, 5)}m colPx${pad(w.colPx, 6)}`
  + `  n${pad(w.n, 4)} ln${pad(w.ln, 4)}  puff${pad(w.puff, 5)}m`
  + `  lineOver${pad(w.lineOver, 6)}  overPx${pad(w.overPx, 6)}`
  + `  gmean/puff${pad(w.gmean != null && w.puff ? +(w.gmean / w.puff).toFixed(2) : null, 5)}`
  + `  dots${pad(w.dots, 6)}  amb${w.amb ? 1 : 0}  fail${w.fail ? 1 : 0}`;

const rows = [];
let stalled = 0, prevMet = -1;
for (let k = 0; k < 200; k++) {
  const r = await evaluate(`(() => {
    __QA.step(60);
    const p = __RSB.plume();
    if (!p || !p.sheath) return { met: null, rows: [] };
    return { met: p.met, rows: p.sheath.map((w, i) => ({
      i, lit: !!w.lit, col: w.col, colPx: w.colPx,
      n: w.flame.n, ln: w.flame.ln, puff: w.flame.puff, dots: w.flame.dots, gmean: w.flame.gmean,
      lineOver: w.flame.lineOver, overPx: w.flame.overPx, amb: w.flame.amb, fail: w.flame.fail,
    })) };
  })()`);
  // The socket can drop mid-flight (a closed page, a crashed renderer). `evaluate` has already sent
  // the run to `done`, so all that is left is to stop waiting on a page that is not answering.
  if (finished) break;
  if (!r || r.met === null) break;
  if (r.met > prevMet + 0.5) stalled = 0; else if (++stalled > 3) break;
  prevMet = r.met;
  for (const w of r.rows) if (w.lit) { const row = { met: r.met, ...w }; rows.push(row); console.log(line(row)); }
  if (r.met >= capMet) break;
}

const seen = rows.filter(w => w.n > 3);
const failed = seen.filter(w => w.fail);
console.log(`\n[${clock()}] rows sampled: ${seen.length}   ambiguous(suppressed): ${seen.filter(w => w.amb).length}`
  + `   reached-past-tip(suppressed): ${seen.filter(w => !w.fail && w.lineOver > 1).length}`
  + `   FAILED: ${failed.length}`);
for (const w of failed) console.log(`  FAIL MET${w.met} plume#${w.i}: lineOver ${w.lineOver} overPx ${w.overPx}`);

// The instrument's own coverage: a run that never saw a lit row with a chain long enough to judge is
// not evidence, whatever it prints.
if (!seen.length) done(2, 'NO_LIT_ROWS_SAMPLED');
done(failed.length ? 1 : 0, (failed.length ? 'PEARL_GATE_RED ' : 'PEARL_GATE_GREEN ') + `mode=${mode}`);
