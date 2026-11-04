// agent-notify.js: the wording of child -> parent notifications and how pending ones are coalesced.
import { noticeText, mergeNotice, NOTICE_HEAD, RESULT_CLIP } from '../src/agent-notify.js';

let fails = 0;
const ok = (cond, m) => { console.log((cond ? 'PASS ' : 'FAIL ') + m); if (!cond) fails++; };

const one = noticeText([{ childId: 'k1', name: 'Kid', outcome: 'finished', result: 'all done', turns: 1 }]);
ok(one.startsWith(NOTICE_HEAD) && /not from the user/.test(one), 'marked automatic');
ok(one.includes('Agent k1 "Kid" finished its turn.') && one.includes('all done'), 'names the child, outcome and result');
ok(!one.includes('more chars'), 'a short result is not clipped');

const long = noticeText([{ childId: 'k1', name: 'Kid', outcome: 'finished', result: 'x'.repeat(RESULT_CLIP + 321), turns: 1 }]);
ok(long.includes('[321 more chars; read_agent agent_id=k1 result=true returns all of it]') && !long.includes('x'.repeat(RESULT_CLIP + 1)), 'a long result is clipped with the read_agent hint');

ok(/ERROR/.test(noticeText([{ childId: 'k', name: 'n', outcome: 'error', result: 'boom', turns: 1 }])), 'error outcome');
ok(/stopped before finishing/.test(noticeText([{ childId: 'k', name: 'n', outcome: 'stopped', turns: 1 }])), 'stopped outcome');
const b = noticeText([{ childId: 'k', name: 'n', outcome: 'blocked', blocked: [{ text: 'Bash(rm:*)', question: false }, { text: 'Which db?', question: true }] }]);
ok(/BLOCKED/.test(b) && b.includes("approval of Bash(rm:*)") && b.includes('a question for the user: Which db?'), 'blocked outcome lists approvals and questions');

// coalescing
const p = new Map();
mergeNotice(p, { childId: 'a', name: 'A', outcome: 'finished', result: 'r1' });
mergeNotice(p, { childId: 'b', name: 'B', outcome: 'finished', result: 'rb' });
mergeNotice(p, { childId: 'a', name: 'A', outcome: 'finished', result: 'r2' });
ok(p.size === 2 && p.get('a').result === 'r2' && p.get('a').turns === 2, 'a later turn of the same child replaces the earlier one and counts turns');
ok([...p.keys()].join() === 'b,a', 'ordered by newest news');
const many = noticeText([...p.values()]);
ok(many.includes('2 agents you started have news') && /^- Agent b /m.test(many) && /^- Agent a /m.test(many) && many.includes('2 turns since the last notification'), 'one message, one bullet per child');
mergeNotice(p, { childId: 'a', name: 'A', outcome: 'blocked', blocked: [{ text: 'Edit', question: false }] });
ok(p.get('a').result === 'r2' && p.get('a').blockedNow && /now BLOCKED/.test(noticeText([p.get('a')])), 'a block after a pending finished turn is added to it');
const q = new Map();
mergeNotice(q, { childId: 'c', name: 'C', outcome: 'blocked', blocked: [] });
mergeNotice(q, { childId: 'c', name: 'C', outcome: 'finished', result: 'ok' });
ok(q.get('c').outcome === 'finished' && q.get('c').turns === 1, 'a finished turn replaces a pending block notice');

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
