// ---- the agents' browser: live view of a profile's Chromium (server: browser.js). The server streams the page as binary
// JPEG frames on /ws/browser?profile=…; JSON text frames carry state (tabs, who is driving). You can click, scroll and
// type into it only after "Take control", which also makes the agents' own browser actions fail until you give it back.
// Also Settings → Browser and the "Browser" checkbox of the new-agent dialog.
let brCfg = null, bws = null, bprofile = null, bstate = null, bmeta = { w: 0, h: 0 }, bframeBusy = false, bactual = false;
const brStates = {}; // profile -> latest { controller, agents } pushed on the main channel
const bsend = (o) => { if (bws?.readyState === 1) bws.send(JSON.stringify(o)); };
const iAmDriving = () => bstate?.controller?.type === 'user';

async function loadBrowserCfg() {
  try { brCfg = await api('/browser'); for (const p of brCfg.profiles) brStates[p.name] = p; } catch { brCfg = null; }
  $('#bbrow').hidden = !brCfg?.mcp || !brCfg.binary;
  $('#browrow').hidden = !brCfg?.mcp;
}

// the agent header button shows a dot while someone is driving that agent's profile
function onBrowserState(m) {
  brStates[m.profile] = m;
  renderBrowserBtn();
  const n = Object.values(brStates).filter((s) => s.controller).length;
  $('#nbrow').hidden = !n; $('#nbrow').textContent = n;
}
function renderBrowserBtn() {
  const b = $('#browb'), p = sel && agents[sel]?.browser;
  if (!b) return;
  b.hidden = !p;
  const s = p && brStates[p], me = s?.controller;
  b.classList.toggle('live', !!me);
  b.title = me ? `${me.type === 'user' ? 'You are' : me.name + ' is'} driving the browser (${p})` : `Watch and take over this agent's browser (${p})`;
}

function setupBrowserOption() {
  $('#browchk').checked = !!brCfg?.defaultOn;
}

async function openBrowser(profile) {
  if (!brCfg) await loadBrowserCfg();
  const names = brCfg?.profiles.map((p) => p.name) || [];
  profile = profile || brCfg?.profile || 'default';
  if (!names.includes(profile)) names.push(profile);
  $('#bprof').innerHTML = names.map((n) => `<option>${esc(n)}</option>`).join('');
  $('#bprof').value = profile;
  if (!$('#bdlg').open) { $('#bdlg').showModal(); fitBrowser(); }
  if (bprofile !== profile || !bws || bws.readyState > 1) bconnect(profile);
}

function bconnect(profile) {
  bclose();
  bprofile = profile; bstate = null; bmeta = { w: 0, h: 0 };
  bmsg('Starting the browser…');
  const ws = bws = new WebSocket(wsUrl('/ws/browser?profile=' + encodeURIComponent(profile)));
  ws.binaryType = 'blob';
  ws.onmessage = async (e) => {
    if (ws !== bws) return;
    if (typeof e.data !== 'string') return bdraw(e.data);
    const m = JSON.parse(e.data);
    if (m.t === 'state') { bstate = m; bmeta = m.meta?.w ? m.meta : bmeta; brender(); }
    else if (m.t === 'meta') { bmeta = m; bsize(); }
    else if (m.t === 'error') flash(m.message, 'error');
    else if (m.t === 'closed') bmsg(m.message || 'Disconnected', true);
  };
  ws.onclose = () => { if (ws === bws) { bws = null; if ($('#bdlg').open && !$('#bmsg').dataset.keep) bmsg('Disconnected.', true); } };
}
function bclose() { bfitted = false; const w = bws; bws = null; if (w) { w.onclose = null; try { w.close(); } catch {} } }
function bmsg(text, retry) {
  const m = $('#bmsg');
  m.hidden = !text; m.textContent = text || ''; m.dataset.keep = retry ? '1' : '';
  if (retry) { const b = document.createElement('button'); b.textContent = 'Reconnect'; b.onclick = () => bconnect(bprofile); m.append(' ', b); }
}

// frames: decode off the main thread and draw only the newest while one is still being decoded
let bpending = null;
async function bdraw(blob) {
  bpending = blob;
  if (bframeBusy) return;
  bframeBusy = true;
  try {
    while (bpending) {
      const b = bpending; bpending = null;
      const img = await createImageBitmap(b), cv = $('#bcv');
      if (cv.width !== img.width || cv.height !== img.height) { cv.width = img.width; cv.height = img.height; bsize(); }
      cv.getContext('2d').drawImage(img, 0, 0);
      img.close?.();
      if (!$('#bmsg').hidden && !$('#bmsg').dataset.keep) bmsg('');
    }
  } catch {} finally { bframeBusy = false; }
}
function bsize() { // fit to the width of the stage, or show the page at its real size (scroll the stage)
  const cv = $('#bcv');
  cv.style.width = bactual && bmeta.w ? bmeta.w + 'px' : '';
  $('#bstage').classList.toggle('actual', bactual);
}

function brender() {
  const s = bstate;
  if (!s) return;
  const act = s.tabs.find((t) => t.id === s.active);
  if (document.activeElement !== $('#burl')) $('#burl').value = act?.url && act.url !== 'about:blank' ? act.url : '';
  const c = s.controller, me = c?.type === 'user';
  $('#bwho').textContent = me ? 'You are in control. The agents’ browser actions are refused until you give it back.'
    : c ? `${c.name} is driving. You are watching.` : s.agents.length ? `Idle (${s.agents.map((a) => a.name).join(', ')} connected). You are watching.` : 'Idle. You are watching.';
  $('#bwho').classList.toggle('me', me);
  $('#btake').textContent = me ? 'Give back' : c ? `Take control from ${c.name}` : 'Take control';
  $('#btake').classList.toggle('primary', !me);
  $('#bkeys').hidden = !me;
  $('#bstage').classList.toggle('ctl', me);
  $('#bsub').textContent = `${s.profile} · ${s.headed ? 'headed' : 'headless'}`;
  const tabs = $('#btabs');
  tabs.innerHTML = '';
  for (const t of s.tabs) {
    const d = document.createElement('div');
    d.className = 'btab' + (t.id === s.active ? ' on' : '');
    d.innerHTML = '<button type="button" class="bt" role="tab"></button><button type="button" class="bx" aria-label="Close tab">×</button>';
    const b = d.querySelector('.bt');
    b.textContent = t.title || t.url || 'New tab'; b.title = t.url || '';
    b.setAttribute('aria-selected', t.id === s.active);
    b.onclick = () => bsend({ t: 'tab', id: t.id });
    d.querySelector('.bx').onclick = () => bsend({ t: 'closetab', id: t.id });
    d.querySelector('.bx').hidden = s.tabs.length < 2 || !me;
    tabs.append(d);
  }
  const nt = document.createElement('button');
  nt.type = 'button'; nt.className = 'bnew'; nt.textContent = '+'; nt.title = 'New tab'; nt.setAttribute('aria-label', 'New tab'); nt.hidden = !me;
  nt.onclick = () => bsend({ t: 'newtab' });
  tabs.append(nt);
  for (const id of ['bback', 'bfwd', 'breload', 'burl']) $('#' + id).disabled = !me;
  $('#bstage').classList.toggle('empty', !s.running);
  bfit();
}
// on a phone the page is made as wide as the screen while you drive, so it is readable; back to the window size after
let bfitted = false;
function bfit() {
  const st = $('#bstage'), want = iAmDriving() && matchMedia('(max-width: 700px)').matches && st.clientWidth > 0;
  if (want) { bsend({ t: 'resize', w: st.clientWidth, h: Math.max(st.clientHeight, 300) }); bfitted = true; }
  else if (bfitted) { bsend({ t: 'resize', w: 0, h: 0 }); bfitted = false; }
}
let bfitRaf = 0;
new ResizeObserver(() => { cancelAnimationFrame(bfitRaf); bfitRaf = requestAnimationFrame(bfit); }).observe($('#bstage'));

// ---- input: only while you are in control ----------------------------------------------------------------------
function bpoint(e) { // client coordinates -> the page's CSS pixels
  const cv = $('#bcv'), r = cv.getBoundingClientRect();
  return { x: Math.round((e.clientX - r.left) / r.width * (bmeta.w || cv.width)), y: Math.round((e.clientY - r.top) / r.height * (bmeta.h || cv.height)) };
}
let bdown = false, bmoveAt = 0, btouch = null;
const cv = $('#bcv');
cv.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') return;
  cv.focus();
  if (!iAmDriving()) return;
  e.preventDefault(); cv.setPointerCapture(e.pointerId); bdown = true;
  bsend({ t: 'mouse', k: 'down', ...bpoint(e), b: e.button === 2 ? 'right' : 'left', n: e.detail || 1 });
});
cv.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' || !iAmDriving() || Date.now() - bmoveAt < 40) return;
  bmoveAt = Date.now();
  bsend({ t: 'mouse', k: 'move', ...bpoint(e), held: bdown });
});
cv.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch' || !bdown) return;
  bdown = false;
  bsend({ t: 'mouse', k: 'up', ...bpoint(e), b: e.button === 2 ? 'right' : 'left', n: e.detail || 1 });
});
cv.addEventListener('contextmenu', (e) => { if (iAmDriving()) e.preventDefault(); });
cv.addEventListener('wheel', (e) => {
  if (!iAmDriving()) return; // not driving: let the stage scroll normally
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : 1;
  bsend({ t: 'wheel', ...bpoint(e), dx: e.deltaX * k, dy: e.deltaY * k });
}, { passive: false });
// touch: a tap clicks, a drag scrolls the page
cv.addEventListener('touchstart', (e) => {
  if (!iAmDriving() || e.touches.length !== 1) { btouch = null; return; }
  const t = e.touches[0];
  btouch = { x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY, scroll: false };
}, { passive: true });
cv.addEventListener('touchmove', (e) => {
  if (!btouch) return;
  e.preventDefault();
  const t = e.touches[0], r = cv.getBoundingClientRect(), k = (bmeta.w || cv.width) / r.width;
  if (!btouch.scroll && Math.hypot(t.clientX - btouch.x, t.clientY - btouch.y) > 8) btouch.scroll = true;
  if (btouch.scroll) {
    bsend({ t: 'wheel', ...bpoint(t), dx: (btouch.lx - t.clientX) * k, dy: (btouch.ly - t.clientY) * k });
    btouch.lx = t.clientX; btouch.ly = t.clientY;
  }
}, { passive: false });
cv.addEventListener('touchend', (e) => {
  if (!btouch) return;
  const b = btouch; btouch = null;
  if (b.scroll) return;
  e.preventDefault(); // no synthesized mouse events
  const p = bpoint({ clientX: b.x, clientY: b.y });
  bsend({ t: 'mouse', k: 'move', ...p }); bsend({ t: 'mouse', k: 'down', ...p, n: 1 }); bsend({ t: 'mouse', k: 'up', ...p, n: 1 });
}, { passive: false });
cv.addEventListener('keydown', (e) => {
  if (!iAmDriving() || e.isComposing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return; // the paste event carries the text
  e.preventDefault();
  bsend({ t: 'key', k: 'down', key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey });
});
cv.addEventListener('keyup', (e) => {
  if (!iAmDriving() || e.isComposing) return;
  e.preventDefault();
  bsend({ t: 'key', k: 'up', key: e.key, code: e.code, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey });
});
cv.addEventListener('paste', (e) => { if (!iAmDriving()) return; e.preventDefault(); bsend({ t: 'text', text: e.clipboardData.getData('text/plain') }); });

// phone keyboard: type into a real input, send on Enter / the Enter key
$('#btext').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  const v = $('#btext').value;
  if (v) bsend({ t: 'text', text: v });
  bsend({ t: 'key', k: 'down', key: 'Enter', code: 'Enter' }); bsend({ t: 'key', k: 'up', key: 'Enter', code: 'Enter' });
  $('#btext').value = '';
});
$('#bkeys').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-k]');
  if (!b) return;
  const v = $('#btext').value;
  if (v && b.dataset.k !== 'Backspace') { bsend({ t: 'text', text: v }); $('#btext').value = ''; }
  bsend({ t: 'key', k: 'down', key: b.dataset.k, code: b.dataset.k }); bsend({ t: 'key', k: 'up', key: b.dataset.k, code: b.dataset.k });
});

$('#btake').onclick = () => bsend({ t: iAmDriving() ? 'give' : 'take' });
$('#bback').onclick = () => bsend({ t: 'back' });
$('#bfwd').onclick = () => bsend({ t: 'forward' });
$('#breload').onclick = () => bsend({ t: 'reload' });
$('#burl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); bsend({ t: 'nav', url: $('#burl').value }); $('#burl').blur(); cv.focus(); } });
$('#burl').addEventListener('focus', () => $('#burl').select());
$('#bzoom').onclick = () => { bactual = !bactual; $('#bzoom').setAttribute('aria-pressed', bactual); bsize(); };
$('#bprof').onchange = () => go('/browser/' + $('#bprof').value);
$('#bdlg').addEventListener('close', () => { bclose(); bprofile = null; }); // closing hands control back (the server does it when the last viewer leaves)
$('#bbrow').onclick = () => go('/browser');

// phones: the soft keyboard shrinks the visual viewport only; size the dialog to what is visible
function fitBrowser() {
  const d = $('#bdlg'), vv = window.visualViewport;
  if (!d.open || !vv) { d.style.removeProperty('--vvh'); return; }
  d.style.setProperty('--vvh', vv.height + 'px');
}
window.visualViewport?.addEventListener('resize', fitBrowser);

// ---- Settings → Browser ---------------------------------------------------------------------------------------------
async function loadBrowserSettings() {
  await loadBrowserCfg();
  const c = brCfg;
  if (!c) return;
  $('#bsdef').checked = c.defaultOn; $('#bsprof').value = c.profile; $('#bspath').value = c.path; $('#bshead').checked = c.headed;
  $('#bsinfo').textContent = !c.mcp ? 'The Playwright MCP package is missing: run npm install in the swarm folder.'
    : !c.binary ? 'No Chromium found. Install one with "npx playwright install chromium" (docs/install.md), or enter its path below.'
    : `Using ${c.binary}. Profiles live in ${c.profileDir} and hold session cookies: keep that folder private.`;
  const box = $('#bslist');
  box.innerHTML = '';
  for (const p of c.profiles) {
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('b'); name.textContent = p.name;
    const st = document.createElement('span'); st.className = 'mutl'; st.textContent = p.running ? 'running' + (p.controller ? ` · ${p.controller.name} driving` : '') : p.exists ? 'stopped' : 'unused';
    const mkb = (label, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b; };
    row.append(name, st, mkb('Open', () => { $('#sdlg').close(); go('/browser/' + p.name); }));
    if (p.running) row.append(mkb('Stop', async () => { await api(`/browser/${p.name}/stop`, { method: 'POST' }).catch((e) => flash(e.message, 'error')); loadBrowserSettings(); }));
    if (p.exists) row.append(mkb('Delete logins…', async () => {
      if (!await ask(`Delete the browser profile "${p.name}"? Every login and cookie saved in it is lost, and its browser is stopped.`, { ok: 'Delete', danger: true })) return;
      await api(`/browser/${p.name}/clear`, { method: 'POST' }).then(() => flash('Profile deleted', 'ok')).catch((e) => flash(e.message, 'error'));
      loadBrowserSettings();
    }, 'red'));
    box.append(row);
  }
}
async function saveBrowserSettings() {
  if (!brCfg) return;
  brCfg = { ...brCfg, ...await api('/browser', { method: 'PUT', body: { defaultOn: $('#bsdef').checked, profile: $('#bsprof').value.trim() || 'default', headed: $('#bshead').checked, path: $('#bspath').value.trim() } }) };
}

loadBrowserCfg();
