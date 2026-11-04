// Unit check of rooms.js against an in-memory database (no server, no model calls):
//   node test/rooms-unit.mjs
// Resume keeps an archived room shut and fully reopens a done one; ?after=N&limit=L pages forward from N.
import Database from 'better-sqlite3';
import { createRooms } from '../src/rooms.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sent = [], agents = new Map([['w1', { id: 'w1', name: 'writer', status: 'idle', pendingApprovals: () => [], send: (t) => sent.push(t) }]]);
const rooms = createRooms({ db: new Database(':memory:'), agents, broadcast: () => {}, notify: () => {} });
const call = async (method, p, body) => {
  let out;
  await rooms.handle({ method, headers: {} }, new URL('http://x' + p), {}, { json: (_res, code, j) => (out = { code, j }), readBody: async () => body || {} });
  return out;
};

const id = (await call('POST', '/api/rooms', { name: 'r' })).j.id;
for (let i = 0; i < 10; i++) await call('POST', `/api/rooms/${id}/messages`, { text: 'm' + i });
let r = await call('GET', `/api/rooms/${id}?limit=3`);
ok(r.j.thread.map((m) => m.text).join() === 'm7,m8,m9', 'no after: the newest messages');
const first = (await call('GET', `/api/rooms/${id}?limit=500`)).j.thread[0].id;
r = await call('GET', `/api/rooms/${id}?after=${first}&limit=3`);
ok(r.j.thread.map((m) => m.text).join() === 'm0,m1,m2', 'after=N&limit=L: the next L after N, not the newest');

await call('POST', `/api/rooms/${id}/members`, { agentId: 'w1' });
r = await call('POST', `/api/rooms/${id}/messages`, { text: '@writer go' });
ok(r.j.delivered?.includes('writer') && /m9/.test(sent[0] || '') && /\[Room "r"/.test(sent[0] || ''), 'a mention is delivered with the recent messages');

await call('POST', `/api/rooms/${id}/done`, { summary: 'all good' });
r = await call('POST', `/api/rooms/${id}/resume`);
ok(r.code === 200 && r.j.status === 'active' && r.j.summary === '' && r.j.doneBy === null, 'resuming a done room clears its summary and done_by');

await call('PATCH', `/api/rooms/${id}`, { archived: true, budget: 5 });
r = await call('POST', `/api/rooms/${id}/resume`);
ok(r.code === 409 && (await call('GET', `/api/rooms/${id}`)).j.status === 'archived', 'resume refuses an archived room');
ok((await call('PATCH', `/api/rooms/${id}`, { resume: true })).code === 409, 'so does update_room resume');
r = await call('PATCH', `/api/rooms/${id}`, { archived: false });
ok(r.code === 200 && r.j.status === 'active', 'unarchiving opens it');
r = await call('PATCH', `/api/rooms/${id}`, { archived: true, resume: true });
ok(r.j.status === 'archived', 'archived and resume together archive');

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
