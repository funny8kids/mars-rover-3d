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
def concrete_maps(tag="concrete", pm=400.0, tile=1.80, tint=(1.0, 1.0, 1.0), joints=True,
                  nrm=9.0):
    """Precast concrete: the board joints a form leaves behind, a form-tie dimple at each
    joint's quarter points, dust in the hollows and fine aggregate standing proud of the
    slurry. Cast steps read as poured work because of the joints and the ties, and nothing
    else on them says so.

    `nrm` is how far that relief is pushed into the normal map, and it has to travel with the
    part's size: 9.0 sells a 40 cm tread two metres away, and the same value on a 300 mm kerb
    seen from a metre turns the aggregate into stucco."""
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
            "normal": _save(height_to_normal(height, nrm), tag + "_nrm")}
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


# ─────────────────────────── painted hazard stripes ───────────────────────────
def stripe_maps(tag="stripe", pm=560.0, tile=0.24, ca=(0.865, 0.845, 0.80),
                cb=(0.70, 0.105, 0.062), slope=(1, 2)):
    """Road-marking enamel laid over extruded metal. Two things make stripes read as paint
    rather than as a flag: the band edge is a 100 micron step, so it catches a hard line in
    the highlight, and the pale bands are the ones that go chalky with dust while the red
    side keeps its gloss. `slope` is a pair of small integers — the diagonal is (sU*x + sV*y),
    so the pattern advances by whole bands whenever either axis repeats, and the field tiles
    seamlessly at any UV scale. A non-integer angle would leave a seam every `tile` metres,
    which on a 2 m rail shows up as a bar marching along the barrier."""
    u_m = v_m = tile
    w = h = int(round(tile * pm))
    U, V = _mesh(w, h, pm)
    s = (U * slope[0] + V * slope[1]) % tile
    half = tile * 0.5
    red = s < half
    edge = np.minimum(s, tile - s)                    # distance to the nearest band line
    film = np.clip(1.0 - edge / 0.0016, 0, 1)         # the bead of enamel at each edge
    grit = _pnoise(w, h, int(tile / 0.0028), int(tile / 0.0028), 1201) - 0.5
    chalk = _pnoise(w, h, max(2, int(tile / 0.035)), max(2, int(tile / 0.035)), 733)
    scuff = _pnoise(w, h, max(2, int(tile / 0.006)), max(2, int(tile / 0.006)), 991)
    pale = np.where(red, 0.0, 1.0)
    tone_u = np.clip(1.0 - pale * chalk * 0.17 - scuff * 0.07 - film * 0.05, 0.6, 1.0)
    base = np.where(red[..., None], np.array(cb, float), np.array(ca, float))
    col = np.clip(base * (tone_u * 255.0)[..., None], 0, 255)
    rough = np.clip(150 + pale * 62 + chalk * 30 - film * 26 + grit * 12, 60, 255)
    height = film * 0.85 + grit * 0.4 - np.where(red, 0.0, chalk * 0.25)
    maps = {"basecolor": _save(col, tag + "_col"),
            "rough": _save(rough, tag + "_rgh"),
            "normal": _save(height_to_normal(height, 8.0), tag + "_nrm")}
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


# ─────────────────────────── a printed sign face ───────────────────────────
def sign_face_maps(tag, w_m, h_m, title="DANGER", lines=(), pm=420.0,
                   field=(176, 138, 58), ink=(34, 31, 29), dust=(186, 156, 116)):
    """The laminated face of a safety placard: enamel print under a UV film, weathered where
    it stands. This is the one field here that does not tile — a sign is a graphic, not a
    surface, so it is authored at the panel's exact metre size and the builder gives it planar
    UVs that map 1:1. That is also why the legend is 70 mm: it is drawn at the size it would
    be printed, so it reads at the distance a driver has to read it.

    The artwork is drawn (PIL polygons plus the same DejaVu Bold a stencil shop uses), then
    weathered by the same passes as everything else: chalk on the pale field, an ultraviolet
    bleed-down from the top edge, a dust creep up the bottom, and a fine grit both ways. The
    roughness plane is what sells it — printed enamel keeps its gloss while the chalked metal
    around it loses it, so a sign reads as film on a plate rather than as a painted rectangle.
    The relief comes from the artwork's own edges: the print does sit proud of the laminate by
    a few microns, and normal-mapping the outline is what makes the lettering catch the sun."""
    w, h = int(round(w_m * pm)), int(round(h_m * pm))
    X0, Z0 = w / 2.0, h / 2.0            # metres->pixels, v up in the mesh, y down in the file

    def px(x_m): return X0 + x_m * pm
    def py(z_m): return h - (Z0 + z_m * pm)

    col = Image.new("RGB", (w, h), field)
    ink_m = Image.new("L", (w, h), 0)     # 255 wherever enamel is laid down
    d, di = ImageDraw.Draw(col), ImageDraw.Draw(ink_m)

    def poly(pts, fill):
        q = [(px(x), py(z)) for x, z in pts]
        d.polygon(q, fill=fill)
        di.polygon(q, fill=255 if fill == ink else 0)

    def rect(x0, z0, x1, z1, fill):
        poly([(x0, z0), (x1, z0), (x1, z1), (x0, z1)], fill)

    def rule(x0, z0, x1, z1, t):
        """An outlined rectangle of thickness t: the border rule every placard carries."""
        rect(x0, z0, x1, z0 + t, ink); rect(x0, z1 - t, x1, z1, ink)
        rect(x0, z0, x0 + t, z1, ink); rect(x1 - t, z0, x1, z1, ink)

    HW, HH = w_m / 2.0, h_m / 2.0
    rule(-HW + 0.055, -HH + 0.055, HW - 0.055, HH - 0.055, 0.020)

    # ── the ISO warning triangle: a ring of black, the field showing through the middle ──
    TCX, TCZ, R = -HW + 0.46, 0.02, 0.345
    tri = [(TCX + R * math.sin(a), TCZ - R * 0.52 + R * math.cos(a) * 1.12)
           for a in (0.0, TAU / 3.0, 2.0 * TAU / 3.0)]
    poly(tri, ink)
    # The inner triangle is inset about the *centroid*, because that is the one centre from
    # which a uniform scale is a uniform perpendicular inset. Scale about the apex-height mean
    # instead — as `TCZ` is — and the border comes out twice as thick along the base as along
    # the sides, which is the exact tell of a hand-placed warning sign.
    CX, CZ = TCX, sum(p[1] for p in tri) / 3.0
    poly([(CX + (p[0] - CX) * 0.72, CZ + (p[1] - CZ) * 0.72) for p in tri], field)
    # The exclamation is sized against that inset ring — the inner triangle spans 417 mm and
    # closes to 215 mm half-width at its foot — so no stroke of it bleeds into the black.
    poly([(TCX - 0.045, TCZ - 0.135), (TCX + 0.045, TCZ - 0.135),
          (TCX + 0.026, TCZ + 0.015), (TCX - 0.026, TCZ + 0.015)], ink)
    poly([(TCX - 0.034, TCZ - 0.245), (TCX + 0.034, TCZ - 0.245),
          (TCX + 0.034, TCZ - 0.185), (TCX - 0.034, TCZ - 0.185)], ink)

    # ── the legend, left-aligned off the triangle's corner, sized like a printed placard ──
    LX, RX = -HW + 0.94, HW - 0.085          # the text column, clear of the art and the rule

    def word(s, z_m, cap_m):
        """Draw at the cap height asked for, or as near to it as the column allows. The legend
        is authored per site rather than tuned to this width, and a sign whose second line runs
        off the plate is worse than a sign with slightly small type."""
        size = int(cap_m * pm)
        f = ImageFont.truetype(FONT_BOLD, size)
        while size > 12 and d.textlength(s, font=f) > (RX - LX) * pm:
            size = int(size * 0.94)
            f = ImageFont.truetype(FONT_BOLD, size)
        d.text((px(LX), py(z_m)), s, font=f, fill=ink, anchor="lm")
        di.text((px(LX), py(z_m)), s, font=f, fill=255, anchor="lm")

    word(title, 0.235, 0.185)
    z = 0.030
    for s in lines:
        word(s, z, 0.072)
        z -= 0.132

    base = np.asarray(col, float) / 255.0
    inm = np.asarray(ink_m, float) / 255.0
    U, V = _mesh(w, h, pm)
    # `_mesh` counts v from the file's first row, which is the picture's top — so metres up from
    # the panel's middle is h_m/2 - V, not V - h_m/2. Get that sign wrong and the saltation band
    # buries the upper half of the graphic instead of the foot of the board.
    zz = h_m / 2.0 - V                      # metres up from the panel's middle
    grit = _pnoise(w, h, int(w_m / 0.0022), int(h_m / 0.0022), 211) - 0.5
    chalk = _pnoise(w, h, max(2, int(w_m / 0.34)), max(2, int(h_m / 0.20)), 407)
    blotch = _pnoise(w, h, max(2, int(w_m / 0.9)), max(2, int(h_m / 0.5)), 913)
    pale = 1.0 - inm                        # the field, not the enamel
    # Chalking, not darkening: UV lifts an exposed placard's pigment toward the laminate's own
    # bone, and it works from the crown down because that is the half the sun sees. The enamel
    # resists most of it — which is the difference between a faded sign and merely a dirty one.
    crown = np.clip(0.62 + zz / (2.0 * h_m), 0.0, 1.0)
    fade = np.clip(0.34 * crown + 0.13 * chalk + 0.07 * blotch, 0.0, 1.0) * (0.22 + 0.78 * pale)
    colr = base + (base * 0.45 + 0.52 - base) * fade[..., None]
    # Saltation carries grit up the foot of a vertical face and stops, ragged, where the wind
    # could not lift it further. It is a film laid over the print rather than paint on the
    # metal, so it lightens the black about as much as it yellows the field: contrast falls,
    # hue does not. And it reaches ~120 mm, not half the board — the panel stands on legs.
    foot = zz + HH                          # metres above the panel's own bottom edge
    creep = np.clip((0.115 + 0.070 * chalk - foot) / 0.085, 0.0, 1.0) * 0.70
    colr = colr + (np.array(dust, float) / 255.0 - colr) * creep[..., None]
    colr += grit[..., None] * 0.040
    rough = np.clip(86 + pale * 30 + fade * 52 + creep * 74 + grit * 12, 60, 255)
    edge = (np.abs(inm - np.roll(inm, 1, 1)) + np.abs(inm - np.roll(inm, 1, 0)))
    # A placard face is not a tiling field: the wrapped differences would weld the top border
    # rule to the bottom one and raise a ridge along the panel's own edge.
    edge[:2, :] = edge[-2:, :] = edge[:, :2] = edge[:, -2:] = 0.0
    height = (np.clip(edge * 2.2, 0, 1) * 0.35 + creep * 0.18 + chalk * 0.07
              + grit * 0.5 - crown * 0.05)
    maps = {"basecolor": _save(np.clip(colr * 255.0, 0, 255), tag + "_col"),
            "rough": _save(rough, tag + "_rgh"),
            "normal": _save(height_to_normal(height, 3.0), tag + "_nrm")}
    return maps, w_m, h_m


# ─────────────────────────── a drum's oxidiser placard ───────────────────────────
def oxidiser_placard_maps(tag="cryo_placard", w_m=0.24, h_m=0.30, pm=1000.0):
    """The 240 × 300 mm laminate riveted to a cryo drum's shoulder: the ISO 5.1 oxidiser
    diamond — flame over a circle, category number in the bottom vertex — over the printed
    proper shipping name and UN number. Like `sign_face_maps` this is a graphic, not a field:
    it is rasterised at the card's exact metres and the builder gives it planar UVs, so the
    legend arrives legible rather than as texture soup.

    The reason a placard cannot be a decal text pass: an unmarked drum is a programmer-art
    drum. The diamond is *why* the crate reads as LOX and not as fuel, and the corner wear —
    printed at 1:1 because that is where a card lifts — is what stops it reading as new print."""
    w, h = int(round(w_m * pm)), int(round(h_m * pm))
    col = Image.new("RGB", (w, h), (233, 229, 219))
    sym = Image.new("L", (w, h), 0)                     # 255 wherever enamel is laid
    d, ds = ImageDraw.Draw(col), ImageDraw.Draw(sym)
    INK = (36, 33, 30)
    YEL = (238, 199, 18)

    def diamond(cx, cy, r, fill):
        pts = [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]
        d.polygon(pts, fill=fill)
        ds.polygon(pts, fill=255 if fill == INK else 0)

    # 170 mm of diamond in the top two thirds: black plate, then the yellow inset by the
    # 9 mm border rule every placard carries.
    DCX, DCY, DR = w / 2.0, h * 0.335, min(w * 0.44, h * 0.30)
    diamond(DCX, DCY, DR, INK)
    diamond(DCX, DCY, DR - 0.009 * pm, YEL)

    # ── the symbol: a circle outline the flame sits over, both in the diamond's upper field ──
    rr = 0.026 * pm
    d.ellipse([DCX - rr, DCY + 0.018 * pm - rr, DCX + rr, DCY + 0.018 * pm + rr],
              outline=INK, width=int(0.006 * pm))
    ds.ellipse([DCX - rr, DCY + 0.018 * pm - rr, DCX + rr, DCY + 0.018 * pm + rr],
               outline=255, width=int(0.006 * pm))
    fshape = [(0.00, -0.95), (-0.44, -0.54), (-0.52, -0.02), (-0.36, 0.38), (-0.15, 0.63),
              (-0.01, 0.81), (0.15, 1.00), (0.25, 0.72), (0.33, 0.49), (0.50, 0.20),
              (0.55, -0.20), (0.42, -0.59), (0.17, -0.86)]
    fs = 0.034 * pm
    fx, fy = DCX - 0.004 * pm, DCY - 0.030 * pm
    d.polygon([(fx + a * fs, fy - b * fs) for a, b in fshape], fill=INK)
    ds.polygon([(fx + a * fs, fy - b * fs) for a, b in fshape], fill=255)

    def word(s, cx, cy, cap_m):
        f = ImageFont.truetype(FONT_BOLD, int(cap_m * pm))
        d.text((cx, cy), s, font=f, fill=INK, anchor="mm")
        ds.text((cx, cy), s, font=f, fill=255, anchor="mm")

    word("5.1", DCX, DCY + DR * 0.60, 0.030)
    word("OXYGEN, LIQUID", w / 2.0, h * 0.715, 0.021)
    word("UN 1073", w / 2.0, h * 0.885, 0.026)
    # corner wear: a card lifts at two opposite corners first, and the laminate under the
    # print is bone, not steel — this is the only damage on the card and it is always there.
    for cx_, cy_ in ((0, 0), (w - 1, h - 1)):
        d.ellipse([cx_ - 0.030 * pm, cy_ - 0.030 * pm, cx_ + 0.030 * pm, cy_ + 0.030 * pm],
                  fill=(196, 186, 168))

    base = np.asarray(col, float) / 255.0
    inm = np.asarray(sym, float) / 255.0
    U, V = _mesh(w, h, pm)
    zz = h_m / 2.0 - V                        # metres up from the card's middle
    grit = _pnoise(w, h, int(w_m / 0.0016), int(h_m / 0.0016), 2113) - 0.5
    chalk = _pnoise(w, h, max(2, int(w_m / 0.055)), max(2, int(h_m / 0.045)), 4407)
    pale = 1.0 - inm
    # UV lifts the white and the yellow toward bone and leaves the black roughly alone; the
    # crown sees most of it, because the card stands on the drum's shoulder facing the sky.
    crown = np.clip(0.60 + zz / (2.0 * h_m), 0.0, 1.0)
    fade = np.clip(0.30 * crown + 0.14 * chalk, 0.0, 1.0) * (0.18 + 0.82 * pale)
    colr = base + (base * 0.42 + 0.55 - base) * fade[..., None]
    foot = zz + h_m / 2.0
    creep = np.clip((0.055 + 0.030 * chalk - foot) / 0.045, 0.0, 1.0) * 0.55
    colr = colr + (np.array([0.66, 0.56, 0.42]) - colr) * creep[..., None]
    colr += grit[..., None] * 0.035
    rough = np.clip(84 + pale * 26 + fade * 46 + creep * 70 + grit * 12, 55, 255)
    edge = np.abs(inm - np.roll(inm, 1, 1)) + np.abs(inm - np.roll(inm, 1, 0))
    edge[:2, :] = edge[-2:, :] = edge[:, :2] = edge[:, -2:] = 0.0     # the print, not its seam
    height = np.clip(edge * 2.0, 0, 1) * 0.4 + creep * 0.2 + chalk * 0.06 + grit * 0.12 - crown * 0.05
    maps = {"basecolor": _save(np.clip(colr * 255.0, 0, 255), tag + "_col"),
            "rough": _save(rough, tag + "_rgh"),
            "normal": _save(height_to_normal(height, 2.2), tag + "_nrm")}
    return maps, w_m, h_m


def _plates(U, V, tile, n, seed):
    """Wrapping Voronoi: the site id of the plate covering each pixel, and its distance in
    metres to that plate's boundary.

    Thresholded value noise is the obvious way to cut rock into flat panels and it produces a
    camouflage pattern, because a noise field's isolines are smooth curves. Basalt jointing is a
    network of straight cracks meeting at hard corners, which is what a Voronoi gives — and it
    returns an id per pixel, so the map can give every facet its own step, tone and polish
    instead of one continuous field pretending to be broken."""
    rng = np.random.default_rng(seed)
    P = rng.random((n, 2)) * tile
    idd = np.zeros(U.shape, np.int64)
    d1 = np.full(U.shape, 1e9)
    d2 = np.full(U.shape, 1e9)
    for k in range(n):
        du = np.abs(U - P[k, 0]); du = np.minimum(du, tile - du)
        dv = np.abs(V - P[k, 1]); dv = np.minimum(dv, tile - dv)
        d = np.hypot(du, dv)
        win = d < d1
        d2 = np.where(win, d1, np.minimum(d2, d))
        d1 = np.where(win, d, d1)
        idd = np.where(win, k, idd)
    return idd, (d2 - d1) * 0.5


# ─────────────────────────── basalt boulder ───────────────────────────
def boulder_maps(tag="rock_basalt", pm=240.0, tile=3.2, n_plates=26,
                 tint=(0.74, 0.685, 0.635)):
    """A clast of basalt, weathered from the inside out. Nothing here is modelled because a
    rim boulder is read at 60 m and looked at at 6 m, and its whole job is to look like rock
    rather than like a shaded ball:

      * `plates` — cleavage. The surface is a mosaic of flat facets, each one a discrete step
        in height and a discrete value in tone, separated by a 50 mm joint. This is the term
        that kills the icosphere look, and it is why the field is a Voronoi rather than noise.
      * `pit`    — saltation bites, thrown on a wrapping lattice so the tile has no seam.
      * `mant`   — the mantle. Fines shelter in the joints and the pit floors, so the rock
        lightens exactly where a brush could not reach.
      * `rough`  — the joint *polishes* the facets it bounds: a wind-faceted face is smoother
        than the matrix around it, and each plate takes its own degree of that.

    The scale of the plate field is the whole argument, and the first forge of this map got it
    wrong: 44 plates in a 1.6 m tile is a 0.24 m mosaic, and a 7 m boulder tiled 4.8 times
    across renders as a football of grout lines. Real columnar jointing breaks a clast of this
    size into a few tens of decimetre-scale faces, so the tile is 3.2 m and holds 26 plates —
    0.6 m facets, two and a bit repeats across the biggest clast, which is what lets the eye
    read one continuous stone rather than a wallpaper.
    """
    u_m = v_m = tile
    w = h = int(round(tile * pm))
    U, V = _mesh(w, h, pm)

    idd, edge = _plates(U, V, tile, n_plates, 4211)
    rng = np.random.default_rng(9042)
    step = rng.random(n_plates) * 2 - 1        # each plate sits at its own level
    hue = rng.random(n_plates) * 2 - 1         # ...and is its own shade, fresh to varnished
    polish = rng.random(n_plates)              # ...and has caught its own amount of wind
    joint = 1.0 - np.clip(edge / 0.050, 0.0, 1.0)

    swell = _pnoise(w, h, 3, 3, 771) - 0.5
    grit = _pnoise(w, h, int(tile / 0.035), int(tile / 0.035), 2909) - 0.5

    # impact pits — centre, radius and depth per strike, distances taken wrapped so a pit that
    # straddles the tile edge reassembles itself on the other side. Seven to a 3.2 m tile, and
    # they are dimples in an exposed face, not a stipple pattern: at the density the first forge
    # used they read as the surface's own texture and the rock looked like foam.
    pit = np.zeros((h, w), float)
    rp = np.random.default_rng(517)
    for k in range(7):
        cu, cv = rp.random(2)
        rad = 0.09 + rp.random() * 0.21
        du = np.abs(U - cu * tile); du = np.minimum(du, tile - du)
        dv = np.abs(V - cv * tile); dv = np.minimum(dv, tile - dv)
        q = np.hypot(du, dv) / rad
        pit += np.where(q < 1.0, -(1.0 - q * q) * 0.9 + np.clip((q - 0.72) / 0.28, 0, 1) * 0.22, 0.0)
    pit = np.clip(pit, -1.0, 0.35)

    height = step[idd] * 0.62 + swell * 0.16 + grit * 0.10 + pit * 0.80 - joint * 0.42
    mant = np.clip(0.30 + joint * 0.55 - pit * 0.55 + swell * 0.5, 0.0, 1.0)
    # Basalt is dark, and the ring's boulders have to be the darkest thing on the island or they
    # vanish into the dune they sit on. The joint reads dark because it is a shadowed fracture,
    # the pit floors follow it down, and their lips stay fresh-broken and bright.
    #
    # The per-plate tone step is deliberately smaller than the per-plate height step. Height is
    # what makes a facet: the normal map turns the same number into a lit face and a shaded one,
    # and no albedo is needed. Putting the same amplitude into the albedo as well double-counts
    # the geometry and is what made the first version check instead of stone.
    tone = np.clip(96 + step[idd] * 13 + hue[idd] * 15 + swell * 22 - joint * 34
                   + pit * 20 + mant * 22, 28, 176)
    rough = np.clip(206 - polish[idd] * 46 + joint * 26 + mant * 18 + grit * 10, 96, 255)
    maps = {"basecolor": _save(np.dstack([tone * tint[0], tone * tint[1], tone * tint[2]]),
                               tag + "_col"),
            "rough": _save(rough, tag + "_rgh"),
            "normal": _save(height_to_normal(height, 8.0), tag + "_nrm")}
    return maps, u_m, v_m


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
       # Not a dimmer. The pale blanket's field spans p2→p98 = 172→255, and multiplying it by
       # 0.055 collapsed the carbon version to 9→14 — five levels out of 255, i.e. every hex cell
       # and every grout line erased, which is why the ship's lee half drew as one black slab with
       # a 170-level step at the seam against the lit blanket (measured on a noon frame, camera 66 m
       # out: lit 228 / dark 49-63 / sky 139). 0.19 keeps the field at 30→48 — 18 levels of real
       # tile structure — and because basecolour is sRGB-decoded before lighting, that 3.7× albedo
       # lifts the unlit side to roughly L 110, still well under the sky and far under the sun side.
       "tps_dark": lambda: tps_maps(tag="tps_dark", tint=0.19), "burnt": burnt_maps,
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
       "tap_iron": lambda: panel_maps(tag="tap_iron", tint=(0.475, 0.455, 0.42),
                                      base=236, rough_base=126, tile=0.40, rivet=0.026),
       "tap_soot": lambda: panel_maps(tag="tap_soot", tint=(0.215, 0.205, 0.192),
                                      base=236, rough_base=168, tile=0.55, rivet=0.0),
       "tap_cast": lambda: concrete_maps(tag="tap_cast", tile=1.2,
                                         tint=(0.395, 0.372, 0.335)),
       "stand_cryo": lambda: panel_maps(tag="stand_cryo", tint=(0.735, 0.735, 0.722),
                                        base=246, rough_base=96, tile=0.55, rivet=0.034),
       "stand_cast": lambda: concrete_maps(tag="stand_cast", tile=1.6,
                                           tint=(0.50, 0.478, 0.436)),
       "car_paint": lambda: panel_maps(tag="car_paint", tint=(0.60, 0.075, 0.062),
                                       base=250, rough_base=64, tile=0.90, rivet=0.0),
       "car_trim": lambda: panel_maps(tag="car_trim", tint=(0.145, 0.142, 0.14),
                                      base=250, rough_base=120, tile=0.30, rivet=0.0),
       "car_rim": lambda: panel_maps(tag="car_rim", tint=(0.545, 0.54, 0.53),
                                     base=250, rough_base=76, tile=0.22, rivet=0.028),
       # The gate's barrier run: enamel on galvanised steel, and the road-marking bands that
       # are the only reason a low rail is visible against dune sand at 100 m.
       "bar_stripe": lambda: stripe_maps(tag="bar_stripe", tile=0.24),
       "bar_white": lambda: panel_maps(tag="bar_white", tint=(0.795, 0.775, 0.735), base=234,
                                       rough_base=126, tile=0.55, rivet=0.0),
       # The barrier's own darkwork and kerb cast at the scale those parts actually are. Reusing
       # the substation's fields would have been correct and cost 900 kB a kit: `tap_cast` spans
       # 1.2 m at 400 px/m, so 480 px of grit texture that no PNG will compress — for a fitting
       # you drive past in under a second. Small parts get small fields.
       "bar_soot": lambda: panel_maps(tag="bar_soot", tint=(0.245, 0.235, 0.22), base=236,
                                      rough_base=148, tile=0.34, pm=430, rivet=0.0),
       # No board joints here on purpose: a kerb bay is one precast unit, and a seam every
       # 560 mm drew four cracks across it and turned the run into a stack of boxes.
       "bar_cast": lambda: concrete_maps(tag="bar_cast", tile=0.56, pm=340, joints=False,
                                         nrm=4.2, tint=(0.635, 0.605, 0.55)),
       # The leak skid's placard, at the panel's own 2.20 × 1.10 m size: the legend is 70 mm
       # tall because that is what a printed sign's legend is, and nothing about a hazard board
       # works if you cannot read it from the road it is warning people off.
       "hazard_face": lambda: sign_face_maps("hazard_face", 2.20, 1.10, title="DANGER",
                                             lines=("PROPULSION LEAK · BOG RETURN 3",
                                                    "FLAMMABLE · NO ENTRY · 5 m")),
       # Safety-yellow enamel on a drum chime ring: same orange-peel and roll-coat pass as the
       # rest of the painted metalwork, at the 420 mm scale of a ring seen from a metre out.
       "drum_yellow": lambda: panel_maps(tag="drum_yellow", tint=(0.895, 0.705, 0.072),
                                         base=252, rough_base=116, tile=0.42, pm=520,
                                         rivet=0.019),
       # The drum's own DOT placard, at the card's exact 240 × 300 mm: the one graphic on the
       # crate that says why it exists, so it gets its own field and planar UVs.
       "cryo_placard": oxidiser_placard_maps,
       # The rim rampart's basalt. 230 px/m over a 1.6 m field is 368 px: a boulder is a single
       # rounded mass, so unlike a wall of panels it needs no fine detail to read — it needs the
       # cleavage and the pits at the right scale, and the maps get stretched across it by uv_cube.
       "rock_basalt": boulder_maps,
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
