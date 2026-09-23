import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLabel } from '../src/label.ts';

test('formatLabel includes the greeting and supplied name', () => {
  assert.equal(formatLabel('Ada'), 'Hello, Ada!');
});
