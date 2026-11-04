// File API for the code editor (public/js/editor.js): list, read, write, create, rename and delete files in one agent's
// folder (its cwd, which is the worktree for worktree agents), plus a file's content at git HEAD for the diff view.
// Routes: /api/agents/:id/edit/<op>, same auth as the rest of /api (mounted in server.js).
// Paths are relative to the folder (an absolute path inside it is accepted too). `..` segments are refused outright, and
// every existing path is resolved with realpath and must stay inside the folder's real path, so a symlink that points
// outside is listed (marked `outside`) but can't be opened, written, listed into or used as a parent. New names are
// created under a real, contained parent. Files over MAX_OPEN or not valid UTF-8 are refused (the UI falls back to the
// viewer). Writes are atomic (temp file in the same folder, fsync, rename) and conditional: the client sends the etag it
// opened (a hash of the content), and a file that changed on disk since then is refused with 409 unless `force` is set.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const MAX_OPEN = 2 * 1024 * 1024; // bytes; larger files open in the viewer instead
const MAX_WRITE = 5 * 1024 * 1024, MAX_BODY = 4 * MAX_WRITE; // JSON escaping can grow the body
const HIDDEN = new Set(['.git', 'node_modules']); // left out of listings unless ?all=1
const MAX_ENTRIES = 5000;

const fail = (code, msg, extra = {}) => Object.assign(new Error(msg), { code, extra });
export const etagOf = (buf) => crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20);
const FS_CODES = { ENOENT: 404, EEXIST: 409, ENOTEMPTY: 409, EACCES: 403, EPERM: 403, EROFS: 403, ENOTDIR: 400, EISDIR: 400, EINVAL: 400, ENAMETOOLONG: 400 };
const isText = (buf) => { if (buf.subarray(0, 8192).includes(0)) return false; try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; } };
const inside = (root, p) => p === root || p.startsWith(root + path.sep);

function readJson(req) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (d) => { n += d.length; if (n > MAX_BODY) { reject(fail(413, 'request too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { reject(fail(400, 'bad JSON')); } });
    req.on('error', reject);
  });
}

// isProtected(realPath): never touched (browser profiles); secret: file names never opened, written or removed
export function createEditorFs({ isProtected = () => false, secret = /^$/ } = {}) {
  const rootOf = (agent) => { try { return fs.realpathSync(agent.cwd); } catch { throw fail(404, "the agent's folder does not exist"); } };

  // UI path -> relative path with '/' separators ('' = the folder itself)
  function relOf(root, cwd, p = '') {
    if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) throw fail(400, 'bad path');
    if (path.isAbsolute(p)) {
      const abs = path.resolve(p), base = [root, path.resolve(cwd)].find((r) => inside(r, abs));
      if (!base) throw fail(403, "outside the agent's folder", { outside: true });
      p = path.relative(base, abs);
    }
    const segs = p.split(/[\\/]/).filter((s) => s && s !== '.');
    if (segs.includes('..')) throw fail(400, 'path traversal is not allowed');
    return segs.join('/');
  }
  // an existing path, symlinks resolved, inside the folder
  function existing(root, rel) {
    let rp; try { rp = fs.realpathSync(path.join(root, rel)); } catch (e) { throw fail(FS_CODES[e.code] || 404, e.code === 'ENOENT' ? 'not found' : e.message); }
    if (!inside(root, rp)) throw fail(403, "this path leads outside the agent's folder (symlink)", { outside: true });
    if (isProtected(rp)) throw fail(403, 'browser profiles hold logged-in sessions and are never opened');
    return rp;
  }
  // a name to create, rename or remove: its parent must exist and be inside; the entry itself is not followed
  function entry(root, rel) {
    if (!rel) throw fail(400, "the agent's folder itself can't be changed");
    const name = path.posix.basename(rel), dir = existing(root, path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel));
    if (!fs.statSync(dir).isDirectory()) throw fail(400, 'parent is not a folder');
    if (secret.test(name)) throw fail(403, 'this file is never opened or changed here');
    return { dir, name, full: path.join(dir, name) };
  }
  const lstat = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  // before a folder is removed or renamed: refuse when anything inside it is protected or secret (links are not followed,
  // the same as rm), so deleting or moving a parent can't take a .env, .token, halay.db or browser profile with it
  function guardTree(full) {
    const stack = [full]; let n = 0;
    while (stack.length) {
      const dir = stack.pop();
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      for (const d of ents) {
        const p = path.join(dir, d.name);
        if (secret.test(d.name)) throw fail(403, `this folder contains ${path.relative(full, p)}, which is never changed here`);
        if (isProtected(p)) throw fail(403, 'this folder contains browser profiles, which are never changed');
        if (d.isDirectory()) stack.push(p);
        if (++n > 1e6) throw fail(413, 'too many files in this folder to check');
      }
    }
  }

  function list(root, rel, all) {
    const dir = existing(root, rel);
    if (!fs.statSync(dir).isDirectory()) throw fail(400, 'not a folder');
    const out = []; let hidden = 0;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!all && HIDDEN.has(d.name)) { hidden++; continue; }
      const e = { name: d.name, type: d.isDirectory() ? 'dir' : 'file' };
      if (d.isSymbolicLink()) {
        e.link = true;
        try { const rp = fs.realpathSync(path.join(dir, d.name)); if (!inside(root, rp) || isProtected(rp)) e.outside = true; else e.type = fs.statSync(rp).isDirectory() ? 'dir' : 'file'; }
        catch { e.broken = true; }
      } else if (!d.isDirectory() && !d.isFile()) continue; // sockets, fifos, devices
      out.push(e);
      if (out.length >= MAX_ENTRIES) break;
    }
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: rel, entries: out, hidden, truncated: out.length >= MAX_ENTRIES };
  }

  function read(root, rel) {
    const rp = existing(root, rel);
    if (secret.test(path.basename(rp)) || secret.test(path.posix.basename(rel))) throw fail(403, 'this file is never opened here');
    const st = fs.statSync(rp);
    if (!st.isFile()) throw fail(400, 'not a file');
    if (st.size > MAX_OPEN) throw fail(413, `file is larger than ${MAX_OPEN / 1048576} MB`, { tooLarge: true, size: st.size, limit: MAX_OPEN });
    const buf = fs.readFileSync(rp);
    if (!isText(buf)) throw fail(415, 'binary file (not UTF-8 text)', { binary: true, size: st.size });
    let readonly = false; try { fs.accessSync(rp, fs.constants.W_OK); } catch { readonly = true; }
    return { path: rel, content: buf.toString('utf8'), etag: etagOf(buf), mtime: st.mtimeMs, size: st.size, readonly };
  }

  // { path, content, etag (what the client opened; null = expects a new file), force }
  function write(root, b) {
    const rel = relOf(root, root, b.path);
    if (typeof b.content !== 'string') throw fail(400, 'content must be a string');
    const buf = Buffer.from(b.content, 'utf8');
    if (buf.length > MAX_WRITE) throw fail(413, `file is larger than ${MAX_WRITE / 1048576} MB`);
    const { full } = entry(root, rel);
    const ls = lstat(full);
    let target = full, mode = null;
    if (ls) {
      if (ls.isSymbolicLink()) target = existing(root, rel); // write through a link only when it stays inside
      const st = fs.statSync(target);
      if (!st.isFile()) throw fail(400, 'not a file');
      if (secret.test(path.basename(target))) throw fail(403, 'this file is never changed here');
      mode = st.mode & 0o7777;
      const cur = etagOf(fs.readFileSync(target));
      if (!b.force && cur !== b.etag) throw fail(409, 'the file changed on disk since it was opened', { conflict: true, etag: cur, mtime: st.mtimeMs });
    } else if (!b.force && b.etag) throw fail(409, 'the file was deleted on disk since it was opened', { conflict: true, missing: true });
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.swarm-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      const fd = fs.openSync(tmp, 'wx', mode ?? 0o666);
      try { fs.writeSync(fd, buf); if (mode != null) fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, target);
    } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
    const st = fs.statSync(target);
    return { path: rel, etag: etagOf(buf), mtime: st.mtimeMs, size: st.size };
  }

  function create(root, b) {
    const rel = relOf(root, root, b.path), { full } = entry(root, rel);
    if (lstat(full)) throw fail(409, 'a file or folder with that name already exists');
    if (b.type === 'dir') fs.mkdirSync(full); else fs.writeFileSync(full, '', { flag: 'wx' });
    return { path: rel, type: b.type === 'dir' ? 'dir' : 'file' };
  }

  function rename(root, b) {
    const from = relOf(root, root, b.from), to = relOf(root, root, b.to), src = entry(root, from), dst = entry(root, to);
    if (!lstat(src.full)) throw fail(404, 'not found');
    if (lstat(dst.full)) throw fail(409, 'a file or folder with that name already exists');
    if (isProtected(src.full)) throw fail(403, 'browser profiles are never changed');
    if (fs.lstatSync(src.full).isDirectory()) guardTree(src.full);
    fs.renameSync(src.full, dst.full); // a link is moved as a link
    return { from, path: to };
  }

  function remove(root, b) {
    const rel = relOf(root, root, b.path), { full } = entry(root, rel), ls = lstat(full);
    if (!ls) throw fail(404, 'not found');
    if (isProtected(full)) throw fail(403, 'browser profiles are never changed');
    if (ls.isDirectory()) guardTree(full);
    if (ls.isDirectory()) fs.rmSync(full, { recursive: true }); // rm does not follow links inside the tree
    else fs.unlinkSync(full); // a link: only the link goes
    return { path: rel };
  }

  // { paths: [...] } -> { stats: { path: { mtime, size } | { missing: true } } }, for the editor's change polling
  function stats(root, b) {
    const out = {};
    for (const p of (Array.isArray(b.paths) ? b.paths : []).slice(0, 100)) {
      try { const st = fs.statSync(existing(root, relOf(root, root, p))); out[p] = st.isFile() ? { mtime: st.mtimeMs, size: st.size } : { missing: true }; }
      catch (e) { out[p] = e.code === 404 ? { missing: true } : { error: e.message }; }
    }
    return { stats: out };
  }

  // the file's content at HEAD of the repo it is in (for the diff view)
  function head(root, rel) {
    const rp = existing(root, rel);
    if (secret.test(path.basename(rp))) throw fail(403, 'this file is never opened here');
    return new Promise((resolve, reject) => {
      execFile('git', ['-c', 'core.fsmonitor=false', '-C', path.dirname(rp), 'show', 'HEAD:./' + path.basename(rp)], { maxBuffer: MAX_OPEN + 1024, encoding: 'buffer', timeout: 15000 }, (e, out) => {
        if (e) return reject(fail(e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 413 : 404, e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'the HEAD version is too large' : 'not in git at HEAD (new, untracked, or not a repository)'));
        if (!isText(out)) return reject(fail(415, 'binary at HEAD', { binary: true }));
        resolve({ path: rel, content: out.toString('utf8') });
      });
    });
  }

  async function handle(agent, op, req, url) {
    const root = rootOf(agent), q = (k) => url.searchParams.get(k) || '';
    const get = req.method === 'GET', post = req.method === 'POST' || req.method === 'PUT';
    if (op === 'list' && get) return list(root, relOf(root, agent.cwd, q('path')), q('all') === '1');
    if (op === 'file' && get) return read(root, relOf(root, agent.cwd, q('path')));
    if (op === 'head' && get) return head(root, relOf(root, agent.cwd, q('path')));
    if (!post) throw fail(405, 'method not allowed');
    const b = await readJson(req);
    if (op === 'file') return write(root, b);
    if (op === 'stat') return stats(root, b);
    if (op === 'create') return create(root, b);
    if (op === 'rename') return rename(root, b);
    if (op === 'delete') return remove(root, b);
    throw fail(404, 'not found');
  }

  // -> [status, body]; fs errors (string codes) map to HTTP statuses
  async function route(agent, op, req, url) {
    try { return [200, await handle(agent, op, req, url)]; }
    catch (e) {
      const code = typeof e.code === 'number' ? e.code : FS_CODES[e.code] || 500;
      return [code, { error: e.message, ...(e.extra || {}) }];
    }
  }
  return { route, handle };
}
