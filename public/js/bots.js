// ---- Bots: permanent agents with identity and memory. #/bots lists them, #/bots/<handle> is one bot (status, memory files,
// schedules), the form creates and edits. A bot's chat is its agent's own chat (#/a/<id>); bots also show in the agent list with a badge.
let bots = {}, botForm = null, curBot = null, botFile = null, botFileEdit = false, botFiles = []; // botForm: null | 'new' | handle being edited
const botHash = () => { const p = location.hash.replace(/^#\/?/, '').split('/'); return p[0] === 'bots' ? decodeURIComponent(p[1] || '') || null : undefined; };
const botList = () => Object.values(bots).sort((a, b) => a.name.localeCompare(b.name));
const botEmoji = (b) => { const s = mk('span', 'bemo', b.emoji || '🤖'); s.setAttribute('aria-hidden', 'true'); return s; };

async function loadBots() {
  bots = Object.fromEntries((await api('/bots')).map((b) => [b.handle, b]));
  botBadge();
  if ($('#botdlg').open) renderBots();
}
function botBadge() {
  const n = botList().filter((b) => b.paused).length;
  $('#nbots').hidden = !n; $('#nbots').textContent = n;
  $('#bbots').setAttribute('aria-label', 'Bots' + (n ? `, ${n} paused` : ''));
}
function onBot(b) { bots[b.handle] = b; botBadge(); if ($('#botdlg').open && botForm === null) { renderBots(); } }
function onBotRemoved(h) { delete bots[h]; botBadge(); if ($('#botdlg').open) { if (botHash() === h) go('/bots'); else renderBots(); } }
const botState = (b) => { const a = agents[b.agentId]; return b.paused ? 'paused' : !a ? 'missing' : approvals.some((p) => p.agentId === b.agentId) ? blockedTxt(b.agentId) : a.status; };
const botDot = (st) => ({ paused: 'stopped', missing: 'error', 'needs approval': 'error', 'has a question': 'error' })[st] || st;

// ---- views
function renderBots() {
  const h = botHash(), inForm = botForm !== null, b = h && bots[h], view = !!b && !inForm;
  $('#botlist').hidden = view || inForm; $('#botview').hidden = !view; $('#botform').hidden = !inForm;
  $('#botback').hidden = !view && !inForm; $('#botedit').hidden = !view; $('#botfoot').hidden = view || inForm;
  if (inForm) return;
  if (!view) { curBot = null; $('#bothead').textContent = 'Bots'; $('#botsub').textContent = 'Permanent agents with a name, a role and a memory'; return renderBotList(); }
  $('#bothead').textContent = `${b.emoji} ${b.name}`; $('#botsub').textContent = '@' + b.handle;
  renderBotView(b);
}
function renderBotList() {
  const l = $('#botlist'); l.innerHTML = '';
  const all = botList();
  if (!all.length) l.innerHTML = estate('bot', 'No bots yet', 'A bot is a long-lived agent you create once and talk to forever: it has a name, a role, and memory files it reads and updates, so it remembers across context refreshes and restarts.');
  for (const b of all) {
    const st = botState(b), d = mk('button', 'botrow'); d.type = 'button';
    const top = mk('div', 'bott');
    top.append(botEmoji(b), mk('b', '', b.name), mk('small', 'mutl', '@' + b.handle), mk('span', 'sp'), mk('span', 'dot ' + botDot(st)), mk('small', 'bots-st', st));
    d.append(top, mk('small', 'botrole', b.role.replace(/\s+/g, ' ').slice(0, 160)));
    const meta = [b.account, b.permissionMode, b.model, b.effort && 'effort ' + b.effort, b.browser && 'browser ' + b.browser, b.context && `context ${Math.round(b.context / 1000)}k`].filter(Boolean).join(' · ');
    d.append(mk('small', 'botmeta', meta));
    d.onclick = () => go('/bots/' + encodeURIComponent(b.handle));
    l.append(d);
  }
  l.append(botSettings());
}

// where new bots get their home folders, and when an idle bot's context is refreshed
function botSettings() {
  const det = mk('details', 'botset'); det.append(mk('summary', '', 'Bot settings'));
  const body = mk('div', 'botsetb'), root = mk('input', 'fld'), tok = mk('input', 'fld'), save = mk('button', '', 'Save'); save.type = 'button';
  root.autocomplete = 'off'; tok.type = 'number'; tok.min = 50000; tok.step = 10000; tok.inputMode = 'numeric';
  const lab = (t, e, hint) => { const x = mk('label', 'fl', t); x.append(e); if (hint) x.append(mk('small', 'mutl', hint)); return x; };
  body.append(lab('Bots folder', root, 'Each new bot gets a home folder <bots folder>/<handle>/ with BOT.md and memory/. Empty = the bots/ folder in the swarm repo (git-ignored).'), lab('Refresh an idle bot’s context at (tokens)', tok, 'Its memory files carry what matters across the refresh. Default 100000.'), save);
  det.append(body);
  api('/bots/settings').then((c) => { root.value = c.root || ''; root.placeholder = c.resolvedRoot; tok.value = c.ctxTokens; }).catch(() => {});
  save.onclick = async () => { try { await api('/bots/settings', { method: 'PUT', body: { root: root.value, ctxTokens: Number(tok.value) } }); flash('Saved', 'ok'); } catch (e) { flash(e.message, 'error'); } };
  return det;
}

async function renderBotView(b) {
  const v = $('#botview'), same = curBot === b.handle;
  curBot = b.handle;
  const st = botState(b);
  const head = mk('div', 'botcard'), top = mk('div', 'bott');
  top.append(botEmoji(b), mk('b', '', b.name), mk('small', 'mutl', '@' + b.handle), mk('span', 'sp'), mk('span', 'dot ' + botDot(st)), mk('small', 'bots-st', st));
  const acts = mk('div', 'botacts');
  const btn = (label, ic, fn, cls) => { const x = mk('button', cls || '', ''); x.type = 'button'; x.innerHTML = icon(ic) + '<span></span>'; x.querySelector('span').textContent = label; x.onclick = () => fn(x).catch?.((e) => flash(e.message, 'error')); return x; };
  const chat = mk('a', 'button', ''); chat.href = '#/a/' + b.agentId; chat.innerHTML = icon('message-square') + '<span>Open chat</span>';
  acts.append(chat,
    btn(b.paused ? 'Resume' : 'Pause', b.paused ? 'play' : 'pause', async () => { await api(`/bots/${b.handle}/${b.paused ? 'resume' : 'pause'}`, { method: 'POST' }); }),
    btn('Refresh context', 'refresh-cw', async (x) => {
      if (!(await ask(`Give ${b.name} a fresh context? It updates its memory files, writes a handoff note and continues from them.`, { ok: 'Refresh' }))) return;
      x.disabled = true;
      try { await api(`/bots/${b.handle}/refresh`, { method: 'POST' }); flash('Context refreshed', 'ok'); } finally { x.disabled = false; }
    }),
    btn('Delete', 'trash-2', () => deleteBot(b), 'danger'));
  const facts = mk('div', 'botfacts');
  const fact = (k, val) => { if (val) { const f = mk('span', 'botfact'); f.append(mk('small', '', k), mk('span', '', val)); facts.append(f); } };
  fact('Account', b.account); fact('Mode', b.permissionMode); fact('Model', b.model || 'default'); fact('Effort', b.effort || 'default'); fact('Browser', b.browser || 'off');
  fact('Context', `${Math.round(b.context / 1000)}k of ${Math.round((b.ctxTokens || b.ctxDefault) / 1000)}k before an automatic refresh${b.handoff ? ' (refreshing…)' : ''}`);
  fact('Folder', b.cwd + (b.home ? '' : `  (memory in ${b.dir})`));
  if (b.rooms.length) fact('Rooms', b.rooms.map((id) => rooms[id]?.name || '#' + id).join(', '));
  head.append(top, mk('div', 'botrole full', b.role), facts, acts);
  const mem = mk('section', 'botsec'), sch = mk('section', 'botsec');
  mem.append(mk('h3', '', 'Memory'), mk('div', 'botmem', ''));
  sch.append(mk('h3', '', 'Schedules'), mk('div', 'botsch', ''));
  v.replaceChildren(head, mem, sch);
  if (!same) { botFile = null; botFileEdit = false; }
  renderBotMemory(b); renderBotSchedules(b);
}

async function deleteBot(b) {
  if (!(await ask(`Delete ${b.name} (@${b.handle})? Its agent, chat and schedules are removed.`, { ok: 'Delete bot', danger: true }))) return;
  const home = await ask(`Also delete its folder?\n${b.dir}\n\nThis removes its memory and BOT.md for good. Keep it to be able to reuse the memory later.`, { ok: 'Delete folder too', cancel: 'Keep folder', danger: true });
  await api(`/bots/${encodeURIComponent(b.handle)}${home ? '?home=1' : ''}`, { method: 'DELETE' });
  flash(home ? 'Bot and folder deleted' : 'Bot deleted, folder kept', 'ok');
  go('/bots');
}

// ---- memory viewer / editor
async function renderBotMemory(b) {
  const box = $('#botview .botmem');
  if (!box) return;
  try { botFiles = await api(`/bots/${encodeURIComponent(b.handle)}/files`); } catch (e) { box.textContent = e.message; return; }
  if (curBot !== b.handle) return;
  if (!botFile || !botFiles.some((f) => f.name === botFile)) botFile = botFiles.find((f) => f.name === 'memory/journal.md')?.name || botFiles[0]?.name;
  const tabs = mk('div', 'bottabs seg');
  for (const f of botFiles) {
    const t = mk('button', f.name === botFile ? 'on' : '', f.name.replace(/^memory\//, '')); t.type = 'button'; t.title = `${f.size} bytes · ${new Date(f.mtime).toLocaleString()}`;
    t.onclick = () => { botFile = f.name; botFileEdit = false; renderBotMemory(b); };
    tabs.append(t);
  }
  const add = mk('button', '', '+'); add.type = 'button'; add.title = 'New memory file'; add.setAttribute('aria-label', 'New memory file');
  add.onclick = async () => {
    const n = prompt('New memory file name (letters, digits, - and _):'); if (!n) return;
    const name = 'memory/' + n.trim().replace(/\.md$/, '') + '.md';
    try { await api(`/bots/${encodeURIComponent(b.handle)}/file?name=${encodeURIComponent(name)}`, { method: 'PUT', body: { content: '# ' + n.trim() + '\n' } }); botFile = name; botFileEdit = true; renderBotMemory(b); }
    catch (e) { flash(e.message, 'error'); }
  };
  tabs.append(add);
  const body = mk('div', 'botfile');
  box.replaceChildren(tabs, body);
  if (!botFile) { body.append(mk('div', 'mutl', 'No files yet.')); return; }
  let content = '';
  try { content = (await api(`/bots/${encodeURIComponent(b.handle)}/file?name=${encodeURIComponent(botFile)}`)).content; } catch (e) { body.textContent = e.message; return; }
  if (curBot !== b.handle) return;
  const bar = mk('div', 'botfbar'), name = botFile;
  if (!botFileEdit) {
    const view = mk('div', 'md botmd'); view.innerHTML = renderMd(content);
    const ed = mk('button', '', 'Edit'); ed.type = 'button'; ed.onclick = () => { botFileEdit = true; renderBotMemory(b); };
    bar.append(mk('small', 'mutl', botFiles.find((f) => f.name === name) ? `${content.length} characters` : ''), mk('span', 'sp'), ed);
    body.append(bar, view);
    return;
  }
  const ta = mk('textarea', 'fld botta'); ta.value = content; ta.rows = 16; ta.spellcheck = false;
  const save = mk('button', 'primary', 'Save'), cancel = mk('button', '', 'Cancel'), del = mk('button', 'danger', 'Delete file');
  save.type = cancel.type = del.type = 'button';
  save.onclick = async () => {
    save.disabled = true;
    try { await api(`/bots/${encodeURIComponent(b.handle)}/file?name=${encodeURIComponent(name)}`, { method: 'PUT', body: { content: ta.value } }); botFileEdit = false; flash('Saved', 'ok'); if (name === 'BOT.md') loadBots(); renderBotMemory(b); }
    catch (e) { flash(e.message, 'error'); } finally { save.disabled = false; }
  };
  cancel.onclick = () => { botFileEdit = false; renderBotMemory(b); };
  del.onclick = async () => { if (!(await ask(`Delete ${name}?`, { ok: 'Delete', danger: true }))) return; try { await api(`/bots/${encodeURIComponent(b.handle)}/file?name=${encodeURIComponent(name)}`, { method: 'DELETE' }); botFileEdit = false; botFile = null; renderBotMemory(b); } catch (e) { flash(e.message, 'error'); } };
  bar.append(mk('small', 'mutl', name === 'BOT.md' ? 'The role block between the markers is the bot’s role; the rest is yours.' : ''), mk('span', 'sp'));
  if (name !== 'BOT.md' && !['journal.md', 'notes.md', 'threads.md'].includes(name.slice(7))) bar.append(del);
  bar.append(cancel, save);
  body.append(bar, ta);
}

// ---- schedules aimed at this bot
async function renderBotSchedules(b) {
  const box = $('#botview .botsch');
  if (!box) return;
  let all = [];
  try { all = (await api('/schedules')).filter((s) => s.bot === b.handle); } catch (e) { box.textContent = e.message; return; }
  if (curBot !== b.handle) return;
  box.innerHTML = '';
  if (!all.length) box.append(mk('div', 'mutl', 'No schedules. A schedule sends its prompt to this bot on a cron timetable, as a turn of its own session.'));
  for (const s of all) {
    const r = mk('div', 'botsr'), t = mk('div', 'botst');
    t.append(mk('b', '', s.title), mk('small', 'mutl', `${s.description} · ${s.cron}${s.enabled ? '' : ' · paused'}${s.enabled && s.nextRunAt ? ' · next ' + new Date(s.nextRunAt).toLocaleString() : ''}`));
    const tog = mk('button', '', s.enabled ? 'Pause' : 'Enable'), del = mk('button', 'danger', 'Delete'); tog.type = del.type = 'button';
    tog.onclick = async () => { try { await api('/schedules/' + s.id, { method: 'PATCH', body: { enabled: !s.enabled } }); renderBotSchedules(b); } catch (e) { flash(e.message, 'error'); } };
    del.onclick = async () => { if (await ask(`Delete schedule "${s.title}"?`, { ok: 'Delete', danger: true })) { try { await api('/schedules/' + s.id, { method: 'DELETE' }); renderBotSchedules(b); } catch (e) { flash(e.message, 'error'); } } };
    r.append(t, tog, del);
    box.append(r);
  }
  const add = mk('div', 'botsadd'), title = mk('input', 'fld'), cron = mk('input', 'fld'), prompt_ = mk('input', 'fld'), go_ = mk('button', 'primary', 'Add schedule');
  title.placeholder = 'Title'; cron.placeholder = 'Cron, e.g. 0 9 * * 1-5'; prompt_.placeholder = 'What should it do on each run?'; go_.type = 'button';
  for (const e of [title, cron, prompt_]) e.autocomplete = 'off';
  go_.onclick = async () => {
    try { await api('/schedules', { method: 'POST', body: { title: title.value, prompt: prompt_.value, cron: cron.value, bot: b.handle, notify: 'failure' } }); renderBotSchedules(b); }
    catch (e) { flash(e.message, 'error'); }
  };
  add.append(title, cron, prompt_, go_);
  box.append(add);
}

// ---- create / edit form
async function openBotForm(which) {
  botForm = which;
  const b = which === 'new' ? null : bots[which], f = $('#botform');
  f.innerHTML = '';
  const [{ names: accts, def: defAcct }, brCfg_, rs] = await Promise.all([accountsWithDefault().catch(() => ({ names: ['claude'], def: 'claude' })), api('/browser').catch(() => null), api('/rooms').catch(() => [])]);
  const settings = await api('/bots/settings').catch(() => ({ resolvedRoot: 'bots', ctxTokens: 100000 }));
  const field = (label, el, hint) => { const l = mk('label', 'fl', label); l.append(el); if (hint) l.append(mk('small', 'mutl', hint)); return l; };
  const inp = (v, ph) => { const e = mk('input', 'fld'); e.value = v || ''; if (ph) e.placeholder = ph; e.autocomplete = 'off'; return e; };
  const name = inp(b?.name, 'e.g. Scout'), handle = inp(b?.handle, 'scout'), emoji = inp(b?.emoji || '🤖'); emoji.maxLength = 8; emoji.className = 'fld botemo';
  handle.autocapitalize = 'none'; handle.disabled = !!b;
  const role = mk('textarea', 'fld'); role.rows = 7; role.value = b?.role || ''; role.placeholder = 'Who is this bot and what is it for? How should it behave, what should it keep track of? (It becomes its BOT.md.)';
  let handleTouched = !!b;
  handle.oninput = () => { handleTouched = true; };
  name.oninput = () => { if (!handleTouched) handle.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24); updHome(); };
  handle.addEventListener('input', () => updHome());
  const acct = mk('select', 'fld'); acct.innerHTML = accts.map((a) => `<option>${esc(a)}</option>`).join(''); acct.value = b?.account || localStorage.getItem('halay-acct') || defAcct || accts[0];
  const mode = mk('select', 'fld');
  for (const [v, t] of [['manual', 'manual (asks for approval; recommended)'], ['auto', 'auto (fewer prompts)'], ['acceptEdits', 'acceptEdits (edits auto-approved)'], ['plan', 'plan (read-only)'], ['bypassPermissions', 'bypassPermissions (dangerous)'], ['cli', 'your settings only']]) mode.append(new Option(t, v));
  mode.value = b?.permissionMode || 'manual';
  const model = inp(b?.model, 'default'); model.setAttribute('list', 'botmodels');
  if (!$('#botmodels')) { const dl = mk('datalist'); dl.id = 'botmodels'; for (const m of ['opus', 'sonnet', 'haiku', 'fable']) dl.append(new Option(m)); document.body.append(dl); }
  const effort = mk('select', 'fld'); fillEffortSelect(effort, b?.effort);
  // folder
  const home = mk('input'); home.type = 'radio'; home.name = 'bothome'; home.checked = !b || b.home;
  const own = mk('input'); own.type = 'radio'; own.name = 'bothome'; own.checked = !!b && !b.home;
  const homeLbl = mk('label', 'chk'), ownLbl = mk('label', 'chk');
  const homeTxt = mk('span', ''); homeLbl.append(home, homeTxt); ownLbl.append(own, mk('span', '', 'An existing project folder (memory goes in <folder>/.bots/<handle>/)'));
  const cwd = inp(b && !b.home ? b.cwd : '', '/absolute/path/to/project'); cwd.setAttribute('list', 'botcwds');
  if (!$('#botcwds')) { const dl = mk('datalist'); dl.id = 'botcwds'; document.body.append(dl); }
  $('#botcwds').replaceChildren(...[...new Set(Object.values(agents).filter((a) => !a.oneOff && a.role !== 'conductor').map((a) => a.cwd))].map((c) => new Option(c)));
  const updHome = () => { homeTxt.textContent = `A new home folder: ${(b?.cwd || `${settings.resolvedRoot}/${handle.value || '<handle>'}`)}`; cwd.hidden = !own.checked; };
  home.onchange = own.onchange = updHome; updHome();
  const folder = mk('div', 'botfolder'); folder.append(homeLbl, ownLbl, cwd);
  if (b) { for (const e of [home, own, cwd]) e.disabled = true; }
  // browser
  const bon = mk('input'); bon.type = 'checkbox'; bon.checked = !!b?.browser;
  const prof = mk('select', 'fld'); const names = brCfg_?.profiles.map((p) => p.name) || ['default'];
  if (b?.browser && !names.includes(b.browser)) names.push(b.browser);
  prof.innerHTML = names.map((n) => `<option>${esc(n)}</option>`).join(''); prof.value = b?.browser || brCfg_?.profile || names[0]; const profF = field('Browser profile', prof); profF.hidden = !bon.checked;
  bon.onchange = () => { profF.hidden = !bon.checked; };
  const bl = mk('label', 'chk'); bl.append(bon, mk('span', '', 'Give it a browser (logins persist per profile)'));
  // rooms
  const rp = mk('div', 'rmpick'), have = new Set(b?.rooms || []);
  for (const r of rs.filter((x) => x.status !== 'archived')) { const l = mk('label', 'chk'), c = mk('input'); c.type = 'checkbox'; c.value = r.id; c.checked = have.has(r.id); l.append(c, mk('span', '', r.name)); rp.append(l); }
  if (!rp.children.length) rp.append(mk('small', 'mutl', 'No rooms yet.'));
  const ctx = inp(b?.ctxTokens || '', `${settings.ctxTokens} (default)`); ctx.type = 'number'; ctx.inputMode = 'numeric'; ctx.min = 50000; ctx.step = 10000;
  // schedules (new bots)
  const scheds = mk('div', 'botnewsch');
  const addSched = () => {
    const r = mk('div', 'botsadd'), c = inp('', 'Cron, e.g. 0 9 * * 1-5'), p = inp('', 'What should it do on each run?'), x = mk('button', '', 'Remove'); x.type = 'button';
    x.onclick = () => r.remove(); r.append(c, p, x); scheds.append(r);
  };
  const addBtn = mk('button', '', 'Add a schedule'); addBtn.type = 'button'; addBtn.onclick = addSched;
  const row = mk('div', 'row'), save = mk('button', 'primary', b ? 'Save' : 'Create bot'), cancel = mk('button', '', 'Cancel');
  save.type = cancel.type = 'button'; row.append(mk('span', 'sp'), cancel, save);
  const two = (...els) => { const d = mk('div', 'botgrid'); d.append(...els); return d; };
  f.append(mk('b', '', b ? `Edit ${b.name}` : 'New bot'), two(field('Name', name), field('Emoji', emoji)), field('Handle', handle, 'How rooms @mention it. Fixed once created.'), field('Role and instructions', role),
    two(field('Account', acct), field('Permission mode', mode)), two(field('Model', model), field('Effort', effort)), field('Auto-refresh context at (tokens)', ctx), mk('div', 'dsub', 'Working folder'), folder,
    bl, profF, mk('div', 'dsub', 'Rooms to join'), rp);
  if (!b) f.append(mk('div', 'dsub', 'Schedules (optional)'), scheds, addBtn);
  f.append(row);
  cancel.onclick = () => { botForm = null; renderBots(); };
  save.onclick = async () => {
    save.disabled = true;
    const body = {
      name: name.value, emoji: emoji.value, role: role.value, account: acct.value, permissionMode: mode.value, model: model.value, effort: effort.value, browser: bon.checked ? prof.value : '',
      rooms: [...rp.querySelectorAll('input:checked')].map((c) => Number(c.value)), ctxTokens: ctx.value ? Number(ctx.value) : null,
    };
    try {
      let h = b?.handle;
      if (b) await api('/bots/' + encodeURIComponent(h), { method: 'PATCH', body });
      else {
        h = (await api('/bots', { method: 'POST', body: { ...body, handle: handle.value, cwd: own.checked ? cwd.value : '' } })).handle;
        for (const r of scheds.children) {
          const [c, p] = r.querySelectorAll('input');
          if (c.value.trim()) await api('/schedules', { method: 'POST', body: { title: `${name.value}: ${p.value.slice(0, 40) || 'scheduled run'}`, prompt: p.value, cron: c.value, bot: h, notify: 'failure' } }).catch((e) => flash('Schedule not added: ' + e.message, 'error'));
        }
      }
      botForm = null; await loadBots(); go('/bots/' + encodeURIComponent(h)); renderBots();
    } catch (e) { flash(e.message, 'error'); } finally { save.disabled = false; }
  };
  $('#bothead').textContent = b ? b.name : 'New bot'; $('#botsub').textContent = '';
  renderBots(); name.focus();
}

OPENERS.bots = async () => {
  botForm = null; curBot = null;
  $('#botdlg').showModal();
  await loadBots().catch((e) => flash(e.message, 'error'));
  if (!Object.keys(rooms).length) loadRooms().catch(() => {});
  renderBots();
};
window.addEventListener('hashchange', () => { if ($('#botdlg').open && botHash() !== undefined) { botForm = null; renderBots(); } });
$('#bbots').onclick = () => go('/bots');
$('#botnew').onclick = () => openBotForm('new');
$('#botedit').onclick = () => openBotForm(botHash());
$('#botback').onclick = () => { if (botForm !== null) { botForm = null; renderBots(); } else go('/bots'); };
