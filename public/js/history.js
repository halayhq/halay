// ---- history: sessions grouped by the folder they ran in; click one to resume it, or start a new agent in the folder
const ONE_OFF = 'one-off';
let allSessions = [], histPartial = false, histTimer = 0, presetDir = null, acctBackend = {};
const sBackend = (s) => s.backend || 'claude'; // Claude's transcripts carry no backend
// "Resume as": the picked account and mode when the session's CLI can use them, else one of its accounts and manual
function resumeAs(s) {
  const want = $('#hacct').value, b = sBackend(s);
  const account = (acctBackend[want] || 'claude') === b ? want : s.agentAccount || sAccts(s)[0] || s.accounts[0];
  const mode = $('#hmode').value, modes = capsOf(b)?.modes;
  return { account, permissionMode: !modes || modes.includes(mode) ? mode : 'manual' };
}
const lsJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const sAccts = (s) => (s.agentAccount ? [s.agentAccount] : s.accounts.length === 1 ? s.accounts : []); // accounts sharing one projects dir can't be told apart
const histAgo = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : s < 86400 * 14 ? Math.floor(s / 86400) + 'd ago' : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); };
function renderHistory() {
  const f = $('#hq').value.trim().toLowerCase(), showHidden = $('#hshow').checked;
  const coll = lsJSON('halay-hcoll', {}), hidden = new Set(lsJSON('halay-hhide', []));
  const groups = new Map();
  for (const s of allSessions) {
    const key = s.oneOff ? ONE_OFF : s.cwd; // one-off agents each had their own scratch folder; they share one group
    let g = groups.get(key);
    if (!g) groups.set(key, g = { cwd: key, oneOff: !!s.oneOff, exists: s.repoExists ?? s.exists, last: 0, accts: new Set(), all: [], hits: [] });
    g.all.push(s); g.last = Math.max(g.last, s.mtime); sAccts(s).forEach((a) => g.accts.add(a));
    if (!f || (s.title + ' ' + (s.oneOff ? 'one-off' : s.cwd) + ' ' + (s.model || '') + ' ' + backendLabel(sBackend(s))).toLowerCase().includes(f)) g.hits.push(s);
  }
  const list = $('#hlist'); list.innerHTML = '';
  const sorted = [...groups.values()].filter((g) => (!f || g.hits.length) && (showHidden || !hidden.has(g.cwd))).sort((a, b) => b.last - a.last);
  const nHidden = [...groups.values()].filter((g) => hidden.has(g.cwd)).length;
  $('#hshowl').hidden = !nHidden; $('#hshowl span').textContent = `Show ${nHidden} hidden`;
  if (!sorted.length) { const e = document.createElement('div'); e.className = 'hempty'; e.textContent = allSessions.length ? 'No sessions match.' : histPartial ? 'Indexing transcripts…' : 'No previous sessions.'; list.append(e); }
  sorted.forEach((g, i) => {
    const open = f ? true : (g.cwd in coll ? !coll[g.cwd] : i < 2); // while filtering, groups with matches are open
    const sec = document.createElement('section'); sec.className = 'hg' + (open ? ' open' : '') + (hidden.has(g.cwd) ? ' ishidden' : '');
    const name = g.oneOff ? 'One-off' : g.cwd.replace(/\/+$/, '').split('/').pop() || g.cwd;
    const head = document.createElement('div'); head.className = 'hgh';
    head.innerHTML = '<button class="hgt" aria-expanded="false"><i class="chev">' + icon('chevron-right') + '</i><span class="hgm"><b class="hgn"></b><span class="hgp"><bdi></bdi></span><small class="hgs"></small></span></button><span class="hga"><button class="hnew" title="Start a new agent in this folder">' + icon('plus') + 'New</button><button class="hhide"></button></span>';
    head.querySelector('.hgn').textContent = name + (g.exists || g.oneOff ? '' : ' (missing)');
    head.querySelector('.hgp').title = g.oneOff ? 'Agents started in a throwaway folder; the folder is removed with the agent, the conversation stays' : g.cwd; head.querySelector('bdi').textContent = g.oneOff ? 'scratch folders, removed with their agents' : g.cwd;
    head.querySelector('.hgs').textContent = `${g.all.length} session${g.all.length === 1 ? '' : 's'}${f ? ` · ${g.hits.length} match` : ''} · ${histAgo(g.last)}${g.accts.size ? ' · ' + [...g.accts].join(', ') : ''}`;
    const tg = head.querySelector('.hgt'); tg.setAttribute('aria-expanded', open);
    tg.onclick = () => { const c = lsJSON('halay-hcoll', {}); c[g.cwd] = sec.classList.toggle('open') ? 0 : 1; tg.setAttribute('aria-expanded', sec.classList.contains('open')); localStorage.setItem('halay-hcoll', JSON.stringify(c)); if (sec.classList.contains('open') && !sec.querySelector('.hrow')) fill(); };
    head.querySelector('.hgp').onclick = (e) => { e.stopPropagation(); flash(g.oneOff ? 'One-off agents run in a throwaway folder that is deleted with the agent. Their conversations stay here; opening one recreates an empty folder.' : g.cwd); };
    if (g.oneOff) head.querySelector('.hnew').hidden = true;
    const hb = head.querySelector('.hhide'); hb.textContent = hidden.has(g.cwd) ? 'Unhide' : 'Hide'; hb.title = 'Hide or show this folder in History (stored in this browser)';
    hb.onclick = () => { const h = new Set(lsJSON('halay-hhide', [])); h.has(g.cwd) ? h.delete(g.cwd) : h.add(g.cwd); localStorage.setItem('halay-hhide', JSON.stringify([...h])); renderHistory(); };
    head.querySelector('.hnew').onclick = () => { if (!g.exists) return flash('That folder no longer exists.'); presetDir = g.cwd; go('/new'); };
    const body = document.createElement('div'); body.className = 'hgb';
    const fill = () => {
      const rows = new Map(); // agent id -> its row, so sub-agents can nest under it
      const kids = g.hits.filter((s) => s.parentAgent && g.hits.some((p) => p.agent === s.parentAgent));
      for (const s of [...g.hits.filter((x) => !kids.includes(x)), ...kids]) {
        const d = document.createElement('div'); d.className = 'hrow' + (s.agent ? ' live' : '') + (kids.includes(s) ? ' sub' : '') + (!s.exists && !s.oneOff ? ' gone' : '');
        d.innerHTML = '<span class="ht"></span><small class="hm"></small>';
        d.firstChild.textContent = s.title;
        const bits = [histAgo(s.mtime)];
        if (sBackend(s) !== 'claude') bits.push(backendLabel(sBackend(s)));
        if (s.turns) bits.push(`${s.turns} turn${s.turns === 1 ? '' : 's'}`);
        else if (s.msgs) bits.push(`${s.msgs} msg`);
        bits.push(...sAccts(s));
        if (s.model) bits.push(s.model.replace(/^claude-/, ''));
        const tok = s.tokens && (s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheCreate);
        if (tok) bits.push(fmtN(s.tokens.input + s.tokens.cacheCreate + s.tokens.output) + ' tok' + (s.tokens.cacheRead ? ` (+${fmtN(s.tokens.cacheRead)} cached)` : ''));
        if (s.cost) bits.push(fmtCost(s.cost));
        if (s.worktree) bits.push(s.worktree === true ? 'worktree' : 'worktree ' + s.worktree);
        if (s.parentAgent && !kids.includes(s) && agents[s.parentAgent]) bits.push('↳ ' + agents[s.parentAgent].name);
        if (s.oneOff) bits.push('one-off' + (s.exists ? '' : ' · folder removed'));
        else if (!s.exists) bits.push('folder missing');
        d.lastChild.textContent = bits.join(' · ');
        d.title = s.title;
        if (s.agent && agents[s.agent]) { const b = document.createElement('b'); b.className = 'hlive'; b.textContent = '● live · ' + (agents[s.agent].name || s.agentName || s.agent); d.insertBefore(b, d.lastChild); }
        d.onclick = async () => {
          if (s.agent && agents[s.agent]) { $('#hdlg').close(); return select(s.agent); }
          if (!s.exists && !s.oneOff) return;
          try {
            if (sBackend(s) !== 'claude') { d.classList.add('busy'); flash(`Reading the ${backendLabel(sBackend(s))} session…`); }
            const a = await api('/agents', { method: 'POST', body: { cwd: s.resumeCwd || s.cwd, sessionId: s.id, ...resumeAs(s) } });
            $('#hdlg').close(); agents[a.id] = a; select(a.id);
          } catch (e) { flash(e.message, 'error'); } finally { d.classList.remove('busy'); }
        };
        if (s.agent) rows.set(s.agent, d);
        const pr = kids.includes(s) && rows.get(s.parentAgent);
        if (pr) { let at = pr; while (at.nextSibling?.classList.contains('sub')) at = at.nextSibling; at.after(d); } else body.append(d);
      }
      if (!g.hits.length) body.textContent = 'No matches.';
    };
    if (open) fill();
    sec.append(head, body); list.append(sec);
  });
}
$('#hist').onclick = () => go('/history');
async function loadHistory() {
  clearTimeout(histTimer);
  const r = await api('/sessions/all');
  allSessions = r.sessions; histPartial = r.partial;
  if ($('#hdlg').open) renderHistory();
  if (r.partial && $('#hdlg').open) histTimer = setTimeout(() => loadHistory().catch(() => {}), 1500); // server is still indexing big transcripts
}
async function openHistory() {
  $('#hmode').innerHTML = $('#mode').innerHTML;
  const list = await api('/accounts').catch(() => [{ name: 'claude', backend: 'claude' }]);
  await loadBackends();
  acctBackend = Object.fromEntries(list.map((a) => [a.name, a.backend || 'claude']));
  const accts = list.map((a) => a.name);
  $('#hacct').innerHTML = accts.map((a) => `<option>${a}</option>`).join('');
  $('#hacct').value = localStorage.getItem('halay-acct') || accts[0];
  $('#hlist').innerHTML = skel(6);
  $('#hdlg').showModal();
  await loadHistory();
}
$('#hq').oninput = renderHistory;
$('#hshow').onchange = renderHistory;
$('#hclose').onclick = () => { clearTimeout(histTimer); $('#hdlg').close(); };
$('#hdlg').addEventListener('close', () => clearTimeout(histTimer));

