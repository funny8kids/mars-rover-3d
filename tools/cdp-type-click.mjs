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
// The platform key codes are not decoration: Chrome runs a focused button's default action only when
// the event carries the virtual key code, so an Enter that looks complete in `key`/`code` alone presses
// nothing at all.
const VK = { Enter: 13, ' ': 32 };
const keyBase = (k, code) => ({ key: k, code, windowsVirtualKeyCode: VK[k], nativeVirtualKeyCode: VK[k] });
const keyDown = async (k, code) => {
  const base = keyBase(k, code);
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' });
  await send('Input.dispatchKeyEvent', { ...base, type: 'char', text: k === 'Enter' ? '\r' : k.toUpperCase() });
};
const keyUp = (k, code) => send('Input.dispatchKeyEvent', { ...keyBase(k, code), type: 'keyUp' });
const key = async (k, code) => { await keyDown(k, code); await keyUp(k, code); };
const shot = async name => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${shotDir}/${name}.png`, Buffer.from(data, 'base64'));
  return `${shotDir}/${name}.png`;
};
// Pointer *without* a button: the mission log opens on `pointerenter`, and only CDP's own mouseMoved
// synthesises the boundary events (mouseenter/leave) the way a real hand does. `.dispatchEvent(new
// PointerEvent(...))` from the page would fire the handler while proving nothing about hit-testing.
const hover = async (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });

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
  panelBox: p.panels?.top?.[0], pinned: p.phase?.pinned,
  density: p.density,
  mpOpenAt: [p.phase?.missionPanel?.openAtStart, p.phase?.missionPanel?.openAtReading],
  mpWaited: p.phase?.missionPanel?.waitedMs, mpPops: p.phase?.missionPanel?.popsDuringRun,
  anchors: (sc => {
    const bad = [];
    for (const [k, v] of Object.entries(sc || {})) {
      if (typeof v === 'string') { bad.push(k + ': ' + v); continue; }          // 'absent from DOM'
      if (v?.broken) bad.push(k + ': on screen but missing from the census');
      if (k === 'anchorMutation' && (v.dropped !== 1 || v.caught !== true)) bad.push('plant did not reach: ' + JSON.stringify(v));
      if (k === 'hudMarkupParity' && v.missing?.length) bad.push('shipped ids absent here: ' + v.missing.join(','));
    }
    return bad;
  })(p.selfCheck),
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
  // Where the caret is, not which keys were struck: a keyboard player Tabs onto the control first, so
  // the step sets that precondition and then drives the *real* key event. `blur` is the same node's
  // other half — the panel has to give up what focus lent it.
  if (opts.focus) await evaluate(`document.querySelector(${JSON.stringify(opts.focus)}).focus();1`);
  if (opts.key) await key(opts.key, opts.code || ('Key' + opts.key.toUpperCase()));
  // A *held* key rather than a tap: `inp` samples key state per frame, so down-and-up in the same
  // instant is a throttle blip that moves the rover nowhere. Holding W is how the walk gets off a
  // teleport pad — the only way to test a control that steps back for a contextual one.
  // Named `holdKey`, not `hold`: `opts.hold` is already the list of layers pinned for the probe
  // (`window.__AUDHOLD` below), and reusing that key made the mission-log gesture steps call
  // `['mission-panel'].toUpperCase()` — the walk died on it rather than passing quietly.
  if (opts.holdKey) {
    const code = opts.code || ('Key' + opts.holdKey.toUpperCase());
    await keyDown(opts.holdKey, code);
    await frames(opts.holdFrames || 90);
    await keyUp(opts.holdKey, code);
  }
  if (opts.blur) await evaluate(`document.activeElement && document.activeElement.blur();1`);
  if (opts.hover) {
    const r = await waitBox(opts.hover, opts.waitMs ?? 20000);
    if (!r) { results.push({ name, fail: 'never got a box (still hidden?): ' + opts.hover }); console.log('!! ' + name + ' FAIL no box: ' + opts.hover); return; }
    await hover(r.cx, r.cy);
  }
  if (opts.unhover) await hover(...opts.unhover);
  await frames(opts.settleFrames || 30);
  const after = await fn.after?.();
  const out = { name, target: opts.sel || opts.key || opts.holdKey, before, after };
  // A click that lands is not yet a click that works: `elementFromPoint` proves the pointer reached
  // the node, only the state change proves the handler was wired to the element the player sees. The
  // mission log has both halves to check (panel class, and the counter's own label).
  if (opts.check) {
    const why = opts.check(after, before);
    if (why) {
      out.fail = 'state: ' + why;
      results.push(out);
      console.log('!! ' + name + ' FAIL ' + out.fail);
      if (opts.shot) out.png = await shot(opts.shot);
      return;
    }
  }
  if (opts.measure) {
    // Which screen the ruler is allowed to read is the probe's own gate, not a guess made here: it
    // waits for that screen and reports what was actually up.
    await evaluate(`window.__AUDSTATE=${JSON.stringify(opts.phase || 'hud')};1`);
    // ... and which *transients* the step pinned open is the probe's other gate: it retires anything
    // the HUD pops for itself, so a click-opened log has to be declared or the ruler would close it
    // again before reading, and the step would measure the state it exists to prove wrong.
    await evaluate(`window.__AUDHOLD=${JSON.stringify(opts.hold || [])};1`);
    const p = JSON.parse(await evaluate(probe));
    await evaluate(`delete window.__AUDSTATE;delete window.__AUDHOLD;1`);
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
    // §7's density bar, judged by the probe and read here. Two ways this can be a lie rather than a
    // measurement, so both are checked: a `fail` that trips (the HUD got too crowded), and a bar that
    // can never trip (the probe's own 1 % control does not turn all three clauses red — a clause wired
    // to nothing reads identical to a clause satisfied).
    const d = out.reading.density;
    if (!d && (opts.phase || 'hud') === 'hud') {
      out.fail = 'probe returned no density block — §7 would be unjudged, not passed';
    } else if (d && d.judged) {
      if (d.control?.tripped !== 3) {
        out.fail = `density bar is decoration: control tripped ${d.control?.tripped}/3 at 1 %`;
      } else if (d.fail.length) {
        out.fail = '§7 density: ' + d.fail.join('; ') + ' | 各层 ' + d.ownerSplit.join(' , ');
      }
    }
    if (out.fail) {
      results.push(out);
      console.log('!! ' + name + ' FAIL ' + out.fail);
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

// ── §7 任务日志：一行在驾驶时，其余靠操作展开 ──
// Six gestures over four input paths, walked as a player would hit them: hover reveals, hover-leave
// retracts, the
// counter toggles both ways under a real click, a real Enter key does the same from the keyboard, and
// blur gives the reveal back. The click steps are not redundant with the hover steps — a real pointer
// has to cross the panel to reach the counter, so `pointerenter` opens the log *before* the press
// lands, and the press therefore has to collapse it. Asserting that (rather than "click opens") is the
// point of driving the input domain instead of calling `UI.setMissionsOpen`.
// These steps are also what caught a real defect, and the `btnBoxes` rule below is the record of it:
// with the counter *under* the rows it reveals, opening the panel slid the button out from under the
// pointer (y 58 → 160), the press landed on a mission row instead, `focusout` collapsed the panel back,
// and the browser dispatched `click` on the common ancestor (`#mission-panel`) — where no listener is
// registered, so clicking 还有 N 条 did nothing at all. A control must not move when it works.
// Splitting the lists fixed that instance and the rule below caught the second one the same day
// (`btnBoxes ["35,85,51,18"] vs ["35,58,62,18"]`): the collapsed state also hid `.mp-title`, and a
// heading *above* the counter slides it exactly as much as four rows below it does (y 58 → 85). Hence
// the anchor test, and why width is not in it — 「还有 3 条」 and 「收起任务」 are different words.
const mpRead = `(() => {
  const p = document.getElementById('mission-panel'), b = document.getElementById('mp-more');
  if (!p || !b) return { missing: [!p && 'mission-panel', !b && 'mp-more'].filter(Boolean) };
  const vis = n => !!n && getComputedStyle(n).display !== 'none' && !!n.getClientRects().length;
  const li = [...p.querySelectorAll('li')];
  const r = p.getBoundingClientRect(), rb = b.getBoundingClientRect();
  return { open: p.classList.contains('open'), lines: li.length, shown: li.filter(vis).length,
    headShown: vis(p.querySelector('#mission-list li')),
    label: b.textContent.trim(), hidden: b.hidden, aria: b.getAttribute('aria-expanded'),
    focused: document.activeElement === b,
    box: [Math.round(r.width), Math.round(r.height)],
    btnBox: [Math.round(rb.x), Math.round(rb.y), Math.round(rb.width), Math.round(rb.height)] }; })()`;
const mpSeen = [];
const judgeMp = (s, want) => {
  if (s.missing) return 'elements missing: ' + s.missing.join(',');
  mpSeen.push({ want, label: s.label, btnBox: s.btnBox.join(','), rect: s.btnBox });
  if (s.open !== want) return `panel ${want ? 'did not open' : 'did not close'} (open=${s.open})`;
  if (s.aria !== String(want)) return `aria-expanded=${s.aria} while ${want ? 'open' : 'closed'}`;
  if (s.hidden) return 'toggle is hidden, so the collapsed log has no way back';
  if (!s.headShown) return 'the active row disappeared, so the collapsed panel has nothing to lean on';
  if (want && s.shown !== s.lines) return `open shows ${s.shown}/${s.lines} lines`;
  if (!want && s.shown !== 1) return `closed shows ${s.shown} lines, expected the active one`;
  return null;
};
const mpStep = (name, want, opts) => step(name,
  { before: () => evaluate(mpRead), after: () => evaluate(mpRead) },
  { ...opts, check: opts.check || (s => judgeMp(s, want)) });
await mpStep('hud:mission-hover-open', true, { hover: '#mp-more', measure: true, hold: ['mission-panel'] });
await mpStep('hud:mission-hover-close', false, { unhover: [640, 420], shot: 'hud-collapsed' });
await mpStep('hud:mission-click-collapse', false, { sel: '#mp-more' });
await mpStep('hud:mission-click-open', true, { sel: '#mp-more', measure: true, hold: ['mission-panel'], shot: 'hud-log-open' });
await mpStep('hud:mission-key-collapse', false, { focus: '#mp-more', key: 'Enter', code: 'Enter' });
await mpStep('hud:mission-key-open', true, { key: 'Enter', code: 'Enter' });
await mpStep('hud:mission-blur-close', false, { blur: true, unhover: [640, 420] });
{
  const opened = mpSeen.filter(x => x.want).map(x => x.label);
  const closed = mpSeen.filter(x => !x.want).map(x => x.label);
  const btnBoxes = [...new Set(mpSeen.map(x => x.btnBox))];
  const anchors = [...new Set(mpSeen.map(x => x.rect.slice(0, 2).join(',')))];
  // Two clauses, because "the box is identical" is both too strict (the label changes width) and not
  // enough (a control can slide *past* the pointer while keeping a similar box): what has to hold is
  // that the control sits where it sat, and that wherever the pointer was on any of these rects it is
  // still on all of them — that is the actual condition under which a press and a release hit one node.
  const centreIn = (a, b) => a[0] + a[2] / 2 >= b[0] && a[0] + a[2] / 2 <= b[0] + b[2]
    && a[1] + a[3] / 2 >= b[1] && a[1] + a[3] / 2 <= b[1] + b[3];
  const rects = [...new Set(mpSeen.map(x => x.rect.join(',')))].map(s => s.split(',').map(Number));
  const drifted = [];
  for (const a of rects) for (const b of rects)
    if (a !== b && !centreIn(a, b)) drifted.push(`pressing ${a.join(',')} would land outside ${b.join(',')}`);
  const bad = [];
  if (!opened.length || !closed.length) bad.push(`no ${opened.length ? 'collapsed' : 'open'} state was ever judged`);
  if (new Set(opened).size !== 1) bad.push('open label is not stable: ' + JSON.stringify(opened));
  if (new Set(closed).size !== 1) bad.push('closed label is not stable: ' + JSON.stringify(closed));
  if (opened[0] === closed[0]) bad.push('the toggle says the same thing open and closed: ' + opened[0]);
  if (anchors.length !== 1) bad.push('the counter moves when the log opens, so the pointer is never on it: ' + JSON.stringify(anchors));
  if (drifted[0]) bad.push(drifted[0]);
  results.push({ name: 'hud:mission-state', states: mpSeen.length, opened, closed, btnBoxes, anchors, fail: bad[0] });
  console.log((bad.length ? '!! ' : '## ') + 'hud:mission-state '
    + JSON.stringify({ states: mpSeen.length, opened, closed, btnBoxes, anchors, bad }));
}

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

// ── 停在光台上：提示条接管，传送胶囊让位 ──
// A control that steps back for a contextual one is only half designed: the other half is that it
// comes back. `hud:teleport-warp` leaves the rover parked on the pad, which is exactly the frame
// where the pill is hidden (`main.js`: hint up + keyboard ⇒ `tele-fab` hidden), so this step holds W
// until the rover is off the pad and asserts both halves — the hint retires, the pill returns. The
// pill being *clickable* is already proven by `hud:teleport-open` at the spawn pad, so what would
// break here is a one-way door, and that is what the check refuses.
// This step also measures the frame §7's bar is actually about: the driving HUD, hint retired.
const padState = `JSON.stringify({ hint: document.getElementById('tele-hint').classList.contains('hidden'),
  fab: document.getElementById('tele-fab').classList.contains('hidden'),
  speed: Math.round(window.__RSB.state.speed * 10) / 10,
  pos: window.__RSB.state.pos.map(v => Math.round(v)).join(',') })`;
await step('hud:pad-leave', {
  before: () => evaluate(padState),
  after: () => evaluate(padState)
}, { holdKey: 'w', holdFrames: 120, settleFrames: 45, measure: true, shot: 'after-leave',
  check: (a, b) => {
    const s = JSON.parse(a);
    if (!s.hint) return `pad hint did not retire after driving off the pad (still up at ${s.pos}, ${s.speed} m/s) — was ${b}`;
    if (s.fab) return `the teleport pill did not come back once the hint retired: ${a}`;
    return null;
  } });

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
