// ---- dialog shell: the × in every .dlgx header closes its dialog (routing restores the URL on 'close')
document.addEventListener('click', (e) => { const x = e.target.closest('.dlg-x'); if (x) x.closest('dialog')?.close(); });
const skel = (n = 4) => '<div class="skrow"><div class="skel"></div><div class="skel"></div></div>'.repeat(n); // placeholder rows while a list loads
const estate = (ic, title, text) => `<div class="estate">${icon(ic)}<b>${esc(title)}</b>${text ? `<p>${esc(text)}</p>` : ''}</div>`;

// ---- conductor prompt editor
$('#psave').onclick = async () => { try { await api('/conductor/prompt', { method: 'PUT', body: { prompt: $('#ptext').value } }); $('#pdlg').close(); flash('Prompt saved', 'ok'); } catch (e) { flash(e.message, 'error'); } };
$('#pdefault').onclick = async () => { await api('/conductor/prompt', { method: 'PUT', body: { prompt: '' } }); $('#ptext').value = (await api('/conductor/prompt')).prompt; };
$('#pclose').onclick = () => $('#pdlg').close();

// ---- files: browse the agent's folder for markdown, view rendered
let fdir = '', fcur = null;
const fapi = (kind, p) => api(`/agents/${sel}/${kind}?path=${encodeURIComponent(p)}`);
const fjoin = (a, b) => (a ? a + '/' : '') + b;
async function fbrowse(p) {
  if (!$('#flist').children.length || $('#flist').hidden) { $('#flist').hidden = false; $('#fview').hidden = true; $('#flist').innerHTML = skel(5); }
  const r = await fapi('files', p);
  fdir = p; fcur = null;
  setHash(`/a/${sel}/files/${enc(p)}`);
  $('#fdlg .fcrumb').textContent = '/' + p;
  $('#fview').hidden = true; $('#fback').hidden = true; $('#flist').hidden = false;
  const l = $('#flist'); l.innerHTML = '';
  const item = (ic, t, f) => { const e = document.createElement('div'); e.innerHTML = ic; e.append(t); e.tabIndex = 0; e.setAttribute('role', 'button'); e.onclick = () => f().catch((x) => flash(x.message, 'error')); e.onkeydown = (k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); e.click(); } }; l.append(e); };
  if (p) item(icon('arrow-up'), '..', () => fbrowse(p.split('/').slice(0, -1).join('/')));
  for (const d of r.dirs) item(icon('folder', 'f'), d, () => fbrowse(fjoin(p, d)));
  for (const f of r.files) item(icon('file-text'), f, () => fopen(fjoin(p, f)));
  if (!r.dirs.length && !r.files.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No folders or markdown files here.'; l.append(e); }
}
async function fopen(p) {
  const r = await fapi('file', p);
  fcur = p;
  setHash(`/a/${sel}/file/${enc(p)}`);
  $('#fdlg .fcrumb').textContent = '/' + p;
  $('#flist').hidden = true; $('#fview').hidden = false; $('#fback').hidden = false;
  $('#fview').innerHTML = renderMd(r.content); highlightBlocks($('#fview'));
  $('#fdlg .dlg-body').scrollTop = 0;
}
$('#fview').onclick = (e) => { // relative links to other markdown files stay in the viewer
  const a = e.target.closest('a'), href = a?.getAttribute('href');
  if (!href || href.startsWith('#') || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return;
  e.preventDefault();
  const p = decodeURIComponent(new URL(href, 'http://x/' + encodeURI(fcur)).pathname.slice(1));
  if (/\.(md|markdown)$/i.test(p)) fopen(p).catch((x) => flash(x.message, 'error'));
};
$('#fback').onclick = () => fbrowse(fcur.split('/').slice(0, -1).join('/')).catch((x) => flash(x.message, 'error'));
$('#fclose').onclick = () => $('#fdlg').close();
$('#fedit').onclick = () => go(`/a/${sel}/edit` + (fcur ? '/' + enc(fcur) : ''));
$('#fdlg').addEventListener('close', () => { $('#flist').innerHTML = ''; });
const openFiles = () => go(`/a/${sel}/files`);
