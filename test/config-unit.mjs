// Unit checks (no server): the HALAY_* environment reader (util.js env).
import { env } from '../src/util.js';
import { checker } from './lib/spare.mjs';
const { ok, done } = checker();

// ---- env()
ok(env('T1', { HALAY_T1: 'new' }) === 'new', 'env: HALAY_ name is read');
ok(env('T2', { SWARM_T2: 'old' }) === undefined, 'env: the pre-rename SWARM_ name is ignored');
ok(env('T3', { HALAY_T3: 'new', SWARM_T3: 'old' }) === 'new', 'env: HALAY_ is read when both are set');
ok(env('T4', {}) === undefined, 'env: unset -> undefined');
ok(env('T5', { HALAY_T5: '' }) === '', 'env: an empty HALAY_ value is returned as is');

done();
