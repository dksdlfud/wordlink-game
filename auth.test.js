'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAuth, suggestNickname, safeNext } = require('./auth');

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const readBody = req => new Promise(resolve => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => resolve(b)); });
const cookiesFrom = res => (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ');

// 가짜 OAuth 제공자 + 가짜 게임 서버를 띄워 로그인 전체 흐름을 검증한다.
async function setup(profile = { sub: 'g-123', name: '홍 길동!' }) {
  const mock = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/token') {
      const body = new URLSearchParams(await readBody(req));
      res.setHeader('Content-Type', 'application/json');
      if (body.get('code') !== 'good-code' || body.get('client_secret') !== 'sec') { res.statusCode = 400; return res.end('{}'); }
      return res.end(JSON.stringify({ access_token: 'tok' }));
    }
    if (url.pathname === '/user') {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'Bearer tok') { res.statusCode = 401; return res.end('{}'); }
      return res.end(JSON.stringify(profile));
    }
    res.statusCode = 404; res.end();
  });
  const providers = {
    google: {
      label: 'Google', authorizeUrl: `${mock.base}/authorize`, tokenUrl: `${mock.base}/token`, userUrl: `${mock.base}/user`,
      scope: 'openid profile', extraAuthorize: {}, profile: raw => ({ id: raw.sub, name: raw.name })
    },
    github: { label: 'GitHub', authorizeUrl: `${mock.base}/authorize`, tokenUrl: `${mock.base}/token`, userUrl: `${mock.base}/user`, scope: '', extraAuthorize: {}, profile: raw => ({ id: raw.id, name: raw.login }) }
  };
  const auth = createAuth({ providers, warn: false, env: { SESSION_SECRET: 's3cret', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' } });
  const app = await listen((req, res) => { if (!auth.handle(req, res)) { res.statusCode = 404; res.end(); } });
  return { auth, app, mock, close: () => { app.server.close(); mock.server.close(); } };
}
const get = (url, cookie, init = {}) => fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {}, ...init });

test('설정된 제공자만 노출되고, 로그인 전에는 user가 없다', async () => {
  const t = await setup();
  const me = await (await get(`${t.app.base}/auth/me`)).json();
  assert.deepEqual(me.providers, [{ id: 'google', label: 'Google' }]); // github은 키가 없어 숨김
  assert.equal(me.user, null);
  assert.equal((await get(`${t.app.base}/auth/github`)).status, 404);
  t.close();
});

test('로그인 전체 흐름: 인가 → 콜백 → 세션 쿠키 → 계정 playerId', async () => {
  const t = await setup();
  const start = await get(`${t.app.base}/auth/google?next=${encodeURIComponent('/?room=AB2CD')}`);
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location'));
  assert.equal(authorize.searchParams.get('client_id'), 'cid');
  assert.equal(authorize.searchParams.get('redirect_uri'), `${t.app.base}/auth/google/callback`);
  const stateCookie = cookiesFrom(start);
  assert.match(start.headers.getSetCookie()[0], /HttpOnly/);

  const done = await get(`${t.app.base}/auth/google/callback?code=good-code&state=${authorize.searchParams.get('state')}`, stateCookie);
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/?room=AB2CD'); // 초대 링크 유지
  const session = cookiesFrom(done);
  assert.match(session, /wl_session=/);

  const me = await (await get(`${t.app.base}/auth/me`, session)).json();
  assert.equal(me.user.provider, 'google');
  assert.equal(me.user.suggestedName, '홍길동'); // 공백·특수문자 제거
  assert.equal(JSON.stringify(me).includes('g-123'), false); // 계정 ID 비노출

  const info = t.auth.sessionFromCookieHeader(session);
  assert.match(info.playerId, /^u-[0-9a-f]{40}$/);
  assert.equal(info.playerId, t.auth.playerIdFor('google', 'g-123')); // 같은 계정이면 항상 같은 ID
  assert.notEqual(info.playerId, t.auth.playerIdFor('google', 'g-124'));

  const out = await get(`${t.app.base}/auth/logout`, session, { method: 'POST' });
  assert.match(out.headers.getSetCookie()[0], /Max-Age=0/);
  t.close();
});

test('state가 다르거나 쿠키가 없거나 위조되면 로그인에 실패한다', async () => {
  const t = await setup();
  const start = await get(`${t.app.base}/auth/google`);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const stateCookie = cookiesFrom(start);

  const noCookie = await get(`${t.app.base}/auth/google/callback?code=good-code&state=${state}`);
  assert.match(noCookie.headers.get('location'), /auth_error=state/);
  const badState = await get(`${t.app.base}/auth/google/callback?code=good-code&state=nope`, stateCookie);
  assert.match(badState.headers.get('location'), /auth_error=state/);
  assert.equal(cookiesFrom(badState).includes('wl_session'), false);
  const denied = await get(`${t.app.base}/auth/google/callback?error=access_denied&state=${state}`, stateCookie);
  assert.match(denied.headers.get('location'), /auth_error=denied/);
  const badCode = await get(`${t.app.base}/auth/google/callback?code=bad&state=${state}`, stateCookie);
  assert.match(badCode.headers.get('location'), /auth_error=failed/);

  const forged = 'wl_session=' + Buffer.from(JSON.stringify({ p: 'google', a: 'x', n: 'hack', exp: Date.now() + 1e9 })).toString('base64url') + '.AAAA';
  assert.equal(t.auth.sessionFromCookieHeader(forged), null);
  t.close();
});

test('다른 비밀값으로 서명된 세션은 거부된다', async () => {
  const t = await setup();
  const start = await get(`${t.app.base}/auth/google`);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const done = await get(`${t.app.base}/auth/google/callback?code=good-code&state=${state}`, cookiesFrom(start));
  const session = cookiesFrom(done);
  const other = createAuth({ providers: { google: { label: 'Google' } }, warn: false, env: { SESSION_SECRET: 'different', GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' } });
  assert.equal(other.sessionFromCookieHeader(session), null);
  t.close();
});

test('닉네임 다듬기와 next 검증', () => {
  assert.equal(suggestNickname('홍 길동!'), '홍길동');
  assert.equal(suggestNickname('a'), '');
  assert.equal(suggestNickname('😀😀'), '');
  assert.equal(suggestNickname('abcdefghijklmnop'), 'abcdefghijkl');
  assert.equal(safeNext('/?room=AB2CD'), '/?room=AB2CD');
  assert.equal(safeNext('//evil.com'), '/');
  assert.equal(safeNext('https://evil.com'), '/');
  assert.equal(safeNext('/\\evil'), '/');
});
