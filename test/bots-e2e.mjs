// REST check of bots against a SPARE instance (never the live server); makes no model calls (a bot's agent only starts on its first message):
//   PORT=4791 HALAY_DB=/tmp/x/halay.db node src/server.js &
//   BASE=http://127.0.0.1:4791 TOKEN=$(cat .token) node test/bots-e2e.mjs
import fs from 'node:fs';
const BASE = process.env.BASE, TOKEN = process.env.TOKEN, H = 'e2e' + Date.now().toString(36);
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const api = async (p, method = 'GET', body, headers = {}) => {
  const r = await fetch(BASE + '/api' + p, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};

let r = await api('/bots', 'POST', { name: 'E2E ' + H, handle: H, role: 'You are a test bot.', emoji: '🧪' });
ok(r.status === 201 && r.j.handle === H && r.j.permissionMode === 'manual', 'create: handle kept, mode defaults to manual');
const bot = r.j;
ok(fs.existsSync(bot.dir + '/BOT.md') && fs.existsSync(bot.dir + '/memory/journal.md') && fs.existsSync(bot.dir + '/memory/notes.md') && fs.existsSync(bot.dir + '/memory/threads.md'), 'home folder has BOT.md and memory files');
ok((await api('/bots', 'POST', { name: 'dup', handle: H, role: 'x' })).status === 409, 'duplicate handle refused');
ok((await api('/bots', 'POST', { name: 'bad', role: 'x', cwd: '/definitely/not/here' })).status === 400, 'missing folder refused');
ok((await api('/bots', 'POST', { name: 'nope', role: 'x', account: 'no-such-account' })).status === 400, 'unknown account refused');
const ag = (await api('/agents/' + bot.agentId)).j;
ok(ag.bot?.handle === H && ag.status === 'stopped', 'its agent exists with a bot badge');

ok((await api(`/bots/${H}`, 'PATCH', { effort: 'turbo' })).status === 400, 'unknown effort refused');
r = await api(`/bots/${H}`, 'PATCH', { model: 'haiku', effort: 'low' });
ok(r.status === 200 && r.j.model === 'haiku' && r.j.effort === 'low' && (await api('/agents/' + bot.agentId)).j.effort === 'low', 'model and effort reach its agent');
r = await api(`/bots/${H}`, 'PATCH', { role: 'You are a renamed test bot.', emoji: '🔬' });
ok(r.status === 200 && fs.readFileSync(bot.dir + '/BOT.md', 'utf8').includes('renamed test bot'), 'role edit rewrites the BOT.md role block');
ok(/bot:pointer/.test(fs.readFileSync(bot.dir + '/CLAUDE.md', 'utf8')) && /BOT\.md/.test(fs.readFileSync(bot.dir + '/CLAUDE.md', 'utf8')), 'a Claude bot in its home folder gets a CLAUDE.md that points at BOT.md');
// a bot made before the rename has CLAUDE.md: it becomes BOT.md the first time the file is needed
fs.renameSync(bot.dir + '/BOT.md', bot.dir + '/CLAUDE.md');
ok((await api(`/bots/${H}/file?name=BOT.md`)).status === 200 && fs.existsSync(bot.dir + '/BOT.md') && !fs.existsSync(bot.dir + '/CLAUDE.md'), 'an old CLAUDE.md is renamed to BOT.md on first use');
ok((await api(`/bots/${H}/file?name=memory/notes.md`, 'PUT', { content: '- fact\n' })).status === 200 && (await api(`/bots/${H}/file?name=memory/notes.md`)).j.content === '- fact\n', 'memory file edit round-trips');
ok((await api(`/bots/${H}/file?name=../../etc/passwd`)).status === 400 && (await api(`/bots/${H}/file?name=memory/../BOT.md`)).status === 400, 'file names outside BOT.md and memory/ are refused');
ok((await api(`/bots/${H}/files`)).j.length === 4, 'files listed');

ok((await api(`/bots/${H}/pause`, 'POST')).j.paused === true, 'pause');
await api(`/agents/${bot.agentId}/send`, 'POST', { text: 'hello' });
ok((await api('/agents/' + bot.agentId + '?tail=5')).j.events.some((e) => /paused/.test(e.text || '')), 'a paused bot holds messages back');
ok((await api(`/bots/${H}/resume`, 'POST')).j.paused === false, 'resume');

r = await api(`/schedules`, 'POST', { title: 't', prompt: 'p', cron: '0 9 * * *', bot: H });
ok(r.status === 200 || r.status === 201, 'schedule can target a bot') ;
if (r.j.id) { ok(r.j.bot === H && r.j.cwd === bot.cwd, 'schedule takes the bot folder'); await api('/schedules/' + r.j.id, 'DELETE'); }
ok((await api('/schedules', 'POST', { title: 't', cron: '0 9 * * *', bot: 'nobody' })).status === 400, 'schedule for an unknown bot refused');

ok((await api('/agents/' + bot.agentId, 'DELETE')).status === 409, 'the bot agent cannot be removed from the agent list');
ok((await api('/agents', 'POST', { prompt: 'x', cwd: bot.cwd, parentId: bot.agentId })).status === 409, 'start_agent cannot duplicate a bot (folder)');
ok((await api('/bots', 'POST', { name: 'agent made', role: 'x' }, { 'x-halay-agent': bot.agentId })).status === 403, 'agents other than the conductor cannot create bots');

r = await api(`/bots/${H}?home=1`, 'DELETE');
ok(r.status === 200 && r.j.deletedFolder && !fs.existsSync(bot.dir), 'delete with its folder');
ok((await api('/agents/' + bot.agentId)).status === 404 && (await api('/bots/' + H)).status === 404, 'agent and bot are gone');
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
