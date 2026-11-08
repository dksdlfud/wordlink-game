'use strict';
// 계정별 전적 · 경험치 저장소.
// 메모리에 전부 올려 두고, 바뀐 것만 모아서 (기본 2초) 저장한다.
//   - 기본: JSON 파일 (DATA_DIR/profiles.json, 기본 ./data). 임시 파일에 쓴 뒤 rename 하므로 쓰다가 꺼져도 깨지지 않는다.
//   - DATABASE_URL 이 있으면: PostgreSQL (wl_profiles 테이블). `pg` 패키지가 필요하다.
// ⚠ Render 무료 플랜처럼 디스크가 재배포·재시작 때 초기화되는 곳에서는 파일 저장소의 기록도 함께 사라진다. README의 '기록 저장' 참고.

const fs = require('node:fs');
const path = require('node:path');
const { levelInfo } = require('./progress');

const KEY_PATTERN = /^s-[a-f0-9]{32}$/;
const RECENT_LIMIT = 10;
const PERSIST_DELAY_MS = 2000;

const num = (value, max = Number.MAX_SAFE_INTEGER) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
};
const text = (value, max) => String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, max);

function blankProfile(now) {
  return {
    name: '', provider: '', createdAt: now, lastSeenAt: now,
    xp: 0, games: 0, wins: 0, roundWins: 0, totalScore: 0, bestMatchScore: 0,
    words: 0, longestWord: '', bestWord: '', bestWordPoints: 0, missionHits: 0,
    streak: 0, bestStreak: 0, recent: []
  };
}
// 파일/DB에서 읽은 값은 믿지 않고 형식을 맞춰 가져온다.
function sanitizeProfile(raw, now = Date.now()) {
  const base = blankProfile(now);
  if (!raw || typeof raw !== 'object') return base;
  const recent = Array.isArray(raw.recent) ? raw.recent.slice(0, RECENT_LIMIT).map(item => ({
    at: num(item?.at), rank: num(item?.rank), players: num(item?.players), score: num(item?.score), xp: num(item?.xp), won: Boolean(item?.won)
  })) : [];
  return {
    name: text(raw.name, 12), provider: text(raw.provider, 12),
    createdAt: num(raw.createdAt) || now, lastSeenAt: num(raw.lastSeenAt) || now,
    xp: num(raw.xp), games: num(raw.games), wins: num(raw.wins), roundWins: num(raw.roundWins),
    totalScore: num(raw.totalScore), bestMatchScore: num(raw.bestMatchScore), words: num(raw.words),
    longestWord: text(raw.longestWord, 12), bestWord: text(raw.bestWord, 12), bestWordPoints: num(raw.bestWordPoints),
    missionHits: num(raw.missionHits), streak: num(raw.streak), bestStreak: num(raw.bestStreak), recent
  };
}

// ---- 저장 백엔드 ----
function fileBackend(file) {
  return {
    async load() {
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
      try {
        const data = JSON.parse(raw);
        return data && typeof data.profiles === 'object' && data.profiles ? data.profiles : {};
      } catch {
        // 파일이 깨졌으면 덮어쓰기 전에 보관해 둔다.
        const backup = `${file}.corrupt-${Date.now()}`;
        fs.renameSync(file, backup);
        console.error(`[store] ${file} 을(를) 읽을 수 없어 ${backup} 로 옮기고 새로 시작합니다.`);
        return {};
      }
    },
    async save(_dirty, all) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: all() }));
      fs.renameSync(tmp, file);
    }
  };
}
function pgBackend(pool) {
  return {
    async load() {
      await pool.query('create table if not exists wl_profiles (key text primary key, data jsonb not null, updated_at timestamptz not null default now())');
      const result = await pool.query('select key, data from wl_profiles');
      return Object.fromEntries(result.rows.map(row => [row.key, row.data]));
    },
    async save(dirty, all) {
      const profiles = all();
      for (const key of dirty) {
        if (!profiles[key]) continue;
        await pool.query('insert into wl_profiles (key, data, updated_at) values ($1, $2::jsonb, now()) on conflict (key) do update set data = excluded.data, updated_at = now()', [key, JSON.stringify(profiles[key])]);
      }
    }
  };
}

function createStore(options = {}) {
  const now = options.now || Date.now;
  const backend = options.backend || fileBackend(options.file || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'profiles.json'));
  const persistDelay = options.persistDelay ?? PERSIST_DELAY_MS;
  const profiles = new Map();
  const dirty = new Set();
  let timer = null;
  let saving = Promise.resolve();

  const ready = backend.load().then(loaded => {
    for (const [key, value] of Object.entries(loaded)) if (KEY_PATTERN.test(key)) profiles.set(key, sanitizeProfile(value, now()));
  });

  function persistNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty.size) return saving;
    const keys = [...dirty];
    dirty.clear();
    const all = () => Object.fromEntries([...profiles]);
    saving = saving.then(() => backend.save(keys, all)).catch(error => {
      console.error('[store] 저장 실패:', error.message);
      keys.forEach(key => dirty.add(key)); // 다음 기회에 다시 시도
    });
    return saving;
  }
  function markDirty(key) {
    dirty.add(key);
    if (timer) return;
    timer = setTimeout(() => { timer = null; persistNow(); }, persistDelay);
    timer.unref?.();
  }
  const view = (key, profile) => {
    const info = levelInfo(profile.xp);
    return { ...profile, recent: profile.recent.map(item => ({ ...item })), level: info.level, levelInfo: info };
  };

  return {
    ready,
    size: () => profiles.size,
    has: key => profiles.has(key),
    // 접속할 때마다 호출: 없으면 만들고, 마지막 닉네임·접속 시각을 갱신한다.
    touch(key, { name = '', provider = '' } = {}) {
      if (!KEY_PATTERN.test(key)) return null;
      let profile = profiles.get(key);
      if (!profile) { profile = blankProfile(now()); profiles.set(key, profile); }
      const nextName = text(name, 12);
      if (nextName) profile.name = nextName;
      if (provider) profile.provider = text(provider, 12);
      profile.lastSeenAt = now();
      markDirty(key);
      return view(key, profile);
    },
    get(key) {
      const profile = profiles.get(key);
      return profile ? view(key, profile) : null;
    },
    // 경기 한 판의 결과를 반영한다. 이전·이후 경험치를 돌려줘 레벨 업 연출에 쓴다.
    recordMatch(key, result) {
      const profile = profiles.get(key);
      if (!profile) return null;
      const xpBefore = profile.xp;
      const xp = num(result.xp);
      profile.xp += xp;
      profile.games += 1;
      if (result.won) profile.wins += 1;
      profile.roundWins += num(result.roundWins);
      const score = num(result.score);
      profile.totalScore += score;
      profile.bestMatchScore = Math.max(profile.bestMatchScore, score);
      for (const item of result.words || []) {
        profile.words += 1;
        profile.missionHits += num(item.missions);
        if (item.word.length > profile.longestWord.length) profile.longestWord = text(item.word, 12);
        if (num(item.points) > profile.bestWordPoints) { profile.bestWordPoints = num(item.points); profile.bestWord = text(item.word, 12); }
      }
      profile.streak = result.won ? profile.streak + 1 : 0;
      profile.bestStreak = Math.max(profile.bestStreak, profile.streak);
      profile.recent.unshift({ at: now(), rank: num(result.rank), players: num(result.players), score, xp, won: Boolean(result.won) });
      profile.recent.length = Math.min(profile.recent.length, RECENT_LIMIT);
      markDirty(key);
      return { xpBefore, xpAfter: profile.xp, before: levelInfo(xpBefore), after: levelInfo(profile.xp) };
    },
    // 랭킹: 경험치 순. 이름만 내보내고 계정 키는 절대 내보내지 않는다.
    top(limit = 30, minGames = 1) {
      return [...profiles.values()]
        .filter(profile => profile.games >= minGames && profile.name)
        .sort((a, b) => b.xp - a.xp || b.wins - a.wins || a.createdAt - b.createdAt)
        .slice(0, limit)
        .map((profile, index) => ({ rank: index + 1, name: profile.name, level: levelInfo(profile.xp).level, xp: profile.xp, games: profile.games, wins: profile.wins }));
    },
    rankOf(key) {
      const mine = profiles.get(key);
      if (!mine || mine.games < 1) return null;
      let better = 0;
      for (const profile of profiles.values()) if (profile.games >= 1 && (profile.xp > mine.xp || (profile.xp === mine.xp && profile.wins > mine.wins))) better += 1;
      return better + 1;
    },
    flush: persistNow
  };
}

// 환경변수로 저장소를 고른다. DATABASE_URL 이 있으면 PostgreSQL, 없으면 파일.
function createStoreFromEnv(env = process.env) {
  if (env.DATABASE_URL) {
    let Pool;
    try { ({ Pool } = require('pg')); } catch { throw new Error('DATABASE_URL 이 설정됐지만 pg 패키지가 없어요. `npm install pg` 를 실행해 주세요.'); }
    const pool = new Pool({ connectionString: env.DATABASE_URL, ssl: env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 3 });
    return createStore({ backend: pgBackend(pool) });
  }
  return createStore({ file: path.join(env.DATA_DIR || path.join(__dirname, 'data'), 'profiles.json') });
}

module.exports = { createStore, createStoreFromEnv, fileBackend, pgBackend, sanitizeProfile, KEY_PATTERN };
