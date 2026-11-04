// Routing check of the web UI against a SPARE instance (never the live server); makes no model calls. With no BASE it starts
// its own instance on a free port with a throwaway database and the fake CLI first in PATH:
//   node test/routes-e2e.mjs
// or against an instance you started (fake CLI first in PATH, see test/models-e2e.mjs):
//   BASE=http://127.0.0.1:4793 TOKEN=t node test/routes-e2e.mjs
// Needs playwright-core and Chrome. Covers:
//  - no two classic scripts in index.html declare the same global function or var (they share one global scope, so a later
//    script silently replaces the earlier one's function: editor.js's showTab once took over the Tasks panel's tab switch)
//  - every hash route opens its own dialog and only that one, without page errors
//  - the Tasks panel's Schedules tab after the editor has been opened (it used to jump to #/a/<id>/edit)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spareHome } from './lib/spare.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
let BASE = process.env.BASE, TOKEN = process.env.TOKEN, server = null;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-e2e-'));

// 1. global function / var names: V8 creates them on the global object before a script runs, so they are listed even
// when the script then throws on its first DOM access in this bare context
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const owner = {}, dups = [], quiet = () => {}; // quiet: main.js starts async and rejects in this bare context
process.on('unhandledRejection', quiet);
for (const [, src] of html.matchAll(/<script src="\/js\/([^"]+)"><\/script>/g)) {
  const ctx = vm.createContext({});
  const before = new Set(vm.runInContext('Object.getOwnPropertyNames(globalThis)', ctx));
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js', src), 'utf8'), ctx, { filename: src }); } catch {}
  for (const k of vm.runInContext('Object.getOwnPropertyNames(globalThis)', ctx)) {
    if (before.has(k)) continue;
    if (owner[k]) dups.push(`${k} (${owner[k]} and ${src})`);
    owner[k] = src;
  }
}
ok(!dups.length, `${Object.keys(owner).length} global functions/vars, each declared by one script` + (dups.length ? '; twice: ' + dups.join(', ') : ''));
await sleep(50);
process.off('unhandledRejection', quiet);

if (!BASE) {
  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  TOKEN = 'routes-e2e-' + Date.now();
  BASE = 'http://127.0.0.1:' + port;
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, ...spareHome(scratch), PORT: String(port), HOST: '127.0.0.1', HALAY_DB: path.join(scratch, 'halay.db'), HALAY_TOKEN: TOKEN, FAKE_CLAUDE_USAGE: '1', PATH: path.join(ROOT, 'test/fake-claude') + ':' + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100 && !log.includes('running'); i++) await sleep(100);
  if (!log.includes('running')) { console.log(log); throw new Error('spare server did not start'); }
}

const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + '/api' + p, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let agentId = null;
try {
  const dir = path.join(scratch, 'repo');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'x.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
  const r = await api('/agents', 'POST', { cwd: dir, name: 'routes e2e' });
  agentId = r.j.id;
  ok(r.status === 201 && agentId, 'agent created');

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // sign in through the context's cookie jar: loading the login page first races its own redirect with the next goto (ERR_ABORTED)
  await page.context().request.post(BASE.replace('127.0.0.1', 'localhost') + '/auth/token', { data: { token: TOKEN } });
  await page.goto(BASE.replace('127.0.0.1', 'localhost') + '/?r=1#/');
  await page.waitForSelector('#side');
  await page.waitForFunction((id) => document.querySelector(`[data-id="${id}"]`) || window.agents?.[id], agentId, { timeout: 10000 }).catch(() => {});

  const DIALOGS = ['#tdlg', '#adlg', '#sdlg', '#udlg', '#rmdlg', '#botdlg', '#hdlg', '#dlg', '#fdlg', '#gdlg', '#xdlg', '#edlg', '#bdlg'];
  const openDialogs = () => page.evaluate((ds) => ds.filter((d) => document.querySelector(d)?.open), DIALOGS);
  async function visit(hash, dlg, timeout = 10000) {
    errors.length = 0;
    await page.evaluate((h) => { location.hash = h; }, hash);
    const opened = dlg ? await page.waitForFunction((d) => document.querySelector(d)?.open, dlg, { timeout }).then(() => true, () => false) : true;
    // settle: the previous dialog closes only after the new route's opener finished loading (can take a while after Monaco loaded)
    await page.waitForFunction(([ds, want]) => ds.filter((d) => document.querySelector(d)?.open).join() === want, [DIALOGS, dlg || ''], { timeout: 5000 }).catch(() => {});
    await sleep(150);
    const now = await page.evaluate(() => location.hash), open = await openDialogs();
    ok(opened && open.join() === (dlg || '') && now.startsWith(hash), `${hash} -> ${dlg || 'no dialog'} (open: ${open.join() || 'none'}, hash ${now})`);
    ok(!errors.length, `${hash} without page errors` + (errors.length ? ': ' + errors.join(' | ') : ''));
  }

  // 2. each route opens its own dialog
  const a = '#/a/' + agentId;
  await visit(a, null);
  ok(await page.evaluate(() => document.body.classList.contains('open')), 'agent route opens the chat');
  // ids are unique in the live DOM with the chat open (a second #ubody once made the chat header's usage popover render into the Usage dialog)
  const dupIds = await page.evaluate(() => { const seen = new Set(), dups = new Set(); for (const e of document.querySelectorAll('[id]')) { if (seen.has(e.id)) dups.add(e.id); seen.add(e.id); } return [...dups]; });
  ok(!dupIds.length, 'no duplicate element ids with the chat open' + (dupIds.length ? ': ' + dupIds.join(', ') : ''));
  // markdown from agents is untrusted: no style blocks or attributes, no forms, inputs only as disabled checkboxes
  const md = await page.evaluate(() => renderMd('hi <style>body{display:none}</style><div style="position:fixed;inset:0">x</div><form action="https://e.example"><input name="p" type="password"><button>Allow</button></form><img src=x onerror="alert(1)">\n\n- [x] done'));
  ok(!/<style|style=|<form|<button|type="password"|onerror/i.test(md) && /<input[^>]*type="checkbox"/.test(md) && /disabled/.test(md), 'renderMd drops style, forms and handlers, keeps task checkboxes: ' + md.slice(0, 300));
  await visit(a + '/edit/x.js', '#edlg', 40000); // also loads Monaco, which the Schedules check below depends on
  ok(await page.waitForFunction(() => window.monaco?.editor && document.querySelector('#ecode .view-lines'), null, { timeout: 30000 }).then(() => true, () => false), 'editor shows x.js');
  for (const [h, d] of [['#/tasks', '#tdlg'], ['#/bots', '#botdlg'], ['#/rooms', '#rmdlg'], ['#/settings', '#sdlg'], ['#/approvals', '#adlg'], ['#/usage', '#udlg'],
    ['#/history', '#hdlg'], ['#/new', '#dlg'], [a + '/files', '#fdlg'], [a + '/file/README.md', '#fdlg'], [a + '/git', '#gdlg'], ['#/term', '#xdlg'], [a + '/edit', '#edlg'], ['#/', null]])
    await visit(h, d);

  // 2b. the conductor can't be removed: the API refuses and the chat header menu has no Remove
  const cr = await api('/conductor', 'POST');
  const cid = cr.j.id || cr.j.agent?.id;
  ok(!!cid, 'conductor started');
  if (cid) {
    const dr = await api('/agents/' + cid, 'DELETE');
    ok(dr.status === 403 && /cannot be removed/.test(dr.j.error || ''), 'DELETE conductor refused: ' + dr.status);
    ok((await api('/agents/' + cid)).status === 200, 'conductor still exists');
    await visit('#/a/' + cid, null);
    ok(await page.waitForFunction(() => document.querySelector('#del')?.hidden === true, null, { timeout: 5000 }).then(() => true, () => false), 'conductor chat has no Remove');
    await visit('#/', null);
  }

  // 3. Tasks panel tabs, with the editor loaded in this page
  await visit('#/tasks', '#tdlg');
  errors.length = 0;
  await page.click('#ttabs');
  await sleep(500);
  ok(await page.evaluate(() => !document.querySelector('#tpanes').hidden && document.querySelector('#tpaneb').hidden && document.querySelector('#ttabs').classList.contains('on')), 'Schedules tab shows the schedules');
  ok(await page.evaluate(() => location.hash) === '#/tasks' && (await openDialogs()).join() === '#tdlg', 'Schedules tab stays on #/tasks (no jump to the editor)');
  await page.click('#ttabb');
  await sleep(300);
  ok(await page.evaluate(() => !document.querySelector('#tpaneb').hidden && document.querySelector('#tpanes').hidden), 'Tasks tab shows the tasks again');
  ok(!errors.length, 'tab switching without page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await page.evaluate(() => localStorage.removeItem('swarm-ttab'));

  // 4. the Assign… panel of a queued task opens without page errors (it once threw: append() returns undefined, so
  // `sel2.append(option).value = ''` failed), and assigning to an idle agent / to a new agent works
  const t1 = await api('/tasks', 'POST', { title: 'assign to idle', prompt: 'do the first thing', cwd: dir });
  const t2 = await api('/tasks', 'POST', { title: 'assign to new', prompt: 'do the second thing', cwd: dir });
  ok(t1.status === 201 && t2.status === 201, 'two queued tasks created');
  await visit('#/tasks', '#tdlg');
  const assignBtn = (title) => page.locator('#tpaneb > *, #tlist > *').filter({ hasText: title }).getByRole('button', { name: 'Assign…' }).first();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Assign…'), null, { timeout: 10000 });
  errors.length = 0;
  await assignBtn('assign to idle').click();
  const opts = await page.waitForSelector('.assign select', { timeout: 5000 }).then(() => page.$$eval('.assign select option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })))).catch(() => []);
  ok(opts.length >= 2 && opts[0].v === '' && /^New agent in /.test(opts[0].t) && opts.some((o) => o.v === agentId), 'Assign panel lists "New agent" first and the idle agent: ' + JSON.stringify(opts));
  ok(!errors.length, 'opening the Assign panel without page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await page.selectOption('.assign select', agentId);
  await page.click('.assign button.primary');
  ok(await page.waitForFunction((id) => location.hash === '#/a/' + id, agentId, { timeout: 10000 }).then(() => true, () => false), 'assigning to the idle agent opens that agent');
  const g1 = (await api('/tasks/' + t1.j.id)).j;
  ok(g1.agentId === agentId && ['running', 'done'].includes(g1.status), `task 1 runs on the idle agent (${g1.status}, ${g1.agentId})`);
  await page.waitForFunction(() => document.body.classList.contains('open'), null, { timeout: 10000 }); // the agent's chat is open
  await sleep(500); // let the agent's status events (the fake CLI finishes at once) arrive before navigating away
  await visit('#/tasks', '#tdlg');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Assign…'), null, { timeout: 10000 });
  await assignBtn('assign to new').click();
  await page.waitForSelector('.assign select', { timeout: 5000 });
  await page.click('.assign button.primary'); // default choice: a new agent
  ok(await page.waitForFunction((id) => /^#\/a\/./.test(location.hash) && location.hash !== '#/a/' + id, agentId, { timeout: 10000 }).then(() => true, () => false), 'assigning with the default choice opens a new agent');
  const g2 = (await api('/tasks/' + t2.j.id)).j;
  ok(g2.agentId && g2.agentId !== agentId && ['running', 'done'].includes(g2.status), `task 2 runs on a new agent (${g2.status}, ${g2.agentId})`);
  ok(!errors.length, 'assigning without page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  if (g2.agentId) {
    await api('/agents/' + g2.agentId, 'DELETE').catch(() => {});
    // the page is on that agent's chat: its removal event sends the page back to #/ . Wait for that, or it can overtake the next visit
    await page.waitForFunction((id) => location.hash !== '#/a/' + id, g2.agentId, { timeout: 10000 }).catch(() => {});
    await sleep(300);
  }

  // 5. the chat header's usage chip opens a popover with the agent's usage, and the global Usage dialog's body is a different element
  await visit('#/a/' + agentId, null);
  const chip = await page.waitForFunction(() => { const b = document.querySelector('#ubtn'); return b && !b.hidden && b.textContent; }, null, { timeout: 10000 }).then((h) => h.jsonValue(), () => '');
  ok(/turn/.test(chip), 'usage chip shows turns: ' + chip);
  if (chip) {
    await page.click('#ubtn');
    const pop = await page.waitForFunction(() => document.querySelector('#upbody')?.textContent.includes('Total tokens') && document.querySelector('#upbody').textContent, null, { timeout: 5000 }).then((h) => h.jsonValue(), () => '');
    ok(!!pop, 'usage popover has content: ' + pop.slice(0, 80));
    ok(await page.evaluate(() => document.querySelectorAll('#ubody').length === 1 && !document.querySelector('#upop #ubody') && !document.querySelector('#ubody').textContent.includes('Total tokens')), "the Usage dialog's #ubody is untouched by the popover");
    await page.keyboard.press('Escape');
  }
  await visit('#/usage', '#udlg');
  ok(await page.waitForFunction(() => document.querySelector('#ubody')?.children.length > 0, null, { timeout: 10000 }).then(() => true, () => false), 'Usage dialog still renders its body');
} catch (e) {
  ok(false, 'unexpected error: ' + (e.stack || e));
} finally {
  await browser.close();
  if (agentId) await api('/agents/' + agentId, 'DELETE').catch(() => {});
  if (server) server.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
