// Generic driver for coding agents that speak ACP, the Agent Client Protocol (JSON-RPC 2.0, one message per line, over
// the agent's stdin/stdout; https://agentclientprotocol.com).
//
// The swarm keeps Claude's stream-json event shapes as its own format, so this driver translates: message chunks become
// `assistant` text and thinking blocks, tool calls become `tool_use` blocks under the names the UI knows (Bash, Read,
// Edit, ...), their results `tool_result` blocks, the plan a TodoWrite call, usage a `system/context` event, and the
// end of a `session/prompt` a `result`. Permission requests go through the swarm's own approval flow
// (Agent.requestPermission), after the swarm's mode policy (Agent.autoDecision) had its say.
//
// The process runs detached like claude does (FIFO stdin, output file), so the driver keeps its whole protocol state
// in a plain object that the server saves with the output offset; a restarted server restores it and carries on, with
// open permission requests asked again.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { preamble } from '../prompts.js';

const RPC = '2.0';
// what the swarm declares in initialize; a backend may add _meta (Cursor: parameterizedModelPicker, see cursor.js)
const clientCaps = (backend) => ({ fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...(backend.clientMeta && { _meta: backend.clientMeta }) });
const line = (o) => JSON.stringify({ jsonrpc: RPC, ...o }) + '\n';

// ACP tool kinds -> the Claude tool names the chat view renders, with their input in Claude's shape.
// ctx.mcpServers: the names of the MCP servers the session was started with, to tell where an agent's flattened
// `mcp_<server>_<tool>` name splits (Antigravity)
export function toolOf(tc, ctx = {}) {
  const raw = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {};
  const title = typeof tc.title === 'string' ? tc.title : '';
  const loc = Array.isArray(tc.locations) && tc.locations[0]?.path;
  const diff = Array.isArray(tc.content) ? tc.content.find((c) => c?.type === 'diff') : null;
  const pathOf = () => raw.filePath ?? raw.file_path ?? raw.path ?? raw.Path ?? raw.abs_path ?? diff?.path ?? loc ?? undefined;
  switch (tc.kind) {
    case 'execute': return { name: 'Bash', input: { command: String(raw.command ?? raw.cmd ?? raw.CommandLine ?? title), ...(raw.description ? { description: String(raw.description) } : {}) } };
    case 'read': return { name: 'Read', input: { file_path: pathOf() ?? title } };
    case 'edit':
      // Antigravity (rawInput with capitalized keys, its diff only comes with the result): write_file { Path, Content }, edit_file { Path, Target, Replacement }
      if (typeof raw.Content === 'string') return { name: 'Write', input: { file_path: pathOf() ?? title, content: raw.Content } };
      if (typeof raw.Target === 'string' && typeof raw.Replacement === 'string') return { name: 'Edit', input: { file_path: pathOf() ?? title, old_string: raw.Target, new_string: raw.Replacement } };
      if (diff && (diff.oldText == null || diff.oldText === '')) return { name: 'Write', input: { file_path: diff.path, content: String(diff.newText ?? '') } };
      if (diff) return { name: 'Edit', input: { file_path: diff.path, old_string: String(diff.oldText), new_string: String(diff.newText ?? '') } };
      return { name: 'Edit', input: { file_path: pathOf() ?? title, ...raw } };
    case 'search':
      if (tc.name === 'search_web') return { name: 'WebSearch', input: { query: String(raw.query ?? title) } }; // Antigravity's
      return { name: 'Grep', input: { pattern: String(raw.pattern ?? raw.query ?? title), ...(raw.path ? { path: raw.path } : {}) } };
    case 'fetch': return { name: 'WebFetch', input: { url: String(raw.url ?? title) } };
    default: {
      // Antigravity names an MCP tool mcp_<server>_<tool> (kind other, title "Run mcp_<server>_<tool>"): single underscores
      // throughout, so the session's server names say where the server's name ends
      const flat = String(tc.name || title.replace(/^Run /, '')).match(/^mcp_(.+)$/)?.[1];
      if (flat && /^Run mcp_/.test(title)) {
        const known = (ctx.mcpServers || []).filter((s) => flat.startsWith(s + '_')).sort((a, b) => b.length - a.length)[0];
        const [server, tool] = known ? [known, flat.slice(known.length + 1)] : [flat.split('_')[0], flat.split('_').slice(1).join('_')];
        const { toolSummary, ...args } = raw; // its own note on the call, in every tool's rawInput
        if (server && tool) return { name: `mcp__${server}__${tool}`, input: args };
      }
      // an MCP tool, named the way Claude names them (mcp__<server>__<tool>) so the swarm knows its own tools.
      // Cursor: rawInput { providerIdentifier, toolName, args }, or a title "<server>-<tool>: <tool>"
      if (raw.providerIdentifier && raw.toolName) return { name: `mcp__${raw.providerIdentifier}__${raw.toolName}`, input: raw.args && typeof raw.args === 'object' ? raw.args : {} };
      const m = title.match(/^([\w.-]+?)-([\w.-]+): \2$/);
      if (m) return { name: `mcp__${m[1]}__${m[2]}`, input: raw };
      // Cursor's subagent: rawInput { _toolName: 'task', description, prompt } -> Claude's Task card
      if (raw._toolName === 'task') return { name: 'Task', input: { description: String(raw.description ?? title), prompt: String(raw.prompt ?? '') } };
      // Gemini's exit_plan_mode asks with no rawInput, only a title naming the plan file: Claude's ExitPlanMode, with the plan
      const plan = title.match(/^Requesting plan approval for: (.+)$/);
      if (plan) return { name: 'ExitPlanMode', input: { plan: planText(plan[1].trim()), planFilePath: plan[1].trim() } };
      // OpenCode 2.2+ reaches MCP tools from code, through its execute tool: one plain call shows as that tool
      if ((title === 'execute' || tc.name === 'execute') && typeof raw.code === 'string') {
        const call = codeCall(raw.code);
        if (call) return { ...call, viaCode: true };
      }
      const { _toolName, ...rest } = raw;
      return { name: title || tc.kind || 'tool', input: rest };
    }
  }
}

// OpenCode's execute code (`return await tools.swarm.start_agent({ name: 'x', prompt: "..." })`) as the one MCP call it
// makes: { name: mcp__<server>__<tool>, input: its arguments }. Only when there is exactly one call, outside any loop,
// with literal arguments (read, never run); otherwise null and the call stays an execute card showing its code.
// every file a tool call names: its locations, its diffs, path arguments, and the path toolOf found (Agent.autoDecision)
export function pathsOf(tc, input = {}) {
  const raw = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {};
  const out = [
    ...(Array.isArray(tc.locations) ? tc.locations.map((l) => l?.path) : []),
    ...(Array.isArray(tc.content) ? tc.content.filter((c) => c?.type === 'diff').map((c) => c.path) : []),
    raw.filePath, raw.file_path, raw.path, raw.Path, raw.abs_path, raw.notebook_path, input.notebook_path,
    input.file_path !== tc.title ? input.file_path : undefined, // toolOf's last resort is the title, which is no path
  ];
  return [...new Set(out.filter((p) => typeof p === 'string' && p))];
}

export function codeCall(code) {
  const calls = [...code.matchAll(/\btools\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)];
  if (calls.length !== 1) return null;
  const [m] = calls;
  const p = { s: code, i: m.index + m[0].length };
  skipWs(p);
  let input = {};
  if (code[p.i] !== ')') {
    const v = readLiteral(p);
    if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    skipWs(p);
    if (code[p.i] === ',') { p.i++; skipWs(p); }
    if (code[p.i] !== ')') return null;
    input = v;
  }
  p.i++; // past the call's ')'
  // the card shows only the call, so the code around it must do nothing else: at most `const x = await`, `return`, `;`,
  // comments, and `return x` of that result. Anything more (another statement, a loop, a second call) stays an execute
  // card with the whole code, so the user sees what would run.
  const strip = (t) => t.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  const before = strip(code.slice(0, m.index)), after = strip(code.slice(p.i));
  const pre = /^\s*(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*)?(?:return\s+)?(?:await\s+)?$/.exec(before);
  if (!pre) return null;
  const post = /^\s*;?\s*(?:return\s+([A-Za-z_$][\w$]*)\s*;?\s*)?$/.exec(after);
  if (!post || (post[1] && post[1] !== pre[1])) return null;
  return { name: `mcp__${m[1]}__${m[2]}`, input };
}

const skipWs = (p) => { for (;;) { const r = /^(\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(p.s.slice(p.i)); if (!r) return; p.i += r[0].length; } };
// a JavaScript literal (object, array, string, number, true/false/null) at p.i; undefined if it is anything else
function readLiteral(p) {
  skipWs(p);
  const s = p.s, c = s[p.i];
  if (c === '{' || c === '[') {
    const obj = c === '{', out = obj ? {} : [];
    p.i++;
    for (;;) {
      skipWs(p);
      if (s[p.i] === (obj ? '}' : ']')) { p.i++; return out; }
      if (obj) {
        let key;
        const id = /^[A-Za-z_$][\w$]*/.exec(s.slice(p.i));
        if (id) { key = id[0]; p.i += key.length; } else { key = readLiteral(p); if (typeof key !== 'string' && typeof key !== 'number') return undefined; }
        skipWs(p);
        if (s[p.i] !== ':') return undefined;
        p.i++;
        const v = readLiteral(p);
        if (v === undefined) return undefined;
        out[key] = v;
      } else {
        const v = readLiteral(p);
        if (v === undefined) return undefined;
        out.push(v);
      }
      skipWs(p);
      if (s[p.i] === ',') p.i++;
      else if (s[p.i] !== (obj ? '}' : ']')) return undefined;
    }
  }
  if (c === '"' || c === "'" || c === '`') {
    let out = '';
    for (let i = p.i + 1; i < s.length; i++) {
      const ch = s[i];
      if (ch === c) { p.i = i + 1; return out; }
      if (c === '`' && ch === '$' && s[i + 1] === '{') return undefined; // a template with values in it
      if (c !== '`' && ch === '\n') return undefined;
      if (ch !== '\\') { out += ch; continue; }
      const e = s[++i];
      if (e === 'u' && s[i + 1] === '{') { const j = s.indexOf('}', i); out += String.fromCodePoint(parseInt(s.slice(i + 2, j), 16)); i = j; }
      else if (e === 'u') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; }
      else if (e === 'x') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
      else if (e === '\n') { /* a line continuation */ }
      else out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }[e] ?? e;
    }
    return undefined;
  }
  const r = /^(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|true|false|null)(?![\w$])/.exec(s.slice(p.i));
  if (!r) return undefined;
  p.i += r[0].length;
  return r[0] === 'true' ? true : r[0] === 'false' ? false : r[0] === 'null' ? null : Number(r[0]);
}

// a plan file's text (Gemini writes its plan to a file and asks to approve that)
function planText(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(200000); const n = fs.readSync(fd, buf, 0, buf.length, 0); return buf.toString('utf8', 0, n) + (n === buf.length ? '\n\n(cut short)' : ''); }
    finally { fs.closeSync(fd); }
  } catch { return `The plan is in ${file}`; }
}

// a tool call's output as text for the tool_result block
function resultText(tc) {
  const parts = [];
  for (const c of Array.isArray(tc.content) ? tc.content : []) {
    if (c?.type === 'content' && c.content?.type === 'text') parts.push(c.content.text);
    else if (c?.type === 'diff') parts.push(`${c.oldText == null ? 'wrote' : 'edited'} ${c.path}`);
    else if (c?.type === 'terminal') parts.push(`(terminal ${c.terminalId})`);
  }
  if (parts.length) return parts.join('\n');
  const o = tc.rawOutput;
  if (o == null) return '';
  if (typeof o === 'string') return o;
  if (typeof o.output === 'string') return o.output;
  if (typeof o.stdout === 'string' || typeof o.stderr === 'string') return [o.stdout, o.stderr].filter(Boolean).join('\n') + (o.exitCode ? `\n(exit code ${o.exitCode})` : '');
  return JSON.stringify(o);
}

const todoStatus = (s) => (s === 'in_progress' || s === 'completed' ? s : 'pending');

// desc: { id, label, bin, capabilities, launch(spec) -> { args, env }, setup?(spec) -> steps, authMethod?, preamble?, probe? }
// setup steps, applied in order once the session exists: { configId, value } (session/set_config_option),
// { model } (session/set_model, matched against the session's model list) or { mode } (session/set_mode).
// authMethod: an authMethods id to call `authenticate` with before the session (Cursor needs it, or session/new hangs).
// acpArgs: the arguments that start its ACP server with nothing else, for History's short-lived processes.
export function createAcpBackend(desc) {
  const backend = {
    ...desc,
    driverKind: 'acp',
    reencodeOnRedeliver: true, // stdin lines belong to one process's protocol conversation; a new process gets the texts again

    launch(spec) {
      const { args, env } = desc.launch(spec);
      return { cmd: desc.bin, args, env, stderr: 'separate' };
    },

    ownsPid(pid) {
      try {
        return new RegExp(desc.bin.replace(/[^\w-]/g, '')).test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
      } catch { return false; }
    },

    // the swarm's decision as what the driver answers (see driver.answer)
    permissionResult(d) { return d; },

    driver(agent, saved, spec) { return acpDriver(backend, agent, saved, spec); },

    // the model list from the CLI's ACP server (desc.models.acp: a method answering { models: [{ value }] }), no session
    listModels(opts) { return listModelsAcp(backend, opts); },
    // History: the CLI's sessions (session/list), or null when it can't list them
    listSessions(opts) { return listSessions(backend, opts); },
    // History: a session's conversation as swarm events, read by loading it in a short-lived process (its replay)
    readSession(opts) { return readSession(backend, opts); },
  };
  return backend;
}

// ---- History: short-lived ACP processes, separate from any agent's ---------------------------------------------
// They run the CLI's bare ACP server (acpArgs) with the account's environment and are killed when done.
function oneShot(backend, { env, cwd, timeoutMs = 60000 }, onStart) {
  return new Promise((resolve, reject) => {
    const ch = spawn(backend.bin, backend.acpArgs || ['acp'], { cwd: cwd || os.tmpdir(), env: env || process.env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '', done = false;
    const finish = (err, v) => { if (done) return; done = true; clearTimeout(timer); try { ch.kill(); } catch {} if (err) reject(err); else resolve(v); };
    const timer = setTimeout(() => finish(new Error(`${backend.label} did not answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    ch.on('error', (e) => finish(e));
    ch.on('close', (code) => finish(new Error(`${backend.label} exited (${code})`))); // after its output is read
    ch.stdin.on('error', () => {});
    const write = (text) => { if (!done) ch.stdin.write(text); };
    const onLine = onStart({ write, finish });
    ch.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim() && !done) onLine(l); }
    });
  });
}

function listModelsAcp(backend, opts = {}) {
  return oneShot(backend, opts, ({ write, finish }) => {
    let next = 1;
    const calls = {};
    const request = (method, params) => { const id = next++; calls[id] = method; write(line({ id, method, params })); };
    request('initialize', { protocolVersion: 1, clientCapabilities: clientCaps(backend), clientInfo: { name: 'swarm', version: '1' } });
    // the list comes from a method of its own, or from session/new's models (Antigravity: no list without a session)
    const ask = () => request(backend.models.acp, backend.models.acp === 'session/new' ? { cwd: opts.cwd || os.tmpdir(), mcpServers: [] } : {});
    return (l) => {
      let m;
      try { m = JSON.parse(l); } catch { return; }
      if (m.method) { if (m.id !== undefined) write(line({ id: m.id, error: { code: -32601, message: 'not supported' } })); return; }
      const method = calls[m.id];
      if (m.error) return finish(new Error(`${backend.label}: ${method} failed: ${m.error.message || JSON.stringify(m.error)}`));
      if (method === 'initialize') {
        if (backend.authMethod && (m.result?.authMethods || []).some((a) => a.id === backend.authMethod)) return request('authenticate', { methodId: backend.authMethod });
        return ask();
      }
      if (method === 'authenticate') return ask();
      if (method === backend.models.acp) {
        const list = Array.isArray(m.result?.models) ? m.result.models : m.result?.models?.availableModels; // session/new: { models: { availableModels } }
        return finish(null, (list || []).map((x) => String(x.value ?? x.modelId ?? '')).filter(Boolean));
      }
    };
  });
}

const HISTORY_MAX = 500; // sessions listed per account

function listSessions(backend, opts) {
  return oneShot(backend, opts, ({ write, finish }) => {
    let next = 1;
    const calls = {}, sessions = [];
    const request = (method, params) => { const id = next++; calls[id] = method; write(line({ id, method, params })); };
    request('initialize', { protocolVersion: 1, clientCapabilities: clientCaps(backend), clientInfo: { name: 'swarm', version: '1' } });
    return (l) => {
      let m;
      try { m = JSON.parse(l); } catch { return; }
      if (m.method) { if (m.id !== undefined) write(line({ id: m.id, error: { code: -32601, message: 'not supported' } })); return; }
      const method = calls[m.id];
      delete calls[m.id];
      if (m.error) return finish(new Error(`${backend.label}: ${method} failed: ${m.error.message || JSON.stringify(m.error)}`));
      if (method === 'initialize') {
        if (!m.result?.agentCapabilities?.sessionCapabilities?.list) return finish(null, null);
        if (backend.authMethod && (m.result.authMethods || []).some((a) => a.id === backend.authMethod)) return request('authenticate', { methodId: backend.authMethod });
        return request('session/list', {});
      }
      if (method === 'authenticate') return request('session/list', {});
      if (method === 'session/list') {
        for (const x of m.result?.sessions || []) {
          if (!x?.sessionId || !x.cwd || !x.title) continue; // untitled: opened but never prompted (Cursor lists those too)
          sessions.push({ id: String(x.sessionId), cwd: String(x.cwd), title: typeof x.title === 'string' ? x.title : '', mtime: Date.parse(x.updatedAt) || 0 });
        }
        if (m.result?.nextCursor && sessions.length < HISTORY_MAX) return request('session/list', { cursor: m.result.nextCursor });
        return finish(null, sessions.slice(0, HISTORY_MAX));
      }
    };
  });
}

function readSession(backend, { env, cwd, sessionId, timeoutMs }) {
  return oneShot(backend, { env, cwd, timeoutMs }, ({ write, finish }) => {
    const out = [];
    // the driver of a process that never prompts: no swarm MCP server, and it never asks anything
    const stub = { cwd, writeIn: (text) => write(text), push: (e) => out.push(e), saveDriverState() {}, setStatus() {}, autoDecision: () => 'deny', requestPermission: async () => ({ allowed: false }) };
    const d = acpDriver(backend, stub, null, { sessionId, replay: true, mcpServers: {} });
    for (const l of d.started()) write(l);
    return (l) => {
      out.push(...d.onLine(l));
      const st = d.state();
      if (st.phase === 'failed') return finish(new Error(out.findLast((e) => e.type === 'result')?.result || `${backend.label} could not load the session`));
      if (st.phase === 'ready') finish(null, out.filter((e) => !(e.type === 'system' && e.subtype === 'init')));
    };
  });
}

function acpDriver(backend, agent, saved, spec) {
  // st is everything needed to carry on after a server restart; it must stay plain JSON
  const st = saved ? JSON.parse(saved) : {
    next: 1, // our next request id
    calls: {}, // id -> method of our requests still waiting for a response
    phase: 'init', // init | session | ready | failed
    loading: false, // a session/load is replaying history (not shown: the swarm has the chat already; but see spec.replay)
    userText: '', // a replayed user message being streamed (spec.replay)
    session: null, // the ACP session id
    queue: [], // user texts waiting for the session or for the current prompt to finish
    prompting: null, // id of the session/prompt in flight
    text: '', thought: '', // the assistant message being streamed
    msgs: 0, // assistant messages emitted (for their ids)
    tools: {}, // toolCallId -> { tc, emitted, done }
    lastText: '', // the turn's last assistant text: the result
    cost: null, costAtTurn: null, procCost: 0, // cumulative session cost from usage_update; what this process spent
    perms: {}, // their request id -> { id, kind: permission | question | plan, ... } while the user decides
    todos: [], // Cursor's todo list (cursor/update_todos can merge into it)
    mcp: Object.keys(spec?.mcpServers || {}), // the MCP servers the session has (toolOf: where a flattened tool name splits)
    always: [], // "always allow" answers the agent's own options couldn't take (it offers allow_once only): { toolName, ruleContent }
    setup: [], // steps still to apply after session/new or session/load (see setup above)
    models: [], // the session's model ids (session/new's unstable `models` field), to match a setup model against
    preamble: false, // the swarm instructions still have to go in front of the first prompt
    preambleAt: null, // st.msgs when the prompt carrying them was sent, until it ends
  };
  const write = (o) => agent.writeIn(line(o));
  // text: the user's words a prompt carries, so a message the process never read can go to a new one (Agent.redeliver)
  const request = (method, params, text) => { const id = st.next++; st.calls[id] = method; agent.writeIn(line({ id, method, params }), text); return id; };
  const ev = (e) => ({ ...e, session_id: st.session || undefined });
  // what a backend adds to session/new and session/load (Antigravity: the swarm's instructions as an appended system prompt)
  const sessionMeta = () => { const meta = backend.newSessionMeta?.(spec || {}); return meta ? { _meta: meta } : {}; };
  const mcpServers = (s) => Object.entries(s.mcpServers || {}).map(([name, m]) => ({ name, command: m.command, args: m.args || [], env: Object.entries(m.env || {}).map(([k, v]) => ({ name: k, value: String(v) })) }));

  // flush the streamed text/thinking into one assistant message
  function flush(out) {
    const content = [];
    if (st.thought) content.push({ type: 'thinking', thinking: st.thought });
    if (st.text) content.push({ type: 'text', text: st.text });
    if (st.text) st.lastText = st.text;
    st.text = ''; st.thought = '';
    if (content.length) out.push(ev({ type: 'assistant', message: { id: `acp-${++st.msgs}`, role: 'assistant', content } }));
  }

  function emitTool(out, id) {
    const t = st.tools[id];
    if (!t || t.emitted) return;
    flush(out);
    t.emitted = true;
    const { name, input } = toolOf(t.tc, { mcpServers: st.mcp });
    out.push(ev({ type: 'assistant', message: { id: `acp-${++st.msgs}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input, _acp: { kind: t.tc.kind, title: t.tc.title } }] } }));
  }

  function toolUpdate(out, u) {
    const t = st.tools[u.toolCallId] || (st.tools[u.toolCallId] = { tc: {}, emitted: false, done: false });
    for (const [k, v] of Object.entries(u)) if (v != null && k !== 'sessionUpdate') t.tc[k] = k === 'rawInput' && t.tc.rawInput ? { ...t.tc.rawInput, ...v } : v;
    const status = t.tc.status;
    if (status === 'in_progress' || status === 'completed' || status === 'failed') emitTool(out, u.toolCallId);
    if ((status === 'completed' || status === 'failed') && !t.done) {
      t.done = true;
      out.push(ev({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: u.toolCallId, content: resultText(t.tc), is_error: status === 'failed' }] } }));
    }
  }

  // a replayed user message, without the swarm instructions it may have carried
  function flushUser(out) {
    const text = st.userText.replace(/^<swarm-instructions>[\s\S]*?<\/swarm-instructions>\s*/, '').trim();
    st.userText = '';
    if (text) out.push(ev({ type: 'user_prompt', text }));
  }

  function onUpdate(out, u) {
    if (!u || typeof u !== 'object') return;
    if (u.sessionUpdate === 'user_message_chunk') {
      if (spec?.replay && u.content?.type === 'text') { flush(out); st.userText += u.content.text; }
      return;
    }
    if (st.userText) flushUser(out);
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': if (u.content?.type === 'text') st.text += u.content.text; return; // with the thinking before it: one message
      case 'agent_thought_chunk': if (u.content?.type === 'text') { if (st.text) flush(out); st.thought += u.content.text; } return;
      case 'tool_call': case 'tool_call_update': return toolUpdate(out, u);
      case 'plan':
        flush(out);
        out.push(ev({ type: 'assistant', message: { id: `acp-${++st.msgs}`, role: 'assistant', content: [{ type: 'tool_use', id: `plan-${st.msgs}`, name: 'TodoWrite', input: { todos: (u.entries || []).map((x) => ({ content: String(x.content ?? ''), status: todoStatus(x.status), activeForm: String(x.content ?? '') })) } }] } }));
        return;
      case 'usage_update':
        if (typeof u.cost?.amount === 'number') st.cost = u.cost.amount;
        if (u.used > 0) out.push(ev({ type: 'system', subtype: 'context', used: u.used, size: u.size ?? null }));
        return;
      default: // available_commands_update, current_mode_update, config_option_update: nothing to show
    }
  }

  function startPrompt() {
    if (st.phase !== 'ready' || st.prompting || !st.queue.length) return false;
    const user = st.queue.splice(0).join('\n\n');
    const text = st.preamble && spec?.systemPrompt ? preamble(spec.systemPrompt) + user : user;
    st.preambleAt = st.preamble && spec?.systemPrompt ? st.msgs : null; // see session/prompt below
    st.preamble = false;
    st.costAtTurn = st.cost; st.lastText = '';
    st.prompting = request('session/prompt', { sessionId: st.session, prompt: [{ type: 'text', text }] }, user);
    return true;
  }

  function sessionReady(out) {
    const next = st.setup.shift();
    if (next?.configId) return request('session/set_config_option', { sessionId: st.session, configId: next.configId, value: next.value });
    if (next?.effort) { // the model's own reasoning option (category thought_level), with the swarm's level mapped onto its values
      const opt = (st.opts || []).find((o) => o.category === 'thought_level');
      const value = opt && effortValue(opt, next.effort);
      if (value) return request('session/set_config_option', { sessionId: st.session, configId: opt.id, value });
      out?.push(ev({ type: 'note', text: opt ? `effort ${next.effort}: this model's levels are ${optionValues(opt).join(', ')}` : `effort ${next.effort}: this model has no effort setting` }));
      return sessionReady(out);
    }
    if (next?.mode) return request('session/set_mode', { sessionId: st.session, modeId: next.mode });
    if (next?.model) { // "gpt-5.3-codex" -> the session's "gpt-5.3-codex[reasoning=medium,fast=false]"
      const id = st.models.find((x) => x === next.model) || st.models.find((x) => x.startsWith(next.model + '[')) || next.model;
      return request('session/set_model', { sessionId: st.session, modelId: id });
    }
    st.phase = 'ready';
    if (startPrompt()) setImmediate(() => { if (st.prompting) agent.setStatus('running'); });
  }

  function turnEnded(out, result, error) {
    flush(out);
    st.prompting = null;
    // a call the user refused whose end the agent never reported (Antigravity sometimes ends the turn without it): closed here
    for (const [id, t] of Object.entries(st.tools)) {
      if (t.denied && t.emitted && !t.done) out.push(ev({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: t.denied, is_error: true }] } }));
    }
    st.tools = {}; // their calls are over: keep the saved state small
    const turnCost = st.cost != null ? Math.max(0, st.cost - (st.costAtTurn ?? 0)) : null;
    if (turnCost != null) st.procCost += turnCost;
    const u = result?.usage || {};
    const stop = result?.stopReason;
    out.push(ev({
      type: 'result', subtype: error ? 'error' : stop === 'end_turn' ? 'success' : stop || 'success', is_error: !!error || stop === 'refusal',
      result: error ? `error: ${error.message || JSON.stringify(error)}` : stop === 'cancelled' ? 'Interrupted' : st.lastText,
      stop_reason: stop, num_turns: 1,
      ...(result?.usage ? { usage: { input_tokens: u.inputTokens || 0, output_tokens: (u.outputTokens || 0) + (u.thoughtTokens || 0), cache_read_input_tokens: u.cachedReadTokens || 0, cache_creation_input_tokens: u.cachedWriteTokens || 0 } } : {}),
      ...(st.cost != null ? { total_cost_usd: st.procCost } : {}),
    }));
  }

  // a response to one of our requests
  function onResponse(out, m) {
    const method = st.calls[m.id];
    delete st.calls[m.id];
    if (!method) return;
    if (m.error && !['session/prompt', 'session/set_config_option', 'session/set_model', 'session/set_mode'].includes(method)) {
      // the session could not be set up: report it and end the turn the user is waiting on
      out.push(ev({ type: 'stderr', text: `${backend.label}: ${method} failed: ${m.error.message || JSON.stringify(m.error)}` }));
      if (method === 'session/load' && !spec?.replay) { st.session = null; request('session/new', { cwd: agent.cwd, mcpServers: mcpServers(spec || {}), ...sessionMeta() }); return; }
      st.phase = 'failed';
      st.queue = [];
      out.push(ev({ type: 'result', subtype: 'error', is_error: true, result: `${backend.label} could not start a session: ${m.error.message || 'error'}` }));
      return;
    }
    switch (method) {
      case 'initialize': {
        st.phase = 'session';
        st.caps = m.result?.agentCapabilities || {};
        if (backend.authMethod && (m.result?.authMethods || []).some((a) => a.id === backend.authMethod)) { request('authenticate', { methodId: backend.authMethod }); return; }
        return openSession();
      }
      case 'authenticate': return openSession();
      case 'session/new':
        st.session = m.result?.sessionId || null;
        st.preamble = !!backend.preamble;
        st.models = modelIdsOf(m.result);
        if (Array.isArray(m.result?.configOptions)) st.opts = slimOpts(m.result.configOptions);
        out.push(ev({ type: 'system', subtype: 'init', model: currentOf(m.result, 'model'), _acp: { agent: backend.id } }));
        return sessionReady(out);
      case 'session/load':
        if (st.userText) flushUser(out);
        flush(out);
        st.loading = false;
        st.preamble = !!backend.preamble && !!spec?.instructionsOnLoad && !spec?.replay; // see Agent.launchSpec
        st.models = modelIdsOf(m.result);
        if (Array.isArray(m.result?.configOptions)) st.opts = slimOpts(m.result.configOptions);
        out.push(ev({ type: 'system', subtype: 'init', model: currentOf(m.result, 'model'), resumed: true, _acp: { agent: backend.id } }));
        return sessionReady(out);
      case 'session/set_config_option': case 'session/set_model': case 'session/set_mode':
        if (m.error) out.push(ev({ type: 'stderr', text: `${backend.label}: ${method} failed: ${m.error.message || JSON.stringify(m.error)}` }));
        if (Array.isArray(m.result?.configOptions)) st.opts = slimOpts(m.result.configOptions); // a new model brings its own options
        return sessionReady(out);
      case 'session/prompt':
        turnEnded(out, m.result, m.error);
        // the prompt that carried the instructions failed before the agent said or did anything (a login or quota
        // error, say): the session may never have taken them in, so they go with the next message again
        if (m.error && st.preambleAt != null && st.msgs === st.preambleAt) st.preamble = true;
        st.preambleAt = null;
        if (st.setup.length && st.phase === 'ready') { st.phase = 'session'; return sessionReady(out); } // see reconfigure
        // queued messages start the next turn right away; the agent shows running again once the result above is in
        if (startPrompt()) setImmediate(() => { if (st.prompting) agent.setStatus('running'); });
        return;
      default:
    }
  }

  // resume the agent's session if it has one and the CLI can, else start a new one
  function openSession() {
    if (spec?.sessionId && st.caps?.loadSession) { st.session = spec.sessionId; st.loading = true; request('session/load', { sessionId: spec.sessionId, cwd: agent.cwd, mcpServers: mcpServers(spec), ...sessionMeta() }); }
    else request('session/new', { cwd: agent.cwd, mcpServers: mcpServers(spec || {}), ...sessionMeta() });
  }

  // a request from the agent to us
  function onRequest(out, m) {
    const p = m.params || {};
    if (m.method === 'session/request_permission') {
      st.perms[m.id] = { id: m.id, kind: 'permission', toolCall: p.toolCall || {}, options: p.options || [] };
      return askPermission(out, m.id);
    }
    // Cursor's blocking extensions: multiple-choice questions and plan approval, asked like Claude's AskUserQuestion and ExitPlanMode
    if (m.method === 'cursor/ask_question') {
      st.perms[m.id] = { id: m.id, kind: 'question', title: p.title || '', questions: Array.isArray(p.questions) ? p.questions : [], toolCallId: p.toolCallId };
      return askPermission(out, m.id);
    }
    if (m.method === 'cursor/create_plan') {
      const ownTitle = /^\s*# /.test(String(p.plan || '')); // the plan text usually brings its own heading
      st.perms[m.id] = { id: m.id, kind: 'plan', plan: [!ownTitle && p.name && `# ${p.name}`, p.overview, p.plan].filter(Boolean).join('\n\n'), toolCallId: p.toolCallId };
      return askPermission(out, m.id);
    }
    // Cursor's todo list and subagent reports: its docs call them notifications, but cursor-agent 2026.10 sends them
    // with an id (a subagent's once it has finished), so they get an answer too
    if (m.method === 'cursor/update_todos' || m.method === 'cursor/task') {
      onNotification(out, m);
      return write({ id: m.id, result: { outcome: m.method === 'cursor/task' ? { outcome: 'completed' } : { outcome: 'accepted', todos: p.todos || [] } } });
    }
    // fs/*, terminal/* (we declare neither) and extension methods we don't know: answer, so the agent never hangs
    write({ id: m.id, error: { code: -32601, message: `method not supported by the swarm: ${m.method}` } });
  }

  // a notification from the agent (no answer expected)
  function onNotification(out, m) {
    const p = m.params || {};
    if (m.method === 'cursor/update_todos' && Array.isArray(p.todos)) {
      const incoming = p.todos.map((t) => ({ id: String(t.id ?? ''), content: String(t.content ?? ''), status: String(t.status || 'pending') }));
      if (p.merge) { for (const t of incoming) { const i = st.todos.findIndex((x) => x.id === t.id); if (i >= 0) st.todos[i] = t; else st.todos.push(t); } }
      else st.todos = incoming;
      flush(out);
      out.push(ev({ type: 'assistant', message: { id: `acp-${++st.msgs}`, role: 'assistant', content: [{ type: 'tool_use', id: `todos-${st.msgs}`, name: 'TodoWrite', input: { todos: st.todos.filter((t) => t.status !== 'cancelled').map((t) => ({ content: t.content, status: todoStatus(t.status), activeForm: t.content })) } }] } }));
    } else if (m.method === 'cursor/task') {
      flush(out);
      const type = typeof p.subagentType === 'string' && p.subagentType !== 'unspecified' ? ` (${p.subagentType})` : '';
      const took = Number.isFinite(p.durationMs) ? `, done in ${Math.round(p.durationMs / 1000)} s` : '';
      out.push(ev({ type: 'note', text: `Subagent${type}: ${String(p.description || p.prompt || '').slice(0, 300)}${took}` }));
    }
  }

  // the swarm's form of a Cursor question: Claude's AskUserQuestion input
  const questionInput = (p) => ({ questions: p.questions.map((q) => ({ question: String(q.prompt ?? ''), header: String(p.title || 'Question').slice(0, 12), multiSelect: !!q.allowMultiple, options: (q.options || []).map((o) => ({ label: String(o.label ?? o.id), description: '' })) })) });
  // answers as the swarm gives them ({ question text: "label, label" }, a label with ", " or a quote JSON-quoted) -> option ids
  function selectedIds(q, answer) {
    if (typeof answer !== 'string') return [];
    const labels = [...answer.matchAll(/\s*("(?:[^"\\]|\\.)*"|[^,]+)/g)].map((x) => x[1].trim()).map((x) => { if (x.startsWith('"')) { try { return JSON.parse(x); } catch {} } return x; });
    return (q.options || []).filter((o) => labels.includes(String(o.label ?? o.id))).map((o) => o.id);
  }

  function askPermission(out, rpcId) {
    const p = st.perms[rpcId];
    if (p.kind === 'question' || p.kind === 'plan') {
      const req = p.kind === 'question' ? { tool_name: 'AskUserQuestion', input: questionInput(p) } : { tool_name: 'ExitPlanMode', input: { plan: p.plan } };
      setImmediate(() => { if (st.perms[rpcId]) agent.requestPermission({ ...req, tool_use_id: p.toolCallId }).then((d) => answer(rpcId, d)); });
      return;
    }
    const tcId = p.toolCall.toolCallId;
    // merge what the request knows about the call; not its text content, which Cursor uses for the reason it asks
    // ("Not in allowlist: od") or for the arguments, and which would otherwise stand in for the call's output
    const content = Array.isArray(p.toolCall.content) ? p.toolCall.content.filter((c) => c?.type !== 'content') : undefined;
    if (tcId) toolUpdate(out, { ...p.toolCall, content: content?.length ? content : undefined, status: undefined, toolCallId: tcId });
    const tc = (tcId && st.tools[tcId]?.tc) || p.toolCall;
    const { name, input, viaCode } = toolOf(tc, { mcpServers: st.mcp });
    // code that calls a swarm tool is still code: the swarm decides on it as execute, not as that tool
    const auto = agent.autoDecision(viaCode ? 'execute' : name, input, tc.kind, pathsOf(tc, input));
    if (auto) return answer(rpcId, { allowed: auto === 'allow', decision: auto, message: auto === 'deny' ? 'Not allowed for this agent' : undefined });
    if (alwaysAllowed(name, input)) return answer(rpcId, { allowed: true, decision: 'allow' });
    if (tcId) emitTool(out, tcId);
    // asked after the current batch of events is in (the request card refers to the tool_use above it)
    setImmediate(() => {
      if (!st.perms[rpcId]) return;
      agent.requestPermission({ tool_name: name, input, tool_use_id: tcId }).then((d) => answer(rpcId, d));
    });
  }

  // does an "always allow" the swarm kept (answer) cover this call? A shell rule is a command's leading words
  // (`git status:*`); it covers the command only when the rest is plain arguments, nothing the shell would act on
  function alwaysAllowed(name, input) {
    return (st.always || []).some((r) => { // (a state saved before this existed has none)
      if (r.toolName !== name) return false;
      if (!r.ruleContent) return true;
      const words = r.ruleContent.replace(/:\*$/, ''), cmd = String(input?.command ?? '').trim();
      return cmd === words || (cmd.startsWith(words + ' ') && !/[;&|<>$`()\\\n]/.test(cmd.slice(words.length)));
    });
  }

  function answer(rpcId, d) {
    const p = st.perms[rpcId];
    if (!p) return;
    delete st.perms[rpcId];
    if (p.kind === 'question') {
      const answers = d.allowed && d.answers ? p.questions.map((q) => ({ questionId: q.id, selectedOptionIds: selectedIds(q, d.answers[String(q.prompt ?? '')]) })).filter((a) => a.selectedOptionIds.length) : [];
      write({ id: p.id, result: { outcome: answers.length ? { outcome: 'answered', answers } : { outcome: 'skipped', reason: d.message || 'The user declined to answer' } } });
      return agent.saveDriverState();
    }
    if (p.kind === 'plan') {
      write({ id: p.id, result: { outcome: d.allowed ? { outcome: 'accepted' } : { outcome: 'rejected', reason: d.message || 'Rejected by the user' } } });
      return agent.saveDriverState();
    }
    // an agent that offers no allow_always (Antigravity) can't remember the user's "always": the swarm does, for this process
    if (d.allowed && d.decision === 'always' && d.alwaysRule && !p.options.some((x) => x.kind === 'allow_always')) (st.always ||= []).push(d.alwaysRule);
    if (!d.allowed && st.tools[p.toolCall.toolCallId]) st.tools[p.toolCall.toolCallId].denied = d.message || 'Denied';
    const pick = (...kinds) => { for (const k of kinds) { const o = p.options.find((x) => x.kind === k); if (o) return o.optionId; } return null; };
    const optionId = d.allowed ? (d.decision === 'always' ? pick('allow_always', 'allow_once') : pick('allow_once', 'allow_always')) : pick('reject_once', 'reject_always');
    write({ id: p.id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
    agent.saveDriverState();
  }

  const driver = {
    started() {
      st.setup = backend.setup ? backend.setup(spec || {}) : [];
      const id = st.next++;
      st.calls[id] = 'initialize';
      return [line({ id, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: clientCaps(backend), clientInfo: { name: 'swarm', version: '1' } } })];
    },
    // session changes between turns (OpenCode leaving plan mode once its plan is approved): made as soon as no turn is
    // going, before any queued message
    reconfigure(steps) {
      if (!steps?.length || st.phase === 'failed') return;
      st.setup.push(...steps);
      if (st.phase === 'ready' && !st.prompting) { st.phase = 'session'; sessionReady(null); }
      agent.saveDriverState();
    },
    // a user message: sent now if the session is idle, else queued for the end of the current turn (ACP takes one prompt at a time)
    encode(text) {
      st.queue.push(text);
      if (st.phase === 'failed') return null;
      if (st.prompting) agent.push({ type: 'note', text: 'Queued: this agent takes one message at a time; it is sent when the current turn ends' });
      startPrompt();
      return null; // written through request()
    },
    onLine(raw) {
      let m;
      try { m = JSON.parse(raw); } catch { return [{ type: 'stderr', text: raw }]; }
      if (!m || typeof m !== 'object') return [];
      const out = [];
      // spec.replay: reading a session for History, where the replay is the point
      if (m.method === 'session/update') { if (!st.loading || spec?.replay) onUpdate(out, m.params?.update); }
      else if (m.method && m.id !== undefined) onRequest(out, m);
      else if (m.method) onNotification(out, m);
      else if (m.id !== undefined) onResponse(out, m);
      return out;
    },
    interrupt() {
      driver.drop();
      if (st.session && st.prompting) write({ method: 'session/cancel', params: { sessionId: st.session } });
      for (const id of Object.keys(st.perms)) answer(id, { allowed: false });
    },
    // after a server restart: the requests the user had open were lost with the old server; ask again
    resume() {
      const out = [];
      for (const id of Object.keys(st.perms)) askPermission(out, id);
      return out;
    },
    drop() { if (st.queue.length) agent.push({ type: 'note', text: `${st.queue.length} queued message(s) dropped` }); st.queue = []; },
    unsent() { return st.queue.slice(); }, // messages still waiting for the session: never on the wire
    state() { return st; },
  };
  return driver;
}

// the session's config options, kept small for the saved state: what setup steps are resolved against
const slimOpts = (list) => list.map((o) => ({ id: o.id, category: o.category, currentValue: o.currentValue, options: (o.options || []).map((x) => ({ value: x.value ?? x.id })) }));
const optionValues = (opt) => (opt.options || []).map((x) => String(x.value ?? x.id));
// the swarm's effort (low, medium, high, xhigh, max) as one of the model's values: the same name, else the nearest above
// (xhigh is Cursor's extra-high for some models; max falls back to the highest level there is)
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function effortValue(opt, effort) {
  const vals = optionValues(opt);
  const norm = (v) => v.toLowerCase().replace(/^extra[-_ ]?high$/, 'xhigh');
  const rank = (v) => EFFORT_ORDER.indexOf(norm(v));
  const exact = vals.find((v) => norm(v) === effort);
  if (exact) return exact;
  const want = EFFORT_ORDER.indexOf(effort), known = vals.filter((v) => rank(v) >= 0).sort((a, b) => rank(a) - rank(b));
  return known.find((v) => rank(v) >= want) || known.at(-1) || null;
}

const modelIdsOf = (r) => (Array.isArray(r?.models?.availableModels) ? r.models.availableModels.map((m) => String(m.modelId)) : []);
const currentOf = (r, cat) => r?.models?.currentModelId && cat === 'model' ? r.models.currentModelId : (Array.isArray(r?.configOptions) ? r.configOptions.find((o) => o.category === cat || o.id === cat)?.currentValue ?? null : null);
