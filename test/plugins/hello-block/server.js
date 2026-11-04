export function activate(ctx) {
  ctx.events.on('agent.finished', ({ agent, result }) => {
    ctx.store.set('finished', (ctx.store.get('finished') || 0) + 1);
    ctx.store.set('lastResult', { agent: agent.id, result });
  });
  for (const e of ['agent.started', 'agent.status', 'agent.event', 'agent.exited'])
    ctx.events.on(e, () => ctx.store.set(e, (ctx.store.get(e) || 0) + 1));
  ctx.routes.get('lifecycle', () => Object.fromEntries(['agent.started', 'agent.status', 'agent.event', 'agent.exited'].map((e) => [e, ctx.store.get(e) || 0])));
  ctx.routes.get('ping', () => ({ pong: ctx.settings.get().greeting }));
  ctx.routes.get('stats', () => ({ finished: ctx.store.get('finished') || 0, last: ctx.store.get('lastResult') || null }));
  ctx.routes.get('agents', async () => (await ctx.agents.list()).length);
  ctx.routes.get('echo/:word', ({ params }) => ({ word: params.word }));
  ctx.mcp.tool({
    name: 'echo', roles: ['agent', 'conductor'], description: 'Echo the text back.',
    schema: { type: 'object', properties: { text: { type: 'string' } } },
    run: ({ text }, caller) => `echo from ${caller.role}: ${text}`,
  });
  if (ctx.agents.start) throw new Error('agents:control was not granted, so ctx.agents.start must not exist');
}
