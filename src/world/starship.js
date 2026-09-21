// ─────────────────────────────────────────────────────────────────────────────────────
// The launch stack: Starship riding a Super Heavy booster, in metres of the real vehicle
// (scaled once by the caller). What makes that silhouette readable from 200 m is a short
// list of things — a *cylinder*, not a cone-with-a-cone-on-top; a hundred visible ring
// welds on polished steel; black hexagonal tiles on exactly one face; four D-section
// flaps; four folded grid fins; a sea-level Raptor field under a burnt skirt. Every one of
// those is modelled here as geometry, because at this scale the recognisable parts *are*
// the geometry and a texture cannot stand in for them.
// ─────────────────────────────────────────────────────────────────────────────────────

const R = 4.5;            // hull radius, 9 m diameter
const BOOT = 36;          // Super Heavy height above the pad
const STAGE = 38.4;       // top of the interstage: the ship's aft skirt starts here
const SHIP = 33;          // Starship upper stage height
const TIP = STAGE + SHIP; // ~71 m to the nose tip

const WIND = 0.9;         // radians: half-angle of the windward face that carries tiles

// Brushed stainless: fine vertical streaks, so the tank reflects the sky in stripes the way
// a rolled-and-welded shell does, instead of reading as a mirror or as grey plastic.
function steelRough(THREE) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 512;
  const c = cv.getContext('2d');
  // A roughness map multiplies, so a mid-grey canvas halved the material's roughness and turned the
  // barrel into a mirror that threw one blown-white sun bar up its length. The base is near-white
  // here and the streaks only bite a little.
  c.fillStyle = '#e6e6e6';
  c.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * 256, w = 0.4 + Math.random() * 1.6;
    c.strokeStyle = `rgba(${Math.random() < 0.5 ? 255 : 40},${Math.random() < 0.5 ? 255 : 40},40,${0.02 + Math.random() * 0.05})`;
    c.lineWidth = w;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x + (Math.random() - 0.5) * 6, 512); c.stroke();
  }
  // the girth welds are rougher than the base metal, and they arrive on a 1.25 m pitch
  for (let y = 0; y < 512; y += 512 / 14) {
    c.fillStyle = 'rgba(230,230,230,0.5)';
    c.fillRect(0, y - 1.5, 256, 3);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 1);
  return t;
}

// Thermal protection tiles: 30 cm hexes in a dark mat, with the grout lines lighter than the
// tile faces so the field catches the sun instead of turning the nose into a black blob.
function tileMap(THREE) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const c = cv.getContext('2d');
  c.fillStyle = '#0b0a09';
  c.fillRect(0, 0, 512, 512);
  const s = 26;
  for (let row = -1; row < 12; row++) {
    for (let col = -1; col < 12; col++) {
      const cx = col * s * 1.732 + (row % 2 ? s * 0.866 : 0), cy = row * s * 1.5;
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3 + Math.PI / 6;
        c[i ? 'lineTo' : 'moveTo'](cx + Math.cos(a) * (s - 1.6), cy + Math.sin(a) * (s - 1.6));
      }
      c.closePath();
      const v = 30 + Math.random() * 22;
      c.fillStyle = `rgb(${v},${v * 0.94},${v * 0.9})`;
      c.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// The wordmark is painted on the aft stainless, not embossed, so it is alpha over the steel
// with the same roughness underneath.
function wordmark(THREE, text) {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 256;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, 1024, 256);
  c.fillStyle = '#1d1b19';
  c.font = '700 128px "Helvetica Neue", Arial, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.letterSpacing = '22px';
  c.fillText(text, 512, 132);
  c.strokeStyle = 'rgba(20,18,16,0.55)';
  c.lineWidth = 2;
  c.strokeRect(70, 40, 884, 176);
  const t = new THREE.CanvasTexture(cv);
  t.anisotropy = 4;
  return t;
}

export function createStarship(THREE, { text = 'STARBASE' } = {}) {
  const g = new THREE.Group();
  const rough = steelRough(THREE), tiles = tileMap(THREE);

  // Polished steel, but not a mirror: at metalness 1 the hull has no diffuse term at all, so the
  // tank went to solid black wherever the sky reflection missed the camera. Dulled the other way and
  // it throws a blown-white sun band down the barrel that bloom then turns into a lamp. This is a
  // vehicle that has been sitting in dust: a film of it takes the mirror off the stainless and
  // leaves a grey tank with a sheen, which is what the sun actually lands on.
  const steel = new THREE.MeshStandardMaterial({
    color: 0xa7a096, roughness: 0.55, metalness: 0.45, roughnessMap: rough, envMapIntensity: 0.85,
  });
  // The aft skirt soaks up every Raptor start: straw-blue oxide at the flame edge, going dark
  // up the barrel. Without it the engines read as bolted on rather than as hot enough to burn.
  const burnt = new THREE.MeshStandardMaterial({ color: 0x6b5b4c, roughness: 0.66, metalness: 0.55 });
  const tps = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: tiles, roughness: 0.82, metalness: 0.1,
  });
  tps.map.repeat.set(18, 9);
  const dark = new THREE.MeshStandardMaterial({ color: 0x2e2b28, roughness: 0.7, metalness: 0.45 });
  const hinge = new THREE.MeshStandardMaterial({ color: 0x6f6a62, roughness: 0.44, metalness: 0.95 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x10171c, roughness: 0.08, metalness: 0.6 });
  const nozzle = new THREE.MeshStandardMaterial({ color: 0x241f1c, roughness: 0.5, metalness: 0.9, side: THREE.DoubleSide });
  const paint = new THREE.MeshStandardMaterial({
    map: wordmark(THREE, text), transparent: true, roughness: 0.42, metalness: 0.6,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  });

  const put = (geo, mat, x, y, z, ry = 0, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.y = ry; m.rotation.x = rx;
    g.add(m);
    return m;
  };

  // ── barrels ───────────────────────────────────────────────────────────────────────
  // Open-ended cylinders, then a windward overlay at +0.04 m for the tile blanket: tiles
  // only ever covered the side that faced re-entry, and the seam between steel and tile is
  // the single most Starship detail on the vehicle.
  const barrel = (y0, y1, r = R, seg = 56) =>
    put(new THREE.CylinderGeometry(r, r, y1 - y0, seg, 1, true), steel, 0, (y0 + y1) / 2, 0);

  const blanket = (y0, y1, r, start = Math.PI / 2 - WIND, span = WIND * 2, mat = tps) =>
    put(new THREE.CylinderGeometry(r, r, y1 - y0, 28, 1, true, start, span),
      mat, 0, (y0 + y1) / 2, 0);

  barrel(0, BOOT);                                    // Super Heavy
  barrel(STAGE, STAGE + 20);                          // ship: metha / LOX barrels
  blanket(0.2, BOOT - 0.2, R + 0.04);                 // booster windward tiles
  put(new THREE.CylinderGeometry(R, R, 4.4, 56, 1, true), burnt, 0, 2.2, 0);

  // ring welds, one per 1.25 m of shell — the pitch the stainless actually arrives on
  const weld = new THREE.TorusGeometry(R + 0.03, 0.035, 4, 44);
  for (let y = 1.25; y < BOOT - 1; y += 1.25) put(weld, hinge, 0, y, 0, 0, Math.PI / 2);
  for (let y = STAGE + 1.25; y < STAGE + 20; y += 1.25) put(weld, hinge, 0, y, 0, 0, Math.PI / 2);

  // ── nose ──────────────────────────────────────────────────────────────────────────
  // An ogive that keeps its curvature to the very tip: r = R·(1−t²)^0.55 stays blunt where a
  // cone would be sharp, which is the difference between "Starship" and "1960s rocket".
  const NOSE0 = STAGE + 20, NOSE = TIP - NOSE0;
  const prof = [];
  for (let i = 0; i <= 26; i++) {
    const t = i / 26;
    prof.push(new THREE.Vector2(R * Math.pow(1 - t * t, 0.55), NOSE0 + t * NOSE));
  }
  put(new THREE.LatheGeometry(prof, 56), steel, 0, 0, 0);
  const noseTps = prof.map(p => new THREE.Vector2(p.x * 1.012, p.y));
  put(new THREE.LatheGeometry(noseTps, 26, Math.PI / 2 - WIND, WIND * 2), tps, 0, 0, 0);
  // the payload-bay rim stands proud of the shell where it meets the nose
  put(new THREE.TorusGeometry(R + 0.05, 0.07, 5, 44), hinge, 0, NOSE0, 0, 0, Math.PI / 2);

  // ── interstage ────────────────────────────────────────────────────────────────────
  put(new THREE.CylinderGeometry(R + 0.12, R + 0.12, 2.4, 48, 1, true), dark, 0, BOOT + 1.2, 0);
  const bolt = new THREE.BoxGeometry(0.16, 0.2, 0.16);
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * Math.PI * 2;
    put(bolt, hinge, Math.sin(a) * (R + 0.16), BOOT + 0.5, Math.cos(a) * (R + 0.16), a);
  }
  // hot-staging gas: eight short bells pointing down and out
  const gas = new THREE.CylinderGeometry(0.16, 0.09, 0.34, 10);
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    put(gas, nozzle, Math.sin(a) * (R + 0.2), BOOT + 2.1, Math.cos(a) * (R + 0.2), a, 0.5);
  }

  // ── Raptors ───────────────────────────────────────────────────────────────────────
  // A de Laval bell, not a cone: throat, then a quick flare that straightens out. Thirteen
  // around the rim plus three gimballed in the middle is the sea-level Raptor field.
  const bell = rExit => {
    const p = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      p.push(new THREE.Vector2(0.2 * R + (rExit - 0.2 * R) * Math.pow(t, 2.2), -t * rExit * 1.55));
    }
    return new THREE.LatheGeometry(p, 20);
  };
  const raptor = (x, y, z, s = 1) => {
    const m = put(bell(0.66 * s), nozzle, x, y, z);
    m.scale.setScalar(1);
    put(new THREE.CylinderGeometry(0.86 * s, 0.98 * s, 0.7 * s, 14), burnt, x, y + 0.5 * s, z);
    put(new THREE.CylinderGeometry(0.3 * s, 0.3 * s, 1.05 * s, 10), dark, x, y + 1.35 * s, z);
  };
  for (let i = 0; i < 13; i++) {
    const a = i / 13 * Math.PI * 2;
    raptor(Math.sin(a) * 3.5, 0.35, Math.cos(a) * 3.5);
  }
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2 + 0.5;
    raptor(Math.sin(a) * 1.25, 0.35, Math.cos(a) * 1.25, 1.15);
  }
  // the ship's own three, tucked in the interstage shadow
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2;
    raptor(Math.sin(a) * 1.6, STAGE + 0.1, Math.cos(a) * 1.6, 0.85);
  }

  // ── flaps ─────────────────────────────────────────────────────────────────────────
  // D-section: a straight hinge line and a swept round trailing body. Two aft on the ship,
  // two forward canards, stowed flush against the barrel exactly as they fly.
  const flapGeo = (span, thick) => {
    const s = new THREE.Shape();
    s.moveTo(0, -span / 2);
    s.lineTo(0, span / 2);
    s.absarc(0, 0, span / 2, Math.PI / 2, -Math.PI / 2, true);
    return new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 1 });
  };
  const flap = (y, side, span, tilt) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * R * 0.985, y, 0);
    pivot.rotation.z = -side * tilt;
    g.add(pivot);
    const f = new THREE.Mesh(flapGeo(span, 0.24), tps);
    f.rotation.y = side > 0 ? 0 : Math.PI;
    f.position.z = 0;
    pivot.add(f);
    const rim = new THREE.Mesh(flapGeo(span - 0.16, 0.3), steel);
    rim.rotation.y = f.rotation.y;
    rim.position.z = -0.03;
    pivot.add(rim);
    for (const hz of [-span * 0.34, span * 0.34]) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.62, 12), hinge);
      c.rotation.z = Math.PI / 2;
      c.position.set(side * 0.1, hz, 0.12);
      pivot.add(c);
      const br = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.24), dark);
      br.position.set(side * -0.32, hz, 0.12);
      pivot.add(br);
    }
    return pivot;
  };
  const flaps = [flap(STAGE + 2.6, 1, 5.2, 0.06), flap(STAGE + 2.6, -1, 5.2, 0.06),
    flap(NOSE0 - 1.4, 1, 3.1, 0.1), flap(NOSE0 - 1.4, -1, 3.1, 0.1)];

  // ── grid fins ─────────────────────────────────────────────────────────────────────
  // Four, folded flat against the booster near its top. A lattice rather than a plate: the
  // open squares are what makes the silhouette read as "booster that came back".
  const gridFin = (a, side) => {
    const fin = new THREE.Group();
    // Stowed fins still stand a palm's width off the tank and catch the sun along their edge; flat
    // against the shell they disappeared entirely and the booster lost the "came back" silhouette.
    fin.position.set(Math.sin(a) * (R + 0.34), BOOT - 4.5, Math.cos(a) * (R + 0.34));
    fin.rotation.y = a;
    fin.rotation.x = side * 0.14;
    g.add(fin);
    const bar = new THREE.BoxGeometry(0.1, 2.5, 0.14);
    for (let i = 0; i < 6; i++) {
      const b = new THREE.Mesh(bar, hinge);
      b.position.set(-1.15 + i * 0.46, 0, 0);
      fin.add(b);
      const h = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.1, 0.14), hinge);
      h.position.set(0, -1.15 + i * 0.46, 0);
      fin.add(h);
    }
    const frame = new THREE.Mesh(new THREE.BoxGeometry(2.72, 2.72, 0.1), dark);
    frame.position.z = -0.06;
    fin.add(frame);
    const pintle = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.7, 12), hinge);
    pintle.rotation.z = Math.PI / 2;
    pintle.position.set(-side * 0.4, 0, -0.1);
    fin.add(pintle);
  };
  for (let i = 0; i < 4; i++) gridFin(i * Math.PI / 2 + Math.PI / 4, i % 2 ? 1 : -1);

  // ── the small stuff that sells it at 20 m ─────────────────────────────────────────
  // payload bay doors: two curved leaves on the lee side with the seam between them
  const door = new THREE.CylinderGeometry(R + 0.07, R + 0.07, 5.6, 16, 1, true, -Math.PI / 2 - 0.26, 0.25);
  put(door, steel, 0, STAGE + 9.6, 0);
  put(new THREE.TorusGeometry(R + 0.08, 0.05, 4, 20, 0.52), hinge, 0, STAGE + 6.8, 0, -Math.PI / 2 - 0.26, Math.PI / 2);
  put(new THREE.TorusGeometry(R + 0.08, 0.05, 4, 20, 0.52), hinge, 0, STAGE + 12.4, 0, -Math.PI / 2 - 0.26, Math.PI / 2);

  // RCS quads: two pockets fore, two aft, each with three cold-gas bells
  const rcs = new THREE.BoxGeometry(0.5, 0.5, 0.34);
  const rcsBell = new THREE.CylinderGeometry(0.07, 0.11, 0.2, 8);
  for (const [y, a] of [[TIP - 4.2, 0.6], [TIP - 4.2, Math.PI + 0.6], [STAGE + 1.4, Math.PI / 2], [STAGE + 1.4, -Math.PI / 2]]) {
    const x = Math.sin(a) * (R + 0.1), z = Math.cos(a) * (R + 0.1);
    put(rcs, dark, x, y, z, a);
    for (const d of [-0.15, 0, 0.15]) put(rcsBell, nozzle, x + Math.cos(a) * d * 2, y + d, z - Math.sin(a) * d * 2, a, Math.PI / 2);
  }

  // the crew window band, three panes behind the forward flaps
  const pane = new THREE.CylinderGeometry(R + 0.05, R + 0.05, 0.55, 6, 1, true, 0.28, 0.12);
  for (let i = 0; i < 3; i++) put(pane, glass, 0, NOSE0 - 5.2 + i * 1.5, 0);

  // cupper: the four steel lifting bands the chopsticks actually grab
  const cup = new THREE.TorusGeometry(R + 0.14, 0.16, 6, 40);
  for (const y of [BOOT - 1.4, BOOT - 3.2]) put(cup, hinge, 0, y, 0, 0, Math.PI / 2);

  // a fill/drain line running up the windward side, and the ladder down the aft
  const line = new THREE.CylinderGeometry(0.09, 0.09, BOOT - 6, 8);
  put(line, dark, Math.sin(Math.PI / 2) * (R + 0.1), BOOT / 2 - 1, Math.cos(Math.PI / 2) * (R + 0.1));
  const rail = new THREE.BoxGeometry(0.07, BOOT - 10, 0.07);
  for (const a of [-0.1, 0.1]) put(rail, hinge, Math.sin(Math.PI / 2 + a) * (R + 0.12), BOOT / 2 - 3, Math.cos(Math.PI / 2 + a) * (R + 0.12));
  for (let y = 4; y < BOOT - 8; y += 1.1)
    put(new THREE.BoxGeometry(0.5, 0.06, 0.06), hinge, 0, y, R + 0.16);

  // the wordmark, painted on the aft stainless on the lee side
  put(new THREE.CylinderGeometry(R + 0.06, R + 0.06, 2.5, 24, 1, true, -Math.PI / 2 - 0.34, 0.68),
    paint, 0, 11.5, 0);

  g.rotation.y = 0.42;                                 // show the tile seam, not the dead centre
  return { group: g, height: TIP, radius: R + 0.6, flaps, mats: [steel, burnt, tps, dark, hinge, glass, nozzle, paint] };
}
