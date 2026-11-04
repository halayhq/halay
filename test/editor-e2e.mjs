// REST check of the code editor's file API (/api/agents/:id/edit/*, editor-fs.js) against a SPARE instance (never the live
// server); makes no model calls. With no BASE it starts its own instance on a free port with a throwaway database and the
// fake CLI first in PATH:
//   node test/editor-e2e.mjs
// or against an instance you started (fake CLI first in PATH, see test/models-e2e.mjs):
//   BASE=http://127.0.0.1:4793 TOKEN=t node test/editor-e2e.mjs
// Covers listing (hidden folders), read/write round trips, `..` and absolute-path escapes, symlinks that leave the folder
// (read, write, list, create under), the size and binary limits, secret names, the etag conflict and force, atomic writes,
// create / rename / delete, change polling and the git HEAD version.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createEditorFs } from '../src/editor-fs.js';
import { spareHome } from './lib/spare.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let BASE = process.env.BASE, TOKEN = process.env.TOKEN, server = null;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-e2e-'));

if (!BASE) {
  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  TOKEN = 'editor-e2e-' + Date.now();
  BASE = 'http://127.0.0.1:' + port;
  server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, ...spareHome(scratch), PORT: String(port), HOST: '127.0.0.1', HALAY_DB: path.join(scratch, 'halay.db'), HALAY_TOKEN: TOKEN, PATH: path.join(ROOT, 'test/fake-claude') + ':' + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100 && !log.includes('running'); i++) await sleep(100);
  if (!log.includes('running')) { console.log(log); throw new Error('spare server did not start'); }
}

const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + '/api' + p, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};

const dir = path.join(scratch, 'proj'), outside = path.join(scratch, 'outside');
fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true }); fs.mkdirSync(outside);
fs.writeFileSync(path.join(dir, 'src/a.js'), 'let a = 1;\n');
fs.writeFileSync(path.join(dir, 'node_modules/x/i.js'), '');
fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'esc-file'));
fs.symlinkSync(outside, path.join(dir, 'esc-dir'));
fs.symlinkSync('src/a.js', path.join(dir, 'ok-link.js'));
execFileSync('git', ['init', '-q'], { cwd: dir });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'src/a.js'], { cwd: dir });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });

let agentId = null;
try {
  let r = await api('/agents', 'POST', { cwd: dir, name: 'editor e2e' });
  agentId = r.j.id;
  ok(r.status === 201 && agentId, 'agent created in a scratch folder');
  const E = (op, q = '') => `/agents/${agentId}/edit/${op}${q}`;
  const enc = encodeURIComponent;

  // listing
  r = await api(E('list'));
  const names = (r.j.entries || []).map((e) => e.name);
  ok(r.status === 200 && names.includes('src') && !names.includes('.git') && !names.includes('node_modules') && r.j.hidden === 2, 'root listed, .git and node_modules hidden by default');
  ok(r.j.entries?.[0]?.type === 'dir', 'folders first');
  ok(r.j.entries?.find((e) => e.name === 'esc-dir')?.outside && r.j.entries?.find((e) => e.name === 'esc-file')?.outside, 'symlinks leaving the folder are marked outside');
  ok(r.j.entries?.find((e) => e.name === 'ok-link.js')?.outside !== true, 'a symlink inside the folder is fine');
  r = await api(E('list', '?all=1'));
  ok(r.j.entries?.some((e) => e.name === '.git') && r.j.entries?.some((e) => e.name === 'node_modules'), 'all=1 shows them');
  r = await api(E('list', '?path=src'));
  ok(r.status === 200 && r.j.entries?.length === 1 && r.j.entries[0].name === 'a.js', 'subfolder listed');
  ok((await api(E('list', '?path=esc-dir'))).status === 403, 'listing through a symlink that leaves the folder is refused');
  ok((await api(E('list', '?path=' + enc('../outside')))).status === 400, 'listing ../ is refused');

  // read
  r = await api(E('file', '?path=src/a.js'));
  const a = r.j;
  ok(r.status === 200 && a.content === 'let a = 1;\n' && a.etag && a.mtime > 0 && a.size === 11, 'file read with etag and mtime');
  ok((await api(E('file', '?path=' + enc(path.join(fs.realpathSync(dir), 'src/a.js'))))).j.path === 'src/a.js', 'an absolute path inside the folder works and comes back relative');
  ok((await api(E('file', '?path=' + enc('src/../../outside/secret.txt')))).status === 400, '.. traversal refused');
  r = await api(E('file', '?path=' + enc(path.join(outside, 'secret.txt'))));
  ok(r.status === 403 && r.j.outside, 'absolute path outside the folder refused');
  r = await api(E('file', '?path=esc-file'));
  ok(r.status === 403 && r.j.outside && !JSON.stringify(r.j).includes('outside\\n'), 'symlink to a file outside refused (content not leaked)');
  ok((await api(E('file', '?path=esc-dir/secret.txt'))).status === 403, 'file under a symlinked folder outside refused');
  ok((await api(E('file', '?path=ok-link.js'))).j.content === 'let a = 1;\n', 'symlink inside the folder readable');
  r = await api(E('file', '?path=big.txt'));
  ok(r.status === 413 && r.j.tooLarge && r.j.size > 2 * 1024 * 1024, 'file over 2 MB refused with tooLarge (viewer fallback)');
  r = await api(E('file', '?path=bin.dat'));
  ok(r.status === 415 && r.j.binary, 'binary file refused with binary (viewer fallback)');
  ok((await api(E('file', '?path=.env'))).status === 403, 'secret names (.env) are not opened');
  ok((await api(E('file', '?path=nope.txt'))).status === 404, 'missing file is 404');
  ok((await api(E('file', '?path=src'))).status === 400, 'a folder is not a file');

  // write + conflicts
  r = await api(E('file'), 'PUT', { path: 'src/a.js', content: 'let a = 2;\n', etag: a.etag });
  ok(r.status === 200 && r.j.etag && r.j.etag !== a.etag, 'save with the opened etag works');
  ok(fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8') === 'let a = 2;\n', 'content on disk');
  ok(!fs.readdirSync(path.join(dir, 'src')).some((f) => f.endsWith('.tmp')), 'no temp file left behind (atomic write)');
  const mine = r.j.etag;
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'let a = 3; // the agent\n'); // someone else edits it
  r = await api(E('file'), 'PUT', { path: 'src/a.js', content: 'let a = 4;\n', etag: mine });
  ok(r.status === 409 && r.j.conflict && r.j.etag && r.j.etag !== mine, 'save over a file changed on disk is refused (409 conflict)');
  ok(fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8') === 'let a = 3; // the agent\n', 'the agent\'s version is untouched');
  r = await api(E('file'), 'PUT', { path: 'src/a.js', content: 'let a = 4;\n', etag: mine, force: true });
  ok(r.status === 200 && fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8') === 'let a = 4;\n', 'force overwrites');
  fs.chmodSync(path.join(dir, 'src/a.js'), 0o755);
  r = await api(E('file'), 'PUT', { path: 'src/a.js', content: 'let a = 5;\n', etag: r.j.etag });
  ok(r.status === 200 && (fs.statSync(path.join(dir, 'src/a.js')).mode & 0o777) === 0o755, 'file mode kept across the atomic rename');
  fs.rmSync(path.join(dir, 'src/gone.js'), { force: true });
  r = await api(E('file'), 'PUT', { path: 'src/gone.js', content: 'x', etag: 'abc' });
  ok(r.status === 409 && r.j.missing, 'save of a file deleted on disk is a conflict');
  r = await api(E('file'), 'PUT', { path: 'esc-file', content: 'pwned', etag: null, force: true });
  ok(r.status === 403 && fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8') === 'outside\n', 'writing through a symlink that leaves the folder is refused');
  r = await api(E('file'), 'PUT', { path: 'esc-dir/new.txt', content: 'x', force: true });
  ok(r.status === 403 && !fs.existsSync(path.join(outside, 'new.txt')), 'creating a file under a symlinked folder outside is refused');
  r = await api(E('file'), 'PUT', { path: '../outside/new.txt', content: 'x', force: true });
  ok(r.status === 400 && !fs.existsSync(path.join(outside, 'new.txt')), 'writing to ../ is refused');
  ok((await api(E('file'), 'PUT', { path: '.env', content: 'x', force: true })).status === 403 && fs.readFileSync(path.join(dir, '.env'), 'utf8') === 'SECRET=1\n', 'secret names are not written');
  ok((await api(E('file'), 'PUT', { path: 'huge.txt', content: 'y'.repeat(5 * 1024 * 1024 + 1) })).status === 413, 'writes over 5 MB refused');

  // create, rename, delete
  ok((await api(E('create'), 'POST', { path: 'lib', type: 'dir' })).status === 200 && fs.statSync(path.join(dir, 'lib')).isDirectory(), 'folder created');
  ok((await api(E('create'), 'POST', { path: 'lib/n.py', type: 'file' })).status === 200 && fs.readFileSync(path.join(dir, 'lib/n.py'), 'utf8') === '', 'file created');
  ok((await api(E('create'), 'POST', { path: 'lib/n.py', type: 'file' })).status === 409, 'creating over an existing name refused');
  ok((await api(E('create'), 'POST', { path: 'esc-dir/x', type: 'file' })).status === 403 && !fs.existsSync(path.join(outside, 'x')), 'creating under a symlink outside refused');
  ok((await api(E('rename'), 'POST', { from: 'lib/n.py', to: 'lib/m.py' })).status === 200 && fs.existsSync(path.join(dir, 'lib/m.py')), 'renamed');
  ok((await api(E('rename'), 'POST', { from: 'lib/m.py', to: 'src/a.js' })).status === 409, 'rename onto an existing name refused');
  ok((await api(E('rename'), 'POST', { from: 'lib/m.py', to: '../m.py' })).status === 400, 'rename out of the folder refused');
  ok((await api(E('rename'), 'POST', { from: 'lib/m.py', to: 'esc-dir/m.py' })).status === 403 && !fs.existsSync(path.join(outside, 'm.py')), 'rename into a symlink outside refused');
  ok((await api(E('delete'), 'POST', { path: 'esc-dir' })).status === 200 && fs.existsSync(path.join(outside, 'secret.txt')), 'deleting a symlink removes only the link');
  ok((await api(E('delete'), 'POST', { path: 'lib' })).status === 200 && !fs.existsSync(path.join(dir, 'lib')), 'folder deleted');
  // a parent folder that holds a secret or a browser profile can't be removed or renamed either
  fs.mkdirSync(path.join(dir, 'cfg/deep'), { recursive: true }); fs.writeFileSync(path.join(dir, 'cfg/deep/.env'), 'S=1\n');
  r = await api(E('delete'), 'POST', { path: 'cfg' });
  ok(r.status === 403 && fs.existsSync(path.join(dir, 'cfg/deep/.env')), 'deleting a folder with a .env inside refused');
  ok((await api(E('rename'), 'POST', { from: 'cfg', to: 'cfg2' })).status === 403 && fs.existsSync(path.join(dir, 'cfg/deep/.env')), 'renaming a folder with a .env inside refused');
  {
    const prof = path.join(dir, 'runs/browser-profiles/default'); fs.mkdirSync(prof, { recursive: true });
    const efs = createEditorFs({ isProtected: (rp) => rp.startsWith(fs.realpathSync(path.join(dir, 'runs/browser-profiles'))), secret: /^\.env$/ });
    const fake = { cwd: dir }, call = (op, body) => { const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; return efs.route(fake, op, req, new URL('http://x/')); };
    let [st] = await call('delete', { path: 'runs' });
    ok(st === 403 && fs.existsSync(prof), 'deleting a parent of browser profiles refused');
    [st] = await call('rename', { from: 'runs', to: 'runs2' });
    ok(st === 403 && fs.existsSync(prof), 'renaming a parent of browser profiles refused');
    fs.rmSync(path.join(dir, 'runs'), { recursive: true });
  }
  ok((await api(E('delete'), 'POST', { path: '' })).status === 400 && fs.existsSync(dir), 'the folder itself cannot be deleted');
  ok((await api(E('delete'), 'POST', { path: '..' })).status === 400, 'deleting .. refused');

  // change polling and HEAD
  r = await api(E('stat'), 'POST', { paths: ['src/a.js', 'nope.txt', 'esc-file'] });
  ok(r.status === 200 && r.j.stats['src/a.js'].mtime > 0 && r.j.stats['nope.txt'].missing && r.j.stats['esc-file'].error, 'stat for polling: mtime, missing, refused');
  r = await api(E('head', '?path=src/a.js'));
  ok(r.status === 200 && r.j.content === 'let a = 1;\n', 'HEAD version for the diff view');
  ok((await api(E('head', '?path=big.txt'))).status === 404, 'untracked file has no HEAD version');

  // auth
  const u = await fetch(BASE + `/api/agents/${agentId}/edit/file?path=src/a.js`);
  ok(u.status === 401, 'unauthenticated read refused');
  const w = await fetch(BASE + `/api/agents/${agentId}/edit/file`, { method: 'PUT', body: JSON.stringify({ path: 'src/a.js', content: 'x', force: true }) });
  ok(w.status === 401 && fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8') === 'let a = 5;\n', 'unauthenticated write refused');
  ok((await api('/agents/nope/edit/list')).status === 404, 'unknown agent is 404');

  // static Monaco route
  const m = await fetch(BASE + '/vendor/monaco/vs/loader.js', { headers: { authorization: 'Bearer ' + TOKEN } });
  ok(m.status === 401, 'Monaco needs a browser session like the rest of the UI');
} finally {
  if (agentId) await api(`/agents/${agentId}?discard=1`, 'DELETE');
  if (server) server.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
