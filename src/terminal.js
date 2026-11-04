// Interactive terminals: a login shell in a PTY (node-pty), streamed to xterm.js over a WebSocket (/ws/term).
// The shells live in a separate detached process (pty-host.js), so like agents they survive server restarts: on startup
// the server reconnects to the host and gets every terminal back with its scrollback. Sessions also outlive their
// sockets: output is replayed when a page (re)attaches. A terminal ends when its shell exits or it is closed (DELETE);
// HALAY_KILL_AGENTS=1 ends them with the server too. HALAY_TERMINAL=0 turns all of it off. Input and output are never logged.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import { trimScrollback, env } from './util.js'; // the host keeps the same scrollback; this copy is what pages are replayed from

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENABLED = !/^(0|false|off|no)$/i.test(env('TERMINAL') || '');
const MAX_TERMS = 12;
const HOST_VERSION = 1; // pty-host.js VERSION

// node-pty is native; if it is missing or doesn't load, the rest of the app keeps working and the UI says why.
// The host loads it to run the shells; it is loaded here too to report that early and to fix the prebuild below.
let pty = null, loadError = '';
if (ENABLED) {
  try {
    pty = require('node-pty');
    // the macOS prebuilds ship spawn-helper without the exec bit, which fails every spawn with "posix_spawnp failed"
    const dir = path.dirname(require.resolve('node-pty/package.json'));
    for (const d of ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release']) {
      const h = path.join(dir, d, 'spawn-helper');
      try { if (!(fs.statSync(h).mode & 0o111)) fs.chmodSync(h, 0o755); } catch {}
    }
  } catch (e) { loadError = e.message.split('\n')[0]; }
}

const terms = new Map(); // id -> { id, title, cwd, agentId, pid, cols, rows, createdAt, buf, clients }
let onChange = () => {};
export const termsAvailable = () => !!pty;

export const termSummary = (t) => ({ id: t.id, title: t.title, cwd: t.cwd, agentId: t.agentId, pid: t.pid, cols: t.cols, rows: t.rows, createdAt: t.createdAt, attached: t.clients.size });
export const listTerms = () => [...terms.values()].map(termSummary);
export const termStatus = () => ({ enabled: ENABLED, available: !!pty, error: ENABLED ? loadError : 'turned off with HALAY_TERMINAL=0', terminals: pty ? listTerms() : [] });

const clamp = (n, lo, hi, d) => (Number.isFinite(+n) ? Math.min(Math.max(Math.round(+n), lo), hi) : d);
const send = (ws, s) => { if (ws.readyState === 1) ws.send(s); };

// ---- the host connection
let SOCK = '', HOST_LOG = '', host = null, connecting = null, ready = Promise.resolve(), creating = 0;
const pending = new Map(); // reqId -> { resolve, reject }
const toHost = (m) => { if (host && !host.destroyed) host.write(JSON.stringify(m) + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// runs: the server's runs/ folder (the socket and the host's log live there). Reconnects to a host left by the last run.
export function initTerms({ runs }) {
  SOCK = path.join(runs, 'pty.sock');
  // Unix socket paths are limited to ~104 bytes; fall back to a fixed name in the temp folder
  if (Buffer.byteLength(SOCK) > 100) SOCK = path.join(os.tmpdir(), 'swarm-pty-' + crypto.createHash('sha1').update(runs).digest('hex').slice(0, 10) + '.sock');
  HOST_LOG = path.join(runs, 'pty-host.log');
  if (pty && fs.existsSync(SOCK)) ready = connect(false).catch(() => {});
}

function addTerm(m, buf = '') {
  if (terms.has(m.id)) return terms.get(m.id);
  const t = { ...m, buf, clients: new Set() };
  terms.set(m.id, t);
  return t;
}

function onHostMessage(m) {
  if (m.op === 'data') {
    const t = terms.get(m.id);
    if (!t) return;
    t.buf = trimScrollback(t.buf + m.d);
    for (const ws of t.clients) send(ws, '0' + m.d);
  } else if (m.op === 'exit') endTerm(m.id, { code: m.code, signal: m.signal });
  else if (m.op === 'created') {
    const t = addTerm(m.term);
    onChange();
    pending.get(m.reqId)?.resolve(t); pending.delete(m.reqId);
  } else if (m.op === 'error') { pending.get(m.reqId)?.reject(new Error(m.error)); pending.delete(m.reqId); }
}

function endTerm(id, info) {
  const t = terms.get(id);
  if (!t) return;
  terms.delete(id);
  for (const ws of t.clients) { send(ws, '1' + JSON.stringify({ type: 'exit', ...info })); ws.close(1000); }
  onChange();
}

// resolves once the host's hello (with every live terminal) is in. spawnIt: start a host if none answers.
function connect(spawnIt) {
  return new Promise((resolve, reject) => {
    let tries = 0, spawned = false;
    const attempt = () => {
      const s = net.connect(SOCK);
      let acc = '', hello = false;
      s.setEncoding('utf8');
      s.on('data', (chunk) => {
        acc += chunk;
        for (let i; (i = acc.indexOf('\n')) >= 0;) {
          const line = acc.slice(0, i); acc = acc.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.op === 'hello') {
            hello = true; host = s;
            if (m.v !== HOST_VERSION) console.log(`terminal host speaks version ${m.v}, this server ${HOST_VERSION}; it is replaced once its terminals are closed`);
            for (const t of m.terms) addTerm(t, t.buf);
            onChange();
            resolve();
          } else onHostMessage(m);
        }
      });
      s.on('error', async (e) => {
        if (hello) return;
        if (!spawnIt || !['ENOENT', 'ECONNREFUSED'].includes(e.code) || ++tries > 50) return reject(new Error('terminal host unavailable: ' + e.message));
        if (!spawned) { spawned = true; try { fs.unlinkSync(SOCK); } catch {} startHost(); }
        await sleep(100);
        attempt();
      });
      s.on('close', () => {
        if (!hello || host !== s) return;
        host = null; // the host went away (killed): its shells are gone
        for (const id of [...terms.keys()]) endTerm(id, { code: null, lost: true });
        for (const p of pending.values()) p.reject(new Error('terminal host went away'));
        pending.clear();
      });
    };
    attempt();
  });
}

// detached (own session, like the agents), so it outlives this server; logs only its own start/stop lines
function startHost() {
  const out = fs.openSync(HOST_LOG, 'a');
  spawn(process.execPath, [path.join(HERE, 'pty-host.js'), SOCK], { cwd: os.homedir(), env: process.env, detached: true, stdio: ['ignore', out, out] }).unref();
  fs.closeSync(out);
}
const ensureHost = () => host ? Promise.resolve() : (connecting ||= connect(true).finally(() => { connecting = null; }));

// opts: { cwd, agentId, title, cols, rows }. extraEnv is added to the server's environment.
export async function createTerm(opts, extraEnv = {}) {
  if (!pty) throw Object.assign(new Error(ENABLED ? `terminal unavailable: ${loadError}` : 'the terminal is turned off (HALAY_TERMINAL=0)'), { code: 403 });
  if (terms.size + creating >= MAX_TERMS) throw Object.assign(new Error(`at most ${MAX_TERMS} terminals; close one first`), { code: 400 });
  let cwd = opts.cwd && path.isAbsolute(opts.cwd) ? opts.cwd : os.homedir();
  try { if (!fs.statSync(cwd).isDirectory()) cwd = os.homedir(); } catch { cwd = os.homedir(); }
  const env = { ...process.env, ...extraEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' };
  delete env.DEV; delete env.HALAY_DEV_PID; // the dev runner's flags, not the shell's business
  delete env.HALAY_TOKEN; delete env.HALAY_RESET_PASSKEYS; // the server's credential and a one-time start flag: not for the shell (or an agent started in it)
  creating++; // a slot is held across the awaits below, so concurrent creates can't go past MAX_TERMS
  try { await ensureHost(); return await create(opts, cwd, env); } finally { creating--; }
}
async function create(opts, cwd, env) {
  const reqId = crypto.randomBytes(6).toString('hex');
  let timer;
  const t = new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    timer = setTimeout(() => { if (pending.delete(reqId)) reject(new Error('the terminal host did not answer')); }, 10000);
  }).finally(() => clearTimeout(timer));
  toHost({ op: 'create', reqId, opts: {
    shell: process.env.SHELL || os.userInfo().shell || '/bin/zsh', args: ['-l'], cwd, env,
    cols: clamp(opts.cols, 10, 500, 80), rows: clamp(opts.rows, 4, 200, 24), agentId: opts.agentId || null,
    title: String(opts.title || path.basename(cwd) || cwd).slice(0, 80),
  } });
  const made = await t;
  if (opts.input) toHost({ op: 'input', id: made.id, d: String(opts.input).slice(0, 500) }); // typed at the prompt, not run: the user presses Enter
  return made;
}

export function killTerm(id) {
  if (!terms.has(id)) return false;
  toHost({ op: 'kill', id });
  return true;
}
export const killAllTerms = () => { for (const id of terms.keys()) killTerm(id); };

// ---- WebSocket: /ws/term?token=…&id=…  (auth is checked by the caller before handing the upgrade over)
// Frames are text with a one-character tag. Server → page: '0'+output, '1'+JSON control ({type:'exit'|'size'}).
// Page → server: '0'+input, '1'+JSON {type:'resize', cols, rows}.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true, zlibDeflateOptions: { level: 3 } } });
export async function termUpgrade(req, socket, head, url) {
  await ready; // just restarted: the host's terminals may still be coming in
  const t = pty && terms.get(url.searchParams.get('id') || '');
  if (!t) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => {
    send(ws, '1' + JSON.stringify({ type: 'size', cols: t.cols, rows: t.rows }));
    if (t.buf) send(ws, '0' + t.buf);
    t.clients.add(ws);
    onChange();
    ws.on('message', (m) => {
      const s = m.toString();
      if (s[0] === '0') toHost({ op: 'input', id: t.id, d: s.slice(1) });
      else if (s[0] === '1') {
        let j; try { j = JSON.parse(s.slice(1)); } catch { return; }
        if (j.type === 'resize') {
          const cols = clamp(j.cols, 10, 500, t.cols), rows = clamp(j.rows, 4, 200, t.rows);
          if (cols !== t.cols || rows !== t.rows) { t.cols = cols; t.rows = rows; toHost({ op: 'resize', id: t.id, cols, rows }); }
        }
      }
    });
    ws.on('close', () => { t.clients.delete(ws); onChange(); });
  });
}

// REST under /api/terminals. ctx: { json, readBody, agentCwd(id) -> cwd|null, extraEnv }. Returns true if handled.
export async function termApi(req, res, url, ctx) {
  const { json } = ctx;
  await ready;
  if (url.pathname === '/api/terminals') {
    if (req.method === 'GET') return json(res, 200, termStatus()), true;
    if (req.method === 'POST') {
      const b = await ctx.readBody(req);
      let cwd = b.cwd, title = b.title;
      if (b.agentId) {
        cwd = ctx.agentCwd(b.agentId);
        if (!cwd) return json(res, 404, { error: 'no such agent' }), true;
      }
      try { return json(res, 200, termSummary(await createTerm({ cwd, agentId: b.agentId, title, cols: b.cols, rows: b.rows, input: b.input }, ctx.extraEnv))), true; }
      catch (e) { return json(res, e.code || 500, { error: e.message }), true; }
    }
  }
  const m = url.pathname.match(/^\/api\/terminals\/([0-9a-f]+)$/);
  if (m && req.method === 'DELETE') return killTerm(m[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such terminal' }), true;
  return false;
}

export const onTermsChange = (fn) => { onChange = fn; };
