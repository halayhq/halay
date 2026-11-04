import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createBrowser } from './browser.js';
import Database from 'better-sqlite3';
import webpush from 'web-push';
import { Cron } from 'croner';
import * as gitt from './git-tools.js';
import { createAuth } from './auth.js';
import { createRooms } from './rooms.js';
import { createBots } from './bots.js';
import { modeRank, env } from './util.js';
import { setupHome, ensureDataDir, describeReason } from './cli/home.js';
import { tlsConfig, checkTls, certPaths, machineNames, CHECK_MS } from './cli/cert.js';
import { BACKENDS, backendOf, DEFAULT_BACKEND, usable } from './backends/index.js';
import { systemPrompt, swarmAsks, swarmPlans } from './prompts.js';
import { noticeText, mergeNotice } from './agent-notify.js';
import { peerFromEntry, peerEvent, PeerTail, peerNames } from './peer-messages.js';
import { createEditorFs } from './editor-fs.js';
import { createPeers } from './peers.js';
import { createStats } from './stats.js';
import { installKind, INSTALL_FOR_GOOD } from './cli/install-kind.js';
import { APP_NAME, APP_SHORT_NAME, APP_VERSION, BRAND_SURFACE } from './product.js';
import { createPluginHost } from './plugins.js';
import { initTerms, termApi, termUpgrade, listTerms, killAllTerms, onTermsChange } from './terminal.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // the package folder (src/..)
const INSTALL_KIND = installKind(ROOT);
const LAUNCH_ENV = { ...process.env }; // before .env is merged in, so a restart (Settings → Restart server) re-reads .env
// The data dir (home.js): HALAY_HOME, else HALAY_DB's folder, else this folder when it is a git checkout that already
// holds data, else ~/.halay. Every file written at runtime goes below it; code and static files stay in ROOT.
// .env files (see .env.example): the real environment wins, then <data dir>/.env, then ROOT/.env (a clone's).
const HOME = setupHome({ root: ROOT });
const DATA_DIR = HOME.dir;
const dataDirCreated = ensureDataDir(HOME);
const dataPath = (...p) => path.join(DATA_DIR, ...p);
console.log(`data: ${DATA_DIR} (${describeReason(HOME.reason)}${dataDirCreated ? ', created now' : ''})${HOME.envFiles.length ? '; settings from ' + HOME.envFiles.join(', ') : ''}`);
const PORT = Number(process.env.PORT || 4777);
// Loopback by default. Set HOST=0.0.0.0 to reach it from your phone (use Tailscale/LAN only).
const HOST = process.env.HOST || '127.0.0.1';
// HTTPS (cert.js, `halay cert install`, or your own HALAY_TLS_CERT/HALAY_TLS_KEY): when there is a certificate, the app
// is also served over HTTPS on HALAY_HTTPS_PORT at HOST, and plain HTTP stays on loopback only (agents, the swarm MCP
// server, the restart helper and tailscale serve use http://127.0.0.1, which never needs the private CA) unless
// HALAY_HTTP_HOST says otherwise.
const TLS = tlsConfig({ dataDir: DATA_DIR });
if (TLS?.error) console.warn('https: ' + TLS.error);
const HTTPS_ON = !!TLS && !TLS.error;
const HTTPS_PORT = Number(env('HTTPS_PORT') || 4778);
const isLoopback = (h) => h === '127.0.0.1' || h === '::1' || h === 'localhost';
const HTTP_HOST = env('HTTP_HOST') || (HTTPS_ON && !isLoopback(HOST) ? '127.0.0.1' : HOST);

// Access token: env var, else persisted in .token
const TOKEN_FILE = dataPath('.token');
let tokenCreated = false; // the token is shown in the log only the first time; after that the log points to .token
const TOKEN =
  env('TOKEN') ||
  (fs.existsSync(TOKEN_FILE)
    ? fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    : (() => {
        const t = crypto.randomBytes(16).toString('hex');
        fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
        tokenCreated = true;
        return t;
      })());

// Local app token (the macOS menu-bar app, macos/): a second, random credential that only signs a browser session in
// (POST /auth/local, auth.js), written owner-only (mode 600) so that being able to read it is the proof of being this user.
// It is new at every start, not kept like .token: a copy that leaks (a backup of the data folder, a screenshot) then dies
// with the next restart, and nothing else depends on it (the app reads the file each time it signs in; the sessions it
// got keep working). HALAY_LOCAL_APP=0 turns it off: no file, no endpoint.
const LOCAL_TOKEN_FILE = dataPath('local-app-token');
const LOCAL_TOKEN = env('LOCAL_APP') === '0' ? null : (() => {
  const t = crypto.randomBytes(32).toString('base64url'), tmp = LOCAL_TOKEN_FILE + '.tmp';
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, t, { mode: 0o600, flag: 'wx' }); // 600 from the first byte, then renamed over the old one: never readable by others
    fs.renameSync(tmp, LOCAL_TOKEN_FILE);
    return t;
  } catch (e) { console.warn(`local-app-token: can't write ${LOCAL_TOKEN_FILE} (${e.code || e.message}); the Mac app can't sign in`); return null; }
})();

// ---- persistence ---------------------------------------------------------

const DB_PATH = env('DB') || path.join(DATA_DIR, 'halay.db');
const RUNS = dataPath('runs'); // per-agent <id>.in (stdin FIFO) and <id>.out (claude's output)
fs.mkdirSync(RUNS, { recursive: true, mode: 0o700 });
// owner-only: the database holds peers' access tokens, the Web Push private key and plugin secrets; runs/ holds every
// agent's output and its MCP config (with the token). Tightened at each start too, for files made before this.
const chmodQuiet = (f, m) => { try { fs.chmodSync(f, m); } catch {} };
chmodQuiet(RUNS, 0o700);
if (!env('TOKEN')) chmodQuiet(TOKEN_FILE, 0o600);
const db = new Database(DB_PATH);
for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) chmodQuiet(f, 0o600); // before WAL mode: SQLite gives -wal/-shm the db's mode
db.pragma('journal_mode = WAL');
// browser login (passkeys + sessions); the token remains the machine credential. PUBLIC_URL is defined further down.
const auth = createAuth({ db, token: TOKEN, publicUrl: () => PUBLIC_URL(), localToken: LOCAL_TOKEN });
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT, cwd TEXT, account TEXT, permission_mode TEXT,
    model TEXT, session_id TEXT, created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, id);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, json TEXT NOT NULL, ua TEXT, created_at INTEGER);
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER UNIQUE, agent_id TEXT NOT NULL, account TEXT, ts INTEGER, day TEXT,
    input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_create INTEGER NOT NULL DEFAULT 0,
    cost REAL, cum_cost REAL, source TEXT
  );
  CREATE INDEX IF NOT EXISTS usage_agent ON usage(agent_id, id);
  CREATE INDEX IF NOT EXISTS usage_day ON usage(day, account);
  CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, agent_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, prompt TEXT, cwd TEXT, account TEXT,
    status TEXT NOT NULL DEFAULT 'queued', position INTEGER NOT NULL DEFAULT 0, agent_id TEXT, result TEXT,
    created_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, prompt TEXT, cwd TEXT, account TEXT, permission_mode TEXT,
    one_off INTEGER NOT NULL DEFAULT 0, cron TEXT NOT NULL, tz TEXT, enabled INTEGER NOT NULL DEFAULT 1,
    overlap TEXT NOT NULL DEFAULT 'skip', notify TEXT NOT NULL DEFAULT 'always', keep_agents INTEGER NOT NULL DEFAULT 3,
    next_run_at INTEGER, last_run_at INTEGER, last_task_id INTEGER, skip_reason TEXT, skipped_at INTEGER,
    created_at INTEGER, updated_at INTEGER
  );
`);
// pid/out_offset let a restarted server reattach to the claude process it left running
for (const col of ['pid INTEGER', 'out_offset INTEGER DEFAULT 0', 'parent_id TEXT', 'role TEXT', 'wt TEXT']) try { db.exec(`ALTER TABLE agents ADD COLUMN ${col}`); } catch {}
try { db.exec('ALTER TABLE events ADD COLUMN ts INTEGER'); } catch {} // when the event was recorded (older rows have none)
for (const col of ['depends_on TEXT', 'auto_start INTEGER NOT NULL DEFAULT 0', 'scheduled_from INTEGER']) try { db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch {}
try { db.exec('ALTER TABLE agents ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0'); } catch {} // 1 = hidden from the agent list (UI only; the agent keeps running)
try { db.exec('ALTER TABLE agents ADD COLUMN lean INTEGER'); } catch {} // 1/0 = launch with/without --strict-mcp-config; NULL = the global default
try { db.exec('ALTER TABLE agents ADD COLUMN browser TEXT'); } catch {} // the browser profile this agent gets (browser.js); NULL = none
for (const t of ['agents', 'schedules', 'tasks']) try { db.exec(`ALTER TABLE ${t} ADD COLUMN bot TEXT`); } catch {} // the bot (bots.js handle) an agent is, or a schedule / task is aimed at
try { db.exec('ALTER TABLE schedules ADD COLUMN created_by TEXT'); } catch {} // the agent that added it through MCP; NULL = the user (UI)
try { db.exec('ALTER TABLE agents ADD COLUMN effort TEXT'); } catch {} // --effort level; NULL = the CLI default
try { db.exec('ALTER TABLE agents ADD COLUMN started_by TEXT'); } catch {} // 'peer:<name>' when another swarm instance started it (peers.js); NULL = the user or parent_id
try { db.exec('ALTER TABLE agents ADD COLUMN notify INTEGER'); } catch {} // 0 = don't wake the parent when this agent's turn ends (start_agent notify=false); NULL = on
for (const col of ['backend TEXT', 'backend_state TEXT']) try { db.exec(`ALTER TABLE agents ADD COLUMN ${col}`); } catch {} // the coding-agent CLI (backends/); NULL = claude. backend_state: its driver's JSON state for reattaching
try { db.exec('ALTER TABLE tasks ADD COLUMN added_by TEXT'); } catch {} // 'peer:<name>' when another swarm instance added it; NULL = here
for (const t of ['schedules', 'tasks']) for (const col of ['model TEXT', 'effort TEXT']) try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${col}`); } catch {} // for the agent it starts; NULL = the defaults
const q = {
  insAgent: db.prepare('INSERT INTO agents (id,name,cwd,account,permission_mode,model,session_id,created_at,parent_id,role,wt) VALUES (@id,@name,@cwd,@account,@permission_mode,@model,@session_id,@created_at,@parent_id,@role,@wt)'),
  setProc: db.prepare('UPDATE agents SET pid=?, out_offset=? WHERE id=?'),
  setOffset: db.prepare('UPDATE agents SET out_offset=? WHERE id=?'),
  setSession: db.prepare('UPDATE agents SET session_id=? WHERE id=?'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key=?'),
  putSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  delSetting: db.prepare('DELETE FROM settings WHERE key=?'),
  setMode: db.prepare('UPDATE agents SET permission_mode=? WHERE id=?'),
  setAccount: db.prepare('UPDATE agents SET account=? WHERE id=?'),
  setBackend: db.prepare('UPDATE agents SET backend=? WHERE id=?'),
  setBackendState: db.prepare('UPDATE agents SET backend_state=? WHERE id=?'),
  delAgent: db.prepare('DELETE FROM agents WHERE id=?'),
  delEvents: db.prepare('DELETE FROM events WHERE agent_id=?'),
  insEvent: db.prepare('INSERT INTO events (agent_id, json, ts) VALUES (?, ?, ?)'),
  insFts: db.prepare('INSERT INTO events_fts (rowid, text, agent_id) VALUES (?, ?, ?)'),
  delFts: db.prepare('DELETE FROM events_fts WHERE rowid IN (SELECT id FROM events WHERE agent_id=?)'),
  lastTs: db.prepare('SELECT MAX(ts) AS ts FROM events WHERE agent_id=?'),
  insUsage: db.prepare('INSERT OR IGNORE INTO usage (event_id,agent_id,account,ts,day,input,output,cache_read,cache_create,cost,cum_cost,source) VALUES (@event_id,@agent_id,@account,@ts,@day,@input,@output,@cache_read,@cache_create,@cost,@cum_cost,@source)'),
  lastCum: db.prepare('SELECT cum_cost FROM usage WHERE agent_id=? AND cum_cost IS NOT NULL ORDER BY id DESC LIMIT 1'),
  agentUsage: db.prepare('SELECT agent_id, COUNT(*) turns, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_create) cache_create, SUM(cost) cost, SUM(cost IS NULL) no_cost FROM usage GROUP BY agent_id'),
  agentTurns: db.prepare('SELECT ts, input, output, cache_read, cache_create, cost, source FROM usage WHERE agent_id=? ORDER BY id DESC LIMIT 30'),
  dayTotals: db.prepare('SELECT SUM(cost) cost, SUM(input+output) tokens FROM usage WHERE account=? AND day=?'),
  allAgents: db.prepare('SELECT * FROM agents'),
  agentEvents: db.prepare('SELECT json, ts FROM events WHERE agent_id=? ORDER BY id'),
  allSubs: db.prepare('SELECT endpoint, json FROM push_subs'),
  putSub: db.prepare('INSERT INTO push_subs (endpoint,json,ua,created_at) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET json=excluded.json, ua=excluded.ua'),
  delSub: db.prepare('DELETE FROM push_subs WHERE endpoint=?'),
  allTasks: db.prepare('SELECT * FROM tasks ORDER BY position, id'),
  getTask: db.prepare('SELECT * FROM tasks WHERE id=?'),
  insTask: db.prepare('INSERT INTO tasks (title,prompt,cwd,account,model,effort,depends_on,auto_start,bot,status,position,created_at,updated_at) VALUES (@title,@prompt,@cwd,@account,@model,@effort,@depends_on,@auto_start,@bot,\'queued\',(SELECT COALESCE(MAX(position),0)+1 FROM tasks),@now,@now)'),
  updTask: db.prepare('UPDATE tasks SET title=@title, prompt=@prompt, cwd=@cwd, account=@account, model=@model, effort=@effort, depends_on=@depends_on, auto_start=@auto_start, bot=@bot, status=@status, agent_id=@agent_id, result=@result, updated_at=@now WHERE id=@id'),
  delTask: db.prepare('DELETE FROM tasks WHERE id=?'),
  orphanTasks: db.prepare("UPDATE tasks SET agent_id=NULL, status=CASE WHEN status='running' THEN 'failed' ELSE status END, result=CASE WHEN status='running' THEN 'agent removed' ELSE result END WHERE agent_id=?"),
  setPos: db.prepare('UPDATE tasks SET position=? WHERE id=?'),
  runningTasks: db.prepare("SELECT * FROM tasks WHERE agent_id=? AND status='running'"),
  insRunTask: db.prepare('INSERT INTO tasks (title,prompt,cwd,account,model,effort,scheduled_from,status,position,created_at,updated_at) VALUES (@title,@prompt,@cwd,@account,@model,@effort,@scheduled_from,\'queued\',(SELECT COALESCE(MAX(position),0)+1 FROM tasks),@now,@now)'),
  prevRun: db.prepare('SELECT * FROM tasks WHERE scheduled_from=? AND id<? ORDER BY id DESC LIMIT 1'),
  schedRuns: db.prepare('SELECT * FROM tasks WHERE scheduled_from=? ORDER BY id DESC'),
  allSchedules: db.prepare('SELECT * FROM schedules ORDER BY id'),
  getSchedule: db.prepare('SELECT * FROM schedules WHERE id=?'),
  insSchedule: db.prepare('INSERT INTO schedules (title,prompt,cwd,account,permission_mode,model,effort,one_off,cron,tz,enabled,overlap,notify,keep_agents,next_run_at,created_by,bot,created_at,updated_at) VALUES (@title,@prompt,@cwd,@account,@permission_mode,@model,@effort,@one_off,@cron,@tz,@enabled,@overlap,@notify,@keep_agents,@next_run_at,@created_by,@bot,@now,@now)'),
  updSchedule: db.prepare('UPDATE schedules SET title=@title, prompt=@prompt, cwd=@cwd, account=@account, permission_mode=@permission_mode, model=@model, effort=@effort, one_off=@one_off, cron=@cron, tz=@tz, enabled=@enabled, overlap=@overlap, notify=@notify, keep_agents=@keep_agents, next_run_at=@next_run_at, bot=@bot, updated_at=@now WHERE id=@id'),
  setScheduleRun: db.prepare('UPDATE schedules SET last_run_at=?, last_task_id=?, skip_reason=NULL, skipped_at=NULL WHERE id=?'),
  setScheduleNext: db.prepare('UPDATE schedules SET next_run_at=? WHERE id=?'),
  setScheduleSkip: db.prepare('UPDATE schedules SET skip_reason=?, skipped_at=? WHERE id=?'),
  delSchedule: db.prepare('DELETE FROM schedules WHERE id=?'),
};
q.setLean = db.prepare('UPDATE agents SET lean=? WHERE id=?');
q.setNotify = db.prepare('UPDATE agents SET notify=? WHERE id=?');
q.setStartedBy = db.prepare('UPDATE agents SET started_by=? WHERE id=?');
q.setAddedBy = db.prepare('UPDATE tasks SET added_by=? WHERE id=?');
q.setBrowser = db.prepare('UPDATE agents SET browser=? WHERE id=?');
q.setHidden = db.prepare('UPDATE agents SET hidden=? WHERE id=?');
q.setBot = db.prepare('UPDATE agents SET bot=? WHERE id=?');
q.setModel = db.prepare('UPDATE agents SET model=?, effort=? WHERE id=?');

// ---- small settings helpers (cached; cleared on write) -------------------------

const cfgCache = new Map();
const getCfg = (key, defaults) => {
  if (!cfgCache.has(key)) {
    let saved = {};
    try { saved = JSON.parse(q.getSetting.get(key)?.value || '{}'); } catch {}
    cfgCache.set(key, { ...defaults, ...saved });
  }
  return cfgCache.get(key);
};
const putCfg = (key, v) => { q.putSetting.run(key, JSON.stringify(v)); cfgCache.delete(key); };
// idleMinutes: silence while no tool runs; toolMinutes: silence during a tool call (a long Bash command is legitimate);
// startMinutes: a delivered message claude hasn't answered at all (it prints its init line within seconds of reading one)
const WATCHDOG_DEFAULTS = { enabled: true, idleMinutes: 15, toolMinutes: 60, startMinutes: 3, repeatCount: 4 };
const watchdogCfg = () => getCfg('watchdog', WATCHDOG_DEFAULTS);
const usageAlertsCfg = () => getCfg('usage_alerts', { accounts: {} }); // accounts: { name: { dailyCost, dailyTokens } }
// context size: gauge colours, the push at `high`, recycling with a handoff note, the CLI's auto-compact window, lean launches
const CONTEXT_DEFAULTS = {
  warn: 100_000, high: 150_000, notifyHigh: true,
  autoRecycle: false, recycleTokens: 150_000, recycleIdleHours: 2, // agents: off by default
  conductorRecycle: true, conductorTokens: 60_000, conductorIdleHours: 3, // the conductor: on
  autoCompactWindow: 0, // tokens, passed as CLAUDE_CODE_AUTO_COMPACT_WINDOW (the CLI accepts 100k–1M); 0 = the CLI's default
  leanDefault: false, // launch agents with --strict-mcp-config unless the agent says otherwise
};
const contextCfg = () => getCfg('context', CONTEXT_DEFAULTS);
// what new agents get when neither the request nor a parent agent says (Settings > Agent defaults); '' = the CLI's own default
// builtinSubagents false: agents delegate through swarm agents only (their CLI's own subagent tool is off, see launchSpec)
// permissionMode, model and effort here are Claude's (the original keys, so old settings read as before); perBackend holds
// the same three for each other CLI ({ opencode: { permissionMode, model, effort }, ... }): its modes, models and effort differ
const AGENT_DEFAULTS = { permissionMode: 'auto', model: '', effort: '', builtinSubagents: false, perBackend: {} };
const agentDefaults = () => getCfg('agent_defaults', AGENT_DEFAULTS);
const OTHER_CLI_DEFAULTS = { permissionMode: 'manual', model: '', effort: '' }; // Claude's `auto` doesn't exist elsewhere
const defaultsFor = (backend) => {
  const d = agentDefaults();
  if (!backend || backend === DEFAULT_BACKEND) return { permissionMode: d.permissionMode, model: d.model, effort: d.effort };
  return { ...OTHER_CLI_DEFAULTS, ...(d.perBackend?.[backend] || {}) };
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']; // claude --effort
// an alias (opus, sonnet, haiku, fable, ...) or a full model id such as claude-sonnet-5-5 or claude-opus-5-5[1m]
const validModel = (m) => typeof m === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@\/\[\]-]{0,99}$/.test(m);
// a request's model/effort: undefined = not given, null = cleared, else the checked value; { error } when invalid
function modelEffortOf(body) {
  const out = {};
  for (const k of ['model', 'effort']) {
    const v = body[k];
    if (v === undefined) continue;
    if (v === null || v === '' || v === 'default') { out[k] = null; continue; }
    if (typeof v !== 'string') return { error: `${k} must be a string` };
    const t = v.trim();
    if (k === 'model' && !validModel(t)) return { error: 'model must be an alias (opus, sonnet, haiku, fable) or a full model id' };
    if (k === 'effort' && !EFFORTS.includes(t)) return { error: 'effort must be one of ' + EFFORTS.join(', ') };
    out[k] = t;
  }
  return out;
}

// ---- event history: timestamps, full-text index ---------------------------------

// Plain text of an event for the search index (prompts, replies, tool calls and results, errors).
function searchText(ev) {
  const parts = [];
  const add = (s) => { if (typeof s === 'string' && s) parts.push(s); };
  const body = (c) => { if (typeof c === 'string') add(c); else if (Array.isArray(c)) for (const p of c) if (p?.type === 'text') add(p.text); };
  switch (ev.type) {
    case 'user_prompt': add(ev.text); break;
    case 'peer_message': add(ev.fromName); add(ev.text); break;
    case 'assistant':
      for (const c of ev.message?.content || []) {
        if (c.type === 'text') add(c.text);
        else if (c.type === 'tool_use') { add(c.name); add(typeof c.input === 'string' ? c.input : JSON.stringify(c.input)); }
      }
      break;
    case 'user': for (const c of ev.message?.content || []) { if (c.type === 'tool_result') body(c.content); else if (c.type === 'text') add(c.text); } break;
    case 'result': add(ev.result); break;
    case 'stderr': add(ev.text); break;
    case 'handoff': add(ev.text); break;
    case 'permission_request': add(ev.tool_name); add(String(ev.input?.command ?? ev.input?.file_path ?? ev.input?.url ?? '')); break;
  }
  return parts.join('\n').slice(0, 8000);
}

// the one way events are stored: row + search index entry. The time lives in the ts column; in memory and on the
// wire an event carries it as _ts (ms), which the UI shows under chat messages.
function recordEvent(agentId, ev, ts = Date.now()) {
  const { _ts, ...rest } = ev;
  const id = q.insEvent.run(agentId, JSON.stringify(rest), ts).lastInsertRowid;
  const text = searchText(ev);
  if (text) q.insFts.run(id, text, agentId);
  return id;
}

// ---- usage: tokens and cost per finished turn --------------------------------------
// A result event carries this turn's `usage` and `total_cost_usd`, which is cumulative for the claude process,
// so the cost of a turn is the difference to the previous result (a drop means a new process). If a result has
// no usage, the turn's assistant messages are summed instead and no cost is known.

const n0 = (x) => (Number.isFinite(x) ? x : 0);
const dayOf = (ts) => {
  if (!ts) return null;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

class UsageTracker {
  constructor(cum = 0) { this.cum = cum; this.msgs = new Map(); }
  observe(e) { if (e.type === 'assistant' && e.message?.usage) this.msgs.set(e.message.id || 'm' + this.msgs.size, e.message.usage); }
  newProcess() { this.cum = 0; }
  result(ev) {
    let u = ev.usage, source = 'result';
    if (!u || typeof u !== 'object') {
      if (!this.msgs.size) return null;
      u = {};
      for (const m of this.msgs.values()) for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) u[k] = n0(u[k]) + n0(m[k]);
      source = 'messages';
    }
    this.msgs.clear();
    let cost = null, cum = null;
    if (typeof ev.total_cost_usd === 'number') { cum = ev.total_cost_usd; cost = cum >= this.cum ? cum - this.cum : cum; this.cum = cum; }
    return { input: n0(u.input_tokens), output: n0(u.output_tokens), cache_read: n0(u.cache_read_input_tokens), cache_create: n0(u.cache_creation_input_tokens), cost, cum_cost: cum, source };
  }
}

const emptyUsage = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0, noCost: 0 });

// one-time backfills for databases that predate the search index / usage table
(function backfill() {
  if (!q.getSetting.get('fts_v1')) {
    db.transaction(() => {
      for (const r of db.prepare('SELECT id, agent_id, json FROM events ORDER BY id').all()) {
        let ev; try { ev = JSON.parse(r.json); } catch { continue; }
        const text = searchText(ev);
        if (text) q.insFts.run(r.id, text, r.agent_id);
      }
      q.putSetting.run('fts_v1', String(Date.now()));
    })();
  }
  if (!q.getSetting.get('usage_v1')) {
    const acct = new Map(q.allAgents.all().map((a) => [a.id, a.account]));
    const trackers = new Map();
    db.transaction(() => {
      for (const r of db.prepare('SELECT id, agent_id, json, ts FROM events ORDER BY id').all()) {
        if (!r.json.startsWith('{"type":"assistant"') && !r.json.includes('"type":"result"')) continue;
        let ev; try { ev = JSON.parse(r.json); } catch { continue; }
        if (ev.type !== 'assistant' && ev.type !== 'result') continue;
        const t = trackers.get(r.agent_id) || trackers.set(r.agent_id, new UsageTracker()).get(r.agent_id);
        t.observe(ev);
        if (ev.type !== 'result') continue;
        const row = t.result(ev);
        if (row) q.insUsage.run({ ...row, event_id: r.id, agent_id: r.agent_id, account: acct.get(r.agent_id) ?? null, ts: r.ts ?? null, day: dayOf(r.ts) });
      }
      q.putSetting.run('usage_v1', String(Date.now()));
    })();
  }
})();
const usageByAgent = new Map(q.agentUsage.all().map((r) => [r.agent_id, { turns: r.turns, input: r.input, output: r.output, cacheRead: r.cache_read, cacheCreate: r.cache_create, cost: r.cost || 0, noCost: r.no_cost }]));

// ---- accounts ------------------------------------------------------------
// Discovered from your zsh aliases of the form `[VAR="val" ...] <cli>`, e.g.
// claude-work='CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude' or opencode-x='XDG_DATA_HOME="$HOME/.oc-x" opencode':
// the alias name starts with the backend's id or binary and the command is that binary. Plain `claude` is always
// offered, and every other backend whose CLI is installed by its own name. Each account belongs to one backend.
// HALAY_BACKENDS=claude,opencode limits which backends are offered (default: all).
const ENABLED_BACKENDS = (env('BACKENDS') || '').split(',').map((x) => x.trim()).filter(Boolean);
const backendEnabled = (id) => !!BACKENDS[id] && (id === DEFAULT_BACKEND || !ENABLED_BACKENDS.length || ENABLED_BACKENDS.includes(id));

const backendStatus = {}; // id -> { ok, reason }: can this server run it (see backends/index.js usable)
function discoverAccounts() {
  const accounts = { claude: { name: 'claude', backend: 'claude', env: {} } };
  backendStatus.claude = { ok: true };
  for (const b of Object.values(BACKENDS)) if (b.id !== DEFAULT_BACKEND && backendEnabled(b.id)) backendStatus[b.id] = usable(b);
  for (const b of Object.values(BACKENDS)) if (b.id !== DEFAULT_BACKEND && backendStatus[b.id]?.ok) accounts[b.id] = { name: b.id, backend: b.id, env: {} };
  const byBin = new Map(Object.values(BACKENDS).filter((b) => backendStatus[b.id]?.ok).map((b) => [b.bin, b]));
  let out = '';
  try {
    out = execFileSync('zsh', ['-ic', 'alias'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
  } catch {}
  for (const line of out.split('\n')) {
    const m = line.match(/^([\w-]+)=(.*)$/);
    if (!m) continue;
    let val = m[2];
    if (/^'.*'$/.test(val)) val = val.slice(1, -1);
    const tokens = val.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const b = byBin.get(tokens.pop());
    if (!b || !(m[1].startsWith(b.id) || m[1].startsWith(b.bin))) continue;
    const env = {};
    let ok = true;
    for (const t of tokens) {
      const e = t.match(/^(\w+)=(.*)$/);
      if (!e) { ok = false; break; }
      env[e[1]] = e[2].replace(/^"(.*)"$/, '$1').replace(/\$HOME|~/g, os.homedir());
    }
    if (ok) accounts[m[1]] = { name: m[1], backend: b.id, env, alias: true };
  }
  return accounts;
}
const accounts = discoverAccounts();
// Accounts added in the swarm (Settings → Accounts → Add), no shell alias needed: settings 'accounts' holds
// [{ name, backend, env, dir }]. Each gets a folder of its own for the CLI's login and data (backend.accountEnv), under
// ACCOUNTS_ROOT unless another one is picked. Alias accounts keep working, and one can be saved here so its alias can go.
const ACCOUNTS_ROOT = env('ACCOUNTS_DIR') || path.join(os.homedir(), '.halay-accounts');
const savedAccounts = () => { try { const a = JSON.parse(q.getSetting.get('accounts')?.value || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const putSavedAccounts = (list) => q.putSetting.run('accounts', JSON.stringify(list));
for (const a of savedAccounts()) if (backendStatus[a.backend]?.ok) accounts[a.name] = { name: a.name, backend: a.backend, env: a.env || {}, saved: true, dir: a.dir || null };
const ACCOUNT_NAME = /^[A-Za-z][\w-]{0,39}$/;
// POST /api/accounts { backend, name, dir?, shareHistory? }
function addAccount(body) {
  const b = BACKENDS[body.backend], name = String(body.name || '').trim();
  if (!b || !backendStatus[b.id]?.ok) return { code: 400, error: 'unknown or unavailable CLI' };
  if (!b.accountEnv) return { code: 400, error: b.noAccounts || `${b.label} accounts can't be added here` };
  if (!ACCOUNT_NAME.test(name)) return { code: 400, error: 'name: a letter, then letters, digits, - or _ (up to 40)' };
  if (accounts[name]) return { code: 409, error: `there is already an account ${name}` };
  let dir = typeof body.dir === 'string' && body.dir.trim() ? body.dir.trim().replace(/^~(?=$|\/)/, os.homedir()) : path.join(ACCOUNTS_ROOT, name);
  if (!path.isAbsolute(dir)) return { code: 400, error: 'folder: an absolute path (or ~/...)' };
  dir = path.resolve(dir);
  if (Object.values(accounts).some((a) => Object.values(b.accountEnv(dir)).some((v) => Object.values(a.env).includes(v)))) return { code: 409, error: 'another account already uses that folder' };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Claude: share session history and memory with the main account (the reference setup), unless asked not to
    if (b.id === DEFAULT_BACKEND && body.shareHistory !== false && !fs.existsSync(path.join(dir, 'projects'))) {
      const main = path.join(configDirOf(accounts.claude), 'projects');
      fs.mkdirSync(main, { recursive: true });
      fs.symlinkSync(main, path.join(dir, 'projects'));
    }
  } catch (e) { return { code: 500, error: `could not set up ${dir}: ${e.message}` }; }
  const acct = { name, backend: b.id, env: b.accountEnv(dir), saved: true, dir };
  putSavedAccounts([...savedAccounts().filter((a) => a.name !== name), { name, backend: b.id, env: acct.env, dir }]);
  accounts[name] = acct;
  return { account: acct };
}
// an alias account kept by the swarm too, so the alias can be removed
function saveAliasAccount(name) {
  const a = accounts[name];
  if (!a) return { code: 404, error: 'no such account' };
  if (a.saved) return { account: a };
  if (!a.alias) return { code: 400, error: `${name} is a CLI's own account: nothing to save` };
  putSavedAccounts([...savedAccounts().filter((x) => x.name !== name), { name, backend: a.backend, env: a.env, dir: null }]);
  a.saved = true;
  return { account: a };
}
// forgets an account added (or saved) here; its folder stays, and an alias of that name takes over at the next start
function removeAccount(name) {
  const a = accounts[name];
  if (!a) return { code: 404, error: 'no such account' };
  if (!a.saved) return { code: 400, error: a.alias ? `${name} comes from a shell alias: remove the alias from your shell config` : `${name} is a CLI's own account` };
  const users = [...agents.values()].filter((x) => x.account === name);
  if (users.length) return { code: 409, error: `agents use it: ${users.map((x) => x.name).slice(0, 5).join(', ')}` };
  putSavedAccounts(savedAccounts().filter((x) => x.name !== name));
  if (chosenDefaults()[a.backend] === name) { const d = { ...chosenDefaults() }; delete d[a.backend]; putCfg('default_accounts', d); }
  if (a.alias) a.saved = false; else delete accounts[name];
  delete authCache['acct:' + name];
  return { ok: true, dir: a.dir };
}
const claudeAccounts = () => Object.values(accounts).filter((a) => a.backend === DEFAULT_BACKEND); // limits, logins, History: Claude's
const backendOfAccount = (name) => accounts[name]?.backend || null;
// a backend's bare default account: its own (`opencode`), else its first alias
const bareAccountFor = (backend) => (accounts[backend]?.backend === backend ? backend : Object.values(accounts).find((a) => a.backend === backend)?.name) || null;
// Settings → Accounts → Set as default: settings 'default_accounts' = { <backend id>: account name }. A saved name that
// is gone (removed, its CLI not installed now) or belongs to another backend is ignored: the bare default applies.
const chosenDefaults = () => getCfg('default_accounts', {});
const chosenDefaultFor = (backend) => { const c = chosenDefaults()[backend]; return typeof c === 'string' && accounts[c]?.backend === backend ? c : null; };
// the account an agent on `backend` gets when nothing else decides (no account named, no parent of that backend)
const defaultAccountFor = (backend = DEFAULT_BACKEND) => chosenDefaultFor(backend) || bareAccountFor(backend);
// an agent's account, or (when it is gone) its backend's default account, else Claude's
const accountOr = (name, backend = DEFAULT_BACKEND) => accounts[name] || accounts[defaultAccountFor(backend)] || accounts[defaultAccountFor(DEFAULT_BACKEND)] || accounts.claude;
// PUT /api/accounts/default { backend, account }: account null/'' clears the choice (back to the bare default)
function setDefaultAccount(body) {
  const backend = body?.backend, account = body?.account;
  if (typeof backend !== 'string' || !BACKENDS[backend] || !backendEnabled(backend)) return { code: 400, error: `unknown backend ${backend} (backends: ${Object.keys(BACKENDS).filter(backendEnabled).join(', ')})` };
  const next = { ...chosenDefaults() };
  if (account === null || account === undefined || account === '') delete next[backend];
  else {
    if (typeof account !== 'string' || !accounts[account]) return { code: 400, error: `unknown account ${account}` };
    if (accounts[account].backend !== backend) return { code: 400, error: `account ${account} is a ${BACKENDS[accounts[account].backend].label} account, not ${BACKENDS[backend].label}` };
    next[backend] = account;
  }
  putCfg('default_accounts', next);
  return { defaults: defaultAccounts() };
}
// { <backend id>: { account, chosen } } for each backend that has an account here
const defaultAccounts = () => Object.fromEntries(Object.keys(BACKENDS).filter((id) => defaultAccountFor(id)).map((id) => [id, { account: defaultAccountFor(id), chosen: !!chosenDefaultFor(id) }]));
// The environment for a claude started on an account. Variables that belong to the Claude Code session the server
// may have been started from (e.g. a restart run inside an agent) are dropped: an inherited CLAUDE_CONFIG_DIR would put
// every account without its own (the default `claude` and plain aliases) on that session's login.
const INHERITED_CLAUDE_VARS = /^(CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SSE_PORT|SESSION_ATTENDED|EXECPATH|MESSAGING_SOCKET|MESSAGING_TOKEN|AUTO_COMPACT_WINDOW))$/;
// HALAY_TOKEN (set in the environment or .env) is the server's own credential: an agent's shell must not see it (the
// swarm MCP server gets it explicitly, in its own config)
const SERVER_ONLY_VARS = /^(HALAY_TOKEN|HALAY_RESET_PASSKEYS)$/;
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED_CLAUDE_VARS.test(k) && !SERVER_ONLY_VARS.test(k)));
if (process.env.CLAUDE_CONFIG_DIR) console.warn(`ignoring CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR} from the server's environment; accounts set their own`);
const accountEnv = (acct) => ({ ...baseEnv, ...acct.env });

// Plan limits per account, as Claude Code's /usage shows them. `claude -p /usage` answers locally from the
// account's login (no model turn, no cost). Cached for a few minutes; accounts sharing one config dir run once.
const LIMITS_TTL = Number(env('LIMITS_TTL_MS')) || 5 * 60e3; // (the env var is for tests)
const limitsCache = {}; // config dir -> { at, limits, note, error, pending }
function readLimits(acct) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-usage-'));
    const child = spawn('claude', ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'], {
      cwd: tmp, env: accountEnv(acct), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 45e3);
    const done = (r) => { clearTimeout(timer); fs.rmSync(tmp, { recursive: true, force: true }); resolve({ at: Date.now(), ...r }); };
    child.on('error', (e) => done({ error: e.message }));
    child.on('close', () => {
      let text;
      try { const j = JSON.parse(out); if (j.is_error) return done({ error: String(j.result || 'claude reported an error').slice(0, 300) }); text = String(j.result || ''); }
      catch { return done({ error: (err || out || 'no answer from claude').trim().split('\n').pop().slice(0, 300) }); }
      // "Current session: 9% used · resets Oct 24 at 2:09am (Europe/Istanbul)"
      const limits = [];
      for (const m of text.matchAll(/^Current ([^:\n]+):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets ([^\n]+))?$/gm))
        limits.push({ label: m[1].trim(), pct: Number(m[2]), resets: (m[3] || '').trim() });
      done({ limits, note: limits.length ? '' : text.split('\n').find((l) => l.trim())?.trim().slice(0, 200) || '' });
    });
  });
}
// Stale-while-revalidate: a reading older than LIMITS_TTL is served as it is and refreshed in the background (`claude -p /usage`
// can take many seconds), so the sidebar never waits on it; only a first reading (nothing cached yet) or ?refresh=1 waits.
function refreshLimits(dir, accts) {
  const old = limitsCache[dir];
  const p = readLimits(accts[0]).then((r) => (limitsCache[dir] = r));
  limitsCache[dir] = { ...(old || { at: 0 }), pending: p };
  return p;
}
async function accountLimits(force) {
  const byDir = {};
  for (const a of claudeAccounts()) (byDir[configDirOf(a)] ||= []).push(a);
  const out = {};
  await Promise.all(Object.entries(byDir).map(async ([dir, accts]) => {
    let c = limitsCache[dir];
    const stale = !c || Date.now() - c.at > LIMITS_TTL;
    if (force) c = await (c?.pending || refreshLimits(dir, accts));
    else if (!c?.at) c = await (c?.pending || refreshLimits(dir, accts)); // nothing to show yet: wait for the first reading
    else if (stale && !c.pending) refreshLimits(dir, accts).catch(() => {}); // serve the old reading, refresh behind it
    for (const a of accts) out[a.name] = { at: c.at, limits: c.limits || [], note: c.note || '', error: c.error || '' };
  }));
  return out;
}

// Login state per account, from `claude auth status --json` (local, no model turn, no cost). It never prints a token.
// Cached per config dir, refreshed at startup and every 30 minutes, and flipped to logged out when an agent's run fails on auth.
const AUTH_EVERY = 30 * 60e3;
function configDirOf(acct) { return acct?.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); } // a declaration: used above too
// Only the two expiry timestamps are taken from the stored OAuth login (<dir>/.credentials.json, else the macOS Keychain
// item "Claude Code-credentials[-<first 8 hex of sha256(config dir)>]"); the tokens themselves are dropped right away.
function oauthExpiry(acct) {
  const dir = configDirOf(acct);
  const pick = (txt) => { try { const o = JSON.parse(txt).claudeAiOauth; return o ? { accessExpiresAt: o.expiresAt || null, refreshExpiresAt: o.refreshTokenExpiresAt || null } : null; } catch { return null; } };
  try { const r = pick(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')); if (r) return Promise.resolve(r); } catch {}
  if (process.platform !== 'darwin') return Promise.resolve(null);
  const svc = 'Claude Code-credentials' + (acct.env.CLAUDE_CONFIG_DIR ? '-' + crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8) : '');
  return new Promise((resolve) => execFile('security', ['find-generic-password', '-s', svc, '-w'], { timeout: 5e3 }, (err, out) => resolve(err ? null : pick(out))));
}
const authCache = {}; // config dir -> { at, loggedIn, method, email, org, plan, error, pending }
function readAuth(acct) {
  return new Promise((resolve) => {
    const child = spawn('claude', ['auth', 'status', '--json'], { cwd: os.tmpdir(), env: accountEnv(acct), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20e3);
    const done = (r) => { clearTimeout(timer); resolve({ at: Date.now(), ...r }); };
    child.on('error', (e) => done({ error: e.message }));
    child.on('close', () => { // exits 1 when logged out but still prints the JSON
      try {
        const j = JSON.parse(out);
        oauthExpiry(acct).then((x) => done({ ...x, loggedIn: !!j.loggedIn, method: j.loggedIn ? j.authMethod || '' : '', email: j.email || '', org: j.orgName || '', plan: j.subscriptionType || '' }));
      } catch { done({ error: (err || out || 'no answer from claude').trim().split('\n').pop().slice(0, 200) }); }
    });
  });
}
async function accountAuth(force) {
  const byDir = {};
  for (const a of claudeAccounts()) (byDir[configDirOf(a)] ||= []).push(a);
  const out = {};
  await Promise.all(Object.entries(byDir).map(async ([dir, accts]) => {
    let c = authCache[dir];
    if (!c || (force && !c.pending) || Date.now() - c.at > AUTH_EVERY) {
      const p = c?.pending || readAuth(accts[0]);
      authCache[dir] = { ...(c || { at: 0 }), pending: p };
      c = authCache[dir] = await p;
    } else if (c.pending) c = await c.pending;
    for (const a of accts) out[a.name] = { loggedIn: c.loggedIn ?? null, method: c.method || '', email: c.email || '', org: c.org || '', plan: c.plan || '', accessExpiresAt: c.accessExpiresAt || null, refreshExpiresAt: c.refreshExpiresAt || null, checkedAt: c.at, error: c.error || '',
      fix: `${a.env.CLAUDE_CONFIG_DIR ? `CLAUDE_CONFIG_DIR=${shellWord(a.env.CLAUDE_CONFIG_DIR)} ` : ''}claude   # then /login` };
  }));
  await otherAccountAuth(force, out);
  return out;
}
// how an account shows in the UI: where it comes from (the CLI's own, a shell alias, or added in the swarm) and its folder
const accountSummary = (a) => ({ name: a.name, backend: a.backend, default: defaultAccountFor(a.backend) === a.name, source: a.saved ? 'swarm' : a.alias ? 'alias' : 'cli', dir: a.dir || null, env: Object.keys(a.env) });

// other CLIs: their backend's auth (a status command, or a check of where the CLI keeps its login), cached per account
// a value as one shell word for the login commands typed into a terminal: "…" as before when nothing in it is special
// inside double quotes, else '…' (a folder named $(…) or with a backtick must not run anything)
const shellWord = (v) => { v = String(v); return /^[^"$`\\!\x00-\x1f\x7f]*$/.test(v) ? JSON.stringify(v) : `'${v.replace(/'/g, `'\\''`)}'`; };
const shellEnvPrefix = (env) => Object.entries(env || {}).map(([k, v]) => `${k}=${shellWord(v)} `).join('');
function readBackendAuth(acct) {
  const auth = BACKENDS[acct.backend]?.auth;
  if (!auth) return Promise.resolve({ at: Date.now(), error: 'this CLI has no login check' });
  if (auth.check) { try { return Promise.resolve({ at: Date.now(), ...auth.check(accountEnv(acct)) }); } catch (e) { return Promise.resolve({ at: Date.now(), error: e.message }); } }
  return new Promise((resolve) => {
    const child = spawn(BACKENDS[acct.backend].bin, auth.args, { cwd: os.tmpdir(), env: { ...accountEnv(acct), NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20e3);
    const done = (r) => { clearTimeout(timer); resolve({ at: Date.now(), ...r }); };
    child.on('error', (e) => done({ error: e.message }));
    child.on('close', () => {
      try { done(auth.parse(out.replace(/\x1b\[[0-9;]*m/g, ''), err.replace(/\x1b\[[0-9;]*[mK]/g, ''))); } // (stderr for a CLI that reports a missing login there)
      catch { done({ error: (err || out || 'no answer').replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').pop().slice(0, 200) }); }
    });
  });
}
async function otherAccountAuth(force, out) {
  await Promise.all(Object.values(accounts).filter((a) => a.backend !== DEFAULT_BACKEND).map(async (a) => {
    const key = 'acct:' + a.name;
    let c = authCache[key];
    if (!c || (force && !c.pending) || Date.now() - c.at > AUTH_EVERY) {
      const p = c?.pending || readBackendAuth(a);
      authCache[key] = { ...(c || { at: 0 }), pending: p };
      c = authCache[key] = await p;
    } else if (c.pending) c = await c.pending;
    const fix = BACKENDS[a.backend]?.auth?.fix;
    out[a.name] = { loggedIn: c.loggedIn ?? null, method: c.method || '', email: c.email || '', org: '', plan: '', checkedAt: c.at, error: c.error || '', fix: fix ? shellEnvPrefix(a.env) + fix : '' };
  }));
}

// an agent's run failed on authentication: the account is logged out now; re-check shortly in case that was a one-off
function markLoggedOut(acct) {
  const dir = configDirOf(acct);
  authCache[dir] = { ...(authCache[dir] || {}), at: Date.now(), loggedIn: false, method: '', error: '' };
  setTimeout(() => accountAuth(true).catch(() => {}), 60e3).unref();
}
const AUTH_FAIL = /not logged in|please run \/login|authentication_error|authentication_failed|invalid (api key|x-api-key|bearer)|oauth token (has )?(expired|revoked)|invalid authentication|failed to authenticate|api error:? 401/i;
accountAuth(true).catch(() => {});
setInterval(() => accountAuth(true).catch(() => {}), AUTH_EVERY).unref();

// Claude keeps transcripts at <config dir>/projects/<cwd with non-alphanumerics as '-'>/<session>.jsonl
function listSessions(account, cwd) {
  if (backendOfAccount(account) !== DEFAULT_BACKEND) return []; // History is Claude's transcripts
  const configDir = configDirOf(accounts[account]);
  const dir = path.join(configDir, 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const used = new Set([...agents.values()].map((a) => a.sessionId));
  const stats = [];
  for (const f of files) { // one stat each; a file removed meanwhile is just left out
    try { stats.push({ f, file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }); } catch {}
  }
  const out = [];
  for (const { f, file, mtime } of stats.sort((a, b) => b.mtime - a.mtime).slice(0, 50)) { // titles only for the 50 shown
    const id = f.slice(0, -'.jsonl'.length);
    try { out.push({ id, mtime, title: sessionInfo(file, mtime).title, inUse: used.has(id) }); } catch {}
  }
  return out;
}

const infoCache = new Map(); // file -> { mtime, info }

function sessionInfo(file, mtime) {
  const hit = infoCache.get(file);
  if (hit?.mtime === mtime) return hit.info;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(128 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const info = { title: null, cwd: null };
  for (const line of buf.toString('utf8', 0, n).split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    info.cwd ??= e.cwd ?? null;
    if (!info.title && e.type === 'user' && !e.isSidechain) {
      const c = e.message?.content;
      const text = typeof c === 'string' ? c : c?.find?.((p) => p.type === 'text')?.text;
      if (text && !text.startsWith('<')) info.title = text.replace(/\s+/g, ' ').slice(0, 120);
    }
    if (info.title && info.cwd) break;
  }
  info.title ??= '(no prompt)';
  infoCache.set(file, { mtime, info });
  return info;
}

// Every session in any folder. Accounts whose projects dir is the same (e.g. symlinked) are scanned once;
// which account created a session isn't recorded, so the caller picks the account to resume with.
function sessionRoots() {
  const roots = new Set();
  for (const acct of claudeAccounts()) {
    const dir = configDirOf(acct);
    try { roots.add(fs.realpathSync(path.join(dir, 'projects'))); } catch {}
  }
  return roots;
}

// A subagent's transcript: Claude writes it to <config dir>/projects/<cwd>/<session>/subagents/agent-<task id>.jsonl.
// Returned as compact entries (prompt, assistant text, tool calls, trimmed results) from index `after` on, at most 400.
function subagentTranscript(agent, taskId, after) {
  const acct = accountOr(agent.account, agent.backend);
  const proj = path.join(configDirOf(acct), 'projects', path.resolve(agent.cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  const name = `agent-${taskId}.jsonl`;
  let file = agent.sessionId && path.join(proj, agent.sessionId, 'subagents', name);
  if (!file || !fs.existsSync(file)) { // an earlier session of this agent (after a new context)
    file = null;
    try { for (const d of fs.readdirSync(proj)) { const f = path.join(proj, d, 'subagents', name); if (fs.existsSync(f)) { file = f; break; } } } catch {}
  }
  if (!file) return { entries: [], next: after, found: false };
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const trim = (v) => typeof v === 'string' ? cut(v, 600) : Array.isArray(v) ? v.slice(0, 50).map(trim) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)])) : v;
  // the UI polls this while the subagent runs: keep what was parsed and only read what was appended since
  let c = subCache.get(file);
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  if (!c || size < c.offset) c = { offset: 0, entries: [] }; // new, or rewritten shorter
  subCache.delete(file); subCache.set(file, c); // most recently used last
  for (const k of subCache.keys()) { if (subCache.size <= 20) break; subCache.delete(k); }
  const entries = c.entries;
  let text = '';
  if (size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - c.offset);
      fs.readSync(fd, buf, 0, buf.length, c.offset);
      const end = buf.lastIndexOf(10) + 1; // complete lines only; the rest is read next time
      text = buf.toString('utf8', 0, end);
      c.offset += end;
    } finally { fs.closeSync(fd); }
  }
  for (const line of text.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isMeta) continue;
    const ts = e.timestamp, c = e.message?.content;
    if (typeof c === 'string') { if (e.type === 'user') entries.push({ ts, kind: 'user', text: cut(c, 4000) }); continue; }
    for (const p of Array.isArray(c) ? c : []) {
      if (p.type === 'text' && p.text?.trim()) entries.push({ ts, kind: e.type === 'user' ? 'user' : 'text', text: cut(p.text, 4000) });
      else if (p.type === 'tool_use') entries.push({ ts, kind: 'tool', name: p.name, input: trim(p.input) });
      else if (p.type === 'tool_result') entries.push({ ts, kind: 'result', text: cut(typeof p.content === 'string' ? p.content : (p.content || []).map((x) => x.text ?? '').join('\n'), 1500) });
    }
  }
  entries.forEach((x, i) => (x.i = i));
  const out = entries.slice(after, after + 400);
  return { entries: out, next: after + out.length, found: true };
}

const subCache = new Map(); // subagent transcript file -> { offset, entries } (the 20 most recently read)

// the last `max` bytes of a file as text, starting at a line boundary (all of it when it is smaller)
function readTail(file, max) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, from = Math.max(0, size - max), buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const start = from ? buf.indexOf(10) + 1 : 0; // drop the partial first line
    return buf.toString('utf8', start);
  } finally { fs.closeSync(fd); }
}

// An assistant event that sends a message to another session (SendMessage) carries the names the UI shows for its
// recipients: { address: from-name } learned from the peer messages before it (a peer is addressed as uds:/…sock).
function withPeerNames(ev, events) {
  const tos = (ev.message?.content || []).filter((c) => c.type === 'tool_use' && c.name === 'SendMessage' && typeof c.input?.to === 'string').map((c) => c.input.to);
  if (!tos.length) return ev;
  const names = peerNames(events), known = {};
  for (const t of tos) if (names[t]) known[t] = names[t];
  return Object.keys(known).length ? { ...ev, _peerNames: known } : ev;
}

// Turn an earlier transcript into the events the UI renders, so a resumed session shows its history.
function importTranscript(sessionId) {
  if (!/^[\w-]+$/.test(sessionId)) return [];
  for (const root of sessionRoots()) {
    for (const proj of fs.readdirSync(root)) {
      const file = path.join(root, proj, sessionId + '.jsonl');
      if (!fs.existsSync(file)) continue;
      const events = [], subs = new Set(), seen = new Set(); // subs: Task/Agent tool_use ids, so their results come back as subagent cards
      for (const line of readTail(file, 64 << 20).split('\n')) { // only the last 1000 events are kept: the tail is enough
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const peer = peerFromEntry(e); // a message from another Claude session (peer-messages.js): meta, but shown
        if (peer) { if (!peer.msgId || !seen.has(peer.msgId)) { seen.add(peer.msgId); events.push({ ...peerEvent(peer), _ts: peer.ts }); } continue; }
        if (e.isSidechain || e.isMeta) continue;
        const _ts = Date.parse(e.timestamp) || undefined;
        if (e.type === 'assistant') {
          for (const p of e.message?.content || []) if (p.type === 'tool_use' && (p.name === 'Task' || p.name === 'Agent')) subs.add(p.id);
          events.push(withPeerNames({ type: 'assistant', message: e.message, _ts }, events));
        }
        else if (e.type === 'user') {
          const c = e.message?.content;
          if (typeof c === 'string' || c?.some?.((p) => p.type === 'text')) {
            const text = typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
            if (!text.startsWith('<')) events.push({ type: 'user_prompt', text, _ts });
          } else if (c?.some?.((p) => p.type === 'tool_result' && (p.is_error || subs.has(p.tool_use_id)))) events.push({ type: 'user', message: e.message, _ts });
        }
      }
      return events.slice(-1000);
    }
  }
  return [];
}

// ---- history index: per-transcript stats, scanned incrementally and persisted ------------------
// Transcripts are append-only and can reach hundreds of MB, so each file is scanned once, in chunks, by string
// matching (no JSON.parse of whole lines); the byte offset reached is stored with the counters, and a grown file
// is only read from there. Scans have a time budget so one request never blocks the server for long.
db.exec('CREATE TABLE IF NOT EXISTS session_stats (file TEXT PRIMARY KEY, size INTEGER, mtime REAL, json TEXT NOT NULL)');
const sstat = {
  all: db.prepare('SELECT file, size, mtime, json FROM session_stats'),
  put: db.prepare('INSERT INTO session_stats (file,size,mtime,json) VALUES (?,?,?,?) ON CONFLICT(file) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, json=excluded.json'),
  del: db.prepare('DELETE FROM session_stats WHERE file=?'),
};
const statCache = new Map(); // file -> { size, mtime, st }
for (const r of sstat.all.all()) try { statCache.set(r.file, { size: r.size, mtime: r.mtime, st: JSON.parse(r.json) }); } catch {}

const newStats = () => ({ off: 0, turns: 0, msgs: 0, model: null, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, pid: null, pu: null });
const numIn = (s, k) => { const m = s.match(new RegExp('"' + k + '":(\\d+)')); return m ? +m[1] : 0; };

function scanChunk(st, text) {
  for (const line of text.split('\n')) {
    if (!line || line.includes('"isSidechain":true')) continue;
    if (line.includes('"type":"assistant"')) {
      const id = /"message":\{[^]*?"id":"([^"]+)"/.exec(line.slice(0, 2000))?.[1] || null;
      const um = line.lastIndexOf('"usage":{');
      let u = null;
      if (um >= 0) { const seg = line.slice(um, um + 600); u = [numIn(seg, 'input_tokens'), numIn(seg, 'output_tokens'), numIn(seg, 'cache_read_input_tokens'), numIn(seg, 'cache_creation_input_tokens')]; }
      const mm = /"model":"([^"]+)"/.exec(line.slice(0, 2000));
      if (mm && mm[1] !== '<synthetic>') st.model = mm[1];
      if (id !== st.pid) { // streamed messages repeat their id; the last repeat has the final usage
        if (st.pu) { st.input += st.pu[0]; st.output += st.pu[1]; st.cacheRead += st.pu[2]; st.cacheCreate += st.pu[3]; }
        st.pid = id; st.msgs++;
      }
      if (u) st.pu = u;
    } else if (line.includes('"type":"user"') && !line.includes('"tool_use_id"') && !line.includes('"isMeta":true') && !/"content":"<[a-z-]+>/.test(line.slice(0, 1500))) {
      st.turns++; st.msgs++;
    }
  }
}

// Bring one file's stats up to date; returns false if the budget ran out first (progress is kept).
function refreshStats(file, stat, deadline) {
  let c = statCache.get(file);
  if (c && c.size === stat.size && c.mtime === stat.mtimeMs && c.st.done) return true;
  let st = c?.st;
  if (!st || stat.size < st.off) st = newStats(); // new or truncated
  delete st.done;
  const CH = 4 * 1024 * 1024;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CH);
    while (st.off < stat.size) {
      const n = fs.readSync(fd, buf, 0, CH, st.off);
      if (n <= 0) break;
      let end = n;
      if (st.off + n < stat.size) { end = buf.lastIndexOf(10, n - 1) + 1; if (end <= 0) end = n; } // whole lines only
      scanChunk(st, buf.toString('utf8', 0, end));
      st.off += end;
      if (Date.now() > deadline && st.off < stat.size) break;
    }
  } finally { fs.closeSync(fd); }
  const done = st.off >= stat.size;
  if (done) {
    if (st.pu) { st.input += st.pu[0]; st.output += st.pu[1]; st.cacheRead += st.pu[2]; st.cacheCreate += st.pu[3]; }
    st.pu = null; st.pid = null; // flush the last message; a later append can only add whole new ones
  }
  const info = sessionInfo(file, stat.mtimeMs);
  st.title = info.title; st.cwd = info.cwd;
  if (done) st.done = true;
  statCache.set(file, { size: stat.size, mtime: stat.mtimeMs, st });
  sstat.put.run(file, stat.size, stat.mtimeMs, JSON.stringify(st));
  return done;
}

let warming = false;
function warmSessions() { // finish any partial scans in the background without hogging the event loop
  if (warming) return; warming = true;
  const step = () => {
    let left = false;
    try { left = listAllSessions(40, true).partial; } catch (e) { console.error('history warm failed:', e.message); }
    if (left) setTimeout(step, 30); else warming = false;
  };
  setTimeout(step, 100);
}

// Repo a worktree folder belongs to, read from its `.git` file ("gitdir: <repo>/.git/worktrees/<name>"); null if it isn't one or is gone.
const wtRepoCache = new Map();
function worktreeRepoOf(dir) {
  if (!wtRepoCache.has(dir) || wtRepoCache.get(dir) === null) {
    let repo = null;
    try { const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(dir, '.git'), 'utf8')); if (m) repo = path.resolve(dir, m[1]).split(path.sep + '.git' + path.sep + 'worktrees' + path.sep)[0]; } catch {}
    wtRepoCache.set(dir, repo);
  }
  return wtRepoCache.get(dir);
}

// worktree sessions belong to the repo they were branched from; sub-agents hang under the agent that started them
function placeSession(s, a, exists) {
  const repo = a?.wt?.repo || (s.cwd.startsWith(TMP_ROOT + path.sep) ? worktreeRepoOf(s.cwd) : null);
  if (repo && repo !== s.cwd) { s.resumeCwd = s.cwd; s.cwd = repo; s.repoExists = exists(repo); s.worktree = a?.wt?.branch || true; }
  if (a?.parentId) s.parentAgent = a.parentId;
  if (a) { s.agent = a.id; s.agentAccount = a.account; s.agentStatus = a.status; s.agentName = a.name; if (a.usage?.cost) s.cost = a.usage.cost; }
  return s;
}

// ---- History for the other CLIs: each account's sessions, listed by the CLI itself (ACP session/list through a
// short-lived process, backends/acp.js listSessions) and cached; a stale list is refreshed in the background
const acpHistory = new Map(); // account -> { at, list (undefined: not listed yet, null: the CLI can't list), pending }
const ACP_HISTORY_TTL = 30e3, ACP_HISTORY_NONE_TTL = 60 * 60e3; // a CLI that can't list is asked again hourly
function acpHistoryOf(acct) {
  const c = acpHistory.get(acct.name);
  if (c?.pending || (c && Date.now() - c.at < (c.list === null ? ACP_HISTORY_NONE_TTL : ACP_HISTORY_TTL))) return c;
  const pending = BACKENDS[acct.backend].listSessions({ env: accountEnv(acct), timeoutMs: 45000 })
    .catch((e) => { console.error(`history: listing ${acct.name}'s sessions failed: ${e.message}`); return c?.list || []; })
    .then((list) => { acpHistory.set(acct.name, { at: Date.now(), list }); });
  const next = { at: c?.at || 0, list: c?.list, pending };
  acpHistory.set(acct.name, next);
  return next;
}
function listAcpSessions() {
  const bySession = new Map([...agents.values()].filter((a) => a.sessionId && a.backend !== DEFAULT_BACKEND).map((a) => [a.sessionId, a]));
  const merged = new Map();
  let partial = false;
  for (const acct of Object.values(accounts)) {
    if (acct.backend === DEFAULT_BACKEND || !BACKENDS[acct.backend]?.listSessions) continue;
    const c = acpHistoryOf(acct);
    if (c.list === undefined) { partial = true; continue; }
    for (const x of c.list || []) { // accounts of one CLI sharing its data list the same sessions
      const m = merged.get(`${acct.backend}:${x.id}`);
      if (m) m.accounts.push(acct.name);
      else merged.set(`${acct.backend}:${x.id}`, { ...x, backend: acct.backend, accounts: [acct.name] });
    }
  }
  const dirs = new Map(), exists = (d) => { if (!dirs.has(d)) dirs.set(d, fs.existsSync(d)); return dirs.get(d); };
  const out = [];
  for (const x of merged.values()) {
    const a = bySession.get(x.id), oneOff = !!oneOffIdOf(x.cwd);
    if (!a && !oneOff && x.cwd.startsWith(TMP_ROOT + path.sep) && !exists(x.cwd)) continue; // a gone worktree no agent owns
    out.push(placeSession({ ...x, title: x.title || '(untitled)', exists: exists(x.cwd), oneOff, inUse: !!a }, a, exists));
  }
  return Object.assign(out, { partial });
}

function listAllSessions(budgetMs = 250, internal = false) {
  const roots = new Map(); // real projects dir -> accounts that use it
  for (const acct of claudeAccounts()) {
    const name = acct.name, dir = configDirOf(acct);
    try { const r = fs.realpathSync(path.join(dir, 'projects')); roots.set(r, [...(roots.get(r) || []), name]); } catch {}
  }
  const bySession = new Map([...agents.values()].filter((a) => a.sessionId).map((a) => [a.sessionId, a]));
  const files = [];
  for (const [root, accts] of roots) {
    let projects;
    try { projects = fs.readdirSync(root); } catch { continue; }
    for (const proj of projects) {
      let names;
      try { names = fs.readdirSync(path.join(root, proj)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of names) {
        const file = path.join(root, proj, f);
        try { files.push({ file, stat: fs.statSync(file), id: f.slice(0, -6), accts }); } catch {}
      }
    }
  }
  files.sort((x, y) => y.stat.mtimeMs - x.stat.mtimeMs);
  const live = new Set(files.map((f) => f.file));
  for (const k of statCache.keys()) if (!live.has(k)) { statCache.delete(k); sstat.del.run(k); }
  const deadline = Date.now() + budgetMs;
  const dirs = new Map(), exists = (d) => { if (!dirs.has(d)) dirs.set(d, fs.existsSync(d)); return dirs.get(d); }; // many sessions share a folder
  let partial = false;
  const out = [];
  for (const { file, stat, id, accts } of files.slice(0, 600)) {
    if (Date.now() > deadline && !(statCache.get(file)?.st.title)) { partial = true; continue; } // out of budget and never seen: skip for now
    let done = true;
    try { done = refreshStats(file, stat, deadline); } catch { continue; }
    if (!done) partial = true;
    const st = statCache.get(file)?.st;
    if (!st?.cwd) continue; // no cwd recorded: can't resume
    const a = bySession.get(id);
    const oneOff = !!oneOffIdOf(st.cwd); // a removed one-off agent keeps its conversation; resuming recreates the empty scratch folder
    if (!a && !oneOff && st.cwd.startsWith(TMP_ROOT + path.sep) && !exists(st.cwd)) continue; // an agent's worktree folder that is gone and that no agent owns: nothing to resume or attribute
    const s = { id, mtime: stat.mtimeMs, title: st.title, cwd: st.cwd, exists: exists(st.cwd), oneOff, accounts: accts, inUse: !!a,
      turns: st.turns, msgs: st.msgs, model: st.model, tokens: { input: st.input, output: st.output, cacheRead: st.cacheRead, cacheCreate: st.cacheCreate }, size: stat.size };
    placeSession(s, a, exists);
    if (!done) s.partial = true;
    out.push(s);
  }
  if (internal) return { partial };
  if (partial) warmSessions();
  return Object.assign(out, { partial });
}

/** @type {Map<string, Agent>} */
const agents = new Map();
const clients = new Set();


// Wire form of an event: long strings (tool output, file contents) are cut and base64 images dropped, and the
// event gets _cut: true. The UI fetches the full event on demand (GET /api/agents/:id/events/:index).
const CUT_AT = 4000, CUT_KEEP = 2000;
function slimEvent(ev) {
  let cut = false;
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (key === 'data' && v.length > 1000) { cut = true; return ''; } // image bytes
      if (v.length > CUT_AT) { cut = true; return v.slice(0, CUT_KEEP) + `\n… [${v.length - CUT_KEEP} more characters]`; }
      return v;
    }
    if (Array.isArray(v)) { let out = v; v.forEach((x, i) => { const y = walk(x); if (y !== x) { if (out === v) out = v.slice(); out[i] = y; } }); return out; }
    if (v && typeof v === 'object') { let out = v; for (const k in v) { const y = walk(v[k], k); if (y !== v[k]) { if (out === v) out = { ...v }; out[k] = y; } } return out; }
    return v;
  };
  const out = walk(ev);
  return cut ? { ...out, _cut: true } : ev;
}

const broadcast = (msg) => {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
};

// the agents' browser (browser.js): Chromium per profile, the driver lock, the UI's live view
const browser = createBrowser({ root: ROOT, runs: RUNS, port: PORT, token: TOKEN, getCfg, putCfg, broadcast, agentName: (id) => agents.get(id)?.name });

// Rule that "always allow" saves: Bash by its leading words (like the CLI's `git status:*`), other tools by name.
function permissionRule(toolName, input) {
  if (toolName === 'Bash' && typeof input?.command === 'string') {
    const [cmd, sub] = input.command.trim().split(/\s+/);
    const subcommands = /^(git|npm|pnpm|yarn|docker|kubectl|cargo|go|pip|brew|gh)$/.test(cmd) && /^[a-z][\w-]*$/.test(sub || '');
    const words = subcommands ? `${cmd} ${sub}` : cmd;
    return { rule: { toolName, ruleContent: `${words}:*` }, text: `Bash(${words}:*)` };
  }
  return { rule: { toolName }, text: toolName };
}

// does a Claude permission rule such as Edit(//abs/dir/memory/**) or Read(//abs/dir/**) cover this call? Only the
// path rules the swarm itself makes (bots' memory files) are understood; an Edit rule covers every editing tool.
function ruleMatches(rule, toolName, input) {
  const m = String(rule).match(/^(\w+)\((.*)\)$/);
  if (!m) return false;
  const tools = m[1] === 'Edit' ? ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] : [m[1]];
  const file = input?.file_path;
  if (!tools.includes(toolName) || typeof file !== 'string' || !m[2].startsWith('//')) return false;
  const glob = m[2].slice(1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp('^' + glob + '$').test(path.resolve(file));
}

// AskUserQuestion goes through the permission prompt like any tool (in every mode: it needs the user), but "allow" alone
// gives the agent "The user did not answer the questions." The answers travel back in the allowed call's updatedInput:
// { ...input, answers: { [question text]: answer } }, a multi-select answer being its labels joined by ", " (a label
// that itself holds ", " or a quote is JSON-quoted, as the CLI does).
const QUESTION_TOOL = 'AskUserQuestion';
const isQuestion = (toolName) => toolName === QUESTION_TOOL;
const questionsOf = (input) => (Array.isArray(input?.questions) ? input.questions.filter((x) => x && typeof x.question === 'string') : []);
const joinLabels = (ls) => ls.map((l) => (l.includes(', ') || l.includes('"') ? JSON.stringify(l) : l)).join(', ');
// answers from the UI or the API, either an array in question order or an object keyed by question text; each answer is
// a string or (multi-select) an array of strings. Returns { [question text]: string } with the unanswered left out, or
// { error }.
function questionAnswers(input, given) {
  const qs = questionsOf(input), out = {};
  if (!given || typeof given !== 'object') return { error: 'answers required: an array in question order, or an object keyed by question text' };
  const known = new Set(qs.map((x) => x.question));
  if (!Array.isArray(given)) for (const k of Object.keys(given)) if (!known.has(k)) return { error: `no question ${JSON.stringify(k.slice(0, 80))}` };
  qs.forEach((x, i) => {
    let a = Array.isArray(given) ? given[i] : given[x.question];
    if (Array.isArray(a)) a = joinLabels(a.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean));
    else if (typeof a === 'number' && Number.isFinite(a)) a = String(a);
    if (typeof a === 'string' && a.trim()) out[x.question] = a.trim().slice(0, 4000);
  });
  if (!Object.keys(out).length) return { error: 'answer at least one question' };
  return { answers: out };
}
// one line for a pending request: what the user is asked for
const pendingText = (toolName, input, rule) => isQuestion(toolName)
  ? `a question: ${questionsOf(input).map((x) => JSON.stringify(x.question)).join('; ') || '(no questions)'}`.slice(0, 300)
  : rule || toolName;

// Each agent gets its own scratch folder inside the swarm folder (gitignored) instead of the shared /tmp.
const TMP_ROOT = dataPath('tmp');
const tmpDirFor = (id) => path.join(TMP_ROOT, id);
// <tmp>/<id>/scratch -> id (a one-off agent's folder), else null
const oneOffIdOf = (cwd) => { const m = typeof cwd === 'string' && path.relative(TMP_ROOT, cwd).split(path.sep); return m && m.length === 2 && m[1] === 'scratch' && /^[\w-]+$/.test(m[0]) && m[0] !== '_staged' ? m[0] : null; };

// ---- file uploads: streamed to disk under an agent's tmp dir (or a staging dir before the agent exists) ----
const UPLOAD_MAX = Math.max(1, Number(env('UPLOAD_MAX_MB')) || 50) * 1024 * 1024;
const STAGE_ROOT = path.join(TMP_ROOT, '_staged');
const cleanStaged = () => { // staged files nobody claimed within a day
  let es; try { es = fs.readdirSync(STAGE_ROOT, { withFileTypes: true }); } catch { return; }
  for (const e of es) { const d = path.join(STAGE_ROOT, e.name); try { if (Date.now() - fs.statSync(d).mtimeMs > 864e5) fs.rmSync(d, { recursive: true, force: true }); } catch {} }
};
cleanStaged();
setInterval(cleanStaged, 36e5).unref(); // hourly, not just at startup
// staged uploads (not yet claimed by an agent) may take this much disk in total
const STAGE_MAX = Math.max(UPLOAD_MAX, (Number(env('STAGE_MAX_MB')) || 1024) * 1024 * 1024);
const stagedBytes = () => {
  let n = 0;
  let ds; try { ds = fs.readdirSync(STAGE_ROOT); } catch { return 0; }
  for (const d of ds) {
    let names; try { names = fs.readdirSync(path.join(STAGE_ROOT, d)); } catch { continue; }
    for (const f of names) { try { n += fs.statSync(path.join(STAGE_ROOT, d, f)).size; } catch {} }
  }
  return n;
};
const safeName = (n) => {
  let b = path.basename(String(n || '').replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/^\.+/, '').trim().slice(-120);
  return b || 'file';
};
const mb = (n) => Math.round(n / 1048576);
// free name in dir: "a.png", "a (1).png", ...
function freeName(dir, name) {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const n = i ? `${stem} (${i})${ext}` : name;
    if (!fs.existsSync(path.join(dir, n))) return n;
  }
}
// Streams the request body into dir. Resolves { name, path, size } or { code, error }.
function receiveUpload(req, dir, rawName) {
  return new Promise((resolve) => {
    const len = Number(req.headers['content-length']);
    if (len > UPLOAD_MAX) { req.resume(); return resolve({ code: 413, error: `file too large (${mb(len)} MB; limit ${mb(UPLOAD_MAX)} MB)` }); }
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { req.resume(); return resolve({ code: 500, error: 'could not create the upload folder: ' + e.message }); }
    const part = path.join(dir, `.part-${crypto.randomUUID().slice(0, 8)}`);
    const out = fs.createWriteStream(part);
    let size = 0, done = false;
    const finish = (r) => { if (done) return; done = true; if (r.error) { out.destroy(); fs.rmSync(part, { force: true }); } resolve(r); };
    req.on('data', (d) => {
      size += d.length;
      if (size > UPLOAD_MAX) { finish({ code: 413, error: `file too large (limit ${mb(UPLOAD_MAX)} MB)` }); req.resume(); }
      else if (!done && !out.write(d)) { req.pause(); out.once('drain', () => req.resume()); }
    });
    req.on('aborted', () => finish({ code: 400, error: 'upload interrupted' }));
    req.on('error', (e) => finish({ code: 400, error: 'upload failed: ' + e.message }));
    out.on('error', (e) => finish({ code: 500, error: 'could not write the file: ' + e.message }));
    req.on('end', () => {
      if (done) return;
      out.end(() => {
        if (done) return;
        try {
          const base = safeName(rawName);
          let name = freeName(dir, base);
          for (;;) { // link() fails if the name is taken, so two uploads at once never overwrite each other
            try { fs.linkSync(part, path.join(dir, name)); break; } catch (e) { if (e.code !== 'EEXIST') throw e; name = freeName(dir, base); }
          }
          fs.rmSync(part, { force: true });
          finish({ name, path: path.join(dir, name), size });
        } catch (e) { finish({ code: 500, error: 'could not save the file: ' + e.message }); }
      });
    });
  });
}
// moves staged uploads (ids from POST /api/uploads) into an agent's uploads dir
function claimStaged(agentId, ids) {
  const dest = path.join(tmpDirFor(agentId), 'uploads'), files = [];
  for (const sid of [].concat(ids || [])) {
    if (!/^[\w-]{8,40}$/.test(String(sid))) continue;
    const dir = path.join(STAGE_ROOT, String(sid));
    let names; try { names = fs.readdirSync(dir).filter((n) => !n.startsWith('.part-')); } catch { continue; }
    fs.mkdirSync(dest, { recursive: true });
    for (const n of names) {
      const to = freeName(dest, n);
      try { fs.renameSync(path.join(dir, n), path.join(dest, to)); files.push(path.join(dest, to)); } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return files;
}
const withAttachments = (text, files) => (files.length ? [text, 'Attached files: ' + files.join(', ')].filter(Boolean).join('\n\n') : text);
// what agents are told (their system prompt): prompts.js

// fresh context with handoff: what the agent is asked before its session is reset, and how the note is passed on
const HANDOFF_ASK =
  `[Swarm: fresh context] Your context is about to be cleared to keep it small, and this work will continue in a new session that sees only what you write now. ` +
  `Write a handoff note for your future self, about 300–500 words of plain markdown, with these sections: Goal; Current state; Decisions made (and why); Open threads; Key files and paths; Next steps. ` +
  `Be concrete: exact paths, branch names, commands, ids of agents or tasks, and anything the user asked for that is still pending. ` +
  `Do not use any tools and do not change anything; reply with only the note.`;
const handoffSeed = (note) =>
  `[Handoff from your previous context] Your earlier context was cleared to keep it small. This is the note you wrote for yourself just before that; ` +
  `treat it as your memory of the work so far, and re-read files rather than assuming what is in them.\n\n${note}\n\n[End of handoff]\n\n`;

const PEER_SCAN_TYPES = new Set(['command_lifecycle', 'assistant', 'user', 'result']); // stdout events that may follow a peer message
const MAX_WAKE_TURNS = 20; // agent notifications: automatic wake-ups of one agent in a row before they pause (ping-pong guard)
const NOTIFY_BLOCKED_MS = Math.max(1, Number(env('NOTIFY_BLOCKED_SECS')) || 120) * 1000; // a child blocked on the user this long: its parent is told once
const MAX_DEPTH = 3, MAX_CHILDREN = 8, MAX_LIVE = Math.max(1, Number(env('MAX_LIVE')) || 60); // limits on agents starting agents; MAX_LIVE = running agents at once
const SWARM_TOOLS = ['list_agents', 'start_agent', 'send_message', 'read_agent', 'wait_for_agent', 'interrupt_agent', 'remove_agent', 'refresh_agent_context', 'list_accounts', 'list_sessions', 'list_tasks', 'get_task', 'add_task', 'update_task', 'delete_task', 'assign_task',
  'list_schedules', 'add_schedule', 'update_schedule', 'delete_schedule', 'run_schedule_now',
  'create_bot', 'list_bots', 'update_bot', 'create_room', 'list_rooms', 'update_room', 'add_to_room', 'remove_from_room', 'read_room', 'post_to_room', 'mark_room_done'];

// The conductor's system prompt: user override from the UI, else prompts/conductor.md; plus facts only the server knows.
const defaultConductorPrompt = () => fs.readFileSync(path.join(ROOT, 'prompts', 'conductor.md'), 'utf8');
// Model names differ per CLI: the ones of the CLIs other than Claude that have accounts here.
const conductorPrompt = () => {
  const others = [...new Set(Object.values(accounts).map((a) => a.backend).filter((b) => b !== DEFAULT_BACKEND && BACKENDS[b]?.modelHint))];
  return (q.getSetting.get('conductor_prompt')?.value ?? defaultConductorPrompt()) +
    `\n\nAccounts available to agents: ${Object.values(accounts).map((a) => (a.backend === DEFAULT_BACKEND ? a.name : `${a.name} (${BACKENDS[a.backend].label})`)).join(', ')}.` +
    (others.length ? ` Models for agents on the other CLIs: ${others.map((b) => `${BACKENDS[b].label}: ${BACKENDS[b].modelHint}`).join('; ')}.` : '');
};
const CONDUCTOR_DIR = dataPath('conductor');
// the conductor runs in Claude's auto mode; a backend without it accepts edits by itself (it rarely edits) and asks for the rest
const conductorMode = (backend) => (BACKENDS[backend].capabilities.modes.includes('auto') ? 'auto' : 'acceptEdits');

/** @type {Map<string, {agent: Agent, resolve: Function}>} */
const pending = new Map();

// ---- approvals inbox: every open permission request, across agents ----------

// question requests (AskUserQuestion) carry kind 'question' and the questions themselves, so the inbox can answer them
const approvalList = () =>
  [...pending].map(([reqId, p]) => ({ reqId, agentId: p.agent.id, agentName: p.agent.name, kind: isQuestion(p.req.tool_name) ? 'question' : 'approval', ...p.req })).sort((a, b) => a.at - b.at);
const broadcastApprovals = () => broadcast({ type: 'approvals', approvals: approvalList() });
const previewInput = (input) => String(input?.command ?? input?.file_path ?? input?.url ?? input?.plan ?? JSON.stringify(input, null, 1) ?? '').slice(0, 600);

// ---- notifications ---------------------------------------------------------
// The web UI always hears about these over the websocket. Web Push goes to the browsers you enabled it on; other
// channels (ntfy, webhooks, …) are plugins the user enables (plugins.js). The ntfy fields below are only read to move
// the old built-in ntfy settings into the ntfy plugin once.

const NOTIFY_DEFAULTS = { enabled: false, server: 'https://ntfy.sh', topic: '', token: '', publicUrl: '', details: false, events: { done: true, error: true, blocked: true, usage: true, stuck: true, context: true, room: true } };
const notifySettings = () => {
  let saved = {};
  try { saved = JSON.parse(q.getSetting.get('notify')?.value || '{}'); } catch {}
  return { ...NOTIFY_DEFAULTS, ...saved, events: { ...NOTIFY_DEFAULTS.events, ...saved.events } };
};
const KIND_LABEL = { done: 'finished', error: 'hit an error', blocked: 'needs approval', usage: 'passed a usage threshold', stuck: 'looks stuck', context: 'has a large context', room: 'room update' };


// ---- Web Push (works with the page closed). VAPID keys are generated once and kept in the settings table.
// Browsers only allow it from a secure context, so it is used through the HTTPS front (tailscale serve).
// The HTTPS address comes from Settings or HALAY_PUBLIC_URL (.env); empty when neither is set.
const PUBLIC_URL = () => notifySettings().publicUrl || env('PUBLIC_URL') || '';
const vapid = (() => {
  let k;
  try { k = JSON.parse(q.getSetting.get('vapid')?.value || 'null'); } catch {}
  if (!k?.publicKey) { k = webpush.generateVAPIDKeys(); q.putSetting.run('vapid', JSON.stringify(k)); }
  return k;
})();
// web-push requires an https: or mailto: subject; without a public URL use a placeholder contact.
const vapidSubject = () => { const u = PUBLIC_URL(); return /^(https:\/\/|mailto:)/.test(u) ? u : 'mailto:swarm@example.com'; };
const vapidDetails = () => ({ subject: vapidSubject(), publicKey: vapid.publicKey, privateKey: vapid.privateKey });
if (!/^https:\/\//.test(PUBLIC_URL())) console.log('web push: no HTTPS public URL set (HALAY_PUBLIC_URL in .env or Settings); using a placeholder VAPID subject');

async function sendWebPush(payload) {
  const subs = q.allSubs.all();
  const body = JSON.stringify(payload);
  const results = await Promise.all(subs.map(async (r) => {
    try {
      await webpush.sendNotification(JSON.parse(r.json), body, { vapidDetails: vapidDetails(), TTL: 3600, urgency: payload.kind === 'done' ? 'normal' : 'high' });
      return true;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { q.delSub.run(r.endpoint); console.log(`web push: dropped dead subscription (${e.statusCode}) ${new URL(r.endpoint).host}`); } // subscription is gone
      else console.error('web push:', e.statusCode || e.message);
      return false;
    }
  }));
  return { sent: results.filter(Boolean).length, total: subs.length };
}

// ws clients report whether they are looking at an agent, so a push isn't sent for what you are already watching
const presence = new Map(); // ws -> { visible, agentId }
const watched = (agentId) => [...presence.values()].some((p) => p.visible && p.agentId === agentId);

// push: false keeps it in the page (badge, toast) without a Web Push / channel (ntfy, webhook…) message
// label: wording instead of the kind's (a question is a `blocked` event that reads "has a question")
function notifyAgent(agent, kind, detail, { push = true, label = KIND_LABEL[kind] } = {}) {
  agent.attention = { kind, at: Date.now() };
  const text = `${label}${detail ? ': ' + detail : ''}`;
  broadcast({ type: 'notify', agentId: agent.id, name: agent.name, kind, label, text });
  broadcast({ type: 'agent', agent: agent.summary() });
  pluginHost.emit('agent.attention', { agent: agent.summary(), kind, label, text, detail: detail || '' });
  if (kind === 'blocked') pluginHost.emit('approval.requested', { agent: agent.summary(), approvals: agent.pendingApprovals(), text });
  const s = notifySettings();
  if (!push || !s.events[kind] || watched(agent.id)) return;
  if (q.allSubs.all().length)
    sendWebPush({ kind, title: `${agent.name} · ${label}`, body: s.details ? detail || '' : '', tag: agent.id, url: '/#/a/' + agent.id })
      .catch((e) => console.error('web push:', e.message));
  pluginHost.notify({ kind, title: `${agent.name} · ${label}`, body: s.details ? detail || '' : '', agentId: agent.id, url: '/#/a/' + agent.id });
}

// ---- rooms (group chats between agents; see rooms.js)
const rooms = createRooms({ db, agents, broadcast, notify: notifyAgent, onMessage: (room, message) => pluginHost.emit('room.message', { room, message }) });

// ---- bots (permanent agents with identity and memory; see bots.js). Lazy callbacks: spawnAgent and removeAgent are defined further down.
const bots = createBots({ db, agents, broadcast, root: DATA_DIR, getCfg, putCfg, accounts: () => accounts, defaultAccount: () => defaultAccountFor(DEFAULT_BACKEND), browser, rooms, spawn: (body, internal) => spawnAgent(body, internal), removeAgent: (a) => removeAgent(a) });

// ---- peers: other swarm instances this one can see and drive, and that can drive this one (peers.js, docs/peers.md)
const stats = createStats({ volumes: [DATA_DIR] });
stats.start();
const peers = createPeers({ getCfg, putCfg, agents, stats });

// ---- plugins (plugins.js): started once the server listens; HALAY_PLUGINS=0 = safe mode (all off)
// A plugin calls this server's own REST API as itself (x-halay-plugin), so it gets exactly the checks and limits a client gets.
async function coreApi(method, p, body, pluginId) {
  const h = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
  const r = await fetch(`http://${h.includes(':') ? `[${h}]` : h}:${PORT}${p}`, {
    method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', 'x-halay-plugin': pluginId },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.statusText), { status: r.status });
  return j;
}
// a plugin's own notification: in the page, as a push and through every channel (`details` decides about the text, as for agents)
function notifyUser({ kind, title, body, agentId, url }) {
  broadcast({ type: 'notify', agentId: agentId || null, name: title, kind, text: body ? `${title}: ${body}` : title });
  const s = notifySettings(), text = s.details ? body || '' : '';
  if (q.allSubs.all().length) sendWebPush({ kind, title, body: text, tag: 'plugin-' + kind, url: url || (agentId ? '/#/a/' + agentId : '/') }).catch((e) => console.error('web push:', e.message));
  pluginHost.notify({ kind, title, body: text, agentId: agentId || null, url: url || null });
}
// the swarm MCP server's own tool names (swarm-mcp.js runs in each agent's claude, so it is read, not imported), so a
// plugin tool can't take one of them
let coreTools;
function coreToolNames() {
  if (!coreTools) {
    try { coreTools = [...fs.readFileSync(path.join(ROOT, 'src', 'swarm-mcp.js'), 'utf8').matchAll(/^  ([a-z_]+): \{\n\s+description:/gm)].map((m) => m[1]); } catch { coreTools = []; }
  }
  return coreTools;
}
const pluginHost = createPluginHost({
  db, root: ROOT, broadcast,
  pluginsDir: env('PLUGINS_DIR') || dataPath('plugins'),
  dataDir: dataPath('plugin-data'),
  safeMode: env('PLUGINS') === '0',
  services: { coreApi, notifyUser, publicUrl: () => PUBLIC_URL(), coreToolNames },
});
const roleOf = (a) => (a.role === 'conductor' ? 'conductor' : a.bot ? 'bot' : 'agent');

// ---- backlog tasks -----------------------------------------------------------
// A queued task is `ready` when every task it depends on is done, `waiting` while some are still queued/running,
// and `blocked` when one failed, is itself blocked, or was deleted. Blocked tasks never start by themselves.

const TASK_STATUSES = ['queued', 'running', 'done', 'failed'];
const RESULT_MAX = 20000;
const DRAIN_CHUNK = 4 << 20; // bytes of agent output read per step
const AGENT_EVENTS_DEFAULT = 1000; // GET /api/agents/:id without ?tail= or ?all=1 returns this many of the latest events
const parseDeps = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter(Number.isInteger) : []; } catch { return []; } };
const PLACEHOLDER = /\{\{\s*result:(\d+)\s*\}\}/g;
const placeholderIds = (prompt) => [...String(prompt || '').matchAll(PLACEHOLDER)].map((m) => Number(m[1]));

// { state: ready|waiting|blocked, reason, waitingOn: [ids] } from the dependencies alone
function depCheck(t, byId, seen = new Set()) {
  const waitingOn = [];
  let reason = null;
  seen.add(t.id);
  for (const id of parseDeps(t.depends_on)) {
    const d = byId.get(id);
    if (!d) { reason ??= `dependency #${id} was deleted`; continue; }
    if (d.status === 'done') continue;
    if (d.status === 'failed') { reason ??= `dependency #${id} failed`; continue; }
    if (d.status === 'queued' && !seen.has(id) && depCheck(d, byId, seen).state === 'blocked') { reason ??= `dependency #${id} is blocked`; continue; }
    waitingOn.push(id);
  }
  return { state: reason ? 'blocked' : waitingOn.length ? 'waiting' : 'ready', reason, waitingOn };
}

function taskOut(t, byId) {
  byId ||= new Map(q.allTasks.all().map((x) => [x.id, x]));
  const dc = depCheck(t, byId);
  const queued = t.status === 'queued';
  return {
    id: t.id, title: t.title, prompt: t.prompt || '', cwd: t.cwd || '', account: t.account || '', status: t.status, position: t.position,
    model: t.model || '', effort: t.effort || '', agentId: t.agent_id, result: t.result, createdAt: t.created_at, updatedAt: t.updated_at,
    dependsOn: parseDeps(t.depends_on), autoStart: !!t.auto_start, bot: t.bot || null, scheduledFrom: t.scheduled_from ?? null, addedBy: t.added_by || null,
    state: queued ? dc.state : t.status, // what the task is doing right now: ready | waiting | blocked | running | done | failed
    blockedBy: queued ? dc.reason : null, waitingOn: queued ? dc.waitingOn : [],
  };
}
const allTasks = () => { const rows = q.allTasks.all(), byId = new Map(rows.map((x) => [x.id, x])); return rows.map((t) => taskOut(t, byId)); };
// coalesced: a burst of changes (a schedule run, a turn settling several tasks) sends the whole list once
let tasksPending = false;
const broadcastTasks = () => {
  if (tasksPending) return;
  tasksPending = true;
  setImmediate(() => { tasksPending = false; broadcast({ type: 'tasks', tasks: allTasks() }); });
};

// would giving task `id` these dependencies create a loop?
function dependsOnItself(id, deps, byId) {
  const seen = new Set(), stack = [...deps];
  while (stack.length) {
    const x = stack.pop();
    if (x === id) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...parseDeps(byId.get(x)?.depends_on));
  }
  return false;
}

// body: partial task fields; addedBy: 'peer:<name>' for a new task a peer adds. Returns { error, code } or { task }
function saveTask(id, body, addedBy = null) {
  const old = id ? q.getTask.get(id) : null;
  if (id && !old) return { code: 404, error: 'no such task' };
  const t = {
    title: old?.title, prompt: old?.prompt ?? null, cwd: old?.cwd ?? null, account: old?.account ?? null,
    status: old?.status ?? 'queued', agent_id: old?.agent_id ?? null, result: old?.result ?? null,
    depends_on: parseDeps(old?.depends_on), auto_start: old?.auto_start ? 1 : 0, bot: old?.bot ?? null,
    model: old?.model ?? null, effort: old?.effort ?? null,
  };
  const me = modelEffortOf(body);
  if (me.error) return { code: 400, error: me.error };
  Object.assign(t, me);
  for (const k of ['title', 'prompt', 'cwd', 'account', 'status'])
    if (body[k] !== undefined) {
      if (body[k] !== null && typeof body[k] !== 'string') return { code: 400, error: `${k} must be a string` };
      t[k] = body[k] === null ? null : body[k].trim();
    }
  const depsIn = body.dependsOn ?? body.depends_on;
  if (depsIn !== undefined) {
    if (!Array.isArray(depsIn) || !depsIn.every((x) => Number.isInteger(Number(x)))) return { code: 400, error: 'dependsOn must be an array of task ids' };
    t.depends_on = [...new Set(depsIn.map(Number))];
  }
  const autoIn = body.autoStart ?? body.auto_start;
  if (autoIn !== undefined) t.auto_start = autoIn ? 1 : 0;
  if (!t.title) return { code: 400, error: 'title required' };
  if (body.bot !== undefined) {
    if (body.bot !== null && body.bot !== '' && !bots.get(body.bot)) return { code: 400, error: `no bot @${body.bot}` };
    t.bot = body.bot || null;
  }
  for (const k of ['prompt', 'cwd', 'account']) if (!t[k]) t[k] = null;
  if (!TASK_STATUSES.includes(t.status)) return { code: 400, error: 'status must be one of ' + TASK_STATUSES.join(', ') };
  if (t.cwd && !(fs.existsSync(t.cwd) && fs.statSync(t.cwd).isDirectory())) return { code: 400, error: 'cwd must be an existing directory' };
  if (t.account && !accounts[t.account]) return { code: 400, error: 'unknown account' };
  // a {{result:N}} placeholder is a dependency on N
  t.depends_on = [...new Set([...t.depends_on, ...placeholderIds(t.prompt)])];
  const byId = new Map(q.allTasks.all().map((x) => [x.id, x]));
  for (const d of t.depends_on) {
    if (d === id) return { code: 400, error: 'a task cannot depend on itself' };
    if (!byId.has(d)) return { code: 400, error: `no task #${d} to depend on` };
  }
  if (id && dependsOnItself(id, t.depends_on, byId)) return { code: 400, error: 'those dependencies would make a loop' };
  if (t.status === 'queued') { t.agent_id = null; if (old && old.status !== 'queued') t.result = null; }
  const now = Date.now(), row = { ...t, depends_on: t.depends_on.length ? JSON.stringify(t.depends_on) : null };
  let rowId = id;
  if (old) q.updTask.run({ ...row, id, now });
  else rowId = q.insTask.run({ title: t.title, prompt: t.prompt, cwd: t.cwd, account: t.account, model: t.model, effort: t.effort, depends_on: row.depends_on, auto_start: t.auto_start, bot: t.bot, now }).lastInsertRowid;
  if (!old && addedBy) q.setAddedBy.run(addedBy, rowId);
  broadcastTasks();
  if (!old) pluginHost.emit('task.added', { task: taskOut(q.getTask.get(rowId)) });
  if (t.status === 'done' && old?.status !== 'done') setTimeout(() => autoStartReady(null), 0); // marked done by hand: dependents may be ready
  return { task: taskOut(q.getTask.get(rowId)) };
}

// the prompt with each {{result:N}} replaced by what task N produced; a scheduled run also gets
// {{last_result}} / {{last_run_at}} from the run of the same schedule before it
const resolvePrompt = (t) => {
  let text = (t.prompt || t.title).trim();
  if (t.scheduled_from) {
    const prev = q.prevRun.get(t.scheduled_from, t.id), tz = q.getSchedule.get(t.scheduled_from)?.tz || LOCAL_TZ;
    text = text.replace(/\{\{\s*last_result\s*\}\}/g, () => (prev?.result ?? '').trim())
      .replace(/\{\{\s*last_run_at\s*\}\}/g, () => (prev ? fmtTime(prev.created_at, tz) : 'never'));
  }
  return text.replace(PLACEHOLDER, (_, n) => (q.getTask.get(Number(n))?.result ?? '').trim() || '(that task produced no result)');
};

// the agent never got the task's prompt (folder gone, claude failed to start, bot paused): fail the task with the
// reason, so it is not shown running forever and its dependents are blocked instead of waiting
function undelivered(t, agent) {
  const error = `could not deliver the task to agent ${agent.id}: ${agent.sendError || 'unknown reason'}`;
  q.updTask.run({ ...t, status: 'failed', agent_id: agent.id, result: error, now: Date.now() });
  broadcastTasks();
  pluginHost.emit('task.finished', { task: taskOut(q.getTask.get(t.id)) });
  return { code: 500, error, agent: agent.summary() };
}

// Hand a task to an idle agent, or start a new agent for it. Returns { error, code } or { task, agent }.
function assignTask(id, { agentId, cwd, account, permissionMode, model, effort, parentId, oneOff } = {}, startedBy = null) {
  const t = q.getTask.get(id);
  if (!t) return { code: 404, error: 'no such task' };
  const me = modelEffortOf({ model, effort });
  if (me.error) return { code: 400, error: me.error };
  if (t.status === 'running') return { code: 409, error: 'task is already running' };
  const dc = depCheck(t, new Map(q.allTasks.all().map((x) => [x.id, x])));
  if (dc.state !== 'ready')
    return { code: 409, error: dc.state === 'blocked' ? `task is blocked: ${dc.reason}` : `task is waiting for ${dc.waitingOn.map((n) => '#' + n).join(', ')} to finish` };
  const prompt = resolvePrompt(t);
  let agent;
  if (!agentId && t.bot) { // aimed at a bot: it does the task in its own long-lived session
    const r = bots.ensureAgent(t.bot);
    if (r.error) return r;
    agentId = r.agent.id;
  }
  if (agentId) {
    agent = agents.get(agentId);
    if (!agent) return { code: 404, error: 'no such agent' };
    if (agent.status === 'running') return { code: 409, error: 'agent is busy; pick an idle agent' };
    if (agent.bot && bots.isPaused(agent.bot)) return { code: 409, error: `bot @${agent.bot} is paused` };
    if (!agent.send(prompt)) return undelivered(t, agent);
  } else {
    const r = spawnAgent({ cwd: cwd || t.cwd, account: account || t.account || undefined, permissionMode, model: me.model || t.model || undefined, effort: me.effort || t.effort || undefined, parentId, oneOff: !!oneOff, name: t.title.slice(0, 60), prompt }, { startedBy });
    if (r.error) return r;
    agent = r.agent;
    if (r.delivered === false) return undelivered(t, agent);
  }
  q.updTask.run({ ...t, status: 'running', agent_id: agent.id, result: null, now: Date.now() });
  broadcastTasks();
  return { task: taskOut(q.getTask.get(id)), agent: agent.summary() };
}

// A finished turn settles the task the agent was working on; its dependents may now be startable.
// Returns true if one of them was a scheduled run (its schedule decides about notifying).
function taskTurnEnded(agent, ev) {
  pluginHost.emit('agent.finished', { agent: agent.summary(), isError: !!ev.is_error, result: String(ev.result ?? ''), handoff: !!agent.handoff });
  const rows = q.runningTasks.all(agent.id);
  for (const t of rows) q.updTask.run({ ...t, status: ev.is_error ? 'failed' : 'done', result: String(ev.result ?? '').slice(0, RESULT_MAX), now: Date.now() });
  if (!rows.length) return false;
  broadcastTasks();
  for (const t of rows) pluginHost.emit('task.finished', { task: taskOut(q.getTask.get(t.id)) });
  setTimeout(() => { autoStartReady(agent); scheduledRunsEnded(rows); }, 0); // after the turn is fully over, so the agent reads as idle
  return rows.some((t) => t.scheduled_from);
}

// Tasks flagged auto-start whose dependencies are all done: start a new agent in the task's folder, or, with no
// folder, give it to the agent that just finished. Blocked and waiting tasks are never touched.
function autoStartReady(finished) {
  try { autoStartReadyNow(finished); } catch (e) { console.error('auto-start of ready tasks failed:', e); } // runs from timers
}
function autoStartReadyNow(finished) {
  const rows = q.allTasks.all(), byId = new Map(rows.map((x) => [x.id, x]));
  for (const t of rows) {
    if (t.status !== 'queued' || !t.auto_start || !parseDeps(t.depends_on).length) continue;
    if (depCheck(t, byId).state !== 'ready') continue;
    let r;
    if (t.cwd || t.bot) {
      if (liveAgents() >= MAX_LIVE) continue;
      r = assignTask(t.id, {});
    } else if (finished && finished.role !== 'conductor' && agents.has(finished.id) && finished.status !== 'running') r = assignTask(t.id, { agentId: finished.id });
    else continue;
    if (r.error) console.error(`auto-start of task #${t.id} failed: ${r.error}`);
  }
}

// oneOff may arrive as a string from MCP clients that stringify booleans
const isOneOff = (body) => body.oneOff === true || body.oneOff === 'true';

// a backend's model list from its CLI (e.g. `opencode models`), cached for 10 minutes; [] if it has none or fails
const modelsCache = new Map(); // backend id -> { at, list, pending }
function backendModels(b, force) {
  if (!b.models) return Promise.resolve([]);
  const c = modelsCache.get(b.id);
  if (c?.pending) return c.pending;
  if (c && !force && Date.now() - c.at < 10 * 60e3) return Promise.resolve(c.list);
  const acct = accounts[defaultAccountFor(b.id)];
  if (!acct) return Promise.resolve([]);
  const pending = new Promise((resolve) => {
    const done = (err, list) => { list = err ? (c?.list || []) : list; modelsCache.set(b.id, { at: Date.now(), list }); resolve(list); };
    if (b.models.acp) return b.listModels({ env: accountEnv(acct), timeoutMs: 45000 }).then((l) => done(null, l), (e) => done(e)); // from its ACP server
    execFile(b.bin, b.models.args, { cwd: os.tmpdir(), env: accountEnv(acct), timeout: 30000, maxBuffer: 4 << 20 }, (err, out) => done(err, err ? null : b.models.parse(String(out))));
  });
  modelsCache.set(b.id, { ...(c || { at: 0, list: [] }), pending });
  return pending;
}

// a request's backend and account, checked: { backend, account } or { error }. The account decides the backend; a
// backend alone gets its default account; neither inherits the parent's account, else Claude's default account.
function backendAndAccount(body, parent) {
  const want = body.backend || null;
  if (want && !BACKENDS[want]) return { error: `unknown backend ${want} (backends: ${Object.keys(BACKENDS).join(', ')})` };
  if (want && !backendEnabled(want)) return { error: `backend ${want} is turned off (HALAY_BACKENDS)` };
  let account = body.account || null;
  if (!account) account = want ? (parent && parent.backend === want ? parent.account : defaultAccountFor(want)) : parent?.account || defaultAccountFor(DEFAULT_BACKEND);
  if (!account) return { error: `${BACKENDS[want].label} can't run here: ${backendStatus[want]?.reason || 'not installed'}` };
  if (!accounts[account]) return { error: 'unknown account' };
  const backend = accounts[account].backend;
  if (want && want !== backend) return { error: `account ${account} is a ${BACKENDS[backend].label} account, not ${BACKENDS[want].label}` };
  return { backend, account };
}
// Resuming another CLI's session (History): its conversation, read by loading the session in a short-lived process
// of that CLI (the replay; backends/acp.js readSession). null for Claude, whose transcript spawnAgent imports itself.
async function otherCliHistory(body) {
  if (!body.sessionId || body.parentId) return null;
  const bk = backendAndAccount(body, null);
  if (bk.error || bk.backend === DEFAULT_BACKEND) return null; // spawnAgent reports a bad account
  const b = BACKENDS[bk.backend];
  if (!b.readSession) return { code: 400, error: `${b.label} sessions can't be resumed` };
  if (!/^[\w.:-]+$/.test(String(body.sessionId))) return { code: 400, error: 'bad session id' };
  if (body.cwd && oneOffIdOf(body.cwd)) fs.mkdirSync(body.cwd, { recursive: true }); // a removed one-off's folder comes back empty
  const cwd = body.cwd && fs.existsSync(body.cwd) ? body.cwd : null;
  if (!cwd) return null; // spawnAgent says what is wrong with the folder
  try {
    return { events: (await b.readSession({ env: accountEnv(accounts[bk.account]), cwd, sessionId: String(body.sessionId), timeoutMs: 60000 })) };
  } catch (e) { return { code: 502, error: `could not read the ${b.label} session: ${e.message}` }; }
}

// internal ({ id, wt, history }) only ever comes from the server itself (worktree start, History), never from a request body
function spawnAgent(body, internal = {}) {
  const parent = body.parentId ? agents.get(body.parentId) : null;
  if (body.parentId && !parent) return { code: 400, error: 'unknown parent agent' };
  // an agent starting agents (swarm MCP): inherit from the parent, but never escalate, and keep it bounded
  if (internal.startedBy && liveAgents() >= MAX_LIVE) return { code: 400, error: `${MAX_LIVE} agents are already running` };
  if (parent) {
    let depth = 1;
    for (let p = parent; p.parentId && agents.get(p.parentId); p = agents.get(p.parentId)) depth++;
    if (depth > MAX_DEPTH) return { code: 400, error: `agents can only be nested ${MAX_DEPTH} deep` };
    if (parent.role !== 'conductor' && [...agents.values()].filter((a) => a.parentId === parent.id).length >= MAX_CHILDREN)
      return { code: 400, error: `an agent can start at most ${MAX_CHILDREN} agents` };
    if (liveAgents() >= MAX_LIVE)
      return { code: 400, error: `${MAX_LIVE} agents are already running` };
  }
  if (!internal.bot && (body.parentId || internal.startedBy)) { // an agent, the conductor or a peer starting an agent must not duplicate a bot
    const dup = bots.duplicateOf({ cwd: body.cwd, name: body.name });
    if (dup) return { code: 409, error: dup };
  }
  const reopened = !isOneOff(body) && body.sessionId && !internal.id ? oneOffIdOf(body.cwd) : null; // resuming a removed one-off's session
  if (reopened && agents.has(reopened)) return { code: 400, error: 'that one-off agent still exists' };
  const oneOff = isOneOff(body) || !!reopened;
  if (oneOff && body.worktree) return { code: 400, error: 'oneOff and worktree cannot be combined (a one-off folder is an empty scratch dir, not a git repository)' };
  if (oneOff && body.sessionId && !reopened) return { code: 400, error: 'a resumed session cannot move into a one-off folder (its transcript belongs to the original folder)' };
  const id = internal.id || reopened || (oneOff ? crypto.randomUUID().slice(0, 8) : undefined);
  const cwd = oneOff ? path.join(tmpDirFor(id), 'scratch') : body.cwd || parent?.cwd;
  const me = modelEffortOf(body);
  if (me.error) return { code: 400, error: me.error };
  // backend and account: an account belongs to one backend; either may be given, else the parent's, else claude
  const bk = backendAndAccount(body, parent);
  if (bk.error) return { code: 400, error: bk.error };
  const { backend, account } = bk, caps = BACKENDS[backend].capabilities, defs = defaultsFor(backend); // Settings → Agent defaults for this CLI
  const sameAsParent = parent && parent.backend === backend; // a parent on another CLI has models and modes that mean nothing here
  let permissionMode = body.permissionMode || (sameAsParent || !parent ? parent?.permissionMode : null) || defs.permissionMode || 'auto';
  if (![...PERMISSION_MODES, 'default'].includes(permissionMode)) return { code: 400, error: 'permissionMode must be one of ' + PERMISSION_MODES.join(', ') };
  if (!caps.modes.includes(permissionMode === 'default' ? 'manual' : permissionMode)) {
    if (body.permissionMode) return { code: 400, error: `${BACKENDS[backend].label} agents can't use permission mode ${permissionMode} (they can: ${caps.modes.join(', ')})` };
    permissionMode = 'manual'; // an inherited or default mode it lacks (e.g. Claude's auto): ask the user
  }
  // never more permissive than the parent: an explicit mode above the parent's is refused; a default one (the Settings
  // default, or a parent on another CLI) comes down to the parent's mode, else manual (every call asks)
  if (parent && modeRank(permissionMode) > modeRank(parent.permissionMode)) {
    if (body.permissionMode) return { code: 400, error: `a child cannot be more permissive than its parent (${parent.permissionMode}): ${body.permissionMode}` };
    permissionMode = caps.modes.includes(parent.permissionMode === 'default' ? 'manual' : parent.permissionMode) ? parent.permissionMode : modeRank(parent.permissionMode) >= modeRank('manual') ? 'manual' : caps.modes.includes('plan') ? 'plan' : 'manual';
  }
  // model and effort: the request's, else the parent's (same backend), else the Settings default (Claude's), else the CLI's
  const model = me.model || (sameAsParent ? parent.model : null) || defs.model || null;
  let effort = me.effort || (sameAsParent ? parent.effort : null) || defs.effort || null;
  if (effort && !caps.effort.includes(effort)) {
    if (me.effort) return { code: 400, error: caps.effort.length ? `effort must be one of ${caps.effort.join(', ')} for ${BACKENDS[backend].label}` : `${BACKENDS[backend].label} has no effort setting` };
    effort = null;
  }
  if (body.sessionId && backend !== DEFAULT_BACKEND && !internal.history) return { code: 400, error: `resuming a ${BACKENDS[backend].label} session goes through POST /api/agents, which reads its conversation first` };
  const { sessionId, prompt } = body;
  const name = body.name || (oneOff ? 'one-off' : undefined);
  if (parent?.role === 'conductor' && !body.cwd && !oneOff) return { code: 400, error: 'cwd is required' };
  if (!oneOff && (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()))
    return { code: 400, error: cwd ? `cwd must be an existing directory: ${cwd}` : 'cwd is required (or set oneOff to start in a scratch folder)' };
  if (oneOff) {
    try { fs.mkdirSync(cwd, { recursive: true }); } catch (e) { return { code: 500, error: `could not create the one-off folder ${cwd}: ${e.message}` }; }
  }
  let lean = body.lean == null || body.lean === '' ? null : body.lean === true || body.lean === 'true'; // MCP clients may send strings
  if (lean && !caps.lean) return { code: 400, error: `${BACKENDS[backend].label} can't run lean (only the swarm's MCP servers)` };
  if (!caps.lean) lean = null;
  const notify = !(body.notify === false || body.notify === 'false'); // wake the parent when its turns end (MCP clients may send strings)
  // browser: true = the default profile, a name = that profile, false = none; unset = the Settings default
  const bc = browser.cfg(), want = body.browser == null || body.browser === '' ? bc.defaultOn : body.browser === 'false' ? false : body.browser;
  const bprofile = want === false ? null : typeof want === 'string' && want !== 'true' ? want : want ? bc.profile : null;
  if (bprofile && !browser.validName(bprofile)) return { code: 400, error: 'bad browser profile name (letters, digits, - and _)' };
  if (bprofile && !browser.available()) return { code: 400, error: 'the browser tool is not installed (npm install, then see docs/browser.md)' };
  const agent = Agent.create({ id, wt: internal.wt, cwd, permissionMode, model, effort, account, backend, sessionId, name, parentId: parent?.id, startedBy: internal.startedBy, lean, browser: bprofile, bot: internal.bot, notify });
  if (sessionId) {
    agent.events = internal.history || importTranscript(sessionId);
    db.transaction(() => { for (const ev of agent.events) recordEvent(agent.id, ev, ev._ts ?? null); })();
    agent.recomputeTodos();
  }
  agents.set(agent.id, agent);
  broadcast({ type: 'agent', agent: agent.summary() });
  const attached = claimStaged(agent.id, body.uploads);
  const delivered = prompt || attached.length ? agent.send(withAttachments(prompt, attached), parent ? { by: parent.id } : undefined) : undefined;
  return { agent, delivered };
}

const stableJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// ---- usage warnings: per account, per day, once per metric -----------------------------
// [[metric, text]] for each of the account's daily thresholds it has reached today
function usageHits(account) {
  const cfg = usageAlertsCfg().accounts?.[account];
  if (!cfg) return [];
  const tot = q.dayTotals.get(account, dayOf(Date.now()));
  const hits = [];
  if (cfg.dailyCost > 0 && (tot.cost || 0) >= cfg.dailyCost) hits.push(['cost', `$${(tot.cost || 0).toFixed(2)} of the $${cfg.dailyCost} daily cost threshold`]);
  if (cfg.dailyTokens > 0 && (tot.tokens || 0) >= cfg.dailyTokens) hits.push(['tokens', `${(tot.tokens || 0).toLocaleString('en-US')} of the ${cfg.dailyTokens.toLocaleString('en-US')} daily token threshold`]);
  return hits;
}

function checkUsageAlerts(agent) {
  const hits = usageHits(agent.account);
  if (!hits.length) return;
  const day = dayOf(Date.now());
  let warned;
  try { warned = JSON.parse(q.getSetting.get('usage_warned')?.value || '{}'); } catch { warned = {}; }
  if (warned.day !== day) warned = { day, keys: [] };
  for (const [metric, text] of hits) {
    const k = agent.account + '|' + metric;
    if (warned.keys.includes(k)) continue;
    warned.keys.push(k);
    q.putSetting.run('usage_warned', JSON.stringify(warned));
    notifyAgent(agent, 'usage', `account ${agent.account} is at ${text}`);
  }
}

// ---- watchdog sweep: running agents that went quiet ---------------------------------------
setInterval(() => { try { watchdogTick(); } catch (e) { console.error('watchdog:', e); } }, 30_000).unref();
function watchdogTick() {
  const cfg = watchdogCfg();
  if (!cfg.enabled) return;
  const now = Date.now(), mins = (ms) => Math.round(ms / 60000);
  for (const a of agents.values()) {
    if (a.status !== 'running' || !a.pid || a.watchdog || a.pendingApprovals().length) continue;
    if (a.sentAt && now - a.sentAt >= cfg.startMinutes * 60_000) {
      a.flagStuck('idle', `no response ${mins(now - a.sentAt)} min after it was sent a message: claude never started the turn; interrupt it and send the message again`, 'idle');
      continue;
    }
    const tool = a.toolInProgress();
    if (now - a.lastEventAt < (tool ? cfg.toolMinutes : cfg.idleMinutes) * 60_000) continue;
    a.flagStuck('idle', `no activity for ${mins(now - a.lastEventAt)} min while running${tool ? ` (in a ${tool} call)` : ''}`, 'idle');
  }
}

// ---- context recycling: an idle agent with a big context gets a fresh one with a handoff note. Off by default for
// agents, on for the conductor. Never touches a running agent or one waiting for an approval; a worktree with
// uncommitted changes is named in the note.
setInterval(() => { try { recycleTick(); } catch (e) { console.error('context recycling:', e); } }, 60_000).unref();
function recycleTick() {
  const cfg = contextCfg(), now = Date.now();
  for (const a of agents.values()) {
    const conductor = a.role === 'conductor';
    if (!(conductor ? cfg.conductorRecycle : cfg.autoRecycle) || a.handoff || !a.sessionId) continue;
    if (a.status !== 'idle' && !(conductor && a.status === 'stopped')) continue; // stopped agents are left alone, except the conductor
    const idle = (conductor ? cfg.conductorIdleHours : cfg.recycleIdleHours) * 36e5;
    if (a.ctx < (conductor ? cfg.conductorTokens : cfg.recycleTokens) || now - a.lastEventAt < idle || now - (a.recycleFailedAt || 0) < idle) continue;
    if (a.pendingApprovals().length) continue;
    console.log(`context: refreshing ${a.name} (${a.id}) with a handoff: ${Math.round(a.ctx / 1000)}k tokens, idle ${((now - a.lastEventAt) / 36e5).toFixed(1)}h`);
    a.startHandoff({ auto: true }).then(async (r) => {
      const out = r.done ? await r.done : r;
      if (out.error) { a.recycleFailedAt = Date.now(); console.log(`context: refresh of ${a.id} failed: ${out.error}`); }
    }).catch((e) => { a.recycleFailedAt = Date.now(); console.error(`context: refresh of ${a.id} failed:`, e); });
  }
}

// ---- schedules: recurring tasks -----------------------------------------------------------------
// Each run of a schedule is a new task (scheduled_from = the schedule) handed to a new agent through assignTask, in the
// schedule's folder or a fresh one-off scratch folder; taskTurnEnded settles it like any other task. next_run_at is
// persisted, so a restart picks up where it left off. The next run is always computed from now, so runs missed while
// the server was down collapse into one run at startup instead of a burst.

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const PERMISSION_MODES = ['auto', 'manual', 'acceptEdits', 'plan', 'bypassPermissions', 'cli'];
const DECISIONS = ['allow', 'always', 'deny', 'answer']; // answers to an approval card
const OVERLAPS = ['skip', 'queue'], NOTIFY_WHEN = ['always', 'failure', 'alert'];
const RUNS_KEPT = 100; // finished run tasks kept per schedule (its run history)
function liveAgents() { return [...agents.values()].filter((a) => a.pid).length; } // running claude processes

const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const fmtTime = (ts, tz) => { try { return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(ts) + ' ' + tz; } catch { return new Date(ts).toISOString(); } };

// a paused Cron (only used to compute times), or throws with a message fit for the user
function cronOf(expr, tz) {
  const e = String(expr || '').trim().replace(/\s+/g, ' ');
  if (!e) throw new Error('cron is required, e.g. "0 9 * * 1-5" for weekdays at 09:00');
  const n = e.split(' ').length;
  if (!e.startsWith('@') && n !== 5) throw new Error(`cron must have 5 fields (minute hour day-of-month month day-of-week), "${e}" has ${n}`);
  try { return new Cron(e, { timezone: tz, paused: true }); } catch (err) { throw new Error(`invalid cron "${e}": ${err.message.replace(/^\w+: /, '')}`); }
}
const nextRunOf = (s, after = new Date()) => { try { return cronOf(s.cron, s.tz || LOCAL_TZ).nextRun(after)?.getTime() ?? null; } catch { return null; } };

// "0 9 * * 1-5" -> "Weekdays at 09:00"; falls back to the expression itself for anything unusual
const DOWS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function describeCron(expr) {
  const e = String(expr || '').trim().replace(/\s+/g, ' ');
  const nick = { '@yearly': 'Every year on January 1 at 00:00', '@annually': 'Every year on January 1 at 00:00', '@monthly': 'On day 1 of every month at 00:00', '@weekly': 'Every Sunday at 00:00', '@daily': 'Every day at 00:00', '@midnight': 'Every day at 00:00', '@hourly': 'Every hour' }[e.toLowerCase()];
  if (nick) return nick;
  const f = e.split(' ');
  if (f.length !== 5) return e;
  const [mi, h, dom, mon, dow] = f;
  const num = (x) => /^\d+$/.test(x), every = (x) => /^\*\/\d+$/.test(x) && +x.slice(2);
  const pad = (x) => String(x).padStart(2, '0');
  const list = (xs) => (xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs.at(-1) : xs[0]);
  const dayName = (x) => { const n = num(x) ? +x % 7 : DOWS.findIndex((d) => d.slice(0, 3).toLowerCase() === x.toLowerCase()); return DOWS[n]; };
  let time, recurring = true;
  if (num(mi) && num(h)) { time = `at ${pad(h)}:${pad(mi)}`; recurring = false; }
  else if (num(mi) && /^\d+(,\d+)+$/.test(h)) { time = 'at ' + list(h.split(',').map((x) => `${pad(x)}:${pad(mi)}`)); recurring = false; }
  else if (num(mi) && h === '*') time = +mi ? `every hour at minute ${+mi}` : 'every hour';
  else if (num(mi) && every(h)) time = `every ${every(h) === 1 ? '' : every(h) + ' '}hour${every(h) === 1 ? '' : 's'}${+mi ? ` at minute ${+mi}` : ''}`;
  else if (num(mi) && /^\d+-\d+$/.test(h)) { const [a, b] = h.split('-'); time = `every hour from ${pad(a)}:${pad(mi)} to ${pad(b)}:${pad(mi)}`; }
  else if (every(mi) && h === '*') time = `every ${every(mi) === 1 ? '' : every(mi) + ' '}minute${every(mi) === 1 ? '' : 's'}`;
  else if (every(mi) && /^\d+-\d+$/.test(h)) { const [a, b] = h.split('-'); time = `every ${every(mi)} minutes from ${pad(a)}:00 to ${pad(b)}:59`; }
  else if (mi === '*' && h === '*') time = 'every minute';
  else return e;
  let days = null; // null = every day
  const dowText = () => {
    const d = dow.toLowerCase();
    if (d === '1-5' || d === 'mon-fri') return 'on weekdays';
    if (['0,6', '6,0', '6,7', '6-7', 'sat,sun', 'sun,sat'].includes(d)) return 'on weekends';
    if (/^\w+-\w+$/.test(d) && dayName(d.split('-')[0]) && dayName(d.split('-')[1])) return `${dayName(d.split('-')[0])} to ${dayName(d.split('-')[1])}`;
    const names = d.split(',').map(dayName);
    return names.every(Boolean) ? (names.length === 1 ? 'every ' + names[0] : 'on ' + list(names)) : null;
  };
  if (dow !== '*' && dow !== '?') { days = dowText(); if (!days) return e; }
  if (dom !== '*' && dom !== '?') {
    const dd = /^[\d,]+$/.test(dom) ? `on day${dom.includes(',') ? 's' : ''} ${list(dom.split(','))} of the month` : null;
    if (!dd) return e;
    days = days ? `${dd} and ${days.replace(/^on /, '')}` : dd;
  }
  let months = '';
  if (mon !== '*') {
    const ms = mon.split(',').map((x) => (num(x) ? MONTHS[+x - 1] : MONTHS.find((m) => m.slice(0, 3).toLowerCase() === x.toLowerCase())));
    if (!ms.every(Boolean)) return e;
    months = ' in ' + list(ms);
  }
  const cap = (x) => x[0].toUpperCase() + x.slice(1);
  if (!days) return cap(recurring ? time : `every day ${time}`) + months;
  if (days === 'on weekdays' || days === 'on weekends') days = days.slice(3);
  return cap(recurring ? `${time}, ${days}` : `${days} ${time}`) + months;
}

function scheduleOut(s) {
  const last = s.last_task_id ? q.getTask.get(s.last_task_id) : null;
  return {
    id: s.id, title: s.title, prompt: s.prompt || '', cwd: s.cwd || '', account: s.account || '', permissionMode: s.permission_mode || 'auto', model: s.model || '', effort: s.effort || '',
    oneOff: !!s.one_off, cron: s.cron, tz: s.tz || LOCAL_TZ, description: describeCron(s.cron), enabled: !!s.enabled,
    overlap: s.overlap, notify: s.notify, keepAgents: s.keep_agents, nextRunAt: s.enabled ? s.next_run_at : null,
    lastRunAt: s.last_run_at, lastTaskId: s.last_task_id, lastStatus: last?.status ?? null, lastAgentId: last?.agent_id ?? null,
    bot: s.bot || null, skipReason: s.skip_reason, skippedAt: s.skipped_at, createdBy: s.created_by || null, createdAt: s.created_at, updatedAt: s.updated_at,
  };
}
const allSchedules = () => q.allSchedules.all().map(scheduleOut);
const broadcastSchedules = () => broadcast({ type: 'schedules', schedules: allSchedules() });

// body: partial schedule fields (camelCase or snake_case); createdBy: the agent adding it (new schedules only)
// returns { error, code } or { schedule }
// caller: the agent adding or changing it (swarm MCP), whose permission mode its runs may not exceed; null for the user
function saveSchedule(id, body, createdBy = null, caller = null) {
  const old = id ? q.getSchedule.get(id) : null;
  if (id && !old) return { code: 404, error: 'no such schedule' };
  const s = old ? { ...old } : { bot: null, prompt: null, cwd: null, account: null, permission_mode: null, model: null, effort: null, one_off: 0, tz: LOCAL_TZ, enabled: 1, overlap: 'skip', notify: 'always', keep_agents: 3 };
  const val = (...ks) => ks.map((k) => body[k]).find((v) => v !== undefined);
  const bool = (v) => v === true || v === 'true' || v === 1; // MCP clients may send booleans as strings
  for (const [k, ...alias] of [['title'], ['prompt'], ['cwd'], ['account'], ['permission_mode', 'permissionMode'], ['cron'], ['tz', 'timezone'], ['overlap'], ['notify']]) {
    const v = val(k, ...alias);
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'string') return { code: 400, error: `${k} must be a string` };
    s[k] = v === null ? null : v.trim() || null;
  }
  const oneOff = val('one_off', 'oneOff'), enabled = val('enabled'), keep = val('keep_agents', 'keepAgents');
  if (oneOff !== undefined) s.one_off = bool(oneOff) ? 1 : 0;
  if (enabled !== undefined) s.enabled = bool(enabled) ? 1 : 0;
  if (keep !== undefined && keep !== null && keep !== '') {
    if (!Number.isInteger(Number(keep)) || keep < 0 || keep > 50) return { code: 400, error: 'keep_agents must be a whole number from 0 to 50' };
    s.keep_agents = Number(keep);
  }
  const me = modelEffortOf(body);
  if (me.error) return { code: 400, error: me.error };
  Object.assign(s, me);
  if (!s.title) return { code: 400, error: 'title required' };
  if (body.bot !== undefined) s.bot = body.bot || null;
  if (s.bot) { // aimed at a bot: each run is a turn of the bot's own session, in its folder and account
    const b = bots.get(s.bot);
    if (!b) return { code: 400, error: `no bot @${s.bot}` };
    s.cwd = b.cwd; s.one_off = 0; s.account = b.account;
  }
  if (s.one_off) s.cwd = null;
  else if (!s.cwd) return { code: 400, error: 'cwd is required (or set one_off to run each time in a fresh scratch folder)' };
  else if (!(fs.existsSync(s.cwd) && fs.statSync(s.cwd).isDirectory())) return { code: 400, error: `cwd must be an existing directory: ${s.cwd}` };
  if (s.account && !accounts[s.account]) return { code: 400, error: `unknown account ${s.account} (accounts: ${Object.keys(accounts).join(', ')})` };
  s.permission_mode ||= defaultsFor(accounts[s.account]?.backend).permissionMode; // the account's CLI decides which defaults
  if (!PERMISSION_MODES.includes(s.permission_mode)) return { code: 400, error: 'permission_mode must be one of ' + PERMISSION_MODES.join(', ') };
  if (caller) { // an agent: its schedule's runs may not be more permissive than itself (an unchanged mode it was given may stay)
    if (!s.bot && modeRank(s.permission_mode) > modeRank(caller.permissionMode) && !(old && s.permission_mode === old.permission_mode)) {
      if (val('permission_mode', 'permissionMode')) return { code: 400, error: `a schedule cannot be more permissive than the agent adding it (${caller.permissionMode}): ${s.permission_mode}` };
      // the default would be: yours instead, or the most permissive mode the schedule's CLI has that isn't above yours
      const modes = BACKENDS[accounts[s.account]?.backend || DEFAULT_BACKEND].capabilities.modes;
      s.permission_mode = modes.includes(caller.permissionMode) ? caller.permissionMode
        : modes.filter((x) => modeRank(x) <= modeRank(caller.permissionMode)).sort((a, b) => modeRank(b) - modeRank(a))[0] || 'manual';
    }
    const b = s.bot && bots.get(s.bot);
    if (b && caller.role !== 'conductor' && modeRank(b.permission_mode) > modeRank(caller.permissionMode))
      return { code: 400, error: `bot @${s.bot} runs in ${b.permission_mode}, more permissive than you (${caller.permissionMode}): only the user or the swarm chat can schedule it` };
  }
  { const be = BACKENDS[accounts[s.account]?.backend || DEFAULT_BACKEND]; // a mode its CLI lacks would fail on every run
    if (!be.capabilities.modes.includes(s.permission_mode === 'default' ? 'manual' : s.permission_mode)) return { code: 400, error: `${be.label} agents can't use permission mode ${s.permission_mode} (they can: ${be.capabilities.modes.join(', ')})` }; }
  s.tz ||= LOCAL_TZ;
  if (!validTz(s.tz)) return { code: 400, error: `unknown time zone "${s.tz}" (use an IANA name such as Europe/Istanbul or America/New_York)` };
  s.overlap ||= 'skip'; s.notify ||= 'always';
  if (!OVERLAPS.includes(s.overlap)) return { code: 400, error: 'overlap must be skip or queue' };
  if (!NOTIFY_WHEN.includes(s.notify)) return { code: 400, error: 'notify must be always, failure or alert' };
  let next;
  try { s.cron = String(s.cron || '').trim().replace(/\s+/g, ' '); next = cronOf(s.cron, s.tz).nextRun()?.getTime(); }
  catch (e) { return { code: 400, error: e.message }; }
  if (!next) return { code: 400, error: `cron "${s.cron}" never matches a future time` };
  // the next run moves only when the timing changes or the schedule is switched (back) on
  if (!old || old.cron !== s.cron || old.tz !== s.tz || (s.enabled && !old.enabled) || old.next_run_at == null) s.next_run_at = next;
  const now = Date.now();
  if (old) q.updSchedule.run({ ...s, id, now });
  else id = q.insSchedule.run({ ...s, next_run_at: next, created_by: createdBy, now }).lastInsertRowid;
  broadcastSchedules();
  return { schedule: scheduleOut(q.getSchedule.get(id)) };
}

// A schedule's finished runs go with it; a run still going is kept as a plain task so it can finish.
function deleteSchedule(id) {
  db.transaction(() => {
    for (const t of q.schedRuns.all(id)) {
      if (t.status === 'running') db.prepare('UPDATE tasks SET scheduled_from=NULL WHERE id=?').run(t.id);
      else q.delTask.run(t.id);
    }
    q.delSchedule.run(id);
  })();
  broadcastTasks();
  broadcastSchedules();
}

// Web Push (and the plugins' channels, e.g. ntfy) about a schedule; `details` in the notification settings decides whether text is included.
function notifySchedule(s, kind, label, text, agentId) {
  const ns = notifySettings(), title = `⏰ ${s.title} · ${label}`;
  if (q.allSubs.all().length)
    sendWebPush({ kind, title, body: ns.details ? text || '' : '', tag: 'schedule-' + s.id, url: agentId ? '/#/a/' + agentId : '/#/tasks' })
      .catch((e) => console.error('web push:', e.message));
  pluginHost.notify({ kind, title, body: ns.details ? text || '' : '', agentId: agentId || null, url: agentId ? '/#/a/' + agentId : '/#/tasks' });
}

function skipRun(s, reason, notify) {
  q.setScheduleSkip.run(reason, Date.now(), s.id);
  console.log(`schedule #${s.id} (${s.title}): run skipped: ${reason}`);
  pluginHost.emit('schedule.run', { schedule: scheduleOut(q.getSchedule.get(s.id) || s), phase: 'skipped', reason });
  if (notify) {
    broadcast({ type: 'notify', agentId: null, name: '⏰ ' + s.title, kind: 'usage', text: 'run skipped: ' + reason });
    notifySchedule(s, 'usage', 'run skipped', reason);
  }
}

// Start one run now. Returns { task, agent } or { code, error } plus busy / full / budget / unavailable when it could not start.
function runSchedule(s) {
  const prev = s.last_task_id ? q.getTask.get(s.last_task_id) : null;
  if (prev?.status === 'running') return { code: 409, error: `the previous run (task #${prev.id}) is still running`, busy: true };
  if (liveAgents() >= MAX_LIVE) return { code: 409, error: `${MAX_LIVE} agents are already running`, full: true };
  const account = s.account || defaultAccountFor(DEFAULT_BACKEND), hits = usageHits(account);
  if (hits.length) return { code: 409, error: `account ${account} is over its daily usage threshold (${hits.map((h) => h[1]).join('; ')})`, budget: true };
  let botAgent = null;
  if (s.bot) { // a bot runs the schedule itself: busy or paused counts as the previous run still going
    const r = bots.ensureAgent(s.bot);
    if (r.error) return { ...r, unavailable: true };
    botAgent = r.agent;
    if (bots.isPaused(s.bot)) return { code: 409, error: `bot @${s.bot} is paused`, busy: true };
    if (botAgent.status === 'running' || botAgent.handoff) return { code: 409, error: `bot @${s.bot} is busy`, busy: true };
  }
  const now = Date.now();
  const taskId = q.insRunTask.run({ title: s.title, prompt: s.prompt, cwd: s.one_off ? null : s.cwd, account: s.account, model: s.model, effort: s.effort, scheduled_from: s.id, now }).lastInsertRowid;
  q.setScheduleRun.run(now, taskId, s.id);
  const r = assignTask(taskId, { agentId: botAgent?.id, permissionMode: s.permission_mode || 'auto', oneOff: !!s.one_off });
  if (r.error) { // nothing started (e.g. the folder is gone): the run fails right away
    const t = q.getTask.get(taskId);
    q.updTask.run({ ...t, status: 'failed', result: 'could not start: ' + r.error, now: Date.now() });
    broadcastTasks();
    setTimeout(() => scheduledRunsEnded([t]), 0);
  }
  console.log(`schedule #${s.id} (${s.title}): started run task #${taskId}${r.agent ? ' on agent ' + r.agent.id : ': ' + r.error}`);
  if (r.agent) pluginHost.emit('schedule.run', { schedule: scheduleOut(q.getSchedule.get(s.id) || s), phase: 'started', taskId: Number(taskId), agentId: r.agent.id });
  broadcastSchedules();
  return r;
}

// Due schedules: run them, or skip this time (previous run still going with overlap=skip, or over budget). A full swarm
// (MAX_LIVE) and overlap=queue leave next_run_at alone, so the run is retried on the next tick.
function scheduleTick() {
  const now = Date.now();
  let all;
  try { all = q.allSchedules.all(); } catch (e) { return console.error('schedules:', e); }
  for (const s of all) {
    if (!s.enabled || s.next_run_at == null || s.next_run_at > now) continue;
    try {
      const r = runSchedule(s);
      if (r.full || (r.busy && s.overlap === 'queue')) continue;
      if (r.busy || r.budget) skipRun(s, r.error, r.budget);
      else if (r.unavailable) skipRun(s, r.error, true); // no run task was recorded (its bot could not start): say why
      q.setScheduleNext.run(nextRunOf(s, new Date(now)), s.id);
    } catch (e) {
      console.error(`schedule #${s.id} (${s.title}): run failed:`, e);
      try { skipRun(s, 'internal error: ' + e.message, true); q.setScheduleNext.run(nextRunOf(s, new Date(now)), s.id); } catch {}
    }
    broadcastSchedules();
  }
}

// After runs end: notify as the schedule says, remove old run agents beyond keep_agents, trim the run history.
function scheduledRunsEnded(rows) {
  const sids = new Set(rows.map((t) => t.scheduled_from).filter(Boolean));
  if (!sids.size) return;
  let trimmed = false;
  for (const sid of sids) {
    const s = q.getSchedule.get(sid);
    if (!s) continue;
    for (const { id } of rows.filter((t) => t.scheduled_from === sid)) {
      const t = q.getTask.get(id);
      if (!t || t.status === 'running') continue;
      const failed = t.status === 'failed', alert = /ALERT:[^\n]*/.exec(t.result || '')?.[0];
      pluginHost.emit('schedule.run', { schedule: scheduleOut(s), phase: 'finished', taskId: t.id, agentId: t.agent_id, failed, result: t.result || '' });
      if (s.notify === 'always' || (s.notify === 'failure' && failed) || (s.notify === 'alert' && alert))
        notifySchedule(s, failed ? 'error' : 'done', alert ? 'ALERT' : failed ? 'run failed' : 'run finished', (alert || t.result || '').replace(/\s+/g, ' ').slice(0, 160), t.agent_id);
    }
    const runs = q.schedRuns.all(sid), seen = new Set();
    const runAgents = runs.map((t) => t.agent_id).filter((a) => a && agents.has(a) && !seen.has(a) && seen.add(a));
    for (const id of runAgents.slice(s.keep_agents)) {
      const a = agents.get(id);
      if (a.status === 'running' || a.pendingApprovals().length || q.runningTasks.all(id).length || a.role === 'conductor' || a.bot) continue;
      console.log(`schedule #${sid} (${s.title}): removing old run agent ${id}`);
      removeAgent(a);
    }
    for (const t of runs.slice(RUNS_KEPT)) if (t.status !== 'running') { q.delTask.run(t.id); trimmed = true; }
  }
  if (trimmed) broadcastTasks();
  broadcastSchedules();
  scheduleTick(); // a queued run (overlap=queue) can start now that the previous one ended
}

setInterval(scheduleTick, 30_000).unref();
setTimeout(scheduleTick, 3000).unref(); // runs missed while the server was down: once, shortly after startup

const WORKTREE_COMMIT_NOTE = `You are working in a git worktree on its own branch. Before you finish, commit all your changes on this branch (git add -A && git commit with a clear message) so nothing is left uncommitted.`;

// Start an agent in a fresh `git worktree` under its own tmp dir (new branch off the repo's current branch).
async function spawnAgentInWorktree(body, internal = {}) {
  if (isOneOff(body)) return spawnAgent(body, internal); // rejects oneOff + worktree
  if (!body.worktree) return spawnAgent(body, internal);
  if (body.sessionId) return { code: 400, error: 'a resumed session cannot move into a worktree (its transcript belongs to the original folder)' };
  const parent = body.parentId ? agents.get(body.parentId) : null;
  const repoDir = body.cwd || parent?.cwd;
  if (!repoDir || !fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) return { code: 400, error: repoDir ? `cwd must be an existing directory: ${repoDir}` : 'cwd is required for a worktree' };
  const id = crypto.randomUUID().slice(0, 8);
  let w;
  try {
    w = await gitt.addWorktree({ repoDir, wtPath: path.join(tmpDirFor(id), 'wt'), branch: body.branch ? String(body.branch).trim() : `swarm/${id}` });
  } catch (e) { return { code: typeof e.code === 'number' ? e.code : 500, error: e.message }; }
  const name = body.name || `${path.basename(repoDir)} · ${w.branch}`;
  const prompt = body.prompt && `${body.prompt}\n\n${WORKTREE_COMMIT_NOTE}`;
  const r = spawnAgent({ ...body, prompt, name, cwd: w.cwd, worktree: undefined, branch: undefined }, { ...internal, id, wt: { repo: w.repo, path: w.path, branch: w.branch, base: w.base } });
  if (r.error) { // nothing was started: take the fresh worktree and branch back out (git removes it without force)
    await gitt.removeWorktree(w.path, { deleteBranch: true }).catch(() => {});
    fs.rmSync(tmpDirFor(id), { recursive: true, force: true });
    gitt.pruneWorktrees(w.repo);
  }
  return r;
}

class Agent {
  constructor({ id, cwd, name, account, permissionMode, model, effort, sessionId, startedAt, parentId, startedBy, role, wt, lean, hidden, browser, bot, backend, backendState, notify }) {
    this.id = id || crypto.randomUUID().slice(0, 8);
    this.backend = backend || DEFAULT_BACKEND; // the coding-agent CLI it runs on (backends/)
    this.backendState = backendState ?? null; // the driver's saved state (reattach after a server restart)
    this._driver = null;
    this.cwd = cwd;
    this.name = name || path.basename(cwd) || cwd;
    this.account = account;
    this.role = role || null; // 'conductor' = the swarm chat agent that drives the others
    this.parentId = parentId || null; // set when another agent started this one through the swarm MCP
    this.startedBy = startedBy || null; // 'peer:<name>' when another swarm instance started it (peers.js)
    this.permissionMode = permissionMode;
    this.model = model || null; // --model (alias or full id); null = the CLI default
    this.effort = effort || null; // --effort; null = the CLI default
    this.waiters = [];
    this.status = 'stopped'; // idle | running | stopped | error
    this.events = [];
    this.pid = null; // claude runs detached from this server so it survives restarts
    this.child = null; // only set while this server instance spawned it (gives the exit code)
    this.offset = 0; // bytes of the .out file already turned into events
    this.fifo = path.join(RUNS, this.id + '.in');
    this.outFile = path.join(RUNS, this.id + '.out');
    this.errFile = path.join(RUNS, this.id + '.err'); // stderr of a backend that keeps it apart from its output
    this.mcpFile = path.join(RUNS, this.id + '.mcp.json'); // claude's --mcp-config: a 0600 file, so the token is not in argv (ps)
    this.sessionId = sessionId || null;
    this.startedAt = startedAt || Date.now();
    this.remote = { status: 'off', url: null, error: null }; // off | starting | on | error
    this.remoteProc = null;
    this.todos = []; // latest TodoWrite checklist: [{ content, status: pending|in_progress|completed, activeForm }]
    this.taskSeq = 0;
    this.attention = null; // { kind: done|error|blocked|usage|stuck, at } until the user looks at the agent
    this.wt = wt || null; // { repo, path, branch, base } when started in a worktree
    this.usage = usageByAgent.get(this.id) || emptyUsage();
    this.ut = new UsageTracker(q.lastCum.get(this.id)?.cum_cost ?? 0);
    this.lastEventAt = Date.now();
    this.watchdog = null; // { kind: idle|loop, at, detail } while the agent looks stuck; cleared on activity
    this.lanes = new Map(); // parent_tool_use_id -> { key, count }: consecutive identical tool calls
    this.hidden = !!hidden; // hidden from the sidebar list by the user; the UI shows it again whenever it needs you
    this.browser = browser || null; // name of the browser profile this agent drives (browser.js), or null: no browser
    this.bot = bot || null; // handle of the bot this agent is (bots.js): permanent, with memory files
    this.lean = lean ?? null; // true/false: launch with/without --strict-mcp-config; null: the global default
    this.ctx = 0; // current context size in tokens: the last main-thread API call's input + cache read + cache write
    this.ctxSent = 0; // what the UI was last told
    this.ctxAlerted = false; // pushed about crossing the high threshold in this session
    this.handoff = null; // { phase: asking|resetting, resolve, message, dirty, auto } while a fresh-context-with-handoff runs
    this.pendingHandoff = null; // note written by the previous session, prepended to the next message
    this.peerTail = null; // PeerTail on the session's transcript: messages from other Claude sessions (peer-messages.js)
    this.inbox = []; // lines on their way to claude's stdin: [{ buf, off, pid, retried }] (see writeIn)
    this.inTimer = null; // retry of a write that found the FIFO full
    this.sentAt = 0; // when a message that starts a turn was handed to claude; 0 once claude printed anything after it
    // child -> parent notifications (agent-notify.js, notifyParent below)
    this.notify = notify !== false; // wake the parent when a turn it asked for ends (start_agent notify, default true)
    this.armed = false; // the current turn was asked for by the parent (its prompt, send_message) or follows a notification: notify the parent when it ends
    this.outstanding = 0; // messages handed to the process whose turn hasn't ended yet (a message sent mid-turn is a turn of its own)
    this.waitedBy = new Map(); // agent id -> open wait_for_agent calls on this agent: that wait returns the result, so no notification
    this.blockTimer = null; // fires when the turn has been blocked on the user for a while (NOTIFY_BLOCKED_MS)
    this.blockNotified = false; // the parent was told about the block in this turn
    this.removing = false;
    this.notices = new Map(); // as a parent: child id -> pending notification entry, delivered when this agent's turn ends
    this.wakeTurns = 0; // consecutive turns started by notifications, with no other message in between (loop guard)
    this.wakePaused = false;
  }

  summary() {
    const { id, name, cwd, status, account, permissionMode, model, effort, startedAt, remote, parentId, role, todos, attention, usage } = this;
    const watchdog = this.watchdog && { kind: this.watchdog.kind, at: this.watchdog.at, detail: this.watchdog.detail };
    return { id, name, cwd, status, account, backend: this.backend, permissionMode, model, effort, startedAt, remote, parentId, startedBy: this.startedBy, role, todos, attention, usage, watchdog, worktree: this.wt && { branch: this.wt.branch, base: this.wt.base, path: this.wt.path }, oneOff: this.oneOff,
      context: this.ctx, lean: this.lean, notify: this.notify, browser: this.browser, bot: this.bot && bots.badge(this.bot), hidden: this.hidden, handoff: this.handoff ? this.handoff.phase : this.pendingHandoff ? 'pending' : null, activity: this.activity(), waiting: this.waiting() };
  }

  // what the agent waits on the user for, from the open requests: { questions, approvals } (counts), or null
  waiting() {
    let questions = 0, approvals = 0;
    for (const p of pending.values()) if (p.agent === this) isQuestion(p.req.tool_name) ? questions++ : approvals++;
    return questions || approvals ? { questions, approvals } : null;
  }

  // for the agent list: when it last did something, and what (its current tool call, else its last text or your last prompt)
  activity() {
    const out = { at: 0, tool: null, text: null };
    for (const e of this.events.slice(-80)) {
      out.at = Math.max(out.at, e._ts || 0);
      if (e.parent_tool_use_id) continue; // a sub-agent's step: activity, but not the agent's own line
      if (e.type === 'assistant') for (const c of e.message?.content || []) {
        if (c.type === 'tool_use') { const i = c.input || {}; out.tool = { name: c.name, input: Object.fromEntries(['command', 'file_path', 'pattern', 'url', 'description', 'agent_id'].filter((k) => typeof i[k] === 'string').map((k) => [k, i[k].slice(0, 200)])) }; }
        else if (c.type === 'text' && c.text.trim()) { out.text = c.text.slice(0, 200); out.tool = null; }
      }
      else if (e.type === 'user_prompt' && e.text) { out.text = (e.agentNotify ? 'Notification: ' : e.by && agents.get(e.by) ? agents.get(e.by).name + ': ' : 'You: ') + e.text.slice(0, 200); out.tool = null; }
      else if (e.type === 'peer_message' && e.text) { out.text = (e.fromName || 'Another session') + ': ' + e.text.slice(0, 200); out.tool = null; }
      else if (e.type === 'result' || e.type === 'exit') out.tool = null;
    }
    return out;
  }

  // ---- context size, from the per-message usage of the main thread's API calls (result events sum a whole turn)
  recomputeContext() {
    this.ctx = 0; this.pendingHandoff = null;
    for (const e of this.events) this.observeContext(e);
    this.ctxSent = this.ctx;
    this.ctxAlerted = this.ctx >= contextCfg().high; // already over it before this server started: don't push again
  }

  // true if the context size changed
  observeContext(e) {
    if (e.type === 'context_reset') { this.pendingHandoff = null; const had = this.ctx; this.ctx = 0; this.ctxAlerted = false; return had > 0; }
    if (e.type === 'handoff') { this.pendingHandoff = e.text; return false; }
    if (e.type === 'user_prompt' && !e.handoffAsk) { this.pendingHandoff = null; return false; }
    if (e.type === 'system' && e.subtype === 'compact_boundary' && e.compact_metadata?.post_tokens > 0) { this.ctx = e.compact_metadata.post_tokens; return true; }
    if (e.type === 'system' && e.subtype === 'context' && e.used > 0) { if (e.used === this.ctx) return false; this.ctx = e.used; return true; } // ACP usage_update
    if (e.type !== 'assistant' || e.parent_tool_use_id || !e.message?.usage) return false;
    const u = e.message.usage, t = n0(u.input_tokens) + n0(u.cache_read_input_tokens) + n0(u.cache_creation_input_tokens);
    if (!t || t === this.ctx) return false;
    this.ctx = t;
    return true;
  }

  contextChanged() {
    const cfg = contextCfg();
    if (this.ctx < cfg.warn) this.ctxAlerted = false; // reset or compacted: may warn again later
    else if (this.ctx >= cfg.high && !this.ctxAlerted) {
      this.ctxAlerted = true;
      if (cfg.notifyHigh) notifyAgent(this, 'context', `${Math.round(this.ctx / 1000)}k tokens, re-sent on every turn; consider a fresh context with handoff`);
    }
    if (Math.abs(this.ctx - this.ctxSent) >= 1000 || !this.ctx) { this.ctxSent = this.ctx; broadcast({ type: 'agent', agent: this.summary() }); }
  }

  // ---- fresh context with handoff: the agent writes a note about its work, the session is reset, and the note
  // goes (labelled) in front of the first message of the new session. Resolves { error, code } or { done } where
  // done resolves { ok, note } or { error } when the handoff is over.
  async startHandoff({ message, auto } = {}) {
    const refuse = () => {
      if (this.handoff) return { code: 409, error: 'a handoff is already in progress' };
      if (this.status === 'running') return { code: 409, error: 'agent is busy; refresh its context when it is idle' };
      if (this.pendingApprovals().length) return { code: 409, error: 'agent is waiting for an approval or an answer' };
      if (!this.sessionId) return { code: 400, error: 'nothing to hand off: this agent has no session yet' + (this.pendingHandoff ? ' (its last handoff note is still waiting for the next message)' : '') };
      if (!this.pid && !fs.existsSync(this.cwd)) return { code: 400, error: `folder ${this.cwd} no longer exists` };
      return null;
    };
    let r = refuse();
    if (r) return r;
    const dirty = this.wt ? await gitt.worktreeRisk(this.wt.path).catch(() => null) : null;
    if ((r = refuse())) return r;
    let resolve;
    const done = new Promise((res) => { resolve = res; });
    this.send((this.bot ? bots.handoffAsk(bots.dirOf(this.bot)) : HANDOFF_ASK) + (dirty?.dirty ? `\n\nThe worktree has ${dirty.dirty} uncommitted or untracked file(s) on branch ${dirty.branch}; say so in the note.` : ''), { handoffAsk: true });
    if (this.status !== 'running') return { code: 500, error: 'could not start the handoff turn' };
    this.handoff = { phase: 'asking', resolve, message: message || null, dirty, auto: !!auto, from: this.ctx, timer: setTimeout(() => this.failHandoff('no note after 20 minutes'), 20 * 60_000) };
    broadcast({ type: 'agent', agent: this.summary() });
    return { done };
  }

  failHandoff(why) {
    const h = this.handoff;
    if (!h) return;
    clearTimeout(h.timer);
    this.handoff = null;
    this.push({ type: 'note', text: `Fresh context with handoff failed (${why}); the context was kept` });
    broadcast({ type: 'agent', agent: this.summary() });
    h.resolve({ error: `handoff failed: ${why}; the context was kept` });
    if (h.message) this.send(h.message);
  }

  finishHandoff(ev) {
    const h = this.handoff;
    if (!h) return;
    let note = String(ev.result ?? '').trim();
    if (ev.is_error || note.length < 40) return this.failHandoff(ev.is_error ? 'the handoff turn ended with an error' : 'the agent wrote no usable note');
    if (this.status === 'running') return this.failHandoff('the agent got another message meanwhile');
    clearTimeout(h.timer);
    if (h.dirty?.dirty) note += `\n\n(Swarm: when this note was written, the worktree had ${h.dirty.dirty} uncommitted or untracked file(s) on branch ${h.dirty.branch}.)`;
    this.handoff = null;
    this.resetContext({ handoff: note, auto: h.auto, from: h.from });
    h.resolve({ ok: true, note });
    if (h.message) this.send(h.message);
  }

  // fresh context: the next message starts a new Claude session (the chat above stays for reference)
  resetContext({ handoff, auto, from } = {}) {
    this.killProc();
    this.sessionId = null;
    q.setSession.run(null, this.id);
    this.push(handoff ? { type: 'context_reset', handoff: true, auto: auto || undefined, from } : { type: 'context_reset' });
    if (handoff) this.push({ type: 'handoff', text: handoff });
    broadcast({ type: 'agent', agent: this.summary() });
  }

  recomputeTodos() {
    this.todos = []; this.taskSeq = 0;
    for (const e of this.events) this.observeTodos(e);
  }

  // true if the checklist changed. Older Claude Code sends the whole list with TodoWrite; newer versions
  // build it with TaskCreate (ids count up from 1) and TaskUpdate (status changes, 'deleted' removes).
  observeTodos(e) {
    if (e.type === 'context_reset') { const had = this.todos.length > 0; this.todos = []; this.taskSeq = 0; return had; }
    if (e.type !== 'assistant' || e.parent_tool_use_id) return false;
    let changed = false;
    for (const c of e.message?.content || []) {
      if (c.type !== 'tool_use') continue;
      const i = c.input || {};
      if (c.name === 'TodoWrite' && Array.isArray(i.todos)) {
        this.todos = i.todos.map((x) => ({ content: String(x.content ?? x.subject ?? ''), status: x.status || 'pending', activeForm: x.activeForm || '' }));
        changed = true;
      } else if (c.name === 'TaskCreate') {
        this.todos.push({ id: String(++this.taskSeq), content: String(i.subject ?? ''), status: 'pending', activeForm: i.activeForm || '' });
        changed = true;
      } else if (c.name === 'TaskUpdate') {
        const t = this.todos.find((x) => x.id === String(i.taskId));
        if (!t) continue;
        if (i.status === 'deleted') this.todos = this.todos.filter((x) => x !== t);
        else {
          if (i.status) t.status = i.status;
          if (i.subject) t.content = i.subject;
          if (i.activeForm) t.activeForm = i.activeForm;
        }
        changed = true;
      }
    }
    return changed;
  }

  // reacts to events as they happen: checklist, notifications, backlog tasks
  observe(e, eventId) {
    if (this.observeTodos(e)) broadcast({ type: 'agent', agent: this.summary() });
    if (this.observeContext(e)) this.contextChanged();
    this.watch(e);
    this.ut.observe(e);
    if (e.type === 'result') {
      const row = this.ut.result(e);
      if (row) this.recordUsage(row, eventId);
    }
    if (e.type === 'assistant' && e.error === 'authentication_failed') this.authFailed = true;
    if (e.type === 'permission_request' && isQuestion(e.tool_name)) notifyAgent(this, 'blocked', questionsOf(e.input).map((x) => x.question).join(' · ').replace(/\s+/g, ' ').slice(0, 160), { label: 'has a question' });
    else if (e.type === 'permission_request') notifyAgent(this, 'blocked', `${e.rule || e.tool_name}${e.input ? ' · ' + previewInput(e.input).replace(/\s+/g, ' ').slice(0, 120) : ''}`);
    if (e.type === 'permission_request') this.watchBlocked();
    if (e.type === 'result') this.turnEnded(e.subtype === 'cancelled' || (e.is_error && this.stopRequested) ? 'stopped' : e.is_error ? 'error' : 'finished', e.result); // ACP: cancelled
    if (e.type === 'result') {
      const scheduled = taskTurnEnded(this, e); // a scheduled run is pushed (or not) by its schedule's notify setting
      let detail = String(e.result ?? '').replace(/\s+/g, ' ').slice(0, 160);
      if (e.is_error && this.backend === DEFAULT_BACKEND && (this.authFailed || AUTH_FAIL.test(detail))) {
        detail = `Account ${this.account} is logged out, so this agent couldn't run. Log in again (Settings → Accounts) and retry.`;
        markLoggedOut(accountOr(this.account));
        this.push({ type: 'stderr', text: detail });
      }
      this.authFailed = false;
      if (!this.handoff) notifyAgent(this, e.is_error ? 'error' : 'done', detail, { push: !scheduled });
    }
  }

  static create(opts) {
    const a = new Agent(opts);
    q.insAgent.run({
      id: a.id, name: a.name, cwd: a.cwd, account: a.account, permission_mode: a.permissionMode,
      model: a.model ?? null, session_id: a.sessionId, created_at: a.startedAt, parent_id: a.parentId, role: a.role,
      wt: a.wt ? JSON.stringify(a.wt) : null,
    });
    if (a.lean !== null) q.setLean.run(a.lean ? 1 : 0, a.id);
    if (!a.notify) q.setNotify.run(0, a.id);
    if (a.startedBy) q.setStartedBy.run(a.startedBy, a.id);
    if (a.browser) q.setBrowser.run(a.browser, a.id);
    if (a.bot) q.setBot.run(a.bot, a.id);
    if (a.effort) q.setModel.run(a.model, a.effort, a.id);
    if (a.backend !== DEFAULT_BACKEND) q.setBackend.run(a.backend, a.id);
    return a;
  }

  push(event) {
    event._ts = Date.now();
    this.events.push(event);
    const eventId = recordEvent(this.id, event, event._ts);
    this.lastEventAt = event._ts;
    broadcast({ type: 'event', agentId: this.id, i: this.events.length - 1, event: slimEvent(event) });
    pluginHost.emit('agent.event', { agentId: this.id, event: slimEvent(event) });
    this.observe(event, eventId);
  }

  recordUsage(row, eventId) {
    const ts = Date.now();
    q.insUsage.run({ ...row, event_id: eventId, agent_id: this.id, account: this.account, ts, day: dayOf(ts) });
    const u = this.usage;
    u.turns++; u.input += row.input; u.output += row.output; u.cacheRead += row.cache_read; u.cacheCreate += row.cache_create;
    if (row.cost == null) u.noCost++; else u.cost += row.cost;
    usageByAgent.set(this.id, u);
    checkUsageAlerts(this);
  }

  // ---- watchdog: flags an agent that stops producing events or repeats the same tool call. Never interrupts.
  flagStuck(kind, detail, key) {
    if (this.watchdog) return; // one incident at a time, notified once
    this.watchdog = { kind, at: Date.now(), detail, key };
    notifyAgent(this, 'stuck', detail);
  }

  clearStuck() {
    if (!this.watchdog) return;
    this.watchdog = null;
    broadcast({ type: 'agent', agent: this.summary() });
  }

  watch(e) {
    if (e.type === 'result' || e.type === 'exit' || e.type === 'user_prompt' || e.type === 'peer_message' || e.type === 'context_reset') { this.lanes.clear(); this.clearStuck(); return; }
    if (this.watchdog?.kind === 'idle') this.clearStuck(); // it produced something after all
    if (e.type !== 'assistant') return;
    const cfg = watchdogCfg();
    for (const c of e.message?.content || []) {
      if (c.type !== 'tool_use') continue;
      const lane = e.parent_tool_use_id || '', key = c.name + ' ' + stableJson(c.input);
      const prev = this.lanes.get(lane);
      const cur = prev?.key === key ? { key, count: prev.count + 1 } : { key, count: 1 };
      this.lanes.set(lane, cur);
      if (this.watchdog?.kind === 'loop' && this.watchdog.lane === lane && this.watchdog.key !== key) this.clearStuck();
      if (cfg.enabled && cur.count >= cfg.repeatCount) {
        this.flagStuck('loop', `${c.name} called ${cur.count}× in a row with the same input: ${previewInput(c.input).replace(/\s+/g, ' ').slice(0, 100)}`, key);
        if (this.watchdog?.key === key) { this.watchdog.lane = lane; this.watchdog.count = cur.count; }
      }
    }
  }

  // name of the main-thread tool call of the current turn still waiting for its result, or null
  toolInProgress() {
    const done = new Set();
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.type === 'result' || e.type === 'user_prompt' || e.type === 'exit') return null;
      if (e.parent_tool_use_id || !Array.isArray(e.message?.content)) continue;
      for (const c of e.message.content) {
        if (e.type === 'user' && c.type === 'tool_result') done.add(c.tool_use_id);
        else if (e.type === 'assistant' && c.type === 'tool_use' && !done.has(c.id)) return c.name;
      }
    }
    return null;
  }

  setStatus(status) {
    const was = this.status;
    this.status = status;
    broadcast({ type: 'agent', agent: this.summary() });
    if (was !== status) pluginHost.emit('agent.status', { agent: this.summary(), status, was });
    if (status !== 'running') for (const w of this.waiters.splice(0)) w();
    if (status !== 'running' && this.notices.size) setImmediate(() => this.flushNotices()); // not mid-drain: it may start a turn
    if (status !== 'running' && this.browser) browser.agentIdle(this.id); // its turn is over: free the browser's driver seat
  }

  // approvals and questions this agent is currently blocked on: [{ text, question }], text being what the user is asked
  pendingApprovals() {
    const open = new Map();
    for (const e of this.events) {
      if (e.type === 'permission_request') open.set(e.reqId, { text: pendingText(e.tool_name, e.input, e.rule), question: isQuestion(e.tool_name) });
      if (e.type === 'permission_resolved') open.delete(e.reqId);
    }
    return [...open.values()];
  }

  // resolves when the current turn is over (or after timeout seconds), for the swarm MCP's wait tools
  // by: the id of the agent waiting (its swarm token). Its wait returns this turn's result, so the turn doesn't notify it,
  // and a notification about this agent already pending for it is dropped (the wait consumed it).
  waitIdle(seconds, by) {
    if (by) this.waitedBy.set(by, (this.waitedBy.get(by) || 0) + 1);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        if (by) {
          const n = this.waitedBy.get(by) - 1;
          n > 0 ? this.waitedBy.set(by, n) : this.waitedBy.delete(by);
          if (this.status !== 'running') this.noticeSeen(by);
        }
        resolve({ status: this.status, result: this.events.findLast((e) => e.type === 'result')?.result ?? null, pending: this.pendingApprovals() }); };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== done); done(); }, seconds * 1000);
      if (this.status !== 'running') return done();
      this.waiters.push(done);
    });
  }

  // ---- child -> parent notifications (agent-notify.js). Delivery reuses send(): the parent gets a user turn marked
  // agentNotify, which the UI shows as a notification. Pending ones live in the parent's memory only: a server restart
  // drops them (the child's result stays readable with read_agent), while an armed child turn that is still running
  // across the restart is re-armed from its events and notifies when it ends.
  parentToTell() {
    if (!this.notify || !this.armed || this.removing || !this.parentId) return null;
    const p = agents.get(this.parentId);
    if (!p || p.removing || p.status === 'stopped' || p.status === 'error') return null; // gone or not running: dropped
    if (this.waitedBy.has(p.id)) return null; // blocked in wait_for_agent on this agent: the wait returns it
    return p;
  }

  // a turn ended (result, or its process died mid-turn): outcome finished | error | stopped
  turnEnded(outcome, result) {
    clearTimeout(this.blockTimer); this.blockTimer = null;
    if (this.handoff) return; // the handoff note's own turn
    this.outstanding = Math.max(0, this.outstanding - 1);
    const p = this.parentToTell();
    if (p) p.queueNotice({ childId: this.id, name: this.name, outcome, result: result ?? null });
    if (!this.outstanding || outcome === 'stopped') { this.armed = false; this.outstanding = 0; }
    this.blockNotified = false;
  }

  // an approval or a question in an armed turn: if it is still open after NOTIFY_BLOCKED_MS, tell the parent once
  watchBlocked() {
    if (this.blockTimer || this.blockNotified || !this.armed || !this.notify || !this.parentId) return;
    this.blockTimer = setTimeout(() => {
      this.blockTimer = null;
      if (!this.waiting() || this.blockNotified || this.status !== 'running') return;
      const p = this.parentToTell();
      if (!p) return;
      this.blockNotified = true;
      p.queueNotice({ childId: this.id, name: this.name, outcome: 'blocked', blocked: this.pendingApprovals() });
    }, NOTIFY_BLOCKED_MS);
    this.blockTimer.unref?.();
  }

  // the agent `by` read this agent's finished turn itself (wait_for_agent, read_agent): a pending notice of it is stale
  noticeSeen(by) {
    if (by === this.parentId) agents.get(by)?.notices.delete(this.id);
  }

  // as a parent: hold the entry, delivered now if idle, else when the current turn ends (coalesced)
  queueNotice(entry) {
    mergeNotice(this.notices, entry);
    if (this.status !== 'running') setImmediate(() => this.flushNotices()); // after the child's result is fully handled
  }

  flushNotices() {
    if (!this.notices.size || this.status === 'running' || this.handoff || this.inbox.length || this.queuedTexts?.length) return;
    if (this.removing || !agents.has(this.id) || this.status === 'stopped' || this.status === 'error') { this.notices.clear(); return; }
    if (this.wakeTurns >= MAX_WAKE_TURNS) { // loop guard: wait for a message from the user (or the parent) first
      if (!this.wakePaused) {
        this.wakePaused = true;
        this.push({ type: 'note', text: `Agent notifications paused after ${this.wakeTurns} automatic wake-ups in a row; ${this.notices.size} pending. They are delivered after the next message.` });
      }
      return;
    }
    const entries = [...this.notices.values()];
    this.notices.clear();
    this.send(noticeText(entries), { agentNotify: entries.map((e) => e.childId) }); // a paused bot drops it (send says so)
  }

  get be() { return backendOf(this.backend) || backendOf(DEFAULT_BACKEND); }
  // the protocol state of the current process (created with it, restored from backendState after a server restart)
  get driver() { return this._driver || (this._driver = this.be.driver(this, this.backendState)); }

  // what the swarm wants from this agent's process, whatever CLI runs it; the backend turns it into argv and env
  launchSpec(env) {
    const builtinSubagents = !!agentDefaults().builtinSubagents;
    return {
      cwd: this.cwd, permissionMode: this.permissionMode, model: this.model, effort: this.effort, sessionId: this.sessionId, role: this.role, env,
      // a session resumed from History that never finished a turn here was started outside the swarm: CLIs that take
      // the swarm's instructions with a session's first message (preamble) get them with the next one
      instructionsOnLoad: !!this.sessionId && !this.events.some((e) => e.type === 'result'),
      systemPrompt: systemPrompt(this.be, {
        role: this.role, builtinSubagents, permissionMode: this.permissionMode, tmpDir: tmpDirFor(this.id),
        conductor: this.role === 'conductor' ? conductorPrompt() : '', bot: this.bot && bots.promptFor(this.bot), rooms: rooms.promptFor(this.id), browser: this.browser && browser.prompt(this.browser),
      }),
      autoAllowTools: SWARM_TOOLS, // the swarm MCP server's own tools: bounded server-side, never prompted for
      noSubagents: this.role === 'conductor' || !builtinSubagents, // delegation through swarm agents only
      bot: this.bot ? { allowRules: bots.allowRules(this.bot) } : null,
      lean: !!(this.lean ?? contextCfg().leanDefault),
      mcpServers: {
        swarm: {
          command: process.execPath,
          args: [path.join(ROOT, 'src', 'swarm-mcp.js')],
          // approve is claude's --permission-prompt-tool: other CLIs ask through ACP and must not see it (Cursor's model
          // called it to put a question to the user); HALAY_BACKEND words the tool descriptions for that CLI; ask_user
          // and submit_plan only for CLIs without their own (prompts.js)
          env: { HALAY_URL: `http://127.0.0.1:${PORT}`, HALAY_TOKEN: auth.agentToken(this.id), HALAY_AGENT: this.id, HALAY_ROLE: this.role || '', ...(this.be.id !== 'claude' && { HALAY_NO_APPROVE: '1', HALAY_BACKEND: this.be.id, HALAY_ASK_TOOL: swarmAsks(this.be) ? '1' : '0' }), ...(!builtinSubagents && { HALAY_NO_BUILTIN: '1' }), ...(swarmPlans(this.be, this.permissionMode) && { HALAY_PLAN_TOOL: '1' }) },
        },
        ...(this.browser ? { browser: browser.mcpServer(this.browser, this.id, path.join(tmpDirFor(this.id), 'browser')) } : {}), // opt-in: lean agents stay lean
      },
      autoCompactWindow: contextCfg().autoCompactWindow,
      mcpConfigFile: this.mcpFile, // where a CLI that takes its MCP servers on the command line gets them from instead
    };
  }

  start() {
    const acct = accountOr(this.account, this.backend);
    const tmp = tmpDirFor(this.id);
    const spec = this.launchSpec({ ...accountEnv(acct), TMPDIR: tmp, TMP: tmp, TEMP: tmp });
    const { cmd, args, env, stderr } = this.be.launch(spec);
    this._driver = this.be.driver(this, null, spec); this.backendState = null; // a new process starts a new protocol conversation
    this.ut.newProcess(); // total_cost_usd restarts from zero with a new claude process
    fs.mkdirSync(tmp, { recursive: true });
    fs.rmSync(this.fifo, { force: true });
    execFileSync('mkfifo', [this.fifo]);
    fs.writeFileSync(this.outFile, '');
    // stdin is the FIFO opened read-write, so claude never sees EOF while we're between server runs
    const inFd = fs.openSync(this.fifo, fs.constants.O_RDWR);
    const outFd = fs.openSync(this.outFile, 'a');
    // a protocol on stdout (ACP) must not get log lines mixed into it: stderr goes to its own file then
    const errFd = stderr === 'separate' ? fs.openSync(this.errFile, 'w') : outFd;
    const child = spawn(cmd, args, {
      cwd: this.cwd,
      env,
      stdio: [inFd, outFd, errFd],
      detached: true,
    });
    fs.closeSync(inFd);
    fs.closeSync(outFd);
    if (errFd !== outFd) fs.closeSync(errFd);
    child.on('error', () => {}); // a failed spawn is handled below via the missing pid
    if (!child.pid) {
      this.push({ type: 'stderr', text: `failed to start ${cmd} (is it on PATH?)` });
      this.setStatus('error');
      notifyAgent(this, 'error', `failed to start ${cmd}`);
      return false;
    }
    child.unref();
    this.child = child;
    this.pid = child.pid;
    this.offset = 0;
    q.setProc.run(this.pid, 0, this.id);
    child.on('exit', (code) => this.onExit(code, child.pid));
    for (const line of this.driver.started()) this.writeIn(line);
    pluginHost.emit('agent.started', { agent: this.summary(), pid: this.pid });
    return true;
  }

  // Turn whatever claude has written since last time into events. Safe to call any time.
  drain(final = false) {
    let fd;
    try { fd = fs.openSync(this.outFile, 'r'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      // in chunks, so a big unread tail is never one huge buffer; a chunk grows only for a single line longer than it
      let want = DRAIN_CHUNK;
      while (this.offset < size) {
        const left = size - this.offset, buf = Buffer.alloc(Math.min(left, want));
        fs.readSync(fd, buf, 0, buf.length, this.offset);
        const tail = buf.length === left;
        const end = final && tail ? buf.length : buf.lastIndexOf(10) + 1; // only complete lines, unless the process is gone
        if (end <= 0) { if (tail) return; want *= 2; continue; }
        want = DRAIN_CHUNK;
        db.transaction(() => {
          // one bad line must not undo the rest: the offset always moves past it, so the poll never replays it
          for (const line of buf.toString('utf8', 0, end).split('\n')) {
            try { this.onLine(line.trim()); } catch (e) { console.error(`agent ${this.id}: handling an output line failed:`, e); }
          }
          this.offset += end;
          q.setOffset.run(this.offset, this.id);
          this.saveDriverState();
        })();
      }
    } finally { fs.closeSync(fd); }
  }

  // the last lines a backend with its own stderr file wrote there (shown when its process failed)
  stderrTail() {
    let t = '';
    try { t = readTail(this.errFile, 4000).trim(); } catch {}
    if (t) this.push({ type: 'stderr', text: t.split('\n').slice(-15).join('\n') });
  }

  // the swarm's own answer to a permission request, before the user is asked (backends that route every request
  // through the swarm, i.e. ACP): 'allow', 'deny' or null (ask the user). Claude applies these through its own flags.
  // paths: every file the call names (ACP: its locations, diffs and path arguments); acceptEdits allows an edit only when
  // all of them are inside the agent's folder or its tmp dir, like Claude Code's own acceptEdits
  autoDecision(toolName, input, kind, paths) {
    const tool = String(toolName || '');
    const m = tool.match(/^(?:mcp__)?swarm[_.:-]+(?:mcp[_.:-]+)?([a-z_]+)$/i);
    if (m && (SWARM_TOOLS.includes(m[1]) || m[1] === 'ask_user' || m[1] === 'submit_plan' || pluginHost.autoAllowed(m[1], roleOf(this)))) return 'allow'; // ask_user, submit_plan: their card is the question
    // built-in subagents (Claude's Task/Agent, OpenCode's task, Gemini's agents) when they are off: swarm agents instead
    if ((this.role === 'conductor' || !agentDefaults().builtinSubagents) && /^(task|agent|subagent|codebase_investigator|cli_help|generalist)$/i.test(tool)) return 'deny';
    if (this.bot && bots.allowRules(this.bot).some((r) => ruleMatches(r, tool, input))) return 'allow'; // its memory files
    if (this.permissionMode === 'bypassPermissions') return 'allow';
    if (this.permissionMode === 'acceptEdits' && (kind === 'edit' || /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) && this.editsInside(paths ?? [input?.file_path, input?.notebook_path])) return 'allow';
    return null;
  }

  // are all these paths (relative ones from the agent's folder) inside its folder or tmp dir, symlinks resolved? false for none
  editsInside(paths) {
    const list = [].concat(paths || []).filter((p) => typeof p === 'string' && p && !p.includes('\0'));
    if (!list.length) return false;
    const realish = (p) => { // the real path of p, or of its nearest existing parent with the rest appended (a new file)
      let rest = '';
      for (let d = p; ; d = path.dirname(d)) {
        try { return path.join(fs.realpathSync(d), rest); } catch {}
        if (path.dirname(d) === d) return p;
        rest = path.join(path.basename(d), rest);
      }
    };
    const roots = [this.cwd, tmpDirFor(this.id)].map((r) => realish(path.resolve(r)));
    return list.every((p) => { const rp = realish(path.resolve(this.cwd, p)); return roots.some((r) => rp === r || rp.startsWith(r + path.sep)); });
  }

  // another CLI for this agent (its account moved to one): takes effect with its next process
  setBackend(backend) {
    if (!BACKENDS[backend] || backend === this.backend) return;
    this.killProc();
    this.backend = backend; this._driver = null; this.backendState = null;
    q.setBackend.run(backend, this.id); q.setBackendState.run(null, this.id);
    broadcast({ type: 'agent', agent: this.summary() });
  }

  // the driver's state goes to the DB with the output offset, so a restarted server resumes the protocol where it was
  saveDriverState() {
    const st = this._driver ? this._driver.state() : null;
    const json = st == null ? null : JSON.stringify(st);
    if (json !== this.backendState) { this.backendState = json; q.setBackendState.run(json, this.id); }
  }

  onLine(line) {
    if (!line) return;
    for (const ev of this.driver.onLine(line)) this.onEvent(ev);
  }

  onEvent(ev) {
    this.sentAt = 0;
    if (ev.session_id && ev.session_id !== this.sessionId) {
      this.sessionId = ev.session_id;
      q.setSession.run(ev.session_id, this.id);
    }
    if (PEER_SCAN_TYPES.has(ev.type)) this.scanPeers();
    if (ev.type === 'assistant') ev = withPeerNames(ev, this.events);
    this.push(ev);
    if (ev.type === 'result') {
      this.setStatus('idle'); // after the push, so waiters can read the result
      if (this.handoff?.phase === 'asking') { this.handoff.phase = 'resetting'; setImmediate(() => this.finishHandoff(ev)); } // not mid-drain: it ends the process
      else if (this.wt) this.noteDirtyWorktree();
    }
  }

  // Messages other Claude sessions sent this one reach the CLI directly, and its output has no text for them: read
  // them from the transcript (peer-messages.js) before the event that follows them, so they land in order in the chat.
  scanPeers() {
    if (this.backend !== 'claude' || !this.sessionId) return;
    const acct = accountOr(this.account);
    const file = path.join(configDirOf(acct), 'projects', path.resolve(this.cwd).replace(/[^a-zA-Z0-9]/g, '-'), this.sessionId + '.jsonl');
    if (this.peerTail?.file !== file) this.peerTail = new PeerTail(file, { since: this.lastEventAt - 2000 });
    let found;
    try { found = this.peerTail.read(); } catch (e) { console.error(`peer messages of ${this.id}: ${e.message}`); return; }
    if (!found.length) return;
    const seen = new Set(this.events.filter((e) => e.type === 'peer_message' && e.msgId).map((e) => e.msgId));
    for (const p of found) {
      if (p.msgId && seen.has(p.msgId)) continue;
      seen.add(p.msgId);
      if (!p.queued && this.status === 'idle') { // it starts a turn of its own (the CLI does, not us): show it running
        this.outstanding = 0; this.armed = false; this.blockNotified = false; this.stopRequested = false;
        this.outstanding++;
        this.setStatus('running');
      }
      this.push(peerEvent(p));
    }
  }

  // a worktree agent should commit its work; say so in the chat when it ended a turn with changes left over (never commits for it)
  noteDirtyWorktree() {
    gitt.worktreeRisk(this.wt.path).then((risk) => {
      if (risk?.dirty && this.status === 'idle') this.push({ type: 'note', text: `${risk.dirty} uncommitted or untracked file(s) remain in the worktree (branch ${risk.branch}); ask the agent to commit them` });
    }).catch(() => {});
  }

  onExit(code, pid) {
    if (!this.pid || this.pid !== pid) return; // already handled, or a newer process owns this agent
    this.drain(true);
    if (code) this.stderrTail();
    this.pid = null; this.child = null;
    q.setProc.run(null, this.offset, this.id);
    this.queuedTexts = this._driver?.unsent ? this._driver.unsent() : []; // messages a protocol driver held back: they go to the next process
    this._driver = null; this.saveDriverState(); // its protocol state ended with the process
    this.denyPending('agent process exited');
    if (this.handoff?.phase === 'asking') this.failHandoff('the agent process exited');
    if (this.status !== 'error') this.setStatus('stopped');
    this.push({ type: 'exit', code });
    pluginHost.emit('agent.exited', { agent: this.summary(), code });
    if (this.inbox.length || this.queuedTexts.length) { setImmediate(() => this.redeliver()); return; } // its turn never started: it goes to a new process
    if (this.outstanding) this.turnEnded('stopped', null); // it died mid-turn
    this.sentAt = 0;
    // a task whose agent died mid-turn can never finish: fail it so its dependents block instead of waiting forever
    const lost = q.runningTasks.all(this.id);
    for (const t of lost) q.updTask.run({ ...t, status: 'failed', result: `agent process exited${code != null ? ' (' + code + ')' : ''} before finishing`, now: Date.now() });
    if (lost.length) { broadcastTasks(); setTimeout(() => scheduledRunsEnded(lost), 0); }
    for (const t of lost) pluginHost.emit('task.finished', { task: taskOut(q.getTask.get(t.id)) });
  }

  // true when the message was delivered or is held for delivery (handoff); false when it never will be, with the reason in sendError
  send(text, meta) {
    const fail = (why) => { this.sendError = why; return false; };
    if (this.bot && bots.isPaused(this.bot)) { this.push({ type: 'note', text: 'Bot is paused: this message was not delivered' }); return fail(`bot @${this.bot} is paused`); }
    if (this.handoff) { // the session is about to be replaced: hold the message for the new one
      this.handoff.message = this.handoff.message ? this.handoff.message + '\n\n' + text : text;
      this.push({ type: 'note', text: 'Message held until the handoff note is written; it starts the fresh context' });
      return true;
    }
    if (!this.pid && !fs.existsSync(this.cwd)) { this.push({ type: 'stderr', text: `folder ${this.cwd} no longer exists (was its worktree removed?)` }); return fail(`folder ${this.cwd} no longer exists`); }
    if (!this.pid && !this.start()) return fail('failed to start claude'); // revive a stopped agent, resuming its session
    this.attention = null;
    let wire = text;
    if (this.pendingHandoff && !meta?.handoffAsk) { wire = handoffSeed(this.pendingHandoff) + text; meta = { ...meta, withHandoff: true }; }
    if (this.status !== 'running') this.sentAt = Date.now(); // starts a turn (mid-turn, claude reads it but prints nothing for it yet)
    // notifications: a turn asked for by the parent (or following a notification) tells the parent when it ends; a turn the
    // user started in this agent's own chat does not (the user is already there)
    const fromParent = !!meta?.agentNotify || (!!meta?.by && meta.by === this.parentId);
    if (this.status !== 'running') { this.outstanding = 0; this.armed = false; this.blockNotified = false; this.stopRequested = false; }
    this.outstanding++;
    if (fromParent) this.armed = true;
    if (meta?.agentNotify) this.wakeTurns++;
    else if (!meta?.handoffAsk) { this.wakeTurns = 0; this.wakePaused = false; }
    this.push({ type: 'user_prompt', text, ...meta });
    this.setStatus('running');
    const line = this.driver.encode(wire, meta);
    if (line) this.writeIn(line, wire);
    return true;
  }

  // ---- claude's stdin: the FIFO, written non-blocking and in order. A blocking write must not be used: on macOS a
  // blocking write bigger than the FIFO's buffer (8 KB) never wakes a kqueue-driven reader such as claude, so a long
  // message (a room turn with its recent messages) hung forever with the agent shown running, and it held a libuv
  // threadpool thread until the process died (then EPIPE). Non-blocking, the kernel takes what fits and we retry the rest.
  writeIn(line, text) {
    this.inbox.push({ buf: Buffer.from(line), off: 0, pid: this.pid, retried: false, text });
    if (this.inbox.length === 1) this.pumpIn();
  }

  pumpIn() {
    clearTimeout(this.inTimer);
    this.inTimer = null;
    while (this.inbox.length) {
      const job = this.inbox[0];
      if (!this.pid || job.pid !== this.pid) return this.redeliver(); // its process is gone
      let fd;
      try {
        fd = fs.openSync(this.fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK); // ENXIO when nothing reads the FIFO
        while (job.off < job.buf.length) job.off += fs.writeSync(fd, job.buf, job.off);
      } catch (e) {
        if (e.code === 'EAGAIN') { this.inTimer = setTimeout(() => this.pumpIn(), 50); return; } // full: claude reads it soon
        return this.inputLost(e);
      } finally { if (fd !== undefined) fs.closeSync(fd); }
      this.inbox.shift();
    }
  }

  // claude can't read its stdin any more (ENXIO/EPIPE: the process died or closed it): end that process; onExit then
  // delivers what was waiting to a fresh one, so the agent never stays "running" on a dead pipe
  inputLost(err) {
    this.push({ type: 'stderr', text: 'could not write to agent: ' + err.message + (this.pid ? '; restarting its claude process' : '') });
    if (!this.pid) return this.redeliver();
    const pid = this.pid;
    this.signal('SIGTERM');
    this.onExit(null, pid);
  }

  // messages whose process died before reading them go to a new process (resuming the session), once
  redeliver() {
    clearTimeout(this.inTimer);
    this.inTimer = null;
    const jobs = this.inbox.splice(0);
    const queued = this.queuedTexts || [];
    this.queuedTexts = null;
    if (!jobs.length && !queued.length) return;
    const fail = (why) => {
      this.sentAt = 0;
      this.push({ type: 'stderr', text: `message not delivered: ${why}` });
      this.setStatus('error');
      notifyAgent(this, 'error', `message not delivered: ${why}`);
    };
    if (jobs.some((j) => j.retried)) return fail('the claude process went away twice before reading it');
    if (!this.pid && !fs.existsSync(this.cwd)) return fail(`folder ${this.cwd} no longer exists`);
    if (!this.pid && !this.start()) return; // start() reported it
    this.push({ type: 'note', text: `The ${this.be.bin} process was gone before it read the message; ${jobs.length > 1 ? 'the messages were' : 'it was'} delivered to a new one` });
    this.setStatus('running');
    this.sentAt = Date.now();
    if (this.be.reencodeOnRedeliver) { // protocol lines of the old process mean nothing to the new one: send the messages again
      for (const t of [...jobs.filter((j) => j.text).map((j) => j.text), ...queued]) { const l = this.driver.encode(t); if (l) this.writeIn(l, t); }
      for (const j of this.inbox) j.retried = true;
      return;
    }
    this.inbox = jobs.map((j) => ({ ...j, off: 0, pid: this.pid, retried: true }));
    this.pumpIn();
  }

  // stop delivering (interrupt, kill): what hasn't reached claude yet is dropped
  dropInput() {
    clearTimeout(this.inTimer);
    this.inTimer = null;
    if (this.inbox.length) this.push({ type: 'note', text: `${this.inbox.length} message(s) not yet read by ${this.be.bin} were dropped` });
    this.inbox = [];
    this._driver?.drop?.(); // and what a protocol driver still holds back
  }

  signal(sig) {
    try { process.kill(this.pid, sig); } catch {}
  }

  // Returns a promise for claude's permission-prompt-tool decision; settled from the UI.
  requestPermission({ tool_name, input, tool_use_id }, signal) {
    const reqId = crypto.randomUUID().slice(0, 8);
    const rule = isQuestion(tool_name) ? { text: null } : permissionRule(tool_name, input); // nothing to "always allow" for a question
    return new Promise((resolve) => {
      pending.set(reqId, { agent: this, resolve, req: { tool_name, rule: rule.text, preview: previewInput(input), at: Date.now(), ...(isQuestion(tool_name) && { title: input?.title, questions: questionsOf(input) }) } });
      this.push({ type: 'permission_request', reqId, tool_name, input, tool_use_id, rule: rule.text });
      broadcastApprovals();
      signal?.on('close', () => this.resolvePermission(reqId, 'deny', 'request cancelled'));
    });
  }

  // decision: allow | always | deny, or answer (with answers) for a question. Returns true, false (no such request) or
  // { error } when the decision doesn't fit the request (a question can only be answered or declined).
  resolvePermission(reqId, decision, message, answers) {
    const p = pending.get(reqId);
    if (!p || p.agent !== this) return false;
    const ev = this.events.findLast((e) => e.type === 'permission_request' && e.reqId === reqId);
    let given = null;
    if (isQuestion(p.req.tool_name) && decision !== 'deny') {
      if (decision !== 'answer') return { error: 'this is a question: answer it (decision "answer" with answers) or decline it (decision "deny")' };
      const r = questionAnswers(ev?.input, answers);
      if (r.error) return r;
      given = r.answers;
    } else if (decision === 'answer') return { error: 'decision must be allow, always or deny' };
    pending.delete(reqId);
    const allowed = decision === 'allow' || decision === 'always' || decision === 'answer';
    const denied = isQuestion(p.req.tool_name) && !message ? 'The user declined to answer the questions.' : message || 'Denied by user';
    p.resolve(this.be.permissionResult({ allowed, decision, input: ev?.input, answers: given, alwaysRule: decision === 'always' ? permissionRule(ev.tool_name, ev.input).rule : null, message: denied }));
    this.push({ type: 'permission_resolved', reqId, decision, ...(given && { answers: given }) });
    broadcastApprovals();
    pluginHost.emit('approval.resolved', { agent: this.summary(), reqId, toolName: p.req.tool_name, decision });
    if (this.attention?.kind === 'blocked' && ![...pending.values()].some((x) => x.agent === this)) this.attention = null;
    if (!this.waiting()) { clearTimeout(this.blockTimer); this.blockTimer = null; }
    broadcast({ type: 'agent', agent: this.summary() }); // its `waiting` changed
    return true;
  }

  denyPending(message) {
    for (const [reqId, p] of pending) if (p.agent === this) this.resolvePermission(reqId, 'deny', message);
  }

  // Claude's Remote Control: a `claude remote-control` server for this folder, reachable from
  // claude.ai/code and the Claude mobile app. It's its own process and creates its own session;
  // it doesn't share this agent's chat or approvals.
  setRemote(patch) {
    this.remote = { ...this.remote, ...patch };
    broadcast({ type: 'agent', agent: this.summary() });
  }

  startRemote() {
    if (this.remoteProc) return;
    const acct = accountOr(this.account);
    this.setRemote({ status: 'starting', url: null, error: null });
    const proc = spawn('claude', ['remote-control', '--name', this.name], {
      cwd: this.cwd,
      env: accountEnv(acct),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.remoteProc = proc;
    let tail = '';
    const onData = (d) => {
      const raw = d.toString();
      tail = (tail + raw).slice(-4000);
      // links come wrapped in terminal escape codes; prefer the session link over the environment link
      const urls = tail.match(/https:\/\/claude\.ai\/code[^\s\x07\x1b]*/g) || [];
      const url = urls.findLast((u) => u.includes('/session_')) || urls.at(-1);
      if (url && /Connected/.test(tail)) this.setRemote({ status: 'on', url });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => this.setRemote({ status: 'error', error: e.message }));
    proc.on('exit', (code) => {
      this.remoteProc = null;
      if (this.remote.status === 'off') return;
      const msg = tail.replace(/\x1b\][^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().split('\n').pop();
      this.setRemote({ status: 'error', url: null, error: `exited (${code}): ${msg}` });
    });
  }

  stopRemote() {
    this.setRemote({ status: 'off', url: null, error: null });
    if (this.remoteProc) this.remoteProc.kill('SIGTERM');
  }

  stop() {
    this.clearStuck();
    this.lastEventAt = Date.now();
    this.dropInput();
    this.denyPending('interrupted');
    if (this.pid) this.driver.interrupt();
  }

  // End the claude process now (mode switch, remove). The next send() starts a fresh one.
  killProc() {
    this.dropInput();
    if (!this.pid) return;
    const pid = this.pid;
    this.signal('SIGTERM');
    this.onExit(null, pid);
  }

  // a one-off agent lives in <tmp>/<id>/scratch, which is removed with the agent
  get oneOff() { return this.cwd === path.join(tmpDirFor(this.id), 'scratch'); }

  kill() {
    if (this.remoteProc) this.remoteProc.kill('SIGTERM');
    this.denyPending('agent removed');
    if (this.handoff) { const h = this.handoff; clearTimeout(h.timer); this.handoff = null; h.resolve({ error: 'agent removed' }); } // held messages go with it
    this.killProc();
    fs.rmSync(this.fifo, { force: true });
    fs.rmSync(this.outFile, { force: true });
    fs.rmSync(this.errFile, { force: true });
    fs.rmSync(this.mcpFile, { force: true });
    fs.rmSync(tmpDirFor(this.id), { recursive: true, force: true });
  }
}

// Remove an agent for good (its process, tmp dir and DB rows; a one-off's conversation stays in History). Callers check first.
function removeAgent(agent) {
  if (agent.role === 'conductor') throw new Error('the swarm chat (conductor) cannot be removed');
  agent.removing = true; // its process ending is not news for its parent
  clearTimeout(agent.blockTimer);
  agents.get(agent.parentId)?.notices.delete(agent.id);
  agent.kill();
  rooms.agentRemoved(agent.id);
  if (agent.wt) gitt.pruneWorktrees(agent.wt.repo); // the branch (and its commits) stays in the repo
  agents.delete(agent.id);
  q.orphanTasks.run(agent.id);
  broadcastTasks();
  broadcastApprovals();
  q.delFts.run(agent.id);
  q.delEvents.run(agent.id);
  q.delAgent.run(agent.id);
  broadcast({ type: 'removed', agentId: agent.id });
  pluginHost.emit('agent.removed', { agentId: agent.id, name: agent.name });
}

for (const r of q.allAgents.all()) {
  const a = new Agent({
    id: r.id, name: r.name, cwd: r.cwd, account: r.account, permissionMode: r.permission_mode,
    model: r.model, effort: r.effort, sessionId: r.session_id, startedAt: r.created_at, parentId: r.parent_id, startedBy: r.started_by, role: r.role,
    wt: (() => { try { return JSON.parse(r.wt || 'null'); } catch { return null; } })(), lean: r.lean == null ? null : !!r.lean, hidden: !!r.hidden, browser: r.browser, bot: r.bot,
    backend: r.backend, backendState: r.backend_state, notify: r.notify !== 0,
  });
  a.lastEventAt = q.lastTs.get(r.id)?.ts || Date.now();
  a.events = q.agentEvents.all(r.id).map((x) => { const e = JSON.parse(x.json); if (x.ts) e._ts = x.ts; return e; });
  a.recomputeTodos();
  a.recomputeContext();
  a.offset = r.out_offset || 0;
  // approvals are held in memory, so any still open were lost with the old server; a live claude re-asks
  const open = new Set(a.events.filter((e) => e.type === 'permission_request').map((e) => e.reqId));
  for (const e of a.events) if (e.type === 'permission_resolved') open.delete(e.reqId);
  for (const reqId of open) a.push({ type: 'permission_resolved', reqId, decision: 'expired' });
  agents.set(a.id, a);
  if (!r.pid) continue;
  // reattach to the claude this agent had running before the restart
  a.pid = r.pid;
  if (a.be.ownsPid(r.pid)) {
    if (a.driver.resume) for (const ev of a.driver.resume()) a.onEvent(ev); // requests the agent still waits on are asked again
    a.drain();
    const startsTurn = (e) => e.type === 'user_prompt' || (e.type === 'peer_message' && !e.queued); // a peer message to an idle session starts a turn
    const last = a.events.findLast((e) => e.type === 'result' || startsTurn(e));
    a.status = last && last.type !== 'result' ? 'running' : 'idle';
    if (a.status === 'running') { // a turn that ends after the restart still notifies the parent if the parent asked for it
      const since = a.events.slice(a.events.findLastIndex((e) => e.type === 'result') + 1).filter(startsTurn);
      a.outstanding = since.length;
      a.armed = since.some((e) => e.agentNotify || (e.by && e.by === a.parentId));
    }
    if (a.events.at(-1)?.type === 'user_prompt') a.sentAt = a.events.at(-1)._ts || Date.now(); // the watchdog flags it if claude never answers
  } else a.onExit(null, r.pid); // it finished (or died) while the server was down
}

// Agents we didn't spawn ourselves have no exit event, so watch them; every agent's output is drained here.
setInterval(() => {
  for (const a of agents.values()) {
    if (!a.pid) continue;
    a.drain();
    if (!a.child) { try { process.kill(a.pid, 0); } catch (e) { if (e.code === 'ESRCH') a.onExit(null, a.pid); } }
  }
}, 150);

// ---- HTTP ----------------------------------------------------------------

// Resolve rel inside root (following symlinks); null if it escapes.
function within(root, rel) {
  try {
    const realRoot = fs.realpathSync(root);
    const target = fs.realpathSync(path.resolve(realRoot, rel));
    return target === realRoot || target.startsWith(realRoot + path.sep) ? target : null;
  } catch { return null; }
}

// served to browsers without a session (the login page and what it loads)
const LOGIN_PUBLIC = new Set(['/login.js', '/login.css', '/css/theme.css', '/js/colors.js', '/js/themes.js', '/js/theme.js', '/icons.svg', '/favicon.svg', '/favicon-32.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-192.png', '/icon-maskable-512.png', '/badge-96.png', '/apple-touch-icon.png', '/manifest.webmanifest', '/sw.js', '/vendor/simplewebauthn.js']);
const VENDOR = {
  '/vendor/marked.min.js': 'node_modules/marked/marked.min.js',
  '/vendor/purify.min.js': 'node_modules/dompurify/dist/purify.min.js',
  '/vendor/hljs.min.js': 'node_modules/@highlightjs/cdn-assets/highlight.min.js',
  '/vendor/hljs-light.css': 'node_modules/@highlightjs/cdn-assets/styles/github.min.css',
  '/vendor/hljs-dark.css': 'node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css',
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/simplewebauthn.js': 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js',
  '/vendor/xterm-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
};
// Monaco (the code editor) is a tree of files: /vendor/monaco/vs/... -> node_modules/monaco-editor/min/vs/...
const MONACO_DIR = path.join(ROOT, 'node_modules/monaco-editor/min');
const vendorFile = (p) => {
  if (VENDOR[p]) return path.join(ROOT, VENDOR[p]);
  if (!p.startsWith('/vendor/monaco/')) return null;
  let f; try { f = path.join(MONACO_DIR, decodeURIComponent(p.slice('/vendor/monaco/'.length))); } catch { return null; }
  return f.startsWith(MONACO_DIR + path.sep) ? f : null;
};

const assetCache = new Map(); // file -> { mtimeMs, raw, gz, br, deflate, etag, compressible }
function staticAsset(file, ext) {
  const mtimeMs = fs.statSync(file).mtimeMs, hit = assetCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  const raw = fs.readFileSync(file);
  const compressible = raw.length > 256 && !/^\.(png|ico|jpg|jpeg|webp|gif|woff2?)$/.test(ext);
  const asset = {
    mtimeMs, raw, compressible, etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20) + '"',
    ...(compressible ? {
      gz: zlib.gzipSync(raw, { level: 9 }), deflate: zlib.deflateSync(raw, { level: 9 }),
      // brotli 11 runs at about 1 MB/s on the event loop, so big files (Monaco's) get a fast level instead
      br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: raw.length > 512 * 1024 ? 5 : 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
    } : { gz: raw, deflate: raw, br: raw }),
  };
  assetCache.set(file, asset);
  return asset;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };

// Best encoding the client accepts (br only where it is precomputed, i.e. static files)
const pickEncoding = (req, allowBr) => {
  const ae = String(req.headers['accept-encoding'] || '');
  return allowBr && /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : /\bdeflate\b/.test(ae) ? 'deflate' : '';
};

const json = (res, code, body) => {
  const data = Buffer.from(JSON.stringify(body));
  const enc = data.length > 1024 ? pickEncoding(res.req, false) : '';
  if (!enc) {
    res.writeHead(code, { 'content-type': 'application/json', vary: 'Accept-Encoding' });
    return res.end(data);
  }
  zlib[enc === 'gzip' ? 'gzip' : 'deflate'](data, { level: 5 }, (err, out) => {
    res.writeHead(code, { 'content-type': 'application/json', 'content-encoding': enc, vary: 'Accept-Encoding' });
    res.end(err ? data : out);
  });
};

// a JSON request body; rejects with .status 413 past `max` bytes and 400 for invalid JSON (the HTTP handler answers
// with that status). Uploads don't come through here (receiveUpload streams them to disk).
const BODY_MAX = 5 << 20;
const bodyError = (status, message) => Object.assign(new Error(message), { status, code: status });
const readBody = (req, max = BODY_MAX) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, over = false;
    req.on('data', (d) => {
      if (over) return;
      size += d.length;
      if (size > max) { over = true; chunks.length = 0; reject(bodyError(413, `request body is over ${Math.round(max / 2 ** 20)} MB`)); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      if (over) return;
      const s = Buffer.concat(chunks).toString('utf8');
      try { resolve(s.trim() ? JSON.parse(s) : {}); } catch { reject(bodyError(400, 'request body is not valid JSON')); }
    });
    req.on('error', reject);
  });

// What an agent's own token (auth.js) opens: the calls its swarm tools make (swarm-mcp.js), nothing more; no terminals,
// approvals, modes, settings, accounts, plugins, peers' setup, files or restarts. A regular agent acts only on the agents
// it started; the conductor (the swarm chat) on any agent, plus tasks, bots, accounts and sessions to read, and peers.
// The routes themselves keep their own checks (rooms, schedules, bots, permission modes). Null when allowed, else why not.
function agentRoute(me, method, p, url) {
  const conductor = me.role === 'conductor', no = `an agent's token cannot ${method} ${p}`;
  const conductorOnly = (ok) => (!ok ? no : conductor ? null : 'only the swarm chat (conductor) can do this');
  let m;
  if (p === '/api/agents') return method === 'GET' || method === 'POST' ? null : no;
  if ((m = p.match(/^\/api\/agents\/([^/]+)(?:\/(\w+))?$/))) {
    const action = m[2];
    if (action ? !['wait', 'send', 'interrupt', 'refresh', 'focus'].includes(action) || method !== 'POST' : !['GET', 'DELETE'].includes(method)) return no;
    if (method === 'DELETE' && url.searchParams.get('discard') === '1') return 'only the user can discard an agent\'s files (its Remove button)';
    let id; try { id = decodeURIComponent(m[1]); } catch { return no; }
    const a = agents.get(id);
    if (!a) return null; // the route answers 404
    if (a.id === me.id) return 'that is you: an agent cannot drive itself';
    if (!conductor && a.parentId !== me.id) return `agent ${id} is not one you started`;
    return null;
  }
  if (p === '/api/stats') return method === 'GET' ? null : no;
  if (p === '/api/rooms' || p.startsWith('/api/rooms/')) return null; // rooms.js: an agent only in its rooms
  if (p === '/api/schedules' || p.startsWith('/api/schedules/')) return null; // a regular agent only its own (below)
  // bots: list, create, read, edit, pause and resume (bots.js: no settings, no deleting); not their files or a refresh
  if (p === '/api/bots') return conductorOnly(method === 'GET' || method === 'POST');
  if ((m = p.match(/^\/api\/bots\/[^/]+(?:\/(\w+))?$/))) return conductorOnly(m[1] ? method === 'POST' && ['pause', 'resume'].includes(m[1]) : method === 'GET' || method === 'PATCH');
  if (p === '/api/tasks' || p.startsWith('/api/tasks/')) return conductorOnly(p !== '/api/tasks/reorder');
  if (p === '/api/accounts' || p === '/api/sessions/all') return conductorOnly(method === 'GET');
  if (p === '/api/peers') return conductorOnly(method === 'GET');
  if (/^\/api\/peers\/[^/]+\/./.test(p)) return conductorOnly(true); // the proxy to a peer (peers.js checks the path)
  return no;
}

// ---- git (see git-tools.js): paths must stay inside the agent's folder or its tmp dir ----------

function gitDir(agent, p) {
  const dir = within(agent.cwd, p || '') || within(tmpDirFor(agent.id), p || '');
  if (!dir) throw Object.assign(new Error('path is outside the agent folder'), { code: 400 });
  return dir;
}

// repos for the agent: its folder plus anything git-looking under its tmp dir (worktrees it or we made)
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
async function agentRepos(agent) {
  const dirs = [agent.cwd];
  const tmp = tmpDirFor(agent.id);
  const scan = (d, depth) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const sub = path.join(d, e.name);
      if (fs.existsSync(path.join(sub, '.git'))) dirs.push(sub); else if (depth > 0) scan(sub, depth - 1);
    }
  };
  scan(tmp, 2);
  if (fs.existsSync(agent.cwd)) for (const w of await gitt.listWorktrees(agent.cwd)) if (w.path.startsWith(real(tmp) + path.sep)) dirs.push(w.path);
  const seen = new Set(), out = [];
  for (const d of dirs.slice(0, 20)) {
    if (!fs.existsSync(d)) continue;
    const info = await gitt.repoInfo(d, agent.wt && real(d) === real(agent.wt.path) ? agent.wt.base : undefined);
    if (!info || seen.has(info.top)) continue;
    seen.add(info.top);
    if (info.linked && info.top !== info.path) info.path = info.top; // a worktree is addressed by its own root
    info.isCwd = d === agent.cwd;
    info.managed = !!agent.wt && info.top === real(agent.wt.path);
    out.push(info);
  }
  return out;
}

async function gitRoute(agent, action, req, url, res) {
  const qp = (k) => url.searchParams.get(k) || undefined;
  if (!action && req.method === 'GET') return json(res, 200, { repos: await agentRepos(agent) });
  if (action === 'diff' && req.method === 'GET') {
    const mode = qp('mode') === 'base' ? 'base' : 'working';
    return json(res, 200, await gitt.diff(gitDir(agent, qp('path')), { mode, base: qp('base'), file: qp('file') }));
  }
  if (action === 'review' && req.method === 'GET') return json(res, 200, await gitt.review(gitDir(agent, qp('path')), qp('base')));
  if ((action === 'merge' || action === 'remove') && req.method === 'POST') {
    const b = await readBody(req);
    if (b.confirm !== true) throw Object.assign(new Error('this needs an explicit confirmation (confirm: true)'), { code: 400 });
    const dir = gitDir(agent, b.path);
    if (agent.status === 'running') throw Object.assign(new Error('the agent is working; wait for it to finish its turn (or interrupt it) first'), { code: 409 });
    const cwdReal = real(agent.cwd), own = cwdReal === dir || cwdReal.startsWith(dir + path.sep); // is the agent living in this worktree?
    let result;
    if (action === 'merge') {
      result = await gitt.merge(dir, { base: b.base, mode: b.mode, expectHead: b.expectHead, remove: false, deleteBranch: false });
    }
    if (action === 'remove' || (action === 'merge' && b.remove)) {
      if (own) agent.killProc(); // its folder is about to disappear
      try {
        result = { ...result, ...(await gitt.removeWorktree(dir, { deleteBranch: !!b.deleteBranch, expectHead: action === 'remove' ? b.expectHead : undefined })) };
        if (own) agent.push({ type: 'note', text: `worktree ${dir} was ${action === 'merge' ? 'merged and ' : ''}removed` });
      } catch (e) {
        if (action === 'remove') throw e;
        result.removed = false; result.removeError = e.message; // the merge itself went through
      }
    }
    broadcast({ type: 'agent', agent: agent.summary() });
    return json(res, 200, result);
  }
  return json(res, 404, { error: 'not found' });
}

// ---- usage report ------------------------------------------------------------------------------
const USAGE_SUM = 'SUM(input) input, SUM(output) output, SUM(cache_read) cacheRead, SUM(cache_create) cacheCreate, SUM(cost) cost, SUM(cost IS NULL) noCost, COUNT(*) turns';
const uq = {
  byAccount: db.prepare(`SELECT COALESCE(account, '(unknown)') account, ${USAGE_SUM} FROM usage GROUP BY account ORDER BY account`),
  byDay: db.prepare(`SELECT day, COALESCE(account, '(unknown)') account, ${USAGE_SUM} FROM usage WHERE day IS NULL OR day >= ? GROUP BY day, account ORDER BY day IS NULL, day DESC, account`),
  today: db.prepare(`SELECT COALESCE(account, '(unknown)') account, ${USAGE_SUM} FROM usage WHERE day = ? GROUP BY account`),
};
const searchBefore = db.prepare('SELECT COUNT(*) n FROM events WHERE agent_id=? AND id<?');
function usageReport(days) {
  const since = dayOf(Date.now() - (days - 1) * 86_400_000);
  const today = dayOf(Date.now());
  const alerts = usageAlertsCfg().accounts || {};
  const byAccount = uq.byAccount.all(), byDay = uq.byDay.all(since), todayRows = uq.today.all(today);
  return {
    today, days, byAccount, byDay, todayByAccount: todayRows, thresholds: alerts,
    over: Object.entries(alerts).flatMap(([a, c]) => {
      const t = todayRows.find((r) => r.account === a);
      return [...(c.dailyCost > 0 && (t?.cost || 0) >= c.dailyCost ? ['cost'] : []), ...(c.dailyTokens > 0 && (t?.input || 0) + (t?.output || 0) >= c.dailyTokens ? ['tokens'] : [])].map((metric) => ({ account: a, metric }));
    }),
    notes: {
      cost: "Cost is the total_cost_usd Claude Code reports, an API-price estimate. On a subscription plan it is not what you are billed. Turns where the CLI reported no cost are counted in noCost and add nothing to the sums.",
      tokens: 'input and output are this turn\'s tokens; cache read/write are shown separately. Daily token thresholds count input + output only.',
      dates: 'Turns recorded before usage tracking existed have no date and are listed under "earlier" (day = null).',
    },
  };
}

// ---- file viewer: files inside the agent's folder or its tmp dir, via short-lived signed URLs -----------------
// <img src> and new tabs can't send the Bearer header and the long-lived token must not end up in URLs, so the UI asks
// POST /api/agents/:id/fileurl (Bearer) for a URL signed with a per-process secret: bound to agent + real path, valid for
// 10-20 minutes (the expiry is bucketed so the same file keeps the same URL and the browser can cache it).
const FILE_SECRET = crypto.randomBytes(32);
const FILE_TTL = 600;
const MAX_BIN = 25 * 1024 * 1024, MAX_TEXT = 2 * 1024 * 1024;
const IMG_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
const TEXT_EXT = new Set('txt md markdown json jsonl js mjs cjs jsx ts tsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh fish ps1 sql css scss less html htm xml yaml yml toml ini cfg conf env log csv tsv diff patch lock gradle make mk dockerfile gitignore svelte vue lua r pl scala dart ex exs erl hs clj tf proto graphql vim'.split(' ').map((e) => '.' + e));
const TEXT_NAMES = new Set(['makefile', 'dockerfile', 'readme', 'license', 'changelog', 'procfile', 'gemfile', 'rakefile']);
// never served even inside an agent folder (an agent whose cwd is the swarm folder would otherwise expose these)
const SECRET_NAME = /^(\.token|local-app-token(\.tmp)?|\.env(\..*)?|(swarm|halay)\.db(-shm|-wal)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx))$/i;
// code editor (public/js/editor.js): read/write inside the agent's folder, same exclusions as the viewer
const editFs = createEditorFs({ isProtected: (rp) => browser.isProtected(rp), secret: SECRET_NAME });

function fileKind(file, head) {
  const ext = path.extname(file).toLowerCase(), base = path.basename(file).toLowerCase();
  if (IMG_TYPES[ext]) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(base)) return 'text';
  if (head && !head.includes(0)) { try { new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 3))); return 'text'; } catch {} }
  return 'binary';
}

// Resolve a path from the UI (absolute, or relative to the agent's cwd, then its tmp dir) to a real file inside one of the
// two allowed folders. Symlinks are resolved first and containment is checked on the result.
function resolveAgentFile(agent, p) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) throw Object.assign(new Error('bad path'), { code: 400 });
  if (p.split(/[\\/]/).includes('..')) throw Object.assign(new Error('path traversal is not allowed'), { code: 400 });
  const roots = [agent.cwd, tmpDirFor(agent.id)].map((r) => { try { return fs.realpathSync(r); } catch { return null; } }).filter(Boolean);
  const cands = path.isAbsolute(p) ? [p] : roots.map((r) => path.join(r, p));
  let found = false;
  for (const c of cands) {
    let rp; try { rp = fs.realpathSync(c); } catch { continue; }
    found = true;
    if (!roots.some((r) => rp === r || rp.startsWith(r + path.sep))) continue;
    if (browser.isProtected(rp)) throw Object.assign(new Error('browser profiles hold logged-in sessions and are never served'), { code: 403, outside: false });
    if (SECRET_NAME.test(path.basename(rp)) || SECRET_NAME.test(path.basename(c))) throw Object.assign(new Error('this file is never served'), { code: 403, outside: false });
    if (!fs.statSync(rp).isFile()) throw Object.assign(new Error('not a file'), { code: 400 });
    return rp;
  }
  if (found) throw Object.assign(new Error("outside the agent's folder"), { code: 403, outside: true });
  // not on disk: is the path at least lexically outside the folders?
  const abs = path.isAbsolute(p) ? path.resolve(p) : null;
  if (abs && !roots.some((r) => abs === r || abs.startsWith(r + path.sep))) throw Object.assign(new Error("outside the agent's folder"), { code: 403, outside: true });
  throw Object.assign(new Error('file not found'), { code: 404 });
}

const fileSig = (id, rp, exp) => crypto.createHmac('sha256', FILE_SECRET).update(id + '\0' + rp + '\0' + exp).digest('base64url');

function signFile(agent, p) {
  const rp = resolveAgentFile(agent, p);
  const st = fs.statSync(rp);
  let head = null;
  if (!IMG_TYPES[path.extname(rp).toLowerCase()] && path.extname(rp).toLowerCase() !== '.pdf') {
    const fd = fs.openSync(rp, 'r'); try { head = Buffer.alloc(Math.min(8192, st.size)); fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  }
  const kind = fileKind(rp, head);
  const exp = (Math.floor(Date.now() / 1000 / FILE_TTL) + 2) * FILE_TTL;
  const qs = new URLSearchParams({ p: rp, exp: String(exp), sig: fileSig(agent.id, rp, exp) });
  const limit = kind === 'text' ? MAX_TEXT : MAX_BIN;
  return { kind, name: path.basename(rp), path: rp, size: st.size, truncated: kind === 'text' && st.size > MAX_TEXT, tooLarge: kind !== 'text' && st.size > MAX_BIN, limit, url: `/raw/${agent.id}?${qs}` };
}

function serveRaw(req, url, res) {
  const fail = (code, msg) => { if (res.headersSent) return res.destroy(); res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }); res.end(msg); };
  let agent;
  try { agent = agents.get(decodeURIComponent(url.pathname.slice(5))); } catch { return fail(400, 'malformed URL'); }
  const rp = url.searchParams.get('p') || '', exp = Number(url.searchParams.get('exp')), sig = url.searchParams.get('sig') || '';
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(405, 'method not allowed');
  if (!agent || !(exp > Date.now() / 1000)) return fail(403, 'link expired');
  const want = Buffer.from(fileSig(agent.id, rp, exp)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return fail(403, 'bad signature');
  let real, fd;
  try {
    real = resolveAgentFile(agent, rp); // symlinks may have changed since signing: re-check
    if (real !== rp) return fail(403, 'file changed');
    fd = fs.openSync(real, 'r');
  } catch (e) { return fail(typeof e.code === 'number' ? e.code : 404, e.message); }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return fail(400, 'not a file');
    const ext = path.extname(real).toLowerCase();
    const head = Buffer.alloc(Math.min(8192, st.size)); fs.readSync(fd, head, 0, head.length, 0);
    const kind = fileKind(real, head);
    if (kind !== 'text' && st.size > MAX_BIN) return fail(413, 'file too large (limit 25 MB)');
    const name = path.basename(real).replace(/[^\w.\- ]/g, '_');
    const h = { 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=300', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin', 'last-modified': st.mtime.toUTCString() };
    let type, disp = 'inline', csp = "default-src 'none'; sandbox", len = st.size, truncated = false;
    const dest = req.headers['sec-fetch-dest'] || '';
    if (kind === 'image' && ext === '.svg' && dest !== 'image') { type = 'text/plain; charset=utf-8'; if (dest === 'document' || !dest) disp = 'attachment'; } // svg as a document could run script
    else if (kind === 'image') { type = IMG_TYPES[ext]; csp = "default-src 'none'; style-src 'unsafe-inline'; sandbox"; }
    else if (kind === 'pdf') { type = 'application/pdf'; csp = "default-src 'none'; style-src 'unsafe-inline'"; }
    else if (kind === 'text') { type = 'text/plain; charset=utf-8'; if (st.size > MAX_TEXT) { len = MAX_TEXT; truncated = true; } }
    else { type = 'application/octet-stream'; disp = 'attachment'; }
    if (url.searchParams.get('dl') === '1') disp = 'attachment';
    res.writeHead(200, { ...h, 'content-type': type, 'content-length': len, 'content-security-policy': csp, 'content-disposition': `${disp}; filename="${name}"`, ...(truncated ? { 'x-truncated': '1', 'access-control-expose-headers': 'x-truncated' } : {}) });
    if (req.method === 'HEAD' || len === 0) { fs.closeSync(fd); fd = undefined; return res.end(); } // empty file: end: -1 would throw ERR_OUT_OF_RANGE
    const rs = fs.createReadStream(null, { fd, start: 0, end: len - 1, autoClose: true });
    fd = undefined; // the stream owns (and closes) it now
    rs.on('error', () => res.destroy());
    rs.pipe(res);
  } catch (e) { if (fd !== undefined) try { fs.closeSync(fd); } catch {} return fail(500, 'read error'); }
}

// Host header that is a loopback IP literal (127.x.x.x or [::1]), with or without a port
const LOOPBACK_IP_HOST = /^(127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/;
async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  // the x-swarm-* request headers were renamed x-halay-*: an old client (a swarm-mcp.js started before the rename, a peer on an
  // older version) still sends the old names. Normalised here, before anything reads or overwrites them.
  for (const h of ['agent', 'peer', 'plugin']) if (req.headers['x-halay-' + h] === undefined && req.headers['x-swarm-' + h] !== undefined) req.headers['x-halay-' + h] = req.headers['x-swarm-' + h];

  if (url.pathname === '/halay-ca.crt' && (req.method === 'GET' || req.method === 'HEAD')) return serveCaCert(req, res); // public: phones install it before they can sign in

  // A browser that opens the page by a loopback IP (http://127.0.0.1:PORT/) cannot register or use a passkey: WebAuthn needs a domain
  // as the relying-party id and Chrome rejects an IP address ("127.0.0.1 is an invalid domain"). Send it to the same URL on localhost
  // (a secure context, so passkeys work), keeping path and query (?token=). Only a browser navigation is redirected: agents, the MCP
  // server, plugins and peers call http://127.0.0.1:PORT with fetch/curl (Accept */*, usually an Authorization header) and are left alone.
  if ((req.method === 'GET' || req.method === 'HEAD') && LOOPBACK_IP_HOST.test(String(req.headers.host || '')) && /\btext\/html\b/.test(String(req.headers.accept || ''))
    && !req.headers.authorization && !req.headers['x-halay-agent'] && !req.headers['x-halay-peer'] && !req.headers['x-halay-plugin'] && !req.headers['x-forwarded-host'] && !req.headers['tailscale-user-login']) {
    res.writeHead(302, { location: `${req.socket.encrypted ? 'https' : 'http'}://localhost:${req.headers.host.match(/:(\d+)$/)?.[1] || (req.socket.encrypted ? HTTPS_PORT : PORT)}${req.url.startsWith('/') ? req.url : '/'}`, 'cache-control': 'no-store' });
    return res.end();
  }

  if (url.pathname.startsWith('/auth/') && await auth.publicRoutes(req, res, url, { json, readBody })) return; // login, setup, logout: no session needed
  if (url.pathname.startsWith('/raw/')) return serveRaw(req, url, res); // signed, expiring links (POST /api/agents/:id/fileurl is authenticated)

  // /internal/*: the swarm MCP server's calls. With an agent's token (auth.js) a call speaks for that agent only: the
  // agentId in its body must be that agent, and x-halay-agent is set from the token
  const ik = url.pathname.startsWith('/internal/') ? auth.who(req, url) : null;
  if (url.pathname.startsWith('/internal/')) {
    if (!ik) return json(res, 401, { error: 'unauthorized' });
    if (ik === 'agent') req.headers['x-halay-agent'] = req.agentId;
  }
  const ownAgent = (body) => ik !== 'agent' || String(body.agentId) === req.agentId;

  // the swarm's question tool for CLIs without one (swarm-mcp.js ask_user): a question card, held open until answered
  if (url.pathname === '/internal/ask' && req.method === 'POST') {
    const body = await readBody(req);
    if (!ownAgent(body)) return json(res, 403, { error: 'an agent can only ask for itself' });
    const agent = agents.get(body.agentId);
    if (!agent) return json(res, 404, { error: 'no such agent' });
    const qs = Array.isArray(body.questions) ? body.questions : [];
    if (!qs.length || qs.length > 4) return json(res, 400, { error: 'questions: one to four' });
    const questions = [];
    for (const x of qs) {
      const options = Array.isArray(x?.options) ? x.options.filter((o) => o && typeof o.label === 'string' && o.label.trim()).map((o) => ({ label: o.label.trim().slice(0, 200), description: typeof o.description === 'string' ? o.description.slice(0, 500) : '' })) : [];
      if (typeof x?.question !== 'string' || !x.question.trim()) return json(res, 400, { error: 'every question needs its text' });
      if (options.length < 2 || options.length > 4) return json(res, 400, { error: `"${x.question.slice(0, 60)}": two to four options` });
      if (questions.some((y) => y.question === x.question.trim())) return json(res, 400, { error: 'two questions with the same text' });
      questions.push({ question: x.question.trim().slice(0, 1000), header: String(x.header || 'Question').slice(0, 12), options, multiSelect: !!x.multiSelect });
    }
    const d = await agent.requestPermission({ tool_name: QUESTION_TOOL, input: { ...(typeof body.title === 'string' && body.title && { title: body.title.slice(0, 120) }), questions } }, res);
    if (res.writableEnded || res.destroyed) return; // the tool call was cancelled
    const allowed = d.behavior ? d.behavior === 'allow' : !!d.allowed, answers = d.updatedInput?.answers || d.answers;
    return json(res, 200, allowed && answers && Object.keys(answers).length ? { answers } : { answers: null, message: d.message || '' });
  }

  // submit_plan (swarm-mcp.js): a plan card for CLIs without plan approval over ACP; approved, the agent leaves plan
  // mode (manual: every call still asks) once its turn ends, and is told to implement the plan
  if (url.pathname === '/internal/plan' && req.method === 'POST') {
    const body = await readBody(req, 4 << 20);
    if (!ownAgent(body)) return json(res, 403, { error: 'an agent can only submit its own plan' });
    const agent = agents.get(body.agentId);
    if (!agent) return json(res, 404, { error: 'no such agent' });
    if (typeof body.plan !== 'string' || !body.plan.trim()) return json(res, 400, { error: 'plan: the whole plan as text' });
    if (agent.permissionMode !== 'plan') return json(res, 200, { message: 'You are not in plan mode: no approval needed, go ahead within your permission mode.' });
    const d = await agent.requestPermission({ tool_name: 'ExitPlanMode', input: { plan: body.plan.slice(0, 200000) } }, res);
    if (res.writableEnded || res.destroyed) return; // the tool call was cancelled
    const allowed = d.behavior ? d.behavior === 'allow' : !!d.allowed;
    if (!allowed) return json(res, 200, { message: `The user rejected the plan${d.message && !/^(denied|rejected)/i.test(d.message) ? `: ${d.message}` : '.'} You are still in plan mode: revise the plan, or ask what to change.` });
    if (agent.permissionMode === 'plan') {
      agent.permissionMode = 'manual';
      q.setMode.run('manual', agent.id);
      broadcast({ type: 'agent', agent: agent.summary() });
      agent.driver.reconfigure?.(agent.be.leavePlan || []);
      agent.push({ type: 'note', text: 'Plan approved: leaving plan mode (now manual) when this turn ends' });
      agent.send('The plan is approved and plan mode is off: implement it now.');
    }
    return json(res, 200, { message: 'The user approved the plan. End your turn now without doing anything else: plan mode is switched off when it ends, and the next message asks you to implement the plan.' });
  }

  if (url.pathname === '/internal/permission' && req.method === 'POST') {
    const body = await readBody(req, 64 << 20); // the tool's whole input (a Write of a big file)
    if (!ownAgent(body)) return json(res, 403, { error: 'an agent can only ask permission for itself' });
    const agent = agents.get(body.agentId);
    if (!agent) return json(res, 404, { error: 'no such agent' });
    if (pluginHost.autoAllowed(body.tool_name, roleOf(agent))) return json(res, 200, { behavior: 'allow', updatedInput: body.input ?? {} }); // a plugin tool marked autoAllow (shown when it was enabled)
    const decision = await agent.requestPermission(body, res);
    return json(res, 200, decision);
  }

  // plugin tools for swarm-mcp.js: the list for the calling agent's role, and calls (plugins.js)
  if (url.pathname.startsWith('/internal/plugin-tools')) {
    const agent = agents.get(String(req.headers['x-halay-agent'] || ''));
    if (!agent) return json(res, 404, { error: 'no such agent' });
    const caller = { agentId: agent.id, role: roleOf(agent), name: agent.name, cwd: agent.cwd };
    if (url.pathname === '/internal/plugin-tools' && req.method === 'GET') return json(res, 200, pluginHost.toolsFor(caller.role));
    if (url.pathname === '/internal/plugin-tools/call' && req.method === 'POST') {
      const body = await readBody(req);
      try { return json(res, 200, { text: await pluginHost.callTool(String(body.name || ''), body.arguments, caller) }); }
      catch (e) { return json(res, e.status || 500, { error: e.message || String(e) }); }
    }
    return json(res, 404, { error: 'not found' });
  }

  if (url.pathname.startsWith('/api/')) {
    const kind = auth.who(req, url);
    if (!kind) return json(res, 401, { error: 'unauthorized' });
    // An agent's token (auth.js): the caller is that agent, whatever x-halay-agent says, and it reaches only the routes
    // its swarm tools use, with the same limits the tools have (agentRoute)
    const me = kind === 'agent' ? agents.get(req.agentId) : null;
    if (kind === 'agent') {
      if (!me) return json(res, 401, { error: 'this agent no longer exists' });
      req.headers['x-halay-agent'] = me.id;
      const denied = agentRoute(me, req.method, url.pathname, url);
      if (denied) return json(res, 403, { error: denied });
    }
    if (await auth.manageRoutes(req, res, url, kind, { json, readBody })) return;

    // A call another swarm instance forwarded (peers.js): it holds this server's token, so it has the conductor's rights;
    // what it starts or adds is marked 'peer:<name>'. It cannot reach this server's own peers (no chains, no loops).
    const fromPeer = req.headers['x-halay-peer'] === undefined ? null : String(req.headers['x-halay-peer']);
    if (fromPeer !== null) {
      if (kind !== 'token' || !peers.validName(fromPeer)) return json(res, 403, { error: 'peer calls need the access token and a valid x-halay-peer name' });
      if (url.pathname.startsWith('/api/peers')) return json(res, 403, { error: 'a peer cannot use this server\'s peers' });
    }
    // a plugin calling this API through ctx (plugins.js coreApi): what it starts or adds is marked 'plugin:<id>'
    const fromPlugin = kind === 'token' && req.headers['x-halay-plugin'] !== undefined && pluginHost.validId(req.headers['x-halay-plugin']) ? String(req.headers['x-halay-plugin']) : null;
    const startedBy = fromPeer ? 'peer:' + fromPeer : fromPlugin ? 'plugin:' + fromPlugin : null;
    if (url.pathname === '/api/plugins' || url.pathname.startsWith('/api/plugins/'))
      return pluginHost.handle(req, url, res, { json, readBody, caller: { kind, agentId: req.headers['x-halay-agent'] ? String(req.headers['x-halay-agent']) : null, peer: fromPeer, plugin: fromPlugin } });
    if (url.pathname === '/api/stats' && req.method === 'GET') return json(res, 200, { name: peers.self(), ...stats.get() });
    if (url.pathname === '/api/machines' && req.method === 'GET') return json(res, 200, peers.machines()); // cached: never waits on a peer
    if (url.pathname === '/api/instance' && req.method === 'GET') return json(res, 200, peers.instance());
    if (url.pathname.startsWith('/api/peers')) {
      // an agent (the conductor, through the swarm MCP's peer option) can't start or switch anything on a peer to a
      // permission mode above its own, as it can't here
      const ca = agents.get(String(req.headers['x-halay-agent'] || ''));
      const check = ca && ((method, apiPath, b) => method !== 'GET' && /^\/(agents|tasks\/\d+\/assign|agents\/[^/]+\/mode)$/.test(apiPath) && b.permissionMode
        && modeRank(b.permissionMode) > modeRank(ca.permissionMode) ? `you cannot start or set a more permissive mode than your own (${ca.permissionMode}) on a peer: ${b.permissionMode}` : null);
      if (await peers.handle(req, url, res, { json, readBody, check })) return;
    }

    if (url.pathname.startsWith('/api/browser') && await browser.api(req, res, url, { json, readBody })) return;

    if (url.pathname === '/api/sessions/all') {
      const r = listAllSessions(), o = listAcpSessions(); // Claude's transcripts, and the other CLIs' own lists
      return json(res, 200, { sessions: [...r, ...o].sort((x, y) => y.mtime - x.mtime), partial: r.partial || o.partial });
    }

    if (url.pathname === '/api/sessions') {
      const cwd = url.searchParams.get('cwd');
      return json(res, 200, cwd ? listSessions(url.searchParams.get('account') || defaultAccountFor(DEFAULT_BACKEND), cwd) : []);
    }

    if (url.pathname === '/api/conductor' && req.method === 'POST') {
      let c = [...agents.values()].find((a) => a.role === 'conductor');
      if (!c) {
        const body = await readBody(req);
        const saved = q.getSetting.get('conductor_account')?.value;
        const account = (accounts[saved] && saved) || body.account || defaultAccountFor(DEFAULT_BACKEND);
        if (!accounts[account]) return json(res, 400, { error: 'unknown account' });
        fs.mkdirSync(CONDUCTOR_DIR, { recursive: true });
        const backend = backendOfAccount(account);
        c = Agent.create({ cwd: CONDUCTOR_DIR, name: 'Swarm chat', account, backend, permissionMode: conductorMode(backend), role: 'conductor' });
        agents.set(c.id, c);
        broadcast({ type: 'agent', agent: c.summary() });
      }
      return json(res, 200, c.summary());
    }
    if (url.pathname === '/api/conductor/account' && req.method === 'POST') {
      // A session lives in its account's config dir, so switching accounts starts a fresh context (the chat above stays for reference).
      const { account } = await readBody(req);
      if (!accounts[account]) return json(res, 400, { error: 'unknown account' });
      q.putSetting.run('conductor_account', account);
      const c = [...agents.values()].find((a) => a.role === 'conductor');
      if (c && c.account !== account) {
        if (c.status === 'running') return json(res, 409, { error: 'agent is busy; switch when it is idle' });
        c.killProc();
        c.account = account;
        c.sessionId = null;
        q.setAccount.run(account, c.id);
        if (c.backend !== backendOfAccount(account)) { // another CLI: its own default mode, model and effort
          c.setBackend(backendOfAccount(account));
          c.permissionMode = conductorMode(c.backend); q.setMode.run(c.permissionMode, c.id);
          c.model = null; c.effort = null; q.setModel.run(null, null, c.id);
        }
        q.setSession.run(null, c.id);
        c.push({ type: 'context_reset' });
        broadcast({ type: 'agent', agent: c.summary() });
      }
      return json(res, 200, { ok: true, account });
    }
    if (url.pathname === '/api/conductor/prompt') {
      if (req.method === 'GET') {
        const custom = q.getSetting.get('conductor_prompt')?.value;
        return json(res, 200, { prompt: custom ?? defaultConductorPrompt(), isDefault: custom === undefined });
      }
      if (req.method === 'PUT') {
        const { prompt } = await readBody(req);
        if (typeof prompt === 'string' && prompt.trim()) q.putSetting.run('conductor_prompt', prompt);
        else q.delSetting.run('conductor_prompt');
        return json(res, 200, { ok: true });
      }
    }

    if (url.pathname === '/api/backends' && req.method === 'GET') { // the coding-agent CLIs agents can run on (backends/)
      return json(res, 200, Object.values(BACKENDS).filter((b) => backendEnabled(b.id)).map((b) => ({
        id: b.id, label: b.label, bin: b.bin, capabilities: b.capabilities, modelHint: b.modelHint || null, addAccounts: b.accountEnv ? true : b.noAccounts || false,
        accounts: Object.values(accounts).filter((a) => a.backend === b.id).map((a) => a.name), defaultAccount: defaultAccountFor(b.id),
        installed: !!backendStatus[b.id]?.ok, ...(backendStatus[b.id]?.ok ? {} : { reason: backendStatus[b.id]?.reason || null }),
      })));
    }
    const bm = url.pathname.match(/^\/api\/backends\/([\w-]+)\/models$/);
    if (bm && req.method === 'GET') { // the models a backend offers (for the pickers); [] when it can't list them
      const b = BACKENDS[bm[1]];
      if (!b || !backendEnabled(b.id)) return json(res, 404, { error: 'no such backend' });
      return json(res, 200, await backendModels(b, url.searchParams.has('refresh')));
    }
    if (url.pathname === '/api/accounts' && req.method === 'POST') {
      const r = addAccount(await readBody(req));
      if (r.error) return json(res, r.code, { error: r.error });
      const auth = await accountAuth(false);
      return json(res, 201, { ...accountSummary(r.account), ...auth[r.account.name] });
    }
    if (url.pathname === '/api/accounts/default' && (req.method === 'GET' || req.method === 'PUT')) {
      if (req.method === 'GET') return json(res, 200, defaultAccounts());
      const r = setDefaultAccount(await readBody(req));
      return r.error ? json(res, r.code, { error: r.error }) : json(res, 200, r.defaults);
    }
    const acm = url.pathname.match(/^\/api\/accounts\/([\w-]+)(\/save)?$/);
    if (acm && (acm[2] ? req.method === 'POST' : req.method === 'DELETE')) {
      const r = acm[2] ? saveAliasAccount(acm[1]) : removeAccount(acm[1]);
      return r.error ? json(res, r.code, { error: r.error }) : json(res, 200, r.account ? accountSummary(r.account) : r);
    }
    if (url.pathname === '/api/accounts') {
      const auth = await accountAuth(url.searchParams.has('refresh'));
      return json(res, 200, Object.values(accounts).map((a) => ({ ...accountSummary(a), ...auth[a.name] })));
    }
    if (url.pathname === '/api/limits') return json(res, 200, await accountLimits(url.searchParams.has('refresh')));

    if (url.pathname === '/api/agents' && req.method === 'GET') // a regular agent sees itself and the agents it started
      return json(res, 200, [...agents.values()].filter((a) => !me || me.role === 'conductor' || a.id === me.id || a.parentId === me.id).map((a) => a.summary()));

    if (url.pathname === '/api/agents' && req.method === 'POST') {
      const body = await readBody(req);
      if (fromPeer) delete body.parentId; // the caller's agent ids mean nothing here
      if (me) body.parentId = me.id; // an agent's token: what it starts is its child, with a child's limits
      const history = await otherCliHistory(body);
      if (history?.error) return json(res, history.code, { error: history.error });
      const r = await spawnAgentInWorktree(body, { startedBy, history: history?.events });
      return r.error ? json(res, r.code, { error: r.error }) : json(res, 201, r.agent.summary());
    }

    if (url.pathname === '/api/uploads' && req.method === 'POST') { // before an agent exists: staged, claimed by POST /api/agents { uploads: [id] }
      const sid = crypto.randomUUID(), len = Number(req.headers['content-length']) || 0;
      if (stagedBytes() + len > STAGE_MAX) { req.resume(); return json(res, 507, { error: `too many unclaimed uploads (over ${mb(STAGE_MAX)} MB); start the agent or try again later` }); }
      const r = await receiveUpload(req, path.join(STAGE_ROOT, sid), url.searchParams.get('name'));
      if (r.error) { fs.rmSync(path.join(STAGE_ROOT, sid), { recursive: true, force: true }); return json(res, r.code, { error: r.error }); }
      return json(res, 201, { id: sid, ...r });
    }

    if (url.pathname.startsWith('/api/rooms') && await rooms.handle(req, url, res, { json, readBody })) return;
    if (url.pathname.startsWith('/api/bots') && await bots.handle(req, url, res, { json, readBody })) return;

    // ---- approvals inbox
    if (url.pathname === '/api/approvals' && req.method === 'GET') return json(res, 200, approvalList());
    const am = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (am && req.method === 'POST') {
      const { decision, answers } = await readBody(req);
      if (!DECISIONS.includes(decision)) return json(res, 400, { error: 'decision must be allow, always, deny or answer' });
      const p = pending.get(am[1]);
      const r = p && p.agent.resolvePermission(am[1], decision, undefined, answers);
      return r?.error ? json(res, 400, r) : r ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such pending request' });
    }

    // ---- Web Push subscriptions
    if (url.pathname === '/api/push/key' && req.method === 'GET')
      return json(res, 200, { publicKey: vapid.publicKey, httpsUrl: PUBLIC_URL(), subscriptions: q.allSubs.all().length });
    if (url.pathname === '/api/push/subscribe' && req.method === 'POST') {
      const { subscription } = await readBody(req);
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth || !/^https:\/\//.test(subscription.endpoint))
        return json(res, 400, { error: 'not a valid PushSubscription' });
      q.putSub.run(subscription.endpoint, JSON.stringify(subscription), String(req.headers['user-agent'] || '').slice(0, 200), Date.now());
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/push/unsubscribe' && req.method === 'POST') {
      const { endpoint } = await readBody(req);
      q.delSub.run(String(endpoint || ''));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/push/test' && req.method === 'POST') {
      const r = await sendWebPush({ kind: 'done', title: APP_NAME, body: 'Test notification', tag: 'test', url: '/' });
      return r.total ? json(res, 200, r) : json(res, 400, { error: 'no device has enabled notifications yet' });
    }

    // ---- notification settings (ntfy is off until enabled here)
    if (url.pathname === '/api/settings/notify') { // which events push, with or without details, and this app's HTTPS address (ntfy is a plugin now)
      if (req.method === 'GET') { const { publicUrl, details, events } = notifySettings(); return json(res, 200, { publicUrl, details, events }); }
      if (req.method === 'PUT') {
        const b = await readBody(req), cur = notifySettings();
        const next = {
          ...cur,
          publicUrl: String(b.publicUrl ?? cur.publicUrl).trim(),
          details: !!(b.details ?? cur.details),
          events: Object.fromEntries(Object.keys(NOTIFY_DEFAULTS.events).map((k) => [k, !!(b.events?.[k] ?? cur.events[k])])),
        };
        q.putSetting.run('notify', JSON.stringify(next));
        return json(res, 200, { publicUrl: next.publicUrl, details: next.details, events: next.events });
      }
    }

    // ---- usage, thresholds, watchdog settings
    if (url.pathname === '/api/usage' && req.method === 'GET') return json(res, 200, usageReport(Math.min(Math.max(parseInt(url.searchParams.get('days'), 10) || 14, 1), 365)));
    if (url.pathname === '/api/settings/usage') {
      if (req.method === 'GET') return json(res, 200, usageAlertsCfg());
      if (req.method === 'PUT') {
        const b = await readBody(req), next = { accounts: {} };
        for (const [name, v] of Object.entries(b.accounts || {})) {
          if (!accounts[name]) return json(res, 400, { error: `unknown account ${name}` });
          const dailyCost = Number(v?.dailyCost) || 0, dailyTokens = Math.round(Number(v?.dailyTokens) || 0);
          if (dailyCost < 0 || dailyTokens < 0 || !Number.isFinite(dailyCost + dailyTokens)) return json(res, 400, { error: 'thresholds must be positive numbers (empty or 0 = off)' });
          if (dailyCost || dailyTokens) next.accounts[name] = { dailyCost, dailyTokens };
        }
        putCfg('usage_alerts', next);
        return json(res, 200, next);
      }
    }
    if (url.pathname === '/api/settings/watchdog') {
      if (req.method === 'GET') return json(res, 200, watchdogCfg());
      if (req.method === 'PUT') {
        const b = await readBody(req), cur = watchdogCfg();
        const next = { enabled: !!(b.enabled ?? cur.enabled), idleMinutes: Number(b.idleMinutes ?? cur.idleMinutes), toolMinutes: Number(b.toolMinutes ?? cur.toolMinutes), startMinutes: Number(b.startMinutes ?? cur.startMinutes), repeatCount: Math.round(Number(b.repeatCount ?? cur.repeatCount)) };
        if (!(next.idleMinutes >= 1 && next.idleMinutes <= 1440)) return json(res, 400, { error: 'idle minutes must be between 1 and 1440' });
        if (!(next.toolMinutes >= 1 && next.toolMinutes <= 1440)) return json(res, 400, { error: 'minutes during a tool call must be between 1 and 1440' });
        if (!(next.startMinutes >= 1 && next.startMinutes <= 1440)) return json(res, 400, { error: 'minutes without a response must be between 1 and 1440' });
        if (!(next.repeatCount >= 2 && next.repeatCount <= 100)) return json(res, 400, { error: 'repeat count must be between 2 and 100' });
        putCfg('watchdog', next);
        return json(res, 200, next);
      }
    }
    if (url.pathname === '/api/settings/agents') { // defaults for new agents: permission mode, model, effort; built-in subagents for all
      if (req.method === 'GET') return json(res, 200, { ...agentDefaults(), efforts: EFFORTS, modes: PERMISSION_MODES });
      if (req.method === 'PUT') {
        const b = await readBody(req), cur = agentDefaults(), me = modelEffortOf(b);
        if (me.error) return json(res, 400, { error: me.error });
        const next = { permissionMode: b.permissionMode || cur.permissionMode, model: me.model === undefined ? cur.model : me.model || '', effort: me.effort === undefined ? cur.effort : me.effort || '',
          builtinSubagents: b.builtinSubagents === undefined ? !!cur.builtinSubagents : b.builtinSubagents === true || b.builtinSubagents === 'true' };
        if (!PERMISSION_MODES.includes(next.permissionMode)) return json(res, 400, { error: 'permissionMode must be one of ' + PERMISSION_MODES.join(', ') });
        // other CLIs: { perBackend: { opencode: { permissionMode, model, effort } } }; only what the CLI supports is accepted
        next.perBackend = { ...(cur.perBackend || {}) };
        if (b.perBackend !== undefined) {
          if (!b.perBackend || typeof b.perBackend !== 'object' || Array.isArray(b.perBackend)) return json(res, 400, { error: 'perBackend must be an object keyed by CLI id' });
          for (const [id, v] of Object.entries(b.perBackend)) {
            const be = BACKENDS[id];
            if (!be || id === DEFAULT_BACKEND) return json(res, 400, { error: `perBackend: no such CLI ${id} (Claude's defaults are the top-level ones)` });
            const old = { ...OTHER_CLI_DEFAULTS, ...(next.perBackend[id] || {}) }, model = v?.model === undefined ? old.model : String(v.model || '').trim();
            if (model && !validModel(model)) return json(res, 400, { error: `${be.label}: not a model name` });
            const mode = v?.permissionMode || old.permissionMode, effort = v?.effort === undefined ? old.effort : v.effort || '';
            if (!be.capabilities.modes.includes(mode)) return json(res, 400, { error: `${be.label} agents can't use permission mode ${mode} (they can: ${be.capabilities.modes.join(', ')})` });
            if (effort && !be.capabilities.effort.includes(effort)) return json(res, 400, { error: be.capabilities.effort.length ? `${be.label}: effort must be one of ${be.capabilities.effort.join(', ')}` : `${be.label} has no effort setting` });
            next.perBackend[id] = { permissionMode: mode, model, effort };
          }
        }
        putCfg('agent_defaults', next);
        return json(res, 200, next);
      }
    }
    if (url.pathname === '/api/settings/context') {
      if (req.method === 'GET') return json(res, 200, contextCfg());
      if (req.method === 'PUT') {
        const b = await readBody(req), cur = contextCfg(), next = {};
        for (const k of Object.keys(CONTEXT_DEFAULTS)) {
          const v = b[k] ?? cur[k];
          next[k] = typeof CONTEXT_DEFAULTS[k] === 'boolean' ? !!v : Number(v);
        }
        for (const k of ['warn', 'high', 'recycleTokens', 'conductorTokens']) if (!(next[k] >= 1000 && next[k] <= 2_000_000)) return json(res, 400, { error: 'token thresholds must be between 1,000 and 2,000,000' });
        if (next.high < next.warn) return json(res, 400, { error: 'the high threshold must not be below the warning threshold' });
        for (const k of ['recycleIdleHours', 'conductorIdleHours']) if (!(next[k] >= 0.1 && next[k] <= 720)) return json(res, 400, { error: 'idle hours must be between 0.1 and 720' });
        if (next.autoCompactWindow && !(next.autoCompactWindow >= 100_000 && next.autoCompactWindow <= 1_000_000)) return json(res, 400, { error: 'the auto-compact window must be between 100,000 and 1,000,000 tokens (Claude Code ignores other values), or empty for its default' });
        next.autoCompactWindow = Math.round(next.autoCompactWindow || 0);
        putCfg('context', next);
        for (const a of agents.values()) a.ctxAlerted = a.ctx >= next.high; // new thresholds: no burst of pushes
        broadcast({ type: 'context_cfg', cfg: next });
        return json(res, 200, next);
      }
    }

    // ---- full-text search over event history
    if (url.pathname === '/api/search' && req.method === 'GET') {
      const terms = (url.searchParams.get('q') || '').split(/\s+/).filter(Boolean).slice(0, 8);
      if (!terms.length) return json(res, 200, []);
      const match = terms.map((t, i) => `"${t.replace(/"/g, '""')}"${i === terms.length - 1 ? '*' : ''}`).join(' ');
      const only = url.searchParams.get('agent');
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 40, 1), 100);
      try {
        const rows = db.prepare(`SELECT f.rowid AS id, f.agent_id AS agentId, e.ts, snippet(events_fts, 0, char(1), char(2), '…', 24) AS snippet
          FROM events_fts f JOIN events e ON e.id = f.rowid WHERE events_fts MATCH ?${only ? ' AND f.agent_id = ?' : ''} ORDER BY f.rowid DESC LIMIT ?`)
          .all(...[match, ...(only ? [only] : []), limit]);
        return json(res, 200, rows.filter((r) => agents.has(r.agentId)).map((r) => ({ ...r, agentName: agents.get(r.agentId).name, index: searchBefore.get(r.agentId, r.id).n, total: agents.get(r.agentId).events.length })));
      } catch (e) { return json(res, 400, { error: 'could not search: ' + e.message }); }
    }

    // ---- git probe for the new-agent dialog
    if (url.pathname === '/api/git/probe' && req.method === 'GET') {
      const dir = url.searchParams.get('path') || '';
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(res, 400, { error: 'not a folder' });
      return json(res, 200, await gitt.probe(dir));
    }

    // ---- backlog tasks
    if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, allTasks());
    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const r = saveTask(null, await readBody(req), startedBy);
      return r.error ? json(res, r.code, { error: r.error }) : json(res, 201, r.task);
    }
    if (url.pathname === '/api/tasks/reorder' && req.method === 'POST') {
      const { ids } = await readBody(req);
      if (!Array.isArray(ids) || !ids.every((x) => Number.isSafeInteger(x) && x > 0)) return json(res, 400, { error: 'ids must be an array of task ids' });
      db.transaction(() => ids.forEach((id, i) => q.setPos.run(i + 1, id)))();
      broadcastTasks();
      return json(res, 200, allTasks());
    }
    const tm = url.pathname.match(/^\/api\/tasks\/(\d+)(?:\/(assign))?$/);
    if (tm) {
      const id = Number(tm[1]);
      if (!tm[2] && req.method === 'GET') return q.getTask.get(id) ? json(res, 200, taskOut(q.getTask.get(id))) : json(res, 404, { error: 'no such task' });
      if (!tm[2] && (req.method === 'PATCH' || req.method === 'PUT')) {
        const r = saveTask(id, await readBody(req));
        return r.error ? json(res, r.code, { error: r.error }) : json(res, 200, r.task);
      }
      if (!tm[2] && req.method === 'DELETE') {
        if (!q.getTask.get(id)) return json(res, 404, { error: 'no such task' });
        q.delTask.run(id);
        broadcastTasks();
        return json(res, 200, { ok: true });
      }
      if (tm[2] && req.method === 'POST') {
        const body = await readBody(req);
        if (fromPeer) delete body.parentId;
        if (me && !body.agentId) body.parentId = me.id;
        const r = assignTask(id, body, startedBy);
        return r.error ? json(res, r.code, { error: r.error }) : json(res, 200, r);
      }
    }

    // ---- schedules (recurring tasks)
    // swarm-mcp.js names the calling agent in x-halay-agent: a regular agent may change only the schedules it added;
    // the conductor and the UI (no header) may change any
    const schedCaller = startedBy || String(req.headers['x-halay-agent'] || '') || null;
    const schedLimited = !fromPeer && schedCaller && agents.get(schedCaller)?.role !== 'conductor';
    if (url.pathname === '/api/schedules' && req.method === 'GET') return json(res, 200, allSchedules());
    if (url.pathname === '/api/schedules' && req.method === 'POST') {
      const r = saveSchedule(null, await readBody(req), schedCaller, fromPeer ? null : agents.get(schedCaller) || null);
      return r.error ? json(res, r.code, { error: r.error }) : json(res, 201, r.schedule);
    }
    if (url.pathname === '/api/schedules/preview' && req.method === 'GET') { // the form's live check: description and next runs
      const tz = url.searchParams.get('tz') || LOCAL_TZ;
      if (!validTz(tz)) return json(res, 400, { error: `unknown time zone "${tz}"` });
      try {
        const next = cronOf(url.searchParams.get('cron'), tz).nextRuns(3).map((d) => d.getTime());
        if (!next.length) return json(res, 400, { error: 'that cron never matches a future time' });
        return json(res, 200, { description: describeCron(url.searchParams.get('cron')), next, tz });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    const sm = url.pathname.match(/^\/api\/schedules\/(\d+)(?:\/(run))?$/);
    if (sm) {
      const id = Number(sm[1]), s = q.getSchedule.get(id);
      if (!s) return json(res, 404, { error: 'no such schedule' });
      if (!sm[2] && req.method === 'GET') return json(res, 200, { ...scheduleOut(s), runs: q.schedRuns.all(id).map((t) => taskOut(t)) });
      if (schedLimited && s.created_by !== schedCaller)
        return json(res, 403, { error: `schedule ${id} was added by ${s.created_by ? 'agent ' + s.created_by : 'the user'}; you can only change, delete or run the schedules you added` });
      if (!sm[2] && (req.method === 'PATCH' || req.method === 'PUT')) {
        const r = saveSchedule(id, await readBody(req), null, fromPeer ? null : agents.get(schedCaller) || null);
        return r.error ? json(res, r.code, { error: r.error }) : json(res, 200, r.schedule);
      }
      if (!sm[2] && req.method === 'DELETE') { deleteSchedule(id); return json(res, 200, { ok: true }); }
      if (sm[2] && req.method === 'POST') { // run now; next_run_at is left as it is
        const r = runSchedule(s);
        if (r.budget) { skipRun(s, r.error, false); broadcastSchedules(); }
        return r.error && !r.task ? json(res, r.code, { error: r.error }) : json(res, 200, { task: r.task, agent: r.agent, error: r.error });
      }
    }

    const em = url.pathname.match(/^\/api\/agents\/([^/]+)\/edit\/(\w+)$/);
    if (em) {
      const agent = agents.get(em[1]);
      if (!agent) return json(res, 404, { error: 'no such agent' });
      const [code, body] = await editFs.route(agent, em[2], req, url);
      return json(res, code, body);
    }
    const gm = url.pathname.match(/^\/api\/agents\/([^/]+)\/git(?:\/(\w+))?$/);
    if (gm) {
      const agent = agents.get(gm[1]);
      if (!agent) return json(res, 404, { error: 'no such agent' });
      try { return await gitRoute(agent, gm[2], req, url, res); }
      catch (e) { return json(res, typeof e.code === 'number' ? e.code : 500, { error: e.message }); }
    }
    const um = url.pathname.match(/^\/api\/agents\/([^/]+)\/usage$/);
    if (um && req.method === 'GET') {
      const agent = agents.get(um[1]);
      if (!agent) return json(res, 404, { error: 'no such agent' });
      return json(res, 200, { totals: agent.usage, turns: q.agentTurns.all(agent.id) });
    }

    const sam = url.pathname.match(/^\/api\/agents\/([^/]+)\/subagent\/([\w-]+)$/);
    if (sam && req.method === 'GET') { // a (background) subagent's own transcript, for the Details view on its card
      const agent = agents.get(sam[1]);
      if (!agent) return json(res, 404, { error: 'no such agent' });
      return json(res, 200, subagentTranscript(agent, sam[2], Math.max(0, Number(url.searchParams.get('after')) || 0)));
    }

    const fm = url.pathname.match(/^\/api\/agents\/([^/]+)\/events\/(\d+)$/);
    if (fm && req.method === 'GET') { // one event in full, for the "show full" taps on slimmed events
      const ev = agents.get(fm[1])?.events[Number(fm[2])];
      return ev ? json(res, 200, ev) : json(res, 404, { error: 'no such event' });
    }

    const m = url.pathname.match(/^\/api\/agents\/([^/]+)(?:\/(\w+))?$/);
    if (m) {
      const agent = agents.get(m[1]);
      if (!agent) return json(res, 404, { error: 'no such agent' });
      const action = m[2];
      if (!action && req.method === 'GET') {
        // No params: the last AGENT_EVENTS_DEFAULT events, untouched (swarm-mcp reads this); ?all=1: every event, untouched.
        // The UI asks for a slim window instead:
        //   ?tail=N            the last N events (slimEvent'd); `from` is the index of the first one; `pending` holds
        //                      approvals still waiting from before the window ({ i, event })
        //   ?before=F&limit=L  the L events ending just before index F (Load earlier)
        // Indexes are absolute positions in the agent's history, the same ones search results use. Todos, usage and
        // the rest of the summary are computed server-side over the whole history, so the window doesn't affect them.
        const tail = parseInt(url.searchParams.get('tail'), 10), before = parseInt(url.searchParams.get('before'), 10);
        if (me && url.searchParams.get('seen') === '1' && agent.status !== 'running') agent.noticeSeen(me.id); // read_agent: the caller has read its result
        const all = agent.events;
        if (before >= 0) {
          const to = Math.min(before, all.length), from = Math.max(0, to - (parseInt(url.searchParams.get('limit'), 10) || 200));
          return json(res, 200, { id: agent.id, events: all.slice(from, to).map(slimEvent), from, total: all.length });
        }
        const raw = !(tail > 0), from = raw && url.searchParams.get('all') === '1' ? 0 : Math.max(0, all.length - (raw ? AGENT_EVENTS_DEFAULT : tail)), open = new Map();
        for (let i = 0; i < from; i++) { const e = all[i]; if (e.type === 'permission_request') open.set(e.reqId, i); else if (e.type === 'permission_resolved') open.delete(e.reqId); }
        const pending = [...open.values()].map((i) => ({ i, event: raw ? all[i] : slimEvent(all[i]) }));
        return json(res, 200, { ...agent.summary(), events: raw ? all.slice(from) : all.slice(from).map(slimEvent), from, total: all.length, pending });
      }
      if (action === 'upload' && req.method === 'POST') {
        const r = await receiveUpload(req, path.join(tmpDirFor(agent.id), 'uploads'), url.searchParams.get('name'));
        return r.error ? json(res, r.code, { error: r.error }) : json(res, 201, r);
      }
      if (action === 'send' && req.method === 'POST') {
        const { text } = await readBody(req);
        if (typeof text !== 'string' || !text.trim()) return json(res, 400, { error: 'text must be a non-empty string' });
        if (!agent.send(text, me ? { by: me.id } : undefined)) return json(res, 409, { error: 'not delivered: ' + agent.sendError });
        return json(res, 200, { ok: true });
      }
      if (action === 'permission' && req.method === 'POST') {
        const { reqId, decision, answers } = await readBody(req);
        if (!DECISIONS.includes(decision)) return json(res, 400, { error: 'decision must be allow, always, deny or answer' });
        const r = agent.resolvePermission(reqId, decision, undefined, answers);
        return r?.error ? json(res, 400, r) : r ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such pending request' });
      }
      if (action === 'reset' && req.method === 'POST') {
        // fresh context: the next message starts a new Claude session (the chat above stays for reference)
        if (agent.status === 'running') return json(res, 409, { error: 'agent is busy; reset when it is idle' });
        if (agent.handoff) return json(res, 409, { error: 'a handoff is in progress' });
        agent.resetContext();
        return json(res, 200, { ok: true });
      }
      if (action === 'refresh' && req.method === 'POST') {
        // fresh context with handoff; wait: true answers when the note is written and the context reset
        const { message, wait } = await readBody(req);
        const r = await agent.startHandoff({ message: typeof message === 'string' && message.trim() ? message : null });
        if (r.error) return json(res, r.code, { error: r.error });
        if (!wait) return json(res, 202, { ok: true, started: true });
        const out = await r.done;
        return out.error ? json(res, 502, { error: out.error }) : json(res, 200, { ok: true, words: out.note.split(/\s+/).length, continued: !!message });
      }
      if (action === 'wait' && req.method === 'POST') {
        const { timeout = 300 } = await readBody(req);
        return json(res, 200, await agent.waitIdle(Math.min(Math.max(Number(timeout) || 300, 1), 1800), me?.id));
      }
      if (action === 'files' && req.method === 'GET') {
        // Markdown viewer: list folders and .md files under the agent's folder
        const dir = within(agent.cwd, url.searchParams.get('path') || '');
        if (!dir) return json(res, 400, { error: 'path outside the agent folder' });
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          const dirs = entries.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => d.name);
          const files = entries.filter((d) => d.isFile() && /\.(md|markdown)$/i.test(d.name)).map((d) => d.name);
          return json(res, 200, { dirs: dirs.sort(), files: files.sort() });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (action === 'file' && req.method === 'GET') {
        const file = within(agent.cwd, url.searchParams.get('path') || '');
        if (!file || !/\.(md|markdown)$/i.test(file)) return json(res, 400, { error: 'not a markdown file in the agent folder' });
        try {
          if (fs.statSync(file).size > 2_000_000) return json(res, 400, { error: 'file too large' });
          return json(res, 200, { content: fs.readFileSync(file, 'utf8') });
        } catch (e) { return json(res, 404, { error: e.message }); }
      }
      if (action === 'fileurl' && req.method === 'POST') { // signed, short-lived URL for the file viewer
        const { path: p } = await readBody(req);
        try { return json(res, 200, signFile(agent, p)); }
        catch (e) { return json(res, typeof e.code === 'number' ? e.code : 500, { error: e.message, outside: !!e.outside }); }
      }
      if (action === 'mode' && req.method === 'POST') {
        // like shift+tab in the CLI: takes effect by restarting the process, which resumes the session
        const { permissionMode } = await readBody(req);
        if (!PERMISSION_MODES.includes(permissionMode))
          return json(res, 400, { error: 'unknown mode' });
        if (!agent.be.capabilities.modes.includes(permissionMode)) return json(res, 400, { error: `${agent.be.label} agents can't use permission mode ${permissionMode} (they can: ${agent.be.capabilities.modes.join(', ')})` });
        if (agent.status === 'running') return json(res, 409, { error: 'agent is busy; change the mode when it is idle' });
        agent.permissionMode = permissionMode;
        q.setMode.run(permissionMode, agent.id);
        agent.killProc();
        broadcast({ type: 'agent', agent: agent.summary() });
        return json(res, 200, { ok: true });
      }
      if (action === 'model' && req.method === 'POST') {
        // model and/or effort ('' or null = the default); like the mode, applies by restarting the process, which resumes the session
        const b = await readBody(req), me = modelEffortOf(b);
        if (me.error) return json(res, 400, { error: me.error });
        if (agent.bot) return json(res, 409, { error: `this is bot @${agent.bot}: change its model on the Bots page (update_bot)` });
        if (agent.status === 'running' || agent.handoff) return json(res, 409, { error: 'agent is busy; change the model when it is idle' });
        const model = me.model !== undefined ? me.model : agent.model, effort = me.effort !== undefined ? me.effort : agent.effort;
        if (effort && !agent.be.capabilities.effort.includes(effort)) return json(res, 400, { error: `${agent.be.label} has no effort ${effort}` });
        if (model !== agent.model || effort !== agent.effort) {
          agent.model = model; agent.effort = effort;
          q.setModel.run(model, effort, agent.id);
          agent.killProc();
          broadcast({ type: 'agent', agent: agent.summary() });
        }
        return json(res, 200, { ok: true, model, effort });
      }
      if (action === 'remote' && req.method === 'POST') {
        const { enabled } = await readBody(req);
        if (enabled) agent.startRemote(); else agent.stopRemote();
        return json(res, 200, agent.remote);
      }
      if (action === 'seen' && req.method === 'POST') { // the user looked at this agent
        if (agent.attention) { agent.attention = null; broadcast({ type: 'agent', agent: agent.summary() }); }
        return json(res, 200, { ok: true });
      }
      if (action === 'hidden' && req.method === 'POST') { // list-only: never touches the process
        const { hidden } = await readBody(req);
        agent.hidden = !!hidden && agent.role !== 'conductor';
        q.setHidden.run(agent.hidden ? 1 : 0, agent.id);
        broadcast({ type: 'agent', agent: agent.summary() });
        return json(res, 200, { ok: true, hidden: agent.hidden });
      }
      if (action === 'start' && req.method === 'POST') {
        // start a stopped agent's process without a message: it resumes its session and waits idle, so it picks up a new
        // swarm MCP server and instructions (after an update) with no turn. The user's call only (not an agent's token).
        if (agent.pid) return json(res, 200, { ok: true, already: true, agent: agent.summary() });
        if (agent.handoff) return json(res, 409, { error: 'a handoff is in progress' });
        if (agent.bot && bots.isPaused(agent.bot)) return json(res, 409, { error: `bot @${agent.bot} is paused` });
        if (!fs.existsSync(agent.cwd)) return json(res, 400, { error: `folder ${agent.cwd} no longer exists` });
        if (!agent.start()) return json(res, 500, { error: 'failed to start ' + agent.be.bin });
        agent.setStatus('idle');
        return json(res, 200, { ok: true, agent: agent.summary() });
      }
      if (action === 'interrupt' && req.method === 'POST') {
        if (me && me.id === agent.parentId) agent.armed = false; // the parent stopped it: no need to tell the parent
        agent.stopRequested = true;
        agent.stop();
        return json(res, 200, { ok: true });
      }
      if (action === 'focus' && req.method === 'POST') { // the conductor moves the user's view to one of the agents it started
        const { parentId } = await readBody(req);
        const caller = me || (parentId && agents.get(parentId));
        if (caller?.role !== 'conductor' || agent.parentId !== caller.id) return json(res, 403, { error: 'only the conductor can open agents it started' });
        broadcast({ type: 'focus', agentId: agent.id });
        return json(res, 200, { ok: true });
      }
      if (!action && req.method === 'DELETE') {
        if (agent.role === 'conductor') return json(res, 403, { error: 'the swarm chat (conductor) cannot be removed' });
        if (agent.bot) return json(res, 409, { error: `this is bot @${agent.bot}: delete it on the Bots page (a bot is permanent)`, bot: agent.bot });
        if (agent.wt && fs.existsSync(agent.wt.path) && url.searchParams.get('discard') !== '1') { // its tmp dir (and worktree) goes with it
          const risk = await gitt.worktreeRisk(agent.wt.path).catch(() => null);
          if (risk?.dirty) return json(res, 409, { error: `the worktree has ${risk.dirty} uncommitted or untracked file(s) that would be lost`, worktree: risk });
        }
        if (agent.oneOff && url.searchParams.get('discard') !== '1') { // the scratch folder goes with it, the conversation stays
          const files = fs.existsSync(agent.cwd) ? fs.readdirSync(agent.cwd).length : 0;
          if (files) return json(res, 409, { error: `the one-off folder still has ${files} item(s) that would be deleted (the conversation is kept)`, oneOff: { path: agent.cwd, items: files } });
        }
        removeAgent(agent);
        return json(res, 200, { ok: true });
      }
    }

    // Folder browser (server-side, since browsers can't expose real paths)
    if (url.pathname === '/api/fs') {
      const dir = path.resolve(url.searchParams.get('path') || os.homedir());
      try {
        const dirs = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .map((d) => d.name)
          .sort((a, b) => a.localeCompare(b));
        return json(res, 200, { path: dir, parent: path.dirname(dir), dirs });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    // ---- terminals (terminal.js) and server restart
    if (url.pathname.startsWith('/api/terminals') && await termApi(req, res, url, { json, readBody, agentCwd: (id) => agents.get(id)?.cwd || null, extraEnv: TERM_ENV })) return;
    if (url.pathname === '/api/server' && req.method === 'GET') return json(res, 200, { name: APP_NAME, version: APP_VERSION, installKind: INSTALL_KIND, pid: process.pid, startedAt: STARTED_AT, restartMode: restartMode(), node: process.version, dataDir: DATA_DIR, serverLog: SERVER_LOG, pathWarnings: PATH_WARNINGS,
      https: HTTPS_ON ? { port: HTTPS_PORT, urls: httpsUrls(), source: TLS.source, expires: tlsState.expires ? new Date(tlsState.expires).toISOString() : null, lastCheck: tlsState.lastCheck, warnings: tlsState.warnings } : null });
    if (url.pathname === '/api/server/tls-reload' && req.method === 'POST') { // `halay cert renew` / `install`: serve the files on disk now, no restart
      if (!httpsServer) return json(res, 200, { reloaded: false, reason: 'HTTPS is not on in this server; restart it' });
      try { tlsCheck(); reloadTls(); return json(res, 200, { reloaded: true, expires: tlsState.expires ? new Date(tlsState.expires).toISOString() : null }); } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (url.pathname === '/api/server/restart' && req.method === 'POST') {
      try { const mode = restartServer(); return json(res, 200, { ok: true, mode }); }
      catch (e) { return json(res, 500, { error: e.message }); }
    }
    return json(res, 404, { error: 'not found' });
  }

  if (url.pathname === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({
      name: APP_NAME, short_name: APP_SHORT_NAME, start_url: '/', scope: '/', display: 'standalone',
      background_color: BRAND_SURFACE, theme_color: BRAND_SURFACE,
      icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }, { src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' }, { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
    }));
  }

  // static: kept in memory with precomputed br/gzip (re-read when the file's mtime changes) and an ETag.
  // html/js/css revalidate on every load (a 304 is tiny, and edits show up at once); images and vendor libs are cached for a day.
  // Without a session only the login page and what it needs are served; everything else is 401.
  const isRoot = url.pathname === '/' || url.pathname === '/index.html';
  let loginPage = false;
  if (!auth.session(req)) {
    if (isRoot) loginPage = true;
    else if (!LOGIN_PUBLIC.has(url.pathname)) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('unauthorized'); }
  }
  const vendor = url.pathname.startsWith('/vendor/') && !loginPage ? vendorFile(url.pathname) : null;
  const pluginFile = url.pathname.startsWith('/plugins/') && !loginPage ? pluginHost.staticFile(url.pathname) : null; // a running plugin's UI files
  const file = vendor || pluginFile || path.join(ROOT, 'public', loginPage ? 'login.html' : url.pathname === '/' ? 'index.html' : url.pathname);
  if ((!vendor && !pluginFile && !file.startsWith(path.join(ROOT, 'public'))) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  const ext = path.extname(file), asset = staticAsset(file, ext);
  const enc = asset.compressible ? pickEncoding(req, true) : '';
  const body = enc === 'br' ? asset.br : enc === 'gzip' ? asset.gz : enc === 'deflate' ? asset.deflate : asset.raw;
  // Monaco's chunks have hashed names; its loader and entry files don't, so they revalidate like the app's own
  const longLived = VENDOR[url.pathname] || (vendor && /-[\w-]{8}\.\w+$/.test(file)) || /^\.(png|ico|jpg|webp)$/.test(ext);
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    etag: asset.etag,
    vary: 'Accept-Encoding',
    'cache-control': url.pathname === '/sw.js' ? 'no-cache' : longLived ? 'public, max-age=86400' : 'no-cache',
    ...(loginPage ? { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } : {}),
  };
  if (req.headers['if-none-match'] === asset.etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, ...(enc ? { 'content-encoding': enc } : {}), 'content-length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// one bad request must never take the process down: log it and end the response (500 if nothing was sent yet)
const onRequest = (req, res) => {
  const bail = (e) => {
    if (e?.status === 400 || e?.status === 413) { // a bad request body (readBody): the client's mistake, not ours
      try { if (!res.headersSent) { res.writeHead(e.status, { 'content-type': 'application/json', ...(e.status === 413 ? { connection: 'close' } : {}) }); res.end(JSON.stringify({ error: e.message })); } else res.destroy(); } catch {}
      return;
    }
    console.error(`[http] ${req.method} ${String(req.url).split('?')[0]}:`, e);
    try { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('internal error'); } else res.destroy(); } catch { try { res.destroy(); } catch {} }
  };
  try { Promise.resolve(handleRequest(req, res)).catch(bail); } catch (e) { bail(e); }
};
const server = http.createServer(onRequest);

// ---- HTTPS (cert.js): the same app on HTTPS_PORT. halay's own certificate is checked at start and every 12 h and
// re-issued when it nears expiry or the machine's names changed, then swapped in with setSecureContext (open
// connections keep theirs). A certificate you provide (HALAY_TLS_CERT/KEY) is never written, only warned about.
const tlsState = { expires: null, warnings: [], lastCheck: null };
function tlsCheck() {
  if (!HTTPS_ON) return;
  const r = checkTls({ dataDir: DATA_DIR, tls: TLS });
  tlsState.expires = r.expires; tlsState.warnings = r.warnings; tlsState.lastCheck = new Date().toISOString();
  for (const w of r.warnings) console.warn('https: ' + w);
  if (r.renewed) reloadTls();
}
const tlsFiles = () => ({ cert: fs.readFileSync(TLS.certFile), key: fs.readFileSync(TLS.keyFile) });
function reloadTls() { if (httpsServer) httpsServer.setSecureContext(tlsFiles()); }
let httpsServer = null, tlsTimer = null;
if (HTTPS_ON) {
  tlsCheck();
  try { httpsServer = https.createServer(tlsFiles(), onRequest); }
  catch (e) { console.error(`https: can't use the certificate (${TLS.certFile}): ${e.message}; HTTPS is off`); }
  if (httpsServer) tlsTimer = setInterval(() => { try { tlsCheck(); } catch (e) { console.error('https: check failed:', e.message); } }, Number(env('TLS_CHECK_SECONDS')) * 1000 || CHECK_MS).unref(); // the variable is for tests
}
// the addresses to open it at over HTTPS, for the log and Settings
function httpsUrls() {
  if (!httpsServer) return [];
  if (isLoopback(HOST)) return [`https://localhost:${HTTPS_PORT}/`];
  let names = [];
  try { names = TLS.source === 'halay' ? new crypto.X509Certificate(tlsFiles().cert).subjectAltName.split(/,\s*/).map((s) => s.replace(/^(DNS|IP Address):/, '')) : machineNames({ tsName: null }).names; } catch {}
  names = names.filter((n) => n !== 'localhost' && n !== '127.0.0.1' && !n.includes(':'));
  return (names.length ? names : ['localhost']).map((n) => `https://${n}:${HTTPS_PORT}/`);
}
// GET /halay-ca.crt (no login): the public certificate of halay's own CA, for phones to install. Never anything else.
function serveCaCert(req, res) {
  const f = certPaths(DATA_DIR).caCrt;
  let body = null;
  if (TLS?.source === 'halay') try { body = fs.readFileSync(f); } catch {}
  if (!body || !/^-----BEGIN CERTIFICATE-----/.test(body.toString('latin1'))) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no local CA (halay cert install)'); }
  res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// permessage-deflate: live events and tool output are text. No context takeover so idle sockets cost no zlib memory.
// maxPayload: the browser only ever sends small presence messages
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true, zlibDeflateOptions: { level: 3 } } });
const onUpgrade = (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  // an agent's Playwright MCP server reaches its browser with a key for that profile and agent only (browser.js)
  const kind = browser.cdpKeyOk(url) ? 'cdp-key' : auth.who(req, url);
  // an agent's token opens no websocket (the UI's feed, terminals, the browser viewer)
  if (!kind || kind === 'agent' || (kind === 'session' && !auth.sameOrigin(req))) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  if (url.pathname === '/ws/term') return termUpgrade(req, socket, head, url);
  if (browser.upgrade(req, socket, head, url)) return;
  if (url.pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', (e) => console.error('[ws]', e.message)); // e.g. a message over maxPayload: ws closes the socket itself
    ws.on('message', (m) => {
      try { const j = JSON.parse(m); if (j.type === 'presence') presence.set(ws, { visible: !!j.visible, agentId: j.agentId || null }); } catch {}
    });
    ws.on('close', () => { clients.delete(ws); presence.delete(ws); });
  });
};
server.on('upgrade', onUpgrade);
httpsServer?.on('upgrade', onUpgrade);

// heartbeat: a client that stopped answering pings (sleeping laptop, dropped network) is closed, so it stops getting broadcasts
setInterval(() => {
  for (const ws of clients) {
    if (!ws.alive) { ws.terminate(); clients.delete(ws); presence.delete(ws); continue; }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }
}, 30_000).unref();

onTermsChange(() => broadcast({ type: 'terminals', terminals: listTerms() }));
initTerms({ runs: RUNS }); // reconnects to the terminals' host (pty-host.js) left running by the last server

// Agents and terminals are detached and keep running across restarts (that's the point). Remote Control servers
// aren't, so stop those. HALAY_KILL_AGENTS=1 also stops the agents and terminals, e.g. for a clean shutdown.
function shutdown(code = 0) {
  for (const a of agents.values()) {
    if (a.remoteProc) a.remoteProc.kill('SIGTERM');
    if (env('KILL_AGENTS')) a.killProc();
  }
  if (env('KILL_AGENTS')) killAllTerms();
  if (tlsTimer) clearInterval(tlsTimer);
  Promise.race([pluginHost.stop(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {}).finally(() => process.exit(code)); // plugins get up to 2 s
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
// a stray error in a plugin, timer or callback is logged and the server keeps serving; before it listens (e.g. the
// port is taken) there is nothing to keep alive, so it exits
let listening = false;
process.on('uncaughtException', (e) => { console.error('uncaught exception:', e); if (!listening) process.exit(1); });
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

// ---- restart (Settings → Restart server, POST /api/server/restart, SIGUSR2 = `swarm-restart` in a swarm terminal)
// A detached helper (restart-helper.js, own session, so it survives this process and its terminals) waits for us to
// exit and starts `node src/server.js` again with the launch environment, logging to runs/server.log.
// 'spawn': it starts the server right away. 'exit': we exit with code 75 so a supervisor (npm run dev, pm2, systemd,
// launchd) restarts us, and the helper only starts the server if nothing listens on the port after 20 s.
// Decided at startup from the parent process, not from env vars like DEV or INVOCATION_ID alone, which leak into
// agents' and terminals' environments (a server started by the helper still has the helper as its parent then).
const STARTED_AT = Date.now();
const RESTART_EXIT = 75;
const SERVER_LOG = path.join(RUNS, 'server.log');
// terminals outlive this process, so `swarm-restart` there reads the current server's pid from a file
const PID_FILE = path.join(RUNS, 'server.pid');
const TERM_ENV = { HALAY_PID_FILE: PID_FILE, PATH: `${path.join(ROOT, 'bin')}:${process.env.PATH || ''}` };
const RESTART_MODE = (() => {
  const m = env('RESTART');
  if (m === 'spawn' || m === 'exit') return m;
  if (env('DEV_PID') === String(process.ppid)) return 'exit'; // npm run dev
  if (process.env.pm_id !== undefined && process.send) return 'exit'; // pm2 (talks to us over IPC)
  let parent = '';
  try { parent = execFileSync('ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim(); } catch {}
  const xpc = process.env.XPC_SERVICE_NAME || ''; // the job label under launchd; '0' or application.* for a terminal's (orphaned) child
  if (/(^|\/)launchd$/.test(parent) && xpc && xpc !== '0' && !xpc.startsWith('application.')) return 'exit';
  if (/(^|\/)systemd$/.test(parent) && process.env.INVOCATION_ID) return 'exit';
  return 'spawn';
})();
const restartMode = () => RESTART_MODE;
let restarting = false;
function restartServer() {
  const mode = restartMode();
  if (restarting) return mode;
  const out = fs.openSync(SERVER_LOG, 'a');
  const helper = spawn(process.execPath, [path.join(ROOT, 'src', 'cli', 'restart-helper.js'), String(process.pid), mode, HTTP_HOST, String(PORT), ...process.execArgv, ...process.argv.slice(1)],
    { cwd: process.cwd(), env: LAUNCH_ENV, detached: true, stdio: ['ignore', out, out] });
  helper.unref();
  fs.closeSync(out);
  restarting = true;
  console.log(`restarting (${mode}); the restart helper logs to ${SERVER_LOG}`);
  setTimeout(() => shutdown(mode === 'exit' ? RESTART_EXIT : 0), 300); // let the HTTP answer go out first
  return mode;
}
process.on('SIGUSR2', () => { try { restartServer(); } catch (e) { console.error('restart failed:', e.message); } });

// Dev: reload open browser tabs when UI files change (server code changes restart the process instead).
if (process.env.DEV) {
  let t;
  fs.watch(path.join(ROOT, 'public'), { recursive: true }, () => {
    clearTimeout(t);
    t = setTimeout(() => broadcast({ type: 'reload' }), 100);
  });
}

// CLIs this server is set up to use but can't find on its PATH: claude (always offered), git, every CLI named in
// HALAY_BACKENDS and the CLI of every account saved in Settings. A service (launchd/systemd) doesn't get the PATH of
// your login shell: `halay service install` copies it into the service, so re-run it after installing a new CLI.
// Logged at startup and shown in Settings → Server.
const onPath = (bin) => { try { execFileSync('/bin/sh', ['-c', 'command -v "$0"', bin], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; } };
const PATH_WARNINGS = (() => {
  const want = new Set(['claude', 'git']);
  for (const id of ENABLED_BACKENDS) if (BACKENDS[id]) want.add(BACKENDS[id].bin);
  for (const a of savedAccounts()) if (BACKENDS[a.backend]) want.add(BACKENDS[a.backend].bin);
  const missing = [...want].filter((b) => !onPath(b));
  return missing.map((b) => `\`${b}\` is not on the server's PATH`);
})();
if (PATH_WARNINGS.length) console.warn(`PATH: ${PATH_WARNINGS.join('; ')}. Agents that need it will fail to start. PATH is ${process.env.PATH || '(empty)'}` +
  (RESTART_MODE === 'exit' ? '. Running as a service: install the CLI, then run `halay service install` again so the service gets your shell\'s PATH.' : ''));

server.listen(PORT, HTTP_HOST, () => {
  listening = true;
  fs.writeFileSync(PID_FILE, String(process.pid));
  // where this server listens, for `halay token` / `halay restart` (a --port flag or PORT in a service isn't in .env)
  try { fs.writeFileSync(path.join(RUNS, 'server.json'), JSON.stringify({ pid: process.pid, port: PORT, host: HTTP_HOST, ...(httpsServer && { httpsPort: HTTPS_PORT }) }) + '\n', { mode: 0o600 }); } catch {}
  // a browser URL needs a name, not 127.0.0.1: passkeys (WebAuthn) refuse an IP address as the relying-party id, localhost works
  const base = `http://${['0.0.0.0', '::', '127.0.0.1', '::1'].includes(HTTP_HOST) ? 'localhost' : HTTP_HOST.includes(':') ? `[${HTTP_HOST}]` : HTTP_HOST}:${PORT}/`;
  if (tokenCreated) console.log(`halay running: ${base}?token=${TOKEN} (new access token, saved in ${TOKEN_FILE})`);
  else console.log(`halay running: ${base} (access token: ${env('TOKEN') ? 'the HALAY_TOKEN environment variable' : TOKEN_FILE})`);
  console.log(auth.hasKeys()
    ? 'login: passkeys (the token no longer signs a browser in; it still works for agents and the API). Lost them all? Start once with HALAY_RESET_PASSKEYS=1.'
    : 'login: no passkey yet. Open the URL above (at your HTTPS address if you have one) and choose "Set up your passkey".');
  if (INSTALL_KIND === 'npx') console.log(`Running from npx (temporary). To install for good: ${INSTALL_FOR_GOOD} (your data in ${DATA_DIR} carries over)`);
  warmSessions(); // index History transcripts in the background so the first open is fast
  accountLimits().catch(() => {}); // the first plan-limits reading, so the sidebar has it by the time a page asks
  // ntfy used to be built in: its old settings (the `notify` row) move to the ntfy plugin once, on if it was on
  const ntfySeed = () => { const n = notifySettings(); return n.topic ? { enabled: n.enabled, settings: { server: n.server, topic: n.topic, token: n.token } } : null; };
  if (httpsServer) {
    httpsServer.on('error', (e) => { tlsState.warnings = [...tlsState.warnings, `can't listen on ${HOST}:${HTTPS_PORT} (${e.code || e.message})`]; console.error(`https: can't listen on ${HOST}:${HTTPS_PORT}: ${e.message}`); });
    httpsServer.listen(HTTPS_PORT, HOST, () => console.log(`https: ${httpsUrls().join(' ')} (${TLS.source === 'halay' ? `halay's local CA, ${certPaths(DATA_DIR).caCrt}; phones get it at /halay-ca.crt` : TLS.certFile})${HTTP_HOST !== HOST ? `; plain http only on ${HTTP_HOST}:${PORT}` : ''}`));
  }
  pluginHost.start({ seeds: { ntfy: ntfySeed } }).then(() => { broadcast({ type: 'plugins' }); pluginHost.emit('server.ready', { port: PORT }); })
    .catch((e) => console.error('plugins:', e));
});
