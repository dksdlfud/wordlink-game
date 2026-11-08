'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { xpNeeded, levelInfo, titleFor, tierFor, calcMatchXp, matchEligible, MAX_LEVEL } = require('./progress');

test('xpNeeded: 레벨이 오를수록 필요 경험치가 늘어난다', () => {
  assert.equal(xpNeeded(1), 100);
  for (let level = 1; level < 98; level += 1) assert.ok(xpNeeded(level + 1) > xpNeeded(level));
});

test('levelInfo: 경계값', () => {
  assert.deepEqual(levelInfo(0), { level: 1, into: 0, need: 100, pct: 0, max: false });
  assert.equal(levelInfo(99).level, 1);
  assert.equal(levelInfo(100).level, 2);
  assert.equal(levelInfo(100).into, 0);
  assert.equal(levelInfo(100 + xpNeeded(2) - 1).level, 2);
  assert.equal(levelInfo(100 + xpNeeded(2)).level, 3);
});

test('levelInfo: 잘못된 값과 만렙', () => {
  assert.equal(levelInfo(-5).level, 1);
  assert.equal(levelInfo('abc').level, 1);
  assert.equal(levelInfo(undefined).level, 1);
  const max = levelInfo(1e12);
  assert.equal(max.level, MAX_LEVEL);
  assert.equal(max.max, true);
  assert.equal(max.pct, 100);
});

test('titleFor / tierFor: 구간별 칭호', () => {
  assert.equal(titleFor(1), '낱말 새싹');
  assert.equal(titleFor(4), '낱말 새싹');
  assert.equal(titleFor(5), '글자 수집가');
  assert.equal(titleFor(99), '말잇기 전설');
  assert.equal(tierFor(1), 0);
  assert.equal(tierFor(50), 5);
  assert.equal(tierFor(99), 7);
});

test('calcMatchXp: 우승자와 패자의 차이, 구성 합계', () => {
  const winner = calcMatchXp({ score: 500, roundWins: 3, rank: 1, players: 4, won: true });
  assert.equal(winner.total, 20 + 100 + 30 + 40 + 10);
  assert.equal(winner.total, winner.parts.reduce((sum, part) => sum + part.xp, 0));
  const second = calcMatchXp({ score: 300, roundWins: 1, rank: 2, players: 4, won: false });
  assert.ok(second.parts.some(part => part.label === '준우승'));
  const loser = calcMatchXp({ score: 0, roundWins: 0, rank: 2, players: 2, won: false });
  assert.equal(loser.total, 20);
});

test('calcMatchXp: 점수 경험치 상한', () => {
  const huge = calcMatchXp({ score: 100000, players: 2 });
  assert.equal(huge.total, 20 + 300);
});

test('matchEligible: 단어 수와 참여자 수 조건', () => {
  assert.equal(matchEligible({ totalWords: 5, contributors: 2 }), false);
  assert.equal(matchEligible({ totalWords: 6, contributors: 1 }), false);
  assert.equal(matchEligible({ totalWords: 6, contributors: 2 }), true);
});
