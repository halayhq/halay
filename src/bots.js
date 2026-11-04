// Bots: permanent, UI-creatable agents with a persistent identity and memory. A bot is a definition (this file, table
// `bots`) plus one ordinary agent (agents.get(bot.agent_id)) that carries a `bot` handle, so everything that works on
// agents (the list, rooms, approvals, notifications, schedules, tasks) works on bots. Identity and memory live in files
// the bot's agent reads at the start of a session and updates after every task: BOT.md (its role, editable) and
// memory/ (journal.md, notes.md, threads.md). A context that grows past a threshold is refreshed with the existing
// handoff mechanism while the bot is idle, so a bot runs indefinitely; the memory files carry what matters across.
import fs from 'node:fs';
import path from 'node:path';
import { slug, modeRank } from './util.js';
import { BACKENDS } from './backends/index.js';

export const DEFAULTS = { root: '', ctxTokens: 100_000, idleSeconds: 30 }; // root '' = <data dir>/bots
const RESERVED = new Set(['user', 'you', 'all', 'everyone', 'settings', 'swarm']);
const MODES = ['auto', 'manual', 'acceptEdits', 'plan', 'bypassPermissions', 'cli'];
const rank = modeRank; // least to most permissive (util.js)
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']; // claude --effort
const MEMORY_FILES = { 'journal.md': '# Journal\n\nWhat I did, newest last. One dated entry per task.\n', 'notes.md': '# Notes\n\nDurable facts: the user, projects, preferences, decisions.\n', 'threads.md': '# Open threads\n\nThings pending, waiting on someone, or to follow up. Remove them when settled.\n' };
const MAX_FILE = 200_000;
const MIN_REFRESH_GAP = 30 * 60_000;
const ROLE_START = '<!-- bot:role -->', ROLE_END = '<!-- /bot:role -->';

export { slug };

// what a bot is asked before its context is cleared: memory first, then a short note
export const handoffAsk = (dir) =>
  `[Swarm: fresh context] Your context is about to be cleared to keep it small, and you continue in a new session that sees only your memory files and the note you write now. ` +
  `First bring your memory up to date in ${path.join(dir, 'memory')}: journal.md (what you did), notes.md (durable facts), threads.md (open threads); use tools for that and nothing else. ` +
  `Then reply with only a short handoff note (about 200 words, plain markdown): what you were doing, open threads, next steps, anything the user asked for that is pending.`;

export function createBots({ db, agents, broadcast, root: dataDir, getCfg, putCfg, spawn, removeAgent, accounts, defaultAccount = () => 'claude', browser, rooms }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      handle TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT, role TEXT, account TEXT, cwd TEXT NOT NULL, home INTEGER NOT NULL DEFAULT 1,
      model TEXT, permission_mode TEXT NOT NULL DEFAULT 'manual', browser TEXT, rooms TEXT, ctx_tokens INTEGER, paused INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER
    );
  `);
  try { db.exec('ALTER TABLE bots ADD COLUMN effort TEXT'); } catch {} // claude --effort; NULL = the default
  const q = {
    all: db.prepare('SELECT * FROM bots ORDER BY created_at, handle'),
    get: db.prepare('SELECT * FROM bots WHERE handle=?'),
    ins: db.prepare('INSERT INTO bots (handle,name,emoji,role,account,cwd,home,model,effort,permission_mode,browser,rooms,ctx_tokens,agent_id,created_by,created_at,updated_at) VALUES (@handle,@name,@emoji,@role,@account,@cwd,@home,@model,@effort,@permission_mode,@browser,@rooms,@ctx_tokens,@agent_id,@created_by,@now,@now)'),
    upd: db.prepare('UPDATE bots SET name=@name, emoji=@emoji, role=@role, account=@account, model=@model, effort=@effort, permission_mode=@permission_mode, browser=@browser, rooms=@rooms, ctx_tokens=@ctx_tokens, paused=@paused, agent_id=@agent_id, updated_at=@now WHERE handle=@handle'),
    del: db.prepare('DELETE FROM bots WHERE handle=?'),
    agentName: db.prepare('UPDATE agents SET name=? WHERE id=?'),
    agentModel: db.prepare('UPDATE agents SET model=?, effort=? WHERE id=?'),
    agentMode: db.prepare('UPDATE agents SET permission_mode=? WHERE id=?'),
    agentAccount: db.prepare('UPDATE agents SET account=? WHERE id=?'),
    agentBrowser: db.prepare('UPDATE agents SET browser=? WHERE id=?'),
  };
  const cfg = () => ({ ...DEFAULTS, ...getCfg('bots', DEFAULTS) });
  const botsRoot = () => { const r = cfg().root; return path.resolve(r ? r.replace(/^~(?=$|\/)/, process.env.HOME || '~') : path.join(dataDir, 'bots')); };
  const get = (handle) => q.get.get(String(handle || ''));
  const dirOf = (b) => (b.home ? b.cwd : path.join(b.cwd, '.bots', b.handle)); // BOT.md and memory/ live here
  const agentOf = (b) => agents.get(b.agent_id);
  const roomIds = (b) => { try { return JSON.parse(b.rooms || '[]').filter(Number.isInteger); } catch { return []; } };
  const liveRooms = (b) => rooms.list().filter((r) => r.members.some((m) => m.id === b.agent_id)).map((r) => r.id);

  // ---- files: BOT.md (generated from the role, editable) and the memory folder
  const botMd = (b) =>
    `# ${b.emoji || '🤖'} ${b.name} (@${b.handle})\n\n${ROLE_START}\n${(b.role || '').trim()}\n${ROLE_END}\n\n` +
    `## Notes to self\n\n(Edit freely. Only the role block above is rewritten when the role is changed in the swarm UI.)\n`;
  // bots made before the file was renamed (it was CLAUDE.md): moved to BOT.md the first time it is needed
  const POINTER = '<!-- bot:pointer -->';
  function migrate(b) {
    const d = dirOf(b), old = path.join(d, 'CLAUDE.md'), now = path.join(d, 'BOT.md');
    try {
      if (fs.existsSync(old) && !fs.existsSync(now) && !fs.readFileSync(old, 'utf8').includes(POINTER)) fs.renameSync(old, now);
    } catch {}
  }
  // A Claude bot in its own home folder also gets a short CLAUDE.md that points at BOT.md: Claude Code loads that one by
  // itself, so reading the identity file doesn't rest on the model obeying the prompt (small models sometimes skip it).
  // Other CLIs don't load a CLAUDE.md, and a bot living in a project's .bots/ folder isn't in Claude's working folder.
  function pointer(b) {
    if (!b.home || (accounts()[b.account]?.backend || 'claude') !== 'claude') return;
    const f = path.join(dirOf(b), 'CLAUDE.md');
    try {
      if (!fs.existsSync(f)) fs.writeFileSync(f, `${POINTER}\nYou are a bot. Your identity and instructions are in BOT.md in this folder and your memory is in memory/. ` +
        `Before anything else, read BOT.md, memory/notes.md and memory/threads.md.\n`);
    } catch {}
  }
  function setRole(b) {
    migrate(b);
    const f = path.join(dirOf(b), 'BOT.md');
    let t = '';
    try { t = fs.readFileSync(f, 'utf8'); } catch {}
    const block = `${ROLE_START}\n${(b.role || '').trim()}\n${ROLE_END}`;
    const i = t.indexOf(ROLE_START), j = t.indexOf(ROLE_END);
    const next = !t ? botMd(b) : i >= 0 && j > i ? t.slice(0, i) + block + t.slice(j + ROLE_END.length) : t.replace(/\s*$/, '\n\n') + block + '\n';
    if (next !== t) fs.writeFileSync(f, next);
  }
  function scaffold(b) {
    migrate(b);
    pointer(b);
    const dir = dirOf(b);
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    if (!fs.existsSync(path.join(dir, 'BOT.md'))) fs.writeFileSync(path.join(dir, 'BOT.md'), botMd(b));
    else setRole(b);
    for (const [n, t] of Object.entries(MEMORY_FILES)) if (!fs.existsSync(path.join(dir, 'memory', n))) fs.writeFileSync(path.join(dir, 'memory', n), t);
  }
  // a file name from the UI/API -> absolute path, or null when it is not BOT.md or memory/<name>.md|.txt
  function fileOf(b, name) {
    migrate(b);
    name = String(name || '');
    if (name === 'BOT.md') return path.join(dirOf(b), name);
    const m = name.match(/^memory\/([\w][\w. -]{0,80}\.(?:md|txt))$/);
    return m && !m[1].includes('..') ? path.join(dirOf(b), 'memory', m[1]) : null;
  }
  function listFiles(b) {
    const dir = dirOf(b), out = [];
    const add = (n) => { try { const s = fs.statSync(path.join(dir, n)); if (s.isFile()) out.push({ name: n, size: s.size, mtime: s.mtimeMs }); } catch {} };
    add('BOT.md');
    let names = [];
    try { names = fs.readdirSync(path.join(dir, 'memory')).filter((n) => /\.(md|txt)$/.test(n)).sort(); } catch {}
    const first = Object.keys(MEMORY_FILES);
    for (const n of [...first.filter((x) => names.includes(x)), ...names.filter((x) => !first.includes(x))]) add('memory/' + n);
    return out;
  }

  // ---- what the bot's agent is told, and may do without asking
  function promptFor(handle) {
    const b = get(handle);
    if (!b) return '';
    migrate(b);
    pointer(b);
    const dir = dirOf(b), mem = path.join(dir, 'memory');
    return `You are a bot: a permanent agent in the user's swarm with a persistent identity, "${b.name}" (@${b.handle}). You are not a one-off chat: you keep running for weeks, your context is cleared and restarted from time to time, and whatever you want to remember afterwards has to be written down.\n` +
      `Identity and instructions: ${path.join(dir, 'BOT.md')}. Memory folder: ${mem}/ with journal.md (what you did, newest last), notes.md (durable facts: the user, projects, preferences, decisions) and threads.md (open threads: pending, waiting on someone, to follow up).\n` +
      `At the start of a session (your first turn, and when a message begins with a handoff note) read BOT.md, notes.md, threads.md and the last ~60 lines of journal.md before doing anything else. ` +
      `At the end of every task, before your final answer: append a dated journal entry (run \`date\` for the time) saying what you did and what came of it; add new durable facts to notes.md; update threads.md (add, change, remove). ` +
      `Curate rather than only append: rewrite notes.md and threads.md when they get stale or long (over ~150 lines), and archive old journal entries into memory/journal-archive.md. Keep entries short and concrete (paths, ids, decisions). Update the memory files with the Edit and Write tools (they need no approval there), not with shell redirects such as echo >> (those wait for the user's approval). ` +
      `The memory files are the source of truth across context refreshes and restarts; trust them over your recollection, and re-read files before relying on them. ` +
      `Edit BOT.md only when the user asks you to change your role. Messages to you come from the user, from rooms (@${b.handle}), schedules and tasks; they all reach you as normal turns.`;
  }
  // memory writes must never wait for an approval, whatever the bot's permission mode
  const allowRules = (handle) => {
    const b = get(handle);
    if (!b) return [];
    const dir = dirOf(b); // an absolute path rule starts with //
    return [`Edit(/${dir}/memory/**)`, `Edit(/${dir}/BOT.md)`, `Read(/${dir}/**)`];
  };

  // ---- agent
  const badge = (handle) => { const b = get(handle); return b ? { handle: b.handle, emoji: b.emoji || '🤖', paused: !!b.paused } : null; };
  function out(b) {
    const a = agentOf(b), r = liveRooms(b);
    return {
      handle: b.handle, name: b.name, emoji: b.emoji || '🤖', role: b.role || '', account: b.account, cwd: b.cwd, dir: dirOf(b), home: !!b.home, model: b.model || '', effort: b.effort || '',
      permissionMode: b.permission_mode, browser: b.browser || '', rooms: a ? r : roomIds(b), ctxTokens: b.ctx_tokens || null, ctxDefault: cfg().ctxTokens, paused: !!b.paused,
      agentId: b.agent_id, status: a ? a.status : 'missing', context: a ? a.ctx : 0, handoff: a?.handoff?.phase || null, createdAt: b.created_at, updatedAt: b.updated_at,
    };
  }
  const push = (b) => broadcast({ type: 'bot', bot: out(b) });
  const save = (b, patch = {}) => { Object.assign(b, patch); q.upd.run({ ...b, now: Date.now() }); return b; };

  // the bot's agent, created when missing (first start, or its process record is gone)
  function ensureAgent(b) {
    let a = agentOf(b);
    if (a) return { agent: a };
    if (!fs.existsSync(b.cwd)) return { code: 400, error: `the bot's folder is gone: ${b.cwd}` };
    scaffold(b);
    const r = spawn({ cwd: b.cwd, permissionMode: b.permission_mode, account: b.account, model: b.model || undefined, effort: b.effort || undefined, name: b.name, browser: b.browser || false }, { id: b.agent_id && !agents.has(b.agent_id) ? b.agent_id : undefined, bot: b.handle });
    if (r.error) return r;
    a = r.agent;
    if (b.agent_id !== a.id) save(b, { agent_id: a.id });
    for (const id of roomIds(b)) rooms.join(id, a.id);
    return { agent: a };
  }

  // ---- create / edit
  const trimmed = (v, n) => String(v ?? '').trim().slice(0, n);
  function validate(f, caller, old) {
    if (!trimmed(f.name, 60)) return { code: 400, error: 'name required' };
    if (!trimmed(f.role, 20000)) return { code: 400, error: 'role (instructions) required' };
    if (!accounts()[f.account]) return { code: 400, error: `unknown account ${f.account} (accounts: ${Object.keys(accounts()).join(', ')})` };
    if (!MODES.includes(f.permission_mode)) return { code: 400, error: 'permission_mode must be one of ' + MODES.join(', ') };
    const be = BACKENDS[accounts()[f.account].backend] || BACKENDS.claude; // the account's coding-agent CLI decides which modes and efforts exist
    if (!be.capabilities.modes.includes(f.permission_mode)) return { code: 400, error: `a ${be.label} bot can't use permission mode ${f.permission_mode} (it can: ${be.capabilities.modes.join(', ')})` };
    if (caller && rank(f.permission_mode) > rank(caller.permissionMode) && !(old && rank(f.permission_mode) <= rank(old.permission_mode)))
      return { code: 400, error: 'a bot cannot be more permissive than the agent creating it' };
    if (f.browser && !browser.validName(f.browser)) return { code: 400, error: 'bad browser profile name (letters, digits, - and _)' };
    if (f.browser && !browser.available()) return { code: 400, error: 'the browser tool is not installed (npm install, then see docs/browser.md)' };
    if (f.effort && !EFFORTS.includes(f.effort)) return { code: 400, error: 'effort must be one of ' + EFFORTS.join(', ') };
    if (f.effort && !be.capabilities.effort.includes(f.effort)) return { code: 400, error: `${be.label} has no effort setting` };
    if (f.ctx_tokens != null && !(f.ctx_tokens >= 50_000 && f.ctx_tokens <= 1_000_000)) return { code: 400, error: 'context threshold must be 50000-1000000 tokens' };
    return null;
  }
  // browser: false/'' = none, true = the default profile, a name = that profile
  const browserOf = (v) => (v === undefined ? undefined : v === false || v === 'false' || v === '' || v === null ? null : v === true || v === 'true' ? browser.cfg().profile : String(v));

  function create(body, caller) {
    const name = trimmed(body.name, 60), handle = slug(body.handle || name);
    if (!handle) return { code: 400, error: 'handle: use letters and digits (it is how rooms @mention the bot)' };
    if (RESERVED.has(handle)) return { code: 400, error: `@${handle} is reserved` };
    if (get(handle)) return { code: 409, error: `a bot @${handle} already exists` };
    let cwd = trimmed(body.cwd, 1000), home = 0;
    if (cwd) {
      cwd = path.resolve(cwd);
      if (!(fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) return { code: 400, error: `cwd must be an existing directory: ${cwd}` };
    } else { cwd = path.join(botsRoot(), handle); home = 1; }
    const f = {
      handle, name, emoji: trimmed(body.emoji, 8) || '🤖', role: trimmed(body.role, 20000), account: body.account || caller?.account || defaultAccount(), cwd, home,
      model: trimmed(body.model, 80) || null, effort: trimmed(body.effort, 10) || null, permission_mode: body.permissionMode || body.permission_mode || 'manual', browser: browserOf(body.browser) ?? null,
      rooms: null, ctx_tokens: body.ctxTokens ? Number(body.ctxTokens) : null, agent_id: null, created_by: caller?.id || null,
    };
    const bad = validate(f, caller);
    if (bad) return bad;
    const ids = [...new Set(Array.isArray(body.rooms) ? body.rooms.map(Number) : [])];
    for (const id of ids) if (!rooms.exists(id)) return { code: 400, error: `no room #${id}` };
    f.rooms = JSON.stringify(ids);
    try { scaffold(f); } catch (e) { return { code: 500, error: `could not create the bot's folder ${dirOf(f)}: ${e.message}` }; }
    const now = Date.now();
    q.ins.run({ ...f, now });
    const b = get(handle), r = ensureAgent(b);
    if (r.error) { q.del.run(handle); return r; }
    push(b);
    console.log(`bot @${handle}: created (agent ${b.agent_id}, ${home ? 'home ' : 'folder '}${cwd})`);
    return { bot: out(get(handle)) };
  }

  function patch(b, body, caller) {
    const f = { ...b };
    if (body.name !== undefined) f.name = trimmed(body.name, 60);
    if (body.emoji !== undefined) f.emoji = trimmed(body.emoji, 8) || '🤖';
    if (body.role !== undefined) f.role = trimmed(body.role, 20000);
    if (body.account !== undefined) f.account = body.account;
    if (body.model !== undefined) f.model = trimmed(body.model, 80) || null;
    if (body.effort !== undefined) f.effort = trimmed(body.effort, 10) || null;
    if (body.permissionMode !== undefined || body.permission_mode !== undefined) f.permission_mode = body.permissionMode ?? body.permission_mode;
    if (body.browser !== undefined) f.browser = browserOf(body.browser);
    if (body.ctxTokens !== undefined) f.ctx_tokens = body.ctxTokens ? Number(body.ctxTokens) : null;
    const backendOf = (acct) => accounts()[acct]?.backend || 'claude';
    if (accounts()[f.account] && backendOf(f.account) !== backendOf(b.account)) { // another CLI: the old model, effort and mode may mean nothing there
      if (body.model === undefined) f.model = null;
      if (body.effort === undefined) f.effort = null;
      const modes = BACKENDS[backendOf(f.account)].capabilities.modes;
      if (body.permissionMode === undefined && body.permission_mode === undefined && !modes.includes(f.permission_mode)) f.permission_mode = 'manual';
    }
    const bad = validate(f, caller, b);
    if (bad) return bad;
    let ids = null;
    if (body.rooms !== undefined) {
      ids = [...new Set((Array.isArray(body.rooms) ? body.rooms : []).map(Number))];
      for (const id of ids) if (!rooms.exists(id)) return { code: 400, error: `no room #${id}` };
    }
    const a = agentOf(b);
    const runtime = a && (f.account !== b.account || f.model !== b.model || f.effort !== b.effort || f.permission_mode !== b.permission_mode || f.browser !== b.browser);
    if (runtime && (a.status === 'running' || a.handoff)) return { code: 409, error: 'the bot is busy; change its account, model, mode or browser when it is idle' };
    if (a) {
      if (f.name !== b.name) { a.name = f.name; q.agentName.run(f.name, a.id); }
      if (f.model !== b.model || f.effort !== b.effort) { a.model = f.model || null; a.effort = f.effort || null; q.agentModel.run(f.model, f.effort, a.id); }
      if (f.permission_mode !== b.permission_mode) { a.permissionMode = f.permission_mode; q.agentMode.run(f.permission_mode, a.id); }
      if (f.browser !== b.browser) { a.browser = f.browser; q.agentBrowser.run(f.browser, a.id); }
      if (f.account !== b.account) { a.account = f.account; q.agentAccount.run(f.account, a.id); a.resetContext(); a.setBackend(accounts()[f.account].backend); } // a session lives in its account's config dir; memory carries over
      else if (runtime) a.killProc(); // the next message starts a process with the new settings and resumes the session
    }
    if (ids) {
      f.rooms = JSON.stringify(ids);
      if (a) {
        const have = new Set(liveRooms(b));
        for (const id of have) if (!ids.includes(id)) rooms.leave(id, a.id);
        for (const id of ids) if (!have.has(id)) rooms.join(id, a.id);
      }
    }
    save(b, f);
    if (body.role !== undefined || body.name !== undefined || body.emoji !== undefined) { try { setRole(b); } catch (e) { console.error(`bot @${b.handle}: could not update BOT.md: ${e.message}`); } }
    if (a) broadcast({ type: 'agent', agent: a.summary() });
    push(b);
    return { bot: out(b) };
  }

  function setPaused(b, paused) {
    if (!!b.paused === paused) return { bot: out(b) };
    save(b, { paused: paused ? 1 : 0 });
    const a = agentOf(b);
    if (a && paused) { a.denyPending('bot paused'); if (a.handoff) a.failHandoff('the bot was paused'); a.killProc(); a.push({ type: 'note', text: 'Bot paused: messages are held back until it is resumed' }); }
    else if (a) a.push({ type: 'note', text: 'Bot resumed' });
    if (a) broadcast({ type: 'agent', agent: a.summary() });
    push(b);
    return { bot: out(b) };
  }

  // the bot's folder is only ever deleted when it is a real directory below the bots root (home bots) or its .bots/<handle> memory dir
  function remove(b, { deleteHome }) {
    const a = agentOf(b);
    if (a) removeAgent(a, { force: true });
    q.del.run(b.handle);
    let kept = null;
    const dir = dirOf(b);
    if (deleteHome) {
      const ok = b.home ? dir.startsWith(botsRoot() + path.sep) && path.basename(dir) === b.handle : path.basename(path.dirname(dir)) === '.bots' && path.basename(dir) === b.handle;
      if (ok) fs.rmSync(dir, { recursive: true, force: true }); else kept = 'refused to delete a folder outside the bots root';
    }
    broadcast({ type: 'bot_removed', handle: b.handle });
    console.log(`bot @${b.handle}: deleted${deleteHome && !kept ? ' with its folder' : ', folder kept at ' + dir}`);
    return { ok: true, deletedFolder: !!deleteHome && !kept, folder: dir, note: kept };
  }

  // ---- background upkeep: re-create missing agents, refresh big idle contexts
  const refreshing = new Set(), warned = new Set(); // warned: handles whose re-create error was logged (rows are re-read every tick)
  function tick() {
    const c = cfg(), now = Date.now();
    for (const b of q.all.all()) {
      let a = agentOf(b);
      if (!a) {
        const r = ensureAgent(b);
        if (r.error) { if (!warned.has(b.handle)) { console.error(`bot @${b.handle}: could not re-create its agent: ${r.error}`); warned.add(b.handle); } continue; }
        warned.delete(b.handle);
        a = r.agent;
        console.log(`bot @${b.handle}: agent re-created (${a.id})`);
        push(b);
      }
      const live = liveRooms(b);
      if (JSON.stringify(live) !== JSON.stringify(roomIds(b))) save(b, { rooms: JSON.stringify(live) });
      const lastReset = a.events.findLast((e) => e.type === 'context_reset')?._ts || 0; // a fresh session already starts big (tools, prompts): never refresh in a loop
      if (now - lastReset < MIN_REFRESH_GAP) continue;
      if (b.paused || a.handoff || refreshing.has(b.handle) || !a.sessionId || a.status !== 'idle' || a.pendingApprovals().length) continue;
      if (a.ctx < (b.ctx_tokens || c.ctxTokens) || now - a.lastEventAt < c.idleSeconds * 1000 || now - (a.recycleFailedAt || 0) < 10 * 60_000) continue;
      console.log(`bot @${b.handle}: context ${Math.round(a.ctx / 1000)}k, refreshing with a handoff`);
      refreshing.add(b.handle);
      refresh(b, true).then((r) => { if (r.error) { a.recycleFailedAt = Date.now(); console.log(`bot @${b.handle}: refresh failed: ${r.error}`); } }).finally(() => refreshing.delete(b.handle));
    }
  }
  async function refresh(b, auto) {
    const r = ensureAgent(b);
    if (r.error) return r;
    const a = r.agent;
    if (b.paused) return { code: 409, error: 'the bot is paused' };
    const h = await a.startHandoff({ auto });
    if (h.error) return h;
    return h.done;
  }
  const timer = setInterval(tick, 30_000); timer.unref();
  setTimeout(tick, 2000).unref();

  // ---- REST. Only the user and the conductor manage bots; other agents get nothing.
  async function handle(req, url, res, { json, readBody }) {
    const m = url.pathname.match(/^\/api\/bots(?:\/([^/]+))?(?:\/([a-z]+))?$/);
    if (!m) return false;
    const caller = String(req.headers['x-halay-agent'] || '') || null, callerAgent = caller && agents.get(caller);
    if (caller && !callerAgent) return json(res, 403, { error: 'unknown agent' }), true;
    if (callerAgent && callerAgent.role !== 'conductor') return json(res, 403, { error: 'only the user and the swarm chat manage bots' }), true;
    const reply = (r, ok = 200) => (r.error ? json(res, r.code || 400, { error: r.error, ...(r.extra || {}) }) : json(res, ok, r.bot || r));
    const [, h, sub] = m;
    if (!h) {
      if (req.method === 'GET') return json(res, 200, q.all.all().map(out)), true;
      if (req.method === 'POST') return reply(create(await readBody(req), callerAgent || null), 201), true;
      return false;
    }
    if (h === 'settings') {
      if (req.method === 'GET') return json(res, 200, { ...cfg(), resolvedRoot: botsRoot() }), true;
      if (req.method === 'PUT') {
        if (callerAgent) return json(res, 403, { error: 'only the user changes bot settings' }), true;
        const body = await readBody(req), cur = cfg(), next = { root: String(body.root ?? cur.root).trim(), ctxTokens: Math.round(Number(body.ctxTokens ?? cur.ctxTokens)), idleSeconds: cur.idleSeconds };
        if (!(next.ctxTokens >= 50_000 && next.ctxTokens <= 1_000_000)) return json(res, 400, { error: 'context threshold must be 50000-1000000 tokens' }), true;
        putCfg('bots', next);
        return json(res, 200, { ...cfg(), resolvedRoot: botsRoot() }), true;
      }
      return false;
    }
    const b = get(h);
    if (!b) return json(res, 404, { error: 'no such bot' }), true;
    if (!sub) {
      if (req.method === 'GET') return json(res, 200, out(b)), true;
      if (req.method === 'PATCH') return reply(patch(b, await readBody(req), callerAgent || null)), true;
      if (req.method === 'DELETE') {
        if (callerAgent) return json(res, 403, { error: 'only the user deletes bots' }), true;
        return reply(remove(b, { deleteHome: url.searchParams.get('home') === '1' })), true;
      }
      return false;
    }
    if (req.method === 'POST' && sub === 'pause') return reply(setPaused(b, true)), true;
    if (req.method === 'POST' && sub === 'resume') return reply(setPaused(b, false)), true;
    if (req.method === 'POST' && sub === 'refresh') { const r = await refresh(b, false); return reply(r.error ? r : { ok: true, note: r.note }), true; }
    if (sub === 'files' && req.method === 'GET') return json(res, 200, listFiles(b)), true;
    if (sub === 'file') {
      const name = url.searchParams.get('name'), f = fileOf(b, name);
      if (!f) return json(res, 400, { error: 'name must be BOT.md or memory/<file>.md' }), true;
      if (req.method === 'GET') {
        try { return json(res, 200, { name, content: fs.readFileSync(f, 'utf8') }), true; } catch { return json(res, 404, { error: 'no such file' }), true; }
      }
      if (req.method === 'PUT') {
        const { content } = await readBody(req);
        if (typeof content !== 'string' || content.length > MAX_FILE) return json(res, 400, { error: `content must be text up to ${MAX_FILE} characters` }), true;
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, content);
        if (name === 'BOT.md') { // keep the role field in step with a hand-edited role block
          const t = content, i = t.indexOf(ROLE_START), j = t.indexOf(ROLE_END);
          if (i >= 0 && j > i) { const role = t.slice(i + ROLE_START.length, j).trim(); if (role && role !== b.role) { save(b, { role }); push(b); } }
        }
        return json(res, 200, { ok: true }), true;
      }
      if (req.method === 'DELETE') {
        if (name === 'BOT.md' || name.slice(7) in MEMORY_FILES) return json(res, 400, { error: 'the core files cannot be deleted' }), true;
        fs.rmSync(f, { force: true });
        return json(res, 200, { ok: true }), true;
      }
    }
    return false;
  }

  // start_agent from another agent must not quietly duplicate a bot: a bot's own folder or name means "message the bot"
  function duplicateOf({ cwd, name }) {
    const c = cwd && path.resolve(cwd), n = slug(name);
    for (const b of q.all.all()) {
      if ((c && b.home && path.resolve(b.cwd) === c) || (n && n === b.handle) || (name && String(name).trim().toLowerCase() === b.name.toLowerCase()))
        return `that is bot @${b.handle} (agent ${b.agent_id}): it is permanent, so message it with send_message instead of starting another agent for it`;
    }
    return null;
  }

  return {
    handle, promptFor, allowRules, badge, get, list: () => q.all.all().map(out), agentIdOf: (handle) => get(handle)?.agent_id || null, ensureAgent: (handle) => { const b = get(handle); return b ? ensureAgent(b) : { code: 404, error: `no bot @${handle}` }; },
    isPaused: (handle) => !!get(handle)?.paused, dirOf: (handle) => { const b = get(handle); return b ? dirOf(b) : null; }, duplicateOf, handoffAsk, tick, cfg,
  };
}
