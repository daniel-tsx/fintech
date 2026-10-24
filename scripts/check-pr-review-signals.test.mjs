import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTestDiff, t2Files } from './check-pr-review-signals.mjs';

// Keywords are split so this file never trips the guard itself.
const ONLY = 'it' + '.only', SKIP = 'describe' + '.skip';
const diff = (file, ...lines) => [`--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@', ...lines].join('\n');
const SPEC = 'apps/api/test/unit/ledger.spec.ts';

test('T2 paths are detected; others are not', () => {
  assert.deepEqual(t2Files([
    'apps/api/drizzle/0012_x.sql', 'apps/api/src/ledger/ledger.service.ts', 'apps/api/src/payment-command-worker.ts',
    'apps/web/app/page.tsx', 'apps/api/src/observability/logger.ts', 'docs/ledger.md',
  ]), ['apps/api/drizzle/0012_x.sql', 'apps/api/src/ledger/ledger.service.ts', 'apps/api/src/payment-command-worker.ts']);
});

test('ordinary new tests pass', () => {
  assert.deepEqual(analyzeTestDiff(diff(SPEC, "+it('posts a balanced journal', () => {})")), { errors: [], removedTests: [] });
});

test('focused test fails', () => {
  assert.match(analyzeTestDiff(diff(SPEC, `+${ONLY}('x', () => {})`)).errors.join(), /focused/);
});

test('new skipped test fails unless env-gated or explicitly allowed', () => {
  assert.match(analyzeTestDiff(diff(SPEC, `+${SKIP}('x', () => {})`)).errors.join(), /skipped/);
  assert.deepEqual(analyzeTestDiff(diff(SPEC, `+const d = process.env.RUN_DB_TESTS === '1' ? describe : ${SKIP};`)).errors, []);
  assert.deepEqual(analyzeTestDiff(diff(SPEC, `+${SKIP}('x', () => {}); // allow-skip: flaky upstream`)).errors, []);
});

test('skips outside test files are ignored', () => {
  assert.deepEqual(analyzeTestDiff(diff('apps/api/src/ledger/a.ts', `+${SKIP}('x')`)).errors, []);
});

test('removed test cases are listed, renamed-in-place ones are not', () => {
  const r = analyzeTestDiff(diff(SPEC, "-it('rejects unbalanced journals', () => {})", "-it('kept title', () => {})", "+it('kept title', () => { /* edited */ })"));
  assert.deepEqual(r.removedTests, [{ file: SPEC, title: 'rejects unbalanced journals' }]);
});
