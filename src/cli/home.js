// Where halay keeps its runtime data (the "data dir"): access token, database, runs/, tmp/, bots/, plugins/,
// plugin-data/, conductor/, logs/, .env. The code and static files are always read from the app folder (ROOT).
// Shared by server.js and the `halay` command (bin/halay.js), so both find the same folder.
//
// Resolution, first match wins:
//   1. HALAY_HOME                     an explicit folder (a leading ~ is expanded)
//   2. HALAY_DB's folder              when only HALAY_DB is set: runs/ and plugins/ always lived next to it, so a server
//                                     started that way (the tests, spare instances) keeps all its data there
//   3. ROOT, when it is a git checkout that already holds data (.token or halay.db): installs from a clone
//      made before the data dir existed keep working untouched
//   4. ~/.halay                       everything else (a global npm install, a fresh clone)
// HALAY_HOME and HALAY_DB are read from the environment, else from ROOT/.env (a clone's settings file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

const expandHome = (p, home) => p.replace(/^~(?=$|\/)/, home);
const readEnvFile = (f) => { try { return parseEnv(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// -> { dir, reason: 'HALAY_HOME' | 'HALAY_DB' | 'checkout' | 'home' }
export function resolveDataDir({ env = process.env, root, home = os.homedir(), exists = fs.existsSync } = {}) {
  const pick = (name) => String(env['HALAY_' + name] ?? '');
  const h = pick('HOME').trim();
  if (h) return { dir: path.resolve(expandHome(h, home)), reason: 'HALAY_HOME' };
  const db = pick('DB').trim();
  if (db) return { dir: path.dirname(path.resolve(expandHome(db, home))), reason: 'HALAY_DB' };
  if (root && exists(path.join(root, '.git')) && ['.token', 'halay.db'].some((f) => exists(path.join(root, f))))
    return { dir: root, reason: 'checkout' };
  return { dir: path.join(home, '.halay'), reason: 'home' };
}

export const describeReason = (r) => ({ HALAY_HOME: 'set by HALAY_HOME', HALAY_DB: "HALAY_DB's folder", checkout: 'the app folder (a git checkout with existing data)', home: 'the default' })[r] || r;

// Create the data dir (mode 700) and tighten it when it is halay's own folder; an existing folder that is a checkout
// or was named with HALAY_HOME / HALAY_DB is left as it is. -> true when it was created now
export function ensureDataDir({ dir, reason }) {
  const created = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (created || reason === 'home') try { fs.chmodSync(dir, 0o700); } catch {}
  return created;
}

// Resolve the data dir and load the .env files into `target` (process.env). Precedence: the real environment, then
// <data dir>/.env, then ROOT/.env (a clone's; an npm install has none). A variable set in an earlier one is never
// overwritten by a later one. -> { dir, reason, envFiles: [loaded files] }
export function setupHome({ root, env = process.env, home = os.homedir() } = {}) {
  const rootEnvFile = path.join(root, '.env');
  const rootEnv = readEnvFile(rootEnvFile);
  const { dir, reason } = resolveDataDir({ env: { ...(rootEnv || {}), ...env }, root, home });
  const envFiles = [];
  for (const f of [...new Set([path.join(dir, '.env'), rootEnvFile])]) {
    const vars = f === rootEnvFile ? rootEnv : readEnvFile(f);
    if (!vars) continue;
    envFiles.push(f);
    for (const [k, v] of Object.entries(vars)) if (!(k in env)) env[k] = v;
  }
  return { dir, reason, envFiles };
}
