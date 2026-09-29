#!/usr/bin/env node
// 【F】1 吊车/发电机「驾驶机位那一帧」的取锚件：把 prop→坐标 从**离线构建**里 dump 出来。
//
//   node tools/cc0-anchor-dump.mjs
//
// 为什么要走离线：活页面上拿不到这两件的位置 —— `scene.traverse` 找不到（道具被 mergeInto 合掉，
// prop id 不在对象 name 上），`R.colliders()` 交回的是压缩行、不带 `prop` 字段。`offline-world.mjs`
// 的 `colliders` 保留 `prop`，所以坐标在这里是完整的：页内探针只要吃这份输出里的中心点就能站好机位。
import { buildOfflineWorld } from '/home/dominic-jamil/GIthub_Code/mars-rover-3d/tools/offline-world.mjs';

const w = await buildOfflineWorld({ sky: true });
const rows = (w.colliders || []).filter(c => typeof c.prop === 'string' && /genset|gantry|crane|substation/i.test(c.prop));
const byProp = {};
for (const c of rows) (byProp[c.prop] ||= []).push(c);
const out = [];
for (const k of Object.keys(byProp).sort()) {
  const v = byProp[k];
  const cx = v.reduce((a, c) => a + c.x, 0) / v.length, cz = v.reduce((a, c) => a + c.z, 0) / v.length;
  out.push({ prop: k, discs: v.length, cx: +cx.toFixed(2), cz: +cz.toFixed(2), maxR: +Math.max(...v.map(c => c.r)).toFixed(2),
    top: v.some(c => c.top === undefined) ? null : +Math.max(...v.map(c => c.top)).toFixed(2) });
}
console.log(JSON.stringify(out, null, 1));
console.log('TOTAL matching discs', rows.length, '· props', out.length);
process.exit(0);
