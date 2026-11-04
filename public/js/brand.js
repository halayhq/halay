// Branding: the product name comes from the server (/manifest.webmanifest, built from package.json via product.js) and fills
// <meta name="application-name">, the title, every .brand-name, including inside <template>s. The docs/source links
// (<link id="docslink">, <link id="srclink"> in index.html) fill every [data-brand-link]; .brand-version gets /api/server's version.
// Also marks Apple keyboards (html.mac) so shortcut hints show ⌘ there and Ctrl elsewhere (css/polish.css).
(() => {
  const meta = document.querySelector('meta[name="application-name"]');
  const each = (sel, fn) => [document, ...[...document.querySelectorAll('template')].map((t) => t.content)].forEach((r) => r.querySelectorAll(sel).forEach(fn));
  each('[data-brand-link]', (e) => { const l = document.getElementById(e.dataset.brandLink); if (l) e.href = l.href; });
  fetch('/manifest.webmanifest').then((r) => r.json()).then((m) => {
    if (!m.name) return;
    if (meta) meta.content = m.name;
    if (!document.title || document.title === 'halay') document.title = m.name;
    each('.brand-name', (e) => { e.textContent = m.name; });
  }).catch(() => {});
  if (document.querySelector('.brand-version')) fetch('/api/server').then((r) => r.ok ? r.json() : {}).then((s) => {
    if (s.version) each('.brand-version', (e) => { e.textContent = 'Version ' + s.version; });
  }).catch(() => {});
  if (/mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '')) document.documentElement.classList.add('mac');
})();
