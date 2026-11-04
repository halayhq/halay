// Login page (served at / without a session): sign in with a passkey, set up the first one (needs the access token), or use the token.
const $ = (s) => document.querySelector(s);
let NAME = 'halay'; // replaced by the product name from the manifest (package.json via product.js on the server)
const nameP = fetch('/manifest.webmanifest').then((r) => r.json()).then((m) => { if (m.name) { NAME = m.name; document.title = 'Sign in · ' + NAME; } }).catch(() => {});
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const say = (t, ok) => { const m = $('#msg'); m.textContent = t || ''; m.classList.toggle('ok', !!ok); };
const webauthn = window.isSecureContext && !!window.PublicKeyCredential && !!window.SimpleWebAuthnBrowser;
const fromUrl = new URLSearchParams(location.search).get('token') || '';
if (fromUrl) history.replaceState(null, '', location.pathname); // keep the token out of history and the address bar
const done = () => location.replace('/');
const busy = async (fn) => {
  const b = $('#main'); b.disabled = true; say('');
  try { await fn(); } catch (e) { say(e.name === 'NotAllowedError' ? 'Cancelled or timed out. Try again.' : e.name === 'InvalidStateError' ? 'This device already has a passkey for this app.' : e.message); }
  b.disabled = false;
};

function show({ title, lead, main, alt }) {
  $('#title').textContent = title; $('#title').classList.toggle('wordmark', title === NAME); $('#lead').textContent = lead;
  $('#main').hidden = !main; $('#main').textContent = main || '';
  $('#alt').hidden = !alt; $('#alt').textContent = alt || '';
}
const tokenLogin = () => busy(async () => { await post('/auth/token', { token: $('#tok').value.trim() }); done(); });
const needsHttps = 'Passkeys need a secure connection (https:// or localhost). Open the app at its HTTPS address, or use the access token.';

(async () => {
  await nameP;
  let st;
  try { st = await (await fetch('/auth/state')).json(); } catch { return show({ title: NAME, lead: 'Cannot reach the server.', main: 'Retry' }), ($('#main').onclick = () => location.reload()); }
  if (st.loggedIn) return done();
  $('#tok').value = fromUrl;

  if (st.setup) { // first run: proving the token is required, a passkey can't be claimed by whoever reaches this page
    show({ title: 'Set up your passkey', lead: webauthn ? 'No passkey is registered yet. Confirm with the access token (the ?token=… part of the URL printed when the server started, or the file .token), then your device creates a passkey.' : needsHttps, main: webauthn ? 'Set up your passkey' : 'Sign in with token', alt: webauthn ? 'Continue with the token only' : '' });
    $('#tokform').hidden = false;
    $('#main').onclick = webauthn ? () => busy(async () => {
      const token = $('#tok').value.trim();
      if (!token) throw new Error('Enter the access token first.');
      const { challengeId, options } = await post('/auth/setup/options', { token });
      const response = await SimpleWebAuthnBrowser.startRegistration(options);
      await post('/auth/setup/verify', { challengeId, response });
      done();
    }) : tokenLogin;
    $('#alt').onclick = tokenLogin;
    return;
  }

  show({ title: NAME, lead: webauthn ? 'Sign in with your passkey.' : needsHttps, main: webauthn ? 'Sign in with passkey' : '' });
  if (webauthn) $('#main').onclick = () => busy(async () => {
    const { challengeId, options } = await post('/auth/login/options');
    const response = await SimpleWebAuthnBrowser.startAuthentication(options);
    await post('/auth/login/verify', { challengeId, response });
    done();
  });
})();
$('#tokform').onsubmit = (e) => { e.preventDefault(); $('#main').click(); };
