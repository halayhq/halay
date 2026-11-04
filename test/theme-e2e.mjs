// Colour themes in the browser (Settings → Appearance, js/theme.js, js/appearance.js) against a SPARE instance it starts itself
// (throwaway database, fake CLI; never the live server). Needs playwright-core and Chrome.
//   node test/theme-e2e.mjs
// Covers: Halay is the default and a saved older choice is kept, every preset applies (--acc/--bg change, meta theme-color follows), keyboard selection in the radio group, the
// choice survives a reload and is already there at DOMContentLoaded (no flash), light/dark toggle with a preset, the custom
// accent (hex field and colour picker, contrast fitting, survives a reload), an invalid hex is rejected, Reset, the login page
// uses the saved theme, the section fits a 375px screen, and no console errors.
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, startSpare, checker, sleep } from './lib/spare.mjs';
const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
const { ok, done } = checker();

const spare = await startSpare({ tag: 'theme', env: { HALAY_TERMINAL: '0' } });
const BASE = spare.base.replace('127.0.0.1', 'localhost'); // the browser uses localhost: a page at 127.0.0.1 is redirected there (passkeys need a domain)
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
// record the palette as the page first sees it: at DOMContentLoaded and on the first animation frame
const firstPaint = () => {
  const read = () => { const cs = getComputedStyle(document.documentElement); return { acc: cs.getPropertyValue('--acc').trim(), bg: cs.getPropertyValue('--bg').trim(), body: document.body && getComputedStyle(document.body).backgroundColor }; };
  document.addEventListener('DOMContentLoaded', () => { window.__dcl = read(); });
  const frame = () => { if (document.body) window.__raf = read(); else requestAnimationFrame(frame); }; // first frame with something to paint
  requestAnimationFrame(frame);
};
const watch = (page, tag) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
};
const rgbOf = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  await ctx.addInitScript(firstPaint);
  const page = await ctx.newPage();
  watch(page, 'app');
  // sign in through the context's cookie jar: loading the login page first races its own redirect with the next goto (ERR_ABORTED)
  await page.context().request.post(BASE + '/auth/token', { data: { token: spare.token } });
  await page.goto(BASE + '/?r=1#/');
  await page.waitForSelector('#side');
  const P = await page.evaluate(() => THEME_PRESETS);
  const v = () => page.evaluate(() => { const cs = getComputedStyle(document.documentElement); return { acc: cs.getPropertyValue('--acc').trim(), bg: cs.getPropertyValue('--bg').trim(), onAcc: cs.getPropertyValue('--on-acc').trim(), meta: document.querySelector('meta[name="theme-color"]').content, saved: localStorage.getItem('halay-palette') }; });
  let cur = await v();
  ok(cur.acc === '#0e0e11' && cur.onAcc === '#c9f53f' && cur.bg === '#ffffff' && cur.meta === '#ffffff' && cur.saved === null, `default is Halay light (acc ${cur.acc}, on-acc ${cur.onAcc}, bg ${cur.bg}, meta ${cur.meta})`);

  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForFunction(() => document.querySelector('#sdlg')?.open);
  const cards = await page.$$eval('#cthemes [role=radio]', (b) => b.map((x) => [x.dataset.id, x.getAttribute('aria-checked'), x.textContent]));
  ok(cards.length === 5 && cards[0][0] === 'halay' && cards[0][1] === 'true' && cards[1][0] === 'nord' && cards[4][0] === 'custom' && cards.filter((c) => c[1] === 'true').length === 1, 'Settings lists 4 presets + Custom, Halay checked: ' + cards.map((c) => c[2]).join(', '));
  ok(await page.$eval('#cthemes', (e) => e.getAttribute('role') === 'radiogroup' && !!e.getAttribute('aria-labelledby')), 'cards are a labelled radio group');

  // every preset applies
  let prev = cur;
  for (const p of P) {
    await page.click(`#cthemes [data-id="${p.id}"]`);
    cur = await v();
    const checked = await page.$eval(`#cthemes [data-id="${p.id}"]`, (e) => e.getAttribute('aria-checked'));
    ok(cur.acc === p.light.acc && cur.bg === p.light.bg && cur.meta === p.light.bg && checked === 'true', `${p.name}: --acc ${cur.acc}, --bg ${cur.bg}, meta theme-color follows, card checked`);
    if (p !== P[0]) ok(cur.acc !== prev.acc && cur.bg !== prev.bg, `${p.name}: differs from the previous preset`);
    prev = cur;
  }
  const btn = await page.waitForFunction((want) => { const c = getComputedStyle(document.querySelector('.cprev button.primary')).backgroundColor; return c === want && c; }, rgbOf(P.at(-1).light.acc), { timeout: 2000 }).then((h) => h.jsonValue(), () => 'not ' + rgbOf(P.at(-1).light.acc));
  ok(btn === rgbOf(P.at(-1).light.acc), 'preview button uses the accent: ' + btn); // after the .12s background transition

  // keyboard: arrows move the selection, focus follows, one tab stop
  await page.focus('#cthemes [aria-checked=true]');
  await page.keyboard.press('Home');
  ok(await page.evaluate(() => document.activeElement.dataset.id === 'halay' && document.activeElement.getAttribute('aria-checked') === 'true'), 'Home selects and focuses the first card');
  await page.keyboard.press('ArrowRight');
  const kb = await page.evaluate(() => ({ id: document.activeElement.dataset.id, tabs: [...document.querySelectorAll('#cthemes [tabindex="0"]')].map((e) => e.dataset.id) }));
  cur = await v();
  ok(kb.id === 'nord' && kb.tabs.join() === 'nord' && cur.acc === P[1].light.acc, `ArrowRight -> Nord applied and focused, one tab stop (${kb.tabs})`);
  ok(await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow !== 'none'), 'the focused card shows a focus ring');

  // reload: saved, and already applied when the page first renders
  await page.reload(); await page.waitForSelector('#side');
  await page.waitForFunction(() => window.__raf, null, { timeout: 5000 }).catch(() => {}); // the first-frame snapshot is taken in a rAF callback, which can land after #side exists
  const fp = await page.evaluate(() => ({ dcl: window.__dcl, raf: window.__raf }));
  ok(fp.dcl?.bg === P[1].light.bg && fp.dcl?.acc === P[1].light.acc && fp.raf?.bg === P[1].light.bg && fp.dcl.body === rgbOf(P[1].light.bg), `Nord survives a reload and is there at DOMContentLoaded and the first frame (${JSON.stringify(fp)})`);

  // light/dark toggle with a preset
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForFunction(() => document.querySelector('#sdlg')?.open);
  await page.click('[data-theme-pick=dark]');
  cur = await v();
  ok(cur.bg === P[1].dark.bg && cur.acc === P[1].dark.acc && cur.meta === P[1].dark.bg, `Dark with Nord -> polar night (${cur.bg}, ${cur.acc})`);
  const sw = await page.$eval('#cthemes [data-id="nord"] .ctsw i', (e) => getComputedStyle(e).backgroundColor);
  ok(sw === rgbOf(P[1].dark.bg), 'card swatches follow the mode');
  await page.click('[data-theme-pick=light]');
  cur = await v();
  ok(cur.bg === P[1].light.bg, 'Light again -> snow storm');
  await page.click('[data-theme-pick=system]');
  await page.emulateMedia({ colorScheme: 'dark' });
  const bgIs = (want) => page.waitForFunction((w) => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === w, want, { timeout: 3000 }).then(() => true, () => false);
  ok(await bgIs(P[1].dark.bg), 'System follows prefers-color-scheme to dark');
  await page.emulateMedia({ colorScheme: 'light' });
  ok(await bgIs(P[1].light.bg), 'and back to light');

  // custom accent
  await page.click('#cthemes [data-id="custom"]');
  ok(await page.isVisible('#chex') && (await page.$eval('#cbase', (e) => e.value)) === 'nord', 'Custom shows the accent fields, surfaces from Nord');
  await page.fill('#chex', '#ff8800');
  cur = await v();
  const want = await page.evaluate(() => ({ l: swarmColor.fitAccent('#ff8800', ['bg', 'side', 'card', 'ubg'].map((k) => THEME_PRESETS[1].light[k]), false), d: swarmColor.fitAccent('#ff8800', ['bg', 'side', 'card', 'ubg'].map((k) => THEME_PRESETS[1].dark[k]), true) }));
  const hint = await page.textContent('#chint');
  ok(cur.acc === want.l.acc && cur.bg === P[1].light.bg && want.l.adjusted && /Adjusted for contrast/.test(hint) && hint.includes(want.l.acc), `custom #ff8800 on Nord light -> ${cur.acc} (adjusted; hint: "${hint}")`);
  const contrastOk = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement), g = (k) => cs.getPropertyValue(k).trim(); return swarmColor.contrast(g('--acc'), g('--on-acc')) >= 4.5 && ['--bg', '--side', '--card', '--ubg'].every((k) => swarmColor.contrast(g('--acc'), g(k)) >= 4.5); });
  ok(contrastOk, 'custom accent: on-acc and every surface pass 4.5:1');
  ok(JSON.parse(cur.saved).accent === '#ff8800' && JSON.parse(cur.saved).preset === 'custom', 'custom saved: ' + cur.saved);
  // invalid hex
  await page.fill('#chex', '#12zz');
  const bad = await v();
  ok(await page.$eval('#chex', (e) => e.getAttribute('aria-invalid')) === 'true' && bad.acc === cur.acc && bad.saved === cur.saved && /Not a colour/.test(await page.textContent('#chint')), 'invalid hex is flagged and not applied');
  // the colour picker
  await page.$eval('#cpick', (e) => { e.value = '#2266aa'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  cur = await v();
  ok(JSON.parse(cur.saved).accent === '#2266aa' && (await page.$eval('#chex', (e) => [e.value, e.getAttribute('aria-invalid')])).join() === '#2266aa,', 'colour picker sets the accent and fixes the hex field');
  ok(/Readable as is|Adjusted/.test(await page.textContent('#chint')), 'hint updated: ' + await page.textContent('#chint'));
  // dark: a light-enough accent is derived
  await page.click('[data-theme-pick=dark]');
  const dk = await v();
  const wantD = await page.evaluate(() => swarmColor.fitAccent('#2266aa', ['bg', 'side', 'card', 'ubg'].map((k) => THEME_PRESETS[1].dark[k]), true));
  ok(dk.acc === wantD.acc && dk.bg === P[1].dark.bg, `custom #2266aa in dark -> ${dk.acc}`);
  await page.click('[data-theme-pick=light]');
  // survives a reload
  await page.reload(); await page.waitForSelector('#side');
  const fp2 = await page.evaluate(() => window.__dcl);
  cur = await v();
  ok(fp2.acc === cur.acc && JSON.parse(cur.saved).accent === '#2266aa' && cur.bg === P[1].light.bg, `custom accent survives a reload, applied at DOMContentLoaded (${fp2.acc})`);

  // surfaces from another preset
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForFunction(() => document.querySelector('#sdlg')?.open);
  await page.selectOption('#cbase', 'gruvbox');
  cur = await v();
  ok(cur.bg === P[3].light.bg && JSON.parse(cur.saved).base === 'gruvbox', 'Surfaces from Gruvbox switches the surfaces, keeps the custom accent');

  // narrow screen: the section fits
  await page.setViewportSize({ width: 375, height: 812 });
  await sleep(300);
  const fit = await page.evaluate(() => { const s = document.querySelector('#sappear'), r = s.getBoundingClientRect(); return { sw: s.scrollWidth, cw: s.clientWidth, right: Math.max(...[...s.querySelectorAll('*')].map((e) => e.getBoundingClientRect().right)), vw: innerWidth, rr: r.right }; });
  ok(fit.sw <= fit.cw + 1 && fit.right <= fit.vw, `Appearance fits 375px (scroll ${fit.sw}/${fit.cw}, rightmost ${Math.round(fit.right)} <= ${fit.vw})`);
  await page.setViewportSize({ width: 1280, height: 900 });

  // reset
  await page.click('#creset');
  cur = await v();
  ok(cur.acc === '#0e0e11' && cur.bg === '#ffffff' && cur.saved === null && await page.$eval('#cthemes [data-id="halay"]', (e) => e.getAttribute('aria-checked')) === 'true' && await page.isHidden('#ccustom'), 'Reset to default -> Halay, nothing saved');
  // an explicit pick of the default is saved (so a later change of default leaves it alone)
  await page.click('#cthemes [data-id="halay"]');
  ok(JSON.parse((await v()).saved || '{}').preset === 'halay', 'picking Halay explicitly is saved');
  await page.click('#creset');

  // login page (no session) uses the saved theme
  const lctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  await lctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('halay-palette', JSON.stringify({ preset: 'gruvbox', base: 'gruvbox' })); localStorage.setItem('halay-theme', 'dark'); sessionStorage.setItem('seeded', '1'); } });
  await lctx.addInitScript(firstPaint);
  const lp = await lctx.newPage();
  watch(lp, 'login');
  await lp.goto(BASE + '/');
  await lp.waitForSelector('#card');
  const lv = await lp.evaluate(() => ({ dcl: window.__dcl, title: document.title, main: getComputedStyle(document.documentElement).getPropertyValue('--acc').trim(), meta: document.querySelector('meta[name="theme-color"]').content, side: !!document.querySelector('#side') }));
  ok(!lv.side && lv.dcl?.bg === P[3].dark.bg && lv.main === P[3].dark.acc && lv.meta === P[3].dark.bg, `login page uses the saved theme (Gruvbox dark: bg ${lv.dcl?.bg}, acc ${lv.main})`);
  await lctx.close();

  // a removed preset: someone who saved Ink navy gets the default (Halay)
  const mctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  await mctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('halay-palette', JSON.stringify({ preset: 'ink', base: 'ink' })); sessionStorage.setItem('seeded', '1'); } });
  const mp = await mctx.newPage();
  watch(mp, 'migrate');
  await mp.goto(BASE + '/');
  const mv = await mp.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--acc').trim());
  ok(mv === P[0].light.acc, `a saved Ink navy (removed) falls back to Halay (acc ${mv})`);
  await mctx.close();

  await sleep(200);
  ok(!errors.length, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();
} catch (e) {
  ok(false, 'unexpected error: ' + (e.stack || e));
} finally {
  await browser.close();
  await spare.stop();
}
done();
