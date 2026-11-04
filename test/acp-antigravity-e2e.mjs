// The Antigravity backend (backends/antigravity.js) against test/fake-acp/agy, which is shaped after what `agy acp` 1.4.12
// sent in recordings: its launch (nothing but `acp`, in every mode, no plan mode), the swarm's instructions as an appended
// system prompt in session/new's _meta (and again in session/load), the session's models as the model list and
// session/set_model for the agent's, its approvals for shell commands (allow_once and reject_once only: the swarm keeps
// "always"), edits that ask like commands (outside agy's own temp folder) and MCP calls that never ask, tool names (Write/Edit cards, mcp__<server>__<tool>), per-prompt
// token usage, interrupt, resume after a mode change, no extra accounts, and the login check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, startSpare, checker, waitFor } from './lib/spare.mjs';

const c = checker(), ok = c.ok;
process.env.PATH = path.join(ROOT, 'test/fake-acp') + path.delimiter + process.env.PATH;
const s = await startSpare({ tag: 'agy', env: { HALAY_TERMINAL: '0' } });
const LOG = path.join(s.dir, 'acp.log');
await s.restart({ FAKE_ACP_LOG: LOG });

const log = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const startOf = (pid) => log().find((x) => x.start && x.pid === pid)?.start;
const sent = (method) => log().filter((r) => r.in).map((r) => ({ pid: r.pid, m: JSON.parse(r.in) })).filter((x) => !method || x.m.method === method);
const agentOf = async (id) => (await s.api('/agents')).j.find((a) => a.id === id);
const eventsOf = async (id) => (await s.api(`/agents/${id}?all=1`)).j.events || [];
const idle = (id, ms = 8000) => waitFor(async () => (await agentOf(id))?.status === 'idle', ms);
const lastResult = async (id) => (await eventsOf(id)).findLast((e) => e.type === 'result');
const send = (id, text) => s.api(`/agents/${id}/send`, 'POST', { text });
const approval = (id) => waitFor(async () => (await s.api('/approvals')).j.find((x) => x.agentId === id), 8000);
const decide = (id, reqId, decision) => s.api(`/agents/${id}/permission`, 'POST', { reqId, decision });
const toolUse = async (id, name) => (await eventsOf(id)).flatMap((e) => (e.type === 'assistant' ? e.message.content : [])).findLast((b) => b.type === 'tool_use' && b.name === name);
const start = async (body) => { const r = await s.api('/agents', 'POST', { cwd: s.dir, ...body }); if (r.status >= 300) throw new Error(r.text); return r.j.id; };

try {
  // ---- the backend: probe, accounts, capabilities
  const bk = (await s.api('/backends')).j.find((b) => b.id === 'antigravity');
  ok(bk?.installed && bk.label === 'Antigravity' && bk.bin === 'agy', 'agy is usable (its probe finds "Agent Client Protocol" in `agy acp --help`)');
  ok(bk.capabilities.modes.join() === 'manual,acceptEdits,bypassPermissions,cli' && !bk.capabilities.modes.includes('plan') && bk.capabilities.effort.length === 0 && bk.capabilities.appendPrompt && !bk.capabilities.questions, 'capabilities: no plan mode, no effort, appended system prompt, no question tool: ' + JSON.stringify(bk.capabilities));
  ok(bk.addAccounts === 'Antigravity keeps its login in the OS keyring, one per user: use the antigravity account' && bk.accounts.join() === 'antigravity', 'no accounts to add (the login is in the keyring), the default account exists');
  ok((await s.api('/accounts', 'POST', { backend: 'antigravity', name: 'second' })).status === 400, 'adding an account is refused');
  const ms = (await s.api('/backends/antigravity/models')).j;
  ok(ms.join() === 'gemini-3.8-flash-high,gemini-3.8-flash-medium,gemini-3.8-flash-low', "the model list is what a session offers (not `agy models`, which lists ids ACP refuses): " + ms.join());
  const newOnly = sent('session/new').at(-1);
  ok(newOnly && newOnly.m.params.mcpServers.length === 0, 'listed from a throwaway session without MCP servers');

  // ---- launch, system prompt, MCP servers, model, usage
  const a = await start({ name: 'agy1', backend: 'antigravity', model: 'gemini-3.8-flash-low', prompt: 'hello agy' });
  ok(await idle(a), 'an antigravity agent answers');
  let pid = sent('session/prompt').at(-1).pid;
  ok(startOf(pid).argv.join(' ') === 'acp', 'launched as `agy acp` and nothing else: ' + startOf(pid).argv.join(' '));
  const ns = sent('session/new').find((x) => x.pid === pid).m.params;
  const append = ns._meta?.antigravity?.systemPrompt?.append;
  ok(typeof append === 'string' && append.includes('start_agent') && !/mcp__|AskUserQuestion|ExitPlanMode/.test(append), "session/new carries the swarm's instructions as _meta.antigravity.systemPrompt.append, in neutral tool names");
  ok(sent('session/prompt').at(-1).m.params.prompt[0].text === 'hello agy', 'and the first message goes as written, without a preamble');
  ok(ns.mcpServers[0]?.name === 'swarm' && ns.mcpServers[0].args[0].endsWith('swarm-mcp.js') && ns.mcpServers[0].env.some((e) => e.name === 'HALAY_AGENT' && e.value === a), 'the swarm MCP server goes in session/new with env as { name, value } pairs');
  const sm = sent('session/set_model').find((x) => x.pid === pid)?.m.params;
  ok(sm?.modelId === 'gemini-3.8-flash-low', 'the agent\'s model is set with session/set_model');
  await send(a, 'fake-system'); await idle(a);
  ok(/^system=(?!none)\S.* model=gemini-3.8-flash-low$/.test((await lastResult(a))?.result), 'the model runs with the appended prompt and the chosen model: ' + (await lastResult(a))?.result);
  const res = await lastResult(a);
  ok(res.usage?.input_tokens === 10 && res.usage.output_tokens === 7 && res.usage.cache_read_input_tokens === 100 && res.total_cost_usd === undefined, 'usage: tokens from the prompt result (thoughts counted as output), no cost: ' + JSON.stringify(res.usage));
  ok(!(await eventsOf(a)).some((e) => e.type === 'system' && e.subtype === 'context'), 'no context size (agy sends none)');

  // ---- modes: plan is not offered
  ok((await s.api(`/agents/${a}/mode`, 'POST', { permissionMode: 'plan' })).status === 400, 'plan mode is refused');
  ok((await start({ name: 'x', backend: 'antigravity', effort: 'high' }).catch((e) => e.message)).includes('no effort'), 'and so is an effort');

  // ---- approvals: a command asks, allow/deny map onto its allow_once/reject_once, "always" is the swarm's
  await send(a, 'fake-tool:git status -s'); let ap = await approval(a);
  ok(ap?.tool_name === 'Bash' && ap.preview === 'git status -s' && ap.rule === 'Bash(git status:*)', 'a command asks, shown as Bash with its CommandLine: ' + JSON.stringify(ap));
  await decide(a, ap.reqId, 'allow'); await idle(a);
  ok((await lastResult(a))?.result === 'answer=allow', 'allow answers with its allow option');
  await send(a, 'fake-tool:ls'); ap = await approval(a);
  await decide(a, ap.reqId, 'deny'); await idle(a);
  ok((await lastResult(a))?.result === 'answer=deny', 'deny answers with its deny option');
  ok((await eventsOf(a)).some((e) => e.type === 'user' && e.message.content.some((x) => x.type === 'tool_result' && x.is_error)), 'a refused call shows as a failed tool_result');
  await send(a, 'fake-nofail fake-tool:ls -a'); ap = await approval(a);
  await decide(a, ap.reqId, 'deny'); await idle(a);
  ok((await eventsOf(a)).filter((e) => e.type === 'user' && e.message.content.some((x) => x.type === 'tool_result' && x.is_error && x.content === 'Denied by user')).length === 1, 'a refused call whose end agy never reports is closed with a failed tool_result when the turn ends');
  await send(a, 'fake-tool:git status'); ap = await approval(a);
  await decide(a, ap.reqId, 'always'); await idle(a);
  ok((await lastResult(a))?.result === 'answer=allow', '"always" is answered with the only allow it has');
  const asked = (await s.api('/approvals')).j.length;
  await send(a, 'fake-tool:git status -sb'); await idle(a);
  ok((await lastResult(a))?.result === 'answer=allow' && (await s.api('/approvals')).j.length === asked, 'the same command (more arguments) is then allowed by the swarm without asking');
  await send(a, 'fake-tool:git status -s; rm x'); ap = await approval(a);
  ok(ap?.tool_name === 'Bash', 'but not one that adds another command: ' + JSON.stringify(ap?.preview));
  await decide(a, ap.reqId, 'deny'); await idle(a);
  await send(a, 'fake-tool:git push'); ap = await approval(a);
  ok(ap?.tool_name === 'Bash', 'nor another subcommand');
  await decide(a, ap.reqId, 'deny'); await idle(a);

  // ---- edits ask in manual mode (agy asks for them outside its own temp folder), MCP calls never do; their cards
  const f = path.join(s.dir, 'notes.md');
  await send(a, 'fake-write:' + f); ap = await approval(a);
  ok(ap?.tool_name === 'Write' && ap.preview === f, 'write_file asks, shown as Write with its path: ' + JSON.stringify(ap));
  await decide(a, ap.reqId, 'allow'); await idle(a);
  let tu = await toolUse(a, 'Write');
  ok(tu?.input.file_path === f && tu.input.content === 'hi\n', 'write_file shows as a Write card with its path and content: ' + JSON.stringify(tu?.input));
  await send(a, 'fake-edit:' + f); ap = await approval(a);
  ok(ap?.tool_name === 'Edit', 'edit_file asks, shown as Edit');
  await decide(a, ap.reqId, 'allow'); await idle(a);
  tu = await toolUse(a, 'Edit');
  ok(tu?.input.file_path === f && tu.input.old_string === 'foo' && tu.input.new_string === 'baz', 'edit_file shows as an Edit card: ' + JSON.stringify(tu?.input));
  await send(a, 'fake-mcp:swarm_list_agents'); await idle(a);
  tu = await toolUse(a, 'mcp__swarm__list_agents');
  ok(tu && tu.input.name === 'bob' && !('toolSummary' in tu.input), 'an MCP call is named mcp__swarm__list_agents, without its toolSummary: ' + JSON.stringify(tu));
  ok((await s.api('/approvals')).j.length === 0, 'and it did not ask');
  await send(a, 'fake-search'); await idle(a);
  ok((await toolUse(a, 'WebSearch'))?.input.query === 'site:example.com', 'search_web shows as a WebSearch card');

  // ---- acceptEdits: the swarm allows edits inside the agent's folder, commands still ask; bypass allows everything
  ok((await s.api(`/agents/${a}/mode`, 'POST', { permissionMode: 'acceptEdits' })).status === 200, 'acceptEdits is accepted');
  await send(a, 'fake-write:' + f); await idle(a);
  ok((await s.api('/approvals')).j.length === 0, 'in acceptEdits a write inside the folder is allowed by the swarm without asking');
  await send(a, 'fake-write:' + path.join(os.homedir(), '.zshrc-swarm-test')); ap = await approval(a);
  ok(ap?.tool_name === 'Write', 'one outside the folder still asks');
  await decide(a, ap.reqId, 'deny'); await idle(a);
  await send(a, 'fake-tool:echo one'); ap = await approval(a);
  ok(ap?.tool_name === 'Bash', 'and a command still asks');
  await decide(a, ap.reqId, 'allow'); await idle(a);
  const pids = new Set(log().filter((x) => x.start).map((x) => x.pid));
  ok(startOf(sent('session/prompt').at(-1).pid).argv.join(' ') === 'acp', 'the mode adds no flag');
  ok((await s.api(`/agents/${a}/mode`, 'POST', { permissionMode: 'bypassPermissions' })).status === 200, 'bypassPermissions is accepted');
  await send(a, 'fake-tool:echo two'); await idle(a);
  ok((await lastResult(a))?.result === 'answer=allow' && (await s.api('/approvals')).j.length === 0, 'in bypassPermissions the swarm allows the command by itself');
  ok(startOf(sent('session/prompt').at(-1).pid).argv.join(' ') === 'acp', 'and agy gets no --dangerously-skip-permissions');

  // ---- resume: a mode change restarts the process, which loads the session and gives the instructions again
  const load = sent('session/load').at(-1);
  ok(load && !pids.has(load.pid) && load.m.params.sessionId === (await eventsOf(a)).findLast((e) => e.session_id).session_id, 'the new process resumed the session with session/load');
  ok(load.m.params._meta?.antigravity?.systemPrompt?.append === append, 'and appended the instructions again');
  ok(!(await eventsOf(a)).some((e) => JSON.stringify(e).includes('old reply (replayed)')), 'the history session/load replays is not shown again');

  // ---- cli mode and interrupt
  const b = await start({ name: 'agy2', backend: 'antigravity', permissionMode: 'cli', prompt: 'hi' });
  await idle(b);
  ok(startOf(sent('session/prompt').at(-1).pid).argv.join(' ') === 'acp', 'cli mode starts it with nothing else');
  await send(a, 'fake-sleep-30');
  await new Promise((r) => setTimeout(r, 300));
  await s.api(`/agents/${a}/interrupt`, 'POST', {});
  ok(await idle(a, 4000) && sent('session/cancel').length >= 1 && (await lastResult(a))?.stop_reason === 'cancelled', 'interrupt sends session/cancel and the turn ends cancelled');
  await send(a, 'after the interrupt'); await idle(a);
  ok((await lastResult(a))?.result.endsWith('after the interrupt'), 'the same session carries on');

  // ---- Settings → Accounts: `agy models` says whether it is signed in (on stderr when it is not)
  let acs = (await s.api('/accounts?refresh=1')).j;
  const acc = () => acs.find((x) => x.name === 'antigravity');
  ok(acc()?.loggedIn === true && acc().fix === 'agy   # then sign in with Google', 'logged in: ' + JSON.stringify(acc()));
  await s.restart({ FAKE_ACP_LOG: LOG, FAKE_AGY_NOAUTH: '1' });
  acs = (await s.api('/accounts?refresh=1')).j;
  ok(acc()?.loggedIn === false && /^agy\b/.test(acc().fix), 'signed out shows as logged out with the command to sign in: ' + JSON.stringify(acc()));
  const nl = await start({ name: 'nologin', backend: 'antigravity', prompt: 'hi' });
  ok(await idle(nl) && /could not start a session: Please sign in/.test((await lastResult(nl))?.result || ''), 'an agent without a login ends its turn saying so');
} catch (e) {
  ok(false, 'antigravity test crashed: ' + e.stack);
} finally {
  if (c.fails) console.log(s.log().slice(-3000));
  for (const x of (await s.api('/agents')).j || []) await s.api(`/agents/${x.id}`, 'DELETE'); // the fake agy never sees EOF: end its processes
  await s.stop();
}
c.done();
