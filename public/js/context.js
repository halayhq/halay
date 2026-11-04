// ---- context size: gauge in the list and chat header, fresh context with handoff, settings
let ctxCfg = { warn: 100000, high: 150000, leanDefault: false };
const loadCtxCfg = () => api('/settings/context').then((c) => { ctxCfg = c; renderList(); renderCtx(); }).catch(() => {});

const ctxK = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0));
const ctxLevel = (n) => (n >= ctxCfg.high ? 'high' : n >= ctxCfg.warn ? 'warn' : '');
function ctxGauge(a) {
  const s = mk('span', 'ctxg ' + ctxLevel(a.context), a.handoff === 'asking' || a.handoff === 'resetting' ? '⟳ handoff' : ctxK(a.context));
  s.title = a.handoff === 'pending' ? 'Fresh context: the handoff note goes with the next message'
    : `Context: ${(a.context || 0).toLocaleString('en-US')} tokens, re-sent on every turn` + (ctxLevel(a.context) ? '. Consider a fresh context with handoff.' : '');
  if (a.handoff === 'pending') s.textContent = '0 · note';
  return s;
}

// chat header: a ring meter (share of the context window, colored by the warn/high thresholds)
const ctxWin = (n) => ctxCfg.autoCompactWindow || (n > 200000 ? 1000000 : 200000);
function ctxRing(a) {
  const n = a.context || 0, w = ctxWin(n), lvl = ctxLevel(n), C = 2 * Math.PI * 7, f = Math.min(1, n / w);
  const s = mk('span', 'ring ' + (lvl || 'ok'));
  s.innerHTML = `<svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="7" class="rb"/><circle cx="9" cy="9" r="7" class="rf" stroke-dasharray="${(f * C).toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 9 9)"/></svg><span></span>`;
  const busy = a.handoff === 'asking' || a.handoff === 'resetting';
  s.querySelector('span').textContent = busy ? 'handoff…' : a.handoff === 'pending' ? 'note' : ctxK(n);
  s.title = a.handoff === 'pending' ? 'Fresh context: the handoff note goes with the next message'
    : `${ctxK(n)} of ${ctxK(w)} context (${(n).toLocaleString('en-US')} tokens, re-sent on every turn)` + (lvl ? '. Consider a fresh context with handoff (⋯ menu).' : '');
  s.setAttribute('role', 'img'); s.setAttribute('aria-label', s.title); s.tabIndex = 0;
  return s;
}

// header usage chip (`~$9.21 · 109 turns`) and its popover with the full breakdown
function renderUsage(a) {
  const b = $('#ubtn'), u = a.usage; if (!b) return;
  b.hidden = !u?.turns; if (!u?.turns) return;
  const noCost = u.noCost >= u.turns;
  b.innerHTML = `${icon('gauge')}<span>${noCost ? '' : `<b>~${fmtCost(u.cost)}</b><i> · </i>`}<span class="ut">${fmtN(tokTotal(u))} tok · ${plural(u.turns, 'turn')}</span></span>`;
  b.title = 'Usage of this agent (click for details)';
  const row = (k, v) => `<tr><th>${k}</th><td>${v}</td></tr>`;
  $('#upbody').innerHTML = `<b>Usage</b><table>${row('Model', esc(a.model || 'default') + (a.effort ? ' · effort ' + esc(a.effort) : ''))}${row('Turns', u.turns.toLocaleString('en-US'))}${row('Total tokens', fmtN(tokTotal(u)))}${row('Input tokens', fmtN(u.input))}${row('Output tokens', fmtN(u.output))}${row('Cache read', fmtN(u.cacheRead))}${row('Cache written', fmtN(u.cacheCreate))}${row('Estimated cost', noCost ? 'unavailable' : '~' + fmtCost(u.cost) + (u.noCost ? ` <small>(${plural(u.noCost, 'turn')} without a cost)</small>` : ''))}${row('Context now', `${ctxK(a.context)} of ${ctxK(ctxWin(a.context || 0))}`)}</table>
    <p>Tokens are summed over finished turns. Cost is the estimate Claude Code reports (API prices); it is not a bill, and some turns report none.</p>`;
}

function renderCtx() {
  const a = agents[sel], box = $('#ctxbox');
  if (!a || !box) return;
  box.replaceChildren(ctxRing(a));
  renderUsage(a);
  const b = $('#hand');
  b.disabled = a.status === 'running' || !!a.handoff && a.handoff !== 'pending';
  b.title = 'The agent writes a short handoff note (goal, state, decisions, open threads, files, next steps), then its context is cleared and the note goes with your next message';
}

async function refreshWithHandoff(id) {
  const a = agents[id];
  if (!a) return;
  if (!await ask(`Fresh context with handoff for ${a.name}? It writes a short note about its work (about a minute), then starts a new session that gets the note with your next message.`, { ok: 'Hand off' })) return;
  try { await api(`/agents/${id}/refresh`, { method: 'POST', body: {} }); } catch (e) { flash(e.message, 'error'); }
}

// settings dialog: Context section
const CTX_FIELDS = { cwarn: 'warn', chigh: 'high', crtok: 'recycleTokens', crhrs: 'recycleIdleHours', cctok: 'conductorTokens', cchrs: 'conductorIdleHours', ccompact: 'autoCompactWindow' };
const CTX_CHECKS = { cnotify: 'notifyHigh', crecycle: 'autoRecycle', ccond: 'conductorRecycle', clean: 'leanDefault' };
async function loadContextSettings() {
  ctxCfg = await api('/settings/context');
  for (const [el, k] of Object.entries(CTX_FIELDS)) $('#' + el).value = ctxCfg[k] || '';
  for (const [el, k] of Object.entries(CTX_CHECKS)) $('#' + el).checked = !!ctxCfg[k];
}
async function saveContextSettings() {
  const body = {};
  for (const [el, k] of Object.entries(CTX_FIELDS)) body[k] = Number($('#' + el).value) || 0;
  for (const [el, k] of Object.entries(CTX_CHECKS)) body[k] = $('#' + el).checked;
  ctxCfg = await api('/settings/context', { method: 'PUT', body });
  renderList(); renderCtx();
}
