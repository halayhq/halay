// Claude Code backend: `claude -p` with stream-json in and out. Its events are the
// swarm's canonical event format, so lines pass through as they are. Permission requests arrive through the swarm MCP
// server's `approve` tool (--permission-prompt-tool), not on stdout.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// write a file only its owner can read (also when it existed with wider permissions); returns its path
function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export const claude = {
  id: 'claude',
  label: 'Claude Code',
  bin: 'claude',
  // an account added in Settings → Accounts: its own config folder
  accountEnv: (dir) => ({ CLAUDE_CONFIG_DIR: dir }),
  capabilities: {
    approvals: true, questions: true, resume: true, mcp: true, appendPrompt: true, midTurnInput: true, lean: true,
    modes: ['auto', 'manual', 'acceptEdits', 'plan', 'bypassPermissions', 'cli'], effort: ['low', 'medium', 'high', 'xhigh', 'max'],
    models: 'free', usage: { tokens: true, cost: true, context: true }, remoteControl: true, limits: true, history: true, subagents: true,
  },

  // spec: what the swarm wants for this launch (see Agent.launchSpec in server.js) -> { cmd, args, env }
  launch(spec) {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--forward-subagent-text', // subagent activity shows nested under its card in the UI
      // 'cli' = pass nothing, so the mode comes from your settings exactly as in a terminal session
      // (newer CLIs renamed `default` to `manual`)
      ...(spec.permissionMode === 'cli' ? [] : ['--permission-mode', spec.permissionMode === 'default' ? 'manual' : spec.permissionMode]),
      // no "Co-Authored-By: Claude" / "Generated with Claude Code" lines in agents' commits and PRs
      '--settings', JSON.stringify({ includeCoAuthoredBy: false, attribution: { commit: '', pr: '' }, ...(spec.bot && { autoMemoryEnabled: false, permissions: { allow: spec.bot.allowRules } }) }),
      '--permission-prompt-tool', 'mcp__swarm__approve',
      // the swarm tools are this app's own and are bounded server-side, so they don't need a prompt each time
      '--allowedTools', spec.autoAllowTools.map((t) => 'mcp__swarm__' + t).join(','),
      // the conductor delegates through swarm agents only: without the built-in subagent tool it can't drift to invisible subagents
      ...(spec.noSubagents ? ['--disallowedTools', 'Agent,Task'] : []),
      '--append-system-prompt', spec.systemPrompt,
      // lean: only the swarm MCP server, none of the user's MCP servers or claude.ai connectors
      ...(spec.lean ? ['--strict-mcp-config'] : []),
      // the config holds the agent's swarm token: from a file only this user can read, not on the command line, where
      // every local user can see it (ps)
      '--mcp-config', spec.mcpConfigFile ? writePrivate(spec.mcpConfigFile, JSON.stringify({ mcpServers: spec.mcpServers })) : JSON.stringify({ mcpServers: spec.mcpServers }),
    ];
    if (spec.model) args.push('--model', spec.model);
    if (spec.effort) args.push('--effort', spec.effort);
    if (spec.sessionId) args.push('--resume', spec.sessionId);
    const env = {
      ...spec.env,
      ...(spec.autoCompactWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(spec.autoCompactWindow) } : {}),
      ...(spec.bot ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}), // a bot keeps its memory in its own folder, not in Claude's per-project auto-memory
    };
    return { cmd: 'claude', args, env };
  },

  // is this pid (from before a server restart) still our claude?
  ownsPid(pid) {
    try {
      return /claude/.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch { return false; }
  },

  // per-agent protocol state; claude's is stateless: lines in, events out
  driver(agent) {
    return {
      started() { return []; }, // stdin lines to write right after the process starts
      encode(text) { return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'; },
      onLine(line) {
        try { return [JSON.parse(line)]; } catch { return [{ type: 'stderr', text: line }]; }
      },
      interrupt() { agent.signal('SIGINT'); },
      state() { return null; },
    };
  },

  // the permission-prompt-tool's answer for a decision made in the swarm (see Agent.resolvePermission)
  permissionResult({ allowed, input, answers, alwaysRule, message }) {
    if (!allowed) return { behavior: 'deny', message };
    const result = { behavior: 'allow', updatedInput: answers ? { ...input, answers } : input };
    if (alwaysRule) // same as choosing "don't ask again" in the CLI: saved to the project's .claude/settings.local.json
      result.updatedPermissions = [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [alwaysRule] }];
    return result;
  },
};
