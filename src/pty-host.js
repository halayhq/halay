// PTY host: owns the web terminals' shells so they survive server restarts, the way agents do (they run detached).
// terminal.js starts it detached (its own session) for the first terminal and talks to it over a Unix socket (mode 600)
// with JSON lines; a restarted server connects again and gets every terminal back with its scrollback. It exits a
// minute after its last terminal ends, so a new version of this file is picked up then. Input and output are never logged.
//   node src/pty-host.js <socket path>
//
// server → host: {op:'create', reqId, opts:{shell, args, cwd, cols, rows, env, title, agentId}}, {op:'input', id, d},
//                {op:'resize', id, cols, rows}, {op:'kill', id}
// host → server: {op:'hello', v, pid, terms:[{…meta, buf}]} on connect, {op:'created', reqId, term}, {op:'error', reqId, error},
//                {op:'data', id, d}, {op:'exit', id, code, signal}
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { trimScrollback } from './util.js'; // output kept per terminal for reattaching

const VERSION = 1; // bump with protocol changes (terminal.js HOST_VERSION)
const require = createRequire(import.meta.url);
const SOCK = process.argv[2];
const log = (s) => console.log(`[pty-host ${new Date().toISOString()}] ${s}`);
const pty = require('node-pty');

const terms = new Map(); // id -> { id, title, cwd, agentId, cols, rows, createdAt, pty, buf }
const conns = new Set();
const meta = (t) => ({ id: t.id, title: t.title, cwd: t.cwd, agentId: t.agentId, pid: t.pty.pid, cols: t.cols, rows: t.rows, createdAt: t.createdAt });
const line = (m) => JSON.stringify(m) + '\n';
const send = (c, m) => { if (!c.destroyed) c.write(line(m)); };
const all = (m) => { const s = line(m); for (const c of conns) if (!c.destroyed) c.write(s); };

let idle = null;
function checkIdle() {
  clearTimeout(idle);
  if (!terms.size) idle = setTimeout(() => { log('no terminals for a minute, exiting'); quit(); }, 60000);
}
function quit() {
  for (const t of terms.values()) try { t.pty.kill('SIGHUP'); } catch {}
  try { fs.unlinkSync(SOCK); } catch {}
  process.exit(0);
}

function create(o) {
  const p = pty.spawn(o.shell, o.args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env });
  const t = { id: crypto.randomBytes(6).toString('hex'), title: o.title, cwd: o.cwd, agentId: o.agentId || null, cols: o.cols, rows: o.rows, createdAt: Date.now(), pty: p, buf: '' };
  p.onData((d) => {
    t.buf = trimScrollback(t.buf + d);
    all({ op: 'data', id: t.id, d });
  });
  p.onExit(({ exitCode, signal }) => {
    terms.delete(t.id);
    all({ op: 'exit', id: t.id, code: exitCode, signal });
    checkIdle();
  });
  terms.set(t.id, t);
  clearTimeout(idle);
  return t;
}

const dim = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
function handle(c, m) {
  if (!m || typeof m !== 'object') return;
  const t = terms.get(m.id);
  if (m.op === 'create') {
    try { all({ op: 'created', reqId: m.reqId, term: meta(create(m.opts)) }); }
    catch (e) { send(c, { op: 'error', reqId: m.reqId, error: e.message }); }
  } else if (m.op === 'input') { if (t && typeof m.d === 'string') t.pty.write(m.d); }
  else if (m.op === 'resize' && t && dim(m.cols, 1, 1000) && dim(m.rows, 1, 1000)) { t.cols = m.cols; t.rows = m.rows; try { t.pty.resize(m.cols, m.rows); } catch {} }
  else if (m.op === 'kill' && t) {
    try { t.pty.kill('SIGHUP'); } catch {}
    setTimeout(() => { if (terms.has(t.id)) try { process.kill(t.pty.pid, 'SIGKILL'); } catch {} }, 3000).unref(); // a shell that ignores SIGHUP still goes
  }
}

const server = net.createServer((c) => {
  conns.add(c);
  c.setEncoding('utf8');
  send(c, { op: 'hello', v: VERSION, pid: process.pid, terms: [...terms.values()].map((t) => ({ ...meta(t), buf: t.buf })) });
  let acc = '';
  c.on('data', (chunk) => {
    acc += chunk;
    for (let i; (i = acc.indexOf('\n')) >= 0;) {
      const s = acc.slice(0, i); acc = acc.slice(i + 1);
      let m; try { m = JSON.parse(s); } catch { continue; }
      try { handle(c, m); } catch (e) { log(`bad ${m?.op} message: ${e.message}`); }
    }
  });
  c.on('close', () => conns.delete(c));
  c.on('error', () => {});
});

// one host per socket: a live one answers, a stale socket file (host killed) is replaced
fs.mkdirSync(path.dirname(SOCK), { recursive: true });
process.umask(0o077); // the socket is created mode 600: only this user can drive the shells
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') { log(e.message); process.exit(1); }
  net.connect(SOCK).on('connect', () => { log('another host is already running'); process.exit(0); })
    .on('error', () => { try { fs.unlinkSync(SOCK); } catch {} server.listen(SOCK); });
});
server.listen(SOCK, () => { fs.chmodSync(SOCK, 0o600); log(`listening on ${SOCK} (pid ${process.pid})`); checkIdle(); });
for (const sig of ['SIGHUP', 'SIGINT']) process.on(sig, () => {}); // detached; only SIGTERM (or the last terminal ending) stops it
process.on('SIGTERM', quit);
// one bad message or a failing pty must not take every shell down with the host
process.on('uncaughtException', (e) => log(`uncaught: ${e.stack || e.message}`));
