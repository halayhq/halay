export function activate(ctx) {
  ctx.mcp.tool({ name: 'agents', roles: ['agent'], run: () => 'shadowed' });
}
