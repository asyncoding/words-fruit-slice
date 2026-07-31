const { state, getSections, REWARDS, calcCoins } = require('./data')
const { playComplete } = require('./audio')

let W, H, ctx, buttons = [], charCards = [], touchZones = {}
let TOP = 0, BOTTOM = 0, YH = 0

function init(c, w, h, topInset, bottomInset) {
  ctx = c; W = w; H = h
  TOP = topInset; BOTTOM = bottomInset; YH = H - TOP - BOTTOM
}

function clearButtons() { buttons = []; charCards = []; touchZones = {} }

function addBtn(id, x, y, w, h, label, color) {
  const b = { id, x, y, w, h, label, color: color || '#e94560' }
  buttons.push(b)
  return b
}

function addZone(id, x, y, w, h) { touchZones[id] = { x, y, w, h } }

function drawRoundRect(x, y, w, h, r, fill) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
  if (fill) { ctx.fillStyle = fill; ctx.fill() }
}

function drawBackground() {
  const g = ctx.createLinearGradient(0, TOP, 0, H - BOTTOM)
  g.addColorStop(0, '#1a1a2e'); g.addColorStop(0.5, '#16213e'); g.addColorStop(1, '#0f3460')
  ctx.fillStyle = g; ctx.fillRect(0, TOP, W, YH)
  for (let i = 0; i < 30; i++) {
    const x = (i * 137 + 50) % W, y = TOP + ((i * 97 + 30) % YH), r = 0.5 + (i % 3)
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255,255,255,${0.03 + (i % 5) * 0.01})`; ctx.fill()
  }
}

function drawText(text, x, y, size, color, align) {
  ctx.fillStyle = color || '#fff'
  ctx.font = `bold ${size}px "PingFang SC","Microsoft YaHei",sans-serif`
  ctx.textAlign = align || 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y)
}

function drawStartScreen() {
  drawBackground()
  drawText('🍉 识字切西瓜', W / 2, TOP + YH * 0.06, 44, '#fff')
  drawText('切水果收集生字，写拼音组词赚金币！', W / 2, TOP + YH * 0.13, 16, 'rgba(255,255,255,.6)')

  const sections = getSections()
  const btnH = 40, gap = 6, startY = TOP + YH * 0.20, cols = 3
  const btnW = (W - 40 - (cols - 1) * gap) / cols

  clearButtons()
  sections.forEach((sec, i) => {
    const col = i % cols, row = Math.floor(i / cols)
    const x = 20 + col * (btnW + gap), y = startY + row * (btnH + gap)
    const sel = state.section && state.section.title === sec.title
    drawRoundRect(x, y, btnW, btnH, 16, sel ? '#e94560' : 'rgba(255,255,255,.08)')
    drawText(sec.title, x + btnW / 2, y + btnH / 2, 13, sel ? '#fff' : 'rgba(255,255,255,.7)')
    addBtn('sec-' + i, x, y, btnW, btnH, sec.title)
  })

  const startBtnY = startY + Math.ceil(sections.length / cols) * (btnH + gap) + 24
  drawRoundRect(W / 2 - 90, startBtnY, 180, 52, 26, '#e94560')
  drawText('开始游戏', W / 2, startBtnY + 26, 22, '#fff')
  addBtn('start', W / 2 - 90, startBtnY, 180, 52, '开始游戏')

  drawText('选择要练习的课文', W / 2, startBtnY + 80, 13, 'rgba(255,255,255,.3)')

  if (state.coins > 0) {
    drawText(`🪙 ${state.coins}`, W - 16, TOP + 12, 18, '#ffd700', 'right')
  }
}

function drawLevel1HUD() {
  const remaining = Math.max(0, Math.ceil(state.gameDuration - state.gameTimer))
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; drawRoundRect(8, TOP + 8, 220, 36, 8, 'rgba(0,0,0,0.3)')
  drawText(`📚 ${state.collectedChars.length}/${state.fruitsTarget}`, 16, TOP + 26, 15, '#fff', 'left')
  drawText(`⏱ ${remaining}s`, W - 16, TOP + 26, 15, '#fff', 'right')
}

function drawDialog() {
  ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(0, TOP, W, YH)
  const bx = W / 2 - 150, by = TOP + YH / 2 - 90, bw = 300, bh = 180
  const g = ctx.createLinearGradient(0, by, 0, by + bh)
  g.addColorStop(0, '#1a1a2e'); g.addColorStop(1, '#16213e')
  drawRoundRect(bx, by, bw, bh, 16, null)
  ctx.fillStyle = g; ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 1; ctx.stroke()

  const hasChars = state.collectedChars.length > 0
  drawText(hasChars ? '🎉 太棒了！' : '😅 再试试！', W / 2, by + 38, 22, '#fff')
  drawText(
    hasChars ? `收集了 ${state.collectedChars.length} 个生字！完成第二关兑换金币吧！` : '一个水果都没切到... 再玩一次吧！',
    W / 2, by + 78, 15, 'rgba(255,255,255,.6)'
  )

  const btnL = hasChars ? '进入第二关 →' : '再玩一次'
  drawRoundRect(W / 2 - 80, by + 118, 160, 46, 23, '#e94560')
  drawText(btnL, W / 2, by + 141, 18, '#fff')
  addBtn('dialog', W / 2 - 80, by + 118, 160, 46, btnL)
}

function drawLevel2() {
  drawBackground()

  const title = state.section ? state.section.title : ''
  const shortTitle = title.length > 8 ? title.slice(0, 8) + '…' : title
  drawText(`📝 ${shortTitle} — 写拼音·组词·造句`, W / 2, TOP + 34, 14, '#fff')

  const coins = calcCoins()
  drawText(`🪙 ${coins}`, W - 20, TOP + 34, 14, '#ffd700', 'right')

  const cardY = TOP + 52, cardH = 48, cardGap = 8
  clearButtons()
  const totalW = state.collectedChars.length * (cardH + cardGap) - cardGap
  const offsetX = Math.max(20, (W - totalW) / 2)

  charCards = []
  state.collectedChars.forEach((c, i) => {
    const x = offsetX + i * (cardH + cardGap)
    const used = state.l2Pinyins.some(p => p.idx === i) || state.l2Words.some(w => w.idx === i) || state.l2Sentences.some(s => s.idx === i)
    drawRoundRect(x, cardY, cardH, cardH, 10, used ? 'rgba(255,255,255,.03)' : 'rgba(255,255,255,.08)')
    ctx.globalAlpha = used ? 0.25 : 1
    drawText(c.character, x + cardH / 2, cardY + cardH / 2, 24, '#fff')
    ctx.globalAlpha = 1
    charCards.push({ x, y: cardY, w: cardH, h: cardH, idx: i, char: c })
    addBtn('char-' + i, x, cardY, cardH, cardH, c.character)
  })

  const taskStartY = TOP + 114
  drawTask('🔤 写拼音', taskStartY, '+1 🪙', state.l2Pinyins, 'pinyin')
  drawTask('📖 组词', taskStartY + 148, '+1 🪙/字', state.l2Words, 'word')
  drawTask('✏️ 造句', taskStartY + 240, '+2 🪙/字', state.l2Sentences, 'sentence')

  addBtn('done', W / 2 - 60, TOP + YH - 60, 120, 40, '完成 ✓')
  drawRoundRect(W / 2 - 60, TOP + YH - 60, 120, 40, 20, '#e94560')
  drawText('完成 ✓', W / 2, TOP + YH - 40, 16, '#fff')
}

function drawTask(label, y, coinLabel, placed, type) {
  const areaW = W - 24
  drawRoundRect(12, y, areaW, 124, 12, 'rgba(255,255,255,.03)')
  ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([])
  drawText(label, 24, y + 16, 14, 'rgba(255,255,255,.6)', 'left')
  drawText(coinLabel, W - 24, y + 16, 12, '#ffd700', 'right')

  const areaY = y + 32
  const zoneW = W - 32
  drawRoundRect(16, areaY, zoneW, 28, 8, 'rgba(255,255,255,.03)')

  placed.forEach((p, i) => {
    drawRoundRect(20 + i * 40, areaY + 2, 36, 24, 6, 'rgba(255,255,255,.08)')
    drawText(p.char.character, 20 + i * 40 + 18, areaY + 14, 15, '#fff')
  })

  addZone('zone-' + type, 16, areaY, zoneW, 28)

  if (type === 'pinyin') {
    const hasText = state.pinyinText.length > 0
    const ph = state.pinyinText || '拖入生字后输入拼音...'
    drawRoundRect(16, areaY + 34, zoneW, 34, 8, 'rgba(0,0,0,.3)')
    ctx.strokeStyle = hasText ? '#e94560' : 'rgba(255,255,255,.1)'; ctx.lineWidth = 1; ctx.stroke()
    drawText(ph, 24, areaY + 51, 14, hasText ? '#fff' : 'rgba(255,255,255,.3)', 'left')
    addBtn('input-pinyin', 16, areaY + 34, zoneW, 34, '')
  }
  if (type === 'word') {
    const ph = state.wordText || '拖入生字，或直接输入组词...'
    drawRoundRect(16, areaY + 34, zoneW, 34, 8, 'rgba(0,0,0,.3)')
    drawText(ph, 24, areaY + 51, 14, state.wordText ? '#fff' : 'rgba(255,255,255,.3)', 'left')
    addBtn('input-word', 16, areaY + 34, zoneW, 34, '')
  }
  if (type === 'sentence') {
    const ph = state.sentenceText || '拖入生字，或直接输入句子...'
    drawRoundRect(16, areaY + 34, zoneW, 54, 8, 'rgba(0,0,0,.3)')
    drawText(ph, 24, areaY + 61, 14, state.sentenceText ? '#fff' : 'rgba(255,255,255,.3)', 'left')
    addBtn('input-sentence', 16, areaY + 34, zoneW, 54, '')
  }
}

function drawComplete(audioAlreadyPlayed) {
  if (!audioAlreadyPlayed) {
    const coins = calcCoins()
    if (coins > 0) playComplete()
  }
  ctx.fillStyle = 'rgba(0,0,0,.85)'; ctx.fillRect(0, TOP, W, YH)
  drawText('🎊 游戏结束！', W / 2, TOP + YH * 0.06, 28, '#fff')
  drawText(String(calcCoins()), W / 2, TOP + YH * 0.16, 46, '#ffd700')
  drawText('总金币', W / 2, TOP + YH * 0.22, 15, 'rgba(255,255,255,.5)')

  const stats = [
    ['收集生字', state.collectedChars.length],
    ['写过拼音', state.l2Pinyins.length],
    ['组过词', state.wordText.split(/[\s,，、]+/).filter(w => w.length > 0).length],
    ['造过句', state.l2Sentences.length],
  ]
  stats.forEach((s, i) => {
    const x = W / 2 - 90 + (i % 2) * 120, y = TOP + YH * 0.28 + Math.floor(i / 2) * 56
    drawRoundRect(x, y, 100, 48, 10, 'rgba(255,255,255,.05)')
    drawText(String(s[1]), x + 50, y + 20, 24, '#4fc3f7')
    drawText(s[0], x + 50, y + 40, 13, 'rgba(255,255,255,.4)')
  })

  drawText('🎁 金币兑换', W / 2, TOP + YH * 0.54, 14, 'rgba(255,255,255,.4)')
  const rw = 66, rh = 62, rg = 8, rStartY = TOP + YH * 0.58, rCols = 4
  REWARDS.forEach((r, i) => {
    const col = i % rCols, row = Math.floor(i / rCols)
    const x = (W - (rCols * rw + (rCols - 1) * rg)) / 2 + col * (rw + rg)
    const y = rStartY + row * (rh + rg)
    const unlocked = calcCoins() >= r.cost
    drawRoundRect(x, y, rw, rh, 10, unlocked ? 'rgba(255,215,0,.1)' : 'rgba(255,255,255,.05)')
    ctx.strokeStyle = unlocked ? '#ffd700' : 'rgba(255,255,255,.1)'; ctx.lineWidth = 1; ctx.stroke()
    drawText(r.icon, x + rw / 2, y + 20, 24, unlocked ? '#ffd700' : 'rgba(255,255,255,.5)')
    drawText(r.name, x + rw / 2, y + 40, 12, unlocked ? '#ffd700' : 'rgba(255,255,255,.5)')
    drawText(`${r.cost}🪙`, x + rw / 2, y + 54, 10, unlocked ? '#ffd700' : 'rgba(255,255,255,.4)')
  })

  const btnY = rStartY + Math.ceil(REWARDS.length / rCols) * (rh + rg) + 20
  drawRoundRect(W / 2 - 90, btnY, 80, 42, 18, '#e94560')
  drawText('再来一次', W / 2 - 50, btnY + 21, 16, '#fff')
  addBtn('again', W / 2 - 90, btnY, 80, 42, '再来一次')
  drawRoundRect(W / 2 + 10, btnY, 80, 42, 18, 'rgba(255,255,255,.1)')
  drawText('返回首页', W / 2 + 50, btnY + 21, 16, 'rgba(255,255,255,.7)')
  addBtn('exit', W / 2 + 10, btnY, 80, 42, '返回首页')
}

function hitTest(tx, ty) {
  for (const b of buttons) {
    if (tx >= b.x && tx <= b.x + b.w && ty >= b.y && ty <= b.y + b.h) return b
  }
  return null
}

function hitCharCard(tx, ty) {
  for (const c of charCards) {
    if (tx >= c.x && tx <= c.x + c.w && ty >= c.y && ty <= c.y + c.h) return c
  }
  return null
}

function hitZone(tx, ty) {
  for (const [id, z] of Object.entries(touchZones)) {
    if (tx >= z.x && tx <= z.x + z.w && ty >= z.y && ty <= z.y + z.h) return id
  }
  return null
}

module.exports = {
  init, clearButtons, addBtn, drawRoundRect, drawBackground, drawText,
  drawStartScreen, drawLevel1HUD, drawDialog, drawLevel2, drawComplete,
  hitTest, hitCharCard, hitZone, buttons, charCards, touchZones,
}
