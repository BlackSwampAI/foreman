import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, type UhpAdapter } from '../src/controller.js';
import { JsonStore } from '../src/store.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function setup(adapter: Partial<UhpAdapter> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-prompt-limit-')); dirs.push(dir);
  const store = new JsonStore(join(dir, 'state.json'));
  await store.mutate(state => { for (const role of state.roles) { role.enabled = true; role.availableConfigs = [{ harnessId: 'fixture', model: 'model-fixture' }]; role.config = { harnessId: 'fixture', model: 'model-fixture' }; } });
  const uhp: UhpAdapter = { submit: async () => ({ externalId: 'resp-followup', responseId: 'resp-followup', sessionId: 'session-orchestrator', status: 'completed', outputText: 'bounded follow-up' }), cancel: async () => ({ status: 'cancelled' }), ...adapter };
  const controller = new Controller(store, uhp);
  const project: any = await controller.createProject('Prompt size fixture');
  const task: any = await controller.createTask(project.id, 'Inspect verified work');
  const run: any = await controller.createRun(task.id);
  const stamp = new Date().toISOString(), base = 'a'.repeat(40);
  await store.mutate(state => {
    const current = state.projects[0]!.tasks[0]!.runs[0]!;
    current.pinnedBaseCommit = base; current.workspaceId = 'workspace-fixture';
    current.sessions.orchestrator.uhpSessionId = 'session-orchestrator';
    current.assignments.push({ id: 'worker-fixture', roleId: 'worker', status: 'succeeded', requestedConfig: { harnessId: 'fixture', model: 'model-fixture' }, responseId: 'resp-worker', sessionId: 'session-worker', prompt: 'edit README', submissionId: 'worker-sub', idempotencyKey: 'worker-key', createdAt: stamp } as any);
    current.workerEvidence = { provenance: 'recorded_replay', workerAssignmentId: 'worker-fixture', responseId: 'resp-worker', pinnedBaseCommit: base, completeSnapshot: { reportedComplete: true, reportedErrors: 0, entryCount: 1 }, scopeVerified: true, allowedScope: ['README.md'], entries: [], changes: [{ path: 'README.md', kind: 'modified', summary: 'edit' }], reviewDiff: `diff --git a/README.md b/README.md\n${'+large diff line\n'.repeat(550)}`, acceptance: 'not_decided' } as any;
    current.validation = { id: 'validation-fixture', status: 'passed', passed: true, reportedPassed: true, checks: [{ name: 'fixture check', passed: true }], observations: [{ name: 'fixture check', command: 'fixture', args: [], exitCode: 0, timedOut: false, output: 'validation output '.repeat(400), outputTruncated: false, startedAt: stamp, finishedAt: stamp, passed: true }], policy: { requireAllChecksPass: true, configuredCheckCount: 1 }, createdAt: stamp } as any;
  });
  await store.mutate(state => {
    const current = state.projects[0]!.tasks[0]!.runs[0]!;
    current.orchestratorInbox = (controller as any).buildOrchestratorInbox(current.id, current);
  });
  return { controller, store, run };
}

describe('UHP prompt size and stopped-run recovery', () => {
  it('keeps the bridge diagnostic on a terminal assignment failure', async () => {
    const { controller, store, run } = await setup({ submit: async () => ({ externalId: 'failed-response', responseId: 'failed-response', status: 'failed', result: { message: 'Codex CLI exited before reporting a session id' } }) });
    const assignment = await controller.assign(run.id, 'planner', 'Summarize the task.');
    expect(assignment).toMatchObject({ status: 'failed', error: 'Codex CLI exited before reporting a session id' });
    expect((await store.load()).projects[0]!.tasks[0]!.runs[0]!.assignments.at(-1)?.result).toEqual({ message: 'Codex CLI exited before reporting a session id' });
  });

  it('rejects correction resume without a recovered stopped run and makes no UHP submission', async () => {
    let calls = 0;
    const { controller, run } = await setup({ submit: async () => { calls++; throw new Error('must not submit'); } });
    await expect(controller.resumeReviewerCorrection(run.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(calls).toBe(0);
  });

  it('bounds the composed Orchestrator follow-up while retaining the full verified inbox', async () => {
    const submissions: string[] = [];
    const { controller, store, run } = await setup({ submit: async input => { submissions.push(input.prompt); return { externalId: 'resp-followup', responseId: 'resp-followup', sessionId: 'session-orchestrator', status: 'completed', outputText: 'bounded follow-up' }; } });
    const operatorQuestion = `Please inspect the verified result. ${'question detail '.repeat(180)} Preserve this final instruction: return a JSON object with verdict and rationale.`;
    const result = await controller.followUpOrchestrator(run.id, operatorQuestion);
    expect(result.assignment.status).toBe('succeeded');
    expect(submissions).toHaveLength(1);
    expect(Buffer.byteLength(submissions[0]!, 'utf8')).toBeLessThan(16_000);
    expect(submissions[0]).toMatch(/truncat/i);
    expect(submissions[0]).toContain(operatorQuestion);
    const saved = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
    expect(saved.orchestratorInbox?.reviewDiff).toContain('+large diff line');
    expect(saved.orchestratorInbox?.validation.observations[0]?.output).toContain('validation output');
  });

  it('records a deterministic prompt_limit rejection and does not replay it during recovery', async () => {
    let calls = 0;
    const { controller, store, run } = await setup({ submit: async input => { calls++; expect(Buffer.byteLength(input.prompt, 'utf8')).toBeLessThan(16_000); throw Object.assign(new Error('UHP request failed (400): prompt_limit'), { statusCode: 400 }); } });
    await expect(controller.followUpOrchestrator(run.id, `Review this result. ${'detail '.repeat(300)} Keep the required JSON instructions at the end.`)).rejects.toThrow('prompt_limit');
    const before = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
    expect(before.assignments.at(-1)).toMatchObject({ roleId: 'orchestrator', status: 'failed', error: expect.stringContaining('prompt_limit') });
    expect(before.orchestratorInbox?.reviewDiff).toContain('+large diff line');
    await controller.recover();
    const after = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
    expect(calls).toBe(1);
    expect(after.workerEvidence?.responseId).toBe('resp-worker');
    expect(after.orchestratorInbox?.evidenceDigest).toBeTruthy();
    expect(after.assignments.at(-1)?.status).toBe('failed');
  });

  it('restores an eligible Reviewer recommendation after a stopped prompt_limit correction', async () => {
    let calls = 0;
    const resumedPrompts: string[] = [];
    const { controller, store, run } = await setup({ submit: async input => { calls++; resumedPrompts.push(input.prompt); return { externalId: `resp-resume-${calls}`, responseId: `resp-resume-${calls}`, sessionId: 'session-orchestrator', status: 'completed', outputText: 'not a valid Worker proposal' }; } });
    controller.configureVerifiedWorkspace({ repoPath: '/fixture/repo', bridgeBaseUrl: 'http://127.0.0.1:1', allowedScope: ['README.md'], commands: [{ name: 'fixture', command: 'true', args: [] }] });
    const before = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
    const reviewEvidence = (controller as any).reviewerEvidencePackage(before);
    const stamp = new Date().toISOString(), recommendationAt = new Date(Date.now() + 1_000).toISOString(), orchestratorAt = new Date(Date.now() + 2_000).toISOString();
    const recommendation: any = { id: 'recommendation-fixture', status: 'proposed', provenance: 'uhp_response', reviewerAssignmentId: 'reviewer-fixture', harnessId: 'fixture', model: 'model-fixture', responseId: 'resp-reviewer', sessionId: 'session-reviewer', reviewMode: 'read_only', mutationAttempted: false, verdict: 'request_changes', rationale: 'Please make the requested edit.', createdAt: recommendationAt };
    await store.mutate(state => {
      const current = state.projects[0]!.tasks[0]!.runs[0]!;
      current.assignments.push({ id: 'reviewer-fixture', roleId: 'reviewer', status: 'succeeded', requestedConfig: { harnessId: 'fixture', model: 'model-fixture' }, actualConfig: { harnessId: 'fixture', model: 'model-fixture' }, requestedModel: 'model-fixture', selectedHarnessId: 'fixture', reportedHarnessId: 'fixture', responseId: 'resp-reviewer', sessionId: 'session-reviewer', reviewerExecution: { mode: 'read_only', mutationAttempted: false, validation: reviewEvidence.controllerValidation }, prompt: 'review', submissionId: 'review-sub', idempotencyKey: 'review-key', createdAt: stamp } as any);
      current.reviewerRecommendation = recommendation;
      current.reviewerRecommendationHistory = [recommendation];
      current.controller = { startedAt: stamp, active: false, phase: 'stopped', stoppedReason: 'UHP request failed (400): prompt_limit', budgets: { roleTurns: { planner: 2, orchestrator: 3, worker: 2, reviewer: 2 }, workerAttempts: 2 } };
    });
    await controller.retryReviewer(run.id);
    await store.mutate(state => {
      const current = state.projects[0]!.tasks[0]!.runs[0]!;
      current.assignments.push({ id: 'orchestrator-prompt-limit', roleId: 'orchestrator', status: 'failed', requestedConfig: { harnessId: 'fixture', model: 'model-fixture' }, prompt: 'bounded correction', submissionId: 'orch-sub', idempotencyKey: 'orch-key', error: 'UHP request failed (400): prompt_limit', createdAt: orchestratorAt } as any);
      current.reviewerRecommendation = undefined;
      current.status = 'failed';
      current.controller = { ...current.controller!, active: false, phase: 'stopped', stoppedReason: 'UHP request failed (400): prompt_limit' };
    });

    await controller.recover();
    const recovered = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
    expect(calls).toBe(0);
    expect(recovered.reviewerRecommendation).toMatchObject({ id: recommendation.id, verdict: 'request_changes' });
    expect(recovered.reviewerRetryAuthorized).toBe(false);
    expect(recovered.status).toBe('awaiting_approval');
    expect((await store.load()).events.some(item => item.type === 'reviewer.recommendation_restored' && item.entityId === run.id && item.data.decisionRequired === true)).toBe(true);

    // A later CLI failure during correction is recoverable under the same evidence
    // binding; the UI must not treat prompt_limit as the only resumable error.
    await store.mutate(state => {
      const current = state.projects[0]!.tasks[0]!.runs[0]!;
      current.assignments.at(-1)!.error = 'Codex CLI exited before reporting a session id';
      current.controller!.stoppedReason = 'Orchestrator correction turn did not succeed';
    });
    expect(calls).toBe(0);
    const resumed = await controller.resumeReviewerCorrection(run.id);
    expect(resumed.controller).toMatchObject({ active: true, phase: 'orchestrating' });
    await expect(controller.resumeReviewerCorrection(run.id)).rejects.toMatchObject({ statusCode: 409 });
    for (let i = 0; i < 200; i++) {
      const current = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
      if (!current.controller?.active) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const stoppedAgain = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
    expect(calls).toBe(1);
    expect(resumedPrompts).toHaveLength(1);
    expect(Buffer.byteLength(resumedPrompts[0]!, 'utf8')).toBeLessThanOrEqual(12_000);
    expect(stoppedAgain.controller).toMatchObject({ active: false, phase: 'stopped' });
    expect(stoppedAgain.reviewerRecommendation).toMatchObject({ id: recommendation.id, verdict: 'request_changes' });

    await store.mutate(state => {
      const current = state.projects[0]!.tasks[0]!.runs[0]!, forged = { ...recommendation, id: 'forged-recommendation' };
      current.reviewerRecommendation = undefined;
      current.reviewerRecommendationHistory = [forged];
      current.reviewerRetryAuthorized = true;
      current.assignments.find(item => item.id === 'reviewer-fixture')!.reviewerExecution!.validation = { forged: true };
      current.status = 'failed';
      current.controller = { ...current.controller!, active: false, phase: 'stopped', stoppedReason: 'UHP request failed (400): prompt_limit' };
      state.events.push({ id: 'forged-retry-event', type: 'reviewer.retry_authorized', entityType: 'run', entityId: run.id, at: stamp, data: { previousRecommendationId: forged.id } });
    });
    await controller.recover();
    const rejectedRepair = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
    expect(rejectedRepair.reviewerRecommendation).toBeUndefined();
    expect(rejectedRepair.status).toBe('failed');
  });
});
