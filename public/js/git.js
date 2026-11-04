// UI for: per-agent git/worktree view, usage and cost, full-text search, watchdog banner, settings extras.
// Loaded after the main script in index.html and shares its globals ($, api, mk, agents, sel, events, go, ...).

const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(2) + 'k' : String(Math.round(n || 0)));
const fmtCost = (c) => '$' + (c < 1 ? c.toFixed(3) : c.toFixed(2));
const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'earlier (undated)');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---- per-agent: usage line and watchdog banner --------------------------------------------------

function usageText(u) {
  if (!u?.turns) return '';
  const cost = u.noCost >= u.turns ? 'cost unavailable' : `~${fmtCost(u.cost)} est.` + (u.noCost ? ` (${plural(u.noCost, 'turn')} without a cost)` : '');
  return `Usage · ${plural(u.turns, 'turn')} · in ${fmtN(u.input)} · out ${fmtN(u.output)} · cache ${fmtN(u.cacheRead)} read / ${fmtN(u.cacheCreate)} written · ${cost}`;
}

function renderAgentExtras() {
  const a = agents[sel], line = $('#uline'), wd = $('#wd');
  if (!a || !line) return;
  renderCtx();
  const t = usageText(a.usage);
  line.hidden = !t; line.textContent = t;
  line.title = 'Tokens are summed over finished turns. Cost is the estimate Claude Code reports (API prices); it is not a bill, and some turns report none.';
  wd.hidden = !a.watchdog;
  if (!a.watchdog) return;
  wd.innerHTML = '';
  const b = mk('button', 'primary', 'Interrupt');
  b.onclick = async () => { b.disabled = true; try { await api(`/agents/${a.id}/interrupt`, { method: 'POST' }); } catch (e) { flash(e.message, 'error'); b.disabled = false; } };
  wd.append(mk('span', '', `⚠ ${a.watchdog.kind === 'loop' ? 'Possible loop' : 'Looks stuck'}: ${a.watchdog.detail}`), b);
}

// ---- git view ------------------------------------------------------------------------------------------

const eh = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function diffHtml(text) {
  return text.split('\n').map((l) => {
    const c = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') ? 'm' : l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : l.startsWith('@@') ? 'h' : '';
    return c ? `<span class="${c}">${eh(l)}</span>` : eh(l);
  }).join('\n');
}
const gq = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const gapi = (kind, o) => api(`/agents/${sel}/git${kind ? '/' + kind : ''}${o ? '?' + gq(o) : ''}`);
const gbody = () => $('#gbody');

async function openGit() {
  if (!agents[sel]) return;
  $('#gtitle').textContent = 'Git · ' + agents[sel].name;
  $('#gback').hidden = true;
  gbody().innerHTML = skel(3);
  $('#gdlg').showModal();
  await gitList();
}

async function gitList() {
  const id = sel;
  $('#gback').hidden = true;
  $('#grefresh').onclick = gitList;
  let r;
  try { r = await gapi(''); } catch (e) { if (sel === id) gbody().textContent = e.message; return; }
  if (sel !== id) return;
  const b = gbody(); b.innerHTML = ''; $('#gdlg .dlg-body').scrollTop = 0;
  if (!r.repos.length) b.append(mk('div', 'mutl', 'No git repository found in this agent\'s folder or its tmp folder.'));
  for (const repo of r.repos) b.append(repoCard(repo));
}

function repoCard(r) {
  const card = mk('div', 'gcard');
  const h = mk('h5', '', r.linked ? (r.managed ? 'Worktree' : 'Linked worktree') : r.isCwd ? 'Agent folder' : 'Repository');
  if (r.linked) h.append(mk('span', 'gtag', 'worktree'));
  card.append(h, mk('div', 'gline', r.path));
  const l1 = mk('div', 'gline'); l1.innerHTML = icon('git-branch') + ' '; l1.append(mk('b', '', r.detached ? `detached @ ${r.headShort || '?'}` : r.branch || '(no commits yet)'));
  if (r.upstream) l1.append(` · ${r.upstream.name} ↑${r.upstream.ahead ?? '?'} ↓${r.upstream.behind ?? '?'}`);
  if (r.base) l1.append(` · vs ${r.base.name || '?'} ↑${r.base.ahead ?? '?'} ahead ↓${r.base.behind ?? '?'} behind`);
  card.append(l1);
  const s = r.status;
  card.append(mk('div', 'gline', s.total ? `${s.total} changed file(s): ${s.staged} staged · ${s.unstaged} unstaged · ${s.untracked} untracked` : 'Working tree clean'));
  const slot = mk('div');
  if (s.files.length) {
    const d = mk('details'); d.append(mk('summary', 'gline', 'Changed files (tap one to see its changed lines)'));
    const list = mk('div', 'gfiles');
    for (const f of s.files) { // each file expands to its own diff, with +/- line counts on the row
      const wrap = mk('div', 'gfile'), row = mk('div', 'gfr');
      row.append(mk('span', 'gfs', `${f.x}${f.y}`), mk('span', 'gfp', f.path));
      row.append(f.binary ? mk('span', 'gfn', 'binary') : f.add != null ? mk('span', 'gfn', `+${f.add} −${f.del}`) : f.x === '?' ? mk('span', 'gfn', 'new') : '');
      const body = mk('div', 'gfd'); body.hidden = true;
      row.onclick = () => { body.hidden = !body.hidden; wrap.classList.toggle('open', !body.hidden); if (!body.hidden && !body.firstChild) showDiff(body, r.path, { file: f.path }, null); };
      wrap.append(row, body); list.append(wrap);
    }
    if (s.moreFiles) list.append(mk('div', 'mutl', `…and ${s.moreFiles} more`));
    d.append(list); card.append(d);
  }
  if (r.diffStat) card.append(mk('pre', '', r.diffStat));
  const row = mk('div', 'row');
  const bd = mk('button', '', 'View diff (uncommitted)'); bd.onclick = () => showDiff(slot, r.path, {}, 'uncommitted changes vs HEAD');
  row.append(bd);
  if (r.linked) { const br = mk('button', 'primary', 'Review and merge…'); br.onclick = () => gitReview(r); row.append(br); }
  card.append(row, slot);
  if (r.commits.length) {
    const d = mk('details'); d.append(mk('summary', 'gline', `Recent commits (${r.commits.length})`));
    const c = mk('div', 'gcommits');
    for (const k of r.commits) { const x = mk('div'); x.append(mk('b', '', k.short + ' '), k.subject, mk('br'), mk('small', '', `${k.author} · ${fmtWhen(k.at)}`)); c.append(x); }
    d.append(c); card.append(d);
  }
  return card;
}

async function showDiff(slot, path, opts, label) {
  slot.innerHTML = '';
  slot.append(mk('div', 'mutl', 'Loading diff…'));
  try {
    const r = await gapi('diff', { path, ...opts });
    slot.innerHTML = '';
    if (label) slot.append(mk('div', 'gline', 'Diff: ' + label));
    if (!r.diff.trim()) { slot.append(mk('div', 'mutl', 'No differences.')); return; }
    const pre = mk('pre', 'diff'); pre.innerHTML = diffHtml(r.diff); slot.append(pre);
    if (r.truncated) slot.append(mk('div', 'gerr', `Diff is large; only the first ${fmtN(r.bytes)} characters are shown. Read-only view.`));
  } catch (e) { slot.innerHTML = ''; slot.append(mk('div', 'gerr', e.message)); }
}

// review a linked worktree against its base, then (after an explicit confirmation) merge and/or remove it
async function gitReview(r) {
  const b = gbody(); b.innerHTML = skel(3); $('#gdlg .dlg-body').scrollTop = 0;
  $('#gback').hidden = false; $('#gback').onclick = gitList;
  $('#grefresh').onclick = () => gitReview(r);
  let rv;
  try { rv = await gapi('review', { path: r.path, base: r.base?.name }); } catch (e) { b.innerHTML = ''; b.append(mk('div', 'gerr', e.message)); return; }
  b.innerHTML = '';
  const card = mk('div', 'gcard');
  const h = mk('h5', '', `Review and merge: ${rv.branch} → ${rv.base}`);
  card.append(h, mk('div', 'gline', `Worktree ${rv.path}`), mk('div', 'gline', `Merges into the checkout at ${rv.baseRepo}. Nothing is pushed.`));
  card.append(mk('div', 'gline', `${plural(rv.ahead, 'commit')} to merge · ${rv.behind ? plural(rv.behind, 'commit') + ' on ' + rv.base + ' not in the branch' : 'branch is up to date with ' + rv.base}`));
  if (rv.wouldConflict) card.append(mk('div', 'gerr', `Merging would conflict in: ${rv.conflicts.join(', ') || 'some files'}. Resolve it in the worktree first (for example by merging ${rv.base} into the branch there).`));
  else if (rv.mergeCheckFailed) card.append(mk('div', 'gerr', 'Could not dry-run the merge to check for conflicts, so merging is disabled.'));
  else card.append(mk('div', 'gok', rv.canFastForward ? 'Fast-forward is possible; no conflicts.' : 'A merge commit is needed (the base moved on); no conflicts.'));
  if (rv.blockers.length) { const bl = mk('div', 'gblock'); bl.append(mk('b', '', 'Merge is blocked:')); for (const x of rv.blockers) bl.append(mk('div', '', '• ' + x)); card.append(bl); }
  if (rv.stat) card.append(mk('pre', '', rv.stat));
  if (rv.commits.length) {
    const c = mk('div', 'gcommits');
    for (const k of rv.commits) { const x = mk('div'); x.append(mk('b', '', k.short + ' '), k.subject, mk('br'), mk('small', '', `${k.author} · ${fmtWhen(k.at)}`)); c.append(x); }
    card.append(c);
  }
  const dslot = mk('div');
  const bd = mk('button', '', `View full diff vs ${rv.base}`);
  bd.onclick = () => {
    dslot.innerHTML = '';
    const pre = mk('pre', 'diff'); pre.innerHTML = diffHtml(rv.diff || ''); dslot.append(pre);
    if (rv.truncated) dslot.append(mk('div', 'gerr', 'Diff is large and was cut off. Read-only view.'));
    if (!rv.diff) dslot.textContent = 'No differences.';
  };
  card.append(mk('div', 'row'), dslot); card.lastChild.previousSibling.append(bd);

  // actions
  const act = mk('div'); card.append(act);
  const mode = { v: rv.canFastForward ? 'ff' : 'merge' };
  const radios = mk('div');
  for (const [v, txt, ok] of [['ff', 'Fast-forward (no merge commit)', rv.canFastForward], ['merge', 'Merge commit', true]]) {
    const lab = mk('label', 'chk'), rd = mk('input'); rd.type = 'radio'; rd.name = 'gmode'; rd.value = v; rd.checked = mode.v === v; rd.disabled = !ok;
    rd.onchange = () => { mode.v = v; };
    lab.append(rd, mk('span', '', txt + (ok ? '' : ' (not possible: the base has moved)'))); radios.append(lab);
  }
  const rmWt = mk('input'), rmBr = mk('input'); rmWt.type = rmBr.type = 'checkbox';
  const l1 = mk('label', 'chk'); l1.append(rmWt, mk('span', '', 'Then remove the worktree'));
  const l2 = mk('label', 'chk'); l2.append(rmBr, mk('span', '', 'and delete the branch (only if fully merged)'));
  rmBr.disabled = true; rmWt.onchange = () => { rmBr.disabled = !rmWt.checked; if (!rmWt.checked) rmBr.checked = false; };
  const status = mk('div');
  const buttons = mk('div', 'row');
  const mergeBtn = mk('button', 'primary', 'Merge…'); mergeBtn.disabled = !!rv.blockers.length || rv.wouldConflict || rv.mergeCheckFailed || !rv.ahead;
  const removeBtn = mk('button', '', 'Remove worktree only…');
  buttons.append(mergeBtn, removeBtn);
  act.append(mk('b', '', 'Merge into ' + rv.base), radios, l1, l2, buttons, status);

  const confirmStep = (text, endpoint, body) => {
    buttons.hidden = true; status.innerHTML = '';
    const box = mk('div', 'gconfirm'); box.append(mk('div', '', text));
    const row = mk('div', 'row'), ok = mk('button', 'primary', 'Confirm'), no = mk('button', '', 'Back');
    no.onclick = () => { box.remove(); buttons.hidden = false; };
    ok.onclick = async () => {
      ok.disabled = no.disabled = true;
      try {
        const res = await api(`/agents/${sel}/git/${endpoint}`, { method: 'POST', body: { ...body, path: rv.path, base: rv.base, expectHead: rv.head, confirm: true } });
        box.remove();
        const lines = [];
        if (res.merged) lines.push(`Merged ${rv.branch} into ${rv.base} (${res.mode === 'ff' ? 'fast-forward' : 'merge commit'}), now at ${String(res.newHead).slice(0, 7)}.`);
        if (res.removed) lines.push('Worktree removed.' + (res.branchDeleted ? ' Branch deleted.' : ''));
        if (res.branchNote) lines.push(res.branchNote);
        status.append(mk('div', 'gok', lines.join(' ') || 'Done.'));
        if (res.removeError) status.append(mk('div', 'gerr', 'The merge went through, but the worktree was not removed: ' + res.removeError));
        const back = mk('button', '', 'Back to repositories'); back.onclick = gitList; status.append(back);
      } catch (e) { box.remove(); buttons.hidden = false; status.append(mk('div', 'gerr', e.message)); } // e.g. dirty worktree, conflict, base checked out elsewhere, agent busy
      status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    row.append(ok, no); box.append(row); act.append(box);
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  mergeBtn.onclick = () => confirmStep(
    `Merge ${plural(rv.ahead, 'commit')} from ${rv.branch} into ${rv.base} in ${rv.baseRepo} by ${mode.v === 'ff' ? 'fast-forward' : 'a merge commit'}` +
    (rmWt.checked ? `, then remove the worktree${rmBr.checked ? ' and delete the branch' : ''}` : '') + '. Nothing is pushed and nothing is forced.',
    'merge', { mode: mode.v, remove: rmWt.checked, deleteBranch: rmBr.checked });
  removeBtn.onclick = () => confirmStep(
    `Remove the worktree ${rv.path}${rmBr.checked ? ` and delete branch ${rv.branch}` : ''} without merging. Git refuses if there are uncommitted files${rmBr.checked ? ' or if the branch is not fully merged' : ''}; nothing is forced. The agent's process in that folder is stopped.`,
    'remove', { deleteBranch: rmBr.checked });
  b.append(card);
}
$('#gclose').onclick = () => $('#gdlg').close();

