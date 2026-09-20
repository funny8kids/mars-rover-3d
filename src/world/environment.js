import * as THREE from 'three';
import { smoothstep } from '../utils/noise.js';

// Every fill source used to be warm ochre, so the whole frame collapsed onto one hue and read as a
// sepia filter. Martian light is a contrast, not a tint: a butterscotch key through the dust and a
// cool slate bounce off shadowed regolith. Splitting the fill side cool is what makes the sunlit
// faces look sunlit and gives the settlement's geometry its read.
const COOL_FILL = new THREE.Color(0.14, 0.18, 0.28);
const COOL_GROUND = new THREE.Color(0.10, 0.12, 0.19);

// Sun path, ambient/fog moods, weather state machine, real-time env cube camera.
export class Environment {
  constructor(scene, sky, quality) {
    this.scene = scene; this.sky = sky; this.q = quality;
    // 0..1 (0=midnight). el = sin((dayT-0.25)*2pi), so 0.235 booted *below* the horizon at
    // nightF 0.93; 0.30 puts the sun ~18 deg up — real golden hour, full key, long shadows.
    this.dayT = 0.30;
    this.dayLength = 300;           // seconds for full cycle
    this.cycleOn = true;
    this.weather = 'clear';         // clear | storm
    this.storm = 0; this.stormTarget = 0;
    this.stormTimer = 100;

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

    this._c = { sky: new THREE.Color(), fog: new THREE.Color(), sun: new THREE.Color() };
    this._mh = new THREE.Vector3();
    this.moonDir = new THREE.Vector3(0, 1, 0);
    this.state = { sunDir: new THREE.Vector3(), dayF: 1, nightF: 0, duskF: 0, stormF: 0, clock: '06:00' };
  }
  forceNight() { this.dayT = 0.02; }
  toggleWeather() { this.weather = this.weather === 'clear' ? 'storm' : 'clear'; this.stormTarget = this.weather === 'storm' ? 1 : 0; }
  update(dt, focus, elapsed, renderer) {
    if (this.cycleOn) this.dayT = (this.dayT + dt / this.dayLength) % 1;
    this.storm = THREE.MathUtils.damp(this.storm, this.stormTarget, 0.35, dt);
    this.stormTimer -= dt;
    if (this.stormTimer < 0) {
      this.stormTarget = this.stormTarget > 0.5 ? 0 : 1;
      this.weather = this.stormTarget > 0.5 ? 'storm' : 'clear';
      this.stormTimer = 110 + Math.random() * 120;
    }
    const ang = (this.dayT - 0.25) * Math.PI * 2;
    const el = Math.sin(ang), az = Math.cos(ang);
    const dir = this.state.sunDir.set(az * 0.75, Math.max(el, -0.4), az * 0.66).normalize();

    const dayF = smoothstep(-0.02, 0.32, el);
    const nightF = smoothstep(0.05, -0.12, el);
    const duskF = smoothstep(-0.14, 0.02, el) * (1 - smoothstep(0.06, 0.34, el));
    const stormMix = this.storm;

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
    this.sun.intensity = THREE.MathUtils.lerp(0.10, 3.4, dayF) * (1 - stormMix * 0.72);
    this._c.sun.setRGB(1.0, 0.72, 0.5).lerp(new THREE.Color(1.0, 0.92, 0.82), smoothstep(0.1, 0.5, el));
    this.sun.color.copy(this._c.sun).lerp(new THREE.Color(0.50, 0.58, 0.82), nightF * 0.99);
    this.sun.intensity += nightF * 1.6; // moonlight key: strong enough to throw real shadows

    // ambient
    // a dust storm is a giant diffuse light box: the key dims but the wrap-around fill rises.
    // Without that fill every shadowed face in the frame collapses into a black void.
    // The day value had to come up too: a 3.4 sun against 0.58 hemi put shadowed stone at 1/6 of
    // the lit side, so the settlement's unlit faces read as flat black cut-outs.
    this.hemi.intensity = THREE.MathUtils.lerp(0.42, 0.62, dayF) * (1 + stormMix * 1.5) + nightF * 0.34;
    this._c.sky.setRGB(0.46, 0.33, 0.27).lerp(new THREE.Color(0.74, 0.57, 0.46), dayF);
    this._c.sky.lerp(new THREE.Color(0.10, 0.13, 0.26), nightF);
    this.amb.intensity = 0.13 + dayF * 0.09 + nightF * 0.12 + stormMix * 0.30;

    // fog mood
    const fogC = this._c.fog.setRGB(0.38, 0.175, 0.085).lerp(new THREE.Color(0.045, 0.05, 0.075), nightF);
    fogC.lerp(new THREE.Color(0.42, 0.14, 0.05), duskF * 0.6);
    fogC.lerp(new THREE.Color(0.30, 0.145, 0.07), stormMix);
    this.fog.color.copy(fogC);
    // shadow-side fill tinted by the actual haze colour, so dark scarp reads as dust-lit rock
    this.hemi.color.copy(this._c.sky).lerp(fogC, stormMix * 0.85);
    this.amb.color.copy(fogC).lerp(COOL_FILL, 0.55 * dayF);
    // densities sized for a 300 m island: the far rim should always sit in soft haze
    this.fog.density = THREE.MathUtils.lerp(0.0026, 0.0014, dayF) + nightF * 0.0016 + stormMix * 0.0095;
    renderer.setClearColor(fogC, 1);

    this.sky.setSun(dir, dayF * (1 - stormMix * 0.75), stormMix, elapsed, this.moonDir, nightF * (1 - stormMix * 0.9));

    const hh = Math.floor(((this.dayT * 24) + 6) % 24), mm = Math.floor((this.dayT * 24 * 60) % 60);
    this.state.clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    Object.assign(this.state, { dayF, nightF, duskF, stormF: stormMix });

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
