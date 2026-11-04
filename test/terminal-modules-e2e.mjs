// Web terminals against a SPARE instance with its own database and runs/ (never the live server); no model calls:
//   node test/terminal-e2e.mjs
// Concurrent creates can't go past the 12-terminal limit, and the PTY host survives malformed messages.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spareHome } from './lib/spare.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'term-e2e-'));
const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = 'term-e2e-' + Date.now(), BASE = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, ...spareHome(scratch), PORT: String(port), HOST: '127.0.0.1', HALAY_DB: path.join(scratch, 'halay.db'), HALAY_TOKEN: TOKEN, HALAY_TERMINAL: '1', PATH: path.join(ROOT, 'test/fake-claude') + ':' + process.env.PATH },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 100 && !log.includes('running'); i++) await sleep(100);
const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + '/api' + p, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
let sock = null;
try {
  const st = (await api('/terminals')).j;
  if (!st.available) console.log('SKIP terminal unavailable: ' + st.error);
  else {
    const rs = await Promise.all(Array.from({ length: 15 }, () => api('/terminals', 'POST', { cwd: scratch, cols: 80, rows: 24 })));
    const made = rs.filter((r) => r.status === 200).length;
    ok(made === 12 && rs.filter((r) => r.status === 400).length === 3, `15 concurrent creates make exactly 12 terminals (made ${made})`);
    ok((await api('/terminals')).j.terminals.length === 12, 'the list has 12');

    // malformed messages straight to this spare server's own host socket (computed the way terminal.js does)
    const runs = path.join(scratch, 'runs');
    let sockPath = path.join(runs, 'pty.sock');
    if (Buffer.byteLength(sockPath) > 100) sockPath = path.join(os.tmpdir(), 'swarm-pty-' + crypto.createHash('sha1').update(runs).digest('hex').slice(0, 10) + '.sock');
    const id = rs.find((r) => r.status === 200).j.id;
    sock = net.connect(sockPath);
    await new Promise((r) => sock.once('data', r)); // hello
    for (const m of [{ op: 'input', id, d: 123 }, { op: 'input', id, d: { x: 1 } }, { op: 'resize', id, cols: 'x', rows: null }, { op: 'resize', id, cols: 1e9, rows: -1 }, null, 5, { op: 'create', reqId: 'r', opts: null }])
      sock.write(JSON.stringify(m) + '\n');
    await sleep(500);
    ok((await api('/terminals')).j.terminals.length === 12, 'the host survives malformed messages and keeps every shell');
    for (const t of (await api('/terminals')).j.terminals) await api('/terminals/' + t.id, 'DELETE');
    for (let i = 0; i < 50 && (await api('/terminals')).j.terminals.length; i++) await sleep(100);
    const again = await api('/terminals', 'POST', { cwd: scratch });
    ok(again.status === 200, 'a new terminal can be made after closing them');
    if (again.j.id) await api('/terminals/' + again.j.id, 'DELETE');
  }
} finally {
  sock?.destroy();
  server.kill();
  await sleep(500);
  // the spare host exits by itself a minute after its last terminal closed (all were closed above)
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
