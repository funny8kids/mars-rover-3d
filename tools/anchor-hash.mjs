#!/usr/bin/env node
// tools/anchor-hash.mjs — hash the part of a source file that a measurement can actually depend on.
//
// The #104 parity claim (src/main.js) is anchored to a browser run: the ladder in
// tools/logs/beam-level-ladder-2026-09-27.txt drew its frames from specific bytes, and rewording the
// comment above the code being measured does not redraw them. A whole-file sha256 cannot tell those two
// apart, so either the comment can never be corrected or the measurement is silently stale — this prints
// both hashes and leaves the choice explicit:
//
//   ANCHOR  sha256 over the file with full-line comments (`^\s*//`) removed  — the standing anchor
//   BYTES   sha256 over the file as it sits on disk                          — the run's snapshot
//
// `--check` compares the ANCHOR against an expected value and exits 1 on a mismatch, which is what makes
// the log's claim readable by a machine rather than by a human. The normalisation is only sound because
// no string literal in the measured files starts a line with `//`; `tools/anchor-hash.mjs --selftest`
// re-derives both halves of that assumption on a scratch copy (add a comment → ANCHOR holds, edit a
// digit of code → ANCHOR moves). Its third and fourth arguments choose which code line to break, and it
// refuses to judge a file whose line isn't there rather than reporting a vacuous pass.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
export const anchorOf = (text) => sha(text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'));
export const bytesOf = (text) => sha(text);

const [path] = process.argv.slice(2);
if (path === '--selftest') {
  // Both halves of the assumption, on a scratch copy of the file the anchor points at.
  const target = process.argv[3] || 'src/main.js';
  let base;
  try { base = readFileSync(target, 'utf8'); } catch (e) { console.log(`CANNOT_READ ${target}`); process.exit(2); }
  // The inserted line keeps the surrounding indentation: an indent change is a text change, and the
  // first self-test draft of this line dropped four spaces and reported the anchor as comment-sensitive.
  const a0 = anchorOf(base);
  const needle = process.argv[4] || '0.16 + 0.12 * Math.sin(elapsed * 2.4)';
  const replacement = process.argv[5] || '0.17 + 0.12 * Math.sin(elapsed * 2.4)';
  if (!base.includes(needle)) {
    console.log(`MUTATION_ANCHOR_ABSENT ${target}: no "${needle.slice(0, 32)}…" to break, so this file's`
      + ` anchor is not being judged here — pass the code line to mutate as the 3rd/4th arguments.`);
    process.exit(2);
  }
  const reworded = anchorOf('// a line added by the self-test, no code touched\n' + base);
  const mutated = anchorOf(base.replace(needle, replacement));
  const lines = base.split('\n').filter((l) => /^\s*\/\//.test(l)).length;
  console.log(`SELFTEST on ${target}: ${lines} full-line comment rows; anchor ${a0.slice(0, 12)}…`);
  console.log(`  reword (one comment line added) → ${reworded === a0 ? 'ANCHOR HOLDS' : 'ANCHOR MOVED (a comment edit invalidated the measurement — the normalisation is wrong)'}`);
  console.log(`  mutate (\`${needle.slice(0, 40)}\` → \`${replacement.slice(0, 40)}\`) →`
    + ` ${mutated !== a0 ? 'ANCHOR MOVED (as it must)' : 'ANCHOR HELD (the code line is invisible to the hash — the anchor is decoration)'}`);
  const ok = reworded === a0 && mutated !== a0;
  console.log(ok ? 'SELFTEST_RC=0' : 'SELFTEST_RC=1');
  process.exit(ok ? 0 : 1);
}
if (!path) { console.log('usage: node tools/anchor-hash.mjs <file> [<expected-anchor> | --check <sha>]   |   node tools/anchor-hash.mjs --selftest [file]'); process.exit(2); }
let src;
try { src = readFileSync(path, 'utf8'); } catch (e) { console.log(`CANNOT_READ ${path} — ${e.code || e.message}`); process.exit(2); }
const anchor = anchorOf(src);
console.log(`ANCHOR ${anchor}  ${path}  (executable text — the standing anchor)`);
console.log(`BYTES  ${bytesOf(src)}  ${path}  (as on disk right now)`);
const want = process.argv[3] === '--check' ? process.argv[4] : process.argv[3];
if (want) {
  console.log(anchor === want ? `ANCHOR_MATCH ${path}` : `ANCHOR_MISMATCH ${path}: log says ${want}, file is ${anchor}`);
  process.exit(anchor === want ? 0 : 1);
}
