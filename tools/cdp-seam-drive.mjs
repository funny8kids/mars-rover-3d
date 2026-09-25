// usage: node tools/cdp-seam-drive.mjs <url|-> [port=9333] [only=<zone-regex>] [what=seams|traps]
//
// The driven half of the 「碰撞体与外观不一致 / 夹缝清零」 gate (goal 【C】3, and 【A】2's
// "可进入但不可退出").
//
// `plan().tight` counts pairs of collision discs that come inside CORRIDOR (3.2 m) of each other,
// and `scan().seams` is the same population narrowed to the ones next to drive-reached ground. On
// 2026-09-25 that census holds 45 pairs / 33 seams, and every one of them is a place where the
// rover's hull can touch two structures at once. `scan()` deliberately stopped judging those by
// geometry alone: its own comment says "the driven test is the consumer now". This tool is that
// consumer. It parks the rover on each pinch stance the audit names and asks the shipped physics,
// with the shipped input path, whether a player can drive out — and it classifies the answer:
//
//   released   a forward throttle gets ≥ RELEASE metres away, no rescue needed
//   reversed   only the reverse gear (or a turn begun in reverse) got out — the soak failure's shape
//   rescued    the body did move, but only after the unstick state machine fired ⇒ the pocket is real
//   pinned     nothing got out inside the budget
//
// Anything but `released` is a defect to re-site, and the exit code is non-zero until the whole
// census reads `released`. The point of driving rather than measuring is that the analytic seam rule
// cannot tell a lamp post from a hangar; the rover can.
import fs from 'fs';

const [,, urlArg, portStr, onlyArg, whatArg] = process.argv;
const port = Number(portStr || 9333);
const only = onlyArg ? new RegExp(onlyArg.replace(/^only=/, '')) : null;
// `seams` (the default) is the population of two discs close enough to touch the hull at once.
// `traps` is the other half of 【A】2's ask — "可进入但不可退出": a dead-end run the flood fill can
// reach and the rover cannot pivot out of, which no pair rule can see because the two walls in those
// stances are 7-11 m apart and read as a lane. Both records carry a, b, gap, at and axis, so the
// attempt ladder below is the same rig pointed at a different stance list.
const what = whatArg ? whatArg.replace(/^what=/, '') : 'seams';
// Measured, not guessed: the gate↔ring-315 crease releases the rover at 5.79 m, but only after
// ~7 s of *wall clock* from a dead stop while it scrapes both faces (4.8 s of sim buys 1.3 m). A
// 3.5 s budget called that stance "pinned" — so the budget has to clear the slowest honest escape,
// and an attempt that is going nowhere still costs the full window.
const ATTEMPTS = 9000;
const RELEASE = 4;       // metres from the stance that counts as out
const T0 = Date.now();
const clock = () => `t+${((Date.now() - T0) / 1000).toFixed(0)}s`;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /5173/.test(t.url)) || list.find(t => t.type === 'page');
if (!page) { console.log('NO_PAGE_TARGET'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map(); let exceptions = 0;
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions++;
    console.log('[EXCEPTION] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
};
await new Promise(r => ws.onopen = r);
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
// `http.server` sends no Cache-Control, so a re-navigation can hand the page the *previous* build's
// modules and an identical table reads as "my props.js edit did nothing".
await send('Network.setCacheDisabled', { cacheDisabled: true });
if (urlArg !== '-') await send('Page.navigate', { url: urlArg });

const evaluate = async (expr, timeout = 90000) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout });
  if (r.exceptionDetails) throw new Error('EVAL ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const readyDeadline = Date.now() + 240000;
for (;;) {
  const ok = await evaluate(`!!(window.__RSB && window.__RSB.state && window.__RSB.state.started === true && window.__RSB.env)`);
  if (ok === true) break;
  if (Date.now() > readyDeadline) { console.log('READY_TIMEOUT'); process.exit(2); }
  await sleep(1000);
}
console.log(`${clock()} READY ${urlArg === '-' ? page.url : urlArg}`);
// Do NOT pause the harness clock or step the sim by hand from here. qa_boot.html replaces
// `performance.now` with its virtual clock (measured: `nowFn === "() => vt"`, and vt runs ~2× real
// time while the pump is live), and input.js ramps the pedal against `performance.now()` — so with
// `__QA.pause()` the clock freezes, `inp.gas` never leaves 0 and every stance reads "moved 0.0 m",
// which the first run of this tool reported as eight pinned rovers on a stance that in fact creeps
// out at 2.9 m/s. Driving through the shipped rAF loop is both the honest rig and the working one.
await evaluate(`window.__QA?.resume(); 0`);


// One stance per seam candidate, plus the discs that make it. The discs cannot be looked up by
// name: one prop id carries several `coverDiscs` entries (`hub:spaceport-gate#1` alone owns discs
// at (5.2,-19.6) r1.46, (5.2,-16.7) r1.46 and (9.2,-13.5) r2.10), so the first match is a different
// structure than the one the crease is against — and the first run of this tool framed its headings
// off exactly that wrong disc. The binding disc is the one the hull actually touches at the stance:
// |dist(stance, centre) − (r + BODY_R)| minimal, which is what a wheel feels.


const stanceExpr = `(()=>{
  const R = window.__RSB, BODY = 1.6, solids = R.solids().filter(c => c.floor === undefined);
  const binder = (name, x, z) => {
    let best = null, bd = 9;
    for (const c of solids) {
      if ((c.prop || c.name) !== name) continue;
      const d = Math.abs(Math.hypot(x - c.x, z - c.z) - c.r - BODY);
      if (d < bd) { bd = d; best = c; }
    }
    return best ? [best.x, best.z, best.r, +bd.toFixed(2)] : null;
  };
  return JSON.stringify(R.scan().${what}.map(x => ({
    a: x.a, b: x.b, gap: x.gap, at: x.at, axis: x.axis,
    A: binder(x.a, x.at[0], x.at[1]), B: binder(x.b, x.at[0], x.at[1]),
  })));
})()`;
const rows = JSON.parse(await evaluate(stanceExpr)).filter(r => !only || only.test(`${r.a} ${r.b}`));
console.log(`${clock()} CENSUS ${rows.length} ${what} stances, ${ATTEMPTS} ms of wall clock per attempt, release at ${RELEASE} m`);

// The attempt ladder, in the order a player would think of them. `in` is the heading that points at
// the crease — the arrival a driver actually has when they drive into a joint crooked, which is the
// shape the acceptance soak failed in.
const DRIVE = `(()=>{
  const R = window.__RSB;
  window.__DRV = async (sx, sz, yaw, keys, budgetMs) => {
    const out = R.place(sx, sz, yaw);
    const ev0 = (R.unstick().events || []).length;
    await new Promise(r => setTimeout(r, 120));
    const k = R.input().keys; keys.forEach(x => k.add(x));
    let maxV = 0, gas = 0, moved = 0, rescueSeen = null, simMs = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      await new Promise(r => setTimeout(r, 50));
      simMs = performance.now() - t0;
      const p = R.phys(), i = R.input(), u = R.unstick();
      gas = Math.max(gas, Math.abs(i.gas) || 0);
      maxV = Math.max(maxV, Math.hypot(p.vx, p.vz));
      moved = Math.max(moved, Math.hypot(p.x - sx, p.z - sz));
      if (u.phase) { rescueSeen = u.phase; break; }
      if (moved >= ${RELEASE}) break;
    }
    keys.forEach(x => k.delete(x));
    await new Promise(r => setTimeout(r, 60));
    const p = R.phys();
    return { end: [+p.x.toFixed(2), +p.z.toFixed(2)], d: +Math.hypot(p.x - sx, p.z - sz).toFixed(2),
             moved: +moved.toFixed(2), v: +p.speed.toFixed(1), maxV: +maxV.toFixed(1), gas: +gas.toFixed(2),
             simMs: Math.round(simMs), rescueSeen, evDelta: (R.unstick().events || []).length - ev0,
             touching: out.touching };
  };
  return 'ok';
})()`;
await evaluate(DRIVE);

const verdicts = [];
for (const [i, r] of rows.entries()) {
  if (!r.A || !r.B) { console.log(`${clock()} #${i} SKIP unresolved discs ${r.a} ${r.b}`); continue; }
  // outward bisector of the two hull faces: the direction a driver hopes for; `in` is its opposite.
  const [sx, sz] = r.at;
  const nA = [sx - r.A[0], sz - r.A[1]], la = Math.hypot(...nA) || 1;
  const nB = [sx - r.B[0], sz - r.B[1]], lb = Math.hypot(...nB) || 1;
  const ox = nA[0] / la + nB[0] / lb, oz = nA[1] / la + nB[1] / lb;
  const outYaw = Math.atan2(ox, oz);           // phys.yaw is measured from +z towards +x
  const inYaw = outYaw + Math.PI;
  const axisYaw = Math.atan2(r.axis[0], r.axis[1]);
  // There is no reverse-from-standstill in this game (a KeyS hold at zero speed leaves `gas` at 0 —
  // measured), so every attempt is throttle-forward on some heading, which is also what a player
  // reaching for a way out actually does.
  const tries = [
    ['out',      outYaw,                ['KeyW']],
    ['in',       inYaw,                 ['KeyW']],
    ['in+left',  inYaw,                 ['KeyW', 'KeyA']],
    ['in+right', inYaw,                 ['KeyW', 'KeyD']],
    ['axis',     axisYaw,               ['KeyW']],
    ['cross',    outYaw + Math.PI / 2,  ['KeyW']],
  ];
  let best = null;
  const seen = [];
  const binding = `A ${r.A[0].toFixed(1)},${r.A[1].toFixed(1)}r${r.A[2].toFixed(2)} (Δ${r.A[3]}) | B ${r.B[0].toFixed(1)},${r.B[1].toFixed(1)}r${r.B[2].toFixed(2)} (Δ${r.B[3]})`;
  for (const [tag, yaw, keys] of tries) {
    const res = await evaluate(
      `window.__DRV(${sx},${sz},${yaw},${JSON.stringify(keys)},${ATTEMPTS})`, 90000);
    const fwd = keys[0] === 'KeyW';
    seen.push(`${tag}:${res.moved.toFixed(1)}m/g${res.gas.toFixed(1)}${res.rescueSeen ? '!rescue' : ''}${res.simMs >= ATTEMPTS - 200 ? '=full' : ''}`);
    const got = res.moved >= RELEASE;
    if (got && (!best || (best.fwd && !fwd))) best = { tag, fwd, ...res };
    if (best && best.fwd) break;
  }
  const reached = (m) => parseFloat(String(m).match(/:([\d.]+)m/)[1]);
  const v = !best ? 'pinned' : (best.rescueSeen || best.evDelta) ? 'rescued' : best.fwd ? 'released' : 'reversed';
  verdicts.push({ i, a: r.a, b: r.b, gap: r.gap, at: r.at, v, tag: best?.tag, binding,
                  moved: best?.moved ?? Math.max(...seen.map(reached)) });
  console.log(`${clock()} #${String(i).padStart(2)} ${v.toUpperCase().padEnd(9)} gap ${r.gap.toFixed(2)}m ${r.a} | ${r.b} at ${r.at} via ${best?.tag || '-'} ${best?.moved ?? '-'}m  [${seen.join(' ')}]  ${binding}`);
}

const tally = verdicts.reduce((m, v) => (m[v.v] = (m[v.v] || 0) + 1, m), {});
const bad = verdicts.filter(v => v.v !== 'released');
console.log(`${clock()} TALLY ${JSON.stringify(tally)} of ${verdicts.length} stances`);
console.log(`${clock()} NONRELEASED ${bad.map(v => `#${v.i} ${v.a}|${v.b} ${v.v}`).join(' ; ') || 'none'}`);
if (exceptions) console.log(`${clock()} EXCEPTIONS ${exceptions}`);
console.log(`${clock()} ${what.toUpperCase()}-DRIVE VERDICT ${(!bad.length && !exceptions && verdicts.length) ? 'PASS' : 'FAIL'}`);
process.exitCode = (!bad.length && !exceptions && verdicts.length) ? 0 : 1;
await send('Runtime.evaluate', { expression: `window.__QA?.resume(); 0` }).catch(() => {});
ws.close();
process.exit(process.exitCode);