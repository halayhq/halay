function renderMain() {
  const a = agents[sel];
  if (!a) return renderWelcome();
  $('#main').innerHTML = `
    <div id="head"><button id="back" class="hb" aria-label="Back to agents">${icon('arrow-left')}</button><div class="t"><b></b><small><span class="hacct"></span><span class="hcwd"></span></small></div>
      <div id="hact"><select id="pm" title="Permission mode" aria-label="Permission mode"></select><button id="files" class="hb" title="Browse the agent's folder">${icon('folder')}<span>Files</span></button><button id="editb" class="hb" title="Code editor for the agent's folder">${icon('code')}<span>Editor</span></button><button id="gitb" class="hb" title="Git: changes, commits, worktree">${icon('git-branch')}<span>Git</span></button><button id="termb" class="hb" title="Terminal in the agent's folder"${termOn() ? '' : ' hidden'}>${icon('terminal')}<span>Terminal</span></button><button id="browb" class="hb" title="Watch and take over this agent's browser"${a.browser ? '' : ' hidden'}>${icon('globe')}<span>Browser</span></button><span id="ctxbox"></span><button id="ubtn" class="hb uchip" popovertarget="upop" aria-haspopup="dialog" hidden></button></div>
      <button id="more" class="hb" popovertarget="hmenu" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">${icon('ellipsis')}</button>
      <div id="hmenu" class="menu" role="menu" aria-label="Agent actions" popover>
        <button id="cprompt" role="menuitem" hidden>${icon('file-text')}<span>Prompt</span></button>
        <label class="mi">${icon('sparkles')}<span>Model</span><select id="hmodel" aria-label="Model for this agent"></select></label>
        <label class="mi" id="heffw">${icon('zap')}<span>Effort</span><select id="heffort" aria-label="Effort for this agent"></select></label>
        <label id="cacctw" class="mi" hidden>${icon('user')}<span>Account</span><select id="cacct" aria-label="Claude account the conductor runs as"></select></label>
        <button id="rc" role="menuitem">${icon('radio')}<span>Remote: off</span></button>
        <a id="rclink" role="menuitem" target="_blank" rel="noopener" hidden>${icon('external-link')}<span>Open in Claude</span></a>
        <button id="hand" role="menuitem">${icon('refresh-cw')}<span>Fresh context + handoff</span></button>
        <button id="ctx" role="menuitem" title="Forget the conversation and start a fresh Claude session">${icon('rotate-ccw')}<span>New context</span></button>
        <hr>
        <button id="del" role="menuitem" class="red">${icon('trash-2')}<span>Remove</span></button>
      </div>
      <div id="upop" class="menu upop" role="dialog" aria-label="Usage" popover><div id="upbody"></div><div id="uline" hidden></div></div></div>
    <div id="wd" hidden></div>
    <details id="todos" open hidden><summary></summary><ul></ul></details>
    <div id="log"></div>
    <div id="jumpw"><button id="jump" title="Jump to latest" aria-label="Jump to latest" hidden>${icon('arrow-down')}<span class="n" hidden></span></button></div>
    <div id="busy" hidden>${icon('clock')}<span>The agent is working: your message is read after its current step.</span></div>
    <div id="stopped" hidden>${icon('circle-stop')}<span>Not running: it starts with your next message.</span><button id="startp" title="Start its process now, resuming its session, without sending a message (e.g. to pick up an update)">${icon('play')}<span>Start now</span></button></div>
    <div class="atray" id="atray" hidden></div>
    <div id="bar"><button id="attach" title="Attach files" aria-label="Attach files">${icon('paperclip')}</button><input type="file" id="afile" multiple hidden><textarea id="txt" placeholder="Message the agent…" aria-label="Message"></textarea><button id="stop" title="Stop the agent (interrupt)" aria-label="Stop" hidden>${icon('square')}</button><button class="primary" id="go" title="Send (Enter)" aria-label="Send">${icon('send')}</button></div>`;
  headTitle();
  setupMenus();
  $('#rc').onclick = () => api(`/agents/${sel}/remote`, { method: 'POST', body: { enabled: agents[sel].remote.status === 'off' || agents[sel].remote.status === 'error' } }).catch((e) => flash(e.message, 'error'));
  updateRemote();
  renderTodos();
  $('#pm').innerHTML = $('#mode').innerHTML.replace(/ \(.*?\)/g, '');
  $('#pm').value = a.permissionMode === 'default' ? 'manual' : a.permissionMode;
  applyHeadCaps();
  $('#pm').onchange = () => api(`/agents/${sel}/mode`, { method: 'POST', body: { permissionMode: $('#pm').value } }).catch((e) => { flash(e.message, 'error'); $('#pm').value = agents[sel].permissionMode; });
  // model and effort: applied by restarting the idle agent's process, which resumes its session (bots: on the Bots page)
  fillHeadModel(); fillEffortSelect($('#heffort'), a.effort);
  $('#hmodel').disabled = $('#heffort').disabled = !!a.bot;
  $('#hmodel').title = $('#heffort').title = a.bot ? 'A bot: change it on the Bots page' : 'Applies from the next message (the session is resumed)';
  const setMdl = (body, el, was) => api(`/agents/${sel}/model`, { method: 'POST', body }).then(() => flash('Applies from the next message', 'ok')).catch((e) => { flash(e.message, 'error'); el.value = was || ''; });
  $('#hmodel').onchange = async () => { if (await otherModel($('#hmodel'), BACKENDS[agents[sel].backend]?.modelHint)) setMdl({ model: $('#hmodel').value }, $('#hmodel'), agents[sel].model); };
  $('#heffort').onchange = () => setMdl({ effort: $('#heffort').value }, $('#heffort'), agents[sel].effort);
  $('#files').onclick = openFiles;
  $('#editb').onclick = () => go(`/a/${sel}/edit`);
  edMark();
  $('#gitb').onclick = () => go(`/a/${sel}/git`);
  $('#termb').onclick = () => termForAgent(sel);
  $('#browb').onclick = () => go('/browser/' + agents[sel].browser);
  renderBrowserBtn();
  $('#ctx').onclick = async () => {
    if (!await ask('Start a fresh context? The agent forgets the conversation so far; the chat above stays for reference.', { ok: 'Start fresh', danger: true })) return;
    try { await api(`/agents/${sel}/reset`, { method: 'POST' }); } catch (e) { flash(e.message, 'error'); }
  };
  $('#hand').onclick = () => refreshWithHandoff(sel);
  $('#cacctw').hidden = a.role !== 'conductor';
  if (a.role === 'conductor') accountNames().then((accts) => {
    $('#cacct').innerHTML = accts.map((n) => `<option>${esc(n)}</option>`).join('');
    $('#cacct').value = agents[sel]?.account;
  });
  $('#cacct').onchange = async () => {
    const was = agents[sel].account, to = $('#cacct').value;
    $('#hmenu').hidePopover?.();
    if (!await ask(`Run the conductor as ${to}? Sessions belong to an account, so this starts a fresh context; the chat above stays for reference.`, { ok: `Switch to ${to}` })) return ($('#cacct').value = was);
    try { await api('/conductor/account', { method: 'POST', body: { account: to } }); localStorage.setItem('halay-acct', to); } catch (e) { flash(e.message, 'error'); $('#cacct').value = was; }
  };
  $('#cprompt').hidden = a.role !== 'conductor';
  $('#del').hidden = a.role === 'conductor'; // the swarm chat can't be removed
  $('#cprompt').onclick = async () => { $('#ptext').value = (await api('/conductor/prompt')).prompt; $('#pdlg').showModal(); };
  $('#back').onclick = () => go('/');
  $('#stop').onclick = async () => {
    const b = $('#stop'); b.disabled = true;
    try { await api(`/agents/${sel}/interrupt`, { method: 'POST' }); } catch (e) { flash(e.message, 'error'); } finally { b.disabled = false; }
  };
  $('#startp').onclick = async () => {
    const b = $('#startp'); b.disabled = true;
    try { await api(`/agents/${sel}/start`, { method: 'POST' }); } catch (e) { flash(e.message, 'error'); } finally { b.disabled = false; }
  };
  $('#del').onclick = async () => {
    const wt = agents[sel]?.worktree;
    if (!await ask(agents[sel]?.oneOff ? 'Remove this agent? Its one-off folder is deleted; the conversation is kept in History.' : wt ? `Remove this agent? Its tmp folder and worktree are deleted; branch ${wt.branch} stays in the repository.` : 'Remove this agent?', { ok: 'Remove', danger: true })) return;
    try { await api('/agents/' + sel, { method: 'DELETE' }); }
    catch (e) {
      if (e.status === 409 && e.data?.worktree && await ask(e.message + '. Remove the agent anyway and lose them? (Committed work stays on branch ' + e.data.worktree.branch + '.)', { ok: 'Remove and discard', danger: true }))
        await api('/agents/' + sel + '?discard=1', { method: 'DELETE' }).catch((x) => flash(x.message, 'error'));
      else if (e.status === 409 && e.data?.oneOff && await ask(e.message + '. Remove the agent anyway?', { ok: 'Remove', danger: true }))
        await api('/agents/' + sel + '?discard=1', { method: 'DELETE' }).catch((x) => flash(x.message, 'error'));
      else if (e.status !== 409) flash(e.message, 'error');
    }
  };
  const aid = sel, list = chatAtts[aid] ||= [], tray = $('#atray');
  const att = attachments({ list, tray, button: $('#attach'), input: $('#afile'), drop: $('#main'), paste: $('#txt'), path: () => `/agents/${aid}/upload`, onChange: () => { if (sel !== aid || !$('#atray')?.isSameNode(tray)) return; $('#go').disabled = att.busy(); updComposer(); } });
  $('#go').disabled = att.busy();
  const send = async () => {
    const t = $('#txt').value.trim();
    if (att.busy()) return;
    const bad = att.failed();
    if (bad.length && !await ask(`${bad.length} attachment(s) failed to upload and will be left out (${bad[0].err}). Send anyway?`, { ok: 'Send anyway' })) return;
    const files = list.filter((a) => a.res).map((a) => a.res.path);
    if (!t && !files.length) return;
    $('#txt').value = ''; list.length = 0; att.render(); updComposer();
    const text = files.length ? [t, 'Attached files: ' + files.join(', ')].filter(Boolean).join('\n\n') : t;
    try { await api(`/agents/${aid}/send`, { method: 'POST', body: { text } }); }
    catch (e) { flash(e.message, 'error'); if (sel === aid && !$('#txt').value) { $('#txt').value = t; updComposer(); } }
  };
  $('#go').onclick = send;
  $('#txt').onkeydown = (e) => { // touch keyboards: Enter is a newline (send button or Cmd/Ctrl+Enter sends)
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (matchMedia('(pointer: coarse)').matches && !e.metaKey && !e.ctrlKey) return;
    e.preventDefault(); send();
  };
  $('#txt').oninput = updComposer;
  unread = 0;
  $('#log').addEventListener('scroll', updJump, { passive: true });
  $('#jump').onclick = () => { $('#log').scrollTo({ top: $('#log').scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
  renderLog();
  renderAgentExtras();
  queueMicrotask(updComposer); // after rerender() has put back what you were typing
  scroll();
  afterRender();
}

// name (with the conductor's icon), then "account · folder" as one muted line
// the selected agent's model picker: its CLI's models (Claude's aliases, else the list the backend gives)
function fillHeadModel() {
  const a = agents[sel]; if (!a || !$('#hmodel')) return;
  const b = a.backend || 'claude';
  if (b === 'claude') return fillModelSelect($('#hmodel'), a.model);
  fillModelSelect($('#hmodel'), a.model, 'default', [], true);
  backendModels(b).then((ms) => { if (agents[sel] === a && $('#hmodel') && document.activeElement !== $('#hmodel')) fillModelSelect($('#hmodel'), agents[sel].model, 'default', ms, true); });
}
// what the header offers, by what the agent's CLI can do (modes, effort, Remote Control)
function applyHeadCaps() {
  const a = agents[sel]; if (!a || !$('#pm')) return;
  loadBackends().then(() => {
    const caps = capsOf(a.backend); if (!caps || agents[sel] !== a) return;
    for (const o of $('#pm').options) { o.disabled = !caps.modes.includes(o.value); o.title = o.disabled ? `Not available for ${backendLabel(a.backend)}` : ''; }
    $('#heffw').hidden = !caps.effort.length;
    $('#rc').hidden = !caps.remoteControl;
  });
}

function headTitle() {
  const a = agents[sel]; if (!a || !$('#head')) return;
  $('#head .t b').innerHTML = (a.role === 'conductor' ? icon('compass') : '') + '<span></span>';
  $('#head .t b span').textContent = a.name;
  const mdl = [shortModel(a.model), a.effort && 'effort ' + a.effort].filter(Boolean).join(' ');
  const be = a.backend && a.backend !== 'claude' && a.account !== a.backend ? backendLabel(a.backend) + ' · ' : ''; // an alias doesn't say which CLI it is
  $('#head .hacct').textContent = be + a.account + (mdl ? ' · ' + mdl : '');
  $('#head .t').title = a.name + ' · ' + (a.backend && a.backend !== 'claude' ? backendLabel(a.backend) + ' · ' : '') + a.account + ' · model ' + (a.model || 'default') + (a.effort ? ' · effort ' + a.effort : '') + '\n' + a.cwd;
}

// ---- header popovers (⋯ menu, usage): native popovers (top layer, Esc and outside click close them), placed under
// their button on wide screens and as a bottom sheet on phones (CSS)
const phone = matchMedia('(max-width: 700px)');
function setupMenus() {
  for (const [pid, bid] of [['hmenu', 'more'], ['upop', 'ubtn']]) {
    const p = $('#' + pid), b = $('#' + bid);
    if (!p.showPopover) { b.onclick = () => p.classList.toggle('open'); continue; } // no popover API: plain toggle
    p.addEventListener('beforetoggle', (e) => {
      b.setAttribute('aria-expanded', e.newState === 'open');
      if (e.newState !== 'open') return;
      if (phone.matches) { p.style.top = p.style.right = ''; return; }
      const r = b.getBoundingClientRect();
      p.style.top = r.bottom + 6 + 'px'; p.style.right = Math.max(8, innerWidth - r.right) + 'px';
    });
    p.addEventListener('toggle', (e) => {
      if (e.newState === 'open') { if (pid === 'hmenu') menuItems()[0]?.focus(); }
      else if (p.contains(document.activeElement) || document.activeElement === document.body) b.focus({ preventScroll: true });
    });
  }
  const m = $('#hmenu');
  m.addEventListener('click', (e) => { if (e.target.closest('button, a')) m.hidePopover?.(); });
  m.addEventListener('keydown', (e) => {
    const items = menuItems(), i = items.indexOf(document.activeElement);
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (to === null || (e.target.tagName === 'SELECT' && /Arrow/.test(e.key))) return;
    e.preventDefault(); items[(to + items.length) % items.length]?.focus();
  });
}
const menuItems = () => [...$('#hmenu').querySelectorAll('button, a, select')].filter((x) => !x.disabled && !x.closest('[hidden]'));

// ---- composer: Send turns into Stop while the agent runs; typing while it runs shows a note and Send again
function updComposer() {
  const a = agents[sel], go = $('#go'); if (!a || !go) return;
  const running = a.status === 'running', typed = !!$('#txt').value.trim() || !!(chatAtts[sel] || []).length;
  $('#stop').hidden = !running;
  go.hidden = running && !typed;
  $('#busy').hidden = !(running && typed);
  $('#stopped').hidden = a.status !== 'stopped';
}

// ---- jump to latest: shown when the log isn't at the bottom, with a count of events that came in since
let unread = 0;
const atBottom = (l = $('#log')) => l.scrollHeight - l.scrollTop - l.clientHeight < 80;
function updJump() {
  const l = $('#log'), b = $('#jump'); if (!l || !b) return;
  const far = l.scrollHeight - l.scrollTop - l.clientHeight > 240;
  if (atBottom(l)) unread = 0;
  b.hidden = !far && !unread;
  const n = b.querySelector('.n'); n.hidden = !unread; n.textContent = unread > 99 ? '99+' : unread;
  b.setAttribute('aria-label', unread ? `Jump to latest (${unread} new)` : 'Jump to latest');
}

// ---- empty main pane: a welcome card
function renderWelcome() {
  const all = Object.values(agents), cond = all.find((a) => a.role === 'conductor');
  const when = (a) => a.activity?.at || a.startedAt || 0;
  const recent = all.filter((a) => a.role !== 'conductor').sort((x, y) => (y.status === 'running') - (x.status === 'running') || when(y) - when(x)).slice(0, 3);
  $('#main').replaceChildren($('#welcometpl').content.cloneNode(true)); // wording and links: <template id="welcometpl"> in index.html
  $('.welcome .wr').hidden = !recent.length;
  $('.welcome').classList.toggle('first', !all.some((a) => a.role !== 'conductor'));
  api('/accounts').then((l) => { // first run: say so when the claude CLI is missing or signed out
    const w = $('.welcome .wnote'), bad = l.length && l.every((x) => x.loggedIn === false || x.error);
    if (!w || !bad) return;
    w.hidden = false; w.classList.toggle('missing', l.some((x) => /ENOENT/.test(x.error || '')));
  }).catch(() => {});
  $('#wnew').onclick = () => $('#new').click();
  $('#wcond').onclick = async () => {
    try {
      const a = cond || await api('/conductor', { method: 'POST', body: { account: localStorage.getItem('halay-acct') || undefined } });
      agents[a.id] = a; go('/a/' + a.id);
    } catch (e) { flash(e.message, 'error'); }
  };
  for (const a of recent) {
    const r = mk('button', 'wa');
    r.innerHTML = `<span class="dot ${a.status}"></span><span class="wn"><b></b><small></small></span><small class="wt"></small>${icon('chevron-right')}`;
    r.querySelector('b').textContent = a.name;
    r.querySelector('.wn small').textContent = a.oneOff ? 'one-off' : a.cwd;
    r.querySelector('.wt').textContent = a.status === 'running' ? 'running' : typeof histAgo === 'function' && when(a) ? histAgo(when(a)) : '';
    r.onclick = () => go('/a/' + a.id);
    $('.welcome .wr').append(r);
  }
}

// The log is built off-screen in a fragment (appendEvent writes to outEl while it is set) and attached in one go.
let outEl = null, curIdx = 0, permEls = {};
const logEl = () => outEl || $('#log');

function earlierButton() {
  const b = document.createElement('button');
  b.id = 'earlier'; b.style.alignSelf = 'center'; b.textContent = `Load earlier (${hidden[sel]} older events)`;
  // loads by itself when scrolled near the top; after an error it waits for a click
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && !b.disabled) b.click(); }, { root: $('#log'), rootMargin: '400px 0px 0px 0px' });
  b.onclick = () => loadOlder(200).catch((e) => { io.disconnect(); flash(e.message, 'error'); b.textContent = `Load earlier (${hidden[sel]} older events)`; b.disabled = false; });
  requestAnimationFrame(() => b.isConnected && io.observe(b)); // after the log has scrolled to the bottom
  return b;
}

function renderEvents(list, start) {
  outEl = document.createDocumentFragment();
  try { list.forEach((ev, i) => { curIdx = start + i; appendEvent(ev); }); return outEl; }
  finally { outEl = null; }
}

function renderLog() {
  cards = {}; permEls = {}; tcards = {}; tasks2card = {}; jobs = {}; liveGroup = null;
  const frag = document.createDocumentFragment();
  for (const p of pend[sel] || []) frag.append(renderEvents([p.event], p.i));
  frag.append(renderEvents(events[sel] || [], hidden[sel] || 0));
  $('#log').append(frag);
  if (hidden[sel]) $('#log').prepend(earlierButton());
  const last = $('#log').lastElementChild; // a running turn keeps its latest tool calls open
  if (agents[sel]?.status === 'running' && last?.classList.contains('tgroup')) { liveGroup = last; setGroup(last, true); }
}

// Prepends at least `count` older events without touching the rest of the log or the scroll position.
async function loadOlder(count) {
  const id = sel, from = hidden[id];
  const b = $('#earlier'); if (b) { b.disabled = true; b.textContent = 'Loading…'; }
  const a = await api(`/agents/${id}?before=${from}&limit=${count}`);
  if (sel !== id || hidden[id] !== from) return;
  const l = $('#log'), h = l.scrollHeight, t = l.scrollTop;
  // approvals that were shown ahead of the window are drawn in place now
  pend[id] = (pend[id] || []).filter((p) => { if (p.i < a.from) return true; permEls[p.event.reqId]?.remove(); delete permEls[p.event.reqId]; return false; });
  const had = new Set(Object.keys(cards));
  const frag = renderEvents(a.events, a.from);
  // the new cards and approvals may have been answered by events that were already loaded
  curIdx = from;
  events[id].forEach((ev, i) => {
    curIdx = from + i;
    const cid = ev.parent_tool_use_id || (ev.type === 'system' ? taskCardId(ev) : null);
    if (ev.type === 'permission_resolved' || cid) { if (ev.type === 'permission_resolved' || (cards[cid] && !had.has(cid))) appendEvent(ev); }
    else if (ev.type === 'user') appendEvent(ev, had);
    else if (ev.type === 'result' || ev.type === 'exit') for (const c in cards) if (!had.has(c) && (ev.type === 'exit' || !cards[c].bg)) subDone(c, '', 'ended');
  });
  events[id] = a.events.concat(events[id]); hidden[id] = a.from;
  b?.remove();
  const before = [...l.children].find((n) => Number(n.dataset.ev) >= from);
  l.insertBefore(frag, before || null);
  if (a.from > 0) l.prepend(earlierButton());
  l.scrollTop = t + l.scrollHeight - h; // keep the view where it was
}

function updateRemote() {
  const r = agents[sel]?.remote; if (!r || !$('#rc')) return;
  $('#rc span').textContent = { off: 'Remote: off', starting: 'Remote: starting…', on: 'Remote: on', error: 'Remote: error' }[r.status];
  $('#rc').title = r.error || 'Control this folder from claude.ai/code and the Claude mobile app (a separate session, not this chat)';
  $('#rc').classList.toggle('on', r.status === 'on');
  $('#head .hcwd').textContent = agents[sel].cwd + (r.error ? ' · remote ' + r.error : '');
  $('#rclink').hidden = !r.url; if (r.url) $('#rclink').href = r.url;
}

const scroll = () => { const l = $('#log'); if (l) l.scrollTop = l.scrollHeight; };

function add(cls, text, html) {
  const l = logEl(); if (!l) return;
  if (!cls.startsWith('tgroup')) settle();
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.dataset.ev = curIdx;
  if (html) d.innerHTML = html; else d.textContent = text;
  l.append(d);
  return d;
}

// when a message was sent, as a small line under it: the time for today's, the date too for older ones (and the
// year when it isn't this one); the full date in the tooltip. ev._ts comes from the server; older events have none.
function stamp(d, ts) {
  if (!d || !ts) return;
  const t = new Date(ts), now = new Date(), hm = { hour: 'numeric', minute: '2-digit' };
  const s = document.createElement('div');
  s.className = 'mts' + (d.classList.contains('user') || d.classList.contains('out') ? ' user' : '');
  s.dataset.ev = d.dataset.ev;
  s.append(t.toDateString() === now.toDateString() ? t.toLocaleTimeString([], hm)
    : t.toLocaleString([], { day: 'numeric', month: 'short', year: t.getFullYear() === now.getFullYear() ? undefined : 'numeric', ...hm }));
  s.title = t.toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' });
  d.after(s);
  return s;
}

// a turn's end (`done · 3 turns · $0.20`) joins the timestamp line of its last reply instead of a line of its own
function turnFoot(ev) {
  const l = logEl(); if (!l) return;
  const f = mk('span', 'tfo' + (ev.is_error ? ' bad' : ''), `${ev.is_error ? 'error' : 'done'} · ${plural(ev.num_turns ?? 0, 'turn')} · ${fmtCost(ev.total_cost_usd ?? 0)}`);
  f.title = 'This turn: Claude Code turns and estimated cost (API prices)';
  let s = l.lastElementChild;
  if (!s?.classList.contains('mts') || s.classList.contains('user') || s.querySelector('.tfo')) {
    s = mk('div', 'mts tfl'); s.dataset.ev = curIdx; l.append(s);
    if (ev._ts) s.title = new Date(ev._ts).toLocaleString([], { dateStyle: 'full', timeStyle: 'medium' });
  }
  s.append(f);
}

// Events arrive slimmed (long text cut, images dropped, _cut set); the cut text ends with this marker.
const isCut = (t) => typeof t === 'string' && /\n… \[\d+ more characters\]$/.test(t);
// adds a "Show full" button to `parent` that fetches event `idx` and hands it to apply()
function moreBtn(parent, idx, apply) {
  const b = document.createElement('button');
  b.className = 'more'; b.textContent = 'Show full';
  b.onclick = async (e) => {
    e.stopPropagation(); b.disabled = true; b.textContent = 'Loading…';
    try { apply(await api(`/agents/${sel}/events/${idx}`)); b.remove(); }
    catch (x) { b.disabled = false; b.textContent = 'Show full'; flash(x.message, 'error'); }
  };
  parent.append(b);
}


// links open in a new tab; in-page anchors stay put. The only input markdown makes is a task list's checkbox: any
// input left is a disabled checkbox
if (window.DOMPurify) DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A' && n.getAttribute('href') && !n.getAttribute('href').startsWith('#')) { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
  if (n.tagName === 'INPUT') { n.setAttribute('type', 'checkbox'); n.setAttribute('disabled', ''); }
});
// Agent output, room messages and files are untrusted (a web page or file can put text in an agent's reply): no
// <style> or style attributes that could restyle or cover the app's own controls (an approval card), and no forms
const MD_PURIFY = { FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'dialog'], FORBID_ATTR: ['style', 'formaction', 'form'] };
const renderMd = (text) => window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(String(text)), MD_PURIFY) : esc(text).replace(/\n/g, '<br>');
const mdDecor = (root) => codeTools(highlightBlocks(linkPaths(root))); // after renderMd: path links, highlighting, code block bar

// ---- code blocks in markdown: language label and copy button; long ones capped with "Show all"
function codeTools(root) {
  root.querySelectorAll('pre > code').forEach((c) => {
    const pre = c.parentElement; if (pre.parentElement?.classList.contains('cb')) return;
    const w = mk('div', 'cb'), h = mk('div', 'cbh'), n = c.textContent.replace(/\n$/, '').split('\n').length;
    h.append(mk('span', '', (/language-([\w+-]+)/.exec(c.className) || [])[1] || 'code'));
    const b = mk('button', 'cbc'); b.innerHTML = icon('copy') + '<span>Copy</span>'; b.setAttribute('aria-label', 'Copy code');
    b.onclick = async (e) => {
      e.stopPropagation();
      if (!await copyText(c.textContent)) return flash('Could not copy', 'error');
      b.innerHTML = icon('check') + '<span>Copied</span>'; setTimeout(() => { b.innerHTML = icon('copy') + '<span>Copy</span>'; }, 1500);
    };
    h.append(b); pre.before(w); w.append(h, pre);
    if (n > 24) {
      w.classList.add('cap');
      const m = mk('button', 'cbm', `Show all ${n} lines`);
      m.onclick = (e) => { e.stopPropagation(); const cap = w.classList.toggle('cap'); m.textContent = cap ? `Show all ${n} lines` : 'Show less'; if (cap) w.scrollIntoView({ block: 'nearest' }); };
      w.append(m);
    }
  });
  return root;
}

// ---- tool calls: one line per call (icon, verb, key argument), expanded on click; consecutive calls grouped
const relP = (p) => { const c = agents[sel]?.cwd, s = String(p ?? ''); return c && s.startsWith(c + '/') ? s.slice(c.length + 1) : s; };
const line1 = (s) => String(s ?? '').trim().split('\n')[0];
const nLines = (s) => (typeof s === 'string' && s ? s.replace(/\n$/, '').split('\n').length : 0);
const agentName = (id) => agents[id]?.name || id || '';
function diffStat(pairs) {
  if (pairs.some(([o, n]) => isCut(o) || isCut(n))) return '';
  const a = pairs.reduce((s, [, n]) => s + nLines(n), 0), d = pairs.reduce((s, [o]) => s + nLines(o), 0);
  return `+${a} −${d}`;
}
// { ic, verb, arg, extra } for a tool call
function toolSum(name, inp) {
  inp = inp && typeof inp === 'object' ? inp : {};
  const f = relP(inp.file_path || inp.notebook_path || inp.path || '');
  switch (name) {
    case 'Bash': return { ic: 'terminal', verb: 'Ran', arg: line1(inp.command).replace(/^cd ("[^"]*"|'[^']*'|\S+) *(&&|;) */, ''), tip: inp.description }; // the full command, `cd` included, is in the expanded part
    case 'Read': return { ic: 'file-text', verb: 'Read', arg: f, extra: inp.offset ? `from line ${inp.offset}` : '' };
    case 'Edit': return { ic: 'pencil', verb: 'Edited', arg: f, extra: diffStat([[inp.old_string, inp.new_string]]) };
    case 'MultiEdit': return { ic: 'pencil', verb: 'Edited', arg: f, extra: diffStat((inp.edits || []).map((e) => [e.old_string, e.new_string])) };
    case 'NotebookEdit': return { ic: 'pencil', verb: 'Edited', arg: f };
    case 'Write': return { ic: 'square-pen', verb: 'Wrote', arg: f, extra: nLines(inp.content) && !isCut(inp.content) ? plural(nLines(inp.content), 'line') : '' };
    case 'Grep': return { ic: 'search', verb: 'Searched', arg: line1(inp.pattern), extra: inp.path ? 'in ' + relP(inp.path) : inp.glob || '' };
    case 'Glob': return { ic: 'search', verb: 'Searched', arg: line1(inp.pattern), extra: inp.path ? 'in ' + relP(inp.path) : '' };
    case 'WebFetch': return { ic: 'globe', verb: 'Fetched', arg: inp.url };
    case 'WebSearch': return { ic: 'globe', verb: 'Searched the web', arg: inp.query };
    case 'Task': case 'Agent': return { ic: 'bot', verb: 'Ran subagent', arg: inp.description || inp.subagent_type };
    case 'AskUserQuestion': { const q = askQs(inp); return { ic: 'message-square', verb: 'Asked', arg: q[0]?.question || '', extra: q.length > 1 ? `+${q.length - 1} more` : '' }; }
    case 'TodoWrite': { const t = inp.todos || []; return { ic: 'list-todo', verb: 'Updated todos', arg: '', extra: t.length ? `${t.filter((x) => x.status === 'completed').length}/${t.length} done` : '' }; }
    case 'mcp__swarm__send_message': return { ic: 'message-square', verb: 'Messaged', arg: agentName(inp.agent_id) };
    case 'mcp__swarm__start_agent': return { ic: 'bot', verb: 'Started agent', arg: inp.name || '' };
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  const first = inp.agent_id ? agentName(inp.agent_id) : Object.values(inp).find((v) => typeof v === 'string');
  if (m) return { ic: m[1] === 'swarm' ? 'bot' : 'zap', verb: `${m[1]} · ${m[2]}`, arg: line1(first) };
  return { ic: 'wrench', verb: name, arg: line1(first) };
}
const FILE_TOOLS = ['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

// ---- AskUserQuestion: the agent's questions as a form, in its chat and in the approvals inbox. The CLI hands them to
// the permission prompt; the server turns the answers into the allowed call's updatedInput.answers. send(body) posts
// { decision: 'answer', answers } (in question order: a label or the typed "Other" text, an array of them for
// multi-select, null when left blank) or { decision: 'deny' }.
const askQs = (inp) => (Array.isArray(inp?.questions) ? inp.questions.filter((q) => q && typeof q.question === 'string') : []);
let askSeq = 0;
function askForm(inp, send) {
  const f = mk('form', 'ask'), uid = 'ask' + ++askSeq;
  if (inp?.title) f.append(mk('div', 'askt', inp.title));
  const sub = mk('button', 'primary', 'Submit answers'), no = mk('button', '', 'Decline');
  sub.type = 'submit'; no.type = 'button'; no.title = 'The agent is told you declined to answer';
  const sync = () => { sub.disabled = !getters.some((g) => g() !== null); };
  const getters = askQs(inp).map((q, qi) => {
    const fs = mk('fieldset', 'askq'), lg = mk('legend');
    if (q.header) lg.append(mk('span', 'askh', q.header));
    lg.append(mk('span', 'askqt', q.question));
    fs.append(lg);
    if (typeof q.description === 'string' && q.description) fs.append(mk('div', 'askd', q.description));
    f.append(fs);
    if (q.kind === 'text' || q.kind === 'number') {
      const t = mk(q.kind === 'text' ? 'textarea' : 'input', 'askin');
      if (q.kind === 'text') { t.rows = 2; t.placeholder = q.placeholder || 'Your answer'; }
      else { t.type = 'number'; t.inputMode = 'decimal'; for (const k of ['min', 'max', 'step']) if (Number.isFinite(q[k])) t[k] = q[k]; if (Number.isFinite(q.defaultValue)) t.value = q.defaultValue; }
      t.setAttribute('aria-label', q.question); t.oninput = sync;
      fs.append(t);
      if (q.kind === 'number' && q.unit) fs.append(mk('span', 'asku', q.unit));
      return () => t.value.trim() || null;
    }
    const multi = !!q.multiSelect, name = `${uid}-${qi}`;
    if (multi) fs.append(mk('div', 'askm', 'Pick any number'));
    const opt = (cls) => { const l = mk('label', 'asko' + (cls ? ' ' + cls : '')), i = mk('input'); i.type = multi ? 'checkbox' : 'radio'; i.name = name; i.onchange = sync; l.append(i); fs.append(l); return [l, i]; };
    const boxes = (Array.isArray(q.options) ? q.options : []).map((o) => {
      const [l, i] = opt(), tx = mk('span', 'askl');
      i.value = String(o?.label ?? '');
      tx.append(mk('b', '', i.value));
      if (o?.description) tx.append(mk('small', '', o.description));
      if (o?.preview) { const p = mk('details', 'askp'); p.append(mk('summary', '', 'Preview'), mk('pre', '', String(o.preview))); tx.append(p); }
      l.append(tx);
      return i;
    });
    const [, oi] = opt('askother'), ot = mk('input', 'askin');
    ot.type = 'text'; ot.placeholder = 'Other…'; ot.setAttribute('aria-label', `Other answer to: ${q.question}`); ot.enterKeyHint = 'done';
    ot.oninput = () => { if (ot.value.trim()) oi.checked = true; sync(); };
    oi.onchange = () => { if (oi.checked) ot.focus(); sync(); };
    oi.parentElement.append(ot);
    return () => {
      const other = oi.checked && ot.value.trim();
      const picked = [...boxes.filter((i) => i.checked).map((i) => i.value), ...(other ? [other] : [])];
      return !picked.length ? null : multi ? picked : picked[0];
    };
  });
  const btns = mk('div', 'btns'); btns.append(sub, no); f.append(btns);
  const busy = (on) => f.querySelectorAll('button, input, textarea').forEach((x) => { x.disabled = on; });
  const go = (body) => { busy(true); send(body).catch((e) => { flash(e.message, 'error'); busy(false); sync(); }); };
  f.onsubmit = (e) => { e.preventDefault(); if (!sub.disabled) go({ decision: 'answer', answers: getters.map((g) => g()) }); };
  no.onclick = () => go({ decision: 'deny' });
  sync();
  return f;
}
// the card once settled: each question with its answer (answers: { [question text]: answer } from permission_resolved)
function askDone(d, inp, ev) {
  d.classList.add('done');
  const s = mk('div', 'ask askdone');
  if (inp?.title) s.append(mk('div', 'askt', inp.title));
  for (const q of askQs(inp)) {
    const r = mk('div', 'askr'), a = ev.answers?.[q.question];
    if (q.header) r.append(mk('span', 'askh', q.header));
    r.append(mk('div', 'askqt', q.question), mk('div', 'aska' + (a ? '' : ' none'), a || 'no answer'));
    s.append(r);
  }
  s.append(mk('div', 'btns', ev.decision === 'expired' ? '↻ expired (server restarted)' : ev.decision === 'deny' ? '✗ Declined' : '✓ Answered'));
  const f = d.querySelector('form.ask');
  f ? f.replaceWith(s) : d.append(s);
}
function toolLine(s) { // the inner HTML of a one-line summary
  return `${icon(s.ic, 'ti')}<span class="tv">${esc(s.verb)}</span>${s.arg ? `<span class="ta">${esc(s.arg)}</span>` : ''}${s.extra ? `<span class="tx">${esc(s.extra)}</span>` : ''}`;
}

let tcards = {}, liveGroup = null;
function setGroup(g, open, user) {
  g.classList.toggle('open', open);
  g.querySelector('.tgs').setAttribute('aria-expanded', open);
  if (user) g.user = true;
}
// a live turn moved on (text, an approval, the end): fold its tool calls unless you opened/closed them yourself
function settle() {
  if (outEl || !liveGroup) return;
  if (!liveGroup.user) setGroup(liveGroup, false);
  liveGroup = null;
}
function groupSum(g) {
  const n = g.querySelectorAll('.tc').length, bad = g.querySelectorAll('.tc.bad').length;
  g.classList.toggle('multi', n > 1);
  g.querySelector('.tgs').innerHTML = `${icon('chevron-right', 'chev')}<span>Ran ${n} tools</span>${bad ? `<span class="tgbad">${bad} failed</span>` : ''}`;
}
function toolGroup() {
  const l = logEl(); if (!l) return null;
  const last = l.lastElementChild;
  if (last?.classList.contains('tgroup')) return last;
  const g = add('tgroup', '', '<button class="tgs" aria-expanded="false"></button><div class="tgb"></div>');
  g.querySelector('.tgs').onclick = () => setGroup(g, !g.classList.contains('open'), true);
  if (!outEl) { liveGroup = g; setGroup(g, true); }
  return g;
}
function toolCard(ev, c, idx, ci) {
  const g = toolGroup(); if (!g) return;
  const s = toolSum(c.name, c.input), d = document.createElement('div');
  d.className = 'msg tool tc' + (outEl ? '' : ' pend'); d.dataset.ev = idx;
  const fps = toolPaths(c.input), nf = fps.length > 1 || (fps.length === 1 && !FILE_TOOLS.includes(c.name)) ? fps.length : 0;
  d.innerHTML = `<button class="tl" aria-expanded="false">${toolLine(s)}${nf ? `<span class="tfn">${plural(nf, 'file')}</span>` : ''}${icon('chevron-down', 'chev')}</button><div class="terr" hidden></div><div class="tb"></div>`;
  const tl = d.querySelector('.tl'); tl.title = s.tip || c.name;
  d.tu = { ev, c, idx, ci, fps, res: null, input: null };
  tl.onclick = () => { const o = d.classList.toggle('open'); tl.setAttribute('aria-expanded', o); if (o) tcBody(d); };
  tcards[c.id] = d;
  g.querySelector('.tgb').append(d);
  groupSum(g);
}
function tcResult(d, c, idx, ci, cut) {
  const imgs = Array.isArray(c.content) ? c.content.map((x, j) => [x, j]).filter(([x]) => x?.type === 'image').map(([x, j]) => [idx, [ci, j], x]) : [];
  d.tu.res = { text: resText(c.content), err: !!c.is_error, idx, ci, cut, imgs };
  d.classList.remove('pend');
  if (c.is_error) {
    d.classList.add('bad');
    const e = d.querySelector('.terr'); e.hidden = false; e.textContent = line1(d.tu.res.text).slice(0, 300) || 'tool error';
    const g = d.closest('.tgroup'); if (g) groupSum(g);
  }
  if (d.classList.contains('open')) tcBody(d);
}
// expanded: the full input (command, diff, JSON), file chips, then the output
async function tcBody(d) {
  const { ev, c, idx, ci, fps, res } = d.tu, b = d.querySelector('.tb');
  b.innerHTML = '';
  const pin = mk('pre', 'tin');
  b.append(pin);
  let input = d.tu.input || c.input;
  if (!d.tu.input && ev._cut) {
    pin.textContent = 'Loading…';
    try { input = d.tu.input = (await api(`/agents/${sel}/events/${idx}`)).message.content[ci].input; } catch (e) { pin.textContent = e.message; return; }
    if (!d.isConnected) return;
  }
  const inp = input && typeof input === 'object' ? input : {};
  const diff = (pairs) => pairs.map(([o, n]) => [...String(o ?? '').split('\n').map((l) => '-' + l), ...String(n ?? '').split('\n').map((l) => '+' + l)].join('\n')).join('\n@@\n');
  if (c.name === 'Bash' && typeof inp.command === 'string') pin.textContent = '$ ' + inp.command;
  else if (c.name === 'Edit' && typeof inp.old_string === 'string') { pin.classList.add('diff'); pin.innerHTML = diffHtml(diff([[inp.old_string, inp.new_string]])); }
  else if (c.name === 'MultiEdit' && Array.isArray(inp.edits)) { pin.classList.add('diff'); pin.innerHTML = diffHtml(diff(inp.edits.map((e) => [e.old_string, e.new_string]))); }
  else if (c.name === 'Write' && typeof inp.content === 'string') pin.textContent = inp.content;
  else if (c.name === 'TodoWrite' && Array.isArray(inp.todos)) pin.textContent = inp.todos.map((t) => (t.status === 'completed' ? '✓ ' : t.status === 'in_progress' ? '▸ ' : '○ ') + t.content).join('\n');
  else pin.textContent = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  if (fps.length) fileChips(b, fps, c.id);
  if (!res) return;
  for (const [i, loc, x] of res.imgs) imageBlock(b, i, loc, x);
  if (!res.text.trim()) return;
  const out = mk('pre', 'tout' + (res.err ? ' bad' : ''), res.text);
  b.append(out);
  if (isCut(res.text)) moreBtn(b, res.idx, (f) => { res.text = out.textContent = resText(f.message.content[res.ci].content); });
}

// ---- subagents: Task/Agent tool_use -> card, filled in when its tool_result (foreground) or task_notification
// (background) arrives. task_started / task_progress / task_updated system events feed its live status line.
let cards = {}, tasks2card = {}, jobs = {};
const resText = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('\n') : '';
const dur = (ms) => { const s = Math.round((ms || 0) / 1000); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; };
const taskCardId = (ev) => ev.subtype?.startsWith('task_') ? (cards[ev.tool_use_id] ? ev.tool_use_id : tasks2card[ev.task_id] || tasks2card[ev.parent_task_id] || jobs[ev.task_id]?.card || null) : null;
function subCard(c) {
  const d = add('sub', '', `<div class="sh">${icon('bot', 'sic')}<b></b><span class="sd"></span><span class="st run">running…</span></div>
    <div class="sp" hidden><span class="spin" aria-hidden="true"></span><span class="sstep"></span><span class="sstat"></span></div>
    <div class="sjobs" hidden></div>
    <details class="ssteps" hidden><summary></summary><ol></ol></details>
    <details class="snest" hidden><summary></summary></details>
    <details class="sres" hidden open><summary>Result</summary><div class="md"></div></details>
    <div class="sact" hidden><button class="sdet">${icon('eye')}<span>Details</span></button></div>`);
  if (!d) return;
  d.querySelector('b').textContent = c.input?.subagent_type || 'subagent';
  d.querySelector('.sd').textContent = c.input?.description || '';
  d.nested = 0; d.steps = []; d.toolUse = c.id;
  d.querySelector('.sdet').onclick = () => subDetails(d);
  cards[c.id] = d;
}
function subStatus(d, u, step) {
  const p = d.querySelector('.sp'); p.hidden = false;
  if (step !== undefined) d.querySelector('.sstep').textContent = step;
  if (u) d.querySelector('.sstat').textContent = [u.tool_uses != null && plural(u.tool_uses, 'tool'), u.total_tokens && ctxK(u.total_tokens) + ' tokens', u.duration_ms && dur(u.duration_ms)].filter(Boolean).join(' · ');
}
function subTask(ev) { // task_started / task_progress / task_updated / task_notification of a subagent or of its own jobs
  const job = jobs[ev.task_id];
  if (ev.subtype === 'task_started' && ev.owned_by_subagent && ev.parent_task_id) {
    const d = cards[tasks2card[ev.parent_task_id]]; if (!d) return;
    const chip = mk('span', 'sjob run'); chip.title = ev.description || ''; chip.innerHTML = `${icon(ev.task_type === 'local_bash' ? 'terminal' : 'bot')}<span></span>`;
    chip.querySelector('span').textContent = ev.description || ev.task_type || 'job';
    jobs[ev.task_id] = { card: d.toolUse, chip };
    const j = d.querySelector('.sjobs'); j.hidden = false; j.append(chip);
    return;
  }
  if (job) { // one of a subagent's own jobs
    const st = ev.patch?.status || ev.status;
    if (st && st !== 'running') { job.chip.classList.remove('run'); job.chip.classList.toggle('bad', /fail|error|kill/.test(st)); job.chip.title = (job.chip.title + ' · ' + st).trim(); }
    return;
  }
  const id = cards[ev.tool_use_id] ? ev.tool_use_id : tasks2card[ev.task_id], d = cards[id]; if (!d) return;
  if (ev.subtype === 'task_started') {
    tasks2card[ev.task_id] = id; d.taskId = ev.task_id; d.bg = !!ev.is_backgrounded;
    d.querySelector('.sact').hidden = false;
    if (d.bg) d.querySelector('.sh b').title = 'Runs in the background';
    if (!d.done) subStatus(d, null, 'Starting…');
  } else if (ev.subtype === 'task_progress') {
    d.lastUsage = ev.usage;
    const step = ev.description || (ev.last_tool_name ? 'Running ' + ev.last_tool_name : '');
    if (step && d.steps[d.steps.length - 1] !== step && step !== d.querySelector('.sd').textContent) {
      d.steps.push(step);
      const s = d.querySelector('.ssteps'), ol = s.querySelector('ol'); s.hidden = false;
      ol.append(mk('li', '', step)); while (ol.children.length > 60) ol.firstChild.remove();
      s.querySelector('summary').textContent = `Steps (${d.steps.length})`;
    }
    subStatus(d, ev.usage, d.done ? '' : step);
  } else if (ev.subtype === 'task_updated') {
    const st = ev.patch?.status;
    if (st && st !== 'running' && st !== 'pending') subDone(id, '', st === 'completed' ? 'done' : st);
  } else if (ev.subtype === 'task_notification') {
    if (ev.usage) d.lastUsage = ev.usage;
    const text = ev.handback_report?.text;
    subDone(id, text || '', ev.status === 'completed' || !ev.status ? 'done' : ev.status, text ? { idx: curIdx, get: (f) => f.handback_report.text } : undefined);
  }
}
// more: { idx, get(fullEvent) -> text } when `text` may have been cut
function subDone(id, text, state = 'done', more) {
  const d = cards[id]; if (!d) return;
  if (!d.done) {
    d.done = true;
    const st = d.querySelector('.st'); st.classList.remove('run'); st.classList.toggle('bad', /fail|error|kill/.test(state)); st.textContent = state;
    if (!d.querySelector('.sp').hidden) subStatus(d, d.lastUsage, '');
    d.querySelectorAll('.sjob.run').forEach((j) => j.classList.remove('run'));
  }
  const r = d.querySelector('.sres');
  if (text && text.trim() && !d.hasRes) {
    d.hasRes = true;
    const md = r.querySelector('.md'); r.hidden = false; r.open = false; md.innerHTML = renderMd(text); mdDecor(md);
    if (more && isCut(text)) moreBtn(md, more.idx, (full) => { md.innerHTML = renderMd(more.get(full)); mdDecor(md); });
  }
}
function subNest(ev) { // the subagent's own messages, collapsed under its card
  const d = cards[ev.parent_tool_use_id]; if (!d || ev.type !== 'assistant') return;
  const n = d.querySelector('.snest');
  for (const c of ev.message?.content || []) {
    let line = null;
    if (c.type === 'text' && c.text.trim()) line = mk('div', 'st-text', c.text.replace(/\s+/g, ' '));
    else if (c.type === 'tool_use' && c.name !== 'SubagentHandback') { line = mk('div', 'st-tool'); line.innerHTML = toolLine(toolSum(c.name, c.input)); }
    if (!line) continue;
    n.append(line); n.hidden = false; n.querySelector('summary').textContent = `Activity (${++d.nested})`;
  }
}
// the subagent's whole transcript in a dialog, polled every 3 s while it runs
function subDetails(card) {
  const aid = sel, dlg = document.createElement('dialog');
  dlg.className = 'subdlg';
  dlg.innerHTML = `<div class="sdh">${icon('bot')}<b></b><span class="sd"></span><span class="st"></span><button class="x" aria-label="Close">${icon('x')}</button></div><div class="sdl" role="log" aria-live="polite"><div class="sdm">Loading…</div></div>`;
  dlg.querySelector('b').textContent = card.querySelector('.sh b').textContent;
  dlg.setAttribute('aria-label', 'Subagent: ' + card.querySelector('.sh b').textContent);
  dlg.querySelector('.sd').textContent = card.querySelector('.sd').textContent;
  const st = () => { const s = dlg.querySelector('.st'); s.textContent = card.done ? card.querySelector('.st').textContent : 'running…'; s.classList.toggle('run', !card.done); };
  const list = dlg.querySelector('.sdl');
  let after = 0, timer = 0, alive = true, lastTool = null, empty = true;
  const put = (e) => {
    if (empty) { list.innerHTML = ''; empty = false; }
    if (e.kind === 'tool') {
      const t = mk('div', 'msg tool tc'); t.innerHTML = `<button class="tl" aria-expanded="false">${toolLine(toolSum(e.name, e.input))}${icon('chevron-down', 'chev')}</button><div class="tb"><pre class="tin"></pre></div>`;
      t.querySelector('.tin').textContent = e.name === 'Bash' && typeof e.input?.command === 'string' ? '$ ' + e.input.command : JSON.stringify(e.input, null, 2);
      const tl = t.querySelector('.tl'); tl.title = e.name;
      tl.onclick = () => tl.setAttribute('aria-expanded', t.classList.toggle('open'));
      list.append(t); lastTool = t;
    } else if (e.kind === 'result' && lastTool && !lastTool.querySelector('.tout')) {
      if (e.text?.trim()) lastTool.querySelector('.tb').append(mk('pre', 'tout', e.text));
    } else if (e.kind === 'text' || e.kind === 'user') {
      const m = mk('div', 'msg md' + (e.kind === 'user' ? ' sprompt' : ''));
      m.innerHTML = (e.kind === 'user' ? '<small>Prompt</small>' : '') + `<div class="md">${renderMd(e.text || '')}</div>`; mdDecor(m);
      list.append(m); lastTool = null;
    }
  };
  const poll = async () => {
    try {
      const near = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      const r = await api(`/agents/${aid}/subagent/${encodeURIComponent(card.taskId)}?after=${after}`);
      if (!alive) return;
      (r.entries || []).forEach(put);
      if (r.next != null) after = r.next;
      if (empty) list.querySelector('.sdm').textContent = r.found === false ? 'No transcript yet.' : 'Nothing here yet.';
      if (near) list.scrollTop = list.scrollHeight;
      if ((r.entries || []).length >= 400) return poll();
    } catch (e) { if (empty) list.querySelector('.sdm').textContent = 'Could not load the transcript: ' + e.message; }
    st();
    if (alive && !card.done) timer = setTimeout(poll, 3000);
  };
  dlg.querySelector('.x').onclick = () => dlg.close();
  dlg.addEventListener('close', () => { alive = false; clearTimeout(timer); dlg.remove(); });
  document.body.append(dlg); dlg.showModal(); st(); poll();
}

// ---- messages between agents, each as a labelled message (not the user's bubble, not a tool row): one from another
// Claude session (peer_message, peer-messages.js) or from a swarm agent (a prompt with `by`), and the agent's own
// SendMessage / swarm send_message
const peerNameOf = {}; // a peer session's address (uds:/…sock) -> the name it wrote to us with
// a SendMessage `to`: a teammate's name, an agent id, or a peer address shown by its name when it wrote to us
function peerTo(to, ev) {
  const n = ev._peerNames?.[to] || peerNameOf[to];
  if (n) return n;
  return /^[a-z]+:/.test(to) ? 'another session' : to; // an address we have no name for (uds:/…sock)
}
function agentMsg(dir, who, tip, text, ts, idx, full) {
  const d = add('pmsg ' + dir, '', `<div class="pmh">${icon(dir === 'in' ? 'inbox' : 'send', 'ti')}<span></span></div><div class="md"></div>`);
  if (!d) return null;
  const h = d.querySelector('.pmh span');
  h.textContent = (dir === 'in' ? 'Message from ' : 'Message to ') + who;
  if (tip) h.title = tip;
  d.querySelector('.md').innerHTML = renderMd(text || ''); mdDecor(d);
  if (isCut(text)) moreBtn(d, idx, (f) => { d.querySelector('.md').innerHTML = renderMd(full(f) ?? ''); mdDecor(d); });
  stamp(d, ts);
  return d;
}
// the agent's outgoing message, when this tool call is one: SendMessage (to another session or a teammate) or swarm send_message
function outMsg(ev, c, idx, ci) {
  const inp = c.input && typeof c.input === 'object' ? c.input : {};
  if (c.name === 'SendMessage' && typeof inp.message === 'string' && typeof inp.to === 'string')
    return agentMsg('out', peerTo(inp.to, ev), inp.to + (inp.summary ? ' · ' + inp.summary : ''), inp.message, ev._ts, idx, (f) => f.message.content[ci].input.message);
  if (c.name === 'mcp__swarm__send_message' && typeof inp.text === 'string')
    return agentMsg('out', agentName(inp.agent_id) + (inp.peer ? ' on ' + inp.peer : ''), inp.agent_id, inp.text, ev._ts, idx, (f) => f.message.content[ci].input.text);
  return null;
}

function appendEvent(ev, skip) {
  if (ev.parent_tool_use_id) return subNest(ev);
  const idx = curIdx;
  if (ev.type === 'system' && /^task_(started|progress|updated|notification)$/.test(ev.subtype)) subTask(ev);
  else if (ev.type === 'peer_message') {
    if (ev.from && ev.fromName) peerNameOf[ev.from] = ev.fromName;
    const d = agentMsg('in', ev.fromName || 'another session', ev.from ? 'Another Claude session: ' + ev.from : '', ev.text, ev._ts, idx, (f) => f.text);
    if (d && ev.queued) d.querySelector('.pmh').append(mk('small', '', 'while it was working'));
  }
  else if (ev.type === 'user_prompt' && ev.by && !ev.agentNotify) // sent by another swarm agent (send_message, its first prompt)
    agentMsg('in', agentName(ev.by), 'Swarm agent ' + ev.by, ev.text, ev._ts, idx, (f) => f.text);
  else if (ev.type === 'user_prompt' && ev.agentNotify) { // automatic: a child agent's turn ended (agent-notify.js), not the user's words
    const d = add('anotify', ev.text);
    if (isCut(ev.text)) moreBtn(d, idx, (f) => { d.textContent = f.text; });
    stamp(d, ev._ts);
  }
  else if (ev.type === 'user_prompt') {
    const att = /(?:^|\n\n)Attached files: (\/[^\n]*)$/.exec(ev.text), files = att ? att[1].split(/, (?=\/)/) : [];
    const d = add('user', att ? ev.text.slice(0, att.index) : ev.text);
    if (d && files.length) { if (!d.textContent) d.classList.add('onlyfiles'); fileChips(d, files); }
    if (isCut(ev.text)) moreBtn(d, idx, (f) => { d.textContent = f.text; });
    stamp(d, ev._ts);
  }
  else if (ev.type === 'assistant') {
    (ev.message?.content || []).forEach((c, ci) => {
      if (c.type === 'text') {
        if (!c.text.trim()) return;
        const d = add('md', '', `<div class="md">${renderMd(c.text)}</div>`);
        if (d) mdDecor(d);
        if (isCut(c.text)) moreBtn(d, idx, (f) => { d.querySelector('.md').innerHTML = renderMd(f.message.content[ci].text); mdDecor(d); });
        stamp(d, ev._ts);
      }
      else if (c.type === 'image') { const d = add('tool', ''); if (d) imageBlock(d, idx, [ci, null], c); }
      else if (c.type === 'tool_use' && (c.name === 'Task' || c.name === 'Agent')) subCard(c);
      else if (c.type === 'tool_use' && outMsg(ev, c, idx, ci)) return;
      else if (c.type === 'tool_use') toolCard(ev, c, idx, ci);
    });
  } else if (ev.type === 'user') {
    (ev.message?.content || []).forEach((c, ci) => {
      const te = c.type === 'tool_result' ? toolEls[c.tool_use_id] : null, tc = c.type === 'tool_result' ? tcards[c.tool_use_id] : null;
      if (te && !skip) te.run();
      if (tc) return tcResult(tc, c, idx, ci, ev._cut);
      if (c.type === 'image' && !skip) { const d = add('tool', ''); if (d) imageBlock(d, idx, [ci, null], c); }
      if (c.type === 'tool_result' && Array.isArray(c.content) && !(te?.img) && !skip) {
        c.content.forEach((x, j) => { if (x?.type === 'image') { const d = add('tool', ''); if (d) imageBlock(d, idx, [ci, j], x); } });
      }
      if (c.type === 'tool_result' && cards[c.tool_use_id]) {
        const d = cards[c.tool_use_id], text = resText(c.content);
        // a background subagent answers at once ("Async agent launched…"); it is done when its task_notification arrives
        if (!skip?.has(c.tool_use_id) && !d.bg && !/^Async agent launched/.test(text)) subDone(c.tool_use_id, text, c.is_error ? 'error' : 'done', { idx, get: (f) => resText(f.message.content[ci].content) });
      }
      else if (c.type === 'tool_result' && c.is_error && !skip) {
        const t = typeof c.content === 'string' ? c.content.slice(0, 400) : 'tool error';
        const d = add('err', t);
        if (ev._cut && typeof c.content === 'string') moreBtn(d, idx, (f) => { d.textContent = f.message.content[ci].content; });
      }
    });
  } else if (ev.type === 'permission_request') {
    settle();
    const d = document.createElement('div');
    d.className = 'msg perm'; d.id = 'perm-' + ev.reqId; d.dataset.ev = curIdx;
    if (ev.tool_name === 'AskUserQuestion') {
      const aid = sel;
      d.classList.add('askc'); d.askInput = ev.input;
      d.innerHTML = `<b>${icon('message-square', 'ti')} ${esc(agents[aid]?.name || 'The agent')} has a question</b>`;
      d.append(askForm(ev.input, (body) => api(`/agents/${aid}/permission`, { method: 'POST', body: { reqId: ev.reqId, ...body } })));
      permEls[ev.reqId] = d;
      logEl()?.append(d);
      return;
    }
    d.innerHTML = `<b>Allow <span class="tn"></span>?</b><code></code><div class="btns"><button class="primary" data-d="allow">Allow</button><button data-d="always">Always allow</button><button data-d="deny">Deny</button></div>`;
    d.querySelector('.tn').textContent = ev.tool_name;
    if (ev.rule) d.querySelector('[data-d=always]').title = 'Saves ' + ev.rule + ' to .claude/settings.local.json';
    d.querySelector('code').textContent = ev.input?.command ?? ev.input?.file_path ?? JSON.stringify(ev.input, null, 2);
    d.querySelectorAll('button').forEach((b) => b.onclick = () => api(`/agents/${sel}/permission`, { method: 'POST', body: { reqId: ev.reqId, decision: b.dataset.d } }).catch((e) => flash(e.message, 'error')));
    permEls[ev.reqId] = d;
    logEl()?.append(d);
  } else if (ev.type === 'permission_resolved') {
    const d = permEls[ev.reqId];
    if (d?.askInput) askDone(d, d.askInput, ev);
    else if (d) { d.classList.add('done'); d.querySelector('.btns').textContent = ev.decision === 'expired' ? '↻ expired (server restarted)' : ev.decision === 'deny' ? '✗ Denied' : '✓ Allowed' + (ev.decision === 'always' ? ' (always)' : ''); }
  } else if (ev.type === 'result') {
    settle();
    for (const id in cards) if (!cards[id].bg) subDone(id, '', 'ended');
    turnFoot(ev);
  } else if (ev.type === 'context_reset') add('res', ev.handoff ? `— new context, continuing from a handoff note${ev.auto ? ` (automatic: ${ctxK(ev.from)} context after a long idle)` : ''} —` : '— new context —');
  else if (ev.type === 'handoff') { const d = add('md handoff', '', '<details><summary>Handoff note for the new session</summary><div class="md"></div></details>'); if (d) { d.querySelector('.md').innerHTML = renderMd(ev.text); if (isCut(ev.text)) moreBtn(d, idx, (f) => { d.querySelector('.md').innerHTML = renderMd(f.text); }); } }
  else if (ev.type === 'note') add('res', ev.text);
  else if (ev.type === 'stderr') { const d = add('err', ev.text); if (isCut(ev.text)) moreBtn(d, idx, (f) => { d.textContent = f.text; }); }
  else if (ev.type === 'exit') { for (const id in cards) subDone(id, '', 'ended'); add('res', 'process exited (' + ev.code + ')'); }
}

// ---- live updates
let curWs = null, swReg = null, opened = false;
// tells the server what you are looking at, so it doesn't push about it
function sendPresence() { if (curWs?.readyState === 1) curWs.send(JSON.stringify({ type: 'presence', visible: !document.hidden, agentId: sel })); }
document.addEventListener('visibilitychange', sendPresence);
window.addEventListener('focus', sendPresence);
const SEEN_TYPES = ['assistant', 'user_prompt', 'peer_message', 'permission_request', 'result']; // what counts as "new" for jump to latest
function connect() {
  const ws = new WebSocket(wsUrl('/ws'));
  curWs = ws;
  ws.onopen = async () => {
    wsTries = 0; wsBanner(false);
    sendPresence();
    if (!opened) { opened = true; return; } // first connect: the page has just loaded all of this
    if (restartPending) return location.reload(); // Settings → Restart server: load the new server's UI too
    // reconnect (e.g. after a server restart): events may have been missed, so resync
    try {
      const fresh = {}; for (const a of await api('/agents')) fresh[a.id] = a;
      agents = fresh;
      if (sel && agents[sel]) { // keep what is on screen until the reload succeeded
        const old = { e: events[sel], h: hidden[sel], p: pend[sel] };
        try { await loadAgent(sel); } catch (e) { events[sel] = old.e; hidden[sel] = old.h; pend[sel] = old.p; throw e; }
      }
      for (const id of Object.keys(events)) if (id !== sel) { delete events[id]; delete hidden[id]; delete pend[id]; }
      loadExtras();
      renderList();
      if (sel && agents[sel]) rerender();
    } catch (e) {
      console.warn('resync after reconnect failed:', e);
      flash("Couldn't refresh after reconnecting: " + e.message, 'error');
      wsBanner(true, 'Out of date. ', () => { wsBanner(false); ws.onopen(); });
    }
  };
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch (e) { console.warn('bad WebSocket message:', e); return; }
    if (msg.type === 'event') noteLiveEvent(msg);
    if (msg.type === 'reload') location.reload();
    else if (msg.type === 'agent') {
      agents[msg.agent.id] = { ...agents[msg.agent.id], ...msg.agent }; renderList();
      if (msg.agent.id === sel && $('#head')) {
        if (curRoom != null) renderRoomMembers();
        headTitle(); if ($('#cacct')) $('#cacct').value = agents[sel].account; if ($('#hmodel') && document.activeElement !== $('#hmodel')) fillHeadModel(); applyHeadCaps(); if ($('#heffort') && document.activeElement !== $('#heffort')) fillEffortSelect($('#heffort'), agents[sel].effort); updateRemote(); renderTodos(); renderAgentExtras(); markSeen(sel); updComposer();
        if (agents[sel].status !== 'running') { settle(); $('#log').querySelectorAll('.tc.pend').forEach((t) => t.classList.remove('pend')); }
      }
    }
    else if (msg.type === 'tasks') { tasks = msg.tasks; updateBadges(); renderTasks(); }
    else if (msg.type === 'schedules') { schedules = msg.schedules; renderSchedules(); }
    else if (msg.type === 'approvals') { approvals = msg.approvals; updateBadges(); renderApprovals(); if (curRoom != null) renderRoomMembers(); }
    else if (msg.type === 'room') onRoom(msg.room);
    else if (msg.type === 'room_msg') onRoomMsg(msg);
    else if (msg.type === 'bot') onBot(msg.bot);
    else if (msg.type === 'bot_removed') onBotRemoved(msg.handle);
    else if (msg.type === 'notify') onNotify(msg);
    else if (msg.type === 'focus') onFocus(msg.agentId);
    else if (msg.type === 'terminals') onTerms(msg.terminals);
    else if (msg.type === 'browser') onBrowserState(msg);
    else if (msg.type === 'plugin' || msg.type === 'plugins') onPluginMsg(msg);
    else if (msg.type === 'context_cfg') { ctxCfg = msg.cfg; renderList(); renderCtx(); }
    else if (msg.type === 'removed') { delete agents[msg.agentId]; renderList(); if (sel === msg.agentId) go('/'); else if (!sel) renderMain(); }
    else if (msg.type === 'event') {
      const id = msg.agentId;
      if (pendingEv[id]) return void pendingEv[id].push(msg); // history is loading; applied when it lands
      if (!events[id]) return; // not open: fetched fresh when it is
      const next = hidden[id] + events[id].length;
      if (msg.i < next) return; // already have it
      if (msg.i > next) { loadAgent(id).then(() => id === sel && rerender()).catch((e) => console.warn('reload after a missed event failed:', e)); return; } // missed some: reload
      events[id].push(msg.event);
      if (id === sel) {
        const l = $('#log'), near = atBottom(l); curIdx = msg.i; appendEvent(msg.event);
        if (msg.event.type === 'result' && $('#slive')) $('#slive').textContent = `${agents[id]?.name || 'Agent'} replied`;
        if (near) scroll(); else if (SEEN_TYPES.includes(msg.event.type) && !msg.event.parent_tool_use_id) unread++;
        updJump();
      }
    }
  };
  ws.onclose = () => {
    wsBanner(true);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(wsTries++, 5)) * (0.75 + Math.random() * 0.5); // exponential backoff, capped, jittered
    setTimeout(async () => { // signed out meanwhile (expired, logged out elsewhere)? then show the login page instead of retrying
      try { if (!(await (await fetch('/auth/state')).json()).loggedIn) return location.reload(); } catch (e) { console.warn('auth check failed:', e); }
      connect();
    }, delay);
  };
}
// "Reconnecting…" strip (styled by .conn-banner in css/polish.css)
let wsTries = 0;
function wsBanner(on, text = '', retry) {
  let b = $('#connbanner');
  if (!on) { b?.remove(); return; }
  if (!b) {
    b = mk('div', 'conn-banner'); b.id = 'connbanner'; b.setAttribute('role', 'status');
    document.body.append(b);
  }
  b.textContent = text + (retry ? '' : 'Reconnecting…');
  if (retry) { const r = mk('button', '', 'Retry'); r.type = 'button'; r.onclick = retry; b.append(r); }
}
