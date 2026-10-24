#!/usr/bin/env node
// Append-only guard for apps/api/drizzle: existing SQL migrations and snapshots are
// byte-identical, and existing journal entries are an unchanged prefix of the new journal.
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

export const DIR = 'apps/api/drizzle';
const JOURNAL = `${DIR}/meta/_journal.json`;

/** base/head: Map of repo-relative path -> file text. Returns a list of problems. */
export function checkMigrationHistory(base, head) {
  const problems = [];
  for (const [path, text] of base) {
    if (path === JOURNAL) continue;
    if (!head.has(path)) problems.push(`Deleted or renamed: ${path}`);
    else if (head.get(path) !== text) problems.push(`Modified: ${path}`);
  }
  if (!base.has(JOURNAL)) return problems;
  if (!head.has(JOURNAL)) return [...problems, `Deleted: ${JOURNAL}`];
  let before, after;
  try { before = JSON.parse(base.get(JOURNAL)); after = JSON.parse(head.get(JOURNAL)); }
  catch { return [...problems, `Unparseable: ${JOURNAL}`]; }
  if (before.version !== after.version || before.dialect !== after.dialect) problems.push('Journal version or dialect changed');
  const old = before.entries ?? [], next = after.entries ?? [];
  old.forEach((entry, i) => {
    if (!isDeepStrictEqual(entry, next[i])) problems.push(`Journal entry ${i} (${entry.tag}) was changed, removed or reordered`);
  });
  let latest = Math.max(0, ...old.map((entry) => entry.when ?? 0));
  for (let i = old.length; i < next.length; i++) {
    const entry = next[i];
    // drizzle-orm's migrator silently skips an entry whose `when` is not newer than the last applied one.
    if (!(entry.when > latest)) problems.push(`New journal entry ${entry.tag} has when ${entry.when}, which must be greater than ${latest}`);
    latest = Math.max(latest, entry.when ?? 0);
    if (entry.idx !== i) problems.push(`New journal entry ${entry.tag} has idx ${entry.idx}, expected ${i}`);
    if (!head.has(`${DIR}/${entry.tag}.sql`)) problems.push(`New journal entry ${entry.tag} has no ${DIR}/${entry.tag}.sql`);
  }
  return problems;
}

function filesAt(ref) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  const names = git('ls-tree', '-r', '--name-only', ref, '--', DIR).split('\n').filter(Boolean);
  return new Map(names.map((name) => [name, git('show', `${ref}:${name}`)]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [baseRef, headRef = 'HEAD'] = process.argv.slice(2);
  if (!baseRef) { console.error('Usage: node scripts/check-migration-history.mjs <base-ref> [head-ref]'); process.exit(2); }
  const problems = checkMigrationHistory(filesAt(baseRef), filesAt(headRef));
  if (problems.length) {
    console.error('Existing migrations are append-only. Add a new forward migration instead:');
    for (const p of problems) console.error(`- ${p}`);
    process.exit(1);
  }
  console.log(`Migration history is append-only (${baseRef}..${headRef})`);
}
