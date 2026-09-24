import fs from 'fs';

// usage: node tools/cdp-type-click.mjs <url> [port] [stepRegex]
//
// 【F】1 的"UI 变更必须真实点击走一遍交互"：每一步都是 CDP `Input.dispatchMouseEvent` 打在
// 元素自己的矩形中心上，并且先做命中测试（`elementFromPoint` 必须落回该元素或其子节点）——
// 只有 DOM 读数的话，一层盖在上面的透明层会让"点击成功"变成假绿。
//
// 为什么每一步之后重跑 tools/hud-audit-probe.js 而不是在这里再写一遍溢出/碰撞尺子：尺子只能有一把。
// 在驱动脚本里复制一份 fit 判据，就会有两把口径不同的尺子，而它们的差值正是最容易被骗过去的地方。
// 代价是每步 ~30 s（probe 要 settle 120 帧），换来的是菜单/传送面板/拍照/计时赛/遥测板用的是
// 同一把尺子，而且它自带的三个 control（plantedClip / phantom / fonts.discriminates）也在每一步复查。
const [,, url, portStr, onlyRe] = process.argv;
const port = Number(portStr || 9333);
const stepRe = onlyRe ? new RegExp(onlyRe) : null;
const probe = fs.readFileSync(new URL('./hud-audit-probe.js', import.meta.url), 'utf8');
const shotDir = '/tmp/rsb-j2-click';
fs.mkdirSync(shotDir, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && /5173/.test(t.url)) || list.find(t => t.type === 'page');
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
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    console.log('[EXCEPTION] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
};
await new Promise(r => ws.onopen = r);
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
  return r.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The loop is driven by `__QA.step`, so a click's effect is advanced in virtual frames rather than
// waited for on the wall clock: a toast that fades in over 400 ms costs 24 slices, not 400 ms.
const frames = n => evaluate(`__QA.step(${n}); 1`);

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Page.navigate', { url });
{
  const deadline = Date.now() + 240000;
  for (;;) {
    const ok = await evaluate(`!!(window.__RSB && window.__QA)
      && document.getElementById('loader').classList.contains('hidden')
      && !document.getElementById('menu').classList.contains('hidden')`).catch(() => false);
    if (ok) break;
    if (Date.now() > deadline) { console.log('BOOT_TIMEOUT'); process.exit(1); }
    await sleep(2000);
  }
}

const rectOf = sel => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2,
           text: (el.textContent || '').trim().slice(0, 24) };
})()`);

const hitTest = (sel, x, y) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  const top = document.elementFromPoint(${x}, ${y});
  if (!el || !top) return { ok: false, got: top ? (top.id || top.className || top.tagName) : 'nothing' };
  return { ok: el === top || el.contains(top) || top.contains(el),
           got: top.id ? '#' + top.id : (top.className || top.tagName).toString().slice(0, 30) };
})()`);

// A control can legitimately not be on screen yet — the teleport pill is `hidden` until the launch
// countdown hands control back, and its zero-sized rect would make the hit test report `#scene`,
// which reads exactly like a z-index bug and is not one. So advance frames until the node has a box,
// then hit-test that box. Bounded: a control that never appears is still a failure.
const waitBox = async (sel, ms) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await rectOf(sel);
    if (r && r.w > 0 && r.h > 0) return r;
    if (Date.now() > deadline) return null;
    await frames(15);
  }
};

const mouse = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const key = async (k, code) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code });
  await send('Input.dispatchKeyEvent', { type: 'char', text: k.toUpperCase() });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
};
const shot = async name => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${shotDir}/${name}.png`, Buffer.from(data, 'base64'));
  return `${shotDir}/${name}.png`;
};

const results = [];
const fitOf = p => ({
  h: p.fit?.hiddenScreen?.onScreen?.h?.n ?? p.fit?.en?.h?.n,
  v: p.fit?.hiddenScreen?.onScreen?.v?.n ?? p.fit?.en?.v?.n,
  collisions: p.fit?.hiddenScreen?.collisions?.n,
  enCollisions: p.fit?.en?.collisions?.n,
  min: p.type?.min, under11: p.type?.under11?.pct, tracked15: p.type?.tracked15?.pct,
  wide: p.type?.tracked15?.list,
  below45: p.type?.contrast?.below45, contrastMin: p.type?.contrast?.min,
  textPct: p.type?.textCoveragePct, panelPct: p.panels?.coveragePct,
  controls: { planted: p.fit?.control?.plantedClipCaught, phantom: p.fit?.control?.fonts?.phantom,
              discriminates: p.fit?.control?.fonts?.discriminates, restored: p.fit?.control?.restoredAfterLocaleToggle }
});

async function step(name, fn, opts = {}) {
  if (stepRe && !stepRe.test(name)) return;
  const before = await fn.before?.();
  if (opts.sel) {
    const r = await waitBox(opts.sel, opts.waitMs ?? 20000);
    // A dropped step has to be loud: the SUMMARY line is the only other place it appears, and a
    // walk that finishes looking complete is exactly how a missed click passes as a verified one.
    if (!r) { results.push({ name, fail: 'never got a box (still hidden?): ' + opts.sel }); console.log('!! ' + name + " FAIL no box (hidden past the wait deadline): " + opts.sel); return; }
    const hit = await hitTest(opts.sel, r.cx, r.cy);
    if (!hit.ok) { results.push({ name, fail: 'hit test missed', want: opts.sel, got: hit.got, rect: r }); console.log('!! ' + name + ' FAIL hit test missed want=' + opts.sel + ' got=' + hit.got + ' rect=' + JSON.stringify(r)); return; }
    await mouse(r.cx, r.cy);
  }
  if (opts.key) await key(opts.key, opts.code || ('Key' + opts.key.toUpperCase()));
  await frames(opts.settleFrames || 30);
  const after = await fn.after?.();
  const out = { name, target: opts.sel || opts.key, before, after };
  if (opts.measure) {
    // Which screen the ruler is allowed to read is the probe's own gate, not a guess made here: it
    // waits for that screen and reports what was actually up.
    await evaluate(`window.__AUDSTATE=${JSON.stringify(opts.phase || 'hud')};1`);
    const p = JSON.parse(await evaluate(probe));
    await evaluate(`delete window.__AUDSTATE;1`);
    out.reading = fitOf(p);
    out.worst = { h: p.fit?.hiddenScreen?.onScreen?.h?.worst, v: p.fit?.hiddenScreen?.onScreen?.v?.worst,
                  col: p.fit?.hiddenScreen?.collisions?.list };
    // The probe answers an un-ready phase with `{fail, phase}` and no census. Treating that as a
    // reading would print `min=undefined h=undefined` next to a green-looking step, so it is a failure.
    if (p.fail || out.reading.min == null) {
      out.fail = 'probe: ' + (p.fail || 'no type.min in the reply');
      results.push(out);
      console.log('!! ' + name + ' FAIL ' + out.fail + ' phase=' + (opts.phase || 'hud'));
      if (opts.shot) out.png = await shot(opts.shot);
      return;
    }
  }
  if (opts.shot) out.png = await shot(opts.shot);
  results.push(out);
  console.log('## ' + name + ' ' + JSON.stringify(out));
}

// ---- the walk ----
await step('menu:quality-hi', {
  before: () => evaluate(`document.querySelector('.q-card[data-q="hi"]').className`),
  after: () => evaluate(`[...document.querySelectorAll('.q-card')].map(c => c.dataset.q + ':' + c.className.includes('sel')).join(' ')`)
}, { sel: '.q-card[data-q="hi"]' });

await step('menu:quality-std', {
  after: () => evaluate(`[...document.querySelectorAll('.q-card')].map(c => c.dataset.q + ':' + c.className.includes('sel')).join(' ')
    + ' | start disabled=' + document.getElementById('start-btn').disabled`)
}, { sel: '.q-card[data-q="std"]' });

await step('menu:lang-toggle', {
  before: () => evaluate(`[document.getElementById('lang-btn').textContent, document.querySelector('.menu-title').textContent,
    document.querySelector('.q-card span').textContent, getComputedStyle(document.getElementById('lang-btn')).width].join(' | ')`),
  after: () => evaluate(`[document.getElementById('lang-btn').textContent, document.querySelector('.menu-title').textContent,
    document.querySelector('.q-card span').textContent, getComputedStyle(document.getElementById('lang-btn')).width].join(' | ')`)
}, { sel: '#lang-btn', phase: 'menu', measure: true });

await step('menu:lang-back', { after: () => evaluate(`document.getElementById('lang-btn').textContent`) },
  { sel: '#lang-btn', phase: 'menu', measure: true, shot: 'menu' });

await step('menu:start', {
  after: () => evaluate(`[document.getElementById('hud').className, document.getElementById('menu').className,
    !!window.__RSB.state.started].join(' | ')`)
}, { sel: '#start-btn' });

await step('hud:mission-panel', {}, { measure: true, shot: 'hud' });

// ── §4 动效落位：computed style, then the same reading under emulated reduced motion ──
// The spec-side ruler counts what is written; this asks the browser what it will interpolate with,
// and then flips `prefers-reduced-motion` to check the `@media` block actually flattens the same
// elements. A reduced-motion rule that never fires is the most common kind of accessibility comment.
const motion = fs.readFileSync(new URL('./motion-landing-probe.js', import.meta.url), 'utf8');
const motionOn = !stepRe || stepRe.test('hud:motion-landing');
const judgeMotion = (name, p, mode) => {
  const bad = [];
  if (p.reducedMotionMatches !== (mode === 'reduce')) bad.push(`media query reads ${p.reducedMotionMatches} in ${mode} mode`);
  const wantBezier = mode === 'reduce' ? 0 : p.landed.length;
  if (p.landedBezier !== wantBezier) bad.push(`landedBezier ${p.landedBezier} != ${wantBezier}`);
  if (p.keepLinearOk !== p.keepLinear.length) bad.push(`keepLinear ${p.keepLinearOk}/${p.keepLinear.length}`);
  if (mode === 'reduce' && !p.entryAnimationDurations.every(d => parseFloat(d) <= 0.001))
    bad.push(`entry animations still run: ${p.entryAnimationDurations}`);
  if (mode === 'default') {
    if (p.entryAnimationsOk !== p.entryAnimations.length) bad.push(`entry ${p.entryAnimationsOk}/${p.entryAnimations.length}`);
    for (const x of p.landed) if (!x.ok) bad.push(`${x.sel}: ${x.why}`);
  }
  const out = { name, mode, bezier: p.landedBezier, of: p.landed.length,
    keepLinear: `${p.keepLinearOk}/${p.keepLinear.length}`,
    entry: `${p.entryAnimationsOk}/${p.entryAnimations.length}`,
    durations: p.entryAnimationDurations, tokens: p.tokens, fail: bad.length ? bad.join('; ') : undefined };
  results.push(out);
  console.log((bad.length ? '!! ' : '## ') + name + ' ' + JSON.stringify(out));
};
if (motionOn) {
  judgeMotion('hud:motion-landing', JSON.parse(await evaluate(motion)), 'default');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  try {
    judgeMotion('hud:motion-reduced', JSON.parse(await evaluate(motion)), 'reduce');
  } finally {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  }
}

await step('hud:teleport-open', {
  after: () => evaluate(`(() => { const u = document.getElementById('teleport-ui');
    return u ? [u.className, u.querySelectorAll('.tp-item').length, getComputedStyle(u).display].join(' | ') : 'no #teleport-ui'; })()`)
}, { sel: '#tele-fab' });

await step('hud:teleport-warp', {
  before: () => evaluate(`window.__RSB.state.pos.map(v => Math.round(v)).join(',')`),
  after: () => evaluate(`JSON.stringify({ pos: window.__RSB.state.pos.map(v => Math.round(v)),
    panelGone: !document.getElementById('teleport-ui'), hint: document.getElementById('tele-hint')?.textContent || 'none' })`)
}, { sel: '.tp-item:not([disabled])', settleFrames: 90, measure: true, shot: 'after-warp' });

await step('hud:mute-fab', {
  after: () => evaluate(`[document.getElementById('mute-fab').textContent, document.getElementById('mute-fab').className].join(' | ')`)
}, { sel: '#mute-fab', measure: true });

await step('hud:photo-mode', {
  after: () => evaluate(`[document.getElementById('photo-ui').className, document.getElementById('hud').className].join(' | ')`)
}, { key: 'p', code: 'KeyP' });

await step('hud:photo-exit', {
  after: () => evaluate(`document.getElementById('photo-ui').className`)
}, { key: 'p', code: 'KeyP', measure: true });

await step('hud:race-start', {
  after: () => evaluate(`[document.getElementById('race-hud').className, document.getElementById('race-check').textContent].join(' | ')`)
}, { key: 'r', code: 'KeyR' });

await step('hud:race-board', {
  after: () => evaluate(`[document.getElementById('board-pop').className, document.getElementById('board-list').children.length,
    document.getElementById('race-timer').textContent].join(' | ')`)
}, { sel: '#race-board-btn', measure: true, shot: 'race-board' });

await step('hud:board-close', { after: () => evaluate(`document.getElementById('board-pop').className`) },
  { sel: '#board-close', measure: true });

console.log('SUMMARY ' + JSON.stringify(results.map(r => ({ n: r.name, fail: r.fail, got: r.got,
  bezier: r.bezier, of: r.of, mode: r.mode,
  read: r.reading && { min: r.reading.min, col: r.reading.collisions, h: r.reading.h, v: r.reading.v,
    wide: r.reading.wide?.length ? r.reading.wide : undefined },
  png: r.png })), null, 1));
console.log('STEPS ' + results.length + ' FAILED ' + results.filter(r => r.fail).length);
