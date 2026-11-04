// Delivery to claude's stdin (the runs/<id>.in FIFO) against a SPARE instance (never the live server); makes no model calls.
// Starts its own instance on a free port with a throwaway database and the fake CLI in its event-driven mode
// (FAKE_CLAUDE_NODE=1: it reads stdin the way the real claude does):
//   node test/stdin-e2e.mjs            (SLOW=1 also checks the watchdog's "no response" flag; takes ~1.5 min)
//  - a room @mention bigger than the FIFO's 8 KB buffer reaches the agent and its turn finishes (it used to hang "running")
//  - a killed claude process: status leaves "running"/"idle" for "stopped", and the next message starts a new process
//  - a live process that can't read its stdin any more (ENXIO): the message goes to a new process instead of hanging
//  - watchdog settings: the new limits are accepted and validated; SLOW=1: a message claude never answers is flagged
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spareHome } from './lib/spare.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stdin-e2e-'));
const PIDLOG = path.join(scratch, 'pids.log');

const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = 'stdin-e2e-' + Date.now(), BASE = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, ...spareHome(scratch), PORT: String(port), HOST: '127.0.0.1', HALAY_DB: path.join(scratch, 'halay.db'), HALAY_TOKEN: TOKEN, FAKE_CLAUDE_NODE: '1', FAKE_CLAUDE_PIDLOG: PIDLOG, PATH: path.join(ROOT, 'test/fake-claude') + ':' + process.env.PATH },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 100 && !log.includes('running'); i++) await sleep(100);
if (!log.includes('running')) { console.log(log); throw new Error('spare server did not start'); }

const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + '/api' + p, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const waitFor = async (f, ms = 5000) => { for (let t = Date.now(); Date.now() - t < ms; await sleep(100)) { const v = await f(); if (v) return v; } return null; };
const agentOf = async (id) => (await api('/agents/' + id)).j;
const lastPid = () => Number(fs.readFileSync(PIDLOG, 'utf8').trim().split('\n').at(-1));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// resolves the agent once it is idle again with a result newer than event index `from`
const turnDone = (id, from, ms) => waitFor(async () => { const a = await agentOf(id); return a.status === 'idle' && a.events.slice(from).some((e) => e.type === 'result') && a; }, ms);

try {
  const dir = path.join(scratch, 'w'); fs.mkdirSync(dir);
  const a = (await api('/agents', 'POST', { cwd: dir, name: 'namer', prompt: 'hello' })).j;
  ok(a.id && await turnDone(a.id, 0), 'agent started and finished its first turn');
  const pid1 = lastPid();

  // 1. a room message bigger than the FIFO buffer
  const room = (await api('/rooms', 'POST', { name: 'naming', members: [a.id] })).j;
  let from = (await agentOf(a.id)).total;
  // as in the incidents: the turn carries the room's recent messages, so it outgrows the 8 KB buffer (each message is <= 8000 chars)
  await api(`/rooms/${room.id}/messages`, 'POST', { text: 'availability notes, round 1: ' + 'crewhall is free on npm and github. '.repeat(200) });
  const big = '@namer ' + 'name candidates and availability notes. '.repeat(190);
  const posted = await api(`/rooms/${room.id}/messages`, 'POST', { text: big });
  ok(posted.j.delivered?.includes('namer'), 'room delivered the long @mention');
  let after = await turnDone(a.id, from, 5000);
  const res = after?.events.slice(from).find((e) => e.type === 'result')?.result || '';
  ok(after && Number(res.match(/\((\d+) bytes\)/)?.[1]) > 8192, `long message read whole and the turn finished (${res || 'still ' + (await agentOf(a.id)).status})`);
  ok(lastPid() === pid1, 'same claude process');

  // 2. the claude process dies while idle
  process.kill(pid1, 'SIGKILL');
  ok(await waitFor(async () => (await agentOf(a.id)).status === 'stopped'), 'killed process: status becomes stopped');
  from = (await agentOf(a.id)).total;
  await api(`/agents/${a.id}/send`, 'POST', { text: 'are you there?' });
  after = await turnDone(a.id, from);
  ok(after && lastPid() !== pid1 && alive(lastPid()), 'next message starts a new process and its turn finishes');

  // 3. the process is alive but no longer reads its stdin (nothing holds the FIFO's read end)
  const pid2 = lastPid();
  from = (await agentOf(a.id)).total;
  await api(`/agents/${a.id}/send`, 'POST', { text: 'fake-close-stdin' });
  ok(await turnDone(a.id, from), 'turn before stdin closes');
  await sleep(200);
  from = (await agentOf(a.id)).total;
  await api(`/agents/${a.id}/send`, 'POST', { text: 'second try ' + 'x'.repeat(9000) });
  after = await turnDone(a.id, from);
  const evs = after?.events.slice(from) || [];
  ok(after && lastPid() !== pid2, 'message went to a new process, turn finished');
  ok(evs.some((e) => e.type === 'stderr' && /could not write to agent: .*ENXIO/.test(e.text)) && evs.some((e) => e.type === 'note' && /delivered to a new one/.test(e.text)), 'the chat says why');
  ok(await waitFor(() => !alive(pid2), 2000), 'the process that could not read was ended');

  // 4. watchdog settings
  ok((await api('/settings/watchdog')).j.toolMinutes === 60 && (await api('/settings/watchdog')).j.startMinutes === 3, 'watchdog defaults: 60 min during a tool call, 3 min without a response');
  ok((await api('/settings/watchdog', 'PUT', { startMinutes: 0 })).status === 400, 'startMinutes 0 refused');
  ok((await api('/settings/watchdog', 'PUT', { toolMinutes: 5000 })).status === 400, 'toolMinutes 5000 refused');
  ok((await api('/settings/watchdog', 'PUT', { startMinutes: 1 })).j.startMinutes === 1, 'startMinutes saved');

  if (process.env.SLOW) {
    await api(`/agents/${a.id}/send`, 'POST', { text: 'fake-mute' });
    const w = await waitFor(async () => (await agentOf(a.id)).watchdog, 100_000);
    ok(w?.kind === 'idle' && /no response/.test(w.detail), `a message claude never answers is flagged (${w?.detail})`);
    await api(`/agents/${a.id}/interrupt`, 'POST');
    ok(await waitFor(async () => (await agentOf(a.id)).status === 'stopped'), 'interrupt ends it');
  }
} finally {
  for (const p of fs.existsSync(PIDLOG) ? fs.readFileSync(PIDLOG, 'utf8').trim().split('\n') : []) try { process.kill(Number(p), 'SIGKILL'); } catch {}
  server.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
