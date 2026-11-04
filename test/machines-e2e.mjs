// /api/machines (the Machines block's cached view) against a SPARE instance: node test/machines-e2e.mjs
// It answers at once with this machine's stats, never waits on a peer that is off (status null = not probed yet), and fills in
// the peer's status after the background probe finished.
import { startSpare, checker, waitFor } from './lib/spare.mjs';
const { ok, done } = checker();
const s = await startSpare({ tag: 'machines' });
try {
  const none = await s.api('/machines');
  ok(none.status === 200 && none.j.stats?.cpu && Array.isArray(none.j.peers) && none.j.peers.length === 0, 'no peers: this machine\'s stats and an empty list');
  await s.api('/peers/ghost', 'PUT', { url: 'http://192.0.2.1:9', token: 'x' }); // a documentation address: never answers
  const t0 = Date.now(), first = await s.api('/machines');
  ok(Date.now() - t0 < 1500, `answers at once with a peer that never answers (${Date.now() - t0} ms)`);
  ok(first.j.peers[0]?.name === 'ghost' && first.j.peers[0].status === null, 'a peer not probed yet has status null');
  ok(!JSON.stringify(first.j).includes('"token"'), 'no peer token in the answer');
  const later = await waitFor(async () => { const r = await s.api('/machines'); return r.j.peers[0]?.status && r.j; }, 15000, 300);
  ok(later && later.peers[0].status.ok === false && !!later.peers[0].status.error, 'after the background probe the peer shows as unreachable with a reason');
  await s.api('/peers/ghost', 'DELETE');
  ok((await s.api('/machines')).j.peers.length === 0, 'a removed peer disappears');
  ok((await fetch(s.base + '/api/machines')).status === 401, 'needs the token');
} catch (e) { ok(false, 'unexpected exception: ' + (e.stack || e)); } finally { await s.stop(); }
done();
