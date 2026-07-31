const GAME_DATA = require('../game-data.js')

const REWARDS = [
  { icon: '🔪', name: '木刀', cost: 10 },
  { icon: '⚔️', name: '银刃', cost: 30 },
  { icon: '🗡️', name: '金刀', cost: 60 },
  { icon: '🌈', name: '彩虹', cost: 100 },
  { icon: '🔥', name: '火焰', cost: 150 },
  { icon: '🌊', name: '海洋', cost: 200 },
  { icon: '🌌', name: '星空', cost: 300 },
  { icon: '👑', name: '传说', cost: 500 },
]

let state = {
  phase: 'menu',
  section: null,
  sectionIdx: 0,
  collectedChars: [],
  usedCharIds: new Set(),
  coins: 0,
  fruitsTarget: 8,
  gameTimer: 0,
  gameDuration: 30,
  fruitsPresented: 0,
  spawnTimer: 0,
  l2Pinyins: [],
  l2Words: [],
  l2Sentences: [],
  pinyinText: '',
  wordText: '',
  sentenceText: '',
  keyboardTarget: null,
}

function saveProgress() {
  try {
    wx.setStorageSync('wfs-progress', { coins: state.coins, chars: state.collectedChars.length })
  } catch (e) {}
}

function loadProgress() {
  try {
    const d = wx.getStorageSync('wfs-progress')
    if (d) state.coins = d.coins || 0
  } catch (e) {}
}

function getSection(idx) {
  if (idx < 0 || idx >= GAME_DATA.sections.length) return null
  return GAME_DATA.sections[idx]
}

function getSections() {
  const s = GAME_DATA.sections.slice()
  s.push({ title: '全部生字', characters: [].concat(...GAME_DATA.sections.map(x => x.characters)), num: '-1' })
  return s
}

function calcCoins() {
  let c = 0
  const hasPinyin = state.l2Pinyins.length > 0 && state.pinyinText.length > 0
  if (hasPinyin) c += 1
  if (state.wordText.length > 0) c += state.wordText.replace(/\s/g, '').length
  const punct = `，。、！？；：""'（）【】《》—…·,.;:!?()[]{}`
  const clean = state.sentenceText.split('').filter(x => !punct.includes(x)).join('')
  if (clean.length > 0) c += clean.length * 2
  state.coins = c
  return c
}

module.exports = { GAME_DATA, REWARDS, state, saveProgress, loadProgress, getSection, getSections, calcCoins }
