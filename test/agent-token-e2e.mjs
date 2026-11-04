// Agents' own tokens (auth.js agentToken): each agent's swarm MCP server gets a token that names that agent instead of the
// access token. The server takes the caller from the token (a spoofed x-halay-agent changes nothing), opens only the
// routes swarm tools use, lets a regular agent act only on the agents it started, and refuses everything else: terminals,
// approvals, modes, settings, accounts, plugins, peers' setup, files, restarts, passkeys and websockets.
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startSpare, checker, newAgent, waitFor, agentToken } from './lib/spare.mjs';

const c = checker();
const s = await startSpare({ tag: 'agenttok', env: { HALAY_TERMINAL: '0', HALAY_BACKENDS: 'claude' } });
const as = (tok) => async (p, method = 'GET', body, headers = {}) => {
  const r = await fetch(s.base + p, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
};
const wsStatus = (url) => new Promise((r) => { const w = new WebSocket(url); w.on('open', () => { w.close(); r('open'); }); w.on('error', () => {}); w.on('unexpected-response', (_, res) => r(res.statusCode)); });
try {
  // the token an agent really gets: in its MCP config, not the access token
  const A = await newAgent(s, { name: 'Ann', prompt: 'hi', permissionMode: 'manual' });
  const B = await newAgent(s, { name: 'Ben', permissionMode: 'manual' });
  const cfgFile = path.join(s.dir, 'runs', A + '.mcp.json');
  await waitFor(() => fs.existsSync(cfgFile), 5000);
  const given = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).mcpServers.swarm.env.HALAY_TOKEN;
  c.ok(given === agentToken(s, A) && given !== s.token, "an agent's MCP server gets its own token, not the access token");
  const ann = as(given);

  // what swarm tools use works, as that agent
  let r = await ann('/api/agents', 'POST', { cwd: s.dir, name: 'Ann child' });
  c.ok(r.status === 201 && r.j.parentId === A && r.j.permissionMode === 'manual', 'it starts an agent, which is always its child: ' + r.status);
  const kid = r.j.id;
  r = await ann('/api/agents', 'POST', { cwd: s.dir, name: 'x', permissionMode: 'bypassPermissions' });
  c.ok(r.status === 400, 'with no say in the parent: a more permissive child is refused');
  r = await ann('/api/agents');
  c.ok(r.status === 200 && r.j.map((a) => a.id).sort().join() === [A, kid].sort().join(), 'it lists itself and its children only');
  c.ok((await ann(`/api/agents/${kid}?tail=1`)).status === 200 && (await ann(`/api/agents/${kid}/send`, 'POST', { text: 'go' })).status === 200, 'it reads and messages its child');
  r = await ann('/api/schedules', 'POST', { title: 't', cron: '0 9 * * *', cwd: s.dir });
  c.ok(r.status === 201 && r.j.createdBy === A, 'it adds a schedule, as itself');

  // ... and only as itself: a spoofed x-halay-agent (another agent, the conductor) changes nothing
  const con = (await s.api('/conductor', 'POST', {})).j;
  r = await ann(`/api/agents/${B}/send`, 'POST', { text: 'hi' }, { 'x-halay-agent': con.id });
  c.ok(r.status === 403, "it cannot message an agent it didn't start, even claiming to be the conductor: " + r.status);
  r = await ann(`/api/agents/${B}`, 'DELETE');
  c.ok(r.status === 403 && !!(await s.api('/agents/' + B)).j.id, 'nor remove one');
  c.ok((await ann(`/api/agents/${kid}?discard=1`, 'DELETE')).status === 403, "nor discard its own child's files (the user's call)");
  c.ok((await ann('/api/tasks', 'GET', undefined, { 'x-halay-agent': con.id })).status === 403, "nor use the conductor's tools (tasks)");
  c.ok((await ann(`/api/agents/${A}/send`, 'POST', { text: 'loop' })).status === 403, 'nor drive itself');

  // the rest of the API is closed to it
  for (const [method, p, body] of [
    ['POST', '/api/terminals', { cwd: s.dir }], ['GET', '/api/approvals'], ['POST', `/api/agents/${A}/permission`, { reqId: 'x', decision: 'allow' }],
    ['POST', `/api/agents/${A}/mode`, { permissionMode: 'bypassPermissions' }], ['PUT', '/api/settings/agents', { permissionMode: 'bypassPermissions' }],
    ['POST', '/api/accounts', { backend: 'claude', name: 'evil' }], ['GET', '/api/plugins'], ['PUT', '/api/peers/x', { url: 'http://x', token: 't' }],
    ['POST', '/api/server/restart'], ['GET', '/api/auth/passkeys'], ['POST', `/api/agents/${A}/fileurl`, { path: 'a' }], ['GET', `/api/agents/${A}/edit/list`],
    ['POST', '/api/conductor', {}], ['GET', '/api/fs'], ['PUT', '/api/conductor/prompt', { text: 'x' }],
  ]) {
    r = await ann(p, method, body);
    c.ok(r.status === 403, `${method} ${p} is refused to an agent's token: ${r.status}`);
  }
  r = await s.api('/settings/agents');
  c.ok(r.j.permissionMode !== 'bypassPermissions', 'and nothing changed');

  // internal calls speak for the token's agent only
  r = await ann('/internal/permission', 'POST', { agentId: B, tool_name: 'Bash', input: { command: 'id' } });
  c.ok(r.status === 403, "it cannot put a permission request in another agent's name");
  // websockets: the UI's feed, terminals and the browser viewer
  const W = s.base.replace('http', 'ws');
  c.ok(await wsStatus(`${W}/ws?token=${given}`) === 401 && await wsStatus(`${W}/ws/term?token=${given}&id=x`) === 401, 'no websocket opens with it');

  // the conductor's token opens the conductor's tools
  const conTok = as(agentToken(s, con.id));
  c.ok((await conTok('/api/tasks')).status === 200 && (await conTok('/api/accounts')).status === 200 && (await conTok(`/api/agents/${B}?tail=1`)).status === 200, "the conductor's token reads tasks, accounts and any agent");
  r = await s.api('/bots', 'POST', { name: 'Tok bot', handle: 'tokbot', role: 'r' });
  c.ok(r.status === 201 && (await conTok('/api/bots/tokbot')).status === 200 && (await conTok('/api/bots/tokbot/pause', 'POST')).status === 200, "the conductor's token reads and pauses a bot");
  c.ok((await conTok('/api/bots/tokbot/file?name=BOT.md', 'PUT', { content: 'x' })).status === 403 && (await conTok('/api/bots/settings', 'PUT', {})).status === 403, "but can't rewrite its files or the bot settings");
  c.ok((await conTok('/api/settings/agents', 'PUT', {})).status === 403 && (await conTok('/api/terminals', 'POST', {})).status === 403, 'but not settings or terminals');

  // forged, malformed and stale tokens
  c.ok((await as(given.slice(0, -2) + 'xx')('/api/agents')).status === 401, 'a forged token -> 401');
  c.ok((await as(`swa.${B}.${given.split('.')[2]}`)('/api/agents')).status === 401, "another agent's id with this mac -> 401");
  await s.api('/agents/' + kid + '?discard=1', 'DELETE');
  c.ok((await as(agentToken(s, kid))('/api/agents')).status === 401, 'the token of a removed agent -> 401');
  // the access token still works as before (the UI, scripts, plugins, peers; agents started before this change)
  c.ok((await s.api('/settings/agents')).status === 200, 'the access token is unchanged');
} catch (e) {
  c.ok(false, 'crashed: ' + e.stack);
  console.log(s.log().slice(-3000));
} finally {
  await s.stop();
}
c.done();
