'use strict';

const HANGUL_WORD = /^[가-힣]{2,12}$/u;

function normalizeWord(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\s+/gu, '')
    .trim();
}

function validateWord(value, dictionary, usedWords, requiredFirst = '') {
  const word = normalizeWord(value);
  if (!word) return { ok: false, code: 'EMPTY', message: '단어를 입력해 주세요.' };
  if (!HANGUL_WORD.test(word)) {
    return { ok: false, code: 'FORMAT', message: '한글 2~12글자로 입력해 주세요.' };
  }
  if (!dictionary.has(word)) {
    return { ok: false, code: 'UNKNOWN', message: '사전에 없는 단어예요.' };
  }
  if (usedWords.has(word)) {
    return { ok: false, code: 'DUPLICATE', message: '이미 사용한 단어예요.' };
  }
  if (requiredFirst && word[0] !== requiredFirst) {
    return {
      ok: false,
      code: 'CHAIN',
      message: `‘${requiredFirst}’(으)로 시작하는 단어를 입력해 주세요.`
    };
  }
  return { ok: true, word };
}

// 서버가 허용하는 이모지 반응 목록 (클라이언트 버튼과 동일하게 유지)
const REACTION_EMOJIS = ['👍', '😂', '😮', '🔥', '👏', '😭'];

// 한 판이 끝났을 때 보여 줄 결과 요약을 만든다. (순수 함수 — 서버 상태를 바꾸지 않음)
function buildRoundSummary({ players, words, winnerId = null, startedAt = null, endedAt = Date.now() }) {
  const played = words.filter(item => item.type === 'word');
  const stats = new Map(players.map(player => [player.id, { wordCount: 0, longestWord: '' }]));
  let longest = null;
  let fastest = null;
  for (const item of played) {
    const own = stats.get(item.playerId);
    if (own) {
      own.wordCount += 1;
      if (item.word.length > own.longestWord.length) own.longestWord = item.word;
    }
    if (!longest || item.word.length > longest.word.length) longest = item;
    if (Number.isFinite(item.elapsedMs) && (!fastest || item.elapsedMs < fastest.elapsedMs)) fastest = item;
  }
  const ranking = players
    .map((player, order) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      eliminated: Boolean(player.eliminated),
      isWinner: player.id === winnerId,
      wordCount: stats.get(player.id).wordCount,
      longestWord: stats.get(player.id).longestWord,
      order
    }))
    .sort((a, b) => Number(a.eliminated) - Number(b.eliminated) || b.score - a.score || b.wordCount - a.wordCount || a.order - b.order)
    .map(({ order, ...row }, index) => ({ ...row, rank: index + 1 }));
  return {
    totalWords: played.length,
    durationMs: Number.isFinite(startedAt) ? Math.max(0, endedAt - startedAt) : null,
    longestWord: longest ? { word: longest.word, playerName: longest.playerName } : null,
    fastestWord: fastest ? { word: fastest.word, playerName: fastest.playerName, elapsedMs: fastest.elapsedMs } : null,
    ranking
  };
}

module.exports = { normalizeWord, validateWord, buildRoundSummary, HANGUL_WORD, REACTION_EMOJIS };
