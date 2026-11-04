# Peers (two swarms driving each other)

Two instances of this swarm, for example on a Mac mini and a laptop in the same tailnet, can see and drive each other: the swarm chat (conductor) on one can list, start, message, wait for and interrupt agents on the other, and use its task backlog, sessions and accounts. Accounts, and with them the agent CLIs (Claude Code, OpenCode, Cursor, Gemini CLI), are each machine's own: an agent started on a peer runs on a CLI installed there, and `list_accounts` with `peer` shows what that machine has. Code: `src/peers.js` (config, proxy, probe), a few lines in `src/server.js` (the receiving side), the `peer` parameter and `list_peers` in `src/swarm-mcp.js`, `public/js/peers.js` (Settings → Peers), `test/peers-e2e.mjs`.

## How it works

- Each server keeps its peers in its own settings table (`halay.db`, gitignored): `name → { url, token }`, plus the name it calls itself. Nothing is in git.
- `/api/peers/<name>/<api path>` on a server is forwarded to `<url>/api/<api path>` of that peer with the peer's token and `x-halay-peer: <this server's name>`. Agents keep talking only to their own server on localhost, with a token of their own; they never see a peer's token or this server's access token. Only `agents`, `tasks`, `sessions`, `accounts`, `limits`, `instance` and `stats` paths are forwarded; anything else gets a 403 (`peers can only be asked for …`).
- On the receiving side a call with `x-halay-peer` must carry the receiver's access token, as every API call. It then has the conductor's rights. Agents it starts are marked `startedBy: "peer:<name>"` (a ⇄ badge in the agent list, "started by peer:<name>" in `list_agents`), tasks it adds `addedBy: "peer:<name>"` (shown as "from peer …" in Tasks). A peer call cannot reach the receiver's own peers, so there are no chains or loops.
- MCP (conductor only): `list_peers` shows each peer and whether it is reachable (with its agent counts and host stats). `list_agents`, `start_agent`, `send_message`, `read_agent`, `wait_for_agent`, `interrupt_agent`, `list_tasks`, `get_task`, `add_task`, `assign_task`, `list_sessions` and `list_accounts` take `peer: "<name>"`. `update_task` and `delete_task` do **not** take `peer` (they act on this swarm's own backlog). Folders are then paths on that machine, and an unset account, permission mode, model or effort means the peer's defaults. Other tools refuse a `peer` argument rather than run locally. Regular agents have no peer tools.
- Errors: an unreachable peer fails after at most 10 s of connecting ("peer "x" is unreachable at …: ECONNREFUSED / no connection after 10s"), a refused token says so (without echoing it), an unknown name says "no peer". A normal call gets up to 2 minutes for an answer; `wait_for_agent` (a long poll) gets its own timeout plus a margin, so it works across machines as it does locally (max 1800 s). If the caller goes away (its MCP server stops), the forwarded request is dropped too.

## Setup (once)

Both machines run the same repo (pull the commit with this feature on both and restart each server once). Example names: `mac-mini` and `laptop`.

1. **Get each server's access token.** On each machine: `cat <data folder>/.token`, e.g. `cat ~/.halay/.token` (or the `HALAY_TOKEN` in `.env` / the launchd plist, if you set one; see [data folder](install.md#data-folder)). It is the token scripts and the API use; agents have tokens of their own.
2. **Name each server** (optional; the default is the `HALAY_PEER_NAME` environment variable, else the host name, lower-cased): Settings → Peers → *This server's name*, then Save. Or `curl -X PUT -H "authorization: Bearer $(cat .token)" -H 'content-type: application/json' -d '{"self":"mac-mini"}' http://127.0.0.1:4777/api/peers`.
3. **On the Mac mini**, add the laptop: Settings → Peers → Name `laptop`, Address `https://<machine>.<tailnet>.ts.net`, the laptop's token → *Save peer*. Or:
   `curl -X PUT -H "authorization: Bearer $(cat .token)" -H 'content-type: application/json' -d '{"url":"https://<machine>.<tailnet>.ts.net","token":"<laptop token>"}' http://127.0.0.1:4777/api/peers/laptop`
4. **On the laptop**, the same the other way round: Name `mac-mini`, Address `https://<machine>.<tailnet>.ts.net`, the Mac mini's token.
5. **Check**: *Check connections* in Settings → Peers shows "reachable: calls itself …", or ask the swarm chat to `list_peers`.

To pass a token without pasting it into a chat, copy it over the tailnet directly, e.g. on the mini: `ssh laptop cat '~/.halay/.token' | pbcopy`, then paste into the field. Changing a peer later: *Edit* fills in name and address; leave the token empty to keep the saved one. Rotating a server's token (delete `.token`, restart) means updating it on the other side too.

## Security notes

- A peer's token is the receiver's full access token: anyone holding it can do everything the API allows on that server (including starting agents that run commands). Only add machines you control, and keep the tailnet-only `tailscale serve` (not `funnel`).
- Tokens are stored only in the settings table of the server that uses them, are never returned by `GET /api/peers` or shown in the UI, never put into an agent's environment or arguments, and never logged. Like `.token` itself, they are readable by anyone with file access to the data folder on that machine (including agents working in it).
- Failed token checks are rate limited per client (10 per 15 minutes); behind `tailscale serve` the client is the peer's tailnet address, so a peer with a stale token is locked out for a while after repeated tries. Fix the token and wait, or restart the receiving server.
- Plain `http://` addresses are accepted (the tailnet encrypts them anyway, and the tests use them), but use the `https://….ts.net` address.

## API

- `GET /api/peers` → `{ self, peers: [{ name, url, hasToken }] }`; `?check=1` adds `status: { ok, name, agents, running } | { ok: false, error }` per peer.
- `PUT /api/peers` `{ self }`: this server's name (empty = the default).
- `PUT /api/peers/<name>` `{ url, token? }`: add or update (token required when adding). `DELETE /api/peers/<name>`. `GET /api/peers/<name>`: one peer with its status.
- `ANY /api/peers/<name>/<path>`: forwarded to the peer's `/api/<path>` (allowed paths above).
- `GET /api/instance` → `{ name, agents, running, stats }`: what a peer's probe sees (`stats` is the host sample from `GET /api/stats`).

Test: `node test/peers-e2e.mjs` starts two spare servers on free ports (fake CLI, throwaway databases) that are each other's peers, and drives one from the other's conductor MCP.

## Host stats (load of each machine)
`src/stats.js` samples this machine on an interval (CPU % from `os.cpus()` deltas plus loadavg and cores; RAM with an "available" figure from `vm_stat` on macOS or `/proc/meminfo` on Linux, because `os.freemem()` undercounts; disk used/free for `/` and the volume the swarm folder is on; battery via `pmset` on macOS), so a request never runs a command. `GET /api/stats` returns the cached sample; `/api/instance` (the peer probe) carries it too, so `list_peers` prints one line per machine, this one first, and the web UI sidebar shows CPU / RAM / fullest-disk per machine (`public/js/hosts.js`, refreshed every 30 s). Tests: `test/stats-unit.mjs`, and the stats checks in `test/peers-e2e.mjs`.
