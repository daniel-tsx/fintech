import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAmount, formatMoney, formatTime } from './format.ts';

test('minor units keep their exact value for each currency exponent', () => {
  assert.equal(formatAmount('10000', 'USD'), '100.00');
  assert.equal(formatAmount('7', 'USD'), '0.07');
  assert.equal(formatAmount('1500', 'JPY'), '1,500');
  assert.equal(formatAmount('250000', 'VND'), '250,000');
  assert.equal(formatAmount('1500', 'CLP'), '1,500');
  assert.equal(formatAmount('1234', 'BHD'), '1.234');
  assert.equal(formatAmount('-305', 'EUR'), '-3.05');
  assert.equal(formatAmount(0, 'USD'), '0.00');
});

test('amounts beyond 2^53 are not rounded', () => {
  assert.equal(formatAmount('900719925474099312', 'USD'), '9,007,199,254,740,993.12');
});

test('non-integer input is shown raw instead of guessed', () => {
  assert.equal(formatAmount('12.5', 'USD'), '12.5');
  assert.equal(formatMoney('100', 'USD'), 'USD 1.00');
});

test('timestamps render in one UTC format with seconds', () => {
  assert.equal(formatTime('2026-10-24T07:15:36.187Z'), '2026-10-24 07:15:36 UTC');
  assert.equal(formatTime(null), '—');
  assert.equal(formatTime('not a date'), 'not a date');
});
