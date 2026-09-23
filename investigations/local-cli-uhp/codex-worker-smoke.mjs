#!/usr/bin/env node
// Bounded Codex Worker proof. Prepare mode makes no provider call. Execute mode is
// guarded by a durable create-once lock and never retries a submission.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from '../../dist/controller.js';
import { JsonStore } from '../../dist/store.js';
import { UhpClient } from '../../dist/uhp.js';

const here = dirname(fileURLToPath(import.meta.url));
const [mode, baseUrl, repoArg, baseCommit, model] = process.argv.slice(2);
if (!['--prepare-only', '--execute-once'].includes(mode) || !baseUrl || !repoArg || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseCommit ?? '') || !model) {
  throw new Error('Usage: node codex-worker-smoke.mjs <--prepare-only|--execute-once> <loopback-uhp-url> <disposable-fixture-repo> <full-base-commit-sha> <explicit-available-codex-model>');
}
const repoPath = resolve(repoArg);
const harnessId = 'codex-cli';
const prompt = 'Edit only README.md. Append the sentence "Codex Worker smoke: Foreman independently verified this change." Do not inspect or change any other file. Return a short completion note.';
const scope = ['README.md'];
const stateDir = resolve(process.env.FOREMAN_CODEX_SMOKE_STATE ?? '/tmp/foreman-codex-worker-smoke');
const recordFile = resolve(process.env.FOREMAN_CODEX_SMOKE_RECORD ?? `${stateDir}/prepared.json`);
const evidenceFile = resolve(process.env.FOREMAN_CODEX_SMOKE_EVIDENCE ?? `${here}/evidence/actual-codex-worker-smoke.json`);
const stateFile = resolve(`${stateDir}/foreman-state.json`);
const client = new UhpClient({ baseUrl, timeoutMs: 45_000, streamInactivityTimeoutMs: 40_000 });
const controller = new Controller(new JsonStore(stateFile), client, false, true, undefined, undefined, 30);
controller.configureVerifiedWorkspace({ repoPath, allowedScope: scope, commands: [{
  name: 'README contains the bounded Codex smoke sentence',
  command: process.execPath,
  args: ['-e', `const fs=require('node:fs');const text=fs.readFileSync('README.md','utf8');if(!text.includes(${JSON.stringify('Codex Worker smoke: Foreman independently verified this change.')}))process.exit(1);`],
}], bridgeBaseUrl: baseUrl, timeoutMs: 10_000, maxOutputBytes: 2_000 });

if (mode === '--prepare-only') {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let existing;
  try { existing = JSON.parse(await readFile(recordFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (existing.baseUrl !== baseUrl || existing.repoPath !== repoPath || existing.baseCommit !== baseCommit.toLowerCase() || existing.model !== model || existing.prompt !== prompt) throw new Error('Existing Codex smoke preparation binds different inputs; use a fresh state directory');
    process.stdout.write(`${JSON.stringify({ status: 'already_prepared', runId: existing.runId, baseCommit: existing.baseCommit, model: existing.model, executeCommand: `node codex-worker-smoke.mjs --execute-once ${baseUrl} ${repoPath} ${baseCommit} ${model}` }, null, 2)}\n`);
    process.exit(0);
  }
  const discovery = await client.discover(true);
  if (discovery.capabilities.idempotency !== true || discovery.capabilities.streaming !== true) throw new Error('Codex bridge must advertise idempotency and streaming');
  const codex = discovery.harnesses.find(item => item.id === harnessId);
  if (!codex?.models?.some(item => item.id === model && item.available !== false) && !discovery.models?.some(item => item.harnessId === harnessId && item.id === model && item.available !== false)) throw new Error(`Explicit Codex model '${model}' is not discoverable`);
  const project = await controller.createProject('Disposable Codex Worker smoke');
  const task = await controller.createTask(project.id, 'Append one bounded sentence to README.md');
  const run = await controller.createRun(task.id);
  await controller.refreshDiscovery();
  await controller.selectRoleConfig('worker', { harnessId, model }, undefined, run.id);
  const preparedRun = await controller.prepareWorkerWorkspace(run.id, baseCommit);
  const record = { version: 1, baseUrl, repoPath, baseCommit: baseCommit.toLowerCase(), harnessId, model, prompt, scope, projectId: project.id, taskId: task.id, runId: run.id, workspaceId: preparedRun.workspaceId, preparedAt: new Date().toISOString() };
  await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: 'prepared_only', liveCalls: 0, runId: run.id, workspaceId: preparedRun.workspaceId, pinnedBaseCommit: preparedRun.pinnedBaseCommit, requestedModel: model, executeCommand: `node codex-worker-smoke.mjs --execute-once ${baseUrl} ${repoPath} ${baseCommit} ${model}`, recordFile }, null, 2)}\n`);
  process.exit(0);
}

const prepared = JSON.parse(await readFile(recordFile, 'utf8'));
if (prepared.baseUrl !== baseUrl || prepared.repoPath !== repoPath || prepared.baseCommit !== baseCommit.toLowerCase() || prepared.model !== model || prepared.harnessId !== harnessId || prepared.prompt !== prompt) throw new Error('Prepared Codex smoke state does not match this explicit invocation');
try { await readFile(evidenceFile); throw new Error('Evidence file already exists; a Codex live call cannot be repeated'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const callLock = `${recordFile}.live-call.lock`;
await writeFile(callLock, `${JSON.stringify({ runId: prepared.runId, model, promptSha256: createHash('sha256').update(prompt).digest('hex'), startedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });

let submissionAttempted = false;
try {
  await controller.refreshDiscovery();
  submissionAttempted = true;
  const assignment = await controller.assign(prepared.runId, 'worker', prompt, { harnessId, model, maxStep: 1, options: { timeoutSeconds: 30 } });
  if (assignment.status !== 'succeeded') throw new Error(`Codex Worker terminal status was ${assignment.status}`);
  const verified = await controller.verifyWorkerOutput(prepared.runId, assignment.id);
  const fullState = await controller.state();
  const run = fullState.projects.flatMap(project => project.tasks).flatMap(task => task.runs).find(item => item.id === prepared.runId);
  const worker = run?.assignments.find(item => item.id === assignment.id);
  const response = await client.retrieve(assignment.responseId);
  const report = {
    evidenceVersion: 1,
    provenance: 'single_live_codex_worker_call',
    status: verified.validation.status === 'passed' && verified.workerEvidence.scopeVerified ? 'verified' : 'failed',
    uhpSubmissionAttempts: 1,
    liveCliInvocations: 1,
    completedModelTurns: 1,
    providerRequestCount: 'unavailable',
    runId: prepared.runId,
    pinnedBaseCommit: run?.pinnedBaseCommit,
    workspaceId: run?.workspaceId,
    requestedModel: worker?.requestedModel ?? model,
    actualModelStatus: worker?.actualModelStatus ?? response.metadata?.actual_model_status ?? 'unavailable',
    actualModel: worker?.actualConfig?.model ?? null,
    cliInvocation: worker?.cliInvocation ?? response.metadata?.cli_invocation ?? null,
    responseId: worker?.responseId ?? null,
    sessionId: worker?.sessionId ?? null,
    measuredUsage: worker?.usage ?? null,
    bounds: { timeoutSeconds: 30, requestedMaxStep: 1, ignoredFields: worker?.configNotes?.ignoredFields ?? [] },
    executionBoundary: response.metadata?.execution_boundary ?? null,
    completeSnapshot: verified.workerEvidence.completeSnapshot,
    scopeVerified: verified.workerEvidence.scopeVerified,
    allowedScope: verified.workerEvidence.allowedScope,
    changes: verified.workerEvidence.changes,
    reviewDiff: verified.workerEvidence.reviewDiff,
    acceptance: verified.workerEvidence.acceptance,
    controllerValidation: { status: verified.validation.status, passed: verified.validation.passed, observations: verified.validation.observations },
    gitPromotion: 'not_requested',
    humanApproval: 'not_requested',
    capturedAt: new Date().toISOString(),
  };
  if (report.actualModelStatus === 'unavailable') report.actualModelDisplay = 'actual model unavailable';
  await mkdir(dirname(evidenceFile), { recursive: true, mode: 0o700 });
  await writeFile(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: report.status, liveCalls: 1, requestedModel: report.requestedModel, actualModel: report.actualModelDisplay ?? report.actualModel, responseId: report.responseId, sessionId: report.sessionId, measuredUsage: report.measuredUsage, changedPaths: report.changes.map(change => change.path), scopeVerified: report.scopeVerified, validation: report.controllerValidation.status, evidenceFile }, null, 2)}\n`);
  if (report.status !== 'verified') process.exitCode = 1;
} catch (error) {
  const state = await controller.state().catch(() => undefined);
  const run = state?.projects.flatMap(project => project.tasks).flatMap(task => task.runs).find(item => item.id === prepared.runId);
  const worker = run?.assignments.find(item => item.roleId === 'worker');
  const response = worker?.responseId ? await client.retrieve(worker.responseId).catch(() => undefined) : undefined;
  const cliStarted = response?.metadata?.execution_stage === 'cli_execution' || response?.metadata?.execution_boundary?.proven === true && worker?.cliInvocation !== undefined;
  const bridgeError = typeof response?.error?.message === 'string' ? response.error.message : undefined;
  const partialSnapshot = prepared.workspaceId ? await fetch(new URL(`extensions/foreman-workspace/v1/workspaces/${encodeURIComponent(prepared.workspaceId)}/snapshot`, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)).then(async result => result.ok ? result.json() : undefined).catch(() => undefined) : undefined;
  const report = { evidenceVersion: 1, provenance: 'single_live_codex_worker_call', status: 'failed', uhpSubmissionAttempts: submissionAttempted ? 1 : 0, liveCliInvocations: cliStarted ? 1 : 0, completedModelTurns: 0, providerRequestCount: 'unavailable', executionStage: response?.metadata?.execution_stage ?? null, executionBoundary: response?.metadata?.execution_boundary ?? null, terminalStatus: response?.status ?? worker?.status ?? 'failed', terminalError: bridgeError ?? (error instanceof Error ? error.message.slice(0, 1000) : 'unknown failure'), cliOutputText: response?.output_text ?? null, snapshot: partialSnapshot ? { complete: partialSnapshot.complete === true, entryCount: Array.isArray(partialSnapshot.entries) ? partialSnapshot.entries.length : null, errors: Array.isArray(partialSnapshot.errors) ? partialSnapshot.errors : [] } : null, scopeVerified: false, controllerValidation: { status: 'not_run', reason: 'Worker response did not provide a complete snapshot for Foreman verification' }, runId: prepared.runId, pinnedBaseCommit: prepared.baseCommit, requestedModel: model, actualModelStatus: worker?.actualModelStatus ?? response?.metadata?.actual_model_status ?? 'unavailable', actualModel: worker?.actualConfig?.model ?? response?.model ?? null, cliInvocation: worker?.cliInvocation ?? response?.metadata?.cli_invocation ?? null, responseId: worker?.responseId ?? null, sessionId: worker?.sessionId ?? null, measuredUsage: worker?.usage ?? response?.usage ?? null, failure: bridgeError ?? (error instanceof Error ? error.message.slice(0, 1000) : 'unknown failure'), retry: 'forbidden_by_durable_call_lock', capturedAt: new Date().toISOString() };
  if (report.actualModelStatus === 'unavailable') report.actualModelDisplay = 'actual model unavailable';
  await mkdir(dirname(evidenceFile), { recursive: true, mode: 0o700 });
  await writeFile(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: 'failed', uhpSubmissionAttempts: report.uhpSubmissionAttempts, liveCliInvocations: report.liveCliInvocations, responseId: report.responseId, sessionId: report.sessionId, retry: report.retry, evidenceFile }, null, 2)}\n`);
  process.exitCode = 1;
}
