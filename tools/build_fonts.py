#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""J1 · 让设计里写的字体族真的落地 —— 自托管 webfont 锻造机

    python3 tools/build_fonts.py            # 拉取上游、子集化、改写 src/styles.css 的字体块
    python3 tools/build_fonts.py --check    # 只重算覆盖集并核对仓库现状，不落盘、不联网

WHY THIS EXISTS: `docs/FRONTEND_BRUNO_SIMON_GAP.md` 第 1 条实测到 `document.fonts` 有 0 条 @font-face，
也就是说 `--mono:"Consolas","JetBrains Mono",…` 里那些名字**一个都没有被渲染过**：界面用的是操作系统
当天给的字面（这台机器上 canvas 推进宽度量出 DejaVu Sans Mono / Noto Sans CJK SC）。修法只能是让那些
名字真的存在，所以这条链的产物不是"更好看的 CSS"，而是**页面上多出来的字节**。

WHAT IT SHIPS, and why those and not others:
  data   JetBrains Mono —— 栈里本来就写着它，HUD 上 90 % 的字符是数字与单位。
  body   IBM Plex Sans —— 技术文档气质的中性无衬线；配一个同族的 CJK 兄弟比给中文换一副面孔更稳。
  display Big Shoulders Display —— 超窄工业体，读起来像喷在坪面结构上的标牌；这是刻意的冒险，
         bruno-simon 用手写体表达"随性"，而这个世界的随性是油漆上去的窄体，不是抄它的字面。
  cjk    Noto Sans SC —— 只为中文**取到真实字重**（今天 CSS 写 700 时浏览器在合成加粗），
         并且让中文不再由操作系统决定。它是子集：只带仓库里真正出现过的 600 多个汉字。

THE GUARD THAT MAKES THE RESULT TRUSTWORTHY: 子集最容易的失败是"某个字不在里面"→ 豆腐块。所以这里
  ① 从 index.html / qa_boot.html / src/** 抽出全部非 ASCII 字符作为清单；
  ② 只把**上游真有**的码位写进 @font-face 的 unicode-range（没覆盖到的字符按 CSS 规则退回系统字体，
     是降级而不是豆腐块）；
  ③ 任何汉字（U+4E00-9FFF）没被子集覆盖 → 退出码非 0，而不是悄悄少一个字。

WOFF2 needs brotli + fontTools on the host python (Blender's python has neither, same reason rsbtex
forges maps on host: see docs/VERIFICATION.md). Latin faces come straight from Google's own subset
files (already woff2, so no subsetting loss); only the CJK goes through pyftsubset, because Google
serves CJK as ~100 chunk files and one ~175 kB file (the whole 400-700 axis, subset to the few
hundred codepoints the UI can paint — the exact count is printed by the `coverage:` line, never
restated here, because a number written into this docstring went stale the day the inventory shrank)
is the better artifact for a static site.
"""
import hashlib
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'src' / 'fonts'
CSS = ROOT / 'src' / 'styles.css'
MARK_START = '/* ===== FONTS:START ===== 由 tools/build_fonts.py 生成，不要手改这一段 ===== */'
MARK_END = '/* ===== FONTS:END ===== */'
UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/124.0.0.0 Safari/537.36')
GF = 'https://raw.githubusercontent.com/google/fonts/main'

# family -> (css2 query, slug, weights, license path in google/fonts or a URL list)
LATIN = [
    ('JetBrains Mono', 'JetBrains+Mono:wght@400;500;700', 'jetbrains-mono', [400, 500, 700],
     'ofl/jetbrainsmono/OFL.txt'),
    ('IBM Plex Sans', 'IBM+Plex+Sans:wght@400;600;700', 'ibm-plex-sans', [400, 600, 700],
     'https://raw.githubusercontent.com/IBM/plex/master/LICENSE.txt'),
    ('Big Shoulders Display', 'Big+Shoulders+Display:wght@600;700;800', 'big-shoulders',
     [600, 700, 800], 'ofl/bigshouldersdisplay/OFL.txt'),
]
CJK = ('Noto Sans SC', 'noto-sans-sc', [400, 500, 700],
       f'{GF}/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf', 'ofl/notosanssc/OFL.txt')

CHECK = '--check' in sys.argv


def fetch(url, binary=False, timeout=180):
    req = urllib.request.Request(url, headers={'user-agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    return data if binary else data.decode('utf-8', 'ignore')


def cache_dir():
    """The upstream variable TTF is ~100 MB and the build only needs it to re-forge the CJK subset,
    so it is kept in the user cache rather than src/fonts (which is committed) or deleted at the end
    of every run (which made each rebuild a 100 MB download that can and did time out)."""
    base = Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache')
    d = base / 'rsb-fonts'
    d.mkdir(parents=True, exist_ok=True)
    return d


def inventory():
    """Every character the UI can actually paint, from the files that ship it.

    CSS comments are stripped: a prose comment is never painted, and including one cost a build —
    a note about line boxes in src/styles.css introduced 凑叠多抓溢盒逐, none of which appear in any
    string, and `--check` failed with 'these hanzi will fall back in the UI' about text nobody sees.
    JS comments stay in (over-inclusive: the subset carries a few glyphs it never paints, which
    costs bytes and cannot produce a false pass — stripping them would need a real JS lexer).
    """
    files = [ROOT / 'index.html', ROOT / 'qa_boot.html']
    files += sorted((ROOT / 'src').rglob('*.js')) + sorted((ROOT / 'src').rglob('*.css'))
    chars = set()
    for f in files:
        if not f.is_file():
            continue
        text = f.read_text(encoding='utf-8', errors='ignore')
        if f.suffix == '.css':
            text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
        chars |= set(text)
    return {c for c in chars if ord(c) > 127}, len(files)


def latin_faces():
    """Parse Google's own css2 answer: it already carries the right woff2 + unicode-range.

    One entry per DISTINCT FILE, not per requested weight. These families are variable on Google's
    CDN — the css2 reply hands back the same woff2 URL for 400, 500 and 700 — so writing it out per
    weight shipped three byte-identical files under three URLs, and the player downloaded the same
    45 kB three times. Measured, not assumed: the browser does honour the axis from a single file
    (Big Shoulders advance 236.3 -> 256.4 -> 276.7 px and ink mass 6046 -> 7447 -> 8870 across
    600/700/800), so one file plus a `font-weight` range is both smaller and the honest declaration.
    """
    out = []
    for family, query, slug, weights, lic in LATIN:
        css = fetch(f'https://fonts.googleapis.com/css2?family={query}&display=block', )
        by_url = {}
        for subset, body in re.findall(r'/\*\s*([a-z0-9-]+)\s*\*/\s*@font-face\s*\{(.*?)\}', css, re.S):
            if subset != 'latin':
                continue
            w = int(re.search(r'font-weight:\s*(\d+)', body).group(1))
            url = re.search(r'url\((https://[^)]+)\)', body).group(1)
            ur = re.search(r'unicode-range:\s*([^;]+);', body)
            f = by_url.setdefault(url, dict(family=family, slug=slug, weights=[], url=url, license=lic,
                                            unicode_range=ur.group(1).strip() if ur else None))
            f['weights'].append(w)
        for f in by_url.values():
            f['weights'] = sorted(f['weights'])
            out.append(f)
        got = sorted(w for f in out if f['slug'] == slug for w in f['weights'])
        if got != sorted(weights):
            sys.exit(f'FAIL {family}: wanted {weights} from css2, got {got}')
    return out


def cjk_subset(text):
    """Subset the upstream variable font to exactly the UI's hanzi, keeping one wght axis.

    One file for the whole weight range, same reasoning that collapsed the Latin faces: three static
    instances of the same glyph set is 500 kB and three fetches where 166 kB and one fetch draws the
    same 400/500/700. The subset keeps its `fvar`, so the browser interpolates the weights itself.
    """
    from fontTools import subset
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
    name, slug, weights, src, lic = CJK
    raw = cache_dir() / 'NotoSansSC-wght.ttf'
    if not raw.exists():
        print(f'  fetching upstream {name} variable TTF (one-off, cached in {raw.parent})')
        raw.write_bytes(fetch(src, binary=True, timeout=900))
    lo, hi = min(weights), max(weights)
    dest = OUT / f'{slug}-{lo}-{hi}.woff2'
    font = TTFont(str(raw), fontNumber=0, lazy=False)
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['kern', 'liga', 'locl', 'pnum']
    opts.hinting = False
    opts.desubroutinize = True
    opts.drop_tables += ['DSIG']
    # Subset *then* clamp, and reload in between. Both halves are measured, not stylistic: clamping
    # the raw 30 k-glyph source dies inside fontTools 4.65 (`KeyError: 'H18533'` in the gvar
    # subsetting path), and clamping the still-in-memory subset silently keeps every delta —
    # 276.5 kB against the reloaded-and-clamped 169.2 kB, with the same glyph count either way
    # (that run's inventory was 14 hanzi larger — a CSS comment; sizes track the inventory).
    tmp = cache_dir() / 'NotoSansSC-subset.ttf'
    sub = subset.Subsetter(options=opts)
    sub.populate(text=text)
    sub.subset(font)
    font.flavor = None
    font.save(str(tmp))
    font = TTFont(str(tmp))
    tmp.unlink()
    instancer.instantiateVariableFont(font, {'wght': (lo, hi)}, updateFontNames=True)
    font.flavor = 'woff2'
    font.save(str(dest))
    out = TTFont(str(dest))
    cmap = out.getBestCmap()
    ax = {a.axisTag: (a.minValue, a.defaultValue, a.maxValue) for a in out['fvar'].axes}
    # What the file must guarantee is that it can *interpolate* the declared range. Not that its fvar
    # says 400-700: limiting a range leaves the default master where it was (wght 100), so rewriting
    # min/default to 400 would tell the browser "the default outlines are the 400 design" and draw
    # thin text. Whether 400/500/700 really paint three weights is a rendering question, and the
    # renderer is the only witness — tools/wght-probe.js answers it in the browser.
    if 'wght' not in ax or ax['wght'][0] > lo or ax['wght'][2] < hi:
        sys.exit(f'FAIL: {dest.name} declares wght {lo}-{hi} but the file only spans {ax.get("wght")} '
                 '— the CSS would promise weights the interpolation cannot reach.')
    print(f'  {name} {lo}-{hi}: {len(cmap):5d} glyphs, {dest.stat().st_size/1024:6.1f} kB, '
          f'axis wght spans {ax["wght"][0]:.0f}-{ax["wght"][2]:.0f} (default {ax["wght"][1]:.0f})')
    return [dict(family=name, slug=slug, weights=[lo, hi], path=dest.name, license=lic,
                 glyphs=len(cmap))], set(cmap)


def ranges(codepoints):
    """Merge codepoints into CSS `U+XXXX` / `U+XXXX-YYYY` runs (sorted, minimal)."""
    cps = sorted(codepoints)
    runs, start, prev = [], cps[0], cps[0]
    for c in cps[1:]:
        if c == prev + 1:
            prev = c
            continue
        runs.append((start, prev))
        start = prev = c
    runs.append((start, prev))
    return ', '.join(f'U+{a:04X}' if a == b else f'U+{a:04X}-{b:04X}' for a, b in runs)


def face_block(f):
    weights = f['weights']
    span = weights[0] if len(weights) == 1 else f'{weights[0]} {weights[-1]}'
    lines = [f'@font-face{{', f'  font-family:\'{f["family"]}\';', '  font-style:normal;',
             f'  font-weight:{span};', f'  src:url(fonts/{f["path"]}) format("woff2");']
    if f.get('unicode_range'):
        lines.append(f'  unicode-range:{f["unicode_range"]};')
    lines.append('}')
    return '\n'.join(lines)


def css_faces(css):
    """Read the @font-face rules back out of the stylesheet that actually ships.

    `--check` enumerates from here rather than from LATIN/CJK again: a check that rebuilds its own
    expected file list from the config keeps passing when the artifact's naming or weight ranges
    change under it, which is the failure this script just had (three identical files, one URL)."""
    m = re.search(re.escape(MARK_START) + r'(.*?)' + re.escape(MARK_END), css, re.S)
    if not m:
        sys.exit('FAIL: the FONTS:START/END block is not in src/styles.css — nothing to check')
    faces = []
    for body in re.findall(r'@font-face\s*\{(.*?)\}', m.group(1), re.S):
        fam = re.search(r"font-family:\s*'([^']+)'", body)
        wt = re.search(r'font-weight:\s*([\d ]+);', body)
        path = re.search(r'url\(fonts/([^)]+)\)', body)
        if not (fam and wt and path):
            sys.exit('FAIL: an @font-face in the block is missing family/weight/src: ' + body)
        ur = re.search(r'unicode-range:\s*([^;]+);', body)
        faces.append(dict(family=fam.group(1), weights=[int(x) for x in wt.group(1).split()],
                          path=path.group(1), unicode_range=ur.group(1).strip() if ur else None))
    if not faces:
        sys.exit('FAIL: the FONTS block declares 0 faces')
    return faces


def guard(faces):
    """Two things that make the shipped font block a lie, checked on the faces themselves."""
    by_path = {}
    for f in faces:
        p = OUT / f['path']
        if not p.is_file():
            sys.exit(f'FAIL: {f["family"]} declares fonts/{f["path"]} but the file is not there')
        h = hashlib.sha256(p.read_bytes()).hexdigest()
        if h in by_path:
            sys.exit(f'FAIL: {f["path"]} and {by_path[h]} are byte-identical — the same bytes are '
                     'being downloaded twice. One @font-face with a weight range covers both.')
        by_path[h] = f['path']
    # The stacks name the design families first; if one of those has no face, the browser silently
    # renders an OS font and every "this is our type identity" claim downstream is unfounded.
    css = CSS.read_text(encoding='utf-8')
    shipped = {f['family'] for f in faces}
    for var in ('--display', '--sans', '--mono'):
        m = re.search(re.escape(var) + r':\s*"([^"]+)"', css)
        if not m:
            sys.exit(f'FAIL: {var} stack not found in {CSS.relative_to(ROOT)}')
        if m.group(1) not in shipped:
            sys.exit(f'FAIL: {var} asks for "{m.group(1)}" first, but no @font-face ships it — '
                     f'shipped families: {sorted(shipped)}')
    print(f'guards: {len(faces)} faces, {len(shipped)} families, no duplicate bytes, '
          'every stack\'s design family is shipped')


def main():
    nonascii, nfiles = inventory()
    print(f'inventory: {len(nonascii)} non-ASCII characters from {nfiles} shipped files')
    OUT.mkdir(parents=True, exist_ok=True)

    faces = []
    if CHECK:
        faces = css_faces(CSS.read_text(encoding='utf-8'))
    else:
        for f in latin_faces():
            ws = f['weights']
            span = str(ws[0]) if len(ws) == 1 else f'{ws[0]}-{ws[-1]}'
            dest = OUT / f'{f["slug"]}-{span}.woff2'
            dest.write_bytes(fetch(f['url'], binary=True))
            print(f'  {f["family"]} weights {ws}: {dest.stat().st_size/1024:6.1f} kB -> {dest.name}')
            f['path'] = dest.name
            faces.append(f)

    hanzi = {c for c in nonascii if 0x4E00 <= ord(c) <= 0x9FFF}
    extra = {c for c in nonascii if not (0x4E00 <= ord(c) <= 0x9FFF)}
    cjk_faces, covered = (None, set())
    if CHECK:
        from fontTools.ttLib import TTFont
        for f in faces:
            if f['family'] == CJK[0]:
                covered |= set(TTFont(str(OUT / f['path'])).getBestCmap())
    else:
        cjk_faces, covered = cjk_subset(''.join(sorted(hanzi | {c for c in extra if ord(c) > 0x2E7F})))
        faces += cjk_faces
        # This script owns src/fonts: a woff2 no face points at is a leftover of an earlier naming
        # scheme, and it would ride into dist as dead weight the player never renders.
        keep = {f['path'] for f in faces}
        for p in sorted(OUT.glob('*.woff2')):
            if p.name not in keep:
                p.unlink()
                print(f'  removed unreferenced {p.name}')

    # `covered` is codepoints (that is what a cmap and a unicode-range speak); the inventory is
    # characters. Convert once, here, instead of comparing the two by accident.
    covered_cp = set(covered)
    covered = {chr(c) for c in covered_cp}
    missing_hanzi = sorted(hanzi - covered)
    fallthrough = sorted(c for c in nonascii if c not in covered)
    # A face with no unicode-range would claim every codepoint and then drop the ones it has no
    # glyph for onto the *next* family. That fall-through is what we want for missing symbols, so
    # the range written here is exactly the set the subset really shipped — not the wish list.
    for f in faces:
        if f['family'] == CJK[0]:
            f['unicode_range'] = ranges(sorted(covered_cp))
    guard(faces)
    if missing_hanzi:
        sys.exit('FAIL: 这些汉字没有进子集，界面上会退回系统字面：' + ''.join(missing_hanzi))
    print(f'coverage: {len(covered)} codepoints in the shipped faces; '
          f'{len(fallthrough)} UI symbols keep falling through to the OS font: '
          + ''.join(fallthrough[:40]))
    if CHECK:
        print('OK (--check wrote nothing)')
        return

    block = (MARK_START + '\n' +
             '/* 清单 = 仓库里真的出现的字符；unicode-range 只声明子集真有的码位，缺字按 CSS 规则退回系统字体\n'
             f'   （缺的符号 {len(fallthrough)} 个，见 tools/build_fonts.py 的 coverage 行）。'
             '字体许可见 src/fonts/LICENSES.md。 */\n' +
             '\n'.join(face_block(f) for f in faces) + '\n' + MARK_END + '\n')

    css = CSS.read_text(encoding='utf-8')
    if MARK_START in css:
        css = re.sub(re.escape(MARK_START) + r'.*?' + re.escape(MARK_END) + r'\n?', '', css, flags=re.S)
    head, sep, tail = css.partition(':root{')
    if not sep:
        sys.exit('FAIL: `:root{` not found in src/styles.css — refusing to write a font block '
                 'anywhere else (an @font-face after a rule is fine, but a marker in the wrong '
                 'place means the next --check reads a file nobody looks at).')
    CSS.write_text(head + block + sep + tail, encoding='utf-8')
    print(f'wrote {len(faces)} @font-face rules into {CSS.relative_to(ROOT)}')

    if not CHECK:
        lic = ['# 字体许可 · Font licences\n\n',
               '自托管子集，全部来自 SIL OFL / Apache 授权的可再分发字体。上游与授权：\n\n']
        for family, _, slug, _, source in LATIN:
            try:
                text = fetch(source if source.startswith('http') else f'{GF}/{source}')
                note = f'完整授权如下（上游 `{source}`）：\n\n```\n{text.strip()[:1400]}\n```\n'
            except Exception as e:                       # a licence page moving must not cost us fonts
                note = f'上游 `{source}` — 授权文本抓取失败（{e}），按 {family} 的 SIL OFL 1.1 分发。\n'
            lic.append(f'## {family}\n\n`{slug}-<weight-range>.woff2`（Google 对这些族给的是可变字体，一个文件覆盖整段字重）\n\n{note}\n')
        lic.append(f'## {CJK[0]}\n\n`{CJK[1]}-<weight-range>.woff2`（一个可变文件覆盖 {CJK[2][0]}–{CJK[2][-1]}，'
                   f'子集到界面用到的字面）— 上游 {CJK[3]}；授权 '
                   f'{CJK[4]}（SIL OFL 1.1）。\n')
        (OUT / 'LICENSES.md').write_text(''.join(lic), encoding='utf-8')
    print('OK')


if __name__ == '__main__':
    main()
