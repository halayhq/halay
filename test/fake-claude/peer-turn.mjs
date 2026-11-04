// Fake claude (test/fake-claude/claude), for a stdin line containing fake-peer: what the real CLI does when other Claude
// sessions message this one (peer-messages.js). It answers the line with a finished turn, then, as the real CLI does:
//   1. a peer message arrives while idle: written to the transcript as a meta user message with origin.kind "peer", and
//      on stdout only {"type":"command_lifecycle","state":"started"} before the turn it starts
//   2. mid-turn, a second peer message: written as a queued_command attachment, nothing on stdout
//   3. the agent replies with SendMessage to the first sender's address, then ends the turn
// The transcript is <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd, non-alphanumerics as '-'>/<session>.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SID = '00000000-0000-4000-8000-000000000000';
const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, SID + '.jsonl');
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (e) => fs.appendFileSync(file, JSON.stringify({ sessionId: SID, timestamp: now(), uuid: crypto.randomUUID(), isSidechain: false, ...e }) + '\n');
const out = (e) => process.stdout.write(JSON.stringify({ session_id: SID, ...e }) + '\n');
const wrap = (from, name, body) => `<cross-session-message from="${from}" from-name="${name}" from-mode="prompting">\n${body}\n</cross-session-message>`;
const origin = (from, name, body) => ({ kind: 'peer', from, verifiedPeerPid: 1, msg_id: crypto.randomUUID(), name, fromMode: 'prompting', body });
const A = 'uds:/tmp/cc-socks/31853.sock', B = 'uds:/tmp/cc-socks/47008.sock';
const assistant = (content) => { const message = { role: 'assistant', content }; log({ type: 'assistant', message }); out({ type: 'assistant', message }); };
const toolResult = (id, text) => { const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }; log({ type: 'user', message }); out({ type: 'user', message }); };
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0 });

const prompt = process.argv[2] || '';
let text = prompt; try { text = JSON.parse(prompt).message.content; } catch {}
log({ type: 'user', message: { role: 'user', content: text } });
result('fake turn');
await sleep(300);

// 1. while idle
const body1 = 'Please update the **site** and reply with a summary.';
const uuid = crypto.randomUUID();
fs.appendFileSync(file, JSON.stringify({ type: 'user', isMeta: true, isSidechain: false, uuid, sessionId: SID, timestamp: now(), promptSource: 'system', turnOrigin: 'peer',
  message: { role: 'user', content: `Another Claude session sent a message:\n${wrap(A, 'wt-71', body1)}\n\nThis came from another Claude session.` }, origin: origin(A, 'wt-71', body1) }) + '\n');
out({ type: 'command_lifecycle', command_uuid: uuid, state: 'started', uuid: crypto.randomUUID() });
assistant([{ type: 'tool_use', id: 'toolu_peer_bash', name: 'Bash', input: { command: 'ls', description: 'List files' } }]);
await sleep(200);
toolResult('toolu_peer_bash', 'index.html');

// 2. mid-turn
const body2 = 'Also use the demo paths.';
log({ type: 'attachment', attachment: { type: 'queued_command', prompt: wrap(B, 'wt-26', body2), source_uuid: crypto.randomUUID(), delivery_id: crypto.randomUUID(), commandMode: 'prompt', origin: origin(B, 'wt-26', body2), isMeta: true } });
await sleep(200);

// 3. the reply
assistant([{ type: 'text', text: 'Replying to the other session with the summary now.' }, { type: 'tool_use', id: 'toolu_peer_send', name: 'SendMessage', input: { to: A, summary: 'site done', message: 'Done: the site is updated.\n\n- index.html' } }]);
toolResult('toolu_peer_send', 'Message sent.');
out({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed', uuid: crypto.randomUUID() });
result('Replied.');
