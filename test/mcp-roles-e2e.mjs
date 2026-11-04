// swarm-mcp.js tool gating by role (conductor = the swarm chat, agent = any other agent) against a SPARE instance it
// starts itself (fake claude): node test/mcp-roles-e2e.mjs
// Checks the tools/list of each role, that a gated tool cannot be called by name, and the behaviour behind rooms, bots,
// schedules, tasks and agent control (an agent only controls the agents it started).
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { startSpare, newAgent, checker, ROOT, agentToken } from './lib/spare.mjs';
const { ok, done } = checker();
const s = await startSpare({ tag: 'mcp' });
const procs = [];
function mcp(agent, role) {
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'swarm-mcp.js')], { env: { ...process.env, HALAY_URL: s.base, HALAY_TOKEN: agentToken(s, agent), HALAY_AGENT: agent, HALAY_ROLE: role || '' }, stdio: ['pipe', 'pipe', 'inherit'] });
  procs.push(p);
  const waits = new Map(); let n = 0;
  readline.createInterface({ input: p.stdout }).on('line', (l) => { const m = JSON.parse(l); waits.get(m.id)?.(m); waits.delete(m.id); });
  const rpc = (method, params) => new Promise((r) => { const id = ++n; waits.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  return {
    tools: async () => (await rpc('tools/list', {})).result.tools.map((t) => t.name),
    call: async (name, args = {}) => { const m = await rpc('tools/call', { name, arguments: args }); return m.error ? { error: true, text: m.error.message } : { error: !!m.result.isError, text: m.result.content[0].text }; },
  };
}
try {
  const con = (await s.api('/conductor', 'POST', {})).j;
  ok(con.id && con.role === 'conductor', 'the swarm chat (conductor) exists');
  const A = await newAgent(s, { name: 'Ann' }), B = await newAgent(s, { name: 'Ben' });
  const C = mcp(con.id, 'conductor'), a = mcp(A, ''), b = mcp(B, '');

  // ---- tool lists
  const ct = await C.tools(), at = await a.tools();
  const agentOnlyGone = ['create_bot', 'list_bots', 'update_bot', 'create_room', 'update_room', 'add_to_room', 'remove_from_room', 'open_agent', 'list_accounts', 'list_sessions', 'list_tasks', 'get_task', 'add_task', 'update_task', 'delete_task', 'assign_task', 'list_peers'];
  ok(agentOnlyGone.every((t) => ct.includes(t)), 'conductor has the bots, room-admin, task, session and peer tools');
  ok(agentOnlyGone.every((t) => !at.includes(t)), 'a regular agent has none of them');
  const common = ['list_agents', 'start_agent', 'send_message', 'read_agent', 'wait_for_agent', 'remove_agent', 'interrupt_agent', 'list_schedules', 'add_schedule', 'update_schedule', 'delete_schedule', 'run_schedule_now', 'list_rooms', 'read_room', 'post_to_room', 'mark_room_done', 'approve'];
  ok(common.every((t) => ct.includes(t) && at.includes(t)), 'both roles have agents, schedules, room reading/posting/done and approve');
  ok(ct.length === new Set(ct).size && at.length === new Set(at).size, 'no duplicate tools');
  for (const t of ['create_room', 'create_bot', 'add_task']) {
    const r = await a.call(t, { name: 'x', role: 'x', title: 'x' });
    ok(r.error, `an agent calling ${t} by name is refused: ${r.text.slice(0, 50)}`);
  }

  // ---- rooms
  let r = await C.call('create_room', { name: 'Squad', goal: 'g', members: [A] });
  ok(!r.error && /Squad/.test(r.text), 'conductor: create_room');
  const rooms = (await s.api('/rooms')).j, rid = rooms[0].id;
  ok(!(await C.call('add_to_room', { room_id: rid, agent_id: B })).error, 'conductor: add_to_room');
  ok((await a.call('list_rooms')).text.includes('Squad'), 'agent: list_rooms shows its room');
  r = await a.call('post_to_room', { room_id: rid, text: 'hello @ben' });
  ok(!r.error, 'agent in the room: post_to_room');
  ok(!(await a.call('mark_room_done', { room_id: rid, summary: 'done' })).error, 'agent in the room: mark_room_done');
  await s.api(`/rooms/${rid}/messages`, 'POST', { text: 'reopen' });
  await C.call('create_room', { name: 'Private', members: [B] }); const rid2 = (await s.api('/rooms')).j.find((x) => x.name === 'Private').id;
  ok((await a.call('list_rooms')).text.includes('Squad') && !(await a.call('list_rooms')).text.includes('Private'), 'agent: list_rooms hides rooms it is not in');
  ok((await a.call('read_room', { room_id: rid2 })).error, 'agent: read_room of a foreign room is refused');
  ok((await a.call('post_to_room', { room_id: rid2, text: 'hi' })).error, 'agent: post_to_room to a foreign room is refused');
  ok((await C.call('list_rooms')).text.includes('Private'), 'conductor: list_rooms shows every room');
  ok(!(await C.call('read_room', { room_id: rid2 })).error, 'conductor: read_room of any room');
  ok((await s.api('/rooms', 'POST', { name: 'hack' }, { 'x-halay-agent': A })).status === 403, 'server side: an agent cannot create rooms either');
  ok((await s.api('/rooms', 'POST', { name: 'viaconductor' }, { 'x-halay-agent': con.id })).status === 201, 'server side: the conductor can');

  // ---- bots
  r = await C.call('create_bot', { name: 'MCP Bot', handle: 'mcpbot' + Date.now().toString(36), role: 'You test.' });
  ok(!r.error, 'conductor: create_bot');
  ok((await C.call('list_bots')).text.includes('MCP Bot'), 'conductor: list_bots');

  // ---- tasks (conductor only)
  r = await C.call('add_task', { title: 'Do it', prompt: 'p' });
  ok(!r.error, 'conductor: add_task');
  ok((await C.call('list_tasks')).text.includes('Do it'), 'conductor: list_tasks');

  // ---- schedules: an agent changes only its own
  const sched = (args) => ({ title: 't', cron: '0 9 * * *', one_off: true, prompt: 'p', ...args });
  r = await a.call('add_schedule', sched({ title: 'ann-s' }));
  ok(!r.error, 'agent: add_schedule');
  const list = (await s.api('/schedules')).j, mine = list.find((x) => x.title === 'ann-s');
  ok(mine && mine.createdBy === A, 'the schedule records its creator');
  ok((await b.call('update_schedule', { schedule_id: mine.id, enabled: false })).error, 'another agent cannot update it (tool)');
  ok((await b.call('delete_schedule', { schedule_id: mine.id })).error, 'another agent cannot delete it (tool)');
  ok((await s.api('/schedules/' + mine.id, 'PATCH', { enabled: false }, { 'x-halay-agent': B })).status === 403, 'another agent cannot update it (server)');
  ok((await s.api('/schedules/' + mine.id + '/run', 'POST', {}, { 'x-halay-agent': B })).status === 403, 'another agent cannot run it (server)');
  ok(!(await a.call('update_schedule', { schedule_id: mine.id, enabled: false })).error, 'the owner can update it');
  ok(!(await C.call('update_schedule', { schedule_id: mine.id, enabled: true })).error, 'the conductor can update any schedule');
  const user = (await s.api('/schedules', 'POST', sched({ title: 'user-s' }))).j;
  ok((await a.call('update_schedule', { schedule_id: user.id, enabled: false })).error && (await a.call('delete_schedule', { schedule_id: user.id })).error, 'an agent cannot change the user\'s schedule');
  ok((await s.api('/schedules/' + user.id, 'DELETE', undefined, { 'x-halay-agent': A })).status === 403, 'the same on the server');
  ok(!(await C.call('delete_schedule', { schedule_id: user.id })).error, 'the conductor can delete the user\'s schedule');
  ok(!(await a.call('delete_schedule', { schedule_id: mine.id })).error, 'the owner can delete its schedule');

  // ---- agent control: an agent controls only what it started
  const child = await a.call('start_agent', { prompt: 'x', one_off: true, name: 'ann-child' });
  ok(!child.error, 'agent: start_agent: ' + child.text.slice(0, 60));
  const childId = (child.text.match(/\b([0-9a-f]{8})\b/) || [])[1];
  ok(childId && (await a.call('list_agents')).text.includes(childId) && !(await a.call('list_agents')).text.includes(B), 'agent: list_agents shows only its own children');
  ok((await a.call('send_message', { agent_id: B, text: 'hi' })).error, 'agent: send_message to an agent it did not start is refused');
  ok((await a.call('remove_agent', { agent_id: B })).error, 'agent: remove_agent of a foreign agent is refused');
  ok(!(await C.call('send_message', { agent_id: B, text: 'hi' })).error, 'conductor: send_message to any agent');
  ok((await C.call('list_agents')).text.includes(B), 'conductor: list_agents sees everyone');
} catch (e) { ok(false, 'unexpected exception: ' + (e.stack || e)); }
finally { procs.forEach((p) => p.kill()); await s.stop(); }
done();
