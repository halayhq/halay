// Local HTTPS with a certificate authority of halay's own (`halay cert install|status|renew|uninstall`), for reaching
// the app over the LAN without Tailscale. tailscale serve (a real certificate, nothing to install) stays the
// recommended way for phones; see docs/install.md.
//
// <data folder>/certs/ (mode 700): ca.key (600) + ca.crt, the root CA, ECDSA P-256, 5 years, with X.509 name
// constraints: it can only vouch for this machine's names (localhost, <host>.local, its Tailscale name, --host names)
// and addresses (loopback, its LAN networks, its Tailscale address), so a stolen ca.key can't impersonate other
// sites to a device that trusts it. leaf.key (600) + leaf.crt: the server's certificate (397 days, SANs = the
// machine's current names that the CA allows). certs.json: the CA's constraints, the leaf's names, renewal times.
// Keys come from node:crypto, certificates from the system `openssl` (execFile, no shell; OpenSSL or LibreSSL).
//
// The server (server.js) serves HTTPS on HALAY_HTTPS_PORT when these files exist (or HALAY_TLS_CERT/HALAY_TLS_KEY
// name your own) and checks the leaf at start and every 12 h (checkTls): re-issued with the same CA when it expires
// within 30 days or the machine's names changed (within what the CA allows), then hot-swapped without a restart.
// Certificates you provide are never written; they only get an expiry warning.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

export const CA_DAYS = 1826, LEAF_DAYS = 397, RENEW_DAYS = 30, CA_WARN_DAYS = 60, CHECK_MS = 12 * 3600e3;
const DAY = 864e5;
const CA_NAME = 'Halay local CA';

export const certPaths = (dataDir) => {
  const dir = path.join(dataDir, 'certs');
  return { dir, caKey: path.join(dir, 'ca.key'), caCrt: path.join(dir, 'ca.crt'), leafKey: path.join(dir, 'leaf.key'), leafCrt: path.join(dir, 'leaf.crt'), state: path.join(dir, 'certs.json') };
};

// ---- names ----------------------------------------------------------------------------------------------------
// interfaces that are virtual machines' or containers' bridges, not the machine's own network
const VIRTUAL_IF = /^(bridge|docker|br-|veth|vmnet|vboxnet|virbr|lo|awdl|llw|anpi|ap\d|gif|stf|cni|flannel|tun|tap)/;
const isTailscaleIp = (ip) => net.isIPv4(ip) && ip4num(ip) >>> 22 === ip4num('100.64.0.0') >>> 22; // 100.64.0.0/10
const ip4num = (ip) => ip.split('.').reduce((n, o) => (n << 8 | +o) >>> 0, 0) >>> 0;
const num2ip4 = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
const prefixOf = (mask) => mask.split('.').reduce((n, o) => n + (+o).toString(2).split('').filter((b) => b === '1').length, 0);

export function hostLocalName(hostname = os.hostname()) {
  const h = hostname.toLowerCase().replace(/\.local\.?$/, '').split('.')[0].replace(/[^a-z0-9-]/g, '-');
  return h ? `${h}.local` : null;
}

// the Tailscale MagicDNS name of this machine (tailscale status --json → Self.DNSName), or null
export function tailscaleName({ run = runTailscale } = {}) {
  for (const [bin, env] of [['tailscale', {}], ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', { TAILSCALE_BE_CLI: '1' }]]) {
    try { const j = JSON.parse(run(bin, env)); const n = String(j?.Self?.DNSName || '').replace(/\.$/, '').toLowerCase(); if (n) return n; } catch {}
  }
  return null;
}
const runTailscale = (bin, env) => execFileSync(bin, ['status', '--json'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env } });

// the machine's names now -> { names: [...], networks: ['a.b.c.d/p', ...] (LAN networks, for the CA's constraints) }
export function machineNames({ extra = [], ifaces = os.networkInterfaces(), hostname = os.hostname(), tsName = tailscaleName } = {}) {
  const names = ['localhost', '127.0.0.1', '::1'], networks = [];
  const local = hostLocalName(hostname); if (local) names.push(local);
  const ts = typeof tsName === 'function' ? tsName() : tsName; if (ts) names.push(ts);
  for (const [ifname, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      if (a.internal || a.family !== 'IPv4' && a.family !== 4) continue;
      if (isTailscaleIp(a.address)) { names.push(a.address); continue; }
      if (VIRTUAL_IF.test(ifname) || a.address.startsWith('169.254.')) continue;
      names.push(a.address);
      const p = Math.max(16, prefixOf(a.netmask || '255.255.255.255')); // never wider than a /16
      networks.push(`${num2ip4((ip4num(a.address) & (p ? (~0 << (32 - p)) >>> 0 : 0)) >>> 0)}/${p}`);
    }
  }
  for (const h of extra) names.push(net.isIP(h) ? h : h.toLowerCase().replace(/\.$/, ''));
  return { names: [...new Set(names)], networks: [...new Set(networks)] };
}

// the CA's name constraints for these names: every DNS name (and its subdomains), loopback, the LAN networks and each
// other address exactly
export function constraintsFor({ names, networks }) {
  const dns = names.filter((n) => !net.isIP(n));
  const ip = ['127.0.0.1/32', '::1/128', ...networks];
  for (const n of names) if (net.isIP(n) && !permits({ dns: [], ip }, n)) ip.push(net.isIPv6(n) ? `${n}/128` : `${n}/32`);
  return { dns, ip: [...new Set(ip)] };
}

export function permits(c, name) {
  if (!net.isIP(name)) return c.dns.some((d) => name === d || name.endsWith('.' + d));
  return c.ip.some((r) => {
    const [a, p] = r.split('/');
    if (net.isIPv6(name) || net.isIPv6(a)) return net.isIPv6(name) && net.isIPv6(a) && +p === 128 && expand6(name) === expand6(a);
    const m = +p ? (~0 << (32 - +p)) >>> 0 : 0;
    return ((ip4num(name) & m) >>> 0) === ((ip4num(a) & m) >>> 0);
  });
}
const expand6 = (ip) => { const [h, t = ''] = ip.split('::'); const hs = h ? h.split(':') : [], ts = t ? t.split(':') : []; return [...hs, ...Array(8 - hs.length - ts.length).fill('0'), ...ts].map((x) => parseInt(x, 16)).join(':'); };
const maskOf = (p, v6) => v6 ? Array(8).fill(0).map((_, i) => ((0xffff << (16 - Math.max(0, Math.min(16, p - 16 * i)))) & 0xffff).toString(16).toUpperCase()).join(':') : num2ip4(+p ? (~0 << (32 - +p)) >>> 0 : 0);

// ---- openssl ---------------------------------------------------------------------------------------------------
export const opensslBin = (env = process.env) => env.HALAY_OPENSSL || 'openssl';
function openssl(bin, args, cwd) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error?.code === 'ENOENT') throw new Error(`\`${bin}\` was not found. halay uses the system openssl to make certificates: install it (macOS has one in /usr/bin; Debian/Ubuntu: sudo apt install openssl) or set HALAY_OPENSSL to its path.`);
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout;
}
const newKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;

// write a file atomically (temp file + rename), with this mode
export function writeAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data, { mode });
  try { fs.chmodSync(tmp, mode); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}
const workDir = (p) => { fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 }); return fs.mkdtempSync(path.join(p.dir, '.work-')); };

// a new root CA limited to these constraints -> writes ca.key, ca.crt
export function createCA({ paths, constraints, days = CA_DAYS, bin = opensslBin(), hostname = os.hostname() }) {
  const w = workDir(paths);
  try {
    const nc = [...constraints.dns.map((d, i) => `permitted;DNS.${i} = ${d}`),
      ...constraints.ip.map((r, i) => { const [a, p] = r.split('/'); return `permitted;IP.${i} = ${a}/${maskOf(+p, net.isIPv6(a))}`; })];
    fs.writeFileSync(path.join(w, 'ca.cnf'), `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = ${CA_NAME} (${hostLocalName(hostname) || 'this machine'})\nO = Halay\n[v3_ca]\nbasicConstraints = critical, CA:TRUE, pathlen:0\nkeyUsage = critical, keyCertSign, cRLSign\nsubjectKeyIdentifier = hash\nnameConstraints = critical, @nc\n[nc]\n${nc.join('\n')}\n`);
    fs.writeFileSync(path.join(w, 'ca.key'), newKey(), { mode: 0o600 });
    openssl(bin, ['req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', String(days), '-config', 'ca.cnf', '-extensions', 'v3_ca', '-set_serial', '0x' + crypto.randomBytes(12).toString('hex'), '-out', 'ca.crt'], w);
    writeAtomic(paths.caKey, fs.readFileSync(path.join(w, 'ca.key')), 0o600);
    writeAtomic(paths.caCrt, fs.readFileSync(path.join(w, 'ca.crt')), 0o644);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
}

// a new leaf (server) certificate for these names, signed by the CA -> writes leaf.key, leaf.crt
export function issueLeaf({ paths, names, days = LEAF_DAYS, bin = opensslBin() }) {
  const w = workDir(paths);
  try {
    const san = names.map((n, i) => net.isIP(n) ? `IP.${i} = ${n}` : `DNS.${i} = ${n}`).join('\n');
    fs.writeFileSync(path.join(w, 'leaf.cnf'), `[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = ${names.find((n) => !net.isIP(n)) || 'localhost'}\nO = Halay\n[v3_leaf]\nbasicConstraints = critical, CA:FALSE\nkeyUsage = critical, digitalSignature\nextendedKeyUsage = serverAuth\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid\nsubjectAltName = @san\n[san]\n${san}\n`);
    fs.writeFileSync(path.join(w, 'leaf.key'), newKey(), { mode: 0o600 });
    openssl(bin, ['req', '-new', '-key', 'leaf.key', '-config', 'leaf.cnf', '-out', 'leaf.csr'], w);
    openssl(bin, ['x509', '-req', '-in', 'leaf.csr', '-CA', paths.caCrt, '-CAkey', paths.caKey, '-set_serial', '0x' + crypto.randomBytes(12).toString('hex'), '-days', String(days), '-sha256', '-extfile', 'leaf.cnf', '-extensions', 'v3_leaf', '-out', 'leaf.crt'], w);
    writeAtomic(paths.leafKey, fs.readFileSync(path.join(w, 'leaf.key')), 0o600);
    writeAtomic(paths.leafCrt, fs.readFileSync(path.join(w, 'leaf.crt')), 0o600);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
}

export const readState = (paths) => { try { return JSON.parse(fs.readFileSync(paths.state, 'utf8')); } catch { return null; } };
export const writeState = (paths, s) => writeAtomic(paths.state, JSON.stringify(s, null, 1) + '\n', 0o600);
export const readCert = (f) => { try { return new crypto.X509Certificate(fs.readFileSync(f)); } catch { return null; } };
export const sansOf = (x) => String(x?.subjectAltName || '').split(/,\s*/).filter(Boolean).map((s) => s.replace(/^(DNS|IP Address):/, '')).map((n) => net.isIPv6(n) && expand6(n) === expand6('::1') ? '::1' : n);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const days = (ms) => Math.floor(ms / DAY);

// ---- the server's side ------------------------------------------------------------------------------------------
// which certificate to serve -> { source: 'user' | 'halay', certFile, keyFile } | { error } | null
export function tlsConfig({ dataDir, env = process.env }) {
  const c = env.HALAY_TLS_CERT, k = env.HALAY_TLS_KEY;
  if (c || k) return c && k ? { source: 'user', certFile: c, keyFile: k } : { error: 'set both HALAY_TLS_CERT and HALAY_TLS_KEY (only one is set); HTTPS is off' };
  const p = certPaths(dataDir);
  return fs.existsSync(p.leafCrt) && fs.existsSync(p.leafKey) ? { source: 'halay', certFile: p.leafCrt, keyFile: p.leafKey } : null;
}

// Check the served certificate and re-issue halay's own leaf when needed. Never writes a user's files.
// -> { renewed, reasons: [...], warnings: [...], expires } ; now and names (the machine's, a list) are injectable for tests
export function checkTls({ dataDir, tls, now = Date.now(), names, bin = opensslBin(), force = false, log = console.log }) {
  const out = { renewed: false, reasons: [], warnings: [], expires: null };
  if (!tls || tls.error) return out;
  const leaf = readCert(tls.certFile);
  if (!leaf) { out.warnings.push(`can't read the HTTPS certificate ${tls.certFile}`); return out; }
  out.expires = Date.parse(leaf.validTo);
  if (tls.source === 'user') {
    const left = out.expires - now;
    if (left < RENEW_DAYS * DAY) out.warnings.push(left <= 0 ? `your HTTPS certificate (${tls.certFile}) has expired; replace it` : `your HTTPS certificate (${tls.certFile}) expires in ${days(left)} days (${leaf.validTo}); replace it (halay never renews certificates it didn't make)`);
    return out;
  }
  const p = certPaths(dataDir), st = readState(p) || {}, ca = readCert(p.caCrt);
  if (!ca || !st.ca?.constraints) { out.warnings.push(`the CA in ${p.dir} is missing or incomplete; run \`halay cert install\` again`); return out; }
  const caLeft = Date.parse(ca.validTo) - now;
  if (caLeft <= 0) { out.warnings.push('the local CA has expired: run `halay cert install` to make a new one (then trust it again, also on your phones)'); return out; }
  if (caLeft < CA_WARN_DAYS * DAY) out.warnings.push(`the local CA expires in ${days(caLeft)} days (${ca.validTo}): run \`halay cert install\` before then to make a new one, and trust it again (also on your phones)`);
  const current = names || machineNames({ extra: st.extraHosts || [] }).names;
  const allowed = current.filter((n) => permits(st.ca.constraints, n)), outside = current.filter((n) => !permits(st.ca.constraints, n));
  if (outside.length) out.warnings.push(`this machine's ${outside.join(', ')} ${outside.length > 1 ? 'are' : 'is'} not covered by the local CA; run \`halay cert install\` again to include ${outside.length > 1 ? 'them' : 'it'} (a new CA must be trusted again, also on phones)`);
  if (force) out.reasons.push('requested');
  if (out.expires - now < RENEW_DAYS * DAY) out.reasons.push(`it expires in ${days(out.expires - now)} days`);
  const have = sansOf(leaf);
  if (!sameSet(allowed, have)) out.reasons.push(`the machine's names changed (${[...allowed.filter((n) => !have.includes(n)).map((n) => '+' + n), ...have.filter((n) => !allowed.includes(n)).map((n) => '-' + n)].join(' ')})`);
  if (out.reasons.length) {
    try {
      issueLeaf({ paths: p, names: allowed, bin, days: Math.min(LEAF_DAYS, Math.max(1, days(caLeft))) });
      out.renewed = true;
      st.leaf = { names: allowed, issuedAt: new Date(now).toISOString() };
      st.lastRenewal = new Date(now).toISOString();
      out.expires = Date.parse(readCert(p.leafCrt).validTo);
      log(`https: renewed the certificate (${out.reasons.join('; ')}); valid until ${new Date(out.expires).toISOString()}`);
    } catch (e) { out.warnings.push('renewing the HTTPS certificate failed: ' + e.message); }
  }
  st.lastCheck = new Date(now).toISOString();
  st.nextCheck = new Date(now + CHECK_MS).toISOString();
  try { writeState(p, st); } catch {}
  return out;
}

// ---- trust stores ----------------------------------------------------------------------------------------------
const LOGIN_KEYCHAIN = () => path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
const LINUX_ANCHORS = [
  { dir: '/usr/local/share/ca-certificates', file: 'halay-local-ca.crt', update: 'update-ca-certificates', distro: 'Debian, Ubuntu' },
  { dir: '/etc/pki/ca-trust/source/anchors', file: 'halay-local-ca.crt', update: 'update-ca-trust', distro: 'Fedora, RHEL, Arch' },
];
export function trustCommands(platform, caCrt) {
  if (platform === 'darwin') return { run: [['security', ['add-trusted-cert', '-r', 'trustRoot', '-k', LOGIN_KEYCHAIN(), caCrt]]] };
  return { print: LINUX_ANCHORS.map((a) => `# ${a.distro}:\nsudo cp '${caCrt}' ${a.dir}/${a.file} && sudo ${a.update}`).concat(`# Chrome/Chromium on Linux (its own NSS store; needs libnss3-tools):\ncertutil -d sql:$HOME/.pki/nssdb -A -t C,, -n '${CA_NAME}' -i '${caCrt}'`) };
}
export function untrustCommands(platform, caCrt) {
  if (platform === 'darwin') {
    const x = readCert(caCrt);
    const sha1 = x ? x.fingerprint.replace(/:/g, '') : null;
    return { run: [['security', ['remove-trusted-cert', caCrt], { ignoreFail: true }], ...(sha1 ? [['security', ['delete-certificate', '-Z', sha1, LOGIN_KEYCHAIN()], { ignoreFail: true }]] : [])] };
  }
  return { print: LINUX_ANCHORS.map((a) => `# ${a.distro}:\nsudo rm -f ${a.dir}/${a.file} && sudo ${a.update}${a.update === 'update-ca-certificates' ? ' --fresh' : ''}`).concat(`# Chrome/Chromium on Linux:\ncertutil -d sql:$HOME/.pki/nssdb -D -n '${CA_NAME}'`) };
}
// is the CA trusted by the system? true / false / null (can't tell)
export function isTrusted(platform, paths) {
  if (!fs.existsSync(paths.leafCrt)) return null;
  if (platform === 'darwin') {
    const r = spawnSync('security', ['verify-cert', '-c', paths.leafCrt, '-p', 'ssl', '-s', 'localhost', '-L', '-q'], { encoding: 'utf8' });
    return r.error ? null : r.status === 0;
  }
  const ca = fs.readFileSync(paths.caCrt, 'utf8');
  return LINUX_ANCHORS.some((a) => { try { return fs.readFileSync(path.join(a.dir, a.file), 'utf8').trim() === ca.trim(); } catch { return false; } });
}

// ---- `halay cert …` ---------------------------------------------------------------------------------------------
export async function certCmd(sub, opts, ctx, { platform = process.platform, log = console.log, err = console.error, names: namesOpt, bin = opensslBin(ctx.env), reload = reloadServer } = {}) {
  const p = certPaths(ctx.dataDir), dry = !!opts['dry-run'];
  const httpsPort = Number(ctx.env.HALAY_HTTPS_PORT || 4778);
  const exec = (list) => {
    for (const [cmd, args, o = {}] of list) {
      if (dry) { log(`would run: ${cmd} ${args.map((a) => /\s/.test(a) ? `'${a}'` : a).join(' ')}`); continue; }
      log(`running: ${cmd} ${args[0]} … (macOS may ask for your password)`);
      const r = spawnSync(cmd, args, { stdio: 'inherit' });
      if (r.status !== 0 && !o.ignoreFail) { err(`${cmd} ${args[0]} failed (exit ${r.status})`); return false; }
    }
    return true;
  };
  if (ctx.env.HALAY_TLS_CERT || ctx.env.HALAY_TLS_KEY) log(`note: HALAY_TLS_CERT/HALAY_TLS_KEY are set, so the server serves that certificate, not the one made here.`);

  if (sub === 'install') {
    const st = readState(p) || {};
    const extra = [...new Set([...(st.extraHosts || []), ...opts.host])];
    const m = namesOpt ? { names: [...new Set([...namesOpt.names, ...extra])], networks: namesOpt.networks } : machineNames({ extra });
    const constraints = constraintsFor(m);
    const ca = readCert(p.caCrt);
    const keepCA = ca && fs.existsSync(p.caKey) && st.ca?.constraints && m.names.every((n) => permits(st.ca.constraints, n)) && Date.parse(ca.validTo) - Date.now() > CA_WARN_DAYS * DAY;
    log(`names: ${m.names.join(', ')}`);
    log(keepCA ? `CA: keeping the existing one (${p.caCrt}); it covers every name` : `CA: a new one, limited to DNS ${constraints.dns.join(', ')} and IP ${constraints.ip.join(', ')}`);
    if (dry) {
      log(`would write ${p.dir}/ (mode 700): ${keepCA ? '' : 'ca.key (600), ca.crt, '}leaf.key (600), leaf.crt, certs.json`);
      if (ca && !keepCA) exec(untrustCommands(platform, p.caCrt).run || []);
      const t = trustCommands(platform, p.caCrt);
      if (t.run) exec(t.run); else log(`then, to trust it:\n${t.print.join('\n')}`);
      return 0;
    }
    try {
      fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 }); fs.chmodSync(p.dir, 0o700);
      if (!keepCA) {
        if (ca && platform === 'darwin') exec(untrustCommands(platform, p.caCrt).run); // the old CA goes from the keychain
        createCA({ paths: p, constraints, bin });
        st.ca = { constraints, createdAt: new Date().toISOString() };
      }
      st.extraHosts = extra;
      const allowed = m.names.filter((n) => permits(st.ca.constraints, n));
      issueLeaf({ paths: p, names: allowed, bin });
      st.leaf = { names: allowed, issuedAt: new Date().toISOString() };
      st.lastRenewal = st.leaf.issuedAt;
      writeState(p, st);
    } catch (e) { err(e.message); return 1; }
    log(`wrote ${p.dir}: ca.crt, ca.key, leaf.crt, leaf.key (valid until ${readCert(p.leafCrt).validTo})`);
    const t = trustCommands(platform, p.caCrt);
    if (t.run) { if (!exec(t.run)) { err('the CA was not added to the keychain; run `halay cert install` again to retry'); return 1; } log('the CA is trusted in your login keychain (Safari, Chrome, Edge). Firefox uses its own store: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import, or set security.enterprise_roots.enabled to true in about:config.'); }
    else log(`to trust it (system and Chrome; halay doesn't run sudo for you):\n${t.print.join('\n')}\nFirefox uses its own store: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import ${p.caCrt}.`);
    const r = await reload(ctx);
    log(r === 'reloaded' ? `the running server now serves the new certificate on https://…:${httpsPort}/` : `restart the server (\`halay restart\`) to start HTTPS on port ${httpsPort} (HALAY_HTTPS_PORT).`);
    log(`phones: open https://<this machine>:${httpsPort}/halay-ca.crt (accept the one-time warning; check the SHA-256 fingerprint from \`halay cert status\`) and install it, see docs/install.md "Local HTTPS". Passkeys are per address: set one up again at the https address.`);
    return 0;
  }
  if (sub === 'status') {
    const st = readState(p), ca = readCert(p.caCrt), leaf = readCert(p.leafCrt);
    if (!ca && !leaf) { log(`no local certificates (${p.dir}). Make them with \`halay cert install\`.`); return 3; }
    log(`folder: ${p.dir}`);
    if (ca) log(`CA: ${p.caCrt}, valid until ${ca.validTo}, SHA-256 ${ca.fingerprint256}${st?.ca?.constraints ? `; limited to DNS ${st.ca.constraints.dns.join(', ')}; IP ${st.ca.constraints.ip.join(', ')}` : ''}`);
    if (leaf) log(`certificate: ${p.leafCrt}, valid until ${leaf.validTo}\nnames: ${sansOf(leaf).join(', ')}`);
    const t = isTrusted(platform, p);
    log(`trusted by the system: ${t === null ? 'unknown' : t ? 'yes' : 'no (run `halay cert install` again, or the commands it prints)'}`);
    log(`last renewal: ${st?.lastRenewal || 'never'}; last check by the server: ${st?.lastCheck || 'never'}; next check: ${st?.nextCheck || 'at the next server start'}`);
    log(`HTTPS port: ${httpsPort}`);
    return 0;
  }
  if (sub === 'renew') {
    if (!readCert(p.caCrt)) { err(`no local CA (${p.dir}); run \`halay cert install\` first.`); return 1; }
    const r = checkTls({ dataDir: ctx.dataDir, tls: { source: 'halay', certFile: p.leafCrt, keyFile: p.leafKey }, names: namesOpt?.names, bin, force: true, log });
    for (const w of r.warnings) err('warning: ' + w);
    if (!r.renewed) return 1;
    const how = await reload(ctx);
    log(how === 'reloaded' ? 'the running server serves the new certificate now (no restart).' : 'no running server reached; it uses the new certificate at its next start.');
    return 0;
  }
  if (sub === 'uninstall') {
    if (!fs.existsSync(p.dir)) { log(`no local certificates (${p.dir}).`); return 0; }
    const u = untrustCommands(platform, p.caCrt);
    if (u.run) exec(u.run); else log(`${dry ? 'then' : 'also'} remove it from the system store (if you added it):\n${u.print.join('\n')}`);
    if (dry) { log(`would delete ${p.dir}`); return 0; }
    fs.rmSync(p.dir, { recursive: true, force: true });
    log(`deleted ${p.dir}. Restart the server (\`halay restart\`) to stop serving HTTPS; remove the CA from your phones too (iOS: Settings → General → VPN & Device Management).`);
    return 0;
  }
  return 2;
}

// ask the running server to reload its certificate (POST /api/server/tls-reload) -> 'reloaded' | 'no-https' | 'not-running'
export async function reloadServer(ctx) {
  let token = ctx.env.HALAY_TOKEN;
  if (!token) try { token = fs.readFileSync(path.join(ctx.dataDir, '.token'), 'utf8').trim(); } catch { return 'not-running'; }
  const h = ctx.host === '0.0.0.0' || ctx.host === '::' ? '127.0.0.1' : ctx.host.includes(':') ? `[${ctx.host}]` : ctx.host;
  try {
    const r = await fetch(`http://${ctx.httpHost || h}:${ctx.port}/api/server/tls-reload`, { method: 'POST', headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.reloaded ? 'reloaded' : 'no-https';
  } catch { return 'not-running'; }
}
