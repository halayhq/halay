// Unit checks for the colour themes (no server): node test/theme-unit.mjs [--report]
//  - js/colors.js: hex parsing, WCAG contrast, the custom-accent fitting (on-acc, lightened/darkened accents), hover
//  - js/themes.js: every preset's light and dark variant passes the WCAG AA checks in swarmColor.audit (--report prints them)
//  - Halay (the default) uses the halay.app tokens and passes the extra pairs its UI uses (lime tint, lime fills)
//  - the default preset matches the fallback palette in css/theme.css
// The browser files are classic scripts, so they run in a vm context here.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, checker } from './lib/spare.mjs';
const { ok, done } = checker();
const ctx = vm.createContext({});
for (const f of ['colors.js', 'themes.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8'), ctx, { filename: f });
const C = vm.runInContext('swarmColor', ctx), P = vm.runInContext('THEME_PRESETS', ctx);
const near = (a, b, d = 0.01) => Math.abs(a - b) <= d;

// ---- parsing and contrast
ok(C.norm('#ABC') === '#aabbcc' && C.norm('abc') === '#aabbcc' && C.norm(' #1E2A52 ') === '#1e2a52', 'norm: short, bare and upper-case hex');
ok([null, undefined, '', '#12345', '#ggg', 'red', '#1234567', 'rgb(1,2,3)', '#12 34 5'].every((x) => C.norm(x) === null), 'norm: rejects anything that is not hex');
ok(near(C.contrast('#000000', '#ffffff'), 21) && near(C.contrast('#ffffff', '#ffffff'), 1), 'contrast: black/white 21, same colour 1');
ok(near(C.contrast('#777777', '#ffffff'), 4.48), 'contrast: #777 on white is 4.48 (WCAG reference value)');
ok(C.mix('#000000', '#ffffff', 0.5) === '#808080' && C.mix('#ff0000', '#0000ff', 0) === '#ff0000', 'mix: sRGB like color-mix');

// ---- text on an accent fill
ok(C.onColor('#1e2a52') === '#ffffff' && C.onColor('#ffd700') === '#0d0f14', 'onColor: white on dark, near-black on light');

// ---- fitting a custom accent
const darkS = ['#0f1012', '#141518', '#1b1d21', '#23252a'], lightS = ['#ffffff', '#f7f7f8', '#f4f4f5', '#f0f0f2'];
const passes = (acc, surf) => surf.every((s) => C.contrast(acc, s) >= 4.5) && C.contrast(acc, C.onColor(acc)) >= 4.5;
let f = C.fitAccent('#1e2a52', lightS, false);
ok(f.acc === '#1e2a52' && !f.adjusted, 'fitAccent: an accent that passes stays as it is');
f = C.fitAccent('#1e2a52', darkS, true);
ok(f.adjusted && C.lum(f.acc) > C.lum('#1e2a52') && passes(f.acc, darkS), `fitAccent: navy on dark surfaces is lightened until it passes (${f.acc})`);
f = C.fitAccent('#ffd700', lightS, false);
ok(f.adjusted && C.lum(f.acc) < C.lum('#ffd700') && passes(f.acc, lightS), `fitAccent: gold on light surfaces is darkened until it passes (${f.acc})`);
f = C.fitAccent('#808080', darkS, true);
ok(passes(f.acc, darkS), `fitAccent: mid grey on dark ends with a readable on-colour too (${f.acc} / ${C.onColor(f.acc)})`);
ok(C.fitAccent('nope', lightS, false) === null, 'fitAccent: invalid input -> null');
for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#7f7f7f', '#000000', '#ffffff', '#3366cc'])
  for (const [surf, dark] of [[lightS, false], [darkS, true]]) {
    const x = C.fitAccent(hex, surf, dark);
    if (!passes(x.acc, surf)) ok(false, `fitAccent: ${hex} on ${dark ? 'dark' : 'light'} -> ${x.acc} still fails`);
  }
ok(true, 'fitAccent: 10 primaries/greys pass on light and dark after fitting');

// ---- hover
for (const acc of ['#1e2a52', '#aebbea', '#7e35de', '#4b9fda']) {
  const on = C.onColor(acc), h = C.hover(acc, on);
  ok(h !== acc && C.contrast(h, on) >= 4.5, `hover: ${acc} -> ${h}, text on it ${C.contrast(h, on).toFixed(2)}:1`);
}

// ---- resolve: presets and custom
ok(C.resolve(P, null, false).id === P[0].id && C.resolve(P, { preset: 'bogus' }, true).id === P[0].id, 'resolve: nothing saved or an unknown preset -> the default');
const r = C.resolve(P, { preset: 'custom', base: 'nord', accent: '#ff8800' }, true);
ok(r.id === 'custom' && r.base === 'nord' && r.variant.bg === P.find((p) => p.id === 'nord').dark.bg && r.requested === '#ff8800', 'resolve: custom keeps the base preset surfaces');
ok(C.resolve(P, { preset: 'custom', base: 'nord', accent: 'zzz' }, false).id === 'nord', 'resolve: custom with an invalid accent falls back to its base');
const v = C.vars(r.variant, true);
ok(v['--acc-rgb'] === C.rgb(v['--acc']).join(',') && v['--acc-s'].startsWith(`rgba(${v['--acc-rgb']},`) && v['--on-acc'] && v['--acc-h'], 'vars: derived --acc-rgb, --acc-s, --on-acc, --acc-h');

// ---- every preset passes AA
const report = process.argv.includes('--report');
ok(P.length === 4 && P[0].id === 'halay' && P.map((p) => p.id).join() === 'halay,nord,solarized,gruvbox', 'presets: Halay first (the default), then Nord, Solarized and Gruvbox (Ink navy, Dracula, Catppuccin removed)');
for (const id of ['ink', 'dracula', 'catppuccin']) ok(C.resolve(P, { preset: id, base: id }, true).id === 'halay', `resolve: a saved ${id} (removed) falls back to Halay`);
ok(C.resolve(P, { preset: 'ink', base: 'ink' }, false).id === 'halay', 'resolve: a saved Ink navy (removed) falls back to Halay');
for (const p of P) for (const m of ['light', 'dark']) {
  const a = C.audit(p[m], m === 'dark'), bad = a.filter(([, x, need]) => x < need);
  ok(!bad.length, `${p.name} ${m}: ${a.length} contrast checks pass` + (bad.length ? '; failing: ' + bad.map(([l, x, n]) => `${l} ${x.toFixed(2)} < ${n}`).join(', ') : ''));
  if (report) console.log('    ' + a.map(([l, x]) => `${l} ${x.toFixed(2)}`).join(', '));
  ok(['bg', 'side', 'card', 'ubg', 'line', 'fg', 'mut', 'acc', 'onAcc', 'ok', 'err', 'warn', 'onSt'].every((k) => C.norm(p[m][k])), `${p.name} ${m}: every token is a hex colour`);
}

// ---- Halay: the halay.app palette, and the extra pairs its UI uses
const H = P[0], tintL = C.tintOn(H.light, 'bg', false), tintD = C.tintOn(H.dark, 'bg', true);
ok(H.light.acc === '#0e0e11' && H.light.onAcc === '#c9f53f' && H.light.hl === '#c9f53f' && H.dark.acc === '#d2ff4d' && H.dark.onAcc === '#0e0e11', 'Halay: ink accent + lime in light, lime accent + ink text in dark (the site tokens)');
ok(H.light.bg === '#ffffff' && H.light.fg === '#0e0e11' && H.light.mut === '#55555d' && H.light.line === '#dcdce1' && H.dark.bg === '#0b0b0e' && H.dark.side === '#131317' && H.dark.fg === '#f4f4f5' && H.dark.mut === '#a1a1ab' && H.dark.line === '#27272d', 'Halay: surfaces, text and lines from the site');
ok(C.contrast('#c9f53f', '#ffffff') < 3, `Halay: lime on white is ${C.contrast('#c9f53f', '#ffffff').toFixed(2)}:1, which is why light mode uses ink as the accent`);
ok(C.vars(H.light, false)['--acc-s'] === 'rgba(201,245,63,0.7)' && C.vars(H.dark, true)['--acc-s'] === 'rgba(210,255,77,0.22)', 'Halay: the soft tint is lime in both modes');
const pairs = [
  ['light: ink (acc) text on the lime tint (active tab, bot badge)', C.contrast(H.light.acc, tintL), 4.5],
  ['light: muted text on the lime tint', C.contrast(H.light.mut, tintL), 4.5],
  ['light: ink on a solid lime fill', C.contrast('#0e0e11', H.light.hl), 4.5],
  ['light: focus border (ink) next to its lime halo', C.contrast(H.light.acc, tintL), 3],
  ['dark: lime (acc) text on the lime tint', C.contrast(H.dark.acc, tintD), 4.5],
  ['dark: lime focus border on the darkest and lightest surfaces', Math.min(...['bg', 'ubg'].map((s) => C.contrast(H.dark.acc, H.dark[s]))), 3],
  ['badge.mut: page colour on the muted fill (light / dark)', Math.min(C.contrast(H.light.bg, H.light.mut), C.contrast(H.dark.bg, H.dark.mut)), 4.5],
];
pairs.push(['light: ink on the lime call-to-action banner', C.contrast(C.vars(H.light, false)['--on-cta'], C.vars(H.light, false)['--cta']), 4.5],
  ['dark: ink on the lime call-to-action banner', C.contrast(C.vars(H.dark, true)['--on-cta'], C.vars(H.dark, true)['--cta']), 4.5]);
ok(P.slice(1).every((p) => ['light', 'dark'].every((m) => C.vars(p[m], m === 'dark')['--cta'] === p[m].acc && C.vars(p[m], m === 'dark')['--on-cta'] === p[m].onAcc)), 'the palettes: a solid accent banner with the button text colour');
ok(C.vars({ ...P[1].light, cta: null }, false)['--cta'] === 'initial', 'a variant without cta resets --cta (the banner falls back to the tint, not Halay lime)');
// ---- each palette is its own: code colours from its syntax scheme, all seven distinct; status colours not the shared Tailwind ones
const TW = ['#15803d', '#dc2626', '#b45309'];
for (const p of P.slice(1)) for (const m of ['light', 'dark']) {
  const syn = p[m].syn || {}, vals = C.SYN.map((k) => C.norm(syn[k])), vv = C.vars(p[m], m === 'dark');
  ok(vals.every(Boolean) && new Set(vals.filter((x, i) => C.SYN[i] !== 'tag' && C.SYN[i] !== 'kw')).size === 5 && C.SYN.every((k) => vv['--syn-' + k] === C.norm(syn[k])), `${p.name} ${m}: its own code colours (${vals.join(' ')})`);
  ok(!['ok', 'err', 'warn'].some((k) => TW.includes(p[m][k])), `${p.name} ${m}: its own status colours`);
}
ok(C.SYN.every((k) => C.vars(H.light, false)['--syn-' + k] === 'initial'), 'Halay keeps the GitHub code colours (no syn: --syn-* reset)');
for (const [l, x, need] of pairs) { ok(x >= need, `Halay ${l}: ${x.toFixed(2)}:1 (needs ${need})`); }
if (report) for (const p of P) for (const m of ['light', 'dark']) {
  const at = C.vars(p[m], m === 'dark')['--acc-t'], t = ['bg', 'side', 'card'].map((s) => C.contrast(at, C.tintOn(p[m], s, m === 'dark')).toFixed(2));
  console.log(`    ${p.name} ${m}: acc-t ${at} on acc-s over bg/side/card ${t.join(' / ')}`);
}

// ---- toasts (css/theme.css .toast): bg surface; the kind icon on its 13% tint chip (non-text, 3:1), title fg and body mut
// on bg; the error toast's border (err 40% into line) is decoration only
for (const p of P) for (const m of ['light', 'dark']) {
  const v = p[m], vv = C.vars(v, m === 'dark'), bad = [];
  for (const k of ['acc', 'ok', 'err', 'warn']) {
    const c = k === 'acc' ? vv['--acc'] : v[k]; if (!c) continue;
    const x = C.contrast(c, C.mix(v.bg, c, 0.13)); if (x < 3) bad.push(`${k} icon on its tint ${x.toFixed(2)}`);
  }
  if (C.contrast(v.fg, v.bg) < 4.5) bad.push('title'); if (C.contrast(v.mut, v.bg) < 4.5) bad.push('body');
  ok(!bad.length, `${p.name} ${m}: toast icons, title and body pass` + (bad.length ? ': ' + bad.join(', ') : ''));
}

// ---- the default matches the fallback in theme.css (used before scripts run and when they don't)
const css = fs.readFileSync(path.join(ROOT, 'public/css/theme.css'), 'utf8');
const block = (re) => Object.fromEntries([...(re.exec(css)?.[1] || '').matchAll(/--([a-z-]+):\s*(#[0-9a-f]{3,6})\b/gi)].map((m) => [m[1], C.norm(m[2])]));
const light = block(/:root \{([^}]*)\}/), dark = block(/:root\[data-theme=dark\] \{([^}]*)\}/);
const key = { bg: 'bg', side: 'side', card: 'card', ubg: 'ubg', line: 'line', fg: 'fg', mut: 'mut', acc: 'acc', 'on-acc': 'onAcc', ok: 'ok', err: 'err', warn: 'warn', 'on-st': 'onSt' };
const diff = (css, v, inherit = {}) => Object.entries(key).filter(([c, t]) => (css[c] || inherit[c]) !== C.norm(v[t])).map(([c]) => c);
const dl = diff(light, P[0].light), dd = diff(dark, P[0].dark, light);
ok(!dl.length && !dd.length, 'theme.css fallback = the Halay preset' + (dl.length || dd.length ? ` (differs: light ${dl}, dark ${dd})` : ''));
done();
