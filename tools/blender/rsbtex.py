# rsbtex — PBR texture forge for the RED STARBASE hero assets.
#
# Why this exists: modelling a 1.25 m girth weld as 3 cm of radius modulation gives a
# launch stack whose shading turns into a pile of dinner plates, and a thermal-protection
# blanket with no tile field is a grey sticker on a barrel. Both details are millimetre
# scale on the real vehicle, so they belong in normal/roughness maps, not in the mesh.
# These maps are exactly periodic and get packed into the exported GLB — the app never
# attaches anything.
#
# Run this one on the host (`python3 tools/blender/rsbtex.py`), not inside Blender: the
# bundled interpreter ships no Pillow. It writes the PNGs plus a manifest carrying each
# field's repeat size, which the builders read to author their UVs.
#
# Every field is authored in metres and rasterised at a uniform px/m, so a 300 mm tile and
# a 1250 mm weld pitch mean what they say. Each forge returns (maps, u_m, v_m): the size of
# one texture repeat in metres, which the builder needs to set the mesh UVs to match.
import math, os, numpy as np
from PIL import Image, ImageDraw, ImageFont

TEXDIR = "/tmp/rsb_tex"
TAU = math.tau
PITCH_WELD = 1.25            # the pitch stainless ring segments actually arrive on
TILE_TPS = 0.30              # thermal tile, flat edge to flat edge
SQ3 = math.sqrt(3.0)


# ─────────────────────────── raster helpers ───────────────────────────
def _mesh(w, h, pm):
    """Pixel-centre coordinates in metres, u across and v up; both arrays are (h, w)."""
    U, V = np.meshgrid((np.arange(w) + 0.5) / pm, (np.arange(h) + 0.5) / pm)
    return U, V


def height_to_normal(h, strength=1.0):
    """Central differences on a wrapping height field -> tangent-space, +Y-up normal."""
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * strength
    gy = (np.roll(h, 1, 0) - np.roll(h, -1, 0)) * 0.5 * strength
    ln = np.sqrt(gx * gx + gy * gy + 1.0)
    return np.dstack([(1.0 - gx / ln) * 127.5, (1.0 - gy / ln) * 127.5,
                      (1.0 / ln) * 255.0]).astype(np.uint8)


def _save(arr, name):
    os.makedirs(TEXDIR, exist_ok=True)
    p = os.path.join(TEXDIR, name + ".png")
    mode = "L" if arr.ndim == 2 else ("RGB" if arr.shape[2] == 3 else "RGBA")
    Image.fromarray(arr.astype(np.uint8), mode).save(p)
    return p


def _pnoise(w, h, fu, fv, seed):
    """Value noise sampled off a wrapping lattice, so a map tiled 2x2 has no seam. PIL's
    resize clamps its edges, which paints a hard dark line every time the texture repeats
    — visible on a barrel as a ring of bands marching up the hull."""
    rng = np.random.default_rng(seed)
    g = rng.random((fv, fu))
    x = np.arange(w) * fu / w
    y = np.arange(h) * fv / h
    x0 = np.floor(x).astype(np.int64); fx = x - x0
    y0 = np.floor(y).astype(np.int64); fy = y - y0
    sx = (fx * fx * (3 - 2 * fx))[None, :]
    sy = (fy * fy * (3 - 2 * fy))[:, None]
    a = g[np.ix_(y0, x0)]; b = g[np.ix_(y0, (x0 + 1) % fu)]
    c = g[np.ix_((y0 + 1) % fv, x0)]; d = g[np.ix_((y0 + 1) % fv, (x0 + 1) % fu)]
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy


def _streaks(w, h, fu, fv, seed):
    """A noise field stretched along v, so it reads as a line running down the barrel
    rather than per-pixel static that aliases the moment it enters a normal map."""
    return _pnoise(w, h, fu, fv, seed) - 0.5


# ─────────────────────────── brushed stainless ───────────────────────────
def steel_maps(tag="steel", pm=400.0):
    """Rolled-and-welded 30X stainless: vertical brush streaks, a coarse girth weld with
    its heat-affected haze, and a film of dust that takes the mirror off the metal.
    Repeats every 2.5 m in both axes — exactly two weld pitches vertically."""
    u_m = v_m = 2.0 * PITCH_WELD
    w = h = int(round(u_m * pm))
    V = _mesh(w, h, pm)[1]

    # girth weld: a tight crown plus a wide discoloured shoulder, on the 1.25 m pitch
    d = V % PITCH_WELD
    d = np.minimum(d, PITCH_WELD - d)
    weld = np.clip(np.exp(-(d / 0.028) ** 2)
                   + 0.42 * np.clip(np.exp(-((d - 0.055) / 0.16) ** 2) - 0.25, 0, 1), 0, 1)

    # the brush runs along the barrel: narrow in u, near-constant down v
    grain = _streaks(w, h, 150, 4, 20260921) * 0.75 + _streaks(w, h, 400, 2, 606) * 0.25
    dust = _pnoise(w, h, 16, 16, 999)

    base = np.clip(232 + dust * 22 - 20 * weld + grain * 26, 188, 255)
    rough = np.clip(158 + dust * 40 + 58 * weld + grain * 62, 96, 255)
    maps = {"basecolor": _save(np.dstack([base, base * 0.995, base * 0.982]), tag + "_col"),
            "rough": _save(rough, tag + "_rgh"),
            "normal": _save(height_to_normal(weld + grain * 0.045, 26.0), tag + "_nrm")}
    return maps, u_m, v_m


# ─────────────────────────── thermal protection ───────────────────────────
def _hex_distance(U, V, s):
    """Distance to the nearest hexagon boundary, normalised: 0 at a cell centre, 1 on its
    grout line. A pointy-top hexagon is the intersection of three slabs whose normals sit
    at 0, 60 and 120 degrees, so the metric is the max of three axis projections."""
    a = SQ3 / 2 * s                      # apothem
    px, py = SQ3 * s, 1.5 * s            # centre pitch along a row, and between rows
    r0 = np.floor(V / py).astype(np.int64)
    c0 = np.round((U - 0.5 * px * (r0 % 2)) / px).astype(np.int64)
    best = np.full(U.shape, 1e9)
    for dj in range(-2, 3):
        rr = r0 + dj
        oy = rr * py
        base = c0 * px + 0.5 * px * (rr % 2)
        for di in range(-2, 3):
            dx, dy = U - (base + di * px), V - oy
            best = np.minimum(best, np.maximum.reduce(
                [np.abs(dx), np.abs(0.5 * dx + 0.8660254 * dy),
                 np.abs(0.5 * dx - 0.8660254 * dy)]) / a)
    return best


def tps_maps(tag="tps", pm=470.0, tint=1.0):
    """A field of 300 mm hexagonal cells with grout between them. The app tints nothing —
    the exporter only reliably carries a straight image into Base Color — so the pale
    silica blanket and the carbon-black windward nose are the same field rasterised twice.
    The lattice is periodic in u every 7 cells and in v every 8 rows (an even row count, so
    the half-cell offset lines up), hence the deliberately non-square map."""
    s = TILE_TPS / SQ3                   # circumradius of a 300 mm flat-to-flat cell
    cols, rows = 7, 8
    u_m, v_m = cols * SQ3 * s, rows * 1.5 * s
    w, h = int(round(u_m * pm)), int(round(v_m * pm))
    U, V = _mesh(w, h, pm)
    edge = _hex_distance(U, V, s)
    grout = np.clip((edge - 0.88) / 0.12, 0, 1)
    speck = (np.random.default_rng(7717).random(U.shape) - 0.5)
    grit = _pnoise(w, h, 22, 22, 3131)
    base = np.clip((246 - 86 * grout + speck * 16 + grit * 12) * tint, 4, 255)
    rough = np.clip(186 + 60 * grout + speck * 14 - grit * 10, 120, 255)
    maps = {"basecolor": _save(np.dstack([base, base * 0.997, base * 0.990]), tag + "_col"),
            "rough": _save(rough, tag + "_rgh"),
            "normal": _save(height_to_normal((grout - 0.5) * 1.8 + grit * 0.05, 7.0), tag + "_nrm")}
    return maps, u_m, v_m


# ─────────────────────────── burnt aft skirt ───────────────────────────
def burnt_maps(tag="burnt", pm=400.0):
    """Straw-blue heat oxide broken by the vertical soot streaks every Raptor start paints
    up the skirt. Kept periodic in both axes so it can tile the whole band."""
    u_m = v_m = 2.0 * PITCH_WELD
    w = h = int(round(u_m * pm))
    streak = _streaks(w, h, 54, 4, 4242) + _streaks(w, h, 150, 2, 88) * 0.4
    tone = np.clip(152 + streak * 66 + _pnoise(w, h, 7, 7, 77) * 16, 84, 224)
    maps = {"basecolor": _save(np.dstack([tone, tone * 0.895, tone * 0.71]), tag + "_col"),
            "rough": _save(np.clip(200 + streak * 46, 150, 255), tag + "_rgh"),
            "normal": _save(height_to_normal(streak * 0.06, 3.5), tag + "_nrm")}
    return maps, u_m, v_m


# ─────────────────────────── painted panel metal ───────────────────────────
def panel_maps(tag="panel", pm=600.0, tile=0.85, tint=(1.0, 1.0, 1.0), base=236.0,
               rough_base=150.0, rivet=0.045):
    """Painted panel metal: a rollcoat sheen, one parting seam every `tile` metres in each
    axis, and a countersunk rivet on the seam every `rivet` metres. A 6 mm gap modelled into
    a 4 m hull is a groove you can only see by flying through it, so the seams and the rivet
    lines live here and the mesh stays a clean loft. `tint` is multiplied into the map
    because the glTF exporter carries a multiply chain as nothing at all."""
    u_m = v_m = tile
    w = h = int(round(tile * pm))
    U, V = _mesh(w, h, pm)
    du = np.minimum(U % tile, tile - U % tile)
    dv = np.minimum(V % tile, tile - V % tile)
    gw = 0.006                                     # the gap itself
    seam = np.clip(1.0 - du / gw, 0, 1) + np.clip(1.0 - dv / gw, 0, 1)
    # a deburred edge holds a fillet of paint, so the metal gets slightly brighter either
    # side of the gap before it falls back to the field
    lip = (np.clip(1.0 - np.abs(du - 1.7 * gw) / (1.5 * gw), 0, 1)
           + np.clip(1.0 - np.abs(dv - 1.7 * gw) / (1.5 * gw), 0, 1))
    rr = rivet * 0.16                              # rivet head radius
    if rivet > 0:
        ru = np.minimum(U % rivet, rivet - U % rivet)
        rv = np.minimum(V % rivet, rivet - V % rivet)
        dots = np.clip(np.exp(-((ru / rr) ** 2 + (dv / rr) ** 2))
                       + np.exp(-((rv / rr) ** 2 + (du / rr) ** 2)), 0, 1)
    else:
        dots = np.zeros_like(seam)
    # the noise cells are absolute lengths, not fractions of the tile: a robot's 240 mm
    # shell and a rover's 850 mm panel must show the same 6 mm orange peel, and a
    # cell count fixed per tile gives a small part stucco instead of paint
    peel = _pnoise(w, h, max(4, int(round(tile / 0.006))),
                   max(4, int(round(tile / 0.006))), 4711) - 0.5
    roll = _pnoise(w, h, max(2, int(round(tile / 0.30))),
                   max(2, int(round(tile / 0.30))), 88)
    height = -seam + lip * 0.3 + dots * 0.5 + peel * 0.022
    tone = np.clip(base + roll * 9 + peel * 4 - seam * 54 + lip * 13 + dots * 14, 30, 255)
    rough = np.clip(rough_base + roll * 16 + seam * 46 - dots * 10 + peel * 6, 50, 255)
    maps = {"basecolor": _save(np.dstack([tone * tint[0], tone * tint[1], tone * tint[2]]),
                               tag + "_col"),
            "rough": _save(rough, tag + "_rgh"),
            "normal": _save(height_to_normal(height, 11.0), tag + "_nrm")}
    return maps, u_m, v_m


# ─────────────────────────── precast concrete ───────────────────────────
def concrete_maps(tag="concrete", pm=400.0, tile=1.80, tint=(1.0, 1.0, 1.0), joints=True):
    """Precast concrete: the board joints a form leaves behind, a form-tie dimple at each
    joint's quarter points, dust in the hollows and fine aggregate standing proud of the
    slurry. Cast steps read as poured work because of the joints and the ties, and nothing
    else on them says so."""
    u_m = v_m = tile
    w = h = int(round(tile * pm))
    U, V = _mesh(w, h, pm)
    du = np.minimum(U % tile, tile - U % tile)
    dv = np.minimum(V % tile, tile - V % tile)
    if joints:
        seam = np.clip(1.0 - du / 0.010, 0, 1) + np.clip(1.0 - dv / 0.010, 0, 1)
        seam = np.clip(seam, 0, 1)
        tie = np.exp(-(((du - tile / 4) / 0.020) ** 2 + (np.minimum(dv, tile - dv) / 0.020) ** 2)) \
            + np.exp(-(((tile / 2 - du) / 0.020) ** 2 + (np.minimum(dv, tile - dv) / 0.020) ** 2)) \
            + np.exp(-(((du - 3 * tile / 4) / 0.020) ** 2 + (np.minimum(dv, tile - dv) / 0.020) ** 2))
        tie = np.clip(tie, 0, 1)
    else:
        seam = tie = np.zeros_like(du)
    grit = _pnoise(w, h, int(tile / 0.0045), int(tile / 0.0045), 505) - 0.5
    blotch = _pnoise(w, h, max(2, int(tile / 0.55)), max(2, int(tile / 0.55)), 707)
    dust = _pnoise(w, h, max(2, int(tile / 1.7)), max(2, int(tile / 1.7)), 313)
    height = -seam * 0.9 - tie * 0.5 + grit * 0.5 + blotch * 0.12
    tone = np.clip(196 - seam * 34 - tie * 20 + grit * 16 + blotch * 26 + dust * 12, 60, 240)
    rough = np.clip(206 + grit * 26 - blotch * 16 + seam * 14, 120, 255)
    maps = {"basecolor": _save(np.dstack([tone * tint[0], tone * tint[1] * 0.985,
                                          tone * tint[2] * 0.96]), tag + "_col"),
            "rough": _save(rough, tag + "_rgh"),
            "normal": _save(height_to_normal(height, 9.0), tag + "_nrm")}
    return maps, u_m, v_m


# ─────────────────────────── woven vinyl ───────────────────────────
def weave_maps(tag="weave", pm=900.0, tile=0.024, tint=(1.0, 1.0, 1.0), base=150.0):
    """The mesh a stadium seat is slung on: two sets of strands at right angles, each one
    rounding over and pinching the other. `tile` is a strand pair, so it is only a few
    millimetres — which is exactly the scale no modelled geometry could reach."""
    u_m = v_m = tile
    w = h = int(round(tile * pm))
    U, V = _mesh(w, h, pm)
    a = np.sin(U / tile * TAU) * 0.5 + 0.5
    b = np.sin(V / tile * TAU) * 0.5 + 0.5
    over = np.where(a > b, a, -b)                       # which strand is on top
    crown = np.abs(over)
    grit = _pnoise(w, h, 3, 3, 909)
    tone = np.clip(base + crown * 58 + grit * 12, 20, 255)
    rough = np.clip(178 - crown * 46 + grit * 18, 70, 255)
    maps = {"basecolor": _save(np.dstack([tone * tint[0], tone * tint[1], tone * tint[2]]),
                               tag + "_col"),
            "rough": _save(rough, tag + "_rgh"),
            "normal": _save(height_to_normal(crown + grit * 0.10, 5.0), tag + "_nrm")}
    return maps, u_m, v_m


# ─────────────────────────── painted lettering ───────────────────────────
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def decal_maps(text, tag, w_m, h_m, pm=300.0, ink=(30, 29, 27), cover=0.90, track=0.18):
    """Lettering as one RGBA decal: the RGB is the paint, the alpha is where the paint is.
    Everywhere else the surface underneath shows through, so a wordmark arrives as paint on
    the hull rather than as a grey rectangle welded to it. Sized to fill `cover` of the
    panel and letterspaced, because that is how a wordmark is applied to a vehicle."""
    w, h = int(round(w_m * pm)), int(round(h_m * pm))
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    fs, adv, total = h, [], 0.0
    while fs > 10:
        f = ImageFont.truetype(FONT_BOLD, int(fs))
        adv = [int(fs * 0.42) if c == " " else d.textbbox((0, 0), c, font=f)[2] for c in text]
        total = sum(adv) + fs * track * (len(text) - 1)
        if total <= w * cover and max(adv) <= h * 0.56:
            break
        fs -= 2
    f = ImageFont.truetype(FONT_BOLD, int(fs))
    x = (w - total) / 2.0
    for c, a in zip(text, adv):
        if c != " ":
            d.text((x + a / 2.0, h / 2.0), c, font=f, fill=255, anchor="mm")
        x += a + fs * track
    rgb = np.zeros((h, w, 4), np.uint8)
    rgb[..., 0], rgb[..., 1], rgb[..., 2] = ink
    rgb[..., 3] = np.asarray(mask)
    return {"decal": _save(rgb, tag + "_decal")}, w_m, h_m


PANELS = {
    # Every tint is baked into the map: the exporter carries a multiply chain as nothing.
    "crew_paint":  lambda: panel_maps(tag="crew_paint", tint=(0.905, 0.878, 0.816), base=224,
                                      rough_base=168, tile=0.62),
    "crew_frame":  lambda: panel_maps(tag="crew_frame", tint=(0.30, 0.295, 0.288), base=236,
                                      rough_base=150, tile=0.60, rivet=0.036),
    "crew_metal":  lambda: panel_maps(tag="crew_metal", tint=(0.60, 0.607, 0.625), base=250,
                                      rough_base=104, tile=0.45, rivet=0.030),
    "crew_foil":   lambda: panel_maps(tag="crew_foil", tint=(0.565, 0.44, 0.196), base=255,
                                      rough_base=86, tile=0.28, rivet=0.022),
    "bot_shell":   lambda: panel_maps(tag="bot_shell", tint=(0.90, 0.895, 0.882), base=238,
                                      rough_base=118, tile=0.24, rivet=0.018),
    "bot_poly":    lambda: panel_maps(tag="bot_poly", tint=(0.108, 0.108, 0.118), base=240,
                                      rough_base=132, tile=0.30, rivet=0.0),
    "bot_joint":   lambda: panel_maps(tag="bot_joint", tint=(0.47, 0.472, 0.478), base=250,
                                      rough_base=92, tile=0.16, rivet=0.012),
}

ALL = dict(PANELS, **{"steel": steel_maps, "tps": tps_maps,
       "tps_dark": lambda: tps_maps(tag="tps_dark", tint=0.055), "burnt": burnt_maps,
       "wordmark": lambda: decal_maps("STARBASE", "wordmark", 7.3, 5.0),
       "deck_cast": lambda: concrete_maps(tag="deck_cast", tint=(0.615, 0.585, 0.525)),
       "deck_plate": lambda: concrete_maps(tag="deck_plate", tile=1.5, joints=False,
                                           tint=(0.30, 0.275, 0.245)),
       "deck_weave": lambda: weave_maps(tag="deck_weave", tint=(0.34, 0.52, 0.72)),
       "gate_cast": lambda: concrete_maps(tag="gate_cast", tile=1.55,
                                          tint=(0.66, 0.635, 0.575)),
       "gate_metal": lambda: panel_maps(tag="gate_metal", tint=(0.575, 0.565, 0.545),
                                        base=232, rough_base=132, tile=1.10, rivet=0.055),
       "gate_dark": lambda: panel_maps(tag="gate_dark", tint=(0.20, 0.198, 0.20),
                                       base=236, rough_base=150, tile=0.70, rivet=0.0),
       "plaza_pave": lambda: concrete_maps(tag="plaza_pave", tile=0.95,
                                          tint=(0.44, 0.405, 0.362)),
       "plaza_ring": lambda: concrete_maps(tag="plaza_ring", tile=1.45, joints=False,
                                          tint=(0.56, 0.525, 0.472)),
       })


if __name__ == "__main__":
    import json
    doc = {}
    for k, fn in ALL.items():
        maps, um, vm = fn()
        doc[k] = {"maps": maps, "u_m": um, "v_m": vm}
        print("%-9s u=%.4f m v=%.4f m" % (k, um, vm), maps)
    with open(os.path.join(TEXDIR, "manifest.json"), "w") as f:
        json.dump(doc, f, indent=1)
