// Plugin host. Finds plugins (plugins-builtin/, the plugins folder and npm packages installed into it),
// keeps their enabled state, granted permissions and settings in halay.db, and runs enabled ones in this process with a
// `ctx` object as their whole API. Plugins are trusted code: permissions decide which ctx members exist (consent and API
// hygiene), they are not a sandbox. Every plugin callback runs guarded, so a failing plugin is logged and, after repeated
// errors, switched off; it never takes the server down. HALAY_PLUGINS=0 starts with every plugin off (safe mode).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP = 'halay'; // manifest key in package.json and npm prefix (halay-plugin-*)
export const PLUGIN_API = '1.0.0';

// what each permission lets a plugin do, in the words the consent dialog shows
export const PERMISSIONS = {
  'events:agents': "see agents' notifications, turn results and approval requests (includes message text)",
  'events:tasks': 'see tasks and scheduled runs as they change',
  'events:rooms': 'see every room message',
  'agents:read': 'list agents and read their summaries',
  'agents:control': 'start agents, send them messages and interrupt them',
  tasks: 'list, add and assign backlog tasks',
  notify: 'send you notifications',
  'notify:channel': 'receive every notification you get (a delivery channel such as Slack or email)',
  mcp: 'give agents new tools that run inside the server',
  routes: 'add API routes under /api/plugins/<id>/',
  ui: 'add code to the web page (runs with your login)',
  db: 'create its own tables in halay.db',
  network: 'make network requests (declared, not enforced)',
  fs: 'read and write files (declared, not enforced)',
  exec: 'run programs (declared, not enforced)',
};
const EVENT_PERMISSION = { agent: 'events:agents', approval: 'events:agents', task: 'events:tasks', schedule: 'events:tasks', room: 'events:rooms', server: null };
export const EVENTS = ['agent.started', 'agent.status', 'agent.event', 'agent.exited', 'agent.attention', 'agent.finished', 'agent.removed', 'approval.requested', 'approval.resolved', 'task.added', 'task.finished', 'schedule.run', 'room.message', 'server.ready', 'server.stopping'];
const ROLES = ['conductor', 'agent', 'bot'];
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOOL = /^[a-z0-9][a-z0-9_]{0,39}$/;
const HOOK_SLOW_MS = 10_000;
const BREAKER = { errors: 20, windowMs: 5 * 60_000 };
const LOG_KEEP = 200;

// ---- semver, just what manifests need: "*", "1", "1.2", "1.2.3", "^1.2", "~1.2", ">=1.2", "a || b"
const ver = (s) => String(s).trim().replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0).concat([0, 0, 0]).slice(0, 3);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
export function satisfies(version, range) {
  const v = ver(version);
  return String(range || '*').split('||').some((r) => {
    r = r.trim();
    if (r === '*' || r === '') return true;
    const m = r.match(/^(\^|~|>=|>|<=|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/);
    if (!m) return false;
    const op = m[1] || '', parts = m[2].split('.').length, w = ver(m[2]);
    if (op === '>=') return cmp(v, w) >= 0;
    if (op === '>') return cmp(v, w) > 0;
    if (op === '<=') return cmp(v, w) <= 0;
    if (op === '<') return cmp(v, w) < 0;
    if (op === '~') return v[0] === w[0] && (parts < 2 || v[1] === w[1]) && cmp(v, w) >= 0;
    if (op === '^') return v[0] === w[0] && (w[0] > 0 || parts < 2 || v[1] === w[1]) && cmp(v, w) >= 0;
    return parts === 3 && op !== '' ? cmp(v, w) === 0 : v.slice(0, parts).every((x, i) => x === w[i]); // "1.2" = 1.2.x
  });
}

// ---- manifest
const SETTING_TYPES = ['string', 'number', 'boolean', 'array'];
function readManifest(dir, source) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const m = pkg[APP];
  if (!m || typeof m !== 'object') throw new Error(`package.json has no "${APP}" section`);
  const id = m.id || String(pkg.name || '').replace(/^@[^/]+\//, '').replace(new RegExp(`^${APP}-plugin-`), '');
  if (!ID.test(id)) throw new Error(`invalid plugin id "${id}" (a-z, 0-9 and -, up to 32 characters)`);
  const permissions = Array.isArray(m.permissions) ? m.permissions : [];
  const unknown = permissions.filter((p) => !PERMISSIONS[p]);
  if (unknown.length) throw new Error(`unknown permission(s): ${unknown.join(', ')}`);
  if (m.ui && !permissions.includes('ui')) throw new Error('a plugin with a "ui" entry needs the "ui" permission');
  const settings = m.settings && typeof m.settings === 'object' ? m.settings : {};
  for (const [k, s] of Object.entries(settings))
    if (!/^[A-Za-z][\w-]{0,39}$/.test(k) || !SETTING_TYPES.includes(s?.type)) throw new Error(`setting "${k}": type must be one of ${SETTING_TYPES.join(', ')}`);
  const inside = (f) => { // entry files must stay inside the plugin folder
    if (!f) return null;
    const p = path.resolve(dir, f);
    const r = path.relative(dir, p);
    if (r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)) throw new Error(`${f} is outside the plugin folder`);
    return p;
  };
  return {
    id, source, dir,
    name: pkg.name || id, version: pkg.version || '0.0.0', description: pkg.description || '',
    displayName: m.displayName || id, api: m.api || '*', permissions, settings,
    server: inside(m.server), ui: inside(m.ui), styles: (Array.isArray(m.styles) ? m.styles : []).map(inside),
    defaultEnabled: source === 'builtin' && m.defaultEnabled === true, // only shipped plugins may start on by themselves
  };
}

// ---- settings: a small JSON-Schema subset. Secrets are never sent to the browser.
function cleanSettings(schema, input, prev = {}) {
  const out = {};
  for (const [k, s] of Object.entries(schema)) {
    let v = input?.[k];
    if (s.secret && (v === undefined || v === null || v === '')) { if (prev[k] !== undefined && v !== null) out[k] = prev[k]; continue; } // empty = keep; null = clear
    if (v === undefined || v === '' || v === null) { if (s.required && s.default === undefined) throw new Error(`${s.title || k} is required`); continue; }
    if (s.type === 'number') { v = Number(v); if (!Number.isFinite(v)) throw new Error(`${s.title || k} must be a number`); }
    else if (s.type === 'boolean') v = v === true || v === 'true';
    else if (s.type === 'string') {
      v = String(v).trim();
      if (s.enum && !s.enum.includes(v)) throw new Error(`${s.title || k} must be one of ${s.enum.join(', ')}`);
      if (s.pattern && !new RegExp(`^(?:${s.pattern})$`).test(v)) throw new Error(`${s.title || k} is not valid${s.help ? ': ' + s.help : ''}`);
    }
    else if (s.type === 'array') {
      if (!Array.isArray(v)) throw new Error(`${s.title || k} must be a list`);
      const allowed = s.items?.enum;
      if (allowed && v.some((x) => !allowed.includes(x))) throw new Error(`${s.title || k}: allowed values are ${allowed.join(', ')}`);
    }
    out[k] = v;
  }
  return out;
}
const withDefaults = (schema, saved) => {
  const out = {};
  for (const [k, s] of Object.entries(schema)) out[k] = saved[k] !== undefined ? saved[k] : s.default !== undefined ? structuredClone(s.default) : s.type === 'boolean' ? false : s.type === 'array' ? [] : '';
  return out;
};
const publicSettings = (schema, saved) => {
  const v = withDefaults(schema, saved), set = {};
  for (const [k, s] of Object.entries(schema)) if (s.secret) { set[k] = saved[k] !== undefined && saved[k] !== ''; delete v[k]; }
  return { values: v, secretsSet: set };
};

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }

/**
 * services: what the server lends to plugins (all optional; a missing one makes the matching ctx member throw).
 *   coreApi(method, path, body, pluginId) → Promise<json>: this server's own REST API, called as the plugin
 *   notifyUser({ kind, title, body, agentId, url }): web push + every channel, like an agent notification
 *   publicUrl() → 'https://…' or '': this app's address, so channels can link back (notification.link)
 */
export function createPluginHost({ db, root, pluginsDir, dataDir, broadcast, services = {}, safeMode = false, log = console }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, granted TEXT, version TEXT, settings TEXT, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS plugin_kv (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at INTEGER, PRIMARY KEY (plugin, key));
    CREATE TABLE IF NOT EXISTS plugin_migrations (plugin TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (plugin, n));
  `);
  const q = {
    get: db.prepare('SELECT * FROM plugins WHERE id=?'),
    put: db.prepare(`INSERT INTO plugins (id, enabled, granted, version, settings, updated_at) VALUES (@id, @enabled, @granted, @version, @settings, @now)
      ON CONFLICT(id) DO UPDATE SET enabled=@enabled, granted=@granted, version=@version, settings=@settings, updated_at=@now`),
    kvGet: db.prepare('SELECT value FROM plugin_kv WHERE plugin=? AND key=?'),
    kvPut: db.prepare('INSERT INTO plugin_kv (plugin, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(plugin, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'),
    kvDel: db.prepare('DELETE FROM plugin_kv WHERE plugin=? AND key=?'),
    kvList: db.prepare("SELECT key, value FROM plugin_kv WHERE plugin=? AND key >= ? AND key < ? || char(1114111) ORDER BY key"),
    migDone: db.prepare('SELECT n FROM plugin_migrations WHERE plugin=?'),
    migAdd: db.prepare('INSERT INTO plugin_migrations (plugin, n) VALUES (?, ?)'),
  };
  const plugins = new Map(); // id -> { manifest, state, error, logs, errors, rec, run }
  const problems = []; // folders that could not be read as plugins: { dir, error }

  const record = (id) => {
    const r = q.get.get(id);
    let granted = [], settings = {};
    try { granted = JSON.parse(r?.granted || '[]'); } catch {}
    try { settings = JSON.parse(r?.settings || '{}'); } catch {}
    return { exists: !!r, enabled: !!r?.enabled, granted, version: r?.version || null, settings };
  };
  const save = (id, patch) => {
    const r = { ...record(id), ...patch };
    q.put.run({ id, enabled: r.enabled ? 1 : 0, granted: JSON.stringify(r.granted), version: r.version, settings: JSON.stringify(r.settings), now: Date.now() });
  };

  const addLog = (p, level, args) => {
    const text = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    p.logs.push({ at: Date.now(), level, text: text.slice(0, 2000) });
    if (p.logs.length > LOG_KEEP) p.logs.splice(0, p.logs.length - LOG_KEEP);
    (level === 'error' ? log.error : level === 'warn' ? log.warn : log.log).call(log, `[plugin ${p.manifest.id}]`, text.slice(0, 500));
  };

  // a plugin callback threw or rejected: log it, and switch the plugin off after too many errors in a short time
  function failed(p, where, e) {
    addLog(p, 'error', [`${where}:`, e]);
    const now = Date.now();
    p.errors = p.errors.filter((t) => now - t < BREAKER.windowMs);
    p.errors.push(now);
    if (p.errors.length >= BREAKER.errors && p.state === 'running') {
      const why = `switched off after ${p.errors.length} errors in ${BREAKER.windowMs / 60000} minutes (last: ${e?.message || e})`;
      serial(p, async () => { if (p.state !== 'running') return; await deactivate(p, why); save(p.manifest.id, { enabled: false }); changed(); });
    }
  }
  // run fn guarded: errors go to failed(), a slow async callback gets a warning (it can't be cancelled)
  async function guard(p, where, fn) {
    let timer;
    try {
      const r = fn();
      if (!(r instanceof Promise)) return r;
      timer = setTimeout(() => addLog(p, 'warn', [`${where} is taking more than ${HOOK_SLOW_MS / 1000}s`]), HOOK_SLOW_MS);
      return await r;
    } catch (e) { failed(p, where, e); throw e; } finally { clearTimeout(timer); }
  }
  const quietly = (pr) => pr.catch(() => {});

  // ---- discovery
  function scan(dir, source) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const d of names) {
      if (d.name.startsWith('.') || d.name === 'node_modules' || !(d.isDirectory() || d.isSymbolicLink())) continue;
      const full = path.join(dir, d.name);
      if (!fs.existsSync(path.join(full, 'package.json'))) continue;
      out.push({ dir: full, source });
    }
    return out;
  }
  function scanNpm(dir) {
    const nm = path.join(dir, 'node_modules'), prefix = `${APP}-plugin-`;
    let names = [];
    try { names = fs.readdirSync(nm); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (n.startsWith(prefix)) out.push({ dir: path.join(nm, n), source: 'npm' });
      else if (n.startsWith('@')) {
        try { for (const s of fs.readdirSync(path.join(nm, n))) if (s.startsWith(prefix)) out.push({ dir: path.join(nm, n, s), source: 'npm' }); } catch {}
      }
    }
    return out;
  }
  function discover() {
    const found = [...scan(path.join(root, 'plugins-builtin'), 'builtin'), ...scan(pluginsDir, 'folder'), ...scanNpm(pluginsDir)];
    for (const { dir, source } of found) {
      let manifest;
      try { manifest = readManifest(dir, source); } catch (e) { problems.push({ dir, source, error: e.message }); continue; }
      if (plugins.has(manifest.id)) { problems.push({ dir, source, error: `duplicate plugin id "${manifest.id}" (already loaded from ${plugins.get(manifest.id).manifest.dir})` }); continue; }
      plugins.set(manifest.id, { manifest, state: 'off', error: null, logs: [], errors: [], run: null });
    }
  }

  // ---- registries filled by running plugins
  const listeners = new Map(); // event -> Set<{ p, fn }>
  const routes = []; // { p, method, parts, handler }
  const tools = new Map(); // full name -> { p, def }
  const channels = new Map(); // `${pluginId}/${id}` -> { p, id, label, send }

  const has = (p, perm) => p.run?.granted.includes(perm);
  const need = (p, perm, what) => { if (!has(p, perm)) throw new Error(`${what} needs the "${perm}" permission in the manifest`); };

  function makeCtx(p) {
    const m = p.manifest, id = m.id, dispose = p.run.dispose;
    const add = (fn) => { dispose.push(fn); return fn; };
    const pluginData = path.join(dataDir, id);
    const ctx = {
      apiVersion: PLUGIN_API,
      plugin: { id, version: m.version, dir: m.dir, get dataDir() { fs.mkdirSync(pluginData, { recursive: true }); return pluginData; } },
      log: { info: (...a) => addLog(p, 'info', a), warn: (...a) => addLog(p, 'warn', a), error: (...a) => addLog(p, 'error', a) },
      httpError,
      settings: {
        get: () => withDefaults(m.settings, record(id).settings),
        onChange: (fn) => { p.run.onSettings.add(fn); add(() => p.run.onSettings.delete(fn)); },
      },
      store: {
        get: (key) => { const r = q.kvGet.get(id, String(key)); return r ? JSON.parse(r.value) : undefined; },
        set: (key, value) => { q.kvPut.run(id, String(key), JSON.stringify(value ?? null), Date.now()); },
        delete: (key) => { q.kvDel.run(id, String(key)); },
        list: (prefix = '') => q.kvList.all(id, String(prefix), String(prefix)).map((r) => ({ key: r.key, value: JSON.parse(r.value) })),
      },
      events: {
        on(name, fn) {
          if (!EVENTS.includes(name)) throw new Error(`unknown event "${name}" (known: ${EVENTS.join(', ')})`);
          const perm = EVENT_PERMISSION[name.split('.')[0]];
          if (perm) need(p, perm, `event ${name}`);
          const l = { p, fn };
          if (!listeners.has(name)) listeners.set(name, new Set());
          listeners.get(name).add(l);
          add(() => listeners.get(name)?.delete(l));
        },
      },
      timers: {
        every: (ms, fn) => { const t = setInterval(() => quietly(guard(p, 'timer', fn)), Math.max(1000, ms)); t.unref?.(); add(() => clearInterval(t)); return t; },
        after: (ms, fn) => { const t = setTimeout(() => quietly(guard(p, 'timer', fn)), ms); t.unref?.(); add(() => clearTimeout(t)); return t; },
      },
      ui: { broadcast: (type, payload) => broadcast({ type: 'plugin', plugin: id, event: String(type), payload }) },
    };
    if (has(p, 'routes')) {
      const route = (method) => (pattern, handler) => {
        const parts = String(pattern).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
        const r = { p, method, parts, handler };
        routes.push(r);
        add(() => routes.splice(routes.indexOf(r), 1));
      };
      ctx.routes = { get: route('GET'), post: route('POST'), put: route('PUT'), patch: route('PATCH'), delete: route('DELETE') };
    }
    if (has(p, 'mcp')) {
      ctx.mcp = {
        tool(def) {
          if (!TOOL.test(def?.name || '')) throw new Error('tool name: a-z, 0-9 and _, up to 40 characters');
          if (typeof def.run !== 'function') throw new Error('tool needs a run(args, caller) function');
          const roles = def.roles || ['conductor'];
          if (!roles.length || roles.some((r) => !ROLES.includes(r))) throw new Error(`tool roles must be some of ${ROLES.join(', ')}`);
          const full = `${id.replace(/-/g, '_')}_${def.name}`;
          // names can meet: plugin a-b's tool c_d and plugin a's tool b_c_d are both a_b_c_d; a core tool must never be shadowed
          if (services.coreToolNames?.().includes(full)) throw new Error(`tool ${full} has the name of a built-in swarm tool; rename it`);
          const owner = tools.get(full)?.p;
          if (owner) throw new Error(owner === p ? `tool ${full} is already registered` : `tool ${full} is already registered by plugin ${owner.manifest.id}; rename it`);
          tools.set(full, { p, def: { ...def, roles, schema: def.schema || { type: 'object', properties: {} } } });
          add(() => tools.delete(full));
          return full;
        },
      };
    }
    if (has(p, 'notify') || has(p, 'notify:channel')) {
      ctx.notify = {};
      if (has(p, 'notify')) ctx.notify.send = ({ title, body = '', agentId = null, kind = 'plugin', url } = {}) => {
        if (!services.notifyUser) throw new Error('notifications are not available');
        return services.notifyUser({ kind, title: String(title || m.displayName), body: String(body), agentId, url, from: id });
      };
      if (has(p, 'notify:channel')) ctx.notify.channel = ({ id: cid, label, send }) => {
        if (!/^[a-z0-9-]{1,32}$/.test(cid || '') || typeof send !== 'function') throw new Error('channel needs an id (a-z, 0-9, -) and a send(notification) function');
        const key = `${id}/${cid}`;
        channels.set(key, { p, id: cid, label: label || cid, send });
        add(() => channels.delete(key));
      };
    }
    const core = (method, p2, body) => {
      if (!services.coreApi) throw new Error('the core API is not available');
      return services.coreApi(method, p2, body, id);
    };
    if (has(p, 'agents:read') || has(p, 'agents:control')) {
      ctx.agents = {
        list: () => core('GET', '/api/agents'),
        get: (aid, { tail = 0 } = {}) => core('GET', `/api/agents/${encodeURIComponent(aid)}${tail ? '?tail=' + tail : '?all=1'}`), // tail 0 = every event
      };
      if (has(p, 'agents:control')) Object.assign(ctx.agents, {
        start: (body) => core('POST', '/api/agents', body),
        send: (aid, text) => core('POST', `/api/agents/${encodeURIComponent(aid)}/send`, { text }),
        interrupt: (aid) => core('POST', `/api/agents/${encodeURIComponent(aid)}/interrupt`, {}),
      });
    }
    if (has(p, 'tasks')) ctx.tasks = {
      list: () => core('GET', '/api/tasks'),
      add: (body) => core('POST', '/api/tasks', body),
      assign: (tid, opts = {}) => core('POST', `/api/tasks/${Number(tid)}/assign`, opts),
    };
    if (has(p, 'db')) {
      const prefix = `p_${id.replace(/-/g, '_')}_`;
      ctx.db = {
        handle: db,
        tablePrefix: prefix,
        // numbered migrations, each run once in a transaction; CREATE/ALTER/DROP may only name the plugin's own tables
        migrate(steps) {
          const done = new Set(q.migDone.all(id).map((r) => r.n));
          steps.forEach((sql, i) => {
            if (done.has(i + 1)) return;
            for (const [, t] of String(sql).matchAll(/\b(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`]?([\w]+)/gi))
              if (!t.startsWith(prefix)) throw new Error(`migration ${i + 1}: ${t} must start with ${prefix}`);
            db.transaction(() => { db.exec(sql); q.migAdd.run(id, i + 1); })();
          });
        },
      };
    }
    return ctx;
  }

  // ---- lifecycle
  const status = (p) => {
    const rec = record(p.manifest.id), m = p.manifest;
    const missing = m.permissions.filter((x) => !rec.granted.includes(x)), compatible = satisfies(PLUGIN_API, m.api);
    return {
      id: m.id, name: m.name, displayName: m.displayName, version: m.version, description: m.description, source: m.source,
      api: m.api, compatible, permissions: m.permissions.map((x) => ({ id: x, text: PERMISSIONS[x] })),
      enabled: rec.enabled, needsConsent: rec.enabled && missing.length > 0, state: p.state,
      error: p.error || (compatible ? null : `needs plugin API ${m.api}; this server has ${PLUGIN_API}`),
      hasSettings: Object.keys(m.settings).length > 0, settingsSchema: m.settings, settings: publicSettings(m.settings, rec.settings),
      ui: !!m.ui, tools: [...tools.entries()].filter(([, t]) => t.p === p).map(([n, t]) => ({ name: 'mcp__swarm__' + n, roles: t.def.roles, autoAllow: !!t.def.autoAllow })),
      channels: [...channels.values()].filter((c) => c.p === p).map((c) => ({ id: c.id, label: c.label })),
    };
  };
  const changed = () => broadcast({ type: 'plugins' });

  async function activate(p) {
    const m = p.manifest, rec = record(m.id);
    if (safeMode) { p.state = 'off'; p.error = 'safe mode (HALAY_PLUGINS=0)'; return; }
    if (!satisfies(PLUGIN_API, m.api)) { p.state = 'error'; p.error = `needs plugin API ${m.api}; this server has ${PLUGIN_API}`; return; }
    const missing = m.permissions.filter((x) => !rec.granted.includes(x));
    if (missing.length) { p.state = 'off'; p.error = `asks for new permissions (${missing.join(', ')}); enable it again to allow them`; return; }
    p.run = { granted: rec.granted, dispose: [], onSettings: new Set(), mod: null };
    p.state = 'starting'; p.error = null; p.errors = [];
    try {
      const ctx = makeCtx(p);
      if (m.server) {
        p.loads = (p.loads || 0) + 1; // a new URL per load, so enabling again runs the plugin's current code
        p.run.mod = await import(pathToFileURL(m.server).href + (p.loads > 1 ? `?v=${p.loads}` : ''));
        if (typeof p.run.mod.activate === 'function') await guard(p, 'activate', () => p.run.mod.activate(ctx));
      }
      p.state = 'running';
      if (rec.version !== m.version) save(m.id, { version: m.version });
      addLog(p, 'info', [`running (${m.version})`]);
    } catch (e) {
      if (!p.logs.some((l) => l.text.startsWith('activate:'))) addLog(p, 'error', ['activate:', e]);
      await deactivate(p, e.message || String(e));
    }
  }
  async function deactivate(p, error = null) {
    const run = p.run;
    p.run = null;
    p.state = error ? 'error' : 'off';
    p.error = error;
    if (!run) return;
    if (typeof run.mod?.deactivate === 'function') {
      try { await Promise.race([run.mod.deactivate(), new Promise((r) => setTimeout(r, 5000))]); } catch (e) { addLog(p, 'error', ['deactivate:', e]); }
    }
    for (const fn of run.dispose.reverse()) { try { fn(); } catch {} }
  }

  // seeds: { id: () => ({ enabled, settings }) | null } for built-in plugins that replace a core feature: the first time such a
  // plugin is seen, it takes over that feature's old settings (and is on if the feature was), with its permissions granted
  async function start({ seeds = {} } = {}) {
    discover();
    for (const p of plugins.values()) {
      const m = p.manifest, rec = record(m.id), seed = !rec.exists && m.source === 'builtin' && seeds[m.id]?.();
      if (seed) save(m.id, { enabled: !!seed.enabled, granted: m.permissions, version: m.version, settings: cleanSettings(m.settings, seed.settings || {}) });
      else if (!rec.exists && m.defaultEnabled) save(m.id, { enabled: true, granted: m.permissions, version: m.version });
      if (record(m.id).enabled) await serial(p, () => activate(p));
    }
    for (const x of problems) log.warn(`[plugins] ${x.dir}: ${x.error}`);
    const n = [...plugins.values()].filter((p) => p.state === 'running').length;
    log.log(`plugins: ${n} running of ${plugins.size} found${safeMode ? ' (safe mode: HALAY_PLUGINS=0)' : ''}`);
  }
  async function stop() {
    const ls = [...(listeners.get('server.stopping') || [])]; // called right away (not after a tick): the process exits next
    await Promise.all(ls.map((l) => quietly(guard(l.p, 'on server.stopping', () => l.fn({})))));
    for (const p of plugins.values()) await serial(p, () => (p.run ? deactivate(p) : null));
  }

  // enable/disable/breaker run one at a time per plugin: two overlapping activate() calls would leak the first one's
  // routes, timers and tools and fail the second with "already registered"
  function serial(p, fn) {
    const run = (p.lock || Promise.resolve()).then(fn);
    p.lock = run.catch(() => {});
    return run;
  }

  async function setEnabled(id, enabled, consent = []) {
    const p = plugins.get(id);
    if (!p) throw httpError(404, `no plugin ${id}`);
    return serial(p, () => setEnabledNow(p, id, enabled, consent));
  }
  async function setEnabledNow(p, id, enabled, consent) {
    if (!enabled) { save(id, { enabled: false }); await deactivate(p); changed(); return status(p); }
    const missing = p.manifest.permissions.filter((x) => !consent.includes(x));
    if (missing.length) throw httpError(400, `confirm the permissions first: ${missing.join(', ')}`);
    save(id, { enabled: true, granted: [...p.manifest.permissions], version: p.manifest.version });
    if (p.run) await deactivate(p);
    await activate(p);
    changed();
    return status(p);
  }

  function putSettings(id, input) {
    const p = plugins.get(id);
    if (!p) throw httpError(404, `no plugin ${id}`);
    const prev = record(id).settings;
    let next;
    try { next = cleanSettings(p.manifest.settings, input, prev); } catch (e) { throw httpError(400, e.message); }
    save(id, { settings: next });
    const values = withDefaults(p.manifest.settings, next);
    if (p.run) for (const fn of p.run.onSettings) quietly(guard(p, 'settings.onChange', () => fn(values)));
    changed();
    return status(p);
  }

  // ---- events: dispatched after the current tick, so a plugin never slows down the code that emits
  function emit(name, payload) {
    const ls = listeners.get(name);
    if (!ls?.size) return;
    // each listener gets its own copy: one plugin changing the payload must not change what the next one sees
    const copy = () => { try { return structuredClone(payload); } catch { return payload; } };
    setImmediate(() => { for (const l of ls) if (l.p.state === 'running') quietly(guard(l.p, `on ${name}`, () => l.fn(copy()))); });
  }

  // ---- notification channels (called for every notification that would go out as a push)
  const linkOf = (url) => { const base = services.publicUrl?.() || ''; return base && url ? base.replace(/#.*$/, '').replace(/\/+$/, '') + url : null; };
  function notify(n) {
    const out = { ...n, link: linkOf(n.url) };
    for (const c of channels.values()) if (c.p.state === 'running') quietly(guard(c.p, `channel ${c.id}`, () => c.send({ ...out })));
  }
  // Settings → Plugins → Send test: every channel of one plugin, waiting for each so an error is shown
  async function testChannels(p) {
    const cs = [...channels.values()].filter((c) => c.p === p);
    if (!cs.length) throw httpError(400, `${p.manifest.displayName} has no notification channel`);
    const n = { kind: 'test', title: 'Test notification', body: 'If you can read this, the channel works.', agentId: null, url: '/', link: linkOf('/') };
    for (const c of cs) await guard(p, `channel ${c.id}`, () => c.send({ ...n })).catch((e) => { throw httpError(502, `${c.label}: ${e.message}`); });
  }

  // ---- MCP tools (served through swarm-mcp.js)
  function toolsFor(role) {
    return [...tools.entries()].filter(([, t]) => t.p.state === 'running' && t.def.roles.includes(role))
      .map(([name, t]) => ({ name, description: `${t.def.description || ''} (plugin ${t.p.manifest.displayName})`.trim(), inputSchema: t.def.schema }));
  }
  async function callTool(name, args, caller) {
    const t = tools.get(name);
    if (!t || t.p.state !== 'running' || !t.def.roles.includes(caller.role)) throw httpError(404, `no plugin tool ${name}`);
    const r = await guard(t.p, `tool ${name}`, () => t.def.run(args || {}, caller));
    return typeof r === 'string' ? r : JSON.stringify(r ?? null);
  }
  // "mcp__swarm__<tool>" that the plugin marked autoAllow, for the caller's role
  const autoAllowed = (toolName, role) => {
    const t = tools.get(String(toolName).replace(/^mcp__swarm__/, ''));
    return !!(t && t.p.state === 'running' && t.def.autoAllow && t.def.roles.includes(role));
  };

  // ---- HTTP: /api/plugins (management + plugin routes) and /plugins/<id>/… (UI files)
  async function handle(req, url, res, { json, readBody, caller }) {
    const send = (code, body) => { json(res, code, body); return true; };
    let parts;
    try { parts = url.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent); } // after /api/plugins
    catch { return send(400, { error: 'malformed URL' }); }
    const fail = (e) => send(e.status || 500, { error: e.message || String(e) });
    try {
      if (!parts.length && req.method === 'GET')
        return send(200, { api: PLUGIN_API, app: APP, safeMode, pluginsDir, plugins: [...plugins.values()].map(status), problems });
      if (parts.length === 1 && parts[0] === 'ui' && req.method === 'GET') // what the page loads: enabled, running plugins with a UI
        return send(200, [...plugins.values()].filter((p) => p.state === 'running' && p.manifest.ui).map((p) => ({
          id: p.manifest.id, displayName: p.manifest.displayName, version: p.manifest.version,
          ui: `/plugins/${p.manifest.id}/${rel(p, p.manifest.ui)}`, styles: p.manifest.styles.map((s) => `/plugins/${p.manifest.id}/${rel(p, s)}`),
        })));
      const p = plugins.get(parts[0]);
      if (!p) return send(404, { error: `no plugin ${parts[0]}` });
      const [, action, ...rest] = parts;
      if (action === undefined && req.method === 'GET') return send(200, { ...status(p), logs: p.logs.slice(-50) });
      // managing a plugin is the user's alone: an agent, a peer or a plugin could otherwise switch one on or off or
      // point its settings (a webhook or ntfy URL) somewhere else. A plugin's own routes (below) decide for themselves.
      const manage = { enable: 'POST', disable: 'POST', settings: 'PUT', test: 'POST' };
      if (manage[action] === req.method && (caller.agentId || caller.peer || caller.plugin)) return send(403, { error: 'only the user can manage plugins (Settings → Plugins)' });
      if (action === 'enable' && req.method === 'POST') return send(200, await setEnabled(p.manifest.id, true, (await readBody(req)).permissions || []));
      if (action === 'disable' && req.method === 'POST') return send(200, await setEnabled(p.manifest.id, false));
      if (action === 'settings' && req.method === 'PUT') return send(200, putSettings(p.manifest.id, await readBody(req)));
      if (action === 'test' && req.method === 'POST') { if (p.state !== 'running') return send(409, { error: 'enable it first' }); await testChannels(p); return send(200, { ok: true }); }
      if (action === 'api') { // the plugin's own routes: /api/plugins/<id>/api/<path>
        if (p.state !== 'running') return send(503, { error: `plugin ${p.manifest.id} is not running` });
        for (const r of routes) {
          if (r.p !== p || r.method !== req.method || r.parts.length !== rest.length) continue;
          const params = {};
          if (!r.parts.every((x, i) => (x.startsWith(':') ? ((params[x.slice(1)] = rest[i]), true) : x === rest[i]))) continue;
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
          const out = await guard(p, `route ${req.method} /${r.parts.join('/')}`, () => r.handler({ params, query: Object.fromEntries(url.searchParams), body, caller }));
          return send(200, out === undefined ? { ok: true } : out);
        }
        return send(404, { error: 'no such plugin route' });
      }
      return send(404, { error: 'not found' });
    } catch (e) { return fail(e); }
  }
  const rel = (p, f) => path.relative(p.manifest.dir, f).split(path.sep).map(encodeURIComponent).join('/');
  // a running plugin's ui entry, its styles, or anything under its public/ folder; null when not allowed
  function staticFile(pathname) {
    const m = pathname.match(/^\/plugins\/([^/]+)\/(.+)$/);
    const p = m && plugins.get(m[1]);
    if (!p || p.state !== 'running') return null;
    let rp;
    try { rp = fs.realpathSync(path.resolve(p.manifest.dir, decodeURIComponent(m[2]))); } catch { return null; }
    const dir = fs.realpathSync(p.manifest.dir), real = (f) => { try { return fs.realpathSync(f); } catch { return null; } };
    const allowed = [p.manifest.ui, ...p.manifest.styles].filter(Boolean).map(real).includes(rp)
      || (!path.relative(path.join(dir, 'public'), rp).startsWith('..') && rp.startsWith(path.join(dir, 'public') + path.sep));
    return allowed && fs.statSync(rp).isFile() ? rp : null;
  }

  return {
    start, stop, emit, notify, toolsFor, callTool, autoAllowed, handle, staticFile,
    list: () => [...plugins.values()].map(status),
    isRunning: (id) => plugins.get(id)?.state === 'running',
    channelCount: () => [...channels.values()].filter((c) => c.p.state === 'running').length,
    validId: (s) => ID.test(String(s || '')) && plugins.has(String(s)),
  };
}
