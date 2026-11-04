// Messages from other Claude sessions in an agent's chat (peer-messages.js, Agent.scanPeers and importTranscript in
// server.js, agentMsg in public/js/chat.js). The real CLI prints no text for them on stdout, only a command_lifecycle
// event, so the server reads them from the session's transcript. The fake claude (test/fake-claude/peer-turn.mjs, on a
// "fake-peer" message) writes that transcript the way the CLI does: one peer message while idle, one mid-turn, and a
// SendMessage reply. Checked: the live events (in order, the turn shown running), the same after a server restart, the
// same rebuilt from the transcript when the session is resumed in a new agent, and (with Chrome) how the chat shows them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startSpare, checker, newAgent, waitFor, ROOT, chromeAvailable } from './lib/spare.mjs';

const c = checker();
// a HOME of its own: the fake claude writes its transcript under $HOME/.claude/projects, never the user's
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-peer-home-')));
const proj = path.join(home, 'proj');
fs.mkdirSync(proj);
const s = await startSpare({ tag: 'peer', env: { HOME: home, HALAY_TERMINAL: '0', HALAY_BACKENDS: 'claude' } });
const agent = async (id) => (await s.api(`/agents/${id}?all=1`)).j;
const SID = '00000000-0000-4000-8000-000000000000', A = 'uds:/tmp/cc-socks/31853.sock';

// the chat-relevant shape of an agent's events: peer messages, prompts, SendMessage calls, texts
function shape(events) {
  const out = [];
  for (const e of events) {
    if (e.type === 'peer_message') out.push(`peer:${e.fromName}${e.queued ? ':queued' : ''}:${e.text}`);
    else if (e.type === 'user_prompt') out.push('prompt');
    else if (e.type === 'assistant') for (const p of e.message?.content || []) {
      if (p.type === 'tool_use' && p.name === 'SendMessage') out.push(`send:${e._peerNames?.[p.input.to] || p.input.to}`);
      else if (p.type === 'tool_use') out.push('tool:' + p.name);
    }
  }
  return out;
}
const WANT = ['prompt', 'peer:wt-71:Please update the **site** and reply with a summary.', 'tool:Bash', 'peer:wt-26:queued:Also use the demo paths.', 'send:wt-71'];

try {
  const id = await newAgent(s, { cwd: proj, name: 'site', prompt: 'hello fake-peer', permissionMode: 'manual' });
  const statuses = [];
  let a = await waitFor(async () => { const x = await agent(id); statuses.push(x.status); return x.events?.some((e) => e.type === 'result' && e.result === 'Replied.') && x.status === 'idle' && x; }, 15000, 50);
  c.ok(!!a, 'the fake session ran the peer turn and is idle again');
  const got = shape(a?.events || []);
  c.ok(JSON.stringify(got) === JSON.stringify(WANT), 'live: the peer messages and the reply are in the chat, in order: ' + JSON.stringify(got));
  const pm = (a?.events || []).filter((e) => e.type === 'peer_message');
  c.ok(pm.length === 2 && pm[0].from === A && pm.every((e) => e.msgId && e._ts), 'each peer message has its sender address, an id and a time');
  const iPeer = (a?.events || []).findIndex((e) => e.type === 'peer_message'), iLife = (a?.events || []).findIndex((e) => e.type === 'command_lifecycle');
  c.ok(iPeer >= 0 && iPeer < iLife, 'the first one is placed before the turn it started');
  c.ok(statuses.includes('running'), 'the turn the peer message started shows the agent running');

  const r = await s.api(`/agents/${id}?all=1`);
  c.ok(/"peer_message"/.test(r.text), 'the events API returns them');

  // a page reload reads the stored events: the same after a server restart
  await s.restart({ HOME: home });
  const b = await agent(id);
  c.ok(JSON.stringify(shape(b.events || [])) === JSON.stringify(WANT), 'after a server restart: the same items');

  // resuming the session in a new agent rebuilds the chat from the transcript
  const transcript = path.join(home, '.claude', 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'), SID + '.jsonl');
  c.ok(fs.existsSync(transcript), 'the fake wrote a transcript where the server looks for it');
  const res = await s.api('/agents', 'POST', { cwd: proj, name: 'resumed', sessionId: SID, permissionMode: 'manual' });
  c.ok(res.status < 300, 'resume the session: ' + res.status);
  const rz = res.j.id && await agent(res.j.id);
  const rshape = shape(rz?.events || []);
  c.ok(JSON.stringify(rshape) === JSON.stringify(WANT), 'resumed from the transcript: the same items: ' + JSON.stringify(rshape));

  // the chat in a browser
  if (!(await chromeAvailable())) c.skip('Chrome not available: the chat rendering is not checked');
  else {
    const { chromium } = createRequire(path.join(ROOT, 'package.json'))('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await (await browser.newContext()).newPage();
      const base = s.base.replace('127.0.0.1', 'localhost');
      await page.context().request.post(base + '/auth/token', { data: { token: s.token } });
      await page.goto(base + '/?r=1#/a/' + id);
      await page.waitForSelector('.msg.pmsg.out', { timeout: 10000 });
      const items = await page.$$eval('#log > .msg', (els) => els.map((e) => [e.className, e.querySelector('.pmh')?.textContent.trim() || '', e.querySelector('.md')?.textContent.trim() || e.textContent.trim()]));
      const pmsg = items.filter(([k]) => k.includes('pmsg'));
      c.ok(pmsg.length === 3, 'three message items: ' + JSON.stringify(pmsg));
      c.ok(pmsg[0]?.[0].includes(' in') && pmsg[0][1] === 'Message from wt-71' && pmsg[0][2] === 'Please update the site and reply with a summary.', 'incoming: labelled with the sender, the text rendered as markdown');
      c.ok(pmsg[1]?.[1].startsWith('Message from wt-26') && /while it was working/.test(pmsg[1][1]), 'the mid-turn one says it came while working');
      c.ok(pmsg[2]?.[0].includes(' out') && pmsg[2][1] === 'Message to wt-71' && pmsg[2][2].startsWith('Done: the site is updated.'), 'outgoing SendMessage: recipient by name and the text, not a tool row');
      const order = items.map(([k, h]) => (k.includes('pmsg') ? h : k.includes('tgroup') ? 'tools' : k.includes(' user') ? 'user' : null)).filter(Boolean);
      c.ok(JSON.stringify(order) === JSON.stringify(['user', 'Message from wt-71', 'tools', order[3], 'Message to wt-71']) && order[3].startsWith('Message from wt-26'), 'in conversation order: ' + JSON.stringify(order));
      c.ok(!(await page.$$eval('.tc .tl', (els) => els.map((e) => e.textContent))).some((t) => /SendMessage/.test(t)), 'no anonymous SendMessage tool row');
    } finally { await browser.close(); }
  }
} catch (e) {
  c.ok(false, 'threw: ' + e.stack);
} finally {
  await s.stop();
  fs.rmSync(home, { recursive: true, force: true });
}
c.done();
