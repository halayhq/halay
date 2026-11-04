// Bot lifecycle beyond bots-e2e.mjs, against a SPARE instance it starts itself (fake claude): node test/bots-lifecycle-e2e.mjs
// Pause / resume (messages held back, a paused bot's process stopped, idempotent), memory file PUT / DELETE (core files
// protected, size and type limits, a hand-edited role block syncing the role), who may manage bots (user and conductor
// only), settings bounds, duplicate protection against start_agent, and delete with and without the home folder.
import fs from 'node:fs';
import path from 'node:path';
import { startSpare, newAgent, checker, waitFor } from './lib/spare.mjs';
const { ok, done } = checker();
const s = await startSpare({ tag: 'botlife' });
const H = 'lc' + Date.now().toString(36);
try {
  const con = (await s.api('/conductor', 'POST', {})).j.id, agent = await newAgent(s, { name: 'plain' });
  const as = (id) => ({ 'x-halay-agent': id });
  const r = await s.api('/bots', 'POST', { name: 'Life ' + H, handle: H, role: 'You are a lifecycle bot.' });
  ok(r.status === 201, 'create');
  const bot = r.j, f = (name) => `/bots/${H}/file?name=${encodeURIComponent(name)}`;

  // ---- who may manage
  ok((await s.api('/bots', 'GET', undefined, as(agent))).status === 403 && (await s.api('/bots', 'POST', { name: 'x', role: 'x' }, as(agent))).status === 403, 'a regular agent cannot list or create bots');
  ok((await s.api(`/bots/${H}`, 'PATCH', { emoji: 'x' }, as(agent))).status === 403 && (await s.api(`/bots/${H}/pause`, 'POST', {}, as(agent))).status === 403, 'a regular agent cannot edit or pause one');
  ok((await s.api('/bots', 'GET', undefined, as('ghost'))).status === 403, 'an unknown caller is refused');
  ok((await s.api('/bots', 'GET', undefined, as(con))).status === 200, 'the conductor can list bots');
  ok((await s.api(`/bots/${H}`, 'DELETE', undefined, as(con))).status === 403, 'the conductor cannot delete a bot (user only)');
  ok((await s.api('/bots/settings', 'PUT', { ctxTokens: 100000 }, as(con))).status === 403, 'the conductor cannot change bot settings');
  ok((await s.api('/bots/settings', 'PUT', { ctxTokens: 10 })).status === 400 && (await s.api('/bots/settings', 'PUT', { ctxTokens: 2e6 })).status === 400, 'settings: context threshold bounds');
  ok((await s.api('/bots/nobody')).status === 404, 'unknown bot: 404');

  // ---- pause / resume
  const msgs = async () => (await s.api('/agents/' + bot.agentId + '?tail=50')).j.events || [];
  let p = await s.api(`/bots/${H}/pause`, 'POST');
  ok(p.j.paused === true, 'pause');
  ok((await s.api(`/bots/${H}/pause`, 'POST')).j.paused === true, 'pause twice is harmless');
  await s.api(`/agents/${bot.agentId}/send`, 'POST', { text: 'held message' });
  ok((await msgs()).some((e) => /paused/i.test(e.text || '')) && !(await msgs()).some((e) => e.type === 'user_prompt' && /held message/.test(e.text || '')), 'a paused bot holds the message back');
  ok((await s.api(`/bots/${H}/refresh`, 'POST')).status === 409, 'refresh of a paused bot: 409');
  ok((await s.api(`/bots/${H}`)).j.paused === true, 'GET shows paused');
  ok((await s.api(`/bots/${H}/resume`, 'POST')).j.paused === false, 'resume');
  ok((await s.api(`/bots/${H}/resume`, 'POST')).j.paused === false, 'resume twice is harmless');
  await s.api(`/agents/${bot.agentId}/send`, 'POST', { text: 'delivered message' });
  ok(await waitFor(async () => (await msgs()).some((e) => e.type === 'user_prompt' && /delivered message/.test(e.text || ''))), 'after resume messages reach the bot');
  ok((await s.api('/bots/nobody/pause', 'POST')).status === 404, 'pause of an unknown bot: 404');

  // ---- files
  ok((await s.api(f('memory/projects.md'), 'PUT', { content: '# P\n' })).status === 200 && (await s.api(f('memory/projects.md'))).j.content === '# P\n', 'PUT a new memory file, GET it back');
  ok((await s.api(`/bots/${H}/files`)).j.some((x) => /projects\.md/.test(x.name || x)), 'it shows in the file list');
  ok((await s.api(f('memory/projects.md'), 'PUT', { content: 5 })).status === 400, 'PUT: content must be a string');
  ok((await s.api(f('memory/projects.md'), 'PUT', { content: 'x'.repeat(200_001) })).status === 400, 'PUT: over 200000 characters refused');
  ok((await s.api(f('memory/projects.md'), 'PUT', {})).status === 400, 'PUT: missing content refused');
  ok((await s.api(f('../x.md'), 'PUT', { content: 'x' })).status === 400 && (await s.api(f('memory/sub/x.md'), 'PUT', { content: 'x' })).status === 400 && (await s.api(f('/etc/passwd'), 'PUT', { content: 'x' })).status === 400, 'PUT: names outside BOT.md and memory/*.md refused');
  ok((await s.api(f('memory/projects.md'), 'DELETE')).status === 200 && (await s.api(f('memory/projects.md'))).status === 404, 'DELETE a memory file');
  ok((await s.api(f('memory/projects.md'), 'DELETE')).status === 200, 'DELETE of a missing file is harmless');
  ok((await s.api(f('memory/notes.md'), 'DELETE')).status === 400 && (await s.api(f('memory/journal.md'), 'DELETE')).status === 400 && (await s.api(f('BOT.md'), 'DELETE')).status === 400, 'DELETE: core files are protected');
  ok(fs.existsSync(path.join(bot.dir, 'memory/notes.md')) && fs.existsSync(path.join(bot.dir, 'BOT.md')), 'the core files are still on disk');
  const claude = (await s.api(f('BOT.md'))).j.content;
  await s.api(f('BOT.md'), 'PUT', { content: claude.replace('You are a lifecycle bot.', 'Hand edited role.') });
  ok((await s.api(`/bots/${H}`)).j.role === 'Hand edited role.', 'a hand-edited role block updates the bot\'s role');
  await s.api(f('BOT.md'), 'PUT', { content: 'no markers at all' });
  ok((await s.api(`/bots/${H}`)).j.role === 'Hand edited role.', 'BOT.md without the role block keeps the role');

  // ---- duplicates
  ok((await s.api('/agents', 'POST', { cwd: s.dir, name: 'Life ' + H, parentId: agent })).status === 409, 'start_agent with a bot\'s name is refused (message the bot)');
  ok((await s.api('/agents', 'POST', { cwd: s.dir, name: H, parentId: agent })).status === 409, 'start_agent with a bot\'s handle is refused');
  ok((await s.api('/agents', 'POST', { cwd: s.dir, name: 'Life ' + H })).status < 300, 'the user may start an agent with that name');

  // ---- delete
  const keep = (await s.api('/bots', 'POST', { name: 'Keep ' + H, handle: 'k' + H, role: 'r' })).j;
  ok((await s.api(`/bots/k${H}`, 'DELETE')).j.deletedFolder === false && fs.existsSync(keep.dir), 'delete: the folder is kept by default');
  ok((await s.api(`/bots/k${H}`)).status === 404 && (await s.api('/agents/' + keep.agentId)).status === 404, 'delete: bot and its agent are gone');
  ok((await s.api(`/bots/${H}`, 'DELETE')).status === 200, 'delete');
  const d2 = (await s.api('/bots', 'POST', { name: 'Gone ' + H, handle: 'g' + H, role: 'r' })).j;
  ok((await s.api(`/bots/g${H}?home=1`, 'DELETE')).j.deletedFolder === true && !fs.existsSync(d2.dir), 'delete with home=1 removes the folder');
  fs.rmSync(keep.dir, { recursive: true, force: true }); fs.rmSync(bot.dir, { recursive: true, force: true });
} catch (e) { ok(false, 'unexpected exception: ' + (e.stack || e)); }
finally { await s.stop(); }
done();
