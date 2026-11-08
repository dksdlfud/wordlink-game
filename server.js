'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Server } = require('socket.io');
const {
  validateWord, normalizeWord, allowedFirstSyllables, buildStartIndex, buildRoundSummary, REACTION_EMOJIS,
  TOTAL_TIME_OPTIONS, ROUND_OPTIONS, DEFAULT_TOTAL_SECONDS, DEFAULT_ROUNDS,
  turnSecondsForRound, buildMissionPool, pickMissionLetter, hasMissionLetter, countMissionLetters, calcScore
} = require('./game-rules');

// The GitHub upload currently has a flattened layout: all app files live at the repository root.
const ROOT = __dirname;
const PUBLIC = ROOT;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_ROOMS = 500;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rawWords = JSON.parse(fs.readFileSync(path.join(ROOT, 'words.json'), 'utf8'));
const dictionary = new Set(rawWords.map(normalizeWord));
const missionPool = buildMissionPool(dictionary);
const startIndex = buildStartIndex(dictionary); // 한방 단어 판정용 (첫 글자별 단어 수)
// 방 설정의 true/false 값을 안전하게 읽는다. 값이 없으면 fallback.
function readBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null; // 잘못된 값
}

const ROUND_BREAK_MS = 6000;      // 라운드 사이 쉬는 시간
const REACTION_COOLDOWN_MS = 350; // 이모지 연타 제한

// ---- 로비 ----
const VERSION = '0.3.0';
const LOBBY_CHANNEL = 'wordlink:lobby';
const LOBBY_CHAT_LIMIT = 60;      // 서버가 기억하는 최근 채팅 수
const CHAT_MAX_LENGTH = 120;
const CHAT_COOLDOWN_MS = 800;
const LOBBY_USER_LIMIT = 200;     // 접속자 목록에 보내는 최대 인원
const LOBBY_BROADCAST_MS = 300;   // 방/접속자 목록 갱신 묶음 전송 간격
const ROOM_IDLE_MS = 10 * 60 * 1000; // 아무도 접속해 있지 않은 방을 치우는 시간
const PASSWORD_MAX_FAILS = 5;
const PASSWORD_BLOCK_MS = 30 * 1000;

const publicFiles = new Set(['/index.html', '/styles.css', '/client.js', '/mascot.css', '/mascot.js']);

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const requested = pathname === '/' ? '/index.html' : pathname;
  // Only expose browser assets. Keep server code, package files and the dictionary private.
  if (!publicFiles.has(requested)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const filePath = path.join(PUBLIC, requested.slice(1));
  fs.readFile(filePath, (error, data) => {
    if (error) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(data);
  });
});

const socketOptions = {
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5
};
if (process.env.CORS_ORIGIN) socketOptions.cors = { origin: process.env.CORS_ORIGIN.split(',').map(value => value.trim()) };
const io = new Server(server, socketOptions);

const rooms = new Map();
const timers = new Map();
const presence = new Map(); // socket.id -> { playerId, name }  (로비·방 어디에 있든 접속 중인 사람)
const lobbyChat = [];
let chatSeq = 0;
let lobbyTimer = null;

function roomChannel(code) { return `wordlink:${code}`; }
function safeName(value) {
  const name = String(value ?? '').normalize('NFC').trim().replace(/[<>]/g, '').slice(0, 12);
  return /^[\p{L}\p{N}_-]{2,12}$/u.test(name) ? name : '';
}
function safePlayerId(value) {
  const id = String(value ?? '');
  return /^[a-zA-Z0-9-]{8,80}$/.test(id) ? id : randomUUID();
}
function safeCode(value) { return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); }
function sendAck(callback, payload) { if (typeof callback === 'function') callback(payload); }
function createCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let i = 0; i < 5; i += 1) code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate a room code.');
}
function getPlayer(room, playerId) { return room.players.get(playerId); }
function playerForSocket(room, playerId, socket) {
  const player = getPlayer(room, playerId);
  return player && player.socketId === socket.id ? player : null;
}
function orderedPlayers(room) { return room.playerOrder.map(id => room.players.get(id)).filter(Boolean); }
function activePlayers(room) { return orderedPlayers(room).filter(player => !player.eliminated); }
function currentPlayer(room) { return room.currentPlayerId ? getPlayer(room, room.currentPlayerId) : null; }
function clearTurnTimer(room) {
  const timer = timers.get(room.code);
  if (timer) clearTimeout(timer);
  timers.delete(room.code);
  room.turnToken += 1;
}
function clearRoundTimers(room) {
  if (room.roundTimer) clearTimeout(room.roundTimer);
  if (room.breakTimer) clearTimeout(room.breakTimer);
  room.roundTimer = null;
  room.breakTimer = null;
  room.roundToken += 1;
}
function roomSnapshot(room) {
  const current = currentPlayer(room);
  return {
    code: room.code,
    number: room.number,
    title: room.title,
    locked: Boolean(room.password),
    hostId: room.hostId,
    state: room.state,
    gameId: room.gameId,
    settings: { ...room.settings },
    round: room.round + 1,
    totalRounds: room.settings.rounds,
    mission: room.mission,
    missionChange: room.missionChange,
    roundEndsAt: room.roundEndsAt,
    nextRoundAt: room.nextRoundAt,
    roundResult: room.roundResult,
    turnSeconds: room.turnSeconds,
    turnDurationMs: room.turnDurationMs,
    totalWords: room.matchWordCount,
    summary: room.state === 'finished' ? room.summary : null,
    players: orderedPlayers(room).map(player => ({
      id: player.id,
      name: player.name,
      online: player.online,
      ready: player.ready,
      score: player.score,
      roundScore: player.roundScore,
      roundWins: player.roundWins,
      eliminated: player.eliminated,
      isHost: player.id === room.hostId
    })),
    currentPlayerId: room.currentPlayerId,
    currentPlayerName: current ? current.name : '',
    turnEndsAt: room.turnEndsAt,
    turnCount: room.turnCount,
    lastSyllable: room.lastSyllable,
    allowedSyllables: allowedFirstSyllables(room.lastSyllable),
    words: room.words.slice(-80),
    winnerId: room.winnerId,
    winnerName: room.winnerId && getPlayer(room, room.winnerId) ? getPlayer(room, room.winnerId).name : ''
  };
}
function broadcast(room) { io.to(roomChannel(room.code)).emit('room:update', roomSnapshot(room)); scheduleLobbyBroadcast(); }
function notice(socket, message, type = 'info') { socket.emit('notice', { message, type }); }
function livePlayers(room) { return orderedPlayers(room).filter(player => !player.left); }

// ---------- 로비: 방 목록 · 접속자 · 정리 ----------
function safeTitle(value, fallback) {
  const title = String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24);
  return title || fallback;
}
// 비밀번호: 비어 있으면 '' (잠금 없음), 영문·숫자 1~8자면 그대로, 그 밖에는 null(잘못된 값)
function safePassword(value) {
  const password = String(value ?? '').trim();
  if (password === '') return '';
  return /^[\p{L}\p{N}]{1,8}$/u.test(password) ? password : null;
}
function nextRoomNumber() {
  const used = new Set([...rooms.values()].map(room => room.number));
  let number = 1;
  while (used.has(number)) number += 1;
  return number;
}
function roomListItem(room) {
  const host = getPlayer(room, room.hostId);
  const count = livePlayers(room).length;
  return {
    code: room.code,
    number: room.number,
    title: room.title,
    locked: Boolean(room.password),
    state: room.state === 'lobby' ? 'waiting' : 'playing',
    players: count,
    maxPlayers: room.settings.maxPlayers,
    hostName: host ? host.name : '',
    rounds: room.settings.rounds,
    totalSeconds: room.settings.totalSeconds,
    turnSeconds: room.settings.turnSeconds,
    allowOneShot: room.settings.allowOneShot !== false,
    joinable: room.state === 'lobby' && count < room.settings.maxPlayers
  };
}
// 종료된 방과 접속자가 아무도 없는 방은 목록에서 숨긴다.
function roomList() {
  return [...rooms.values()]
    .filter(room => room.state !== 'finished' && orderedPlayers(room).some(player => player.online))
    .sort((a, b) => a.number - b.number)
    .map(roomListItem);
}
function userList() {
  const byPlayer = new Map();
  for (const [socketId, entry] of presence) {
    const code = io.sockets.sockets.get(socketId)?.data.roomCode;
    const room = code ? rooms.get(code) : null;
    const where = room ? (room.state === 'lobby' ? 'waiting' : 'playing') : 'lobby';
    const item = { name: entry.name, where, roomNumber: room ? room.number : null };
    const prev = byPlayer.get(entry.playerId);
    if (!prev || (prev.where === 'lobby' && where !== 'lobby')) byPlayer.set(entry.playerId, item);
  }
  const list = [...byPlayer.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return { total: list.length, list: list.slice(0, LOBBY_USER_LIMIT) };
}
// 방/접속자 변화는 잦으므로 짧게 모아서 한 번만 보낸다.
function scheduleLobbyBroadcast() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    io.to(LOBBY_CHANNEL).emit('lobby:rooms', roomList());
    io.to(LOBBY_CHANNEL).emit('lobby:users', userList());
  }, LOBBY_BROADCAST_MS);
  lobbyTimer.unref?.();
}
function removeRoom(room) {
  clearTurnTimer(room);
  clearRoundTimers(room);
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  if (room.idleTimer) clearTimeout(room.idleTimer);
  rooms.delete(room.code);
  scheduleLobbyBroadcast();
}
// 모두 접속이 끊긴 방이 영원히 남지 않도록 일정 시간 뒤 치운다.
function scheduleIdleCleanup(room) {
  if (room.idleTimer) { clearTimeout(room.idleTimer); room.idleTimer = null; }
  if (orderedPlayers(room).some(player => player.online)) return;
  room.idleTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room || orderedPlayers(room).some(player => player.online)) return;
    removeRoom(room);
  }, ROOM_IDLE_MS);
  room.idleTimer.unref?.();
}

// 한 라운드를 끝낸다. 마지막 라운드이거나 남은 사람이 부족하면 경기 전체를 끝낸다.
function endRound(room, reason) {
  if (room.state !== 'playing') return;
  clearTurnTimer(room);
  clearRoundTimers(room);
  room.turnEndsAt = null;
  room.turnDurationMs = null;
  room.roundEndsAt = null;
  room.currentPlayerId = null;
  const candidates = activePlayers(room).filter(player => !player.left);
  let winner = null;
  if (reason === 'last') {
    winner = candidates.length === 1 ? candidates[0] : null;
  } else {
    const top = Math.max(0, ...candidates.map(player => player.roundScore));
    const leaders = top > 0 ? candidates.filter(player => player.roundScore === top) : [];
    winner = leaders.length === 1 ? leaders[0] : null;
  }
  if (winner) winner.roundWins += 1;
  room.roundResult = {
    round: room.round + 1,
    reason,
    winnerId: winner ? winner.id : null,
    winnerName: winner ? winner.name : '',
    scores: livePlayers(room)
      .map(player => ({ id: player.id, name: player.name, roundScore: player.roundScore, eliminated: player.eliminated }))
      .sort((a, b) => b.roundScore - a.roundScore)
  };
  const label = winner ? `${winner.name}님이 라운드 ${room.round + 1}을(를) 가져갔어요.` : `라운드 ${room.round + 1}은(는) 무승부예요.`;
  room.words.push({ type: 'system', text: reason === 'time' ? `⏱ 라운드 시간 종료 — ${label}` : `🏁 ${label}`, at: Date.now() });
  const isLast = room.round + 1 >= room.settings.rounds;
  if (isLast || livePlayers(room).length < 2) return finishMatch(room);
  room.state = 'intermission';
  room.nextRoundAt = Date.now() + ROUND_BREAK_MS;
  const token = room.roundToken;
  room.breakTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room || room.state !== 'intermission' || room.roundToken !== token) return;
    startRound(room, room.round + 1);
    broadcast(room);
  }, ROUND_BREAK_MS);
  room.breakTimer.unref?.();
  broadcast(room);
}

// 전체 경기를 끝낸다. 라운드 승수 → 총점 순으로 우승자를 정한다.
function finishMatch(room) {
  clearTurnTimer(room);
  clearRoundTimers(room);
  room.state = 'finished';
  room.turnEndsAt = null;
  room.turnDurationMs = null;
  room.roundEndsAt = null;
  room.nextRoundAt = null;
  room.currentPlayerId = null;
  const contenders = livePlayers(room);
  const ranked = [...contenders].sort((a, b) => b.roundWins - a.roundWins || b.score - a.score);
  const [first, second] = ranked;
  const decided = first && (!second || first.roundWins !== second.roundWins || first.score !== second.score);
  const champion = decided ? first : null;
  room.winnerId = champion ? champion.id : null;
  room.words.push({ type: 'system', text: champion ? `🏆 ${champion.name}님이 최종 우승했습니다.` : '게임이 종료되었습니다.', at: Date.now() });
  room.summary = buildRoundSummary({
    players: orderedPlayers(room).map(player => ({ id: player.id, name: player.name, score: player.score, roundWins: player.roundWins, eliminated: player.left })),
    words: room.matchWords,
    winnerId: room.winnerId,
    startedAt: room.startedAt,
    endedAt: Date.now()
  });
  broadcast(room);
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    if (rooms.get(room.code) === room) removeRoom(room);
  }, 30 * 60 * 1000);
  room.cleanupTimer.unref?.();
}
function findNextActiveIndex(room, fromIndex) {
  const count = room.playerOrder.length;
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (fromIndex + offset) % count;
    const player = room.players.get(room.playerOrder[index]);
    if (player && !player.eliminated) return index;
  }
  return -1;
}
function startTurn(room, index) {
  const playerId = room.playerOrder[index];
  const player = room.players.get(playerId);
  if (!player || player.eliminated) return endRound(room, 'last');
  clearTurnTimer(room);
  room.turnIndex = index;
  room.currentPlayerId = playerId;
  const now = Date.now();
  const turnMs = room.turnSeconds * 1000;
  const roundLeft = room.roundEndsAt - now;
  room.turnStartedAt = now;
  // 라운드 종료 시각이 더 가까우면 턴 타이머는 두지 않고 라운드 타이머에 맡긴다.
  const clamped = roundLeft <= turnMs;
  room.turnEndsAt = clamped ? room.roundEndsAt : now + turnMs;
  room.turnDurationMs = room.turnEndsAt - now;
  if (clamped) return;
  const token = room.turnToken;
  const timer = setTimeout(() => {
    if (rooms.get(room.code) !== room || room.state !== 'playing' || room.turnToken !== token || room.currentPlayerId !== playerId) return;
    const timedOut = room.players.get(playerId);
    if (timedOut && !timedOut.eliminated) {
      timedOut.eliminated = true;
      room.words.push({ type: 'system', text: `${timedOut.name}님이 시간 초과로 이번 라운드에서 탈락했습니다.`, at: Date.now() });
    }
    const next = findNextActiveIndex(room, room.turnIndex);
    if (next < 0 || activePlayers(room).length <= 1) return endRound(room, 'last');
    room.turnCount += 1;
    startTurn(room, next);
    broadcast(room);
  }, turnMs);
  timers.set(room.code, timer);
  timer.unref?.();
}

// 라운드를 시작한다. 모든 플레이어(나간 사람 제외)가 되살아나고 단어 사슬·라운드 점수가 초기화된다.
function startRound(room, roundIndex) {
  clearTurnTimer(room);
  clearRoundTimers(room);
  room.state = 'playing';
  room.round = roundIndex;
  room.words = [];
  room.usedWords.clear();
  room.lastSyllable = '';
  room.turnCount = 1;
  room.roundResult = null;
  room.nextRoundAt = null;
  room.mission = pickMissionLetter(missionPool, room.mission);
  room.missionChange = null;
  room.turnSeconds = turnSecondsForRound(room.settings.turnSeconds, roundIndex);
  orderedPlayers(room).forEach(player => { player.roundScore = 0; player.eliminated = Boolean(player.left); });
  room.roundEndsAt = Date.now() + room.settings.totalSeconds * 1000;
  const token = room.roundToken;
  room.roundTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room || room.state !== 'playing' || room.roundToken !== token) return;
    endRound(room, 'time');
  }, room.settings.totalSeconds * 1000);
  room.roundTimer.unref?.();
  const first = findNextActiveIndex(room, roundIndex - 1); // 라운드마다 시작 순서를 한 칸씩 돌린다.
  startTurn(room, first);
}

// 새 경기(1라운드부터)를 시작한다.
function startMatch(room) {
  if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
  room.gameId += 1;
  room.matchWords = [];
  room.matchWordCount = 0;
  room.summary = null;
  room.winnerId = null;
  room.mission = '';
  room.startedAt = Date.now();
  orderedPlayers(room).forEach(player => { player.score = 0; player.roundScore = 0; player.roundWins = 0; player.left = false; player.eliminated = false; });
  startRound(room, 0);
}
function createRoomObject(code, host, options = {}) {
  const now = Date.now();
  const settings = { turnSeconds: 15, maxPlayers: 8, totalSeconds: DEFAULT_TOTAL_SECONDS, rounds: DEFAULT_ROUNDS, allowOneShot: true, ...(options.settings || {}) };
  return {
    code,
    number: nextRoomNumber(),
    title: options.title || `${host.name}님의 방`,
    password: options.password || '',
    hostId: host.id,
    state: 'lobby',
    settings,
    players: new Map([[host.id, host]]),
    playerOrder: [host.id],
    words: [],
    usedWords: new Set(),
    lastSyllable: '',
    currentPlayerId: null,
    turnIndex: 0,
    turnEndsAt: null,
    turnCount: 0,
    turnToken: 0,
    turnSeconds: settings.turnSeconds,
    turnDurationMs: null,
    turnStartedAt: null,
    gameId: 0,
    round: 0,
    roundToken: 0,
    roundTimer: null,
    breakTimer: null,
    roundEndsAt: null,
    nextRoundAt: null,
    roundResult: null,
    mission: '',
    missionSeq: 0,
    missionChange: null,
    matchWords: [],
    matchWordCount: 0,
    summary: null,
    startedAt: null,
    winnerId: null,
    createdAt: now,
    cleanupTimer: null,
    idleTimer: null
  };
}
function attachPlayer(room, player, socket) {
  player.socketId = socket.id;
  player.online = true;
  socket.data.playerId = player.id;
  socket.data.roomCode = room.code;
  socket.leave(LOBBY_CHANNEL);
  presence.set(socket.id, { playerId: player.id, name: player.name });
  if (room.idleTimer) { clearTimeout(room.idleTimer); room.idleTimer = null; }
  socket.join(roomChannel(room.code));
  broadcast(room);
}

// 방 참가 공통 처리. 방 코드 입장 · 목록에서 클릭 · 빠른 입장이 모두 이 함수를 쓴다.
function performJoin(socket, room, { name, playerId, password }) {
  const existing = room.players.get(playerId);
  if (existing) { // 이미 이 방의 구성원이면(재접속) 비밀번호 없이 복귀
    if (existing.socketId && existing.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existing.socketId);
      if (oldSocket) oldSocket.leave(roomChannel(room.code));
    }
    existing.name = name;
    attachPlayer(room, existing, socket);
    return { ok: true, room: roomSnapshot(room), playerId };
  }
  if (room.state !== 'lobby') return { ok: false, code: 'STARTED', message: '게임이 이미 시작된 방에는 새로 참가할 수 없어요.' };
  if (orderedPlayers(room).length >= room.settings.maxPlayers) return { ok: false, code: 'FULL', message: '방 인원이 가득 찼어요.' };
  if (room.password) {
    if (Date.now() < (socket.data.pwBlockUntil || 0)) return { ok: false, code: 'PASSWORD_BLOCKED', message: '비밀번호를 여러 번 틀렸어요. 잠시 후 다시 시도해 주세요.' };
    if (!password) return { ok: false, code: 'PASSWORD_REQUIRED', message: '비밀번호가 필요한 방이에요.' };
    if (password !== room.password) {
      socket.data.pwFails = (socket.data.pwFails || 0) + 1;
      if (socket.data.pwFails >= PASSWORD_MAX_FAILS) { socket.data.pwFails = 0; socket.data.pwBlockUntil = Date.now() + PASSWORD_BLOCK_MS; }
      return { ok: false, code: 'PASSWORD_WRONG', message: '비밀번호가 맞지 않아요.' };
    }
    socket.data.pwFails = 0;
  }
  const player = { id: playerId, name, socketId: socket.id, online: true, ready: false, score: 0, roundScore: 0, roundWins: 0, eliminated: false, left: false, lastReactAt: 0 };
  room.players.set(playerId, player);
  room.playerOrder.push(playerId);
  attachPlayer(room, player, socket);
  return { ok: true, room: roomSnapshot(room), playerId };
}
function findRoomPlayer(playerId, code) {
  const room = rooms.get(code);
  if (!room) return null;
  const player = room.players.get(playerId);
  return player ? { room, player } : null;
}

io.on('connection', socket => {
  socket.emit('server:hello', { dictionarySize: dictionary.size, version: VERSION });

  // ---------- 로비 ----------
  socket.on('lobby:enter', (payload = {}, callback) => {
    const name = safeName(payload.name);
    if (!name) return sendAck(callback, { ok: false, message: '닉네임은 한글·영문·숫자 2~12자로 입력해 주세요.' });
    const playerId = safePlayerId(payload.playerId);
    const roomCode = socket.data.roomCode;
    const inRoom = roomCode && rooms.get(roomCode)?.players.get(socket.data.playerId)?.socketId === socket.id;
    if (inRoom) return sendAck(callback, { ok: false, code: 'IN_ROOM', message: '이미 방에 참가 중이에요.' });
    for (const [socketId, entry] of presence) {
      if (socketId !== socket.id && entry.name === name && entry.playerId !== playerId) {
        return sendAck(callback, { ok: false, code: 'NAME_TAKEN', message: '지금 접속 중인 사람이 쓰는 닉네임이에요. 다른 닉네임을 사용해 주세요.' });
      }
    }
    presence.set(socket.id, { playerId, name });
    socket.join(LOBBY_CHANNEL);
    scheduleLobbyBroadcast();
    sendAck(callback, { ok: true, playerId, rooms: roomList(), users: userList(), chat: lobbyChat.slice(-LOBBY_CHAT_LIMIT) });
  });

  socket.on('lobby:leave', (payload = {}, callback) => {
    socket.leave(LOBBY_CHANNEL);
    if (!socket.data.roomCode) presence.delete(socket.id);
    scheduleLobbyBroadcast();
    sendAck(callback, { ok: true });
  });

  socket.on('lobby:refresh', (payload = {}, callback) => {
    if (!presence.has(socket.id)) return sendAck(callback, { ok: false, message: '로비에 입장해 주세요.' });
    sendAck(callback, { ok: true, rooms: roomList(), users: userList() });
  });

  socket.on('lobby:chat', (payload = {}, callback) => {
    const entry = presence.get(socket.id);
    if (!entry || !socket.rooms.has(LOBBY_CHANNEL)) return sendAck(callback, { ok: false, message: '로비에 입장해야 채팅할 수 있어요.' });
    const text = String(payload.text ?? '').normalize('NFC').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CHAT_MAX_LENGTH);
    if (!text) return sendAck(callback, { ok: false, throttled: true });
    const now = Date.now();
    if (now - (socket.data.lastChatAt || 0) < CHAT_COOLDOWN_MS) return sendAck(callback, { ok: false, throttled: true, message: '채팅을 너무 빨리 보내고 있어요.' });
    socket.data.lastChatAt = now;
    chatSeq += 1;
    const message = { id: chatSeq, name: entry.name, text, at: now }; // playerId는 인증 정보라 절대 내보내지 않는다.
    lobbyChat.push(message);
    if (lobbyChat.length > LOBBY_CHAT_LIMIT) lobbyChat.shift();
    io.to(LOBBY_CHANNEL).emit('lobby:chat', message);
    sendAck(callback, { ok: true });
  });

  // ---------- 방 만들기 · 참가 ----------
  socket.on('room:create', (payload = {}, callback) => {
    try {
      if (rooms.size >= MAX_ROOMS) return sendAck(callback, { ok: false, message: '현재 방이 가득 찼어요. 잠시 후 다시 시도해 주세요.' });
      const name = safeName(payload.name);
      if (!name) return sendAck(callback, { ok: false, message: '닉네임은 한글·영문·숫자 2~12자로 입력해 주세요.' });
      const pick = (value, fallback) => (value === undefined || value === null || value === '' ? fallback : Number(value));
      const settings = {
        turnSeconds: pick(payload.turnSeconds, 15),
        maxPlayers: pick(payload.maxPlayers, 8),
        totalSeconds: pick(payload.totalSeconds, DEFAULT_TOTAL_SECONDS),
        rounds: pick(payload.rounds, DEFAULT_ROUNDS),
        allowOneShot: readBool(payload.allowOneShot, true)
      };
      if (![10, 15, 20, 30].includes(settings.turnSeconds)) return sendAck(callback, { ok: false, message: '제한 시간 설정이 올바르지 않아요.' });
      if (![2, 3, 4, 5, 6, 7, 8].includes(settings.maxPlayers)) return sendAck(callback, { ok: false, message: '최대 인원 설정이 올바르지 않아요.' });
      if (!TOTAL_TIME_OPTIONS.includes(settings.totalSeconds)) return sendAck(callback, { ok: false, message: '라운드 총 시간 설정이 올바르지 않아요.' });
      if (!ROUND_OPTIONS.includes(settings.rounds)) return sendAck(callback, { ok: false, message: '라운드 수 설정이 올바르지 않아요.' });
      if (settings.allowOneShot === null) return sendAck(callback, { ok: false, message: '한방 단어 설정이 올바르지 않아요.' });
      const password = safePassword(payload.password);
      if (password === null) return sendAck(callback, { ok: false, message: '비밀번호는 영문·숫자 1~8자로 입력해 주세요.' });
      const title = safeTitle(payload.title, `${name}님의 방`);
      const playerId = safePlayerId(payload.playerId);
      const code = createCode();
      const host = { id: playerId, name, socketId: socket.id, online: true, ready: false, score: 0, roundScore: 0, roundWins: 0, eliminated: false, left: false, lastReactAt: 0 };
      const room = createRoomObject(code, host, { title, password, settings });
      rooms.set(code, room);
      attachPlayer(room, host, socket);
      sendAck(callback, { ok: true, room: roomSnapshot(room), playerId });
    } catch (error) {
      console.error('room:create error', error);
      sendAck(callback, { ok: false, message: '방을 만드는 중 오류가 발생했어요.' });
    }
  });

  socket.on('room:join', (payload = {}, callback) => {
    const code = safeCode(payload.code);
    const name = safeName(payload.name);
    if (!code || code.length !== 5) return sendAck(callback, { ok: false, message: '방 코드는 영문·숫자 5자리예요.' });
    if (!name) return sendAck(callback, { ok: false, message: '닉네임은 한글·영문·숫자 2~12자로 입력해 주세요.' });
    const room = rooms.get(code);
    if (!room) return sendAck(callback, { ok: false, code: 'NOT_FOUND', message: '방을 찾을 수 없어요. 이미 사라졌거나 코드가 달라요.' });
    const password = String(payload.password ?? '').trim().slice(0, 8);
    sendAck(callback, performJoin(socket, room, { name, playerId: safePlayerId(payload.playerId), password }));
  });

  // 빠른 입장: 잠기지 않았고 자리가 있는 대기 중인 방 중 사람이 가장 많은 방으로 들어간다.
  socket.on('room:quick', (payload = {}, callback) => {
    const name = safeName(payload.name);
    if (!name) return sendAck(callback, { ok: false, message: '닉네임은 한글·영문·숫자 2~12자로 입력해 주세요.' });
    const candidates = [...rooms.values()]
      .filter(room => room.state === 'lobby' && !room.password && livePlayers(room).length < room.settings.maxPlayers && orderedPlayers(room).some(player => player.online))
      .sort((a, b) => livePlayers(b).length - livePlayers(a).length || a.number - b.number);
    const room = candidates[0];
    if (!room) return sendAck(callback, { ok: false, code: 'NO_ROOM', message: '지금 바로 들어갈 수 있는 방이 없어요. 새 방을 만들어 보세요!' });
    sendAck(callback, performJoin(socket, room, { name, playerId: safePlayerId(payload.playerId), password: '' }));
  });

  socket.on('room:restore', (payload = {}, callback) => {
    const code = safeCode(payload.code);
    const playerId = String(payload.playerId ?? '');
    const found = findRoomPlayer(playerId, code);
    if (!found) return sendAck(callback, { ok: false, message: '이전 게임방을 복원할 수 없어요.' });
    const { room, player } = found;
    if (player.socketId && player.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(player.socketId);
      if (oldSocket) oldSocket.leave(roomChannel(code));
    }
    attachPlayer(room, player, socket);
    sendAck(callback, { ok: true, room: roomSnapshot(room), playerId });
  });

  socket.on('room:ready', (payload = {}, callback) => {
    const code = safeCode(payload.code);
    const room = rooms.get(code);
    const player = room && playerForSocket(room, String(payload.playerId ?? ''), socket);
    if (!room || !player) return sendAck(callback, { ok: false, message: '방에 연결되어 있지 않아요.' });
    if (room.state !== 'lobby') return sendAck(callback, { ok: false, message: '게임이 시작된 뒤에는 준비 상태를 바꿀 수 없어요.' });
    player.ready = Boolean(payload.ready);
    broadcast(room);
    sendAck(callback, { ok: true });
  });

  socket.on('room:settings', (payload = {}, callback) => {
    const code = safeCode(payload.code);
    const room = rooms.get(code);
    const player = room && playerForSocket(room, String(payload.playerId ?? ''), socket);
    if (!room || !player) return sendAck(callback, { ok: false, message: '방에 연결되어 있지 않아요.' });
    if (player.id !== room.hostId || room.state !== 'lobby') return sendAck(callback, { ok: false, message: '방장만 대기실 설정을 바꿀 수 있어요.' });
    const turnSeconds = Number(payload.turnSeconds);
    const maxPlayers = Number(payload.maxPlayers);
    const totalSeconds = payload.totalSeconds === undefined ? room.settings.totalSeconds : Number(payload.totalSeconds);
    const rounds = payload.rounds === undefined ? room.settings.rounds : Number(payload.rounds);
    const allowOneShot = readBool(payload.allowOneShot, room.settings.allowOneShot !== false);
    if (allowOneShot === null) return sendAck(callback, { ok: false, message: '한방 단어 설정이 올바르지 않아요.' });
    if (![10, 15, 20, 30].includes(turnSeconds)) return sendAck(callback, { ok: false, message: '제한 시간 설정이 올바르지 않아요.' });
    if (!TOTAL_TIME_OPTIONS.includes(totalSeconds)) return sendAck(callback, { ok: false, message: '라운드 총 시간 설정이 올바르지 않아요.' });
    if (!ROUND_OPTIONS.includes(rounds)) return sendAck(callback, { ok: false, message: '라운드 수 설정이 올바르지 않아요.' });
    if (![2, 3, 4, 5, 6, 7, 8].includes(maxPlayers) || maxPlayers < orderedPlayers(room).length) return sendAck(callback, { ok: false, message: '최대 인원은 현재 인원보다 적을 수 없어요.' });
    const title = payload.title === undefined ? room.title : safeTitle(payload.title, room.title);
    let password = room.password;
    if (payload.clearPassword) password = '';
    else if (payload.password !== undefined && String(payload.password).trim() !== '') {
      const next = safePassword(payload.password);
      if (next === null) return sendAck(callback, { ok: false, message: '비밀번호는 영문·숫자 1~8자로 입력해 주세요.' });
      password = next;
    }
    room.settings = { turnSeconds, maxPlayers, totalSeconds, rounds, allowOneShot };
    room.title = title;
    room.password = password;
    broadcast(room);
    sendAck(callback, { ok: true });
  });

  socket.on('room:start', (payload = {}, callback) => {
    const code = safeCode(payload.code);
    const room = rooms.get(code);
    const player = room && playerForSocket(room, String(payload.playerId ?? ''), socket);
    if (!room || !player) return sendAck(callback, { ok: false, message: '방에 연결되어 있지 않아요.' });
    if (player.id !== room.hostId) return sendAck(callback, { ok: false, message: '방장만 게임을 시작할 수 있어요.' });
    const players = orderedPlayers(room);
    if (room.state !== 'lobby') return sendAck(callback, { ok: false, message: '이미 게임이 진행 중이에요.' });
    if (players.length < 2) return sendAck(callback, { ok: false, message: '친구가 한 명 이상 참가해야 시작할 수 있어요.' });
    if (players.some(item => !item.online || !item.ready)) return sendAck(callback, { ok: false, message: '모든 플레이어가 접속하고 준비를 마쳐야 해요.' });
    startMatch(room);
    broadcast(room);
    sendAck(callback, { ok: true });
  });

  socket.on('game:submit', (payload = {}, callback) => {
    const code = safeCode(payload.code);
    const room = rooms.get(code);
    const playerId = String(payload.playerId ?? '');
    const player = room && playerForSocket(room, playerId, socket);
    if (!room || !player) return sendAck(callback, { ok: false, message: '방 연결이 끊어졌어요. 다시 접속해 주세요.' });
    if (room.state !== 'playing') return sendAck(callback, { ok: false, message: '현재 게임 중이 아니에요.' });
    if (room.currentPlayerId !== player.id) return sendAck(callback, { ok: false, message: '아직 내 차례가 아니에요.' });
    if (Date.now() >= room.turnEndsAt) return sendAck(callback, { ok: false, message: '입력 시간이 끝났어요.' });
    const result = validateWord(payload.word, dictionary, room.usedWords, room.lastSyllable, { allowOneShot: room.settings.allowOneShot !== false, startIndex });
    if (!result.ok) return sendAck(callback, { ok: false, code: result.code, message: result.message });
    const word = result.word;
    const now = Date.now();
    const usedMission = hasMissionLetter(word, room.mission) ? room.mission : '';
    const missions = countMissionLetters(word, room.mission);
    const chain = room.words.filter(item => item.type === 'word').length + 1;
    const timeRatio = room.turnDurationMs > 0 ? (room.turnEndsAt - now) / room.turnDurationMs : 0;
    const points = calcScore({ missions, length: word.length, chain, timeRatio });
    room.usedWords.add(word);
    room.lastSyllable = word[word.length - 1];
    player.score += points;
    player.roundScore += points;
    const entry = { type: 'word', word, playerId: player.id, playerName: player.name, points, missions, chain, elapsedMs: now - room.turnStartedAt, at: now };
    // 미션 글자가 사용되면 즉시 새 미션 글자를 제시한다. (방금 쓴 글자는 제외)
    if (usedMission) {
      room.mission = pickMissionLetter(missionPool, usedMission);
      room.missionSeq += 1;
      room.missionChange = { seq: room.missionSeq, from: usedMission, to: room.mission, playerName: player.name, word };
      entry.missionFrom = usedMission;
      entry.missionTo = room.mission;
    }
    room.words.push(entry);
    room.matchWords.push(entry);
    room.matchWordCount += 1;
    const next = findNextActiveIndex(room, room.turnIndex);
    if (next < 0 || activePlayers(room).length <= 1) {
      endRound(room, 'last');
    } else {
      room.turnCount += 1;
      startTurn(room, next);
      broadcast(room);
    }
    sendAck(callback, { ok: true, word, points, missions, chain, newMission: usedMission ? room.mission : '' });
  });

  socket.on('game:rematch', (payload = {}, callback) => {
    const code = safeCode(payload.code);
    const room = rooms.get(code);
    const player = room && playerForSocket(room, String(payload.playerId ?? ''), socket);
    if (!room || !player) return sendAck(callback, { ok: false, message: '방에 연결되어 있지 않아요.' });
    if (player.id !== room.hostId) return sendAck(callback, { ok: false, message: '방장만 다시 시작할 수 있어요.' });
    if (room.state !== 'finished') return sendAck(callback, { ok: false, message: '경기가 끝난 뒤에 다시 시작할 수 있어요.' });
    // 중간에 나간 사람은 새 경기에 데려가지 않는다.
    for (const item of orderedPlayers(room)) {
      if (item.left) {
        room.players.delete(item.id);
        room.playerOrder = room.playerOrder.filter(id => id !== item.id);
      }
    }
    const players = orderedPlayers(room);
    if (players.length < 2 || players.some(item => !item.online)) return sendAck(callback, { ok: false, message: '모든 친구가 다시 접속해야 시작할 수 있어요.' });
    clearTurnTimer(room);
    players.forEach(item => { item.ready = true; });
    startMatch(room);
    broadcast(room);
    sendAck(callback, { ok: true });
  });

  socket.on('room:leave', (payload = {}, callback) => {
    const code = safeCode(payload.code);
    const room = rooms.get(code);
    const player = room && playerForSocket(room, String(payload.playerId ?? ''), socket);
    if (!room || !player) return sendAck(callback, { ok: true });
    socket.leave(roomChannel(code));
    socket.data.roomCode = null;
    player.online = false;
    player.socketId = null;
    if (room.state === 'lobby') {
      room.players.delete(player.id);
      room.playerOrder = room.playerOrder.filter(id => id !== player.id);
      if (room.hostId === player.id) room.hostId = room.playerOrder[0] || null;
      if (room.playerOrder.length === 0) {
        removeRoom(room);
      } else {
        broadcast(room);
      }
    } else if (room.state === 'playing' || room.state === 'intermission') {
      player.eliminated = true;
      player.left = true;
      if (room.hostId === player.id) {
        const nextHost = livePlayers(room).find(candidate => candidate.online) || livePlayers(room)[0];
        room.hostId = nextHost ? nextHost.id : null;
      }
      room.words.push({ type: 'system', text: `${player.name}님이 게임에서 나갔습니다.`, at: Date.now() });
      if (livePlayers(room).length < 2) {
        if (room.state === 'playing') endRound(room, 'last'); else finishMatch(room);
      } else if (room.state === 'intermission') {
        broadcast(room);
      } else if (room.currentPlayerId === player.id) {
        const next = findNextActiveIndex(room, room.turnIndex);
        if (next < 0 || activePlayers(room).length <= 1) endRound(room, 'last');
        else { room.turnCount += 1; startTurn(room, next); broadcast(room); }
      } else if (activePlayers(room).length <= 1) endRound(room, 'last');
      else broadcast(room);
    } else {
      room.players.delete(player.id);
      room.playerOrder = room.playerOrder.filter(id => id !== player.id);
      if (room.hostId === player.id) room.hostId = room.playerOrder[0] || null;
      broadcast(room);
    }
    if (rooms.get(code) === room) scheduleIdleCleanup(room);
    scheduleLobbyBroadcast();
    sendAck(callback, { ok: true });
  });

  socket.on('game:react', (payload = {}, callback) => {
    const code = safeCode(payload.code);
    const room = rooms.get(code);
    const player = room && playerForSocket(room, String(payload.playerId ?? ''), socket);
    if (!room || !player) return sendAck(callback, { ok: false, message: '방에 연결되어 있지 않아요.' });
    if (room.state === 'lobby') return sendAck(callback, { ok: false, message: '게임이 시작된 뒤에 보낼 수 있어요.' });
    const emoji = String(payload.emoji ?? '');
    if (!REACTION_EMOJIS.includes(emoji)) return sendAck(callback, { ok: false, message: '보낼 수 없는 반응이에요.' });
    const now = Date.now();
    if (now - player.lastReactAt < REACTION_COOLDOWN_MS) return sendAck(callback, { ok: false, throttled: true });
    player.lastReactAt = now;
    io.to(roomChannel(room.code)).emit('game:reaction', { playerId: player.id, name: player.name, emoji });
    sendAck(callback, { ok: true });
  });

  socket.on('disconnect', () => {
    presence.delete(socket.id);
    scheduleLobbyBroadcast();
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) return;
    const room = rooms.get(code);
    const player = room && room.players.get(playerId);
    if (!player || player.socketId !== socket.id) return;
    player.online = false;
    player.socketId = null;
    broadcast(room);
    scheduleIdleCleanup(room);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`WORDLINK v${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`Dictionary: ${dictionary.size.toLocaleString('en-US')} words`);
});

function shutdown() {
  for (const room of rooms.values()) { clearTurnTimer(room); clearRoundTimers(room); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
