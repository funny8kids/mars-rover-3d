import * as THREE from 'three';
import { fbm, clamp, lerp, smoothstep } from '../utils/noise.js';

// ═════════════════════════════════════════════════════════════════════════════
// The storm as a *thing that travels*, not a weather switch.
//
// The old implementation was one scalar: `env.storm` eased 0→1 and every consumer
// (fog density, fog colour, sun, hemi, amb, sky mix, godrays, vignette, grain, dirt,
// bloom threshold) lerped on that same number. Measured 2026-09-22, that produced a
// frame whose luminance histogram collapsed from bins 1-7 into bins 1-3 — the whole
// bright half of the tonal range deleted, the gate reduced to a silhouette, and not one
// visible dust mote in frame, because the emitter ring sat above and behind the camera.
// It also could not do the two things that make a Martian storm read: it arrives from
// somewhere, and it is thickest at your boots.
//
// So this module owns a *position*, not a mood: two edges marching along a wind axis,
// with the dust held in the air between them. Everything else — fog, particles, the wall
// mesh, the solar yield, the radio link — samples that field, so they cannot disagree.
// ═════════════════════════════════════════════════════════════════════════════

// Seconds. The calm gap is longer than a cruise lap, so a storm stays an event rather than
// background flicker, and the warning is long enough to drive somewhere on purpose.
const HOLD = { calm: [140, 230], watch: 42, peak: 26, aftermath: 55 };
const LEAD_SPEED = 21;    // m/s — the wall crosses the 300 m island in ~14 s
const TAIL_SPEED = 27;    // the clearing edge runs faster, so the back side is quick
const SPAWN = 320;        // edges start and end this far out along the wind axis
const SLAB_TAIL = 260;    // how far behind the leading edge a fresh event drags its back edge
const BAND = 46;          // metres of ramp between clear air and full dust

// How much clean air is still in front of the wall when the front launches. `watch` stalks the wall
// toward the settlement at a fraction of the front's speed, and that fraction has to be small enough
// for the build-up to END with the wall still out there. It was half the front speed for 42 s, which
// is 441 m — the face crossed the island centre 14 s before the launch, the front phase was left 39 m
// to walk (1.9 s measured), and the bar was counting down to an approaching storm over a settlement
// already under dust. Measured 2026-09-22.
const FACE_AT_LAUNCH = 150;
const WATCH_CREEP = (SPAWN - BAND - FACE_AT_LAUNCH) / HOLD.watch;   // 2.95 m/s

const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));

export class StormField {
  constructor(surfaceAt) {
    this.surfaceAt = surfaceAt;
    this.phase = 'calm';
    this.hold = lerp(...HOLD.calm);
    this.t = 0;
    this.tick = 0;               // never frozen — see advance()
    this.heading = Math.random() * Math.PI * 2;
    this.targetHeading = this.heading;
    this.h0 = this.heading;      // the bearing the current event was drawn with — see advance()
    this.veer = 0;               // its own clock, so the wander starts at zero on every event
    this.wx = Math.cos(this.heading); this.wz = Math.sin(this.heading);
    this.edge = -SPAWN; this.trail = -SPAWN;
    this.amplitude = 0;          // how much dust the air holds, 0..1
    this.speed = 0;              // wind speed, m/s
    this.gust = 0;               // 0..1 gust envelope target
    this.gustEnv = 0;            // gust envelope with the high-frequency wobble applied
    this.dustLoad = 0;           // 0..1 island-wide deposit: softens the ground, is not the ledger
    this.enabled = true;
    this.pinned = false;         // QA holds one phase; see pin()
    // Whose turn it is. While the mission chain is arming beats, `scheduled` stops the calm gap from
    // rolling its own dice, so a front always belongs to something the player is doing. `pendingLead`
    // is a beat that arrived while a slab was still crossing.
    this.scheduled = false;
    this.pendingLead = 0;
  }

  // Hold one phase at a fixed standoff from a point, so a clear-vs-storm screenshot pair is
  // repeatable instead of hostage to a random wind heading. The wall holds its distance, but the
  // weather inside the frame does not stop: the sheet rolls, the fingers drift, the gust wobbles.
  // `standoff` is how far the leading edge still is upwind of `focus` — positive frames the wall on
  // the horizon through clean air, negative buries the viewpoint inside the slab.
  pin(phase, focus, standoff = 150, heading = null) {
    this.enabled = false; this.pinned = true;
    if (heading !== null) {
      this.heading = this.targetHeading = heading;
      this.wx = Math.cos(heading); this.wz = Math.sin(heading);
    }
    // A held frame is framed on the bearing it was asked for, then allowed to breathe from there.
    this.h0 = this.heading; this.veer = 0;
    this.phase = phase; this.t = 0; this.hold = 1e6;
    const targets = { calm: [0, 1.6], watch: [0.2, 9], front: [1, 23], peak: [1, 26], clearing: [0.22, 7], aftermath: [0, 2.4] };
    const [a, s] = targets[phase] || targets.front;
    this.amplitude = a; this.speed = s; this.gust = a;
    const here = this.along(focus.x, focus.z);
    this.edge = here - standoff;
    this.trail = this.edge - SLAB_TAIL;  // the slab depth the front is dragging behind it
    return this;
  }
  // Queue the next front instead of rolling dice on it. `lead` is the seconds of warning the
  // player gets before the leading edge starts walking across the island, so the mission chain can
  // make a storm a deadline with a name — "复电四区，然后你有 100 秒" — rather than background noise.
  // Arming also takes the weather off the dice for good: from the first beat on, a front arrives
  // because a mission called for one. `freeSky()` hands the island back to its own weather.
  arm(lead = 100) {
    this.enabled = true; this.pinned = false; this.scheduled = true;
    // A beat that lands while a slab is still crossing queues behind that slab. Two fronts cannot
    // occupy one sky, and silently dropping the second would drop the mission beat with it.
    if (this.phase !== 'calm') { this.pendingLead = lead; return this; }
    this.pendingLead = 0;
    this.phase = 'calm'; this.t = 0;
    this.hold = Math.max(4, lead - HOLD.watch);
    return this;
  }

  // Clear skies until something is armed: the chain's first steps teach driving and power, and a
  // front during them is noise the player has no reason to read yet.
  holdSky() {
    this.enabled = true; this.pinned = false; this.scheduled = true; this.pendingLead = 0;
    this.phase = 'calm'; this.t = 0; this.hold = Infinity;
    return this;
  }
  // ...and the sandbox keeps its own storms once the chain is over.
  freeSky() {
    this.scheduled = false; this.pendingLead = 0;
    if (this.phase === 'calm') { this.t = 0; this.hold = lerp(...HOLD.calm); }
    return this;
  }

  // The legs an armed event still has to walk once its lead runs out, priced the way `_startEvent`
  // lays them out. Shared by the two ways a front can be pending: already held in calm, or queued
  // behind a slab still crossing.
  _eventLegs() {
    return HOLD.watch + (SPAWN * 0.5 + SPAWN) / LEAD_SPEED + HOLD.peak
      + (SPAWN + SPAWN + SLAB_TAIL) / TAIL_SPEED;
  }

  // Seconds until the slab that is crossing *now* has left and the sky hands the schedule back — the
  // moment a beat armed mid-storm can actually launch.
  _untilCalm() {
    const cross = Math.max(0, (SPAWN * 0.5 - this.edge) / LEAD_SPEED);
    const walkOff = Math.max(0, (SPAWN - this.trail) / TAIL_SPEED);
    switch (this.phase) {
      case 'watch': return Math.max(0, HOLD.watch - this.t) + cross + HOLD.peak + walkOff + HOLD.aftermath;
      case 'front': return cross + HOLD.peak + walkOff + HOLD.aftermath;
      case 'peak': return Math.max(0, HOLD.peak - this.t) + walkOff + HOLD.aftermath;
      case 'clearing': return walkOff + HOLD.aftermath;
      case 'aftermath': return Math.max(0, HOLD.aftermath - this.t);
      default: return 0;
    }
  }

  // Seconds until the sky is empty of a storm — including the front the mission chain has armed but
  // not yet launched. That second half is the whole point: a pad gate that only looked at how much
  // dust is down *right now* would happily ignite into a wall that is scheduled for the next minute,
  // breaking the promise the chain's last beat makes out loud.
  //
  // It is analytic, summed from the same legs `advance()` marches, because a countdown measured down
  // frame by frame drifts every time the wind veers. Each leg is recomputed from the live edge, so the
  // clock converges instead of accumulating error: it runs slightly fast while the wall creeps (the
  // build-up walks at WATCH_CREEP but is priced at LEAD_SPEED) and is exact from `front` onward.
  timeToClear() {
    // A beat queued behind a crossing slab is the case a pad gate must not miss. The current wall is
    // on its way out, so the sky reads clear for the whole aftermath — long enough to light the stack
    // into the *next* wall, which is the one promise the chain's last beat just made out loud.
    if (this.pendingLead) return this._untilCalm() + Math.max(4, this.pendingLead - HOLD.watch) + this._eventLegs();
    const cross = Math.max(0, (SPAWN * 0.5 - this.edge) / LEAD_SPEED);
    const walkOff = Math.max(0, (SPAWN - this.trail) / TAIL_SPEED);
    switch (this.phase) {
      case 'calm': {
        // Nothing scheduled, or a `holdSky` gap with no front queued: the air is as clear as it gets.
        const toLaunch = this.hold - this.t;
        if (!this.scheduled || !Number.isFinite(toLaunch) || toLaunch <= 0) return 0;
        return toLaunch + this._eventLegs();
      }
      case 'watch': return Math.max(0, HOLD.watch - this.t) + cross + HOLD.peak + walkOff;
      case 'front': return cross + HOLD.peak + walkOff;
      case 'peak': return Math.max(0, HOLD.peak - this.t) + walkOff;
      case 'clearing': return walkOff;
      // `aftermath` counts its seconds from `clearing`, so by the time the phase flips the slab has
      // already left and only the settled film is behind — which is a ground problem, not a sky one.
      default: return 0;
    }
  }

  // What the HUD is allowed to claim about the weather. Not "storming: yes/no" but what is coming,
  // in how long, from which quarter, and whether it is already on you — the four things that make a
  // warning actionable.
  // The countdown changes what it measures at the same moment the storm does. While the wall builds,
  // the answer the player can act on is "how long until the front commits", which is exactly knowable;
  // once it is walking, its own leading face and speed are what the clock counts. `weatherLabel` uses
  // two different words for the two, one per phase.
  // `on` is the veto: a point near the upwind rim is under the wall while the field still calls itself
  // `watch`, and a countdown must never out-rank the fact that dust is already falling there.
  outlook(focus) {
    let inFor = 0;
    if (this.phase === 'watch') inFor = Math.max(0, HOLD.watch - this.t);
    else if (this.phase === 'front') inFor = Math.max(0, this.eta(focus.x, focus.z));
    else if (this.phase === 'calm') inFor = Math.max(0, this.hold - this.t);
    return {
      phase: this.phase, in: inFor,
      on: this.local(focus.x, focus.z) > 0.03,
      bearing: (Math.atan2(this.wx, this.wz) * 180 / Math.PI + 360) % 360,
      speed: this.speed, load: this.dustLoad,
      // Whether the next front is a promise the mission chain made or a roll of the island's dice.
      // The HUD counts down to both, but only the armed one is announced while the gap is still long.
      scheduled: this.scheduled,
    };
  }

  unpin() {
    this.pinned = false; this.enabled = true;
    this.hold = this.scheduled ? Infinity : lerp(...HOLD.calm);
    return this;
  }

  // Put the field into a phase. The mission chain schedules storms through here instead of
  // rolling dice on top of the player, and the QA rig uses it to hold one for a screenshot.
  force(phase) {
    this.phase = phase; this.t = 0;
    this.hold = phase === 'calm' ? (this.scheduled ? Infinity : lerp(...HOLD.calm)) : 0;
    if (phase === 'watch' || phase === 'front') this._startEvent();
    // A forced front picks the event up where a natural one launches, so `force('front')` and a storm
    // that was allowed to build up are the same weather at the same distance.
    if (phase === 'front') this.edge = -FACE_AT_LAUNCH - BAND;
    return this;
  }

  _startEvent() {
    this.targetHeading = this.heading = Math.random() * Math.PI * 2;
    this.h0 = this.heading; this.veer = 0;
    this.wx = Math.cos(this.heading); this.wz = Math.sin(this.heading);
    this.edge = -SPAWN; this.trail = -SPAWN - SLAB_TAIL;
  }

  advance(dt, roverPos) {
    // Two clocks: `t` is the phase machine's timer and everything that should stop while QA holds
    // one phase; `tick` is the weather's own elapsed time, and keeps the streaks advecting and the
    // gust wobbling inside a pinned frame so a held storm is never a still image.
    this.tick += dt;
    if (!this.pinned) this.t += dt;
    const edge0 = this.edge, trail0 = this.trail;
    switch (this.phase) {
      case 'calm':
        this.amplitude = damp(this.amplitude, 0, 0.5, dt);
        this.speed = damp(this.speed, 1.6 + Math.sin(this.tick * 0.21) * 0.9, 0.6, dt);
        this.gust = damp(this.gust, 0, 1.2, dt);
        if (this.enabled && this.t > this.hold) { this.phase = 'watch'; this.t = 0; this._startEvent(); }
        break;

      // The wall is visible on the horizon before a single mote reaches you: the wind
      // picks up, the light goes flat, and the leading edge walks toward the settlement.
      case 'watch':
        this.amplitude = damp(this.amplitude, 0.2, 0.35, dt);
        this.speed = damp(this.speed, 9, 0.35, dt);
        this.gust = damp(this.gust, 0.35, 0.8, dt);
        this.edge += WATCH_CREEP * dt;      // it stalks while it builds; the launch closes the distance
        if (this.t > HOLD.watch) { this.phase = 'front'; this.t = 0; }
        break;

      case 'front':
        this.amplitude = damp(this.amplitude, 1, 0.5, dt);
        this.speed = damp(this.speed, 23, 0.5, dt);
        this.gust = damp(this.gust, 1, 0.7, dt);
        this.edge += LEAD_SPEED * dt;
        if (this.edge > SPAWN * 0.5) { this.phase = 'peak'; this.t = 0; }
        break;

      case 'peak':
        this.edge += LEAD_SPEED * dt;
        this.trail = Math.min(-SPAWN - 40, this.trail + 6 * dt);
        this.speed = damp(this.speed, 26, 0.4, dt);
        this.gust = damp(this.gust, 1, 0.6, dt);
        if (this.t > HOLD.peak) { this.phase = 'clearing'; this.t = 0; }
        break;

      // The back edge outruns the front, so the sky clears from the direction the storm
      // came from — the same asymmetry that makes the arrival readable.
      case 'clearing':
        this.edge = SPAWN + 240;
        this.trail += TAIL_SPEED * dt;
        this.amplitude = damp(this.amplitude, 0.22, 0.4, dt);
        this.speed = damp(this.speed, 7, 0.3, dt);
        this.gust = damp(this.gust, 0.2, 0.5, dt);
        if (this.trail > SPAWN) { this.phase = 'aftermath'; this.t = 0; }
        break;

      // Dust that was in the air is now on the ground, on the panels and on the paint.
      case 'aftermath':
        this.amplitude = damp(this.amplitude, 0, 0.45, dt);
        this.trail = SPAWN + 240;
        this.speed = damp(this.speed, 2.4, 0.4, dt);
        this.gust = damp(this.gust, 0.05, 0.9, dt);
        if (this.t > HOLD.aftermath) {
          this.edge = -SPAWN; this.trail = -SPAWN;
          this.phase = 'calm'; this.t = 0;
          // The sky goes back to whoever owns it: a queued mission beat, an armed schedule holding
          // for its next beat, or — after the chain is done — the island's own dice.
          if (this.pendingLead) { const lead = this.pendingLead; this.pendingLead = 0; this.arm(lead); }
          else this.hold = this.scheduled ? Infinity : lerp(...HOLD.calm);
        }
        break;
    }

    // A pinned field holds its geometry: the wall keeps its standoff from the camera instead of
    // marching out of frame while a screenshot pair is taken. The dust in it is still alive —
    // particles advect, the wall rolls on its own clock, and `tick` keeps the fingers drifting.
    if (this.pinned) { this.edge = edge0; this.trail = trail0; }

    // The wind wanders, it does not orbit. Two incommensurate sines around the bearing the event was
    // drawn with keep the crosswind shifting and the wall's line unmemorisable, while bounding the
    // total swing to ±31° — so the front really does come down the bearing the warning named. The
    // previous form added a positive rate for the whole phase: 410° per watch, measured, which is the
    // wall circling the settlement and every arrival estimate being fiction.
    this.veer += dt;
    this.targetHeading = this.h0 + Math.sin(this.veer * 0.045) * 0.35 + Math.sin(this.veer * 0.013) * 0.2;
    this.heading = damp(this.heading, this.targetHeading, 0.4, dt);
    this.wx = Math.cos(this.heading); this.wz = Math.sin(this.heading);

    // Two incommensurate sines over the envelope, so the buffeting never laps.
    this.gustEnv = this.gust * (0.55 + 0.45 * Math.sin(this.tick * 1.7 + Math.sin(this.tick * 0.43) * 2));

    const here = this.local(roverPos.x, roverPos.z);
    // Deposition is what a storm *leaves behind*: it accumulates while dust is airborne and
    // survives the clear sky. This one number is the terrain's share of that — how soft the settled
    // sand reads under the wheels. What the *base* pays for is tracked per surface in main.js, where
    // the rover can reach a given array with its lance and clear that one and not the whole island.
    this.dustLoad = clamp(this.dustLoad + here * dt * 0.010, 0, 1);
    if (this.phase === 'calm') this.dustLoad = clamp(this.dustLoad - dt * 0.0006, 0, 1);
    return here;
  }

  along(x, z) { return x * this.wx + z * this.wz; }
  cross(x, z) { return -z * this.wx + x * this.wz; }

  // How much of the dust slab has already passed this point, 0..1, ignoring how much dust
  // the air carries. Ahead of the front it is 0 — clear air, so the wall is seen *through*.
  coverage(x, z) {
    const s = this.along(x, z);
    const lead = 1 - smoothstep(this.edge - BAND * 0.4, this.edge + BAND, s);
    const tail = smoothstep(this.trail - BAND, this.trail + BAND * 0.4, s);
    return clamp(lead * tail, 0, 1);
  }

  // What the air holds here now: coverage × saturation × the fingers that break the slab up.
  // The noise scrolls with the wind, so the streaks travel instead of sliding along the deck.
  local(x, z) {
    const c = this.coverage(x, z);
    if (c <= 0 || this.amplitude <= 0.001) return 0;
    const u = (x - this.wx * this.edge) * 0.011, v = (z - this.wz * this.edge) * 0.011;
    const fingers = 0.55 + 0.45 * fbm(u + this.tick * 0.05, v - this.tick * 0.04, 3);
    return clamp(c * this.amplitude * fingers * 1.5, 0, 1);
  }

  // Seconds until the leading face of the slab reaches a point. That face is `BAND` ahead of the
  // edge's own coordinate and the point is still in clear air while the face falls short of it, so
  // the gap is `along - (edge + BAND)` — the old version subtracted the other way round, which made
  // an *approaching* front return a negative time. The HUD clamps negatives to zero, so the entire
  // forty-second warning read 0:00 and the countdown only woke up once the dust was already on you.
  eta(x, z) {
    if (this.phase !== 'watch' && this.phase !== 'front') return -1;
    const gap = this.along(x, z) - (this.edge + BAND);
    if (this.phase === 'front') return gap / LEAD_SPEED;
    // During the build-up the wall stalks at WATCH_CREEP, so a point near the centre is reached after
    // the launch and the two legs have to be timed apart. A point far upwind of centre is reached
    // during the creep, which this reports honestly too — `outlook.on` is what tells the bar to stop
    // counting down and say the dust is already falling there.
    const rem = Math.max(0, HOLD.watch - this.t);
    const creep = WATCH_CREEP * rem;
    return gap <= creep ? gap / WATCH_CREEP : rem + (gap - creep) / LEAD_SPEED;
  }

  get state() {
    return {
      phase: this.phase, intensity: this.amplitude, speed: this.speed, gust: this.gustEnv,
      dustLoad: this.dustLoad, windX: this.wx, windZ: this.wz, edge: this.edge, trail: this.trail,
      scheduled: this.scheduled, pendingLead: this.pendingLead, clearIn: this.timeToClear(),
    };
  }
}

// ───────────────────────── the leading edge, as geometry ─────────────────────────
// A Martian storm front is a wall of rolling dust. Across a 300 m island it has to read at
// ~150 m, which no point sprite system manages at a few thousand motes: the wall is one
// sheet with a scrolling, curling alpha, parked on the leading edge and dragged sideways
// with the viewpoint so it always spans the horizon.
// A wall has to *stand up*. The first version was 58 m tall sunk 16 m, which put its centre on the
// deck and left only 13 m of crest above the ground — at a 150 m standoff that is 3° of elevation,
// so the front hid behind the gantry, the dunes and its own haze, and the storm never appeared. The
// sheet is now hung from a deck line instead of centred on it: WALL_DECK is the uv height where the
// plane crosses the ground, so the mass of it rises 87 m above the deck — 33° of elevation at a
// 150 m standoff, high enough to clear the island's own rim and the base's gantries — and the 37 m
// skirt below hides the seam from every angle, including from inside the storm.
// The height is set by angular size, not by how tall a wall we wanted. Measured 2026-09-22 at the
// framed 150 m standoff from an eye 4.7 m up with a 60° vertical fov: the old 124 m sheet crossed the
// deck at −2.2° and topped out at +28.7°, so it filled the sky from the horizon to the top of the
// frame and was cropped there. A front that *replaces* the sky cannot read as an object — it reads as
// a weather switch, which is the complaint being fixed. 88 m puts the crest near +15° and leaves a
// band of real sky above it, so the silhouette is a shape sitting in the world rather than the world.
const WALL_SPAN = 760, WALL_TALL = 88, WALL_DECK = 0.30;
const WALL_SINK = WALL_TALL * (WALL_DECK - 0.5);   // negative: the sheet is lifted, not buried

export function createStormWall(scene) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      uAmt: { value: 0 }, uTime: { value: 0 }, uDeck: { value: WALL_DECK },
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uTint: { value: new THREE.Color(0.42, 0.22, 0.11) },
      uGlow: { value: new THREE.Color(1.0, 0.62, 0.30) },
      uCam: { value: new THREE.Vector3() },
      // The scene's own fog, handed in every frame. The wall has to go the same distance the rest of
      // the world does, or it is scenery on a flat.
      uFogCol: { value: new THREE.Color(0.4, 0.25, 0.15) },
      uFogDen: { value: 0.0014 },
    },
    vertexShader: `
uniform float uTime;
uniform float uDeck;
varying vec2 vUv; varying vec3 vWorld;
void main(){
  vUv = uv;
  vec3 p = position;
  // Roll the sheet along its own length and lean the crest downwind, so the silhouette breaks and
  // the front looks like it is curling over onto you instead of standing there like a hoarding.
  // Nothing below the deck line moves — that skirt is what hides the seam against the dunes.
  float up = smoothstep(uDeck, 1.0, uv.y);
  float w = sin(p.x * 0.063 + uTime * 0.55) * 0.6 + sin(p.x * 0.141 - uTime * 0.9) * 0.4;
  p.z += w * 9.0 * up + up * up * 13.0;
  p.y += w * 2.4 * up;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
    fragmentShader: `
precision highp float;
uniform float uAmt, uTime, uDeck, uFogDen;
uniform vec3 uSun, uTint, uGlow, uCam, uFogCol;
varying vec2 vUv; varying vec3 vWorld;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x),
             mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fb(vec2 p){ return vn(p) * 0.55 + vn(p * 2.37) * 0.28 + vn(p * 5.9) * 0.17; }
void main(){
  // Height measured from the deck in 0..1 of the visible rise, so every ramp below is authored
  // against the ground line rather than against the middle of the sheet.
  float hy = (vUv.y - uDeck) / (1.0 - uDeck);
  // Streaks advect along the wall and are squeezed vertically into billows. The cells are sized in
  // metres, not in uv, so the tumbling reads at the same scale wherever the front happens to be.
  vec2 q = vec2(vUv.x * 46.0 - uTime * 0.42, hy * 8.0 + uTime * 0.16);
  float warp = fb(q * 1.7 + uTime * 0.1) * 1.4;
  float n = fb(q + warp);
  // A second, much smaller scale stretched along the wall. Dust does not roll at one size, and with
  // only the 16 m billow in the frame the front reads as marbled paint: every feature is the same
  // blob and the eye can find no surface to crawl over. Measured 2026-09-22 on the first shelf-cloud
  // pass, which had exactly one scale and looked like whipped cream rather than a wall.
  float fine = fb(vec2(q.x * 3.6 + uTime * 0.95, q.y * 4.6 + warp * 2.0));
  float body = clamp(n * 0.70 + fine * 0.30, 0.0, 1.0);
  // The same field sampled a little above itself. The difference is the slope across each roll, and
  // a slope is the only thing that can light one: a flat noise gives a painted backdrop, a lit
  // shoulder against an unlit lee gives a surface that tumbles.
  float nu = fb(q + warp + vec2(0.0, 0.085));
  float slope = clamp((n - nu) * 9.0, -1.0, 1.0);
  // The silhouette. Measured 2026-09-22: the previous version authored the lobes into a separate
  // crest multiplier, but multiplied it by a smooth belly ramp that had already reached zero by
  // hy 0.72 — so the lobes could never be seen and the front was cut by a dead straight horizontal
  // line, the one shape a dust wall never has. The outline is now the ramp itself, and its height is
  // driven by the same large-scale field that lights the surface, so where the wall bulges the
  // silhouette bulges with it.
  float lobe = fb(vec2(q.x * 0.21 + uTime * 0.075, 4.7));
  float edge = 0.70 + lobe * 0.26 + (n - 0.5) * 0.16;
  float prof = 1.0 - smoothstep(edge - 0.34, edge, hy);
  // A denser shoulder low on the wall: the roll where the front curls over is optically thicker than
  // the haze flung above it, and that band of extra value is what makes the mass read as tumbling.
  prof *= 1.0 + 0.30 * exp(-pow((hy - 0.14) * 2.2, 2.0));
  // Cat's paws: fingers of dust peeled off the deck and running ahead of the wall, thin enough to see
  // the dunes through. They used to sit at hy < 0.1, which is entirely below the horizon line from a
  // 150 m standoff, so the one element that sells "the front is moving" never appeared on screen.
  float paw = exp(-pow((hy - 0.30) * 3.2, 2.0)) * smoothstep(0.40, 0.92, fb(vec2(q.x * 1.9 + uTime * 0.75, q.y * 0.6)));
  float side = smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x);
  // Light does not pass through a wall of dust — it is absorbed in the first few metres of it, so
  // the body of the front is opaque and only its lobes let the sky through.
  float a = clamp(prof * (0.30 + body * 0.70) + paw * 0.42, 0.0, 1.0) * side * uAmt;
  // This material is a raw ShaderMaterial, so it is the only thing in the scene that fog cannot reach.
  // Left that way it kept full contrast at 150 m while the dunes in front of it were already 70 %
  // gone, and that mismatch — not the texture — is what made the front look pasted on. Same
  // FogExp2 law, same density, same colour, applied by hand.
  float ext = 1.0 - exp(-pow(length(vWorld - uCam) * uFogDen, 2.0));
  a *= 1.0 - ext * 0.25;
  if (a < 0.004) discard;
  // Value, not hue: the body of the wall is an unlit cave of dust, and only the sunlit shoulder of
  // each roll blazes. Measured 2026-09-22 the previous expression averaged lit ≈ 0.65, because the
  // upwind-facing term sat near 1 exactly where the camera is framed, and the hy gradient added a
  // fifth of light across the whole band. Most of the slab therefore
  // rendered at full glow: the front came out *brighter* than the dust-lit sky behind it, which is
  // backwards. A haboob wall is a dark mass crossing a bright sky, and that contrast is the only
  // thing that separates its silhouette from the horizon it stands on. The sun is now a gate on the
  // slope — it decides how strongly an already-lit face blazes, not whether the wall is bright.
  vec3 vd = normalize(vWorld - uCam);
  float sunward = pow(clamp(dot(vd, -normalize(uSun)) * 0.5 + 0.5, 0.0, 1.0), 2.0);
  // Only the strongest shoulders blaze. Measured 2026-09-22 with the linear slope term: the visible
  // band averaged lit 0.55, i.e. half the sheet sat at full glow, and half-lit dust is cream — the
  // exact "whipped cream" read being fixed. The power puts light on the crest of each roll and
  // leaves its lee in shadow, which is what makes a roll look like a volume instead of a smear.
  float shoulder = pow(clamp(slope, 0.0, 1.0), 1.7) * (0.25 + 0.75 * sunward);
  // The thin tips of a breaking roll do transmit light — a rim on the crest, not a gradient washing
  // the whole wall upward.
  float rim = smoothstep(0.62, 0.98, body) * smoothstep(0.62, 0.92, hy);
  // Optical depth is cumulative: the bottom of a dust wall is the part no light has ever reached.
  // Without this ramp the mass is the same value top to bottom and reads as a painted cloud layer.
  float depth = 0.28 + 0.72 * smoothstep(0.10, 0.85, hy);
  // The fine marbling is kept at low weight inside the dark mass: a wall with no value inside it is a
  // flat silhouette, and the tumbling has to continue across the face, not just along its edge.
  float lit = clamp((0.06 + shoulder * 0.95 + rim * 0.30 + body * 0.10) * depth, 0.0, 1.0);
  gl_FragColor = vec4(mix(mix(uTint, uGlow, lit), uFogCol, ext * 0.72), a);
}`,
  });
  // RETAINED RUNTIME PRIMITIVE — a sampling grid for a volume, not a surface: the 88 × 22 subdivisions
  // exist so the vertex shader has vertices to tumble (the tumbling is positional, so a coarse quad
  // would fold at the creases), the plane is `frustumCulled:false` because it has to stay drawn when the
  // camera is *inside* its own bbox, and `renderOrder 4` puts it over the world it eats. The front of a
  // dust storm has no silhouette to bake; it has an optical depth, and that is what this draws.
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(WALL_SPAN, WALL_TALL, 88, 22), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.visible = false;
  scene.add(mesh);
  return mesh;
}

// Park the wall on its leading edge, centred on the viewpoint's crosswind coordinate so it
// never runs out of horizon, and hung from the deck line so the dunes can never expose its hem.
export function placeStormWall(mesh, field, focus, dt, sunDir, tint, glow, camPos, fog) {
  const amt = field.amplitude;
  mesh.visible = amt > 0.02;
  if (!mesh.visible) return 0;
  const u = mesh.material.uniforms;
  u.uAmt.value = amt;
  u.uTime.value += dt;
  u.uSun.value.copy(sunDir);
  u.uTint.value.copy(tint);
  u.uGlow.value.copy(glow);
  u.uCam.value.copy(camPos);
  if (fog) {
    u.uFogCol.value.copy(fog.color);
    u.uFogDen.value = fog.density;
  }
  const c = field.cross(focus.x, focus.z);
  mesh.position.set(field.wx * field.edge - field.wz * c, 0, field.wz * field.edge + field.wx * c);
  mesh.rotation.set(0, Math.atan2(field.wx, field.wz), 0);
  // The deck line may never fall below the ground the viewer is standing on. The terrain mesh only
  // exists for ±150 m and clamps to −23.2 beyond it, so any front more than ~45 m out on the island
  // was sampled in that clamp and hung its boots 24 m under the player's feet — which put the whole
  // dense, opaque lower third of the sheet *behind* the crater rim (measured 2026-09-22: deck at
  // −23.2 against a rim crest at +8.0, viewer's own ground at +0.5). What stayed above the horizon
  // was only the translucent crest, so the storm read as a cloudy sky with a flat band across it.
  // A distant front rises from the horizon line, so that is where its deck belongs.
  const g = field.surfaceAt ? field.surfaceAt(mesh.position.x, mesh.position.z) : 0;
  const deck = field.surfaceAt ? Math.max(g, field.surfaceAt(focus.x, focus.z) - 1.5) : g;
  mesh.position.y = deck - WALL_SINK;
  return amt;
}
