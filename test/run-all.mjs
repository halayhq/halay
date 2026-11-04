#!/usr/bin/env node
// One-command test suite: runs every test file sequentially and prints PASS / FAIL / SKIP per file; exits non-zero if any fails.
//   npm test                        everything (unit tests + e2e tests, each e2e test against its own spare instance)
//   npm run test:unit               only the unit tests (no server, no browser)
//   node test/run-all.mjs rooms     only files whose name contains "rooms" (several words = any of them)
//   node test/run-all.mjs --list    show what would run
//   node test/run-all.mjs -v        also stream every test's output (default: output only for failing files)
//
// Isolation: nothing here touches the live server (port 4777) or the checkout's halay.db / .token. Tests that need
// BASE and TOKEN (bots, models, auth, browser) get a spare instance the runner starts for them: a free port, a
// throwaway database in a temp folder, a generated token and the fake claude CLI (test/fake-claude) first in PATH, so no
// model calls are made. The other tests start their own spare instances (test/lib/spare.mjs). The runner stops each
// instance and deletes its temp folder after the test.
//
// Skips: tests that drive a browser (playwright-core + Chrome) are skipped with a message when Chrome can't be launched;
// the terminal tests skip themselves when node-pty isn't installed.
// Environment:
//   HALAY_TEST_TIMEOUT=<seconds>    per-file limit (default 300)
//   HALAY_TEST_PENDING=fail         count the checks for bugs that are known and being fixed (printed XFAIL) as failures
//   SLOW=1                          passed through (stdin-e2e also checks the watchdog; ~1.5 minutes)
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, startSpare, chromeAvailable } from './lib/spare.mjs';

// mode: 'unit' = no server; 'self' = starts its own instance(s); 'spare' = needs BASE/TOKEN, the runner starts the instance
const TESTS = [
  { file: 'unit.mjs', mode: 'unit' },
  { file: 'stats-unit.mjs', mode: 'unit' },
  { file: 'acp-unit.mjs', mode: 'unit' },
  { file: 'prompts-unit.mjs', mode: 'unit' },
  { file: 'agent-notify-unit.mjs', mode: 'unit' },
  { file: 'theme-unit.mjs', mode: 'unit' },
  { file: 'config-unit.mjs', mode: 'unit' },
  { file: 'home-unit.mjs', mode: 'unit' },
  { file: 'install-kind-unit.mjs', mode: 'unit' },
  { file: 'cli-unit.mjs', mode: 'unit' },
  { file: 'service-unit.mjs', mode: 'unit' },
  { file: 'mac-app-unit.mjs', mode: 'unit' },
  { file: 'peer-messages-unit.mjs', mode: 'unit' },
  { file: 'rooms-e2e.mjs', mode: 'self' },
  { file: 'agent-notify-e2e.mjs', mode: 'self' },
  { file: 'agent-notify-acp-e2e.mjs', mode: 'self' },
  { file: 'agent-start-e2e.mjs', mode: 'self' },
  { file: 'git-e2e.mjs', mode: 'self' },
  { file: 'terminal-e2e.mjs', mode: 'self' },
  { file: 'mcp-roles-e2e.mjs', mode: 'self' },
  { file: 'bots-lifecycle-e2e.mjs', mode: 'self' },
  { file: 'peers-filter-e2e.mjs', mode: 'self' },
  { file: 'machines-e2e.mjs', mode: 'self' },
  { file: 'limits-e2e.mjs', mode: 'self' },
  { file: 'auth-reset-e2e.mjs', mode: 'self' },
  { file: 'local-app-e2e.mjs', mode: 'self' },
  { file: 'hardening-e2e.mjs', mode: 'self' },
  { file: 'escalation-e2e.mjs', mode: 'self' },
  { file: 'perms-e2e.mjs', mode: 'self' },
  { file: 'agent-token-e2e.mjs', mode: 'self' },
  { file: 'claude-launch-e2e.mjs', mode: 'self' },
  { file: 'acp-e2e.mjs', mode: 'self' },
  { file: 'acp-ui-e2e.mjs', mode: 'self' },
  { file: 'acp-roles-e2e.mjs', mode: 'self' },
  { file: 'acp-backends-e2e.mjs', mode: 'self' },
  { file: 'acp-history-e2e.mjs', mode: 'self' },
  { file: 'acp-antigravity-e2e.mjs', mode: 'self' },
  { file: 'accounts-e2e.mjs', mode: 'self' },
  { file: 'default-accounts-e2e.mjs', mode: 'self' },
  { file: 'bots-e2e.mjs', mode: 'spare' },
  { file: 'models-e2e.mjs', mode: 'spare' },
  { file: 'editor-e2e.mjs', mode: 'self' },
  { file: 'raw-e2e.mjs', mode: 'self' },
  { file: 'cert-e2e.mjs', mode: 'self' },
  { file: 'stdin-e2e.mjs', mode: 'self' },
  { file: 'peers-e2e.mjs', mode: 'self' },
  { file: 'plugins-e2e.mjs', mode: 'self', chrome: true },
  { file: 'questions-e2e.mjs', mode: 'self', chrome: true },
  { file: 'peer-messages-e2e.mjs', mode: 'self' },
  { file: 'attach-agents-e2e.mjs', mode: 'self', chrome: true },
  { file: 'routes-e2e.mjs', mode: 'self', chrome: true },
  { file: 'theme-e2e.mjs', mode: 'self', chrome: true },
  { file: 'sidebar-more-e2e.mjs', mode: 'self', chrome: true },
  { file: 'auth-e2e.mjs', mode: 'spare', chrome: true, env: { HALAY_TERMINAL: '0' } },
  { file: 'browser-e2e.mjs', mode: 'spare', chrome: true },
];

const args = process.argv.slice(2);
const verbose = args.includes('-v'), listOnly = args.includes('--list'), unitOnly = args.includes('--unit');
const words = args.filter((a) => !a.startsWith('-'));
let todo = TESTS.filter((t) => fs.existsSync(path.join(ROOT, 'test', t.file)));
if (unitOnly) todo = todo.filter((t) => t.mode === 'unit');
if (words.length) todo = todo.filter((t) => words.some((w) => t.file.includes(w)));
if (listOnly) { for (const t of todo) console.log(t.file.padEnd(28), t.mode + (t.chrome ? ' (needs Chrome)' : '')); process.exit(0); }

const TIMEOUT = (Number(process.env.HALAY_TEST_TIMEOUT) || 300) * 1000;
let chrome = null;
const results = [];

function run(t, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'test', t.file)], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', timedOut = false;
    const feed = (d) => { out += d; if (verbose) process.stdout.write(d); };
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, TIMEOUT);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, timedOut }); });
  });
}
const count = (out, tag) => out.split('\n').filter((l) => l.startsWith(tag + ' ')).length;

const started = Date.now();
for (const t of todo) {
  const t0 = Date.now();
  if (t.chrome) {
    chrome ??= await chromeAvailable();
    if (!chrome) { console.log(`SKIP  ${t.file}: needs Chrome (playwright-core with a launchable Chrome); none found`); results.push({ t, status: 'SKIP' }); continue; }
  }
  let spare = null, env = { ...(t.env || {}) };
  try {
    if (t.mode === 'spare') {
      spare = await startSpare({ tag: t.file.replace(/\W.*/, ''), env: t.env });
      // localhost, not 127.0.0.1: WebAuthn (auth-e2e) refuses an IP address as the relying-party id
      env = { ...env, BASE: spare.base.replace('127.0.0.1', 'localhost'), TOKEN: spare.token, DB: spare.db, FAKE_CLAUDE_LOG: spare.claudeLog, PW: path.join(createRequire(path.join(ROOT, 'package.json')).resolve('playwright-core/package.json'), '..') };
    } else { delete process.env.BASE; delete process.env.TOKEN; } // self-starting tests must not talk to someone else's server
    if (verbose) console.log(`\n=== ${t.file}`);
    const r = await run(t, env);
    const fail = r.code !== 0 || r.timedOut, n = { pass: count(r.out, 'PASS'), fail: count(r.out, 'FAIL'), skip: count(r.out, 'SKIP'), xfail: count(r.out, 'XFAIL') };
    const status = fail ? 'FAIL' : n.pass === 0 && n.skip > 0 ? 'SKIP' : 'PASS';
    results.push({ t, status, n });
    console.log(`${status}  ${t.file}  (${n.pass} checks${n.fail ? `, ${n.fail} failed` : ''}${n.skip ? `, ${n.skip} skipped` : ''}${n.xfail ? `, ${n.xfail} pending-fix` : ''}, ${((Date.now() - t0) / 1000).toFixed(1)}s)${r.timedOut ? ' TIMED OUT' : r.code ? ' exit ' + r.code : ''}`);
    if (fail && !verbose) console.log(r.out.split('\n').filter((l) => l.trim()).slice(-40).map((l) => '    ' + l).join('\n'));
  } catch (e) {
    results.push({ t, status: 'FAIL' });
    console.log(`FAIL  ${t.file}: ${e.message}`);
  } finally { await spare?.stop(); }
}

const c = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${c('PASS')} passed, ${c('FAIL')} failed, ${c('SKIP')} skipped of ${results.length} files in ${((Date.now() - started) / 1000).toFixed(0)}s`);
for (const r of results.filter((r) => r.status === 'FAIL')) console.log('  FAILED: ' + r.t.file);
process.exit(c('FAIL') ? 1 : 0);
