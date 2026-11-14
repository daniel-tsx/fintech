import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, contentInBase, makeGit, parseWorktrees, plan } from './cleanup-merged.mjs';

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
  git('checkout', '-q', '-b', 'main');
  commit('a.txt', 'a\n', 'init');
  // Squash-merged: same change lands on main as a different commit, then main moves on.
  git('checkout', '-q', '-b', 'feat/squashed'); commit('b.txt', 'b\n', 'b'); commit('b.txt', 'b2\n', 'b2');
  // Open: never merged.
  git('checkout', '-q', 'main'); git('checkout', '-q', '-b', 'feat/open'); commit('c.txt', 'c\n', 'c');
  // Stacked child merged into feat/open, not main.
  git('checkout', '-q', '-b', 'feat/child'); commit('d.txt', 'd\n', 'd');
  git('checkout', '-q', 'feat/open'); git('merge', '-q', '--squash', 'feat/child'); git('commit', '-q', '-m', 'child (#2)');
  // Merged but its worktree has uncommitted work.
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
  return { dir, repo, git };
}

const find = (actions, kind, suffix) => actions.find((a) => a.kind === kind && a.target.replaceAll('\\', '/').endsWith(suffix));

test('content check: squash-merged is in main, unmerged and stacked-into-another-branch are not', (t) => {
  const { dir, git } = fixture(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(contentInBase(git, 'feat/squashed'), true);
  assert.equal(contentInBase(git, 'fix/dirty'), true);
  assert.equal(contentInBase(git, 'feat/open'), false);
  assert.equal(contentInBase(git, 'feat/child'), false, 'merged into feat/open is not merged into main');
});

test('plan removes only clean, merged work and never main, open branches or workflow handoffs', (t) => {
  const { dir, repo, git } = fixture(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { actions, remote } = plan(git, { root: repo });
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
  assert.deepEqual(git('branch', '--format=%(refname:short)').split('\n').sort(), ['feat/child', 'feat/open', 'fix/dirty', 'main']);
});

test('parseWorktrees reads porcelain output, including detached entries', () => {
  assert.deepEqual(parseWorktrees('worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r/.tmp/x/worktree\nHEAD 2\ndetached\n'), [
    { path: '/r', branch: 'main' }, { path: '/r/.tmp/x/worktree', branch: null },
  ]);
});

test('a merged-into-main PR counts only when its head is exactly the branch tip', (t) => {
  const { dir, repo, git } = fixture(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = git('rev-parse', 'feat/child');
  const stale = plan(git, { root: repo, mergedHeads: new Map([['feat/child', git('rev-parse', 'feat/child~1')]]) });
  assert.equal(find(stale.actions, 'branch', 'feat/child').action, 'KEEP', 'branch moved after the PR merged');
  const exact = plan(git, { root: repo, mergedHeads: new Map([['feat/child', child]]) });
  assert.equal(find(exact.actions, 'branch', 'feat/child').action, 'REMOVE');
  assert.ok(exact.remote.includes('feat/child'));
});
