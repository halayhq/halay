// Unit checks for pure functions that import without side effects (no server): node test/unit.mjs
//  - plugins.js satisfies() (semver ranges in plugin manifests); cleanSettings() is not exported, the plugin e2e covers it
//  - git-tools.js validBranch()
//  - rooms.js: createRooms on an in-memory database with stub agents: handles, @mention delivery, budget, rate limit, states
import Database from 'better-sqlite3';
import { satisfies, PLUGIN_API, PERMISSIONS, EVENTS } from '../src/plugins.js';
import { validBranch } from '../src/git-tools.js';
import { createRooms, DEFAULT_BUDGET, DEFAULT_RATE } from '../src/rooms.js';
import { checker } from './lib/spare.mjs';
const { ok, done } = checker();

// ---- satisfies
ok(satisfies('1.2.3', '*') && satisfies('1.2.3', '') && satisfies('1.2.3', undefined), 'satisfies: * and empty match anything');
ok(satisfies('1.2.3', '1') && satisfies('1.9.0', '1') && !satisfies('2.0.0', '1'), 'satisfies: "1" is 1.x');
ok(satisfies('1.2.9', '1.2') && !satisfies('1.3.0', '1.2'), 'satisfies: "1.2" is 1.2.x');
ok(satisfies('1.2.3', '1.2.3') && !satisfies('1.2.4', '1.2.3'), 'satisfies: exact version');
ok(satisfies('1.5.0', '^1.2') && !satisfies('2.0.0', '^1.2') && !satisfies('1.1.9', '^1.2'), 'satisfies: caret');
ok(satisfies('0.2.5', '^0.2') && !satisfies('0.3.0', '^0.2'), 'satisfies: caret on 0.x pins the minor');
ok(satisfies('1.2.9', '~1.2') && !satisfies('1.3.0', '~1.2.0'), 'satisfies: tilde');
ok(satisfies('1.2.3', '>=1.2') && satisfies('2.0.0', '>=1.2') && !satisfies('1.1.0', '>=1.2'), 'satisfies: >=');
ok(satisfies('1.0.1', '>1') === false || satisfies('1.0.1', '>1.0.0'), 'satisfies: >');
ok(satisfies('1.2.3', '<=1.2.3') && !satisfies('1.2.4', '<=1.2.3') && satisfies('1.2.2', '<1.2.3') && !satisfies('1.2.3', '<1.2.3'), 'satisfies: <= and <');
ok(satisfies('3.0.0', '^1 || ^3') && !satisfies('2.0.0', '^1 || ^3'), 'satisfies: || alternatives');
ok(satisfies('v1.2.3', 'v1.2.3'), 'satisfies: leading v');
ok(!satisfies('1.2.3', 'garbage') && !satisfies('1.2.3', '>=x'), 'satisfies: an unparsable range matches nothing');
ok(satisfies(PLUGIN_API, '*') && Object.keys(PERMISSIONS).length > 0 && EVENTS.includes('agent.started'), 'plugins: exported API constants are sane');

// ---- validBranch
ok(await validBranch('feature/x-1') && await validBranch('swarm/ab12cd34') && await validBranch('v1.0'), 'validBranch: normal names');
for (const bad of ['', '-x', '--help', 'a..b', 'a b', 'x.lock', 'a~1', 'a:b', '/x', null, 42, 'a'.repeat(200)])
  ok(!(await validBranch(bad)), `validBranch: refuses ${JSON.stringify(bad)?.slice(0, 20)}`);

// ---- rooms on an in-memory db with stub agents
function stubAgents(names) {
  const sends = [], map = new Map();
  for (const [id, name, bot] of names) map.set(id, { id, name, bot, role: null, status: 'idle', pendingApprovals: () => [], send: (t, o) => sends.push({ id, text: t, o }) });
  return { map, sends };
}
{
  const { map, sends } = stubAgents([['a1', 'Alpha'], ['a2', 'Beta'], ['a3', 'Beta'], ['b1', 'Whatever', 'helper']]);
  const events = [], notes = [];
  const rooms = createRooms({ db: new Database(':memory:'), agents: map, broadcast: (e) => events.push(e), notify: (a, k, t) => notes.push({ a: a.id, k, t }) });
  let req = null;
  const call = async (method, url, body, caller) => {
    let status = 0, data = null;
    const u = new URL('http://x' + url);
    const r = await rooms.handle({ method, headers: caller ? { 'x-halay-agent': caller } : {} }, u, {}, { json: (res, s, d) => { status = s; data = d; }, readBody: async () => body || {} });
    return { handled: r, status, j: data };
  };
  ok(DEFAULT_BUDGET === 20 && DEFAULT_RATE === 6, 'rooms: defaults');
  ok((await call('GET', '/api/nothing')).handled === false, 'rooms: unrelated paths are not handled');
  ok((await call('POST', '/api/rooms', { name: '  ' })).status === 400, 'rooms: name required');
  ok((await call('POST', '/api/rooms', { name: 'x', budget: 0 })).status === 400 && (await call('POST', '/api/rooms', { name: 'x', rate: 61 })).status === 400, 'rooms: budget 1-500 and rate 1-60');
  ok((await call('POST', '/api/rooms', { name: 'x', members: ['nope'] })).status === 400, 'rooms: unknown member refused');
  const r = await call('POST', '/api/rooms', { name: 'R', goal: 'g', members: ['a1', 'a2', 'a3', 'b1', 'a1'], budget: 2, rate: 1 });
  ok(r.status === 201 && r.j.members.length === 4, 'rooms: created, duplicate members collapsed');
  const h = Object.fromEntries(r.j.members.map((m) => [m.id, m.handle]));
  ok(h.a1 === 'alpha' && h.a2 === 'beta-a2' && h.a3 === 'beta-a3' && h.b1 === 'helper', `rooms: handles (collision gets the id, a bot uses its handle): ${JSON.stringify(h)}`);
  const id = r.j.id, post = (text, caller) => call('POST', `/api/rooms/${id}/messages`, { text }, caller);
  let p = await post('hi @alpha and @nobody and @helper');
  ok(p.status === 200 && p.j.delivered?.length === 2 && p.j.unknown?.[0] === '@nobody', 'rooms: user mention delivers to each member, unknown handles are reported');
  ok(sends.length === 2 && sends[0].text.includes('You are @alpha') && sends[0].o.room === id, 'rooms: delivered turn names the handle and room');
  ok((await post('email me at foo@alpha.com')).j.delivered.length === 0, 'rooms: an @ inside an address is not a mention');
  sends.length = 0;
  p = await post('@all go');
  ok(p.j.delivered.length === 4, 'rooms: @all from the user reaches everyone');
  ok((await post('@all x', 'a1')).status === 400, 'rooms: an agent cannot @all');
  ok((await post('@alpha x', 'a1')).status === 400, 'rooms: an agent cannot mention itself');
  sends.length = 0;
  p = await post('@beta-a2 one', 'a1');
  ok(p.j.delivered.length === 1, 'rooms: agent mention delivered');
  p = await post('@beta-a3 two', 'a1');
  ok(p.j.delivered.length === 0 && /rate limit/.test(p.j.skipped[0]), 'rooms: per-agent rate limit (rate=1)');
  p = await post('@beta-a3 three', 'a2');
  ok(p.j.delivered.length === 1, 'rooms: rate limit is per sender');
  p = await post('@alpha four', 'a3');
  ok(p.j.delivered.length === 0 && /budget/.test(p.j.skipped[0]), 'rooms: budget (2) spent: further mentions are not delivered');
  ok((await call('GET', `/api/rooms/${id}`)).j.status === 'paused', 'rooms: over budget pauses the room');
  ok((await post('@alpha five', 'a2')).status === 409, 'rooms: paused room refuses agent posts');
  ok((await call('POST', `/api/rooms/${id}/resume`, {}, 'a1')).status === 403, 'rooms: an agent cannot resume');
  ok((await call('POST', `/api/rooms/${id}/resume`)).j.status === 'active' && (await call('GET', `/api/rooms/${id}`)).j.used === 0, 'rooms: user resume reopens and resets the budget');
  ok((await call('POST', `/api/rooms/${id}/done`, { summary: '' }, 'a1')).status === 400, 'rooms: done needs a summary');
  ok((await call('POST', `/api/rooms/${id}/done`, { summary: 'fine' }, 'a1')).j.status === 'done', 'rooms: an agent marks it done');
  ok((await post('@alpha late', 'a2')).status === 409, 'rooms: done room refuses agent posts');
  ok((await post('reopen')).status === 200 && (await call('GET', `/api/rooms/${id}`)).j.status === 'active', 'rooms: a user message reopens a done room');
  await call('PATCH', `/api/rooms/${id}`, { archived: true });
  ok((await post('x')).status === 409 && (await post('x', 'a1')).status === 409, 'rooms: archived refuses everyone');
  ok((await call('POST', '/api/rooms', { name: 'n' }, 'a1')).status === 403, 'rooms: an agent cannot create rooms');
  ok((await call('GET', '/api/rooms', null, 'ghost')).status === 403, 'rooms: unknown caller agent refused');
  ok(rooms.promptFor('a1') === '' || !rooms.promptFor('a1').includes('"R"'), 'rooms: archived rooms are left out of the agent prompt');
}
done();
