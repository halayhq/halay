// Unit checks (no server): the data dir (home.js resolveDataDir / setupHome / ensureDataDir).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDataDir, setupHome, ensureDataDir } from '../src/cli/home.js';
import { checker } from './lib/spare.mjs';
const { ok, done } = checker();

const H = '/Users/u', R = '/opt/halay';
const has = (...files) => (f) => files.includes(f);
let d = resolveDataDir({ env: {}, root: R, home: H, exists: has() });
ok(d.dir === '/Users/u/.halay' && d.reason === 'home', 'data dir: nothing set, not a checkout -> ~/.halay');
d = resolveDataDir({ env: {}, root: R, home: H, exists: has('/opt/halay/.git') });
ok(d.dir === '/Users/u/.halay' && d.reason === 'home', 'data dir: a fresh clone (no data in it) -> ~/.halay');
for (const f of ['.token', 'halay.db']) {
  d = resolveDataDir({ env: {}, root: R, home: H, exists: has('/opt/halay/.git', '/opt/halay/' + f) });
  ok(d.dir === R && d.reason === 'checkout', `data dir: a git checkout holding ${f} -> the checkout (old installs keep working)`);
}
d = resolveDataDir({ env: {}, root: R, home: H, exists: has('/opt/halay/.git', '/opt/halay/swarm.db') });
ok(d.reason === 'home', 'data dir: a checkout holding only a pre-rename swarm.db is not treated as a data folder');
d = resolveDataDir({ env: {}, root: R, home: H, exists: has('/opt/halay/.token') });
ok(d.reason === 'home', 'data dir: data next to the code but no git checkout (an npm install) -> ~/.halay');
d = resolveDataDir({ env: { HALAY_HOME: '/srv/h' }, root: R, home: H, exists: has('/opt/halay/.git', '/opt/halay/.token') });
ok(d.dir === '/srv/h' && d.reason === 'HALAY_HOME', 'data dir: HALAY_HOME wins over a checkout with data');
d = resolveDataDir({ env: { HALAY_HOME: '~/x' }, root: R, home: H, exists: has() });
ok(d.dir === '/Users/u/x', 'data dir: HALAY_HOME expands ~');
d = resolveDataDir({ env: { HALAY_HOME: '/srv/h', HALAY_DB: '/db/x.db' }, root: R, home: H, exists: has() });
ok(d.dir === '/srv/h', 'data dir: HALAY_HOME wins over HALAY_DB');
d = resolveDataDir({ env: { HALAY_DB: '/db/x.db' }, root: R, home: H, exists: has('/opt/halay/.git', '/opt/halay/.token') });
ok(d.dir === '/db' && d.reason === 'HALAY_DB', "data dir: only HALAY_DB set -> its folder (where runs/ always went)");
d = resolveDataDir({ env: { SWARM_DB: '/old/swarm.db', SWARM_HOME: '/old' }, root: R, home: H, exists: has() });
ok(d.dir === '/Users/u/.halay' && d.reason === 'home', 'data dir: the pre-rename SWARM_DB / SWARM_HOME names are ignored');

// setupHome: .env precedence (environment > <data dir>/.env > ROOT/.env) and HALAY_HOME from ROOT/.env
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'home-unit-'));
try {
  const root = path.join(tmp, 'app'), data = path.join(tmp, 'data'), home = path.join(tmp, 'home');
  fs.mkdirSync(root); fs.mkdirSync(data);
  fs.writeFileSync(path.join(root, '.env'), `HALAY_HOME=${data}\nA=root\nB=root\nC=root\n`);
  fs.writeFileSync(path.join(data, '.env'), 'A=data\nB=data\n');
  const e = { A: 'env' };
  const h = setupHome({ root, env: e, home });
  ok(h.dir === data && h.reason === 'HALAY_HOME', 'setupHome: HALAY_HOME can come from ROOT/.env');
  ok(e.A === 'env' && e.B === 'data' && e.C === 'root', 'setupHome: environment > data-dir .env > ROOT .env');
  ok(h.envFiles.length === 2 && h.envFiles[0] === path.join(data, '.env'), 'setupHome: reports the files it read');
  const e2 = {};
  const h2 = setupHome({ root: path.join(tmp, 'nothing'), env: e2, home });
  ok(h2.dir === path.join(home, '.halay') && !h2.envFiles.length, 'setupHome: no .env anywhere -> ~/.halay, nothing loaded');
  ok(ensureDataDir(h2) === true && (fs.statSync(h2.dir).mode & 0o777) === 0o700, 'ensureDataDir: creates ~/.halay with mode 700');
  ok(ensureDataDir(h2) === false, 'ensureDataDir: a second call creates nothing');
  fs.chmodSync(data, 0o755);
  ensureDataDir({ dir: data, reason: 'HALAY_HOME' });
  ok((fs.statSync(data).mode & 0o777) === 0o755, "ensureDataDir: an existing HALAY_HOME folder keeps its mode");
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

done();
