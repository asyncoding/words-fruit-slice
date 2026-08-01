// Playwright 验收脚本（拼音描红 v3：挖空 + 虚线边缘 + 逐字母判定）：
// 1) 真实游戏流程端到端：开始游戏 → L1 切瓜 → L2 → 手写蒙层 → 逐字母写字进虚线 → 上方拼音对应字母点亮 → 🎉 → 自动关闭
// 2) 标准书写通过率：蛇形填充字母内部（27 字母 × 5 遍）→ 必须 ≥99%
// 3) 歪写拒绝率：字母上方乱线 / 中部横穿线 → 必须 100% 被要求重写
// 用法: node test/playwright-e2e.mjs [port=8080]
import { chromium } from '/Users/thamelsu/Documents/Code/grade1-practice/game/node_modules/playwright/index.mjs';

const PORT = process.argv[2] || '8080';
const BASE = `http://localhost:${PORT}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const results = [];

const wait = ms => page.waitForTimeout(ms);

// ---------- 1. 打开游戏，进入 L2 手写蒙层 ----------
await page.goto(BASE + '/');
await wait(500);
await page.locator('#startBtn').click();
await wait(800);

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
await wait(800);
await page.locator('.char-card').first().click();
await wait(1200);

const overlayVisible = await page.locator('#hw-overlay').isVisible().catch(() => false);
const pinyinLine = await page.evaluate(() => Array.from(document.querySelectorAll('#hwPinyinLine .py-letter')).map(s => s.textContent).join(''));
const statusTxt = await page.locator('.hw-status').textContent();
results.push(['进入 L2 手写蒙层', overlayVisible ? `PASS (拼音行: ${pinyinLine})` : 'FAIL']);
results.push(['蒙层状态文案', statusTxt.includes('虚线') ? `PASS (${statusTxt})` : `FAIL (${statusTxt})`]);

// 挖空视觉：画布上应有字母轮廓像素（虚线 + 浅色填充）
const drawnPixels = await page.evaluate(() => {
  const hc = document.getElementById('hwCanvas');
  const ctx = hc.getContext('2d');
  const data = ctx.getImageData(0, 0, hc.width, hc.height).data;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
  return n;
});
results.push(['挖空字母渲染', drawnPixels > 3000 ? `PASS (${drawnPixels} px)` : `FAIL (${drawnPixels} px)`]);

// ---------- 2. 书写辅助 ----------
const canvasBox = await page.locator('#hwCanvas').boundingBox();
if (!canvasBox) { console.error('no hwCanvas'); process.exit(1); }

// 沿字母内部采样点蛇形走笔（覆盖全部内部 → 标准书写模拟）
async function drawWordFill() {
  const pts = await page.evaluate(() => hwWordLayout.regionPts.map(p => [p[0], p[1]]));
  if (!pts || !pts.length) throw new Error('no region pts');
  const cols = new Map();
  for (const p of pts) {
    const k = Math.round(p[0]);
    if (!cols.has(k)) cols.set(k, []);
    cols.get(k).push(p);
  }
  const sorted = [];
  const ks = [...cols.keys()].sort((a, b) => a - b);
  ks.forEach((k, i) => {
    const col = cols.get(k).sort((a, b) => a[1] - b[1]);
    if (i % 2) col.reverse();
    sorted.push(...col);
  });
  const picked = sorted.filter((_, i) => i % 3 === 0);
  await page.mouse.move(canvasBox.x + picked[0][0], canvasBox.y + picked[0][1]);
  await page.mouse.down();
  for (const [x, y] of picked.slice(1)) {
    await page.mouse.move(canvasBox.x + x, canvasBox.y + y, { steps: 1 });
  }
  await page.mouse.up();
}

// 歪写：画一条水平线（y: 画布绝对 y）
async function drawHLine(y) {
  await page.mouse.move(canvasBox.x + 20, canvasBox.y + y);
  await page.mouse.down();
  for (let x = 30; x < canvasBox.width - 20; x += 8) {
    await page.mouse.move(canvasBox.x + x, canvasBox.y + y + (x % 16 ? 2 : -2), { steps: 1 });
  }
  await page.mouse.up();
}

// 打开单字母蒙层（递增负 idx 避开 pinyinDone 命中）
let batchSeq = 0;
async function openLetterOverlay(L) {
  await wait(800);  // 等上一样本的停笔判定完全落定，防定时器乱序
  await page.evaluate(({ L, idx }) => {
    openHWOverlay({ character: '测', pinyin: L }, idx);
    hwInkPts = [];
    const el = document.querySelector('#hwMsg');
    el.textContent = ''; el.classList.remove('error');
  }, { L, idx: -1 - batchSeq++ });
  await wait(300);
}

async function readTraceState() {
  return page.evaluate(() => ({
    seqLen: hwTraceSeq.length,
    idx: hwTraceIdx,
    key: hwTraceKey,
    settled: hwTraceSettled,
    lit: document.querySelectorAll('#hwPinyinLine .py-letter.lit').length,
    msg: document.getElementById('hwMsg').textContent,
    done: l2.pinyinDone.length,
  }));
}

// ---------- 3. 标准书写通过率（26 字母 + ü × 5 遍，目标 ≥99%） ----------
const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
letters.push('ü');
let pass = 0, fail = 0;
const failDetail = [];
for (const L of letters) {
  for (let round = 0; round < 5; round++) {
    await openLetterOverlay(L);
    await drawWordFill();
    await wait(1100);
    const st = await readTraceState();
    if (st.settled && st.lit === 1) pass++;
    else { fail++; failDetail.push(`${L}#${round}: settled=${st.settled} lit=${st.lit} msg="${st.msg}"`); }
  }
}
const stdTotal = pass + fail;
const stdRate = stdTotal ? (pass / stdTotal * 100) : 0;
console.log(`\n===== 标准书写通过率（27 字母 × 5 遍 = ${stdTotal} 次）=====`);
console.log(`通过: ${pass}/${stdTotal} (${stdRate.toFixed(1)}%)  失败: ${fail}`);
if (failDetail.length) console.log('失败明细:', failDetail.join(' | '));
results.push(['标准书写通过率', `${stdRate.toFixed(1)}% (${pass}/${stdTotal})`, stdRate >= 99 ? 'PASS' : 'FAIL']);

// ---------- 4. 歪写拒绝率（字母上方乱线 / 中部横穿线，目标 100% 重写） ----------
// 上方乱线：画布顶部 y=20（字母垂直居中，远在字母上方）
// 中部横穿：字母竖直中心画一条贯穿画布的线（只有 ~20% 长度落在字母内 → 内部占比 <60%）
let reject = 0, wrongAccept = 0;
const rejectDetail = [];
for (const L of letters) {
  await openLetterOverlay(L);
  await drawHLine(20);
  await wait(1100);
  let st = await readTraceState();
  if (!st.settled && st.msg.includes('没写准')) reject++; else { wrongAccept++; rejectDetail.push(`${L}#top: settled=${st.settled} msg="${st.msg}"`); }

  await openLetterOverlay(L);
  const midY = await page.evaluate(() => {
    const ys = hwWordLayout.regionPts.map(p => p[1]);
    return (Math.min(...ys) + Math.max(...ys)) / 2;
  });
  await drawHLine(midY);
  await wait(1100);
  st = await readTraceState();
  if (!st.settled && st.msg.includes('没写准')) reject++; else { wrongAccept++; rejectDetail.push(`${L}#mid: settled=${st.settled} msg="${st.msg}"`); }
}
const rejTotal = reject + wrongAccept;
console.log(`\n===== 歪写拒绝率（上方乱线 / 中部横穿 = ${rejTotal} 次）=====`);
console.log(`正确拒绝: ${reject}/${rejTotal} (${(reject / rejTotal * 100).toFixed(1)}%)  误通过: ${wrongAccept}`);
if (rejectDetail.length) console.log('误通过明细:', rejectDetail.join(' | '));
results.push(['歪写拒绝率', `${(reject / rejTotal * 100).toFixed(1)}% (${reject}/${rejTotal})`, wrongAccept === 0 ? 'PASS' : 'FAIL']);

// ---------- 5. 端到端拼音流程（逐字母写 → 对应字母点亮 → 全部完成 → 🎉 → 自动关闭） ----------
await wait(800);  // 等上一轮判定落定
await page.evaluate((idx) => {
  openHWOverlay({ character: '吹', pinyin: 'chuī' }, idx);
  hwInkPts = [];
}, -1 - batchSeq++);
await wait(400);
const e2eTarget = await page.evaluate(() => document.getElementById('hw-target-char').textContent);
const e2eSeq = await page.evaluate(() => hwTraceSeq.join(''));
console.log(`\n===== 端到端拼音流程（目标字: ${e2eTarget}）=====`);
let e2eOk = true;
let finalSt = null;
for (let i = 0; i < 4; i++) {
  const st0 = await page.evaluate(() => ({ key: hwTraceKey, idx: hwTraceIdx }));
  await drawWordFill();
  await wait(1100);   // 700ms 判定
  finalSt = await readTraceState();
  console.log(`  第${i + 1}个字母 (${st0.key}): idx=${finalSt.idx} lit=${finalSt.lit} settled=${finalSt.settled} msg="${finalSt.msg}"`);
  if (finalSt.settled && i < 3) { e2eOk = false; break; }
  if (!finalSt.settled && finalSt.lit !== i + 1) { e2eOk = false; break; }
}
await wait(1500);  // 完成动画 1000ms 后关闭
const overlayClosed = await page.evaluate(() => document.getElementById('hw-overlay').style.display);
const e2ePass = e2eOk && finalSt && finalSt.settled && finalSt.lit === 4 && overlayClosed === 'none';
console.log(`端到端 '${e2eTarget}'（chuī）拼音完成: ${e2ePass ? 'PASS' : 'FAIL'}（seq=${e2eSeq}, 点亮=${finalSt.lit}, 蒙层=${overlayClosed}）`);
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
