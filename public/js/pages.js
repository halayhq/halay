// ---- sidebar sections as pages: Approvals, Tasks, History, Usage and Settings open in the main area (sidebar stays) instead
// of as modals. Their dialogs move into #page and their showModal() becomes a non-modal show(), so the openers and the
// router (which opens and closes them by URL) work unchanged. New agent, Files, Git, the viewer and confirms stay modal.
const PAGE_NAV = { '#adlg': '#bappr', '#tdlg': '#btasks', '#hdlg': '#hist', '#udlg': '#busage', '#sdlg': '#bset', '#rmdlg': '#brooms', '#botdlg': '#bbots' };
// ---- phone tab bar: it scrolls sideways (ui-side.css), so fade the edge that has more items and keep the current page in view.
const navPhone = matchMedia('(max-width: 700px)');
function navFade() {
  const t = $('#tools'), max = t.scrollWidth - t.clientWidth;
  t.classList.toggle('fl', navPhone.matches && t.scrollLeft > 2);
  t.classList.toggle('fr', navPhone.matches && t.scrollLeft < max - 2);
}
function navReveal() {
  const t = $('#tools'), b = t.querySelector('[aria-current=page], #bmore.cur');
  if (navPhone.matches && b && t.clientWidth) {
    const l = b.getBoundingClientRect().left - t.getBoundingClientRect().left + t.scrollLeft, pad = 28; // keep it clear of the edge fade
    let x = t.scrollLeft;
    if (l - pad < x) x = l - pad; else if (l + b.offsetWidth + pad > x + t.clientWidth) x = l + b.offsetWidth + pad - t.clientWidth;
    if (x !== t.scrollLeft) t.scrollTo({ left: x, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  navFade();
}
$('#tools').addEventListener('scroll', navFade, { passive: true });
navPhone.addEventListener('change', navReveal);
{ const ro = new ResizeObserver(navReveal); ro.observe($('#tools')); for (const b of $('#tools').children) ro.observe(b); } // also fires when Terminal/Browser are unhidden or the bar is shown again
function syncPage() {
  const open = Object.keys(PAGE_NAV).find((s) => $(s).open);
  $('#page').hidden = !open;
  document.body.classList.toggle('pg', !!open);
  for (const [s, b] of Object.entries(PAGE_NAV)) { if (s === open) $(b).setAttribute('aria-current', 'page'); else $(b).removeAttribute('aria-current'); }
  $('#bmore').classList.toggle('cur', !!$('#tmenu [aria-current=page]')); // History or Usage open: light up More
  navReveal();
}
for (const s of Object.keys(PAGE_NAV)) {
  const d = $(s);
  d.classList.add('page');
  $('#page').append(d);
  d.showModal = () => {
    // dialog.show() closes every open popover: a page that finishes loading late (its opener awaits a fetch) must not
    // dismiss the More menu the user opened meanwhile, so it is put back as it was (no slide-in again, focus kept)
    const m = $('#tmenu'), keep = !!m.matches?.(':popover-open'), f = document.activeElement;
    for (const o of Object.keys(PAGE_NAV)) if (o !== s && $(o).open) $(o).close();
    if (!d.open) d.show();
    if (keep && !m.matches(':popover-open')) { m.classList.add('still'); m.showPopover(); if (m.contains(f)) f.focus({ preventScroll: true }); }
    syncPage(); $('#page').scrollTop = 0;
  };
  d.addEventListener('close', syncPage);
}

// ---- the sidebar's More menu (#bmore → #tmenu): History, Usage, Terminal, Browser and Theme as icon + label rows. The rows keep
// their ids and click handlers (history.js, usage-search.js, terminal.js, browser.js, ui.js); this only opens, places and closes
// it. A native popover: top layer (the phone tab bar's overflow can't clip it), Esc and outside click close it. Wide screens
// get it under the button; phones get the bottom sheet of .menu[popover] (ui-chat.css).
{
  const m = $('#tmenu'), b = $('#bmore');
  const items = () => [...m.querySelectorAll('button')].filter((x) => !x.disabled && !x.hidden);
  if (!m.showPopover) b.onclick = () => m.classList.toggle('open'); // no popover API: plain toggle
  else {
    b.onclick = () => m.togglePopover();
    m.addEventListener('beforetoggle', (e) => {
      b.setAttribute('aria-expanded', e.newState === 'open');
      if (e.newState !== 'open') { m.classList.remove('still'); return; }
      if (navPhone.matches) { m.style.top = m.style.left = ''; return; }
      const r = b.getBoundingClientRect();
      m.style.top = r.bottom + 6 + 'px'; m.style.left = Math.max(8, Math.min(r.right - 240, innerWidth - 248)) + 'px';
    });
    m.addEventListener('toggle', (e) => {
      if (e.newState === 'open') { if (!m.contains(document.activeElement)) items()[0]?.focus(); }
      else if (m.contains(document.activeElement) || document.activeElement === document.body) b.focus({ preventScroll: true });
    });
  }
  // a page row closes it; Theme keeps it open so it can be clicked through system → light → dark
  m.addEventListener('click', (e) => { const x = e.target.closest('button'); if (x && x.id !== 'btheme') m.hidePopover?.(); });
  m.addEventListener('keydown', (e) => {
    const l = items(), i = l.indexOf(document.activeElement);
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? l.length - 1 : null;
    if (to === null) return;
    e.preventDefault(); l[(to + l.length) % l.length]?.focus();
  });
  // Terminal and Browser keep their own running-count badges in their rows; More shows a dot while either has something
  const upd = () => {
    const n = [...m.querySelectorAll('button:not([hidden]) > .badge:not([hidden])')].reduce((a, x) => a + (+x.textContent || 0), 0);
    $('#nmore').hidden = !n;
    b.setAttribute('aria-label', 'More pages' + (n ? `, ${n} running` : ''));
  };
  new MutationObserver(upd).observe(m, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  upd();
}
