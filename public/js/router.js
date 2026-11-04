// ---- routing: the URL hash is the source of truth, so refresh/back/forward and shared links restore the view
//   #/a/<id>  #/a/<id>/files/<dir>  #/a/<id>/file/<path>  #/a/<id>/edit/<path>  #/history  #/new  #/term  #/term/<terminal id>
const go = (h) => { location.hash = '#' + h; };
const setHash = (h) => history.replaceState(null, '', location.search + '#' + h); // sync the URL without adding history
const enc = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const select = (id) => go('/a/' + id);

async function showAgent(id) {
  sel = id;
  document.body.classList.add('open');
  for (const k in events) if (k !== id) { delete events[k]; delete hidden[k]; delete pend[k]; } // only the open agent is kept live
  if (!events[id]) {
    $('#main').innerHTML = '<div id="empty">Loading…</div>';
    try { await loadAgent(id); }
    catch (e) {
      if (sel !== id) return;
      $('#main').innerHTML = '<div id="empty">Could not load agent: <span></span><br><br><button id="retry">Retry</button> <button id="eback">← Agents</button></div>';
      $('#empty span').textContent = e.message || String(e);
      $('#retry').onclick = () => showAgent(id); $('#eback').onclick = () => go('/');
      return;
    }
    if (sel !== id) return;
  }
  renderMain();
  markSeen(id);
  renderList();
  sendPresence();
}

let routeSeq = 0; // a route() that was overtaken by a newer navigation must not close the newer route's dialogs
async function route() {
  const mine = ++routeSeq;
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const want = { f: false, h: false, n: false, g: false, x: false, b: false, e: false, p: null };
  if (parts[0] === 'a' && agents[parts[1]]) {
    if (sel !== parts[1]) await showAgent(parts[1]);
    document.body.classList.add('open');
    if (parts[2] === 'files' || parts[2] === 'file') {
      want.f = true;
      const p = parts.slice(3).join('/');
      if (!$('#fdlg').open) $('#fdlg').showModal();
      await (parts[2] === 'file' ? fopen(p) : fbrowse(p)).catch((e) => { flash(e.message, 'error'); setHash('/a/' + sel); $('#fdlg').close(); });
    } else if (parts[2] === 'git') { want.g = true; if (!$('#gdlg').open) await openGit(); }
    else if (parts[2] === 'edit') { want.e = true; await openEditor(parts.slice(3).join('/')); }
  } else if (parts[0] === 'history') { want.h = true; if (!$('#hdlg').open) await openHistory(); }
  else if (parts[0] === 'new') { want.n = true; if (!$('#dlg').open) await openNew(); }
  else if (parts[0] === 'term') { want.x = true; await openTerms(parts[1]); }
  else if (parts[0] === 'browser') { want.b = true; await openBrowser(parts[1]); }
  else if (parts[0] === 'p' && parts[1]) { want.pg = true; await openPluginPage(parts[1], parts[2]); }
  else if (PAGES[parts[0]]) { want.p = parts[0]; if (!$(PAGES[parts[0]]).open) await OPENERS[parts[0]](); }
  else {
    if (parts[0] === 'a') setHash('/'); // unknown or removed agent
    if (sel) { sel = null; renderMain(); renderList(); sendPresence(); }
    else if (!$('#main .welcome')) renderMain(); // first load: replace the static placeholder with the welcome card
    document.body.classList.remove('open');
  }
  if (mine !== routeSeq) return;
  if (!want.f && $('#fdlg').open) $('#fdlg').close();
  if (!want.h && $('#hdlg').open) $('#hdlg').close();
  if (!want.n && $('#dlg').open) $('#dlg').close();
  if (!want.g && $('#gdlg').open) $('#gdlg').close();
  if (!want.x && $('#xdlg').open) $('#xdlg').close();
  if (!want.b && $('#bdlg').open) $('#bdlg').close();
  if (!want.e && $('#edlg').open) $('#edlg').close();
  if (!want.pg && $('#pgdlg').open) $('#pgdlg').close();
  for (const k in PAGES) if (want.p !== k && $(PAGES[k]).open) $(PAGES[k]).close();
  renderList();
}
window.addEventListener('hashchange', route);
const PAGES = { tasks: '#tdlg', approvals: '#adlg', settings: '#sdlg', usage: '#udlg', rooms: '#rmdlg', bots: '#botdlg' };
const OPENERS = {};

// closing a dialog (button, Esc) returns the URL to the page underneath, unless navigation already moved on
for (const [id, tag] of [['#fdlg', '/file'], ['#hdlg', '/history'], ['#dlg', '/new'], ['#tdlg', '/tasks'], ['#adlg', '/approvals'], ['#sdlg', '/settings'], ['#gdlg', '/git'], ['#udlg', '/usage'], ['#xdlg', '/term'], ['#rmdlg', '/rooms'], ['#bdlg', '/browser'], ['#botdlg', '/bots'], ['#edlg', '/edit'], ['#pgdlg', '/p/']])
  $(id).addEventListener('close', () => { if (location.hash.includes(tag)) setHash(sel ? '/a/' + sel : '/'); });

