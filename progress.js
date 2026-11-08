'use strict';
// 레벨 · 경험치 · 칭호 계산 (순수 함수 — 서버와 테스트에서 함께 쓴다)

const MAX_LEVEL = 99;
const MIN_MATCH_WORDS = 6;      // 경기 전체 단어가 이보다 적으면 경험치를 주지 않는다 (혼자 방 만들어 파밍 방지)
const MIN_MATCH_CONTRIBUTORS = 2; // 단어를 낸 서로 다른 사람이 이보다 적으면 경험치를 주지 않는다
const SCORE_XP_RATE = 0.2;      // 경기 점수 × 0.2 만큼 경험치
const SCORE_XP_CAP = 300;       // 점수로 받는 경험치 상한

// 레벨 L → L+1 에 필요한 경험치. 1→2: 100, 10→11: 784, 30→31: 약 3,900, 50→51: 약 11,700
function xpNeeded(level) {
  const n = Math.max(1, Math.floor(level)) - 1;
  return 100 + 40 * n + 4 * n * n;
}

// 누적 경험치 → 레벨 정보. 만렙이면 need=0, pct=100.
function levelInfo(totalXp) {
  let xp = Math.max(0, Math.floor(Number(totalXp) || 0));
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpNeeded(level)) { xp -= xpNeeded(level); level += 1; }
  if (level >= MAX_LEVEL) return { level: MAX_LEVEL, into: xp, need: 0, pct: 100, max: true };
  const need = xpNeeded(level);
  return { level, into: xp, need, pct: Math.min(100, Math.floor((xp / need) * 100)), max: false };
}

const TITLES = [
  { from: 1, name: '낱말 새싹' },
  { from: 5, name: '글자 수집가' },
  { from: 10, name: '단어 탐험가' },
  { from: 20, name: '말잇기 달인' },
  { from: 35, name: '어휘 장인' },
  { from: 50, name: '사전 박사' },
  { from: 70, name: '언어의 마법사' },
  { from: 90, name: '말잇기 전설' }
];
function titleFor(level) {
  let found = TITLES[0];
  for (const title of TITLES) if (level >= title.from) found = title;
  return found.name;
}
// 레벨 배지 색 단계 (0~7). 칭호 구간과 같다.
function tierFor(level) {
  let tier = 0;
  TITLES.forEach((title, index) => { if (level >= title.from) tier = index; });
  return tier;
}

// 한 경기 결과 → 경험치. rank는 1부터. 구성 요소를 함께 돌려줘 화면에서 내역을 보여 줄 수 있다.
function calcMatchXp({ score = 0, roundWins = 0, rank = 1, players = 2, won = false }) {
  const parts = [{ label: '경기 참가', xp: 20 }];
  const scoreXp = Math.min(SCORE_XP_CAP, Math.floor(Math.max(0, score) * SCORE_XP_RATE));
  if (scoreXp > 0) parts.push({ label: `획득 점수 ${score}점`, xp: scoreXp });
  if (roundWins > 0) parts.push({ label: `라운드 ${roundWins}승`, xp: roundWins * 10 });
  if (won) parts.push({ label: '최종 우승', xp: 40 });
  else if (rank === 2 && players >= 3) parts.push({ label: '준우승', xp: 15 });
  if (players > 2) parts.push({ label: `${players}인 경기`, xp: (players - 2) * 5 });
  return { total: parts.reduce((sum, part) => sum + part.xp, 0), parts };
}

function matchEligible({ totalWords = 0, contributors = 0 }) {
  return totalWords >= MIN_MATCH_WORDS && contributors >= MIN_MATCH_CONTRIBUTORS;
}

module.exports = { MAX_LEVEL, MIN_MATCH_WORDS, MIN_MATCH_CONTRIBUTORS, xpNeeded, levelInfo, titleFor, tierFor, calcMatchXp, matchEligible, TITLES };
