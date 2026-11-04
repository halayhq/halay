// An agent can never give work a more permissive permission mode than its own (plan < manual < acceptEdits < auto < cli
// < bypassPermissions), whichever way it goes: a child it starts, a schedule it adds or edits (its runs start with no
// parent), a bot it schedules, or an agent it starts on a peer. Against a SPARE instance with the fake claude CLI.
import path from 'node:path';
import { startSpare, checker, ROOT } from './lib/spare.mjs';

const c = checker();
process.env.PATH = path.join(ROOT, 'test/fake-acp') + path.delimiter + process.env.PATH; // a fake OpenCode too
const s = await startSpare({ tag: 'escalation', env: { HALAY_TERMINAL: '0', HALAY_BACKENDS: 'claude,opencode' } });
const as = (agentId) => ({ 'x-halay-agent': agentId }); // what swarm-mcp.js sends for the calling agent
try {
  const start = (body, headers) => s.api('/agents', 'POST', { cwd: s.dir, name: 'a', ...body }, headers);
  const manual = (await start({ name: 'manual parent', permissionMode: 'manual' })).j;
  const plan = (await start({ name: 'plan parent', permissionMode: 'plan' })).j;
  c.ok(manual.permissionMode === 'manual' && plan.permissionMode === 'plan', 'two parents: manual and plan');

  // children
  for (const m of ['acceptEdits', 'auto', 'cli', 'bypassPermissions']) {
    const r = await start({ parentId: manual.id, permissionMode: m });
    c.ok(r.status === 400 && /more permissive/.test(r.j.error), `a manual parent cannot start a ${m} child: ${r.status}`);
  }
  let r = await start({ parentId: manual.id, permissionMode: 'plan' });
  c.ok(r.status === 201 && r.j.permissionMode === 'plan', 'a less permissive child is fine');
  r = await start({ parentId: plan.id, permissionMode: 'manual' });
  c.ok(r.status === 400, 'a plan parent cannot start a manual child');
  r = await start({ parentId: plan.id });
  c.ok(r.status === 201 && r.j.permissionMode === 'plan', 'an inherited mode stays the parent\'s');
  // the Settings default is more permissive than the parent: an unset mode comes down to the parent's
  await s.api('/settings/agents', 'PUT', { permissionMode: 'bypassPermissions' });
  r = await start({ parentId: manual.id, backend: 'claude' });
  c.ok(r.status === 201 && r.j.permissionMode === 'manual', `with a bypassPermissions Settings default, an unset mode still never exceeds the parent's: ${r.j.permissionMode}`);
  await s.api('/settings/agents', 'PUT', { permissionMode: 'auto' });

  // schedules
  const sched = (body, who) => s.api('/schedules', 'POST', { title: 't', cron: '0 9 * * *', cwd: s.dir, ...body }, who ? as(who) : {});
  r = await sched({ permission_mode: 'bypassPermissions' }, manual.id);
  c.ok(r.status === 400 && /more permissive/.test(r.j.error), 'an agent cannot add a schedule more permissive than itself: ' + r.status);
  r = await sched({}, manual.id);
  c.ok(r.status === 201 && r.j.permissionMode === 'manual', `an agent's schedule without a mode gets the agent's, not the default: ${r.j.permissionMode}`);
  const own = r.j.id;
  r = await s.api('/schedules/' + own, 'PATCH', { permission_mode: 'auto' }, as(manual.id));
  c.ok(r.status === 400, 'nor raise its own schedule\'s mode later');
  r = await s.api('/schedules/' + own, 'PATCH', { title: 'renamed' }, as(manual.id));
  c.ok(r.status === 200 && r.j.permissionMode === 'manual', 'other edits still work');
  r = await sched({ permission_mode: 'bypassPermissions' });
  c.ok(r.status === 201 && r.j.permissionMode === 'bypassPermissions', 'the user (no caller agent) can add any mode');

  // with another CLI's default above the caller's mode, an unset mode comes down to one that CLI has (not the caller's
  // Claude-only auto, which would fail every run)
  const accts = (await s.api('/accounts')).j, oc = accts.find((a) => a.backend === 'opencode');
  if (oc) {
    const autoAgent = (await start({ name: 'auto parent', permissionMode: 'auto' })).j;
    await s.api('/settings/agents', 'PUT', { perBackend: { opencode: { permissionMode: 'bypassPermissions' } } });
    r = await sched({ account: oc.name }, autoAgent.id);
    c.ok(r.status === 201 && r.j.permissionMode === 'acceptEdits', `an OpenCode schedule from an auto agent gets acceptEdits: ${r.status} ${r.j.permissionMode || r.j.error}`);
  } else c.skip('no OpenCode account in this instance');
  // a bot more permissive than the caller can't be scheduled by it (the conductor drives any agent anyway)
  r = await s.api('/bots', 'POST', { name: 'Free bot', handle: 'freebot', role: 'r', permission_mode: 'bypassPermissions' });
  c.ok(r.status === 201, 'a bypassPermissions bot (made by the user)');
  r = await sched({ bot: 'freebot' }, manual.id);
  c.ok(r.status === 400 && /more permissive/.test(r.j.error), 'a manual agent cannot schedule turns of a bypassPermissions bot: ' + r.status);

  // a peer: the proxy refuses before forwarding (the peer need not exist for that)
  await s.api('/peers/other', 'PUT', { url: 'http://127.0.0.1:9', token: 'x' });
  r = await s.api('/peers/other/agents', 'POST', { cwd: '/tmp', permissionMode: 'bypassPermissions' }, as(manual.id));
  c.ok(r.status === 403 && /more permissive/.test(r.j.error), 'an agent cannot start a more permissive agent on a peer: ' + r.status);
} catch (e) {
  c.ok(false, 'crashed: ' + e.stack);
  console.log(s.log().slice(-3000));
} finally {
  await s.stop();
}
c.done();
