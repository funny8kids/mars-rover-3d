export const QUALITIES = {
  low:   { label:'低', pixelRatio:0.75, shadow:0,    particles:0.30, ssao:false, dof:false, bloom:true,  bloomStrength:0.55, godrays:false, samples:0, envUpdateHz:1.0,  stormParticles:900  },
  med:   { label:'中', pixelRatio:1.0,  shadow:1536, particles:0.60, ssao:false, dof:false, bloom:true,  bloomStrength:0.7,  godrays:true,  samples:0, envUpdateHz:2.0,  stormParticles:2000 },
  high:  { label:'高', pixelRatio:1.5,  shadow:2048, particles:1.0,  ssao:true,  dof:true,  bloom:true,  bloomStrength:0.85, godrays:true,  samples:4, envUpdateHz:4.0,  stormParticles:3800 },
  ultra: { label:'极致',pixelRatio:2.0, shadow:4096, particles:1.6,  ssao:true,  dof:true,  bloom:true,  bloomStrength:0.95, godrays:true,  samples:8, envUpdateHz:6.0,  stormParticles:6000 },
};

// Compact art-diorama layout (metres). The whole base lives inside a ~110 m playfield
// on a stylised Martian island — every point of interest is a short, dense drive away,
// and teleport pads link them. +X east, +Z south.
export const ISLAND = { radius: 118, rim: 132 };   // flat playfield, then a raised crater-rim wall

export const ZONES = {
  hub:       { name:'中央广场',   pos:[   0,   0],  radius:26, padHeight:0.6, teleport:true },
  habitat:   { name:'生活舱区',   pos:[ -58,  40],  radius:24, padHeight:0.5, teleport:true },
  industry:  { name:'工厂储罐区', pos:[  58,  34],  radius:24, padHeight:0.5, teleport:true },
  comms:     { name:'通讯阵列',   pos:[  46, -56],  radius:20, padHeight:0.5, teleport:true },
  launch:    { name:'发射台',     pos:[ -46, -58],  radius:26, padHeight:0.6, teleport:true },
  science:   { name:'晶体科研区', pos:[   4,  74],  radius:22, padHeight:0.4, teleport:true },
  // legacy aliases kept so mission/race code paths resolve
  production:{ name:'工厂储罐区', pos:[  58,  34],  radius:24, padHeight:0.5 },
  tanks:     { name:'工厂储罐区', pos:[  58,  34],  radius:24, padHeight:0.5 },
  watch:     { name:'发射观礼台', pos:[ -18, -18],  radius:16, padHeight:0.5 },
  night:     { name:'夜空观赏丘', pos:[  78, -18],  radius:18, padHeight:0.4 },
  wild:      { name:'野外',       pos:[   0,   0],  radius:120 },
  storm:     { name:'残骸场',     pos:[ -84,  12],  radius:26 },
  roadster:  { name:'隐藏彩蛋',   pos:[  30,  92],  radius:14 },
};

export const START = { pos:[0, -26, 0.6], heading: 0 };   // south of the gate, facing the plaza
export const SHIP_POS = [-46, -58];
export const LEAK_POS = [66, 24];
export const TERRAIN = { size: 300, seg: 220 };
export const SAMPLE_COUNT = 6;
