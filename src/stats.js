// Host resource stats for this machine (CPU, RAM, disk, uptime, battery), sampled on an interval so a request never
// runs anything. Exposed as GET /api/stats and carried in the peer probe (peers.js → /api/instance) for list_peers.
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';

const GB = 1024 ** 3;
const run = (cmd, args) => new Promise((r) => execFile(cmd, args, { timeout: 5000 }, (e, out) => r(e ? '' : String(out))));
const cpuTimes = () => os.cpus().reduce((a, c) => { for (const k in c.times) a.total += c.times[k]; a.idle += c.times.idle; return a; }, { idle: 0, total: 0 });

// available memory: what can be handed out without swapping. os.freemem() is only the free list, which macOS keeps tiny.
export function parseVmStat(text, total) {
  const page = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!page) return null;
  const n = (k) => Number(text.match(new RegExp(`^Pages ${k}:\\s+(\\d+)`, 'm'))?.[1] || 0);
  const avail = (n('free') + n('inactive') + n('speculative') + n('purgeable')) * page;
  return avail > 0 && avail <= total ? avail : null;
}
export function parseMeminfo(text) {
  const kb = text.match(/^MemAvailable:\s+(\d+) kB/m)?.[1];
  return kb ? Number(kb) * 1024 : null;
}
export function parseBattery(text) {
  const pct = text.match(/(\d+)%/)?.[1];
  if (pct === undefined) return null;
  return { percent: Number(pct), charging: !/discharging/.test(text) && /charging|charged|finishing/.test(text), ac: /AC Power/.test(text) };
}

const disk = (label, p) => {
  try {
    const s = fs.statfsSync(p);
    return { path: p, label, totalGb: +(s.blocks * s.bsize / GB).toFixed(1), usedGb: +((s.blocks - s.bfree) * s.bsize / GB).toFixed(1), freeGb: +(s.bavail * s.bsize / GB).toFixed(1), dev: fs.statSync(p).dev };
  } catch { return null; }
};

export function createStats({ volumes = [], intervalMs = 5000 } = {}) {
  const cores = os.cpus().length, total = os.totalmem();
  let prev = cpuTimes(), cpu = 0, availMem = os.freemem(), battery = null, disks = [], timers = [];

  const sampleCpu = () => {
    const t = cpuTimes(), dt = t.total - prev.total;
    if (dt > 0) cpu = Math.round(100 * (1 - (t.idle - prev.idle) / dt));
    prev = t;
  };
  const sampleDisks = () => {
    const seen = new Set();
    disks = [['/', '/'], ...volumes.map((v) => [v, v])].map(([l, p]) => disk(l, p)).filter((d) => d && !seen.has(d.dev) && seen.add(d.dev));
  };
  const sampleMem = async () => {
    let a = null;
    if (process.platform === 'darwin') a = parseVmStat(await run('vm_stat', []), total);
    else if (process.platform === 'linux') { try { a = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')); } catch {} }
    availMem = a ?? os.freemem();
  };
  const sampleBattery = async () => { if (process.platform === 'darwin') battery = parseBattery(await run('pmset', ['-g', 'batt'])); };

  const start = () => {
    sampleDisks(); sampleMem(); sampleBattery();
    timers = [setInterval(sampleCpu, intervalMs), setInterval(sampleMem, 15_000), setInterval(sampleDisks, 60_000), setInterval(sampleBattery, 60_000)];
    for (const t of timers) t.unref();
  };
  const stop = () => timers.forEach(clearInterval);

  const get = () => {
    const load = os.loadavg();
    return {
      cpu: { percent: Math.min(100, Math.max(0, cpu)), cores, load: load.map((x) => +x.toFixed(2)) },
      mem: { totalGb: +(total / GB).toFixed(1), usedGb: +((total - availMem) / GB).toFixed(1), availGb: +(availMem / GB).toFixed(1), percent: Math.round(100 * (total - availMem) / total) },
      disks: disks.map(({ dev, ...d }) => ({ ...d, percent: Math.round(100 * d.usedGb / d.totalGb) })),
      uptimeS: Math.round(os.uptime()),
      ...(battery && { battery }),
      at: Date.now(),
    };
  };
  return { start, stop, get, sampleCpu, sampleMem, sampleDisks };
}

// one compact line: "cpu 12% (8 cores, load 1.2) · ram 9.1/16 GB (57%) · disk / 3.6 GB free · /Volumes/Data 799 GB free · battery 80% AC"
export function statsLine(s) {
  if (!s?.cpu) return 'stats unavailable';
  const gb = (x) => (x >= 100 ? Math.round(x) : x);
  return [
    `cpu ${s.cpu.percent}% (${s.cores ?? s.cpu.cores} cores, load ${s.cpu.load[0]})`,
    `ram ${s.mem.usedGb}/${s.mem.totalGb} GB (${s.mem.percent}%)`,
    ...s.disks.map((d) => `disk ${d.path} ${gb(d.freeGb)} GB free of ${gb(d.totalGb)} (${d.percent}% used)`),
    s.battery && `battery ${s.battery.percent}%${s.battery.ac ? ' AC' : ' on battery'}`,
  ].filter(Boolean).join(' · ');
}
