# Accounts

The server can run each agent as a different account, for example a `personal` Claude subscription and a `work` one, or a second OpenCode or Gemini login. An account is a CLI plus a folder that holds its login (Claude: a config directory, `CLAUDE_CONFIG_DIR`).

## Add an account in the swarm (no shell setup)

Settings → Accounts → **Add an account**:

1. Pick the CLI and a name (e.g. `claude-work`).
2. Optionally pick a folder: an existing one (e.g. `~/.claude-work`, to reuse its login) or leave it empty for a new `~/.halay-accounts/<name>`.
3. Claude only: **Share session history and memory with the main Claude account** (on by default) links the folder's `projects/` to `~/.claude/projects`, as in the alias setup below.
4. **Add and log in** opens a terminal running the account's login command. Finish the login there, then press **Re-check**.

What the folder is for each CLI:
- Claude Code: `CLAUDE_CONFIG_DIR=<folder>`; log in with `claude`, then `/login`.
- OpenCode: `XDG_DATA_HOME=<folder>` (its logins and sessions; your OpenCode config stays shared); log in with `opencode auth login`.
- Gemini CLI: `GEMINI_CLI_HOME=<folder>` (its own `.gemini`); log in with `gemini` and pick Login with Google, or set an API key.
- Cursor: no second account. cursor-agent keeps its login in the macOS keychain, one per user, so there is only the `cursor` account.
- Antigravity: no second account. `agy` keeps its login in the OS keyring, one per user, and `GEMINI_CLI_HOME` (or `agy`'s own folder flags) doesn't isolate it, so there is only the `antigravity` account. Sign in with `agy`.

The accounts are stored in the swarm's database and work at once, without a restart. **Remove** forgets one (refused while agents use it); its folder and login stay on disk.

Accounts from zsh aliases (below) still work. **Keep here** on an alias account stores it in the swarm, so you can delete the alias afterwards. Each CLI's own default account (`claude`, `opencode`, ...) is always there.

## The default account of each CLI

When nothing names an account, an agent runs on its CLI's default account: the one named after the CLI (`claude`, `opencode`, ...), unless you pick another. **Set as default** on an account in Settings → Accounts makes it the default for its CLI, and the list marks it (**default for Claude Code**, say); **Set as default** on the CLI's own account goes back to it. There is one default per CLI.

- It applies to new agents started without an account (an agent CLI alone picks that CLI's default), tasks and schedules left on **Default account (…)** (the forms show its name), new bots, the swarm chat when it has no account of its own yet, and the new-agent form's preselection when you haven't used an account there before.
- An agent started by another agent still gets its parent's account when it runs on the parent's CLI; the default only applies when nothing else decides.
- If the chosen account is removed (removing it here also clears the choice), or its CLI isn't available at the next start, the CLI's own account is used again; nothing breaks.
- API: `GET /api/accounts` marks each account `default: true|false`; `GET /api/accounts/default` returns `{ <cli>: { account, chosen } }`; `PUT /api/accounts/default { backend, account }` sets one (`account: null` clears it). Like adding and removing accounts, it's for you, not for agents. `/api/backends` carries each CLI's `defaultAccount`, and the swarm chat's `list_accounts` marks the defaults. Stored in the settings table as `default_accounts`.

## Multiple accounts with zsh aliases

The older way, still supported, and the only one that can set other variables (an API key, say). This guide sets up two extra Claude accounts, `work` and `personal`, next to the default one; other CLIs follow the same shape (see the end of this page). Replace the names with your own.

## How the server finds accounts

At startup the server runs `zsh -ic alias` once and keeps every alias that matches all of these:

- the name starts with a CLI's id or binary (`claude`, `opencode`, `gemini`, `cursor`, `cursor-agent`, `antigravity`, `agy`; letters, digits, `_` and `-` after that), e.g. `claude-work`;
- the value is zero or more `VAR=value` assignments followed by exactly that CLI's binary as the last word (`claude`, `opencode`, `gemini`, `cursor-agent` or `agy`).

The CLI must be installed and usable (see the end of this page). The examples below are for Claude.

The variables become that account's environment for every agent, Remote session and transcript lookup. `$HOME` and `~` in values are expanded; nothing else is. The plain `claude` account (config in `~/.claude`) is always offered, even without aliases, and so is each other installed CLI's default account. The alias name, e.g. `claude-work`, is the account name you see in the UI.

## Step by step

### 1. Create a config dir per account

```sh
mkdir -p ~/.claude-work ~/.claude-personal
```

The name doesn't have to match the alias, but keeping them the same avoids confusion.

### 2. Optional: share session history and memory

Each config dir keeps its own `projects/` folder, which holds the session transcripts and the per-project auto memory (`projects/<folder>/memory/`). If you'd rather every account see the same history and memory, point the extra accounts' `projects/` at the default one before you first use them:

```sh
ln -s ~/.claude/projects ~/.claude-work/projects
ln -s ~/.claude/projects ~/.claude-personal/projects
```

The reference setup does exactly this and shares nothing else. The server notices when several accounts resolve to the same `projects/` folder, scans it only once, and lists its sessions under every one of those accounts. Since the transcript is in the shared folder, an agent can resume a session that another account started.

If an account already has its own `projects/` folder, move its contents into `~/.claude/projects/` first (`mv ~/.claude-work/projects/* ~/.claude/projects/`, then `rmdir ~/.claude-work/projects`) and create the link afterwards. `ln -s` into an existing folder would put the link inside it instead.

### 3. Add the aliases to `~/.zshrc`

```sh
alias claude-work='CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude'
alias claude-personal='CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude'
```

Use exactly this shape: single quotes around the whole value, the variable assignment(s), then `claude`. You can add more variables before `claude` (e.g. `FOO="bar" CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude`). An alias with no variables (`alias claude-main='claude'`) is valid but is just another name for the default account.

Open a new terminal (or `source ~/.zshrc`) and check that zsh sees them:

```sh
zsh -ic alias | grep '^claude'
```

### 4. Log in each account once

```sh
claude-work        # starts Claude Code with ~/.claude-work
/login             # inside Claude Code: log in with the work account, then /exit
claude-personal
/login
```

Each config dir keeps its own login. On macOS Claude Code stores it in the Keychain, separately per config dir. On Linux it's `.credentials.json` inside the dir. Don't copy credential files between dirs; log in with `/login` instead. While you're in each account, also trust the folders you'll use with the per-agent **Remote** button (run `claude-work` in them once), since trust is recorded per account.

### 5. Restart the server and check

Accounts are read only at startup, so restart the server (`npm start` again, or restart your pm2/launchd/systemd service). Agents keep running across the restart. Then check that the accounts show up:

- **UI:** the account picker in **+ New** lists `claude`, `claude-work` and `claude-personal`.
- **Swarm chat:** ask the conductor to run `list_accounts`.
- **API:** `curl -s -H "Authorization: Bearer $(cat .token)" http://127.0.0.1:4777/api/accounts`

Start an agent on each account and send it a message. If it answers, that login works.

## Login status

Settings → **Accounts** lists every account with a green (logged in) or red (logged out) dot, the auth method (for Claude: claude.ai subscription or API key), email, org and plan where the CLI says them, and when it was last checked. **Re-check** runs it again; for a logged-out account **Open terminal** starts a web terminal with the account's variables and login command typed in (Claude: `CLAUDE_CONFIG_DIR=… claude`, then press Enter and `/login`; the other CLIs' commands are below). Each CLI's state comes from:

- Claude Code: `claude auth status --json` (details below).
- Cursor: `cursor-agent status --format json` (logged in, email).
- Antigravity: `agy models`, which lists the models when signed in and says "Please sign in" when not (no email or plan is shown).
- OpenCode: always shown as logged in, because its free models need no login; `opencode auth list` gives the number of provider logins.
- Gemini CLI: it has no status command, so an API key (`GEMINI_API_KEY`, `GOOGLE_API_KEY`), a Vertex AI or Code Assist setting in the account's environment, or its OAuth file in `~/.gemini` (`$GEMINI_CLI_HOME/.gemini`) counts as logged in. None found shows as unknown, since it may keep the login in the keychain.

Under each account the list also shows when the OAuth access token and the login (refresh token) expire or expired. Only those two timestamps are read, from `<dir>/.credentials.json` or the macOS Keychain item `Claude Code-credentials-<first 8 hex of sha256(config dir)>`; tokens are never kept or sent. An expired access token is normal and renews itself on the next use; an expired refresh token means you must log in again.

For Claude the state comes from `claude auth status --json`, run once per config dir at startup and every 30 minutes. The status commands are local: no model call, no tokens spent, and the server never stores credentials. If a Claude agent's turn fails on authentication ("Not logged in", expired OAuth token, 401), the account is marked logged out at once, the agent's chat shows "Account … is logged out, so this agent couldn't run. Log in again and retry.", and the usual notification (Web Push / ntfy "error") carries that text. `GET /api/accounts` and the conductor's `list_accounts` include the status.

## What is shared and what is per account (Claude Code)

| | Where it lives | Shared? |
| --- | --- | --- |
| Login / subscription and its usage limits | Keychain (macOS) or `<dir>/.credentials.json` | Per account |
| User settings (`settings.json`: model, theme, permissions, hooks) | `<dir>/settings.json` | Per account. The reference setup keeps them separate. You could symlink the file if you want one set. |
| User-scope MCP servers (`claude mcp add -s user`), account state | `~/.claude.json` for the default account, `<dir>/.claude.json` for the others | Per account. Add an MCP server once for each account that needs it, e.g. `claude-work mcp add -s user …`. |
| Personal skills, plugins, slash commands, `CLAUDE.md` | `<dir>/skills`, `<dir>/plugins`, `<dir>/commands`, `<dir>/CLAUDE.md` | Per account (symlink them if you want them shared) |
| Session transcripts and auto memory | `<dir>/projects/` | Per account, or shared through the `projects/` symlink from step 2 |
| Input history, todos, caches, file history | other files and folders in `<dir>` | Per account |
| Project files: `.claude/settings*.json`, `.mcp.json`, `CLAUDE.md` in the repo | the project folder | Shared by every account that works in that folder |

The server itself has no per-account state apart from the account name saved with each agent. An agent keeps its account across restarts. A child agent inherits its parent's account unless another one is named when it's started.

## Common pitfalls

- **Alias in the wrong file:** the server asks an interactive zsh (`zsh -ic`), so the alias has to be defined in `~/.zshrc` or a file it sources. Aliases in `~/.bashrc`, `~/.zprofile` or a shell function are not seen. If zsh isn't installed, only the default account exists.
- **Alias shape not recognised:** these are skipped silently: flags after `claude` (`… claude --model …`), a full path (`/usr/local/bin/claude`), `command claude`, `&&` or `;`, and names that don't start with `claude`. Check the output of `zsh -ic alias | grep '^claude'` against the shape in step 3.
- **Variables other than `$HOME`/`~` aren't expanded:** `$XDG_CONFIG_HOME/claude-work` reaches Claude literally. Use `$HOME/...` or an absolute path.
- **Forgot to restart:** new or changed aliases only appear after a server restart.
- **Slow `~/.zshrc`:** alias discovery gives up after 10 seconds, and then only the default account is offered. Move slow work out of `.zshrc`, or guard it so it only runs in a real terminal.
- **Account not logged in:** see [Login status](#login-status) below. Run the alias in a terminal and `/login`. For another CLI use its own login command (see below).
- **Wrong account doing the work:** the account is fixed per agent when it's created. Start a new agent (or resume the session) with the account you want.
- **MCP server or setting "missing" on one account:** user-level config is per config dir (see the table). Add it to that account too, or put it in the project's `.mcp.json` / `.claude/settings.json`.
- **Symlink created after first use:** the account already has its own `projects/` folder and keeps writing there. Merge it as described in step 2.

## Accounts for other agent CLIs

Agents can also run on OpenCode, Gemini CLI, Cursor's agent CLI or Antigravity. Each account belongs to one CLI, and the account an agent runs as decides which CLI runs it.

- Every supported CLI that is installed, on the server's PATH and new enough to speak ACP gets a default account named after it: `opencode`, `gemini`, `cursor` or `antigravity`. The new-agent form then shows an Agent CLI picker. `HALAY_BACKENDS=claude,opencode` in the server's environment limits which CLIs are offered.
- For more accounts of the same CLI, use **Add an account** (above), or add aliases the same way as for Claude. The alias name starts with the CLI's id or binary, and the last word is the binary:

```sh
alias opencode-work='XDG_DATA_HOME="$HOME/.opencode-work" opencode'   # its own `opencode auth login` store
alias gemini-api='GEMINI_API_KEY="..." gemini'
alias cursor-team='CURSOR_API_KEY="..." cursor-agent'
```

  An API key in an alias is kept in plain text in your shell config, and in the swarm's database if you press **Keep here**. Prefer a login where the CLI has one.
- Log in with each CLI itself: `opencode auth login`, `gemini` then its login prompt (or an API key), `cursor-agent login`, `agy` then its sign-in. Settings → Accounts shows the state and runs the command for you (Open terminal). A non-Claude agent that isn't logged in says so in its chat when its session can't start.
- A `cursor-agent` without the ACP mode (builds from before 2026) is listed as "too old": run `cursor-agent update` (for `agy`: `agy update`).
- What an account's folder holds, per CLI: OpenCode `XDG_DATA_HOME` (logins in `auth.json`, sessions; your OpenCode config stays shared), Gemini `GEMINI_CLI_HOME` (its own `.gemini`: login, settings, sessions). Cursor keeps its login in the macOS keychain, one per user, so you can't add a second Cursor account in the swarm (an alias with `CURSOR_API_KEY` can); Antigravity's is in the OS keyring, with no way to separate it.
- Cursor agents ask the swarm before running a command, except commands your own Cursor config already allows (`permissions.allow` in `~/.cursor/cli-config.json`). Model changes made in the swarm go into a copy of that config in the agent's own temp folder, so your Cursor default model is not changed.
- Switching the Swarm chat or a bot to an account of another CLI restarts it on that CLI with a fresh session.
