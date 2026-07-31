// Playwright 验收脚本（借鉴 grade1-practice 验收体系）：
// 1) 真实游戏流程端到端：开始游戏 → L1 切瓜 → L2 → 手写拼音蒙层 → 真实鼠标笔画 → 识别上屏断言
// 2) 26 字母批量回归：打开测试台自动批量 → 抓取 [batch-result] 统计
// 用法: node test/playwright-e2e.mjs [port=8080]
import { chromium } from '/Users/thamelsu/Documents/Code/grade1-practice/game/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const PORT = process.argv[2] || '8080';
const BASE = `http://localhost:${PORT}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const results = [];

// ---------- 1. 打开游戏，进入 L2 拼音手写 ----------
await page.goto(BASE + '/');
await page.waitForTimeout(500);
await page.locator('#startBtn').click();  // 开始游戏（课文已自动选中第一课）
await page.waitForTimeout(800);

// L1 切瓜：复用 canvas 切瓜逻辑（内部状态在 window 作用域）
const sliceResult = await page.evaluate(async () => {
  const canvas = document.querySelector('#gameCanvas') || document.querySelector('canvas');
  const rect = canvas.getBoundingClientRect();
  const sliceOne = (f) => {
    const fx = f.x * rect.width / canvas.width;
    const fy = f.y * rect.height / canvas.height;
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: fx - 12, clientY: fy, bubbles: true }));
    for (let i = 1; i <= 5; i++) canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: fx - 12 + 5 * i, clientY: fy + (i % 2) * 3, bubbles: true }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: fx + 12, clientY: fy, bubbles: true }));
  };
  const t0 = Date.now();
  let sliced = 0;
  while (Date.now() - t0 < 60000) {
    const dl = document.getElementById('dialog-overlay');
    if (dl && dl.style.display === 'flex') return { ok: true, ms: Date.now() - t0, sliced };
    if (typeof fruits !== 'undefined') {
      const f = fruits.find(x => !x.sliced);
      if (f) { sliceOne(f); sliced++; }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return { ok: false, sliced };
});
results.push(['L1 切瓜完成', sliceResult.ok ? `PASS (${sliceResult.sliced} 个, ${sliceResult.ms}ms)` : `FAIL (${sliceResult.sliced} 个)`]);

await page.locator('#dialogBtn').click();  // 进入第二关 →
await page.waitForTimeout(800);
await page.locator('.char-card').first().click();
await page.waitForTimeout(1500);

const overlayVisible = await page.locator('#hw-overlay').isVisible().catch(() => false);
results.push(['进入 L2 手写蒙层', overlayVisible ? 'PASS' : 'FAIL']);

// ---------- 2. 笔画回放辅助 ----------
const strokes = JSON.parse(readFileSync(new URL('./emnist-strokes.json', import.meta.url), 'utf-8'));
const canvasBox = await page.locator('#hwCanvas').boundingBox();
if (!canvasBox) { console.error('no hwCanvas'); process.exit(1); }

async function drawStrokes(smp, pauseMs = 40) {
  // 与测试台一致：bbox → 150px 字形高度 → 画布居中（真实鼠标事件）
  const W = canvasBox.width, H = canvasBox.height;
  let minX = 99, minY = 99, maxX = -1, maxY = -1;
  for (const s of smp.strokes) for (const [x, y] of s) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const bw = Math.max(1, maxX - minX + 1), bh = Math.max(1, maxY - minY + 1);
  const scale = 150 / Math.max(bw, bh);
  const offX = (W - bw * scale) / 2, offY = (H - bh * scale) / 2;
  const px = (x) => canvasBox.x + offX + (x - minX) * scale;
  const py = (y) => canvasBox.y + offY + (y - minY) * scale;
  for (const stroke of smp.strokes) {
    if (!stroke.length) continue;
    await page.mouse.move(px(stroke[0][0]), py(stroke[0][1]));
    await page.mouse.down();
    if (stroke.length === 1) {
      await page.mouse.move(px(stroke[0][0]) + 0.4, py(stroke[0][1]) + 0.4);
    } else {
      for (let i = 1; i < stroke.length; i++) {
        await page.mouse.move(px(stroke[i][0]), py(stroke[i][1]), { steps: 3 });
      }
    }
    await page.mouse.up();
    if (pauseMs > 0) await page.waitForTimeout(pauseMs);
  }
}

// ---------- 3. 单字母批量回放（真实鼠标笔画，900ms 停笔识别） ----------
const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
let ok = 0, rej = 0, wrong = 0;
let batchSeq = 0;
const perLetter = {};
const detail = [];

for (const L of letters) {
  const smps = strokes.filter(s => s.letter === L).slice(0, 6);
  for (const smp of smps) {
    // 清画布 & 结果；候选集=目标字母自身（与测试台同口径，测模型基线）
    // 注：① 样本成功 → 🎉 → 1s 后 overlay 自动关闭（close 定时器内 push pinyinDone）；
    //     ② openHWOverlay 对已完成的 idx 直接 return → 用递增负 idx 避开 pinyinDone 命中
    const sampleIdx = -1 - (batchSeq++);
    await page.evaluate(({ L, idx }) => {
      openHWOverlay({ character: L, pinyin: L }, idx);
      const c = document.querySelector('#hwCanvas');
      const dpr = window.devicePixelRatio || 1;
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      c.getContext('2d').clearRect(0, 0, c.width, c.height);
      hwRecognized.length = 0;
      const el = document.querySelector('#hwMsg');
      el.textContent = ''; el.classList.remove('error');
    }, { L, idx: sampleIdx });
    await page.waitForTimeout(300);  // 等蒙层/画布就绪
    await drawStrokes(smp, 40);
    // 等 900ms 停笔 + 识别完成
    await page.waitForTimeout(1500);
    const state = await page.evaluate(() => {
      const msg = document.querySelector('#hwMsg').textContent;
      return { rec: hwRecognized.join(''), msg };
    });
    perLetter[L] = perLetter[L] || { ok: 0, rej: 0, wrong: 0, total: 0 };
    perLetter[L].total++;
    if (state.rec === L) { ok++; perLetter[L].ok++; }
    else if (state.rec === '') { rej++; perLetter[L].rej++; detail.push(`${L}→拒识(${state.msg})`); }
    else { wrong++; perLetter[L].wrong++; detail.push(`${L}→${state.rec}`); }
    if (state.rec === L) await page.waitForTimeout(1200);  // 成功路径 1s 后自动关闭 → 等它完成再画下一个
  }
}

const total = ok + rej + wrong;
console.log(`\n===== 26 字母批量回放（6 样本/字母，真实鼠标笔画）=====`);
console.log(`通过: ${ok}/${total} (${(ok / total * 100).toFixed(1)}%)  拒识: ${rej}  错识: ${wrong}`);
console.log(`最弱字母: ${Object.entries(perLetter).sort((a, b) => (a[1].ok / a[1].total) - (b[1].ok / b[1].total)).slice(0, 5).map(([k, v]) => `${k}:${v.ok}/${v.total}`).join(' ')}`);
if (detail.length) console.log('失败明细:', detail.join(' '));

// ---------- 4. 真实拼音候选集对比（写字母但候选=目标拼音全字母集，量化真实场景差距） ----------
const pinyinCases = [
  { py: 'shuang', chars: ['s', 'h', 'u', 'a', 'n', 'g'] },  // 6 字母（最大候选）
  { py: 'dong', chars: ['d', 'o', 'n', 'g'] },              // 4 字母
  { py: 'you', chars: ['y', 'o', 'u'] },                    // 3 字母
  { py: 'ru', chars: ['r', 'u'] },                          // 2 字母（最小）
];
const realTotal = { ok: 0, rej: 0, wrong: 0, n: 0 };
for (const { py, chars } of pinyinCases) {
  for (const L of chars) {
    const smps = strokes.filter(s => s.letter === L).slice(0, 6);
    for (const smp of smps) {
      const sampleIdx = -1 - (batchSeq++);
      await page.evaluate(({ py, idx }) => {
        openHWOverlay({ character: py, pinyin: py }, idx);
        const c = document.querySelector('#hwCanvas');
        const dpr = window.devicePixelRatio || 1;
        c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
        c.getContext('2d').clearRect(0, 0, c.width, c.height);
        hwRecognized.length = 0;
        const el = document.querySelector('#hwMsg');
        el.textContent = ''; el.classList.remove('error');
      }, { py, idx: sampleIdx });
      await page.waitForTimeout(300);  // 等蒙层/画布就绪
      await drawStrokes(smp, 40);
      await page.waitForTimeout(1500);
      const state = await page.evaluate(() => ({ rec: hwRecognized.join(''), msg: document.querySelector('#hwMsg').textContent }));
      realTotal.n++;
      if (state.rec === L) { realTotal.ok++; await page.waitForTimeout(1200); }
      else if (state.rec === '') realTotal.rej++;
      else realTotal.wrong++;
    }
  }
}
console.log(`\n===== 真实拼音候选集对比（候选=目标拼音全字母集）=====`);
console.log(`通过: ${realTotal.ok}/${realTotal.n} (${(realTotal.ok / realTotal.n * 100).toFixed(1)}%)  拒识: ${realTotal.rej}  候选内错识: ${realTotal.wrong}`);

// ---------- 5. 端到端拼音流程（真实停顿 700ms 多笔画字母） ----------
// 当前蒙层目标字（最后样本为 'ru'）：逐字母写，笔画间 700ms 真实停顿（>900ms 会被识别打断，<900 合成多笔画字母）
const targetPy = await page.evaluate(() => document.querySelector('#hw-target-char').textContent);
console.log(`\n===== 端到端拼音流程（目标字: ${targetPy}）=====`);
const openInfo = await page.evaluate(() => ({
  character: document.querySelector('#hw-target-char').textContent,
  idx: hwCharIdx,
  done: l2.pinyinDone.map(d => d.idx),
}));
console.log('蒙层状态:', JSON.stringify(openInfo));
// 最后一轮样本若成功则蒙层已关 → 用递增 idx 重新打开当前目标字
if (openInfo.character !== targetPy) {
  await page.evaluate((idx) => {
    openHWOverlay({ character: 'ru', pinyin: 'ru' }, idx);
    const c = document.querySelector('#hwCanvas');
    const dpr = window.devicePixelRatio || 1;
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    hwRecognized.length = 0;
  }, -1 - batchSeq++);
  await page.waitForTimeout(400);
} else {
  await page.evaluate(() => {
    hwRecognized.length = 0;
    const area = document.getElementById('hwResultArea');
    area.innerHTML = '';
    const el = document.querySelector('#hwMsg');
    el.textContent = ''; el.classList.remove('error');
  });
}
const pyOk = await (async () => {
  for (const L of 'ru'.split('')) {
    const smp = strokes.find(s => s.letter === L);
    if (!smp) return false;
    await page.evaluate(() => {
      const c = document.querySelector('#hwCanvas');
      const dpr = window.devicePixelRatio || 1;
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      c.getContext('2d').clearRect(0, 0, c.width, c.height);
      const el = document.querySelector('#hwMsg');
      el.textContent = ''; el.classList.remove('error');
    });
    await drawStrokes(smp, 700);  // 笔画间 700ms 停顿（<900ms 不触发识别，合成单字母）
    await page.waitForTimeout(1500);
    const st = await page.evaluate(() => ({ rec: hwRecognized.join(''), msg: document.querySelector('#hwMsg').textContent, vis: document.getElementById('hw-overlay').style.display }));
    console.log(`  写 ${L}: rec=${st.rec} msg=${st.msg} vis=${st.vis}`);
    if (!st.rec.startsWith('r') || (L === 'u' && st.rec !== 'ru')) return false;
    if (L === 'u' && !st.msg.includes('🎉')) return false;
    if (L === 'r' && st.vis !== 'flex') return false;
  }
  return true;
})();
console.log(`端到端 '${targetPy}' 拼音完成: ${pyOk ? 'PASS' : 'FAIL'}`);
results.push(['端到端拼音流程', pyOk ? 'PASS' : 'FAIL']);

results.push(['进入 L2 手写蒙层', overlayVisible ? 'PASS' : 'FAIL']);
results.push(['26 字母批量（6/字母）', `${(ok / total * 100).toFixed(1)}%`]);
results.push(['错识（写对但上屏错字母）', wrong === 0 ? 'PASS (0)' : `FAIL (${wrong})`]);

console.log('\n===== 验收汇总 =====');
for (const [name, r] of results) console.log(`  ${name}: ${r}`);

await browser.close();
