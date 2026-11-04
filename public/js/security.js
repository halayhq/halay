// ---- Settings → Security: passkeys (add / rename / remove) and log out
const pkWhen = (t) => t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'never';
async function loadPasskeys() {
  try {
    const r = await api('/auth/passkeys');
    const canWebauthn = window.isSecureContext && !!window.PublicKeyCredential;
    $('#pkinfo').textContent = r.passkeys.length
      ? `${r.passkeys.length} passkey${r.passkeys.length > 1 ? 's' : ''} can sign in to this server. Signed in with ${r.via === 'passkey' ? 'a passkey' : r.via === 'token' ? 'the access token' : r.via === 'local-app' ? 'the Mac app' : r.via}.`
      : 'No passkey yet: this server is signed in with the access token only.';
    $('#pkadd').disabled = !canWebauthn;
    $('#pkadd').title = canWebauthn ? '' : 'Passkeys need https:// or localhost';
    const list = $('#pklist'); list.textContent = '';
    for (const k of r.passkeys) {
      const row = document.createElement('div');
      row.className = 'pkrow';
      row.innerHTML = '<div class="pkt"><b></b><small></small></div><button type="button" class="pkren">Rename</button><button type="button" class="pkdel danger">Remove</button>';
      row.querySelector('b').textContent = k.name;
      row.querySelector('small').textContent = `${k.rpId || ''} · added ${pkWhen(k.createdAt)} · last used ${pkWhen(k.lastUsedAt)}${k.backedUp ? ' · synced' : ''}`;
      row.querySelector('.pkren').onclick = async () => {
        const name = prompt('Name for this passkey', k.name);
        if (!name || !name.trim() || name.trim() === k.name) return;
        try { await api('/auth/passkeys/' + k.id, { method: 'PATCH', body: { name } }); } catch (e) { $('#pkstatus').textContent = e.message; }
        loadPasskeys();
      };
      row.querySelector('.pkdel').onclick = async () => {
        const last = r.passkeys.length === 1;
        if (!await ask(`Remove the passkey "${k.name}"?` + (last ? ' It is your only one: the server then falls back to the access token until you set a new passkey up (needs the token).' : ''), { ok: 'Remove', danger: true })) return;
        try { await api('/auth/passkeys/' + k.id, { method: 'DELETE' }); } catch (e) { $('#pkstatus').textContent = e.message; }
        loadPasskeys();
      };
      list.append(row);
    }
  } catch (e) { $('#pkinfo').textContent = e.message; }
}
$('#pkadd').onclick = async () => {
  $('#pkstatus').textContent = '';
  try {
    const { challengeId, options } = await api('/auth/passkeys/options', { method: 'POST' });
    const response = await SimpleWebAuthnBrowser.startRegistration(options);
    await api('/auth/passkeys/verify', { method: 'POST', body: { challengeId, response } });
    $('#pkstatus').textContent = 'Passkey added. Rename it below if you like.';
  } catch (e) {
    $('#pkstatus').textContent = e.name === 'NotAllowedError' ? 'Cancelled or timed out.' : e.name === 'InvalidStateError' ? 'This device already has a passkey for this address.' : e.message;
  }
  loadPasskeys();
};
$('#pklogout').onclick = async () => {
  if (!await ask('Log out of this browser?', { ok: 'Log out' })) return;
  await fetch('/auth/logout', { method: 'POST' });
  location.reload();
};
