// swarm-mcp.js retries against a fake swarm server (no real server, no model calls):
//   node test/mcp-retry-e2e.mjs
// A POST whose response is cut off is not repeated (it may have been delivered: a restart must not add a task twice),
// a GET cut off the same way is repeated, and a POST is repeated while nothing listens yet (connection refused).
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const port = await freePort();
const hits = [];
let cut = 0; // cut off this many responses (socket destroyed after the request arrived)
const handler = (req, res) => {
  let b = ''; req.on('data', (d) => (b += d));
  req.on('end', () => {
    hits.push(`${req.method} ${req.url}`);
    if (cut > 0) { cut--; return req.socket.destroy(); }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tasks' && req.method === 'POST') return res.end(JSON.stringify({ id: 7, dependsOn: [] }));
    if (req.url.startsWith('/api/tasks/7')) return res.end(JSON.stringify({ id: 7, title: 't', status: 'queued', dependsOn: [] }));
    res.statusCode = 404; res.end('{"error":"nope"}');
  });
};
let srv = http.createServer(handler).listen(port, '127.0.0.1');

const mcp = spawn(process.execPath, [path.join(ROOT, 'src', 'swarm-mcp.js')], {
  env: { ...process.env, HALAY_URL: 'http://127.0.0.1:' + port, HALAY_TOKEN: 't', HALAY_AGENT: 'a1', HALAY_ROLE: 'conductor' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const waiting = new Map(); let nextId = 1;
readline.createInterface({ input: mcp.stdout }).on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
const call = (name, args) => new Promise((r) => { const id = nextId++; waiting.set(id, r); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); });

try {
  cut = 1; hits.length = 0;
  let m = await call('add_task', { title: 't' });
  ok(m.result?.isError && hits.filter((h) => h === 'POST /api/tasks').length === 1, 'cut-off POST is not repeated');
  ok(/check whether it took effect/.test(m.result?.content?.[0]?.text), 'and the error says to check before retrying');

  cut = 1; hits.length = 0;
  m = await call('get_task', { task_id: 7 });
  ok(!m.result?.isError && hits.filter((h) => h === 'GET /api/tasks/7').length === 2, 'cut-off GET is repeated');

  await new Promise((r) => srv.close(r)); srv.closeAllConnections?.();
  hits.length = 0;
  const p = call('add_task', { title: 't' });
  await sleep(1500);
  srv = http.createServer(handler).listen(port, '127.0.0.1');
  m = await p;
  ok(!m.result?.isError && hits.filter((h) => h === 'POST /api/tasks').length === 1, 'POST retried while the server is down (connection refused), delivered once');
} finally {
  mcp.kill(); srv.close();
}
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
