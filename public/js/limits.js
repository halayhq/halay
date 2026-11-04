// Sidebar: each account's plan limits, as Claude Code's /usage shows them (session and weekly windows).
// The server runs `claude -p /usage` per account and caches it for a few minutes.
let limitsData = null, limitsBusy = false;
function renderLimits() {
  const box = $('#limits'), body = $('#limbody');
  const names = Object.keys(limitsData || {});
  box.hidden = !names.length;
  if (!names.length) return;
  const open = sideLS('halay-limits', true);
  box.classList.toggle('shut', !open); $('#limh').setAttribute('aria-expanded', open);
  // collapsed: the highest share of any window, so a nearly used-up account still shows
  const top = Math.max(0, ...names.flatMap((n) => limitsData[n].limits.map((l) => l.pct)));
  $('#limtop').textContent = names.some((n) => limitsData[n].limits.length) ? `max ${Math.round(top)}%` : '';
  $('#limtop').className = 'n ' + limLevel(top);
  body.innerHTML = '';
  // accounts on one login (same config dir) come back as one reading: show them together
  const groups = {};
  for (const n of names) (groups[JSON.stringify([limitsData[n].at, limitsData[n].limits, limitsData[n].error])] ||= []).push(n);
  for (const ns of Object.values(groups)) {
    const d = limitsData[ns[0]], acct = mk('div', 'lacct');
    acct.append(mk('b', '', ns.join(' · ')));
    if (d.error) acct.append(mk('small', 'lerr', d.error));
    else if (!d.limits.length) acct.append(mk('small', 'lnote', d.note || 'no plan limits reported'));
    for (const l of d.limits) {
      const row = mk('div', 'lrow ' + limLevel(l.pct)), session = /^session$/i.test(l.label);
      row.title = `${l.label}: ${l.pct}% used${l.resets ? '\nresets ' + l.resets : ''}`;
      row.innerHTML = `<span class="ll"></span><span class="lbar"><i style="width:${Math.min(100, l.pct)}%"></i></span><span class="lp">${Math.round(l.pct)}%</span><span class="lr"></span>`;
      row.querySelector('.ll').textContent = session ? 'Session' : l.label.replace(/^week\s*\((?:all models)?\)?/i, 'Week ').replace(/\)$/, '').trim();
      // "Oct 24 at 2:30am (Europe/Istanbul)": the time for the session window, the day for weekly ones
      const m = l.resets.match(/^(.*?) at ([^\s(]+)/);
      row.querySelector('.lr').textContent = m ? (session ? m[2] : m[1]) : l.resets.replace(/\s*\([^)]*\)$/, '');
      acct.append(row);
    }
    body.append(acct);
  }
  const at = Math.min(...names.map((n) => limitsData[n].at || Date.now()));
  const r = relTime(at); $('#limat').textContent = r === 'now' ? 'checked just now' : `checked ${r} ago`;
}
const limLevel = (p) => p >= 90 ? 'high' : p >= 70 ? 'warn' : '';
async function loadLimits(refresh) {
  if (limitsBusy) return;
  limitsBusy = true; $('#limr').classList.add('busy');
  try {
    const early = !refresh && window.__early?.limits; if (early) delete window.__early.limits; // asked by index.html's head, answered from the server's cache
    limitsData = (await early) || await api('/limits' + (refresh ? '?refresh=1' : '')); renderLimits();
  }
  catch (e) { if (refresh) flash('Usage limits: ' + e.message, 'error'); }
  finally { limitsBusy = false; $('#limr').classList.remove('busy'); }
}
$('#limh').onclick = () => { sideSet('halay-limits', !sideLS('halay-limits', true)); renderLimits(); };
$('#limr').onclick = (e) => { e.stopPropagation(); loadLimits(true); };
loadLimits();
setInterval(() => { if (!document.hidden) loadLimits(); }, 5 * 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden && limitsData && Date.now() - Math.min(...Object.values(limitsData).map((d) => d.at)) > 5 * 60e3) loadLimits(); });
