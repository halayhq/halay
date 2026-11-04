// ---- approvals inbox: every open permission request, answerable without opening the chat
function renderApprovals() {
  const l = $('#alist'); if (!l) return;
  l.innerHTML = '';
  if (!approvals.length) { l.innerHTML = estate('inbox', 'Nothing is waiting for you', 'When an agent asks for permission to run a tool, or asks you a question, it shows up here as well as in its chat.'); return; }
  for (const r of approvals) {
    const d = document.createElement('div');
    d.className = 'msg perm';
    if (r.kind === 'question') { // AskUserQuestion: answered right here (askForm is in chat.js)
      d.classList.add('askc');
      d.innerHTML = `<a class="an"></a><b>${icon('message-square', 'ti')} has a question</b>`;
      d.querySelector('.an').textContent = r.agentName;
      d.querySelector('.an').onclick = () => go('/a/' + r.agentId);
      d.append(askForm({ title: r.title, questions: r.questions }, (body) => api('/approvals/' + r.reqId, { method: 'POST', body })));
      l.append(d);
      continue;
    }
    d.innerHTML = `<a class="an"></a><b>Allow <span class="tn"></span>?</b><code></code><div class="btns"><button class="primary" data-d="allow">Allow</button><button data-d="always">Always allow</button><button data-d="deny">Deny</button></div>`;
    d.querySelector('.an').textContent = r.agentName;
    d.querySelector('.an').onclick = () => go('/a/' + r.agentId);
    d.querySelector('.tn').textContent = r.tool_name;
    d.querySelector('code').textContent = r.preview;
    d.querySelector('[data-d=always]').title = 'Saves ' + r.rule + ' to the project\'s .claude/settings.local.json';
    d.querySelectorAll('button').forEach((b) => b.onclick = () => { d.querySelectorAll('button').forEach((x) => x.disabled = true); api('/approvals/' + r.reqId, { method: 'POST', body: { decision: b.dataset.d } }).catch((e) => { flash(e.message, 'error'); d.querySelectorAll('button').forEach((x) => x.disabled = false); }); });
    l.append(d);
  }
}
OPENERS.approvals = async () => {
  $('#alist').innerHTML = skel(2); $('#adlg').showModal();
  try { approvals = await api('/approvals'); } catch (e) { flash(e.message, 'error'); }
  renderApprovals(); updateBadges();
};
$('#bappr').onclick = () => go('/approvals');
$('#aclose').onclick = () => $('#adlg').close();

// ---- tasks: swarm-wide backlog
let editingTask = null;
const taskApi = (path, method, body) => api('/tasks' + path, { method, body }).catch((e) => { flash(e.message, 'error'); throw e; });

const backlog = () => tasks.filter((t) => !t.scheduledFrom); // scheduled runs are listed under their schedule
function renderTasks() {
  const l = $('#tlist'); if (!l) return;
  l.innerHTML = '';
  const byId = new Map(tasks.map((t) => [t.id, t])), list = backlog();
  if (!list.length && $('#tform').hidden) {
    l.innerHTML = estate('list-todo', 'No tasks yet', 'A task is a prompt waiting for an agent. Queue work, order it or make one task wait for another, then start each one when you are ready (or automatically). You can also ask the Swarm chat to add tasks.');
    const b = mk('button', 'primary'); b.innerHTML = icon('plus') + '<span>New task</span>'; b.onclick = () => editTask(null, true); l.firstChild.append(b);
  }
  list.forEach((t, i) => {
    const d = mk('div', 'task');
    const tt = mk('div', 'tt'), tb0 = mk('b'); tb0.append(mk('span', 'tid', '#' + t.id), t.title); tt.append(tb0, mk('span', 'st-chip ' + t.state, t.state)); d.append(tt);
    if (t.dependsOn.length || t.autoStart) {
      const dc = mk('div', 'deps');
      for (const id of t.dependsOn) { const x = byId.get(id); dc.append(mk('span', 'dep-chip ' + (x ? x.status : 'gone'), x ? `← #${id} ${x.title.slice(0, 28)} · ${x.status}` : `← #${id} (deleted)`)); }
      if (t.autoStart) { const c = mk('span', 'dep-chip'); c.innerHTML = icon('zap') + ' auto-start'; dc.append(c); }
      d.append(dc);
    }
    if (t.blockedBy) d.append(mk('div', 'tblock', 'Blocked: ' + t.blockedBy + '. It will not start until you fix the dependency (requeue it, or edit this task).'));
    const meta = [t.addedBy && 'from ' + t.addedBy.replace(/^peer:/, 'peer '), t.cwd, t.account, [t.model, t.effort && 'effort ' + t.effort].filter(Boolean).join(' '), t.agentId && agents[t.agentId] ? '→ ' + agents[t.agentId].name : '', t.result ? '“' + t.result.replace(/\s+/g, ' ').slice(0, 140) + '”' : ''].filter(Boolean).join(' · ');
    if (meta) d.append(mk('small', '', meta));
    if (t.prompt) d.append(mk('small', '', t.prompt.replace(/\s+/g, ' ').slice(0, 160)));
    const tb = mk('div', 'tb');
    const btn = (txt, f, cls, title, ic) => tbtn(tb, txt, f, cls, title, ic);
    btn('', () => moveTask(i, -1), 'icb', 'Move up', 'chevron-up').disabled = i === 0;
    btn('', () => moveTask(i, 1), 'icb', 'Move down', 'chevron-down').disabled = i === list.length - 1;
    if (t.status === 'queued') {
      const b = btn(t.state === 'ready' ? 'Assign…' : t.state === 'blocked' ? 'Blocked' : 'Waiting…', () => assignPanel(t, d), 'primary', t.blockedBy || (t.waitingOn.length ? 'waiting for ' + t.waitingOn.map((n) => '#' + n).join(', ') : ''));
      b.disabled = t.state !== 'ready';
    }
    else if (t.status === 'running') btn('Mark done', () => taskApi('/' + t.id, 'PATCH', { status: 'done' }));
    else btn('Requeue', () => taskApi('/' + t.id, 'PATCH', { status: 'queued' }));
    tb.append(mk('span', 'grow'));
    btn('', () => editTask(t, true), 'icb', 'Edit task', 'pencil');
    btn('', async () => { if (await ask('Delete this task?' + (tasks.some((x) => x.dependsOn.includes(t.id)) ? ' Tasks that depend on it become blocked.' : ''), { ok: 'Delete', danger: true })) taskApi('/' + t.id, 'DELETE'); }, 'icb', 'Delete task', 'trash-2');
    d.append(tb);
    l.append(d);
  });
  $('#cwds').innerHTML = '';
  for (const c of new Set([...Object.values(agents).map((a) => a.cwd), ...tasks.map((t) => t.cwd)].filter(Boolean))) { const o = mk('option'); o.value = c; $('#cwds').append(o); }
  renderDepPicker();
  renderSchedules();
}
function renderDepPicker(selected) {
  const box = $('#tdeps'); if (!box) return;
  const keep = selected || new Set([...box.querySelectorAll('input:checked')].map((x) => Number(x.value)));
  box.innerHTML = '';
  const others = backlog().filter((t) => t.id !== editingTask);
  if (!others.length) box.append(mk('div', 'mutl', 'No other tasks to depend on.'));
  for (const t of others) {
    const lab = mk('label', 'chk'), cb = mk('input'); cb.type = 'checkbox'; cb.value = t.id; cb.checked = keep.has(t.id);
    lab.append(cb, mk('span', '', `#${t.id} ${t.title} · ${t.state}`)); box.append(lab);
  }
}
function moveTask(i, dir) {
  const ids = backlog().map((t) => t.id); [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
  tasks = [...ids.map((id) => tasks.find((t) => t.id === id)), ...tasks.filter((t) => t.scheduledFrom)]; renderTasks();
  taskApi('/reorder', 'POST', { ids }).catch(() => {});
}
function assignPanel(t, row) {
  row.querySelector('.assign')?.remove();
  const box = mk('div', 'tb assign');
  const sel2 = mk('select', 'fld');
  const idle = Object.values(agents).filter((a) => (a.status === 'idle' || a.status === 'stopped') && a.role !== 'conductor');
  const newOpt = mk('option', '', t.cwd ? 'New agent in ' + t.cwd : 'New agent (set a folder first)');
  newOpt.value = ''; sel2.append(newOpt);
  for (const a of idle) { const o = mk('option', '', `${a.name} (${a.status}) · ${a.cwd}`); o.value = a.id; sel2.append(o); }
  const go2 = mk('button', 'primary', 'Start');
  go2.onclick = async () => {
    go2.disabled = true;
    try { const r = await taskApi(`/${t.id}/assign`, 'POST', { agentId: sel2.value || undefined }); go('/a/' + r.agent.id); }
    catch { go2.disabled = false; }
  };
  const cancel = mk('button', '', 'Cancel'); cancel.onclick = () => box.remove();
  box.append(sel2, go2, cancel); row.append(box);
}
// a small toolbar button; icon-only ones get the title as their accessible name
function tbtn(bar, txt, f, cls, title, ic) {
  const b = mk('button', cls || '');
  b.type = 'button';
  if (ic) b.innerHTML = icon(ic) + (txt ? `<span>${esc(txt)}</span>` : ''); else b.textContent = txt;
  if (title) { b.title = title; if (!txt) b.setAttribute('aria-label', title); }
  b.onclick = f; bar.append(b); return b;
}
// the backlog form is shown on demand (+ New task, Edit) and hidden again after save or cancel
function editTask(t, show) {
  editingTask = t ? t.id : null;
  $('#ttitle').value = t?.title || ''; $('#tprompt').value = t?.prompt || ''; $('#tcwd').value = t?.cwd || ''; $('#tacct').value = t?.account || '';
  fillModelSelect($('#tmodel'), t?.model); fillEffortSelect($('#teffort'), t?.effort);
  $('#tauto').checked = !!t?.autoStart; renderDepPicker(new Set(t?.dependsOn || []));
  $('#tformh').textContent = t ? `Edit task #${t.id}` : 'New task';
  $('#tsave').textContent = t ? 'Save task' : 'Add task';
  $('#tform').hidden = !show;
  if (show) { renderTasks(); $('#tform').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); $('#ttitle').focus({ preventScroll: true }); }
  else renderTasks();
  syncTaskFoot();
}
$('#tnew').onclick = () => editTask(null, true);
$('#tsave').onclick = async () => {
  const body = { title: $('#ttitle').value, prompt: $('#tprompt').value, cwd: $('#tcwd').value, account: $('#tacct').value, model: $('#tmodel').value, effort: $('#teffort').value, autoStart: $('#tauto').checked, dependsOn: [...$('#tdeps').querySelectorAll('input:checked')].map((x) => Number(x.value)) };
  if (!body.title.trim()) { $('#ttitle').focus(); return; }
  try { await taskApi(editingTask ? '/' + editingTask : '', editingTask ? 'PATCH' : 'POST', body); flash(editingTask ? 'Task saved' : 'Task added', 'ok'); editTask(null); } catch {}
};
$('#tcancel').onclick = () => editTask(null);
$('#tclose').onclick = () => $('#tdlg').close();
$('#btasks').onclick = () => go('/tasks');
OPENERS.tasks = async () => {
  $('#tlist').innerHTML = skel(3); $('#slist').innerHTML = skel(2); $('#tform').hidden = true; closeSchedForm();
  $('#tdlg').showModal();
  const { names: accts, def } = await accountsWithDefault();
  $('#tacct').innerHTML = `<option value="">Default account (${esc(def)})</option>` + accts.map((a) => `<option>${esc(a)}</option>`).join('');
  $('#sfacct').innerHTML = `<option value="">Default account (${esc(def)})</option>` + accts.map((a) => `<option>${esc(a)}</option>`).join('');
  [tasks, schedules] = await Promise.all([api('/tasks'), api('/schedules')]); editTask(null);
};

