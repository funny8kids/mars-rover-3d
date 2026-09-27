// node tools/pale-foil-scan.mjs [names...]  — enumerate the PALE_FOIL recipe across every staged GLB.
// Reads each GLB's JSON chunk and prints, per material whose name is in the list (or matches --recipe),
// the authored metallicFactor / roughnessFactor / baseColorFactor. It is the audit behind the set in
// src/world/assets.js: which names carry metal ~0.6-0.9 at roughness 1.0 with NO baseColorFactor
// (so THREE keeps color = 1,1,1 and `luma > 2.7` cannot tell them apart), and which of those the set
// actually names.
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const DIR = path.join(ROOT, 'public/assets');
const wanted = process.argv.slice(2).filter(a => !a.startsWith('--'));
const RECIPE = process.argv.includes('--recipe');   // list every name matching the recipe, not just `wanted`
const RMIN = Number(process.env.RMIN ?? 0.9), RMAX = Number(process.env.RMAX ?? 1.001);
const MIN_MIN = Number(process.env.MMIN ?? 0.55), MAX_MAX = Number(process.env.MMAX ?? 0.95);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.glb')) yield p;
  }
}
function jsonChunk(file) {
  const b = fs.readFileSync(file);
  const len = b.readUInt32LE(12);
  return JSON.parse(b.slice(20, 20 + len).toString('utf8'));
}

const rows = [];
let n = 0;
for (const file of walk(DIR)) {
  n++;
  let gl;
  try { gl = jsonChunk(file); } catch (e) { console.log(`UNREADABLE ${file} ${e.message}`); continue; }
  for (const m of gl.materials ?? []) {
    const pbr = m.pbrMetallicRoughness ?? {};
    const metal = pbr.metallicFactor ?? 1.0;          // glTF default when the key is absent
    const rough = pbr.roughnessFactor ?? 1.0;
    const bf = pbr.baseColorFactor;                  // absent => THREE leaves color at 1,1,1
    const recipe = metal >= MIN_MIN && metal <= MAX_MAX && rough >= RMIN && rough <= RMAX && !bf;
    const hit = wanted.length ? wanted.includes(m.name) : recipe;
    if (!hit) continue;
    rows.push({ name: m.name, metal: metal.toFixed(2), rough: rough.toFixed(2), bf: bf ? bf.join(',') : 'absent',
      file: path.relative(ROOT, file), recipe: recipe ? 'RECIPE' : 'named-only' });
  }
}
console.log(`# ${n} GLBs under ${path.relative(ROOT, DIR)} · filter: names [${wanted.join(', ') || 'recipe'}]` +
  ` · recipe = ${MIN_MIN}<=metal<=${MAX_MAX} and ${RMIN}<=rough<=${RMAX} and baseColorFactor absent`);
const byName = new Map();
for (const r of rows) byName.set(r.name, (byName.get(r.name) ?? []).concat(r));
for (const [name, list] of [...byName].sort((a, b) => b[1].length - a[1].length)) {
  const files = [...new Set(list.map(r => r.file.replace(/^public\/assets\//, '')))];
  const kinds = [...new Set(list.map(r => `${r.metal}/${r.rough}/${r.bf}`))];
  const rec = [...new Set(list.map(r => r.recipe))];
  console.log(`  ${name}\t${list.length} material slots\t${kinds.join(' | ')}\t${rec.join('+')}\t<- ${files.join(', ')}`);
}
console.log(`names ${byName.size} · slots ${rows.length}`);
