# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") on this repository, or email
[security@halayhq.com](mailto:security@halayhq.com).
Include what you found, how to reproduce it, and the version or commit. You should get a first answer within a week.
This is a small project maintained in spare time; there is no bug bounty.

## Threat model (read this before running it)

This server is a remote control for your machine. Treat it that way.

- **Anyone who holds the access token (`.token` / `HALAY_TOKEN`) or is signed in with a passkey gets a shell as the
  user running the server.** Agents run commands and edit files with that user's rights, and the web terminal is a
  login shell. There is no sandbox between the web UI and your account.
- **Never expose it to the public internet.** The default bind is `127.0.0.1`. If you set `HOST=0.0.0.0`, do it only
  on a private network (Tailscale/WireGuard/LAN). For phone access use HTTPS from a private tunnel such as
  `tailscale serve` (not `funnel`). Passkeys and Web Push require HTTPS (or localhost) anyway. If you must put it on
  a public address, put a TLS-terminating reverse proxy with its own authentication in front of it.
- **Auth model:** browsers sign in with WebAuthn passkeys (first registration needs the token); agents and the API use
  the token as a Bearer credential. Sessions are 30-day HttpOnly cookies stored hashed. Failed token checks are rate
  limited per client address. Keep `.token` mode 600 and out of git, chats and logs.
- **Agents don't get the access token handed to them** (this limits the halay API, it is not a sandbox: a shell command can still read `.token`, see below). Each agent's halay MCP server gets a token of its own, derived from the
  access token (a new access token revokes them all). The server takes the caller's identity from it, not from a header
  the agent sends, and it opens only what the halay tools need: agents (an agent acts on the agents it started), schedules,
  rooms and stats, and for the conductor tasks, bots, accounts and sessions. Everything else answers 403 to it:
  terminals, approvals, permission modes, settings, accounts, plugins, peer setup, files, the editor and git. A
  `HALAY_TOKEN` set in the environment or `.env` is kept out of agents' and terminals' environments, and the agent
  browser's relay gets a key for its own profile and agent instead of the token. Agents started before an update keep
  the access token until their process restarts.
- **Permission modes don't escalate.** A child agent, a schedule an agent adds, a bot it schedules and an agent it
  starts on a peer can't be more permissive than the agent that asked (order: plan, manual, acceptEdits, auto, cli,
  bypassPermissions).
- **Files on disk** live in the data folder (`~/.halay` by default, `HALAY_HOME` to move it; a git checkout that
  already holds data keeps using itself; see [docs/install.md](docs/install.md#data-folder)) and are owner-only: the
  folder itself is mode 700 when halay creates it, `halay.db` (it holds peers' tokens, the Web Push private key and plugin secrets) and
  `.token` are mode 600, `runs/` (agent output, MCP configs) 700. A `.env` you write yourself may hold `HALAY_TOKEN`:
  `chmod 600` it. The background service (`halay service install`) writes no secret into its launchd/systemd file
  (only `PATH`, `HALAY_HOME` and the paths of node and halay); keep `HALAY_TOKEN` in `.env`, not in the unit. Claude agents get their MCP config from a mode-600
  file under `runs/`, not on the command line. Markdown from agents and files is sanitised: no styles, forms or
  buttons, so a reply can't draw a fake approval card.
- **The Mac app** (`halay app`, macos/) signs in with `local-app-token` in the data folder: random, mode 600, new at every
  start. Whoever can read it can already read `.token`, so it adds no new access; it is accepted only at `POST /auth/local`
  from a direct loopback connection (never with `X-Forwarded-*`, `Forwarded`, `X-Real-IP` or Tailscale headers, nor a
  non-loopback `Host`), in a header, compared in constant time and rate limited. It works with passkeys set up (that is its
  purpose). `HALAY_LOCAL_APP=0` removes it. The app is ad-hoc signed, not notarized.
- **Peers** (docs/peers.md): a peer's token is the other server's full access token. Only link machines you control.
- **Plugins** run inside the server process with the server's rights; install only plugins you trust
  (`HALAY_PLUGINS=0` starts with all plugins off).
- **Agent browser profiles** keep logged-in sessions on disk; protect the machine and the data folder accordingly.
- **The agent CLIs** (Claude Code, OpenCode, Cursor's `cursor-agent`, Gemini CLI, Antigravity's `agy`) are separate programs that you
  install and log in yourself; halay drives them and adds an approval layer, see the next section. The "bypass
  permissions" mode removes the approval prompts for every CLI. Use it only in folders and on machines where that is
  acceptable.

## Local HTTPS certificate authority (`halay cert`)

`halay cert install` creates a root CA of your own in `<data folder>/certs/` (`ca.key`, mode 600, in a mode-700
folder) and, on macOS, adds it to your login keychain as trusted; on Linux it prints the commands to do so. Anyone who
gets `ca.key` can make certificates your devices accept, so:

- The CA is limited by X.509 **name constraints** (critical) to this machine's names and addresses: `localhost`,
  loopback, `<hostname>.local`, its Tailscale name and address, its LAN networks (at most a /16 each) and the
  `--host` names you add. Browsers and operating systems refuse a certificate from it for any other name, so a stolen
  key can impersonate this machine's names, not your bank. (Name constraints are enforced by current Chrome, Safari,
  Firefox, iOS, Android and OpenSSL; very old clients may ignore them.)
- `ca.key` is as sensitive as `.token`: an agent running as your user can read it, like every other file in the data
  folder. The key never leaves the machine; `/halay-ca.crt` (no login) serves only the public certificate.
- Prefer `tailscale serve` (a real certificate, nothing to trust) when you can.
- To remove it: `halay cert uninstall` (removes the keychain entry on macOS, prints the commands on Linux, deletes
  the folder), and remove the CA from every phone you installed it on. Re-running `halay cert install` for names the
  CA doesn't cover makes a new CA and removes the old one from the macOS keychain.

## Agent CLIs: approvals, what they do on their own, credentials

**How approvals reach halay.**
- *Claude Code*: started with `--permission-prompt-tool`, so a tool call that needs a decision goes to halay's
  `approve` MCP tool and shows up as an Allow / Always allow / Deny card. Which calls need one is decided by Claude
  Code's own permission mode and rules. "Always allow" writes a rule to the project's `.claude/settings.local.json`.
- *OpenCode, Cursor, Gemini CLI, Antigravity*: run over ACP (Agent Client Protocol). The CLI sends a `session/request_permission`
  request for each call it wants approved, and halay answers it. OpenCode is configured (per process, through
  `OPENCODE_CONFIG_CONTENT`) to ask for edits, shell commands and web fetches; Gemini runs in its asking approval
  mode; Cursor asks for what its own config doesn't allow; Antigravity asks for shell commands and file edits (not for reads or MCP calls, and no per-launch setting changes that). halay applies the agent's permission mode itself:
  `bypassPermissions` allows everything it is asked, `acceptEdits` allows edits whose paths are all inside the agent's folder or its temp folder (symlinks resolved), and asks for the rest, as Claude Code's own `acceptEdits` does; other modes ask you. Its own halay
  tools are allowed without a prompt; built-in subagent tools are refused unless you turned them on. "Always allow"
  picks the CLI's own "allow always" option, which the CLI stores in its own files; Antigravity has none, so halay remembers it for that agent's process.
- Plan mode uses each CLI's read-only mode, but halay also asks before every edit and command of a plan-mode
  agent. The mode `cli` (an option for every CLI) passes nothing, so the CLI's own settings and rules decide.
- Questions and plan approvals are cards in halay too. Nothing is approved on your behalf by halay except what
  your permission mode says.

**What a CLI can do outside halay's approvals.**
- Calls the CLI never asks about: typically reads and searches, and anything its own configuration allows (Claude's
  `settings.json` rules, Cursor's `permissions.allow` in `cli-config.json`, OpenCode's and Gemini's own settings;
  Antigravity's MCP calls in every mode).
  Agents in `cli` mode are only as restricted as that configuration is.
- Anything a command can reach: an approved shell command runs as the server's user, with no sandbox, and can do
  whatever that user can, including changing the CLI's own configuration and reading halay's own files
  (`.token`, `halay.db`): with those it has the access token and full control of halay. The agent token only
  limits what the halay tools can do; it is not a sandbox. Approve shell commands and broad allow rules accordingly.
- The CLI talks to its own model provider with your login or API key; what it sends there is between you and that
  provider. MCP servers from your own CLI config load as usual (except in lean mode, where the CLI supports it).

**Where credentials live.** halay never stores or sends a login. Each CLI keeps its own:
- Claude Code: the account's config folder (`CLAUDE_CONFIG_DIR`): the macOS Keychain (one item per folder) or
  `.credentials.json` there. halay reads only the two expiry timestamps of the login, for display.
- OpenCode: `auth.json` under the account's `XDG_DATA_HOME` (accounts added in halay get a folder of their own;
  OpenCode's config stays shared). Its free models need no login.
- Gemini CLI: its `.gemini` folder under `GEMINI_CLI_HOME` (an OAuth file), or an API key / Vertex setting in the
  environment. halay only checks that such a file or variable exists.
- Antigravity: the OS keyring, one login per user. halay can't give it a second account.
- Cursor: the macOS Keychain, one login per user, or `CURSOR_API_KEY`. halay can't give Cursor a second account.
  Each Cursor agent runs with a config folder of its own under its temp folder (`tmp/<agent-id>/`), holding a copy of
  your `cli-config.json` and links to the rest, so model changes don't change your default; it is removed with the
  agent.
- Accounts added in Settings → Accounts are stored in halay's database as a name, a CLI and a folder (created
  with mode 700). Accounts from shell aliases keep the variables in the alias; if you press **Keep here**, those
  variables, an API key among them, are copied into the database too. Prefer a login over an API key in an alias.
- Back up and protect these folders like the rest of your home directory. Anyone with file access, and any agent
  working as that user, can read them.

## Out of scope

Issues that need an already-signed-in user or the token to do what that access already allows (such as running a
command), exposing the server publicly against this guidance, and vulnerabilities in third-party dependencies that
should be reported upstream (tell us too if we ship an affected version).
