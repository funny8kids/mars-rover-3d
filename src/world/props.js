import * as THREE from 'three';
import { heightAt, claimLot, resetLots } from './height.js';
import { ZONES, SHIP_POS, LEAK_POS, RIM } from '../config.js';
import { mulberry32, vnoise } from '../utils/noise.js';
import { loadModel, cloneModel } from './assets.js';
import { mergeInto, noMerge } from './merge.js';
import { applySurfaceDetail } from './surface_detail.js';
import { makeDriftMaterial } from './terrain.js';
import { coverDiscs, discLayout, streetEncroach, STREETS, STREET_HW, CORRIDOR, audit, sealCheck } from './plan.js';
import { UNIT_BEAM, shaftMaterial } from '../fx/beams.js';

// ─── RED STARBASE · compact diorama ───
// One ~110 m island, six readable landmarks, everything hand-placed.
// Structures are Kenney Space Kit (CC0, 1-unit grid → scaled 3.5×); the hero
// pieces — the rover, the arch, the teleport pads, the ship, the domes — come
// from our own Blender builds so the silhouette language stays toy-soft.

const K = (name) => `kenney/space/${name}`;
const S = 3.5; // Kenney grid → diorama scale

const G = new THREE.Group();

// Shadow flags for a whole hierarchy. Everything here is armed after loadModel()/unstub() has
// already decided which meshes are glazing, so a plain `castShadow = true` walk used to override
// that decision and put solid rectangles of shadow under every quarter-opaque pane — the greenhouse
// blacked out its own crops, and the lamp globes and the cupola did the same on the decks below
// them. assets.js leaves the verdict on the object itself, and that verdict survives cloneModel().
const shade = (o) => {
  if (o.isMesh) { o.castShadow = !(o.userData.rsbPane || isLightSurface(o)); o.receiveShadow = true; }
};

// The shadow pass reads depth and knows nothing about alpha, so a mesh that only *adds* light —
// a searchlight cone, a crystal's ground ring, a lamp's pool, a painted wordmark — still stamps its
// full silhouette at opacity 0. Five 56 m show-beams did exactly that across PAD ONE in every
// daylight frame. Rather than re-marking every effect by hand at its call site, where the next one
// would forget, the verdict is read off the material: anything that cannot write depth in the
// colour pass has no body to take light away in the shadow pass either.
const isLightSurface = (o) => {
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  return mats.some(m => m && (m.blending === THREE.AdditiveBlending || m.depthWrite === false));
};

// A lamp's pool on the deck is a falloff, not a shape. The grid taps drew theirs as
// `CircleGeometry(1.35, 6)` under a flat additive material — a cyan hexagon stamped on the concrete,
// its six straight edges running out of the light instead of the light running out. The ramp below is
// that disc's alpha, so the pool lands, thins, and has no rim at all. One texture shared by all six
// taps; `CircleGeometry`'s UVs already map the disc into the unit square.
let poolTex = null;
const lightPool = () => {
  if (poolTex) return poolTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  rg.addColorStop(0.00, '#ffffff');
  rg.addColorStop(0.22, '#d0d0d0');
  rg.addColorStop(0.46, '#5c5c5c');
  rg.addColorStop(0.72, '#171717');
  rg.addColorStop(1.00, '#000000');
  g.fillStyle = rg;
  g.fillRect(0, 0, 128, 128);
  poolTex = new THREE.CanvasTexture(cv);
  return poolTex;
};

export async function buildBase(scene, quality) {
  G.clear();
  resetLots();
  const HERO = ['habitat_dome', 'hab_link', 'greenhouse', 'launch_tower', 'cryo_tank', 'starship_stack',
    'crew_rover', 'optimus_bot', 'watch_deck', 'spaceport_gate', 'hub_plaza', 'reactor_tap', 'lox_stand', 'roadster', 'lamp',
    'crystal', 'lander', 'teleport_pad', 'gantry_service', 'astronaut', 'barrier_kit', 'flag_mast',
    'hazard_sign', 'telemetry_board', 'feeder_pillar', 'rim_rock', 'beacon_kit', 'telescope', 'site_kit',
    'drum_crate'];
  const KENNEY = ['hangar_roundA', 'hangar_largeA', 'hangar_smallA',
    'platform_high', 'platform_low', 'platform_large', 'machine_generator',
    'machine_generatorLarge', 'machine_wireless', 'structure', 'structure_detailed', 'pipe_straight',
    'pipe_corner', 'satelliteDish', 'satelliteDish_detailed', 'rocket_baseB', 'rocket_finsA',
    'rover',
    'rocket_fuelA', 'rocket_sidesA', 'rocket_topA', 'barrel', 'craft_speederA',
    'alien', 'desk_computer', 'terrain_roadStraight', 'rail', 'stairs',
    'supports_high', 'craterLarge'];
  const entries = [...HERO, ...KENNEY.map(K)];
  const models = {};
  await Promise.all(entries.map(async (n) => { models[n.split('/').pop()] = await loadModel(n); }));
  // glTF emissives arrive at full strength; under the sun + bloom band they blow out into
  // white discs. One art-direction pass over the shared hero materials fixes every instance.
  // GlTF says a material with no metallic-roughness texture and factors left at 1/1 is a perfectly
  // rough pure conductor — which is to say, a black hole that reflects nothing. That is what every
  // Kenney material exported as, and it silently overrode their painted albedo: 411 of the base's
  // 1279 meshes (railings, platforms, rocks, the entire mid-ground) drew as black cut-outs.
  // loadModel() repairs the stubs now, so nothing here has to.
  const padGlow = [], heroLights = [];
  for (const root of Object.values(models)) {
    root?.traverse(o => {
      // Glazing must not shadow: an opaque shadow map would black out the crops
      // the whole greenhouse exists to show off. assets.js already marks the panes it converted
      // out of KHR transmission; the name test catches the ones authored as plain BLEND glass in
      // Blender, which arrive at unstub() still opaque enough to pass its filter.
      if (o.isMesh && /glass_pane|_glass$/.test(o.name)) { o.userData.rsbPane = true; o.castShadow = false; }
      for (const mt of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
        const n = mt.name || '';
        if (n === 'glass_pane') { mt.transparent = true; mt.opacity = 0.30; mt.depthWrite = false; mt.roughness = 0.06; o.userData.rsbPane = true; o.castShadow = false; }
        // A lamp's clear globe exported at 0.95 albedo is a white block by day — the short pale
        // stubs ringed with cyan in the cryo field are lamp heads whose glass out-shines their
        // bulb. Real smoked glass is dark, hard and reflective, and reads as glass precisely
        // because it mirrors the sky instead of replacing it.
        else if (n === 'glass_clear') { mt.color.setRGB(0.16, 0.185, 0.20); mt.roughness = 0.1; mt.metalness = 0.1; }
        else if (n === 'pad_glow') { mt.emissiveIntensity = 0.12; padGlow.push(mt); }   // daylight: a read-able disc, not a bloom hole
        else if (/^light_/.test(n)) {
          // A near-white strip at the same drive as a saturated one blows the bloom into the
          // vertical flare that was eating the top-left of every launch view. Frosted fittings
          // are lit, not on fire; the coloured accents keep the full drive.
          const c = mt.color, wash = (c.r + c.g + c.b) / 3;
          const white = wash > 0.72 && Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) < 0.22;
          mt.emissiveIntensity = white ? 0.34 : 1.45;
          // A lamp's albedo should be the housing, not the bulb. Exported at full colour it means a
          // fitting reads as a solid block of saturated plastic by day and then has to fight its own
          // emissive term at night; the emissive alone carries the colour from here.
          if (mt.emissive && mt.emissive.r + mt.emissive.g + mt.emissive.b > 0.05) c.multiplyScalar(0.3);
          // What reaches the eye from a fitting is its drive times its emitting area, and the shared
          // night drive was set against the thin authored tubes in the packs. The gate's leg channels
          // are 8.1 m of lit strip down each pylon rebate (measured by raycasting the strip's own
          // top and bottom pixels) — the largest lit surface on the base — and at that shared drive
          // they alone owned 150 of the 170 blown pixels in the gateway frame (raycast of the blown
          // band, 2026-09-24), i.e. two flat white bars standing where the settlement's front door
          // is. Sweeping the drive down, the frame's clip falls off a cliff — 1.05 % at 1.92,
          // 0.93 % at 0.90, 0.21 % at 0.75 — and hits its 0.08 % floor at 0.72, while the strip's own
          // peak holds at 224 across the whole move. So the luminaire stops being a hole in the
          // picture without becoming an unlit groove in the pylon. A wide emitter declares its own
          // night ceiling here, the same way a saturated accent declares its day floor below.
          if (/^light_gate_channel$/.test(n)) mt.userData.nightCap = 0.72;
          heroLights.push(mt);
        }
        else if (n === 'plant' || n === 'crystal_mat') mt.emissiveIntensity = 0.7;
        else if (n === 'solar_cell') {
          // A PV panel is glass over silicon: it should mirror the sky. At metalness 0 / roughness
          // 0.9 it took no environment at all and drew as a black card propped in the plaza.
          mt.color.setHex(0x27395f); mt.metalness = 0.62; mt.roughness = 0.17;
        }
        // The packs ship a near-black 'dark_panel' family for panel shadows. Outdoors, under a
        // 3.4 sun and an ochre sky, that is not shadow — it is missing geometry, so it becomes
        // graphite instead. Real shading comes from the light pass, not from the albedo.
        else if (/^dark_/.test(n)) { mt.color.setHex(0x6e6860); mt.roughness = 0.66; mt.metalness = 0.34; }
      }
    });
  }
  // The teleport pads are the objects the player aims at most and the last ones still drawing as
  // a cake: a glossy near-white disc (0.90 albedo at roughness 0.35) ringed by a full mirror
  // (metalness 1) and topped with saturated gold lamps — three blown values and no material read.
  // A fast-travel pad on a dust planet is worn ceramic over anodised alloy, so the albedos drop
  // into the plaza's value band and the lamps go back to being glass housings that only the
  // emissive term makes bright.
  {
    const pad = models.teleport_pad;
    pad?.traverse(o => {
      for (const mt of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
        switch (mt.name) {
          case 'pad_white': mt.color.setRGB(0.44, 0.415, 0.375); mt.roughness = 0.82; mt.metalness = 0.06; break;
          case 'pad_glow': mt.color.setRGB(0.10, 0.27, 0.28); mt.roughness = 0.6; break;
          case 'rover_alu': mt.color.setRGB(0.46, 0.47, 0.49); mt.metalness = 0.62; mt.roughness = 0.46; break;
          case 'rover_dark': mt.color.setRGB(0.16, 0.155, 0.17); mt.metalness = 0.55; mt.roughness = 0.6; break;
          case 'light_amber': mt.color.setRGB(0.28, 0.15, 0.05); mt.roughness = 0.42; break;
          case 'light_cyan': mt.color.setRGB(0.14, 0.30, 0.34); mt.roughness = 0.42; break;
        }
      }
    });
  }
  // The kit pack is dust-coloured now, but the Blender heroes still ship their authored housings:
  // hull_white at 0.845, cryo_insul at 0.905, and steel/alu_bright as full mirrors. Under a 3.4 sun
  // on an ochre sky those are three independent ways to clip to 255,255,255 before bloom even runs —
  // and bloom then turns the cryo row into a wall of white fog in which the 24 rings of panel detail,
  // the best modelling work in the base, simply vanish. Nothing outdoors on a dust planet keeps a
  // moulded-ceramic white or a polished flank for a season: paint chalks to a grey-tan and bare
  // aluminium anodises and streaks. Only the two silhouettes that are *meant* to be the pale
  // landmarks — the habitat domes and the starship — keep a high albedo, and even they come off white.
  const SHELL = {
    hull_white: [[0.455, 0.435, 0.40], 0.62, 0.06],
    hull_warm: [[0.40, 0.36, 0.315], 0.66, 0.06],
    cryo_insul: [[0.46, 0.44, 0.415], 0.8, 0.2],
    // Raycast forensics on the launch view: the white bars fogging out the service tower at every
    // platform were not lamps at all — they were the railings. `steel` at metalness 0.86 /
    // roughness 0.55 is a semi-mirror, and a 40 mm tube is a near-perfect sun-reflector: each
    // railing threw a clipped specular streak that bloom then smeared across the whole tower.
    // Weathered gantry steel is galvanised or painted and dusted over, closer to a diffuse grey
    // with a hint of sheen than to a mirror.
    steel: [[0.30, 0.305, 0.32], 0.74, 0.42],
    alu_bright: [[0.335, 0.34, 0.355], 0.68, 0.5],
    // The 4 m macro pass found the last two >70 %-saturation albedos in the world hiding here: the
    // kit pack's `acc_orange` (hsl 29,86,59) and `orange` (hsl 29,76,57). Under the noon key a
    // saturated diffuse reads as a flat candy chip even with no emissive at all, so they come down
    // to the dust-faded vermilion the rover's `metalRed` already uses — still the loudest hue on
    // the structure, no longer a highlighter.
    acc_orange: [[0.468, 0.144, 0.032], 0.62, 0.12],
    orange: [[0.50, 0.155, 0.038], 0.6, 0.14],
  };
  const LANDMARKS = new Set(['habitat_dome', 'lander', 'astronaut']);
  for (const [mname, root] of Object.entries(models)) {
    if (!root || mname === 'rover' || mname === 'crystal') continue;
    const lift = LANDMARKS.has(mname) ? 1.34 : 1;
    root.traverse(o => {
      if (!o.isMesh) return;
      for (const mt of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
        const t = SHELL[mt.name];
        if (!t || !mt.color) continue;
        if (mt.emissive && mt.emissive.r + mt.emissive.g + mt.emissive.b > 0.05) continue;
        mt.color.setRGB(t[0][0] * lift, t[0][1] * lift, t[0][2] * lift);
        mt.roughness = t[1]; mt.metalness = t[2];
      }
    });
  }
  // The rover is the one object permanently in the player's own frame, and it was still authored as
  // a gold plate on chrome: `metalRed` at (1.0, 0.63, 0.2) is a saturated toy-yellow body, and its
  // `metal` flank at 0.84 albedo clips with the cryo tanks. Real rovers are body-primed in one
  // safety colour over anodised structure, and safety orange on Mars reads vermilion once the dust
  // has had a season with it. The accent stays the base's loudest hue — it identifies the vehicle —
  // it just stops being a highlighter.
  // Raycasting the arrival view proved the rest of it too: the pale boards and white frames filling
  // the bottom of every driving shot are the rover's own solar wings and deck plating, not the
  // plaza. `rover_white` at 0.82 linear clips to cream under the key, and `solar_cell` is a dark
  // navy that renders periwinkle purely because it is a 0.18-roughness mirror of a bright sky — so
  // the cells go rougher and darker, and the deck plating comes down into the base's value band.
  {
    const r = models.rover;
    r?.traverse(o => {
      for (const mt of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
        switch (mt.name) {
          case 'metalRed': mt.color.setRGB(0.52, 0.135, 0.055); mt.roughness = 0.52; mt.metalness = 0.1; break;
          case 'metal': mt.color.setRGB(0.44, 0.435, 0.43); mt.roughness = 0.44; mt.metalness = 0.72; break;
          case 'metalDark': mt.color.setRGB(0.135, 0.13, 0.135); mt.roughness = 0.62; mt.metalness = 0.6; break;
          case 'rover_white': mt.color.setRGB(0.40, 0.385, 0.355); mt.roughness = 0.56; mt.metalness = 0.08; break;
          case 'rover_alu': mt.color.setRGB(0.395, 0.4, 0.415); mt.roughness = 0.42; mt.metalness = 0.85; break;
          case 'rover_hub': mt.color.setRGB(0.27, 0.255, 0.24); mt.roughness = 0.58; mt.metalness = 0.55; break;
          case 'solar_cell': mt.color.setRGB(0.019, 0.031, 0.072); mt.roughness = 0.34; mt.metalness = 0.3; break;
        }
      }
    });
  }
  // A pack's parts are separate objects only because a modelling tool made them so. Baking each
  // template down to one mesh per material fixes every clone placed from it afterwards, and the
  // merged buffers stay shared instead of being duplicated per instance.
  // `crystal` is the exception: the sample pickup spins its own mesh, so it keeps its parts.
  // `barrier_kit` is the other kind of exception — a *kit* whose child nodes are each cloned out
  // on their own. Baking would sweep every mesh up into the scene root and leave `post` and `bay`
  // empty shells; the run that clones them then instals nothing. Its own parts still collapse,
  // one batch per material, when the assembled barrier run is merged later.
  // `rim_rock` is a third of the same kind, and the reason is harder: its three nodes are
  // alternative clasts, and each one's collision discs in rim_rock.js are measured about *that
  // node's* origin. Baking the kit into one mesh would delete the nodes the rampart clones from.
  const keepsParts = new Set(['crystal', 'barrier_kit', 'rim_rock', 'starship_stack', 'beacon_kit', 'site_kit']);
  // `beacon_kit` is a kit for the same reason as `barrier_kit`, with one more thing riding on it:
  // the optical drum has to survive as its own node, because the night pulse reaches the beacons
  // through `beacons[]` — the placement code clones the fitting and hands over the mesh named
  // `lens`. Baking the kit into one mesh per material would delete the node the five sites clone
  // from and silently take the blinking out of the base.
  // `starship_stack` is a fifth of the same kind, for the hardest reason to see: the launch flies
  // it as two vehicles, so the export carries `booster` and `ship` as nodes and baking the root
  // would weld them back into one buffer no animation can pull apart. Each body collapses to one
  // mesh per material on its own, which keeps the draw-call win and the separation.
  // The bodies are looked up by name rather than read off `children`, and that distinction is the
  // whole bug: the template's outer node is the glTF scene wrapper, so treating `children[0]` as a
  // body flagged the wrapper, left both vehicles' parts exposed, and the pad's own merge pass then
  // pulled 193 parts from the two bodies into shared buffers welded across the seam — a stack that
  // could never come apart while every count still looked healthy.
  // The engine clusters are counted off the asset, not typed in here: a Raptor is authored as four
  // parts, exactly one of which is its bell, so a `raptor_*_bell` node is one engine. Two details the
  // tally has to respect, both measured off the export rather than assumed — the interstage gas vents
  // and the RCS thrusters are also bell-shaped and would be counted as engines by a `*_bell` match,
  // and the thirteen instances of one engine type come through the exporter as
  // `raptor_o_bell`, `raptor_o_bell.001`, …, so a bare `endsWith` finds one engine per type.
  // The third trap is the loader, and it is the reason stripping `.001` still read 2 engines:
  // GLTFLoader names every object through `PropertyBinding.sanitizeNodeName`, whose reserved-character
  // set is `[].:\/` and it *deletes* those rather than escaping them. So the scene never holds
  // `raptor_o_bell.001` — it holds `raptor_o_bell001`, and the dot-stripping regex matched only the
  // unnumbered original of each type. The suffix is therefore consumed inside the test, and a name
  // is only trusted as one engine while the parts are still separate: this tally runs *before*
  // `mergeInto` below, because after a signature merge one bucket per material would look like one
  // engine per type again, which is the number this bug shipped with.
  // The flight HUD lights this many engines, which means adding or removing one in Blender changes
  // the panel by itself instead of leaving it confidently reporting a number the model never had.
  const STACK_ENGINES = { booster: 0, upper: 0 };
  const BELLOF = /^raptor_.+_bell\d*$/;
  for (const [key, slot] of [['booster', 'booster'], ['ship', 'upper']]) {
    const body = models.starship_stack?.getObjectByName(key);
    if (body) {
      let bells = 0;
      body.traverse(o => { if (o.isMesh && BELLOF.test(o.name)) bells++; });
      STACK_ENGINES[slot] = bells;
      noMerge(body); mergeInto(body);
    }
  }
  for (const [name, root] of Object.entries(models)) {
    if (root && !keepsParts.has(name)) mergeInto(root);
  }
  // Cloned packs are already collapsed above; hand-built groups still need their own pass.
  const templateRoots = new Set();
  // `heightAt` rather than `surfaceAt`: the terrain *mesh* is a 1.36 m lattice sampled before this
  // function has graded a single footing, so a prop standing where a deck is about to be cut would
  // otherwise seat itself on the dune that is about to be removed. The analytic field already knows
  // every lot claimed so far and is exact on a level deck, so props and ground agree from the first
  // placement; the mesh is re-surveyed to match once the plan is complete.
  const put = (name, x, z, s, ry, dy = -0.05, at) => {
    const o = cloneModel(models[name]);
    templateRoots.add(o);
    o.scale.setScalar(s);
    o.position.set(x, at !== undefined ? at : heightAt(x, z) + dy, z);
    o.rotation.y = ry || 0;
    CUR.add(o); return o;
  };
  const k = (name, x, z, ry, sc = 1) => put(name, x, z, S * sc, ry);

  // ─── site engineering ───
  // Anything with a wall line gets its own graded footing (see height.js): the ground under it is
  // cut level, the rims of the model therefore all touch down, and the building stands on the top
  // of its own pad rather than on `surfaceAt` at its centre plus a constant nobody can defend.
  // Below this footprint a prop is furniture — a crate, a person, a lamp — and belongs *on*
  // somebody's deck, not on a 7 m slab of its own.
  const GRADE_MIN = 4.5;
  const grade = (id, x, z, w, d, ry) => claimLot({ id: `${ZONE}:${id}`, x, z, w, d, ry });

  // Every teleport pad is one authored asset plus one marking decal, and both have to move
  // together when the pad is re-sited (see the pad-siting pass above the grid).
  const padMeshes = [];
  const putDeck = (name, x, z, s, ry, bias = 0) => {
    const b = footOf(name);
    // `bias` is now purely how far the asset's own plinth is inset below its deck. It used to carry
    // a second job — cancelling the slope the pad was standing on — and that is what made every
    // number at every call site unrepeatable.
    const lid = name === 'teleport_pad' ? `pad${padSeq}` : name;
    const foot = { w: b.w * s, d: b.d * s, ry: ry || 0 };
    const y = grade(lid, x, z, foot.w, foot.d, foot.ry) + bias;
    const o = put(name, x, z, s, ry, 0, y);
    if (name === 'teleport_pad') {
      const d = new THREE.Mesh(padMarkGeo, padMarkMat(PAD_MARKS[padSeq % 6], 0x1a2b3d + padSeq * 7919));
      padSeq++;
      d.rotation.x = -Math.PI / 2;
      d.scale.setScalar(s);
      d.position.set(x, o.position.y + 0.366 * s, z);
      noMerge(d);
      G.add(d);
      padMeshes.push({ o, d, s, bias, x, z, foot, lotId: `${ZONE}:${lid}` });
    }
    return o;
  };

  // The Blender deck is a clean lathe surface, and a clean 6.5 m disc on a dust planet is a lie:
  // pads carry chipped hazard paint, tyre scuffs from the drive-on and a stencil code. One static
  // canvas per pad — drawn at load, uploaded once, never re-drawn — puts all three back and gives
  // every fast-travel node an identity readable from the air. Paint is confined to the outer rim
  // band so the dark bowl in the middle still shows through.
  const PAD_MARKS = ['HUB 01', 'PAD ONE 02', 'SETTLE 03', 'INDUSTRY 04', 'COMMS 05', 'SCIENCE 06'];
  let padSeq = 0;
  const padMarkGeo = new THREE.CircleGeometry(2.52, 64);
  const padMarkMat = (label, seed) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 512;
    const c = cv.getContext('2d');
    const rnd = mulberry32(seed);
    const CX = 256, CY = 256, RIM = 250, IN = 182;
    c.save();
    c.beginPath();
    c.arc(CX, CY, RIM, 0, 6.2832);
    c.arc(CX, CY, IN, 0, 6.2832);
    c.clip('evenodd');
    for (let i = 0; i < 24; i++) {
      const a0 = i / 24 * 6.2832;
      c.beginPath();
      c.arc(CX, CY, (RIM + IN) / 2, a0, a0 + 6.2832 / 24);
      c.lineWidth = RIM - IN;
      c.strokeStyle = i % 2 ? 'rgba(122,80,36,0.50)' : 'rgba(46,42,37,0.34)';
      c.stroke();
    }
    c.strokeStyle = 'rgba(34,30,26,0.30)';
    for (let i = 0; i < 9; i++) {
      const off = (i - 4) * 7;
      c.lineWidth = 3 + rnd() * 4;
      c.beginPath();
      c.moveTo(CX + off, CY + 252);
      c.quadraticCurveTo(CX + off * 1.7, CY + 120, CX + off * 0.4, CY - 252);
      c.stroke();
    }
    c.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 300; i++) {
      const a = rnd() * 6.2832, r = IN + rnd() * (RIM - IN);
      c.beginPath();
      c.arc(CX + Math.cos(a) * r, CY + Math.sin(a) * r, 1.1 + rnd() * 4.4, 0, 6.2832);
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
    c.strokeStyle = 'rgba(28,26,23,0.46)';
    c.lineWidth = 2.5;
    for (const r of [IN + 4, RIM - 4]) { c.beginPath(); c.arc(CX, CY, r, 0, 6.2832); c.stroke(); }
    c.fillStyle = 'rgba(30,28,25,0.5)';
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * 6.2832 + 0.26;
      c.beginPath();
      c.arc(CX + Math.cos(a) * 216, CY + Math.sin(a) * 216, 4.5, 0, 6.2832);
      c.fill();
    }
    c.font = '700 25px ui-monospace, monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(212,204,186,0.44)';
    for (const k of [0, 3]) {
      c.save();
      c.translate(CX, CY);
      c.rotate(k * Math.PI);
      c.fillText(label, 0, -216);
      c.restore();
    }
    c.restore();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({
      map: tex, transparent: true, depthWrite: false, roughness: 0.88, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
  };

  // Rocks and crystals are modelled around their own centre, so every `dy` that assumed the origin
  // sat on the ground left their bottom halves hanging in the air. Sink by the measured box instead.
  const seat = (o, sink = 0) => {
    o.updateMatrixWorld(true);
    o.position.y -= new THREE.Box3().setFromObject(o).min.y + sink * o.scale.x;
    return o;
  };

  const M = {
    // Frames, girders and housings used to sit at 0x33302c — linear 0.03, i.e. a hole in the
    // picture. Against a bright ochre sky every one of them became a black cut-out, which is most
    // of what "the modelling looks cheap" actually was. They are painted steel now.
    dark: new THREE.MeshStandardMaterial({ color: 0x767068, roughness: 0.62, metalness: 0.38 }),
    struct: new THREE.MeshStandardMaterial({ color: 0x8d867a, roughness: 0.5, metalness: 0.72 }),
    white: new THREE.MeshStandardMaterial({ color: 0xb3aa9c, roughness: 0.74, metalness: 0.08 }),
    // Gate legs are the heaviest thing on the airfield and they are cast concrete, not moulded
    // plastic. Painted white on a 12 m pylon is a sky-card: it was the brightest surface at the
    // spawn view by day and glowed like a lamp column under the moon.
    concrete: new THREE.MeshStandardMaterial({ color: 0x6b655b, roughness: 0.95, metalness: 0.02 }),
    orange: new THREE.MeshStandardMaterial({ color: 0xe07a2a, roughness: 0.5, metalness: 0.3 }),
    hazard: new THREE.MeshStandardMaterial({ color: 0x9c4226, roughness: 0.78, metalness: 0.18 }),
    warmWin: new THREE.MeshStandardMaterial({ color: 0xffdca0, emissive: 0xffb050, emissiveIntensity: 1.6 }),
    beacon: new THREE.MeshStandardMaterial({ color: 0x3f1712, emissive: 0xff2010, emissiveIntensity: 4 }),
    // A lamp fitting's albedo is its glass and housing, not its bulb. At 0x9ff0ff the plaza's flush
    // studs and bollard lamps drew as blown white discs by day — sixteen of them scattered across
    // every plaza frame, each one a bloom hole with no fixture shape left. The emissive term carries
    // the colour from here, and these two join heroLights so the day/night cycle actually drives
    // them: a marker lamp that is at full drive under a noon sun is not a lamp, it is a decal.
    goldLight: new THREE.MeshStandardMaterial({ color: 0x4a3316, emissive: 0xffb040, emissiveIntensity: 1.4 }),
    cyanLight: new THREE.MeshStandardMaterial({ color: 0x2b464e, emissive: 0x35c8e8, emissiveIntensity: 1.0 }),
    shipLightRing: new THREE.MeshStandardMaterial({ color: 0x66ccff, emissive: 0x3399ff, emissiveIntensity: 2.5, transparent: true, opacity: 0.9 }),
    // Faceted mineral, not a lava lamp: pale icy body, a shallow skin-deep glow, and a polish
    // sharp enough that the low sun throws a hard highlight off each prism.
    // The first pass was mint-pale and read as candy. A crystal is a body of stone with light stuck
    // inside it: saturated dark teal, near-polished facets, and an emissive that only shows through
    // where the prism is thin. metalness 0.22 gives the faces a hard sun highlight without turning
    // the whole cluster into a mirror.
    crystal: new THREE.MeshStandardMaterial({ color: 0x14504d, emissive: 0x36d8bd, emissiveIntensity: 0.9, roughness: 0.16, metalness: 0.22, flatShading: true }),
    // scree is *local regolith that the crystal broke*, so it is rust-dark with a mineral sheen,
    // not the pale grey-green the first pass had — that read as a plastic flowerpot
    crystalRubble: new THREE.MeshStandardMaterial({ color: 0x3d2a20, roughness: 0.9, metalness: 0.16, flatShading: true }),
    // Freshly settled storm sand is terrain, so it is made of the terrain's own language: one
    // MeshStandardMaterial whose ripple maps are sampled in world space, in terrain.js. See
    // makeDriftMaterial for why the airborne film's ochre is the wrong colour for a pile of it.
  };
  // Deck furniture lamps join the hero lamps so the day/night cycle drives them instead of leaving
  // them at full emissive under a noon sun. The saturated cyan is the exception: even at the shared
  // 0.26 day drive its emissive dominated the dark albedo and the plaza studs still drew as bright
  // candy discs at noon, so it gets its own lower daytime floor; the loop compensates the night
  // term so after-dark output is unchanged.
  M.cyanLight.userData.dimDay = 0.10;
  heroLights.push(M.goldLight, M.cyanLight);
  // A crystal meeting the deck along a clean line looks pasted on. Its own scree gives it geology:
  // mineral fractures into angular chips, and the pile buries the base of the growth. One wide flat
  // collar mesh was the first attempt and it read as a paper mat — the rubble has to be individual
  // stones, each half-sunk into whatever the surface is actually doing under it.
  const chipGeo = new THREE.IcosahedronGeometry(1, 0);
  {
    const cp = chipGeo.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const k = 0.6 + vnoise(cp.getX(i) * 2.3 + 4, cp.getZ(i) * 2.3 + 7) * 0.85;
      cp.setXYZ(i, cp.getX(i) * k, cp.getY(i) * k * 0.62, cp.getZ(i) * k);
    }
    chipGeo.computeVertexNormals();
  }
  const screeRnd = mulberry32(0x5eed);
  const scree = (x, z, s, ry, parent, n = 16, mat = M.crystalRubble) => {
    const grp = new THREE.Group();
    grp.position.set(x, heightAt(x, z), z);
    grp.rotation.y = ry;
    // Fracture debris is densest right at the source and thins out fast; an even scatter out to 3 m
    // reads as a gravel field rather than the foot of a crystal.
    for (let i = 0; i < n; i++) {
      const a = screeRnd() * Math.PI * 2;
      const rad = (0.30 + screeRnd() * 0.42) * s;
      const dx = Math.cos(a) * rad, dz = Math.sin(a) * rad;
      const m = new THREE.Mesh(chipGeo, mat);
      const cs = (0.055 + screeRnd() * 0.10) * s;
      m.position.set(dx, heightAt(x + dx, z + dz) - heightAt(x, z) - cs * 0.35, dz);
      m.scale.set(cs, cs * (0.6 + screeRnd() * 0.5), cs);
      m.rotation.set(screeRnd() * 3, screeRnd() * 6.28, screeRnd() * 3);
      m.castShadow = true; m.receiveShadow = true;
      grp.add(m);
    }
    (parent || CUR).add(grp); return grp;
  };
  const box = (w, h, d, mat, x, y, z, parent) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    (parent || CUR).add(m); return m;
  };
  const cyl = (rt, rb, h, mat, x, y, z, seg = 18, parent) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    (parent || CUR).add(m); return m;
  };
  const colliders = [];
  // ─── footprints ───
  // A prop's collision discs used to be typed by hand in the line below the code that drew it, and
  // the two drifted apart: an r=3.4 disc around a deck whose furniture spanned 6 m, an r=1.6 disc
  // around a 0.6 m telescope, and three gantry legs 3.6 m apart wearing r=5.0 armour — which is how
  // the base ended up with 43 pairs of overlapping discs and pockets the rover could enter but never
  // leave. So props are now drawn inside an authoring scope, and their collision comes from the lot
  // rectangle they occupy: measured off the geometry by default, authored where the measurement
  // would be wrong (an arch you drive under, a rotated gantry). Discs are then the fewest that cover
  // that rectangle, which is why a long low building no longer carries one absurd central balloon.
  let CUR = G;
  let ZONE = '?';                       // the district being composed; the audit's grouping key
  const lots = [];
  const isDecal = m => m.isMesh && Math.abs(m.rotation.x + Math.PI / 2) < 0.02;
  const measured = () => {
    CUR.updateMatrixWorld(true);
    const b = new THREE.Box3(), t = new THREE.Box3();
    let n = 0;
    CUR.traverse(m => {
      if (!m.isMesh || isDecal(m) || !m.geometry) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      t.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      b.union(t); n++;
    });
    return n ? b : null;
  };
  // one rectangle → the discs that hold it, placed in world space. `maxR` tightens the tiling: the
  // fewest discs that cover a long thin rectangle bulge past its ends by (r − half the short side),
  // which is fine in open sand and wrong when the lot's own end has to stop at something.
  const lot = (id, cx, cz, w, d, ry = 0, maxR = 9) => {
    const cos = Math.cos(ry), sin = Math.sin(ry);
    for (const p of coverDiscs(w, d, maxR)) {
      colliders.push({ x: cx + p.dx * cos + p.dz * sin, z: cz - p.dx * sin + p.dz * cos,
                       r: p.r, prop: `${ZONE}:${id}`, zone: ZONE });
    }
    lots.push({ id: `${ZONE}:${id}`, x: cx, z: cz, w: +w.toFixed(1), d: +d.toFixed(1) });
    return id;
  };
  // A model template's own XZ outline, measured once and reused for every clone. The hand-typed
  // radius it used to be replaced with is what drifted: an r=1.6 disc around a 0.62 m telescope,
  // an r=0.8 disc around a flag mast, an r=3.4 disc around 6 m of deck furniture.
  const tplBox = new Map();
  const footOf = name => {
    let b = tplBox.get(name);
    if (!b) {
      const root = models[name];
      root.updateMatrixWorld(true);
      const t = new THREE.Box3().setFromObject(root);
      b = { w: t.max.x - t.min.x, d: t.max.z - t.min.z,
            cx: (t.min.x + t.max.x) / 2, cz: (t.min.z + t.max.z) / 2 };
      tplBox.set(name, b);
    }
    return b;
  };
  // The footprint a model actually has at an absolute scale — for the places where a prop is drawn
  // by `k`/`put` (which take the scale directly) rather than by `kSolid`, and which therefore have no
  // `putSolid` to measure them. A lot typed by eye next to a model placed by scale is the second
  // hand-typed guess the plan was rebuilt to end: the two speeders and the crystal shards are sized
  // this way, and both came out of the face sweep with wall geometry 3-5 m outside their own discs.
  const measuredSlot = (name, s) => {
    const b = footOf(name);
    return [b.w * s, b.d * s];
  };
  // place a model and give it the collision its geometry actually occupies
  const kSolid = (name, x, z, ry, sc = 1, id) => {
    putSolid(name, x, z, S * sc, ry, id);
  };
  const putSolid = (name, x, z, s, ry, id) => {
    const b = footOf(name);
    const keyed = id || name;
    // One footing per collision group: a pressure module, its corridor and its glasshouse are one
    // structure and must not be separated by a fold in the ground.
    const y = Math.min(b.w, b.d) * s >= GRADE_MIN
      ? grade(keyed, x, z, b.w * s, b.d * s, ry || 0)
      : undefined;
    put(name, x, z, s, ry, 0, y);
    lot(keyed, x, z, b.w * s, b.d * s, ry || 0);
    return id;
  };
  // A lamp's collision is its base drum, not its bounding box. `lamp.glb` spans 2.04 × 1.92 m only
  // because a 1.9 m cross-arm hangs 3 m above the deck, which the rover drives under; `footOf` would
  // have wrapped that arm in a wall and parked an invisible metre of barrier on every shoulder.
  // Measured off the mesh instead: every vertex below 0.25 m fits a 600 × 608 mm rectangle centred
  // 114 mm off the model origin, so the disc circumscribes that rectangle at its own centre — which
  // is why the wheel stops at the bolted plinth rather than a metre short of the mast.
  const LAMP_BASE = [-0.114, 0.60, 0.61];
  // A drum must not touch another prop's discs: two raw discs with no daylight between them have no
  // legal position in the crease, which is the "WASD stopped working" bug. How much daylight is
  // settled by the audit, not by taste: the driven census (tools/cdp-seam-drive.mjs, 2026-09-25)
  // parked the rover on every one of the 33 seams `plan()` reported and drove out on six headings —
  // 8 held, and a lamp post standing beside a gantry stanchion was one of them. The bar it used to
  // ask for was 0.3 m on the reasoning that a pole that close to a wall is one the rover can never
  // wedge into; that is backwards. The wedge is the space between the two *inflated* bodies, and it
  // exists for any pair under 2 × BODY_R apart, which is exactly `CORRIDOR`.
  const LAMP_CLEAR = CORRIDOR;
  const lampDrum = (x, z, s, ry) => {
    const [ox, w, d] = LAMP_BASE, c = Math.cos(ry), si = Math.sin(ry);
    return discLayout(w * s, d * s, x + ox * s * c, z - ox * s * si, ry);
  };
  // A pole the rover cannot see coming is worse than a pole that is missing, so a lamp is drawn only
  // where its drum actually fits: clear of every carriageway, and clear of everything already
  // standing. This catches the two placements that were always wrong but invisible — a street lamp
  // at an intersection, whose 8.2 m shoulder offset is the crossing lane, and a plaza lamp on the
  // hub's lamp ring, which swept straight through the building line's hangars.
  const lampFits = (x, z, s, ry) => {
    for (const o of lampDrum(x, z, s, ry)) {
      if (streetEncroach(o.x, o.z, o.r) > 0) return false;
      for (const q of colliders) {
        if (q.floor !== undefined) continue;
        if (Math.hypot(q.x - o.x, q.z - o.z) - q.r - o.r < LAMP_CLEAR) return false;
      }
    }
    return true;
  };
  // Where a lamp's slot is taken it slides along its own run rather than being dropped: an avenue
  // with a 50 m hole where one post refused to fit is a worse defect than a post 3 m down the kerb,
  // and the alternative — a pole standing inside another structure's clearance — is the defect this
  // whole pass exists to end.
  const putLamp = (id, x, z, s, ry, along = null) => {
    if (!lampFits(x, z, s, ry)) {
      let found = null;
      // Capped at 2 m, which is an eighth of the avenue's own post spacing: a slide that long is still
      // the same rhythm on the kerb, and a longer one is a different post standing somewhere else. The
      // first version of this allowed 8 m and moved a south-street lamp 5.5 m, which parked it dead
      // centre in the spaceport gate's drive-through lane — clear of every collider, wrong in the
      // picture, and the reason the cap is a number rather than a comment.
      if (along) {
        for (let n = 1; n <= 4 && !found; n++) {
          for (const t of n % 2 ? [n * 0.5, -n * 0.5] : [-n * 0.5, n * 0.5]) {
            const cx = x + along[0] * t, cz = z + along[1] * t;
            if (lampFits(cx, cz, s, ry)) { found = [cx, cz]; break; }
          }
        }
      }
      if (!found) return false;
      x = found[0]; z = found[1];
    }
    put('lamp', x, z, s, ry, 0);
    const [ox, w, d] = LAMP_BASE, c = Math.cos(ry), si = Math.sin(ry);
    lot(id, x + ox * s * c, z - ox * s * si, w * s, d * s, ry);
    return true;
  };
  // ── satellites are sited by the rule the audit judges, where they are committed ──
  // A district's small furniture is the side of a seam that can move, so it asks for the nearest
  // ground that holds `CORRIDOR` against everything already standing and off the carriageway, and its
  // mesh, footing and collider are then built at that answer — one object moved, so the collider stays
  // the geometry it was measured from rather than a second guess typed after it.
  // The carriageway is a blocker like any other disc, and it gets the same answer: the way out of it
  // is off the lane, perpendicular to the centreline it is standing in.
  const offStreet = (x, z) => {
    let best = null, bd = Infinity;
    for (const s of STREETS) {
      const ex = s.b[0] - s.a[0], ez = s.b[1] - s.a[1];
      const ll = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - s.a[0]) * ex + (z - s.a[1]) * ez) / ll));
      const qx = s.a[0] + ex * t, qz = s.a[1] + ez * t, d = Math.hypot(x - qx, z - qz);
      if (d < bd) { bd = d; best = d > 1e-6 ? [x - qx, z - qz] : [-ez, ex]; }
    }
    return best;
  };
  const corridorBreak = (x, z, w, d, ry) => {
    for (const p of discLayout(w, d, x, z, ry)) {
      if (streetEncroach(p.x, p.z, p.r) > 0) return offStreet(p.x, p.z);
      let worst = Infinity, off = null;
      for (const q of colliders) {
        if (q.floor !== undefined) continue;
        const g = Math.hypot(q.x - p.x, q.z - p.z) - q.r - p.r;
        if (g < worst) { worst = g; off = q; }
      }
      // the disc that is in the way names the way out of it
      if (worst < CORRIDOR) return [p.x - off.x, p.z - off.z];
    }
    return null;
  };
  const siteClear = (x, z, w, d, ry = 0, reach = 9) => {
    const block = corridorBreak(x, z, w, d, ry);
    if (!block) return [x, z];
    const away = Math.atan2(block[1], block[0]);
    for (let r = 0.5; r <= reach; r += 0.5) {
      for (let k = 0; k <= 16; k++) {
        const th = away + (k % 2 ? Math.ceil(k / 2) : -k / 2) * (Math.PI / 8);
        const cx = x + Math.cos(th) * r, cz = z + Math.sin(th) * r;
        if (!corridorBreak(cx, cz, w, d, ry)) return [cx, cz];
      }
    }
    return [x, z];        // nothing within reach: leave it where the audit can still see it
  };
  // the same, for an asset authored in real metres (the hero set): `s` is the absolute scale
  const putClear = (name, x, z, ry, s = 1, id, reach = 9) => {
    const b = footOf(name);
    const [cx, cz] = siteClear(x, z, b.w * s, b.d * s, ry || 0, reach);
    putSolid(name, cx, cz, s, ry, id);
    return id;
  };
  // A pipe run is laid by its own length. Two segments 6 m apart of a model that is 3.15 m long is
  // not a pipeline, it is isolated culverts parked on the apron, and once they carry collision a
  // player bumps into the gaps between them. So the run is divided into as many segments as its
  // length needs, each turned to face the next, and all of them share the host structure's id: the
  // joints are one rigid object, and the audit is right to read them that way.
  const pipeRun = (id, x0, z0, x1, z1, sc, from = 0) => {
    const b = footOf('pipe_straight'), s = S * sc, len = b.d * s;
    const dx = x1 - x0, dz = z1 - z0, dist = Math.hypot(dx, dz);
    const k = Math.max(1, Math.round(dist / len));
    const ry = Math.atan2(dx, dz);
    for (let i = 0; i < k; i++) {
      const t = (i + 0.5) / k;
      kSolid('pipe_straight', x0 + dx * t, z0 + dz * t, ry, sc, `${id}#${from + i}`);
    }
    return k;
  };
  // place a model on ground that holds the corridor, and give it the collision its geometry occupies
  const kClear = (name, x, z, ry, sc = 1, id, reach = 9) => {
    const b = footOf(name), s = S * sc;
    const [cx, cz] = siteClear(x, z, b.w * s, b.d * s, ry || 0, reach);
    putSolid(name, cx, cz, s, ry, id);
    return id;
  };
  // A gantry portal is four stanchions carrying a girder. The bay under it is driveable ground, so
  // the collision is the feet and nothing else — a disc on the centre would wall off the very space
  // the portal is built to enclose, and one oversized disc per foot eats 3.2 m of daylight each.
  const GANTRY_FEET = [[-5.6, -1.9], [5.6, -1.9], [-5.6, 1.9], [5.6, 1.9]];
  // The two end bays, measured off the export rather than typed: everything that stands between the
  // ground and the rover's roof at either end of the span. `GANTRY_FEET` gave each corner a
  // 1.5 × 1.5 m disc, but the asset carries a cast end rack — measured at x 5.03..6.75, z ±3.05,
  // y up to 0.99 on both ends — so a metre of concrete stood in the player's path at every portal in
  // the base while the collision map knew only about the posts. The band between the two ends stays
  // open ground, which is the whole point of a portal.
  const GANTRY_ENDS = [[5.89, 0, 1.72, 6.10], [-5.89, 0, 1.72, 6.10]];
  const portal = (id, x, z, s, ry) => {
    beginProp(id);
    put('gantry_service', x, z, s, ry, 0);
    endProp({ legs: GANTRY_ENDS.map(([a, b, w, d]) => [a * s, b * s, w * s, d * s]), at: [x, z], ry });
  };
  const beginProp = id => { CUR = new THREE.Group(); CUR.name = id; G.add(CUR); return CUR; };
  // opts: w/d/ry override the measurement; legs [[dx,dz,w,d],...] replaces it entirely (a prop you
  // drive under or between); platform makes the whole footprint driveable deck instead of a wall.
  const endProp = (opts = {}) => {
    const id = CUR.name;
    const b = measured();
    if (opts.platform) {
      const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
      for (const p of coverDiscs(b.max.x - b.min.x, b.max.z - b.min.z)) {
        colliders.push({ x: cx + p.dx, z: cz + p.dz, r: p.r, prop: `${ZONE}:${id}`, zone: ZONE,
                         floor: opts.platform, top: opts.deck });
      }
      lots.push({ id: `${ZONE}:${id}`, x: cx, z: cz, w: +(b.max.x - b.min.x).toFixed(1), d: +(b.max.z - b.min.z).toFixed(1) });
    } else if (opts.legs) {
      // legs are given in the prop's own local metres, so an open portal can be authored as
      // "its four stanchions" wherever it stands instead of re-solving the rotation per call site
      const ox = opts.at ? opts.at[0] : 0, oz = opts.at ? opts.at[1] : 0;
      const c = Math.cos(opts.ry || 0), si = Math.sin(opts.ry || 0);
      for (const [i, [dx, dz, w, d]] of opts.legs.entries())
        lot(`${id}#${i}`, ox + dx * c + dz * si, oz - dx * si + dz * c, w, d, opts.ry);
    } else if (opts.w) {
      lot(id, opts.x ?? (b.min.x + b.max.x) / 2, opts.z ?? (b.min.z + b.max.z) / 2, opts.w, opts.d ?? opts.w, opts.ry);
    } else if (b) {
      lot(id, (b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2, b.max.x - b.min.x, b.max.z - b.min.z);
    }
    if (opts.expose) lots[lots.length - 1] = { ...lots[lots.length - 1], ...opts.expose };
    for (const c of [...CUR.children]) { CUR.remove(c); G.add(c); }
    G.remove(CUR);
    CUR = G;
    return id;
  };
  // The report the old layout could not produce: which districts touch each other, which ones are
  // standing in a carriageway, and how much of the drawn geometry is actually collision-bearing.
  // `rim` is the one measurement `audit` structurally cannot make — see sealCheck in plan.js.
  let rimReport = null;
  const auditPlan = () => {
    const a = audit(colliders.filter(c => c.floor === undefined)
      .map(c => ({ x: c.x, z: c.z, r: c.r, zone: c.zone, prop: c.prop, id: c.prop })));
    return { ...a, discs: colliders.length, lots: lots.length, zones: [...new Set(lots.map(l => l.id.split(':')[0]))],
             rim: rimReport, pads: padAudit.filter(p => p.room < 0 || p.rimRoom < 0 || p.road > 0).length, padItems: padAudit };
  };
  const infoZones = [];
  const sparkPoints = [];
  const beacons = [];
  // One fitting, five sites. A site buys these in a box of twelve, so the base places the same
  // exported assembly at whatever scale its host needs — a tank drum roof, a mast cap, a dish rim,
  // a wreck-site pole. `y` is where the old drum's centre sat: the lens is authored at local z 0.31,
  // so sinking the mount by 0.31·s keeps the one part the eye actually reads at the height the
  // layout was tuned to, and the heat sink, hood and conduit arrive with it rather than being
  // drawn as a red pill. The fallback is a cylinder on purpose: if the asset ever fails to load,
  // a base whose night markers have gone dark is a safety regression, not a missing detail.
  const beaconAt = (x, y, z, s) => {
    const kit = models.beacon_kit;
    if (!kit) return beacons.push(cyl(0.4 * s, 0.4 * s, 0.6 * s, M.beacon, x, y, z, 10));
    const g = cloneModel(kit);
    g.position.set(x, y - 0.31 * s, z);
    g.scale.setScalar(s);
    G.add(g);
    const lens = g.getObjectByName('lens');
    if (lens) return beacons.push(lens);
    g.traverse(o => { if (o.isMesh && /beacon_lens/.test(o.material?.name || '')) beacons.push(o); });
  };
  // The rest of the kit: delineators, cones, a pit cover, a docking cradle, a stub mast and the
  // pad's floodlights. One clone per placement, aimed by yaw, and the caller reads a named node
  // back out of the clone when it needs an anchor that is not the origin (`kitNode`) — which is how
  // the flood lamps hand the beam rig a lens position that cannot drift from the housing.
  const kitNode = (name) => models.site_kit?.getObjectByName(name);
  const kitAt = (name, x, y, z, ry = 0) => {
    const src = kitNode(name);
    if (!src) return null;
    const g = cloneModel(src);
    g.position.set(x, y, z);
    g.rotation.y = ry;
    G.add(g);
    return g;
  };
  const lightStrips = [];
  const lightRings = [];
  const showBeamMats = [];
  const teleports = [];
  const padAudit = [];
  let showBeams = null;
  // The two bodies of the launch stack, filled where the stack is placed. See the LAUNCH district.
  let launchRig = null;
  let shipGroup = null;

  const zoneY = (zz) => heightAt(zz.pos[0], zz.pos[1]);

  // ══════════ HUB — plaza, arch gate, flagpole, teleport ══════════
  {
    const [hx, hz] = ZONES.hub.pos;
    ZONE = 'hub';
    const deckBox = (o) => { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o); };
    {
      // A 24 m blank slab in the middle of the player's arrival shot was the loudest "nothing has
      // been modelled here" in the base. A plaza is paved: inset panels with shadowed seams, a
      // landing disc, a hazard ring and flush studs that light up at night.
      const bb = deckBox(k('platform_large', hx, hz, 0, 1.9));
      const top = bb.max.y, x0 = bb.min.x + 0.55, x1 = bb.max.x - 0.55;
      const z0 = bb.min.z + 0.55, z1 = bb.max.z - 0.55;
      const cw = (x1 - x0) / 6, cd = (z1 - z0) / 6;
      // One authored 20 m plate instead of thirty-six boxes: broomed concrete sawn into
      // quarter-metre slabs at its expansion joints, a kerb around the rim, the landing
      // disc raised on its hazard ring, and the apron studs ground flush with the deck.
      const pave = cloneModel(models.hub_plaza);
      pave.scale.setScalar((x1 - x0 + 1.1) / 20);
      pave.position.set(hx, top, hz);
      pave.traverse(shade);
      G.add(pave);
      // A landing disc is marked, not painted one flat colour: a painted "H", a threshold band and
      // the four corner markings a pilot actually lines up against.
      {
        const mark = new THREE.MeshStandardMaterial({
          map: (() => {
            const cv = document.createElement('canvas');
            cv.width = cv.height = 512;
            const c = cv.getContext('2d');
            c.clearRect(0, 0, 512, 512);
            c.strokeStyle = 'rgba(214,206,190,0.5)';
            c.lineWidth = 16;
            c.beginPath(); c.arc(256, 256, 176, 0, 6.2832); c.stroke();
            c.lineWidth = 26;
            c.strokeStyle = 'rgba(226,218,200,0.62)';
            c.beginPath(); c.arc(256, 256, 118, 0, 6.2832); c.stroke();
            c.font = '700 168px ui-sans-serif, sans-serif';
            c.textAlign = 'center'; c.textBaseline = 'middle';
            c.fillStyle = 'rgba(226,218,200,0.58)';
            c.fillText('H', 256, 262);
            const t = new THREE.CanvasTexture(cv);
            t.colorSpace = THREE.SRGBColorSpace;
            return t;
          })(),
          transparent: true, depthWrite: false, roughness: 0.88, metalness: 0,
          polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
        });
        const disc = new THREE.Mesh(new THREE.CircleGeometry(3.48, 48), mark);
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(hx, top + 0.196, hz);
        noMerge(disc);
        G.add(disc);
      }
    }
    // Two raised decks framed the plaza with nothing on them, so this tried to give them a comms
    // mast, a feeder pillar, a stair and ground gear. Measured against the plan it does not fit:
    // the plaza already owns seven ring structures, the gate's four legs, the watch deck, the hub
    // tap and the flag mast, and the only mirrored pair of lots left inside the building line is on
    // the spawn axis. Twelve collider pairs came out overlapping. The ring is the skyline; the
    // plaza keeps its drivable ground, and the service deck that carries the pillar is built at
    // launch instead, where the ground is spare.
    // Spaceport Gate 01 spans the south approach, i.e. the first thing in frame at spawn. The Blender
    // `arch` pack wrapped both legs in an emissive cyan skin and hung the name in front of them on a
    // DoubleSide plane, so from the approach it read as a hologram: two glowing poles, a ghost board,
    // and the letters mirrored backwards behind themselves. A gate is the heaviest structure on an
    // airfield, so it is built as one — jointed pylons carrying a box-girder beam with the sign
    // painted on both faces.
    {
      beginProp('spaceport-gate');
      const gx = hx, gz = hz - 13.5;
      const gy = heightAt(gx, gz);
      const beamY = gy + 0.78 + 4 * 2.35;
      // One authored asset: jointed precast pylons with their bolt bands, a box girder with
      // chords, verticals, soffit joists and a recessed service panel, a railed catwalk, the
      // lane light channels set into rebates, and the beam-top kit.
      const gate = cloneModel(models.spaceport_gate);
      gate.position.set(gx, gy, gz);
      gate.traverse(shade);
      G.add(gate);
      {
        // The name is the one part of a gate that has to be legible rather than built, so the
        // boards are modelled and the lettering stays a painted canvas — mounted on both faces,
        // each single-sided, so it is never mirrored.
        const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 200;
        const g = cv.getContext('2d');
        g.fillStyle = '#26241f'; g.fillRect(0, 0, 1024, 200);
        g.fillStyle = '#5c564c'; for (let i = 64; i < 1024; i += 128) g.fillRect(i, 0, 3, 200);
        g.strokeStyle = '#7d7365'; g.lineWidth = 6; g.strokeRect(3, 3, 1018, 194);
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = '#d8f6ff'; g.font = '700 88px ui-sans-serif, system-ui, sans-serif';
        g.fillText('RED STARBASE', 512, 74);
        g.fillStyle = '#f0a94f'; g.font = '600 40px ui-sans-serif, system-ui, sans-serif';
        g.fillText('星港一号 · SPACEPORT GATE 01', 512, 150);
        const tex = new THREE.CanvasTexture(cv);
        tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
        const face = new THREE.MeshStandardMaterial({
          map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.42,
          roughness: 0.52, metalness: 0.08, side: THREE.FrontSide,
        });
        for (const sgn of [-1, 1]) {
          const p = new THREE.Mesh(new THREE.PlaneGeometry(12.6, 1.86), face);
          p.position.set(gx, beamY + 1.4, gz + sgn * 1.34);
          p.rotation.y = sgn > 0 ? 0 : Math.PI;
          p.castShadow = false; p.receiveShadow = true; G.add(p);
        }
      }
      // s=1.3 keeps the optic where the old red ball was (lens ⌀0.39 vs the ball's ⌀0.42) and just
      // adds the mount, sink and shade around it. `beaconAt` hands back the lens, so the light show
      // keeps blinking the optic only — not the metalwork behind it.
      beaconAt(gx + 9.6, beamY + 6.4, gz, 1.3);
    }
    endProp({ legs: [[hx - 8.1, hz - 13.5, 4.3, 3.6], [hx + 8.1, hz - 13.5, 4.3, 3.6]] });
    // The pack's `rail` is a flat painted panel: edge-on to a moving camera it vanished, face-on it
    // read as a lane stripe trowelled onto the sand. A barrier has three depths of silhouette —
    // kerb, lower tube, top tube — and posts to interrupt it, so it survives every viewpoint.
    //
    // Both runs are instantiated from the two nodes of one Blender kit (tools/blender/
    // build_barriers.py) into a single group that is deliberately not a `put()` template root, so
    // the merge pass bakes all eighteen modules into one batch per material instead of eighteen
    // draws each. Placement stays here because it is the terrain sampling that has to follow the
    // dune; the geometry is what was missing.
    const barRun = new THREE.Group();
    barRun.name = 'gate-barrier-run';
    G.add(barRun);
    const barPost = models.barrier_kit?.getObjectByName('post');
    const barBay = models.barrier_kit?.getObjectByName('bay');
    const barrier = (bx) => {
      const zs = [], ys = [];
      for (let i = 0; i <= 4; i++) { const z = hz - 21.0 + i * 2.16; zs.push(z); ys.push(heightAt(bx, z)); }
      for (let i = 0; i < zs.length; i++) {
        const p = cloneModel(barPost);
        p.position.set(bx, ys[i], zs[i]);
        p.traverse(shade);
        barRun.add(p);
      }
      for (let i = 0; i < zs.length - 1; i++) {
        const len = zs[i + 1] - zs[i];
        const z = (zs[i] + zs[i + 1]) * 0.5;
        // seat each segment on its own two posts rather than the run's chord, or the dune curve
        // floats the kerb in air at one end and buries it at the other
        const tilt = Math.atan2(ys[i] - ys[i + 1], len);
        const b = cloneModel(barBay);
        b.position.set(bx, (ys[i] + ys[i + 1]) * 0.5, z);
        b.rotation.x = tilt;
        b.traverse(shade);
        barRun.add(b);
      }
    };
    barrier(hx - 5.2); barrier(hx + 5.2);
    // Each barrier is the kerb of its own gate leg, so it carries that leg's collision id: audited
    // as a separate prop it reported a −1.7 m crease with the plinth, and a crease inside one
    // structure is not a trap, it is a corner.
    lot('spaceport-gate#0', hx - 5.2, hz - 16.68, 0.36, 8.7);
    lot('spaceport-gate#1', hx + 5.2, hz - 16.68, 0.36, 8.7);
    // flag mast — one Blender asset (tools/blender/build_flagmast.py): bolted boot, winch, cleat,
    // sectional tube with flanges, sheave truck, halyard and rings. A tapered cylinder with a
    // sphere on top could not carry any of that, and at 8 m the mast is the tallest thing in the
    // plaza, so its silhouette is read from every district.
    const mastY = heightAt(hx + 5.5, hz + 4);
    put('flag_mast', hx + 5.5, hz + 4, 1, 0, 0);
    {
      // A flat quad on a pole is the one prop that guarantees the whole plaza looks like a
      // placeholder. Cloth hanging off a mast has a catenary droop and a wind ripple in it.
      const fg = new THREE.PlaneGeometry(2.3, 1.35, 14, 6);
      const fp = fg.attributes.position;
      for (let i = 0; i < fp.count; i++) {
        const u = (fp.getX(i) + 1.15) / 2.3, v = (fp.getY(i) + 0.675) / 1.35;
        fp.setZ(i, Math.sin(u * 7.4 - 0.5) * 0.11 * u + Math.pow(u, 2.4) * 0.20);
        fp.setY(i, fp.getY(i) - Math.pow(u, 2.2) * 0.26);
      }
      fg.computeVertexNormals();
      // The droop was already in the geometry; what made it read as a placeholder was the flat
      // single colour. A base flag carries an insignia, a stitched hem, a hoist sleeve and
      // sun-bleached folds along the weave, and no amount of shading on a plain colour adds those.
      const flagTex = (() => {
        const cv = document.createElement('canvas');
        cv.width = 460; cv.height = 270;
        const c = cv.getContext('2d');
        const rnd = mulberry32(0xf1a9);
        c.fillStyle = '#a8391f';
        c.fillRect(0, 0, 460, 270);
        const gr = c.createLinearGradient(0, 0, 460, 0);
        gr.addColorStop(0, 'rgba(40,18,10,0.42)');
        gr.addColorStop(0.34, 'rgba(255,190,150,0.05)');
        gr.addColorStop(1, 'rgba(228,170,140,0.17)');
        c.fillStyle = gr;
        c.fillRect(0, 0, 460, 270);
        for (let x = 0; x < 460; x += 4) {
          c.fillStyle = `rgba(255,255,255,${(0.018 + rnd() * 0.02).toFixed(3)})`;
          c.fillRect(x, 0, 2, 270);
        }
        c.strokeStyle = 'rgba(228,214,190,0.32)';
        c.lineWidth = 3;
        c.setLineDash([9, 7]);
        c.strokeRect(30, 8, 422, 254);
        c.setLineDash([]);
        c.fillStyle = 'rgba(30,24,20,0.52)';
        c.fillRect(0, 0, 26, 270);
        c.save();
        c.translate(198, 135);
        c.fillStyle = 'rgba(232,222,204,0.90)';
        c.beginPath(); c.arc(0, 0, 62, 0, 6.2832); c.fill();
        c.fillStyle = '#6d2413';
        c.beginPath(); c.arc(6, -4, 46, 0, 6.2832); c.fill();
        c.strokeStyle = 'rgba(232,222,204,0.88)';
        c.lineWidth = 7;
        c.beginPath(); c.arc(0, 0, 84, -0.55, 2.1); c.stroke();
        c.fillStyle = 'rgba(232,222,204,0.88)';
        c.beginPath(); c.arc(Math.cos(2.1) * 84, Math.sin(2.1) * 84, 8, 0, 6.2832); c.fill();
        c.restore();
        for (let i = 0; i < 240; i++) {
          c.fillStyle = `rgba(214,176,132,${(0.05 + rnd() * 0.13).toFixed(3)})`;
          c.beginPath();
          c.arc(120 + rnd() * 340, rnd() * 270, 1 + rnd() * 5, 0, 6.2832);
          c.fill();
        }
        const t = new THREE.CanvasTexture(cv);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
      })();
      const flag = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({
        map: flagTex, roughness: 0.8, metalness: 0, side: THREE.DoubleSide,
      }));
      // The cloth's hoist edge is set to the mast's own halyard line (0.20 m off the pole axis,
      // where the asset's rings are threaded), so the sleeve hangs on the rings instead of
      // floating inside the tube the way it did when both were placed by eye.
      flag.position.set(hx + 6.85, mastY + 6.35, hz + 4); flag.castShadow = true; flag.receiveShadow = true;
      G.add(flag);
    }
    k('barrel', hx - 6, hz + 6, 0.4); k('barrel', hx + 7, hz - 5, 1.2);
    putDeck('teleport_pad', hx - 8.5, hz + 11, 1.25, 0, -0.08);
    teleports.push({ key: 'hub', name: ZONES.hub.name, x: hx - 8.5, z: hz + 11 });
    put('astronaut', hx + 3, hz + 6, 1, 2.4, -0.02);   // the Blender EMU: 1.85 m, real metres
    // The plaza's service quad used to be drawn here with no collider at all, so the rover drove
    // through it. Giving it the collision its body actually has made it a 3.5 × 3.7 m object, and
    // there is no bay on the plaza's own ring that holds the corridor: sited at (10, 1) it came to
    // 2.83 m from the flag mast, at (19, -6) 1.56 m from a transformer ring, and a 16 m search found
    // nothing legal either. The plaza keeps its flag, its gate and its machines; the vehicles live
    // in the district built for them.
    // A flag mast is a 16 cm pole. Wrapping it in an r=0.8 disc meant the plaza had an invisible
    // metre-wide column nobody could see, in the exact line the player drives to reach the pad.
    // The rectangle now is the asset's own ground-level extent measured from its bounding box: the
    // 0.50 m boot plus the winch and crank that overhang its flag-side rim, which is why the centre
    // sits 30 mm off the pole axis rather than on it.
    lot('flagmast', hx + 5.53, hz + 4, 0.55, 0.49);
    {
      // The plaza was a handful of props on an empty plain: no skyline in any direction, which is
      // most of why the settlement read as small and cheap. A ring of structures gives every
      // sightline a back wall — but it has to obey the block. The old version swept r=22-30, which
      // put buildings in the carriageways on all four sides, and it used 18 slots on that circle:
      // 5.9 m of arc apiece, narrower than any hangar in the pack, so no matter how each disc was
      // drawn they had to overlap. Eight slots on the building line get 13.4 m of arc, and each one
      // is turned long-side to the square so the shallow dimension is the one that runs out at the
      // street. Two slots stay empty on purpose: 225° is the watch deck's pad, and 270° is the arrival
      // avenue, i.e. the bearing straight back to the spawn. The plaza's satellite dish used to stand
      // there, and a per-pixel diff of the spawn frame rendered with the headlights on and off
      // (measured 2026-09-24) put all 43 of that frame's blown pixels on that one reflector: its
      // surface is at (0, 1.77, -22.1), 3.9 m in front of the spawn and 2.1 m from each lamp, so the
      // game opened on a white blade standing in the gateway the Spaceport portal was built to frame.
      // The lamp ring below has always excluded the south approach; its comment claims the exclusion
      // is shared with the structures, and that half was false. The dish now stands with the rest of
      // its function in the comms farm.
      const FRONT = 18.5;                       // the hub block's building line
      const RING = [
        { n: 'hangar_roundA', k: 0.5, a: 45 },  { n: 'hangar_largeA', k: 0.62, a: 90 },
        { n: 'machine_generatorLarge', k: 0.9, a: 135 }, { n: 'gantry_service', g: 1.0, a: 180, gate: true },
        { n: 'machine_wireless', k: 1.1, a: 315 }, { n: 'structure_detailed', k: 0.8, a: 0 },
      ];
      for (const slot of RING) {
        const a = slot.a * Math.PI / 180;
        const s = slot.k !== undefined ? S * slot.k : slot.g;
        const b = footOf(slot.n);
        // Which side of the footprint faces the street is decided by the turn: at ry = a + 90° the
        // pack's local x runs radially, at ry = a it is local z. Every slot is turned so the shallow
        // dimension is the radial one — that is what keeps a deep hangar out of the carriageway.
        // A portal gantry is the exception, and it is turned the other way on purpose: its girder
        // must span ACROSS the lane. Two legs of one bent stand 3.8 m apart in the model and their
        // 2.3 m footings leave 1.5 m of daylight, so a 3.2 m rover can never pass between them —
        // turned long-side radial it closed the hub's west lane and stopped a nose-first rover
        // against its own foot (measured 2026-09-21). Turned across it, the lane runs between the
        // two bents 11.2 m apart, which is the space the thing was built to enclose.
        const ry = (slot.gate || b.w <= b.d) ? a + Math.PI / 2 : a;
        const radial = Math.min(b.w, b.d) * s;
        let x = hx + Math.cos(a) * (FRONT - radial / 2), z = hz + Math.sin(a) * (FRONT - radial / 2);
        // Two constraints pull opposite ways — the kerb line pushes a building inward, a neighbour
        // it would swallow pushes it outward — so they are resolved one at a time and the slot stops
        // as soon as neither is violated.
        for (let g = 0; g < 8; g++) {
          const ds = discLayout(b.w * s, b.d * s, x, z, ry);
          const over = Math.max(...ds.map(o => streetEncroach(o.x, o.z, o.r)));
          if (over > 0) { x -= Math.cos(a) * over; z -= Math.sin(a) * over; continue; }
          let clash = 0;
          for (const c of colliders) {
            if (c.floor !== undefined) continue;
            for (const o of ds)
              clash = Math.max(clash, CORRIDOR - (Math.hypot(c.x - o.x, c.z - o.z) - c.r - o.r));
          }
          if (clash <= 0) break;
          // Outward is the natural way clear of a neighbour, but on the hub ring "outward" is also
          // the way into the street — so both exits are tested and the kerb line wins: a building
          // that has nowhere legal to stand stays touching its neighbour rather than blocking a lane.
          const legal = (nx, nz) => Math.max(...discLayout(b.w * s, b.d * s, nx, nz, ry)
            .map(o => streetEncroach(o.x, o.z, o.r))) <= 0;
          const xo = x + Math.cos(a) * clash, zo = z + Math.sin(a) * clash;
          const xi = x - Math.cos(a) * clash, zi = z - Math.sin(a) * clash;
          if (legal(xo, zo)) { x = xo; z = zo; }
          else if (legal(xi, zi)) { x = xi; z = zi; }
          else break;
        }
        if (slot.n === 'gantry_service') { portal(`ring-gantry-${slot.a}`, x, z, s, ry); continue; }
        // An open gantry with nothing standing inside it reads as scaffolding nobody finished; the
        // Blender portal carries its own transformers, switchgear, conductors and signage.
        kSolid(slot.n, x, z, ry, s / S, `ring-${slot.a}`);
      }
      // An ungated lamp ring dropped a post dead-centre in the carriageway, i.e. directly in the
      // rover's path at spawn. Same south exclusion as the structures, plus two lamps squared up on
      // the barrier ends so the approach reads as an avenue rather than a gap in the ring.
      // The lamp ring used to share its radius with the machine ring: both at 13.8 m, so every post
      // stood inside a 2-2.9 m disc's clearance and the avenue of lights the plaza was designed
      // around could not be built at all once the drum had to hold CORRIDOR. Two rings on one radius
      // is the mistake, not the corridor. The lights move inside, to the brim of the paved core, and
      // the machines keep the outer ring they were already reading as their own edge.
      // Closed as a ring, six posts on a 7 m brim turn the plaza's core into a carousel of aisles:
      // the scan found a 15-20 m blind run between the fifth lamp and the spaceport gate's own leg.
      // Open as an arc across the north side, the same lights frame the heart of the plaza and leave
      // every approach lane unobstructed. Four, not five: the fifth stood at (-5.9, -4.1), and 12.6 m
      // due south of it is the spaceport gate's own west leg, which together with a street lamp made a
      // 15 m blind run the scan reports as a trap.
      for (let i = 0; i < 4; i++) {
        const a = (0.30 + i * 0.20) * Math.PI;
        const lx = hx + Math.cos(a) * 7, lz = hz + Math.sin(a) * 7;
        // A 5.7 m mast landing 1.8 m off the pad centre grew straight up through the teleport disc
        // and hid the markings from the approach. Fast-travel nodes keep their own clear envelope.
        if (Math.hypot(lx - (hx - 8.5), lz - (hz + 11)) < 5.4) continue;
        putLamp(`lamp-ring-${i}`, lx, lz, 1.25, a, [-Math.sin(a), Math.cos(a)]);
      }
      for (const sgn of [-1, 1]) {
        // Outboard of the gate's own legs, not between them: the pylons' discs reach to x 6.66 and a
        // drum needs 3.73 m past that, which is where a driver's eye lands on the lamps anyway — the
        // pair frames the portal from outside instead of standing in its opening.
        putLamp(`gate-lamp-${sgn}`, hx + sgn * 10.5, hz - 19.5, 1.15, sgn > 0 ? -1.57 : 1.57, [sgn, 0]);
      }
    }
    infoZones.push({
      key: 'hub', pos: [hx, hz], r: 22, tag: 'RED STARBASE · CENTRAL PLAZA',
      name: '中央广场', params: ['基地心脏 · 六条路线在此交汇', '传送平台：驶上光圈即可跃迁', '按 M 打开全区地图'],
      fact: '每一个火星基地都从一块平地开始。这块平地是用 240 台自动推土机铺出来的。',
    });
  }

  // ══════════ LAUNCH — pad, tower, starship & rocket stack ══════════
  {
    const [px, pz] = ZONES.launch.pos;
    const [ox, oz] = ZONES.hub.pos;                // the plaza the pad's feeder pillar feeds
    ZONE = 'launch';
    k('platform_high', px, pz, 0, 2.4);               // raised launch deck
    {
      // The apron's second platform was a 2.8 m plinth with nothing on it and no collider, so the
      // rover drove straight through a solid-looking structure and the deck framed the pad for free.
      // It is the stand for the pad's comms mast and the feeder pillar that drops conduit into it:
      // 1.4 m of clearance off the dust the booster kicks up, and line of sight over the tower.
      // Sited by search rather than by eye. The deck's collider is one 2 m disc, so its whole
      // footprint must hold the 3.2 m corridor clear of everything the district already owns; the
      // first try sat 0.7 m *inside* the umbilical portal's north foot, and every position between
      // here and the pad is taken by that foot. This is the nearest point on the apron that clears
      // every collider and encroaches no road: 3.8 m to that foot, measured.
      const [sx, sz] = [px + 18, pz + 7], ss = 0.8;
      // The deck's walking surface, surveyed — not its bounding box. The max.y of the box is the top
      // of the tallest thing welded to the platform, which on a railed deck sits well over the floor.
      const deckTopY = (o) => {
        o.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(o);
        const rc = new THREE.Raycaster(
          new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y + 0.5, (b.min.z + b.max.z) / 2),
          new THREE.Vector3(0, -1, 0), 0, b.max.y - b.min.y + 1);
        const hit = rc.intersectObject(o, true)[0];
        return hit ? hit.point.y : b.max.y;
      };
      const dr = 0.4;
      beginProp('feeder-stand');
      const pl = k('platform_low', sx, sz, dr, ss);
      const floorY = deckTopY(pl);
      const onDeck = (name, dx, dz, s, ry) => {
        // Seated on the surveyed deck level, not on a `dy` constant: `dy` is an offset from the
        // terrain under that one item's own footprint, and the pad apron is not flat.
        const x = sx + dx * Math.cos(dr) + dz * Math.sin(dr);
        const z = sz - dx * Math.sin(dr) + dz * Math.cos(dr);
        return put(name, x, z, s, ry, floorY - heightAt(x, z));
      };
      onDeck('machine_wireless', -0.4, 0.25, S * 0.45, dr - 0.4);
      // The pillar is a Blender asset: a hinged door with a three-point latch, tilted louvres on the
      // flanks and back, a pitched rain roof over a drip edge, glands and a strapped conduit out of
      // its foot, all grouted onto a cast plinth. It used to be one `box()` the same 0.7 × 0.5 m —
      // which read as a drawing of a cabinet's silhouette, not the cabinet.
      const [plx, plz] = [sx + 0.85 * Math.cos(dr) - 0.65 * Math.sin(dr),
                          sz - 0.85 * Math.sin(dr) - 0.65 * Math.cos(dr)];
      const pillar = cloneModel(models.feeder_pillar);
      pillar.position.set(plx, floorY, plz);              // its datum is the deck it grouts onto
      // Aimed back at the plaza it feeds, so the latch, warning tile and nameplate read from the
      // approach the rover comes in on. The `+ PI` is the exporter turning the authored +Y face
      // into app -Z.
      pillar.rotation.y = Math.atan2(ox - plx, oz - plz) + Math.PI;
      pillar.traverse(shade);
      CUR.add(pillar);
      const df = footOf('platform_low');
      endProp({ w: df.w * S * ss, d: df.d * S * ss, x: sx, z: sz, ry: dr });
    }
    // A 33 m disc of injection-moulded white plastic was the brightest surface in the scene and it
    // filled the entire driving view. A launch deck is concrete over steel mat: dusty grey-brown.
    // Two colours in the packs do not exist outdoors on Mars: a saturated safety-yellow and a
    // bright cool injection-moulded white. Both are the loudest "kit prop" in any frame — the
    // yellow was the only thing on the island brighter than the sky, and the white is why the
    // machines, corridors and rails read as plastic rather than built structures. Marking paint
    // fades to ochre inside a season of dust and moulded plastic scuffs to a matte grey-brown, so
    // that is what they are now. The emissive guard is what keeps the hero lamps lit: their accents
    // carry a real emissive term and are the base's night lighting, not a surface colour.
    for (const [mname, root] of Object.entries(models)) {
      if (!root || /^(starship_stack|crew_rover|optimus_bot|watch_deck|spaceport_gate|hub_plaza|reactor_tap|lox_stand|roadster|crystal|rover|lamp|habitat_dome|greenhouse|cryo_tank|lander|teleport_pad|beacon_kit)$/.test(mname)) continue;
      const deck = /^platform_/.test(mname);
      // A pipe elbow weathered to flat matte pale grey lost the one thing that says "manufactured":
      // a specular streak along its length. Outdoors it read as a 4 m cream boulder sitting in the
      // player's path. Enamel-coated steel is darker and much glossier than the dust around it.
      const pipe = /^pipe_/.test(mname);
      root.traverse(o => {
        if (!o.isMesh) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (!m.color || m.emissive && m.emissive.r + m.emissive.g + m.emissive.b > 0.05) continue;
          if (pipe) { m.color.setRGB(0.235, 0.232, 0.222); m.roughness = 0.44; m.metalness = 0.58; continue; }
          const { r, g, b } = m.color;
          if (r > 0.55 && g > 0.36 && b < 0.34 && r - b > 0.28) {
            m.color.setRGB(0.21, 0.152, 0.078);
            m.roughness = 0.86; m.metalness = 0.06;
          } else if (r > 0.58 && g > 0.55 && b > 0.5) {
            m.color.setRGB(deck ? 0.225 : 0.30, deck ? 0.198 : 0.275, deck ? 0.174 : 0.245);
            m.roughness = 0.9; m.metalness = deck ? 0.05 : 0.16;
          }
        }
      });
    }
    // ── The mount's perimeter marker: a channel cast into the deck, not a tube laid on it ──
    const py = zoneY(ZONES.launch);
    // The strongback's footing is declared here, ahead of the deck furniture that has to dodge it,
    // because the channel's termination and the flood ring are both solved from this rectangle.
    // Repeating the four numbers at the tower is how the two would drift apart.
    const TW = 11.40, TD = 3.81, tx = px - 11, tz = pz;
    const RING_R = 9.5;
    // What the old one was, measured rather than guessed: a ⌀0.14 torus at py + 0.045 spans y
    // 0.575–0.715 over a deck `surfaceAt` reports level at exactly 0.6 for all 720 bearings. So it was
    // not floating — it was 90 mm of round tube standing on top of a flat slab, drawing a hard shadow
    // band across the pad, and running straight through the strongback's footing for 23.2° of arc.
    // Pad edge lighting is poured in, not laid on: a cast frame set into the slab with a short diffuser
    // face standing out of it, and it stops where a foundation stops it. Per span that is two meshes —
    // the flat frame (the flush-decal case of the primitive rule) and the 60 mm emitter face above it.
    // Neither has volume to float or interior to shadow, and nothing samples the terrain, because the pad
    // deck they sit on is itself level by construction.
    const ringClearArcs = () => {
      const N = 2880;
      const inside = i => {
        const a = i / N * Math.PI * 2;
        return Math.abs(px + Math.cos(a) * RING_R - tx) < TW / 2 &&
               Math.abs(pz + Math.sin(a) * RING_R - tz) < TD / 2;
      };
      // Rotate the scan to start on a transition, so one footing straddling 0 rad still resolves as a
      // single gap instead of two arcs that meet at the north bearing.
      let from = -1;
      for (let i = 0; i < N; i++) if (inside(i) !== inside(i - 1)) { from = i; break; }
      if (from < 0) return inside(0) ? [] : [{ a0: 0, a1: Math.PI * 2 }];
      const arcs = [];
      let run = null;
      for (let k = 0; k <= N; k++) {
        const a = (from + k) / N * Math.PI * 2;
        if (!inside((from + k) % N)) (run ||= { a0: a, a1: a }).a1 = a;
        else if (run) { arcs.push(run); run = null; }
      }
      if (run) arcs.push(run);
      return arcs;
    };
    // Inset each end by half the frame's own width. The solved arc stops where the circle *crosses*
    // the footing's outline, so its last vertices sit on that line and a 0.2 m band left untrimmed
    // would poke 30 mm into the concrete it is supposed to stop against.
    const ARC_INSET = 0.10 / RING_R;
    const arcs = ringClearArcs()
      .map(({ a0, a1 }) => ({ a0: a0 + ARC_INSET, a1: a1 - ARC_INSET }))
      .filter(({ a0, a1 }) => a1 - a0 > 0);
    const channelMat = M.dark.clone();
    const lensMat = M.cyanLight.clone();
    // The tube's own colours were the tell: albedo 0x8fd8e8 is a brighter cool surface than anything
    // on the deck by day, and emissive 0x2f9fbf has no red term at all, so the whole circuit drew as
    // one hue. A recessed marker is dust-covered marking glass in a cast frame — desaturated, and it
    // carries its colour in the emissive only. The clone keeps `cyanLight`'s userData.dimDay 0.10, so
    // the day/night drive stays in the same place as the deck lamps'.
    lensMat.color.setHex(0x8b938e); lensMat.emissive.setHex(0x4a8ba1);
    // The mount interior is drivable too, and an open cylinder has no back face — without this the
    // circuit would vanish the moment the rover stands inside it, which is where the pad is used.
    lensMat.side = THREE.DoubleSide;
    heroLights.push(lensMat);   // a clone escapes the deck-lamp registration; put it back
    lightStrips.push(lensMat);  // and keep it in the ship's light show, which strobes the pad's strips
    for (const { a0, a1 } of arcs) {
      const span = a1 - a0;
      // One segment per half metre of run, so a 28 m arc is as smooth as the full circle it replaced.
      const segs = Math.max(6, Math.round(span * RING_R / 0.5));
      // `RingGeometry` fans out from +x toward +y in its own plane; tipping it by π/2 about x makes the
      // theta angle the world's atan2(z, x), which is the angle `a` is measured in throughout here.
      const band = (width, y, mat) => {
        const b = new THREE.Mesh(new THREE.RingGeometry(RING_R - width / 2, RING_R + width / 2, segs, 1, a0, span), mat);
        b.rotation.x = Math.PI / 2; b.position.set(px, y, pz); G.add(b);
      };
      // 10 mm of cast frame proud of the slab, and the emitter standing 60 mm out of its middle.
      // The emitter cannot be a second flat band: measured at the vantage a player actually has, the
      // sight line from eye 1.55 m to the near point of the ring descends at 5.7°, so a ribbon lying
      // in the deck projects width·sinθ·(px/rad)/distance — a 55 mm glass face 9.5 m out is 0.39 px
      // on an 800 px column, and the night frame came back with the whole circuit invisible even at
      // the full 1.92 drive. Vertical extent is the only thing a grazing view can catch, which is why
      // this is a diffuser *face* and why the tube it replaces read so loudly at 140 mm of silhouette.
      // 60 mm of it, on top of the frame, in the primitive case the rule allows: a ground-hugging
      // fitting with no volume to sculpt, no interior to float, and nothing to sample the terrain.
      band(0.20, py + 0.010, channelMat);
      // `CylinderGeometry` walks its angle as (sin θ, cos θ) while every bearing here is (cos a, sin a),
      // so the arc is handed over mirrored rather than by rotating the mesh — no constant `ry` fixes a
      // change of handedness. θ = π/2 − a, so a runs a0…a1 as θ runs π/2 − a1…π/2 − a0.
      const kerb = new THREE.Mesh(
        new THREE.CylinderGeometry(RING_R, RING_R, 0.060, segs, 1, true, Math.PI / 2 - a1, span), lensMat);
      kerb.position.set(px, py + 0.040, pz); G.add(kerb);
    }
    // Every lens position is handed to `fx/beams.js` as the only honest anchor a pad shaft has: a
    // beam that starts at a lamp is lit by that lamp, and one that starts at a hand-typed coordinate
    // next to the pad is the two 44 m cones this replaced — which floated 11 m off the axis with
    // nothing under them.
    const floods = [];
    // The pitch the 24-lamp circuit was laid out at (2πR/24 = 2.49 m), now walked along the clear arcs
    // rather than the whole circle. Foundations displace luminaires; that is why the count follows the
    // available arc instead of the lamp's own geometry being buried in one — one of the old twenty-four
    // stood at the strongback's footing, and this circuit drops it and keeps the spacing.
    const FLOOD_PITCH = 2 * Math.PI * RING_R / 24;
    for (const { a0, a1 } of arcs) {
      const span = a1 - a0;
      const n = Math.max(1, Math.round(span * RING_R / FLOOD_PITCH));
      // Inset by half a pitch at both ends, so no housing sits on a footing curb.
      for (let i = 0; i < n; i++) {
        const a = a0 + (i + 0.5) / n * span;
        const rx = px + Math.cos(a) * RING_R, rz = pz + Math.sin(a) * RING_R;
        // The kit's lens faces its own local +z, so aiming that at the pad axis takes π/2 − θ, not θ.
        // Yaw and bearing are one conversion apart here, which is what keeps the shafts' `axisR` on the
        // ring radius the beam rig checks them against.
        const ry = Math.PI / 2 - a;
        // Two boxes used to be the lamp: a dark slab and a smaller one in the ring's own material
        // above it. The fixture now has a housing with fins, a yoke it tilts on and a glass face —
        // and the anchor the beam rig needs is read back out of the clone's `flood_lens` node, so it
        // cannot drift from the housing the way the hand-typed +0.18 did.
        const fl = kitAt('flood', rx, py, rz, ry);
        const lens = fl?.getObjectByName('flood_lens');
        if (lens) {
          lens.updateWorldMatrix(true, false);
          const lv = new THREE.Vector3();
          lens.getWorldPosition(lv);
          floods.push([lv.x, lv.y, lv.z]);
        } else {
          floods.push([rx, py + 0.18, rz]);
        }
      }
    }

    // ── Starship riding a Super Heavy: 71 m of stainless on the pad ──
    // Authored in Blender at real vehicle scale, so the only fit numbers here are the ones
    // the pad itself has to supply: the deck the mount stands on, and the engine bells that
    // hang three metres below the vehicle's own datum.
    const SHIP_H = 71.4, SHIP_R = 5.1;
    // Where the export cuts the loft, matched to STAGE in tools/blender/build_starship.py. Every
    // fitting on the stack has to be assigned to a side by this line, or staging leaves half of them
    // hanging in mid-air welded to the wrong vehicle.
    const STAGE_H = 38.4;
    const ship = new THREE.Group();
    const stack = cloneModel(models['starship_stack']);
    stack.traverse(shade);
    // The two vehicles the export was authored as. Mated, both sit at their authored offset and the
    // silhouette is the asset itself; from staging onward each carries its own motion, which is the
    // only reason the launch can show a ship pulling away from a booster instead of a decal sliding
    // up a cylinder. A stack that lost its body nodes is a stale asset, so this fails loudly — a
    // silent fallback would let the sequence "work" while nothing separates.
    // Spelled `upper` here rather than `ship`: this file already has a `ship`, and it is the pad
    // mount that holds the whole stack. The GLB node keeps its authored name `ship` — that is the
    // Starship stage; `base.shipGroup` is the thing it rides on.
    const booster = stack.getObjectByName('booster');
    const upper = stack.getObjectByName('ship');
    if (!booster || !upper) {
      throw new Error('starship_stack has no booster/ship nodes — rebuild tools/blender/build_starship.py');
    }
    // On its mount, not in it: the Raptor field is three metres of bell and the pad deck
    // would swallow the whole engine section if the stack sat at grade.
    ship.position.set(px, py + 2.9, pz);
    ship.add(stack);
    const RING_HUES = [0x3fd9ff, 0xff8a3c, 0xa05cff, 0x3fffc9, 0xff4d6d, 0xffd166];
    const ringGeo = new THREE.TorusGeometry(SHIP_R + 0.1, 0.1, 6, 40);
    for (const [i, f] of [0.05, 0.18, 0.33, 0.5, 0.68, 0.88].entries()) {
      const y = f * SHIP_H;
      const tr = new THREE.Mesh(ringGeo, M.shipLightRing.clone());
      tr.material.color.setHex(RING_HUES[i]); tr.material.emissive.setHex(RING_HUES[i]);
      tr.rotation.x = Math.PI / 2; tr.position.y = y; tr.visible = false; noMerge(tr);
      (y < STAGE_H ? booster : upper).add(tr);
      lightStrips.push(tr.material); lightRings.push(tr);
    }
    launchRig = { stack, mount: ship, booster, upper,
      pad: [px, py, pz], y: py, h: SHIP_H, r: SHIP_R, seam: STAGE_H, engines: STACK_ENGINES, floods,
      // The separation animation moves each body off its rest offset. Reading those offsets now,
      // before anything has touched them, is the only way to know what "mated" was; hardcoding zero
      // would silently re-derive the whole 71 m stack's stance from an assumption.
      rest: { booster: booster.position.clone(), upper: upper.position.clone() } };
    G.add(ship); shipGroup = ship;
    // A vehicle that is a cylinder of one radius gets one disc, which is not what a `lot` rectangle
    // produces: coverDiscs circumscribes the square, so the 9.2 m plot this replaces became a single
    // r 6.51 balloon standing two metres off the engine bells it was drawn to protect. Measured off
    // the mesh instead, with the rover as the yardstick — the triangles that intersect the slab from
    // the deck to 3.15 m up (the rover's own roof, Box3) span 9.04 m centred on the axis and reach
    // 4.52 m from it. Nothing of the stack exists below 1.42 m, and the hull only widens past that
    // above the rover's roof: 4.52 m at 4 m up, 5.3 m at 8 m (the ⌀10.2 m light rings), which the
    // rover drives under rather than into. The lot rectangle stays the measured 9.04 m for the plan
    // census; the collider is the disc. Driven at full throttle from the east the hull now stops with
    // its centre 6.12 m off the axis — 4.52 of disc plus the 1.6 m body ring physics adds — facing the
    // Raptor field; the balloon parked it at 8.11 m, 2 m out on bare slab with nothing in front of it.
    colliders.push({ x: px, z: pz, r: 4.52, prop: `${ZONE}:starship`, zone: ZONE });
    lots.push({ id: `${ZONE}:starship`, x: px, z: pz, w: 9.04, d: 9.04 });

    // ── Chopstick tower, west of the ship: its six arms reach east to the hull
    // and the "RED STARBASE" board on its south face reads from the teleport pad.
    // The asset measures 20.72 x 6.93 x 54.36 m, so at s 0.55 it puts an 11.40 x 3.81 m poured
    // footing on the pad. Its origin is the underside of that footing; the flame duct below it
    // (1.39 m deep, and the reason the export used to carry a baked +2.535 node lift that seated the
    // *duct floor* on the ground and left the footing hanging — see tools/glb_set_node_y.py).
    // (TW, TD, tx, tz are declared with the perimeter channel above: the deck furniture has to dodge
    // this footing, so the footing is stated once and the tower is what gets placed from it.)
    // So it is seated on its own lot: `claimLot` cuts the earthworks rectangle around the footing to
    // the highest natural ground under the deck and batters the shoulder back at 1:3, and the tower
    // is placed at that level rather than at a sampled point plus a constant.
    put('launch_tower', tx, tz, 0.55, 0, 0, grade('chopstick-tower', tx, tz, TW, TD));
    // The tower is a 40 m chopstick whose six arms reach out over the vehicle, so its measured box
    // would wall off the whole pad. The collider is what the rover can actually hit: the legs and pier
    // below its own roof, taken with the same slab predicate as the starship's disc. That field is one
    // continuous 10.14 x 3.48 m pier centred 0.57 m west and 0.17 m south of the footing axis (8.49 x
    // 3.38 within 0.3 m of the deck, 9.09 x 3.45 within 1.5 m) — not the two rails the old hand-typed
    // `lot('chopstick-tower', px - 12.5, pz, 6.5, 6.5)` drew: that single r 4.6 disc left 2.6 m of the
    // eastern pier standing in open air, raised ~3 m of phantom wall north and south of the legs, and
    // reached 17.1 m from the pad axis.
    // `maxR` 2 rather than the default cover, because the pier straddles the pad's edge-lighting
    // channel: the footing runs from 6.5 m out to 16.6 m and `RING_R` is 9.5 m, so any honest cover
    // crosses that circle and `ringClearArcs` already trims the lamp where the two meet. The default
    // 3-disc tiling of this rectangle (r 2.43) stands on 1.90 m of the untrimmed arc and overshoots
    // the circle by 1.12 m; six discs of r 1.93 do the same job at 0.18 m and -0.22 m, and their end
    // caps bulge 0.19 m past the measured field instead of 0.69 m. After the change: no rover-height
    // vertex of the tower lies outside a disc, plan() reports blocks 0 / intrusions 0, and the
    // tower↔ship pair sits at 0.89 m — tight, not overlapping. Driven north into the pier at full
    // throttle the hull stops at z -56.65 (the disc rim at -58.24 plus the body ring) and the rescue
    // takes it off the face instead of leaving it pinned; the sand the old disc fenced off drives
    // through, and the 22 m alley that alley was does not come back — the dead-lock census still
    // reports trapCount 0 / unreachable 0.
    lot('chopstick-tower', tx - 0.572, tz - 0.168, 10.14, 3.48, 0, 2);
    // Sited by triangle probe, not by eye. The tower's crown is a 2.58 x 2.37 m deck whose top face
    // measures y 26.61 (py + 26.01), ringed by a handrail that tops out at 29.11. The ball this
    // fitting replaces sat on the tower's own placement axis, 1.6 m east of the deck's edge, where the
    // highest material there measures 25.54 (py + 24.94) — its plate hung 1.07 m in the air. A glowing
    // sphere reads as a distant lamp there; a mount plate reads as a bug. Now bolted to the deck, 0.6 m
    // off the rail line so the two do not interpenetrate, with s=1.6 (optic ⌀0.48, base 0.68 m) well
    // inside the 2.37 m of standing room.
    beaconAt(px - 13.44, py + 26.01 + 0.31 * 1.6, pz - 0.85, 1.6);

    // ── Kenney booster on a service stand, the base's cargo rocket ──
    {
      // Tucked 1.7 m in toward the chopstick rails from where the two landmarks would otherwise
      // sit. At the wider spacing their colliders left a 4.5 m slot running 22 m back and closing
      // on an umbilical mast: an alley the rover drives into, cannot turn in, and has to reverse
      // the whole 22 m out of again. One solid cluster is both drivable and how a launch stack
      // actually stands — the cargo rocket beside the tower that services it.
      const bx2 = px - 15.6, bz2 = pz + 11.4, by = heightAt(bx2, bz2);
      const stack = new THREE.Group(); stack.position.set(bx2, by, bz2);
      const part = (name, y, ry) => { const o = cloneModel(models[name]); o.scale.setScalar(S); o.position.y = y; o.rotation.y = ry; stack.add(o); };
      part('rocket_baseB', 0.05, 0);
      part('rocket_finsA', 0.02, 0);
      part('rocket_fuelA', S * 1.0, 0.4);
      part('rocket_sidesA', S * 1.9, 0.2);
      part('rocket_topA', S * 2.9, 0);
      G.add(stack);
      lot('cargo-booster', bx2, bz2, 6.2, 6.2);
      sparkPoints.push({ x: bx2 + 3, y: by + 2.2, z: bz2 + 1.5, rate: 0.5 });
    }
    // support gantries + FATO tanks around the pad
    {
      const sx = px + 6, sz = pz - 12, sy = heightAt(sx, sz);
      // A kit scaffold frame standing over empty ground was the last bare prop on the pad. This is
      // the pad's LOX stand instead: a bundled cryo drum on its saddles inside a four-leg cage with
      // a guard ring, its manhole and relief valve, and a transfer line slung out of the bund on
      // clamps, running over two lattice trestles bolted to grade, and landing on a distribution
      // manifold on its own concrete pad short of the mount — the pad's umbilicals take it from there.
      put('lox_stand', sx, sz, 1, 0, 0);
      // The bund is a poured saucer, and it is the widest thing the stand puts on the ground: measured
      // off the export, `bund` reaches 1.709 m and `bund_lip` 1.715 m, the cage's own leg feet land at
      // 1.327 m inside it, and the one thing that overhangs the concrete is the relief valve on the
      // drum's top at 1.729 m. `coverDiscs` circumscribes a rectangle to half its diagonal, so a round
      // pour has to be authored as the square whose diagonal *is* its diameter: a 2.45 m side yields
      // the 1.732 m drum that holds the valve with 3 mm to spare. The 3.5 × 3.5 lot this replaces read
      // the saucer's ⌀ as a square edge and then circumscribed that, which spent the diagonal twice
      // and parked a 0.75 m invisible wall in the ring all the way around the concrete.
      lot('lox-stand', sx, sz, 2.45, 2.45);
      // The drum crate is body-height solid, so it takes the same ruling as every other drum group in
      // the world (pad-drums, drum-crate, lubricant-drums): sized off the model's own measured
      // footprint, not a constant. All four moved off the Kenney `barrels` striped box — a 0.55 m
      // crate printed with four black bands, which was the last piece of programmer art at body size
      // anywhere in the base — to `drum_crate.glb`, the welded skid built in tools/blender/build_crate.py.
      // As `k()` this one carried no collider at all and the rover drove straight through a crate of
      // cryo drums. Its centre used to be solved by hand against the bund at
      // `LAMP_CLEAR` = 0.3 m; that bar has since become the audit's `CORRIDOR`, which no offset this
      // side of the light ring can satisfy by arithmetic, so the crate asks for its ground instead —
      // bounded to 4 m because it belongs to this pipe run and must not wander off the pad.
      // Colliders follow the line's height, not its extent — the same ruling that keeps `lamp.glb`'s
      // cross-arm wall-less (see LAMP_BASE). The band a drum has to cover is set by the vehicle, not
      // by a person standing in the apron: parked on this pad with the suspension settled, the rover
      // measures 2.63 m from wheel to camera mast and tops out 2.72 m above the grade it stands on
      // (read off `phys.groundY` at the stand, the mid-span and the terminal, which all return 0.60 —
      // the apron is one flat pour). So a span below that is something the mast shears rather than
      // something it drives under. Measured off the export, the transfer line's lowest vertex outside
      // the bund sits at 3.945 m over the same datum, which leaves 1.2 m of clearance with the rover
      // parked directly under the sagged middle, so the ground beneath the bridge really is open and
      // a disc there would be a wall on nothing. Only the three things that stand *in* the apron get
      // discs: two trestle foot plates and the terminal pad, all sized off the export instead of off
      // the builder's own constants. The plates are 0.34 m squares and circumscribe to 0.24 m, and
      // the widest member of either lattice — a leg foot at the plate — reaches 0.224 m, so one drum
      // owns the whole tower. The pad is 1.15 m and circumscribes to 0.813 m, and everything stacked
      // on it, manifold gauge dial included, reaches 0.812 m.
      // That the trestles *carry* the span rather than standing next to it is the same class of claim
      // and gets the same treatment — measured off the export, not off the builder's intent. The line's
      // underside at the two tower centres is 4.118 and 3.945; the saddle bands run 4.121-4.176 and
      // 3.897-3.952 and the clamp bands 4.206-4.296 and 3.982-4.072, so the two bracket the pipe's own
      // circumference instead of stopping under it. The towers' topmost hoop band, at 3.673 and 3.450,
      // clears the line by 0.445 and 0.495 m, so a lattice built up to its hoops would be scenery;
      // what holds the span is the four legs, which run unbroken from the 0.000-0.090 foot plate to
      // 4.206 and 3.983 at the clamps. The invariant that checks all of it: no
      // vertex from 0.15 m up to the rover's own 2.72 m ceiling may sit outside these four discs, and
      // it reports 0 — where the drum's relief valve at 1.729 m is the tightest case and the guard
      // ring, at 2.240 m out but 3.010 m up, is the one thing the sweep clears *because* it is above
      // the ceiling. Run it half a metre higher, to 3.27 m, and those four braces are the only
      // strays it finds (192 vertices, no other node), which is the reading that says the band's top
      // has to be the vehicle and not a round number. All three keep the
      // stand's own prop id, so the audit reads them as one structure and never asks a drum to hold
      // corridor distance from its own pipe.
      for (const [n, dx, dz, side] of [[1, -0.71, 1.42, 0.34], [2, -1.42, 2.83, 0.34],
                                       [3, -2.55, 5.10, 1.15]])
        lot(`lox-stand#${n}`, sx + dx, sz + dz, side, side);
      // Sited after the trestle feet exist rather than before them: placement order is clearance
      // order, and the crate's nearest neighbour on this pad is the terminal drum the line ends on.
      putClear('drum_crate', sx - 3.5, sz + 0.9, 0.5, 1, 'lox-drums', 4);
      sparkPoints.push({ x: sx, y: sy + 2.4, z: sz, rate: 0.22 });
    }
    kSolid('machine_generatorLarge', px - 8, pz - 10, 1.9, 0.35, 'pad-diesel');
    portal('cargo-umbilical', px + 15, pz + 12, 1.0, 2.6);   // umbilical portal for the cargo rocket
    // The drum cage stood 3 m from the centre of an 8.8 m booster lot, i.e. inside the rocket's own
    // footprint, so its discs overlapped the stack by 2 m and the crease between them had no legal
    // position in it. It is sited by `kClear` now, so the search that used to be done once by hand is
    // re-run against whatever the district has committed when this line is reached.
    putClear('drum_crate', px + 12, pz + 19, 0.7, 0.5, 'pad-drums');

    // pad wash ring for the light show — guaranteed in-frame from the trigger distance
    const wash = new THREE.Mesh(new THREE.TorusGeometry(13.5, 0.22, 8, 56), M.shipLightRing.clone());
    wash.material.color.setHex(0x9ff0ff); wash.material.emissive.setHex(0x2fbfe0);
    wash.rotation.x = Math.PI / 2; wash.position.set(px, py + 0.5, pz); wash.visible = false; noMerge(wash); G.add(wash);
    lightStrips.push(wash.material); lightRings.push(wash);

    // light-show searchlights: five narrow, near-vertical shafts ringing the pad
    showBeams = new THREE.Group();
    showBeams.position.set(px, 0, pz);
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2 + 0.6;
      const bm = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 2.6, 56, 12, 1, true), new THREE.MeshBasicMaterial({
        color: [0x8fd4ff, 0xffb066, 0xc79cff, 0x8fffe0, 0xff9ab0][i], transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      bm.position.set(Math.cos(a) * 17, 28, Math.sin(a) * 17);
      bm.rotation.z = -Math.cos(a) * 0.14;
      bm.rotation.x = Math.sin(a) * 0.14;
      showBeams.add(bm); showBeamMats.push(bm.material);
    }
    G.add(showBeams);
    // teleport pad, clear of the blast ring
    putDeck('teleport_pad', px + 4, pz + 17, 1.1, 0, -0.08);
    teleports.push({ key: 'launch', name: ZONES.launch.name, x: px + 4, z: pz + 17 });

    infoZones.push({
      key: 'launch', pos: [px, pz], r: 34, tag: 'PAD ONE · ORBITAL LAUNCH MOUNT',
      name: '轨道发射台', params: ['星舰总高 71 m（不锈钢筒身 + 超重型一级）', '筷子塔高 40 m', '任务代号：RED STARBASE'],
      fact: '在火星，这座塔不只是点火台——它是回家的门票。完成任务链后回到观礼台看它喷火。',
      objective: '星舰总装塔 · 任务链终点的发射场',
    });
  }

  // ══════════ HABITAT — two dwelling domes, a glasshouse, one real corridor ══════════
  {
    const [vx, vz] = ZONES.habitat.pos;
    ZONE = 'habitat';
    // A corridor can only bolt to a hatch, so this district is sited from the doors its models
    // actually have. tools/door_bearing.py measures each shipped GLB: `ax` is the bearing the
    // modelled door faces in the asset's own frame, `face` how far its flange stands out from the
    // footprint centre recentre() puts at the origin. One equation then places a hull — aim the
    // hatch at the corridor (`ry = β − ax`) and drop the origin back along that bearing until the
    // flange lands on the corridor's end cap. The block used to rotate by eye and fit rectangles,
    // so all three joints met blank wall, and a four-hull tree asked six door-uses of three doors.
    const DOOR = {
      // Re-measured on the rebuilt asset: the porch frame face stands at +Z 4.890 and the door
      // leaf itself at 4.700, so the flange is set 50 mm inside the frame it bolts to. The old
      // 5.07 came from the previous shell, whose porch was 370 mm deeper.
      dome:  { ax: 0,           face: 4.84 },   // airlock porch: yellow door and steps, on +Z
      glass: { ax: Math.PI / 2, face: 5.46 },   // people door in the +X gable; -X is the air handler
    };
    const CAP = 2.75;                            // corridor flange, measured from the link's origin
    const SPINE = vz - 8;                        // the pressure run, on the avenue side of the block
    const hatch = (key, name, cx, cz, β, s, id) => {
      const d = DOOR[key];
      putSolid(name, cx - Math.sin(β) * d.face * s, cz - Math.cos(β) * d.face * s, s, β - d.ax, id);
    };
    // One airtight volume, not three props touching: glasshouse, link and dwelling dome A are
    // bolted door to door and carry one collision id, so the audit reads the joints as seams the
    // rover cannot be pinched in. Both flanges bury 50 mm into their frames on purpose.
    putSolid('hab_link', vx, SPINE, 1, Math.PI / 2, 'hab-module');
    hatch('glass', 'greenhouse', vx - CAP, SPINE, Math.PI / 2, 1.25, 'hab-module');
    hatch('dome', 'habitat_dome', vx + CAP, SPINE, -Math.PI / 2, 1.1, 'hab-module');
    // Dome B has its own airlock, so its crew walk down those steps rather than through a tunnel —
    // facing south puts the lit porch and the steps at the corner the avenue delivers a rover to,
    // instead of into a neighbour's wall.
    putSolid('habitat_dome', vx + 13.5, vz + 14, 0.9, Math.PI, 'hab-domeB');
    // hangar_roundA is an octagonal drum with no hatch anywhere on it, and measuring it is what
    // dethroned it from MODULE A: a settlement does not park a 15 m windowless drum on its frontage
    // and call it living space. It is the yard's dry store and LOX drum now, at the back of the
    // block where that is exactly what belongs.
    const drum = { x: vx - 8, z: vz + 14, s: S * 1.3 };
    // The drum is a 15 m structure, so it is moved the few metres the rampart asks for rather than
    // re-sited: `siteClear` searches outwards and takes the nearest legal ground.
    {
      const b = footOf('hangar_roundA'), s = drum.s;
      const [hx2, hz2] = siteClear(drum.x, drum.z, b.w * s, b.d * s, 0, 5);
      putSolid('hangar_roundA', hx2, hz2, s, 0, 'hab-drum');
    }
    // Yard life, all of it in the courtyard the two rows leave open and none of it on a disc, so the
    // crew read as a settlement's people rather than props standing in a wall.
    k('stairs', drum.x + 5.2, drum.z - 4.2, Math.PI / 2);   // the drum's only way to its roof hatch
    k('barrel', vx - 2, vz + 6, 1.1);
    put('astronaut', vx + 6, vz + 3, 1, -0.9, -0.02);
    k('alien', vx + 1, vz + 9, 2.1);
    putDeck('teleport_pad', vx + 16, vz + 2, 1.05, 0, -0.08);
    teleports.push({ key: 'habitat', name: ZONES.habitat.name, x: vx + 16, z: vz + 2 });
    const vy = zoneY(ZONES.habitat);
    // The night-side marker the autopilot aims at. It used to be one flat-ended cylinder argued
    // into staying a primitive because "it has to be sampled from terrain, which no exported GLB
    // can be" — but the terrain sampling is the caller's `vy`, and the asset never had to know
    // about it; what the primitive could not do is be a light: no heat sink, no shade hood, no
    // bolt circle, no conduit. Ø0.70 m at the drum roof, the biggest of the five.
    beaconAt(drum.x, vy + 8.3, drum.z, 1.6);
    infoZones.push({
      key: 'habitat', pos: [vx, vz], r: 28, tag: 'SETTLEMENT · MODULE A-D',
      name: '火星生活舱区', params: ['加压体积 3×920 m³ · 连通走廊 5.5 m · 气闸 ×2', '干燥储存鼓 Ø15 m · LOX 转注 12 m³/h', '常驻 24 名工程师与植物学家'],
      fact: '暖光从舷窗透出来的时候，四亿公里外的家也不过如此。',
    });
  }

  // ══════════ INDUSTRY — fab, cryo tanks, pipe racks + the leak skid ══════════
  {
    const [ix, iz] = ZONES.industry.pos;
    ZONE = 'industry';
    // The works yard keeps its heavy end — fab hall and generator block — off the two frontages and
    // puts the light stuff, the masts and the drum crates, on the street side, so the block reads
    // from the avenue as a skyline with a base line rather than four boxes dropped at random.
    kSolid('hangar_largeA', ix - 6, iz + 6, 0.35, 0.35, 'fab-hall');
    // The generator block used to land with its measured footprint right on top of the middle cryo
    // tank: machine_generatorLarge's geometry sits ~10 m off its own origin, so the placement point
    // and the obstacle are different places. It is sited by where its discs end up now.
    kSolid('machine_generatorLarge', ix - 4.2, iz - 10.5, 1.0, 1.2, 'genset-a');
    kSolid('machine_generator', ix + 12, iz + 7, 2.6, 1.4, 'genset-b');
    kSolid('machine_wireless', ix - 14, iz + 14, 0.9, 1.1, 'yard-mast');
    portal('fab-substation', ix + 2, iz + 16, 0.86, 1.1);   // fab substation gantry, an open portal
    // cryo row: three Blender tanks with hazard stripes, stringed along the yard's north edge on
    // their own skid pads so a rover can walk between the drums and the fab wall. One facility, one
    // collision id — a row of drums 0.9 m apart is one long wall to a 3.2 m rover, not a field of
    // pinches, and auditing it as separate props reported a trap that cannot exist.
    for (let i = 0; i < 3; i++) {
      const tx = ix + 17, tz = iz - 14 + i * 6.5;
      putSolid('cryo_tank', tx, tz, 0.95, 0.5 + i, 'cryo-farm');
      sparkPoints.push({ x: tx, y: heightAt(tx, tz) + 1.8, z: tz - 1.6, rate: 0.45 + i * 0.1 });
    }
    // The rack from the tank farm toward the fab: 1.9 m of steel laid on the ground, and until now
    // it had no collision at all — the face sweep found its skin outside every disc. It carries the
    // farm's own prop id with a `#n` suffix, because that is what it is: the manifold welded to the
    // tanks it drains. The audit groups `#n` discs into one rigid object, so neither the joints
    // between the segments nor the overlap where the line lands on a tank's footing reads as a crease
    // a rover could be trapped in — and it is not one.
    // It stops at ix + 8.5 rather than running on to the fab: the west end of the apron is a genset,
    // and a rack laid against it leaves 2.87 m of daylight, which is a seam.
    pipeRun('cryo-farm', ix + 15, iz - 7.5, ix + 8.5, iz - 7.5, 0.9);
    putSolid('drum_crate', ix - 13, iz + 6, 1.1, 2.0, 'drum-crate');   // crate of drums by the rail
    // The parked work rover: a 1.4 m body the rover drove through, because `k` draws and never
    // collides. Measured off the model like every other body in the world.
    kClear('rover', ix - 1, iz + 3, 1.8, 1, 'work-rover', 12);
    putDeck('teleport_pad', ix - 3, iz + 20, 1.05, 0, -0.08);
    teleports.push({ key: 'industry', name: ZONES.industry.name, x: ix - 3, z: iz + 20 });
    infoZones.push({
      key: 'highbay', pos: [ix, iz], r: 26, tag: 'INDUSTRY · FAB & CRYO FARM',
      name: '工厂储罐区', params: ['总装车间净高 18 m', 'LOX/LCH4 低温储罐 ×3', '焊接机器人 96 台'],
      fact: '火星版的“工厂在门口”：推进剂在这里灌装，坏了的零件在这里重焊。',
    });
  }

  // ── leak skid at LEAK_POS — the repair mission's focal point ──
  {
    const [mx, mz] = LEAK_POS;
    ZONE = 'leak';
    const my2 = heightAt(mx, mz);
    kSolid('machine_generator', mx, mz + 2.5, 1.4, 0.8, 'valve-housing');   // the valve housing
    // The BOG line the leak comes from stays drawn-and-uncollided, and that is a filed open defect
    // rather than an oversight. The valve housing stands 8.2 m off the cryo farm's tank line, so a
    // 1.9 m pipe laid on the ground anywhere between them keeps only 2.2-2.7 m of daylight against one
    // side or the other; laid south it reaches the street shoulder and reads as an intrusion; laid
    // west it blocks on the tanks. A half-collided line is worse than an honest gap, because the rover
    // stops on the near side and sails through the far one. The fix belongs to the leak district's
    // rebuild, not to a constant here.
    // hazard ring + red beacon on a hooded mast
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * Math.PI * 2;
      kitAt('stake', mx + Math.cos(a) * 5.4, my2, mz + Math.sin(a) * 5.4, a);
    }
    // South-west, off the housing's own bund. Laid west it crossed the tank farm's footings — the
    // line does belong to that farm, but three blocks in the collision map is not how to say so.
    k('pipe_straight', mx - 5, mz - 1.5, 0.2);
    k('pipe_corner', mx + 4.5, mz - 2.5, 2.4);
    kitAt('mast', mx - 3.4, my2, mz - 3.4);
    // The hooded mast the ring is there to warn about. Two primitives used to stand in for it —
    // a red drum and a 0.9 m square cap plate under it, which read as a lantern balanced on a
    // box. The fitting's own cast mounting plate *is* the cap now, so the plate is gone and the
    // mast carries an obstruction light with a hood, struts, a clamp band and a conduit stub.
    beaconAt(mx - 3.4, my2 + 1.85, mz - 3.4, 1.8);
    // The placard at the road end of the ring. It warns the driver who is about to reach the
    // hazard, so its face is aimed at the nearest street centreline instead of at the leak behind
    // it, and the `+ PI` is what makes the aim land on the printed side: the exporter turns the
    // authored +Y face into the app's -Z, so a bare atan2 shows the rover the sign's back legs.
    const px0 = mx + 0.5, pz0 = mz + 5.6;
    let roadDist = 1e9, aimX = 20, aimZ = 6;
    for (const s of STREETS) {
      const ex = s.b[0] - s.a[0], ez = s.b[1] - s.a[1];
      const t = Math.max(0, Math.min(1, ((px0 - s.a[0]) * ex + (pz0 - s.a[1]) * ez) / (ex * ex + ez * ez)));
      const d = Math.hypot(px0 - (s.a[0] + ex * t), pz0 - (s.a[1] + ez * t));
      if (d < roadDist) { roadDist = d; aimX = s.a[0] + ex * t; aimZ = s.a[1] + ez * t; }
    }
    const bRy = Math.atan2(aimX - px0, aimZ - pz0) + Math.PI;
    // Sited after the aim, not before: the board's three foot discs are strung across its own 2.24 m,
    // so the rotation is part of what has to hold the corridor.
    const [bx, bz] = siteClear(px0, pz0, 2.24, 0.55, bRy);
    beginProp('leak-board');
    put('hazard_sign', bx, bz, 1, bRy, 0);
    // Three discs spanned across the board's own 2.24 m, not one blob at its centre: the panel is
    // the thing that stops a rover and the ground between the legs is driveable.
    endProp({ legs: [[-0.72, 0, 0.55, 0.55], [0, 0, 0.55, 0.55], [0.72, 0, 0.55, 0.55]],
              at: [bx, bz], ry: bRy });
    infoZones.push({
      key: 'tanks', pos: [mx, mz], r: 12, tag: 'ALERT · PROPULSION LEAK',
      name: '推进剂泄漏点', params: ['BOG 回收管线 3 路 · 真空夹套', '按住交互键（键盘 E / 触屏「交互」）约 3 秒'],
      fact: '萨巴蒂尔反应器把 CO₂ 变成甲烷——泄漏的每一口都是回家的燃料。',
      objective: '靠近红色警报阀门组 · 按住交互键约 3 秒',
    });
  }

  // ══════════ COMMS — dish knoll ══════════
  {
    const [cx2, cz2] = ZONES.comms.pos;
    ZONE = 'comms';
    // The listening post is laid out as an antenna farm should be: the big ear on its own deck at
    // the centre of the block, the secondaries fanned out to the north frontage at the spacing their
    // own dish spans require, and the huts and the feed portal set back off the avenue.
    k('platform_high', cx2, cz2, 0.2, 1.6);
    k('platform_low', cx2 - 6, cz2 + 8, 1.1, 1.2);
    kSolid('satelliteDish_detailed', cx2 - 1, cz2 - 1, 0.15, 1.6, 'main-ear');
    kSolid('satelliteDish', cx2 + 10, cz2 - 9, 1.2, 0.85, 'dish-b');
    kSolid('satelliteDish', cx2 + 2, cz2 + 13, 2.9, 0.7, 'dish-c');
    // The plaza's fourth ear, moved out of the arrival avenue (see the hub ring). It stands on the
    // farm's west flank, still inside the pad — 15.8 m from the zone centre against its 20 m radius,
    // so the graded footing under it covers the dish the way the other three are covered — and the
    // collider table has its nearest neighbour, the array mast, 9.5 m away. It is turned to bear
    // west-south-west, which is the one heading none of the other three ears holds.
    kSolid('satelliteDish', cx2 - 15, cz2 - 5, 2.6, 0.9, 'dish-d');
    kSolid('machine_wireless', cx2 - 12, cz2 + 4, 0.5, 1.1, 'array-mast');
    portal('array-feed', cx2 + 17, cz2 - 3, 0.78, 0.9);   // array feed portal, clear of the dish rim
    kSolid('hangar_smallA', cx2 - 12, cz2 + 14, 2.4, 0.9, 'listening-post');
    k('desk_computer', cx2 - 6, cz2 + 8, 1.9);              // outdoor console on the low deck
    k('rail', cx2 - 3, cz2 + 10, 0.35);
    put('astronaut', cx2 - 4, cz2 + 7, 1, 2.6, -0.02);       // whoever is on shift, listening to Earth
    putDeck('teleport_pad', cx2 - 9, cz2 - 8, 1.0, 0, -0.08);
    teleports.push({ key: 'comms', name: ZONES.comms.name, x: cx2 - 9, z: cz2 - 8 });
    const cy = zoneY(ZONES.comms);
    // The smallest of the five, clipped to the rim of the 7.3 m dish — the DSN node's own
    // aviation light, and the one instance where the fitting's conduit stub actually has something
    // to run into.
    beaconAt(cx2 + 3.6, cy + 4.4, cz2 - 1.5, 1.25);
    infoZones.push({
      key: 'comms', pos: [cx2, cz2], r: 22, tag: 'DEEP SPACE NETWORK · NODE M1',
      name: '通讯阵列', params: ['主碟 7.3 m · X 波段', '与地球单程时延 4–24 分钟', '日出日落各一次全星通联'],
      fact: '和地球说话要等二十分钟回音。所以基地里的人，早就学会了自己解决问题。',
    });
  }

  // ══════════ SCIENCE — crystal grove & field lab ══════════
  {
    const [sx, sz] = ZONES.science.pos;
    ZONE = 'science';
    k('platform_low', sx, sz + 2, 0.4, 1.7);
    // a big alien growth the whole zone orbits around
    const big = seat(put('crystal', sx - 2, sz - 3, 2.6, 0.5, 0.6), 0.5);
    big.traverse(o => { if (o.isMesh) o.material = M.crystal; });
    scree(sx - 2, sz - 3, 6.2, 0.7);
    // A crystal is a hard spire in a skirt of loose scree: only the spire is an obstacle, and the
    // rubble is what the rover drives over. Ringing the footprints at r=1.2 left the grove reading
    // as invisible bollards in a field of glass.
    // The spire cluster is 2.6× its model, and the model is a grove, not a needle: the typed
    // 4.4 × 4.4 lot left over a thousand wall faces of the outermost spires outside the disc, which
    // is a rock the rover drives through. Measured off the same model the grove is drawn from.
    {
      const [aw, ad] = measuredSlot('crystal', 2.6);
      lot('anomaly-07', sx - 2, sz - 3, aw, ad);
    }
    for (const [dx, dz, cs] of [[7, 4, 1.05], [-9, 5, 0.8], [3, 9, 0.62], [-5, -9, 0.9]]) {
      // a crystal the size of a rover is a boulder, and the survey scatter does not know what the
      // anomaly's own lot already occupies, so each one takes the nearest ground that holds the corridor
      const [sw2, sd2] = measuredSlot('crystal', cs);
      const [pxx, pzz] = siteClear(sx + dx, sz + dz, sw2, sd2, dx * dz, 6);
      const c = seat(put('crystal', pxx, pzz, cs, dx * dz, cs * 0.34), 0.22);
      c.traverse(o => { if (o.isMesh) o.material = M.crystal; });
      scree(pxx, pzz, cs * 2.0, dx + dz);
      lot(`shard-${dx}${dz}`, pxx, pzz, sw2, sd2, dx * dz);
    }
    k('desk_computer', sx + 9, sz - 4, 2.2);
    kClear('craft_speederA', sx - 11, sz - 2, 1.1, 0.5, 'field-speeder');
    k('craterLarge', sx + 14, sz + 12, 0.7, 1.3);
    putDeck('teleport_pad', sx + 4, sz + 10, 1.0, 0, -0.08);
    teleports.push({ key: 'science', name: ZONES.science.name, x: sx + 4, z: sz + 10 });
    infoZones.push({
      key: 'science', pos: [sx, sz], r: 20, tag: 'FIELD SCIENCE · ANOMALY 07',
      name: '晶体科研区', params: ['撞击玻璃 / 层状硅酸盐 / 橄榄石', '大晶体形成年代：约 37 亿年前', '样本驾驶驶近即可自动采集'],
      fact: '每块岩石都是一页未读的书。好奇号在盖尔坑读了十年。',
    });
  }

  // ══════════ MOTOR POOL — the crew-rover bay and the robots that service it ══════════
  {
    const [mx, mz] = ZONES.motor.pos;
    ZONE = 'motor';
    // The district the map never filled in: a bay, a cradle and the two vehicles that were supposed
    // to live here. A bay you cannot drive into is not a bay, so the canopy keeps its collision to
    // the four stanchions it stands on, and the apron is one service pad sized to the rover rather
    // than two 14 m kit decks that buried it.
    portal('rover-bay', mx - 0.6, mz - 5.2, 0.92, Math.PI / 2);
    // The bots stand on the apron's graded deck, so the ground under a foot is the deck: no rim
    // survey needed.
    const pit = (x, z) => heightAt(x, z);

    // ── the crew rover, parked nose-out on its cradle at the mouth of the bay ──
    // It used to stand *between* the portal's four stanchions, and that is not a garage: the posts are
    // 3.4 m apart and the hull is 3.2 m across, so every one of the four creases came to 1.83 m of
    // daylight, and the driven census found the rover sitting in one of them at full throttle on all
    // six headings. Widening the portal to hold the corridor would have made it an 18 m carport, so
    // the vehicle lives on the apron where a rover actually leaves it and the bay is the open space
    // behind it — which is the thing the district's own note already wanted: a bay you can drive into.
    const ry0 = Math.PI / 2;
    const [rx, rz] = siteClear(mx - 0.6, mz + 3.4, 4.1, 2.44, ry0, 7);
    const cradle = putDeck('platform_low', rx, rz, 1.4, ry0, -0.1);
    const cradleTop = new THREE.Box3().setFromObject(cradle).max.y;
    const rover = cloneModel(models.crew_rover);
    rover.position.set(rx, cradleTop + 0.02, rz);
    rover.rotation.y = ry0;
    rover.traverse(shade);
    G.add(rover);
    // (w, d) are the footprint in the model's own axes and the rover is long along local X, so
    // passing them the other way round strung the two cover discs across the hull instead of
    // along it — a collider standing sideways through a 4.1 m vehicle, and a nose-in pin at each
    // end of it.
    lot('crew-rover', rx, rz, 4.1, 2.44, ry0);
    // the stand it docks on: a low cradle the rover's rockers sit in, so it reads parked, not fallen
    for (const dx of [-1.2, 1.2]) kitAt('cradle', rx + dx, cradleTop, rz, ry0);

    // ── two Optimus on the apron: one checking the airlock, one waiting at the mast ──
    for (const [i, [bx0, bz0, turn]] of [[mx - 3.9, mz - 3.4, 2.3], [mx + 4.2, mz + 1.6, -1.1]].entries()) {
      // a 0.62 m robot does not need the crease it was making with the bay posts it stands beside
      const [bx, bz] = siteClear(bx0, bz0, 0.62, 0.62);
      const bot = cloneModel(models.optimus_bot);
      bot.position.set(bx, pit(bx, bz), bz);
      bot.rotation.y = turn;
      bot.traverse(shade);
      G.add(bot);
      lot(`optimus-0${i + 1}`, bx, bz, 0.62, 0.62);
      // a robot on bare regolith leaves no story; the boot scuff ring and its charge lead do
      kitAt('cover', bx, pit(bx, bz), bz);
      sparkPoints.push({ x: bx, y: pit(bx, bz) + 0.9, z: bz - 0.2, rate: 0.12 });
    }

    // ── the pit: mast, workbench, drums and the second vehicle that still runs on wheels ──
    // The pit's three machines used to be pinned to hand-typed offsets, which is how the apron ended
    // up with three of the eight creases the driven census found the rover cannot drive out of: a
    // charger, a workbench and a drum stack each standing inside a bay stanchion's clearance. They are
    // now sited from the corridor the audit judges, at the offset they were drawn for.
    kClear('machine_wireless', mx + 6.5, mz - 2.5, 0, 1.15, 'charge-mast');
    kClear('desk_computer', mx + 1.6, mz + 6.8, 0.6, 1.5, 'pit-desk');
    putClear('drum_crate', mx + 5.6, mz + 4.2, 1.2, 1.28, 'lubricant-drums');
    // The Kenney `craft_speederA` is 2.0 × 2.1 m in its own units, and the diorama scale is 3.5, so
    // at sc 1.35 it drew a 9.5 × 9.9 m vehicle beside a 4.1 m crew rover while its typed lot claimed
    // 2.2 × 3.4 — a wall-thin collider around a body the rover drove straight through (the face sweep
    // found its skin 5.0 m outside that disc). Sized to what a light rover-quad should be next to the
    // crew rover, and the collision now comes off the same measurement as the mesh.
    const [usw, usd] = measuredSlot('craft_speederA', S * 0.45);
    const [ux2, uz2] = siteClear(mx - 6.4, mz + 1.4, usw, usd, 1.1);
    k('craft_speederA', ux2, uz2, 1.1, 0.45);
    lot('utility-speeder', ux2, uz2, usw, usd, 1.1);
    k('rail', mx - 8.5, mz + 5.5, 0.4, 1.2);
    for (const [dx, dz] of [[-2.5, 0.5], [-1, 1.5], [0.5, 2.5]]) {
      const cx2 = mx + dx, cz2 = mz + dz;
      kitAt('cone', cx2, pit(cx2, cz2), cz2);
    }
    putDeck('teleport_pad', mx + 1.5, mz + 8.5, 1.05, 0, -0.08);
    teleports.push({ key: 'motor', name: ZONES.motor.name, x: mx + 1.5, z: mz + 8.5 });
    infoZones.push({
      key: 'motor', pos: [mx, mz], r: 22, tag: 'MOTOR POOL · CREW ROVER BAY',
      name: '载人车车库', params: ['载人火星车 ×1（加压舱 2.4 m³）', 'Optimus 作业机器人 ×2', '舱外活动最远行程 12 km'],
      fact: '车轮能到的地方不需要火箭。一辆载人火星车就是一座会移动的加压舱。',
    });
  }

  // ══════════ WATCH DECK — the grandstand for the launch ══════════
  {
    const [wx, wz] = ZONES.watch.pos;
    ZONE = 'watch';
    const wy = Math.max(...Array.from({ length: 24 }, (_, i) => {
      const a = i / 24 * 6.283, rr = (i % 3) / 2 * 7;
      return heightAt(wx + Math.cos(a) * rr, wz + Math.sin(a) * rr);
    }));
    // The deck's wearing surface, measured off its own asset rather than guessed: the cast drum is
    // DECK_TOP = 1.00 m in `build_watch_deck.py` and the wear plate laid over it finishes 0.08
    // higher, so the crowd stands 1.08 m above the datum the model is placed at. The old constant
    // said 0.5, which put every foot hung off it — this board's plinth, and the band the chase
    // camera flies over — half a metre inside the concrete.
    const deckTop = wy + 1.08;
    const [lpx, lpz] = ZONES.launch.pos;
    // Azimuth the crowd looks down, and the opposite side of the deck where the seating sits.
    const face = Math.atan2(lpx - wx, lpz - wz);
    const back = face + Math.PI;
    // The whole grandstand is one Blender asset now: a cast drum with its form joints, four
    // stepped tiers of woven seats, a canopy on tapered columns, a two-rail fence, bollard
    // lamps and the broadcast camera — 270-odd bevelled parts welded into eleven buffers, with
    // precast-concrete and woven-vinyl fields carrying the millimetre detail.
    const deck = cloneModel(models.watch_deck);
    deck.position.set(wx, wy, wz);          // the asset's own datum is the ground under the drum
    deck.rotation.y = face;                 // its local +Y is the pad
    deck.traverse(shade);
    G.add(deck);

    // seats facing the pad + telemetry board angled back at the crowd
    k('stairs', wx - 3.5, wz + 2, -2.24, 0.9);
    const boardX = wx + Math.sin(back - 1.28) * 5.4, boardZ = wz + Math.cos(back - 1.28) * 5.4;
    // The enclosure is a Blender asset: a bolted bezel around a recessed bay, a shrouded fin heat
    // sink on the back, a visor on corner-welded brackets, conduit up the post's back into a gland
    // plate, and a cast plinth grouted into the deck. It was five `box()`s — a dark slab, a hood,
    // a square post, a plate and a glowing chip — which read as a drawing of a monitor.
    const board = cloneModel(models.telemetry_board);
    board.position.set(boardX, deckTop, boardZ);   // its own datum is the deck surface it bolts to
    // Aim the panel at the deck centre, where the crowd and the parked rover are. The `+ PI` is the
    // exporter turning the authored +Y face into the app's -Z — same contract as `hazard_sign`.
    board.rotation.y = Math.atan2(wx - boardX, wz - boardZ) + Math.PI;
    board.traverse(shade);
    // RETAINED RUNTIME PRIMITIVE — the flight display itself, and the only part of this asset that
    // is not allowed to be baked: the aperture shows a different frame every second (countdown,
    // ascent arc, telemetry bars), so it has to be a live CanvasTexture. The `box()`s that used to
    // build the cabinet around it are gone; what is left here is one plane dropped into the hole
    // the model cuts, 15 mm proud of the recess floor at the bay's own centre.
    const screenTex = (() => {
      const cv = document.createElement('canvas'); cv.width = 512; cv.height = 288;
      const c = cv.getContext('2d');
      c.fillStyle = '#071019'; c.fillRect(0, 0, 512, 288);
      c.strokeStyle = 'rgba(88,180,214,0.15)'; c.lineWidth = 1;
      for (let x = 0; x <= 512; x += 32) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, 288); c.stroke(); }
      for (let y = 0; y <= 288; y += 32) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(512, y + 0.5); c.stroke(); }
      c.strokeStyle = '#ffb04a'; c.lineWidth = 4; c.beginPath();
      for (let i = 0; i <= 64; i++) {
        const t = i / 64, x = 34 + t * 250, y = 252 - Math.pow(t, 1.6) * 196;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.stroke();
      c.fillStyle = '#7fe3ff'; c.beginPath(); c.arc(284, 60, 6, 0, 7); c.fill();
      c.strokeStyle = 'rgba(127,227,255,0.35)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(34, 252); c.lineTo(300, 252); c.stroke();
      c.font = 'bold 52px ui-monospace, monospace'; c.fillStyle = '#e9f6ff';
      c.fillText('T-00:04:12', 34, 58);
      c.font = 'bold 19px ui-monospace, monospace'; c.fillStyle = '#69c8e6';
      c.fillText('PAD ONE  ·  WINDOW NOMINAL', 34, 88);
      [0.72, 0.44, 0.88, 0.31, 0.63, 0.52].forEach((v, i) => {
        const x = 322 + i * 29;
        c.fillStyle = v > 0.8 ? '#ff7a5c' : '#3fd9ff';
        c.fillRect(x, 252 - v * 132, 17, v * 132);
        c.fillStyle = 'rgba(159,182,196,0.9)';
        c.fillRect(x, 256, 17, 3);
      });
      c.fillStyle = '#8fa8b6'; c.font = '15px ui-monospace, monospace';
      c.fillText('Δv  PWR  LOX  RP   ATT  RNG', 320, 278);
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const screenMat = new THREE.MeshStandardMaterial({
      map: screenTex, emissiveMap: screenTex, emissive: 0xffffff, emissiveIntensity: 1.05,
      roughness: 0.34, metalness: 0,
    });
    const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.55), screenMat);
    // The bay's own coordinates, read off the builder: the aperture is cut at z = 2.69 m and its
    // floor left at Blender y = 0.02, which the Y-up export turns into app z = -0.02. The glass
    // sits 15 mm proud of that floor and faces app -Z, i.e. the way the enclosure is aimed.
    screenMesh.position.set(0, 2.69, -0.035);
    screenMesh.rotation.y = Math.PI;
    board.add(screenMesh);
    G.add(board);

    // `top` lets the chase camera fly over; the rover parks on the deck
    colliders.push({ x: wx, z: wz, r: 9, top: deckTop + 0.25, floor: deckTop,
                     prop: 'watch:deck', zone: 'watch' });
    infoZones.push({
      key: 'watch', pos: [wx, wz], r: 20, tag: 'VIEWING DECK · SAFE DIST 60 m',
      name: '发射观礼台', params: ['视角方位直指 PAD ONE', '点火后 60 m 处会感到大气的轻推'],
      fact: '任务完成后回到这里——星舰点火时，火星的大气会把你轻轻推回座椅。',
      objective: '等待发射窗口 · 完成任务线后自动点火',
    });
  }

  // ══════════ NIGHT HILL — scope + lantern ring on the rim ══════════
  {
    const [nx, nz] = ZONES.night.pos;
    ZONE = 'night';
    putSolid('habitat_dome', nx + 6, nz - 4, 0.7, 1.7, 'dome');
    // A 1.2 m pier on a tripod does not need the r=1.6 armour it used to wear — that was a 3.2 m
    // invisible drum around a 0.9 m column, on a hill the player walks around to find the scope.
    // Registered before the lanterns because placement order is clearance order: a lamp yields to
    // ground it can already see, and drawn after them the pier sat inside a lamp's drum by 30 mm.
    lot('telescope', nx - 7, nz - 6, 1.0, 1.0);
    // Six posts on a 9 m arc are 3.86 m apart, which is 3 cm short of the corridor, and the arc ran
    // through the telescope's own bearing. Five steps over the same sweep on a wider ring clears both:
    // the lanterns light the hill's edge instead of crowding the scope.
    for (let i = 0; i < 6; i++) {
      const a = i / 5 * 2.6 + 2.4;
      const lx = nx + Math.cos(a) * 11.5, lz = nz + Math.sin(a) * 11.5;
      if (Math.hypot(lx - (nx - 7), lz - (nz - 6)) < 5.4) continue;
      putLamp(`lantern-${i}`, lx, lz, 1.3, a, [-Math.sin(a), Math.cos(a)]);
    }
    // Three cylinders used to stand here: a tapered pier, a white tube tipped over at -0.7 rad,
    // and a matte black disc glued onto the tube's end at +1.43. The disc was the tell — a
    // telescope's business end is an aperture, a mirror set down inside a dew shield, so the dark
    // you see sits in a rim of shadow rather than being a coin on a stick. The asset carries the
    // grouted footing, the pier's conduit, the azimuth ring and fork yoke, the counterweight bar
    // that stops a 2.8 m tube tipping, the tube rings on their dovetail, the carry handle, the
    // focuser with its diagonal, eyepiece and two knobs, the finder on its own dovetail, and the
    // recessed mirror cell. Its 40° elevation is baked in, tipped toward the same app -Z bearing
    // the old `rotation.x` produced, so this place call carries no rotation.
    const tel = cloneModel(models.telescope);
    if (tel) {
      tel.position.set(nx - 7, heightAt(nx - 7, nz - 6), nz - 6);
      G.add(tel);
    }
    infoZones.push({
      key: 'night', pos: [nx, nz], r: 18, tag: 'OBSERVATION HILL',
      name: '夜空观赏丘', params: ['夜晚：按 N 快进到午夜', '灯光秀：夜晚靠近星舰按 E'],
      fact: '火星的夜晚没有光污染。银河像一道旧伤疤横贯天顶，地球只是其中一颗不特别亮的星。',
    });
  }

  // ══════════ WRECK FIELD — the Dawn-7 freight lander ══════════
  let wreckPos = null;
  {
    const [yx, yz] = ZONES.storm.pos;
    ZONE = 'storm';
    const wy2 = heightAt(yx, yz);
    wreckPos = new THREE.Vector3(yx, wy2, yz);
    const w = put('lander', yx, yz, 1.15, 0.6, 0.45);
    w.rotation.z = 1.45; w.rotation.x = 0.25;         // down on its side
    lot('dawn7', yx, yz, 10, 10);
    k('barrel', yx + 9, yz + 4, 1.9);
    k('barrel', yx + 11, yz + 1, -0.4);
    {
      // the rescue craft that found it, on ground that holds the corridor with the lander's own lot
      const [rsw, rsd] = measuredSlot('craft_speederA', S * 0.55);
      const [rx, rz] = siteClear(yx - 8, yz + 8, rsw, rsd, 0.9);
      k('craft_speederA', rx, rz, 0.9, 0.55);
      lot('rescue-speeder', rx, rz, rsw, rsd, 0.9);
    }
    for (let i = 0; i < 5; i++) {
      const a = i * 1.7;
      k('terrain_roadStraight', yx - 14 + Math.cos(a) * (i * 3.5), yz - 6 + Math.sin(a) * (i * 2.8), a, 0.7); // scorch debris strip
    }
    kitAt('mast_tall', yx - 8, wy2, yz - 7);
    // The light sits on the mast's receiving flange at 5.80 m, not 0.6 m above it — the stub-mast
    // rule, applied: the beacon's own mounting plate is the top of the mast.
    beaconAt(yx - 8, wy2 + 5.80 + 0.31 * 2.2, yz - 7, 2.2);

    infoZones.push({
      key: 'storm', pos: [yx, yz], r: 24, tag: 'HAZARD ZONE · AEOLIS FIELD',
      name: '残骸场 · 货运飞船“黎明号”', params: ['上次事件：全球性沙尘暴 Sol 388', '太阳能板蒙尘之后，机遇号也这样安静下来'],
      fact: '火星的沙尘暴可以持续数月、覆盖整个星球。驶近时按 N 到午夜再来看它，灯笼会替你先亮着。',
    });
  }

  // ══════════ ROADSTER easter egg ══════════
  {
    const [rx, rz] = ZONES.roadster.pos;
    const ry = heightAt(rx, rz);
    // The one car in the scene that is not driven has to be recognised as a Roadster from
    // 60 m: a lofted body with its shoulder line, a glass canopy, arches over spoked rims,
    // splitter, diffuser and spoiler, shut lines on the panels, and Starman in the seat.
    const car = put('roadster', rx, rz, 1, 2.55, 0);
    lot('roadster', rx, rz, 2.4, 5.0, 2.55);
    // a small cairn of sample crates so the spot reads as visited
    k('desk_computer', rx + 4, rz - 3, 1.8, 0.7);
    infoZones.push({
      key: 'roadster', pos: [rx, rz], r: 12, tag: 'EASTER EGG · DO NOT TOUCH',
      name: '隐藏彩蛋：午夜公路', params: ['2018 年发射 · 飞行 8 年后迫降火星', '乘客：Starman'],
      fact: '“Don’t Panic.” —— 他终于到站了。',
    });
  }

  // ══════════ SAMPLES — mineral sites a front rewrites ══════════
  // Nine sites, six of them on the map at the start. The other three are under a sand lens and
  // stay there until a front's deflation strips them (main.js's 覆沙账本), which is how a storm
  // adds science as well as burying it. The first six keep the exact anchors and rand() order
  // they always had, so every placement verified before this block still holds; the three new
  // ones are appended so they only consume noise *after* the sixth.
  const samples = [];
  {
    const rand = mulberry32(1234);
    const SITES = [
      [86, 60], [-80, 66], [95, -30], [-30, 95], [35, -92], [-90, -35],
      [-46, -86], [-100, 14], [44, 92],   // masked: they surface where the wind takes, not where we hid them
    ];
    // A site is named for the district you drive past to reach it, never for a compass point:
    // the map's N and the props' +z disagree by a mirror, and a wrong bearing in a toast is worse
    // than no bearing. `near` is resolved against ZONES here, so it cannot drift from the map text.
    const nearZone = (x, z) => Object.values(ZONES).filter(zz => zz.name)
      .reduce((a, zz) => Math.hypot(x - zz.pos[0], z - zz.pos[1]) < Math.hypot(x - a.pos[0], z - a.pos[1]) ? zz : a);
    // One shared hemisphere used to be every lens on the island, and it read as a flat orange balloon:
    // no grain in the material and no landform in the form either. A drift is *deposition*, so this is
    // authored as one — crown blown off-centre to the lee, a plan that scallops where the flow
    // separated, and a foot that feathers out instead of ending on a knife edge. The mesh carries its
    // own metres, because main.js's sand ledger has to grow and shrink the same landform every frame —
    // rule B2's ground effect, and the reason it cannot be a baked GLB. The grain comes from terrain.js,
    // which lays the desert's own ripple across it in world space.
    const driftRnd = mulberry32(0xd11f);   // its own stream: the audited site anchors cannot move
    // The skirt is deliberately deep: the cap's boundary has to stay underground on every azimuth of a
    // dune field whose local relief over a 2 m radius measures up to 0.14 m, or the feathered foot ends
    // as a visible lip. Measured with the 0.55 it replaced, the worst clearance was 2 cm on one site;
    // at 0.92 the whole rim ring still buries itself by a hand's width at every cover level.
    const APRON = 1.34, SKIRT = 0.92;      // how far the foot reaches, and how deep it buries itself
    // Authored at its mature size, in metres: a full-grown cap is ~4.0 m along the wind, ~3.1 m across
    // and 0.45 m of crest over a 0.43 m skirt. main.js then blends 0→1 over this shape, so the sand
    // ledger is a growth curve and not a unit conversion. It used to be the conversion, and the
    // constants in it multiplied out to an 8.3 × 5.9 × 1.0 m dune burying a fist-sized rock.
    const FW = 1.65, SIDE = 1.28, HI = 0.47;
    function makeDriftGeo() {
      const RINGS = 14, SECT = 44, TAU = Math.PI * 2;
      // +x is the wind axis: main.js yaws every cap to the heading of the front that built it.
      const cx = 0.16 + driftRnd() * 0.10, cz = (driftRnd() - 0.5) * 0.14;
      // three low harmonics: lobed, never star-like
      const lobes = [[2, 0.055 + driftRnd() * 0.050, driftRnd() * TAU],
                     [3, 0.034 + driftRnd() * 0.040, driftRnd() * TAU],
                     [5, 0.014 + driftRnd() * 0.026, driftRnd() * TAU]];
      const rho = (a) => 1 + lobes.reduce((m, [k, q, p]) => m + q * Math.sin(k * a + p), 0);
      const pos = [], idx = [];
      for (let j = 0; j <= RINGS + 3; j++) {
        const u = j <= RINGS ? j / RINGS : 1 + (j - RINGS) * (APRON - 1) / 3;
        for (let i = 0; i < SECT; i++) {
          const a = i / SECT * TAU, r = u * rho(a);
          const px = Math.cos(a) * r, pz = Math.sin(a) * r;
          let y;
          if (u <= 1) {
            // the crown, measured from its own blown centre and renormalised against the lobed rim
            const dx = px - cx, dz = pz - cz;
            const t = Math.min(1, Math.hypot(dx, dz) / rho(Math.atan2(dz, dx)));
            // cos^1.55 arrives on the rim along a horizontal tangent: a drift's foot is feathered sand
            const crest = Math.max(0, Math.cos(t * Math.PI / 2)) ** 1.55;
            y = crest * (0.88 + 0.24 * vnoise(px * 1.7 + 3, pz * 1.7 + 7));
          } else {
            y = -(u - 1) / (APRON - 1) * SKIRT;
          }
          pos.push(px * FW, y * HI, pz * SIDE);        // metres, and the wind axis is the long one
        }
      }
      for (let j = 0; j < RINGS + 3; j++) {
        for (let i = 0; i < SECT; i++) {
          const a = j * SECT + i, b = j * SECT + (i + 1) % SECT;
          const c = (j + 1) * SECT + i, d = (j + 1) * SECT + (i + 1) % SECT;
          idx.push(a, b, c, b, d, c);              // windings face +y, which is up
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return geo;
    }
    const driftSand = makeDriftMaterial();
    SITES.forEach(([ax2, az2], si) => {
      const x = ax2 + (rand() - 0.5) * 14, z = az2 + (rand() - 0.5) * 14;
      const y = heightAt(x, z);
      const masked = si >= 6;
      const g4 = new THREE.Group(); g4.position.set(x, y, z);
      const c = cloneModel(models['crystal']);
      templateRoots.add(c);
      c.scale.setScalar(0.6 + rand() * 0.35);
      seat(c, 0.1);
      c.traverse(o => { if (o.isMesh) o.material = M.crystal; });
      noMerge(c); g4.add(c);
      const rubble = scree(x, z, c.scale.x * 1.9, rand() * 6.28);
      // No light column: a beam riding on top of a rock is the one cue that says "video-game
      // pickup". The mineral's own glow plus the ground ring carry it, and the map does the rest.
      const pad2 = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.42, 28),
        new THREE.MeshBasicMaterial({ color: 0x8fdccf, transparent: true, opacity: 0.10, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      pad2.rotation.x = -Math.PI / 2; pad2.position.y = 0.07; noMerge(pad2); g4.add(pad2);
      // The cap is sunk a hand's width so its feathered foot always has ground to disappear into;
      // a sand drift does not end on a knife edge, and this one's parent already sits on the survey.
      const lens = new THREE.Mesh(makeDriftGeo(), driftSand);
      const spin = rand() * 6.28;
      lens.scale.setScalar(1); lens.position.y = -0.10;
      lens.rotation.y = spin;
      lens.castShadow = true; lens.receiveShadow = true;
      noMerge(lens); g4.add(lens);
      // The group is never hidden for a masked site: a buried mineral is a sand mound, which is
      // exactly what the lens is, and hiding it would delete the only thing on the ground that says
      // "dig here". main.js dresses every site from its ledger before the first frame, so the mound
      // is already there when the player takes the wheel and the crystal underneath is not.
      G.add(g4);
      // Box3 reads world matrices, and g4 has not been rendered yet to fill its own in.
      g4.updateMatrixWorld(true);
      const rise = new THREE.Box3().setFromObject(c).max.y - heightAt(x, z);
      // A masked site starts under a drift, not under a tomb: 0.75 is deep enough to hide the crystal
      // and shallow enough that one scoured flank brings it back out inside a single crossing.
      samples.push({
        id: si, near: nearZone(x, z).name, group: g4, crystal: c, ring: pad2, lens, rubble, x, z,
        taken: false, buried: masked ? 0.75 : 0, seen: !masked, buriedWarned: false,
        seatY: c.position.y, rise: Math.max(0.9, rise), footY: rubble.position.y,
        spread: 0.86 + (spin / 6.28) * 0.3, yawJit: (spin - Math.PI) * 0.14,
      });
    });
    infoZones.push({
      key: 'samples', pos: [0, 0], r: 9999, tag: 'FIELD SCIENCE',
      name: '火星矿物样本', params: ['撞击玻璃 / 层状硅酸盐 / 橄榄石', '驾驶驶近即可自动采集', '沙暴会埋掉一些，也会刮出另一些'],
      fact: '每块岩石都是一页未读的书。风暴翻过一页，就会盖住另一页。',
    });
  }

  // ══════════ ROAD SETTING — street furniture on the terrain's own carriageway ══════════
  {
    // The road used to be painted along hand-picked zone-to-zone lines, which is why the carriageway
    // you could see did not match the carriageway the terrain shader flattened. Now the same STREETS
    // list that height.js compacts and plan.js audits is what gets lit.
    //
    // It used to get kit tiles as well, and that is what is gone here. A row of `terrain_roadStraight`
    // slabs laid every 8.7 m is a *second* carriageway sitting on top of the first: the shader's is
    // welded to `roadAt()` and therefore to the same field the wheels drive on, the tiles are rigid
    // ribbons at a fixed y. Where a dune rose over the avenue the tiles buried the paint, where the
    // sand dipped they stood proud of it, and the seam between those two cases is what made the
    // street read as pasted-down cards rather than ground. One street, one representation.
    const TILE = S * 1.7;                       // spacing of the lamp posts along the lane
    ZONE = 'road';       // the lamps below are the street's own furniture, not any district's
    for (const [si, s] of STREETS.entries()) {
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1], l = Math.hypot(dx, dz);
      const yaw = Math.atan2(dx, dz);
      const n = Math.round(l / TILE);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = s.a[0] + dx * t, z = s.a[1] + dz * t;
        if (i % 3 === 1) {
          // lamps stand on the shoulder, clear of the trafficable width but inside the setback
          const ox = dz / l * 8.2, oz = -dx / l * 8.2;
          const side = (i % 6 < 3) ? 1 : -1;
          putLamp(`lamp-${si}-${i}`, x + ox * side, z + oz * side, 1.05,
                  yaw + (side > 0 ? Math.PI / 2 : -Math.PI / 2), [dx / l, dz / l]);
        }
      }
    }
    // The kit's road is a pale peach ribbon with a large tile texture on it. Under a peach sky it had
    // no value separation from the dunes, and laid across the dark sintered deck it read as bathroom
    // tiling — the single brightest thing in every driving frame. A service road is compacted
    // regolith asphalt: darker than the pad it crosses, and matte enough to stop catching the dome.
    // It still gets that treatment wherever the kit tile is laid as rubble, which is now only the
    // launch-pad scorch strip.
    models.terrain_roadStraight?.traverse(o => {
      for (const mt of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
        mt.color?.setRGB(0.198, 0.172, 0.152);
        mt.roughness = 0.9; mt.metalness = 0.03;
      }
    });
  }

  G.traverse(shade);

  // Thin masts, lamp posts and stanchions are not colliders, so the chase camera happily parks
  // itself directly behind one and the shot becomes a black slab. Give every slender vertical
  // instance its own materials so the rig can fade it out while it sits on the camera→rover line.
  const occluders = [];
  {
    const box = new THREE.Box3(), sz = new THREE.Vector3(), ctr = new THREE.Vector3();
    // cloning a material the per-frame rig still animates would silently disconnect it
    const animated = new Set([...padGlow, ...beacons.map(b => b.material), ...lightStrips, ...lightRings.map(r => r.material), ...showBeamMats]);
    G.updateMatrixWorld(true);
    for (const inst of G.children) {
      if (!inst.isGroup || inst.children.length === 0) continue;
      box.setFromObject(inst);
      box.getSize(sz); box.getCenter(ctr);
      if (sz.y < 2.2 || Math.max(sz.x, sz.z) > 2.0) continue;
      let blocked = false;
      inst.traverse(o => {
        if (!o.isMesh) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (animated.has(m)) blocked = true;
      });
      if (blocked) continue;
      const mats = [];
      inst.traverse(o => {
        if (!o.isMesh) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        const cl = list.map(m => m.clone());
        o.material = Array.isArray(o.material) ? cl : cl[0];
        mats.push(...cl);
      });
      occluders.push({ inst, mats, x: ctr.x, z: ctr.z, r: Math.max(0.9, Math.hypot(sz.x, sz.z) * 0.5), f: 1 });
    }
  }

  // ══════════ PAD SITING — a charger has to stand on ground the rover can occupy ══════════
  // Pads took a hand-typed district offset that was checked against nothing. The hub one ended up
  // 3.20 m from the centre of a service deck carrying an r=2.47 collider, and the physics loop pads
  // every collider by the rover's 1.6 m half-width — so the charger sat 0.87 m *inside* a wall. When
  // the battery died the tow wrote that pose verbatim and the collision solver fired the rover out
  // of the plaza at 62 m per frame. So every pad is now re-sited against the same discs the physics
  // loop reads, before the reactor taps, UI markers and capture radius take their positions from it.
  {
    const BODY = 1.6;          // physics.js: min = c.r + 1.6
    const MARGIN = 0.35;       // a pad you land on with 5 cm to spare is not a pad
    const pf = footOf('teleport_pad');
    const rimOf = Math.max(pf.w, pf.d) / 2;
    const roomAt = (x, z, r) => {
      let m = Infinity;
      for (const c of colliders) {
        if (c.floor !== undefined) continue;      // decks are driveable, they never shove you
        m = Math.min(m, Math.hypot(c.x - x, c.z - z) - c.r - r);
      }
      return m;
    };
    // The body ring must clear every wall, the drawn pad must not underlap one, and a fast-travel
    // node must not sit in a carriageway.
    const legal = (x, z, rim) => roomAt(x, z, BODY) >= MARGIN
      && roomAt(x, z, rim) >= 0 && streetEncroach(x, z, rim) <= 0;
    for (const tp of teleports) {
      const m = padMeshes.find(p => p.x === tp.x && p.z === tp.z);
      if (!m) continue;
      const ox = tp.x, oz = tp.z, rim = rimOf * m.s;
      let found = null;
      if (!legal(ox, oz, rim)) {
        // Nearest legal approach first — the authored spot encodes the district's arrival line, and
        // a pad moved 9 m sideways still beats one moved 9 m behind a hangar.
        for (let rr = 0.5; rr <= 9 && !found; rr += 0.5) {
          const cands = [];
          for (let i = 0; i < 24; i++) {
            const a = i * Math.PI / 12;
            const x = ox + Math.sin(a) * rr, z = oz + Math.cos(a) * rr;
            if (legal(x, z, rim)) cands.push({ x, z, body: roomAt(x, z, BODY) });
          }
          if (cands.length) found = cands.sort((p, q) => q.body - p.body)[0];
        }
      }
      if (found) {
        m.o.position.x = tp.x = found.x;
        m.o.position.z = tp.z = found.z;
        // The footing moves with the pad: the slab it was cut into is re-graded where the deck now
        // stands rather than the pad being lifted or dropped by whatever the new ground happens to
        // be under its centre — that centre-plus-rim-max reading is what used to leave a pad
        // hovering over a slope it had just been moved onto.
        m.o.position.y = claimLot({ id: m.lotId, x: tp.x, z: tp.z,
          w: m.foot.w, d: m.foot.d, ry: m.foot.ry, move: true }) + m.bias;
        m.d.position.set(tp.x, m.o.position.y + 0.366 * m.s, tp.z);
      }
      padAudit.push({
        id: tp.key,
        room: +roomAt(tp.x, tp.z, BODY).toFixed(2),
        rimRoom: +roomAt(tp.x, tp.z, rim).toFixed(2),
        road: +streetEncroach(tp.x, tp.z, rim).toFixed(2),
        moved: +Math.hypot(tp.x - ox, tp.z - oz).toFixed(1),
      });
    }
  }

  // ══════════ BASE GRID — one reactor tap beside every teleport pad ══════════
  // Five outer districts start blacked out and the rover's battery is the only mobile relay,
  // so each tap needs its own materials: the base-wide emissive sets are shared and cannot be
  // dimmed per district. Deliberately emissive-only (no PointLight) — the whole scene is lit by
  // sun/hemi plus bloom, and six extra dynamic lights would recompile every standard shader.
  const gridRigs = [];
  {
    // The cable's anchor blocks are the one part of a tap that cannot be an asset: each one
    // has to sit on ground the model has never seen.
    const soot = new THREE.MeshStandardMaterial({ color: 0x2a2825, roughness: 0.72, metalness: 0.5 });
    ZONE = 'grid';
    // The tap has to stand beside its pad, out of the carriageway, and clear of everything the
    // district already owns. It used to wear a hand-typed 4.4 m offset, which in the habitat put
    // the rig four metres inside a hangar. So it asks the plan for a free lot instead.
    //
    // It must also stand outside the pad's own trigger circle. That circle is r 3.9 m and the rig's
    // collision disc is r 1.84 m, so a lot on the ring drives the substation through the middle of
    // the stand the pad is asking you to park in: measured at pad:industry, the rig at 3.90 m left
    // 0.46 m of hull room at the centre and made the whole approach side illegal, which is what kept
    // handing the connectivity audit an unstick instead of a park. minR keeps the disc clear of the
    // ring by one body width, so every point inside the trigger circle stays drivable.
    const TAP_STANDOFF = 3.9 + 1.84 + 1.6;
    const siteFor = (px, pz, away, w, d, minR = 0) => {
      const legal = [], best = [];
      for (const rr of [3.9, 5.0, 6.3, 7.8, 9.5, 11.5]) {
        if (rr < minR) continue;
        for (let i = 0; i < 16; i++) {
          const b = away + i * Math.PI / 8 - Math.PI;
          const x = px + Math.sin(b) * rr, z = pz + Math.cos(b) * rr;
          const ds = discLayout(w, d, x, z, b);
          if (ds.some(o => streetEncroach(o.x, o.z, o.r) > 0)) continue;
          let clear = Infinity;
          for (const c of colliders) {
            if (c.floor !== undefined) continue;
            for (const o of ds) clear = Math.min(clear, Math.hypot(c.x - o.x, c.z - o.z) - c.r - o.r);
          }
          (clear >= CORRIDOR ? legal : best).push({ x, z, yaw: b, rr, clear });
        }
      }
      // Hugging the pad beats a wide but distant lot — the tap is meant to be seen from the pad —
      // so legal sites rank by radius first. If the district owns every one of the 96 candidates the
      // emptiest loser is used, which is never as bad as the blind 4.4 m offset it replaced.
      const pick = (legal.length ? legal : best).sort((p, q) => p.rr - q.rr || q.clear - p.clear)[0];
      return pick || { x: px, z: pz, yaw: away };
    };
    for (const tp of teleports) {
      const rad = Math.hypot(tp.x, tp.z) || 1;
      const site = siteFor(tp.x, tp.z, Math.atan2(tp.x / rad, tp.z / rad), 2.6, 2.6, TAP_STANDOFF);
      const rx = site.x, rz = site.z;
      const yaw = Math.atan2(tp.x - rx, tp.z - rz);
      // A substation is a building, so it takes a footing of its own like every other tap on the
      // grid; the 6 cm below that is the plinth deliberately *embedded* in its slab so the joint
      // reads flush, not a slope cancelled by a constant.
      const tf = footOf('reactor_tap');
      const tapY = grade(`tap:${tp.key}`, rx, rz, tf.w, tf.d, yaw) - 0.06;
      const rig = new THREE.Group();
      rig.position.set(rx, tapY, rz);
      rig.rotation.y = yaw;
      G.add(rig);

      // ── the tap has to read as a substation you can drive up to and recognise from 100 m:
      // bolted octagonal footing, finned transformer drum, porcelain bushings, a braced
      // lattice mast and a service deck with its cage. One authored asset, cloned to each pad.
      const tap = cloneModel(models.reactor_tap);
      tap.position.copy(rig.position);
      tap.rotation.y = rig.rotation.y;
      tap.traverse(shade);
      templateRoots.add(tap);          // already baked as a template; re-merging would copy it
      G.add(tap);
      // The tap feeds its pad, and the run between them has to read as one installation from the
      // road. The four 11 cm anchor blocks this replaces were invisible past a few metres. This is
      // a duct now: sections sampled where they actually land, because the ground falls away between
      // the two graded bases and a single rigid span would float mid-run or bury itself at an end.
      // Both ends have to be anchored to something the eye can find, or the run reads as a random
      // dash in the middle of the paving — so it starts at the transformer drum's own face and ends
      // on the pad's bright apron, where dark-on-light carries it. The span is measured, not typed:
      // the tap stands wherever the plan gave it a lot. Local +Z is the side the rig was yawed to
      // face, which is its pad. Kept as primitives rather than authored because every section's
      // height comes from a live terrain sample.
      const ductFrom = 1.05, ductTo = Math.hypot(tp.x - rx, tp.z - rz) - 3.05;
      const ductSpan = (ductTo - ductFrom) / 7;
      for (let i = 0; i < 7; i++) {
        const lz = ductFrom + (i + 0.5) * ductSpan;
        const wx = rx + Math.sin(rig.rotation.y) * lz, wz = rz + Math.cos(rig.rotation.y) * lz;
        box(0.52, 0.19, ductSpan * 0.96, soot, 0, heightAt(wx, wz) + 0.085 - (rig.position.y), lz, rig);
        box(0.2, 0.06, 0.2, soot, 0, heightAt(wx, wz) + 0.205 - (rig.position.y), lz, rig);
      }

      const coreMat = new THREE.MeshStandardMaterial({ color: 0x101a1f, emissive: 0x4fe2ff, emissiveIntensity: 0, roughness: 0.2, metalness: 0.1 });
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 0), coreMat);
      core.position.y = 5.85; core.castShadow = true; noMerge(core); rig.add(core);
      const plateMat = new THREE.MeshBasicMaterial({ color: 0x4fe2ff, transparent: true, opacity: 0, alphaMap: lightPool(), blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      // 1.35 → 1.75 m: the ramp puts most of a flat hexagon's light back on the inside, so the disc
      // has to reach further to pool the same area of deck.
      const plate = new THREE.Mesh(new THREE.CircleGeometry(1.75, 40), plateMat);
      plate.rotation.x = -Math.PI / 2; plate.position.y = 0.42; rig.add(plate);
      // The shaft is the pad floods' shaft — same unit cone, same grazing-edge falloff, same run-out
      // instead of a cap. It used to be a `MeshBasicMaterial` on a 6-segment open cylinder at constant
      // opacity, which drew its own silhouette: three flat quads of cyan with a straight rim on either
      // side, and because the shell is DoubleSide and additive the two walls stacked into a brighter
      // seam down the middle. `fx/beams.js` was written to remove exactly that from the launch pad;
      // this was the last place in the base still doing it.
      const beamMat = shaftMaterial(0x6fe8ff, 0, 0.22);
      const beam = new THREE.Mesh(UNIT_BEAM, beamMat);
      // shallow flare, and it dies away in daylight — the cone opens to 1.05 m over 15 m of rise
      beam.scale.set(1.05, 15, 1.05);
      beam.position.y = core.position.y; rig.add(beam);
      // the additive halo meshes must not cast — a shadow-casting light shaft reads as a solid pole
      for (const o of rig.children) if (o !== beam && o !== plate) { o.castShadow = true; o.receiveShadow = true; }

      // `film` is the dust the last front left on this tap's array. The model is a merged clone and
      // cannot carry a per-copy material without six new shader programs, so the coating is expressed
      // through the two emissive readouts props.js already gives each rig its own copy of — see
      // 沙尘作为账本 in main.js, which integrates it from the storm field's local reading.
      gridRigs.push({ key: tp.key, name: tp.name, tp, x: rx, z: rz, power: 0, shown: -1, film: 0, filmWarned: false, cleaned: false, core, beam, plate, mats: [coreMat, plateMat, beamMat] });
      // The tap plate is 1.35 m across; the r=2.2 drum it used to wear was wide enough to keep the
      // rover out of the very stand it had to park in.
      lot('grid-rig', rx, rz, 2.6, 2.6);
    }
  }

  // ══════════ RIM BORDER — the playfield's edge stops with a ring of discs and *looks* like dust ══════════
  {
    // A5's permanent-loss case had no object in it at all. Past ISLAND.radius the ground climbs to a
    // crater rim standing 10 m at the median over the desert floor (up to 17.2) and then drops
    // 20..34 m into a void the terrain mesh does not even cover, so a rover that crests that lip
    // carries 4 m/s slides the far face — and there is no driving out of the 67° median that face
    // runs at, which left the rescue loop re-dropping it onto the same flat nothing forever.
    //
    // Containment is the collider ring's job, and a ring of equal discs does it as well as a wall of
    // boulders did: `sealCheck` below reads discs alone, and `audit` groups `rim:border#n` into one
    // rigid object, so the overlaps between neighbours are exempt the way the rampart's were. What the
    // boulders were *not* doing was holding their end of the bargain as scenery — 100 clasts around
    // 735 m of horizon is a fence of rocks, and a fence is level design on a planet whose whole appeal
    // is that nothing is designed. So the wall went invisible and the visible boundary moved to
    // rim_veil.js, which draws the same circle as travelling dust. That module is owned by main.js;
    // this block only guarantees that the two circles agree — both take their radius from `RIM`.
    ZONE = 'rim';
    const TAU = Math.PI * 2;
    const discs = Math.ceil((TAU * RIM.discR) / RIM.arc);
    for (let k = 0; k < discs; k++) {
      const a = (k / discs) * Math.PI * 2;
      colliders.push({ x: +(Math.cos(a) * RIM.discR).toFixed(2), z: +(Math.sin(a) * RIM.discR).toFixed(2),
        r: RIM.disc, prop: `rim:border#${k}`, zone: 'rim' });
    }
    // Warn the driver in the one language they read at speed. Deliberately sparse — eight boards
    // around 735 m of rim is a hint, one every 12 m is a fence — and set back inside the veil so the
    // boards are not themselves a pinch point. The hubward aim is the leak board's convention: the
    // exporter turns the authored +Y face into the app's −Z, so `atan2(x, z)` reads face-on from the
    // middle of the island rather than showing the back legs.
    let boards = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU + 0.31;
      const bx = Math.cos(a) * (RIM.face - 5), bz = Math.sin(a) * (RIM.face - 5);
      if (samples.some(s => Math.hypot(s.x - bx, s.z - bz) < 11)) continue;
      const bRy = Math.atan2(bx, bz);
      beginProp(`rim-board${boards}`);
      put('hazard_sign', bx, bz, 1, bRy, 0);
      endProp({ legs: [[-0.72, 0, 0.55, 0.55], [0, 0, 0.55, 0.55], [0.72, 0, 0.55, 0.55]],
                at: [bx, bz], ry: bRy });
      boards++;
    }
    // `audit` exempts same-object overlaps, which is exactly right for an interlocking wall and
    // completely blind to a hole in one. This is the measurement that replaces the check the
    // exemption gave up: flood the annulus over every point a rover centre could hold, and if open
    // ground still reaches the outside, the ring has a gap in it.
    rimReport = { ...sealCheck(colliders.filter(c => c.prop.startsWith('rim:border'))), discs, boards };
  }

  // Collapse the hand-built groups and the several hundred loose struts, tiles and crates placed
  // straight onto the island. Packs placed with `put` are skipped: their template was already
  // baked, and re-merging a clone would duplicate a shared buffer for no gain.
  for (const child of G.children) {
    if (child.isGroup && !templateRoots.has(child)) mergeInto(child);
  }
  mergeInto(G, true);

  // One shading pass over the finished island adds the panel joints, fasteners and weathering that
  // no CC0 kit ships with. Must run after the merge so every surviving material gets patched once.
  applySurfaceDetail(G);

  scene.add(G);
  const flamePoint = new THREE.Vector3(SHIP_POS[0], 1.6, SHIP_POS[1]);
  return {
    group: G, colliders, infoZones, samples, sparkPoints, beacons, lightStrips, lightRings, showBeams, showBeamMats, shipGroup, launchRig, teleports, padGlow, heroLights, occluders, gridRigs, crystalMat: M.crystal,
    plan: auditPlan, lots,
    leakPoint: new THREE.Vector3(LEAK_POS[0], heightAt(LEAK_POS[0], LEAK_POS[1]) + 1.8, LEAK_POS[1]),
    flamePoint,
    // `ZONES.*.pos` is a 2-tuple [x, z], so spreading it into a Vector3 — which the two lines above
    // and below this one do field by field, for exactly that reason — landed the zone's *z* in `.y`
    // and left `.z` at 0. Measured live before the fix: the pad rumble's panner sat at (−60, −54, 0)
    // while the stack stood at (−60, 0.6, −60), i.e. 60 m downwind in the wreck field and 55 m under
    // the sand, and `launch.audioAlt` read 63 m for a vehicle at 3 m. `launchRig.pad` already carries
    // the honest three numbers, so it is the source rather than a second hand-typed copy.
    launchPadPos: new THREE.Vector3(...launchRig.pad),
    wreckPos,
    watchPos: new THREE.Vector3(ZONES.watch.pos[0], heightAt(...ZONES.watch.pos), ZONES.watch.pos[1]),
  };
}
