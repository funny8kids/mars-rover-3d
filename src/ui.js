import { t as tx } from './i18n.js';

const $ = id => document.getElementById(id);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export const UI = {
  missions: [],
  // §7: the log is one line while you drive. The chain of five missions is not something anyone
  // reads at 40 km/h — the next objective is — so the rest of it appears on hover, on keyboard
  // focus, on click, and for a few seconds after the chain actually changes. The panel keeps its
  // own affordance (the counter below the line) rather than hiding content with no way back.
  mpOpen: false, mpTimer: 0, mpWired: false, mpSig: '', mpHead: null,
  renderMissions(missions) {
    this.missions = missions;
    this.paintMissionList();
    this.wireMissionPanel();
    // The look is earned by the chain *changing shape*, not by the list being repainted. main.js
    // repaints on every grid counter tick, on a language switch and at the hand-over from the boot
    // screen; those are the same five lines with one number updated, and popping the whole log open
    // over them hides the objective the player was reading. Counters are deliberately out of the
    // signature — a new active or done mission is what deserves the extra two seconds of screen.
    const sig = missions.map(m => `${m.text}${m.done ? 1 : 0}${m.active ? 1 : 0}`).join('|');
    const changed = !!this.mpSig && this.mpSig !== sig;
    this.mpSig = sig;
    if (changed && !this.mpOpen) this.setMissionsOpen(true, 6000);
    this.paintMissionToggle();
  },
  paintMissionList() {
    const head = $('mission-list'), rest = $('mission-rest');
    head.innerHTML = ''; rest.innerHTML = '';
    // The one visible row is the objective you are on; the counter comes next and the rest of the
    // chain last. The order is a reachability fact, not taste: with the counter *below* the rows it
    // reveals, opening the panel slid the button ~100 px down out of the pointer that had just hovered
    // it, so a real click pressed on a mission row instead, `focusout` collapsed the panel back, and
    // the browser dispatched `click` on the common ancestor (`#mission-panel`) — where nothing listens.
    const list = this.missions;
    this.mpHead = list.find(m => m.active) || list.find(m => !m.done) || list[list.length - 1] || null;
    const at = list.indexOf(this.mpHead);
    list.forEach((m, i) => {
      const li = document.createElement('li');
      // the counter is a hole in the sentence, so the whole line can be translated as one unit
      li.textContent = tx(m.text).replace('{n}', m.n).replace('{total}', m.total);
      li.className = m.done ? 'done' : m.active ? 'active' : '';
      (i === at ? head : rest).appendChild(li);
    });
  },
  wireMissionPanel() {
    if (this.mpWired) return;
    const p = $('mission-panel'), b = $('mp-more');
    if (!p || !b) return;
    this.mpWired = true;
    b.addEventListener('click', () => this.setMissionsOpen(!this.mpOpen));
    p.addEventListener('pointerenter', () => this.setMissionsOpen(true));
    p.addEventListener('pointerleave', () => { if (!b.matches(':focus-visible')) this.setMissionsOpen(false); });
    p.addEventListener('focusin', () => this.setMissionsOpen(true));
    p.addEventListener('focusout', () => this.setMissionsOpen(false));
  },
  setMissionsOpen(on, holdMs = 0) {
    const p = $('mission-panel');
    if (!p) return;
    this.mpOpen = on;
    p.classList.toggle('open', on);
    clearTimeout(this.mpTimer);
    if (on && holdMs) this.mpTimer = setTimeout(() => this.setMissionsOpen(false), holdMs);
    this.paintMissionToggle();
  },
  paintMissionToggle() {
    const b = $('mp-more');
    if (!b) return;
    // the number has to be the rows the reveal actually holds, so it is counted off the same head pick
    // `paintMissionList` used — not off `!active`, which would lie when no row is active
    const rest = this.missions.length - (this.mpHead ? 1 : 0);
    b.textContent = this.mpOpen ? tx('收起任务') : tx('还有 {n} 条').replace('{n}', rest);
    b.setAttribute('aria-expanded', String(this.mpOpen));
    b.hidden = !rest;
  },
  showInfo(zone) {
    const card = $('info-card');
    if (!zone) { card.classList.remove('show'); return; }
    this.zone = zone;
    if (card.dataset.key !== zone.key) {
      card.dataset.key = zone.key;
      $('info-tag').textContent = tx(zone.tag);
      $('info-name').textContent = tx(zone.name);
      $('info-params').innerHTML = zone.params.map(tx).join('<br>');
      $('info-fact').textContent = tx(zone.fact);
    }
    $('info-action').textContent = tx(zone.hudAction || zone.objective || '');
    card.classList.add('show');
  },
  // The card caches by zone key so it does not rewrite every frame — which also means a language
  // switch has to drop the cache and repaint the card that is on screen.
  relabel() {
    $('info-card').dataset.key = '';
    if (this.zone) this.showInfo(this.zone);
    for (const z of this.pipZones || []) this.pips[z.key].title = tx(z.name);
    // the log lines and the toggle are authored in Chinese too — repaint them, but do not treat a
    // language switch as a mission change (that would pop the list open)
    if (this.missions.length) { this.paintMissionList(); this.paintMissionToggle(); }
  },
  setSpeed(kmh) { $('speed-val').textContent = Math.round(kmh); },
  gridInit(zones) {
    const row = $('grid-row');
    row.innerHTML = '';
    this.pips = {};
    this.pipZones = zones;
    for (const z of zones) {
      const d = document.createElement('div');
      d.className = 'grid-pip';
      d.title = tx(z.name);
      row.appendChild(d);
      this.pips[z.key] = d;
    }
  },
  setBattery(pct, state) {
    $('battery-fill').style.width = `${Math.round(pct * 100)}%`;
    $('battery-pct').textContent = `${Math.round(pct * 100)}%`;
    const row = $('battery-row');
    row.classList.toggle('low', pct <= 0.30 && pct > 0.12);
    row.classList.toggle('crit', pct <= 0.12);
    void state;
  },
  setGridStatus(powers) {
    for (const k in this.pips) {
      const p = powers[k];
      this.pips[k].classList.toggle('on', p >= 0.99);
      this.pips[k].classList.toggle('link', p > 0.02 && p < 0.99);
    }
  },
  // The other half of the power HUD's story: 电力 is what the rover has, 积尘 is what the last
  // storm took from it. The row hides itself while both surfaces are still clean so the corner
  // stays quiet until weather has actually written a bill.
  // { value, self, worst, lancing, warn, tag } — `value` is the array the bar is measuring, which
  // narrows to the one under the lance; `worst` is the whole fleet's, and decides whether the row
  // exists at all, so finishing one array never closes the ledger on the rest.
  setFilm({ value, self, worst, lancing, warn, tag }) {
    const row = $('film-row');
    if (worst < 0.03 && self < 0.03) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    $('film-array-tag').textContent = tag;
    $('film-array-fill').style.width = `${Math.round(value * 100)}%`;
    $('film-rover-fill').style.width = `${Math.round(self * 100)}%`;
    row.classList.toggle('warn', !!warn);
    row.classList.toggle('lancing', !!lancing);
  },
  setTop(time, weather, quality, fps) {
    $('tb-time').textContent = `LMT ${time}`;
    $('tb-weather').textContent = tx(weather);
    $('tb-quality').textContent = `${tx('画质')} ${tx(quality)} · ${fps} FPS`;
  },
  toast(msg, ms = 3200) {
    const el = $('toast');
    el.textContent = tx(msg); el.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove('show'), ms);
  },
  countdown(v) {
    const c = $('countdown');
    if (v === null) { c.classList.remove('show'); return; }
    c.textContent = v; c.classList.add('show');
  },
  // The arrow is the rover's optical fix made visible, so `nav.lock` is drawn rather than explained:
  // a low lock slides the bearing sideways and thins the arrow, and a blind one is gone entirely —
  // a wrong arrow that looks certain is worse than no arrow. `t` is the sim clock, so the wobble drifts
  // instead of jittering, and it never costs a random number per frame.
  arrowAngle(vehicle, target, nav, t = 0) {
    const el = $('objective-arrow');
    if (!target || (nav && nav.blind)) { el.style.opacity = 0; return; }
    const dx = target.x - vehicle.x, dz = target.z - vehicle.z;
    const fx = Math.sin(vehicle.yaw), fz = Math.cos(vehicle.yaw);
    const cross = fx * dz - fz * dx;
    const dot = fx * dx + fz * dz;
    let a = Math.atan2(cross, dot);
    const lock = nav ? nav.lock : 1;
    if (lock < 0.98) {
      const e = 1 - lock;
      a += (Math.sin(t * 2.2) * 0.55 + Math.sin(t * 5.7 + 1.7) * 0.3 + Math.sin(t * 13.1 + 0.4) * 0.12) * e;
    }
    const dist = Math.hypot(dx, dz);
    el.style.transform = `rotate(${a * 180 / Math.PI}deg)`;
    el.style.opacity = dist < 26 ? 0 : 0.9 * (0.42 + 0.58 * lock);
    el.classList.toggle('back', dot < 0);
    el.classList.toggle('unstable', lock < 0.9);
  },
  setNav(nav) {
    const el = $('nav-chip');
    if (!el) return;
    const degraded = !!nav && nav.lock < 0.98;
    el.classList.toggle('show', degraded);
    el.classList.toggle('blind', degraded && !!nav.blind);
    if (!degraded) return;
    // The tag names the state, and 94 % is not 失锁 — calling a slide a blackout teaches the player
    // to ignore the chip until it is shouting. setNav owns this text while the chip is up; a hidden
    // chip's tag is unreadable by definition, so nothing waits on it.
    $('nav-chip-tag').textContent = tx(nav.blind ? '信标失锁' : '信标不稳');
    $('nav-chip-val').textContent = `${Math.round(nav.lock * 100)}%`;
    // Two tails, one question each: "what do I have?" while still in the dust, "how long?" once the
    // air is clear enough to be solving again.
    $('nav-chip-tail').textContent = nav.homing > 0
      ? `${tx('重新锁定')} ${mmss(nav.homing)}`
      : `${tx('地标')} ${nav.landmarks}`;
  },
  setHudVisible(v) {
    $('hud').style.opacity = v ? 1 : 0;
    $('hud').style.pointerEvents = v ? '' : 'none';
  },
  raceShow(on, time, check) {
    $('race-hud').classList.toggle('hidden', !on);
    if (on) {
      $('race-timer').textContent = time;
      $('race-check').textContent = check;
    }
  },
  boardOpen(scores) {
    $('board-pop').classList.remove('hidden');
    $('board-list').innerHTML = scores.map(s => `<li>${s.name} — ${s.time}</li>`).join('')
      || `<li>${tx('暂无记录 · 完成一次环基地计时赛')}</li>`;
  },
  boardClose() { $('board-pop').classList.add('hidden'); },
};

export function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
