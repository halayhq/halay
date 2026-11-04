// ---- usage dialog: summary cards, a stacked cost-per-day chart by account, the detailed tables behind "Show table" ----------

function utable(head, rows, cls) {
  const wrap = mk('div', 'scrollx'), t = mk('table', 'ut'), th = mk('thead'), tr = mk('tr');
  for (const h of head) tr.append(mk('th', '', h));
  th.append(tr); t.append(th);
  const tb = mk('tbody');
  for (const r of rows) { const x = mk('tr', r.cls || ''); for (const c of r.cells) x.append(mk('td', '', c)); tb.append(x); }
  t.append(tb); wrap.append(t); return wrap;
}
const costCell = (r) => (r.noCost >= r.turns ? 'n/a' : '~' + fmtCost(r.cost || 0) + (r.noCost ? '*' : ''));
const usum = (rows) => rows.reduce((s, r) => ({ cost: s.cost + (r.cost || 0), noCost: s.noCost + (r.noCost || 0), turns: s.turns + r.turns, tok: s.tok + r.input + r.output, cache: s.cache + r.cacheRead + r.cacheCreate }), { cost: 0, noCost: 0, turns: 0, tok: 0, cache: 0 });
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ucolor = (i) => (i < 8 ? `var(--c${i + 1})` : 'var(--mut)'); // fixed categorical order; a 9th account and beyond share grey

function ucard(label, s, warn) {
  const c = mk('div', 'ucard');
  c.append(mk('div', 'ul', label), mk('div', 'uv', !s.turns ? '$0' : s.noCost >= s.turns ? 'n/a' : '~' + fmtCost(s.cost)), mk('div', 'us', `${plural(s.turns, 'turn')} · ${fmtN(s.tok)} tokens`));
  c.title = `Tokens are input + output; cache (${fmtN(s.cache)} read and written) is not included. Cost is Claude Code's estimate.`;
  if (warn) { const w = mk('div', 'uw'); w.innerHTML = icon('triangle-alert'); w.append(warn); c.append(w); }
  return c;
}

// stacked bars of estimated cost per day, one segment per account; tooltips via <title>
function uchart(u, days, accts, width) {
  const by = new Map();
  for (const r of u.byDay) if (r.day) (by.get(r.day) || by.set(r.day, {}).get(r.day))[r.account] = r;
  const tot = (d) => accts.reduce((s, a) => s + (by.get(d)?.[a]?.cost || 0), 0);
  const max = Math.max(0, ...days.map(tot));
  if (!max) return null;
  const raw = max / 3, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw), top = Math.ceil(max / step) * step;
  const W = Math.max(280, Math.round(width)), H = 200, L = 46, R = 4, T = 8, B = 22, ph = H - T - B, cw = (W - L - R) / days.length, bw = Math.max(4, Math.min(34, cw * 0.62));
  const y = (v) => T + ph - (v / top) * ph;
  const lab = (d) => new Date(d + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
  const money = (v) => '$' + (top < 10 ? v.toFixed(v % 1 ? 2 : 0) : Math.round(v));
  let s = '';
  for (let v = 0; v <= top + step / 2; v += step) s += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="ax" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${money(v)}</text>`;
  const every = Math.ceil(days.length / (W < 500 ? 5 : 8));
  days.forEach((d, i) => {
    const x = L + i * cw + (cw - bw) / 2, rows = accts.map((a, k) => [a, k, by.get(d)?.[a]]).filter(([, , r]) => r?.cost > 0);
    const lines = rows.map(([a, , r]) => `${a}: ~${fmtCost(r.cost)} · ${plural(r.turns, 'turn')}`);
    s += `<rect class="hit" x="${(L + i * cw).toFixed(1)}" y="${T}" width="${cw.toFixed(1)}" height="${ph}"><title>${esc(lab(d))}: ~${fmtCost(tot(d))}${lines.length ? '\n' + esc(lines.join('\n')) : ''}</title></rect><g>`;
    let acc = 0;
    rows.forEach(([a, k, r], j) => {
      const y1 = y(acc + r.cost), y0 = y(acc) - (j ? 2 : 0), h = Math.max(0, y0 - y1); acc += r.cost; // 2px surface gap between segments
      if (h < 0.5) return;
      const last = j === rows.length - 1, rr = last ? Math.min(4, h, bw / 2) : 0;
      const p = `M${x.toFixed(1)},${y0.toFixed(1)}V${(y1 + rr).toFixed(1)}q0,-${rr} ${rr},-${rr}h${(bw - 2 * rr).toFixed(1)}q${rr},0 ${rr},${rr}V${y0.toFixed(1)}Z`;
      s += `<path class="seg-r" d="${p}" fill="${ucolor(k)}"><title>${esc(lab(d))} · ${esc(a)}: ~${fmtCost(r.cost)} · ${plural(r.turns, 'turn')}</title></path>`;
    });
    s += '</g>';
    if (i % every === (days.length - 1) % every) s += `<text class="ax" x="${(L + i * cw + cw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(lab(d))}</text>`;
  });
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Estimated cost per day by account, last ${days.length} days">${s}</svg>`;
}

OPENERS.usage = async () => {
  const b = $('#ubody');
  b.innerHTML = `<div class="ucards">${'<div class="skel skcard"></div>'.repeat(3)}</div><div class="skel skcard" style="height:220px"></div>`;
  $('#udlg').showModal();
  let u;
  try { u = await api('/usage?days=14'); } catch (e) { b.innerHTML = ''; b.append(mk('div', 'gerr', e.message)); return; }
  b.innerHTML = '';
  const accts = [...new Set([...u.byAccount, ...u.byDay].map((r) => r.account))].sort();
  const days = []; const t0 = new Date(u.today + 'T12:00:00');
  for (let i = u.days - 1; i >= 0; i--) { const d = new Date(t0); d.setDate(d.getDate() - i); days.push(ymd(d)); }
  const over = new Set(u.over.map((o) => o.account));

  const cards = mk('div', 'ucards');
  cards.append(
    ucard('Today', usum(u.todayByAccount), u.over.length ? 'Over the warning threshold: ' + u.over.map((o) => `${o.account} (${o.metric})`).join(', ') : ''),
    ucard('Last 7 days', usum(u.byDay.filter((r) => r.day && r.day >= days[days.length - 7]))),
    ucard('All time', usum(u.byAccount)));
  b.append(cards);

  const ch = mk('div', 'uchart'), head = mk('div', 'uch');
  head.append(mk('b', '', `Cost per day, last ${u.days} days`), mk('span', '', 'Claude Code\'s estimate at API prices, not a bill. Hover a bar for details.'));
  ch.append(head);
  b.append(ch);
  const svg = uchart(u, days, accts, ch.clientWidth - 32);
  if (!svg) ch.append(mk('div', 'mutl', 'No cost recorded in this period.'));
  else {
    ch.insertAdjacentHTML('beforeend', svg);
    const leg = mk('div', 'ulegend'), inWin = u.byDay.filter((r) => r.day && r.day >= days[0]);
    accts.forEach((a, k) => {
      const s = usum(inWin.filter((r) => r.account === a)); if (!s.turns) return;
      const it = mk('span'), sw = mk('i'); sw.style.background = ucolor(k);
      it.append(sw, a, mk('small', '', s.noCost >= s.turns ? 'n/a' : '~' + fmtCost(s.cost))); leg.append(it);
    });
    ch.append(leg);
  }

  const tbl = mk('div', 'utables'); tbl.hidden = localStorage.getItem('halay-utable') !== '1';
  const mkHead = (first) => [...(first ? [first] : []), 'Account', 'In', 'Out', 'Cache r/w', 'Est. cost', 'Turns'];
  const row = (label, r, cls) => ({ cls, cells: [...(label ? [label] : []), r.account, fmtN(r.input), fmtN(r.output), `${fmtN(r.cacheRead)} / ${fmtN(r.cacheCreate)}`, costCell(r), String(r.turns)] });
  const sec = (title, node, note) => { const d = mk('div'); d.append(mk('b', '', title)); if (note) d.append(mk('div', 'mutl', note)); d.append(node); tbl.append(d); };
  const tdy = u.todayByAccount.map((r) => row('', r, over.has(r.account) ? 'over' : ''));
  const thr = Object.entries(u.thresholds).map(([a, c]) => `${a}: ${[c.dailyCost > 0 ? '$' + c.dailyCost : '', c.dailyTokens > 0 ? fmtN(c.dailyTokens) + ' tokens' : ''].filter(Boolean).join(' / ')}`).join(' · ');
  sec('Today by account', tdy.length ? utable(mkHead(''), tdy) : mk('div', 'mutl', 'Nothing recorded today.'), thr ? 'Warning thresholds: ' + thr + (u.over.length ? ' — passed: ' + u.over.map((o) => `${o.account} (${o.metric})`).join(', ') : '') : 'No warning thresholds set (Settings → Usage warnings).');
  sec('By day and account', utable(mkHead('Day'), u.byDay.map((r) => row(r.day || 'earlier', r, r.day === u.today && over.has(r.account) ? 'over' : ''))), `Last ${u.days} days. "earlier" = turns from before dates were recorded.`);
  sec('All time by account', utable(mkHead(''), u.byAccount.map((r) => row('', r))));
  const notes = mk('div', 'mutl unotes');
  notes.append(mk('div', '', 'Cost is an estimate: it is the total_cost_usd that Claude Code reports (API-price equivalent). On a subscription plan it is not what you are charged. "n/a" means the CLI reported no cost for those turns; "*" means some turns in that row reported none and are not included in the sum.'), mk('div', '', 'Tokens: when a turn has no usage block, its assistant messages are summed instead (approximate, and without cost).'));
  tbl.append(notes);
  b.append(tbl);
  syncUTable();
};
function syncUTable() { const t = $('#ubody .utables'), on = !!t && !t.hidden; $('#utable').textContent = on ? 'Hide table' : 'Show table'; $('#utable').setAttribute('aria-expanded', on); $('#utable').disabled = !t; }
$('#utable').onclick = () => {
  const t = $('#ubody .utables'); if (!t) return;
  t.hidden = !t.hidden; localStorage.setItem('halay-utable', t.hidden ? '0' : '1'); syncUTable();
  if (!t.hidden) t.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
};
$('#busage').onclick = () => go('/usage');
$('#uclose').onclick = () => $('#udlg').close();

// ---- search ----------------------------------------------------------------------------------------------------

let searchSeq = 0, searchTimer = null, jump = null;
function snippetNode(s) {
  const span = mk('div', 'sn');
  let on = false;
  for (const part of s.split(/([\u0001\u0002])/)) {
    if (part === '\u0001') on = true; else if (part === '\u0002') on = false;
    else if (part) span.append(on ? mk('mark', '', part) : document.createTextNode(part));
  }
  return span;
}
async function runSearch() {
  const text = $('#q').value.trim(), box = $('#sres');
  $('#list').hidden = !!text; box.hidden = !text;
  if (!text) { searchSeq++; box.innerHTML = ''; return; }
  const seq = ++searchSeq;
  let rows;
  try { rows = await api('/search?q=' + encodeURIComponent(text)); } catch (e) { if (seq === searchSeq) box.textContent = e.message; return; }
  if (seq !== searchSeq) return;
  box.innerHTML = '';
  if (!rows.length) { box.append(mk('div', 'sr mutl', 'No matches.')); return; }
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  for (const r of rows) {
    const d = mk('div', 'sr'), h = mk('div', 'sh2');
    h.append(mk('b', '', r.agentName), mk('span', '', fmtWhen(r.ts)));
    d.append(h, snippetNode(r.snippet));
    d.onclick = () => jumpTo(r, terms);
    box.append(d);
  }
}
function clearSearch() { clearTimeout(searchTimer); $('#q').value = ''; $('#qx').hidden = true; runSearch(); $('#q').focus(); }
$('#q').addEventListener('input', () => { $('#qx').hidden = !$('#q').value; clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); });
$('#q').addEventListener('search', () => { $('#qx').hidden = !$('#q').value; runSearch(); });
$('#q').addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#q').value) { e.preventDefault(); e.stopPropagation(); clearSearch(); } });
$('#qx').onclick = clearSearch;

async function jumpTo(r, terms) {
  jump = { agentId: r.agentId, index: r.index, terms };
  if (sel === r.agentId && $('#log')) { if (location.hash.split('/').length > 3) go('/a/' + sel); await applyJump(); }
  else go('/a/' + r.agentId);
}
function afterRender() { if (jump && jump.agentId === sel) applyJump(); }
async function applyJump() {
  const j = jump; jump = null;
  if (!j || !$('#log')) return;
  if (j.index < (hidden[sel] || 0)) { // the match is in history that is not loaded yet
    try { await loadOlder(hidden[sel] - j.index + 40); } catch { return; }
  }
  const pos = j.index;
  const nodes = [...$('#log').querySelectorAll('[data-ev]')];
  if (!nodes.length) return;
  const dist = (n) => Math.abs(Number(n.dataset.ev) - pos);
  const best = Math.min(...nodes.map(dist));
  const cands = nodes.filter((n) => dist(n) === best);
  const el = cands.find((n) => j.terms.some((t) => n.textContent.toLowerCase().includes(t))) || cands[0];
  el.scrollIntoView({ block: 'center' });
  el.classList.add('hit');
  setTimeout(() => el.classList.remove('hit'), 4000);
}

// ---- settings: usage thresholds + watchdog ---------------------------------------------------------------------------

async function loadSettingsExtras() {
  const [accts, ua, wd] = await Promise.all([accountNames(), api('/settings/usage'), api('/settings/watchdog')]);
  const box = $('#ualerts'); box.innerHTML = '';
  for (const a of accts) {
    const c = ua.accounts?.[a] || {}, row = mk('div', 'urow');
    const mkIn = (label, key, step, val) => {
      const l = mk('label', 'fl'), i = mk('input', 'fld'); i.type = 'number'; i.min = '0'; i.step = step; i.inputMode = 'decimal'; i.placeholder = 'off'; i.dataset.acct = a; i.dataset.key = key; i.value = val > 0 ? val : '';
      l.append(mk('span', 'mutl', label), i); return l;
    };
    row.append(mk('b', '', a), mkIn('Daily cost ($)', 'dailyCost', '0.01', c.dailyCost), mkIn('Daily tokens (in + out)', 'dailyTokens', '1000', c.dailyTokens));
    box.append(row);
  }
  $('#wden').checked = wd.enabled; $('#wdidle').value = wd.idleMinutes; $('#wdtool').value = wd.toolMinutes; $('#wdstart').value = wd.startMinutes; $('#wdrep').value = wd.repeatCount;
  await loadContextSettings();
  await loadBrowserSettings();
  const ad = await api('/settings/agents');
  $('#adbuiltin').checked = !!ad.builtinSubagents;
  $('#admode').value = ad.permissionMode; fillModelSelect($('#admodel'), ad.model, 'Claude Code default'); fillEffortSelect($('#adeffort'), ad.effort, 'Claude Code default');
  await renderOtherDefaults(ad.perBackend || {});
}
// one block per installed CLI besides Claude: its permission modes, model (its own list, or any id) and effort (if it has one)
async function renderOtherDefaults(saved) {
  const box = $('#adother'); box.textContent = '';
  const bks = (await loadBackends()).filter((b) => b.installed && b.id !== 'claude');
  $('#adclaude').hidden = !bks.length;
  for (const b of bks) {
    const d = { permissionMode: 'manual', model: '', effort: '', ...(saved[b.id] || {}) }, c = b.capabilities;
    const wrap = mk('div'); wrap.dataset.cli = b.id;
    const mode = mk('select', 'fld'), model = mk('select', 'fld'), eff = mk('select', 'fld');
    mode.dataset.f = 'permissionMode'; model.dataset.f = 'model'; eff.dataset.f = 'effort';
    for (const o of $('#admode').options) if (c.modes.includes(o.value)) mode.append(new Option(o.textContent, o.value));
    mode.value = c.modes.includes(d.permissionMode) ? d.permissionMode : 'manual';
    fillModelSelect(model, d.model, 'default', [], true); model.title = b.modelHint || '';
    model.onchange = () => otherModel(model, b.modelHint);
    backendModels(b.id).then((ms) => fillModelSelect(model, model.value === OTHER_MODEL ? '' : model.value, 'default', ms, true));
    fillEffortSelect(eff, d.effort, 'default');
    for (const o of [...eff.options]) if (o.value && !c.effort.includes(o.value)) o.remove();
    const lab = (t, el, hide) => { const l = mk('label', 'fl'); l.append(t, el); l.hidden = !!hide; return l; };
    const h = mk('h4', 'mutl', b.label), grid = mk('div', 'sgrid');
    grid.append(lab('Permission mode', mode), lab('Model', model), lab('Effort', eff, !c.effort.length));
    wrap.append(h, grid); box.append(wrap);
  }
}
const otherDefaults = () => Object.fromEntries([...$('#adother').children].map((w) => [w.dataset.cli, Object.fromEntries([...w.querySelectorAll('select')].map((s) => [s.dataset.f, s.value === OTHER_MODEL ? '' : s.value]))]));
async function saveSettingsExtras() {
  const accounts = {};
  for (const i of $('#ualerts').querySelectorAll('input')) (accounts[i.dataset.acct] ||= {})[i.dataset.key] = Number(i.value) || 0;
  await api('/settings/usage', { method: 'PUT', body: { accounts } });
  await api('/settings/watchdog', { method: 'PUT', body: { enabled: $('#wden').checked, idleMinutes: Number($('#wdidle').value), toolMinutes: Number($('#wdtool').value), startMinutes: Number($('#wdstart').value), repeatCount: Number($('#wdrep').value) } });
  await saveContextSettings();
  await saveBrowserSettings();
  await api('/settings/agents', { method: 'PUT', body: { permissionMode: $('#admode').value, model: $('#admodel').value, effort: $('#adeffort').value, builtinSubagents: $('#adbuiltin').checked, perBackend: otherDefaults() } });
}

// ---- new agent dialog: offer a worktree when the folder is a git repo --------------------------------------------------------

let repoOk = false;
async function probeRepo(p) {
  $('#wtrow').hidden = true; repoOk = false;
  try {
    const r = await api('/git/probe?path=' + encodeURIComponent(p));
    if (cur !== p) return;
    if (r.isRepo && !r.detached) { repoOk = true; $('#wtrow').hidden = $('#oochk').checked; $('#wtinfo').textContent = `(off ${r.branch}${r.dirty ? ', which has uncommitted changes that stay behind' : ''})`; }
  } catch {}
}
$('#wtchk').onchange = () => { $('#wtopt').hidden = !$('#wtchk').checked; };
