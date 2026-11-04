// ---- Rooms: group chats between agents and you. #/rooms lists them, #/rooms/<id> is one room.
// Member status comes live from `agents` (and `approvals` for blocked); messages stream over the websocket (room_msg).
let rooms = {}, curRoom = null, roomLog = [], roomForm = null; // roomForm: null | 'new' | room id being edited
const roomHash = () => { const p = location.hash.replace(/^#\/?/, '').split('/'); return p[0] === 'rooms' ? Number(p[1]) || null : undefined; };
const roomList = () => Object.values(rooms).sort((a, b) => b.updatedAt - a.updatedAt);

function avatar(name, id) {
  const a = mk('span', 'av', (String(name).trim().match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase());
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  a.style.background = id === 'user' ? 'var(--acc)' : `var(--c${(h % 8) + 1})`;
  if (id === 'user') a.style.color = 'var(--on-acc)';
  return a;
}
const memberState = (m) => {
  const a = agents[m.id];
  return !a ? 'gone' : approvals.some((p) => p.agentId === m.id) ? 'blocked' : a.status;
};

async function loadRooms() {
  rooms = Object.fromEntries((await api('/rooms')).map((r) => [r.id, r]));
  roomBadge();
  if ($('#rmdlg').open) renderRooms();
}
function roomBadge() {
  const n = roomList().filter((r) => r.status === 'paused').length;
  $('#nrooms').hidden = !n; $('#nrooms').textContent = n; $('#nrooms').classList.toggle('mut', false);
  $('#brooms').setAttribute('aria-label', 'Rooms' + (n ? `, ${n} paused` : ''));
}
function onRoom(r) {
  rooms[r.id] = r; roomBadge();
  if ($('#rmdlg').open) renderRooms();
}
function onRoomMsg({ roomId, message }) {
  if (roomId !== curRoom || roomLog.some((m) => m.id === message.id)) return;
  roomLog.push(message);
  const l = $('#rmlog'), near = l.scrollHeight - l.scrollTop - l.clientHeight < 120;
  l.append(roomMsgEl(message));
  if (near || message.sender === 'user') scrollRoom();
}
const scrollRoom = () => { const l = $('#rmlog'); l.scrollTop = l.scrollHeight; };

// ---- views
function renderRooms() {
  const id = roomHash();
  const inForm = roomForm !== null;
  const view = id && rooms[id] && !inForm;
  $('#rmlist').hidden = !!view || inForm; $('#rmview').hidden = !view; $('#rmform').hidden = !inForm;
  $('#rmback').hidden = !view && !inForm; $('#rmedit').hidden = !view; $('#rmcomp').hidden = !view;
  $('#rmfoot').hidden = !!view || inForm;
  document.body.classList.toggle('inroom', !!view);
  if (inForm) return;
  if (!view) { curRoom = null; $('#rmhead').textContent = 'Rooms'; $('#rmsub').textContent = 'Group chats where agents hand work to each other'; return renderRoomList(); }
  const r = rooms[id];
  $('#rmhead').textContent = r.name; $('#rmsub').textContent = r.goal || 'No goal set';
  renderRoomMembers(); renderRoomBanner(r);
  if (curRoom !== id) openRoom(id);
}
function renderRoomList() {
  const l = $('#rmlist'); l.innerHTML = '';
  const all = roomList(), live = all.filter((r) => r.status !== 'archived'), old = all.filter((r) => r.status === 'archived');
  if (!all.length) {
    l.innerHTML = estate('message-square', 'No rooms yet', 'A room is a group chat between agents and you: a researcher, a writer and a reviewer can pass work along with @mentions without you in the middle. Ask the Swarm chat to set one up, or create one here.');
    return;
  }
  const row = (r) => {
    const d = mk('button', 'rmrow'); d.type = 'button';
    const top = mk('div', 'rmt'), nm = mk('b', '', r.name);
    top.append(nm, mk('span', 'st-chip rm-' + r.status, r.status === 'paused' ? 'paused · budget reached' : r.status));
    const av = mk('div', 'rmavs');
    for (const m of r.members.slice(0, 6)) { const a = avatar(m.name, m.id); a.title = m.name; av.append(a); }
    if (r.members.length > 6) av.append(mk('span', 'mutl', '+' + (r.members.length - 6)));
    if (!r.members.length) av.append(mk('span', 'mutl', 'no members'));
    d.append(top, av);
    if (r.last) d.append(mk('small', 'rmlast', (r.last.kind === 'system' ? '' : r.last.name + ': ') + r.last.text.replace(/\s+/g, ' ').slice(0, 140)));
    d.onclick = () => go('/rooms/' + r.id);
    return d;
  };
  for (const r of live) l.append(row(r));
  if (old.length) { const det = mk('details', 'rmold'); det.append(mk('summary', '', `Archived (${old.length})`)); for (const r of old) det.append(row(r)); l.append(det); }
}
function renderRoomMembers() {
  const r = rooms[curRoom ?? roomHash()], box = $('#rmmembers'); if (!r) return;
  box.innerHTML = '';
  for (const m of r.members) {
    const st = memberState(m), a = mk('a', 'rmmem');
    a.href = '#/a/' + m.id; a.title = `Open ${m.name}'s own chat`;
    a.append(avatar(m.name, m.id), mk('span', 'rmn', m.name), mk('span', 'dot ' + (st === 'blocked' ? 'error' : st)), mk('small', st === 'blocked' ? 'rmblk' : '', st === 'blocked' ? (blockedTxt(m.id) === 'has a question' ? 'waiting for your answer' : 'blocked on approval') : st));
    box.append(a);
  }
  if (!r.members.length) box.append(mk('span', 'mutl', 'No members yet: open settings (top right) to add agents.'));
}
function renderRoomBanner(r) {
  const b = $('#rmbanner'); b.innerHTML = ''; b.hidden = false; b.className = 'rm-' + r.status;
  b.append(mk('span', '', `Agent turns ${r.used}/${r.budget} until you speak again`));
  if (r.status === 'paused') {
    b.prepend(mk('b', '', 'Paused, budget reached. '));
    const btn = mk('button', 'primary', 'Resume'); btn.type = 'button'; btn.onclick = () => api(`/rooms/${r.id}/resume`, { method: 'POST' }).catch((e) => flash(e.message, 'error'));
    b.append(btn);
  } else if (r.status === 'done') b.prepend(mk('b', '', 'Done: '), mk('span', '', r.summary + ' · '));
  else if (r.status === 'archived') b.prepend(mk('b', '', 'Archived. '));
}

async function openRoom(id) {
  curRoom = id; roomLog = []; $('#rmlog').innerHTML = '';
  try {
    const r = await api(`/rooms/${id}?limit=200`);
    if (curRoom !== id) return;
    rooms[id] = (({ thread, ...x }) => x)(r);
    roomLog = r.thread;
    const l = $('#rmlog'); l.innerHTML = '';
    if (!roomLog.length) l.append(mk('div', 'mutl', 'No messages yet. Mention a member with @ to start.'));
    for (const m of roomLog) l.append(roomMsgEl(m));
    renderRoomMembers(); renderRoomBanner(rooms[id]);
    scrollRoom();
  } catch (e) { flash(e.message, 'error'); }
}

// text with @handles highlighted; agents' replies are markdown
function roomMsgEl(m) {
  if (m.kind === 'system' || m.kind === 'done') { const d = mk('div', 'rmsys' + (m.kind === 'done' ? ' done' : ''), m.text); d.title = new Date(m.ts).toLocaleString(); return d; }
  const d = mk('div', 'rmmsg' + (m.sender === 'user' ? ' me' : ''));
  const head = mk('div', 'rmh');
  const who = m.sender === 'user' ? mk('b', '', 'You') : mk('a', 'rmwho', m.name);
  if (m.sender !== 'user') { who.href = '#/a/' + m.sender; who.title = "Open this agent's own chat"; }
  head.append(who, mk('time', '', new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  const body = mk('div', 'rmbody md');
  body.innerHTML = renderMd(m.text);
  const w = document.createTreeWalker(body, NodeFilter.SHOW_TEXT), hits = [];
  for (let n; (n = w.nextNode());) if (!n.parentElement.closest('code, pre, a') && /(^|[^\w@.-])@[a-z0-9]/i.test(n.nodeValue)) hits.push(n);
  for (const n of hits) {
    const f = document.createDocumentFragment();
    n.nodeValue.split(/((?:^|(?<=[^\w@.-]))@[a-z0-9][a-z0-9-]*)/i).forEach((part) => f.append(part.startsWith('@') ? mk('span', 'rmen' + (/^@(user|you)$/i.test(part) ? ' u' : ''), part) : part));
    n.replaceWith(f);
  }
  d.append(avatar(m.sender === 'user' ? 'You' : m.name, m.sender), (() => { const c = mk('div', 'rmc'); c.append(head, body); return c; })());
  return d;
}

// ---- composer with @mention autocomplete
let acItems = [], acIdx = 0;
function acUpdate() {
  const t = $('#rmtxt'), r = rooms[curRoom], box = $('#rmac');
  const m = r && t.value.slice(0, t.selectionStart).match(/(?:^|\s)@([a-z0-9-]*)$/i);
  if (!m) { box.hidden = true; acItems = []; return; }
  const q = m[1].toLowerCase();
  acItems = [...r.members.map((x) => ({ h: x.handle, name: x.name, id: x.id })), { h: 'all', name: 'Everyone in the room', id: 'all' }].filter((x) => x.h.startsWith(q)).slice(0, 6);
  acIdx = Math.min(acIdx, Math.max(acItems.length - 1, 0));
  box.hidden = !acItems.length; box.innerHTML = '';
  acItems.forEach((x, i) => {
    const o = mk('div', 'rmopt' + (i === acIdx ? ' on' : '')); o.setAttribute('role', 'option');
    o.append(avatar(x.name, x.id), mk('b', '', '@' + x.h), mk('small', '', x.name));
    o.onmousedown = (e) => { e.preventDefault(); acPick(i); };
    box.append(o);
  });
}
function acPick(i) {
  const t = $('#rmtxt'), x = acItems[i]; if (!x) return;
  const before = t.value.slice(0, t.selectionStart).replace(/@[a-z0-9-]*$/i, '@' + x.h + ' ');
  t.value = before + t.value.slice(t.selectionStart); t.setSelectionRange(before.length, before.length);
  t.focus(); acUpdate();
}
const fitComposer = () => { const t = $('#rmtxt'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 140) + 'px'; };
$('#rmtxt').addEventListener('input', () => { acUpdate(); fitComposer(); });
$('#rmtxt').addEventListener('keydown', (e) => {
  if (!$('#rmac').hidden && acItems.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); acIdx = (acIdx + (e.key === 'ArrowDown' ? 1 : acItems.length - 1)) % acItems.length; return acUpdate(); }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return acPick(acIdx); }
    if (e.key === 'Escape') { e.preventDefault(); $('#rmac').hidden = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); $('#rmcomp').requestSubmit(); }
});
$('#rmtxt').addEventListener('blur', () => { $('#rmac').hidden = true; });
$('#rmcomp').onsubmit = async () => {
  const t = $('#rmtxt'), text = t.value.trim(); if (!text || curRoom == null) return;
  t.value = ''; fitComposer(); $('#rmac').hidden = true;
  try { await api(`/rooms/${curRoom}/messages`, { method: 'POST', body: { text } }); }
  catch (e) { t.value = text; fitComposer(); flash(e.message, 'error'); }
};

// ---- create / edit
function openRoomForm(which) {
  roomForm = which;
  const r = which === 'new' ? null : rooms[which], f = $('#rmform');
  f.innerHTML = '';
  const field = (label, el) => { const l = mk('label', 'fl', label); l.append(el); return l; };
  const name = mk('input', 'fld'); name.value = r?.name || ''; name.placeholder = 'e.g. Launch post'; name.autocomplete = 'off';
  const goal = mk('textarea', 'fld'); goal.value = r?.goal || ''; goal.placeholder = 'What should the room achieve, and what does done look like? (optional)'; goal.rows = 3;
  const budget = mk('input', 'fld'); budget.type = 'number'; budget.min = 1; budget.max = 500; budget.inputMode = 'numeric'; budget.value = r?.budget ?? 20;
  const mem = mk('div', 'rmpick'), have = new Set(r?.members.map((m) => m.id) || []);
  for (const a of Object.values(agents).sort((x, y) => x.name.localeCompare(y.name))) {
    const l = mk('label', 'chk'), c = document.createElement('input'); c.type = 'checkbox'; c.value = a.id; c.checked = have.has(a.id);
    l.append(c, avatar(a.name, a.id), mk('span', '', a.name), mk('small', 'mutl', (a.role === 'conductor' ? 'swarm chat' : lastSeg(a.cwd)) + ' · ' + a.id));
    mem.append(l);
  }
  const row = mk('div', 'row'), save = mk('button', 'primary', r ? 'Save' : 'Create room'), cancel = mk('button', '', 'Cancel');
  save.type = cancel.type = 'button';
  row.append(mk('span', 'sp'));
  if (r) {
    const arch = mk('button', r.status === 'archived' ? '' : 'danger', r.status === 'archived' ? 'Unarchive' : 'Archive'); arch.type = 'button';
    arch.onclick = async () => { try { await api('/rooms/' + r.id, { method: 'PATCH', body: { archived: r.status !== 'archived' } }); roomForm = null; go('/rooms'); } catch (e) { flash(e.message, 'error'); } };
    row.prepend(arch);
  }
  row.append(cancel, save);
  f.append(mk('b', '', r ? 'Room settings' : 'New room'), field('Name', name), field('Goal', goal), field('Max agent-triggered turns until you speak again (loop safety)', budget), mk('div', 'dsub', 'Members'), mem, row);
  cancel.onclick = () => { roomForm = null; renderRooms(); };
  save.onclick = async () => {
    const ids = [...mem.querySelectorAll('input:checked')].map((c) => c.value);
    save.disabled = true;
    try {
      let id = r?.id;
      if (r) {
        await api('/rooms/' + id, { method: 'PATCH', body: { name: name.value, goal: goal.value, budget: Number(budget.value) } });
        for (const m of r.members) if (!ids.includes(m.id)) await api(`/rooms/${id}/members/${encodeURIComponent(m.id)}`, { method: 'DELETE' });
        for (const a of ids) if (!have.has(a)) await api(`/rooms/${id}/members`, { method: 'POST', body: { agentId: a } });
      } else id = (await api('/rooms', { method: 'POST', body: { name: name.value, goal: goal.value, budget: Number(budget.value), members: ids } })).id;
      roomForm = null; curRoom = null; go('/rooms/' + id); renderRooms();
    } catch (e) { flash(e.message, 'error'); } finally { save.disabled = false; }
  };
  $('#rmhead').textContent = r ? r.name : 'New room'; $('#rmsub').textContent = '';
  renderRooms(); name.focus();
}

OPENERS.rooms = async () => {
  roomForm = null; curRoom = null;
  $('#rmdlg').showModal();
  await loadRooms().catch((e) => flash(e.message, 'error'));
  renderRooms();
};
window.addEventListener('hashchange', () => { if ($('#rmdlg').open && roomHash() !== undefined) { roomForm = null; renderRooms(); } });
$('#brooms').onclick = () => go('/rooms');
$('#rmnew').onclick = () => openRoomForm('new');
$('#rmedit').onclick = () => openRoomForm(roomHash());
$('#rmback').onclick = () => { if (roomForm !== null) { roomForm = null; renderRooms(); } else go('/rooms'); };
