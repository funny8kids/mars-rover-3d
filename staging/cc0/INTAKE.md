# CC0 / free-license asset intake — staging area

Status: **research + staging only — nothing under `src/`, `tools/`, `public/assets/` was touched.**
Date: 2026-09-26. Task: work item #76 / 任务 I —「全图粗糙建模清零，优先以网络 CC0/免版权资源替换」.

## 1. What the repo already has

`public/assets/*.glb` (40 files, ~65 MB) — all Blender-authored hero builds (`habitat_dome`,
`starship_stack`, `launch_tower`, `watch_deck`, `spaceport_gate`, `reactor_tap`, `lox_stand`,
`gantry_service`, `telescope`, `drum_crate`, `beacon_kit`, `site_kit`, …) plus two Kenney packs
imported under `public/assets/kenney/{space,nature}/` with their CC0 license files kept
(`LICENSE-space.txt`, `LICENSE-nature.txt` — "License: (Creative Commons Zero, CC0)").
Kenney intake convention: `src/world/props.js` header —
`const K = (name) => 'kenney/space/${name}'; const S = 3.5; // Kenney grid → diorama scale`,
models cloned per placement, footed/scaled via `footOf()`/Box3 measurement (`props.js:563,605,2101`).

Legacy GLBs no longer referenced by runtime code (`comm_dish`, `gate`, `rock_cluster`,
`solar_array` — only in `tools/blender/build_assets.py`): dead weight, **not** intake candidates.

### Remaining runtime primitive calls (`src/world/props.js`)

| Where | What | Verdict |
|---|---|---|
| `props.js:2778-2779` | `box()` ×14 per reactor tap — the 7-section duct run from tap to pad ×6 taps | **Real replacement candidate** (player-facing, repeated). Code comment says it stayed primitive "because every section's height comes from a live terrain sample" — replacement must keep per-section placement. |
| `props.js:882` | `cyl()` beacon fallback | Fallback path only (asset failed to load) — keep as is. |
| `props.js:494, 1516, 1587, 1754, 1764, 2478, 2783, 2788` | `Icosahedron`, `Torus`, `Cylinder`, `Ring`, `Circle`, `Octahedron` | Light FX / decals / stylized energy core — intentional, not programmer art. |
| `main.js:404, 1464` | Torus race gates, shockwave rings | FX/gameplay, keep. |

So the primitive backlog is essentially **one object (the duct run)**; the rest of the visual gap
vs bruno-simon is now material/silhouette quality, with the **Kenney Space Kit secondary structures**
(toy-block hangars, platforms, machines, pipes) being the most "rough-modelled" repeated items
across the base — those are best upgraded by better-looking CC0 structure kits, not by new code.

## 2. Prioritised intake table

Repo convention ≈ 1 unit = 1 metre (e.g. `craft_speederA` "is 2.0 × 2.1 m in its own units",
then scaled ×3.5 for the Kenney grid). All four staged Poly Haven models carry **true
real-world-metre bboxes**, verified by parsing POSITION accessors.

| # | In-repo weakness / candidate | Proposed replacement | Source URL | Licence (author's own words) | Downloaded? | Risk |
|---|---|---|---|---|---|---|
| 1 | Reactor-tap→pad duct run, 14 `box()`s per tap (`props.js:2778`) | **Modular Industrial Pipes 01** (8 sections, 12,340 tris, bbox 0.61×1.95×0.31 m) | https://polyhaven.com/a/modular_industrial_pipes_01 | "CC0 1.0 Universal — public domain dedication, no attribution required" | ✅ `staging/cc0/modular_industrial_pipes_01/` (4.8 MB, glTF 1k + bin + 6 jpg) | Medium: terrain-following per-section placement must be re-implemented on instanced sections; photo-real PBR vs toy-soft palette; multi-file .gltf needs merge to single .glb (loader only reads `./assets/<name>.glb`, `src/world/assets.js:171`) |
| 2 | Industry district lacks a big player-facing structure piece | **Overhead Crane** (89,964 tris, bbox 12.5×4.6×4.7 m — hero-scale, drives/pads readable from afar) | https://polyhaven.com/a/overhead_crane | Same CC0 statement | ✅ `staging/cc0/overhead_crane/` (7.3 MB) | High poly (90k tris) — needs decimation before a mobile build; collision Box3 measurement works, but drive-under clearance must be re-tuned |
| 3 | `reactor_tap` substation yard dressing; empty lots in INDUSTRY/HAB band | **Portable Generator** (26,419 tris, 0.82×0.59×0.56 m) | https://polyhaven.com/a/portable_generator | Same CC0 statement | ✅ `staging/cc0/portable_generator/` (3.4 MB) | Low-ish: small prop; 26k tris for a roadside object; same glb-merge step |
| 4 | Power lines / cable runs between pylons absent from the grid story | **Modular Electric Cables** (42,078 tris, 49 meshes, sagging spans + junction boxes) | https://polyhaven.com/a/modular_electric_cables | Same CC0 statement | ✅ `staging/cc0/modular_electric_cables/` (6.0 MB) | Medium: spans are fixed-length; connecting pylons of varying distance needs section mixing; 49 named nodes actually helps this |
| 5 | Hangars/platforms/machines — Kenney Space Kit silhouette upgrade | **Kenney Factory Kit** (140 files) and/or **City Kit: Industrial** | https://kenney.nl/assets/factory-kit , https://kenney.nl/assets/city-kit-industrial | Kenney page: "License: Creative Commons CC0" (same wording as the packs already in repo) | ❌ not downloaded — kenney.nl's download flow is JS/token-gated (`…:download` returns an HTML page; media-dir probes 404); needs one manual click by a human | Low: same author, same CC0 deed, same grid convention as existing intake; format list on page is vague → check zip contains glb/gltf |
| 6 | Sci-fi modular structures/gantries in a stylised (non-photo) look | **Quaternius Ultimate Modular Sci-Fi / Sci-Fi Essentials / Simple Buildings** | https://quaternius.com/packs/ultimatemodularscifi.html | Quaternius page: "CC0 … free to use in personal and commercial projects" | ❌ not downloaded — distribution is itch.io/Drive, token-gated for scripts | Medium: formats listed as "FBX, OBJ, Blend" → conversion step required; style match likely better than Poly Haven |

All 21 GLB files + 2 Kenney license texts were inventoried (see `ls -la public/assets`); licence
files for the four staged models are in `LICENSE-source.txt` in each folder.

## 3. Verification performed on downloads

- Each `.gltf` parses as JSON; triangle counts computed from INDEX accessors match the author
  pages (pipes 12,340 / generator 26,419 / crane 89,964 / cables 42,078).
- Each `.bin` byte size equals the glTF `buffers[].byteLength` exactly.
- Every `images[].uri` texture file exists on disk; `buffers[].uri` resolves.
- bbox meters recorded (table above) — consistent with the repo's 1u = 1m convention.
- No GLB magic-byte check applies: Poly Haven models are **`.gltf` + external `.bin`/textures**,
  not single-file `.glb`; `src/world/assets.js:171` loads `./assets/<name>.glb` only, so intake
  requires a later gluf merge/convert step (explicitly not done here).

## 4. Rejected / not usable

- **Sketchfab "CC0 filter" downloads** — require a logged-in account and per-item licence
  re-checking on the uploader's page; could not confirm any specific model's licence from the
  author's own page during this pass → REJECTED-UNVERIFIED (may be revisited manually).
- Any "free" asset without a CC0/CC-BY statement on the author's own page was excluded.
  CC-BY items (e.g. many OpenGameArt glTFs) would need an attribution line added to the
  in-game credits screen before use — none were staged.
- Non-commercial / NC-licensed items: not selected — the game is published to a public hosted
  site, so NC licences are unusable regardless of quality.

## 5. What was NOT found anywhere CC0 — still needs Blender

- The hero sci-fi silhouettes the base is built around (hab domes in this exact toy-soft
  language, the starship stack, launch tower, spaceport gate, gantry) — no CC0 source matches
  the style; current `tools/blender/build_*.py` pipeline stays responsible.
- A CC0 **Mars-appropriate red-dust covered** variant of anything: every staged model assumes
  Earth-industrial grime; repo will need dust/retint material passes.
- Kenney-style **rounded pipe/hangar hybrid props** at the diorama's 3.5× grid — the Kenney
  grid and Poly Haven real-metric scale do not share a module size; a conforming prop set is
  authoring work, not intake work.
