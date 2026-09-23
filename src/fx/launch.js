import * as THREE from 'three';

// ─── the launch, as two vehicles ───
// The stack leaves the pad as one silhouette and crosses the sky as two. Everything the finale shows
// — the separation, the booster coming home, the ship's climb — comes out of the one integrator here,
// so the telemetry panel (task #58) can never disagree with where the mesh actually is: altitude is
// the integral of the velocity the vehicle carries, acceleration is its derivative, and the figures
// on the panel are read off the same vectors just written into the scene graph.
//
// What this file deliberately does *not* do is pretend to be a real ascent. Mars gravity is real, the
// guidance law that brings the booster home is real, and the order of events follows a staged orbital
// attempt. The heights are not: at one second of mission time per second of wall clock, a vehicle
// that separates at 30 km is a dot below the horizon long before anyone on the watch deck sees two
// bodies come apart. Staging here happens around a kilometre, where the separation is actually
// legible, and every figure the sim prints is the figure the vehicle really has at that moment. The
// climb stays nearly vertical for the same reason: the island is 118 m across and the camera's far
// plane is 9 km, so a real gravity turn would put the vehicle 10 km downrange over nothing.
//
// The one piece worth being exact about is the booster. It is not animated along a hand-authored
// curve: it is flown by powered-descent guidance back to the pad it left, so it always arrives, and
// the flip that reads so well from the deck falls out of the guidance vector instead of being keyed.

const G_MARS = 3.71;              // m/s², the surface of the planet this is set on
const SOUND_MARS = 240;           // m/s, speed of sound in a 220 K CO₂ column
const HOLD_DOWN = 3.2;            // s from engine start until the stack makes more thrust than it weighs
const SEPARATION_PUSH = 1.4;      // m/s, the stage bolts' share of the split, per body
const RETURN_MAX_ACCEL = 26;      // m/s², the Raptor field's authority over an almost-empty tank
// The descent profile the return is flown against, and the numbers that make it land rather than
// arrive. The first measured flight touched the deck at 97 m/s: a fixed time-to-pad can run out
// while the vehicle is still falling, and no amount of clamping the command after that makes the
// missing altitude come back. So the allowed sink rate is capped by the distance actually left —
// but a cap alone still arrived at 28 m/s, because a feedback loop only discovers that it has
// fallen behind after it already has, and the deficit it carries into the last hundred metres is
// then the arrival speed. The profile's own deceleration is known in advance (see PROFILE_DECEL),
// so the command supplies it as feedforward instead of waiting to be chased into it: measured at
// 2.8 m/s down and 2.1 m off the pad centre, and the same at 15 fps as at 60.
const NET_BRAKE = RETURN_MAX_ACCEL - G_MARS;              // m/s² left once the vehicle's weight is paid for
const DESCENT_LAMBDA = 0.8;                               // how much of the stoppable rate to ask for
// Substituting sink = λ·√(2·a·h) into dh/dt = sink makes the derivative come out constant — which is
// the whole reason to fly a √h profile: the brake it asks for never changes, so it can be fed forward.
const PROFILE_DECEL = DESCENT_LAMBDA * DESCENT_LAMBDA * NET_BRAKE;   // m/s², λ²·a
const TERMINAL_SINK = 1.8;                                // m/s at touchdown — it is flown down, not dropped
const FLOOR_H = 0.4;                                      // m, how low the profile is allowed to read the deck
const GUIDANCE_TAU = 0.85;                                // s, how fast the vehicle chases the profile

// Net tangential acceleration along the flight path, in mission seconds: the shape of a heavy
// launcher — barely lifting off, easing back through max Q, then running away from itself as the
// tanks empty. The integrator turns this into velocity and altitude; nothing else defines them.
const THRUST_TABLE = [
  [0, 3, 2.4],        // release: the stack just clears the tower
  [3, 7, 6.0],
  [7, 13, 4.5],       // max-Q bucket
  [13, 20, 9.5],      // through it, then the booster's engines run down
  [20, 22, 4.0],
  [22, 38, 14.0],     // the ship's three, alone on an almost-empty vehicle
  [38, 46, 8.0],      // thinning air, thinning mass
];
const SECO_AT = 46;               // mission second the ship's engines shut down
const STAGE_AT = 22;              // the hot-staging beat, 2 s after the ship lights
// How far the vehicle leans over, and how fast it starts to. Tied to altitude rather than time
// because a gravity turn *is* the vehicle leaning into thinning air, and an altitude law gives the
// same arc at 30 fps and at 144.
const GAMMA_MAX = 0.19, GAMMA_ALT = 900;

// The beats the finale is built out of. `id` is what the HUD, the audio and the effects all key on,
// so a beat can never be announced in one place and skipped in another. `liftoff` is absent on
// purpose: it belongs to the moment the thrust actually beats the weight, which the hold-down ramp
// decides, not the clock.
const BEATS = [
  { t: 7, id: 'maxq', zh: '最大动压', en: 'Max-Q' },
  { t: 13, id: 'throttleup', zh: '通过最大动压 · 推力回升', en: 'Throttle up' },
  { t: 20, id: 'meco', zh: '助推级主发动机关机', en: 'Boost MECO' },
  { t: 20.4, id: 'shipignition', zh: '飞船发动机点火', en: 'Ship ignition' },
  { t: STAGE_AT, id: 'staging', zh: '级间分离', en: 'Staging' },
  { t: STAGE_AT + 6, id: 'boostback', zh: '助推级返场点火', en: 'Boostback' },
  { t: SECO_AT, id: 'seco', zh: '主发动机关机 · 飞出稠密大气', en: 'SECO' },
];

function accelAt(t) {
  for (const [a, b, v] of THRUST_TABLE) if (t >= a && t < b) return v;
  return 0;
}

export function createLaunch(rig, launch) {
  const seam = rig.seam, top = rig.h;
  // Pivot each body about, in stack-local metres: a mated stack balances low because the loaded
  // booster is the mass, a lone ship balances near its own middle. Rotating a rocket about anything
  // other than its balance point is the hinge-door look this replaces.
  const COM = {
    mated: seam * 0.46,
    booster: seam * 0.52,
    upper: seam + (top - seam) * 0.44,
  };

  // Outbound is away from the middle of the island: the vehicle should climb over the open rim, not
  // over the habitat it was built beside.
  const dir = new THREE.Vector3(rig.pad[0], 0, rig.pad[2]);
  if (dir.lengthSq() < 1) dir.set(0, 0, 1); else dir.normalize();
  // Pitching happens about the horizontal axis perpendicular to that heading, so the whole flight
  // stays in one vertical plane however the pad happens to sit on the island.
  const PIVOT_AXIS = new THREE.Vector3(dir.z, 0, -dir.x);
  const UP = new THREE.Vector3(0, 1, 0);
  const _q = new THREE.Quaternion(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

  // The engine bells are the lowest thing on each body, so the plane the plume leaves from is that
  // body's own bounding-box floor — measured off the asset once, in the frame the parts hang in
  // (stack-local metres), which is what `at()` downstream expects.
  const mouthOf = (node) => rig.stack.worldToLocal(_a.set(0, new THREE.Box3().setFromObject(node).min.y, 0)).y;

  // One body's pose: `d` displaces its datum from the mount, `phi` leans it about PIVOT_AXIS.
  const makeBody = (node, rest, pivot) => ({
    node, rest, pivot, d: new THREE.Vector3(), phi: 0,
    pos: new THREE.Vector3(), q: new THREE.Quaternion(),
    apply() {
      // Pivoting a node about a point it does not own is the whole trick: the parts hang off the node
      // in absolute stack metres, so writing `rotation` alone would swing a 38 m booster about its
      // own tail like a gate. No re-parenting, no re-baking the merged buffers.
      _q.setFromAxisAngle(PIVOT_AXIS, this.phi);
      _a.set(0, this.pivot, 0).sub(rest).applyQuaternion(_q).add(_b.set(0, this.pivot, 0)).add(this.d);
      this.pos.copy(_a);
      this.q.copy(_q);
      this.node.position.copy(this.pos);
      this.node.quaternion.copy(this.q);
      return this;
    },
    // World metres of a point `y` up the stack, carried by this body. `at()` answers in the frame
    // everything outside the stack is written in, because the camera, the rings and the particle
    // systems all read it — the body's own numbers stay stack-local, where they belong.
    at(out, y) { out.copy(this.pos).add(_a.set(0, y, 0).sub(this.rest).applyQuaternion(this.q)); return rig.stack.localToWorld(out); },
    // The body's own nose direction. Exhaust leaves the other way; a rocket accelerates along it.
    axis(out) { return out.copy(UP).applyQuaternion(this.q); },
  });
  const ship = makeBody(rig.upper, rig.rest.upper, COM.upper);
  const booster = makeBody(rig.booster, rig.rest.booster, COM.mated);

  const L = {
    met: 0,
    running: false,
    done: false,
    v: 0,                                   // m/s along the flight path
    alt: 0,                                 // m above the pad deck, of the vehicle datum
    down: 0,                                // m of ground distance from the pad
    gamma: 0,                               // rad of lean from vertical, shared until staging
    ramp: 0,                                // 0..1 engine start, and everything that hangs off it
    engines: rig.engines,
    litBooster: 0,
    litUpper: 0,
    separated: false,
    landed: false,
    fired: new Set(),
    log: [],                                // {met, id, zh, en, alt, vel} — the event record
    pending: [],                            // beats since the last drain
    path: new THREE.Vector3(),              // the ship's datum, pad-relative metres
    bPos: new THREE.Vector3(),              // the booster's, once it is on its own
    bVel: new THREE.Vector3(),
    bPhi: 0,
    tGo: 0,                                 // s to the deck, recomputed by guidance every frame
    touch: null,                            // how the booster actually came home
    written: false,                         // first frame: seed the plumes' swept paths
    shipAim: new THREE.Vector3(),           // world metres of whatever the camera should look at
    tel: { met: 0, alt: 0, vel: 0, accel: 0, down: 0, mach: 0, gamma: 0,
      litBooster: 0, litUpper: 0, separated: false },
    // Everything the effects and the plume seeding need, per vehicle, already in world metres. The
    // engine tally rides along so the particle budget is spent per lit bell rather than per vehicle —
    // a ship on three engines should not throw as much fire as a booster on sixteen.
    plumes: [
      { body: booster, engines: rig.engines.booster, mouth: mouthOf(rig.booster), pos: new THREE.Vector3(),
        prev: new THREE.Vector3(), axis: new THREE.Vector3(), power: 0 },
      { body: ship, engines: rig.engines.upper, mouth: mouthOf(rig.upper), pos: new THREE.Vector3(),
        prev: new THREE.Vector3(), axis: new THREE.Vector3(), power: 0 },
    ],
  };

  const fire = (id, t, zh, en) => {
    if (L.fired.has(id)) return;
    L.fired.add(id);
    L.log.push({ met: t, id, zh, en, alt: +L.alt.toFixed(1), vel: +L.v.toFixed(1) });
    L.pending.push({ id, t, zh, en });
  };
  L.drain = () => { const p = L.pending.slice(); L.pending.length = 0; return p; };

  // One call per launch: everything starts from the stance props.js authored.
  L.start = () => { L.running = true; };

  // A point `y` up the stack in world metres, whichever body carries it — before staging the mated
  // stack, afterwards the half that owns the height. So a probe can keep pointing at the vehicle
  // through the split instead of at the number it was written for.
  L.point = (out, y) => (y < seam || !L.separated ? booster : ship).at(out, y);

  L.update = (dt) => {
    if (!L.running || L.done) return false;
    const t = (L.met += dt);

    // ── the ship's leg: engine start, then one authored thrust profile, integrated ──
    const gross = (t < SECO_AT ? accelAt(t) : 0) + G_MARS;
    L.ramp = t < HOLD_DOWN ? (t / HOLD_DOWN) ** 2 : 1;
    const a = Math.max(0, gross * L.ramp - G_MARS);
    L.v += a * dt;
    L.gamma = GAMMA_MAX * (L.alt / (L.alt + GAMMA_ALT));
    const s = Math.sin(L.gamma), c = Math.cos(L.gamma);
    _a.set(dir.x * s, c, dir.z * s);
    L.path.addScaledVector(_a, L.v * dt);
    if (L.path.y < 0) L.path.y = 0;          // still bolted to the deck
    L.alt = L.path.y;
    L.down = Math.hypot(L.path.x, L.path.z);
    if (L.alt > 0.5) fire('liftoff', t, '升空', 'Liftoff');

    // ── the booster's leg: guided home, not animated ───────────────────────────────
    if (!L.separated) {
      L.bPos.copy(L.path);
      L.bVel.copy(_a).multiplyScalar(L.v);
      L.bPhi = L.gamma;
    } else if (!L.landed) {
      // Powered-descent guidance against a stop-distance profile. The allowed sink rate is the fastest
      // one the field could still brake away over the height actually left (`v² = 2·a·h`, run backwards),
      // so the vehicle is never asked to stop from a rate it has no air left to stop from — the failure
      // that put the first flight on the deck at 97 m/s.
      const h = Math.max(L.bPos.y, FLOOR_H);
      const vSink = Math.max(TERMINAL_SINK, DESCENT_LAMBDA * Math.sqrt(2 * NET_BRAKE * h));
      // Time this profile takes to close: averaging a √h decay is exactly 2h over its end rate.
      const T = Math.max(2 * h / vSink, 1.2);
      L.tGo = T;
      // Horizontal target empties the remaining offset over that same time, so the vehicle arrives at
      // the pad with its ground distance spent rather than still coasting sideways through it.
      _b.set(-L.bPos.x / T - L.bVel.x, -vSink - L.bVel.y, -L.bPos.z / T - L.bVel.z)
        .multiplyScalar(1 / GUIDANCE_TAU);
      // Weight plus the profile's own constant deceleration. The first term is what the vehicle has to
      // beat to hold still; the second is what it has to *spend* to follow a curve that keeps easing
      // toward zero, and a feedback loop alone only discovers that after it has already fallen behind —
      // measured as a 28 m/s arrival at this lag, against 2.8 m/s with the term present. It is applied
      // only while the profile is actually being flown: handed out during the outward coast it cancels
      // the return's own authority, and the booster then stands in the sky forever instead of landing.
      if (L.bVel.y < -0.5 && L.bPos.y > FLOOR_H) _b.y += PROFILE_DECEL;
      _b.y += G_MARS;                              // the field carries the vehicle's weight, then steers
      const mag = _b.length();
      if (mag > RETURN_MAX_ACCEL) _b.multiplyScalar(RETURN_MAX_ACCEL / mag);
      L.bVel.y -= G_MARS * dt;
      L.bVel.addScaledVector(_b, dt);
      L.bPos.addScaledVector(L.bVel, dt);
      // Engines point where the thrust does. This is the whole flip: guidance asks for a retro-burn
      // while the booster is still climbing away, so it turns itself around on its own.
      const want = _b.lengthSq() > 1 ? _a.copy(_b).normalize() : _a.copy(L.bVel).normalize();
      L.bPhi = Math.atan2(want.dot(dir), want.y);
      if (L.bPos.y <= 0) {
        L.bPos.y = 0;
        // What the arrival actually cost, taken before the state is zeroed: the whole point of flying
        // this leg by guidance is that the touch-down speed is an outcome, so it has to be measured.
        L.touch = { t: +t.toFixed(1), offPad: +Math.hypot(L.bPos.x, L.bPos.z).toFixed(1),
          sink: +L.bVel.y.toFixed(1), tGo: +L.tGo.toFixed(1) };
        L.bVel.set(0, 0, 0);
        L.landed = true;
        fire('boosterlanding', t, '助推级回到发射台', 'Booster landed');
      }
    }

    // ── the beats ───────────────────────────────────────────────────────────────────
    for (const bt of BEATS) if (t >= bt.t) fire(bt.id, t, bt.zh, bt.en);
    if (L.fired.has('staging') && !L.separated) {
      L.separated = true;
      // Seed the separated state from the mated one, then give each body the bolts' push along the
      // vehicle's own axis. Doing it here rather than in the beat list means the split can never be
      // announced without actually happening.
      L.bPos.copy(L.path);
      L.bVel.copy(_a.set(dir.x * s, c, dir.z * s)).multiplyScalar(L.v - SEPARATION_PUSH);
      L.bPhi = L.gamma;
      L.v += SEPARATION_PUSH;
      booster.pivot = COM.booster;
      ship.pivot = COM.upper;
    }

    // ── who is lit ────────────────────────────────────────────────────────────────────
    L.litBooster = L.ramp > 0.05 && !L.landed && (t < SECO_AT || !L.separated) ? L.engines.booster : 0;
    L.litUpper = L.ramp > 0.05 && L.separated && t < SECO_AT ? L.engines.upper : 0;

    // ── write the scene ─────────────────────────────────────────────────────────────
    booster.d.copy(L.separated ? L.bPos : L.path);
    booster.phi = L.separated ? L.bPhi : L.gamma;
    ship.d.copy(L.path);
    ship.phi = L.gamma;
    booster.apply();
    ship.apply();
    for (const p of L.plumes) {
      p.prev.copy(p.pos);
      p.body.at(p.pos, p.mouth);
      p.body.axis(p.axis).negate();
      p.power = (p.body === booster ? L.litBooster : L.litUpper) ? L.ramp : 0;
    }
    if (!L.written) { L.plumes.forEach(p => p.prev.copy(p.pos)); L.written = true; }
    L.point(L.shipAim, L.separated ? (seam + top) / 2 : 20);

    L.tel.met = t; L.tel.alt = L.alt; L.tel.vel = L.v; L.tel.accel = a;
    L.tel.down = L.down; L.tel.mach = L.v / SOUND_MARS; L.tel.gamma = L.gamma;
    L.tel.litBooster = L.litBooster; L.tel.litUpper = L.litUpper; L.tel.separated = L.separated;

    // The state main.js already reads everywhere. `y` stays the datum height so the camera rig, the
    // line-of-sight probe and the weather gate all keep working off the same number the mesh moved by.
    launch.y = L.alt;
    launch.t = t;
    launch.tilt = L.gamma;
    launch.intensity = L.ramp * (L.separated ? Math.max(0.35, 1 - (t - STAGE_AT) * 0.02) : 1);
    launch.separated = L.separated;
    launch.boosterLanded = L.landed;

    // The ship is out of range and the booster is home: that is the end of what can be watched.
    if (t >= SECO_AT + 4 && (L.landed || t >= SECO_AT + 24)) L.done = true;
    return true;
  };

  return L;
}
