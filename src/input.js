export function createInput(canvasEl) {
  const inp = { gas: 0, brake: 0, steer: 0, drift: 0, interact: 0, keys: new Set() };
  const touch = { steer: 0, gas: 0, brake: 0, drift: 0, interact: 0 };
  addEventListener('keydown', e => {
    inp.keys.add(e.code);
    if (['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
  });
  addEventListener('keyup', e => inp.keys.delete(e.code));
  addEventListener('blur', () => inp.keys.clear());

  function readKeyboard() {
    let k = { gas: 0, brake: 0, steer: 0, drift: 0 };
    if (inp.keys.has('KeyW') || inp.keys.has('ArrowUp')) k.gas = 1;
    if (inp.keys.has('KeyS') || inp.keys.has('ArrowDown')) k.brake = 1;
    if (inp.keys.has('KeyA') || inp.keys.has('ArrowLeft')) k.steer = 1;
    if (inp.keys.has('KeyD') || inp.keys.has('ArrowRight')) k.steer = -1;
    if (inp.keys.has('Space')) k.drift = 1;
    return k;
  }
  function read(inp2) {
    const k = readKeyboard();
    inp.gas = Math.max(k.gas, touch.gas);
    inp.brake = Math.max(k.brake, touch.brake);
    inp.steer = k.steer !== 0 ? k.steer : touch.steer;
    inp.drift = Math.max(k.drift, touch.drift);
    inp.interact = Math.max(inp.keys.has('KeyE') ? 1 : 0, touch.interact);
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
