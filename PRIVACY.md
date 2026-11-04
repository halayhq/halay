# Privacy

halay is a self-hosted program. There is no halay cloud, no account and no telemetry: the project never receives your
data, and the program makes no calls home (no update check, no analytics).

- **Your data stays on your machine.** Agents, chats, settings, the database, the access token and passkeys live in
  `~/.halay` (or the folder you set). halay does not send them to the halay project.
- **The agent CLIs are separate.** halay drives the agent CLIs you installed (Claude Code, OpenCode, Cursor, Gemini CLI,
  Antigravity). Your prompts and files go to those vendors through those CLIs, under their own terms and privacy
  policies. Logins and API keys stay with the CLIs; halay does not read or store them.
- **The agent browser.** If you let an agent use the browser, it loads whatever sites you or the agent open, from your
  machine, and keeps cookies and logins in a profile folder under the data folder. The first use can download Chromium
  from Playwright's CDN (`npx playwright install chromium`).
- **Notifications are optional and off until you set them up.**
  - *Web push* (phone and desktop alerts) is delivered through your browser vendor's push service (Apple, Google or
    Mozilla). The payload is encrypted for your browser, but that service sees that a notification was sent.
  - *ntfy* uses the public server `https://ntfy.sh` unless you enter your own. The notification text goes to that
    server, so use your own server, or leave the "details" option off, if the text is sensitive.
  - *Webhooks* (Slack, Discord or JSON) send the notification to the URL you enter.
- **Peers** on other machines talk to each other only if you add them, using the address and token you enter.
- **Remote access.** If you reach halay from your phone through Tailscale or another tunnel, that service has its own
  privacy policy. halay itself listens on `127.0.0.1` unless you change it.
- **The Mac app** is only a shell around your local server; it talks to nothing else.
- **The website** (halay.app) is a static page and asks for no account. It uses Google Analytics (GA4) to count visits and
  clicks on its GitHub, docs and npm links and on the install-command copy buttons. Google receives your IP address and
  browser details and sets analytics cookies. It stays off when your browser sends Do Not Track or Global Privacy
  Control, and a content blocker stops it too. This applies to the website only, never to the halay program.
- **Email.** If you write to hello@halayhq.com or security@halayhq.com, your message is used only to answer it.

Questions: [hello@halayhq.com](mailto:hello@halayhq.com).
