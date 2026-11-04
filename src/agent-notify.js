// Child -> parent turn notifications (the swarm's version of Claude Code's <task-notification>): when an agent started
// through the swarm MCP (start_agent) ends a turn its parent asked for, the parent is woken with a short automatic
// message instead of having to block in wait_for_agent or poll read_agent. server.js owns the state (which turns are
// armed, the per-parent queue, the dedupe against wait_for_agent); this file holds the wording, so it is unit-testable.
//
// An entry is { childId, name, outcome: finished|error|stopped|blocked, result, blocked: [{ text, question }], turns }.
// Several entries pending for one parent are coalesced into a single message, one bullet per child (newest state wins).

export const NOTICE_HEAD = '[agent notification]';
export const RESULT_CLIP = 1500;

const clip = (s, max) => (s.length <= max ? { text: s, more: 0 } : { text: s.slice(0, max), more: s.length - max });

const asking = (blocked) => (blocked || []).map((b) => (b.question ? `a question for the user: ${b.text}` : `the user's approval of ${b.text}`)).join('; ') || 'the user';

function what(e) {
  const who = `Agent ${e.childId} "${e.name}"`;
  const again = e.turns > 1 ? ` (${e.turns} turns since the last notification; this is the latest)` : '';
  if (e.outcome === 'blocked') {
    return `${who} is BLOCKED waiting for ${asking(e.blocked)} in the swarm UI. Only the user can unblock it; tell them if they may not have noticed. You will be notified again when its turn ends.`;
  }
  if (e.outcome === 'stopped') return `${who} stopped before finishing its turn (its process exited or it was interrupted)${again}.`;
  const head = e.outcome === 'error' ? `${who} ended its turn with an ERROR${again}.` : `${who} finished its turn${again}.`;
  const r = clip(String(e.result ?? '').trim() || '(no result text)', RESULT_CLIP);
  const now = e.blockedNow ? `\nIt has started another turn since and is now BLOCKED waiting for ${asking(e.blockedNow)} in the swarm UI.` : '';
  return `${head}\nResult:\n${r.text}${r.more ? `… [${r.more} more chars; read_agent agent_id=${e.childId} result=true returns all of it]` : ''}${now}`;
}

// the message a parent gets for its pending entries (in the order they arrived)
export function noticeText(entries) {
  const intro = `${NOTICE_HEAD} Automatic message from the swarm, not from the user: ${entries.length > 1 ? `${entries.length} agents you started have news` : 'an agent you started has news'}.`;
  const body = entries.length === 1 ? what(entries[0]) : entries.map((e) => '- ' + what(e).replace(/\n/g, '\n  ')).join('\n\n');
  return `${intro}\n\n${body}\n\n(No need to call wait_for_agent or read_agent to learn this. Continue your work, or tell the user if it matters to them.)`;
}

// merge a new entry for a child into the parent's pending map (childId -> entry). A later finished turn replaces an
// earlier one (turns counts them, so the parent knows it missed intermediate results); a block notice after a pending
// finished turn is added to it rather than replacing it, and a finished turn clears a pending block notice.
export function mergeNotice(pending, entry) {
  const old = pending.get(entry.childId);
  let next;
  if (entry.outcome === 'blocked') next = old && old.outcome !== 'blocked' ? { ...old, blockedNow: entry.blocked } : { ...entry, turns: 0 };
  else next = { ...entry, turns: (old && old.outcome !== 'blocked' ? old.turns : 0) + 1 };
  pending.delete(entry.childId); // re-inserted: entries are ordered by their newest news
  pending.set(entry.childId, next);
  return pending;
}
