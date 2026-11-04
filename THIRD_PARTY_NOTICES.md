# Third-party notices

halay's own code is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)). This repository does **not** copy
third-party source, with two exceptions listed under "Included in the repository". Everything else is installed from
npm (`npm install`) and keeps its own licence file in `node_modules/<package>/`. The web UI serves some of those
packages straight from `node_modules` under `/vendor/…`; their licence files and notices must stay with them if you
redistribute a copy of `node_modules` or a build that includes it.

## npm dependencies

Generated from `package-lock.json` and the installed `package.json` files; redo it when dependencies change. The
0.1.0 release has 94 packages (direct and transitive, including optional ones; there are no development-only
dependencies). OpenCode, Cursor, Gemini and Antigravity are external programs, not npm dependencies. Licences found:

- **MIT** (70 packages), including: `better-sqlite3`, `ws`, `marked`, `croner`, `jsdom`, `monaco-editor`,
  `@xterm/xterm`, `@xterm/addon-fit`, `@simplewebauthn/server`, `@simplewebauthn/browser`, `node-pty` (optional),
  `fsevents` (optional, macOS file watching, only pulled in by Playwright), `jws`, `node-addon-api`.
- **MIT-0**: `@csstools/color-helpers`, `@csstools/css-syntax-patches-for-csstree`.
- **BSD-3-Clause**: `@highlightjs/cdn-assets` (highlight.js, Copyright (c) 2006 Ivan Sagalaev), `asn1js`,
  `buffer-equal-constant-time`, `source-map-js`, `tough-cookie`.
- **BSD-2-Clause**: `webidl-conversions`, `entities`.
- **ISC**: `inherits`, `minimalistic-assert`, `saxes`.
- **Apache-2.0**: `@playwright/mcp`, `playwright`, `playwright-core` (Copyright (c) Microsoft Corporation),
  `ecdsa-sig-formatter`, `xml-name-validator`.
- **MPL-2.0**: `web-push`.
- **MPL-2.0 OR Apache-2.0** (dual): `dompurify` (used here under Apache-2.0).
- **BlueOak-1.0.0**: `lru-cache`. **CC0-1.0**: `mdn-data`. **0BSD**: `tslib`.

## Notes per component

- **MPL-2.0 (`web-push`)**: MPL-2.0 is a *file-level* copyleft. Obligations only apply to MPL-covered files you modify or
  redistribute in source form: you must keep their licence and make those files' source available. halay uses the
  package unmodified as an ordinary npm dependency, so nothing in this repository is affected and the rest of the code
  stays Apache-2.0. If you patch files inside `web-push` and distribute the result, those patched files stay under MPL-2.0.
- **Apache-2.0 (`playwright`, `playwright-core`, `@playwright/mcp`)**: `playwright` and `playwright-core` ship a `NOTICE`
  file ("Playwright, Copyright (c) Microsoft Corporation. This software contains code derived from the Puppeteer
  project, Apache-2.0") and a `ThirdPartyNotices.txt`. Apache-2.0 section 4 requires redistributors to pass on the
  licence and the `NOTICE` text. As long as those packages are installed from npm unmodified the files travel with them;
  if you bundle or vendor them, include `LICENSE`, `NOTICE` and `ThirdPartyNotices.txt`.
- **Chromium / Chrome (used by the agents' browser)**: not bundled and not redistributed. `npx playwright install
  chromium` downloads a browser build from Playwright's CDN to the user's own machine (Chromium is BSD-3-Clause plus many
  bundled component licences; Google Chrome has its own terms). Users who point `HALAY_BROWSER_PATH` at Chrome accept
  Google's terms for it.
- **monaco-editor** (code editor, served from `node_modules/monaco-editor/min` as `/vendor/monaco/…`): MIT, Copyright (c)
  2016 - present Microsoft Corporation. Its package contains `ThirdPartyNotices.txt` for components it incorporates
  (Node.js path library, marked, TypeScript (Apache-2.0), W3C HTML 5.1 data, JS Beautifier, Ionic docs, vscode-swift), and
  VS Code's codicon icon font (MIT code, CC-BY-4.0 icons). Keep that file with Monaco when redistributing it.
- **highlight.js** (`@highlightjs/cdn-assets`): BSD-3-Clause; the licence file in the package must accompany it.
- **xterm.js** (`@xterm/xterm`, `@xterm/addon-fit`): MIT, Copyright (c) 2017-2019 The xterm.js authors (plus (c) 2014-2016
  SourceLair Private Company and (c) 2012-2013 Christopher Jeffrey, per its LICENSE).
- **marked**: MIT, Copyright (c) 2018+ MarkedJS, (c) 2011-2018 Christopher Jeffrey.
- **better-sqlite3**: MIT (Copyright (c) 2017 Joshua Wise). It compiles in SQLite, which is in the public domain.
- **node-pty** (optional): MIT, Copyright (c) 2012-2015 Christopher Jeffrey, (c) 2016 Daniel Imms, (c) 2018-present
  Microsoft Corporation. Its Windows prebuilds include Microsoft's ConPTY (`conpty.dll`, `OpenConsole.exe`, MIT); they are
  not used on macOS/Linux.
- **croner**: MIT, Copyright (c) 2015-2021 Hexagon. **ws**: MIT, Copyright (c) 2011 Einar Otto Stangvik.
  **@simplewebauthn/\***: MIT, Copyright (c) 2020 Matthew Miller. **web-push**: MPL-2.0, Copyright 2015 Marco Castelluccio.

## Included in the repository

### Icons: `public/icons.svg` (Lucide)

The 86 UI icons in the sprite are from [Lucide](https://lucide.dev) (some are modified only by being wrapped as
`<symbol>`s). Lucide is ISC-licensed, and parts of it derive from Feather (MIT):

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

The Feather portion is MIT:

```
The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.
```

The sprite file carries an attribution comment at the top; keep it.

### App icons: `public/favicon.svg`, `favicon-32.png`, `icon-*.png`, `icon-maskable-*.png`, `badge-96.png`, `apple-touch-icon.png`

The halay mark (an ink rounded square with a lime arc and circles), drawn by `bin/make-icons.mjs` from plain SVG shapes.
It is original work, covered by this project's Apache-2.0 licence. No third-party artwork is included.

### Mac app: `macos/`

The menu-bar app (`halay app`) is original Swift code under this project's Apache-2.0 licence. It uses only Apple's system
frameworks (AppKit, WebKit, Foundation, ServiceManagement, UserNotifications) and includes no third-party code or
libraries.

### Fonts

None are bundled or loaded from the network. The UI uses system font stacks (`-apple-system`, `Segoe UI`,
`ui-monospace`, ...). Monaco brings its own icon font inside its package (see above).

## Not part of this project

- **Agent CLIs.** Claude Code (Anthropic, proprietary), OpenCode, Cursor CLI (Anysphere, proprietary), Gemini CLI and
  Antigravity CLI (Google) are separate programs that the user installs. None is bundled or redistributed. halay starts
  each as an external program and uses the user's own login or API key; each has its own licence and terms.
- **Tailscale** is mentioned in the docs as an optional, external way to get HTTPS and private networking. Nothing of it
  is bundled. **ntfy**, Slack, Discord and Web Push services are optional, user-configured external services.
- **Trademarks** belong to their owners, and halay is not affiliated with any of them: see the Disclaimer in the
  [README](README.md#disclaimer).
