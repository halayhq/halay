# Editor (browse and edit an agent's folder)

Each agent has a code editor over its folder (its cwd, which is the worktree for agents started in one): a file tree, tabs, syntax highlighting and save, on desktop and phone. The editor is [Monaco](https://microsoft.github.io/monaco-editor/) (VS Code's editor), served from `node_modules/monaco-editor` (no CDN) and loaded only when the editor is first opened. Code: `src/editor-fs.js` (file API, mounted in `src/server.js`), `public/js/editor.js` and `public/css/editor.css` (UI).

## Using it
- Agent header → **Editor**, or `#/a/<id>/edit/<path>` to open a file directly. **Files** → **Editor** opens the markdown file you are looking at. A file path in the chat opens in the viewer as before; its **Edit** button (text files up to 2 MB) moves it to the editor, and Ctrl/Cmd+click on the path goes straight there.
- Tree: folders load when you expand them. `.git` and `node_modules` are hidden; the eye button shows them. The toolbar has new file, new folder, rename and delete (delete asks first); new items go in the selected folder, or the selected file's folder. A symlink that points outside the folder is shown in italics and can't be opened.
- Tabs: the language comes from the file name. A dot marks unsaved changes (also on the agent's **Editor** button and in the tree). **Save** or Ctrl/Cmd+S saves. Closing a tab with unsaved changes asks first, and so does leaving or reloading the page. Closing the editor keeps the tabs and their edits for the rest of the page's life, per agent.
- Files over 2 MB, binary files and non-UTF-8 files open in the viewer instead. `.env*`, `.token`, `halay.db`, private keys and browser profiles are never opened, written or removed here (the same rule as the viewer).
- **Diff** compares the tab (including unsaved edits) with the file at git `HEAD` in Monaco's diff editor (side by side, inline on phones).
- Theme: follows the app's light / dark / system setting. TypeScript and JavaScript show syntax errors but not type errors, since a single file is checked without its project.
- Phone: the tree is a drawer (the top-left button), the editor fills the screen and follows the on-screen keyboard; the page never scrolls sideways.

## The agent editing at the same time
- When a file is opened, the server returns its etag (a hash of the content) and mtime. A save sends the etag back, and if the file changed on disk since then (the agent edited it), the save is refused (409) and a banner offers **Reload from disk**, **Compare** (diff of the disk version against yours) or **Overwrite with mine**. A file deleted on disk offers **Save to recreate it**.
- While the editor is open and the page visible, it polls the mtime of the open tabs every 2.5 s. A tab without unsaved changes reloads by itself (one undoable edit, cursor and scroll kept); a tab with unsaved changes gets the banner instead.

## Server side
All under `/api/agents/:id/edit/`, with the same auth as the rest of `/api` (session cookie with a same-origin check for writes, or the Bearer token):
`GET list?path=&all=1`, `GET file?path=` (`{ content, etag, mtime, size, readonly }`, or 413 `tooLarge` / 415 `binary`), `PUT file { path, content, etag, force }` (409 `conflict` with the current etag, or `missing`), `POST stat { paths }`, `POST create { path, type: 'file'|'dir' }`, `POST rename { from, to }`, `POST delete { path }`, `GET head?path=`.

- Paths are relative to the folder (an absolute path inside it is accepted). `..` segments are refused. Existing paths are resolved with `realpath` and must stay inside the folder's real path, so symlinks can't lead out of it, whether for reading, writing, listing, or as the parent of a new file. A link inside the folder is written through; renaming or deleting a link affects only the link.
- Opening is limited to 2 MB, writes to 5 MB. A write goes to a temporary file next to the target (same mode), is fsynced, then renamed over it.
- Monaco is served at `/vendor/monaco/…` from `node_modules/monaco-editor/min` (its AMD build: the ESM build needs a bundler), only to signed-in browsers. Its hashed chunks are cached for a day; big files are compressed with a fast brotli level so the first load doesn't stall the server.

Test (starts its own spare instance; no model calls): `node test/editor-e2e.mjs`, or `BASE=… TOKEN=… node test/editor-e2e.mjs` against one you started.

The UI scripts are classic `<script>`s sharing one global scope, so editor.js prefixes its globals with `e`/`ed` (a second `function showTab` once replaced the Tasks panel's and sent its Schedules tab to the editor). `node test/routes-e2e.mjs` (spare instance, needs playwright-core and Chrome) fails on any global function or var declared by two scripts, opens every hash route and checks that only its dialog opens, and switches the Tasks panel's tabs after the editor has loaded.
