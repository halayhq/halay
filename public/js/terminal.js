// ---- terminals: login shells in a PTY on the server (terminal.js there), drawn with xterm.js (loaded on first use).
// The server keeps each shell and its recent output, so closing this dialog or reloading the page only detaches;
// the × on a tab ends the shell. Frames on /ws/term: '0'+text is terminal data, '1'+JSON is control (see terminal.js).
// Also Settings → Server: server info and Restart server.
let terms = [], termCfg = null, tcur = null, restartPending = false, ctrlOn = false, xtermP = null;
const tviews = {}; // terminal id -> { id, info, term, fit, el, ws, ended, fresh }
const termOn = () => !!termCfg?.enabled;
const narrowTerm = () => matchMedia('(max-width: 700px)').matches;

async function loadTerms() { termCfg = await api('/terminals'); onTerms(termCfg.terminals); }

// the server's list changed (broadcast on create, exit, attach and detach)
function onTerms(list) {
  terms = list;
  for (const id in tviews) if (!tviews[id].ended && !terms.some((t) => t.id === id)) endView(id, 'terminal ended');
  renderTermUi();
}

function renderTermUi() {
  $('#bterm').hidden = !termOn();
  $('#nterm').hidden = !terms.length; $('#nterm').textContent = terms.length;
  if ($('#termb')) $('#termb').hidden = !termOn();
  if (!$('#xdlg').open) return;
  const ids = [...terms.map((t) => t.id), ...Object.keys(tviews).filter((id) => tviews[id].ended)];
  $('#xtabs').innerHTML = '';
  for (const id of ids) {
    const t = terms.find((x) => x.id === id) || tviews[id].info, d = document.createElement('div');
    d.className = 'xtab' + (id === tcur ? ' on' : '') + (tviews[id]?.ended ? ' ended' : '');
    d.innerHTML = `<button type="button" class="xt" role="tab" aria-selected="${id === tcur}">${icon('terminal')}<span></span></button><button type="button" class="xx" title="Close (ends the shell)" aria-label="Close terminal">${icon('x')}</button>`;
    d.querySelector('span').textContent = t.title;
    d.querySelector('.xt').title = t.cwd;
    d.querySelector('.xt').onclick = () => go('/term/' + id);
    d.querySelector('.xx').onclick = () => closeTerm(id);
    $('#xtabs').append(d);
  }
  $('#xnew').hidden = !termCfg?.available;
  $('#xempty').hidden = ids.length > 0;
  $('#xempty').textContent = !termCfg ? 'Loading…' : !termCfg.enabled ? 'The terminal is turned off on the server (HALAY_TERMINAL=0).'
    : !termCfg.available ? `The terminal is unavailable on the server: ${termCfg.error}` : "No terminals open. + starts a shell in your home folder; an agent's Terminal button starts one in its folder.";
  $('#xtabs .on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const loadXterm = () => xtermP ||= (async () => {
  const add = (tag, attrs) => new Promise((r, j) => { const e = Object.assign(document.createElement(tag), attrs); e.onload = r; e.onerror = () => j(new Error('Could not load the terminal (' + (attrs.src || attrs.href) + ')')); document.head.append(e); });
  try { await Promise.all([add('link', { rel: 'stylesheet', href: '/vendor/xterm.css' }), add('script', { src: '/vendor/xterm.js' })]); await add('script', { src: '/vendor/xterm-fit.js' }); }
  catch (e) { xtermP = null; throw e; }
})();

// colours from the app theme; xterm's default ANSI palette is made for dark backgrounds, so light gets its own
function termTheme() {
  const cs = getComputedStyle(document.documentElement), v = (k) => cs.getPropertyValue(k).trim();
  const base = { background: v('--bg'), foreground: v('--fg'), cursor: v('--acc'), cursorAccent: v('--bg'), selectionBackground: `rgba(${v('--acc-rgb')},.35)` };
  if (cs.colorScheme === 'dark') return base;
  return { ...base, black: '#1f2328', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f' };
}

document.addEventListener('halay:theme', () => { for (const k in tviews) tviews[k].term.options.theme = termTheme(); }); // Settings → colour theme

async function openTerms(id) {
  if (!termCfg) await loadTerms().catch((e) => flash(e.message, 'error'));
  if (!$('#xdlg').open) { $('#xdlg').showModal(); fitDialog(); for (const k in tviews) tviews[k].term.options.theme = termTheme(); }
  const known = (x) => x && (terms.some((t) => t.id === x) || tviews[x]);
  if (!known(id)) id = known(tcur) ? tcur : terms[0]?.id;
  if (id && location.hash !== '#/term/' + id) setHash('/term/' + id);
  tcur = id || null;
  renderTermUi();
  if (!id) return;
  try { await loadXterm(); } catch (e) { return flash(e.message, 'error'); }
  if (tcur === id && $('#xdlg').open) showView(id);
}

function showView(id) {
  let v = tviews[id];
  if (!v) {
    const el = document.createElement('div');
    el.className = 'xhost';
    $('#xbody').append(el);
    const term = new Terminal({ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: narrowTerm() ? 12 : 13, scrollback: 5000, cursorBlink: true, macOptionIsMeta: true, theme: termTheme() });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    for (const [k, val] of [['autocapitalize', 'off'], ['autocorrect', 'off'], ['autocomplete', 'off'], ['spellcheck', 'false']]) term.textarea?.setAttribute(k, val);
    if (IOS) keepFilled(term.textarea);
    v = tviews[id] = { id, info: terms.find((t) => t.id === id), term, fit, el, ws: null, ended: false, fresh: freshIds.delete(id) };
    term.onData((d) => termInput(v, d));
  }
  for (const k in tviews) tviews[k].el.hidden = k !== id;
  if (!v.ended && (!v.ws || v.ws.readyState > 1)) attach(v);
  requestAnimationFrame(() => { fitView(v); if (matchMedia('(pointer: fine)').matches) v.term.focus(); }); // on a phone, tapping opens the keyboard
}

function attach(v) {
  const ws = v.ws = new WebSocket(wsUrl('/ws/term?id=' + v.id));
  let replay = false;
  const replayed = () => {
    if (!replay) return;
    replay = false; fitView(v);
    if (v.fresh) { v.fresh = false; v.term.write('\x1b[2m(This shell keeps running across server restarts. To restart the swarm server from here, run swarm-restart.)\x1b[0m\r\n'); }
  };
  ws.onmessage = (m) => {
    const s = m.data;
    if (s[0] === '0') v.term.write(s.slice(1), replay ? replayed : undefined);
    else {
      const j = JSON.parse(s.slice(1));
      // (re)attached: start clean at the shell's size, replay the scrollback, then fit to this window
      if (j.type === 'size') { v.term.reset(); v.term.resize(j.cols, j.rows); replay = true; setTimeout(replayed, 400); }
      else if (j.type === 'exit') endView(v.id, `process exited${j.code ? ' with code ' + j.code : ''}`);
    }
  };
  // dropped (network, server restart): retry while the dialog is open, unless the terminal is gone
  ws.onclose = () => setTimeout(async () => {
    if (v.ws !== ws || v.ended || !$('#xdlg').open) return;
    try { await loadTerms(); if (v.ws === ws && !v.ended) attach(v); } catch { ws.onclose(); }
  }, 1500);
}

function fitView(v) {
  if (!v || v.el.hidden || !$('#xdlg').open || !v.el.clientWidth) return;
  try { v.fit.fit(); } catch {}
  if (v.ws?.readyState === 1 && !v.ended) v.ws.send('1' + JSON.stringify({ type: 'resize', cols: v.term.cols, rows: v.term.rows }));
}

function termInput(v, d) {
  if (ctrlOn && d.length === 1) { // the key bar's Ctrl applies to the next key typed
    const c = d.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64); else if (d === ' ') d = '\x00'; else if (d === '?') d = '\x7f';
    setCtrl(false);
  }
  if (v.ws?.readyState === 1 && !v.ended) v.ws.send('0' + d);
}
function setCtrl(on) { ctrlOn = on; const b = $('#xkeys [data-k=ctrl]'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }

function endView(id, msg) {
  const v = tviews[id];
  if (!v || v.ended) return;
  v.ended = true;
  v.info ||= { title: 'terminal', cwd: '' };
  v.term.write(`\r\n\x1b[2m[${msg}]\x1b[0m\r\n`);
  const ws = v.ws; v.ws = null; ws?.close();
  renderTermUi();
}

function dropView(id) {
  const v = tviews[id];
  if (!v) return;
  const ws = v.ws; v.ws = null; ws?.close();
  v.term.dispose(); v.el.remove();
  delete tviews[id];
}

async function closeTerm(id) {
  if (!tviews[id]?.ended) {
    if (!await ask('Close this terminal? The shell and anything still running in it are ended.', { ok: 'Close terminal', danger: true })) return;
    try { await api('/terminals/' + id, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) return flash(e.message, 'error'); }
  }
  dropView(id);
  terms = terms.filter((t) => t.id !== id);
  const ids = [...terms.map((t) => t.id), ...Object.keys(tviews)];
  if (tcur === id) { tcur = null; go('/term' + (ids[0] ? '/' + ids[0] : '')); }
  renderTermUi();
}

async function newTerm(body) {
  try {
    const t = await api('/terminals', { method: 'POST', body });
    if (!terms.some((x) => x.id === t.id)) terms.push(t);
    freshIds.add(t.id);
    go('/term/' + t.id);
  } catch (e) { flash(e.message, 'error'); }
}
const freshIds = new Set(); // new terminals: show the swarm-restart tip once after the first attach

// an agent's Terminal button: its existing terminal, else a new one in its folder
function termForAgent(id) {
  const t = terms.find((x) => x.agentId === id);
  if (t) return go('/term/' + t.id);
  newTerm({ agentId: id, title: agents[id]?.name });
}

// phones: the soft keyboard shrinks the visual viewport, not the layout one, so size the dialog to what is visible
function fitDialog() {
  const d = $('#xdlg'), vv = window.visualViewport;
  if (!d.open || !vv || !narrowTerm()) { d.style.removeProperty('--vvh'); d.style.removeProperty('--vvt'); return; }
  d.style.setProperty('--vvh', vv.height + 'px'); d.style.setProperty('--vvt', vv.offsetTop + 'px');
}
window.visualViewport?.addEventListener('resize', fitDialog);
window.visualViewport?.addEventListener('scroll', fitDialog);
let fitRaf = 0;
new ResizeObserver(() => { cancelAnimationFrame(fitRaf); fitRaf = requestAnimationFrame(() => fitView(tviews[tcur])); }).observe($('#xbody'));

// Esc belongs to the shell (vim!), not to the dialog; close it with ×
$('#xdlg').addEventListener('cancel', (e) => { if ($('#xbody').contains(document.activeElement)) e.preventDefault(); });
// closing only detaches: the shells keep running and are replayed on the next open
$('#xdlg').addEventListener('close', () => {
  for (const id in tviews) {
    if (tviews[id].ended) { dropView(id); continue; }
    const ws = tviews[id].ws; tviews[id].ws = null; ws?.close();
  }
  setCtrl(false);
  $('#xover').hidden = true;
});
$('#xnew').onclick = () => newTerm({});
$('#bterm').onclick = () => go('/term');

// iOS only repeats a held delete key while the focused field has something left to delete, and xterm keeps its
// textarea empty, so keep some spaces in it (xterm reads typed text from the input event, not from the field)
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function keepFilled(ta) {
  if (!ta) return;
  const fill = () => { if (ta.value.length < 16 || ta.value.length > 256) { ta.value = ' '.repeat(64); ta.setSelectionRange(64, 64); } };
  for (const ev of ['focus', 'input', 'keyup']) ta.addEventListener(ev, () => setTimeout(fill));
  fill();
}

// key bar (phones): keys the soft keyboard lacks. Acts on pointerdown (cancelled, so the keyboard stays up);
// ⌫ and the arrows repeat while held. click only comes in for keyboard activation (detail 0).
const ARROWS = { up: 'A', down: 'B', right: 'C', left: 'D' };
function keyBar(b) {
  const v = tviews[tcur], k = b.dataset.k;
  if (!v || v.ended) return;
  if (k === 'ctrl') return setCtrl(!ctrlOn);
  if (k === 'paste') return pasteKey(v);
  if (k === 'copy') return copyMode(v);
  if (ARROWS[k]) return termInput(v, (v.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + ARROWS[k]);
  termInput(v, k === 'esc' ? '\x1b' : k === 'tab' ? '\t' : k === 'bs' ? '\x7f' : b.dataset.s);
}
let keyRepeat = 0;
const stopRepeat = () => { clearTimeout(keyRepeat); clearInterval(keyRepeat); keyRepeat = 0; };
$('#xkeys').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  stopRepeat();
  keyBar(b);
  if (b.dataset.k === 'bs' || ARROWS[b.dataset.k]) keyRepeat = setTimeout(() => { keyRepeat = setInterval(() => keyBar(b), 60); }, 400);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) $('#xkeys').addEventListener(ev, stopRepeat);
$('#xkeys').addEventListener('contextmenu', (e) => e.preventDefault()); // a long press is a held key, not a menu
$('#xkeys').onclick = (e) => { const b = e.target.closest('button'); if (b && e.detail === 0) keyBar(b); };

// Paste: the clipboard API needs HTTPS (and a permission tap); otherwise a box to paste into with the phone's own menu
async function pasteKey(v) {
  try { const t = await navigator.clipboard.readText(); if (t) v.term.paste(t); return; } catch {}
  overlay('paste', v);
}

// Copy: xterm's own selection doesn't work with touch, so show the text (scrollback + screen) as plain text the phone can
// select natively, with Copy all
function termText(term) {
  const b = term.buffer.active, out = [];
  for (let i = 0; i < b.length; i++) {
    const l = b.getLine(i), s = l.translateToString(true);
    if (l.isWrapped && out.length) out[out.length - 1] += s; else out.push(s);
  }
  while (out.length && !out.at(-1)) out.pop();
  return out.join('\n');
}
function copyMode(v) { overlay('copy', v); }

function overlay(mode, v) {
  const o = $('#xover'), ta = $('#xovt');
  o.dataset.mode = mode; o.hidden = false;
  $('#xovh').textContent = mode === 'copy' ? 'Select text to copy, or copy everything' : 'Paste here, then Send';
  $('#xova').textContent = mode === 'copy' ? 'Copy all' : 'Send';
  ta.readOnly = mode === 'copy';
  ta.value = mode === 'copy' ? termText(v.term) : '';
  if (mode === 'copy') { ta.blur(); requestAnimationFrame(() => { ta.scrollTop = ta.scrollHeight; }); } else ta.focus();
  $('#xova').onclick = async () => {
    if (mode === 'paste') { const t = ta.value.replace(/\n+$/, ''); if (t) v.term.paste(t); return closeOverlay(); } // Enter runs it, like a desktop paste
    try { await navigator.clipboard.writeText(ta.value); }
    catch { ta.readOnly = false; ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); document.execCommand('copy'); ta.readOnly = true; ta.blur(); }
    flash('Copied', 'ok');
  };
}
function closeOverlay() { $('#xover').hidden = true; $('#xovt').value = ''; tviews[tcur]?.term.focus(); }
$('#xovx').onclick = closeOverlay;

// ---- Settings → Server
async function loadServerInfo() {
  try {
    const [s] = await Promise.all([api('/server'), loadTerms()]);
    $('#srvinfo').textContent = `pid ${s.pid}, Node ${s.node}, running since ${new Date(s.startedAt).toLocaleString()}. ` + (s.restartMode === 'exit'
      ? 'Restart exits and lets its supervisor (npm run dev, pm2, systemd or launchd) start it again.'
      : `Restart starts it again through a detached helper; its output then goes to ${s.serverLog || 'runs/server.log'}.`)
      + (s.installKind ? ` Installed as: ${{ clone: 'git clone', npx: 'npx (temporary; npm install -g @halay/app to keep it)', global: 'global npm install', local: 'local npm install' }[s.installKind] || s.installKind}.` : '')
      + (s.dataDir ? ` Data folder: ${s.dataDir}.` : '')
      + (s.https ? ` HTTPS: ${s.https.urls.join(', ') || 'not listening'}${s.https.expires ? ` (certificate valid until ${new Date(s.https.expires).toLocaleDateString()}${s.https.source === 'halay' ? ', renewed automatically' : ''})` : ''}.` : '')
      + (s.https?.warnings?.length ? ` HTTPS warning: ${s.https.warnings.join('; ')}.` : '')
      + (s.pathWarnings?.length ? ` Warning: ${s.pathWarnings.join('; ')}; agents that need it fail to start (see docs/install.md, "Running in the background").` : '');
    $('#srvterm').textContent = !termCfg.enabled ? 'Turned off on the server (HALAY_TERMINAL=0).' : !termCfg.available ? `Unavailable: ${termCfg.error}`
      : `On (${terms.length} open). A login shell with full access to this machine as the server's user, behind the same login as the rest of the app. Turn it off with HALAY_TERMINAL=0.`;
  } catch (e) { $('#srvinfo').textContent = e.message; }
}
$('#srestart').onclick = async () => {
  if (!await ask('Restart the server? Agents and terminals keep running and are reattached.', { ok: 'Restart' })) return;
  try {
    await api('/server/restart', { method: 'POST' });
    restartPending = true; $('#srestart').disabled = true;
    flash('Restarting the server… the page reloads when it is back.');
    setTimeout(() => flash('The server is not back after a minute. Check runs/server.log in its data folder.', 'error'), 60000);
  } catch (e) { flash(e.message, 'error'); }
};
