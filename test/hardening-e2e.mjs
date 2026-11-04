// Server hardening checks against a SPARE instance it starts itself (throwaway database, fake CLI first in PATH, no model
// calls; never the live server):
//   node test/hardening-e2e.mjs
// Covers: request body limits (413) and invalid JSON (400); input validation (task reorder ids, /send text, a malformed
// /raw escape); a task whose prompt can't be delivered fails with the reason and blocks its dependents; a scheduled run
// whose bot can't start is recorded as skipped with the reason; GET /api/agents/:id windows (default, ?all=1, ?tail=);
// the startup log doesn't print the access token when it comes from HALAY_TOKEN.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spareHome } from './lib/spare.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const Database = createRequire(path.join(ROOT, 'package.json'))('better-sqlite3');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) { const v = await fn(); if (v) return v; } return null; };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-e2e-'));
const DB = path.join(scratch, 'halay.db'), TOKEN = 'hardening-e2e-' + Date.now();
const port = await freePort(), BASE = 'http://127.0.0.1:' + port;

let server, log = '';
async function startServer() {
  log = '';
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, ...spareHome(scratch), PORT: String(port), HOST: '127.0.0.1', HALAY_DB: DB, HALAY_TOKEN: TOKEN, HALAY_PLUGINS: '0', PATH: path.join(ROOT, 'test/fake-claude') + ':' + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d));
  if (!await until(() => log.includes('running'), 15000)) { console.log(log); throw new Error('spare server did not start'); }
}
async function stopServer() {
  const done = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await done;
}
const raw = (p, init = {}) => fetch(BASE + p, { ...init, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...(init.headers || {}) } });
const api = async (p, method = 'GET', body) => {
  const r = await raw('/api' + p, { method, body: body && JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};

try {
  await startServer();
  ok(!log.includes(TOKEN) && log.includes('HALAY_TOKEN'), 'startup log names where the token comes from, not the token itself');

  // ---- request bodies
  const big = await raw('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'x', prompt: 'y'.repeat(6 << 20) }) }).catch((e) => ({ status: 'error ' + e.message }));
  ok(big.status === 413, 'a body over 5 MB → 413 (' + big.status + ')');
  const bad = await raw('/api/tasks', { method: 'POST', body: '{"title": "x",' });
  ok(bad.status === 400 && /JSON/.test((await bad.json()).error), 'invalid JSON → 400');
  ok((await api('/tasks')).status === 200, 'server fine after bad bodies');

  // ---- validation
  ok((await api('/tasks/reorder', 'POST', { ids: ['1; DROP', 2] })).status === 400, 'reorder with non-integer ids → 400');
  ok((await api('/tasks/reorder', 'POST', { ids: [] })).status === 200, 'reorder with an empty list → 200');
  ok((await raw('/raw/%E0%A4%A?p=x&exp=1&sig=x')).status === 400, 'malformed /raw escape → 400');

  // ---- undelivered task prompt
  const dir = path.join(scratch, 'work'); fs.mkdirSync(dir);
  const agent = (await api('/agents', 'POST', { cwd: dir, name: 'hardening' })).j;
  ok(agent.id, 'agent created');
  ok((await api(`/agents/${agent.id}/send`, 'POST', { text: 42 })).status === 400, '/send with a non-string text → 400');
  ok((await api(`/agents/${agent.id}/send`, 'POST', { text: '   ' })).status === 400, '/send with blank text → 400');
  fs.rmSync(dir, { recursive: true });
  ok((await api(`/agents/${agent.id}/send`, 'POST', { text: 'hi' })).status === 409, '/send to an agent whose folder is gone → 409');
  const t1 = (await api('/tasks', 'POST', { title: 'first' })).j;
  const t2 = (await api('/tasks', 'POST', { title: 'second', depends_on: [t1.id] })).j;
  const as = await api(`/tasks/${t1.id}/assign`, 'POST', { agentId: agent.id });
  ok(as.status >= 400 && /no longer exists/.test(as.j.error || ''), 'assigning to that agent fails with the reason: ' + as.j.error);
  const tasks = (await api('/tasks')).j;
  const f1 = tasks.find((t) => t.id === t1.id), f2 = tasks.find((t) => t.id === t2.id);
  ok(f1.status === 'failed' && /no longer exists/.test(f1.result || ''), 'the task is failed with the reason, not left running');
  ok(f2.state === 'blocked', 'its dependent is blocked instead of waiting: ' + JSON.stringify({ status: f2.status, state: f2.state }));

  // ---- agent event windows
  const w = fs.mkdtempSync(path.join(scratch, 'w-'));
  const a2 = (await api('/agents', 'POST', { cwd: w, name: 'windows', prompt: 'hello' })).j;
  await until(async () => (await api(`/agents/${a2.id}?all=1`)).j.status === 'idle');
  const all = (await api(`/agents/${a2.id}?all=1`)).j, dflt = (await api(`/agents/${a2.id}`)).j, tail = (await api(`/agents/${a2.id}?tail=1`)).j;
  ok(all.events.length >= 2 && all.from === 0 && all.total === all.events.length, '?all=1 returns every event');
  ok(dflt.events.length === all.events.length && dflt.from === 0, 'default window covers a short history');
  ok(tail.events.length === 1 && tail.from === all.total - 1, '?tail=1 returns the last event');

  // ---- a scheduled run whose bot can't start: recorded as skipped with the reason (seeded directly in the database)
  const botDir = fs.mkdtempSync(path.join(scratch, 'bot-'));
  const H = 'hb' + Date.now().toString(36).slice(-5);
  const b = await api('/bots', 'POST', { name: 'Hardening bot', handle: H, role: 'You are a test bot.', cwd: botDir });
  ok(b.status === 201 || b.status === 200, 'bot created: ' + (b.j.error || b.j.handle));
  const s = await api('/schedules', 'POST', { title: 'bot run', prompt: 'x', cron: '0 0 1 1 *', bot: H });
  ok(s.j.id, 'schedule for the bot created: ' + (s.j.error || s.j.id));
  await stopServer();
  {
    const db = new Database(DB);
    const botAgent = db.prepare('SELECT agent_id FROM bots WHERE handle=?').get(H)?.agent_id;
    db.prepare('UPDATE bots SET agent_id=NULL WHERE handle=?').run(H);
    if (botAgent) db.prepare('DELETE FROM agents WHERE id=?').run(botAgent);
    db.prepare('UPDATE schedules SET next_run_at=? WHERE id=?').run(Date.now() - 1000, s.j.id);
    db.close();
  }
  fs.rmSync(botDir, { recursive: true, force: true });
  await startServer();
  const sk = await until(async () => { const x = (await api('/schedules')).j.find((y) => y.id === s.j.id); return x?.skipReason ? x : null; }, 15000);
  ok(sk && /folder is gone/.test(sk.skipReason), 'the run is recorded as skipped with the reason: ' + sk?.skipReason);
  ok(sk && sk.nextRunAt > Date.now(), 'and the schedule moved on to its next run');
} catch (e) {
  ok(false, 'threw: ' + (e.stack || e));
} finally {
  server?.kill('SIGTERM');
  await sleep(300);
  if (fails) console.log(log.split('\n').slice(-40).join('\n'));
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'all passed');
  process.exit(fails ? 1 : 0);
}
