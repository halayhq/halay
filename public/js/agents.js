// ---- agent list: Swarm chat pinned, then groups (needs you, running, recent, older); sub-agents nest under their parent
// Hidden agents (long press / right-click → Hide from recents) leave the list but keep running; they come back by themselves
// while they need you, and sit under "Hidden (n)" at the bottom otherwise.
const GROUPS = [['need', 'Needs you'], ['run', 'Running'], ['recent', 'Recent'], ['old', 'Older']];
const sideLS = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const sideSet = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const lastSeg = (p) => (p || '').replace(/\/+$/, '').split('/').pop() || p || '';

// Last activity per agent: { at, tool, text }. Seeded from the server's summary (activity), kept live from the
// events the server broadcasts for every agent.
const act = {};
function seedActivity(a) {
  const s = a.activity; if (!s?.at || (act[a.id]?.at || 0) >= s.at) return;
  act[a.id] = { at: s.at, tool: s.tool ? activityLine(s.tool) : null, text: s.text };
}
function noteEvent(id, ev) {
  const a = act[id] ||= {};
  a.at = Math.max(a.at || 0, ev._ts || Date.now());
  if (ev.parent_tool_use_id) return; // a sub-agent's step: activity, but not the agent's own line
  if (ev.type === 'assistant') for (const c of ev.message?.content || []) {
    if (c.type === 'tool_use') a.tool = activityLine(c);
    else if (c.type === 'text' && c.text.trim()) { a.text = c.text; a.tool = null; }
  }
  else if (ev.type === 'user_prompt' && ev.text) { a.text = (ev.agentNotify ? 'Notification: ' : ev.by && agents[ev.by] ? agents[ev.by].name + ': ' : 'You: ') + ev.text; a.tool = null; }
  else if (ev.type === 'peer_message' && ev.text) { a.text = (ev.fromName || 'Another session') + ': ' + ev.text; a.tool = null; }
  else if (ev.type === 'result' || ev.type === 'exit') a.tool = null;
}
function activityLine(c) {
  const i = c.input || {}, n = String(c.name).replace(/^mcp__(\w+)__/, '$1 ');
  const arg = i.command ?? (i.file_path && lastSeg(i.file_path)) ?? i.pattern ?? i.url ?? i.description ?? i.agent_id ?? '';
  return n + (typeof arg === 'string' && arg ? ': ' + arg.split('\n')[0].slice(0, 120) : '');
}
let listQueued = 0;
const queueList = () => { if (!listQueued) listQueued = setTimeout(() => { listQueued = 0; renderList(); }, 400); };
// chat.js hands every parsed live event here (it drops those of agents that aren't open): feeds the list's activity line
function noteLiveEvent(msg) { if (agents[msg.agentId] && msg.event) { noteEvent(msg.agentId, msg.event); queueList(); } }
setInterval(() => { if (!document.hidden) renderList(); }, 60e3); // relative times

const lastAt = (a) => Math.max(act[a.id]?.at || 0, a.attention?.at || 0, a.watchdog?.at || 0, a.startedAt || 0);
const waiting = (a) => approvals.some((p) => p.agentId === a.id);
// what a blocked agent waits for, in words: only questions (AskUserQuestion) to answer, or approvals
const blockedTxt = (id) => { const mine = approvals.filter((p) => p.agentId === id); return mine.length && mine.every((p) => p.kind === 'question') ? 'has a question' : 'needs approval'; };
const needsYou = (a) => !!(a.attention && a.attention.kind !== 'done') || !!a.watchdog || a.status === 'error' || waiting(a);
function stateOf(a) { // a shape and words as well as a color
  const k = a.attention?.kind;
  if (waiting(a) || k === 'blocked') return ['need blocked', blockedTxt(a.id)];
  if (a.status === 'error' || k === 'error') return ['need error', 'error'];
  if (a.watchdog) return ['need warn', a.watchdog.kind === 'loop' ? 'looping?' : 'stuck?'];
  if (k && k !== 'done') return ['need warn', KIND_TXT[k]];
  if (a.status === 'running') return ['running', 'running'];
  if (a.status === 'idle') return ['idle', k === 'done' ? 'idle, finished' : 'idle'];
  return ['stopped', 'stopped: no process; resumes on your next message'];
}
// all tokens an agent has used (cache reads included: they are most of the volume of a long session)
const tokTotal = (u) => (u ? (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheCreate || 0) : 0);
const shortModel = (m) => (m ? m.replace(/^claude-/, '') : '');
const stIcon = (cls, txt) => `<span class="st ${cls}" role="img" aria-label="${esc(txt)}" title="${esc(txt)}">${cls.startsWith('need') ? '!' : ''}</span>`;

function rowEl(a, opt = {}) {
  const [cls, stTxt] = stateOf(a), x = act[a.id] || {}, tc = todoCounts(a.todos), busy = a.status === 'running' && x.tool;
  const r = document.createElement('a');
  r.className = 'arow' + (a.id === sel ? ' sel' : '') + (a.attention ? ' attn' : '') + (opt.conductor ? ' cond' : '');
  r.href = '#/a/' + a.id; r.dataset.id = a.id;
  if (a.id === sel) r.setAttribute('aria-current', 'page');
  r.title = `${a.name}\n${a.oneOff ? 'one-off scratch folder' : a.cwd}${a.worktree ? '\n⎇ ' + a.worktree.branch : ''}${opt.parent ? '\nstarted by ' + opt.parent : ''}${a.startedBy ? '\nstarted by ' + a.startedBy.replace(/^peer:/, 'the peer swarm ') : ''}`;
  const line2 = busy ? 'Running ' + x.tool + '…' : x.text ? x.text.replace(/\s+/g, ' ').slice(0, 160)
    : opt.conductor ? 'drives your swarm' : (a.worktree ? '⎇ ' + a.worktree.branch + ' · ' : '') + (a.oneOff ? 'one-off' : lastSeg(a.cwd));
  r.innerHTML = `${stIcon(cls, stTxt)}<span class="l1"><b class="nm">${opt.conductor ? icon('compass', 'cico') : ''}<span></span></b><span class="pills"></span><time>${esc(relTime(lastAt(a)))}</time></span>`
    + `<span class="l2"><span class="pv${busy ? ' tool' : ''}">${opt.parent && !busy ? `<i class="par">${esc(opt.parent)} ›</i> ` : ''}${esc(line2)}</span><span class="ex"></span></span>`;
  r.querySelector('.nm span').textContent = a.name;
  if (a.bot) { const bb = mk('span', 'botbadge' + (a.bot.paused ? ' paused' : ''), a.bot.emoji + ' bot'); bb.title = `Bot @${a.bot.handle}${a.bot.paused ? ' (paused)' : ''}: a permanent agent with memory`; r.querySelector('.pills').before(bb); }
  if (a.backend && a.backend !== 'claude') { const cb = mk('span', 'botbadge', backendLabel(a.backend)); cb.title = `Runs on ${backendLabel(a.backend)} (account ${a.account}), not Claude Code`; r.querySelector('.pills').before(cb); }
  if (a.startedBy?.startsWith('peer:')) { const pb = mk('span', 'botbadge', '⇄ ' + a.startedBy.slice(5)); pb.title = `Started by the peer swarm "${a.startedBy.slice(5)}"`; r.querySelector('.pills').before(pb); }
  r.querySelector('time').title = 'Last activity ' + new Date(lastAt(a)).toLocaleString();
  const pills = r.querySelector('.pills'), ex = r.querySelector('.ex');
  if (a.attention) pills.append(mk('span', 'pill ' + a.attention.kind, a.attention.kind === 'blocked' ? blockedTxt(a.id) : KIND_TXT[a.attention.kind]));
  if (a.watchdog) { const p = mk('span', 'pill stuck', a.watchdog.kind === 'loop' ? 'looping?' : 'stuck?'); p.title = a.watchdog.detail; pills.append(p); }
  if (tc.total) { const t = mk('span', 'tdo', `${tc.done}/${tc.total}`); t.title = `Todos: ${tc.done} done · ${tc.active} active · ${tc.pending} pending`; t.insertAdjacentHTML('afterbegin', icon('list-todo')); ex.append(t); }
  if (a.model || a.effort) { const m = mk('span', 'mdl', shortModel(a.model) || a.effort); m.title = 'Model: ' + (a.model || 'default') + (a.effort ? ' · effort ' + a.effort : ''); ex.append(m); }
  const tk = tokTotal(a.usage);
  if (tk) { const t = mk('span', 'tok', fmtN(tk)); t.title = `Tokens used so far (input + output + cache): ${tk.toLocaleString('en-US')}\nin ${fmtN(a.usage.input)} · out ${fmtN(a.usage.output)} · cache read ${fmtN(a.usage.cacheRead)} · cache written ${fmtN(a.usage.cacheCreate)}`; ex.append(t); }
  if (a.context || a.handoff) ex.append(ctxGauge(a));
  r._sig = r.outerHTML;
  return r;
}

let listSig = '', liveNeed = null;
function renderList() {
  for (const a of Object.values(agents)) seedActivity(a);
  const all = Object.values(agents), now = Date.now();
  const showHid = sideLS('halay-shid', false), gOpen = sideLS('halay-sgrp', {}), kOpen = sideLS('halay-skids', {});
  // many events change nothing the list shows; skip rebuilding it then
  const sig = JSON.stringify([sel, Math.floor(now / 60e3), showHid, gOpen, kOpen, approvals.map((p) => p.agentId), all.map((a) => [a.id, a.name, a.status, a.cwd, a.startedAt, a.role, a.parentId, a.attention, a.watchdog, a.worktree?.branch, a.oneOff, todoCounts(a.todos), ctxK(a.context), ctxLevel(a.context), a.handoff, act[a.id], a.hidden, a.bot, a.startedBy, a.model, a.effort, fmtN(tokTotal(a.usage))])]);
  if (sig === listSig) return updateBadges();
  listSig = sig;
  const list = $('#list'), keep = list.scrollTop;
  const old = {}; for (const r of list.querySelectorAll('.arow[data-id]')) old[r.dataset.id] = r;
  list.innerHTML = '';
  const c = all.find((a) => a.role === 'conductor');
  if (c) list.append(rowEl(c, { conductor: true }));
  else {
    const pin = document.createElement('button'); pin.className = 'arow cond'; pin.type = 'button';
    pin.innerHTML = `${stIcon('stopped', 'not started')}<span class="l1"><b class="nm">${icon('compass', 'cico')}<span>Swarm chat</span></b></span><span class="l2"><span class="pv">start a chat that drives your swarm</span></span>`;
    pin.onclick = async () => {
      try { const a = await api('/conductor', { method: 'POST', body: { account: localStorage.getItem('halay-acct') || undefined } }); agents[a.id] = a; go('/a/' + a.id); }
      catch (e) { flash(e.message, 'error'); }
    };
    list.append(pin);
  }
  // the conductor's agents stay top level (it is pinned, not a folder); other parents get their sub-agents nested
  const isHid = (a) => a.hidden && a.role !== 'conductor' && !needsYou(a);
  const hid = all.filter(isHid).sort((x, y) => lastAt(y) - lastAt(x));
  const others = all.filter((a) => a.role !== 'conductor' && !isHid(a));
  const nestable = (a) => a.parentId && agents[a.parentId] && agents[a.parentId].role !== 'conductor' && !isHid(agents[a.parentId]);
  const kids = {};
  for (const a of others) if (nestable(a)) (kids[a.parentId] ||= []).push(a);
  const treeAt = (a) => Math.max(lastAt(a), ...(kids[a.id] || []).map(treeAt));
  const groupOf = (a) => needsYou(a) ? 'need' : a.status === 'running' ? 'run' : now - treeAt(a) < 864e5 ? 'recent' : 'old';
  // a sub-agent that needs you or is running shows in that group itself (with its parent's name), not inside a quieter parent
  const promoted = (a) => nestable(a) && ['need', 'run'].includes(groupOf(a)) && groupOf(a) !== groupOf(agents[a.parentId]);
  const roots = others.filter((a) => !nestable(a) || promoted(a));
  const byAt = (x, y) => treeAt(y) - treeAt(x);
  const inTree = (a, id) => a.id === id || (kids[a.id] || []).some((k) => !promoted(k) && inTree(k, id));
  function addTree(box, a, depth, g) {
    const r = rowEl(a, { parent: promoted(a) ? agents[a.parentId].name : '' }); r.style.setProperty('--d', depth); box.append(r);
    const ks = (kids[a.id] || []).filter((k) => !promoted(k)).sort(byAt);
    if (!ks.length) return;
    const busy = ks.filter((k) => k.status === 'running').length, open = (kOpen[a.id] ?? g !== 'old') || (sel && ks.some((k) => inTree(k, sel)));
    const t = document.createElement('button'); t.type = 'button'; t.className = 'kids-t'; t.style.setProperty('--d', depth); t.setAttribute('aria-expanded', !!open);
    t.innerHTML = `${icon('chevron-right', 'car')}<span>${ks.length} sub-agent${ks.length === 1 ? '' : 's'}${busy ? ` · ${busy} running` : ''}</span>`;
    t.title = (open ? 'Hide' : 'Show') + ' the agents ' + a.name + ' started';
    t.onclick = () => { const o = sideLS('halay-skids', {}); o[a.id] = !open; sideSet('halay-skids', o); renderList(); };
    box.append(t);
    if (open) { const sub = document.createElement('div'); sub.className = 'kids'; sub.style.setProperty('--d', depth); box.append(sub); for (const k of ks) addTree(sub, k, depth + 1, g); }
  }
  const need = [];
  for (const [g, label] of GROUPS) {
    const rows = roots.filter((a) => groupOf(a) === g).sort(byAt);
    if (!rows.length) continue;
    if (g === 'need') need.push(...rows);
    const open = (gOpen[g] ?? g !== 'old') || (sel && rows.some((a) => inTree(a, sel)));
    const sec = document.createElement('section'); sec.className = 'sgrp ' + g + (open ? '' : ' shut');
    const h = document.createElement('button'); h.type = 'button'; h.className = 'sgh'; h.setAttribute('aria-expanded', !!open);
    h.innerHTML = `${icon('chevron-right', 'car')}<span>${label}</span><span class="n">${rows.length}</span>`;
    h.onclick = () => { const o = sideLS('halay-sgrp', {}); o[g] = !open; sideSet('halay-sgrp', o); renderList(); };
    sec.append(h);
    if (open) for (const a of rows) addTree(sec, a, 0, g);
    list.append(sec);
  }
  if (hid.length) {
    const open = showHid || (sel && hid.some((a) => a.id === sel));
    const sec = document.createElement('section'); sec.className = 'sgrp hid' + (open ? '' : ' shut');
    const h = document.createElement('button'); h.type = 'button'; h.className = 'sgh'; h.setAttribute('aria-expanded', !!open);
    h.innerHTML = `${icon('chevron-right', 'car')}<span>Hidden</span><span class="n">${hid.length}</span>`;
    h.title = 'Agents you hid from the list; they keep running and come back when they need you';
    h.onclick = () => { sideSet('halay-shid', !open); renderList(); };
    sec.append(h);
    if (open) for (const a of hid) { const r = rowEl(a); r.style.setProperty('--d', 0); sec.append(r); }
    list.append(sec);
  }
  // keep rows that didn't change (rebuilding them restarts the spinner and makes WebKit redraw their icons: flicker),
  // and start new spinners at the phase of the wall clock so a rebuilt one carries on where the old one was
  for (const r of list.querySelectorAll('.arow[data-id]')) {
    const o = old[r.dataset.id];
    if (o && o._sig === r._sig) r.replaceWith(o);
    else { const sp = r.querySelector('.st.running'); if (sp) sp.style.animationDelay = -(Date.now() % 800) + 'ms'; }
  }
  list.scrollTop = keep;
  // screen readers hear when an agent starts needing you
  if (liveNeed) { const fresh = need.filter((a) => !liveNeed.includes(a.id)); if (fresh.length) $('#slive').textContent = fresh.map((a) => `${a.name}: ${stateOf(a)[1]}`).join('. '); }
  liveNeed = need.map((a) => a.id);
  updateBadges();
}

// ---- notifications banner: shown by settings.js until enabled; dismissable, remembered here
$('#bnotifx').onclick = (e) => { e.stopPropagation(); localStorage.setItem('halay-nbar', 'off'); $('#nbar').classList.add('off'); };
if (localStorage.getItem('halay-nbar') === 'off') $('#nbar').classList.add('off');

// ---- todos (the agent's TodoWrite checklist), badges, title
const KIND_TXT = { done: 'done', error: 'error', blocked: 'needs approval', usage: 'usage', stuck: 'stuck', context: 'big context', room: 'room' };
const todoCounts = (todos = []) => ({
  total: todos.length,
  done: todos.filter((t) => t.status === 'completed').length,
  active: todos.filter((t) => t.status === 'in_progress').length,
  pending: todos.filter((t) => t.status !== 'completed' && t.status !== 'in_progress').length,
});

function renderTodos() {
  const box = $('#todos'); if (!box) return;
  const todos = agents[sel]?.todos || [], c = todoCounts(todos);
  if (box.dataset.for !== sel) { box.dataset.for = sel; box.open = c.done < c.total; } // finished lists start collapsed; your toggle sticks
  box.hidden = !c.total;
  if (!c.total) return;
  const cur = todos.find((t) => t.status === 'in_progress');
  box.querySelector('summary').textContent = `Todos · ${c.done}/${c.total} done` + (cur ? ' · ▶ ' + (cur.activeForm || cur.content) : '');
  const ul = box.querySelector('ul'); ul.innerHTML = '';
  for (const t of todos) {
    const li = document.createElement('li'); li.className = t.status;
    const ck = document.createElement('span'); ck.className = 'ck'; ck.textContent = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐';
    const tx = document.createElement('span'); tx.textContent = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    li.append(ck, tx); ul.append(li);
  }
}

let apprSig = '', swarmName = ''; // swarmName: this server's own peer name, so several open tabs are told apart

function updateBadges() {
  const ak = approvals.map((p) => p.agentId).join();
  if (ak !== apprSig) { apprSig = ak; queueList(); } // approvals move agents into "Needs you"
  const na = approvals.length, nq = tasks.filter((t) => t.status === 'queued').length;
  $('#nappr').hidden = !na; $('#nappr').textContent = na; $('#bappr').setAttribute('aria-label', 'Approvals' + (na ? `, ${na} waiting` : ''));
  $('#ntasks').hidden = !nq; $('#ntasks').textContent = nq; $('#btasks').setAttribute('aria-label', 'Tasks' + (nq ? `, ${nq} queued` : ''));
  const attn = Object.values(agents).filter((a) => a.attention || a.watchdog).length;
  const n = attn || na;
  document.title = (n ? `(${n}) ` : '') + (swarmName ? swarmName + ' · ' : '') + (document.querySelector('meta[name="application-name"]')?.content || 'halay'); // product name: index.html <head>
}

// ---- notifications: in-page toast always (plain-http Tailscale has no Notification API), browser notification if granted
// m.kind (server.js KIND_LABEL, plus plugin kinds) -> the toast's colour, icon and how long it stays
const NOTE_KIND = {
  done: ['ok', 'circle-check', 6000], error: ['err', 'circle-alert', 12000], blocked: ['warn', 'inbox', 12000],
  stuck: ['warn', 'hourglass', 12000], usage: ['warn', 'gauge', 12000], context: ['warn', 'layers', 12000], room: ['info', 'message-square', 6000],
};
function agentToast(m) {
  const [kind, ic, ms] = NOTE_KIND[m.kind] || ['info', 'bell', 8000];
  const label = m.label || KIND_TXT[m.kind] || '';
  // the server's text repeats the label ("needs approval: Bash · npm test") or the title (plugins: "title: body")
  let body = String(m.text || '');
  for (const pre of [label, m.name]) if (pre && body.startsWith(pre)) { body = body.slice(pre.length).replace(/^\s*[:·-]\s*/, ''); break; }
  const to = !m.agentId ? '/tasks' : m.kind === 'blocked' && approvals.length > 1 ? '/approvals' : '/a/' + m.agentId;
  toast({ title: m.name, label, body, kind, icon: m.label === 'has a question' ? 'circle-help' : ic, ms, open: () => go(to), openLabel: to === '/tasks' ? 'Open Tasks' : to === '/approvals' ? 'Open Approvals' : 'Open ' + m.name });
}
function onNotify(m) {
  if (m.agentId === sel && !document.hidden) return; // you are looking at it
  agentToast(m);
  navigator.vibrate?.(m.kind === 'done' ? 80 : [120, 60, 120]);
  if (window.Notification && Notification.permission === 'granted' && localStorage.getItem('halay-bn') !== 'off') {
    const to = m.agentId ? '/a/' + m.agentId : '/tasks'; // no agent: a schedule's skipped run
    const lb = m.label || KIND_TXT[m.kind], title = lb ? `${m.name} · ${lb}` : m.name, opts = { body: m.text, tag: m.agentId || m.name, icon: '/icon-192.png', data: { url: '/#' + to } };
    try {
      if (swReg) swReg.showNotification(title, opts); // same tag as the Web Push one, so they replace each other
      else { const n = new Notification(title, opts); n.onclick = () => { window.focus(); go(to); n.close(); }; }
    } catch {}
  }
}
// the conductor asks to show an agent: switch to it, unless you are typing (then offer it as a toast)
function onFocus(id) {
  const a = agents[id];
  if (!a || sel === id) return;
  const el = document.activeElement;
  if (el && el.matches('input, textarea, select, [contenteditable]') && (el.value || el.isContentEditable)) {
    toast({ title: a.name, label: 'started', body: 'The conductor started it for you. Open it when you are done typing.', kind: 'info', icon: 'compass', ms: 12000, open: () => go('/a/' + id), openLabel: 'Open ' + a.name });
  } else go('/a/' + id);
}
function markSeen(id) {
  const a = agents[id];
  if (!a?.attention || document.hidden) return;
  a.attention = null; renderList();
  api(`/agents/${id}/seen`, { method: 'POST' }).catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && sel) markSeen(sel); });

// ---- hide / unhide: long press (touch) or right-click opens a small menu; the choice is saved on the server
async function setHidden(id, hidden) {
  const a = agents[id]; if (!a) return;
  a.hidden = hidden; renderList();
  try { await api(`/agents/${id}/hidden`, { method: 'POST', body: { hidden } }); }
  catch (e) { a.hidden = !hidden; renderList(); flash(e.message, 'error'); }
}
function closeRowMenu() { document.querySelector('.rowmenu')?.remove(); }
function rowMenu(row, x, y) {
  const a = agents[row.dataset.id]; if (!a) return;
  closeRowMenu();
  const m = document.createElement('div'); m.className = 'rowmenu'; m.setAttribute('role', 'menu');
  const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem');
  b.innerHTML = icon(a.hidden ? 'eye' : 'eye-off') + '<span></span>';
  b.querySelector('span').textContent = a.hidden ? 'Show in list again' : 'Hide from recents';
  b.onclick = () => { closeRowMenu(); setHidden(a.id, !a.hidden); };
  const n = document.createElement('p'); n.textContent = a.hidden ? '' : `${a.name} keeps running; it comes back if it needs you.`;
  m.append(b); if (n.textContent) m.append(n);
  document.body.append(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
  b.focus();
}
(() => {
  const list = $('#list'); let timer = 0, sx = 0, sy = 0, fired = 0;
  const rowOf = (e) => { const r = e.target.closest?.('.arow[data-id]'); return r && !r.classList.contains('cond') ? r : null; };
  const cancel = () => { clearTimeout(timer); timer = 0; };
  list.addEventListener('pointerdown', (e) => {
    const r = rowOf(e); if (!r || e.pointerType === 'mouse') return;
    sx = e.clientX; sy = e.clientY; cancel();
    timer = setTimeout(() => { timer = 0; fired = Date.now(); navigator.vibrate?.(15); rowMenu(r, sx, sy); }, 500);
  });
  list.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel(); });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) list.addEventListener(t, cancel);
  list.addEventListener('scroll', cancel, { passive: true });
  list.addEventListener('contextmenu', (e) => { // desktop right-click; on touch it is the long press itself
    const r = rowOf(e); if (!r) return;
    e.preventDefault(); if (!fired || Date.now() - fired > 800) rowMenu(r, e.clientX, e.clientY);
  });
  list.addEventListener('click', (e) => { if (fired && Date.now() - fired < 800 && rowOf(e)) { e.preventDefault(); e.stopPropagation(); } }, true); // the release after a long press is not a tap
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.rowmenu')) closeRowMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRowMenu(); });
  addEventListener('scroll', closeRowMenu, true);
})();
