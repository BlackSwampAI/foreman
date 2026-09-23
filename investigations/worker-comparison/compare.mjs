#!/usr/bin/env node
// AGY Worker diagnostic runner. Preparation is model-call-free.
// Every explicit attempt ID has its own fresh workspace, lock and evidence.
// Reports contain bounded evidence only: never raw CLI output or credentials.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Controller } from '../../dist/controller.js';
import { JsonStore } from '../../dist/store.js';
import { UhpClient } from '../../dist/uhp.js';
import { fetchBridgeSnapshot, validateWorkerOutput, verifyWorkerSnapshot } from '../../dist/verified-workspace.js';
import { attemptIdFor, comparisonClientTimeouts, parseAttemptCount, parseAttemptId, parseComparisonTimeoutSeconds } from './attempts.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = here;
const [mode, ...args] = process.argv.slice(2);
const usage = 'Usage: FOREMAN_WORKER_COMPARISON_ATTEMPTS=1..10 node compare.mjs --prepare-only <loopback-uhp-url> <disposable-repo> <base-sha> <agy-model> <agy-cli-version|unavailable>\n       node compare.mjs --execute-attempt antigravity-cli <attempt-001..010> <loopback-uhp-url> <disposable-repo> <base-sha> <agy-model> <agy-cli-version|unavailable>';
if (mode === '--help' || mode === '-h') { process.stdout.write(`${usage}\n`); process.exit(0); }
const executeHarness = mode === '--execute-attempt' ? args.shift() : undefined;
const attemptId = mode === '--execute-attempt' ? args.shift() : undefined;
const attemptCount = parseAttemptCount(process.env.FOREMAN_WORKER_COMPARISON_ATTEMPTS);
if (!['--prepare-only', '--execute-attempt'].includes(mode) || (mode === '--execute-attempt' && (executeHarness !== 'antigravity-cli' || !attemptId)) || args.length !== 5) throw new Error(usage);
if (mode === '--execute-attempt') parseAttemptId(attemptId, attemptCount);

const [baseUrl, repoArg, baseCommitArg, agyModel, agyCliVersion] = args;
const repoPath = resolve(repoArg);
const baseCommit = baseCommitArg.toLowerCase();
if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) throw new Error('A full Git base commit SHA is required');
if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/.*)?$/.test(baseUrl)) throw new Error('The UHP bridge URL must be loopback-only');
if (!agyModel.trim()) throw new Error('AGY model ID must be explicit and non-empty');
const allowedScope = ['src/label.ts', 'test/label.check.ts'];
const validationCommands = [{ name: 'pnpm test', command: 'pnpm', args: ['test'] }];
const taskText = await readFile(join(repoPath, 'TASK.txt'), 'utf8');
const taskDigest = createHash('sha256').update(taskText).digest('hex');
const baseModels = { 'antigravity-cli': agyModel };
const cliVersions = { 'antigravity-cli': agyCliVersion };
const stateDir = resolve(process.env.FOREMAN_WORKER_COMPARISON_STATE ?? join(tmpdir(), `foreman-worker-comparison-state-${baseCommit.slice(0, 12)}`));
const preparedPath = join(stateDir, 'prepared.json');
const evidenceDir = join(stateDir, 'evidence');
const statePath = join(stateDir, 'foreman-state.json');
const timeoutSeconds = parseComparisonTimeoutSeconds(process.env.FOREMAN_WORKER_COMPARISON_TIMEOUT_SECONDS);
const client = new UhpClient({ baseUrl, ...comparisonClientTimeouts(timeoutSeconds) });
const controller = new Controller(new JsonStore(statePath), client, false, true, undefined, undefined, 75);
controller.configureVerifiedWorkspace({
  repoPath,
  allowedScope,
  commands: validationCommands,
  bridgeBaseUrl: baseUrl,
  timeoutMs: 90_000,
  maxOutputBytes: 8_000,
});

async function checkBase() {
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    exec('git', ['-C', repoPath, 'rev-parse', 'HEAD']),
    exec('git', ['-C', repoPath, 'status', '--porcelain']),
  ]);
  if (head.trim().toLowerCase() !== baseCommit) throw new Error('Disposable repository HEAD does not match the supplied base SHA');
  if (status.trim()) throw new Error('Disposable repository must be clean before comparison preparation');
}

function modeDiscovery(discovery, harnessId, model) {
  const harness = discovery.harnesses.find(item => item.id === harnessId);
  const found = harness?.models?.find(item => item.id === model && item.available !== false)
    ?? discovery.models?.find(item => item.harnessId === harnessId && item.id === model && item.available !== false);
  if (!harness || !found) throw new Error(`Explicit ${harnessId} model '${model}' is not discoverable`);
  return harness;
}

function safeId(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160);
}
function safeVersion(value) {
  if (typeof value !== 'string' || !value || value.toLowerCase() === 'unavailable') return null;
  return value.replace(/[^A-Za-z0-9.+_-]/g, '').slice(0, 80) || null;
}
function safeScalar(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 100);
  return undefined;
}
function safeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:input|output|total|thinking|thought|cached|cache|request|prompt|completion|reasoning|candidate|tool|duration|elapsed)[A-Za-z0-9_]*$/i.test(key)) {
      if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
      else if (key === 'input_tokens_details' && item && typeof item === 'object' && Number.isFinite(item.cached_tokens)) result[key] = { cached_tokens: item.cached_tokens };
    }
  }
  return result;
}
function toolEvidence(metadata, harnessId) {
  const diagnostics = [metadata?.agy_diagnostic, metadata?.worker_diagnostic].filter(value => value && typeof value === 'object');
  const rawEvents = diagnostics.flatMap(value => [
    ...(Array.isArray(value.tool_events) ? value.tool_events : []),
    ...(Array.isArray(value.tool_steps) ? value.tool_steps : []),
    ...(Array.isArray(value.events) ? value.events : []),
    ...(Array.isArray(value.permission_events) ? value.permission_events.map(event => ({ ...event, type: 'permission_event' })) : []),
  ]);
  const events = rawEvents.map(event => ({
    ...(Number.isInteger(event.step_index) ? { stepIndex: event.step_index } : Number.isInteger(event.stepIndex) ? { stepIndex: event.stepIndex } : {}),
    ...(typeof event.type === 'string' ? { type: event.type.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 60) } : {}),
    ...(typeof event.name === 'string' ? { name: event.name.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) } : typeof event.tool_name === 'string' ? { name: event.tool_name.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) } : typeof event.toolName === 'string' ? { name: event.toolName.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) } : typeof event.tool === 'string' ? { name: event.tool.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) } : {}),
    ...(typeof event.state === 'string' ? { state: event.state.slice(0, 32) } : typeof event.status === 'string' ? { state: event.status.slice(0, 32) } : {}),
    ...(typeof event.severity === 'string' ? { severity: event.severity.slice(0, 32) } : {}),
    ...(typeof event.error_category === 'string' ? { errorCategory: event.error_category.slice(0, 60) } : {}),
    ...(typeof event.permission_outcome === 'string' ? { permissionOutcome: event.permission_outcome.slice(0, 60) } : {}),
    ...(typeof event.permission_denied === 'boolean' ? { permissionDenied: event.permission_denied } : {}),
  }));
  const permissions = {};
  for (const item of diagnostics) {
    for (const key of ['soft_denial_observed', 'execution_observations_passed', 'selected_agent_matches', 'executed_tools_within_profile']) {
      if (typeof item[key] === 'boolean') permissions[key] = item[key];
    }
    for (const key of ['permission_mode', 'requested_execution_mode', 'observed_agent', 'outcome']) {
      if (typeof item[key] === 'string') permissions[key] = item[key].slice(0, 100);
    }
  }
  const denied = metadata?.denied_actions;
  if (Array.isArray(denied)) permissions.deniedActionCount = denied.length;
  const diagnostic = diagnostics.at(-1) ?? {};
  const numeric = key => Number.isFinite(diagnostic[key]) ? diagnostic[key] : null;
  return {
    events,
    permissions: Object.keys(permissions).length ? permissions : { status: 'not_reported_by_bridge', harnessId },
    toolLifecycleUpdateCount: numeric('tool_lifecycle_update_count'),
    distinctToolStepCount: numeric('distinct_tool_step_count'),
    reportedCliTurns: numeric('reported_cli_turns'),
    terminalResultStatus: typeof diagnostic.result_status === 'string' ? diagnostic.result_status.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) : 'not_reported_by_bridge',
    responseCharacters: numeric('response_characters'),
  };
}
function failureCategory(error) {
  const text = String(error).toLowerCase();
  if (/auth|login|credential|oauth|api key/.test(text)) return 'authentication';
  if (/model|harness|unavailable|discover/.test(text)) return 'harness_or_model_unavailable';
  if (/timeout|timed out/.test(text)) return 'timeout';
  if (/permission|sandbox|isolation|workspace/.test(text)) return 'workspace_or_permission';
  if (/snapshot|scope|validation|test/.test(text)) return 'verification_or_validation';
  return 'transport_or_bridge';
}
function responseEnvelope(response, harnessId, submitted) {
  const metadata = response?.metadata ?? {};
  const actualModel = typeof response?.model === 'string' && response.model ? response.model : null;
  const actualModelStatus = actualModel ? 'observed' : metadata.actual_model_status === 'unavailable' ? 'unavailable' : 'unreported';
  const usage = safeUsage(response?.usage);
  const diagnosticUsage = safeUsage(metadata.cli_reported_usage ?? metadata.agy_usage_cumulative ?? metadata.reported_usage);
  const configuredInitModel = metadata.configured_init_model;
  const invocationArgs = metadata.cli_invocation?.args;
  const modelIndex = Array.isArray(invocationArgs) ? invocationArgs.findIndex((arg, index) => (arg === '--model' || arg === '-m') && typeof invocationArgs[index + 1] === 'string') : -1;
  const cliModelArgument = modelIndex >= 0 ? String(invocationArgs[modelIndex + 1]).slice(0, 120) : null;
  const effortIndex = Array.isArray(invocationArgs) ? invocationArgs.findIndex((arg, index) => arg === '--effort' && typeof invocationArgs[index + 1] === 'string') : -1;
  const cliEffortArgument = effortIndex >= 0 && ['low', 'medium', 'high'].includes(invocationArgs[effortIndex + 1]) ? invocationArgs[effortIndex + 1] : null;
  const toolAndPermissionEvidence = toolEvidence(metadata, harnessId);
  if (toolAndPermissionEvidence.responseCharacters === null && typeof response?.output_text === 'string') toolAndPermissionEvidence.responseCharacters = response.output_text.length;
  return {
    status: response?.status ?? submitted?.status ?? 'failed',
    harnessId,
    requestedModel: submitted?.requestedModel ?? response?.requested_model ?? metadata.requested_model ?? null,
    actualModelStatus,
    ...(actualModelStatus === 'observed' ? { actualModel } : {}),
    cliVersion: safeVersion(metadata.cli_version ?? metadata.harness_version) ?? submitted?.cliVersion ?? null,
    cliVersionSource: metadata.cli_version || metadata.harness_version ? 'bridge_reported' : submitted?.cliVersion ? 'provided_for_installed_host_cli' : 'unavailable',
    responseId: safeId(response?.id ?? submitted?.responseId),
    sessionId: safeId(response?.session_id ?? response?.sessionId ?? submitted?.sessionId),
    runtimeMs: Number.isFinite(submitted?.runtimeMs) ? submitted.runtimeMs : null,
    configuredInitModel: typeof configuredInitModel === 'string' ? configuredInitModel.slice(0, 120) : null,
    configuredInitModelStatus: typeof configuredInitModel === 'string' ? 'reported_by_bridge' : 'not_exposed_by_bridge',
    promptEvidence: { submittedPromptSha256: typeof metadata.submitted_prompt_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(metadata.submitted_prompt_sha256) ? metadata.submitted_prompt_sha256 : null, agyAgentDefinitionSha256: typeof metadata.agy_diagnostic?.agent_definition_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(metadata.agy_diagnostic.agent_definition_sha256) ? metadata.agy_diagnostic.agent_definition_sha256 : null },
    cliModelArgument,
    cliEffortArgument,
    cliModelArgumentMatchesRequest: cliModelArgument === (submitted?.requestedModel ?? response?.requested_model ?? metadata.requested_model ?? null),
    reportedUsage: { uhpUsageFields: usage, cliUsageFields: diagnosticUsage },
    providerRequestCount: 'unavailable',
    toolAndPermissionEvidence,
    executionBoundary: metadata.execution_boundary && typeof metadata.execution_boundary === 'object' ? {
      proven: metadata.execution_boundary.proven === true,
      workspaceWritable: metadata.execution_boundary.workspace_writable === true,
      hostAuthMountedReadOnly: metadata.execution_boundary.host_auth_mounted_read_only === true,
    } : null,
    executionStage: typeof metadata.execution_stage === 'string' ? metadata.execution_stage.slice(0, 80) : null,
  };
}
function summarizeChanges(changes) {
  return changes.map(change => ({
    kind: change.kind,
    path: change.path,
    ...(change.previousPath ? { previousPath: change.previousPath } : {}),
    ...(change.before ? { before: { kind: change.before.kind, executable: change.before.executable, bytes: Buffer.from(change.before.contentBase64, 'base64').length, sha256: createHash('sha256').update(Buffer.from(change.before.contentBase64, 'base64')).digest('hex') } } : {}),
    ...(change.after ? { after: { kind: change.after.kind, executable: change.after.executable, bytes: Buffer.from(change.after.contentBase64, 'base64').length, sha256: createHash('sha256').update(Buffer.from(change.after.contentBase64, 'base64')).digest('hex') } } : {}),
  }));
}
function checkTaskAcceptance(verified) {
  const changedPaths = verified.changes.map(change => change.path).sort();
  const expectedPaths = [...allowedScope].sort();
  const entries = new Map(verified.entries.map(entry => [entry.path, Buffer.from(entry.contentBase64, 'base64').toString('utf8')]));
  const source = entries.get('src/label.ts') ?? '';
  const test = entries.get('test/label.check.ts') ?? '';
  const sourceUpdated = /return\s+`Welcome,\s*\$\{name\}!`\s*;/.test(source);
  const testUpdated = /assert\.equal\(formatLabel\('Ada'\),\s*'Welcome, Ada!'\);/.test(test);
  const exactPaths = JSON.stringify(changedPaths) === JSON.stringify(expectedPaths);
  return { passed: exactPaths && sourceUpdated && testUpdated, exactPaths, changedPaths, expectedPaths, sourceUpdated, testUpdated };
}

async function persistReport(harnessId, report) {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const path = join(evidenceDir, `${harnessId}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return path;
}

if (mode === '--prepare-only') {
  await checkBase();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  try {
    const existing = JSON.parse(await readFile(preparedPath, 'utf8'));
    if (existing.baseUrl !== baseUrl || existing.repoPath !== repoPath || existing.baseCommit !== baseCommit || existing.taskDigest !== taskDigest || JSON.stringify(existing.models) !== JSON.stringify(baseModels) || existing.attemptCount !== attemptCount) throw new Error('Existing comparison preparation binds different inputs; use a fresh state directory');
    process.stdout.write(`${JSON.stringify({ status: 'already_prepared', preparationOnly: true, providerCalls: 0, attemptCount, baseCommit, workspaces: Object.fromEntries(Object.entries(existing.harnesses).map(([id, attempts]) => [id, attempts.map(item => ({ attemptId: item.attemptId, workspaceId: item.workspaceId }))])), execute: `FOREMAN_WORKER_COMPARISON_ATTEMPTS=${attemptCount} node compare.mjs --execute-attempt antigravity-cli attempt-001 ${baseUrl} ${repoPath} ${baseCommit} ${agyModel} ${agyCliVersion}` }, null, 2)}\n`);
    process.exit(0);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const discovery = await client.discover(true);
  if (discovery.capabilities.idempotency !== true || discovery.capabilities.streaming !== true) throw new Error('Bridge must advertise streaming and idempotency');
  const discovered = { 'antigravity-cli': modeDiscovery(discovery, 'antigravity-cli', agyModel) };
  await controller.refreshDiscovery();
  const project = await controller.createProject('Disposable identical Flash Worker comparison');
  const harnesses = {};
  for (const harnessId of ['antigravity-cli']) {
    harnesses[harnessId] = [];
    for (let index = 1; index <= attemptCount; index++) {
      const attempt = attemptIdFor(index);
      const task = await controller.createTask(project.id, 'Update the label greeting and its test');
      const run = await controller.createRun(task.id);
      const model = baseModels[harnessId];
      await controller.selectRoleConfig('worker', { harnessId, model }, undefined, run.id);
      const workspace = await controller.prepareWorkerWorkspace(run.id, baseCommit);
      harnesses[harnessId].push({
        attemptId: attempt,
        model,
        cliVersion: safeVersion(cliVersions[harnessId]),
        taskId: task.id,
        runId: run.id,
        workspaceId: workspace.workspaceId,
        pinnedBaseCommit: workspace.pinnedBaseCommit,
        bridgeHarnessName: typeof discovered[harnessId].name === 'string' ? discovered[harnessId].name.slice(0, 100) : harnessId,
        workerSystemPromptBoundary: 'existing AGY Worker agent instructions are bridge-added',
      });
      if (workspace.pinnedBaseCommit.toLowerCase() !== baseCommit || !workspace.workspaceId) throw new Error(`${harnessId} workspace did not pin the requested base`);
    }
  }
  const allWorkspaces = Object.values(harnesses).flat().map(item => item.workspaceId);
  if (new Set(allWorkspaces).size !== allWorkspaces.length) throw new Error('Every comparison attempt requires a distinct Worker workspace');
  const record = {
    version: 2,
    attemptCount,
    baseUrl,
    repoPath,
    baseCommit,
    projectId: project.id,
    models: baseModels,
    cliVersions: Object.fromEntries(Object.entries(cliVersions).map(([id, value]) => [id, safeVersion(value)])),
    harnesses,
    taskText,
    taskDigest,
    taskBytes: Buffer.byteLength(taskText, 'utf8'),
    taskBytesIdentical: true,
    allowedScope,
    validation: { name: 'pnpm test', command: 'pnpm', args: ['test'] },
    tokenAccountingCaveat: 'AGY adds its existing Worker agent instructions to the submitted task. CLI token accounting fields may differ from the submitted task byte count in scope and definition.',
    preparedAt: new Date().toISOString(),
  };
  await writeFile(preparedPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: 'prepared_only', providerCalls: 0, credentialsRead: false, attemptCount, baseCommit, taskDigest, taskBytes: record.taskBytes, allowedScope, validation: record.validation, workspaces: Object.fromEntries(Object.entries(harnesses).map(([id, attempts]) => [id, attempts.map(item => ({ attemptId: item.attemptId, workspaceId: item.workspaceId }))])), execute: `FOREMAN_WORKER_COMPARISON_ATTEMPTS=${attemptCount} node compare.mjs --execute-attempt antigravity-cli attempt-001 ${baseUrl} ${repoPath} ${baseCommit} ${agyModel} ${agyCliVersion}` }, null, 2)}\n`);
  process.exit(0);
}

const harnessId = executeHarness;
const prepared = JSON.parse(await readFile(preparedPath, 'utf8'));
if (prepared.baseUrl !== baseUrl || prepared.repoPath !== repoPath || prepared.baseCommit !== baseCommit || prepared.taskDigest !== taskDigest || JSON.stringify(prepared.models) !== JSON.stringify(baseModels) || prepared.attemptCount !== attemptCount || Number(attemptId.slice(-3)) > prepared.attemptCount) throw new Error('Prepared comparison state does not match these explicit inputs');
const preparedHarness = prepared.harnesses[harnessId]?.find(item => item.attemptId === attemptId);
if (!preparedHarness || preparedHarness.model !== baseModels[harnessId] || preparedHarness.pinnedBaseCommit?.toLowerCase() !== baseCommit) throw new Error('Prepared harness binding is missing or mismatched');
const callLock = join(stateDir, `${harnessId}.${attemptId}.live-worker-call.lock`);
await writeFile(callLock, `${JSON.stringify({ harnessId, attemptId, runId: preparedHarness.runId, workspaceId: preparedHarness.workspaceId, model: preparedHarness.model, taskDigest, startedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });

let submissionAttempted = false;
const started = performance.now();
let submitted;
let response;
let createdResponseId;
let createdSessionId;
try {
  await controller.refreshDiscovery();
  submissionAttempted = true;
  submitted = await client.submit({
    submissionId: `comparison-${harnessId}-${randomUUID()}`,
    assignmentId: `comparison-worker-${harnessId}-${randomUUID()}`,
    runId: preparedHarness.runId,
    roleId: 'worker',
    taskId: preparedHarness.taskId,
    projectId: prepared.projectId,
    prompt: prepared.taskText,
    config: { harnessId, model: preparedHarness.model, workspaceId: preparedHarness.workspaceId, timeoutSeconds, maxStep: 1 },
    idempotencyKey: `comparison-${harnessId}-${randomUUID()}`,
    onEvent: event => {
      if (event.type === 'response.created') {
        createdResponseId ??= event.responseId;
        createdSessionId ??= event.sessionId;
      }
    },
  });
  const submissionRuntimeMs = Number.isFinite(submitted.runtimeMs) ? submitted.runtimeMs : Math.round(performance.now() - started);
  response = submitted.responseId ? await client.retrieve(submitted.responseId) : undefined;
  if (!response) throw new Error('Bridge response could not be retrieved');
  if (response.id !== submitted.responseId || response.metadata?.workspace_id !== preparedHarness.workspaceId || response.status !== 'completed') throw new Error('Worker response did not bind a completed turn to its prepared workspace');
  const sessionId = response.session_id ?? response.sessionId;
  if (!sessionId || (submitted.sessionId && sessionId !== submitted.sessionId)) throw new Error('Worker response session binding is missing or inconsistent');
  const snapshotStarted = performance.now();
  const envelope = await fetchBridgeSnapshot(baseUrl, preparedHarness.workspaceId, baseCommit, 30_000);
  const verified = await verifyWorkerSnapshot({ repoPath, pinnedBaseCommit: baseCommit, envelope, allowedScope });
  const validation = await validateWorkerOutput({ repoPath, evidence: verified, commands: validationCommands, timeoutMs: 90_000, maxOutputBytes: 8_000 });
  const validationRuntimeMs = Math.round(performance.now() - snapshotStarted);
  const taskAcceptance = checkTaskAcceptance(verified);
  const status = verified.scopeVerified && taskAcceptance.passed && validation.passed ? 'verified' : 'failed';
  const report = {
    evidenceVersion: 1,
    provenance: `live_${harnessId}_${attemptId}_worker_call`,
    attemptId,
    status,
    harnessId,
    requestedModel: preparedHarness.model,
    actualModelStatus: responseEnvelope(response, harnessId, { ...submitted, cliVersion: preparedHarness.cliVersion }).actualModelStatus,
    ...(typeof response.model === 'string' ? { actualModel: response.model } : {}),
    cliVersion: responseEnvelope(response, harnessId, { ...submitted, cliVersion: preparedHarness.cliVersion }).cliVersion,
    cliVersionSource: responseEnvelope(response, harnessId, { ...submitted, cliVersion: preparedHarness.cliVersion }).cliVersionSource,
    responseId: safeId(response.id),
    sessionId: safeId(sessionId),
    runId: safeId(preparedHarness.runId),
    taskId: safeId(preparedHarness.taskId),
    workspaceId: safeId(preparedHarness.workspaceId),
    pinnedBaseCommit: baseCommit,
    taskDigest,
    taskBytes: prepared.taskBytes,
    taskBytesIdenticalAcrossAttempts: prepared.taskBytesIdentical,
    taskScope: allowedScope,
    validationCommand: 'pnpm test',
    uhpSubmissionAttempts: 1,
    liveCliInvocations: response.metadata?.execution_stage === 'cli_execution' ? 1 : response.metadata?.execution_stage ? 0 : 'not reported by bridge',
    providerRequestCount: 'unavailable',
    wallTimeMs: { workerSubmission: Math.round(submissionRuntimeMs), snapshotAndVerificationAndValidation: validationRuntimeMs, total: Math.round(performance.now() - started) },
    reportedUsage: responseEnvelope(response, harnessId, submitted).reportedUsage,
    promptEvidence: responseEnvelope(response, harnessId, submitted).promptEvidence,
    toolAndPermissionEvidence: responseEnvelope(response, harnessId, submitted).toolAndPermissionEvidence,
    diagnosticCounts: { toolLifecycleUpdateCount: responseEnvelope(response, harnessId, submitted).toolAndPermissionEvidence.toolLifecycleUpdateCount, distinctToolStepCount: responseEnvelope(response, harnessId, submitted).toolAndPermissionEvidence.distinctToolStepCount, reportedCliTurns: responseEnvelope(response, harnessId, submitted).toolAndPermissionEvidence.reportedCliTurns, terminalResultStatus: responseEnvelope(response, harnessId, submitted).toolAndPermissionEvidence.terminalResultStatus, responseCharacters: responseEnvelope(response, harnessId, submitted).toolAndPermissionEvidence.responseCharacters },
    executionBoundary: responseEnvelope(response, harnessId, submitted).executionBoundary,
    actualModelEvidence: { requestedModelArgument: preparedHarness.model, cliModelArgument: responseEnvelope(response, harnessId, submitted).cliModelArgument, cliEffortArgument: responseEnvelope(response, harnessId, submitted).cliEffortArgument, cliModelArgumentMatchesRequest: responseEnvelope(response, harnessId, submitted).cliModelArgumentMatchesRequest, configuredInitModel: responseEnvelope(response, harnessId, submitted).configuredInitModel, configuredInitModelStatus: responseEnvelope(response, harnessId, submitted).configuredInitModelStatus, actualModelStatus: responseEnvelope(response, harnessId, submitted).actualModelStatus },
    foremanVerification: { provenance: verified.provenance, completeSnapshot: verified.completeSnapshot, scopeVerified: verified.scopeVerified, allowedScope: verified.allowedScope, changedPaths: verified.changes.map(change => change.path), changes: summarizeChanges(verified.changes), exactReviewDiff: verified.reviewDiff },
    taskAcceptance,
    foremanValidation: { passed: validation.passed, checks: validation.checks.map(check => ({ name: check.name, exitCode: check.exitCode, signal: check.signal ?? null, timedOut: check.timedOut, outputTruncated: check.outputTruncated, startedAt: check.startedAt, finishedAt: check.finishedAt })) },
    taskTextIdenticalAcrossAttempts: true,
    tokenAccountingCaveat: prepared.tokenAccountingCaveat,
    capturedAt: new Date().toISOString(),
  };
  const evidenceFile = await persistReport(`${harnessId}.${attemptId}`, report);
  process.stdout.write(`${JSON.stringify({ status, harnessId, attemptId, requestedModel: report.requestedModel, actualModel: report.actualModel ?? 'unavailable', responseId: report.responseId, sessionId: report.sessionId, measuredUsage: report.reportedUsage, changedPaths: report.foremanVerification.changedPaths, scopeVerified: report.foremanVerification.scopeVerified, validationPassed: report.foremanValidation.passed, evidenceFile }, null, 2)}\n`);
  if (status !== 'verified') process.exitCode = 1;
} catch (error) {
  if (!response && createdResponseId) response = await client.retrieve(createdResponseId).catch(() => undefined);
  const summary = {
    evidenceVersion: 1,
    provenance: `live_${harnessId}_${attemptId}_worker_call`,
    attemptId,
    status: 'failed',
    harnessId,
    requestedModel: preparedHarness.model,
    cliVersion: preparedHarness.cliVersion,
    cliVersionSource: preparedHarness.cliVersion ? 'provided_for_installed_host_cli' : 'unavailable',
    responseId: safeId(response?.id ?? submitted?.responseId ?? createdResponseId),
    sessionId: safeId(response?.session_id ?? response?.sessionId ?? submitted?.sessionId ?? createdSessionId),
    runId: safeId(preparedHarness.runId),
    taskId: safeId(preparedHarness.taskId),
    workspaceId: safeId(preparedHarness.workspaceId),
    pinnedBaseCommit: baseCommit,
    taskDigest,
    uhpSubmissionAttempts: submissionAttempted ? 1 : 0,
    liveCliInvocations: response?.metadata?.execution_stage === 'cli_execution' ? 1 : response?.metadata?.execution_stage ? 0 : 'not reported by bridge',
    providerRequestCount: 'unavailable',
    wallTimeMs: Math.round(performance.now() - started),
    failureCategory: failureCategory(error),
    terminalStatus: response?.status ?? submitted?.status ?? 'failed',
    modelStatus: response?.metadata?.actual_model_status ?? 'unreported',
    executionStage: typeof response?.metadata?.execution_stage === 'string' ? response.metadata.execution_stage.slice(0, 80) : null,
    boundaryDiagnostic: response?.metadata?.execution_boundary_diagnostic && typeof response.metadata.execution_boundary_diagnostic === 'object' ? {
      category: typeof response.metadata.execution_boundary_diagnostic.category === 'string' ? response.metadata.execution_boundary_diagnostic.category.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) : 'unreported',
      exitCode: Number.isInteger(response.metadata.execution_boundary_diagnostic.exit_code) ? response.metadata.execution_boundary_diagnostic.exit_code : null,
      signal: typeof response.metadata.execution_boundary_diagnostic.signal === 'string' ? response.metadata.execution_boundary_diagnostic.signal.slice(0, 32) : null,
    } : null,
    measuredUsage: safeUsage(response?.usage),
    reportedUsage: responseEnvelope(response, harnessId, submitted).reportedUsage,
    promptEvidence: responseEnvelope(response, harnessId, submitted).promptEvidence,
    diagnosticCounts: { toolLifecycleUpdateCount: responseEnvelope(response, harnessId, submitted).toolAndPermissionEvidence.toolLifecycleUpdateCount, distinctToolStepCount: responseEnvelope(response, harnessId, submitted).toolAndPermissionEvidence.distinctToolStepCount, reportedCliTurns: responseEnvelope(response, harnessId, submitted).toolAndPermissionEvidence.reportedCliTurns, terminalResultStatus: responseEnvelope(response, harnessId, submitted).toolAndPermissionEvidence.terminalResultStatus, responseCharacters: responseEnvelope(response, harnessId, submitted).toolAndPermissionEvidence.responseCharacters },
    toolAndPermissionEvidence: toolEvidence(response?.metadata ?? {}, harnessId),
    retry: 'use_a_new_prepared_attempt_id_and_workspace',
    tokenAccountingCaveat: prepared.tokenAccountingCaveat,
    capturedAt: new Date().toISOString(),
  };
  const evidenceFile = await persistReport(`${harnessId}.${attemptId}`, summary);
  process.stdout.write(`${JSON.stringify({ status: 'failed', harnessId, attemptId, submissionAttempts: summary.uhpSubmissionAttempts, responseId: summary.responseId, failureCategory: summary.failureCategory, retry: summary.retry, evidenceFile }, null, 2)}\n`);
  process.exitCode = 1;
}
