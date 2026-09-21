import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

// Same 32-tap hemisphere, same occlusion window and same 5x5 blur as three's SSAOPass, so the darkening
// itself is unchanged. What differs is the geometry input: the vendor pass re-renders the whole scene
// with MeshNormalMaterial to get a normal buffer, and this one rebuilds the normal from four neighbouring
// depth samples of the beauty pass.
const AO_FRAG = /* glsl */`
uniform sampler2D tDepth;
uniform sampler2D tNoise;
uniform vec3 kernel[ KERNEL_SIZE ];
uniform vec2 resolution;
uniform float cameraNear;
uniform float cameraFar;
uniform mat4 cameraProjectionMatrix;
uniform mat4 cameraInverseProjectionMatrix;
uniform float kernelRadius;
uniform float minDistance;
uniform float maxDistance;

varying vec2 vUv;

#include <packing>

float depthAt( const in vec2 screenPosition ) {
  return texture2D( tDepth, screenPosition ).x;
}

float linearAt( const in vec2 screenPosition ) {
  return viewZToOrthographicDepth( perspectiveDepthToViewZ( depthAt( screenPosition ), cameraNear, cameraFar ), cameraNear, cameraFar );
}

vec3 viewPosAt( const in vec2 screenPosition, const in float depth ) {
  float viewZ = perspectiveDepthToViewZ( depth, cameraNear, cameraFar );
  float clipW = cameraProjectionMatrix[ 2 ][ 3 ] * viewZ + cameraProjectionMatrix[ 3 ][ 3 ];
  vec4 clipPosition = vec4( ( vec3( screenPosition, depth ) - 0.5 ) * 2.0, 1.0 );
  clipPosition *= clipW; // unprojection
  return ( cameraInverseProjectionMatrix * clipPosition ).xyz;
}

// Reversed-normal estimation: four neighbours give four candidate planes, and the pair whose depths sit
// closest to the centre is the one that is still the same surface. Without that test the sample that
// steps off a silhouette onto the sky builds a near-perpendicular normal and draws a dark halo around
// every hull — the classic failure of depth-only AO.
vec3 normalFromDepth( const in vec2 screenPosition, const in float depth, const in vec3 center ) {

  vec2 texel = 1.0 / resolution;
  vec2 dx = vec2( texel.x, 0.0 ), dy = vec2( 0.0, texel.y );

  float dR = depthAt( screenPosition + dx ), dL = depthAt( screenPosition - dx );
  float dU = depthAt( screenPosition + dy ), dD = depthAt( screenPosition - dy );

  vec3 pR = viewPosAt( screenPosition + dx, dR ), pL = viewPosAt( screenPosition - dx, dL );
  vec3 pU = viewPosAt( screenPosition + dy, dU ), pD = viewPosAt( screenPosition - dy, dD );

  vec3 n = cross( pR - center, pU - center );
  float w = abs( dR - depth ) + abs( dU - depth );

  vec3 c = cross( pU - center, pL - center );
  float cw = abs( dU - depth ) + abs( dL - depth );
  if ( cw < w ) { w = cw; n = c; }

  c = cross( pL - center, pD - center );
  cw = abs( dL - depth ) + abs( dD - depth );
  if ( cw < w ) { w = cw; n = c; }

  c = cross( pD - center, pR - center );
  cw = abs( dD - depth ) + abs( dR - depth );
  if ( cw < w ) { n = c; }

  if ( dot( n, n ) < 1e-12 ) return vec3( 0.0, 0.0, 1.0 ); // degenerate patch: face the camera, never NaN

  n = normalize( n );
  return dot( n, center ) > 0.0 ? -n : n; // view space: the camera is at the origin
}

void main() {

  float depth = depthAt( vUv );

  if ( depth == 1.0 ) {

    gl_FragColor = vec4( 1.0 ); // sky: don't darken the horizon

  } else {

    vec3 viewPosition = viewPosAt( vUv, depth );
    vec3 viewNormal = normalFromDepth( vUv, depth, viewPosition );

    vec2 noiseScale = vec2( resolution.x / 4.0, resolution.y / 4.0 );
    vec3 random = vec3( texture2D( tNoise, vUv * noiseScale ).r );

    vec3 tangent = normalize( random - viewNormal * dot( random, viewNormal ) );
    vec3 bitangent = cross( viewNormal, tangent );
    mat3 kernelMatrix = mat3( tangent, bitangent, viewNormal );

    float occlusion = 0.0;

    for ( int i = 0; i < KERNEL_SIZE; i ++ ) {

      vec3 sampleVector = kernelMatrix * kernel[ i ];
      vec3 samplePoint = viewPosition + ( sampleVector * kernelRadius );

      vec4 samplePointNDC = cameraProjectionMatrix * vec4( samplePoint, 1.0 );
      samplePointNDC /= samplePointNDC.w;

      vec2 samplePointUv = samplePointNDC.xy * 0.5 + 0.5;

      float realDepth = linearAt( samplePointUv );
      float sampleDepth = viewZToOrthographicDepth( samplePoint.z, cameraNear, cameraFar );
      float delta = sampleDepth - realDepth;

      if ( delta > minDistance && delta < maxDistance ) {

        occlusion += 1.0;

      }

    }

    occlusion = clamp( occlusion / float( KERNEL_SIZE ), 0.0, 1.0 );

    gl_FragColor = vec4( vec3( 1.0 - occlusion ), 1.0 );

  }

}`;

const BLUR_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 resolution;

varying vec2 vUv;

void main() {

  vec2 texelSize = ( 1.0 / resolution );
  float result = 0.0;

  for ( int i = - 2; i <= 2; i ++ ) {

    for ( int j = - 2; j <= 2; j ++ ) {

      result += texture2D( tDiffuse, vUv + ( vec2( float( i ), float( j ) ) * texelSize ) ).r;

    }

  }

  gl_FragColor = vec4( vec3( result / ( 5.0 * 5.0 ) ), 1.0 );

}`;

const COPY_FRAG = /* glsl */`
uniform sampler2D tDiffuse;

varying vec2 vUv;

void main() {
  gl_FragColor = texture2D( tDiffuse, vUv );
}`;

function makeKernel(size) {
  const kernel = [];
  for (let i = 0; i < size; i++) {
    const s = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random()).normalize();
    // Samples are biased toward the surface, so contact darkening survives a small radius without the
    // far taps bleeding the sky into every crevice.
    const scale = THREE.MathUtils.lerp(0.1, 1, (i / size) * (i / size));
    kernel.push(s.multiplyScalar(scale));
  }
  return kernel;
}

// 4x4 of random rotation vectors, tiled across the screen, so the 32 taps don't line up into a moiré.
function makeNoise() {
  const data = new Float32Array(16);
  for (let i = 0; i < 16; i++) data[i] = Math.random();
  const t = new THREE.DataTexture(data, 4, 4, THREE.RedFormat, THREE.FloatType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

export class DepthAOpass extends Pass {
  // No scene: the depth attachment of the beauty buffer is the only geometry input, which is exactly
  // the point. The composer's render target must carry a depthTexture (see post.js).
  constructor(camera, width, height, kernelSize = 32) {
    super();
    this.needsSwap = false; // darkens readBuffer in place, exactly like the pass it replaces
    this.camera = camera;
    this.width = width;
    this.height = height;
    this.kernelRadius = 1.2;
    this.minDistance = 0.0000022;
    this.maxDistance = 0.000333;

    this.kernel = makeKernel(kernelSize);
    this.noiseTexture = makeNoise();

    this.aoRenderTarget = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType });
    this.blurRenderTarget = this.aoRenderTarget.clone();

    const shared = { depthTest: false, depthWrite: false };

    this.aoMaterial = new THREE.ShaderMaterial({
      name: 'rsb depth AO',
      defines: { KERNEL_SIZE: kernelSize },
      uniforms: {
        tDepth: { value: null },
        tNoise: { value: this.noiseTexture },
        kernel: { value: this.kernel },
        cameraNear: { value: camera.near },
        cameraFar: { value: camera.far },
        resolution: { value: new THREE.Vector2(width, height) },
        cameraProjectionMatrix: { value: new THREE.Matrix4() },
        cameraInverseProjectionMatrix: { value: new THREE.Matrix4() },
        kernelRadius: { value: this.kernelRadius },
        minDistance: { value: this.minDistance },
        maxDistance: { value: this.maxDistance },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: AO_FRAG,
      ...shared,
    });

    this.blurMaterial = new THREE.ShaderMaterial({
      name: 'rsb AO blur',
      uniforms: { tDiffuse: { value: this.aoRenderTarget.texture }, resolution: { value: new THREE.Vector2(width, height) } },
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      ...shared,
    });

    // MultiplyBlending is destination × source, which is how AO belongs on a lit frame.
    this.copyMaterial = new THREE.ShaderMaterial({
      name: 'rsb AO composite',
      uniforms: { tDiffuse: { value: this.blurRenderTarget.texture } },
      vertexShader: QUAD_VERT,
      fragmentShader: COPY_FRAG,
      ...shared,
      blending: THREE.MultiplyBlending,
    });

    this.fsQuad = new FullScreenQuad(null);
  }

  dispose() {
    this.aoRenderTarget.dispose();
    this.blurRenderTarget.dispose();
    this.aoMaterial.dispose();
    this.blurMaterial.dispose();
    this.copyMaterial.dispose();
    this.noiseTexture.dispose();
    this.fsQuad.dispose();
  }

  quad(renderer, material, target) {
    // autoClear would wipe the beauty pixels the composite is about to multiply onto.
    const originalAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    this.fsQuad.material = material;
    this.fsQuad.render(renderer);
    renderer.autoClear = originalAutoClear;
  }

  render(renderer, writeBuffer, readBuffer) {
    const depth = readBuffer.depthTexture;
    if (!depth) throw new Error('DepthAOpass: the composer render target needs a depthTexture attachment');

    const u = this.aoMaterial.uniforms;
    // The chase rig re-derives FOV with speed every frame the rover accelerates, so the matrices have to
    // come from the live camera or the unprojection looks for occluders at UVs it never rendered.
    u.cameraNear.value = this.camera.near;
    u.cameraFar.value = this.camera.far;
    u.cameraProjectionMatrix.value.copy(this.camera.projectionMatrix);
    u.cameraInverseProjectionMatrix.value.copy(this.camera.projectionMatrixInverse);
    u.tDepth.value = depth;
    u.kernelRadius.value = this.kernelRadius;
    u.minDistance.value = this.minDistance;
    u.maxDistance.value = this.maxDistance;

    this.quad(renderer, this.aoMaterial, this.aoRenderTarget);

    this.blurMaterial.uniforms.tDiffuse.value = this.aoRenderTarget.texture;
    this.quad(renderer, this.blurMaterial, this.blurRenderTarget);

    this.copyMaterial.uniforms.tDiffuse.value = this.blurRenderTarget.texture;
    this.quad(renderer, this.copyMaterial, this.renderToScreen ? null : readBuffer);
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    this.aoRenderTarget.setSize(width, height);
    this.blurRenderTarget.setSize(width, height);
    this.aoMaterial.uniforms.resolution.value.set(width, height);
    this.blurMaterial.uniforms.resolution.value.set(width, height);
  }
}
