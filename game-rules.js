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

module.exports = { normalizeWord, validateWord, HANGUL_WORD };
