// 动效**落位**探针：量的是渲染出来的 computed style，不是 CSS 里写过的字面。
//
//   node tools/cdp-run.mjs <qa_boot-url|-> tools/motion-landing-probe.js 9333
//
// 为什么规格侧那把尺子不够：tools/ref-site-font-probe.mjs 数的是 `src/styles.css` 的文本
// （`customBeziers` / `overshootingBeziers` / `beziersApplied`），它能证明作者写了四条过冲曲线、
// 并且声明处都指到了它们；但它看不见层叠之后的结果 —— 一条被后面的规则覆盖掉的 transition、
// 一个 var() 拼错成 `--ease-porp`，在文本尺子下都仍然是绿的。这里读 `getComputedStyle`，
// 也就是浏览器最终决定用来插值的那条曲线。
//
// 判据（docs/FRONTEND_BRUNO_SIMON_GAP.md §4）：
//   landed  —— §4 修法点名的每一处，computed timing function 必须是控制点落在 [0,1] 之外的
//              cubic-bezier（过冲），且 property 名单不能是 `all`（裸写法等于整条计算样式挂进过渡）。
//   keepLinear —— 连续读数（电力条、积尘条、遥测推进条）必须**不是** bezier：一个会过冲的百分比
//              读数不是生动，是仪表坏了。这一条同时是 `landed` 的反向对照：如果探针把整页都判成
//              bezier，说明它读的字段本身不可信。
//   reducedMotion —— 由调用方（tools/cdp-type-click.mjs）用 Emulation.setEmulatedMedia 跑第二遍：
//              同一批元素在 reduce 之下必须退回 linear/none，`@media (prefers-reduced-motion)` 那段
//              才是真在生效，而不是一句写在注释里的承诺。
(() => {
  const overshoots = tf => [...tf.matchAll(/cubic-bezier\(([^)]*)\)/g)].some(m => {
    const p = m[1].split(',').map(Number);
    return p.length === 4 && (p[1] > 1 || p[1] < 0 || p[3] > 1 || p[3] < 0);
  });
  // State classes are what the question is about ("when the panel is shown, which curve runs?"), and
  // most of them are off right now. So the probe puts the state on, reads it, and takes it back off —
  // the same way the fit census forces hidden panels into layout. Anything added is removed in the
  // `finally`, so a run cannot leave the UI in a state the next reading mistakes for the game's.
  const read = (sel, add = []) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, missing: true };
    const added = add.filter(c => !el.classList.contains(c));
    added.forEach(c => el.classList.add(c));
    try {
      const cs = getComputedStyle(el);
      return { sel, props: cs.transitionProperty.split(',').map(s => s.trim()),
        fns: cs.transitionTimingFunction.split(/,\s*(?![^(]*\))/).map(s => s.trim()),
        durations: cs.transitionDuration.split(',').map(s => s.trim()),
        animation: cs.animationName };
    } finally { added.forEach(c => el.classList.remove(c)); }
  };
  const want = [
    { sel: '#toast', prop: 'transform' },
    { sel: '#info-card', prop: 'transform' },
    { sel: '#mission-list li', prop: 'transform', add: ['active'] },
    { sel: '#tele-fab', prop: 'transform' },
    { sel: '#mute-fab', prop: 'transform' },
    { sel: '.start-btn', prop: 'transform' },
    { sel: '.q-card', prop: 'transform' },
    { sel: '#tel-wrap', prop: 'transform', add: ['show'] }
  ];
  const mustStayLinear = ['#battery-fill', '.film-bar i', '.tel-ramp i'];
  const landed = want.map(w => {
    const r = read(w.sel, w.add);
    if (r.missing) return { ...r, ok: false, why: 'not on screen' };
    const i = r.props.indexOf(w.prop);
    if (i < 0) return { ...r, ok: false, why: `no transition on ${w.prop}` };
    if (r.props.includes('all')) return { ...r, ok: false, why: 'transition-property is all' };
    const fn = r.fns[i] ?? r.fns[0];
    return { ...r, checked: w.prop, fn, ok: overshoots(fn), why: overshoots(fn) ? null : 'not overshooting' };
  });
  const keepLinear = mustStayLinear.map(sel => {
    const r = read(sel);
    if (r.missing) return { ...r, ok: false, why: 'not on screen' };
    const bad = r.fns.filter(f => /cubic-bezier/.test(f));
    return { sel, fns: r.fns, ok: bad.length === 0, why: bad.length ? `bezier on a continuous readout: ${bad}` : null };
  });
  // The entry animations are `animation`, not `transition`, so they need their own read: the pills
  // arrive by losing display:none, which no transition can interpolate from.
  const entryAnimations = ['#tele-fab', '#mute-fab'].map(sel => {
    const r = read(sel);
    const cs = r.missing ? null : getComputedStyle(document.querySelector(sel));
    return { sel, name: cs?.animationName, fn: cs?.animationTimingFunction,
      dur: cs?.animationDuration, ok: !!cs && cs.animationName !== 'none' && overshoots(cs.animationTimingFunction) };
  });
  return JSON.stringify({
    reducedMotionMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
    landed, landedOk: landed.filter(x => x.ok).length,
    // One number for the other direction: under emulated reduce the same list must fall to 0, which is
    // what makes the `@media` block a mechanism instead of a promise.
    landedBezier: landed.filter(x => /cubic-bezier/.test(x.fn || '')).length,
    keepLinear, keepLinearOk: keepLinear.filter(x => x.ok).length,
    entryAnimations, entryAnimationsOk: entryAnimations.filter(x => x.ok).length,
    entryAnimationDurations: entryAnimations.map(x => x.dur),
    tokens: ['--ease-pop', '--ease-glide', '--ease-lean', '--ease-exit']
      .map(n => [n, getComputedStyle(document.documentElement).getPropertyValue(n).trim()])
  }, null, 1);
})()
