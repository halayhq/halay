// Child -> parent turn notifications with the ACP backends (OpenCode, Gemini CLI, Cursor), against the fake ACP agent
// (test/fake-acp). Parents and children on different CLIs: the notification reaches an ACP parent as a session/prompt,
// an ACP child's end_turn / cancel / crash / permission request turn into finished / stopped / blocked notices, a busy ACP
// parent gets them coalesced after its turn, and wait_for_agent on an ACP child still suppresses them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, startSpare, checker, waitFor, agentToken, sleep } from './lib/spare.mjs';

const c = checker();
process.env.PATH = path.join(ROOT, 'test/fake-acp') + path.delimiter + process.env.PATH;
const CURSOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-home-'));
fs.writeFileSync(path.join(CURSOR_HOME, 'cli-config.json'), JSON.stringify({ permissions: { allow: [] } }));
fs.mkdirSync(path.join(CURSOR_HOME, 'acp-sessions'));
const s = await startSpare({ tag: 'anotacp', env: { HALAY_TERMINAL: '0', HALAY_NOTIFY_BLOCKED_SECS: '1', CURSOR_CONFIG_DIR: CURSOR_HOME } });
const LOG = path.join(s.dir, 'acp.log');
await s.restart({ FAKE_ACP_LOG: LOG });
const prompts = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.in).map((r) => JSON.parse(r.in)).filter((m) => m.method === 'session/prompt').map((m) => JSON.stringify(m.params.prompt)); } catch { return []; } };

const as = (tok) => async (p, method = 'GET', body) => {
  const r = await fetch(s.base + p, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
};
const agent = async (id) => (await s.api(`/agents/${id}?all=1`)).j;
const notes = async (id) => (await agent(id)).events.filter((e) => e.type === 'user_prompt' && e.agentNotify);
const about = async (p, kid) => (await notes(p)).filter((e) => e.agentNotify.includes(kid));
const idle = (id, ms = 15000) => waitFor(async () => (await agent(id)).status === 'idle', ms);
const start = async (body) => { const r = await s.api('/agents', 'POST', { cwd: s.dir, ...body }); if (r.status >= 300) throw new Error(r.text); return r.j.id; };

try {
  // ---- an OpenCode parent with a Gemini child
  const P = await start({ name: 'OC parent', backend: 'opencode', prompt: 'hi' });
  c.ok(!!await idle(P), 'the OpenCode parent is up and idle');
  const par = as(agentToken(s, P));
  const spawn = async (body) => { const r = await par('/api/agents', 'POST', { cwd: s.dir, ...body }); if (r.status !== 201) throw new Error('spawn: ' + r.text); return r.j; };

  const g = await spawn({ name: 'Gem kid', backend: 'gemini', prompt: 'do it' });
  c.ok(g.backend === 'gemini' && g.parentId === P, 'a Gemini child of an OpenCode parent');
  let n = await waitFor(async () => (await about(P, g.id))[0], 10000);
  c.ok(!!n && /finished its turn/.test(n.text) && n.text.includes('"Gem kid"'), 'Gemini child -> OpenCode parent: woken: ' + n?.text.split('\n')[2]);
  c.ok(!!await waitFor(() => prompts().some((p) => p.includes('[agent notification]') && p.includes(g.id)), 5000), 'it reached the OpenCode process as a session/prompt');
  c.ok(!!await idle(P), 'the parent answered it (end_turn) and is idle');

  // ---- a Cursor child
  const cu = await spawn({ name: 'Cur kid', backend: 'cursor', prompt: 'go' });
  n = await waitFor(async () => (await about(P, cu.id))[0], 15000);
  c.ok(cu.backend === 'cursor' && !!n && /finished its turn/.test(n.text), 'Cursor child -> OpenCode parent: woken');
  await idle(P);

  // ---- busy ACP parent: coalesced after its turn
  await s.api(`/agents/${P}/send`, 'POST', { text: 'busy fake-sleep-3' });
  await waitFor(async () => (await agent(P)).status === 'running', 3000);
  await par(`/api/agents/${g.id}/send`, 'POST', { text: 'again' });
  await par(`/api/agents/${cu.id}/send`, 'POST', { text: 'again' });
  await idle(g.id); await idle(cu.id); await sleep(300);
  c.ok((await agent(P)).status === 'running' && (await about(P, g.id)).length === 1, 'busy OpenCode parent: nothing delivered mid-turn');
  n = await waitFor(async () => (await notes(P)).find((e) => e.agentNotify.length === 2), 10000);
  c.ok(!!n && n.agentNotify.includes(g.id) && n.agentNotify.includes(cu.id), 'then one coalesced notification for both children');
  await idle(P);

  // ---- a Claude parent with an OpenCode child
  const C = await start({ name: 'Claude parent', prompt: 'hi', permissionMode: 'manual' });
  await idle(C);
  const cpar = as(agentToken(s, C));
  const oc = (await cpar('/api/agents', 'POST', { cwd: s.dir, name: 'OC kid', backend: 'opencode', prompt: 'x' })).j;
  n = await waitFor(async () => (await about(C, oc.id))[0], 10000);
  c.ok(oc.backend === 'opencode' && !!n && /finished its turn/.test(n.text), 'OpenCode child -> Claude parent: woken');
  await idle(C);

  // ---- ACP permission request: blocked notice, then the finished turn
  const before = (await about(P, g.id)).length;
  await par(`/api/agents/${g.id}/send`, 'POST', { text: 'fake-tool' });
  n = await waitFor(async () => (await about(P, g.id)).find((e) => /BLOCKED/.test(e.text)), 8000);
  c.ok(!!n && /approval/.test(n.text), 'Gemini child blocked on an ACP permission request: parent told: ' + n?.text.split('\n')[2]?.slice(0, 120));
  const ap = await waitFor(async () => (await s.api('/approvals')).j.find((x) => x.agentId === g.id), 5000);
  await s.api(`/approvals/${ap.reqId}`, 'POST', { decision: 'allow' });
  n = await waitFor(async () => (await about(P, g.id)).length === before + 2 && (await about(P, g.id)).at(-1), 10000);
  c.ok(!!n && /finished its turn/.test(n.text) && n.text.includes('answer=once'), 'then notified when the turn ends, with its result');
  await idle(P);

  // ---- interrupt (session/cancel): by the user -> "stopped"; by the parent -> no notification
  await par(`/api/agents/${g.id}/send`, 'POST', { text: 'fake-sleep-8' });
  await waitFor(async () => (await agent(g.id)).status === 'running', 3000); await sleep(300);
  await s.api(`/agents/${g.id}/interrupt`, 'POST');
  n = await waitFor(async () => (await about(P, g.id)).find((e) => /stopped before finishing/.test(e.text)), 8000);
  c.ok(!!n, 'interrupted by the user (ACP cancelled): the parent is told it stopped');
  await idle(P); await idle(g.id);
  const k = (await about(P, g.id)).length;
  await par(`/api/agents/${g.id}/send`, 'POST', { text: 'fake-sleep-8' });
  await waitFor(async () => (await agent(g.id)).status === 'running', 3000); await sleep(300);
  await par(`/api/agents/${g.id}/interrupt`, 'POST');
  await idle(g.id); await sleep(800);
  c.ok((await about(P, g.id)).length === k, 'interrupted by the parent itself: no notification');

  // ---- crash mid-turn
  await par(`/api/agents/${cu.id}/send`, 'POST', { text: 'fake-crash' });
  n = await waitFor(async () => (await about(P, cu.id)).find((e) => /stopped before finishing/.test(e.text)), 8000);
  c.ok(!!n, 'Cursor child process crashed mid-turn: the parent is told it stopped');
  await idle(P);

  // ---- wait_for_agent on an ACP child suppresses the notification
  const k2 = (await about(P, g.id)).length;
  await par(`/api/agents/${g.id}/send`, 'POST', { text: 'fake-sleep-2' });
  const w = await par(`/api/agents/${g.id}/wait`, 'POST', { timeout: 20 });
  await sleep(800);
  c.ok(w.j.status === 'idle' && (await about(P, g.id)).length === k2, 'wait_for_agent on a Gemini child: result returned, no notification');

  // ---- opt-out on an ACP child
  const q = await spawn({ name: 'Quiet OC', backend: 'opencode', prompt: 'x', notify: false });
  await idle(q.id); await sleep(800);
  c.ok(q.notify === false && !(await about(P, q.id)).length, 'notify=false on an OpenCode child: no notification');
} catch (e) {
  c.ok(false, 'crashed: ' + e.stack);
  console.log(s.log().slice(-3000));
} finally {
  await s.stop();
  fs.rmSync(CURSOR_HOME, { recursive: true, force: true });
}
c.done();
