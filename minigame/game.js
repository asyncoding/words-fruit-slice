const { state, saveProgress, loadProgress, getSections } = require('./js/data')
const audio = require('./js/audio')
const ui = require('./js/ui')
const level1 = require('./js/level1')
const level2 = require('./js/level2')

const sysInfo = wx.getSystemInfoSync()
const dpr = sysInfo.pixelRatio || 1
const W = sysInfo.windowWidth
const H = sysInfo.windowHeight
const safeArea = sysInfo.safeArea || { top: 0, bottom: H, left: 0, right: W }
const topInset = safeArea.top || 0
const bottomInset = (sysInfo.screenHeight || H) - (safeArea.bottom || H)

const canvas = wx.createCanvas()
canvas.width = W * dpr
canvas.height = H * dpr
const ctx = canvas.getContext('2d')
ctx.scale(dpr, dpr)

ui.init(ctx, W, H, topInset, bottomInset)
level1.init(ctx, W, H)
level2.reset()
loadProgress()

let lastTime = Date.now()
let dragCharData = null
let keyboardOpen = false
let keyboardTarget = null
let keyboardHeight = 0
let keyboardOffset = 0
let completeSoundPlayed = false

wx.onKeyboardShow = wx.onKeyboardShow || function(){}
wx.onKeyboardHide = wx.onKeyboardHide || function(){}

wx.onKeyboardShow(function(res) {
  keyboardHeight = res.height || 0
  keyboardOffset = Math.min((keyboardHeight / dpr) * 0.4, (H - topInset - bottomInset) * 0.5)
})

wx.onKeyboardHide(function() {
  keyboardHeight = 0
  keyboardOffset = 0
})

function startLevel1() {
  state.phase = 'playing'
  state.collectedChars = []
  state.usedCharIds = new Set()
  level1.reset()
  level1.spawnFruit()
  state.fruitsPresented = 1
  lastTime = Date.now()
}

function endLevel1() {
  state.phase = 'dialog'
}

function startLevel2() {
  state.phase = 'level2'
  level2.reset()
}

function showComplete() {
  state.phase = 'complete'
  completeSoundPlayed = false
  saveProgress()
}

function showKeyboard(target) {
  if (keyboardOpen) return
  keyboardOpen = true
  keyboardTarget = target
  const defaults = { pinyin: state.pinyinText, word: state.wordText, sentence: state.sentenceText }
  const maxLengths = { pinyin: 20, word: 50, sentence: 200 }
  try {
    wx.showKeyboard({
      defaultValue: defaults[target] || '',
      maxLength: maxLengths[target] || 50,
      multiple: target === 'sentence',
      confirmType: 'done',
    })
  } catch (e) {}
}

wx.onKeyboardInput(function(res) {
  if (keyboardTarget === 'pinyin') state.pinyinText = res.value
  else if (keyboardTarget === 'word') state.wordText = res.value
  else if (keyboardTarget === 'sentence') state.sentenceText = res.value
})

wx.onKeyboardConfirm(function() { keyboardOpen = false; keyboardTarget = null })
wx.onKeyboardComplete(function() { keyboardOpen = false; keyboardTarget = null })

function handlePhaseTouch(type, x, y) {
  if (state.phase === 'playing') {
    if (type === 'start') level1.onTouchStart(x, y)
    else if (type === 'move') level1.onTouchMove(x, y)
    else if (type === 'end') level1.onTouchEnd()
    return
  }
  if (type !== 'end') return

  if (state.phase === 'menu') {
    const btn = ui.hitTest(x, y)
    if (!btn) return
    if (btn.id.startsWith('sec-')) {
      const idx = parseInt(btn.id.split('-')[1])
      const sections = getSections()
      state.section = sections[idx]
      state.fruitsTarget = Math.min(state.section.characters.length, 12)
    } else if (btn.id === 'start') {
      if (state.section) startLevel1()
    }
  } else if (state.phase === 'dialog') {
    const btn = ui.hitTest(x, y)
    if (btn && btn.id === 'dialog') {
      if (state.collectedChars.length > 0) startLevel2()
      else startLevel1()
    }
  } else if (state.phase === 'level2') {
    const ay = y + keyboardOffset
    const charCard = ui.hitCharCard(x, ay)
    if (charCard) {
      dragCharData = { idx: charCard.idx, char: charCard.char }
      return
    }
    const zone = ui.hitZone(x, ay)
    if (zone && dragCharData) {
      const type = zone.split('-')[1]
      if (type === 'pinyin') level2.addToPinyinArea(dragCharData.char, dragCharData.idx)
      else if (type === 'word') level2.addToWordArea(dragCharData.char, dragCharData.idx)
      else if (type === 'sentence') level2.addToSentenceArea(dragCharData.char, dragCharData.idx)
      dragCharData = null
      return
    }
    const btn = ui.hitTest(x, ay)
    if (!btn) { dragCharData = null; return }
    if (btn.id.startsWith('input-')) {
      showKeyboard(btn.id.split('-')[1])
    } else if (btn.id === 'done') {
      showComplete()
    }
    dragCharData = null
  } else if (state.phase === 'complete') {
    const btn = ui.hitTest(x, y)
    if (!btn) return
    if (btn.id === 'again') { state.usedCharIds = new Set(); completeSoundPlayed = false; startLevel1() }
    else if (btn.id === 'exit') {
      state.phase = 'menu'; completeSoundPlayed = false
    }
  }
}

wx.onTouchStart(function(e) {
  for (let i = 0; i < e.touches.length; i++) {
    handlePhaseTouch('start', e.touches[i].clientX, e.touches[i].clientY)
  }
})
wx.onTouchMove(function(e) {
  for (let i = 0; i < e.touches.length; i++) {
    handlePhaseTouch('move', e.touches[i].clientX, e.touches[i].clientY)
  }
})
wx.onTouchEnd(function(e) {
  const list = e.changedTouches || e.touches
  for (let i = 0; i < list.length; i++) {
    handlePhaseTouch('end', list[i].clientX, list[i].clientY)
  }
})

function update(dt) {
  if (state.phase === 'playing') {
    level1.update(dt)
    if (state.collectedChars.length >= state.fruitsTarget) endLevel1()
    else if (state.gameTimer >= state.gameDuration) endLevel1()
  }
}

function render() {
  if (state.phase === 'menu') {
    ui.drawStartScreen()
  } else if (state.phase === 'playing') {
    ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, W, H)
    level1.render()
    level1.renderSwipe()
    ui.drawLevel1HUD()
  } else if (state.phase === 'dialog') {
    ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, W, H)
    level1.render()
    ui.drawDialog()
  } else if (state.phase === 'level2') {
    ctx.save()
    if (keyboardOffset > 0) ctx.translate(0, -keyboardOffset)
    ui.drawLevel2()
    ctx.restore()
  } else if (state.phase === 'complete') {
    ui.drawComplete(completeSoundPlayed)
    if (!completeSoundPlayed) { completeSoundPlayed = true }
  }
}

function gameLoop() {
  const now = Date.now()
  const dt = Math.min((now - lastTime) / 1000, 0.05)
  lastTime = now
  update(dt)
  render()
  if (wx.requestAnimationFrame) wx.requestAnimationFrame(gameLoop)
  else setTimeout(gameLoop, 16)
}

if (wx.requestAnimationFrame) wx.requestAnimationFrame(gameLoop)
else setTimeout(gameLoop, 16)
