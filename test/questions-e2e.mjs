// AskUserQuestion end to end against a SPARE instance (never the live server); makes no model calls. With no BASE it starts
// its own instance on a free port with a throwaway database and the fake CLI first in PATH:
//   node test/questions-e2e.mjs
// or against an instance you started (fake CLI first in PATH, see test/models-e2e.mjs):
//   BASE=http://127.0.0.1:4793 TOKEN=t node test/questions-e2e.mjs
// Plays the CLI's side through swarm-mcp.js's `approve` tool (the --permission-prompt-tool), the way claude asks:
//  - the question shows in the approvals list as kind "question"; "allow" and bad answers are refused
//  - list_agents / read_agent / wait_for_agent / list_rooms say the agent waits on a question, not an approval
//  - the chat card (desktop and phone): options, multi-select, "Other" text; Submit returns
//    updatedInput = { ...input, answers: { [question]: "Label" | "A, B" | other text } }; the card then shows the answers
//  - Decline denies; the approvals inbox answers a question too
// Needs playwright-core and Chrome.
import { agentToken, spareHome } from './lib/spare.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
let BASE = process.env.BASE, TOKEN = process.env.TOKEN, server = null;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'questions-e2e-'));

if (!BASE) {
  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  TOKEN = 'questions-e2e-' + Date.now();
  BASE = 'http://127.0.0.1:' + port;
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, ...spareHome(scratch), PORT: String(port), HOST: '127.0.0.1', HALAY_DB: path.join(scratch, 'halay.db'), HALAY_TOKEN: TOKEN, PATH: path.join(ROOT, 'test/fake-claude') + ':' + process.env.PATH },
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
// a swarm MCP server as claude runs it for agent `agent`; call(tool, args) -> the tool's text
function mcp(agent, role) {
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'swarm-mcp.js')], { env: { ...process.env, HALAY_URL: BASE, HALAY_TOKEN: agentToken({ token: TOKEN }, agent), HALAY_AGENT: agent, HALAY_ROLE: role || '' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waits = new Map(); let n = 0;
  readline.createInterface({ input: p.stdout }).on('line', (l) => { const m = JSON.parse(l); waits.get(m.id)?.(m.result); waits.delete(m.id); });
  const rpc = (method, params) => new Promise((r) => { const id = ++n; waits.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return { call: async (name, args) => (await rpc('tools/call', { name, arguments: args })).content[0].text, kill: () => p.kill(), init: () => rpc('initialize', {}) };
}

const Q = {
  questions: [
    { question: 'Which color do you prefer?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Green', description: 'calm' }, { label: 'Blue', description: 'cool' }] },
    { question: 'Which fruits do you like?', header: 'Fruits', multiSelect: true, options: [{ label: 'Apple', description: 'crunchy' }, { label: 'Banana, ripe', description: 'label with a comma' }, { label: 'Cherry', description: 'small' }] },
    { question: 'Anything else?', header: 'Notes', multiSelect: false, options: [{ label: 'No', description: 'nothing' }, { label: 'Yes', description: 'tell me' }] },
  ],
};
const waitFor = async (f, ms = 5000) => { for (let t = Date.now(); Date.now() - t < ms; await sleep(100)) { const v = await f(); if (v) return v; } return null; };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const made = [], procs = [];
try {
  const dir = path.join(scratch, 'w'); fs.mkdirSync(dir);
  const parent = (await api('/agents', 'POST', { cwd: dir, name: 'q parent' })).j;
  const asker = (await api('/agents', 'POST', { cwd: dir, name: 'q asker', parentId: parent.id })).j;
  made.push(asker.id, parent.id);
  ok(parent.id && asker.id, 'agents created');
  const cli = mcp(asker.id), cond = mcp(parent.id, 'conductor');
  procs.push(cli, cond);
  await cli.init(); await cond.init();

  // 1. claude asks through the permission prompt tool
  let answer = cli.call('approve', { tool_name: 'AskUserQuestion', input: Q, tool_use_id: 'toolu_q1' }).then(JSON.parse);
  const appr = await waitFor(async () => (await api('/approvals')).j.find((x) => x.agentId === asker.id));
  ok(appr?.kind === 'question' && appr.questions?.length === 3 && !appr.rule, 'approvals list: kind question, the questions, no "always allow" rule');
  ok((await api('/approvals/' + appr.reqId, 'POST', { decision: 'allow' })).status === 400, 'plain allow refused for a question (it would answer nothing)');
  ok((await api('/approvals/' + appr.reqId, 'POST', { decision: 'answer', answers: { 'Not asked?': 'x' } })).status === 400, 'answer to an unknown question refused');
  ok((await api('/approvals/' + appr.reqId, 'POST', { decision: 'answer', answers: [] })).status === 400, 'empty answers refused');
  const sum = (await api('/agents')).j.find((a) => a.id === asker.id);
  ok(sum?.waiting?.questions === 1 && !sum.waiting.approvals, 'agent summary: waiting on 1 question');

  // 2. what the conductor sees
  const la = await cond.call('list_agents', {});
  ok(/q asker.*BLOCKED: waiting for the user to answer its question/.test(la), 'list_agents: blocked on a question');
  const ra = await cond.call('read_agent', { agent_id: asker.id });
  ok(ra.includes('BLOCKED: waiting for the user to answer a question: "Which color do you prefer?"') && !ra.includes('to approve'), 'read_agent: names the question, not an approval');
  const wa = await cond.call('wait_for_agent', { agent_id: asker.id, timeout_seconds: 1 });
  ok(wa.includes('answer a question') && !wa.includes('to approve'), 'wait_for_agent: blocked on a question');
  const room = await api('/rooms', 'POST', { name: 'q room', goal: 'test', members: [asker.id] });
  const lr = await cli.call('list_rooms', {}); // as a member: rooms are listed per agent (the conductor is the swarm chat)
  ok(room.j.members?.[0]?.blocked && room.j.members[0].question && lr.includes('@q-asker (q asker, BLOCKED on a question for the user'), 'rooms: member blocked on a question' + (lr.includes('BLOCKED') ? '' : ` (${lr})`));

  // 3. the chat card, desktop
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // sign in through the context's cookie jar: loading the login page first races its own redirect with the next goto (ERR_ABORTED)
  await page.context().request.post(BASE.replace('127.0.0.1', 'localhost') + '/auth/token', { data: { token: TOKEN } });
  await page.goto(BASE.replace('127.0.0.1', 'localhost') + '/?r=1#/a/' + asker.id);
  const card = page.locator('.msg.perm.askc').last();
  await card.waitFor({ timeout: 10000 });
  ok(await card.locator('fieldset').count() === 3 && await card.locator('input[type=radio]').count() === 3 + 1 + 2 + 1 && await card.locator('input[type=checkbox]').count() === 4, 'card: 3 questions, radios / checkboxes with an Other each');
  ok(await card.locator('button[type=submit]').isDisabled(), 'Submit disabled until something is answered');
  ok((await card.textContent()).includes('label with a comma') && (await card.textContent()).includes('Fruits'), 'card shows headers and option descriptions');
  await card.locator('label', { hasText: 'Green' }).click();
  await card.locator('label', { hasText: 'Apple' }).click();
  await card.locator('label', { hasText: 'Banana, ripe' }).click();
  await card.locator('fieldset').nth(1).locator('.askother input[type=text]').fill('Mango');
  await card.locator('fieldset').nth(2).locator('.askother input[type=text]').fill('ship it on Friday');
  await page.screenshot({ path: path.join(scratch, 'desktop.png') });
  await card.locator('button[type=submit]').click();
  const d = await Promise.race([answer, sleep(5000).then(() => null)]);
  ok(d?.behavior === 'allow' && d.updatedInput?.questions?.length === 3, 'Submit allows the call with the original questions');
  ok(JSON.stringify(d?.updatedInput?.answers) === JSON.stringify({ 'Which color do you prefer?': 'Green', 'Which fruits do you like?': 'Apple, "Banana, ripe", Mango', 'Anything else?': 'ship it on Friday' }),
    'answers: label, comma-joined multi-select (comma label quoted, Other appended), Other text: ' + JSON.stringify(d?.updatedInput?.answers));
  ok(await page.waitForFunction(() => [...document.querySelectorAll('.msg.perm.askc.done .askdone')].at(-1)?.textContent.includes('Apple, "Banana, ripe", Mango'), null, { timeout: 5000 }).then(() => true, () => false), 'card settles into the answers');
  ok(!(await api('/agents')).j.find((a) => a.id === asker.id)?.waiting, 'agent no longer waiting');

  // 4. phone: Decline denies
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  phone.on('pageerror', (e) => errors.push(e.message));
  // sign in through the context's cookie jar: loading the login page first races its own redirect with the next goto (ERR_ABORTED)
  await phone.context().request.post(BASE.replace('127.0.0.1', 'localhost') + '/auth/token', { data: { token: TOKEN } });
  answer = cli.call('approve', { tool_name: 'AskUserQuestion', input: Q, tool_use_id: 'toolu_q2' }).then(JSON.parse);
  await phone.goto(BASE.replace('127.0.0.1', 'localhost') + '/?r=1#/a/' + asker.id);
  const pc = phone.locator('.msg.perm.askc:not(.done)').last();
  await pc.waitFor({ timeout: 10000 });
  const box = await pc.locator('.asko').first().boundingBox(), cw = await pc.boundingBox();
  ok(box && box.height >= 44 && cw && cw.x >= 0 && cw.x + cw.width <= 390 + 1, `phone: options are touch-sized (${box?.height}px) and the card fits the screen`);
  ok(await pc.locator('.askother input[type=text]').first().evaluate((e) => getComputedStyle(e).fontSize) === '16px', 'phone: Other field is 16px (no iOS zoom)');
  await phone.screenshot({ path: path.join(scratch, 'phone.png'), fullPage: false });
  await pc.locator('button', { hasText: 'Decline' }).click();
  const dd = await Promise.race([answer, sleep(5000).then(() => null)]);
  ok(dd?.behavior === 'deny' && /declined to answer/.test(dd.message), 'Decline denies: ' + JSON.stringify(dd));
  ok(await phone.waitForFunction(() => [...document.querySelectorAll('.msg.perm.askc.done .askdone')].at(-1)?.textContent.includes('Declined'), null, { timeout: 5000 }).then(() => true, () => false), 'card shows Declined');

  // 5. the approvals inbox answers a question
  answer = cli.call('approve', { tool_name: 'AskUserQuestion', input: { questions: [Q.questions[0]] }, tool_use_id: 'toolu_q3' }).then(JSON.parse);
  await waitFor(async () => (await api('/approvals')).j.length);
  await page.evaluate(() => { location.hash = '#/approvals'; });
  const ic = page.locator('#alist .msg.perm.askc');
  await ic.waitFor({ timeout: 10000 });
  await ic.locator('label', { hasText: 'Blue' }).click();
  await ic.locator('button[type=submit]').click();
  const di = await Promise.race([answer, sleep(5000).then(() => null)]);
  ok(di?.behavior === 'allow' && di.updatedInput?.answers?.['Which color do you prefer?'] === 'Blue', 'approvals inbox: answered');

  // 6. an ordinary approval still works the old way
  answer = cli.call('approve', { tool_name: 'Bash', input: { command: 'echo hi' } }).then(JSON.parse);
  const ba = await waitFor(async () => (await api('/approvals')).j.find((x) => x.tool_name === 'Bash'));
  ok(ba?.kind === 'approval' && ba.rule === 'Bash(echo:*)', 'tool approval: kind approval');
  ok(/to approve Bash\(echo:\*\)/.test(await cond.call('wait_for_agent', { agent_id: asker.id, timeout_seconds: 1 })), 'wait_for_agent: blocked on an approval');
  ok((await api('/approvals/' + ba.reqId, 'POST', { decision: 'answer', answers: ['x'] })).status === 400, '"answer" refused for a tool approval');
  await api('/approvals/' + ba.reqId, 'POST', { decision: 'allow' });
  const da = await Promise.race([answer, sleep(5000).then(() => null)]);
  ok(da?.behavior === 'allow' && da.updatedInput?.command === 'echo hi', 'tool approval allowed with its input');
  ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  if (process.env.KEEP_SHOTS) for (const f of ['desktop.png', 'phone.png']) fs.copyFileSync(path.join(scratch, f), path.join(process.env.KEEP_SHOTS, f));
} catch (e) {
  ok(false, 'unexpected error: ' + (e.stack || e));
} finally {
  await browser.close();
  for (const p of procs) p.kill();
  for (const id of made) await api('/agents/' + id, 'DELETE').catch(() => {});
  if (server) server.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
