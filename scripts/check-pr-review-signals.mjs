#!/usr/bin/env node
// PR review signals: flags T2-area files so a human knows which PRs need a deep read,
// rejects focused or newly skipped tests, and lists removed test cases.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Paths whose changes are T2 (AGENTS.md#task-size) regardless of the size the PR claims.
export const T2_PATHS = [
  /^apps\/api\/drizzle\//,
  /^apps\/api\/src\/(audit|auth|balances|database|disputes|jobs|ledger|outbox|payment-commands|payment-provider|payments|payouts|rabbitmq|reconciliation|refunds|settlements|webhooks)\//,
  /^apps\/api\/src\/[^/]*(worker|relay)[^/]*\.ts$/,
];
const TEST_FILE = /(^|\/)test\/|\.(spec|test)\.[cm]?[jt]sx?$/;
const FOCUS = /\b(?:it|test|describe)\.only\b|\bf(?:it|describe)\(/;
const SKIP = /\b(?:it|test|describe)\.skip\b|\bx(?:it|test|describe)\(/;
// Environment-gated suites (RUN_DB_TESTS ? describe : describe.skip) and explicit opt-outs are allowed.
const ALLOWED_SKIP = /process\.env|allow-skip:/;
const TITLE = /\b(?:it|test)\(\s*(['"`])(.+?)\1/;

export function t2Files(files) {
  return files.filter((f) => T2_PATHS.some((re) => re.test(f)));
}

/** diff: `git diff --unified=0` text. Returns { errors, removedTests }. */
export function analyzeTestDiff(diff) {
  const errors = [], added = new Set(), removed = [];
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
    if (line.startsWith('--- ') || !file || !TEST_FILE.test(file)) continue;
    const body = line.slice(1);
    if (line.startsWith('+')) {
      if (FOCUS.test(body)) errors.push(`${file}: focused test added: ${body.trim()}`);
      else if (SKIP.test(body) && !ALLOWED_SKIP.test(body)) errors.push(`${file}: skipped test added (add "allow-skip: <reason>" if intended): ${body.trim()}`);
      const t = body.match(TITLE); if (t) added.add(t[2]);
    } else if (line.startsWith('-')) {
      const t = body.match(TITLE); if (t) removed.push({ file, title: t[2] });
    }
  }
  return { errors, removedTests: removed.filter((r) => !added.has(r.title)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  if (!base) { console.error('Usage: node scripts/check-pr-review-signals.mjs <base-ref> [head-ref]'); process.exit(2); }
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 << 20 });
  const files = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
  const t2 = t2Files(files);
  const { errors, removedTests } = analyzeTestDiff(git('diff', '--unified=0', '--no-color', base, head));
  const lines = ['## Review signals', ''];
  lines.push(t2.length ? `**T2 area touched** — read these files carefully:\n${t2.map((f) => `- \`${f}\``).join('\n')}` : 'No T2-area files changed.');
  if (removedTests.length) lines.push('', `**Removed test cases** — confirm each removal is intended:\n${removedTests.map((r) => `- \`${r.file}\`: ${r.title}`).join('\n')}`);
  if (errors.length) lines.push('', `**Blocking test changes:**\n${errors.map((e) => `- ${e}`).join('\n')}`);
  const report = lines.join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `t2=${t2.length ? 'true' : 'false'}\n`);
  for (const r of removedTests) console.log(`::warning file=${r.file}::Removed test case: ${r.title}`);
  process.exit(errors.length ? 1 : 0);
}
