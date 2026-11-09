'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, pgBackend, sanitizeProfile } = require('./store');

const KEY = `s-${'a'.repeat(32)}`;
const KEY2 = `s-${'b'.repeat(32)}`;
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wl-store-')), 'profiles.json');
const match = (extra = {}) => ({ xp: 100, score: 200, roundWins: 2, won: true, rank: 1, players: 3, words: [{ word: '사과', points: 30, missions: 1 }, { word: '과일나무', points: 50, missions: 0 }], ...extra });

test('touch: 새 프로필을 만들고 이름을 갱신한다', async () => {
  const store = createStore({ file: tmpFile(), persistDelay: 0 });
  await store.ready;
  assert.equal(store.get(KEY), null);
  const profile = store.touch(KEY, { name: '철수', provider: 'google' });
  assert.equal(profile.name, '철수');
  assert.equal(profile.level, 1);
  assert.equal(store.touch(KEY, { name: '영희' }).name, '영희');
  assert.equal(store.touch('invalid-key', { name: 'x' }), null);
});

test('recordMatch: 전적과 경험치, 연승이 쌓인다', async () => {
  const store = createStore({ file: tmpFile(), persistDelay: 0 });
  await store.ready;
  store.touch(KEY, { name: '철수' });
  const first = store.recordMatch(KEY, match());
  assert.equal(first.after.level, 2); // 100xp → 레벨 2
  store.recordMatch(KEY, match({ score: 50 }));
  let profile = store.get(KEY);
  assert.equal(profile.games, 2);
  assert.equal(profile.wins, 2);
  assert.equal(profile.streak, 2);
  assert.equal(profile.bestMatchScore, 200);
  assert.equal(profile.totalScore, 250);
  assert.equal(profile.longestWord, '과일나무');
  assert.equal(profile.bestWord, '과일나무');
  assert.equal(profile.missionHits, 2);
  store.recordMatch(KEY, match({ won: false, rank: 2 }));
  profile = store.get(KEY);
  assert.equal(profile.streak, 0);
  assert.equal(profile.bestStreak, 2);
  assert.equal(profile.recent.length, 3);
  assert.equal(profile.recent[0].won, false);
});

test('recordMatch: 최근 기록은 10개까지만', async () => {
  const store = createStore({ file: tmpFile(), persistDelay: 0 });
  await store.ready;
  store.touch(KEY, { name: '철수' });
  for (let i = 0; i < 15; i += 1) store.recordMatch(KEY, match());
  assert.equal(store.get(KEY).recent.length, 10);
  assert.equal(store.recordMatch(KEY2, match()), null); // 프로필이 없으면 무시
});

test('top / rankOf: 경험치 순, 이름만 노출', async () => {
  const store = createStore({ file: tmpFile(), persistDelay: 0 });
  await store.ready;
  store.touch(KEY, { name: '철수' });
  store.touch(KEY2, { name: '영희' });
  store.recordMatch(KEY, match({ xp: 50 }));
  store.recordMatch(KEY2, match({ xp: 300 }));
  const top = store.top();
  assert.deepEqual(top.map(row => row.name), ['영희', '철수']);
  assert.equal(top[0].rank, 1);
  assert.ok(!JSON.stringify(top).includes(KEY));
  assert.equal(store.rankOf(KEY), 2);
  assert.equal(store.rankOf(`s-${'c'.repeat(32)}`), null);
});

test('파일 저장: flush 후 새 저장소에서 그대로 읽힌다', async () => {
  const file = tmpFile();
  const a = createStore({ file, persistDelay: 60000 });
  await a.ready;
  a.touch(KEY, { name: '철수', provider: 'github' });
  a.recordMatch(KEY, match());
  await a.flush();
  const b = createStore({ file, persistDelay: 60000 });
  await b.ready;
  const profile = b.get(KEY);
  assert.equal(profile.name, '철수');
  assert.equal(profile.xp, 100);
  assert.equal(profile.games, 1);
});

test('파일이 깨져 있으면 백업하고 빈 상태로 시작한다', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ 깨진 json');
  const store = createStore({ file, persistDelay: 0 });
  await store.ready;
  assert.equal(store.size(), 0);
  assert.ok(fs.readdirSync(path.dirname(file)).some(name => name.includes('.corrupt-')));
});

test('로드한 값은 형식을 다시 맞춘다 (이상한 키·값 무시)', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ profiles: { [KEY]: { name: '<b>철수</b>', xp: '12abc', games: -3, recent: 'x' }, __proto__x: { xp: 9 }, 'bad key': { xp: 9 } } }));
  const store = createStore({ file, persistDelay: 0 });
  await store.ready;
  assert.equal(store.size(), 1);
  const profile = store.get(KEY);
  assert.equal(profile.name, 'b철수/b');
  assert.equal(profile.xp, 0);
  assert.equal(profile.games, 0);
  assert.deepEqual(profile.recent, []);
  assert.equal(sanitizeProfile(null).xp, 0);
});

test('pg 백엔드: 테이블 생성 · 불러오기 · 바뀐 키만 upsert', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: sql.trim().split(/\s+/).slice(0, 3).join(' '), params });
      if (sql.includes('select key, data')) return { rows: [{ key: KEY, data: { name: '철수', xp: 250 } }] };
      return { rows: [] };
    }
  };
  const store = createStore({ backend: pgBackend(pool), persistDelay: 60000 });
  await store.ready;
  assert.equal(store.get(KEY).xp, 250);
  store.touch(KEY2, { name: '영희' });
  await store.flush();
  const upserts = calls.filter(call => call.sql.startsWith('insert into wl_profiles'));
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].params[0], KEY2);
});

test('저장에 실패하면 다음 flush에서 다시 시도한다', async () => {
  let fail = true;
  const saved = [];
  const backend = { async load() { return {}; }, async save(keys) { if (fail) throw new Error('disk full'); saved.push(...keys); } };
  const store = createStore({ backend, persistDelay: 60000 });
  await store.ready;
  const originalError = console.error; console.error = () => {};
  store.touch(KEY, { name: '철수' });
  await store.flush();
  fail = false;
  await store.flush();
  console.error = originalError;
  assert.deepEqual(saved, [KEY]);
});

test('avatar: 저장되고, 다른 접속에서 touch 해도 유지되며, 지울 수 있다', async () => {
  const store = createStore({ file: tmpFile(), persistDelay: 0 });
  await store.ready;
  assert.equal(store.touch(KEY, { name: '철수' }).avatar, '');
  assert.equal(store.touch(KEY, { avatar: '🐶' }).avatar, '🐶');
  assert.equal(store.touch(KEY, { name: '철수' }).avatar, '🐶'); // 사진 없이 touch 해도 그대로
  store.recordMatch(KEY, match());
  assert.equal(store.top(5)[0].avatar, '🐶');
  assert.equal(store.touch(KEY, { clearAvatar: true }).avatar, '');
  assert.equal(sanitizeProfile({ avatar: '<b>🐱' }).avatar, 'b🐱');
});
