// ---- plugins (plugins.js on the server): load the UI part of running plugins, give each a `host` object,
// and Settings → Plugins (list, enable with consent, generated settings forms, log). A plugin's UI runs in this page with
// your login, like its server part runs in the server: only enable plugins you trust.
const pluginUi = {}; // id -> { cleanup: [fn], styles: [link], listeners: { type: Set<fn> }, settingsRender }
let pluginList = [];

const pluginStore = (id) => ({
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(`halay-plugin:${id}:${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(`halay-plugin:${id}:${k}`, JSON.stringify(v)),
});

// a plugin callback that throws must not break the page: report it and carry on
function pluginTry(id, where, fn, fallback) {
  try {
    const r = fn();
    if (r instanceof Promise) return r.catch((e) => { console.error(`[plugin ${id}] ${where}:`, e); return fallback; });
    return r;
  } catch (e) { console.error(`[plugin ${id}] ${where}:`, e); return fallback; }
}

function pluginHostFor(p) {
  const st = pluginUi[p.id], add = (fn) => { st.cleanup.push(fn); return fn; };
  const host = {
    id: p.id, apiVersion: p.apiVersion,
    // the plugin's own routes (ctx.routes): host.api('status') = /api/plugins/<id>/api/status
    api: (path, opts) => api(`/plugins/${encodeURIComponent(p.id)}/api/${String(path).replace(/^\/+/, '')}`, opts),
    // this server's documented REST API with your session, e.g. host.coreApi('/stats')
    coreApi: (path, opts) => api(path, opts),
    on(type, fn) { // what the plugin's server part sends with ctx.ui.broadcast(type, payload)
      (st.listeners[type] ||= new Set()).add(fn);
      return add(() => st.listeners[type].delete(fn));
    },
    every(ms, fn) { const t = setInterval(() => { if (!document.hidden) pluginTry(p.id, 'timer', fn); }, Math.max(1000, ms)); return add(() => clearInterval(t)); },
    storage: pluginStore(p.id),
    go: (hash) => go(hash),
    ui: Object.freeze({ flash, ask, icon, mk, esc, relTime }),
    sidebar: Object.freeze({
      // a collapsible block like Plan limits / Machines. render(body) fills it; returns { refresh, setCount, setHidden, remove }
      block({ id, title, order = 100, render, collapsed = false }) {
        const key = `halay-pblock:${p.id}:${id}`, sec = mk('section', 'pblock');
        sec.dataset.order = order; sec.dataset.plugin = p.id; sec.setAttribute('aria-label', title);
        const head = mk('button', 'sgh'); head.type = 'button';
        head.innerHTML = icon('chevron-right', 'car') + '<span></span><span class="n"></span>';
        head.querySelector('span').textContent = title;
        const body = mk('div', 'pbody');
        sec.append(head, body);
        const open = () => sideLS(key, !collapsed && !matchMedia('(max-width: 700px)').matches);
        const show = () => { sec.classList.toggle('shut', !open()); head.setAttribute('aria-expanded', open()); };
        head.onclick = () => { sideSet(key, !open()); show(); };
        show();
        const after = [...document.querySelectorAll('#side .pblock')].find((b) => Number(b.dataset.order) > order);
        $('#side').insertBefore(sec, after || $('#slive'));
        const refresh = () => pluginTry(p.id, `block ${id}`, () => render(body), null);
        refresh();
        add(() => sec.remove());
        return {
          el: sec, body, refresh,
          setCount(text, level = '') { const n = head.querySelector('.n'); n.textContent = text ?? ''; n.className = 'n ' + level; },
          setHidden(h) { sec.hidden = !!h; },
          remove: () => sec.remove(),
        };
      },
    }),
    pages: Object.freeze({
      // a page at #/p/<plugin>/<id>, opened from a button in the sidebar's tool row
      add({ id, title, icon: ic = 'puzzle', render }) {
        const b = mk('button'); b.type = 'button';
        b.title = title; b.setAttribute('aria-label', title); b.dataset.label = title; b.dataset.plugin = p.id;
        b.innerHTML = icon(ic);
        b.onclick = () => go(`/p/${p.id}/${id}`);
        $('#tools').insertBefore(b, $('#bmore')); // visible in the bar, before More
        (st.pages ||= {})[id] = { title, render };
        add(() => { b.remove(); delete st.pages[id]; });
      },
    }),
    settings: Object.freeze({
      // extra content under the plugin's generated form in Settings → Plugins
      section({ render }) { st.settingsRender = render; add(() => { st.settingsRender = null; }); },
    }),
  };
  return Object.freeze(host);
}

// the cache-busting key of a plugin's UI: the server's load counter (rev) when it sends one, else the version
const pluginRev = (p) => String(p.rev ?? p.version);
async function loadPluginUi(p) {
  let st = pluginUi[p.id];
  if (st && (st.cancelled || st.rev !== pluginRev(p))) { await unloadPluginUi(p.id); st = null; } // being unloaded, or a newer load: start over
  if (st) return;
  st = pluginUi[p.id] = { cleanup: [], styles: [], listeners: {}, pages: {}, rev: pluginRev(p), cancelled: false };
  const rev = encodeURIComponent(st.rev);
  for (const href of p.styles) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href + '?v=' + rev;
    document.head.append(l); st.styles.push(l);
  }
  st.loading = (async () => {
    try {
      const mod = await import(p.ui + '?v=' + rev);
      if (st.cancelled) return; // unloaded while the import was pending: never activate
      st.mod = mod;
      if (typeof mod.activate === 'function') await mod.activate(pluginHostFor({ ...p, apiVersion: pluginApiVersion }));
    } catch (e) {
      console.error(`[plugin ${p.id}] could not start its UI:`, e);
      flash(`Plugin ${p.displayName}: its page code failed (${e.message})`, 'error');
    }
  })();
  await st.loading;
}
// waits for a pending load, so deactivate/cleanup see everything the plugin registered
function unloadPluginUi(id) {
  const st = pluginUi[id];
  if (!st) return Promise.resolve();
  st.cancelled = true;
  return st.unloading ||= (async () => {
    await st.loading;
    pluginTry(id, 'deactivate', () => st.mod?.deactivate?.());
    for (const fn of st.cleanup.reverse()) { try { fn(); } catch (e) { console.warn(`[plugin ${id}] cleanup:`, e); } }
    for (const l of st.styles) l.remove();
    if (pluginUi[id] === st) delete pluginUi[id];
    if (location.hash.startsWith(`#/p/${id}/`)) go('/');
  })();
}
let pluginApiVersion = null;
// which plugin UIs should be loaded now: called at start and whenever the server says plugins changed
let syncing = null, syncAgain = false;
function syncPluginUis() { // one at a time; a request that arrives meanwhile runs once more afterwards
  if (syncing) { syncAgain = true; return syncing; }
  return syncing = (async () => {
    do { syncAgain = false; await syncPluginUisOnce(); } while (syncAgain);
  })().finally(() => { syncing = null; });
}
async function syncPluginUisOnce() {
  let want;
  // the API version is needed by every plugin UI: ask for it alongside the list, not after it
  const ver = pluginApiVersion ? null : api('/plugins').then((d) => d.api || null, () => null);
  const early = window.__early?.ui; if (window.__early) delete window.__early.ui; // the page's head already asked (index.html)
  try { want = (await early) || await api('/plugins/ui'); } catch (e) { console.warn('plugins: could not list plugin UIs:', e); return; }
  const ids = new Set(want.map((p) => p.id));
  await Promise.all(Object.keys(pluginUi).filter((id) => !ids.has(id)).map(unloadPluginUi));
  if (ver) pluginApiVersion = await ver;
  await Promise.all(want.map(loadPluginUi)); // in parallel: one slow plugin must not hold up the others
}

// WebSocket: { type: 'plugin', plugin, event, payload } from ctx.ui.broadcast, and { type: 'plugins' } when the list changed
function onPluginMsg(msg) {
  if (msg.type === 'plugins') { syncPluginUis(); if ($('#sdlg').open) renderPluginSettings(); return; } // cards with unsaved edits are kept as they are
  const fns = pluginUi[msg.plugin]?.listeners[msg.event];
  if (fns) for (const fn of fns) pluginTry(msg.plugin, 'on ' + msg.event, () => fn(msg.payload));
}

async function openPluginPage(id, page) {
  await pluginsReady;
  const pg = pluginUi[id]?.pages?.[page];
  if (!pg) { flash('That plugin page is not available (is the plugin enabled?)', 'error'); go('/'); return; }
  $('#pghead').textContent = pg.title;
  $('#pgsub').textContent = pluginList.find((x) => x.id === id)?.displayName || id;
  const body = $('#pgbody'); body.textContent = '';
  if (!$('#pgdlg').open) $('#pgdlg').showModal();
  await pluginTry(id, `page ${page}`, () => pg.render(body), null);
}
$('#pgclose').onclick = () => $('#pgdlg').close();

// ---- Settings → Plugins
const PSTATE = { running: 'on', off: 'off', error: 'error', starting: 'starting…' };
function pluginField(id, k, s, values, secretsSet) {
  let cleared = false;
  const wrap = mk('div', 'fl'), fid = `pf-${id}-${k}`, label = mk('label', '', s.title || k);
  label.htmlFor = fid;
  let input;
  if (s.type === 'boolean') {
    const l = mk('label', 'chk'); input = mk('input'); input.type = 'checkbox'; input.checked = !!values[k];
    l.append(input, document.createTextNode(' ' + (s.title || k))); wrap.append(l);
  } else if (s.type === 'array' && !s.items?.enum) { // free-form list: one item per line or comma separated
    wrap.append(label); input = mk('textarea', 'fld'); input.rows = 3;
    input.value = (values[k] || []).join('\n'); wrap.append(input);
    if (!s.help) wrap.append(mk('div', 'mutl', 'One per line, or separated by commas.'));
  } else if (s.type === 'array') {
    wrap.append(label);
    const box = mk('div', 'pchoices'); input = box;
    for (const v of s.items.enum) {
      const l = mk('label', 'chk'), c = mk('input'); c.type = 'checkbox'; c.value = v; c.checked = (values[k] || []).includes(v);
      l.append(c, document.createTextNode(' ' + v)); box.append(l);
    }
    wrap.append(box);
  } else if (s.enum) {
    wrap.append(label); input = mk('select', 'fld');
    for (const v of s.enum) { const o = mk('option', '', v); o.value = v; input.append(o); }
    input.value = values[k] ?? ''; wrap.append(input);
  } else {
    wrap.append(label); input = mk('input', 'fld');
    input.type = s.secret ? 'password' : s.type === 'number' ? 'number' : 'text';
    input.autocomplete = 'off'; input.autocapitalize = 'off';
    if (s.secret) input.placeholder = secretsSet[k] ? 'saved (leave empty to keep)' : '';
    else input.value = values[k] ?? '';
    if (s.placeholder && !s.secret) input.placeholder = s.placeholder;
    wrap.append(input);
    if (s.secret && secretsSet[k]) { // an empty field keeps the saved secret; Clear sends null to delete it
      const c = mk('button', '', 'Clear'); c.type = 'button'; c.setAttribute('aria-label', 'Clear saved ' + (s.title || k));
      c.onclick = () => {
        cleared = !cleared; c.textContent = cleared ? 'Undo clear' : 'Clear';
        input.disabled = cleared; input.value = ''; input.placeholder = cleared ? 'will be cleared on save' : 'saved (leave empty to keep)';
        wrap.dispatchEvent(new Event('change', { bubbles: true }));
      };
      wrap.append(c);
    }
  }
  input.id = fid;
  if (s.help) wrap.append(mk('div', 'mutl', s.help));
  const read = () => s.type === 'boolean' ? input.checked
    : s.type === 'array' && s.items?.enum ? [...input.querySelectorAll('input:checked')].map((c) => c.value)
    : s.type === 'array' ? input.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
    : s.secret && cleared ? null
    : input.value;
  return { el: wrap, read };
}
async function enablePlugin(p) {
  const perms = p.permissions.map((x) => `• ${x.text}`).join('\n');
  const yes = await ask(`Enable ${p.displayName}? Plugins run with the same access as this server.${perms ? '\n\nIt asks to:\n' + perms : ''}`, { ok: 'Enable' });
  if (!yes) return;
  try { await api(`/plugins/${encodeURIComponent(p.id)}/enable`, { method: 'POST', body: { permissions: p.permissions.map((x) => x.id) } }); }
  catch (e) { flash(e.message, 'error'); }
  renderPluginSettings();
}
function pluginCard(p) {
  const card = mk('div', 'pcard ' + p.state), head = mk('div', 'pchd');
  card.dataset.pid = p.id; card.dirty = false;
  const t = mk('b', '', p.displayName); head.append(t, mk('span', 'pver', `${p.version} · ${p.source}`));
  head.append(mk('span', 'pstate ' + p.state, p.needsConsent ? 'needs consent' : PSTATE[p.state] || p.state));
  const btn = (text, fn) => { const b = mk('button', '', text); b.type = 'button'; b.onclick = fn; head.append(b); return b; };
  const off = p.state === 'running' || p.state === 'error' || p.needsConsent; // can be turned off; an errored or unconsented one can also be enabled again
  if (p.state !== 'running') {
    const en = btn('Enable', () => enablePlugin(p));
    if (!p.compatible) { en.disabled = true; en.title = p.error || `Needs plugin API ${p.api || '(newer)'}`; head.append(mk('span', 'mutl', en.title)); }
  }
  if (off) btn('Disable', async () => { await api(`/plugins/${encodeURIComponent(p.id)}/disable`, { method: 'POST' }).catch((e) => flash(e.message, 'error')); renderPluginSettings(); });
  card.append(head);
  if (p.description) card.append(mk('div', 'mutl', p.description));
  if (p.error) card.append(mk('div', 'perr', p.error));
  if (p.permissions.length) card.append(mk('div', 'mutl pperm', 'Can: ' + p.permissions.map((x) => x.text).join('; ')));
  if (p.tools.length) card.append(mk('div', 'mutl', 'Agent tools: ' + p.tools.map((x) => `${x.name} (${x.roles.join(', ')}${x.autoAllow ? ', no approval' : ''})`).join(', ')));
  if (p.hasSettings) {
    const fields = Object.entries(p.settingsSchema).map(([k, s]) => [k, pluginField(p.id, k, s, p.settings.values, p.settings.secretsSet)]);
    const form = mk('div', 'pform'); fields.forEach(([, f]) => form.append(f.el));
    const row = mk('div', 'row'), save = mk('button', '', 'Save settings'); save.type = 'button';
    const doSave = async (quiet) => { // resolves true when saved
      const body = Object.fromEntries(fields.map(([k, f]) => [k, f.read()]));
      try { await api(`/plugins/${encodeURIComponent(p.id)}/settings`, { method: 'PUT', body }); card.dirty = false; if (!quiet) flash(`${p.displayName}: settings saved`, 'ok'); return true; }
      catch (e) { flash(e.message, 'error'); return false; }
    };
    save.onclick = () => doSave();
    for (const ev of ['input', 'change']) form.addEventListener(ev, () => { card.dirty = true; });
    row.append(save);
    if (p.channels.length && p.state === 'running') {
      const test = mk('button', '', 'Send test'); test.type = 'button';
      test.onclick = async () => {
        try { if (!await doSave(true)) return; await api(`/plugins/${encodeURIComponent(p.id)}/test`, { method: 'POST' }); flash('Test sent', 'ok'); }
        catch (e) { flash(e.message, 'error'); }
      };
      row.append(test);
    }
    form.append(row); card.append(form);
  }
  const extra = pluginUi[p.id]?.settingsRender;
  if (extra) { const box = mk('div', 'pextra'); card.append(box); pluginTry(p.id, 'settings section', () => extra(box)); }
  const logs = mk('details', 'plog'), sum = mk('summary', '', 'Log'), pre = mk('pre');
  logs.append(sum, pre);
  logs.ontoggle = async () => {
    if (!logs.open) return;
    try { const d = await api(`/plugins/${encodeURIComponent(p.id)}`); pre.textContent = d.logs.map((l) => `${new Date(l.at).toLocaleTimeString()} ${l.level} ${l.text}`).join('\n') || '(empty)'; }
    catch (e) { pre.textContent = e.message; }
  };
  card.append(logs);
  return card;
}
async function renderPluginSettings() {
  const box = $('#plist');
  let d;
  try { d = await api('/plugins'); } catch (e) { box.textContent = e.message; return; }
  pluginList = d.plugins;
  const keep = new Map([...box.querySelectorAll('.pcard')].filter((c) => c.dirty).map((c) => [c.dataset.pid, c])); // unsaved edits survive a refresh
  box.textContent = '';
  if (d.safeMode) box.append(mk('div', 'perr', 'Safe mode (HALAY_PLUGINS=0): every plugin is off until the server starts without it.'));
  if (!d.plugins.length) box.append(mk('div', 'mutl', 'No plugins found.'));
  for (const p of d.plugins) box.append(keep.get(p.id) || pluginCard(p));
  for (const x of d.problems) box.append(mk('div', 'perr', `${x.dir}: ${x.error}`));
  $('#pdir').textContent = d.pluginsDir;
}

const pluginsReady = syncPluginUis();
