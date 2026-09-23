// Pure helpers for keeping interactive UHP roles in separate CLI contexts.
// Session ids are accepted only from a completed response carrying the exact
// same run, role, harness, model, and project binding.
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

const MAX_ID = 200;
const MAX_SESSION_ID = 512;
const BINDING_FIELDS = ['run_id', 'role_id', 'harness_id', 'model', 'project_id'];

function requiredText(value, field, max = MAX_ID) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`invalid_${field}`);
  }
  return value.trim();
}

function firstDefined(object, ...names) {
  for (const name of names) if (object?.[name] !== undefined) return object[name];
  return undefined;
}

/** Return the canonical identity that scopes a persistent role conversation. */
export function roleSessionBinding(value = {}) {
  const binding = {
    run_id: requiredText(firstDefined(value, 'run_id', 'runId'), 'run_id'),
    role_id: requiredText(firstDefined(value, 'role_id', 'roleId'), 'role_id'),
    harness_id: requiredText(firstDefined(value, 'harness_id', 'harnessId'), 'harness_id'),
    model: requiredText(value.model, 'model'),
    project_id: requiredText(firstDefined(value, 'project_id', 'projectId'), 'project_id'),
  };
  return binding;
}

/** Create a stable, opaque state directory for one exact role/run binding. */
export function roleStatePath(rootDir, value) {
  if (typeof rootDir !== 'string' || !rootDir || !isAbsolute(rootDir)) throw new TypeError('role_state_root_must_be_absolute');
  const binding = roleSessionBinding(value);
  const digest = createHash('sha256').update(JSON.stringify(BINDING_FIELDS.map(field => binding[field]))).digest('hex');
  return join(resolve(rootDir), 'role-sessions', digest);
}

function sessionRecord(response) {
  return response?.metadata?.role_session;
}

/**
 * Resolve a UHP previous_response_id into the exact native CLI conversation.
 * `responses` is the server's persisted response map. A missing id starts a
 * new context; a supplied id is rejected unless the completed response proves
 * the exact expected binding and a native session id.
 */
export function resolvePreviousRoleSession({ previousResponseId, responses, expectedBinding, rootDir }) {
  const binding = roleSessionBinding(expectedBinding);
  const statePath = roleStatePath(rootDir, binding);
  if (previousResponseId === undefined || previousResponseId === null || previousResponseId === '') {
    return { continuation: false, state_path: statePath };
  }
  const responseId = requiredText(previousResponseId, 'previous_response_id');
  const prior = responses instanceof Map ? responses.get(responseId) : responses?.[responseId];
  if (!prior || prior.id !== responseId || prior.status !== 'completed') throw new Error('previous_response_not_completed');
  const session = sessionRecord(prior);
  if (!session || !sameBinding(session.binding, binding)) throw new Error('previous_response_binding_mismatch');
  if (session.state_path !== statePath) throw new Error('previous_response_state_path_mismatch');
  const sessionId = requiredText(session.cli_session_id, 'cli_session_id', MAX_SESSION_ID);
  return { continuation: true, previous_response_id: responseId, session_id: sessionId, state_path: statePath };
}

/** Return a response copy with controller-owned role session metadata added. */
export function withRoleSession(response, { binding: rawBinding, sessionId, rootDir }) {
  const binding = roleSessionBinding(rawBinding);
  const statePath = roleStatePath(rootDir, binding);
  const cliSessionId = requiredText(sessionId, 'cli_session_id', MAX_SESSION_ID);
  return {
    ...response,
    metadata: {
      ...(response?.metadata ?? {}),
      role_session: { binding, cli_session_id: cliSessionId, state_path: statePath },
    },
  };
}

function sameBinding(left, right) {
  try {
    const normalized = roleSessionBinding(left);
    return BINDING_FIELDS.every(field => normalized[field] === right[field]);
  } catch {
    return false;
  }
}
