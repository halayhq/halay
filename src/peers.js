// Peers: other halay instances (e.g. on another Mac in the tailnet) this server can see and drive (docs/peers.md).
// Config lives in this server's settings table ('peers': { self, peers: { name: { url, token } } }), never in git.
// /api/peers/<name>/<api path> is forwarded to <url>/api/<api path> with that peer's token and x-halay-peer: <self>,
// so agents only ever talk to their own server and never see a peer's token. Tokens are never returned by the API.
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { NAME_RE, env } from './util.js';

export const validName = (s) => NAME_RE.test(String(s || ''));
// what a peer may reach through the proxy: the conductor's tools (agents, tasks, sessions, accounts) and the instance probe
const ALLOWED_PATHS = ['agents', 'tasks', 'sessions', 'accounts', 'limits', 'instance', 'stats'];
const ALLOWED = new RegExp(`^/(${ALLOWED_PATHS.join('|')})(/|$)`);
const CONNECT_MS = 10_000; // a peer that is off or not in the tailnet fails fast instead of hanging
const REPLY_MS = 120_000; // no answer at all: a normal call
const MAX_BODY = 1_000_000;

export function createPeers({ getCfg, putCfg, agents, stats }) {
  const cfg = () => getCfg('peers', { self: '', peers: {} });
  const self = () => cfg().self || env('PEER_NAME') || os.hostname().replace(/\.local$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32) || 'swarm';
  const list = () => Object.entries(cfg().peers || {}).map(([name, p]) => ({ name, url: p.url, hasToken: !!p.token }));

  function save(name, { url, token }) {
    if (!validName(name)) return { code: 400, error: 'peer name: letters, digits, - and _ (max 32)' };
    if (name === self()) return { code: 400, error: 'that is the name of this server' };
    const c = cfg(), old = c.peers?.[name];
    let u;
    try { u = new URL(String(url || old?.url || '')); } catch { return { code: 400, error: 'url must be the peer\'s address, e.g. https://other-mac.tailnet.ts.net' }; }
    if (!/^https?:$/.test(u.protocol)) return { code: 400, error: 'url must start with https:// (or http://)' };
    const tok = token ? String(token).trim() : old?.token;
    if (!tok) return { code: 400, error: 'token required (the peer\'s access token: its .token file or HALAY_TOKEN)' };
    putCfg('peers', { ...c, peers: { ...c.peers, [name]: { url: u.origin + u.pathname.replace(/\/+$/, ''), token: tok } } });
    return { peer: list().find((p) => p.name === name) };
  }

  // one call to a peer; resolves { status, headers, body (Buffer) } or rejects with an Error carrying .code (HTTP status for our reply)
  function call(name, method, apiPath, body, { replyMs = REPLY_MS, onRes } = {}) {
    const p = cfg().peers?.[name];
    if (!p) return Promise.reject(Object.assign(new Error(`no peer "${name}" (configure it in Settings → Peers)`), { code: 404 }));
    const u = new URL(p.url + '/api' + apiPath);
    const mod = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const fail = (code, msg) => reject(Object.assign(new Error(msg), { code }));
      const req = mod.request(u, {
        method,
        headers: { authorization: `Bearer ${p.token}`, 'x-halay-peer': self(), 'x-swarm-peer': self() /* old name, for peers not yet upgraded */, accept: 'application/json', ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) },
      });
      let connected = false;
      const ct = setTimeout(() => { if (!connected) { req.destroy(); fail(504, `peer "${name}" is unreachable at ${p.url}: no connection after ${CONNECT_MS / 1000}s (is it on and in the tailnet?)`); } }, CONNECT_MS);
      const rt = setTimeout(() => { req.destroy(); fail(504, `peer "${name}" did not answer within ${Math.round(replyMs / 1000)}s`); }, replyMs);
      req.on('socket', (s) => {
        if (!s.connecting) { connected = true; return; } // a kept-alive socket
        s.once(u.protocol === 'https:' ? 'secureConnect' : 'connect', () => { connected = true; });
      });
      req.on('error', (e) => { clearTimeout(ct); clearTimeout(rt); fail(502, `peer "${name}" is unreachable at ${p.url}: ${e.code || e.message}`); });
      req.on('response', (res) => {
        clearTimeout(ct); clearTimeout(rt);
        if (onRes) return resolve(onRes(res));
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', (e) => fail(502, `peer "${name}": ${e.message}`));
      });
      req.end(body);
    });
  }

  // a peer's answer on our side: its own error message, but a refused token is said plainly (and never echoed)
  const authHint = (name, status) => status === 401 ? `peer "${name}" refused the token this server has for it (401); paste its current token in Settings → Peers` : null;

  // GET /api/peers?check=1 → each peer with { ok, name (as it calls itself), agents, running } or { ok: false, error }
  const probe = async (name) => {
    try {
      const r = await call(name, 'GET', '/instance', undefined, { replyMs: 8000 });
      if (r.status !== 200) return { ok: false, error: authHint(name, r.status) || `HTTP ${r.status}: ${String(r.body).slice(0, 200)}` };
      return { ok: true, ...JSON.parse(r.body) };
    } catch (e) { return { ok: false, error: e.message }; }
  };

  // The Machines block's view: answers at once from the last probe of each peer (a probe of a machine that is off takes up to
  // ~10 s), and refreshes in the background when the cache is older than STALE_MS. A peer never probed yet has status null.
  const seen = new Map(); // name -> { status, at }
  let refreshing = false, lastRefresh = 0;
  const STALE_MS = 20_000;
  function refreshMachines() {
    if (refreshing) return;
    refreshing = true; lastRefresh = Date.now();
    Promise.all(list().map(async (p) => { seen.set(p.name, { status: await probe(p.name), at: Date.now() }); }))
      .catch(() => {}).finally(() => { refreshing = false; });
  }
  function machines() {
    const known = list();
    if (Date.now() - lastRefresh > STALE_MS || known.some((p) => !seen.has(p.name))) refreshMachines(); // stale, or a peer added since
    const peers = known.map((p) => ({ ...p, status: seen.get(p.name)?.status ?? null, checkedAt: seen.get(p.name)?.at ?? null }));
    for (const n of seen.keys()) if (!peers.some((p) => p.name === n)) seen.delete(n); // a peer that was removed
    return { name: self(), stats: stats?.get() ?? null, peers, checking: refreshing };
  }

  // what this server tells a peer that probes it
  const instance = () => {
    const all = [...agents.values()];
    return { name: self(), agents: all.length, running: all.filter((a) => a.status === 'running').length, ...(stats && { stats: stats.get() }) };
  };

  async function forward(req, res, name, apiPath, search, opts) {
    const { json } = opts;
    if (!ALLOWED.test(apiPath)) return json(res, 403, { error: `peers can only be asked for ${ALLOWED_PATHS.slice(0, -1).join(', ')} and ${ALLOWED_PATHS.at(-1)}, not ${apiPath}` });
    let body;
    if (!['GET', 'HEAD', 'DELETE'].includes(req.method) || req.headers['content-length'] > 0) {
      const chunks = []; let n = 0, over = false;
      // keep reading (and drop) the rest of an oversized body: leaving the loop early destroys the request's socket, and the
      // client then sees ECONNRESET (a flaky read error) instead of the 413. Past 16x the limit, give up on the connection.
      for await (const d of req) { n += d.length; if (n > MAX_BODY) { over = true; if (n > 16 * MAX_BODY) { req.destroy(); break; } } else chunks.push(d); }
      if (over) { res.setHeader('connection', 'close'); return json(res, 413, { error: 'request too large for a peer' }); }
      body = Buffer.concat(chunks);
      if (!body.length) body = undefined;
    }
    // the caller's own limits (an agent may not start something more permissive than itself there either)
    if (opts.check) {
      let j = {};
      try { j = body ? JSON.parse(String(body)) : {}; } catch {}
      const err = opts.check(req.method, apiPath, j && typeof j === 'object' ? j : {});
      if (err) return json(res, 403, { error: err });
    }
    // a long poll (wait_for_agent, a blocking refresh) waits as long as the peer may hold it, plus a margin
    let replyMs = REPLY_MS;
    if (/\/(wait|refresh)$/.test(apiPath)) {
      let t = 1800;
      try { t = Math.min(Math.max(Number(JSON.parse(String(body || '{}')).timeout) || 300, 1), 1800); } catch {}
      replyMs = Math.max(t, 600) * 1000 + 60_000;
    }
    let up;
    try {
      up = await call(name, req.method, apiPath + (search || ''), body, { replyMs, onRes: (r) => r });
    } catch (e) { return json(res, e.code || 502, { error: e.message }); }
    const hint = authHint(name, up.statusCode);
    if (hint) { up.resume(); return json(res, 502, { error: hint }); }
    res.writeHead(up.statusCode, { 'content-type': up.headers['content-type'] || 'application/json', 'cache-control': 'no-store' });
    up.pipe(res);
    up.on('error', () => res.destroy());
    res.on('close', () => up.destroy()); // our caller gave up (e.g. the MCP server stopped): stop waiting on the peer too
  }

  // /api/peers…: the config (GET list, PUT { self }, PUT/DELETE /api/peers/<name>) and the proxy (/api/peers/<name>/<api path>)
  async function handle(req, url, res, opts) {
    const { readBody } = opts, json = (...a) => (opts.json(...a), true); // handled
    if (url.pathname === '/api/peers') {
      if (req.method === 'GET') {
        const peers = list();
        if (url.searchParams.has('check')) await Promise.all(peers.map(async (p) => { p.status = await probe(p.name); }));
        return json(res, 200, { self: self(), peers });
      }
      if (req.method === 'PUT') {
        const { self: s } = await readBody(req);
        if (s && !validName(s)) return json(res, 400, { error: 'name: letters, digits, - and _ (max 32)' });
        putCfg('peers', { ...cfg(), self: s || '' });
        return json(res, 200, { self: self(), peers: list() });
      }
    }
    const m = url.pathname.match(/^\/api\/peers\/([^/]+)(\/.*)?$/);
    if (!m) return false;
    const name = decodeURIComponent(m[1]);
    if (m[2]) { await forward(req, res, name, m[2], url.search, opts); return true; }
    if (req.method === 'PUT') {
      const r = save(name, await readBody(req));
      return r.error ? json(res, r.code, { error: r.error }) : json(res, 200, r.peer);
    }
    if (req.method === 'DELETE') {
      const c = cfg();
      if (!c.peers?.[name]) return json(res, 404, { error: 'no such peer' });
      const { [name]: _, ...rest } = c.peers;
      putCfg('peers', { ...c, peers: rest });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      const p = list().find((x) => x.name === name);
      return p ? json(res, 200, { ...p, status: await probe(name) }) : json(res, 404, { error: 'no such peer' });
    }
    return false;
  }

  return { handle, instance, machines, self, validName };
}
