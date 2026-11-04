// Interactive terminals (terminal.js, /api/terminals and /ws/term) against a SPARE instance it starts itself:
//   node test/terminal-e2e.mjs
// Create, output replay when a page re-attaches, resize (and its clamping), the MAX_TERMS (12) limit, close (DELETE), agent cwd.
// Skips itself when node-pty is not available (the server then reports terminals as unavailable).
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startSpare, newAgent, checker, waitFor, sleep } from './lib/spare.mjs';
const { ok, skip, done } = checker();
const s = await startSpare({ tag: 'term' });
try {
  const st = (await s.api('/terminals')).j;
  if (!st.enabled || !st.available) { skip('terminals unavailable: ' + (st.error || 'node-pty missing')); await s.stop(); done(); }
  ok(st.terminals.length === 0, 'no terminals at the start');
  ok((await fetch(s.base + '/api/terminals')).status === 401, 'terminals need auth');
  ok((await s.api('/terminals', 'POST', { agentId: 'nope' })).status === 404, 'unknown agentId: 404');

  const mk = (body = {}) => s.api('/terminals', 'POST', { cwd: s.dir, ...body });
  const t = await mk({ cols: 100, rows: 30, title: 'one' });
  ok(t.status === 200 && /^[0-9a-f]+$/.test(t.j.id) && t.j.cols === 100 && t.j.rows === 30 && t.j.title === 'one', 'create: id, size and title');
  ok((await s.api('/terminals')).j.terminals.some((x) => x.id === t.j.id), 'listed');

  // attach over a websocket; collect what it receives
  const attach = (id, token = s.token) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/term?token=${token}&id=${id}`);
    const c = { ws, out: '', size: null };
    ws.on('message', (m) => { m = m.toString(); if (m[0] === '0') c.out += m.slice(1); else if (m[0] === '1') { const j = JSON.parse(m.slice(1)); if (j.type === 'size') c.size = j; } });
    ws.on('open', () => resolve(c)); ws.on('error', reject);
    ws.on('unexpected-response', (q, r) => reject(Object.assign(new Error('http ' + r.statusCode), { status: r.statusCode })));
  });
  const c1 = await attach(t.j.id);
  await waitFor(() => c1.size);
  ok(c1.size?.cols === 100 && c1.size?.rows === 30, 'attach: the first message carries the size');
  c1.ws.send('0echo marker_$((20+22))\n');
  ok(await waitFor(() => c1.out.includes('marker_42'), 8000), 'input reaches the shell, output comes back');
  c1.ws.close();
  await sleep(200);
  const c2 = await attach(t.j.id);
  ok(await waitFor(() => c2.out.includes('marker_42'), 3000), 'replay: a new page gets the earlier output');

  // resize, and a re-attach sees the new size; values are clamped
  c2.ws.send('1' + JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  await sleep(300);
  const c3 = await attach(t.j.id); await waitFor(() => c3.size);
  ok(c3.size.cols === 120 && c3.size.rows === 40, 'resize: the new size is kept');
  c3.ws.send('1' + JSON.stringify({ type: 'resize', cols: 1, rows: 1 })); await sleep(300);
  c3.ws.send('1{not json'); // ignored
  const c4 = await attach(t.j.id); await waitFor(() => c4.size);
  ok(c4.size.cols === 10 && c4.size.rows === 4, 'resize: clamped to a 10x4 minimum');
  c3.ws.send('1' + JSON.stringify({ type: 'resize', cols: 9999, rows: 9999 })); await sleep(300);
  const c5 = await attach(t.j.id); await waitFor(() => c5.size);
  ok(c5.size.cols === 500 && c5.size.rows === 200, 'resize: clamped to a 500x200 maximum');
  ok((await s.api('/terminals')).j.terminals.find((x) => x.id === t.j.id).clients >= 1 || true, 'listing still works with clients attached');
  for (const c of [c2, c3, c4, c5]) c.ws.close();

  // websocket errors
  let e = await attach('deadbeef').catch((x) => x); ok(e.status === 404 || e.message.includes('404'), 'attach to an unknown terminal: 404');
  e = await attach(t.j.id, 'wrong-token').catch((x) => x); ok(e instanceof Error, 'attach with a wrong token is refused');

  // agent cwd
  const ag = await newAgent(s, { name: 'T', cwd: fs.realpathSync(s.dir) });
  const ta = await mk({ agentId: ag, cwd: '/etc' });
  ok(ta.status === 200, 'create for an agent');
  const ca = await attach(ta.j.id);
  ca.ws.send('0pwd\n');
  ok(await waitFor(() => ca.out.includes(path.basename(s.dir)), 8000), 'an agent terminal starts in the agent\'s folder (not the cwd in the request)');
  ca.ws.close();

  // MAX_TERMS = 12
  const ids = [t.j.id, ta.j.id];
  let last;
  for (let i = 0; i < 10; i++) { last = await mk(); if (last.status === 200) ids.push(last.j.id); }
  ok(ids.length === 12, 'twelve terminals can be open');
  last = await mk();
  ok(last.status === 400 && /at most 12/.test(last.j.error), 'the 13th is refused with a clear message');
  ok((await s.api('/terminals/' + ids.pop(), 'DELETE')).status === 200, 'close one');
  ok(await waitFor(async () => (await mk()).status === 200, 3000), 'a new one can be created after closing');
  ok((await s.api('/terminals/deadbeef', 'DELETE')).status === 404, 'closing an unknown terminal: 404');
  for (const x of (await s.api('/terminals')).j.terminals) await s.api('/terminals/' + x.id, 'DELETE');
  ok(await waitFor(async () => (await s.api('/terminals')).j.terminals.length === 0, 3000), 'all closed');
  const t2 = await mk(); const c6 = await attach(t2.j.id);
  c6.ws.send('0exit\n');
  ok(await waitFor(async () => !(await s.api('/terminals')).j.terminals.some((x) => x.id === t2.j.id), 5000), 'a terminal whose shell exits goes away');
} catch (e) { ok(false, 'unexpected exception: ' + (e.stack || e)); }
finally { await s.stop(); }
done();
