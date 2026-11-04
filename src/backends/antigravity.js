// Google's Antigravity CLI (`agy`, https://antigravity.google/cli) through its ACP server, `agy acp`. Checked live with agy 1.4.12:
// - Approvals: its shell commands and its file writes/edits reach session/request_permission, with allow_once and
//   reject_once options and nothing else, so the swarm applies the agent's permission mode itself (acceptEdits allows edits
//   inside the agent's folder). Not asked: reads, and MCP calls (the swarm's own tools and any others), and writes in a
//   workspace under the process's TMPDIR (agy treats it as scratch space; the agent's own tmp folder is that). Nothing makes
//   it ask more: `agy acp` rejects --settings, the root-level --settings is ignored by the ACP server, and permissions rules
//   (ask/deny) in a settings.json, also a private one (--gemini-dir), are not read by it. So MCP calls can't be gated in
//   `manual`. `bypassPermissions` is the swarm allowing every request (not --dangerously-skip-permissions). Its "always
//   allow" is kept by the swarm, for the life of the process (acp.js).
// - No session/set_mode, so no plan mode and no mode flag: `cli` mode starts it with nothing else, like the others.
// - The swarm's instructions are an appended system prompt (session/new `_meta.antigravity.systemPrompt.append`, see
//   newSessionMeta). The swarm's MCP servers go in session/new and are used. A resumed session is session/load.
// - Models: the ids session/new offers (only the three gemini-3.8-flash-* ones on a free account; Claude and GPT-OSS ids that
//   `agy models` prints were refused over ACP), set with session/set_model. The effort is part of the id (-low, -medium, -high).
// - Its login is in the OS keyring, one per user (GEMINI_CLI_HOME and the other folder flags don't isolate it), so no extra accounts.
// - It has its own subagent tools (invoke_subagent, ...) that can't be turned off, and a free account's quota is limited.
// - Only per-prompt token counts in session/prompt's result: no cost, no context size.
import { createAcpBackend } from './acp.js';

export const antigravity = createAcpBackend({
  id: 'antigravity',
  label: 'Antigravity',
  bin: 'agy',
  acpArgs: ['acp'],
  probe: { args: ['acp', '--help'], expect: /Agent Client Protocol/, tooOld: 'this agy has no ACP mode: run `agy update`' },
  // no accountEnv: see above
  noAccounts: 'Antigravity keeps its login in the OS keyring, one per user: use the antigravity account',
  // Settings → Accounts: `agy models` needs a login and says so on stderr (exit 1) when there is none; a signed-in one prints its models
  auth: {
    args: ['models'],
    parse(out, err) {
      if (/sign in/i.test(err)) return { loggedIn: false };
      if (/^[\w.-]+\t/m.test(out)) return { loggedIn: true, method: 'Antigravity login' };
      throw new Error('no answer');
    },
    fix: 'agy   # then sign in with Google',
  },
  capabilities: {
    approvals: true, questions: false, resume: true, mcp: true, appendPrompt: true, midTurnInput: false, lean: false,
    modes: ['manual', 'acceptEdits', 'bypassPermissions', 'cli'], effort: [],
    models: 'list', usage: { tokens: true, cost: false, context: false }, remoteControl: false, limits: false, history: false, subagents: false,
  },
  modelHint: 'an Antigravity model id, e.g. gemini-3.8-flash-high (effort is part of the id)',
  models: { acp: 'session/new' }, // only a session lists them (the ids it accepts, which `agy models` doesn't know)

  launch(spec) {
    return { args: ['acp'], env: spec.env };
  },

  newSessionMeta(spec) {
    return spec.systemPrompt ? { antigravity: { systemPrompt: { append: spec.systemPrompt } } } : undefined;
  },

  setup(spec) {
    return spec.model ? [{ model: spec.model }] : [];
  },
});
