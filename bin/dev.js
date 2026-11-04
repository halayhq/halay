// Dev runner (npm run dev, from the package folder): restarts src/server.js when it or a file it loads (src/git-tools.js,
// src/terminal.js, src/swarm-mcp.js, prompts/conductor.md; not src/pty-host.js, which outlives the server and is replaced
// once its terminals are closed) changes, and when the server exits with code 75 (Settings → Restart server under npm run dev).
// Watches the directory (not the files) so editors that replace files atomically are still noticed.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const WATCHED = new Set(['server.js', 'git-tools.js', 'terminal.js', 'swarm-mcp.js']);
let child, timer, restarting = false;

function start() {
  child = spawn(process.execPath, ['src/server.js'], { stdio: 'inherit', env: { ...process.env, DEV: '1', HALAY_DEV_PID: String(process.pid) } });
  child.on('exit', (code, sig) => {
    if (restarting || code === 75) { restarting = false; start(); }
    else if (!quitting) { console.log(`[dev] server exited (${sig || code}); waiting for changes`); child = null; }
  });
}

let quitting = false;
const onChange = (watched) => (_, file) => {
  if (watched && file && !watched.has(file)) return; // file can be null on some platforms: restart to be safe
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`[dev] ${file || 'a file'} changed, restarting`);
    if (child) { restarting = true; child.kill('SIGTERM'); } else start();
  }, 150);
};
fs.watch('src', onChange(WATCHED));
fs.watch('prompts', onChange(null));

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => { quitting = true; child?.kill('SIGTERM'); setTimeout(() => process.exit(0), 300); });

start();
