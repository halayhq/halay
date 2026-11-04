// ACP backends end to end, against the fake ACP agent test/fake-acp/opencode on a spare
// server: backend and account selection, capability checks, the launch (config env, instructions file, MCP servers),
// a chat turn translated into swarm events, approvals (allow, always, deny), the swarm's own mode policy (swarm tools,
// acceptEdits), plan and model as session options, resume with session/load after a restart of the process, queued
// mid-turn messages, interrupt (session/cancel), a crash, and a server restart with a permission request still open.
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, startSpare, checker, waitFor, sleep } from './lib/spare.mjs';

const c = checker(), ok = c.ok;
process.env.PATH = path.join(ROOT, 'test/fake-acp') + path.delimiter + process.env.PATH;
const s = await startSpare({ tag: 'acp', env: { HALAY_TERMINAL: '0', HALAY_BACKENDS: 'claude,opencode' } }); // the fake also answers as gemini and cursor-agent
const LOG = path.join(s.dir, 'acp.log');
await s.restart({ FAKE_ACP_LOG: LOG });

const log = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const sent = (method) => log().filter((r) => r.in).map((r) => ({ pid: r.pid, m: JSON.parse(r.in) })).filter((x) => !method || x.m.method === method);
const agentOf = async (id) => (await s.api('/agents')).j.find((a) => a.id === id);
const eventsOf = async (id) => (await s.api(`/agents/${id}?all=1`)).j.events || [];
const idle = (id, ms = 8000) => waitFor(async () => (await agentOf(id))?.status === 'idle', ms);
const lastResult = async (id) => (await eventsOf(id)).findLast((e) => e.type === 'result');
const send = (id, text) => s.api(`/agents/${id}/send`, 'POST', { text });
const approval = (id) => waitFor(async () => (await s.api('/approvals')).j.find((x) => x.agentId === id), 8000);
const decide = (id, reqId, decision) => s.api(`/agents/${id}/permission`, 'POST', { reqId, decision });
const results = (id) => eventsOf(id).then((ev) => ev.filter((e) => e.type === 'result').length);

try {
  // ---- backends, accounts, selection and capability checks
  const backends = (await s.api('/backends')).j;
  const oc = backends.find((b) => b.id === 'opencode');
  ok(oc && oc.installed && oc.accounts.includes('opencode'), 'GET /api/backends lists opencode as installed with its account');
  ok(backends.find((b) => b.id === 'claude')?.capabilities.modes.includes('auto'), 'claude is listed with its modes');
  ok(JSON.stringify((await s.api('/backends/opencode/models')).j) === '["opencode/big-pickle","opencode/other"]', 'GET /api/backends/opencode/models lists the CLI\'s models');
  ok((await s.api('/backends/claude/models')).j.length === 0 && (await s.api('/backends/nope/models')).status === 404, 'claude has no server-side list (the UI has its own); unknown backends 404');
  const accts = (await s.api('/accounts')).j;
  ok(accts.find((a) => a.name === 'opencode')?.backend === 'opencode' && accts.find((a) => a.name === 'claude')?.backend === 'claude', '/api/accounts gives each account its backend');
  const bad = async (body, re, m) => { const r = await s.api('/agents', 'POST', { cwd: s.dir, name: 'x', ...body }); ok(r.status === 400 && re.test(r.j.error || ''), m + ` (${r.status} ${r.j.error})`); };
  await bad({ backend: 'opencode', permissionMode: 'auto' }, /can't use permission mode auto/, "an explicit mode the backend lacks is refused");
  await bad({ backend: 'opencode', effort: 'high' }, /no effort/, 'effort is refused for a backend without it');
  await bad({ backend: 'opencode', lean: true }, /lean/, 'lean is refused for a backend without it');
  await bad({ backend: 'claude', account: 'opencode' }, /is a OpenCode account/, 'an account of another backend is refused');
  await bad({ backend: 'nope' }, /unknown backend/, 'an unknown backend is refused');

  // ---- a plain turn
  const r = await s.api('/agents', 'POST', { cwd: s.dir, name: 'oc', backend: 'opencode', prompt: 'hello world' });
  ok(r.status < 300 && r.j.id, 'an opencode agent starts: ' + r.text.slice(0, 200));
  const id = r.j.id;
  let a = await agentOf(id);
  ok(a.backend === 'opencode' && a.account === 'opencode', 'the agent has backend and account opencode');
  ok(a.permissionMode === 'manual', "the default mode (auto, which OpenCode lacks) falls back to manual: " + a.permissionMode);
  ok(await idle(id), 'the turn ends: the agent is idle');
  const start = log().find((x) => x.start)?.start;
  ok(start && start.argv.join(' ') === 'acp' && start.cwd === fs.realpathSync(s.dir), 'launched as `opencode acp` in the agent folder');
  const cfg = JSON.parse(start?.config || '{}');
  ok(cfg.permission?.edit === 'ask' && cfg.permission?.bash === 'ask' && cfg.permission?.task === 'deny', "OPENCODE_CONFIG_CONTENT makes edits and shell ask (the swarm decides) and turns OpenCode's own subagents off (the default: swarm agents only)");
  const instr = cfg.instructions?.[0] && fs.readFileSync(cfg.instructions[0], 'utf8');
  ok(instr && instr.includes('start_agent') && !instr.includes('mcp__swarm__'), 'the swarm prompt is an instructions file, with plain tool names');
  const sn = sent('session/new')[0]?.m.params;
  const sw = sn?.mcpServers?.find((x) => x.name === 'swarm');
  ok(sw && sw.args[0].endsWith('swarm-mcp.js') && sw.env.some((e) => e.name === 'HALAY_AGENT' && e.value === id), 'session/new gets the swarm MCP server with this agent\'s env');
  ok(sn?.cwd === s.dir, 'session/new gets the agent folder');
  let ev = await eventsOf(id);
  const asst = ev.find((e) => e.type === 'assistant' && e.message.content.some((x) => x.type === 'text'));
  ok(asst && asst.message.content[0].type === 'thinking' && asst.message.content[1].text === 'fake reply: hello world', 'thought and reply chunks become one assistant message (thinking + text)');
  const res = ev.findLast((e) => e.type === 'result');
  ok(res && res.result === 'fake reply: hello world' && !res.is_error && res.usage?.input_tokens === 10 && res.usage?.cache_read_input_tokens === 100, 'the prompt response becomes a result with the reply and usage');
  a = await agentOf(id);
  ok(a.context === 1235, 'usage_update sets the context size: ' + a.context);
  ok(Math.abs((a.usage?.cost || 0) - 0.25) < 1e-9 && a.usage?.turns === 1, 'the turn cost (from usage_update) is recorded: ' + JSON.stringify(a.usage));
  ok(ev.some((e) => e.type === 'system' && e.subtype === 'init' && e.model === 'opencode/big-pickle'), 'a system/init event names the model');

  // ---- approvals: allow, always, deny
  await send(id, 'fake-tool please');
  let ap = await approval(id);
  ok(ap && ap.tool_name === 'Bash' && /ls -la/.test(ap.preview) && ap.rule === 'Bash(ls:*)', 'a shell call asks the user, as Bash with its command: ' + JSON.stringify(ap && { t: ap.tool_name, p: ap.preview, r: ap.rule }));
  ok((await decide(id, ap.reqId, 'allow')).status === 200, 'allow is accepted');
  await idle(id);
  ok((await lastResult(id))?.result === 'answer=once', 'allow reaches the agent as allow_once');
  ev = await eventsOf(id);
  const tu = ev.find((e) => e.type === 'assistant' && e.message.content.some((x) => x.type === 'tool_use' && x.id === 'call-tool'));
  ok(tu && tu.message.content[0].name === 'Bash' && tu.message.content[0].input.command === 'ls -la', 'the call shows as a Bash tool_use');
  ok(ev.some((e) => e.type === 'user' && e.message.content.some((x) => x.type === 'tool_result' && x.tool_use_id === 'call-tool' && x.content === 'file listing' && !x.is_error)), 'its output shows as the tool_result');
  ok(ev.filter((e) => e.type === 'assistant' && e.message.content.some((x) => x.id === 'call-tool')).length === 1, 'the tool_use is shown once');
  await send(id, 'fake-tool again');
  ap = await approval(id); await decide(id, ap.reqId, 'always'); await idle(id);
  ok((await lastResult(id))?.result === 'answer=always', '"always" picks allow_always');
  await send(id, 'fake-tool no');
  ap = await approval(id); await decide(id, ap.reqId, 'deny'); await idle(id);
  ok((await lastResult(id))?.result === 'answer=reject', 'deny picks reject_once');
  ok((await eventsOf(id)).some((e) => e.type === 'user' && e.message.content.some((x) => x.type === 'tool_result' && x.is_error)), 'a rejected call shows as a failed tool_result');

  // ---- the swarm's policy: swarm tools are allowed without asking; acceptEdits allows edits
  const before = (await s.api('/approvals')).j.length;
  await send(id, 'fake-task'); await idle(id);
  ok((await lastResult(id))?.result === 'answer=reject' && (await s.api('/approvals')).j.length === before, 'a built-in subagent call is refused by the swarm without asking');
  await send(id, 'fake-swarm'); await idle(id);
  ok((await lastResult(id))?.result === 'answer=once' && (await s.api('/approvals')).j.length === before, 'a swarm MCP tool is allowed without asking');
  await send(id, 'fake-edit'); ap = await approval(id);
  ok(ap?.tool_name === 'Edit', 'in manual mode an edit asks, shown as Edit');
  await decide(id, ap.reqId, 'allow'); await idle(id);
  const sid = (await agentOf(id)) && (await eventsOf(id)).findLast((e) => e.session_id)?.session_id;
  ok((await s.api(`/agents/${id}/mode`, 'POST', { permissionMode: 'auto' })).status === 400, "switching to a mode the backend lacks is refused");
  ok((await s.api(`/agents/${id}/mode`, 'POST', { permissionMode: 'acceptEdits' })).status === 200, 'switching to acceptEdits works');
  const pids = new Set(log().filter((x) => x.start).map((x) => x.pid));
  await send(id, 'fake-edit:notes.md'); await idle(id);
  ok((await lastResult(id))?.result === 'answer=once', 'in acceptEdits an edit in its folder is allowed by the swarm without asking');
  // outside its folder (a shell startup file, another repo's hooks) it asks, as Claude Code's acceptEdits does
  await send(id, 'fake-edit:' + path.join(os.homedir(), '.zshrc-swarm-test')); ap = await approval(id);
  ok(ap?.tool_name === 'Edit', 'in acceptEdits an edit outside its folder still asks: ' + JSON.stringify(ap?.input?.file_path));
  if (ap) { await decide(id, ap.reqId, 'deny'); await idle(id); }
  await send(id, 'fake-edit:../outside.txt'); ap = await approval(id);
  ok(ap?.tool_name === 'Edit', 'and so does a relative path that leads out of it');
  if (ap) { await decide(id, ap.reqId, 'deny'); await idle(id); }
  const load = sent('session/load').at(-1);
  ok(load && load.m.params.sessionId === sid && !pids.has(load.pid), 'the mode change restarted the process, which resumed the session with session/load');
  ok(!(await eventsOf(id)).some((e) => JSON.stringify(e).includes('old reply (replayed)')), 'the history session/load replays is not shown again');

  // ---- plan mode and model are session config options
  await s.api(`/agents/${id}/mode`, 'POST', { permissionMode: 'plan' });
  ok((await s.api(`/agents/${id}/model`, 'POST', { model: 'opencode/other' })).status === 200, 'a model change is accepted');
  ok((await s.api(`/agents/${id}/model`, 'POST', { effort: 'high' })).status === 400, 'an effort change is refused');
  await send(id, 'hi in plan'); await idle(id);
  const opts = sent('session/set_config_option').map((x) => x.m.params);
  ok(opts.some((o) => o.configId === 'model' && o.value === 'opencode/other') && opts.some((o) => o.configId === 'mode' && o.value === 'plan'), 'model and plan mode are set with session/set_config_option');
  const order = sent().map((x) => x.m.method).filter(Boolean);
  ok(order.lastIndexOf('session/set_config_option') < order.lastIndexOf('session/prompt'), 'the options are set before the prompt');

  // ---- plan approval: OpenCode has none over ACP, so in plan mode it gets the swarm's submit_plan (a plan card)
  const pp = sent('session/prompt').at(-1).pid;
  const swp = [...sent('session/load'), ...sent('session/new')].find((x) => x.pid === pp).m.params.mcpServers.find((x) => x.name === 'swarm');
  const penv = Object.fromEntries(swp.env.map((e) => [e.name, e.value]));
  ok(penv.HALAY_PLAN_TOOL === '1', 'in plan mode its swarm MCP server offers submit_plan');
  const pinstr = JSON.parse(log().find((r) => r.pid === pp && r.start).start.config).instructions[0];
  ok(/Plan mode: .*submit_plan/.test(fs.readFileSync(pinstr, 'utf8')), 'and its instructions say to use it');
  const mcpCall = (env, name, args) => new Promise((resolve) => {
    const ch = spawn(swp.command, swp.args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    ch.stdout.on('data', (d) => { buf += d; const l = buf.split('\n').find((x) => x.includes('"id":7')); if (l) { ch.kill(); resolve(JSON.parse(l).result); } });
    ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  const { HALAY_PLAN_TOOL: _, ...noPlanEnv } = penv;
  ok((await mcpCall(noPlanEnv, 'submit_plan', { plan: 'x' }))?.isError, 'without plan mode the tool is not there');
  const rejected = mcpCall(penv, 'submit_plan', { plan: '# Rename\n\n1. rename a to b' });
  let pc = await approval(id);
  ok(pc?.tool_name === 'ExitPlanMode' && /# Rename[\s\S]*rename a to b/.test(pc.preview), 'submit_plan shows a plan card: ' + JSON.stringify(pc?.preview));
  await decide(id, pc.reqId, 'deny');
  ok(/rejected the plan[\s\S]*still in plan mode/.test((await rejected)?.content?.[0]?.text) && (await agentOf(id)).permissionMode === 'plan', 'rejecting tells the model and keeps plan mode');
  const nTurns = await results(id);
  await send(id, 'fake-sleep-2');
  await sleep(300);
  const approved = mcpCall(penv, 'submit_plan', { plan: '# Rename\n\n1. rename a to b' });
  pc = await approval(id);
  await decide(id, pc.reqId, 'allow');
  ok(/approved the plan[\s\S]*End your turn/.test((await approved)?.content?.[0]?.text), 'approving tells the model to end its turn');
  ok((await agentOf(id)).permissionMode === 'manual', 'the agent leaves plan mode for manual');
  ok(await waitFor(async () => (await results(id)) === nTurns + 2 && (await agentOf(id)).status === 'idle', 10000), 'its turn ends, and the next one runs');
  const after = sent().filter((x) => x.pid === pp).map((x) => x.m.method === 'session/set_config_option' ? `mode=${x.m.params.value}` : x.m.method === 'session/prompt' ? x.m.params.prompt[0].text.slice(0, 20) : null).filter(Boolean);
  ok(after.slice(-3).join('|') === 'fake-sleep-2|mode=build|The plan is approved', 'between the turns, the same process switches to build, then is told to implement: ' + after.slice(-3).join('|'));
  await s.api(`/agents/${id}/mode`, 'POST', { permissionMode: 'manual' });

  // ---- plan updates become the todo list
  await send(id, 'fake-plan'); await idle(id);
  a = await agentOf(id);
  ok(a.todos?.length === 2 && a.todos[1].status === 'in_progress' && a.todos[0].content === 'first step', 'a plan update becomes the todo list: ' + JSON.stringify(a.todos));

  // ---- a message sent mid-turn is queued and sent when the turn ends
  const n0 = await results(id);
  await send(id, 'fake-sleep-2');
  await sleep(300);
  await send(id, 'queued follow-up');
  ev = await eventsOf(id);
  ok(ev.some((e) => e.type === 'note' && /Queued/.test(e.text)), 'a mid-turn message is noted as queued');
  ok(await waitFor(async () => (await results(id)) === n0 + 2 && (await agentOf(id)).status === 'idle', 10000), 'both turns finish');
  const prompts = sent('session/prompt').map((x) => x.m.params.prompt[0].text);
  ok(prompts.at(-1).includes('queued follow-up') && prompts.at(-2).includes('fake-sleep-2'), 'the queued message went as the next prompt');

  // ---- interrupt
  await send(id, 'fake-sleep-30');
  await sleep(300);
  await s.api(`/agents/${id}/interrupt`, 'POST', {});
  ok(await idle(id, 4000), 'interrupt ends the turn quickly');
  ok(sent('session/cancel').length >= 1, 'interrupt sends session/cancel');
  ok((await lastResult(id))?.stop_reason === 'cancelled', 'the result says cancelled');

  // ---- a crash shows stderr; the next message starts a new process that resumes
  await send(id, 'fake-crash');
  ok(await waitFor(async () => (await agentOf(id)).status === 'stopped', 6000), 'a crashed process leaves the agent stopped');
  ev = await eventsOf(id);
  ok(ev.some((e) => e.type === 'stderr' && /boom/.test(e.text)), "the process's stderr is shown");
  ok(ev.some((e) => e.type === 'exit' && e.code === 3), 'the exit code is shown');
  await send(id, 'after the crash'); await idle(id);
  ok((await lastResult(id))?.result.endsWith('after the crash'), 'the next message runs in a new process');

  // ---- server restart while a permission request is open: asked again, answered to the same process
  await send(id, 'fake-tool across a restart');
  ap = await approval(id);
  const pidBefore = sent('session/prompt').at(-1).pid;
  await s.restart({ FAKE_ACP_LOG: LOG });
  const ap2 = await approval(id);
  ok(ap2 && ap2.reqId !== ap.reqId && ap2.tool_name === 'Bash', 'after a server restart the open request is asked again');
  await decide(id, ap2.reqId, 'allow');
  ok(await idle(id), 'the turn ends after the answer');
  ok((await lastResult(id))?.result === 'answer=once' && log().filter((x) => x.in && JSON.parse(x.in).result?.outcome).at(-1)?.pid === pidBefore, 'the answer reached the same process');

  // ---- remove
  ok((await s.api(`/agents/${id}`, 'DELETE')).status === 200, 'the agent can be removed');
  ok(await waitFor(() => { try { process.kill(pidBefore, 0); return false; } catch { return true; } }, 4000), 'its process is gone');
} catch (e) {
  ok(false, 'acp test crashed: ' + e.stack);
} finally {
  if (c.fails) console.log(s.log().slice(-3000));
  await s.stop();
}
c.done();
