// /api/limits is stale-while-revalidate (SPARE instance, fake claude answering `-p /usage` after 2 s): a reading older than the
// TTL is served at once and refreshed behind the request; only the very first reading and ?refresh=1 wait for claude.
//   node test/limits-e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSpare, checker, sleep, waitFor } from './lib/spare.mjs';
const { ok, done } = checker();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-e2e-')), file = path.join(dir, 'pct');
fs.writeFileSync(file, '10');
const s = await startSpare({ tag: 'limits', env: { HALAY_LIMITS_TTL_MS: '1500', FAKE_USAGE_SLEEP: '2', FAKE_USAGE_FILE: file } });
try {
  const read = async (q = '') => { const t = Date.now(), r = await s.api('/limits' + q), a = Object.values(r.j)[0]; return { ms: Date.now() - t, pct: a?.limits?.[0]?.pct }; };
  const first = await waitFor(async () => { const r = await read(); return r.pct !== undefined && r; }, 15000, 300); // warmed at startup
  ok(first && first.pct === 10, `first reading arrives (${first?.pct}%)`);
  const hit = await read();
  ok(hit.ms < 300 && hit.pct === 10, `a fresh reading comes from the cache (${hit.ms} ms)`);
  fs.writeFileSync(file, '20');
  await sleep(1700); // older than the 1.5 s TTL now
  const stale = await read();
  ok(stale.ms < 500 && stale.pct === 10, `a stale reading is served at once (${stale.ms} ms), still the old value`);
  const fresh = await waitFor(async () => { const r = await read(); return r.pct === 20 && r; }, 8000, 400);
  ok(!!fresh, 'the background refresh replaced it with the new value');
  fs.writeFileSync(file, '30');
  const forced = await read('?refresh=1');
  ok(forced.pct === 30 && forced.ms >= 1500, `?refresh=1 waits for a new reading (${forced.ms} ms, ${forced.pct}%)`);
} catch (e) { ok(false, 'unexpected exception: ' + (e.stack || e)); } finally { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
done();
