#!/usr/bin/env node
// Same-task AGY/Gemini Worker comparison. Prepare is model-call-free. Each
// execute-once invocation takes a durable per-harness lock before submission.
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

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = here;
const [mode, ...args] = process.argv.slice(2);
const usage = 'Usage: node compare.mjs --prepare-only <loopback-uhp-url> <disposable-repo> <base-sha> <gemini-model> <agy-model> <gemini-cli-version|unavailable> <agy-cli-version|unavailable>\n       node compare.mjs --execute-once <gemini-cli|antigravity-cli> <loopback-uhp-url> <disposable-repo> <base-sha> <gemini-model> <agy-model> <gemini-cli-version|unavailable> <agy-cli-version|unavailable>';
if (mode === '--help' || mode === '-h') { process.stdout.write(`${usage}\n`); process.exit(0); }
const executeHarness = mode === '--execute-once' ? args.shift() : undefined;
if (!['--prepare-only', '--execute-once'].includes(mode) || (mode === '--execute-once' && !['gemini-cli', 'antigravity-cli'].includes(executeHarness)) || args.length !== 7) throw new Error(usage);

const [baseUrl, repoArg, baseCommitArg, geminiModel, agyModel, geminiCliVersion, agyCliVersion] = args;
const repoPath = resolve(repoArg);
const baseCommit = baseCommitArg.toLowerCase();
if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) throw new Error('A full Git base commit SHA is required');
if (!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/.*)?$/.test(baseUrl)) throw new Error('The UHP bridge URL must be loopback-only');
if (!geminiModel.trim() || !agyModel.trim()) throw new Error('Both requested model IDs must be explicit and non-empty');
if (geminiModel !== 'gemini-3.5-flash' || agyModel !== 'gemini-3.8-flash-low') throw new Error('This comparison is pinned to Gemini CLI gemini-3.5-flash and AGY gemini-3.8-flash-low; model substitutions are not allowed');
const allowedScope = ['src/label.ts', 'test/label.check.ts'];
const validationCommands = [{ name: 'pnpm test', command: 'pnpm', args: ['test'] }];
const taskText = await readFile(join(repoPath, 'TASK.txt'), 'utf8');
const taskDigest = createHash('sha256').update(taskText).digest('hex');
const baseModels = { 'gemini-cli': geminiModel, 'antigravity-cli': agyModel };
const cliVersions = { 'gemini-cli': geminiCliVersion, 'antigravity-cli': agyCliVersion };
const stateDir = resolve(process.env.FOREMAN_WORKER_COMPARISON_STATE ?? join(tmpdir(), `foreman-worker-comparison-state-${baseCommit.slice(0, 12)}`));
const preparedPath = join(stateDir, 'prepared.json');
const evidenceDir = join(stateDir, 'evidence');
const statePath = join(stateDir, 'foreman-state.json');
const client = new UhpClient({ baseUrl, timeoutMs: 90_000, streamInactivityTimeoutMs: 75_000 });
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
function safeNumericTree(value, depth = 0) {
  if (depth > 4 || !value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) continue;
    if (typeof item === 'number' && Number.isFinite(item)) output[key] = item;
    else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const child = safeNumericTree(item, depth + 1);
      if (child && Object.keys(child).length) output[key] = child;
    }
  }
  return Object.keys(output).length ? output : undefined;
}
function geminiPerModelUsage(metadata) {
  const models = metadata?.gemini_usage?.models ?? metadata?.gemini_diagnostic?.stats?.models ?? metadata?.gemini_stats?.models ?? metadata?.stats?.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return null;
  return Object.fromEntries(Object.entries(models).slice(0, 20).map(([model, stats]) => [model.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100), safeNumericTree(stats)]).filter(([, stats]) => stats));
}
function toolEvidence(metadata, harnessId) {
  const diagnostics = [metadata?.gemini_diagnostic, metadata?.gemini_cli_diagnostic, metadata?.agy_diagnostic, metadata?.worker_diagnostic].filter(value => value && typeof value === 'object');
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
  return { events, permissions: Object.keys(permissions).length ? permissions : { status: 'not_reported_by_bridge', harnessId } };
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
  const diagnosticUsage = safeUsage(metadata.cli_reported_usage ?? metadata.gemini_usage ?? metadata.gemini_usage_cumulative ?? metadata.agy_usage_cumulative ?? metadata.reported_usage);
  const perModelUsage = geminiPerModelUsage(metadata);
  const configuredInitModel = metadata.gemini_diagnostic?.init_model ?? metadata.gemini_diagnostic?.configured_model ?? metadata.gemini_cli_diagnostic?.init_model ?? metadata.configured_init_model;
  const invocationArgs = metadata.cli_invocation?.args;
  const modelIndex = Array.isArray(invocationArgs) ? invocationArgs.findIndex((arg, index) => (arg === '--model' || arg === '-m') && typeof invocationArgs[index + 1] === 'string') : -1;
  const cliModelArgument = modelIndex >= 0 ? String(invocationArgs[modelIndex + 1]).slice(0, 120) : null;
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
    cliModelArgument,
    cliModelArgumentMatchesRequest: cliModelArgument === (submitted?.requestedModel ?? response?.requested_model ?? metadata.requested_model ?? null),
    perModelUsageNames: perModelUsage ? Object.keys(perModelUsage) : [],
    reportedUsage: { uhpUsageFields: usage, cliUsageFields: diagnosticUsage, geminiPerModelStats: perModelUsage },
    providerRequestCount: 'unavailable',
    toolAndPermissionEvidence: toolEvidence(metadata, harnessId),
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
    if (existing.baseUrl !== baseUrl || existing.repoPath !== repoPath || existing.baseCommit !== baseCommit || existing.taskDigest !== taskDigest || JSON.stringify(existing.models) !== JSON.stringify(baseModels)) throw new Error('Existing comparison preparation binds different inputs; use a fresh state directory');
    process.stdout.write(`${JSON.stringify({ status: 'already_prepared', preparationOnly: true, providerCalls: 0, baseCommit, workspaces: Object.fromEntries(Object.entries(existing.harnesses).map(([id, item]) => [id, item.workspaceId])), executeGemini: `node compare.mjs --execute-once gemini-cli ${baseUrl} ${repoPath} ${baseCommit} ${geminiModel} ${agyModel} ${geminiCliVersion} ${agyCliVersion}` }, null, 2)}\n`);
    process.exit(0);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const discovery = await client.discover(true);
  if (discovery.capabilities.idempotency !== true || discovery.capabilities.streaming !== true) throw new Error('Bridge must advertise streaming and idempotency');
  const discovered = {
    'gemini-cli': modeDiscovery(discovery, 'gemini-cli', geminiModel),
    'antigravity-cli': modeDiscovery(discovery, 'antigravity-cli', agyModel),
  };
  await controller.refreshDiscovery();
  const project = await controller.createProject('Disposable identical Flash Worker comparison');
  const harnesses = {};
  for (const harnessId of ['gemini-cli', 'antigravity-cli']) {
    const task = await controller.createTask(project.id, 'Update the label greeting and its test');
    const run = await controller.createRun(task.id);
    const model = baseModels[harnessId];
    await controller.selectRoleConfig('worker', { harnessId, model }, undefined, run.id);
    const workspace = await controller.prepareWorkerWorkspace(run.id, baseCommit);
    harnesses[harnessId] = {
      model,
      cliVersion: safeVersion(cliVersions[harnessId]),
      taskId: task.id,
      runId: run.id,
      workspaceId: workspace.workspaceId,
      pinnedBaseCommit: workspace.pinnedBaseCommit,
      bridgeHarnessName: typeof discovered[harnessId].name === 'string' ? discovered[harnessId].name.slice(0, 100) : harnessId,
      workerSystemPromptBoundary: harnessId === 'antigravity-cli' ? 'existing AGY Worker agent instructions are bridge-added' : 'Gemini CLI system prompt is CLI-managed and not exposed by the bridge',
    };
    if (workspace.pinnedBaseCommit.toLowerCase() !== baseCommit || !workspace.workspaceId) throw new Error(`${harnessId} workspace did not pin the requested base`);
  }
  if (harnesses['gemini-cli'].workspaceId === harnesses['antigravity-cli'].workspaceId) throw new Error('Comparison requires separate Worker workspaces');
  const record = {
    version: 1,
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
    tokenAccountingCaveat: 'The task text bytes are identical. AGY adds its existing Worker agent instructions; Gemini CLI uses its own system prompt. CLI token accounting fields may therefore differ in both scope and definition.',
    preparedAt: new Date().toISOString(),
  };
  await writeFile(preparedPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: 'prepared_only', providerCalls: 0, credentialsRead: false, baseCommit, taskDigest, taskBytes: record.taskBytes, allowedScope, validation: record.validation, workspaces: Object.fromEntries(Object.entries(harnesses).map(([id, item]) => [id, item.workspaceId])), executeGemini: `node compare.mjs --execute-once gemini-cli ${baseUrl} ${repoPath} ${baseCommit} ${geminiModel} ${agyModel} ${geminiCliVersion} ${agyCliVersion}` }, null, 2)}\n`);
  process.exit(0);
}

const harnessId = executeHarness;
const prepared = JSON.parse(await readFile(preparedPath, 'utf8'));
if (prepared.baseUrl !== baseUrl || prepared.repoPath !== repoPath || prepared.baseCommit !== baseCommit || prepared.taskDigest !== taskDigest || JSON.stringify(prepared.models) !== JSON.stringify(baseModels)) throw new Error('Prepared comparison state does not match these explicit inputs');
if (harnessId === 'antigravity-cli') {
  const geminiEvidence = JSON.parse(await readFile(join(evidenceDir, 'gemini-cli.json'), 'utf8').catch(() => 'null'));
  if (geminiEvidence?.status !== 'verified') throw new Error('AGY execution refused: the Gemini attempt must first complete Foreman scope verification and pnpm test validation successfully');
}
const preparedHarness = prepared.harnesses[harnessId];
if (!preparedHarness || preparedHarness.model !== baseModels[harnessId] || preparedHarness.pinnedBaseCommit?.toLowerCase() !== baseCommit) throw new Error('Prepared harness binding is missing or mismatched');
const callLock = join(stateDir, `${harnessId}.live-worker-call.lock`);
await writeFile(callLock, `${JSON.stringify({ harnessId, runId: preparedHarness.runId, workspaceId: preparedHarness.workspaceId, model: preparedHarness.model, taskDigest, startedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });

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
    config: { harnessId, model: preparedHarness.model, workspaceId: preparedHarness.workspaceId, timeoutSeconds: 60, maxStep: 1 },
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
    provenance: `single_live_${harnessId}_worker_call`,
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
    taskBytesIdenticalAcrossHarnesses: prepared.taskBytesIdentical,
    taskScope: allowedScope,
    validationCommand: 'pnpm test',
    uhpSubmissionAttempts: 1,
    liveCliInvocations: response.metadata?.execution_stage === 'cli_execution' ? 1 : response.metadata?.execution_stage ? 0 : 'not reported by bridge',
    providerRequestCount: 'unavailable',
    wallTimeMs: { workerSubmission: Math.round(submissionRuntimeMs), snapshotAndVerificationAndValidation: validationRuntimeMs, total: Math.round(performance.now() - started) },
    reportedUsage: responseEnvelope(response, harnessId, submitted).reportedUsage,
    toolAndPermissionEvidence: responseEnvelope(response, harnessId, submitted).toolAndPermissionEvidence,
    executionBoundary: responseEnvelope(response, harnessId, submitted).executionBoundary,
    actualModelEvidence: { requestedModelArgument: preparedHarness.model, cliModelArgument: responseEnvelope(response, harnessId, submitted).cliModelArgument, cliModelArgumentMatchesRequest: responseEnvelope(response, harnessId, submitted).cliModelArgumentMatchesRequest, configuredInitModel: responseEnvelope(response, harnessId, submitted).configuredInitModel, configuredInitModelStatus: responseEnvelope(response, harnessId, submitted).configuredInitModelStatus, perModelUsageNames: responseEnvelope(response, harnessId, submitted).perModelUsageNames, actualModelStatus: responseEnvelope(response, harnessId, submitted).actualModelStatus },
    foremanVerification: { provenance: verified.provenance, completeSnapshot: verified.completeSnapshot, scopeVerified: verified.scopeVerified, allowedScope: verified.allowedScope, changedPaths: verified.changes.map(change => change.path), changes: summarizeChanges(verified.changes), exactReviewDiff: verified.reviewDiff },
    taskAcceptance,
    foremanValidation: { passed: validation.passed, checks: validation.checks.map(check => ({ name: check.name, exitCode: check.exitCode, signal: check.signal ?? null, timedOut: check.timedOut, outputTruncated: check.outputTruncated, startedAt: check.startedAt, finishedAt: check.finishedAt })) },
    taskTextIdenticalAcrossHarnesses: true,
    tokenAccountingCaveat: prepared.tokenAccountingCaveat,
    capturedAt: new Date().toISOString(),
  };
  const evidenceFile = await persistReport(harnessId, report);
  process.stdout.write(`${JSON.stringify({ status, harnessId, requestedModel: report.requestedModel, actualModel: report.actualModel ?? 'unavailable', responseId: report.responseId, sessionId: report.sessionId, measuredUsage: report.reportedUsage, changedPaths: report.foremanVerification.changedPaths, scopeVerified: report.foremanVerification.scopeVerified, validationPassed: report.foremanValidation.passed, evidenceFile }, null, 2)}\n`);
  if (status !== 'verified') process.exitCode = 1;
} catch (error) {
  if (!response && createdResponseId) response = await client.retrieve(createdResponseId).catch(() => undefined);
  const summary = {
    evidenceVersion: 1,
    provenance: `single_live_${harnessId}_worker_call`,
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
    toolAndPermissionEvidence: toolEvidence(response?.metadata ?? {}, harnessId),
    retry: 'forbidden_by_durable_call_lock',
    tokenAccountingCaveat: prepared.tokenAccountingCaveat,
    capturedAt: new Date().toISOString(),
  };
  const evidenceFile = await persistReport(harnessId, summary);
  process.stdout.write(`${JSON.stringify({ status: 'failed', harnessId, submissionAttempts: summary.uhpSubmissionAttempts, responseId: summary.responseId, failureCategory: summary.failureCategory, retry: summary.retry, evidenceFile }, null, 2)}\n`);
  process.exitCode = 1;
}
