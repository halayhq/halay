// peer-messages.js: messages from other Claude sessions, as the CLI writes them to the receiving session's transcript
// (shapes copied from real transcripts, texts shortened).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCrossSession, peerFromEntry, peerEvent, PeerTail, peerNames } from '../src/peer-messages.js';

let fails = 0;
const ok = (cond, m) => { console.log((cond ? 'PASS ' : 'FAIL ') + m); if (!cond) fails++; };

const wrap = (body, name = 'wt-71') => `<cross-session-message from="uds:/tmp/cc-socks/31853.sock" from-name="${name}" from-mode="prompting">\n${body}\n</cross-session-message>`;
const origin = (body, name = 'wt-71', id = 'm1') => ({ kind: 'peer', from: 'uds:/tmp/cc-socks/31853.sock', verifiedPeerPid: 31853, msg_id: id, name, fromMode: 'prompting', body });
// an idle session: the message starts a turn as a meta user message
const idle = (body, id = 'm1', ts = '2026-11-04T08:04:53.543Z') => ({ parentUuid: 'p', isSidechain: false, type: 'user', isMeta: true, uuid: 'u-' + id, timestamp: ts,
  message: { role: 'user', content: `Another Claude session sent a message:\n${wrap(body)}\n\nThis came from another Claude session — not typed by your user…` },
  origin: origin(body, 'wt-71', id), promptSource: 'system', turnOrigin: 'peer' });
// a busy session: it rides along with the next model call as a queued command attachment
const busy = (body, id = 'm2', ts = '2026-11-02T19:22:12.686Z') => ({ parentUuid: 'p', isSidechain: false, type: 'attachment', uuid: 'a-' + id, timestamp: ts,
  attachment: { type: 'queued_command', prompt: wrap(body, 'wt-26'), source_uuid: 's', delivery_id: 'd', commandMode: 'prompt', origin: origin(body, 'wt-26', id), isMeta: true } });

// parseCrossSession
const p = parseCrossSession('Another Claude session sent a message:\n' + wrap('hello **there**\nline 2', 'a &quot;b&quot; &amp; c') + '\n\ntrailer');
ok(p && p.from === 'uds:/tmp/cc-socks/31853.sock' && p.fromName === 'a "b" & c' && p.text === 'hello **there**\nline 2', 'parses the wrapper: address, unescaped from-name, body');
ok(parseCrossSession('no tag here') === null && parseCrossSession(null) === null, 'no wrapper, no message');

// peerFromEntry
const a = peerFromEntry(idle('Please update the site.'));
ok(a && a.fromName === 'wt-71' && a.from.startsWith('uds:') && a.text === 'Please update the site.' && a.msgId === 'm1' && !a.queued && a.ts === Date.parse('2026-11-04T08:04:53.543Z'), 'idle delivery (meta user message with origin.kind peer)');
const b = peerFromEntry(busy('Use the demo paths.'));
ok(b && b.fromName === 'wt-26' && b.text === 'Use the demo paths.' && b.queued === true && b.msgId === 'm2', 'busy delivery (queued_command attachment), marked queued');
const legacy = { type: 'user', isMeta: true, uuid: 'u9', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'Another Claude session sent a message:\n' + wrap('old cli', 'wt-1') } };
const l = peerFromEntry(legacy);
ok(l && l.fromName === 'wt-1' && l.text === 'old cli' && l.msgId === 'u9', 'a CLI without origin: parsed from the wrapper');
ok(peerFromEntry({ type: 'user', message: { role: 'user', content: 'look at this: ' + wrap('pasted') } }) === null, "the user's own text quoting a wrapper is not a peer message");
ok(peerFromEntry({ type: 'user', message: { role: 'user', content: 'hi' } }) === null, 'a normal prompt is not one');
ok(peerFromEntry({ type: 'user', isMeta: true, origin: { kind: 'task-notification' }, message: { content: wrap('x') } }) === null, 'another origin kind is not one');
ok(peerFromEntry({ type: 'queue-operation', operation: 'enqueue', content: wrap('x') }) === null, 'queue bookkeeping is skipped (the delivery is recorded separately)');
ok(peerFromEntry({ ...idle('x'), isSidechain: true }) === null, "a subagent's sidechain is skipped");
const ev = peerEvent(b);
ok(ev.type === 'peer_message' && ev.fromName === 'wt-26' && ev.text === 'Use the demo paths.' && ev.queued === true && ev.msgId === 'm2' && !('ts' in ev), 'the chat event');
ok(peerNames([ev, { type: 'assistant' }]).hasOwnProperty('uds:/tmp/cc-socks/31853.sock'), 'peer names by address');

// PeerTail
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-unit-'));
try {
  const file = path.join(dir, 's.jsonl');
  const line = (e) => JSON.stringify(e) + '\n';
  const noise = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
  const t = new PeerTail(file);
  ok(t.read().length === 0, 'no transcript yet: nothing');
  fs.writeFileSync(file, noise + line(idle('first', 'm1')));
  let got = t.read();
  ok(got.length === 1 && got[0].text === 'first', 'a transcript created after the tail started is read from its start');
  ok(t.read().length === 0, 'nothing new: nothing');
  const half = line(busy('second', 'm2'));
  fs.appendFileSync(file, noise + half.slice(0, 40));
  ok(t.read().length === 0, 'a line still being written waits');
  fs.appendFileSync(file, half.slice(40));
  got = t.read();
  ok(got.length === 1 && got[0].text === 'second' && got[0].queued, 'and is read once complete');

  // a tail started on an existing transcript (server restart) skips what is older than `since`
  const t2 = new PeerTail(file, { since: Date.parse('2026-11-03T00:00:00Z') });
  got = t2.read();
  ok(got.length === 1 && got[0].text === 'first', 'since: older messages are skipped on the first read');
  fs.appendFileSync(file, line(busy('third', 'm3', '2026-10-01T00:00:00Z')));
  ok(t2.read().length === 1, 'later reads take everything appended');
  // the first read only looks at the end of a long transcript, starting at a line boundary
  const t3 = new PeerTail(file, { window: half.length + 10 });
  got = t3.read();
  ok(got.length === 1 && got[0].text === 'third', 'window: only the end of the file, from a whole line');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
