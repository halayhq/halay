// Attachments belong to the agent they were added to. Drops a file onto agent A's chat after other agents' chats were opened
// in the same page (the drop zone, #main, outlives each chat: stale listeners used to upload the file to every agent opened
// before), then checks B's view, B's upload folder and what B is sent, and that A still has the file when you come back.
// Own spare instance (free port, throwaway database); the fake CLI logs what each agent is sent. Skips without Chrome.
//   node test/attach-agents-e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, startSpare, checker, waitFor, newAgent, chromeAvailable } from './lib/spare.mjs';

const c = checker(), ok = c.ok;
if (!(await chromeAvailable())) { c.skip('Chrome is not available'); c.done(); }
const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-e2e-'));
const stdinLog = path.join(scratch, 'stdin.log');
fs.writeFileSync(stdinLog, '');
const s = await startSpare({ tag: 'attach', env: { HALAY_TERMINAL: '0', FAKE_CLAUDE_STDINLOG: stdinLog } });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const SECRET = 'secret-for-A.txt', SECRET2 = 'second-for-B.txt';
const uploads = (id) => { try { return fs.readdirSync(path.join(s.dir, 'tmp', id, 'uploads')).filter((n) => !n.startsWith('.part-')); } catch { return []; } };
try {
  const A = await newAgent(s, { name: 'agent A' }), B = await newAgent(s, { name: 'agent B' }), C = await newAgent(s, { name: 'agent C' });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // sign in through the context's cookie jar: loading the login page first races its own redirect with the next goto (ERR_ABORTED)
  await page.context().request.post(s.base.replace('127.0.0.1', 'localhost') + '/auth/token', { data: { token: s.token } });
  await page.goto(s.base.replace('127.0.0.1', 'localhost') + '/?r=1#/');
  await page.waitForSelector('#side');
  const open = async (id) => { await page.evaluate((id) => { location.hash = '#/a/' + id; }, id); await page.waitForFunction((id) => sel === id && document.querySelector('#txt'), id, { timeout: 10000 }); };
  const tray = () => page.evaluate(() => ({ hidden: $('#atray').hidden, chips: [...document.querySelectorAll('#atray .achip .an')].map((e) => e.textContent), ready: !!document.querySelector('#atray .achip.ok') }));
  const drop = (name, body) => page.evaluate(([name, body]) => {
    const dt = new DataTransfer(); dt.items.add(new File([body], name, { type: 'text/plain' }));
    for (const t of ['dragenter', 'dragover', 'drop']) $('#main').dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [name, body]);

  // every chat is opened (and so rendered) before the drop, B and C twice: each render used to leave one more drop listener on #main
  for (const id of [B, C, B, A, C, B]) await open(id);
  await open(A);
  await drop(SECRET, 'private to A');
  ok(await waitFor(async () => (await tray()).ready, 8000), "the file appears as a ready chip in A's composer");
  await new Promise((r) => setTimeout(r, 600)); // time for any stray upload to land
  ok(uploads(A).join() === SECRET, "A's upload folder has the file: " + uploads(A).join());
  ok(!uploads(B).length && !uploads(C).length, `no other agent's upload folder got it (B: ${uploads(B).join() || 'empty'}, C: ${uploads(C).join() || 'empty'})`);
  const lists = await page.evaluate(([A, B, C]) => ({ A: chatAtts[A].length, B: (chatAtts[B] || []).length, C: (chatAtts[C] || []).length }), [A, B, C]);
  ok(lists.A === 1 && lists.B === 0 && lists.C === 0, 'only A has a pending attachment: ' + JSON.stringify(lists));

  // switch to B: nothing shown, and what B is sent has no file
  await open(B);
  let t = await tray();
  ok(t.hidden && !t.chips.length, "B's composer shows no attachment");
  await page.fill('#txt', 'hello from B');
  await page.click('#go');
  ok(await waitFor(() => fs.readFileSync(stdinLog, 'utf8').includes('hello from B'), 8000), 'B was sent its message');
  const sentB = fs.readFileSync(stdinLog, 'utf8');
  ok(!sentB.includes('Attached files') && !sentB.includes(SECRET), "the message to B carries no attachment");

  // a file dropped on B belongs to B only, and A keeps its own
  await drop(SECRET2, 'private to B');
  ok(await waitFor(async () => (await tray()).ready, 8000), 'a file dropped on B shows in B');
  await new Promise((r) => setTimeout(r, 400));
  ok(uploads(B).join() === SECRET2 && uploads(A).join() === SECRET && !uploads(C).length, `folders: A ${uploads(A).join()}, B ${uploads(B).join()}, C ${uploads(C).join() || 'empty'}`);

  // back to A: its chip is still there (draft kept per agent), B's is not; sending from A attaches A's file only
  await open(A);
  t = await tray();
  ok(t.chips.join() === SECRET && t.ready, "back on A: its pending file is still there and only that: " + t.chips.join());
  await open(C);
  t = await tray();
  ok(t.hidden && !t.chips.length, "C shows nothing either");
  await open(A);
  await page.fill('#txt', 'hello from A');
  await page.click('#go');
  const sentA = await waitFor(() => { const l = fs.readFileSync(stdinLog, 'utf8'); return l.includes('hello from A') ? l : null; }, 8000);
  ok(!!sentA && sentA.includes(path.join('tmp', A, 'uploads', SECRET)) && !sentA.includes(SECRET2), "A's message carries A's file path (in A's folder) and not B's file");
  t = await tray();
  ok(t.hidden, "the tray is empty after sending");
  ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} catch (e) {
  ok(false, 'test crashed: ' + e.stack);
} finally {
  await browser.close();
  await s.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
}
c.done();
