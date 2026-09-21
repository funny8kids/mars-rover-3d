import * as THREE from 'three';
import { surfaceAt } from './height.js';
import { ZONES, SHIP_POS, LEAK_POS, SAMPLE_COUNT } from '../config.js';
import { mulberry32, vnoise } from '../utils/noise.js';
import { loadModel, cloneModel, cloneMaterials } from './assets.js';
import { mergeInto, noMerge } from './merge.js';
import { applySurfaceDetail } from './surface_detail.js';

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
  const HERO = ['habitat_dome', 'greenhouse', 'launch_tower', 'starship', 'cryo_tank',
    'lamp', 'crystal', 'lander', 'teleport_pad', 'gantry_service'];
  const KENNEY = ['hangar_roundA', 'hangar_largeA', 'hangar_smallA', 'corridor', 'corridor_corner',
    'corridor_end', 'platform_high', 'platform_low', 'platform_large', 'machine_generator',
    'machine_generatorLarge', 'machine_wireless', 'structure', 'structure_detailed', 'pipe_straight',
    'pipe_corner', 'satelliteDish', 'satelliteDish_detailed', 'rocket_baseB', 'rocket_finsA',
    'rover',
    'rocket_fuelA', 'rocket_sidesA', 'rocket_topA', 'barrels', 'barrel', 'craft_speederA',
    'astronautA', 'alien', 'desk_computer', 'terrain_roadStraight', 'rail', 'stairs',
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
  const LANDMARKS = new Set(['habitat_dome', 'starship', 'lander']);
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
    G.add(o); return o;
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
    (parent || G).add(grp); return grp;
  };
  const box = (w, h, d, mat, x, y, z, parent) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    (parent || G).add(m); return m;
  };
  const cyl = (rt, rb, h, mat, x, y, z, seg = 18, parent) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    (parent || G).add(m); return m;
  };
  const colliders = [];
  const infoZones = [];
  const sparkPoints = [];
  const beacons = [];
  const lightStrips = [];
  const lightRings = [];
  const showBeamMats = [];
  const teleports = [];
  let showBeams = null;
  const shipMats = [];
  let shipGroup = null;

  const zoneY = (zz) => surfaceAt(zz.pos[0], zz.pos[1]);

  // ══════════ HUB — plaza, arch gate, flagpole, teleport ══════════
  {
    const [hx, hz] = ZONES.hub.pos;
    const deckBox = (o) => { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o); };
    {
      // A 24 m blank slab in the middle of the player's arrival shot was the loudest "nothing has
      // been modelled here" in the base. A plaza is paved: inset panels with shadowed seams, a
      // landing disc, a hazard ring and flush studs that light up at night.
      const bb = deckBox(k('platform_large', hx, hz, 0, 1.9));
      const top = bb.max.y, x0 = bb.min.x + 0.55, x1 = bb.max.x - 0.55;
      const z0 = bb.min.z + 0.55, z1 = bb.max.z - 0.55;
      const nx = 6, nz = 6, cw = (x1 - x0) / nx, cd = (z1 - z0) / nz;
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const edge = i === 0 || j === 0 || i === nx - 1 || j === nz - 1;
        box(cw - 0.3, 0.075, cd - 0.3, edge ? M.struct : M.dark,
          x0 + (i + 0.5) * cw, top + 0.038, z0 + (j + 0.5) * cd);
      }
      cyl(3.5, 3.5, 0.1, M.concrete, hx, top + 0.05, hz, 44);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(4.0, 0.15, 6, 48), M.hazard);
      ring.rotation.x = Math.PI / 2; ring.position.set(hx, top + 0.11, hz);
      ring.castShadow = ring.receiveShadow = true; G.add(ring);
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
        disc.position.set(hx, top + 0.108, hz);
        noMerge(disc);
        G.add(disc);
      }
      for (let i = 0; i < 12; i++) {
        const a = i / 12 * Math.PI * 2 + 0.26;
        // Flush markers, not pucks: a 6 cm proud cylinder threw its own shadow at noon and, with
        // the cyan emissive, every stud read as a candy disc dropped on the plaza. Real apron
        // lighting is a lens set level with the deck.
        cyl(0.15, 0.15, 0.05, M.cyanLight, hx + Math.cos(a) * (cw * 2.7), top + 0.026,
          hz + Math.sin(a) * (cd * 2.7), 10);
      }
    }
    const deckTopY = (o) => deckBox(o).max.y;
    for (const [pl, sgn] of [[k('platform_high', hx - 11, hz + 9, 0.6), -1],
                             [k('platform_high', hx + 11, hz + 9, -0.6), 1]]) {
      // A raised deck with nothing on it is a modelling leftover, and there were two framing the
      // plaza. `dy` is an offset from terrain height, so carrying the deck's own top through it
      // seats equipment on the platform without a second placement function.
      const dy = deckTopY(pl) - surfaceAt(pl.position.x, pl.position.z);
      const cx = pl.position.x, cz = pl.position.z;
      put('machine_generator', cx - sgn * 1.4, cz - 1.3, 2.0, 0.35, dy);
      put('desk_computer', cx + sgn * 1.9, cz - 1.5, 1.5, sgn * 2.4, dy);
      put('barrels', cx + sgn * 2.1, cz + 1.6, 1.6, 0.8, dy);
      // A 13 m substation portal shrunk onto a 6 m deck reads as a yellow-topped garden table.
      // What actually lives on a raised service deck is a comms mast and its feeder pillar.
      put('machine_wireless', cx - sgn * 1.7, cz + 1.5, 0.5, -0.4, dy);
      box(0.7, 0.9, 0.5, M.struct, cx - sgn * 2.5, deckTopY(pl) + 0.45, cz + 0.6);
      colliders.push({ x: cx, z: cz, r: 3.4 });
    }
    // Spaceport Gate 01 spans the south approach, i.e. the first thing in frame at spawn. The Blender
    // `arch` pack wrapped both legs in an emissive cyan skin and hung the name in front of them on a
    // DoubleSide plane, so from the approach it read as a hologram: two glowing poles, a ghost board,
    // and the letters mirrored backwards behind themselves. A gate is the heaviest structure on an
    // airfield, so it is built as one — jointed pylons carrying a box-girder beam with the sign
    // painted on both faces.
    {
      const gx = hx, gz = hz - 13.5, gy = surfaceAt(gx, gz);
      const legX = (sgn) => gx + sgn * 8.1;
      const shaftH = 2.35, shaftN = 4, baseY = gy + 0.78;
      const beamY = baseY + shaftN * shaftH;
      for (const sgn of [-1, 1]) {
        const x = legX(sgn);
        box(4.0, 0.78, 3.3, M.struct, x, gy + 0.39, gz);
        box(4.3, 0.2, 3.6, M.dark, x, gy + 0.1, gz);          // kerb lip, so the plinth isn't floating
        for (let i = 0; i < shaftN; i++) {
          const w = 2.9 - i * 0.22, d = 2.5 - i * 0.16;
          const y = baseY + i * shaftH + shaftH / 2;
          box(w, shaftH - 0.14, d, M.concrete, x, y, gz);
          if (i < shaftN - 1) box(w + 0.16, 0.15, d + 0.16, M.struct, x, y + shaftH / 2, gz);
        }
        box(2.2, 0.34, 2.0, M.dark, x, beamY - 0.17, gz);      // bearing pad under the beam
        // Lane-facing light channel: a recessed strip, not a skin. The old arch lit the whole leg.
        box(0.14, shaftN * shaftH - 1.1, 0.42, M.cyanLight, x - sgn * (1.32), baseY + (shaftN * shaftH) / 2 - 0.2, gz);
        for (let i = 0; i < 4; i++) {
          box(0.3, 0.16, 0.5, M.struct, x - sgn * 1.3, baseY + 0.9 + i * 2.0, gz + 0.0);
        }
        cyl(0.13, 0.13, shaftN * shaftH + 0.4, M.struct, x + sgn * 1.35, baseY + (shaftN * shaftH) / 2, gz + 0.95, 8);
        for (const t of [0.6, 3.1, 5.6, 8.1]) {
          cyl(0.21, 0.21, 0.18, M.dark, x + sgn * 1.35, baseY + t, gz + 0.95, 8);
        }
        for (let i = 0; i < 3; i++) {                          // hazard chevrons on the kerb side
          const c = box(0.5, 0.62, 0.1, i % 2 ? M.hazard : M.orange, x - sgn * 1.9, gy + 0.42, gz - 1.83);
          c.rotation.z = 0.62;
        }
      }
      // Box-girder beam: two chords with verticals front and back, so it has depth and shadow instead
      // of reading as a painted slab.
      box(20.9, 0.44, 2.0, M.struct, gx, beamY + 0.22, gz);
      box(20.9, 0.44, 2.0, M.struct, gx, beamY + 2.44, gz);
      for (let i = 0; i <= 8; i++) {
        const px = gx - 9.8 + i * 2.45;
        for (const sgn of [-1, 1]) box(0.28, 1.78, 0.34, M.struct, px, beamY + 1.33, gz + sgn * 0.82);
      }
      box(21.2, 0.18, 2.5, M.struct, gx, beamY + 2.75, gz);    // top deck plate
      // A driver passes under this beam, so the soffit is the face that is actually seen. Left as
      // an open girder it read as a blank white board hanging in the sky; joisted, panelled and
      // wired it reads as the underside of an airfield gantry.
      for (let i = 0; i <= 9; i++) {
        const px = gx - 10.0 + i * 2.22;
        box(0.20, 0.46, 2.34, M.struct, px, beamY + 2.44, gz);
      }
      box(20.4, 0.10, 1.55, M.dark, gx, beamY + 2.20, gz);      // recessed service panel
      for (const sgn of [-1, 1]) {
        cyl(0.07, 0.07, 20.4, M.struct, gx, beamY + 2.32, gz + sgn * 0.95, 6).rotation.z = Math.PI / 2;
      }
      for (let i = 0; i <= 6; i++) {                            // downlights over the lane
        const px = gx - 9.1 + i * 3.04;
        cyl(0.17, 0.21, 0.16, M.dark, px, beamY + 2.10, gz, 10);
        cyl(0.15, 0.15, 0.03, M.goldLight, px, beamY + 2.01, gz, 10);
      }
      for (let i = 0; i <= 10; i++) {                          // catwalk railing
        const px = gx - 10.4 + i * 2.08;
        cyl(0.06, 0.06, 1.05, M.dark, px, beamY + 3.36, gz + 1.12, 6);
        cyl(0.06, 0.06, 1.05, M.dark, px, beamY + 3.36, gz - 1.12, 6);
      }
      for (const sgn of [-1, 1]) {
        cyl(0.055, 0.055, 20.9, M.dark, gx, beamY + 3.83, gz + sgn * 1.12, 6).rotation.z = Math.PI / 2;
        cyl(0.055, 0.055, 20.9, M.dark, gx, beamY + 3.28, gz + sgn * 1.12, 6).rotation.z = Math.PI / 2;
      }
      {
        // Sign faces are painted on a canvas and mounted on both sides of the beam, each single-sided,
        // so the name is legible from the approach and from the plaza — never mirrored.
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
          box(13.4, 2.7, 0.3, M.dark, gx, beamY + 1.4, gz + sgn * 1.15);
          const p = new THREE.Mesh(new THREE.PlaneGeometry(12.6, 1.86), face);
          p.position.set(gx, beamY + 1.4, gz + sgn * 1.32);
          p.rotation.y = sgn > 0 ? 0 : Math.PI;
          p.castShadow = false; p.receiveShadow = true; G.add(p);
          for (const bx of [-6.2, 6.2]) cyl(0.09, 0.09, 0.34, M.struct, gx + bx, beamY + 1.4, gz + sgn * 1.4, 8).rotation.x = Math.PI / 2;
        }
      }
      for (const [bx, bw] of [[gx - 6.4, 3.4], [gx + 6.6, 2.2]]) {   // beam-top equipment
        box(bw, 1.3, 1.9, M.white, bx, beamY + 3.5, gz);
        box(bw + 0.18, 0.16, 2.1, M.struct, bx, beamY + 2.86, gz);
        box(0.14, 1.32, 1.94, M.orange, bx, beamY + 3.5, gz);
      }
      cyl(0.09, 0.12, 3.4, M.dark, gx + 9.6, beamY + 4.6, gz, 8);
      beacons.push(cyl(0.2, 0.2, 0.42, M.beacon, gx + 9.6, beamY + 6.4, gz, 8));
      for (let i = 0; i < 4; i++) {                            // approach floodlights under the beam
        const fx = gx - 6.3 + i * 4.2;
        const h = box(0.62, 0.44, 0.86, M.dark, fx, beamY - 0.24, gz);
        h.rotation.x = 0.5;
        const l = cyl(0.24, 0.24, 0.08, M.goldLight, fx, beamY - 0.42, gz - 0.22, 10);
        l.rotation.x = Math.PI / 2 + 0.5;
      }
    }
    colliders.push({ x: hx - 8.1, z: hz - 13.5, r: 2.5 }, { x: hx + 8.1, z: hz - 13.5, r: 2.5 });
    // The pack's `rail` is a flat painted panel: edge-on to a moving camera it vanished, face-on it
    // read as a lane stripe trowelled onto the sand. A barrier has three depths of silhouette —
    // kerb, lower tube, top tube — and posts to interrupt it, so it survives every viewpoint.
    const barrier = (bx) => {
      const zs = [], ys = [];
      for (let i = 0; i <= 5; i++) { const z = hz - 23.0 + i * 2.16; zs.push(z); ys.push(surfaceAt(bx, z)); }
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
    k('astronautA', hx + 3, hz + 6, 2.4);
    k('craft_speederA', hx + 10, hz + 1, 0.9);
    colliders.push({ x: hx + 5.5, z: hz + 4, r: 0.8 });
    {
      // The plaza was a handful of props on an empty plain: no skyline in any direction, which is
      // most of why the settlement read as small and cheap. A service ring at r≈22 gives every
      // sightline a back wall. The south gate channel stays open so the approach still leads in.
      const RING = [
        ['hangar_smallA', 1.05], ['gantry_service', 0.95], ['satelliteDish_detailed', 0.9],
        ['machine_generatorLarge', 0.9], ['hangar_roundA', 0.55], ['machine_wireless', 1.0],
        ['satelliteDish', 0.95], ['gantry_service', 1.0], ['gantry_service', 0.95], ['hangar_largeA', 0.42],
      ];
      const rnd = mulberry32(0x5eed1);
      // An open gantry with nothing standing inside it reads as scaffolding nobody finished, and
      // there were six of them framing the plaza. The Blender portal carries its own transformers,
      // switchgear, conductors and signage, so it needs no cargo.
      for (let i = 0; i < 18; i++) {
        const a = i / 18 * Math.PI * 2 + 0.17;
        if (Math.hypot(Math.cos(a), Math.sin(a) + 1) < 0.8) continue;   // gate approach
        const [name, sc] = RING[i % RING.length];
        const r = 22 + rnd() * 8;
        const x = hx + Math.cos(a) * r, z = hz + Math.sin(a) * r;
        if (name === 'gantry_service') {
          // 13.2 m of portal with legs at ±5.6 / ±1.9 — a ring collider on the centre would let a
          // rover drive straight through a girder, so box the four feet.
          const ry = a + rnd() * 0.6;
          put('gantry_service', x, z, sc, ry, 0);
          for (const [lx, lz] of [[-5.6, -1.9], [5.6, -1.9], [-5.6, 1.9], [5.6, 1.9]]) {
            const px = lx * sc, pz = lz * sc;
            colliders.push({ x: x + px * Math.cos(ry) + pz * Math.sin(ry),
                             z: z - px * Math.sin(ry) + pz * Math.cos(ry), r: 1.6 });
          }
          continue;
        }
        k(name, x, z, a + rnd() * 1.2, sc);
        colliders.push({ x, z, r: 3.0 * sc });
      }
      // An ungated lamp ring dropped a post dead-centre in the carriageway, i.e. directly in the
      // rover's path at spawn. Same south exclusion as the structures, plus two lamps squared up on
      // the barrier ends so the approach reads as an avenue rather than a gap in the ring.
      for (let i = 0; i < 10; i++) {
        const a = i / 10 * Math.PI * 2 + 0.31;
        if (Math.hypot(Math.cos(a), Math.sin(a) + 1) < 0.95) continue;
        const lx = hx + Math.cos(a) * 15.5, lz = hz + Math.sin(a) * 15.5;
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
      if (!root || /^(starship|crystal|rover|lamp|habitat_dome|greenhouse|cryo_tank|lander|teleport_pad)$/.test(mname)) continue;
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

    // ── Starship, our Blender hull, ~30 m toy-superhero scale ──
    const ship = new THREE.Group();
    ship.position.set(px, py + 0.3, pz);
    const hull = cloneModel(models['starship']);
    const shipMatMap = cloneMaterials(hull);
    hull.scale.setScalar(0.65);                       // seated 47.7 m hull → 31 m
    ship.add(hull);
    const seen = new Set();
    hull.traverse(o => {
      if (!o.isMesh) return;
      for (const mm of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!seen.has(mm)) { seen.add(mm); shipMats.push(mm); }
      }
    });
    const RING_HUES = [0x3fd9ff, 0xff8a3c, 0xa05cff, 0x3fffc9, 0xff4d6d, 0xffd166];
    for (const [i, f] of [0.06, 0.16, 0.3, 0.46, 0.64, 0.85].entries()) {
      const tr = new THREE.Mesh(new THREE.TorusGeometry(2.45, 0.1, 6, 32), M.shipLightRing.clone());
      tr.material.color.setHex(RING_HUES[i]); tr.material.emissive.setHex(RING_HUES[i]);
      tr.rotation.x = Math.PI / 2; tr.position.y = f * 31; tr.visible = false; noMerge(tr); ship.add(tr);
      lightStrips.push(tr.material); lightRings.push(tr);
    }
    for (const mm of shipMatMap.values()) {
      if (mm.name === 'light_amber' || mm.name === 'light_cyan') lightStrips.push(mm);
    }
    ship.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    G.add(ship); shipGroup = ship;
    colliders.push({ x: px, z: pz, r: 7 });

    // ── Chopstick tower, west of the ship: its six arms reach east to the hull
    // and the "RED STARBASE" board on its south face reads from the teleport pad.
    // Blender asset is 20.7 x 6.9 x 54.4 m with the flame trench 2.5 m below datum.
    put('launch_tower', px - 11, pz, 0.55, 0, 1.1);
    colliders.push({ x: px - 12.5, z: pz, r: 4 });
    const towerBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), M.beacon);
    towerBeacon.position.set(px - 11, py + 29.4, pz);
    G.add(towerBeacon); beacons.push(towerBeacon);

    // ── Kenney booster on a service stand, the base's cargo rocket ──
    {
      const bx2 = px - 15, bz2 = pz + 7, by = surfaceAt(bx2, bz2);
      const stack = new THREE.Group(); stack.position.set(bx2, by, bz2);
      const part = (name, y, ry) => { const o = cloneModel(models[name]); o.scale.setScalar(S); o.position.y = y; o.rotation.y = ry; stack.add(o); };
      part('rocket_baseB', 0.05, 0);
      part('rocket_finsA', 0.02, 0);
      part('rocket_fuelA', S * 1.0, 0.4);
      part('rocket_sidesA', S * 1.9, 0.2);
      part('rocket_topA', S * 2.9, 0);
      G.add(stack);
      colliders.push({ x: bx2, z: bz2, r: 4.5 });
      sparkPoints.push({ x: bx2 + 3, y: by + 2.2, z: bz2 + 1.5, rate: 0.5 });
    }
    // support gantries + FATO tanks around the pad
    // A support frame with nothing standing under it is scaffolding somebody abandoned, so this one
    // is the pad's LOX stand: a cryo drum, a transfer line slung to the flame deck, and a barrel cage.
    {
      const sx = px + 6, sz = pz - 12, sy = surfaceAt(sx, sz);
      // A kit scaffold frame standing over empty ground was the last bare prop on the pad. This is
      // the LOX stand instead: bund, drum, cradle, manifold and a transfer line to the flame deck.
      cyl(1.55, 1.7, 0.24, M.white, sx, sy + 0.12, sz, 26);
      cyl(0.62, 0.62, 1.9, M.struct, sx, sy + 1.19, sz, 20);
      for (const yy of [0.56, 1.29, 1.96]) cyl(0.66, 0.66, 0.09, M.dark, sx, sy + yy, sz, 20);
      cyl(0.24, 0.24, 0.42, M.white, sx, sy + 2.34, sz, 14);
      for (let i = 0; i < 4; i++) {
        const a = i / 4 * Math.PI * 2 + 0.79;
        cyl(0.075, 0.075, 2.9, M.struct, sx + Math.sin(a) * 1.12, sy + 1.69, sz + Math.cos(a) * 1.12, 8);
        box(0.1, 0.1, 2.24, M.struct, sx + Math.sin(a) * 1.12, sy + 3.06, sz + Math.cos(a) * 1.12, G)
          .rotation.y = a;
      }
      const cap = new THREE.Mesh(new THREE.TorusGeometry(1.12, 0.06, 5, 22), M.struct);
      cap.rotation.x = Math.PI / 2; cap.position.set(sx, sy + 3.1, sz); G.add(cap);
      box(0.52, 0.44, 0.36, M.dark, sx + 0.98, sy + 0.86, sz - 0.62, G).rotation.y = 0.8;
      box(0.15, 0.15, 0.52, M.orange, sx + 1.24, sy + 1.2, sz - 0.78, G).rotation.y = 0.8;
      const pts = [];
      for (let i = 0; i <= 18; i++) {
        const t = i / 18;
        pts.push(new THREE.Vector3(sx + (px - sx) * t,
          sy + 2.3 - t * 1.1 - Math.sin(t * Math.PI) * 0.75, sz + (pz - sz) * t));
      }
      const line = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 26, 0.075, 6), M.dark);
      line.castShadow = true; G.add(line);
      k('barrels', sx - 2.4, sz + 1.6, 0.5);
      colliders.push({ x: sx, z: sz, r: 2.1 });
      sparkPoints.push({ x: sx, y: sy + 2.4, z: sz, rate: 0.22 });
    }
    k('machine_generatorLarge', px - 8, pz - 10, 1.9);
    put('gantry_service', px + 16, pz + 10, 1.0, 2.6, 0);   // umbilical portal for the cargo rocket
    k('barrels', px - 14, pz + 14, 0.7);
    colliders.push({ x: px - 8, z: pz - 10, r: 4 }, { x: px + 16, z: pz + 10, r: 4.5 }, { x: px - 14, z: pz + 14, r: 2.6 });

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
      name: '轨道发射台', params: ['星舰总高 31 m（1:4 纪念比例）', '筷子塔高 40 m', '任务代号：RED STARBASE'],
      fact: '在火星，这座塔不只是点火台——它是回家的门票。完成任务链后回到观礼台看它喷火。',
      objective: 'drive: 驶近发射台完成巡检',
    });
  }

  // ══════════ HABITAT — round hangar, domes, corridors, greenhouse ══════════
  {
    const [vx, vz] = ZONES.habitat.pos;
    k('hangar_roundA', vx - 7, vz - 4, 0.5, 1.4);     // the big living drum
    colliders.push({ x: vx - 7, z: vz - 4, r: 8 });
    // The seated 14.4 m domes used to sit where the corridors and the round hangar drum are;
    // coincident shells z-fight into a torn black blob, so the settlement is spread out.
    put('habitat_dome', vx + 18, vz + 14, 1.15, 0.6);      // seated 14.4 x 12.3 x 10.3 m
    put('habitat_dome', vx - 2, vz + 22, 0.85, 2.3);
    put('greenhouse', vx - 16, vz + 10, 1.25, -0.5, 0.05); // 13.7 x 12.0 x 5.0 m glasshouse
    // the greenhouse is a rectangle, not a disc — three overlapping circles keep
    // the rover out of the glass instead of letting it cut a corner off
    const ghA = -0.5, ghux = Math.cos(ghA), ghuz = -Math.sin(ghA);
    colliders.push({ x: vx + 18, z: vz + 14, r: 8.5 }, { x: vx - 2, z: vz + 22, r: 6.5 });
    for (const t of [-3.6, 0, 3.6]) {
      colliders.push({ x: vx - 16 + ghux * t, z: vz + 10 + ghuz * t, r: t === 0 ? 5.0 : 4.2 });
    }
    // pressurised corridors linking drum → domes → greenhouse
    k('corridor', vx + 3, vz + 3, 0.62, 1.1);
    k('corridor_corner', vx + 9, vz + 12, 1.35);
    k('corridor_end', vx - 8, vz + 9, 0.9);
    // front step, awning planters, life
    k('stairs', vx + 11, vz - 10, 0.1);
    k('barrel', vx - 2, vz - 8, 1.1);
    k('astronautA', vx + 7, vz + 15, -0.9);
    k('alien', vx - 13, vz + 14, 2.1);
    putDeck('teleport_pad', vx + 15, vz - 6, 1.05, 0, -0.08);
    teleports.push({ key: 'habitat', name: ZONES.habitat.name, x: vx + 15, z: vz - 6 });
    const vy = zoneY(ZONES.habitat);
    beacons.push(cyl(0.35, 0.35, 0.5, M.beacon, vx - 7, vy + 8.3, vz - 4, 10));   // seated on the hangar drum
    infoZones.push({
      key: 'habitat', pos: [vx, vz], r: 26, tag: 'SETTLEMENT · MODULE A-D',
      name: '火星生活舱区', params: ['加压体积 4×920 m³ · 气闸 ×2', '温室穹顶生物量 ~2.1 t', '住 here 的有 24 名工程师与植物学家'],
      fact: '暖光从舷窗透出来的时候，四亿公里外的家也不过如此。',
    });
  }

  // ══════════ INDUSTRY — fab, cryo tanks, pipe racks + the leak skid ══════════
  {
    const [ix, iz] = ZONES.industry.pos;
    k('hangar_largeA', ix - 6, iz - 8, 0.35, 0.35);   // the fab hall
    colliders.push({ x: ix - 6, z: iz - 8, r: 10 });
    k('machine_generatorLarge', ix + 11, iz - 4, 1.2);
    k('machine_generator', ix + 10, iz + 6, 2.6);
    k('machine_wireless', ix - 14, iz + 8, 0.9);
    put('gantry_service', ix + 3, iz + 15, 0.86, 1.1, 0);   // fab substation gantry
    colliders.push({ x: ix + 11, z: iz - 4, r: 4 }, { x: ix + 10, z: iz + 6, r: 4 }, { x: ix - 14, z: iz + 8, r: 4 }, { x: ix + 3, z: iz + 14, r: 4.5 });
    // cryo row: three Blender tanks with hazard stripes
    for (let i = 0; i < 3; i++) {
      const tx = ix + 17 - i * 0, tz = iz - 14 + i * 6.5;
      put('cryo_tank', tx + (i === 1 ? 3 : 0), tz, 0.95, 0.5 + i, 0.24);
      colliders.push({ x: tx + (i === 1 ? 3 : 0), z: tz, r: 3.0 });
      sparkPoints.push({ x: tx, y: surfaceAt(tx, tz) + 1.8, z: tz - 1.6, rate: 0.45 + i * 0.1 });
    }
    // pipe rack from tanks toward the fab
    for (let i = 0; i < 2; i++) {
      k('pipe_straight', ix + 10 - 6 * i, iz - 4 + 6 * i, 0.75, 0.9 + i * 0.1);
    }
    k('pipe_corner', ix + 6, iz - 10, 0.4);
    k('barrels', ix - 12, iz - 2, 2.0);               // crate of drums by the rail
    colliders.push({ x: ix - 12, z: iz - 2, r: 2.8 });
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
    const my2 = surfaceAt(mx, mz);
    k('machine_generator', mx, mz + 2.5, 1.4, 0.8);   // the valve housing
    k('pipe_straight', mx - 5, mz - 1.5, 0.2);
    k('pipe_corner', mx + 4.5, mz - 2.5, 2.4);
    colliders.push({ x: mx, z: mz + 2.5, r: 3.6 });
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
    k('platform_high', cx2, cz2, 0.2, 1.6);
    k('platform_low', cx2 - 6, cz2 + 8, 1.1, 1.2);
    k('satelliteDish_detailed', cx2 - 1, cz2, 0.15, 2.3);   // the big ear
    k('satelliteDish', cx2 + 9, cz2 - 6, 1.2);
    k('satelliteDish', cx2 + 4, cz2 + 9, 2.9, 0.75);
    k('machine_wireless', cx2 - 9, cz2 + 6, 0.5);
    put('gantry_service', cx2 + 11, cz2 + 4, 0.78, 0.9, 0);  // array feed portal
    k('hangar_smallA', cx2 - 10, cz2 + 11, 2.4);            // the listening post
    k('desk_computer', cx2 - 6, cz2 + 8, 1.9);              // outdoor console on the low deck
    k('rail', cx2 - 3, cz2 + 10, 0.35);
    k('astronautA', cx2 - 4, cz2 + 7, 2.6);                 // whoever is on shift, listening to Earth
    colliders.push({ x: cx2 - 1, z: cz2, r: 5 }, { x: cx2 + 9, z: cz2 - 6, r: 3 }, { x: cx2 + 4, z: cz2 + 9, r: 2.6 }, { x: cx2 - 10, z: cz2 + 11, r: 5 });
    putDeck('teleport_pad', cx2 - 9, cz2 - 8, 1.0, 0, -0.08);
    teleports.push({ key: 'comms', name: ZONES.comms.name, x: cx2 - 9, z: cz2 - 8 });
    const cy = zoneY(ZONES.comms);
    beacons.push(cyl(0.3, 0.3, 0.45, M.beacon, cx2 + 4.6, cy + 4.4, cz2 + 1.5, 10));  // on the big dish's rim
    infoZones.push({
      key: 'comms', pos: [cx2, cz2], r: 22, tag: 'DEEP SPACE NETWORK · NODE M1',
      name: '通讯阵列', params: ['主碟 7.3 m · X 波段', '与地球单程时延 4–24 分钟', '日出日落各一次全星通联'],
      fact: '和地球说话要等二十分钟回音。所以基地里的人，早就学会了自己解决问题。',
    });
  }

  // ══════════ SCIENCE — crystal grove & field lab ══════════
  {
    const [sx, sz] = ZONES.science.pos;
    k('platform_low', sx, sz + 2, 0.4, 1.7);
    // a big alien growth the whole zone orbits around
    const big = seat(put('crystal', sx - 2, sz - 3, 2.6, 0.5, 0.6), 0.5);
    big.traverse(o => { if (o.isMesh) o.material = M.crystal; });
    scree(sx - 2, sz - 3, 6.2, 0.7);
    for (const [dx, dz, cs] of [[7, 4, 1.05], [-9, 5, 0.8], [3, 9, 0.62], [-5, -9, 0.9]]) {
      const c = seat(put('crystal', sx + dx, sz + dz, cs, dx * dz, cs * 0.34), 0.22);
      c.traverse(o => { if (o.isMesh) o.material = M.crystal; });
      scree(sx + dx, sz + dz, cs * 2.0, dx + dz);
      colliders.push({ x: sx + dx, z: sz + dz, r: 1.2 });
    }
    colliders.push({ x: sx - 2, z: sz - 3, r: 2.6 });
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

  // ══════════ WATCH DECK — the grandstand for the launch ══════════
  {
    const [wx, wz] = ZONES.watch.pos;
    const wy = Math.max(...Array.from({ length: 24 }, (_, i) => {
      const a = i / 24 * 6.283, rr = (i % 3) / 2 * 7;
      return surfaceAt(wx + Math.cos(a) * rr, wz + Math.sin(a) * rr);
    }));
    const deckTop = wy + 0.5;
    const [lpx, lpz] = ZONES.launch.pos;
    // Azimuth the crowd looks down, and the opposite side of the deck where the seating sits.
    const face = Math.atan2(lpx - wx, lpz - wz);
    const back = face + Math.PI;
    const plate = new THREE.MeshStandardMaterial({ color: 0x3d362e, roughness: 0.93, metalness: 0.05 });
    const precast = new THREE.MeshStandardMaterial({ color: 0x8a8272, roughness: 0.88, metalness: 0.04 });
    const webSeat = new THREE.MeshStandardMaterial({ color: 0x2c4560, roughness: 0.66, metalness: 0.16 });
    const canopy = new THREE.MeshStandardMaterial({ color: 0xc9c2b2, roughness: 0.52, metalness: 0.42 });
    // M.hazard is a saturated traffic paint that glows like a neon rope under a 3.4 sun. Deck
    // marking is oxidised iron oxide over a primer, and it is a flat painted band, not a tube.
    const safetyRed = new THREE.MeshStandardMaterial({ color: 0x6e2a19, roughness: 0.82, metalness: 0.04 });

    // A 16 m puck of injection-moulded white with one bench on it was the flattest thing on the
    // island, and it sat directly between the rover and the launch pad so it filled every approach
    // shot. It is now a grandstand: precast drum, dark wearing plate, tiered benches, shade canopy.
    cyl(8.0, 8.4, 1.0, precast, wx, deckTop - 0.5, wz, 44);
    cyl(7.94, 7.94, 0.08, plate, wx, deckTop + 0.04, wz, 44);
    const band = new THREE.Mesh(new THREE.TorusGeometry(7.5, 0.05, 5, 72), safetyRed);
    band.rotation.x = Math.PI / 2; band.position.set(wx, deckTop + 0.095, wz); G.add(band);
    // A cast plate this wide is poured in segments, and the joints are the only thing that says so.
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * Math.PI * 2 + 0.1;
      const j = box(0.1, 0.02, 4.6, M.dark, wx + Math.sin(a) * 5.5, deckTop + 0.085,
        wz + Math.cos(a) * 5.5, G);
      j.rotation.y = a;
    }
    for (const rr of [4.2, 6.0]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.045, 5, 52), M.dark);
      ring.rotation.x = Math.PI / 2; ring.position.set(wx, deckTop + 0.088, wz); G.add(ring);
    }
    // Four tiered arcs of benches, stepped up away from the pad so every row clears the one ahead.
    const rows = [[2.5, 0.02, 5], [3.9, 0.2, 7], [5.3, 0.38, 9], [6.6, 0.54, 11]];
    for (const [r, rise, n] of rows) {
      for (let i = 0; i < n; i++) {
        const u = back + (i / (n - 1) - 0.5) * 1.5;
        const x = wx + Math.sin(u) * r, z = wz + Math.cos(u) * r;
        box(0.66, 0.1, 0.44, webSeat, x, deckTop + 0.5 + rise, z, G).rotation.y = u;
        box(0.66, 0.36, 0.08, webSeat, wx + Math.sin(u) * (r + 0.24), deckTop + 0.72 + rise,
          wz + Math.cos(u) * (r + 0.24), G).rotation.y = u;
        box(0.62, 0.42 + rise, 0.5, precast, x, deckTop + 0.26 + rise / 2, z, G).rotation.y = u;
      }
      // armrest dividers and a foot rail along the front of each tier
      for (let i = 0; i <= n; i++) {
        const u = back + (i / n - 0.5) * 1.5 - 0.75 / n;
        box(0.07, 0.3, 0.5, M.struct, wx + Math.sin(u) * r, deckTop + 0.62 + rise,
          wz + Math.cos(u) * r, G).rotation.y = u;
      }
    }
    // Shade canopy over the top tier — the only shade on the deck, and the reason the rows are there.
    {
      const cx = wx + Math.sin(back) * 6.2, cz = wz + Math.cos(back) * 6.2;
      for (const u of [-0.72, -0.24, 0.24, 0.72]) {
        const px2 = wx + Math.sin(back + u) * 7.35, pz2 = wz + Math.cos(back + u) * 7.35;
        cyl(0.13, 0.19, 3.5, M.struct, px2, deckTop + 1.75, pz2, 10);
        box(0.5, 0.12, 0.5, M.struct, px2, deckTop + 0.06, pz2, G).rotation.y = back + u;
      }
      const roof = box(9.6, 0.18, 4.4, canopy, cx, deckTop + 3.62, cz, G);
      roof.rotation.y = back; roof.rotation.x = 0.1;
      box(9.6, 0.34, 0.14, canopy, cx, deckTop + 3.5, cz, G).rotation.y = back;
      // the front lip carries the house lights, so the grandstand reads as occupied after dark
      const fascia = box(9.0, 0.1, 0.16, M.warmWin, cx, deckTop + 3.36, cz, G);
      fascia.rotation.y = back;
      const fp = new THREE.Vector3(Math.sin(face), 0, Math.cos(face)).multiplyScalar(2.05);
      fascia.position.x += fp.x; fascia.position.z += fp.z;
      for (let i = 0; i < 6; i++) {
        const o = (i / 5 - 0.5) * 8.4;
        cyl(0.09, 0.09, 0.07, M.warmWin,
          cx + Math.cos(back) * o, deckTop + 3.42,
          cz - Math.sin(back) * o, 8);
      }
    }
    // Perimeter: stanchions and a two-rail fence on the open viewing side, bollard lamps on the lip.
    for (let i = 0; i < 16; i++) {
      const u = face + (i / 15 - 0.5) * 2.5;
      const x = wx + Math.sin(u) * 7.62, z = wz + Math.cos(u) * 7.62;
      cyl(0.05, 0.05, 1.15, M.struct, x, deckTop + 0.62, z, 6);
      cyl(0.07, 0.07, 0.1, M.dark, x, deckTop + 0.1, z, 8);
    }
    for (const [ry, rr] of [[1.16, 7.62], [0.66, 7.62]]) {
      const arc = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.045, 5, 40, 2.5), M.struct);
      // A partial torus starts at local +x, so the z-rotation is the azimuth of the arc's first
      // degree — π/2 − u converts a deck bearing (sin u, cos u) into it.
      arc.rotation.set(Math.PI / 2, 0, Math.PI / 2 - face + 1.25);
      arc.position.set(wx, deckTop + ry, wz); G.add(arc);
    }
    for (let i = 0; i < 9; i++) {
      const u = face + (i / 8 - 0.5) * 2.9;
      const x = wx + Math.sin(u) * 7.1, z = wz + Math.cos(u) * 7.1;
      cyl(0.1, 0.12, 0.52, M.struct, x, deckTop + 0.3, z, 8);
      cyl(0.11, 0.11, 0.09, M.warmWin, x, deckTop + 0.6, z, 8);
    }
    // Broadcast camera on a tripod at the rail — the shot that films the launch.
    {
      const u = face + 1.02;
      const cx = wx + Math.sin(u) * 6.6, cz = wz + Math.cos(u) * 6.6;
      const cy = deckTop + 1.5;
      for (let i = 0; i < 3; i++) {
        const a = u + i / 3 * Math.PI * 2;
        const leg = cyl(0.035, 0.035, 1.1, M.dark, cx + Math.sin(a) * 0.3, cy - 0.5,
          cz + Math.cos(a) * 0.3, 6);
        leg.rotation.set(Math.cos(a) * 0.32, 0, -Math.sin(a) * 0.32);
      }
      box(0.5, 0.3, 0.28, M.dark, cx, cy + 0.12, cz, G).rotation.y = u;
      box(0.42, 0.24, 0.1, M.white, cx, cy + 0.4, cz, G).rotation.y = u;
      const lens = cyl(0.11, 0.13, 0.34, M.dark,
        cx + Math.sin(face) * 0.3, cy + 0.12, cz + Math.cos(face) * 0.3, 12);
      lens.rotation.set(Math.PI / 2, 0, -face);
      cyl(0.085, 0.085, 0.05, M.cyanLight,
        cx + Math.sin(face) * 0.48, cy + 0.12, cz + Math.cos(face) * 0.48, 12)
        .rotation.set(Math.PI / 2, 0, -face);
    }
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
    colliders.push({ x: wx, z: wz, r: 9, top: deckTop + 0.25, floor: deckTop });
    infoZones.push({
      key: 'watch', pos: [wx, wz], r: 20, tag: 'VIEWING DECK · SAFE DIST 60 m',
      name: '发射观礼台', params: ['视角方位直指 PAD ONE', '点火后 60 m 处会感到大气的轻推'],
      fact: '任务完成后回到这里——星舰点火时，火星的大气会把你轻轻推回座椅。',
      objective: 'drive: 等待发射窗口（完成任务线后触发）',
    });
  }

  // ══════════ NIGHT HILL — scope + lantern ring on the rim ══════════
  {
    const [nx, nz] = ZONES.night.pos;
    const ny = surfaceAt(nx, nz);
    put('habitat_dome', nx + 6, nz - 4, 0.7, 1.7);
    colliders.push({ x: nx + 6, z: nz - 4, r: 3.6 });
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
    colliders.push({ x: nx - 7, z: nz - 6, r: 1.6 });
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
    const wy2 = surfaceAt(yx, yz);
    wreckPos = new THREE.Vector3(yx, wy2, yz);
    const w = put('lander', yx, yz, 1.15, 0.6, 0.45);
    w.rotation.z = 1.45; w.rotation.x = 0.25;         // down on its side
    colliders.push({ x: yx, z: yz, r: 7 });
    k('barrel', yx + 9, yz + 4, 1.9);
    k('barrel', yx + 11, yz + 1, -0.4);
    k('craft_speederA', yx - 8, yz + 8, 0.9, 0.7);    // the rescue craft that found it
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
    const car = new THREE.Group(); car.position.set(rx, ry, rz); car.rotation.y = 2.55; // nose points out at the rim
    const paint = new THREE.MeshPhysicalMaterial({ color: 0xa81414, roughness: 0.26, metalness: 0.5, clearcoat: 0.85, clearcoatRoughness: 0.15, envMapIntensity: 1.2 });
    const glassDark = new THREE.MeshPhysicalMaterial({ color: 0x0d1620, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.6 });
    const suitMat = new THREE.MeshStandardMaterial({ color: 0xe6e2d8, roughness: 0.62, metalness: 0.05 });
    box(1.9, 0.4, 4.4, paint, 0, 0.66, 0, car);
    box(1.62, 0.42, 1.5, paint, 0, 0.72, -1.75, car);
    box(1.5, 0.34, 1.25, paint, 0, 0.78, 1.7, car);
    box(1.42, 0.56, 1.35, paint, 0, 0.98, 0.35, car);
    box(1.24, 0.5, 0.1, glassDark, 0, 1.16, -0.42, car).rotation.x = -0.5;
    for (const s of [-1, 1]) {
      box(0.5, 0.5, 1.45, paint, s * 0.86, 0.72, -1.5, car).rotation.z = s * 0.16;
      box(0.5, 0.46, 1.3, paint, s * 0.86, 0.72, 1.55, car).rotation.z = s * 0.16;
      const lampB = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), M.goldLight);
      lampB.position.set(s * 0.6, 0.86, -2.48); car.add(lampB);
    }
    const tyre = new THREE.MeshStandardMaterial({ color: 0x14120f, roughness: 0.95 });
    for (const [wxp, wzp] of [[-1.06, -1.5], [1.06, -1.5], [-1.06, 1.55], [1.06, 1.55]]) {
      cyl(0.58, 0.58, 0.38, tyre, wxp, 0.58, wzp, 16, car).rotation.z = Math.PI / 2;
      cyl(0.3, 0.3, 0.4, M.struct, wxp, 0.58, wzp, 12, car).rotation.z = Math.PI / 2;
    }
    const star = new THREE.Group(); star.position.set(0, 0.78, 0.42);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.29, 0.4, 6, 12), suitMat);
    torso.position.y = 0.42; star.add(torso);
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), suitMat);
    helm.position.y = 0.9; star.add(helm);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.225, 16, 12), new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 1, roughness: 0.12, envMapIntensity: 1.5 }));
    visor.position.set(0, 0.92, -0.1); visor.scale.set(0.95, 0.8, 0.5); star.add(visor);
    car.add(star);
    car.traverse(o => { if (o.isMesh) o.castShadow = true; });
    G.add(car);
    colliders.push({ x: rx, z: rz, r: 3.2 });
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

  // ══════════ ROAD SETTING — lamps + centerline tiles between zones ══════════
  {
    const pairs = [
      [ZONES.hub.pos, ZONES.launch.pos], [ZONES.hub.pos, ZONES.habitat.pos],
      [ZONES.hub.pos, ZONES.industry.pos], [ZONES.hub.pos, ZONES.comms.pos],
      [ZONES.hub.pos, ZONES.science.pos], [ZONES.launch.pos, ZONES.watch.pos],
      [ZONES.watch.pos, ZONES.comms.pos],
    ];
    for (const [a, b] of pairs) {
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
      const n = Math.max(3, Math.round(l / 13));
      const yaw = Math.atan2(dx, dz);
      for (let i = 1; i < n; i++) {
        const t = i / n;
        const x = a[0] + dx * t, z = a[1] + dz * t;
        k('terrain_roadStraight', x, z, yaw, 0.9);
        if (i % 2 === 0) {
          const ox = dz / l * 4.6, oz = -dx / l * 4.6;
          const side = (i % 4 === 2) ? 1 : -1;
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
    const animated = new Set([...padGlow, ...beacons.map(b => b.material), ...lightStrips, ...lightRings.map(r => r.material), ...showBeamMats, ...shipMats]);
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
    const iron = new THREE.MeshStandardMaterial({ color: 0x5a544b, roughness: 0.44, metalness: 0.86 });
    const soot = new THREE.MeshStandardMaterial({ color: 0x2a2825, roughness: 0.72, metalness: 0.5 });
    for (const tp of teleports) {
      const rad = Math.hypot(tp.x, tp.z) || 1;
      const rx = tp.x + (tp.x / rad) * 4.4, rz = tp.z + (tp.z / rad) * 4.4;
      const rig = new THREE.Group();
      rig.position.set(rx, rimY(rx, rz, 2.05) - 0.06, rz);
      rig.rotation.y = Math.atan2(tp.x - rx, tp.z - rz);
      G.add(rig);

      // ── the tap has to read as a substation you can drive up to and recognise from 100 m:
      // bolted plinth, finned transformer drum, insulator bushings, a braced lattice mast,
      // then the reactor core hung in a cage above the service deck.
      cyl(1.85, 2.05, 0.26, soot, 0, 0.13, 0, 8, rig);        // octagonal foundation
      cyl(1.42, 1.42, 0.14, iron, 0, 0.33, 0, 8, rig);        // bolted flange
      for (let i = 0; i < 8; i++) {
        const a = i * 0.7854 + 0.39;
        box(0.14, 0.13, 0.14, soot, Math.sin(a) * 1.42, 0.46, Math.cos(a) * 1.42, rig);
      }

      cyl(0.6, 0.62, 1.0, iron, 0, 0.92, 0, 12, rig);         // transformer drum
      for (let i = 0; i < 12; i++) {                          // cooling fins
        const a = i * 0.5236;
        const fin = box(0.045, 0.82, 0.24, soot, Math.sin(a) * 0.68, 0.92, Math.cos(a) * 0.68, rig);
        fin.rotation.y = -a;
      }
      cyl(0.44, 0.58, 0.16, soot, 0, 1.5, 0, 12, rig);        // conservator cap
      for (let i = 0; i < 3; i++) {                           // porcelain bushings
        const a = i * 2.094 + 0.5, bx = Math.sin(a) * 0.33, bz = Math.cos(a) * 0.33;
        for (let d = 0; d < 3; d++) cyl(0.145 - d * 0.015, 0.165 - d * 0.015, 0.05, soot, bx, 1.66 + d * 0.13, bz, 8, rig);
        cyl(0.03, 0.03, 0.46, iron, bx, 1.98, bz, 6, rig);
      }

      const MS = 0.6, Y0 = 2.2, Y1 = 4.7, TIER = (Y1 - Y0) / 3;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.1, Y1 - Y0 + 0.3, 0.1, iron, sx * MS, (Y0 + Y1) / 2, sz * MS, rig);
      const braceZ = Math.atan2(MS * 2, TIER);
      for (let k = 0; k < 4; k++) {
        const face = new THREE.Group();
        face.rotation.y = k * Math.PI / 2;
        rig.add(face);
        const at = (w, h, d, mat, x, y) => { const b = box(w, h, d, mat, x, y, MS, face); return b; };
        for (let t = 0; t <= 3; t++) at(MS * 2, 0.07, 0.06, iron, 0, Y0 + t * TIER);
        for (let t = 0; t < 3; t++) {
          const yc = Y0 + (t + 0.5) * TIER, L = Math.hypot(MS * 2, TIER) + 0.06;
          at(0.05, L, 0.05, soot, 0, yc).rotation.z = braceZ;
          at(0.05, L, 0.05, soot, 0, yc).rotation.z = -braceZ;
        }
      }
      box(1.5, 0.11, 1.5, iron, 0, Y1 + 0.06, 0, rig);       // service deck
      for (let k = 0; k < 4; k++) {
        const a = k * Math.PI / 2;
        const rail = box(1.44, 0.045, 0.045, soot, Math.sin(a) * 0.7, Y1 + 0.52, Math.cos(a) * 0.7, rig);
        rail.rotation.y = a;
      }
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
      const yoke = new THREE.Mesh(new THREE.TorusGeometry(0.92, 0.055, 6, 20), iron);
      yoke.position.y = 5.85; yoke.rotation.x = Math.PI / 2; yoke.castShadow = true; rig.add(yoke);
      for (let i = 0; i < 4; i++) {                            // cage bars over the core
        const a = i * 1.5708;
        const bar = box(0.055, 1.5, 0.055, iron, Math.sin(a) * 0.72, 5.85, Math.cos(a) * 0.72, rig);
        bar.rotation.z = Math.sin(a) * 0.24; bar.rotation.x = -Math.cos(a) * 0.24;
      }
      cyl(0.1, 0.14, 0.9, iron, 0, 5.0, 0, 8, rig);           // hanger post off the deck
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
      colliders.push({ x: rx, z: rz, r: 2.2 });
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
    group: G, colliders, infoZones, samples, sparkPoints, beacons, lightStrips, lightRings, showBeams, showBeamMats, shipMats, shipGroup, teleports, padGlow, heroLights, occluders, gridRigs, crystalMat: M.crystal,
    leakPoint: new THREE.Vector3(LEAK_POS[0], surfaceAt(LEAK_POS[0], LEAK_POS[1]) + 1.8, LEAK_POS[1]),
    flamePoint,
    launchPadPos: new THREE.Vector3(...ZONES.launch.pos),
    wreckPos,
    watchPos: new THREE.Vector3(ZONES.watch.pos[0], surfaceAt(...ZONES.watch.pos), ZONES.watch.pos[1]),
  };
}
