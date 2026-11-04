// Accounts added in the swarm (Settings → Accounts), without shell aliases: adding one per CLI (its own folder, set
// through the CLI's variable; Claude's sharing the main account's history; Cursor refused, its login is per user),
// the login command, agents running with the account's environment, persistence across a restart, keeping an alias
// account in the swarm so its alias can go, and removing (refused while agents use it). The server runs with a home
// of its own, so the user's aliases and folders are not touched. The Settings form is checked when Chrome is there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { ROOT, startSpare, checker, waitFor, chromeAvailable } from './lib/spare.mjs';

const c = checker(), ok = c.ok;
process.env.PATH = path.join(ROOT, 'test/fake-acp') + path.delimiter + process.env.PATH;
const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'acct-home-'));
const root = path.join(home, 'accts'), LOG = path.join(home, 'acp.log'), ENVLOG = path.join(home, 'env.log');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
const s = await startSpare({ tag: 'accts', env: { HOME: home, HALAY_ACCOUNTS_DIR: root, HALAY_TERMINAL: '0', HALAY_BACKENDS: 'claude,opencode,gemini,cursor', FAKE_ACP_LOG: LOG, FAKE_CLAUDE_ENVLOG: ENVLOG } });
const accts = async () => (await s.api('/accounts')).j;
const acct = async (n) => (await accts()).find((a) => a.name === n);
const log = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

try {
  ok((await acct('claude'))?.source === 'cli' && (await acct('opencode'))?.source === 'cli', "the CLIs' own accounts are listed as such");

  // ---- adding
  const add = (body) => s.api('/accounts', 'POST', body);
  const r1 = await add({ backend: 'claude', name: 'claude-work' });
  const dir1 = path.join(root, 'claude-work');
  ok(r1.status === 201 && r1.j.source === 'swarm' && r1.j.dir === dir1 && r1.j.env.join() === 'CLAUDE_CONFIG_DIR', 'a Claude account is added with a folder of its own: ' + r1.text.slice(0, 200));
  ok(fs.realpathSync(path.join(dir1, 'projects')) === fs.realpathSync(path.join(home, '.claude', 'projects')), "it shares the main account's history and memory");
  ok(r1.j.fix === `CLAUDE_CONFIG_DIR=${JSON.stringify(dir1)} claude   # then /login`, 'its login command: ' + r1.j.fix);
  const r2 = await add({ backend: 'opencode', name: 'oc-2', dir: '~/oc2' });
  ok(r2.status === 201 && r2.j.dir === path.join(home, 'oc2') && r2.j.env.join() === 'XDG_DATA_HOME' && /^XDG_DATA_HOME=".*oc2" opencode auth login$/.test(r2.j.fix), 'an OpenCode account in a folder picked by the user: ' + r2.j.fix);
  // the login command is typed into a terminal: a folder name with shell syntax in it must stay a name
  const marker = path.join(home, 'pwned'), evil = path.join(home, `x$(touch ${marker})\`touch ${marker}\`'q`);
  const re = await add({ backend: 'claude', name: 'claude-odd', dir: evil });
  let printed = '';
  try { printed = execFileSync('zsh', ['-fc', re.j.fix.replace(/ claude {3}# then \/login$/, ' printenv CLAUDE_CONFIG_DIR')], { encoding: 'utf8' }).trim(); } catch (e) { printed = 'ERR ' + e.message; }
  ok(re.status === 201 && !fs.existsSync(marker) && printed === evil, `a folder named with $(…), backticks and a quote is quoted, not run: ${re.j.fix} -> ${printed}`);
  await s.api('/accounts/claude-odd', 'DELETE');
  const r3 = await add({ backend: 'gemini', name: 'gem-2' });
  ok(r3.status === 201 && r3.j.env.join() === 'GEMINI_CLI_HOME' && r3.j.loggedIn === null, 'a Gemini account, not logged in yet');
  const r4 = await add({ backend: 'claude', name: 'claude-x', shareHistory: false });
  ok(r4.status === 201 && !fs.existsSync(path.join(root, 'claude-x', 'projects')), 'history sharing can be left out');
  ok((await add({ backend: 'cursor', name: 'cur-2' })).j.error?.includes('keychain'), "Cursor can't get a second account (its login is per user)");
  ok((await add({ backend: 'claude', name: 'claude-work' })).status === 409, 'a name in use is refused');
  ok((await add({ backend: 'claude', name: 'bad name' })).status === 400 && (await add({ backend: 'claude', name: 'y', dir: 'rel/dir' })).status === 400, 'a bad name or a relative folder is refused');
  ok((await add({ backend: 'claude', name: 'claude-dup', dir: dir1 })).status === 409, 'a folder another account uses is refused');
  const bks = (await s.api('/backends')).j;
  ok(bks.find((b) => b.id === 'claude').accounts.includes('claude-work') && /keychain/.test(bks.find((b) => b.id === 'cursor').addAccounts), 'the pickers list the new account; Cursor says why it takes none');

  // ---- agents run with the account's environment
  const a1 = await s.api('/agents', 'POST', { cwd: home, name: 'w', account: 'claude-work', prompt: 'hi' });
  ok(a1.status === 201, 'an agent starts on the new account');
  ok(await waitFor(() => { try { return fs.readFileSync(ENVLOG, 'utf8').includes(`CLAUDE_CONFIG_DIR=${dir1}`); } catch { return false; } }, 8000), 'claude runs with its config folder');
  const a2 = await s.api('/agents', 'POST', { cwd: home, name: 'o', account: 'oc-2', prompt: 'hi' });
  ok(a2.status === 201 && await waitFor(() => log().some((r) => r.start?.name === 'opencode' && r.start.xdgData === path.join(home, 'oc2')), 8000), 'OpenCode runs with its data folder');

  // ---- kept across a restart; aliases
  fs.writeFileSync(path.join(home, '.zshrc'), `alias claude-alt='CLAUDE_CONFIG_DIR="$HOME/.claude-alt" claude'\n`);
  await s.restart();
  ok((await acct('claude-work'))?.source === 'swarm' && (await acct('gem-2'))?.dir === path.join(root, 'gem-2'), 'added accounts are kept across a restart');
  ok((await acct('claude-alt'))?.source === 'alias', 'an alias account is listed as such');
  ok((await s.api('/accounts/claude-alt/save', 'POST')).j.source === 'swarm', 'it can be kept in the swarm');
  fs.writeFileSync(path.join(home, '.zshrc'), '');
  await s.restart();
  const alt = await acct('claude-alt');
  ok(alt?.source === 'swarm' && alt.fix.includes(path.join(home, '.claude-alt')), 'and stays after its alias is gone');
  ok((await s.api('/accounts/claude/save', 'POST')).status === 400, "a CLI's own account has nothing to keep");

  // ---- removing
  const del = (n) => s.api(`/accounts/${n}`, 'DELETE');
  const d1 = await del('claude-work');
  ok(d1.status === 409 && /agents use it: w/.test(d1.j.error), 'an account agents use is not removed: ' + d1.j.error);
  await s.api(`/agents/${a1.j.id}`, 'DELETE');
  ok((await del('claude-work')).status === 200 && !(await acct('claude-work')) && fs.existsSync(dir1), 'once unused it is removed; its folder stays');
  ok((await del('claude')).status === 400 && (await del('nope')).status === 404, "a CLI's own account can't be removed; an unknown one 404s");

  // ---- the Settings form
  if (await chromeAvailable()) {
    const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      // sign in through the context's cookie jar: loading the login page first races its own redirect with the next goto (ERR_ABORTED)
      await page.context().request.post(s.base.replace('127.0.0.1', 'localhost') + '/auth/token', { data: { token: s.token } });
      await page.goto(s.base.replace('127.0.0.1', 'localhost') + '/?r=1');
      await page.waitForFunction(() => typeof loadAccounts === 'function');
      await page.evaluate(() => { $('#sdlg').showModal(); loadAccounts(); $('#aadd').open = true; });
      await page.waitForSelector('#aaback option[value=claude]', { state: 'attached' });
      ok(await page.$eval('#aaback option[value=cursor]', (o) => o.disabled), 'the form offers no Cursor account');
      await page.selectOption('#aaback', 'gemini');
      ok(await page.$eval('#aasharel', (l) => l.hidden), 'history sharing is offered for Claude only');
      await page.fill('#aaname', 'gem-ui');
      await page.click('#aago');
      await page.waitForSelector('#acctlist .pkrow:has-text("gem-ui")', { state: 'attached' });
      const row = await page.$eval('#acctlist .pkrow:has-text("gem-ui")', (r) => r.innerText);
      ok(/added here/.test(row) && /Remove/.test(row), 'the new account is listed with its folder and a Remove button: ' + row.replace(/\n/g, ' | '));
      ok(/Keep here/.test(await page.$eval('#acctlist .pkrow:has-text("claude-alt")', (r) => r.innerText)) === false, 'a kept account has no Keep button');
      ok(!errors.length, 'no page errors: ' + errors.join(' | '));
    } finally { await browser.close(); }
  } else console.log('  (Chrome not available: the Settings form is not checked)');
} catch (e) {
  ok(false, 'accounts test crashed: ' + e.stack);
} finally {
  if (c.fails) console.log(s.log().slice(-3000));
  await s.stop();
  fs.rmSync(home, { recursive: true, force: true });
}
c.done();
