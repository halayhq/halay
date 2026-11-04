// A throwaway halay instance with demo data, for bin/make-screenshots.mjs and bin/make-demos.mjs. Own port, database, HOME,
// data folder and TMPDIR, all under /tmp/demo (short neutral paths: the swarm chat's folder is in the data folder and
// shows in its header), test/fake-claude-demo first in PATH (no real agent CLI or account is used), the Machines plugin off
// (it shows this computer's name). Never touches a running server. Demo project folders go to /tmp/demo-projects.
import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process'; import net from 'node:net';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
export const WT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const { chromium } = createRequire(WT + '/package.json')('playwright-core');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const PROJ = '/tmp/demo-projects';
const ROOT = '/tmp/demo', MARK = '.halay-demo';

// a folder we may wipe: missing, or made by us (has the marker)
const ours = (d) => !fs.existsSync(d) || fs.existsSync(path.join(d, MARK));
function fresh(d) {
  if (!ours(d)) throw new Error(`${d} exists and was not made by this script; remove it yourself`);
  fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, MARK), '');
}

// start(): { base, token, api(path, method, body), signIn(page), stop() }. extraEnv goes to the server (and so to the fake CLI).
export async function start({ extraEnv = {}, projects = ['api-server', 'web-shop', 'docs-site'] } = {}) {
  fresh(ROOT); fresh(PROJ);
  for (const d of projects) fs.mkdirSync(path.join(PROJ, d), { recursive: true });
  const home = ROOT + '/home', tmp = ROOT + '/tmp'; fs.mkdirSync(home); fs.mkdirSync(tmp);
  // node on PATH without the folder it lives in, so no agent CLI installed on this machine is found (only the fake claude)
  fs.mkdirSync(ROOT + '/bin'); fs.symlinkSync(process.execPath, ROOT + '/bin/node');
  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const token = 'demo-' + Date.now(), base = 'http://127.0.0.1:' + port;
  // a clean environment, not ours: nothing from this machine's shell (public URLs, accounts, tokens) reaches the instance
  const env = { LANG: 'en_US.UTF-8', TZ: 'UTC', HOME: home, ZDOTDIR: home, USER: 'demo', LOGNAME: 'demo', TMPDIR: tmp, TMP: tmp, TEMP: tmp, HALAY_HOME: home + '/.halay', PORT: String(port), HOST: '127.0.0.1', HALAY_DB: ROOT + '/halay.db', HALAY_TOKEN: token, HALAY_TERMINAL: '0', PATH: [path.join(WT, 'test/fake-claude-demo'), ROOT + '/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter), ...extraEnv };
  const srv = spawn(process.execPath, [WT + '/src/server.js'], { cwd: WT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 150 && !log.includes('running'); i++) await sleep(100);
  if (!log.includes('running')) { console.log(log); srv.kill('SIGKILL'); throw new Error('server did not start'); }
  const api = async (p, method = 'GET', body) => (await fetch(base + '/api' + p, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json().catch(() => ({}));
  await api('/plugins/machines/disable', 'POST');
  // first run: the login page asks to confirm the token (prefilled from ?token=); sign in with the token, not a passkey
  const signIn = async (page) => {
    await page.goto(base + '/?token=' + token);
    if (await page.isVisible('#tokform').catch(() => false)) {
      await page.click(await page.isVisible('#alt') ? '#alt' : '#main');
      await page.waitForSelector('#side', { timeout: 10000 });
    }
  };
  const stop = async () => {
    srv.kill('SIGTERM'); await sleep(1500); if (srv.exitCode === null) srv.kill('SIGKILL');
    fs.rmSync(ROOT, { recursive: true, force: true }); fs.rmSync(PROJ, { recursive: true, force: true });
  };
  return { base, token, api, signIn, stop, log: () => log };
}
