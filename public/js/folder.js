// ---- new agent, two steps: (1) where: recent folders, a typed path, the folder browser or a one-off folder; (2) first message, session, options
let cur = '', sessionId = null, homeDir = '', bdir = '', nrows = [], nsel = 0, sessSeq = 0;
const ncwd = (p) => p.replace(/(.)\/+$/, '$1');
const nexpand = (p) => (homeDir ? p.replace(/^~(?=\/|$)/, homeDir) : p);
const isScratch = (p) => /\/tmp\/[0-9a-f]{8}\/(scratch|wt)(\/|$)/.test(p); // folders the swarm made itself (one-off, worktrees)
function recentDirs() { // last used first, then folders of agents (newest first), tasks and schedules
  const seen = new Set(), out = [];
  const add = (p) => { if (!p || isScratch(p)) return; p = ncwd(p); if (!seen.has(p)) { seen.add(p); out.push(p); } };
  add(localStorage.getItem('halay-last'));
  Object.values(agents).filter((a) => a.role !== 'conductor' && !a.oneOff && !a.worktree).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).forEach((a) => add(a.cwd));
  tasks.forEach((t) => add(t.cwd)); schedules.forEach((s) => add(s.cwd));
  return out;
}
function renderRecent() {
  const q = $('#npath').value.trim(), typed = /^[~/]/.test(q) ? ncwd(nexpand(q)) : '', ql = (typed || q).toLowerCase();
  const hits = recentDirs().filter((p) => !ql || p.toLowerCase().includes(ql));
  nrows = [...(typed && !hits.includes(typed) ? [{ p: typed, typed: true }] : []), ...hits.map((p) => ({ p }))];
  nsel = Math.max(0, Math.min(nsel, nrows.length - 1));
  $('#nrech').textContent = q ? 'Matching folders' : 'Recent folders';
  const box = $('#nrecent'); box.innerHTML = '';
  nrows.forEach((r, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.classList.toggle('hl', !!q && i === nsel);
    b.innerHTML = `${icon(r.typed ? 'corner-down-left' : 'folder', 'f')}<span class="nrt"><b></b><small><bdi></bdi></small></span>${icon('chevron-right')}`;
    b.querySelector('b').textContent = (r.typed ? 'Use ' : '') + (r.p.split('/').pop() || r.p);
    b.querySelector('bdi').textContent = r.p;
    b.onclick = () => choose(r.p);
    box.append(b);
  });
  if (!nrows.length) box.innerHTML = `<div class="empty">${q ? 'No recent folder matches. Type a full path (starting with / or ~), or use Browse….' : 'No recent folders yet. Type a path, or use Browse….'}</div>`;
}
$('#npath').oninput = () => { nsel = 0; renderRecent(); };
$('#npath').onkeydown = (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); nsel = Math.max(0, Math.min(nrows.length - 1, nsel + (e.key === 'ArrowDown' ? 1 : -1))); renderRecent(); $('#nrecent .hl')?.scrollIntoView({ block: 'nearest' }); }
  else if (e.key === 'Enter') { e.preventDefault(); if (nrows[nsel]) choose(nrows[nsel].p); }
};

// the folder browser (secondary to recent folders and typing)
async function browse(p) {
  let r;
  try { r = await api('/fs?path=' + encodeURIComponent(p || '')); } catch (e) { if (p) return browse(''); throw e; }
  bdir = r.path;
  $('#crumb').textContent = r.path;
  const box = $('#dirs'); box.innerHTML = '';
  const row = (ic, text, f) => { const e = document.createElement('div'); e.innerHTML = ic; e.append(text); e.tabIndex = 0; e.setAttribute('role', 'button'); e.onclick = f; e.onkeydown = (k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); f(); } }; box.append(e); };
  if (r.parent !== r.path) row(icon('arrow-up'), '..', () => browse(r.parent));
  for (const d of r.dirs) row(icon('folder', 'f'), d, () => browse(r.path.replace(/\/$/, '') + '/' + d));
  box.scrollTop = 0;
}
function showBrowser(on) {
  $('#picker').hidden = !on; $('#nbrowse').setAttribute('aria-expanded', on);
  $('#nnext').textContent = on ? 'Use this folder' : 'Continue';
  $('#nrech').hidden = $('#nrecent').hidden = on;
}
$('#nbrowse').onclick = async () => {
  if (!$('#picker').hidden) return showBrowser(false);
  const q = $('#npath').value.trim();
  $('#dirs').innerHTML = skel(4); showBrowser(true);
  await browse(/^[~/]/.test(q) ? nexpand(q) : cur || localStorage.getItem('halay-last') || '').catch((e) => flash(e.message, 'error'));
};
$('#noneoff').onclick = () => choose('', true);

function nstep(n) {
  $('#nstep1').hidden = n !== 1; $('#nstep2').hidden = n !== 2; $('#nback').hidden = n !== 2;
  $('#nnext').hidden = n !== 1; $('#start').hidden = n !== 2;
  $('#nsub').textContent = n === 1 ? 'Step 1 of 2 · Where should it work?' : 'Step 2 of 2 · What should it do?';
  $('#dlg .dlg-body').scrollTop = 0;
}
async function choose(p, oneOff = false) {
  $('#oochk').checked = oneOff;
  if (!oneOff) {
    try { cur = (await api('/fs?path=' + encodeURIComponent(nexpand(p)))).path; }
    catch (e) { flash(/ENOENT|no such/i.test(e.message) ? 'No such folder: ' + p : e.message, 'error'); return; }
  }
  $('#nwname').textContent = oneOff ? 'One-off scratch folder' : cur.split('/').pop() || cur;
  $('#nwpath').innerHTML = '<bdi></bdi>'; $('#nwpath').classList.toggle('txt', oneOff); $('#nwpath bdi').textContent = oneOff ? 'a fresh empty folder, removed with the agent' : cur; // bdi: the rtl ellipsis keeps the end of the path
  $('#nsessw').hidden = true; $('#wtrow').hidden = true; $('#wtchk').checked = false; $('#wtopt').hidden = true; sessionId = null;
  nstep(2);
  $('#nprompt').focus();
  if (!oneOff) { loadSessions(); probeRepo(cur); }
}
$('#nchange').onclick = $('#nback').onclick = () => { nstep(1); renderRecent(); $('#npath').focus(); };
$('#nnext').onclick = () => { if (!$('#picker').hidden) choose(bdir); else if (nrows[nsel]) choose(nrows[nsel].p); else $('#npath').focus(); };

async function loadSessions() {
  const seq = ++sessSeq, at = cur;
  sessionId = null;
  let list;
  try { list = await api(`/sessions?cwd=${encodeURIComponent(at)}&account=${encodeURIComponent($('#acct').value)}`); } catch { list = []; }
  if (seq !== sessSeq || cur !== at || $('#oochk').checked) return;
  $('#sess').innerHTML = '';
  $('#nsessw').hidden = !list.length; // only offered when this folder has sessions to continue
  const opt = (title, sub, id, used) => {
    const d = document.createElement('div');
    d.innerHTML = '<span></span><small></small>';
    d.firstChild.textContent = title; d.lastChild.textContent = sub;
    if (id === null) d.firstChild.insertAdjacentHTML('afterbegin', icon('sparkles'));
    if (used) d.classList.add('used');
    if (id === null) d.classList.add('on');
    d.tabIndex = 0; d.setAttribute('role', 'option');
    d.onclick = () => { sessionId = id; [...$('#sess').children].forEach((c) => c.classList.toggle('on', c === d)); $('#wtrow').hidden = !repoOk || !!id; };
    d.onkeydown = (k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); d.click(); } };
    $('#sess').append(d);
  };
  opt('New session', '', null);
  for (const s of list) opt(s.title, new Date(s.mtime).toLocaleString() + (s.inUse ? ' · already open as an agent' : ''), s.id, s.inUse);
}
function optSummary() {
  const m = $('#mode').value, b = $('#nbackend').value;
  $('#noptsum').textContent = [b && b !== 'claude' ? backendLabel(b) : '', $('#acct').value, m === 'cli' ? 'your settings' : m, $('#nmodel').value, $('#neffort').value && 'effort ' + $('#neffort').value, $('#leanchk').checked ? 'lean' : '', $('#browchk').checked ? 'browser' : ''].filter(Boolean).join(' · ');
}
$('#acct').onchange = () => { optSummary(); if (!$('#oochk').checked && cur) loadSessions(); };
// the agent CLI picked: its accounts, and only the modes, models, effort and lean option it has
let nAccts = [], nDefs = {};
async function applyBackend() {
  const b = $('#nbackend').value || 'claude', caps = capsOf(b), bk = BACKENDS[b];
  const accts = bk?.accounts?.length ? bk.accounts : b === 'claude' ? nAccts : [];
  const keep = $('#acct').value;
  const def = bk?.defaultAccount; // Settings → Accounts → Set as default
  $('#acct').innerHTML = accts.map((a) => `<option value="${esc(a)}">${esc(a)}${a === def && accts.length > 1 ? ' (default)' : ''}</option>`).join('');
  const last = localStorage.getItem('halay-acct');
  $('#acct').value = accts.includes(keep) ? keep : accts.includes(last) ? last : accts.includes(def) ? def : accts[0];
  for (const o of $('#mode').options) o.disabled = !!caps && !caps.modes.includes(o.value);
  if ($('#mode').selectedOptions[0]?.disabled) $('#mode').value = caps.modes.includes('manual') ? 'manual' : caps.modes[0];
  const claude = b === 'claude';
  // Settings → Agent defaults of this CLI (Claude's are the top-level ones)
  const dd = claude ? nDefs : nDefs.perBackend?.[b] || {};
  const dmode = dd.permissionMode || (claude ? 'auto' : 'manual');
  if (!caps || caps.modes.includes(dmode)) $('#mode').value = dmode;
  fillModelSelect($('#nmodel'), '', dd.model ? `default (${dd.model})` : 'default', claude ? MODELS : [], !claude);
  $('#nmodel').title = bk?.modelHint || '';
  fillEffortSelect($('#neffort'), '', dd.effort ? `default (${dd.effort})` : 'default');
  $('#neffrow').hidden = !!caps && !caps.effort.length; if ($('#neffrow').hidden) $('#neffort').value = '';
  $('#leanrow').hidden = !!caps && !caps.lean; if ($('#leanrow').hidden) $('#leanchk').checked = false; else $('#leanchk').checked = !!ctxCfg.leanDefault;
  optSummary();
  if (!claude) backendModels(b).then((ms) => { if ($('#nbackend').value === b) { fillModelSelect($('#nmodel'), $('#nmodel').value, dd.model ? `default (${dd.model})` : 'default', ms, true); optSummary(); } });
}
$('#nbackend').onchange = async () => { await applyBackend(); if (!$('#oochk').checked && cur) loadSessions(); };
$('#mode').onchange = optSummary; $('#nmodel').onchange = () => otherModel($('#nmodel'), BACKENDS[$('#nbackend').value]?.modelHint).then(optSummary); $('#neffort').onchange = optSummary; $('#leanchk').onchange = optSummary; $('#browchk').onchange = optSummary;
$('#new').onclick = () => go('/new');
async function openNew() {
  const [accts, home, defs, bks] = await Promise.all([accountNames(), api('/fs?path=').catch(() => null), api('/settings/agents').catch(() => ({})), loadBackends()]);
  nAccts = accts; nDefs = defs;
  homeDir = home?.path || '';
  // Settings > Agent defaults: the mode is preselected; '' for model/effort lets the server apply its default
  $('#mode').value = defs.permissionMode || 'auto';
  fillModelSelect($('#nmodel'), '', defs.model ? `default (${defs.model})` : 'default'); fillEffortSelect($('#neffort'), '', defs.effort ? `default (${defs.effort})` : 'default');
  $('#acct').innerHTML = accts.map((a) => `<option>${esc(a)}</option>`).join('');
  $('#oochk').checked = false; newAtts.length = 0; $('#nprompt').value = ''; natt.render(); $('#start').disabled = false; $('#leanchk').checked = !!ctxCfg.leanDefault; setupBrowserOption();
  $('#acct').value = localStorage.getItem('halay-acct') || accts[0]; $('#nopts').open = false;
  // Agent CLI: offered when another one besides Claude is installed
  const usable = bks.filter((b) => b.installed);
  $('#nbackrow').hidden = usable.length < 2;
  $('#nbackend').innerHTML = (usable.length ? usable : [{ id: 'claude', label: 'Claude Code' }]).map((b) => `<option value="${esc(b.id)}">${esc(b.label)}</option>`).join('');
  const lastB = localStorage.getItem('halay-backend');
  $('#nbackend').value = usable.some((b) => b.id === lastB) ? lastB : 'claude';
  await applyBackend();
  $('#npath').value = ''; nsel = 0; showBrowser(false);
  const pd = presetDir; presetDir = null;
  nstep(1); renderRecent();
  $('#dlg').showModal();
  if (pd) await choose(pd); else $('#npath').focus();
}
const newAtts = [];
const natt = attachments({ list: newAtts, tray: $('#ntray'), button: $('#nattach'), input: $('#nfile'), drop: $('#dlg'), paste: $('#nprompt'), path: () => '/uploads', onChange: () => { $('#start').disabled = natt.busy(); } });
$('#cancel').onclick = () => $('#dlg').close();
$('#nprompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#start').click(); } });
$('#start').onclick = async () => {
  try {
    if (natt.busy()) return;
    const bad = natt.failed();
    if (bad.length && !await ask(`${bad.length} attachment(s) failed to upload and will be left out (${bad[0].err}). Start anyway?`, { ok: 'Start anyway' })) return;
    const oneOff = $('#oochk').checked;
    const wt = !oneOff && $('#wtchk').checked && !$('#wtrow').hidden && !sessionId;
    $('#start').disabled = true;
    const a = await api('/agents', { method: 'POST', body: { uploads: newAtts.filter((a) => a.res).map((a) => a.res.id), prompt: $('#nprompt').value.trim() || undefined, ...(oneOff ? { oneOff: true } : { cwd: cur }), permissionMode: $('#mode').value, model: $('#nmodel').value || undefined, effort: $('#neffort').value || undefined, account: $('#acct').value, backend: $('#nbackend').value || undefined, sessionId: oneOff ? null : sessionId, lean: $('#leanchk').checked, browser: $('#browchk').checked, ...(wt ? { worktree: true, branch: $('#wtbranch').value.trim() || undefined } : {}) } });
    localStorage.setItem('halay-acct', $('#acct').value); localStorage.setItem('halay-backend', $('#nbackend').value || 'claude');
    if (!oneOff) localStorage.setItem('halay-last', cur);
    $('#dlg').close();
    agents[a.id] = a; select(a.id);
  } catch (e) { flash(e.message, 'error'); } finally { $('#start').disabled = natt.busy(); }
};
