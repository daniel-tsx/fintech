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
  // Shared infrastructure that carries financial invariants: API idempotency and its payload hash.
  /^apps\/api\/src\/common\/(idempotency\.service|hash)\.ts$/,
  // Runtime module wiring: registering a dormant writer here is an activation.
  /^apps\/api\/src\/[^/]*app\.module\.ts$/,
];
// CI and the guards themselves: weakening them removes protection from every later PR. They get a
// separate `guard-change` label (independent review) rather than T2, which would demand financial reading.
export const GUARD_PATHS = [
  /^\.github\/workflows\//,
  /^scripts\/check-(migration-history|pr-review-signals)\.mjs$/,
];
const TEST_FILE = /(^|\/)test\/|\.(spec|test)\.[cm]?[jt]sx?$/;
const FOCUS = /\b(?:it|test|describe)\.only\b|\bf(?:it|describe)\(/;
const SKIP = /\b(?:it|test|describe)\.skip\b|\bx(?:it|test|describe)\(/;
// Allowed skips: the repository's env-gated suite alias, exactly
//   const describeDb = process.env.RUN_DB_TESTS === '1' [&& process.env.RUN_X === '1'] ? describe : describe.skip;
// or a trailing `// allow-skip: <reason>` comment. Allowed skips are always listed for the human reviewer.
const ENV_GATE = /^\s*const\s+\w+\s*=\s*process\.env\.RUN_[A-Z0-9_]+\s*===\s*'1'(?:\s*&&\s*process\.env\.RUN_[A-Z0-9_]+\s*===\s*'1')*\s*\?\s*(describe|it|test)\s*:\s*\1\.skip\s*;?\s*$/;
const ALLOW_SKIP = /\/\/\s*allow-skip:\s*(\S.*)$/;
export const isEnvGate = (line) => ENV_GATE.test(line);
export const skipReason = (line) => line.match(ALLOW_SKIP)?.[1].trim() ?? null;
const ASSERTION = /\bexpect\(|\bassert(?:\.\w+)?\(/g;
const WEAK_MATCHER = /\.(toBeDefined|toBeTruthy|toBeFalsy)\(\)|expect\.anything\(\)|\.toHaveBeenCalled\(\)/;
const TITLE = /\b(?:it|test)\(\s*(['"`])(.+?)\1/;

export function guardFiles(files) {
  return files.filter((f) => GUARD_PATHS.some((re) => re.test(f)));
}

export function t2Files(files) {
  return files.filter((f) => T2_PATHS.some((re) => re.test(f)));
}

/** diff: `git diff --unified=0` text. Returns { errors, removedTests, assertionSignals, skipsAdded }. */
export function analyzeTestDiff(diff) {
  const errors = [], added = new Set(), removed = [], counts = new Map(), weak = [], skipsAdded = [];
  const count = (file, key, body) => {
    const c = counts.get(file) ?? { added: 0, removed: 0 };
    c[key] += (body.match(ASSERTION) ?? []).length; counts.set(file, c);
  };
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
    if (line.startsWith('--- ') || !file || !TEST_FILE.test(file)) continue;
    const body = line.slice(1);
    if (line.startsWith('+')) {
      if (FOCUS.test(body)) errors.push(`${file}: focused test added: ${body.trim()}`);
      else if (SKIP.test(body) && !isEnvGate(body)) {
        const reason = skipReason(body);
        if (reason) skipsAdded.push({ file, reason, line: body.trim() });
        else errors.push(`${file}: skipped test added without the env-gate alias or a "// allow-skip: <reason>" comment: ${body.trim()}`);
      }
      if (WEAK_MATCHER.test(body)) weak.push({ file, line: body.trim() });
      count(file, 'added', body);
      const t = body.match(TITLE); if (t) added.add(t[2]);
    } else if (line.startsWith('-')) {
      count(file, 'removed', body);
      const t = body.match(TITLE); if (t) removed.push({ file, title: t[2] });
    }
  }
  const assertionSignals = [
    ...[...counts].filter(([, c]) => c.removed > c.added).map(([file, c]) => `${file}: ${c.removed - c.added} assertion(s) removed net (${c.removed} removed, ${c.added} added)`),
    ...weak.map((w) => `${w.file}: weak matcher added: ${w.line}`),
  ];
  return { errors, removedTests: removed.filter((r) => !added.has(r.title)), assertionSignals, skipsAdded };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  if (!base) { console.error('Usage: node scripts/check-pr-review-signals.mjs <base-ref> [head-ref]'); process.exit(2); }
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 << 20 });
  const files = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
  const t2 = t2Files(files), guards = guardFiles(files);
  const { errors, removedTests, assertionSignals, skipsAdded } = analyzeTestDiff(git('diff', '--unified=0', '--no-color', base, head));
  const lines = ['## Review signals', ''];
  lines.push(t2.length ? `**T2 area touched** — read these files carefully:\n${t2.map((f) => `- \`${f}\``).join('\n')}` : 'No T2-area files changed.');
  if (guards.length) lines.push('', `**CI or guard change** — needs an independent reviewer:\n${guards.map((f) => `- \`${f}\``).join('\n')}`);
  if (skipsAdded.length) lines.push('', `**Skips added** — approve each reason:\n${skipsAdded.map((s) => `- \`${s.file}\`: ${s.reason}`).join('\n')}`);
  if (removedTests.length) lines.push('', `**Removed test cases** — confirm each removal is intended:\n${removedTests.map((r) => `- \`${r.file}\`: ${r.title}`).join('\n')}`);
  if (assertionSignals.length) lines.push('', `**Assertion changes** — check that tests were not weakened:\n${assertionSignals.map((s) => `- ${s}`).join('\n')}`);
  if (errors.length) lines.push('', `**Blocking test changes:**\n${errors.map((e) => `- ${e}`).join('\n')}`);
  const report = lines.join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `t2=${t2.length ? 'true' : 'false'}\nguard=${guards.length ? 'true' : 'false'}\n`);
  for (const r of removedTests) console.log(`::warning file=${r.file}::Removed test case: ${r.title}`);
  for (const s of assertionSignals) console.log(`::warning::${s}`);
  for (const s of skipsAdded) console.log(`::warning file=${s.file}::Skip added: ${s.reason}`);
  process.exit(errors.length ? 1 : 0);
}
