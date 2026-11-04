// Rooms: group chats between agents (and the user). A message that @mentions a member is delivered to that agent as a
// new turn (agent.send queues it if the agent is busy); unaddressed messages are only visible in the room and show up
// as context in the next turn an agent gets from it. Loop safety: a per-room budget of agent-triggered turns (reset by
// any user message), a per-agent rate limit, no self-mentions, and a paused state the user resumes.
import { slug } from './util.js';

export const DEFAULT_BUDGET = 20; // agent-triggered turns per room between user messages
export const DEFAULT_RATE = 6; // mentions one agent may send per minute in a room
const RECENT = 12; // messages of context in a delivered turn
const CLIP = 700; // characters per context message
const MAX_TEXT = 8000;

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n) + '…');

export function createRooms({ db, agents, broadcast, notify, onMessage = () => {} }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, goal TEXT, status TEXT NOT NULL DEFAULT 'active',
      budget INTEGER NOT NULL DEFAULT ${DEFAULT_BUDGET}, rate INTEGER NOT NULL DEFAULT ${DEFAULT_RATE}, used INTEGER NOT NULL DEFAULT 0,
      summary TEXT, done_by TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS room_members (room_id INTEGER NOT NULL, agent_id TEXT NOT NULL, added_at INTEGER, PRIMARY KEY (room_id, agent_id));
    CREATE TABLE IF NOT EXISTS room_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, sender TEXT NOT NULL, name TEXT, text TEXT NOT NULL,
      mentions TEXT, kind TEXT, ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS room_messages_room ON room_messages (room_id, id);
  `);
  const q = {
    all: db.prepare('SELECT * FROM rooms ORDER BY id'),
    get: db.prepare('SELECT * FROM rooms WHERE id=?'),
    ins: db.prepare('INSERT INTO rooms (name,goal,budget,rate,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'),
    upd: db.prepare('UPDATE rooms SET name=@name, goal=@goal, status=@status, budget=@budget, rate=@rate, used=@used, summary=@summary, done_by=@done_by, updated_at=@updated_at WHERE id=@id'),
    members: db.prepare('SELECT agent_id FROM room_members WHERE room_id=? ORDER BY added_at, agent_id'),
    addMember: db.prepare('INSERT OR IGNORE INTO room_members (room_id,agent_id,added_at) VALUES (?,?,?)'),
    delMember: db.prepare('DELETE FROM room_members WHERE room_id=? AND agent_id=?'),
    delMemberAll: db.prepare('DELETE FROM room_members WHERE agent_id=?'),
    roomsOf: db.prepare('SELECT room_id FROM room_members WHERE agent_id=?'),
    insMsg: db.prepare('INSERT INTO room_messages (room_id,sender,name,text,mentions,kind,ts) VALUES (?,?,?,?,?,?,?)'),
    msgs: db.prepare('SELECT * FROM (SELECT * FROM room_messages WHERE room_id=? ORDER BY id DESC LIMIT ?) ORDER BY id'), // the newest
    msgsAfter: db.prepare('SELECT * FROM room_messages WHERE room_id=? AND id>? ORDER BY id LIMIT ?'), // the next ones, for a poller
    lastMsg: db.prepare('SELECT * FROM room_messages WHERE room_id=? ORDER BY id DESC LIMIT 1'),
    countMsgs: db.prepare('SELECT COUNT(*) n FROM room_messages WHERE room_id=?'),
  };
  const sent = new Map(); // `${room}:${agent}` -> timestamps of recent mentions, for the per-agent rate limit

  // ---- members and handles
  const memberIds = (rid) => q.members.all(rid).map((r) => r.agent_id).filter((id) => agents.has(id));
  const handles = (ids) => { // @handle per member: slug of the name, with the id appended when two names collide
    const count = {}, base = ids.map((id) => agents.get(id).bot || slug(agents.get(id).name) || id); // a bot is addressed by its own handle
    for (const b of base) count[b] = (count[b] || 0) + 1;
    return new Map(ids.map((id, i) => [id, count[base[i]] > 1 ? `${base[i]}-${id}` : base[i]]));
  };
  const memberOut = (rid) => {
    const ids = memberIds(rid), h = handles(ids);
    // blocked: waiting on the user; question: (part of) that is a question to answer rather than an approval
    return ids.map((id) => { const p = agents.get(id).pendingApprovals(); return { id, name: agents.get(id).name, handle: h.get(id), status: agents.get(id).status, blocked: p.length > 0, question: p.some((x) => x.question) }; });
  };
  const msgOut = (m) => ({ id: m.id, roomId: m.room_id, sender: m.sender, name: m.name, text: m.text, mentions: JSON.parse(m.mentions || '[]'), kind: m.kind || null, ts: m.ts });
  const roomOut = (r) => ({
    id: r.id, name: r.name, goal: r.goal || '', status: r.status, budget: r.budget, rate: r.rate, used: r.used, summary: r.summary || '', doneBy: r.done_by || null,
    members: memberOut(r.id), messages: q.countMsgs.get(r.id).n, last: q.lastMsg.get(r.id) ? msgOut(q.lastMsg.get(r.id)) : null, updatedAt: r.updated_at,
  });
  const push = (r) => broadcast({ type: 'room', room: roomOut(r) });
  const save = (r, patch = {}) => { Object.assign(r, patch, { updated_at: Date.now() }); q.upd.run(r); return r; };

  function addMsg(r, sender, name, text, { mentions = [], kind = null } = {}) {
    const ts = Date.now();
    const id = q.insMsg.run(r.id, sender, name, text, JSON.stringify(mentions), kind, ts).lastInsertRowid;
    const m = msgOut({ id, room_id: r.id, sender, name, text, mentions: JSON.stringify(mentions), kind, ts });
    broadcast({ type: 'room_msg', roomId: r.id, message: m });
    save(r);
    push(r);
    onMessage(roomOut(r), m);
    return m;
  }
  const system = (r, text) => addMsg(r, 'system', 'Swarm', text, { kind: 'system' });

  // ---- what an agent receives when it is addressed
  function turnText(r, to, from, fromName, text) {
    const ids = memberIds(r.id), h = handles(ids);
    const members = ids.map((id) => `@${h.get(id)} (${agents.get(id).name}${id === to ? ', you' : ', ' + agents.get(id).status})`).join(', ');
    const recent = q.msgs.all(r.id, RECENT).filter((m) => m.kind !== 'system').map((m) => `- ${m.sender === 'user' ? 'user' : m.name}: ${clip(m.text.replace(/\s+/g, ' '), CLIP)}`).join('\n');
    return [
      `[Room "${r.name}" #${r.id}] You are @${h.get(to)}. ${fromName}${from === 'user' ? '' : ' (@' + (h.get(from) || slug(fromName)) + ')'} addressed you:`,
      '',
      text,
      '',
      r.goal ? `Room goal: ${r.goal}` : null,
      `Members: ${members}, and the user. Recent messages:`,
      recent,
      '',
      `Reply by calling the post_to_room tool (room_id ${r.id}); your normal reply is not seen by the room. @mention the member who should act next, or the user (@user) when you need them. ` +
        `Don't mention yourself or hand back work that is not needed. When the goal is met, call mark_room_done with a summary.`,
    ].filter((x) => x !== null).join('\n');
  }

  // ---- posting
  // Returns { error, code } or { message, delivered: [names], skipped: [reasons], unknown: [@x] }.
  function post(r, sender, text) {
    text = String(text ?? '').trim();
    if (!text) return { code: 400, error: 'text required' };
    if (text.length > MAX_TEXT) return { code: 400, error: `message too long (max ${MAX_TEXT} characters)` };
    const user = sender === 'user', agent = user ? null : agents.get(sender);
    if (!user && !agent) return { code: 404, error: 'unknown sender' };
    if (r.status === 'archived') return { code: 409, error: 'this room is archived' };
    if (!user) {
      if (r.status === 'paused') return { code: 409, error: `room is paused (its budget of ${r.budget} agent-triggered turns is used up); only the user can resume it` };
      if (r.status === 'done') return { code: 409, error: 'room is marked done; only the user can reopen it' };
    }
    const ids = memberIds(r.id), h = handles(ids), byHandle = new Map([...h].map(([id, hd]) => [hd, id]));
    const targets = new Set(), unknown = [];
    let toUser = false, all = false;
    for (const m of text.matchAll(/(?:^|[^\w@.-])@([a-z0-9][a-z0-9-]*)/gi)) {
      const t = m[1].toLowerCase().replace(/-+$/, '');
      if (t === 'user' || t === 'you') toUser = true;
      else if (t === 'all' || t === 'everyone') all = true;
      else if (byHandle.has(t)) targets.add(byHandle.get(t));
      else if (ids.includes(t)) targets.add(t);
      else unknown.push('@' + t);
    }
    if (!user && targets.has(sender)) return { code: 400, error: 'you mentioned yourself; address another member (or @user)' };
    if (!user && all) return { code: 400, error: '@all is for the user; address specific members' };
    if (all) for (const id of ids) targets.add(id);
    if (user && r.status !== 'active') { // a message from the user reopens a paused or finished room and resets the budget
      save(r, { status: 'active', used: 0, summary: r.status === 'done' ? '' : r.summary, done_by: null });
    } else if (user) save(r, { used: 0 });
    const m = addMsg(r, user ? 'user' : sender, user ? 'You' : agent.name, text, { mentions: [...targets] });
    if (toUser && !user) notify(agent, 'room', `room "${r.name}": ${clip(text.replace(/\s+/g, ' '), 120)}`);
    const delivered = [], skipped = [];
    let overBudget = false;
    for (const id of targets) {
      const a = agents.get(id);
      if (!user) {
        const key = `${r.id}:${sender}`, now = Date.now(), recent = (sent.get(key) || []).filter((t) => now - t < 60_000);
        if (r.used >= r.budget) { skipped.push(`${a.name}: room budget reached, the room is now paused`); overBudget = true; continue; }
        if (recent.length >= r.rate) { skipped.push(`${a.name}: you sent ${r.rate} mentions in the last minute (rate limit)`); continue; }
        recent.push(now); sent.set(key, recent);
        r.used++;
      }
      a.send(turnText(r, id, user ? 'user' : sender, user ? 'The user' : agent.name, text), { room: r.id });
      delivered.push(a.name);
    }
    if (overBudget) pause(r, agent);
    save(r);
    push(r);
    return { message: m, delivered, skipped, unknown: [...new Set(unknown)] };
  }

  // the budget counts agent-triggered turns; a mention beyond it is not delivered and pauses the room
  function pause(r, agent) {
    save(r, { status: 'paused' });
    system(r, `Paused: ${r.budget} agent-triggered turns used since the last message from the user. Agents' messages are no longer delivered. Post a message or press Resume to continue.`);
    notify(agent, 'room', `room "${r.name}" paused: budget of ${r.budget} agent turns reached`);
  }

  function markDone(r, by, summary) {
    if (r.status === 'archived') return { code: 409, error: 'this room is archived' };
    summary = String(summary ?? '').trim();
    if (!summary) return { code: 400, error: 'summary required' };
    const agent = by === 'user' ? null : agents.get(by);
    save(r, { status: 'done', summary, done_by: by });
    addMsg(r, 'system', 'Swarm', `Goal marked done by ${agent ? agent.name : 'you'}: ${summary}`, { kind: 'done' });
    if (agent) notify(agent, 'done', `room "${r.name}" is done: ${clip(summary.replace(/\s+/g, ' '), 140)}`);
    return { room: roomOut(r) };
  }

  // ---- create / edit
  function create({ name, goal, members, budget, rate }, createdBy) {
    name = String(name ?? '').trim();
    if (!name) return { code: 400, error: 'name required' };
    const ids = [...new Set(Array.isArray(members) ? members : [])];
    for (const id of ids) if (!agents.has(id)) return { code: 400, error: `no agent ${id}` };
    const b = budget === undefined ? DEFAULT_BUDGET : Math.floor(Number(budget)), rt = rate === undefined ? DEFAULT_RATE : Math.floor(Number(rate));
    if (!(b >= 1 && b <= 500)) return { code: 400, error: 'budget must be 1-500' };
    if (!(rt >= 1 && rt <= 60)) return { code: 400, error: 'rate must be 1-60' };
    const now = Date.now(), id = q.ins.run(name.slice(0, 80), String(goal ?? '').trim().slice(0, 2000), b, rt, createdBy, now, now).lastInsertRowid;
    for (const a of ids) q.addMember.run(id, a, now);
    const r = q.get.get(id);
    system(r, `Room created${ids.length ? ' with ' + ids.map((a) => agents.get(a).name).join(', ') : ''}.`);
    return { room: roomOut(r) };
  }

  function patch(r, body) {
    const p = {};
    if (body.name !== undefined) { const n = String(body.name).trim(); if (!n) return { code: 400, error: 'name required' }; p.name = n.slice(0, 80); }
    if (body.goal !== undefined) p.goal = String(body.goal).trim().slice(0, 2000);
    if (body.budget !== undefined) { const b = Math.floor(Number(body.budget)); if (!(b >= 1 && b <= 500)) return { code: 400, error: 'budget must be 1-500' }; p.budget = b; }
    if (body.rate !== undefined) { const b = Math.floor(Number(body.rate)); if (!(b >= 1 && b <= 60)) return { code: 400, error: 'rate must be 1-60' }; p.rate = b; }
    if (body.archived) p.status = 'archived';
    else if (body.archived === false || body.resume) {
      // an archived room stays shut until it is unarchived; a done room that is resumed is open again, like after a user message
      if (r.status === 'archived' && body.archived !== false) return { code: 409, error: 'this room is archived; unarchive it first' };
      p.used = 0; p.status = 'active';
      if (r.status === 'done') { p.summary = ''; p.done_by = null; }
    }
    save(r, p);
    if (body.resume) system(r, 'Resumed by the user; the budget starts over.');
    push(r);
    return { room: roomOut(r) };
  }

  function addMember(r, agentId) {
    const a = agents.get(agentId);
    if (!a) return { code: 404, error: `no agent ${agentId}` };
    if (q.members.all(r.id).some((m) => m.agent_id === agentId)) return { room: roomOut(r) };
    q.addMember.run(r.id, agentId, Date.now());
    system(r, `${a.name} joined the room (@${handles(memberIds(r.id)).get(agentId)}).`);
    return { room: roomOut(r) };
  }
  function removeMember(r, agentId) {
    const a = agents.get(agentId);
    q.delMember.run(r.id, agentId);
    system(r, `${a ? a.name : agentId} left the room.`);
    return { room: roomOut(r) };
  }

  // an agent that is removed leaves all its rooms
  function agentRemoved(id) {
    const rs = q.roomsOf.all(id).map((x) => q.get.get(x.room_id)).filter(Boolean);
    const name = agents.get(id)?.name || id;
    q.delMemberAll.run(id);
    for (const r of rs) system(r, `${name} was removed from the swarm and left the room.`);
  }

  // appended to an agent's system prompt when it starts: the rooms it is in now
  function promptFor(agentId) {
    const rs = q.roomsOf.all(agentId).map((x) => q.get.get(x.room_id)).filter((r) => r && r.status !== 'archived');
    if (!rs.length) return ''; // agents added to a room later learn the rules from the turn they are addressed in
    const base =
      `Rooms: you can be a member of group chats with other agents and the user. A message from a room arrives as a normal turn starting "[Room …]" with the sender, the goal and recent messages. ` +
      `Your normal reply is not seen by the room: answer with the post_to_room tool and @mention the member who should act next (@handle, as listed in the message), or @user when you need the user. ` +
      `Unaddressed messages are not sent to anyone; you see them as context the next time you are addressed, or with read_room. You can't mention yourself. ` +
      `The room has a budget of agent-triggered turns and pauses when it is spent, so don't ping other agents without something for them to do. mark_room_done (summary) closes the goal and notifies the user.`;
    return base + ' You are in: ' + rs.map((r) => `"${r.name}" (#${r.id}${r.goal ? ', goal: ' + clip(r.goal, 150) : ''})`).join('; ') + '.';
  }

  // ---- REST. Agent callers (x-halay-agent set) are limited to the rooms they are in, and can't create or edit rooms,
  // except the conductor; the UI sends no such header.
  async function handle(req, url, res, { json, readBody }) {
    const m = url.pathname.match(/^\/api\/rooms(?:\/(\d+))?(?:\/([a-z]+))?(?:\/([^/]+))?$/);
    if (!m) return false;
    const caller = String(req.headers['x-halay-agent'] || '') || null;
    const callerAgent = caller && agents.get(caller);
    if (caller && !callerAgent) return json(res, 403, { error: 'unknown agent' }), true;
    const power = !caller || callerAgent.role === 'conductor'; // the user or the conductor
    const out = (r) => (r.error ? json(res, r.code, { error: r.error }) : json(res, r.code || 200, r.room || r));
    const [, rid, sub, arg] = m;
    if (!rid) {
      if (req.method === 'GET') {
        const own = power ? null : new Set(q.roomsOf.all(caller).map((x) => x.room_id));
        return json(res, 200, q.all.all().filter((r) => !own || own.has(r.id)).map(roomOut)), true;
      }
      if (req.method === 'POST') {
        if (!power) return json(res, 403, { error: 'only the user and the swarm chat create rooms' }), true;
        const r = create(await readBody(req), caller);
        return out(r.room ? { room: r.room, code: 201 } : r), true;
      }
      return false;
    }
    const r = q.get.get(Number(rid));
    if (!r) return json(res, 404, { error: 'no such room' }), true;
    if (!power && !q.members.all(r.id).some((x) => x.agent_id === caller)) return json(res, 403, { error: 'you are not in that room' }), true;
    const sender = caller || 'user';
    if (!sub && req.method === 'GET') {
      const after = Number(url.searchParams.get('after')) || 0, limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
      return json(res, 200, { ...roomOut(r), thread: (after ? q.msgsAfter.all(r.id, after, limit) : q.msgs.all(r.id, limit)).map(msgOut) }), true;
    }
    if (!sub && req.method === 'PATCH') return power ? (out(patch(r, await readBody(req))), true) : (json(res, 403, { error: 'not allowed' }), true);
    if (sub === 'messages' && req.method === 'POST') {
      const x = post(r, sender, (await readBody(req)).text);
      return out(x), true;
    }
    if (sub === 'done' && req.method === 'POST') return out(markDone(r, sender, (await readBody(req)).summary)), true;
    if (sub === 'resume' && req.method === 'POST') return power ? (out(patch(r, { resume: true })), true) : (json(res, 403, { error: 'only the user resumes a room' }), true);
    if (sub === 'members') {
      if (!power) return json(res, 403, { error: 'not allowed' }), true;
      if (req.method === 'POST') return out(addMember(r, (await readBody(req)).agentId)), true;
      if (req.method === 'DELETE' && arg) return out(removeMember(r, decodeURIComponent(arg))), true;
    }
    return false;
  }

  return {
    handle, agentRemoved, promptFor, list: () => q.all.all().map(roomOut), exists: (id) => !!q.get.get(id),
    join: (id, agentId) => { const r = q.get.get(id); return r ? addMember(r, agentId) : { code: 404, error: 'no such room' }; },
    leave: (id, agentId) => { const r = q.get.get(id); return r ? removeMember(r, agentId) : { code: 404, error: 'no such room' }; },
  };
}
