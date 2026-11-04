// The sidebar's page nav (index.html #tools, js/pages.js) against a SPARE instance it starts itself (throwaway database, fake
// CLI; never the live server). Needs playwright-core and Chrome.
//   node test/sidebar-more-e2e.mjs
// Covers: the frequent pages stay in the bar with a visible label, the rare ones (History, Usage, Terminal, Browser, Theme)
// sit in the More menu; More opens and closes (aria-expanded, Esc returns focus, outside click), arrow keys move inside it,
// a page row opens its page and lights up More, Theme cycles and keeps the menu open, a Terminal/Browser count puts a dot
// on More, a page that opens late (its opener awaits a fetch) leaves an open menu open, the phone tab bar fits without
// scrolling and opens the menu as a sheet even while a page is open, no console errors.
// No fixed sleeps: every step waits on the state it needs (open/closed and settled, focus, URL, the page's dialog).
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, startSpare, checker } from './lib/spare.mjs';
const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
const { ok, done } = checker();

const spare = await startSpare({ tag: 'more', env: { HALAY_TERMINAL: '0' } });
const BASE = spare.base.replace('127.0.0.1', 'localhost');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const open = (page) => page.evaluate(() => document.querySelector('#tmenu').matches(':popover-open'));
// wait until the menu is open (or closed), More's aria-expanded agrees and no animation is running (the sheet slides in)
const settle = (page, want) => page.waitForFunction((w) => {
  const m = document.querySelector('#tmenu');
  return m.matches(':popover-open') === w && document.querySelector('#bmore').getAttribute('aria-expanded') === String(w) && !m.getAnimations().length;
}, want, { timeout: 10000 }).then(() => true, () => false);
const until = (page, f, arg) => page.waitForFunction(f, arg, { timeout: 10000 }).then(() => true, () => false);
const focused = (page, id) => until(page, (x) => document.activeElement?.id === x, id);
// signs in once: the phone page reuses the desktop page's session cookie (storageState) instead of a second sign-in request
let session;
async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport, colorScheme: 'light', storageState: session });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  if (!session) { await ctx.request.post(BASE + '/auth/token', { data: { token: spare.token } }); session = { cookies: (await ctx.storageState()).cookies, origins: [] }; }
  await page.goto(BASE + '/?r=1#/');
  await page.waitForSelector('#side');
  await until(page, () => document.querySelector('#btheme')?.textContent.includes('Theme'));
  return page;
}

try {
  const page = await newPage({ width: 1280, height: 800 });
  const bar = await page.evaluate(() => [...document.querySelectorAll('#tools > button')].map((b) => b.id));
  ok(JSON.stringify(bar) === JSON.stringify(['bappr', 'btasks', 'brooms', 'bbots', 'bset', 'bmore']), 'bar holds Approvals, Tasks, Rooms, Bots, Settings, More: ' + bar);
  ok(await page.evaluate(() => ['hist', 'busage', 'bterm', 'bbrow', 'btheme'].every((id) => document.querySelector('#tmenu > #' + id))), 'History, Usage, Terminal, Browser, Theme are in the More menu');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('#btasks'), '::after').content === '"Tasks"'), 'bar buttons show their label');
  ok(await page.evaluate(() => { const t = document.querySelector('#tools'); return t.scrollWidth <= t.clientWidth; }), 'desktop bar fits the sidebar');
  ok(await page.getAttribute('#bmore', 'aria-expanded') === 'false' && await page.getAttribute('#bmore', 'aria-haspopup') === 'menu', 'More: aria-haspopup, collapsed');

  await page.click('#bmore');
  ok(await settle(page, true), 'More opens the menu');
  ok(await focused(page, 'hist'), 'focus moves to the first row');
  await page.keyboard.press('ArrowDown');
  ok(await focused(page, 'busage'), 'ArrowDown moves to Usage');
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  ok(await focused(page, 'btheme'), 'ArrowUp wraps to Theme (hidden Terminal/Browser skipped)');
  await page.keyboard.press('Escape');
  ok(await settle(page, false) && await focused(page, 'bmore'), 'Escape closes it and focus returns to More');

  await page.click('#bmore'); await settle(page, true);
  await page.mouse.click(900, 600);
  ok(await settle(page, false), 'an outside click closes it');

  // a page whose opener finished late: dialog.show() closes popovers, pages.js puts the menu back
  await page.click('#bmore'); await settle(page, true);
  await page.keyboard.press('ArrowDown'); await focused(page, 'busage');
  await page.evaluate(() => document.querySelector('#udlg').showModal());
  ok(await until(page, () => document.querySelector('#udlg').open) && await settle(page, true) && await focused(page, 'busage'), 'a page opening late leaves the menu open, focus kept');
  await page.keyboard.press('Escape'); await settle(page, false);
  await page.evaluate(() => document.querySelector('#udlg').close());
  await until(page, () => !document.querySelector('#udlg').open && !document.querySelector('#bmore').classList.contains('cur'));

  const th0 = await page.evaluate(() => localStorage.getItem('halay-theme') || 'system');
  await page.click('#bmore'); await settle(page, true);
  await page.click('#btheme');
  ok(th0 === 'system' && await until(page, () => localStorage.getItem('halay-theme') === 'light') && await open(page), `Theme cycles (${th0} → light) and keeps the menu open`);
  ok(await until(page, () => document.querySelector('#btheme').textContent.includes('Theme: Light')), 'the Theme row names the current theme');
  await page.click('#btheme');
  ok(await until(page, () => document.documentElement.dataset.theme === 'dark'), 'second click: dark');

  await page.click('#hist');
  ok(await settle(page, false) && await until(page, () => location.hash === '#/history'), 'History row opens the History page and closes the menu');
  // the page (and so the lit state) follows the dialog, which opens once History's data is fetched
  ok(await until(page, () => document.querySelector('#hdlg').open && document.querySelector('#bmore').classList.contains('cur') && document.querySelector('#hist').getAttribute('aria-current') === 'page'), 'More is lit while History is open');
  await page.click('#btasks');
  ok(await until(page, () => document.querySelector('#tdlg').open && !document.querySelector('#bmore').classList.contains('cur')), 'and unlit on Tasks');

  ok(await page.evaluate(() => document.querySelector('#nmore').hidden), 'no dot on More with nothing running');
  await page.evaluate(() => { const b = document.querySelector('#bterm'); b.hidden = false; const n = document.querySelector('#nterm'); n.hidden = false; n.textContent = '2'; });
  ok(await until(page, () => !document.querySelector('#nmore').hidden && /2 running/.test(document.querySelector('#bmore').getAttribute('aria-label'))), 'a Terminal count puts a dot on More and in its label');

  const phone = await newPage({ width: 390, height: 844 });
  ok(await phone.evaluate(() => { const t = document.querySelector('#tools'); return t.scrollWidth <= t.clientWidth + 1; }), 'phone tab bar fits without scrolling');
  await phone.goto(BASE + '/?r=1#/history');
  await until(phone, () => document.querySelector('#hdlg').open);
  await phone.click('#bmore');
  ok(await settle(phone, true), 'phone: More opens the menu over a page');
  const box = await phone.evaluate(() => { const r = document.querySelector('#tmenu').getBoundingClientRect(); return { b: Math.round(r.bottom), h: r.height, w: r.width }; });
  ok(box.h > 100 && box.b === 844 && box.w === 390, 'phone: it is a bottom sheet ' + JSON.stringify(box));
  await phone.click('#busage');
  ok(await until(phone, () => location.hash === '#/usage' && document.querySelector('#udlg').open), 'phone: the Usage row opens Usage');
} catch (e) {
  ok(false, 'threw: ' + e.stack);
  console.log('server log (tail):\n' + spare.log().split('\n').slice(-30).join('\n'));
} finally {
  ok(!errors.length, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); await spare.stop();
}
done();
