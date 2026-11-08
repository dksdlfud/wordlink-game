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
  const result = validateWord('뷁뷁뷁뷁', dictionary, new Set(), '');
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

// ── 라운드제 · 미션 글자 ──────────────────────────────────
const {
  turnSecondsForRound, buildMissionPool, pickMissionLetter, hasMissionLetter,
  TOTAL_TIME_OPTIONS, buildRoundSummary, calcScore, countMissionLetters
} = require('./game-rules');

test('라운드 총 시간 선택지', () => {
  assert.deepEqual(TOTAL_TIME_OPTIONS, [20, 40, 60, 80, 100, 150, 500]);
});

test('라운드가 갈수록 턴 제한 시간이 줄어들고 5초 아래로는 내려가지 않는다', () => {
  const series = [0, 1, 2, 3, 4, 5, 6].map(round => turnSecondsForRound(15, round));
  assert.deepEqual(series, [15, 13, 11, 9, 7, 5, 5]);
  for (let i = 1; i < series.length; i += 1) assert.ok(series[i] <= series[i - 1]);
  assert.ok([0, 1, 2, 3, 4, 5, 6].every(round => turnSecondsForRound(10, round) >= 5));
  assert.equal(turnSecondsForRound(30, 0), 30);
});

test('미션 글자 후보는 사전에 실제로 쓰이는 한글이다', () => {
  const pool = buildMissionPool(dictionary);
  assert.ok(pool.length >= 50);
  assert.ok(pool.every(ch => /^[가-힣]$/u.test(ch)));
  assert.ok(pool.every(ch => [...dictionary].some(word => word.includes(ch))));
});

test('미션 글자는 직전 글자를 피해서 뽑는다', () => {
  const pool = ['가', '나', '다'];
  for (let i = 0; i < 30; i += 1) assert.notEqual(pickMissionLetter(pool, '가'), '가');
  assert.equal(pickMissionLetter(['가'], '가'), '가');
  assert.equal(pickMissionLetter([], ''), '');
});

test('미션 글자 포함 여부', () => {
  assert.equal(hasMissionLetter('사과나무', '나'), true);
  assert.equal(hasMissionLetter('사과', '나'), false);
  assert.equal(hasMissionLetter('사과', ''), false);
});

test('경기 요약은 라운드 승수 → 점수 순으로 순위를 매긴다', () => {
  const summary = buildRoundSummary({
    players: [
      { id: 'a', name: 'A', score: 500, roundWins: 1, eliminated: false },
      { id: 'b', name: 'B', score: 300, roundWins: 2, eliminated: false },
      { id: 'c', name: 'C', score: 900, roundWins: 0, eliminated: true }
    ],
    words: [], winnerId: 'b'
  });
  assert.deepEqual(summary.ranking.map(row => row.id), ['b', 'a', 'c']);
  assert.equal(summary.ranking[0].roundWins, 2);
});

test('점수 공식', () => {
  // (0+2) × (7×2+5)^0.74 + 0.88×1×(1+1) = 2×8.84 + 1.76 → 19
  assert.equal(calcScore({ missions: 0, length: 2, chain: 1, timeRatio: 1 }), 19);
  // 미션 글자가 있으면 곱 계수가 커진다.
  assert.ok(calcScore({ missions: 1, length: 3, chain: 4, timeRatio: .5 }) > calcScore({ missions: 0, length: 3, chain: 4, timeRatio: .5 }));
  assert.equal(countMissionLetters('가나가', '가'), 2);
  assert.equal(countMissionLetters('가나가', ''), 0);
});
