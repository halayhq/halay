// `halay service install|uninstall|status|logs|start|stop`: run the server in the background at login, as a launchd
// user agent on macOS (~/Library/LaunchAgents/app.halay.plist) or a systemd user unit on Linux
// (~/.config/systemd/user/halay.service).
//
// A service doesn't get your shell's PATH (launchd and systemd start with a minimal one), so the agent CLIs (claude,
// opencode, cursor-agent, agy, gemini), git and node wouldn't be found. install asks your login shell for its PATH
// (`$SHELL -ilc`, with a timeout; else this process's PATH) and writes it into the unit, with HALAY_HOME and the
// absolute paths of node and bin/halay.js. Installing a CLI later means running `halay service install` again.
//
// Restarts: the server detects launchd/systemd as its parent (server.js RESTART_MODE) and, for Settings → Restart
// server, exits with code 75 so the service manager starts it again; restart-helper.js only steps in if nothing
// serves the port 20 s later. So both units restart on a non-zero exit only (launchd KeepAlive SuccessfulExit=false,
// systemd Restart=on-failure): `halay stop` (SIGTERM, exit 0) stays stopped, a crash or a restart comes back. Agents
// and terminals run detached and must outlive the server: launchd's AbandonProcessGroup, systemd's KillMode=process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { ROOT, serverPid } from './cli.js';
import { ensureDataDir } from './home.js';
import { temporaryReason, INSTALL_FOR_GOOD } from './install-kind.js';

export const LABEL = 'app.halay';
export const UNIT = 'halay.service';
const MARK = '__HALAY_PATH__';

export const unitPath = (platform = process.platform, home = os.homedir()) =>
  platform === 'darwin' ? path.join(home, 'Library', 'LaunchAgents', LABEL + '.plist')
    : platform === 'linux' ? path.join(home, '.config', 'systemd', 'user', UNIT) : null;

// PATH of the user's login shell -> { path, source: 'shell' | 'fallback', note }. `node`'s own folder is always in
// it (first, if the shell's PATH doesn't have it) and so are the system folders.
export function captureLoginPath({ shell = process.env.SHELL, fallback = process.env.PATH || '', nodeDir = path.dirname(process.execPath), timeoutMs = 10000, run = runShell } = {}) {
  let p = '', note = '';
  if (!shell) note = 'SHELL is not set';
  else {
    try {
      const out = run(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], timeoutMs);
      const m = String(out).match(new RegExp(`${MARK}(.*?)${MARK}`, 's'));
      if (m && m[1].includes('/')) p = m[1].trim(); else note = `${shell} printed no PATH`;
    } catch (e) { note = `${shell} failed: ${e.code === 'ETIMEDOUT' || e.signal ? `no answer within ${timeoutMs / 1000} s` : e.message.split('\n')[0]}`; }
  }
  const source = p ? 'shell' : 'fallback';
  const parts = (p || fallback).split(':').filter(Boolean);
  if (!parts.includes(nodeDir)) parts.unshift(nodeDir);
  for (const d of ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) if (!parts.includes(d)) parts.push(d);
  return { path: [...new Set(parts)].join(':'), source, note };
}
const runShell = (shell, args, timeout) => execFileSync(shell, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], killSignal: 'SIGKILL' });

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// spec: { node, entry, dataDir, path, logFile, env: { NAME: value } (extra, e.g. PORT) }
export function launchdPlist(spec) {
  const env = { PATH: spec.path, HALAY_HOME: spec.dataDir, ...spec.env };
  const str = (s) => `<string>${xml(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`halay service install\`. Run it again (rather than editing this) after installing a new agent CLI,
     so the PATH below is your login shell's current one. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	${str(LABEL)}
	<key>ProgramArguments</key>
	<array>
		${str(spec.node)}
		${str(spec.entry)}
		${str('start')}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${Object.entries(env).map(([k, v]) => `		<key>${xml(k)}</key>\n		${str(v)}`).join('\n')}
	</dict>
	<key>WorkingDirectory</key>
	${str(spec.dataDir)}
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>AbandonProcessGroup</key>
	<true/>
	<key>ProcessType</key>
	<string>Standard</string>
	<key>StandardOutPath</key>
	${str(spec.logFile)}
	<key>StandardErrorPath</key>
	${str(spec.logFile)}
</dict>
</plist>
`;
}

// systemd quoting: inside "…" escape \ and ", and % (specifiers) as %%; in ExecStart also $ as $$
const sq = (s, exec) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, exec ? '$$$$' : '$')}"`;
export function systemdUnit(spec) {
  const env = { PATH: spec.path, HALAY_HOME: spec.dataDir, ...spec.env };
  return `# Written by \`halay service install\`. Run it again (rather than editing this) after installing a new agent CLI,
# so the PATH below is your login shell's current one.
[Unit]
Description=Halay: web UI for coding agents
After=network-online.target

[Service]
Type=simple
ExecStart=${[spec.node, spec.entry, 'start'].map((a) => sq(a, true)).join(' ')}
WorkingDirectory=${sq(spec.dataDir)}
${Object.entries(env).map(([k, v]) => `Environment=${sq(`${k}=${v}`)}`).join('\n')}
Restart=on-failure
RestartSec=2
KillMode=process
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.logFile}

[Install]
WantedBy=default.target
`;
}

// what install / uninstall / start / stop run, per platform: [[cmd, args, { ignoreFail }]]
export function commands(sub, { platform = process.platform, uid = process.getuid?.(), file }) {
  const dom = `gui/${uid}`, job = `${dom}/${LABEL}`;
  if (platform === 'darwin') return {
    install: [['launchctl', ['bootout', job], { ignoreFail: true }], ['launchctl', ['enable', job]], ['launchctl', ['bootstrap', dom, file]]],
    uninstall: [['launchctl', ['bootout', job], { ignoreFail: true }]],
    start: [['launchctl', ['kickstart', job]]],
    stop: [['launchctl', ['kill', 'SIGTERM', job]]],
  }[sub];
  return {
    install: [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', UNIT]], ['systemctl', ['--user', 'restart', UNIT]]],
    uninstall: [['systemctl', ['--user', 'disable', '--now', UNIT], { ignoreFail: true }]],
    start: [['systemctl', ['--user', 'start', UNIT]]],
    stop: [['systemctl', ['--user', 'stop', UNIT]]],
  }[sub];
}

// pid of the running service (launchctl print / systemctl show), else null
function servicePid(platform, uid) {
  try {
    if (platform === 'darwin') { const m = execFileSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/^\s*pid = (\d+)/m); return m ? +m[1] : null; }
    const v = execFileSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', UNIT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return +v || null;
  } catch { return null; }
}

export async function serviceCmd(sub, opts, ctx, { platform = process.platform, home = os.homedir(), log = console.log, err = console.error, capture = captureLoginPath, root = ROOT } = {}) {
  const file = unitPath(platform, home);
  if (!file) { err(`halay service supports macOS (launchd) and Linux (systemd --user); this is ${platform}. Run \`halay\` under your own supervisor instead (docs/install.md).`); return 1; }
  const uid = process.getuid?.();
  const logFile = path.join(ctx.dataDir, 'logs', 'halay.log');
  const dry = !!opts['dry-run'];
  const exec = (list) => {
    for (const [cmd, args, o = {}] of list) {
      if (dry) { log(`would run: ${cmd} ${args.join(' ')}`); continue; }
      const r = spawnSync(cmd, args, { encoding: 'utf8' });
      if (r.status !== 0 && !o.ignoreFail) { err(`${cmd} ${args.join(' ')} failed (${r.error?.message || 'exit ' + r.status}): ${(r.stderr || '').trim()}`); return false; }
    }
    return true;
  };

  if (sub === 'install') {
    const temp = temporaryReason(root);
    if (temp) { // also with --dry-run: the unit it would print is one that stops working
      err(`halay service install: not from here: ${temp} (${root}), and that folder can disappear, so the service would silently stop starting. Install halay for good first, then set up the service:\n  ${INSTALL_FOR_GOOD}\n  halay service install\nYour data (${ctx.dataDir}) carries over.`);
      return 1;
    }
    const running = serverPid(ctx.pidFile), svc = servicePid(platform, uid);
    if (running && running !== svc) {
      const m = `a halay server is already running outside the service (pid ${running}, data folder ${ctx.dataDir}). Stop it first (\`halay stop\`), then run this again; otherwise the service can't take the port.`;
      if (!dry) { err(m); return 1; }
      log('note: ' + m);
    }
    const captured = capture();
    const extra = {};
    if (opts.port) extra.PORT = opts.port;
    if (opts.host[0]) extra.HOST = opts.host[0];
    if (process.env.LANG) extra.LANG = process.env.LANG;
    const spec = { node: process.execPath, entry: path.join(root, 'bin', 'halay.js'), dataDir: ctx.dataDir, path: captured.path, logFile, env: extra };
    const text = platform === 'darwin' ? launchdPlist(spec) : systemdUnit(spec);
    log(`PATH for the service: from ${captured.source === 'shell' ? `your login shell (${process.env.SHELL})` : `this process (${captured.note})`}`);
    if (dry) { log(`would write ${file}:\n\n${text}`); exec(commands('install', { platform, uid, file })); return 0; }
    ensureDataDir({ dir: ctx.dataDir, reason: ctx.reason }); // the unit's working directory must exist
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o644 });
    log(`wrote ${file}`);
    if (!exec(commands('install', { platform, uid, file }))) return 1;
    log(`halay runs in the background now and starts at login. Log: ${logFile} (\`halay service logs\`). Sign in: \`halay token\`.`);
    log('After installing or updating an agent CLI (or switching Node versions), run `halay service install` again so the service gets the new PATH.');
    if (platform === 'linux') log('On a headless machine, run `loginctl enable-linger $USER` once so it starts at boot and keeps running after you log out.');
    return 0;
  }
  if (sub === 'uninstall') {
    if (!fs.existsSync(file) && !dry) { log(`no service installed (${file} doesn't exist).`); return 0; }
    if (!exec(commands('uninstall', { platform, uid, file }))) return 1;
    if (dry) { log(`would delete ${file}`); if (platform === 'linux') log('would run: systemctl --user daemon-reload'); return 0; }
    fs.rmSync(file, { force: true });
    if (platform === 'linux') exec([['systemctl', ['--user', 'daemon-reload'], { ignoreFail: true }]]);
    log(`removed the service (${file}). Agents keep running; your data stays in ${ctx.dataDir}.`);
    return 0;
  }
  if (sub === 'start' || sub === 'stop') {
    if (!fs.existsSync(file)) { err(`no service installed (${file}); run \`halay service install\` first.`); return 1; }
    return exec(commands(sub, { platform, uid, file })) ? 0 : 1;
  }
  if (sub === 'status') {
    if (!fs.existsSync(file)) { log(`not installed (${file} doesn't exist). Install with \`halay service install\`.`); return 3; }
    log(`installed: ${file}\nlog: ${logFile}\ndata folder: ${ctx.dataDir}`);
    if (platform === 'darwin') {
      const r = spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { encoding: 'utf8' });
      if (r.status !== 0) { log('state: not loaded (log out and in, or run `halay service install` again)'); return 3; }
      for (const k of ['state', 'pid', 'last exit code', 'runs']) { const m = r.stdout.match(new RegExp(`^\\s*${k} = (.*)$`, 'm')); if (m) log(`${k}: ${m[1]}`); }
      return /^\s*state = running/m.test(r.stdout) ? 0 : 3;
    }
    const r = spawnSync('systemctl', ['--user', 'status', UNIT, '--no-pager'], { encoding: 'utf8' });
    log(r.stdout.trim());
    return r.status;
  }
  if (sub === 'logs') {
    if (!fs.existsSync(logFile)) { log(`no log yet (${logFile}).`); return 1; }
    const args = ['-n', String(opts.lines || 100), ...(opts.follow ? ['-f'] : []), logFile];
    if (dry) { log(`would run: tail ${args.join(' ')}`); return 0; }
    return await new Promise((res) => spawn('tail', args, { stdio: 'inherit' }).on('exit', (c) => res(c ?? 0)));
  }
  return 2;
}
