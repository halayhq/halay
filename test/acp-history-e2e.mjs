// History for the other CLIs, against the fake ACP agent (as opencode, cursor-agent and gemini): their sessions listed
// by the CLIs themselves (session/list, paged, Cursor after its login step; Gemini can't list), resuming one (its
// conversation read from the session's replay, the swarm instructions it carried left out; the agent then loads the
// session and, as it was started outside the swarm, Cursor gets the swarm instructions with the next message), and
// the History dialog resuming a Cursor session with the Cursor account and a mode Cursor has. The dialog part skips
// without Chrome. The server's HOME is its own (startSpare): with the real one History would stay partial while it
// scans the user's Claude transcripts, for longer than the wait below on a machine with many of them.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, startSpare, checker, waitFor, chromeAvailable } from './lib/spare.mjs';

const c = checker(), ok = c.ok;
process.env.PATH = path.join(ROOT, 'test/fake-acp') + path.delimiter + process.env.PATH;
const s = await startSpare({ tag: 'acphist', env: { HALAY_TERMINAL: '0', HALAY_BACKENDS: 'claude,opencode,gemini,cursor' } });
const LOG = path.join(s.dir, 'acp.log'), PROJ = path.join(s.dir, 'proj');
fs.mkdirSync(PROJ);
await s.restart({ FAKE_ACP_LOG: LOG, FAKE_ACP_LIST_CWD: PROJ });

const log = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const sent = (method) => log().filter((r) => r.in).map((r) => ({ pid: r.pid, m: JSON.parse(r.in) })).filter((x) => !method || x.m.method === method);
const agentOf = async (id) => (await s.api('/agents')).j.find((a) => a.id === id);
const eventsOf = async (id) => (await s.api(`/agents/${id}?all=1`)).j.events || [];
const idle = (id) => waitFor(async () => (await agentOf(id))?.status === 'idle', 8000);
const sessions = async () => (await s.api('/sessions/all')).j;
const others = (all) => all.sessions.filter((x) => x.backend);

try {
  // ---- listing
  const first = await sessions();
  ok(first.partial, 'the first History request is partial while the CLIs list their sessions');
  const all = await waitFor(async () => { const r = await sessions(); return !r.partial && others(r).length >= 4 ? r : null; }, 20000);
  const oc = others(all || { sessions: [] }).filter((x) => x.backend === 'opencode'), cu = others(all || { sessions: [] }).filter((x) => x.backend === 'cursor');
  ok(oc.length === 2 && cu.length === 2, 'OpenCode and Cursor sessions are listed, both pages: ' + JSON.stringify(others(all || { sessions: [] }).map((x) => x.id)));
  ok(!others(all || { sessions: [] }).some((x) => x.backend === 'gemini'), 'Gemini, which has no session/list, lists none');
  const c1 = cu.find((x) => x.id === 'ses_hist_cursor-agent_1');
  ok(c1 && c1.cwd === PROJ && c1.title === 'Old cursor-agent session 1' && c1.exists && c1.accounts.join() === 'cursor' && c1.mtime === Date.UTC(2026, 9, 1), 'a session carries its folder, title, date and account: ' + JSON.stringify(c1));
  const lists = sent('session/list'), cursorPid = lists.find((x) => x.m.params.cursor === undefined && log().some((r) => r.pid === x.pid && r.start?.name === 'cursor-agent'))?.pid;
  const order = sent().filter((x) => x.pid === cursorPid).map((x) => x.m.method);
  ok(order.slice(0, 3).join() === 'initialize,authenticate,session/list', 'Cursor is listed after its login step: ' + order.join());
  ok(lists.some((x) => x.m.params.cursor === '1'), 'the second page is asked for with the cursor');
  ok(log().filter((r) => r.start && r.start.name === 'cursor-agent').every((r) => r.start.argv.join(' ') === 'acp'), 'the listing process is the bare ACP server');

  // ---- resuming a Cursor session
  const r = await s.api('/agents', 'POST', { cwd: PROJ, sessionId: c1.id, account: 'cursor', permissionMode: 'manual' });
  ok(r.status === 201, 'the Cursor session is resumed: ' + r.text.slice(0, 160));
  const id = r.j.id;
  const ev = await eventsOf(id);
  const prompts = ev.filter((e) => e.type === 'user_prompt').map((e) => e.text);
  ok(prompts.join('|') === 'list the files please|thanks', 'its user messages are in the chat, without the swarm instructions: ' + JSON.stringify(prompts));
  const tool = ev.find((e) => e.type === 'assistant' && e.message.content.some((b) => b.type === 'tool_use' && b.name === 'Bash' && b.input.command === 'ls'));
  const res = ev.find((e) => e.type === 'user' && e.message.content[0]?.content === 'a.txt\nb.txt\n');
  ok(tool && res, 'its shell call and output are in the chat');
  const texts = ev.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((b) => b.type === 'text').map((b) => b.text));
  ok(texts.join('|') === 'There are two files.|You are welcome.', 'and its replies: ' + JSON.stringify(texts));
  ok(ev.some((e) => e.type === 'assistant' && e.message.content.some((b) => b.type === 'thinking' && b.thinking === 'I should run ls')), 'and its thinking');
  const ra = await agentOf(id);
  ok(ra.status === 'stopped' && ra.backend === 'cursor' && !sent('session/prompt').length, 'the agent waits for a message, on Cursor, with no process yet (like a resumed Claude session): ' + ra.status);

  await s.api(`/agents/${id}/send`, 'POST', { text: 'carry on' });
  await idle(id);
  const pid = sent('session/prompt').at(-1).pid;
  ok(sent('session/load').some((x) => x.pid === pid && x.m.params.sessionId === c1.id), 'its process loads the session');
  const p1 = sent('session/prompt').at(-1).m.params.prompt[0].text;
  ok(p1.startsWith('<swarm-instructions>') && p1.trimEnd().endsWith('carry on'), 'a session started outside the swarm gets the swarm instructions with the next message');
  ok((await eventsOf(id)).filter((e) => e.type === 'user_prompt').length === 3, 'the replay of its own load is not added to the chat again');
  await s.api(`/agents/${id}/send`, 'POST', { text: 'and again' });
  await idle(id);
  ok(!sent('session/prompt').at(-1).m.params.prompt[0].text.includes('<swarm-instructions>'), 'only once');
  const live = (await sessions()).sessions.find((x) => x.id === c1.id);
  ok(live?.agent === id, 'History shows the session as live in that agent');

  // ---- OpenCode, and errors
  const ro = await s.api('/agents', 'POST', { cwd: PROJ, sessionId: 'ses_hist_opencode_2', account: 'opencode', permissionMode: 'manual' });
  ok(ro.status === 201 && (await eventsOf(ro.j.id)).some((e) => e.type === 'user_prompt' && e.text === 'thanks'), 'an OpenCode session is resumed with its conversation');
  const rg = await s.api('/agents', 'POST', { cwd: PROJ, sessionId: 'ses_hist_x', account: 'cursor', permissionMode: 'auto' });
  ok(rg.status === 400 && /can't use permission mode auto/.test(rg.j.error), 'a mode the CLI lacks is refused: ' + rg.j.error);
  const rb = await s.api('/agents', 'POST', { cwd: PROJ, sessionId: 'bad id!', account: 'cursor' });
  ok(rb.status === 400 && /bad session id/.test(rb.j.error), 'a malformed session id is refused');

  // ---- the History dialog
  if (await chromeAvailable()) {
    const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // sign in through the context's cookie jar: loading the login page first races its own redirect with the next goto (ERR_ABORTED)
      await page.context().request.post(s.base.replace('127.0.0.1', 'localhost') + '/auth/token', { data: { token: s.token } });
      await page.goto(s.base.replace('127.0.0.1', 'localhost') + '/?r=1#/history');
      await page.waitForSelector('#hdlg[open] .hrow', { timeout: 10000 });
      await page.fill('#hq', 'cursor-agent session 2');
      const row = page.locator('#hlist .hrow', { hasText: 'Old cursor-agent session 2' });
      await row.waitFor({ timeout: 5000 });
      ok(/Cursor/.test(await row.locator('.hm').textContent()), "the row names the session's CLI: " + await row.locator('.hm').textContent());
      await page.selectOption('#hacct', 'claude');
      await page.selectOption('#hmode', 'auto');
      const before = new Set((await s.api('/agents')).j.map((a) => a.id));
      await row.click();
      const na = await waitFor(async () => (await s.api('/agents')).j.find((a) => !before.has(a.id)), 10000);
      ok(na?.backend === 'cursor' && na.account === 'cursor' && na.permissionMode === 'manual', 'resuming from the dialog uses the Cursor account and a mode Cursor has (Claude and auto were picked): ' + JSON.stringify(na && { b: na.backend, a: na.account, m: na.permissionMode }));
      ok(!errors.length, 'no page errors: ' + errors.join(' | '));
    } finally { await browser.close(); }
  } else console.log('  (Chrome not available: History dialog not checked)');
} catch (e) {
  ok(false, 'history test crashed: ' + e.stack);
} finally {
  if (c.fails) console.log(s.log().slice(-3000));
  await s.stop();
}
c.done();
