'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const app = $('#app');
  const toastNode = $('#toast');
  const connectionDot = $('#connection-dot');
  const connectionLabel = $('#connection-label');
  const SESSION_KEY = 'wordlink.session.v1';
  const PLAYER_KEY = 'wordlink.playerId.v1';
  const SOUND_KEY = 'wordlink.sound.v1';
  const NICKMODE_KEY = 'wordlink.nickmode.v1';
  const REACTIONS = ['👍', '😂', '😮', '🔥', '👏', '😭'];
  const REACTION_COOLDOWN_MS = 350;
  const TOTAL_TIME_OPTIONS = [20, 40, 60, 80, 100, 150, 500];
  const ROUND_OPTIONS = [3, 5, 7];

  const state = {
    socket: null,
    room: null,
    session: null,
    restoring: false,
    toastTimer: null,
    summaryClosedGame: null,
    summaryShownGame: null,
    lastTick: '',
    lastReactionAt: 0,
    nickname: null,          // 로비에 입장한 닉네임 (없으면 홈 화면)
    auth: { providers: [], user: null }, // 소셜 로그인 상태 (/auth/me) — user가 있으면 로그인됨
    hub: { rooms: [], users: [], total: 0, chat: [], onlyJoinable: false },
    profile: null,           // 내 경험치·전적 (null: 아직 모름 · { guest: true }: 게스트 · 그 밖에는 서버가 준 프로필)
    rewards: new Map(),      // gameId → 그 경기에서 받은 경험치 (결과 화면에 표시)
    dialogClose: null,
    draft: { key: '', value: '' }, // 입력 중인 단어 (화면이 다시 그려져도 유지)
    screen: '',   // 지금 보이는 화면 종류 (home · hub · lobby · game) — 같은 화면을 다시 그릴 땐 등장 애니메이션을 생략한다.
    shown: null   // 직전에 그린 게임 화면의 스냅샷 — 무엇이 바뀌었는지 비교해 필요한 곳만 움직인다.
  };
  const CHAT_MAX_LENGTH = 120;

  // 같은 화면을 다시 그릴 때는 fade-in이 매번 처음부터 재생돼 깜빡이므로, 화면이 '바뀔 때만' 등장 효과를 쓴다.
  function enterScreen(key) {
    const same = state.screen === key;
    state.screen = key;
    if (!same) window.Bokgu?.screen(key); // 도우미 복구에게 화면 전환을 알린다.
    // 무한 반복 애니메이션이 화면을 다시 그려도 끊기지 않고 이어지도록 위상을 맞춘다.
    document.documentElement.style.setProperty('--ph', `${Math.round(performance.now())}ms`);
    return same;
  }
  function settleScreen(same) {
    if (!same) return;
    const section = app.firstElementChild;
    if (section) section.classList.remove('fade-in');
  }
  // 목록을 통째로 갈아엎지 않고 달라진 항목만 바꾼다. (호버·애니메이션이 끊기지 않고, 새 항목만 부드럽게 등장)
  function patchList(container, items, keyOf, htmlOf, enterClass) {
    const hadItems = Boolean(container.querySelector('[data-key]'));
    const old = new Map();
    for (const el of container.children) if (el.dataset && el.dataset.key) old.set(el.dataset.key, el);
    const nodes = items.map(item => {
      const key = String(keyOf(item));
      const html = htmlOf(item).trim();
      const prev = old.get(key);
      if (prev && prev.dataset.sig === html) return prev;
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      const fresh = tpl.content.firstElementChild;
      fresh.dataset.key = key;
      fresh.dataset.sig = html;
      if (!prev && hadItems && enterClass) fresh.classList.add(enterClass);
      return fresh;
    });
    const keep = new Set(nodes);
    for (const el of [...container.children]) if (!keep.has(el)) el.remove();
    nodes.forEach((node, index) => {
      if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
    });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function playerId() {
    let id = localStorage.getItem(PLAYER_KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `wl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(PLAYER_KEY, id);
    }
    return id;
  }
  function saveSession(session) {
    state.session = session;
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
  function clearSession() {
    state.session = null;
    state.room = null;
    localStorage.removeItem(SESSION_KEY);
  }
  function readSession() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      return value && value.code && value.playerId && value.name ? value : null;
    } catch { return null; }
  }
  function showToast(message, type = 'info') {
    toastNode.textContent = message;
    toastNode.className = `toast show ${type}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toastNode.className = 'toast'; }, 2600);
  }
  function request(event, payload = {}) {
    return new Promise(resolve => {
      if (!state.socket || !state.socket.connected) {
        resolve({ ok: false, message: '서버와 연결되지 않았어요. 연결 상태를 확인해 주세요.' });
        return;
      }
      state.socket.timeout(7000).emit(event, payload, (error, result) => {
        if (error) resolve({ ok: false, message: '서버 응답이 늦어요. 다시 시도해 주세요.' });
        else resolve(result || { ok: false, message: '서버에서 응답을 받지 못했어요.' });
      });
    });
  }
  // 같은 닉네임은 어떤 방·어떤 기기에서도 같은 색이 나오도록 이름만으로 색을 정한다.
  function hashName(name) {
    let hash = 2166136261;
    for (const char of String(name ?? '').normalize('NFC')) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }
  function avatarStyle(name) {
    const hash = hashName(name);
    const hue = (hash % 24) * 15;
    const base = (hash >>> 8) & 1 ? 74 : 62;
    return `--av-a:hsl(${hue},58%,${base + 6}%);--av-b:hsl(${hue},52%,${base - 12}%);--av-fg:hsl(${hue},45%,10%)`;
  }
  function avatar(name, small = false) {
    return `<span class="avatar tinted ${small ? 'small' : ''}" style="${avatarStyle(name)}">${escapeHtml((name || '?').slice(0, 1))}</span>`;
  }
  // ---------- 레벨 ----------
  const TIER_FROM = [1, 5, 10, 20, 35, 50, 70, 90]; // 칭호 구간 시작 레벨 — progress.js 의 TITLES 와 같게 유지
  function tierOf(level) { let tier = 0; TIER_FROM.forEach((from, index) => { if (level >= from) tier = index; }); return tier; }
  // 게스트(레벨 없음)는 배지를 그리지 않는다.
  function lvBadge(level) { return Number.isFinite(level) && level > 0 ? `<span class="lv-badge tier-${tierOf(level)}" title="레벨 ${level}">Lv.${level}</span>` : ''; }
  function xpBar(pct, extraClass = '', style = '') { return `<div class="xp-track"><i class="xp-fill ${extraClass}" style="width:${Math.max(0, Math.min(100, pct))}%;${style}"></i></div>`; }
  async function loadProfile() {
    const result = await request('profile:me');
    if (!result.ok) return null;
    state.profile = result.guest ? { guest: true } : result.profile;
    updateProfile();
    return state.profile;
  }
  function setConnection(connected) {
    connectionDot.className = connected ? 'online' : 'offline';
    connectionLabel.textContent = connected ? '서버 연결됨' : '연결 끊김';
  }
  function setRoom(room) {
    state.room = room;
    render();
  }

  // ---------- 효과음 (WebAudio로 직접 합성 — 별도 음원 파일 없음) ----------
  const sound = (() => {
    let ctx = null;
    let enabled = true;
    try { enabled = localStorage.getItem(SOUND_KEY) !== 'off'; } catch { /* 저장소를 못 쓰면 기본값(켜짐) */ }
    const lastPlayed = {};
    const PATTERNS = {
      submit: [{ freq: 523, dur: .09 }, { freq: 784, at: .08, dur: .14 }],
      word: [{ freq: 440, dur: .08, type: 'triangle', gain: .05 }],
      turn: [{ freq: 659, dur: .1 }, { freq: 988, at: .11, dur: .18 }],
      tick: [{ freq: 1320, dur: .05, type: 'square', gain: .025 }],
      error: [{ freq: 180, dur: .16, type: 'square', gain: .04, to: 140 }],
      eliminate: [{ freq: 392, dur: .35, type: 'sawtooth', gain: .04, to: 130 }],
      out: [{ freq: 300, dur: .2, type: 'triangle', gain: .05, to: 200 }],
      start: [{ freq: 440, dur: .1 }, { freq: 554, at: .1, dur: .1 }, { freq: 659, at: .2, dur: .2 }],
      win: [523, 659, 784, 1047].map((freq, i) => ({ freq, at: i * .12, dur: i === 3 ? .5 : .14 })),
      end: [{ freq: 392, dur: .18, type: 'triangle' }, { freq: 330, at: .18, dur: .18, type: 'triangle' }, { freq: 262, at: .36, dur: .4, type: 'triangle' }],
      bonus: [{ freq: 784, dur: .08 }, { freq: 1047, at: .08, dur: .08 }, { freq: 1319, at: .16, dur: .22 }],
      pop: [{ freq: 700, dur: .07, gain: .035, to: 1000 }],
      toggle: [{ freq: 880, dur: .08, gain: .05 }]
    };
    function context() {
      if (!ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        try { ctx = new Ctor(); } catch { return null; }
      }
      return ctx;
    }
    // 브라우저 정책상 첫 사용자 입력 이후에야 소리를 낼 수 있다.
    function unlock() {
      const audio = context();
      if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
    }
    function tone(audio, { freq, at = 0, dur = .12, type = 'sine', gain = .07, to = null }) {
      const start = audio.currentTime + at;
      const osc = audio.createOscillator();
      const amp = audio.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, start + dur);
      amp.gain.setValueAtTime(0.0001, start);
      amp.gain.exponentialRampToValueAtTime(gain, start + .012);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(amp);
      amp.connect(audio.destination);
      osc.start(start);
      osc.stop(start + dur + .03);
    }
    function play(name, delayMs = 0) {
      if (!enabled || !PATTERNS[name]) return;
      if (delayMs > 0) { setTimeout(() => play(name), delayMs); return; }
      const audio = context();
      if (!audio) return;
      if (audio.state !== 'running') { unlock(); return; }
      const now = performance.now();
      if (now - (lastPlayed[name] ?? -Infinity) < 70) return;
      lastPlayed[name] = now;
      PATTERNS[name].forEach(note => tone(audio, note));
    }
    async function setEnabled(value) {
      enabled = Boolean(value);
      try { localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off'); } catch { /* 무시 */ }
      if (enabled) {
        const audio = context();
        if (audio && audio.state === 'suspended') { try { await audio.resume(); } catch { /* 무시 */ } }
        play('toggle');
      }
    }
    ['pointerdown', 'keydown', 'touchend'].forEach(type => window.addEventListener(type, unlock, { passive: true }));
    return { play, setEnabled, get enabled() { return enabled; } };
  })();
  function syncSoundButton() {
    const button = $('#sound-toggle');
    if (!button) return;
    button.setAttribute('aria-pressed', String(sound.enabled));
    button.setAttribute('aria-label', sound.enabled ? '효과음 켜짐 (누르면 끄기)' : '효과음 꺼짐 (누르면 켜기)');
    const label = $('#sound-state');
    if (label) label.textContent = sound.enabled ? 'ON' : 'OFF';
  }

  // 미션 글자가 사용돼 새 미션이 제시되면 모두에게 알려 준다.
  function announceMissionChange(prev, next) {
    const change = next && next.missionChange;
    if (!change || !next.code) return;
    if (prev && prev.code === next.code && prev.gameId === next.gameId && prev.missionChange && prev.missionChange.seq === change.seq) return;
    if (!prev || prev.code !== next.code) { state.missionFlashSeq = change.seq; return; } // 재접속 시에는 알림 생략
    state.missionFlashSeq = change.seq;
    showToast(`🎯 ${change.playerName}님이 미션 ‘${change.from}’ 성공! 새 미션은 ‘${change.to}’`, 'success');
  }

  // 방 상태가 바뀔 때 이전/다음 스냅샷을 비교해 알맞은 효과음을 낸다.
  function playRoomSounds(prev, next) {
    if (!prev || !state.session || prev.code !== next.code) return;
    const me = state.session.playerId;
    if (prev.state !== 'playing' && next.state === 'playing') { sound.play('start'); return; }
    if (prev.state === 'playing' && next.state === 'finished') { sound.play(next.winnerId && next.winnerId === me ? 'win' : 'end'); return; }
    if (prev.state === 'playing' && next.state === 'intermission') { sound.play(next.roundResult && next.roundResult.winnerId === me ? 'win' : 'end'); return; }
    if (next.state !== 'playing') return;
    const newWord = next.totalWords > prev.totalWords;
    const lastWord = newWord ? next.words.filter(item => item.type === 'word').slice(-1)[0] : null;
    const prevOut = new Set(prev.players.filter(player => player.eliminated).map(player => player.id));
    const newlyOut = next.players.filter(player => player.eliminated && !prevOut.has(player.id));
    const myTurnNow = next.currentPlayerId === me && prev.currentPlayerId !== me;
    if (newlyOut.length) sound.play(newlyOut.some(player => player.id === me) ? 'eliminate' : 'out');
    else if (lastWord && lastWord.playerId !== me) sound.play('word'); // 내 단어는 제출 응답에서 따로 재생
    if (myTurnNow) sound.play('turn', newlyOut.length || (lastWord && lastWord.playerId !== me) ? 220 : 0);
  }

  // ---------- 이모지 반응 ----------
  function showReaction(payload) {
    const layer = $('#reaction-layer');
    if (!layer || !payload || !REACTIONS.includes(payload.emoji)) return;
    sound.play('pop');
    if (document.hidden) return;
    while (layer.children.length >= 30) layer.firstChild.remove();
    const node = document.createElement('div');
    node.className = `reaction-float${state.session && payload.playerId === state.session.playerId ? ' mine' : ''}`;
    node.style.left = `${8 + Math.random() * 84}%`;
    node.style.setProperty('--drift', `${Math.round((Math.random() - .5) * 70)}px`);
    const emoji = document.createElement('span');
    emoji.className = 'reaction-emoji';
    emoji.textContent = payload.emoji;
    const name = document.createElement('span');
    name.className = 'reaction-name';
    name.textContent = String(payload.name ?? '');
    name.style.cssText = avatarStyle(payload.name);
    node.append(emoji, name);
    layer.append(node);
    node.addEventListener('animationend', () => node.remove());
    setTimeout(() => node.remove(), 3200);
  }
  async function sendReaction(emoji) {
    if (!state.room || !state.session || !REACTIONS.includes(emoji)) return;
    const now = Date.now();
    if (now - state.lastReactionAt < REACTION_COOLDOWN_MS) return;
    state.lastReactionAt = now;
    const result = await request('game:react', { code: state.room.code, playerId: state.session.playerId, emoji });
    if (!result.ok && !result.throttled) showToast(result.message, 'error');
  }

  // ---------- 라운드 결과 요약 ----------
  function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}분 ${String(seconds).padStart(2, '0')}초` : `${seconds}초`;
  }
  // 결과 화면의 경험치 영역. 로그인했으면 이번 경기에서 받은 경험치와 내역, 게스트면 로그인 안내.
  function rewardMarkup(reward, animate) {
    if (!reward) return state.auth.user ? '' : '<p class="reward-note">로그인하면 경험치와 전적이 저장돼요.</p>';
    if (reward.skipped === 'short') return '<p class="reward-note">경기가 너무 짧아 경험치는 지급되지 않았어요. (단어 6개 이상 · 2명 이상 참여)</p>';
    if (reward.skipped === 'noword') return '<p class="reward-note">단어를 하나도 내지 않아 경험치는 지급되지 않았어요.</p>';
    const from = reward.leveledUp ? 0 : reward.before.pct;
    const parts = reward.parts.map(part => `<li><span>${escapeHtml(part.label)}</span><b>+${part.xp}</b></li>`).join('');
    return `<div class="reward-box${reward.leveledUp ? ' levelup' : ''}">
      <div class="reward-head">
        <strong>+${reward.xp} XP</strong>
        <span class="reward-level">${lvBadge(reward.after.level)}${reward.leveledUp ? `<em>LEVEL UP!</em>` : ''}</span>
      </div>
      ${xpBar(reward.after.pct, animate ? 'grow' : '', `--from:${from}%`)}
      <div class="reward-sub"><span>${escapeHtml(reward.title)}${reward.newTitle ? ' · 새 칭호!' : ''}</span><span>${reward.after.max ? 'MAX' : `다음 레벨까지 ${(reward.after.need - reward.after.into).toLocaleString('ko-KR')} XP`}</span></div>
      <ul class="reward-parts">${parts}</ul>
    </div>`;
  }

  // ---------- 마이페이지 · 랭킹 ----------
  function loginPrompt(title, note) {
    const links = state.auth.providers.map(provider => `<a class="social-button social-${escapeHtml(provider.id)}" href="/auth/${encodeURIComponent(provider.id)}?next=%2F"><i aria-hidden="true">${escapeHtml(provider.label.slice(0, 1))}</i>${escapeHtml(provider.label)}</a>`).join('');
    openDialog(`
      <h2 class="dialog-title">${title}</h2>
      <p class="dialog-note">${note}</p>
      ${links ? `<div class="social-row" style="margin-top:16px">${links}</div>` : '<p class="dialog-note" style="margin-top:12px">이 서버에는 아직 소셜 로그인이 설정되어 있지 않아요.</p>'}
      <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>닫기</button></div>`);
  }
  function formatAgo(at) {
    const diff = Math.max(0, Date.now() - at);
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '방금';
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    return `${Math.floor(hours / 24)}일 전`;
  }
  async function openMyPage() {
    if (!state.auth.user) {
      return loginPrompt('👤 마이페이지', '게스트는 기록이 저장되지 않아요.<br>소셜 계정으로 로그인하면 점수 · 레벨 · 전적이 쌓이고 랭킹에 올라요.');
    }
    const node = openDialog('<h2 class="dialog-title">👤 마이페이지</h2><p class="dialog-note">불러오는 중…</p>');
    const p = await loadProfile();
    if (!$('#dialog') || $('#dialog') !== node) return; // 그 사이 닫힘
    if (!p || p.guest) { node.firstElementChild.innerHTML = '<h2 class="dialog-title">👤 마이페이지</h2><p class="dialog-note">기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p><div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>닫기</button></div>'; node.querySelector('[data-cancel]').addEventListener('click', closeDialog); return; }
    const winRate = p.games ? `${Math.round((p.wins / p.games) * 100)}%` : '–';
    const tile = (label, value, note = '') => `<div class="mp-tile"><small>${label}</small><strong>${value}</strong>${note ? `<span>${note}</span>` : ''}</div>`;
    const tiles = [
      tile('플레이', `${p.games}판`, `${p.wins}승`),
      tile('승률', winRate),
      tile('연승', `${p.streak}`, `최고 ${p.bestStreak}`),
      tile('라운드 승리', `${p.roundWins}`),
      tile('누적 점수', p.totalScore.toLocaleString('ko-KR')),
      tile('한 경기 최고', p.bestMatchScore.toLocaleString('ko-KR')),
      tile('낸 단어', `${p.words.toLocaleString('ko-KR')}개`),
      tile('가장 긴 단어', p.longestWord ? escapeHtml(p.longestWord) : '–', p.longestWord ? `${p.longestWord.length}글자` : ''),
      tile('최고 득점 단어', p.bestWord ? escapeHtml(p.bestWord) : '–', p.bestWord ? `+${p.bestWordPoints}점` : ''),
      tile('미션 글자', `${p.missionHits}회`)
    ].join('');
    const recent = p.recent.length ? p.recent.map(item => `<li class="mp-match${item.won ? ' won' : ''}"><span class="mp-rank">${item.won ? '🏆' : `${item.rank}위`}</span><span class="mp-match-info">${item.players}명 · ${item.score}점</span><b class="mp-xp">+${item.xp} XP</b><time>${formatAgo(item.at)}</time></li>`).join('') : '<li class="mp-empty">아직 기록이 없어요. 친구와 한 판 해 보세요!</li>';
    node.firstElementChild.classList.add('wide');
    node.firstElementChild.innerHTML = `
      <h2 class="dialog-title">👤 마이페이지</h2>
      <div class="mp-head">${avatar(p.name || state.nickname)}<div><strong>${escapeHtml(p.name || state.nickname)}</strong><span>${lvBadge(p.level)} ${escapeHtml(p.title)}${p.rank ? ` · 전체 ${p.rank}위` : ''}</span></div></div>
      <div class="xp-box mp-xp">
        <div class="xp-top"><b>경험치</b><span>${p.max ? 'MAX' : `${p.xpInto.toLocaleString('ko-KR')} / ${p.xpNeed.toLocaleString('ko-KR')} XP`}</span></div>
        ${xpBar(p.pct)}
        <div class="xp-total">누적 ${p.xp.toLocaleString('ko-KR')} XP</div>
      </div>
      <div class="mp-grid">${tiles}</div>
      <h3 class="mp-subtitle">최근 경기</h3>
      <ul class="mp-matches">${recent}</ul>
      <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>닫기</button></div>`;
    node.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', closeDialog));
  }
  async function openRanking() {
    const node = openDialog('<h2 class="dialog-title">🏆 랭킹</h2><p class="dialog-note">불러오는 중…</p>');
    const result = await request('ranking:top');
    if ($('#dialog') !== node) return;
    const card = node.firstElementChild;
    card.classList.add('wide');
    if (!result.ok) {
      card.innerHTML = `<h2 class="dialog-title">🏆 랭킹</h2><p class="dialog-note">${escapeHtml(result.message || '랭킹을 불러오지 못했어요.')}</p><div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>닫기</button></div>`;
    } else {
      const mine = state.auth.user ? state.nickname : null;
      const rows = result.list.length ? result.list.map(row => `<li class="rk-row${row.name === mine ? ' me' : ''}"><span class="rk-rank${row.rank <= 3 ? ` top${row.rank}` : ''}">${row.rank}</span>${avatar(row.name, true)}<span class="rk-name">${lvBadge(row.level)}${escapeHtml(row.name)}</span><span class="rk-stat">${row.wins}승 / ${row.games}판</span><b class="rk-xp">${row.xp.toLocaleString('ko-KR')} XP</b></li>`).join('') : '<li class="mp-empty">아직 랭킹에 오른 사람이 없어요. 첫 번째 주인공이 되어 보세요!</li>';
      card.innerHTML = `
        <h2 class="dialog-title">🏆 랭킹</h2>
        <p class="dialog-note">누적 경험치 순이에요.${state.auth.user ? (result.myRank ? ` 내 순위는 <b>${result.myRank}위</b>.` : ' 한 판 이상 플레이하면 순위에 올라요.') : ' 로그인한 플레이어만 순위에 올라요.'}</p>
        <ol class="rk-list">${rows}</ol>
        <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>닫기</button></div>`;
    }
    card.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', closeDialog));
  }

  function summaryMarkup(room, isHost, animate) {
    const summary = room.summary;
    if (!summary) return '';
    const me = state.session.playerId;
    const winner = summary.ranking.find(row => row.isWinner);
    const tiles = [
      ['총 단어', `${summary.totalWords}개`, ''],
      ['가장 긴 단어', summary.longestWord ? escapeHtml(summary.longestWord.word) : '—', summary.longestWord ? escapeHtml(summary.longestWord.playerName) : ''],
      ['가장 빠른 입력', summary.fastestWord ? `${(summary.fastestWord.elapsedMs / 1000).toFixed(1)}초` : '—', summary.fastestWord ? `${escapeHtml(summary.fastestWord.word)} · ${escapeHtml(summary.fastestWord.playerName)}` : ''],
      ['플레이 시간', summary.durationMs == null ? '—' : formatDuration(summary.durationMs), '']
    ].map(([label, value, note]) => `<div class="summary-stat"><small>${label}</small><strong>${value}</strong>${note ? `<span>${note}</span>` : ''}</div>`).join('');
    const levels = new Map(room.players.map(player => [player.id, player.level]));
    const rows = summary.ranking.map(row => {
      const status = row.isWinner ? '최종 우승' : row.eliminated ? '퇴장' : '참가';
      const detail = `${status} · ${row.roundWins}승 · 단어 ${row.wordCount}개${row.longestWord ? ` · 최장 ${escapeHtml(row.longestWord)}` : ''}`;
      return `<li class="summary-row ${row.isWinner ? 'winner' : ''}">
        <span class="summary-rank">${row.rank}</span>
        ${avatar(row.name, true)}
        <div class="summary-name">${lvBadge(levels.get(row.id))}${escapeHtml(row.name)}${row.id === me ? '<em class="summary-me">나</em>' : ''}${row.isWinner ? ' 🏆' : ''}<small>${detail}</small></div>
        <span class="summary-score">${row.score}<small>점</small></span>
      </li>`;
    }).join('');
    return `
      <div id="summary-backdrop" class="summary-backdrop ${animate ? 'enter' : ''}" role="dialog" aria-modal="true" aria-labelledby="summary-title">
        <div class="summary-card" tabindex="-1">
          <button id="summary-close" class="summary-close" type="button" aria-label="결과 요약 닫기">✕</button>
          <div class="summary-kicker">라운드 결과</div>
          <h2 id="summary-title" class="summary-title">${winner ? `${escapeHtml(winner.name)} 승리!` : '게임 종료'}</h2>
          <p class="summary-sub">${winner ? '가장 많은 라운드를 이긴 플레이어예요.' : '이번 판의 결과를 확인해 보세요.'}</p>
          <div class="summary-stats">${tiles}</div>
          ${rewardMarkup(state.rewards.get(room.gameId), animate)}
          <ol class="summary-ranking">${rows}</ol>
          <div class="summary-actions">
            <button id="summary-dismiss" class="ghost-button" type="button">닫기</button>
            ${isHost ? '<button id="summary-rematch" class="primary-button" type="button">다시 플레이 ↗</button>' : '<span class="summary-wait">방장이 다시 시작할 수 있어요</span>'}
          </div>
        </div>
      </div>`;
  }
  function closeSummary() {
    if (!state.room) return;
    const gameId = state.room.gameId;
    const node = $('#summary-backdrop');
    const finish = () => { state.summaryClosedGame = gameId; render(); };
    if (!node) { finish(); return; }
    if (node.classList.contains('leaving')) return;
    node.classList.add('leaving');
    setTimeout(finish, 230);
  }

  const socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 700, reconnectionDelayMax: 5000 });
  state.socket = socket;
  socket.on('connect', async () => {
    setConnection(true);
    if (state.restoring) return;
    const saved = state.session || readSession();
    if (saved) {
      state.restoring = true;
      state.session = saved;
      const result = await request('room:restore', { code: saved.code, playerId: saved.playerId });
      state.restoring = false;
      if (result.ok) {
        state.nickname = saved.name;
        state.room = result.room;
        saveSession(saved);
        render();
      } else if (readSession()) {
        clearSession();
        if (state.nickname) await enterLobby(state.nickname, { silent: true }); else render();
        showToast(`이전 게임방을 찾을 수 없어 ${state.nickname ? '로비' : '홈'}로 이동했어요.`, 'error');
      }
      return;
    }
    // 방 안이 아니라 로비에 있었다면, 서버가 재시작됐거나 연결이 끊겼다 돌아온 것이므로 다시 입장한다.
    if (state.nickname) await enterLobby(state.nickname, { silent: true });
  });
  socket.on('disconnect', () => setConnection(false));
  socket.on('connect_error', () => setConnection(false));
  socket.on('room:update', room => {
    if (state.session && room.code === state.session.code) {
      announceMissionChange(state.room, room);
      playRoomSounds(state.room, room);
      window.Bokgu?.room(state.room, room, state.session.playerId);
      setRoom(room);
    }
  });
  socket.on('lobby:rooms', rooms => { state.hub.rooms = rooms; updateRooms(); updateProfile(); });
  socket.on('lobby:users', payload => { state.hub.users = payload.list; state.hub.total = payload.total; updateUsers(); updateProfile(); });
  socket.on('lobby:chat', message => {
    state.hub.chat.push(message);
    if (state.hub.chat.length > 80) state.hub.chat.shift();
    appendChatLine(message);
  });
  socket.on('profile:reward', payload => {
    state.rewards.set(payload.gameId, payload);
    if (payload.leveledUp) { sound.play('win', 500); showToast(`레벨 업! Lv.${payload.after.level}`, 'success'); }
    loadProfile();
    if (state.room && state.room.state === 'finished') render(); // 결과 화면이 이미 떠 있으면 경험치를 바로 보여 준다.
  });
  socket.on('game:reaction', showReaction);
  socket.on('notice', payload => showToast(payload.message || '알 수 없는 오류가 발생했어요.', payload.type || 'info'));
  socket.on('server:hello', payload => {
    document.documentElement.dataset.dictionarySize = String(payload.dictionarySize || 0);
  });

  // ---------- 다이얼로그 ----------
  function openDialog(html) {
    closeDialog();
    const node = document.createElement('div');
    node.id = 'dialog';
    node.className = 'dialog-backdrop';
    node.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" tabindex="-1">${html}</div>`;
    document.body.append(node);
    document.body.classList.add('dialog-open');
    node.addEventListener('mousedown', event => { if (event.target === node) closeDialog(); });
    node.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', closeDialog));
    return node;
  }
  function closeDialog() {
    const node = $('#dialog');
    if (node) {
      node.removeAttribute('id');
      node.classList.add('closing');
      node.addEventListener('animationend', event => { if (event.target === node) node.remove(); });
      setTimeout(() => node.remove(), 450);
    }
    document.body.classList.remove('dialog-open');
    const callback = state.dialogClose;
    state.dialogClose = null;
    if (callback) callback();
  }
  // 비밀번호를 입력받는다. 취소하면 null.
  function askPassword(note = '') {
    return new Promise(resolve => {
      const node = openDialog(`
        <h2 class="dialog-title">🔒 비밀번호 입력</h2>
        <p class="dialog-note">${escapeHtml(note || '이 방은 비밀번호가 필요해요.')}</p>
        <form id="password-form" autocomplete="off">
          <input id="password-input" class="text-input" type="password" maxlength="8" autocomplete="off" placeholder="비밀번호">
          <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>취소</button><button type="submit" class="primary-button">입장</button></div>
        </form>`);
      state.dialogClose = () => resolve(null);
      const input = $('#password-input', node);
      input.focus();
      $('#password-form', node).addEventListener('submit', event => {
        event.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        state.dialogClose = null;
        closeDialog();
        resolve(value);
      });
    });
  }

  // ---------- 홈 (닉네임 입력) ----------
  function renderHome() {
    const sameScreen = enterScreen('home');
    document.body.classList.remove('modal-open');
    closeDialog();
    const rawCode = new URLSearchParams(location.search).get('room') || '';
    const inviteCode = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const { user, providers } = state.auth;
    const socialOk = !!(user && user.suggestedName);
    const mode = user && socialOk ? nickMode() : 'custom';
    app.innerHTML = `
      <section class="home-layout fade-in">
        <div class="hero-copy">
          <span class="eyebrow">WORD GAME · REALTIME</span>
          <h1 class="hero-title">단어를 잇고,<br><span class="accent">친구와 플레이.</span></h1>
          <p class="hero-description">로비에서 열려 있는 방을 골라 바로 들어가거나, 직접 방을 만들어 친구를 기다려 보세요. 제한 시간 안에 가장 기발한 단어를 이어 가면 됩니다.</p>
          <div class="feature-row">
            <span class="feature-chip"><b>⚡</b> 실시간 대전</span>
            <span class="feature-chip"><b>🚪</b> 자유 접속 방</span>
            <span class="feature-chip"><b>💬</b> 로비 채팅</span>
          </div>
        </div>
        <section class="home-card">
          <div class="card-kicker">LET'S PLAY TOGETHER</div>
          <h2 class="card-heading">로비 입장하기</h2>
          <p class="card-subtitle">${user ? '로그인한 계정으로 입장해요. 닉네임 방식을 골라 주세요.' : '닉네임만 정하면 가입 없이 바로 들어갈 수 있어요.'}</p>
          ${user ? `
          <div class="auth-chip"><span>✅ <b>${escapeHtml(user.providerLabel)}</b> 계정으로 로그인됨</span><button id="auth-logout" class="link-button" type="button">로그아웃</button></div>
          <div class="nick-mode" role="radiogroup" aria-label="닉네임 방식">
            <label class="nick-option${socialOk ? '' : ' disabled'}">
              <input type="radio" name="nick-mode" value="social" ${mode === 'social' ? 'checked' : ''} ${socialOk ? '' : 'disabled'}>
              <span><b>소셜 이름 그대로</b><small>${socialOk ? escapeHtml(user.suggestedName) : '쓸 수 있는 이름이 없어요 (한글·영문·숫자 2~12자)'}</small></span>
            </label>
            <label class="nick-option">
              <input type="radio" name="nick-mode" value="custom" ${mode === 'custom' ? 'checked' : ''}>
              <span><b>직접 정하기</b><small>원하는 닉네임을 입력해요</small></span>
            </label>
          </div>` : ''}
          <div id="nick-field"${mode === 'social' ? ' hidden' : ''}>
            <label class="field-label" for="display-name">플레이어 닉네임</label>
            <input id="display-name" class="text-input" type="text" maxlength="12" autocomplete="nickname" placeholder="닉네임을 입력하세요" value="${escapeHtml(localStorage.getItem('wordlink.nickname') || '')}">
          </div>
          <button id="enter-lobby" class="primary-button button-full" style="margin-top:18px">로비 입장 <span aria-hidden="true">↗</span></button>
          ${inviteCode ? `<div class="divider-label">초대받은 방이 있어요</div><button id="join-invite" class="secondary-button button-full">방 ${escapeHtml(inviteCode)} 으로 바로 입장</button>` : ''}
          ${!user && providers.length ? `
          <div class="divider-label">소셜 계정으로 시작</div>
          <div class="social-row">${providers.map(p => `<a class="social-button social-${escapeHtml(p.id)}" href="/auth/${encodeURIComponent(p.id)}?next=${encodeURIComponent(inviteCode ? `/?room=${inviteCode}` : '/')}"><i aria-hidden="true">${escapeHtml(p.label.slice(0, 1))}</i>${escapeHtml(p.label)}</a>`).join('')}</div>` : ''}
          <p class="home-footnote">${user ? '계정은 로그인 유지와 재접속 확인에만 쓰이고, 이메일 등 개인정보는 저장하지 않아요.' : '계정 가입 없이 게스트로 바로 플레이할 수 있어요.'}</p>
        </section>
      </section>`;
    const enter = async invite => {
      const name = readNickname();
      if (!name) return;
      const button = $('#enter-lobby');
      button.disabled = true;
      button.textContent = '입장 중…';
      const ok = await enterLobby(name);
      if (!ok) { renderHome(); return; }
      if (invite) { history.replaceState({}, '', location.pathname); await joinByCode(invite); }
    };
    $('#enter-lobby').addEventListener('click', () => enter(''));
    $('#display-name').addEventListener('keydown', event => { if (event.key === 'Enter') enter(''); });
    app.querySelectorAll('input[name="nick-mode"]').forEach(radio => radio.addEventListener('change', () => {
      try { localStorage.setItem(NICKMODE_KEY, radio.value); } catch { /* 저장 못 해도 이번 화면에서는 동작 */ }
      $('#nick-field').hidden = radio.value === 'social';
      if (radio.value === 'custom') $('#display-name').focus();
    }));
    if ($('#auth-logout')) $('#auth-logout').addEventListener('click', logout);
    if ($('#join-invite')) $('#join-invite').addEventListener('click', () => enter(inviteCode));
    settleScreen(sameScreen);
  }

  function nickMode() {
    try { return localStorage.getItem(NICKMODE_KEY) === 'custom' ? 'custom' : 'social'; } catch { return 'social'; }
  }
  async function logout() {
    try { await fetch('/auth/logout', { method: 'POST' }); } catch { /* 네트워크 오류여도 새로 고침하면 상태가 다시 확인된다 */ }
    location.reload(); // 소켓 인증은 연결 시점에 정해지므로 새로 연결해야 게스트로 돌아간다.
  }
  async function loadAuth() {
    try {
      const response = await fetch('/auth/me', { cache: 'no-store' });
      if (response.ok) {
        const data = await response.json();
        state.auth = { providers: Array.isArray(data.providers) ? data.providers : [], user: data.user || null };
      }
    } catch { /* 로그인 기능 없이 게스트로 진행 */ }
    const params = new URLSearchParams(location.search);
    const error = params.get('auth_error');
    if (error) {
      params.delete('auth_error');
      history.replaceState({}, '', location.pathname + (params.toString() ? `?${params}` : ''));
      showToast(error === 'denied' ? '로그인을 취소했어요.' : '로그인에 실패했어요. 잠시 후 다시 시도해 주세요.', 'error');
    }
  }

  function readNickname() {
    const user = state.auth.user;
    if (user && user.suggestedName && nickMode() === 'social') return user.suggestedName;
    const input = $('#display-name');
    const name = (input?.value || '').trim();
    if (!/^[\p{L}\p{N}_-]{2,12}$/u.test(name)) {
      showToast('닉네임은 한글·영문·숫자 2~12자로 입력해 주세요.', 'error');
      input?.focus();
      return '';
    }
    localStorage.setItem('wordlink.nickname', name);
    return name;
  }
  async function enterLobby(name, options = {}) {
    const result = await request('lobby:enter', { name, playerId: playerId() });
    if (!result.ok) {
      if (!options.silent || result.code === 'NAME_TAKEN') showToast(result.message, 'error');
      if (result.code !== 'IN_ROOM') state.nickname = null;
      if (options.silent) render();
      return false;
    }
    state.nickname = name;
    state.hub.rooms = result.rooms;
    state.hub.users = result.users.list;
    state.hub.total = result.users.total;
    state.hub.chat = result.chat;
    if (!state.room) mountHub();
    loadProfile();
    return true;
  }
  async function leaveLobby() {
    await request('lobby:leave');
    state.nickname = null;
    state.hub.chat = [];
    renderHome();
  }

  // ---------- 로비 화면 (접속자 · 방 목록 · 채팅) ----------
  function nameColor(name) { return `hsl(${(hashName(name) % 24) * 15},55%,30%)`; }
  function whereLabel(user) {
    if (user.where === 'waiting') return `대기실 ${user.roomNumber}번`;
    if (user.where === 'playing') return `게임중 ${user.roomNumber}번`;
    return '로비';
  }
  function mountHub() {
    enterScreen('hub');
    document.body.classList.remove('modal-open');
    closeDialog();
    if (!$('#hub')) {
      app.innerHTML = `
        <section id="hub" class="hub fade-in">
          <div class="hub-tabs">
            <button id="hub-create" class="hub-tab primary" type="button">＋ 방 만들기</button>
            <button id="hub-quick" class="hub-tab" type="button">⚡ 빠른 입장</button>
            <button id="hub-code" class="hub-tab" type="button">🔑 코드로 입장</button>
            <button id="hub-refresh" class="hub-tab" type="button">⟳ 새로고침</button>
            <button id="hub-mypage" class="hub-tab" type="button">👤 마이페이지</button>
            <button id="hub-ranking" class="hub-tab" type="button">🏆 랭킹</button>
            <span class="hub-tabs-spacer"></span>
            <span id="hub-summary" class="hub-summary"></span>
          </div>
          <div class="hub-grid">
            <section class="panel hub-users">
              <div class="panel-header"><span class="panel-title">접속자 목록</span><span id="hub-user-count" class="panel-caption"></span></div>
              <ul id="hub-user-list" class="hub-user-list"></ul>
            </section>
            <section class="panel hub-rooms">
              <div class="panel-header">
                <span class="panel-title">방 목록 <span id="hub-room-count" class="panel-caption"></span></span>
                <label class="hub-filter"><input id="hub-filter" type="checkbox"> 입장 가능한 방만</label>
              </div>
              <div id="hub-room-grid" class="hub-room-grid"></div>
            </section>
            <section class="panel hub-profile">
              <div class="panel-header"><span class="panel-title">내 정보</span></div>
              <div id="hub-profile-body" class="hub-profile-body"></div>
            </section>
            <section class="panel hub-chat">
              <div class="panel-header"><span class="panel-title">로비 채팅</span><span class="panel-caption">최근 대화 60개까지 보관돼요</span></div>
              <div id="hub-chat-log" class="hub-chat-log" role="log" aria-live="polite"></div>
              <form id="hub-chat-form" class="hub-chat-form" autocomplete="off">
                <input id="hub-chat-input" class="text-input" type="text" maxlength="${CHAT_MAX_LENGTH}" placeholder="메시지를 입력하고 Enter">
                <button class="primary-button" type="submit">전송</button>
              </form>
            </section>
          </div>
        </section>`;
      $('#hub-create').addEventListener('click', openCreateDialog);
      $('#hub-quick').addEventListener('click', quickJoin);
      $('#hub-code').addEventListener('click', openCodeDialog);
      $('#hub-refresh').addEventListener('click', refreshHub);
      $('#hub-mypage').addEventListener('click', openMyPage);
      $('#hub-ranking').addEventListener('click', openRanking);
      $('#hub-filter').addEventListener('change', event => { state.hub.onlyJoinable = event.target.checked; updateRooms(); });
      $('#hub-room-grid').addEventListener('click', event => {
        const card = event.target.closest('.room-card');
        if (!card) return;
        if (card.dataset.status === 'playing') return showToast('이미 게임이 진행 중인 방이에요.', 'error');
        if (card.dataset.status === 'full') return showToast('방 인원이 가득 찼어요.', 'error');
        joinByCode(card.dataset.code);
      });
      $('#hub-chat-form').addEventListener('submit', sendChat);
    }
    $('#hub-filter').checked = state.hub.onlyJoinable;
    updateUsers();
    updateRooms();
    updateProfile();
    renderChatLog();
  }
  function updateUsers() {
    const list = $('#hub-user-list');
    if (!list) return;
    $('#hub-user-count').textContent = `${state.hub.total}명`;
    if (!state.hub.users.length) { list.innerHTML = '<li class="hub-empty">접속자가 없어요.</li>'; return; }
    patchList(list, state.hub.users, user => user.name, user => `
      <li class="hub-user${user.name === state.nickname ? ' me' : ''}">
        ${avatar(user.name, true)}
        <span class="hub-user-name">${lvBadge(user.level)}${escapeHtml(user.name)}${user.name === state.nickname ? ' <em>(나)</em>' : ''}</span>
        <span class="hub-user-where ${user.where}">${whereLabel(user)}</span>
      </li>`, 'enter');
  }
  function roomCardHtml(room) {
    const status = room.state === 'playing' ? 'playing' : room.joinable ? 'waiting' : 'full';
    const label = { playing: '게임중', waiting: '대기중', full: '가득 참' }[status];
    return `
      <button type="button" class="room-card ${status}" data-code="${escapeHtml(room.code)}" data-status="${status}">
        <span class="room-num"><i class="room-dot ${status}"></i>${room.number}</span>
        <span class="room-title">${escapeHtml(room.title)}</span>
        <span class="room-lock${room.locked ? ' on' : ''}" title="${room.locked ? '비밀번호가 필요한 방' : '자유롭게 입장할 수 있는 방'}">${room.locked ? '🔒' : '🔓'}</span>
        <span class="room-rule">끝말잇기 · ${room.rounds}라운드 · ${room.totalSeconds}초 · 턴 ${room.turnSeconds}초${room.allowOneShot === false ? ' · 한방 금지' : ''}</span>
        <span class="room-meta"><span class="room-host">방장 ${escapeHtml(room.hostName || '-')}</span><span class="room-people">👥 ${room.players}/${room.maxPlayers}</span><span class="room-state ${status}">${label}</span></span>
      </button>`;
  }
  function updateRooms() {
    const grid = $('#hub-room-grid');
    if (!grid) return;
    const rooms = state.hub.onlyJoinable ? state.hub.rooms.filter(room => room.joinable) : state.hub.rooms;
    $('#hub-room-count').textContent = `${state.hub.rooms.length}개`;
    if (!rooms.length) {
      grid.innerHTML = `<div class="hub-empty">${state.hub.rooms.length ? '입장할 수 있는 방이 없어요.' : '아직 열린 방이 없어요.<br>첫 번째 방을 만들어 보세요!'}</div>`;
      return;
    }
    patchList(grid, rooms, room => room.code, roomCardHtml, 'enter');
  }
  function updateProfile() {
    const body = $('#hub-profile-body');
    if (!body) return;
    const summary = $('#hub-summary');
    if (summary) summary.textContent = `방 ${state.hub.rooms.length}개 · 접속자 ${state.hub.total}명`;
    const p = state.profile;
    const known = p && !p.guest;
    const level = known ? `
      <div class="xp-box">
        <div class="xp-top">${lvBadge(p.level)}<b>${escapeHtml(p.title)}</b><span>${p.max ? 'MAX' : `${p.xpInto.toLocaleString('ko-KR')} / ${p.xpNeed.toLocaleString('ko-KR')} XP`}</span></div>
        ${xpBar(p.pct)}
      </div>` : p && p.guest ? '<p class="hub-guest-note">게스트로 접속 중이에요. 로그인하면 점수와 레벨이 저장돼요.</p>' : '';
    const html = `
      <div class="hub-profile-main">${avatar(state.nickname)}<div><strong>${escapeHtml(state.nickname)}</strong><small>${known ? `${p.games}전 ${p.wins}승` : '로비에서 대기 중'}</small></div></div>
      ${level}
      <button id="hub-profile-open" class="secondary-button button-full" type="button">${known ? '마이페이지' : '내 기록'}</button>
      <button id="hub-rename" class="ghost-button button-full" type="button">닉네임 변경</button>`;
    if (body.dataset.sig === html) return;
    body.dataset.sig = html;
    body.innerHTML = html;
    $('#hub-profile-open').addEventListener('click', openMyPage);
    $('#hub-rename').addEventListener('click', leaveLobby);
  }
  function chatLineHtml(message) {
    const time = new Date(message.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `<div class="chat-line${message.name === state.nickname ? ' mine' : ''}"><span class="chat-name" style="color:${nameColor(message.name)}">${escapeHtml(message.name)}</span><span class="chat-text">${escapeHtml(message.text)}</span><time class="chat-time">${time}</time></div>`;
  }
  function renderChatLog() {
    const log = $('#hub-chat-log');
    if (!log) return;
    log.innerHTML = state.hub.chat.length ? state.hub.chat.map(chatLineHtml).join('') : '<div class="chat-empty">아직 대화가 없어요. 첫 인사를 건네 보세요!</div>';
    log.scrollTo({ top: log.scrollHeight, behavior: 'instant' });
  }
  function appendChatLine(message) {
    const log = $('#hub-chat-log');
    if (!log) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    $('.chat-empty', log)?.remove();
    log.insertAdjacentHTML('beforeend', chatLineHtml(message));
    log.lastElementChild.classList.add('enter');
    while (log.children.length > 80) log.firstChild.remove();
    if (nearBottom || message.name === state.nickname) log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
  }
  async function sendChat(event) {
    event.preventDefault();
    const input = $('#hub-chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const result = await request('lobby:chat', { text });
    if (!result.ok) {
      input.value = text; // 너무 빨리 보냈거나 실패하면 쓰던 글을 돌려준다.
      if (!result.throttled) showToast(result.message, 'error');
    }
  }
  async function refreshHub() {
    const result = await request('lobby:refresh');
    if (!result.ok) return showToast(result.message, 'error');
    state.hub.rooms = result.rooms;
    state.hub.users = result.users.list;
    state.hub.total = result.users.total;
    updateRooms(); updateUsers(); updateProfile();
  }

  // ---------- 방 입장 · 만들기 ----------
  function enterRoom(result) {
    saveSession({ code: result.room.code, playerId: result.playerId, name: state.nickname });
    state.room = result.room;
    history.replaceState({}, '', location.pathname);
    render();
    showToast(`${result.room.number}번 방에 입장했어요.`, 'success');
  }
  async function joinByCode(code, password = '') {
    const result = await request('room:join', { code, name: state.nickname, playerId: playerId(), password });
    if (result.ok) return enterRoom(result);
    if (result.code === 'PASSWORD_REQUIRED' || result.code === 'PASSWORD_WRONG') {
      const typed = await askPassword(result.code === 'PASSWORD_WRONG' ? result.message : '');
      if (typed) return joinByCode(code, typed);
      return;
    }
    showToast(result.message, 'error');
  }
  async function quickJoin() {
    const result = await request('room:quick', { name: state.nickname, playerId: playerId() });
    if (result.ok) enterRoom(result); else showToast(result.message, 'error');
  }
  function openCodeDialog() {
    const node = openDialog(`
      <h2 class="dialog-title">코드로 입장</h2>
      <p class="dialog-note">친구가 알려 준 방 코드 5자리를 입력하세요.</p>
      <form id="code-form" autocomplete="off">
        <input id="code-input" class="text-input code-input" type="text" maxlength="5" placeholder="방 코드 5자리">
        <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>취소</button><button type="submit" class="primary-button">입장</button></div>
      </form>`);
    const input = $('#code-input', node);
    input.focus();
    input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
    $('#code-form', node).addEventListener('submit', event => {
      event.preventDefault();
      if (!/^[A-Z0-9]{5}$/.test(input.value)) return showToast('방 코드를 영문·숫자 5자리로 입력해 주세요.', 'error');
      const code = input.value;
      closeDialog();
      joinByCode(code);
    });
  }
  function openCreateDialog() {
    const options = (values, selected, unit) => values.map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}${unit}</option>`).join('');
    const node = openDialog(`
      <h2 class="dialog-title">방 만들기</h2>
      <p class="dialog-note">만든 방은 로비 목록에 바로 올라가고, 누구나 클릭해서 들어올 수 있어요.</p>
      <form id="create-form" autocomplete="off">
        <label class="field-label" for="create-title">방 제목</label>
        <input id="create-title" class="text-input" type="text" maxlength="24" value="${escapeHtml(state.nickname)}님의 방">
        <label class="field-label" for="create-password">비밀번호 <small class="field-hint">(선택 · 영문·숫자 1~8자, 비우면 자유 입장)</small></label>
        <input id="create-password" class="text-input" type="text" maxlength="8" autocomplete="off" placeholder="비밀번호 없음">
        <div class="dialog-grid">
          <div><label class="field-label" for="create-max">최대 인원</label><select id="create-max" class="select-input">${options([2, 3, 4, 5, 6, 7, 8], 8, '명')}</select></div>
          <div><label class="field-label" for="create-rounds">라운드 수</label><select id="create-rounds" class="select-input">${options(ROUND_OPTIONS, 3, '라운드')}</select></div>
          <div><label class="field-label" for="create-total">라운드 총 시간</label><select id="create-total" class="select-input">${options(TOTAL_TIME_OPTIONS, 60, '초')}</select></div>
          <div><label class="field-label" for="create-turn">턴 제한 시간</label><select id="create-turn" class="select-input">${options([10, 15, 20, 30], 15, '초')}</select></div>
          <div><label class="field-label" for="create-oneshot">한방 단어 <small class="field-hint">(이어 갈 단어가 없는 단어)</small></label><select id="create-oneshot" class="select-input"><option value="true" selected>허용</option><option value="false">금지</option></select></div>
        </div>
        <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>취소</button><button id="create-submit" type="submit" class="primary-button">방 만들기 <span aria-hidden="true">↗</span></button></div>
      </form>`);
    $('#create-title', node).select();
    $('#create-form', node).addEventListener('submit', async event => {
      event.preventDefault();
      const submit = $('#create-submit', node);
      submit.disabled = true;
      const result = await request('room:create', {
        name: state.nickname, playerId: playerId(),
        title: $('#create-title', node).value,
        password: $('#create-password', node).value,
        maxPlayers: Number($('#create-max', node).value),
        rounds: Number($('#create-rounds', node).value),
        totalSeconds: Number($('#create-total', node).value),
        turnSeconds: Number($('#create-turn', node).value),
        allowOneShot: $('#create-oneshot', node).value === 'true'
      });
      if (!result.ok) { showToast(result.message, 'error'); submit.disabled = false; return; }
      closeDialog();
      enterRoom(result);
    });
  }

  function renderLobby(room) {
    const sameScreen = enterScreen('lobby');
    document.body.classList.remove('modal-open');
    const mine = room.players.find(player => player.id === state.session.playerId);
    const isHost = room.hostId === state.session.playerId;
    const allReady = room.players.length >= 2 && room.players.every(player => player.online && player.ready);
    const playerRows = room.players.map(player => `
      <div class="player-row">
        ${avatar(player.name)}
        <div class="player-info">
          <div class="player-name">${lvBadge(player.level)}${escapeHtml(player.name)} ${player.isHost ? '<span class="host-label">방장</span>' : ''}</div>
          <div class="player-meta">${player.online ? '온라인 · 참가 중' : '연결 끊김'}</div>
        </div>
        <span class="player-status ${player.ready ? 'ready' : player.online ? '' : 'offline'}">${player.ready ? '준비 완료' : player.online ? '대기 중' : '오프라인'}</span>
      </div>`).join('');
    const emptySlots = Math.max(0, Math.min(room.settings.maxPlayers - room.players.length, 3));
    const settingsContent = isHost ? `
      <div class="setting-block">
        <label class="field-label" for="setting-title">방 제목</label>
        <input id="setting-title" class="text-input" type="text" maxlength="24" value="${escapeHtml(room.title)}">
      </div>
      <div class="setting-block">
        <label class="field-label" for="setting-password">비밀번호 <small class="field-hint">${room.locked ? '(설정됨 · 비우면 유지)' : '(선택)'}</small></label>
        <input id="setting-password" class="text-input" type="text" maxlength="8" autocomplete="off" placeholder="${room.locked ? '새 비밀번호' : '영문·숫자 1~8자'}">
        ${room.locked ? '<label class="check-line"><input id="setting-clear-pw" type="checkbox"> 비밀번호 해제</label>' : ''}
      </div>
      <div class="setting-block">
        <label class="field-label" for="setting-time">턴 제한 시간 <small class="field-hint">(라운드가 갈수록 줄어요)</small></label>
        <select id="setting-time" class="select-input"><option value="10" ${room.settings.turnSeconds === 10 ? 'selected' : ''}>10초</option><option value="15" ${room.settings.turnSeconds === 15 ? 'selected' : ''}>15초</option><option value="20" ${room.settings.turnSeconds === 20 ? 'selected' : ''}>20초</option><option value="30" ${room.settings.turnSeconds === 30 ? 'selected' : ''}>30초</option></select>
      </div>
      <div class="setting-block">
        <label class="field-label" for="setting-total">라운드 총 시간</label>
        <select id="setting-total" class="select-input">${TOTAL_TIME_OPTIONS.map(sec => `<option value="${sec}" ${room.settings.totalSeconds === sec ? 'selected' : ''}>${sec}초</option>`).join('')}</select>
      </div>
      <div class="setting-block">
        <label class="field-label" for="setting-rounds">라운드 수</label>
        <select id="setting-rounds" class="select-input">${ROUND_OPTIONS.map(num => `<option value="${num}" ${room.settings.rounds === num ? 'selected' : ''}>${num}라운드</option>`).join('')}</select>
      </div>
      <div class="setting-block">
        <label class="field-label" for="setting-oneshot">한방 단어 <small class="field-hint">(이어 갈 단어가 없는 단어)</small></label>
        <select id="setting-oneshot" class="select-input"><option value="true" ${room.settings.allowOneShot !== false ? 'selected' : ''}>허용</option><option value="false" ${room.settings.allowOneShot === false ? 'selected' : ''}>금지</option></select>
      </div>
      <div class="setting-block">
        <label class="field-label" for="setting-players">최대 인원</label>
        <select id="setting-players" class="select-input">${[2,3,4,5,6,7,8].map(num => `<option value="${num}" ${room.settings.maxPlayers === num ? 'selected' : ''} ${num < room.players.length ? 'disabled' : ''}>${num}명</option>`).join('')}</select>
        <p class="setting-note">인원은 2~8명까지 설정할 수 있어요.</p>
      </div>
      <button id="apply-settings" class="ghost-button button-full">설정 적용</button>` : `
      <div class="setting-block"><label class="field-label">방 제목</label><div class="read-only-setting">${escapeHtml(room.title)}${room.locked ? ' 🔒' : ''}</div></div>
      <div class="setting-block"><label class="field-label">턴 제한 시간</label><div class="read-only-setting">${room.settings.turnSeconds}초</div></div>
      <div class="setting-block"><label class="field-label">라운드 총 시간</label><div class="read-only-setting">${room.settings.totalSeconds}초</div></div>
      <div class="setting-block"><label class="field-label">라운드 수</label><div class="read-only-setting">${room.settings.rounds}라운드</div></div>
      <div class="setting-block"><label class="field-label">한방 단어</label><div class="read-only-setting">${room.settings.allowOneShot === false ? '금지' : '허용'}</div></div>
      <div class="setting-block"><label class="field-label">최대 인원</label><div class="read-only-setting">${room.settings.maxPlayers}명</div></div>
      <p class="setting-note">대기실 설정은 방장만 변경할 수 있어요.</p>`;

    app.innerHTML = `
      <section class="fade-in lobby-screen">
        <div class="page-heading-row">
          <div><span class="eyebrow">WAITING ROOM</span><h1 class="page-title">${escapeHtml(room.title)}</h1><p class="page-description">${room.number}번 방${room.locked ? ' · 🔒 비밀번호 방' : ''} · 모든 플레이어가 준비되면 방장이 게임을 시작할 수 있어요.</p></div>
          <div class="room-code-pill"><small>방 코드</small><strong>${escapeHtml(room.code)}</strong></div>
        </div>
        <div class="lobby-grid">
          <section class="panel">
            <div class="panel-header"><span class="panel-title">참가 플레이어</span><span class="panel-caption">${room.players.length} / ${room.settings.maxPlayers}명</span></div>
            <div class="player-list">${playerRows}${Array.from({ length: emptySlots }, () => `<div class="empty-slot"><span class="avatar">＋</span><span>친구를 기다리는 자리</span></div>`).join('')}</div>
          </section>
          <section class="panel settings-panel">
            <div class="panel-header"><span class="panel-title">게임 설정</span><span class="panel-caption">${isHost ? '방장 설정' : '보기 전용'}</span></div>
            <div class="settings-content">${settingsContent}</div>
          </section>
        </div>
        <div class="invite-strip"><p><b>친구를 초대해 보세요</b>방 코드 ${escapeHtml(room.code)} 또는 초대 링크를 공유하면 바로 참가할 수 있어요.</p><button id="copy-invite" class="secondary-button">초대 링크 복사 ↗</button></div>
        <div class="lobby-actions">
          <button id="leave-room" class="ghost-button danger-button">방 나가기</button>
          <button id="ready-toggle" class="secondary-button">${mine?.ready ? '준비 취소' : '준비 완료'}</button>
          ${isHost ? `<button id="start-game" class="primary-button" ${allReady ? '' : 'disabled'}>게임 시작하기 ↗</button>` : '<button class="primary-button" disabled>방장 시작 대기 중</button>'}
        </div>
      </section>`;

    $('#ready-toggle').addEventListener('click', async () => {
      const result = await request('room:ready', { code: room.code, playerId: state.session.playerId, ready: !mine?.ready });
      if (!result.ok) showToast(result.message, 'error');
    });
    $('#leave-room').addEventListener('click', leaveRoom);
    $('#copy-invite').addEventListener('click', copyInvite);
    if ($('#apply-settings')) $('#apply-settings').addEventListener('click', applySettings);
    if ($('#start-game')) $('#start-game').addEventListener('click', startGame);
    settleScreen(sameScreen);
  }
  async function applySettings() {
    const result = await request('room:settings', {
      code: state.room.code, playerId: state.session.playerId,
      turnSeconds: Number($('#setting-time').value), maxPlayers: Number($('#setting-players').value),
      totalSeconds: Number($('#setting-total').value), rounds: Number($('#setting-rounds').value),
      allowOneShot: $('#setting-oneshot').value === 'true',
      title: $('#setting-title').value, password: $('#setting-password').value, clearPassword: Boolean($('#setting-clear-pw')?.checked)
    });
    showToast(result.ok ? '게임 설정을 적용했어요.' : result.message, result.ok ? 'success' : 'error');
  }
  async function startGame() {
    const result = await request('room:start', { code: state.room.code, playerId: state.session.playerId });
    if (!result.ok) showToast(result.message, 'error');
  }
  async function copyInvite() {
    const url = `${location.origin}${location.pathname}?room=${state.room.code}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('초대 링크를 복사했어요.', 'success');
    } catch {
      try { await navigator.clipboard.writeText(state.room.code); showToast(`방 코드 ${state.room.code}를 복사했어요.`, 'success'); }
      catch { showToast(`친구에게 방 코드 ${state.room.code}를 알려 주세요.`); }
    }
  }
  async function leaveRoom() {
    const session = state.session;
    if (session) await request('room:leave', { code: session.code, playerId: session.playerId });
    clearSession();
    history.replaceState({}, '', location.pathname);
    // 방을 나가면 로비로 돌아간다.
    if (state.nickname) { if (!(await enterLobby(state.nickname))) renderHome(); } else renderHome();
  }

  function renderGame(room) {
    const sameScreen = enterScreen('game');
    const prev = sameScreen && state.shown && state.shown.gameId === room.gameId ? state.shown : null;
    const keepScroll = {
      history: $('#history-list') ? $('#history-list').scrollTop : 0,
      scores: $('.score-list') ? $('.score-list').scrollLeft : 0
    };
    const mine = room.players.find(player => player.id === state.session.playerId);
    const isHost = room.hostId === state.session.playerId;
    const isPlaying = room.state === 'playing';
    const onBreak = room.state === 'intermission';
    const myTurn = isPlaying && room.currentPlayerId === state.session.playerId && !mine?.eliminated;
    const alive = room.players.filter(player => !player.eliminated).length;
    const wordCount = room.words.filter(item => item.type === 'word').length;
    const sortedPlayers = [...room.players].sort((a, b) => Number(a.eliminated) - Number(b.eliminated) || b.score - a.score);
    const scoreRows = sortedPlayers.map(player => {
      const current = player.id === room.currentPlayerId;
      const status = player.eliminated ? '탈락' : !player.online ? '연결 끊김' : current ? '현재 차례' : '플레이 중';
      const arrive = current && prev && prev.currentPlayerId !== room.currentPlayerId;
      const bump = prev && prev.scores[player.id] != null && player.score > prev.scores[player.id];
      return `<div class="score-row ${current ? 'current' : ''}${arrive ? ' arrive' : ''} ${player.eliminated ? 'eliminated' : ''}">
        ${avatar(player.name, true)}
        <div class="score-name">${lvBadge(player.level)}${escapeHtml(player.name)}<span class="score-state">${status}${room.totalRounds > 1 ? ` · ${player.roundWins}승` : ''}</span></div>
        <span class="score-points${bump ? ' bump' : ''}">${player.score}</span>
      </div>`;
    }).join('');
    const addedEntries = prev ? Math.max(0, room.words.length - prev.entryCount) : 0;
    const history = room.words.slice().reverse().map((item, reverseIndex) => {
      const enter = reverseIndex < addedEntries ? ' enter' : '';
      if (item.type === 'system') return `<div class="history-system${enter}">${escapeHtml(item.text)}</div>`;
      return `<div class="history-item${enter}"><span class="history-index">${String(room.words.filter(entry => entry.type === 'word').indexOf(item) + 1).padStart(2, '0')}</span>${avatar(item.playerName, true)}<span class="history-word">${escapeHtml(item.word)}</span><span class="history-player">${escapeHtml(item.playerName)}</span><span class="history-points">${item.missions ? `<em class="history-bonus">🎯×${item.missions}</em> ` : ''}+${item.points}</span></div>`;
    }).join('');
    const finished = room.state === 'finished';
    const winnerContent = finished ? `<div class="finished-banner"><div class="trophy">🏆</div><h2>${room.winnerName ? `${escapeHtml(room.winnerName)} 승리!` : '게임 종료'}</h2></div>` : '';
    const breakContent = onBreak && room.roundResult ? (() => {
      const result = room.roundResult;
      const board = result.scores.map(row => `${escapeHtml(row.name)} ${row.roundScore}점`).join(' · ');
      return `<div class="finished-banner round-banner"><div class="trophy">${result.winnerId ? '🏁' : '🤝'}</div><h2>ROUND ${result.round} ${result.winnerId ? `— ${escapeHtml(result.winnerName)} 승리!` : '— 무승부'}</h2><p>${board}</p><p class="break-count-line"><span id="break-count">–</span>초 뒤 ROUND ${room.round + 1}/${room.totalRounds} 시작</p></div>`;
    })() : '';
    const turnName = onBreak ? '다음 라운드를 준비해요' : isPlaying ? (myTurn ? '내 차례예요!' : `${escapeHtml(room.currentPlayerName)}님의 차례`) : '게임이 종료되었어요';
    const allowed = (room.allowedSyllables && room.allowedSyllables.length) ? room.allowedSyllables : (room.lastSyllable ? [room.lastSyllable] : []);
    const allowedLabel = allowed.map(item => `‘${escapeHtml(item)}’`).join(' 또는 ');
    const allowedChip = allowed.map(item => escapeHtml(item)).join(' / ');
    const allowedPlaceholder = allowed.join(' · ');
    const turnHint = onBreak ? '' : myTurn ? (room.lastSyllable ? `${allowedLabel}(으)로 시작` : '첫 단어를 입력하세요') : '';
    const chain = room.words.filter(item => item.type === 'word').slice(-1)[0];
    const newWord = Boolean(prev) && wordCount > prev.wordCount;
    const turnChanged = Boolean(prev) && prev.currentPlayerId !== room.currentPlayerId;
    const allowedKey = allowed.join('|');
    const letterChanged = Boolean(prev) && prev.allowedKey !== allowedKey;
    const showSummary = finished && Boolean(room.summary) && state.summaryClosedGame !== room.gameId;
    const firstShow = showSummary && state.summaryShownGame !== room.gameId;
    if (showSummary) state.summaryShownGame = room.gameId;
    const summaryHtml = showSummary ? summaryMarkup(room, isHost, firstShow) : '';
    const turnKey = `${room.gameId}:${room.round}:${room.currentPlayerId}:${room.turnEndsAt}`;
    const entryMode = finished ? 'done' : onBreak ? 'break' : myTurn ? 'mine' : mine?.eliminated ? 'out' : 'wait';
    const startChips = allowed.length
      ? allowed.map(item => `<button type="button" class="entry-chip" data-letter="${escapeHtml(item)}" ${myTurn ? '' : 'disabled'} aria-label="${escapeHtml(item)} 입력하기">${escapeHtml(item)}</button>`).join('<span class="entry-or">또는</span>')
      : '<span class="entry-chip free">아무 글자</span>';
    const entryTitle = {
      mine: allowed.length ? '이 글자로 시작하는 단어를 입력하세요' : '첫 단어를 자유롭게 입력하세요',
      wait: `${escapeHtml(room.currentPlayerName || '다른 사람')}님이 입력하는 중이에요`,
      out: '이번 라운드에서 탈락했어요 · 다음 라운드를 기다려 주세요',
      break: '잠시 쉬는 시간이에요',
      done: '게임이 끝났어요'
    }[entryMode];
    const entryPlaceholder = entryMode === 'mine' ? (allowed.length ? `${allowed[0]}로 시작하는 단어 (2~12글자)` : '첫 단어 (2~12글자)') : entryMode === 'wait' ? '내 차례를 기다리는 중…' : '입력할 수 없어요';
    const entryMarkup = `<section class="entry-card is-${entryMode}" id="entry-card" aria-label="단어 입력">
          <div class="entry-top">
            <div class="entry-start" aria-hidden="${entryMode === 'mine' ? 'false' : 'true'}">${entryMode === 'mine' || entryMode === 'wait' ? startChips : ''}</div>
            <div class="entry-title">${entryTitle}</div>
          </div>
          <form id="word-form" class="entry-form" autocomplete="off" novalidate>
            <div class="entry-field">
              <input id="word-input" class="text-input" type="text" inputmode="text" lang="ko" maxlength="12" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="send" aria-label="단어 입력" aria-describedby="entry-hint" placeholder="${escapeHtml(entryPlaceholder)}" ${myTurn ? '' : 'disabled'}>
              <span id="entry-count" class="entry-count" aria-hidden="true">0/12</span>
            </div>
            <button class="primary-button entry-send" type="submit" ${myTurn ? '' : 'disabled'}><span>보내기</span><kbd aria-hidden="true">↵</kbd></button>
          </form>
          <div id="entry-hint" class="entry-hint" role="status" aria-live="polite">${myTurn ? `<span class="hint-neutral">${room.mission ? `🎯 미션 글자 ‘${escapeHtml(room.mission)}’가 들어가면 보너스 점수!` : '한글 2~12글자 · Enter로 보내기'}</span>` : ''}</div>
        </section>`;
    const reactionBar = `<section class="reaction-bar" aria-label="이모지 반응"><span class="reaction-label">반응</span><div class="reaction-buttons">${REACTIONS.map(emoji => `<button type="button" class="reaction-button" data-emoji="${emoji}" aria-label="${emoji} 반응 보내기">${emoji}</button>`).join('')}</div></section>`;
    app.innerHTML = `
      <section class="fade-in game-screen">
        <div class="game-topline">
          <div class="game-top-actions">
            <button id="leave-room" class="ghost-button danger-button">방 나가기</button>
            <button id="copy-invite" class="ghost-button">초대 링크 복사</button>
            ${finished && room.summary ? '<button id="open-summary" class="secondary-button">결과 요약 보기</button>' : ''}
            ${finished && isHost ? '<button id="rematch" class="primary-button">다시 플레이 ↗</button>' : finished ? '<button class="secondary-button" disabled>방장이 다시 시작할 수 있어요</button>' : ''}
          </div>
          <div class="game-top-info"><span class="game-round">${room.round}/${room.totalRounds} 라운드${isPlaying ? ' · <span id="round-clock">–</span>' : ''}</span><span class="game-code">방 ${escapeHtml(room.code)} <span class="footer-dot">·</span> ${alive}명 생존</span></div>
        </div>
        <div class="game-body">
        <div class="game-left">
        ${winnerContent}${breakContent}
        <section class="turn-card stage">
          <div class="stage-side stage-next">
            <span class="stage-side-label">다음 글자</span>
            <strong class="stage-letter${letterChanged ? ' swap' : ''}">${allowedChip || '?'}</strong>
          </div>
          <div class="stage-side stage-mission${state.missionFlashSeq && room.missionChange && room.missionChange.seq === state.missionFlashSeq ? ' mission-new' : ''}">
            <span class="stage-side-label">미션</span>
            <strong class="stage-letter">${room.mission ? escapeHtml(room.mission) : '?'}</strong>
          </div>
          <div class="stage-center">
            <div class="turn-label">${finished ? '경기 종료' : onBreak ? '라운드 휴식' : '현재 차례'}</div>
            <div class="turn-name${turnChanged ? ' swap' : ''}">${turnName}</div>
            ${finished || !turnHint ? '' : `<div class="turn-hint">${turnHint}</div>`}
            <div class="chain-current">${chain ? `<span class="chain-word${newWord ? ' pop' : ''}">${escapeHtml(chain.word)}</span>` : '<span class="chain-word empty">첫 단어를 기다리고 있어요</span>'}</div>
            <div class="timer-track"><div id="timer-fill" class="timer-fill"></div></div>
          </div>
          <div class="stage-side stage-chain">
            <span class="stage-side-label">체인</span>
            <strong class="stage-letter">${wordCount}</strong>
            <div class="turn-clock"><span class="clock-icon">◷</span><span id="clock-number" class="clock-number">${isPlaying ? room.turnSeconds : '—'}</span></div>
          </div>
        </section>
        ${entryMarkup}
        <div class="players-row">
          <section class="panel score-panel"><div class="panel-header"><span class="panel-title">플레이어 순위</span><span class="panel-caption">점수</span></div><div class="score-list">${scoreRows}</div></section>
        </div>
        ${reactionBar}
        </div>
        <section class="panel history-panel chat-panel">
          <div class="panel-header"><span class="panel-title">단어 기록</span><span class="panel-caption">${wordCount}개</span></div>
          <div id="history-list" class="history-list">${history || '<div class="history-empty">아직 입력된 단어가 없어요.<br>첫 번째 단어의 주인공이 되어 보세요!</div>'}</div>
        </section>
        </div>
      </section>${summaryHtml}`;
    document.body.classList.toggle('modal-open', showSummary);
    $('#word-form').addEventListener('submit', submitWord);
    $('#leave-room').addEventListener('click', leaveRoom);
    $('#copy-invite').addEventListener('click', copyInvite);
    if ($('#rematch')) $('#rematch').addEventListener('click', rematch);
    app.querySelectorAll('.reaction-button').forEach(button => button.addEventListener('click', () => sendReaction(button.dataset.emoji)));
    if ($('#open-summary')) $('#open-summary').addEventListener('click', () => { state.summaryClosedGame = null; state.summaryShownGame = null; render(); });
    if (showSummary) {
      $('#summary-close').addEventListener('click', closeSummary);
      $('#summary-dismiss').addEventListener('click', closeSummary);
      $('#summary-backdrop').addEventListener('click', event => { if (event.target.id === 'summary-backdrop') closeSummary(); });
      if ($('#summary-rematch')) $('#summary-rematch').addEventListener('click', rematch);
      if (firstShow) $('.summary-card')?.focus({ preventScroll: true });
    }
    setupEntry(room, { myTurn, allowed, turnKey });
    updateClock();
    settleScreen(sameScreen);
    // 화면을 다시 그려도 스크롤 위치를 지킨다. 새 단어가 들어왔을 때만 맨 위로 부드럽게 올린다.
    const historyNode = $('#history-list');
    if (historyNode) {
      if (newWord || addedEntries) {
        historyNode.scrollTo({ top: Math.min(keepScroll.history, historyNode.scrollHeight), behavior: 'instant' });
        historyNode.scrollTo({ top: 0, behavior: 'smooth' });
      } else historyNode.scrollTo({ top: keepScroll.history, behavior: 'instant' });
    }
    const scoreNode = $('.score-list');
    if (scoreNode && keepScroll.scores) scoreNode.scrollLeft = keepScroll.scores;
    state.shown = {
      gameId: room.gameId, wordCount, entryCount: room.words.length, allowedKey,
      currentPlayerId: room.currentPlayerId,
      scores: Object.fromEntries(room.players.map(player => [player.id, player.score]))
    };
  }
  // ---------- 단어 입력 ----------
  // 입력하는 동안 규칙을 바로 알려 준다. (최종 판정은 항상 서버가 한다)
  function checkDraft(word, room) {
    const text = word.normalize('NFC').replace(/\s+/gu, '');
    if (!text) return { level: 'neutral', text: '' };
    if (/[^가-힣]/u.test(text)) return { level: 'warn', code: 'FORMAT', text: '한글만 입력할 수 있어요 (자음·모음만 있는 글자는 안 돼요)' };
    const allowed = (room.allowedSyllables && room.allowedSyllables.length) ? room.allowedSyllables : (room.lastSyllable ? [room.lastSyllable] : []);
    if (allowed.length && !allowed.includes(text[0])) {
      return { level: 'warn', code: 'START', text: `첫 글자는 ${allowed.map(item => `‘${item}’`).join(' 또는 ')}(이)어야 해요` };
    }
    if (text.length < 2) return { level: 'neutral', text: '2글자 이상 입력해 주세요' };
    if (room.words.some(item => item.type === 'word' && item.word === text)) return { level: 'warn', code: 'DUPLICATE', text: '이미 사용한 단어예요' };
    const hits = room.mission ? [...text].filter(ch => ch === room.mission).length : 0;
    return { level: 'ok', text: hits ? `🎯 미션 글자 ×${hits} · 보너스 점수! Enter로 보내기` : 'Enter로 보내기' };
  }
  function setEntryHint(level, text) {
    const hint = $('#entry-hint');
    const card = $('#entry-card');
    if (hint) hint.innerHTML = text ? `<span class="hint-${level}">${level === 'ok' ? '✓ ' : level === 'warn' || level === 'error' ? '⚠ ' : ''}${escapeHtml(text)}</span>` : '';
    if (card) { card.classList.toggle('has-warn', level === 'warn' || level === 'error'); card.classList.toggle('has-ok', level === 'ok'); }
  }
  function setupEntry(room, { myTurn, allowed, turnKey }) {
    const input = $('#word-input');
    const form = $('#word-form');
    if (!input || !form) return;
    form.addEventListener('submit', submitWord);
    const count = $('#entry-count');
    let composing = false;
    const refresh = () => {
      if (count) count.textContent = `${[...input.value].length}/12`;
      form.classList.toggle('has-text', Boolean(input.value));
      if (!myTurn) return;
      if (composing) { setEntryHint('neutral', ''); return; } // 글자를 조합하는 중에는 안내를 잠시 멈춘다.
      const result = checkDraft(input.value, state.room || room);
      if (result.text) setEntryHint(result.level, result.text);
      else setEntryHint('neutral', '');
      if (!result.text && !input.value) {
        const hint = $('#entry-hint');
        if (hint) hint.innerHTML = `<span class="hint-neutral">${room.mission ? `🎯 미션 글자 ‘${escapeHtml(room.mission)}’가 들어가면 보너스 점수!` : '한글 2~12글자 · Enter로 보내기'}</span>`;
      }
    };
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; state.draft = { key: turnKey, value: input.value }; refresh(); });
    input.addEventListener('input', () => {
      state.draft = { key: turnKey, value: input.value };
      input.classList.remove('shake');
      refresh();
    });
    $('#entry-card')?.querySelectorAll('.entry-chip[data-letter]').forEach(chip => chip.addEventListener('click', () => {
      if (!myTurn) return;
      const letter = chip.dataset.letter;
      // 비어 있거나 다른 글자로 시작하면 그 글자로 맞춰 주고, 이미 맞게 시작했다면 그대로 둔다.
      if (!input.value || !allowed.includes(input.value[0])) input.value = letter + (input.value ? input.value.slice(1) : '');
      state.draft = { key: turnKey, value: input.value };
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      refresh();
    }));
    // 다른 사람의 반응·점수 갱신으로 화면이 다시 그려져도 쓰던 글자를 그대로 복원한다.
    if (myTurn && state.draft.key === turnKey && state.draft.value) input.value = state.draft.value;
    else if (state.draft.key !== turnKey) state.draft = { key: turnKey, value: '' };
    if (myTurn) {
      refresh();
      const keepFocus = !state.hadFocusBeforeRender && document.activeElement && document.activeElement !== document.body && document.activeElement.closest?.('.reaction-bar');
      if (!keepFocus) { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); }
    } else refresh();
  }
  function flashEntryError(message) {
    const input = $('#word-input');
    setEntryHint('error', message);
    if (input) {
      input.classList.remove('shake');
      void input.offsetWidth; // 애니메이션을 다시 시작한다.
      input.classList.add('shake');
      input.focus();
      input.select(); // 틀린 단어는 선택해 두어 바로 다시 입력할 수 있게 한다.
    }
  }
  async function submitWord(event) {
    event.preventDefault();
    const input = $('#word-input');
    const word = input?.value.trim();
    if (!word) return flashEntryError('단어를 입력해 주세요.');
    const local = checkDraft(word, state.room);
    if (local.level === 'warn') { sound.play('error'); window.Bokgu?.rejected({ code: local.code }); return flashEntryError(local.text); }
    const button = $('#word-form button[type="submit"]');
    if (button) { if (button.disabled) return; button.disabled = true; button.classList.add('busy'); }
    const result = await request('game:submit', { code: state.room.code, playerId: state.session.playerId, word });
    if (!result.ok) {
      sound.play('error');
      window.Bokgu?.rejected({ code: result.code });
      flashEntryError(result.message || '단어를 보내지 못했어요.');
      const live = $('#word-form button[type="submit"]');
      if (live) { live.disabled = false; live.classList.remove('busy'); }
    } else {
      state.draft = { key: '', value: '' };
      if (input) input.value = '';
      sound.play('submit');
      window.Bokgu?.accepted({ word, points: result.points, chain: result.chain, missions: result.missions });
      if (result.missions) sound.play('bonus', 160);
      showToast(`+${result.points}점${result.chain > 1 ? ` · ${result.chain}체인` : ''}${result.newMission ? ` · 새 미션 ‘${result.newMission}’` : ''}`, 'success');
    }
  }
  async function rematch() {
    const result = await request('game:rematch', { code: state.room.code, playerId: state.session.playerId });
    if (!result.ok) showToast(result.message, 'error');
    else showToast('새 게임을 시작했어요!', 'success');
  }
  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  // 타이머는 매 프레임(rAF) 계산해 GPU 변환(translate)으로만 움직인다. 숫자는 값이 바뀔 때만 다시 쓴다.
  const clockView = { fill: null, number: null, round: null, count: null, frac: 1, turnKey: '', from: 1, t0: 0, applied: '' };
  const REFILL_MS = 340;
  function cached(name, selector) {
    const node = clockView[name];
    if (node && node.isConnected) return node;
    clockView[name] = $(selector);
    if (name === 'fill') clockView.applied = '';
    return clockView[name];
  }
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
  function updateClock() {
    const room = state.room;
    if (!room) return;
    if (room.state === 'intermission') {
      const count = cached('count', '#break-count');
      if (count) setText(count, String(Math.max(0, Math.ceil(((room.nextRoundAt || Date.now()) - Date.now()) / 1000))));
      return;
    }
    if (room.state !== 'playing') { clockView.frac = 1; clockView.turnKey = ''; return; }
    const now = Date.now();
    const roundClock = cached('round', '#round-clock');
    if (roundClock) {
      const left = Math.max(0, (room.roundEndsAt || now) - now);
      setText(roundClock, formatClock(left));
      const low = left <= 10000;
      if (roundClock.classList.contains('low') !== low) roundClock.classList.toggle('low', low);
    }
    const number = cached('number', '#clock-number');
    const fill = cached('fill', '#timer-fill');
    if (!number || !fill) return;
    const duration = room.turnDurationMs || room.turnSeconds * 1000;
    const remaining = Math.max(0, (room.turnEndsAt || now) - now);
    const seconds = Math.ceil(remaining / 1000);
    setText(number, String(seconds));
    // 새 차례가 시작되면 막대가 뚝 차오르지 않고 부드럽게 채워진다.
    const key = `${room.gameId}:${room.round}:${room.turnEndsAt}`;
    const perf = performance.now();
    if (clockView.turnKey !== key) { clockView.turnKey = key; clockView.from = clockView.frac; clockView.t0 = perf; }
    const target = Math.max(0, Math.min(1, remaining / duration));
    let frac = target;
    if (target > clockView.from) {
      const progress = Math.min(1, (perf - clockView.t0) / REFILL_MS);
      frac = clockView.from + (target - clockView.from) * (1 - Math.pow(1 - progress, 3));
    }
    clockView.frac = frac;
    const transform = `translate3d(${((frac - 1) * 100).toFixed(3)}%,0,0)`;
    if (clockView.applied !== transform) { fill.style.transform = transform; clockView.applied = transform; }
    const low = seconds <= 5;
    if (fill.classList.contains('low') !== low) fill.classList.toggle('low', low);
    if (state.session && room.currentPlayerId === state.session.playerId && seconds > 0 && seconds <= 5) window.Bokgu?.lowTime(key, seconds);
    if (state.session && room.currentPlayerId === state.session.playerId && seconds > 0 && seconds <= 3) {
      const tickKey = `${room.turnEndsAt}:${seconds}`;
      if (state.lastTick !== tickKey) { state.lastTick = tickKey; sound.play('tick'); }
    }
  }
  function frameLoop() {
    updateClock();
    requestAnimationFrame(frameLoop);
  }

  function render() {
    window.Bokgu?.sync(state.room, state.session ? state.session.playerId : null);
    if (!state.room || !state.session) { if (state.nickname) mountHub(); else renderHome(); return; }
    if (state.room.state === 'lobby') renderLobby(state.room);
    else renderGame(state.room);
  }

  const soundButton = $('#sound-toggle');
  if (soundButton) soundButton.addEventListener('click', async () => { await sound.setEnabled(!sound.enabled); syncSoundButton(); });
  syncSoundButton();
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('dialog-open')) closeDialog();
    else if (event.key === 'Escape' && document.body.classList.contains('modal-open')) closeSummary();
  });

  requestAnimationFrame(frameLoop);
  setConnection(false);
  loadAuth().then(() => { if (!state.nickname && !state.room) renderHome(); });
})();
