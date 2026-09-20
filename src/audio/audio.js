// Spatial audio with a gentle voice: a slow harmonic pad under a soft engine hum,
// pink-noise wind, and Kenney (CC0) one-shots for every UI beat. Nothing in here
// should ever be the harshest thing the player is hearing.
const SFX = {
  good: 'threeTone1', bad: 'lowDown', go: 'powerUp1',
  tick: 'tone1', pep: 'pepSound2', zap: 'zapTwoTone', warp: 'highUp', pick: 'twoTone1',
};

export class GameAudio {
  constructor() { this.ready = false; }
  async init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4; comp.knee.value = 24;
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    this.lowpass = ctx.createBiquadFilter(); this.lowpass.type = 'lowpass'; this.lowpass.frequency.value = 20000;
    this.master.connect(this.lowpass); this.lowpass.connect(comp); comp.connect(ctx.destination);

    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 128;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.master.connect(this.analyser);

    // pink-ish noise — white noise through the ear is exactly what this project was hated for
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = nb.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + 0.029 * w; b1 = 0.985 * b1 + 0.032 * w; b2 = 0.95 * b2 + 0.048 * w;
      d[i] = (b0 + b1 + b2 + w * 0.05) * 0.22;
    }
    this.noiseBuf = nb;

    // ── ambient pad: a slow A-major-ish drone breathing through a lowpass ──
    this.padG = ctx.createGain(); this.padG.gain.value = 0.05;
    this.padF = ctx.createBiquadFilter(); this.padF.type = 'lowpass'; this.padF.frequency.value = 520; this.padF.Q.value = 0.7;
    this.padF.connect(this.padG); this.padG.connect(this.master);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.045;
    const lfoG = ctx.createGain(); lfoG.gain.value = 260;
    lfo.connect(lfoG); lfoG.connect(this.padF.frequency); lfo.start();
    // [freq, level, detune] — root, fifth, octave, warm third
    for (const [fr, lv, det] of [[110, 0.5, 0], [165, 0.3, 4], [220, 0.26, -5], [277.2, 0.14, 3]]) {
      for (const side of [-1, 1]) {
        const o = ctx.createOscillator(); o.type = 'triangle';
        o.frequency.value = fr; o.detune.value = det + side * 5;
        const g = ctx.createGain(); g.gain.value = lv * 0.5;
        o.connect(g); g.connect(this.padF); o.start();
      }
    }

    // engine: two triangles under a soft lowpass — a hum, not a chainsaw
    const g = this.engineG = ctx.createGain(); g.gain.value = 0;
    const f = this.engineF = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 260; f.Q.value = 1.2;
    this.o1 = ctx.createOscillator(); this.o1.type = 'triangle'; this.o1.frequency.value = 55;
    this.o2 = ctx.createOscillator(); this.o2.type = 'sine'; this.o2.frequency.value = 27.5;
    const og2 = ctx.createGain(); og2.gain.value = 0.5;
    this.o1.connect(f); this.o2.connect(og2); og2.connect(f); f.connect(g); g.connect(this.master);
    this.o1.start(); this.o2.start();
    // drivetrain layer, heavily tamed
    this.engNoise = ctx.createBufferSource(); this.engNoise.buffer = nb; this.engNoise.loop = true;
    const enf = ctx.createBiquadFilter(); enf.type = 'lowpass'; enf.frequency.value = 300;
    this.engNoiseG = ctx.createGain(); this.engNoiseG.gain.value = 0;
    this.engNoise.connect(enf); enf.connect(this.engNoiseG); this.engNoiseG.connect(this.master);
    this.engNoise.start();

    // wind / storm — low, hollow, distant
    this.wind = ctx.createBufferSource(); this.wind.buffer = nb; this.wind.loop = true;
    this.windF = ctx.createBiquadFilter(); this.windF.type = 'bandpass'; this.windF.frequency.value = 260; this.windF.Q.value = 0.4;
    this.windG = ctx.createGain(); this.windG.gain.value = 0.012;
    this.wind.connect(this.windF); this.windF.connect(this.windG); this.windG.connect(this.master);
    this.wind.start();

    // leak — a soft steam sigh, not a 3.8 kHz needle
    this.hiss = ctx.createBufferSource(); this.hiss.buffer = nb; this.hiss.loop = true;
    const hf = ctx.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = 900; hf.Q.value = 0.9;
    this.hissG = ctx.createGain(); this.hissG.gain.value = 0.12;
    this.hissP = ctx.createPanner(); this.hissP.panningModel = 'HRTF'; this.hissP.distanceModel = 'inverse'; this.hissP.refDistance = 20;
    this.hiss.connect(hf); hf.connect(this.hissG); this.hissG.connect(this.hissP); this.hissP.connect(this.master);
    this.hiss.start();

    // launch rumble (positional at pad)
    this.rumble = ctx.createBufferSource(); this.rumble.buffer = nb; this.rumble.loop = true;
    const rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 120;
    this.rumbleG = ctx.createGain(); this.rumbleG.gain.value = 0;
    this.rumbleP = ctx.createPanner(); this.rumbleP.panningModel = 'HRTF'; this.rumbleP.distanceModel = 'inverse'; this.rumbleP.refDistance = 60;
    this.rumble.connect(rf); rf.connect(this.rumbleG); this.rumbleG.connect(this.rumbleP); this.rumbleP.connect(this.master);
    this.rumble.start();
    this.rumbleTone = ctx.createOscillator(); this.rumbleTone.type = 'sine'; this.rumbleTone.frequency.value = 38;
    this.rumbleToneG = ctx.createGain(); this.rumbleToneG.gain.value = 0;
    this.rumbleTone.connect(this.rumbleToneG); this.rumbleToneG.connect(this.rumbleP); this.rumbleTone.start();

    // Kenney one-shots — mission beats, door chimes, countdown pings
    this.buffers = {};
    try {
      await Promise.all(Object.entries(SFX).map(async ([key, file]) => {
        const res = await fetch(`./assets/audio/${file}.ogg`);
        if (!res.ok) return;
        this.buffers[key] = await ctx.decodeAudioData(await res.arrayBuffer());
      }));
    } catch { /* fall back to synthesized beeps */ }

    this.ready = true;
    if (ctx.state === 'suspended') await ctx.resume();
  }
  _setP(p, x, y, z) {
    if (p.positionX) { const t = this.ctx.currentTime; p.positionX.setTargetAtTime(x, t, 0.05); p.positionY.setTargetAtTime(y, t, 0.05); p.positionZ.setTargetAtTime(z, t, 0.05); }
    else p.setPosition(x, y, z);
  }
  play(name, vol = 0.4, rate = 1) {
    if (!this.ready) return;
    const buf = this.buffers[name];
    if (!buf) return;
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate;
    const g = this.ctx.createGain(); g.gain.value = vol;
    s.connect(g); g.connect(this.master); s.start();
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
    this.o1.frequency.setTargetAtTime(42 + rpm * 60 * e, t, 0.08);
    this.o2.frequency.setTargetAtTime(21 + rpm * 30 * e, t, 0.08);
    this.engineF.frequency.setTargetAtTime(150 + rpm * 320 + speed01 * 220, t, 0.1);
    this.engineG.gain.setTargetAtTime(0.03 + power * 0.07 + speed01 * 0.03, t, 0.12);
    this.engNoiseG.gain.setTargetAtTime(0.008 + speed01 * 0.03, t, 0.14);
    // the pad is the room tone: fuller at night, hushed in a storm
    this.padG.gain.setTargetAtTime(0.04 + nightF * 0.035 - stormF * 0.02, t, 0.5);
    this.windG.gain.setTargetAtTime(0.012 + stormF * 0.10 + nightF * 0.012 + speed01 * 0.012, t, 0.3);
    this.windF.frequency.setTargetAtTime(240 + stormF * 160 + Math.sin(t * 0.35) * 60, t, 0.4);
    this.lowpass.frequency.setTargetAtTime(20000 - stormF * 9000, t, 0.35);   // muffled during storm
    this.hissG.gain.setTargetAtTime(leakActive ? 0.10 : 0, t, 0.4);
    if (leakActive && this.leakPos) this._setP(this.hissP, this.leakPos.x, this.leakPos.y, this.leakPos.z);
    if (padPos) this._setP(this.rumbleP, padPos.x, padPos.y + 6, padPos.z);
    const li = launchIntensity || 0;
    this.rumbleG.gain.setTargetAtTime(li * 0.85, t, 0.1);
    this.rumbleToneG.gain.setTargetAtTime(li * 0.55, t, 0.1);
  }
  radio(kind = 'beep') {
    if (!this.ready) return;
    if (kind === 'good') { this.play('good', 0.35); return; }
    if (kind === 'bad') { this.play('bad', 0.35); return; }
    if (this.buffers.pep) { this.play('pep', 0.28); return; }
    // fallback: soft sine pip
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 660;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.08, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.2);
  }
  level() {
    if (!this.ready) return 0;
    this.analyser.getByteFrequencyData(this.freq);
    let s = 0; for (let i = 0; i < 24; i++) s += this.freq[i];
    return s / (24 * 255);
  }
  cue(time = 0) { // countdown tick
    if (!this.ready) return;
    if (this.buffers.tick) {
      const buf = this.buffers.tick, s = this.ctx.createBufferSource();
      s.buffer = buf; s.playbackRate.value = 0.8;
      const g = this.ctx.createGain(); g.gain.value = 0.22;
      s.connect(g); g.connect(this.master); s.start(this.ctx.currentTime + time);
      return;
    }
    const ctx = this.ctx, t = ctx.currentTime + time;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 880;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.15);
  }
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
    try { localStorage.setItem('rsb_muted', m ? '1' : '0'); } catch { /* private mode */ }
  }
}
