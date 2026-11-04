// The instructions the swarm gives an agent (spec.systemPrompt, see Agent.launchSpec in server.js), assembled from the
// agent's role and settings and from what its backend declares (backends/*.js), so each CLI is told only about tools
// and features it has. Claude's text is the reference wording (test/claude-launch-e2e.mjs records it exactly); the other
// CLIs get the same text with Claude's tool names made neutral, plus what they need instead: how the swarm's MCP tools
// are named for them, ask_user when they have no question tool of their own, submit_plan in plan mode when they have no
// plan approval of their own. How the text reaches the CLI is the backend's business (an appended system prompt, an
// instructions file, or a preamble on a session's first message: backends/acp.js).

// every agent except the conductor (prompts/conductor.md covers both for it). Claude Code's own prompt pushes its
// built-in Agent tool, so without this agents drift to invisible subagents in long sessions.
const SWARM_PROMPT =
  `Delegating work: you run inside the user's agent swarm, a web UI where the user watches and steers every agent. ` +
  `To hand work to another agent, use the swarm tool mcp__swarm__start_agent, not the built-in Agent (Task) tool, whenever the work edits files, ` +
  `takes more than a few minutes, should run in parallel with other work, belongs in another folder, or is something the user may want to follow, message or continue later. ` +
  `Swarm agents appear in the UI, can be messaged (send_message), survive restarts, can work in their own git worktree (worktree=true) or a scratch folder (one_off=true), ` +
  `and their approvals reach the user; built-in subagents are invisible to the user and vanish with your turn. ` +
  `Give a swarm agent a self-contained prompt (it has none of your context), end your turn if you have nothing else to do: when its turn ends you are woken with an automatic "[agent notification]" message (not from the user) carrying its result, so don't poll; wait_for_agent (when you need the answer before continuing) and read_agent are optional. remove_agent it when its work is done and reported. ` +
  `<<BUILTIN>>` +
  `If unsure, use start_agent. This holds for the whole session, however long it gets.\n\n` +
  `Schedules: with the swarm tools list_schedules, add_schedule, update_schedule, delete_schedule and run_schedule_now you can set up recurring work ` +
  `when the user asks for it (each run starts a new agent with the schedule's prompt). You can list every schedule but only change, delete or run the ones you added.`;

// the built-in subagent tool: allowed for quick lookups, or turned off (Settings → Agent defaults)
const swarmPrompt = (builtin) => SWARM_PROMPT.replace('<<BUILTIN>>', builtin
  ? 'Use the built-in Agent tool only for a quick read-only lookup whose answer you need in this turn (searching code, reading docs). '
  : 'Built-in subagents are turned off in this swarm: do quick lookups yourself, and delegate everything else with start_agent. ');

// every agent: their context is re-sent on every turn. The subagent sentence only where built-in subagents may be used
// (it used to be there for everyone, contradicting "built-in subagents are turned off" and the conductor's rules).
const contextPrompt = (builtin) =>
  `Keeping your context small: everything in this conversation is re-sent on every turn, so a long session gets slow and expensive. ` +
  (builtin ? `Delegate broad read-only searches and exploration across many files to a quick built-in subagent and keep only its conclusions (real work goes to swarm agents, see above). ` : '') +
  `Read big files in parts (offset/limit) or grep for what you need instead of reading them whole. ` +
  `Never dump huge command output: filter it with grep, head or tail, use quiet flags, or write it to a file and look at the part you need. ` +
  `Keep final answers concise: what you did, the result, and anything that needs the user.`;

export const tmpPrompt = (dir) =>
  `Scratch space: your private temp directory is ${dir} (TMPDIR, TMP and TEMP point to it). ` +
  `Put scratch files, throwaway scripts, git clones and git worktrees there, not in /tmp or elsewhere on the system. ` +
  `It is deleted when this agent is removed, so never keep anything there that must outlive the agent.`;

// CLIs other than Claude see the swarm's MCP tools under names of their own (swarm_start_agent, mcp_swarm_start_agent,
// start_agent): the text names them plainly, and this says how to find them
const TOOL_NAMES_PROMPT = `Tool names: the swarm tools named here (start_agent, send_message, read_agent, ...) are the tools of the MCP server "swarm"; ` +
  `your CLI may list them with a prefix (e.g. swarm_start_agent). They are allowed without asking.`;
// a CLI without a question tool that reaches the swarm (capabilities.questions false): the swarm's own (swarm-mcp.js ask_user)
const QUESTIONS_PROMPT = `Questions: your CLI's own question tool does not work here. When you need the user to choose or decide before you can go on, ` +
  `or are asked to ask them something, call the swarm tool mcp__swarm__ask_user: it shows a question card in the swarm UI, notifies the user, waits and returns the answers. ` +
  `Don't ask such questions in plain text.`;
// plan mode on CLIs with no plan approval of their own over ACP (backend.leavePlan: OpenCode)
// (checked live with OpenCode 2.2: a one-line version was ignored and the plan written as the reply)
const PLAN_PROMPT = `Plan mode: you are in plan mode, and the user approves plans in the swarm UI, not in this chat. ` +
  `When your plan is ready, do not write it as your reply: call the swarm tool mcp__swarm__submit_plan with the whole plan (Markdown). ` +
  `That shows it to the user and waits for the decision. Approved: end your turn; you are switched out of plan mode and the next message tells you to implement it. ` +
  `Rejected: revise the plan with the feedback and submit it again.`;

// the swarm's own question tool (ask_user) and plan tool (submit_plan): which agents get them (swarm-mcp.js lists them)
export const swarmAsks = (be) => !be.capabilities.questions;
export const swarmPlans = (be, permissionMode) => !!be.leavePlan && permissionMode === 'plan';

// Claude names MCP tools mcp__<server>__<tool> and its subagent tool Agent (Task); other CLIs get neutral words
const claudeNames = (be) => be.id === 'claude';
export const neutralToolNames = (be, text) => (claudeNames(be) ? text : text
  .replace(/mcp__swarm__\*/g, "the swarm MCP server's tools").replace(/mcp__swarm__/g, '')
  .replace(/mcp__browser__browser_\*/g, 'browser_*').replace(/mcp__browser__/g, '')
  .replace(/the built-in Agent \(Task\) tool/g, "your CLI's built-in subagent tool")
  .replace(/the built-in Agent tool/g, 'your built-in subagent tool')
  .replace(/the built-in Agent\/Task tool/g, "your CLI's built-in subagent tool")
  .replace(/with the Edit and Write tools/g, 'with your file edit and write tools'));

// be: the agent's backend descriptor. o: { role, builtinSubagents, permissionMode, conductor (its prompt text), bot,
// rooms, tmpDir, browser } (bot, rooms and browser: their prompts, or empty)
export function systemPrompt(be, o) {
  const conductor = o.role === 'conductor', builtin = !conductor && !!o.builtinSubagents;
  return neutralToolNames(be, [
    conductor ? o.conductor : swarmPrompt(builtin),
    !claudeNames(be) && TOOL_NAMES_PROMPT,
    o.bot,
    swarmAsks(be) && QUESTIONS_PROMPT,
    swarmPlans(be, o.permissionMode) && PLAN_PROMPT,
    o.rooms,
    tmpPrompt(o.tmpDir),
    contextPrompt(builtin),
    o.browser,
  ].filter(Boolean).join('\n\n'));
}

// how the instructions are put in front of a session's first message, for CLIs that can't add to their system prompt
export const preamble = (text) =>
  `<swarm-instructions>\nStanding instructions from the swarm that runs you, in place of a system prompt: follow them for the whole session. ` +
  `The message to answer follows the closing tag.\n\n${text}\n</swarm-instructions>\n\n`;
