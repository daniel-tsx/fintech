import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, looksMerged, makeGit, parseWorktrees, plan } from './cleanup-merged.mjs';

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cleanup-merged-'));
  const origin = join(dir, 'origin.git'), repo = join(dir, 'repo');
  makeGit(dir)('init', '-q', '--bare', '-b', 'main', origin);
  makeGit(dir)('clone', '-q', origin, repo);
  const git = makeGit(repo);
  const commit = (file, text, msg) => { writeFileSync(join(repo, file), text); git('add', file); git('commit', '-q', '-m', msg); };
  appendFileSync(join(repo, '.git/info/exclude'), '.env\nnode_modules/\n');
  git('checkout', '-q', '-b', 'main');
  commit('a.txt', 'a\n', 'init');
  git('checkout', '-q', '-b', 'feat/squashed'); commit('b.txt', 'b\n', 'b'); commit('b.txt', 'b2\n', 'b2');
  git('checkout', '-q', 'main'); git('checkout', '-q', '-b', 'feat/open'); commit('c.txt', 'c\n', 'c');
  git('checkout', '-q', '-b', 'feat/child'); commit('d.txt', 'd\n', 'd'); // stacked on feat/open, merged there
  git('checkout', '-q', 'feat/open'); git('merge', '-q', '--squash', 'feat/child'); git('commit', '-q', '-m', 'child (#2)');
  git('checkout', '-q', 'main'); git('checkout', '-q', '-b', 'fix/dirty'); commit('e.txt', 'e\n', 'e');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', 'feat/squashed'); git('commit', '-q', '-m', 'b (#1)');
  git('merge', '-q', '--squash', 'fix/dirty'); git('commit', '-q', '-m', 'e (#3)');
  commit('a.txt', 'a2\n', 'later main work');
  git('push', '-q', 'origin', 'main', 'feat/open', 'feat/child', 'feat/squashed');
  git('fetch', '-q', 'origin');
  git('worktree', 'add', '-q', join(repo, '.tmp/squashed/worktree'), 'feat/squashed');
  git('worktree', 'add', '-q', join(repo, '.tmp/dirty/worktree'), 'fix/dirty');
  writeFileSync(join(repo, '.tmp/dirty/worktree/e.txt'), 'local edit\n');
  git('worktree', 'add', '-q', join(repo, '.tmp/open/worktree'), 'feat/open');
  mkdirSync(join(repo, '.tmp/agent-workflows/x'), { recursive: true });
  mkdirSync(join(repo, '.tmp/orphan'), { recursive: true });
  const old = (Date.now() - 30 * 86_400_000) / 1000; utimesSync(join(repo, '.tmp/orphan'), old, old);
  // PRs merged into main, as GitHub reports them: branch -> head SHA.
  const prs = new Map([['feat/squashed', git('rev-parse', 'feat/squashed')], ['fix/dirty', git('rev-parse', 'fix/dirty')]]);
  return { dir, repo, git, prs };
}

const find = (actions, kind, suffix) => actions.find((a) => a.kind === kind && a.target.replaceAll('\\', '/').endsWith(suffix));
const branchesOf = (git) => git('branch', '--format=%(refname:short)').split('\n').sort();

test('without merged-PR evidence nothing is removed; content that looks merged is only REVIEW', (t) => {
  const { dir, repo, git } = fixture(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(looksMerged(git, 'feat/squashed'), true);
  assert.equal(looksMerged(git, 'feat/child'), false, 'merged into feat/open is not in main');
  for (const heads of [new Map(), null]) {
    const { actions, remote } = plan(git, { root: repo, mergedHeads: heads });
    assert.deepEqual(actions.filter((a) => a.action === 'REMOVE'), []);
    assert.equal(find(actions, 'branch', 'fix/dirty').action, 'KEEP');
    assert.deepEqual(remote, []);
  }
});

test('with merged-PR evidence: removes only clean merged work; keeps dirty, open, stacked and workflow handoffs', (t) => {
  const { dir, repo, git, prs } = fixture(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { actions, remote } = plan(git, { root: repo, mergedHeads: prs });
  assert.equal(find(actions, 'worktree', '.tmp/squashed/worktree').action, 'REMOVE');
  assert.equal(find(actions, 'worktree', '.tmp/dirty/worktree').reason, 'uncommitted changes');
  assert.equal(find(actions, 'worktree', '.tmp/open/worktree').action, 'KEEP');
  assert.equal(find(actions, 'branch', 'feat/squashed').action, 'REMOVE');
  assert.equal(find(actions, 'branch', 'fix/dirty').action, 'KEEP');
  assert.equal(find(actions, 'branch', 'feat/child').action, 'KEEP');
  assert.equal(actions.some((a) => a.target === 'main'), false);
  assert.equal(find(actions, 'tmp', '.tmp/squashed').action, 'REMOVE');
  assert.equal(find(actions, 'tmp', '.tmp/dirty').action, 'KEEP');
  assert.equal(find(actions, 'tmp', '.tmp/agent-workflows').action, 'KEEP');
  assert.match(find(actions, 'tmp', '.tmp/orphan').reason, /untouched \d+ days/);
  assert.deepEqual(remote, ['feat/squashed']);

  apply(git, actions);
  assert.equal(existsSync(join(repo, '.tmp/squashed')), false);
  assert.equal(existsSync(join(repo, '.tmp/dirty/worktree/e.txt')), true);
  assert.equal(existsSync(join(repo, '.tmp/agent-workflows/x')), true);
  assert.deepEqual(branchesOf(git), ['feat/child', 'feat/open', 'fix/dirty', 'main']);
  assert.match(git('ls-remote', 'origin'), /refs\/heads\/feat\/squashed/, 'remote branches are never deleted');
});

test('regression: task branches without commits of their own are kept, from main or from a merged task branch', (t) => {
  const { dir, repo, git, prs } = fixture(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Planning task from main; stacked child and follow-up created from a branch whose PR merged.
  git('worktree', 'add', '-q', '-b', 'feat/pending', join(repo, '.tmp/pending/worktree'), 'origin/main');
  writeFileSync(join(repo, '.tmp/pending/plan.md'), 'plan\n');
  git('worktree', 'add', '-q', '-b', 'feat/stacked', join(repo, '.tmp/stacked/worktree'), 'feat/squashed');
  writeFileSync(join(repo, '.tmp/stacked/plan.md'), 'plan\n');
  git('branch', 'fix/followup', 'feat/squashed');
  mkdirSync(join(repo, '.tmp/followup')); writeFileSync(join(repo, '.tmp/followup/epic.md'), 'epic\n');
  git('push', '-q', 'origin', 'feat/pending', 'feat/stacked'); git('fetch', '-q', 'origin');
  const { actions, remote } = plan(git, { root: repo, mergedHeads: prs });
  for (const b of ['feat/pending', 'feat/stacked', 'fix/followup']) assert.notEqual(find(actions, 'branch', b).action, 'REMOVE', b);
  for (const s of ['.tmp/pending', '.tmp/stacked', '.tmp/followup']) assert.equal(find(actions, 'tmp', s).action, 'KEEP', s);
  assert.deepEqual(remote, ['feat/squashed']);
});

test('regression: a .tmp/<slug>/ holding a kept (detached, dirty) worktree is never deleted', (t) => {
  const { dir, repo, git, prs } = fixture(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wt = join(repo, '.tmp/squashed/worktree');
  makeGit(wt)('checkout', '-q', '--detach'); writeFileSync(join(wt, 'b.txt'), 'unsaved\n');
  const { actions } = plan(git, { root: repo, mergedHeads: prs });
  assert.equal(find(actions, 'worktree', '.tmp/squashed/worktree').reason, 'detached HEAD');
  assert.equal(find(actions, 'tmp', '.tmp/squashed').action, 'KEEP');
  apply(git, actions);
  assert.equal(existsSync(join(wt, 'b.txt')), true);
});

test('merged worktrees holding ignored files of their own, or locked, are kept; regenerable output is not a reason', (t) => {
  const { dir, repo, git, prs } = fixture(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wt = join(repo, '.tmp/squashed/worktree');
  mkdirSync(join(wt, 'node_modules/x'), { recursive: true }); writeFileSync(join(wt, 'node_modules/x/i.js'), '');
  assert.equal(find(plan(git, { root: repo, mergedHeads: prs }).actions, 'worktree', '.tmp/squashed/worktree').action, 'REMOVE');
  writeFileSync(join(wt, '.env'), 'SECRET=local\n');
  assert.match(find(plan(git, { root: repo, mergedHeads: prs }).actions, 'worktree', '.tmp/squashed/worktree').reason, /ignored files of its own: \.env/);
  rmSync(join(wt, '.env')); git('worktree', 'lock', wt);
  assert.equal(find(plan(git, { root: repo, mergedHeads: prs }).actions, 'worktree', '.tmp/squashed/worktree').reason, 'locked');
});

test('a missing base fails with a clear message; parseWorktrees reads porcelain output', (t) => {
  const { dir, repo, git } = fixture(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => plan(git, { root: repo, base: 'origin/nope' }), /origin\/nope not found/);
  assert.deepEqual(parseWorktrees('worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r/.tmp/x/worktree\nHEAD 2\ndetached\nlocked reason\n'), [
    { path: '/r', branch: 'main', locked: false }, { path: '/r/.tmp/x/worktree', branch: null, locked: true },
  ]);
});
