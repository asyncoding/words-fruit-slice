const { state } = require('./data')
const { playCoin } = require('./audio')

function reset() {
  state.l2Pinyins = []; state.l2Words = []; state.l2Sentences = []
  state.pinyinText = ''; state.wordText = ''; state.sentenceText = ''
}

function addToPinyinArea(char, idx) {
  state.l2Pinyins.length = 0
  state.l2Pinyins.push({ idx, char })
  playCoin()
}

function addToWordArea(char, idx) {
  state.l2Words.push({ idx, char })
  playCoin()
}

function addToSentenceArea(char, idx) {
  state.l2Sentences.push({ idx, char })
  playCoin()
}

function removePinyin(idx) {
  state.l2Pinyins = state.l2Pinyins.filter(p => p.idx !== idx)
}

function removeWord(idx) {
  state.l2Words = state.l2Words.filter(w => w.idx !== idx)
}

function removeSentence(idx) {
  state.l2Sentences = state.l2Sentences.filter(s => s.idx !== idx)
}

module.exports = { reset, addToPinyinArea, addToWordArea, addToSentenceArea }
