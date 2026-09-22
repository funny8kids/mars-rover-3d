import { t as tx } from './i18n.js';

const $ = id => document.getElementById(id);
const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export const UI = {
  missions: [],
  renderMissions(missions) {
    this.missions = missions;
    const ul = $('mission-list');
    ul.innerHTML = '';
    for (const m of missions) {
      const li = document.createElement('li');
      // the counter is a hole in the sentence, so the whole line can be translated as one unit
      li.textContent = tx(m.text).replace('{n}', m.n).replace('{total}', m.total);
      li.className = m.done ? 'done' : m.active ? 'active' : '';
      ul.appendChild(li);
    }
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
