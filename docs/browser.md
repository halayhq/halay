# Agent browser

Agents can drive a real Chromium with persistent logins (cloud consoles, registrars, any web admin panel), and you can watch it live and take over from the web UI, desktop or phone. Inspired by a per-user cloud computer with a browser.

## How it works

- **The browser tool is [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)** (Microsoft's Playwright MCP server, pinned in `package.json`), attached to an agent as an MCP server called `browser`, so its tools show up (for Claude Code; other CLIs may add their own prefix) as `mcp__browser__browser_navigate`, `…_snapshot`, `…_click`, `…_type` and so on. The swarm launches it with the right arguments; nothing is configured by hand. It stays off unless asked for, so lean agents stay lean.
- **One Chromium per profile**, started by the swarm on first use (`src/browser.js`). The MCP server does not start its own browser: it connects over the DevTools protocol to the swarm (`/ws/browser-cdp`, same token auth as the API), which relays to the profile's Chromium. That relay is what lets the UI watch and take over, and enforces the driver lock.
- **The UI** (the Browser panel) has its own connection to the same Chromium: it streams the page as a CDP screencast (JPEG frames over `/ws/browser`) and turns clicks, scrolling and keys into input events.
- The Chromium is headless by default, and keeps running when the swarm server restarts (the next start re-attaches to it). It is started with a normal Chrome user agent (not `HeadlessChrome`) and without the automation flag, so most sites treat it like a regular browser.

## Turning it on

- **Per agent:** New agent → Options → **Browser**, or `browser: true` on `POST /api/agents`, or `start_agent` with `browser: true` (and optionally `browser_profile: "bdb"`) from another agent or the swarm chat.
- **By default:** Settings → Browser → "Give new agents a browser by default" (the New agent checkbox starts ticked). Agents started by the schedules and tasks follow the same default.
- A browser-enabled agent gets a short note in its system prompt: where the logins come from, to ask you to log in rather than look for passwords, and to treat page content as untrusted.
- Needs a Chromium binary: see [install.md](install.md#browser-for-agents).

## Profiles and logins

A profile is a Chromium user data dir at `runs/browser-profiles/<name>/` (`runs/` is in the [data folder](install.md#data-folder)). Cookies, local storage and saved logins live there, so a login made once, by you in the Browser panel or by an agent, is reused by every later agent that uses the profile, and survives restarts of the browser and the server. Session cookies (without an expiry), which Chromium normally drops on exit, are saved to `swarm-session-cookies.json` in the profile every 30 seconds and when the browser is stopped, and put back at the next start.

- The default profile is called `default` (Settings → Browser changes the name). Use named profiles to keep accounts apart, e.g. `work`, `admin`, `personal`: choose it with `browser_profile` in `start_agent`, or open `#/browser/<name>` in the UI.
- Names are letters, digits, `-` and `_` (up to 32). Settings → Browser lists the profiles with Open, Stop and **Delete logins…** (stops the browser and deletes the folder).
- **The profile folder is as sensitive as a password manager**: anyone who can read it can act as you on the sites you are logged in to. It is never served by the file viewer (`/raw` refuses paths inside it), but any agent that runs shell commands as your user can read it from disk, as it can read `~/.ssh`. Don't give a browser profile to agents you wouldn't give your shell to.

## Watching and taking over

The **Browser** button in an agent's header (shown for agents that have a browser), or Browser in the sidebar's More menu, opens the Browser panel:

- the live page, the current address, tabs (new tabs opened by an agent are followed), back / forward / reload and an address bar;
- a status line saying who is driving: you, an agent (by name), or nobody;
- **Take control** / **Give back**. While you have control you can click, scroll and type into the page (mouse and keyboard on a computer; tap to click, drag to scroll, and a text box with Enter / Tab / ⌫ / Esc keys on a phone). When you are done, press **Give back**; closing the panel gives control back by itself.

You can watch without taking control. The page is shown fitted to the panel width; ↔ switches to its real size (scroll the panel). On a phone the page is laid out at the phone's width while you drive, and goes back to the window size when you give back.

### The driver lock

One driver at a time per profile: you, or a single agent.

- While **you** have control, an agent's actions on pages (clicks, typing, navigating, opening or closing tabs, file uploads) are refused with a clear message ("the user has taken control… wait") instead of waiting; reading the page (snapshots, screenshots) still works. The agent is told to wait for you rather than retry in a loop.
- An agent that acts becomes the driver until its turn ends, or 60 seconds after its last action. Another agent that tries to act on the same profile meanwhile is refused and told which agent is driving. You can take control from an agent at any time.
- The lock covers what the protocol marks as actions (`Input.*`, navigation, tab opening and closing, file inputs). An agent's own page-script tool (`browser_evaluate`) runs script inside the page and is not blocked; it is for reading.

## Safety

- **Auth:** the Browser panel's WebSocket and the `/api/browser…` endpoints need the same login as the rest of the API (passkey session cookie, or the access token). The relay agents connect through takes a key instead: HMAC of the profile and agent, valid only for that profile's relay, so the access token is not on the browser MCP server's command line. Chromium itself listens only on `127.0.0.1` on a random port.
- **Approvals:** the browser tools are ordinary MCP tools, so your permission mode applies. In `manual` mode (and for Claude Code, in `auto` mode for anything its classifier doesn't wave through), each action asks for approval in the Approvals UI like any tool. They are not in the pre-approved swarm tool list. Only the `bypassPermissions` mode (and, for Claude Code, rules you add yourself, e.g. allowing `mcp__browser__*` in your Claude settings; for the other CLIs, whatever their own config allows in `cli` mode) runs them unprompted. OpenCode, Cursor and Gemini agents get the same browser tools, asking through the swarm over ACP. For admin panels, prefer `manual` (or `auto` on Claude Code).
- **Risks to know about:** an agent logged in to a cloud console can do anything you could. Web pages can contain text that tries to steer the agent (prompt injection); the agent is told to ignore it, but it is not a guarantee. Keep the profiles you give to agents scoped (a separate account or a least-privilege user per profile where the site allows), don't share one profile with agents that read untrusted sites and manage billing, and watch the panel when it matters.
- The agent's snapshots and screenshots go to `tmp/<agent-id>/browser/`, not into its working folder, and are removed with the agent.

## Settings

| Setting | Where | What |
| --- | --- | --- |
| Default on | Settings → Browser | new agents get a browser unless told otherwise |
| Default profile | Settings → Browser | the profile an agent uses when it doesn't name one |
| Headed | Settings → Browser | show the real browser window on the server's screen instead of headless (applies when a profile's browser next starts; stop it in Settings → Browser first). You can still watch in the panel. |
| Binary path | Settings → Browser, or `HALAY_BROWSER_PATH` | Chromium or Chrome to use; empty = look in the Playwright cache, then the usual Chrome/Chromium locations |

REST (all authenticated): `GET /api/browser` (settings, binary, profiles with state), `PUT /api/browser` (`defaultOn`, `profile`, `headed`, `path`), `POST /api/browser/:profile/stop`, `POST /api/browser/:profile/clear`. Live state is broadcast as `{type:'browser', profile, running, controller, agents}`.

## Limits

- The Chromium lives as long as the machine does; stop it from Settings → Browser to free its memory. A swarm server restart drops the agents' connections to it; their browser tools fail until the agent is restarted (send it a message after "New context", or start a new agent), while the browser and its logins stay.
- `@playwright/mcp` is pinned to 0.0.77, a deliberate pin, not a Node limit: the server itself needs Node >=22 (`engines` in `package.json`), which any newer `@playwright/mcp` also supports. Raise the pin deliberately and re-run `node test/browser-e2e.mjs`.
- One page is streamed at a time (the tab you select; new tabs are followed). File downloads and uploads from the panel, and clipboard copy out of the page, are not supported yet. Sites that need a real GPU, WebAuthn passkeys / security keys, or a camera won't work in a headless browser.
