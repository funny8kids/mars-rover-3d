// Which materials does a `desun()` roughness tier actually move?
//
//   node tools/glb-metal-band.mjs [lo] [hi]        e.g. node tools/glb-metal-band.mjs 1.35 1.6
//
// `src/world/assets.js:desun()` buckets metals by the *sum* of the linear base colour (r+g+b, which
// it calls `luma`) and puts a roughness floor under the pale ones. Every time that boundary moves,
// the question is not "did the named offender get fixed" but "who else was standing in the band the
// boundary just stepped over" — and the answer has to come from the asset library, not from memory.
// So this reads the GLB JSON chunk of every file under public/assets and lists the materials the
// move changes the finish of.
//
// 口径, in the words the filter uses:
//   · metalness — `pbrMetallicRoughness.metallicFactor`, and glTF's own default of 1.0 when the key
//     is absent. Reading the key as "missing ⇒ 0" would hide exactly the materials that are worst
//     affected: `ti_anodised` and the Perseverance `spring` both omit it and are full conductors.
//     (An early version of this scan took `metallicFactor` off the material instead of off
//     `pbrMetallicRoughness`, so it came back undefined for every material, defaulted all of them to
//     1.0, and returned 10 names — six of them dielectric paint. The band is 3 names wide, not 10.)
//   · luma — `baseColorFactor` summed. A material with no `baseColorFactor` (the colour lives in the
//     base-colour texture, and THREE leaves `color` at 1,1,1) scores 3.0 and therefore never lands in
//     a band whose upper bound is below 3.0; those are matched by name elsewhere (PALE_FOIL).
//   · only materials whose authored roughness is *under* the floor they would get are worth seeing,
//     so the row prints roughness and the floor the boundary assigns.
import fs from 'fs';
import path from 'path';

const [loArg, hiArg] = process.argv.slice(2);
const LO = loArg === undefined ? 1.35 : Number(loArg);
const HI = hiArg === undefined ? 1.6 : Number(hiArg);
const ROOT = 'public/assets';

const walk = d => fs.readdirSync(d).flatMap(f => {
  const p = path.join(d, f);
  return fs.statSync(p).isDirectory() ? walk(p) : (p.endsWith('.glb') ? [p] : []);
});

const files = walk(ROOT);
const byKey = new Map();
let unparsed = 0;
for (const f of files) {
  const b = fs.readFileSync(f);
  if (b.readUInt32LE(0) !== 0x46546C67) continue;          // 'glTF' magic — not a GLB after all
  const n = b.readUInt32LE(12);
  let j;
  try { j = JSON.parse(b.slice(20, 20 + n).toString('utf8')); } catch { unparsed++; continue; }
  for (const m of j.materials ?? []) {
    const p = m.pbrMetallicRoughness ?? {};
    const metal = p.metallicFactor === undefined ? 1 : p.metallicFactor;
    if (!(metal > 0.5)) continue;
    const bf = p.baseColorFactor;
    const luma = bf ? bf[0] + bf[1] + bf[2] : 3;
    if (!(luma > LO && luma <= HI)) continue;
    const rough = p.roughnessFactor === undefined ? 1 : p.roughnessFactor;
    const k = `${m.name}\tluma ${luma.toFixed(2)}\tmetal ${metal.toFixed(2)}\trough ${rough.toFixed(2)}`
      + (p.metallicRoughnessTexture ? '\t+mrMap' : '') + (p.baseColorTexture ? '\t+bcMap' : '');
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(path.relative(ROOT, f).replace(/\.glb$/, ''));
  }
}

console.log(`band ${LO} < luma <= ${HI} · metalness > 0.5 (glTF default 1.0) · ${files.length} GLBs under ${ROOT}`
  + (unparsed ? ` · ${unparsed} unparseable` : ''));
if (!byKey.size) console.log('  (none — the boundary moves the finish of nothing in the library)');
for (const [k, v] of [...byKey].sort()) console.log(`  ${k}\t<-  ${[...v].sort().join(', ')}`);
