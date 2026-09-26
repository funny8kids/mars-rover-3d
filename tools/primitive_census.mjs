#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// The 【B】1 census: every geometry the runtime builds by hand, and whether it has
// said why.
//
// The standing rule (commit 048f582) is that an exception has to live on the thing it
// excuses: a retained hand-built primitive carries a `RETAINED RUNTIME PRIMITIVE` line
// immediately above its own call, with the measured reason a Blender/GLB pass cannot do
// better. Before this pass that marker existed in three places and the repo had no way to
// count the places it did not — the audit was a promise in a commit message.
//
// So this enumerates, per call site, three states only:
//   marked     — a RETAINED line sits within MARK_WINDOW lines above the call
//   exempt     — listed below with a ticket, and the ticket is the reason it is not marked yet
//   unmarked   — neither: that is the finding, and `--check` is red on it
//
// Two ways this could be silently green, both closed:
//   · a comment that spells `new THREE.XGeometry(` would enter the denominator, so comment
//     lines are dropped before matching;
//   · an exemption that outlives its fix would hide a new unmarked site of the same shape, so
//     every exemption is checked for staleness in both directions (marked anyway / anchor gone).
// The exemptions are matched on the whole relative path *and* a substring of the call line,
// never `endsWith` — a suffix match would let `src/other/main.js` inherit `src/main.js`'s
// exemptions.
// ══════════════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const MARK = 'RETAINED RUNTIME PRIMITIVE';
const MARK_WINDOW = 10;
const CALL = /new THREE\.([A-Za-z]+Geometry)\(/;

// Each entry: the file, an anchor that must be present on the call line, and who owns the fix.
// The three #105 entries are not excuses — those sites owe a marker like any other, and the only thing
// holding them is that #75 has src/main.js and src/world/sky.js open right now; a second writer in the
// same file would land its own hunks under the other's commit message. The exemption therefore names
// the ticket that empties this list, and #105 goes red the day one of them is marked and not removed.
const EXEMPT = [
  { file: 'src/main.js', anchor: 'TorusGeometry(6, 0.35', why: 'the race-gate rings', ticket: '#105', owner: 'after #75 releases src/main.js' },
  { file: 'src/main.js', anchor: 'TorusGeometry(r, r * 0.14', why: 'shockWave, one ring per event', ticket: '#105', owner: 'after #75 releases src/main.js' },
  { file: 'src/world/sky.js', anchor: 'SphereGeometry(7000', why: 'the sky dome volume', ticket: '#105', owner: 'after #75 releases src/world/sky.js' },
  { file: 'src/world/props.js', anchor: 'PlaneGeometry(2.3, 1.35', why: 'the plaza flag cloth', ticket: '#101', owner: '#101 (a Blender cloth asset, not an excuse)' },
  { file: 'src/world/props.js', anchor: 'CylinderGeometry(0.5, 2.6, 56', why: 'the five light-show searchlights', ticket: '#104', owner: '#104 (move them onto fx/beams.js; needs main.js:2280 off `.opacity`)' },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const sites = [];
for (const file of walk(SRC)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = line.match(CALL);
    if (!m) return;
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;   // a comment quoting a call is not a call
    const window = lines.slice(Math.max(0, i - MARK_WINDOW), i).join('\n');
    sites.push({
      rel: relative(ROOT, file), line: i + 1, cls: m[1],
      marked: window.includes(MARK),
      exempt: EXEMPT.filter(e => e.file === relative(ROOT, file) && line.includes(e.anchor)),
      text: t,
    });
  });
}

const unmarked = sites.filter(s => !s.marked && s.exempt.length === 0);
const exempt = sites.filter(s => !s.marked && s.exempt.length > 0);
const marked = sites.filter(s => s.marked);

// Stale exemptions, both directions.
const stale = [];
for (const e of EXEMPT) {
  const hits = sites.filter(s => s.rel === e.file && s.text.includes(e.anchor));
  if (!hits.length) stale.push(`${e.file} :: ${e.anchor} — the call it exempted is gone`);
  else if (hits.every(h => h.marked)) stale.push(`${e.file} :: ${e.anchor} — already marked, the exemption is now the cover`);
}

const byFile = new Map();
for (const s of sites) byFile.set(s.rel, (byFile.get(s.rel) || 0) + 1);

const L = [];
L.push(`primitive census — ${new Date().toLocaleDateString('en-CA')} — ${ROOT}`);   // local date, so the stamp matches the log's filename
L.push('command: node tools/primitive_census.mjs --check   (its exit code is not in this file; the run that produced these lines printed CHECK_RC on stderr)');
L.push('');
L.push(`total live hand-built geometry call sites: ${sites.length}`);
L.push(`  marked   ${marked.length}`);
L.push(`  exempt   ${exempt.length}   (${[...new Set(exempt.flatMap(s => s.exempt.map(e => e.ticket)))].join(', ')})`);
L.push(`  UNMARKED ${unmarked.length}`);
L.push('');
L.push('per file (call sites):');
for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) L.push(`  ${String(n).padStart(3)}  ${f}`);
L.push('');
L.push('exempt:');
for (const s of exempt) L.push(`  ${s.rel}:${s.line} ${s.cls}  → ${s.exempt.map(e => `${e.why} [${e.ticket}] ${e.owner}`).join('; ')}`);
if (unmarked.length) {
  L.push('');
  L.push('UNMARKED — no RETAINED line, no exemption:');
  for (const s of unmarked) L.push(`  ${s.rel}:${s.line} ${s.cls}  ${s.text.slice(0, 90)}`);
}
L.push('');
L.push('marked (the exception written on the thing it excuses):');
for (const s of marked) L.push(`  ${s.rel}:${s.line} ${s.cls}`);
L.push('');
L.push(`stale exemptions: ${stale.length}`);
for (const s of stale) L.push(`  ${s}`);
L.push('');
L.push(`VERDICT ${unmarked.length === 0 && stale.length === 0 ? 'PASS' : 'FAIL'}`);
console.log(L.join('\n'));

const check = process.argv.includes('--check');
if (!check) process.exit(0);
if (unmarked.length) { console.error(`CHECK_RC=1 — ${unmarked.length} unmarked call site(s)`); process.exit(1); }
if (stale.length) { console.error(`CHECK_RC=2 — ${stale.length} stale exemption(s)`); process.exit(2); }
console.error('CHECK_RC=0');
