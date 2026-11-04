// REST check of per-agent model / effort and the agent defaults against a SPARE instance (never the live server).
// It makes no model calls: run the spare server with the fake CLI first in PATH, so started agents only log their arguments:
//   FAKE_CLAUDE_LOG=/tmp/x/claude.log PATH=$PWD/test/fake-claude:$PATH PORT=4792 HALAY_DB=/tmp/x/halay.db HALAY_TOKEN=t node src/server.js &
//   BASE=http://127.0.0.1:4792 TOKEN=t FAKE_CLAUDE_LOG=/tmp/x/claude.log node test/models-e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const BASE = process.env.BASE, TOKEN = process.env.TOKEN, LOG = process.env.FAKE_CLAUDE_LOG;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + '/api' + p, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the arguments of the last fake claude launch in folder-free terms: { model, effort, mode }
const lastLaunch = () => {
  const runs = fs.readFileSync(LOG, 'utf8').split('---\n').filter((r) => r.includes('stream-json'));
  const a = (runs.at(-1) || '').split('\n'), arg = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  return { model: arg('--model'), effort: arg('--effort'), mode: arg('--permission-mode') };
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'models-e2e-'));
const made = [];
const start = async (body) => { const r = await api('/agents', 'POST', { cwd: dir, ...body }); if (r.j.id) made.push(r.j.id); return r; };
const before = (await api('/settings/agents')).j;

try {
  let r = await api('/settings/agents');
  ok(r.status === 200 && r.j.permissionMode && 'model' in r.j && r.j.efforts?.includes('xhigh'), 'agent defaults readable, with the effort levels');
  ok((await api('/settings/agents', 'PUT', { effort: 'turbo' })).status === 400, 'unknown effort refused');
  ok((await api('/settings/agents', 'PUT', { model: 'bad model; rm -rf' })).status === 400, 'malformed model refused');
  ok((await api('/settings/agents', 'PUT', { permissionMode: 'yolo' })).status === 400, 'unknown permission mode refused');
  r = await api('/settings/agents', 'PUT', { permissionMode: 'acceptEdits', model: 'sonnet', effort: 'low' });
  ok(r.status === 200 && r.j.model === 'sonnet' && r.j.effort === 'low' && r.j.permissionMode === 'acceptEdits', 'defaults saved');

  r = await start({ name: 'defaults' });
  ok(r.status === 201 && r.j.permissionMode === 'acceptEdits' && r.j.model === 'sonnet' && r.j.effort === 'low', 'a new agent gets the defaults');
  r = await start({ name: 'explicit', permissionMode: 'plan', model: 'opus', effort: 'high' });
  const parent = r.j;
  ok(r.status === 201 && parent.permissionMode === 'plan' && parent.model === 'opus' && parent.effort === 'high', 'request values win over the defaults');
  ok((await start({ effort: 'turbo' })).status === 400, 'start with an unknown effort refused');
  ok((await start({ model: 'x y' })).status === 400, 'start with a malformed model refused');

  r = await start({ name: 'child', parentId: parent.id });
  ok(r.status === 201 && r.j.permissionMode === 'plan' && r.j.model === 'opus' && r.j.effort === 'high', 'a child inherits mode, model and effort from its parent');
  r = await start({ name: 'cheap child', parentId: parent.id, model: 'haiku', effort: 'low' });
  ok(r.status === 201 && r.j.model === 'haiku' && r.j.effort === 'low', 'a child can pick a cheaper model and effort');
  ok((await start({ parentId: parent.id, permissionMode: 'bypassPermissions' })).status === 400, 'a child still cannot be more permissive than its parent');

  r = await api(`/agents/${parent.id}/model`, 'POST', { model: 'haiku', effort: '' });
  ok(r.status === 200 && r.j.model === 'haiku' && r.j.effort === null, 'model of an idle agent changed, effort back to default');
  const pa = (await api('/agents/' + parent.id)).j;
  ok(pa.model === 'haiku' && pa.effort == null, 'the change is kept on the agent');
  ok((await api(`/agents/${parent.id}/model`, 'POST', { effort: 'ultra' })).status === 400, 'model endpoint validates effort');

  // tasks
  r = await api('/tasks', 'POST', { title: 'models e2e task', cwd: dir, model: 'haiku', effort: 'medium' });
  const task = r.j;
  ok(r.status === 201 && task.model === 'haiku' && task.effort === 'medium', 'task stores model and effort');
  ok((await api('/tasks/' + task.id, 'PATCH', { effort: 'nope' })).status === 400, 'task effort validated');
  r = await api('/tasks/' + task.id, 'PATCH', { effort: 'xhigh' });
  ok(r.status === 200 && r.j.effort === 'xhigh' && r.j.model === 'haiku', 'task edit keeps the model and changes effort');
  if (LOG) {
    r = await api(`/tasks/${task.id}/assign`, 'POST', {});
    if (r.j.agent) made.push(r.j.agent.id);
    ok(r.status === 200 && r.j.agent.model === 'haiku' && r.j.agent.effort === 'xhigh', 'assigned task starts its agent with the task model and effort');
    await sleep(1500);
    const l = lastLaunch();
    ok(l.model === 'haiku' && l.effort === 'xhigh' && l.mode === 'acceptEdits', `claude launched with --model haiku --effort xhigh --permission-mode acceptEdits (got ${JSON.stringify(l)})`);
  } else console.log('SKIP launch checks (set FAKE_CLAUDE_LOG and run the server with test/fake-claude first in PATH)');
  await api('/tasks/' + task.id, 'DELETE');

  // schedules
  r = await api('/schedules', 'POST', { title: 'models e2e', cron: '0 9 * * *', cwd: dir, model: 'sonnet', effort: 'low' });
  const sch = r.j;
  ok(r.status === 201 && sch.model === 'sonnet' && sch.effort === 'low' && sch.permissionMode === 'acceptEdits', 'schedule stores model and effort; mode from the defaults');
  ok((await api('/schedules/' + sch.id, 'PATCH', { model: 'a b' })).status === 400, 'schedule model validated');
  r = await api('/schedules/' + sch.id, 'PATCH', { model: '', effort: 'max' });
  ok(r.status === 200 && r.j.model === '' && r.j.effort === 'max', 'schedule model cleared, effort changed');
  if (LOG) {
    r = await api(`/schedules/${sch.id}/run`, 'POST');
    if (r.j.agent) made.push(r.j.agent.id);
    ok(r.status === 200 && r.j.agent?.model === 'sonnet' && r.j.agent?.effort === 'max', 'a run uses the schedule effort and the default model');
  }
  await api('/schedules/' + sch.id, 'DELETE');
} finally {
  for (const id of made) await api(`/agents/${id}?discard=1`, 'DELETE');
  await api('/settings/agents', 'PUT', { permissionMode: before.permissionMode || 'auto', model: before.model || '', effort: before.effort || '' });
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
