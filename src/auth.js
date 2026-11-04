// Browser login: passkeys (WebAuthn) + server-side sessions in SQLite. The access token stays the machine credential
// (agents, swarm-mcp.js: Authorization: Bearer); a browser can sign in with it only while no passkey exists.
import crypto from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { APP_NAME } from './product.js';
import { env } from './util.js';

const COOKIE = 'halay_session';
const OLD_COOKIE = 'swarm_session'; // the name before the rename: still accepted (so nobody is signed out), cleared at the next sign-in or sign-out
const SESSION_MS = 30 * 24 * 3600 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;
const RP_NAME = APP_NAME; // shown by the passkey dialog
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function createAuth({ db, token, publicUrl, localToken = null }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT, name TEXT NOT NULL, rp_id TEXT, device_type TEXT, backed_up INTEGER, created_at INTEGER, last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER, expires_at INTEGER NOT NULL, last_seen_at INTEGER, via TEXT, ua TEXT
    );
  `);
  const q = {
    user: db.prepare('SELECT * FROM users ORDER BY id LIMIT 1'),
    addUser: db.prepare('INSERT INTO users (name, handle, created_at) VALUES (?,?,?)'),
    keys: db.prepare('SELECT * FROM passkeys WHERE user_id=? ORDER BY created_at'),
    allKeys: db.prepare('SELECT COUNT(*) n FROM passkeys'),
    key: db.prepare('SELECT * FROM passkeys WHERE id=?'),
    addKey: db.prepare('INSERT INTO passkeys (id,user_id,public_key,counter,transports,name,rp_id,device_type,backed_up,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'),
    useKey: db.prepare('UPDATE passkeys SET counter=?, last_used_at=? WHERE id=?'),
    renameKey: db.prepare('UPDATE passkeys SET name=? WHERE id=? AND user_id=?'),
    delKey: db.prepare('DELETE FROM passkeys WHERE id=? AND user_id=?'),
    addSess: db.prepare('INSERT INTO sessions (id_hash,user_id,created_at,expires_at,last_seen_at,via,ua) VALUES (?,?,?,?,?,?,?)'),
    sess: db.prepare('SELECT * FROM sessions WHERE id_hash=?'),
    touch: db.prepare('UPDATE sessions SET last_seen_at=?, expires_at=? WHERE id_hash=?'),
    delSess: db.prepare('DELETE FROM sessions WHERE id_hash=?'),
    delOtherSess: db.prepare('DELETE FROM sessions WHERE id_hash<>?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at<?'),
  };
  const owner = () => q.user.get() || (q.addUser.run('owner', crypto.randomBytes(32).toString('base64url'), Date.now()), q.user.get());
  const hasKeys = () => q.allKeys.get().n > 0;

  // HALAY_RESET_PASSKEYS=1: forget every passkey and session at startup, so the first-run setup / token sign-in is open again
  if (env('RESET_PASSKEYS') === '1') {
    db.exec('DELETE FROM passkeys; DELETE FROM sessions;');
    console.log('auth: HALAY_RESET_PASSKEYS is set: all passkeys and browser sessions were removed. Unset it again after this start.');
  } else if (env('RESET_PASSKEYS')) console.log(`auth: HALAY_RESET_PASSKEYS=${env('RESET_PASSKEYS')} ignored (only 1 resets the passkeys)`);
  q.purge.run(Date.now());
  setInterval(() => q.purge.run(Date.now()), 3600e3).unref();

  // ---- rate limiting: failed attempts per client, sliding window ----
  const fails = new Map(); // key -> [timestamps]
  const WINDOW = 15 * 60e3, MAX_FAILS = 10, MAX_REQS = 60;
  const clientKey = (req) => {
    const ra = req.socket.remoteAddress || '';
    const loop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    return (loop && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || ra; // behind tailscale serve every request is loopback
  };
  const recent = (k, win) => { const now = Date.now(); const a = (fails.get(k) || []).filter((t) => now - t < win); fails.set(k, a); return a; };
  const limited = (req) => recent('fail:' + clientKey(req), WINDOW).length >= MAX_FAILS;
  const noteFail = (req) => { recent('fail:' + clientKey(req), WINDOW).push(Date.now()); };
  const noteReq = (req) => { const a = recent('req:' + clientKey(req), 60e3); a.push(Date.now()); return a.length > MAX_REQS; };
  setInterval(() => { for (const k of fails.keys()) if (!recent(k, WINDOW).length) fails.delete(k); }, 600e3).unref();

  const tokenOk = (given) => {
    const a = Buffer.from(sha(String(given || ''))), b = Buffer.from(sha(token));
    return crypto.timingSafeEqual(a, b);
  };
  // token check that counts failures (API bearer / ?token= / login forms); false when the client is locked out
  function checkToken(req, given) {
    if (limited(req)) return false;
    if (tokenOk(given)) return true;
    noteFail(req);
    return false;
  }

  // ---- local app sign-in (POST /auth/local): the macOS menu-bar app (macos/) can't use a passkey, so it proves it is the
  // same user by reading <data dir>/local-app-token (mode 600, written by server.js) and sends that. Loopback is NOT proof
  // enough (behind tailscale serve or any reverse proxy every request is loopback, see clientKey), so the endpoint needs
  // the token, and in addition refuses anything that looks proxied: a forwarding header, a non-loopback socket or Host.
  const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'tailscale-user-login'];
  const LOOPBACK_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/i;
  const directLocal = (req) => LOOPBACK_ADDR.has(req.socket.remoteAddress || '') && LOOPBACK_HOST.test(String(req.headers.host || '')) && !FORWARDED.some((h) => req.headers[h] !== undefined);
  const localTokenOk = (given) => {
    const a = Buffer.from(sha(String(given || ''))), b = Buffer.from(sha(localToken));
    return crypto.timingSafeEqual(a, b);
  };

  // ---- origin / rpID ----
  const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
  // The origin the browser used, accepted only if it is this server's own address (Host, X-Forwarded-Host or the configured public URL).
  function originFor(req) {
    const origin = req.headers.origin;
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const pub = publicUrl();
    if (origin) {
      const oh = hostOf(origin);
      if (oh && (oh === host || oh === req.headers.host || (pub && oh === hostOf(pub)))) return origin;
      return null;
    }
    return null;
  }
  const rpIdOf = (origin) => new URL(origin).hostname;

  // ---- sessions ----
  const secureReq = (req) => !!req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' || !!req.headers['tailscale-user-login'] || (publicUrl() || '').startsWith('https://') && hostOf(publicUrl()) === req.headers.host;
  const cookieStr = (req, value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureReq(req) ? '; Secure' : ''}`;
  function startSession(req, res, via) {
    const raw = crypto.randomBytes(32).toString('base64url'), now = Date.now();
    q.addSess.run(sha(raw), owner().id, now, now + SESSION_MS, now, via, String(req.headers['user-agent'] || '').slice(0, 200));
    const prev = res.getHeader('set-cookie');
    const c = [cookieStr(req, raw, SESSION_MS / 1000), 'swarm_token=; Path=/; Max-Age=0', `${OLD_COOKIE}=; Path=/; Max-Age=0`];
    res.setHeader('set-cookie', prev ? [].concat(prev, c) : c);
  }
  const readCookie = (req) => { const h = String(req.headers.cookie || ''); return [COOKIE, OLD_COOKIE].map((n) => (h.match(new RegExp('(?:^|; )' + n + '=([\\w-]+)')) || [])[1]).find(Boolean); };
  // the logged-in session of a request, or null; renews sessions in their second half
  function session(req) {
    const raw = readCookie(req);
    if (!raw) return null;
    const h = sha(raw), s = q.sess.get(h), now = Date.now();
    if (!s) return null;
    if (s.expires_at < now) { q.delSess.run(h); return null; }
    if (s.expires_at - now < SESSION_MS / 2 || now - s.last_seen_at > 3600e3) q.touch.run(now, Math.max(s.expires_at, now + SESSION_MS), h);
    return s;
  }
  function endSession(req, res) {
    const raw = readCookie(req);
    if (raw) q.delSess.run(sha(raw));
    res.setHeader('set-cookie', [cookieStr(req, '', 0), `${OLD_COOKIE}=; Path=/; Max-Age=0`]);
  }
  // Same-origin check for cookie-authenticated requests that change things (SameSite=Lax already blocks cross-site POSTs).
  function sameOrigin(req) {
    const o = req.headers.origin;
    if (!o) return true;
    const pub = publicUrl();
    const oh = hostOf(o), host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    return !!oh && (oh === host || oh === req.headers.host || (pub && oh === hostOf(pub)));
  }
  // ---- agent tokens: what an agent's swarm MCP server gets instead of the access token. swa.<agent id>.<mac>: it names
  // the agent, so the server knows who calls without trusting a header, and opens only what swarm tools need (server.js).
  // Derived from the access token, so it survives server restarts (agents outlive them) and a new token revokes them all.
  const agentKey = crypto.createHash('sha256').update('swarm-agent-token\0' + token).digest();
  const agentMac = (id) => crypto.createHmac('sha256', agentKey).update(String(id)).digest('base64url');
  const agentToken = (id) => `swa.${id}.${agentMac(id)}`;
  // the agent id of a well-formed, genuine agent token, else null
  function agentOfToken(given) {
    const m = /^swa\.([\w-]{1,64})\.([\w-]{43})$/.exec(String(given || ''));
    if (!m) return null;
    const want = Buffer.from(agentMac(m[1])), got = Buffer.from(m[2]);
    return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1] : null;
  }

  // 'token' | 'agent' (req.agentId is then the calling agent) | 'session' | null. (url ?token= is kept for scripts,
  // EventSource and old links)
  function who(req, url) {
    const bearer = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    const given = bearer ? bearer[1] : url.searchParams.get('token');
    if (given != null && given !== '' && String(given).startsWith('swa.')) {
      if (limited(req)) return null;
      const id = agentOfToken(given);
      if (id) { req.agentId = id; return 'agent'; }
      noteFail(req);
      return null;
    }
    if (given != null && given !== '') { if (checkToken(req, given)) return 'token'; }
    const s = session(req);
    if (s && (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || sameOrigin(req))) return 'session';
    return null;
  }

  // ---- challenges (single use, 5 min) ----
  const challenges = new Map();
  function newChallenge(data) {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
    if (challenges.size > 500) challenges.clear();
    const id = crypto.randomBytes(18).toString('base64url');
    challenges.set(id, { ...data, exp: now + CHALLENGE_MS });
    return id;
  }
  const takeChallenge = (id, kind) => {
    const c = challenges.get(id);
    challenges.delete(id);
    return c && c.exp > Date.now() && c.kind === kind ? c : null;
  };

  const keyInfo = (k) => ({ id: k.id, name: k.name, rpId: k.rp_id, createdAt: k.created_at, lastUsedAt: k.last_used_at, deviceType: k.device_type, backedUp: !!k.backed_up });
  const guessName = (ua = '') => /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux' : 'Passkey';

  async function registrationOptions(origin) {
    const u = owner();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: rpIdOf(origin), userID: u.handle, userName: u.name, userDisplayName: u.name,
      attestationType: 'none',
      excludeCredentials: q.keys.all(u.id).filter((k) => k.rp_id === rpIdOf(origin)).map((k) => ({ id: k.id, type: 'public-key', transports: JSON.parse(k.transports || '[]') })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    return { challengeId: newChallenge({ kind: 'reg', challenge: options.challenge, origin, setup: false }), options };
  }
  async function finishRegistration(req, c, response, name) {
    const origin = c.origin, ua = req.headers['user-agent'];
    const v = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpIdOf(origin), requireUserVerification: false });
    if (!v.verified || !v.registrationInfo) throw new Error('passkey was not verified');
    const i = v.registrationInfo, id = b64u(i.credentialID);
    if (q.key.get(id)) throw new Error('this passkey is already registered');
    q.addKey.run(id, owner().id, Buffer.from(i.credentialPublicKey), i.counter, JSON.stringify(response.response?.transports || []),
      String(name || '').trim().slice(0, 60) || guessName(ua), rpIdOf(origin), i.credentialDeviceType, i.credentialBackedUp ? 1 : 0, Date.now());
    return id;
  }

  // Public endpoints (no auth): /auth/*. Returns true when handled.
  async function publicRoutes(req, res, url, { json, readBody }) {
    const p = url.pathname;
    if (!p.startsWith('/auth/')) return false;
    const post = req.method === 'POST';
    if (p === '/auth/state' && req.method === 'GET') {
      const setup = !hasKeys();
      return json(res, 200, { setup, tokenLogin: setup, loggedIn: !!session(req) }), true;
    }
    if (!post) return json(res, 404, { error: 'not found' }), true;
    if (noteReq(req)) return json(res, 429, { error: 'too many requests, wait a minute' }), true;
    if (p === '/auth/logout') { endSession(req, res); return json(res, 200, { ok: true }), true; }
    if (p === '/auth/local') { // the token is in a header, never in the URL or a body
      if (!localToken) return json(res, 404, { error: 'not found' }), true;
      if (limited(req)) return json(res, 429, { error: 'too many failed attempts, try again later' }), true;
      if (!directLocal(req)) { noteFail(req); return json(res, 403, { error: 'local sign-in only works for a direct connection from this machine' }), true; }
      const given = req.headers['x-halay-local-token'];
      if (typeof given !== 'string' || !localTokenOk(given)) { noteFail(req); return json(res, 401, { error: 'wrong token' }), true; }
      startSession(req, res, 'local-app');
      return json(res, 200, { ok: true }), true;
    }
    const body = await readBody(req);
    const origin = originFor(req);
    const locked = () => json(res, 429, { error: 'too many failed attempts, try again later' });

    if (p === '/auth/token') { // browser sign-in with the access token
      if (hasKeys()) return json(res, 403, { error: 'a passkey is set up: sign in with it (lost them all? start once with HALAY_RESET_PASSKEYS=1)' }), true;
      if (limited(req)) return locked(), true;
      if (!checkToken(req, body.token)) return json(res, 401, { error: 'wrong token' }), true;
      startSession(req, res, 'token');
      return json(res, 200, { ok: true }), true;
    }
    if (p === '/auth/setup/options') { // first passkey: only while none exists, and only with the token
      if (hasKeys()) return json(res, 403, { error: 'a passkey is already set up; sign in and add another in Settings' }), true;
      if (limited(req)) return locked(), true;
      if (!checkToken(req, body.token)) return json(res, 401, { error: 'wrong token' }), true;
      if (!origin) return json(res, 400, { error: 'unexpected origin; open the app at its own address' }), true;
      const r = await registrationOptions(origin);
      challenges.get(r.challengeId).setup = true;
      return json(res, 200, r), true;
    }
    if (p === '/auth/setup/verify') {
      const c = takeChallenge(body.challengeId, 'reg');
      if (!c || !c.setup) return json(res, 400, { error: 'setup expired, start again' }), true;
      if (hasKeys()) return json(res, 403, { error: 'a passkey is already set up' }), true;
      if (!origin || origin !== c.origin) return json(res, 400, { error: 'unexpected origin' }), true;
      try { await finishRegistration(req, c, body.response, body.name); }
      catch (e) { noteFail(req); return json(res, 400, { error: e.message }), true; }
      startSession(req, res, 'passkey');
      return json(res, 200, { ok: true }), true;
    }
    if (p === '/auth/login/options') {
      if (limited(req)) return locked(), true;
      if (!origin) return json(res, 400, { error: 'unexpected origin; open the app at its own address' }), true;
      const options = await generateAuthenticationOptions({ rpID: rpIdOf(origin), userVerification: 'preferred', allowCredentials: [] });
      return json(res, 200, { challengeId: newChallenge({ kind: 'auth', challenge: options.challenge, origin }), options }), true;
    }
    if (p === '/auth/login/verify') {
      if (limited(req)) return locked(), true;
      const c = takeChallenge(body.challengeId, 'auth');
      const k = c && body.response?.id ? q.key.get(String(body.response.id)) : null;
      if (!c || !k || !origin || origin !== c.origin) { noteFail(req); return json(res, 401, { error: 'sign-in failed' }), true; }
      try {
        const v = await verifyAuthenticationResponse({
          response: body.response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpIdOf(origin), requireUserVerification: false,
          authenticator: { credentialID: Buffer.from(k.id, 'base64url'), credentialPublicKey: new Uint8Array(k.public_key), counter: k.counter, transports: JSON.parse(k.transports || '[]') },
        });
        if (!v.verified) throw new Error('not verified');
        q.useKey.run(v.authenticationInfo.newCounter, Date.now(), k.id);
      } catch { noteFail(req); return json(res, 401, { error: 'sign-in failed' }), true; }
      startSession(req, res, 'passkey');
      return json(res, 200, { ok: true }), true;
    }
    return json(res, 404, { error: 'not found' }), true;
  }

  // Settings → passkeys; called for /api/auth/* after the request is authenticated. Adding needs a browser session.
  async function manageRoutes(req, res, url, kind, { json, readBody }) {
    const p = url.pathname;
    if (!p.startsWith('/api/auth/')) return false;
    const u = owner();
    if (p === '/api/auth/passkeys' && req.method === 'GET') {
      const cur = session(req);
      return json(res, 200, { passkeys: q.keys.all(u.id).map(keyInfo), via: cur?.via || kind }), true;
    }
    const needSession = () => kind === 'session' ? false : (json(res, 403, { error: 'sign in with the browser to change passkeys' }), true);
    if (p === '/api/auth/passkeys/options' && req.method === 'POST') {
      if (needSession()) return true;
      const origin = originFor(req);
      if (!origin) return json(res, 400, { error: 'unexpected origin; open the app at its own address' }), true;
      return json(res, 200, await registrationOptions(origin)), true;
    }
    if (p === '/api/auth/passkeys/verify' && req.method === 'POST') {
      if (needSession()) return true;
      const body = await readBody(req);
      const c = takeChallenge(body.challengeId, 'reg');
      const origin = originFor(req);
      if (!c || c.setup || !origin || origin !== c.origin) return json(res, 400, { error: 'expired, try again' }), true;
      try { await finishRegistration(req, c, body.response, body.name); } catch (e) { return json(res, 400, { error: e.message }), true; }
      return json(res, 200, { passkeys: q.keys.all(u.id).map(keyInfo) }), true;
    }
    const m = p.match(/^\/api\/auth\/passkeys\/([\w-]+)$/);
    if (m && req.method === 'PATCH') {
      if (needSession()) return true;
      const name = String((await readBody(req)).name || '').trim().slice(0, 60);
      if (!name) return json(res, 400, { error: 'name required' }), true;
      return json(res, q.renameKey.run(name, m[1], u.id).changes ? 200 : 404, { ok: true }), true;
    }
    if (m && req.method === 'DELETE') {
      if (needSession()) return true;
      if (!q.delKey.run(m[1], u.id).changes) return json(res, 404, { ok: true }), true;
      // without passkeys the token signs browsers in again (first-run setup), so the sessions passkeys vouched for end too;
      // only the browser that deleted the last one stays signed in
      if (!hasKeys()) q.delOtherSess.run(session(req)?.id_hash ?? '');
      return json(res, 200, { ok: true }), true;
    }
    return json(res, 404, { error: 'not found' }), true;
  }

  return { who, agentToken, checkToken, session, startSession, endSession, publicRoutes, manageRoutes, hasKeys, limited, sameOrigin };
}
