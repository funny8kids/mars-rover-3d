import fs from 'fs';

// usage: node tools/cdp-interaction-audit.mjs <url> <outDir> [port] [stepNameRegex]
// Drives the real gameplay hooks in window.__RSB and asserts the narrative/interaction
// layer end-to-end: info cards, hold-E repair, sample pickup, photo mode, time trial,
// easter egg, and the launch sequence.
const [,, url, outDir, portStr, onlyRe] = process.argv;
const port = Number(portStr || 9333);
fs.mkdirSync(outDir, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /localhost/.test(t.url)) || list.find(t => t.type === 'page');
if (!page) { console.log('NO_PAGE_TARGET'); process.exit(1); }

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
    console.log('[EXCEPTION] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
};
const evaluate = async expr => {
  // eval() so a step can be a sequence of statements — `return (a; b)` is a syntax error
  const r = await send('Runtime.evaluate', {
    expression: `(function(){ try { return eval(${JSON.stringify(expr)}); } catch (e) { return 'ERR ' + e.message; } })()`,
    returnByValue: true,
  });
  return r.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Let the elastic chase catch up after a warp, then give the post chain a beat to adapt
// (auto-exposure and bloom bleed are both frame-rate-driven, so they settle late too).
const settle = async (maxMs = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const d = await evaluate(`__RSB.cam().dist`);
    if (!(d > 15)) break;
    await sleep(400);
  }
  await sleep(1400);
};
const shot = async name => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(s.data, 'base64'));
  console.log('SHOT ' + name);
};

await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
await send('Page.enable');
// Frames must be comparable across runs, and captureScreenshot follows the real window: a
// debug Chrome that got minimized/resized silently produced 360x50 strips in audit17.
// Restore the window to a known size instead of overriding metrics — an occluded target
// rejects Emulation.setDeviceMetricsOverride with "Target does not support metrics override".
try {
  const { windowId } = await send('Browser.getWindowForTarget');
  await send('Browser.setWindowBounds', { windowId, bounds: { state: 'normal', left: 40, top: 40, width: 520, height: 560 } });
  console.log('WINDOW restored to 520x560');
} catch (e) { console.log('WINDOW_WARN ' + e.message); }
await send('Page.navigate', { url });

const deadline = Date.now() + 240000;
let ready = false;
while (Date.now() < deadline) {
  await sleep(500);
  if (await evaluate('!!(window.__RSB && window.__RSB.state.started === true)') === true) { ready = true; break; }
}
if (!ready) { console.log('READY_TIMEOUT'); process.exit(2); }
console.log('READY ' + JSON.stringify(await evaluate('JSON.stringify(window.__RSB.state)')));

const S = 'window.__RSB';
// steps: [name, expr, waitMs, shotName, pollUntilExpr]
// warp(..., search=0) pins the rover exactly on the target — the default ±8 m flatness
// search can drop it outside a 4-12 m interaction radius and silently miss the trigger.
const steps = [
  ['m0-patrol-warp', `${S}.warp(-260, 30, true); 'ok'`, 0, null, `${S}.state.mission >= 1`],
  ['m0-patrol-state', `JSON.stringify(${S}.state)`, 0, 'a_m0_patrol'],
  // Re-arm the key each iteration (a window blur clears `inp.keys`), but do NOT re-warp: the
  // warp drops the rover by 0.8 m, and settling eats most of the frames the hold needs.
  // At headless 20 fps a 3 s hold takes ~70 s of wall time, so this poll needs a wide budget.
  // Park 9 m out and face the skid: warping onto the leak point itself buries the chase
  // camera inside the valve cluster, which no real player can do (the collider is r=7).
  ['m1-leak-warp-hold', `${S}.warp(215, -35, [215, -26], 0); ${S}.hold(true); 'holding E'`, 0, null, `${S}.hold(true); ${S}.state.leak === true`, 170000],
  ['m1-leak-state', `${S}.hold(false); JSON.stringify(${S}.state)`, 0, 'b_leak_repair'],
  ['m2-samples-list', `JSON.stringify(${S}.sampleList())`, 0, null],
  ['m2-sample1-hold', `var s=${S}.sampleList().find(x=>!x[2]); ${S}.warp(s[0], s[1], false, 0); JSON.stringify(s)`, 0, null, `var s=${S}.sampleList().find(x=>!x[2]); ${S}.warp(s[0], s[1], false, 0); ${S}.state.samples >= 1`],
  ['m2-sample1-state', `JSON.stringify(${S}.state)`, 0, 'c_sample_pickup'],
  // Pickup is proximity-only (<4.2 m), so one warp per beacon closes the whole set. The poll
  // re-warps each iteration until nothing is left untaken: "集齐触发奖励" is only proven when
  // samples hits 6 AND the mission chain advances (launchArmed => the reward is the launch window).
  ['m2-samples-all', `'collecting remaining beacons'`, 0, null, `(()=>{const s=${S}.sampleList().find(x=>!x[2]); if(s) ${S}.warp(s[0], s[1], false, 0); return ${S}.state.samples >= 6})()`, 150000],
  ['m2-samples-state', `JSON.stringify({samples: ${S}.state.samples, mission: ${S}.state.mission, remaining: ${S}.sampleList().filter(x=>!x[2]).length, toast: document.getElementById('toast').textContent, missionRow: document.getElementById('mission-panel').textContent.includes('6/6')})`, 1500, 'c2_samples_complete'],
  // Poll the actual easter-egg card: `textContent.length > 0` is true for whatever card was
  // up before the warp, so it passed on a stale sample card and hid the real check.
  ['egg-roadster', `${S}.warp(470, 411, [470, 420], 0); 'ok'`, 0, null, `document.getElementById('info-name').textContent.includes('午夜公路') && document.getElementById('info-card').className.includes('show')`, 30000],
  ['egg-card-text', `document.getElementById('info-name').textContent + ' | ' + document.getElementById('info-card').className`, 2000, 'd_roadster_egg'],
  ['user-gesture', `'sent via CDP'`, 0, null, null],
  ['photo-on', `${S}.photo(true); JSON.stringify({hudOpacity: getComputedStyle(document.getElementById('hud')).opacity, photoUi: getComputedStyle(document.getElementById('photo-ui')).display})`, 2500, 'e_photo_mode'],
  // Actually press the real share button: shoot() re-renders the composer first (the canvas has
  // no preserveDrawingBuffer, so a bare toDataURL would come back blank), then downloads the PNG
  // and hands it to navigator.share. Either branch ends in a toast, which is the observable.
  ['photo-share-click', `document.getElementById('photo-share').click(); 'clicked'`, 0, null, `/截图|分享/.test(document.getElementById('toast').textContent)`, 25000],
  ['photo-share-state', `JSON.stringify({toast: document.getElementById('toast').textContent, canShareFiles: !!(navigator.canShare && navigator.canShare({files:[new File([new Uint8Array(4)],'x.png',{type:'image/png'})]}))})`, 1500, 'e2_photo_share'],
  ['photo-off', `${S}.photo(false); getComputedStyle(document.getElementById('hud')).opacity`, 0, null],
  // Second easter egg: the ship's night light show. Needs nightF > 0.5 AND E held within 90 m of
  // the pad AND photo mode off — hence it sits after photo-off. Poll the toast (a real observable)
  // rather than the module-private `showOn` counter.
  ['egg-lightshow', `${S}.startNight(); ${S}.warp(-200, 40, true); ${S}.hold(true); 'night + holding E'`, 0, null, `document.getElementById('toast').textContent.includes('灯光秀') && document.getElementById('toast').className.includes('show')`, 150000],
  ['egg-lightshow-state', `${S}.hold(false); document.getElementById('toast').textContent`, 1200, 'l_light_show'],
  ['race-start', `window.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyR'})); 'ok'`, 3000, null],
  ['race-state', `JSON.stringify({raceHud: getComputedStyle(document.getElementById('race-hud')).display, timer: document.getElementById('race-timer').textContent})`, 0, 'f_race_hud'],
  // Finish the whole time trial so 「成绩写入本地排行榜」 is an observation, not a code reading.
  // Gate centres are the midpoints of consecutive ZONES pairs (src/main.js:133), so the tool can
  // pin the rover on each one instead of driving a loop SwiftShader would take minutes to cross;
  // the HUD checkpoint counter is the only thing polled, and it only advances on real proximity.
  ['race-gates', `window.__G=[[47.5,-77.5],[115,55],[-110,85],[-177.5,-47.5],[-77.5,-152.5]]; window.__I=0; 'gates armed'`, 0, null, null],
  ['race-gate-run', `'running the 5 gates'`, 0, null, `(()=>{const t=document.getElementById('race-hud').textContent; if(t.includes('检查点 '+(window.__I+1))) window.__I++; const g=window.__G[window.__I]; if(g) ${S}.warp(g[0], g[1], false, 0); // the finish hides the HUD in the same frame it advances to 5/5, so the counter alone can never be observed at 5 — the toast is the real end-of-race observable
 return window.__I>=5 || /计时赛完成/.test(document.getElementById('toast').textContent)})()`, 90000],
  ['race-finish', `JSON.stringify({toast: document.getElementById('toast').textContent, boardRows: (JSON.parse(localStorage.getItem('rsb_board')||'[]')).length, bestMs: (JSON.parse(localStorage.getItem('rsb_board')||'[]')[0]||{}).ms, hudAfter: getComputedStyle(document.getElementById('race-hud')).display})`, 2500, 'f2_time_trial_done'],
  ['leaderboard-open', `document.getElementById('race-board-btn').click(); 'opened'`, 0, null, `!document.getElementById('board-pop').className.includes('hidden') && document.getElementById('board-list').textContent.includes(':')`, 15000],
  ['leaderboard-shot', `JSON.stringify({rows: document.getElementById('board-list').textContent, stored: (JSON.parse(localStorage.getItem('rsb_board')||'[]')).length})`, 1200, 'f3_leaderboard'],
  // The panel is modal and centered: leaving it open contaminates every later frame (audit16's
  // launch shots caught it), so dismiss it through its real close button and assert it is gone.
  ['leaderboard-close', `document.getElementById('board-close').click(); 'closed'`, 0, null, `document.getElementById('board-pop').className.includes('hidden')`, 10000],
  ['audio-idle', `JSON.stringify(${S}.audio())`, 0, null],
  ['audio-resume', `var c=${S}.audioCtx(); c ? (c.resume(), 'resuming:' + c.state) : 'no-ctx'`, 0, null, `${S}.audio().state === 'running'`],
  ['audio-running', `JSON.stringify(${S}.audio())`, 0, null],
  ['storm-warp-on', `${S}.warp(620, -260); ${S}.startStorm(); 'storm on'`, 0, null, `${S}.audio().lp < 15000`],
  ['storm-audio', `JSON.stringify(${S}.audio()) + ' stormF=' + ${S}.env().state.stormF.toFixed(2)`, 4000, 'i_storm_muffled'],
  ['storm-off', `${S}.warp(10, -70); ${S}.startStorm(); 'storm off + drive out of the storm zone'`, 0, null, `${S}.audio().lp > 19000`, 200000],
  ['storm-off-audio', `JSON.stringify(${S}.audio()) + ' stormF=' + ${S}.env().state.stormF.toFixed(2)`, 0, null],
  ['launch-arm', `${S}.skipMissions(); ${S}.warp(-95, -95, true); JSON.stringify(${S}.state)`, 0, null, `${S}.state.launch !== 'idle'`],
  ['launch-countdown', `JSON.stringify({ ...${S}.state, raceHud: getComputedStyle(document.getElementById('race-hud')).display })`, 0, 'g_launch_countdown'],
  ['launch-wait', `'ascent wait'`, 0, null, `${S}.state.launch === 'ascent' || ${S}.state.launch === 'fly'`, 260000],
  ['launch-ascent-state', `JSON.stringify(${S}.state)`, 1500, 'h_launch_ascent'],
  // the money shot: plume + ground shake while the vehicle is still low enough to fill the frame
  ['launch-flame', `JSON.stringify(${S}.state)`, 0, null, `${S}.state.launchY > 110`, 260000],
  ['launch-flame-shot', `JSON.stringify(${S}.state)`, 1200, 'k_launch_flame'],
  ['launch-high', `JSON.stringify(${S}.state)`, 0, null, `${S}.state.launchY > 900`, 260000],
  ['launch-climax-shot', `JSON.stringify(${S}.state)`, 0, 'j_launch_high'],
];

for (const step of steps) {
  const [name, expr, waitMs, shotName, until, pollMs = 90000] = step;
  if (onlyRe && !new RegExp(onlyRe).test(name)) continue;
  if (name === 'user-gesture') {
    // a CDP-dispatched key is a trusted event, so it satisfies the autoplay gesture rule
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    console.log('STEP user-gesture => trusted ShiftLeft dispatched');
    continue;
  }
  const out = await evaluate(expr);
  console.log(`STEP ${name} => ${typeof out === 'string' ? out : JSON.stringify(out)}`);
  if (waitMs) await sleep(waitMs);
  if (until) {
    const t0 = Date.now(); let v;
    do { v = await evaluate(until); if (v === true) break; await sleep(500); } while (Date.now() - t0 < pollMs);
    console.log(`POLL ${name} => ${v === true ? 'OK' : 'TIMEOUT(last=' + JSON.stringify(v) + ')'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  if (shotName) {
    // A warp teleports the rover but the chase camera keeps lerping, and headless SwiftShader
    // runs that lerp in slow motion — shooting immediately frames an empty dune with the
    // subject still 100 m behind. Wait until it has actually caught up.
    await settle();
    await shot(shotName);
  }
}
process.exit(0);
