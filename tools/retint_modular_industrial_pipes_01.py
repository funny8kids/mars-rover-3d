#!/usr/bin/env python3
"""retint_modular_industrial_pipes_01.py — CC0 conform: hue-mapped retint of the
Poly Haven `modular_industrial_pipes_01` baseColor maps to the RED STARBASE sheet,
then a rebuild of the single-file GLB into staging/.

Triage verdict (tools/logs/cc0-conform-2026-09-26.txt line 2): WIRE-AFTER-RETINT —
geometry/scale/materials are usable, only the colours are wrong. So this script
touches NOTHING but the two `*_diff` baseColor images:

  - geometry, UVs, node structure, materials, normal + ARM maps: byte-identical;
  - the two diff maps are replaced by `*_col` maps (repo naming convention, see
    tools/blender/rsbtex.py `_save(tag + "_col")`), written next to copies of the
    untouched channels in a rebuilt source folder, merged by tools/gltf_to_glb.mjs.

Retint method (luminance-preserving, NOT a flat fill):
  Per pixel, Rec.709 luminance L in sRGB space drives a modulation m = L / mean(L)
  of that pixel's class; the class palette colour is multiplied by m (with a soft
  shoulder above m=1.15 so baked highlights don't hard-clip). Cavity darks, rust
  speckle and grime live in L, so they survive; only the mean hue/saturation move.
  Two classes, split by source hue (the Poly Haven atlas is already colour-coded):
    cool steel (hue 100-300 deg, or near-neutral s<0.06)  -> pad cream enamel
    warm rust / painted hardware (flanges, valves, props) -> safety orange

Palette targets (read from the repo, not invented):
  cream  (0.795, 0.775, 0.735)  = `bar_white` tint, tools/blender/rsbtex.py:689
  orange (0.714, 0.416, 0.197)  = sRGB-encode of the runtime `acc_orange` albedo
          (0.468, 0.144, 0.032), src/world/props.js:231 (the SHELL value every
          orange part on the pad is actually rendered at).

Run:  python3 tools/retint_modular_industrial_pipes_01.py
Headless, host python3 only (Pillow + numpy, same as rsbtex.py); re-runnable.
"""
import json
import math
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__ + "/.."))
SRC_DIR = os.path.join(ROOT, "staging/cc0/modular_industrial_pipes_01")
BUILD_DIR = os.path.join(ROOT, "staging/cc0/modular_industrial_pipes_01_retint_src")
OUT_GLB = os.path.join(ROOT, "staging/modular_industrial_pipes_01_retinted.glb")

CREAM = np.array([0.795, 0.775, 0.735])   # rsbtex.py:689 bar_white tint
ORANGE = np.array([0.714, 0.416, 0.197])  # sRGB of props.js:231 acc_orange linear (0.468,0.144,0.032)


def srgb_encode(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1.0 / 2.4) - 0.055)


def hsv(a):
    """a: (h,w,3) float 0-1 -> hue deg, saturation, Rec.709 luminance (sRGB space)."""
    mx = a.max(-1)
    mn = a.min(-1)
    d = mx - mn
    eps = 1e-9
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    h = np.where(mx == r, ((g - b) / (d + eps)) % 6,
                 np.where(mx == g, (b - r) / (d + eps) + 2, (r - g) / (d + eps) + 4)) * 60.0
    s = np.where(mx > 0, d / np.maximum(mx, eps), 0.0)
    L = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return h, s, L


def mean_hue(h, s):
    """Saturation-weighted circular mean hue in degrees."""
    w = s.ravel()
    ang = np.deg2rad(h.ravel())
    x = (w * np.cos(ang)).sum()
    y = (w * np.sin(ang)).sum()
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def retint(rgb):
    """rgb: (1024,1024,3) float 0-1 -> retinted float 0-1 + per-class stats."""
    h, s, L = hsv(rgb)
    cool = ((h >= 100) & (h <= 300)) | (s < 0.06)
    out = np.empty_like(rgb)
    info = {}
    for mask, target, key in ((cool, CREAM, "cream"), (~cool, ORANGE, "orange")):
        if not mask.any():
            info[key] = dict(frac=0.0)
            continue
        Lc = L[mask]
        m = Lc / Lc.mean()                       # mean-1 modulation: keeps grime contrast
        knee = 1.15
        m = np.where(m <= knee, m, knee + (m - knee) / (1.0 + 1.8 * (m - knee)))  # soft shoulder
        out[mask] = (target[None, :] * m[:, None]).clip(0, 1)
        info[key] = dict(frac=float(mask.mean()), L_mean_src=float(Lc.mean()),
                         gain=float(target @ np.array([0.2126, 0.7152, 0.0722]) / Lc.mean()))
    return out, info


def stats(a):
    return [dict(mean=float(a[..., i].mean()), std=float(a[..., i].std())) for i in range(3)]


def main():
    # linear target check: props.js acc_orange (0.468,0.144,0.032) -> sRGB
    chk = srgb_encode([0.468, 0.144, 0.032])
    assert np.allclose(chk, ORANGE, atol=0.002), chk

    gltf = json.load(open(os.path.join(SRC_DIR, "modular_industrial_pipes_01_1k.gltf")))
    assert len(gltf["materials"]) == 2 and len(gltf["images"]) == 6
    for m in gltf["materials"]:
        assert "baseColorFactor" not in m["pbrMetallicRoughness"], "factor not white; revisit"

    # --- rebuild a gltf source tree with the two diff maps replaced by *_col ----
    tex_src = os.path.join(SRC_DIR, "textures")
    tex_dst = os.path.join(BUILD_DIR, "textures")
    if os.path.isdir(BUILD_DIR):
        shutil.rmtree(BUILD_DIR)
    os.makedirs(tex_dst)
    shutil.copy(os.path.join(SRC_DIR, "modular_industrial_pipes_01.bin"), BUILD_DIR)

    report = {}
    for img in gltf["images"]:
        name = img["name"]
        if name.endswith("_diff"):
            tag = name[: -len("_diff")]
            src = os.path.join(tex_src, os.path.basename(img["uri"]))
            a = np.asarray(Image.open(src).convert("RGB")).astype(np.float64) / 255.0
            assert a.shape == (1024, 1024, 3), a.shape
            b, info = retint(a)
            h0, s0, _ = hsv(a)
            h1, s1, _ = hsv(b)
            outp = os.path.join(tex_dst, tag + "_col.jpg")
            Image.fromarray((b * 255).round().astype(np.uint8)).save(outp, quality=92)
            img["uri"] = "textures/" + tag + "_col.jpg"
            img["name"] = tag + "_col"
            report[tag] = dict(
                src=src, new=outp, classes=info,
                mean_hue_before=round(mean_hue(h0, s0), 1), mean_hue_after=round(mean_hue(h1, s1), 1),
                before=dict(shape=list(a.shape), stats=stats(a)),
                after=dict(shape=list(b.shape), stats=stats(b)),
            )
        else:
            shutil.copy(os.path.join(tex_src, os.path.basename(img["uri"])), tex_dst)

    gname = os.path.join(BUILD_DIR, "modular_industrial_pipes_01.gltf")
    json.dump(gltf, open(gname, "w"))

    # --- merge to a single GLB with the repo converter ---------------------------
    r = subprocess.run(["node", os.path.join(ROOT, "tools/gltf_to_glb.mjs"), gname, OUT_GLB],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout, r.stderr, file=sys.stderr)
        sys.exit(r.returncode)
    conv = json.loads(r.stdout)

    # --- verify: geometry bytes identical, tri count, image dims, map stats ------
    import struct
    glb = open(OUT_GLB, "rb").read()
    jlen = struct.unpack_from("<I", glb, 12)[0]
    j = json.loads(glb[20:20 + jlen])
    bin0 = glb[20 + jlen + 8:]
    geom = open(os.path.join(SRC_DIR, "modular_industrial_pipes_01.bin"), "rb").read()
    assert bin0[:len(geom)] == geom, "geometry BIN chunk changed!"
    tris = sum(j["accessors"][p["indices"]]["count"] // 3
               for m in j["meshes"] for p in m["primitives"])
    embedded = {}
    for img in j["images"]:
        bv = j["bufferViews"][img["bufferView"]]
        data = bin0[bv["byteOffset"]:bv["byteOffset"] + bv["byteLength"]]
        im = Image.open(__import__("io").BytesIO(data))
        embedded[img["name"]] = dict(mime=img["mimeType"], size=list(im.size),
                                     bytes=len(data),
                                     sha=__import__("hashlib").sha256(data).hexdigest()[:12])
    # byte-identity of untouched channels vs the source files
    same = {}
    for f in sorted(os.listdir(tex_src)):
        p2 = os.path.join(tex_dst, f)
        if f.endswith("_diff_1k.jpg"):
            continue
        import hashlib
        same[f] = hashlib.sha256(open(os.path.join(tex_src, f), "rb").read()).hexdigest() == \
                  hashlib.sha256(open(p2, "rb").read()).hexdigest()
    print(json.dumps(dict(
        out_glb=OUT_GLB, bytes=conv["bytes"], triangles=tris,
        bbox_m=conv["bboxSizeMeters"], meshPrims=conv["meshPrims"],
        geometry_bin_identical=True, untouched_channels_identical=same,
        embedded=embedded, retint=report), indent=1))


if __name__ == "__main__":
    main()
