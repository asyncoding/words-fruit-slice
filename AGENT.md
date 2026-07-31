# 识字切西瓜 — 开发与优化指南

## 目标

持续优化「识字切西瓜」网页游戏（index.html 单文件版）的：
- **拼音手写识别率**：向 99%+ 努力（CNN 本地识别）
- **首页加载性能**：iPhone 上首屏课文秒开
- **玩法体验**：切西瓜 L1 + 拼音/组词/造句 L2

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
| `index.html` | **主游戏，全部逻辑单文件**（识别、游戏、商店、存档） |
| `game-data.json` | 29 课 617 生字数据（fetch 加载） |
| `game-data.js` | 数据兜底通道（`window.__GAME_DATA`，fetch 失败时 script 标签加载，兼容 file:// 直开） |
| `emnist_cnn.onnx` | 手写识别 CNN 模型（2.54MB，EMNIST+笔画渲染+字体混合重训，首次手写时懒加载） |
| `tools/train/train.py` | 模型重训管线（venv 依赖：torch/torchvision/onnx/onnxruntime/scipy/skimage/PIL；数据与 venv 不入库） |
| `tools/train/make_emnist_strokes.py` | EMNIST 真手写 → 骨架折线笔画轨迹（`--train` 全量/默认 test 采样） |
| `tools/train/add_ij_dots.py` | 给 i/j 无点样本合成点（儿童书写规范，80% 概率补点） |
| `test/hw-overlay-test.html` | **蒙层手写回放测试台**：镜像 index.html 蒙层逻辑，用真实 pointer 事件回放 EMNIST 笔画轨迹，批量测准确率/拒识/混淆（`?samples=N&model=old&pen=N&dump=1`） |
| `test/playwright-e2e.mjs` | **Playwright 端到端验收**（借鉴 grade1-practice 验收体系）：真实游戏流程（L1 切瓜→L2→手写蒙层）+ 26 字母×6 真实鼠标笔画回放 + 真实拼音候选集对比 + 端到端拼音通关；`node test/playwright-e2e.mjs [port]` |
| `test/emnist-strokes.json` | 624 个真实手写笔画轨迹样本（26 字母 × 24，浏览器回放 + 离线验收共用） |
| `vendor/ort/` | onnxruntime-web 1.21.0 本地化（ort.min.js + wasm，37MB）——**CDN 在国内被墙，严禁改回 CDN** |
| `vendor/jieba/` | jieba-wasm 2.4.0 本地化（组词校验用） |
| `minigame/` | 微信小程序版（独立实现，尚无手写功能） |
| `WordsFruitSlice/` | Cocos Creator 工程（独立嵌套 git 仓库，不入本库） |
| `start.sh` | 本地预览：`./start.sh [port]`（默认 3000） |

### 识别流程（全部本地，无云服务）

```
用户手写（canvas，pointer 事件，笔宽 = max(8, min(w,h)*0.05)）→ 停笔 900ms（单一滑动定时器）→ recognizeLetterCNN()
  ├─ 1. 预处理（EMNIST 风格，方向A4）：alpha>20 包围盒 → 等比缩放至 20×20
  │    → 28×28 居中 → 笔画质心对齐 (14,14) → 预乘亮度灰度
  ├─ 2. onnxruntime-web (wasm) 推理 emnist_cnn.onnx（EMNIST 26 个字母类）
  │    模型为 EMNIST 真手写 + 笔画渲染 + 4 款渲染字体混合重训（2.54MB，方向A3 完成）
  │    ⚠️ onnxruntime-web 全部本地化（vendor/ort/），CDN 在国内不可用（曾致加载 164s+ 静默失败）
  ├─ 3. 候选集约束：只在期望拼音去重字母集内取最大概率；集内置信不足 → 回退全局最大并标 lowConf
  ├─ 4. 拒识：lowConf 或 置信度 < HW_MIN_CONF(0.20) → 不采纳，提示重写
  └─ 5. 匹配：结果串 vs 期望拼音（去声调）；前缀错误实时提示第N位
  └─ 6. 带声调输入处理：TONE_MAP 归一化 ü 系（nǚ/lǜ/jù 等）→ 候选集同时含 u 与 v，孩子写 v 也能认
```

### 关键函数（index.html）

| 函数 | 位置 | 作用 |
|------|------|------|
| `loadCNNModel()` | ~794 | 懒加载 onnxruntime-web（动态 script）+ CNN session（wasm） |
| `recognizeLetterCNN()` | ~818 | EMNIST质心对齐预处理→推理→候选集约束/回退→返回字母+置信度+lowConf |
| `openHWOverlay()` | ~867 | 打开手写蒙层，绑定 pointer 事件 |
| `doHWRecognize()` | ~926 | 拒识(lowConf/阈值)→识别→前缀反馈→与期望拼音比对 |
| `initSectionPicker()` | ~1280 | 首页课文按钮渲染（含完成金色边框） |
| `loadGameData()` / `applyGameData()` | ~230 | 数据双通道加载（fetch → script 兜底） |
| `loadSave()` / `writeSave()` | ~300 | localStorage 存档（字段级默认值补全） |
| `initSentenceGame()` 等 | L2 | 造句填空玩法 |
| jieba-wasm | ~1057 | 组词校验（CDN 动态 import，懒加载） |

### 存档格式

`localStorage['wfs-save']`：`{ coins, ownedKnives, equippedKnife, completedSections }`
→ 读取时必须字段级补默认值（老存档缺字段会崩）。

---

## 二、当前识别率瓶颈分析（笔画渲染修复后现状）

**已完成优化**（按时间）：
1. 混合数据重训（EMNIST 真手写 + 渲染字体）+ EMNIST 质心对齐预处理
2. **笔画渲染数据（StrokeDataset）**：EMNIST 骨架折线 → 圆头笔画画布渲染（镜像 app 真实绘制管线），修复「EMNIST 位图 92% 但笔画渲染只有 78%」的 sim-to-real 缺口
3. **i/j 点合成**（add_ij_dots.py）：EMNIST 成人笔迹常省略 i/j 的点（骨架化后与 l 无法区分），按儿童书写规范 80% 补点
4. **笔宽修复**：旧公式 `max(4, w*0.012)` 在 iPhone（360px 画布）只有 4.3px，笔画降采样到 28×28 后 ≈0.5px 淡墨 → 大面积拒识（手机实测 63.8%/拒识 36%）；改为 `max(8, min(w,h)*0.05)` ≈ 18px ≈ EMNIST 2.5px/28×28
5. **笔画级形状变形（deform_strokes）**：弯曲量缩放(0.6~1.5)/闭合空隙调整/顶点尖圆角/近笔画连笔合并——模拟孩子"该弯的写直、该闭合的留缝、弧度不足、连笔"等书写误差
6. **弱字母过采样**：笔画渲染下 g/p/b/q/i/o/d 最易混，×2 过采样

**实测曲线（手机画布 360×420，单字母候选集最严苛场景，浏览器回放 624 真手写样本）：**

| 版本 | 准确率 | 拒识率 | 说明 |
|------|--------|--------|------|
| 旧模型 + 旧细笔 | 63.8% | 36% | 用户反馈"非常差"时的真实体验 |
| 新模型 + 粗笔 | 83.7% | 16% | 模型 1 + 笔宽修复 |
| + 点修复 | 87.2% | 12.8% | i/j 点渲染 |
| + 变形 + 过采样 | **88.1%** | **11.9%** | 错识 0（候选集下要么认对要么拒识） |
| 迭代4 复测（900ms 滑动停笔） | **88.14%** | **11.9%** | 错识 0；真实停顿 700ms 模拟 ru/you/shuang 全过 |
| 迭代5（HW_MIN_CONF 0.30→0.20） | **91.67%**（312 子集）/ 93.1%（624 全量） | 8.3% | 离线 624 网格寻优：th0.20 全赚（错识仅 +2 且真实关卡候选集更小）；同一浏览器口径 88.14%→91.67% |
| 迭代6（Playwright 真实鼠标验收） | **91.0%**（156）/ 92.2%（真实候选集 90） | 9.0% | 独立工具链验证：真实 mouse 事件回放 ≈ browse dispatch 口径（91.67%），确认测试台无系统偏差 |

**迭代5 阈值调优依据（离线 624 样本、真实拼音候选集 multi 模式）**：
- th=0.30: 87.0% / 拒识 73 / 错识 8；th=0.20: **90.2%** / 拒识 50 / 错识 11
- 候选集归一化置信度 `p_best/(p_best+p_outside_max)` 与绝对阈值等价（网格对比无优势），实现复杂度不值，弃用
- 阈值收益来自「候选集外干扰类概率不惩罚候选内正确字母」——写对但字形离群时（如 a 像 q，p_q=0.66 但候选 {a,n}）abs 阈值 0.20 放行，归一化反而拒识

**迭代5 重训实验结论（4 轮全失败，勿重蹈）**：
1. ❌ 回喂 **test** 集错分样本（hard-example mining）：test 泄漏 + 边界过拟合（边界样本 acc 100% 但 624 回放 88.5%→86.7%）
2. ❌ 回喂 **train** 集错分样本 8325×6（13.4% 占比）+ 弱字母 50% 替换采样：分布歪斜，test 92.82%→90.68%
3. ❌ Focal Loss γ=2 从头训练：难样本权重塌缩（pt²≈0.0015），loss≈0 模型冻结在均匀输出（3.85%）
4. ❌ Focal Loss γ=0.5：pt 下溢 0×inf=NaN
5. ✅ 结论：**当前数据下 92.82% test / 88.5% 回放是训练平台期**；提升必须靠**新数据**（真孩子笔迹），不是训练技巧

**残余瓶颈**：
1. **碗状字母弱区分**（g 58%/b 75%/p 75%/d 79% 单字母 top-1）：a/b/d/g/o/p/q 笔画渲染后形状接近（圈+尾笔），需更多真实孩子笔迹或候选集内混淆先验加权
2. **垃圾输入高置信映射**：斜线→x、圆点→o、横竖线→l——乱画恰像期望字母时会被采纳，靠前缀反馈兜底
3. **笔画粒度限制**：停笔（900ms）只识别 1 个字母，字母间停顿 <900ms 会叠墨合并识别（提示文案已引导"稍等片刻"）
4. **首用延迟**：onnxruntime 本地化后 3s（iPhone 弱网更慢，可考虑压缩/缓存策略）

---

## 三、优化方向（优化 Agent 需调研）

### 方向 A：CNN 识别质量（A3/A4/笔画渲染/点合成/笔宽/形状变形 已完成；余下子项可选做）

1. **✅ 混合数据重训（已做）**：EMNIST + 笔画渲染 + 4 款渲染字体，管线在 `tools/train/train.py`
2. **✅ 笔画渲染数据（已做）**：骨架折线圆头笔画渲染，修复 sim-to-real 缺口（StrokeDataset）
3. **✅ i/j 点合成（已做）**：add_ij_dots.py，80% 概率给无点 i/j 补点
4. **✅ 笔宽修复（已做）**：`max(8, min(w,h)*0.05)`，匹配 EMNIST 笔画粗细
5. **✅ 笔画级形状变形（已做）**：弯曲量/闭合空隙/尖圆角/连笔（deform_strokes）
6. **✅ 弱字母过采样（已做）**：g/p/b/q/i/o/d ×2
7. **✅ 拒识阈值调优（已做）**：0.30→0.20，迭代5，+3.5%（离线网格验证，错识 +2 可接受）
8. **多帧投票**：同一字母识别 2-3 次（或滑动窗口），投票取多数
9. **更多真孩子笔迹收集**：当前 EMNIST（成人）+ 合成变形是代理，收集真儿童笔迹加入训练收益最大
10. **候选集约束强化**：结合混淆先验（碗状字母组 a/b/d/g/o/p/q 互混）在候选集内做加权

### 方向 B：后处理增强

1. **拼音音节表验证**：识别结果是否在合法拼音音节表内
2. **上下文感知**：结合当前生字的拼音修正（如当前字"大"，结果应含 d 或 a）
3. **贝叶斯消歧**：基于 EMNIST 混淆矩阵先验做最大似然估计（重训后可离线生成新混淆矩阵）

### 方向 C：用户体验优化

1. **书写指导**：蒙层显示示例字母轮廓，引导规范书写
2. **笔画回放**：识别失败时回放笔画，便于分析问题
3. **渐进式学习**：连续写错 2 次的字母自动提示正确写法
4. **手写入口增强**：L2 拼音 tab 支持直接点字母按钮兜底（识别失败可手选）

### 方向 D：性能优化（首页加载）

1. **数据体积**：game-data.json(237KB)/game-data.js 压缩瘦身或首屏只载课文标题
2. **模型量化**：onnx 转 int8/uint8 量化，体积与推理速度双降
3. **预加载策略**：空闲时（requestIdleCallback）预加载 onnxruntime，手写时只剩模型加载
4. **小程序同步**：把 CNN 方案迁移到 minigame/（当前无手写功能）

---

## 四、验收标准

### 4.1 验收环境

- 浏览器：Safari（iPhone 真机）+ Chrome（桌面）双端
- 工具：Playwright（browse）自动化，见本机 gstack browse
- 本地服务：`./start.sh`（默认 3000 端口）
- 测试用例覆盖 26 字母 + 带声调字母 + 真实课文拼音

### 4.2 验收指标

| 指标 | 目标 | 最新实测 |
|------|------|------|
| 单字母准确率（渲染字体 Arial/Georgia 抖动3变体，浏览器） | ≥ 99% | **98.1%（153/156）**，y→v×3 |
| 单字母准确率（EMNIST 真手写 test 集） | ≥ 90% | **92.82%** |
| 真手写笔画回放（手机画布 360×420，浏览器 pointer 事件，单字母候选集，900ms 滑动停笔） | ≥ 90% | **88.14%（拒识 11.9%、错识 0）**（迭代4 复测） |
| 真手写笔画回放（Playwright 真实鼠标事件，156 样本，单字母候选集） | ≥ 90% | **91.0%（拒识 14、错识 0）**（迭代6，≈browse 口径 91.67%） |
| 真实拼音候选集（Playwright，shuang/dong/you/ru，90 样本） | ≥ 90% | **92.2%（拒识 6、候选内错识 1）** |
| 真手写笔画（离线渲染验收 18px 粗笔，624 样本） | ≥ 90% | **88.0%** |
| 端到端拼音通关（真实停顿 700ms/笔画 + 多字母候选集，浏览器模拟） | ≥ 90% | **ru ✓ you ✓ shuang ✓**（迭代4：g 拒识 2 次后重试通过） |
| 识别延迟（前端 CNN，桌面） | ≤ 100ms | **0.8ms** |
| 首页课文按钮渲染（弱网 iPhone 4G） | ≤ 3s | 懒加载链保持 |
| 首次手写从打开蒙层到可识别 | ≤ 8s（含模型加载） | 本地 vendor 后 3s（迭代4：CDN 曾 164s+ 且失败） |
| 无拒识误判（乱画被当正确字母） | 有阈值拦截 | 候选集外垃圾被拦截；候选集内(斜线→x等)由前缀反馈兜底 |

### 4.3 测试用例

```javascript
// 单字母（CNN 识别）
const SINGLE_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

// 拼音组合（逐字母书写）
const PINYIN_COMBO = [
  'ba','bo','bi','bu','pa','po','pi','pu','ma','mo','mi','mu',
  'da','de','di','du','ta','te','ti','tu','na','ne','ni','nu',
  'ga','ge','gu','ha','he','hu','ji','ju','qi','qu','xi','xu',
  'za','ze','zu','ca','ce','cu','sa','se','su','zhi','chi','shi',
  'an','en','in','un','ang','eng','ing','ong',
  'li','ni','lu','nu','ji','qi','xi',   // 易混淆
  // 带声调（期望去声调比对）
  'ma','ma','ma','ma','da','da','da','da',
];

// 边缘测试
const EDGE_CASES = [
  'a','o','e',      // 单韵母
  'n','g',          // 声母+韵尾
  '',               // 空笔画（应拒识/忽略）
  'aaaa',           // 重复
];
```

### 4.4 验收脚本要点（Playwright，test/playwright-e2e.mjs）

借鉴 grade1-practice 的 Playwright 验收体系（独立于 browse 口径，防系统偏差）。依赖 grade1-practice 仓库的 playwright（本仓库无 node_modules）：

```bash
node test/playwright-e2e.mjs 8080   # 完整验收（≈15 分钟：L1 + 156 批量 + 90 候选集 + 端到端）
```

四段验收：
1. **L1 切瓜**：真实 DOM 事件切 12 个水果 → dialog 弹出
2. **26 字母批量**（6 样本/字母 = 156）：真实 `page.mouse` 事件画 EMNIST 笔画（bbox→150px 字形居中），900ms 停笔识别，单字母候选集
3. **真实拼音候选集**（shuang/dong/you/ru = 90 样本）：候选集 = 目标拼音全字母集，量化真实关卡差距
4. **端到端拼音通关**：逐字母写（笔画间 700ms 停顿 <900ms 合成多笔画字母）→ 🎉 → overlay 自动关闭

**关键经验（踩坑记录，勿重犯）**：
- **顶层 `let` 变量不能通过 `window.x = ...` 覆盖**：index.html 的 `hwCharData/hwRecognized` 是顶层 let（全局词法环境，非 window 属性）。`page.evaluate` 内必须用裸标识符（`hwCharData = ...`、`hwRecognized.length = 0`）才能操作真实变量；`window.x` 只是创建无效的新属性，导致候选集永远停留在初始字、结果数组永远为空
- **openHWOverlay 对已完成 idx 直接 return**（`l2.pinyinDone.some(p => p.idx === idx)`）：批量循环每个样本必须用**递增负 idx**（`-1, -2, ...`），否则成功一次后后续样本全部打不开蒙层
- **成功路径 1s 后自动关闭蒙层**（🎉 → `setTimeout(close, 1000)`）：读结果后若成功需等 ~1.2s 再画下一样本，否则下一样本笔画画到一半蒙层被关（墨迹被截断）
- **drawStrokes 坐标换算**：bbox → `scale = 150/max(bw,bh)` → 画布居中（与测试台一致）。首版误用"字形高度 0.62"公式画到画布外，156 样本 0 墨迹
- **识别结果读取时机**：900ms 停笔定时器 → 画完等 1500ms 再读 `hwMsg/hwRecognized`
- Playwright 版本：import grade1-practice 的 `node_modules/playwright/index.mjs`（本仓库无依赖）

### 4.5 带声调输入处理机制（借鉴 grade1-practice）

**实现**（index.html `doHWRecognize`，~978 行）：
- `TONE_MAP`：韵母声调字符（āáǎà/ēéěè/īíǐì/ōóǒò/ūúǔù）→ 对应字母；`stripTones()` 用 NFD 归一化去除组合变音符
- **ü 系处理**（nǚ/lǜ/jù 等）：拼音含 `üǖǘǚǜ` 时，候选集同时含 `u` 与 `v`（孩子写 v 也能认）；`hasUmlaut` 正则判断后 `[...new Set([...expected, ...(hasUmlaut ? ['v'] : [])])]`
- 与 grade1-practice 差异：grade1 的 TONE_MAP 用于**显示层还原**（识别 v 后显示 ü），本项目候选集直接纳入 u/v 双写兼容

**测试覆盖**：EMNIST 样本无 ü 系字形，需手工写 nǚ/lǜ 验证（浏览器回放 + iPhone 真机各一次）。

---

## 五、迭代流程

### 每次迭代步骤

1. **主 Agent** 确定本次优化目标（从优化方向中选一个）
2. **优化 Agent** 执行：
   - 分析相关代码（重点 `index.html` 内对应函数）
   - 调研业界方案（WebSearch，注意 onnx 量化/拒识/混淆矩阵方向）
   - 实施代码修改
   - **提交 Commit**（`git add -p` 仅添加相关文件，消息写明优化项）
   - 若方案升级导致 AGENT.md 中架构/方向/指标变化 → **同步更新 AGENT.md 并提交**
3. **主 Agent** 确认优化 Agent 输出
4. **验收 Agent** 执行：
   - 更新验收脚本（如有必要）
   - 运行 Playwright 验收（http://localhost:3000，必要时 iPhone 真机 Safari）
   - 记录验收报告到 `acceptance_log.md`
   - 提取经验教训，避免重复踩坑
5. **主 Agent** 评估验收结果：
   - 未达标：回退代码，分析原因，重新迭代
   - 达标：庆祝，进入下一个优化方向

### 断点续作

- 验收 Agent 每次运行后更新 `acceptance_log.md`，记录：
  - 测试时间、测试用例、通过/失败统计
  - 失败案例分析（具体哪个字母/组合失败）
  - 失败原因分析（CNN 误识别、预处理、匹配逻辑）
- 下次迭代时，主 Agent 读取 `acceptance_log.md` 确定优先级

---

## 六、注意事项

1. **不要改坏懒加载链路**：onnxruntime/CNN/jieba 均为首次使用时加载，保持 home 页轻量是铁律
2. **每次只改一个方向**，方便回退和归因
3. **验收必须在真实浏览器中运行**（Playwright），iPhone 用 Safari 网页检查器看 `[game]` 日志
4. **阈值调整要谨慎**：加拒识会降低"误判"，但可能提高"答不对必须重写"的挫败感
5. **模型更换需评估体积**：emnist_cnn.onnx 保持 ≤4MB，否则拉高 iPhone 首用延迟
6. **存档兼容**：任何存档字段的增删改，`loadSave()` 必须字段级补默认值
7. **旧存档数据**：线上用户有历史 localStorage，勿做破坏性迁移
8. **孩子的手写习惯差异大**，测试用例应考虑不同书写风格（潦草、倾斜、大小不一）
9. **遇到问题先和主 Agent 确认**，不要擅自做重大决策
10. **不要引入云 OCR/云识别**：当前架构是纯本地识别（离线可用、无成本、无隐私问题）
11. **CDN 禁令**：onnxruntime/jieba 必须用本地 vendor（国内 jsdelivr 不可用，曾致模型加载 164s+ 静默失败）；`ort.env.wasm.wasmPaths` 必须绝对 URL（`new URL('vendor/ort/', document.baseURI).href`），动态 import 相对 specifier 必须 `./` 前缀
12. **停笔识别定时器**：单一 `hwRecTimer`（up 重置、down 取消），并发 endDraw 窗口会把多笔画字母拆碎（u 3 笔 → a/g 实测复现）；900ms 对单笔画/多笔画字母安全，字母间停顿需 >900ms（提示文案引导）
