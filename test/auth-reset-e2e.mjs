// HALAY_RESET_PASSKEYS handling (auth.js) against a SPARE instance it starts itself, no browser needed:
//   node test/auth-reset-e2e.mjs
// Plants a passkey and a browser session in the database, then checks: with a passkey the token sign-in is closed and
// the session works; a restart WITH HALAY_RESET_PASSKEYS=1 deletes passkeys and sessions (the session stops working,
// token sign-in is open again, the machine token still works, other data survives); a later restart WITHOUT the
// variable does not delete newly created ones; HALAY_RESET_PASSKEYS=0 / empty is treated per the code (see below).
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { startSpare, checker } from './lib/spare.mjs';
const { ok, done } = checker();
const s = await startSpare({ tag: 'authreset' });
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const state = async (cookie) => (await (await fetch(s.base + '/auth/state', { headers: cookie ? { cookie } : {} })).json());
const withDb = (f) => { const db = new Database(s.db); try { return f(db); } finally { db.close(); } };
const counts = () => withDb((db) => ({ keys: db.prepare('SELECT COUNT(*) n FROM passkeys').get().n, sessions: db.prepare('SELECT COUNT(*) n FROM sessions').get().n }));
const plant = (raw) => withDb((db) => {
  const now = Date.now(), uid = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id || db.prepare('INSERT INTO users (name, handle, created_at) VALUES (?,?,?)').run('owner', 'h', now).lastInsertRowid;
  db.prepare('INSERT INTO passkeys (id,user_id,public_key,counter,transports,name,rp_id,device_type,backed_up,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('pk-' + raw, uid, Buffer.from('k'), 0, '[]', 'planted', 'localhost', 'singleDevice', 0, now);
  db.prepare('INSERT INTO sessions (id_hash,user_id,created_at,expires_at,last_seen_at,via,ua) VALUES (?,?,?,?,?,?,?)').run(sha(raw), uid, now, now + 3600e3, now, 'passkey', 'test');
});
try {
  ok((await state()).setup === true && (await state()).tokenLogin === true, 'fresh instance: setup open, token sign-in allowed');
  const tokenLogin = (tok) => fetch(s.base + '/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok }) });
  // a session minted by the token sign-in exists too
  const t1 = await tokenLogin(s.token);
  ok(t1.status === 200 && /halay_session=/.test(t1.headers.get('set-cookie') || ''), 'token sign-in works while no passkey exists');
  const realCookie = (t1.headers.get('set-cookie').match(/halay_session=[\w-]+/) || [])[0];
  await s.api('/agents', 'POST', { cwd: s.dir, name: 'survivor' });
  ok(/swarm_session=;[^,]*Max-Age=0/.test(t1.headers.get('set-cookie') || ''), 'sign-in clears the old swarm_session cookie');
  ok((await fetch(s.base + '/api/agents', { headers: { cookie: realCookie.replace('halay_', 'swarm_') } })).status === 200, 'a session under the old cookie name is still accepted');

  plant('plantedsession1');
  const ck = 'halay_session=plantedsession1';
  let st = await state(ck);
  ok(st.setup === false && st.tokenLogin === false && st.loggedIn === true, 'with a passkey: setup closed, session valid');
  ok((await tokenLogin(s.token)).status === 403, 'with a passkey: the browser token sign-in is refused (403)');
  ok((await fetch(s.base + '/api/agents', { headers: { cookie: ck } })).status === 200, 'the planted session can use the API');
  ok((await fetch(s.base + '/api/agents', { headers: { authorization: 'Bearer ' + s.token } })).status === 200, 'the machine token works');
  ok(counts().keys === 1 && counts().sessions === 2, 'database: 1 passkey, 2 sessions');

  // a restart without the variable keeps everything
  await s.restart();
  ok(counts().keys === 1 && counts().sessions === 2 && (await state(ck)).loggedIn === true, 'restart without the variable: passkeys and sessions kept');
  ok(!/HALAY_RESET_PASSKEYS is set/.test(s.log()), 'no reset message in the log');

  // reset
  await s.restart({ HALAY_RESET_PASSKEYS: '1' });
  ok(/HALAY_RESET_PASSKEYS is set/.test(s.log()), 'the log says the passkeys were removed');
  ok(counts().keys === 0 && counts().sessions === 0, 'database: passkeys and sessions deleted');
  st = await state(ck);
  ok(st.setup === true && st.tokenLogin === true && st.loggedIn === false, 'after the reset: setup open, the old session is logged out');
  ok((await fetch(s.base + '/api/agents', { headers: { cookie: ck } })).status === 401 && (await fetch(s.base + '/api/agents', { headers: { cookie: realCookie } })).status === 401, 'after the reset: old session cookies are 401');
  ok((await tokenLogin(s.token)).status === 200, 'after the reset: token sign-in works again');
  ok((await tokenLogin('wrong')).status === 401, 'a wrong token is still refused');
  ok((await s.api('/agents')).j.some((a) => a.name === 'survivor'), 'agents and other data survive the reset');

  // passkeys added after the reset survive a normal restart
  plant('plantedsession2');
  await s.restart();
  ok(counts().keys === 1 && (await state('halay_session=plantedsession2')).loggedIn === true, 'a passkey added after the reset survives a restart without the variable');
  // only the exact value 1 resets: "0" (and "false", empty) are ignored
  await s.restart({ HALAY_RESET_PASSKEYS: '0' });
  ok(counts().keys === 1, 'HALAY_RESET_PASSKEYS=0 does not reset');
  await s.restart({ HALAY_RESET_PASSKEYS: '' });
  ok(counts().keys === 1, 'an empty HALAY_RESET_PASSKEYS does not reset');
} catch (e) { ok(false, 'unexpected exception: ' + (e.stack || e)); }
finally { await s.stop(); }
done();
