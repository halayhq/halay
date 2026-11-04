// Small shared UI helpers: icons from /icons.svg, toast()/flash() notifications instead of alert(), ask() dialogs instead of confirm().
// The toast stack is a manual popover so it shows above open modal dialogs (both live in the top layer; the later one wins).
// It sits just below the page header (desktop: top-right, phone: top-centre), so it never covers the header's buttons or
// the composer at the bottom.
function toastLayer() {
  const t = $('#toasts');
  const h = document.querySelector('#head'), r = h && h.getBoundingClientRect();
  t.style.setProperty('--toast-top', r && r.height && r.bottom > 0 && r.bottom < innerHeight / 3 ? Math.round(r.bottom) + 'px' : '0px');
  // re-raise only when needed: a modal opened after the stack would cover it
  const under = [...document.querySelectorAll('dialog[open]')].some((d) => d.matches(':modal'));
  t.classList.toggle('over-dlg', under); // phone: dialogs sit near the top, so the stack moves to the bottom edge
  if (t.showPopover && (!t.matches(':popover-open') || under)) { try { t.hidePopover(); } catch {} t.showPopover(); }
  return t;
}
// a dialog closed: the stack goes back below the header
document.addEventListener('close', () => setTimeout(() => {
  const t = $('#toasts'); if (t) t.classList.toggle('over-dlg', [...document.querySelectorAll('dialog[open]')].some((d) => d.matches(':modal')));
}), true);
// The sprite is inlined once, so icons added later point into this page: an external <use href="/icons.svg#…"> is
// re-resolved by WebKit every time it's inserted, and blinks when a list is rebuilt.
fetch('/icons.svg').then((r) => r.text()).then((t) => {
  const d = document.createElement('div'); d.hidden = true; d.innerHTML = t; document.body.prepend(d);
  for (const u of document.querySelectorAll('use[href^="/icons.svg#"]')) u.setAttribute('href', u.getAttribute('href').slice(10));
}).catch(() => {});
const icon = (name, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// One notification card in the toast stack (newest nearest the top, at most 3).
//   { title, label?, body?, kind: 'info'|'ok'|'warn'|'err', icon?, alert?, ms?, open?: () => void, openLabel? }
// title + an optional muted label on one line, the body clamped to two lines. With `open`, a click or Enter runs it
// (and closes the toast); without, a click just closes it. Esc or the × closes it. The timer pauses while the pointer
// or the keyboard focus is on it; on touch it can be swiped sideways.
const TOAST_ICON = { info: 'info', ok: 'circle-check', warn: 'triangle-alert', err: 'circle-alert' };
const toastCalm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function toast(o) {
  const kind = TOAST_ICON[o.kind] ? o.kind : 'info';
  const d = document.createElement('div');
  d.className = `toast ${kind} in` + (o.open ? ' act' : '') + (o.body || o.label ? '' : ' solo');
  d.setAttribute('role', o.alert ? 'alert' : 'status'); d.tabIndex = 0;
  if (o.open) d.title = o.openLabel || 'Open';
  d.innerHTML = `<span class="tic">${icon(o.icon || TOAST_ICON[kind])}</span><div class="ttx"><div class="tt"><b></b><span class="tl"></span></div><p></p></div>`
    + `<button type="button" class="tclose" aria-label="Dismiss notification" title="Dismiss (Esc)">${icon('x')}</button>`;
  d.querySelector('b').textContent = String(o.title ?? '');
  const l = d.querySelector('.tl'); if (o.label) l.textContent = o.label; else l.remove();
  const p = d.querySelector('p'); if (o.body) p.textContent = o.body; else p.remove();
  d.addEventListener('animationend', () => d.classList.remove('in'), { once: true });

  let left = o.ms ?? 5000, t0 = 0, timer = 0, held = 0;
  const close = () => {
    if (d.classList.contains('out')) return;
    clearTimeout(timer); d.classList.add('out');
    const back = d.contains(document.activeElement); // focus was on the toast: don't drop it on <body>
    const gone = () => { d.remove(); if (back) $('#main')?.focus({ preventScroll: true }); if (!$('#toasts').children.length) try { $('#toasts').hidePopover?.(); } catch {} };
    if (toastCalm()) gone(); else { d.addEventListener('animationend', gone, { once: true }); setTimeout(gone, 400); }
  };
  const run = () => { if (held || !left) return; t0 = Date.now(); timer = setTimeout(close, left); };
  const hold = (on) => {
    held = Math.max(0, held + (on ? 1 : -1));
    if (on && held === 1) { clearTimeout(timer); left = Math.max(1200, left - (Date.now() - t0)); } else if (!held) run();
  };
  d.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') hold(true); });
  d.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hold(false); });
  d.addEventListener('focusin', () => { if (!d.dataset.f) { d.dataset.f = 1; hold(true); } });
  d.addEventListener('focusout', (e) => { if (!d.contains(e.relatedTarget)) { delete d.dataset.f; hold(false); } });
  const act = () => { close(); o.open?.(); };
  d.querySelector('.tclose').onclick = (e) => { e.stopPropagation(); close(); };
  d.onclick = () => { if (d.dataset.swiped) return; act(); };
  d.onkeydown = (k) => {
    if (k.key === 'Escape') { k.preventDefault(); k.stopPropagation(); close(); }
    else if ((k.key === 'Enter' || k.key === ' ') && k.target === d) { k.preventDefault(); act(); }
  };
  // swipe sideways to dismiss (touch and pen); a short drag snaps back
  let sx = null, dx = 0;
  d.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' || e.target.closest('.tclose')) return; sx = e.clientX; dx = 0; delete d.dataset.swiped; });
  d.addEventListener('pointermove', (e) => {
    if (sx === null) return; dx = e.clientX - sx;
    if (Math.abs(dx) > 6) { d.classList.add('drag'); d.style.transform = `translateX(${dx}px)`; d.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 220)); }
  });
  const end = () => {
    if (sx === null) return; sx = null; d.classList.remove('drag');
    if (Math.abs(dx) > 6) { d.dataset.swiped = 1; setTimeout(() => delete d.dataset.swiped, 50); }
    if (Math.abs(dx) > 80) { d.style.setProperty('--sx', dx + 'px'); d.classList.add('swipe'); close(); } else { d.style.transform = ''; d.style.opacity = ''; }
  };
  d.addEventListener('pointerup', end); d.addEventListener('pointercancel', end);

  const box = toastLayer(); box.prepend(d);
  for (const old of [...box.children].filter((c) => !c.classList.contains('out')).slice(3)) old._close?.();
  d._close = close;
  run();
  return { close };
}

// A short message in the toast stack. kind: 'info' | 'ok' | 'error'. Errors stay longer; a click closes it.
function flash(text, kind = 'info') {
  const k = kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : 'info';
  return toast({ title: String(text ?? ''), kind: k, alert: k === 'err', ms: k === 'err' ? 9000 : 4000 });
}

// Styled confirm. Resolves true/false. opts: { ok: 'Remove', danger: true, cancel: 'Cancel' }. Focus starts on Cancel.
let askN = 0;
function ask(text, opts = {}) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'ask';
    const mid = 'askmsg' + ++askN; d.setAttribute('aria-labelledby', mid); d.setAttribute('aria-describedby', mid);
    d.innerHTML = `<p id="${mid}"></p><div class="row"><span style="flex:1"></span><button type="button" class="no"></button><button type="button" class="yes ${opts.danger ? 'danger' : 'primary'}"></button></div>`;
    d.querySelector('p').textContent = text;
    d.querySelector('.no').textContent = opts.cancel || 'Cancel';
    d.querySelector('.yes').textContent = opts.ok || 'OK';
    let answer = false;
    d.querySelector('.yes').onclick = () => { answer = true; d.close(); };
    d.querySelector('.no').onclick = () => d.close();
    d.addEventListener('close', () => { d.remove(); resolve(answer); });
    document.body.append(d);
    d.showModal();
    if ($('#toasts').children.length) toastLayer(); // keep a visible error above the new dialog
    d.querySelector('.no').focus();
  });
}

// Theme switch: the segmented control in Settings and the sidebar button (cycles system → light → dark).
const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };
function renderThemeButton() {
  const t = localStorage.getItem('halay-theme') || 'system', b = $('#btheme');
  if (!b) return; // a row in the sidebar's More menu: icon, the current theme, and what a click switches to
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  b.innerHTML = icon(THEME_ICON[t]) + `<span>Theme: ${cap(t)}</span><small>${cap(nextTheme())} next</small>`;
  b.title = `Theme: ${t} (click for ${nextTheme()})`; b.setAttribute('aria-label', `Theme: ${t}, switch to ${nextTheme()}`);
}
document.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-theme-pick]');
  if (pick) { setTheme(pick.dataset.themePick); renderThemeButton(); }
  else if (e.target.closest('#btheme')) { setTheme(nextTheme()); renderThemeButton(); }
});
applyTheme(); renderThemeButton(); // marks the Settings buttons, which didn't exist yet when theme.js ran in <head>

// Model / effort pickers (new agent, tasks, schedules, bots, chat header, Settings). '' = the default: Settings > Agent defaults,
// else the CLI's. A full model id that is not in the list (e.g. set through MCP) is kept as an extra option.
const MODELS = [['opus', 'opus (most capable)'], ['sonnet', 'sonnet (cheaper, routine work)'], ['haiku', 'haiku (cheapest, simple jobs)'], ['fable', 'fable']];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// models: [[value, label]] (default: Claude's aliases; other backends' come from backendModels). other: also offer
// "Other…" to type a model id (for CLIs whose models can't be listed)
function fillModelSelect(sel, value, dflt = 'default', models = MODELS, other = false) {
  sel.innerHTML = '';
  sel.append(new Option(dflt, ''));
  for (const [v, t] of models) sel.append(new Option(t, v));
  if (value && !models.some(([v]) => v === value)) sel.append(new Option(value, value));
  if (other) sel.append(new Option('Other…', OTHER_MODEL));
  sel.value = value || '';
  sel.dataset.was = sel.value;
}
const OTHER_MODEL = '__other__';
// in a model select's change handler: "Other…" asks for the id and selects it; resolves false when cancelled
async function otherModel(sel, hint) {
  if (sel.value !== OTHER_MODEL) { sel.dataset.was = sel.value; return true; }
  const v = (await askText(`Model id${hint ? ` (${hint})` : ''}`, '', 'Use')).trim();
  if (!v) { sel.value = sel.dataset.was || ''; return false; }
  if (![...sel.options].some((o) => o.value === v)) sel.insertBefore(new Option(v, v), sel.querySelector(`option[value="${OTHER_MODEL}"]`));
  sel.value = sel.dataset.was = v;
  return true;
}

// ---- backends: the coding-agent CLIs agents run on (GET /api/backends), with what each can do
const BACKENDS = {}; // id -> { id, label, capabilities, accounts, installed, modelHint }
let backendsP = null;
const loadBackends = () => (backendsP ||= api('/backends').then((l) => { for (const b of l) BACKENDS[b.id] = b; return l; }).catch(() => { backendsP = null; return []; }));
const capsOf = (id) => BACKENDS[id || 'claude']?.capabilities || null;
const backendLabel = (id) => BACKENDS[id]?.label || id;
const modelLists = {};
// [[value, label]] for a backend's model picker: Claude's aliases, else the list its CLI gives (fetched once)
const backendModels = (id) => (!id || id === 'claude' ? Promise.resolve(MODELS)
  : (modelLists[id] ||= api(`/backends/${id}/models`).then((l) => l.map((m) => [m, m])).catch(() => { delete modelLists[id]; return []; })));
function fillEffortSelect(sel, value, dflt = 'default') {
  sel.innerHTML = '';
  sel.append(new Option(dflt, ''));
  for (const v of EFFORTS) sel.append(new Option(v, v));
  sel.value = value || '';
}
