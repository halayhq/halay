// Unit checks (no server): install-kind.js (npx / global / local / clone detection, temporary folders) and
// `halay service install` refusing to point a service at a temporary folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installKind, isNpxPath, temporaryReason, npxCacheDirs } from '../src/cli/install-kind.js';
import { serviceCmd } from '../src/cli/service.js';
import { checker } from './lib/spare.mjs';
const { ok, done } = checker();

const none = () => false, home = '/Users/u', env = {};
const kind = (root, e = env, exists = none) => installKind(root, { env: e, home, exists });

// ---- npx / npm exec
ok(isNpxPath('/Users/u/.npm/_npx/abc123/node_modules/@halay/app', { env, home }), 'default npm cache: ~/.npm/_npx/<hash>/…');
ok(kind('/Users/u/.npm/_npx/abc123/node_modules/@halay/app') === 'npx', 'kind: npx');
ok(kind('/somewhere/odd/_npx/x/node_modules/@halay/app') === 'npx', 'a _npx folder anywhere (a cache we cannot see) counts');
ok(kind('/data/cache/_npx/h/node_modules/@halay/app', { npm_config_cache: '/data/cache' }) === 'npx', 'custom cache via npm_config_cache');
ok(kind('/data/cache2/_npx/h/node_modules/@halay/app', { NPM_CONFIG_CACHE: '/data/cache2' }) === 'npx', 'custom cache via NPM_CONFIG_CACHE');
ok(npxCacheDirs({ env: { npm_config_cache: '/c' }, home }).includes('/c/_npx'), 'npxCacheDirs lists the custom cache');
ok(kind('/Users/u/.npm/_npxfoo/x/@halay/app') !== 'npx' && kind('/Users/u/_npx-notes/halay') !== 'npx', 'a folder merely starting with _npx is not the cache');

// ---- the other kinds
ok(kind('/Users/u/code/halay', env, (p) => p === '/Users/u/code/halay/.git') === 'clone', 'kind: clone (has .git)');
ok(kind('/opt/homebrew/lib/node_modules/@halay/app') === 'global', 'kind: global (…/lib/node_modules/@halay/app)');
ok(kind('/Users/u/.nvm/versions/node/v24.1.0/lib/node_modules/@halay/app') === 'global', 'kind: global under nvm');
ok(kind('/Users/u/project/node_modules/@halay/app') === 'local', 'kind: local (a project\'s node_modules)');
ok(kind('/Users/u/code/halay', env, (p) => p.endsWith('.git')) === 'clone', 'clone wins even under a path with node_modules-looking names');

// ---- temporary places
const t = (root, e = env, exists = none) => temporaryReason(root, { env: e, home, exists });
ok(/npx cache/.test(t('/Users/u/.npm/_npx/a/node_modules/@halay/app')), 'npx cache is temporary');
ok(/\/tmp/.test(t('/tmp/x/node_modules/@halay/app')) && /\/var\/folders/.test(t('/var/folders/ab/cd/T/x/node_modules/@halay/app')), '/tmp and macOS /var/folders are temporary');
ok(t('/Users/u/.nvm/versions/node/v24/lib/node_modules/@halay/app') === null && t('/opt/homebrew/lib/node_modules/@halay/app') === null && t('/Users/u/project/node_modules/@halay/app') === null, 'global and local installs are fine');
ok(t('/tmp/clone/halay', env, (p) => p === '/tmp/clone/halay/.git') === null, 'a git clone is never refused, even in /tmp');
ok(t('/Volumes/Data/tmp/a6c/node_modules/@halay/app') === null, 'a TMPDIR someone keeps elsewhere is not "temporary"');

// ---- service install refuses (also --dry-run), and writes nothing
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'svc-npx-'));
try {
  for (const platform of ['darwin', 'linux']) for (const dry of [false, true]) {
    const out = [], h = path.join(tmp, platform + dry);
    const ctx = { dataDir: path.join(h, '.halay'), reason: 'home', pidFile: path.join(h, '.halay/runs/server.pid') };
    const code = await serviceCmd('install', { 'dry-run': dry, host: [] }, ctx, { platform, home: h, root: '/Users/u/.npm/_npx/abc/node_modules/@halay/app', log: (m) => out.push(m), err: (m) => out.push(m), capture: () => { throw new Error('must not get that far'); } });
    const text = out.join('\n');
    ok(code === 1 && /temporary npx cache/.test(text) && text.includes('npm install -g @halay/app') && text.includes('halay service install') && !text.includes('would write') && !fs.existsSync(h), `${platform}${dry ? ' --dry-run' : ''}: refused with the install-for-good instructions, nothing written`);
  }
  const out = [], h = path.join(tmp, 'ok');
  const ctx = { dataDir: path.join(h, '.halay'), reason: 'home', pidFile: path.join(h, '.halay/runs/server.pid') };
  const code = await serviceCmd('install', { 'dry-run': true, host: [] }, ctx, { platform: 'linux', home: h, root: '/opt/homebrew/lib/node_modules/@halay/app', log: (m) => out.push(m), err: (m) => out.push(m), capture: () => ({ path: '/usr/bin', source: 'fallback', note: 't' }) });
  ok(code === 0 && out.join('\n').includes('/opt/homebrew/lib/node_modules/@halay/app/bin/halay.js'), 'a global install dry-runs fine and the unit points at its bin/halay.js');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

done();
