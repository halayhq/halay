// The git worktree flow (git-tools.js through /api/agents/:id/git) against a SPARE instance it starts itself, on a temp git
// repo (fake claude, no model calls): node test/git-e2e.mjs
// Covers: start in a worktree (worktree=true), repos listing, review, merge with ff and with a merge commit, the guards
// (confirm, expectHead, mode, dirty tree, not fast-forwardable, conflicts, path outside the folder), remove (with and
// without deleting the branch, refused when dirty) and bad branch names.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startSpare, newAgent, checker } from './lib/spare.mjs';
const { ok, done } = checker();
const s = await startSpare({ tag: 'git', env: { GIT_CEILING_DIRECTORIES: fs.realpathSync(os.tmpdir()) } }) // a temp folder may itself sit inside a repo;
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, msg) => { fs.writeFileSync(path.join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };
try {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(s.dir, 'repo-')));
  git(repo, 'init', '-q', '-b', 'main'); commit(repo, 'a.txt', 'one\n', 'init');
  const start = async (extra = {}) => { const r = await s.api('/agents', 'POST', { cwd: repo, worktree: true, name: 'wt', ...extra }); return r; };
  const gapi = (id, action, method = 'GET', body, q = '') => s.api(`/agents/${id}/git${action ? '/' + action : ''}${q}`, method, body);

  // ---- start
  ok((await s.api('/agents', 'POST', { cwd: s.dir, worktree: true })).status === 400, 'worktree in a folder that is not a repo: 400');
  ok((await start({ branch: 'bad name' })).status === 400, 'worktree with an invalid branch name: 400');
  const a1 = await start({ branch: 'feat/one' });
  ok(a1.status < 300 && a1.j.worktree?.branch === 'feat/one' && a1.j.worktree?.base === 'main', 'worktree agent starts on its own branch off main');
  ok((await start({ branch: 'feat/one' })).status === 400, 'an existing branch name is refused');
  const id1 = a1.j.id, wt1 = a1.j.worktree.path;
  ok(fs.existsSync(path.join(wt1, 'a.txt')) && git(wt1, 'rev-parse', '--abbrev-ref', 'HEAD') === 'feat/one', 'the worktree folder exists on that branch');
  const lst = await gapi(id1);
  ok(lst.status === 200 && lst.j.repos?.length >= 1, 'GET git lists repos');

  // ---- review and the guards
  let rv = await gapi(id1, 'review');
  ok(rv.status === 200 && rv.j.ahead === 0 && rv.j.blockers.some((b) => /no commits/.test(b)), 'review: no commits yet is a blocker');
  const head1 = commit(wt1, 'b.txt', 'b\n', 'add b');
  rv = (await gapi(id1, 'review')).j;
  ok(rv.ahead === 1 && rv.behind === 0 && rv.canFastForward && !rv.wouldConflict && rv.blockers.length === 0 && rv.head === head1, 'review: 1 ahead, can fast-forward, no blockers');
  ok(rv.commits?.length === 1 && /b\.txt/.test(rv.diff), 'review: commit list and diff');
  ok((await gapi(id1, 'review', 'GET', undefined, '?path=/etc')).status === 400, 'review: a path outside the agent folder is refused');
  ok((await gapi(id1, 'review', 'GET', undefined, '?base=nope')).status === 400, 'review: an unknown base is refused');
  const mergeBody = { path: wt1, mode: 'ff', expectHead: head1, confirm: true };
  ok((await gapi(id1, 'merge', 'POST', { ...mergeBody, confirm: undefined })).status === 400, 'merge: needs confirm');
  ok((await gapi(id1, 'merge', 'POST', { ...mergeBody, mode: 'squash' })).status === 400, 'merge: mode must be ff or merge');
  ok((await gapi(id1, 'merge', 'POST', { ...mergeBody, expectHead: 'x' })).status === 400, 'merge: expectHead must be a sha');
  ok((await gapi(id1, 'merge', 'POST', { ...mergeBody, expectHead: '0'.repeat(40) })).status === 400, 'merge: a moved branch is refused');
  fs.writeFileSync(path.join(wt1, 'dirty.txt'), 'x');
  rv = (await gapi(id1, 'review')).j;
  ok(rv.blockers.some((b) => /uncommitted/.test(b)), 'review: an untracked file blocks');
  ok((await gapi(id1, 'merge', 'POST', mergeBody)).status === 409, 'merge: refused with a dirty worktree');
  ok((await gapi(id1, 'remove', 'POST', { path: wt1, confirm: true })).status === 400 && fs.existsSync(wt1), 'remove: refused with a dirty worktree, nothing removed');
  fs.rmSync(path.join(wt1, 'dirty.txt'));

  // ---- ff merge, then remove the worktree and delete the branch
  let m = await gapi(id1, 'merge', 'POST', mergeBody);
  ok(m.status === 200 && m.j.merged && m.j.mode === 'ff' && m.j.newHead === head1, 'merge ff: main moved to the branch head');
  ok(git(repo, 'rev-parse', 'HEAD') === head1 && fs.existsSync(path.join(repo, 'b.txt')) && !git(repo, 'log', '--merges', '--oneline'), 'merge ff: no merge commit, file in main');
  m = await gapi(id1, 'remove', 'POST', { path: wt1, confirm: true, deleteBranch: true });
  ok(m.status === 200 && m.j.removed && m.j.branchDeleted && !fs.existsSync(wt1), 'remove: folder gone, merged branch deleted');
  ok(!git(repo, 'branch', '--list', 'feat/one') && !git(repo, 'worktree', 'list').includes('feat/one'), 'remove: git knows nothing of it any more');

  // ---- non-ff: ff refused, merge commit works; "merge and remove" in one go
  const a2 = (await start({ branch: 'feat/two' })).j, wt2 = a2.worktree.path;
  const head2 = commit(wt2, 'c.txt', 'c\n', 'add c');
  commit(repo, 'd.txt', 'd\n', 'main moves on');
  rv = (await gapi(a2.id, 'review')).j;
  ok(rv.ahead === 1 && rv.behind === 1 && !rv.canFastForward && !rv.wouldConflict, 'review: diverged, no conflict');
  m = await gapi(a2.id, 'merge', 'POST', { path: wt2, mode: 'ff', expectHead: head2, confirm: true });
  ok(m.status === 409 && /fast-forward/.test(m.j.error), 'merge ff: refused when it cannot fast-forward');
  m = await gapi(a2.id, 'merge', 'POST', { path: wt2, mode: 'merge', expectHead: head2, confirm: true, remove: true, deleteBranch: true });
  ok(m.status === 200 && m.j.merged && m.j.removed && m.j.branchDeleted, 'merge (merge commit) with remove: merged, worktree and branch removed');
  ok(git(repo, 'log', '--merges', '--oneline').split('\n').length === 1 && fs.existsSync(path.join(repo, 'c.txt')) && fs.existsSync(path.join(repo, 'd.txt')), 'merge: a merge commit with both sides in main');

  // ---- conflict
  const a3 = (await start({ branch: 'feat/three' })).j, wt3 = a3.worktree.path;
  const head3 = commit(wt3, 'a.txt', 'three\n', 'edit a on branch');
  const mainHead = commit(repo, 'a.txt', 'main\n', 'edit a on main');
  rv = (await gapi(a3.id, 'review')).j;
  ok(rv.wouldConflict && rv.conflicts.includes('a.txt'), 'review: predicts a conflict in a.txt');
  m = await gapi(a3.id, 'merge', 'POST', { path: wt3, mode: 'merge', expectHead: head3, confirm: true });
  ok(m.status === 409 && /conflict/.test(m.j.error), 'merge: the conflict is refused');
  ok(git(repo, 'rev-parse', 'HEAD') === mainHead && git(repo, 'status', '--porcelain') === '' && fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'main\n', 'merge: main is untouched after the refused merge');

  // ---- remove an unmerged branch's worktree: the worktree goes, the branch stays
  m = await gapi(a3.id, 'remove', 'POST', { path: wt3, confirm: true, deleteBranch: true, expectHead: head3 });
  ok(m.status === 200 && m.j.removed && !m.j.branchDeleted && /kept/.test(m.j.branchNote || ''), 'remove: an unmerged branch is kept (-d refuses)');
  ok((await gapi(a3.id, 'remove', 'POST', { path: wt3 })).status === 400, 'remove: needs confirm');
  ok((await gapi(a3.id, 'remove', 'POST', { path: wt3, confirm: true })).status >= 400, 'remove: a gone worktree is an error, not a crash');
  ok((await s.api('/agents/nope/git')).status === 404, 'unknown agent is 404');
  ok((await s.api('/agents/' + a3.id, 'DELETE')).status < 300, 'removing the agent works afterwards');
} catch (e) { ok(false, 'unexpected exception: ' + (e.stack || e)); }
finally { await s.stop(); }
done();
