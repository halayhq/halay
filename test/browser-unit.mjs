// Unit check of browser.js settings (no server, no Chromium launched):
//   node test/browser-unit.mjs
// A Chromium path in Settings that does not exist is reported as such, and the usual places are used instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrowser } from '../src/browser.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-unit-'));
let cfg = { path: path.join(scratch, 'no-such-chrome') };
const b = createBrowser({ root: scratch, runs: scratch, port: 1, token: 't', getCfg: () => cfg, putCfg: () => {}, broadcast: () => {}, agentName: () => '' });
const get = async () => { let out; await b.api({ method: 'GET', headers: {} }, {}, new URL('http://x/api/browser'), { json: (_r, code, j) => (out = j), readBody: async () => ({}) }); return out; };
const logs = []; const log = console.log; console.log = (...a) => logs.push(a.join(' '));
let j = await get();
console.log = log;
ok(j.pathMissing === cfg.path, 'a missing configured path is reported (pathMissing)');
ok(j.binary !== cfg.path, 'and not used as the binary');
ok(!j.binary || logs.some((l) => l.includes('does not exist') && l.includes(cfg.path)), 'falling back to a found Chromium says so in the log');
cfg = { path: process.execPath }; // any existing file
j = await get();
ok(j.pathMissing === null && j.binary === process.execPath, 'an existing configured path is used as is');
fs.rmSync(scratch, { recursive: true, force: true });
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
