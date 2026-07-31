const { state } = require('./data')
const { playSlice } = require('./audio')

let W, H, ctx
const fruits = []
const particles = []
const slicedFruits = []
let swipePoints = []

const FRUIT_TYPES = [
  { r: 36, color: '#4caf50', inner: '#81c784' },
  { r: 32, color: '#ff9800', inner: '#ffb74d' },
  { r: 28, color: '#f44336', inner: '#ef9a9a' },
  { r: 30, color: '#9c27b0', inner: '#ce93d8' },
  { r: 26, color: '#ffeb3b', inner: '#fff9c4' },
]

function init(c, w, h) { ctx = c; W = w; H = h }

function reset() {
  fruits.length = 0; slicedFruits.length = 0; particles.length = 0
  state.fruitsPresented = 0; state.spawnTimer = 0; state.gameTimer = 0
  swipePoints = []
}

function createFruit() {
  const chars = state.section ? state.section.characters : []
  const available = chars.filter(c => !state.usedCharIds.has(c.character + c.sentence))
  if (available.length === 0) return null
  const idx = Math.floor(Math.random() * available.length)
  const charData = available[idx]
  state.usedCharIds.add(charData.character + charData.sentence)
  const ft = FRUIT_TYPES[Math.floor(Math.random() * FRUIT_TYPES.length)]
  const x = 60 + Math.random() * (W - 120)
  return {
    x, y: H + 50, vx: (Math.random() - 0.5) * 260, vy: -(420 + Math.random() * 300),
    r: ft.r, color: ft.color, inner: ft.inner,
    char: charData.character, charData,
    sliced: false, rotation: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 4, gravity: 560,
    opacity: 1, sliceAngle: 0,
  }
}

function spawnFruit() {
  const f = createFruit()
  if (f) fruits.push(f)
}

function checkSlice(x1, y1, x2, y2) {
  for (let i = fruits.length - 1; i >= 0; i--) {
    const f = fruits[i]
    if (f.sliced || f.y > H + 100 || f.opacity <= 0) continue
    const lineLen = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
    if (lineLen < 1) continue
    const t = ((f.x - x1) * (x2 - x1) + (f.y - y1) * (y2 - y1)) / (lineLen * lineLen)
    const ct = Math.max(0, Math.min(1, t))
    const cx = x1 + ct * (x2 - x1), cy = y1 + ct * (y2 - y1)
    if (Math.sqrt((f.x - cx) ** 2 + (f.y - cy) ** 2) < f.r + 15) {
      sliceFruit(i); return
    }
  }
}

function sliceFruit(idx) {
  const f = fruits[idx]
  if (f.sliced) return
  f.sliced = true
  playSlice()
  slicedFruits.push(f)
  state.collectedChars.push(f.charData)
  spawnParticles(f.x, f.y, f.color)
}

function spawnParticles(x, y, color) {
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2, s = 60 + Math.random() * 180
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, r: 3 + Math.random() * 4, color, life: 1, decay: 0.015 + Math.random() * 0.02, gravity: 280 })
  }
}

function update(dt) {
  if (state.phase !== 'playing') return
  state.gameTimer += dt
  if (state.gameTimer >= state.gameDuration) return
  state.spawnTimer += dt
  const si = Math.max(0.6, 2.0 - state.gameTimer / 15 * 0.8)
  if (state.spawnTimer >= si && state.fruitsPresented < state.fruitsTarget) {
    spawnFruit(); state.fruitsPresented++; state.spawnTimer = 0
  }
  for (let i = fruits.length - 1; i >= 0; i--) {
    const f = fruits[i]; if (f.sliced) continue
    f.vy += f.gravity * dt; f.x += f.vx * dt; f.y += f.vy * dt
    f.rotation += f.rotSpeed * dt
    if (f.y > H + 100) fruits.splice(i, 1)
  }
  for (let i = slicedFruits.length - 1; i >= 0; i--) {
    const f = slicedFruits[i]
    f.vy += f.gravity * dt; f.x += f.vx * dt * 0.5; f.y += f.vy * dt
    f.opacity -= dt * 0.8
    if (f.opacity <= 0) slicedFruits.splice(i, 1)
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]
    p.vy += p.gravity * dt; p.x += p.vx * dt; p.y += p.vy * dt
    p.life -= p.decay
    if (p.life <= 0) particles.splice(i, 1)
  }
  const now = Date.now()
  swipePoints = swipePoints.filter(p => now - p.t < 100)
}

function render() {
  for (const f of fruits) {
    if (f.sliced) continue
    ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.rotation); ctx.globalAlpha = f.opacity
    ctx.beginPath(); ctx.arc(0, 0, f.r, 0, Math.PI * 2)
    ctx.fillStyle = f.color; ctx.fill()
    ctx.beginPath(); ctx.arc(-f.r * 0.15, -f.r * 0.15, f.r * 0.6, 0, Math.PI * 2)
    ctx.fillStyle = f.inner; ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = `bold ${Math.floor(f.r * 0.75)}px "PingFang SC","Microsoft YaHei",sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 4
    ctx.fillText(f.char, 0, 1)
    ctx.restore()
  }
  for (const f of slicedFruits) {
    if (f.opacity <= 0) continue
    ctx.save(); ctx.translate(f.x, f.y); ctx.globalAlpha = f.opacity
    ctx.fillStyle = '#fff'
    ctx.font = `bold ${Math.floor(f.r * 0.6)}px sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    for (let h = -1; h <= 1; h += 2) {
      ctx.beginPath(); ctx.arc(h * 3, 0, f.r, -Math.PI / 2 * h, Math.PI / 2 * h); ctx.closePath()
      ctx.fillStyle = f.color; ctx.fill()
      ctx.fillStyle = '#fff'; ctx.fillText(f.char, h * 3, 0)
    }
    ctx.restore()
  }
  for (const p of particles) {
    if (p.life <= 0) continue
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2)
    ctx.fillStyle = p.color; ctx.globalAlpha = p.life; ctx.fill(); ctx.globalAlpha = 1
  }
}

function renderSwipe() {
  if (swipePoints.length < 2) return
  ctx.beginPath(); ctx.moveTo(swipePoints[0].x, swipePoints[0].y)
  for (let i = 1; i < swipePoints.length; i++) ctx.lineTo(swipePoints[i].x, swipePoints[i].y)
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke()
}

function onTouchStart(x, y) {
  if (state.phase !== 'playing') return
  swipePoints = [{ x, y, t: Date.now() }]
}

function onTouchMove(x, y) {
  if (state.phase !== 'playing' || swipePoints.length === 0) return
  const prev = swipePoints[swipePoints.length - 1]
  swipePoints.push({ x, y, t: Date.now() })
  checkSlice(prev.x, prev.y, x, y)
}

function onTouchEnd() { swipePoints = [] }

module.exports = { init, reset, update, render, renderSwipe, onTouchStart, onTouchMove, onTouchEnd, spawnFruit }
