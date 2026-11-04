// The default account of each backend (Settings → Accounts → Set as default; settings 'default_accounts'): nothing set
// keeps the CLI's own account; a chosen one is what new agents, tasks and the swarm chat get when no account is named;
// a parent agent's account still wins; a wrong backend or unknown account is refused; clearing works; a saved name that
// is gone (or on another backend) falls back to the bare default without breaking anything; removing the account
// drops the choice. Fakes only (fake claude, fake ACP CLIs), a home and database of its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, startSpare, checker, chromeAvailable } from './lib/spare.mjs';

const c = checker(), ok = c.ok;
process.env.PATH = path.join(ROOT, 'test/fake-acp') + path.delimiter + process.env.PATH;
const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'defacct-home-'));
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
const s = await startSpare({ tag: 'defacct', env: { HOME: home, HALAY_HOME: path.join(home, '.halay'), HALAY_ACCOUNTS_DIR: path.join(home, 'accts'), HALAY_TERMINAL: '0', HALAY_BACKENDS: 'claude,opencode' } });
const defaults = async () => (await s.api('/accounts/default')).j;
const setDef = (backend, account) => s.api('/accounts/default', 'PUT', { backend, account });
const start = async (body) => (await s.api('/agents', 'POST', { cwd: home, ...body })).j;
const list = async () => (await s.api('/accounts')).j;

try {
  // ---- nothing set: as before
  let d = await defaults();
  ok(d.claude?.account === 'claude' && d.claude.chosen === false && d.opencode?.account === 'opencode', 'unset: each CLI\'s own account is its default: ' + JSON.stringify(d));
  ok((await s.api('/accounts', 'POST', { backend: 'claude', name: 'claude-work' })).status === 201, 'a second Claude account is added');
  ok((await s.api('/accounts', 'POST', { backend: 'opencode', name: 'oc-2' })).status === 201, 'a second OpenCode account is added');
  ok((await start({ name: 'u0' })).account === 'claude', 'unset: a new agent without an account runs as claude');
  ok((await list()).find((a) => a.name === 'claude')?.default === true && (await list()).find((a) => a.name === 'claude-work')?.default === false, 'GET /accounts marks the default');

  // ---- validation
  const bad1 = await setDef('opencode', 'claude-work');
  ok(bad1.status === 400 && /Claude Code account/.test(bad1.j.error), 'an account of another backend is refused: ' + bad1.j.error);
  const bad2 = await setDef('claude', 'ghost');
  ok(bad2.status === 400 && /unknown account/.test(bad2.j.error), 'an unknown account is refused');
  const bad3 = await setDef('nope', 'claude');
  ok(bad3.status === 400 && /unknown backend/.test(bad3.j.error), 'an unknown backend is refused');
  ok((await setDef('gemini', 'claude')).status === 400, 'a backend turned off (HALAY_BACKENDS) is refused');
  ok((await defaults()).claude.account === 'claude', 'refused requests change nothing');

  // ---- set
  const r = await setDef('claude', 'claude-work');
  ok(r.status === 200 && r.j.claude?.account === 'claude-work' && r.j.claude.chosen === true, 'the Claude default is set: ' + r.text);
  ok((await setDef('opencode', 'oc-2')).status === 200, 'the OpenCode default is set');
  const l = await list();
  ok(l.find((a) => a.name === 'claude-work').default && !l.find((a) => a.name === 'claude').default && l.find((a) => a.name === 'oc-2').default, 'GET /accounts marks the chosen defaults');
  const bks = (await s.api('/backends')).j;
  ok(bks.find((b) => b.id === 'claude').defaultAccount === 'claude-work' && bks.find((b) => b.id === 'opencode').defaultAccount === 'oc-2', '/backends carries each default (the pickers)');
  ok((await start({ name: 'n1' })).account === 'claude-work', 'a new agent without an account gets the chosen default');
  ok((await start({ name: 'n2', backend: 'opencode' })).account === 'oc-2', 'a backend alone gets that backend\'s chosen default');
  ok((await start({ name: 'n3', account: 'claude' })).account === 'claude', 'a named account still wins');

  // ---- parents still decide
  const p = await start({ name: 'parent', account: 'claude' });
  ok((await start({ name: 'kid', parentId: p.id })).account === 'claude', "a child agent inherits its parent's account over the default");
  const po = await start({ name: 'oparent', account: 'opencode' });
  ok((await start({ name: 'okid', parentId: po.id, backend: 'opencode' })).account === 'opencode', 'also on another backend');
  ok((await start({ name: 'xkid', parentId: p.id, backend: 'opencode' })).account === 'oc-2', "a child on another backend than its parent's gets that backend's default");

  // ---- tasks and the swarm chat
  const t = (await s.api('/tasks', 'POST', { title: 'default task', prompt: 'hi', cwd: home })).j;
  const ta = await s.api(`/tasks/${t.id}/assign`, 'POST', {});
  const tAgent = ta.j.agent || (await s.api('/agents')).j.find((a) => a.id === ta.j.agentId);
  ok(ta.status === 200 && tAgent?.account === 'claude-work', 'a task without an account runs on the default: ' + ta.text.slice(0, 200));
  const cond = await s.api('/conductor', 'POST', {});
  ok(cond.status === 200 && cond.j.account === 'claude-work', 'the swarm chat starts on the default when none is saved or sent');
  const bot = await s.api('/bots', 'POST', { name: 'Scout', handle: 'scout', role: 'Look around.' });
  ok(bot.status < 300 && (bot.j.account || bot.j.bot?.account) === 'claude-work', 'a bot made without an account gets the default: ' + bot.text.slice(0, 200));

  // ---- clearing
  const cl = await setDef('opencode', null);
  ok(cl.status === 200 && cl.j.opencode.account === 'opencode' && cl.j.opencode.chosen === false, 'clearing goes back to the bare default');
  ok((await start({ name: 'n4', backend: 'opencode' })).account === 'opencode', 'and new agents get it');

  // ---- a stale saved value falls back silently
  const Database = createRequire(path.join(ROOT, 'package.json'))('better-sqlite3');
  const kill = async () => { s.proc.kill('SIGTERM'); for (let i = 0; i < 50 && s.proc.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100)); };
  await kill();
  { const db = new Database(s.db); db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('default_accounts', JSON.stringify({ claude: 'ghost', opencode: 'claude-work' })); db.close(); }
  await s.restart();
  d = await defaults();
  ok(d.claude.account === 'claude' && !d.claude.chosen && d.opencode.account === 'opencode' && !d.opencode.chosen, 'a deleted or wrong-backend saved default falls back: ' + JSON.stringify(d));
  ok((await start({ name: 'n5' })).account === 'claude' && (await start({ name: 'n6', backend: 'opencode' })).account === 'opencode', 'agents still start, on the bare defaults');
  await kill();
  { const db = new Database(s.db); db.prepare('UPDATE settings SET value=? WHERE key=?').run('not json', 'default_accounts'); db.close(); }
  await s.restart();
  ok((await defaults()).claude?.account === 'claude' && (await start({ name: 'n7' })).account === 'claude', 'a corrupt setting falls back too');

  // ---- removing the default account drops the choice
  ok((await setDef('opencode', 'oc-2')).status === 200, 'oc-2 is the default again');
  for (const a of (await s.api('/agents')).j.filter((x) => x.account === 'oc-2')) await s.api(`/agents/${a.id}`, 'DELETE');
  ok((await s.api('/accounts/oc-2', 'DELETE')).status === 200, 'it is removed');
  d = await defaults();
  ok(d.opencode.account === 'opencode' && !d.opencode.chosen, 'its backend is back on the bare default');
  ok((await s.api('/accounts', 'POST', { backend: 'opencode', name: 'oc-2' })).status === 201 && (await defaults()).opencode.account === 'opencode', 're-adding the name does not make it the default again');

  // ---- Settings → Accounts
  if (await chromeAvailable()) {
    ok((await setDef('claude', 'claude-work')).status === 200, 'claude-work is the default for the UI check');
    const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.context().request.post(s.base.replace('127.0.0.1', 'localhost') + '/auth/token', { data: { token: s.token } });
      await page.goto(s.base.replace('127.0.0.1', 'localhost') + '/?r=1');
      await page.waitForFunction(() => typeof loadAccounts === 'function');
      await page.evaluate(() => { $('#sdlg').showModal(); loadAccounts(); });
      await page.waitForSelector('#acctlist .pkrow:has-text("claude-work")', { state: 'attached' });
      // a row by its account name (the head's first text node, before any badge)
      const row = (n) => page.$$eval('#acctlist .pkrow', (rs, n) => rs.find((r) => r.querySelector('b')?.firstChild?.textContent.endsWith(' ' + n))?.innerText || '', n);
      const work = await row('claude-work'), plain = await row('claude');
      ok(/default for Claude Code/.test(work) && !/Set as default/.test(work), 'the default is marked: ' + work.replace(/\n/g, ' | '));
      ok(/Set as default/.test(plain) && !/default for/.test(plain), 'the others offer Set as default: ' + plain.replace(/\n/g, ' | '));
      // Set as default on claude (the CLI's own account) clears the choice
      await page.$$eval('#acctlist .pkrow', (rs) => [...rs.find((r) => r.querySelector('b')?.firstChild?.textContent.endsWith(' claude'))?.querySelectorAll('button') || []].find((b) => b.textContent === 'Set as default')?.click());
      await page.waitForFunction(() => [...document.querySelectorAll('#acctlist .pkrow')].some((r) => r.querySelector('b')?.firstChild?.textContent.endsWith(' claude') && /default for/.test(r.innerText)));
      d = await defaults();
      ok(d.claude.account === 'claude' && !d.claude.chosen, "Set as default on the CLI's own account clears the choice");
      ok((await setDef('claude', 'claude-work')).status === 200, 'claude-work is the default again');
      await page.evaluate(() => OPENERS.tasks());
      await page.waitForSelector('#sfacct option[value=""]', { state: 'attached' });
      const labels = await page.evaluate(() => [$('#tacct').options[0].textContent, $('#sfacct').options[0].textContent]);
      ok(labels.every((x) => x === 'Default account (claude-work)'), 'the task and schedule forms name the real default: ' + labels.join(' / '));
      ok(!errors.length, 'no page errors: ' + errors.join(' | '));
    } finally { await browser.close(); }
  } else console.log('  (Chrome not available: Settings → Accounts is not checked)');
} catch (e) {
  ok(false, 'default accounts test crashed: ' + e.stack);
} finally {
  if (c.fails) console.log(s.log().slice(-3000));
  await s.stop();
  fs.rmSync(home, { recursive: true, force: true });
}
c.done();
