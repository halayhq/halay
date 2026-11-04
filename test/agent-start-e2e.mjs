// POST /api/agents/:id/start: a stopped agent's process is started without a message (it resumes its session and waits
// idle, e.g. to pick up an updated swarm MCP server). No turn, no prompt, no replayed history; the next message works as
// usual; an agent's own token can't do it. Claude (test/fake-claude) and OpenCode (test/fake-acp). In the chat, a
// stopped agent shows a "Start now" button above the composer (skipped without Chrome).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, startSpare, checker, waitFor, agentToken, chromeAvailable } from './lib/spare.mjs';

const c = checker();
process.env.PATH = path.join(ROOT, 'test/fake-acp') + path.delimiter + process.env.PATH;
const s = await startSpare({ tag: 'agstart', env: { HALAY_TERMINAL: '0' } });
const LOG = path.join(s.dir, 'acp.log');
await s.restart({ FAKE_ACP_LOG: LOG });
const agent = async (id) => (await s.api(`/agents/${id}?all=1`)).j;
const status = (id, want, ms = 10000) => waitFor(async () => (await agent(id)).status === want, ms);
const acpIn = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.in).map((r) => JSON.parse(r.in).method); } catch { return []; } };
const launches = () => { try { return fs.readFileSync(s.claudeLog, 'utf8').split('---\n').filter((x) => x.includes('-p')); } catch { return []; } };

try {
  for (const backend of ['claude', 'opencode']) {
    const r = await s.api('/agents', 'POST', { cwd: s.dir, name: backend + ' one', backend, prompt: 'hello' });
    const id = r.j.id;
    c.ok(!!await status(id, 'idle'), `${backend}: first turn done`);
    await s.api(`/agents/${id}/mode`, 'POST', { permissionMode: 'manual' }); // ends the process (the way a reload does)
    c.ok(!!await status(id, 'stopped'), `${backend}: process ended, agent stopped`);
    const before = (await agent(id)).events.length, nLaunch = launches().length, nPrompts = acpIn().filter((m) => m === 'session/prompt').length;
    c.ok((await as(agentToken(s, id))(`/api/agents/${id}/start`)).status === 403, `${backend}: an agent's token can't start one`);
    const st = await s.api(`/agents/${id}/start`, 'POST');
    c.ok(st.status === 200 && st.j.agent?.status === 'idle', `${backend}: started, idle: ` + st.text.slice(0, 120));
    await new Promise((r) => setTimeout(r, 1500));
    const a = await agent(id);
    c.ok(a.status === 'idle', `${backend}: still idle a moment later (no turn ran)`);
    const added = a.events.slice(before).map((e) => e.type);
    c.ok(!added.some((t) => ['user_prompt', 'assistant', 'result', 'user'].includes(t)), `${backend}: no prompt, reply or replayed history in the chat: [${added.join(', ')}]`);
    if (backend === 'claude') c.ok(launches().length === nLaunch + 1 && launches().at(-1).includes('--resume'), 'claude: a new process, resuming the session');
    else c.ok(acpIn().filter((m) => m === 'session/prompt').length === nPrompts && acpIn().includes('session/load'), 'opencode: session loaded, no prompt sent');
    c.ok((await s.api(`/agents/${id}/start`, 'POST')).j.already === true, `${backend}: starting a running process again is a no-op`);
    await s.api(`/agents/${id}/send`, 'POST', { text: 'next' });
    c.ok(!!await waitFor(async () => (await agent(id)).events.filter((e) => e.type === 'result').length === 2 && (await agent(id)).status === 'idle', 10000), `${backend}: the next message runs one turn as usual`);
  }
  // ---- the chat's Start now button
  if (!(await chromeAvailable())) c.skip('Chrome is not available: Start now button not checked');
  else {
    const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
    const web = s.base.replace('127.0.0.1', 'localhost');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.context().request.post(web + '/auth/token', { data: { token: s.token } });
      const id = (await s.api('/agents', 'POST', { cwd: s.dir, name: 'ui one', prompt: 'hello' })).j.id;
      await status(id, 'idle');
      await page.goto(web + '/?r=1#/a/' + id);
      await page.waitForSelector('#txt');
      c.ok(await page.evaluate(() => $('#stopped').hidden), 'a live agent: no Start now strip');
      await s.api(`/agents/${id}/mode`, 'POST', { permissionMode: 'manual' });
      await status(id, 'stopped');
      c.ok(!!await waitFor(() => page.evaluate(() => !$('#stopped').hidden && !!$('#startp')), 5000), 'stopped: the Start now strip shows');
      const before = (await agent(id)).events.length;
      await page.click('#startp');
      c.ok(!!await status(id, 'idle', 5000), 'clicking Start now starts it (idle)');
      c.ok(!!await waitFor(() => page.evaluate(() => $('#stopped').hidden), 5000), 'and the strip hides');
      await new Promise((r) => setTimeout(r, 800));
      c.ok(!(await agent(id)).events.slice(before).some((e) => ['user_prompt', 'result'].includes(e.type)), 'no message was sent, no turn ran');
      c.ok(!errors.length, 'no page errors: ' + errors.join('; '));
    } finally { await browser.close(); }
  }
} catch (e) {
  c.ok(false, 'crashed: ' + e.stack);
  console.log(s.log().slice(-3000));
} finally {
  await s.stop();
}
c.done();
function as(tok) { return async (p, method = 'POST') => { const r = await fetch(s.base + p, { method, headers: { authorization: 'Bearer ' + tok } }); return { status: r.status }; }; }
