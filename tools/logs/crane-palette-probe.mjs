// Crane palette separation尺 —— 判「这台吊车在画面上是不是另一台机器」。
//
// 为什么需要它：`crane-carried-check.mjs` 量的是落位与碰撞（缩放、标高、净空、盘数），那份尺对
// 颜色完全失明 —— 吊车可以和宿主门架是同一个 albedo 而照样 `CRANE_CHECK_PASS`。2026-09-29 看图
// 记下的"读成一根更粗的梁"正是这一格：离线量到两件材质（truss 与 trim）是同一个 0.30/0.275/0.245，
// 而宿主门架的 `steel` 是 0.305 —— 差 0.03 亮度，结构上就是迷彩。
//
// 三条判据全部从场景里现读的材质算，不手抄产品公式：
//   G1 吊车自己的两件材质要分得开（内部色调分离），亮度差 ≥ 0.04 或色相差 ≥ 0.25
//   G2 trim 必须是基地那个安全色（红减蓝 ≥ 0.35），truss 必须是中性（|红减蓝| ≤ 0.08）
//   G3 吊车与宿主门架的全部材质之间，至少有一条 ≥ 0.06 的亮度差且伴随色相方向不同 —— 即"不迷彩"
//
// 极性对照（`--control`）：把改动前那一对真实值（同一色两次）喂进同一条纯函数 `grade()`，必须判红。
// 「派生 A、派生 B、比较相等」的守卫如果不把比较做成可注入纯函数，改坏比较也测不出来。
import { buildOfflineWorld } from '../offline-world.mjs';

const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const rgbOf = mt => [mt.color.r, mt.color.g, mt.color.b];
// 色相方向用红减蓝：火星场景里灰是暖的、安全色是橙的，这一个数就能把两者分开。
const warm = ([r, , b]) => r - b;

// 纯函数：观察值进，判据出。GATES 的阈值只在这里出现一次。
export function grade(body, trim, hostMats, gates = { internal: 0.04, accent: 0.35, neutral: 0.08, host: 0.06 }) {
  const out = [];
  const dBright = Math.abs(lum(body) - lum(trim));
  const dHue = Math.abs(warm(body) - warm(trim));
  out.push({ id: 'G1_internal_separation', pass: dBright >= gates.internal || dHue >= 0.25,
             brightDelta: +dBright.toFixed(4), hueDelta: +dHue.toFixed(4) });
  out.push({ id: 'G2_trim_is_safety_hue', pass: warm(trim) >= gates.accent, trimWarm: +warm(trim).toFixed(4) });
  out.push({ id: 'G2b_body_is_neutral', pass: Math.abs(warm(body)) <= gates.neutral, bodyWarm: +warm(body).toFixed(4) });
  const vs = hostMats.map(h => ({ name: h.name, d: +(lum(h.rgb) - lum(trim)).toFixed(4),
                                  dh: +(warm(h.rgb) - warm(trim)).toFixed(4) }));
  const best = vs.slice().sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0] || null;
  out.push({ id: 'G3_not_camouflage', pass: !!best && Math.abs(best.d) >= gates.host && Math.abs(best.dh) > 0.05,
             against: best ? `${best.name} Δluma ${best.d} Δwarm ${best.dh}` : 'NO_HOST_MATERIALS' });
  return out;
}

const { scene } = await buildOfflineWorld({ sky: false });
// 宿主的归因口径抄 `crane-carried-check.mjs`：门架的材质被重染进基色板，所以只能按 prop scope 找，
// 而合并之后 scope 不一定还在网格自己的 userData 上 —— 父节点名是那一把尺用的第二种身份。
const scopeOf = o => String(o.userData?.scope || o.parent?.name || '');
const craneMats = new Map(), hostMats = new Map();
const hosts = [];
scene.traverse(o => {
  if (!o.isMesh) return;
  const scope = scopeOf(o);
  const isHost = /gantry/.test(scope) && !/overhead_crane/.test(String(o.name));
  for (const mt of (Array.isArray(o.material) ? o.material : [o.material])) {
    if (!mt) continue;
    if (/overhead_crane/.test(mt.name || '')) { if (!craneMats.has(mt.name)) craneMats.set(mt.name, rgbOf(mt)); }
    else if (isHost) { if (!hostMats.has(mt.name)) hostMats.set(mt.name, rgbOf(mt)); }
  }
  if (isHost) hosts.push(o);
});
console.log('CRANE_MATS ' + craneMats.size + ' · HOST_MESHES ' + hosts.length + ' · HOST_MATS ' + hostMats.size);
if (craneMats.size !== 2) { console.log('CRANE_PALETTE_FAIL NO_CRANE_TO_MEASURE'); process.exit(1); }
const body = craneMats.get('overhead_crane'), trim = craneMats.get('overhead_crane_trim');
console.log('CRANE_RGB_BODY ' + JSON.stringify(body));
console.log('CRANE_RGB_TRIM ' + JSON.stringify(trim));
for (const [k, v] of hostMats) console.log('HOST_RGB ' + k + ' ' + JSON.stringify(v));

const rows = grade(body, trim, [...hostMats].map(([name, rgb]) => ({ name, rgb })));
for (const r of rows) console.log('GATE ' + r.id + ' ' + (r.pass ? 'ok' : 'FAIL') + ' ' + JSON.stringify(r));
const failed = rows.filter(r => !r.pass).map(r => r.id);

// 极性对照：改动前那一对真实值（两件材质同一个 albedo，实测 CRANE_LUMA_SPAN 0）
const PRE = { body: [0.30, 0.275, 0.245], trim: [0.30, 0.275, 0.245] };
const ctrl = grade(PRE.body, PRE.trim, [...hostMats].map(([name, rgb]) => ({ name, rgb })));
const ctrlFailed = ctrl.filter(r => !r.pass).map(r => r.id);
for (const r of ctrl) console.log('CONTROL ' + r.id + ' ' + (r.pass ? 'ok' : 'FAIL') + ' ' + JSON.stringify(r));

const controlCaught = ctrlFailed.length > 0;
console.log('FAILED ' + failed.length + ' ' + JSON.stringify(failed));
console.log('CONTROL_CAUGHT ' + controlCaught + ' ' + JSON.stringify(ctrlFailed));
if (failed.length === 0 && controlCaught) { console.log('CRANE_PALETTE_PASS'); process.exit(0); }
console.log('CRANE_PALETTE_FAIL');
process.exit(1);
