# 验证与工程记录 · Verification Log

这份文档记录「怎么证明它真的能跑」，以及踩过的坑。仓库首页 [README](../README.md) 只留结论与截图，
细节、断言、数字都集中在这里。

所有证据都由 `tools/` 下的 CDP 无头脚本产出，不依赖人工点浏览器。

> 文中 `F:/tmp_rsb/auditN/`、`F:/tmp_rsb/soakN/` 是**开发机本机的证据目录**（抓帧 PNG + 完整日志），
> 体积大且与代码无关，没有随仓库分发。要复现，照下面「无头视觉验证」的命令跑一遍即可，
> 输出目录自己指定。仓库内随附的截图见 [`screenshots/`](screenshots/)。

---

## 无头视觉验证（tools/）

不依赖人工点浏览器即可拿到真实渲染帧与控制台报错：

```bash
node tools/shot-server.mjs                       # 可选：接收页面 POST 回来的截图
# 启动一个带独立 user-data-dir 的无头 Edge（SwiftShader 软渲染）：
#   msedge --headless=new --user-data-dir=F:\tmp_rsb\pcdp2 --remote-debugging-port=9333 \
#          --enable-unsafe-swiftshader --use-angle=swiftshader --window-size=1280,720
node tools/cdp-shot.mjs <url> <outPrefix> <marksCsv> [port]        # 按秒标记抓帧 + 打印异常
node tools/cdp-eval.mjs "<js expression>" [port]                   # 读取 window.__RSB 状态
node tools/cdp-phase-shot.mjs <url> <outPrefix> <pollExpr> <offsetsCsv> [port]
node tools/cdp-phase-eval.mjs <url> <pollExpr> <evalExpr> <offsetsCsv> [port]
node tools/cdp-probe-shot.mjs <url> <readyExpr> <actionExpr> <delaySecs> <outPng> [port]
                                                                   # 轮询到条件满足再抓帧，用于等事件而非等秒数
node tools/cdp-launch-frames.mjs <url> <outPrefix> <altitudesCsv> [settleSecs] [port]
                                                                   # 按指定海拔抓发射段
node tools/cdp-interaction-audit.mjs <url> <outDir> [port] [stepRegex]  # 逐步跑完整交互链，每步轮询断言条件成立再抓帧
node tools/cdp-drive-test.mjs <url> <outDir> [port] [deck|drift|crater|climb-out|soak]
                                                                   # 用 CDP `Input.dispatchKeyEvent` 按真键开车（可信事件，证明的就是玩家那条输入链路），
                                                                   # 每 350 ms 采样 pose()（真正画出来的高度）相对地表三角面的穿透、
                                                                   # pitch / roll / onFloor / grounded / trauma，并按状态条件退出而非按帧数
node tools/cdp-audio-audit.mjs <url> [port]                        # 读**已渲染**的音频：ctx.currentTime 是否推进、AnalyserNode 电平、
                                                                   # 引擎增益随速、风暴主低通、发射轰鸣峰值（需 `--autoplay-policy=no-user-gesture-required`）
# 页面内表达式类探针（不抓帧，只读代码真正写进去的数）也放 tools/，用 cdp-run 跑：
node tools/cdp-run.mjs <url|-> tools/storm-aniso-probe.js          # 沙暴「随风能见度各向异性」：固定视点只转风向，读 scene.fog.density
                                                                   # 第二个参数给 `-` 表示复用已开的页面；一次约 3 s（整条读数不需要渲染帧）
node tools/cdp-run.mjs <url|-> tools/storm-layer-probe.js          # 沙暴「分层密度与视差」：读三个粒子池里**每条活精灵**的分布，
                                                                   # 用置换零假设判「分层」这个词是否只是标签（详见文件头）；一次约 10–14 s
node tools/cdp-run.mjs "…qa_boot.html?auto=std&audstate=hud"   tools/hud-audit-probe.js   9333 90000 300000
                                                                   # 前端「bruno-simon 差距」DOM 侧：字号阶梯 / 字距 / 文本与面板覆盖率 /
                                                                   # 真实合成背景的 WCAG 对比度 + 怠速镜头构图；一次约 60 s
                                                                   # §2c 是**字体落位普查**：对每个文本节点比 scrollWidth/clientWidth（浏览器自己对
                                                                   # 「这串字放不放得下」的回答，overflow:visible 也成立），再用 Range.getClientRects
                                                                   # 逐行字面盒查两两**压字**；zh 与点过 #lang-btn 的 en 各一遍，
                                                                   # 配一条植入截断 + 一条同串双栈敏感性对照（详见文件内注释）
node tools/cdp-run.mjs "…qa_boot.html?auto=std&audstate=drive" tools/hud-audit-probe.js   9333 90000 300000
                                                                   # 同一条探针的加速侧：沿真实油门过程逐档读 fov / 距离 / 主体占高比 /
                                                                   # 地平线行号，并给出归因；一次约 150 s
                                                                   # 两趟分开是因为一次 Runtime.evaluate 只有一个帧预算（≈500 档步进帧就让 CDP 回 -32603）
node tools/ref-site-font-probe.mjs                                 # 规格侧对照尺：同一支函数跑 bruno-simon.com 线上 CSS 与 src/styles.css
                                                                   # （@font-face / 字体族 / 字号集 / 字号×字距配对 / 动效与过冲）；不需要浏览器
python3 tools/build_fonts.py                                       # 锻造自托管子集：从 Google 的可变字体抽界面真正用到的字面/字重，
                                                                   # 生成 src/fonts/*.woff2 + src/styles.css 的 FONTS 块 + LICENSES.md
python3 tools/build_fonts.py --check                               # 同一支函数只读校验：产物在不在、CSS 引的文件与磁盘上的文件是否一一对应，
                                                                   # 并且三条闸——缺文件 / 两份 @font-face 字节完全相同（= 同一串字节下载两次）/
                                                                   # --display·--sans·--mono 的第一族根本没发货 —— 任一命中即 RC=1
                                                                   # 清单口径：CSS 注释被剥掉（注释里的汉字永远不上屏；一条讲线盒的注释曾把
                                                                   # 凑叠多抓溢盒逐 七个字算成「界面会退回系统字面」而判红），JS 注释保留（偏保守，
                                                                   # 只会让子集多带几个字面，不可能假绿）。末尾还报**没被覆盖**的 63 个界面符号
                                                                   # 注意：FONTS 块顶部那行「缺的符号 N 个」是被写进 CSS 的读数，改完清单口径
                                                                   # 必须重跑不带 --check 的那条（--check 不落盘，读数会停在旧值：实测块里 64 / 实时 63）
node tools/cdp-run.mjs "…qa_boot.html?auto=std&audstate=hud" tools/wght-probe.js 9333 60000 240000
                                                                   # 「一个可变文件到底画不画得出多种字重」= 墨量，不是 CSS 声明：从 CSSOM 取族与
                                                                   # 字重区间，逐档 lo/mid/hi 先 await document.fonts.load(文本) 再数被点亮的像素；
                                                                   # 文本按族问加载器（拉丁串回 0 个人面才换汉字串），降级面只作诊断不作判据
node tools/cdp-run.mjs "…qa_boot.html?auto=std&audstate=hud" tools/lh-sweep-probe.js 9333 45000 180000
                                                                   # 改 line-height 之前先量它：同一档字号下逐档读 §2c 那把尺（scrollHeight − clientHeight），
                                                                   # 用它自己的读数选值，而不是猜第二个值（猜出来的 1.18 只把 +8 px 压到 +4 px）
```

> `cdp-run.mjs` 在 `Page.navigate` 之前会发 `Network.setCacheDisabled`。`http.server` 不发
> `Cache-Control`，Chrome 的**脚本缓存**会跨导航复用已编译的 ES 模块：改了 `src/` 再跑探针，可能跑的
> 还是上一版的字节、打印出一份一模一样的报告，读起来像「我的改动没生效」。`fetch(u,{cache:'reload'})`
> 只刷 HTTP 缓存、不刷脚本缓存，`await import()` 反而**绕过**脚本缓存因而不能当身份证明。探针报告里因此
> 会带上产出该分布的积分常数（`physics`），旧模块是看得见的、不是可信的。

> 抓帧脚本的两个坑（都踩过）：
> 1. **软渲染是慢动作**。主循环 `dt = min(0.05, 真实帧间隔)`，而 SwiftShader 只有 2–20 fps，所以墙上时间过 22 秒、仿真可能只走几秒。等「海拔 > 2000 m」这类条件必然超时——用 `cdp-launch-frames.mjs` 按海拔抓，而不是按秒。
> 2. 驱动箭体高度必须**每个渲染帧推进一小步**（`requestAnimationFrame`）。用 `setInterval` 直接改 `launch.y` 会跑在尾焰发射器前面——它只按游戏自己的 `dt` 沿扫过路径播种——烟柱就会断成一串珠子，照片骗人。

`?auto=<low|med|high|ultra>&demo=<warp|launch|storm|night>` 可跳过菜单直达指定演示。`window.__RSB` 暴露给脚本的钩子：
`state`（started / bootMs / pos / speed / fps / mission / launch / samples / leak / quality 快照）、`cam()` / `phys()` / `env()` / `post()` / `launchRef`、
`skipMissions()`、`startStorm()` / `startNight()`、`warp(x, z, face, search)`（把车放到 ±search 米内最平坦处并对准设施，`search=0` 精确落点；
  传送会给一个 `demoPin` 把车停在原地拍定妆照，**任何驾驶按键都会立刻解除它**，否则 `?demo=…` 进来的玩家会发现 `W` 是死的）、
`hold(true|false)`（模拟长按 `E`）、`photo(true|false)`、`sampleList()`、`nearby(r)`（镜头视锥内的高亮发光体，用于定位过曝源）、
`audio()`（WebAudio 快照：ctx 状态 / 主低通截止频率 / 电平 / 引擎增益，用于验证风暴闷音）、`audioCtx()`、`diag()`、
`los()`（发射塔 3 / 40 / 80 / 120 m 各点的屏幕投影，判断「有没有入画」不要靠肉眼猜）、
`ground(x, z)`（返回 `{drawn, surface, stand}`：网格着色高度、纯地形高度、含可行车平台的站立高度——证明车没有穿进设施里）、
`pick(px, py)`（屏幕点射线命中的物体名，用来确认画面里那个东西到底是什么）。

---

## 驾驶验收：不穿模 / 不翻车失控

「穿模」在这里有一个可测定义：`pose()` 返回的是**真正画出来的**网格原点，轮心恰好悬在它下方一个轮半径（`RIDE = 0.46`），所以只要这个原点低于地表三角面，车轮和底盘就切进沙里。
`cdp-drive-test.mjs` 每 350 ms 读一次 `pose().y − surfaceAt(x,z)`（`penS`）与 `− standHeight`（`penD`，含可行车平台），负值即穿透。姿态限位是 ±0.40 rad（≈23°）。

| 实测工况（`?auto=med`，可信按键事件） | 采样 | 最小 penS / penD | 峰值速度 | 最大 \|pitch\| \|roll\| | 最大 trauma |
| --- | --- | --- | --- | --- | --- |
| 修复前：从 170 m 坑底全油门爬壁 | 146 | **−0.31 / −0.31**（车身陷入沙面） | 14.4 m/s | 0.045 / 0.355 | 0.95（一直在震屏） |
| 修复后：同一工况 `climb-out` | 143 | **0.00 / 0.00** | 14.4 m/s（≈52 km/h 爬完 15° 坑壁） | 0.046 / 0.355 | **0.00** |
| 驶上 4.5 m 观礼台甲板 `deck` | 61 | 最小离地间隙 0.40 m（= 轮半径） | 13.0 m/s | 0.092 / 0.041 | 0.00 |
| 沙丘手刹漂移 `drift` | 52 | 0.46 / 0.46 | 13.8 m/s | 0.347 / 0.396（贴住限位，未越界） | 0.33 |
| 冲进陨石坑再自己开出来 `crater` | 65 | 0.46 / 0.46 | 15.2 m/s | 0.142 / 0.400 | 0.57 |
| **连续体验 `soak`**：同一页面会话里 13 段一镜到底（怠速沉降 → 3 组全油门＋急停 → 上观礼台 → 冲进陨石坑 → 爬出 → 穿越沙尘暴区 → 手刹漂移 → 倒车 → 多航向续驶到 300 s） | **859** | **0.00 / 0.00**（穿透样本 **0**） | 16.0 m/s | 0.307 / 0.240（越过 ±0.40 限位的样本 **0**） | 0.47（出现在风暴段，未饱和） |

`soak` 的结论是**脚本算出来的**，不是我看着日志说的：抓帧在 `F:/tmp_rsb/soak2/`，退出码 0，末行 `SOAK VERDICT PASS`，
跑在与交互链**同一个构建产物**上（`npm run preview` → `http://127.0.0.1:4173/`，`index-gNNNwTm4.js`）。
门槛写死在工具里——会话墙钟 ≥300 s（实测 **327.2 s**，用页面自己的 `performance.now()` 计）、穿透样本 0、
越过姿态限位样本 0、非有限坐标 0、油门按住却不动连续 >25 s、`Runtime.exceptionThrown` 计数 0（实测 **0**）。
唯一几次「油门按住但速度 <0.6」都是传送落地那一瞬，合计 3 个样本 ≈1.1 s；腾空样本占比 0.003。
这一轮也顺手回答了验收里「无严重 bug，可连续体验 5–10 分钟」那条——之前只有各 30–80 s 的分段用例，没有整段会话的数字。
（`fps` 中位数 20 是软渲染 `dt` 上限的地板值，不是真机帧率，见文末帧率说明。同一用例在修正灯光秀取景**之前**的产物上还跑过一次 `F:/tmp_rsb/soak1/`，792 样本 / 302.2 s，同样 PASS；两轮只差相机取景分支，物理路径相同。）

配套的地形侧证据（浏览器外直接算 250×250 段格网）：基地园区内坡度 >23° 的边 **5.65% → 0**，野外 **6.01% → 0.40%**，最陡 67° → 31°——所以「不翻车」不是靠限位硬挡出来的，而是任务路线上根本不存在超过限位的地形。
`climb-out` 用例专门验证陨石坑不是单向陷阱：坑底起步按住 W，11.8 m/s 越过对侧坑缘（退出条件 `z < 335` 达成）。

---

## 音效验收：读渲染出来的样本，而不是 AudioParam

之前那行「风暴闷音 20000 → 9596 Hz」是**弱证据**：无头浏览器没解锁 AudioContext 时 `ctx.state === 'suspended'`，`setTargetAtTime` 照样改参数、`AnalyserNode` 电平恒为 0，数字好看但一点声音都没出。
`cdp-audio-audit.mjs` 换成硬证据（浏览器需带 `--autoplay-policy=no-user-gesture-required` 启动）：

| 断言 | 实测 |
| --- | --- |
| 上下文真在渲染 | 2 s 墙上时间里 `ctx.currentTime` 推进 1.88 s |
| 引擎声随速变化 | 按住 W：电平峰值 0.488、引擎增益 0.05 → 0.190 随速度爬升 |
| 沙尘暴滤波 | 进风暴区主低通 20000 → **7676 Hz**，且期间电平仍 0.69–0.71（闷，但没静音） |
| 离开风暴 | `toggleWeather` 是**闭锁**的天气开关：只开出风暴区只消掉「局部项」，必须再切一次预报，之后低通回到 20000 Hz |
| 发射轰鸣 | 上升段电平峰值 0.746，为全程最高（盖过引擎与风） |

---

## 交互链审计已实测通过的项

桌面整链跑的是**构建产物**而不是 dev server：`npm run build` → `npm run preview` → `http://localhost:4173/?auto=med`，
用 `tools/cdp-interaction-audit.mjs` 逐步验证。最近一次（`dist/assets/index-gNNNwTm4.js`，含灯光秀取景修正）
整链抓帧在 `F:/tmp_rsb/audit15/`，退出码 0、**0 条 `Runtime.exceptionThrown`、0 条 FAIL、无 TIMEOUT**，
12 张帧覆盖每个断言，含全部音频断言；它之前还有两轮同样退出码 0 的整链（`audit13` 冷启动、`audit14` 清理死配置后），
差异只在冷/热启动耗时与事件推进速度；
`audit16` 在同一产物上补跑了三条当时**只读过代码、没有真断言**的验收项（集齐奖励、真按分享键、完赛写排行榜），
`audit17` 又把计时赛那一段用修正后的退出条件重跑了一次（见下表最后两行）。
移动端另跑一轮 `tools/cdp-touch-audit.mjs`（抓帧在 `F:/tmp_rsb/touch1/`）。

> **`audit17` / `audit18` 是「只有数据、没有画面」的两轮**：调试用的浏览器窗口在那之前被最小化了，
> `Page.captureScreenshot` 跟着真实窗口走，于是那两轮的帧全是 360×50 的窄条，不能当构图证据。
> 尝试用 `Browser.setWindowBounds` 复原时 CDP 回 `Browser window not found`，最小化的窗口无法从协议侧恢复，
> 所以这两轮只作为状态断言使用，构图证据仍是 `audit15` / `audit16` 的 500×450 帧。
> 工具里保留了这段 try/catch（失败只打 `WINDOW_WARN`），并新增 `leaderboard-close` 一步，避免下次再被弹层挡画面。

| 断言 | 实测（audit15，构建产物 `index-gNNNwTm4.js`） |
| --- | --- |
| 进入可交互 | `bootMs = 1204`（浏览器 profile 已热）。同一产物在全新 profile 的首次冷启动实测 `bootMs = 10042`（audit13）——SwiftShader 软渲染下这 10 秒几乎全是 250×250 段地形与全基地几何构建，不是下载（首包 gzip 169 kB）；冷热两种都仍在「10 秒内可交互」线上，真机 GPU 上几何构建更快，但这一条按边界所述未在真机复验 |
| 巡检发射台 | warp 后 `mission 0 → 1`（同一帧即读到），塔体入画 `a_m0_patrol.png` |
| 长按修漏 | 把车停在泄漏点**外圈 9 m**（`[215, -35]`，碰撞体半径 7 m 处）按住 E：9.2 s 墙钟后 `leak: true / mission 2`（audit13 冷启动下同一步是 14.6 s）。不靠「把相机埋进阀门里」作弊 |
| 采样 | 6 块样本坐标可枚举（`[-293,216] [-442,-126] [-45,506] [-257,-304] [-558,-220] [-175,347]`），第一块拾取后 `samples: 1`；发射前读到的终态是 `samples: 6` |
| 彩蛋 · Roadster | 直接轮询卡片**文字**：`隐藏彩蛋：午夜公路 \| hidden show`（0.5 s 内命中） |
| 彩蛋 · 夜晚灯光秀 | `startNight` + 停在发射台 90 m 内按住 E：0.5 s 轮询到 toast `✦ 星舰灯光秀开始`。`l_light_show.png` 里助推器段的多色光环、塔架桁架、台面青色洗光弧与星空同框——**这一帧是修正后才成立的**：之前同一站位抓出来车占满画面、121 m 的箭体完全出框（audit13/14 的帧就是这样），所以给灯光秀接上了发射段已有的取景通道（`chase.aim/aimW/raise`，`src/main.js`），镜头抬起对准 `sp.y + 46` 的发光段 |
| 拍照模式 | `hud opacity 0` / 拍照面板 `display block`，退出后恢复 `1` |
| 拍照 · 真的按「分享截图」 | audit16（同一产物补跑）：拍照态下 `document.getElementById('photo-share').click()` → 0.0 s 轮到 toast `✦ 已保存截图`，`navigator.canShare({files}) = true`。`shoot()` 先 `composer.render()` 再 `toDataURL`，所以拿到的是真画面而不是空缓冲；帧 `e2_photo_share.png` |
| 收集物集齐 → 奖励 | audit16：`sampleList()` 读到 6 个信标坐标，逐个 `warp(search=0)` 钉上去，**2.0 s** 内 `samples: 6 / remaining: 0 / mission: 3`，toast 换成 `▸ 任务链完成 — 发射窗口开启，返回观礼台`，HUD 任务行含 `6/6`——奖励就是发射窗口本身，且它是被真实接近触发（<4.2 m）而非 `skipMissions()`；帧 `c2_samples_complete.png` |
| 计时赛 | `raceHud: block`、`timer 00:02.4`；进入发射倒计时的同一帧读到 `raceHud: none`（高潮不被打断） |
| 完赛 → 本地排行榜 | audit16：按 `R` 起表后逐个 `warp` 到 5 个门心（门心 = 相邻 ZONES 的中点，`src/main.js`），**5.0 s 完赛**：toast `✦ 计时赛完成 00:05.0 — 已记入排行榜`、`localStorage.rsb_board` 存下 1 行（`bestMs 4971.4`）、HUD 自动收起；点 `#race-board-btn` 后弹层去掉 `hidden`，`#board-list` 渲染出 `漫游车 2026/9/20 — 00:05.0`。帧 `f2_time_trial_done.png` / `f3_leaderboard.png`。（这一轮 `POLL race-gate-run` 曾报 TIMEOUT：完赛那一帧 HUD 就隐藏了，只数 HUD 永远等不到 `5/5`——产品链路是对的，退出条件写错了，已改成同时接受完赛 toast） |
| ↑ 补跑（排序 / 跨刷新持久化 / 关闭按钮） | audit17 用修正后的退出条件重跑同一段：`POLL race-gate-run => OK in 2.6s`，**2.2 s 完赛**，`rsb_board` 变成 **2 行**且新成绩排在前面（`00:02.2` 在 `00:05.0` 之上）——上一轮那行是**另一次进程、刷新之后**留下的，所以这同时证明了排序与 localStorage 持久化；点 `#board-close` 后弹层重新带上 `hidden`（`POLL leaderboard-close => OK`）。audit16 里没关弹层，导致它后续的发射帧被居中的弹层挡住，所以**发射高潮的构图以 audit15 的帧为准** |
| 音频链路 | `ctx.state = running`，`audio-resume` 0.0 s 命中；静止时主低通 20000 Hz、电平 0.440、引擎增益 0.05 |
| 沙尘暴闷音 | 进风暴区主低通 20000 → **10732 Hz**（电平反而升到 0.603，闷而不哑），驶出后回到 19105 Hz。此时画面 `stormF` 读数只有 0.11——那是**全局预报项**，而音频/粒子用的是 `max(全局预报, 局部风暴区项 × 0.85)`（`src/main.js`），所以车在风暴区里就已经闷了；`i_storm_muffled.png` 可见体积雾 + 屏幕脏污 |
| 沙暴 · 随风能见度各向异性 | `tools/storm-aniso-probe.js`：**视点固定、只转风向**（0°/45°/90°/135°），读的是 `Environment.update()` 当帧真写进 `scene.fog.density` 的数（`src/world/environment.js` 里沿视线 40/110/220 m 采样的那一支），基线是同一次调用传 `viewDir=null`，也就是「没有这段代码」的世界。埋进沙暴里：顺风的轴线方向比横风方向清楚 **182 m vs 120 m**（半程可见距离 D50），最负的三行永远落在风的轴线上、随风一起转（旋转组 `corr` 0.984..0.992）；站在锋面前方：视线碰不到沙墙的那些行**恰好读到 0.0**（那里 coverage 结构为 0，不是噪声小），碰到的三行读到 +7..+10 → **350 m vs 595 m**。八组全绿。判据是 `proj<0`（尘柱在上风侧）＋`rangeRatio<0.8`＋旋转组相关＋前方组的结构零，**不再**用「信噪倍数」：埋在板内横风行本来就要读到 fingers 梯度，那个比值量的是噪声相位而不是条款（第一版就是这样，钉住相位后它在 buried/0 以 5.8× 变红，而同一次跑的 `corr` 是 0.992）。**闸门见过红**：文件头那条 sed 把视线采样删掉，8/8 判负、每一行 0.0 |
| 沙暴 · 分层密度与视差 | `tools/storm-layer-probe.js`：**不渲染任何帧**，`__RSB.stormStep(800)` 直接跑 `updateStorm` 13.3 s 的沙，然后 `stormLayers()` 逐条读出三个池里**每条活精灵**经过顶点/片元着色器同一套算术后的深度、大小、α 与屏幕扫过速度，再用**置换零假设**判「分层」是不是只是标签——把同样的样本随机重新分成同样大小的三组 400 次，看真实分组是否比任何一次重新发牌都更分离（`S = 三组中位数的极差 / 组内 IQR 均值`，另要求 `obs ≥ 3 × 最好的一次发牌`，因为 200 条样本足以让一个很弱的真差异也变得「随机做不到」）。判据是四条序（高度 / 精灵尺寸 / 顺风速度升序、屏幕扫过速度降序）＋每层顺风分量 ≥ 0.5 倍风速且「死速」占比 ≤ 50 %＋近层领扫＋盐跃层过半离地。**闸门见过两次红**，两条 sed 都写在工具文件头：M1 把贴地保留率改回每帧常数 → 落地层 72.3 % 趴在沙面上以 0.04 倍风速静止，而置换统计量**反而更大**（2.542 / 5.349），这正是「零假设不能当唯一闸门」的现场证据；M2 把三层种子压进同一条 2.5–5.5 m 的带 → 第一版判据放它过了，于是加了 3× 边界，重跑才判负。完整数字与修复前后的对照见 `tools/storm-layer-probe.js` 文件头；**以最新一次日志为准**，本次提交的实跑存 `/tmp/layer-green-final.raw`、`/tmp/layer-green-final2.raw`（两个全新页面逐位一致），红件在 `/tmp/layer-red1.raw`、`/tmp/layer-red2b.raw` |
| 发射链 | `idle → countdown → ignition → ascent → fly`，`launchY` 依次读到 100.5 → 1765.8 → **4902.6 m**，烟柱与箭体分别在 `k/g/h/j` 四帧入画 |
| 移动端触屏 | 触摸窗口内 `touchUiVisible: true`、`interButton: true`，自动降到 `quality: low`，`bootMs 16667`；点「油门」车速到 6.5 m/s（fps 27.9），点「交互」10.9 s 修好泄漏，toast 换行为「▸ 新任务：采集 6 块火星样本」；`t0_touch_hud.png` 确认速度表已移到右上、不与 2×2 按钮网格重叠 |
| 前端 bruno-simon 差距 | 结论与七条「现象 / 实测 / 对照事实 / 修法 / 判负标准」在 `docs/FRONTEND_BRUNO_SIMON_GAP.md`；这一行只登记尺子与红件。三把尺子：`node tools/cdp-run.mjs "http://127.0.0.1:5173/qa_boot.html?auto=std&audstate=hud" tools/hud-audit-probe.js 9333 90000 300000`（量**真渲染出来**的东西：DOM 字号/字距/覆盖/对比度普查 + 相机投影算术，~60 s）、同一命令换 `&audstate=drive`（沿真实加速过程逐档采镜头构图，~150 s；分两趟是因为一次 `Runtime.evaluate` 只有一个帧预算，约 500 档步进帧就让 CDP 回 `-32603`）、`node tools/ref-site-font-probe.mjs`（同一支函数跑参考站线上 CSS 与我们的 `src/styles.css`，量**作者写下的规格**）。实测：`document.fonts` 0 个 face，canvas 推进宽度反证 `--mono` 落到 DejaVu Sans Mono（657.97 px）、`--sans`/`.title` 落到 Noto Sans CJK SC（607.64 px）——即 `getComputedStyle().fontFamily` 回的名字全是自证（参考站 3 个 @font-face + Amatic SC 700 + Nunito `display=block`）；屏上阶梯 `{10:2,11:7,12:1,12.5:4,14:1,52:1}`（min 10 px、`under11 12.5 %`、`tracked15 43.8 %`、`textCoveragePct 9.1`、4 个盒子 `10.01 %`）；动效 15 条 transition / 5 组 keyframes / **0 条 cubic-bezier**、7 条 text-shadow（参考站 23 / 1 / 4 条 bezier 全部过冲 / 0）。**闸门见过红（M1）**：把 `src/camera/chase.js:74` 的 `speed * 0.42` 改成 `0`（锚点全仓唯一），drive 档的 14 帧 fov 阶梯**全部躺平在 60.0**、占比仍从 12.41 掉到 8.52 —— 说明这一档量的确实是游戏相机，而主体变小另有其因；还原后 `git diff` 空。修正后的归因由 `shareAttribution` 给出：加速时主体高度占比 −38.1 %，其中**后退 −31.5 %、开镜 −9.9 %**（`factorsInto 0.617` 对上实测比值 `opticsCheck 0.619`，`rulerControl` 两把独立尺 9.94 == 9.94），所以「fov 变宽被后退盖过」这种说法是错的，两条都在把车缩小；判负标准 `totalPctLost ≤ 15` 且 `top.horizonPct − atRest.horizonPct ≤ 2`。已证伪、不要重提的七条（含「对比度不够」「阶梯不够拉」「静态 fov 60° 是错的」）同样列在那份文档的表里 |

三处值得记下的坑（修好后结论才算数）：
彩蛋断言原本写的是 `textContent.length > 0`，那对上一帧残留的卡片恒为真；泄漏 warp 原本落在泄漏点正上方，
把跟车相机埋进了几何体里（真实玩家做不到）；灯光秀最初只有箭体高处一圈同色环——90 m 触发半径内 121 m 的
箭体根本进不全框，所以把大部分环挪到了助推器段并加了地面洗光圈，并在修正后**重新跑完整链**（audit15）而不是只补一帧。
三项现在都在 0.5 s（两个彩蛋）/ 9.2 s（修漏）内以正确构图通过。

> **音频断言必须在带 `--autoplay-policy=no-user-gesture-required` 的浏览器上跑**：默认策略下 AudioContext
> 停在 `suspended`，`POLL audio-resume` 与风暴低通都会 TIMEOUT（之前一轮就是这样，画面链路不受影响）。
> 这是浏览器策略，不是应用的坑——真人第一次按键即可解锁。audit13 / audit14 / audit15 都带了这个 flag，所以音频三行全部命中。
>
> 软渲染仍是慢动作（`dt = min(0.05, 真实Δ)`），所以修漏的 3 秒与上升段各花了几十倍墙钟时间——
> 按海拔精细抓帧请用 `tools/cdp-launch-frames.mjs`，实测在 y=36 / 183 / 375 / 1017 / 2200 m 都拿到完整构图。
>
> 帧率说明：无头验证跑在 CPU 软渲染（SwiftShader）上，1280×720 / `med` 约 20–55 fps，
> 因此「桌面 60 fps」只能在真实 GPU 上验收；软渲染只用于证明画面、交互与音频链路正确。
> 软渲染掉帧时会自动触发降级提示（`已自动关闭部分特效以保证流畅`），这正是设计中的保护路径。

---

## 已知边界（尚未验证 / 不适用）

写清楚免得被当成已完成：

1. **帧率证据分两类，别混着看**。
   - 软渲染（SwiftShader，`--use-gl=angle` + `swiftshader`）：`audit15` / `audit16` 与全部 soak 数字都跑在这里，
     它证明的是画面、交互、音频链路正确，**不是**性能数字。
   - 真实 GPU：README 配图与最后一轮取帧用的调试浏览器（Edge，`--remote-debugging-port=9336`，未加任何 GL 覆写 flag）
     经 `WEBGL_debug_renderer_info` 读出 `ANGLE (AMD, AMD Radeon(TM) 610M ... Direct3D11)`，即核显直出。
     这台机器上 `高` 档（pixelRatio 1.5，1887×1034）HUD 实测 **22–27 FPS 并触发自动降档提示**，
     说明降级链路在真机上确实生效；但**「桌面独显 60 FPS」这条本机没有条件验证**，
     验收请在真机上打开 `npm run dev` 或 `dist/`，右上角状态条实时显示帧率与当前档位。
2. **托管部署未执行**。`dist/` 已构建，且整条交互链是**跑在构建产物上**验证通过的（`npm run preview` → `http://localhost:4173/`，见上表 `audit15`，产物 `dist/assets/index-gNNNwTm4.js`），
   但 Vercel / Netlify 发布需要操作者逐步确认后才做。
3. **KTX2 / DRACO 不适用**：场景 100% 程序化生成（零贴图、零模型文件），没有可压缩的外部资产。
   **Web Worker 也未使用**：地形（固定 250×250 段，不随档位变化）与设施几何在加载阶段一次性构建，
   因此运行期的优化手段是 InstancedMesh / 合并几何、按档位的粒子与 MSAA 预算、按 `envUpdateHz` 节流 CubeCamera，
   以及视锥剔除——没有多级 LOD 网格。
4. **WebGPU 路径未实现**：当前为 WebGL2（在 Chrome / Safari / Firefox 现代版本上均可运行），
   目标是「可部署 + 可降级」优先于新后端。

---

## 实现备忘（三处非显然的设计）

- **地形与物理同源**：`surfaceAt(x,z)` 在 250×250 段网格上做精确三角插值，地形网格、车辆物理、相机、碰撞体、传送、计时门全部读它，所以不会出现「视觉上在地面、物理上在地下」。基地「场平」按半径 +58 m、道路按半宽 4~5 倍缓坡过渡到 +1 m 基准，园区内的原始沙丘起伏再压向该基准（只保留 18%）——否则平地基准会落在低 45 m 的沙丘洼地里，任务路线上出现 75° 陡坎。陨石坑深度按 `min(depth, 0.13·r)` 收敛，因为碗壁最陡处在坑缘，深而小的坑会做成 35° 竖壁，车滑下去时姿态被 23° 限位钳住且爬不出来。
- **落地弹簧阻尼的是相对地速**（`prevGroundH` 前馈）。按固定目标阻尼时，弹簧追移动斜坡会留下 `2ζ·v/ω ≈ 0.19·v` 的稳态滞后，14 m/s 爬 15° 坑壁时车身会被画到地形三角面以下 0.6 m——那就是「穿模」。另有 `pose()` 兜底：悬挂起伏可以抬高车身，但网格原点永不低于接触点。
- **发射双段机位**：A 段是观礼台后上方的吊车机位，让漫游车、观礼台、发射塔与 120 m 全箭同框；箭体离地 120 m 后按 `climb` 交叉淡出到 B 段——跟着箭体一起爬升的空中机位（保持在箭体后方 250–380 m、下方 0.3 倍距离），所以箭不会在雾霾里缩成一个点。尾焰粒子按本帧爬升距离沿**扫过路径**多点播种（`steps = 1 + floor(climb / 6)`），慢机器上每帧跳几十米也不会把烟柱拉成虚线。
