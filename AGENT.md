# 拼音手写识别率优化指南

## 目标

将拼音手写识别成功率优化至 **99.99%**。

## 双 Agent 协作模式

采用"上下文隔离"的双 Agent 方式持续迭代：

```
主 Agent（协调者）
  ├── 优化 Agent（Task 子 agent）→ 分析代码、调研方案、实施优化
  └── 验收 Agent（Task 子 agent）→ 制定验收标准、Playwright 验收
```

- 两个子 Agent 上下文隔离，仅通过仓库文件传递信息
- 主 Agent 负责协调决策，不直接执行
- 每次迭代：优化 Agent 输出 → 验收 Agent 验证 → 主 Agent 决策下一步

---

## 一、代码架构概览

### 识别流程

```
用户手写（canvas）→ 停笔 1.2s → 识别流程
  ├─ 1. 几何识别（前端）: recognizePinyinByGeometry()
  │   针对单字母，纯像素分析，置信度≥0.65 直接返回
  │
  ├─ 2. 百度手写 OCR（后端）: /api/handwrite
  │   前端上传裁剪后的 PNG → 后端同时调用百度手写 OCR + 通用 OCR(ENG)
  │
  └─ 3. 后处理（前端）: fixPinyinText()
      对百度结果做字符映射修正 + 上下文消歧
```

### 关键文件

| 文件 | 作用 |
|------|------|
| `game/public/app.js` | 前端：画布、几何识别、后处理、UI |
| `game/server.js` | 后端：百度 OCR API 转发、结果清洗 |
| `game/public/style.css` | 蒙层样式 |

### 关键函数

| 函数 | 位置 |
|------|------|
| `recognizePinyinByGeometry()` | `app.js:197-654` — 几何识别 |
| `fixPinyinText()` | `app.js:118-181` — 后端结果修正 |
| `trimmedDataUrl()` | `app.js:883-947` — 图片裁剪/白底/黑字 |
| `recognize()` | `app.js:768-841` — 识别主流程 |
| `createHandwritePad()` | `app.js:663-877` — 创建手写组件 |
| `/api/handwrite` | `server.js:415-500` — 后端 API |

---

## 二、当前识别率瓶颈分析

### 1. 几何识别（前端）

- 覆盖 **26 个字母**，基于像素分析（连通分量、闭环检测、中心交叉检测）
- 置信度门槛 0.65，低于此门槛则走百度 API
- 已知问题：
  - **p/r 几何特征几乎相同**，无法区分（返回低置信度 0.6）
  - **s 的 serpentine 检测**依赖 4 角笔画，写不规范时容易漏判
  - **g 的判断**有两条路径，可能互相冲突
  - **宽高比依赖**对书写不规范的孩子不友好（如写得太宽/太窄）

### 2. 百度手写 OCR

- 对**单个英文字母**识别率极低（l/i/o/g/q/x 经常返回空或数字）
- 通用 OCR（ENG 模式）作为兜底，对规整字母更准
- 局限性：
  - 免费版 QPS 限制（code 18 频繁限流）
  - 孩子手写不规范（潦草、笔画重叠、出格）时识别率下降明显
  - 大小写混合、带声调字符处理不稳定

### 3. 后处理修正

- `fixPinyinText()` 映射表覆盖常见误识别（0→o, I→l, ×→x 等）
- 歧义字符消歧（1 在词首→l, 9 在元音后→g）
- 局限性：
  - 多字符场景下 1/9 消歧规则简单，可能误判
  - 声调字符处理不够完善（ü/ê 等）

---

## 三、优化方向（优化 Agent 需调研）

### 方向 A：几何识别增强（优先级最高）

1. **降低置信度门槛**同时增加校验规则，提高几何识别覆盖率
2. **增加笔画方向特征**（stroke direction histogram）区分 p/r
3. **增加笔画宽度变化特征**区分 c/e
4. **增加局部轮廓曲率分析**（contour curvature）提升 s 识别率
5. **多尺度特征融合**：不同分辨率下提取特征再投票

### 方向 B：百度 OCR 调用优化

1. **图片预处理增强**：
   - 笔画加粗/细化（morphological dilation/erosion）
   - 去噪（median filter）
   - 笔画平滑（bezier 插值）
2. **多帧投票**：连续写 2-3 次，投票取多数
3. **多 API 并行**：同时调用百度、阿里、腾讯 OCR 对比
4. **请求重试机制**：限流（code 18）时自动重试

### 方向 C：后处理增强

1. **拼音音节表验证**：识别结果是否在合法拼音音节表内
2. **上下文感知**：结合当前生字的拼音来修正（如已知当前字是"大"，拼音是 da，则识别结果应包含 d 或 a）
3. **贝叶斯消歧**：基于拼音字母频率表做最大似然估计

### 方向 D：用户体验优化

1. **书写指导**：在蒙层上显示示例字母轮廓，引导孩子规范书写
2. **笔画回放**：识别失败时回放笔画，便于分析问题
3. **渐进式学习**：连续写错 2 次的字母，自动弹出提示和正确写法

---

## 四、验收标准

### 4.1 验收环境

- **Node.js** 运行后端服务
- **Playwright** 自动化浏览器操作
- 测试用例覆盖全部 26 个字母 + 带声调字母

### 4.2 验收指标

| 指标 | 目标 |
|------|------|
| 单字母几何识别准确率 | ≥ 99% |
| 拼音字符串识别准确率 | ≥ 99.9% |
| 端到端识别成功率 | ≥ 99.99% |
| 识别延迟（前端几何） | ≤ 50ms |
| 识别延迟（含百度API） | ≤ 2s |
| 限流情况下自动重试 | 自动重试 3 次 |

### 4.3 测试用例

```javascript
// 单字母测试（几何识别为主）
const SINGLE_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

// 拼音组合测试（百度 OCR 为主）
const PINYIN_COMBO = [
  'ba', 'bo', 'bi', 'bu', 'pa', 'po', 'pi', 'pu',
  'ma', 'mo', 'mi', 'mu', 'fa', 'fo', 'fu',
  'da', 'de', 'di', 'du', 'ta', 'te', 'ti', 'tu',
  'na', 'ne', 'ni', 'nu', 'nv', 'la', 'le', 'li', 'lu', 'lv',
  'ga', 'ge', 'gu', 'ka', 'ke', 'ku', 'ha', 'he', 'hu',
  'ji', 'ju', 'qi', 'qu', 'xi', 'xu',
  'za', 'ze', 'zu', 'ca', 'ce', 'cu', 'sa', 'se', 'su',
  'zha', 'zhe', 'zhu', 'cha', 'che', 'chu', 'sha', 'she', 'shu',
  'an', 'en', 'in', 'un', 'ang', 'eng', 'ing', 'ong',
  // 易混淆组合
  'li', 'ni', 'lu', 'nu', 'lv', 'nv',
  'ji', 'qi', 'xi', 'zi', 'ci', 'si',
  'zhi', 'chi', 'shi', 'ri',
  // 带声调
  'mā', 'má', 'mǎ', 'mà',
  'dā', 'dá', 'dǎ', 'dà',
];

// 边缘测试
const EDGE_CASES = [
  'a', 'o', 'e',  // 单韵母
  'n', 'g',        // 声母+韵尾
  '',              // 空笔画
  'aaaa',          // 重复
];
```

### 4.4 验收脚本

验收 Agent 需编写 Playwright 脚本：

```javascript
// 伪代码示例
const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:3000');

// 遍历测试用例
for (const testCase of testCases) {
  // 1. 点击手写按钮
  await page.click('.hw-trigger');
  // 2. 在 canvas 上模拟书写笔画
  await simulateHandwriting(page, testCase);
  // 3. 等待识别结果
  await page.waitForTimeout(2000);
  // 4. 验证输入框内容
  const result = await page.inputValue('.target-input');
  // 5. 记录结果
  logResult(testCase, result);
}

// 生成验收报告
generateReport();
```

---

## 五、迭代流程

### 每次迭代步骤

1. **主 Agent** 确定本次优化目标（从优化方向中选择一个）
2. **优化 Agent** 执行：
   - 分析相关代码
   - 调研业界方案（WebSearch）
   - 实施代码修改
   - 提交 Commit（`git add -p` 仅添加相关文件）
3. **主 Agent** 确认优化 Agent 输出
4. **验收 Agent** 执行：
   - 更新验收脚本（如有必要）
   - 运行 Playwright 验收
   - 记录验收报告到 `acceptance_log.md`
   - 提取经验教训，避免重复踩坑
5. **主 Agent** 评估验收结果：
   - 未达标：回退代码，分析原因，重新迭代
   - 达标：庆祝，进入下一个优化方向

### 断点续作

- 验收 Agent 每次运行后更新 `acceptance_log.md`，记录：
  - 测试时间、测试用例、通过/失败统计
  - 失败案例分析（具体哪个字母/组合失败）
  - 失败原因分析（几何识别、百度 OCR、后处理）
- 下次迭代时，主 Agent 读取 `acceptance_log.md` 确定优先级

---

## 六、注意事项

1. **不要修改几何识别的基础数据结构**（二值化、连通分量、闭环检测这些核心算法已稳定）
2. **每次只改一个方向**，方便回退和归因
3. **验收必须在真实的浏览器中运行**，不能用 Node.js canvas mock
4. **置信度调整要谨慎**：降低门槛可能引入更多误判
5. **百度 OCR 调用有成本**，优化时尽量让几何识别覆盖更多场景
6. **孩子的手写习惯差异大**，测试用例应考虑不同书写风格（潦草、倾斜、大小不一）
7. **遇到问题先和主 Agent 确认**，不要擅自做重大决策