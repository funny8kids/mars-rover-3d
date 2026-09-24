// 用 census 自己的尺子量 line-height：`el.scrollHeight - el.clientHeight`。
// WHY: 把 52 px 的 #speed-val 从 line-height:1 提到 1.18，census 只从 +8 px 缩到 +4 px——线盒不是
// 简单的 line-height × 字号，猜第二个值就是猜第二次。这里在页面里逐档扫，读的就是 §2c 那一对照，
// 所以扫出来的「刚好不再溢出」和 census 判绿是同一件事。
(async () => {
  const el = document.getElementById('speed-val');
  const unit = document.getElementById('speed-unit');
  if (!el || !unit) return JSON.stringify({ FAIL: 'elements missing' });
  const saved = el.style.lineHeight;
  const rows = [];
  for (const lh of ['1', '1.1', '1.18', '1.25', '1.3', '1.35', '1.4', '1.5', 'normal']) {
    el.style.lineHeight = lh;
    void el.offsetHeight;                                     // flush layout before reading
    const a = el.getBoundingClientRect(), b = unit.getBoundingClientRect();
    rows.push({ lh, fs: +parseFloat(getComputedStyle(el).fontSize).toFixed(1),
      box: el.clientHeight, need: el.scrollHeight,
      over: el.scrollHeight - el.clientHeight,
      gapToUnit: +(b.top - a.bottom).toFixed(1) });
  }
  el.style.lineHeight = saved;
  return JSON.stringify({ rows, css: getComputedStyle(el).lineHeight }, null, 1);
})()
