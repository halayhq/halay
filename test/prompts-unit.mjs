// What each backend's agents are told (prompts.js) and what the swarm MCP server tells them (swarm-mcp.js tool
// descriptions), without a server: every CLI gets only the tools and features it has, under names it can use.
// Also the ACP preamble: its form, and that it goes out again when the prompt carrying it failed before any output.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, checker } from './lib/spare.mjs';
import { BACKENDS } from '../src/backends/index.js';
import { systemPrompt, swarmAsks, swarmPlans, preamble } from '../src/prompts.js';
import { createAcpBackend } from '../src/backends/acp.js';

const c = checker(), ok = c.ok;
const CLAUDE_ONLY = /mcp__|AskUserQuestion|ExitPlanMode|TodoWrite|Agent \(Task\)|built-in Agent|Agent\/Task|the Edit and Write tools/;
const bot = 'You are a bot. Update the memory files with the Edit and Write tools (they need no approval there).';
const browser = 'You have a real browser (tools mcp__browser__browser_*).';
const prompt = (id, o = {}) => systemPrompt(BACKENDS[id], { tmpDir: '/tmp/x', conductor: 'CONDUCTOR. Tools (mcp__swarm__*): start_agent.', ...o });

// ---- Claude: its own names and tools; nothing it doesn't need
const cl = prompt('claude', { builtinSubagents: true, bot, browser });
ok(cl.includes('mcp__swarm__start_agent, not the built-in Agent (Task) tool') && cl.includes('with the Edit and Write tools') && cl.includes('mcp__browser__browser_*'), 'Claude: its own tool names');
ok(!/ask_user|submit_plan|Tool names:/.test(cl), 'Claude: no ask_user, submit_plan or naming note (it has AskUserQuestion and ExitPlanMode)');
ok(/Use the built-in Agent tool only/.test(cl) && /quick built-in subagent/.test(cl), 'Claude, built-in subagents allowed: for quick lookups');
const clOff = prompt('claude', { builtinSubagents: false });
ok(/Built-in subagents are turned off/.test(clOff) && !/quick built-in subagent|Use the built-in Agent tool/.test(clOff), 'Claude, built-in subagents off: said once, and no lookup advice contradicting it');
const clCond = prompt('claude', { role: 'conductor', builtinSubagents: true });
ok(clCond.startsWith('CONDUCTOR.') && !/quick built-in subagent|Delegating work:/.test(clCond), 'Claude conductor: its own prompt, never told to use a built-in subagent');
ok(!swarmAsks(BACKENDS.claude) && !swarmPlans(BACKENDS.claude, 'plan'), 'Claude gets neither ask_user nor submit_plan');

// ---- the other CLIs
for (const id of ['opencode', 'gemini', 'cursor']) {
  const be = BACKENDS[id];
  for (const builtinSubagents of [true, false]) for (const permissionMode of ['manual', 'plan']) for (const role of ['', 'conductor']) {
    const p = prompt(id, { builtinSubagents, permissionMode, role, bot, browser });
    const tag = `${id} (${role || 'agent'}, ${permissionMode}, built-in subagents ${builtinSubagents ? 'on' : 'off'})`;
    const bad = p.match(CLAUDE_ONLY);
    ok(!bad, `${tag}: no Claude-only names${bad ? ': ' + bad[0] : ''}`);
    ok(/Tool names: .*MCP server "swarm"/.test(p) && /start_agent/.test(p), `${tag}: plain tool names, with how its CLI names them`);
    ok(/ask_user/.test(p) === swarmAsks(be) && swarmAsks(be), `${tag}: ask_user (no question tool of its own reaches the swarm)`);
    const plan = id === 'opencode' && permissionMode === 'plan';
    ok(/submit_plan/.test(p) === plan, `${tag}: submit_plan ${plan ? 'named (no plan approval of its own over ACP)' : 'not named'}`);
    ok(/quick built-in subagent/.test(p) === (builtinSubagents && !role), `${tag}: lookup subagent advice only when built-in subagents are allowed`);
    ok(p.includes('with your file edit and write tools') && p.includes('browser_*'), `${tag}: bot and browser texts in its words`);
  }
}
ok(swarmPlans(BACKENDS.opencode, 'plan') && !swarmPlans(BACKENDS.opencode, 'manual') && !swarmPlans(BACKENDS.gemini, 'plan') && !swarmPlans(BACKENDS.cursor, 'plan'), 'submit_plan only for OpenCode in plan mode');

// ---- swarm-mcp.js tool descriptions, per caller's CLI (no server needed for tools/list)
// this shell's own HALAY_* (when run inside a swarm agent) must not leak in
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HALAY_')));
const toolsOf = (env) => new Promise((resolve, reject) => {
  const ch = spawn(process.execPath, [path.join(ROOT, 'src', 'swarm-mcp.js')], { env: { ...clean, HALAY_URL: 'http://127.0.0.1:9', HALAY_TOKEN: 'x', HALAY_AGENT: 'a', ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const t = setTimeout(() => { ch.kill(); reject(new Error('no tools/list answer')); }, 10000);
  ch.stdout.on('data', (d) => { buf += d; const l = buf.split('\n').find((x) => x.includes('"tools"')); if (l) { clearTimeout(t); ch.kill(); resolve(JSON.parse(l).result.tools); } });
  ch.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
});
const desc = (tools, name) => tools.find((t) => t.name === name);
const tc = await toolsOf({});
const saC = desc(tc, 'start_agent');
ok(saC.description.startsWith('Start a new Claude Code agent') && /built-in Agent\/Task tool/.test(saC.description) && /sonnet or haiku/.test(saC.description), 'MCP, Claude caller: start_agent described as before');
ok(/^model alias \(opus, sonnet, haiku, fable\)/.test(saC.inputSchema.properties.model.description) && desc(tc, 'approve') && !desc(tc, 'ask_user') && !desc(tc, 'submit_plan'), 'MCP, Claude caller: Claude model aliases, approve, no ask_user or submit_plan');
for (const id of ['opencode', 'gemini', 'cursor']) {
  const be = BACKENDS[id];
  const t = await toolsOf({ HALAY_BACKEND: id, HALAY_NO_APPROVE: '1', HALAY_ASK_TOOL: swarmAsks(be) ? '1' : '0', ...(id === 'opencode' && { HALAY_PLAN_TOOL: '1' }) });
  const sa = desc(t, 'start_agent'), all = JSON.stringify(t);
  ok(sa.description.startsWith(`Start a new coding agent (${be.label}`) && /your CLI's built-in subagent tool/.test(sa.description) && !/mcp__|Agent\/Task|sonnet or haiku/.test(sa.description), `MCP, ${id} caller: start_agent in its words`);
  ok(sa.inputSchema.properties.model.description.includes(be.modelHint) && /for a Claude agent: opus/.test(sa.inputSchema.properties.model.description), `MCP, ${id} caller: its own model names first, Claude's for Claude agents`);
  ok(/has none/.test(sa.inputSchema.properties.effort.description) === !be.capabilities.effort.length, `MCP, ${id} caller: effort ${be.capabilities.effort.length ? 'offered' : 'marked as missing on its CLI'}`);
  ok(!/mcp__browser__/.test(all) && /auto is for Claude agents only/.test(sa.inputSchema.properties.permission_mode.description), `MCP, ${id} caller: no Claude tool prefixes; auto marked Claude-only`);
  ok(!desc(t, 'approve') && !!desc(t, 'ask_user') && !!desc(t, 'submit_plan') === (id === 'opencode'), `MCP, ${id} caller: ask_user, no approve${id === 'opencode' ? ', submit_plan in plan mode' : ''}`);
}
// an MCP server started before HALAY_ASK_TOOL existed (only HALAY_NO_APPROVE): still offers ask_user
ok(!!desc(await toolsOf({ HALAY_NO_APPROVE: '1' }), 'ask_user'), 'MCP: ask_user also for an older non-Claude launch env');

// ---- the ACP preamble
const pre = preamble('RULES');
ok(pre.startsWith('<swarm-instructions>\n') && pre.includes('RULES\n</swarm-instructions>\n\n') && pre.replace(/^<swarm-instructions>[\s\S]*?<\/swarm-instructions>\s*/, '') === '', 'the preamble is one <swarm-instructions> block that the replay strips whole');

const be = createAcpBackend({ id: 'pa', label: 'PA', bin: 'pa', preamble: true, capabilities: {}, launch: () => ({ args: [], env: {} }) });
const writes = [];
const agent = { cwd: '/w', writeIn: (l) => writes.push(JSON.parse(l)), autoDecision: () => null, requestPermission: () => Promise.resolve({ allowed: true }), saveDriverState() {}, push() {}, setStatus() {} };
const d = be.driver(agent, null, { systemPrompt: 'RULES', mcpServers: {} });
d.started();
const feed = (m) => d.onLine(JSON.stringify({ jsonrpc: '2.0', ...m }));
feed({ id: 1, result: { protocolVersion: 1 } });
feed({ id: 2, result: { sessionId: 's1' } });
const prompts = () => writes.filter((w) => w.method === 'session/prompt');
d.encode('first');
ok(prompts().at(-1).params.prompt[0].text === preamble('RULES') + 'first', 'the first message carries the instructions');
feed({ id: prompts().at(-1).id, error: { code: -32000, message: 'quota exceeded' } });
d.encode('again');
ok(prompts().at(-1).params.prompt[0].text === preamble('RULES') + 'again', 'that prompt failed before any output: the next message carries them again');
feed({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } } } });
feed({ id: prompts().at(-1).id, error: { code: -32000, message: 'crashed' } });
d.encode('third');
ok(prompts().at(-1).params.prompt[0].text === 'third', 'a failed prompt that already had output did reach the session: not sent twice');
feed({ id: prompts().at(-1).id, result: { stopReason: 'end_turn' } });
d.encode('fourth');
ok(prompts().at(-1).params.prompt[0].text === 'fourth', 'later messages go without them');

c.done();
