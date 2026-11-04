// ---- Settings → Peers: other swarm servers the swarm chat can drive (docs/peers.md). Tokens go in, never come back.
let peerSelf = '';
async function loadPeers(check = false) {
  try {
    const r = await api('/peers' + (check ? '?check=1' : ''));
    $('#prself').value = peerSelf = swarmName = r.self || ''; updateBadges();
    const list = $('#prlist'); list.textContent = '';
    if (!r.peers.length) list.append(mk('div', 'mutl', 'No peers yet.'));
    for (const p of r.peers) {
      const row = mk('div', 'pkrow'), t = mk('div', 'pkt');
      t.append(mk('b', '', p.name), mk('small', '', p.url + (p.status ? (p.status.ok ? ` · reachable: calls itself "${p.status.name}", ${p.status.agents} agents, ${p.status.running} running` : ` · unreachable: ${p.status.error}`) : '')));
      const ed = mk('button', '', 'Edit'); ed.type = 'button';
      ed.onclick = () => { $('#prname').value = p.name; $('#prurl').value = p.url; $('#prtok').value = ''; $('#prtok').focus(); };
      const del = mk('button', 'danger', 'Remove'); del.type = 'button';
      del.onclick = async () => {
        if (!await ask(`Remove the peer "${p.name}"? The swarm chat can no longer reach it (its agents keep running there).`, { ok: 'Remove', danger: true })) return;
        try { await api('/peers/' + encodeURIComponent(p.name), { method: 'DELETE' }); } catch (e) { $('#prstatus').textContent = e.message; }
        loadPeers();
      };
      row.append(t, ed, del);
      list.append(row);
    }
  } catch (e) { $('#prstatus').textContent = e.message; }
}
$('#pradd').onclick = async () => {
  $('#prstatus').textContent = '';
  const name = $('#prname').value.trim();
  try {
    await api('/peers/' + encodeURIComponent(name), { method: 'PUT', body: { url: $('#prurl').value.trim(), token: $('#prtok').value.trim() || undefined } });
    $('#prname').value = $('#prurl').value = $('#prtok').value = '';
    $('#prstatus').textContent = `Saved "${name}".`;
    loadPeers(true);
  } catch (e) { $('#prstatus').textContent = e.message; }
};
$('#prcheck').onclick = async () => { $('#prstatus').textContent = 'Checking…'; await loadPeers(true); $('#prstatus').textContent = ''; };
// part of the Settings Save button
const savePeerSelf = async () => { const v = $('#prself').value.trim(); if (v !== peerSelf) { await api('/peers', { method: 'PUT', body: { self: v } }); loadPeers(); } };
