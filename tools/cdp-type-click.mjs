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
// 开机判据要的是「菜单还开着」：loader 已 hidden 且 #menu **没有** hidden。带 `?auto=std` 的 qa_boot 走的是
// demo 开机支路，菜单由 demo 自己收——2026-09-29 同一 URL 两趟历史跑给出两个结果（一趟 25 步绿、一趟 240 s
// 后 BOOT_TIMEOUT），所以这条判据在带查询串时是与竞态对赌。2026-09-29 的重量真撞上了红的那一半，4 分钟后
// 只剩一句 BOOT_TIMEOUT，把「喂错了 URL」伪装成「产品起不来」。入库的那把尺是不带查询串的。
if (url.includes('?')) {
  console.log(`WRONG_BOOT_URL "${url}" —— 走查要不带查询串的 qa_boot.html（?auto=std 走 demo 开机支路，菜单收起与开机门赛跑）`);
  process.exit(1);
}
const probe = fs.readFileSync(new URL('./hud-audit-probe.js', import.meta.url), 'utf8');
const shotDir = '/tmp/rsb-j2-click';
fs.mkdirSync(shotDir, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
// 这一行原来写死 `/5173/`（Vite 时代的端口，早已不存在），于是走查靠 fallback 取"列表里的第一个 page"。
// 2026-09-29 的重跑因此 attach 到 127.0.0.1:8612 的另一个 app 页面，240 s 后报 BOOT_TIMEOUT ——
// 与 clip-sweep 那次同源：过滤条件是陈的，而陈旧过滤会把"驱动错了页面"伪装成"产品起不来"。
const page = list.find(t => t.type === 'page' && /qa_boot|8080/.test(t.url)) || list.find(t => t.type === 'page');
if (!page) { console.log('NO_PAGE_TARGET'); process.exit(1); }
// 起不来时先要能回答"我连的是哪一个页面"，否则 BOOT_TIMEOUT 说不出自己连错了对象。
console.log('TARGET ' + page.url + ' [' + page.title + ']');

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
// §7's bar is a share of the *layout* frame, and this shared headless chrome sits at a mobile layout
// (body 390x844) while Browser.getWindowBounds still reports 1920x1080. Measured 2026-09-29 in
// tools/logs/frame-attribution-2026-09-29.log on one src/ build, one variable: laid 390x844 ⇒
// text 8.75 % / panel 10.92 % / #mission-panel 8.11 % (three reds), laid 1920x1080 ⇒ 1.39 / 1.56 /
// 1.29 (fail []). So the walk pins the frame it judges at rather than inheriting whatever the window
// was left in, and refuses to judge anywhere else.
const PINNED_FRAME = { width: 1920, height: 1080 };
await send('Emulation.setDeviceMetricsOverride', { ...PINNED_FRAME, deviceScaleFactor: 1, mobile: false });
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

// A pinned override that the build refused would otherwise judge §7 at an unnamed frame, which is how
// the two archived runs came to disagree by a factor of eight on identical bytes.
const laidOf = () => evaluate(`(() => { const b = document.body.getBoundingClientRect();
  return [Math.round(b.width), Math.round(b.height)].join('x'); })()`);
const laid0 = await laidOf();
console.log(`FRAME_PINNED laid=${laid0} want=${PINNED_FRAME.width}x${PINNED_FRAME.height}`);
if (laid0 !== `${PINNED_FRAME.width}x${PINNED_FRAME.height}`) {
  console.log('FRAME_REFUSED — §7 的判据绑视口，这一跑不判');
  process.exit(1);
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
  frame: p.frame,
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

// ── 停在光台上 → 开出去：提示条退场，传送胶囊回来 ──
// A control that steps back for a contextual one is only half designed: the other half is that it
// comes back. `hud:teleport-warp` leaves the rover parked on the pad, which is exactly the frame
// where the pill is hidden (`main.js`: hint up + keyboard ⇒ `tele-fab` hidden), so this step drives
// off the pad and asserts both halves. The pill being *clickable* is already proven by
// `hud:teleport-open` at the spawn pad, so what would break here is a one-way door, and that is what
// the check refuses.
// This step also measures the frame §7's bar is actually about: the driving HUD, hint retired.
//
// 存档的第一跑（tools/logs/click-walk-2026-09-29b.log）红在这一格且未归因。归因跑见
// tools/logs/pad-leave-attribution-2026-09-29.log，两条量具事实把红解释干净了，产品侧一条没改：
// ① 判据绑的是"提示"这一个东西，而 `#tele-hint` 在产品里有两个主人（main.js:2380 光台 /
//    main.js:2388 并网，后者要求停着才出现），所以只读 `hidden` 位读不到"哪一个主人"；
// ② 上一格的落点离盘心 4.5 m，落在 pad 自己的 3.9 m 触发半径**外**（归因跑 on-pad 那行
//    hidden=true、txt=""），这一步的前提"车在台面上"从第一帧就不成立；而 120 帧的行程在
//    hold-60 之后拐回了圈内（d=0.43 → 2.21），末速 1.26~1.6 m/s 又低于 2.5 的"算停着"门槛，
//    于是提示条按设计重新亮起 —— 尺子读到的是正确行为的反面。
// 所以：前提自己造（钉到盘心，半径从 `__RSB.pois()` 拿，不手抄），读数改在**离开那一瞬间**
// （settleFrames 0，keyUp 立刻读），并把"离没离开半径""过没过 2.5"写成会拒绝放行的判据。
const padState = `(() => {
  const R = window.__RSB, s = R.state;
  let best = null;
  for (const p of R.pois().filter(x => x.kind === 'pad')) {
    const d = Math.hypot(s.pos[0] - p.x, s.pos[2] - p.z);
    if (!best || d < best.d) best = { d: +d.toFixed(2), at: p.name, r: p.r };
  }
  const h = document.getElementById('tele-hint'), f = document.getElementById('tele-fab');
  return JSON.stringify({ hidden: h.classList.contains('hidden'), fabHidden: f.classList.contains('hidden'),
    txt: (h.textContent || '').trim().slice(0, 48), speed: +(s.speed || 0).toFixed(2),
    pos: s.pos.map(v => +v.toFixed(1)), pad: best });
})()`;
await step('hud:pad-leave', {
  before: async () => {
    // 上一格把车放在盘边 4.5 m 外（那是"到不到台"的构图，不是本格的构图），这里把车钉到盘心：
    // 光台在产品 UI 里就是"停在这儿"的邀请，而 #93 已把盘面判成可驾驶 datum，所以"从台面上开得走"
    // 是产品的承诺，本格就测这一句 —— 前提自己造，且造在读数上看得见。
    //
    // 试过把落位交给产品自己的裁决（`R.warp(p.x, p.z)`＝走 warpTo 的 search=8）：那一跑读数是
    // `nearest pad:hub d=11.31/r=3.9`（tools/logs/click-walk-2026-09-29f.log 第 22 行）—— ±8 m 的
    // 搜索格把车一路滑到了台面外 11.3 m，"车在台面上"这个前提当场不成立，尺子按设计拒判。所以
    // 这里保留 search=0：**判据不放宽**，改成加一条更硬的读数（见 check 里的 moved ≥ 3 m）。
    // 归因见 tools/logs/pad-exit-2026-09-29.log：从盘心出发 16 个航向里 13 个在 9 m 内撞实体，9 条
    // 在 1.5–2 m，挡住的是这台盘自己的三枚发射柱 `hub:pad0#0/#1/#2`（props.js:1548 量过：
    // 3.00/3.03/3.15 m）。那是产品侧的台缘净空问题（#116），不归本尺掩盖。
    //
    // #116 的第一格已在产品侧修掉：站在台面上的姿态**从来没人给它挑朝向**（`teleportTo` 的 atPad
    // 分支只在落点离圆心 >1 m 时才设 yaw，而 atPad 的落点就在圆心）⇒ 出生/拖回光台那一帧的朝向是
    // 上一姿态留下的，而台缘三枚发射柱把 16 条航向堵掉 13 条。现在 atPad 姿态由产品自己的
    // `outwardBearing` 挑"净空最直的那条"，`warp` 的 face 传 `'out'` 走同一把规则。
    // 所以这一格的前提改成问产品：**位置还是尺子钉的（search=0，仍在盘心），朝向交给产品的规则**。
    // 判据一字未改。
    await evaluate(`(() => { const R = window.__RSB, p = R.pois().filter(x => x.kind === 'pad')[0];
      R.warp(p.x, p.z, 'out', 0); return p.name; })()`);
    await frames(120);
    return evaluate(padState);
  },
  after: () => evaluate(padState)
}, { holdKey: 'w', holdFrames: 45, settleFrames: 0, measure: true, shot: 'after-leave',
  check: (a, b) => {
    const s = JSON.parse(a), p0 = JSON.parse(b);
    if (p0.hidden) return `precondition: parked on the pad but the pad hint never came up — ` +
      `nearest ${p0.pad.at} d=${p0.pad.d}/r=${p0.pad.r}, speed=${p0.speed}, txt="${p0.txt}"`;
    // 真正的判据是"按着 W 车能开走"，不是"跨过某个半径"：跨过半径在产品自己的落位下先天成立。
    const moved = Math.hypot(s.pos[0] - p0.pos[0], s.pos[2] - p0.pos[2]);
    if (!(moved >= 3)) return `held W for 45 frames and travelled only ${moved.toFixed(2)} m ` +
      `(${p0.pos} → ${s.pos}) — the arrival pose is not drivable away, speed at read ${s.speed}`;
    if (!s.pad || !(s.pad.d > s.pad.r)) return `not off the pad at read time: d=${s.pad && s.pad.d} of ` +
      `r=${s.pad && s.pad.r} at ${s.pos} — crossed ${moved.toFixed(2)} m but stayed inside the keep-out`;
    if (!(s.speed >= 2.5)) return `speed ${s.speed} m/s at read time is under the 2.5 "parked" bar, ` +
      `so a lit hint here would not distinguish the two owners of #tele-hint`;
    if (!s.hidden) return `pad hint stayed up after leaving the pad: txt="${s.txt}" (off ${s.pad.at} at d=${s.pad.d})`;
    if (s.fabHidden) return `the teleport pill did not come back once the hint retired: ${a}`;
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
const failedSteps = results.filter(r => r.fail).length;
console.log('STEPS ' + results.length + ' FAILED ' + failedSteps);

// 判决行之后必须由尺子自己交出退出码，并且交出码就离场。
// `click-walk-2026-09-29h.log` 里那句"全绿"此前只能靠尾行读，因为这条 WebSocket 不关 ⇒ 进程挂着，
// 外层 shell 被我按 PID 收掉时把 `CLICK_WALK_RC=143` 追加进了归档日志 —— 那是 SIGTERM，不是判决。
// 落盘用 fs.writeSync：stdout 是管道时 console.log 之后立刻 process.exit 会把尾巴截掉。
const walkRc = failedSteps === 0 ? 0 : 1;
fs.writeSync(1, 'CLICK_WALK_RC=' + walkRc + '\n');
try { ws.close(); } catch { /* 已经断了就没必要再喊 */ }
process.exit(walkRc);
