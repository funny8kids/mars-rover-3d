// usage: node tools/cdp-audio-audit.mjs <url> [port]
// Proves the synth actually *renders* audible samples, not just that AudioParam targets were
// written. `analyser.getByteFrequencyData` (surfaced as `lvl`) only ever moves while the
// context is running, so lvl > 0 is the load-bearing assertion here — and it needs the browser
// to be launched with --autoplay-policy=no-user-gesture-required, since headless has no real
// gesture to unlock playback.
const [,, url, portStr = '9335'] = process.argv;
const port = Number(portStr);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /localhost/.test(t.url)) || list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (m, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method: m, params }));
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
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){ try { return eval(${JSON.stringify(expr)}); } catch (e) { return 'ERR ' + e.message; } })()`,
    returnByValue: true,
  });
  return r.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEYS = { KeyW: { key: 'w', code: 'KeyW', vk: 87 }, KeyS: { key: 's', code: 'KeyS', vk: 83 } };
const key = (type, k) => send('Input.dispatchKeyEvent', { type, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });

// one line: ctx state | rendered seconds | master level | engine gain | master lowpass | speed
const A = `(()=>{const a=__RSB.audio(),c=__RSB.audioCtx(),p=__RSB.phys();return [
  a.state,c?+c.currentTime.toFixed(2):'none',+(a.lvl).toFixed(3),+(a.eng).toFixed(3),Math.round(a.lp),+p.speed.toFixed(1),
  'stormF=' + __RSB.env().state.stormF.toFixed(2)].join(' | ')})()`;

async function poll(label, expr, secs = 60) {
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    if (await evaluate(expr) === true) { console.log(`  ${label} OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`); return true; }
    await sleep(400);
  }
  console.log(`  ${label} TIMEOUT after ${secs}s (last=${await evaluate(expr)})`);
  return false;
}

await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await poll('ready', `!!(window.__RSB && __RSB.state.started === true)`, 240);
await send('Page.bringToFront');

console.log('IDLE       ' + await evaluate(A));
const t0 = Number(await evaluate('__RSB.audioCtx().currentTime'));
await sleep(2000);
const t1 = Number(await evaluate('__RSB.audioCtx().currentTime'));
console.log(`RENDERED   ctxTime ${t0} -> ${t1} (${(t1 - t0).toFixed(2)} s of audio produced in 2 s wall)`);

console.log('CASE drive — engine must follow speed');
await key('keyDown', KEYS.KeyW);
let peak = 0, peakEng = 0;
for (let i = 0; i < 26; i++) {
  await sleep(500);
  const line = await evaluate(A);
  const [st, , lvl, eng, , spd] = line.split(' | ');
  peak = Math.max(peak, Number(lvl)); peakEng = Math.max(peakEng, Number(eng));
  if (i % 4 === 0 || i === 25) console.log(`  s${String(i).padStart(2, '0')} ${line}`);
  if (st !== 'running') { console.log('  NOT RUNNING — audio never unlocked, abort'); break; }
}
await key('keyUp', KEYS.KeyW);
await key('keyDown', KEYS.KeyS); await sleep(900); await key('keyUp', KEYS.KeyS);
console.log(`  peak lvl ${peak.toFixed(3)} | peak engine gain ${peakEng.toFixed(3)}`);

console.log('CASE storm — master lowpass must close while samples keep flowing');
await evaluate(`__RSB.warp(620, -260); __RSB.startStorm(); 'storm on'`);
await poll('stormF>0.6', `__RSB.env().state.stormF > 0.6`, 90);
for (let i = 0; i < 6; i++) { await sleep(900); console.log(`  s${i} ${await evaluate(A)}`); }
const stormLp = Number((await evaluate(A)).split(' | ')[4]);

console.log('CASE leave storm — filter must reopen');
// toggleWeather latches: driving out of the zone only removes the *local* term, so the
// forecast has to be toggled back or the muffle never lifts.
await evaluate(`if (__RSB.env().weather === 'storm') __RSB.startStorm(); __RSB.warp(10, -70); 'storm off, out of the zone'`);
await poll('lp back > 19000', `__RSB.audio().lp > 19000`, 120);
const dryLp = Number((await evaluate(A)).split(' | ')[4]);
console.log(`  lowpass ${stormLp} Hz in the storm -> ${dryLp} Hz clear`);

console.log('CASE launch — rumble must dominate the mix');
await evaluate(`__RSB.skipMissions(); __RSB.warp(-95, -95, true); 'armed'`);
await poll('ascent', `__RSB.state.launch === 'ascent' || __RSB.state.launch === 'fly'`, 240);
let launchPeak = 0;
for (let i = 0; i < 12; i++) {
  await sleep(900);
  const line = await evaluate(A);
  launchPeak = Math.max(launchPeak, Number(line.split(' | ')[2]));
  if (i % 3 === 0) console.log(`  s${String(i).padStart(2, '0')} ${line} launchY=${await evaluate('__RSB.state.launchY.toFixed(0)')}`);
}
const verdict = {
  unlocked: (await evaluate(`__RSB.audio().state`)) === 'running',
  renderedSeconds: +(t1 - t0).toFixed(2),
  drivePeakLvl: +peak.toFixed(3),
  engineGainPeak: +peakEng.toFixed(3),
  stormLowpassHz: stormLp,
  clearLowpassHz: dryLp,
  launchPeakLvl: +launchPeak.toFixed(3),
};
console.log('VERDICT ' + JSON.stringify(verdict));
ws.close();
