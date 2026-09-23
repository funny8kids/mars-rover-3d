// ───────────────────────── the flight instrument panel ─────────────────────────
// The finale used to end by saying so: a toast reading 「助推级回到发射台 · T+40s」, while every number
// the integrator had actually produced — how high, how fast, how hard, where the booster came down —
// was thrown away, because nothing in the scene graph read it. A launch you cannot read the instruments
// of is a video, not a mission.
//
// So this is the reader. Every figure comes out of `launch.flight.tel` and out of the flight path
// fx/launch.js samples from its own integrator, which means the altitude on the plot is the altitude
// the mesh has, to the same metre, and the panel can never tell a story the sim did not fly. The one
// line here that is not a measurement is the booster's state word, and it is derived from the
// vertical speed and time-to-deck printed beside it rather than from a timer.
//
// Why it builds its own DOM instead of being authored in index.html: all forty-some nodes are slots
// for numbers — there is no static layout to design around — and the QA boot page keeps its own copy
// of the HUD markup. Mounted from here, the page that gets screenshotted and the page that gets
// driven cannot drift apart.

import { t, getLang, onChange } from '../i18n.js';

const MONO = '"JetBrains Mono",ui-monospace,monospace';
const AMBER = '#ffbe5c', CYAN = '#5fd4e8', DIM = '#8d7a63', LINE = 'rgba(255,150,60,.13)';
const PLOT_W = 204, PLOT_H = 94;
const DASH = '—';

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt !== undefined) n.textContent = txt;
  return n;
};

const len = v => (v >= 950 ? [(v / 1000).toFixed(2), 'km'] : [v.toFixed(0), 'm']);
const signed = v => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}`;

// Each row is [label, reader], and a reader returns [number, unit] or null. Null draws as an em dash:
// the booster's own figures do not exist before it is on its own, and a row of zeros there would be a
// lie rather than a blank.
const SHIP_ROWS = [
  ['高度', x => len(x.alt)],
  ['速度', x => [x.vel.toFixed(0), 'm/s']],
  ['马赫', x => [x.mach.toFixed(2), 'M']],
  ['加速度', x => [x.accel.toFixed(1), 'm/s²']],
];
const BOOST_ROWS = [
  ['高度', x => (x.separated ? len(x.bAlt) : null)],
  ['垂速', x => (x.separated ? [signed(x.bVs), 'm/s'] : null)],
  ['距台', x => (x.separated ? [x.bDown.toFixed(1), 'm'] : null)],
  // The word is read off the vertical speed, the time-to-deck and whether the field is burning, all
  // printed beside it, so it cannot claim a phase the numbers on the same line contradict. It is the one
  // row whose value is not a number, and so the one row allowed to take the unit column as well — an
  // English annunciator is six letters, and a column built for four digits has no room for it.
  ['状态', x => (x.landed ? ['回收', ''] : !x.separated ? null
    : !x.bBurn ? ['滑行', ''] : x.bVs > 0 ? ['爬升', ''] : x.bTGo < 12 ? ['制动', ''] : ['返场', '']), true],
];

// Mission elapsed time, in the T±mm:ss.s the watch decks use. It is one string for both languages,
// which is why it is not registered with the label table.
const fmtMet = s => `T${s < 0 ? '−' : '+'}${String(Math.floor(Math.abs(s) / 60)).padStart(2, '0')}:`
  + `${(Math.abs(s) % 60).toFixed(1).padStart(4, '0')}`;

export function mountTelemetry() {
  const hud = document.getElementById('hud');
  if (!hud) return null;

  // Chinese is the authored language everywhere else in the base, so labels are registered as they are
  // built and repainted from the catalogue on a language switch.
  const labels = [];
  const lab = (node, zh) => { labels.push([node, zh]); node.textContent = t(zh); return node; };

  const wrap = el('div'); wrap.id = 'tel-wrap';
  const log = el('div'); log.id = 'tel-log';
  const bar = el('div'); bar.className = 'tel-bar';

  // ── lead: the clock, the phase, and the two numbers that only make sense together ──
  const lead = el('div', 'tel-cell tel-lead');
  const met = el('div'); met.id = 'tel-met'; met.textContent = fmtMet(0);
  const phase = el('div'); phase.id = 'tel-phase';
  const rampBar = el('div', 'tel-ramp');
  const rampFill = el('i');
  rampBar.appendChild(rampFill);
  const sub = el('div', 'tel-sub');
  const downVal = el('b'); const gammaVal = el('b');
  sub.append(lab(el('span', 'p-lab'), '弹道'), downVal, el('span', 'p-sep', '·'),
    lab(el('span', 'p-lab'), '倾角'), gammaVal);
  lead.append(lab(el('div', 'tel-cap'), '任务时间'), met, phase, rampBar, sub);

  // ── the profile: altitude against downrange, both autoscaled ──
  const plotCell = el('div', 'tel-cell tel-plot');
  const cv = document.createElement('canvas');
  cv.id = 'tel-trace';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(PLOT_W * dpr); cv.height = Math.round(PLOT_H * dpr);
  cv.style.width = `${PLOT_W}px`; cv.style.height = `${PLOT_H}px`;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  plotCell.append(lab(el('div', 'tel-cap'), '高度 — 时间剖面'), cv);

  // One vehicle's column: its name, its bells, and the four figures that describe it.
  const gauge = (titleZh, rows, bellCount) => {
    const cell = el('div', 'tel-cell tel-gauge');
    const tally = el('span', 'eng-tally', `0/${bellCount}`);
    const head = el('div', 'tel-cap');
    head.append(lab(el('span'), titleZh), tally);
    const row = el('div', 'eng-row');
    const dots = [];
    for (let i = 0; i < bellCount; i++) { const d = el('i', 'eng-dot'); row.appendChild(d); dots.push(d); }
    // Exactly two ranks of bells. A wrapping flex row would otherwise break sixteen into three ragged
    // lines of six, and the shape of the ring the booster actually has is a tally the eye should be able
    // to take in without reading the number beside it.
    if (bellCount > 4) row.style.maxWidth = `${Math.ceil(bellCount / 2) * 11 - 3}px`;
    const grid = el('div', 'tel-rows');
    const spec = rows.map(([zh, read, wide]) => {
      const num = el('b'); const unit = el('i');
      if (wide) num.className = 'r-wide';
      grid.append(lab(el('span', 'r-lab'), zh), num, unit);
      return { read, num, unit, wide };
    });
    cell.append(head, row, grid);
    return { cell, dots, tally, spec };
  };
  const ship = gauge('上面级', SHIP_ROWS, 3);
  const boost = gauge('助推级', BOOST_ROWS, 16);

  bar.append(lead, plotCell, ship.cell, boost.cell);
  wrap.append(log, bar);
  hud.appendChild(wrap);

  let shown = false, txtAcc = 0, plotAcc = 0, logLen = -1;
  // The things drawn off the flight rather than off the rig: the object the last frame was read from,
  // and the authored Chinese behind the two word slots — the mission phase and the booster's state. All
  // of them exist so that a language switch can be answered without a frame, and all are cleared when
  // the panel is re-armed — a panel for the next launch must not be able to repaint the last one's
  // history. A dash is not a word, so a state slot that is currently blank is remembered as blank.
  let last = null, phaseWord = '', stateWord = '';

  const paintRows = (g, x) => {
    for (const r of g.spec) {
      const v = r.read(x);
      if (v === null) { r.num.textContent = DASH; r.unit.textContent = ''; if (r.wide) stateWord = ''; continue; }
      // Numbers pass through the translator unchanged and come back as themselves; the state row's
      // annunciators are words, and this is the one slot they can be translated from.
      r.num.textContent = t(v[0]);
      r.unit.textContent = v[1];
      if (r.wide) stateWord = v[0];
    }
  };

  // A bell count from the ramp, not from the beat list: `ramp` is the factor the thrust is multiplied
  // by, so how many of the sixteen are contributing right now is the sim's own answer, and engine
  // start reads across the hold-down instead of arriving all at once.
  const paintBells = (dots, tally, lit, total, ramp) => {
    const n = lit > 0 ? Math.max(1, Math.round(total * Math.min(1, ramp))) : 0;
    for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i < n);
    tally.textContent = `${n}/${total}`;
  };

  const drawTrace = (tr) => {
    const w = PLOT_W, h = PLOT_H;
    const px = 3, pt = 11, pb = 11;
    ctx.clearRect(0, 0, w, h);
    // Both axes scale to what the flight has actually used, with headroom. The horizontal one is mission
    // time and not ground distance: measured against downrange the climb is nearly vertical, so the whole
    // ascent drew as one straight diagonal and the booster's return as a squiggle in the corner — a plot
    // of a thing already printed as a number beside it. Against the clock, every beat leaves a change of
    // slope, and the split into two vehicles is the shape of the picture. Both maxima are printed in the
    // corners, so the autoscale is stated rather than hidden.
    const spanT = Math.max(12, tr.maxT * 1.06), spanA = Math.max(120, tr.maxAlt * 1.14);
    const X = s => px + (s / spanT) * (w - px * 2);
    const Y = a => h - pb - (a / spanA) * (h - pt - pb);
    ctx.lineWidth = 1;
    ctx.strokeStyle = LINE;
    ctx.beginPath();
    for (let i = 1; i <= 2; i++) {
      ctx.moveTo(px + (i * (w - px * 2)) / 3, pt); ctx.lineTo(px + (i * (w - px * 2)) / 3, h - pb);
      ctx.moveTo(px, pt + (i * (h - pt - pb)) / 3); ctx.lineTo(w - px, pt + (i * (h - pt - pb)) / 3);
    }
    ctx.stroke();
    // The deck, so the booster's arrival is a fact about the drawing and not only about the numbers.
    ctx.strokeStyle = 'rgba(255,150,60,.34)';
    ctx.beginPath(); ctx.moveTo(px, h - pb + .5); ctx.lineTo(w - px, h - pb + .5); ctx.stroke();
    const line = (flat, color) => {
      if (flat.length < 4) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(X(flat[0]), Y(flat[1]));
      for (let i = 2; i < flat.length; i += 2) ctx.lineTo(X(flat[i]), Y(flat[i + 1]));
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(X(flat[flat.length - 2]), Y(flat[flat.length - 1]), 2.1, 0, 6.2832); ctx.fill();
    };
    line(tr.booster, CYAN);
    line(tr.ship, AMBER);
    if (tr.sep) {
      ctx.strokeStyle = '#ffe6c0'; ctx.lineWidth = 1;
      const sx = X(tr.sep[0]), sy = Y(tr.sep[1]);
      ctx.beginPath(); ctx.moveTo(sx - 3, sy - 3); ctx.lineTo(sx + 3, sy + 3);
      ctx.moveTo(sx + 3, sy - 3); ctx.lineTo(sx - 3, sy + 3); ctx.stroke();
    }
    ctx.font = `8px ${MONO}`;
    ctx.fillStyle = DIM; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const alt = spanA / 1.14;
    ctx.fillText(alt >= 950 ? `${(alt / 1000).toFixed(2)} km` : `${alt.toFixed(0)} m`, px, 8);
    ctx.textAlign = 'right';
    ctx.fillText(`${tr.maxT.toFixed(0)} s`, w - px, h - 2);
  };

  // The state a panel arrives in before the sim has anything to say: dashes, dark bells, and an empty
  // profile that already carries its axes. A row of zeros would be a measurement the vehicle never made.
  const blank = () => {
    for (const g of [ship, boost]) {
      for (const r of g.spec) { r.num.textContent = DASH; r.unit.textContent = ''; }
      for (const d of g.dots) d.classList.remove('on');
      g.tally.textContent = `0/${g.dots.length}`;
    }
    drawTrace({ ship: [], booster: [], maxAlt: 0, maxT: 0, sep: null });
  };

  // The log is the record the sequence leaves behind, and it is drawn off `F.log` rather than off the
  // toast queue — the queue paces one line at a time for reading, and this is the part that keeps the
  // history. Rebuilt whole, because a language switch changes the words on the lines and not the lines.
  const paintLog = (F) => {
    logLen = F.log.length;
    log.textContent = '';
    for (const e of F.log.slice(-3)) {
      const row = el('div', 'tel-ev');
      row.append(el('b', null, `T+${e.label}s`), el('span', null, getLang() === 'en' ? e.en : e.zh));
      log.appendChild(row);
    }
  };

  const api = {
    get on() { return shown; },
    // Coming back up is not a no-op: the pips, the log rail and the trace all belong to whichever
    // flight last used them, and the second launch has to start from an empty panel.
    show() {
      if (shown) return;
      shown = true;
      txtAcc = plotAcc = 1;
      logLen = -1;
      last = null; phaseWord = ''; stateWord = '';
      log.textContent = '';
      blank();
      wrap.classList.add('show');
    },
    hide() { if (shown) { shown = false; wrap.classList.remove('show'); } },
    countdown(cd, dt = 1 / 60) {
      api.show();
      txtAcc += dt;
      if (txtAcc < 0.1) return;
      txtAcc = 0;
      met.textContent = fmtMet(-cd);
      phaseWord = '倒计时';
      phase.textContent = t(phaseWord);
      rampFill.style.width = '0%';
      downVal.textContent = '0 m'; gammaVal.textContent = '0.0°';
    },
    update(F, dt) {
      api.show();
      last = F;
      txtAcc += dt; plotAcc += dt;
      const x = F.tel;
      if (F.log.length !== logLen) paintLog(F);
      if (txtAcc < 0.1) return;
      txtAcc = 0;
      met.textContent = fmtMet(x.met);
      phaseWord = x.phase;
      phase.textContent = t(phaseWord);
      rampFill.style.width = `${Math.round(Math.min(1, x.ramp) * 100)}%`;
      paintRows(ship, x);
      paintRows(boost, x);
      paintBells(ship.dots, ship.tally, x.litUpper, x.engines.upper, x.ramp);
      paintBells(boost.dots, boost.tally, x.litBooster, x.engines.booster, x.ramp);
      downVal.textContent = `${x.down.toFixed(0)} m`;
      gammaVal.textContent = `${(x.gamma * 57.2958).toFixed(1)}°`;
      if (plotAcc >= 0.08) { plotAcc = 0; drawTrace(F.track); }
    },
    relabel() {
      for (const [n, zh] of labels) n.textContent = t(zh);
      // The slots drawn off the flight cannot wait for the next frame to be redrawn — that frame stops
      // arriving the moment the vehicle is away, and the deck is deliberately left on screen for five
      // seconds after it. `phaseWord` is empty at mount, before a countdown has ever painted.
      if (phaseWord) phase.textContent = t(phaseWord);
      const wide = boost.spec.find(s => s.wide);
      if (wide) wide.num.textContent = stateWord ? t(stateWord) : DASH;
      if (last) paintLog(last);
    },
  };
  onChange(() => api.relabel());
  api.relabel();
  return api;
}
