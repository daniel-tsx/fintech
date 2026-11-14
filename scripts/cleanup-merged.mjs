#!/usr/bin/env node
// Post-merge cleanup for task worktrees, local branches and .tmp/<slug>/ directories.
// Dry run by default; `--apply` removes only what the plan marks REMOVE. A branch counts as done
// only when it has work of its own that is already in origin/main (squash merges included), not
// merely because a PR was merged: a PR merged into another branch never reaches main.
// A second signal covers squash-merged branches that later main edits made conflict: a PR merged into
// main whose head is exactly the branch tip (read with `gh` when available).
// Never touches main, the current checkout, dirty worktrees, .tmp/agent-workflows/ or remote branches
// (remote deletions are printed for the human to run).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const STALE_DAYS = 14;

export function makeGit(cwd) {
  return (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * True only when `ref` has work of its own and all of it is already in `base`.
 * A branch with no commits of its own (a task still in planning), only empty commits, or a net-empty
 * diff (a commit and its revert) is NOT counted: "nothing to merge" is not evidence of a merge.
 */
export function contentInBase(git, ref, base = 'origin/main') {
  const tip = git('rev-parse', ref);
  if (git('rev-list', '--count', `${base}..${ref}`) === '0') {
    // Already an ancestor of base. Merged through a merge commit only if the tip is off base's
    // first-parent line; a fresh branch from base (or a fast-forward) sits on that line: keep it.
    return !git('rev-list', '--first-parent', base).split('\n').includes(tip);
  }
  const mergeBase = git('merge-base', base, ref);
  if (git('diff', '--name-only', mergeBase, ref) === '') return false;
  try {
    const tree = git('merge-tree', '--write-tree', base, ref).split('\n')[0];
    return tree === git('rev-parse', `${base}^{tree}`);
  } catch {
    return false; // conflict or unsupported git: treat as not merged (safe side)
  }
}

export function parseWorktrees(porcelain) {
  return porcelain.split('\n\n').filter(Boolean).map((block) => {
    const get = (k) => block.split('\n').find((l) => l.startsWith(`${k} `))?.slice(k.length + 1);
    return { path: get('worktree'), branch: get('branch')?.replace(/^refs\/heads\//, '') ?? null };
  });
}

/** Map of branch -> head SHA for PRs merged into main, via the GitHub REST API; empty when `gh` is unavailable. */
export function loadMergedHeads(cwd) {
  try {
    const out = execFileSync('gh', ['api', '--paginate', 'repos/{owner}/{repo}/pulls?state=closed&base=main&per_page=100',
      '--jq', '.[] | select(.merged_at != null) | "\\(.head.ref) \\(.head.sha)"'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Map(out.split('\n').filter(Boolean).map((l) => l.split(' ')));
  } catch {
    return new Map();
  }
}

export function plan(git, { root, base = 'origin/main', now = Date.now(), mergedHeads = new Map() } = {}) {
  try { git('rev-parse', '--verify', '--quiet', `${base}^{commit}`); } catch { throw new Error(`${base} not found: run \`git fetch origin\` first`); }
  const inMain = (ref, name) => mergedHeads.get(name) === git('rev-parse', ref) || contentInBase(git, ref, base);
  const current = resolve(git('rev-parse', '--show-toplevel'));
  const worktrees = parseWorktrees(git('worktree', 'list', '--porcelain'));
  const branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
  const merged = new Map(branches.filter((b) => b !== 'main').map((b) => [b, inMain(b, b)]));
  const actions = [];
  const keepBranch = new Set([worktrees[0]?.branch].filter(Boolean)); // whatever the main checkout has out

  for (const wt of worktrees.slice(1)) { // the first entry is the main checkout
    const path = resolve(wt.path);
    let reason = null;
    if (path === current) reason = 'current checkout';
    else if (!wt.branch) reason = 'detached HEAD';
    else if (!merged.get(wt.branch)) reason = 'branch not in main';
    else if (!existsSync(path)) reason = 'directory missing; run `git worktree prune` if it was deleted on purpose';
    else if (makeGit(path)('status', '--porcelain')) reason = 'uncommitted changes';
    if (reason) { if (wt.branch) keepBranch.add(wt.branch); actions.push({ kind: 'worktree', target: wt.path, action: 'KEEP', reason }); }
    else actions.push({ kind: 'worktree', target: wt.path, action: 'REMOVE', reason: `${wt.branch} is in main` });
  }
  for (const b of branches) {
    if (b === 'main') continue;
    if (keepBranch.has(b)) actions.push({ kind: 'branch', target: b, action: 'KEEP', reason: 'worktree kept' });
    else if (merged.get(b)) actions.push({ kind: 'branch', target: b, action: 'REMOVE', reason: 'content in main' });
    else actions.push({ kind: 'branch', target: b, action: 'KEEP', reason: 'not in main' });
  }

  const tmp = join(root, '.tmp');
  const removedBranches = new Set(actions.filter((a) => a.kind === 'branch' && a.action === 'REMOVE').map((a) => a.target));
  const live = new Set(branches.filter((b) => !removedBranches.has(b)).map((b) => b.split('/').pop()));
  // A .tmp/<slug>/ holding any worktree that is not being removed (dirty, detached, current, open) stays.
  const removedWorktrees = new Set(actions.filter((a) => a.kind === 'worktree' && a.action === 'REMOVE').map((a) => resolve(a.target)));
  const keptWorktrees = worktrees.slice(1).map((w) => resolve(w.path)).filter((p) => !removedWorktrees.has(p));
  for (const slug of existsSync(tmp) ? readdirSync(tmp) : []) {
    const dir = join(tmp, slug);
    if (!statSync(dir).isDirectory()) continue;
    if (keptWorktrees.some((p) => p === resolve(dir) || p.startsWith(resolve(dir) + sep))) { actions.push({ kind: 'tmp', target: dir, action: 'KEEP', reason: 'holds a worktree that is kept' }); continue; }
    if (slug === 'agent-workflows') { actions.push({ kind: 'tmp', target: dir, action: 'KEEP', reason: 'engineering-workflow handoffs are finalized by a human' }); continue; }
    const owner = [...removedBranches].find((b) => b.split('/').pop() === slug);
    if (owner && !live.has(slug)) actions.push({ kind: 'tmp', target: dir, action: 'REMOVE', reason: `${owner} is in main` });
    else if (live.has(slug)) actions.push({ kind: 'tmp', target: dir, action: 'KEEP', reason: 'branch still open' });
    else {
      const days = Math.floor((now - statSync(dir).mtimeMs) / 86_400_000);
      actions.push({ kind: 'tmp', target: dir, action: 'REVIEW', reason: days >= STALE_DAYS ? `no branch, untouched ${days} days` : 'no matching branch' });
    }
  }

  const remote = git('for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin').split('\n')
    .filter((r) => r && r !== 'origin' && r !== 'origin/HEAD' && r !== base)
    .filter((r) => inMain(r, r.replace(/^origin\//, ''))).map((r) => r.replace(/^origin\//, ''));
  return { actions, remote };
}

export function apply(git, actions) {
  for (const a of actions.filter((x) => x.action === 'REMOVE')) {
    if (a.kind === 'worktree') git('worktree', 'remove', a.target); // no --force: git refuses dirty trees
    else if (a.kind === 'branch') git('branch', '-D', a.target);
    else if (a.kind === 'tmp') rmSync(a.target, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const git = makeGit(process.cwd());
  const root = dirname(resolve(git('rev-parse', '--path-format=absolute', '--git-common-dir')));
  let result;
  try {
    if (!args.has('--no-fetch')) git('fetch', 'origin', '--prune');
    result = plan(git, { root, mergedHeads: loadMergedHeads(process.cwd()) });
  } catch (err) {
    console.error(`cleanup: ${err.message.split('\n')[0]}`); process.exit(1);
  }
  const { actions, remote } = result;
  for (const a of actions) console.log(`${a.action.padEnd(6)} ${a.kind.padEnd(8)} ${a.target}  (${a.reason})`);
  if (remote.length) console.log(`\nRemote branches already in main (delete only with the owner's approval):\n  git push origin --delete ${remote.join(' ')}`);
  if (args.has('--apply')) { apply(git, actions); console.log('\nApplied the REMOVE actions.'); }
  else console.log('\nDry run. Re-run with --apply to remove the REMOVE entries.');
}
