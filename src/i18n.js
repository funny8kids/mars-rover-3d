// ─────────────────────────────────────────────────────────────────────────────────────
// Chinese is the authored language of this base — the strings live where the things they
// describe are built (zone facts in props.js, mission lines in main.js, labels in
// index.html). A second catalogue of files to keep in sync would rot on the first edit, so
// the switcher translates at the moment of display instead: t() looks the authored string up
// in this table and returns English when the toggle is on, falling back to the original for
// anything missed. Adding a line in Chinese therefore still *shows* something rather than
// silently going blank.
// ─────────────────────────────────────────────────────────────────────────────────────

const EN = {
  // ── districts ───────────────────────────────────────────────────────────────────
  中央广场: 'Central Plaza', 星舰发射台: 'Starship Pad', 生活舱区: 'Settlement',
  工厂储罐区: 'Fabrication & Cryo', 通讯阵列: 'Comms Array', 晶体科研区: 'Science Field',
  车辆整备场: 'Motor Pool', 发射观礼台: 'Viewing Deck', 夜空观赏丘: 'Observation Hill',
  残骸场: 'Debris Field', 隐藏彩蛋: 'Easter Egg', 野外: 'Open Mars',
  标准: 'Standard', 高质量: 'High',

  // ── zone cards ──────────────────────────────────────────────────────────────────
  '星港一号 · SPACEPORT GATE 01': 'Spaceport Gate 01',
  '基地心脏 · 六条路线在此交汇': 'The heart of the base · six routes meet here',
  '加压体积 4×920 m³ · 气闸 ×2': 'Pressurised 4 × 920 m³ · 2 airlocks',
  '住 here 的有 24 名工程师与植物学家': 'Home to 24 engineers and botanists',
  '暖光从舷窗透出来的时候，四亿公里外的家也不过如此。':
    'Warm light through a porthole, and home — four hundred million km off — feels that near.',
  '传送平台：驶上光圈即可跃迁': 'Teleport pad: drive onto the ring to jump',
  '按 M 打开全区地图': 'Press M for the full map',
  轨道发射台: 'Orbital Launch Mount',
  '星舰总高 71 m（不锈钢筒身 + 超重型一级）': 'Starship stands 71 m — stainless hull on a Super Heavy',
  '筷子塔高 40 m': 'Chopstick tower: 40 m',
  '任务代号：RED STARBASE': 'Mission code: RED STARBASE',
  '星舰总装塔 · 任务链终点的发射台': 'Starship assembly tower · the launch that ends the chain',
  '在火星，这座塔不只是点火台——它是回家的门票。完成任务链后回到观礼台看它喷火。':
    'On Mars this tower is not a launch pad, it is the ticket home. Finish the chain and come watch it burn.',
  '点火后 60 m 处会感到大气的轻推': 'At 60 m you will feel the atmosphere push back',
  '温室穹顶生物量 ~2.1 t': 'Greenhouse dome biomass ~2.1 t',
  '每块岩石都是一页未读的书。': 'Every rock is an unread page.',
  '撞击玻璃 / 层状硅酸盐 / 橄榄石': 'Impact glass / layered silicates / olivine',
  '大晶体形成年代：约 37 亿年前': 'The great crystal grew ~3.7 billion years ago',
  '样本驾驶驶近即可自动采集': 'Samples: drive close to collect',
  驾驶驶近即可自动采集: 'Drive close to collect',
  '每块岩石都是一页未读的书。好奇号在盖尔坑读了十年。':
    'Every rock is an unread page. Curiosity spent ten years on one.',
  '总装车间净高 18 m': 'Final assembly hall: 18 m clear height',
  'LOX/LCH4 低温储罐 ×3': '3 × LOX/LCH4 cryo tanks',
  '焊接机器人 96 台': '96 welding robots',
  '火星版的“工厂在门口”：推进剂在这里灌装，坏了的零件在这里重焊。':
    'The Martian version of the factory gate: propellant filled here, broken parts re-welded here.',
  '萨巴蒂尔反应器把 CO₂ 变成甲烷——泄漏的每一口都是回家的燃料。':
    'A Sabatier reactor turns CO₂ into methane — every leaked breath is fuel for the way home.',
  推进剂泄漏点: 'Propellant leak',
  'BOG 回收管线 3 路 · 真空夹套': '3 boil-off recovery lines · vacuum jacketed',
  '靠近红色警报阀门组 · 按住交互键约 3 秒': 'Hold the interact key ~3 s at the red alarm valve stack',
  '按住交互键（键盘 E / 触屏「交互」）约 3 秒': 'Hold interact (E, or the on-screen button) ~3 s',
  '主碟 7.3 m · X 波段': '7.3 m primary dish · X band',
  '与地球单程时延 4–24 分钟': 'One-way delay to Earth: 4–24 minutes',
  '日出日落各一次全星通联': 'Two all-planet links a day, at sunrise and sunset',
  '和地球说话要等二十分钟回音。所以基地里的人，早就学会了自己解决问题。':
    'Twenty minutes for an answer from Earth — so the base learned to solve its own problems.',
  '火星的夜晚没有光污染。银河像一道旧伤疤横贯天顶，地球只是其中一颗不特别亮的星。':
    'A Martian night has no light pollution. The Milky Way lies across the zenith like an old scar, and Earth is one star among them, not a bright one.',
  '夜晚：按 N 快进到午夜': 'Night: press N to skip to midnight',
  '残骸场 · 货运飞船“黎明号”': 'Debris field · the cargo ship Aurora',
  '上次事件：全球性沙尘暴 Sol 388': 'Last event: global dust storm, Sol 388',
  '太阳能板蒙尘之后，机遇号也这样安静下来': 'This is how Opportunity went quiet, under a layer of dust',
  '火星的沙尘暴可以持续数月、覆盖整个星球。驶近时按 N 到午夜再来看它，灯笼会替你先亮着。':
    'A Martian dust storm can run for months and take the whole planet. Drive close, press N to midnight, and the lanterns will hold the dark for you.',
  载人车车库: 'Crew Rover Bay',
  '载人火星车 ×1（加压舱 2.4 m³）': '1 × crewed Mars rover (2.4 m³ pressurised cabin)',
  'Optimus 作业机器人 ×2': '2 × Optimus work robots',
  '舱外活动最远行程 12 km': 'EVA range: 12 km',
  '车轮能到的地方不需要火箭。一辆载人火星车就是一座会移动的加压舱。':
    'Where wheels can reach, no rocket is needed. A crewed rover is a pressurised cabin that moves.',
  '等待发射窗口 · 完成任务线后自动点火': 'Awaiting the launch window · ignites when the chain is done',
  '任务完成后回到这里——星舰点火时，火星的大气会把你轻轻推回座椅。':
    'Come back when the work is done — when Starship lights, the atmosphere will ease you into your seat.',
  '隐藏彩蛋：午夜公路': 'Easter egg: the midnight road',
  '2018 年发射 · 飞行 8 年后迫降火星': 'Launched 2018 · reached Mars after eight years',
  '乘客：Starman': 'Passenger: Starman',
  '“Don’t Panic.” —— 他终于到站了。': '“Don’t Panic.” He finally got off at his stop.',
  '视角方位直指 PAD ONE': 'Its viewpoint aims straight at PAD ONE',
  火星矿物样本: 'Martian mineral samples',
  '每一个火星基地都从一块平地开始。这块平地是用 240 台自动推土机铺出来的。':
    'Every Mars base starts as a flat piece of ground. This one took 240 dozers.',

  // ── mission chain ───────────────────────────────────────────────────────────────
  '重启基地电网 {n}/{total} · 开上各区光台并保持':
    'Restore the base grid {n}/{total} · drive onto each pad and hold',
  '修复储罐区泄漏 · 靠近白雾长按 E': 'Seal the tank-farm leak · hold E in the white vent cloud',
  '采集火星样本 {n}/{total} · 驶近发光信标':
    'Collect Martian samples {n}/{total} · drive into the glowing beacons',
  '返回发射观礼台 · 见证星舰升空': 'Return to the viewing deck · watch Starship leave',

  // ── HUD, toasts, hints ──────────────────────────────────────────────────────────
  '欢迎来到 RED STARBASE — 基地断电中，驾驶漫游车重启电网':
    'Welcome to RED STARBASE — the grid is dark. Drive the rover and bring it back.',
  '⏸ 已暂停（Esc 继续）': '⏸ Paused (Esc to resume)', '▶ 继续': '▶ Resumed',
  '▸ 新任务：储罐区检测到推进剂泄漏，靠近白雾长按 E':
    '▸ New objective: propellant leaking at the tank farm — hold E in the vent cloud',
  '▸ 任务链完成 — 发射窗口开启，返回观礼台':
    '▸ Chain complete — the launch window is open, return to the deck',
  '✦ 全区复电 — 基地电网满载，灯光亮度全开':
    '✦ All districts online — the grid is at full load and the lights are wide open',
  '✔ 泄漏已封堵 — 推进剂压力恢复': '✔ Leak sealed — propellant pressure restored',
  '⚠ 电量低于 22% — 返回任一亮起的光台补电':
    '⚠ Charge below 22% — get back to any lit pad and recharge',
  '⚡ 电力耗尽 — 自动回收程序已呼叫，3 秒后拖回中央广场':
    '⚡ Battery empty — recovery called, towing back to Central Plaza in 3 s',
  '◂ 拖回中央广场 — 光台补电中，电量 38%': '◂ Towed to Central Plaza — recharging, 38%',
  '⟲ 探测到卡死 — 自动脱困程序介入，倒出夹缝': '⟲ Deadlock detected — the rover is backing itself out',
  '⟲ 自动脱困 — 抬升车体，滑向最近净空路面': '⟲ Auto-recovery — jacking up and sliding to clear ground',
  '⚠ 自动脱困找不到落点 — 请按 S 倒车离开这里': '⚠ No safe landing found — hold S to reverse out of here',
  '⛔ 该区电网未恢复 — 光台无法成像': '⛔ This district is still dark — the pad cannot image a jump',
  '⚠ 发射程序启动 · 请留在观礼台安全区': '⚠ Launch sequence started · stay inside the deck safety line',
  '★ 已抵达观礼台 — 发射程序即将启动': '★ On the deck — the launch sequence is starting',
  '✦ 星舰灯光秀开始': '✦ Starship light show starting',
  '✦ 星舰已离开大气层 — 「愿它在群星间找到家」':
    '✦ Starship has left the atmosphere — may it find a home among the stars',
  '⚠ 沙尘暴来袭…': '⚠ Dust storm incoming…',
  '沙尘消散 · 天空恢复': 'The dust has settled — the sky is clear',
  '时间快进至深夜 — 银河可见': 'Time advanced to midnight — the galaxy is out',
  '⚠ 检测到帧率偏低 — 已自动降采样': '⚠ Low frame rate — resolution reduced automatically',
  '⚠ 已自动关闭部分特效以保证流畅': '⚠ Some effects switched off to keep the frame rate',
  ' · 已降档': ' · degraded',
  '驶上传送光台后再按 G — 或按 M 打开全区地图直接跃迁':
    'Drive onto a pad, then press G — or press M to jump straight from the map',
  '你在这里': 'You are here', 无电: 'no power', 升空: 'liftoff',
  '环基地计时赛开始 — 依次穿越绿色星环（再按 R 取消）':
    'Base lap time trial — pass the green rings in order (press R again to cancel)',
  '✦ 已保存截图': '✦ Screenshot saved',
  '当前浏览器不支持直接分享 · 已下载图片': 'Sharing is unavailable here — the image was downloaded',
  '音效 开': 'Sound on', '音效 关': 'Sound off',  '✦ 传送 · MAP': '✦ Teleport · MAP',
  '✦ 传送网络 · TELEPORT NETWORK': '✦ Teleport network',
  '数字键 1-6 直接跃迁 · 按 G 在光台上就地开启 · M 全区地图':
    'Number keys 1-6 jump directly · press G while on a pad · M for the full map',
  '暂无记录 · 完成一次环基地计时赛': 'No times yet · finish one lap of the base',
  '「交互」': 'interact', 交互: 'Act', 加速: 'Gas', 刹车: 'Brake', 漂移: 'Drift',
  '密封中…': 'Sealing…',
  '光台已就绪 — 按': 'pad is ready — press',
  跃迁: 'to jump', 全区地图: 'the full map',
  '光台无电 — 复电后才能成像跃迁': 'pad is dark — it cannot image a jump until power returns',
  并网中: 'Linking', 保持停车直到反应桩亮起: 'stay stopped until the tap lights up',
  电量不足: 'Charge too low', '无法并网，先回光台补电': 'cannot link — recharge at a pad first',
  按住: 'Hold', 点亮星舰灯光秀: 'to start the Starship light show',
  '靠近白色雾流，按住': 'Get to the white vent cloud and hold',
  修复: 'to repair', '密封中…': 'Sealing…', 检查点: 'Checkpoints',

  // ── boot sequence, menu, static chrome ──────────────────────────────────────────
  '正在建立下行链路…': 'Establishing downlink…',
  '校准地形高度场…': 'Calibrating the terrain height field…',
  ' sculpting 火星孤岛 · 300m 程序化沙丘…': 'Sculpting a Martian island · 300 m of procedural dunes…',
  '撞击坑与岩石风化场…': 'Craters and weathered regolith…',
  '载入 Blender 建模的星舰基地资产…': 'Loading the Blender-built base assets…',
  '装配漫游车 RD-6 …': 'Assembling the RD-6 rover…',
  '启动火星大气模拟…': 'Starting the Martian atmosphere…',
  '载入渲染管线…': 'Loading the render pipeline…',
  '链路就绪 · 等待指令': 'Link ready · awaiting command',
  '启动失败：': 'Startup failed: ',
  '已根据设备自动推荐：': 'Recommended for this device: ',
  画质: 'Quality', 自适应: 'adaptive', 推荐: 'For you',
  晴朗: 'Clear', 沙尘暴: 'Dust storm', 夜晚: 'Night',
  我在火星开漫游车: 'I drive a rover on Mars',
  选择渲染画质: 'Choose render quality',
  '流畅 · 笔记本与移动端': 'Smooth · laptops and mobile',
  'Bloom + 阴影 + 光晕': 'Bloom + shadows + glow',
  桌面独显: 'Desktop GPU',
  '+SSAO 高粒子 · 超采样': '+SSAO, dense particles, supersampled',
  '启 动 漫 游 车': 'S T A R T  R O V E R',
  '驾驶（低重力漂移）': 'drive (low-gravity drift)',
  手刹: 'handbrake',
  '交互 / 修复': 'interact / repair',
  拍照模式: 'Photo mode',
  '切换天气': 'toggle weather',
  '快进至深夜': 'skip to midnight',
  计时赛: 'time trial',
  菜单: 'menu',
  任务日志: 'Mission log', 电力: 'Power', 排行榜: 'Leaderboard',
  '环基地计时赛 · 排行榜': 'Base lap · leaderboard', 关闭: 'Close',
  '检查点': 'Checkpoints',
  '暂无记录 · 完成一次环基地计时赛': 'No times yet · finish one lap of the base',
  '拍照模式 — 拖动旋转视角 · 滚轮变焦 ·':
    'Photo mode — drag to orbit · wheel to zoom ·',
  快门: 'shutter', 退出: 'exit', 分享截图: 'Share screenshot',
};

let lang = 'zh';
try { if (localStorage.getItem('rsb_lang') === 'en') lang = 'en'; } catch { /* private mode */ }

const subs = new Set();
export const getLang = () => lang;
export const t = s => (lang === 'en' && typeof s === 'string' ? (EN[s] ?? s) : s);
export const onChange = fn => { subs.add(fn); return fn; };

// The shell is authored in index.html, so switching rewrites the DOM in place rather than
// reloading a world that took fifteen seconds to build. Entries are [selector, property, en].
const STATIC = [
  ['#menu .menu-title', 'textContent', 'Choose render quality'],
  ['.q-card[data-q=std] b', 'textContent', 'Standard'],
  ['.q-card[data-q=std] span', 'textContent', 'Smooth · laptops and mobile'],
  ['.q-card[data-q=std] i', 'textContent', 'Bloom + shadows + glow'],
  ['.q-card[data-q=hi] b', 'textContent', 'High quality'],
  ['.q-card[data-q=hi] span', 'textContent', 'Desktop GPU'],
  ['.q-card[data-q=hi] i', 'textContent', '+SSAO, dense particles, supersampled'],
  ['#start-btn', 'textContent', 'S T A R T  R O V E R'],
  ['.mp-title', 'textContent', 'Mission log'],
  ['#battery-tag', 'textContent', 'Power'],
  ['#race-board-btn', 'textContent', 'Leaderboard'],
  ['#race-check', 'textContent', 'Checkpoints 0/5'],
  ['#board-pop h3', 'textContent', 'Base lap · leaderboard'],
  ['#board-close', 'textContent', 'Close'],
  ['#photo-share', 'textContent', 'Share screenshot'],
  ['#t-gas', 'textContent', 'Gas'], ['#t-brake', 'textContent', 'Brake'],
  ['#t-drift', 'textContent', 'Drift'], ['#t-inter', 'textContent', 'Act'],
  ['.controls-hint', 'innerHTML',
    '<span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive (low-gravity drift)</span>'
    + '<span><kbd>Space</kbd> handbrake</span><span><kbd>E</kbd> interact / repair</span>'
    + '<span><kbd>P</kbd> photo mode</span><span><kbd>T</kbd> weather</span>'
    + '<span><kbd>N</kbd> skip to midnight</span><span><kbd>R</kbd> time trial</span>'
    + '<span><kbd>Esc</kbd> menu</span>'],
  ['.photo-tip', 'innerHTML',
    'Photo mode — drag to orbit · wheel to zoom · <kbd>C</kbd> shutter · <kbd>P</kbd> exit'],
];

function applyStatic() {
  for (const [sel, prop, en] of STATIC) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (!el.dataset.zh) el.dataset.zh = el[prop];   // the authored Chinese, captured once
    el[prop] = lang === 'en' ? en : el.dataset.zh;
  }
  // The "recommended" flag is CSS content, so it switches through a custom property.
  document.documentElement.style.setProperty('--rec-label', `"${lang === 'en' ? 'For you' : '推荐'}"`);
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}

export function setLang(next) {
  lang = next === 'en' ? 'en' : 'zh';
  try { localStorage.setItem('rsb_lang', lang); } catch { /* private mode */ }
  applyStatic();
  subs.forEach(f => f());
}

// One control, in the corner of both the menu and the HUD, because a language choice made at
// the start has to be reversible after it.
export function mountLangButton() {
  const b = document.createElement('button');
  b.id = 'lang-btn';
  b.setAttribute('aria-label', 'Switch language / 切换语言');
  const paint = () => { b.textContent = lang === 'zh' ? 'EN' : '中文'; };
  b.onclick = () => { setLang(lang === 'zh' ? 'en' : 'zh'); paint(); };
  document.body.appendChild(b);
  subs.add(paint);
  applyStatic();
  paint();
}
