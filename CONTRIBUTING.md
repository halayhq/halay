# Contributing

Thanks for helping. This is a small project; keep changes focused.

## Setup

Requirements: Node.js 22 or newer (24 or 26 recommended), git, and (for the real thing) at least one agent CLI (Claude Code, OpenCode, Cursor's `cursor-agent`, Gemini CLI or Antigravity's `agy`). The tests use a fake `claude` and a fake ACP agent (`test/fake-acp`), so they
need neither the CLI nor a login.

    git clone https://github.com/halayhq/halay.git && cd halay
    npm install
    npm run dev      # restarts on server changes, reloads tabs on UI changes
    node bin/halay.js --help    # the `halay` command, run from the clone

The server keeps its data in `~/.halay` unless the clone already holds data from before; set `HALAY_HOME` to keep a
development instance apart from an installed one (see docs/install.md, "Data folder"). What ships to npm is the
`files` list in package.json: check `npm pack --dry-run` when you add a runtime file.

## Layout

- `src/`: the server (`src/server.js` is the entry point; `npm start` runs it) and its modules; `src/backends/` drives
  each agent CLI; `src/cli/` is the `halay` command and the install side (data folder, service, certificates, Mac app,
  restart helper).
- `bin/`: `halay.js` (the npm bin), `swarm-restart`, `dev.js` (`npm run dev`) and the maintainer scripts.
- `public/`: the web UI (served as is). `prompts/`: the conductor prompt. `plugins-builtin/`: plugins that ship with halay.
- `macos/`: the Mac app. `docs/`: user docs. `test/`: tests (`npm test`).

## Tests

Each test in `test/` is a standalone script that starts its own throwaway server on a free port with a temporary
database and a fake CLI (`test/fake-claude`). They never touch your running server or `halay.db`.

    npm test                       # all of them, in sequence
    node test/peers-e2e.mjs        # or one

Add or extend a test for behaviour you change. `test/browser-e2e.mjs` needs a Chromium (`npx playwright install
chromium`).

## Code style

- Plain ES modules and plain browser JS/CSS: no framework, no build step, no TypeScript, no bundler.
- Match the surrounding style (2-space indent, single quotes, semicolons, short comments that say *why*).
- Add runtime dependencies only with a clear reason; check the licence is MIT, BSD, ISC, Apache-2.0 or MPL-2.0 (no GPL, AGPL, SSPL or BSL dependencies) and update
  `THIRD_PARTY_NOTICES.md`.
- Never commit secrets, tokens, `.env`, databases, real hostnames/tailnet names or personal paths. Use placeholders
  like `<machine>.<tailnet>.ts.net` in docs and examples.
- Update the README / `docs/` / `.env.example` when you add a user-visible feature or environment variable.

## Pull requests

1. Fork, branch from `main`, make small commits with clear messages.
2. Run the tests that cover your change (ideally `npm test`).
3. Open a PR describing what and why; mention anything you could not test.
4. By contributing you agree your work is licensed under the Apache License 2.0 (see section 5 of the licence).

Security issues: see [SECURITY.md](SECURITY.md); do not open public issues for them.
