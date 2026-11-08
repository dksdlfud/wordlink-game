'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeWord, validateWord, allowedFirstSyllables } = require('./game-rules');

const words = JSON.parse(fs.readFileSync(path.join(__dirname, 'words.json'), 'utf8'));
const dictionary = new Set(words.map(normalizeWord));

test('normalizes composed Hangul and whitespace', () => {
  assert.equal(normalizeWord(' 사 과 '), '사과');
});

test('accepts a registered first word', () => {
  const result = validateWord('사과', dictionary, new Set(), '');
  assert.equal(result.ok, true);
  assert.equal(result.word, '사과');
});

test('accepts an exact last-syllable chain', () => {
  const result = validateWord('과자', dictionary, new Set(['사과']), '과');
  assert.equal(result.ok, true);
});

test('rejects a word that does not start with the required syllable', () => {
  const result = validateWord('바다', dictionary, new Set(), '과');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CHAIN');
});

test('rejects repeated words', () => {
  const result = validateWord('사과', dictionary, new Set(['사과']), '');
  assert.equal(result.code, 'DUPLICATE');
});

test('rejects words outside the starter dictionary', () => {
  const result = validateWord('초전도체', dictionary, new Set(), '');
  assert.equal(result.code, 'UNKNOWN');
});

test('rejects non-Hangul and invalid length', () => {
  assert.equal(validateWord('hello', dictionary, new Set()).code, 'FORMAT');
  assert.equal(validateWord('차', dictionary, new Set()).code, 'FORMAT');
  assert.equal(validateWord('가나다라마바사아자차카타파하', dictionary, new Set()).code, 'FORMAT');
});

test('starter dictionary has no duplicate entries', () => {
  assert.equal(words.length, dictionary.size);
});

test('every starter dictionary entry is a supported Hangul word', () => {
  assert.ok(words.every(word => /^[가-힣]{2,12}$/u.test(word)));
});

test('두음법칙: ㄹ+ㅣ/ㅕ/ㅛ/ㅠ/ㅑ/ㅖ → ㅇ', () => {
  assert.deepEqual(allowedFirstSyllables('리'), ['리', '이']);
  assert.deepEqual(allowedFirstSyllables('려'), ['려', '여']);
  assert.deepEqual(allowedFirstSyllables('료'), ['료', '요']);
  assert.deepEqual(allowedFirstSyllables('류'), ['류', '유']);
  assert.deepEqual(allowedFirstSyllables('량'), ['량', '양']);
  assert.deepEqual(allowedFirstSyllables('례'), ['례', '예']);
});

test('두음법칙: ㄹ+ㅏ/ㅐ/ㅗ/ㅚ/ㅜ/ㅡ → ㄴ', () => {
  assert.deepEqual(allowedFirstSyllables('라'), ['라', '나']);
  assert.deepEqual(allowedFirstSyllables('래'), ['래', '내']);
  assert.deepEqual(allowedFirstSyllables('로'), ['로', '노']);
  assert.deepEqual(allowedFirstSyllables('뢰'), ['뢰', '뇌']);
  assert.deepEqual(allowedFirstSyllables('루'), ['루', '누']);
  assert.deepEqual(allowedFirstSyllables('릉'), ['릉', '능']);
});

test('두음법칙: ㄴ+ㅣ/ㅕ/ㅛ/ㅠ → ㅇ', () => {
  assert.deepEqual(allowedFirstSyllables('녀'), ['녀', '여']);
  assert.deepEqual(allowedFirstSyllables('뇨'), ['뇨', '요']);
  assert.deepEqual(allowedFirstSyllables('뉴'), ['뉴', '유']);
  assert.deepEqual(allowedFirstSyllables('님'), ['님', '임']);
});

test('두음법칙이 적용되지 않는 글자는 그대로', () => {
  assert.deepEqual(allowedFirstSyllables('과'), ['과']);
  assert.deepEqual(allowedFirstSyllables('나'), ['나']);
  assert.deepEqual(allowedFirstSyllables('이'), ['이']);
  assert.deepEqual(allowedFirstSyllables(''), []);
});

test('두음법칙 적용 연결: 원래 글자와 변환 글자 모두 허용', () => {
  // 필요한 단어가 사전에 있는지 확인
  const toIeung = [...dictionary].find(w => w[0] === '이');
  const toNa = [...dictionary].find(w => w[0] === '나');
  const toRa = [...dictionary].find(w => w[0] === '라');
  assert.ok(toIeung && toNa);
  assert.equal(validateWord(toIeung, dictionary, new Set(), '리').ok, true);
  assert.equal(validateWord(toNa, dictionary, new Set(), '라').ok, true);
  if (toRa) assert.equal(validateWord(toRa, dictionary, new Set(), '라').ok, true);
});

test('두음법칙 안내 메시지에 두 글자 모두 표시', () => {
  const result = validateWord('사과', dictionary, new Set(), '리');
  assert.equal(result.code, 'CHAIN');
  assert.ok(result.message.includes('‘리’') && result.message.includes('‘이’'));
});
