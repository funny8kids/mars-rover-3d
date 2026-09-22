import * as THREE from 'three';
import { smoothstep } from '../utils/noise.js';

// Every fill source used to be warm ochre, so the whole frame collapsed onto one hue and read as a
// sepia filter. Martian light is a contrast, not a tint: a butterscotch key through the dust and a
// cool slate bounce off shadowed regolith. Splitting the fill side cool is what makes the sunlit
// faces look sunlit and gives the settlement's geometry its read.
const COOL_FILL = new THREE.Color(0.14, 0.18, 0.28);
const COOL_GROUND = new THREE.Color(0.10, 0.12, 0.19);
// Sunlight that has crossed a wall of dust arrives red: the short wavelengths are scattered out of
// the direct beam first, so what is left is the deep amber of a low Martian afternoon seen through
// the front. Linear values — light colours are worked in linear space and tone-mapped downstream.
const SUN_THROUGH_DUST = new THREE.Color(0.95, 0.40, 0.15);
// Metres out along the sun's ground track where the air is probed for dust. The slab a storm drags
// behind its leading edge is ~260 m deep, so the probes straddle it and one beyond.
const SUN_PATH = [45, 110, 190, 285, 400];

// Sun path, ambient/fog moods, the travelling storm field, real-time env cube camera.
export class Environment {
  constructor(scene, sky, quality, field) {
    this.scene = scene; this.sky = sky; this.q = quality;
    this.field = field;
    // 0..1 (0=midnight). el = sin((dayT-0.25)*2pi), so 0.235 booted *below* the horizon at
    // nightF 0.93; 0.30 puts the sun ~18 deg up — real golden hour, full key, long shadows.
    this.dayT = 0.30;
    this.dayLength = 300;           // seconds for full cycle
    this.cycleOn = true;

    this.sun = new THREE.DirectionalLight(0xffdcb0, 3);
    this.sun.castShadow = true;
    const sm = quality.shadow || 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    // The map used to cover ±160 m — the whole island — which cost both ways: 15 cm per texel, so
    // every handrail, wheel and rivet in the frame fell between texels and vanished, and because the
    // frustum held the entire settlement no shadow caster was ever culled. Tracking the rover with a
    // 120 m box makes the shadows four times sharper and the pass far cheaper.
    Object.assign(this.sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 460 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.09;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xc98a5a, 0x40251a, 0.30);
    this.hemi.groundColor.copy(COOL_GROUND);   // bounce off shadowed regolith, not a warm mud pit
    scene.add(this.hemi);
    this.amb = new THREE.AmbientLight(0x554433, 0.10);
    scene.add(this.amb);

    scene.fog = new THREE.FogExp2(0x9a5a32, 0.00042);
    this.fog = scene.fog;

    // Reflections come from the sky dome. A live cube capture of the whole scene was the original
    // source and it failed twice over: MeshStandardMaterial has no IBL path for a raw cube map, so
    // the metals reflected nothing at all, and re-rendering 1 500 meshes six times a face at 4 Hz
    // cost more than the frame it was supposed to improve. PMREM of the dome is one sphere.
    this.pmrem = null;      // needs the renderer, so it is built on the first update
    this.envRT = null;
    this.envTimer = 0;

    this._c = { sky: new THREE.Color(), fog: new THREE.Color(), sun: new THREE.Color(), dust: new THREE.Color() };
    this._mh = new THREE.Vector3();
    this._look = new THREE.Vector3();
    // How much of the key the storm is eating, 0..1. Drives the sun light, the solar pads and the
    // HUD, because all three care about the light that actually arrives, not about the weather map.
    this.sunShade = 0;
    this.moonDir = new THREE.Vector3(0, 1, 0);
    this.state = {
      sunDir: new THREE.Vector3(), dayF: 1, nightF: 0, duskF: 0, stormF: 0, clock: '06:00',
      stormAmp: 0, stormPhase: 'calm', stormSpeed: 0, stormGust: 0, stormLoad: 0,
      stormWindX: 1, stormWindZ: 0, stormEta: -1, sunShade: 0,
    };
  }
  get weather() { return this.field.phase === 'calm' ? 'clear' : 'storm'; }
  forceNight() { this.dayT = 0.02; }
  // The debug key used to flip a boolean. It now pushes the field through its own phases, so a
  // forced storm still has to arrive as a front and leave as one instead of popping into place.
  toggleWeather() {
    if (this.field.phase === 'calm') this.field.force('watch');
    else this.field.force('clearing');
    return this.weather;
  }
  update(dt, focus, elapsed, renderer, viewDir) {
    if (this.cycleOn) this.dayT = (this.dayT + dt / this.dayLength) % 1;
    // One call, one truth: the field owns its own timing and reports how much dust is at the rover.
    const here = this.field.advance(dt, focus);
    const ang = (this.dayT - 0.25) * Math.PI * 2;
    const el = Math.sin(ang), az = Math.cos(ang);
    const dir = this.state.sunDir.set(az * 0.75, Math.max(el, -0.4), az * 0.66).normalize();

    const dayF = smoothstep(-0.02, 0.32, el);
    const nightF = smoothstep(0.05, -0.12, el);
    const duskF = smoothstep(-0.14, 0.02, el) * (1 - smoothstep(0.06, 0.34, el));
    const stormMix = here;

    // Sun-path extinction — the dust between the sun and the rover, which is a different quantity
    // from the dust beside the rover. Measured 2026-09-22 with the front held 150 m upwind: the air
    // at the camera was clean, so `stormMix` was zero, the key stayed at full noon strength and the
    // ground stayed flat saturated red while a wall of soil blazed across the sky. That mismatch is
    // the remaining "painted backdrop" tell — the storm lit the sky and touched nothing else, even
    // though every photon reaching the dunes in that frame has to cross the front to get there.
    // A low sun's ray runs the length of the slab, so it pays almost the whole bill; near noon it
    // clips the top of the wall and is barely touched, which is why the same front at 08:00 and at
    // 13:00 costs different amounts of key.
    const slant = 1 - smoothstep(0.25, 0.85, Math.max(el, 0)) * 0.72;
    let shade = 0;
    if (dayF > 0.01) {
      for (let i = 0; i < SUN_PATH.length; i++) {
        const r = SUN_PATH[i];
        shade += this.field.local(focus.x + dir.x * r, focus.z + dir.z * r);
      }
      shade = THREE.MathUtils.clamp(shade / SUN_PATH.length, 0, 1) * slant * dayF;
    }
    // Damped: the probes land on the field's own fingers, and a key that stuttered with them would
    // read as a flickering lamp rather than as weather moving across the sky.
    this.sunShade = THREE.MathUtils.damp(this.sunShade, shade, 3.2, dt);

    // sun light
    this.sun.visible = dayF > 0.01 || nightF > 0.01;
    // The moon rides opposite the sun's longitude and climbs through the night, and the
    // directional key is swung to come from it — otherwise the dune shadows point away from
    // a light source that isn't anywhere in the sky.
    const mh = this._mh.set(-dir.x, 0, -dir.z);
    if (mh.lengthSq() < 1e-6) mh.set(1, 0, 0);
    const tilt = 0.36 + nightF * 0.30;
    this.moonDir.copy(mh.normalize()).multiplyScalar(Math.cos(tilt)).setY(Math.sin(tilt)).normalize();
    this.sun.position.copy(nightF > 0.01 ? this.moonDir : dir).multiplyScalar(300).add(focus);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
    // max(), not a product: when the rover is buried the whole sky around it is dust, so the local
    // term and the sun-path term are measuring two halves of the same column and must not stack.
    this.sun.intensity = THREE.MathUtils.lerp(0.10, 3.4, dayF) * (1 - Math.max(stormMix * 0.68, this.sunShade * 0.74));
    this._c.sun.setRGB(1.0, 0.72, 0.5).lerp(new THREE.Color(1.0, 0.92, 0.82), smoothstep(0.1, 0.5, el));
    this.sun.color.copy(this._c.sun).lerp(new THREE.Color(0.50, 0.58, 0.82), nightF * 0.99);
    this.sun.color.lerp(SUN_THROUGH_DUST, this.sunShade * 0.8);
    this.sun.intensity += nightF * 1.6; // moonlight key: strong enough to throw real shadows

    // ambient
    // A dust storm is a diffuse light box: the key dims and the wrap-around fill rises. But the
    // old box was too generous — hemi ×2.5 plus ambient +0.30 against a 0.28× sun lit every shadow
    // as much as every face, and the measured histogram collapsed from seven luminance bins into
    // three: the gate became a silhouette because nothing in the frame was *not* lit any more.
    // Dust scatters, it does not replace the sun, so the fill now climbs about half as hard.
    this.hemi.intensity = THREE.MathUtils.lerp(0.42, 0.62, dayF) * (1 + stormMix * 0.7) + nightF * 0.34;
    this._c.sky.setRGB(0.46, 0.33, 0.27).lerp(new THREE.Color(0.74, 0.57, 0.46), dayF);
    this._c.sky.lerp(new THREE.Color(0.10, 0.13, 0.26), nightF);
    this.amb.intensity = 0.13 + dayF * 0.09 + nightF * 0.12 + stormMix * 0.13;
    // The blocked key does not vanish, it is scattered — and a front a kilometre wide that has the
    // sun behind it is the largest lamp in the scene. So the fill climbs on the same signal that
    // dims the sun: the ground loses its shadows and gains a flat, sourceless glow, which is the
    // light a haboob actually has. Deliberately small next to the 0.74 the key gives up.
    this.hemi.intensity += this.sunShade * dayF * 0.22;
    this.amb.intensity += this.sunShade * dayF * 0.05;

    // fog mood
    // The dust tint breathes: suspension coarsens and thins as the front rolls through, so the
    // cast colour is not the same flat rust at minute 1 and minute 3 of the same event.
    // A dust storm is not a dim room. Optically thick Martian dust is forward-scattering and lit
    // from all sides, so the box *glows*: the air goes pale butterscotch and the frame lifts. The
    // previous tint (0.275, 0.135, 0.062) was darker than the clear-sky fog it was lerping away
    // from, so every increase in dust could only push the histogram down into one maroon bin.
    const shift = 0.5 + 0.5 * Math.sin(elapsed * 0.07 + this.field.tick * 0.13);
    const fogC = this._c.fog.setRGB(0.38, 0.175, 0.085).lerp(new THREE.Color(0.045, 0.05, 0.075), nightF);
    fogC.lerp(new THREE.Color(0.42, 0.14, 0.05), duskF * 0.6);
    this._c.dust.setRGB(0.585 + shift * 0.075, 0.375 + shift * 0.055, 0.185 + shift * 0.030);
    fogC.lerp(this._c.dust, stormMix);
    this.fog.color.copy(fogC);
    // shadow-side fill tinted by the actual haze colour, so dark scarp reads as dust-lit rock
    this.hemi.color.copy(this._c.sky).lerp(fogC, stormMix * 0.85);
    this.amb.color.copy(fogC).lerp(COOL_FILL, 0.55 * dayF);
    // Densities sized for a 300 m island: the far rim should always sit in soft haze.
    // The dust term used to be 0.0155, and measured 2026-09-22 that was the reason the front could
    // never be seen: FogExp2 gives f = 1 - exp(-(d*D)^2), so at that density the air was already 64 %
    // opaque at 60 m and 99.8 % opaque at 149 m — the standoff the wall is framed at. The storm ate
    // its own horizon, and the only thing that stayed visible was the wall mesh, which is a raw
    // ShaderMaterial and takes no scene fog, so it floated in front of a fully-fogged world at full
    // contrast. That pair is exactly the "painted backdrop" tell. 0.0058 leaves ~30 % of the wall's
    // own value at 150 m and ~83 % at 60 m: the air still swallows the far rim, but the front is now
    // something you can watch arrive.
    this.fog.density = THREE.MathUtils.lerp(0.0026, 0.0014, dayF) + nightF * 0.0016;
    // FogExp2 has one density, so direction-dependent visibility cannot come from the fog model —
    // it comes from sampling the field along the sightline. The column, not the point: looking into
    // the front loads the whole sightline with dust, while turning downwind lets the eye run past
    // the retreating tail into clearing air, which is the anisotropy a moving front actually has.
    // Sampling only beside the camera made this term cancel exactly when the storm peaked.
    let column = stormMix;
    if (viewDir) {
      const lx = focus.x + viewDir.x, lz = focus.z + viewDir.z;
      const near = this.field.local(lx + viewDir.x * 40, lz + viewDir.z * 40);
      const mid = this.field.local(lx + viewDir.x * 110, lz + viewDir.z * 110);
      const far = this.field.local(lx + viewDir.x * 220, lz + viewDir.z * 220);
      column = stormMix * 0.35 + near * 0.25 + mid * 0.22 + far * 0.18;
    }
    this.fog.density += column * 0.0058;
    renderer.setClearColor(fogC, 1);

    // The dome is 20 km out: it reads the slab's whole saturation, not the pocket of dust the rover
    // happens to be standing in, or the sky would snap open the moment a finger of clear air passed
    // over the antenna mast.
    const skyStorm = Math.max(stormMix, this.field.amplitude * 0.62);
    this.sky.setSun(dir, dayF * (1 - skyStorm * 0.75), skyStorm, elapsed, this.moonDir, nightF * (1 - skyStorm * 0.9), dayF);

    const hh = Math.floor(((this.dayT * 24) + 6) % 24), mm = Math.floor((this.dayT * 24 * 60) % 60);
    this.state.clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    Object.assign(this.state, {
      dayF, nightF, duskF, stormF: stormMix,
      stormAmp: this.field.amplitude, stormPhase: this.field.phase,
      stormSpeed: this.field.speed, stormGust: this.field.gustEnv, stormLoad: this.field.dustLoad,
      stormWindX: this.field.wx, stormWindZ: this.field.wz, stormEta: this.field.eta(focus.x, focus.z),
      sunShade: this.sunShade,
    });

    // refresh environment reflections
    this.envTimer -= dt;
    if (this.envTimer <= 0) {
      this.envTimer = 1 / Math.min(this.q.envUpdateHz || 2, 2);
      this.pmrem ||= new THREE.PMREMGenerator(renderer);
      const prev = this.envRT;
      this.envRT = this.pmrem.fromScene(this.sky.envScene, 0, 1, 20000);
      prev?.dispose();
      this.scene.environment = this.envRT.texture;
    }
    return this.state;
  }
}
