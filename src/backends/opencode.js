// OpenCode (https://opencode.ai) through its ACP server, `opencode acp`. Per-process config goes in the
// OPENCODE_CONFIG_CONTENT env var (merged over the user's config), so nothing is written into the project:
// - permission: edits, shell and web fetches always ask, so every call reaches the swarm, which applies the agent's
//   permission mode itself (Agent.autoDecision); `cli` mode leaves the user's own rules alone
// - instructions: the swarm's system prompt, from a file in the agent's tmp folder
// - the conductor gets no built-in subagent tool (permission.task = deny): it delegates through swarm agents
// Model and plan mode are ACP session config options, set right after the session starts.
import fs from 'node:fs';
import path from 'node:path';
import { createAcpBackend } from './acp.js';

export const opencode = createAcpBackend({
  id: 'opencode',
  label: 'OpenCode',
  bin: 'opencode',
  // an account added in Settings → Accounts: its own data folder (logins in auth.json, sessions); the user's config stays shared
  accountEnv: (dir) => ({ XDG_DATA_HOME: dir }),
  acpArgs: ['acp'],
  capabilities: {
    approvals: true, questions: false, resume: true, mcp: true, appendPrompt: true, midTurnInput: false, lean: false,
    modes: ['manual', 'acceptEdits', 'plan', 'bypassPermissions', 'cli'], effort: [],
    models: 'list', usage: { tokens: true, cost: true, context: true }, remoteControl: false, limits: false, history: true, subagents: false,
  },
  // Settings → Accounts: its free models need no login, so it counts as logged in; `opencode auth list` gives the
  // provider logins it has, `opencode auth login` adds one
  auth: {
    args: ['auth', 'list'],
    parse(out) { const n = Number(out.match(/(\d+)\s+credentials?/)?.[1] ?? NaN); return { loggedIn: true, method: Number.isFinite(n) ? `${n} provider login${n === 1 ? '' : 's'} (free models need none)` : 'free models need no login' }; },
    fix: 'opencode auth login',
  },
  modelHint: 'provider/model, e.g. anthropic/claude-sonnet-5-5 or opencode/big-pickle',
  models: { args: ['models'], parse: (out) => out.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:@-]+$/.test(l)) }, // `opencode models`: provider/model per line

  launch(spec) {
    const config = {};
    const permission = spec.permissionMode === 'cli' ? {} : { edit: 'ask', bash: 'ask', webfetch: 'ask' };
    if (spec.noSubagents) permission.task = 'deny';
    if (Object.keys(permission).length) config.permission = permission;
    const tmp = spec.env.TMPDIR;
    if (spec.systemPrompt && tmp) {
      const file = path.join(tmp, '.swarm-instructions.md');
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(file, spec.systemPrompt + '\n');
      config.instructions = [file];
    }
    return { args: ['acp'], env: { ...spec.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } };
  },

  // its plan_exit tool doesn't exist over ACP (experimental, and it asks through OpenCode's question service, which its
  // ACP agent doesn't forward), so in plan mode it gets the swarm's submit_plan; approving switches it to build with this
  leavePlan: [{ configId: 'mode', value: 'build' }],

  // ACP config options applied once the session exists
  setup(spec) {
    const out = [];
    if (spec.model) out.push({ configId: 'model', value: spec.model });
    if (spec.permissionMode === 'plan') out.push({ configId: 'mode', value: 'plan' });
    return out;
  },
});
