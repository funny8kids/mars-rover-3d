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
uniform float uDay;      // 0 night .. 1 noon
uniform float uStorm;
uniform float uTime;

float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float vn(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y);
}
float fbm2(vec2 p){ float s=0.,a=.5; for(int i=0;i<5;i++){ s+=a*vn(p); p*=2.07; a*=.5;} return s; }

void main(){
  vec3 d = normalize(vDir);
  float y = clamp(d.y, -1.0, 1.0);
  float horizon = pow(1.0 - max(y, 0.0), 3.2);

  // mars palettes
  vec3 dayZen  = vec3(0.16, 0.13, 0.16);
  vec3 dayHor  = vec3(0.72, 0.42, 0.22);
  vec3 duskZen = vec3(0.05, 0.05, 0.11);
  vec3 duskHor = vec3(0.85, 0.30, 0.10);
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
  float glow = pow(sdot, 220.0) * 0.9 + pow(sdot, 14.0) * 0.30 + pow(sdot, 3.0) * 0.10;
  vec3 sunCol = mix(vec3(1.0, 0.55, 0.28), vec3(1.0, 0.87, 0.72), dayF);
  sky += sunCol * (disc * 22.0 + glow) * (0.12 + dayF * 0.9) * (1.0 - duskF * 0.15);

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
    sky += (vec3(0.92, 0.94, 1.0) * star * 3.2 + vec3(0.5, 0.55, 0.78) * mw) * nightF;
  }

  // storm darkening + ochre soup
  vec3 stormCol = vec3(0.48, 0.24, 0.11);
  sky = mix(sky, stormCol * (0.5 + dayF * 0.7), uStorm * 0.85 * (0.4 + 0.6 * horizon));
  gl_FragColor = vec4(sky, 1.0);
  #include <colorspace_fragment>
}`;

export function createSky(scene) {
  const geo = new THREE.SphereGeometry(7000, 48, 32);
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VS, fragmentShader: SKY_FS,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0.4, 0.5, 0.2) },
      uDay: { value: 0.8 }, uStorm: { value: 0 }, uTime: { value: 0 },
    },
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return {
    mesh, mat,
    setSun(dir, day, storm, time) {
      mat.uniforms.uSunDir.value.copy(dir);
      mat.uniforms.uDay.value = day;
      mat.uniforms.uStorm.value = storm;
      mat.uniforms.uTime.value = time;
    },
  };
}
