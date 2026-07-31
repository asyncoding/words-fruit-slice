let audioCtx = null

function ensureCtx() {
  if (!audioCtx) {
    audioCtx = wx.createWebAudioContext()
  }
}

function playTone(freq, duration, type) {
  try {
    ensureCtx()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain)
    gain.connect(audioCtx.destination)
    osc.type = type || 'sine'
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(freq * 0.3, audioCtx.currentTime + duration)
    gain.gain.setValueAtTime(0.25, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration)
    osc.start(audioCtx.currentTime)
    osc.stop(audioCtx.currentTime + duration)
  } catch (e) {}
}

function playSlice() { playTone(800, 0.1, 'sawtooth') }
function playCoin() { playTone(1200, 0.12, 'sine') }
function playComplete() {
  [523, 659, 784, 1047, 784].forEach((f, i) => {
    setTimeout(() => playTone(f, 0.25, 'sine'), i * 100)
  })
}
function playError() { playTone(150, 0.2, 'square') }

module.exports = { playSlice, playCoin, playComplete, playError }
