// Local app sign-in (POST /auth/local, auth.js; the token file is written by server.js) against SPARE instances it starts
// itself, no browser:
//   node test/local-app-e2e.mjs
// Covers: the token file (mode 600, new at every start); a valid token signs in and the session cookie works, also once a
// passkey exists; a wrong or missing token, a token in the query string, a wrong method; a request that looks proxied
// (X-Forwarded-For and the other forwarding headers, a non-loopback Host) is refused even WITH the valid token; failed
// attempts are rate limited; HALAY_LOCAL_APP=0 turns it off.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import Database from 'better-sqlite3';
import { startSpare, checker } from './lib/spare.mjs';
const { ok, done } = checker();
const s = await startSpare({ tag: 'localapp' });
const file = path.join(s.dir, 'local-app-token');
const readToken = () => fs.readFileSync(file, 'utf8').trim();

// node:http, not fetch: fetch won't send an arbitrary Host header
const post = (p, headers = {}, { method = 'POST', port = s.port } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (r) => {
    let text = ''; r.on('data', (d) => (text += d)); r.on('end', () => resolve({ status: r.statusCode, cookie: [].concat(r.headers['set-cookie'] || []).join('\n'), text }));
  });
  req.on('error', reject); req.end();
});
const local = (tok, headers = {}) => post('/auth/local', { ...(tok === undefined ? {} : { 'x-halay-local-token': tok }), ...headers });
const sessionOf = (r) => (r.cookie.match(/halay_session=[\w-]+/) || [])[0];
const apiWith = async (cookie) => (await fetch(s.base + '/api/agents', { headers: { cookie } })).status;

try {
  // ---- the token file
  const st = fs.statSync(file);
  ok((st.mode & 0o777) === 0o600, 'local-app-token is mode 600');
  ok(/^[\w-]{43}$/.test(readToken()) && readToken() !== s.token, 'a random 256-bit token of its own, not the access token');
  ok(!fs.existsSync(file + '.tmp'), 'no temp file left behind');

  // ---- sign in
  const t1 = readToken();
  const r = await local(t1);
  const cookie = sessionOf(r);
  ok(r.status === 200 && JSON.parse(r.text).ok === true && !!cookie, 'valid token: 200 and a halay_session cookie');
  ok(/HttpOnly/.test(r.cookie) && /SameSite=Lax/.test(r.cookie), 'the cookie is the normal session cookie (HttpOnly, SameSite=Lax)');
  ok(await apiWith(cookie) === 200, 'that session can use the API');
  ok((await (await fetch(s.base + '/api/auth/passkeys', { headers: { cookie } })).json()).via === 'local-app', 'the session is recorded as via local-app');

  // ---- refusals: nothing is signed in
  for (const [name, res, code] of [
    ['wrong token', await local('x'.repeat(43)), 401],
    ['empty token', await local(''), 401],
    ['missing token', await local(undefined), 401],
    ['the access token is not the local token', await local(s.token), 401],
    ['token in the query string', await post('/auth/local?token=' + t1, {}), 401],
    ['token in the Authorization header', await post('/auth/local', { authorization: 'Bearer ' + t1 }), 401],
    ['GET', await post('/auth/local', { 'x-halay-local-token': t1 }, { method: 'GET' }), 404],
  ]) ok(res.status === code && !sessionOf(res), `${name}: ${code}, no cookie`);

  // ---- a proxied request is refused even with the right token (the failures above would lock us out: start clean)
  await s.restart();
  const t1b = readToken();
  for (const h of [{ 'x-forwarded-for': '203.0.113.9' }, { 'x-forwarded-host': 'halay.example.ts.net' }, { 'x-forwarded-proto': 'https' }, { forwarded: 'for=203.0.113.9' }, { 'x-real-ip': '203.0.113.9' }, { 'tailscale-user-login': 'a@b.c' }]) {
    const res = await local(t1b, h);
    ok(res.status === 403 && !sessionOf(res), `valid token + ${Object.keys(h)[0]}: 403, no cookie`);
  }
  const hostRes = await local(t1b, { host: 'halay.example.com' });
  ok(hostRes.status === 403 && !sessionOf(hostRes), 'valid token + a Host that is not loopback: 403, no cookie');
  ok((await local(t1b, { host: 'localhost:' + s.port })).status === 200, 'Host localhost:PORT is fine');
  await s.restart(); // the refusals counted as failures: start clean for the next part

  // ---- a new token at every start; the old one is dead, the old session lives
  const t2 = readToken();
  ok(t2 !== t1b && (st2 => (st2.mode & 0o777) === 0o600)(fs.statSync(file)), 'a restart writes a new token (still mode 600)');
  ok((await local(t1b)).status === 401, 'the previous start\'s token no longer works');
  ok(await apiWith(cookie) === 200, 'a session the old token made survives the restart');

  // ---- still works with a passkey set up (the normal browser token login is closed then)
  const db = new Database(s.db);
  try {
    const uid = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id || db.prepare('INSERT INTO users (name, handle, created_at) VALUES (?,?,?)').run('owner', 'h', Date.now()).lastInsertRowid;
    db.prepare('INSERT INTO passkeys (id,user_id,public_key,counter,transports,name,rp_id,device_type,backed_up,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('pk', uid, Buffer.from('k'), 0, '[]', 'planted', 'localhost', 'singleDevice', 0, Date.now());
  } finally { db.close(); }
  const viaToken = await fetch(s.base + '/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: s.token }) });
  ok(viaToken.status === 403, 'with a passkey, the browser token sign-in is closed');
  const r3 = await local(t2);
  ok(r3.status === 200 && await apiWith(sessionOf(r3)) === 200, 'with a passkey, the local token still signs the app in');

  // ---- rate limit: 10 failures lock the client out, the valid token included
  for (let i = 0; i < 10; i++) await local('wrong' + i);
  const locked = await local(t2);
  ok(locked.status === 429 && !sessionOf(locked), 'after 10 failed attempts even the valid token gets 429');
  await s.restart();
  ok((await local(readToken())).status === 200, 'a restart clears the lockout');
  await s.stop();

  // ---- off switch
  const off = await startSpare({ tag: 'localappoff', env: { HALAY_LOCAL_APP: '0' } });
  ok(!fs.existsSync(path.join(off.dir, 'local-app-token')), 'HALAY_LOCAL_APP=0: no token file');
  ok((await post('/auth/local', { 'x-halay-local-token': 'anything' }, { port: off.port })).status === 404, 'HALAY_LOCAL_APP=0: the endpoint is 404');
  await off.stop();
} catch (e) { ok(false, 'threw: ' + (e.stack || e)); try { await s.stop(); } catch {} }
done();
