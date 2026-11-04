// Shared helpers for the test suite: start a SPARE swarm instance (never the live server): a free port, a throwaway
// database in a temp folder, the fake claude CLI first in PATH (no model calls), its own access token and its own HOME
// (<dir>/home, unless the test passes env.HOME): the user's Claude accounts (shell aliases, ~/.claude) and transcripts,
// and the other CLIs' data in HOME, are never seen or written by a test.
//   const s = await startSpare({ tag: 'rooms', env: { HALAY_TERMINAL: '0' } });
//   s.base, s.token, s.dir, s.db, s.log(), await s.api('/rooms', 'POST', {...}) -> { status, j, text }, await s.stop()
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
export const waitFor = async (f, ms = 5000, step = 100) => { for (let t = Date.now(); Date.now() - t < ms; await sleep(step)) { const v = await f(); if (v) return v; } return null; };

// ok(cond, message) prints PASS/FAIL lines in the format the runner counts; check.fails is the failure count
export function checker() {
  const c = { fails: 0, passes: 0, skips: 0, xfails: 0 };
  c.ok = (cond, m) => { console.log((cond ? 'PASS ' : 'FAIL ') + m); if (cond) c.passes++; else c.fails++; };
  // a check for a known bug that is being fixed: counts as a failure only with HALAY_TEST_PENDING=fail (printed XFAIL otherwise)
  c.pending = (cond, m) => { if (cond) return c.ok(true, m + ' (pending fix: now passing)'); if (process.env.HALAY_TEST_PENDING === 'fail') return c.ok(false, m + ' (pending fix)'); console.log('XFAIL ' + m + ' (pending fix)'); c.xfails++; };
  c.skip = (m) => { console.log('SKIP ' + m); c.skips++; };
  c.done = () => { console.log(`\n${c.passes} passed, ${c.fails} failed${c.skips ? `, ${c.skips} skipped` : ''}${c.xfails ? `, ${c.xfails} expected-failures (pending fix)` : ''}`); process.exit(c.fails ? 1 : 0); };
  return c;
}

// the environment giving a test server a HOME of its own (<dir>/home, or `home`), with an empty ~/.claude and a git
// identity for the server's merges; the Playwright browsers stay found in the real cache. Only the Claude backend (the
// fake claude) unless the test put the fake ACP agents (test/fake-acp) first in PATH: else the server would run the
// real OpenCode / Cursor / Gemini CLIs installed on the machine (their login checks, in this empty HOME, take ~20 s).
// Spread it after process.env; a test's own HALAY_BACKENDS comes after it.
export function spareHome(dir, home = path.join(dir, 'home')) {
  if (!fs.existsSync(path.join(home, '.claude'))) fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const git = path.join(home, '.gitconfig');
  if (!fs.existsSync(git)) fs.writeFileSync(git, '[user]\n\tname = halay test\n\temail = test@halay.invalid\n');
  const fakeAcp = (process.env.PATH || '').split(path.delimiter).includes(path.join(ROOT, 'test/fake-acp'));
  return { HOME: home, ...(fakeAcp ? {} : { HALAY_BACKENDS: 'claude' }), HALAY_ACCOUNTS_DIR: path.join(home, '.halay-accounts'), PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright') };
}

export async function startSpare({ tag = 'spare', env = {}, token, scratch } = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(scratch || os.tmpdir(), `swarm-${tag}-`));
  const homeEnv = env.HOME ? spareHome(null, env.HOME) : spareHome(dir), home = homeEnv.HOME;
  const s = { port, dir, home, base: 'http://127.0.0.1:' + port, token: token || process.env.HALAY_TEST_TOKEN || `${tag}-${crypto.randomBytes(8).toString('hex')}`, db: path.join(dir, 'halay.db'), claudeLog: path.join(dir, 'claude.log'), _log: '' };
  const launch = async (extra = {}) => {
    s._log = '';
    s.proc = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
      // HALAY_HOME from the caller's environment is dropped: it would take the data dir away from HALAY_DB's folder
      env: { ...process.env, HALAY_HOME: undefined, ...homeEnv, PORT: String(port), HOST: '127.0.0.1', HALAY_DB: s.db, HALAY_TOKEN: s.token, FAKE_CLAUDE_LOG: s.claudeLog, ...env, ...extra, PATH: path.join(ROOT, 'test/fake-claude') + path.delimiter + process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    s.proc.stdout.on('data', (d) => (s._log += d)); s.proc.stderr.on('data', (d) => (s._log += d));
    for (let i = 0; i < 150 && !s._log.includes('running') && s.proc.exitCode === null; i++) await sleep(100);
    if (!s._log.includes('running')) { s.proc.kill(); throw new Error(`spare server ${tag} did not start:\n${s._log}`); }
  };
  s.log = () => s._log;
  // stop the server and start it again on the same port, database and token (extra: env for this start only)
  s.restart = async (extra = {}) => {
    const p = s.proc; p.kill('SIGTERM');
    for (let i = 0; i < 50 && p.exitCode === null; i++) await sleep(100);
    if (p.exitCode === null) p.kill('SIGKILL');
    await launch(extra);
  };
  await launch();
  s.headers = (extra = {}) => ({ authorization: 'Bearer ' + s.token, 'content-type': 'application/json', ...extra });
  s.api = async (p, method = 'GET', body, headers = {}) => {
    const r = await fetch(s.base + '/api' + p, { method, headers: s.headers(headers), body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = {}; }
    return { status: r.status, j, text };
  };
  s.stop = async () => {
    // the data dir is this folder (HALAY_DB's folder, home.js): agents' tmp/<id> and bots/<handle> go with it below
    if (s.proc.exitCode === null) { s.proc.kill('SIGTERM'); for (let i = 0; i < 30 && s.proc.exitCode === null; i++) await sleep(100); if (s.proc.exitCode === null) s.proc.kill('SIGKILL'); }
    try { execFileSync('pkill', ['-f', dir]); } catch {} // helpers the server leaves behind (terminal host, agents' processes)
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return s;
}

// a new agent that only logs (fake claude); returns its id
export async function newAgent(s, body = {}) {
  const r = await s.api('/agents', 'POST', { cwd: body.cwd || s.dir, name: 'a', ...body });
  if (r.status >= 300) throw new Error('agent start failed: ' + r.text);
  return r.j.id;
}

// is a real browser usable for the playwright tests?
export async function chromeAvailable() {
  try {
    const { createRequire } = await import('node:module');
    const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
    const b = await chromium.launch({ channel: 'chrome', headless: true });
    await b.close();
    return true;
  } catch { return false; }
}

// the token an agent's swarm MCP server gets (auth.js agentToken): it speaks for that agent only
export const agentToken = (s, id) => `swa.${id}.${crypto.createHmac('sha256', crypto.createHash('sha256').update('swarm-agent-token\0' + s.token).digest()).update(String(id)).digest('base64url')}`;
