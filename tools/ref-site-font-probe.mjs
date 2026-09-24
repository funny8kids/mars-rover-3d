// 「前端 bruno-simon 差距」的**对照事实**探针：同一把尺子量两边，输出并排的两份读数。
//
//   node tools/ref-site-font-probe.mjs
//
// 为什么两边都要过同一个函数：只抓参考站、只报我们自己的数字，是两种口径的两把尺子（一边数 CSS
// 里写过的字号，一边数屏上真正出现的字号），差值就没有意义。这里 `cssRules()` 同时跑在
// bruno-simon.com 的 `assets/index-*.css` 与我们的 `src/styles.css` 上，`htmlRules()` 同时跑在两边
// 的首页 HTML 上，字段一一对应。
//
// 只读：不改任何文件。它给出的是**规格**（作者写了什么），观感仍由 tools/hud-audit-probe.js 的
// 屏上普查与镜头读数负责；两边的分工在 docs/VERIFICATION.md「前端 bruno-simon 差距」那一行里写明。
import { readFileSync } from 'node:fs';

const UA = { 'user-agent': 'Mozilla/5.0' };
const uniq = a => [...new Set(a)];
const all = (s, re, g = 1) => uniq([...s.matchAll(re)].map(m => (m[g] ?? m[0]).trim()).filter(Boolean));

// 一条 CSS 声明里的 font-size/letter-spacing 同时带上它所在的字号，才能算出 em 值——
// "字距大不大"只有相对于字号才成立（64 px 上的 8 px 是舒展，10 px 上的 1.5 px 是终端感）。
const paired = css => {
  const out = [];
  for (const block of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const body = block[2];
    const fs = (body.match(/font-size:\s*([\d.]+)(px|rem|em)/) || [])[0];
    const ls = (body.match(/letter-spacing:\s*([\d.]+)(px|em|rem)/) || [])[0];
    if (fs && ls) out.push({ sel: block[1].trim().slice(0, 34), fs, ls });
  }
  return out;
};

const cssRules = css => {
  const px = v => (v.endsWith('rem') ? parseFloat(v) * 16 : parseFloat(v));
  const sizes = all(css, /font-size:\s*([-\d.]+(?:px|rem|em|vw))/g).sort((a, b) => px(a) - px(b));
  const beziers = all(css, /cubic-bezier\(([^)]*)\)/g);
  // 过冲 = 控制点 y 落到 [0,1] 之外：这是"弹一下"的签名，关键字 `ease` 永远给不出来。
  const overshoot = beziers.filter(b => { const p = b.split(',').map(Number); return p[1] > 1 || p[1] < 0 || p[3] > 1 || p[3] < 0; });
  const fams = all(css, /font-family:\s*([^;}]+)/g);
  return {
    bytes: css.length,
    families: fams,
    faceRoles: { brand: fams.filter(f => !/sans-serif|serif|system-ui|monospace/.test(f)) },
    fontSizes: sizes,
    fontSizeSpan: sizes.length ? `${sizes[0]} → ${sizes[sizes.length - 1]} = ${(px(sizes[sizes.length - 1]) / px(sizes[0])).toFixed(1)}×` : null,
    letterSpacing: all(css, /letter-spacing:\s*([^;}]+)/g),
    sizeAndTracking: paired(css).slice(0, 12),
    weights: all(css, /font-weight:\s*([-\d\w]+(?:\s*,\s*[-\d\w]+)?)/g),
    transitions: (css.match(/transition(?:-duration)?:/g) || []).length,
    keyframes: (css.match(/@keyframes/g) || []).length,
    customBeziers: beziers.length,
    overshootingBeziers: overshoot.length,
    keywordEaseOnly: uniq(css.match(/\b(?:ease|ease-in|ease-out|ease-in-out|linear)\b/g) || []),
    textShadows: (css.match(/text-shadow:/g) || []).length,
    fontFaces: (css.match(/@font-face/g) || []).length,
  };
};

const htmlRules = html => ({
  bytes: html.length,
  webfontLinks: all(html, /href="(https:\/\/fonts\.googleapis\.com[^"]*)"/g),
  loadingMode: uniq(html.match(/display=(block|swap|auto|optional|fallback)/g) || []),
  domTags: (html.match(/<[a-z][a-z0-9]*[\s>/]/gi) || []).length,
  textTags: all(html, /<(p|h1|h2|h3|span|div|a|li)[\s>]/gi),
});

const REF = 'https://bruno-simon.com/';
const refHtml = await (await fetch(REF, { headers: UA })).text();
const refCssHref = (refHtml.match(/href="(\.\/assets\/index-[\w-]+\.css)"/) || [])[1];
const refCss = refCssHref ? await (await fetch(REF + refCssHref.slice(2), { headers: UA })).text() : '';

const oursHtml = readFileSync('index.html', 'utf8');
const oursCss = readFileSync('src/styles.css', 'utf8');

console.log(JSON.stringify({
  reference: { at: REF + (refCssHref || ''), html: htmlRules(refHtml), css: cssRules(refCss) },
  ours: { at: 'index.html + src/styles.css', html: htmlRules(oursHtml), css: cssRules(oursCss) },
}, null, 1));
