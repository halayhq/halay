// Peers end to end: two SPARE instances (never the live server) on free ports, each with a throwaway database and the
// fake CLI first in PATH, configured as each other's peers; makes no model calls:
//   node test/peers-e2e.mjs
// Checks:
//  - /api/peers: config validation; tokens are never returned; the peer probe (list_peers) says reachable / unreachable
//  - the conductor's MCP tools with peer=<name>: list_agents, start_agent (wait), send_message, read_agent, wait_for_agent
//    (a long poll through the proxy), interrupt_agent, list_tasks, add_task, get_task, assign_task, list_sessions, list_accounts
//  - on the receiving side agents and tasks are marked started_by / added_by "peer:<name>"
//  - an unreachable peer and a wrong token give a clear error fast, without the token in it
//  - a peer call cannot reach the receiver's own peers; a regular agent has no peer tools and peer= is refused where unsupported
//  - neither token reaches the other server's agents (env, arguments) or its log
import { agentToken, spareHome } from './lib/spare.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'peers-e2e-'));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function startServer(tag) {
  const port = await freePort(), dir = path.join(scratch, tag);
  fs.mkdirSync(dir);
  const s = { tag, port, base: 'http://127.0.0.1:' + port, token: `peers-e2e-${tag}-${Date.now()}`, dir, envLog: path.join(dir, 'env.log'), argLog: path.join(dir, 'args.log'), log: '' };
  s.proc = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, ...spareHome(dir), PORT: String(port), HOST: '127.0.0.1', HALAY_DB: path.join(dir, 'halay.db'), HALAY_TOKEN: s.token, FAKE_CLAUDE_ENVLOG: s.envLog, FAKE_CLAUDE_LOG: s.argLog, PATH: path.join(ROOT, 'test/fake-claude') + ':' + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.proc.stdout.on('data', (d) => (s.log += d)); s.proc.stderr.on('data', (d) => (s.log += d));
  for (let i = 0; i < 100 && !s.log.includes('running'); i++) await sleep(100);
  if (!s.log.includes('running')) { console.log(s.log); throw new Error(`spare server ${tag} did not start`); }
  s.api = async (p, method = 'GET', body, headers = {}) => {
    const r = await fetch(s.base + '/api' + p, { method, headers: { authorization: 'Bearer ' + s.token, 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { text }; }
    return { status: r.status, j, text };
  };
  return s;
}

// a swarm MCP server as claude runs it for agent `agent` on server s; call(tool, args) -> { text, error }
function mcp(s, agent, role) {
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'swarm-mcp.js')], { env: { ...process.env, HALAY_URL: s.base, HALAY_TOKEN: agentToken(s, agent), HALAY_AGENT: agent, HALAY_ROLE: role || '' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waits = new Map(); let n = 0;
  readline.createInterface({ input: p.stdout }).on('line', (l) => { const m = JSON.parse(l); waits.get(m.id)?.(m.result); waits.delete(m.id); });
  const rpc = (method, params) => new Promise((r) => { const id = ++n; waits.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return {
    call: async (name, args) => { const r = await rpc('tools/call', { name, arguments: args }); return { text: r.content[0].text, error: !!r.isError }; },
    tools: async () => (await rpc('tools/list', {})).tools,
    init: () => rpc('initialize', {}), kill: () => p.kill(),
  };
}
const waitFor = async (f, ms = 5000) => { for (let t = Date.now(); Date.now() - t < ms; await sleep(100)) { const v = await f(); if (v) return v; } return null; };

const A = await startServer('a'), B = await startServer('b');
const procs = [];
try {
  const work = path.join(scratch, 'work'); fs.mkdirSync(work);

  // ---- config
  ok((await A.api('/peers', 'PUT', { self: 'a' })).j.self === 'a', 'A calls itself "a"');
  ok((await B.api('/peers', 'PUT', { self: 'b' })).j.self === 'b', 'B calls itself "b"');
  ok((await A.api('/peers/b', 'PUT', { url: B.base })).status === 400, 'a peer without a token is refused');
  ok((await A.api('/peers/bad%20name', 'PUT', { url: B.base, token: 'x' })).status === 400, 'a bad peer name is refused');
  ok((await A.api('/peers/c', 'PUT', { url: 'ftp://x', token: 'x' })).status === 400, 'a non-http url is refused');
  ok((await A.api('/peers/a', 'PUT', { url: B.base, token: 'x' })).status === 400, 'a peer cannot have this server\'s own name');
  const put = await A.api('/peers/b', 'PUT', { url: B.base + '/', token: B.token });
  ok(put.status === 200 && put.j.url === B.base && put.j.hasToken, 'A: peer b added (trailing slash dropped)');
  ok((await A.api('/peers/b', 'PUT', { url: B.base })).status === 200, 'updating the url keeps the stored token');
  await B.api('/peers/a', 'PUT', { url: A.base, token: A.token });
  const deadPort = await freePort();
  await A.api('/peers/dead', 'PUT', { url: 'http://127.0.0.1:' + deadPort, token: 'whatever' });
  await A.api('/peers/wrongtok', 'PUT', { url: B.base, token: 'not-the-token' });
  const lst = await A.api('/peers');
  ok(lst.j.peers.length === 3 && !lst.text.includes(B.token) && !lst.text.includes('not-the-token') && !lst.text.includes('whatever'), 'GET /api/peers lists peers without tokens');

  // ---- the conductor on A
  const condA = (await A.api('/conductor', 'POST', {})).j;
  const cond = mcp(A, condA.id, 'conductor'); procs.push(cond); await cond.init();
  const names = (await cond.tools()).map((t) => t.name);
  ok(names.includes('list_peers'), 'conductor has list_peers');
  const lp = (await cond.call('list_peers', {})).text;
  ok(/this swarm is "a"/.test(lp) && /- b · .* reachable \(calls itself b;/.test(lp), 'list_peers: b reachable and named');
  ok(/this swarm is "a" · cpu \d+% \(\d+ cores, load [\d.]+\) · ram [\d.]+\/[\d.]+ GB \(\d+%\) · disk \S+ /.test(lp), 'list_peers: this machine\'s own stats on the first line');
  ok(/- b · .*reachable \(.*\) · cpu \d+% \(\d+ cores.* · ram [\d.]+\/[\d.]+ GB.* · disk /.test(lp), 'list_peers: the peer\'s stats on its line');
  const hs = (await A.api('/stats')).j;
  ok(hs.name === 'a' && hs.cpu.percent >= 0 && hs.cpu.percent <= 100 && hs.cpu.cores > 0 && hs.mem.totalGb > 0 && hs.mem.usedGb <= hs.mem.totalGb && hs.disks.length >= 1 && hs.disks.every((d) => d.totalGb > 0 && d.freeGb <= d.totalGb), 'GET /api/stats: cpu, ram and disks are sane');
  const ps = (await A.api('/peers/b')).j.status;
  ok(ps.ok && ps.stats?.mem?.totalGb > 0 && (await A.api('/peers/b/stats')).j.cpu?.cores > 0, 'peer probe and /api/peers/<name>/stats carry the peer\'s stats');
  ok(/- dead · .*UNREACHABLE: .*unreachable/.test(lp), 'list_peers: the dead peer is unreachable');
  ok(/- wrongtok · .*UNREACHABLE: .*refused the token/.test(lp) && !lp.includes('not-the-token'), 'list_peers: a wrong token is reported, not echoed');

  // start an agent on B from A's conductor
  const st = await cond.call('start_agent', { peer: 'b', cwd: work, name: 'from a', prompt: 'hello from a', wait: true });
  const startedId = st.text.match(/started agent (\S+)/)?.[1];
  ok(!st.error && startedId && /on peer b/.test(st.text) && /result: fake turn/.test(st.text), 'start_agent peer=b wait=true: started and finished on B');
  const onB = (await B.api('/agents')).j.find((a) => a.id === startedId);
  ok(onB?.startedBy === 'peer:a' && !onB.parentId, 'B: the agent is marked started by peer:a, no parent');
  ok(!(await A.api('/agents')).j.some((a) => a.id === startedId), 'A: the agent is not on A');
  ok(/started by peer:a/.test((await cond.call('list_agents', { peer: 'b' })).text), 'list_agents peer=b shows it, started by peer:a');
  ok(!(await cond.call('list_agents', {})).text.includes(startedId), 'list_agents without peer is only A');

  ok((await cond.call('send_message', { peer: 'b', agent_id: startedId, text: 'again', wait: true })).text.includes('fake turn'), 'send_message peer=b wait=true');
  const rd = (await cond.call('read_agent', { peer: 'b', agent_id: startedId })).text;
  ok(/\[prompt\] again/.test(rd) && /status: idle/.test(rd), 'read_agent peer=b');
  ok((await cond.call('read_agent', { peer: 'b', agent_id: startedId, result: true })).text === 'fake turn', 'read_agent peer=b result=true');
  const nope = await cond.call('read_agent', { peer: 'b', agent_id: 'nosuch' });
  ok(nope.error && /no agent nosuch .*on peer b/.test(nope.text), 'read_agent peer=b of an unknown agent: "no agent"');

  // a long poll through the proxy: still running after 1s, then finished
  await cond.call('send_message', { peer: 'b', agent_id: startedId, text: 'fake-sleep-4' });
  const w1 = (await cond.call('wait_for_agent', { peer: 'b', agent_id: startedId, timeout_seconds: 1 })).text;
  ok(/status: running/.test(w1) && /still working after 1s/.test(w1), 'wait_for_agent peer=b timeout 1: still running');
  const t0 = Date.now();
  const w2 = (await cond.call('wait_for_agent', { peer: 'b', agent_id: startedId, timeout_seconds: 30 })).text;
  ok(/result: fake turn/.test(w2) && Date.now() - t0 > 1500, `wait_for_agent peer=b blocks until the turn ends (${Date.now() - t0}ms)`);
  await cond.call('send_message', { peer: 'b', agent_id: startedId, text: 'fake-sleep-20' });
  await waitFor(async () => (await B.api('/agents')).j.find((a) => a.id === startedId)?.status === 'running');
  const intr = await cond.call('interrupt_agent', { peer: 'b', agent_id: startedId });
  ok(!intr.error && intr.text === 'interrupted', 'interrupt_agent peer=b');

  // tasks on B
  const at = await cond.call('add_task', { peer: 'b', title: 'peer task', prompt: 'do it', cwd: work });
  const taskId = Number(at.text.match(/added task (\d+)/)?.[1]);
  ok(taskId && /on peer b/.test(at.text), 'add_task peer=b');
  const tB = (await B.api('/tasks/' + taskId)).j;
  ok(tB.addedBy === 'peer:a' && tB.title === 'peer task', 'B: the task is marked added by peer:a');
  ok(!(await A.api('/tasks')).j.length, 'A: no task added here');
  ok(/peer task/.test((await cond.call('list_tasks', { peer: 'b' })).text), 'list_tasks peer=b');
  ok(/"prompt": "do it"/.test((await cond.call('get_task', { peer: 'b', task_id: taskId })).text), 'get_task peer=b');
  const as = await cond.call('assign_task', { peer: 'b', task_id: taskId });
  const taskAgent = as.text.match(/on agent (\S+)/)?.[1];
  ok(!as.error && taskAgent && /on peer b/.test(as.text), 'assign_task peer=b starts an agent on B: ' + as.text);
  ok((await B.api('/agents')).j.find((a) => a.id === taskAgent)?.startedBy === 'peer:a', 'B: the task agent is marked started by peer:a');

  ok(!(await cond.call('list_sessions', { peer: 'b' })).error, 'list_sessions peer=b');
  ok(/^claude( \(default\))?: /m.test((await cond.call('list_accounts', { peer: 'b' })).text), 'list_accounts peer=b');

  // errors
  let t1 = Date.now();
  const dead = await cond.call('list_agents', { peer: 'dead' });
  ok(dead.error && /peer "dead" is unreachable/.test(dead.text) && Date.now() - t1 < 5000, `an unreachable peer fails fast and clearly: ${dead.text}`);
  const wt = await cond.call('list_agents', { peer: 'wrongtok' });
  ok(wt.error && /refused the token/.test(wt.text) && !wt.text.includes('not-the-token'), 'a wrong token: clear error without the token');
  const unk = await cond.call('list_agents', { peer: 'nobody' });
  ok(unk.error && /no peer "nobody"/.test(unk.text), 'an unknown peer name');
  const rm = await cond.call('remove_agent', { peer: 'b', agent_id: startedId });
  ok(rm.error && /cannot be used on a peer/.test(rm.text), 'peer= on a tool without peer support is refused, not run locally');
  { const r = await A.api('/peers/b/peers'); ok(r.status === 403 && /limits, instance and stats/.test(r.j?.error), 'the proxy only forwards the allowed API paths, and says which'); }
  ok((await B.api('/peers', 'GET', undefined, { 'x-halay-peer': 'a' })).status === 403, 'a peer call cannot use the receiver\'s peers');
  ok((await B.api('/agents', 'GET', undefined, { 'x-halay-peer': 'bad name!' })).status === 403, 'a bad x-halay-peer name is refused');
  ok((await B.api('/peers', 'GET', undefined, { 'x-swarm-peer': 'a' })).status === 403, 'the old x-swarm-peer header name is still understood (a peer call cannot use the receiver\'s peers)');
  ok((await B.api('/agents', 'GET', undefined, { 'x-swarm-peer': 'bad name!' })).status === 403, 'a bad old-style x-swarm-peer name is refused too');
  ok((await fetch(B.base + '/api/agents', { headers: { 'x-halay-peer': 'a' } })).status === 401, 'a peer call without the token is refused');

  // a regular agent: no peer tools
  const kid = (await A.api('/agents', 'POST', { cwd: work, name: 'plain', parentId: condA.id })).j;
  const plain = mcp(A, kid.id); procs.push(plain); await plain.init();
  const pnames = (await plain.tools()).map((t) => t.name);
  ok(!pnames.includes('list_peers') && !(await plain.tools()).find((t) => t.name === 'start_agent').inputSchema.properties.peer, 'a regular agent has no list_peers and no peer parameter');
  ok((await plain.call('list_agents', { peer: 'b' })).error, 'a regular agent passing peer= is refused');

  // no token crosses over
  await sleep(500);
  const envA = fs.existsSync(A.envLog) ? fs.readFileSync(A.envLog, 'utf8') : '', envB = fs.existsSync(B.envLog) ? fs.readFileSync(B.envLog, 'utf8') : '';
  const argA = fs.existsSync(A.argLog) ? fs.readFileSync(A.argLog, 'utf8') : '', argB = fs.existsSync(B.argLog) ? fs.readFileSync(B.argLog, 'utf8') : '';
  ok(envB.length > 0 && envA.length > 0, 'both servers ran fake agents');
  ok(!envA.includes(B.token) && !argA.includes(B.token) && !A.log.includes(B.token), "B's token is not in A's agents' env, arguments or A's log");
  ok(!envB.includes(A.token) && !argB.includes(A.token) && !B.log.includes(A.token), "A's token is not in B's agents' env, arguments or B's log");

  ok((await A.api('/peers/dead', 'DELETE')).status === 200 && !(await A.api('/peers')).j.peers.some((p) => p.name === 'dead'), 'a peer can be removed');
} catch (e) {
  fails++; console.log('FAIL', e);
} finally {
  for (const p of procs) p.kill();
  for (const s of [A, B]) {
    for (const a of (await s.api('/agents').catch(() => ({ j: [] }))).j || []) await s.api('/agents/' + a.id, 'DELETE').catch(() => {});
    s.proc.kill();
  }
  await sleep(300);
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
