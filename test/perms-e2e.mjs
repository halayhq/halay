// The data files hold secrets (peers' tokens, the Web Push private key, plugin secrets in halay.db; agents' output and
// their MCP config with the token in runs/): only the owner may read them, also when they existed before with wider modes.
import fs from 'node:fs';
import path from 'node:path';
import { startSpare, checker, newAgent, waitFor } from './lib/spare.mjs';

const c = checker();
const s = await startSpare({ tag: 'perms', env: { HALAY_TERMINAL: '0', HALAY_BACKENDS: 'claude' } });
const envLog = path.join(s.dir, 'env.log');
await s.restart({ FAKE_CLAUDE_ENVLOG: envLog });
const mode = (f) => { try { return fs.statSync(f).mode & 0o777; } catch { return null; } };
const runs = path.join(s.dir, 'runs');
try {
  c.ok(mode(s.db) === 0o600, `halay.db is 600 (${mode(s.db)?.toString(8)})`);
  c.ok(mode(runs) === 0o700, `runs/ is 700 (${mode(runs)?.toString(8)})`);
  const id = await newAgent(s, { prompt: 'hi' });
  const f = path.join(runs, id + '.mcp.json');
  c.ok(!!(await waitFor(() => fs.existsSync(f), 5000)) && mode(f) === 0o600, `the agent's MCP config is 600 (${mode(f)?.toString(8)})`);
  // the server runs with HALAY_TOKEN set (spare.mjs): the agent's own environment doesn't have it
  const envRec = (await waitFor(() => { try { return fs.readFileSync(envLog, 'utf8').split('\n---\n').find((r) => r.includes('/tmp/' + id + '\n')); } catch { return null; } }, 5000)) || '';
  c.ok(envRec.includes(id) && !envRec.includes(s.token), "the token is not in the agent's environment" + (envRec ? '' : ' (no env record)') + (envRec.includes(s.token) ? ': ' + envRec.split('\n').filter((l) => l.includes(s.token)).map((l) => l.split('=')[0]).join() : ''));
  // files from before: loosened, then a restart tightens them again
  fs.chmodSync(s.db, 0o644); fs.chmodSync(runs, 0o755);
  await s.restart();
  c.ok(mode(s.db) === 0o600 && mode(runs) === 0o700, `a restart tightens them (${mode(s.db)?.toString(8)}, ${mode(runs)?.toString(8)})`);
} catch (e) {
  c.ok(false, 'crashed: ' + e.stack);
  console.log(s.log().slice(-2000));
} finally {
  await s.stop();
}
c.done();
