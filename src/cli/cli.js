// The `halay` command (bin/halay.js): argument parsing and the small commands that talk to a running server.
// The server itself is server.js, imported in-process by `halay start`, so a restart (restart-helper.js) re-launches
// exactly `<node> <bin/halay.js> start …` again.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupHome } from './home.js';
import { installKind } from './install-kind.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // the package folder (src/cli/../..)
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
export const INSTALL_KIND = installKind(ROOT);

export const HELP = `halay ${VERSION}: a web UI to run and control coding agents, one per folder.

Usage:
  halay [start] [--port N] [--host ADDR]   run the server in the foreground (Ctrl-C stops it; agents keep running)
  halay token                              print the sign-in URL (with the access token)
  halay restart                            restart the running server (like Settings → Restart server)
  halay stop                               stop the running server (agents and terminals keep running)
  halay service install|uninstall|status|logs|start|stop [--dry-run] [--port N] [--host ADDR] [-f] [-n LINES]
                                           run it in the background at login (launchd on macOS, systemd --user on
                                           Linux); install again after installing a new agent CLI (PATH)
  halay app [install]                      macOS: open the menu-bar app (status, and the web UI in its own window, already
                                           signed in); install copies it to ~/Applications for Spotlight and Login Items
  halay cert install|status|renew|uninstall [--host NAME|IP ...] [--dry-run]
                                           local HTTPS on HALAY_HTTPS_PORT (4778) with a CA of its own, limited to
                                           this machine's names; tailscale serve is the easier way for phones
  halay --version | --help

Data folder: $HALAY_HOME, else ~/.halay (a git checkout that already holds data keeps using itself).
Settings: environment variables or <data folder>/.env (see .env.example); PORT (4777), HOST (127.0.0.1), HALAY_*.
Docs: https://github.com/halayhq/halay/blob/main/docs/install.md`;

const COMMANDS = {
  start: [], token: [], restart: [], stop: [], help: [], version: [],
  service: ['install', 'uninstall', 'status', 'logs', 'start', 'stop'],
  cert: ['install', 'status', 'renew', 'uninstall'],
  app: ['install'],
};
const SUB_OPTIONAL = new Set(['app']); // `halay app` alone launches it
const VALUE_FLAGS = new Set(['port', 'host', 'lines']);
const BOOL_FLAGS = new Set(['dry-run', 'follow', 'help', 'version']);
const SHORT = { h: 'help', v: 'version', f: 'follow', n: 'lines' };

// argv (after `halay`) -> { cmd, sub, opts: { port, host: [..], 'dry-run', follow, lines }, error }
// --host may repeat (cert install); for start/service only the last one counts.
export function parseArgs(argv) {
  const out = { cmd: null, sub: null, opts: { host: [] }, error: null };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { words.push(...argv.slice(i + 1)); break; }
    let m = a.match(/^--([a-z-]+)(?:=(.*))?$/) || a.match(/^-([a-z])$/);
    if (!m) { words.push(a); continue; }
    const name = a.startsWith('--') ? m[1] : SHORT[m[1]];
    if (!name) return { ...out, error: `unknown option ${a}` };
    if (BOOL_FLAGS.has(name)) { if (m[2] !== undefined) return { ...out, error: `--${name} takes no value` }; out.opts[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) return { ...out, error: `unknown option ${a}` };
    const v = m[2] !== undefined ? m[2] : argv[++i];
    if (v === undefined || v === '') return { ...out, error: `--${name} needs a value` };
    if (name === 'host') out.opts.host.push(v); else out.opts[name] = v;
  }
  if (out.opts.port !== undefined && (!/^\d{1,5}$/.test(out.opts.port) || +out.opts.port < 1 || +out.opts.port > 65535)) return { ...out, error: `--port must be a port number, got ${out.opts.port}` };
  if (out.opts.lines !== undefined && !/^\d+$/.test(out.opts.lines)) return { ...out, error: `--lines must be a number` };
  if (out.opts.help) return { ...out, cmd: 'help' };
  if (out.opts.version) return { ...out, cmd: 'version' };
  const [cmd = 'start', sub, ...extra] = words;
  if (!(cmd in COMMANDS)) return { ...out, error: `unknown command "${cmd}" (see halay --help)` };
  out.cmd = cmd;
  const subs = COMMANDS[cmd];
  if (subs.length) {
    if (!sub && !SUB_OPTIONAL.has(cmd)) return { ...out, error: `halay ${cmd} needs one of: ${subs.join(', ')}` };
    if (sub && !subs.includes(sub)) return { ...out, error: `unknown "halay ${cmd} ${sub}" (one of: ${subs.join(', ')})` };
    out.sub = sub ?? null;
    if (extra.length) return { ...out, error: `unexpected argument ${extra[0]}` };
  } else if (sub !== undefined) return { ...out, error: `unexpected argument ${sub}` };
  if (out.opts.host.length > 1 && cmd !== 'cert') return { ...out, error: '--host given more than once' };
  return out;
}

// The settings a command needs, resolved like the server does (data folder, .env files), without touching process.env.
export function context(env = process.env) {
  const e = { ...env };
  const home = setupHome({ root: ROOT, env: e });
  const port = Number(e.PORT || 4777), host = e.HOST || '127.0.0.1';
  const ctx = { env: e, dataDir: home.dir, reason: home.reason, port, host, pidFile: path.join(home.dir, 'runs', 'server.pid') };
  return withRunning(ctx);
}

// a running server's own port and host (runs/server.json, written when it listens) win over the settings: it may
// have been started with --port, or by a service with its own PORT
export function withRunning(ctx, { readFile = fs.readFileSync, alive = serverPid } = {}) {
  let j; try { j = JSON.parse(readFile(path.join(ctx.dataDir, 'runs', 'server.json'), 'utf8')); } catch { return ctx; }
  if (!j?.port || alive(ctx.pidFile) !== j.pid) return ctx;
  return { ...ctx, port: Number(j.port), host: j.host || ctx.host };
}

// the URL that signs a browser in: http://<host>:<port>/?token=…, plus the HTTPS address when one is set
export function signInUrls(ctx, readFile = fs.readFileSync) {
  const e = ctx.env;
  let token = e.HALAY_TOKEN;
  if (!token) try { token = readFile(path.join(ctx.dataDir, '.token'), 'utf8').trim(); } catch { return { error: `no access token yet in ${ctx.dataDir} (start halay once to create one)` }; }
  // localhost, not 127.0.0.1: a passkey needs a domain name (see server.js)
  const h = ['0.0.0.0', '::', '127.0.0.1', '::1'].includes(ctx.host) ? 'localhost' : ctx.host.includes(':') ? `[${ctx.host}]` : ctx.host;
  const urls = [`http://${h}:${ctx.port}/?token=${token}`];
  const pub = (e.HALAY_PUBLIC_URL ?? '').replace(/\/+$/, '');
  if (/^https:\/\//.test(pub)) urls.push(`${pub}/?token=${token}`);
  return { urls };
}

// the running server's pid from <data folder>/runs/server.pid, only if that process is alive and is a halay server
// (a stale file may name an unrelated process now). -> pid | null
export function serverPid(pidFile, { readFile = fs.readFileSync, ps = psCommand } = {}) {
  let pid; try { pid = Number(readFile(pidFile, 'utf8').trim()); } catch { return null; }
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return null; }
  return /server\.js|halay/.test(ps(pid) || '') ? pid : null;
}
const psCommand = (pid) => { try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { return ''; } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function restartCmd(ctx, log = console.log) {
  const pid = serverPid(ctx.pidFile);
  if (!pid) { log(`no running halay server found (${ctx.pidFile}). Start it with \`halay\` or \`halay service start\`.`); return 1; }
  process.kill(pid, 'SIGUSR2');
  log(`restarting the halay server (pid ${pid}); agents and terminals keep running…`);
  for (const end = Date.now() + 60000; Date.now() < end; await sleep(500)) {
    const now = serverPid(ctx.pidFile);
    if (now && now !== pid && await answers(ctx)) { log(`back up (pid ${now}).`); return 0; }
  }
  log(`not back after 60 s; see ${path.join(ctx.dataDir, 'runs', 'server.log')} (and the service log, if it runs as a service).`);
  return 1;
}

export async function stopCmd(ctx, log = console.log) {
  const pid = serverPid(ctx.pidFile);
  if (!pid) { log(`no running halay server found (${ctx.pidFile}).`); return 1; }
  process.kill(pid, 'SIGTERM');
  for (const end = Date.now() + 10000; Date.now() < end; await sleep(200)) {
    try { process.kill(pid, 0); } catch { log(`stopped (pid ${pid}). Agents and terminals keep running; the next start reattaches them.`); return 0; }
  }
  log(`pid ${pid} is still running after 10 s.`);
  return 1;
}

async function answers(ctx) {
  const h = ctx.host === '0.0.0.0' || ctx.host === '::' ? '127.0.0.1' : ctx.host.includes(':') ? `[${ctx.host}]` : ctx.host;
  try { const r = await fetch(`http://${h}:${ctx.port}/`, { signal: AbortSignal.timeout(2000) }); return r.status < 500; } catch { return false; }
}
