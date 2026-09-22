// Every structure on the base is a CC0 kit piece: clean boxes and cylinders in a flat colour. Under a
// hard sun that reads as "programmer art" however good the lighting is, because real hardware is
// assembled — it has panel joints, fasteners, grit and weathering. Rather than re-topologise 1279
// meshes, put that information in the shading, anchored in world space on the same 2.6 m module grid
// the paved pads already use, so hulls, walls and decks read as built from the same stock.
// Static geometry only: a world-anchored pattern would slide across anything that moves.
const MODULE = 2.6;

// Only the two varyings may cross into the vertex stage. The helpers below call fwidth, which is a
// fragment-only derivative in GLSL ES — injecting the whole block into the vertex shader made every
// patched program fail to compile, and then every draw with it logged INVALID_OPERATION.
const VARY = /* glsl */`
  varying vec3 vRsbW;
  varying vec3 vRsbN;
`;

const PARS = /* glsl */`
  #ifndef RSB_SURFACE_PARS
  #define RSB_SURFACE_PARS
  float gRsbRough = 1.0;
  float rsbHash( vec2 p ) {
    float s = sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453;
    return s - floor( s );
  }
  float rsbNoise( vec2 p ) {
    vec2 i = floor( p ), f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( rsbHash( i ), rsbHash( i + vec2( 1.0, 0.0 ) ), f.x ),
                mix( rsbHash( i + vec2( 0.0, 1.0 ) ), rsbHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
  }
  // Box projection: take the two axes the surface is not facing, so walls and floors both get square
  // panels instead of one of them smearing into stripes.
  vec2 rsbFace( vec3 p, vec3 n ) {
    vec3 a = abs( n );
    if ( a.y > a.x && a.y > a.z ) return p.xz;
    if ( a.x > a.y && a.x > a.z ) return p.zy;
    return p.xy;
  }
  float rsbGrid( vec2 uv, float cell, float halfw ) {
    vec2 g = abs( fract( uv / cell - 0.5 ) - 0.5 ) * cell;
    float d = min( g.x, g.y );
    return 1.0 - smoothstep( 0.0, max( halfw, fwidth( d ) ), d );
  }
  float rsbLip( vec2 uv, float cell ) {
    vec2 g = abs( fract( uv / cell - 0.5 ) - 0.5 ) * cell;
    float d = min( g.x, g.y );
    float aa = fwidth( d );
    return ( 1.0 - smoothstep( 0.0, cell * 0.055 + aa, d ) )
         - ( 1.0 - smoothstep( 0.0, cell * 0.014 + aa, d ) );
  }
  float rsbRivet( vec2 uv, float cell ) {
    vec2 c = ( floor( uv / cell ) + 0.5 ) * cell;
    float d = length( uv - c );
    return 1.0 - smoothstep( cell * 0.026, cell * 0.048 + fwidth( d ), d );
  }
  #endif
`;

// Two passes in one string, because only one of them is manufacturing.
//
// `panel` is the built world: joints on a 2.6 m module, a lipped seam, a rivet at each corner, and the
// lower roughness of machined metal. `dust` is the weather, which lands on everything.
//
// Natural stone takes only the second. A panel joint and a module-corner rivet cast onto a boulder are
// straight grey lines across a curved face, and raycasting the dune views proved this patch — not the
// drift shader, not the terrain — was drawing the seamed "tent" facets all over the open desert.
function patch(panel) {
  return /* glsl */`
  {
    vec3 nrm = normalize( vRsbN );
    vec2 uv = rsbFace( vRsbW, nrm );
    ${panel ? /* glsl */`
    float major = rsbGrid( uv, ${MODULE}, ${MODULE} * 0.011 );
    float minor = rsbGrid( uv, ${MODULE * 0.25}, ${MODULE} * 0.004 ) * 0.40;
    float joint = max( major, minor );
    float riv = rsbRivet( uv, ${MODULE} ) * major;
    float grit = rsbNoise( uv * 11.0 ) * 0.6 + rsbNoise( uv * 43.0 ) * 0.4;

    diffuseColor.rgb *= 1.0 - joint * 0.40;
    diffuseColor.rgb += vec3( 0.085, 0.080, 0.074 ) * rsbLip( uv, ${MODULE} );
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.40, 0.41, 0.43 ), riv * 0.55 );
    diffuseColor.rgb *= 0.91 + grit * 0.16;
    gRsbRough = 1.0 - joint * 0.34 - riv * 0.38 + grit * 0.09;` : ''}

    // Weathering: fine dust films every upward face, runoff streaks the sides.
    float dust = rsbNoise( uv * 2.1 + 7.0 ) * 0.65 + rsbNoise( uv * 7.3 ) * 0.35;
    diffuseColor.rgb = mix( diffuseColor.rgb,
      diffuseColor.rgb * vec3( 1.14, 0.97, 0.80 ) + vec3( 0.050, 0.026, 0.010 ),
      clamp( nrm.y, 0.0, 1.0 ) * dust * 0.55 );
    float side = 1.0 - abs( nrm.y );
    diffuseColor.rgb *= 1.0 - side * smoothstep( 0.55, 0.96, rsbNoise( vec2( uv.x * 5.5, uv.y * 0.75 ) ) ) * 0.18;
  }
`;
}

// Grown or broken, not built: no module, no fasteners. `rock_basalt` is the forged rim/clast kit, and it
// is the only natural material in here — the drift sand has its own shader and is skipped above.
const NATURAL = /^rock_basalt$/;

const skip = (mt) => !mt || !mt.isMeshStandardMaterial || mt.transparent === true
  || /^light_|glass|plant|leaf|crystal|pad_glow|drift_/.test(mt.name || '')
  || (mt.emissive && (mt.emissive.r + mt.emissive.g + mt.emissive.b) / 3 * (mt.emissiveIntensity ?? 1) > 0.25);

export function applySurfaceDetail(root) {
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const mt of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (skip(mt) || seen.has(mt)) continue;
      seen.add(mt);
      const natural = NATURAL.test(mt.name || '');
      const base = mt.onBeforeCompile;
      mt.onBeforeCompile = (shader, renderer) => {
        base?.(shader, renderer);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\n' + VARY)
          // `transformed` is pre-instance: an instanced buffer holds one clone of the vertices, so
          // without the instanceMatrix term every copy would sample the panel grid at the ORIGIN's
          // world position and the whole batch would share one weathering streak.
          .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 rsbWorld = vec4( transformed, 1.0 );
        vec3 rsbNormal = objectNormal;
        #ifdef USE_INSTANCING
          rsbWorld = instanceMatrix * rsbWorld;
          rsbNormal = mat3( instanceMatrix ) * rsbNormal;
        #endif
        vRsbW = ( modelMatrix * rsbWorld ).xyz;
        vRsbN = normalize( mat3( modelMatrix ) * rsbNormal );`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\n' + VARY + PARS)
          .replace('#include <color_fragment>', '#include <color_fragment>\n' + patch(!natural));
        if (!natural) {
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp( roughnessFactor * gRsbRough, 0.04, 1.0 );`);
        }
      };
      mt.customProgramCacheKey = () => natural ? 'rsb-surface-dust' : 'rsb-surface-detail';
    }
  });
}
