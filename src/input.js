// Analog control layer. Every axis is a rate-limited scalar in [-1, 1]: keys ramp instead of
// snapping, and steering springs back to centre, which is what makes the rover feel driven
// rather than switched.
const STEER_RATE = 2.9;   // rad/s of pedal travel
const STEER_BACK = 3.6;   // spring-back rate when the key is released
const PEDAL_RATE = 3.6;
const PEDAL_BACK = 5.2;

const lerp = (a, b, k) => a + (b - a) * k;
const approach = (v, target, up, down, dt) =>
  target > v ? Math.min(target, v + up * dt) : Math.max(target, v - down * dt);
const ramp = (v, target, rate, dt) => lerp(v, target, 1 - Math.exp(-rate * dt));

function pollGamepad() {
  for (const gp of (navigator.getGamepads?.() || [])) {
    if (!gp || gp.mapping !== 'standard') continue;
    const [lx, ly, rt, lt] = gp.axes;
    const a = gp.buttons;
    if (!a) continue;
    const pressed = i => (a[i]?.pressed ? 1 : 0);
    if (Math.abs(lx) > 0.12 || Math.abs(ly) > 0.12 || rt > 0.05 || lt > 0.05 || pressed(0)) {
      return { steer: Math.abs(lx) > 0.12 ? lx : 0, gas: rt, brake: lt, drift: pressed(0) || pressed(1) };
    }
  }
  return null;
}

export function createInput(canvasEl) {
  const inp = { gas: 0, brake: 0, steer: 0, drift: 0, interact: 0, keys: new Set() };
  const touch = { steer: 0, gas: 0, brake: 0, drift: 0, interact: 0 };
  addEventListener('keydown', e => {
    inp.keys.add(e.code);
    if (['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  });
  addEventListener('keyup', e => inp.keys.delete(e.code));
  addEventListener('blur', () => inp.keys.clear());

  function keyAxes() {
    const k = inp.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    // left = +1 so a positive steer turns the rover left, matching the wheel visuals
    const turn = (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) - (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0);
    return { fwd, turn, drift: k.has('Space') ? 1 : 0 };
  }

  // The pedals are followers, so their time base has to be the step they are handed to. Measuring a
  // second wall clock here (an anchor set at construction, advanced only when `read()` runs) gave the
  // throttle a dt that nothing else in the frame uses: the autopilot audit writes `inp.gas` and then
  // steps the sim at a fixed 1/60, and the value physics actually got was `approach(0.6, 1, rate, dt)`
  // with `dt` = however long the machine really took. Two reps of one build drove different laps
  // because of it — wind, clock, day and pose all pinned and agreeing to six decimals at t=0, the
  // hull still 9e-5 m apart 0.25 s later and 931 m against 980 m by 180 s
  // (tools/logs/tour-180-sig-{r,s}.log). For a player this changes nothing but the jitter: both
  // numbers are elapsed real seconds per frame, and tick() already clamps to 0.05.
  function read(simDt) {
    const dt = Math.min(0.05, simDt);

    const kb = keyAxes();
    const gp = pollGamepad();
    const turn = gp ? gp.steer : kb.turn;
    const fwd = gp ? (gp.gas > 0.06 ? 1 : gp.brake > 0.06 ? -1 : 0) || kb.fwd : kb.fwd;
    const gasT = Math.max(fwd > 0 ? 1 : 0, gp ? gp.gas : 0, touch.gas);
    const brakeT = Math.max(fwd < 0 ? 1 : 0, gp ? gp.brake : 0, touch.brake);
    const steerT = Math.max(-1, Math.min(1, turn || (touch.steer || 0)));

    inp.gas = approach(inp.gas, gasT, PEDAL_RATE, PEDAL_BACK, dt);
    inp.brake = approach(inp.brake, brakeT, PEDAL_RATE, PEDAL_BACK, dt);
    inp.steer = approach(inp.steer, steerT, steerT * inp.steer < 0 ? STEER_RATE * 1.6 : STEER_RATE, STEER_BACK, dt);
    if (Math.abs(inp.steer) < 0.004) inp.steer = 0;
    inp.drift = ramp(inp.drift, Math.max(kb.drift, gp ? gp.drift : 0, touch.drift), 7, dt);
    inp.interact = Math.max(kb.fwd !== undefined && inp.keys.has('KeyE') ? 1 : 0, touch.interact);
    return inp;
  }

  // ---- touch stick ----
  function bindStick() {
    const pad = document.getElementById('t-left');
    if (!pad) return;
    const knob = pad.querySelector('.t-stick');
    let active = false, cx = 0;
    const setT = e => {
      const t = e.changedTouches[0];
      const dx = Math.max(-1, Math.min(1, (t.clientX - cx) / 45));
      touch.steer = -dx;
      knob.style.transform = `translate(${dx * 34}px,0)`;
    };
    pad.addEventListener('touchstart', e => { active = true; cx = e.changedTouches[0].clientX; setT(e); });
    pad.addEventListener('touchmove', e => { if (active) setT(e); });
    pad.addEventListener('touchend', () => { active = false; touch.steer = 0; knob.style.transform = ''; });
    const btn = (id, prop) => {
      const b = document.getElementById(id);
      if (!b) return;
      const off = () => touch[prop] = 0;
      b.addEventListener('touchstart', e => { e.preventDefault(); touch[prop] = 1; });
      b.addEventListener('touchend', off);
      // touchend is not guaranteed: an incoming call, a system gesture or the browser stealing the
      // touch fires touchcancel instead and the finger's release never reaches us.
      b.addEventListener('touchcancel', off);
    };
    btn('t-gas', 'gas'); btn('t-brake', 'brake'); btn('t-drift', 'drift'); btn('t-inter', 'interact');
    // The dust lance is a held key rather than an analog axis, so the touch button feeds the same
    // set the keyboard does — one source of truth, and the lance behaves identically on both.
    const lance = document.getElementById('t-lance');
    if (lance) {
      const off = () => inp.keys.delete('KeyF');
      lance.addEventListener('touchstart', e => { e.preventDefault(); inp.keys.add('KeyF'); });
      lance.addEventListener('touchend', off);
      // A stuck lance is not a stuck throttle, it is a slow drain to 0% battery, and the tow-home
      // recovery then respawns the rover with the button still held — a loop the player cannot leave.
      lance.addEventListener('touchcancel', off);
    }
  }
  return { inp, read, bindStick, isTouch: 'ontouchstart' in window };
}
