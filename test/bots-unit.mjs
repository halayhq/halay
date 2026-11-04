// Unit check of bots.js against an in-memory database (no server, no model calls):
//   node test/bots-unit.mjs
// A bot made by an agent can't be more permissive than that agent in any mode, and a bot whose agent can't be
// re-created is reported once, not on every upkeep tick.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createBots } from '../src/bots.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-unit-'));
const db = new Database(':memory:');
db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, model TEXT, effort TEXT, permission_mode TEXT, account TEXT, browser TEXT)');
const agents = new Map(), cfgs = { bots: { root: scratch } };
let n = 0, spawnFails = false;
const bots = createBots({
  db, agents, broadcast: () => {}, root: scratch, getCfg: (k, d) => cfgs[k] || d, putCfg: () => {}, accounts: () => ({ main: {} }),
  browser: { validName: () => true, available: () => true, cfg: () => ({ profile: 'default' }) },
  rooms: { list: () => [], exists: () => false, join() {}, leave() {} },
  spawn: (body) => {
    if (spawnFails) return { code: 400, error: 'nope' };
    const a = { id: 'b' + ++n, ...body, status: 'stopped', events: [], ctx: 0, pendingApprovals: () => [], killProc() {}, summary: () => ({}) };
    agents.set(a.id, a); return { agent: a };
  },
  removeAgent: () => {},
});
const call = async (method, p, body, agent) => {
  let out;
  const req = { method, headers: agent ? { 'x-halay-agent': agent } : {} };
  await bots.handle(req, new URL('http://x' + p), {}, { json: (_res, code, j) => (out = { code, j }), readBody: async () => body });
  return out;
};
const conductor = (mode) => { agents.set('c', { id: 'c', role: 'conductor', permissionMode: mode }); return 'c'; };

const order = ['plan', 'manual', 'acceptEdits', 'auto', 'cli', 'bypassPermissions'];
let h = 0;
for (const [ci, cm] of order.entries())
  for (const [bi, bm] of order.entries()) {
    const r = await call('POST', '/api/bots', { name: 'x' + ++h, role: 'r', account: 'main', permissionMode: bm }, conductor(cm));
    const allowed = bi <= ci;
    if ((r.code === 201) !== allowed) ok(false, `caller ${cm} creating a ${bm} bot: got ${r.code}`);
  }
ok(true, 'creation follows plan < manual < acceptEdits < auto < cli < bypassPermissions for every pair');
ok((await call('POST', '/api/bots', { name: 'u', role: 'r', account: 'main', permissionMode: 'bypassPermissions' })).code === 201, 'the user (no caller agent) can create any mode');
ok((await call('PATCH', '/api/bots/u', { permissionMode: 'acceptEdits' }, conductor('manual'))).code === 200, 'an agent may lower a bot it could not have created');
ok((await call('PATCH', '/api/bots/u', { permissionMode: 'auto' }, conductor('manual'))).code === 400, 'but not raise it above its own mode');

// warn once
const b = bots.get('u');
agents.delete(b.agent_id); spawnFails = true;
const errs = []; const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
const log = console.log; console.log = () => {};
bots.tick(); bots.tick(); bots.tick();
console.error = orig; console.log = log;
ok(errs.filter((e) => /@u: could not re-create/.test(e)).length === 1, 'a failing re-create is logged once');

fs.rmSync(scratch, { recursive: true, force: true });
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
