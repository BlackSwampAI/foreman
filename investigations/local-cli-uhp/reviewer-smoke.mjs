#!/usr/bin/env node
// One explicitly authorized live Reviewer smoke. Never invoked by tests.
// Imports the recorded Worker response without submitting another Worker task.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

await import('tsx/esm/api').then(({ register }) => register());
const { Controller } = await import('../../src/controller.ts');
const { JsonStore } = await import('../../src/store.ts');
const { UhpClient } = await import('../../src/uhp.ts');
const { assertReviewerBounds, isPrepareOnly, REVIEWER_TASK_BOUNDS, REVIEWER_STREAM_INACTIVITY_TIMEOUT_MS } = await import('./reviewer-smoke-bounds.mjs');

const [baseUrl, repoPathArg, evidenceFileArg, model] = process.argv.slice(2);
if (!baseUrl || !repoPathArg || !evidenceFileArg || !model) throw new Error('Usage: node reviewer-smoke.mjs <loopback-uhp-url> <worker-repo> <recorded-evidence.json> <explicit-claude-model>');
const repoPath = resolve(repoPathArg), evidenceFile = resolve(evidenceFileArg), harnessId = 'claude-code';
assertReviewerBounds(REVIEWER_TASK_BOUNDS);
const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'));
if (evidence.validation !== 'verified_by_foreman_git_comparison' || evidence.scopeVerified !== true || evidence.acceptance !== 'not_decided' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(evidence.baseCommit ?? '') || !evidence.responseId || !evidence.sessionId || !evidence.actualModel || !evidence.allowedScope?.length || !evidence.reviewDiff) throw new Error('Recorded Worker evidence is incomplete or was not verified by Foreman');
const evidenceDigest = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
const stateDir = resolve(process.env.FOREMAN_REVIEWER_SMOKE_STATE_DIR ?? '/tmp/foreman-read-only-reviewer-smoke');
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const stateFile = resolve(stateDir, 'state.json'), markerFile = resolve(stateDir, 'smoke.json');
const marker = await readMarker();
if (marker && (marker.baseUrl !== baseUrl || marker.repoPath !== repoPath || marker.evidenceDigest !== evidenceDigest || marker.model !== model)) throw new Error('Persisted Reviewer smoke state belongs to different evidence or configuration; choose a new state directory');

const command = "const fs=require('node:fs');const crypto=require('node:crypto');const hash=crypto.createHash('sha256').update(fs.readFileSync('README.md')).digest('hex');if(hash!=='ec226d04f0a4bb12dac8bb031969ed266f892929161dac7da361485fe587633e')process.exit(1);console.log('recorded README SHA-256 verified')";
const store = new JsonStore(stateFile);
await store.load();
const uhp = new UhpClient({ baseUrl, timeoutMs: 90_000, streamInactivityTimeoutMs: REVIEWER_STREAM_INACTIVITY_TIMEOUT_MS, harnessId, model });
const controller = new Controller(store, uhp, false, true, { harnessId, model }, undefined, 90);
controller.configureVerifiedWorkspace({ repoPath, allowedScope: evidence.allowedScope, commands: [{ name: 'recorded README SHA-256', command: process.execPath, args: ['-e', command] }], timeoutMs: 10_000, maxOutputBytes: 2_000 });
await controller.refreshDiscovery();
const discovery = await uhp.discover(true);
if (discovery.capabilities.readOnlyReviewer !== true) throw new Error('UHP bridge does not advertise read-only Reviewer mode');

let projectId = marker?.projectId, taskId = marker?.taskId, runId = marker?.runId;
const saveMarker = async () => saveJson(markerFile, { baseUrl, repoPath, evidenceDigest, model, projectId, taskId, runId });
if (!projectId) { const project = await controller.createProject('Recorded Worker Reviewer smoke'); projectId = project.id; await saveMarker(); }
if (!taskId) { const task = await controller.createTask(projectId, 'Review the recorded verified Worker change'); taskId = task.id; await saveMarker(); }
if (!runId) { const run = await controller.createRun(taskId); runId = run.id; await saveMarker(); }
await controller.pinWorkerBase(runId, evidence.baseCommit);
await controller.selectRoleConfig('reviewer', { harnessId, model, options: { ...REVIEWER_TASK_BOUNDS } }, undefined, runId);

let run = findRun(await controller.state(), runId);
if (!run.workerEvidence) {
  await controller.importRecordedWorkerEvidence(runId, { responseId: evidence.responseId, sessionId: evidence.sessionId, actualModel: evidence.actualModel, usage: evidence.usage, evidence });
}
run = findRun(await controller.state(), runId);
if (run.validation?.status !== 'passed') {
  await controller.retryValidation(runId);
  run = findRun(await controller.state(), runId);
}
if (run.validation?.status !== 'passed' || !run.validation.observations?.length || run.validation.observations.some(o => !o.passed || o.exitCode !== 0 || o.timedOut || o.outputTruncated)) throw new Error('Controller-observed README hash validation did not pass');
assertReviewerBounds(run.roleConfigs.reviewer.options);

if (isPrepareOnly(process.env.FOREMAN_REVIEWER_SMOKE_PREPARE_ONLY)) {
  const preparation = {
    reportVersion: 1,
    status: 'prepared_only',
    acceptance: 'not_decided',
    provenance: { worker: 'recorded_live_import_no_worker_submit', reviewer: 'not_submitted' },
    pinnedBaseCommit: run.pinnedBaseCommit,
    worker: { responseId: evidence.responseId, sessionId: evidence.sessionId, actualModel: evidence.actualModel, usage: evidence.usage ?? null, validation: evidence.validation, scopeVerified: evidence.scopeVerified, allowedScope: evidence.allowedScope, reviewDiff: evidence.reviewDiff },
    controllerValidation: run.validation,
    runId,
  };
  const outputFile = resolve(process.env.FOREMAN_REVIEWER_SMOKE_EVIDENCE_FILE ?? `${stateDir}/reviewer-evidence.json`);
  await saveJson(outputFile, preparation);
  process.stdout.write(`${JSON.stringify({ status: 'prepared_only', runId, baseCommit: preparation.pinnedBaseCommit, workerResponseId: evidence.responseId, validationStatus: run.validation.status, validationChecks: run.validation.observations.length, reviewerSubmitted: false, evidenceFile: outputFile }, null, 2)}\n`);
  process.exit(0);
}

let recommendation = run.reviewerRecommendation;
let reviewerAssignment = recommendation ? run.assignments.find(a => a.id === recommendation.reviewerAssignmentId) : undefined;
if (!recommendation) {
  const existing = run.assignments.filter(a => a.roleId === 'reviewer');
  if (existing.length > 1) throw new Error('Persisted state has multiple Reviewer attempts; refusing another live request');
  if (existing.length === 1) {
    reviewerAssignment = existing[0];
    if (['running','submitted'].includes(reviewerAssignment.status) && reviewerAssignment.responseId) {
      await controller.refreshAssignment(reviewerAssignment.id); // retrieval only; never resubmits.
      run = findRun(await controller.state(), runId); reviewerAssignment = run.assignments.find(a => a.id === reviewerAssignment.id);
    }
    if (reviewerAssignment?.status === 'succeeded') {
      try { recommendation = await controller.recordReviewerRecommendation(runId, reviewerAssignment.id, 'uhp_response'); }
      catch { /* emit the durable response evidence below */ }
      run = findRun(await controller.state(), runId); recommendation = run.reviewerRecommendation;
    }
  } else {
    const callLock = resolve(stateDir, 'reviewer-call-started.json');
    try {
      await writeFile(callLock, `${JSON.stringify({ runId, evidenceDigest, startedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
      await saveMarker(); // Controller persists its generated idempotency key in state before the UHP POST.
      await controller.requestReviewer(runId, 'uhp_response');
      run = findRun(await controller.state(), runId); recommendation = run.reviewerRecommendation;
      reviewerAssignment = run.assignments.find(a => a.roleId === 'reviewer');
    } catch {
      run = findRun(await controller.state(), runId); reviewerAssignment = run.assignments.find(a => a.roleId === 'reviewer');
    }
  }
}
if (!recommendation || !reviewerAssignment?.idempotencyKey || !recommendation.actualModel || !recommendation.responseId || !recommendation.sessionId || recommendation.reviewMode !== 'read_only' || recommendation.mutationAttempted !== false || reviewerAssignment.status !== 'succeeded') {
  const failureReport = { reportVersion:1, acceptance:'not_decided', provenance:{worker:'recorded_live_import_no_worker_submit',reviewer:'uhp_response'}, runId, pinnedBaseCommit:run.pinnedBaseCommit, reviewerAttempt:reviewerAssignment ? { responseId:reviewerAssignment.responseId ?? reviewerAssignment.externalId ?? null, status:reviewerAssignment.status, actualModel:reviewerAssignment.actualConfig?.model ?? null, sessionId:reviewerAssignment.sessionId ?? null, idempotencyKey:reviewerAssignment.idempotencyKey, reviewerExecution:reviewerAssignment.reviewerExecution ?? null } : { responseId:null,status:'not_recorded',idempotencyKey:null } };
  const failedFile=resolve(process.env.FOREMAN_REVIEWER_SMOKE_EVIDENCE_FILE??`${stateDir}/reviewer-evidence.json`); await saveJson(failedFile,failureReport);
  process.stdout.write(`${JSON.stringify({status:'failed',runId,reviewerResponseId:failureReport.reviewerAttempt.responseId,reviewerStatus:failureReport.reviewerAttempt.status,idempotencyKey:failureReport.reviewerAttempt.idempotencyKey,evidenceFile:failedFile},null,2)}\n`);
  process.exitCode=1;
} else {

const report = {
  reportVersion: 1,
  acceptance: 'not_decided',
  provenance: { worker: 'recorded_live_import_no_worker_submit', reviewer: recommendation.provenance },
  pinnedBaseCommit: run.pinnedBaseCommit,
  worker: { responseId: evidence.responseId, sessionId: evidence.sessionId, actualModel: evidence.actualModel, usage: evidence.usage ?? null, validation: evidence.validation, scopeVerified: evidence.scopeVerified, allowedScope: evidence.allowedScope, reviewDiff: evidence.reviewDiff },
  controllerValidation: run.validation,
  reviewer: { responseId: recommendation.responseId, sessionId: recommendation.sessionId, harnessId: recommendation.harnessId, requestedModel: recommendation.model, actualModel: recommendation.actualModel, usage: recommendation.usage ?? null, verdict: recommendation.verdict, rationale: recommendation.rationale, reviewMode: recommendation.reviewMode, mutationAttempted: recommendation.mutationAttempted, idempotencyKey: reviewerAssignment.idempotencyKey },
  runId,
};
const outputFile = resolve(process.env.FOREMAN_REVIEWER_SMOKE_EVIDENCE_FILE ?? `${stateDir}/reviewer-evidence.json`);
await saveJson(outputFile, report);
process.stdout.write(`${JSON.stringify({ status: 'complete', runId, baseCommit: report.pinnedBaseCommit, workerResponseId: report.worker.responseId, validationStatus: run.validation.status, validationChecks: run.validation.observations.length, reviewerResponseId: report.reviewer.responseId, reviewerSessionId: report.reviewer.sessionId, reviewerActualModel: report.reviewer.actualModel, reviewerUsage: report.reviewer.usage, verdict: report.reviewer.verdict, reviewMode: report.reviewer.reviewMode, mutationAttempted: report.reviewer.mutationAttempted, idempotencyKey: report.reviewer.idempotencyKey, evidenceFile: outputFile }, null, 2)}\n`);
}

function findRun(state, id) { for (const project of state.projects) for (const task of project.tasks) for (const run of task.runs) if (run.id === id) return run; throw new Error(`Persisted smoke run not found: ${id}`); }
async function readMarker() { try { return JSON.parse(await readFile(markerFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
async function saveJson(path, value) { const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temp, path); }
