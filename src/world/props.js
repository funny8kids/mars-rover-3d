import * as THREE from 'three';
import { surfaceAt } from './height.js';
import { ZONES, SHIP_POS, LEAK_POS, SAMPLE_COUNT } from '../config.js';
import { mulberry32, vnoise } from '../utils/noise.js';
import { loadModel, cloneModel } from './assets.js';
import { mergeInto, noMerge } from './merge.js';
import { applySurfaceDetail } from './surface_detail.js';
import { coverDiscs, discLayout, streetEncroach, STREETS, STREET_HW, CORRIDOR, audit } from './plan.js';

// ─── RED STARBASE · compact diorama ───
// One ~110 m island, six readable landmarks, everything hand-placed.
// Structures are Kenney Space Kit (CC0, 1-unit grid → scaled 3.5×); the hero
// pieces — the rover, the arch, the teleport pads, the ship, the domes — come
// from our own Blender builds so the silhouette language stays toy-soft.

const K = (name) => `kenney/space/${name}`;
const S = 3.5; // Kenney grid → diorama scale

const G = new THREE.Group();

export async function buildBase(scene, quality) {
  G.clear();
  const HERO = ['habitat_dome', 'greenhouse', 'launch_tower', 'cryo_tank', 'starship_stack',
    'crew_rover', 'optimus_bot', 'watch_deck', 'spaceport_gate', 'hub_plaza', 'reactor_tap', 'lox_stand', 'roadster', 'lamp',
    'crystal', 'lander', 'teleport_pad', 'gantry_service', 'astronaut'];
  const KENNEY = ['hangar_roundA', 'hangar_largeA', 'hangar_smallA', 'corridor', 'corridor_corner',
    'corridor_end', 'platform_high', 'platform_low', 'platform_large', 'machine_generator',
    'machine_generatorLarge', 'machine_wireless', 'structure', 'structure_detailed', 'pipe_straight',
    'pipe_corner', 'satelliteDish', 'satelliteDish_detailed', 'rocket_baseB', 'rocket_finsA',
    'rover',
    'rocket_fuelA', 'rocket_sidesA', 'rocket_topA', 'barrels', 'barrel', 'craft_speederA',
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
      // the whole greenhouse exists to show off.
      if (o.isMesh && /glass_pane|_glass$/.test(o.name) ) o.castShadow = false;
      for (const mt of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
        const n = mt.name || '';
        if (n === 'glass_pane') { mt.transparent = true; mt.opacity = 0.30; mt.depthWrite = false; mt.roughness = 0.06; o.castShadow = false; }
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
  for (const [name, root] of Object.entries(models)) {
    if (root && name !== 'crystal') mergeInto(root);
  }
  // Cloned packs are already collapsed above; hand-built groups still need their own pass.
  const templateRoots = new Set();
  const put = (name, x, z, s, ry, dy = -0.05) => {
    const o = cloneModel(models[name]);
    templateRoots.add(o);
    o.scale.setScalar(s);
    o.position.set(x, surfaceAt(x, z) + dy, z);
    o.rotation.y = ry || 0;
    CUR.add(o); return o;
  };
  const k = (name, x, z, ry, sc = 1) => put(name, x, z, S * sc, ry);

  // A wide deck seated on the centre height buries its downslope rim in the dune, so seat it on
  // the highest ground inside its own footprint instead.
  const rimY = (x, z, r) => {
    let y = surfaceAt(x, z);
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6;
      y = Math.max(y, surfaceAt(x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    return y;
  };
  const putDeck = (name, x, z, s, ry, bias = 0) => {
    const o = put(name, x, z, s, ry, 0);
    o.position.y = rimY(x, z, 2.7 * s) + bias;
    if (name === 'teleport_pad') {
      const d = new THREE.Mesh(padMarkGeo, padMarkMat(PAD_MARKS[padSeq % 6], 0x1a2b3d + padSeq * 7919));
      padSeq++;
      d.rotation.x = -Math.PI / 2;
      d.scale.setScalar(s);
      d.position.set(x, o.position.y + 0.366 * s, z);
      noMerge(d);
      G.add(d);
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
  const scree = (x, z, s, ry, parent) => {
    const grp = new THREE.Group();
    grp.position.set(x, surfaceAt(x, z), z);
    grp.rotation.y = ry;
    // Fracture debris is densest right at the source and thins out fast; an even scatter out to 3 m
    // reads as a gravel field rather than the foot of a crystal.
    for (let i = 0; i < 16; i++) {
      const a = screeRnd() * Math.PI * 2;
      const rad = (0.30 + screeRnd() * 0.42) * s;
      const dx = Math.cos(a) * rad, dz = Math.sin(a) * rad;
      const m = new THREE.Mesh(chipGeo, M.crystalRubble);
      const cs = (0.055 + screeRnd() * 0.10) * s;
      m.position.set(dx, surfaceAt(x + dx, z + dz) - surfaceAt(x, z) - cs * 0.35, dz);
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
  // one rectangle → the discs that hold it, placed in world space
  const lot = (id, cx, cz, w, d, ry = 0) => {
    const cos = Math.cos(ry), sin = Math.sin(ry);
    for (const p of coverDiscs(w, d)) {
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
  // place a model and give it the collision its geometry actually occupies
  const kSolid = (name, x, z, ry, sc = 1, id) => {
    putSolid(name, x, z, S * sc, ry, id);
  };
  const putSolid = (name, x, z, s, ry, id) => {
    put(name, x, z, s, ry);
    const b = footOf(name), cos = Math.cos(ry || 0), sin = Math.sin(ry || 0);
    lot(id || name, x + (b.cx * cos + b.cz * sin) * s, z - (b.cx * sin - b.cz * cos) * s,
        b.w * s, b.d * s, ry || 0);
    return id;
  };
  // A gantry portal is four stanchions carrying a girder. The bay under it is driveable ground, so
  // the collision is the feet and nothing else — a disc on the centre would wall off the very space
  // the portal is built to enclose, and one oversized disc per foot eats 3.2 m of daylight each.
  const GANTRY_FEET = [[-5.6, -1.9], [5.6, -1.9], [-5.6, 1.9], [5.6, 1.9]];
  const portal = (id, x, z, s, ry) => {
    beginProp(id);
    put('gantry_service', x, z, s, ry, 0);
    endProp({ legs: GANTRY_FEET.map(([a, b]) => [a * s, b * s, 1.5, 1.5]), at: [x, z], ry });
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
  const auditPlan = () => {
    const a = audit(colliders.filter(c => c.floor === undefined)
      .map(c => ({ x: c.x, z: c.z, r: c.r, zone: c.zone, prop: c.prop, id: c.prop })));
    return { ...a, discs: colliders.length, lots: lots.length, zones: [...new Set(lots.map(l => l.id.split(':')[0]))] };
  };
  const infoZones = [];
  const sparkPoints = [];
  const beacons = [];
  const lightStrips = [];
  const lightRings = [];
  const showBeamMats = [];
  const teleports = [];
  let showBeams = null;
  let shipGroup = null;

  const zoneY = (zz) => surfaceAt(zz.pos[0], zz.pos[1]);

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
      pave.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
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
    const deckTopY = (o) => deckBox(o).max.y;
    for (const sgn of [-1, 1]) {
      // A raised deck with nothing on it is a modelling leftover, and there were two framing the
      // plaza. `dy` is an offset from terrain height, so carrying the deck's own top through it
      // seats equipment on the platform without a second placement function.
      const cx = hx + sgn * 11, cz = hz + 9;
      beginProp(`service-deck-${sgn > 0 ? 'east' : 'west'}`);
      const pl = k('platform_high', cx, cz, -sgn * 0.6);
      const dy = deckTopY(pl) - surfaceAt(cx, cz);
      put('machine_generator', cx - sgn * 1.4, cz - 1.3, 2.0, 0.35, dy);
      put('desk_computer', cx + sgn * 1.9, cz - 1.5, 1.5, sgn * 2.4, dy);
      put('barrels', cx + sgn * 2.1, cz + 1.6, 1.6, 0.8, dy);
      // A 13 m substation portal shrunk onto a 6 m deck reads as a yellow-topped garden table.
      // What actually lives on a raised service deck is a comms mast and its feeder pillar.
      put('machine_wireless', cx - sgn * 1.7, cz + 1.5, 0.5, -0.4, dy);
      box(0.7, 0.9, 0.5, M.struct, cx - sgn * 2.5, deckTopY(pl) + 0.45, cz + 0.6);
      // The deck is the obstacle; everything standing on it is 2 m above the rover's roof and needs
      // no collider. Measuring the authoring group instead swept the mast's own wide geometry into
      // the footprint and gave a 6 m platform a 16 m solid peanut that swallowed the ring buildings.
      const df = footOf('platform_high');
      endProp({ w: df.w * S, d: df.d * S, x: cx, z: cz });
    }
    // Spaceport Gate 01 spans the south approach, i.e. the first thing in frame at spawn. The Blender
    // `arch` pack wrapped both legs in an emissive cyan skin and hung the name in front of them on a
    // DoubleSide plane, so from the approach it read as a hologram: two glowing poles, a ghost board,
    // and the letters mirrored backwards behind themselves. A gate is the heaviest structure on an
    // airfield, so it is built as one — jointed pylons carrying a box-girder beam with the sign
    // painted on both faces.
    {
      beginProp('spaceport-gate');
      const gx = hx, gz = hz - 13.5;
      const gy = surfaceAt(gx, gz);
      const beamY = gy + 0.78 + 4 * 2.35;
      // One authored asset: jointed precast pylons with their bolt bands, a box girder with
      // chords, verticals, soffit joists and a recessed service panel, a railed catwalk, the
      // lane light channels set into rebates, and the beam-top kit.
      const gate = cloneModel(models.spaceport_gate);
      gate.position.set(gx, gy, gz);
      gate.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
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
      const beaconBulb = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 10), M.beacon);
      beaconBulb.position.set(gx + 9.6, beamY + 6.4, gz);
      G.add(beaconBulb); beacons.push(beaconBulb);
    }
    endProp({ legs: [[hx - 8.1, hz - 13.5, 4.3, 3.6], [hx + 8.1, hz - 13.5, 4.3, 3.6]] });
    // The pack's `rail` is a flat painted panel: edge-on to a moving camera it vanished, face-on it
    // read as a lane stripe trowelled onto the sand. A barrier has three depths of silhouette —
    // kerb, lower tube, top tube — and posts to interrupt it, so it survives every viewpoint.
    const barrier = (bx) => {
      const zs = [], ys = [];
      for (let i = 0; i <= 4; i++) { const z = hz - 21.0 + i * 2.16; zs.push(z); ys.push(surfaceAt(bx, z)); }
      for (let i = 0; i < zs.length; i++) {
        cyl(0.075, 0.095, 1.2, M.white, bx, ys[i] + 0.6, zs[i], 10);
        cyl(0.105, 0.105, 0.15, M.hazard, bx, ys[i] + 1.06, zs[i], 10);
      }
      for (let i = 0; i < zs.length - 1; i++) {
        const z = (zs[i] + zs[i + 1]) * 0.5, y = (ys[i] + ys[i + 1]) * 0.5;
        const len = zs[i + 1] - zs[i];
        // seat each segment on its own two posts rather than the run's chord, or the dune curve
        // floats the kerb in air at one end and buries it at the other
        const tilt = Math.atan2(ys[i] - ys[i + 1], len);
        const kb = box(0.34, 0.30, len, M.struct, bx, y + 0.15, z);
        kb.rotation.x = tilt;
        for (const [h, mat, r] of [[0.62, M.dark, 0.055], [0.98, M.white, 0.05]]) {
          const m = cyl(r, r, len, mat, bx, y + h, z, 8);
          m.rotation.x = Math.PI / 2 + tilt;
        }
      }
    };
    barrier(hx - 5.2); barrier(hx + 5.2);
    // Each barrier is the kerb of its own gate leg, so it carries that leg's collision id: audited
    // as a separate prop it reported a −1.7 m crease with the plinth, and a crease inside one
    // structure is not a trap, it is a corner.
    lot('spaceport-gate#0', hx - 5.2, hz - 16.68, 0.36, 8.7);
    lot('spaceport-gate#1', hx + 5.2, hz - 16.68, 0.36, 8.7);
    // flag mast
    const my = zoneY(ZONES.hub);
    cyl(0.12, 0.16, 7, M.white, hx + 5.5, my + 3.5, hz + 4, 8);
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
      flag.position.set(hx + 6.7, my + 6.35, hz + 4); flag.castShadow = true; flag.receiveShadow = true;
      G.add(flag);
      // halyard rings, so the cloth is attached to something rather than floating beside the pole
      for (const h of [6.98, 6.35, 5.72]) {
        const rr = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.028, 5, 14), M.dark);
        rr.rotation.y = Math.PI / 2;
        rr.position.set(hx + 5.5, my + h, hz + 4);
        rr.castShadow = true;
        G.add(rr);
      }
      cyl(0.05, 0.05, 0.72, M.struct, hx + 5.5, my + 7.32, hz + 4, 8);
      const finial = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 10), M.struct);
      finial.position.set(hx + 5.5, my + 7.74, hz + 4); finial.castShadow = true; G.add(finial);
    }
    k('barrel', hx - 6, hz + 6, 0.4); k('barrel', hx + 7, hz - 5, 1.2);
    putDeck('teleport_pad', hx - 8.5, hz + 11, 1.25, 0, -0.08);
    teleports.push({ key: 'hub', name: ZONES.hub.name, x: hx - 8.5, z: hz + 11 });
    put('astronaut', hx + 3, hz + 6, 1, 2.4, -0.02);   // the Blender EMU: 1.85 m, real metres
    k('craft_speederA', hx + 10, hz + 1, 0.9);
    // A flag mast is a 16 cm pole. Wrapping it in an r=0.8 disc meant the plaza had an invisible
    // metre-wide column nobody could see, in the exact line the player drives to reach the pad.
    lot('flagmast', hx + 5.5, hz + 4, 0.45, 0.45);
    {
      // The plaza was a handful of props on an empty plain: no skyline in any direction, which is
      // most of why the settlement read as small and cheap. A ring of structures gives every
      // sightline a back wall — but it has to obey the block. The old version swept r=22-30, which
      // put buildings in the carriageways on all four sides, and it used 18 slots on that circle:
      // 5.9 m of arc apiece, narrower than any hangar in the pack, so no matter how each disc was
      // drawn they had to overlap. Eight slots on the building line get 13.4 m of arc, and each one
      // is turned long-side to the square so the shallow dimension is the one that runs out at the
      // street. The gate channel stays open so the approach still leads in.
      const FRONT = 18.5;                       // the hub block's building line
      const RING = [
        { n: 'hangar_roundA', k: 0.5, a: 45 },  { n: 'hangar_largeA', k: 0.62, a: 90 },
        { n: 'machine_generatorLarge', k: 0.9, a: 135 }, { n: 'gantry_service', g: 1.0, a: 180 },
        { n: 'satelliteDish', k: 0.9, a: 270 },
        { n: 'machine_wireless', k: 1.1, a: 315 }, { n: 'structure_detailed', k: 0.8, a: 0 },
      ];
      for (const slot of RING) {
        const a = slot.a * Math.PI / 180;
        const s = slot.k !== undefined ? S * slot.k : slot.g;
        const b = footOf(slot.n);
        // Which side of the footprint faces the street is decided by the turn: at ry = a + 90° the
        // pack's local x runs radially, at ry = a it is local z. Every slot is turned so the shallow
        // dimension is the radial one — that is what keeps a deep hangar out of the carriageway.
        const ry = b.w <= b.d ? a + Math.PI / 2 : a;
        const radial = Math.min(b.w, b.d) * s;
        const cos = Math.cos(ry), si = Math.sin(ry);
        // A model's footprint is not centred on its origin, and `lot` knows it; the street test has
        // to read the same discs the physics loop will, or the audit disagrees with the placement.
        const ox = (b.cx * cos + b.cz * si) * s, oz = -(b.cx * si - b.cz * cos) * s;
        let x = hx + Math.cos(a) * (FRONT - radial / 2), z = hz + Math.sin(a) * (FRONT - radial / 2);
        // Two constraints pull opposite ways — the kerb line pushes a building inward, a neighbour
        // it would swallow pushes it outward — so they are resolved one at a time and the slot stops
        // as soon as neither is violated.
        for (let g = 0; g < 8; g++) {
          const ds = discLayout(b.w * s, b.d * s, x + ox, z + oz, ry);
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
          const legal = (nx, nz) => Math.max(...discLayout(b.w * s, b.d * s, nx + ox, nz + oz, ry)
            .map(o => streetEncroach(o.x, o.z, o.r))) <= 0;
          const xo = x + Math.cos(a) * clash, zo = z + Math.sin(a) * clash;
          const xi = x - Math.cos(a) * clash, zi = z - Math.sin(a) * clash;
          if (legal(xo, zo)) { x = xo; z = zo; }
          else if (legal(xi, zi)) { x = xi; z = zi; }
          else break;
        }
        if (slot.n === 'gantry_service') { portal(`ring-gantry-${slot.a}`, x, z, s, ry); continue; }
        if (slot.n === 'gantry_service') { portal(`ring-gantry-${slot.a}`, x, z, s, ry); continue; }
        // An open gantry with nothing standing inside it reads as scaffolding nobody finished; the
        // Blender portal carries its own transformers, switchgear, conductors and signage.
        kSolid(slot.n, x, z, ry, s / S, `ring-${slot.a}`);
      }
      // An ungated lamp ring dropped a post dead-centre in the carriageway, i.e. directly in the
      // rover's path at spawn. Same south exclusion as the structures, plus two lamps squared up on
      // the barrier ends so the approach reads as an avenue rather than a gap in the ring.
      for (let i = 0; i < 10; i++) {
        const a = i / 10 * Math.PI * 2 + 0.31;
        if (Math.hypot(Math.cos(a), Math.sin(a) + 1) < 0.95) continue;
        const lx = hx + Math.cos(a) * 13.8, lz = hz + Math.sin(a) * 13.8;
        // A 5.7 m mast landing 1.8 m off the pad centre grew straight up through the teleport disc
        // and hid the markings from the approach. Fast-travel nodes keep their own clear envelope.
        if (Math.hypot(lx - (hx - 8.5), lz - (hz + 11)) < 5.4) continue;
        put('lamp', lx, lz, 1.25, a, 0);
      }
      for (const sgn of [-1, 1]) {
        put('lamp', hx + sgn * 7.6, hz - 19.5, 1.15, sgn > 0 ? -1.57 : 1.57, 0);
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
    ZONE = 'launch';
    k('platform_high', px, pz, 0, 2.4);               // raised launch deck
    k('platform_low', px + 13, pz + 9, 0.8);
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
      if (!root || /^(starship_stack|crew_rover|optimus_bot|watch_deck|spaceport_gate|hub_plaza|reactor_tap|lox_stand|roadster|crystal|rover|lamp|habitat_dome|greenhouse|cryo_tank|lander|teleport_pad)$/.test(mname)) continue;
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
    // the pad's glow ring
    const py = zoneY(ZONES.launch);
    // A fat neon donut floating 0.35 m over the deck was the most obviously synthetic object on the
    // island, and it threw a hard shadow band across the pad. Real pad lighting is recessed
    // perimeter furniture: a flush guide line and a ring of individual floods.
    const ring = new THREE.Mesh(new THREE.TorusGeometry(9.5, 0.07, 6, 72), M.cyanLight.clone());
    ring.material.color.setHex(0x8fd8e8); ring.material.emissive.setHex(0x2f9fbf);
    heroLights.push(ring.material);   // a clone escapes the deck-lamp registration; put it back
    ring.rotation.x = Math.PI / 2; ring.position.set(px, py + 0.045, pz); G.add(ring);
    lightStrips.push(ring.material);
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * Math.PI * 2;
      const rx = px + Math.sin(a) * 9.5, rz = pz + Math.cos(a) * 9.5;
      box(0.36, 0.12, 0.22, M.dark, rx, py + 0.1, rz, G).rotation.y = a;
      box(0.24, 0.05, 0.14, ring.material, rx, py + 0.18, rz, G).rotation.y = a;
    }

    // ── Starship riding a Super Heavy: 71 m of stainless on the pad ──
    // Authored in Blender at real vehicle scale, so the only fit numbers here are the ones
    // the pad itself has to supply: the deck the mount stands on, and the engine bells that
    // hang three metres below the vehicle's own datum.
    const SHIP_H = 71.4, SHIP_R = 5.1;
    const ship = new THREE.Group();
    const stack = cloneModel(models['starship_stack']);
    stack.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    // On its mount, not in it: the Raptor field is three metres of bell and the pad deck
    // would swallow the whole engine section if the stack sat at grade.
    ship.position.set(px, py + 2.9, pz);
    ship.add(stack);
    const RING_HUES = [0x3fd9ff, 0xff8a3c, 0xa05cff, 0x3fffc9, 0xff4d6d, 0xffd166];
    const ringGeo = new THREE.TorusGeometry(SHIP_R + 0.1, 0.1, 6, 40);
    for (const [i, f] of [0.05, 0.18, 0.33, 0.5, 0.68, 0.88].entries()) {
      const tr = new THREE.Mesh(ringGeo, M.shipLightRing.clone());
      tr.material.color.setHex(RING_HUES[i]); tr.material.emissive.setHex(RING_HUES[i]);
      tr.rotation.x = Math.PI / 2; tr.position.y = f * SHIP_H; tr.visible = false; noMerge(tr); ship.add(tr);
      lightStrips.push(tr.material); lightRings.push(tr);
    }
    G.add(ship); shipGroup = ship;
    lot('starship', px, pz, 9.2, 9.2);

    // ── Chopstick tower, west of the ship: its six arms reach east to the hull
    // and the "RED STARBASE" board on its south face reads from the teleport pad.
    // Blender asset is 20.7 x 6.9 x 54.4 m with the flame trench 2.5 m below datum.
    put('launch_tower', px - 11, pz, 0.55, 0, 1.1);
    // The tower is a 40 m chopstick whose six arms reach out over the vehicle. Its measured box
    // would therefore wall off the whole pad, so the lot is the two rails it actually stands on.
    lot('chopstick-tower', px - 12.5, pz, 6.5, 6.5);
    const towerBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), M.beacon);
    towerBeacon.position.set(px - 11, py + 29.4, pz);
    G.add(towerBeacon); beacons.push(towerBeacon);

    // ── Kenney booster on a service stand, the base's cargo rocket ──
    {
      const bx2 = px - 16, bz2 = pz + 13, by = surfaceAt(bx2, bz2);
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
    // A support frame with nothing standing under it is scaffolding somebody abandoned, so this one
    // is the pad's LOX stand: a cryo drum, a transfer line slung to the flame deck, and a barrel cage.
    {
      const sx = px + 6, sz = pz - 12, sy = surfaceAt(sx, sz);
      // A kit scaffold frame standing over empty ground was the last bare prop on the pad. This is
      // the LOX stand instead: bund, drum, cradle, manifold and a transfer line to the flame deck.
      // One authored stand: a bundled cryo drum on its saddles inside a four-leg cage with a
      // guard ring, its manhole and relief valve, and the transfer line laid — with its clamps
      // and its riser flange — out to the flame deck it feeds.
      put('lox_stand', sx, sz, 1, 0, 0);
      k('barrels', sx - 2.4, sz + 1.6, 0.5);
      lot('lox-stand', sx, sz, 3.5, 3.5);
      sparkPoints.push({ x: sx, y: sy + 2.4, z: sz, rate: 0.22 });
    }
    kSolid('machine_generatorLarge', px - 8, pz - 10, 1.9, 0.35, 'pad-diesel');
    portal('cargo-umbilical', px + 15, pz + 12, 1.0, 2.6);   // umbilical portal for the cargo rocket
    kSolid('barrels', px - 14, pz + 14, 0.7, 0.5, 'pad-drums');

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

  // ══════════ HABITAT — round hangar, domes, corridors, greenhouse ══════════
  {
    const [vx, vz] = ZONES.habitat.pos;
    ZONE = 'habitat';
    // The settlement reads as a place, not a pile, because everything is on the block: the drum
    // backs onto the interior, the dwelling domes and the glasshouse take the two frontages that
    // face the avenue and the north street, and nothing is allowed further out than the building
    // line — which is what used to put dome A's 8.5 m disc three metres into the carriageway.
    // The seated 14.4 m domes used to sit where the corridors and the round hangar drum are;
    // coincident shells z-fight into a torn black blob, so the settlement is spread out.
    // One pressurised structure, not four props touching: the drum and the corridors that bolt onto
    // it are one airtight volume, so they carry one collision id and the audit stops reporting the
    // joints between them as creases the rover could get stuck in.
    kSolid('hangar_roundA', vx - 7, vz - 5, 0.5, 1.3, 'hab-module');   // the big living drum
    putSolid('habitat_dome', vx + 13, vz + 15, 1.1, 0.6, 'dome-a');   // seated 14.4 x 12.3 x 10.3 m
    putSolid('habitat_dome', vx - 5, vz + 18, 0.85, 2.3, 'dome-b');
    putSolid('greenhouse', vx - 17, vz + 5, 1.25, -0.5, 'glasshouse');  // 13.7 x 12.0 x 5.0 m
    // pressurised corridors linking drum → domes → greenhouse
    kSolid('corridor', vx + 3, vz + 3, 0.62, 1.0, 'hab-module');
    kSolid('corridor_corner', vx + 9, vz + 11, 1.35, 1.0, 'hab-module');
    kSolid('corridor_end', vx - 8, vz + 9, 0.9, 1.0, 'hab-module');
    // front step, awning planters, life
    k('stairs', vx + 11, vz - 10, 0.1);
    k('barrel', vx - 2, vz - 8, 1.1);
    put('astronaut', vx + 7, vz + 15, 1, -0.9, -0.02);
    k('alien', vx - 13, vz + 14, 2.1);
    putDeck('teleport_pad', vx + 15, vz - 6, 1.05, 0, -0.08);
    teleports.push({ key: 'habitat', name: ZONES.habitat.name, x: vx + 15, z: vz - 6 });
    const vy = zoneY(ZONES.habitat);
    beacons.push(cyl(0.35, 0.35, 0.5, M.beacon, vx - 7, vy + 8.3, vz - 5, 10));   // seated on the hangar drum
    infoZones.push({
      key: 'habitat', pos: [vx, vz], r: 26, tag: 'SETTLEMENT · MODULE A-D',
      name: '火星生活舱区', params: ['加压体积 4×920 m³ · 气闸 ×2', '温室穹顶生物量 ~2.1 t', '住 here 的有 24 名工程师与植物学家'],
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
      sparkPoints.push({ x: tx, y: surfaceAt(tx, tz) + 1.8, z: tz - 1.6, rate: 0.45 + i * 0.1 });
    }
    // pipe rack from tanks toward the fab
    for (let i = 0; i < 2; i++) {
      k('pipe_straight', ix + 10 - 6 * i, iz - 4 + 6 * i, 0.75, 0.9 + i * 0.1);
    }
    k('pipe_corner', ix + 6, iz - 10, 0.4);
    kSolid('barrels', ix - 13, iz + 6, 2.0, 1.1, 'drum-crate');   // crate of drums by the rail
    k('rover', ix - 1, iz + 3, 1.8);                   // parked work rover
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
    const my2 = surfaceAt(mx, mz);
    kSolid('machine_generator', mx, mz + 2.5, 1.4, 0.8, 'valve-housing');   // the valve housing
    k('pipe_straight', mx - 5, mz - 1.5, 0.2);
    k('pipe_corner', mx + 4.5, mz - 2.5, 2.4);
    // hazard ring + red beacon on a hooded mast
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * Math.PI * 2;
      cyl(0.07, 0.07, 0.9, M.orange, mx + Math.cos(a) * 5.4, my2 + 0.45, mz + Math.sin(a) * 5.4, 6);
    }
    cyl(0.09, 0.09, 1.6, M.struct, mx - 3.4, my2 + 0.8, mz - 3.4, 8);
    beacons.push(cyl(0.4, 0.4, 0.6, M.beacon, mx - 3.4, my2 + 1.85, mz - 3.4, 10));
    box(0.9, 0.12, 0.9, M.struct, mx - 3.4, my2 + 2.35, mz - 3.4);
    // warning board facing the approach road
    const board = new THREE.Group();
    board.position.set(mx + 0.5, my2 + 1.5, mz + 5.6);
    board.rotation.y = Math.atan2(mx - 20 - (mx + 0.5), mz - 6 - (mz + 5.6));
    box(2.4, 1.1, 0.1, M.dark, 0, 0, 0, board);
    box(2.0, 0.5, 0.06, M.hazard, 0, 0.05, 0.09, board);
    G.add(board);
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
    kSolid('machine_wireless', cx2 - 12, cz2 + 4, 0.5, 1.1, 'array-mast');
    portal('array-feed', cx2 + 17, cz2 - 3, 0.78, 0.9);   // array feed portal, clear of the dish rim
    kSolid('hangar_smallA', cx2 - 12, cz2 + 14, 2.4, 0.9, 'listening-post');
    k('desk_computer', cx2 - 6, cz2 + 8, 1.9);              // outdoor console on the low deck
    k('rail', cx2 - 3, cz2 + 10, 0.35);
    put('astronaut', cx2 - 4, cz2 + 7, 1, 2.6, -0.02);       // whoever is on shift, listening to Earth
    putDeck('teleport_pad', cx2 - 9, cz2 - 8, 1.0, 0, -0.08);
    teleports.push({ key: 'comms', name: ZONES.comms.name, x: cx2 - 9, z: cz2 - 8 });
    const cy = zoneY(ZONES.comms);
    beacons.push(cyl(0.3, 0.3, 0.45, M.beacon, cx2 + 3.6, cy + 4.4, cz2 - 1.5, 10));  // on the big dish's rim
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
    lot('anomaly-07', sx - 2, sz - 3, 4.4, 4.4);
    for (const [dx, dz, cs] of [[7, 4, 1.05], [-9, 5, 0.8], [3, 9, 0.62], [-5, -9, 0.9]]) {
      const c = seat(put('crystal', sx + dx, sz + dz, cs, dx * dz, cs * 0.34), 0.22);
      c.traverse(o => { if (o.isMesh) o.material = M.crystal; });
      scree(sx + dx, sz + dz, cs * 2.0, dx + dz);
      lot(`shard-${dx}${dz}`, sx + dx, sz + dz, cs * 1.7, cs * 1.7);
    }
    k('desk_computer', sx + 9, sz - 4, 2.2);
    k('craft_speederA', sx - 11, sz - 2, 1.1, 0.8);
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
    const cradle = putDeck('platform_low', mx - 0.6, mz - 5.2, 1.4, Math.PI / 2, -0.1);
    const cradleTop = new THREE.Box3().setFromObject(cradle).max.y;
    portal('rover-bay', mx - 0.6, mz - 5.2, 0.92, Math.PI / 2);
    const pit = (x, z) => rimY(x, z, 1.6);

    // ── the crew rover, parked nose-out on its stand so the cupola clears the girder ──
    const rover = cloneModel(models.crew_rover);
    const ry0 = Math.PI / 2;
    rover.position.set(mx - 0.6, cradleTop + 0.02, mz - 5.2);
    rover.rotation.y = ry0;
    rover.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    G.add(rover);
    // (w, d) are the footprint in the model's own axes and the rover is long along local X, so
    // passing them the other way round strung the two cover discs across the hull instead of
    // along it — a collider standing sideways through a 4.1 m vehicle, and a nose-in pin at each
    // end of it.
    lot('crew-rover', mx - 0.6, mz - 5.2, 4.1, 2.44, ry0);
    // the stand it docks on: a low cradle the rover's rockers sit in, so it reads parked, not fallen
    for (const dx of [-1.2, 1.2])
      box(0.5, 0.16, 2.5, M.dark, mx - 0.6 + dx, cradleTop + 0.08, mz - 5.2).rotation.y = ry0;

    // ── two Optimus on the apron: one checking the airlock, one waiting at the mast ──
    for (const [i, [bx, bz, turn]] of [[mx - 3.9, mz - 3.4, 2.3], [mx + 4.2, mz + 1.6, -1.1]].entries()) {
      const bot = cloneModel(models.optimus_bot);
      bot.position.set(bx, pit(bx, bz), bz);
      bot.rotation.y = turn;
      bot.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      G.add(bot);
      lot(`optimus-0${i + 1}`, bx, bz, 0.62, 0.62);
      // a robot on bare regolith leaves no story; the boot scuff ring and its charge lead do
      cyl(0.42, 0.46, 0.04, M.concrete, bx, pit(bx, bz) + 0.02, bz, 20);
      sparkPoints.push({ x: bx, y: pit(bx, bz) + 0.9, z: bz - 0.2, rate: 0.12 });
    }

    // ── the pit: mast, workbench, drums and the second vehicle that still runs on wheels ──
    kSolid('machine_wireless', mx + 6.5, mz - 2.5, 0, 1.15, 'charge-mast');
    kSolid('desk_computer', mx + 1.6, mz + 6.8, 0.6, 1.5, 'pit-desk');
    kSolid('barrels', mx + 5.6, mz + 4.2, 1.2, 1.3, 'lubricant-drums');
    k('craft_speederA', mx - 6.4, mz + 1.4, 1.1, 1.35);
    lot('utility-speeder', mx - 6.4, mz + 1.4, 2.2, 3.4, 1.1);
    k('rail', mx - 8.5, mz + 5.5, 0.4, 1.2);
    for (const [dx, dz] of [[-2.5, 0.5], [-1, 1.5], [0.5, 2.5]]) {
      const cx2 = mx + dx, cz2 = mz + dz;
      cyl(0.05, 0.26, 0.42, M.hazard, cx2, pit(cx2, cz2) + 0.21, cz2, 12);
      cyl(0.3, 0.32, 0.04, M.dark, cx2, pit(cx2, cz2) + 0.02, cz2, 12);
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
      return surfaceAt(wx + Math.cos(a) * rr, wz + Math.sin(a) * rr);
    }));
    const deckTop = wy + 0.5;
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
    deck.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    G.add(deck);

    // seats facing the pad + telemetry board angled back at the crowd
    k('stairs', wx - 3.5, wz + 2, -2.24, 0.9);
    const boardX = wx + Math.sin(back - 1.28) * 5.4, boardZ = wz + Math.cos(back - 1.28) * 5.4;
    const board = new THREE.Group(); board.position.set(boardX, deckTop + 2.55, boardZ);
    board.rotation.y = Math.atan2(wx - boardX, wz - boardZ);
    box(3.6, 2.0, 0.18, M.dark, 0, 0, 0, board);
    // An emissive rectangle of pure yellow was the second-brightest thing in the plaza and said
    // nothing. A flight-display board shows the flight: ascent arc, countdown, telemetry bars.
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
    screenMesh.position.set(0, 0.05, 0.115); board.add(screenMesh);
    box(3.86, 0.16, 0.3, M.struct, 0, 1.08, 0, board);
    box(0.26, 2.6, 0.26, M.struct, 0, -1.6, 0, board);
    box(1.1, 0.12, 0.9, M.dark, 0, -2.86, 0, board);
    box(0.16, 0.5, 0.16, M.cyanLight, 1.85, -1.0, 0.1, board);
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
    const ny = surfaceAt(nx, nz);
    putSolid('habitat_dome', nx + 6, nz - 4, 0.7, 1.7, 'dome');
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * 2.6 + 2.4;
      const lx = nx + Math.cos(a) * 9, lz = nz + Math.sin(a) * 9;
      put('lamp', lx, lz, 1.3, a, 0);
    }
    cyl(0.3, 0.45, 1.8, M.struct, nx - 7, ny + 0.9, nz - 6, 10);
    const scope = cyl(0.45, 0.62, 2.8, M.white, nx - 7, ny + 2.8, nz - 6, 12);
    // The merge pass bakes shared-material meshes into batches and removes the originals, which
    // would orphan this scope's lens child along with it (AF1 forensics: the lens simply vanished).
    noMerge(scope);
    scope.rotation.x = -0.7;
    // The muzzle otherwise draws as a flat sunlit beige disc — a matte black lens must sit ON TOP
    // of the cylinder's own opaque cap (recessing below it hides nothing, and a metallic lens
    // mirrors the noon sun — AC1/AD1 forensics).
    scope.add(cyl(0.43, 0.43, 0.06, new THREE.MeshStandardMaterial({ color: 0x101216, roughness: 0.85, metalness: 0.05 }), 0, 1.43, 0, 12));
    // A 1.2 m pier on a tripod does not need the r=1.6 armour it used to wear — that was a 3.2 m
    // invisible drum around a 0.9 m column, on a hill the player walks around to find the scope.
    lot('telescope', nx - 7, nz - 6, 1.0, 1.0);
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
    const wy2 = surfaceAt(yx, yz);
    wreckPos = new THREE.Vector3(yx, wy2, yz);
    const w = put('lander', yx, yz, 1.15, 0.6, 0.45);
    w.rotation.z = 1.45; w.rotation.x = 0.25;         // down on its side
    lot('dawn7', yx, yz, 10, 10);
    k('barrel', yx + 9, yz + 4, 1.9);
    k('barrel', yx + 11, yz + 1, -0.4);
    k('craft_speederA', yx - 8, yz + 8, 0.9, 0.7);    // the rescue craft that found it
    lot('rescue-speeder', yx - 8, yz + 8, 3.4, 2.2, 0.7);
    for (let i = 0; i < 5; i++) {
      const a = i * 1.7;
      k('terrain_roadStraight', yx - 14 + Math.cos(a) * (i * 3.5), yz - 6 + Math.sin(a) * (i * 2.8), a, 0.7); // scorch debris strip
    }
    cyl(0.25, 0.3, 6, M.struct, yx - 8, wy2 + 3, yz - 7, 8);
    beacons.push(cyl(0.55, 0.55, 0.9, M.beacon, yx - 8, wy2 + 6.4, yz - 7, 10));
    infoZones.push({
      key: 'storm', pos: [yx, yz], r: 24, tag: 'HAZARD ZONE · AEOLIS FIELD',
      name: '残骸场 · 货运飞船“黎明号”', params: ['上次事件：全球性沙尘暴 Sol 388', '太阳能板蒙尘之后，机遇号也这样安静下来'],
      fact: '火星的沙尘暴可以持续数月、覆盖整个星球。驶近时按 N 到午夜再来看它，灯笼会替你先亮着。',
    });
  }

  // ══════════ ROADSTER easter egg ══════════
  {
    const [rx, rz] = ZONES.roadster.pos;
    const ry = surfaceAt(rx, rz);
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

  // ══════════ SAMPLES — six glowing crystals around the island ══════════
  const samples = [];
  {
    const rand = mulberry32(1234);
    const anchors = [[86, 60], [-80, 66], [95, -30], [-30, 95], [35, -92], [-90, -35]];
    for (const [ax2, az2] of anchors) {
      const x = ax2 + (rand() - 0.5) * 14, z = az2 + (rand() - 0.5) * 14;
      const y = surfaceAt(x, z);
      const g4 = new THREE.Group(); g4.position.set(x, y, z);
      const c = cloneModel(models['crystal']);
      templateRoots.add(c);
      c.scale.setScalar(0.6 + rand() * 0.35);
      seat(c, 0.1);
      c.traverse(o => { if (o.isMesh) o.material = M.crystal; });
      noMerge(c); g4.add(c);
      scree(x, z, c.scale.x * 1.9, rand() * 6.28);
      // No light column: a beam riding on top of a rock is the one cue that says "video-game
      // pickup". The mineral's own glow plus the ground ring carry it, and the map does the rest.
      const pad2 = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.42, 28),
        new THREE.MeshBasicMaterial({ color: 0x8fdccf, transparent: true, opacity: 0.10, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      pad2.rotation.x = -Math.PI / 2; pad2.position.y = 0.07; g4.add(pad2);
      G.add(g4);
      samples.push({ group: g4, crystal: c, x, z, taken: false });
    }
    infoZones.push({
      key: 'samples', pos: [0, 0], r: 9999, tag: 'FIELD SCIENCE',
      name: '火星矿物样本', params: ['撞击玻璃 / 层状硅酸盐 / 橄榄石', '驾驶驶近即可自动采集', `集齐 ${SAMPLE_COUNT} 块解锁发射窗口`],
      fact: '每块岩石都是一页未读的书。',
    });
  }

  // ══════════ ROAD SETTING — lamps + centerline tiles on the street grid ══════════
  {
    // The road used to be painted along hand-picked zone-to-zone lines, which is why the carriageway
    // you could see did not match the carriageway the terrain shader flattened. Now the same STREETS
    // list that height.js compacts and plan.js audits is what gets tiled and lit.
    const TILE = S * 1.7;                       // one kit road tile laid across the lane
    for (const s of STREETS) {
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1], l = Math.hypot(dx, dz);
      const yaw = Math.atan2(dx, dz);
      const n = Math.round(l / TILE);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = s.a[0] + dx * t, z = s.a[1] + dz * t;
        k('terrain_roadStraight', x, z, yaw, 1.7);
        if (i % 3 === 1) {
          // lamps stand on the shoulder, clear of the trafficable width but inside the setback
          const ox = dz / l * 8.2, oz = -dx / l * 8.2;
          const side = (i % 6 < 3) ? 1 : -1;
          put('lamp', x + ox * side, z + oz * side, 1.05, yaw + (side > 0 ? Math.PI / 2 : -Math.PI / 2), 0);
        }
      }
    }
    // The kit's road is a pale peach ribbon with a large tile texture on it. Under a peach sky it had
    // no value separation from the dunes, and laid across the dark sintered deck it read as bathroom
    // tiling — the single brightest thing in every driving frame. A service road is compacted
    // regolith asphalt: darker than the pad it crosses, and matte enough to stop catching the dome.
    models.terrain_roadStraight?.traverse(o => {
      for (const mt of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
        mt.color?.setRGB(0.198, 0.172, 0.152);
        mt.roughness = 0.9; mt.metalness = 0.03;
      }
    });
  }

  G.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

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
    // A tap has to stand beside its pad, out of the carriageway, and clear of everything the
    // district already owns. It used to wear a hand-typed 4.4 m offset, which in the habitat put
    // the rig four metres inside a hangar. So it asks the plan for a free lot instead.
    const siteFor = (px, pz, away, w, d) => {
      const legal = [], best = [];
      for (const rr of [3.9, 5.0, 6.3, 7.8, 9.5, 11.5]) {
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
      const site = siteFor(tp.x, tp.z, Math.atan2(tp.x / rad, tp.z / rad), 2.6, 2.6);
      const rx = site.x, rz = site.z;
      const rig = new THREE.Group();
      rig.position.set(rx, rimY(rx, rz, 2.05) - 0.06, rz);
      rig.rotation.y = Math.atan2(tp.x - rx, tp.z - rz);
      G.add(rig);

      // ── the tap has to read as a substation you can drive up to and recognise from 100 m:
      // bolted octagonal footing, finned transformer drum, porcelain bushings, a braced
      // lattice mast and a service deck with its cage. One authored asset, cloned to each pad.
      const tap = cloneModel(models.reactor_tap);
      tap.position.copy(rig.position);
      tap.rotation.y = rig.rotation.y;
      tap.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      templateRoots.add(tap);          // already baked as a template; re-merging would copy it
      G.add(tap);
      // cable run back to the pad so the two read as one installation — the ground falls away
      // between the two bases, so each anchor has to be sampled where it actually lands
      for (let i = 1; i <= 4; i++) {
        const lz = -1.6 - (i / 5) * 2.0;
        const wx = rx + Math.sin(rig.rotation.y) * lz, wz = rz + Math.cos(rig.rotation.y) * lz;
        box(0.11, 0.13, 0.11, soot, 0, surfaceAt(wx, wz) + 0.06 - (rig.position.y), lz, rig);
      }

      const coreMat = new THREE.MeshStandardMaterial({ color: 0x101a1f, emissive: 0x4fe2ff, emissiveIntensity: 0, roughness: 0.2, metalness: 0.1 });
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.62, 0), coreMat);
      core.position.y = 5.85; core.castShadow = true; noMerge(core); rig.add(core);
      const plateMat = new THREE.MeshBasicMaterial({ color: 0x4fe2ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const plate = new THREE.Mesh(new THREE.CircleGeometry(1.35, 6), plateMat);
      plate.rotation.x = -Math.PI / 2; plate.position.y = 0.42; rig.add(plate);
      const beamMat = new THREE.MeshBasicMaterial({ color: 0x6fe8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      // a shaft you navigate by at night, not a pole — shallow flare, and it dies away in daylight
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 0.14, 15, 6, 1, true), beamMat);
      beam.position.y = core.position.y + 7.5; rig.add(beam);
      // the additive halo meshes must not cast — a shadow-casting light shaft reads as a solid pole
      for (const o of rig.children) if (o !== beam && o !== plate) { o.castShadow = true; o.receiveShadow = true; }

      gridRigs.push({ key: tp.key, name: tp.name, tp, x: rx, z: rz, power: 0, shown: -1, core, beam, plate, mats: [coreMat, plateMat, beamMat] });
      // The tap plate is 1.35 m across; the r=2.2 drum it used to wear was wide enough to keep the
      // rover out of the very stand it had to park in.
      lot('grid-rig', rx, rz, 2.6, 2.6);
    }
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
    group: G, colliders, infoZones, samples, sparkPoints, beacons, lightStrips, lightRings, showBeams, showBeamMats, shipGroup, teleports, padGlow, heroLights, occluders, gridRigs, crystalMat: M.crystal,
    plan: auditPlan, lots,
    leakPoint: new THREE.Vector3(LEAK_POS[0], surfaceAt(LEAK_POS[0], LEAK_POS[1]) + 1.8, LEAK_POS[1]),
    flamePoint,
    launchPadPos: new THREE.Vector3(...ZONES.launch.pos),
    wreckPos,
    watchPos: new THREE.Vector3(ZONES.watch.pos[0], surfaceAt(...ZONES.watch.pos), ZONES.watch.pos[1]),
  };
}
