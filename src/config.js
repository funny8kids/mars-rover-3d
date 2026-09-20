export const QUALITIES = {
  low:   { label:'低', pixelRatio:0.75, shadow:0,    particles:0.30, ssao:false, dof:false, bloom:true,  bloomStrength:0.55, godrays:false, samples:0, envUpdateHz:1.0,  stormParticles:900  },
  med:   { label:'中', pixelRatio:1.0,  shadow:1536, particles:0.60, ssao:false, dof:false, bloom:true,  bloomStrength:0.7,  godrays:true,  samples:0, envUpdateHz:2.0,  stormParticles:2000 },
  high:  { label:'高', pixelRatio:1.5,  shadow:2048, particles:1.0,  ssao:true,  dof:true,  bloom:true,  bloomStrength:0.85, godrays:true,  samples:4, envUpdateHz:4.0,  stormParticles:3800 },
  ultra: { label:'极致',pixelRatio:2.0, shadow:4096, particles:1.6,  ssao:true,  dof:true,  bloom:true,  bloomStrength:0.95, godrays:true,  samples:8, envUpdateHz:6.0,  stormParticles:6000 },
};

// world layout — meters. +X east, +Z south-ish on ground plane.
export const ZONES = {
  launch:    { name:'发射区',      pos:[-260, 0],    radius:120, padHeight:1.2 },
  production:{ name:'生产区',      pos:[ 40, 170],   radius:110, padHeight:1.0 },
  tanks:     { name:'储罐区',      pos:[ 190, -60],  radius:95,  padHeight:1.0 },
  habitat:   { name:'生活区',      pos:[ -60,-210],  radius:110, padHeight:1.0 },
  wild:      { name:'野外',        pos:[ 420, 320],  radius:400 },
  storm:     { name:'沙尘暴区',    pos:[ 620, -260], radius:280 },
  night:     { name:'夜空观赏点',  pos:[-420, 330],  radius:120 },
  roadster:  { name:'隐藏彩蛋区',  pos:[ 470, 420],  radius:60 },
  watch:     { name:'发射观礼台',  pos:[ -95,-95],   radius:26, padHeight:1.0 },
};

export const START = { pos:[10, -70, 1.0], heading: Math.PI*0.25 };
export const SHIP_POS = [-260, 0];
export const LEAK_POS = [215, -30];
export const TERRAIN = { size: 2600, seg: 250 };
export const SAMPLE_COUNT = 6;
