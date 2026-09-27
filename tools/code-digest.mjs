// tools/code-digest.mjs — a hash of a JS file that comments cannot change.
//
// Why this exists: the clip/blown measurements in tools/logs/cell-attribution-2026-09-27.txt were
// taken while the prose in src/ was still being rewritten. A whole-file sha256 goes red on every one
// of those edits, which would either freeze the comments or void the measurement — both wrong, since
// a comment cannot move a pixel. This digests only the lines that can: whole-line comments, trailing
// comments and blank lines are dropped, what is left is hashed.
//
//   node tools/code-digest.mjs <file> [<file> …]     ->  <path>  <code lines>  <sha256[0:16]>
//
// Both controls, run 2026-09-27T11:10+08:00 on src/world/sky.js:
//   false positive (a comment must NOT move it): append "// a comment-only control line"  -> unchanged
//   polarity      (a pixel-changing byte MUST) : smoothstep(0.99985 -> 0.99986)           -> changes
// The polarity case edits a digit inside the GLSL string, which is why the digester strips comments
// from the text and not from the AST: the shader source is a template literal, so a comment written
// inside it is a byte the renderer actually compiles. That is also why nothing here claims to catch a
// comment written *inside* a string literal — it does not, and it is not meant to.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

for (const p of process.argv.slice(2)) {
  const lines = readFileSync(p, 'utf8').split('\n').map(l => {
    if (/^\s*\/\//.test(l)) return '';
    const cut = l.match(/(^|[^:])\/\/(?![^'"`]*['"`]$)/);
    let s = cut ? l.slice(0, cut.index + 2) : l;
    s = s.replace(/\/\*[\s\S]*?\*\//g, '');
    return s.replace(/\s+$/, '');
  }).filter(l => l.trim() !== '');
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
  console.log(`${p.replace(/^.*mars-rover-3d\//, '')}\t${lines.length}\t${digest}`);
}
