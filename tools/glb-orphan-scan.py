#!/usr/bin/env python3
"""Which shipped .glb files can the running app never load?

tools/glb-owner-census.py answers "who WRITES each .glb" over a denominator of names the
builders and five reader patterns happen to mention. On 2026-09-29 that denominator measured
28 rows against 128 distinct .glb basenames on disk, so a file sitting in public/assets that
no pattern recognised produced no row, no rc, and no alarm — the census could not see the
state overhead_crane.glb and portable_generator.glb were actually in (shipped to dist,
material names committed in assets.js, zero references from app code).

This scanner takes the DISK as its denominator: every .glb served by the site must be
nameable by app code (src/**.js + the page shells), because assets.js builds its request
path as './assets/<name>.glb' from a literal name. A file whose name appears nowhere in app
code is dead weight on a public host: it costs the visitor nothing only if nobody ever asks.

Exit codes: 0 = nothing unreferenced, 4 = at least one unreferenced .glb, 5 = the scan itself
could not be trusted (empty enumeration, or a name it could not classify).
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'public', 'assets')
SKIP_DIRS = {'web'}                      # excluded from the published site by design
APP_GLOBS = [('src', '.js')]
APP_FILES = [f for f in ('index.html', 'qa_boot.html') if os.path.isfile(os.path.join(ROOT, f))]

TOKEN = re.compile(r'[A-Za-z0-9_\-]+')
LINE_COMMENT = re.compile(r'//[^\n]*')
BLOCK_COMMENT = re.compile(r'/\*.*?\*/', re.S)
# assets.js keeps a list of MATERIAL group names (audit_double_sided.mjs --emit writes it). Those
# strings are not requests: 'overhead_crane' sits there because the crane's I-beams are open shells,
# and the crane is still loaded by nobody. A name only counts if it survives dropping this set.
MATERIAL_SET = re.compile(r'SHEET_MATERIALS[\s\S]*?\]\);')


def strip_noise(text):
    text = BLOCK_COMMENT.sub(' ', text)
    text = LINE_COMMENT.sub('', text)
    return MATERIAL_SET.sub(' ', text)


def app_text():
    """Everything the shipped page can read at runtime, as one searchable blob per token."""
    names = set()
    for d, ext in APP_GLOBS:
        for root, dirs, files in os.walk(os.path.join(ROOT, d)):
            dirs[:] = [x for x in dirs if x != 'node_modules']
            for f in files:
                if not f.endswith(ext):
                    continue
                with open(os.path.join(root, f), encoding='utf8', errors='replace') as fh:
                    names |= set(TOKEN.findall(strip_noise(fh.read())))
    for f in APP_FILES:
        with open(os.path.join(ROOT, f), encoding='utf8', errors='replace') as fh:
            names |= set(TOKEN.findall(strip_noise(fh.read())))
    return names


def shipped_glbs():
    out, skipped = [], 0
    for root, dirs, files in os.walk(ASSETS):
        dirs.sort()
        for f in files:
            if not f.endswith('.glb'):
                continue
            p = os.path.join(root, f)
            if not os.path.isfile(p):
                continue
            rel = os.path.relpath(p, ASSETS).replace(os.sep, '/')
            if rel.split('/')[0] in SKIP_DIRS:
                skipped += 1            # under public/assets/web — not served by the site
                continue
            out.append((rel, os.path.getsize(p)))
    return sorted(out), skipped


def main(argv):
    show_all = '--all' in argv
    tokens = app_text()
    rows, skipped = shipped_glbs()
    if not rows:
        print('ENUM_REFUSED no .glb found under public/assets — nothing was scanned')
        return 5
    if not tokens:
        print('ENUM_REFUSED app code produced zero tokens — nothing was scanned')
        return 5
    dead = []
    for rel, size in rows:
        stem = os.path.basename(rel)[:-4]
        if stem in tokens:
            if show_all:
                print('%-46s referenced' % rel)
        else:
            dead.append((rel, size))
    for rel, size in dead:
        print('%-46s UNREFERENCED %8.1f KiB' % (rel, size / 1024.0))
    print('ENUMERATED %d · REFERENCED %d · UNREFERENCED %d · dead bytes %.1f MiB · skipped web/ %d'
          % (len(rows), len(rows) - len(dead), len(dead),
             sum(s for _, s in dead) / 1048576.0, skipped))
    if dead:
        print('GLB_ORPHANS')
        return 4
    print('GLB_ALL_REFERENCED')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
