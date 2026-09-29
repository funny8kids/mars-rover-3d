#!/usr/bin/env python3
"""The shipped artifact must hold exactly the .glb files the page can ask for.

`src/world/assets.js:229` builds every model URL one way: `./assets/${name}.glb`, and the only names
that ever reach it come from the registry in `buildBase` — three literal arrays (`HERO`, `CC0`,
`KENNEY`) plus the `K()` prefix helper. So the request set is enumerable from source, which makes two
questions answerable without a browser: is anything the page will ask for missing from `dist`, and is
anything in `dist` not askable for. The first is a broken site, so it is a gate; the second is weight,
and it is reported (a file can be requested from another module's literal too, and this tool only
claims to read the registry).

Usage: python3 tools/dist-request-check.py --root dist
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROPS = os.path.join(ROOT, 'src', 'world', 'props.js')
ARR = re.compile(r'const (HERO|CC0|KENNEY) = \[([\s\S]*?)\];')
STR = re.compile(r"'([^']+)'")
KPREF = re.compile(r'const K = \(name\) => `([^`]+)/\$\{name\}`')


def registry(text):
    hero, cc0, kenney, kp = [], [], [], None
    for m in ARR.finditer(text):
        names = STR.findall(m.group(2))
        if not names:
            sys.exit('REFUSED array %s parsed empty — the extractor no longer matches the source shape' % m.group(1))
        {'HERO': hero, 'CC0': cc0, 'KENNEY': kenney}[m.group(1)].extend(names)
    k = KPREF.search(text)
    if k:
        kp = k.group(1)
    if not (hero and cc0 and kenney and kp):
        sys.exit('REFUSED registry not found (HERO/CC0/KENNEY/%s) — this checker is pointed at the wrong shape' % kp)
    return ['assets/%s.glb' % n for n in hero + cc0] + ['assets/%s/%s.glb' % (kp, n) for n in kenney]


def main(argv):
    root = argv[argv.index('--root') + 1] if '--root' in argv else 'dist'
    base = os.path.join(ROOT, root)
    if not os.path.isdir(base):
        sys.exit('REFUSED --root %s is not a directory' % root)
    want = registry(open(PROPS, encoding='utf8').read())
    missing = [w for w in want if not os.path.isfile(os.path.join(base, w))]
    have = []
    for r, dirs, files in os.walk(os.path.join(base, 'assets')):
        dirs.sort()
        for f in files:
            if f.endswith('.glb'):
                have.append(os.path.relpath(os.path.join(r, f), base).replace(os.sep, '/'))
    extra = sorted(set(have) - set(want))
    print('REQUESTED %d · PRESENT %d · MISSING %d · GLB_IN_ROOT %d · NOT_IN_REGISTRY %d'
          % (len(want), len(want) - len(missing), len(missing), len(have), len(extra)))
    for m in missing[:20]:
        print('  MISSING %s' % m)
    for e in extra[:8]:
        print('  outside-registry %s' % e)
    if missing:
        print('DIST_REQUEST FAIL')
        return 6
    print('DIST_REQUEST PASS')
    return 0


sys.exit(main(sys.argv[1:]))
