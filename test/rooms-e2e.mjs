// Rooms over REST against a SPARE instance it starts itself (fake claude, no model calls): node test/rooms-e2e.mjs
// Covers create/list/get, @mention routing to real agents (the turn reaches the agent's history), the budget (one per delivered
// mention) and the pause it causes, the per-agent rate limit, resume, done, archive, handle collisions, ?after=N&limit=L
// pagination, and what an agent caller (x-halay-agent) may and may not do.
import { startSpare, newAgent, checker, waitFor } from './lib/spare.mjs';
const { ok, done } = checker();
const s = await startSpare({ tag: 'rooms' });
try {
  const A = await newAgent(s, { name: 'Alice' }), B = await newAgent(s, { name: 'Bob' }), B2 = await newAgent(s, { name: 'Bob' }), C = await newAgent(s, { name: 'Carol' });
  const as = (id) => ({ 'x-halay-agent': id });
  const room = async (body) => (await s.api('/rooms', 'POST', body));

  // ---- create / list / validation
  ok((await room({})).status === 400, 'create: name required');
  ok((await room({ name: 'x', members: ['nope'] })).status === 400, 'create: unknown member refused');
  ok((await room({ name: 'x', budget: 501 })).status === 400 && (await room({ name: 'x', rate: 0 })).status === 400, 'create: budget and rate bounds');
  const r = await room({ name: 'Plan', goal: 'ship it', members: [A, B, B2, C], budget: 3, rate: 2 });
  ok(r.status === 201 && r.j.name === 'Plan' && r.j.status === 'active' && r.j.budget === 3 && r.j.rate === 2 && r.j.members.length === 4, 'create: 201 with members, budget, rate');
  const id = r.j.id, base = `/rooms/${id}`;
  ok((await s.api('/rooms')).j.some((x) => x.id === id), 'list: the room is listed');
  ok((await s.api('/rooms/9999')).status === 404, 'get: unknown room is 404');
  const hd = Object.fromEntries(r.j.members.map((m) => [m.id, m.handle]));
  ok(hd[A] === 'alice' && hd[B] === 'bob-' + B && hd[B2] === 'bob-' + B2 && hd[C] === 'carol', 'handles: equal names get their id appended');

  // ---- routing from the user
  const post = (text, caller) => s.api(base + '/messages', 'POST', { text }, caller ? as(caller) : {});
  let p = await post('@alice please look, cc @carol');
  ok(p.status === 200 && p.j.delivered.length === 2 && p.j.message.mentions.length === 2, 'user @mention: delivered to both mentioned agents');
  const gotTurn = await waitFor(async () => (await s.api('/agents/' + A)).j.events?.some((e) => String(e.text || '').includes('[Room "Plan"')));
  ok(gotTurn, 'the turn arrives in the mentioned agent\'s history');
  ok(!(await s.api('/agents/' + B)).j.events?.some((e) => String(e.text || '').includes('[Room "Plan"')), 'an unmentioned member gets no turn');
  p = await post('just chatting');
  ok(p.j.delivered.length === 0, 'unaddressed message is delivered to nobody');
  ok((await post('')).status === 400 && (await post('x'.repeat(8001))).status === 400, 'post: empty and over-long text refused');
  ok((await post('hello', 'ghost')).status === 403, 'post: unknown agent caller refused');

  // ---- rate limit (2/min) and budget (3 delivered agent mentions)
  p = await post('@carol one', A); ok(p.j.delivered.length === 1, 'agent mention 1 delivered');
  p = await post('@carol two', A); ok(p.j.delivered.length === 1, 'agent mention 2 delivered');
  p = await post('@carol three', A); ok(p.j.delivered.length === 0 && /rate limit/.test(p.j.skipped[0]), 'rate limit: the 3rd mention in a minute is skipped');
  ok((await s.api(base)).j.used === 2, 'a skipped mention does not use budget');
  p = await post('@alice back', C); ok(p.j.delivered.length === 1 && (await s.api(base)).j.used === 3, 'budget: counts per delivered mention (a different sender is not rate limited)');
  p = await post('@alice more', B); ok(p.j.delivered.length === 0 && /budget/.test(p.j.skipped[0]), 'budget: the next mention is not delivered');
  let cur = (await s.api(base)).j;
  ok(cur.status === 'paused', 'budget: the room is paused');
  p = await post('@alice x', B2); ok(p.status === 409, 'paused: agent posts are refused (409)');
  ok((await s.api(base + '/resume', 'POST', {}, as(A))).status === 403, 'resume: an agent cannot');
  ok((await s.api(base + '/resume', 'POST')).j.status === 'active' && (await s.api(base)).j.used === 0, 'resume: the user resumes and the budget restarts');
  await post('@alice x', B2);
  p = await post('@bob-' + B + ' hey', C);
  ok(p.j.delivered.length === 1, 'handle with id suffix addresses that exact agent');
  p = await post('@bob hey', C); ok(p.j.delivered.length === 0 && p.j.unknown.includes('@bob'), 'the ambiguous bare name is unknown');

  // a user message resets the budget of a room that is not paused
  await post('@carol a', A); await post('@alice b', C); await post('ping');
  ok((await s.api(base)).j.used === 0, 'user message resets used');

  // ---- done / reopen / archive
  ok((await s.api(base + '/done', 'POST', { summary: ' ' })).status === 400, 'done: summary required');
  ok((await s.api(base + '/done', 'POST', { summary: 'all good' }, as(A))).j.status === 'done', 'done: an agent marks it done');
  ok((await s.api(base)).j.summary === 'all good', 'done: summary kept');
  ok((await post('@bob x', C)).status === 409, 'done: agent posts are refused');
  ok((await post('reopen it')).status === 200 && (await s.api(base)).j.status === 'active', 'done: a user message reopens');
  ok((await s.api(base, 'PATCH', { budget: 0 })).status === 400 && (await s.api(base, 'PATCH', { name: ' ' })).status === 400, 'patch: validates');
  ok((await s.api(base, 'PATCH', { name: 'Plan2', budget: 5 })).j.name === 'Plan2', 'patch: rename');
  ok((await s.api(base, 'PATCH', { archived: true })).j.status === 'archived', 'archive');
  ok((await post('x')).status === 409 && (await s.api(base + '/done', 'POST', { summary: 's' })).status === 409, 'archived: no posts and no done');
  ok((await s.api(base, 'PATCH', { archived: false })).j.status === 'active', 'unarchive');

  // ---- pagination
  const r2 = await room({ name: 'Pages', members: [A] }), pb = `/rooms/${r2.j.id}`;
  for (let i = 1; i <= 12; i++) await s.api(pb + '/messages', 'POST', { text: 'm' + i });
  const all = (await s.api(pb)).j.thread; // system "created" + 12
  ok(all.length === 13 && all.at(-1).text === 'm12', 'thread: all messages by default, oldest first');
  const last5 = (await s.api(pb + '?limit=5')).j.thread;
  ok(last5.length === 5 && last5[0].text === 'm8' && last5.at(-1).text === 'm12', 'limit=5 returns the 5 newest');
  const after = all[5].id, next = (await s.api(pb + `?after=${after}&limit=3`)).j.thread;
  ok(next.length === 3 && next.every((m) => m.id > after), 'after=N returns only newer messages');
  ok(next.map((m) => m.id).join() === all.slice(6, 9).map((m) => m.id).join(), 'after+limit returns the next `limit` messages after N (ascending)');
  ok((await s.api(pb + `?after=${all.at(-1).id}`)).j.thread.length === 0, 'after=<last id> is empty');
  ok((await s.api(pb + '?limit=9999')).j.thread.length === 13, 'limit is capped, not an error');

  // ---- agent callers
  ok((await s.api('/rooms', 'POST', { name: 'n' }, as(A))).status === 403, 'agent: cannot create a room');
  ok((await s.api('/rooms', 'POST', { name: 'n' }, { 'x-swarm-agent': A })).status === 403, 'agent: the old x-swarm-agent header name is still understood (cannot create a room)');
  ok((await s.api(base, 'PATCH', { name: 'z' }, as(A))).status === 403, 'agent: cannot edit a room');
  ok((await s.api(base + '/members', 'POST', { agentId: C }, as(A))).status === 403, 'agent: cannot add members');
  const outsider = await newAgent(s, { name: 'Out' });
  ok((await s.api(base, 'GET', undefined, as(outsider))).status === 403, 'agent: cannot read a room it is not in');
  ok(!(await s.api('/rooms', 'GET', undefined, as(outsider))).j.some((x) => x.id === id), 'agent: its room list shows only its own rooms');
  ok((await s.api('/rooms', 'GET', undefined, as(A))).j.some((x) => x.id === id), 'agent: sees rooms it is in');
  // members
  ok((await s.api(base + '/members', 'POST', { agentId: outsider })).j.members.some((m) => m.id === outsider), 'members: the user adds one');
  ok((await s.api(base + '/members', 'POST', { agentId: 'nope' })).status === 404, 'members: unknown agent is 404');
  ok(!(await s.api(base + '/members/' + outsider, 'DELETE')).j.members.some((m) => m.id === outsider), 'members: the user removes one');
  // removing an agent removes it from rooms
  await s.api('/agents/' + C, 'DELETE');
  ok(!(await s.api(base)).j.members.some((m) => m.id === C), 'a removed agent leaves its rooms');
} catch (e) { ok(false, 'unexpected exception: ' + (e.stack || e)); }
finally { await s.stop(); }
done();
