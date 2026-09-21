// maxPixels caps the *framebuffer* area, not the device ratio: a 1.5 ratio on a small window and
// on a 4K display differ by four times in cost, and it is the area that decides the frame time.
export const QUALITIES = {
  low:   { label:'低', pixelRatio:0.75, maxPixels:0.6e6, shadow:0,    particles:0.30, ssao:false, bloom:true,  bloomStrength:0.55, godrays:false, envUpdateHz:1.0, stormParticles:900  },
  med:   { label:'中', pixelRatio:1.0,  maxPixels:1.3e6, shadow:1024, particles:0.60, ssao:true,  bloom:true,  bloomStrength:0.70, godrays:true,  envUpdateHz:2.0, stormParticles:2000 },
  high:  { label:'高', pixelRatio:1.5,  maxPixels:2.3e6, shadow:2048, particles:1.0,  ssao:true,  bloom:true,  bloomStrength:0.85, godrays:true,  envUpdateHz:2.0, stormParticles:3800 },
  ultra: { label:'极致',pixelRatio:2.0, maxPixels:4.0e6, shadow:3072, particles:1.6,  ssao:true,  bloom:true,  bloomStrength:0.95, godrays:true,  envUpdateHz:2.0, stormParticles:6000 },
};

// Compact art-diorama layout (metres). +X east, +Z south.
// The districts no longer sit where each one looked good on its own: every district owns a cell of
// a 3x3 lattice of 60 m blocks, with two avenues and two streets crossing between them (the rules
// live in src/world/plan.js). Cell centres are x,z ∈ {-60, 0, 60} and the street centrelines sit at
// ±30, so two districts can no longer grow into each other the way the old five spokes radiating
// from one hub did — industry and habitat used to lean on the same ground and their props merged
// into one pile of overlapping collision discs.
export const ISLAND = { radius: 118, rim: 132 };   // flat playfield, then a raised crater-rim wall

export const ZONES = {
  // the core is a pedestrian plaza: the street grid rings it at ±30 and no road crosses it
  hub:       { name:'中央广场',   pos:[   0,   0],  radius:22, padHeight:0.6, teleport:true },
  // launch takes the south-west corner — the only district that needs real standoff from people
  launch:    { name:'星舰发射台', pos:[ -60, -60],  radius:26, padHeight:0.6, teleport:true },
  habitat:   { name:'生活舱区',   pos:[ -60,  60],  radius:22, padHeight:0.5, teleport:true },
  industry:  { name:'工厂储罐区', pos:[  60,  60],  radius:22, padHeight:0.5, teleport:true },
  comms:     { name:'通讯阵列',   pos:[  60, -60],  radius:20, padHeight:0.5, teleport:true },
  science:   { name:'晶体科研区', pos:[   0,  60],  radius:20, padHeight:0.4, teleport:true },
  // motor pool: the crew rover and the walker, straight ahead of the spawn point
  motor:     { name:'车辆整备场', pos:[   0, -60],  radius:20, padHeight:0.5 },
  // single-purpose sites, each set back off a frontage rather than dropped in a gap
  watch:     { name:'发射观礼台', pos:[ -16, -17],  radius:11, padHeight:0.5 },
  night:     { name:'夜空观赏丘', pos:[  60,   0],  radius:18, padHeight:0.4 },
  storm:     { name:'残骸场',     pos:[ -60,   0],  radius:22 },
  roadster:  { name:'隐藏彩蛋',   pos:[ 100,  -8],  radius:12 },
  wild:      { name:'野外',       pos:[   0,   0],  radius:120 },
};

export const START = { pos:[0, -26, 0.6], heading: 0 };   // south of the gate, facing the plaza
export const SHIP_POS = [-60, -60];
export const LEAK_POS = [86, 44];
export const TERRAIN = { size: 300, seg: 220 };
export const SAMPLE_COUNT = 6;
