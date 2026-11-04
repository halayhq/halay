// Light / dark / system mode and the colour theme. Loaded in <head> (after js/colors.js and js/themes.js) so the saved choice
// applies before the first paint, on the app and on the login page.
// Mode ('halay-theme' in localStorage): 'system' (no data-theme) follows prefers-color-scheme; 'light' / 'dark' set data-theme
// on <html>, which theme.css keys on (color-scheme, shadows, and the default palette when scripts are off).
// Colour theme ('halay-palette'): { preset, base, accent } (docs/theming.md). The tokens of the preset's variant for the current
// mode go on <html> as inline custom properties, so they win over theme.css; they are re-applied whenever the mode changes.
const THEMES = ['system', 'light', 'dark'];
const PALETTE_KEY = 'halay-palette';
function getPalette() { try { return JSON.parse(localStorage.getItem(PALETTE_KEY)) || {}; } catch { return {}; } }
const isDark = (t = localStorage.getItem('halay-theme') || 'system') => t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme(t = localStorage.getItem('halay-theme') || 'system') {
  const root = document.documentElement, dark = isDark(t);
  if (t === 'system') delete root.dataset.theme; else root.dataset.theme = t;
  let bar = dark ? '#0b0b0e' : '#ffffff', res = null;
  if (typeof swarmColor !== 'undefined' && typeof THEME_PRESETS !== 'undefined') {
    res = swarmColor.resolve(THEME_PRESETS, getPalette(), dark);
    for (const [k, v] of Object.entries(swarmColor.vars(res.variant, dark))) root.style.setProperty(k, v);
    bar = res.variant.bg;
    if (res.variant.syn) root.dataset.syn = ''; else delete root.dataset.syn; // css/viewer.css: the theme's own code colours
  }
  // browser title bar colour = the page background
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bar);
  // code highlighting ships one sheet per scheme, chosen by media query: force the matching one
  for (const l of document.querySelectorAll('link[data-hl]')) l.media = l.dataset.hl === (dark ? 'dark' : 'light') ? 'all' : 'not all';
  document.querySelectorAll('[data-theme-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themePick === t)));
  document.dispatchEvent(new CustomEvent('halay:theme', { detail: { dark, ...res } })); // editor, terminal, Settings → Appearance
}
function setTheme(t) { localStorage.setItem('halay-theme', t); applyTheme(t); }
// null = forget the choice (Reset to default). An explicit pick is kept even when it is the current default, so a later change
// of the default moves only the people who never picked (a missing key).
function setPalette(p) {
  if (!p) localStorage.removeItem(PALETTE_KEY); else localStorage.setItem(PALETTE_KEY, JSON.stringify(p));
  applyTheme();
}
const nextTheme = () => THEMES[(THEMES.indexOf(localStorage.getItem('halay-theme') || 'system') + 1) % THEMES.length];
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
// another tab changed the theme
addEventListener('storage', (e) => { if (e.key === PALETTE_KEY || e.key === 'halay-theme') applyTheme(); });
applyTheme();
