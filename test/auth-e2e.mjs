// End-to-end check of the passkey login against a SPARE instance (never the live server). Needs playwright-core and Chrome:
//   PORT=4791 HALAY_TOKEN=testtoken123 HALAY_DB=/tmp/x/halay.db HALAY_TERMINAL=0 node src/server.js &
//   PW=/path/to/node_modules/playwright-core BASE=http://localhost:4791 TOKEN=testtoken123 DB=/tmp/x/halay.db node test/auth-e2e.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
const { chromium } = createRequire(import.meta.url)(process.env.PW);
// the app is used at localhost (passkeys need a domain, not an IP address); IP_BASE is the same server at 127.0.0.1, which agents/API use
const BASE = process.env.BASE.replace('127.0.0.1', 'localhost'), IP_BASE = BASE.replace('localhost', '127.0.0.1'), TOKEN = process.env.TOKEN, DB = process.env.DB;
const host = new URL(BASE).host;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const status = async (p, init) => (await fetch(BASE + p, { redirect: 'manual', ...init })).status;
const post = (p, body, headers = {}) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });

// 1. nothing reachable without auth
for (const p of ['/api/agents', '/api/settings/notify', '/api/terminals', '/api/server', '/api/uploads', '/api/auth/passkeys', '/js/main.js', '/js/state.js', '/css/base.css', '/index.html', '/vendor/xterm.js', '/nope'])
  ok([401].includes(await status(p, p === '/api/uploads' ? { method: 'POST' } : undefined)) || (p === '/index.html' || false), `unauthenticated ${p} -> 401 (or login page)`);
ok((await (await fetch(BASE + '/')).text()).includes('id="card"'), 'unauthenticated / is the login page');
ok((await (await fetch(BASE + '/index.html')).text()).includes('id="card"'), 'unauthenticated /index.html is the login page');
ok(await status('/raw/abc?p=x&exp=1&sig=bad') >= 400, 'unsigned /raw refused');
const wsTry = (url, headers = {}) => new Promise((r) => { const w = new WebSocket(url, { headers }); w.on('open', () => { w.close(); r('open'); }); w.on('error', (e) => r(e.message)); w.on('unexpected-response', (_, res) => r(res.statusCode)); });
const WS = BASE.replace('http', 'ws');
ok(await wsTry(WS + '/ws') === 401, 'unauthenticated WebSocket /ws -> 401');
ok(await wsTry(WS + '/ws/term?id=x') === 401, 'unauthenticated WebSocket /ws/term -> 401');
ok(await wsTry(WS + '/ws?token=wrong') === 401, 'wrong token WebSocket -> 401');
ok(await wsTry(WS + '/ws?token=' + TOKEN) === 'open', 'token WebSocket still opens');

// 1b. loopback-IP redirect: a browser page request at 127.0.0.1 goes to localhost (passkeys refuse an IP as the RP id); machine calls do not
const nav = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
{
  const r = await fetch(IP_BASE + '/?token=' + TOKEN + '&x=1', { redirect: 'manual', headers: nav });
  ok(r.status === 302 && r.headers.get('location') === BASE + '/?token=' + TOKEN + '&x=1', 'browser page request at 127.0.0.1 redirects to localhost (same path + ?token=): ' + r.status + ' ' + r.headers.get('location'));
  const r2 = await fetch(IP_BASE + '/some/deep/path?a=b', { redirect: 'manual', headers: nav, method: 'GET' });
  ok(r2.status === 302 && r2.headers.get('location') === BASE + '/some/deep/path?a=b', 'redirect keeps the path and query');
  const r3 = await fetch(IP_BASE + '//evil.example/x', { redirect: 'manual', headers: nav });
  ok(r3.status === 302 && new URL(r3.headers.get('location')).host === new URL(BASE).host, 'redirect target is always localhost (no open redirect)');
  ok((await fetch(IP_BASE + '/api/agents', { redirect: 'manual' })).status === 401, 'API call at 127.0.0.1 without auth is not redirected (401)');
  ok((await fetch(IP_BASE + '/api/agents', { redirect: 'manual', headers: { accept: '*/*' } })).status === 401, 'curl-style Accept */* is not redirected');
  ok((await fetch(IP_BASE + '/api/agents', { redirect: 'manual', headers: { authorization: 'Bearer ' + TOKEN } })).status === 200, 'Bearer API call at 127.0.0.1 works (agents, MCP, plugins)');
  ok((await fetch(IP_BASE + '/api/agents', { redirect: 'manual', headers: { ...nav, authorization: 'Bearer ' + TOKEN } })).status === 200, 'Bearer call is never redirected, even with Accept: text/html');
  ok((await fetch(IP_BASE + '/api/agents?token=' + TOKEN, { redirect: 'manual' })).status === 200, '?token= API call at 127.0.0.1 works');
  ok((await fetch(IP_BASE + '/', { redirect: 'manual', method: 'POST', headers: nav })).status !== 302, 'only GET/HEAD are redirected');
  ok((await fetch(IP_BASE + '/', { redirect: 'manual', headers: { ...nav, 'x-forwarded-host': 'm.tail.ts.net' } })).status !== 302, 'behind a proxy (x-forwarded-host) there is no redirect');
  ok((await fetch(BASE + '/', { redirect: 'manual', headers: nav })).status === 200, 'a request already at localhost is not redirected');
}

// 2. first-run setup needs the token
ok((await post('/auth/setup/options', {})).status === 401, 'setup/options without token refused');
ok((await post('/auth/setup/options', { token: 'nope' })).status === 401, 'setup/options with wrong token refused');
ok((await post('/auth/setup/verify', { challengeId: 'x', response: {} })).status === 400, 'setup/verify without a token-issued challenge refused');
ok((await (await fetch(BASE + '/auth/state')).json()).setup === true, 'state: setup needed');

// 3. machine access with the token
ok(await status('/api/agents', { headers: { authorization: 'Bearer ' + TOKEN } }) === 200, 'Bearer token API call works');
ok(await status('/api/agents', { headers: { authorization: 'Bearer ' + TOKEN, 'x-halay-agent': 'abc' } }) === 200, 'Bearer + x-halay-agent works');
ok(await status('/api/agents?token=' + TOKEN) === 200, '?token= API call works');
const mcp = await new Promise((resolve) => { // swarm-mcp.js unchanged: list_agents over stdio
  const p = spawn('node', ['src/swarm-mcp.js'], { env: { ...process.env, HALAY_URL: IP_BASE, HALAY_TOKEN: TOKEN, HALAY_AGENT: '' } });
  let out = ''; p.stdout.on('data', (d) => { out += d; if (out.includes('"id":2')) { p.kill(); resolve(out); } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_agents', arguments: {} } }) + '\n');
  setTimeout(() => { p.kill(); resolve(out); }, 8000);
});
ok(/"id":2/.test(mcp) && !/unauthorized|isError":true/.test(mcp), 'swarm-mcp.js list_agents works with the token');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function newCtx() {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId: authId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { ctx, page, cdp, authId };
}
// goto can be cut off (or stall) by the page's own reload (the app reloads on a 401 when the session ended): retry
const gotoRoot = async (page) => { for (let i = 0; ; i++) { try { return await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 10000 }); } catch (e) { if (i === 2) throw e; await page.waitForTimeout(500); } } };
const loggedIn = async (page) => { await gotoRoot(page); await page.waitForTimeout(1500); return !!(await page.$('#side')); };

// 4. browser: setup refused with a wrong token, allowed with the token
const A = await newCtx();
// the first-run link as `npm start` used to print it (127.0.0.1): the browser must end up on localhost with the token still in the form
await A.page.goto(IP_BASE + '/?token=' + TOKEN);
await A.page.waitForSelector('#main:not([hidden])');
ok(new URL(A.page.url()).hostname === 'localhost', 'opening the 127.0.0.1 link lands on localhost: ' + A.page.url().replace(TOKEN, '…'));
ok((await A.page.inputValue('#tok')) === TOKEN, 'the token from the link is already filled in');
ok((await A.page.textContent('#title')) === 'Set up your passkey', 'login page offers "Set up your passkey" on first run');
await A.page.fill('#tok', 'wrong-token');
await A.page.click('#main');
await A.page.waitForFunction(() => document.querySelector('#msg').textContent.length > 0);
ok(/wrong token/i.test(await A.page.textContent('#msg')), 'UI: setup with wrong token refused');
ok(!(await A.page.$('#side')), 'still on login page');
await A.page.fill('#tok', TOKEN);
await A.page.click('#main');
await A.page.waitForSelector('#side', { timeout: 15000 });
ok(true, 'setup with the token works and lands in the app');
const cookies = await A.ctx.cookies();
const sc = cookies.find((c) => c.name === 'halay_session');
ok(sc && sc.httpOnly && sc.sameSite === 'Lax', 'session cookie is HttpOnly + SameSite=Lax');
ok(sc && sc.expires - Date.now() / 1000 > 29 * 86400, 'session cookie lasts ~30 days');
ok(!(await A.page.evaluate(() => document.cookie)).includes('halay_session'), 'cookie not readable from JS');
ok((await (await A.page.request.get('/api/agents')).status()) === 200, 'session cookie accepted by the API');
ok(await wsTry(WS + '/ws', { cookie: `halay_session=${sc.value}`, origin: BASE }) === 'open', 'WebSocket accepts the session');
ok(await wsTry(WS + '/ws', { cookie: `halay_session=${sc.value}`, origin: 'https://evil.example' }) === 401, 'WebSocket with session but foreign Origin refused');
ok((await A.page.request.post('/api/agents', { headers: { origin: 'https://evil.example' }, data: {} })).status() === 401, 'session POST with foreign Origin refused (CSRF)');
const up = await A.page.request.post('/api/uploads?name=a.txt', { data: 'hello' });
ok(up.status() === 201, 'upload accepted with the session (' + up.status() + ')');
ok((await post('/auth/setup/options', { token: TOKEN })).status === 403, 'setup refused once a passkey exists (even with the token)');
ok(await loggedIn(A.page), 'reload keeps the session');

// 5. Settings lists the passkey; logout; login with the passkey
await A.page.click('#bset');
await A.page.waitForSelector('#pklist .pkrow');
ok((await A.page.$$('#pklist .pkrow')).length === 1, 'Settings → Security lists 1 passkey');
await A.page.click('#pklogout');
await A.page.click('dialog.ask .yes');
await A.page.waitForSelector('#card');
ok(true, 'Logout returns to the login page');
ok(await status('/api/agents', { headers: { cookie: `halay_session=${sc.value}` } }) === 401, 'old session cookie is dead after logout');
await A.page.waitForSelector('#main:not([hidden])');
ok((await A.page.textContent('#main')) === 'Sign in with passkey', 'login page offers passkey sign-in');
await A.page.click('#main');
await A.page.waitForSelector('#side', { timeout: 15000 });
ok(true, 'login with the passkey works');
// the app's startup requests must be answered before the session is expired below: a late 401 reloads the page,
// which would abort the next navigation
await A.page.waitForLoadState('networkidle').catch(() => {});

// 6. expiry
const sess = new Database(DB);
const cur = (await A.ctx.cookies()).find((c) => c.name === 'halay_session');
ok(await status('/api/agents', { headers: { cookie: `halay_session=${cur.value}` } }) === 200, 'session valid before expiry');
sess.prepare('UPDATE sessions SET expires_at=?').run(Date.now() - 1000);
ok(await status('/api/agents', { headers: { cookie: `halay_session=${cur.value}` } }) === 401, 'expired session refused');
ok(sess.prepare('SELECT COUNT(*) n FROM sessions').get().n === 0, 'expired session row removed');
ok(!(await loggedIn(A.page)), 'browser with expired session sees the login page');

// 7. the token no longer signs a browser in once a passkey exists
ok((await post('/auth/token', { token: TOKEN })).status === 403, 'token sign-in refused once a passkey exists');
const B = await newCtx();
await B.page.goto('/?token=' + TOKEN);
ok(!(await B.page.$('#side')) && !!(await B.page.$('#card')), '?token= link does not sign in once a passkey exists');
// "second device": copy the passkey into B's authenticator so it can sign in, then add its own
const creds = (await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authId })).credentials;
for (const c of creds) await B.cdp.send('WebAuthn.addCredential', { authenticatorId: B.authId, credential: c });
await B.page.waitForSelector('#main:not([hidden])');
await B.page.click('#main'); await B.page.waitForSelector('#side', { timeout: 15000 });
await B.page.click('#bset');
await B.page.waitForSelector('#pklist .pkrow');
await B.cdp.send('WebAuthn.clearCredentials', { authenticatorId: B.authId }); // so this device can register its own
await B.page.click('#pkadd');
await B.page.waitForFunction(() => document.querySelectorAll('#pklist .pkrow').length === 2, null, { timeout: 15000 });
ok(true, 'second passkey added while signed in');
B.page.once('dialog', (d) => d.accept('Test phone'));
await B.page.locator('.pkren').nth(1).click();
await B.page.waitForFunction(() => [...document.querySelectorAll('#pklist .pkrow b')].some((b) => b.textContent === 'Test phone'));
ok(true, 'passkey renamed');
await B.page.click('#bset'); await B.page.waitForSelector('#pklist .pkrow');
await B.page.locator('.pkdel').nth(1).click(); await B.page.click('dialog.ask .yes');
await B.page.waitForFunction(() => document.querySelectorAll('#pklist .pkrow').length === 1);
ok(true, 'passkey removed');
// deleting the last passkey re-opens token sign-in, so every other browser session ends
// (B signed in with a copy of A's passkey, so A's copy needs a higher signature counter to not look cloned)
const aCreds = (await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authId })).credentials;
await A.cdp.send('WebAuthn.clearCredentials', { authenticatorId: A.authId });
for (const c of aCreds) await A.cdp.send('WebAuthn.addCredential', { authenticatorId: A.authId, credential: { ...c, signCount: c.signCount + 100 } });
await A.page.goto('/'); await A.page.waitForSelector('#main:not([hidden])');
await A.page.click('#main'); await A.page.waitForSelector('#side', { timeout: 15000 });
const aSess = (await A.ctx.cookies()).find((c) => c.name === 'halay_session').value, bSess = (await B.ctx.cookies()).find((c) => c.name === 'halay_session').value;
ok(await status('/api/agents', { headers: { cookie: `halay_session=${aSess}` } }) === 200, 'A signed in again with the passkey');
await B.page.locator('.pkdel').nth(0).click(); await B.page.click('dialog.ask .yes');
await B.page.waitForFunction(() => document.querySelectorAll('#pklist .pkrow').length === 0);
ok(await status('/api/agents', { headers: { cookie: `halay_session=${aSess}` } }) === 401, 'deleting the last passkey ends the other sessions');
ok(await status('/api/agents', { headers: { cookie: `halay_session=${bSess}` } }) === 200, 'the browser that deleted it stays signed in');
// adding needs a browser session, not the bare token
ok((await post('/api/auth/passkeys/options', {}, { authorization: 'Bearer ' + TOKEN })).status === 403, 'Bearer token cannot register passkeys');
ok((await post('/auth/login/verify', { challengeId: 'x', response: { id: 'y' } })).status === 401, 'login/verify with junk refused');

// 8. rate limit (per client)
let last = 0;
for (let i = 0; i < 14; i++) last = (await post('/auth/login/verify', { challengeId: 'x', response: { id: 'y' } })).status;
ok(last === 429, 'repeated failed sign-ins are rate limited (429)');
for (let i = 0; i < 12; i++) await fetch(BASE + '/api/agents', { headers: { authorization: 'Bearer bad' + i } });
ok(await status('/api/agents', { headers: { authorization: 'Bearer ' + TOKEN } }) === 401, 'locked-out client refused even with the right token during the window');
await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
