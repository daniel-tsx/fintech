import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTestDiff, guardFiles, skipReason, t2Files } from './check-pr-review-signals.mjs';

// Keywords are split so this file never trips the guard itself.
const ONLY = 'it' + '.only', SKIP = 'describe' + '.skip', WEAK = 'toBe' + 'Defined';
const diff = (file, ...lines) => [`--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', ...lines].join('\n');
const SPEC = 'apps/api/test/unit/ledger.spec.ts';

test('T2 paths are detected; others are not', () => {
  assert.deepEqual(t2Files([
    'apps/api/drizzle/0012_x.sql', 'apps/api/src/ledger/ledger.service.ts', 'apps/api/src/payment-command-worker.ts',
    'apps/web/app/page.tsx', 'apps/api/src/observability/logger.ts', 'docs/ledger.md',
  ]), ['apps/api/drizzle/0012_x.sql', 'apps/api/src/ledger/ledger.service.ts', 'apps/api/src/payment-command-worker.ts']);
});

test('shared high-risk infrastructure and runtime wiring are T2; other shared code is not', () => {
  const files = [
    'apps/api/src/common/idempotency.service.ts', 'apps/api/src/common/hash.ts', 'apps/api/src/app.module.ts',
    'apps/api/src/worker-app.module.ts', 'apps/api/src/common/correlation.middleware.ts', 'apps/api/src/common/domain-error.ts',
    '.github/workflows/ci.yml', 'scripts/check-migration-history.mjs', 'scripts/sync-agent-skills.mjs',
  ];
  assert.deepEqual(t2Files(files), files.slice(0, 4));
  assert.deepEqual(guardFiles(files), ['.github/workflows/ci.yml', 'scripts/check-migration-history.mjs']);
});

test('ordinary new tests pass', () => {
  assert.deepEqual(analyzeTestDiff(diff(SPEC, "+it('posts a balanced journal', () => { expect(1).toBe(1); })")), { errors: [], removedTests: [], assertionSignals: [], skipsAdded: [] });
});

test('focused test fails', () => {
  assert.match(analyzeTestDiff(diff(SPEC, `+${ONLY}('x', () => {})`)).errors.join(), /focused/);
});

test('env-gated suite aliases pass silently', () => {
  for (const line of [
    `const d = process.env.RUN_DB_TESTS === '1' ? describe : ${SKIP};`,
    `const d=process.env.RUN_DB_TESTS==='1'&&process.env.RUN_MIGRATION_TESTS==='1'?describe:${SKIP};`,
  ]) assert.deepEqual(analyzeTestDiff(diff(SPEC, `+${line}`)), { errors: [], removedTests: [], assertionSignals: [], skipsAdded: [] }, line);
});

test('a skip with an allow-skip comment passes but is listed for the human', () => {
  const r = analyzeTestDiff(diff(SPEC, `+${SKIP}('x', () => {}); // allow-skip: Stripe test-mode outage`));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.skipsAdded.map((s) => s.reason), ['Stripe test-mode outage']);
});

test('mentioning process.env or allow-skip does not bypass the skip guard', () => {
  for (const line of [
    `${SKIP}('x', () => {})`,
    `${SKIP}('x', () => {}); // process.env`,
    `${SKIP}(process.env.CI ? 'a' : 'b', () => {})`,
    `const d = process.env.NEVER === 'x' ? describe : ${SKIP};`,
    `const d = process.env.RUN_DB_TESTS === '1' || true ? describe : ${SKIP};`,
    `${SKIP}('x', () => {}); // allow-skip:`,
    `${SKIP}('x', () => {}); // allow-skip:   `,
    `${SKIP}('allow-skip: this is a title, not a comment', () => {})`,
  ]) {
    assert.equal(skipReason(line), null, line);
    assert.match(analyzeTestDiff(diff(SPEC, `+${line}`)).errors.join(), /skipped/, line);
  }
});

test('net assertion removal and weak matchers are surfaced, not blocking', () => {
  const r = analyzeTestDiff(diff(SPEC,
    "-  expect(result.status).toBe('CAPTURED');", "-  expect(journal.lines).toHaveLength(2);",
    `+  expect(result).${WEAK}();`));
  assert.deepEqual(r.errors, []);
  assert.match(r.assertionSignals.join('\n'), /1 assertion\(s\) removed net \(2 removed, 1 added\)/);
  assert.match(r.assertionSignals.join('\n'), /weak matcher added: expect\(result\)\.toBeDefined\(\)/);
  assert.deepEqual(analyzeTestDiff(diff(SPEC, "-  expect(a).toBe(1);", "+  expect(a).toBe(2);")).assertionSignals, []);
});

test('skips outside test files are ignored', () => {
  assert.deepEqual(analyzeTestDiff(diff('apps/api/src/ledger/a.ts', `+${SKIP}('x')`)).errors, []);
});

test('removed test cases are listed, renamed-in-place ones are not', () => {
  const r = analyzeTestDiff(diff(SPEC, "-it('rejects unbalanced journals', () => {})", "-it('kept title', () => {})", "+it('kept title', () => { /* edited */ })"));
  assert.deepEqual(r.removedTests, [{ file: SPEC, title: 'rejects unbalanced journals' }]);
});
