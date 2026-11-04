// Settings → Appearance → Colour theme: the preset cards (a radio group), the custom accent and the preview strip.
// Applies on every change through setPalette() (js/theme.js); nothing goes to the server.
(() => {
  const C = swarmColor, P = THEME_PRESETS, DEF = P[0].id, box = $('#cthemes');
  const state = () => { const s = getPalette(); return { preset: s.preset || DEF, base: s.base || (s.preset !== 'custom' && s.preset) || DEF, accent: C.norm(s.accent) }; };
  // one card per preset plus Custom; roving tabindex, arrows move and select (radio group pattern)
  const sw = (v) => `<span class="ctsw" aria-hidden="true"><i style="background:${v.bg}"></i><i style="background:${v.card}"></i><i style="background:${v.acc}"></i>${v.hl ? `<i style="background:${v.hl}"></i>` : ''}</span>`; // hl: Halay light's lime
  function render(dark = isDark()) {
    const s = state(), cards = [...P.map((p) => ({ id: p.id, name: p.name, v: p[dark ? 'dark' : 'light'] })),
      { id: 'custom', name: 'Custom', v: C.resolve(P, { ...s, preset: 'custom', accent: s.accent || P.find((p) => p.id === s.base)?.[dark ? 'dark' : 'light'].acc }, dark).variant }];
    const focused = box.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    box.innerHTML = cards.map((c) => `<button type="button" role="radio" class="ctcard" data-id="${c.id}" aria-checked="${c.id === s.preset}" tabindex="${c.id === s.preset ? 0 : -1}">${sw(c.v)}<span>${c.name}</span></button>`).join('');
    if (focused) box.querySelector(`[data-id="${focused}"]`)?.focus();
    $('#ccustom').hidden = s.preset !== 'custom';
    if (s.preset === 'custom') {
      const r = C.resolve(P, s, dark), o = C.resolve(P, s, !dark);
      $('#cpick').value = s.accent;
      if (document.activeElement !== $('#chex')) { $('#chex').value = s.accent; $('#chex').removeAttribute('aria-invalid'); }
      $('#cbase').value = s.base;
      const adj = [[r, dark], [o, !dark]].filter(([x]) => x.adjusted).map(([x, d]) => `${d ? 'dark' : 'light'} mode uses ${x.variant.acc}`);
      if ($('#chex').getAttribute('aria-invalid') !== 'true') $('#chint').textContent = adj.length ? `Adjusted for contrast: ${adj.join(', ')}.` : 'Readable as is in light and dark mode.';
    }
  }
  const pick = (id) => {
    const s = state();
    if (id === 'custom') setPalette({ preset: 'custom', base: s.base, accent: s.accent || P.find((p) => p.id === s.base)[isDark() ? 'dark' : 'light'].acc });
    else setPalette({ preset: id, base: id, ...(s.accent ? { accent: s.accent } : {}) });
  };
  box.onclick = (e) => { const b = e.target.closest('.ctcard'); if (b) { pick(b.dataset.id); box.querySelector(`[data-id="${b.dataset.id}"]`)?.focus(); } };
  box.onkeydown = (e) => {
    const all = [...box.querySelectorAll('.ctcard')], i = all.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let j = step ? (i + step + all.length) % all.length : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : -1;
    if (j < 0 || i < 0) return;
    e.preventDefault(); pick(all[j].dataset.id); box.querySelector(`[data-id="${all[j].dataset.id}"]`)?.focus();
  };
  $('#cbase').innerHTML = P.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  const setAccent = (hex) => { const s = state(); setPalette({ ...s, preset: 'custom', accent: hex }); };
  $('#cpick').oninput = () => { $('#chex').value = $('#cpick').value; $('#chex').removeAttribute('aria-invalid'); setAccent($('#cpick').value); };
  $('#chex').oninput = () => {
    const h = C.norm($('#chex').value);
    if (h) { $('#chex').removeAttribute('aria-invalid'); setAccent(h); return; }
    $('#chex').setAttribute('aria-invalid', 'true');
    $('#chint').textContent = 'Not a colour: use a hex value like #3366cc.';
  };
  $('#chex').onblur = () => { if ($('#chex').getAttribute('aria-invalid') === 'true') return; $('#chex').value = state().accent || ''; };
  $('#cbase').onchange = () => setPalette({ ...state(), preset: 'custom', base: $('#cbase').value });
  $('#creset').onclick = () => { $('#chex').removeAttribute('aria-invalid'); setPalette(null); };
  document.addEventListener('halay:theme', (e) => render(e.detail.dark));
  render();
})();
