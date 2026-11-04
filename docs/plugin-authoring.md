# Writing a plugin

A plugin adds things to the swarm without forking it: tools for agents, notification channels, API routes, reactions to
events, sidebar blocks and pages. Working examples:
`plugins-builtin/webhook-notify` (server + small UI), `plugins-builtin/ntfy` (a channel), `plugins-builtin/machines`
(UI only), `test/plugins/hello-block` (a bit of everything).

Plugin API version: **1.0.0**. App name: `halay` (the manifest key and npm prefix `halay-plugin-*`).

## Where plugins live

- `plugins/<folder>/` next to `halay.db` (`HALAY_PLUGINS_DIR` overrides). The folder is gitignored.
- npm: `npm i --prefix plugins halay-plugin-<name>` (or `@scope/halay-plugin-<name>`).
- `plugins-builtin/`: shipped with the app.

Plugins are found when the server starts, and new ones start **disabled**. Enable them in **Settings → Plugins**; the
dialog lists the permissions they ask for. Enabling and disabling take effect right away. New or changed plugin code
needs a server restart (Settings → Server → Restart). `HALAY_PLUGINS=0` starts with every plugin off (safe mode).

## Starter

```
plugins/hello/
  package.json
  server.js     (optional)
  ui.js         (optional)
```

```json
{
  "name": "halay-plugin-hello",
  "version": "0.1.0",
  "description": "Says hello when an agent finishes.",
  "halay": {
    "id": "hello",
    "displayName": "Hello",
    "api": "^1.0",
    "server": "server.js",
    "ui": "ui.js",
    "styles": [],
    "permissions": ["events:agents", "notify", "routes", "ui"],
    "settings": {
      "greeting": { "type": "string", "title": "Greeting", "default": "Well done" }
    }
  }
}
```

```js
// server.js
export function activate(ctx) {
  ctx.events.on('agent.finished', ({ agent, isError }) => {
    if (!isError) ctx.notify.send({ title: `${ctx.settings.get().greeting}, ${agent.name}`, agentId: agent.id });
  });
  ctx.routes.get('hello', () => ({ text: ctx.settings.get().greeting }));
}
```

```js
// ui.js (an ES module loaded into the page)
export function activate(host) {
  host.sidebar.block({ id: 'hi', title: 'Hello', render: async (el) => { el.textContent = (await host.api('hello')).text; } });
}
```

## Manifest (`package.json` → `"halay"`)

- `id`: `a-z 0-9 -`, up to 32 characters; defaults to the package name without `halay-plugin-`. Must be unique.
- `api`: the plugin API versions it works with (`^1.0`, `1.x`, `>=1.0`, `a || b`). Outside the range it is listed as incompatible.
- `server`, `ui`, `styles`: entry files inside the plugin folder. A `ui` entry needs the `ui` permission.
- `permissions`: see below. A new version that asks for more is switched off until the user enables it again.
- `settings`: fields shown as a form in Settings → Plugins. Each one has a `type` (`string`, `number`, `boolean`, or
  `array` with `items.enum` for checkboxes) and optionally `title`, `help`, `default`, `required`, `enum`, `pattern`
  (a regex the whole value must match), `placeholder` and `secret` (stored on the server, never sent back to the
  browser; leaving it empty keeps the saved value).
- `defaultEnabled`: honoured only for built-in plugins.
- Files under `public/` in the plugin folder are served at `/plugins/<id>/public/…` while the plugin runs.

## Permissions

Permissions decide which `ctx` members exist, and the user sees them before enabling a plugin. They are not a sandbox:
a plugin runs in the server process and in the page with the same access as the app itself.

- `events:agents`: `agent.*` and `approval.*` events (includes message and result text)
- `events:tasks`: `task.*` and `schedule.*` events
- `events:rooms`: `room.message`
- `agents:read`: `ctx.agents.list/get`; `agents:control`: also `start/send/interrupt`
- `tasks`: `ctx.tasks`
- `notify`: `ctx.notify.send`; `notify:channel`: `ctx.notify.channel`
- `mcp`: `ctx.mcp.tool`
- `routes`: `ctx.routes`
- `ui`: a `ui` entry
- `db`: `ctx.db`
- `network`, `fs`, `exec`: declared so the user knows; not enforced

## Server API: `activate(ctx)`

`export async function activate(ctx)`; optionally `export async function deactivate()`. Everything registered through
`ctx` (listeners, routes, tools, channels, timers) is removed when the plugin is disabled, so most plugins need no
`deactivate`. A callback that throws is logged in the plugin's log (Settings → Plugins → Log). 20 errors within 5 minutes
switch the plugin off.

- `ctx.apiVersion`, `ctx.plugin` `{ id, version, dir, dataDir }` (`dataDir` is created on first use).
- `ctx.log.info/warn/error(...)`.
- `ctx.settings.get()`: the values with defaults applied. `ctx.settings.onChange(fn)`.
- `ctx.store.get(key)`, `.set(key, value)`, `.delete(key)`, `.list(prefix)`: JSON key/value in halay.db, per plugin.
- `ctx.events.on(name, fn)`: called after the current tick; a slow handler never delays the swarm. Events:
  - `agent.started` `{ agent, pid }`: the agent's CLI process (Claude Code, OpenCode, ...) started (first message, resume, restart)
  - `agent.status` `{ agent, status, was }`: `idle`, `running`, `stopped`, `error` changes
  - `agent.event` `{ agentId, event }`: every event in the agent's stream (assistant text, tool calls and results…; the other CLIs' events are mapped to Claude's event shape), slimmed like the UI's copy
  - `agent.exited` `{ agent, code }`: its process ended
  - `agent.attention` `{ agent, kind, label, text, detail }`: a notification about an agent (kind `done`, `error`,
    `blocked`, `stuck`, `context`, `usage`, `room`), sent whether or not a push goes out
  - `agent.finished` `{ agent, isError, result, handoff }`: every finished turn, with the full result text
  - `agent.removed` `{ agentId, name }`
  - `approval.requested` `{ agent, approvals, text }`, `approval.resolved` `{ agent, reqId, toolName, decision }`
  - `task.added` `{ task }`, `task.finished` `{ task }` (also when a task fails because its agent's process died)
  - `schedule.run` `{ schedule, phase: 'started' | 'skipped' | 'finished', reason?, taskId?, agentId?, failed?, result? }`
  - `room.message` `{ room, message }`
  - `server.ready` `{ port }`, `server.stopping` `{}` (awaited, up to 2 s in total)
  - `agent` is the same summary `GET /api/agents` returns; `task`/`schedule`/`room` match their REST shapes.
- `ctx.routes.get/post/put/patch/delete(path, handler)`: served at `/api/plugins/<id>/api/<path>`, with the API's
  login (session or token). `path` may have `:params`. `handler({ params, query, body, caller })` returns the JSON answer;
  `throw ctx.httpError(400, 'why')` for an error. `caller` is `{ kind: 'session'|'token', agentId, peer, plugin }`.
- `ctx.mcp.tool({ name, description, schema, roles, autoAllow, run(args, caller) })`: an agent tool named
  `mcp__swarm__<id with _>_<name>` (the other CLIs may show it with a prefix of their own, e.g. `swarm_<id>_<name>`; the swarm's instructions tell them so). `roles`: any of `conductor`, `agent`, `bot` (default `['conductor']`). `run` returns
  a string (anything else is sent as JSON). `caller` is `{ agentId, role, name, cwd }`. Without `autoAllow` a call goes
  through the agent's normal permission handling. Agents get new tools in their next session (New context, or a restart of
  their process).
- `ctx.notify.send({ title, body, agentId, kind, url })`: a notification to the user (page, Web Push, every channel).
  Settings → Notifications → "Include details" decides whether `body` is included in pushes.
- `ctx.notify.channel({ id, label, send(n) })`: get every notification that goes out as a push:
  `n = { kind, title, body, agentId, url, link }` (`link` is absolute when the app's HTTPS address is set). Throw on
  failure; Settings → Plugins → Send test calls it and shows the error.
- `ctx.agents.list()`, `.get(id, { tail })`; with `agents:control` `.start(body)`, `.send(id, text)`, `.interrupt(id)`.
  These call this server's REST API, so the same checks and limits apply; agents a plugin starts are marked `plugin:<id>`.
- `ctx.tasks.list()`, `.add(body)`, `.assign(id, opts)`: the same, for the task backlog.
- `ctx.ui.broadcast(type, payload)`: to the plugin's UI (`host.on(type, fn)`) in every open page.
- `ctx.timers.every(ms, fn)`, `.after(ms, fn)` (at least 1 s), cleared on disable.
- `ctx.db` (`db` permission): `ctx.db.handle` (better-sqlite3), `ctx.db.tablePrefix` (`p_<id>_`) and
  `ctx.db.migrate([sql1, sql2, …])`, which runs each step once in a transaction. Tables, indexes, views and triggers must
  start with the prefix.

## UI API: `activate(host)`

`ui.js` is imported as an ES module after the app has loaded, with `styles` added as stylesheets. Optionally
`export function deactivate()`. What it registers through `host` is removed when the plugin is disabled.

- `host.id`, `host.apiVersion`.
- `host.api(path, opts)`: the plugin's routes (`host.api('last')` = `/api/plugins/<id>/api/last`). `opts` = `{ method, body }`.
- `host.coreApi(path, opts)`: the app's REST API with the page's login, e.g. `host.coreApi('/stats')`.
- `host.on(type, fn)`: messages from `ctx.ui.broadcast`.
- `host.every(ms, fn)`: a timer that skips while the page is hidden.
- `host.sidebar.block({ id, title, order, render(body), collapsed })`: a collapsible block at the bottom of the sidebar
  (Machines has `order` 10). Returns `{ el, body, refresh(), setCount(text, level), setHidden(bool), remove() }`;
  `level` `warn` or `high` colours the count.
- `host.pages.add({ id, title, icon, render(el) })`: a page at `#/p/<plugin>/<id>`, opened from a button in the
  sidebar's page bar (before More). `icon` is a name from `public/icons.svg` (default `puzzle`).
- `host.settings.section({ render(el) })`: extra content under the plugin's settings form.
- `host.storage.get(key, default)`, `.set(key, value)`: per-plugin `localStorage`.
- `host.go(hash)`: navigate (`host.go('/tasks')`).
- `host.ui`: the app's helpers: `mk(tag, class, text)`, `esc(text)`, `icon(name)`, `flash(text, kind)`, `ask(text, opts)`,
  `relTime(ms)`. Use the app's CSS variables (`--fg`, `--mut`, `--line`, `--card`, `--err`, `--ok`) so light and dark both work.

Anything outside `ctx` and `host` (the app's globals, internal tables, other routes) is internal and may change without notice.

## Versioning

The plugin API follows semver on its own, separate from the app version. Minor versions only add (new events, new `ctx`
or `host` members, new payload fields), so check before using something newer than your `api` range
(`if (ctx.notify?.channel)`). A major version keeps an adapter for the previous one for at least one release.

## Testing

Point a spare instance at your plugin folder: `HALAY_PLUGINS_DIR=/path/to/plugins HALAY_DB=/tmp/x/halay.db PORT=4799 node src/server.js`.
`test/plugins-e2e.mjs` shows how to drive one without model calls (the fake CLI in `test/fake-claude`).
