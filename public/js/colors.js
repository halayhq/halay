// Colour maths for the colour themes (js/themes.js holds the data, js/theme.js applies it). Pure functions, no DOM: loaded in
// <head> before theme.js, and by test/theme-unit.mjs in a node vm. One global, swarmColor.
const swarmColor = (() => {
  const NEAR_BLACK = '#0d0f14', WHITE = '#ffffff', AA = 4.5;
  // '#abc', 'abc', '#aabbcc', 'AABBCC' -> '#aabbcc'; anything else -> null
  const norm = (s) => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s ?? '').trim());
    if (!m) return null;
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return '#' + h.toLowerCase();
  };
  const rgb = (hex) => { const h = norm(hex); return h ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) : null; };
  const hex = (c) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
  // WCAG 2 relative luminance and contrast ratio
  const lum = (h) => {
    const [r, g, b] = rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // a mixed with t (0..1) of b, in sRGB like CSS color-mix(in srgb, a, b t%)
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  // text/icon colour on an accent fill: white or near-black, whichever contrasts more
  const onColor = (acc) => (contrast(acc, WHITE) >= contrast(acc, NEAR_BLACK) ? WHITE : NEAR_BLACK);
  const minOn = (acc, surfaces) => Math.min(...surfaces.map((s) => contrast(acc, s)));

  // Make an accent usable on these surfaces: text/links on every surface >= 4.5:1, and white or near-black text on it >= 4.5:1.
  // Dark surfaces lighten it (mix with white), light ones darken it (mix with black), in 2% steps; adjusted says whether it moved.
  function fitAccent(color, surfaces, dark) {
    const start = norm(color);
    if (!start) return null;
    let acc = start;
    for (let t = 0.02; t <= 1.0001 && !(minOn(acc, surfaces) >= AA && contrast(acc, onColor(acc)) >= AA); t += 0.02) acc = mix(start, dark ? WHITE : '#000000', t);
    return { acc, adjusted: acc !== start };
  }
  // hover fill for primary buttons: a visible step that keeps (or raises) the contrast with the text on it. Darken under white
  // text, lighten under dark text; a near-black accent can't get visibly darker, so it lightens (as long as white stays >= 4.5)
  function hover(acc, on = onColor(acc)) {
    if (on === WHITE || lum(on) > 0.5) {
      const light = mix(acc, WHITE, 0.14);
      if (lum(acc) < 0.03 && contrast(light, on) >= AA) return light;
      return mix(acc, '#000000', 0.12);
    }
    return mix(acc, WHITE, 0.14);
  }
  const SURF = ['bg', 'side', 'card', 'ubg'];
  // the soft tint (--acc-s): the accent at 16% (light) / 22% (dark), or the variant's own highlight hue (hl) at 70%; a variant
  // can set its own strength (tint, 0..1) where the default would push its muted text below 4.5:1
  const HL_ALPHA = 0.7, tintAlpha = (v, dark) => (norm(v.hl) ? HL_ALPHA : v.tint ?? (dark ? 0.22 : 0.16));
  const tint = (v, dark) => `rgba(${rgb(norm(v.hl) || v.acc).join(',')},${tintAlpha(v, dark)})`;
  // the tint as an opaque colour over surface s (what the eye sees), for the contrast checks
  const tintOn = (v, s, dark) => mix(v[s], norm(v.hl) || v.acc, tintAlpha(v, dark));
  // accent-coloured text on the tint (active tab, chips, badges): the accent, moved toward white (dark) / black (light) until it
  // reads at 4.5:1 on the tint over every surface, so a stronger tint never costs legibility
  // muted text inside tinted rows (selected options, switcher items) does the same, toward the text colour (--mut-t: the tinted
  // rules in CSS set --mut to it, so everything muted inside follows)
  function onTint(c, v, dark, to = dark ? WHITE : '#000000') {
    const on = ['bg', 'side', 'card'].map((s) => tintOn(v, s, dark));
    for (let t = 0; t <= 1.0001; t += 0.02) { const x = mix(c, to, t); if (minOn(x, on) >= AA) return x; }
    return null;
  }
  const accOnTint = (v, dark) => onTint(norm(v.acc), v, dark) || (dark ? WHITE : '#000000');
  // toward the text colour first; where even that is too faint on the tint (Solarized dark), toward white / black
  const mutOnTint = (v, dark) => onTint(norm(v.mut), v, dark, norm(v.fg)) || onTint(norm(v.mut), v, dark) || (dark ? WHITE : '#000000');
  // code highlighting tokens (keyword, function, string, number, type, comment, tag); a variant without syn keeps highlight.js's
  // GitHub colours (js/theme.js sets data-syn on <html> only when the variant has them)
  const SYN = ['kw', 'fn', 'str', 'num', 'type', 'com', 'tag'];
  // one theme variant ({ bg, side, card, ubg, line, fg, mut, acc, onAcc?, ok?, err?, warn? }) -> CSS custom properties
  function vars(v, dark) {
    const acc = norm(v.acc), on = norm(v.onAcc) || onColor(acc), [r, g, b] = rgb(acc);
    const out = { '--bg': v.bg, '--side': v.side, '--card': v.card, '--ubg': v.ubg, '--line': v.line, '--fg': v.fg, '--mut': v.mut,
      '--acc': acc, '--acc-rgb': `${r},${g},${b}`, '--acc-s': tint(v, dark), '--acc-t': accOnTint(v, dark), '--mut-t': mutOnTint(v, dark), '--on-acc': on, '--acc-h': norm(v.accH) || hover(acc, on) };
    // no cta: 'initial' (guaranteed-invalid) so var(--cta, …) falls back, also over the Halay value in theme.css
    const cta = norm(v.cta);
    Object.assign(out, cta ? { '--cta': cta, '--on-cta': cta === acc ? on : onColor(cta) } : { '--cta': 'initial', '--on-cta': 'initial' });
    for (const k of SYN) out['--syn-' + k] = norm(v.syn?.[k]) || 'initial';
    for (const k of ['ok', 'err', 'warn']) if (v[k]) out['--' + k] = v[k];
    if (v.onSt) out['--on-st'] = v.onSt;
    return out;
  }
  // the saved choice ({ preset, base, accent }) -> { id, variant (tokens), adjusted, requested } for one mode. preset 'custom' =
  // the surfaces of `base` with `accent` fitted to them; an unknown preset falls back to the first (the default).
  function resolve(presets, state, dark) {
    const s = state || {}, find = (id) => presets.find((p) => p.id === id);
    const custom = s.preset === 'custom' && norm(s.accent);
    const p = find(custom || s.preset === 'custom' ? s.base : s.preset) || presets[0], mode = dark ? 'dark' : 'light', v = { ...p[mode] };
    if (!custom) return { id: p.id, variant: v, adjusted: false };
    const f = fitAccent(s.accent, SURF.map((k) => v[k]), dark);
    Object.assign(v, { acc: f.acc, onAcc: onColor(f.acc), accH: null, hl: null, cta: v.cta && f.acc });
    return { id: 'custom', base: p.id, variant: v, adjusted: f.adjusted, requested: norm(s.accent) };
  }
  // every WCAG check the themes promise, as [label, ratio, needed]
  // (dark only changes the tint's strength). Text on the tint (selected rows, chips, the active tab: fg or acc) needs 4.5:1 too.
  function audit(v, dark = false) {
    const vv = vars(v, dark), on = vv['--on-acc'], out = [];
    for (const s of SURF) out.push([`fg on ${s}`, contrast(v.fg, v[s]), AA]);
    for (const s of ['bg', 'side', 'card']) out.push([`mut on ${s}`, contrast(v.mut, v[s]), AA]);
    for (const s of SURF) out.push([`acc on ${s}`, contrast(vv['--acc'], v[s]), AA]);
    out.push(['on-acc on acc', contrast(on, vv['--acc']), AA], ['on-acc on acc-h', contrast(on, vv['--acc-h']), AA]);
    for (const s of ['bg', 'side']) out.push([`fg on acc-s/${s}`, contrast(v.fg, tintOn(v, s, dark)), AA]);
    for (const s of ['bg', 'side', 'card']) out.push([`mut-t on acc-s/${s}`, contrast(vv['--mut-t'], tintOn(v, s, dark)), AA], [`acc-t on acc-s/${s}`, contrast(vv['--acc-t'], tintOn(v, s, dark)), AA]);
    if (norm(v.cta)) out.push(['on-cta on cta', contrast(vv['--on-cta'], vv['--cta']), AA]);
    for (const k of SYN) if (norm(v.syn?.[k])) for (const s of ['bg', 'card']) out.push([`syn ${k} on ${s}`, contrast(v.syn[k], v[s]), AA]);
    const onSt = v.onSt || WHITE;
    for (const k of ['ok', 'err', 'warn']) if (v[k]) {
      out.push([`onSt on ${k}`, contrast(onSt, v[k]), AA]);
      for (const s of ['bg', 'side', 'card']) out.push([`${k} on ${s}`, contrast(v[k], v[s]), 3]);
    }
    return out;
  }
  return { SYN, accOnTint, mutOnTint, norm, rgb, hex, lum, contrast, mix, onColor, fitAccent, hover, vars, resolve, audit, tintOn, AA };
})();
