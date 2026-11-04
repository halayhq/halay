#!/usr/bin/env node
// Record the README's animated demos (docs/screenshots/demo-*.gif, plus an .mp4 of each) on a throwaway instance
// (bin/demo-instance.mjs) driven by the scripted fake claude in test/fake-claude-demo (DEMO_SCENES=1): no real agent, model
// or account. Each demo gets a fresh instance. Frames come from Chrome's screencast (CDP) and are turned into a GIF with
// ffmpeg (palettegen / paletteuse) and an H.264 MP4. A drawn pointer shows where the script clicks.
//   node bin/make-demos.mjs [outdir] [name...]     names: swarm, approval, phone, themes (default: all)
//   FFMPEG=/path/to/ffmpeg to pick the binary (default: ffmpeg on PATH, else /opt/homebrew/bin/ffmpeg)
//   KEEP_FRAMES=1 keeps the raw frames in <outdir>/frames-<name>/ for checking
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
import { WT, chromium, sleep, PROJ, start } from './demo-instance.mjs';
const OUT = path.resolve(process.argv[2] || path.join(WT, 'docs/screenshots'));
const ONLY = process.argv.slice(3);
const FFMPEG = process.env.FFMPEG || (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch { return '/opt/homebrew/bin/ffmpeg'; } })();
fs.mkdirSync(OUT, { recursive: true });
const JOB = 'Ship the new checkout: an API endpoint, the checkout page and the docs. One agent per repo.';
const API_PROMPT = 'Add a POST /checkout endpoint to the API server: validate the cart, create the order, return its id. Add tests.';
const PAGE_PROMPT = 'Build the checkout page in the web shop: address form, order summary and a Pay button that calls POST /checkout.';
const DOCS_PROMPT = 'Document the new checkout flow in the docs site: a guide page and the POST /checkout API reference.';

// a pointer drawn into the page (headless Chrome shows none); moved with a CSS transition, a ring on each click
const POINTER = () => {
  const add = () => {
    if (document.getElementById('demo-ptr')) return;
    const s = document.createElement('style');
    s.textContent = `#demo-ptr{position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(20,20,24,.55);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.45);z-index:2147483647;pointer-events:none;transition:transform .55s cubic-bezier(.4,0,.2,1),opacity .3s;opacity:0}
#demo-ptr.on{opacity:1}#demo-ptr.down{animation:demo-ring .45s ease-out}@keyframes demo-ring{0%{box-shadow:0 0 0 0 rgba(120,120,255,.7)}100%{box-shadow:0 0 0 18px rgba(120,120,255,0)}}`;
    const p = document.createElement('div'); p.id = 'demo-ptr';
    document.documentElement.append(s, p);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
};
async function pointTo(page, sel, { click = true, tap = false, dwell = 350 } = {}) {
  const el = page.locator(sel).first();
  await el.waitFor({ state: 'visible', timeout: 15000 });
  const move = async (ms) => {
    const b = await el.boundingBox(), x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2;
    await page.evaluate(([x, y, ms]) => { const p = document.getElementById('demo-ptr'); p.classList.add('on'); p.style.transitionDuration = ms + 'ms, .3s'; p.style.transform = `translate(${x}px,${y}px)`; }, [x, y, ms]);
    return x + ',' + y;
  };
  // follow the target if it moved meanwhile (a live list re-sorts)
  let at = await move(550); await sleep(600 + dwell);
  for (let i = 0; i < 3; i++) { const now = await move(150); if (now === at) break; at = now; await sleep(250); }
  if (!click) return;
  await page.evaluate(() => { const p = document.getElementById('demo-ptr'); p.classList.remove('down'); void p.offsetWidth; p.classList.add('down'); });
  if (tap) await el.tap(); else await el.click();
}
// an agent's list row by its name (a row's preview can mention other agents' names)
const rowOf = async (api, name) => `.arow[data-id="${(await api('/agents')).find((a) => a.name === name).id}"]`;
const hidePointer = (page) => page.evaluate(() => document.getElementById('demo-ptr')?.classList.remove('on'));

// screencast recorder: frames with their timestamps, written as JPEGs; encode() turns them into a GIF and an MP4
async function recorder(page, dir, size) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page), frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    const file = path.join(dir, String(frames.length).padStart(5, '0') + '.jpg');
    fs.writeFileSync(file, Buffer.from(f.data, 'base64')); frames.push({ file, t: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  return {
    start: () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: size.w * 2, maxHeight: size.h * 2, everyNthFrame: 1 }),
    async stop() { const end = Date.now() / 1000; await cdp.send('Page.stopScreencast'); await sleep(200); return { frames, end }; },
  };
}
function encode(name, { frames, end }, dir, { width, fps = 10 }) {
  // the screencast sends a frame only when something changed: hold each frame until the next one
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.01, (frames[i + 1]?.t ?? end) - f.t).toFixed(3)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  fs.writeFileSync(path.join(dir, 'list.txt'), list);
  const input = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt')];
  const scale = `fps=${fps},scale=${width}:-2:flags=lanczos`;
  execFileSync(FFMPEG, [...input, '-vf', `${scale},split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', path.join(OUT, name + '.gif')]);
  execFileSync(FFMPEG, [...input, '-vf', `fps=25,scale=${Math.round(width * 1.25 / 2) * 2}:-2:flags=lanczos`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart', '-an', path.join(OUT, name + '.mp4')]);
  const kb = (f) => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB';
  console.log(`${name}: ${frames.length} frames, ${(end - frames[0].t).toFixed(1)} s, gif ${kb(name + '.gif')}, mp4 ${kb(name + '.mp4')}`);
}

const DESK = { w: 1200, h: 750 }, PHONE = { w: 390, h: 844 };
const errors = [];
async function demo(name, { size, mobile = false, theme = 'light', width, fps, setup, hash, play }) {
  if (ONLY.length && !ONLY.includes(name)) return;
  const inst = await start({ extraEnv: { DEMO_SCENES: '1' } });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const dir = path.join(OUT, 'frames-' + name);
  try {
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: theme });
    await ctx.addInitScript((t) => { localStorage.setItem('halay-theme', t); localStorage.setItem('halay-nbar', 'off'); }, theme);
    await ctx.addInitScript(POINTER);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(name + ': ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(name + ': ' + m.text()); });
    const state = setup ? await setup(inst) : {};
    await inst.signIn(page);
    if (hash) await page.goto(inst.base + '/' + (typeof hash === 'function' ? hash(state) : hash));
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {}); await sleep(1000);
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.evaluate(([x, y]) => { const p = document.getElementById('demo-ptr'); p.style.transition = 'none'; p.style.transform = `translate(${x}px,${y}px)`; void p.offsetWidth; p.style.transition = ''; }, [size.w * 0.6, size.h * 0.55]);
    const rec = await recorder(page, dir, size);
    await rec.start(); await sleep(300);
    await play(page, inst, state);
    encode(name, await rec.stop(), dir, { width, fps });
  } finally {
    await browser.close(); await inst.stop();
    if (!process.env.KEEP_FRAMES) fs.rmSync(dir, { recursive: true, force: true });
  }
}
// an earlier, finished agent so the list doesn't start empty (the fake answers it at once)
const earlier = async (api) => { await api('/agents', 'POST', { cwd: PROJ + '/api-server', name: 'port from env', prompt: 'Make the server port configurable' }); await sleep(1500); };

try {
  // (a) the hero: the swarm chat gets a bigger job and starts three agents, which show up in the list and work
  await demo('demo-swarm-chat', {
    size: DESK, width: 960, fps: 12,
    setup: async ({ api }) => { await earlier(api); return {}; },
    play: async (page, { api }) => {
      await pointTo(page, '.arow.cond', { dwell: 150 });
      await page.waitForSelector('#txt', { timeout: 10000 }); await sleep(250);
      await page.focus('#txt'); await hidePointer(page);
      await page.keyboard.type(JOB, { delay: 14 }); await sleep(300);
      await page.keyboard.press('Enter');
      await page.getByText('Started 3 agents').waitFor({ timeout: 20000 });
      await sleep(900);
      await pointTo(page, await rowOf(api, 'checkout page'), { dwell: 150 });
      await sleep(2600);
    },
  });

  // (b) following an agent live: todos, tool calls, an approval card that gets allowed, the finished answer
  await demo('demo-approval', {
    size: DESK, width: 960, fps: 12,
    setup: async ({ api }) => { await earlier(api); const a = await api('/agents', 'POST', { cwd: PROJ + '/api-server', name: 'checkout API' }); await sleep(800); return { a }; },
    hash: (s) => '#/a/' + s.a.id,
    play: async (page, { api }, { a }) => {
      await sleep(200);
      await api(`/agents/${a.id}/send`, 'POST', { text: API_PROMPT });
      await page.locator('button[data-d="allow"]:visible').first().waitFor({ timeout: 20000 });
      await sleep(500);
      await pointTo(page, 'button[data-d="allow"]:visible', { dwell: 300 });
      await sleep(300); await hidePointer(page);
      await page.getByText('All 14 tests').waitFor({ timeout: 20000 }).catch(() => {});
      await sleep(1800);
    },
  });

  // (c) the phone layout: three agents working in the list, one asks for approval; open it from the toast, allow, it finishes
  await demo('demo-phone', {
    size: PHONE, mobile: true, width: 390, fps: 12,
    setup: async ({ api }) => { await earlier(api); return {}; },
    play: async (page, { api }) => {
      await sleep(400);
      for (const [name, cwd, prompt] of [['checkout API', '/api-server', API_PROMPT], ['checkout page', '/web-shop', PAGE_PROMPT], ['checkout docs', '/docs-site', DOCS_PROMPT]]) {
        await api('/agents', 'POST', { cwd: PROJ + cwd, name, prompt }); await sleep(300);
      }
      // the approval arrives as a toast (and the row moves to Needs you): tap the toast to open the agent
      const toastSel = '.toast.act:has-text("needs approval")';
      await page.locator(toastSel).waitFor({ timeout: 20000 }); await sleep(900);
      await pointTo(page, toastSel, { tap: true, dwell: 150 });
      await page.locator('button[data-d="allow"]:visible').first().waitFor({ timeout: 20000 });
      await sleep(500);
      await pointTo(page, 'button[data-d="allow"]:visible', { tap: true, dwell: 250 });
      await sleep(300); await hidePointer(page);
      await page.getByText('All 14 tests').waitFor({ timeout: 20000 }).catch(() => {});
      await sleep(1500);
    },
  });

  // (d) colour themes: Settings → Appearance, a few presets, dark mode, back to the default
  await demo('demo-themes', {
    size: DESK, width: 960, fps: 10,
    setup: async ({ api }) => {
      await api('/agents', 'POST', { cwd: PROJ + '/web-shop', name: 'web-shop checkout', prompt: 'Make the server port configurable' });
      await api('/agents', 'POST', { cwd: PROJ + '/docs-site', name: 'docs-site' });
      await earlier(api); return {};
    },
    play: async (page) => {
      await pointTo(page, '#bset', { dwell: 100 }); await sleep(800);
      for (const id of ['nord', 'solarized', 'gruvbox']) { await pointTo(page, `.ctcard[data-id="${id}"]`, { dwell: 100 }); await sleep(600); }
      await pointTo(page, '[data-theme-pick="dark"]', { dwell: 100 }); await sleep(700);
      for (const id of ['nord', 'halay']) { await pointTo(page, `.ctcard[data-id="${id}"]`, { dwell: 100 }); await sleep(700); }
      await hidePointer(page); await sleep(600);
    },
  });
} finally {
  console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors');
}
