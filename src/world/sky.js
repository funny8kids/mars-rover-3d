import * as THREE from 'three';

const SKY_VS = `
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(position,1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
}`;
const SKY_FS = `
precision highp float;
varying vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uMoonF;
uniform float uDay;      // 0 night .. 1 noon, already dimmed by dust
uniform float uDayRaw;   // the sun's true altitude, so the dust can still light the air
uniform float uStorm;
uniform float uTime;

float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y);
}
float fbm2(vec2 p){ float s=0.,a=.5; for(int i=0;i<5;i++){ s+=a*vn(p); p*=2.07; a*=.5;} return s; }

// Ridgelines are sampled on a circle in azimuth, so the silhouette closes on itself without a seam.
// smoothstep flattens the summits: Martian horizon features are table mesas, not triangular peaks.
float mesa(float a, float seed, float f){
  vec2 p = vec2(cos(a), sin(a)) * f;
  float h = vn(p + seed) + vn(p * 2.3 + seed + 7.0) * 0.40 + vn(p * 5.7 + seed + 19.0) * 0.13;
  return smoothstep(0.30, 0.78, h / 1.53);
}

void main(){
  vec3 d = normalize(vDir);
  float y = clamp(d.y, -1.0, 1.0);

  // mars palettes — Outer Wilds dusk: violet zenith melting into a burnt-pink horizon
  vec3 dayZen  = vec3(0.20, 0.13, 0.27);
  vec3 dayHor  = vec3(0.86, 0.44, 0.26);
  vec3 duskZen = vec3(0.07, 0.05, 0.14);
  vec3 duskHor = vec3(0.92, 0.30, 0.16);
  vec3 nightZen= vec3(0.006, 0.008, 0.020);
  vec3 nightHor= vec3(0.028, 0.030, 0.046);

  float sunHeight = uSunDir.y;
  float dayF = uDay;
  float duskF = smoothstep(-0.08, 0.18, sunHeight) * (1.0 - smoothstep(0.18, 0.55, sunHeight));

  vec3 zen = mix(nightZen, dayZen, dayF);
  vec3 hor = mix(nightHor, dayHor, dayF);
  hor = mix(hor, duskHor, duskF * 0.9);
  zen = mix(zen, mix(duskZen, zen, dayF), duskF * 0.5);

  vec3 sky = mix(hor, zen, pow(clamp(y + 0.06, 0.0, 1.0), 0.62));
  // below horizon: dusty ground haze
  sky = mix(sky, hor * 0.55, smoothstep(0.0, -0.12, y));

  // sun disc + glow
  float sdot = max(dot(d, uSunDir), 0.0);
  float disc = smoothstep(0.9993, 0.99965, sdot);
  // The old corona spread 0.30 out to a 20-degree radius on top of a 0.10 hemisphere-wide wash,
  // so the sun read as a white hole rather than a disc with a rim.
  float glow = pow(sdot, 220.0) * 0.9 + pow(sdot, 26.0) * 0.22 + pow(sdot, 3.0) * 0.055;
  vec3 sunCol = mix(vec3(1.0, 0.55, 0.28), vec3(1.0, 0.87, 0.72), dayF);
  sky += sunCol * (disc * 22.0 + glow) * (0.12 + dayF * 0.9) * (1.0 - duskF * 0.15);
  // Forward scattering off suspended fines. Clearing the disc away with the day factor also threw
  // away the only thing that made a dust storm read as *dust* rather than brown fog: the sun still
  // shines through a Martian storm, it just smears into a wide sheath around itself. This is lit by
  // the sun's real altitude, so it survives the dimming rather than going out with it.
  float aureole = pow(sdot, 6.0) * 0.75 + pow(sdot, 1.8) * 0.30;
  sky += vec3(1.0, 0.56, 0.24) * aureole * uStorm * uDayRaw * (1.0 - smoothstep(0.55, 1.0, uStorm) * 0.45);

  // stars + milky way at night
  float nightF = 1.0 - smoothstep(0.0, 0.22, sunHeight);
  if(nightF > 0.01){
    // azimuth cells converge toward the zenith, so thin the field out there instead
    // of painting a bright crowd overhead
    float conv = clamp(sqrt(max(0.0, 1.0 - d.y * d.y)), 0.2, 1.0);
    vec3 mwAxis = normalize(vec3(0.45, 0.7, -0.3));
    float band = exp(-pow(dot(d, mwAxis) * 3.2, 2.0));
    vec2 sc = vec2(atan(d.z, d.x), acos(clamp(d.y, -1.0, 1.0))) * 140.0;
    vec2 cf = fract(sc) - 0.5;
    float st = h21(floor(sc));
    float mag = fract(st * 91.7);
    // the galactic band is where the dense field lives
    float lit = smoothstep(0.986 - band * 0.022, 0.9996, st) * conv;
    float tw = 0.72 + 0.28 * sin(uTime * 2.4 + st * 71.0);
    float star = lit * tw * smoothstep(0.26 - mag * 0.1, 0.02, length(cf));
    float mw = band * (0.35 + fbm2(sc * 0.05)) * 0.05;
    // 3.2 put every star ~7x over the bloom threshold (0.42), and UnrealBloomPass smears a
    // sub-pixel source into the square footprint of its coarsest mip: measured at MET 14 on the
    // dusk sky, ~15 faint 26 px squares scattered along the galactic band, gone the moment the
    // term drops to 0.60 and gone with bloom switched off — so they were never stars, they were
    // the bloom of stars. 0.60 keeps the top of the field just over threshold, which is what a
    // bright star should do, and leaves the twinkle readable against a night sky at 0.03-0.08.
    sky += (vec3(0.92, 0.94, 1.0) * star * 0.60 + vec3(0.5, 0.55, 0.78) * mw) * nightF * (1.0 - uStorm);
  }

  // the moon: the night key light has a visible source, so the dune shadows
  // actually point away from something in the sky
  if (uMoonF > 0.01){
    float mdot = max(dot(d, uMoonDir), 0.0);
    float halo = pow(mdot, 900.0) * 0.55 + pow(mdot, 60.0) * 0.10 + pow(mdot, 7.0) * 0.022;
    sky += vec3(0.55, 0.65, 0.92) * halo * uMoonF;
    // the disc is only ~1.5° wide, so the maria are evaluated inside it — projecting the whole
    // sky through a gnomonic UV would divide by ~0 behind the moon and feed sin() values near
    // 1e10, which is enough to NaN the entire dome white
    if (mdot > 0.9990){
      float disc = smoothstep(0.99930, 0.99958, mdot);
      vec3 ma = normalize(uMoonDir);
      vec3 mt = normalize(cross(vec3(0.0, 1.0, 0.0), ma));
      vec3 mb = cross(ma, mt);
      vec2 mp = vec2(dot(d, mt), dot(d, mb)) / max(mdot, 0.999);
      float r = length(mp) / 0.0265;
      float maria = fbm2(mp * 110.0 + 4.0);
      vec3 moonCol = mix(vec3(0.96, 0.97, 1.0), vec3(0.54, 0.59, 0.74), smoothstep(0.34, 0.74, maria));
      moonCol *= 1.0 - 0.34 * smoothstep(0.45, 1.0, r);   // limb darkening keeps it a sphere
      sky += moonCol * disc * 2.2 * uMoonF;
    }
  }

  // High dust veils. A smooth two-colour gradient is the main reason the dome reads as a flat
  // colour field: wind-sheared cirrus gives the sky structure, and drifting bands give it time.
  // Projected onto a plane at unit height so the pattern stays the same size overhead instead of
  // converging at the zenith.
  if (y > 0.012){
    vec2 cp = d.xz / max(y, 0.05);
    float veil = fbm2(vec2(cp.x * 0.40, cp.y * 1.30) + vec2(uTime * 0.0035, uTime * 0.0012));
    float filament = fbm2(vec2(cp.x * 1.7, cp.y * 5.4) - vec2(uTime * 0.0085, 0.0));
    float cover = smoothstep(0.50, 0.79, veil) * (0.30 + 0.80 * smoothstep(0.30, 0.74, filament));
    // cp = d.xz / y diverges toward the horizon, so the filament field goes far above Nyquist
    // within a few degrees of it and aliased into the flat white scratches that dominated every
    // driving frame. The veils now start well above the horizon line.
    float fade = smoothstep(0.075, 0.34, y) * (1.0 - smoothstep(0.62, 0.98, y));
    // +1e-4 keeps the horizontal normal finite when the view points straight at the zenith
    vec2 sd = normalize(vec2(d.x, d.z) + 1e-4);
    vec2 sdSun = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-4);
    float sunward = pow(max(dot(sd, sdSun), 0.0), 1.6);
    // sunward veils catch the key light; the rest of the field stays a cool, thin grey
    vec3 veilCol = mix(vec3(0.55, 0.56, 0.68), vec3(1.00, 0.83, 0.65), 0.25 + sunward * 0.75);
    // A storm lifts its dust *above* the weather layer, so the high veils thicken rather than
    // being painted out by the ochre below — suppressing them is what turned the old storm sky into
    // one flat brown disc with no structure and no motion overhead.
    veilCol = mix(veilCol, vec3(0.85, 0.52, 0.27), uStorm * 0.8);
    float veilW = (0.16 + 0.52 * dayF) * (1.0 + uStorm * 1.6);
    sky = mix(sky, veilCol, min(cover * fade * veilW, 0.92));
  }

  // Distant mesas. With nothing standing on the horizon line every sightline ended in a hard band
  // of haze, which is most of what made the world feel like a small stage. Two layers at different
  // values put real depth behind the settlement, and the far one is washed toward the sky colour
  // because that is what an atmosphere does.
  float az = atan(d.z, d.x);
  float farLine  = 0.055 + mesa(az, 1.7, 3.0) * 0.075;
  float nearLine = 0.018 + mesa(az, 9.4, 5.5) * 0.040;
  float lit = 0.07 + 0.93 * dayF;
  vec3 farRock = mix(hor, vec3(0.52, 0.35, 0.27), 0.55) * lit;
  vec3 nearRock = mix(hor * 0.55, vec3(0.30, 0.19, 0.15), 0.62) * lit;
  float ridgeA = 1.0 - uStorm * 0.8;
  sky = mix(sky, farRock, smoothstep(farLine + 0.004, farLine - 0.004, y) * ridgeA);
  sky = mix(sky, nearRock, smoothstep(nearLine + 0.004, nearLine - 0.004, y) * ridgeA);

  // Dust load by altitude. The column of air you look through is many times longer at the horizon
  // than overhead, so the same suspension paints a bright butterscotch band on the skyline and only
  // a thin maroon wash at the zenith. The old version lerped the whole dome toward one brown at one
  // weight — that flat tint is the other half of why the storm looked like a filter, not weather.
  float am = min(1.0 / (0.20 + max(y, 0.0) * 1.55), 5.0);
  vec3 dustLow  = vec3(0.78, 0.44, 0.19);
  vec3 dustHigh = vec3(0.23, 0.095, 0.055);
  vec3 dustCol = mix(dustLow, dustHigh, smoothstep(0.03, 0.72, y)) * (0.42 + uDayRaw * 0.78);
  sky = mix(sky, dustCol, min(uStorm * am * 0.5, 0.93));
  // Billows blown along the base of the dome. This is the only motion in the storm that is not
  // particle-sized, and it is what tells you the wall out there is travelling.
  if (uStorm > 0.02 && y < 0.34){
    vec2 bp = vec2(atan(d.z, d.x) * 2.6 + uTime * 0.055, y * 7.0 - uTime * 0.022);
    float band = fbm2(bp) * 0.6 + fbm2(bp * 2.7 + 3.1) * 0.4;
    float billow = smoothstep(0.44, 0.88, band) * smoothstep(0.34, 0.01, y);
    sky = mix(sky, dustLow * (0.5 + uDayRaw * 0.8), billow * uStorm * 0.55);
  }
  gl_FragColor = vec4(sky, 1.0);
  #include <colorspace_fragment>
}`;

export function createSky(scene) {
  const geo = new THREE.SphereGeometry(7000, 48, 32);
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VS, fragmentShader: SKY_FS,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0.4, 0.5, 0.2) },
      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonF: { value: 0 },
      uDay: { value: 0.8 }, uDayRaw: { value: 0.8 }, uStorm: { value: 0 }, uTime: { value: 0 },
    },
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  scene.add(mesh);
  // Metals need an irradiance map, and the only honest source for one on Mars is this dome. The
  // mirror shares the material, so it tracks every uniform for free and PMREM can sample the sky
  // without the whole settlement being re-rendered six times per refresh.
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(geo, mat));
  return {
    mesh, mat, envScene,
    setSun(dir, day, storm, time, moonDir, moonF, dayRaw) {
      mat.uniforms.uSunDir.value.copy(dir);
      mat.uniforms.uDay.value = day;
      mat.uniforms.uDayRaw.value = dayRaw ?? day;
      mat.uniforms.uStorm.value = storm;
      mat.uniforms.uTime.value = time;
      if (moonDir) mat.uniforms.uMoonDir.value.copy(moonDir);
      mat.uniforms.uMoonF.value = moonF || 0;
    },
  };
}
