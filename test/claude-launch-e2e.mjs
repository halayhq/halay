// Golden test of exactly how claude is launched and fed: argv, the relevant environment and the stdin lines, for a set
// of agent configurations (plain, manual + model + effort + lean, cli mode, a resumed session after a mode change, the
// conductor, a bot). It guards the backend refactor: Claude's launch must not change.
//   node test/claude-launch-e2e.mjs            compare with test/fixtures/claude-launch.golden.json
//   UPDATE_GOLDEN=1 node test/claude-launch-e2e.mjs   rewrite the golden file (only on purpose, after reviewing the diff)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, startSpare, checker, waitFor, newAgent } from './lib/spare.mjs';

const GOLDEN = path.join(ROOT, 'test/fixtures/claude-launch.golden.json');
const ENV_KEYS = /^(TMPDIR|TMP|TEMP|CLAUDE_[A-Z_]+)=/; // what the server sets for the launch (HALAY_* would be this shell's own)
const c = checker();
// HALAY_BACKENDS=claude: other CLIs installed on this machine would add accounts to the conductor's prompt
const s = await startSpare({ tag: 'launch', env: { HALAY_TERMINAL: '0', HALAY_BACKENDS: 'claude' } });
const envLog = path.join(s.dir, 'env.log'), stdinLog = path.join(s.dir, 'stdin.log');
await s.restart({ FAKE_CLAUDE_ENVLOG: envLog, FAKE_CLAUDE_STDINLOG: stdinLog });

const ids = [];
const norm = (txt) => {
  let t = txt.replace(/swa\.([\w-]+)\.[\w-]{43}/g, '<AGENT_TOKEN:$1>').split(s.token).join('<TOKEN>').split(s.dir).join('<DIR>').split(fs.realpathSync(s.dir)).join('<DIR>')
    .split(ROOT).join('<ROOT>').split(process.execPath).join('<NODE>').split(os.homedir()).join('<HOME>').split(':' + s.port).join(':<PORT>');
  ids.forEach((id, i) => { t = t.split(id).join(`<ID${i}>`); });
  return t;
};
const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const tail = (f, from) => { try { return fs.readFileSync(f, 'utf8').slice(from); } catch { return ''; } };
const idle = (id) => waitFor(async () => { const a = (await s.api('/agents')).j.find((x) => x.id === id); return a && a.status === 'idle'; }, 10000);

// runs act(), waits for a new launch and the turn to finish; returns the normalized launch record
async function launch(label, act) {
  const marks = [size(s.claudeLog), size(envLog), size(stdinLog)];
  const id = await act();
  if (!ids.includes(id)) ids.push(id);
  await waitFor(() => size(s.claudeLog) > marks[0], 10000);
  const done = await idle(id);
  c.ok(!!done, `${label}: the turn finished`);
  // the server also runs claude for other things meanwhile (auth status, limits): only the agent's launch counts
  const args = (tail(s.claudeLog, marks[0]).split('\n---\n').find((r) => r.includes('\n--input-format\n')) || '').split('\n');
  // --mcp-config is a file only this user can read (it holds the token), never the JSON itself on the command line:
  // the record keeps its content, so the golden file still shows what the servers are
  const mi = args.indexOf('--mcp-config') + 1;
  if (mi > 0) {
    const f = args[mi];
    let mode = null; try { mode = fs.statSync(f).mode & 0o777; } catch {}
    c.ok(path.isAbsolute(f) && mode === 0o600 && !f.includes(s.token), `${label}: --mcp-config is a 0600 file, no token in argv (${f}, mode ${mode?.toString(8)})`);
    c.ok(!args.some((a) => a.includes(s.token)), `${label}: the token appears nowhere in claude's argv`);
    try { args[mi] = fs.readFileSync(f, 'utf8'); } catch {}
  }
  const envRec = tail(envLog, marks[1]).split('\n---\n').find((r) => r.includes(`TMPDIR=${path.join(s.dir, 'tmp', id)}\n`)) || '';
  const env = envRec.split('\n').filter((l) => ENV_KEYS.test(l)).sort();
  const stdin = tail(stdinLog, marks[2]).split('\n').filter(Boolean);
  return JSON.parse(norm(JSON.stringify({ args, env, stdin })));
}
const send = async (id, text) => { const r = await s.api(`/agents/${id}/send`, 'POST', { text }); if (r.status !== 200) throw new Error(r.text); return id; };

const got = {};
try {
  // the golden records were made with built-in subagents allowed (the swarm's default before that setting existed)
  c.ok((await s.api('/settings/agents', 'PUT', { builtinSubagents: true })).j.builtinSubagents === true, 'built-in subagents allowed for the golden records');
  let plain;
  got.plain = await launch('plain', async () => (plain = await newAgent(s, { name: 'plain', prompt: 'hello there' })));
  got.manual = await launch('manual+model+effort+lean', () => newAgent(s, { name: 'tuned', prompt: 'hi', permissionMode: 'manual', model: 'sonnet', effort: 'high', lean: true }));
  got.cli = await launch('cli mode', () => newAgent(s, { name: 'cli', prompt: 'hi', permissionMode: 'cli', lean: false }));
  got.resumed = await launch('resumed after a mode change', async () => {
    const r = await s.api(`/agents/${plain}/mode`, 'POST', { permissionMode: 'acceptEdits' });
    if (r.status !== 200) throw new Error(r.text);
    return send(plain, 'second message');
  });
  got.conductor = await launch('conductor', async () => send((await s.api('/conductor', 'POST', {})).j.id, 'what is running?'));
  got.bot = await launch('bot', async () => {
    const r = await s.api('/bots', 'POST', { name: 'Snap bot', handle: 'snapbot', role: 'You answer briefly.' });
    if (r.status >= 300) throw new Error(r.text);
    const id = await waitFor(async () => (await s.api('/agents')).j.find((a) => a.bot?.handle === 'snapbot')?.id, 5000);
    return send(id, 'hello bot');
  });

  // the default: no built-in subagents, so every agent gets the flag the conductor has, and the prompt says so
  await s.api('/settings/agents', 'PUT', { builtinSubagents: false });
  const off = await launch('swarm subagents only', () => newAgent(s, { name: 'swarm-only', prompt: 'hi' }));
  const i = off.args.indexOf('--disallowedTools');
  c.ok(i > 0 && off.args[i + 1] === 'Agent,Task', 'with built-in subagents off, claude gets --disallowedTools Agent,Task');
  const sp = off.args[off.args.indexOf('--append-system-prompt') + 1] || '';
  c.ok(/Built-in subagents are turned off/.test(sp) && !/Use the built-in Agent tool only/.test(sp), 'and its instructions say built-in subagents are off');
  let mcp = {};
  try { mcp = JSON.parse(off.args[off.args.indexOf('--mcp-config') + 1]); } catch {}
  c.ok(mcp.mcpServers?.swarm?.env?.HALAY_NO_BUILTIN === '1', "the swarm MCP server knows, for start_agent's description");
  const keys = (env) => env.map((l) => l.split('=')[0]).join();
  c.ok(keys(off.env) === keys(got.plain.env), 'its environment has the same variables');

  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + '\n');
    console.log('wrote ' + GOLDEN);
  } else {
    const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (const k of Object.keys(want)) {
      for (const part of ['args', 'env', 'stdin']) {
        const a = JSON.stringify(got[k]?.[part]), b = JSON.stringify(want[k][part]);
        c.ok(a === b, `${k}: ${part} unchanged`);
        if (a !== b) console.log(`  want ${b}\n  got  ${a}`);
      }
    }
  }
} catch (e) {
  c.ok(false, 'launch test crashed: ' + e.stack);
  console.log(s.log().slice(-3000));
} finally {
  await s.stop();
}
c.done();
