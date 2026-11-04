// Signed in by a session cookie (HttpOnly, set by the login page); no secret lives in the page.
const $ = (s) => document.querySelector(s);
const api = async (p, opts = {}) => {
  let r;
  try { r = await fetch('/api' + p, { ...opts, headers: { 'content-type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) }); }
  catch { throw Object.assign(new Error('Server unreachable'), { status: 0 }); }
  if (r.status === 401) { location.reload(); return new Promise(() => {}); } // session ended: the reload shows the login page
  const j = await r.json().catch(() => null); // a 502 HTML page or an empty 204 is not JSON
  if (!r.ok) throw Object.assign(new Error(j?.error || r.statusText || 'Request failed (' + r.status + ')'), { data: j || {}, status: r.status });
  return j;
};

// shared helpers (state.js loads first)
const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); // safe in text and attributes
const relTime = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : s < 86400 * 7 ? Math.floor(s / 86400) + 'd' : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }); };
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {} // needs a secure context; the fallback covers plain http
  const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;top:0;opacity:0'; document.body.append(ta); ta.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { ta.remove(); }
}
const wsUrl = (path) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;

const accountNames = async () => (await api('/accounts')).map((a) => a.name); // /accounts also carries each login status
// the accounts plus the default one of a CLI (Settings → Accounts → Set as default; else its own bare account)
const accountsWithDefault = async (backend = 'claude') => { const l = await api('/accounts'); return { names: l.map((a) => a.name), def: l.find((a) => a.default && a.backend === backend)?.name || backend }; };

let tasks = [], approvals = [], schedules = [];
// Only the newest window of an agent's history is loaded (the server slims big payloads; "Show full" fetches one event).
// events[id] is a contiguous run of the history starting at absolute index hidden[id] (= how many older events are not loaded);
// those absolute indexes are what live events (msg.i) and search results use. pend[id]: approvals still open from before the window.
let agents = {}, sel = null, events = {}, hidden = {}, pend = {}, pendingEv = {};
const TAIL = '?tail=' + (matchMedia('(max-width: 700px)').matches ? 120 : 300);

// (re)load the newest window of one agent. Live events that arrive meanwhile are buffered and applied after.
async function loadAgent(id) {
  const buf = pendingEv[id] = [];
  try {
    const { events: evs, pending, from, ...sum } = await api('/agents/' + id + TAIL);
    events[id] = evs; hidden[id] = from; pend[id] = pending || []; agents[id] = sum;
    for (const m of buf) if (m.i === from + evs.length) evs.push(m.event);
  } finally { delete pendingEv[id]; }
}
function rerender() { const v = $('#txt')?.value; renderMain(); if (v && $('#txt')) $('#txt').value = v; } // keeps what you were typing

