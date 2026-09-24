(async () => {
  const R = window.__RSB, Q = window.__QA;
  let waited = 0;
  while (!R.state.started && waited < 60000) { await new Promise(r => setTimeout(r, 300)); waited += 300; }
  if (!R.state.started) return JSON.stringify({ fail: 'never started', waited });
  R.place(6, 6, 0);
  Q.pause();
  for (let i = 0; i < 12; i++) Q.step(15, 1000 / 60);
  const rest = await R.shot('j5_at_rest', null, null, null);
  const keys = R.input().keys;
  keys.add('KeyW');
  let v = 0, guard = 0;
  while (v < 13 && guard++ < 40) { Q.step(15, 1000 / 60); v = R.state.speed || 0; }
  const fast = await R.shot('j5_at_speed', null, null, null);
  keys.delete('KeyW');
  Q.resume();
  return JSON.stringify({ v: +v.toFixed(1), kmh: Math.round(v * 3.6), rest, fast });
})()
