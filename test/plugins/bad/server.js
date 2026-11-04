export function activate(ctx) {
  ctx.routes.get('boom', () => { throw new Error('boom'); });
  ctx.routes.get('reject', async () => { await new Promise((r) => setTimeout(r, 5)); throw new Error('async boom'); });
}
