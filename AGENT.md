# 识字切西瓜 — 开发与优化指南

## 目标

持续优化「识字切西瓜」网页游戏（index.html 单文件版）的：
- **拼音描红体验**：L2 拼音玩法 = 虚线规范模板 + 沿虚线描摹判定，孩子描对即点亮字母（100% 可达成，不依赖识别）
- **首页加载性能**：iPhone 上首屏课文秒开
- **玩法体验**：切西瓜 L1 + 拼音/组词/造句 L2

> 历史背景：L2 拼音曾用 CNN 手写识别（EMNIST 训练，浏览器回放 91%，真实儿童笔迹只有 ~63%），迭代7 已**完全替换为描红玩法**（无识别、无模型、无 onnx 依赖）。CNN 相关文件仍留在仓库（tools/train/、vendor/ort/、emnist_cnn.onnx），但**不再被玩法使用，不得重新引入**。

## 双 Agent 协作模式

采用"上下文隔离"的双 Agent 方式持续迭代：

```
主 Agent（协调者）
  ├── 优化 Agent（Task 子 agent）→ 分析代码、调研方案、实施优化
  └── 验收 Agent（Task 子 agent）→ 制定验收标准、浏览器验收
```

- 两个子 Agent 上下文隔离，仅通过仓库文件传递信息
- 主 Agent 负责协调决策，不直接执行
- 每次迭代：优化 Agent 输出 → 验收 Agent 验证 → 主 Agent 决策下一步
- **每轮迭代必须提交 commit**；若升级方案发生变化，**同步更新本 AGENT.md**（与代码同一 commit 或紧随其后）

---

## 一、代码架构概览

### 工程结构

| 路径 | 说明 |
|------|------|
| `index.html` | **主游戏，全部逻辑单文件**（描红、切瓜、组词、商店、存档） |
| `game-data.json` | 29 课 617 生字数据（fetch 加载） |
| `game-data.js` | 数据兜底通道（`window.__GAME_DATA`，fetch 失败时 script 标签加载，兼容 file:// 直开） |
| `test/playwright-e2e.mjs` | **Playwright 描红验收**（被 .gitignore 忽略，提交需 `git add -f`）：真实游戏流程 + 标准描摹 130 次 + 歪描 52 次 + 端到端 chuī；`node test/playwright-e2e.mjs [port]`（约 10 分钟） |
| `test/playwright-i8.mjs` | **Playwright 迭代8 验收**：认识字进度弹窗 + 生字本 + 友盟埋点事件断言（`_czc` 缓冲收集）；`node test/playwright-i8.mjs [port]`（约 2 分钟） |
| `minigame/` | 微信小程序版（独立实现，尚无手写功能） |
| `WordsFruitSlice/` | Cocos Creator 工程（独立嵌套 git 仓库，不入本库） |
| `start.sh` | 本地预览：`./start.sh [port]`（默认 3000） |
| ~~tools/train/、vendor/ort/、emnist_cnn.onnx、test/hw-overlay-test.html、test/emnist-strokes.json~~ | CNN 识别遗留物，**玩法已不使用**，勿删勿引 |

### 描红判定流程（全部本地，无识别、无模型）

```
用户沿虚线描摹（#hwCanvas，pointer 事件，墨迹存 hwInkPts）→ 停笔 700ms（全局 hwRecTimer）→ judgeTrace()
  ├─ 1. 墨迹收集：mousedown/pointerdown 起笔 → move 收点（每 ~6px 一个 [x,y] 数组）→ up 结束
  ├─ 2. 空间哈希（buildTraceHash，cell=32px）：墨迹点 → 32×32 网格，3×3 邻居桶查询
  ├─ 3. 双向覆盖率判定（任一不达标 → 提示「✍️ 没描准，再试一次」，保持 hwTraceIdx 不变）：
  │    ├─ 模板覆盖率 tmplCover：模板点（沿虚线步长 TRACE_STEP=4 插值）距最近墨迹 ≤ TRACE_RADIUS(24px) 的比例 ≥ TRACE_TMPL_COVER(0.60)
  │    └─ 墨迹覆盖率 inkCover：墨迹点距最近模板点 ≤ 半径的比例 ≥ TRACE_INK_COVER(0.50)（防乱涂多圈"涂满"骗过 tmplCover）
  ├─ 4. 通过 → hwTraceIdx+1 → 拼音行对应字母点亮（.lit）→ 未完成提示「👍 很好！继续描「x」」/ 完成提示「🎉 你真棒！拼音写完了！」+ playCoin
  └─ 5. 完成 → 1s 后自动关闭蒙层 → l2.pinyinDone.push({idx,char,pinyin}) → renderL2Chars + updateL2Coins
```

**描红模板（TRACE_TEMPLATES）**：26 字母 + 'ü'（含音调符号 ü）共 27 个**程序化规范手写骨架**，坐标统一四线三格体系（cap 顶 y=0、x-height 顶 y=65、基线 y=130、descender y=155~195，x 0~100）。渲染统一 scale：`H_REF=130 → H_PX=min(rect.height*0.5, 200)`，所有字母同一比例（x-height 视觉 100px），画布内上下按比例定位（首字母 cap 顶 +28px）。

**带声调拼音 → 字母序列**（openHWOverlay）：解析拼音行每个字符，`TONE_TO_KEY` 把声调韵母字符（āáǎà/ēéěè/īíǐì/ōóǒò/ūúǔù）映射到无调字母，ü/ü 系（ǖǘǚǜ/ü）→ 'ü' 模板；序列逐字母出题（chūn → c,h,ū,n；chuī → c,h,u,i）。

### 关键函数（index.html）

| 函数 | 位置 | 作用 |
|------|------|------|
| `TRACE_TEMPLATES` | ~789 | 27 个规范手写骨架模板（四线三格坐标） |
| `TONE_TO_KEY` | ~800 | 声调字符 → 模板 key 映射（含 ü 系） |
| `buildTraceHash()` | ~810 | 墨迹点 32px 空间哈希（3×3 邻居桶查询） |
| `judgeTrace()` | ~820 | 双覆盖率判定（tmplCover ≥0.60 && inkCover ≥0.50） |
| `renderTraceTemplate()` | ~850 | 虚线模板绘制（rgba(255,215,0,.45)、lineWidth 12、dash [10,9]）+ 墨迹红色覆盖显示 |
| `traceNext()` | ~890 | 通过后推进字母索引、点亮拼音、完成结算（playCoin + 1s 关闭 + pinyinDone.push） |
| `openHWOverlay()` | ~910 | 打开蒙层：解析拼音行（#hwPinyinLine 逐字符 span）、首字母出题、清定时器/墨迹 |
| `initSectionPicker()` | ~1280 | 首页课文按钮渲染（含完成金色边框） |
| `loadGameData()` / `applyGameData()` | ~230 | 数据双通道加载（fetch → script 兜底） |
| `loadSave()` / `writeSave()` | ~300 | localStorage 存档（字段级默认值补全） |
| jieba-wasm | ~1057 | 组词校验（CDN 动态 import，懒加载） |

### 存档格式

`localStorage['wfs-save']`：`{ coins, ownedKnives, equippedKnife, completedSections, knownChars }`
→ 读取时必须字段级补默认值（老存档缺字段会崩）。`knownChars = [{c: 字符, p: 拼音}]`（已认识生字，跨轮累计去重，每轮完成时合并）。

### 认识字进度（迭代8）

- **"认识"的定义**：本轮 L2 拼音**描红完成**的生字（`l2.pinyinDone` 对应字符）→ 合并进 `save.knownChars`（去重）
- **每轮结束弹窗**（showComplete → mergeKnownChars 增量 >0 时）：`耶！我又认识了 X 个字，总共已经认识了 Y 个字啦！`（#new-chars-overlay，z-index 120，盖在完成页上）+「📖 查看已认识的生字」/「好的」
- **首页入口**：`#knownEntryBtn`（📖 生字本，显示累计数）→ `#known-overlay` 网格列表（字符 + 拼音）
- **友盟 U-Web 埋点**（track 封装，全部 try/catch 静默降级）：
  - SDK：`https://v1.cnzz.com/z.js?id=站点ID`（U-Web/CNZZ 系，注册于 webplus.umeng.com 后填 `UMENG_SITE_ID`；占位符 `YOUR_CNZZ_SITE_ID` 时不加载 SDK 但 track 仍本地收集进 `window._czc` 数组）
  - 事件：`game/session_start`（DAU 辅助）、`btn_expose`/`btn_click`（按钮曝光/点击，label=按钮 id）、`func_expose`/`func_use`（功能曝光/使用，label=level1/level2_pinyin/level2_word/level2_sentence/hw_overlay/shop/complete/known_list/home/new_chars_popup）、`game/round_complete`（label=课文，value=当日累计轮数，localStorage `wfs-rounds-YYYY-M-D` 计数）
  - DAU/UV 由 SDK 自动统计（cookie 唯一访客）

---

## 二、描红调优历史（迭代7）

**玩法决策**（与用户确认）：CNN 自由书写识别成功率太低（真实儿童笔迹 ~63%），完全替换为**描红**（虚线规范模板 + 沿虚线描摹判定）；模板用**程序化规范手写体骨架**（非 EMNIST 样本）；不留自由书写开关。

**关键修复（踩坑记录）**：
1. **hwInkPts 存 [x,y] 数组**：曾存 {x,y} 对象，judgeTrace 读 p[0] 为 undefined → NaN → 全 0% 覆盖
2. **全局 hwRecTimer + openHWOverlay 开头 clearTimeout**：防上一蒙层的 700ms 停笔判定乱序覆盖新墨迹（曾致失败样本 msg=""、歪描误通过）
3. **模板几何统一**：旧模板各字母坐标体系混乱（d bbox 仅 64px 高，偏移 45px 仍 60% 覆盖）；重写为四线三格统一坐标系 + TRACE_RADIUS 26→24 + 统一 scale
4. **判定时机**：700ms 停笔（比旧识别 900ms 短，孩子等待感低）；完成动画 1000ms 后关蒙层

**Playwright 验收结果（迭代7 最终）**：

| 验收项 | 结果 |
|------|------|
| L1 切瓜（12 个真实 DOM 事件） | PASS |
| 进入 L2 手写蒙层（拼音行渲染） | PASS |
| 标准描摹通过率（26 字母 × 5 遍 = 130 次，模板点 + 2px 抖动真实鼠标回放） | **100.0% (130/130)** |
| 歪描拒绝率（只描 25% / 模板上方 30px 乱画线 = 52 次） | **100.0% (52/52)** |
| 端到端 chuī（逐字母描 → 4/4 点亮 → 🎉 → 蒙层自动关闭） | PASS |
| 页面运行时错误 | 0 |

**歪描测试设计教训（勿重蹈）**：
- ❌ 整条模板**平移**（水平/垂直/斜向）作歪描：w/m 斜线周期 30.8px < 2×R=48 → 任何水平偏移必撞线；竖线字母垂直平移自重叠（线长 100px > 偏移 45px）；x 的 45° 交叉斜线与斜向平移平行重叠。**数学上无解**
- ✅ 改用「**不完整描摹**（frac 0.25）+ **位置完全错误的乱线**（模板 bbox 上方 30px 水平线，距模板必然 >R=24px）」——覆盖率必然 <60%

**残余问题/可优化点**：
1. 标准描摹用"模板点 + 抖动"模拟真孩子沿虚线描摹，真实手指/笔的模糊度更高——判定参数（R=24、覆盖率 0.60/0.50）需真机实测微调
2. 描错时无"擦除重来"按钮（只能重描，墨迹叠加）
3. 竖线/斜线类字母（l/i/t/v/w/x/y）对"画一条位置接近的线"宽容度高（R=24px 带宽）——若真机出现"乱画恰好通过"，可加最小点数/线段数约束

**迭代8（认识字进度 + 友盟埋点）要点**：
1. **完成态防护**：traceNext 完成分支置 `hwTraceSettled=true`，judgeTrace 入口检查——完成动画 1000ms 期间再描会重复结算（pinyinDone 重复 push + 金币重复）；曾复现 done=2
2. **埋点验收**：playwright-i8.mjs 用 `page.addInitScript(() => window._czc = [])` 注入缓冲数组（必须在 goto 前注入，否则 session_start 等加载期事件进旧数组被覆盖丢失）；track() 在 `window._czc` 缺失时自行创建数组
3. **认识字弹窗时机**：showComplete 中合并 knownChars 后弹窗（z-index 120 > 完成页 80 < 蒙层 200）；againBtn/exitBtn 需同时关掉弹窗层

---

## 三、优化方向（优化 Agent 需调研）

### 方向 A：描红判定质量

1. **真机校准**：iPhone Safari 真实手指描摹 → 对比 Playwright 100% 下的真实通过率，调 R/覆盖率
2. **容差自适应**：按字母结构分档（直线/曲线/点）给不同半径，或按孩子连写顺畅度（前几次通过 → 放宽）
3. **防涂满作弊**：inkCover 已有；可加"墨迹总长/总点数下限"（画两笔横线涂满不通过）
4. **逐笔画引导**：描错后提示"哪一段没描到"（画半透明绿色高亮未覆盖模板段）

### 方向 B：书写体验

1. **擦除/重来按钮**：蒙层右上角，清空墨迹重描
2. **笔画动画回放**：虚线模板带起始箭头/顺序指示（孩子不知道从哪起笔）
3. **完成庆祝**：字母点亮动画（当前纯变色）、整词完成彩带
4. **进度感**：蒙层显示"第 2/4 个字母"

### 方向 C：玩法扩展

1. **手写模式（可选开关）**：若未来想恢复自由书写，需另训/换方案（见历史：CNN 已移除，勿直接用旧模型）
2. **小程序同步**：minigame/ 加入描红玩法（画布 API 相似，可移植判定逻辑）

### 方向 D：性能优化（首页加载）

1. **数据体积**：game-data.json(237KB)/game-data.js 压缩瘦身或首屏只载课文标题
2. **预加载策略**：requestIdleCallback 预载下一课数据

---

## 四、验收标准

### 4.1 验收环境

- 浏览器：Safari（iPhone 真机）+ Chrome（桌面）双端
- 工具：Playwright（`test/playwright-e2e.mjs`，独立工具链，防系统偏差）
- 本地服务：`./start.sh [port]`（Playwright 验收用 8080）
- 依赖：grade1-practice 仓库的 playwright（本仓库无 node_modules）

### 4.2 验收指标（描红）

| 指标 | 目标 | 最新实测（迭代7） |
|------|------|------|
| 标准描摹通过率（26 字母 × 5 遍 = 130 次，模板点 + 2px 抖动真实鼠标） | ≥ 99% | **100.0% (130/130)** |
| 歪描拒绝率（只描 25% / 模板上方乱线 = 52 次） | 100% | **100.0% (52/52)** |
| 端到端拼音通关（逐字母描 chuī → 4/4 点亮 → 🎉 → 蒙层自动关闭） | PASS | **PASS** |
| L1 切瓜（12 个真实 DOM 事件 → dialog） | PASS | **PASS** |
| 页面运行时错误 | 0 | **0** |
| 判定延迟（停笔 → 反馈） | ≤ 800ms | 700ms 停笔判定 |
| 首次打开蒙层到可描 | 即开即用 | 无模型加载（0 额外延迟） |
| 认识字进度（迭代8，playwright-i8.mjs） | 全 PASS | 新字弹窗文案/生字本列表/knownChars 持久化/入口计数/第二轮不弹窗/埋点事件齐备 |

### 4.3 测试用例

```javascript
// 标准描摹（沿虚线，jitter ±2px）：26 字母 × 5 遍 = 130
// 歪描（应拒绝重描）：
//   1) 只描前 25% 笔画（不完整）
//   2) 模板 bbox 上方 30px 画长横线（位置完全错误）
// 端到端：chuī → c,h,u,i 逐字母 → 🎉 → 蒙层关闭
```

### 4.4 验收脚本要点（Playwright，test/playwright-e2e.mjs）

```bash
node test/playwright-e2e.mjs 8080   # 完整验收（≈10 分钟：L1 + 130 标准 + 52 歪描 + 端到端）
```

五段验收：
1. **L1 切瓜**：真实 DOM 事件切 12 个水果 → dialog 弹出 → 进入 L2 → 点第一个字卡 → 蒙层打开（拼音行渲染正确）
2. **标准描摹 130 次**：读取页面 `hwTmplPts` 每 3 点取 1 + 2px 种子抖动 → 真实 `page.mouse` 沿点描 → 700ms 判定 → 推进（idx===1）
3. **歪描 52 次**：只描 25% / bbox 上方 30px 乱线 → 必须保持 idx===0（要求重描）
4. **端到端 chuī**：逐字母描 → 点亮 4/4 → 🎉 → **等完成动画 1000ms（判定 700ms + 关闭 1000ms = 1700ms，读取需 1.2s+ 缓冲）** → 蒙层 display=none
5. **页面错误**：pageerror 计数 === 0

**关键经验（踩坑记录，勿重犯）**：
- **顶层 `let` 变量不能通过 `window.x = ...` 覆盖**：index.html 的 `hwTraceIdx/hwInkPts/l2` 是顶层 let（全局词法环境，非 window 属性）。`page.evaluate` 内必须用裸标识符（`hwInkPts = []`）才能操作真实变量
- **openHWOverlay 对已完成 idx 直接 return**（`l2.pinyinDone.some(p => p.idx === idx)`）：批量循环每个样本必须用**递增负 idx**（`-1, -2, ...`），否则成功一次后后续样本全部打不开蒙层；单字母批量时 pinyinDone 会累积（130 条），端到端断言**不能依赖 done 总数**，用 lit 数 + 蒙层状态
- **成功路径 1s 后自动关闭蒙层**（🎉 → `setTimeout(close, 1000)`）：读结果后若成功需等 ~1.2s 再画下一样本，否则下一样本笔画画到一半蒙层被关
- **两个样本间必须间隔 ≥800ms**（openLetterOverlay 内部已等）：700ms 停笔判定 + 清理，防乱序
- **歪描不能用模板平移**（见 §二 教训）：w/m 斜线周期 30.8px < 48px 判定带宽，任何水平偏移必撞线；竖线字母垂直平移自重叠；x 交叉斜线与斜向平移平行。只能用「不完整描摹」+「远离模板的乱线」
- **drawTrace 的 offsetY 等选项需真实现**：传了没实现的选项会被静默忽略 → 歪描画成标准描摹 → 误通过（曾致拒绝率崩到 69.2%）
- **蒙层关闭时机**：判定 700ms + 完成动画 1000ms = 1700ms 才关闭，最终断言等待要覆盖（当前 +1.2s）
- Playwright 版本：import grade1-practice 的 `node_modules/playwright/index.mjs`（本仓库无依赖）

### 4.5 带声调拼音处理机制

**实现**（index.html `openHWOverlay`）：
- 拼音行渲染为逐字符 span（#hwPinyinLine .py-letter）
- `TONE_TO_KEY`：声调韵母字符（āáǎà/ēéěè/īíǐì/ōóǒò/ūúǔù）→ 无调字母；ü/ü 系（ü/ǖǘǚǜ）→ 'ü' 模板 key（模板含 umlaut 两点）
- 序列 = 拼音字符串逐字符映射（chūn → c,h,ū,n），无拆音节、无 u/v 同键问题（描红是形状匹配不是识别）

---

## 五、迭代流程

### 每次迭代步骤

1. **主 Agent** 确定本次优化目标（从优化方向中选一个）
2. **优化 Agent** 执行：
   - 分析相关代码（重点 `index.html` 内对应函数）
   - 调研业界方案（WebSearch）
   - 实施代码修改
   - **提交 Commit**（`git add -p` 仅添加相关文件，消息写明优化项）
   - 若方案升级导致 AGENT.md 中架构/方向/指标变化 → **同步更新 AGENT.md 并提交**
3. **主 Agent** 确认优化 Agent 输出
4. **验收 Agent** 执行：
   - 更新验收脚本（如有必要）
   - 运行 Playwright 验收（`node test/playwright-e2e.mjs 8080`，必要时 iPhone 真机 Safari）
   - 记录验收报告到 `acceptance_log.md`
   - 提取经验教训，避免重复踩坑
5. **主 Agent** 评估验收结果：
   - 未达标：回退代码，分析原因，重新迭代
   - 达标：庆祝，进入下一个优化方向

### 断点续作

- 验收 Agent 每次运行后更新 `acceptance_log.md`，记录：
  - 测试时间、测试用例、通过/失败统计
  - 失败案例分析（具体哪个字母/组合失败）
  - 失败原因分析（判定参数、模板几何、测试脚本）
- 下次迭代时，主 Agent 读取 `acceptance_log.md` 确定优先级

---

## 六、注意事项

1. **不要重新引入 CNN/onnx**：迭代7 起 L2 拼音是描红玩法（无识别、无模型、无 onnxruntime 依赖），旧模型文件（emnist_cnn.onnx、vendor/ort/、tools/train/）仅留档不参与构建；`emnist_cnn_iter4/5b.onnx` 等未跟踪文件勿提交
2. **每次只改一个方向**，方便回退和归因
3. **验收必须在真实浏览器中运行**（Playwright），iPhone 用 Safari 网页检查器看 `[game]` 日志
4. **判定参数调整要谨慎**：加严会提高"必须重描"的挫败感，放宽会漏过歪描——改后必须全量重跑五段验收
5. **描红模板几何**：任何模板坐标修改必须保持四线三格统一坐标系（cap 0 / x-height 65 / baseline 130 / descender 155~195，x 0~100），否则各字母 scale 不一致会复现"偏移 45px 仍 60% 覆盖"类误通过
6. **存档兼容**：任何存档字段的增删改，`loadSave()` 必须字段级补默认值
7. **旧存档数据**：线上用户有历史 localStorage，勿做破坏性迁移
8. **孩子的手写/手指习惯差异大**，描红判定需真机实测（手指 vs 鼠标精度差）
9. **遇到问题先和主 Agent 确认**，不要擅自做重大决策
10. **CDN 禁令**（jieba 组词）：必须用本地 vendor（国内 jsdelivr 不可用），动态 import 相对 specifier 必须 `./` 前缀
11. **停笔判定定时器**：单一全局 `hwRecTimer`（up 重置、down 取消），openHWOverlay 开头必须 clearTimeout（防上一蒙层判定乱序覆盖新墨迹）
12. **test/ 目录被 .gitignore 忽略**：验收脚本变更提交需 `git add -f test/playwright-e2e.mjs`
