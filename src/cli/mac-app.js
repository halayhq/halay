// `halay app [install]`: the macOS menu-bar app (macos/): server status in the menu bar and the web UI in a window of its
// own, already signed in. It is a thin shell; the server stays this Node server.
//
// The .app is built by macos/build.sh (universal, ad-hoc signed, not notarized) and ships inside the npm package at
// macos/build/halay.app. Files npm unpacks are not quarantined, so Gatekeeper never checks it (a downloaded copy would
// be). npm does drop the exec bit of unpacked files, though, and a bundle whose executable isn't executable won't
// launch, so it is set again here before every launch (as terminal.js does for node-pty's spawn-helper).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, INSTALL_KIND } from './cli.js';

export const APP = 'halay.app';
export const BUNDLE_ID = 'app.halay.mac';
export const bundledApp = (root = ROOT) => path.join(root, 'macos', 'build', APP);
export const installedApp = (home = os.homedir()) => path.join(home, 'Applications', APP);
export const executable = (app) => path.join(app, 'Contents', 'MacOS', 'halay');

// Makes the bundle's executable executable. -> null, or why it couldn't be (a root-owned global install, say)
export function ensureExecutable(app, { stat = fs.statSync, chmod = fs.chmodSync } = {}) {
  const exe = executable(app);
  try { if (stat(exe).mode & 0o111) return null; chmod(exe, 0o755); return null; } catch (e) { return `${exe}: ${e.code || e.message}`; }
}

// is this folder a halay app bundle (so it is ours to replace)?
export const isHalayApp = (app, { readFile = fs.readFileSync } = {}) => {
  try { return readFile(path.join(app, 'Contents', 'Info.plist'), 'utf8').includes(`<string>${BUNDLE_ID}</string>`); } catch { return false; }
};

const copyApp = (from, to) => spawnSync('ditto', [from, to], { encoding: 'utf8' }); // ditto keeps the signature, modes and attributes intact

export async function appCmd(sub, opts, ctx, {
  platform = process.platform, root = ROOT, kind = INSTALL_KIND, home = os.homedir(), log = console.log, err = console.error,
  exists = fs.existsSync, run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }), copy = copyApp, ensureExec = ensureExecutable,
} = {}) {
  if (platform !== 'darwin') { err(`halay app is the macOS menu-bar app; this is ${platform}. Open the web UI in a browser instead (\`halay token\`).`); return 1; }
  const app = bundledApp(root);
  if (!exists(app)) {
    err(kind === 'clone'
      ? `the Mac app is not built in this checkout (${app} is missing). Build it with: macos/build.sh (needs the Xcode command line tools).`
      : `this halay install has no Mac app (${app} is missing). Reinstall: npm install -g @halay/app`);
    return 1;
  }

  if (sub === 'install') {
    const dest = installedApp(home);
    if (exists(dest) && !isHalayApp(dest)) { err(`${dest} exists and is not the halay app; not replacing it.`); return 1; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    const r = copy(app, dest);
    if (r.status !== 0) { err(`could not copy the app to ${dest}: ${(r.stderr || r.error?.message || 'exit ' + r.status).trim()}`); return 1; }
    const bad = ensureExec(dest);
    if (bad) { err(`copied, but the app can't be made executable: ${bad}`); return 1; }
    log(`installed ${dest}. Open it from Spotlight or \`halay app\`; tick Launch at Login in its menu to start it at login.`);
    log('Run `halay app install` again after updating halay (an app that is already running keeps its version until you quit it from the menu bar).');
    return 0;
  }

  const bad = ensureExec(app);
  if (bad) { err(`can't make the Mac app executable (${bad}). Run \`halay app install\` to use a copy in ~/Applications instead.`); return 1; }
  // the data folder and port the CLI resolved, so the app finds the same server even when started from another shell/folder;
  const r = run('open', [app, '--args', '--data-dir', ctx.dataDir, '--port', String(ctx.port)]);
  if (r.status !== 0) { err(`could not open ${app}: ${(r.stderr || r.error?.message || 'exit ' + r.status).trim()}`); return 1; }
  log(`halay app opened (menu bar, top right). Server: http://localhost:${ctx.port}/ (data folder ${ctx.dataDir}).`);
  return 0;
}
