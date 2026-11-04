#!/usr/bin/env node
// Re-take the README screenshots (docs/screenshots/) on a throwaway instance (bin/demo-instance.mjs: own port, database, HOME
// and data folder under /tmp/demo, a clean environment, the fake claude from test/fake-claude-demo, the Machines plugin
// off). Demo folders go to /tmp/demo-projects (short paths in the shots); both are removed afterwards. Never touches a
// running server. The animated demos for the README come from bin/make-demos.mjs.
//   node bin/make-screenshots.mjs [outdir]            (the README set, plus settings-themes-dark and settings-custom-accent
//                                                      for docs/theming.md)
//   node bin/make-screenshots.mjs [outdir] review     (390px phone and extra shots: dark welcome, approval card, dialogs)
//   node bin/make-screenshots.mjs [outdir] themes     (every colour theme preset, light and dark, desktop and 390px phone, plus
//                                                      Settings → Appearance; docs/theming.md)
import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
import { WT, chromium, sleep, PROJ, start } from './demo-instance.mjs';
const OUT = path.resolve(process.argv[2] || path.join(WT, 'docs/screenshots')), REVIEW = process.argv[3] === 'review', THEMES = process.argv[3] === 'themes';
fs.mkdirSync(OUT, { recursive: true });
const inst = await start(), { api, signIn } = inst, BASE = inst.base, TOKEN = inst.token;
const errors = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function shot(name, { w, h, theme, hash = '', mobile = false, before, palette } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: theme });
  // the "Enable notifications" bar is dismissed (it only asks for the browser permission)
  await ctx.addInitScript(([t, p]) => { localStorage.setItem('halay-theme', t); localStorage.setItem('halay-nbar', 'off'); if (p) localStorage.setItem('halay-palette', JSON.stringify(p)); }, [theme, palette]);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push(name + ': ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(name + ': ' + r.status() + ' ' + r.url()); });
  await signIn(page);
  if (hash) await page.goto(BASE + '/' + hash);
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); await sleep(1200);
  if (before) await before(page);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('shot', name);
  await ctx.close();
}
const D = { w: 1280, h: 800 }, P = { w: REVIEW || THEMES ? 390 : 375, h: REVIEW || THEMES ? 844 : 812, mobile: true };
try {
  if (!THEMES) await shot('desktop-welcome', { ...D, theme: 'light' });
  if (REVIEW) await shot('desktop-welcome-dark', { ...D, theme: 'dark' });
  const proj = PROJ;
  const a1 = await api('/agents', 'POST', { cwd: proj + '/api-server', name: 'api-server tests', prompt: 'Make the server port configurable' });
  await sleep(1500);
  const a2 = await api('/agents', 'POST', { cwd: proj + '/web-shop', name: 'web-shop checkout', prompt: 'Make the server port configurable' });
  await api('/agents', 'POST', { cwd: proj + '/docs-site', name: 'docs-site' });
  await sleep(4000);
  const hash = '#/a/' + a2.id;
  if (THEMES) {
    const ids = ['halay', 'nord', 'solarized', 'gruvbox'];
    const settings = async (p) => { await p.click('#bset', { timeout: 5000 }); await sleep(500); };
    for (const id of ids) for (const t of ['light', 'dark']) {
      const palette = { preset: id, base: id };
      await shot(`theme-${id}-${t}`, { ...D, theme: t, hash, palette });
      await shot(`theme-${id}-${t}-phone`, { ...P, theme: t, hash, palette });
      await shot(`theme-${id}-${t}-settings`, { ...D, theme: t, palette, before: settings });
    }
    await shot('theme-custom-light-settings', { ...D, theme: 'light', palette: { preset: 'custom', base: 'nord', accent: '#ff8800' }, before: settings });
    await shot('theme-custom-dark-settings-phone', { ...P, theme: 'dark', palette: { preset: 'custom', base: 'nord', accent: '#ff8800' }, before: settings });
  }
  if (!THEMES) {
  await shot('desktop-chat', { ...D, theme: 'light', hash });
  await shot('phone-chat-dark', { ...P, theme: 'dark', hash });
  const settings = async (p) => { await p.click('#bset', { timeout: 5000 }); await sleep(500); };
  await shot('settings-themes-dark', { ...D, theme: 'dark', palette: { preset: 'gruvbox', base: 'gruvbox' }, before: settings });
  await shot('settings-custom-accent', { ...D, theme: 'light', palette: { preset: 'custom', base: 'nord', accent: '#ff8800' }, before: settings });
  if (REVIEW) {
    await shot('phone-chat-light', { ...P, theme: 'light', hash });
    // a running agent and a permission card (claude's side of the approval played through swarm-mcp's approve tool)
    const a3 = await api('/agents', 'POST', { cwd: proj + '/api-server', name: 'deploy check', prompt: 'fake-wait deploy it' });
    await sleep(1500);
    const m = spawn(process.execPath, [WT + '/src/swarm-mcp.js'], { env: { ...process.env, HALAY_URL: BASE, HALAY_TOKEN: TOKEN, HALAY_AGENT: a3.id }, stdio: ['pipe', 'pipe', 'inherit'] });
    m.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    m.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'npm run deploy -- --prod' }, tool_use_id: 'toolu_p' } } }) + '\n');
    await sleep(1500);
    const h3 = '#/a/' + a3.id;
    for (const t of ['light', 'dark']) {
      await shot('desktop-perm-' + t, { ...D, theme: t, hash: h3 });
      await shot('phone-perm-' + t, { ...P, theme: t, hash: h3 });
      await shot('desktop-settings-' + t, { ...D, theme: t, hash: h3, before: async (p) => { await p.click('#bset', { timeout: 5000 }); await sleep(500); } });
      await shot('desktop-newagent-' + t, { ...D, theme: t, before: async (p) => { await p.click('#new', { timeout: 5000 }); await sleep(500); await p.keyboard.press('Tab'); } });
    }
    m.kill();
  }
  }
} finally {
  await browser.close();
  await inst.stop();
  console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'no console errors');
}
