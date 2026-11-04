// Local HTTPS (cert.js, `halay cert`, the server's HTTPS listener). Everything happens in temp folders; nothing is
// ever added to this machine's keychain or trust store (trust steps only as --dry-run, or the Linux path that prints).
//   1. names, constraints, permits (pure)
//   2. `halay cert install` in a temp data folder: files, modes, SANs and name constraints (openssl x509 -text); the
//      constraints are enforced (a leaf for another name fails to verify); with both OpenSSL and LibreSSL if present
//   3. checkTls with a fake clock: renews when near expiry or when the names change (within the CA), warns for names
//      outside it, never touches a user's certificate
//   4. dry-runs and status
//   5. a spare server: HTTPS with the generated CA (passed as `ca` to the client), /halay-ca.crt, Secure cookie, wss,
//      plain http on loopback, auto-renew at start, `halay cert renew` hot-swaps without a restart, the 12 h timer
//      (shortened) renews and swaps too, a user-provided certificate is only warned about
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import * as C from '../src/cli/cert.js';
import { ROOT, checker, freePort, sleep, waitFor, spareHome } from './lib/spare.mjs';
const { ok, done } = checker();

const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cert-e2e-'));
const mode = (f) => fs.statSync(f).mode & 0o777;
const text = (f) => execFileSync('openssl', ['x509', '-in', f, '-noout', '-text'], { encoding: 'utf8' });
const NAMES = { names: ['localhost', '127.0.0.1', '::1', 'box.local', 'box.tail9.ts.net', '192.168.5.20', '100.101.102.103'], networks: ['192.168.0.0/16'] };
const procs = [];
try {
  // ---- 1. pure
  ok(C.hostLocalName('Halay-Mac-Mini') === 'halay-mac-mini.local' && C.hostLocalName('box.local') === 'box.local' && C.hostLocalName('srv.example.com') === 'srv.local', 'hostLocalName: lowercased <host>.local');
  const m = C.machineNames({ hostname: 'Box', tsName: 'box.tail9.ts.net', extra: ['My.Example.'], ifaces: {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0' }],
    en0: [{ address: '192.168.5.20', family: 'IPv4', internal: false, netmask: '255.255.255.0' }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    utun4: [{ address: '100.101.102.103', family: 'IPv4', internal: false, netmask: '255.255.255.255' }],
    bridge100: [{ address: '192.168.139.3', family: 'IPv4', internal: false, netmask: '255.255.254.0' }],
    en1: [{ address: '10.1.2.3', family: 'IPv4', internal: false, netmask: '255.0.0.0' }],
  } });
  ok(JSON.stringify(m.names) === JSON.stringify(['localhost', '127.0.0.1', '::1', 'box.local', 'box.tail9.ts.net', '192.168.5.20', '100.101.102.103', '10.1.2.3', 'my.example']), 'machineNames: loopback, <host>.local, Tailscale name and IP, LAN IPv4s, --host; no VM bridges, no link-local');
  ok(JSON.stringify(m.networks) === JSON.stringify(['192.168.5.0/24', '10.1.0.0/16']), 'machineNames: LAN networks, never wider than /16');
  const c = C.constraintsFor(m);
  ok(JSON.stringify(c.dns) === JSON.stringify(['localhost', 'box.local', 'box.tail9.ts.net', 'my.example']) && c.ip.includes('100.101.102.103/32') && c.ip.includes('192.168.5.0/24') && !c.ip.includes('192.168.5.20/32'), 'constraintsFor: the DNS names; loopback, LAN networks, the Tailscale IP exactly');
  ok(C.permits(c, '192.168.5.77') && !C.permits(c, '192.168.6.1') && C.permits(c, '::1') && !C.permits(c, '::2') && C.permits(c, 'x.box.local') && !C.permits(c, 'evilbox.local') && !C.permits(c, 'example.com'), 'permits: networks, exact IPv6, DNS subtrees only');

  // ---- 2. install in a temp data folder (platform linux: trust is only printed, never run)
  const bins = ['openssl', ...(fs.existsSync('/usr/bin/openssl') && !/^OpenSSL 3/.test(spawnSync('/usr/bin/openssl', ['version'], { encoding: 'utf8' }).stdout) ? ['/usr/bin/openssl'] : [])];
  for (const bin of bins) {
    const dir = fs.mkdtempSync(path.join(scratch, 'inst-')), out = [];
    const ctx = { dataDir: dir, env: {}, port: 1, host: '127.0.0.1' };
    const code = await C.certCmd('install', { host: ['my.example'] }, ctx, { platform: 'linux', names: NAMES, bin, log: (s) => out.push(s), err: (s) => out.push('ERR ' + s), reload: async () => 'not-running' });
    const p = C.certPaths(dir), label = `[${spawnSync(bin, ['version'], { encoding: 'utf8' }).stdout.trim().split(' ').slice(0, 2).join(' ')}]`;
    ok(code === 0 && out.some((l) => /sudo cp .*update-ca-certificates/.test(l)) && out.some((l) => /Firefox uses its own store/.test(l)), `${label} install: exit 0, prints the sudo commands (doesn't run them) and the Firefox note`);
    ok(mode(p.dir) === 0o700 && mode(p.caKey) === 0o600 && mode(p.leafKey) === 0o600 && mode(p.state) === 0o600, `${label} install: certs/ 700, keys and state 600`);
    const ca = text(p.caCrt), leaf = text(p.leafCrt);
    ok(/Name Constraints: critical/.test(ca) && /Permitted:\s+DNS:localhost\s+DNS:box\.local\s+DNS:box\.tail9\.ts\.net\s+DNS:my\.example\s+IP:127\.0\.0\.1\/255\.255\.255\.255\s+IP:0:0:0:0:0:0:0:1\/FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF\s+IP:192\.168\.0\.0\/255\.255\.0\.0\s+IP:100\.101\.102\.103\/255\.255\.255\.255/.test(ca), `${label} CA: critical name constraints with exactly the machine's names and networks`);
    ok(/CA:TRUE, pathlen:0/.test(ca) && /Certificate Sign, CRL Sign/.test(ca) && /ASN1 OID: prime256v1|NIST CURVE: P-256/.test(ca), `${label} CA: CA:TRUE pathlen 0, keyCertSign, P-256`);
    ok(/DNS:localhost, IP Address:127\.0\.0\.1, IP Address:0:0:0:0:0:0:0:1, DNS:box\.local, DNS:box\.tail9\.ts\.net, IP Address:192\.168\.5\.20, IP Address:100\.101\.102\.103, DNS:my\.example/.test(leaf), `${label} leaf: SANs = the names (incl. --host)`);
    ok(/TLS Web Server Authentication/.test(leaf) && /CA:FALSE/.test(leaf), `${label} leaf: serverAuth, CA:FALSE`);
    const x = new crypto.X509Certificate(fs.readFileSync(p.leafCrt)), life = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / 864e5;
    ok(life <= 397 && life >= 396, `${label} leaf: ${life} days (at most 397)`);
    ok(execFileSync('openssl', ['verify', '-CAfile', p.caCrt, p.leafCrt], { encoding: 'utf8' }).includes('OK'), `${label} leaf verifies against the CA`);
    // the constraints hold: a certificate this CA signs for another name is refused
    const evil = { ...p, leafKey: path.join(dir, 'evil.key'), leafCrt: path.join(dir, 'evil.crt') };
    C.issueLeaf({ paths: evil, names: ['www.example.com'], bin });
    const v = spawnSync('openssl', ['verify', '-CAfile', p.caCrt, evil.leafCrt], { encoding: 'utf8' });
    ok(v.status !== 0 && /permitted subtree violation|name constraint/i.test(v.stdout + v.stderr), `${label} a certificate the CA signs for www.example.com fails verification (name constraints)`);
    const st = C.readState(p);
    ok(st.extraHosts.includes('my.example') && st.leaf.names.length === 8 && st.lastRenewal, `${label} certs.json: extra hosts, leaf names, last renewal`);
  }

  // ---- 3. checkTls with a fake clock
  const d3 = fs.mkdtempSync(path.join(scratch, 'check-'));
  await C.certCmd('install', { host: [] }, { dataDir: d3, env: {}, port: 1, host: '127.0.0.1' }, { platform: 'linux', names: NAMES, log: () => {}, err: () => {}, reload: async () => 'not-running' });
  const p3 = C.certPaths(d3), tls3 = { source: 'halay', certFile: p3.leafCrt, keyFile: p3.leafKey };
  const serial = () => new crypto.X509Certificate(fs.readFileSync(p3.leafCrt)).serialNumber;
  let s0 = serial(), logs = [];
  let r = C.checkTls({ dataDir: d3, tls: tls3, names: NAMES.names, log: (l) => logs.push(l) });
  ok(!r.renewed && !r.warnings.length && serial() === s0, 'check: fresh certificate, same names -> nothing to do');
  r = C.checkTls({ dataDir: d3, tls: tls3, names: NAMES.names, now: Date.now() + 380 * 864e5, log: (l) => logs.push(l) });
  ok(r.renewed && serial() !== s0 && /expires in 1[67] days/.test(r.reasons.join()) && /renewed the certificate/.test(logs.join()), 'check: 380 days later (fake clock) -> re-issued, logged');
  ok(mode(p3.leafKey) === 0o600 && !fs.readdirSync(p3.dir).some((f) => f.includes('.tmp-') || f.startsWith('.work-')), 'check: new files mode 600, no temp files left (atomic rename)');
  s0 = serial();
  r = C.checkTls({ dataDir: d3, tls: tls3, names: [...NAMES.names.filter((n) => n !== '192.168.5.20'), '192.168.7.9'], log: () => {} });
  ok(r.renewed && /\+192\.168\.7\.9/.test(r.reasons.join()) && /-192\.168\.5\.20/.test(r.reasons.join()) && new crypto.X509Certificate(fs.readFileSync(p3.leafCrt)).subjectAltName.includes('192.168.7.9'), 'check: a new LAN IP inside the CA\'s network -> re-issued with it');
  s0 = serial();
  r = C.checkTls({ dataDir: d3, tls: tls3, names: [...NAMES.names.filter((n) => n !== '192.168.5.20'), '192.168.7.9', '10.9.9.9', 'renamed.local'] });
  ok(!r.renewed && serial() === s0 && r.warnings.some((w) => /10\.9\.9\.9, renamed\.local are not covered by the local CA; run `halay cert install` again/.test(w)), 'check: names outside the CA -> a warning to re-run install, no re-issue');
  r = C.checkTls({ dataDir: d3, tls: tls3, names: NAMES.names, now: Date.now() + (C.CA_DAYS - 30) * 864e5, log: () => {} });
  ok(r.warnings.some((w) => /the local CA expires in \d+ days/.test(w)), 'check: CA within 60 days of expiry -> warning to re-run install');
  const st3 = C.readState(p3);
  ok(st3.lastCheck && st3.nextCheck && Date.parse(st3.nextCheck) - Date.parse(st3.lastCheck) === C.CHECK_MS && st3.lastRenewal, 'certs.json: last check, next check (12 h later), last renewal');
  // a user's certificate: only warned about, never written
  const userDir = fs.mkdtempSync(path.join(scratch, 'user-')), up = { ...p3, leafKey: path.join(userDir, 'mine.key'), leafCrt: path.join(userDir, 'mine.crt') };
  C.issueLeaf({ paths: up, names: ['localhost', '127.0.0.1'], days: 5 });
  const before = fs.readFileSync(up.leafCrt), beforeM = fs.statSync(up.leafCrt).mtimeMs;
  r = C.checkTls({ dataDir: userDir, tls: { source: 'user', certFile: up.leafCrt, keyFile: up.leafKey }, names: ['localhost', 'something-else'] });
  ok(!r.renewed && r.warnings.some((w) => /expires in \d days.*never renews certificates it didn't make/.test(w)) && fs.readFileSync(up.leafCrt).equals(before) && fs.statSync(up.leafCrt).mtimeMs === beforeM, 'check: user-provided certificate near expiry -> warning only, file untouched');
  ok(JSON.stringify(C.tlsConfig({ dataDir: userDir, env: { HALAY_TLS_CERT: up.leafCrt } })).includes('set both'), 'tlsConfig: only one of HALAY_TLS_CERT/KEY -> an error, HTTPS off');

  // ---- 4. dry-runs and status
  let out = [];
  const dDry = path.join(scratch, 'dry-none');
  ok(await C.certCmd('install', { host: [], 'dry-run': true }, { dataDir: dDry, env: {}, port: 1, host: 'h' }, { platform: 'darwin', names: NAMES, log: (s) => out.push(s), err: (s) => out.push(s) }) === 0
    && out.some((l) => /^would run: security add-trusted-cert -r trustRoot -k .*login\.keychain-db .*ca\.crt$/.test(l)) && !fs.existsSync(dDry), 'install --dry-run (macOS): prints the security add-trusted-cert command, writes nothing');
  out = [];
  ok(await C.certCmd('uninstall', { host: [], 'dry-run': true }, { dataDir: d3, env: {}, port: 1, host: 'h' }, { platform: 'darwin', log: (s) => out.push(s), err: (s) => out.push(s) }) === 0
    && out.some((l) => /would run: security remove-trusted-cert/.test(l)) && out.some((l) => /would run: security delete-certificate -Z [0-9A-F]{40} /.test(l)) && fs.existsSync(p3.caCrt), 'uninstall --dry-run (macOS): prints remove-trusted-cert + delete-certificate, deletes nothing');
  out = [];
  ok(await C.certCmd('uninstall', { host: [], 'dry-run': true }, { dataDir: d3, env: {}, port: 1, host: 'h' }, { platform: 'linux', log: (s) => out.push(s), err: (s) => out.push(s) }) === 0 && out.join('\n').includes('sudo rm -f /usr/local/share/ca-certificates/halay-local-ca.crt') && fs.existsSync(p3.caCrt), 'uninstall --dry-run (Linux): prints the sudo commands, deletes nothing');
  out = [];
  ok(await C.certCmd('status', { host: [] }, { dataDir: d3, env: {}, port: 1, host: 'h' }, { platform: 'linux', log: (s) => out.push(s), err: (s) => out.push(s) }) === 0
    && /valid until/.test(out.join()) && /SHA-256 [0-9A-F:]{95}/.test(out.join()) && /names: localhost/.test(out.join()) && /trusted by the system: no/.test(out.join()) && /last renewal: 20/.test(out.join()) && /next check: 20/.test(out.join()), 'status: paths, fingerprint, SANs, expiry, trusted or not, last renewal, next check');
  out = [];
  ok(await C.certCmd('uninstall', { host: [] }, { dataDir: d3, env: {}, port: 1, host: 'h' }, { platform: 'linux', log: (s) => out.push(s), err: (s) => out.push(s) }) === 0 && !fs.existsSync(p3.dir), 'uninstall (Linux, nothing to run): deletes the certs folder');
  ok(/`openssl-does-not-exist` was not found/.test((() => { try { C.issueLeaf({ paths: C.certPaths(scratch), names: ['localhost'], bin: 'openssl-does-not-exist' }); } catch (e) { return e.message; } })()), 'openssl missing -> a clear message');

  // ---- 5. a spare server
  const home = fs.mkdtempSync(path.join(scratch, 'srv-'));
  const ctx = { dataDir: home, env: {}, port: 1, host: '127.0.0.1' };
  const SRV_NAMES = { names: ['localhost', '127.0.0.1', '::1'], networks: [] };
  await C.certCmd('install', { host: [] }, ctx, { platform: 'linux', names: SRV_NAMES, log: () => {}, err: () => {}, reload: async () => 'not-running' });
  const P = C.certPaths(home);
  C.issueLeaf({ paths: P, names: SRV_NAMES.names, days: 3 }); // short-lived: the server must renew it at start
  const caPem = fs.readFileSync(P.caCrt);
  const port = await freePort(), hport = await freePort(), TOKEN = 'cert-e2e-' + crypto.randomBytes(6).toString('hex');
  let log = '';
  const start = (extra = {}) => { log = ''; const pr = spawn(process.execPath, [path.join(ROOT, 'bin/halay.js'), 'start'], { env: { ...process.env, ...spareHome(scratch), HALAY_HOME: home, PORT: String(port), HOST: '127.0.0.1', HALAY_HTTPS_PORT: String(hport), HALAY_TOKEN: TOKEN, HALAY_TERMINAL: '0', HALAY_TLS_CHECK_SECONDS: '2', ...extra, PATH: path.join(ROOT, 'test/fake-claude') + path.delimiter + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }); pr.stdout.on('data', (d) => (log += d)); pr.stderr.on('data', (d) => (log += d)); procs.push(pr); return pr; };
  const stop = async (pr) => { pr.kill('SIGTERM'); for (let i = 0; i < 50 && pr.exitCode === null; i++) await sleep(100); if (pr.exitCode === null) pr.kill('SIGKILL'); };
  const agent = new https.Agent({ ca: caPem, keepAlive: true, maxSockets: 1 });
  const get = (p, { headers = {}, method = 'GET', body, ag = agent } = {}) => new Promise((res, rej) => {
    const rq = https.request({ host: '127.0.0.1', servername: 'localhost', port: hport, path: p, method, headers: { host: `localhost:${hport}`, ...headers }, agent: ag, ca: caPem }, (r) => { const sock = r.socket, cert = sock.getPeerCertificate(); let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b, cert, socket: sock })); });
    rq.on('error', rej); rq.end(body);
  });
  let srv = start();
  ok(await waitFor(() => /https: https:\/\/localhost:\d+\//.test(log), 15000), 'server: logs the https URL');
  ok(/https: renewed the certificate \(it expires in [0-3] days\)/.test(log), 'server: a leaf expiring within 30 days is renewed at start');
  let res = await get('/halay-ca.crt');
  ok(res.status === 200 && res.headers['content-type'] === 'application/x-x509-ca-cert' && res.body === caPem.toString() && !res.body.includes('PRIVATE'), 'GET /halay-ca.crt without login: only the public CA certificate, x509-ca-cert type');
  ok(Date.parse(res.cert.valid_to) - Date.now() > 300 * 864e5, 'HTTPS serves the renewed certificate (valid for about a year), trusted with the CA as `ca`');
  const firstSocket = res.socket, serial1 = res.cert.serialNumber;
  res = await get('/api/server', { headers: { authorization: 'Bearer ' + TOKEN } });
  const info = JSON.parse(res.body);
  ok(res.status === 200 && info.https?.port === hport && info.https.source === 'halay' && info.https.urls[0] === `https://localhost:${hport}/` && info.https.expires, '/api/server over HTTPS: https port, source, URL, expiry');
  res = await get('/auth/token', { method: 'POST', headers: { 'content-type': 'application/json', origin: `https://localhost:${hport}` }, body: JSON.stringify({ token: TOKEN }) });
  const cookie = [].concat(res.headers['set-cookie'] || []).find((c) => /^halay_session=[\w-]+;/.test(c)) || '';
  ok(res.status === 200 && /; Secure/.test(cookie) && /HttpOnly/.test(cookie), 'token sign-in over HTTPS sets a Secure, HttpOnly session cookie');
  const http1 = await fetch(`http://127.0.0.1:${port}/api/server`, { headers: { authorization: 'Bearer ' + TOKEN } });
  ok(http1.status === 200, 'plain http on 127.0.0.1 keeps working (agents, MCP, restart helper)');
  const wsOk = await new Promise((r) => { const ws = new WebSocket(`wss://localhost:${hport}/ws?token=${TOKEN}`, { ca: caPem }); ws.on('open', () => { ws.close(); r(true); }); ws.on('error', () => r(false)); setTimeout(() => r(false), 5000); });
  ok(wsOk, 'websocket over wss:// works');
  const wsBad = await new Promise((r) => { const ws = new WebSocket(`wss://localhost:${hport}/ws`, { ca: caPem }); ws.on('open', () => r('open')); ws.on('unexpected-response', (_, rs) => r(rs.statusCode)); ws.on('error', () => r('error')); setTimeout(() => r('timeout'), 5000); });
  ok(wsBad === 401, 'wss:// without a login -> 401');
  const untrusted = await new Promise((r) => { https.get({ host: '127.0.0.1', servername: 'localhost', port: hport, path: '/halay-ca.crt' }, () => r('trusted')).on('error', (e) => r(e.code)); });
  ok(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/.test(untrusted), `a client without the CA refuses the certificate (${untrusted})`);
  // `halay cert renew`: re-issue + reload in the running server, no restart; the open connection keeps working
  const pid1 = srv.pid;
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin/halay.js'), 'cert', 'renew'], { encoding: 'utf8', env: { ...process.env, HALAY_HOME: home, PORT: String(port), HOST: '127.0.0.1', HALAY_TOKEN: TOKEN } });
  ok(cli.status === 0 && /serves the new certificate now \(no restart\)/.test(cli.stdout), 'halay cert renew: re-issued and the running server reloaded it' + (cli.status ? `: ${cli.stdout}${cli.stderr}` : ''));
  const fresh = new https.Agent({ ca: caPem, keepAlive: false });
  res = await get('/halay-ca.crt', { ag: fresh });
  ok(res.cert.serialNumber !== serial1 && srv.pid === pid1 && srv.exitCode === null, 'a new connection gets the new certificate; same server process');
  res = await get('/halay-ca.crt');
  ok(res.status === 200 && res.socket === firstSocket, 'the connection opened before the swap keeps working');
  // the timer (HALAY_TLS_CHECK_SECONDS=2 here, 12 h normally): a leaf made short-lived behind its back is renewed and swapped
  C.issueLeaf({ paths: P, names: SRV_NAMES.names, days: 2 });
  const shortSerial = new crypto.X509Certificate(fs.readFileSync(P.leafCrt)).serialNumber;
  const renewedByTimer = await waitFor(async () => { const r2 = await get('/halay-ca.crt', { ag: new https.Agent({ ca: caPem, keepAlive: false }) }); return r2.cert.serialNumber !== shortSerial && Date.parse(r2.cert.valid_to) - Date.now() > 300 * 864e5 ? r2 : null; }, 15000, 500);
  ok(!!renewedByTimer && srv.pid === pid1 && srv.exitCode === null, 'the periodic check renews a near-expiry leaf and the listener serves it without a restart');
  await stop(srv);

  // a user-provided certificate: served, warned about near expiry, never rewritten
  const own = { ...P, leafKey: path.join(scratch, 'own.key'), leafCrt: path.join(scratch, 'own.crt') };
  C.issueLeaf({ paths: own, names: ['localhost', '127.0.0.1'], days: 10 });
  const ownBytes = fs.readFileSync(own.leafCrt);
  srv = start({ HALAY_TLS_CERT: own.leafCrt, HALAY_TLS_KEY: own.leafKey });
  ok(await waitFor(() => /https: https:\/\/localhost/.test(log), 15000) && /your HTTPS certificate .* expires in \d+ days/.test(log), 'user certificate: served, with an expiry warning in the log');
  res = await get('/api/server', { headers: { authorization: 'Bearer ' + TOKEN }, ag: new https.Agent({ ca: caPem, keepAlive: false }) });
  const j = JSON.parse(res.body);
  ok(j.https.source === 'user' && j.https.warnings.some((w) => /expires in/.test(w)), 'user certificate: the warning is in /api/server (Settings)');
  res = await get('/halay-ca.crt', { ag: new https.Agent({ ca: caPem, keepAlive: false }) });
  ok(res.status === 404, '/halay-ca.crt is 404 when the certificate is not halay\'s own');
  await sleep(2500); // a timer check runs
  ok(fs.readFileSync(own.leafCrt).equals(ownBytes), 'user certificate: never rewritten (also after a timer check)');
  await stop(srv);
} catch (e) {
  ok(false, 'unexpected error: ' + (e.stack || e));
} finally {
  for (const pr of procs) if (pr.exitCode === null) pr.kill('SIGKILL');
  fs.rmSync(scratch, { recursive: true, force: true });
}
done();
