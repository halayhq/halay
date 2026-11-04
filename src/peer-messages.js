// Messages from other Claude sessions (Claude Code's SendMessage across sessions). The CLI hands them to the receiving
// session itself, not through our stdin, and its stream-json output carries no text for them: an idle session prints
// only {"type":"command_lifecycle","command_uuid":<transcript uuid>,"state":"started"} before the turn they start, and a
// busy one prints nothing (the message rides along as a system reminder with the next model call). The transcript has
// them, in one of two shapes:
//   idle: {"type":"user","isMeta":true,"message":{"content":"Another Claude session sent a message:\n<cross-session-message
//          from=\"uds:…sock\" from-name=\"wt-71\" …>\n…</cross-session-message>…"},"origin":{"kind":"peer","from":…,
//          "name":"wt-71","msg_id":…,"body":"<the text>"},"timestamp":…}
//   busy: {"type":"attachment","attachment":{"type":"queued_command","prompt":"<cross-session-message …>…</cross-session-message>",
//          "origin":{ same as above }},"timestamp":…}
// (queue-operation enqueue/remove lines carry the text too; they are bookkeeping, the two above are the delivery.)
// So the server reads what a session appends to its transcript (PeerTail) and turns these into chat events:
//   { type: 'peer_message', from, fromName, text, msgId, queued }
import fs from 'node:fs';

const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const attr = (attrs, k) => { const m = new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(attrs); return m ? unesc(m[1]) : undefined; };

// the first <cross-session-message …>…</cross-session-message> in a text -> { from, fromName, text } or null
export function parseCrossSession(raw) {
  if (typeof raw !== 'string') return null;
  const m = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/.exec(raw);
  if (!m) return null;
  return { from: attr(m[1], 'from') ?? '', fromName: attr(m[1], 'from-name') ?? '', text: m[2] };
}

// does a prompt text look like a delivered peer message (and not, say, the user pasting one into a longer message)?
const isPeerWrapper = (s) => typeof s === 'string' && /^(?:Another Claude session sent a message[^\n]*\n)?<cross-session-message\b/.test(s.trimStart());

// one transcript entry -> { from, fromName, text, msgId, queued, ts } when it delivers a peer message, else null
export function peerFromEntry(e) {
  if (!e || typeof e !== 'object' || e.isSidechain) return null;
  let origin, raw, queued = false;
  if (e.type === 'user') {
    origin = e.origin;
    const c = e.message?.content;
    raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : '';
  } else if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
    origin = e.attachment.origin; raw = e.attachment.prompt; queued = true;
  } else return null;
  if (origin && typeof origin === 'object') { if (origin.kind !== 'peer') return null; }
  else if (!isPeerWrapper(raw)) return null; // a CLI without `origin`: only the exact wrapper counts
  const parsed = parseCrossSession(raw);
  const text = typeof origin?.body === 'string' ? origin.body : parsed?.text;
  if (typeof text !== 'string') return null;
  return {
    from: String(origin?.from ?? parsed?.from ?? ''),
    fromName: String(origin?.name ?? parsed?.fromName ?? ''),
    text,
    msgId: origin?.msg_id || e.attachment?.delivery_id || e.uuid || null,
    queued,
    ts: Date.parse(e.timestamp) || undefined,
  };
}

// the chat event for a peer message
export const peerEvent = (p) => ({ type: 'peer_message', from: p.from, fromName: p.fromName, text: p.text, ...(p.msgId && { msgId: p.msgId }), ...(p.queued && { queued: true }) });

// Follows one transcript file: read() returns the peer messages appended since the last call (complete lines only).
// since: the first read skips messages older than this (ms); it starts at most `window` bytes before the end, so a
// server that restarted picks up what arrived meanwhile without reading a long transcript from the start.
export class PeerTail {
  constructor(file, { since = 0, window = 1 << 20 } = {}) {
    this.file = file; this.since = since; this.window = window; this.offset = null; this.size = -1;
  }

  read() {
    let size;
    try { size = fs.statSync(this.file).size; } catch { if (this.offset == null) this.offset = 0; return []; } // not written yet
    let skipFirst = false;
    if (this.offset == null || size < this.offset) { // first look (or the file was rewritten): only its end
      this.offset = Math.max(0, size - this.window); skipFirst = this.offset > 0;
    }
    if (size === this.offset) return [];
    const fd = fs.openSync(this.file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(size - this.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
      const end = buf.lastIndexOf(10, n - 1) + 1; // the last line may still be being written: next time
      text = buf.toString('utf8', 0, end);
      this.offset += end;
    } finally { fs.closeSync(fd); }
    const out = [];
    const lines = text.split('\n');
    if (skipFirst) lines.shift(); // started mid-line
    for (const line of lines) {
      if (!line.includes('cross-session-message') && !line.includes('"kind":"peer"')) continue; // cheap filter: most lines are tool output
      let e; try { e = JSON.parse(line); } catch { continue; }
      const p = peerFromEntry(e);
      if (p && !(this.since && p.ts && p.ts < this.since)) out.push(p);
    }
    this.since = 0;
    return out;
  }
}

// The name to show for a SendMessage recipient: a peer address ("uds:/tmp/cc-socks/123.sock") becomes the from-name it
// wrote to us with, when one of its messages is known (names: address -> from-name).
export function peerNames(events) {
  const names = {};
  for (const e of events) if (e?.type === 'peer_message' && e.from && e.fromName) names[e.from] = e.fromName;
  return names;
}
