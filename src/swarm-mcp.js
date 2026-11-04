// stdio MCP server handed to every swarm agent (claude --mcp-config). It provides:
//  - approve: claude's --permission-prompt-tool; forwards permission requests to the web UI
//  - the swarm tools, so an agent can start other agents in the swarm and drive them
// An agent can only see and control the agents it started itself; the conductor (the swarm chat) can drive any agent.
// The conductor can also drive peers (other swarm instances, docs/peers.md): with `peer` a call goes to this server's
// /api/peers/<peer>/… proxy, which forwards it with the peer's token, so the token never reaches this process.
import http from 'node:http';
import readline from 'node:readline';
import { statsLine } from './stats.js';
import { BACKENDS } from './backends/index.js';
import { env } from './util.js';

const HALAY_URL = env('URL'), HALAY_TOKEN = env('TOKEN'), HALAY_AGENT = env('AGENT'), HALAY_ROLE = env('ROLE'), HALAY_BACKEND = env('BACKEND');
const conductor = HALAY_ROLE === 'conductor';
// the caller's CLI when it isn't Claude: descriptions then use its words (its subagent tool, its model names);
// Claude's descriptions stay as they are
const own = HALAY_BACKEND && HALAY_BACKEND !== 'claude' ? BACKENDS[HALAY_BACKEND] || null : null;
const say = (claude, other) => (own ? other : claude);

// errors that prove the request never reached the server (nothing listening yet, e.g. while it restarts)
const UNSENT = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);
const requestOnce = (method, path, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      `${HALAY_URL}${path}`,
      { method, headers: { authorization: `Bearer ${HALAY_TOKEN}`, 'content-type': 'application/json', 'x-halay-agent': HALAY_AGENT || '' } },
      (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('close', () => { if (!res.complete) reject(Object.assign(new Error('connection lost'), { transient: true })); });
        res.on('end', () => {
          let j;
          try { j = JSON.parse(s); } catch { j = { error: s }; }
          res.statusCode < 300 ? resolve(j) : reject(Object.assign(new Error(j.error || s), { status: res.statusCode }));
        });
      },
    );
    req.on('error', (e) => reject(Object.assign(e, { transient: true, unsent: UNSENT.has(e.code) })));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

// If the swarm server is restarting, keep trying: the new server picks the request up instead of failing it. Only reads
// (GET, or a call marked safe: a wait or a permission request the old server took down with it) are repeated after a
// cut-off; anything else is repeated only when it provably never arrived, so a restart can't start an agent or post a
// message twice.
const request = async (method, path, body, { safe = method === 'GET' } = {}) => {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    try { return await requestOnce(method, path, body); } catch (e) {
      if (!e.transient || Date.now() > deadline) throw e;
      if (!safe && !e.unsent) throw new Error(`the connection to the swarm server was lost (it may have restarted) before it answered ${method} ${path}; check whether it took effect before trying again`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
};

// an /api/… path on this server, or the same path on a peer through this server's proxy
const at = (peer, p) => (peer ? p.replace(/^\/api\//, `/api/peers/${encodeURIComponent(peer)}/`) : p);
const onPeer = (peer) => (peer ? ` on peer ${peer}` : '');

// the agent with the last `tail` events (slimmed by the server), or with all of them untouched when tail is 0
// seen: the caller reads its result now, so a pending turn notification about it is dropped (server.js noticeSeen)
const child = async (id, tail = 1, peer, seen) => {
  if (id === HALAY_AGENT && !peer) throw new Error('that is you; agent_id must be an agent you started');
  let err;
  const qs = [tail ? 'tail=' + tail : null, seen && !peer ? 'seen=1' : null].filter(Boolean).join('&');
  const a = await request('GET', at(peer, `/api/agents/${encodeURIComponent(id)}${qs ? '?' + qs : ''}`)).catch((e) => { err = e; return null; });
  if (peer && !a && err?.status !== 404) throw err; // the peer is unreachable or refused: say that, not "no agent"
  if (!a || (!conductor && a.parentId !== HALAY_AGENT)) throw new Error(`no agent ${id} among the agents you can control${onPeer(peer)} (see list_agents)`);
  return a;
};

// Outputs are kept short: everything returned here stays in the caller's context for the rest of its session.
const kTok = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0));
const brief = (a) =>
  `- ${a.id} "${a.name}"${a.bot ? ` [bot @${a.bot.handle}${a.bot.paused ? ', paused' : ''}]` : ''} ${a.status}${a.handoff ? ` (handoff ${a.handoff})` : ''} · ${a.account} · ${a.permissionMode}${a.model ? ' · ' + a.model : ''}${a.effort ? ' · effort ' + a.effort : ''} · context ${kTok(a.context)} · ${a.oneOff ? 'one-off folder' : a.cwd}` +
  `${a.worktree ? ` · worktree branch ${a.worktree.branch}` : ''} · started by ${a.parentId || a.startedBy || 'user'}${a.role === 'conductor' ? ' · (its swarm chat)' : ''}` +
  (a.waiting?.questions ? ' · BLOCKED: waiting for the user to answer its question' : '') +
  (a.waiting?.approvals ? ` · BLOCKED: waiting for the user to approve ${a.waiting.approvals > 1 ? a.waiting.approvals + ' tool calls' : 'a tool call'}` : '') +
  stuckNote(a);
const stuckNote = (a) => (a.watchdog ? ` · ${a.watchdog.kind === 'loop' ? 'MAY BE LOOPING' : 'LOOKS STUCK'}: ${a.watchdog.detail}` : '');
const clip = (s, max, hint) => (s.length <= max ? s : `${s.slice(0, max)}… [${s.length - max} more chars${hint ? '; ' + hint : ''}]`);

// "BLOCKED: …" for an approval or a question (AskUserQuestion) the agent waits on; the user answers either in the swarm UI
const blockedLine = (question, what) => (question
  ? `BLOCKED: waiting for the user to answer ${what} in the swarm UI (not an approval; only the user can answer it)`
  : `BLOCKED: waiting for the user to approve ${what} in the swarm UI`);
const questionText = (input) => `a question: ${(Array.isArray(input?.questions) ? input.questions : []).map((q) => JSON.stringify(String(q?.question ?? ''))).join('; ')}`;

// What a parent needs to see of a child: the recent conversation, and whether it is stuck on an approval or a question.
// Long lines are clipped unless full; the newest reply of the agent gets more room than older ones.
function condense(a, n, full) {
  const open = new Map();
  for (const p of a.pending || []) open.set(p.event.reqId, p.event);
  for (const e of a.events) {
    if (e.type === 'permission_request') open.set(e.reqId, e);
    if (e.type === 'permission_resolved') open.delete(e.reqId);
  }
  const lines = [];
  for (const e of a.events) {
    if (e.parent_tool_use_id) continue;
    if (e.type === 'user_prompt') lines.push([e.handoffAsk ? '[prompt] (asked for a handoff note)' : `[prompt] ${e.text}`, 400]);
    else if (e.type === 'peer_message') lines.push([`[message from session ${e.fromName || e.from}] ${e.text}`, 400]);
    else if (e.type === 'assistant')
      for (const c of e.message?.content || []) {
        if (c.type === 'text') lines.push([`[agent] ${c.text}`, 1200, true]);
        else if (c.type === 'tool_use') lines.push([`[tool] ${c.name} ${JSON.stringify(c.input)}`, 150]);
      }
    else if (e.type === 'result') lines.push([`[turn finished${e.is_error ? ' with an error' : ''}]`]);
    else if (e.type === 'stderr') lines.push([`[error] ${e.text}`, 300]);
    else if (e.type === 'context_reset') lines.push([`[fresh context${e.handoff ? ', continuing from a handoff note' : ''}]`]);
  }
  const lastReply = lines.findLastIndex((l) => l[2]);
  let clipped = false;
  const out = lines.slice(-n).map(([t, max], i, arr) => {
    const lim = lines.length - arr.length + i === lastReply ? 4000 : max;
    if (full || !lim || t.length <= lim) return t;
    clipped = true;
    return clip(t, lim);
  });
  const more = lines.length > out.length ? `(${lines.length - out.length} earlier lines not shown; pass a larger last to see them)` : null;
  const blocked = [...open.values()].map((r) => (r.tool_name === 'AskUserQuestion' ? blockedLine(true, clip(questionText(r.input), 400)) : blockedLine(false, r.rule || r.tool_name)));
  return [`status: ${a.status}${stuckNote(a)} · context ${kTok(a.context)}`, ...blocked, more, out.join('\n') || '(nothing yet)', clipped ? '(long lines were clipped; full=true shows them whole)' : null].filter(Boolean).join('\n');
}

const RESULT_MAX = 3000;
const waitFor = async (id, seconds, peer) => {
  const r = await request('POST', at(peer, `/api/agents/${encodeURIComponent(id)}/wait`), { timeout: seconds }, { safe: true });
  const parts = [`status: ${r.status}`];
  if (r.pending.length) parts.push(...r.pending.map((p) => (typeof p === 'string' ? blockedLine(false, p) : blockedLine(p.question, p.text))));
  if (r.status === 'running') parts.push(`(still working after ${seconds}s; call wait_for_agent again or read_agent to see progress)`);
  else parts.push(`result: ${clip(String(r.result ?? '(no result)'), RESULT_MAX, 'read_agent with result=true returns all of it')}`);
  return parts.join('\n');
};

// conductor only: run the tool on a peer swarm instance (list_peers) instead of this one
const peerProp = conductor ? { peer: { type: 'string', description: 'name of a peer swarm instance (see list_peers) to do this on instead of this one; omit for this swarm' } } : {};
const idProp = { agent_id: { type: 'string', description: 'id of an agent you control' } };
// cost control: a cheaper model or lower effort for work that doesn't need the best one
const MODEL_HINT = 'opus for hard work (design, tricky bugs, big refactors); sonnet for routine coding, lookups, reviews and checks; haiku for simple, mechanical or scheduled jobs (summaries, status checks, triage)';
const modelProps = (dflt, hint) => ({
  model: { type: 'string', description: say(
    `model alias (opus, sonnet, haiku, fable) or a full model id; pick the cheapest that can do the job${hint ? ': ' + MODEL_HINT : ' (see start_agent)'}. Default: ${dflt}`,
    `for an agent on your CLI (${own?.label}): ${own?.modelHint || 'a model it knows'}; for a Claude agent: opus, sonnet, haiku, fable or a full model id${hint ? ' (' + MODEL_HINT + ')' : ''}. Pick the cheapest that can do the job. Default: ${dflt}`) },
  effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: `thinking effort; lower is faster and cheaper${own && !own.capabilities.effort.length ? ` (${own.label} has none: leave it unset for agents on it)` : ''}. Default: ${dflt}` },
});
const waitProp = { wait: { type: 'boolean', description: 'block until the agent finishes its turn and return its result (default false). Without it you are woken with an [agent notification] message when the turn ends, so only wait when you need the answer before you can continue' } };
// how a parent learns that a child's turn ended (server.js notifyParent / agent-notify.js); peers don't notify
const NOTIFY_NOTE = 'When an agent you started finishes a turn you asked for (its first prompt, your send_message), you are woken with an automatic "[agent notification]" message carrying its outcome and clipped result (also once if it stays blocked on the user\'s approval or question); if you are mid-turn it arrives after your turn. So you never need to poll: wait_for_agent and read_agent are optional. Agents on a peer do not notify.';

// a call the server holds open until the user acts (ask_user): aborted when the MCP client cancels the tool call
const inFlight = new Map(); // MCP request id -> abort()
// tools only some agents see: approve is Claude's permission-prompt tool, ask_user the question tool of CLIs without one
// that reaches the swarm (HALAY_ASK_TOOL 1 or 0; launches from before it: every CLI but Claude), submit_plan the plan approval
// of CLIs without one of their own over ACP (OpenCode), in plan mode. See prompts.js
const HALAY_NO_APPROVE = env('NO_APPROVE'), HALAY_ASK_TOOL = env('ASK_TOOL'), HALAY_PLAN_TOOL = env('PLAN_TOOL');
const listed = (name) => name === 'approve' ? !HALAY_NO_APPROVE : name === 'ask_user' ? (HALAY_ASK_TOOL ? HALAY_ASK_TOOL === '1' : !!HALAY_NO_APPROVE) : name === 'submit_plan' ? !!HALAY_PLAN_TOOL : true;

const requestHeld = (path, body, mcpId) =>
  new Promise((resolve, reject) => {
    const req = http.request(`${HALAY_URL}${path}`, { method: 'POST', headers: { authorization: `Bearer ${HALAY_TOKEN}`, 'content-type': 'application/json', 'x-halay-agent': HALAY_AGENT || '' } }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => {
        let j;
        try { j = JSON.parse(s); } catch { j = { error: s }; }
        res.statusCode < 300 ? resolve(j) : reject(new Error(j.error || s));
      });
    });
    req.on('error', (e) => reject(e));
    if (mcpId !== undefined) inFlight.set(mcpId, () => { req.destroy(); reject(new Error('cancelled')); });
    req.end(JSON.stringify(body));
  }).finally(() => inFlight.delete(mcpId));

const tools = {
  // Claude has AskUserQuestion; the other CLIs have no question tool over ACP (Gemini and OpenCode leave theirs out,
  // Cursor's never reaches ACP sessions), so they get this one (listed only for them, see tools/list)
  ask_user: {
    description: 'Ask the user one to four multiple-choice questions in the swarm UI and wait for the answers (a question card, like the approval cards). ' +
      'Use it when you need the user to choose before you can go on; do not ask such questions in plain text. Each question has 2 to 4 options; the user may also type their own answer. ' +
      'Returns each question with the chosen option labels, or that the user declined.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'a short title for the card (optional)' },
        questions: {
          type: 'array', minItems: 1, maxItems: 4,
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'the full question' },
              header: { type: 'string', description: 'a very short label (max 12 characters)' },
              options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } },
              multiSelect: { type: 'boolean', description: 'allow several options (default false)' },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    run: async (a, ctx) => {
      const r = await requestHeld('/internal/ask', { agentId: HALAY_AGENT, title: a.title, questions: a.questions }, ctx?.id);
      if (!r.answers) return `The user declined to answer${r.message && !/declined/i.test(r.message) ? `: ${r.message}` : '.'}`;
      return 'The user answered:\n' + Object.entries(r.answers).map(([q, ans]) => `- ${q}\n  ${ans}`).join('\n');
    },
  },
  submit_plan: {
    description: 'In plan mode, put your finished plan to the user for approval (a plan card in the swarm UI) and wait for the decision. ' +
      'Call it once the plan is ready, with the whole plan; do not ask "is this plan okay?" in plain text or with ask_user. ' +
      'Approved: end your turn right away; you are switched out of plan mode and the next message tells you to implement it. Rejected: revise the plan with the feedback.',
    schema: {
      type: 'object',
      properties: { plan: { type: 'string', description: 'the whole plan, in Markdown' } },
      required: ['plan'],
    },
    run: async (a, ctx) => {
      const r = await requestHeld('/internal/plan', { agentId: HALAY_AGENT, plan: a.plan }, ctx?.id);
      return r.message;
    },
  },
  approve: {
    description: 'Ask the user whether a tool call may proceed',
    schema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name', 'input'],
    },
    run: (a) => request('POST', '/internal/permission', { agentId: HALAY_AGENT, ...a }, { safe: true }).then((d) => {
      if (d.behavior === 'allow') d.updatedInput ??= a.input;
      return JSON.stringify(d);
    }),
  },
  list_agents: {
    description: conductor
      ? 'List every agent in the swarm with its folder, account and status (idle, running, stopped, error).'
      : 'List the swarm agents you started, with their status (idle, running, stopped, error).',
    schema: { type: 'object', properties: { ...peerProp } },
    run: async ({ peer }) => {
      if (peer) { const all = (await request('GET', at(peer, '/api/agents'))).map(brief); return all.length ? `peer ${peer}:\n${all.join('\n')}` : `peer ${peer} has no agents.`; }
      const mine = (await request('GET', '/api/agents')).filter((a) => a.id !== HALAY_AGENT && (conductor || a.parentId === HALAY_AGENT)).map(brief);
      return mine.length ? mine.join('\n') : conductor ? 'There are no other agents yet.' : 'You have not started any agents.';
    },
  },
  start_agent: {
    description:
      say('Start a new Claude Code agent', `Start a new coding agent (${own?.label} unless account or backend picks another CLI)`) + ' in the swarm (visible in the swarm web UI) working on a task in a folder. ' +
      `This is the preferred way to delegate: use it instead of ${say('the built-in Agent/Task tool', "your CLI's built-in subagent tool")} for anything that edits files, runs more than a few minutes, runs in parallel, ` +
      'belongs in another folder, or the user may want to follow or continue (built-in subagents are invisible to the user). ' + (env('NO_BUILTIN') ? 'Built-in subagents are turned off in this swarm: delegate with this tool. ' : 'The built-in tool is only for quick read-only lookups. ') +
      `It runs with your account, permission mode, model and effort unless you override them; give it a cheaper model${say(' (e.g. sonnet or haiku)', '')} when the work is routine. Anything it needs approved is approved by the user in the UI. ` +
      'Returns the new agent id. With wait=true it blocks until the agent finishes its first turn and returns the result. ' + NOTIFY_NOTE + ' Bots (list_bots) are permanent agents: never start a second agent for a bot\'s role or folder, message the bot instead.',
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'the task for the new agent; be specific, it has none of your context' },
        cwd: { type: 'string', description: 'absolute folder to work in (default: your folder)' },
        name: { type: 'string', description: 'short name shown in the UI' },
        account: { type: 'string', description: 'account alias such as claude-work (default: yours); an account belongs to one coding-agent CLI (see list_accounts), so it also picks the backend' },
        backend: { type: 'string', description: "which coding-agent CLI runs it: claude, or another installed one such as opencode (see list_accounts). Default: your account's. Model names and permission modes depend on the backend" },
        session_id: { type: 'string', description: 'continue this earlier Claude session (from list_sessions) instead of starting a fresh one' },
        permission_mode: { type: 'string', enum: ['auto', 'manual', 'acceptEdits', 'plan', 'bypassPermissions', 'cli'], description: "default: yours; can't be more permissive than yours" + say('', '; auto is for Claude agents only') },
        one_off: { type: 'boolean', description: 'ignore cwd and start it in a fresh empty scratch folder that is deleted with the agent (cwd not required)' },
        worktree: { type: 'boolean', description: 'run it in its own git worktree on a new branch (cwd must be inside a git repo); the agent is told to commit its work on that branch; the user reviews and merges it from the agent\'s Git view' },
        lean: { type: 'boolean', description: "launch with only the swarm MCP server (none of the user's MCP servers or claude.ai connectors); a smaller context. Default: the user's setting" },
        browser: { type: 'boolean', description: "give it a real browser (Playwright MCP, tools " + say('mcp__browser__*', 'browser_*') + ") with persistent logins that the user can watch and take over in the swarm UI. Opt-in (adds browser tools to its context). Default: the user's setting" },
        browser_profile: { type: 'string', description: "which saved browser profile (cookies and logins) it uses, e.g. a per-account name; implies browser=true. Default: the user's default profile. One agent drives a profile at a time" },
        ...modelProps("yours, else the user's default", true),
        ...waitProp,
        notify: { type: 'boolean', description: 'wake you with an [agent notification] when a turn you asked of it ends (default true); false = you check on it yourself' },
        ...(conductor && { peer: { type: 'string', description: "start it on a peer swarm instance (see list_peers) instead of this one: cwd (or one_off) is then a folder on that machine, and unset account, mode, model and effort are the peer's defaults, not yours" } }),
      },
      required: ['prompt'],
    },
    run: async ({ prompt, cwd, name, account, backend, permission_mode, model, effort, session_id, worktree, one_off, lean, browser, browser_profile, wait, notify, peer }) => {
      const a = await request('POST', at(peer, '/api/agents'), { prompt, cwd, name, account, backend, permissionMode: permission_mode, model, effort, sessionId: session_id, worktree, oneOff: one_off, lean, browser: browser_profile || browser, notify, parentId: peer ? undefined : HALAY_AGENT });
      const head = `started agent ${a.id} ("${a.name}")${onPeer(peer)} in ${a.cwd}${a.model ? ' on ' + a.model : ''}${a.effort ? ', effort ' + a.effort : ''}`;
      return wait ? `${head}\n${await waitFor(a.id, 600, peer)}` : head;
    },
  },
  open_agent: {
    description: "Move the user's view in the swarm web UI to the chat of an agent you started (if they are typing, they just get an 'Open <name>' prompt). Use it right after starting a one-off agent.",
    schema: { type: 'object', properties: idProp, required: ['agent_id'] },
    run: async ({ agent_id }) => { await child(agent_id); await request('POST', `/api/agents/${encodeURIComponent(agent_id)}/focus`, { parentId: HALAY_AGENT }); return 'opened'; },
  },
  send_message: {
    description: 'Send a follow-up message to an agent you control. If it is mid-turn the message is queued after the current turn. If you started it, you are notified when the turn ends (no need to wait or poll).',
    schema: { type: 'object', properties: { ...idProp, text: { type: 'string' }, ...waitProp, ...peerProp }, required: ['agent_id', 'text'] },
    run: async ({ agent_id, text, wait, peer }) => {
      await child(agent_id, 1, peer);
      await request('POST', at(peer, `/api/agents/${encodeURIComponent(agent_id)}/send`), { text });
      return wait ? await waitFor(agent_id, 600, peer) : 'sent';
    },
  },
  read_agent: {
    description: 'Read the recent conversation of an agent you control (prompts, its replies, tool calls), its status and context size. Says if it is blocked waiting for an approval or for the user to answer its question. Long lines are clipped unless full=true. Optional for agents you started: an [agent notification] tells you when their turns end.',
    schema: {
      type: 'object',
      properties: {
        ...idProp,
        last: { type: 'number', description: 'how many recent lines (default 15)' },
        full: { type: 'boolean', description: 'do not clip long lines (default false)' },
        result: { type: 'boolean', description: 'return only the complete final answer of its last finished turn' },
        ...peerProp,
      },
      required: ['agent_id'],
    },
    run: async ({ agent_id, last = 15, full, result, peer }) => {
      if (result) {
        const a = await child(agent_id, 0, peer, true);
        return String(a.events.findLast((e) => e.type === 'result')?.result ?? '(no finished turn yet)');
      }
      return condense(await child(agent_id, full ? 0 : 400, peer, true), last, full);
    },
  },
  refresh_agent_context: {
    description:
      'Give an idle agent you control a fresh context with a handoff: it writes a short note on its goal, state, decisions, open threads, key files and next steps, its session is reset, and the note goes in front of its next message. ' +
      'Use it when an agent will keep working but its context is large (list_agents and read_agent show the size; above ~100k every turn is slow and costly), or before giving a long-running agent an unrelated task. ' +
      'Not for running agents or agents waiting for approval. Blocks until the note is written (about a minute).',
    schema: { type: 'object', properties: { ...idProp, message: { type: 'string', description: 'optional next instruction, sent right after the reset together with the note' } }, required: ['agent_id'] },
    run: async ({ agent_id, message }) => {
      await child(agent_id);
      const r = await request('POST', `/api/agents/${encodeURIComponent(agent_id)}/refresh`, { message, wait: true });
      return `fresh context; handoff note of ${r.words} words saved` + (r.continued ? ' and sent with your message' : '; it is sent with the next message');
    },
  },
  wait_for_agent: {
    description: 'Block until an agent you control finishes its current turn (or the timeout passes) and return its result. Reports if it is blocked on a user approval or a question for the user. Optional: agents you started wake you with an [agent notification] when a turn ends, so use this only when you cannot continue without the answer (while you wait, that turn does not notify you).',
    schema: { type: 'object', properties: { ...idProp, timeout_seconds: { type: 'number', description: 'default 300, max 1800' }, ...peerProp }, required: ['agent_id'] },
    run: async ({ agent_id, timeout_seconds = 300, peer }) => { await child(agent_id, 1, peer); return waitFor(agent_id, timeout_seconds, peer); },
  },
  list_accounts: {
    description: 'List the accounts agents can run as (aliases such as a personal and a work account), each with its coding-agent CLI (backend: claude, opencode, ...) and, for Claude accounts, the login status (logged in or out, method, email, plan). (default) marks the account each CLI\'s agents get when none is named and they do not inherit yours. Do not start agents on a logged-out account.',
    schema: { type: 'object', properties: { ...peerProp } },
    run: async ({ peer }) => { const l = await request('GET', at(peer, '/api/accounts')); return l.map((a) => `${a.name}${a.backend && a.backend !== 'claude' ? ` [${a.backend}]` : ''}${a.default && l.filter((x) => x.backend === a.backend).length > 1 ? ' (default)' : ''}: ${a.loggedIn === false ? 'LOGGED OUT (agents on it will fail until someone runs /login there)' : a.loggedIn ? ['logged in', a.method, a.email, a.plan].filter(Boolean).join(', ') : 'login status unknown'}`).join('\n'); },
  },
  list_sessions: {
    description: 'List earlier Claude sessions in any folder, newest first, with first prompt and folder. Use a session id with start_agent to continue it.',
    schema: { type: 'object', properties: { filter: { type: 'string', description: 'only sessions whose prompt or folder contains this text' }, limit: { type: 'number', description: 'default 15' }, ...peerProp } },
    run: async ({ filter, limit = 15, peer }) => {
      const f = filter?.toLowerCase();
      const all = await request('GET', at(peer, '/api/sessions/all'));
      const rows = (all.sessions || all) // { sessions, partial }
        .filter((x) => x.exists && (!f || (x.title + x.cwd).toLowerCase().includes(f)))
        .slice(0, limit)
        .map((x) => `- ${x.id} · ${new Date(x.mtime).toISOString().slice(0, 16).replace('T', ' ')} · ${x.cwd}${x.inUse ? ' (open as an agent)' : ''}\n  ${clip(String(x.title || '').replace(/\s+/g, ' '), 120)}`);
      return rows.length ? rows.join('\n') : 'no matching sessions';
    },
  },
  remove_agent: {
    description: 'Remove an agent you control, like the Remove button in the UI: a running agent is stopped first. Refused if its worktree has uncommitted files or its one-off folder still has files; then only the user can remove it, in the UI.',
    schema: { type: 'object', properties: idProp, required: ['agent_id'] },
    run: async ({ agent_id }) => {
      const a = await child(agent_id);
      try { await request('DELETE', `/api/agents/${encodeURIComponent(agent_id)}`); } catch (e) {
        if (e.status !== 409) throw e;
        return `NOT REMOVED: ${e.message}. Only the user can confirm that: ask them to remove "${a.name}" with its Remove button in the swarm UI.`;
      }
      return `removed${a.status === 'running' ? ' (it was running; its turn was stopped)' : ''}` +
        (a.worktree ? `; branch ${a.worktree.branch} stays in the repository` : a.oneOff ? '; its conversation stays in History' : '');
    },
  },
  interrupt_agent: {
    description: 'Interrupt the current turn of an agent you control (like pressing Esc).',
    schema: { type: 'object', properties: { ...idProp, ...peerProp }, required: ['agent_id'] },
    run: async ({ agent_id, peer }) => { await child(agent_id, 1, peer); await request('POST', at(peer, `/api/agents/${encodeURIComponent(agent_id)}/interrupt`)); return 'interrupted'; },
  },
};

const taskLine = (t, full = false) => ({
  id: t.id, title: t.title, status: t.status, state: t.state !== t.status ? t.state : undefined,
  depends_on: t.dependsOn?.length ? t.dependsOn : undefined, auto_start: t.autoStart || undefined,
  blocked_by: t.blockedBy || undefined, waiting_on: t.waitingOn?.length ? t.waitingOn : undefined,
  prompt: t.prompt ? (full ? t.prompt : clip(t.prompt, 200, 'get_task for all of it')) : undefined, folder: t.cwd || undefined, account: t.account || undefined, model: t.model || undefined, effort: t.effort || undefined, agent_id: t.agentId || undefined, schedule_id: t.scheduledFrom || undefined,
  result: t.result ? (full ? t.result : t.result.length > 300 ? t.result.slice(0, 300) + '… (get_task for all of it)' : t.result) : undefined,
});
const taskProps = {
  title: { type: 'string', description: 'short task title' },
  prompt: { type: 'string', description: 'full instructions for the agent that will do it (default: the title). {{result:<task id>}} is replaced with the final answer of the agent that ran that task, and makes this task depend on it.' },
  cwd: { type: 'string', description: 'absolute folder the agent should work in' },
  account: { type: 'string', description: 'account alias to run as' },
  ...modelProps("the user's default (a bot or an existing agent keeps its own)"),
  bot: { type: 'string', description: 'handle of a bot (see list_bots) that should do this task in its own long-lived session instead of a new agent' },
  depends_on: { type: 'array', items: { type: 'number' }, description: 'ids of tasks that must be done first. The task is startable only when all are done; if one fails this task is blocked and will not start.' },
  auto_start: { type: 'boolean', description: 'start this task automatically when its dependencies finish (needs depends_on; runs in its folder, or on the agent that finished the last dependency if it has none). Default false.' },
};
Object.assign(tools, {
  list_tasks: {
    description: "List the swarm's task backlog (the user's to-do list shown in the Tasks panel) in queue order. status is queued, running, done or failed; a queued task also has state ready (startable), waiting (dependencies still running/queued) or blocked (a dependency failed or was deleted).",
    schema: { type: 'object', properties: { status: { type: 'string', enum: ['queued', 'running', 'done', 'failed'], description: 'only tasks with this status' }, ...peerProp } },
    run: async ({ status, peer }) => {
      const rows = (await request('GET', at(peer, '/api/tasks'))).filter((t) => !status || t.status === status).map((t) => taskLine(t));
      return rows.length ? JSON.stringify(rows, null, 1) : 'no tasks';
    },
  },
  get_task: {
    description: 'Get one backlog task in full, including the complete result of the agent that ran it.',
    schema: { type: 'object', properties: { task_id: { type: 'number' }, ...peerProp }, required: ['task_id'] },
    run: async ({ task_id, peer }) => JSON.stringify(taskLine(await request('GET', at(peer, `/api/tasks/${task_id}`)), true), null, 1),
  },
  add_task: {
    description: 'Add a task to the backlog (status queued). It does not start anything unless auto_start is set and its dependencies finish; otherwise use assign_task. Use depends_on (and {{result:<id>}} in the prompt) to chain tasks so a later one gets an earlier one\'s output.',
    schema: { type: 'object', properties: { ...taskProps, ...peerProp }, required: ['title'] },
    run: async ({ peer, ...a }) => {
      const t = await request('POST', at(peer, '/api/tasks'), a);
      return `added task ${t.id}${onPeer(peer)}` + (t.dependsOn.length ? ` (depends on ${t.dependsOn.join(', ')}; ${t.state}${t.blockedBy ? ': ' + t.blockedBy : ''})` : '');
    },
  },
  update_task: {
    description: 'Edit a backlog task: title, prompt, folder, account, model, effort, depends_on, auto_start, or status (queued, running, done, failed). Dependencies that would form a loop are rejected.',
    schema: { type: 'object', properties: { task_id: { type: 'number' }, ...taskProps, status: { type: 'string', enum: ['queued', 'running', 'done', 'failed'] } }, required: ['task_id'] },
    run: async ({ task_id, ...rest }) => { await request('PATCH', `/api/tasks/${task_id}`, rest); return 'updated'; },
  },
  delete_task: {
    description: 'Delete a task from the backlog. Tasks that depended on it become blocked.',
    schema: { type: 'object', properties: { task_id: { type: 'number' } }, required: ['task_id'] },
    run: async ({ task_id }) => { await request('DELETE', `/api/tasks/${task_id}`); return 'deleted'; },
  },
  assign_task: {
    description: 'Start work on a backlog task: send it to an idle agent (agent_id) or, without agent_id, start a new agent for it in the task folder (cwd required on the task or here). Refused if the task is waiting for or blocked by its dependencies. {{result:<id>}} placeholders in the prompt are filled in. The task becomes running and is marked done/failed when the agent finishes its turn.',
    schema: { type: 'object', properties: { task_id: { type: 'number' }, agent_id: { type: 'string', description: 'an idle agent to give the task to; omit to start a new agent' }, cwd: { type: 'string' }, account: { type: 'string' }, ...modelProps('the task\'s, else yours, else the user\'s default (ignored with agent_id)'), ...peerProp }, required: ['task_id'] },
    run: async ({ task_id, agent_id, cwd, account, model, effort, peer }) => {
      const r = await request('POST', at(peer, `/api/tasks/${task_id}/assign`), { agentId: agent_id, cwd, account, model, effort, parentId: agent_id || peer ? undefined : HALAY_AGENT });
      return `task ${task_id} is running on agent ${r.agent.id} ("${r.agent.name}")${onPeer(peer)}`;
    },
  },
});

const when = (ts) => (ts ? new Date(ts).toISOString() : undefined);
const scheduleLine = (s) => ({
  id: s.id, title: s.title, cron: s.cron, timezone: s.tz, runs: s.description, enabled: s.enabled,
  folder: s.oneOff ? undefined : s.cwd, one_off: s.oneOff || undefined, account: s.account || undefined, permission_mode: s.permissionMode, model: s.model || undefined, effort: s.effort || undefined,
  overlap: s.overlap, notify: s.notify, keep_agents: s.keepAgents, next_run: when(s.nextRunAt), last_run: when(s.lastRunAt),
  last_status: s.lastStatus || undefined, last_task_id: s.lastTaskId || undefined, last_agent_id: s.lastAgentId || undefined,
  skipped: s.skippedAt && s.skippedAt > (s.lastRunAt || 0) ? `${when(s.skippedAt)}: ${s.skipReason}` : undefined,
  prompt: s.prompt || undefined, added_by: s.createdBy === HALAY_AGENT ? 'you' : s.createdBy || 'user',
});
// a regular agent may only change the schedules it added (the server checks this too); the conductor may change any
const ownSchedule = async (id) => {
  if (conductor) return;
  const s = await request('GET', `/api/schedules/${encodeURIComponent(id)}`).catch(() => null);
  if (!s) throw new Error(`no schedule ${id} (see list_schedules)`);
  if (s.createdBy !== HALAY_AGENT)
    throw new Error(`schedule ${id} was added by ${s.createdBy ? 'agent ' + s.createdBy : 'the user'}; you can only change, delete or run the schedules you added`);
};
const scheduleProps = {
  title: { type: 'string', description: 'short name, also used for each run\'s task and agent' },
  prompt: { type: 'string', description: 'full instructions for the agent of each run (default: the title); it starts fresh every time, so make it self-contained. {{last_result}} is replaced with the previous run\'s final answer (empty on the first run) and {{last_run_at}} with when it ran ("never" on the first run). Tell it to start its answer with ALERT: when something needs the user, if notify is alert.' },
  cron: { type: 'string', description: 'standard 5-field cron: minute hour day-of-month month day-of-week. Translate what the user says into it, e.g. "every weekday at 9" -> "0 9 * * 1-5", "every hour" -> "0 * * * *", "every Monday at 8:30" -> "30 8 * * 1", "every 15 minutes" -> "*/15 * * * *", "on the 1st of each month at noon" -> "0 12 1 * *".' },
  timezone: { type: 'string', description: 'IANA time zone the cron is read in, e.g. Europe/Istanbul (default: the server\'s)' },
  cwd: { type: 'string', description: 'absolute folder each run works in (required unless one_off)' },
  one_off: { type: 'boolean', description: 'run each time in a fresh empty scratch folder instead of cwd' },
  bot: { type: 'string', description: "handle of a bot (see list_bots): each run is then a turn of that bot's own session (in its folder and account, with its memory) instead of a new agent. A busy or paused bot skips the run" },
  account: { type: 'string', description: 'account alias to run as (default claude)' },
  permission_mode: { type: 'string', enum: ['auto', 'manual', 'acceptEdits', 'plan', 'bypassPermissions', 'cli'], description: "default: the user's default (auto). Runs are unattended: anything that needs an approval waits for the user" },
  ...modelProps("the user's default; a scheduled job is usually routine, so prefer sonnet or haiku with low effort unless it needs real reasoning (ignored with bot)"),
  enabled: { type: 'boolean', description: 'default true' },
  overlap: { type: 'string', enum: ['skip', 'queue'], description: 'if the previous run is still going when the next is due: skip that run (default) or queue it until the previous one ends' },
  notify: { type: 'string', enum: ['always', 'failure', 'alert'], description: 'push notification after a run: always (default), only on failure, or only when the result contains "ALERT:"' },
  keep_agents: { type: 'number', description: 'how many recent run agents to keep (older idle ones are removed after each run; default 3)' },
};
Object.assign(tools, {
  list_schedules: {
    description: `List the scheduled (recurring) tasks: cron, time zone, next and last run, last run status, why a run was skipped if it was, and who added each one (added_by)${conductor ? '' : '; you can only change, delete or run the ones added_by you'}.`,
    schema: { type: 'object', properties: {} },
    run: async () => {
      const rows = (await request('GET', '/api/schedules')).map(scheduleLine);
      return rows.length ? JSON.stringify(rows, null, 1) : 'no schedules';
    },
  },
  add_schedule: {
    description: 'Add a recurring task, e.g. when the user asks for something to happen regularly. On each run the swarm creates a new task and starts a NEW agent for it (never reusing one, and not you), then records its result as that task\'s result. Translate natural-language timing ("every weekday at 9", "hourly", "every Monday morning") into a 5-field cron yourself and confirm the schedule in words. Use one_off for work that belongs to no folder.',
    schema: { type: 'object', properties: scheduleProps, required: ['title', 'cron'] },
    run: async (a) => {
      const s = await request('POST', '/api/schedules', a);
      return `added schedule ${s.id}: ${s.description} (${s.cron}, ${s.tz}); ${s.enabled ? 'next run ' + when(s.nextRunAt) : 'disabled'}`;
    },
  },
  update_schedule: {
    description: (conductor ? 'Edit a schedule' : 'Edit a schedule you added') + ' (any field, e.g. enabled=false to pause it). Natural-language timing must be translated into a 5-field cron. Changing the cron or time zone, or re-enabling it, recomputes the next run from now.',
    schema: { type: 'object', properties: { schedule_id: { type: 'number' }, ...scheduleProps }, required: ['schedule_id'] },
    run: async ({ schedule_id, ...rest }) => {
      await ownSchedule(schedule_id);
      const s = await request('PATCH', `/api/schedules/${schedule_id}`, rest);
      return `updated schedule ${s.id}: ${s.description} (${s.cron}, ${s.tz}), ${s.enabled ? 'next run ' + when(s.nextRunAt) : 'disabled'}`;
    },
  },
  delete_schedule: {
    description: (conductor ? 'Delete a schedule' : 'Delete a schedule you added') + ' and its run history (a run still going finishes as a plain task; its agents stay until removed).',
    schema: { type: 'object', properties: { schedule_id: { type: 'number' } }, required: ['schedule_id'] },
    run: async ({ schedule_id }) => { await ownSchedule(schedule_id); await request('DELETE', `/api/schedules/${schedule_id}`); return 'deleted'; },
  },
  run_schedule_now: {
    description: (conductor ? 'Run a schedule' : 'Run a schedule you added') + ' once right now (as a new task and a new agent), without changing its next scheduled run. Refused while its previous run is still going or when its account is over its usage threshold.',
    schema: { type: 'object', properties: { schedule_id: { type: 'number' } }, required: ['schedule_id'] },
    run: async ({ schedule_id }) => {
      await ownSchedule(schedule_id);
      const r = await request('POST', `/api/schedules/${schedule_id}/run`);
      return `schedule ${schedule_id} is running as task ${r.task.id} on agent ${r.agent.id} ("${r.agent.name}"); get_task ${r.task.id} for its result when it is done`;
    },
  },
});

// ---- bots: permanent agents with a persistent identity and memory (bots.js). The user manages them in the Bots page; the conductor can too.
const botLine = (b) =>
  `- @${b.handle} ${b.emoji} "${b.name}" ${b.paused ? 'PAUSED' : b.status} · agent ${b.agentId} · ${b.account} · ${b.permissionMode}${b.model ? ' · ' + b.model : ''}${b.effort ? ' · effort ' + b.effort : ''}${b.browser ? ' · browser ' + b.browser : ''} · context ${kTok(b.context)} · ${b.home ? 'home ' : 'folder '}${b.cwd}` +
  `${b.rooms.length ? ' · rooms ' + b.rooms.map((r) => '#' + r).join(' ') : ''}\n  role: ${clip(b.role.replace(/\s+/g, ' '), 200)}`;
const botProps = {
  name: { type: 'string', description: 'display name' },
  handle: { type: 'string', description: 'unique @handle used to mention it in rooms (letters, digits, -; default: from the name)' },
  emoji: { type: 'string', description: 'avatar emoji (default 🤖)' },
  role: { type: 'string', description: "the bot's role and standing instructions (becomes its BOT.md); it keeps working from this and from its memory files forever, so describe what it is for, how it should behave and what it should remember" },
  account: { type: 'string', description: 'account alias (default: yours)' },
  cwd: { type: 'string', description: 'working folder: an existing absolute path. Default: a new home folder for the bot under the bots root (recommended unless it works on a project)' },
  ...modelProps("the user's default"),
  permission_mode: { type: 'string', enum: ['auto', 'manual', 'acceptEdits', 'plan', 'bypassPermissions', 'cli'], description: "default manual (asks the user to approve); can't be more permissive than yours" },
  browser: { type: 'string', description: "browser profile name to give the bot a browser (Playwright MCP) with persistent logins; 'default' for the default profile; omit for none" },
  rooms: { type: 'array', items: { type: 'number' }, description: 'ids of rooms (see list_rooms) the bot should be a member of' },
  context_tokens: { type: 'number', description: "context size at which an idle bot gets a fresh context with a handoff (default: the user's setting, 100000)" },
};
const botBody = ({ context_tokens, permission_mode, browser, ...rest }) => ({ ...rest, ...(context_tokens !== undefined && { ctxTokens: context_tokens }), ...(permission_mode !== undefined && { permissionMode: permission_mode }), ...(browser !== undefined && { browser: browser === 'default' ? true : browser }) });
Object.assign(tools, {
  list_bots: {
    description: 'List the bots: permanent named agents with a persistent identity and memory (journal, notes, open threads), created once and talked to forever. Shows handle, agent id (use it with send_message, read_agent), status, role and rooms. Talk to a bot with send_message instead of starting a new agent; schedules and tasks can target it with bot=<handle>.',
    schema: { type: 'object', properties: {} },
    run: async () => { const bs = await request('GET', '/api/bots'); return bs.length ? bs.map(botLine).join('\n') : 'no bots'; },
  },
  create_bot: {
    description: 'Create a bot: a permanent agent for an ongoing role (an assistant, a monitor, a researcher, a support desk) that the user will talk to over time. It gets a home folder with BOT.md (its role) and a memory/ folder it reads at the start and updates after every task, so it keeps its knowledge when its context is refreshed (automatic when idle and big). It appears as an agent in the swarm. Use start_agent instead for one-off work. Only create a bot when the user asks for one.',
    schema: { type: 'object', properties: botProps, required: ['name', 'role'] },
    run: async (a) => { const b = await request('POST', '/api/bots', botBody(a)); return `created bot @${b.handle} (agent ${b.agentId}); folder ${b.dir}\n${botLine(b)}`; },
  },
  update_bot: {
    description: "Change a bot's name, emoji, role, account, model, effort, permission mode, browser (browser='' removes it), rooms or context threshold. Changing account, model, effort, mode or browser needs the bot idle; a new account starts a fresh session (its memory files carry over). Pause or resume it with paused=true/false.",
    schema: { type: 'object', properties: { bot: { type: 'string', description: 'the bot handle (see list_bots)' }, ...botProps, paused: { type: 'boolean', description: 'pause (stops its process and holds messages) or resume it' } }, required: ['bot'] },
    run: async ({ bot, paused, ...rest }) => {
      const h = encodeURIComponent(bot);
      let b = Object.keys(rest).length ? await request('PATCH', `/api/bots/${h}`, botBody(rest)) : await request('GET', `/api/bots/${h}`);
      if (paused !== undefined) b = await request('POST', `/api/bots/${h}/${paused === true || paused === 'true' ? 'pause' : 'resume'}`);
      return `updated\n${botLine(b)}`;
    },
  },
});
for (const t of conductor ? [] : ['create_bot', 'list_bots', 'update_bot']) delete tools[t];

// ---- rooms: group chats between agents and the user (rooms.js). A regular agent only sees the rooms it is in.
const roomLine = (r) =>
  `- #${r.id} "${r.name}" ${r.status}${r.status === 'paused' ? ' (budget reached; the user resumes it)' : ''} · agent turns ${r.used}/${r.budget}` +
  `${r.goal ? ` · goal: ${clip(r.goal, 160)}` : ''}${r.summary ? ` · done: ${clip(r.summary, 160)}` : ''}\n  members: ` +
  (r.members.map((m) => `@${m.handle} (${m.name}, ${m.blocked ? (m.question ? 'BLOCKED on a question for the user' : 'BLOCKED on an approval') : m.status}, id ${m.id})`).join(', ') || 'none');
const roomId = { room_id: { type: 'number', description: 'the room id (see list_rooms)' } };
Object.assign(tools, {
  list_rooms: {
    description: conductor ? 'List every room (agent group chats) with its status, budget, goal and members (@handle to address them).' : 'List the rooms you are in with status, goal and members (@handle to address them).',
    schema: { type: 'object', properties: {} },
    run: async () => {
      const rs = (await request('GET', '/api/rooms')).filter((r) => r.status !== 'archived');
      return rs.length ? rs.map(roomLine).join('\n') : 'no rooms';
    },
  },
  create_room: {
    description:
      'Create a room: a group chat between existing agents (any folder or account) and the user, where agents hand work to each other with @mentions without you in the middle. ' +
      'Give it a goal and members (agent ids from list_agents). Creating a room does not start anything: post the first message with post_to_room, @mentioning the agent that should begin. ' +
      'Agents are told to answer with post_to_room and to @mention whoever acts next. The room pauses after `budget` agent-triggered turns without a message from the user.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, goal: { type: 'string', description: 'what the room should achieve and what "done" looks like' },
        members: { type: 'array', items: { type: 'string' }, description: 'agent ids' },
        budget: { type: 'number', description: 'max agent-triggered turns until the user speaks again (default 20)' },
      },
      required: ['name'],
    },
    run: async (a) => { const r = await request('POST', '/api/rooms', a); return `created room #${r.id}\n${roomLine(r)}`; },
  },
  update_room: {
    description: 'Rename a room, change its goal or budget, archive it (archived=true) or resume a paused one (resume=true).',
    schema: { type: 'object', properties: { ...roomId, name: { type: 'string' }, goal: { type: 'string' }, budget: { type: 'number' }, archived: { type: 'boolean' }, resume: { type: 'boolean' } }, required: ['room_id'] },
    run: async ({ room_id, ...rest }) => `updated\n${roomLine(await request('PATCH', `/api/rooms/${room_id}`, rest))}`,
  },
  add_to_room: {
    description: 'Add an existing agent to a room. It gets room context with each message addressed to it.',
    schema: { type: 'object', properties: { ...roomId, agent_id: { type: 'string' } }, required: ['room_id', 'agent_id'] },
    run: async ({ room_id, agent_id }) => `added\n${roomLine(await request('POST', `/api/rooms/${room_id}/members`, { agentId: agent_id }))}`,
  },
  remove_from_room: {
    description: 'Remove an agent from a room (the agent itself keeps running).',
    schema: { type: 'object', properties: { ...roomId, agent_id: { type: 'string' } }, required: ['room_id', 'agent_id'] },
    run: async ({ room_id, agent_id }) => `removed\n${roomLine(await request('DELETE', `/api/rooms/${room_id}/members/${encodeURIComponent(agent_id)}`))}`,
  },
  read_room: {
    description: 'Read the recent messages of a room (including ones addressed to nobody), its goal, members and budget. Messages addressed to you already arrive as turns with this context; use this to catch up.',
    schema: { type: 'object', properties: { ...roomId, last: { type: 'number', description: 'how many recent messages (default 20)' } }, required: ['room_id'] },
    run: async ({ room_id, last = 20 }) => {
      const r = await request('GET', `/api/rooms/${room_id}?limit=${Math.min(Math.max(last, 1), 100)}`);
      const lines = r.thread.map((m) => `[${new Date(m.ts).toISOString().slice(11, 16)}] ${m.kind === 'system' ? '(' + m.text + ')' : (m.sender === HALAY_AGENT ? 'you' : m.name) + ': ' + clip(m.text, 1500)}`);
      return [roomLine(r), lines.join('\n') || '(no messages)'].join('\n');
    },
  },
  post_to_room: {
    description:
      'Post a message to a room you are in. @mention a member (@handle) to hand work to them: it is delivered to that agent as a new turn (queued if it is busy) with the room goal and recent messages. ' +
      'Use @user to ask the user something. Without a mention the message is only visible in the room. You cannot mention yourself or use @all. ' +
      'Loop safety: each delivered mention costs one of the room\'s agent-turn budget (it pauses when spent) and you may send only a few mentions per minute. Only mention someone when you have something for them to do.',
    schema: { type: 'object', properties: { ...roomId, text: { type: 'string' } }, required: ['room_id', 'text'] },
    run: async ({ room_id, text }) => {
      const r = await request('POST', `/api/rooms/${room_id}/messages`, { text });
      return ['posted', r.delivered.length ? `delivered to ${r.delivered.join(', ')}` : null, ...r.skipped.map((s) => `NOT DELIVERED to ${s}`), r.unknown.length ? `no such member: ${r.unknown.join(', ')} (see list_rooms)` : null].filter(Boolean).join('; ');
    },
  },
  mark_room_done: {
    description: 'Mark the room goal as done with a short summary of the outcome. The user is notified and the room stops delivering agent messages until the user posts again.',
    schema: { type: 'object', properties: { ...roomId, summary: { type: 'string' } }, required: ['room_id', 'summary'] },
    run: async ({ room_id, summary }) => { await request('POST', `/api/rooms/${room_id}/done`, { summary }); return 'room marked done; the user was notified'; },
  },
});
for (const t of conductor ? [] : ['create_room', 'update_room', 'add_to_room', 'remove_from_room']) delete tools[t];

for (const t of conductor ? [] : ['open_agent', 'list_accounts', 'list_sessions', 'list_tasks', 'get_task', 'add_task', 'update_task', 'delete_task', 'assign_task']) delete tools[t];

// ---- peers: other swarm instances (docs/peers.md); the user configures them in Settings → Peers
Object.assign(tools, {
  list_peers: {
    description: 'List the peer swarm instances (the same swarm running on the user\'s other machines) and whether each is reachable, with its agent counts and its load (CPU, RAM, disk), plus the load of this machine. Check it before starting heavy work on a machine. Pass peer=<name> to list_agents, start_agent, send_message, read_agent, wait_for_agent, interrupt_agent, list_tasks, get_task, add_task, assign_task, list_sessions or list_accounts to do that on the peer; folders are then paths on that machine.',
    schema: { type: 'object', properties: {} },
    run: async () => {
      const [r, me] = await Promise.all([request('GET', '/api/peers?check=1'), request('GET', '/api/stats').catch(() => null)]);
      const rows = r.peers.map((p) => `- ${p.name} · ${p.url} · ${p.status?.ok ? `reachable (calls itself ${p.status.name}; ${p.status.agents} agents, ${p.status.running} running) · ${statsLine(p.status.stats)}` : `UNREACHABLE: ${p.status?.error || 'unknown'}`}`);
      return `this swarm is "${r.self}" · ${statsLine(me)}\n` + (rows.length ? rows.join('\n') : 'no peers configured (the user adds them in Settings → Peers)');
    },
  },
});
if (!conductor) delete tools.list_peers;

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');

// ---- plugin tools (plugins.js): the server lists the ones for this agent's role and runs them; we only pass calls on.
// Fetched with each tools/list, so tools of a plugin enabled later appear in the agent's next session.
const pluginTools = () => requestOnce('GET', '/internal/plugin-tools').catch(() => []);
const callPluginTool = (name, args) => request('POST', '/internal/plugin-tools/call', { name, arguments: args }).then((r) => r.text);

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize')
    return reply(m.id, {
      protocolVersion: m.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'swarm', version: '1.0.0' },
    });
  if (m.method === 'tools/list') {
    const own = Object.entries(tools).filter(([name]) => listed(name)).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema }));
    const extra = (await pluginTools()).filter((t) => !tools[t.name]);
    return reply(m.id, { tools: [...own, ...extra] });
  }
  if (m.method === 'tools/call') {
    const t = tools[m.params?.name] && listed(m.params.name) ? tools[m.params.name] : null;
    if (!t) { // maybe a plugin's tool: the server knows (and says "no plugin tool" otherwise)
      try { return reply(m.id, { content: [{ type: 'text', text: await callPluginTool(m.params?.name, m.params?.arguments || {}) }] }); }
      catch (e) { return reply(m.id, { isError: true, content: [{ type: 'text', text: e.status === 404 ? 'unknown tool' : e.message }] }); }
    }
    if (m.params.arguments?.peer && !t.schema.properties?.peer) // never quietly do on this swarm what was meant for a peer
      return reply(m.id, { isError: true, content: [{ type: 'text', text: `${m.params.name} cannot be used on a peer` }] });
    try {
      return reply(m.id, { content: [{ type: 'text', text: await t.run(m.params.arguments || {}, { id: m.id }) }] });
    } catch (e) {
      // approve must always answer with a decision; for the others an error is shown to the model
      if (m.params.name === 'approve')
        return reply(m.id, { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: `permission server unreachable: ${e.message}` }) }] });
      return reply(m.id, { isError: true, content: [{ type: 'text', text: e.message }] });
    }
  }
  if (m.method === 'notifications/cancelled') return inFlight.get(m.params?.requestId)?.(); // the client gave up on a call
  if (m.id !== undefined) // unknown request
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not found' } }) + '\n');
});
