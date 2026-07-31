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
| `emnist_cnn.onnx` | 手写识别 CNN 模型（3.5MB，首次手写时懒加载） |
| `minigame/` | 微信小程序版（独立实现，尚无手写功能） |
| `WordsFruitSlice/` | Cocos Creator 工程（独立嵌套 git 仓库，不入本库） |
| `start.sh` | 本地预览：`./start.sh [port]`（默认 3000） |

### 识别流程（全部本地，无云服务）

```
用户手写（canvas，pointer 事件）→ 停笔 400ms → recognizeLetterCNN()
  ├─ 1. 预处理：alpha>20 包围盒裁剪 → 15% 内边距 → 居中缩放到 28×28 黑底
  ├─ 2. onnxruntime-web (wasm) 推理 emnist_cnn.onnx（EMNIST 26 个字母类）
  ├─ 3. 取最大概率类 → a-z；每次停笔识别 1 个字母，追加到结果串
  └─ 4. 匹配：结果串 vs stripTones(期望拼音)（去声调），相等 → 通关标记
```

### 关键函数（index.html）

| 函数 | 位置 | 作用 |
|------|------|------|
| `loadCNNModel()` | ~794 | 懒加载 onnxruntime-web（动态 script）+ CNN session（wasm） |
| `recognizeLetterCNN()` | ~818 | 裁剪→28×28→灰度→推理→返回字母+置信度 |
| `openHWOverlay()` | ~867 | 打开手写蒙层，绑定 pointer 事件 |
| `doHWRecognize()` | ~926 | 识别→结果拼接→与期望拼音比对 |
| `initSectionPicker()` | ~1280 | 首页课文按钮渲染（含完成金色边框） |
| `loadGameData()` / `applyGameData()` | ~230 | 数据双通道加载（fetch → script 兜底） |
| `loadSave()` / `writeSave()` | ~300 | localStorage 存档（字段级默认值补全） |
| `initSentenceGame()` 等 | L2 | 造句填空玩法 |
| jieba-wasm | ~1057 | 组词校验（CDN 动态 import，懒加载） |

### 存档格式

`localStorage['wfs-save']`：`{ coins, ownedKnives, equippedKnife, completedSections }`
→ 读取时必须字段级补默认值（老存档缺字段会崩）。

---

## 二、当前识别率瓶颈分析（CNN 版）

1. **EMNIST 混淆对**：i/l、o/d、m/w、s/z 等字母在 CNN 上易混，孩子写法不规范时更明显
2. **无拒识阈值**：任何笔迹都返回置信度最高的字母，乱画/多余笔画会硬凑出一个字母
3. **笔画粒度限制**：每次停笔（400ms）只识别 1 个字母，多字母拼音需逐字母写；连笔跨越会断错
4. **训练分布偏差**：EMNIST 为成人规整笔迹，与一年级孩子手写差异大
5. **首用延迟**：onnxruntime + 3.5MB 模型首次懒加载约数秒（iPhone 更慢），需防用户误以为卡死

---

## 三、优化方向（优化 Agent 需调研）

### 方向 A：CNN 识别质量（最高优先级）

1. **置信度门槛 + 拒识**：低于阈值提示重写，而不是硬给一个字母
2. **多帧投票**：同一字母识别 2-3 次（或滑动窗口），投票取多数
3. **数据增强重训**：对 EMNIST 做孩子笔迹增强（加粗/抖动/旋转）重训小模型，压缩后 <4MB
4. **预处理对齐**：当前按 alpha 包围盒，可加笔画居中/笔画粗细归一（morphological 加粗/细化、去噪）
5. **候选集约束**：结合当前生字的拼音字母集做 top-k 过滤（如期望 da → 只需区分 d/a）

### 方向 B：后处理增强

1. **拼音音节表验证**：识别结果是否在合法拼音音节表内
2. **上下文感知**：结合当前生字的拼音修正（如当前字"大"，结果应含 d 或 a）
3. **贝叶斯消歧**：基于拼音字母频率表做最大似然估计（EMNIST 混淆矩阵先验）

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

| 指标 | 目标 |
|------|------|
| 单字母识别准确率（规范书写） | ≥ 95% |
| 端到端拼音通关成功率（真实课文抽样） | ≥ 90% |
| 识别延迟（前端 CNN，桌面） | ≤ 100ms |
| 首页课文按钮渲染（弱网 iPhone 4G） | ≤ 3s |
| 首次手写从打开蒙层到可识别 | ≤ 8s（含模型加载） |
| 无拒识误判（乱画被当正确字母） | 有阈值拦截 |

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

### 4.4 验收脚本要点（Playwright）

```javascript
// 伪代码示例
const { chromium } = require('playwright');
const page = await (await chromium.launch()).newPage();
await page.goto('http://localhost:3000');

for (const testCase of testCases) {
  // 1. 进入某课 → 完成 L1（或直接用存档跳过）→ L2 拼音 tab
  // 2. 点击生字卡 → 打开 hw-overlay
  // 3. 在 #hwCanvas 上模拟书写（mouse events）
  // 4. 等待 1.5s → 检查 overlay 是否自动关闭 + 卡片是否出现 .done
  // 5. 记录结果（PASS/FAIL + 实际识别串，可从 console/state 读取）
}
generateReport();
```

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
