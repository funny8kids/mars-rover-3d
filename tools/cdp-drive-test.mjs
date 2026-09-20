import fs from 'fs';

// usage: node tools/cdp-drive-test.mjs <url> <outDir> [port] [profile]
// Acceptance probe for "驾驶手感流畅、不穿模、不翻车失控": holds real keys via CDP
// Input.dispatchKeyEvent (trusted events, so it proves the shipped input path works),
// samples the physics every ~350 ms and reports ground penetration, pitch/roll clamps
// and airtime, and shoots frames along the way.
// profiles: deck (drive onto the watch platform) | drift (handbrake slide on flats)
//           crater | climb-out | soak (continuous 5+ min multi-zone drive, auto-verdict)
const [,, url, outDir, portStr, profileName = 'deck'] = process.argv;
const port = Number(portStr || 9333);
fs.mkdirSync(outDir, { recursive: true });
let exceptions = 0;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /localhost/.test(t.url)) || list.find(t => t.type === 'page');

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
  if (msg.method === 'Runtime.exceptionThrown') {
    exceptions++;
    console.log('[EXCEPTION] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
};
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){ try { return eval(${JSON.stringify(expr)}); } catch (e) { return 'ERR ' + e.message; } })()`,
    returnByValue: true,
  });
  return r.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(s.data, 'base64'));
  console.log('SHOT ' + name);
};

const KEYS = {
  KeyW: { key: 'w', code: 'KeyW', vk: 87 },
  KeyS: { key: 's', code: 'KeyS', vk: 83 },
  KeyA: { key: 'a', code: 'KeyA', vk: 65 },
  KeyD: { key: 'd', code: 'KeyD', vk: 68 },
  Space: { key: ' ', code: 'Space', vk: 32 },
};
async function down(code) {
  const k = KEYS[code];
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
}
async function up(code) {
  const k = KEYS[code];
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
}
async function tap(code) { await down(code); await sleep(80); await up(code); }

await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
const deadline = Date.now() + 240000;
let ready = false;
while (Date.now() < deadline) {
  await sleep(500);
  if (await evaluate('!!(window.__RSB && window.__RSB.state.started === true)') === true) { ready = true; break; }
}
if (!ready) { console.log('READY_TIMEOUT'); process.exit(2); }
await send('Page.bringToFront');
console.log('READY ' + JSON.stringify(await evaluate('JSON.stringify(__RSB.state)')));

// does a synthetic (non-trusted) event reach the game's listener at all?
console.log('SYNTHETIC_TEST ' + await evaluate(`(()=>{
  let hits = 0; const h = () => hits++;
  addEventListener('keydown', h);
  dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyW'}));
  removeEventListener('keydown', h);
  return JSON.stringify({syntheticListenerHits: hits, pageFocused: document.hasFocus()});
})()`));

// one sample line: x z rootY | surface stand | penS penD | speed pitch roll | onFloor grounded trauma
// rootY is pose() — the height the mesh is actually drawn at, wheel centres one radius above it —
// so penS/penD are the honest "穿模?" reading: negative means geometry under the visible ground.
const SAMPLE = `(()=>{const p=__RSB.phys();const q=p.pose();const g=__RSB.ground(p.x,p.z);return [
  +p.x.toFixed(1),+p.z.toFixed(1),+q.y.toFixed(2),
  g.surface,g.stand,+(q.y-g.surface).toFixed(2),+(q.y-g.stand).toFixed(2),
  +p.speed.toFixed(1),+p.pitch.toFixed(3),+p.roll.toFixed(3),
  p.onFloor?1:0,p.grounded?1:0,+p.trauma.toFixed(2)].join(' | ')})()`;

async function run(label, expr, samples, everyMs, shots, until, sampleExpr) {
  console.log('CASE ' + label + ' => ' + await evaluate(expr));
  for (let i = 0; i < samples; i++) {
    await sleep(everyMs);
    console.log(`  s${String(i).padStart(2, '0')} ${await evaluate(sampleExpr || SAMPLE)}`);
    if (shots?.includes(i)) await shot(`${label}_${i}`);
    // headless rendering runs in slow motion (dt is clamped, fps swings 20-100), so the
    // wall-clock sample count cannot be the exit condition — drive on measured state instead
    if (until && await evaluate(until) === true) { console.log('  reached: ' + until); return i; }
  }
  return -1;
}

if (profileName === 'drift') {
  await run('straight', `__RSB.warp(10,-70,false,0); 'warp to flats'`, 10, 400);
  await down('KeyW');
  await run('accel', `'W held (trusted)'`, 14, 400, [6, 13]);
  await down('KeyD');
  await run('turn', `'W+D held'`, 10, 400, [9]);
  await down('Space');
  await run('handbrake-drift', `'W+D+Space held'`, 10, 400, [9]);
  await up('Space'); await up('KeyD'); await up('KeyW');
  await run('release', `'all keys released'`, 8, 400);
} else if (profileName === 'crater') {
  // the wild craters are the steepest drivable-looking geometry in the world, and being able
  // to get in but not back out is a stuck bug. Descend, then climb the far wall.
  await run('rim-warp', `__RSB.warp(480, 505, false, 0); __RSB.phys().yaw = Math.PI; 'warped on the rim, facing -z into the bowl'`, 4, 400);
  await down('KeyW');
  await run('descend', `'W held into the crater'`, 30, 400, [12, 24], `__RSB.phys().speed > 9 && Math.abs(__RSB.phys().z - 430) < 40`);
  await up('KeyW');
  await run('out-try', `'W held again, trying the far wall'`, 45, 400, [14, 29, 44], `Math.abs(__RSB.phys().z - 430) > 95`);
  await up('KeyW');
  await run('coast', `'released'`, 6, 400);
} else if (profileName === 'climb-out') {
  // The slow-motion budget is the whole story here: driving across a 170 m crater at ~10 m/s
  // needs far more samples than a wall-clock loop suggests. Start in the bowl and prove the
  // graded walls are climbable rather than a one-way trap.
  await run('bowl-warp', `__RSB.warp(480, 430, false, 0); __RSB.phys().yaw = Math.PI; 'warped in the bowl centre, facing the far rim'`, 4, 400, null, null);
  await down('KeyW');
  await run('climb', `'W held from the low point'`, 220, 350, [40, 100, 160, 219], `__RSB.phys().z < 335`);
  await up('KeyW');
  await run('escape-coast', `'released on the far rim'`, 8, 400);
} else if (profileName === 'soak') {
  // One more number the short profiles cannot give: the acceptance line 「无严重 bug，可连续
  // 体验 5–10 分钟」 asks for a single page session that keeps driving through several zones.
  // Every sample is checked for ground penetration, tilt past the clamp, non-finite state,
  // throttle-held-but-not-moving, and uncaught exceptions; the verdict is computed, not eyeballed.
  const EVERY = 350;
  const MIN_SECONDS = 300;
  const SAMPLE_SOAK = `(()=>{const p=__RSB.phys(),q=p.pose(),g=__RSB.ground(p.x,p.z);const r={
    leg:window.__LEG|0,drv:window.__DRV|0,x:+p.x.toFixed(1),z:+p.z.toFixed(1),y:+q.y.toFixed(2),
    penS:+(q.y-g.surface).toFixed(2),penD:+(q.y-g.stand).toFixed(2),v:+p.speed.toFixed(1),
    pi:+p.pitch.toFixed(3),ro:+p.roll.toFixed(3),tr:+p.trauma.toFixed(2),
    air:p.grounded?0:1,fps:Number(__RSB.state.fps)||0};
    window.__SOAK.push(r);return Object.keys(r).map(k=>k+'='+r[k]).join(' ')})()`;
  const statExpr = leg => `(()=>{const a=window.__SOAK.filter(r=>${leg == null ? 'true' : `r.leg===${leg}`});const n=a.length;
    const mm=f=>{let mi=1e9,ma=-1e9;for(const r of a){const v=f(r);if(v<mi)mi=v;if(v>ma)ma=v;}return[mi,ma];};
    let pen=0,tilt=0,bad=0,run=0,runMax=0,runAt=null;
    for(const r of a){if(r.penS<-0.005)pen++;
      if(Math.abs(r.pi)>0.402||Math.abs(r.ro)>0.402)tilt++;
      if(![r.x,r.y,r.penS,r.v,r.pi,r.ro].every(Number.isFinite))bad++;
      if(r.drv&&r.v<0.6){run++;if(run>runMax){runMax=run;runAt=[r.x,r.z];}}else run=0;}
    const f=a.map(r=>r.fps).sort((p,q)=>p-q);
    return JSON.stringify({n,elapsedSec:+((performance.now()-window.__T0)/1000).toFixed(1),
      minPenS:mm(r=>r.penS)[0],minPenD:mm(r=>r.penD)[0],maxV:mm(r=>r.v)[1],
      maxPitch:+mm(r=>Math.abs(r.pi))[1].toFixed(3),maxRoll:+mm(r=>Math.abs(r.ro))[1].toFixed(3),
      maxTrauma:mm(r=>r.tr)[1],penSamples:pen,tiltSamples:tilt,nonFiniteSamples:bad,
      stuckRunSamples:runMax,stuckAt:runAt,airFrac:+(a.reduce((s,r)=>s+r.air,0)/n).toFixed(3),
      fpsMin:f[0],fpsMed:f[n>>1],fpsMax:f[n-1],last:[a[n-1].x,a[n-1].z]})})()`;
  let cur = 0;
  async function nextLeg(name, drv) {
    if (cur) console.log('STAT leg' + cur + ' ' + await evaluate(statExpr(cur)));
    cur++;
    await evaluate(`window.__LEG=${cur};window.__DRV=${drv};0`);
    console.log('--- LEG ' + cur + ' ' + name);
  }
  await evaluate(`window.__SOAK=[];window.__T0=performance.now();0`);
  await nextLeg('idle-settle', 0);
  await run('idle', `'no keys: boot settle'`, 20, EVERY, null, null, SAMPLE_SOAK);

  for (let cycle = 1; cycle <= 3; cycle++) {
    await nextLeg(`accel-${cycle}`, 1);
    await down('KeyW');
    await run(`accel-${cycle}`, `'W held, flats'`, 55, EVERY, null, null, SAMPLE_SOAK);
    await up('KeyW');
    await nextLeg(`hard-brake-${cycle}`, 0);
    await down('KeyS');
    await run(`brake-${cycle}`, `'S held to a full stop'`, 40, EVERY, null, `__RSB.phys().speed < 0.4`, SAMPLE_SOAK);
    await up('KeyS');
  }

  await nextLeg('deck-climb', 1);
  await run('deck-warp', `__RSB.warp(-95, -128, false, 0); 'warp 33m south of the deck'`, 2, EVERY, null, null, SAMPLE_SOAK);
  await down('KeyW');
  await run('deck', `'W onto the 4.5m platform'`, 60, EVERY, [20, 50], null, SAMPLE_SOAK);
  await up('KeyW');

  await nextLeg('crater-dive', 1);
  await run('crater-warp', `__RSB.warp(480, 505, false, 0); __RSB.phys().yaw = Math.PI; 'rim, facing into the bowl'`, 2, EVERY, null, null, SAMPLE_SOAK);
  await down('KeyW');
  await run('crater-in', `'W down into the crater'`, 80, EVERY, [30, 70], null, SAMPLE_SOAK);
  await up('KeyW');
  await nextLeg('crater-climb-out', 1);
  await down('KeyW');
  await run('crater-out', `'W up the far wall'`, 220, EVERY, [80, 160, 219], `__RSB.phys().z < 335`, SAMPLE_SOAK);
  await up('KeyW');

  await nextLeg('storm-zone', 1);
  await run('storm-warp', `__RSB.warp(500, -260, false, 0); 'west edge of the storm zone'`, 2, EVERY, null, null, SAMPLE_SOAK);
  await down('KeyW');
  await run('storm', `'W through the storm wall (heaviest particle budget)'`, 110, EVERY, [30, 70, 109], null, SAMPLE_SOAK);
  await up('KeyW');

  await nextLeg('drift-slide', 1);
  await down('KeyW'); await down('KeyD');
  await run('drift-approach', `'W+D'`, 25, EVERY, null, null, SAMPLE_SOAK);
  await down('Space');
  await run('drift', `'W+D+Space handbrake slide'`, 40, EVERY, [20, 39], null, SAMPLE_SOAK);
  await up('Space'); await up('KeyD'); await up('KeyW');

  await nextLeg('reverse', 1);
  await down('KeyS');
  await run('reverse', `'S reverse under power'`, 45, EVERY, null, null, SAMPLE_SOAK);
  await up('KeyS');

  // fill whatever wall-clock is left so the 5-minute claim is measured, not assumed
  for (const head of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7, -0.7]) {
    const el = await evaluate(`(performance.now()-window.__T0)/1000`);
    if (Number(el) > MIN_SECONDS) break;
    await nextLeg(`tail-head-${head.toFixed(2)}`, 1);
    await run('tail-warp', `__RSB.phys().yaw = ${head.toFixed(3)}; 'heading ${head.toFixed(2)} rad at t=${Math.round(el)}s'`, 1, EVERY, null, null, SAMPLE_SOAK);
    await down('KeyW');
    await run('tail', `'W on heading ${head.toFixed(2)}'`, 300, EVERY, null, `(performance.now()-window.__T0)/1000 > ${MIN_SECONDS}`, SAMPLE_SOAK);
    await up('KeyW');
  }
  console.log('STAT total ' + await evaluate(statExpr(null)));
  const total = JSON.parse(String(await evaluate(statExpr(null))));
  await shot('soak_end');
  const fails = [];
  if (!(total.elapsedSec >= MIN_SECONDS)) fails.push(`only ${total.elapsedSec}s of continuous session`);
  if (total.nonFiniteSamples) fails.push(`${total.nonFiniteSamples} non-finite samples`);
  if (total.penSamples) fails.push(`${total.penSamples} samples with the drawn mesh below the ground`);
  if (total.tiltSamples) fails.push(`${total.tiltSamples} samples past the tilt clamp`);
  if (total.stuckRunSamples * EVERY > 25000) fails.push(`throttle held and no motion for ${(total.stuckRunSamples * EVERY / 1000).toFixed(1)}s at ${JSON.stringify(total.stuckAt)}`);
  if (exceptions) fails.push(`${exceptions} uncaught exceptions`);
  console.log('SOAK TOTAL ' + JSON.stringify(total));
  console.log('SOAK VERDICT ' + (fails.length ? 'FAIL: ' + fails.join('; ') : 'PASS'));
  process.exitCode = fails.length ? 1 : 0;
} else {
  // start 33 m south of the观礼台 deck, point due north (+z), and drive onto it under power
  await run('deck-approach-warp', `__RSB.warp(-95, -128, false, 0); __RSB.phys().yaw = 0; 'warped 33m south of the deck, yaw=0 (+z)'`, 4, 400);
  await down('KeyW');
  await run('deck-climb', `'W held, driving north onto the platform'`, 40, 400, [12, 22], `__RSB.phys().onFloor === true`);
  await run('deck-roll-on', `'still W, now on the deck'`, 10, 400, [8], `__RSB.phys().z > -100`);
  await up('KeyW');
  await tap('KeyS');
  await down('KeyS');
  await run('deck-brake', `'S held: hard stop on the deck'`, 20, 400, [15], `__RSB.phys().speed < 0.4`);
  await up('KeyS');
  await run('deck-rest', `'idle on deck: settles with no jitter'`, 6, 400);
}
console.log('FINAL ' + JSON.stringify(await evaluate('JSON.stringify(__RSB.state)')));
ws.close();
