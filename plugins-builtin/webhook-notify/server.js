// The example plugin of docs/plugin-authoring.md: a notification channel, an event hook, a route and an agent tool.
const payload = (format, n) => {
  const text = n.body ? `*${n.title}*\n${n.body}` : `*${n.title}*`;
  const withLink = n.link ? `${text}\n${n.link}` : text;
  if (format === 'slack') return { text: withLink };
  if (format === 'discord') return { content: withLink.replace(/^\*(.*)\*$/m, '**$1**') };
  return { kind: n.kind, title: n.title, body: n.body || '', link: n.link || null, agentId: n.agentId || null };
};

export function activate(ctx) {
  async function post(n) {
    const { url, format } = ctx.settings.get();
    if (!url) throw new Error('set the webhook URL first (Settings → Plugins → Webhook notifications)');
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(format, n)), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`the webhook answered ${r.status}`);
    ctx.store.set('last', { at: Date.now(), title: n.title, kind: n.kind });
    ctx.ui.broadcast('sent', { at: Date.now(), title: n.title });
  }

  // a channel: gets every notification that goes out as a push, filtered by Settings → Notifications
  ctx.notify.channel({ id: 'webhook', label: 'Webhook', send: post });

  // a hook: skipped scheduled runs only reach the page by default; post them too if the setting says so
  ctx.events.on('schedule.run', ({ schedule, phase, reason }) => {
    if (phase === 'skipped' && ctx.settings.get().skipped) return post({ kind: 'usage', title: `⏰ ${schedule.title} · run skipped`, body: reason || '' });
  });

  // a route for the UI: when the last message went out
  ctx.routes.get('last', () => ctx.store.get('last') || null);

  // a tool: lets the swarm chat send the user a message directly
  ctx.mcp.tool({
    name: 'notify_user',
    roles: ['conductor'],
    autoAllow: true,
    description: "Send the user a short message through their webhook (Slack, Discord…). Use it for results they asked to be told about, not for routine progress.",
    schema: { type: 'object', properties: { title: { type: 'string', description: 'one line' }, text: { type: 'string' } }, required: ['text'] },
    run: async ({ title = 'Halay', text }) => { await post({ kind: 'plugin', title, body: text }); return 'sent'; },
  });
}
