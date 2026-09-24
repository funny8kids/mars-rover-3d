# 前端为什么没有 bruno-simon 的美感 — 实测根因

这一页回答的是一个被反复提起、但一直没法定性判断题："整个前端总觉得没有 bruno-simon 的美感"。
**"更好看/更高级"不是答案**，所以这里每条都写成五段：现象 → 实测数字（谁读出来的）→ 对照事实
（参考站同一口径的数）→ 修法 → 判负标准。凡是只有意见、没有读数的假设，一律放进文末「已证伪」，
免得下一轮又被重新提出。

读数由两支工具产出，互不重叠：

```bash
# 屏上真实落位 + 镜头几何（改不了任何文件；drive 档会在一个标签页里开车）
node tools/cdp-run.mjs "http://127.0.0.1:5173/qa_boot.html?auto=std&audstate=hud"   tools/hud-audit-probe.js 9333 90000 300000   # ~60 s
node tools/cdp-run.mjs "http://127.0.0.1:5173/qa_boot.html?auto=std&audstate=drive" tools/hud-audit-probe.js 9333 90000 300000   # ~150 s
# 两边的**作者规格**用同一个函数量（参考站线上 CSS vs 我们的 src/styles.css）
node tools/ref-site-font-probe.mjs
```

分工：`hud-audit-probe` 数的是"这一帧真的被渲染成什么样"，`ref-site-font-probe` 数的是"规格写了什么"。
世界着色（雾、分级、曝光）不在这里，那条链是抓帧 + 亮度直方图，见 [VERIFICATION.md](VERIFICATION.md)。

下面每一节的"实测"都来自这三次跑（2026-09-24，`?auto=std`，无头 SwiftShader，版式框 1000×923）。

---

## 1 字体身份从未落地：界面是操作系统画出来的

**现象**：整套界面在任何一台非 Windows/macOS 机器上都会换一副面孔，而设计里根本没有为它选定过字面。

**实测**：`document.fonts` 长度 **0** —— 页面没有一条 `@font-face`，也没有任何 webfont 链接
（`fonts.loadedFaces`）。栈里写的名字是 `--mono:"Consolas","JetBrains Mono",ui-monospace,monospace`
与 `--sans:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui`（`src/styles.css:4-5`），这台机器上一
个都不存在。用 canvas 推进宽度判定实际落地的字面：`--mono` → **DejaVu Sans Mono**（w 657.97），
`--sans` 与 `.title` → **Noto Sans CJK SC**（w 607.64）。注意 `getComputedStyle().fontFamily` 回的是
**写进去的那串名字**（普查样本里 `fam` 仍显示 "Segoe UI"），它证明不了任何东西 —— 所以这里量宽度。

**对照事实**：参考站首页 `<link>` 里是
`fonts.googleapis.com/css2?family=Amatic SC:wght@700&family=Nunito:wght@400;700;900&display=block`，
它的 CSS 里另有 **3 条 @font-face**（`Pally-Regular` / `Pally-Medium` / `Pally-Bold`，自有品牌字族），
`font-family` 出现 6 个值、其中 3 个是品牌名。而且它用 `display=block`：**宁可白屏也不画一张降级面孔**。

**修法**：`src/styles.css:4-5` 两个变量指向**自托管**的字族（仓库已经有 `vendor/` 放 three.js 的先例），
`index.html` 补 `@font-face`；授权走 SIL OFL（用户定的方向是能复用就不自己造，Google Fonts 可直接自托管）。
需要两个角色：一个有辨识度的 display/hand 体（对应 Amatic SC 的位置），一个 HUD 数字用的等宽体
（对应 Pally 的位置）。

**判负标准**（`hud-audit-probe` hud 档）：`fonts.loadedFaces ≥ 3`，且 `fonts.monoResolves.hit` /
`sansResolves.hit` 里出现设计写的那个族名，而不是 `DejaVu Sans Mono` / `Noto Sans CJK SC`。
只要 `loadedFaces === 0`，字体这一栏就不许写"已通过"。

**落地（2026-09-24）**：4 条 `@font-face`、4 个族全部 `loaded`，三个角色的栈各自第一族都命中设计族
（`--display → Big Shoulders Display`、`--sans → IBM Plex Sans`、`--mono → JetBrains Mono`），
中文由 `Noto Sans SC` 接管（`fonts.sansResolves.cjk.hit = ["Noto Sans SC 【design】"]`，
`differsFromOsOnly 6/6`）。判据从"≥3 个 face"改成了**按脚本 × 按角色**：一个族只在它真正被要求画的那种
文字上算数——`Noto Sans SC` 对拉丁串 `facesMatched=0` 是**正确**的（子集里没有拉丁字面），而旧判据会把这
读成"字体没落地"。同时保留一条假族名对照（`RSB Not A Shipped Face` 两种脚本都回 0）证明这盏灯不是恒绿。

**体积**：`src/fonts/` 从 13 个文件 / 836 kB 压到 **4 个文件 / 276 kB**。原因不是"少发一个字重"，而是
Google 的 css2 对这三个拉丁族**本来就回同一个可变 woff2**——按字重逐个落盘等于把同一份 45 kB 下载三次。
中文侧同理：三个静态实例（500 kB / 3 次请求）换成一段被夹到 400–700 的子集（166 kB / 1 次请求，
633 个字面）。一个可变文件能不能真画出三种字重，由 `tools/wght-probe.js` 在浏览器里用**墨量**回答：
`Noto Sans SC 8823→11509→13328`、`Big Shoulders 6046→7447→8870`、`JetBrains Mono 6499→7892→8660`、
`IBM Plex Sans 6211→8807→10519`，四族 `facesMatched` 每档都是 1。

**仍然没解决（诚实记账）**：63 个界面符号（`°±²³·¹½×Øé÷ΔΣβζθλπρτφω–—’“”…⁻₂→↔⇒∈−√∫≈≤⊘`）不在任何子集里，
继续由系统字面兜底——它们是数学/箭头/排版标点，Google 的 latin 子集不含这些码位。要么补一段符号子集，
要么把这些字符换掉；现在它们由 `build_fonts.py --check` 每一跑报一次，不会悄悄烂掉。

**顺带抓到的一条生成物纪律**：`src/styles.css` 的 FONTS 块顶部那行"缺的符号 N 个"是**写进 CSS 的读数**，
所以它会随清单漂移。给 `inventory()` 加"剥掉 CSS 注释"这一步之后我只跑了 `--check`（它不落盘），
块里就还留着旧值 64，而同一支函数的实时读数是 63 —— 一个只读校验**不会**让它变正确。重跑 `build_fonts.py`
后字节跟着变（子集 647→633 个字面：少的正是我那句注释里的字，Google 重新切了 IBM Plex 那份文件），
`wght-probe` 的三档墨量与 §2c census 的 h/v/collisions **逐位相同**，说明重切没有改到渲染。

---

## 2 层级不是太扁，是地板太低

**现象**：HUD 一眼看上去是"调试面板"，不是"排版"。

**实测**：屏上 16 个可见文本节点，阶梯 `{10 px: 2, 11 px: 7, 12 px: 1, 12.5 px: 4, 14 px: 1, 52 px: 1}`
—— 11 px 一档独占 7/16。规格侧 `src/styles.css` 的字面 `font-size` 有 **18 档，8.5 px → 64 px**
（含 CSSOM 的 `clamp(60px,12vw,150px)` 是 20 档，8.5 → 150 px）。

**对照事实**：参考站 CSS 只有 **13 档，0.8rem(=12.8 px) → 64 px**，`letter-spacing` 3 值，
`font-weight` 400/500/700/900。

**这里要纠正一个说法**：把"没有美感"归因于"字号阶梯没拉开"是**错的** —— 同一把尺子下我们的跨度
（7.5× / 17.6×）比参考站（5.0×）**更大**，档数更多。真正的差在**下限**：我们最小 8.5 px，
他们最小 12.8 px；以及第 1 条的字体身份。层级从来不是靠把小字做小做出来的。

**修法**：`src/styles.css` 里 8.5 / 9 / 9.5 px 那批（`.tel-sub`、`.r-lab`、`#film-lance`、`.film-line`、
`#info-tag` 一类）全部提到 ≥ 12 px，靠字重（600/700/800 已在用）与色阶拉层级；`#info-tag` 这类标签行
用"更大 + 更灰 + 更宽字距"，不要用"更小 + 更亮"。

**判负标准**：hud 档 `type.min ≥ 12` 且 `type.under11.pct === 0`；`ref-site-font-probe` 里我们这侧的
`fontSizes[0] ≥ 12px`（现在 8.5px）。

**落地（2026-09-24）**：8.5 / 9 / 9.5 / 10 / 11 px 那一批全部提到 ≥ 12 px，层级改由字重
（600/700/800）与色阶承担。hud 档屏上 16 个节点的阶梯变成 `{12:8, 13:5, 15:2, 52:1}`，
`type.min 12`、`under11.pct 0`；规格侧 `fontSizes[0] = 12px`，而 authored 档数顺手从 18 档收到
**9 档**（`12/13/15/18/20/22/25/52/64`，参考站 13 档）—— 之前那 18 档里有 9 档是 8.5–11 px 的碎级。为了让**菜单那一屏**（display 层住的地方）
也被同一把尺子量到，探针多了一个 phase：`window.__AUDSTATE='menu'`（`audstate=menu` 同义），
菜单档 31 个节点 `{12:27, 18:1, 20:1, 22:2}`，同样 `min 12`。对比度没有因为字重上升而失手：八个状态
（菜单 zh/en + hud 六态）全部 `contrast.below45 = 0`，最暗的一行是 `.q-card i` —— 菜单 en 面 `4.72`、
zh 面 `4.92`，hud 档 `min 5.5`（红线 4.5）。

**代价要说出来**：屏上跨度从 7.5× 缩到 4.3×（12 → 52），12 与 13 两档在屏幕上几乎没有差别 ——
这正是 §5（用色阶代替发光）与 §7（补一个真正的正文层）要填的空位，而不是把字号再压回去的理由。

---

## 3 字距用在了错的那一端

**现象**："小字 + 大字距"是 2015 年游戏 HUD 的签名，一眼就是模板感。

**实测**：`src/styles.css` 的 20 个 `letter-spacing` **全部是 em**，从 `.02em` 到 `.5em`，而带上字号配对
之后几乎全落在 9–14 px 的小字上：`#info-tag` 10 px/.25em、`#speed-unit` 11 px/.35em、
`#battery-row` 10 px/.18em、`.mp-title` 11 px/.3em、`.tel-ev` 10 px/.09em。屏上 **43.8 %（7/16）**
的可见文本字距 ≥ 0.15em。

**对照事实**：参考站的 `letter-spacing` 只有 3 个值，全是 **px**（1/8/14），而唯一的
"字号 + 字距"配对是 `25 px` + `8 px`（=0.32em，`.input-group.is-name-tag .input-te…`）——
**大字距只出现在 display 层**，正文一律不动字距。

**修法**：≤14 px 的文本字距压回 ≤ 0.06em；把 `.15–.5em` 这一档留给 ≥18 px 的标题与按钮 ——
`.menu-title` 20 px/.5em、`.start-btn` 18 px/.4em 已经是对的，问题在小字那一半。

**判负标准**：hud 档 `tracked15.pct` 从 43.8 % 降到 ≤ 15 %，并且 `sizeAndTracking` 配对表里
不再出现「字号 < 14 px 且字距 ≥ 0.15em」的组合。

**落地（2026-09-24）**：≤14 px 的文本字距全部压回 ≤ .06em，`.15–.5em` 那一档只留在 ≥18 px 的标题与按钮上。
hud 档 `tracked15.pct` 43.8 % → **0 %**（六个 HUD 状态各测一遍，全部 0）；规格侧配对表里
「<14 px 且 ≥.15em」的组合为 0。菜单档 12.9 %（4/31），四条全部 ≥18 px：`.menu-title` 20/.5em、
`.q-card b` 22/.2em ×2、`.start-btn` 18/.4em；排行榜打开时 hud 档出现唯一一条 `#board-pop h3`
18 px/.2em（4.2 %），同样在 display 那一侧。为了让「谁在名单上」可核对，探针的 `tracked15` 现在带
`list`（`元素:文本=字号/字距`）——一个只有计数的名单会被下一个读它的人随口解释掉。

---

## 4 动效没有一次过冲

**现象**：UI 出现/消失都是"匀速滑到位"，没有任何东西弹一下，所以画面显得"没被调过"。

**实测**：`src/styles.css` 15 条 `transition`、5 个 `@keyframes`，但 `cubic-bezier()` **0 个**；
缓动关键字只有 `ease` 与 `linear`（`ease-in-out`/`ease-out` 也在用）。另有 5 处是裸写法
（`transition:.25s`、`transition:.3s`、`transition:.4s`），既没列 property 名单也没指定曲线，
等于把整条计算样式挂进过渡。

**对照事实**：参考站 23 条 `transition`、**4 个自定义 cubic-bezier，4/4 都带过冲** ——
`(.4,1.6,.65,1)`、`(.42,0,.47,-.55)`、`(.49,2.2,.53,.75)`、`(.65,-1,.45,1)`：第二个/第四个控制点的 y
落在 [0,1] 之外，这在关键字里永远拿不到。

**修法**：给"进入/退出"的少数几处（`#toast`、`#info-card`、`#mission-panel li`、`#tele-fab`/`#mute-fab`、
`.start-btn:hover`）换成显式的过冲曲线 + 明确 duration + property 名单。只改进入，不改常驻读数
（`#battery-fill`、`.film-bar i` 这类连续量应该继续 `linear`，让它们过冲会读不准）。

**判负标准**：`ref-site-font-probe` 我们这侧 `customBeziers ≥ 4` 且 `overshootingBeziers === customBeziers`；
`transition:.25s` 这种"只给时长"的写法在 `src/styles.css` 里为 0。

---

## 5 用发光代替了层级

**现象**：想强调就加 `text-shadow`，于是"高级感"变成了霓虹。

**实测**：`src/styles.css` 里 **7 处 `text-shadow`**（`#speed-val` 的 `0 0 22px rgba(255,140,40,.55)`、
`.logo-glyph` 的 `0 0 40px rgba(255,120,26,.8)` 等）。

**对照事实**：参考站 `text-shadow` **0 处**。它的强调全部来自字号、字重（用到 900）和颜色。

**修法**：文本层保留 ≤ 2 处发光，且只给"真的在发光"的对象（信标状态、警告）；其余用第 2 条的
字号 + 字重解决。

**判负标准**：`textShadows ≤ 2`。

---

## 6 镜头会在加速过程中换一张构图（这条不依赖参考站）

**现象**：停车时和 48 km/h 时，画面不是"同一张构图的不同速度"，而是两张不同的构图。

**实测**（drive 档；先在路网上找到 31.5 m 净空的直道 `{x:6,z:6,yaw:0}`，`R.place` 落位、飞 40 帧让
rig 落稳，再按住 W 逐档读）：

| 速度 | fov | 镜头到主体 | 主体占画面高 | 地平线在第几行 |
| --- | --- | --- | --- | --- |
| 0（落位后静止） | 60.0 | 11.8 m | 11.56 % | 32.5 % |
| 1.2 m/s | 60.1 | 11.1 m | 12.37 % | 33.5 % |
| 10.8 m/s | 64.0 | 16.9 m | **7.53 %** | 39.3 % |
| 11.5 m/s | 64.4 | 19.6 m | **6.45 %**（最低） | 40.4 % |
| 13.4 m/s = 48 km/h | 65.4 | 16.2 m | 7.66 % | 38.8 % |

从 4 km/h 到 48 km/h，**主体占比掉 38.1 %**（12.37 → 7.66），地平线**下滑 6.3 个百分点**，
dolly 距离从 11.1 m 一路退到 19.6 m 再回 16.2 m。全程 fps 60、`rescue` 空、`gas` 1.00。

**归因**（`shareAttribution`，不是手算）：`byRetreatingRigPct 31.5` + `byOpeningLensPct 9.9`，
两项乘回 0.617 与实测比 0.619 相符 —— 也就是说 **80 % 的缩水来自 rig 后退**，20 % 来自开角。
代码位置：`src/camera/chase.js:30` `back = 9.6 + speed * 0.16`（每 m/s 后退 0.16 m）与
`:74` `targetFov = 60 + speed * 0.42`。两个方向都在把主体做小，**没有任何一项把它们拉回来**。

**对照事实**：参考站的镜头无法用同一探针读数（它的站点是打包后的 three.js 场景，页面里没有我们这样
的接口）。所以这一条刻意用**自证式判据**：一个被安排过的镜头，不会在两种速度下给出两张构图。
这比"和它长得像"更硬，因为它不需要抓得住对方。

**修法**：把"随速后退"改成"随速保持" —— 例如 `back` 增速归零、或让 `back` 与 `fov` 联动
（`back` 随开角收窄，使 `share` 恒定）；`look` 的高度随速度微调，把地平线钉在同一行。

**判负标准**（drive 档）：`shareAttribution.totalPctLost ≤ 15`，且 `top.horizonPct − atRest.horizonPct ≤ 2`。

**闸门 M1（见过红）**：把 `src/camera/chase.js` 的 `speed * 0.42` 改成 `0` 重跑 drive 档，14 档 fov
**全部读回 60.0**（实测，同时主体占比变成 12.41 → 8.52，即少了开角那 9.9 %）。不躺平就说明这一档
量的不是游戏相机。恢复后同一档阶梯是 60.1 → 65.4。

---

## 7 密度：HUD 占掉了 19 % 的画面，而且没有正文层

**现象**：像仪表盘，不像一帧画面。

**实测**（hud 档，同一版式框 1000×923）：文本覆盖率 `textCoveragePct` **9.1 %**；带底色/描边/背景模糊的
"盒子" **4 个，覆盖 10.01 %**（`#mission-panel` 5.71 %：bg+border+blur 三样全占；`#toast` 3.47 %；
`#tele-fab` 0.56 %；`#mute-fab` 0.26 %）。合计 **≈ 19 % 画面不是世界**。（扫描了 212 个节点，
按原因计数：无自身文本 113、不可见 3、有效透明度 <0.05 23、尺寸 <2 px 57、出框 0。）

**对照事实**：参考站首页 DOM 有 543 个标签，文本标签里含 `p` / `li` / `a`（**有正文层**：句子、列表、链接）；
我们是 122 个标签，文本标签只有 `h1` / `h2` / `h3` / `span` / `div`（**全是标签与读数，没有一句人话**）。

**修法**：常驻面板改成情境出现（`#mission-panel` 在非任务态收成一行；`#toast` 保持一次性），
把省下的画面还给世界；同时给基地加一个"可读的正文层"（区名/设施名的 3D 标牌，属于 D 项的范围，
这里只登记为因果链上的一环）。

**判负标准**：hud 档 `panels.coveragePct ≤ 5` 且 `textCoveragePct ≤ 5`，且 `panels.top` 里
不再有同时 `bg && border && blur` 的 > 3 % 盒子。

---

## 8 真实点击抓到的两件 DOM 读数看不见的事

【F】1 要求"UI 变更必须真实点击走一遍交互"，于是有了 `tools/cdp-type-click.mjs`：14 步走一遍
菜单 → 启动 → HUD → 传送面板 → 跃迁 → 静音 → 拍照 → 计时赛 → 排行榜 → 关闭，每一步都是
CDP `Input.dispatchMouseEvent` 打在元素自己的矩形中心上，且先过 `document.elementFromPoint` 命中测试。
它抓到两件前面七节所有尺子都看不见的事：

1. **`#lang-btn` 在菜单那一屏根本点不动。** 它是 `position:fixed; z-index:40`，而 `.overlay`（`#menu`）
   是 `z-index:50` —— 命中测试在按钮自己的中心拿到的是 `#menu`。之前每一次语言切换测试都是绿的，
   因为它们调的是 `element.click()`，而 `.click()` 不关心谁压在它上面。于是一个不认得汉字的人
   在他唯一会停留的那一屏上，够不到唯一能自救的控件。修：`z-index:55`（越过 overlay，低于
   一闪而过的 `.tp-flash`），并补一条 `#loader:not(.hidden)~#lang-btn{display:none}` —— 加载条还在
   走的时候没有东西可翻译。真实点击复测：菜单档点一次 → 「选择渲染画质」变 "Choose render quality"、
   按钮自己从 39.84 px 变 49.45 px（"EN" ↔ "中文"），再点一次回到 zh。
2. **`kbd` 提到 12 px 之后，`#controls-hint` 那一排键帽全部悬出本行 2 px。** 菜单 phase 一开就报
   `v.n = 10`（十条，每条一个 `.controls-hint` 子项）。行盒由这一行的字号决定（12 px → 18 px），
   而键帽加上 1 px 边框 + 2 px 下边框是 19–20 px —— 把字号抬到地板上而不把行抬起来，正是
   §2c 在 `#speed-val` 上已经栽过一次的那个错。修：`.controls-hint{line-height:1.75}`，复测 `v.n = 0`。

顺带记两条关于尺子自己的：驱动脚本原本在命中测试失败时只往最终 SUMMARY 里塞一条记录就 `return`，
一次走完看起来像"14 步都做了"——现在每步失败立刻打 `!!` 行，且探针回 `{fail}`（phase 没等到）
或回一个没有 `type.min` 的对象时，那一步判红而不是判绿；`restoredAfterLocaleToggle` 原本硬比
`=== 'EN'`，在故意停在 en 面的那一测里把"正确还原"报成 false，现在比的是本次运行开始前的那颗胶囊文本。

**判负标准**：`node tools/cdp-type-click.mjs <qa_boot url> 9333` 末行 `STEPS 14 FAILED 0`，
且每个带 `measure` 的状态都是 `min=12 h=0 v=0 collisions=0`、三个 control 全绿。

---

## 已证伪：下面这些不要再作为原因提出

| 假设 | 为什么被推翻 |
| --- | --- |
| "文字对比度不够" | 16 条文本全部打分，`below45 = 0`，最低 5.5（`#tb-time` LMT 07:20 / `#tb-weather` / `#tb-quality`）。读得清，不是问题。 |
| "字号阶梯没拉开" | 我们 authored 跨度 7.5×（18 档）／17.6×（含 clamp，20 档），参考站 5.0×（13 档）。这一条方向相反，见第 2 节。 |
| "屏上最大只有 14 px，说明 HUD 没有层级" | 尺子坏了：run #1 用被改写的 `innerWidth` 当量框，把 52 px 的 `#speed-val`（x=936）判成出框。改用 `body` 的版式框后它进表了。现在由 `selfCheck` 五个正对照守住。 |
| "后处理分级是省事的默认值" | `src/fx/post.js` 是有作者意图、随昼夜变化的链；A7 的实测另已判明整条链 <1 ms，不是任何"图省事"的证据。 |
| "世界偏色 / 死黑" | 那是抓帧 + 亮度直方图那条链（`clip=0`），与本页的规格读数无关。 |
| "静止 fov 60° 异常" | 60° 正常。问题不在静止值，在随速变化与 dolly，见第 6 节。 |
| "字体没问题，CSS 里写了 Segoe UI / Consolas" | `getComputedStyle().fontFamily` 回的是你写的名字，不是被渲染的字面。推进宽度实测落到 DejaVu Sans Mono / Noto Sans CJK SC，见第 1 节。 |
| "推进宽度可以判定中文字面" | 对拉丁成立，对中文不成立：每个汉字占同一个 em 框，`火星基地坪站` 在 400 和 700 下都是 **432.0 px**，而墨量是 8823 → 13328（`tools/wght-probe.js`）。宽度这把尺对字重全盲；判定字重只能数被点亮的像素。同理，`unicode-range` 的正则也不是脚本探测器——一条 `U\+(4E\|30\|FF0\|FF1)` 把四个族**全部**判成汉字，拉丁三行于是量的都是降级面（8908→8908→13070，与降级锚一模一样），探针自己造了假红；哪种文字由 `document.fonts.load()` 回不回人面来回答。 |
| "整串像素哈希可以判定字体身份" | 哈希把每个字面的**推进宽度**一起折进数字，同一副轮廓经两条不同的栈会哈希分离；而且整串画在固定宽画布上会被切（168 px 画布在 32 px 下切掉 `火星基地坪站` 的尾巴，比较是在残缺的墨上做的）。现场症状：`sansResolves.cjk.hit` 为空、`designTookOver` 却说 webfont 已落地。改成**一字符一框、固定 alphabetic 基线**后，进入数字的只有那一个字的形状（`tools/hud-audit-probe.js:248-253`）。 |

## 顺带记录：出生点按 W 量到的是碰撞，不是镜头

drive 档第一次从出生点 `(0,-26)` 按住 W 时，车在 1.9 m 后被钉住：`gas` 一路到 1.00、
`longAcc` 9.8 m/s²，速度 2.22 m/s@f20 → 4.91@f40 → **0.07@f60 并一直趴到 f120**，位置锁在
z = −24.07。挡路的是 `(0, −21.07)`、半径 1.4 m 的碰撞圆盘 —— **出生点正前方 4.93 m**
（`lens.spawnBlocker`，probe 现在每次都把它读出来）。`rescue` 全程为空，因为这次钉住约 1.4 s，
短于 2 s 的卡死判据。

结论：这是**关卡布局**，不是 A 项的物理回归，也不是输入链坏了；但它意味着"在出生点按 W 读镜头"
这个做法永远测不到镜头，所以探针自带找路（`lane` + `clearance`）。出生点前方净空是否要改，
留作 D 项的一个输入。
