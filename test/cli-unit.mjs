// Unit checks (no server): the `halay` command's argument parsing and sign-in URL (cli.js).
import path from 'node:path';
import { parseArgs, signInUrls, serverPid, withRunning } from '../src/cli/cli.js';
import { checker } from './lib/spare.mjs';
const { ok, done } = checker();

const p = (...a) => parseArgs(a);
ok(p().cmd === 'start' && !p().error, 'no arguments -> start');
ok(p('start').cmd === 'start', 'start');
let r = p('--port', '4796');
ok(r.cmd === 'start' && r.opts.port === '4796', '--port N (start implied)');
r = p('start', '--port=4796', '--host', '0.0.0.0');
ok(r.opts.port === '4796' && r.opts.host[0] === '0.0.0.0', '--port=N and --host ADDR');
ok(p('--version').cmd === 'version' && p('-v').cmd === 'version', '--version / -v');
ok(p('--help').cmd === 'help' && p('-h').cmd === 'help' && p('help').cmd === 'help' && p('token', '--help').cmd === 'help', '--help / -h / help, also after a command');
ok(p('token').cmd === 'token' && p('restart').cmd === 'restart' && p('stop').cmd === 'stop', 'token, restart, stop');
ok(/unknown command "bogus"/.test(p('bogus').error), 'unknown command is an error');
ok(/unknown option --nope/.test(p('--nope').error), 'unknown option is an error');
ok(/--port needs a value/.test(p('--port').error), '--port without a value is an error');
ok(/--port must be a port number/.test(p('--port', 'abc').error) && /port number/.test(p('--port', '70000').error) && /port number/.test(p('--port', '0').error), 'a bad port is an error');
ok(/unexpected argument x/.test(p('token', 'x').error), 'an extra word is an error');
ok(/more than once/.test(p('start', '--host', 'a', '--host', 'b').error), '--host twice is an error for start');
ok(/takes no value/.test(p('--help=1').error), 'a flag given a value is an error');
r = p('cert', 'install', '--host', 'a.example', '--host=10.0.0.5', '--dry-run');
ok(r.cmd === 'cert' && r.sub === 'install' && r.opts.host.join() === 'a.example,10.0.0.5' && r.opts['dry-run'], 'cert install: --host may repeat, --dry-run');
ok(p('cert', 'renew').sub === 'renew' && p('cert', 'status').sub === 'status' && p('cert', 'uninstall').sub === 'uninstall', 'cert renew / status / uninstall');
ok(/needs one of: install, status, renew, uninstall/.test(p('cert').error), 'cert without a subcommand is an error');

// sign-in URL
const ctx = (env, host = '127.0.0.1', port = 4777) => ({ env, dataDir: '/d', host, port });
const file = (t) => (f) => { if (f === path.join('/d', '.token')) return t + '\n'; throw new Error('ENOENT'); };
ok(signInUrls(ctx({}), file('abc')).urls[0] === 'http://localhost:4777/?token=abc', 'token URL (localhost: passkeys refuse an IP address)'+' from <data dir>/.token');
ok(signInUrls(ctx({ HALAY_TOKEN: 'envtok' }), file('abc')).urls[0] === 'http://localhost:4777/?token=envtok', 'HALAY_TOKEN wins over .token');
ok(signInUrls(ctx({}, '0.0.0.0', 4796), file('abc')).urls[0] === 'http://localhost:4796/?token=abc', 'HOST 0.0.0.0 -> localhost');
ok(signInUrls(ctx({}, '::1'), file('abc')).urls[0] === 'http://localhost:4777/?token=abc', 'HOST ::1 -> localhost');
ok(signInUrls(ctx({}, 'fe80::1'), file('abc')).urls[0] === 'http://[fe80::1]:4777/?token=abc', 'another IPv6 HOST is bracketed');
r = signInUrls(ctx({ HALAY_PUBLIC_URL: 'https://m.t.ts.net/' }), file('abc'));
ok(r.urls.length === 2 && r.urls[1] === 'https://m.t.ts.net/?token=abc', 'the HTTPS public URL is printed too');
ok(/no access token yet in \/d/.test(signInUrls(ctx({}), () => { throw new Error('ENOENT'); }).error), 'no token yet -> a clear error');

// serverPid: only a live halay process
ok(serverPid('/x', { readFile: () => String(process.pid), ps: () => 'node /a/server.js' }) === process.pid, 'pid file naming a live server.js -> its pid');
ok(serverPid('/x', { readFile: () => String(process.pid), ps: () => '/usr/bin/vim' }) === null, 'a pid reused by another program -> null (never signalled)');
ok(serverPid('/x', { readFile: () => '99999999', ps: () => 'node server.js' }) === null, 'a dead pid -> null');
ok(serverPid('/x', { readFile: () => { throw new Error('ENOENT'); } }) === null, 'no pid file -> null');

// withRunning: the running server's port wins (it may have been started with --port)
const base = { dataDir: '/d', pidFile: '/d/runs/server.pid', port: 4777, host: '127.0.0.1' };
const sj = (j) => () => JSON.stringify(j);
ok(withRunning(base, { readFile: sj({ pid: 42, port: 4796, host: '0.0.0.0' }), alive: () => 42 }).port === 4796, 'server.json of the live server -> its port');
ok(withRunning(base, { readFile: sj({ pid: 42, port: 4796 }), alive: () => 43 }).port === 4777, 'server.json of an older server -> the settings');
ok(withRunning(base, { readFile: () => { throw new Error('ENOENT'); }, alive: () => 42 }).port === 4777, 'no server.json -> the settings');

done();
