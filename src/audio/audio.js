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
    const rf = this.rumbleF = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 120; rf.Q.value = 0.4;
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
  update(dt, { speed01, rpm, power, stormF, windLoad, windGust, nightF, camPos, camFwd, camUp, roverPos, leakActive, launchIntensity, launchThrust, launchAlt, launchProx, padPos, blast }) {
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
    // Wind pressure, not weather mood. `windLoad` is the front's standing pressure at the rover
    // (wind speed × the dust actually reaching it), so the roar climbs through `watch` — nine
    // m/s of air with clean sky and zero dust — and that is the warning you hear before the wall
    // is on top of you. `stormF` on its own could only say "dust is here", one second too late.
    const wLoad = windLoad || 0, wGust = windGust || 0;
    const breathe = 0.72 + 0.28 * Math.sin(t * 1.31) + 0.16 * Math.sin(t * 0.53 + 1.7);
    this.windG.gain.setTargetAtTime(0.012 + wLoad * (0.055 + 0.105 * wGust) * breathe + nightF * 0.012 + speed01 * 0.012, t, 0.25);
    // Pressure sets the register (a deeper roar as the front arrives); the gust swings the band
    // up and down around it, which is the swoop a gust makes as it passes the mast.
    this.windF.frequency.setTargetAtTime(200 + wLoad * 190 + wGust * Math.sin(t * 0.83) * 150, t, 0.4);
    this.windF.Q.setTargetAtTime(0.4 + wLoad * 0.5, t, 0.5);
    this.lowpass.frequency.setTargetAtTime(20000 - stormF * 9000, t, 0.35);   // muffled during storm
    // The dust-off lance shares the leak's noise voice: both are gas under pressure through a
    // nozzle, and a second generator for a three-second action is not a cost this scene should
    // carry. The panner follows whichever of the two is actually sounding, so the hiss you hear
    // from the cab is the one coming off the vehicle and not from the tank farm.
    const b = blast || 0;
    this.hissG.gain.setTargetAtTime((leakActive ? 0.10 : 0) + b * 0.075, t, b ? 0.06 : 0.4);
    if (b && roverPos) this._setP(this.hissP, roverPos.x, roverPos.y + 0.5, roverPos.z);
    else if (leakActive && this.leakPos) this._setP(this.hissP, this.leakPos.x, this.leakPos.y, this.leakPos.z);
    if (padPos) this._setP(this.rumbleP, padPos.x, padPos.y + 6, padPos.z);
    // The rumble is not one drone turned up and down. Two separate things move it: how many bells
    // are actually burning, and how much air is left between the vehicle and the deck. Sixteen at
    // the pad and three on the upper stage are not the same sound, and by two kilometres up the
    // top of the band has been absorbed on the way down, so what reaches you is a lower, thinner
    // version of the same roar. Gain alone could only ever give the pad sound at another volume —
    // which is what the launch used to be, right up to the moment it went silent.
    const li = launchIntensity || 0;
    const thr = launchThrust === undefined ? 1 : launchThrust;
    // Mars' scale height is ~11 km, so a literal density ratio would still read 0.8 at SECO and buy
    // nothing the ear can follow. This is the same curve with the exponent the scene needs.
    const air = 1 / (1 + (launchAlt || 0) / 700);
    this._launchProx = launchProx === undefined ? 1 : launchProx;
    this._launchAlt = launchAlt || 0;
    this.rumbleG.gain.setTargetAtTime(li * 0.85 * (0.26 + 0.74 * air), t, 0.1);
    // The sub fades on a shallower curve than the noise band, because that is the actual order of
    // attenuation: a 40 Hz pressure wave crosses several kilometres of thinning air more or less
    // intact, and the crackle on top of it does not. Both reach 1 at the deck, so nothing about the
    // pad-side level changed — only the five-kilometres-up version got quieter, which it always should.
    this.rumbleToneG.gain.setTargetAtTime(li * 0.55 * (0.6 + 0.4 * air), t, 0.1);
    this.rumbleF.frequency.setTargetAtTime(58 + thr * 196 * (0.34 + 0.66 * air), t, 0.25);
    this.rumbleTone.frequency.setTargetAtTime(30 + thr * 17 * (0.5 + 0.5 * air), t, 0.4);
  }
  // One-shot shaped noise: pink buffer through a filter that travels, under a gain that attacks and
  // falls away. Every launch beat below is built from this and `_sub`, because a Kenney UI pip has
  // nothing to say about 16 engines lighting.
  _burst({ at = 0, dur = 0.5, f0 = 200, f1 = f0, q = 0.7, type = 'lowpass', vol = 0.3, attack = 0.012, rate = 1 }) {
    if (!this.ready) return;
    const ctx = this.ctx, t0 = ctx.currentTime + at;
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
    s.playbackRate.value = rate * (0.86 + Math.random() * 0.28);
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(Math.max(20, f0), t0);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t0); s.stop(t0 + dur + 0.05);
  }
  _sub({ at = 0, dur = 1.2, f0 = 26, f1 = f0, vol = 0.3, attack = 0.05 }) {
    if (!this.ready) return;
    const ctx = this.ctx, t0 = ctx.currentTime + at;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(8, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  // The event sounds of a flight. Distance from the pad dims them, and so does the vehicle's own
  // altitude — the same air-thinning term the rumble uses, because a bang two kilometres up is not
  // the bang that happens at your feet. Neither ever gates the sound off: on Mars the ground carries
  // that far, and a silent staging would read as a missing feature, not as physics.
  // `alt` overrides the blended height for a beat that belongs to one specific vehicle; see the call
  // site, where SECO passes the ship's altitude because the blend is weighted by thrust.
  launchEvent(kind = 'ignition', alt) {
    if (!this.ready) return;
    this._lastEvent = kind;
    const prox = this._launchProx === undefined ? 1 : this._launchProx;
    const h = (alt === undefined ? this._launchAlt : alt) || 0;
    const air = 1 / (1 + h / 700);
    this._lastEventAlt = h;
    const vp = 0.28 + 0.72 * prox;
    const v = vp * (0.42 + 0.58 * air);
    if (kind === 'ignition') {
      // Chamber pressure coming up: the band opens from nothing over the hold-down, and the sub
      // climbs as the turbopumps get their breath. Deliberately no transient snap — the stack is
      // still clamped, so this is a swell, not a bang.
      this._burst({ dur: 2.4, f0: 70, f1: 430, q: 0.6, vol: 0.30 * v, attack: 0.5 });
      this._sub({ dur: 2.2, f0: 21, f1: 44, vol: 0.30 * v, attack: 0.55 });
    } else if (kind === 'liftoff') {
      // The boom is the stack clearing the tower and the trench letting go: energy falling away in
      // frequency while the level still rises, which is how a shock front reads at a distance.
      this._burst({ dur: 2.0, f0: 520, f1: 110, q: 0.5, vol: 0.34 * v, attack: 0.06 });
      this._sub({ dur: 2.6, f0: 46, f1: 24, vol: 0.34 * v, attack: 0.08 });
    } else if (kind === 'staging') {
      // Hot staging, so the upper stage is *already* burning — it lit 2.4 mission seconds ago and
      // `shipignition` said so. What the seam gives you is the pyro and the two vehicles pushing
      // apart, then the bottle of gas between them venting into the wake.
      this._burst({ dur: 0.13, f0: 2400, f1: 900, q: 2.6, type: 'bandpass', vol: 0.20 * v, attack: 0.003 });
      this._sub({ at: 0.05, dur: 0.7, f0: 88, f1: 30, vol: 0.26 * v, attack: 0.01 });
      this._burst({ at: 0.3, dur: 1.1, f0: 900, f1: 180, q: 0.9, vol: 0.11 * v, attack: 0.08 });
    } else if (kind === 'meco') {
      // Sixteen bells letting go at once. Same shape as SECO but twice the chamber still in the
      // drop, and it lands a beat and a half before the seam blows — the two must not be the same sound.
      this._sub({ dur: 1.1, f0: 52, f1: 17, vol: 0.30 * v, attack: 0.02 });
      this._burst({ dur: 0.9, f0: 420, f1: 70, q: 0.5, vol: 0.20 * v, attack: 0.02 });
    } else if (kind === 'relight') {
      // Three bells, not sixteen — and by the time the booster does this it is falling, so the
      // start-up has to be audibly smaller than the ignition it echoes.
      this._burst({ dur: 1.4, f0: 110, f1: 460, q: 0.7, vol: 0.20 * v, attack: 0.22 });
    } else if (kind === 'seco') {
      // The engine stops pushing, so the air stops being worked. A glide down in register under a
      // short decay — and then nothing, which is the point: above the weather there is no second
      // sound to arrive.
      this._sub({ dur: 1.5, f0: 42, f1: 15, vol: 0.24 * v, attack: 0.02 });
      this._burst({ dur: 1.2, f0: 300, f1: 60, q: 0.5, vol: 0.16 * v, attack: 0.02 });
    } else if (kind === 'landing') {
      // Deliberately scaled by proximity alone. The blended height reads the ship's at this moment —
      // the booster has flamed out, so nothing is left to weight it down, and the flight logged
      // `alt` 8671 m for a touchdown twenty metres from the listener. Thinning by that would mute the
      // one beat that happens at your feet.
      this._burst({ dur: 0.45, f0: 2600, f1: 420, q: 1.4, type: 'bandpass', vol: 0.12 * vp, attack: 0.008 });
      this._sub({ dur: 1.0, f0: 34, f1: 13, vol: 0.20 * vp, attack: 0.035 });
      this._burst({ at: 0.1, dur: 1.7, f0: 300, f1: 85, q: 0.5, vol: 0.09 * vp, attack: 0.1 });
    }
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
