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

**落地（2026-09-24）**：`:root` 里四条曲线，全部带过冲，各管一种物理 ——
`--ease-pop`（到位后越过再收）、`--ease-glide`（滑进位）、`--ease-lean`（先蓄力再弹过，给 hover/press）、
`--ease-exit`（退出前先缩）。规格侧：`customBeziers 4 / overshootingBeziers 4 / beziersApplied 4`，
`bareTransitions 0`（原来 7 条裸写法：`.q-card`、`.start-btn`、`#mission-list li`、`#info-card`、
`.grid-pip`、`#toast`、`.eng-dot`），`transitions` 15 → 20 条，每条都写明 property + duration + curve。
参考站 23 条 / 4 过冲 / 2 裸 —— 数量上我们仍少 3 条，但"零过冲 vs 全过冲"这一项已经翻过来了。

**渲染侧另开一把尺子**（`tools/motion-landing-probe.js`）：文本尺子数的是写过的字面，看不见层叠之后的
结果，所以它读 `getComputedStyle`。八处点名的进入态（`#toast`、`#info-card`、`#mission-list li.active`、
`#tele-fab`、`#mute-fab`、`.start-btn`、`.q-card`、`#tel-wrap.show`）computed timing function 全部是
控制点越界的 `cubic-bezier` = **8/8**；连续读数（`#battery-fill`、`.film-bar i`、`.tel-ramp i`）
必须**不是** bezier（会过冲的百分比不是生动，是仪表坏了）= **3/3**；两颗胶囊靠 `display:none → block`
出现，transition 无法从 `none` 插值，所以进入是 `@keyframes fab-in` + `--ease-pop` = **2/2**
（不带 `both`：fill-forwards 会永久压住 `:hover` 的 transform）。
`prefers-reduced-motion` 用 CDP `Emulation.setEmulatedMedia` 实测第二遍：同一批元素 bezier 计数
8 → **0**，四个 token 全部解析成 `linear`，进入动画时长压到 `1e-05s` —— 那段 `@media` 是真在生效的机制。

**两条自己踩到的**：① 给 `li.active` 加 3 px 侧倾后，`fit.hiddenScreen.onScreen.h` 立刻报
`#mission-list 326>323`；第一次把 3 px 补在 `#mission-panel` 的 padding 上**没有用** —— 自适应宽度的盒子，
外侧 padding 长的是 border box，内容宽度一点没变，两次读数一模一样；补在列表自己的 `padding-right` 才归零。
② 规格尺子原本用 `Object.fromEntries` 建自定义属性表，于是**最后**一条定义赢 —— `prefers-reduced-motion`
块里那四条 `linear` 覆盖掉真曲线，`beziersApplied` 报 0（一个假红，但方向诚实）。现在取**第一**条定义，
并把 reduce 块里的覆盖单独报成 `reducedMotionTokens`，不再静默改写。
RED 对照：同一把新尺子跑改动前的 `src/styles.css` 字节 → `transitions 15 / bare 7 / beziers 0 /
overshoot 0 / applied 0 / reducedTokens []`，四个新字段全部会因缺曲线而红。

---

## 5 用发光代替了层级

**现象**：想强调就加 `text-shadow`，于是"高级感"变成了霓虹。

**实测**：`src/styles.css` 里 **7 处 `text-shadow`**（`#speed-val` 的 `0 0 22px rgba(255,140,40,.55)`、
`.logo-glyph` 的 `0 0 40px rgba(255,120,26,.8)` 等）。

**对照事实**：参考站 `text-shadow` **0 处**。它的强调全部来自字号、字重（用到 900）和颜色。

**修法**：文本层保留 ≤ 2 处发光，且只给"真的在发光"的对象（信标状态、警告）；其余用第 2 条的
字号 + 字重解决。

**判负标准**：`textShadows ≤ 2`。

**落地（2026-09-24）**：7 → **2**。留下的两处是画面里真的有光源照着字的对象 —— `#countdown`（点火时
压在探照灯柱上的 T- 秒数）与 `#tel-wrap`（尾羽正下方的发射遥测板）。其余五处全部改由字号 / 字重 /
色阶承担：`.logo-glyph` 去掉 40 px 光晕（它是一枚标志，不是一盏灯）、`#speed-val` 去掉 22 px 光晕
（52 px / 700 已经是全场最大，发光只是把层级涂在字上）、`#mission-list li.active` 从
「亮色 + 12 px 光晕」改成 `#fff3df` + `font-weight:600` + 第 4 条给的 3 px 侧倾。
两处**深色**墨影（`#nav-chip`、`.tel-ev`）本来也不是发光，是拿墨影当代偿底板：胶囊自己的
`background` 从 `.74` 提到 `.86`，发射轨迹日志改落到一块 `rgba(9,11,17,.55)` 的小底板上，
`text-shadow` 一并删掉 —— 顺带把 `#mission-list li` 的 transition 里那条再也不会变的
`text-shadow` 撤了（挂在不变性质上的过渡是死重量）。

**没有失手的地方**：八个状态（菜单 zh/en + HUD 六态）真实点击走查后 `contrast.below45` 仍为 0，
`min` 5.5（hud 档）/ 4.72–4.73（菜单档最暗的 `.q-card i`，红线 4.5）；`h=0 v=0 collisions=0`
（`li.active` 提到 600 字重没有把最长一行顶出列表 —— 汉字的 em 框等宽，拉丁只宽约 1 px，4 px 预留吃得住）。
`STEPS 16 FAILED 0`。

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

**落地（2026-09-24）**：`totalPctLost 38.1 → **1.8**`，`horizon Δ 6.3 → **−0.5**`。drive 档阶梯（同一条 31.5 m 直道，fps 全程 60）：

| km/h | 主体占高 | 地平线行 | 机位到主体 | 计划 back | 滤波器拖尾 lag |
| --- | --- | --- | --- | --- | --- |
| 0（落定） | 13.40 % | 34.1 | 10.3 m | 9.60 | 0 |
| 12 | 13.42 % | 34.2 | 10.1 | 8.32 | 1.01 |
| 30 | 13.36 % | 34.0 | 9.8 | 6.55 | 2.42 |
| 48 | 13.18 % | 33.7 | 9.4 | 4.64 | 3.96 |

`src/camera/chase.js` 里改的是三件事，缺一件都到不了这个数：

1. **开角与机位联动**：`back = 9.6·tan(30°)/tan(fov/2)` —— 主体占高 ∝ 1/(d·tan(fov/2))，镜头开多少度，
   机位就按同一个因子收进来，`share` 因此是恒等式而不是巧合。
2. **俯角由几何导出**：`up = 1.5 + (hold + la)·0.1844`（0.1844 = (4.1−1.5)/(9.6+4.5)，即怠速那一档的
   俯角），地平线不再随速度上下漂。
3. **把跟随滤波器的稳态拖尾付回去**：`lag = speed/stiff`，`back = max(4.5, hold − lag)`。这一条是量出来
   的，不是猜的 —— 加了 `plan`（每帧把 back/up/la/stiff/lag 交出来，`__RSB.camPlan()`）之后才发现
   achieved distance ≡ back + lag：48 km/h 时滤波器自己就拖后 3.96 m，占掉剩余损失的全部。
   另有一处道具侧的：相机避让的保留半径原本一律 `r + 1.8`，一根 0.45 m 的路灯杆因此能把机位顶开 3 m
   （实测 32→39 km/h 之间 dist 11.8 → 16.2、占比 12.5 → 7.9），现在按 `clamp(r·1.2, .35, 1.8)` 随粗细缩放，
   3 m 级的大件行为不变。

**尺子自己也被修了一次**：drive 档的 `atRest` 原来只等 40 帧，量到的是一台还在飞入的相机
（dist 12.8 对落定后的 10.3），整条阶梯的比值都建在这个偏高的基线上 —— 现在 step 到相机不动为止
（`atRestFrames`，本次 120）。两条自证仍在：`rulerControl` 投影/解析两把尺 13.66 == 13.66，
`opticsCheck` 实测比 0.982 对几何比 0.978。反例记录：第一版把 `tan(30°)` 写成 `tan(15°)`，
读数当场变成 dist 7.3、占比 19 % —— 常数错一位，判据会红，不是绿得可疑。
【F】1 的抓帧另跑一遍：怠速与 47 km/h 两张 `clip = 0`、最暗一档 0 像素，两张直方图形状一致
（`[0,213,397,105,91,195,…]` vs `[0,237,411,50,56,246,…]`），即"同一张构图的两种速度"。

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

**§7 已落地（2026-09-24）**：做法不是"把字变小"，是把**五条句子中的四条从常驻改成情境出现**：
`src/ui.js` 只把当前目标留在 `#mission-list`，其余三条放进 `#mission-rest`，
`#mission-panel:not(.open)` 用一条 CSS 把 `#mission-rest` 收起。展开有四条路，全部真实驱动过：
指针悬停、键盘聚焦、点计数器、以及任务链**形状**改变时自动展开 6 秒（`renderMissions` 里 `mpSig`
只折进 `text/done/active`，故意不含 `{n}` 计数器 —— `main.js` 每个网格计数 tick 都会重画同一批句子，
把"数字动了"当成"新任务了"会盖掉玩家正在读的那一行）。收起的内容必须留一条回来的路，所以计数器
`#mp-more` 不 `hidden`（除非真的没有别条），并且带 `aria-expanded`。
密度读数（hud 档，同一版式框）见本节末尾的实跑记录。

**真实点击抓到的第三件事：控件会在指针底下跑掉。** 上面那套收/放第一版把计数器放在
`#mission-list` 之后，面板是 `top:18px` 顶锚、往下长的，于是展开时计数器从 `y=58` 滑到 `y=160`。
`/tmp/mp-events.mjs`（一次性记录仪：capture 阶段把 `pointerover/enter/leave`、`pointerdown/up`、
`mouse*`、`click`、`focus/blur/focusin/focusout` 全打在面板和按钮上）量到的序列是：
CDP 的 `mouse()` 先发 `mouseMoved` → `pointerenter` 已经先把面板打开 → `mousePressed` 落在
`#mission-list` 的一行 `li` 上（不可聚焦，焦点交给 `body`）→ `focusout` 把面板收起 →
`mouseReleased` 时按钮早已不在指针下面，浏览器把 `click` 派给**最近的共同祖先** `#mission-panel`
—— 那里没有监听器。结果：点「还有 3 条」什么都不发生。历次 `element.click()` 测试全绿，因为
`.click()` 既不移动指针也不换焦点。
**修法是把改动放在产品里而不是测试里**：DOM 拆成 `#mission-list`（当前目标，1 行）→ `#mp-more`
（计数器）→ `#mission-rest`（其余），计数器于是坐在同一块地上；样式选择器从
`#mission-list li…` 全部改成 `#mission-panel li…`，两截列表共用 `padding-right:4px` 那条溢出补位。
被否掉的两版：计数器提到整块列表前面（读序变成"数字—句子"），`display:contents` + CSS `order`
（DOM 序 ≠ 视觉序，读屏和 Tab 都会拿到错的顺序，而且会丢掉 `#mission-list` 那个承重盒）。
走查里新增一条不变量把这件事钉住：`hud:mission-state` 要求七个手势步量到的 `#mp-more` **锚点
（x, y）只有一个值**，并且"任一状态下指针所在的那个矩形中心，落进其余所有矩形之内"。锚点不含宽度
是刻意的 ——「还有 3 条」和「收起任务」本来就是两个长度。这条不变量当天就抓到了**同一种病的第二个实例**：
拆完列表后按钮仍然从 `y=58` 滑到 `y=85`，因为收起态还顺手 `display:none` 掉了 `.mp-title`，
而标题在按钮**上面**（`btnBoxes ["35,85,51,18"]` 对 `["35,58,62,18"]`）。判据是"按钮上面所有东西的高度
不能变"，于是标题成为待机 HUD 的一部分，密度全部由那三条句子省回来。
`hud:mission-click-*` 两步断言的是**真实输入域的顺序**（悬停先开 → 点击收起 → 再点展开），
不是"点击会展开"。RED 件：`/tmp/j6-mp2.txt` 的
`hud:mission-click-collapse FAIL state: panel did not close (open=true)` /
`hud:mission-click-open FAIL state: panel did not open (open=false)` /
`hud:mission-labels` 报 `opened:["收起任务","还有 3 条"]` 与 `closed` 正好相反；
第一轮修完（列表拆了、标题还收着）复跑是 `/tmp/j6-mp3.txt` 的 `STEPS 12 FAILED 5`，
四个手势步全红、`hud:mission-state` 报出那一对 y 值。

尺子自己也被这三条手势逼着补了三件东西：① `Input.dispatchKeyEvent` 合成 Enter 必须带
`windowsVirtualKeyCode/nativeVirtualKeyCode=13` 与 `char:'\r'`，否则焦点在按钮上也不会触发默认动作，
键盘那两步会假绿；② `window.__AUDHOLD` 把"操作者亲手放上去的层"声明给探针，探针只退役没被点名的
瞬时层，并回 `pinned:` —— 所以展开态那次读数（文本 6.14 % / 盒子 7.73 %，`pinned:["mission-panel"]`）
永远不会被误读成待机 HUD；③ 正对照必须能失败：`selfCheck` 的锚点改用普查自己的 `onScreen()` 判
（`broken` vs `skipped:'faint'|'display:none'|'zero-box'|'offscreen'`）、`anchorMutation` 要求
`dropped===1 && caught===true`、`hudMarkupParity` 去 `fetch('/index.html')` 用 DOMParser 比对 ——
这也是 `qa_boot.html` 必须与 `index.html` 的 HUD 标记保持一致的原因，否则走查量的是一屏游戏里
并不存在的 DOM。

### 实跑记录（2026-09-24，最终字节）

命令：`node tools/cdp-type-click.mjs "http://127.0.0.1:5173/qa_boot.html?v=<tag>" 9333`，认的是末行
`STEPS … FAILED 0`。闸门在 `tools/hud-audit-probe.js` 的 `density` 块里：`bar {textPct:5, panelPct:5,
cardedBoxPct:3}`，`judged` 只在判的确实是那一屏（`want==='hud'`）且没有一层是操作者亲手钉上去的
（`pinned` 为空）时才为真，超线由 `cdp-type-click.mjs` 落成一行的 `!! … FAIL §7 density: …`。

| 哪一屏 | 文本 | 盒子 | 最大整卡盒 | 进闸门？ |
| --- | --- | --- | --- | --- |
| 待机 HUD（`hud:mission-panel`） | 3.15 % | 3.81 % | `#mission-panel 2.93 %` | ✅ `control {bar:1, tripped:3}` |
| 静音后 / 拍照退出后 | 3.15 % | 3.83 % | 2.93 % | ✅ |
| 停在光台上（`hud:teleport-warp`） | 4.28 % | 4.85 % | 2.93 % | ✅ |
| 从光台开走（`hud:pad-leave`） | 3.13 % | 3.81 % | 2.93 % | ✅ |
| 排行榜弹出（`hud:race-board`） | 3.13 % | 3.81 % | 2.93 % | ✅（弹出层记在 `summonedUp`，外层读数 5.62 / 10.43） |
| 关榜瞬间（`hud:board-close`） | 3.13 % | 3.81 % | 2.93 % | ✅（`#race-hud` 仍在淡出，外层读数 3.74 / 5.06） |
| 任务日志展开（`hud:mission-hover-open` / `-click-open`） | 6.14 % | 7.57 % | 6.69 % | ❌ `pinned:["mission-panel"]`：这一屏是玩家亲手放上去的 |
| 菜单档（`menu:lang-*`） | 0.17 % | 0 % | — | ❌ `judged:false`，`summonedUp:["#menu"]` |

以上判绿的每一步同时保持 `min=12`、`h=0`、`v=0`、`collisions=0`、`below45=0`、hud 档
`contrastMin 5.39`。

**闸门先见过红，才有资格说绿。** 任务日志收成一行之后，**停在光台上**那一屏仍是盒子 **5.46 %**（同一次
跑的 `hud:mute-fab` / `photo-exit` / `race-board` / `board-close` 全是 5.46–5.48 %），五条一起红：
`/tmp/j7-gate-full.txt`。逐层归属（`ownerSplit`）指出多出来的不是任务面板，是同一帧上**两句同样的召唤**：
`#tele-hint` 1.74 %（「按 G 跃迁（M 全区地图）」）＋ `#tele-fab` 0.61 %（「✦ 传送 · MAP」）。修法在
产品里而不在尺子里：`src/main.js` 让传送胶囊在**这一条提示**在场时让位（键在条件上，不是"有任何提示"
就藏——电网那条提示请玩家留在原地，那里胶囊是唯一的地图门），并且触屏不藏（`G` 是 `keydown` 监听，
手机上胶囊是唯一的门，所以提示语按 `input.isTouch` 分叉成「点左下的『✦ 传送 · MAP』」）。没有改
`BAR`，也没有加豁免。改后同一帧 **4.28 / 4.85**（`/tmp/j8-fab-full.txt`、`/tmp/j9-full.txt`）。

整卡盒 3 % 那条线也不是一步到位的：五条句子常驻时 `#mission-panel` 是 **6.05 %**，收成一行 +
把 `.mp-title` 留在待机态后是 **3.05 %**（仍超），最后把 `padding` 从 12 px 收到 10 px 才是 **2.93 %**
——省的是内边距不是字号，理由写在 `src/styles.css:143`。

**条件式控件必须两半都验**，所以走查多了一步 `hud:pad-leave`（24 步 → 25 步）：让车真的开下光台。
提示是"藏起来"的，胶囊就必须"回来"，只断言前一半的话，一条写反的条件会永久吃掉传送门。车靠**按住**
W 起来（`holdFrames:120`）：`inp` 逐帧采样按键状态，同一瞬间按下又松开等于给了一脚油门噪声，车不会动。
读数 `{"hint":false,"fab":true,"pos":"-4,1,12"}` → `{"hint":true,"fab":false,"pos":"-11,1,5"}`。

两件踩到的坑：① `opts.hold` 这个名字已经被探针占用了（`window.__AUDHOLD`＝"这一步钉住了哪些层"），
复用它的走查死在 `['mission-panel'].toUpperCase()` 上（`/tmp/j9-pad-full.txt`），改名 `holdKey`；
② 菜单档那一步的 `anchors:["plant did not reach: {\"skipped\":\"anchor not on screen: zero-box\"}"]`
不是漏检——`#speed-val` 在菜单里就是零盒子，探针按 `onScreen()` 报了原因；hud 档 `anchors:[]` 才是
"锚点变异闸门跑过了"的证据。

**闸门自己也被变异过（极性验证）**：把 `#mission-panel` 的 `padding` 从 10 px 改成 40 px（锚点全仓唯一，
`count != 1` 就中止），跑 `menu:quality-std|menu:start|hud:mission-panel$`，闸门如实判负：
`!! hud:mission-panel FAIL §7 density: 盒子 5.67 % > 5; #mission-panel 是 4.79 % 的「底色+描边+模糊」盒 > 3`
→ `MUTATION CAUGHT (gate goes red)`，随后从 `cp -a` 的备份还原，`sha256sum src/styles.css` 回到
`b52efcac…`（干净那次 `STEPS … FAILED 0` 跑的就是这组字节）。这一次还原判定**自己先错过**：脚本写的是
`[ "$(sha256sum < src/styles.css)" = "$BASE" ]`，而 `sha256sum < file` 输出的是 `hash  -`，永远不等于裸
hash —— 于是字节完全一致的文件被判成 `RESTORE FAILED`。假红和假绿一样会骗人（这一次是往"更糟"的方向骗，
下次就会往"更好"的方向骗），改成 `sha256sum file | cut -d' ' -f1` 之后两个极性都验过：当前文件
→ `RESTORED`，一份故意做肥的副本 → `RESTORE FAILED`。

---

## 8 真实点击抓到的两件 DOM 读数看不见的事

【F】1 要求"UI 变更必须真实点击走一遍交互"，于是有了 `tools/cdp-type-click.mjs`：24 步走一遍
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

**判负标准**：`node tools/cdp-type-click.mjs <qa_boot url> 9333` 末行 `STEPS 24 FAILED 0`，
且每个带 `measure` 的状态都是 `min=12 h=0 v=0 collisions=0`、三个 control 全绿。
步数会随手势增加，所以认的是"末行 `FAILED` 后为 0 且这一步的读数在表里"，不是 24 这个字。

**第三个坑（写在尺子的用法上，不是产品上）**：第三个位置参数是 `stepRegex`，用它只跑 HUD 那几步时，
`menu:start` 会被一起滤掉 —— 于是游戏从未启动，`#mp-more` 的矩形是 `0,0,0,0`，七条手势全部红成
"phase \"hud\" never arrived"。这看起来像产品回归，其实是走查被剥掉了入口。子集跑法要么带上
`menu:start`，要么直接跑全程。

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
