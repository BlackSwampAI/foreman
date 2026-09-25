import assert from 'node:assert/strict';
import { test } from 'vitest';
import { codexCliArgs } from './cli-args.mjs';

test('Codex continuation keeps global sandbox policy before exec resume', () => {
  const initial = codexCliArgs('gpt-6-sol', { persistentContext: true });
  const resumed = codexCliArgs('gpt-6-sol', { persistentContext: true, sessionId: 'session-fixture' });
  assert.deepEqual(initial.slice(0, 5), ['--ask-for-approval', 'never', '--sandbox', 'read-only', 'exec']);
  assert.deepEqual(resumed.slice(0, 7), ['--ask-for-approval', 'never', '--sandbox', 'read-only', 'exec', 'resume', 'session-fixture']);
  assert.equal(resumed.at(-1), '-');
  assert.ok(!resumed.includes('--ephemeral'));
  assert.ok(resumed.includes('--ignore-user-config'));
});

test('Codex Worker and Reviewer retain their sandbox policies', () => {
  const worker = codexCliArgs('gpt-6-sol');
  const reviewer = codexCliArgs('gpt-6-sol', { reviewer: true });
  assert.deepEqual(worker.slice(0, 5), ['--ask-for-approval', 'never', '--sandbox', 'workspace-write', 'exec']);
  assert.deepEqual(reviewer.slice(0, 5), ['--ask-for-approval', 'never', '--sandbox', 'read-only', 'exec']);
  assert.ok(worker.includes('--ephemeral'));
  assert.ok(reviewer.includes('--ignore-rules'));
});
