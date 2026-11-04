// Colour themes: the one list of presets (docs/theming.md). Each has a light and a dark variant; js/theme.js picks the one for
// the current mode and sets the tokens on <html> (js/colors.js derives --acc-rgb, --acc-s, --acc-h and, when missing, --on-acc).
// Tokens: bg (page), side (sidebar), card (raised/hover surfaces), ubg (user chat bubble), line (borders), fg (text), mut
// (secondary text), acc (accent), onAcc (text on an accent fill), ok/err/warn (status fills) and onSt (text on a status fill).
// Optional: hl, a highlight hue for the soft tint (--acc-s: selection, selected rows, chips, focus halo) when it differs from
// the accent. Halay light uses it: the accent is ink (lime text on white is only 1.3:1), the lime goes into the tint.
// Optional: cta, a solid fill for call-to-action banners (Enable notifications), with --on-cta text picked for contrast (onAcc
// when it is the accent). Halay uses lime in both modes, like the site's lime buttons, the others their accent; without it the
// banner is the soft tint.
// Optional: syn, code highlighting colours from the palette's own syntax scheme ({ kw, fn, str, num, type, com, tag }); without
// it code keeps highlight.js's GitHub colours. Optional: tint, the soft tint's strength when the default (16% / 22%) is too much.
// Every variant passes WCAG AA (test/theme-unit.mjs checks it). Where a canonical palette value had to move for that, the comment
// next to it gives the original.
// Light surfaces: a near-white page with the palette's hue only as a whisper; its canonical background (Snow Storm, base3,
// light0) moves to the sidebar, cards and bubbles. Whole pages in those mid-tone tints were tiring to read on.
// Removed presets fall back to the default when saved: Ink navy (the default before Halay; it was Halay without the lime), and
// Dracula and Catppuccin (their filled violet buttons read as a generic generated UI; Custom still gives any accent).
// The first preset (Halay) is the default and must match the fallback in css/theme.css (the unit test checks that too).
const THEME_PRESETS = [
  { id: 'halay', name: 'Halay',
    // the halay.app palette: ink #0e0e11 and lime. Light: ink is the accent (buttons, links, focus), lime is the highlight and the
    // text on ink buttons. Dark: lime #d2ff4d is the accent with ink text on lime fills, as on the site.
    light: { bg: '#ffffff', side: '#fafafa', card: '#f4f4f5', ubg: '#efeff1', line: '#dcdce1', fg: '#0e0e11', mut: '#55555d', acc: '#0e0e11', onAcc: '#c9f53f', hl: '#c9f53f', cta: '#c9f53f', ok: '#15803d', err: '#dc2626', warn: '#b45309', onSt: '#ffffff' },
    dark: { bg: '#0b0b0e', side: '#131317', card: '#1b1b20', ubg: '#222228', line: '#27272d', fg: '#f4f4f5', mut: '#a1a1ab', acc: '#d2ff4d', onAcc: '#0e0e11', cta: '#d2ff4d', ok: '#15803d', err: '#dc2626', warn: '#b45309', onSt: '#ffffff' } },
  { id: 'nord', name: 'Nord',
    light: { bg: '#fafbfc', side: '#f0f2f6', card: '#eceff4', ubg: '#e5e9f0', line: '#d8dee9', fg: '#2e3440', mut: '#4c566a', acc: '#486384' /* frost #5e81ac darkened, was 3:1 */, onAcc: '#ffffff', cta: '#486384',
      ok: '#6a7b5b', err: '#b45b64', warn: '#a06856' /* aurora #a3be8c, #bf616a, #d08770 darkened for white text */, onSt: '#ffffff',
      syn: { kw: '#4e6b8f', fn: '#347182', str: '#567140', num: '#845c7f', type: '#367272', com: '#60697b', tag: '#4e6b8f' } /* frost and aurora, darkened to 4.5:1 */ },
    dark: { bg: '#2e3440', side: '#3b4252', card: '#3b4252', ubg: '#3b4252', line: '#434c5e', fg: '#eceff4', mut: '#d8dee9', acc: '#88c0d0', onAcc: '#2e3440', cta: '#88c0d0', ok: '#a3be8c', err: '#cf898f' /* aurora red #bf616a lightened */, warn: '#ebcb8b', onSt: '#2e3440',
      syn: { kw: '#96b1cc' /* nord9 #81a1c1 */, fn: '#88c0d0', str: '#a3be8c', num: '#c3a5bd' /* nord15 #b48ead */, type: '#8fbcbb', com: '#a7aebc' /* nord3 #616e88 is 2:1 */, tag: '#96b1cc' } } },
  { id: 'solarized', name: 'Solarized',
    light: { bg: '#fffdf7', side: '#fbf5e4', card: '#f7f1df', ubg: '#eee8d5', line: '#e8e1cc', fg: '#073642' /* base02 */, mut: '#566c73' /* base01 #586e75, a touch darker */, acc: '#1e6ca4' /* blue #268bd2 darkened, was 3:1 */, onAcc: '#ffffff', cta: '#1e6ca4',
      ok: '#6d7d00' /* green #859900 darkened */, err: '#dc322f', warn: '#cb4b16', onSt: '#ffffff',
      syn: { kw: '#606e00', fn: '#1e6ca4', str: '#1e746d', num: '#ba3072', type: '#846400', com: '#616a6a', tag: '#b54314' } /* the accents, darkened to 4.5:1 */ },
    dark: { bg: '#002b36', side: '#00252f', card: '#073642', ubg: '#073642', line: '#0e4452', tint: 0.16 /* stronger puts base1 text under 4.5 */, fg: '#97a5a5' /* base1 #93a1a1 lightened, was 4.3 on the selected-row tint */, mut: '#8c9b9d' /* base0 #839496 lightened, was 4.1 on base02 */, acc: '#4b9fda' /* blue #268bd2 lightened */, onAcc: '#002b36', cta: '#4b9fda',
      ok: '#859900', err: '#e56563' /* red #dc322f lightened */, warn: '#b58900', onSt: '#002b36',
      syn: { kw: '#8fa114', fn: '#4b9fda', str: '#39a89f', num: '#e174a9', type: '#bc9417', com: '#8c9ba0', tag: '#db815c' } /* the accents, lightened to 4.5:1 on base02 */ } },
  { id: 'gruvbox', name: 'Gruvbox',
    light: { bg: '#fffcf2', side: '#f9f3dc', card: '#f5edd2', ubg: '#f2e5bc', line: '#e3d6b0', fg: '#3c3836', mut: '#665c54', acc: '#a83802' /* orange #af3a03, Gruvbox's signature, a touch darker (was blue #076678) */, onAcc: '#ffffff', cta: '#a83802', ok: '#79740e', err: '#9d0006', warn: '#86570f' /* yellow #b57614 darkened; orange is the accent now */, onSt: '#ffffff',
      syn: { kw: '#9d0006', fn: '#396b4d', str: '#67630c', num: '#8f3f71', type: '#86570f', com: '#695e54', tag: '#076678' } /* gruvbox-light, darkened to 4.5:1 */ },
    dark: { bg: '#282828', side: '#1d2021', card: '#32302f', ubg: '#32302f', line: '#3c3836', fg: '#ebdbb2', mut: '#a89984', acc: '#fe8019' /* orange (was blue #83a598) */, onAcc: '#1d2021', cta: '#fe8019', ok: '#b8bb26', err: '#fb4934', warn: '#fabd2f', onSt: '#1d2021',
      syn: { kw: '#fc6857' /* red #fb4934 */, fn: '#8ec07c', str: '#b8bb26', num: '#d3869b', type: '#fabd2f', com: '#a29689' /* gray #928374 */, tag: '#83a598' } } },
];
