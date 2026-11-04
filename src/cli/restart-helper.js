// Restart helper for Settings → Restart server (and `swarm-restart` in a swarm terminal).
// server.js starts it with spawn(..., { detached: true }), i.e. in its own session (setsid), so it outlives the server
// and the server's terminals. It waits for the old server to exit, then starts it again with the same node, arguments,
// working directory and environment, and exits after a few seconds; the new server keeps writing to the same log file.
// mode 'exit' means a supervisor (npm run dev, pm2, systemd, launchd) should restart it: then the helper only starts
// the server itself if nothing is listening on the port 20 s after the old one exited, so a restart never leaves it down.
//   node src/cli/restart-helper.js <old pid> <spawn|exit> <host> <port> <node args…>
import net from 'node:net';
import { spawn } from 'node:child_process';

const [pid, mode, host, port, ...args] = process.argv.slice(2);
const log = (s) => console.log(`[restart ${new Date().toISOString()}] ${s}`);
const alive = () => { try { process.kill(+pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listening = () => new Promise((r) => {
  const s = net.connect(+port, host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host);
  s.setTimeout(1000);
  s.on('connect', () => { s.destroy(); r(true); }).on('error', () => r(false)).on('timeout', () => { s.destroy(); r(false); });
});

async function waitExit(ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (!alive()) return true;
  return !alive();
}

log(`waiting for server pid ${pid} to exit (${mode})`);
if (!(await waitExit(15000))) {
  log('still running after 15 s, sending SIGTERM');
  try { process.kill(+pid, 'SIGTERM'); } catch {}
  if (!(await waitExit(10000))) { log('old server did not exit; not starting a second one'); process.exit(1); }
}
if (mode === 'exit') {
  for (const end = Date.now() + 20000; Date.now() < end; await sleep(500))
    if (await listening()) { log(`port ${port} is served again (restarted by its supervisor); nothing to do`); process.exit(0); }
  log(`nothing listens on port ${port} after 20 s, starting the server myself`);
}
const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
log(`started ${process.execPath} ${args.join(' ')} (pid ${child.pid}) in ${process.cwd()}`);
// stay a few seconds: the new server looks at its parent at startup to tell a launchd/systemd service from this,
// and an early crash (port still taken, syntax error) is worth a line in the log
const timer = setTimeout(() => { log('new server is up'); process.exit(0); }, 5000);
child.on('exit', (code, sig) => { clearTimeout(timer); log(`new server exited at once (${sig || code}); see above`); process.exit(1); });
