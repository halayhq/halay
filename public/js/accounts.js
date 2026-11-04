// ---- Settings → Accounts: login state of each account (Claude: `claude auth status`; other CLIs: their backend's check),
// with the command that fixes a logged-out one; adding, keeping (an alias account) and removing accounts
async function loadAccounts(refresh) {
  const list = $('#acctlist'), btn = $('#arecheck');
  btn.disabled = true;
  try {
    const [accts, bks] = await Promise.all([api('/accounts' + (refresh ? '?refresh=1' : '')), loadBackends()]);
    const label = (id) => bks.find((b) => b.id === id)?.label || id;
    const perBackend = (id) => accts.filter((x) => x.backend === id).length;
    list.textContent = '';
    for (const a of accts) {
      const row = mk('div', 'pkrow'), t = mk('div', 'pkt');
      const head = mk('b', '', (a.loggedIn ? '\u25CF ' : a.loggedIn === false ? '\u25CF ' : '\u25CB ') + a.name);
      head.style.color = a.loggedIn ? 'var(--ok)' : a.loggedIn === false ? 'var(--err)' : '';
      const info = a.loggedIn ? ['logged in', a.method === 'claude.ai' ? 'claude.ai subscription' : a.method, a.email, a.org && a.org !== a.email + "'s Organization" ? a.org : '', a.plan].filter(Boolean).join(' \u00B7 ')
        : a.loggedIn === false ? 'logged out: agents on this account fail until you log in' : 'unknown: ' + (a.error || 'not checked yet');
      // the account the CLI's agents get when none is named (Settings → Accounts → Set as default)
      if (a.default && perBackend(a.backend) > 1) { const d = mk('span', 'botbadge', 'default for ' + label(a.backend)); d.title = `New ${label(a.backend)} agents, tasks and schedules use ${a.name} unless you pick another account`; head.append(d); }
      t.append(head, mk('small', '', `${info} \u00B7 checked ${relTime(a.checkedAt) === 'now' ? 'just now' : relTime(a.checkedAt) + ' ago'}`));
      const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      const exp = (label, ms) => ms ? `${label} ${ms < Date.now() ? 'expired' : 'expires'} ${when(ms)}` : '';
      const ex = [exp('access token', a.accessExpiresAt), exp('login (refresh token)', a.refreshExpiresAt)].filter(Boolean).join(' \u00B7 ');
      if (ex) t.append(mk('small', '', ex + (a.accessExpiresAt && a.accessExpiresAt < Date.now() && a.loggedIn ? ' (renews itself on next use)' : '')));
      row.append(t);
      const where = a.source === 'swarm' ? 'added here' + (a.dir ? ' \u00B7 ' + a.dir : '') : a.source === 'alias' ? 'from a zsh alias' : '';
      if (where) t.append(mk('small', '', where));
      const btns = mk('div', 'abtns');
      if (a.loggedIn !== true && a.fix) {
        t.append(mk('small', '', 'Fix: run ' + a.fix));
        if (termCfg?.available || !termCfg) btns.append(loginBtn(a));
      }
      if (!a.default) {
        const b = mk('button', '', 'Set as default'); b.type = 'button';
        b.title = `Make ${a.name} the account new ${label(a.backend)} agents get when none is picked`;
        // the CLI's own account is the default anyway: choosing it clears the choice
        b.onclick = () => api('/accounts/default', { method: 'PUT', body: { backend: a.backend, account: a.source === 'cli' ? null : a.name } })
          .then(() => { backendsP = null; flash(`${a.name} is now the default ${label(a.backend)} account`); loadAccounts(); }).catch((e) => flash(e.message, 'error'));
        btns.append(b);
      }
      if (a.source === 'alias') {
        const b = mk('button', '', 'Keep here'); b.type = 'button';
        b.title = 'Keep this account in the swarm, so the alias can be removed from your shell config';
        b.onclick = () => api(`/accounts/${a.name}/save`, { method: 'POST' }).then(() => { flash(`${a.name} is kept in the swarm: you can remove its alias`); loadAccounts(); }).catch((e) => flash(e.message, 'error'));
        btns.append(b);
      }
      if (a.source === 'swarm') {
        const b = mk('button', '', 'Remove'); b.type = 'button';
        b.onclick = async () => {
          if (!confirm(`Remove the account ${a.name}? Its folder${a.dir ? ` (${a.dir})` : ''} and login stay on disk.`)) return;
          try { await api(`/accounts/${a.name}`, { method: 'DELETE' }); backendsP = null; loadAccounts(); } catch (e) { flash(e.message, 'error'); }
        };
        btns.append(b);
      }
      if (btns.children.length) row.append(btns);
      list.append(row);
    }
    // CLIs that can't run here (not on the server's PATH, or too old for ACP) and why; found when the server starts
    for (const b of (await loadBackends()).filter((x) => !x.installed)) {
      const row = mk('div', 'pkrow'), t = mk('div', 'pkt');
      const head = mk('b', '', '\u25CB ' + b.label);
      t.append(head, mk('small', '', 'not available: ' + (b.reason || 'not installed') + '. Fix it, then restart the server.'));
      row.append(t); list.append(row);
    }
  } catch (e) { list.textContent = e.message; }
  finally { btn.disabled = false; }
}
$('#arecheck').onclick = () => loadAccounts(true);

// a terminal running the account's login command
function loginBtn(a) {
  const b = mk('button', '', 'Log in');
  b.type = 'button'; b.title = 'Opens a terminal running: ' + a.fix;
  b.onclick = async () => { $('#sdlg').close(); await newTerm({ title: 'Log in ' + a.name, input: a.fix.replace(/\s+#.*$/, '') }); };
  return b;
}

// ---- add an account: the CLI gets a folder of its own for its login (Claude: CLAUDE_CONFIG_DIR, OpenCode: XDG_DATA_HOME,
// Gemini: GEMINI_CLI_HOME), then a terminal logs it in
$('#aadd').addEventListener('toggle', async () => {
  if (!$('#aadd').open) return;
  const bks = (await loadBackends()).filter((b) => b.installed);
  $('#aaback').innerHTML = '';
  for (const b of bks) { const o = mk('option', '', b.label + (b.addAccounts === true ? '' : ' (can\'t add)')); o.value = b.id; o.disabled = b.addAccounts !== true; o.title = typeof b.addAccounts === 'string' ? b.addAccounts : ''; $('#aaback').append(o); }
  aaSync();
});
function aaSync() {
  const b = $('#aaback').value;
  $('#aasharel').hidden = b !== 'claude';
  $('#aaname').placeholder = 'e.g. ' + b + '-work';
  $('#aadir').placeholder = '~/.halay-accounts/' + ($('#aaname').value.trim() || '<name>');
  const off = [...$('#aaback').options].filter((o) => o.disabled && o.title).map((o) => o.title);
  $('#aanote').textContent = off.join(' ');
}
$('#aaback').onchange = aaSync;
$('#aaname').oninput = aaSync;
$('#aago').onclick = async () => {
  const btn = $('#aago'); btn.disabled = true;
  try {
    const a = await api('/accounts', { method: 'POST', body: { backend: $('#aaback').value, name: $('#aaname').value.trim(), dir: $('#aadir').value.trim() || undefined, shareHistory: $('#aashare').checked } });
    backendsP = null; // the pickers list the new account
    $('#aaname').value = ''; $('#aadir').value = ''; $('#aadd').open = false;
    await loadAccounts();
    if (a.loggedIn !== true && a.fix && (termCfg?.available || !termCfg)) loginBtn(a).click();
    else flash(`Account ${a.name} added`);
  } catch (e) { flash(e.message, 'error'); } finally { btn.disabled = false; }
};
