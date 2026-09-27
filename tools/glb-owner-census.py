#!/usr/bin/env python3
# ============================================================================
# RED STARBASE — #95 asset-ownership census
#
# Answers one question statically, with no Blender and no browser: for every .glb the
# game loads, how many builders will write it, and can anything rebuild it at all?
#
# Why that is a reproducibility question: `export(r, "rover.glb")` writes into OUT
# (public/assets, or RSB_OUT for a verification run). If several scripts export the same
# name, the bytes on disc are whichever builder ran last, and "rebuild this asset" has no
# defined answer. Measured by this file on 2026-09-27: rover.glb has three writers
# (build_assets.py:480, build_heroes.py:297, build_showcase.py:1466), teleport_pad.glb and
# arch.glb two each (build_heroes + build_showcase) — and rover and teleport_pad are both
# loaded at runtime (src/vehicle/rover.js:9; putDeck('teleport_pad') in props.js), where
# #93's plateau datum is read straight off that asset's authored 0.30 m. So a re-run of the
# wrong builder moves a collider datum. That is not a hygiene nit.
#
# Two口径 mistakes this file made on its first run, fixed here because a guard that cries
# wolf gets switched off:
#   * a name inside a `wanted = [...]` reconciliation list was counted as an export. Now a
#     line only counts if it is shaped like an actual export call, and writers are counted
#     per FILE (one builder = one writer, whatever lines it has).
#   * the Kenney / CC0 pack assets (alien, barrel, pipe_*, platform_*, rail, stairs,
#     desk_computer, machine_wireless) have no builder by design — their source is a
#     downloaded, licensed pack. They are now classified SOURCED, not NOBUILDER, by asking
#     where the file actually lives under public/assets and whether a licence file sits
#     beside it. A referenced asset that is on disc nowhere is still a hard failure.
#
# `--selfcheck` runs both polarities on synthetic trees, because a detector that has never
# gone red on a real duplicate and never stayed green on a clean one is decoration.
#
# Usage:  python3 tools/glb-owner-census.py [--all] [--selfcheck]
# Exit codes:
#   0  OWNERSHIP_SINGLE    every referenced asset is written by ≤1 builder (or is sourced)
#   1  OWNERSHIP_MULTI     a referenced asset has more than one builder
#   2  OWNERSHIP_NOBUILD   a referenced, shipped-by-us asset has no builder at all
#   3  OWNERSHIP_MISSING   a referenced asset is not on disc anywhere
#   4  OWNERSHIP_SELFCHECK the polarity controls did not behave (the census is untrusted)
#   5  OWNERSHIP_PARTIALSWEEP --from-sweep was given a sweep that has not run every builder
# ============================================================================
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALL = '--all' in sys.argv
SELFCHECK = '--selfcheck' in sys.argv

# An export-shaped line. `export(x, "name.glb")` or a `(build_thing, "name.glb")` pair.
# Deliberately does NOT match a bare string in a `wanted = [...]` list.
WRITE_PATTERNS = [
    # The first arg is allowed to contain parens — `export(build_alpha(), "x.glb")` is a real
    # shape in this repo, and the first version of this pattern rejected it, which the
    # polarity control below caught on its very first run (both arms read NOBUILDER).
    re.compile(r'export\s*\(.*,\s*["\']([A-Za-z0-9_\-]+\.glb)["\']\s*\)'),
    re.compile(r'\(\s*build_[A-Za-z0-9_]+\s*,\s*["\']([A-Za-z0-9_\-]+\.glb)["\']'),
]
# Names the runtime hands to something that loads a model. The list is printed in the
# header so a reviewer sees the口径 behind "referenced" instead of trusting the count.
READ_PATTERNS = [
    re.compile(r'\bloadModel\(\s*[\'"]([a-z0-9_\-]+)[\'"]'),
    re.compile(r'\bmodel\(\s*[\'"]([a-z0-9_\-]+)[\'"]'),
    re.compile(r'\bput\(\s*[\'"]([a-z0-9_\-]+)[\'"]'),
    re.compile(r'\bk\(\s*[\'"]([a-z0-9_\-]+)[\'"]'),
    re.compile(r'\bkClear\(\s*[\'"]([a-z0-9_\-]+)[\'"]'),
    re.compile(r'\bpadMarkMat\(\s*[\'"]([a-z0-9_\-]+)[\'"]'),
    re.compile(r'cloneModel\(models\[[\'"]([a-z0-9_\-]+)[\'"]\]\)'),
    re.compile(r'models\[[\'"]([a-z0-9_\-]+)[\'"]\]'),
    re.compile(r'\bfootOf\(\s*[\'"]([a-z0-9_\-]+)[\'"]'),
]
THIRD_PARTY_DIRS = ('kenney', 'cc0', 'polyhaven', 'assets/web')


LIT = re.compile(r'["\']([A-Za-z0-9_\-]+\.glb)["\']')
# A literal is "produced here" under one of three shapes the repo actually uses; each is
# named in the output so a reader can see which evidence flagged a builder, and each has an
# arm in --selfcheck because the first version of this file recognised only the first two
# and reported build_rimrock.py and build_gantry.py — real producers — as NOBUILDER.
EXPORT_CALL = re.compile(r'export\w*\s*\(([^\n]*)\)')
TUPLE = re.compile(r'\(\s*build_[A-Za-z0-9_]+\s*,\s*["\']([A-Za-z0-9_\-]+\.glb)["\']')


def writers_in(text):
    """{name: how} for every .glb this builder can put on disc."""
    body = '\n'.join(l for l in text.splitlines() if not l.strip().startswith('#'))
    out = {}
    # args the file exports to: `export(kit, fname)` -> fname; `export(r, "x.glb")` -> the literal
    export_args = []
    for m in EXPORT_CALL.finditer(body):
        export_args.append(m.group(1))
    for args in export_args:
        for m in LIT.finditer(args):
            out.setdefault(m.group(1), 'export-literal')
        for var in re.findall(r'\b([A-Za-z_][A-Za-z0-9_]*)\b', args):
            if var in ('export',):
                continue
            # the variable's own assignment, searched backwards over at most 260 chars so a
            # multi-line os.path.join(...) still counts
            for m in re.finditer(r'\b' + re.escape(var) + r'\s*=', body):
                window = body[m.end():m.end() + 260]
                for lit in LIT.finditer(window):
                    out.setdefault(lit.group(1), 'export-var ' + var)
                break
    for m in TUPLE.finditer(body):
        out.setdefault(m.group(1), 'export-tuple')
    # The fourth shape the repo uses: a module-level destination constant, with rsbkit's
    # export() appending nothing — `OUT = os.path.join(root, 'x.glb')` IS the produced file.
    for m in re.finditer(r'^\s*OUT\s*=', body, re.M):
        for lit in LIT.finditer(body[m.end():m.end() + 260]):
            out.setdefault(lit.group(1), 'OUT const')
    return out


def scan(builders_dir, src_dir, assets_dir):
    writers = defaultdict(dict)             # glb -> {builder file: how}
    for fn in sorted(os.listdir(builders_dir)):
        if not (fn.startswith('build_') and fn.endswith('.py')):
            continue
        with open(os.path.join(builders_dir, fn), encoding='utf8', errors='replace') as f:
            for name, how in writers_in(f.read()).items():
                writers[name].setdefault(fn, how)
    readers = defaultdict(set)
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d != 'node_modules']
        for f in files:
            if not f.endswith('.js'):
                continue
            p = os.path.join(root, f)
            with open(p, encoding='utf8', errors='replace') as fh:
                text = fh.read()
            for pat in READ_PATTERNS:
                for m in pat.finditer(text):
                    readers[m.group(1) + '.glb'].add(os.path.relpath(p, ROOT))
    return writers, readers


# ─────────────────────────── measured mode ───────────────────────────
# The static scan above can only recognise export shapes its author thought of. It was
# caught under-counting on 2026-09-27: it read `lamp.glb` and `crystal.glb` as having one
# builder, while the sweep's own log shows build_base_v2 printing
#   EXPORTED crystal.glb          -> /tmp/rsb-repro-a/crystal.glb
# for both of them. So the authority is what a run SAYS it wrote. Each builder run prints
# `EXPORTED <name>.glb` (two spellings in this repo) and/or a `*_DONE k/n ['a', 'b', …]`
# line; a builder whose log carries neither is UNKNOWN and is named, never counted as zero.
MEASURED_EXPORT = re.compile(r'EXPORTED\s+([A-Za-z0-9_\-]+\.glb)')
MEASURED_DONE = re.compile(r'^[A-Z][A-Z0-9_]*_DONE\s+\d+/\d+\s+\[([^\]]*)\]', re.M)
MEASURED_ANY_DONE = re.compile(r'^[A-Z][A-Z0-9_]*_DONE\b', re.M)


def produced_by_run(log_text):
    names = set(MEASURED_EXPORT.findall(log_text))
    for grp in MEASURED_DONE.findall(log_text):
        names |= {k.strip().strip(chr(39) + chr(92)) + '.glb' for k in grp.split(',') if k.strip()}
    return names, bool(MEASURED_ANY_DONE.search(log_text))


def measured_report(sweep_dir, readers, assets_dir):
    all_builders = sorted(f[:-3] for f in os.listdir(os.path.join(ROOT, 'tools', 'blender'))
                          if f.startswith('build_') and f.endswith('.py'))
    per_builder = {}
    for f in sorted(os.listdir(sweep_dir)):
        m = re.match(r'^(build_[A-Za-z0-9_]+)\.[ab]\.out$', f)
        if not m:
            continue
        with open(os.path.join(sweep_dir, f), encoding='utf8', errors='replace') as fh:
            names, saw_done = produced_by_run(fh.read())
        per_builder.setdefault(m.group(1), (names, saw_done))
    writers = defaultdict(dict)
    unknown = []
    for b, (names, saw_done) in sorted(per_builder.items()):
        if not names and not saw_done:
            unknown.append(b)
        for n in sorted(names):
            writers[n][b] = 'run-log'
    # Denominator first: a half-finished sweep has no right to a verdict, because 22 of the
    # 27 builders' assets would read "no builder" for the reason that they simply have not run.
    missing_logs = [b for b in all_builders if b not in per_builder]
    print('builders with a run log: %d/%d · %s' %
          (len(per_builder), len(all_builders),
           'whose log names no produced file: ' + ', '.join(unknown) if unknown else 'every logged builder named what it wrote'))
    if missing_logs:
        print('no run log for: ' + ', '.join(missing_logs))
        print('OWNERSHIP_PARTIALSWEEP')
        return 5
    tally = defaultdict(int)
    multi = 0
    for name in sorted(set(writers) | set(readers)):
        if not readers.get(name):
            continue
        w = sorted(writers.get(name, {}))
        if len(w) > 1:
            kind, multi = 'MULTI', multi + 1
        elif not w:
            kind = 'NOBUILDER-in-sweep'
        else:
            kind = 'ok'
        tally[kind] += 1
        print('%-24s %-18s %s' % (name, kind, ', '.join(w) or '—'))
    print('measured kinds ' + ' '.join('%s=%d' % (k, tally[k]) for k in
          ['ok', 'MULTI', 'NOBUILDER-in-sweep']))
    return 1 if multi else 0


def measured_control():
    """The run-log parser must catch every completion idiom that exists in the repo, or a
    measured 'ok' means nothing. Shapes are copied from real logs, not invented."""
    cases = [
        ("EXPORTED astronaut.glb 2071772\nASTRONAUT_DONE\n", {'astronaut.glb'}),
        ("EXPORTED crystal.glb            -> /tmp/rsb-repro-a/crystal.glb\n"
         "BASE_V2_DONE 7/7 ['lamp', 'crystal']\n", {'crystal.glb', 'lamp.glb'}),
        ("nothing at all here\n", set()),
    ]
    bad = 0
    for text, want in cases:
        got, saw_done = produced_by_run(text)
        ok = got == want and saw_done == bool(want)
        print('run-log shape → %-28s %s' % (', '.join(sorted(got)) or '(none)', 'OK' if ok else 'MISREAD'))
        if not ok:
            bad += 1
    return bad


def locate(assets_dir, name):
    """Where does this asset actually live under the asset root (None if absent)?"""
    for root, dirs, files in os.walk(assets_dir):
        if name in files:
            return os.path.relpath(os.path.join(root, name), assets_dir)
    return None


def classify(writers, readers, assets_dir, name):
    w = writers.get(name, {})
    if not readers.get(name):
        return ('unused', w, None)
    where = locate(assets_dir, name)
    if where is None:
        return ('MISSING', w, None)
    if len(w) > 1:
        return ('MULTI', w, where)
    rel = where.replace(os.sep, '/')
    if any(seg in rel for seg in THIRD_PARTY_DIRS) or \
            os.path.exists(os.path.join(assets_dir, os.path.dirname(rel),
                                        'LICENSE-' + name[:-4] + '.txt')):
        return ('SOURCED', w, where)
    if not w:
        return ('NOBUILDER', w, where)
    return ('ok', w, where)


def report(builders_dir, src_dir, assets_dir, show_all=False):
    writers, readers = scan(builders_dir, src_dir, assets_dir)
    tally = defaultdict(int)
    bad = {'MULTI': 0, 'NOBUILDER': 0, 'MISSING': 0}
    for name in sorted(set(writers) | set(readers)):
        kind, w, where = classify(writers, readers, assets_dir, name)
        tally[kind] += 1
        if kind in bad:
            bad[kind] += 1
        if show_all or kind != 'unused':
            print('%-24s %-10s builders=%-2d readers=%-2d  %s%s' %
                  (name, kind, len(w), len(readers.get(name, [])),
                   ', '.join('%s(%s)' % (f, h) for f, h in sorted(w.items())) or '—',
                   '' if not where else '  [%s]' % where))
    print('kinds ' + ' '.join('%s=%d' % (k, tally[k]) for k in
          ['ok', 'SOURCED', 'unused', 'MULTI', 'NOBUILDER', 'MISSING']))
    if bad['MISSING']:
        print('OWNERSHIP_MISSING'); return 3
    if bad['NOBUILDER']:
        print('OWNERSHIP_NOBUILD'); return 2
    if bad['MULTI']:
        print('OWNERSHIP_MULTI'); return 1
    print('OWNERSHIP_SINGLE'); return 0


SHAPES = [
    ('export(r, "shape_a.glb")', 'shape_a.glb'),
    ('    for fn, fname in [(build_x, "shape_b.glb")]:\n        export(fn(), fname)', 'shape_b.glb'),
    ('fname = "shape_c.glb" if x else "other.glb"\nexport(kit, fname)', 'shape_c.glb'),
    ('OUT = os.path.join(base,\n                 \'shape_d.glb\')\nexport(root)', 'shape_d.glb'),
]


def shape_coverage():
    """Coverage self-proof: every production shape found in the real builders must be
    recognised, or the census under-counts writers and its 'ok' rows mean nothing."""
    bad = 0
    for text, want in SHAPES:
        got = writers_in(text)
        ok = want in got
        print('shape %-14s recognised by %-14s → %s' % (want, got.get(want, '—'), 'OK' if ok else 'MISS'))
        if not ok:
            bad += 1
    return bad


def selfcheck():
    """Both polarities, on synthetic trees: an injected duplicate MUST read MULTI, and
    a clean injection (a second builder for a name nobody shares) MUST NOT."""
    rc = 0
    for want_multi, label in [(True, 'true-positive'), (False, 'false-positive')]:
        tmp = tempfile.mkdtemp(prefix='rsb-owner-census-')
        b, s, a = [os.path.join(tmp, x) for x in ('blender', 'src', 'assets')]
        for d in (b, s, a):
            os.makedirs(d)
        with open(os.path.join(b, 'build_alpha.py'), 'w') as f:
            f.write('export(build_alpha(), "alpha.glb")\n')
        # beta is written in the OTHER real shape (a tuple inside an export loop), so the control
        # exercises both patterns rather than only the one the author happened to test.
        with open(os.path.join(b, 'build_beta.py'), 'w') as f:
            f.write('    for fn, fname in [(build_beta, "%s")]:\n        export(fn(), fname)\n'
                    % ('alpha.glb' if want_multi else 'beta.glb'))
        with open(os.path.join(s, 'main.js'), 'w') as f:
            f.write("loadModel('alpha');\n")
        os.makedirs(os.path.join(a, 'kenney'))
        open(os.path.join(a, 'alpha.glb'), 'w').close()
        import contextlib
        cap = _Cap()
        with contextlib.redirect_stdout(cap):
            code = report(b, s, a)
        # _Cap IS the list; wrapping a list would have copied it and left the capture empty,
        # which is how this control reported FAILED on a detector that was answering correctly.
        joined = '\n'.join(cap)
        good = (want_multi and 'MULTI' in joined and code == 1) or \
               (not want_multi and 'alpha.glb' in joined and code == 0)
        print('control %s (%s): rc=%s → %s' %
              (label, 'inject duplicate' if want_multi else 'inject distinct name',
               code, 'OK' if good else 'FAILED'))
        if not good:
            print('  captured: ' + ' | '.join(l.strip() for l in cap if 'kinds' not in l))
        shutil.rmtree(tmp)
        if not good:
            rc = 4
    return rc


class _Cap(list):
    def write(self, text):
        for line in text.splitlines():
            if line.strip():
                self.append(line)
    def flush(self):
        pass


if __name__ == '__main__':
    print('READ_PATTERNS %d  WRITE_PATTERNS %d' % (len(READ_PATTERNS), len(WRITE_PATTERNS)))
    SWEEP = None
    for i, a in enumerate(sys.argv):
        if a == '--from-sweep' and i + 1 < len(sys.argv):
            SWEEP = sys.argv[i + 1]
    if SWEEP:
        _, readers = scan(os.path.join(ROOT, 'tools', 'blender'), os.path.join(ROOT, 'src'),
                          os.path.join(ROOT, 'public', 'assets'))
        if SELFCHECK:
            miss = measured_control()
            if miss:
                print('OWNERSHIP_SELFCHECK'); sys.exit(4)
        sys.exit(measured_report(SWEEP, readers, os.path.join(ROOT, 'public', 'assets')))
    code = 0
    if SELFCHECK:
        miss = shape_coverage()
        if miss:
            print('OWNERSHIP_SELFCHECK'); sys.exit(4)
        code = selfcheck()
        if code:
            print('OWNERSHIP_SELFCHECK'); sys.exit(code)
    sys.exit(report(os.path.join(ROOT, 'tools', 'blender'),
                    os.path.join(ROOT, 'src'),
                    os.path.join(ROOT, 'public', 'assets'), ALL) or code)
