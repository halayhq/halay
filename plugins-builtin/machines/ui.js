// Sidebar: how loaded this machine and each peer are (CPU, RAM, fullest disk). /api/stats is this host's cached sample;
// /api/peers?check=1 probes the peers (which carry their stats). Refreshed every 30 s while the page is visible.
// Was public/js/hosts.js; now the first core feature moved into a built-in plugin.
const level = (p) => (p >= 90 ? 'high' : p >= 75 ? 'warn' : '');

function row({ mk, icon }, name, s, err, url, checking) {
  const r = mk('div', 'mrow' + (s ? '' : ' off')), head = mk('div', 'mhd');
  head.append(mk('b', '', name));
  if (url) { // a peer: open its own web UI in a new tab
    const a = mk('a', 'hopen'); a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.title = `Open ${name} in a new tab`; a.setAttribute('aria-label', `Open ${name}`);
    a.innerHTML = icon('external-link');
    head.append(a);
  }
  r.append(head);
  if (!s && checking) { head.append(mk('span', 'hm', 'checking…')); return r; }
  if (!s) { head.append(mk('span', 'hm', 'offline')); r.title = `${name}: ${err || 'unreachable'}`; return r; }
  const disks = s.disks || [], worst = disks.reduce((a, d) => (!a || d.percent > a.percent ? d : a), null);
  const stats = mk('div', 'mst'); r.append(stats);
  for (const [label, pct] of [['CPU', s.cpu.percent], ['RAM', s.mem.percent], ['Disk', worst?.percent]]) {
    if (pct === undefined) continue;
    stats.append(mk('span', 'hm ' + level(pct), `${label} ${pct}%`));
  }
  r.title = `${name}\nCPU ${s.cpu.percent}% of ${s.cpu.cores} cores, load ${s.cpu.load.join(' ')}\nRAM ${s.mem.usedGb} of ${s.mem.totalGb} GB used\n`
    + disks.map((d) => `Disk ${d.path}: ${d.freeGb} GB free of ${d.totalGb} GB`).join('\n')
    + (s.battery ? `\nBattery ${s.battery.percent}%${s.battery.ac ? ' (AC)' : ''}` : '');
  return r;
}

export function activate(host) {
  // One request, /api/machines, answered from the server's cache (this machine's sample and the last probe of every peer), so
  // the block fills in at once and never waits on a peer that is off. A peer the server has not probed yet shows "checking…"
  // and is asked about again shortly.
  let seq = 0, retries = 0, retry = 0;
  const block = host.sidebar.block({
    id: 'load', title: 'Machines', order: 10,
    async render(body) {
      const mine = ++seq;
      try {
        const early = window.__early?.machines; if (early) delete window.__early.machines; // asked by index.html's head
        const d = (await early) || await host.coreApi('/machines');
        if (mine !== seq) return;
        const me = { ...d.stats, name: d.name };
        const peers = d.peers.map((p) => ({ ...p, stats: p.status?.ok ? p.status.stats : null, checking: p.status === null }));
        body.textContent = '';
        body.append(row(host.ui, d.name + ' (this)', me));
        for (const p of peers) body.append(row(host.ui, p.name, p.stats, p.status?.error, p.url, p.checking));
        // collapsed: the highest share of any machine, so a nearly full disk or busy host still shows
        const top = Math.max(0, ...[me, ...peers.map((p) => p.stats)].filter(Boolean).flatMap((s) => [s.cpu.percent, s.mem.percent, ...(s.disks || []).map((x) => x.percent)]));
        block.setCount(`max ${top}%`, level(top));
        block.setHidden(false);
        clearTimeout(retry);
        if (peers.some((p) => p.checking) && retries++ < 8) retry = setTimeout(block.refresh, 2500); else if (!peers.some((p) => p.checking)) retries = 0;
      } catch { block.setHidden(true); }
    },
  });
  block.setHidden(true); // until the first reading arrives
  host.every(30e3, block.refresh);
}
