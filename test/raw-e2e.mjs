// /raw/<agent> signed file links against a SPARE instance (never the live server); no model calls. Regression test for the
// crash on a 0-byte file (createReadStream end: -1 threw after writeHead, then fail() threw ERR_HTTP_HEADERS_SENT):
//   node test/raw-e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spareHome } from './lib/spare.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-e2e-'));
const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const TOKEN = 'raw-e2e-' + Date.now(), BASE = 'http://127.0.0.1:' + port;
const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: { ...process.env, ...spareHome(scratch), PORT: String(port), HOST: '127.0.0.1', HALAY_DB: path.join(scratch, 'halay.db'), HALAY_TOKEN: TOKEN, PATH: path.join(ROOT, 'test/fake-claude') + ':' + process.env.PATH },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '', exited = false; server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d)); server.on('exit', () => (exited = true));
for (let i = 0; i < 100 && !log.includes('running'); i++) await sleep(100);
if (!log.includes('running')) { console.log(log); throw new Error('spare server did not start'); }
const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + '/api' + p, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const dir = path.join(scratch, 'proj'); fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'empty.txt'), '');
fs.writeFileSync(path.join(dir, 'empty.bin'), '');
fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
let agentId = null;
try {
  agentId = (await api('/agents', 'POST', { cwd: dir, name: 'raw e2e' })).j.id;
  for (const [name, body] of [['empty.txt', ''], ['empty.bin', ''], ['hello.txt', 'hello\n']]) {
    const f = await api(`/agents/${agentId}/fileurl`, 'POST', { path: path.join(dir, name) });
    for (const method of ['GET', 'HEAD']) {
      const r = await fetch(BASE + f.j.url, { method });
      const t = await r.text();
      ok(r.status === 200 && r.headers.get('content-length') === String(body.length) && t === (method === 'GET' ? body : ''), `${method} ${name}: 200, length ${body.length}`);
    }
  }
  const f = await api(`/agents/${agentId}/fileurl`, 'POST', { path: path.join(dir, 'hello.txt') });
  const bad = await fetch(BASE + f.j.url.replace(/sig=\w+/, 'sig=nope'));
  ok(bad.status === 403, 'bad signature is 403');
  await sleep(200);
  ok(!exited, 'server still alive');
} finally {
  if (agentId) await api(`/agents/${agentId}?discard=1`, 'DELETE');
  server.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
