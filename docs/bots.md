# Bots (permanent agents with identity and memory)

Every agent is a one-off chat. A **bot** is a named agent you create once and talk to forever: it has a role, a home folder with memory files it reads and updates itself, a context that is refreshed automatically when it grows, and it shows up everywhere an agent does. Code: `src/bots.js` (definitions, files, upkeep, REST at `/api/bots`), a few hooks in `src/server.js` and `src/rooms.js`, the bot tools in `src/swarm-mcp.js`, `public/js/bots.js` (UI).

## Using them
- Sidebar → **Bots** → **New bot**: name and handle, emoji, role/instructions, account (which also picks the CLI: a bot can run on Claude Code, OpenCode, Cursor, Gemini CLI or Antigravity), permission mode (default **manual**: it asks for approval), model and effort (empty = the Settings → Agent defaults of the bot's CLI, else the CLI's own default; the pickers offer what the CLI has), working folder, browser on/off plus profile, rooms to join, an auto-refresh threshold, optional schedules. **Open chat** is the bot's agent chat (also in the agent list, with a bot badge). Edit, **Pause** / **Resume**, **Refresh context** and **Delete** are on the bot's page; Delete asks, then asks separately whether to delete its folder (it is kept unless you confirm).
- The conductor can `list_bots`, `create_bot`, `update_bot` (incl. `paused`). It cannot create a bot with a more permissive mode than its own (nor schedule one that is more permissive than the agent scheduling it), and `start_agent` refuses a folder or name that belongs to a bot (it is told to `send_message` the bot instead). Other agents can't manage bots.
- **@mention** a bot in a room by its handle (`@scout`); a bot's room handle is always its bot handle. Schedules and backlog tasks can target a bot (`bot=<handle>` on `add_schedule` / `add_task`, the Schedules box on the bot's page): the run is a turn of the bot's own session instead of a new agent. A busy or paused bot skips a scheduled run like an overlapping one.

## Folder and memory
By default a bot lives in `<bots folder>/<handle>/` (the `bots/` folder in the [data folder](install.md#data-folder); change it on the Bots page → Bot settings or `PUT /api/bots/settings`). You can instead point it at an existing project folder; its files then go in `<folder>/.bots/<handle>/` so the project's own files (a `CLAUDE.md` or `AGENTS.md`, say) are left alone.

    BOT.md             generated from the role (the identity file on every CLI; the bot's prompt names it by its absolute path); the block between <!-- bot:role --> markers follows the role field, the rest is yours (bots made before the rename had this as `CLAUDE.md`; it is renamed on first use)
    CLAUDE.md          only for a Claude bot in its own home folder: a two-line pointer to BOT.md, which Claude Code loads by itself, so reading the identity file doesn't depend on the model following the prompt
    memory/journal.md  what it did, one dated entry per task
    memory/notes.md    durable facts: you, projects, preferences, decisions
    memory/threads.md  open threads: pending, waiting, to follow up

The bot's system prompt tells it to read these at the start of a session and to update them at the end of every task (with the CLI's file edit and write tools, which the swarm pre-approves for exactly these paths, so a manual-mode bot never waits for an approval to remember something). The bot page shows the files rendered and lets you edit them or add more files. Claude Code's own per-project auto-memory is switched off for bots so the folder is the single memory.

## Never-ending context
An idle bot whose context passes its threshold (default 100,000 tokens, per bot or in Bot settings; minimum 50,000) gets the existing fresh-context-with-handoff: it first brings its memory files up to date, writes a short note, its session is reset, and the note plus the memory files carry it on. Never while it is running, waiting for an approval or paused, only after it has been quiet for 30 seconds, and at most once per 30 minutes (a new session already starts at a few tens of thousands of tokens). **Refresh context** does it on demand. Changing a bot's account also starts a fresh session (sessions live in the account's config dir); the memory files make that painless.

## Lifecycle
Bot definitions are in the SQLite table `bots`; the bot's agent is an ordinary agent row with a `bot` column, so it survives restarts like any agent (its CLI process keeps running, or resumes its session on the next message). If the agent is gone entirely, the server re-creates it (same id, rooms re-joined) within 30 seconds. An agent that is a bot can't be removed from the agent list or by `remove_agent`: delete the bot instead. Pause stops its process and holds back messages (they are not queued) until you resume.

## REST
`GET/POST /api/bots`, `GET/PATCH/DELETE /api/bots/:handle` (`?home=1` also deletes the folder), `POST /api/bots/:handle/pause|resume|refresh`, `GET /api/bots/:handle/files`, `GET/PUT/DELETE /api/bots/:handle/file?name=BOT.md|memory/<file>.md`, `GET/PUT /api/bots/settings`. Test without model calls: `BASE=http://127.0.0.1:4791 TOKEN=… node test/bots-e2e.mjs` against a spare instance.
