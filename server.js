'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Server } = require('socket.io');
const { validateWord, normalizeWord } = require('./game-rules');

// The GitHub upload currently has a flattened layout: all app files live at the repository root.
const ROOT = __dirname;
const PUBLIC = ROOT;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_ROOMS = 500;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rawWords = JSON.parse(fs.readFileSync(path.join(ROOT, 'words.json'), 'utf8'));
const dictionary = new Set(rawWords.map(normalizeWord));

const publicFiles = new Set(['/index.html', '/styles.css', '/client.js']);

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
function roomSnapshot(room) {
  const current = currentPlayer(room);
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    settings: { ...room.settings },
    players: orderedPlayers(room).map(player => ({
      id: player.id,
      name: player.name,
      online: player.online,
      ready: player.ready,
      score: player.score,
      eliminated: player.eliminated,
      isHost: player.id === room.hostId
    })),
    currentPlayerId: room.currentPlayerId,
    currentPlayerName: current ? current.name : '',
    turnEndsAt: room.turnEndsAt,
    turnCount: room.turnCount,
    lastSyllable: room.lastSyllable,
    words: room.words.slice(-80),
    winnerId: room.winnerId,
    winnerName: room.winnerId && getPlayer(room, room.winnerId) ? getPlayer(room, room.winnerId).name : ''
  };
}
function broadcast(room) { io.to(roomChannel(room.code)).emit('room:update', roomSnapshot(room)); }
function notice(socket, message, type = 'info') { socket.emit('notice', { message, type }); }
function finishGame(room) {
  clearTurnTimer(room);
  room.state = 'finished';
  room.turnEndsAt = null;
  const remaining = activePlayers(room);
  room.winnerId = remaining.length === 1 ? remaining[0].id : null;
  room.currentPlayerId = null;
  room.words.push({ type: 'system', text: room.winnerId ? `${remaining[0].name}님이 최종 승리했습니다.` : '게임이 종료되었습니다.', at: Date.now() });
  broadcast(room);
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    if (rooms.get(room.code) === room) rooms.delete(room.code);
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
  if (!player || player.eliminated) return finishGame(room);
  clearTurnTimer(room);
  room.turnIndex = index;
  room.currentPlayerId = playerId;
  room.turnEndsAt = Date.now() + room.settings.turnSeconds * 1000;
  const token = room.turnToken;
  const timer = setTimeout(() => {
    if (rooms.get(room.code) !== room || room.state !== 'playing' || room.turnToken !== token || room.currentPlayerId !== playerId) return;
    const timedOut = room.players.get(playerId);
    if (timedOut && !timedOut.eliminated) {
      timedOut.eliminated = true;
      room.words.push({ type: 'system', text: `${timedOut.name}님이 시간 초과로 탈락했습니다.`, at: Date.now() });
      if (room.hostId === timedOut.id) {
        const nextHost = activePlayers(room).find(candidate => candidate.online) || activePlayers(room)[0];
        room.hostId = nextHost ? nextHost.id : null;
      }
    }
    const next = findNextActiveIndex(room, room.turnIndex);
    if (next < 0 || activePlayers(room).length <= 1) return finishGame(room);
    room.turnCount += 1;
    startTurn(room, next);
    broadcast(room);
  }, room.settings.turnSeconds * 1000);
  timers.set(room.code, timer);
  timer.unref?.();
}
function createRoomObject(code, host) {
  const now = Date.now();
  return {
    code,
    hostId: host.id,
    state: 'lobby',
    settings: { turnSeconds: 15, maxPlayers: 8 },
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
    winnerId: null,
    createdAt: now,
    cleanupTimer: null
  };
}
function attachPlayer(room, player, socket) {
  player.socketId = socket.id;
  player.online = true;
  socket.data.playerId = player.id;
  socket.data.roomCode = room.code;
  socket.join(roomChannel(room.code));
  broadcast(room);
}
function findRoomPlayer(playerId, code) {
  const room = rooms.get(code);
  if (!room) return null;
  const player = room.players.get(playerId);
  return player ? { room, player } : null;
}

io.on('connection', socket => {
  socket.emit('server:hello', { dictionarySize: dictionary.size, version: '0.1.0' });

  socket.on('room:create', (payload = {}, callback) => {
    try {
      if (rooms.size >= MAX_ROOMS) return sendAck(callback, { ok: false, message: '현재 방이 가득 찼어요. 잠시 후 다시 시도해 주세요.' });
      const name = safeName(payload.name);
      if (!name) return sendAck(callback, { ok: false, message: '닉네임은 한글·영문·숫자 2~12자로 입력해 주세요.' });
      const playerId = safePlayerId(payload.playerId);
      const code = createCode();
      const host = { id: playerId, name, socketId: socket.id, online: true, ready: false, score: 0, eliminated: false };
      const room = createRoomObject(code, host);
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
    if (!room) return sendAck(callback, { ok: false, message: '방을 찾을 수 없어요. 코드를 확인해 주세요.' });
    const playerId = safePlayerId(payload.playerId);
    const existing = room.players.get(playerId);
    if (existing) {
      if (existing.socketId && existing.socketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(existing.socketId);
        if (oldSocket) oldSocket.leave(roomChannel(code));
      }
      existing.name = name;
      attachPlayer(room, existing, socket);
      return sendAck(callback, { ok: true, room: roomSnapshot(room), playerId });
    }
    if (room.state !== 'lobby') return sendAck(callback, { ok: false, message: '게임이 이미 시작된 방에는 새로 참가할 수 없어요.' });
    if (orderedPlayers(room).length >= room.settings.maxPlayers) return sendAck(callback, { ok: false, message: '방 인원이 가득 찼어요.' });
    const player = { id: playerId, name, socketId: socket.id, online: true, ready: false, score: 0, eliminated: false };
    room.players.set(playerId, player);
    room.playerOrder.push(playerId);
    attachPlayer(room, player, socket);
    sendAck(callback, { ok: true, room: roomSnapshot(room), playerId });
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
    if (![10, 15, 20, 30].includes(turnSeconds)) return sendAck(callback, { ok: false, message: '제한 시간 설정이 올바르지 않아요.' });
    if (![2, 3, 4, 5, 6, 7, 8].includes(maxPlayers) || maxPlayers < orderedPlayers(room).length) return sendAck(callback, { ok: false, message: '최대 인원은 현재 인원보다 적을 수 없어요.' });
    room.settings = { turnSeconds, maxPlayers };
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
    room.state = 'playing';
    room.words = [];
    room.usedWords.clear();
    room.lastSyllable = '';
    room.turnCount = 1;
    room.winnerId = null;
    players.forEach(item => { item.score = 0; item.eliminated = false; });
    startTurn(room, 0);
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
    const result = validateWord(payload.word, dictionary, room.usedWords, room.lastSyllable);
    if (!result.ok) return sendAck(callback, { ok: false, code: result.code, message: result.message });
    const word = result.word;
    room.usedWords.add(word);
    room.lastSyllable = word[word.length - 1];
    player.score += word.length * 10;
    room.words.push({ type: 'word', word, playerId: player.id, playerName: player.name, points: word.length * 10, at: Date.now() });
    const next = findNextActiveIndex(room, room.turnIndex);
    if (next < 0 || activePlayers(room).length <= 1) {
      finishGame(room);
    } else {
      room.turnCount += 1;
      startTurn(room, next);
      broadcast(room);
    }
    sendAck(callback, { ok: true, word, points: word.length * 10 });
  });

  socket.on('game:rematch', (payload = {}, callback) => {
    const code = safeCode(payload.code);
    const room = rooms.get(code);
    const player = room && playerForSocket(room, String(payload.playerId ?? ''), socket);
    if (!room || !player) return sendAck(callback, { ok: false, message: '방에 연결되어 있지 않아요.' });
    if (player.id !== room.hostId) return sendAck(callback, { ok: false, message: '방장만 다시 시작할 수 있어요.' });
    const players = orderedPlayers(room);
    if (players.length < 2 || players.some(item => !item.online)) return sendAck(callback, { ok: false, message: '모든 친구가 다시 접속해야 시작할 수 있어요.' });
    clearTurnTimer(room);
    if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
    room.state = 'playing';
    room.words = [];
    room.usedWords.clear();
    room.lastSyllable = '';
    room.turnCount = 1;
    room.winnerId = null;
    players.forEach(item => { item.score = 0; item.eliminated = false; item.ready = true; });
    startTurn(room, 0);
    broadcast(room);
    sendAck(callback, { ok: true });
  });

  socket.on('room:leave', (payload = {}, callback) => {
    const code = safeCode(payload.code);
    const room = rooms.get(code);
    const player = room && playerForSocket(room, String(payload.playerId ?? ''), socket);
    if (!room || !player) return sendAck(callback, { ok: true });
    socket.leave(roomChannel(code));
    player.online = false;
    player.socketId = null;
    if (room.state === 'lobby') {
      room.players.delete(player.id);
      room.playerOrder = room.playerOrder.filter(id => id !== player.id);
      if (room.hostId === player.id) room.hostId = room.playerOrder[0] || null;
      if (room.playerOrder.length === 0) {
        rooms.delete(code);
      } else {
        broadcast(room);
      }
    } else if (room.state === 'playing') {
      player.eliminated = true;
      if (room.hostId === player.id) {
        const nextHost = activePlayers(room).find(candidate => candidate.online) || activePlayers(room)[0];
        room.hostId = nextHost ? nextHost.id : null;
      }
      room.words.push({ type: 'system', text: `${player.name}님이 게임에서 나갔습니다.`, at: Date.now() });
      if (room.currentPlayerId === player.id) {
        const next = findNextActiveIndex(room, room.turnIndex);
        if (next < 0 || activePlayers(room).length <= 1) finishGame(room);
        else { room.turnCount += 1; startTurn(room, next); broadcast(room); }
      } else if (activePlayers(room).length <= 1) finishGame(room);
      else broadcast(room);
    } else {
      room.players.delete(player.id);
      room.playerOrder = room.playerOrder.filter(id => id !== player.id);
      if (room.hostId === player.id) room.hostId = room.playerOrder[0] || null;
      broadcast(room);
    }
    sendAck(callback, { ok: true });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const playerId = socket.data.playerId;
    if (!code || !playerId) return;
    const room = rooms.get(code);
    const player = room && room.players.get(playerId);
    if (!player || player.socketId !== socket.id) return;
    player.online = false;
    player.socketId = null;
    broadcast(room);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`WORDLINK v0.1.0 listening on http://${HOST}:${PORT}`);
  console.log(`Dictionary: ${dictionary.size.toLocaleString('en-US')} words`);
});

function shutdown() {
  for (const room of rooms.values()) clearTurnTimer(room);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
