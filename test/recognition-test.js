// 拼音识别验收测试 — 镜像 index.html recognizeLetterCNN 的预处理与推理逻辑（source: index.html:823-886）
const HW_MIN_CONF = 0.30;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const CANVAS_SIZE = 220;
let session = null;

const results = {
  status: 'running',
  startedAt: 0,
  finishedAt: 0,
  ortVersion: 'onnxruntime-web@1.21.0',
  model: 'emnist_cnn.onnx',
  variants: [],
  perLetter: {},
  confusion: {},
  topConfusions: [],
  summary: {
    total: 0, correct: 0, accuracy: 0,
    candTotal: 0, candAccurate: 0, candGameCorrect: 0, candGameReject: 0, candGameAcceptWrong: 0,
    fbTotal: 0, fbLowConf: 0, fbReturnedTrue: 0,
    rej: [],
    perLetterOk: []
  },
  quick: null,
  latencyMs: null
};

function newCanvas() {
  const c = document.createElement('canvas');
  c.width = CANVAS_SIZE; c.height = CANVAS_SIZE;
  return c;
}

function preprocess28(canvasEl) {
  const ctx2d = canvasEl.getContext('2d');
  const w = canvasEl.width, h = canvasEl.height;
  const imageData = ctx2d.getImageData(0, 0, w, h);
  const pixels = imageData.data;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pixels[(y * w + x) * 4 + 3] > 20) {
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
    }
  }
  if (minX > maxX || minY > maxY) return null;

  // EMNIST 风格预处理：bbox → 等比缩放至 20×20 → 28×28 居中 → 笔画质心对齐 (14,14)
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const scale20 = 20 / Math.max(bw, bh);
  const dw = Math.max(1, Math.round(bw * scale20)), dh = Math.max(1, Math.round(bh * scale20));

  const tmp = document.createElement('canvas');
  tmp.width = 28; tmp.height = 28;
  const tmpCtx = tmp.getContext('2d');
  tmpCtx.drawImage(canvasEl, minX, minY, bw, bh, Math.floor((28 - dw) / 2), Math.floor((28 - dh) / 2), dw, dh);

  const tmpData = tmpCtx.getImageData(0, 0, 28, 28);
  let cx = 0, cy = 0, cnt = 0, tMinX = 28, tMinY = 28, tMaxX = 0, tMaxY = 0;
  for (let y = 0; y < 28; y++) {
    for (let x = 0; x < 28; x++) {
      if (tmpData.data[(y * 28 + x) * 4 + 3] > 20) {
        cx += x; cy += y; cnt++;
        if (x < tMinX) tMinX = x; if (x > tMaxX) tMaxX = x;
        if (y < tMinY) tMinY = y; if (y > tMaxY) tMaxY = y;
      }
    }
  }
  if (!cnt) return null;
  let dx = Math.round(14 - cx / cnt), dy = Math.round(14 - cy / cnt);
  dx = Math.max(-tMinX, Math.min(dx, 27 - tMaxX));
  dy = Math.max(-tMinY, Math.min(dy, 27 - tMaxY));

  const floatArray = new Float32Array(28 * 28);
  for (let y = 0; y < 28; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= 28) continue;
    for (let x = 0; x < 28; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= 28) continue;
      const i = (sy * 28 + sx) * 4;
      const a = tmpData.data[i + 3] / 255.0;
      floatArray[y * 28 + x] = (0.299 * tmpData.data[i] + 0.587 * tmpData.data[i + 1] + 0.114 * tmpData.data[i + 2]) * a / 255.0;
    }
  }
  return floatArray;
}

async function recognize(canvasEl, allowedLetters) {
  if (!session) return null;
  const t0 = performance.now();
  const floatArray = preprocess28(canvasEl);
  if (!floatArray) return null;
  const tensor = new ort.Tensor('float32', floatArray, [1, 1, 28, 28]);
  const out = await session.run({ input: tensor });
  const probs = Array.from(out.output.data);
  let bestIdx = 0, lowConf = false;
  let bestAllowed = -1;
  if (allowedLetters && allowedLetters.length) {
    const allowedSet = new Set(allowedLetters.map(l => l.charCodeAt(0) - 97));
    for (const idx of allowedSet) {
      if (idx >= 0 && idx < 26 && (bestAllowed < 0 || probs[idx] > probs[bestAllowed])) bestAllowed = idx;
    }
    if (bestAllowed >= 0 && probs[bestAllowed] >= HW_MIN_CONF) {
      bestIdx = bestAllowed;
    } else if (bestAllowed >= 0) {
      for (let i = 1; i < 26; i++) if (probs[i] > probs[bestIdx]) bestIdx = i;
      lowConf = true;
    }
  } else {
    for (let i = 1; i < 26; i++) if (probs[i] > probs[bestIdx]) bestIdx = i;
  }
  const globalIdx = probs.indexOf(Math.max(...probs));
  const top3 = probs.map((p, i) => String.fromCharCode(97 + i) + ':' + Math.round(p * 1000) / 1000)
    .sort((a, b) => parseFloat(b.split(':')[1]) - parseFloat(a.split(':')[1])).slice(0, 3).join(' ');
  return {
    letter: String.fromCharCode(97 + bestIdx),
    confidence: Math.round(probs[bestIdx] * 100) / 100,
    lowConf, top3, globalIdx, latency: performance.now() - t0,
    probs
  };
}

function drawGlyph(c, letter, font, size, jx, jy, rotate) {
  const x = c.getContext('2d');
  x.save();
  x.fillStyle = '#fff';
  x.font = `${size}px ${font}`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  if (rotate) x.rotate(rotate);
  x.fillText(letter, CANVAS_SIZE / 2 + jx, CANVAS_SIZE / 2 + jy);
  x.restore();
}

function drawShape(c, kind) {
  const x = c.getContext('2d');
  const cx = CANVAS_SIZE / 2;
  x.strokeStyle = '#fff'; x.lineWidth = 10; x.lineCap = 'round';
  x.beginPath();
  switch (kind) {
    case '横线': x.moveTo(10, cx); x.lineTo(CANVAS_SIZE - 10, cx); break;
    case '竖线': x.moveTo(cx, 10); x.lineTo(cx, CANVAS_SIZE - 10); break;
    case '斜线': x.moveTo(30, 30); x.lineTo(CANVAS_SIZE - 30, CANVAS_SIZE - 30); break;
    case '圆点': x.fillStyle = '#fff'; x.arc(cx, cx, 8, 0, Math.PI * 2); x.fill(); x.beginPath(); break;
    case '乱画':
      for (let i = 0; i < 6; i++) {
        x.moveTo(20 + i * 30, 30 + (i % 3) * 60);
        x.lineTo(50 + i * 30, 80 + (i % 2) * 50);
      }
      break;
  }
  x.stroke();
}

const VARIANTS = [
  { font: 'Arial', jx: 0, jy: 0 },
  { font: 'Arial', jx: 3, jy: -3 },
  { font: 'Arial', jx: -3, jy: 3 },
  { font: 'Georgia', jx: 0, jy: 0 },
  { font: 'Georgia', jx: 3, jy: -3 },
  { font: 'Georgia', jx: -3, jy: 3 },
];

function setStatus(html, cls) {
  document.getElementById('status').innerHTML = `<span class="${cls}">${html}</span>`;
}

async function loadModel() {
  if (session) return;
  setStatus('⏳ 加载 onnxruntime + emnist_cnn.onnx…', 'busy');
  const t0 = performance.now();
  ort.env.wasm.wasmPaths = new URL('../vendor/ort/', document.baseURI).href;
  session = await ort.InferenceSession.create('../emnist_cnn.onnx', {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  results.modelLoadMs = Math.round(performance.now() - t0);
  setStatus(`✅ 模型加载完成（${results.modelLoadMs}ms）`, 'ok');
}

async function runFullTest() {
  results.status = 'running';
  results.startedAt = Date.now();
  await loadModel();
  setStatus('⏳ 单字母测试 26×6 样本…', 'busy');

  const latency = [];
  for (const ch of LETTERS) {
    for (let v = 0; v < VARIANTS.length; v++) {
      const c = newCanvas();
      drawGlyph(c, ch, VARIANTS[v].font, 110, VARIANTS[v].jx, VARIANTS[v].jy, 0);
      const r = await recognize(c, null);
      latency.push(r.latency);
      results.variants.push({
        ch, v, font: VARIANTS[v].font, jx: VARIANTS[v].jx, jy: VARIANTS[v].jy,
        out: r.letter, conf: r.confidence, top3: r.top3
      });
    }
  }
  results.summary.total = results.variants.length;
  results.summary.correct = results.variants.filter(x => x.out === x.ch).length;
  results.summary.accuracy = Math.round(results.summary.correct / results.summary.total * 10000) / 100;
  results.latencyMs = Math.round(latency.reduce((a, b) => a + b, 0) / latency.length * 10) / 10;

  for (const ch of LETTERS) {
    const samples = results.variants.filter(x => x.ch === ch);
    const ok = samples.filter(x => x.out === ch).length;
    results.perLetter[ch] = { ok, total: samples.length, acc: Math.round(ok / samples.length * 1000) / 10 };
    const bad = samples.filter(x => x.out !== ch);
    const cnt = {};
    bad.forEach(b => cnt[b.out] = (cnt[b.out] || 0) + 1);
    const worst = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    results.perLetter[ch].worst = worst ? { letter: worst[0], n: worst[1] } : null;
  }

  results.confusion = {};
  for (const ch of LETTERS) results.confusion[ch] = {};
  results.variants.forEach(x => {
    results.confusion[x.ch][x.out] = (results.confusion[x.ch][x.out] || 0) + 1;
  });
  results.topConfusions = [];
  for (const a of LETTERS) for (const b of LETTERS) {
    if (a === b) continue;
    const n = results.confusion[a][b] || 0;
    if (n > 0) results.topConfusions.push({ from: a, to: b, n });
  }
  results.topConfusions.sort((x, y) => y.n - x.n);

  setStatus('⏳ 候选集约束测试 26×6…', 'busy');
  const S = results.summary;
  for (const ch of LETTERS) {
    const confuser = results.perLetter[ch].worst ? results.perLetter[ch].worst.letter : null;
    const allowed = confuser ? [ch, confuser] : [ch];
    for (const v of VARIANTS) {
      const c = newCanvas();
      drawGlyph(c, ch, v.font, 110, v.jx, v.jy, 0);
      const r = await recognize(c, allowed);
      S.candTotal++;
      const allowedProbs = allowed.map(l => r.probs[l.charCodeAt(0) - 97]);
      const bestAllowedLetter = allowed[allowedProbs.indexOf(Math.max(...allowedProbs))];
      if (bestAllowedLetter === ch) S.candAccurate++;
      if (r.lowConf && r.confidence < HW_MIN_CONF) S.candGameReject++;
      else if (r.letter === ch) S.candGameCorrect++;
      else S.candGameAcceptWrong++;
    }
  }

  setStatus('⏳ 回退保底测试 26×6…', 'busy');
  for (const ch of LETTERS) {
    const bad = results.variants.filter(x => x.ch === ch && x.out !== ch);
    const cnt = {};
    bad.forEach(b => cnt[b.out] = (cnt[b.out] || 0) + 1);
    const topConf = Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(e => e[0]);
    const c1 = topConf[0] || (ch === 'a' ? 'b' : 'a');
    const c2 = topConf[1] || (ch === 'a' ? 'c' : 'b');
    const allowed = [c1, c2];
    for (const v of VARIANTS) {
      const c = newCanvas();
      drawGlyph(c, ch, v.font, 110, v.jx, v.jy, 0);
      const r = await recognize(c, allowed);
      S.fbTotal++;
      if (r.lowConf) S.fbLowConf++;
      if (r.letter === ch) S.fbReturnedTrue++;
    }
  }

  setStatus('⏳ 拒识测试（横线/竖线/斜线/圆点/乱画）…', 'busy');
  for (const shape of ['横线', '竖线', '斜线', '圆点', '乱画']) {
    const c1 = newCanvas(); drawShape(c1, shape);
    const r1 = await recognize(c1, null);
    const c2 = newCanvas(); drawShape(c2, shape);
    const r2 = await recognize(c2, ['c', 'h', 'u', 'n']);
    const gameReject = r2.lowConf && r2.confidence < HW_MIN_CONF;
    S.rej.push({
      shape,
      letterNull: r1.letter, confNull: r1.confidence,
      letterCand: r2.letter, confCand: r2.confidence, lowConf: r2.lowConf,
      gameReject,
      gameWouldAccept: gameReject ? false : r2.letter
    });
  }

  renderAll();
  results.status = 'done';
  results.finishedAt = Date.now();
  window.__testResults = results;
  setStatus(`✅ 测试完成：${S.total} 单字母样本 + ${S.candTotal} 候选 + ${S.fbTotal} 回退 + ${S.rej.length} 拒识样本`, 'ok');
}

function renderAll() {
  const S = results.summary;
  const c1 = document.getElementById('c1');
  c1.textContent = S.accuracy + '%';
  c1.parentElement.className = 'card ' + (S.accuracy >= 95 ? 'good' : S.accuracy >= 90 ? 'warn' : 'bad');
  document.getElementById('c1n').textContent = `${S.correct}/${S.total}（26 字母 × 6 变体）`;

  const c2 = document.getElementById('c2');
  const candAcc = Math.round(S.candAccurate / S.candTotal * 10000) / 100;
  c2.textContent = candAcc + '%';
  c2.parentElement.className = 'card good';
  document.getElementById('c2n').textContent = `约束命中 ${candAcc}% · 游戏口径正确 ${Math.round(S.candGameCorrect / S.candTotal * 1000) / 10}%（${S.candGameCorrect}/${S.candTotal}），误采纳 ${S.candGameAcceptWrong}，拒识 ${S.candGameReject}`;

  const c3 = document.getElementById('c3');
  c3.textContent = Math.round(S.fbReturnedTrue / S.fbTotal * 10000) / 100 + '%';
  c3.parentElement.className = 'card ' + (S.fbReturnedTrue / S.fbTotal >= 0.9 ? 'good' : 'warn');
  document.getElementById('c3n').textContent = `候选集不含真字母时，回退仍返回真字母 ${S.fbReturnedTrue}/${S.fbTotal}；lowConf 标记 ${S.fbLowConf}/${S.fbTotal}`;

  const c4 = document.getElementById('c4');
  const rejOk = S.rej.filter(r => r.gameReject).length;
  c4.textContent = `${rejOk}/${S.rej.length}`;
  c4.parentElement.className = 'card ' + (rejOk === S.rej.length ? 'good' : 'bad');
  document.getElementById('c4n').textContent = `无候选集 conf<0.30：${S.rej.filter(r => r.confNull < HW_MIN_CONF).length}/${S.rej.length}；候选集+游戏判定拦截 ${rejOk}/${S.rej.length}`;

  const tbody = document.querySelector('#per-letter tbody');
  tbody.innerHTML = '';
  for (const ch of LETTERS) {
    const p = results.perLetter[ch];
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><b>${ch}</b></td><td>${p.ok}</td><td>${p.total}</td><td class="${p.acc >= 90 ? 'okc' : 'errc'}">${p.acc}%</td><td class="l">${p.worst ? p.worst.letter + ' ×' + p.worst.n : '—'}</td>`;
    tbody.appendChild(tr);
  }

  const cm = document.getElementById('cm');
  let html = '<tr><th>真\\识</th>';
  for (const b of LETTERS) html += `<th>${b}</th>`;
  html += '</tr>';
  for (const a of LETTERS) {
    html += `<tr><th>${a}</th>`;
    for (const b of LETTERS) {
      const n = results.confusion[a][b] || 0;
      const maxN = 6;
      const frac = Math.min(1, n / maxN);
      const bg = a === b ? `rgba(6,214,160,${0.2 + frac * 0.55})` : `rgba(255,107,107,${frac * 0.6})`;
      html += `<td class="cm-cell${a === b ? ' diag' : ''}" style="background:${bg}">${n || ''}</td>`;
    }
    html += '</tr>';
  }
  cm.innerHTML = html;

  const rt = document.querySelector('#rej tbody');
  rt.innerHTML = '';
  for (const r of S.rej) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.shape}</td>
      <td>${r.letterNull} (${r.confNull.toFixed(2)})</td>
      <td>${r.letterCand} (${r.confCand.toFixed(2)})</td>
      <td>${r.lowConf ? '是' : '否'}</td>
      <td class="${r.gameReject ? 'okc' : 'errc'}">${r.gameReject ? '✅ 拒识' : '❌ 采纳为 ' + r.gameWouldAccept + '（BUG）'}</td>`;
    rt.appendChild(tr);
  }
}

async function runQuickTest(allowedLetters) {
  document.getElementById('sec-quick').style.display = 'block';
  const out = document.getElementById('quick-out');
  await loadModel();
  const rows = [];
  for (const ch of allowedLetters) {
    const draws = [
      { label: 'Arial 居中', font: 'Arial', jx: 0, jy: 0, rot: 0 },
      { label: 'Georgia 居中', font: 'Georgia', jx: 0, jy: 0, rot: 0 },
      { label: 'Arial 旋转8°', font: 'Arial', jx: 2, jy: -2, rot: 0.14 },
    ];
    for (const d of draws) {
      const c = newCanvas();
      drawGlyph(c, ch, d.font, 110, d.jx, d.jy, d.rot);
      const rNone = await recognize(c, null);
      const c2 = newCanvas();
      drawGlyph(c2, ch, d.font, 110, d.jx, d.jy, d.rot);
      const rCand = await recognize(c2, allowedLetters);
      rows.push({
        ch, variant: d.label,
        none: rNone.letter + ' (' + rNone.confidence.toFixed(2) + ')',
        cand: rCand.letter + ' (' + rCand.confidence.toFixed(2) + ')', lowConf: rCand.lowConf,
        noneOk: rNone.letter === ch, candOk: rCand.letter === ch
      });
    }
  }
  results.quick = rows;
  let html = `<table><thead><tr><th>真字母</th><th>变体</th><th>无候选集</th><th>候选集 [${allowedLetters.join(',')}]</th><th>lowConf</th></tr></thead><tbody>`;
  for (const r of rows) {
    html += `<tr><td><b>${r.ch}</b></td><td>${r.variant}</td>
      <td class="${r.noneOk ? 'okc' : 'errc'}">${r.none}</td>
      <td class="${r.candOk ? 'okc' : 'errc'}">${r.cand}</td>
      <td>${r.lowConf ? '是' : '否'}</td></tr>`;
  }
  html += '</tbody></table>';
  out.innerHTML = html;
}

const params = new URLSearchParams(location.search);
const allowedParam = params.get('allowed');

if (allowedParam && /^[a-z]{1,6}$/.test(allowedParam)) {
  window.__testResults = results;
  results.status = 'quick';
  document.getElementById('status').innerHTML = `<span class="ok">⚡ 快速模式：候选集 [${allowedParam.split('')}]</span>`;
  runQuickTest(allowedParam.split('')).then(() => {
    results.finishedAt = Date.now();
    setStatus(`✅ 快速测试完成（${allowedParam.split('').length * 3} 样本）`, 'ok');
  });
} else {
  runFullTest();
}

const manualCanvas = document.getElementById('manualCanvas');
const mctx = manualCanvas.getContext('2d');
mctx.lineWidth = 8; mctx.lineCap = 'round'; mctx.lineJoin = 'round'; mctx.strokeStyle = '#fff';
let mdrawing = false, mlast = null;
manualCanvas.addEventListener('pointerdown', e => {
  mdrawing = true;
  mlast = { x: e.offsetX, y: e.offsetY };
});
manualCanvas.addEventListener('pointermove', e => {
  if (!mdrawing) return;
  mctx.beginPath(); mctx.moveTo(mlast.x, mlast.y); mctx.lineTo(e.offsetX, e.offsetY); mctx.stroke();
  mlast = { x: e.offsetX, y: e.offsetY };
});
manualCanvas.addEventListener('pointerup', () => { mdrawing = false; });
document.getElementById('btnManualClear').addEventListener('click', () => {
  mctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  document.getElementById('manualOut').textContent = '-';
});
document.getElementById('btnManualNone').addEventListener('click', async () => {
  const r = await recognize(manualCanvas, null);
  document.getElementById('manualOut').textContent = r ? `无候选：${r.letter} (conf ${r.confidence.toFixed(2)}) · top3 ${r.top3}` : '无笔迹';
});
document.getElementById('btnManualCand').addEventListener('click', async () => {
  const r = await recognize(manualCanvas, ['c', 'h', 'u', 'n']);
  document.getElementById('manualOut').textContent = r ? `候选集[c,h,u,n]：${r.letter} (conf ${r.confidence.toFixed(2)}, lowConf=${r.lowConf}) · top3 ${r.top3}` : '无笔迹';
});
