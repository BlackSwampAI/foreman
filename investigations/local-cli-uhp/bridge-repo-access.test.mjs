import assert from 'node:assert/strict';
import { test, describe } from 'vitest';
import { claudeCodeCliArgs } from './cli-args.mjs';
import { bwrapBaseArgs } from './bwrap-args.mjs';

describe('claudeCodeCliArgs — persistent context (planner / orchestrator)', () => {
  test('persistentContext=true → --permission-mode plan and --tools Read,Grep,Glob', () => {
    const args = claudeCodeCliArgs('claude-sonnet', { persistentContext: true });
    const pmIdx = args.indexOf('--permission-mode');
    assert.ok(pmIdx >= 0, '--permission-mode flag present');
    assert.equal(args[pmIdx + 1], 'plan');
    const toolsIdx = args.indexOf('--tools');
    assert.ok(toolsIdx >= 0, '--tools flag present');
    assert.equal(args[toolsIdx + 1], 'Read,Grep,Glob');
  });

  test('persistentContext=false (worker) → --permission-mode acceptEdits and --tools Read,Edit,Write', () => {
    const args = claudeCodeCliArgs('claude-sonnet', { persistentContext: false });
    const pmIdx = args.indexOf('--permission-mode');
    assert.equal(args[pmIdx + 1], 'acceptEdits');
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Edit,Write');
  });

  test('session resume flag is included when sessionId is set', () => {
    const args = claudeCodeCliArgs('claude-sonnet', { persistentContext: true, sessionId: 'ses-abc' });
    const resumeIdx = args.indexOf('--resume');
    assert.ok(resumeIdx >= 0, '--resume flag present');
    assert.equal(args[resumeIdx + 1], 'ses-abc');
  });

  test('reviewer mode → --permission-mode plan, empty --tools, --safe-mode', () => {
    const args = claudeCodeCliArgs('claude-sonnet', { reviewer: true, maxStep: 10 });
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(args.includes('--safe-mode'));
  });
});

describe('bwrapBaseArgs — workspace mount mode', () => {
  const ws = { dir: '/tmp/test-workspace', authDir: '/tmp/test-auth' };

  test('readOnlyWorkspace=false → --bind for workspace dir', () => {
    const args = bwrapBaseArgs(ws, [], false);
    // The token just before /workspace (index N-1 is ws.dir, N-2 is the flag)
    const workspaceIdx = args.indexOf('/workspace');
    assert.ok(workspaceIdx >= 0, '/workspace present');
    assert.equal(args[workspaceIdx - 2], '--bind', 'workspace mounted writable');
    assert.equal(args[workspaceIdx - 1], ws.dir);
  });

  test('readOnlyWorkspace=true → --ro-bind for workspace dir', () => {
    const args = bwrapBaseArgs(ws, [], true);
    const workspaceIdx = args.indexOf('/workspace');
    assert.ok(workspaceIdx >= 0, '/workspace is present in args');
    assert.equal(args[workspaceIdx - 2], '--ro-bind', 'workspace mounted read-only');
    assert.equal(args[workspaceIdx - 1], ws.dir);
  });

  test('auth dir is still mounted with --ro-bind when mountAuth=true', () => {
    const args = bwrapBaseArgs(ws, [], true, true);
    const authIdx = args.indexOf('/auth');
    assert.ok(authIdx >= 0);
    assert.equal(args[authIdx - 1], ws.authDir);
    assert.equal(args[authIdx - 2], '--ro-bind');
  });

  test('mountAuth=false omits the auth mount', () => {
    const args = bwrapBaseArgs(ws, [], false, false);
    assert.ok(!args.includes('/auth'), 'no /auth mount when mountAuth=false');
  });
});

describe('foreman_read_only_workspace_id validation logic', () => {
  // Unit test the validation condition inline (the bridge implements this at submission time)
  function validateRoWorkspace(roWorkspaceId, workspaces) {
    if (roWorkspaceId && !workspaces.has(roWorkspaceId)) {
      return { code: 409, body: { error: { code: 'workspace_required', message: 'foreman_read_only_workspace_id references an unknown workspace' } } };
    }
    return null;
  }

  test('unknown foreman_read_only_workspace_id → 409 workspace_required', () => {
    const ws = new Map([['known-ws', { dir: '/tmp/known' }]]);
    const result = validateRoWorkspace('unknown-ws-xyz', ws);
    assert.equal(result?.code, 409);
    assert.equal(result?.body.error.code, 'workspace_required');
  });

  test('known foreman_read_only_workspace_id → no error', () => {
    const ws = new Map([['known-ws', { dir: '/tmp/known' }]]);
    const result = validateRoWorkspace('known-ws', ws);
    assert.equal(result, null);
  });

  test('absent foreman_read_only_workspace_id (undefined) → no error', () => {
    const ws = new Map();
    assert.equal(validateRoWorkspace(undefined, ws), null);
  });
});
