import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';

const FINAL = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSunUV: { value: new THREE.Vector2(0.5, 0.5) },
    uGodRay: { value: 0 },
    uCA: { value: 0.15 },
    uGrain: { value: 0.06 },
    uVignette: { value: 0.6 },
    uDirt: { value: 0 },
    uDirtTex: { value: null },
    uFlash: { value: 0 },
    uFlashCol: { value: new THREE.Color(1, 0.5, 0.2) },
    uGrade: { value: 1 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse, uDirtTex;
uniform float uTime, uGodRay, uCA, uGrain, uVignette, uDirt, uFlash, uGrade;
uniform vec2 uSunUV, uRes;
uniform vec3 uFlashCol;
float h12(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
void main(){
  vec2 uv = vUv;
  vec2 fromCenter = uv - 0.5;
  float r2 = dot(fromCenter, fromCenter);
  // chromatic aberration (radial)
  float ca = (0.0015 + uCA * 0.004) * (0.4 + r2 * 2.4);
  vec3 col;
  col.r = texture2D(tDiffuse, uv + fromCenter * ca).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - fromCenter * ca).b;
  // god rays: radial march toward sun UV
  if (uGodRay > 0.001){
    vec3 rays = vec3(0.0);
    vec2 d = (uv - uSunUV) * -0.062;
    vec2 p = uv;
    float illum = 1.0;
    for (int i = 0; i < 10; i++){
      p += d;
      vec3 s = texture2D(tDiffuse, clamp(p, 0.001, 0.999)).rgb;
      float lum = dot(s, vec3(0.333));
      rays += max(s * lum - 0.55, 0.0) * illum;
      illum *= 0.86;
    }
    col += rays * 0.045 * uGodRay * vec3(1.0, 0.62, 0.32);
  }
  // color grade: violet shadows / amber highlights (Outer Wilds dusk mood)
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 shadows = vec3(0.052, 0.030, 0.085);
  vec3 highs = vec3(1.12, 0.80, 0.48);
  col = mix(col * highs * 0.94, mix(col, col * highs, 0.55) + shadows * (1.0 - clamp(lum * 2.6, 0.0, 1.0)) * 1.15, uGrade);
  // excess fill light flattens the image into pale pink — crush blacks and re-saturate
  col = max(col - 0.022, vec3(0.0)) * 1.10;
  float lum2 = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum2), col, 1.22);
  // screen dirt during storms
  if (uDirt > 0.001){
    vec3 dirt = texture2D(uDirtTex, uv * 1.15 + 0.02).rgb;
    // grit on the lens during storms — sparse, so it reads as dust not static
    float specks = step(0.9977, h12(floor(uv * vec2(900.0, 520.0))));
    col = mix(col, col * vec3(0.72, 0.55, 0.38) + dirt * 0.06, uDirt * 0.8);
    col += vec3(0.75, 0.55, 0.35) * specks * uDirt * 0.12;
  }
  // vignette
  col *= clamp(1.0 - r2 * uVignette * 1.35, 0.0, 1.5);
  // launch flash / color bias — a bias, not a whiteout: the frame has to keep its structure
  col = mix(col, col * vec3(1.35, 0.78, 0.58) + uFlashCol * 0.18, uFlash);
  // film grain, scaled by luminance so a night frame never fills with grey snow
  float g = h12(uv * (uRes + uTime * 60.0)) - 0.5;
  col += g * uGrain * (0.18 + 0.82 * clamp(lum2 * 2.4, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`,
};

function makeDirtTexture() {
  const s = 512, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 420; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 1 + Math.random() * 14;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${140 + Math.random() * 80 | 0},100,60,${0.05 + Math.random() * 0.16})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  return t;
}

export function createPost(renderer, scene, camera, quality, w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: quality.samples });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  let ssao = null, bokeh = null;
  if (quality.ssao) {
    ssao = new SSAOPass(scene, camera, w, h);
    ssao.kernelRadius = 10; ssao.minDistance = 0.0006; ssao.maxDistance = 0.09;
    ssao.output = SSAOPass.OUTPUT.Default;
    composer.addPass(ssao);
  }
  if (quality.dof) {
    bokeh = new BokehPass(scene, camera, { focus: 24, aperture: 0.00006, maxblur: 0.008 });
    composer.addPass(bokeh);
  }
  const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), quality.bloomStrength, 0.75, 0.82);
  composer.addPass(bloom);
  const finalPass = new ShaderPass(FINAL);
  finalPass.uniforms.uDirtTex.value = makeDirtTexture();
  finalPass.uniforms.uRes.value.set(w, h);
  composer.addPass(finalPass);
  composer.addPass(new OutputPass());
  return {
    composer, bloom, ssao, bokeh, final: finalPass,
    setSize(w, h) {
      composer.setSize(w, h);
      finalPass.uniforms.uRes.value.set(w, h);
    },
  };
}
