// ---- code editor: Monaco (VS Code's editor, served from node_modules by /vendor/monaco/, loaded on first use) over the
// agent's folder, through /api/agents/:id/edit/* (editor-fs.js). Lazy file tree, tabs with a dirty marker, Ctrl/Cmd+S
// saves with the etag the file was opened with; a 409 means it changed on disk (the agent edited it) and the banner
// offers reload, compare or overwrite. Open tabs are polled while the editor is visible: an unmodified tab reloads by
// itself, a modified one gets the banner. Tabs live per agent for as long as the page is loaded, so closing the dialog
// loses nothing; leaving the page with unsaved edits asks first. Routes: #/a/<id>/edit and #/a/<id>/edit/<path>.

const ED = {}; // agent id -> { tabs, cur, open (expanded folders), kids (folder -> entries), sel (tree selection), all, hidden }
let monacoP = null, edView = null, diffView = null, ePending = null;
const est = (id = sel) => ED[id] ||= { tabs: [], cur: null, open: new Set(['']), kids: new Map(), sel: null, all: false, hidden: 0 };
const eurl = (id, op, p) => `/agents/${id}/edit/${op}${p != null ? '?path=' + encodeURIComponent(p) : ''}`;
const ecur = (s = est()) => s.tabs.find((t) => t.path === s.cur) || null;
const edirty = (t) => t.model.getAlternativeVersionId() !== t.saved;
const eparent = (p) => p.split('/').slice(0, -1).join('/');
const ejoin = (d, n) => (d ? d + '/' : '') + n;
const eNarrow = matchMedia('(max-width: 700px)');

const loadMonaco = () => monacoP ||= new Promise((resolve, reject) => {
  const s = document.createElement('script'); s.src = '/vendor/monaco/vs/loader.js';
  s.onerror = () => reject(new Error('Could not load the editor (/vendor/monaco). Is monaco-editor installed (npm install)?'));
  s.onload = () => {
    delete window.define?.amd; // UMD scripts loaded later (xterm) would otherwise register as AMD modules instead of globals
    window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
    window.require(['vs/editor/editor.main'], () => resolve(window.monaco), (e) => reject(new Error('Could not load the editor: ' + (e?.message || e))));
  };
  document.head.append(s);
}).then(setupMonaco).catch((e) => { monacoP = null; throw e; });

function setupMonaco(monaco) {
  // files are opened one by one, without their project: type errors from unresolved imports would be noise
  for (const d of [monaco.languages.typescript?.typescriptDefaults, monaco.languages.typescript?.javascriptDefaults]) d?.setDiagnosticsOptions?.({ noSemanticValidation: true });
  eTheme();
  const host = $('#ehost'), code = mk('div'), dv = mk('div');
  code.id = 'ecode'; dv.id = 'ediffv'; dv.hidden = true; host.append(code, dv);
  const opts = { automaticLayout: true, fontSize: 13, scrollBeyondLastLine: false, fixedOverflowWidgets: true, renderWhitespace: 'selection', ...eNarrowOpts() };
  edView = monaco.editor.create(code, { ...opts, model: null });
  diffView = monaco.editor.createDiffEditor(dv, { ...opts, originalEditable: false, renderSideBySide: !eNarrow.matches });
  return monaco;
}
const eNarrowOpts = () => (eNarrow.matches ? { minimap: { enabled: false }, wordWrap: 'on', lineNumbersMinChars: 3, folding: false, glyphMargin: false } : { minimap: { enabled: true }, wordWrap: 'off', lineNumbersMinChars: 5, folding: true });
eNarrow.addEventListener('change', () => { edView?.updateOptions(eNarrowOpts()); diffView?.updateOptions({ renderSideBySide: !eNarrow.matches }); eTreeShow(!eNarrow.matches); });

// theme follows the app (theme.js sets data-theme on <html>, or the system scheme decides): Monaco's own light/dark with
// the app's background
function eTheme() {
  if (!window.monaco?.editor) return;
  const cs = getComputedStyle(document.documentElement), bg = cs.getPropertyValue('--bg').trim(), dark = cs.colorScheme === 'dark';
  const name = dark ? 'swarm-dark' : 'swarm-light';
  monaco.editor.defineTheme(name, { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: /^#[0-9a-f]{6}$/i.test(bg) ? { 'editor.background': bg, 'editorGutter.background': bg, 'minimap.background': bg } : {} });
  monaco.editor.setTheme(name);
}
new MutationObserver(eTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', eTheme);
document.addEventListener('halay:theme', eTheme); // colour theme changed in Settings (js/theme.js)

// ---- opening (router.js), and the ways in: header button, Files dialog, the viewer's Edit, Ctrl/Cmd+click on a path
async function openEditor(p) {
  const id = sel, s = est(id);
  $('#ehead').textContent = 'Editor · ' + agents[id].name;
  if (!$('#edlg').open) { $('#edlg').showModal(); eFit(); eTreeShow(!eNarrow.matches || (!p && !ePending && !s.tabs.length)); }
  renderTabs(); eStatus();
  if (!s.kids.has('')) eLoadDir(id, '').then(() => sel === id && renderTree()).catch((e) => { $('#etlist').textContent = e.message; });
  else renderTree();
  if (!window.monaco?.editor) {
    $('#eempty').hidden = false; $('#eempty').textContent = 'Loading the editor…';
    try { await loadMonaco(); } catch (e) { $('#eempty').textContent = e.message; return; }
    if (sel !== id) return;
  }
  const want = ePending || p; ePending = null;
  if (want && want !== s.cur) await openTab(want);
  else eShowTab(s.cur);
}
function editPath(p) { if ($('#edlg').open) return openTab(p); ePending = p; go(`/a/${sel}/edit`); }

// ---- tree: one folder per request, expanded folders kept per agent
async function eLoadDir(id, dir) {
  const s = est(id), r = await api(eurl(id, 'list', dir) + (s.all ? '&all=1' : ''));
  s.kids.set(dir, r.entries);
  if (!dir) s.hidden = r.hidden;
}
async function eRefreshTree(id = sel) {
  const s = est(id), dirs = [...s.open];
  s.kids = new Map();
  await Promise.all(dirs.map((d) => eLoadDir(id, d).catch(() => { if (d) s.open.delete(d); })));
  if (sel === id) renderTree();
}
function renderTree() {
  const s = est(), l = $('#etlist'), st = l.scrollTop;
  l.innerHTML = '';
  const walk = (dir, depth) => {
    for (const e of s.kids.get(dir) || []) {
      const p = ejoin(dir, e.name), isDir = e.type === 'dir', open = isDir && s.open.has(p);
      const row = mk('div', 'etrow' + (s.sel?.path === p ? ' on' : '') + (e.outside || e.broken ? ' out' : '') + (s.tabs.some((t) => t.path === p && edirty(t)) ? ' dirty' : ''));
      row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', depth + 1); row.setAttribute('aria-selected', String(s.sel?.path === p)); row.tabIndex = 0;
      if (isDir) row.setAttribute('aria-expanded', String(open));
      row.style.paddingLeft = 6 + depth * 14 + 'px';
      row.innerHTML = (isDir ? icon(open ? 'chevron-down' : 'chevron-right', 'ech') : '<span class="ech"></span>') + icon(isDir ? (open ? 'folder-open' : 'folder') : 'file', 'eic') + '<span class="etn"></span>';
      row.querySelector('.etn').textContent = e.name;
      row.title = e.outside ? p + " (a link to outside the agent's folder)" : e.broken ? p + ' (broken link)' : p;
      row.onclick = () => eTreeClick(p, e);
      row.onkeydown = (k) => {
        if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); row.click(); }
        else if (k.key === 'ArrowDown' || k.key === 'ArrowUp') { k.preventDefault(); (k.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling)?.focus(); }
      };
      l.append(row);
      if (open) { if (s.kids.has(p)) walk(p, depth + 1); else l.append(Object.assign(mk('div', 'etrow mutl', 'Loading…'), { style: `padding-left:${20 + (depth + 1) * 14}px` })); }
    }
  };
  walk('', 0);
  if (s.kids.has('') && !s.kids.get('').length) l.append(mk('div', 'etrow mutl', 'This folder is empty.'));
  if (!s.all && s.hidden) l.append(mk('div', 'etnote mutl', `${s.hidden} hidden (.git, node_modules): the eye button shows them`));
  l.scrollTop = st;
  $('#ehid').setAttribute('aria-pressed', String(s.all)); $('#ehid').innerHTML = icon(s.all ? 'eye' : 'eye-off');
}
async function eTreeClick(p, e) {
  const id = sel, s = est(id);
  s.sel = { path: p, type: e.type };
  if (e.outside || e.broken) { renderTree(); return flash(e.broken ? 'This link is broken.' : "This link points outside the agent's folder, so it can't be opened here.", 'error'); }
  if (e.type === 'file') { renderTree(); if (eNarrow.matches) eTreeShow(false); return openTab(p); }
  if (s.open.has(p)) s.open.delete(p); else s.open.add(p);
  renderTree();
  if (s.open.has(p) && !s.kids.has(p)) { try { await eLoadDir(id, p); } catch (x) { s.open.delete(p); flash(x.message, 'error'); } if (sel === id) renderTree(); }
}
async function eReveal(id, p) { // expand the folders above an opened file and select it
  const s = est(id); let d = '';
  for (const seg of p.split('/').slice(0, -1)) { d = ejoin(d, seg); s.open.add(d); if (!s.kids.has(d)) await eLoadDir(id, d).catch(() => {}); }
  s.sel = { path: p, type: 'file' };
  if (sel !== id) return;
  renderTree();
  $('#etlist .etrow.on')?.scrollIntoView({ block: 'nearest' });
}

// tree actions: new file / folder go into the selected folder (or the selected file's folder)
const eTargetDir = (s) => (!s.sel ? '' : s.sel.type === 'dir' ? s.sel.path : eparent(s.sel.path));
async function eCreate(type) {
  const id = sel, s = est(id), dir = eTargetDir(s);
  const name = await askText(`New ${type === 'dir' ? 'folder' : 'file'} in /${dir}`, '', 'Create');
  if (!name) return;
  try {
    const r = await api(`/agents/${id}/edit/create`, { method: 'POST', body: { path: ejoin(dir, name), type } });
    if (dir) s.open.add(dir);
    s.sel = { path: r.path, type: r.type };
    await eRefreshTree(id);
    if (type !== 'dir') await openTab(r.path);
  } catch (e) { flash(e.message, 'error'); }
}
async function eRename() {
  const id = sel, s = est(id), it = s.sel;
  if (!it) return flash('Select a file or folder first.', 'info');
  const name = await askText('Rename ' + it.path, it.path.split('/').pop(), 'Rename');
  if (!name || name === it.path.split('/').pop()) return;
  const to = ejoin(eparent(it.path), name);
  try { await api(`/agents/${id}/edit/rename`, { method: 'POST', body: { from: it.path, to } }); } catch (e) { return flash(e.message, 'error'); }
  const moved = (p) => (p === it.path ? to : p.startsWith(it.path + '/') ? to + p.slice(it.path.length) : null);
  s.open = new Set([...s.open].map((p) => moved(p) || p));
  for (const t of s.tabs) { const np = moved(t.path); if (np) eRetarget(id, t, np); }
  s.sel = { path: to, type: it.type };
  await eRefreshTree(id);
  if (sel === id) eShowTab(s.cur);
}
async function eDelete() {
  const id = sel, s = est(id), it = s.sel;
  if (!it) return flash('Select a file or folder first.', 'info');
  if (!await ask(`Delete ${it.path}${it.type === 'dir' ? ' and everything in it' : ''}? This can't be undone here.`, { ok: 'Delete', danger: true })) return;
  try { await api(`/agents/${id}/edit/delete`, { method: 'POST', body: { path: it.path } }); } catch (e) { return flash(e.message, 'error'); }
  for (const t of [...s.tabs]) if (t.path === it.path || t.path.startsWith(it.path + '/')) { if (edirty(t)) t.disk = { missing: true }; else eDropTab(id, t); }
  s.sel = null;
  await eRefreshTree(id);
  if (sel === id) { renderTabs(); eShowTab(s.cur); }
}
$('#enewf').onclick = () => eCreate('file');
$('#enewd').onclick = () => eCreate('dir');
$('#eren').onclick = eRename;
$('#edel').onclick = eDelete;
$('#erefresh').onclick = () => eRefreshTree().catch((e) => flash(e.message, 'error'));
$('#ehid').onclick = () => { const s = est(); s.all = !s.all; eRefreshTree().catch((e) => flash(e.message, 'error')); };

// a small prompt in the style of ask(); resolves the trimmed text, or '' when cancelled
function askText(text, value = '', ok = 'OK') {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'ask';
    d.innerHTML = '<form method="dialog"><p></p><input class="fld" type="text" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"><div class="row"><span style="flex:1"></span><button type="button" class="no">Cancel</button><button class="yes primary"></button></div></form>';
    d.querySelector('p').textContent = text;
    d.querySelector('.yes').textContent = ok;
    const inp = d.querySelector('input'); inp.value = value; inp.setAttribute('aria-label', text);
    let answer = '';
    d.querySelector('form').onsubmit = () => { answer = inp.value.trim(); };
    d.querySelector('.no').onclick = () => d.close();
    d.addEventListener('close', () => { d.remove(); resolve(answer); });
    document.body.append(d);
    d.showModal();
    inp.focus(); const dot = value.lastIndexOf('.'); inp.setSelectionRange(0, dot > 0 ? dot : value.length);
  });
}

// ---- tabs: one Monaco model per open file (language from the file name), dirty = edited since the last load or save
const eUri = (id, p) => monaco.Uri.from({ scheme: 'file', path: '/' + id + '/' + p });
function eTab(id, r) {
  const t = { path: r.path, etag: r.etag, mtime: r.mtime, size: r.size, readonly: r.readonly, disk: null, view: null, model: monaco.editor.createModel(r.content, undefined, eUri(id, r.path)) };
  t.saved = t.model.getAlternativeVersionId();
  eWatch(id, t);
  return t;
}
function eWatch(id, t) { // t.was: the dirty state last drawn; whoever moves t.saved resets it and redraws
  t.was = edirty(t);
  t.model.onDidChangeContent(() => { const d = edirty(t); if (d !== t.was) { t.was = d; if (sel === id) { renderTabs(); eStatus(); renderTree(); } edMark(); } });
}
function eRetarget(id, t, np) { // renamed on disk: same text and dirty state under the new name (and maybe a new language)
  const s = est(id), d = edirty(t), m = monaco.editor.createModel(t.model.getValue(), undefined, eUri(id, np)), cur = s.cur === t.path;
  if (cur && edView.getModel() === t.model) edView.setModel(m);
  t.model.dispose(); t.model = m; t.path = np; t.saved = d ? -1 : m.getAlternativeVersionId(); t.view = null;
  if (cur) s.cur = np;
  eWatch(id, t);
}
async function openTab(p) {
  const id = sel, s = est(id);
  let t = s.tabs.find((x) => x.path === p);
  if (!t) {
    let r;
    try { r = await api(eurl(id, 'file', p)); }
    catch (e) {
      if (e.data?.tooLarge || e.data?.binary) { flash((e.data.binary ? 'Binary file' : 'Larger than 2 MB') + ': opened in the viewer instead', 'info'); return openViewer(p); }
      return flash(e.message, 'error');
    }
    if (!window.monaco?.editor || sel !== id) return;
    t = s.tabs.find((x) => x.path === r.path); // an absolute path came back relative and is already open
    if (!t) { t = eTab(id, r); s.tabs.push(t); }
  }
  if (sel !== id) return;
  eShowTab(t.path);
  eReveal(id, t.path);
}
function eShowTab(p) {
  const s = est(), t = s.tabs.find((x) => x.path === p) || s.tabs.at(-1) || null, prev = ecur(s);
  if (!edView) return;
  if (prev && edView.getModel() === prev.model) prev.view = edView.saveViewState();
  eDiffOff();
  s.cur = t?.path || null;
  edView.setModel(t?.model || null);
  $('#ecode').hidden = !t; $('#eempty').hidden = !!t;
  $('#eempty').textContent = eNarrow.matches ? 'Open the file list (top left) and pick a file.' : 'Pick a file on the left.';
  if (t) {
    if (t.view) edView.restoreViewState(t.view);
    edView.updateOptions({ readOnly: t.readonly });
    if (!eNarrow.matches) edView.focus();
  }
  setHash(`/a/${sel}/edit` + (t ? '/' + enc(t.path) : ''));
  renderTabs(); eStatus();
}
async function closeTab(t) {
  const id = sel;
  if (edirty(t) && !await ask(`Close ${t.path}? Your unsaved changes are lost.`, { ok: 'Discard changes', danger: true })) return;
  eDropTab(id, t);
  if (sel === id) eShowTab(est(id).cur);
}
function eDropTab(id, t) {
  const s = est(id), i = s.tabs.indexOf(t);
  if (i < 0) return;
  s.tabs.splice(i, 1);
  if (s.cur === t.path) s.cur = (s.tabs[i] || s.tabs[i - 1])?.path || null;
  if (edView?.getModel() === t.model) edView.setModel(null);
  t.model.dispose();
  edMark();
}
function renderTabs() {
  const s = est(), bar = $('#etabs');
  bar.innerHTML = '';
  for (const t of s.tabs) {
    const d = edirty(t), w = mk('div', 'etab' + (t.path === s.cur ? ' on' : '') + (d ? ' dirty' : ''));
    const b = mk('button', 'et'); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(t.path === s.cur)); b.title = t.path + (d ? ' (unsaved)' : '');
    b.innerHTML = (d ? '<span class="edot" aria-label="unsaved">●</span>' : '') + '<span></span>'; b.lastChild.textContent = t.path.split('/').pop();
    b.onclick = () => eShowTab(t.path);
    const x = mk('button', 'ex'); x.innerHTML = icon('x'); x.setAttribute('aria-label', 'Close ' + t.path); x.title = 'Close';
    x.onclick = () => closeTab(t);
    w.onauxclick = (e) => { if (e.button === 1) closeTab(t); };
    w.append(b, x); bar.append(w);
  }
  bar.hidden = !s.tabs.length;
  bar.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function eStatus() { // subtitle, Save / Diff buttons, banner
  const s = est(), t = ecur(s);
  $('#esub').textContent = t ? t.path + ' · ' + (t.model.getLanguageId?.() || 'text') + (t.readonly ? ' · read-only' : '') : agents[sel]?.cwd || '';
  $('#esave').disabled = !t || t.readonly || (!edirty(t) && !t.disk);
  $('#ediff').hidden = !t;
  renderBanner();
}
// the agent's header button shows a dot while that agent has unsaved files
function edMark() { const b = $('#editb'); if (b) b.classList.toggle('dirty', !!ED[sel]?.tabs.some(edirty)); }

// ---- saving, conflicts, reload
async function eSave(force = false) {
  const id = sel, t = ecur(est(id));
  if (!t || t.readonly || t.saving || (!force && !edirty(t) && !t.disk)) return;
  t.saving = true;
  const alt = t.model.getAlternativeVersionId();
  try {
    const r = await api(`/agents/${id}/edit/file`, { method: 'PUT', body: { path: t.path, content: t.model.getValue(), etag: t.etag, force } });
    Object.assign(t, { etag: r.etag, mtime: r.mtime, size: r.size, saved: alt, disk: null }); t.was = edirty(t);
    eDiffOff(true);
    flash('Saved ' + t.path, 'ok');
  } catch (e) {
    if (e.status === 409) t.disk = e.data?.missing ? { missing: true } : { etag: e.data?.etag, mtime: e.data?.mtime };
    else flash(e.message, 'error');
  } finally {
    t.saving = false;
    if (sel === id) { renderTabs(); eStatus(); renderTree(); }
    edMark();
  }
}
function eApply(t, r) { // put the disk version into the model as one undoable edit, keeping the scroll position
  const view = edView?.getModel() === t.model ? edView.saveViewState() : null;
  t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text: r.content }], () => null);
  t.model.pushStackElement();
  Object.assign(t, { etag: r.etag, mtime: r.mtime, size: r.size, readonly: r.readonly, saved: t.model.getAlternativeVersionId(), disk: null, was: false });
  if (view) { edView.restoreViewState(view); edView.updateOptions({ readOnly: t.readonly }); }
}
async function eReload(t) {
  const id = sel;
  try { const r = await api(eurl(id, 'file', t.path)); eApply(t, r); eDiffOff(); }
  catch (e) { return flash(e.message, 'error'); }
  if (sel === id) { renderTabs(); eStatus(); renderTree(); }
  edMark();
}
function renderBanner() {
  const t = ecur(), b = $('#ebanner');
  b.innerHTML = ''; b.hidden = !t?.disk;
  if (!t?.disk) return;
  const btn = (label, f, cls = '') => { const x = mk('button', cls, label); x.onclick = f; b.append(x); };
  b.append(mk('span', '', t.disk.missing ? 'This file was deleted or moved on disk.' : edirty(t) ? 'This file changed on disk (the agent may have edited it) and you have unsaved changes.' : 'This file changed on disk.'));
  if (t.disk.missing) { btn('Save to recreate it', () => eSave(true), 'primary'); btn('Close tab', () => closeTab(t)); return; }
  btn('Reload from disk', async () => { if (!edirty(t) || await ask('Reload from disk? Your unsaved changes are replaced (Undo brings them back).', { ok: 'Reload', danger: true })) eReload(t); });
  btn('Compare', () => eDiff('disk'));
  btn('Overwrite with mine', () => eSave(true), 'danger');
}

// ---- live awareness: poll the mtime of open tabs while the editor is visible (cheap stat; the file is only fetched when
// it changed). Unmodified tabs reload, modified ones get the banner.
async function ePoll() {
  const id = sel, s = ED[id];
  if (!$('#edlg').open || document.hidden || !s?.tabs.length || s.polling || !window.monaco?.editor) return;
  s.polling = true;
  let changed = false;
  try {
    const { stats } = await api(`/agents/${id}/edit/stat`, { method: 'POST', body: { paths: s.tabs.map((t) => t.path) } });
    for (const t of [...s.tabs]) {
      const st = stats[t.path];
      if (!st || st.error || t.saving || !s.tabs.includes(t)) continue;
      if (st.missing) { if (!t.disk?.missing) { t.disk = { missing: true }; changed = true; } continue; }
      if (st.mtime === t.mtime && st.size === t.size && !t.disk?.missing) continue;
      const r = await api(eurl(id, 'file', t.path)).catch(() => null);
      if (!r || t.saving) continue;
      changed = true;
      if (r.etag === t.etag) { Object.assign(t, { mtime: r.mtime, size: r.size }); if (t.disk?.missing) t.disk = null; }
      else if (!edirty(t)) eApply(t, r);
      else { t.disk = { etag: r.etag, mtime: r.mtime }; Object.assign(t, { mtime: r.mtime, size: r.size }); }
    }
  } catch (e) { console.warn('editor: checking files on disk failed:', e); ePollGap = Math.min(30000, ePollGap * 2); } finally { s.polling = false; }
  if (changed) ePollGap = 2500; else ePollGap = Math.min(10000, Math.round(ePollGap * 1.3)); // back off while nothing happens
  if (!changed) return;
  if (sel === id && $('#edlg').open) { renderTabs(); eStatus(); renderTree(); }
  edMark();
}
let ePollGap = 2500;
(function ePollLoop() { // only while the editor is open and the tab visible; the gap grows when idle or failing
  const live = $('#edlg').open && !document.hidden;
  (live ? ePoll() : Promise.resolve()).finally(() => setTimeout(ePollLoop, live ? ePollGap : 2500));
})();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { ePollGap = 2500; ePoll(); } });

// ---- diff view (Monaco's diff editor): the tab against git HEAD, or against the disk version after a conflict
let eDiffOrig = null;
async function eDiff(kind) {
  const id = sel, t = ecur(est(id));
  if (!t || !diffView) return;
  if (eDiffOrig && eDiffOrig.kind === kind) return eDiffOff();
  let r;
  try { r = await api(eurl(id, kind === 'head' ? 'head' : 'file', t.path)); } catch (e) { return flash(e.message, 'error'); }
  if (sel !== id || ecur() !== t) return;
  eDiffOff();
  const orig = monaco.editor.createModel(r.content, t.model.getLanguageId());
  eDiffOrig = { kind, model: orig, tab: t };
  diffView.setModel({ original: orig, modified: t.model });
  $('#ecode').hidden = true; $('#ediffv').hidden = false;
  $('#ediff').setAttribute('aria-pressed', 'true');
  $('#ediff span').textContent = kind === 'head' ? 'Diff: HEAD' : 'Diff: disk';
}
function eDiffOff(onlyDisk) {
  if (!eDiffOrig || (onlyDisk && eDiffOrig.kind !== 'disk')) return;
  diffView.setModel(null); eDiffOrig.model.dispose(); eDiffOrig = null;
  $('#ediffv').hidden = true; $('#ecode').hidden = !ecur();
  $('#ediff').setAttribute('aria-pressed', 'false'); $('#ediff span').textContent = 'Diff';
}
$('#ediff').onclick = () => eDiff(eDiffOrig?.kind === 'disk' ? 'disk' : 'head');

// ---- dialog: layout, keys, leaving
$('#esave').onclick = () => eSave();
$('#edlg').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); eSave(); } }, true);
$('#edlg').addEventListener('cancel', (e) => { if (document.activeElement?.closest('.monaco-editor')) e.preventDefault(); }); // Esc closes Monaco's widgets, not the editor
$('#edlg').addEventListener('close', () => { const n = ED[sel]?.tabs.filter(edirty).length; if (n) flash(plural(n, 'unsaved file') + ' stay open in the editor', 'info'); edMark(); });
window.addEventListener('beforeunload', (e) => { if (Object.values(ED).some((s) => s.tabs.some(edirty))) { e.preventDefault(); e.returnValue = ''; } });

// the file list: a column on wide screens (the button hides it), a drawer over the editor on phones
function eTreeShow(on) {
  const d = $('#edlg');
  d.classList.toggle('notree', !on); d.classList.toggle('drawer', on && eNarrow.matches);
  $('#escrim').hidden = !(on && eNarrow.matches);
  $('#etreeb').setAttribute('aria-expanded', String(on));
}
$('#etreeb').onclick = () => eTreeShow($('#edlg').classList.contains('notree'));
$('#escrim').onclick = () => eTreeShow(false);
// phones: follow the visual viewport so the keyboard doesn't cover the editor (as the terminal does)
function eFit() {
  const d = $('#edlg'), vv = window.visualViewport;
  if (!d.open || !vv || !eNarrow.matches) { d.style.removeProperty('--vvh'); d.style.removeProperty('--vvt'); return; }
  d.style.setProperty('--vvh', vv.height + 'px'); d.style.setProperty('--vvt', vv.offsetTop + 'px');
}
window.visualViewport?.addEventListener('resize', eFit);
window.visualViewport?.addEventListener('scroll', eFit);
