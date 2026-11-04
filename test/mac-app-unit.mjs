// Unit checks (no server, nothing launched): `halay app` (mac-app.js, cli.js parseArgs): argument parsing, the exec bit npm
// drops, launching with the data folder and port, install to ~/Applications and its refusals.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../src/cli/cli.js';
import { appCmd, bundledApp, installedApp, ensureExecutable, isHalayApp, executable } from '../src/cli/mac-app.js';
import { checker } from './lib/spare.mjs';
const { ok, done } = checker();

// ---- arguments
ok(parseArgs(['app']).cmd === 'app' && parseArgs(['app']).sub === null && !parseArgs(['app']).error, '`halay app` alone is fine');
ok(parseArgs(['app', 'install']).sub === 'install', '`halay app install`');
ok(/unknown "halay app nope"/.test(parseArgs(['app', 'nope']).error), 'an unknown app subcommand is an error');
ok(/needs one of/.test(parseArgs(['service']).error), 'service still needs its subcommand');

// ---- a fake package with a built app whose executable has lost its exec bit (what npm unpacks)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-app-unit-'));
const mkApp = (dir, { id = 'app.halay.mac', mode = 0o644 } = {}) => {
  fs.mkdirSync(path.join(dir, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleIdentifier</key>\n<string>${id}</string></dict></plist>`);
  fs.writeFileSync(executable(dir), '#!/bin/sh\n', { mode });
  fs.chmodSync(executable(dir), mode);
};
const root = path.join(tmp, 'pkg'), home = path.join(tmp, 'home');
mkApp(bundledApp(root));
ok(bundledApp(root) === path.join(root, 'macos', 'build', 'halay.app') && installedApp(home) === path.join(home, 'Applications', 'halay.app'), 'bundled and installed paths');
ok(!(fs.statSync(executable(bundledApp(root))).mode & 0o111), 'setup: the executable has no exec bit');
ok(ensureExecutable(bundledApp(root)) === null && (fs.statSync(executable(bundledApp(root))).mode & 0o111) === 0o111, 'ensureExecutable sets the exec bit');
ok(/EPERM/.test(ensureExecutable('/x', { stat: () => ({ mode: 0o644 }), chmod: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); } })), 'ensureExecutable reports a chmod it is not allowed to do');
ok(isHalayApp(bundledApp(root)) && !isHalayApp(path.join(tmp, 'nothing')), 'isHalayApp checks the bundle id');

// ---- launch
const out = [], errs = [];
const io = { log: (m) => out.push(m), err: (m) => errs.push(m) };
let ran = null;
const base = { platform: 'darwin', root, home, kind: 'global', ...io, run: (c, a) => { ran = [c, a]; return { status: 0 }; } };
const ctx = { dataDir: '/data/halay', port: 4790 };
fs.chmodSync(executable(bundledApp(root)), 0o644);
ok(await appCmd(null, {}, ctx, base) === 0, 'halay app: exit 0');
ok(ran[0] === 'open' && ran[1][0] === bundledApp(root) && ran[1].join(' ').endsWith('--args --data-dir /data/halay --port 4790'), 'launches the bundle with `open`, passing the data folder and port');
ok(fs.statSync(executable(bundledApp(root))).mode & 0o111, 'the exec bit was set before launching');
ok(await appCmd(null, {}, ctx, { ...base, run: () => ({ status: 1, stderr: 'boom' }) }) === 1 && /could not open/.test(errs.at(-1)), 'a failed open is reported');
ok(await appCmd(null, {}, ctx, { ...base, ensureExec: () => 'EPERM' }) === 1 && /halay app install/.test(errs.at(-1)), 'cannot chmod (root-owned global install): points to `halay app install`');
ok(await appCmd(null, {}, ctx, { ...base, platform: 'linux' }) === 1 && /macOS/.test(errs.at(-1)), 'not macOS: says so');
ok(await appCmd(null, {}, ctx, { ...base, root: path.join(tmp, 'empty'), kind: 'clone' }) === 1 && /macos\/build\.sh/.test(errs.at(-1)), 'a checkout without a build: tells how to build');
ok(await appCmd(null, {}, ctx, { ...base, root: path.join(tmp, 'empty') }) === 1 && /no Mac app/.test(errs.at(-1)), 'an install without the app: says so');

// ---- install
const copy = (from, to) => { fs.cpSync(from, to, { recursive: true }); return { status: 0 }; };
ok(await appCmd('install', {}, ctx, { ...base, copy }) === 0 && isHalayApp(installedApp(home)), 'install copies the app to ~/Applications');
ok(fs.statSync(executable(installedApp(home))).mode & 0o111, 'the installed executable is executable');
ok(await appCmd('install', {}, ctx, { ...base, copy }) === 0, 'installing again replaces it');
fs.rmSync(installedApp(home), { recursive: true });
mkApp(installedApp(home), { id: 'com.example.other' });
ok(await appCmd('install', {}, ctx, { ...base, copy }) === 1 && /not the halay app/.test(errs.at(-1)) && !isHalayApp(installedApp(home)), 'a foreign app of that name is not replaced');
fs.rmSync(installedApp(home), { recursive: true });
ok(await appCmd('install', {}, ctx, { ...base, copy: () => ({ status: 1, stderr: 'disk full' }) }) === 1 && /disk full/.test(errs.at(-1)), 'a failed copy is reported');

fs.rmSync(tmp, { recursive: true, force: true });
done();
