// Demo stand-in for claude's stream-json mode (bin/make-screenshots.mjs, bin/make-demos.mjs). Two modes:
// - default: answers each stdin line at once with a finished turn (a short text, three tool calls, a markdown answer)
// - DEMO_SCENES=1 (the animated demos): paced, scripted turns. The swarm chat (conductor) really starts three agents through
//   the swarm MCP server from its --mcp-config; the "checkout API" worker asks for an approval through the same server's
//   approve tool (the card in the UI) and waits for the answer. Nothing here talks to a real model.
import readline from 'node:readline'; import fs from 'node:fs'; import { spawn } from 'node:child_process'; import crypto from 'node:crypto';
const SCENES = process.env.DEMO_SCENES === '1';
const sid = SCENES ? crypto.randomUUID() : '11111111-2222-4333-8444-555555555555';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pace = 1; const w = (ms) => sleep(ms * pace); // per scene: the API worker is quick, the other two take longer
// the folder as the swarm named it (macOS resolves /tmp to /private/tmp)
const CWD = process.cwd().replace(/^\/private\/tmp\//, '/tmp/');
const usage = { input_tokens: 12, output_tokens: 420, cache_read_input_tokens: 15800, cache_creation_input_tokens: 3400 };
const model = 'claude-sonnet-4-5';
let n = 0, t = 0;
out({ type: 'system', subtype: 'init', session_id: sid, model, cwd: CWD, tools: [] });
const m = (content) => out({ type: 'assistant', session_id: sid, message: { id: 'msg_' + (++n), role: 'assistant', model, content, usage } });
const r = (id, text) => out({ type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const done = (turns) => out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', num_turns: turns, session_id: sid, total_cost_usd: 0.04, usage });
const text = (s) => m([{ type: 'text', text: s }]);
const tool = (name, input) => { const id = 'toolu_' + (++t); m([{ type: 'tool_use', id, name, input }]); return id; };

// the swarm MCP server from --mcp-config, started on first use (the same server the real CLI would talk to)
let mcp, mcpId = 10; const waiting = new Map();
function swarm(name, args) {
  if (!mcp) {
    const a = process.argv.indexOf('--mcp-config'), raw = process.argv[a + 1];
    const cfg = JSON.parse(raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8')).mcpServers.swarm;
    mcp = spawn(cfg.command, cfg.args || [], { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'ignore'] });
    readline.createInterface({ input: mcp.stdout }).on('line', (l) => { try { const j = JSON.parse(l); waiting.get(j.id)?.(j); } catch {} });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  }
  const id = ++mcpId;
  return new Promise((res) => {
    waiting.set(id, (j) => res(j.result?.content?.[0]?.text || ''));
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

const P = '/tmp/demo-projects';
const JOBS = [
  { name: 'checkout API', cwd: P + '/api-server', prompt: 'Add a POST /checkout endpoint to the API server: validate the cart, create the order, return its id. Add tests.' },
  { name: 'checkout page', cwd: P + '/web-shop', prompt: 'Build the checkout page in the web shop: address form, order summary and a Pay button that calls POST /checkout.' },
  { name: 'checkout docs', cwd: P + '/docs-site', prompt: 'Document the new checkout flow in the docs site: a guide page and the POST /checkout API reference.' },
];
const todos = (items, k) => tool('TodoWrite', { todos: items.map((c, i) => ({ content: c, activeForm: c, status: i < k ? 'completed' : i === k ? 'in_progress' : 'pending' })) });

async function conductor() {
  await sleep(600);
  text("That splits cleanly into three jobs, one per repo. I'll start an agent for each so they run in parallel:");
  await sleep(500);
  for (const j of JOBS) {
    const id = tool('mcp__swarm__start_agent', j);
    const res = await swarm('start_agent', j);
    await sleep(200); r(id, res || 'started'); await sleep(400);
  }
  text('Started **3 agents**:\n\n- **checkout API** in `api-server`: the endpoint and its tests\n- **checkout page** in `web-shop`: the form and the Pay button\n- **checkout docs** in `docs-site`: guide and API reference\n\nI\'ll check on them as they finish. Anything they need approved shows up in their chat and under Approvals.');
  done(4);
}

async function api() {
  pace = 0.7;
  const steps = ['Read the cart routes', 'Add POST /checkout', 'Install zod', 'Run the tests'];
  await w(700); text("I'll read how the cart routes are set up first.");
  await w(500); let id = todos(steps, 0);
  await w(500); r(id, 'Todos updated');
  id = tool('Read', { file_path: CWD + '/src/routes/cart.js' }); await w(700); r(id, "router.get('/cart', ...)\nrouter.post('/cart/items', ...)");
  await w(600); id = todos(steps, 1); r(id, 'Todos updated');
  await w(400); id = tool('Write', { file_path: CWD + '/src/routes/checkout.js', content: "import { z } from 'zod';\n\nconst Cart = z.object({ items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1) });\n\nrouter.post('/checkout', async (req, res) => {\n  const cart = Cart.parse(req.body);\n  const order = await orders.create(cart);\n  res.status(201).json({ id: order.id });\n});\n" });
  await w(800); r(id, 'File created successfully.');
  await w(500); id = todos(steps, 2); r(id, 'Todos updated');
  await w(400); text('The validation uses `zod`, which is not installed yet.');
  await w(400);
  const input = { command: 'npm install zod', description: 'Install zod for request validation' };
  id = tool('Bash', input);
  const decision = await swarm('approve', { tool_name: 'Bash', input, tool_use_id: id });
  if (!/"allow"/.test(decision)) { r(id, 'The user denied this.'); await w(400); text('OK, I left `zod` out. Want me to validate by hand instead?'); return done(3); }
  await w(900); r(id, 'added 1 package in 1s');
  await w(300); id = todos(steps, 3); r(id, 'Todos updated');
  await w(300); id = tool('Bash', { command: 'npm test', description: 'Run the tests' }); await w(1100); r(id, '14 passing (1.4s)');
  await w(300); id = todos(steps, 4); r(id, 'Todos updated');
  await w(400);
  text('Done. `POST /checkout` validates the cart and returns the new order id:\n\n```js\nrouter.post(\'/checkout\', async (req, res) => {\n  const cart = Cart.parse(req.body);\n  const order = await orders.create(cart);\n  res.status(201).json({ id: order.id });\n});\n```\n\nAll **14 tests** pass, including two new ones for an empty cart and a bad quantity.');
  done(7);
}

async function page() {
  pace = 1.6;
  const steps = ['Find the cart page', 'Build the checkout form', 'Wire up the Pay button', 'Build'];
  await w(1100); text("Let me look at how the shop's pages are organised.");
  await w(500); let id = todos(steps, 0); r(id, 'Todos updated');
  await w(400); id = tool('Glob', { pattern: 'src/pages/**/*.tsx' }); await w(900); r(id, 'src/pages/Cart.tsx\nsrc/pages/Home.tsx\nsrc/pages/Product.tsx');
  await w(500); id = tool('Read', { file_path: CWD + '/src/pages/Cart.tsx' }); await w(900); r(id, 'export function Cart() { ... }');
  await w(500); id = todos(steps, 1); r(id, 'Todos updated');
  await w(500); id = tool('Write', { file_path: CWD + '/src/pages/Checkout.tsx', content: 'export function Checkout() { ... }' }); await w(1400); r(id, 'File created successfully.');
  await w(500); id = todos(steps, 2); r(id, 'Todos updated');
  await w(500); id = tool('Edit', { file_path: CWD + '/src/pages/Checkout.tsx', old_string: 'onPay={todo}', new_string: "onPay={() => api.post('/checkout', cart)}" }); await w(1200); r(id, 'The file has been updated.');
  await w(400); id = todos(steps, 3); r(id, 'Todos updated');
  await w(400); id = tool('Bash', { command: 'npm run build', description: 'Build the shop' }); await w(1800); r(id, 'built in 2.1s');
  await w(300); id = todos(steps, 4); r(id, 'Todos updated');
  await w(300); text('Done. The checkout page has the address form, the order summary and a **Pay** button that posts to `/checkout`. The build passes.');
  done(8);
}

async function docs() {
  pace = 1.7;
  await w(1500); text("I'll see how the existing guides are written.");
  await w(600); let id = tool('Read', { file_path: CWD + '/docs/guides/cart.md' }); await w(1000); r(id, '# The cart\n...');
  await w(900); id = tool('Write', { file_path: CWD + '/docs/guides/checkout.md', content: '# Checkout\n...' }); await w(1600); r(id, 'File created successfully.');
  await w(900); id = tool('Write', { file_path: CWD + '/docs/api/checkout.md', content: '# POST /checkout\n...' }); await w(1500); r(id, 'File created successfully.');
  await w(700); text('Done. Added **docs/guides/checkout.md** and the **POST /checkout** reference, both linked from the sidebar.');
  done(4);
}

function instant() {
  text("I'll look at the project first.");
  let id = tool('Read', { file_path: CWD + '/server.js' }); r(id, "const port = 3000;\napp.listen(port);");
  id = tool('Edit', { file_path: CWD + '/server.js', old_string: 'const port = 3000;', new_string: 'const port = Number(process.env.PORT) || 3000;' }); r(id, 'The file has been updated.');
  id = tool('Bash', { command: 'npm test', description: 'Run the tests' }); r(id, '12 passing (1.2s)');
  text("Done. The server now reads its port from `PORT`:\n\n```js\nconst port = Number(process.env.PORT) || 3000;\n```\n\nAll **12 tests** pass. Next I'd suggest:\n\n- add a test for the `PORT` override\n- document it in the README");
  done(4);
}

const isConductor = process.argv.some((a) => a.includes('You are the conductor of the user'));
let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  queue = queue.then(async () => {
    if (/fake-wait/.test(line)) await sleep(600000);
    if (!SCENES) return instant();
    if (isConductor) return conductor();
    if (/POST \/checkout endpoint/.test(line)) return api();
    if (/checkout page/.test(line)) return page();
    if (/checkout flow/.test(line)) return docs();
    return instant();
  });
});
