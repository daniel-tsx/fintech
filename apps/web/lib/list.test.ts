import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byMoney, countBy, hrefWith, matches, sortRows } from './list.ts';

test('hrefWith keeps the current query and applies the patch', () => {
  assert.equal(hrefWith('/payments', { q: 'abc', status: 'CAPTURED', page: '2' }, { status: undefined, page: undefined }), '/payments?q=abc');
  assert.equal(hrefWith('/payments', {}, {}), '/payments');
});

test('matches is a case-insensitive substring search', () => {
  assert.equal(matches('4444', ['44444444-4444-4444-8444-444444444444']), true);
  assert.equal(matches('NOTEBOOK', [null, 'Seeded notebook purchase']), true);
  assert.equal(matches('zzz', ['abc']), false);
  assert.equal(matches(undefined, []), true);
});

test('countBy keeps first-seen order', () => {
  assert.deepEqual(countBy(['CREATED', 'CAPTURED', 'CREATED'], (s) => s), [{ value: 'CREATED', count: 2 }, { value: 'CAPTURED', count: 1 }]);
});

test('money sorts by currency, then exact minor units, beyond 2^53', () => {
  const rows = [
    { amount: '900719925474099313', currency: 'USD' },
    { amount: '900719925474099312', currency: 'USD' },
    { amount: '1500', currency: 'JPY' },
  ];
  const sorted = sortRows(rows, { sort: 'amount', dir: 'asc' }, 'created', { amount: byMoney((r) => r) });
  assert.deepEqual(sorted.map((r) => r.amount), ['1500', '900719925474099312', '900719925474099313']);
});

test('the default sort keeps API order', () => {
  const rows = [{ id: 2 }, { id: 1 }];
  assert.equal(sortRows(rows, {}, 'created', { created: () => 0 }), rows);
});
