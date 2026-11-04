// ntfy (https://ntfy.sh) as a notification channel: every notification that goes out as a push is posted to the topic too.
// Was built into server.js; moved into a built-in plugin. Its old settings are copied over once.
const TAG = { done: 'white_check_mark', error: 'x', test: 'bell' };

export function activate(ctx) {
  ctx.notify.channel({
    id: 'ntfy',
    label: 'ntfy',
    async send(n) {
      const { server, topic, token } = ctx.settings.get();
      if (!topic) throw new Error('set a topic first (Settings → Plugins → ntfy)');
      const base = new URL(server || 'https://ntfy.sh');
      if (!/^https?:$/.test(base.protocol)) throw new Error('server must be an http(s) URL');
      const r = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify({
          topic, title: n.title, message: n.body || n.title,
          priority: n.kind === 'done' || n.kind === 'test' ? 3 : 4,
          tags: [TAG[n.kind] || 'warning'],
          ...(n.link ? { click: n.link } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`ntfy answered ${r.status}`);
    },
  });
}
