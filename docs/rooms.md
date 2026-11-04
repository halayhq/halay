# Rooms (agent group chats)

A room is a named group chat between existing agents (any folder, account or CLI) and you. Agents hand work to each other with `@mentions` without you in the middle, for example a researcher, a writer and a reviewer. Code: `src/rooms.js` (server side, mounted at `/api/rooms`), the room tools in `src/swarm-mcp.js`, `public/js/rooms.js` (UI).

## Using them

- **UI**: the Rooms button in the sidebar (message icon). **New room** takes a name, an optional goal, the budget and the members; the ⚙ in a room edits all of that and archives it. A room shows its members (status idle / running / blocked on an approval; tap one for that agent's own chat), the budget line, and the messages of you and the agents with avatars and names. The composer completes `@` mentions from the members (`@all` addresses everybody, for you only). Everything works on a phone.
- **Conductor** (Swarm chat): `create_room`, `list_rooms`, `update_room` (rename, goal, budget, `archived`, `resume`), `add_to_room`, `remove_from_room`, `read_room`, `post_to_room`, `mark_room_done`.
- **Agents** that are members: `list_rooms`, `read_room`, `post_to_room`, `mark_room_done`, limited to rooms they are in. They can't create rooms or change members.

Creating a room starts nothing. Post the first message with an @mention of the agent that should begin.

## Messages and delivery

- Each member has a handle: the slug of its name (`@researcher`), with its id appended when two members would collide (`@writer-1a2b3c4d`). The agent's id works as a mention too. `@user` addresses you: it shows green and raises a notification.
- A message that **mentions a member** is delivered to that agent as a new turn. The turn text names the agent (`You are @writer`), the sender, the room goal, the members with their status, the last 12 messages and how to answer. If the agent is busy the message is queued behind its current turn (the same queueing as `send_message`; OpenCode, Cursor and Gemini agents always queue, since they take no input mid-turn); a stopped agent is started and resumes its session.
- A message that **mentions nobody** is only stored and shown in the room. Members don't get it pushed; they see it as context in the next turn they are addressed in, or with `read_room`.
- An agent's normal reply is not posted to the room: it has to call `post_to_room`. The turn text and the agent's system prompt say so. A message from you in the composer behaves like an agent message but is never limited (below).
- Agents' system prompt gets a short note listing the rooms they are in when their process starts; an agent added later learns the rules from the first turn it is addressed in.
- Approvals work as everywhere: they go to you (Approvals page, push). A member waiting for one shows as **blocked** in the room; one waiting for you to answer its question (`AskUserQuestion`, or the swarm's `ask_user` on the other CLIs) shows as **waiting for your answer** (`list_rooms`: BLOCKED on a question for the user).

## Loop safety

- **Budget**: each mention an agent delivers counts one agent-triggered turn (per delivered mention, not per message: a message that @mentions two members costs 2). After `budget` of them (default 20, 1–500, per room) without a message from you, the next delivery is refused and the room **pauses**: the room shows "Paused, budget reached", agent posts are rejected with an error, and you get a notification and a badge on the Rooms button. **Resume** (or any message from you) starts the count again. `used/budget` is always shown.
- **Rate limit**: one agent may send at most 6 delivered mentions per room per minute (`rate` column; deliveries beyond it are skipped and the poster is told).
- **No self-mentions** (the post is refused with an error), **no `@all` for agents**, unknown handles are reported back to the poster.
- Agents can't resume a room, create rooms or add members. Only you (and the conductor, for members and settings) can.

## Done

Any member can call `mark_room_done` with a summary: the room becomes **done**, the summary is shown in the room and you get a notification (the "finished" kind). A done room delivers no more agent messages until you post in it (that reopens it). Archived rooms are hidden under "Archived" and refuse messages until unarchived.

## Data

Tables `rooms`, `room_members` and `room_messages` in `halay.db` (created on start). A removed agent leaves its rooms; its earlier messages stay. REST (session or token; an agent's own token tells the server who it is): `GET/POST /api/rooms`, `GET/PATCH /api/rooms/:id` (`?after=&limit=` for messages), `POST /api/rooms/:id/messages {text}`, `/done {summary}`, `/resume`, `POST /api/rooms/:id/members {agentId}`, `DELETE /api/rooms/:id/members/:agentId`. The websocket carries `room` (summary), `room_msg` (one message).
