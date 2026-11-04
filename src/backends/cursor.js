// Cursor's agent CLI (https://cursor.com/docs/cli/acp) through its ACP server, `cursor-agent acp` (newer installs also
// call the binary `agent`). Builds without the acp command are reported as too old (probe) instead of being run.
// Checked live with cursor-agent 2026.10.22:
// - `authenticate` (cursor_login) must come before session/new, which otherwise never answers.
// - The MCP servers given in session/new are used (the swarm's tools reach Cursor agents).
// - Model, effort and plan mode are set per session (session/set_config_option, session/set_mode), with the client's
//   parameterizedModelPicker on: models by name, effort as the model's thought_level option. Either way (and with
//   --model) the CLI saves the model as the user's default in cli-config.json, hence each agent's own config folder
//   (privateConfigDir below).
// - Every call it wants approved reaches the swarm, which applies the agent's permission mode itself; commands the
//   user allowed in Cursor's own config (cli-config.json permissions) run without asking.
// - cursor/ask_question is listed in Cursor's docs but never sent: its servers give ACP sessions no AskQuestion tool
//   (a known Cursor bug, forum.cursor.com/t/172976), so capabilities.questions is false: its agents get the swarm's
//   ask_user tool and are told to use it (prompts.js). The driver still shows a cursor/ask_question should one come.
// - Cursor's extension methods are mapped by the ACP driver: cursor/ask_question to a question card,
//   cursor/create_plan to an approval of the plan, cursor/update_todos to the todo list, cursor/task to a note.
// - No flag adds to its system prompt, so the swarm's instructions go in front of each session's first message.
// - It reports no token usage or cost.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAcpBackend } from './acp.js';

// Cursor saves a session's model (and its options) as the user's default in cli-config.json, whether set by --model or
// in the session. So each agent runs with a config folder of its own (CURSOR_CONFIG_DIR): links to everything in the
// user's (sessions, MCP servers, rules, ...) but a fresh copy of cli-config.json, which keeps the user's permissions
// and takes the model changes. Its "allow always" choices stay with that copy.
function privateConfigDir(env) {
  const home = env.HOME || os.homedir();
  const base = env.CURSOR_CONFIG_DIR || (env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'cursor') : path.join(home, '.cursor'));
  const dir = path.join(env.TMPDIR, 'cursor-config');
  fs.mkdirSync(dir, { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(base); } catch {}
  for (const name of entries) {
    const at = path.join(dir, name);
    if (name === 'cli-config.json') { try { fs.rmSync(at, { force: true }); fs.copyFileSync(path.join(base, name), at); } catch {} continue; }
    try { fs.lstatSync(at); } catch { try { fs.symlinkSync(path.join(base, name), at); } catch {} }
  }
  return dir;
}

export const cursor = createAcpBackend({
  id: 'cursor',
  label: 'Cursor',
  bin: 'cursor-agent',
  acpArgs: ['acp'],
  probe: { args: ['acp', '--help'], expect: /Usage:\s+\S+\s+acp\b/, tooOld: 'this cursor-agent has no ACP mode: run `cursor-agent update`' },
  authMethod: 'cursor_login',
  // no accountEnv: cursor-agent keeps its login in the macOS keychain (cursor-access-token), one per user, so a second
  // Cursor account can't be added in Settings → Accounts
  noAccounts: 'Cursor keeps its login in the macOS keychain, one per user: use the cursor account',
  // Settings → Accounts: `cursor-agent status --format json` (no token in it is kept), and the command that logs in
  auth: {
    args: ['status', '--format', 'json'],
    parse(out) { const j = JSON.parse(out); return { loggedIn: !!j.isAuthenticated, email: j.userInfo?.email || '', method: 'Cursor account' }; },
    fix: 'cursor-agent login',
  },
  preamble: true,
  capabilities: {
    approvals: true, questions: false, resume: true, mcp: true, appendPrompt: false, midTurnInput: false, lean: false,
    modes: ['manual', 'acceptEdits', 'plan', 'bypassPermissions', 'cli'], effort: ['low', 'medium', 'high', 'xhigh', 'max'],
    models: 'list', usage: { tokens: false, cost: false, context: false }, remoteControl: false, limits: false, history: true, subagents: false,
  },
  modelHint: 'a Cursor model name, e.g. gpt-5.5, claude-opus-5-5 or composer-2.5 (effort is set separately)',
  // its models by name (gpt-5.5, claude-opus-5-5, ...), from its ACP server: the ids `cursor-agent models` prints
  // (gpt-5.5-high-fast) are presets that sessions don't accept
  models: { acp: 'cursor/list_available_models' },
  // models by name, with effort, context and fast as each model's own config options (see setup)
  clientMeta: { parameterizedModelPicker: true },

  launch(spec) {
    return { args: ['acp'], env: spec.env.TMPDIR ? { ...spec.env, CURSOR_CONFIG_DIR: privateConfigDir(spec.env) } : spec.env };
  },

  setup(spec) {
    const out = [];
    if (spec.model) out.push({ configId: 'model', value: spec.model }); // its answer has the model's options, effort among them
    if (spec.effort) out.push({ effort: spec.effort });
    if (spec.permissionMode === 'plan') out.push({ mode: 'plan' });
    return out;
  },
});
