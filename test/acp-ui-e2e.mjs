// The web UI with a second agent CLI installed (the fake ACP agent as `opencode`): the new-agent form's Agent CLI
// picker (accounts, modes, effort, lean and models follow it), and an OpenCode agent's header and list row (badge,
// modes it lacks disabled, no effort or Remote Control). Skips without Chrome.
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, startSpare, checker, waitFor, chromeAvailable } from './lib/spare.mjs';

const c = checker(), ok = c.ok;
if (!(await chromeAvailable())) { c.skip('Chrome is not available'); c.done(); }
const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
process.env.PATH = path.join(ROOT, 'test/fake-acp') + path.delimiter + process.env.PATH;
const s = await startSpare({ tag: 'acpui', env: { HALAY_TERMINAL: '0', HALAY_BACKENDS: 'claude,opencode' } }); // the fake also answers as gemini and cursor-agent
const web = s.base.replace('127.0.0.1', 'localhost'); // the browser uses localhost (a page at 127.0.0.1 is redirected there, which makes every goto a full reload)
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // sign in through the context's cookie jar: loading the login page first races its own redirect with the next goto (ERR_ABORTED)
  await page.context().request.post(web + '/auth/token', { data: { token: s.token } });
  await page.goto(web + '/?r=1');
  await page.waitForSelector('#new');

  // ---- new-agent form
  await page.click('#new');
  await page.waitForSelector('#dlg[open]');
  await waitFor(() => page.evaluate(() => $('#nbackend').options.length > 1), 5000);
  const form = () => page.evaluate(() => ({
    pickerShown: !$('#nbackrow').hidden, backends: [...$('#nbackend').options].map((o) => o.value), backend: $('#nbackend').value,
    accts: [...$('#acct').options].map((o) => o.value), autoOff: $('#mode').querySelector('[value=auto]').disabled, mode: $('#mode').value,
    effortShown: !$('#neffrow').hidden, leanShown: !$('#leanrow').hidden, models: [...$('#nmodel').options].map((o) => o.value), sum: $('#noptsum').textContent,
  }));
  // the options sit in a collapsed section on the form's second step: pick through the select's change event
  const pick = (v) => page.evaluate((v) => { $('#nbackend').value = v; $('#nbackend').dispatchEvent(new Event('change')); }, v);
  let f = await form();
  ok(f.pickerShown && f.backends.join() === 'claude,opencode' && f.backend === 'claude', 'the Agent CLI picker offers Claude Code and OpenCode, Claude first: ' + JSON.stringify(f.backends));
  ok(!f.accts.includes('opencode') && f.accts.includes('claude') && !f.autoOff && f.effortShown && f.leanShown && f.models.includes('opus'), 'with Claude: Claude accounts, every mode, effort, lean and Claude models');
  await pick('opencode');
  await waitFor(async () => (await form()).models.includes('opencode/other'), 5000);
  f = await form();
  ok(f.accts.join() === 'opencode', 'with OpenCode: only its account');
  ok(f.autoOff && f.mode !== 'auto', 'auto mode is disabled and not selected: ' + f.mode);
  ok(!f.effortShown && !f.leanShown, 'effort and lean are hidden');
  ok(f.models.includes('opencode/big-pickle') && !f.models.includes('opus'), "the model picker lists OpenCode's models");
  ok(f.sum.startsWith('OpenCode'), 'the options summary names the CLI: ' + f.sum);
  // a model the list lacks: "Other…" asks for its id
  await page.evaluate(() => { $('#nmodel').value = '__other__'; $('#nmodel').dispatchEvent(new Event('change')); });
  await page.waitForSelector('dialog.ask[open] input');
  await page.fill('dialog.ask[open] input', 'opencode/custom-x');
  await page.click('dialog.ask[open] .yes');
  ok(await waitFor(() => page.evaluate(() => $('#nmodel').value === 'opencode/custom-x'), 3000), '"Other…" takes a typed model id');
  await pick('claude');
  await waitFor(async () => (await form()).models.includes('opus'), 3000);
  f = await form();
  ok(f.accts.includes('claude') && !f.autoOff && f.models.includes('opus'), 'back to Claude: its accounts, modes and models again');
  await page.keyboard.press('Escape');

  // ---- an OpenCode agent's header and list row
  const id = (await s.api('/agents', 'POST', { cwd: s.dir, name: 'oc ui', backend: 'opencode' })).j.id;
  await page.goto(web + '/?r=1#/a/' + id);
  await page.waitForSelector('#head .hacct');
  await waitFor(() => page.evaluate(() => $('#pm').querySelector('[value=auto]').disabled), 5000);
  const h = await page.evaluate((id) => ({
    acct: $('#head .hacct').textContent, autoOff: $('#pm').querySelector('[value=auto]').disabled, manualOn: !$('#pm').querySelector('[value=manual]').disabled,
    effortHidden: $('#heffw').hidden, rcHidden: $('#rc').hidden, badge: [...document.querySelectorAll('.botbadge')].map((b) => b.textContent),
  }), id);
  ok(h.acct.startsWith('opencode'), 'the header names the account: ' + h.acct);
  ok(h.autoOff && h.manualOn, "the header's mode picker disables auto, keeps manual");
  ok(h.effortHidden && h.rcHidden, 'no effort picker and no Remote Control for OpenCode');
  ok(h.badge.includes('OpenCode'), 'the list row has an OpenCode badge: ' + JSON.stringify(h.badge));
  // ---- Settings → Agent defaults: a block per installed CLI besides Claude, and the new-agent form uses it
  await page.evaluate(() => loadSettingsExtras());
  const ad = await page.evaluate(() => [...$('#adother').children].map((w) => ({ cli: w.dataset.cli, modes: [...w.querySelector('[data-f=permissionMode]').options].map((o) => o.value), effortShown: !w.querySelector('[data-f=effort]').closest('label').hidden })));
  ok(ad.length === 1 && ad[0].cli === 'opencode' && !ad[0].modes.includes('auto') && ad[0].modes.includes('manual') && !ad[0].effortShown, 'one defaults block for OpenCode, without auto and without effort: ' + JSON.stringify(ad));
  await page.evaluate(() => { const w = $('#adother').firstChild; w.querySelector('[data-f=permissionMode]').value = 'acceptEdits'; return saveSettingsExtras(); });
  ok((await s.api('/settings/agents')).j.perBackend?.opencode?.permissionMode === 'acceptEdits', 'saving the form stores the OpenCode default');
  await page.evaluate(() => openNew());
  await waitFor(() => page.evaluate(() => $('#dlg').open), 3000);
  await pick('opencode');
  ok((await form()).mode === 'acceptEdits', "the new-agent form preselects OpenCode's default mode");
  await page.evaluate(() => { $('#dlg').close(); });
  await s.api('/settings/agents', 'PUT', { perBackend: { opencode: { permissionMode: 'manual' } } });
  ok(!errors.length, 'no page errors: ' + errors.join(' | '));
} catch (e) {
  ok(false, 'ui test crashed: ' + e.stack);
} finally {
  await browser.close();
  await s.stop();
}
c.done();
