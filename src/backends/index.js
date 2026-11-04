// Registry of the coding-agent CLIs the swarm can run. An agent's backend is stored in
// agents.backend; NULL (every agent made before backends existed) means claude.
import { execFileSync, spawnSync } from 'node:child_process';
import { claude } from './claude.js';
import { opencode } from './opencode.js';
import { gemini } from './gemini.js';
import { cursor } from './cursor.js';
import { antigravity } from './antigravity.js';

export const BACKENDS = { claude, opencode, gemini, cursor, antigravity };
export const DEFAULT_BACKEND = 'claude';
export const backendOf = (id) => BACKENDS[id || DEFAULT_BACKEND] || null;

// can this server run the backend? Its CLI must be on PATH and, where the backend has a probe, speak the protocol
// (e.g. a cursor-agent from before its ACP mode does not). Checked when accounts are discovered (server start).
// -> { ok: true } | { ok: false, reason }
export function usable(b) {
  try { execFileSync('/bin/sh', ['-c', 'command -v "$0"', b.bin], { stdio: 'ignore', timeout: 5000 }); } catch { return { ok: false, reason: `\`${b.bin}\` is not on the server's PATH` }; }
  if (!b.probe) return { ok: true };
  // both streams, also when it exits 0: `agy acp --help` prints its help to stderr
  const r = spawnSync(b.bin, b.probe.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  return b.probe.expect.test(out) ? { ok: true } : { ok: false, reason: b.probe.tooOld || `this ${b.bin} does not support ACP` };
}
export const installed = (b) => usable(b).ok;
