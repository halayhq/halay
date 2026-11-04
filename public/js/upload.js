// ---- attachments: files are uploaded as soon as they are picked, dropped or pasted; the message then carries their paths
const MAX_UPLOAD_NOTE = 'Upload failed';
function uploadFile(file, path, onProgress) { // resolves { name, path, size[, id] }
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api' + path + (path.includes('?') ? '&' : '?') + 'name=' + encodeURIComponent(file.name || 'file'));
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onerror = () => reject(new Error('Network error while uploading ' + file.name));
    x.onabort = () => reject(new Error('Upload cancelled'));
    x.onload = () => {
      let j = {}; try { j = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300) resolve(j);
      else reject(new Error(j.error || `${MAX_UPLOAD_NOTE} (${x.status} ${x.statusText})`));
    };
    x.send(file);
  });
}

// An attachment tray. opts: { list, tray, button, input, drop, path: () => upload URL path, onChange }.
// list is the (shared, persistent) array of { name, size, pct, res, err, xhr } entries.
function attachments(opts) {
  const { list, tray } = opts;
  const render = () => {
    if (!tray.isConnected) return; // the chat was re-rendered or another agent opened: this tray is gone, the list stays with its agent
    tray.hidden = !list.length;
    tray.replaceChildren(...list.map((a) => {
      const c = document.createElement('span');
      c.className = 'achip' + (a.err ? ' bad' : a.res ? ' ok' : '');
      const n = document.createElement('span'); n.className = 'an'; n.textContent = a.name;
      const s = document.createElement('small');
      s.textContent = a.err ? a.err : a.res ? fmtSize(a.size) : Math.round(a.pct * 100) + '%';
      const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.title = 'Remove ' + a.name; x.setAttribute('aria-label', 'Remove ' + a.name);
      x.onclick = () => { a.dead = true; list.splice(list.indexOf(a), 1); render(); opts.onChange?.(); };
      c.append(n, s, x);
      if (!a.res && !a.err) { const b = document.createElement('i'); b.style.width = Math.round(a.pct * 100) + '%'; c.append(b); }
      return c;
    }));
  };
  const add = (files) => {
    for (const f of files) {
      const a = { name: f.name || 'pasted-file', size: f.size, pct: 0 };
      list.push(a);
      uploadFile(f, opts.path(), (p) => { a.pct = p; if (!a.dead) list.ui.render(); })
        .then((r) => { a.res = r; })
        .catch((e) => { a.err = e.message; })
        .finally(() => { if (!a.dead) { list.ui.render(); list.ui.onChange?.(); } }); // the tray showing this list now, not the one it was added from
    }
    render(); opts.onChange?.();
  };
  list.ui = { render, onChange: opts.onChange };
  opts.button.onclick = () => opts.input.click();
  opts.input.onchange = () => { add([...opts.input.files]); opts.input.value = ''; };
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  if (opts.drop) {
    // The drop zone (#main) outlives the chat inside it, so every render of a chat used to leave its listeners behind and one drop
    // uploaded the file to every agent opened before. One tray per zone: the previous tray's listeners go when a new one is set up.
    opts.drop._attAbort?.abort();
    const ac = opts.drop._attAbort = new AbortController(), on = { signal: ac.signal };
    opts.drop.classList.remove('dropping');
    let depth = 0;
    opts.drop.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); depth++; opts.drop.classList.add('dropping'); } }, on);
    opts.drop.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); }, on);
    opts.drop.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; opts.drop.classList.remove('dropping'); } }, on);
    opts.drop.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; opts.drop.classList.remove('dropping'); add([...e.dataTransfer.files]); }, on);
  }
  if (opts.paste) opts.paste.addEventListener('paste', (e) => {
    const fs = [...(e.clipboardData?.files || [])];
    if (!fs.length) return;
    e.preventDefault();
    add(fs.map((f) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${(f.type.split('/')[1] || 'bin').replace(/[^\w]/g, '')}`, { type: f.type }))));
  });
  render();
  return { add, render, busy: () => list.some((a) => !a.res && !a.err), failed: () => list.filter((a) => a.err) };
}

const chatAtts = {}; // agent id -> attachments typed-in but not yet sent
