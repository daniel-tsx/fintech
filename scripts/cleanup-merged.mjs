#!/usr/bin/env node
// Post-merge cleanup REPORT for task worktrees, local branches and .tmp/<slug>/ directories.
// It never deletes anything (it only fetches when given --fetch): it prints what is done (DONE), what to keep (KEEP) and what a human
// should look at (REVIEW), with the commands to remove DONE entries by hand.
//
// A branch is DONE only on positive evidence: a PR merged into main whose head is exactly the
// branch tip (GitHub REST API via `gh`). Content heuristics cannot tell a finished branch from a
// task that has no commits yet or one stacked on another task, so a branch whose changes merely
// look present in origin/main is marked REVIEW and never removed automatically.
// main, the main or current checkout, dirty/locked worktrees, worktrees holding ignored files of
// their own (.env, notes), .tmp/agent-workflows/ and remote branches are never DONE.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const STALE_DAYS = 14;
// Regenerable ignored output that may be deleted with a worktree; any other ignored file keeps it.
const DISPOSABLE = /^(node_modules|\.next|dist|build|coverage|\.turbo)(\/|$)|(^|\/)(node_modules|\.next|dist|build|coverage|\.turbo)\/|\.tsbuildinfo$/;

export function makeGit(cwd) {
  return (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Hint only: the branch has commits beyond base and merging it into base would change nothing. */
export function looksMerged(git, ref, base = 'origin/main') {
  if (git('rev-list', '--count', `${base}..${ref}`) === '0') return false;
  try {
    return git('merge-tree', '--write-tree', base, ref).split('\n')[0] === git('rev-parse', `${base}^{tree}`);
  } catch {
    return false;
  }
}

export function parseWorktrees(porcelain) {
  return porcelain.split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n');
    const get = (k) => lines.find((l) => l.startsWith(`${k} `))?.slice(k.length + 1);
    return { path: get('worktree'), branch: get('branch')?.replace(/^refs\/heads\//, '') ?? null, locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')) };
  });
}

/** Map of branch -> head SHA for PRs merged into main; empty when `gh` is unavailable or fails. */
export function loadMergedHeads(cwd) {
  try {
    const out = execFileSync('gh', ['api', '--paginate', 'repos/{owner}/{repo}/pulls?state=closed&base=main&per_page=100',
      '--jq', '.[] | select(.merged_at != null) | "\\(.head.ref) \\(.head.sha)"'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return new Map(out.split('\n').filter(Boolean).map((l) => l.split(' ')));
  } catch {
    return null;
  }
}

function worktreeKeepReason(wt, current) {
  const path = resolve(wt.path);
  if (path === current) return 'current checkout';
  if (wt.locked) return 'locked';
  if (!existsSync(path)) return 'directory missing; run `git worktree prune` if it was deleted on purpose';
  // Independent of user config such as status.showUntrackedFiles=no.
  const status = makeGit(path)('-c', 'status.showUntrackedFiles=all', 'status', '--porcelain', '--ignored=matching', '--untracked-files=all').split('\n').filter(Boolean);
  if (makeGit(path)('ls-files', '-v').split('\n').some((l) => /^[a-zS] /.test(l))) return 'files hidden by skip-worktree/assume-unchanged';
  if (status.some((l) => !l.startsWith('!! '))) return 'uncommitted changes';
  const own = status.map((l) => l.slice(3)).filter((f) => !DISPOSABLE.test(f));
  if (own.length) return `ignored files of its own: ${own.slice(0, 3).join(', ')}${own.length > 3 ? ', …' : ''}`;
  return null;
}

export function plan(git, { root, base = 'origin/main', now = Date.now(), mergedHeads = new Map() } = {}) {
  try { git('rev-parse', '--verify', '--quiet', `${base}^{commit}`); } catch { throw new Error(`${base} not found: run \`git fetch origin\` first`); }
  const heads = mergedHeads ?? new Map();
  const prMerged = (ref, name) => heads.get(name) === git('rev-parse', ref);
  const current = resolve(git('rev-parse', '--show-toplevel'));
  const worktrees = parseWorktrees(git('worktree', 'list', '--porcelain'));
  const branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter((b) => b && b !== 'main');
  const merged = new Map(branches.map((b) => [b, prMerged(b, b)]));
  const actions = [];
  const keepBranch = new Set([worktrees[0]?.branch].filter(Boolean)); // whatever the main checkout has out

  for (const wt of worktrees.slice(1)) { // the first entry is the main checkout
    const reason = !wt.branch ? 'detached HEAD' : !merged.get(wt.branch) ? 'no PR merged into main at this tip' : worktreeKeepReason(wt, current);
    if (reason) { if (wt.branch) keepBranch.add(wt.branch); actions.push({ kind: 'worktree', target: wt.path, action: 'KEEP', reason }); }
    else actions.push({ kind: 'worktree', target: wt.path, action: 'DONE', reason: `${wt.branch}: PR merged into main` });
  }
  for (const b of branches) {
    if (keepBranch.has(b)) actions.push({ kind: 'branch', target: b, action: 'KEEP', reason: 'worktree kept' });
    else if (merged.get(b)) actions.push({ kind: 'branch', target: b, action: 'DONE', reason: 'PR merged into main at this tip', sha: git('rev-parse', b) });
    else if (looksMerged(git, b, base)) actions.push({ kind: 'branch', target: b, action: 'REVIEW', reason: 'changes appear in main but no merged PR matches; delete by hand if done' });
    else actions.push({ kind: 'branch', target: b, action: 'KEEP', reason: 'open' });
  }

  const tmp = join(root, '.tmp');
  const removedBranches = actions.filter((a) => a.kind === 'branch' && a.action === 'DONE').map((a) => a.target);
  const removedWorktrees = new Set(actions.filter((a) => a.kind === 'worktree' && a.action === 'DONE').map((a) => resolve(a.target)));
  const keptWorktrees = worktrees.slice(1).map((w) => resolve(w.path)).filter((p) => !removedWorktrees.has(p));
  const live = new Set(branches.filter((b) => !removedBranches.includes(b)).map((b) => b.split('/').pop()));
  for (const slug of existsSync(tmp) ? readdirSync(tmp) : []) {
    const dir = join(tmp, slug);
    if (!statSync(dir).isDirectory()) continue;
    const owner = removedBranches.find((b) => b.split('/').pop() === slug);
    let action = 'KEEP', reason;
    if (slug === 'agent-workflows') reason = 'engineering-workflow handoffs are finalized by a human';
    else if (keptWorktrees.some((p) => p === resolve(dir) || p.startsWith(resolve(dir) + sep))) reason = 'holds a worktree that is kept';
    else if (live.has(slug)) reason = 'a branch with this slug is still open';
    else if (owner) { action = 'DONE'; reason = `${owner}: PR merged into main (check for files added after the merge)`; }
    else {
      const days = Math.floor((now - statSync(dir).mtimeMs) / 86_400_000);
      action = 'REVIEW'; reason = days >= STALE_DAYS ? `no branch, untouched ${days} days` : 'no matching branch';
    }
    actions.push({ kind: 'tmp', target: dir, action, reason });
  }

  const remote = git('for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin').split('\n')
    .filter((r) => r && r !== 'origin' && r !== 'origin/HEAD' && r !== base)
    .map((r) => r.replace(/^origin\//, '')).filter((name) => prMerged(`origin/${name}`, name));
  return { actions, remote, prData: mergedHeads !== null };
}

/** Commands a human can run to remove the DONE entries; printed, never executed. */
export function removalCommands(actions) {
  // Single quotes stop $ and ` expansion in bash and PowerShell; they escape ' differently, so a path
  // containing ' is printed as a comment to quote by hand.
  const q = (s) => (/[^\w./:@-]/.test(s) ? `'${s}'` : s);
  // update-ref with the expected SHA refuses to delete a branch that moved after this report.
  return actions.filter((a) => a.action === 'DONE').map((a) => {
    const cmd = a.kind === 'worktree' ? `git worktree remove ${q(a.target)}` : a.kind === 'branch' ? `git update-ref -d ${q(`refs/heads/${a.target}`)} ${a.sha}` : `rm -r ${q(a.target)}`;
    return a.target.includes("'") ? `# quote by hand: ${cmd}` : cmd;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--apply')) { console.error('cleanup: report only; there is no --apply. Run the printed commands after checking them.'); process.exit(2); }
  try {
    const git = makeGit(process.cwd());
    const root = dirname(resolve(git('rev-parse', '--path-format=absolute', '--git-common-dir')));
    if (args.has('--fetch')) git('fetch', 'origin', '--prune');
    const { actions, remote, prData } = plan(git, { root, mergedHeads: loadMergedHeads(process.cwd()) });
    for (const a of actions) console.log(`${a.action.padEnd(6)} ${a.kind.padEnd(8)} ${a.target}  (${a.reason})`);
    if (!prData) console.log('\n`gh` unavailable or not signed in: no merged-PR evidence, so nothing is DONE.');
    const cmds = removalCommands(actions);
    if (cmds.length) console.log(`\nTo remove the DONE entries (check them first; this script deletes nothing):\n${cmds.map((c) => `  ${c}`).join('\n')}`);
    if (remote.length) console.log(`\nRemote branches whose merged PR head is their tip (delete only with the owner's approval):\n  git push origin --delete ${remote.join(' ')}`);
    if (!cmds.length && !remote.length) console.log('\nNothing to clean up.');
  } catch (err) {
    console.error(`cleanup: ${String(err.stderr || err.message).trim().split('\n')[0]}`); process.exit(1);
  }
}
