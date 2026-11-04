// ---- settings: browser notifications (other channels such as ntfy are plugins: js/plugins.js)
const b64u = (k) => Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(k.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const iosBrowser = /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone;
const pushOk = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && window.Notification;

// the halay Mac app (macos/) sets window.halayShell before the page loads: its webview has no Web Push, so it shows
// agents' notifications itself (a Notification shim that hands them to macOS), and this setting is for other devices
const inShell = !!window.halayShell;

// what this device can do: { kind: 'shell'|'insecure'|'ios-install'|'unsupported'|'denied'|'off'|'on', sub }
async function pushStatus() {
  if (inShell) return { kind: 'shell' };
  if (!window.isSecureContext) return { kind: 'insecure' };
  if (!pushOk()) return { kind: iosBrowser ? 'ios-install' : 'unsupported' };
  if (Notification.permission === 'denied') return { kind: 'denied' };
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return { kind: sub && Notification.permission === 'granted' && localStorage.getItem('halay-bn') !== 'off' ? 'on' : 'off', sub };
}
async function renderPush() {
  const st = await pushStatus(), httpsUrl = (await api('/push/key').catch(() => ({}))).httpsUrl || '';
  const msg = {
    shell: 'Web Push is for your phone or another browser: open halay there to turn it on. This window is the halay Mac app, which shows its own notifications (change them in System Settings → Notifications).',
    insecure: `Notifications need HTTPS, and this page is plain http. Open the app ${httpsUrl ? `at ${httpsUrl}` : 'over HTTPS'} (e.g. served by "tailscale serve"; set the address with HALAY_PUBLIC_URL or in Settings) and enable them there. In-page alerts keep working here.`,
    'ios-install': 'On iPhone/iPad, notifications only work from the Home Screen app: open the HTTPS address in Safari, tap Share → Add to Home Screen, open Swarm from the new icon, and enable notifications there.',
    unsupported: 'This browser does not support Web Push. In-page alerts still work; the ntfy plugin (Settings → Plugins) is an option.',
    denied: 'Notifications are blocked for this site. Allow them in the browser or phone settings, then come back.',
    off: 'Get a notification when an agent finishes, errors or needs approval, even with this page closed.',
    on: 'Notifications are on for this device (also work with the page closed).',
  }[st.kind];
  $('#pnote').textContent = msg;
  $('#pbtn').hidden = !['off', 'on'].includes(st.kind);
  $('#pbtn').textContent = st.kind === 'on' ? 'Turn off on this device' : 'Enable notifications';
  $('#ptest').hidden = st.kind !== 'on';
  $('#bnotif').hidden = ['on', 'unsupported', 'shell'].includes(st.kind);
  return st;
}
async function enablePush() {
  const reg = swReg || await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  swReg = reg;
  if (await Notification.requestPermission() !== 'granted') throw new Error('Permission was not granted');
  const { publicKey } = await api('/push/key');
  const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(publicKey) });
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  localStorage.setItem('halay-bn', 'on');
}
async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration(), sub = await reg?.pushManager.getSubscription();
  if (sub) { await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
  localStorage.setItem('halay-bn', 'off');
}
$('#pbtn').onclick = async () => {
  $('#pstatus').textContent = '';
  try { (await pushStatus()).kind === 'on' ? await disablePush() : await enablePush(); }
  catch (e) { $('#pstatus').textContent = e.message; }
  renderPush();
};
$('#ptest').onclick = async () => {
  $('#pstatus').textContent = 'Sending…';
  try { const r = await api('/push/test', { method: 'POST' }); $('#pstatus').textContent = `Sent to ${r.sent} of ${r.total} device(s).`; }
  catch (e) { $('#pstatus').textContent = e.message; }
};
$('#bnotif').onclick = () => go('/settings');
// register the worker on every load where it is possible, keep the subscription fresh, and open agents from notification taps
if (!inShell && pushOk()) {
  navigator.serviceWorker.register('/sw.js').then((r) => { swReg = r; }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'goto') go(e.data.hash); });
  pushStatus().then(async (st) => { if (st.kind === 'on') api('/push/subscribe', { method: 'POST', body: { subscription: st.sub.toJSON() } }).catch(() => {}); });
}
const nbody = () => ({ publicUrl: $('#nurl').value, details: $('#ndetails').checked, events: { done: $('#ndone').checked, error: $('#nerror').checked, blocked: $('#nblocked').checked, usage: $('#nusage').checked, stuck: $('#nstuck').checked, context: $('#ncontext').checked } });
OPENERS.settings = async () => {
  const n = await api('/settings/notify');
  $('#nurl').value = n.publicUrl;
  $('#ndetails').checked = n.details; $('#ndone').checked = n.events.done; $('#nerror').checked = n.events.error; $('#nblocked').checked = n.events.blocked; $('#nusage').checked = n.events.usage; $('#nstuck').checked = n.events.stuck; $('#ncontext').checked = n.events.context !== false;
  await loadSettingsExtras();
  loadServerInfo();
  loadPasskeys();
  loadPeers();
  loadAccounts();
  renderPluginSettings();
  $('#nstatus').textContent = '';
  $('#pstatus').textContent = '';
  await renderPush(); $('#sdlg').showModal();
  $('#sdlg .dlg-body').scrollTop = 0; railSpy();
};
// one Save for everything on the server (several endpoints, and half-typed numbers shouldn't be sent), so no auto-save
$('#ssave').onclick = async () => {
  const b = $('#ssave'); b.disabled = true; $('#nstatus').textContent = '';
  try { await api('/settings/notify', { method: 'PUT', body: nbody() }); await saveSettingsExtras(); await savePeerSelf(); $('#sdlg').close(); flash('Settings saved', 'ok'); }
  catch (e) { $('#nstatus').textContent = e.message; flash(e.message, 'error'); }
  finally { b.disabled = false; }
};
// left rail: jump to a section; the section in view is highlighted
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function railSpy() {
  const body = $('#sdlg .dlg-body'), secs = [...document.querySelectorAll('#sdlg .ssec')];
  let on = secs[0];
  for (const s of secs) if (s.offsetTop - body.offsetTop <= body.scrollTop + 60) on = s;
  if (body.scrollTop > 0 && body.scrollTop + body.clientHeight >= body.scrollHeight - 4) on = secs.at(-1); // the last ones can't reach the top
  document.querySelectorAll('.srail a').forEach((a) => { a.classList.toggle('on', a.dataset.sec === on.id); a.toggleAttribute('aria-current', a.dataset.sec === on.id); });
}
$('#sdlg .dlg-body').addEventListener('scroll', railSpy, { passive: true });
document.querySelectorAll('.srail a').forEach((a) => a.onclick = (e) => { e.preventDefault(); $('#' + a.dataset.sec).scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' }); });
$('#sclose').onclick = () => $('#sdlg').close();
$('#bset').onclick = () => go('/settings');

async function loadExtras() {
  try { [tasks, approvals, schedules] = await Promise.all([api('/tasks'), api('/approvals'), api('/schedules')]); } catch {}
  loadTerms().catch(() => {});
  loadRooms().catch(() => {});
  updateBadges(); renderTasks(); renderApprovals();
}

