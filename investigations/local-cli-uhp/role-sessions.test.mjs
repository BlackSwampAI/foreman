import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test } from 'vitest';
import { resolvePreviousRoleSession, roleSessionBinding, roleStatePath, withRoleSession } from './role-sessions.mjs';

const binding = {
  run_id: 'run_1',
  role_id: 'planner',
  harness_id: 'claude-code',
  model: 'claude-sonnet',
  project_id: 'project_1',
};

test('canonical binding accepts camel case inputs and rejects incomplete scope', () => {
  assert.deepEqual(roleSessionBinding({ runId: 'run_1', roleId: 'planner', harnessId: 'claude-code', model: 'claude-sonnet', projectId: 'project_1' }), binding);
  assert.throws(() => roleSessionBinding({ ...binding, project_id: '' }), /invalid_project_id/);
  assert.throws(() => roleSessionBinding({ ...binding, role_id: 'planner\nother' }), /invalid_role_id/);
});

test('state path is stable per exact binding and stays below configured root', () => {
  const root = join(tmpdir(), 'foreman-role-state-root');
  const path = roleStatePath(root, binding);
  assert.equal(path, roleStatePath(root, { ...binding }));
  assert.notEqual(path, roleStatePath(root, { ...binding, role_id: 'orchestrator' }));
  assert.notEqual(path, roleStatePath(root, { ...binding, model: 'claude-opus' }));
  const rel = relative(root, path);
  assert.ok(rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
  assert.throws(() => roleStatePath('relative/root', binding), /absolute/);
});

test('a completed matching response yields its native session and persistent path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foreman-role-session-'));
  try {
    const statePath = roleStatePath(root, binding);
    const prior = withRoleSession({ id: 'resp_1', status: 'completed', metadata: { run_id: binding.run_id } }, { binding, sessionId: 'native-session-1', rootDir: root });
    const resolved = resolvePreviousRoleSession({ previousResponseId: 'resp_1', responses: { resp_1: prior }, expectedBinding: binding, rootDir: root });
    assert.deepEqual(resolved, { continuation: true, previous_response_id: 'resp_1', session_id: 'native-session-1', state_path: statePath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing previous response starts an isolated empty context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foreman-role-session-'));
  try {
    assert.deepEqual(resolvePreviousRoleSession({ responses: {}, expectedBinding: binding, rootDir: root }), {
      continuation: false,
      state_path: roleStatePath(root, binding),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only completed responses with an exact run/role/harness/model/project binding can continue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foreman-role-session-'));
  try {
    const matching = withRoleSession({ id: 'resp_1', status: 'completed' }, { binding, sessionId: 'native-1', rootDir: root });
    const reject = (response, expected = binding) => assert.throws(
      () => resolvePreviousRoleSession({ previousResponseId: response.id, responses: { [response.id]: response }, expectedBinding: expected, rootDir: root }),
    );
    reject({ ...matching, status: 'in_progress' });
    reject({ ...matching, status: 'failed' });
    for (const field of ['run_id', 'role_id', 'harness_id', 'model', 'project_id']) {
      reject(matching, { ...binding, [field]: `${binding[field]}-other` });
    }
    reject({ ...matching, metadata: { role_session: { ...matching.metadata.role_session, state_path: `${root}/elsewhere` } } });
    reject({ ...matching, metadata: { role_session: { ...matching.metadata.role_session, cli_session_id: '' } } });
    assert.throws(() => resolvePreviousRoleSession({ previousResponseId: 'resp_missing', responses: {}, expectedBinding: binding, rootDir: root }), /not_completed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('planner and orchestrator contexts are distinct even on the same harness/model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foreman-role-session-'));
  try {
    const planner = withRoleSession({ id: 'resp_planner', status: 'completed' }, { binding, sessionId: 'planner-native', rootDir: root });
    const orchestratorBinding = { ...binding, role_id: 'orchestrator' };
    assert.throws(() => resolvePreviousRoleSession({ previousResponseId: planner.id, responses: { [planner.id]: planner }, expectedBinding: orchestratorBinding, rootDir: root }), /binding_mismatch/);
    assert.notEqual(roleStatePath(root, binding), roleStatePath(root, orchestratorBinding));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
