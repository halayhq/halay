// ---- quick switcher (⌘K / Ctrl+K): agents, pages, folders to start in, past sessions and message search; plus `/`, `g t`, `g h`
const kdlg = document.createElement('dialog');
kdlg.className = 'kswitch'; kdlg.setAttribute('aria-label', 'Quick switcher');
kdlg.innerHTML = `<div class="kin">${icon('search')}<input id="kq" type="text" placeholder="Jump to an agent, folder, session or page…" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"
  role="combobox" aria-expanded="true" aria-controls="kres" aria-autocomplete="list"><kbd>esc</kbd></div><div class="kres" id="kres" role="listbox" aria-label="Results"></div>
  <div class="kft"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span><span style="margin-left:auto"><kbd>/</kbd> search · <kbd>g</kbd> <kbd>t</kbd> tasks · <kbd>g</kbd> <kbd>h</kbd> history</span></div>`;
document.body.append(kdlg);
let kItems = [], kCur = 0, kSessions = null, kHits = [], kSeq = 0, kTimer = 0;

const PAGE_ITEMS = [
  ['New agent', 'plus', '/new'], ['Approvals', 'inbox', '/approvals'], ['Tasks', 'list-todo', '/tasks'], ['History', 'history', '/history'],
  ['Usage', 'chart-column', '/usage'], ['Settings', 'settings', '/settings'],
];
const kMatch = (terms, s) => { s = s.toLowerCase(); return terms.every((t) => s.includes(t)); };
const kScore = (q, name) => { name = name.toLowerCase(); return name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3; };

function kBuild() {
  const q = $('#kq').value.trim().toLowerCase(), terms = q.split(/\s+/).filter(Boolean), out = [];
  const sec = (label, items) => { if (items.length) out.push({ sec: label }, ...items); };
  // agents: needs-you first when there's no query, then by last activity
  const ags = Object.values(agents).filter((a) => !terms.length || kMatch(terms, `${a.name} ${a.cwd} ${a.worktree?.branch || ''} ${a.role === 'conductor' ? 'swarm chat conductor' : ''}`))
    .sort((x, y) => (terms.length ? kScore(q, x.name) - kScore(q, y.name) : needsYou(y) - needsYou(x)) || lastAt(y) - lastAt(x)).slice(0, terms.length ? 8 : 6);
  sec('Agents', ags.map((a) => {
    const [cls, txt] = stateOf(a);
    return { html: stIcon(cls, txt), t: a.name, s: txt.split(':')[0] + ' · ' + (a.oneOff ? 'one-off' : a.cwd), r: relTime(lastAt(a)), run: () => go('/a/' + a.id) };
  }));
  if (terms.length) sec('Pages', PAGE_ITEMS.filter(([n]) => kMatch(terms, n)).map(([n, ic, h]) => ({ html: icon(ic), t: n, run: () => go(h) })));
  // folders: where your agents and past sessions ran
  const dirs = new Map(), own = /\/tmp\/[\w-]+\/(wt|scratch)$/; // the swarm's own worktree and scratch folders aren't places to start in
  for (const a of Object.values(agents)) if (!a.oneOff && a.cwd && !a.worktree && !own.test(a.cwd)) dirs.set(a.cwd, Math.max(dirs.get(a.cwd) || 0, lastAt(a)));
  for (const s of kSessions || []) if (!s.oneOff && s.exists !== false && s.cwd && !s.worktree && !own.test(s.cwd)) dirs.set(s.cwd, Math.max(dirs.get(s.cwd) || 0, s.mtime));
  const fl = [...dirs].filter(([d]) => !terms.length || kMatch(terms, d)).sort((x, y) => (terms.length ? kScore(q, lastSeg(x[0])) - kScore(q, lastSeg(y[0])) : 0) || y[1] - x[1]).slice(0, terms.length ? 5 : 3);
  sec('Start a new agent in', fl.map(([d]) => ({ html: icon('folder'), t: lastSeg(d), s: d, run: () => { presetDir = d; go('/new'); } })));
  if (terms.length) {
    // past sessions (the History list): live ones open their agent, others open History filtered by your query
    const ss = (kSessions || []).filter((s) => kMatch(terms, `${s.title} ${s.oneOff ? 'one-off' : s.cwd}`) && !(s.agent && ags.some((a) => a.id === s.agent))).slice(0, 5);
    sec('Sessions', ss.map((s) => ({ html: icon('history'), t: s.title || '(untitled)', s: (s.oneOff ? 'one-off' : s.cwd) + (s.agent && agents[s.agent] ? ' · open as ' + agents[s.agent].name : ''), r: relTime(s.mtime),
      run: () => s.agent && agents[s.agent] ? go('/a/' + s.agent) : openHistoryWith($('#kq').value.trim()) })));
    sec('Messages', kHits.map((r) => ({ html: icon('message-square'), t: r.agentName, snip: r.snippet, r: relTime(r.ts), run: () => jumpTo(r, terms) })));
    out.push({ html: icon('search'), t: `Search all history for “${$('#kq').value.trim()}”`, s: 'in the sidebar', run: () => { if (matchMedia('(max-width: 700px)').matches && document.body.classList.contains('open')) go('/'); $('#q').value = $('#kq').value.trim(); $('#qx').hidden = false; runSearch(); } });
  }
  kItems = out.filter((x) => !x.sec); kCur = Math.min(kCur, Math.max(0, kItems.length - 1));
  const box = $('#kres'); box.innerHTML = '';
  if (!kItems.length) box.innerHTML = '<div class="kempty">No matches.</div>';
  let i = 0;
  for (const x of out) {
    if (x.sec) { box.append(mk('div', 'ksec', x.sec)); continue; }
    const n = i++, d = document.createElement('div');
    d.className = 'kit'; d.id = 'kit' + n; d.setAttribute('role', 'option');
    d.innerHTML = `<span class="kic">${x.html}</span><span class="kt"><b></b>${x.s || x.snip ? '<small></small>' : ''}</span>${x.r ? `<span class="kr">${esc(x.r)}</span>` : ''}`;
    d.querySelector('b').textContent = x.t;
    if (x.snip) d.querySelector('small').append(snippetNode(x.snip)); else if (x.s) d.querySelector('small').textContent = x.s;
    d.onmousemove = () => { if (kCur !== n) { kCur = n; kMark(); } };
    d.onclick = () => kRun(n);
    box.append(d);
  }
  kMark();
}
function kMark() {
  $('#kres').querySelectorAll('.kit').forEach((d, i) => d.setAttribute('aria-selected', i === kCur));
  const cur = $('#kit' + kCur);
  if (cur) { $('#kq').setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
}
function kRun(n) { const x = kItems[n]; if (!x) return; kdlg.close(); x.run(); }
async function openHistoryWith(q) {
  go('/history');
  for (let i = 0; i < 40 && !$('#hdlg').open; i++) await new Promise((r) => setTimeout(r, 50));
  $('#hq').value = q; $('#hq').dispatchEvent(new Event('input'));
}
async function kSearch() {
  const q = $('#kq').value.trim(), seq = ++kSeq;
  if (q.length < 3) { kHits = []; return; }
  try { const rows = await api('/search?limit=5&q=' + encodeURIComponent(q)); if (seq === kSeq && kdlg.open) { kHits = rows; kBuild(); } } catch {}
}

function openSwitcher() {
  if (kdlg.open) return $('#kq').select();
  $('#kq').value = ''; kCur = 0; kHits = []; kBuild();
  kdlg.showModal(); $('#kq').focus();
  if (!kSessions) api('/sessions/all').then((r) => { kSessions = r.sessions; setTimeout(() => { kSessions = null; }, 5 * 60e3); if (kdlg.open) kBuild(); }).catch(() => {});
}
$('#kq').addEventListener('input', () => { kCur = 0; kBuild(); clearTimeout(kTimer); kTimer = setTimeout(kSearch, 220); });
$('#kq').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); kCur = (kCur + 1) % Math.max(1, kItems.length); kMark(); }
  else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); kCur = (kCur - 1 + kItems.length) % Math.max(1, kItems.length); kMark(); }
  else if (e.key === 'Enter') { e.preventDefault(); kRun(kCur); }
});
kdlg.addEventListener('click', (e) => { if (e.target === kdlg) kdlg.close(); }); // backdrop
$('#kswitch').onclick = openSwitcher;
const kMac = /Mac|iPhone|iPad/.test(navigator.platform);
if (!kMac) $('#kswitch kbd').textContent = 'Ctrl K';

// global keys. Single-key shortcuts only when you aren't typing and no dialog is open.
let gPending = 0;
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('#xbody')) return; // keys typed in a terminal belong to the shell (Ctrl+K is kill-line)
  if ((kMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); kdlg.open ? kdlg.close() : openSwitcher(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  const el = document.activeElement;
  if (el && el.matches('input, textarea, select, [contenteditable], [contenteditable] *')) return;
  if (document.querySelector('dialog[open]')) return;
  if (gPending && (e.key === 't' || e.key === 'h')) { e.preventDefault(); gPending = 0; go(e.key === 't' ? '/tasks' : '/history'); return; }
  gPending = 0;
  if (e.key === 'g') { gPending = setTimeout(() => { gPending = 0; }, 1200); return; }
  if (e.key === '/') {
    e.preventDefault();
    if (matchMedia('(max-width: 700px)').matches && document.body.classList.contains('open')) go('/'); // the list is hidden behind the chat
    $('#q').focus();
  }
});
