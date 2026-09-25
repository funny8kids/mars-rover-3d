import * as THREE from 'three';

// ─── 阴影投射体预算 ───
// 阴影通道每帧把全图 1 506 个"想投影"的网格（userData.rsbCast，即 props.js 里 shade() 之外所有
// castShadow）投进 3 072² 深度图：标定格（1920×1080、太阳高度角 18°）实测完全武装时 shadow 通道
// 交 1 234 draw/tick、整帧 2 265 draw，而其中绝大多数投出的影子在画面上根本读不出来：几颗铆钉
// 在 60 m 外的沙面上投出 2 px 的灰点。这里的判据只决定"谁投影"，不决定"谁被画"——Beauty
// 通道一个三角形都不少，所以它不可能改变剪影，代价只有远处小道具的影子。
//
// 判据是"大到任何距离都值得投影，或者近到影子真的进画"：
//   世界包围球半径 ≥ big，或世界 AABB 高度 ≥ tall → 永远投影（建筑、桅杆、巨石）
//   否则只有离相机 ≤ near 才投影；已经开着时要退到 far 才关，避免在阈值上反复闪。
// 两个距离都按包围球中心量，与标定阈值时的量法一致（不是表面距离）。
// 实例化瓦片（A10 的 30 m 碎石场）按单实例包围球＋瓦片自身矩阵判定，即整块瓦片同进同退：
// 这就是标定时的量法，改成"整片实例合并包围球"会让每个瓦片都算大物件、预算当场失效。
//
// 为什么半径这一条不够：影子读不读得出来，取决于它有多长，而影长由**净高**决定，不由胖瘦决定。
// 路灯（lamp_shell）实测世界净高 6.32 m、包围球半径只有 3.65 m——19° 太阳下它投出 18 m 一条
// 黑带子，却正好卡在 big=4 之下。只看半径时逐机位普查显示：被降级又确实在画内的东西里，最大的
// 一批就是 46~56 m 外的路灯壳（每个占画面 0.22）。这条判据的成本和收益各自实测过，不是推理：
//   成本  107 个灯柱本体，tall=3.5 时 107/107 投影，把高度判据摘掉（tall=1e9）后 0/107；
//         全图永远投影的集合因此从 247 涨到 485。整条判据的价钱：深度通道 323 → 517 draw/tick，
//         整帧 1 482 → 1 673 draw，fps 54.5 → 53.4 —— 小于 radius-only 那一档自己三轮的散布
//         （55.0/54.5/53.5），所以是"读得出 draw、读不出帧率"。
//   收益  同一机位、同一太阳下三拍（A=有判据 / B=摘掉判据 / A′=同档重拍做控制）做**有向**帧差。
//         关掉一个投影体只会让它遮住的地面变亮，所以统计量是"变亮(>12 灰阶) − 变暗"，不是
//         "动了多少像素"：控制的噪声（浮尘、信标脉冲）两个方向都有、会自己抵消。实测 A→B 净
//         +316 px，A→A′ 控制 −2 px，且变亮像素连成画面下半幅的一横排——就是那条影子。clip=0。
// 所以补一条高度判据：细而高的东西永远投影，胖而矮的东西照旧按距离走。
//
// tall 取 3.5 而不是 3。3.0 只多放行 20/1 506 个网格（6 只低温罐、5 片天线罩、1 座塔、1 根桅杆，
// 外加 4 个已经有 6.32 m 同族兄弟开着的灯架构件），fps 在同场交错的三档里量不出差别
// （tall 3 / 3.5 / 4 → 53.8 / 53.5 / 53.5，噪声地板 ±1.5）。唯一能让这条阈值可见的机位，是把它
// 推到近距门之外：这些件离相机 44~58 m（> far=45，否则 near=35 早就替它们开着，阈值无从表现）、
// 离太阳方位 96°、clip=0，6/6 对 0/6 投影 —— 帧差净 +52 px，而同档控制自己每个方向就动 334 px，
// 8× 增强的变亮图里也找不出罐体形状的黑带。判不出收益就不付这份钱：留 3.5。
//
// 阈值来自 tools/cdp-frame-cost.mjs 的 shadow 档（9334 探针页、同一机位 (-94,-34) yaw 90、钉住
// dayT=0.30 → el=18°、1920×1080、三轮交错、读的是游戏自己的 rAF 帧循环）：完全武装 47.1 fps /
// 2 265 draw / 1 234 shadow draw·tick⁻¹，只看半径（tall=1e9）54.5 / 1 482 / 323，
// big=4 + tall=3.5 + near=35 → 53.4 / 1 673 / 517，完全关阴影的上限 62.6 fps / 1 202 draw。
// 太阳高度角必须钉住才可比：不钉时 asis 的 shadow draw/tick 会在两分钟内从 1 213 漂到 437，
// 因为太阳在动、阴影视锥罩住的道具集在变——那个漂移比这几档之间的差还大。
export function createShadowBudget(scene, { big = 4, tall = 3.5, near = 35, far = 45, step = 2.5, eye = null } = {}) {
  const sphere = new THREE.Sphere();
  const box = new THREE.Box3();
  const candidates = [];
  let lastEye = null;
  let always = 0;
  let lit = 0;
  let params = { big, tall, near, far, step };

  // Art intent is recorded once per mesh, then never read from `castShadow` again: classify()
  // writes that same flag, so a second classify() would see its own demotions as "this was never a
  // caster" and drop them out of the candidate set forever. Glass and light-additive surfaces are
  // already false here (props.js `shade()`), so they stay untouched by the budget.
  const intent = (o) => (o.userData.rsbCast ??= o.castShadow === true);

  function classify() {
    scene.updateMatrixWorld(true);
    candidates.length = 0;
    always = 0;
    lit = 0;
    scene.traverse(o => {
      if (!o.isMesh || !o.geometry || !intent(o)) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const radius = sphere.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld).radius;
      // World-axis AABB height, so a leaning prop reads taller than it stands: the error is toward
      // keeping a shadow, which is the direction a picture can survive.
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      const height = box.max.y - box.min.y;
      o.castShadow = radius >= params.big || height >= params.tall;
      if (o.castShadow) always++; else candidates.push(o);
    });
    lastEye = null;
    return candidates.length + always;
  }

  function update(pos) {
    if (lastEye && lastEye.distanceTo(pos) <= params.step) return lit;
    (lastEye ||= pos.clone()).copy(pos);
    lit = always;
    for (const o of candidates) {
      sphere.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld);
      const d = sphere.center.distanceTo(pos);
      const want = o.castShadow ? d <= params.far : d <= params.near;
      if (want !== o.castShadow) o.castShadow = want;
      if (want) lit++;
    }
    return lit;
  }

  classify();
  if (eye) update(eye);
  return {
    classify,
    update,
    // The QA sweep has to move the thresholds without reloading the page, because the ruler that
    // picked them is a per-arm fps measurement on one pinned sun in one page.
    retune(opts) { params = { ...params, ...opts }; return classify(); },
    get stats() {
      return {
        casters: always + candidates.length, always, small: candidates.length, lit,
        ...params,
      };
    },
  };
}
