// Gemini CLI (https://github.com/google-gemini/gemini-cli) through its ACP mode, `gemini --acp`.
// - The CLI runs in its asking approval mode, so every call it wants approved reaches the swarm, which applies the
//   agent's permission mode itself; plan mode is the CLI's own read-only `--approval-mode plan`; `cli` passes nothing.
// - There is no flag to add to its system prompt (GEMINI_SYSTEM_MD would replace all of it), so the swarm's
//   instructions go in front of the first message of each session (`preamble`).
// - Lean: --allowed-mcp-server-names limits it to the swarm's own MCP servers.
// - Auth (Google login, GEMINI_API_KEY, Vertex) is the CLI's; a missing login fails session/new, which is shown.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAcpBackend } from './acp.js';

export const gemini = createAcpBackend({
  id: 'gemini',
  label: 'Gemini CLI',
  bin: 'gemini',
  // an account added in Settings → Accounts: its own home for ~/.gemini (login, settings, sessions)
  accountEnv: (dir) => ({ GEMINI_CLI_HOME: dir }),
  acpArgs: ['--acp'],
  probe: { args: ['--help'], expect: /--acp\b/ },
  preamble: true,
  capabilities: {
    approvals: true, questions: false, resume: true, mcp: true, appendPrompt: false, midTurnInput: false, lean: true,
    modes: ['manual', 'acceptEdits', 'plan', 'bypassPermissions', 'cli'], effort: [],
    models: 'free', usage: { tokens: true, cost: false, context: true }, remoteControl: false, limits: false, history: false, subagents: false,
  },
  // Settings → Accounts: Gemini has no status command, so a login is looked for where the CLI keeps it (an API key or
  // Vertex/Code Assist in the environment, else its OAuth file); none found is "unknown", since it may use the keychain
  auth: {
    check(env) {
      if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return { loggedIn: true, method: 'API key' };
      if (env.GOOGLE_GENAI_USE_VERTEXAI || env.GOOGLE_GENAI_USE_GCA) return { loggedIn: true, method: env.GOOGLE_GENAI_USE_VERTEXAI ? 'Vertex AI' : 'Code Assist' };
      const dir = path.join(env.GEMINI_CLI_HOME || env.HOME || os.homedir(), '.gemini');
      if (['oauth_creds.json', 'gemini-credentials.json'].some((f) => fs.existsSync(path.join(dir, f)))) return { loggedIn: true, method: 'Google login' };
      return { loggedIn: null, error: 'no Gemini login found (Google login, GEMINI_API_KEY or Vertex AI)' };
    },
    fix: 'gemini   # then pick Login with Google, or set GEMINI_API_KEY',
  },
  modelHint: 'a Gemini model id, e.g. gemini-2.5-pro',

  launch(spec) {
    const args = ['--acp'];
    if (spec.permissionMode === 'plan') args.push('--approval-mode', 'plan');
    else if (spec.permissionMode !== 'cli') args.push('--approval-mode', 'default');
    if (spec.model) args.push('--model', spec.model);
    if (spec.lean) args.push('--allowed-mcp-server-names', Object.keys(spec.mcpServers).join(','));
    const env = { ...spec.env };
    // no built-in subagents (codebase_investigator, ...): a system settings file of its own with them off, on top of the
    // machine's (system settings win over the user's and the project's)
    if (spec.noSubagents && spec.env.TMPDIR) {
      const base = spec.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || (process.platform === 'darwin' ? '/Library/Application Support/GeminiCli/settings.json' : process.platform === 'win32' ? 'C:\\ProgramData\\gemini-cli\\settings.json' : '/etc/gemini-cli/settings.json');
      let settings = {};
      try { settings = JSON.parse(fs.readFileSync(base, 'utf8')); } catch {}
      settings.experimental = { ...(settings.experimental || {}), enableAgents: false };
      const file = path.join(spec.env.TMPDIR, '.gemini-system-settings.json');
      fs.mkdirSync(spec.env.TMPDIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(settings, null, 1) + '\n');
      env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = file;
    }
    return { args, env };
  },
});
