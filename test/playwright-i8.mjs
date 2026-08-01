// Playwright 验收脚本（迭代8：认识字进度 + 友盟埋点）
// 1) 埋点：_czc 本地缓冲收集 → 断言 session/曝光/点击/轮次完成事件
// 2) 新字弹窗：完成一轮（L1→L2→完成）认识 1 字 → 弹窗文案/查看列表
// 3) 持久化：knownChars 存档 + 首页生字本入口计数
// 4) 第二轮（无新字）→ 不弹窗，round_complete 计数递增
// 用法: node test/playwright-i8.mjs [port=8080]
import { chromium } from '/Users/thamelsu/Documents/Code/grade1-practice/game/node_modules/playwright/index.mjs';

const PORT = process.argv[2] || '8080';
const BASE = `http://localhost:${PORT}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const results = [];

// 事件收集 helper（_czc 数组缓冲 = track() 写入处）
const ev = () => page.evaluate(() => window._czc || []);
const hasEv = (cat, act, label) => ev().then(list => list.some(e => e[0] === '_trackEvent' && e[1] === cat && e[2] === act && (label === undefined || e[3] === label)));
const evCount = (act, label) => ev().then(list => list.filter(e => e[0] === '_trackEvent' && e[2] === act && (label === undefined || e[3] === label)).length);

// ---------- L1 切瓜（真实 DOM 事件） ----------
const sliceAllFruits = async (timeoutMs = 60000) => {
  const ok = await page.evaluate(async (t0cap) => {
    const canvas = document.querySelector('#gameCanvas') || document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const sliceOne = (f) => {
      const fx = f.x * rect.width / canvas.width, fy = f.y * rect.height / canvas.height;
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: fx - 12, clientY: fy, bubbles: true }));
      for (let i = 1; i <= 5; i++) canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: fx - 12 + 5 * i, clientY: fy + (i % 2) * 3, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent('mouseup', { clientX: fx + 12, clientY: fy, bubbles: true }));
    };
    const t0 = Date.now();
    while (Date.now() - t0 < t0cap) {
      const dl = document.getElementById('dialog-overlay');
      if (dl && dl.style.display === 'flex') return true;
      if (typeof fruits !== 'undefined') { const f = fruits.find(x => !x.sliced); if (f) sliceOne(f); }
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  }, timeoutMs);
  return ok;
};

// ---------- 描一个字的完整拼音（真实鼠标沿虚线，循环到蒙层自动关闭） ----------
async function traceFullPinyin() {
  const canvasBox = await page.locator('#hwCanvas').boundingBox();
  let guard = 0;
  while (guard < 12) {
    const open = await page.evaluate(() => document.getElementById('hw-overlay').style.display);
    if (open !== 'flex') break;
    const pts = await page.evaluate(() => hwTmplPts.map(p => [p[0], p[1]]));
    await page.mouse.move(canvasBox.x + pts[0][0], canvasBox.y + pts[0][1]);
    await page.mouse.down();
    for (let i = 3; i < pts.length; i += 3) {
      await page.mouse.move(canvasBox.x + pts[i][0], canvasBox.y + pts[i][1], { steps: 2 });
    }
    await page.mouse.up();
    await wait(1150);  // 700ms 判定 + 推进
    guard++;
  }
  await wait(1150);  // 完成动画 1000ms 后关闭
}

const wait = ms => page.waitForTimeout(ms);
const click = id => page.locator('#' + id).click();

// ==================== 0. 页面加载 + 首页埋点 ====================
await page.addInitScript(() => { window._czc = []; });
await page.goto(BASE + '/');
await wait(600);
const s1 = await hasEv('game', 'session_start');
const s2 = await hasEv('func_expose', 'home');
const s3 = await hasEv('btn_expose', 'startBtn');
const s4 = await hasEv('btn_expose', 'knownEntryBtn');
results.push(['首页埋点', s1 && s2 && s3 && s4 ? `PASS (session_start/home/startBtn/knownEntryBtn)` : `FAIL s1=${s1} s2=${s2} s3=${s3} s4=${s4}`]);

// 生字本入口初始文案（无已知字 → 不带计数）
const entryTxt0 = await page.locator('#knownEntryBtn').textContent();
results.push(['生字本入口初始', entryTxt0.includes('（') ? `FAIL (${entryTxt0})` : 'PASS']);

// 商店曝光
await click('menuShopBtn');
await wait(300);
const s5 = await hasEv('func_expose', 'shop');
await click('shopCloseBtn');
await wait(200);
results.push(['商店曝光/点击', (s5 && await hasEv('btn_click', 'menuShopBtn') && await hasEv('btn_click', 'shopCloseBtn')) ? 'PASS' : 'FAIL']);

// ==================== 1. 第一轮：L1 → L2 → 描 1 字 → 完成 ====================
await click('startBtn');
await wait(300);
const s6 = await hasEv('btn_click', 'startBtn');
const ok1 = await sliceAllFruits();
results.push(['L1 切瓜', ok1 ? 'PASS' : 'FAIL']);

const s7 = await hasEv('btn_expose', 'dialogBtn');
await click('dialogBtn');
await wait(800);
const s8 = await hasEv('func_expose', 'level2_pinyin') && await hasEv('func_use', 'level2_pinyin');
const s9 = await hasEv('btn_expose', 'l2FinishBtn');
results.push(['L2 进入 + 曝光', (s7 && s8 && s9) ? 'PASS' : `FAIL dialogExpose=${s7} l2=${s8} finishExpose=${s9}`]);

// 描完整拼音（循环到蒙层自动关闭）
await page.locator('.char-card').first().click();
await wait(1200);
await traceFullPinyin();
const s10 = await hasEv('func_expose', 'hw_overlay') && await hasEv('func_use', 'hw_overlay');
const hwClosed = await page.evaluate(() => document.getElementById('hw-overlay').style.display);
const doneCount = await page.evaluate(() => l2.pinyinDone.length);
results.push(['描红完成 1 字', (s10 && hwClosed === 'none' && doneCount === 1) ? 'PASS' : `FAIL expose=${s10} hw=${hwClosed} done=${doneCount}`]);

// 完成本轮
await click('l2FinishBtn');
await wait(500);
const s11 = await hasEv('btn_click', 'l2FinishBtn');
const rc1 = await evCount('round_complete');
const popupVisible = await page.locator('#new-chars-overlay').isVisible();
const popupMsg = await page.locator('#newCharsMsg').textContent();
const s12 = await hasEv('func_expose', 'new_chars_popup');
const s13 = await hasEv('btn_expose', 'againBtn');
results.push(['完成页 + 埋点', (s11 && rc1 === 1 && s12 && s13) ? 'PASS' : `FAIL click=${s11} rc=${rc1} popup=${s12} again=${s13}`]);
results.push(['新字弹窗', (popupVisible && popupMsg.includes('1') && popupMsg.includes('认识了 1')) ? `PASS (${popupMsg})` : `FAIL visible=${popupVisible} msg=${popupMsg}`]);

// 弹窗查看已认识生字
await click('newCharsViewBtn');
await wait(300);
const knownVisible = await page.locator('#known-overlay').isVisible();
const knownCards = await page.locator('#knownGrid .ko-card').count();
const knownCountTxt = await page.locator('#knownCount').textContent();
results.push(['弹窗→生字本列表', (knownVisible && knownCards === 1 && knownCountTxt.includes('1')) ? 'PASS' : `FAIL vis=${knownVisible} cards=${knownCards} ${knownCountTxt}`]);

// 关闭 → 返回首页 → 入口带计数
await click('knownCloseBtn');
await wait(200);
await click('exitBtn');
await wait(500);
const entryTxt1 = await page.locator('#knownEntryBtn').textContent();
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wfs-save') || '{}').knownChars || []);
results.push(['knownChars 持久化', (entryTxt1.includes('1') && saved.length === 1) ? `PASS (${entryTxt1})` : `FAIL entry=${entryTxt1} saved=${saved.length}`]);

// 首页入口 → 生字本
await click('knownEntryBtn');
await wait(300);
const knownVisible2 = await page.locator('#known-overlay').isVisible();
const knownCards2 = await page.locator('#knownGrid .ko-card').count();
await click('knownCloseBtn');
await wait(200);
results.push(['首页生字本入口', knownVisible2 && knownCards2 === 1 ? 'PASS' : `FAIL vis=${knownVisible2} cards=${knownCards2}`]);

// ==================== 2. 第二轮：无新字 → 不弹窗 ====================
await click('startBtn');
await wait(300);
const ok2 = await sliceAllFruits();
await click('dialogBtn');
await wait(800);
await click('l2FinishBtn');
await wait(500);
const popupVisible2 = await page.locator('#new-chars-overlay').isVisible();
const rc2 = await evCount('round_complete');
results.push(['第二轮无新字', (!popupVisible2 && rc2 === 2) ? 'PASS' : `FAIL popup=${popupVisible2} rc=${rc2}`]);

// ==================== 汇总 ====================
results.push(['页面运行时错误', errors.length === 0 ? 'PASS (0)' : `FAIL (${errors.join('; ')})`]);
console.log('\n===== 迭代8 验收汇总 =====');
for (const r of results) {
  const flag = r[1].startsWith('FAIL') ? '❌' : r[1].startsWith('PASS') ? '✅' : '';
  console.log(`  ${flag} ${r[0]}: ${r[1]}`);
}
const anyFail = results.some(r => r[1].startsWith('FAIL'));
console.log(anyFail ? '\n结果: FAIL' : '\n结果: ALL PASS');
await browser.close();
process.exit(anyFail ? 1 : 0);
