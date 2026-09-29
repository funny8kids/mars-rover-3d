#!/usr/bin/env python3
"""#76 reverted placement, kept runnable: re-applies the `portable_generator` INDUSTRY hunk
pair, measures with the repo's own SRC_MD5 take-string, then restores.
Verified 2026-09-29: applied -> 018e4f2a34c9 (the bytes both A4 FAIL logs ran on),
restored -> 7b48281325ed (the anchored, three-times-green bytes).
Hunks are the verbatim Edit old_string/new_string pairs recorded in the session transcript,
not a hand-retyped diff. The md5 must come from `find|sort|xargs cat` -- Python-side sorting
gives a different 12-gram for the same tree (measured: 9e567da05b5e vs 7b48281325ed).
"""
import hashlib, json, shutil, subprocess
TR='/home/dominic-jamil/.qoder/projects/-home-dominic-jamil-GIthub-Code-mars-rover-3d/c6070a37-7d4c-4fbf-82f1-b65677c248e0.jsonl'
P='src/world/props.js'
def md5():
    return subprocess.run(['bash','-c',"find src -name '*.js' | sort | xargs cat | md5sum | cut -c1-12"],
                          capture_output=True, text=True).stdout.strip()
def hunk_pairs():
    out=[]
    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get('old_string'), str) and isinstance(o.get('new_string'), str):
                out.append((o['old_string'], o['new_string']))
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    for line in open(TR, encoding='utf-8', errors='replace'):
        if 'portable-genset' in line or 'const CC0' in line:
            try: walk(json.loads(line))
            except Exception: pass
    sel, seen = [], set()
    for o, n in out:
        if 'portable' in n and ('CC0' in o or 'putSolid' in n):
            k = (len(o), n[:40])
            if k not in seen: seen.add(k); sel.append((o, n))
    return sel
bak = P + '.bak-genset'
shutil.copy2(P, bak)
t = open(P, encoding='utf-8').read()
for o, n in hunk_pairs():
    assert t.count(o) == 1, 'anchor not unique: ' + o[:40]
    t = t.replace(o, n, 1)
open(P, 'w', encoding='utf-8').write(t)
print('SRC_MD5 applied  =', md5(), 'expect 018e4f2a34c9')
shutil.copy2(bak, P)
print('SRC_MD5 restored =', md5(), 'expect 7b48281325ed')
print('git src dirty    =', subprocess.run(['git','status','--porcelain','src/'],
                                           capture_output=True, text=True).stdout.strip() or '(clean)')
