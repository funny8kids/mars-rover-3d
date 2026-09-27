#!/usr/bin/env node
// tools/beam-pool-mutants.mjs — prove the #104 pool gates can actually refuse.
//
// tools/beam-ladder-pool.mjs reads tools/logs/beam-level-ladder-2026-09-27.txt and exits non-zero when a
// claim in src/main.js stops holding. A gate nobody has seen red is decoration, so this takes the real
// log, breaks one claim at a time in a scratch copy, runs the pool over each copy, and refuses unless the
// named judgement is the one that fires. The unmutated copy is the false-positive control: it must pass.
//
//   node tools/beam-pool-mutants.mjs [log-path]
//
// Rows are addressed by (block, pose, rung), so a mutant moves one reading and nothing else — a grep on
// the number would hit the same text in three poses' footers.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const LOG = process.argv[2] || 'tools/logs/beam-level-ladder-2026-09-27.txt';
const ROW = /^(\s+)(0\.28)(\s+)([\d.]+)(\s+)([\d.]+)(\s+)(\d+)(\s+)(\d+)(\s+)(\d+)(\s+)([\d.-]+)(\s+)([\d.-]+)(\s+)([\d.-]+)(\s+)([\d.-]+)(\s+)([\d.-]+)(\s+)(.*)$/;

// Each mutant: which layer's crest rows at which pose, which column index of the match to rewrite, and
// the sentence the pool must then print.
const MUTANTS = [
  { name: 'no-op swap', pose: 'apron', layer: 'LADDER', col: 20, to: '0.00', expect: 'under the 1.5 floor' },
  { name: 'shafts too bright', pose: 'apron', layer: 'LADDER', col: 20, to: '+0.5', expect: 'lift difference' },
  { name: 'shafts blow pixels', pose: 'apron', layer: 'LADDER', col: 4, to: '0.62', expect: 'more pixels than the frame does without it' },
  { name: 'shafts reach the pad centre', pose: 'pad-centre', layer: 'LADDER', col: 20, to: '0.50', expect: 'no longer invisible from the pad centre' },
  { name: 'shafts lose the plaza', pose: 'plaza', layer: 'LADDER', col: 20, to: '0.10', expect: 'do not carry more light' },
];

let raw;
try { raw = readFileSync(LOG, 'utf8'); } catch (e) {
  console.log(`CANNOT_READ ${LOG} — ${e.code || e.message}`); process.exit(2);
}

const run = (text, tag) => {
  const p = join(tmpdir(), `beam-pool-mutant-${tag}.txt`);
  writeFileSync(p, text);
  try {
    const out = execFileSync(process.execPath, ['tools/beam-ladder-pool.mjs', p], { encoding: 'utf8' });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  } finally { rmSync(p, { force: true }); }
};

const apply = (m) => {
  let pose = '', layer = '', n = 0;
  const lines = raw.split('\n').map((ln) => {
    const h = ln.match(/^----\s+(LADDER|LEGACY)\s+(\S+)/);
    if (h) { layer = h[1]; pose = h[2]; return ln; }
    if (pose !== m.pose || layer !== m.layer) return ln;
    const r = ln.match(ROW);
    if (!r) return ln;
    const g = [...r];
    const old = g[m.col];
    const val = String(m.to).startsWith('+') ? (+old + +m.to.slice(1)).toFixed(2) : m.to;
    const pad = g[m.col - 1];                 // the whitespace column before the value keeps its width
    g[m.col] = val;
    g[m.col - 1] = ' '.repeat(Math.max(1, pad.length + old.length - val.length));
    n++;
    return g.slice(1).join('');
  });
  return { text: lines.join('\n'), n };
};

const clean = run(raw, 'control');
console.log(`CONTROL unmutated log → POOL ${clean.rc === 0 ? 'passes (as it must)' : `REFUSES (rc ${clean.rc}) — the log itself no longer satisfies the gates`}`);
const fails = [];
if (clean.rc !== 0) fails.push('control: the unmutated log does not pass, so no mutant result means anything');
for (const m of MUTANTS) {
  const { text, n } = apply(m);
  if (!n) { console.log(`MUTANT ${m.name}: no matching rows — cannot be judged`); fails.push(`${m.name}: addressed 0 rows`); continue; }
  const r = run(text, m.name.replace(/\W+/g, '-'));
  const caught = r.rc !== 0 && r.out.includes(m.expect);
  console.log(`MUTANT ${m.name} (${n} crest rows at ${m.pose} rewritten) → pool rc=${r.rc} `
    + `${caught ? `refused by name ("${m.expect}")` : `NOT refused by name — the gate is blind to it`}`);
  if (!caught) {
    fails.push(`${m.name}: the pool did not refuse with "${m.expect}" (rc ${r.rc})`);
    if (r.rc !== 0) console.log(r.out.split('\n').filter((l) => l.includes('refused') || l.startsWith('  ')).slice(-4).join('\n'));
  }
}
console.log(fails.length ? `MUTANTS_RC=1 — ${fails.length} blind gate(s):\n  ` + fails.join('\n  ') : `MUTANTS_RC=0 — ${MUTANTS.length} gates each seen red by the mutation they exist to catch`);
process.exit(fails.length ? 1 : 0);
