// Unit checks for stats.js parsers and the collector (no server): node test/stats-unit.mjs
import { parseVmStat, parseMeminfo, parseBattery, createStats, statsLine } from '../src/stats.js';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                                     6822.\nPages active:                                 352879.\nPages inactive:                               353425.\nPages speculative:                                91.\nPages purgeable:                                2054.\n';
ok(parseVmStat(vm, 24 * 1024 ** 3) === (6822 + 353425 + 91 + 2054) * 16384, 'vm_stat: free + inactive + speculative + purgeable pages');
ok(parseVmStat('garbage', 1e10) === null, 'vm_stat: garbage gives null');
ok(parseMeminfo('MemTotal: 100 kB\nMemAvailable:   2048 kB\n') === 2048 * 1024, '/proc/meminfo: MemAvailable');
const b = parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging; 1:00 remaining present: true");
ok(b.percent === 80 && b.ac && b.charging, 'pmset: AC and charging');
ok(parseBattery("Now drawing from 'AC Power'") === null, 'pmset: a desktop has no battery');

const s = createStats({ volumes: ['/', process.cwd()], intervalMs: 50 });
s.start();
await new Promise((r) => setTimeout(r, 400));
const g = s.get(); s.stop();
ok(g.cpu.percent >= 0 && g.cpu.percent <= 100 && g.cpu.cores > 0 && g.cpu.load.length === 3, 'collector: cpu percent, cores, loadavg');
ok(g.mem.usedGb + g.mem.availGb - g.mem.totalGb < 0.2 && g.mem.percent >= 0 && g.mem.percent <= 100, 'collector: ram used + available = total');
ok(g.disks.length >= 1 && new Set(g.disks.map((d) => d.path)).size === g.disks.length, 'collector: disks present, no duplicates');
ok(/^cpu \d+% .* · ram .* · disk /.test(statsLine(g)) && !statsLine(g).includes('\n'), 'statsLine: one compact line');
ok(statsLine(null) === 'stats unavailable', 'statsLine: missing stats');
process.exit(fails ? 1 : 0);
