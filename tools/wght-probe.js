// 字重是否真的落地：一个 @font-face 写了 `font-weight: 400 700`，浏览器画出来的是三种墨量，还是一份
// 文件被复制成三条？
//
// WHY THIS EXISTS: 自托管字体改成「一个可变文件 + 一段字重范围」之后，光看 CSS 声明证明不了 anything ——
// 声明可以是假的，文件可以只有一个 master。判据只能是**墨量**：同一串字、同一字号，只换 font-weight，
// 数画布上被点亮的像素。
//
// TWO TRAPS THIS AVOIDS (both were hit while writing it):
// (1) Canvas 2D 不会为一个没用过的字体发起加载。少了下面的 `document.fonts.load()`，中间那几个字重
//     量的其实是系统降级字面，整张表会读成「字重全都一样」——一个假红，指向错的地方。
// (2) `document.fonts.load(font)` 的默认文本是 `" "`，落在中文子集的 unicode-range 之外，所以 Noto
//     Sans SC 会 facesMatched=0。文本要按族给：先试拉丁串，回 0 个人面再试汉字串。
//
//     这里曾经写过一条 `unicode-range` 正则（看到 U+4E… 就判汉字），它把**四个族全部**判成了汉字，
//     于是拉丁三行量的全是降级面（8908→8908→13070，和降级锚 8908 一模一样），探针自己制造了假红。
//     unicode-range 里也含 U+2000-206F 之类的标点段，正则无从区分「这个族画什么字」——只有加载器知道。
//
// The families, ranges and texts all come out of src/styles.css as the browser parsed it, so this
// probe cannot drift from what the build actually shipped.
(async () => {
  await document.fonts.ready;
  const LATIN = 'HAGOZ0123', HAN = '火星基地坪站';
  const faces = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }   // cross-origin: nothing to read
    for (const r of rules) {
      if (r.type !== CSSRule.FONT_FACE_RULE) continue;
      const fam = r.style.getPropertyValue('font-family').replace(/["']/g, '').trim();
      const wt = r.style.getPropertyValue('font-weight').split(/\s+/).map(Number).filter(Number.isFinite);
      const ur = r.style.getPropertyValue('unicode-range');
      if (!fam || !wt.length) continue;
      faces.push({ fam, lo: wt[0], hi: wt[wt.length - 1], ur: ur || '(none)' });
    }
  }
  const cv = document.createElement('canvas'); cv.width = 900; cv.height = 140;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  // Advance alone is not enough: a CJK face keeps every glyph on the same em box, so 火星基地坪站
  // measures the same width at 400 and 700 while the strokes are visibly heavier. Ink mass is the
  // reading that cannot be satisfied by the same outline.
  const ink = (fam, wt, txt) => {
    cx.clearRect(0, 0, 900, 140);
    cx.font = `${wt} 72px "${fam}"`; cx.textBaseline = 'top'; cx.fillStyle = '#fff';
    const adv = cx.measureText(txt).width;
    cx.fillText(txt, 4, 10);
    const d = cx.getImageData(0, 0, 900, 140).data;
    let mass = 0; for (let i = 3; i < d.length; i += 4) mass += d[i];
    return { wt, adv: +adv.toFixed(1), mass: Math.round(mass / 255) };
  };
  const out = { shippedFaces: faces.map(f => `${f.fam} ${f.lo}-${f.hi}`).join(' | ') };
  const uniq = new Map();
  for (const f of faces) {
    if (uniq.has(f.fam)) { const p = uniq.get(f.fam); p.lo = Math.min(p.lo, f.lo); p.hi = Math.max(p.hi, f.hi); continue; }
    uniq.set(f.fam, { ...f });
  }
  // Which script a family actually paints is asked of the loader, not read out of the CSS text:
  //拉丁串先试，回 0 个人面才换汉字串。一个族只会答一种，所以这里的顺序不会把降级面读成成功。
  const textFor = async (fam, lo, hi) => {
    for (const txt of [LATIN, HAN])
      if ((await document.fonts.load(`${lo} 72px "${fam}"`, txt)).length) return txt;
    return LATIN;
  };
  for (const [fam, f] of uniq) {
    const txt = await textFor(f.fam, f.lo, f.hi);
    const probe = [f.lo, Math.round((f.lo + f.hi) / 2), f.hi];
    const rows = [];
    for (const wt of probe) {
      const list = await document.fonts.load(`${wt} 72px "${fam}"`, txt);
      rows.push({ facesMatched: list.length, ...ink(fam, wt, txt) });
    }
    const fb = ink('sans-serif', 400, txt);
    out[fam] = { text: txt, unicodeRange: f.ur, declared: `${f.lo}-${f.hi}`, rows,
      // A weight that matches no face is a weight the browser invents by synthesising — say so.
      allLoaded: rows.every(r => r.facesMatched > 0),
      monotoneHeavier: rows.every((r, i) => i === 0 || r.mass > rows[i - 1].mass),
      spreadPct: +((rows[rows.length - 1].mass - rows[0].mass) * 100 / Math.max(1, rows[0].mass)).toFixed(1),
      // 与降级面的墨量距离只是诊断，不是判据：72 px 下系统汉字面和 Noto 400 的墨量差不到 1 %，
      // 这一条会在**已经证明加载成功**的族上假红。真正的证据是上面的 facesMatched>0。
      fallbackAnchor: fb,
      nearFallback: rows.map(r => +((r.mass - fb.mass) * 100 / fb.mass).toFixed(1)) };
  }
  out.verdict = [...uniq.keys()].map(k =>
    `${k}: ${out[k].allLoaded && out[k].monotoneHeavier ? 'OK' : 'FAIL'} `
    + `墨量 ${out[k].rows.map(r => r.mass).join('→')}（降级面 ${out[k].fallbackAnchor.mass}）`);
  return JSON.stringify(out, null, 1);
})()
