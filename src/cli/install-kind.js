// How this copy of halay was installed, from where its folder (ROOT) is: 'clone' (a git checkout), 'npx' (npm's
// temporary npx / `npm exec` cache, which npm may clean at any time and refill with another version), 'global'
// (npm install -g), 'local' (a node_modules folder of some project). Plus: is that folder in a temporary place a
// background service must not point at? Pure functions of their arguments, so they are unit tested.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// npm's cache: npm_config_cache (also spelled NPM_CONFIG_CACHE), else ~/.npm. A custom one is covered; the `_npx`
// directory name is matched anywhere in the path as well (a cache we can't see from the environment).
export function npxCacheDirs({ env = process.env, home = os.homedir() } = {}) {
  const c = env.npm_config_cache || env.NPM_CONFIG_CACHE;
  return [...new Set([c && path.join(c, '_npx'), path.join(home, '.npm', '_npx')].filter(Boolean).flatMap((d) => [path.resolve(d), real(d)]))];
}

export function isNpxPath(root, opts = {}) {
  const variants = [path.resolve(root), real(root)];
  return variants.some((r) => r.split(path.sep).includes('_npx') || npxCacheDirs(opts).some((d) => inside(r, d)));
}

// -> 'clone' | 'npx' | 'global' | 'local'
export function installKind(root, { exists = fs.existsSync, ...opts } = {}) {
  if (exists(path.join(root, '.git'))) return 'clone';
  if (isNpxPath(root, opts)) return 'npx';
  const parts = path.resolve(root).split(path.sep);
  return parts.slice(-3, -1).join('/') === 'node_modules/@halay' && parts[parts.length - 4] === 'lib' ? 'global' : 'local';
}

export const KIND_LABEL = { clone: 'git clone', npx: 'npx (temporary)', global: 'global npm install', local: 'local npm install' };

// Folders that are cleaned out on their own: /tmp and friends, macOS's per-user temp (/var/folders), the npx cache.
// Fixed list, not os.tmpdir(): a TMPDIR someone points at a folder they keep must not count.
const TEMP_DIRS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/dev/shm', '/var/folders', '/private/var/folders'];

// -> null when `root` is a fine place for a service to point at, else a short reason. A git clone is never refused.
export function temporaryReason(root, opts = {}) {
  if (installKind(root, opts) === 'clone') return null;
  if (isNpxPath(root, opts)) return "it runs from npm's temporary npx cache";
  for (const r of [path.resolve(root), real(root)]) {
    const d = TEMP_DIRS.find((t) => inside(r, t));
    if (d) return `it lives in a temporary folder (${d})`;
  }
  return null;
}

export const INSTALL_FOR_GOOD = 'npm install -g @halay/app';
