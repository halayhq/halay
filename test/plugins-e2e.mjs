// Plugin host check (plugins.js) against a SPARE instance it starts itself: a throwaway database, the fake
// CLI first in PATH (no model calls), HALAY_PLUGINS_DIR = test/plugins (fixtures) and a local HTTP listener standing in for
// ntfy and the webhook. Needs playwright-core and Chrome for the UI part.
//   node test/plugins-e2e.mjs
// Covers: discovery (built-in, folder, invalid manifest, incompatible api), consent on enable, the old ntfy settings moving
// to the ntfy plugin, settings with secrets, plugin routes, events, notification channels (agent turn + test button),
// MCP tools through swarm-mcp.js, autoAllow, the circuit breaker, and the UI (Machines block, a plugin block and page,
// Settings → Plugins).
import { agentToken, spareHome } from './lib/spare.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('playwright-core');
const Database = require('better-sqlite3');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = await fn(); if (v) return v; } return null; };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-e2e-'));

// the stand-in for ntfy and the webhook: records every POST
const got = [];
const sink = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { got.push({ path: req.url, body: JSON.parse(b) }); } catch { got.push({ path: req.url, body: b }); } res.end('ok'); }); });
const sinkPort = await freePort();
await new Promise((r) => sink.listen(sinkPort, '127.0.0.1', r));
const SINK = `http://127.0.0.1:${sinkPort}`;

// an "existing install" with ntfy configured the old way, before plugins existed
const DB = path.join(scratch, 'halay.db');
{
  const db = new Database(DB);
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('notify', JSON.stringify({ enabled: true, server: SINK + '/ntfy', topic: 'e2e-topic', token: '', details: true }));
  db.close();
}

const port = await freePort(), TOKEN = 'plugins-e2e-' + Date.now(), BASE = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, ...spareHome(scratch), PORT: String(port), HOST: '127.0.0.1', HALAY_DB: DB, HALAY_TOKEN: TOKEN, HALAY_PLUGINS_DIR: path.join(ROOT, 'test/plugins'), PATH: path.join(ROOT, 'test/fake-claude') + ':' + process.env.PATH },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d));
const api = async (p, method = 'GET', body, headers = {}) => {
  const r = await fetch(BASE + p, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const plugin = async (id) => (await api('/api/plugins')).j.plugins.find((p) => p.id === id);
const enable = (id, extra) => plugin(id).then((p) => api(`/api/plugins/${id}/enable`, 'POST', { permissions: p.permissions.map((x) => x.id) }, extra));

let browser;
try {
  ok(await until(() => log.includes('plugins:'), 15000), 'server started and loaded plugins');

  // 1. discovery
  const list = (await api('/api/plugins')).j;
  const ids = list.plugins.map((p) => p.id);
  ok(['machines', 'ntfy', 'webhook-notify', 'hello-block', 'bad', 'future'].every((x) => ids.includes(x)), 'found built-in and folder plugins: ' + ids.join(', '));
  ok(list.problems.some((x) => x.dir.endsWith('invalid') && /unknown permission/.test(x.error)), 'invalid manifest reported, not loaded');
  ok((await plugin('machines')).state === 'running', 'Machines (built-in, on by default) is running');
  ok((await plugin('hello-block')).state === 'off', 'a folder plugin starts disabled');
  ok(!(await plugin('future')).compatible, 'plugin needing API ^2.0 is marked incompatible');
  ok(/needs plugin API/.test((await plugin('future')).error || ''), 'an incompatible plugin says why in its status, even while off');

  // 2. the old built-in ntfy settings moved to the ntfy plugin, which is on because ntfy was
  const nt = await plugin('ntfy');
  ok(nt.state === 'running' && nt.settings.values.topic === 'e2e-topic', 'ntfy settings migrated and plugin running');

  // 3. consent: the exact permission list is needed, and an agent can't enable a plugin
  ok((await api('/api/plugins/hello-block/enable', 'POST', { permissions: ['ui'] })).status === 400, 'enable without the full permission list refused');
  ok((await enable('hello-block', { 'x-halay-agent': 'someone' })).status === 403, 'enable from an agent refused');
  ok((await enable('future')).j.state === 'error', 'enabling an incompatible plugin leaves it in error');
  const hb = (await enable('hello-block')).j;
  ok(hb.state === 'running', 'hello-block enabled' + (hb.error ? ': ' + hb.error : ''));
  // two enables at once run one after the other: no leaked registrations, no "already registered"
  const both = await Promise.all([enable('hello-block'), enable('hello-block')]);
  ok(both.every((r) => r.status === 200 && r.j.state === 'running'), 'concurrent enables both end running: ' + both.map((r) => r.j.state + (r.j.error ? ' ' + r.j.error : '')).join(', '));
  ok((await api('/api/plugins/hello-block')).j.tools.length === 1, 'and the plugin has its one tool, once');
  // only the user manages plugins: an agent (or peer / plugin) may not switch one off or retarget its settings
  ok((await api('/api/plugins/hello-block/disable', 'POST', {}, { 'x-halay-agent': 'someone' })).status === 403, 'disable from an agent refused');
  ok((await api('/api/plugins/hello-block/settings', 'PUT', { greeting: 'pwned' }, { 'x-halay-agent': 'someone' })).status === 403, 'settings from an agent refused');
  ok((await api('/api/plugins/hello-block/test', 'POST', {}, { 'x-halay-agent': 'someone' })).status === 403, 'test from an agent refused');
  ok((await plugin('hello-block')).state === 'running', 'still running after the refused disable');
  ok((await api('/api/plugins/%E0%A4%A')).status === 400, 'malformed URL escape → 400');
  const sh = (await enable('list')).j;
  ok(sh.state === 'error' && /built-in swarm tool/.test(sh.error || ''), 'a plugin tool shadowing a core tool fails loudly: ' + sh.error);

  // 4. routes and settings
  ok((await api('/api/plugins/hello-block/api/ping')).j.pong === 'hello', 'plugin route with default setting');
  ok((await api('/api/plugins/hello-block/api/echo/abc')).j.word === 'abc', 'route params');
  ok(typeof (await api('/api/plugins/hello-block/api/agents')).j === 'number', 'ctx.agents.list through the core API');
  await api('/api/plugins/hello-block/settings', 'PUT', { greeting: 'merhaba' });
  ok((await api('/api/plugins/hello-block/api/ping')).j.pong === 'merhaba', 'settings saved and read');

  // 5. webhook-notify: secret setting, test button, channel on an agent turn
  ok((await enable('webhook-notify')).j.state === 'running', 'webhook-notify enabled');
  const ws = (await api('/api/plugins/webhook-notify/settings', 'PUT', { url: SINK + '/hook', format: 'json' })).j;
  ok(ws.settings.secretsSet.url === true && !('url' in ws.settings.values), 'secret stored and not sent back');
  ok((await api('/api/plugins/webhook-notify/test', 'POST')).status === 200 && got.some((g) => g.path === '/hook' && g.body.kind === 'test'), 'Send test reached the webhook');

  const dir = path.join(scratch, 'work'); fs.mkdirSync(dir);
  const agent = (await api('/api/agents', 'POST', { cwd: dir, name: 'plugin e2e' })).j;
  ok(agent.id, 'agent created');
  got.length = 0;
  await api(`/api/agents/${agent.id}/send`, 'POST', { text: 'hi' });
  ok(await until(() => got.some((g) => g.path === '/hook' && g.body.kind === 'done')), 'agent turn finished → webhook channel');
  ok(got.some((g) => g.path === '/ntfy' && g.body.topic === 'e2e-topic'), 'agent turn finished → ntfy plugin channel (migrated settings)');
  const st = await until(async () => { const s = (await api('/api/plugins/hello-block/api/stats')).j; return s.finished ? s : null; });
  ok(st?.last?.agent === agent.id && st.last.result === 'fake turn', 'agent.finished event with the full result');
  const lc = await until(async () => { const l = (await api('/api/plugins/hello-block/api/lifecycle')).j; return l['agent.started'] && l['agent.status'] >= 2 && l['agent.event'] ? l : null; });
  ok(lc, 'agent.started, agent.status and agent.event events: ' + JSON.stringify(lc));

  // 6. MCP tools, through swarm-mcp.js as an agent would use them
  const mcp = spawn(process.execPath, [path.join(ROOT, 'src', 'swarm-mcp.js')], { env: { ...process.env, HALAY_URL: BASE, HALAY_TOKEN: agentToken({ token: TOKEN }, agent.id), HALAY_AGENT: agent.id, HALAY_ROLE: '' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map(); let buf = '';
  mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.set(m.id, m); } });
  const rpc = async (id, method, params) => { mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return until(() => replies.get(id), 10000); };
  await rpc(1, 'initialize', {});
  const names = (await rpc(2, 'tools/list', {}))?.result.tools.map((t) => t.name) || [];
  ok(names.includes('hello_block_echo') && !names.includes('webhook_notify_notify_user'), 'agent sees the plugin tool for its role only');
  const call = await rpc(3, 'tools/call', { name: 'hello_block_echo', arguments: { text: 'yo' } });
  ok(call?.result?.content?.[0]?.text === 'echo from agent: yo', 'plugin tool call answered: ' + JSON.stringify(call?.result));
  const unknown = await rpc(4, 'tools/call', { name: 'nope_tool', arguments: {} });
  ok(unknown?.result?.isError && unknown.result.content[0].text === 'unknown tool', 'unknown tool still reported as unknown');
  mcp.kill();

  const cond = (await api('/api/conductor', 'POST', {})).j;
  const condId = cond.id || cond.agent?.id;
  const perm = await api('/internal/permission', 'POST', { agentId: condId, tool_name: 'mcp__swarm__webhook_notify_notify_user', input: { text: 'x' } });
  ok(perm.j.behavior === 'allow', 'autoAllow tool allowed for the conductor without a card');
  got.length = 0;
  const nu = await api('/internal/plugin-tools/call', 'POST', { name: 'webhook_notify_notify_user', arguments: { title: 'T', text: 'from the conductor' } }, { 'x-halay-agent': condId });
  ok(nu.j.text === 'sent' && got.some((g) => g.path === '/hook' && g.body.body === 'from the conductor'), 'conductor tool posted to the webhook');
  ok((await api('/internal/plugin-tools/call', 'POST', { name: 'webhook_notify_notify_user', arguments: { text: 'x' } }, { 'x-halay-agent': agent.id })).status === 404, 'conductor-only tool refused for an agent');

  await api(`/api/agents/${agent.id}/interrupt`, 'POST');
  ok(await until(async () => (await api('/api/plugins/hello-block/api/lifecycle')).j['agent.exited'] >= 1), 'agent.exited event after the process is stopped');

  // 7. circuit breaker: 20 errors switch the plugin off, the server carries on
  ok((await enable('bad')).j.state === 'running', 'bad plugin enabled');
  ok((await api('/api/plugins/bad/api/boom')).status === 500, 'throwing route → 500');
  for (let i = 0; i < 19; i++) await api('/api/plugins/bad/api/' + (i % 2 ? 'boom' : 'reject'));
  const bad = await until(async () => { const p = await plugin('bad'); return p.state === 'error' ? p : null; }, 3000);
  ok(bad && !bad.enabled && /switched off/.test(bad.error), 'breaker switched the bad plugin off: ' + bad?.error);
  ok((await api('/api/plugins/bad/api/boom')).status === 503, 'its routes answer 503 while off');
  ok((await api('/api/agents')).status === 200, 'server still fine');

  // 8. UI
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  // sign in through the context's cookie jar: loading the login page first races its own redirect with the next goto (ERR_ABORTED)
  await page.context().request.post(BASE.replace('127.0.0.1', 'localhost') + '/auth/token', { data: { token: TOKEN } });
  await page.goto(BASE.replace('127.0.0.1', 'localhost') + '/?r=1#/');
  ok(await page.waitForSelector('.pblock[data-plugin="machines"]:not([hidden]) .mrow', { timeout: 15000 }).then(() => true, () => false), 'Machines block rendered by the built-in plugin');
  ok(await page.waitForFunction(() => document.querySelector('.pblock[data-plugin="hello-block"] .pbody')?.textContent === 'greeting: merhaba', null, { timeout: 10000 }).then(() => true, () => false), 'plugin sidebar block rendered');
  await page.click('#tools button[data-plugin="hello-block"]');
  ok(await page.waitForSelector('#pgdlg[open] .hello-page', { timeout: 5000 }).then(() => true, () => false), 'plugin page opens from its tool button');
  ok((await page.evaluate(() => location.hash)) === '#/p/hello-block/main', 'plugin page has its own route');
  await page.evaluate(() => { location.hash = '#/settings'; });
  ok(await page.waitForFunction(() => document.querySelectorAll('#plist .pcard').length >= 5, null, { timeout: 10000 }).then(() => true, () => false), 'Settings → Plugins lists the plugins');
  await page.evaluate(() => { location.hash = '#/'; });
  await api('/api/plugins/hello-block/disable', 'POST');
  ok(await page.waitForFunction(() => !document.querySelector('.pblock[data-plugin="hello-block"]') && !document.querySelector('#tools button[data-plugin="hello-block"]'), null, { timeout: 5000 }).then(() => true, () => false), 'disabling removes its block and button live');
  ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));

  // 9. plugin files are served only for running plugins and only their declared files
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const raw = (p) => fetch(BASE + p, { headers: { cookie } }).then((r) => r.status);
  ok(await raw('/plugins/machines/ui.js') === 200, 'running plugin ui.js served');
  ok(await raw('/plugins/machines/package.json') === 404, 'other plugin files not served');
  ok(await raw('/plugins/hello-block/ui.js') === 404, 'disabled plugin files not served');
} catch (e) {
  ok(false, 'threw: ' + (e.stack || e));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  sink.close();
  await sleep(500);
  if (fails) console.log(log.split('\n').filter((l) => /plugin|error/i.test(l)).slice(-40).join('\n'));
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
}
