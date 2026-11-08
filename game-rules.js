'use strict';

const HANGUL_WORD = /^[가-힣]{2,12}$/u;

function normalizeWord(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\s+/gu, '')
    .trim();
}

// ── 두음법칙 ──────────────────────────────────────────────
// 한글 음절을 초성/중성/종성으로 나누어 처리한다.
const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const CHO_N = 2;   // ㄴ
const CHO_R = 5;   // ㄹ
const CHO_IEUNG = 11; // ㅇ
// 중성 인덱스: ㅏ0 ㅐ1 ㅑ2 ㅒ3 ㅓ4 ㅔ5 ㅕ6 ㅖ7 ㅗ8 ㅘ9 ㅙ10 ㅚ11 ㅛ12 ㅜ13 ㅝ14 ㅞ15 ㅟ16 ㅠ17 ㅡ18 ㅢ19 ㅣ20
const JUNG_TO_IEUNG = new Set([2, 3, 6, 7, 12, 17, 20]); // ㅑ ㅒ ㅕ ㅖ ㅛ ㅠ ㅣ
const JUNG_R_TO_N = new Set([0, 1, 8, 11, 13, 18]);       // ㅏ ㅐ ㅗ ㅚ ㅜ ㅡ

// 끝 글자에 두음법칙을 적용했을 때 다음 단어의 첫 글자로 허용되는 글자 목록.
// 항상 원래 글자를 첫 번째로 포함한다. (예: '리' → ['리', '이'], '라' → ['라', '나'])
function allowedFirstSyllables(syllable) {
  const ch = String(syllable ?? '').normalize('NFC');
  if (!ch) return [];
  const code = ch.codePointAt(0);
  if (ch.length !== 1 || code < HANGUL_BASE || code > HANGUL_LAST) return [ch];
  const offset = code - HANGUL_BASE;
  const cho = Math.floor(offset / 588);
  const jung = Math.floor((offset % 588) / 28);
  const jong = offset % 28;
  const compose = newCho => String.fromCharCode(HANGUL_BASE + (newCho * 21 + jung) * 28 + jong);
  const result = [ch];
  if (cho === CHO_N && JUNG_TO_IEUNG.has(jung)) result.push(compose(CHO_IEUNG)); // 녀→여, 뇨→요, 뉴→유, 니→이
  else if (cho === CHO_R && JUNG_TO_IEUNG.has(jung)) result.push(compose(CHO_IEUNG)); // 랴→야, 려→여, 례→예, 료→요, 류→유, 리→이
  else if (cho === CHO_R && JUNG_R_TO_N.has(jung)) result.push(compose(CHO_N)); // 라→나, 래→내, 로→노, 뢰→뇌, 루→누, 르→느
  return result;
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
  if (requiredFirst) {
    const allowed = allowedFirstSyllables(requiredFirst);
    if (!allowed.includes(word[0])) {
      const label = allowed.map(item => `‘${item}’`).join(' 또는 ');
      return {
        ok: false,
        code: 'CHAIN',
        message: `${label}(으)로 시작하는 단어를 입력해 주세요.`
      };
    }
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

module.exports = { normalizeWord, validateWord, allowedFirstSyllables, buildRoundSummary, HANGUL_WORD, REACTION_EMOJIS };
