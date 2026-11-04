// The conductor (swarm chat) and bots on an ACP backend (the fake ACP agent as `opencode`):
// the conductor runs on an OpenCode account with its prompt and MCP role, accepts edits by itself (OpenCode
// has no auto mode), can't use the built-in subagent tool, and switches back to Claude with its account; a bot on an
// OpenCode account gets its memory edits allowed by the swarm, other edits asked, its account switch changes its CLI,
// and its options are checked against what OpenCode can do.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, startSpare, checker, waitFor } from './lib/spare.mjs';

const c = checker(), ok = c.ok;
process.env.PATH = path.join(ROOT, 'test/fake-acp') + path.delimiter + process.env.PATH;
const s = await startSpare({ tag: 'acproles', env: { HALAY_TERMINAL: '0', HALAY_BACKENDS: 'claude,opencode' } }); // the fake also answers as gemini and cursor-agent
const LOG = path.join(s.dir, 'acp.log');
await s.restart({ FAKE_ACP_LOG: LOG });

const log = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const sent = (method) => log().filter((r) => r.in).map((r) => ({ pid: r.pid, m: JSON.parse(r.in) })).filter((x) => !method || x.m.method === method);
const agentOf = async (id) => (await s.api('/agents')).j.find((a) => a.id === id);
const eventsOf = async (id) => (await s.api(`/agents/${id}?all=1`)).j.events || [];
const idle = (id) => waitFor(async () => (await agentOf(id))?.status === 'idle', 8000);
const lastResult = async (id) => (await eventsOf(id)).findLast((e) => e.type === 'result');
const send = (id, text) => s.api(`/agents/${id}/send`, 'POST', { text });
const approvals = async (id) => (await s.api('/approvals')).j.filter((x) => x.agentId === id);

try {
  // ---- conductor on OpenCode
  const con = (await s.api('/conductor', 'POST', { account: 'opencode' })).j;
  ok(con.backend === 'opencode' && con.account === 'opencode', 'the conductor starts on the OpenCode account');
  ok(con.permissionMode === 'acceptEdits', 'it runs in acceptEdits (OpenCode has no auto mode): ' + con.permissionMode);
  await send(con.id, 'hello conductor'); await idle(con.id);
  const start = log().find((x) => x.start)?.start, cfg = JSON.parse(start?.config || '{}');
  ok(cfg.permission?.task === 'deny', "OpenCode's subagent tool is denied for the conductor");
  const instr = fs.readFileSync(cfg.instructions[0], 'utf8');
  ok(/Accounts available to agents: claude, opencode \(OpenCode\)/.test(instr) && !instr.includes('mcp__swarm__'), 'its instructions are the conductor prompt, with accounts and their CLIs, and plain tool names');
  const env = sent('session/new')[0]?.m.params.mcpServers.find((x) => x.name === 'swarm').env;
  ok(env.some((e) => e.name === 'HALAY_ROLE' && e.value === 'conductor'), "the swarm MCP server gets the conductor's role");
  await send(con.id, 'fake-task'); await idle(con.id);
  ok((await lastResult(con.id))?.result === 'answer=reject' && !(await approvals(con.id)).length, 'a subagent call is refused by the swarm without asking');
  await send(con.id, 'fake-edit:notes.md'); await idle(con.id);
  ok((await lastResult(con.id))?.result === 'answer=once' && !(await approvals(con.id)).length, 'an edit in its folder is allowed without asking (acceptEdits)');
  ok((await s.api('/conductor/account', 'POST', { account: 'claude' })).status === 200, 'the conductor switches to the claude account');
  const back = await agentOf(con.id);
  ok(back.backend === 'claude' && back.permissionMode === 'auto' && !back.model, 'with it the conductor is back on Claude, in auto mode: ' + JSON.stringify({ b: back.backend, m: back.permissionMode }));
  ok((await eventsOf(con.id)).some((e) => e.type === 'context_reset'), 'the switch starts a fresh context');

  // ---- a bot on OpenCode
  ok((await s.api('/bots', 'POST', { name: 'Bad bot', handle: 'badbot', role: 'r', account: 'opencode', permissionMode: 'auto' })).status === 400, "a bot can't use a mode its CLI lacks");
  ok((await s.api('/bots', 'POST', { name: 'Bad bot', handle: 'badbot', role: 'r', account: 'opencode', effort: 'high' })).status === 400, "a bot can't have an effort its CLI lacks");
  const r = await s.api('/bots', 'POST', { name: 'OC bot', handle: 'ocbot', role: 'You keep notes.', account: 'opencode', permissionMode: 'manual' });
  ok(r.status < 300, 'a bot on the OpenCode account is created: ' + r.text.slice(0, 120));
  const bot = (await s.api('/bots')).j.find((b) => b.handle === 'ocbot');
  const bid = await waitFor(async () => (await s.api('/agents')).j.find((a) => a.bot?.handle === 'ocbot')?.id, 5000);
  ok((await agentOf(bid)).backend === 'opencode', "the bot's agent runs on OpenCode");
  ok(fs.existsSync(path.join(bot.dir, 'BOT.md')) && fs.existsSync(path.join(bot.dir, 'memory', 'notes.md')), 'its identity file and memory folder exist');
  ok(!fs.existsSync(path.join(bot.dir, 'CLAUDE.md')), 'a bot on another CLI gets no CLAUDE.md pointer');
  await send(bid, `fake-edit:${path.join(bot.dir, 'memory', 'notes.md')}`); await idle(bid);
  ok((await lastResult(bid))?.result === 'answer=once' && !(await approvals(bid)).length, 'an edit of its memory files is allowed by the swarm without asking');
  await send(bid, `fake-edit:${path.join(s.dir, 'elsewhere.txt')}`);
  const ap = await waitFor(async () => (await approvals(bid))[0], 6000);
  ok(ap?.tool_name === 'Edit', 'an edit elsewhere asks the user');
  await s.api(`/agents/${bid}/permission`, 'POST', { reqId: ap.reqId, decision: 'deny' }); await idle(bid);
  const instrBot = fs.readFileSync(JSON.parse(log().filter((x) => x.start).at(-1).start.config).instructions[0], 'utf8');
  ok(instrBot.includes(path.join(bot.dir, 'BOT.md')) && instrBot.includes('You are a bot'), "its instructions carry the bot prompt, naming its identity file");
  const sw = await s.api('/bots/ocbot', 'PATCH', { account: 'claude' });
  ok(sw.status < 300, 'the bot switches to the claude account: ' + sw.text.slice(0, 120));
  const ba = await agentOf(bid);
  ok(ba.backend === 'claude' && ba.permissionMode === 'manual', 'with it the bot runs on Claude');
} catch (e) {
  ok(false, 'roles test crashed: ' + e.stack);
} finally {
  if (c.fails) console.log(s.log().slice(-3000));
  await s.stop();
}
c.done();
