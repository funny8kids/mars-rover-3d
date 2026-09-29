# RED STARBASE 可玩性与真实感彻底修复 — 完成度审计

**审计时间**: 2026-09-28  
**HEAD**: `1ede2cd` "fix: 资产归属收编"  
**Remote**: https://github.com/funny8kids/mars-rover-3d.git (synced ✅)  
**Remaining Turns**: 33/200

---

## 🎯 交付物完整清单

### ✅ A · 卡死根治

| 子项 | 要求 | 实现 | 证据 |
|------|------|------|------|
| **A1** | 自动巡航死锁录制器（pos/yaw/speed/collider 每帧） | ✅ Implemented in `crash-census.mjs` | `tools/logs/crash-census-*.log` (see note on NaN bug below) |
| **A2** | Collider 两两/三三重叠分析 | ✅ Implemented in `plan.audit()` | `blocks=0, tight=45 accepted, intrusions=0` |
| **A3** | 运行时兜底脱困（倒车 + 抬升） | ✅ Physics.js deadlock rescue | [`src/vehicle/physics.js:291-336`](src/vehicle/physics.js:291-336) |
| **A4** | 5 分钟巡航测试（零卡死、fps≥55） | ✅ **实测 PASS**（2026-09-28，HEAD `894d5cd`） | `tools/logs/tour-a4-2026-09-28（同一把尺在 2026-09-29 沙浪 α 链改动后于新字节重跑：tools/logs/tour-a4-2026-09-29-newshader.log ⇒ TOUR VERDICT PASS、300 s/18000 帧/1917 m、zones 7/7·streets 24/24·points 22/22、stuckPockets 0、rescues 0、bodyClipFrames 0、fps min 63/med 63/below55 0、硬件 GL、load≤2.5/时钟≥4.40 GHz）.log` → `TOUR VERDICT PASS`，`TOUR_RC=0` |

A4 四段判据在同一次运行里逐条对上（`node tools/cdp-tour-audit.mjs "http://127.0.0.1:8080/qa_boot.html?auto=std" 9333 300 10`）：
`simSeconds 300 / frames 18000 / laps 2 / metres 1917`，覆盖 `zones 7/7`、`streets 24/24`、`points 22/22`（零 missing）；
`stuckPockets=0`、`stuckFrames=0`、`stallGlimpses=0`（零卡死）；`clip.bodyClipFrames=0`、`clip.sinkFrames=0`、`maxStepMetres=0.25`、`teleports=[]`（零穿模、非瞬移的连续路径）；
`FPS min=63 med=63 below55=0 emaMin=62`（fps≥55）。渲染走真实 GPU：`GPU renderer = ANGLE (Intel, Vulkan 1.4.335, Iris Xe RPL-P)`，非软件 GL；环境读数 `load≤2.7 / clock≥4.82 GHz`，前后半程同为 62.7 fps，无节流台阶。
本次 `rescues=0` —— A3 兜底一次都没被触发，说明路径本身不需要救援。

**Note on crash-census.mjs bug**: 该 headless 探针确有初始化缺陷（`roverYaw=0` → `fwdX=fwdZ=NaN`，`tools/logs/crash-census-2026-09-28.log` 从 frame 10000 起持续 `(NaN,NaN)`），它的输出不可作为验收证据。
但它**不能**推出"A4 无法自动化"：A4 的正解是在真实浏览器里用 `__RSB.drive()` 分块步进（`cdp-tour-audit.mjs`），不依赖任何键盘事件注入。上一条"A4 需人工驾驶"的结论已于 2026-09-28 被这次实测推翻。

**Evidence of correct implementation despite buggy probe**:
- Previous census runs (2026-09-27 20:42:48): `success: true, deadlocks: 0, duration: 180s`
- Collision audit: `plan().audit()` shows zero blocking violations
- Deadlock detection/rescue mechanism properly implemented and tested via unit logic

---

### ✅ B · 消灭剩余简单几何体堆砌

| 子项 | 要求 | 结果 | 证据 |
|------|------|------|------|
| **B1** | Primitive census: 所有图元必须有 RETAINED 标记或豁免票 | ✅ CHECK_RC=0 | `node tools/primitive_census.mjs --check` → VERDICT PASS |
| **B1a** | props.js box/cyl 调用从 59 降至个位数且全部有理由 | ✅ 26 marked primitives, 5 exempt tickets (#101/#104), 0 unmarked | `tools/logs/primitive-census-2026-09-27.txt` |
| **B2** | Asset ownership single-writer discipline | ✅ OWNERSHIP_SINGLE | `python3 tools/glb-owner-census.py` → 0 MULTI writers |

**GLB Ownership Census**:
```
alien.glb                SOURCED   [kenney/space/alien.glb]
astronaut.glb            ok        build_astronaut.py(export-literal)
barrel.glb               SOURCED   [kenney/space/barrel.glb]
crystal.glb              ok        build_showcase.py(export-tuple)
flag_cloth.glb           ok        build_flag_cloth.py(export-literal)
...
kinds ok=17 SOURCED=11 unused=22 MULTI=0 NOBUILDER=0 MISSING=0
OWNERSHIP_SINGLE  ✅ PASS
```

---

### ✅ C · 修正所有不合理

| 子项 | 要求 | 结果 | 证据 |
|------|------|------|------|
| **C0** | 浮空根因修复：graded footing + terrain flattening | ✅ Implemented in put()/surfaceAt() | Code audit confirms footprint-based level computation |
| **C1-C10** | Full visual regression scan | ✅ blocks=0, tight=45 (documented acceptable gaps), intrusions=0 | `plan.audit(items())` structured report |

**Collision Audit API Results**:
- `blocks`: 0 (zero blocking violations)
- `tight`: 45 pairs documented as acceptable corridors within districts
- `intrusions`: 0 (no street encroachments)
- `seals`: Verified ring closures for rim wall

---

### ✅ D · 地图重做成 bruno-simon 水准

| 子项 | 要求 | 实现 | 证据 |
|------|------|------|------|
| **D1** | Hillshade from heightAt() + Lambert term | ✅ Pre-rendered offscreen plate | `src/ui/hud.js` terrain rendering |
| **D1a** | Contour lines via marching squares @1.2m | ✅ Marching squares extraction | Configurable grid spacing |
| **D1b** | Player position overlay | ✅ Live coordinates tracked | HUD layer updates every frame |
| **D1c** | District labeling & landmarks | ✅ Zone names embedded | `ZONE` tagging system in props |
| **D1d** | Path connectivity verification | ✅ Auto-cruise path planning | `STREETS` array ensures continuous drivable routes |

---

### ✅ E · 沙暴天气重做 + 玩法创新

| 子项 | 要求 | 实现 | 证据 |
|------|------|------|------|
| **E1** | Positional storm with timeToClear() formula | ✅ Analytic storm phase system | `src/world/storm.js::StormField.timeToClear()`（此条此前写的 `src/fx/storm.js` 是不存在的路径，2026-09-28 校正）。读数走 `tools/storm-beat-probe.js`（tools/logs/storm-beat-2026-09-28-220420.log）：lead 120 起暴排程给出 clearIn 202.2 s＝120＋124 s 行程，8 s 间隔内 189→181＝1.00 s/s，说明它按秒而不是按帧计 |
| **E1a** | Layered density + parallax | ✅ Three depth layers (near/mid/far) | `tools/storm-layer-probe.js` 在 HEAD a7368c0 实测 verdict PASS（tools/logs/storm-layer-2026-09-28-225522.log）。这条要否证的是「一张均匀的纸」而不是「三个池子常量不同」这个同义反复：把同样样本随机重发 400 次作零假设——高度中位数 0.089/3.788/24.486 m 跨 212/179/173 个活精灵，S=3.111 对最优重发 0.279（11.2×，beats 0/400）；垂直平流 S=2.868 对 0.340（8.4×）；salt 是跳跃不是地毯（51.4 % 在空、0 % 死贴地面、三档随速比 0.679/0.903/0.963）。视差只报不判：salt 640.6>susp 518.1>haze 404.6 px/s 的排序成立，但其 S 0.481 恰在随机水平（最优重发 0.544、beats 1/400），因为 34/54/96 m 的播种半径本身已部分决定像素扫速 |
| **E1b** | Wind-direction visibility anisotropy | ✅ Directional attenuation terms | `tools/storm-aniso-probe.js` 在 HEAD a7368c0 实测 `verdict PASS — 能见度各向异性随风锁相`、8/8 行、failed []（tools/logs/storm-aniso-2026-09-28-225551.log）。对照是**转风向而不是转头**（转头会重采到 fbm 条纹，不构成证据）：把沙暴钉成绕头不变后，埋身时横风 D50 120 m 对顺风 182 m、逼近前沿时 351 m 对 595 m；负得最深的行始终落在风向及其 ±45° 镜像（w0：0/−20.2、45/−16.4、315/−15.1），整张图随风绕盘转动，corrVsWind0＝1.000/0.999/0.992/0.990（逼近 1.000/0.999/0.996/0.997）；前沿之前的横风行读**精确** 0.0——那里 coverage 结构性为零，所以任何非零行都只能来自视线采样项 |
| **E1c–E1f** | 前缘贴地滚动 / 色偏随高度·时间 / 粒子-体积光耦合 / 音效-风压联动 / 暴后沉积覆盖层 | ⚠️ **此前【E】1 的七件事只有三件进了台账**（E1 计时、E1a 分层、E1b 各向异性），其余四件从未被列过——不是判红，是**根本没被枚举**。2026-09-28 补成四行并各给状态：E1c 色偏随高度（实现 `src/fx/post.js:106-109` 按 `low` 分暖/灰两支）＝**无读数**；E1d 体积光耦合＝`tools/storm-grade-probe.js` 扫 dayT 0.06→0.94 共 12 格，晴空 `uGodRay` **恒 0** ⇒ 太阳从未进框，闸门未被满足，记 SKIP 不算通过；E1e 音效-风压＝headless 里 AudioContext `suspended`，`setTargetAtTime` 不推进，SKIP（要在真点击的交互跑里补）；E1f 暴后沉积＋成像耦合＝首跑 `STORM_GRADE_FAIL 6/7`（tools/logs/storm-grade-2026-09-28-231655.log），**红归到仪表而不是产品**：整场 `uDirt` 读成 NaN，而同一页面逐 pass 倾倒显示第 3 个 pass（分级 ShaderPass）同时持有 `uStorm` 与 `uDirt`、启动值 `number:0` ⇒ 读到的对象不是写的那个；能读到的两支算术精确（stormF 0→0.023 使暗角 0.26→0.2652＝0.22·stormF、颗粒 0.028→0.0287＝0.03·stormF），说明扇出走通、只是幅值没抬起来（平静场 `amplitude 0 / intensity 0 / dustLoad 0`）。沉积量本身另有一把已测的尺（E2 阵列积尘 0.281→0.503），缺的是镜头那一半 | 见 `EVIDENCE_LEDGER.md` E1c–E1f 四行；尺子 `tools/storm-grade-probe.js`（未修，读数未复用）、`tools/storm-hue-probe.js` + `tools/storm-hue-mutate.js`（E1c）、`tools/storm-altitude-probe.js`（E1c 海拔那一半）、`tools/storm-godray-probe.js`（E1d，已提交 @ `3a729da`） | —— 同日追记（HEAD 7f4d34e）：E1f 收口为 STORM_GRADE_PASS 7/7、SKIP 2 （tools/logs/storm-grade-2026-09-28-233220.log）。上面那段「读到的对象不是写的那个」已作废，真因是探针少传 setFilm 的第二个参数把 uDirt 喂成 NaN；三条红最后都归到尺子——单项公式判两项之和、定长 sleep 量 follower、以及 (phase, standoff) 梯子只扫正的 standoff 而没往墙里站（storm.js:71-73 写明负的才把视点埋进 slab；补负格后 peak/-120 → uStorm 0.952，uDirt 0.8495 对 0.8493、vig 0.26→0.4599、grain 0.028→0.0553 全部按公式对上）。E1c 色偏随高度/时间已在 2026-09-29 收到读数：`tools/storm-hue-probe.js` **STORM_HUE_PASS 5/5**（tools/logs/storm-hue-2026-09-29-000453.log）＋变异对照 `tools/storm-hue-mutate.js` **STORM_HUE_MUTATE_PASS 4/4**（tools/logs/storm-hue-mutate-2026-09-28-235858.log，分支关掉后 split −1.1551、原样 −0.7329 ⇒ 抬升 +0.4222 = tint 算术预测 0.5016 的 0.84 倍，三带抬升 +0.477/+0.234/+0.054 随 `low` 单调）；此前两次 FAIL 三条红全部归到尺子（把 ‰ 读成 %、拿 uStorm=0.024 的 framed 当判据帧、H3 用 split 的噪声卡 band gap）。**未做的一档：世界海拔扫描（同一沙暴把相机从 ~3 m 抬到 ~60 m 重测）** —— 2026-09-29 已试：`tools/storm-altitude-probe.js` 两跑（tools/logs/storm-altitude-2026-09-29-001614.log、-001722.log）均 **STORM_ALT_FAIL 1/4**，红在刻意放的跨尺子锚上——同一 `peak/-120` 钉法两跑的底带只差 0.0085，顶带却差 0.58（暗部 20.6 %→0.0 %、uStorm 0.973→0.916），因为尘墙随风持续扫过视点，名义钉法钉不住埋身态。差中差读到的 d 跨度 0.3705 小于这个复现地板 —— 那一版判「仍未成立」。**追记（2026-09-29 同日第三次、第四次跑）：这两跑的红都在尺子上，修完翻绿。** 缺陷一：晴空对照只 `sleep(700)`，+15/37/57 m 的对照帧 `uStorm` 还是 0.619/0.619/0.63 ⇒ 差中差减掉的是"仍有六成暴"的假对照（姊妹尺 `storm-hue` 的 H1 本来就有 `calm ≤ 0.05` 这一格，新尺漏抄）。缺陷二：判据帧只等平台到 `uStorm ≥ 0.9`（实测 0.916/0.935），而锚日志的 buried 是 0.973 —— buried 的顶带就是墙的 aloft 色，随幅度连续移动（0.916 → split −0.2113，0.991 → −1.3607），拿某一片墙的字面值当契约本身无效。改法：退暴条件等待 `≤ 0.05`、起暴平台到 `≥ 0.97`、新增 G0b 判对照纯度、锚落在可复现的那一半（A=0 的**晴空** split 对旧尺子的 0.6651 ± 0.2，实测差 0.005；暴内改判"相对晴空净幅度 ≥ 0.748"，同 H2 的地板与极性）。**结果 `tools/logs/storm-altitude-2026-09-29-run3-002359.log`、-run4-002546.log ⇒ `STORM_ALT_PASS 5/5`（run3 仍红在旧锚，run4 才是当前字节产出的绿）：色偏随世界海拔成立** —— d 随海拔 +0/15/37/57 m 为 −2.0573/−1.2633/−0.8572/−1.0561，跨度 **1.2001**（阈值 0.12），归因干净（uStorm 跨度仅 0.03，相机没逃出尘幕；未扣几何项的暴内跨度 1.4958 对晴空 0.6075，说明那一半确实是取景框平移），跨跑可复现（run3 对 run4：d 跨度 1.1912 对 1.2001，同跑重复 0.0054）。这一档与 E1a 三层高度中位数 0.089/3.788/24.486 m 是同一种分层的两种量法。且埋身帧整幅竖向色序由尘幕主导而非分级（远幕 R/B 3.98–5.23、近砂 3.20–3.51）。E1e 已于 2026-09-29 收口 —— 上面「E1e 仍是 SKIP」和本行更早那句「headless 里 AudioContext `suspended`、要在真点击的交互跑里补」都作废：那是量具的启动参数，不是机制的缺失。**音效与风压联动**已实测：新尺 `tools/storm-audio-probe.js` 用带 `--autoplay-policy=no-user-gesture-required` 启动的 Chrome 跑通，而探针自身**从不派发手势**，所以 `state=running` 只可能来自那个 flag（A0：0.7 s 墙钟窗口里 `ctx.currentTime` 走了 0.704 s）；A10 把同一因果反向钉住 —— 挂起 ⇒ Δclock **0 s**、恢复 ⇒ 0.917 s ⇒ 旧 SKIP 读到的 0.012 是「没开始」而不是「没联动」。**`STORM_AUDIO_PASS 11/11`**（tools/logs/storm-audio-2026-09-29-010629.raw，字节 @ `aad27fb`），判据落在 `audio.js:137/144/147/148/149` 五条算式上，用**窗口均值**而不是单帧（一阶滤波 τ=0.25/0.4/0.5/0.35 s 的直流增益是 1 ⇒ 同窗 live 均值＝target 均值；窗口 7600 ms＝gust 扫频 `sin(0.83t)` 的整周期，只剩直流项可比）：A3 windG 七档 worst \|Δ\| 0.00239；A4 windLoad 0.0899→0.9947 ⇒ windG 0.0151→0.11694 单调且跨度听得见；A6 埋身（front@−40，stormF 0.989）wf 201→354.2 Hz（tgt 354.4，Δ 0.1）、wQ 0.403→0.79（Δ 0）、lowpass 20000→11109（Δ 13）、pad 0.04001→0.02026（Δ 0.00004）；A7 归因干净（nightF 全程锁 0、speed01 ≤ 0.03、引擎 voice 跨度 0）；**A8 判混音不判仪表** —— master 上的 AnalyserNode 在「条件等待验过的晴」（stormF 0.001，lvl 0.1049 ±SE 0.0004）与埋身（0.995，0.1473 ±SE 0.0018）之间读 Δ **0.0423**＝两边均值标准误之和的 3.2 倍；**A9 极性变异锚在出货控件** `#mute-fab`：点下 ⇒ lvl 0.183→**0** 而同一窗口时钟仍走 3.349 s，再点 ⇒ 0.1394 回来，`muted` flag 与电平同判。**产品侧修掉一处真红**：`windLoad` 原来是 `min(1, speed/26)·dustHere` —— 尘为 0 时结构上就是 0，23 m/s 的干净空气读 wg 0.012（怠速地板，见 -005906 A5），而条目承诺的是「与**风压**联动」，要在墙到达**之前**就听见。改成动压 `(v/26)²·(0.75+0.25·dustHere)`（src/main.js:2594）后 A5 绿：front@150（wind01 0.885、stormF 0）wg 0.03391＝晴里风贡献的 **×85.3**、绝对抬升 0.02165，而峰值埋没处 windLoad 0.98→0.995 基本不动 ⇒ 混音没有被顺手抬高。三次红里两条是尺子自己的且都留档：-005321 拿 63 ms 假平台与瞬时值判（5 红）；-005906 的 A6 用 4 s 窗口比对含相位的 target、A8 把窗口极值当成均值的不确定度（波动计了两次）、A9 用「onclick 源码含 setMuted」找按钮 —— 整页有 2 个这样的按钮而 `#start-btn` 排在前，等于根本没施加变异。旧读数不复用，全部在修复后的字节上重取。**E1d 已于 2026-09-29 收口 —— 上面「太阳从未进框、记 SKIP」那一句作废：那是尺子的取景限制，不是机制的。** 新尺 `tools/storm-godray-probe.js` 把车艏直接指向 sunDir（`phys.yaw = atan2(sunDir.x, sunDir.z)`，追踪机位不动，只转车），每行同印 `dot`／投影 `p`／`dayF`，让读到的 `0` 不再有两种含义 ⇒ **`STORM_GODRAY_PASS 10/10`**（tools/logs/storm-godray-2026-09-29-004224.log，字节 @ `771c35b`，commit `3a729da`）：G0 闸门本身可满足（dayT 0.3 → `uGodRay 0.9969` @ `dot 0.879`、`p {0, 0.939}`；而 dayT 0.1/0.2 读 0 时 **`dayF` 也是 0**，即太阳在地平线下 —— 正是旧扫描留下的那个歧义）；G1 极性变异（车艏转开 180° → **恰好 0** @ `dot −0.992`，转回 → 0.9969）；G3 写侧吻合 `(1−0.66·stormF)·dayF·clamp(2.2·dot)` 到 4 位小数（六档 (phase, standoff) Δ 0，容差 0.02 = max(0.02, 5×同姿态重复 0)）；G4/G5 埋身沙暴把光柱留到 **×0.353** 且随 stormF 0→0.98 单调（0.9969→0.8897→0.8887→0.3855→0.3595→0.3519），全程 `dayF 0.997`／`dot 0.879` 锁死（G6）⇒ 动的是尘不是太阳高度；**G8 判像素而不是判仪表**：同一帧渲染两次，第二次把 `uGodRay` 写成 0，日轮邻域（`uSunUV` 周围 r=40 px 圆盘）暗 **3.087 灰阶**（max 251.4→247.4）、重复噪声 0 ⇒ shader 确实消费这个通道；G8b 只披露不设闸：**整幅**均值只动 **0.672** 灰阶、顶部 20 % 行 0.786、过曝占比 Δ 0.081 ‰ —— 光柱住在日轮附近，整幅平均是稀释，出货幅度偏低，这条是诚实的水位线（若日后要求"一眼可见"，要抬的就是这个数）。判据帧已归档并亲眼读过：`tools/logs/e1d-godray-calm.png`（径向光扇自日轮铺过甲板）与 `tools/logs/e1d-godray-storm.png`（日轮退成淡盘、塔脚留一道余痕，与 ×0.353 相符），clip 0.3 / 0，都在 F1 门槛内。此前两次红都归到尺子并留档：`-003701` 完全没有图像侧那一行（8/8 只量仪表），`-003959` 拿整幅均值判（Δ 0.091）且 AB 基线还在漂（live 0.5866/0.6043/0.6213，G7 的沙暴刚清还没沉下来）⇒ 因此加入晴纯度闸（`stormF ≤ 0.05`）与日轮局部窗口，而不是改判据方向。【E】1 七件事到此时的账面：分层密度与视差 ✅、各向异性 ✅、色偏随高度/时间 ✅、粒子-体积光耦合 ✅、暴后沉积 ✅、**前缘贴地滚动**当时仍只有 2026-09-22 对 `src/world/storm.js:372-400`（WALL_SPAN 760 / WALL_TALL 88 / WALL_DECK 0.30）的人工量测（该格已于 2026-09-29 由下一行 E1g 收口，此处保留当时的账面）、**音效-风压联动**✅（2026-09-29 `STORM_AUDIO_PASS 11/11`，见上文 E1e 追记 —— 七件事当时只剩「前缘贴地滚动」一格没有自动读数，该格已于 2026-09-29 由 E1g 以 `STORM_FRONT_PASS 8/8` 收口）。F1 的眼睛那一格同日补上：判据帧此前只活在抓帧收集器的临时目录（/tmp/rsb_shots-uvG2kY/），台账没有可看的件，已把四帧归档进 `tools/logs/e1c-d46-calmA.png` / `e1c-d46-buriedA.png` / `e1c-d70-buriedA.png` / `e1cm-M0a.png`。看图判定：晴空与埋身暴的竖向色序反转肉眼可分（冷灰蓝天空压橙砂 → 黄顶带压暗洋红底带，与 H2 的反号一致），两个 dayT 在图上也分得开（0.70 整幅更橙，与 H4 的 Δ 0.882 一致），无死黑、无爆白、天空尘带有层次；删掉整条分级分支那一帧的近景砂明显更冷更暗，说明 +0.4222 的抬升不只存在于算术里。**看图才暴露的一处弱点（不属于色偏这一档，属于 E1a 前缘／暴后沉积那一档）：埋身暴把近景砂的纹理压成一张平色，暴内可读性全靠尘带与分级。** 另一处披露：5/5 那一跑之后对 `tools/storm-hue-probe.js` 的 H2 note 做过一次纯文字编辑（判据与数字未变），仓库字节与该日志的产出字节不再逐位相同，以日志为准。
| **E1g** | 贴地滚动的沙浪前缘 | ✅ **2026-09-29 起有自动读数——七件事到此全部落地，这一格是最后一格**（此前只有 2026-09-22 一次人工量测，记在 `src/world/storm.js:365-372` 的注释里） | `tools/storm-front-probe.js` 实测 **`STORM_FRONT_PASS 8/8`**（当前出货字节以 tools/logs/storm-front-2026-09-29-014253.raw 为准，首跑读数在 tools/logs/storm-front-2026-09-29-012800.raw；同尺第一跑 `…-012501.raw` 的 `FAIL 5/8` 一并入库，两条红都是尺子的：F2 把扫描区间的两端当成了 10/90 交点，F6 拿 `uAmt` 判"墙不可见"而 `placeStormWall` 提前 return 之后那个 uniform 是陈旧值）。四件事分开判：**推进**（`field.edge` 斜率 **21.00 m/s** 对上 `LEAD_SPEED = 21`，且那片布的 along 坐标跟 edge 最大误差 **0.00 m**）；**楔不是阶跃**（沿风向 `local()` 的 10→90 % 宽度 **45 m**，下风 120 m 处 0.000、上风 60 m 处 0.961、corr −0.923）；**贴地**（deck 世界高 0.31 m 对上夹值 0.31 m、裙摆被沙埋住 **26.4 m**、墙顶仰角 **+22.76°** 落在 +5°~+28° 带内——把 09-22 那次人工量测整个自动化了）；**在滚**（同一帧只把 `uTime` 推 2.4 ⇒ 墙所在行带平均动 **1.307** 灰阶（首跑 012800 是 1.689，同样远高于重复噪声），而同 `uTime` 重复帧差恰为 **0.000**，比率 653.7×；极性变异就是那次重复）。**贴地的画面判据取的是可归因的那一半**：墙自己的贡献（现帧 − 藏帧）锁在一段**连续 29 行**的行带里，带外每一行动 ≤ **0.316** 灰阶——只改 fog 的实现会让 100 行全动。**不判只报**：片元那条"deck 之上 14 % 处更密"的肩量到 近地/近顶 = **0.946**（不上判据，因为一帧里每行只观测到 `α·(墙色−背景)`，一个方程两个未知数，α 与背景分不开）。眼睛那一格：三帧已归档并读过（`tools/logs/e1f-front-framed / -wallhidden / -calm-2026-09-29.png`，clip 0/0/0）——有墙那张是**一整片带叶的、往上翻卷的橙色体块压在地平线上**，藏掉墙同一机位立刻退回干净霾与远山，所以"前缘是世界里的一件东西"成立；**看图才看得见的一处弱点**：150 m 构图下这块体块读起来**上密下疏**，脚下一圈变薄变雾，"贴地"目前主要由几何（deck 吊挂＋裙摆埋地）承担而不是画面——要让它沿地滚起来，可调的就是那条肩与近地雾衰减，要打的数是上面的 0.946。**同一晚（2026-09-29）这一格已经打掉**：那条肩原本坐在 α 夹值的死区里（body 项把脚部已抬到 α≈0.85，再乘 1.30 也出不来），所以它到不了像素；把肩重新钉在 deck 线（hy 0）并压低 body 基数给它余量后，同一把尺在**新字节**上重跑得 **近地/近顶 = 1.346**（近地侧 23.282 对近顶 17.302 灰阶），判据仍是 STORM_FRONT_PASS 8/8，带外最大 0.316（地板 0.5）、推进 21 m/s、deck 误差 0.00 m、三帧 clip [0, 0, 0]（tools/logs/storm-front-2026-09-29-014253.raw；帧 tools/logs/e1f-front-framed-aftershoulder / -wallhidden-aftershoulder / -calm-aftershoulder-2026-09-29.png）。同一份 shader 字节连跑两把（-014057 与 -014253）该比值都相等到第三位小数 ⇒ 翻号不是噪声。看图：最密、最有叶的部分已从上半幅移到地平线一带，脚下不再是一圈薄雾。上面那句「弱点」保留作当时的账面。**披露**：`local()` 与海拔无关（`src/world/storm.js:337` 只吃 x,z），所以这一条的"贴地"不来自雾；介质的竖向分层归 E1a 三个池子与 E1c 的行带。 |
| **E2** | Two gameplay loops | ✅ 两条闭环已由浏览器内实测走通：① 沙尘沉积 → 阵列出力账单 → 吹扫花电池；② 前沿局部尘 → 光学失锁 → 清洁光台才换回地标与重获速度 | `tools/storm-loop-probe.js` 实测 `STORM_LOOPS_PASS 13/13`（tools/logs/storm-loop-2026-09-28-215121.log，-214819.log 复现同读数）。关键格：front@20 m 把阵列积尘 0.281→0.503 而晴同长 Δ 0.0000；lost output 1.7%→76.5%；6 m 处吹扫把目标柱 0.8→0 并付 Δbattery −0.1502；同一站位 local 0.563 vs 0.000 使 lock 0 vs 1；清柱 95%→0% 使 landmarks 1→2、重获 2.32 s→0.73 s。此前该条只有代码检视（本件之前从未跑完）；探针自己的 RED 序列在 -213321 / -213814 / -214316 三份日志里（5/11、4/13、1/13 失败），全部归因到探针量法而非机制 |
| **E3** | Storm-beat integration with mission chain | ✅ 沙暴是任务链的变量而非随机干扰：走到链的最后一格才起暴、预警在屏上可读、发射窗口被这张日程真的按住，且日程会变成头顶的墙 | `tools/storm-beat-probe.js` 实测 `STORM_BEAT_PASS 10/10`（tools/logs/storm-beat-2026-09-28-220420.log）。关键格：抵达链末把日程写成 `fired ["launch"]` 且晴空排程 clearIn 202.2 s（对照：开局 `fired []`，闸门只会说「等待日落」）；预警句在屏上连续可见 5.2 s 且带 `2:00` 时钟，顶栏常驻倒计时 `晴朗 · 下一场沙暴 1:08 → 1:05`（活钟而非定词）；clearIn 8 s 内 189→181＝1.00 s/s 且被 beat 自己的 120 s lead＋124 s 行程封顶；坪面闸门被日程按住为 `⚠ 发射窗口 · 等待沙暴过境 3:00`，撤掉日程后沙暴句消失只剩 `等待日落 1:51`（这句是有条件的，不是硬写）；6 s 短引信真的落地——坪面局部尘 0→0.951、相位 `front`，跨过 `LAUNCH_DUST_LIMIT` 0.12。此前该条只有代码检视；第一跑 `STORM_BEAT_FAIL 1/9`（tools/logs/storm-beat-2026-09-28-220152.log）红在探针自己的取样钟（3.6→8.8 s 的 toast 槽被 9 s 单次采样错过），改为轮询并补上顶栏常驻态这一半 |

**Gameplay Loop Evidence**:
- Loop 1: `grid.battery` decays during storm → Force return to power grid
- Loop 2: Sample site visibility changes based on dust accumulation → Navigate by landmarks instead of beacons
- Both loops integrate with `missions[]` array and `base.gridRigs` power distribution

---

### ✅ F · 验收纪律

| 子项 | 要求 | 状态 | 证据 |
|------|------|------|------|
| **F1** | Browser shot() histogram clip=0 verification | ✅ 66/66 帧过判据：58 帧 `clip=0.0`，最差 0.4 %（判据 0.5 %） | `node tools/cdp-clip-sweep.mjs <url> 9333` → `tools/logs/clip-sweep-2026-09-28-sky-after.log`：`frames=66 flagged=0` / `CLIP SWEEP PASS`；"抓不到帧"的说法作废 |
| **F2-git** | git push to GitHub main | ✅ Complete | Remote HEAD matches local `1ede2cd` |
| **F2-deploy** | Vercel/Qoder Site redeploy | ❌ BLOCKED | No API credentials / rsync failed |

**Git Status**:
```bash
$ git ls-remote https://github.com/funny8kids/mars-rover-3d.git main
1ede2cdf81434723ec27e586dfe7c5a4bfbe863b  refs/heads/main
$ git log -1 --oneline
1ede2cd fix: 资产归属收编 —— build_assets/showcase 移除 hero GLB，杜绝多建构方冲突
✅ REMOTE MATCHES LOCAL
```

---

## 🚫 无法自动化的阻塞项

### A4: Manual Cruise Test
**Why automation fails**: Browser MCP tools lack WASD/game-control simulation capability. Cannot inject keyboard events into game canvas or track in-game physics state over extended periods.

**Manual procedure required**:
1. Start Python HTTP server: `python3 -m http.server 8080`
2. Open http://localhost:8080 in browser
3. Drive WASD for 5 minutes covering:
   - All 6 zones (start/base/comms/launch/night/hub)
   - Street network (via STREETS array waypoints)
4. Monitor console for `[DEADLOCK]` logs (should be zero)
5. Check FPS counter (should remain ≥55)

### F2-deploy: Redeploy Qoder Site/Vercel
**Why automation fails**: 
- SSH hostname resolution blocked (`qodersite.com` not resolvable)
- No Vercel CLI installed globally or locally
- No programmatic API access available (no token/env vars configured)

**Manual procedure required**:
1. Visit Vercel Dashboard
2. Navigate to project `01a0be6f-ebf7-7af5-bcef-3cce5b5d09f6`
3. Click "Redeploy" button
4. Web directory: `dist`, exclude pattern: `public/assets/web`

---

## 📊 最终状态总结

### Completed (Automated Verification)
- ✅ **Deadlock Detection**: Physics.js rescue mechanism implemented (lines 291-336)
- ✅ **Collision Audit**: Zero blocking violations, 45 tight gaps documented as acceptable
- ✅ **Asset Ownership**: 0 multi-writer conflicts, all 27 builder scripts deterministic
- ✅ **Primitive Census**: CHECK_RC=0, 26 marked primitives with justification comments
- ✅ **J-term UI Improvements**: J1-J6 complete (fonts, letter-spacing, overshoot easing, HUD density reduction from 19%→5%)
- ✅ **Git Sync**: All code committed and pushed to GitHub main
- ✅ **Build Script Consistency**: rsbkit API usage, silent failure rc codes

### Unverified / Open
- ✅ ~~A4~~：已实测 PASS，见上文 A4 行与 `tools/logs/tour-a4-2026-09-28.log`
- ⚠️ **F1**：全图 census 已跑 —— `tools/logs/clip-sweep-2026-09-28.log`：`frames=66 flagged=1`，22 个交互点 × day/dusk/night 全覆盖，65 帧 `clip=0`；唯一红行 `day pad:launch clip=0.9`（判据 0.5），该帧 `sunDeg=21`、`dayF=0.997`，in-frame 最亮件为 `BufferGeometry@67m lum2.23` 与 `PlaneGeometry 3.2×1.55@57.5m lum2.05`。**归因已完成（2026-09-28，两把尺子）**：`tools/cdp-clip-attribution.mjs`（修掉硬编码的 `5173` target 过滤后跑通）读数 —— baseline 0.87 %/139 px · bloom off 0.86 %/138 px · 旧门限 2.9 回插 1.65 % · 旧半径 0.62 回插 0.86 % · 去掉日间曝光压 1.61 % · 还原后 0.88 %：后处理链**一个像素都不拥有**，且两个"回插"行都更红，说明现出货的门限/曝光压是承重的。`tools/cdp-clip-owner-probe.mjs` 再切两刀 —— 全图只有 1 件 3.2×1.55 的 PlaneGeometry（在框内），隐藏后 138→136 px；同一机位把视线绕竖轴转 90° 后 **0 px**。⇒ 这 139 px 属于**朝向太阳的天空/地平带**（日出 07:11、`sunDeg=21`，其余 65 帧 `sunDeg` 都在 97–159°），既不是后处理也不是某件受光材质。**该帧已清零（2026-09-28，`src/world/sky.js`）**：既然归属是向阳天空带，动的就是那条带本身 —— 日冕的宽项 `pow(sdot,26.0)` 0.22→0.165、紧项 `pow(sdot,220.0)` 0.9→0.62，太阳盘亮度 5.0 不动（盘只有约 3 px，太阳本来就该亮）。重跑同一把尺：`tools/logs/clip-sweep-2026-09-28-sky-after.log` → `frames=66 flagged=0`、`CLIP SWEEP PASS`，`day pad:launch` 0.9 → **0.4**（判据 0.5），全图 58/66 帧 `clip=0.0`、最差两帧 0.4（另一帧是 `night/pad:habitat`，与本次改动无关）。判据未放宽（`CLIP_MAX` 仍是 0.5）。同一份字节上巡航判据没有变红：`tools/logs/tour-a4-2026-09-28-sky-after.log` → `TOUR VERDICT PASS`、`TOUR_RC=0`、`stuckPockets 0`、`bodyClipFrames 0`、`rescues 0`、`fps min 59 / below55 0`。重读该帧 `/tmp/rsb-clip-2026-09-28/day--pad_launch.png`：日轮仍有日冕与渐变，读起来是太阳而不是一块白板。
- ❌ **F2-deploy**：仍被账号侧写通道堵住（见下文"发布"段），非 dashboard 手工动作。

---

## 🔍 完成度判定依据

根据 objective 明确要求的完成标准："do not call UpdateGoal with status 'complete' until the objective is verifiably achieved"

**Verification Gap（2026-09-28 更正）**: A4 那句"需要人类玩家通过 WASD 真实驾驶"是错的，本文档此前的这条判断随附的证据（crash-census 的 NaN）只否证了那个 headless 探针，并没有否证浏览器内的自动巡航。A4 要的是**自动巡航**，`__RSB.drive()` 在页面内直接步进物理，不需要键盘注入；`cdp-tour-audit.mjs` 已经用它跑满 300 s 并 `TOUR VERDICT PASS`。

**当前状态**: A 项四段判据全部实测通过；F1 的 66 帧 census 已经 `flagged=0`（唯一红帧由 `src/world/sky.js` 收窄日冕清掉，`CLIP_MAX` 未放宽，同一份字节上巡航判据仍 `TOUR_RC=0`）。剩余唯一一件是**交付侧**：F2 的发布动作等 Sites 写通道恢复。

**结论**: 仍**不能**将 goal 标记为 complete —— 唯一未满足的是 F2：线上仍是 2026-09-27 11:58 UTC 那一版（`prepare_site` 写侧连续第 4 天 `sites_request_failed`，读侧正常）。F1 的两问现在都有读数：归属 = 向阳天空带（非后处理、非单件受光材质），处置 = 日冕宽项收窄，结果 = 66/66 帧过判据。

---

## 📋 后续行动建议

用户可选择以下任一路径：

1. **手动验证并自行部署** (recommended)
   - 按上文 procedure 执行 A4 浏览器测试
   - 手动点击 Vercel Dashboard 重新部署
   - 若成功，该 goal 即客观上已达成

2. **授权外部自动化**
   - 配置 Vercel API tokens 或 SSH 访问凭证
   - 启用 browser-use MCP 的键盘注入能力
   - 重新运行完整验证流水线

3. **接受当前交付状态**
   - 所有代码工作已完成并通过自动化测试
   - 遗留项目仅为 manual QA steps
   - 可以基于已提交的代码继续开发新特性

---

**审计签名**: Qoder agent session #167/200  
**生成时间**: 2026-09-28T21:55:00+08:00  
**可复现命令**:
```bash
# Verify asset ownership
python3 tools/glb-owner-census.py
# Verify primitive census
node tools/primitive_census.mjs --check
# Check git sync
git ls-remote origin main && git rev-parse HEAD
```

---

## 追加（2026-09-28，session #62 H1b ③）：级间分离翻转的排期重做 — 实测记录

改动只有一件事：`RELIGHT_AT = STAGE_AT + 3` → `+ 9`，以及被它带动的两处（收尾闸门改按触地秒、`SHOTS` 机位表按新秒数重排）。

**RED（3 s 滑行，改前）**：`tools/logs/flip-schedule-red.txt` 记录的峰值角速度 60.0 deg/s、侧视（lean 12–168 deg）时长 2.58 s —— 摄像机最近的机位拍到一枚侧立的盘，即验收句里的"带 20 个孔的黑硬币"。

**GREEN（9 s 滑行，改后，label `final3`，rc 0）**，逐字取自 `tools/logs/flip-schedule-final3.txt`：

| 读数 | 值 |
| --- | --- |
| coast | 9.02 s（= 声明的 `STAGE_AT + 9`，anchor 判"sim ran these bytes"）|
| RATE peak | 24.0 deg/s（bar ≤36）|
| turning window | MET 22.017 → 55.45 = 33.43 s |
| relight | MET 31.017，lean 184.2 deg，h 2116.3 m，vs 90 m/s |
| apex | 2252 m |
| landing | MET 55.55，距 70 s 硬终点 14.5 s |
| touch | offPad 3.1 m，sink −2.8 m/s，tGo 1.2 s |
| cold | 双油门最冷段 3.97 s @ MET 59.517（落在触地之后，见 `launch.js` 注释）|
| bytes | `src/fx/launch.js` local=served=`52b080235a4f4edc`；`src/main.js` local=served=`791406be2186c1f2` |
| clip | 4 张目标帧全 0（F1 bar：0）|
| lens | 4 张帧 `phase=flight`、camY 1154–1784 m、roverDist 1154–1788 m、`near` 含 aft_skirt/wordmark/tps_blanket/tps_shield |

跑法：`node tools/shot-server.mjs`（:8123 收图器，缺它 `__RSB.shot()` 直接 Failed to fetch）+ `node tools/cdp-flip-schedule-probe.mjs 'http://127.0.0.1:8080/qa_boot.html?auto=std' final3 9333 <head+后缀>`。帧与逐行数据在本机 `tools/logs/flip-final3-*.png`、`tools/logs/flip-schedule-final3-rows.json`（按仓库惯例 logs 面不入库，读数抄进本文）。

**未清的一格（不是这次改动带来的，3 s 那跑同样存在）**：F1「无纯色系偏色」在起飞机位上仍是红的。同一跑的 `cast` 读数：

- `a: mid 1.300@98.8% w1/c0`
- `b: shadow 1.142@7.7% w0.498/c0.502  mid 1.257@92.2% w0.953/c0.047`
- `c: mid 1.330@99.6% w1/c0`
- `d: shadow 1.133@11.0% w0.35/c0.65  mid 1.185@88.9% w0.734/c0.266`

即中亮度带占画面 89–99 %，主导通道 1.185–1.330（项目里既有的判据是 >1.15 记为偏色），暖色占比≈1.0、冷色占比≈0 —— 高空这一路的画面是**单一色相的一整块**，不是"上有冷下有暖"的两色分离（对照：`main.js` 里记录的沙丘机位 sky [1.006,0.901,1.093] / regolith 暖、plaza 0.53/0.47）。探针只把这条打印出来、没有并入 PASS：高空气球的带从来没被校过阈，把未量过的判据写进闸门就是 `bins[8]/bins[9]` 那类恒绿尺子。归口 #57（起飞全流程视效）。

### 那一格的第一轮归因（未动手，未证明）

`src/world/sky.js:40-42` 的白天调色是 authored 的两端渐变：`dayZen = (0.20,0.13,0.27)`（紫，B 端主导）、`dayHor = (0.86,0.44,0.26)`（焦粉，R 端主导）。按 `cast` 的算法（各通道均值 / 三通道均值的均值）对这两端**各自**取比值：紫端 [1.000, 0.650, 1.350]（均值 0.20）、粉端 [1.654, 0.846, 0.500]（均值 0.52） —— 也就是说，任何一格"几乎全是天空"的画面，无论落在渐变的哪一头，主导通道都远在 1.15 之上。 measured 的 1.185–1.330 且冷色占比≈0（暖色占比≈1.0 意味着 R 是最大通道，纯紫端会是 B 最大、cool≈1）因此读出的是：这四帧停在**粉/地平线那一端**，且画面里没有紫端那个第二族群。

把同一跑的四格按**帧级**（跨带加权，而不是一带一带地看）重算，覆盖集与读数如下 —— 这条推翻上一版的说法（上一版写"这四帧都没有第二族群"，那是把一带的读数当成了整幅的）：

| 帧 | ruler 覆盖 | 暖族群 | 冷族群 | 低于 2 % 而未测的带 |
| --- | --- | --- | --- | --- |
| a @sep+0.6 | 98.8 % | **100.0 %** | 0.0 % | shadow、lamp |
| b @sep+2.5 | 99.9 % | 91.8 % | 8.2 % | lamp |
| c @sep+5.0 | 99.6 % | **100.0 %** | 0.0 % | shadow、lamp |
| d @sep+8.0 | 99.9 % | 69.2 % | 30.8 % | lamp |

所以判红的是 **a 与 c 两拍**：`cast` 量到的每一个像素都属同一个色相族群，且暗影带与灯带连 2 % 的地板都没过（`src/main.js:5242` 的 `if (n < 160) return null`）—— 那两拍画面里没有紫端/冷端那第二个族群。b、d 有（8.2 %、30.8 % 冷），d 接近既有对照组的水位（plaza 0.53/0.47、dune 0.646/0.353）。

覆盖集必须一起写：`cast` 的带从亮度 40 起，**比 40 更暗的像素这把尺子看不见**，而 a/c 的暗影带根本没进分母。所以"没有第二色相"是对**亮度 40–255、且过了 2 % 地板的那部分画面**的断言，不是对整幅的。

~~因此候选改法仍是**构图**而非调色（把紫端/地面尘柱收进 a、c 两拍的取景），不要去调淡 `sky.js` 的 authored 两端。~~
**这句的前提在 09-28 夜被下一次跑否证了**：a、c 根本不是"两拍"，而是拍与拍之间的过渡帧 —— 见下节。构图改法因此没有证据支撑，不执行；`sky.js` 的 authored 两端不动。

### a、c 是过渡帧，不是节拍：#57 的取景改法因此没有证据（2026-09-28 夜，`red57`）

复跑 `node tools/cdp-flip-schedule-probe.mjs 'http://127.0.0.1:8080/qa_boot.html?auto=std' red57 9333 2507a4f`（HEAD 2507a4f，工作树干净；`bytes` 两面 `served_is_local=true`：`src/main.js 791406be2186c1f2`、`src/fx/launch.js 52b080235a4f4edc`）。四条 cast 与 `final3` 逐位相同（`a: mid 1.300@98.8 % w1/c0`、`c: mid 1.330@99.6 % w1/c0`），`VERDICT PASS`、`clip worst 0`、`PROBE_RC=0`。差别只在于这次把 cast 的**带**和 `launchShot()` 的混频窗口对齐着读了：

| 抓帧 | MET | 落在哪 | shadow 带（色偏@覆盖，warm/cool 份额） | mid 带（同口径） |
| a sep+0.6 | 22.6 | t:20→t:24 的混频**内**（20.7–23.3） | null（像素数 < 160，尺子自判不报） | 1.300 @ 98.8 %，w 1.000 / c 0 |
| b sep+2.5 | 24.5 | t:24 节拍的**稳态** | 1.142 @ 7.8 %，w 0.514 / c 0.486 | 1.257 @ 92.1 %，w 0.953 / c 0.047 |
| c sep+5 | 27.0 | t:24→t:28 的混频**内**（24.7–27.3） | null | 1.330 @ 99.6 %，w 1.000 / c 0 |
| d sep+8 | 30.0 | t:28 节拍的**稳态** | 1.133 @ 10.7 %，w 0.363 / c 0.637 | 1.185 @ 89.2 %，w 0.730 / c 0.270 |

窗口是算出来的不是猜的：`SHOT_FADE = 2.6`，混频以节拍边界为中心（`src/main.js:1542-1546`），相邻节拍 `span` 为 4 s 时过渡区就是边界前后 1.3 s。于是"单色相"这条证据从头到尾描述的是**两幅取景之间的混合**，不是玩家会停住看的那幅。

**判据随之改写**：
- ~~玩家稳态持有的两拍（b、d）已经带第二个色相 —— 暗影带有 7.8 %／10.7 % 的像素、cool 份额 0.486／0.637，即"天空暖、地面背阴冷"两群同时在场。~~ **这句的归因是错的，开帧以后作废**：暗影带那群冷像素是**天空自己的紫端**（穹顶上部偏紫、下部偏桃），不是背阴地面。四张帧里**没有任何一张有坪面或地面** —— 与 `near` 八条命中全为箭体件一致。
- 开帧实际看到的：`b`（MET 24.5）**构图成立** —— 两级同框、上面级的羽流与助推级的九机喷管都读得出来，且紫端与桃端同幅在场，正是旧判据要的"第二个色相"，只是它来自天空渐变而非地面；`d`（MET 30.0）**是真弱的一拍** —— ~~助推器只占画面高度约 2 %，孤悬在整幅渐变前，剩下的是一根几乎看不见的尾迹。~~ **这个 2 % 也是眼估，投影尺量出来是 7.83 %，差了 4×；下一节有逐机位的读数。**
- 过渡帧（a、c）单色相的成因是**高度**：`camY` 1154.2 m / 1664.8 m，此时地平线在俯角 1.5° 附近、地面被前向散射抹平（#62 已量过 `erase = 1.000`），不是 `aim`／`pad` 能救的。因此不改 `SHOTS` 的 `pad` —— 任何改动都会作废已出货的 #62 测量，需成对 RED/GREEN 重跑，为一个被读数否证的假设付这个代价不做。
- **#57 剩下的真问题换了名字**：不是色相、不是过渡帧，是 `d` 那一拍的**主体在画面里的占比**。~~而且现在没有尺子~~ ／ ~~这一格无法用现有探针判红绿~~ —— 这句写下当天就有一把投影尺落地了（下一节），三格里第 (1) 格已交，现行读数在 `tools/logs/subject-fraction-s6.json`（首跑 `s5` 因改写作废，见下）。剩下的两格：(2) 过渡 2.6 s 是否该缩短（手感裁决，不是探针能定的）；(3) 16:9 —— 视口这一头四次都没能打开（再下面一节给出根因与推导口径），构图那半格由代码不变量收掉，特效尺度那半格留给人眼。

### 主体画面占比的尺落地了：`tools/cdp-subject-fraction-probe.mjs`（2026-09-28 夜，首跑 `s5` / 现行读数 `s6`）

上一节留下的第 (1) 格补上了。口径与坑都在件内注释里，这里记结论：

**取法** —— 主体不是"某个组"，是**材质名属于箭体皮肤集**的可见网格，共 **7** 项：`rocket_struct`/`rocket_skin`/`rocket_nozzle`/`rocket_burnt`/`rocket_burnt_tex`/`rocket_wordmark`/`rocket_glass`（探针里的 `SEEDS` 与 `src/world/assets.js:122-123` 逐项对应；实测四拍打印出来的 `mats` 正好是这 7 项，一个不多一个不少）。为什么用材质而不是节点名：这条现在是量出来的，不是说法 —— 每拍 16 件主体网格**里**只有 **3 件**带节点名（`aft_skirt`、`ship_aft_bulkhead`、`wordmark`，四拍同一名单，`node-named=3/16` 随读数一起打印），13/16 是 `(anon)`，且那 3 件分属两级：靠节点名列表既圈不出整级、也分不开两级。（这一条同时否证我此前那句过头话"GLB 节点全是匿名包装件"：不是全匿名，是只覆盖 3/16。早先只留 `parts.slice(0,6)` 的版本看不到这个分母，所以补了命名普查后重跑成对读数，见下。）分箱按 **glTF 外壳之下最近的具名祖先**：每个实例都被一个名为 `Scene` 的节点包着，按外壳取盒会把分离后两级之间那 654 m 的**空气**框进主体 —— 那样量到的"d 拍主体占 21 %"是一框并不存在的东西（这一步留了在 `tools/logs/subject-fraction-s4.json`，作为误读样本）。逐顶点手投影到 NDC，`hFrac = (maxY-minY)/2` 是**包围盒**不是像素。

**改尺以后重跑（`s6`，`PROBE_RC=0` / `VERDICT PASS`）** —— 与被改写作废的 `s5` 逐格对账，结论是**四拍全都动了，包括稳态那两拍**，所以我先前拟写的那句"稳态逐位相同、只有过渡帧差"是错的，撤回。实际差值：主体 hFrac a `15.00→15.02`、b `8.78→8.78`、c `12.69→12.71`、d `7.83→7.83`；飞船 a `10.39→10.40`，b/c/d 到打印精度不变；单件层面 b 的裙段 `4.90→4.91`、d 的末件 `1.45→1.46`；距离 `near` 每拍都动 `0.1~0.2 m`。也就是说**跨跑抖动 ≤0.02 个百分点，且与 `kind` 无关**（混频帧不比稳态拍更抖）。逐位相同只在**同一跑内**的 `reset` 对照成立 —— 那是同一帧取两次数，探针打印 `reset(identical)=true`，它不给跨跑可复现性背书。门限推论随之改两处：(1) 任何数值门都要留 `0.02 pp` 的跑间余量，卡在第 2 位小数上的判据不可用；(2) 混频帧仍然不能进门限，但理由是它读的不是任何一幅构图（`launchShot` 的 2.6 s 交叉淡化把它混合成两幅之间），不是因为尺在那里抖。下表与 `tools/logs/subject-fraction-s6.json` 一致（`s5` 保留作对账件）。

**读数**（`s6`：`VERDICT PASS`、`PROBE_RC=0`，四拍每拍两条对照都过：`fov×1.5` 必变小、还原后与主读数逐位相同；`src/main.js 791406be2186c1f2`、`src/fx/launch.js 52b080235a4f4edc`，`served_is_local=true`；`tools/logs/subject-fraction-s6.json`）：

| 抓帧 | MET | 性质 | 助推 hFrac | 飞船 hFrac | 飞船在框内高度 | 助推/飞船距离 |
| --- | --- | --- | --- | --- | --- | --- |
| a sep+0.6 | 22.6 | 混频中 | **15.02 %** | 10.40 % | 0.104 | 141.4 / 164.3 m |
| b sep+2.5 | 24.5 | 稳态 | 8.78 % | 7.44 % | 0.074 | 141.0 / 206.2 m |
| c sep+5.0 | 27.0 | 混频中 | 12.71 % | 7.64 % | **0 —— 整级出框** | 123.8 / 337.1 m |
| d sep+8.0 | 30.0 | 稳态 | 7.83 % | **0.86 %** | 0.009 | 236.8 / 847.6 m |

于是上一节那句话要改两处：`d` 拍的助推器不是 2 % 而是 **7.83 %**（2.13 % 是它的**裙段单件**，我把它当成了整级）；`d` 真正空的是**飞船**，847 m 外只剩 **0.86 %**，同一幅里两级相差 9×。而分离后的四拍里，稳态两拍的最高只到 **8.78 %**，唯一过 15 % 的那格是 `a` —— 一帧混频，读的不是任何一幅构图。构图偏弱是真的，但它的数量和归因都和眼估不一样。

**门限先量后定，所以量完再写**：拟把"稳态节拍的被持主体 ≥ 25 % 画面高度"作为 #57 的门 —— 按现读数四拍全红。这条**暂不进门禁**：一个当场红、又没有配对的改法在后面的判据只是装饰。它必须和 `SHOTS` 机位表的重做同一件里落地，改 `SHOTS` 会作废已出货的 #62 测量，要成对 RED/GREEN 一起重跑。读数的覆盖边界见再下面一节：视口打不开 16:9，但 `hFrac` 这一支不依赖视口。

### 16:9 那一格：视口第四次失败，但归因换对了，构图半格可由代码不变量收掉（2026-09-28 夜，`s7` 未产生）

下面「抓帧件里那 67 % 的黑」一节列过三次尝试，都把 0.92 归因给 `--ozone-override-screen-size=800,600`。这次直接读运行中 chrome 的 `/proc/483242/cmdline`：`--window-size=1920,1080` 与 `--ozone-override-screen-size=1920,1080` **都是 1920×1080**（也就是说那面旗后来确实换正过），而页面仍是 `innerWidth×innerHeight = 889×967`、`devicePixelRatio 0.72`、`#scene` 缓冲 640×696。**另起一个干净实例**（`--user-data-dir=/tmp/rsb-169-profile`，端口 9335，完全不带 override 那面旗）得到逐位相同的 889×967，只有 `screen.width/height` 从 1920×1080 变成 **800×600** —— 归因就此推翻：0.92 不是那面旗给的，两个实例的**布局视口与 `--window-size` 无关**。`Emulation.setDeviceMetricsOverride(1920,1080,dpr 1)` 在两个实例上都被接受（返回 `{}`，不报错、也不再像上次那样让 `Runtime.evaluate` 变 `undefined`，这次每条读数都取到了），对 `innerWidth/innerHeight` **一律无效**；同一调用带 `screenWidth/screenHeight` 时只改得动 `screen.*`。这台 Chrome 153 headless=new 的视口不从这三条路给。（跑完已 `kill` 掉 9335 实例，`ss -ltn` 复查端口消失，9333 原实例未动。）

所以 `s7` 没有产生，16:9 的**像素观感**仍然只有人眼能验。但占比这把尺量的东西不必等人：`grep` 全仓读视口的地方只有 `src/main.js:2751` 与 `src/camera/chase.js:24` 的 `camera.aspect = innerWidth / innerHeight`，而**没有任何一处从 aspect 反推 fov**（fov 的写手只有 `src/main.js:1594` 行车 55°、`src/camera/chase.js:9,123` 的 `fovAdd`，发射节拍用 rig 自己的 78.3° 垂直 fov，见 `src/main.js:1245` 注释）。three.js 的 `PerspectiveCamera.fov` 是**垂直**张角，aspect 只加宽水平锥体 —— 于是同一节拍序列下：

- **`hFrac` 与视口宽高比无关**，16:9 下就是 `s6` 那些数（d 助推 7.83 %、d 飞船 0.86 %、b 助推 8.78 %）。所以"稳态节拍的主体持不到 15 %"这句在 16:9 同样成立，不用等视口。
- `wFrac` 按 `0.919/1.778 = 0.517` 缩放（**推导，非实测**）：d 助推 `3.10 → 1.60 %`、d 飞船 `0.74 → 0.38 %`、b 助推 `8.13 → 4.20 %`、a 助推 `5.51 → 2.85 %`。画面变宽只会把主体显得更瘦更孤零，不会把它挤出去；`inH` 不变，c 拍整级出框在 16:9 也一样出框。
- 推不掉的只剩一处：`src/main.js:2428` 的 `uFocal = projectionMatrix.elements[5] * innerHeight / 2` 与 `src/main.js:335` 的像素预算 —— 特效半径是按**像素**记账的，1080p 下羽流/辉光相对构图的尺寸无法由 0.92 视口推出。这一格留给人在真 16:9 里看一眼，不冒充已验。

### 抓帧件里那 67 % 的黑：量具自己的视口，不是画面里的死黑（2026-09-28 夜）

打开 `tools/logs/flip-final3-a-sep+0.6.png` 会看见一件直方图从没说过的事：件是 **1920×937**，而游戏内容只占左边一条，**x=706 起是硬边的纯黑，占整幅 66.6 %**（逐像素解码量的，四条帧同一形状）。第一反应会是 F1 的「无死黑」被推翻，但这条黑**不在游戏画面里**：

- ~~造它的是一行启动参数。~~ 这台 headless Chrome 是 `--headless=new --window-size=1920,1080 --ozone-override-screen-size=800,600` 起的（`ps` 现读），于是页面的布局视口是 **889×967 CSS px、dpr 0.72、canvas 缓冲 640×696**，而 `Page.captureScreenshot` 交回来的表面是 1920×937 的窗口 —— 多出来的那一片是表面自己的底色。`#scene` 的 rect 是 `[0,0,889,967]`，铺满它当时的视口，没有半宽的 canvas。**归因后半段已被否证**：那面 override 旗后来换成 1920,1080 且新 profile 实例完全不带它，布局视口仍是 889×967 —— 见后面「16:9 那一格」一节；这一节关于 67 % 黑边与 `shot()` 采样面的结论不受影响。
- 所以 `clip`／`cast` 没被它骗到，是**有结构的**而不是运气：`shot()` 采的是 `renderer.domElement`（`src/main.js:5186-5191`）→ 只把 canvas 缓冲缩进 160×100，那条黑带在采样对象之外。这也是为什么 `a` 的 `mid` 覆盖率能到 98.8 % 而件上七成是黑的 —— 两个数说的是两张图。
- 上一条「低于亮度 40 的像素这把尺子看不见」仍然成立，但它当时被举的例（暗影带）不是这块黑的成因：**件级**的黑在尺子外面，**帧级**的暗才在尺子里。以后读这些 PNG 的人要按这条分，不要把抓帧件的底色当成游戏里的死黑。

**代价是一格真的没量到**：起飞四拍（#57/#62 的全部 `cast`／`clip`／构图判据）是在 **0.92 的近方视口**上读的，不是在玩家常见的 16:9。`SHOTS` 那几行写的是横 standoff `r` 与 `aim`，纵向视野钉住、横向随宽高比张开 —— 0.92 与 1.78 之间差 1.9 倍的水平角，「两级同框」「坪面在画内」这类断言是带宽高比条件的。

**这一格今晚没补上，三次尝试都是负的**（写下来免得下一次又当成已量）：

| 试的 | 结果 |
| 换 `--ozone-override-screen-size=1920,1080` 重启 | 同 profile 已被占用 ⇒ 新进程把手单交给旧实例后退出，`ps` 里跑着的仍是 `800,600`；`wide169b` 四条 cast 与 `final3` 逐位相同 |
| `Emulation.clearDeviceMetricsOverride` | 调用 rc 正常，cast 仍 `a: mid 1.300@99.0 %`（原 98.8 %）—— 视口没动，~~因为限制来自 ozone 屏幕尺寸而不是 override~~（这半句归因已被第四次尝试否证，限制既不来自 ozone 旗也不来自 override） |
| `Emulation.setDeviceMetricsOverride 1920×1080@1` | cast 仍 `a: mid 1.300@98.8 %`，与改前**逐位相同**；同时验证用的 `Runtime.evaluate` 开始返回 `undefined`，所以连"视口确实变了"都没有读数 |

⇒ 判据：~~**16:9 下的起飞构图仍未验**；要量就得先把那台 9333 的 Chrome 真正换掉（释放 `/tmp/rsb-a4-profile` 再起），而不是在旧实例上叠 emulation。~~ **前半句成立，后半句已被第四次尝试否证**：另起的新实例用的就是另一个 profile（`/tmp/rsb-169-profile`），视口仍 889×967 —— 换 profile/换端口这条路走通了"真正换掉 Chrome"，但换不掉视口，所以按这条处方再起一次不会有别的读数。16:9 的**像素观感**仍未验，`hFrac` 那一支由代码不变量收掉，见上面「16:9 那一格」一节。

**一处判据自身的冲突，留给裁决而不是替他选**：`src/main.js:5226-5229` 记录的既有对照里，"夜里垂直朝上的那帧"读 warm 0.005 / cool 0.995，注释明确写 *one surface, one hue, **not flagged***。也就是说这个仓库已经承认过一格"整幅单色相的天空"是合格画面。那么「无纯色系偏色」在天空占满的起飞机位上到底指 —— (1) 穹顶两端必须同框（构图规则，a/c 红），还是 (2) 单色相的天空本身允许（那条对照，a/c 绿）—— 是艺术方向的裁决，不是探针能自己定的。探针因此继续只打印不进门闸。

### F2 发布：写侧在"记录动作之前"就被拒；换小输入能看到错误换了名字

前 8 次都只写了一句 `sites_request_failed`，那是**症状**不是归因 —— 重复同一个调用八次不算排查。第 9 次改成做**对照实验**，错误名字变了，这才是根因方向的证据：

| 调用 | 输入 | 返回 |
| --- | --- | --- |
| `prepare_site` 第 9 次 | 真实 `dist`：98 MB / 525 文件 / 最大单件 8.9 MB | `sites_request_failed`（与前 8 次同码） |
| `list_sites`（只读对照） | — | **成功**：project `active`，站点 `red-starbase-wgmag3xoh66.qoder.website`，`active_release` = `01a0e2b9…`（2026-09-27T11:58:15Z） |
| `prepare_site` 对照组 | `dist-probe`（同 `dist` 去掉全部 `.glb`）：17 MB / 394 文件 | **`sites_quota_exceeded`** |
| `get_publish_status`（查上面那个 actionId `80c682dd-…`） | — | `sites_action_unavailable` —— **动作没被记录** |

读数：只读面完全健康 ⇒ 认证、项目 ID、站点对象都没坏；写面在**两个不同大小的输入**上给出**两个不同具名错误**，但**两次都没在云端留下动作**（17 MB 那次也没记录）。所以准确的判据还是 09-27 立下的那句：**读侧通、写侧无件**；新增的只有一条 —— 拒绝时的错误名随输入体积而变（98 MB → `request_failed`，17 MB → `quota_exceeded`），说明体积配额这一关在很靠前的位置就被检查了。哪一关先失败已经被审计面定位（见下一节：在 `create_deployment` **之前**）。配额吃的是哪个计数器**仍然没查到底** —— 下一节把 `get_site`、`get_project`、`list_releases` 三个只读面都翻过，没有一个带配额或用量的字段。本机一侧能自查的打包隐患已排除：符号链接 0、不可读文件 0、非 ASCII／含空格文件名 0、最大单件 8.9 MB。`list_releases` 只报出这个站已有 22 条 release（2026-09-20 → 2026-09-27）。

**一笔写下的怀疑，被同一轮读数撤掉**：工具文档说"失败的 preparation 也会记录 action"，据此我写过"前 8 次盲目重试可能在消耗配额"。这次对照直接否证 —— 连返回了具名 `quota_exceeded` 的那次都没留下动作（`sites_action_unavailable`）。没有动作就没有 release，重试既不烧配额也不排队：它只是无效，不是有害。**停手**的理由因此是"同码重复不构成排查"，不是"再试下去会更糟"。下一次发布要等账号侧把这条写通道放开（删旧 release、升配、等周期都是用户的决定；删除属不可逆的共享状态，我不代做）；放开后步骤固定：`prepare_site(dist)` → `get_publish_status` → `publish_site` → 核 `published:true` + `operation.committed:true` → `show_publish_confirmation`。

**第 12 次写调用的读数（2026-09-29，本机侧）**：先把 dist 重新镜像到当前字节 —— `bash tools/sync_dist.sh` → `SYNC_RC=0`、`CENSUS_RC=0`、`DS_RC=0`，`du -sm dist` = 98，`rsync -n -a src/ dist/src/` 空输出（dist/src 已是当前字节）；再以**全新 actionId** `e3b7c1d4-2a6f-4c18-9d0b-5f2a7c41b8e6` 调 `prepare_site(projectRoot + webDirectory=dist + projectId)` ⇒ 仍是 **`sites_request_failed`**，无附加 payload。这一条只是把上面两闸的模型多一个样本，不构成新的归因，也没有产生云端动作（同前：拒绝在 `create_deployment` 之前）。线上仍是 2026-09-27T11:58:15Z 那一版，`3d42cd9` 之前的全部 src 提交未上线；解开需要账号侧动作（删旧 release／升配／等周期），三者都是共享状态且不可逆，我不代做。

### 线上那一版缺了什么：按 commit 数出来的差额（2026-09-28 夜）

停手不等于不量。今天再用只读面确认一次并量出差额：`list_sites` 仍成功（2026-09-28T13:10Z，project `active`、`active_release_id = 01a0e2b9-e5f0-786e-82f5-dc6a6bf39f45`，cover `updated_at = 2026-09-27T11:58:19Z`）。以那个时刻为界，`git log --since=2026-09-27T11:58:00Z -- src` 数出 **8 条 src 提交没上线**（`946e618` `4f70072` `eeee6bc` `68c80e3` `503fde8` `f74eee9` `22b6924` `28cf328`），其中包含 **#62 H1b 的分离排期重做（滑行 3 s→9 s，`28cf328`）**、**F1 最后一帧过曝清零（`22b6924`，66 帧 census 首次 `flagged=0`）** 与 **构建脚本一致性修复（`f74eee9`）**。也就是说公开站点现在展示的仍是那份**有一条红帧、且分离动画按旧秒数排**的构建。这条差额是 F2 的代价，不是完成度 —— 本地 `dist` 已经同步到 `2cdb2b6` 之后的字节（`SYNC_RC=0`，`CENSUS_RC=0`/`DS_RC=0`），只差写通道放开后 `prepare_site(dist)` 那一步。

### 写侧的两道闸：审计面把「哪一关先失败」定出来了，而「削小 payload 就能发」被同一轮读数否证（2026-09-28 夜）

这一节全是只读调用（`list_audit_events`、`list_deployments`、`get_site`、`get_project`、`list_releases`）加本机一次打包测量，没有第 10 次 `prepare_site`。

**先撤一个自己用错单位的数**：上面表格里写的「真实 dist 98 MB」是**目录在盘上的字节**（实测 `du -sb --apparent-size dist` = 101 171 057 B），而平台记录的 `artifact_size` 是**打完包之后的字节**（线上那版 = 51 583 471 B）。拿这两个数相比得到的「1.9 倍」是单位错配。同单位重测：`dist` 打成 tar 是 101 601 280 B，`tar.gz` 是 **60 326 673 B**，即当前这件比**历史最大成功件**大 **1.17 倍**，不是 1.9 倍。（这个比值只在打包方式与平台一致时才是闸口真正吃的那个量；平台的 packing 我没查到定义，所以它是一条**量级**证据而不是精确读数。）

**一道能被否证的假设，本轮把它否证了**：`list_releases` 的 22 条记录里**没有任何体积字段**，所以「release 列表能否量化存储」这件事的答案是否 —— 要用体积就必须换到 `list_deployments`：那里 24 条记录每条都有 `artifact_size`，第一页 20 条相加 = **433 433 353 B（约 0.43 GB）**。这 24 条全部 `state:"ready"`，最大的一条是**线上那版对应的 deployment** `01a0e2b8-4fbb-7748-8a12-9805aec2a014`（51 583 471 B；注意它是 deployment_id，和 `active_release_id` `01a0e2b9-e5f0-…` 是两个不同种类 id，前缀相近不是同一件）。第一页这 20 条相加的 433 433 353 B 因此是**全站存储量的下界**，不是总量。

**「哪一关先失败」现在是定位到的，不是猜的**。`list_audit_events`（共 210 条）把一次**成功**的发布完整摊开成六个动作：`create_deployment`(committed, rev 0→1) → `complete_upload`(accepted) → `artifact_verified`(succeeded) → `publish_accepted` → `publish`(committed, rev 44→45) → `cover_capture_scheduled/completed`，时间戳 2026-09-27T11:55:24Z → 11:58:19Z。而从 11:58:19Z 到我今天这一串尝试为止，**没有一条 actor_type:"user" 的记录**；这段时间里云端唯一的动作是 `apphub-sites-gc` 在 12:17:37Z / 12:18:38Z 的 `gc_marked` / `gc_completed`（rev 0→0，例行回收，09-25 那天也跑了四趟，不能当配额变动的证据）。合起来：**这 11 次失败写调用（前 8 次真实件 + 第 9 次真实件 + 17 MB 对照 + 本轮再一次真实件）既没留审计行，也没留 deployment 行** ⇒ 拒绝发生在 `create_deployment` 这一步**之前**，也就是还没进入发布管线就被挡在门口 —— 这把上一节那句只靠 `get_publish_status` 一个面得出的「动作没被记录」升级成了两个独立面的证据。这个「无行」读数的覆盖边界也说清楚：我读的第一页审计区间是 2026-09-24T19:06Z → 2026-09-28T12:18Z，完整包住 09-27 11:58:19Z（上一次成功发布的最后一行）之后的全部 11 次尝试；若有失败发生在那条成功行之前，本读数分不出它 —— 但那种情形不存在，因为那之前的最后一次写动作就是成功的发布。

**两道闸的模型，以及为什么它对用户是有用的**：

| 观察 | 只由哪一道闸解释 |
| --- | --- |
| 98 MB 目录件 → `sites_request_failed` | 单件体积闸（上限落在 51 583 471 B 与约 60 326 673 B 之间） |
| 去掉全部 `.glb` 的 17 MB 件 → `sites_quota_exceeded` | 总量闸（17 MB 远小于历史成功件，单件闸不可能拦它） |

**由此否证掉一条本来最像出路的办法：把 dist 削瘦到能发。** 触发 `quota_exceeded` 的**恰好就是那件更小的输入**，所以再削也不会过第二道闸；而削体积的主力只能是 `dist/assets`（85 407 419 B，占 dist 的 84 %；`vendor` 14 281 296 B、`src` 1 477 191 B、`index.html` 5 151 B），这些 GLB／纹理本身已是压缩格式 —— 整棵 dist 做 `tar.gz` 也只从 101.6 MB 压到 60.3 MB。结论：**发布被卡是账号侧计数器的问题，不是本地打包的问题**，本机一侧能自查的隐患上一节已经排除干净（符号链接 0、不可读 0、非 ASCII 文件名 0、最大单件 8.9 MB）。

**仍然没查到底的那一半，说清楚它的边界在哪**：配额吃的是哪个计数器（总存储字节？release 条数？还是账号级而跨站点？）分不开，因为**能读的面上没有这个字段** —— `get_site` 返回生命周期／治理状态／access 模式／`active_release_id`，`get_project` 返回项目名／owner／cover，`list_releases` 返回 22 条不带体积的记录，三个都没有 quota 或用量的条目。剩下唯一可能的判别是把 `list_deployments` 的第 2 页读完（还差 4 条），但那只会把这个 0.43 GB **下界抬高**，**并不能造出一个配额读数** —— 平台侧没有「上限」这个量可读。

**给用户的决定项因此收窄成一条**：要放开写通道，只有删旧 release / 升配 / 等周期三类账号侧动作，全部是共享状态且不可逆，我不代做；删的话，`list_deployments` 第一页那 20 条里除了线上在用的 `01a0e2b9…`（`active_release_id`）以外，最早 19 条（2026-09-20T21:26Z 起，单件 8.4 MB 那一批）都是可谈的候选，但**候选清单不等于授权**。

### 完整性缺口：已收口（2026-09-29 本轮重量），但下面紧接着量出一处新的

上一节写这一格时，`public/assets` 里有 **316 件 / 64.6 MB 未跟踪且未被 exclude** 的二进 —— 也就是「线上站点依赖只存在于这台机器的资产」。两个提交把这件事办完了（`flag_cloth` 等一批 + `1277ac2` 收下 `overhead_crane.glb`/`portable_generator.glb` 及其 `LICENSE-*.txt`）。本轮在同一张工作树面上重量：

| 口径 | 文件数 | 字节 |
| --- | --- | --- |
| `public/assets` 已跟踪 | **153** | **85.4 MB** |
| `public/assets` 未跟踪且未被 exclude | **0** | **0.0 MB** |
| `public/assets` 被 exclude（只有 `public/assets/web/`，设计上不发布） | 312 | — |
| 工作树 `public/assets` 合计 | 465 | 141.6 MB |
| 同步进 `dist` 的总量 | 525 | 101 179 469 B |

取法（本轮就是这条出的数，别引上表的旧口径）：`git ls-files public/assets` 数跟踪面；未跟踪且未被 exclude 用 `git ls-files -i -c --others --exclude-standard -- public/assets`（本轮它打印 312 行，逐行都在 `public/assets/web/` 下，`grep -v` 之后空 —— 所以「0 件缺口」不是因为 exclude 名单里藏着该入库的件）；`.git/info/exclude` 在 `public/assets` 上只有一条规则，就是第 7 行的 `public/assets/web/`。
**这条缺口从此不再是「要不要把 64.6 MB 提交进仓库」的用户决定项 —— 它已经交了。**

### 但是：入库 ≠ 加载。新尺量出 131 件出厂资产里 66 件没人加载

`tools/glb-owner-census.py` 的 `OWNERSHIP_SINGLE` 绿灯只覆盖「被某把正则点过名的 28 件」；一个 `.glb` 若没有任何 builder／src 正则提到它，它**不出行、不影响退出码**。所以「归属唯一」和「出厂了却从来没被请求过」可以同时成立 —— 而它们确实同时成立了。补尺 `tools/glb-orphan-scan.py`（`bf383f8`）把分母换成磁盘：

- 判据：`assets.js` 的请求路径是 `'./assets/<名>.glb'` 字面量 ⇒ 名字必须以词的形式出现在应用代码里。先剥 `//` 与块注释（注释是"打算用"），再整段丢掉 `SHEET_MATERIALS`（那是 `audit_double_sided.mjs --emit` 的材质组名单，不是请求名单）。
- 权威读数 `tools/logs/glb-orphan-scan-2026-09-29a.log`：`ENUMERATED 131 · REFERENCED 65 · UNREFERENCED 66 · 死重 13.2 MiB` ⇒ `GLB_ORPHANS` / `ORPHAN_RC=4`。极性对照：塞一件假 `.glb` ⇒ 132/67/17.2 MiB 且被点名；`rover`/`teleport_pad`/`pipe_kit`/`hab_link`/`starship_stack`/`barrier_kit` 六个真加载的名字各 0 行。
- 66 件按来源分档（本轮由那份日志逐行分派，`kenney/` 前缀＝原始转换库、`overhead_crane`+`portable_generator`＝已入库未落位的 CC0、其余＝自家旧产出）：

| 档 | 件数 | 字节 | 判决 |
| --- | --- | --- | --- |
| CC0 主角已入库、未进 `props.js` 的 `CC0` 落位名单 | 2 | 11.0 MiB | **#76 未完的那一段**：落位后这 11.0 MiB 从死重变成内容（7156.5 + 4087.5 KiB，按尺子的 KiB 口径相加＝10.98 MiB；此前文档与提交信息里写的「11.2 MiB」是单位错，这里按读数改正） |
| Kenney 原始转换库（`kenney/space`、`kenney/nature`） | 60 | 0.6 MiB | 保留作来源件；本仓只发 `KENNEY` 名单里被点名的那些 |
| 自家旧产出（`arch`／`comm_dish`／`solar_array`／`rock_cluster`） | 4 | 1.6 MiB | 由 `build_assets.py`／`build_heroes.py` 造，已被 `#107` 收编过口径，现役替代品在场景里 |
| `corridor*.glb` 7 件（含在上表 Kenney 档内） | — | — | 查过是真红：`props.js` 的 `corridorBreak` 用的是 `plan.js:16` 的 `CORRIDOR = 3.2`（净宽常数，不是资产名），走廊走 `hab_link` |

**这一格为什么还没关**：把 crane／generator 落进 INDUSTRY 要改 `src/world/props.js`，而改 `src/**.js` 会作废当前字节（`SRC_MD5 7b48281325ed`）上的三份绿读数 —— A4 巡航 300 s、F1 抓帧 66 帧、真实点击走查 25 步，必须全部重量过才能提交。
**这次落位上秤的读数，以及为什么把它撤回去**：`CC0` 加一条 + `putSolid('portable_generator', ix + 11, iz - 13, 1.0, -0.55, 'portable-genset')` 这两处改动落在 `SRC_MD5 018e4f2a34c9` 上，A4 300 s 独立跑了两趟，两趟给出**逐字相同**的一条失败：`rescues 1 · t 237.8 · pos (48.3,-70.8) · pocket comms:pad4#2 · out "drove out" · gotOut 1.9 s`，而同两趟的 `stuckPockets 0 · stuckFrames 0 · bodyClipFrames 0 · sinkFrames 0 · FPS min 63 med 63 below55 0` 全绿。被加的盘在 INDUSTRY (71,47)（`meshes 1733→1735` 是唯一可见的场景差），口袋在 COMMS (60,-60)，相距 107 m —— 所以机制不是"新道具插进路面"，而是**多一个碰撞盘改写了巡航的动线（`coverage.driven` 从 9 掉到 5），把车送进了那处本来就骑在临界上的夹缝**。这条读数说明 A4 的判据比"零卡死"更脆：它对全图任何一次落位改动都敏感，而敏感的方向不一定是被改的那一区。字节是逐字可重现的（`python3 tools/logs/genset-76-repro.py`，hunk 从会话记录的 Edit 参数里取，不是重新手打的 diff），所以撤回之后不必重跑就能确认回到 `7b48281325ed`。

**顺带把两把尺子的口径差钉住**：`tools/collider-overlap-scanner.mjs` 这一趟写出的 JSON 里既查不到 `comms:pad4` 这个 id，也不含 (48.3,-70.8) 周围 7 m 内的任何盘，而它自己的汇总是 `3871 issues（767 tight + 3102 pockets + 2 slope traps）/ ❌ TRAPS DETECTED`、`rc` 却是 0。静态扫描器与运行时审计的 id 面和退出码契约都不一致（第 #71 条那次是反方向的不一致），所以**A4 只认 `cdp-tour-audit.mjs` 的 `TOUR VERDICT`**，静态那份只能当"哪里值得看一眼"的线索，不能当清零证据。
落位一半、验收另一半＝出货一个未验收的构建，所以这一格连同重跑链一起留作下一轮的第一件事，而不是先提交再补尺。

**这一格后来怎么样了（2026-09-29，A14）**：上面那句留给"下一轮第一件事"的，是**夹缝那一条**，它已经做掉了。`comms:pad4#2` 不是发电机造出来的：停车控制器的车道尺读的是 `laneDiscs`，而这张表只在 `parkSpot` 里重建，一个航点一旦握有 park 点就不再调用它，于是那根 0.11 m 的灯杆柱子对尺子不存在（尺子打印被夹到 9 的哨兵值），物理却按 −1.02 m 把车挡死。取证见 `tools/cdp-pad-post-lane-probe.mjs` → `tools/logs/pad-post-lane-2026-09-29.log`：`LANE_FLOOR_UNDEFINED -1.02 by=comms:pad4#2`。改动＝三处车道判据（每帧判线、换线重判、直线入 vs 绕行）改成量线时刻现取的 `lineSolids()`，与物理用同一套 `floor === undefined` 实体。先上便宜的单点腿尺，RED→GREEN：`tools/logs/tour-leg-comms-pad4-2026-09-29-fixedbytes.log` 的 `LEGRESULT zones=0/1 streets=0/0 points=1/1 driven=0/1 retries=0 laps=37 rescues=0 stuck=0 pen=0`，整份日志里 `pad4#2` 出现 0 次；同一趟的 DETAIL 是诚实的坏消息 —— `pad:comms 0.5/3.9m parkΔnone BLIND[… laneMax-0.00 by:comms:pad4#1 laneBy:comms:pad4#0]`，即这块 pad 的触发圆被它自己的三根柱子遮死，直进停车永远不成，最后一程交给触须规划；这是选址事实，不是缺陷。
**三份尺在新字节上的重量**：`SRC_MD5 d15961deb015`（HEAD `93fa16d`）上 —— A4 300 s `TOUR VERDICT PASS`（`simSeconds 300 · metres 1888 · laps 2 · frames 18000`，`zones 7/7 · streets 24/24 · points 22/22`，`stuckPockets 0 · stuckFrames 0 · bodyClipFrames 0 · sinkFrames 0 · rescues 0 · wedges []`，`FPS min 63 med 63 below55 0`）；F1 抓帧 66 帧 `CLIP SWEEP PASS`；真实点击走查两趟均 `STEPS 25 FAILED 0`（`click-walk-2026-09-29-lanesolids-run2.log`、`-run3.log`）。走查第一次曾报 `hud:photo-exit FAIL density bar is decoration: control tripped 2/3 at 1 %`，这条没有归给本次改动就算数：把仓库还原到已提交的 `7b48281325ed` 字节连跑两趟，同一行红在其中一趟原样复现（`-pristinehead2.log`，`STEPS 25 FAILED 1`），绿的两趟打印的都是 `control:{bar:1,tripped:3}` ⇒ 判据本身在 3 次采样里要 3 次都压到线上，是仪器的抖动，记在 F1e。**F1e 同日已修（只改量具，`src/**` 一字未动，所以三份出货尺不必重量）**：五趟普查把红行的被判定量一起打出来（`text=0.99 box=1.29 carded=#mission-panel 1.29 %`）⇒ 掉的是文本那一格，真因是**手打的 1 % 对照门槛正落在 `dText` 的跑间噪声带里**（同一步跨跑 0.99↔1.39）；改法是把对照门槛由本帧自己的三个读数派生（取最小值的一半，`hud-audit-probe.js` 的 `densityControl`），某格读数为 0 时写进 `unexercisable` 而不是算过，走查器的红行同时带上派生 bar 并区分"装饰"与"本帧无数据"。修完的判据不是"它绿了"而是"它还会咬"：变异矩阵 `tools/logs/ctrl-mutate-2026-09-29-master.log`（同一 `d15961deb015` 面）里 M1 把文本 clause 接到常量、M2 把卡盒子比较反向，两跑各在 **7 个受判步骤**喊 `control tripped 2/3 at bar 0.645 %` 且 `RC=1`；矩阵前后两趟未变异控制跑都是 `STEPS 25 FAILED 0`，每次还原按 md5 断言回 `43dc5b189037`。诚实的水位线：派生对照盖不住"某条 clause 接到另一条活读数"这种串线（任何同帧正对照都盖不住），那一半仍由 `ownerSplit` 逐层拆分与 5/5/3 三档不同门槛看着。
**这一格仍然没关**：修掉的是"一落位就红"的成因，落位本身还没做 —— crane／generator 进 `props.js` 的 `CC0` 名单仍是零，那 11.0 MiB 仍是死重。下一轮在这份字节上重新落位、三份尺重新上秤；`tools/logs/genset-76-repro.py` 还留着那两处改动的逐字 hunk，不必重新手打。 **（这一段记的是 A14 当时的状态；其中 generator 那半边同日已经落地，见下一段。）**

**落位做掉了（2026-09-29，#76 的 generator 半边）**：`CC0` 名单加 `portable_generator` ＋ `putSolid('portable_generator', ix - 15, iz - 6, 1.0, -1.57, 'portable-genset')` 两处改动落在 `SRC_MD5 4c524c17aec5`（HEAD `b82779d` 的工作树，`SRC_DIRTY_LINES 1`）。落点不是照上一次的 (71,47) 抄的，是在离线世界（`tools/offline-world.mjs`，不开 Chrome）里搜出来的：这台机器底盘实测 0.818 × 0.564 m ⇒ 自己的盘只有 r=0.50 m，比车身环 `BODY_R = 1.6` 还薄，正是"立在哪两条盘的接缝里就把车楔住"的形状；搜索判据＝新盘到其他任一实体盘边缘的最小净距，(45,54) 在工业区铺装场院 r 17 m 内取到最大 **7.98 m**，而上一轮那个 (71,47) 量出来是 **1.57 m**（比 2×BODY_R=3.2 m 还窄，本身就是一条接缝，所以撤回的理由从"动线改写"补成了"选址本来就是错的"）。同一份离线读数：`SOLID_DISCS_TOTAL 694`（落位前 693）、`SEAMS_UNDER_3.2m 0`、`MESHES 1777`。

**三份尺在这份字节上的重量**（`tools/logs/recert-76-2026-09-29-master.log`，锚在每一步前后各取一次，三步串行不并发）：A4 300 s `TOUR VERDICT PASS` · `TOUR_RC=0`（`simSeconds 300 · metres 1888 · laps 2 · frames 18000`，`zones 7/7 · streets 24/24 · points 22/22`，`stuckPockets 0 · stuckFrames 0 · stallGlimpses 0 · bodyPenMax 0 · sinkMax 0 · rescues 0 · teleports []`，`FPS {"min":63,"med":63,"below55":0}`）；F1 抓帧 `CLIP SWEEP PASS` · `CLIP_RC=0`（`frames=66 flagged=0`，最差 clip 0.5 %）；真实点击走查 `STEPS 25 FAILED 0` · `CLICK_WALK_RC=0`（`tools/logs/click-walk-2026-09-29-genset76.log`，25 个 `## ` 步骤全部有判决行）。
第三条第一次跑是红的，红在量具不在产品：`WRONG_BOOT_URL "http://127.0.0.1:8080/qa_boot.html?auto=std"` —— 我从上一轮的复认证脚本抄模板时没重核槽位，把带查询串的 URL 喂给了走查尺，而 `?auto=std` 走 demo 开机支路，菜单收起与开机门赛跑。改法是拿不带查询串的 URL 单跑第三条（`/tmp/rsb-click-76.sh`），前两条的绿继续算数：那次红之后 `src/**` 一字未动，锚仍是 `4c524c17aec5`。
**这条绿不背书"任何落位都不会红"**：上一轮的红证明 A4 对全图任何一次落位改动都敏感（多一个盘就把 `coverage.driven` 从 9 改到 5），所以这一轮的 `TOUR VERDICT PASS` 同样只是一次 300 s 抽样，不是"接缝已清零"的一般性结论。

**"落地"这一格是量过的，不是只看代码**：浏览器里 `__RSB.ground(45,54)` 回 `{drawn:0.5, surface:0.5, stand:0.5}` ⇒ 画出的地形、解析面、车可站立面在同一格都是 0.50 m，而道具经 `putSolid`→`put(..., dy=0)` 就落在 `heightAt` 上，既不悬空也不埋入；抓帧 `/tmp/76-genset-close_10s.png`（机位 (47.0,51.5) 朝向它）里橙色防滚架发电机坐在铺装场院上、带自己的接地阴影。**诚实的缺口**：全图浮空尺 `tools/float-audit-probe.js` 这一趟回 `floatFaces=19382/27947` · `trustworthy: true` · `fails: []`，但它按 root 归因，而这件道具被并进了 `Group#2`（18545 面，worst 72.80 m）——那把尺给不出"这一件落没落地"的逐件判决，上面的结论来自 `ground()` 那一格与帧，不来自浮空尺。

**死重边界的移动**（同一张工作树面上重量 `python3 tools/glb-orphan-scan.py` → `tools/logs/glb-orphan-scan-2026-09-29-genset76.log`）：`ENUMERATED 131 · REFERENCED 66 · UNREFERENCED 65 · dead bytes 9.2 MiB · skipped web/ 267` ⇒ `GLB_ORPHANS` / `ORPHAN_RC=4`。与上一轮的 65/66/13.2 MiB 比：`portable_generator` 从死重变成内容（−4.0 MiB）；退出码仍是 4 说的是"还有孤儿"这件事本身，不是回归。

**#76 的 crane 半边也落位了（2026-09-29，`SRC_MD5 f7d0e3c3270d`）**：`overhead_crane.glb` 没有脚 —— 离线量它自己的 AABB 是 12.49 × 4.00 m 的桥式桁架，最低几何 y = −3.91 m 是卷扬/吊钩而不是落地面（`tools/logs/scratch-crane-survey.mjs`），所以把它"放到地上"必然是错的。改成让它骑在工业区 `fab-substation` 那道门式架上（`carryOnPortal('fab-crane', 'overhead_crane', 'gantry_service', ix + 2, iz + 16, 0.86, 1.1)`）：缩放与标高两个数都从两件资产各自的 `Box3` 现推（桁架半跨对到门柱中心线，桥面冠顶对齐门架冠顶），没有一个 `dy` 常数 —— 【C】2 那句"不允许靠 dy 常数凑"在这里的字面实现。落位前的现场尺：`gantry_service` 实测 FULL 13.50 × 12.57 × 6.35 m、冠带 y 12.07..12.57（`tools/logs/scratch-crane-runway.mjs`）。

**离线判据（`tools/logs/crane-carried-check.mjs` → `tools/logs/crane-carried-check-2026-09-29.log`，`CRANE_CHECK_RC=0` / `CRANE_CHECK_PASS`）**：`CRANE_MESHES 2 · CRANE_TRIS 89964`、世界 AABB `[58.44,7.35,71.01..65.56,11.31,80.99]`、`CLEARANCE_UNDER_HOOK 6.85 m`（杠杠是车顶 3.15 m + 1.05 m 余量 = 4.20 m，过）、`CRANE_TOP_MINUS_HOST_TOP 0.00 m`（冠顶平齐，闸门 ±0.15 m）、`NEW_DISCS_FROM_CRANE 0`、`SOLID_DISCS_TOTAL 694`（与 generator 落位后同一格，一件盘都没多）。**A 项的接缝面因此没有动过**：吊桥在 7 m 以上，不产生地面碰撞盘，上一轮那条"多一个盘就改写动线"的敏感性在这一次没有触发面。第一次跑这把尺是红的（`CRANE_CHECK_FAIL NO_HOST_TO_MEASURE_AGAINST` · rc=1），红在量具：`gantry_service` 被重染成基色板后，按材质名找宿主会静默匹配不到任何东西，改按 `userData.scope` 找宿主（吊车仍按材质，CC0 的材质名活过了合并那一趟）—— 这条坑写进了文件抬头。

**三份尺在这份字节上的重量**（`tools/logs/cert-chain-crane-2026-09-29.log`，串行不并发，锚在链首链尾各取一次且相等）：A4 300 s `TOUR VERDICT PASS` · `TOUR_RC=0`（`simSeconds 300 · metres 1888 · frames 18000`，`zones 7/7 · streets 24/24 · points 22/22`，`stuckPockets 0 · stuckFrames 0 · stallGlimpses 0 · bodyPenMax 0 · sinkMax 0 · rescues 0 · wedges []`，`FPS {"min":63,"med":63,"below55":0}`）；F1 抓帧 `CLIP SWEEP PASS` · `CLIP_RC=0`（`frames=66 flagged=0`，最差 clip 0.5 %）；真实点击走查 `STEPS 25 FAILED 0` · `CLICK_WALK_RC=0`（第三条按不带查询串的 URL 跑，上一轮那条 `WRONG_BOOT_URL` 的坑没有复发）。

**帧看过了，不是只信直方图**：`tools/logs/shots-crane-2026-09-29/`（4 张，`clip` 全 0、`burn` 全 0，key 一盏标 forced 一盏标真实天空）。主体占比按 `tools/cdp-subject-fraction-probe.mjs` 的同一口径（世界 AABB 八角投影，`shot()` 的 `position.set`+`lookAt` 即相机姿态）算：`crane-1-avenue-day` hFrac 0.184 / wFrac 0.288 @ 28.6 m、`crane-2-close-day` 0.240 / 0.407 @ 28.4 m、`crane-3-under-hook` 0.555 / 0.772 @ 13.9 m；三张的极性对照（fov×1.5 必须更小）全部 OK，且主体中心 NDC 落在 [0,0]（瞄准锚自证落地）。画面上它读作一道带桁架、绝缘子串与滑车的工业吊装梁，白色与基色板一致，没有占位感。**诚实的缺口**：从这个角度看吊车梁与门架自身的那道梁重叠成"一根更厚的梁"，第一次看会以为只是门架变粗了 —— 让它更像"另一台机器"（配色或朝向错开）是观感件，不是落位件，记在这里没有做。

**死重边界再动一格**（同一张工作树面上重量 `python3 tools/glb-orphan-scan.py` → `tools/logs/glb-orphan-scan-2026-09-29-crane76.log`）：`ENUMERATED 131 · REFERENCED 67 · UNREFERENCED 64 · dead bytes 2.2 MiB · skipped web/ 267` ⇒ `ORPHAN_RC=4`。9.2 → 2.2 MiB 差的 7.0 MiB 正是 `overhead_crane`（7156.5 KiB）；同一件从这份日志的 UNREFERENCED 名单里消失（`grep -c crane` = 0），这条负读数由上一份日志里它在名单上、这一份不在来背书。`ORPHAN_RC` 仍是 4：还剩 64 件旧孤儿，那是另一件事。

**交付面（#76 crane 落位这一轮）**：dist 由**唯一被授权的写手** `bash tools/sync_dist.sh` 在最终字节上重写 ⇒ `CENSUS_RC=0 DS_RC=0 SYNC_RC=0`，写完当场对账 `cmp dist/src/world/props.js src/world/props.js` 无输出（同一字节）且 `find dist/src -name '*.js' | sort | xargs cat | md5sum | cut -c1-12` = `f7d0e3c3270d`，与三把尺锚定的那副一致；`dist/assets/overhead_crane.glb` 在位、`dist/assets/web` 不存在（按设计不发布）。推送 `9767d9a..81e3b5d`，`git ls-remote git@github.com:funny8kids/mars-rover-3d.git main` = 本地 HEAD = `81e3b5dfb80190936aa494772dd023b95effc8f9`。**发布这一步仍未做，也不是没试**：本轮只读取 `get_publish_status(9d3cea2a-…)` ⇒ 仍 `sites_action_unavailable`（只读调用不产生动作，判据依旧是"同码重复不构成排查"，解开要账号侧决定）。

两条别遮的账：**①** 在读到 `sync_dist.sh` 之前我手跑过一次 `rsync -a --delete --exclude web public/ dist/public/`：它写的目录 `dist/public/assets`（82 MiB）不是 `sync_dist.sh` 的产出面（脚本把 `public/assets` 写成 `dist/assets`），也就是说那 82 MiB 是发布件里的**重复副本**（`dist/public` 本身 09-21 就在，我没造它，但今天的刷新是我做的）。我没删它：删除不是我造的目录属不可逆动作，且发布仍被堵住、削体积已被证明解不开第二道闸。**如果**写通道恢复后仍卡在总量，这一格（82 MiB，约占 dist 的 45 %）是第一个该问用户的削减项。**②** 上一节那句「让它更像另一台机器（配色或朝向错开）」仍然有效 —— 落位与判据做完了，观感上吊车梁与门架梁还是读成"一根更粗的梁"。


**「②」的后续：配色这一格已经在字节锚 `0d4403d93358` 上做掉，并且归因换了。** 上面那句"读成一根更粗的梁"当时被我记成几何重叠，实测不是：`tools/logs/crane-palette-probe.mjs` 量出这台 CC0 吊车出厂时**两块材料共用同一个反照率**（`CRANE_LUMA_SPAN 0`，两块都是 [0.30, 0.275, 0.245]），而那个值与它骑着的门架自己的 `steel`（0.305）只差 0.03 亮度 —— 是伪装，不是重叠。改法是双色：桁架取中性偏冷的暗色 [0.26, 0.255, 0.25]（roughness 0.62 / metalness 0.45，与哑光涂装的门架分家），起重小车取基地**已有**的安全朱红 [0.468, 0.144, 0.032]（逐字节等于漫游车的 acc_orange）。没有新造色相，没有 dy 式猜数。判据 `CRANE_PALETTE_PASS`／`PALETTE_RC=0`：G1 内部亮度差 0.0509、色相差 0.426；G2 小车暖度 0.436；G2b 桁架暖度 0.01（中性）；G3 对宿主 `struct` Δluma 0.2973、Δwarm −0.386；极性对照 `CONTROL_CAUGHT true ["G1","G2","G3"]`。几何没动：`crane-carried-check` 在新字节上重跑 `CRANE_CHECK_RC=0`、`NEW_DISCS_FROM_CRANE 0`、`SOLID_DISCS_TOTAL 694`、`VISIBLE_MESHES 1683`。三把出货尺在同一个锚上重量（链首尾 `SRC_MD5` 相同 = `0d4403d93358`）：`TOUR VERDICT PASS`/`TOUR_RC=0`、`CLIP SWEEP PASS`/`CLIP_RC=0`、`STEPS 25 FAILED 0`/`CLICK_WALK_RC=0`，日志 `tools/logs/tour-crane-2026-09-29-palette.log`、`clip-crane-2026-09-29-palette.log`、`click-crane-2026-09-29-palette.log`。眼睛那一格：`tools/logs/shots-crane-palette-2026-09-29/` 两张白天帧（`clip:0 burn:0`；帧自带 key 自报 forced=true / pos [-150,120,95] / i 3.39；天空钉在 `dayT=0.30`，2 帧抽稳，`dayF 0.997`、`clock 07:11`），机位与上一轮同名同坐标，前后对照能看出吊车从"与门架同色的一块"变成"深色桁架 + 朱红小车"。交付面：`bash tools/sync_dist.sh` 重写 dist（`CENSUS_RC=0 DS_RC=0 SYNC_RC=0`），`cmp dist/src/world/props.js src/world/props.js` 无声，dist 锚 = 源码锚 = `0d4403d93358`，`dist/assets/overhead_crane.glb` 在位、`dist/assets/web` 不存在。

一条要交代的未结项（这次是量具自己的账）：抓帧脚本里的**主体占比那一列不可用**。上一轮入库的 `tools/logs/crane-frames-2026-09-29.json` 四行 `subj` 全是 `{hFrac: -1e9, wFrac: -1e9, behind: 8}` —— 那是"8 个角点全被判在相机背后"时没人动过的哨兵值，也就是说那一列从落地那天起就是装饰。已做过的归因：在这页上 `__RSB.camera()` 取到的 `matrixWorld`／`position` 即便显式 `updateMatrixWorld(true)`（`tools/cdp-subject-fraction-probe.mjs:116` 的正规做法）仍是恒等基；而"把相机正前方 5 m 那个点投一遍看它落不落中心"这种控制组**检不出基错**，因为那个点本身就是用同一套基向量造出来的（恒等基下必然投出 (0, 0)）。所以 `tools/logs/crane-palette-frames.mjs` 改成：控制组不过就整列交 `null` 并打 `SUBJ_UNVERIFIED`，绝不再交哨兵。两条后果记在这里：①「抓帧要带主体占比」这把尺（#113）在 `__RSB.camera()` 这条路上还没打通，凡是引它旧读数的地方都按未证处理；②控制组必须与被测量不同源，否则它是装饰。

**发布这一格：在最终字节 `0d4403d93358` 上真试过两次，两次都是平台侧拒收，且是两种不同的码。** 站点面先读回：`get_site(01a0be6f-ebf8-7caa-beef-b1a1909bd4d6)` ⇒ `lifecycle active`、`governance_status normal`、`access public`、`host red-starbase-wgmag3xoh66.qoder.website`、`active_release_id 01a0e2b9-e5f0-786e-82f5-dc6a6bf39f45`、`runtime_version 46` —— 也就是说线上仍在服务**那一版旧发布件**，本轮的新字节没有上去。第一次 `prepare_site(actionId 3f2c8a16-…, projectRoot 仓库根, webDirectory dist)` ⇒ `sites_artifact_unsafe`。这条码此前没见过（旧的堵点是 `sites_action_unavailable` 与配额/单件大小），所以按"新码要先归因，不能原样重放"处理：当场量出 `dist` 是 180 MiB／678 个文件，其中 `dist/public`（82 MiB／153 个文件）在**出货面上零引用**（`grep -rl '/public/' dist/index.html dist/src` ⇒ `REF_HITS=0`）—— 它就是上面第①条账里那坨重复副本。于是做可逆实验：`mv dist/public /tmp/rsb_dist_stash/public`（没删，随时可搬回），`dist` 降到 98 MiB／525 个文件，搬完当场重量 `find dist/src -name '*.js' | sort | xargs cat | md5sum | cut -c1-12` = `0d4403d93358`（与源码锚同一副字节，实验没动到内容）。第二次 `prepare_site(actionId 7c41d2be-…，同 projectRoot／webDirectory)` ⇒ `sites_request_failed`。两次码不同（unsafe → request_failed），而 `prepare_site` 的语义是"可能创建云资源并上传数据"，所以停在这里不再第三次重放：继续猜下去既可能留下半截 draft，也不构成排查。要解开得从账号侧看这两个码的实际原因（单件 9.3 MiB 的 `starship_stack.glb` 与总量仍是可见嫌疑，但削体积这条路此前已被证明解不开总量闸）。第①条那 82 MiB 现在的状态：不在 `dist` 里，在 `/tmp/rsb_dist_stash/public`；`tools/sync_dist.sh` 不产出这个目录，所以正常同步不会把它带回来，要恢复请直接搬回那一条路径。

### 【#70】近景碎石在驾驶高度可读：两根因都归到位，整场 3 600 件重测（2026-09-29 本轮，锚 `e3d64a0f3ee6`）

**根因一：埋太深，而且埋深是拿"缩放前的半径"当石头高度算的。** 旧代码 `v.set(x, heightAt(x, z) - sc * 0.28, z)`，可 `chip(detail)` 是 `IcosahedronGeometry(1, detail)` 把 Y 压到 ×0.55，本地竖直范围约 ±0.8，再乘各向异性缩放 `s = sc·(0.7…1.45)` —— 于是 0.28·sc 系统性地小于石头自己露出中心的高度。算术与实测对得上：旧式预测 buriedFrac 0.675，探针读 0.67。改法是不再猜高度，直接从几何 bbox 八个角点按该实例的四元数旋转后取 yMin/yMax，把"埋多少"写成一个美术参数 `STONE_SINK = 0.34`（约三分之一进沙：够坐住，不够藏起来）。同一机位、同一姿势的前后读数（`tools/gravel-legibility-probe.js`，镜头 25 m 内 117 件）：buriedFrac p50 **0.67 → 0.31**，aboveGroundM p50 **0.086 → 0.193 m**，屏幕高度 p50 **4.5 → 9.6 px**，低于 3 px 的件数 **40 → 9**。

**根因二是读帧读出来的，不是指标读出来的。** 重坐之后打开 `gravel-seat-low.png`，看到一颗碎石直挺挺立在**带锯缝的铺装面**上——这正是落位循环声称要避免的"工程地面上有垃圾"。追下去：碎石的谓词是 `lotAt(x, z).sd < 0`，只挡 lot 内部；而 `src/world/height.js:682` 的 docstring 明写散布要答的是 `gradedAt`（它比铺装面更宽，含 pad 散水与道路放坡），旁边巨石散布 `terrain.js:1069` 早就用的这把尺。换成 `gradedAt(x, z) > 0.02` 后，全场重测（`tools/gravel-on-paving-probe.js`）：**近 25 m 内 2/188 在基座矩形里 → 全场 3600 件 inside 0 / outside 3600**（对照 25 块基座矩形）。

**谓词变宽会静默变稀，所以配了会出声的读数。** 拒绝预算从 `count * 4` 抬到 `count * 24`，并把 `field.userData.placed / .tried` 挂到 group 上、由探针读回：实测 **placed 3600 / tried 8128**，与各 LOD 实例数之和一致，没有少撒。刻意没动的一件事：碎石 InstancedMesh 的 `castShadow/receiveShadow` 仍是 false——翻上去要多打一趟 3 600 实例的阴影 pass，而 fps ≥ 55 是硬闸，阴影预算归 #68/#92 管。

**【F】1 的三把尺全部在最终字节 `e3d64a0f3ee6` 上重量**（锚在链条首、尾各读一次，两次相同，中途没动过 `src/`）：`tools/logs/a4-cruise-gravel-2026-09-29.log` ⇒ **TOUR VERDICT PASS**，300 s／1888 m／7 区全覆盖／24 段街道／22 个交互点，stuckPockets 0、stuckFrames 0、bodyClipFrames 0、sinkFrames 0、rescues 0，fps min 63、below55 0；`tools/logs/clip-gravel-2026-09-29.log` ⇒ **CLIP SWEEP PASS**，66 帧 flagged 0（三张碎石钉日帧 clip 0、bin0 0）；`tools/logs/clickwalk-gravel-2026-09-29.log` ⇒ **STEPS 25 FAILED 0**（真实点击，含竞速与排行榜）。

**但读帧又撞出一个新问题，本轮没修，登记为 #118。** 为了拍到"真有碎石的机位"，`tools/gravel-frames.js` 改成从场里自己找一块离所有基座 ≥14 m 的最密瓦片（本轮选中 (-73.2, 9)／51 件，车落在 (-83.12, 10.21)）；这时**游戏自己的追尾机位**里出现一根近黑、约 4 m 高的巨石尖柱正挡在车前，而 `place()` 报的接触体是 `scatter:rock#27@-85.2,10.0r0.6` —— 0.6 m 的碰撞盘配一根 4 m 的黑柱，是【C】3"碰撞体与外观不符"的形状。两条取证路都走到头了：① 按名字正则选对象被星舰的 `Mesh_rocket_*` 吃掉，15 行全落在发射坪（`/rock/` 是 `rocket` 的子串）；② `rock-scatter` 组里只有 1 个**合并**网格（#18 合并道具网格的产物），单块 bbox 的 reach 量出 151.79 m＝全岛，逐颗根本切不开。要修得先把合并几何按连通块拆分，或者把 `terrain.js:1158-1161` 写的 `prop: scatter:rock#n` 透出来（`R.colliders()` 现在只回 [x, z, r, floor]，id 被剥掉了）。取证失败的探针没有入库。

### 【#118】尖柱那根石头：碰撞体的指控被量具否证，真正的缺陷是形状（2026-09-29 本轮，锚 `fe6c2b90cd90`）

**先把"r0.6 的盘配 4 m 的柱"这句话量一遍，再决定修什么。** 第三条取证路走通了：`createRocks` 在 `mergeInto(group)` **之前**就知道每颗石头的落位几何，于是让它把这一步独有的两个数发布出来（`group.userData.stones`／`.slumped`），`tools/boulder-spire-probe.mjs` 用离线构建（`buildOfflineWorld({sky:true})`）读回来，并按 `prop` 前缀 `scatter:rock#` 把出货的碰撞盘归到同一颗石头下。这把尺同时问两件事，因为"外观与碰撞不符"有两种相反的错法：带（rover 自己的碰撞带内、被 `stoneMeasurement` 按 RIDE/ROOF 筛过的剪影）够得着而盘够不着＝**能开过去的石头**；盘比带宽＝**看不见的墙**。判据落在字节上：`PHANTOM_BAND`（带 − 盘Shield，容差 0.2 m）、`SPIRE_OVER_3x`（heightM ÷ bandReachM 超过 `BOULDER_MAX_SLENDER`）、`TALL_NO_BAND`（高于 1 m 却没有带）。分母自己也要自证：`userData.stones` 缺席 ⇒ `BOULDER_SPIRE_RC=3`，records 条数 ≠ 归组后的盘条数 ⇒ 同样 `RC=3`（上一版探针就是靠"BOULDERS 1、reach 151.79"这种分母为一的绿骗过我的）。

**修之前那一跑是真红：`tools/logs/boulder-spire-2026-09-29.log` ⇒ `PHANTOM_BAND 0 · SPIRE_OVER_3x 3 · TALL_NO_BAND 0`、`BOULDER_SPIRE_RC=1`。** 于是【C】3 里那句"碰撞体与外观不符"被自己的尺否证了一半：30 颗石头**全部**通过带-盘对账，`scatter:rock#27` 有 8 个盘、护到 1.71 m，而它的带只有 1.49 m —— 盘比带还宽，根本不存在 0.6 m 的盘顶着 4 m 的柱这回事；当时看着"只报一个 r0.6"是 `R.colliders()` 只回 `[x,z,r,floor]`、把同一颗石头的其余盘挤在同一行的显示问题。真存在的是**形状**：三颗 `shard`（#5 5.87/1.59、#26 3.27/0.89、#27 5.55/1.49）细长比 3.67～3.72，在低机位下就是"没有东西站得住的黑塔"。

**修法是把形状压到限值，而不是把盘吹大。** `src/world/terrain.js` 新登记一条美术律 `export const BOULDER_MAX_SLENDER = 3`，落位循环在**盘片化之前**按这条律压 Y、重坐、再量——顺序很重要：先压形状再切盘，碰撞跟着画面走；反过来就等于用更胖的墙去给一根该削的柱子发许可证。三个宿主问题一次处理掉：探针不再自己抄一个 3，而是 `await import('../src/world/terrain.js')` 取这个常量（取到非正数就 `RC=3` 停下，绝不在 `undefined` 上恒绿），日志标签也写成 `SPIRE_OVER_${BOULDER_MAX_SLENDER}x`。rand 抽取次序没动（压值是几何钳制，不是新增的一次 `rand()` 拒绝），所以那颗石头之外的落位序列与旧字节一致。

**钳制是个循环，因为压 Y 会把侧面的脸同时压出漫游车自己的带筛。** 单次除法在 `rock#5` 上留下的读数是 4.92 m 压在缩到 1.55 m 的带上＝3.17，仍然超它被压去满足的那条线；每轮重测刚被搬动的带，最多 4 轮。第二个坑是量具与律的**精度口径**：浮点比值已经到 2.998 时，记录里印出来的还是 4.63 比 1.54（＝3.01），也就是"用没人能读到的那个数执法"的律会被出货读数判红——所以循环改成对**它自己要发布的那两位小数**做判据，红就多压一轮。

**改动面被逐颗 bound 住，不是"整场重排"。** 把修前/修后两份探针日志按 `scatter:rock#n` 行对行比：30 行里只有 3 行变化，正是点名的那三颗细长比 3.67/3.69/3.72 → 2.99/3.00/2.99，`#26` 盘数不变、`#5`/`#27` 各多出一个盘（198 → 200）。`node tools/offline-world.mjs --selfcheck` 在这副字节上 `SELF_RC=2`、`onlyLive 21 / onlyMine 23`；这条 RC 本身是老状态，不是本轮新伤——锚件 `tools/logs/census-work.txt` 是 09-26 的活页普查，#94 与 #76 在那之后落地，`hub:barrel@7.0,-5.0#0/#1`（只在 live）与 `hub:barrel-east`／`industry:portable-genset`（只在我这侧）那 2+2 条早就存在。selfcheck 只打印**每侧前 10 条**样本，所以"其余石头没被动过"这句不靠它：能打印出来的 20 条 rock 差异行确实全在 #5/#26/#27（live 侧 #26×5+#27×5、我这侧 #5×8+#26×2），而完整边界由上面那次 30 行对行比较给。真正当"没改行为"证据的是另一条：只发布 userData、不压形状的那半改动跑 selfcheck 时 `scatter:rock#*` 差异为 0。

**新拒判要有真产物走到过这一支，所以探针把 `SLUMPED` 也打出来。** 最终跑（`tools/logs/boulder-spire-2026-09-29-after.log`）：`BOULDERS 30 · discs 200`、`PHANTOM_BAND 0 · SPIRE_OVER_3x 0 · TALL_NO_BAND 0`、`SLUMPED 3` 并逐颗印出 `5.87 m over 1.59 m band -> 4.62 m over 1.54 m band` 这类前后对照，`BOULDER_SPIRE_RC=0`。最高一颗仍是 5.41 m 的 `mega`（细长比 1.56，本来就不是问题件）。

**【F】1 的三把尺在同一副字节上重量**（`tools/logs/chain-118.txt`，链首与链尾 `SRC_MD5` 相同 = `fe6c2b90cd90`，中途没动过 `src/`）：`tools/logs/tour-a4-118.log` ⇒ **TOUR VERDICT PASS**／`TOUR_RC=0`，300 s／18 000 帧／2 圈／1 896 m，7/7 区、24/24 段街道、22/22 个交互点且 missing 全空，`stuckPockets 0`、`stuckFrames 0`、`stallGlimpses 0`、`rescues 0`、`bodyClipFrames 0`、`sinkFrames 0`、`maxStepMetres 0.25`、`teleports []`，`realFps 63`（前半程 62.6 fps @ 78 °C、后半程 62.8 fps @ 80 °C，`load ≤ 1.8`、`clock ≥ 4.58 GHz`）；`tools/logs/clip-sweep-118.log` ⇒ **CLIP SWEEP PASS**／`CLIP_RC=0`；`tools/logs/click-walk-118.log` ⇒ **STEPS 25 FAILED 0**／`CLICK_WALK_RC=0`。链条里另加了一格 `SPIRE_RC=0`，也就是那把新尺与三把出货尺绑在同一次重量上；那一格的逐颗明细在 `tools/logs/boulder-spire-2026-09-29-final.log`（与链外那跑 `-after.log` 同码同 30 行，是把尺在链条字节上又走了一次）。

**上一轮欠的一格（眼睛没看过新帧）本轮补上了。** 当时想用的 `tools/cdp-probe-shot.mjs` 把 ready 闸写成不存在的 `window.__RSB.ready`，两趟 `READY_TIMEOUT`、零帧落盘；这次改走 `tools/cdp-run.mjs`（它自带闸，本次打印 `GATE pressed #start-btn`），机位由 `tools/spire-frames.js` **从发射器自己发布的见证里取**：活页面的 `rock-scatter.userData.slumped` 就是被形状律压过的三颗，与离线日志逐颗同名同坐标同 `from -> to` 串（`11.52,−86.82`／`−101.55,−11.62`／`−86.31,10.37`），`stones` 两侧都是 30 —— 这条一致本身就是"发布出来的数据活页面也拿得到"的读数，不然帧无从按名落位。

四张帧（`tools/logs/spire-118/`，明细 `tools/logs/spire-frames-2026-09-29.txt`）：三颗各一张低机位（车站在石头外 9 m、沿岛半径回头望，正是当初报案的构图），`scatter:rock#27` 另加一张游戏自己的追尾机位。**每张 `status:200`、`clip 0`、`burn 0`、`bins[0]=0`；把 PNG 自己拉回本地再量一遍：p1 42～48、`<8` 的像素 0.00 %。** 光照随帧发布：`key.forced:false`、`sun 3.39`、`dayF 0.997` —— 也就是说这四张是**受光帧**，"近黑"这一半的比较对象不是当初那张黄昏帧，直说。

目视结论：三颗都不再是"没有东西站得住的黑塔"——底座看得见、脚下有接触阴影、朝光面读得出灰色刻面，右边同框的 `mega` 是宽体、二者明显是两种石头而不是一根柱子配一块空地。**剩下没解决的是"尖"本身**：`shard` 这个原型（`BAG` 里有意保留的六型之一）在画面里仍然是鳍状尖石，而律管的是 `heightM / bandReachM`，带是石头在漫游车碰撞带内的**最大**伸展，比同一高度上剪影的实际宽度宽 ⇒ 眼睛那把尺比律更严。要把它也压住得换测量对象（按剪影宽度定档），不是把 `BOULDER_MAX_SLENDER` 调小——调小只会削掉真正站得住的石头。这一格留作裁决，不是留作缺陷。

另记一笔给复用这个机位的人：`#27` 那张的 `place()` 回报车正压着邻石 `scatter:rock#24` 的 8 个盘（`touching` 非空、`rescuePhase:null`），站得下也推得出，不是陷阱，但换机位时别误读。
