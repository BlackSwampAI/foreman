import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptIdFor, comparisonClientTimeouts, parseAttemptCount, parseAttemptId, parseComparisonTimeoutSeconds } from '../attempts.mjs';

test('attempt count is bounded and defaults to one', () => {
  assert.equal(parseAttemptCount(), 1);
  assert.equal(parseAttemptCount('10'), 10);
  for (const value of ['0', '11', '1.5', 'NaN', '']) assert.throws(() => parseAttemptCount(value));
});

test('attempt IDs are stable, explicit, and bounded by prepared count', () => {
  assert.equal(attemptIdFor(1), 'attempt-001');
  assert.equal(attemptIdFor(10), 'attempt-010');
  assert.equal(parseAttemptId('attempt-002', 3), 'attempt-002');
  for (const value of ['attempt-000', 'attempt-011', 'attempt-001x', '../attempt-001']) assert.throws(() => parseAttemptId(value, 10));
  assert.throws(() => parseAttemptId('attempt-003', 2));
});

test('AGY comparison timeout fits UHP request bounds and caps CLI runtime at 110 seconds', () => {
  assert.equal(parseComparisonTimeoutSeconds(), 110);
  assert.equal(parseComparisonTimeoutSeconds('60'), 60);
  assert.deepEqual(comparisonClientTimeouts(110), { timeoutMs: 120_000, streamInactivityTimeoutMs: 120_000 });
  assert.deepEqual(comparisonClientTimeouts(60), { timeoutMs: 120_000, streamInactivityTimeoutMs: 70_000 });
  for (const value of ['0', '111', '1.5', 'NaN', '']) assert.throws(() => parseComparisonTimeoutSeconds(value));
  assert.throws(() => comparisonClientTimeouts(111));
});
