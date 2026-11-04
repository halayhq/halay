// Read-only git inspection plus a guarded worktree create / merge / remove, for the swarm's per-agent git view.
// Everything goes through execFile (no shell). Nothing here pushes, forces, or discards uncommitted work.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DIFF_CAP = 300_000; // bytes of diff text returned to the UI

const fail = (message, code = 400) => Object.assign(new Error(message), { code });

// Runs git in dir. Never rejects: { code, stdout, stderr, truncated }. Output over `max` is a failure (code 128), except
// with `partial`, where the truncated output comes back as a success with truncated: true (diffs shown up to a cap).
function git(dir, args, { max = 64_000_000, read = true, timeout = 30_000, partial = false } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', '-C', dir, ...args], {
      encoding: 'utf8', maxBuffer: max, timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_PAGER: 'cat', ...(read ? { GIT_OPTIONAL_LOCKS: '0' } : {}) },
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr, truncated: false });
      const truncated = err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      if (truncated && !partial) return resolve({ code: 128, stdout: '', stderr: `git output exceeded ${max} bytes`, truncated });
      resolve({ code: truncated ? 0 : typeof err.code === 'number' ? err.code : 128, stdout: stdout || '', stderr: stderr || err.message, truncated });
    });
  });
}
const out = async (dir, args, opts) => { const r = await git(dir, args, opts); return r.code === 0 ? r.stdout.trim() : null; };

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const SHA = /^[0-9a-f]{40}$/;

// Branch names: conservative charset, then git's own check. Never starts with '-'.
export async function validBranch(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][\w./+-]{0,100}$/.test(name) || name.includes('..') || name.endsWith('.lock')) return false;
  return (await git(process.cwd(), ['check-ref-format', '--branch', name])).code === 0;
}

async function localBranchSha(dir, name) {
  if (!(await validBranch(name))) return null;
  return out(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`]);
}

export async function probe(dir) {
  const top = await out(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return { isRepo: false };
  const branch = await out(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const dirty = (await out(dir, ['status', '--porcelain', '--untracked-files=no']))?.split('\n').filter(Boolean).length || 0;
  return { isRepo: true, top: real(top), branch, detached: !branch, dirty };
}

// Main checkout of the repo a linked worktree belongs to (derived by git, never from a request).
async function mainWorktree(dir) {
  const r = await out(dir, ['worktree', 'list', '--porcelain']);
  const first = r?.split('\n').find((l) => l.startsWith('worktree '));
  return first ? real(first.slice(9)) : null;
}

export async function listWorktrees(dir) {
  const r = await out(dir, ['worktree', 'list', '--porcelain']);
  if (!r) return [];
  return r.split('\n\n').map((blk) => {
    const o = {};
    for (const l of blk.split('\n')) { const i = l.indexOf(' '); o[i < 0 ? l : l.slice(0, i)] = i < 0 ? true : l.slice(i + 1); }
    return { path: o.worktree && real(o.worktree), branch: o.branch?.replace('refs/heads/', '') || null, head: o.HEAD || null };
  }).filter((w) => w.path);
}

async function statusOf(dir) {
  const sr = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  const r = sr.code === 0 ? sr.stdout : null; // not trimmed: the first entry may start with a space (' M path')
  const files = [];
  const c = { staged: 0, unstaged: 0, untracked: 0 };
  if (r) {
    const parts = r.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i]; if (e.length < 4) continue;
      const x = e[0], y = e[1];
      files.push({ x, y, path: e.slice(3) });
      if (x === '?') c.untracked++; else { if (x !== ' ') c.staged++; if (y !== ' ') c.unstaged++; }
      if (x === 'R' || x === 'C') i++; // the old name follows
    }
  }
  // lines added/removed per file vs HEAD (untracked files have no counts; the UI shows them as new)
  const ns = await out(dir, ['diff', '--numstat', '--no-color', '--no-ext-diff', '--no-textconv', (await out(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])) ? 'HEAD' : '--cached', '--']);
  const num = new Map();
  for (const l of (ns || '').split('\n')) { const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l); if (m) num.set(m[3], m[1] === '-' ? { binary: true } : { add: +m[1], del: +m[2] }); }
  for (const f of files) Object.assign(f, num.get(f.path));
  return { ...c, total: c.staged + c.unstaged + c.untracked, files: files.slice(0, 60), moreFiles: Math.max(0, files.length - 60) };
}

const parseLog = (s) => (s || '').split('\n').filter(Boolean).map((l) => {
  const [sha, short, author, at, subject] = l.split('\x1f');
  return { sha, short, author, at: Number(at) * 1000, subject };
});
const LOGFMT = '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s';

async function counts(dir, spec) { // "A...B" -> { left: only in A, right: only in B }
  const r = await out(dir, ['rev-list', '--left-right', '--count', spec]);
  if (!r) return null;
  const [left, right] = r.split(/\s+/).map(Number);
  return { left, right };
}

export async function repoInfo(dir, baseHint) {
  const top = await out(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const gitDir = await out(dir, ['rev-parse', '--absolute-git-dir']);
  const commonRaw = await out(dir, ['rev-parse', '--git-common-dir']);
  const linked = !!(gitDir && commonRaw) && real(gitDir) !== real(path.resolve(dir, commonRaw));
  const head = await out(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const branch = await out(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const info = { path: dir, top: real(top), linked, branch, detached: !branch, head, headShort: head?.slice(0, 7) || null };
  info.upstream = null;
  const up = head && branch ? await out(dir, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]) : null;
  if (up) { const c = await counts(dir, `HEAD...${up}`); info.upstream = { name: up, ahead: c?.left ?? null, behind: c?.right ?? null }; }
  info.status = await statusOf(dir);
  info.diffStat = head ? (await out(dir, ['diff', '--stat=70', '--no-color', '--no-ext-diff', 'HEAD', '--']))?.split('\n').slice(-60).join('\n') || '' : '';
  info.commits = head ? parseLog(await out(dir, ['log', '-n', '10', LOGFMT])) : [];
  info.base = null;
  if (linked) {
    const baseRepo = await mainWorktree(dir);
    let base = baseHint || (baseRepo ? await out(baseRepo, ['symbolic-ref', '--short', '-q', 'HEAD']) : null);
    if (base && head && (await localBranchSha(dir, base))) {
      const c = await counts(dir, `${base}...HEAD`);
      info.base = { name: base, repo: baseRepo, ahead: c?.right ?? null, behind: c?.left ?? null };
    } else info.base = { name: base, repo: baseRepo, ahead: null, behind: null };
  }
  return info;
}

// Read-only diff text, capped. mode 'working' = uncommitted vs HEAD, 'base' = commits on HEAD since it left base.
export async function diff(dir, { mode = 'working', base, file, stat = false } = {}) {
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', ...(stat ? ['--stat=80'] : [])];
  if (mode === 'base') {
    if (!(await localBranchSha(dir, base))) throw fail('unknown base branch');
    args.push(`${base}...HEAD`);
  } else if (await out(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])) args.push('HEAD');
  else args.push('--cached');
  args.push('--');
  if (file) {
    if (typeof file !== 'string' || file.includes('\0') || path.isAbsolute(file) || file.split('/').includes('..')) throw fail('bad file path');
    args.push(file);
  }
  let r = await git(dir, args, { max: DIFF_CAP + 1, partial: true });
  if (r.code !== 0) throw fail(r.stderr.trim() || 'git diff failed');
  if (file && mode === 'working' && !r.stdout.trim() && !file.endsWith('/') && await out(dir, ['ls-files', '--others', '--exclude-standard', '--', file])) {
    r = await git(dir, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-index', '--', '/dev/null', file], { max: DIFF_CAP + 1, partial: true }); // untracked: show it as all-added; exit code 1 just means "differs"
    if (r.code > 1) throw fail(r.stderr.trim() || 'git diff failed');
  }
  const text = r.stdout.slice(0, DIFF_CAP);
  return { diff: text, truncated: r.truncated || r.stdout.length > DIFF_CAP, bytes: text.length };
}

// What a merge of this linked worktree's branch into base would do, and what would stop it.
export async function review(dir, base) {
  const info = await repoInfo(dir, base);
  if (!info) throw fail('not a git repository');
  if (!info.linked) throw fail('not a linked worktree: nothing to merge into a base branch');
  if (info.detached) throw fail('the worktree has a detached HEAD; check out its branch first');
  const baseName = base || info.base?.name;
  const baseSha = baseName && (await localBranchSha(dir, baseName));
  if (!baseSha) throw fail('pick a base branch that exists in the repository');
  const baseRepo = info.base?.repo;
  const blockers = [];
  if (info.status.total) blockers.push(`the worktree has ${info.status.total} uncommitted or untracked file(s): commit them (or deal with them) first`);
  if (!baseRepo) blockers.push('could not find the base repository checkout');
  else {
    const cur = await out(baseRepo, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (cur !== baseName) blockers.push(`the base repository (${baseRepo}) has ${cur ? `"${cur}"` : 'a detached HEAD'} checked out, not "${baseName}"; a merge needs "${baseName}" checked out there`);
    const dirty = (await out(baseRepo, ['status', '--porcelain', '--untracked-files=no']))?.split('\n').filter(Boolean).length || 0;
    if (dirty) blockers.push(`the base repository checkout has ${dirty} uncommitted change(s) to tracked files; commit or stash them first`);
  }
  const ahead = (await counts(dir, `${baseName}...HEAD`)) || { left: 0, right: 0 };
  if (!ahead.right) blockers.push(`"${info.branch}" has no commits that are not already in "${baseName}"`);
  const canFastForward = (await git(dir, ['merge-base', '--is-ancestor', baseName, 'HEAD'])).code === 0;
  const mt = await git(dir, ['merge-tree', '--write-tree', '--no-messages', baseName, 'HEAD'], { read: false });
  if (mt.code > 1) blockers.push(`could not dry-run the merge to check for conflicts (git merge-tree --write-tree needs git 2.38 or newer): ${(mt.stderr || '').trim().split('\n')[0] || 'exit ' + mt.code}`);
  const conflicts = mt.code === 1 ? [...new Set(mt.stdout.split('\n').slice(1).filter((l) => /^\d+ [0-9a-f]+ \d\t/.test(l)).map((l) => l.split('\t')[1]))] : [];
  const stat = await diff(dir, { mode: 'base', base: baseName, stat: true });
  const full = await diff(dir, { mode: 'base', base: baseName });
  const commits = parseLog(await out(dir, ['log', `${baseName}..HEAD`, '-n', '50', LOGFMT]));
  return {
    path: dir, branch: info.branch, head: info.head, base: baseName, baseSha, baseRepo,
    ahead: ahead.right, behind: ahead.left, canFastForward, wouldConflict: mt.code === 1, conflicts, mergeCheckFailed: mt.code > 1,
    uncommitted: info.status, blockers, commits, stat: stat.diff, diff: full.diff, truncated: full.truncated,
  };
}

// Creates tmp/<id>/wt on a new branch off the repo's current branch. Returns where the agent should run.
export async function addWorktree({ repoDir, wtPath, branch, subdir = '' }) {
  const p = await probe(repoDir);
  if (!p.isRepo) throw fail('that folder is not inside a git repository');
  if (p.detached) throw fail('the repository has a detached HEAD; check out a branch first so the worktree has a base to merge into');
  if (!(await validBranch(branch))) throw fail('invalid branch name');
  if (await localBranchSha(p.top, branch)) throw fail(`branch "${branch}" already exists`);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const r = await git(p.top, ['worktree', 'add', '-b', branch, wtPath, p.branch], { read: false });
  if (r.code !== 0) throw fail('git worktree add failed: ' + r.stderr.trim());
  const rel = path.relative(p.top, path.resolve(repoDir)); // keep working in the same subfolder
  const cwd = rel && !rel.startsWith('..') ? path.join(wtPath, rel) : wtPath;
  return { repo: p.top, path: real(wtPath), cwd: fs.existsSync(cwd) ? real(cwd) : real(wtPath), branch, base: p.branch, dirtyInOriginal: p.dirty, subdir };
}

async function conflictAbort(repo) {
  if (await out(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) await git(repo, ['merge', '--abort'], { read: false });
}

// Remove a linked worktree (and optionally its branch) without force: git itself refuses a dirty tree, -d an unmerged branch.
export async function removeWorktree(dir, { deleteBranch = false, expectHead } = {}) {
  const info = await repoInfo(dir);
  if (!info?.linked) throw fail('not a linked worktree');
  const repo = info.base?.repo;
  if (!repo) throw fail('could not find the base repository checkout');
  if (expectHead && info.head !== expectHead) throw fail('the branch moved since you looked at it; review again');
  if (info.status.total) throw fail(`the worktree has ${info.status.total} uncommitted or untracked file(s); nothing was removed`);
  const r = await git(repo, ['worktree', 'remove', real(dir)], { read: false });
  if (r.code !== 0) throw fail('git refused to remove the worktree: ' + r.stderr.trim());
  const res = { removed: true, branchDeleted: false, branchNote: null };
  if (deleteBranch && info.branch) {
    const b = await git(repo, ['branch', '-d', info.branch], { read: false });
    res.branchDeleted = b.code === 0;
    if (b.code !== 0) res.branchNote = 'branch kept: ' + b.stderr.trim();
  }
  return res;
}

export async function merge(dir, { base, mode, expectHead, remove = false, deleteBranch = false }) {
  if (!['ff', 'merge'].includes(mode)) throw fail('mode must be ff or merge');
  if (!SHA.test(expectHead || '')) throw fail('expectHead (the reviewed commit) is required');
  const rv = await review(dir, base);
  if (rv.head !== expectHead) throw fail('the branch moved since you reviewed it; review again');
  if (rv.blockers.length) throw fail('cannot merge: ' + rv.blockers.join('; '), 409);
  if (mode === 'ff' && !rv.canFastForward) throw fail(`cannot fast-forward: "${rv.base}" has commits "${rv.branch}" does not. Use a merge commit, or update the branch first`, 409);
  if (rv.wouldConflict) throw fail(`merging would conflict in: ${rv.conflicts.join(', ') || 'some files'}. Resolve in the worktree (e.g. merge ${rv.base} into the branch there), then review again`, 409);
  const args = mode === 'ff' ? ['merge', '--ff-only', expectHead] : ['merge', '--no-ff', '-m', `Merge branch '${rv.branch}' (swarm worktree)`, expectHead];
  const m = await git(rv.baseRepo, args, { read: false });
  if (m.code !== 0) { await conflictAbort(rv.baseRepo); throw fail('git merge failed (nothing was changed): ' + (m.stderr || m.stdout).trim(), 409); }
  const result = { merged: true, mode, base: rv.base, branch: rv.branch, newHead: await out(rv.baseRepo, ['rev-parse', 'HEAD']) };
  if (remove) {
    try { Object.assign(result, await removeWorktree(dir, { deleteBranch })); }
    catch (e) { result.removed = false; result.removeError = e.message; }
  }
  return result;
}

// For deleting an agent: is anything in its worktree not safe elsewhere?
export async function worktreeRisk(dir) {
  const info = await repoInfo(dir);
  if (!info?.linked) return null;
  return { dirty: info.status.total, unmerged: info.base?.ahead ?? null, branch: info.branch, base: info.base?.name || null };
}

export const pruneWorktrees = (repoDir) => git(repoDir, ['worktree', 'prune'], { read: false });
