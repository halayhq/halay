# Installing halay

How to set the server up on your own machine. For what the app does once it runs, see the [README](../README.md).

## Prerequisites

- **macOS or Linux.** Agents talk to the server through named pipes (`mkfifo`), and it uses `ps` to find running agents. Windows isn't supported (WSL should work but is untested).
- **Node.js 22 or newer** (24 or 26 recommended; `node --version`). `package.json` declares `"engines": { "node": ">=22" }`.
- **Build tools, just in case.** `better-sqlite3` and `node-pty` (the web terminal) are native modules. `npm install` normally uses a prebuilt binary, but on a Node version or platform without one it compiles from source. That needs Xcode Command Line Tools on macOS (`xcode-select --install`), or `build-essential` and `python3` on Debian/Ubuntu. `node-pty` ships prebuilds for macOS and Windows only, so on Linux it always compiles. It is an optional dependency: if it can't be built, `npm install` still succeeds and only the terminal is unavailable (Settings → Server says why).
- **At least one agent CLI**, installed by you, on the `PATH` of the shell that starts the server. The server starts every agent as that CLI and reuses its login, so it never asks for credentials itself. None of them is included in this project; each has its own terms.
  - **Claude Code** (`claude`): run it once in a terminal and finish the login. It is always offered as an account.
  - **OpenCode** (`opencode`): its free models need no login. For other providers: `opencode auth login`.
  - **Cursor** (`cursor-agent`): needs a build with its ACP mode (`cursor-agent update` if the swarm lists it as too old). Log in with `cursor-agent login`, or set `CURSOR_API_KEY`.
  - **Gemini CLI** (`gemini`): run `gemini` once and log in with Google, or set `GEMINI_API_KEY`, or use Vertex AI. Google retired Gemini CLI for personal Google accounts on 2026-06-18; for a personal account use Antigravity.
  - **Antigravity** (`agy`): needs a build with its ACP mode (`agy update` if the swarm lists it as too old). Run `agy` once and sign in with Google. See the README for what it can't do (no plan mode, no second account, its MCP calls are not gated by approvals).
  Each CLI other than Claude is found when the server starts: if it isn't on the `PATH` then, it isn't offered until the next restart. Which one an agent runs on follows from its account (see [Accounts](#accounts)); `HALAY_BACKENDS` limits what is offered.
- **git**, to clone the repo and for the git and worktree features.
- **zsh** (optional), only needed for accounts that you define as shell aliases. Accounts added in Settings need no shell. See [Accounts](#accounts).

## Install

```sh
npm install -g @halay/app
halay --version
```

That puts the `halay` command on your `PATH` (in npm's global folder: `npm prefix -g`). If `npm install -g` fails with a permission error, your Node is a system install: use a Node version manager (nvm, fnm, mise, Volta) or point npm at a folder you own (`npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`); don't use `sudo`.

Settings are optional; every one has a default. To change some, create `~/.halay/.env` (see [`.env.example`](../.env.example)).

To keep it running in the background, starting at login: `halay service install` (see [Running in the background](#running-in-the-background)).

**Just trying it?** `npx @halay/app` runs the server without installing anything. It runs from npm's temporary cache (`~/.npm/_npx/<hash>/…`, or `_npx` inside a custom `npm_config_cache`), which npm may clean at any time, and npx may fetch a newer version on a later run. So it is for a first look, not for daily use: `halay service install` refuses to run from it (the service would point at a folder that can vanish and silently stop starting), and the startup log says `Running from npx (temporary)`. Data goes in `~/.halay` exactly as with a global install, so if you then run `npm install -g @halay/app`, all your agents, the access token, passkeys and settings are already there. Stop the npx server first (Ctrl-C or `halay stop`), since two servers can't share the port.

`halay --version` and **⚙ Settings → Server** say how this copy was installed (git clone, global npm install, local npm install, npx).

**From a git clone** (to contribute or to run unreleased code):

```sh
git clone https://github.com/halayhq/halay.git && cd halay
npm install
npm start               # the same as `halay`; or `node bin/halay.js <command>` for the other commands
```

A clone keeps its data in `~/.halay` as well, unless it already holds data from before (see [Data folder](#data-folder)).

### Commands

- `halay` or `halay start [--port N] [--host ADDR]`: run the server in the foreground (Ctrl-C stops it; agents keep running). `PORT`, `HOST` and every `HALAY_*` variable work as well.
- `halay token`: print the sign-in URL with the access token (and the HTTPS one when `HALAY_PUBLIC_URL` is set).
- `halay restart`: restart the running server, like **Settings → Restart server**; waits until it is back.
- `halay stop`: stop the running server. Agents and terminals keep running and are reattached at the next start.
- `halay service install|uninstall|status|logs|start|stop`: run it in the background at login; see [Running in the background](#running-in-the-background).
- `halay app [install]`: the macOS menu-bar app; see [Mac app](#mac-app).
- `halay cert install|status|renew|uninstall`: HTTPS on the LAN with a CA of its own; see [Local HTTPS](#local-https).
- `halay --version`, `halay --help`.

### Data folder

Everything the server writes at runtime lives in one folder, the **data folder**: the access token (`.token`), the database (`halay.db` with its `-wal`/`-shm` files), `runs/` (agent pipes and output, MCP configs, browser profiles, `server.pid`, `server.log`, the terminal socket), `tmp/` (agents' temp folders and worktrees, uploads), `bots/` (bot homes), `conductor/`, `plugins/` and `plugin-data/`, `logs/` (the background service's log) and your `.env`. The code and the web UI are only read from the app folder, so an upgrade never touches your data. Which folder, first match wins:

1. `HALAY_HOME`, if set (in the environment, or in a clone's own `.env`).
2. The folder of `HALAY_DB`, if only that is set (as before, when `runs/` and `plugins/` already followed the database).
3. The app folder itself, if it is a git checkout that already holds data (`.token` or `halay.db`): installs made from a clone before the data folder existed keep working, untouched.
4. `~/.halay` otherwise (an npm install, or a fresh clone). It is created with mode 700.

The server logs the folder it uses at startup (`data: …`), and **⚙ Settings → Server** shows it. To move an existing clone install to `~/.halay`: stop the server, `mkdir -m 700 ~/.halay`, move `.token`, `halay.db*`, `runs/`, `tmp/`, `bots/`, `conductor/`, `plugins/`, `plugin-data/` and `.env` there, and start it again. Do it while no agent is working: running agents keep files open under `runs/` and `tmp/`.

### `.env` settings

The server reads `.env` from the data folder when it starts, and, when it runs from a git clone, the clone's own `.env` too. Precedence: variables set in the real environment, then `<data folder>/.env`, then the clone's `.env`. `.env` is gitignored.

| Variable | Default | What it does |
| --- | --- | --- |
| `HALAY_HOME` | see [Data folder](#data-folder) | The data folder. `~` is expanded. Set it in the environment (or a clone's `.env`), not in the data folder's own `.env`. |
| `HALAY_PUBLIC_URL` | empty | The HTTPS address the app is reached at, e.g. `https://<machine>.<tailnet>.ts.net` from `tailscale serve`. Used as the Web Push sender (VAPID subject) and shown in Settings when you open the app over plain http. The address field in ⚙ Settings overrides it. |
| `PORT` | `4777` | HTTP port. |
| `HOST` | `127.0.0.1` | Listen address. `0.0.0.0` makes it reachable from other devices. See [Phone access](#phone-access). |
| `HALAY_TOKEN` | generated | Access token. If it's unset, a random one is created once and saved in `<data folder>/.token` (mode 600). Agents' and terminals' environments don't get it. |
| `HALAY_LOCAL_APP` | on | Set to `0` to turn off the Mac app's local sign-in (no `local-app-token` file, `POST /auth/local` answers 404). See [Mac app](#mac-app). |
| `HALAY_RESET_PASSKEYS` | off | Set to exactly `1` (any other value is ignored) for one start to delete every passkey and browser session, which re-opens the first-run setup (needs the token). Unset it afterwards. |
| `HALAY_DB` | `<data folder>/halay.db` | SQLite database. Set without `HALAY_HOME`, its folder becomes the data folder. |
| `HALAY_UPLOAD_MAX_MB` | `50` | Maximum size of a file uploaded into a chat. |
| `HALAY_BROWSER_PATH` | auto | Chromium/Chrome binary for the agents' browser. If set but the file doesn't exist, no browser is found (it does not fall back). See [Browser for agents](#browser-for-agents). |
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright's default cache | Where to look for the Chromium that `npx playwright install chromium` downloaded (default `~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` elsewhere). Set it in the same environment you run the install in. |
| `HALAY_PEER_NAME` | host name | The name this server calls itself towards [peers](peers.md) (the name set in Settings → Peers wins). |
| `HALAY_PLUGINS` | on | `0` starts in safe mode: every plugin stays off (see [plugin-authoring.md](plugin-authoring.md)). |
| `HALAY_PLUGINS_DIR` | `<data folder>/plugins` | Where locally installed plugins live. |
| `HALAY_MAX_LIVE` | `60` | Most agents running at once that agents may start through the swarm MCP (minimum 1). |
| `HALAY_KILL_AGENTS` | unset | `1` stops the agents' CLI processes and the web terminals when the server stops. By default they keep running and the next server start reattaches to them. |
| `HALAY_TERMINAL` | on | `0` turns the web terminal off: no shells can be opened, the API answers 403 and the buttons are hidden. |
| `HALAY_BACKENDS` | all installed | Comma-separated CLI ids the swarm offers, e.g. `claude,opencode` (ids: `claude`, `opencode`, `gemini`, `cursor`, `antigravity`). Claude is always on. |
| `HALAY_ACCOUNTS_DIR` | `~/.halay-accounts` | Where the folder of an account added in Settings goes when you don't pick one. |
| `HALAY_HTTPS_PORT` | `4778` | HTTPS port, used when there is a certificate (see [Local HTTPS](#local-https)). |
| `HALAY_TLS_CERT`, `HALAY_TLS_KEY` | unset | Your own certificate and key (PEM) for HTTPS instead of halay's. Never written by halay. |
| `HALAY_HTTP_HOST` | `127.0.0.1` with HTTPS on, else `HOST` | Where plain http listens. |
| `HALAY_OPENSSL` | `openssl` | The openssl binary `halay cert` uses. |
| `HALAY_RESTART` | detected | How **Settings → Restart server** restarts: `spawn` starts the server again through a detached helper, `exit` exits with code 75 for a supervisor to restart (the helper still starts it if nothing serves the port 20 s later). Detected at startup: `exit` under `npm run dev`, pm2, and launchd/systemd services, else `spawn`. |

## First run

```sh
halay            # from a clone: npm start, or npm run dev (restarts on server changes, reloads tabs on UI changes)
```

It prints `halay running: http://localhost:4777/?token=…`. Open that URL (it says `localhost`, not `127.0.0.1`, on purpose: a passkey needs a domain name, and browsers refuse an IP address for it; a browser that opens `http://127.0.0.1:4777/…` is redirected to `localhost` with the same path and `?token=`): with no passkey yet it shows **Set up your passkey** (the token from the URL is already filled in); your device then creates the passkey and you are signed in. Details in [Login](#login-passkeys). To find it again, run `halay token` (or `cat` the `.token` in the [data folder](#data-folder), or check `HALAY_TOKEN`).

Click **+ New**, pick a folder (and an **Agent CLI**, if more than one is installed) and start chatting. The per-agent **Remote** button (Claude Code only) also needs the folder to be trusted by Claude, so run `claude` there once first.

`halay.db`, `.token`, `runs/` and `tmp/` are created in the [data folder](#data-folder) (in a clone that already had them, they stay there; they are gitignored).

## Accounts

An account is one login of one CLI, and the account an agent runs as decides which CLI runs it. Each installed CLI has a default account named after it (`claude`, `opencode`, `gemini`, `cursor`, `antigravity`), using that CLI's usual login; **Set as default** in Settings → Accounts makes another account of that CLI its default ([details](accounts.md#the-default-account-of-each-cli)).

To add more (a work and a personal login, say), open **Settings → Accounts → Add an account**, pick the CLI and a name, optionally a folder, and press **Add and log in**: a terminal opens running the CLI's login command. The account has a folder of its own for its login (Claude `CLAUDE_CONFIG_DIR`, OpenCode `XDG_DATA_HOME`, Gemini `GEMINI_CLI_HOME`; Cursor and Antigravity keep their login in the keychain or keyring and have no second account). It works at once, with no restart and no shell setup.

The older way still works: the server runs `zsh -ic alias` once at startup and picks up every alias whose name starts with a CLI's id or binary and whose value is only `VAR=value` assignments followed by that binary, for example in `~/.zshrc`:

```sh
alias claude-work='CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude'
```

An alias needs a new terminal to log in, and a server restart to appear. **Keep here** on an alias account stores it in the swarm so the alias can go.

For the full walkthrough (sharing Claude history and memory between accounts, what is per account, pitfalls), see [accounts.md](accounts.md).

Each agent's process gets the account's variables, so its sessions, usage and settings come from that folder. Earlier Claude sessions shown in the new-agent dialog are read from `<config dir>/projects/`; OpenCode and Cursor sessions are asked from the CLI (Antigravity's are not listed).

## Browser for agents

Agents can drive a real browser (see [browser.md](browser.md)). It needs a Chromium binary on the server; `@playwright/mcp` itself arrives with `npm install`.

```sh
npx playwright install chromium     # downloads Chromium into ~/Library/Caches/ms-playwright (macOS) or ~/.cache/ms-playwright
```

The server looks for that copy first, then for Google Chrome / Chromium in the usual places. To use another binary, set `HALAY_BROWSER_PATH` or the path in **⚙ Settings → Browser**. On Linux, `npx playwright install-deps chromium` installs the system libraries it needs. Settings → Browser says whether a binary was found. Browser profiles (logins) are stored in `runs/browser-profiles/` and are sensitive.

## Login (passkeys)

The browser UI signs in with a passkey (WebAuthn: Face ID / Touch ID / Windows Hello / a security key). Scripts, the API and peers keep using the access token (`Authorization: Bearer <token>`). Agents don't get it: each agent's `src/swarm-mcp.js` gets a token of its own that opens only the swarm tools (see [SECURITY.md](../SECURITY.md)).

- **First run:** with no passkey registered, the login page offers **Set up your passkey**. It is not open to whoever reaches the page: you must give the token (open the `?token=…` URL printed at startup, or paste it from `.token`), so someone else on your tailnet/LAN can't claim the account. Once a passkey exists, this setup is closed.
- **More devices:** sign in, then **⚙ Settings → Security → Add a passkey on this device** (do this on the phone, over the HTTPS address). The list there lets you rename and remove passkeys and **Log out**. Adding needs a browser session, not just the token.
- **Sessions:** after login the server sets a `halay_session` cookie (HttpOnly, `SameSite=Lax`, `Secure` over https, 30 days, renewed while you use it). Only a hash of it is stored, in the `sessions` table of `halay.db`; logout deletes it. UI pages, API, uploads, the WebSocket (UI and terminal) all accept the session; without one only the login page is served. File viewer links (`/raw/…`) stay signed, expiring URLs. Cookie-authenticated requests that change things must come from the app's own origin.
- **Address:** a passkey belongs to the address (rpID) it was registered at. The origin must be this server's own address: the `Host`/`X-Forwarded-Host` of the request or the host of `HALAY_PUBLIC_URL` (or Settings' address). A passkey made at `https://<machine>.<tailnet>.ts.net` doesn't work at `http://localhost:4777` (which has its own, if you add one there). Passkeys need a secure context (https or localhost) and a domain name as the address, never an IP address (so `http://127.0.0.1:4777` redirects to `http://localhost:4777`), so on a phone use the `tailscale serve` HTTPS address; on plain http only the token sign-in is available.
- **Recovery:** the token signs a browser in only while no passkey exists. Once one does, the token no longer works for browsers (it still works for agents and the API), so a leaked token can't take over the UI. If all passkeys are lost, start the server once with `HALAY_RESET_PASSKEYS=1` (removes all passkeys and sessions), then set up again with the token.
- **Rate limiting:** 10 failed token/passkey attempts per client in 15 minutes lock that client out for the rest of the window. Behind `tailscale serve` the client address comes from `X-Forwarded-For`. Tokens and cookies are never logged.

## Phone access

The token (and the passkeys that gate the browser UI) also open the web terminal (a shell on the machine), so never expose the port to the internet. Use a LAN or a [Tailscale](https://tailscale.com) tailnet.

- **Plain http on the LAN or tailnet:** set `HOST=0.0.0.0` and open `http://<machine-ip-or-tailnet-name>:4777/?token=…` (signs in with the token only while no passkey exists; passkeys need HTTPS). Everything else works except notifications while the page is closed, because browsers allow those only on HTTPS.
- **HTTPS through Tailscale (recommended):** keep `HOST=127.0.0.1`. Enable HTTPS / Serve for your tailnet in the Tailscale admin console, then run:

  ```sh
  tailscale serve --bg --https=443 http://127.0.0.1:4777
  # macOS App Store / standalone app:
  TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=443 http://127.0.0.1:4777
  ```

  `tailscale serve status` shows the address (`https://<machine>.<tailnet>.ts.net`). Put it in `.env` as `HALAY_PUBLIC_URL` and restart the server.
- **HTTPS on the LAN without Tailscale:** see [Local HTTPS](#local-https) below. More setup than Tailscale (every device has to trust a certificate authority of your own), so prefer `tailscale serve` when you can.

### Local HTTPS

For when Tailscale isn't an option: `halay cert install` makes a certificate authority (CA) of halay's own and a server certificate signed by it, and the server then **also** serves the app over HTTPS on port 4778 (`HALAY_HTTPS_PORT`), at `HOST`. Plain http stays on `127.0.0.1` only (agents and the swarm MCP server use it; `HALAY_HTTP_HOST=0.0.0.0` puts it back on the network).

```sh
halay cert install          # [--host name-or-ip …] for extra names; --dry-run shows what it would do
# HOST=0.0.0.0 in ~/.halay/.env to reach it from other devices, then:
halay restart               # starts the HTTPS listener (later certificate changes need no restart)
halay cert status           # names, expiry, fingerprint, trusted or not, last/next renewal check
```

- **What it makes:** in `<data folder>/certs/` (mode 700): `ca.key` (mode 600) and `ca.crt`, an ECDSA P-256 root CA valid 5 years, and `leaf.key` / `leaf.crt`, the server's certificate (397 days). The CA carries X.509 **name constraints**: it can only vouch for this machine's names, i.e. `localhost`, `127.0.0.1`/`::1`, `<hostname>.local`, its Tailscale name (if `tailscale status` gives one), its LAN networks and Tailscale address, and every `--host`. A device that trusts it trusts it for nothing else. It needs the system `openssl` (OpenSSL or LibreSSL; `HALAY_OPENSSL` for another path); there is no mkcert dependency.
- **Trust on this machine:** on macOS, `install` adds the CA to your login keychain (`security add-trusted-cert`; macOS asks for your password). Safari, Chrome and Edge use it. On Linux it prints the `sudo` commands for your distribution's store (and for Chrome's NSS store) instead of running them. **Firefox** has its own store: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import `ca.crt` (or on macOS set `security.enterprise_roots.enabled` to `true` in `about:config`).
- **Phones:** open `https://<this machine>.local:4778/halay-ca.crt` (or the IP), accept the one-time certificate warning (it's only to download the CA; compare the SHA-256 fingerprint the phone shows with `halay cert status`), or send `ca.crt` over AirDrop. The URL serves only the public CA certificate, without login.
  - **iOS / iPadOS:** after downloading, Settings → **Profile Downloaded** → Install; then Settings → General → About → **Certificate Trust Settings** → turn on full trust for "Halay local CA". To remove it: Settings → General → VPN & Device Management.
  - **Android:** Settings → Security (or "Security & privacy") → More security settings → Encryption & credentials → **Install a certificate → CA certificate** → pick the downloaded `halay-ca.crt`. Chrome uses it; some apps don't trust user CAs.
- **Passkeys are per address:** one made at `http://localhost:4777` or at your Tailscale address doesn't work at `https://<machine>.local:4778`; sign in with the token there (while you have no passkey) or with a passkey from an address that has one, then add one in Settings. Set `HALAY_PUBLIC_URL` to the https address for Web Push.
- **Renewal is automatic:** the running server checks the certificate at start and every 12 hours, and re-issues it (with the same CA, so nothing has to be trusted again) when it expires within 30 days or the machine's names changed, e.g. a new LAN address within the same network or a new Tailscale name. It swaps the certificate in without a restart and logs it. A name the CA doesn't cover (another network, a renamed machine) is logged and shown in Settings → Server: run `halay cert install` again; that makes a new CA, which every device must trust again. The CA itself lasts 5 years; from 60 days before it expires the log and Settings remind you. `halay cert renew` re-issues by hand and makes the running server reload it.
- **Your own certificate:** set `HALAY_TLS_CERT` and `HALAY_TLS_KEY` (PEM files) instead. halay serves them and warns before they expire, but never renews or writes them.
- **Removing it:** `halay cert uninstall` (`--dry-run` first, if you like) removes the CA from the login keychain on macOS (prints the commands on Linux), deletes `<data folder>/certs`, and after `halay restart` the server serves http only. Remove the CA from phones by hand.

### Web Push

1. Open the app at its HTTPS address and sign in (the first time with the `?token=…` link, then add a passkey).
2. Go to **⚙ Settings → Enable notifications** and allow them.
3. On iPhone/iPad, first use Share → **Add to Home Screen**, open the app from that icon, and enable notifications there.

VAPID keys are generated automatically on first start and stored in the database. If no HTTPS address is set, a placeholder `mailto:` sender is used and the server logs a line about it.

### ntfy (optional fallback)

ntfy is a built-in plugin: in **⚙ Settings → Plugins → ntfy**, press Enable, set the server (default `https://ntfy.sh`), a hard-to-guess topic and, for a protected topic, an access token, then Save settings and Send test. Subscribe to the same topic in the ntfy app. The HTTPS address in **Settings → Notifications** is used for the tap-through links. If you had ntfy set up before plugins existed, its settings were moved over on the first start. The **Webhook notifications** plugin does the same for Slack, Discord or any JSON webhook.

## Mac app

`halay app` opens a small menu-bar app (macOS 13+, Apple silicon or Intel): the menu shows whether the server is reachable and how many agents are running or blocked, **Open halay** shows the web UI in a window of its own, already signed in (no passkey prompt). Starting the app (Spotlight, `halay app`) opens that window; a start at login only puts the icon in the menu bar. **Settings…** (menu or ⌘,) sets the server (this Mac, found automatically, or another server's address) and the data folder; what you set there wins over the folder `halay app` passes. While the window is open the app has a Dock icon and a menu bar (File, Edit, View, Window). Agents' alerts arrive as macOS notifications (allow them when macOS asks), also while the window is closed or was never opened. It is only a shell: the server is the Node server you already run (`halay`, or `halay service install` to have it at login).

It ships inside the npm package, ad-hoc signed and not notarized: files npm installs aren't quarantined, so macOS doesn't ask. `halay app install` copies it to `~/Applications` (Spotlight); tick **Launch at Login** in its menu to start it when you log in (it then shows in System Settings → General → Login Items, where macOS may ask you to allow it once, and it remembers the data folder `halay app` last used); run it again after updating halay. In a git clone, build it first with `macos/build.sh`. Details: [macos/README.md](../macos/README.md).

How it signs in: the server writes a random `local-app-token` into the data folder at every start (mode 600). The app reads it, which only the same user can do, and exchanges it at `POST /auth/local` for a normal session. The server accepts it only from a direct loopback connection (no `X-Forwarded-*`, `Forwarded`, `X-Real-IP` or Tailscale headers, a loopback `Host`), so a proxy or `tailscale serve` in front of halay can't be used to get in, and failed attempts are rate limited like the other sign-ins.

## Running in the background

```sh
halay service install      # starts it now and at every login
halay service status
halay service logs -f      # the log: <data folder>/logs/halay.log
halay service stop|start
halay service uninstall    # removes the service; data and agents stay
```

Run it from a real install (`npm install -g @halay/app`, or a git clone), not from `npx`: the unit stores the absolute path of `halay`, and `halay service install` (also `--dry-run`) refuses when that is npm's npx cache or a temp folder such as `/tmp`, because the service would silently stop starting once the folder is cleaned.

On macOS this is a launchd user agent, `~/Library/LaunchAgents/app.halay.plist` (label `app.halay`); on Linux a systemd user unit, `~/.config/systemd/user/halay.service`. On a headless Linux machine also run `loginctl enable-linger $USER` once, so it starts at boot and keeps running after you log out. `halay service install --dry-run` prints the file and the commands without changing anything; `--port N` / `--host ADDR` go into the service's environment (other settings go in `<data folder>/.env`).

**PATH.** launchd and systemd don't start programs with your shell's `PATH`, so on their own they wouldn't find `claude`, `opencode`, `cursor-agent`, `agy`, `gemini`, `git` or even `node` (from nvm, Homebrew, `~/.local/bin`, …). `halay service install` asks your login shell for its `PATH` (`$SHELL -ilc`, 10 s timeout; if that fails it uses the `PATH` it was run with and says so) and writes it into the service, together with the absolute paths of `node` and halay and `HALAY_HOME`. So: **run `halay service install` again after installing a new agent CLI, moving one, or switching Node versions.** If a CLI is still missing, the server says so in its log at startup and in **⚙ Settings → Server**.

**Restarts.** Agents and terminals run detached and survive the service being stopped or restarted (the unit leaves them alone: `AbandonProcessGroup` / `KillMode=process`). **Settings → Restart server**, `halay restart` and `swarm-restart` make the server exit with code 75 and the service manager starts it again (only one server: the restart helper starts one itself only if nothing serves the port 20 s later). The service restarts it after a crash too, but not after `halay stop` or `halay service stop`.

**Manual setup / other supervisors.** If you'd rather write the unit yourself, or use pm2 (`pm2 start halay --name halay`, then `pm2 save` and `pm2 startup`): run `<absolute path to node> <install folder>/bin/halay.js start` with `PATH` set to one that has node, git and your agent CLIs, and `HALAY_HOME` set to the data folder; restart only on a non-zero exit; don't kill the whole process group or cgroup on stop (launchd `AbandonProcessGroup`, systemd `KillMode=process`), or the agents die with the server. `halay service install --dry-run` prints a working unit to start from.

## Restarting from the browser

**⚙ Settings → Server → Restart server** (or `halay restart` / `swarm-restart` in a terminal) restarts the server without a shell on the machine. A small helper (`src/cli/restart-helper.js`) is started in its own session, so it survives the old server; it waits for the old process to exit and starts the server again with the same Node, entry point (`halay` or `src/server.js`) and arguments, working directory and environment (the environment from before `.env` was read, so `.env` changes apply). Under a supervisor the server exits with code 75 instead and the supervisor restarts it; the helper only steps in if nothing serves the port after 20 s. The helper and the restarted server log to `runs/server.log`. Agents and web terminals keep running and are reattached (the terminals' shells live in a separate detached process, `src/pty-host.js`). The page reloads by itself when the server is back.

## Updating

```sh
npm install -g @halay/app@latest
halay restart          # or restart it however you run it
```

The service keeps pointing at the same install folder, so an update needs no `halay service install`, unless the update came with a different Node version. (`npx @halay/app` may fetch a newer version on every run, and is not a way to run a service; see [Install](#install).)

From a clone: `git pull && npm install`, then restart. Database migrations run automatically at startup. Running agents are reattached after the restart. Your data folder is not touched by an update.

After switching Node versions (e.g. with nvm), install halay again under the new one: global packages belong to one Node version, and the native modules (`better-sqlite3`, `node-pty`) are built for it.

## Uninstalling

```sh
halay service uninstall     # if you installed the service
halay stop
npm uninstall -g @halay/app
```

If you used `halay cert install`, run `halay cert uninstall` first (it removes the CA from the keychain). Your data stays in the data folder (`~/.halay` by default): delete it to remove everything, including the database and the access token. Running agents are not stopped by `halay stop`; stop them in the UI first, or start once with `HALAY_KILL_AGENTS=1` and stop that. Accounts added in Settings have their own folders under `~/.halay-accounts`.

## Troubleshooting

- **`NODE_MODULE_VERSION` mismatch / `better-sqlite3` fails to load:** you switched Node versions after installing. Run `npm rebuild better-sqlite3`, or delete `node_modules` and run `npm install`.
- **Agents fail to start with `spawn claude ENOENT`** (or `failed to start opencode`, ...): that CLI isn't on the server's `PATH`. The startup log and Settings → Server name the missing ones. Under the service, run `halay service install` again (it copies your login shell's `PATH`); under pm2 or your own unit, set `PATH` there.
- **A CLI isn't offered in the new-agent dialog:** it isn't on the server's `PATH` at startup, `HALAY_BACKENDS` leaves it out, or (Cursor, Gemini, Antigravity) its build has no ACP mode: run `cursor-agent update`, `agy update` or update Gemini CLI. Restart the server after fixing it. Settings → Accounts lists each CLI that can't run, with the reason (also in `GET /api/backends`); one that `HALAY_BACKENDS` leaves out is not listed.
- **An account is missing:** one added in Settings shows at once. For an alias account, check `zsh -ic alias | grep '^claude'` (or `opencode`, ...) shows it in the `VAR=value … <cli>` form, then restart the server.
- **"Notifications need HTTPS":** you're on plain http. Use the `tailscale serve` address.
- **Lost the token:** `halay token` (or `cat <data folder>/.token`). Delete `.token` and restart to generate a new one (agents pick it up on their next start; browser sessions are unaffected, they use cookies).
- **Can't sign in / lost every passkey:** restart once with `HALAY_RESET_PASSKEYS=1`, then set up a passkey again with the token.
- **"Passkeys need a secure connection":** you opened the app over plain http on a non-localhost address. Use the HTTPS address.
- **Port in use (`EADDRINUSE`):** another instance is running, or set a different `PORT`.
- **Logs:** the server logs to stdout/stderr: the terminal, `halay service logs` (`<data folder>/logs/halay.log`) for the service, or `pm2 logs halay`. After a restart from Settings of a server started in a terminal, it logs to `runs/server.log` in the data folder.
- **Browser panel says no Chromium found / the browser won't start:** run `npx playwright install chromium`, or set the path in Settings → Browser. The browser's own log is `runs/browser-<profile>.log`.
- **Terminal unavailable / `node-pty` failed to build:** install the build tools above, then `npm rebuild node-pty` (or `npm install node-pty`) and restart. After switching Node versions, rebuild it like `better-sqlite3`.
- **Terminal says `posix_spawnp failed`:** the macOS prebuild's `spawn-helper` lost its exec bit. The server fixes this at startup; if the files aren't writable, run `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`.
- **Restarted the server with `kill <pid>; npm start` in a web terminal:** that works (the terminal survives), but the new server is then a child of that terminal's shell and stops when the terminal is closed. Prefer `halay restart`, `swarm-restart` or Settings → Restart server, which start it detached.
- **Terminals gone after a restart:** their host (`src/pty-host.js`) was stopped or crashed; see `runs/pty-host.log`. `HALAY_KILL_AGENTS=1` also ends them on purpose.
