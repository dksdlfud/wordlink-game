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
  const REACTIONS = ['👍', '😂', '😮', '🔥', '👏', '😭'];
  const REACTION_COOLDOWN_MS = 350;

  const state = {
    socket: null,
    room: null,
    session: null,
    restoring: false,
    toastTimer: null,
    summaryClosedGame: null,
    summaryShownGame: null,
    lastTick: '',
    lastReactionAt: 0
  };

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

  // 방 상태가 바뀔 때 이전/다음 스냅샷을 비교해 알맞은 효과음을 낸다.
  function playRoomSounds(prev, next) {
    if (!prev || !state.session || prev.code !== next.code) return;
    const me = state.session.playerId;
    if (prev.state !== 'playing' && next.state === 'playing') { sound.play('start'); return; }
    if (prev.state === 'playing' && next.state === 'finished') { sound.play(next.winnerId && next.winnerId === me ? 'win' : 'end'); return; }
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
    const rows = summary.ranking.map(row => {
      const status = row.isWinner ? '최후의 생존자' : row.eliminated ? '탈락' : '생존';
      const detail = `${status} · 단어 ${row.wordCount}개${row.longestWord ? ` · 최장 ${escapeHtml(row.longestWord)}` : ''}`;
      return `<li class="summary-row ${row.isWinner ? 'winner' : ''}">
        <span class="summary-rank">${row.rank}</span>
        ${avatar(row.name, true)}
        <div class="summary-name">${escapeHtml(row.name)}${row.id === me ? '<em class="summary-me">나</em>' : ''}${row.isWinner ? ' 🏆' : ''}<small>${detail}</small></div>
        <span class="summary-score">${row.score}<small>점</small></span>
      </li>`;
    }).join('');
    return `
      <div id="summary-backdrop" class="summary-backdrop ${animate ? 'enter' : ''}" role="dialog" aria-modal="true" aria-labelledby="summary-title">
        <div class="summary-card" tabindex="-1">
          <button id="summary-close" class="summary-close" type="button" aria-label="결과 요약 닫기">✕</button>
          <div class="summary-kicker">ROUND RESULT</div>
          <h2 id="summary-title" class="summary-title">${winner ? `${escapeHtml(winner.name)} 승리!` : '게임 종료'}</h2>
          <p class="summary-sub">${winner ? '마지막까지 살아남은 플레이어예요.' : '이번 판의 결과를 확인해 보세요.'}</p>
          <div class="summary-stats">${tiles}</div>
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
    state.summaryClosedGame = state.room.gameId;
    render();
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
        state.room = result.room;
        saveSession(saved);
        render();
      } else if (readSession()) {
        clearSession();
        render();
        showToast('이전 게임방을 찾을 수 없어 홈으로 이동했어요.', 'error');
      }
    }
  });
  socket.on('disconnect', () => setConnection(false));
  socket.on('connect_error', () => setConnection(false));
  socket.on('room:update', room => {
    if (state.session && room.code === state.session.code) {
      playRoomSounds(state.room, room);
      setRoom(room);
    }
  });
  socket.on('game:reaction', showReaction);
  socket.on('notice', payload => showToast(payload.message || '알 수 없는 오류가 발생했어요.', payload.type || 'info'));
  socket.on('server:hello', payload => {
    document.documentElement.dataset.dictionarySize = String(payload.dictionarySize || 0);
  });

  function renderHome() {
    document.body.classList.remove('modal-open');
    const queryCode = new URLSearchParams(location.search).get('room') || '';
    app.innerHTML = `
      <section class="home-layout fade-in">
        <div class="hero-copy">
          <span class="eyebrow">WORD GAME · REALTIME</span>
          <h1 class="hero-title">단어를 잇고,<br><span class="accent">친구와 플레이.</span></h1>
          <p class="hero-description">마지막 글자에서 다음 단어가 시작되는 순간. 친구를 초대하고, 제한 시간 안에 가장 기발한 단어를 이어 보세요.</p>
          <div class="feature-row">
            <span class="feature-chip"><b>01</b> 실시간 대전</span>
            <span class="feature-chip"><b>02</b> 친구 초대</span>
            <span class="feature-chip"><b>03</b> 점수 경쟁</span>
          </div>
        </div>
        <section class="home-card">
          <div class="card-kicker">LET'S PLAY TOGETHER</div>
          <h2 class="card-heading">게임 시작하기</h2>
          <p class="card-subtitle">닉네임을 정하고 새 방을 만들거나 친구의 방에 참가하세요.</p>
          <label class="field-label" for="display-name">플레이어 닉네임</label>
          <input id="display-name" class="text-input" type="text" maxlength="12" autocomplete="nickname" placeholder="닉네임을 입력하세요" value="${escapeHtml(localStorage.getItem('wordlink.nickname') || '')}">
          <div class="two-fields">
            <div>
              <label class="field-label" for="turn-seconds-home">턴 제한 시간</label>
              <select id="turn-seconds-home" class="select-input"><option value="10">10초</option><option value="15" selected>15초</option><option value="20">20초</option><option value="30">30초</option></select>
            </div>
            <div>
              <label class="field-label" for="max-players-home">최대 인원</label>
              <select id="max-players-home" class="select-input"><option value="2">2명</option><option value="3">3명</option><option value="4">4명</option><option value="5">5명</option><option value="6">6명</option><option value="7">7명</option><option value="8" selected>8명</option></select>
            </div>
          </div>
          <button id="create-room" class="primary-button button-full">새 게임방 만들기 <span aria-hidden="true">↗</span></button>
          <div class="divider-label">OR JOIN A ROOM</div>
          <div class="join-row">
            <input id="join-code" class="text-input code-input" type="text" maxlength="5" placeholder="방 코드 5자리" autocomplete="off" value="${escapeHtml(queryCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))}">
            <button id="join-room" class="secondary-button">참가하기</button>
          </div>
          <p class="home-footnote">계정 가입 없이 게스트로 바로 플레이할 수 있어요.</p>
        </section>
      </section>`;
    $('#create-room').addEventListener('click', createRoom);
    $('#join-room').addEventListener('click', joinRoom);
    $('#display-name').addEventListener('keydown', event => { if (event.key === 'Enter') createRoom(); });
    $('#join-code').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
    $('#join-code').addEventListener('keydown', event => { if (event.key === 'Enter') joinRoom(); });
  }

  function currentName() {
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
  async function createRoom() {
    const name = currentName();
    if (!name) return;
    const button = $('#create-room');
    button.disabled = true;
    button.textContent = '방을 만드는 중…';
    const result = await request('room:create', {
      name, playerId: playerId(),
      turnSeconds: Number($('#turn-seconds-home').value),
      maxPlayers: Number($('#max-players-home').value)
    });
    if (!result.ok) { showToast(result.message, 'error'); renderHome(); return; }
    const session = { code: result.room.code, playerId: result.playerId, name };
    saveSession(session);
    state.room = result.room;
    const settings = await request('room:settings', { code: session.code, playerId: session.playerId, turnSeconds: Number($('#turn-seconds-home')?.value || 15), maxPlayers: Number($('#max-players-home')?.value || 8) });
    if (!settings.ok && settings.message) console.warn(settings.message);
    render();
    showToast('게임방을 만들었어요. 친구를 초대해 보세요!', 'success');
  }
  async function joinRoom() {
    const name = currentName();
    if (!name) return;
    const code = ($('#join-code')?.value || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) { showToast('방 코드를 영문·숫자 5자리로 입력해 주세요.', 'error'); $('#join-code')?.focus(); return; }
    const button = $('#join-room');
    button.disabled = true;
    button.textContent = '접속 중…';
    const result = await request('room:join', { code, name, playerId: playerId() });
    if (!result.ok) { showToast(result.message, 'error'); renderHome(); return; }
    saveSession({ code: result.room.code, playerId: result.playerId, name });
    state.room = result.room;
    history.replaceState({}, '', location.pathname);
    render();
    showToast('게임방에 참가했어요.', 'success');
  }

  function renderLobby(room) {
    document.body.classList.remove('modal-open');
    const mine = room.players.find(player => player.id === state.session.playerId);
    const isHost = room.hostId === state.session.playerId;
    const allReady = room.players.length >= 2 && room.players.every(player => player.online && player.ready);
    const playerRows = room.players.map(player => `
      <div class="player-row">
        ${avatar(player.name)}
        <div class="player-info">
          <div class="player-name">${escapeHtml(player.name)} ${player.isHost ? '<span class="host-label">HOST</span>' : ''}</div>
          <div class="player-meta">${player.online ? '온라인 · 참가 중' : '연결 끊김'}</div>
        </div>
        <span class="player-status ${player.ready ? 'ready' : player.online ? '' : 'offline'}">${player.ready ? '준비 완료' : player.online ? '대기 중' : '오프라인'}</span>
      </div>`).join('');
    const emptySlots = Math.max(0, Math.min(room.settings.maxPlayers - room.players.length, 3));
    const settingsContent = isHost ? `
      <div class="setting-block">
        <label class="field-label" for="setting-time">턴 제한 시간</label>
        <select id="setting-time" class="select-input"><option value="10" ${room.settings.turnSeconds === 10 ? 'selected' : ''}>10초</option><option value="15" ${room.settings.turnSeconds === 15 ? 'selected' : ''}>15초</option><option value="20" ${room.settings.turnSeconds === 20 ? 'selected' : ''}>20초</option><option value="30" ${room.settings.turnSeconds === 30 ? 'selected' : ''}>30초</option></select>
      </div>
      <div class="setting-block">
        <label class="field-label" for="setting-players">최대 인원</label>
        <select id="setting-players" class="select-input">${[2,3,4,5,6,7,8].map(num => `<option value="${num}" ${room.settings.maxPlayers === num ? 'selected' : ''} ${num < room.players.length ? 'disabled' : ''}>${num}명</option>`).join('')}</select>
        <p class="setting-note">인원은 2~8명까지 설정할 수 있어요.</p>
      </div>
      <button id="apply-settings" class="ghost-button button-full">설정 적용</button>` : `
      <div class="setting-block"><label class="field-label">턴 제한 시간</label><div class="read-only-setting">${room.settings.turnSeconds}초</div></div>
      <div class="setting-block"><label class="field-label">최대 인원</label><div class="read-only-setting">${room.settings.maxPlayers}명</div></div>
      <p class="setting-note">대기실 설정은 방장만 변경할 수 있어요.</p>`;

    app.innerHTML = `
      <section class="fade-in">
        <div class="page-heading-row">
          <div><span class="eyebrow">WAITING ROOM</span><h1 class="page-title">친구들이 모이는 중</h1><p class="page-description">모든 플레이어가 준비되면 방장이 게임을 시작할 수 있어요.</p></div>
          <div class="room-code-pill"><small>ROOM CODE</small><strong>${escapeHtml(room.code)}</strong></div>
        </div>
        <div class="lobby-grid">
          <section class="panel">
            <div class="panel-header"><span class="panel-title">참가 플레이어</span><span class="panel-caption">${room.players.length} / ${room.settings.maxPlayers}명</span></div>
            <div class="player-list">${playerRows}${Array.from({ length: emptySlots }, () => `<div class="empty-slot"><span class="avatar">＋</span><span>친구를 기다리는 자리</span></div>`).join('')}</div>
          </section>
          <section class="panel settings-panel">
            <div class="panel-header"><span class="panel-title">게임 설정</span><span class="panel-caption">${isHost ? 'HOST CONTROL' : 'VIEW ONLY'}</span></div>
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
  }
  async function applySettings() {
    const result = await request('room:settings', {
      code: state.room.code, playerId: state.session.playerId,
      turnSeconds: Number($('#setting-time').value), maxPlayers: Number($('#setting-players').value)
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
    renderHome();
  }

  function renderGame(room) {
    const mine = room.players.find(player => player.id === state.session.playerId);
    const isHost = room.hostId === state.session.playerId;
    const isPlaying = room.state === 'playing';
    const myTurn = isPlaying && room.currentPlayerId === state.session.playerId && !mine?.eliminated;
    const alive = room.players.filter(player => !player.eliminated).length;
    const wordCount = room.words.filter(item => item.type === 'word').length;
    const sortedPlayers = [...room.players].sort((a, b) => Number(a.eliminated) - Number(b.eliminated) || b.score - a.score);
    const scoreRows = sortedPlayers.map(player => {
      const current = player.id === room.currentPlayerId;
      const status = player.eliminated ? '탈락' : !player.online ? '연결 끊김' : current ? '현재 차례' : '플레이 중';
      return `<div class="score-row ${current ? 'current' : ''} ${player.eliminated ? 'eliminated' : ''}">
        ${avatar(player.name, true)}
        <div class="score-name">${escapeHtml(player.name)}<span class="score-state">${status}</span></div>
        <span class="score-points">${player.score}</span>
      </div>`;
    }).join('');
    const history = room.words.slice().reverse().map((item, reverseIndex) => {
      if (item.type === 'system') return `<div class="history-system">${escapeHtml(item.text)}</div>`;
      return `<div class="history-item"><span class="history-index">${String(room.words.filter(entry => entry.type === 'word').indexOf(item) + 1).padStart(2, '0')}</span>${avatar(item.playerName, true)}<span class="history-word">${escapeHtml(item.word)}</span><span class="history-player">${escapeHtml(item.playerName)}</span><span class="history-points">+${item.points}</span></div>`;
    }).join('');
    const finished = room.state === 'finished';
    const winnerContent = finished ? `<div class="finished-banner"><div class="trophy">🏆</div><h2>${room.winnerName ? `${escapeHtml(room.winnerName)} 승리!` : '게임 종료'}</h2><p>${room.winnerName ? '마지막까지 살아남았어요.' : '결과를 확인해 주세요.'}</p></div>` : '';
    const turnName = isPlaying ? (myTurn ? '내 차례예요!' : `${escapeHtml(room.currentPlayerName)}님의 차례`) : '게임이 종료되었어요';
    const allowed = (room.allowedSyllables && room.allowedSyllables.length) ? room.allowedSyllables : (room.lastSyllable ? [room.lastSyllable] : []);
    const allowedLabel = allowed.map(item => `‘${escapeHtml(item)}’`).join(' 또는 ');
    const allowedChip = allowed.map(item => escapeHtml(item)).join(' / ');
    const allowedPlaceholder = allowed.join(' · ');
    const turnHint = myTurn ? (room.lastSyllable ? `${allowedLabel}(으)로 시작하는 단어를 입력하세요.` : '첫 단어를 자유롭게 입력해 보세요.') : '차례가 돌아올 때까지 친구들의 단어를 확인해 보세요.';
    const chain = room.words.filter(item => item.type === 'word').slice(-1)[0];
    const showSummary = finished && Boolean(room.summary) && state.summaryClosedGame !== room.gameId;
    const firstShow = showSummary && state.summaryShownGame !== room.gameId;
    if (showSummary) state.summaryShownGame = room.gameId;
    const summaryHtml = showSummary ? summaryMarkup(room, isHost, firstShow) : '';
    const reactionBar = `<section class="reaction-bar" aria-label="이모지 반응"><span class="reaction-label">REACT</span><div class="reaction-buttons">${REACTIONS.map(emoji => `<button type="button" class="reaction-button" data-emoji="${emoji}" aria-label="${emoji} 반응 보내기">${emoji}</button>`).join('')}</div></section>`;
    app.innerHTML = `
      <section class="fade-in game-screen">
        <div class="game-topline">
          <div class="game-top-actions">
            <button id="leave-room" class="ghost-button danger-button">방 나가기</button>
            <button id="copy-invite" class="ghost-button">초대 링크 복사</button>
            ${finished && room.summary ? '<button id="open-summary" class="secondary-button">결과 요약 보기</button>' : ''}
            ${finished && isHost ? '<button id="rematch" class="primary-button">다시 플레이 ↗</button>' : finished ? '<button class="secondary-button" disabled>방장이 다시 시작할 수 있어요</button>' : ''}
          </div>
          <div class="game-top-info"><span class="game-tag">LIVE WORD BATTLE</span><span class="game-code">ROOM ${escapeHtml(room.code)} <span class="footer-dot">·</span> ${alive}명 생존 <span class="footer-dot">·</span> ${wordCount}개 단어</span></div>
        </div>
        ${winnerContent}
        <section class="turn-card stage">
          <div class="stage-side stage-next">
            <span class="stage-side-label">NEXT</span>
            <strong class="stage-letter">${allowedChip || '?'}</strong>
          </div>
          <div class="stage-center">
            <div class="turn-label">${finished ? 'MATCH COMPLETE' : 'CURRENT TURN'}</div>
            <div class="turn-name">${turnName}</div>
            <div class="turn-hint">${finished ? '친구들과 한 판 더 즐겨 보세요.' : turnHint}</div>
            <div class="chain-current">${chain ? `<span class="chain-word">${escapeHtml(chain.word)}</span>` : '<span class="chain-word empty">첫 단어를 기다리고 있어요</span>'}</div>
            <div class="timer-track"><div id="timer-fill" class="timer-fill"></div></div>
          </div>
          <div class="stage-side stage-chain">
            <span class="stage-side-label">CHAIN</span>
            <strong class="stage-letter">${wordCount}</strong>
            <div class="turn-clock"><span class="clock-icon">◷</span><span id="clock-number" class="clock-number">${isPlaying ? room.settings.turnSeconds : '—'}</span></div>
          </div>
        </section>
        <div class="players-row">
          <section class="panel score-panel"><div class="panel-header"><span class="panel-title">플레이어 순위</span><span class="panel-caption">SCORE</span></div><div class="score-list">${scoreRows}</div></section>
          <section class="panel rules-panel"><h3 class="rules-title">게임 규칙</h3><div class="rule-line"><i class="rule-dot"></i><span>마지막 글자로 시작하는 단어를 입력해요.</span></div><div class="rule-line"><i class="rule-dot"></i><span>단어는 2~12글자, 사전에 등록된 단어만 가능해요.</span></div><div class="rule-line"><i class="rule-dot"></i><span>한 번 사용한 단어는 다시 사용할 수 없어요.</span></div><div class="rule-line"><i class="rule-dot"></i><span>시간이 끝나면 탈락하고, 글자 수 × 10점을 얻어요.</span></div></section>
        </div>
        <section class="panel history-panel chat-panel">
          <div class="panel-header"><span class="panel-title">단어 기록</span><span class="panel-caption">${wordCount} WORDS</span></div>
          <div id="history-list" class="history-list">${history || '<div class="history-empty">아직 입력된 단어가 없어요.<br>첫 번째 단어의 주인공이 되어 보세요!</div>'}</div>
          <div class="chat-entry">
            <form id="word-form" class="entry-form">
              <input id="word-input" class="text-input" type="text" maxlength="12" autocomplete="off" placeholder="${myTurn ? (room.lastSyllable ? `${allowedPlaceholder}(으)로 시작하는 단어` : '첫 단어를 입력하세요') : '내 차례를 기다려 주세요'}" ${myTurn ? '' : 'disabled'}>
              <button class="primary-button" type="submit" ${myTurn ? '' : 'disabled'}>단어 제출</button>
            </form>
            <div class="entry-help"><span>${myTurn ? '<strong>ENTER</strong> 키로 빠르게 제출할 수 있어요.' : '순서가 되면 입력창이 활성화돼요.'}</span><span>중복 단어 사용 불가</span></div>
          </div>
        </section>
        ${reactionBar}
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
    const input = $('#word-input');
    if (myTurn && input) input.focus({ preventScroll: true });
    updateClock();
    const historyNode = $('#history-list');
    if (historyNode) historyNode.scrollTop = 0;
  }
  async function submitWord(event) {
    event.preventDefault();
    const input = $('#word-input');
    const word = input?.value.trim();
    if (!word) return showToast('단어를 입력해 주세요.', 'error');
    const button = $('#word-form button');
    button.disabled = true;
    const result = await request('game:submit', { code: state.room.code, playerId: state.session.playerId, word });
    if (!result.ok) {
      sound.play('error');
      showToast(result.message, 'error');
      if (input) { input.value = ''; input.focus(); }
      if (button) button.disabled = false;
    } else {
      sound.play('submit');
      showToast(`‘${result.word}’ 제출 완료 · +${result.points}점`, 'success');
    }
  }
  async function rematch() {
    const result = await request('game:rematch', { code: state.room.code, playerId: state.session.playerId });
    if (!result.ok) showToast(result.message, 'error');
    else showToast('새 게임을 시작했어요!', 'success');
  }
  function updateClock() {
    const room = state.room;
    if (!room || room.state !== 'playing') return;
    const number = $('#clock-number');
    const fill = $('#timer-fill');
    if (!number || !fill) return;
    const duration = room.settings.turnSeconds * 1000;
    const remaining = Math.max(0, (room.turnEndsAt || Date.now()) - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    number.textContent = String(seconds);
    fill.style.width = `${Math.max(0, Math.min(100, remaining / duration * 100))}%`;
    fill.classList.toggle('low', seconds <= 5);
    if (state.session && room.currentPlayerId === state.session.playerId && seconds > 0 && seconds <= 3) {
      const key = `${room.turnEndsAt}:${seconds}`;
      if (state.lastTick !== key) { state.lastTick = key; sound.play('tick'); }
    }
  }

  function render() {
    if (!state.room || !state.session) { renderHome(); return; }
    if (state.room.state === 'lobby') renderLobby(state.room);
    else renderGame(state.room);
  }

  const soundButton = $('#sound-toggle');
  if (soundButton) soundButton.addEventListener('click', async () => { await sound.setEnabled(!sound.enabled); syncSoundButton(); });
  syncSoundButton();
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('modal-open')) closeSummary();
  });

  setInterval(updateClock, 180);
  setConnection(false);
  renderHome();
})();
