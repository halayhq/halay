# halay for Mac (menu-bar app)

A thin Swift shell around the web UI. The server stays the Node server (`halay`); the app only

- shows status in the menu bar (server reachable? agents running / blocked; the icon shows the number of blocked agents),
- opens the UI in a `WKWebView` window, already signed in (**Open halay**). Starting the app opens the window; a start at login (macOS's "launched as login item" open event) doesn't, it only adds the menu-bar icon,
- turns the UI's `new Notification(...)` into macOS notifications,
- has a Settings window (menu or Cmd+,, `SettingsWindow.swift`): the server (this Mac, automatic, or another server's http(s) address) and the data folder, with Test Connection. They are stored in the app's preferences (`AppSettings.swift`) and win over `--data-dir`, `HALAY_HOME` and the remembered folder. Another server has no automatic sign-in (the local token is for a server on this Mac): sign in once in the window; plain http only works where macOS allows it (the local network), use https otherwise,
- keeps the open window in step with the server: when the server restarts (its start time from `/api/server` changes, seen at the menu's 5-second look) or comes back after being away, the page is loaded again, so new scripts and styles arrive and a "can't reach halay" note goes away by itself,
- starts at login if you tick **Launch at Login** in its menu (`SMAppService`, `LaunchAtLogin.swift`). It registers the bundle where it sits, so run `halay app install` first and switch it off and on again if you move the app. A launch with no flags uses the data folder and port of the last `halay app` (stored in the app's preferences), so a login start finds a data folder that isn't `~/.halay`; `HALAY_HOME` still overrides it. If that folder is on a volume that isn't mounted yet at login, the menu says not reachable until it is.

Run it with `halay app` (installed from npm) or `halay app install` to copy it to `~/Applications`.

## Build

Needs macOS and the Xcode command line tools (`xcode-select --install`); no Xcode project.

    macos/build.sh            # -> macos/build/halay.app: universal (arm64 + x86_64), macOS 13+, ad-hoc signed
    macos/build/halay.app/Contents/MacOS/halay --data-dir ~/.halay     # or: node bin/halay.js app

`npm pack` / `npm publish` run the same build (`prepack`), so the tarball always carries a fresh app; publish from a Mac
(`HALAY_SKIP_MAC_APP=1` packs without the app).

## How it ships

The `.app` goes in the main package (`files: macos/build/halay.app/`, about 0.7 MB) instead of a platform package behind
`optionalDependencies` (the esbuild way). One package to publish, version and sign in lockstep with the server it talks to,
nothing to resolve at install, and the size is small. The cost is that Linux installs carry 0.7 MB they never use; if
the app grows, move it to `@halay/mac` with `"os": ["darwin"]` and `halay app` resolves it. No postinstall script is used:
`halay app` sets the executable bit npm may drop (`src/cli/mac-app.js`).

**Not notarized, on purpose.** Gatekeeper and notarization only apply to files carrying the `com.apple.quarantine`
attribute, which browsers and AirDrop set and npm doesn't. An arm64 binary still has to be signed to run, so `build.sh`
signs ad hoc (`codesign -s -`). A copy downloaded with a browser (a GitHub release zip, say) would be quarantined and
blocked: that needs a Developer ID and notarization.

## How it finds the server

Like the CLI (`src/cli/cli.js`): the data folder is `--data-dir` (what `halay app` passes, resolved by the CLI), else `HALAY_HOME`,
else `~/.halay`. `<data>/runs/server.json`, written by the running server, gives its real port, bind host and HTTPS port
(and proves it is alive); without it the app reports "not running". It uses `http://localhost:PORT` and falls back to
`https://localhost:HTTPSPORT` (accepting halay's own certificate for localhost/loopback only).

## Signing in without a passkey

WebAuthn doesn't work in an ad-hoc signed `WKWebView`, and a loopback connection proves nothing (behind `tailscale serve`
every request is loopback). So:

1. At every start the server writes a random 256-bit `<data>/local-app-token` (mode 600). It is new each time so a leaked
   copy dies with the next restart; the app reads the file at each sign-in and sessions it already got keep working.
2. The app checks the file is its own and private (owner = you, no group/other bits), then sends it in the
   `x-halay-local-token` header to `POST /auth/local` (never in a URL).
3. The server compares in constant time, refuses anything that isn't a direct loopback connection (no forwarding headers,
   loopback `Host`), rate limits failures, and answers with a normal `halay_session` cookie (`via = local-app`).
4. The app puts the cookie into the web view's cookie store and reuses the one the web view already holds on later starts.

Limits: the server must listen on loopback for `http://localhost` (the default; `halay cert` keeps http on loopback too).
A server bound only to a LAN address can't use local sign-in. `HALAY_LOCAL_APP=0` turns it off.

## Web view glue

- Menu bar: the app is an accessory app (menu-bar icon only, no Dock icon) until its window opens; then it becomes a regular
  one, with a Dock icon and the menus in `MainMenu.swift` (halay, File, Edit, View, Window: Cmd+C/V/X/A/Z, Cmd+R, Cmd+W, Cmd+Q,
  zoom, full screen), and goes back to the menu bar when the window is closed.
- `<input type="file">` (`runOpenPanelWith`), downloads (`Content-Disposition: attachment` saves to Downloads), `alert` /
  `confirm` / `prompt` panels.
- Unified title bar: the window has a transparent title bar and no title text, and the page is drawn under it. The shim marks
  `<html class="halay-mac">`; `public/css/polish.css` leaves room for the window's buttons at the top left of the sidebar and
  chat header. A web view has no `-webkit-app-region`, so the shim reports a mouse down on an empty part of the top 44px and
  Swift drags the window (double click zooms). The page's `theme-color` colours the window and picks its light or dark look.
- `target=_blank`, `window.open` and links to other sites open in the default browser.
- `window.halayShell` and a `HalayShell/1` user-agent suffix: the web UI (`public/js/settings.js`) uses the flag to replace
  the Web Push setting with a note ("for your phone or another browser"); push can't work in the embedded web view.
- `Notification` shim (`Shim.swift`): permission is always `granted`, notifications go to `UNUserNotificationCenter`
  (same tag replaces), a click shows the window and calls the page's own `onclick`.
- Notifications before the window is ever opened (`EventStream.swift`): until the web view exists the app listens to the
  server's own `/ws` feed (`notify` messages, signed in like the page) and posts the same notifications, with the same
  title, text, tag and click target. Once the web view exists the page takes over and the stream stops, so nothing shows
  twice; closing the window only hides it, the page keeps running. Like the page it shows every `notify` message (the
  per-event choices in Settings only filter Web Push and plugins).

## Self test

`macos/build.sh --selftest` builds a separate test binary (never shipped) that drives the real app against a running
spare server and prints PASS/FAIL: sign-in, status, the event stream, the shim, Settings relabel, Cmd+A/C/V/X/Z through the menu, the file
chooser, external links, Cmd+R / Cmd+W.

    HALAY_HOME=/tmp/h PORT=47791 node bin/halay.js start &
    macos/build/halay-selftest.app/Contents/MacOS/halay --data-dir /tmp/h

The window checks need the screen on and unlocked (a locked screen leaves the window occluded; they are skipped then).
A data folder on a removable/external volume blocks an app started through LaunchServices on a macOS privacy prompt:
use a folder under your home for that.
