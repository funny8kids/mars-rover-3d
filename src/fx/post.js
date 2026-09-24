import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { DepthAOpass } from './depth_ao.js';

// EffectComposer.setSize() re-sizes every pass to the full effective buffer, so a pass that only
// needs to work in a blurry half-resolution world has to opt out by hand. Without this the
// constructor's resolution argument is silently discarded on the first addPass().
function atScale(pass, k) {
  const base = pass.setSize.bind(pass);
  pass.setSize = (w, h) => base(Math.max(2, Math.round(w * k)), Math.max(2, Math.round(h * k)));
  return pass;
}

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
    uStorm: { value: 0 },
    uGrade: { value: 1 },
    uNight: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse, uDirtTex;
uniform float uTime, uGodRay, uCA, uGrain, uVignette, uDirt, uFlash, uGrade, uNight, uStorm;
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
  // god rays: radial march toward the sun's screen position.
  // The march step has to be bounded and the samples have to stop at the frame edge: with the sun
  // just off-screen the step was larger than the whole frame, so all ten taps clamped onto the same
  // bright sky row and painted solid gold bars across half the image.
  if (uGodRay > 0.001){
    vec3 rays = vec3(0.0);
    vec2 d = clamp((uv - uSunUV) * -0.062, vec2(-0.030), vec2(0.030));
    vec2 p = uv;
    float illum = 1.0;
    for (int i = 0; i < 10; i++){
      p += d;
      float inside = step(0.0, p.x) * step(p.x, 1.0) * step(0.0, p.y) * step(p.y, 1.0);
      vec3 s = texture2D(tDiffuse, clamp(p, 0.001, 0.999)).rgb;
      rays += max(s * dot(s, vec3(0.333)) - 0.55, 0.0) * illum * inside;
      illum *= 0.86;
    }
    col += rays * 0.045 * uGodRay * vec3(1.0, 0.62, 0.32);
  }
  // color grade: violet shadows / amber highlights by day (Outer Wilds dusk mood).
  // At night this same violet sat on an already dark frame and turned the whole base into
  // purple mush, so the split-tone, the black crush and the vignette all back off with it.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  // The old lift was blue-dominant (0.085 B vs 0.052 R), so every unlit face — the underside of
  // arches, the shaded side of hulls — collapsed into a purple dead-pixel silhouette.
  //
  // The night half fixed that only partway: (0.020, 0.026, 0.048) is still blue at 2.4× its red, and
  // because the term is *added flat* onto every pixel the scene failed to light, it is the reason the
  // after-dark frame held one hue no matter what the lamps were set to. Measured 2026-09-24: raising
  // the scene's own night fill by 48 % (hemisphere, ambient, moon key, in world/environment.js) moved
  // the shadow band's blue/red ratio by 0.065 at three of four vantages and by 0.009 at the fourth.
  // A grade that swallows a half-strength relight is not tinting the scene, it is replacing it — and
  // a constant added across the whole frame carries no geometry, which is the other half of why unlit
  // ground read as a slab instead of a surface.
  //
  // So the night side of the split tone flips. Cool stays on the highlights, where the moon actually
  // is; the shadows take the rust-warm of a settlement's own lamp spill bouncing off the deck, which
  // is what a base at night is genuinely made of and is the second hue the frame was missing. The lift
  // comes back up (0.55 → 0.85) because the black floor it was being rationed against is the defect,
  // not the cost of avoiding one.
  vec3 shadows = mix(vec3(0.062, 0.042, 0.062), vec3(0.038, 0.026, 0.021), uNight);
  vec3 highs = mix(vec3(1.10, 0.88, 0.64), vec3(0.92, 0.97, 1.10), uNight);
  col = mix(col * highs * 0.94, mix(col, col * highs, 0.55) + shadows * (1.0 - clamp(lum * 2.6, 0.0, 1.0)) * mix(1.15, 0.85, uNight), uGrade);
  // excess fill light flattens the image into pale pink — crush blacks and re-saturate
  col = max(col - mix(0.022, 0.004, uNight), vec3(0.0)) * mix(1.10, 1.55, uNight);
  float lum2 = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum2), col, mix(1.22, 1.10, uNight));
  // Dust stratification. The column of air between you and a pixel near the bottom of the frame is
  // far longer than the one to a pixel near the zenith, so the cast has to fall the same way. One
  // tint multiplied over the whole image is what made the old storm read as a sepia filter rather
  // than weather standing over you.
  if (uStorm > 0.001){
    float low = 1.0 - smoothstep(0.06, 0.82, uv.y);
    col = mix(col, col * vec3(1.22, 0.80, 0.44), uStorm * low * 0.34);
    col = mix(col, col * vec3(0.86, 0.74, 0.72), uStorm * (1.0 - low) * 0.22);
  }
  // screen dirt during storms
  if (uDirt > 0.001){
    vec3 dirt = texture2D(uDirtTex, uv * 1.15 + 0.02).rgb;
    // grit on the lens during storms — sparse, so it reads as dust not static
    float specks = step(0.9977, h12(floor(uv * vec2(900.0, 520.0))));
    col = mix(col, col * vec3(0.72, 0.55, 0.38) + dirt * 0.06, uDirt * 0.8);
    col += vec3(0.75, 0.55, 0.35) * specks * uDirt * 0.12;
  }
  // vignette
  col *= clamp(1.0 - r2 * uVignette * mix(1.35, 0.82, uNight), 0.0, 1.5);
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
  // Four samples of MSAA on a half-float buffer is four times the blend bandwidth on every
  // triangle in the scene, and the effect composer then resamples that buffer anyway. The edges
  // come back from the FXAA pass at the end for a twentieth of the cost.
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  if (quality.ssao) {
    // The beauty pass is now the geometry source for contact darkening, so its render target has to
    // publish depth as a texture. EffectComposer keeps two buffers and the pass chain ends on an odd
    // number of swapping passes, so readBuffer alternates between them every frame: both need their
    // own attachment or half the frames would multiply onto an untouched buffer.
    for (const buf of [composer.renderTarget1, composer.renderTarget2]) {
      const d = new THREE.DepthTexture(buf.width, buf.height);
      d.format = THREE.DepthFormat;
      d.type = THREE.UnsignedIntType;
      buf.depthTexture = d;
    }
    // Contact darkening at half resolution. AO is a low-frequency signal with a blur on top of it,
    // so a full-resolution buffer bought nothing but three million extra samples a frame.
    const ssao = atScale(new DepthAOpass(camera, w, h), 0.5);
    // kernelRadius is in view-space metres; min/maxDistance are normalised over cameraNear..Far,
    // and with a 9 000 m far plane one metre of depth is 1/9000 of the range. The old band (0.00004
    // / 0.0014) was 0.36 m … 12.6 m of linear depth, which a 0.65 m kernel can never reach: the map
    // came back uniformly white and the beauty frame was bit-identical with the pass on and off.
    // 2 cm … 3 m is what a 1.2 m hemisphere actually produces, and it is the difference between a
    // gate that stands on the plaza and one that floats over it.
    ssao.kernelRadius = 1.2; ssao.minDistance = 0.0000022; ssao.maxDistance = 0.000333;
    composer.addPass(ssao);
  }
  // Bloom mips are by definition blurry, so the chain starts at a quarter of the frame's pixels
  // rather than its full size — the same four bright hull pixels, at a quarter the bandwidth.
  const bloom = atScale(new UnrealBloomPass(new THREE.Vector2(w, h), quality.bloomStrength, 0.62, 1.75), 0.5);
  composer.addPass(bloom);
  const finalPass = new ShaderPass(FINAL);
  finalPass.uniforms.uDirtTex.value = makeDirtTexture();
  finalPass.uniforms.uRes.value.set(w, h);
  composer.addPass(finalPass);
  composer.addPass(new OutputPass());
  const fxaa = new ShaderPass(FXAAShader);
  const setFxaa = (w, h) => fxaa.uniforms.resolution.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  fxaa.setSize = setFxaa;
  composer.addPass(fxaa);
  return {
    composer, bloom, ssao: quality.ssao ? composer.passes[1] : null, final: finalPass, fxaa,
    setSize(w, h) {
      // EffectComposer caches the renderer's pixel ratio at construction, so a resize or an
      // auto-degrade that changes it has to re-publish it or the buffers stay at the old area.
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
      // WebGLRenderTarget.setSize() re-sizes the colour texture and leaves depthTexture.image behind
      // at the old size, and the renderer refuses to bind a depth attachment that disagrees with its
      // render target. Re-publish it here rather than trusting the renderer to heal the buffer.
      for (const buf of [composer.renderTarget1, composer.renderTarget2]) {
        const d = buf.depthTexture;
        if (d) {
          d.image.width = buf.width;
          d.image.height = buf.height;
          d.needsUpdate = true;
        }
      }
      finalPass.uniforms.uRes.value.set(w * composer._pixelRatio, h * composer._pixelRatio);
    },
  };
}
