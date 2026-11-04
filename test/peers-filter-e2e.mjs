// The peers proxy filter (peers.js ALLOWED list and the 1 MB body limit) against two SPARE instances it starts itself:
//   node test/peers-filter-e2e.mjs      (peers-e2e.mjs covers the conductor tools through the proxy)
// A calls B through /api/peers/b/<api path>: only agents, tasks, sessions, accounts, limits, instance and stats are
// forwarded; everything else (rooms, bots, settings, terminals, plugins, auth, schedules, peers) is 403, also with
// lookalike and traversal paths; a body over 1,000,000 bytes is 413 and never reaches B.
import http from 'node:http';
import { startSpare, checker } from './lib/spare.mjs';
const { ok, done } = checker();
const A = await startSpare({ tag: 'peerA' }), B = await startSpare({ tag: 'peerB' });
// a request with a literal path (fetch would normalise ../)
const raw = (s, method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: s.port, method, path: p, headers: { authorization: 'Bearer ' + s.token, 'content-type': 'application/json', ...headers } }, (res) => {
    let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => { let j = {}; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, j, text: t }); });
  });
  req.on('error', reject); req.end(body);
});
try {
  await A.api('/peers', 'PUT', { self: 'a' }); await B.api('/peers', 'PUT', { self: 'b' });
  ok((await A.api('/peers/b', 'PUT', { url: B.base, token: B.token })).status === 200, 'A knows B');
  const via = (p, method = 'GET', body) => raw(A, method, '/api/peers/b' + p, body);

  // allowed
  for (const p of ['/agents', '/tasks', '/sessions', '/accounts', '/limits', '/instance', '/stats']) {
    const r = await via(p);
    ok(r.status !== 403 && r.status !== 502 && r.status < 500, `allowed: ${p} is forwarded (${r.status})`);
  }
  ok((await via('/instance')).j.name === 'b', 'the forwarded answer is B\'s');

  // refused
  for (const p of ['/rooms', '/rooms/1', '/bots', '/bots/x/file?name=BOT.md', '/settings/notify', '/terminals', '/plugins', '/plugins/ntfy/settings', '/auth/passkeys', '/peers', '/peers/a/agents', '/schedules', '/uploads', '/server', '/browser/status', '/conductor', '/git/probe', '/']) {
    const r = await via(p);
    ok(r.status === 403, `refused: ${p} is 403 (${r.status})`);
  }
  // lookalikes and traversal: none may reach rooms / settings on B
  for (const p of ['/agentsx', '/agents-secret', '/tasksfoo', '/Agents', '//rooms', '/%2e%2e/rooms', '/agents/../rooms', '/agents/%2e%2e/rooms', '/agents%2f..%2frooms', '/agents/..%2f..%2fsettings/notify']) {
    const r = await via(p);
    const leaked = r.status === 200 && (Array.isArray(r.j) ? r.j.some((x) => x && 'budget' in x) : 'vapid' in r.j || 'channels' in r.j);
    ok(!leaked && r.status !== 502, `lookalike/traversal ${p} does not reach another endpoint (${r.status})`);
  }
  ok((await via('/agents/../rooms')).status === 403 || (await via('/agents/../rooms')).status === 404, 'a literal ../ path to rooms is not served');
  // methods through an allowed prefix still only touch that prefix
  ok((await via('/agents', 'DELETE')).status !== 200, 'DELETE /agents (collection) does nothing');

  // body limit
  const big = JSON.stringify({ title: 't', prompt: 'x'.repeat(1_100_000) });
  ok((await via('/tasks', 'POST', big)).status === 413, 'a body over 1 MB is 413');
  ok((await B.api('/tasks')).j.length === 0, '… and never reached B');
  // the 413 must reach the client every time: the proxy once left its read loop early, which destroyed the socket mid-upload (ECONNRESET about 1 in 25)
  let lost = 0;
  for (let i = 0; i < 40; i++) { try { if ((await via('/tasks', 'POST', big)).status !== 413) lost++; } catch { lost++; } }
  ok(lost === 0, `40 more oversized bodies all get a 413 (${lost} reset or wrong)`);
  const mid = JSON.stringify({ title: 'mid', prompt: 'x'.repeat(900_000) });
  const r = await via('/tasks', 'POST', mid);
  ok(r.status !== 413 && r.status < 500, `a 900 KB body goes through (${r.status})`);
  ok((await via('/tasks', 'POST', JSON.stringify({ title: 'small', prompt: 'p' }))).status < 300 && (await B.api('/tasks')).j.some((t) => t.title === 'small'), 'a small POST is forwarded and creates the task on B');
  ok((await B.api('/tasks')).j.find((t) => t.title === 'small')?.addedBy === 'peer:a', 'B marks it as added by peer:a');

  // auth and unknown peers
  ok((await fetch(A.base + '/api/peers/b/agents')).status === 401, 'the proxy needs A\'s token');
  ok([404, 400].includes((await via('/agents').then(() => raw(A, 'GET', '/api/peers/nope/agents'))).status), 'an unknown peer name is a clean 4xx');
  ok((await raw(A, 'GET', '/api/peers/b/agents', undefined, { 'x-halay-peer': 'c' })).status === 403, 'a peer-marked call cannot use A\'s peers (no chains)');
} catch (e) { ok(false, 'unexpected exception: ' + (e.stack || e)); }
finally { await A.stop(); await B.stop(); }
done();
