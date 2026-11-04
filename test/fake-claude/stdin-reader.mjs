// The fake CLI's event-driven mode (FAKE_CLAUDE_NODE=1): reads stdin with node's own stream, i.e. through kqueue/epoll
// like the real claude, unlike the shell `read` loop, so it sees the same FIFO behaviour. Prints an init line and a
// result per input line; the result says how many bytes the line had. Appends its pid to $FAKE_CLAUDE_PIDLOG.
// A line containing fake-close-stdin answers, then closes stdin and stays alive (a process that can no longer read);
// fake-mute reads the line and prints nothing (a turn that never starts).
import fs from 'node:fs';
import readline from 'node:readline';

if (process.env.FAKE_CLAUDE_PIDLOG) fs.appendFileSync(process.env.FAKE_CLAUDE_PIDLOG, process.pid + '\n');
const session_id = '00000000-0000-4000-8000-000000000000';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.includes('fake-mute')) return;
  out({ type: 'system', subtype: 'init', session_id });
  out({ type: 'result', subtype: 'success', is_error: false, result: `fake turn (${Buffer.byteLength(line)} bytes)`, num_turns: 1, session_id, total_cost_usd: 0 });
  if (line.includes('fake-close-stdin')) { rl.close(); process.stdin.on('error', () => {}).pause(); fs.closeSync(0); setInterval(() => {}, 60_000); }
});
