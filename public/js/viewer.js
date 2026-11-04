// ---- file viewer: images, text, PDFs and other files inside the agent's folder or tmp dir (signed URLs, see /raw on the server)
const IMG_EXT = ['png', 'jpeg', 'jpg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico'];
const OTHER_EXT = 'pdf txt md markdown json jsonl js mjs cjs jsx ts tsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh sql css scss html htm xml yaml yml toml ini cfg conf log csv tsv diff patch svelte vue lua r scala dart tf proto graphql'.split(' ');
const EXT_RE = [...IMG_EXT, ...OTHER_EXT].sort((a, b) => b.length - a.length).join('|');
const PATH_BODY = '(?:/|\\./)?[\\w@+\\-.]+(?:/[\\w@+\\-.]+)*\\.(?:' + EXT_RE + ')';
const PATH_SCAN = new RegExp('(?<![\\w:/.@+-])(' + PATH_BODY + ')(?![\\w/@+-])', 'gi');
const PATH_CODE = new RegExp('^(' + PATH_BODY + ')(?::\\d+(?::\\d+)?)?$', 'i');
const isImgPath = (p) => IMG_EXT.includes((p.split('.').pop() || '').toLowerCase());
const baseName = (p) => p.split('/').filter(Boolean).pop() || p;
const fmtSize = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const goodPath = (p) => p && !p.split('/').includes('..') && !/^https?:/.test(p);

function toolPaths(input) { // file paths a tool call mentions: the usual keys, plus path-looking words in command strings
  const out = new Set();
  const add1 = (p) => { if (typeof p === 'string' && goodPath(p) && out.size < 6) out.add(p); };
  if (input && typeof input === 'object') {
    for (const k of ['file_path', 'notebook_path']) add1(input[k]);
    if (typeof input.path === 'string' && /\.\w{1,8}$/.test(input.path)) add1(input.path);
    for (const k of ['command', 'content', 'new_string', 'prompt', 'description']) if (typeof input[k] === 'string') for (const m of input[k].slice(0, 4000).matchAll(PATH_SCAN)) add1(m[1]);
  }
  return [...out];
}

const fileCache = new Map();
function fileInfo(p) { // { url, kind, name, size, ... } or rejects with e.outside / e.status
  const c = fileCache.get(p);
  if (c && Date.now() - c.t < 5 * 60e3) return c.pr;
  const pr = api('/agents/' + sel + '/fileurl', { method: 'POST', body: { path: p } });
  fileCache.set(p, { t: Date.now(), pr });
  pr.catch(() => fileCache.delete(p));
  return pr;
}

const V = { scale: 1, x: 0, y: 0 };
function vApply() { const i = $('#vstage img'); if (i) i.style.transform = `translate(${V.x}px,${V.y}px) scale(${V.scale})`; }
function vZoom(ns, fx, fy) { // zoom to ns keeping the stage point (fx, fy), measured from the stage centre, fixed
  ns = Math.min(8, Math.max(1, ns));
  V.x = fx - (fx - V.x) * ns / V.scale; V.y = fy - (fy - V.y) * ns / V.scale; V.scale = ns;
  const st = $('#vstage'), mx = st.clientWidth * (ns - 1) / 2, my = st.clientHeight * (ns - 1) / 2;
  V.x = ns === 1 ? 0 : Math.max(-mx, Math.min(mx, V.x)); V.y = ns === 1 ? 0 : Math.max(-my, Math.min(my, V.y));
  vApply();
}
function vStage(src, alt) {
  const body = $('#vbody'); body.innerHTML = '';
  const st = mk('div'); st.id = 'vstage';
  const img = mk('img'); img.src = src; img.alt = alt || ''; img.draggable = false;
  img.onerror = () => { st.replaceChildren(Object.assign(mk('div', 'vcenter', 'Could not load the image.'))); };
  const zb = mk('div'); zb.id = 'vzoom';
  const zbtn = (t, f, label) => { const b = mk('button', '', t); b.setAttribute('aria-label', label); b.onpointerdown = (e) => e.stopPropagation(); b.onclick = f; zb.append(b); };
  zbtn('−', () => vZoom(V.scale / 1.5, 0, 0), 'Zoom out'); zbtn('Fit', () => vZoom(1, 0, 0), 'Fit to screen'); zbtn('+', () => vZoom(V.scale * 1.5, 0, 0), 'Zoom in');
  st.append(img, zb); body.append(st);
  V.scale = 1; V.x = 0; V.y = 0; vApply();
  const ptrs = new Map(); let last = null, tap = 0;
  const rel = (e) => { const r = st.getBoundingClientRect(); return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2]; };
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  st.onpointerdown = (e) => {
    st.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = ptrs.size === 2 ? { d: dist() } : null;
    if (ptrs.size === 1) { const t = Date.now(); if (t - tap < 300) { const [fx, fy] = rel(e); vZoom(V.scale > 1 ? 1 : 2.5, fx, fy); tap = 0; } else tap = t; }
  };
  st.onpointermove = (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 1) { if (V.scale > 1) { V.x += dx; V.y += dy; vZoom(V.scale, 0, 0); } }
    else if (ptrs.size === 2 && last) {
      const d = dist(), [a, b] = [...ptrs.values()], r = st.getBoundingClientRect();
      const fx = (a.x + b.x) / 2 - r.left - r.width / 2, fy = (a.y + b.y) / 2 - r.top - r.height / 2;
      V.x += dx / 2; V.y += dy / 2; vZoom(V.scale * d / last.d, fx, fy); last.d = d; tap = 0;
    }
  };
  const up = (e) => { ptrs.delete(e.pointerId); last = ptrs.size === 2 ? { d: dist() } : null; };
  st.onpointerup = st.onpointercancel = up;
  st.onwheel = (e) => { e.preventDefault(); const [fx, fy] = rel(e); vZoom(V.scale * Math.exp(-e.deltaY * 0.0015), fx, fy); };
}

function vCenter(...kids) { const body = $('#vbody'); body.innerHTML = ''; const c = mk('div', 'vcenter'); c.append(...kids); body.append(c); return c; }
function vLink(label, href, opts = {}) { const a = mk('a', 'btn', label); a.href = href; if (opts.dl) a.setAttribute('download', ''); else { a.target = '_blank'; a.rel = 'noopener'; } return a; }

async function openViewer(p, opts = {}) { // opts.src: show this image (data URL) instead of a file
  const dlg = $('#vdlg');
  $('#vname').textContent = opts.title || baseName(p || ''); $('#vmeta').textContent = p && !opts.src ? p : '';
  for (const id of ['#vopen', '#vdl', '#vwrap', '#vedit']) $(id).hidden = true;
  if (!dlg.open) dlg.showModal();
  if (opts.src) return vStage(opts.src, opts.title);
  vCenter(mk('div', '', 'Loading…'));
  let r;
  try { r = await fileInfo(p); }
  catch (e) {
    const c = vCenter(mk('code', '', p), mk('div', '', e.data?.outside ? "This path is outside the agent's folder, so it is not shown here." : e.message));
    c.firstChild.style.overflowWrap = 'anywhere';
    return;
  }
  $('#vname').textContent = r.name; $('#vmeta').textContent = r.path + ' · ' + fmtSize(r.size);
  const dl = $('#vdl'); dl.href = r.url + '&dl=1'; dl.hidden = r.tooLarge; dl.setAttribute('download', r.name);
  if (r.tooLarge) return vCenter(mk('div', '', 'This file is larger than 25 MB and is not served.'));
  if (r.kind === 'image') return vStage(r.url, r.name);
  if (r.kind === 'text') {
    const body = $('#vbody'); body.innerHTML = '';
    const pre = mk('pre'); pre.id = 'vtext'; pre.textContent = 'Loading…'; body.append(pre);
    $('#vwrap').hidden = false; $('#vwrap').textContent = 'Wrap'; pre.classList.remove('wrap');
    $('#vedit').hidden = r.size > 2 * 1024 * 1024; $('#vedit').onclick = () => { $('#vdlg').close(); editPath(r.path); }; // the code editor opens up to 2 MB
    try {
      const resp = await fetch(r.url); if (!resp.ok) throw new Error(await resp.text());
      highlightInto(pre, await resp.text(), hlLang(r.name));
      if (resp.headers.get('x-truncated') || r.truncated) { const n = mk('div'); n.id = 'vnote'; n.className = 'warn'; n.textContent = 'Truncated: showing the first 2 MB of ' + fmtSize(r.size) + '.'; body.append(n); }
    } catch (e) { pre.textContent = e.message; }
    return;
  }
  const open = r.kind === 'pdf' ? vLink('Open PDF', r.url) : null;
  if (open) { const o = $('#vopen'); o.href = r.url; o.hidden = false; o.textContent = 'Open PDF'; }
  vCenter(mk('b', '', r.name), mk('div', '', (r.kind === 'pdf' ? 'PDF · ' : 'Binary file · ') + fmtSize(r.size)), ...(open ? [open] : []), vLink('Download', r.url + '&dl=1', { dl: true }));
}
$('#vclose').onclick = () => $('#vdlg').close();
$('#vdlg').addEventListener('close', () => { $('#vbody').innerHTML = ''; });
$('#vwrap').onclick = () => { const t = $('#vtext'); if (!t) return; t.classList.toggle('wrap'); $('#vwrap').textContent = t.classList.contains('wrap') ? 'No wrap' : 'Wrap'; };

// thumbnail + path chips under a tool card; retry() runs when the tool result arrives (a Write's file only exists then)
const toolEls = {};
function fileChips(card, paths, id) {
  const wrap = mk('div', 'fchips');
  const chip = (p) => {
    const b = mk('button', 'fchip'); b.innerHTML = icon(isImgPath(p) ? 'eye' : 'file-text') + '<span></span>'; b.lastChild.textContent = p;
    b.title = p; b.onclick = (e) => { e.stopPropagation(); openViewer(p); }; return b;
  };
  const thumb = async (p, slot) => {
    try {
      const r = await fileInfo(p);
      if (r.kind !== 'image' || r.tooLarge) return;
      const b = mk('button', 'fthumb'); b.title = p; b.setAttribute('aria-label', 'View ' + baseName(p));
      const img = mk('img'); img.loading = 'lazy'; img.alt = baseName(p); img.src = r.url;
      img.onerror = () => b.remove();
      b.append(img); b.onclick = (e) => { e.stopPropagation(); openViewer(p); };
      slot.replaceChildren(b);
    } catch (e) {
      if (e.data?.outside) { const o = mk('span', 'fchip out', p + " (outside the agent's folder)"); slot.replaceChildren(o); }
    }
  };
  const slots = paths.map((p) => {
    const slot = mk('span'); slot.style.display = 'contents'; slot.append(chip(p)); wrap.append(slot);
    return [p, slot];
  });
  const run = () => slots.forEach(([p, slot]) => { if (isImgPath(p) && !slot.querySelector('.fthumb')) thumb(p, slot); });
  card.append(wrap); run();
  if (id) toolEls[id] = { run, img: paths.some(isImgPath) };
}

// image blocks inside events (a Read of an image, attachments): bytes are dropped from the wire, fetched when tapped
function imageBlock(parent, idx, loc, c) {
  const b = mk('button', 'fchip'); b.innerHTML = icon('eye') + '<span>image (tap to view)</span>';
  const src = c?.source?.data ? `data:${c.source.media_type || 'image/png'};base64,${c.source.data}` : null;
  if (src) { const img = mk('img'); img.src = src; img.alt = 'image'; img.style.cssText = 'max-width:min(100%,220px);max-height:140px'; b.textContent = ''; b.className = 'fthumb'; b.append(img); }
  b.onclick = async (e) => {
    e.stopPropagation();
    if (src) return openViewer('', { src, title: 'Image' });
    b.disabled = true;
    try {
      const full = await api('/agents/' + sel + '/events/' + idx);
      let blk = full.message.content[loc[0]]; if (loc[1] != null) blk = blk.content[loc[1]];
      const d = blk?.source?.data;
      if (!d) throw new Error('image data is not available');
      openViewer('', { src: `data:${blk.source.media_type || 'image/png'};base64,${d}`, title: 'Image' });
    } catch (x) { flash(x.message, 'error'); } finally { b.disabled = false; }
  };
  const w = mk('div', 'fchips'); w.append(b); parent.append(w);
}

// syntax highlighting (highlight.js, common languages); plain text when the language is unknown or the text is big
const LANG_BY_EXT = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', kt: 'kotlin', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', htm: 'xml', html: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', md: 'markdown', h: 'c', hpp: 'cpp', cc: 'cpp', cs: 'csharp', ps1: 'powershell', gitignore: 'bash', env: 'ini', conf: 'ini', cfg: 'ini', toml: 'ini' };
function hlLang(name) { const b = name.toLowerCase(), e = b.includes('.') ? b.split('.').pop() : b; const l = b === 'dockerfile' || b === 'makefile' ? b : LANG_BY_EXT[e] || e; return window.hljs?.getLanguage(l) ? l : null; }
function highlightInto(el, text, lang) { // el.textContent = text, upgraded to highlighted markup when possible
  el.textContent = text;
  if (!lang || text.length > 300000 || !window.hljs) return;
  try { el.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; el.classList.add('hljs'); } catch {}
}
function highlightBlocks(root) { // fenced code blocks in rendered markdown
  if (!window.hljs) return root;
  root.querySelectorAll('pre > code').forEach((c) => {
    if (c.classList.contains('hljs')) return;
    const m = /language-([\w+-]+)/.exec(c.className), lang = m && window.hljs.getLanguage(m[1]) ? m[1] : null;
    if (lang) highlightInto(c, c.textContent, lang);
  });
  return root;
}

// make inline code spans that look like file paths tappable
function linkPaths(root) {
  root.querySelectorAll('code').forEach((c) => {
    if (c.closest('pre') || c.classList.contains('fpath')) return;
    const m = PATH_CODE.exec(c.textContent.trim());
    if (!m || !goodPath(m[1])) return;
    c.classList.add('fpath'); c.dataset.path = m[1]; c.title = 'Open ' + m[1]; c.setAttribute('role', 'button');
  });
  return root;
}
// Ctrl/Cmd+click opens the path in the code editor instead (the viewer's Edit button does the same)
document.addEventListener('click', (e) => { const f = e.target.closest?.('.fpath'); if (f) { e.preventDefault(); if ((e.metaKey || e.ctrlKey) && sel) editPath(f.dataset.path); else openViewer(f.dataset.path); } });

