'use strict';
// 소셜 로그인 (Google · GitHub · Discord) — 외부 패키지 없이 OAuth 2.0 authorization code 흐름만 구현한다.
//
// 환경변수 (설정된 제공자만 로그인 버튼이 나타난다)
//   GOOGLE_CLIENT_ID  / GOOGLE_CLIENT_SECRET
//   GITHUB_CLIENT_ID  / GITHUB_CLIENT_SECRET
//   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET
//   SESSION_SECRET    세션 쿠키 서명·계정 ID 파생용 비밀값 (운영 필수. 없으면 재시작할 때마다 바뀜)
//   PUBLIC_URL        배포 주소 (예: https://wordlink.onrender.com). Render에서는 RENDER_EXTERNAL_URL을 자동 사용
//
// Redirect URI는 각 제공자 콘솔에 `${PUBLIC_URL}/auth/<google|github|discord>/callback` 으로 등록한다.

const crypto = require('node:crypto');

const SESSION_COOKIE = 'wl_session';
const STATE_COOKIE = 'wl_oauth';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const PROVIDERS = {
  google: {
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid profile',
    extraAuthorize: {},
    profile: raw => ({ id: raw.sub, name: raw.name || raw.given_name || '' })
  },
  github: {
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scope: '',
    extraAuthorize: {},
    profile: raw => ({ id: raw.id, name: raw.login || raw.name || '' })
  },
  discord: {
    label: 'Discord',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userUrl: 'https://discord.com/api/users/@me',
    scope: 'identify',
    extraAuthorize: { prompt: 'none' },
    profile: raw => ({ id: raw.id, name: raw.global_name || raw.username || '' })
  }
};

// 게임 닉네임 규칙(한글·영문·숫자·_·- 2~12자)에 맞게 소셜 이름을 다듬는다. 쓸 수 없으면 ''.
function suggestNickname(value) {
  const name = String(value ?? '').normalize('NFC').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 12);
  return /^[\p{L}\p{N}_-]{2,12}$/u.test(name) ? name : '';
}

function b64url(buffer) { return Buffer.from(buffer).toString('base64url'); }

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key && !(key in out)) out[key] = part.slice(index + 1).trim();
  }
  return out;
}

// 로그인 후 돌아갈 곳. 같은 사이트의 `/` 또는 `/?room=XXXXX` 형태만 허용한다(오픈 리디렉트 방지).
function safeNext(value) {
  const next = String(value ?? '');
  return /^\/(\?[A-Za-z0-9=&_-]{0,40})?$/.test(next) ? next : '/';
}

function createAuth(options = {}) {
  const env = options.env || process.env;
  const providers = options.providers || PROVIDERS;
  const doFetch = options.fetch || fetch;

  let secret = env.SESSION_SECRET;
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    if (options.warn !== false) console.warn('[auth] SESSION_SECRET이 없어 임시 비밀값을 사용합니다. 서버가 재시작되면 로그인 상태가 풀리니 운영에서는 꼭 설정해 주세요.');
  }
  const configuredBase = String(env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

  const enabled = new Map();
  for (const [id, provider] of Object.entries(providers)) {
    const key = id.toUpperCase();
    const clientId = env[`${key}_CLIENT_ID`];
    const clientSecret = env[`${key}_CLIENT_SECRET`];
    if (clientId && clientSecret) enabled.set(id, { ...provider, id, clientId, clientSecret });
  }

  function sign(payload) {
    const body = b64url(JSON.stringify(payload));
    const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }
  function verify(token) {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    let given;
    try { given = Buffer.from(mac, 'base64url'); } catch { return null; }
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return payload && typeof payload.exp === 'number' && payload.exp > Date.now() ? payload : null;
    } catch { return null; }
  }

  // 계정 → playerId. 재접속 인증 정보로도 쓰이므로 HMAC으로 만들어 제공자 ID를 알아도 추측할 수 없게 한다.
  function playerIdFor(provider, accountId) {
    return `u-${crypto.createHmac('sha256', secret).update(`${provider}:${accountId}`).digest('hex').slice(0, 40)}`;
  }

  // 전적 저장용 키. playerId와 달리 SESSION_SECRET에 의존하지 않아, 비밀값을 바꿔도 같은 계정의 기록이 이어진다.
  // 서버 안에서만 쓰고 클라이언트·다른 플레이어에게는 내보내지 않는다.
  function statsKeyFor(provider, accountId) {
    return `s-${crypto.createHash('sha256').update(`wordlink-stats:${provider}:${accountId}`).digest('hex').slice(0, 32)}`;
  }

  function sessionFromCookieHeader(header) {
    const payload = verify(parseCookies(header)[SESSION_COOKIE]);
    if (!payload || !enabled.has(payload.p)) return null;
    return { provider: payload.p, providerLabel: enabled.get(payload.p).label, suggestedName: payload.n || '', playerId: playerIdFor(payload.p, payload.a), statsKey: statsKeyFor(payload.p, payload.a) };
  }

  function baseUrl(req) {
    if (configuredBase) return configuredBase;
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
    return `${proto}://${req.headers.host}`;
  }
  const isSecure = req => baseUrl(req).startsWith('https://');
  function cookie(req, name, value, maxAgeMs) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${isSecure(req) ? '; Secure' : ''}`;
  }
  function clearCookie(req, name) { return cookie(req, name, '', 0); }

  function redirect(res, location, cookies = []) {
    const headers = { Location: location, 'Cache-Control': 'no-store' };
    if (cookies.length) headers['Set-Cookie'] = cookies;
    res.writeHead(302, headers);
    res.end();
  }
  function json(res, status, body, cookies = []) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (cookies.length) headers['Set-Cookie'] = cookies;
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  async function postForm(url, params, headers = {}) {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`token endpoint ${response.status}`);
    return response.json();
  }
  async function getJson(url, headers) {
    const response = await doFetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`profile endpoint ${response.status}`);
    return response.json();
  }

  function startLogin(req, res, provider, url) {
    const nonce = crypto.randomBytes(24).toString('base64url');
    const next = safeNext(url.searchParams.get('next'));
    const redirectUri = `${baseUrl(req)}/auth/${provider.id}/callback`;
    const query = new URLSearchParams({ client_id: provider.clientId, redirect_uri: redirectUri, response_type: 'code', state: nonce, ...provider.extraAuthorize });
    if (provider.scope) query.set('scope', provider.scope);
    const stateCookie = sign({ s: nonce, p: provider.id, next, exp: Date.now() + STATE_MS });
    redirect(res, `${provider.authorizeUrl}?${query}`, [cookie(req, STATE_COOKIE, stateCookie, STATE_MS)]);
  }

  async function finishLogin(req, res, provider, url) {
    const saved = verify(parseCookies(req.headers.cookie)[STATE_COOKIE]);
    const fail = (code, next = '/') => redirect(res, `${next.split('?')[0]}?auth_error=${code}`, [clearCookie(req, STATE_COOKIE)]);
    if (!saved || saved.p !== provider.id) return fail('state');
    const next = safeNext(saved.next);
    if (url.searchParams.get('error')) return fail('denied', next); // 사용자가 동의 화면에서 취소
    const given = Buffer.from(String(url.searchParams.get('state') || ''));
    const wanted = Buffer.from(saved.s);
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return fail('state', next);
    const code = url.searchParams.get('code');
    if (!code) return fail('denied', next);
    try {
      const token = await postForm(provider.tokenUrl, {
        grant_type: 'authorization_code', code, redirect_uri: `${baseUrl(req)}/auth/${provider.id}/callback`,
        client_id: provider.clientId, client_secret: provider.clientSecret
      });
      if (!token.access_token) throw new Error('no access_token');
      const raw = await getJson(provider.userUrl, { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'wordlink-game' });
      const profile = provider.profile(raw);
      if (profile.id === undefined || profile.id === null || profile.id === '') throw new Error('no account id');
      const session = sign({ p: provider.id, a: String(profile.id), n: suggestNickname(profile.name), exp: Date.now() + SESSION_MS });
      redirect(res, next, [cookie(req, SESSION_COOKIE, session, SESSION_MS), clearCookie(req, STATE_COOKIE)]);
    } catch (error) {
      console.error(`[auth] ${provider.id} 로그인 실패:`, error.message);
      fail('failed', next);
    }
  }

  // 처리했으면 true. /auth/ 로 시작하지 않는 요청은 건드리지 않는다.
  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/auth/')) return false;
    const parts = url.pathname.split('/').filter(Boolean); // ['auth', ...]

    if (parts.length === 2 && parts[1] === 'me' && req.method === 'GET') {
      const user = sessionFromCookieHeader(req.headers.cookie);
      json(res, 200, {
        providers: [...enabled.values()].map(p => ({ id: p.id, label: p.label })),
        user: user ? { provider: user.provider, providerLabel: user.providerLabel, suggestedName: user.suggestedName } : null // playerId는 내보내지 않는다.
      });
      return true;
    }
    if (parts.length === 2 && parts[1] === 'logout' && req.method === 'POST') {
      json(res, 200, { ok: true }, [clearCookie(req, SESSION_COOKIE)]);
      return true;
    }
    const provider = enabled.get(parts[1]);
    if (!provider || req.method !== 'GET') { res.writeHead(404); res.end('Not found'); return true; }
    if (parts.length === 2) { startLogin(req, res, provider, url); return true; }
    if (parts.length === 3 && parts[2] === 'callback') { finishLogin(req, res, provider, url); return true; }
    res.writeHead(404); res.end('Not found');
    return true;
  }

  return { handle, sessionFromCookieHeader, playerIdFor, statsKeyFor, enabledProviders: () => [...enabled.keys()] };
}

module.exports = { createAuth, suggestNickname, safeNext, parseCookies, PROVIDERS };
