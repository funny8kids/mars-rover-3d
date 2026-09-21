// ─────────────────────────────────────────────────────────────────────────────────────
// Two vehicles that have to be recognised, not merely suggested, from ten metres away:
// a Tesla Optimus standing at a charging mast, and the pressurised crew rover it services.
// Both are built at their real dimensions in metres — 1.73 tall, 3.9 long — because a
// humanoid's readability *is* its proportion, and a bot built on feel reads as a toy.
// ─────────────────────────────────────────────────────────────────────────────────────

export function createOptimus(THREE) {
  const g = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0xe6e4df, roughness: 0.28, metalness: 0.06 });
  const poly = new THREE.MeshStandardMaterial({ color: 0x1c1c1f, roughness: 0.44, metalness: 0.22 });
  const joint = new THREE.MeshStandardMaterial({ color: 0x8e8d8a, roughness: 0.3, metalness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0a1014, roughness: 0.06, metalness: 0.5 });
  // The eye bars are the only light the figure makes, so their albedo stays dark and carry the
  // colour in emissive — the day/night drive in props.js is what stops them reading as two white
  // holes under a noon sun.
  const eye = new THREE.MeshStandardMaterial({ color: 0x16242a, emissive: 0x9fd4e8, emissiveIntensity: 1.1 });
  eye.userData.dimDay = 0.22;

  const box = (w, h, d, mat, x, y, z, parent = g, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    parent.add(m); return m;
  };
  const cap = (r, len, mat, x, y, z, parent = g, rz = 0) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 14), mat);
    m.position.set(x, y, z); m.rotation.z = rz;
    parent.add(m); return m;
  };
  const disc = (r, h, mat, x, y, z, axis = 'y', parent = g) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 18), mat);
    m.position.set(x, y, z);
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    parent.add(m); return m;
  };

  // ── head: a white shell with a full-width dark visor, not a sphere with eyes stuck on ──
  // It sits almost on the shoulders. A visible neck is what made the first pass read as a signpost
  // rather than a figure — Optimus has barely 30 mm between chin and collar.
  box(0.21, 0.15, 0.2, shell, 0, 1.552, 0, g, 0, 0.16);
  box(0.192, 0.078, 0.024, glass, 0, 1.55, 0.092, g, 0, 0.16);
  for (const s of [-1, 1]) box(0.04, 0.015, 0.012, eye, s * 0.047, 1.557, 0.104, g, 0, 0.16);
  disc(0.018, 0.034, joint, 0.105, 1.552, 0, 'x');             // ear pods
  disc(0.018, 0.034, joint, -0.105, 1.552, 0, 'x');
  cap(0.046, 0.03, poly, 0, 1.465, 0);                         // neck
  disc(0.06, 0.024, joint, 0, 1.437, 0);                       // neck bearing

  // ── torso: white chest carapace over a black frame, with the waist cartridge below ──
  box(0.315, 0.31, 0.185, poly, 0, 1.28, -0.012);
  box(0.34, 0.27, 0.205, shell, 0, 1.325, 0.014);
  box(0.19, 0.055, 0.022, joint, 0, 1.425, 0.115);             // collar trim
  box(0.055, 0.04, 0.014, poly, 0, 1.385, 0.126);              // chest badge
  box(0.29, 0.33, 0.1, poly, 0, 1.26, -0.15);                  // backpack
  box(0.09, 0.09, 0.022, joint, 0, 1.4, -0.205);               // backpack latch
  disc(0.13, 0.15, poly, 0, 1.05, 0);                          // waist cartridge
  disc(0.136, 0.022, joint, 0, 0.968, 0);                      // hip bearing
  box(0.3, 0.13, 0.175, poly, 0, 0.9, 0);                      // pelvis

  // ── arms: a shoulder → elbow → wrist chain, so a bent arm reads as a pose and not a coat rack ──
  const arm = (s, shoulder, elbow, grip) => {
    const sh = new THREE.Group();
    sh.position.set(s * 0.23, 1.385, 0);
    sh.rotation.z = -s * shoulder;
    g.add(sh);
    cap(0.058, 0.055, shell, 0, -0.015, 0.005, sh);            // pauldron
    disc(0.06, 0.07, joint, 0, -0.03, 0, 'z', sh);             // shoulder
    cap(0.048, 0.19, poly, 0, -0.175, 0, sh);                  // upper arm
    const el = new THREE.Group();
    el.position.set(0, -0.3, 0);
    el.rotation.z = -s * elbow;
    sh.add(el);
    disc(0.045, 0.052, joint, 0, 0, 0, 'z', el);               // elbow
    cap(0.042, 0.185, poly, 0, -0.14, 0.005, el);              // forearm
    const wr = new THREE.Group();
    wr.position.set(0, -0.275, 0.005);
    wr.rotation.z = -s * grip;
    el.add(wr);
    disc(0.036, 0.04, joint, 0, 0, 0, 'z', wr);                // wrist
    box(0.055, 0.09, 0.03, poly, 0, -0.055, 0, wr);            // palm
    for (let i = 0; i < 4; i++)
      box(0.012, 0.055, 0.017, poly, -0.019 + i * 0.0128, -0.122, 0.002, wr);
    box(0.015, 0.045, 0.017, poly, s * 0.028, -0.075, 0.014, wr, 0, 0, s * 0.6);  // thumb
    return { sh, el, wr };
  };
  arm(-1, 0.09, 0.12, 0);
  const right = arm(1, 0.62, 1.15, -0.35);                     // raised, holding the service panel
  // the panel itself, gripped at chest height
  box(0.19, 0.14, 0.035, joint, 0, -0.16, 0.05, right.wr);
  box(0.05, 0.05, 0.05, poly, 0, -0.16, 0.09, right.wr);

  // ── legs: a stance wide enough that the two of them read as two ──
  for (const s of [-1, 1]) {
    const hx = s * 0.118;
    disc(0.058, 0.06, joint, hx, 0.865, 0, 'z');               // hip
    cap(0.062, 0.25, poly, hx, 0.68, 0);                       // thigh
    disc(0.054, 0.055, joint, hx, 0.5, 0.005, 'z');            // knee
    cap(0.048, 0.27, poly, hx, 0.31, -0.005);                  // shin
    box(0.105, 0.058, 0.24, poly, hx, 0.03, 0.032);            // foot
    box(0.092, 0.024, 0.06, joint, hx, 0.064, 0.108);          // toe plate
  }

  g.rotation.y = -0.5;
  return { group: g, height: 1.73, emissives: [eye] };
}

export function createCrewRover(THREE) {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xcfc8bb, roughness: 0.52, metalness: 0.18 });
  // Regolith clings to everything below the splash line, so the wear is a material, not a decal.
  const dusty = new THREE.MeshStandardMaterial({ color: 0x8a6a4c, roughness: 0.92, metalness: 0.05 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1917, roughness: 0.95, metalness: 0.02 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x4a4741, roughness: 0.62, metalness: 0.7 });
  const gold = new THREE.MeshStandardMaterial({ color: 0x8e7a4e, roughness: 0.4, metalness: 0.85 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x16232a, roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.72,
  });
  const lamp = new THREE.MeshStandardMaterial({ color: 0x2b2a24, emissive: 0xffd9a0, emissiveIntensity: 1.2 });
  lamp.userData.dimDay = 0.26;

  const put = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    g.add(m); return m;
  };
  const box = (w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) =>
    put(new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz);
  // a cylinder laid along its side: the wheels, hull and drums all run fore-aft or athwartships
  const roll = (rt, rb, len, mat, x, y, z, axis = 'x', seg = 18) =>
    put(new THREE.CylinderGeometry(rt, rb, len, seg), mat, x, y, z,
      axis === 'z' ? Math.PI / 2 : 0, 0, axis === 'x' ? Math.PI / 2 : 0);

  // ── wheels: six, on a rocker-bogie so the rover can walk over a boulder its own height ──
  const wheel = (x, z) => {
    roll(0.42, 0.42, 0.32, rubber, x, 0.42, z, 'z', 22);
    roll(0.2, 0.2, 0.34, frame, x, 0.42, z, 'z', 12);
    roll(0.09, 0.09, 0.38, gold, x, 0.42, z, 'z', 10);
    // grousers: the cleats that make a Mars wheel look like a Mars wheel
    for (let i = 0; i < 14; i++) {
      const a = i / 14 * Math.PI * 2;
      box(0.06, 0.055, 0.3, rubber, x + Math.cos(a) * 0.43, 0.42 + Math.sin(a) * 0.43, z, 0, 0, a);
    }
  };
  for (const x of [-1.45, 0, 1.45]) { wheel(x, 1.02); wheel(x, -1.02); }
  // rockers, steer yokes and the differential bars
  for (const z of [1, -1]) {
    box(3.1, 0.09, 0.11, frame, 0, 0.62, z * 0.9);
    for (const x of [-1.45, 0, 1.45]) box(0.1, 0.5, 0.1, frame, x, 0.55, z * 0.78, z * 0.35);
  }
  box(0.1, 0.1, 1.9, frame, 0.75, 0.9, 0);
  box(0.1, 0.1, 1.9, frame, -0.75, 0.9, 0);

  // ── chassis and the pressurised hull sitting on it ──
  box(3.7, 0.26, 1.9, dusty, 0, 1.02, 0);
  box(3.5, 0.08, 1.7, frame, 0, 1.18, 0);
  roll(0.66, 0.66, 2.75, paint, -0.1, 1.72, 0, 'x', 26);
  for (const x of [-1.3, -0.45, 0.4, 1.15])                    // pressure ribs
    roll(0.69, 0.69, 0.07, frame, x, 1.72, 0, 'x', 26);
  for (const s of [-1, 1])                                      // end domes
    put(new THREE.SphereGeometry(0.66, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      paint, s * 1.47, 1.72, 0, 0, 0, -s * Math.PI / 2);

  // ── the cupola: a crew must be able to look out, and the base must be able to see the crew ──
  put(new THREE.SphereGeometry(0.5, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), glass, 0.62, 2.14, 0);
  roll(0.51, 0.51, 0.08, frame, 0.62, 2.15, 0, 'y', 24);        // coaming
  for (let i = 0; i < 4; i++)                                   // mullions over the glass
    box(0.035, 0.5, 0.035, frame, 0.62, 2.36, 0, 0, i * Math.PI / 4);
  // portholes down both flanks, each on a bolted flange
  for (const z of [1, -1]) for (const x of [-1.05, -0.2, 0.65]) {
    roll(0.17, 0.17, 0.07, glass, x, 1.78, z * 0.66, 'z', 16);
    roll(0.2, 0.2, 0.05, frame, x, 1.78, z * 0.65, 'z', 16);
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2;
      box(0.03, 0.03, 0.04, gold, x + Math.cos(a) * 0.185, 1.78 + Math.sin(a) * 0.185, z * 0.69);
    }
  }

  // ── airlock, ladder and the work rack on the roof ──
  roll(0.34, 0.34, 0.16, frame, -1.62, 1.72, 0, 'x', 20);
  roll(0.26, 0.26, 0.08, gold, -1.72, 1.72, 0, 'x', 16);
  for (let i = 0; i < 3; i++) box(0.04, 0.6, 0.05, frame, -1.76, 1.72, 0, i / 3 * Math.PI, 0);
  for (let i = 0; i < 4; i++) box(0.34, 0.045, 0.05, frame, -1.98, 0.4 + i * 0.33, 0, 0, 0, 0.35);
  box(1.5, 0.06, 1.1, frame, -0.35, 2.42, 0);                   // roof rack
  for (const [x, z] of [[-0.95, 0.45], [-0.95, -0.45], [0.25, 0.45], [0.25, -0.45]])
    box(0.06, 0.16, 0.06, frame, x, 2.32, z);
  for (const s of [-1, 1]) {                                    // folded solar wings
    box(1.25, 0.045, 0.86, gold, -0.35, 2.5 + Math.abs(s) * 0.02, s * 0.52, s * 0.22);
    box(1.28, 0.03, 0.05, frame, -0.35, 2.53, s * 0.5, s * 0.22);
  }
  // mast: a camera head on a telescoping pole, the rover's eyes above the dust it kicks up
  roll(0.035, 0.045, 0.95, frame, 1.25, 2.85, 0.35);
  box(0.22, 0.14, 0.13, frame, 1.25, 3.36, 0.35);
  for (const z of [0.3, 0.4]) roll(0.035, 0.035, 0.06, glass, 1.37, 3.36, z, 'x', 12);
  roll(0.008, 0.012, 0.7, frame, 1.05, 3.1, -0.3);              // whip antenna

  // ── front end: bumper, lamps, winch, and the utility mounts it tows equipment with ──
  box(0.14, 0.42, 1.85, dusty, 1.86, 1.06, 0);
  for (const z of [-0.62, 0.62]) {
    roll(0.13, 0.13, 0.1, lamp, 1.94, 1.2, z, 'x', 14);
    roll(0.16, 0.16, 0.05, frame, 1.9, 1.2, z, 'x', 14);
  }
  roll(0.11, 0.11, 0.42, frame, 1.9, 0.86, 0, 'x', 12);         // winch drum
  box(0.06, 0.16, 0.5, gold, 1.93, 1.42, 0);                    // hazard bar
  for (const z of [-0.5, 0.5]) {
    box(0.5, 0.34, 0.16, dusty, -1.35, 1.28, z);
    box(0.06, 0.4, 0.06, frame, -1.35, 1.62, z);
  }

  return { group: g, length: 4.1, width: 2.4, height: 3.4, emissives: [lamp] };
}
