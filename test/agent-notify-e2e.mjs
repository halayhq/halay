// Child -> parent turn notifications (agent-notify.js, Agent.turnEnded/queueNotice/flushNotices in server.js): when an
// agent started through the swarm MCP ends a turn its parent asked for, the parent gets an automatic "[agent notification]"
// user turn (marked agentNotify), at once when idle, after its turn when busy, coalesced, never while it waits on that
// child in wait_for_agent, not for turns the user started in the child's own chat, not with notify=false, with a loop guard.
// Agents run on the fake claude (test/fake-claude: every stdin line is answered with a finished turn, after N seconds for
// fake-sleep-N). The parent's swarm tools are driven with its own agent token, the way swarm-mcp.js calls the server.
import { startSpare, checker, newAgent, waitFor, agentToken, sleep } from './lib/spare.mjs';

const c = checker();
const s = await startSpare({ tag: 'anotify', env: { HALAY_TERMINAL: '0', HALAY_BACKENDS: 'claude', HALAY_NOTIFY_BLOCKED_SECS: '1' } });
const as = (tok) => async (p, method = 'GET', body, opts = {}) => {
  const r = await fetch(s.base + p, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: opts.signal });
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
};
const agent = async (id) => (await s.api(`/agents/${id}?all=1`)).j;
const notes = async (id) => (await agent(id)).events.filter((e) => e.type === 'user_prompt' && e.agentNotify);
const idle = (id, ms = 15000) => waitFor(async () => (await agent(id)).status === 'idle', ms);
const notesAbout = async (p, kid) => (await notes(p)).filter((e) => e.agentNotify.includes(kid));

try {
  const P = await newAgent(s, { name: 'Parent', prompt: 'hi', permissionMode: 'manual' });
  c.ok(await idle(P), 'the parent is up and idle');
  const parent = as(agentToken(s, P));
  const spawn = async (body) => { const r = await parent('/api/agents', 'POST', { cwd: s.dir, ...body }); if (r.status !== 201) throw new Error('spawn: ' + r.text); return r.j; };
  const drop = (id) => parent(`/api/agents/${id}`, 'DELETE');

  // 1. an idle parent is woken when its child's first turn ends
  const k1 = await spawn({ name: 'Kid one', prompt: 'do it' });
  c.ok(k1.parentId === P && k1.notify === true, 'the child is the parent\'s, notify on by default');
  let n = await waitFor(async () => (await notesAbout(P, k1.id))[0], 10000);
  c.ok(!!n, 'idle parent: woken with a notification');
  c.ok(n && n.text.startsWith('[agent notification]') && n.text.includes(k1.id) && n.text.includes('"Kid one"') && /finished its turn/.test(n.text) && n.text.includes('fake turn'),
    'it names the child, the outcome and the result: ' + n?.text.slice(0, 160));
  c.ok(/not from the user/.test(n?.text || ''), 'it says it is automatic');
  c.ok(await idle(P), 'the parent answered it and is idle again');
  await sleep(500);
  c.ok((await notesAbout(P, k1.id)).length === 1, 'exactly one notification for that turn');

  // a turn the user starts in the child's own chat does not wake the parent
  await s.api(`/agents/${k1.id}/send`, 'POST', { text: 'from the user' });
  await idle(k1.id); await sleep(600);
  c.ok((await notesAbout(P, k1.id)).length === 1, "a turn the user started in the child's chat doesn't notify the parent");
  // a follow-up from the parent does
  await parent(`/api/agents/${k1.id}/send`, 'POST', { text: 'again' });
  c.ok(!!await waitFor(async () => (await notesAbout(P, k1.id)).length === 2, 10000), "the parent's send_message turn notifies again");
  await idle(P);
  await drop(k1.id);

  // 2 + 3. a busy parent gets them after its turn, coalesced into one message
  await s.api(`/agents/${P}/send`, 'POST', { text: 'busy fake-sleep-3' });
  await waitFor(async () => (await agent(P)).status === 'running', 3000);
  const k2 = await spawn({ name: 'Kid two', prompt: 'a' });
  const k3 = await spawn({ name: 'Kid three', prompt: 'b' });
  await idle(k2.id); await idle(k3.id); await sleep(300);
  c.ok((await agent(P)).status === 'running' && !(await notesAbout(P, k2.id)).length, 'busy parent: nothing delivered mid-turn');
  n = await waitFor(async () => (await notesAbout(P, k2.id))[0], 10000);
  c.ok(!!n, 'busy parent: delivered after its turn');
  c.ok(n && n.agentNotify.length === 2 && n.agentNotify.includes(k3.id) && n.text.includes('2 agents you started have news'), 'coalesced: both children in one message');
  c.ok((await notes(P)).filter((e) => e.agentNotify.includes(k3.id)).length === 1, 'and only once');
  await idle(P);
  const ui = (await agent(P)).events.findLast((e) => e.agentNotify);
  c.ok(ui?.type === 'user_prompt', 'stored as a user_prompt marked agentNotify (the UI shows it as a notification)');
  await drop(k2.id); await drop(k3.id);

  // 4. opt-out
  const k4 = await spawn({ name: 'Quiet', prompt: 'x', notify: false });
  c.ok(k4.notify === false, 'notify=false is stored on the agent');
  await idle(k4.id); await sleep(800);
  c.ok(!(await notesAbout(P, k4.id)).length, 'notify=false: the parent is not woken');
  await drop(k4.id);

  // 5. no notification while the parent waits on that child (wait_for_agent returns the result)
  const k5 = await spawn({ name: 'Waited', prompt: 'first' });
  await waitFor(async () => (await notesAbout(P, k5.id)).length === 1, 10000); await idle(P);
  await parent(`/api/agents/${k5.id}/send`, 'POST', { text: 'slow fake-sleep-2' });
  const w = await parent(`/api/agents/${k5.id}/wait`, 'POST', { timeout: 20 });
  c.ok(w.status === 200 && w.j.status === 'idle' && w.j.result === 'fake turn', 'wait_for_agent returns the result');
  await sleep(800);
  c.ok((await notesAbout(P, k5.id)).length === 1, 'no notification for the turn the parent waited on');
  // ... nor for a turn whose notice was still queued (parent busy) when the parent's wait consumed it
  await s.api(`/agents/${P}/send`, 'POST', { text: 'busy fake-sleep-2' });
  await waitFor(async () => (await agent(P)).status === 'running', 3000);
  await parent(`/api/agents/${k5.id}/send`, 'POST', { text: 'quick' });
  await idle(k5.id); await sleep(200);
  const w2 = await parent(`/api/agents/${k5.id}/wait`, 'POST', { timeout: 5 });
  c.ok(w2.j.status === 'idle', 'the wait returns at once (the child already finished)');
  await idle(P); await sleep(800);
  c.ok((await notesAbout(P, k5.id)).length === 1, 'a queued notice the wait consumed is dropped');
  // read_agent (seen=1) consumes it the same way
  await s.api(`/agents/${P}/send`, 'POST', { text: 'busy fake-sleep-2' });
  await waitFor(async () => (await agent(P)).status === 'running', 3000);
  await parent(`/api/agents/${k5.id}/send`, 'POST', { text: 'quick' });
  await idle(k5.id); await sleep(200);
  await parent(`/api/agents/${k5.id}?tail=400&seen=1`);
  await idle(P); await sleep(800);
  c.ok((await notesAbout(P, k5.id)).length === 1, 'read_agent consumes a queued notice too');

  // 6. blocked on the user for a while: the parent is told once
  await parent(`/api/agents/${k5.id}/send`, 'POST', { text: 'block fake-sleep-4' });
  await waitFor(async () => (await agent(k5.id)).status === 'running', 3000);
  const ac = new AbortController();
  const held = as(agentToken(s, k5.id))('/internal/permission', 'POST', { agentId: k5.id, tool_name: 'Bash', input: { command: 'rm -rf build' } }, { signal: ac.signal }).catch(() => null);
  n = await waitFor(async () => (await notesAbout(P, k5.id)).find((e) => /BLOCKED/.test(e.text)), 6000);
  c.ok(!!n && /approval/.test(n.text), 'blocked child: the parent is told it waits on an approval: ' + n?.text.slice(0, 200));
  ac.abort(); await held;
  await waitFor(async () => (await notesAbout(P, k5.id)).length === 3, 10000);
  const last = (await notesAbout(P, k5.id)).at(-1);
  c.ok(/finished its turn|ERROR/.test(last?.text || '') && (await notesAbout(P, k5.id)).filter((e) => /BLOCKED/.test(e.text)).length === 1, 'then once more when its turn ends (block told only once)');
  await idle(P);

  // 7. ping-pong guard: a parent woken again and again with no other message stops being woken after 20
  const before = (await notes(P)).length;
  for (let i = 0; i < 24; i++) {
    const had = (await notes(P)).length;
    await parent(`/api/agents/${k5.id}/send`, 'POST', { text: 'ping ' + i });
    const got = await waitFor(async () => (await notes(P)).length > had, 3000);
    await idle(P);
    if (!got) break;
  }
  const woke = (await notes(P)).length - before;
  const paused = (await agent(P)).events.some((e) => e.type === 'note' && /notifications paused/.test(e.text));
  c.ok(woke < 24 && paused, `loop guard: wake-ups stop (after ${woke} more) with a note in the parent's chat`);
  await s.api(`/agents/${P}/send`, 'POST', { text: 'the user speaks' });
  c.ok(!!await waitFor(async () => (await notes(P)).length > before + woke, 10000), "a message from the user resumes them (the held one is delivered after that turn)");
  await idle(P);

  // 8. a removed parent: the child's turn end is dropped, nothing breaks
  const P2 = await newAgent(s, { name: 'Parent two', prompt: 'hi' }); await idle(P2);
  const k6 = (await as(agentToken(s, P2))('/api/agents', 'POST', { cwd: s.dir, name: 'Orphan', prompt: 'slow fake-sleep-2' })).j;
  await s.api(`/agents/${P2}`, 'DELETE');
  await sleep(2500);
  c.ok((await s.api('/agents')).status === 200 && (await agent(k6.id)).status !== 'running', 'parent removed mid-turn of its child: dropped, server fine');
} catch (e) {
  c.ok(false, 'crashed: ' + e.stack);
  console.log(s.log().slice(-3000));
} finally {
  await s.stop();
}
c.done();
