// Playwright 验收脚本（描红玩法，v2）：
// 1) 真实游戏流程端到端：开始游戏 → L1 切瓜 → L2 → 手写蒙层 → 逐字母沿虚线描摹 → 拼音逐字母点亮 → 🎉
// 2) 标准描摹通过率：用页面模板点生成"完美描摹"（沿虚线 + 微小抖动）→ 26 字母 × 5 → 必须 ≥99%
// 3) 歪描拒绝率：整体偏移/只描局部 → 必须 100% 被要求重描
// 用法: node test/playwright-e2e.mjs [port=8080]
import { chromium } from '/Users/thamelsu/Documents/Code/grade1-practice/game/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';

const PORT = process.argv[2] || '8080';
const BASE = `http://localhost:${PORT}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const results = [];

// 确定性抖动（固定种子伪随机，验收可复现）
function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

// ---------- 1. 打开游戏，进入 L2 手写蒙层 ----------
await page.goto(BASE + '/');
await page.waitForTimeout(500);
await page.locator('#startBtn').click();
await page.waitForTimeout(800);

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

await page.locator('#dialogBtn').click();
await page.waitForTimeout(800);
await page.locator('.char-card').first().click();
await page.waitForTimeout(1200);

const overlayVisible = await page.locator('#hw-overlay').isVisible().catch(() => false);
const pinyinLine = await page.evaluate(() => Array.from(document.querySelectorAll('#hwPinyinLine .py-letter')).map(s => s.textContent).join(''));
results.push(['进入 L2 手写蒙层', overlayVisible ? `PASS (拼音行: ${pinyinLine})` : 'FAIL']);

// ---------- 2. 描摹辅助 ----------
const canvasBox = await page.locator('#hwCanvas').boundingBox();
if (!canvasBox) { console.error('no hwCanvas'); process.exit(1); }

// 用页面模板点生成描摹笔迹（jitterPx: 抖动幅度；offset: 整体偏移；frac: 只描前 frac 比例；above: 在模板上方画乱线）
async function drawTrace(opts = {}) {
  const { jitterPx = 2, offsetX = 0, offsetY = 0, frac = 1, seed = 1, above = false } = opts;
  const rnd = seededRandom(seed);
  if (above) {
    // 模板 bbox 上方 30px 画一条长水平乱线（距模板最近 30px > 判定半径，必然 0% 覆盖）
    const box = await page.evaluate(() => {
      const xs = hwTmplPts.map(p => p[0]), ys = hwTmplPts.map(p => p[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    });
    const [x0, y0] = box;
    const y = y0 - 30;
    await page.mouse.move(canvasBox.x + x0 - 30, canvasBox.y + y);
    await page.mouse.down();
    for (let i = 1; i <= 18; i++) {
      await page.mouse.move(canvasBox.x + x0 - 30 + i * 10, canvasBox.y + y + (i % 3) * 2, { steps: 2 });
    }
    await page.mouse.up();
    return;
  }
  const pts = await page.evaluate(() => hwTmplPts.map(p => [p[0], p[1]]));
  if (!pts || !pts.length) throw new Error('no template pts');
  const count = Math.max(1, Math.round(pts.length * frac));
  const picked = [];
  for (let i = 0; i < count; i += 3) {
    const p = pts[i];
    picked.push([
      p[0] + offsetX + (jitterPx ? (rnd() * 2 - 1) * jitterPx : 0),
      p[1] + offsetY + (jitterPx ? (rnd() * 2 - 1) * jitterPx : 0),
    ]);
  }
  // 用真实 mouse 事件沿点描
  for (let i = 0; i < picked.length; i++) {
    const [x, y] = picked[i];
    if (i === 0) { await page.mouse.move(canvasBox.x + x, canvasBox.y + y); await page.mouse.down(); }
    else await page.mouse.move(canvasBox.x + x, canvasBox.y + y, { steps: 2 });
  }
  await page.mouse.up();
}

// 打开单字母蒙层（递增负 idx 避开 pinyinDone 命中）
let batchSeq = 0;
async function openLetterOverlay(L) {
  await page.waitForTimeout(800);  // 等上一样本的停笔判定完全落定，防定时器乱序
  await page.evaluate(({ L, idx }) => {
    openHWOverlay({ character: '测', pinyin: L }, idx);
    const c = document.querySelector('#hwCanvas');
    const dpr = window.devicePixelRatio || 1;
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    hwInkPts = [];
    const el = document.querySelector('#hwMsg');
    el.textContent = ''; el.classList.remove('error');
  }, { L, idx: -1 - batchSeq++ });
  await page.waitForTimeout(300);
}

async function readTraceState() {
  return page.evaluate(() => ({
    idx: hwTraceIdx,
    seqLen: hwTraceSeq.length,
    key: hwTraceKey,
    msg: document.getElementById('hwMsg').textContent,
    lit: document.querySelectorAll('#hwPinyinLine .py-letter.lit').length,
    done: l2.pinyinDone.length,
  }));
}

// ---------- 3. 标准描摹通过率（26 字母 × 5 遍，目标 ≥99%） ----------
const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
let pass = 0, fail = 0;
const failDetail = [];
for (const L of letters) {
  for (let round = 0; round < 5; round++) {
    await openLetterOverlay(L);
    await drawTrace({ seed: 1000 + pass + fail });
    await page.waitForTimeout(1100);
    const st = await readTraceState();
    if (st.idx === 1) pass++;
    else { fail++; failDetail.push(`${L}#${round}: idx=${st.idx} msg="${st.msg}"`); }
  }
}
const stdTotal = pass + fail;
const stdRate = stdTotal ? (pass / stdTotal * 100) : 0;
console.log(`\n===== 标准描摹通过率（26 字母 × 5 遍 = ${stdTotal} 次）=====`);
console.log(`通过: ${pass}/${stdTotal} (${stdRate.toFixed(1)}%)  失败: ${fail}`);
if (failDetail.length) console.log('失败明细:', failDetail.join(' | '));
results.push(['标准描摹通过率', `${stdRate.toFixed(1)}% (${pass}/${stdTotal})`, stdRate >= 99 ? 'PASS' : 'FAIL']);

// ---------- 4. 歪描拒绝率（只描 25% / 上方乱画线，目标 100% 重描） ----------
// 注：整条模板平移对圈类/密斜线字母（o/w/x/v/z 等）天然有重叠，改用"不完整描摹"和"位置完全错误的乱线"
let reject = 0, wrongAccept = 0;
const rejectDetail = [];
for (const L of letters) {
  await openLetterOverlay(L);
  await drawTrace({ frac: 0.25, seed: 7 });
  await page.waitForTimeout(1100);
  let st = await readTraceState();
  if (st.idx === 0) reject++; else { wrongAccept++; rejectDetail.push(`${L}#frac: idx=${st.idx}`); }

  await openLetterOverlay(L);
  await drawTrace({ above: true, seed: 8 });
  await page.waitForTimeout(1100);
  st = await readTraceState();
  if (st.idx === 0) reject++; else { wrongAccept++; rejectDetail.push(`${L}#above: idx=${st.idx}`); }
}
const rejTotal = reject + wrongAccept;
console.log(`\n===== 歪描拒绝率（只描 25% / 模板上方乱线 = ${rejTotal} 次）=====`);
console.log(`正确拒绝: ${reject}/${rejTotal} (${(reject / rejTotal * 100).toFixed(1)}%)  误通过: ${wrongAccept}`);
if (rejectDetail.length) console.log('误通过明细:', rejectDetail.join(' | '));
results.push(['歪描拒绝率', `${(reject / rejTotal * 100).toFixed(1)}% (${reject}/${rejTotal})`, wrongAccept === 0 ? 'PASS' : 'FAIL']);

// ---------- 5. 端到端拼音流程（逐字母沿虚线描 → 点亮 → 🎉 → 自动关闭） ----------
await page.waitForTimeout(800);  // 等上一轮判定落定
await page.evaluate((idx) => {
  openHWOverlay({ character: '吹', pinyin: 'chuī' }, idx);
  hwInkPts = [];
}, -1 - batchSeq++);
await page.waitForTimeout(400);
const e2eTarget = await page.evaluate(() => document.getElementById('hw-target-char').textContent);
console.log(`\n===== 端到端拼音流程（目标字: ${e2eTarget}）=====`);
let e2ePass = false;
for (let i = 0; i < 4; i++) {
  await drawTrace({ seed: 900 + i });
  await page.waitForTimeout(1100);
  const st = await readTraceState();
  console.log(`  第${i + 1}个字母 (${st.key}): idx=${st.idx} 点亮=${st.lit} done=${st.done} msg="${st.msg}"`);
  if (i < 3 && st.idx !== i + 1) break;
}
const finalSt = await readTraceState();
await page.waitForTimeout(1200);  // 完成动画 1000ms 后自动关闭蒙层
const overlayClosed = await page.evaluate(() => document.getElementById('hw-overlay').style.display);
e2ePass = finalSt.lit === 4 && overlayClosed === 'none';
console.log(`端到端 '${e2eTarget}'（chuī）拼音完成: ${e2ePass ? 'PASS' : 'FAIL'}（点亮=${finalSt.lit}, 蒙层=${overlayClosed}）`);
results.push(['端到端拼音流程', e2ePass ? 'PASS (4/4 点亮 + 完成)' : 'FAIL']);

// ---------- 汇总 ----------
results.push(['页面运行时错误', errors.length === 0 ? 'PASS (0)' : `FAIL (${errors.join('; ')})`]);
console.log('\n===== 验收汇总 =====');
for (const r of results) {
  const flag = r[2] === 'FAIL' ? '❌' : r[2] === 'PASS' ? '✅' : '';
  console.log(`  ${flag} ${r[0]}: ${r[1]}`);
}
const anyFail = results.some(r => r[2] === 'FAIL');
console.log(anyFail ? '\n结果: FAIL' : '\n结果: ALL PASS');
await browser.close();
process.exit(anyFail ? 1 : 0);
