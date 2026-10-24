import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeStatus } from './status.ts';

test('captured, settled and paid out never share a tone or label', () => {
  const captured = describeStatus('CAPTURED');
  const settled = describeStatus('SUCCEEDED', 'settlement');
  const paid = describeStatus('SUCCEEDED', 'payout');
  assert.deepEqual([captured, settled, paid], [
    { tone: 'captured', label: 'captured' },
    { tone: 'settled', label: 'settled' },
    { tone: 'paid', label: 'paid out' },
  ]);
});

test('in-flight provider outcomes stay unknown, never success or failure', () => {
  assert.deepEqual(describeStatus('PROCESSING', 'attempt'), { tone: 'pending', label: 'processing · outcome unknown' });
  for (const value of ['PENDING', 'CAPTURE_PENDING', 'REQUIRES_AUTHORIZATION']) assert.equal(describeStatus(value).tone, 'pending');
});

test('generic success is not a money state, and unknown values stay neutral', () => {
  assert.equal(describeStatus('SUCCEEDED', 'attempt').tone, 'done');
  assert.equal(describeStatus('SOMETHING_NEW').tone, 'neutral');
});
