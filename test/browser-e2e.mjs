// End-to-end check of the agent browser against a SPARE instance (never the live server). Needs a Chromium (see docs/install.md):
//   PORT=4791 HALAY_DB=/tmp/x/halay.db node src/server.js &
//   BASE=http://127.0.0.1:4791 TOKEN=$(cat .token) node test/browser-e2e.mjs
// Starts a tiny test site, drives it through @playwright/mcp (as two different "agents" on one profile) and checks the
// shared login cookie, the driver lock, the viewer's screencast and input, and the auth on the endpoints.
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE, TOKEN = process.env.TOKEN, PROFILE = 'e2e' + Date.now().toString(36);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const api = (p, init = {}) => fetch(BASE + p, { ...init, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' } });

// test site: / has a form and echoes it back; /login sets a session cookie; /whoami shows it
const site = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const cookie = /sid=(\w+)/.exec(req.headers.cookie || '')?.[1];
  res.setHeader('content-type', 'text/html');
  if (u.pathname === '/login') { res.setHeader('set-cookie', 'sid=abc123; Path=/'); return res.end('<h1>logged in</h1>'); }
  if (u.pathname === '/whoami') return res.end(`<h1>sid=${cookie || 'none'}</h1>`);
  if (u.pathname === '/echo') return res.end(`<h1>got name=${u.searchParams.get('name')}</h1>`);
  res.end('<title>Form page</title><form action="/echo"><label>Name <input name="name" id="n"></label><button id="go">Send</button></form><button id="b" onclick="document.title=\'clicked\'" style="position:absolute;left:10px;top:200px;width:120px;height:40px">Click me</button>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = 'http://127.0.0.1:' + site.address().port;

// the CDP key an agent's Playwright MCP server gets on its command line (browser.js): opens only that profile's relay for that agent
const cdpKey = (agent, profile = PROFILE) => crypto.createHmac('sha256', 'browser-cdp\0' + TOKEN).update(profile + '\0' + agent).digest('base64url');
// a minimal MCP stdio client around @playwright/mcp, attached the way server.js does it
function mcp(agent) {
  const url = `ws://${new URL(BASE).host}/ws/browser-cdp?profile=${PROFILE}&agent=${agent}&key=${cdpKey(agent)}`; // the key server.js puts there, not the token
  const p = spawn(process.execPath, [path.join(ROOT, 'node_modules/@playwright/mcp/cli.js'), '--cdp-endpoint', url, '--output-dir', path.join(process.env.TMPDIR || '/tmp', 'browser-e2e-out')], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', id = 0; const waiting = new Map();
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiting.get(m.id)?.(m); } catch {} } });
  const rpc = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const call = async (name, args = {}) => { const m = await rpc('tools/call', { name, arguments: args }); return (m.result?.content || []).map((c) => c.text || '').join('\n') + (m.error ? 'ERR ' + m.error.message : '') + (m.result?.isError ? '\n[isError]' : ''); };
  return { call, rpc, init: () => rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }).then(() => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')), stop: () => p.kill() };
}

// auth
const wsStatus = (url) => new Promise((r) => { const w = new WebSocket(url); w.on('open', () => { w.close(); r('open'); }); w.on('error', () => {}); w.on('unexpected-response', (_, res) => r(res.statusCode)); });
const W = BASE.replace('http', 'ws');
ok((await fetch(BASE + '/api/browser')).status === 401, 'GET /api/browser without auth -> 401');
ok(await wsStatus(`${W}/ws/browser?profile=${PROFILE}`) === 401, 'viewer websocket without auth -> 401');
ok(await wsStatus(`${W}/ws/browser-cdp?profile=${PROFILE}&agent=x`) === 401, 'CDP relay without auth -> 401');
ok(await wsStatus(`${W}/ws/browser?profile=../x&token=${TOKEN}`) === 400, 'bad profile name -> 400');
ok(await wsStatus(`${W}/ws/browser-cdp?profile=${PROFILE}&agent=x&key=nope`) === 401, 'CDP relay with a wrong key -> 401');
ok(await wsStatus(`${W}/ws/browser-cdp?profile=${PROFILE}&agent=y&key=${cdpKey('x')}`) === 401, "another agent's key -> 401");
ok(await wsStatus(`${W}/ws/browser?profile=${PROFILE}&agent=x&key=${cdpKey('x')}`) === 401, 'the key does not open the viewer');
ok((await fetch(`${BASE}/api/browser?key=${cdpKey('x')}`)).status === 401, 'nor the API');

// agent A: read a page, fill and submit a form, log in
const A = mcp('agentA');
await A.init();
let r = await A.call('browser_navigate', { url: SITE + '/' });
ok(/Form page/.test(r), 'agent A opens the test page: ' + r.slice(0, 80).replace(/\n/g, ' '));
const snap = await A.call('browser_snapshot');
ok(/textbox/.test(snap) && /Send/.test(snap), 'agent A reads the page (snapshot has textbox and button)');
const ref = /textbox "?Name"? \[ref=(\w+)\]|textbox[^\n]*\[ref=(\w+)\]/.exec(snap);
r = await A.call('browser_type', { target: ref?.[1] || ref?.[2], text: 'swarm', submit: true });
await new Promise((r) => setTimeout(r, 800));
r = await A.call('browser_snapshot');
ok(/got name=swarm/.test(r), 'agent A filled and submitted the form');
await A.call('browser_navigate', { url: SITE + '/login' });
let list = await (await api('/api/browser')).json();
ok(list.profiles.find((p) => p.name === PROFILE)?.controller?.id === 'agentA', 'agent A holds the driver seat');

// agent B on the same profile while A holds the seat
const B = mcp('agentB');
await B.init();
r = await B.call('browser_navigate', { url: SITE + '/whoami' });
ok(/driving this browser profile/.test(r) && /agentA|Another agent/.test(r), 'agent B is refused while A drives: ' + r.slice(0, 120).replace(/\n/g, ' '));

// viewer: stream, take control, input
const v = new WebSocket(`${W}/ws/browser?profile=${PROFILE}&token=${TOKEN}`);
let frames = 0, state = null, bytes = 0;
v.on('message', (d, bin) => { if (bin) { frames++; bytes += d.length; } else { const m = JSON.parse(d.toString()); if (m.t === 'state') state = m; } });
await new Promise((r) => v.on('open', r));
await new Promise((r) => setTimeout(r, 1500));
ok(frames > 0, `viewer receives screencast frames (${frames}, ${bytes} bytes)`);
ok(state?.tabs?.length >= 1 && /login/.test(state.tabs.map((t) => t.url).join()), 'viewer lists tabs with urls');
v.send(JSON.stringify({ t: 'mouse', k: 'down', x: 20, y: 210 }));
await new Promise((r) => setTimeout(r, 300));
ok(state?.tabs?.[0]?.title !== 'clicked', 'viewer input ignored before taking control');
v.send(JSON.stringify({ t: 'take' }));
await new Promise((r) => setTimeout(r, 300));
ok(state?.controller?.type === 'user', 'user takes control');
r = await A.call('browser_navigate', { url: SITE + '/whoami' });
ok(/taken control/.test(r), 'agent A is refused while the user drives: ' + r.slice(0, 100).replace(/\n/g, ' '));
v.send(JSON.stringify({ t: 'nav', url: SITE + '/' }));
await new Promise((r) => setTimeout(r, 800));
v.send(JSON.stringify({ t: 'mouse', k: 'down', x: 20, y: 210 })); v.send(JSON.stringify({ t: 'mouse', k: 'up', x: 20, y: 210 }));
await new Promise((r) => setTimeout(r, 2200));
ok(state?.tabs?.some((t) => t.title === 'clicked'), 'user click through the viewer reaches the page (title changed)');
v.send(JSON.stringify({ t: 'mouse', k: 'down', x: 70, y: 40 })); // nothing there; focus the field via keyboard path instead
v.send(JSON.stringify({ t: 'give' }));
await new Promise((r) => setTimeout(r, 300));
ok(state?.controller === null, 'user gives control back');
A.stop(); B.stop();

// persistence across agents: a fresh agent C sees the cookie A's page set
const C = mcp('agentC');
await C.init();
await C.call('browser_navigate', { url: SITE + '/whoami' });
r = await C.call('browser_snapshot');
ok(/sid=abc123/.test(r), 'cookie persists to a different agent: ' + r.slice(0, 80).replace(/\n/g, ' '));
C.stop(); v.close();

// persistence across a browser restart (session cookie kept)
await api(`/api/browser/${PROFILE}/stop`, { method: 'POST' });
const D = mcp('agentD');
await D.init();
await D.call('browser_navigate', { url: SITE + '/whoami' });
r = await D.call('browser_snapshot');
ok(/sid=abc123/.test(r), 'session cookie survives a browser restart: ' + r.slice(0, 80).replace(/\n/g, ' '));
D.stop();
await api(`/api/browser/${PROFILE}/clear`, { method: 'POST' });
site.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
