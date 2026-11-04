// Unit checks (no server, nothing loaded): `halay service` (service.js): PATH capture and its fallback, the launchd
// plist and systemd unit it writes, and install/uninstall --dry-run writing nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureLoginPath, launchdPlist, systemdUnit, commands, unitPath, serviceCmd } from '../src/cli/service.js';
import { parseArgs } from '../src/cli/cli.js';
import { checker } from './lib/spare.mjs';
const { ok, done } = checker();

// ---- captureLoginPath
const MARK = '__HALAY_PATH__';
let seen;
let r = captureLoginPath({ shell: '/bin/zsh', fallback: '/fb', nodeDir: '/n/bin', run: (sh, args, t) => { seen = { sh, args, t }; return `motd noise\n${MARK}/opt/homebrew/bin:/usr/bin:/n/bin${MARK}\nmore`; } });
ok(r.source === 'shell' && r.path.startsWith('/opt/homebrew/bin:/usr/bin:/n/bin'), 'PATH from the login shell, noise around it ignored');
ok(seen.sh === '/bin/zsh' && seen.args[0] === '-ilc' && seen.t === 10000, 'runs $SHELL -ilc with a 10 s timeout');
ok(r.path.split(':').filter((d) => d === '/usr/bin').length === 1 && r.path.includes('/sbin'), 'system folders added once');
r = captureLoginPath({ shell: '/bin/zsh', fallback: '/fb:/usr/bin', nodeDir: '/n/bin', run: () => { const e = new Error('spawnSync /bin/zsh ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; } });
ok(r.source === 'fallback' && r.path.startsWith('/n/bin:/fb:/usr/bin') && /no answer within 10 s/.test(r.note), 'shell timeout -> this process\'s PATH, node\'s folder first');
r = captureLoginPath({ shell: '', fallback: '/fb', nodeDir: '/n/bin', run: () => { throw new Error('not called'); } });
ok(r.source === 'fallback' && /SHELL is not set/.test(r.note), 'no SHELL -> fallback');
r = captureLoginPath({ shell: '/bin/sh', fallback: '/fb', nodeDir: '/n/bin', run: () => 'nothing useful' });
ok(r.source === 'fallback' && /printed no PATH/.test(r.note), 'shell output without the marker -> fallback');
r = captureLoginPath({ shell: '/bin/sh', fallback: '/fb', nodeDir: '/n/bin', timeoutMs: 5000 });
ok(r.source === 'shell' && r.path.includes('/n/bin'), 'a real /bin/sh -ilc answers');

// ---- launchd plist
const spec = { node: '/Users/u/.nvm/versions/node/v24.1.0/bin/node', entry: '/Users/u/.nvm/versions/node/v24.1.0/lib/node_modules/@halay/app/bin/halay.js', dataDir: '/Users/u/.halay', path: '/opt/homebrew/bin:/usr/bin:/bin', logFile: '/Users/u/.halay/logs/halay.log', env: { PORT: '4790' } };
const plist = launchdPlist(spec);
const has = (s, ...parts) => parts.every((p) => s.includes(p));
ok(has(plist, '<key>Label</key>\n\t<string>app.halay</string>'), 'plist: label app.halay');
ok(has(plist, `<array>\n\t\t<string>${spec.node}</string>\n\t\t<string>${spec.entry}</string>\n\t\t<string>start</string>\n\t</array>`), 'plist: absolute node + bin/halay.js start');
ok(has(plist, '<key>PATH</key>\n\t\t<string>/opt/homebrew/bin:/usr/bin:/bin</string>', '<key>HALAY_HOME</key>\n\t\t<string>/Users/u/.halay</string>', '<key>PORT</key>\n\t\t<string>4790</string>'), 'plist: PATH, HALAY_HOME and extra env');
ok(has(plist, '<key>KeepAlive</key>\n\t<dict>\n\t\t<key>SuccessfulExit</key>\n\t\t<false/>', '<key>RunAtLoad</key>\n\t<true/>', '<key>AbandonProcessGroup</key>\n\t<true/>'), 'plist: restart on non-zero exit only, at load, agents survive (AbandonProcessGroup)');
ok(has(plist, '<key>StandardOutPath</key>\n\t<string>/Users/u/.halay/logs/halay.log</string>', '<key>StandardErrorPath</key>', '<key>WorkingDirectory</key>\n\t<string>/Users/u/.halay</string>'), 'plist: log in the data folder, working dir = data folder');
ok(!/TOKEN/.test(plist), 'plist: no token in it');
const odd = launchdPlist({ ...spec, dataDir: '/Users/u/A & <B>', path: '/x"y' });
ok(has(odd, '/Users/u/A &amp; &lt;B&gt;', '/x&quot;y') && !odd.includes('A & <B>'), 'plist: XML special characters escaped');
if (process.platform === 'darwin') {
  const f = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'svc-')), 'p.plist');
  for (const [n, t] of [['normal', plist], ['escaped', odd]]) {
    fs.writeFileSync(f, t);
    let lint = ''; try { lint = execFileSync('plutil', ['-lint', f], { encoding: 'utf8' }); } catch (e) { lint = e.stdout || e.message; }
    ok(/OK$/.test(lint.trim()), `plist (${n}) passes plutil -lint`);
  }
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
}

// ---- systemd unit
const unit = systemdUnit({ ...spec, node: '/usr/bin/node', entry: '/usr/lib/node_modules/@halay/app/bin/halay.js', dataDir: '/home/u/.halay', logFile: '/home/u/.halay/logs/halay.log' });
ok(has(unit, 'ExecStart="/usr/bin/node" "/usr/lib/node_modules/@halay/app/bin/halay.js" "start"'), 'unit: ExecStart with absolute node + entry');
ok(has(unit, 'Environment="PATH=/opt/homebrew/bin:/usr/bin:/bin"', 'Environment="HALAY_HOME=/home/u/.halay"', 'Environment="PORT=4790"'), 'unit: PATH, HALAY_HOME, extra env');
ok(has(unit, 'Restart=on-failure', 'KillMode=process', 'WantedBy=default.target', 'StandardOutput=append:/home/u/.halay/logs/halay.log', 'WorkingDirectory="/home/u/.halay"'), 'unit: restart on failure only, agents survive (KillMode=process), log file, enabled for the user session');
const uodd = systemdUnit({ ...spec, node: '/o$d/no"de', path: '/50%/x\\y' });
ok(has(uodd, 'ExecStart="/o$$d/no\\"de"', 'Environment="PATH=/50%%/x\\\\y"'), 'unit: %, $, " and \\ escaped');

// ---- commands and paths
ok(unitPath('darwin', '/Users/u') === '/Users/u/Library/LaunchAgents/app.halay.plist' && unitPath('linux', '/home/u') === '/home/u/.config/systemd/user/halay.service' && unitPath('win32', '/x') === null, 'unit file paths per platform');
const mi = commands('install', { platform: 'darwin', uid: 501, file: '/p' });
ok(JSON.stringify(mi.map((c) => [c[0], ...c[1]])) === JSON.stringify([['launchctl', 'bootout', 'gui/501/app.halay'], ['launchctl', 'enable', 'gui/501/app.halay'], ['launchctl', 'bootstrap', 'gui/501', '/p']]) && mi[0][2].ignoreFail, 'macOS install: bootout (if loaded), enable, bootstrap');
ok(commands('stop', { platform: 'darwin', uid: 501 })[0][1].join(' ') === 'kill SIGTERM gui/501/app.halay', 'macOS stop: SIGTERM (exit 0, KeepAlive leaves it stopped)');
ok(commands('install', { platform: 'linux' }).map((c) => c[1].join(' ')).join('|') === '--user daemon-reload|--user enable halay.service|--user restart halay.service', 'Linux install: daemon-reload, enable, restart');

// ---- CLI parsing for service
let a = parseArgs(['service', 'install', '--dry-run', '--port', '4790']);
ok(a.cmd === 'service' && a.sub === 'install' && a.opts['dry-run'] && a.opts.port === '4790', 'parse: service install --dry-run --port');
a = parseArgs(['service', 'logs', '-f', '-n', '20']);
ok(a.sub === 'logs' && a.opts.follow && a.opts.lines === '20', 'parse: service logs -f -n 20');
ok(/needs one of: install/.test(parseArgs(['service']).error) && /unknown "halay service nope"/.test(parseArgs(['service', 'nope']).error), 'parse: service without / with a bad subcommand');

// ---- dry-run writes nothing
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'svc-dry-'));
try {
  for (const platform of ['darwin', 'linux']) {
    const out = [], home = path.join(tmp, platform);
    const ctx = { dataDir: path.join(home, '.halay'), reason: 'home', pidFile: path.join(home, '.halay/runs/server.pid') };
    const code = await serviceCmd('install', { 'dry-run': true, host: [] }, ctx, { platform, home, log: (m) => out.push(m), err: (m) => out.push(m), capture: () => ({ path: '/usr/bin:/bin', source: 'fallback', note: 'test' }) });
    const text = out.join('\n');
    ok(code === 0 && text.includes('would write ' + unitPath(platform, home)) && /would run: (launchctl bootstrap|systemctl --user restart)/.test(text), `${platform}: install --dry-run prints the file and the commands`);
    ok(!fs.existsSync(home), `${platform}: install --dry-run created nothing (no unit file, no data folder)`);
    out.length = 0;
    ok(await serviceCmd('uninstall', { 'dry-run': true, host: [] }, ctx, { platform, home, log: (m) => out.push(m), err: (m) => out.push(m) }) === 0 && out.join('\n').includes('would delete') && !fs.existsSync(home), `${platform}: uninstall --dry-run prints and removes nothing`);
  }
  const out = [];
  ok(await serviceCmd('install', { host: [] }, { dataDir: tmp }, { platform: 'win32', home: tmp, log: (m) => out.push(m), err: (m) => out.push(m) }) === 1 && /supports macOS/.test(out[0]), 'other platforms: a clear error');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

done();
