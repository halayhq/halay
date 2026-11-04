// ---- schedules: recurring tasks, in the Tasks panel's second tab. Each run is a task (scheduledFrom) on a new agent.
let editingSched = null, schedTab = localStorage.getItem('halay-ttab') === 's' ? 's' : 'b';
const openRuns = new Set(); // schedules whose run history is expanded
const schedApi = (path, method, body) => api('/schedules' + path, { method, body }).catch((e) => { flash(e.message, 'error'); throw e; });
const sWhen = (ts) => (ts ? new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const sIn = (ts) => { const m = Math.round((ts - Date.now()) / 60000); return m < 1 ? 'due now' : m < 60 ? `in ${m} min` : m < 1440 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} d`; };

function showTab(t) {
  schedTab = t; localStorage.setItem('halay-ttab', t);
  $('#ttabb').classList.toggle('on', t === 'b'); $('#ttabs').classList.toggle('on', t === 's');
  $('#ttabb').setAttribute('aria-selected', t === 'b'); $('#ttabs').setAttribute('aria-selected', t === 's');
  $('#tpaneb').hidden = t !== 'b'; $('#tpanes').hidden = t !== 's';
  syncTaskFoot();
}
// footer: "+ New task" or "+ New schedule" for the open tab, hidden while its form is open
function syncTaskFoot() {
  $('#tnew').hidden = schedTab !== 'b' || !$('#tform').hidden;
  $('#snew').hidden = schedTab !== 's' || !$('#sform').hidden;
}
$('#ttabb').onclick = () => showTab('b');
$('#ttabs').onclick = () => showTab('s');
showTab(schedTab);

function renderSchedules() {
  const l = $('#slist'); if (!l) return;
  const on = schedules.filter((s) => s.enabled).length;
  $('#nsched').hidden = !on; $('#nsched').textContent = on;
  l.innerHTML = '';
  if (!schedules.length && $('#sform').hidden) {
    l.innerHTML = estate('calendar-clock', 'No schedules yet', 'A schedule starts a new agent with the same prompt on a timetable, for example "every weekday at 9, summarize my open PRs". You can also ask the Swarm chat to set one up.');
    const b = mk('button', 'primary'); b.innerHTML = icon('plus') + '<span>New schedule</span>'; b.onclick = () => editSched(null); l.firstChild.append(b);
  }
  for (const s of schedules) {
    const runs = tasks.filter((t) => t.scheduledFrom === s.id).sort((a, b) => b.id - a.id);
    const d = mk('div', 'task sched' + (s.enabled ? '' : ' off'));
    const tt = mk('div', 'tt'); tt.append(mk('b', '', s.title));
    if (s.lastStatus) tt.append(mk('span', 'st-chip ' + s.lastStatus, s.lastStatus));
    const tog = mk('label', 'chk stog'), cb = mk('input'); cb.type = 'checkbox'; cb.className = 'sw'; cb.checked = s.enabled; cb.title = s.enabled ? 'Enabled: tap to pause' : 'Paused: tap to enable';
    cb.setAttribute('role', 'switch'); cb.setAttribute('aria-label', `Schedule ${s.title} enabled`);
    cb.onchange = () => schedApi('/' + s.id, 'PATCH', { enabled: cb.checked }).catch(() => { cb.checked = !cb.checked; });
    tog.append(mk('span', '', s.enabled ? 'On' : 'Paused'), cb); tt.append(tog);
    d.append(tt);
    const desc = mk('div', 'sdesc'); desc.innerHTML = icon('clock'); desc.append(`${s.description} · ${s.tz}`); d.append(desc);
    const when = mk('div', 'swhen'), wl = (k, v) => { const x = mk('span', '', k + ' '); x.append(mk('b', '', v)); when.append(x); };
    wl('Next', s.enabled ? (s.nextRunAt ? `${sWhen(s.nextRunAt)} (${sIn(s.nextRunAt)})` : '—') : 'paused');
    wl('Last', sWhen(s.lastRunAt));
    d.append(when);
    if (s.skippedAt && s.skippedAt > (s.lastRunAt || 0)) d.append(mk('div', 'tblock', `Skipped ${sWhen(s.skippedAt)}: ${s.skipReason}`));
    const meta = [s.oneOff ? 'one-off folder' : s.cwd, s.account || 'claude', s.permissionMode, [s.model, s.effort && 'effort ' + s.effort].filter(Boolean).join(' '), s.overlap === 'queue' ? 'queues overlapping runs' : 'skips overlapping runs', { always: 'notifies every run', failure: 'notifies on failure', alert: 'notifies on ALERT:' }[s.notify], `keeps ${s.keepAgents} agent${s.keepAgents === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
    d.append(mk('small', '', meta));
    if (s.prompt) d.append(mk('small', '', s.prompt.replace(/\s+/g, ' ').slice(0, 160)));
    const tb = mk('div', 'tb');
    const btn = (txt, f, cls, title, ic) => tbtn(tb, txt, f, cls, title, ic);
    const running = s.lastStatus === 'running';
    const rb = btn(running ? 'Running…' : 'Run now', async () => { rb.disabled = true; try { const r = await schedApi(`/${s.id}/run`, 'POST'); if (r.agent) go('/a/' + r.agent.id); } catch { rb.disabled = false; } }, 'primary', '', 'play');
    rb.disabled = running;
    const rr = btn(`Runs (${runs.length})`, () => { openRuns.has(s.id) ? openRuns.delete(s.id) : openRuns.add(s.id); renderSchedules(); }, '', '', openRuns.has(s.id) ? 'chevron-up' : 'chevron-down');
    rr.setAttribute('aria-expanded', openRuns.has(s.id));
    tb.append(mk('span', 'grow'));
    btn('', () => editSched(s), 'icb', 'Edit schedule', 'pencil');
    btn('', async () => { if (await ask(`Delete the schedule "${s.title}" and its run history? Its agents stay until you remove them.`, { ok: 'Delete', danger: true })) schedApi('/' + s.id, 'DELETE'); }, 'icb', 'Delete schedule', 'trash-2');
    d.append(tb);
    if (openRuns.has(s.id)) {
      const h = mk('div', 'sruns');
      if (!runs.length) h.append(mk('div', 'mutl', 'No runs yet.'));
      for (const t of runs.slice(0, 30)) {
        const r = mk('div', 'srun');
        const top = mk('div', 'tt'); top.append(mk('span', '', `#${t.id} · ${sWhen(t.createdAt)}`), mk('span', 'st-chip ' + t.status, t.status));
        r.append(top);
        if (t.result) r.append(mk('small', '', t.result.replace(/\s+/g, ' ').slice(0, 240)));
        if (t.agentId && agents[t.agentId]) { const a = mk('a', 'srl', 'Open agent → ' + agents[t.agentId].name); a.href = '#/a/' + t.agentId; r.append(a); }
        h.append(r);
      }
      if (runs.length > 30) h.append(mk('div', 'mutl', `…and ${runs.length - 30} older runs`));
      d.append(h);
    }
    l.append(d);
  }
}

// form: live check of the cron (description and the next runs) as you type
let prevT;
function previewCron() {
  clearTimeout(prevT);
  prevT = setTimeout(async () => {
    const cron = $('#sfcron').value.trim(), tz = $('#sftz').value.trim(), out = $('#sfprev');
    if (!cron) { out.textContent = ''; return; }
    try {
      const r = await api(`/schedules/preview?cron=${encodeURIComponent(cron)}&tz=${encodeURIComponent(tz)}`);
      out.className = 'mutl'; out.textContent = `${r.description} (${r.tz}). Next: ${r.next.map(sWhen).join(', ')}`;
    } catch (e) { out.className = 'tblock'; out.textContent = e.message; }
  }, 250);
}
$('#sfcron').oninput = previewCron;
$('#sftz').oninput = previewCron;
document.querySelectorAll('.spresets button').forEach((b) => b.onclick = () => { $('#sfcron').value = b.dataset.c; previewCron(); });
$('#sfoo').onchange = () => { $('#sfcwd').hidden = $('#sfoo').checked; };

function editSched(s) {
  editingSched = s ? s.id : null;
  if (!$('#tzs').children.length) for (const z of Intl.supportedValuesOf?.('timeZone') || []) { const o = mk('option'); o.value = z; $('#tzs').append(o); }
  $('#sftitle').value = s?.title || ''; $('#sfprompt').value = s?.prompt || '';
  $('#sfoo').checked = !!s?.oneOff; $('#sfcwd').value = s?.cwd || ''; $('#sfcwd').hidden = !!s?.oneOff;
  $('#sfacct').value = s?.account || ''; $('#sfmode').value = s?.permissionMode || 'auto';
  if (!s) api('/settings/agents').then((d) => { if (editingSched === null && d.permissionMode) $('#sfmode').value = d.permissionMode; }).catch(() => {});
  fillModelSelect($('#sfmodel'), s?.model); fillEffortSelect($('#sfeffort'), s?.effort);
  $('#sfcron').value = s?.cron || ''; $('#sftz').value = s?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('#sfover').value = s?.overlap || 'skip'; $('#sfnotify').value = s?.notify || 'always'; $('#sfkeep').value = s?.keepAgents ?? 3;
  $('#sfen').checked = s ? s.enabled : true;
  $('#sformh').textContent = s ? 'Edit schedule' : 'New schedule';
  $('#sfsave').textContent = s ? 'Save schedule' : 'Add schedule';
  $('#sform').hidden = false; renderSchedules(); syncTaskFoot();
  previewCron();
  $('#sform').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $('#sftitle').focus({ preventScroll: true });
}
function closeSchedForm() { editingSched = null; $('#sform').hidden = true; renderSchedules(); syncTaskFoot(); }
$('#snew').onclick = () => editSched(null);
$('#sfcancel').onclick = closeSchedForm;
$('#sfsave').onclick = async () => {
  const body = {
    title: $('#sftitle').value, prompt: $('#sfprompt').value, oneOff: $('#sfoo').checked, cwd: $('#sfoo').checked ? null : $('#sfcwd').value,
    account: $('#sfacct').value, permissionMode: $('#sfmode').value, model: $('#sfmodel').value, effort: $('#sfeffort').value, cron: $('#sfcron').value, tz: $('#sftz').value,
    overlap: $('#sfover').value, notify: $('#sfnotify').value, keepAgents: $('#sfkeep').value === '' ? 3 : Number($('#sfkeep').value), enabled: $('#sfen').checked,
  };
  if (!body.title.trim()) { $('#sftitle').focus(); return; }
  try { await schedApi(editingSched ? '/' + editingSched : '', editingSched ? 'PATCH' : 'POST', body); flash(editingSched ? 'Schedule saved' : 'Schedule added', 'ok'); closeSchedForm(); } catch {}
};
