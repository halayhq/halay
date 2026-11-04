// Gemini CLI and Cursor backends against the fake ACP agent (test/fake-acp, which answers as `gemini --acp` and
// `cursor-agent acp`): their launch flags (approval mode, plan, model, lean), Cursor's login step, per-session model and
// mode and MCP tool naming, the swarm instructions sent in front of a
// session's first message (neither CLI can add to its system prompt), a missing login shown as an error, Cursor's
// extension methods (questions, plan approval, todos, subagent notices), and the probe that reports a CLI without an
// ACP mode instead of running it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, startSpare, checker, waitFor } from './lib/spare.mjs';

const c = checker(), ok = c.ok;
process.env.PATH = path.join(ROOT, 'test/fake-acp') + path.delimiter + process.env.PATH;
// a stand-in for the user's ~/.cursor (CURSOR_CONFIG_DIR of the server, which Cursor agents copy and link from)
const CURSOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-home-'));
fs.writeFileSync(path.join(CURSOR_HOME, 'cli-config.json'), JSON.stringify({ model: 'mine', permissions: { allow: ['Shell(ls)'] } }));
fs.mkdirSync(path.join(CURSOR_HOME, 'acp-sessions'));
const s = await startSpare({ tag: 'acpbk', env: { HALAY_TERMINAL: '0', CURSOR_CONFIG_DIR: CURSOR_HOME } });
const LOG = path.join(s.dir, 'acp.log');
await s.restart({ FAKE_ACP_LOG: LOG });

const log = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const startOf = (pid) => log().find((x) => x.start && x.pid === pid)?.start;
const sent = (method) => log().filter((r) => r.in).map((r) => ({ pid: r.pid, m: JSON.parse(r.in) })).filter((x) => !method || x.m.method === method);
const agentOf = async (id) => (await s.api('/agents')).j.find((a) => a.id === id);
const eventsOf = async (id) => (await s.api(`/agents/${id}?all=1`)).j.events || [];
const idle = (id) => waitFor(async () => (await agentOf(id))?.status === 'idle', 8000);
const lastResult = async (id) => (await eventsOf(id)).findLast((e) => e.type === 'result');
const send = (id, text) => s.api(`/agents/${id}/send`, 'POST', { text });
const approval = (id) => waitFor(async () => (await s.api('/approvals')).j.find((x) => x.agentId === id), 6000);
const start = async (body) => { const r = await s.api('/agents', 'POST', { cwd: s.dir, ...body }); if (r.status >= 300) throw new Error(r.text); return r.j.id; };

try {
  const bks = (await s.api('/backends')).j;
  ok(['opencode', 'gemini', 'cursor'].every((id) => bks.find((b) => b.id === id)?.installed), 'opencode, gemini and cursor are usable (their probes pass)');

  // ---- Settings → Agent defaults per CLI (perBackend): modes, model and effort of each CLI, Claude's stay top-level
  ok(typeof (await s.api('/settings/agents')).j.perBackend === 'object', 'the defaults carry a perBackend object');
  const od = await start({ name: 'od', backend: 'opencode' });
  ok((await agentOf(od)).permissionMode === 'manual', "a CLI without defaults of its own starts in manual (Claude's auto doesn't exist there)");
  ok((await s.api('/settings/agents', 'PUT', { perBackend: { gemini: { permissionMode: 'auto' } } })).status === 400, "Gemini's defaults refuse a mode it lacks");
  ok((await s.api('/settings/agents', 'PUT', { perBackend: { gemini: { effort: 'high' } } })).status === 400, "and an effort it doesn't have");
  ok((await s.api('/settings/agents', 'PUT', { perBackend: { claude: { model: 'opus' } } })).status === 400, "Claude's defaults are not under perBackend");
  ok((await s.api('/settings/agents', 'PUT', { perBackend: { nope: {} } })).status === 400, 'an unknown CLI is refused');
  let pd = await s.api('/settings/agents', 'PUT', { perBackend: { gemini: { permissionMode: 'acceptEdits', model: 'gemini-d-pro' }, cursor: { effort: 'high' } } });
  ok(pd.status === 200 && pd.j.perBackend.gemini.model === 'gemini-d-pro' && pd.j.perBackend.cursor.effort === 'high' && pd.j.perBackend.cursor.permissionMode === 'manual', 'per-CLI defaults saved: ' + JSON.stringify(pd.j.perBackend));
  const gd = await start({ name: 'gd', backend: 'gemini', prompt: 'hi' });
  await idle(gd);
  ok((await agentOf(gd)).permissionMode === 'acceptEdits' && (await agentOf(gd)).model === 'gemini-d-pro', "a new Gemini agent gets Gemini's defaults");
  ok(startOf(sent('session/prompt').at(-1).pid).argv.includes('gemini-d-pro'), 'and launches with that model');
  ok((await agentOf(await start({ name: 'gx', backend: 'gemini', model: 'gemini-own', permissionMode: 'manual' }))).model === 'gemini-own', 'the request still wins over the defaults');
  ok((await agentOf(await start({ name: 'cd', backend: 'cursor' }))).effort === 'high', "a Cursor agent gets Cursor's effort default");
  ok((await agentOf(await start({ name: 'od2', backend: 'opencode' }))).model == null, "another CLI's defaults don't leak into OpenCode");
  await s.api('/settings/agents', 'PUT', { perBackend: { gemini: { permissionMode: 'manual', model: '' }, cursor: { effort: '' } } });

  // ---- Gemini CLI
  const g = await start({ name: 'gem', backend: 'gemini', model: 'gemini-x-pro', lean: true, prompt: 'hello gemini' });
  ok(await idle(g), 'a gemini agent answers');
  let pid = sent('session/prompt').at(-1).pid, st = startOf(pid);
  ok(st.name === 'gemini' && st.argv.join(' ') === '--acp --approval-mode default --model gemini-x-pro --allowed-mcp-server-names swarm', 'launched as gemini --acp in its asking mode, with the model and lean: ' + st.argv.join(' '));
  const p1 = sent('session/prompt').at(-1).m.params.prompt[0].text;
  ok(p1.startsWith('<swarm-instructions>') && p1.includes('start_agent') && p1.trimEnd().endsWith('hello gemini'), 'the swarm instructions go in front of the first message');
  ok((await eventsOf(g)).find((e) => e.type === 'user_prompt')?.text === 'hello gemini', 'the chat shows only what the user wrote');
  await send(g, 'second'); await idle(g);
  ok(!sent('session/prompt').at(-1).m.params.prompt[0].text.includes('<swarm-instructions>'), 'later messages go without them');
  ok((await s.api(`/agents/${g}/mode`, 'POST', { permissionMode: 'plan' })).status === 200, 'plan mode is accepted');
  await send(g, 'in plan'); await idle(g);
  pid = sent('session/prompt').at(-1).pid;
  ok(startOf(pid).argv.includes('plan') && sent('session/load').some((x) => x.pid === pid), 'plan restarts it with --approval-mode plan, resuming the session');
  ok(!sent('session/prompt').at(-1).m.params.prompt[0].text.includes('<swarm-instructions>'), 'a resumed session gets no second preamble');
  await send(g, 'fake-geminiplan');
  const gp = await approval(g);
  ok(gp?.tool_name === 'ExitPlanMode' && /# Rename[\s\S]*fix the imports/.test(gp.preview), "Gemini's exit_plan_mode asks to approve the plan, showing the plan file's text: " + JSON.stringify(gp?.preview));
  await s.api(`/agents/${g}/permission`, 'POST', { reqId: gp.reqId, decision: 'allow' }); await idle(g);
  ok((await lastResult(g))?.result === 'answer=once', 'approving allows it once: ' + (await lastResult(g))?.result);
  ok((await eventsOf(g)).some((e) => e.type === 'assistant' && e.message.content.some((b) => b.type === 'tool_use' && b.name === 'ExitPlanMode')), 'the chat shows it as a plan card');
  ok((await start({ name: 'x', backend: 'gemini', effort: 'high' }).catch((e) => e.message)).includes('no effort'), 'gemini has no effort setting');

  // built-in subagents: off by default, so Gemini gets a system settings file with its agents turned off; on, it doesn't
  const gs = startOf(pid).geminiSettings;
  ok(gs && JSON.parse(fs.readFileSync(gs, 'utf8')).experimental?.enableAgents === false, "gemini's own subagents are off by default: " + gs);
  await s.api('/settings/agents', 'PUT', { builtinSubagents: true });
  const g2 = await start({ name: 'gem2', backend: 'gemini', prompt: 'hi' });
  await idle(g2);
  ok(startOf(sent('session/prompt').at(-1).pid).geminiSettings === null, 'with built-in subagents allowed it keeps them');
  const p2 = sent('session/prompt').at(-1).m.params.prompt[0].text;
  ok(/Use your built-in subagent tool only/.test(p2) && /quick built-in subagent/.test(p2) && !/Built-in subagents are turned off/.test(p2), 'and its instructions allow them for quick lookups');
  await s.api('/settings/agents', 'PUT', { builtinSubagents: false });
  ok(/Built-in subagents are turned off/.test(p1), 'by default the instructions say they are off');
  ok(!/quick built-in subagent/.test(p1), 'and do not also suggest one for lookups');
  // the instructions name what Gemini has: plain tool names with a note on its naming, ask_user, no Claude names
  ok(/^<swarm-instructions>\nStanding instructions from the swarm/.test(p1) && /Tool names: .*MCP server "swarm"/.test(p1) && /ask_user/.test(p1), 'the preamble says what it is, how the swarm tools are named, and to ask with ask_user');
  ok(!/mcp__|AskUserQuestion|ExitPlanMode|TodoWrite|Agent \(Task\)|submit_plan/.test(p1), 'and mentions no Claude tool names, nor submit_plan (Gemini has its own plan approval)');

  // Settings → Accounts: each CLI's login state and the command that logs in (the Open terminal button runs it)
  const gh = path.join(s.dir, 'gemini-home');
  fs.mkdirSync(path.join(gh, '.gemini'), { recursive: true });
  await s.restart({ FAKE_ACP_LOG: LOG, GEMINI_CLI_HOME: gh });
  let acs = (await s.api('/accounts?refresh=1')).j;
  const acc = (n) => acs.find((x) => x.name === n);
  ok(acc('cursor')?.loggedIn === true && acc('cursor').email === 'dev@example.com' && acc('cursor').fix === 'cursor-agent login', 'Cursor: logged in, from cursor-agent status: ' + JSON.stringify(acc('cursor')));
  ok(acc('opencode')?.loggedIn === true && /1 provider login/.test(acc('opencode').method) && acc('opencode').fix === 'opencode auth login', 'OpenCode: its free models need no login, its provider logins are counted: ' + JSON.stringify(acc('opencode')));
  ok(acc('gemini')?.loggedIn === null && /no Gemini login found/.test(acc('gemini').error) && /^gemini\b/.test(acc('gemini').fix), 'Gemini: no login found is unknown, with the command to log in: ' + JSON.stringify(acc('gemini')));
  fs.writeFileSync(path.join(gh, '.gemini', 'oauth_creds.json'), '{}');
  acs = (await s.api('/accounts?refresh=1')).j;
  ok(acc('gemini')?.loggedIn === true && acc('gemini').method === 'Google login', 'Gemini: its OAuth file counts as logged in');
  await s.restart({ FAKE_ACP_LOG: LOG, FAKE_ACP_NOAUTH: '1' });
  acs = (await s.api('/accounts?refresh=1')).j;
  ok(acc('cursor')?.loggedIn === false && acc('cursor').fix === 'cursor-agent login', 'Cursor logged out shows as logged out');
  await s.restart({ FAKE_ACP_LOG: LOG });

  // a missing login fails session/new: the agent shows it and does not hang
  await s.restart({ FAKE_ACP_LOG: LOG, FAKE_ACP_NOAUTH: '1' });
  const nl = await start({ name: 'nologin', backend: 'gemini', prompt: 'hi' });
  ok(await idle(nl), 'without a login the turn ends instead of hanging');
  const r = await lastResult(nl);
  ok(r?.is_error && /could not start a session: Gemini API key is missing/.test(r.result), 'the result says why: ' + r?.result);
  ok((await eventsOf(nl)).some((e) => e.type === 'stderr' && /session\/new failed/.test(e.text)), 'and the error is in the chat');
  await s.restart({ FAKE_ACP_LOG: LOG });

  // ---- Cursor
  const cu = await start({ name: 'cur', backend: 'cursor', model: 'gpt-x', effort: 'max', prompt: 'hello cursor' });
  ok(await idle(cu), 'a cursor agent answers');
  pid = sent('session/prompt').at(-1).pid; st = startOf(pid);
  // no --model: cursor-agent would save it as the user's default model
  ok(st.name === 'cursor-agent' && st.argv.join(' ') === 'acp', 'launched as plain cursor-agent acp: ' + st.argv.join(' '));
  const order = sent().filter((x) => x.pid === pid).map((x) => x.m.method).filter(Boolean);
  ok(order.slice(0, 3).join() === 'initialize,authenticate,session/new', 'it authenticates before opening the session: ' + order.join());
  ok(sent('initialize').find((x) => x.pid === pid)?.m.params.clientCapabilities._meta?.parameterizedModelPicker === true, 'it asks for models by name with their own options');
  // its own config folder: Cursor saves a session's model as the user's default in cli-config.json
  const ccd = st.cursorConfigDir;
  ok(ccd && fs.lstatSync(path.join(ccd, 'cli-config.json')).isFile() && JSON.parse(fs.readFileSync(path.join(ccd, 'cli-config.json'), 'utf8')).permissions?.allow?.[0] === 'Shell(ls)', "it runs with a config folder of its own, with a copy of the user's cli-config.json: " + ccd);
  ok(fs.lstatSync(path.join(ccd, 'acp-sessions')).isSymbolicLink() && fs.realpathSync(path.join(ccd, 'acp-sessions')) === fs.realpathSync(path.join(CURSOR_HOME, 'acp-sessions')), "and links to the rest of the user's (its sessions, for History)");
  ok(JSON.parse(fs.readFileSync(path.join(CURSOR_HOME, 'cli-config.json'), 'utf8')).model === 'mine', "the user's own config is untouched");
  const sets = sent('session/set_config_option').filter((x) => x.pid === pid).map((x) => `${x.m.params.configId}=${x.m.params.value}`);
  ok(sets.join() === 'model=gpt-x,reasoning=extra-high', "the model is set, then the effort as that model's reasoning option (max -> its highest, extra-high): " + sets.join());
  const cs = await start({ name: 'cur2', backend: 'cursor', model: 'sonnet-y', effort: 'xhigh', prompt: 'hi' });
  await idle(cs);
  const sets2 = sent('session/set_config_option').filter((x) => x.pid === sent('session/prompt').at(-1).pid).map((x) => `${x.m.params.configId}=${x.m.params.value}`);
  ok(sets2.join() === 'model=sonnet-y,effort=xhigh', 'another model names its option differently: ' + sets2.join());
  const cd = await start({ name: 'cur3', backend: 'cursor', effort: 'high', prompt: 'hi' });
  await idle(cd);
  ok((await eventsOf(cd)).some((e) => e.type === 'note' && /effort high: this model has no effort setting/.test(e.text)), 'a model without an effort setting says so');
  ok(sent('session/prompt').at(-1).m.params.prompt[0].text.startsWith('<swarm-instructions>'), 'its first message carries the swarm instructions');
  // the swarm MCP server without claude's permission-prompt tool (Cursor's model once called it to ask a question)
  const sw = sent('session/new').find((x) => x.pid === pid).m.params.mcpServers.find((x) => x.name === 'swarm');
  ok(sw.env.some((e) => e.name === 'HALAY_NO_APPROVE' && e.value === '1'), 'its swarm MCP server hides the approve tool');
  const listed = await new Promise((resolve) => {
    const env = Object.fromEntries(sw.env.map((e) => [e.name, e.value]));
    const ch = spawn(sw.command, sw.args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    ch.stdout.on('data', (d) => { buf += d; const l = buf.split('\n').find((x) => x.includes('"tools"')); if (l) { ch.kill(); resolve(JSON.parse(l).result.tools.map((t) => t.name)); } });
    ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  });
  ok(listed.includes('list_agents') && !listed.includes('approve') && listed.includes('ask_user'), 'tools/list has the swarm tools and ask_user, but not approve');

  // ask_user: the swarm's question tool for CLIs without one. A question card; the answers go back to the tool call
  const mcp = () => {
    const env = Object.fromEntries(sw.env.map((e) => [e.name, e.value]));
    const ch = spawn(sw.command, sw.args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    const waiting = new Map();
    ch.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
    return {
      call: (id, name, args) => new Promise((resolve) => { waiting.set(id, resolve); ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); }),
      cancel: (id) => ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }) + '\n'),
      kill: () => ch.kill(),
    };
  };
  const m1 = mcp();
  const asked = m1.call(1, 'ask_user', { title: 'Setup', questions: [{ question: 'Which language?', header: 'Language', options: [{ label: 'Python' }, { label: 'Go', description: 'compiled' }] }, { question: 'Which extras?', options: [{ label: 'tests' }, { label: 'docs' }, { label: 'ci' }], multiSelect: true }] });
  const card = await approval(cu);
  ok(card?.kind === 'question' && card.tool_name === 'AskUserQuestion' && card.questions?.length === 2 && card.questions[1].multiSelect, 'ask_user shows a question card on the agent: ' + JSON.stringify(card?.questions?.map((q) => q.question)));
  ok((await s.api(`/agents/${cu}/permission`, 'POST', { reqId: card.reqId, decision: 'answer', answers: [['Go'], ['tests', 'ci']] })).status === 200, 'the card is answered');
  const got = (await asked).result?.content?.[0]?.text || '';
  ok(/Which language\?\n  Go/.test(got) && /Which extras\?\n  tests, ci/.test(got), 'the tool returns the answers: ' + JSON.stringify(got));
  const declined = m1.call(2, 'ask_user', { questions: [{ question: 'Proceed?', options: [{ label: 'yes' }, { label: 'no' }] }] });
  const card2 = await approval(cu);
  await s.api(`/agents/${cu}/permission`, 'POST', { reqId: card2.reqId, decision: 'deny' });
  ok(/declined/.test((await declined).result?.content?.[0]?.text || ''), 'declining tells the model so');
  m1.call(3, 'ask_user', { questions: [{ question: 'Cancel me?', options: [{ label: 'a' }, { label: 'b' }] }] });
  const card3 = await approval(cu);
  m1.cancel(3);
  ok(card3 && await waitFor(async () => !(await s.api('/approvals')).j.some((x) => x.reqId === card3.reqId), 5000), 'a cancelled tool call takes its card away');
  const bad = await m1.call(4, 'ask_user', { questions: [{ question: 'Only one option?', options: [{ label: 'a' }] }] });
  ok(bad.result?.isError && /two to four options/.test(bad.result.content[0].text), 'a question needs two to four options');
  m1.kill();
  const instrCur = sent('session/prompt').find((x) => x.pid === pid).m.params.prompt[0].text;
  ok(/ask_user/.test(instrCur), "the agent's instructions tell it to use ask_user");
  const cm = (await s.api('/backends/cursor/models')).j;
  ok(JSON.stringify(cm.models || cm) === JSON.stringify(['default', 'gpt-x', 'sonnet-y']), "its models come from its ACP server, by name: " + JSON.stringify(cm));

  await send(cu, 'fake-tool');
  const sh = await approval(cu);
  ok(sh?.tool_name === 'Bash', 'a shell call asks through the swarm');
  await s.api(`/agents/${cu}/permission`, 'POST', { reqId: sh.reqId, decision: 'allow' }); await idle(cu);
  const shRes = (await eventsOf(cu)).findLast((e) => e.type === 'user' && e.message?.content?.[0]?.type === 'tool_result')?.message.content[0].content;
  ok(shRes === 'file listing', "its output is the command's, not the reason Cursor asked: " + JSON.stringify(shRes));

  await send(cu, 'fake-swarm'); await idle(cu);
  ok((await lastResult(cu))?.result === 'answer=once' && !(await s.api('/approvals')).j.some((x) => x.agentId === cu), "a swarm MCP call (Cursor's naming) is allowed by the swarm without asking");
  ok((await eventsOf(cu)).some((e) => e.type === 'assistant' && e.message?.content?.some((b) => b.type === 'tool_use' && b.name === 'mcp__swarm__list_agents')), 'and shows as mcp__swarm__list_agents');

  await send(cu, 'fake-question');
  const q = await approval(cu);
  ok(q?.kind === 'question' && q.questions?.[0]?.question === 'Which color?' && q.questions[0].multiSelect, 'cursor/ask_question becomes a question card');
  ok((await s.api(`/agents/${cu}/permission`, 'POST', { reqId: q.reqId, decision: 'answer', answers: [['Red', 'Green, light']] })).status === 200, 'the question is answered');
  await idle(cu);
  ok((await lastResult(cu))?.result === 'question={"outcome":"answered","answers":[{"questionId":"q1","selectedOptionIds":["r","g"]}]}', 'the answer goes back as option ids (a label with a comma too): ' + (await lastResult(cu))?.result);
  await send(cu, 'fake-question');
  const q2 = await approval(cu);
  await s.api(`/agents/${cu}/permission`, 'POST', { reqId: q2.reqId, decision: 'deny' }); await idle(cu);
  ok(/question=\{"outcome":"skipped"/.test((await lastResult(cu))?.result), 'declining skips the question');

  await send(cu, 'fake-createplan');
  const pl = await approval(cu);
  ok(pl?.tool_name === 'ExitPlanMode' && /# Refactor[\s\S]*1\. do a/.test(pl.preview), 'cursor/create_plan asks to approve the plan, showing it: ' + JSON.stringify(pl?.preview));
  await s.api(`/agents/${cu}/permission`, 'POST', { reqId: pl.reqId, decision: 'allow' }); await idle(cu);
  ok((await lastResult(cu))?.result === 'plan=accepted', 'approving accepts the plan');

  await send(cu, 'fake-todos'); await idle(cu);
  ok((await lastResult(cu))?.result === 'todos=accepted', 'cursor/update_todos sent as a request is answered: ' + (await lastResult(cu))?.result);
  const a = await agentOf(cu);
  ok(a.todos?.length === 2 && a.todos[0].status === 'completed' && a.todos[1].status === 'pending', 'cursor/update_todos (replace, then merge) becomes the todo list: ' + JSON.stringify(a.todos));
  await send(cu, 'fake-subtask'); await idle(cu);
  const evs = await eventsOf(cu);
  ok(evs.some((e) => e.type === 'note' && e.text === 'Subagent (explore): Explore the code, done in 10 s'), 'cursor/task shows as a note: ' + JSON.stringify(evs.filter((e) => e.type === 'note').map((e) => e.text)));
  ok((await lastResult(cu))?.result === 'task=completed', 'and is answered');
  ok(evs.some((e) => e.type === 'assistant' && e.message?.content?.some((b) => b.type === 'tool_use' && b.name === 'Task' && b.input.prompt === 'find auth')), "Cursor's subagent call shows as a Task card");

  ok((await s.api(`/agents/${cu}/mode`, 'POST', { permissionMode: 'plan' })).status === 200, 'a Cursor agent goes to plan mode');
  await send(cu, 'planned'); await idle(cu);
  pid = sent('session/prompt').at(-1).pid;
  ok(startOf(pid).argv.join(' ') === 'acp' && sent('session/set_mode').some((x) => x.pid === pid && x.m.params.modeId === 'plan'), 'plan mode is set on the resumed session, not by a flag');

  // ---- a CLI without an ACP mode is reported, not run
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'old-cursor-'));
  fs.writeFileSync(path.join(old, 'cursor-agent'), '#!/bin/sh\necho "Usage: cursor-agent [options] [command] [prompt...]"\n');
  fs.chmodSync(path.join(old, 'cursor-agent'), 0o755);
  const pathWas = process.env.PATH;
  process.env.PATH = old + path.delimiter + pathWas; // the spare server puts its fake claude in front of this
  await s.restart({ FAKE_ACP_LOG: LOG });
  process.env.PATH = pathWas;
  const cb = (await s.api('/backends')).j.find((b) => b.id === 'cursor');
  ok(cb && !cb.installed && /cursor-agent update/.test(cb.reason || ''), 'an old cursor-agent is reported as too old: ' + cb?.reason);
  const rr = await s.api('/agents', 'POST', { cwd: s.dir, backend: 'cursor' });
  ok(rr.status === 400 && /can't run here: .*cursor-agent update/.test(rr.j.error), 'starting a Cursor agent then says why: ' + rr.j.error);
  ok((await agentOf(cu)).backend === 'cursor', 'the existing Cursor agent is still listed');
  fs.rmSync(old, { recursive: true, force: true });
} catch (e) {
  ok(false, 'backends test crashed: ' + e.stack);
} finally {
  if (c.fails) console.log(s.log().slice(-3000));
  await s.stop();
}
c.done();
