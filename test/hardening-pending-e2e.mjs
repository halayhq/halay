// Hardening checks for known holes, against a SPARE instance it starts itself (fake claude): node test/hardening-e2e.mjs
//   - editor-fs: deleting or renaming a PARENT folder that contains .env / .token / halay.db must be refused
//   - readBody (server.js): an oversized body is 413 and invalid JSON is 400 (it used to be treated as {})
//   - plugins: only the user may change a plugin's settings or disable it (agents, peers and plugins get 403)
// Checks marked "pending fix" cover bugs another change is fixing: they print XFAIL (not a failure) until it lands; run with
// HALAY_TEST_PENDING=fail to count them as failures. The "baseline" checks already pass today and must keep passing.
import fs from 'node:fs';
import path from 'node:path';
import { startSpare, newAgent, checker } from './lib/spare.mjs';
const { ok, pending, done } = checker();
const s = await startSpare({ tag: 'harden' });
try {
  // ---- editor-fs
  const proj = path.join(s.dir, 'proj');
  fs.mkdirSync(proj);
  const agent = await newAgent(s, { name: 'ed', cwd: proj });
  const edit = (op, body) => s.api(`/agents/${agent}/edit/${op}`, 'POST', body);
  const secrets = ['.env', '.token', 'halay.db'];
  const mkTree = (name) => { for (const dir of [name, name + '/deep/er']) { fs.mkdirSync(path.join(proj, dir), { recursive: true }); for (const f of secrets) fs.writeFileSync(path.join(proj, dir, f), 'SECRET\n'); fs.writeFileSync(path.join(proj, dir, 'ok.txt'), 'fine\n'); } };
  const intact = (name) => secrets.every((f) => fs.existsSync(path.join(proj, name, f)) && fs.existsSync(path.join(proj, name, 'deep/er', f)));

  for (const f of secrets) {
    fs.writeFileSync(path.join(proj, f), 'S');
    ok((await edit('delete', { path: f })).status === 403 && fs.existsSync(path.join(proj, f)), `baseline: deleting ${f} directly is refused`);
    ok((await edit('rename', { from: f, to: f + '.bak' })).status === 403 && fs.existsSync(path.join(proj, f)), `baseline: renaming ${f} directly is refused`);
    ok((await edit('rename', { from: 'plain.txt', to: f })).status >= 400, `baseline: renaming something to ${f} is refused`);
    fs.rmSync(path.join(proj, f));
  }
  fs.mkdirSync(path.join(proj, 'plain')); fs.writeFileSync(path.join(proj, 'plain/a.txt'), 'x');
  ok((await edit('delete', { path: 'plain' })).status === 200 && !fs.existsSync(path.join(proj, 'plain')), 'baseline: a folder without secrets can be deleted');
  fs.mkdirSync(path.join(proj, 'plain2')); fs.writeFileSync(path.join(proj, 'plain2/a.txt'), 'x');
  ok((await edit('rename', { from: 'plain2', to: 'plain3' })).status === 200 && fs.existsSync(path.join(proj, 'plain3/a.txt')), 'baseline: a folder without secrets can be renamed');

  mkTree('withsecrets');
  let r = await edit('delete', { path: 'withsecrets' });
  pending(r.status === 403 && intact('withsecrets'), `deleting a folder that contains .env/.token/halay.db is refused and nothing is removed (got ${r.status}, secrets ${intact('withsecrets') ? 'intact' : 'GONE'})`);
  mkTree('deepdel'); fs.rmSync(path.join(proj, 'deepdel', '.env')); fs.rmSync(path.join(proj, 'deepdel', '.token')); fs.rmSync(path.join(proj, 'deepdel', 'halay.db'));
  r = await edit('delete', { path: 'deepdel' });
  pending(r.status === 403 && fs.existsSync(path.join(proj, 'deepdel/deep/er/.env')), `a secret only in a nested subfolder also blocks deleting the parent (got ${r.status})`);
  mkTree('renameme');
  r = await edit('rename', { from: 'renameme', to: 'renamed' });
  pending(r.status === 403 && fs.existsSync(path.join(proj, 'renameme/.env')) && !fs.existsSync(path.join(proj, 'renamed')), `renaming a folder that contains secrets is refused (got ${r.status})`);
  // the project root itself and a folder above it
  r = await edit('delete', { path: '.' });
  ok(r.status >= 400 && fs.existsSync(proj), `baseline: deleting the project root "." is refused (got ${r.status})`);
  r = await edit('delete', { path: '..' });
  ok(r.status >= 400 && fs.existsSync(proj), `baseline: deleting ".." is refused (got ${r.status})`);

  // ---- readBody
  const rawPost = (p, body, ct = 'application/json') => fetch(s.base + '/api' + p, { method: 'POST', headers: { authorization: 'Bearer ' + s.token, 'content-type': ct }, body });
  r = await rawPost('/rooms', '{"name": "ok"}');
  ok(r.status === 201 && (await r.json()).name === 'ok', 'baseline: a valid JSON body works');
  r = await rawPost('/rooms', '{not json');
  pending(r.status === 400 && /json/i.test((await r.json()).error || ''), `invalid JSON is 400 with a JSON error, not silently {} (got ${r.status})`);
  r = await rawPost('/rooms', '[1,2');
  pending(r.status === 400 && /json/i.test((await r.json()).error || ''), `truncated JSON is 400 with a JSON error (got ${r.status})`);
  const before = (await s.api('/rooms')).j.length;
  r = await rawPost('/rooms', JSON.stringify({ name: 'big', goal: 'x'.repeat(30 * 1024 * 1024) })).catch((e) => ({ status: 'connection error: ' + e.cause?.code }));
  pending(r.status === 413, `an oversized body (30 MB) is 413 (got ${r.status})`);
  ok((await s.api('/rooms')).j.length === before + (r.status === 201 ? 1 : 0), 'baseline: an invalid body creates nothing');
  pending((await s.api('/rooms')).j.length === before, 'an oversized body creates nothing');
  ok((await s.api('/agents')).status === 200, 'baseline: the server is still fine afterwards');
  r = await rawPost('/rooms', '');
  ok(r.status === 400 && (await r.json()).error === 'name required', 'baseline: an empty body is {} (400 name required)');

  // ---- plugin user-only guard
  const plugins = (await s.api('/plugins')).j;
  const pid = (Array.isArray(plugins) ? plugins : plugins.plugins || []).find((p) => p.id === 'ntfy')?.id || 'ntfy';
  const asAgent = { 'x-halay-agent': agent }, asPeer = { 'x-halay-peer': 'other' }, asPlugin = { 'x-halay-plugin': 'webhook-notify' };
  const before2 = (await s.api('/plugins/' + pid)).j;
  ok((await s.api(`/plugins/${pid}/enable`, 'POST', { permissions: [] }, asAgent)).status === 403, 'baseline: an agent cannot enable a plugin');
  for (const [who, h] of [['an agent', asAgent], ['a peer', asPeer], ['a plugin', asPlugin]]) {
    r = await s.api(`/plugins/${pid}/settings`, 'PUT', { topic: 'hijacked-' + who.replace(/\W/g, '') }, h);
    pending(r.status === 403, `${who} cannot change a plugin's settings (got ${r.status})`);
    r = await s.api(`/plugins/${pid}/disable`, 'POST', {}, h);
    pending(r.status === 403, `${who} cannot disable a plugin (got ${r.status})`);
  }
  const after = (await s.api('/plugins/' + pid)).j;
  pending(JSON.stringify(after.settings) === JSON.stringify(before2.settings) && after.enabled === before2.enabled, 'the plugin\'s settings and state are unchanged after those calls');
  ok((await s.api(`/plugins/${pid}/settings`, 'PUT', { topic: 'user-topic' })).status === 200 && (await s.api("/plugins/" + pid)).j.settings?.values?.topic === "user-topic", 'baseline: the user can still change settings');
  ok((await s.api(`/plugins/${pid}/disable`, 'POST', {})).status === 200, 'baseline: the user can still disable');
  ok((await s.api('/plugins/nope/disable', 'POST', {})).status === 404, 'baseline: an unknown plugin is 404');
} catch (e) { ok(false, 'unexpected exception: ' + (e.stack || e)); }
finally { await s.stop(); }
done();
