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

  let last = performance.now();
  function read() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

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
      b.addEventListener('touchstart', e => { e.preventDefault(); touch[prop] = 1; });
      b.addEventListener('touchend', () => touch[prop] = 0);
    };
    btn('t-gas', 'gas'); btn('t-brake', 'brake'); btn('t-drift', 'drift'); btn('t-inter', 'interact');
  }
  return { inp, read, bindStick, isTouch: 'ontouchstart' in window };
}
