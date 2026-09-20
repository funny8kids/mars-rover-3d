// Fully synthesized spatial audio: engine, wind, comms, launch rumble, leak hiss.
export class GameAudio {
  constructor() { this.ready = false; }
  async init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 6;
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    this.lowpass = ctx.createBiquadFilter(); this.lowpass.type = 'lowpass'; this.lowpass.frequency.value = 20000;
    this.master.connect(this.lowpass); this.lowpass.connect(comp); comp.connect(ctx.destination);

    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 128;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.master.connect(this.analyser);

    // noise buffer
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;

    // engine: saw + sub through lowpass
    const g = this.engineG = ctx.createGain(); g.gain.value = 0;
    const f = this.engineF = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 300; f.Q.value = 6;
    this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth'; this.o1.frequency.value = 55;
    this.o2 = ctx.createOscillator(); this.o2.type = 'square'; this.o2.frequency.value = 27.5;
    const og2 = ctx.createGain(); og2.gain.value = 0.35;
    this.o1.connect(f); this.o2.connect(og2); og2.connect(f); f.connect(g); g.connect(this.master);
    this.o1.start(); this.o2.start();
    // drivetrain noise layer
    this.engNoise = ctx.createBufferSource(); this.engNoise.buffer = nb; this.engNoise.loop = true;
    const enf = ctx.createBiquadFilter(); enf.type = 'bandpass'; enf.frequency.value = 140; enf.Q.value = 1.4;
    this.engNoiseG = ctx.createGain(); this.engNoiseG.gain.value = 0;
    this.engNoise.connect(enf); enf.connect(this.engNoiseG); this.engNoiseG.connect(this.master);
    this.engNoise.start();

    // wind
    this.wind = ctx.createBufferSource(); this.wind.buffer = nb; this.wind.loop = true;
    this.windF = ctx.createBiquadFilter(); this.windF.type = 'bandpass'; this.windF.frequency.value = 500; this.windF.Q.value = 0.5;
    this.windG = ctx.createGain(); this.windG.gain.value = 0.05;
    this.wind.connect(this.windF); this.windF.connect(this.windG); this.windG.connect(this.master);
    this.wind.start();

    // leak hiss (positional)
    this.hiss = ctx.createBufferSource(); this.hiss.buffer = nb; this.hiss.loop = true;
    const hf = ctx.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = 3800; hf.Q.value = 2.5;
    this.hissG = ctx.createGain(); this.hissG.gain.value = 0.5;
    this.hissP = ctx.createPanner(); this.hissP.panningModel = 'HRTF'; this.hissP.distanceModel = 'inverse'; this.hissP.refDistance = 20;
    this.hiss.connect(hf); hf.connect(this.hissG); this.hissG.connect(this.hissP); this.hissP.connect(this.master);
    this.hiss.start();

    // launch rumble (positional at pad)
    this.rumble = ctx.createBufferSource(); this.rumble.buffer = nb; this.rumble.loop = true;
    const rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 120;
    this.rumbleG = ctx.createGain(); this.rumbleG.gain.value = 0;
    this.rumbleP = ctx.createPanner(); this.rumbleP.panningModel = 'HRTF'; this.rumbleP.distanceModel = 'inverse'; this.rumbleP.refDistance = 250;
    this.rumble.connect(rf); rf.connect(this.rumbleG); this.rumbleG.connect(this.rumbleP); this.rumbleP.connect(this.master);
    this.rumble.start();
    this.rumbleTone = ctx.createOscillator(); this.rumbleTone.type = 'sine'; this.rumbleTone.frequency.value = 38;
    this.rumbleToneG = ctx.createGain(); this.rumbleToneG.gain.value = 0;
    this.rumbleTone.connect(this.rumbleToneG); this.rumbleToneG.connect(this.rumbleP); this.rumbleTone.start();

    this.ready = true;
    if (ctx.state === 'suspended') await ctx.resume();
  }
  _setP(p, x, y, z) {
    if (p.positionX) { const t = this.ctx.currentTime; p.positionX.setTargetAtTime(x, t, 0.05); p.positionY.setTargetAtTime(y, t, 0.05); p.positionZ.setTargetAtTime(z, t, 0.05); }
    else p.setPosition(x, y, z);
  }
  update(dt, { speed01, rpm, power, stormF, nightF, camPos, camFwd, camUp, roverPos, leakActive, launchIntensity, padPos }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime, L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.setTargetAtTime(camPos.x, t, 0.02); L.positionY.setTargetAtTime(camPos.y, t, 0.02); L.positionZ.setTargetAtTime(camPos.z, t, 0.02);
      L.forwardX.setTargetAtTime(camFwd.x, t, 0.03); L.forwardY.setTargetAtTime(camFwd.y, t, 0.03); L.forwardZ.setTargetAtTime(camFwd.z, t, 0.03);
      L.upX.setTargetAtTime(0, t, 0.03); L.upY.setTargetAtTime(1, t, 0.03); L.upZ.setTargetAtTime(0, t, 0.03);
    } else if (L.setPosition) {
      L.setPosition(camPos.x, camPos.y, camPos.z);
      L.setOrientation(camFwd.x, camFwd.y, camFwd.z, 0, 1, 0);
    }
    const e = 0.2 + speed01 * 0.8;
    this.o1.frequency.setTargetAtTime(42 + rpm * 85 * e, t, 0.06);
    this.o2.frequency.setTargetAtTime(21 + rpm * 42 * e, t, 0.06);
    this.engineF.frequency.setTargetAtTime(180 + rpm * 900 + speed01 * 500, t, 0.08);
    this.engineG.gain.setTargetAtTime(0.05 + power * 0.14 + speed01 * 0.05, t, 0.1);
    this.engNoiseG.gain.setTargetAtTime(0.015 + speed01 * 0.06, t, 0.12);
    this.windG.gain.setTargetAtTime(0.02 + stormF * 0.34 + nightF * 0.04 + speed01 * 0.03, t, 0.25);
    this.windF.frequency.setTargetAtTime(420 + stormF * 500 + Math.sin(t * 0.4) * 120, t, 0.3);
    this.lowpass.frequency.setTargetAtTime(20000 - stormF * 14500, t, 0.35);   // muffled during storm
    this.hissG.gain.setTargetAtTime(leakActive ? 0.35 : 0, t, 0.4);
    if (leakActive && this.leakPos) this._setP(this.hissP, this.leakPos.x, this.leakPos.y, this.leakPos.z);
    if (padPos) this._setP(this.rumbleP, padPos.x, padPos.y + 6, padPos.z);
    const li = launchIntensity || 0;
    this.rumbleG.gain.setTargetAtTime(li * 0.95, t, 0.1);
    this.rumbleToneG.gain.setTargetAtTime(li * 0.6, t, 0.1);
  }
  radio(kind = 'beep') {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    // static burst
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 1800; nf.Q.value = 0.8;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.09, t + 0.02);
    ng.gain.setValueAtTime(0.09, t + 0.18);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    n.connect(nf); nf.connect(ng); ng.connect(this.master); n.start(t); n.stop(t + 0.5);
    const beeps = kind === 'good' ? [[880, 0.08], [1320, 0.12]] : kind === 'bad' ? [[300, 0.15], [220, 0.2]] : [[660, 0.09]];
    for (const [fr, at] of beeps) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fr;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + at); g.gain.linearRampToValueAtTime(0.12, t + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + at + 0.12);
      o.connect(g); g.connect(this.master); o.start(t + at); o.stop(t + at + 0.2);
    }
  }
  level() {
    if (!this.ready) return 0;
    this.analyser.getByteFrequencyData(this.freq);
    let s = 0; for (let i = 0; i < 24; i++) s += this.freq[i];
    return s / (24 * 255);
  }
  cue(time = 0) { // countdown tick
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime + time;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 1000;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.12);
  }
}
