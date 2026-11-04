// Unit check of git-tools.js on a scratch repository (no server):
//   node test/git-tools-unit.mjs
// A big diff is returned truncated at the cap, and a merge whose conflict dry-run can't run (git merge-tree --write-tree
// missing, e.g. git < 2.38) is blocked instead of going ahead unchecked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addWorktree, review, merge, diff, DIFF_CAP } from '../src/git-tools.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-tools-unit-')));
const repo = path.join(scratch, 'repo'), wt = path.join(scratch, 'wt');
const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, stdio: 'pipe' }).toString();
fs.mkdirSync(repo);
g(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'init');
await addWorktree({ repoDir: repo, wtPath: wt, branch: 'feat' });
fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n'.repeat(DIFF_CAP)); g(wt, 'add', '.'); g(wt, 'commit', '-qm', 'big');

const d = await diff(wt, { mode: 'base', base: 'main' });
ok(d.truncated && d.diff.length <= DIFF_CAP + 1, 'a diff over the cap comes back truncated');
let rv = await review(wt, 'main');
ok(!rv.mergeCheckFailed && !rv.blockers.length, 'review with a working merge-tree has no blockers');

// a git without merge-tree --write-tree
const bin = path.join(scratch, 'bin'), realGit = execFileSync('which', ['git']).toString().trim();
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = merge-tree ]; then echo "error: unknown option 'write-tree'" >&2; exit 129; fi; done\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
const PATH = process.env.PATH; process.env.PATH = bin + ':' + PATH;
rv = await review(wt, 'main');
ok(rv.mergeCheckFailed && rv.blockers.some((b) => /dry-run the merge/.test(b)), 'a failed merge dry-run is a blocker');
let err = null;
try { await merge(wt, { base: 'main', mode: 'merge', expectHead: rv.head }); } catch (e) { err = e; }
ok(err?.code === 409 && /dry-run/.test(err.message) && g(repo, 'rev-parse', 'HEAD').trim() !== rv.head, 'and merge refuses');
process.env.PATH = PATH;

fs.rmSync(scratch, { recursive: true, force: true });
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
