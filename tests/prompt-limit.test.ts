import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, workerProposalScopeIssue, type UhpAdapter } from '../src/controller.js';
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
  it('enforces scope via targetFiles and ignores prose; legacy fallback passes non-AGY and uses Target file: lines for AGY', () => {
    const scope = ['docs/'];
    // targetFiles in scope — prose with e.g., NBA-compatible/NFL-only/unverified, GET /v1/state/{sport} does not matter
    expect(workerProposalScopeIssue(['docs/api-matrix.md'], scope)).toBeUndefined();
    // regression: workerTask mentioning "e.g." and API route example with targetFiles in scope passes
    expect(workerProposalScopeIssue(['nodes/Sleeper/transport/sleeperApiRequest.ts'], ['nodes/'])).toBeUndefined();
    // out-of-scope targetFile is rejected with the standard message
    expect(workerProposalScopeIssue(['docs/api-matrix.md', 'src/controller.ts'], scope)).toContain('outside the allowed scope: src/controller.ts');
    // absolute path is rejected
    expect(workerProposalScopeIssue(['/etc/passwd'], scope)).toContain('outside the allowed scope: /etc/passwd');
    // path traversal is rejected
    expect(workerProposalScopeIssue(['../secret.ts'], scope)).toContain('outside the allowed scope: ../secret.ts');
    // non-AGY with no targetFiles: legacy pass (post-diff verification enforces scope)
    expect(workerProposalScopeIssue(undefined, scope)).toBeUndefined();
    // AGY with no targetFiles and no Target file: line: requires a target
    expect(workerProposalScopeIssue(undefined, scope, true)).toContain('Antigravity Worker requires');
    // AGY with no targetFiles but a valid Target file: line in the task text: passes
    expect(workerProposalScopeIssue(undefined, scope, true, [], 'Target file: docs/api-matrix.md. Update the coverage table.')).toBeUndefined();
    // AGY with no targetFiles but an out-of-scope Target file: line: rejected
    expect(workerProposalScopeIssue(undefined, scope, true, [], 'Target file: src/controller.ts. Fix the bug.')).toContain('outside the allowed scope: src/controller.ts');
    // AGY with explicit empty targetFiles: requires a target
    expect(workerProposalScopeIssue([], scope, true)).toContain('Antigravity Worker requires');
    // AGY with targetFiles in scope: passes
    expect(workerProposalScopeIssue(['docs/api-matrix.md'], scope, true)).toBeUndefined();
  });
  it('stores the complete Reviewer rationale without clipping it', async () => {
    const { controller, store, run } = await setup();
    const current = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
    const evidence = (controller as any).reviewerEvidencePackage(current);
    const rationale = `${'Reviewer issue detail. '.repeat(230)} FINAL STORED RATIONALE MARKER.`;
    await store.mutate(state => {
      state.projects[0]!.tasks[0]!.runs[0]!.assignments.push({
        id: 'reviewer-long-rationale', roleId: 'reviewer', status: 'succeeded',
        requestedConfig: { harnessId: 'fixture', model: 'model-fixture' },
        actualConfig: { harnessId: 'fixture', model: 'model-fixture' },
        requestedModel: 'model-fixture', selectedHarnessId: 'fixture', reportedHarnessId: 'fixture',
        responseId: 'resp-reviewer-long', sessionId: 'session-reviewer-long',
        result: JSON.stringify({ verdict: 'request_changes', rationale }),
        reviewerExecution: { mode: 'read_only', mutationAttempted: false, validation: evidence.controllerValidation },
      } as any);
    });
    const recommendation: any = await controller.recordReviewerRecommendation(run.id, 'reviewer-long-rationale');
    expect(Buffer.byteLength(rationale, 'utf8')).toBeGreaterThan(4_000);
    expect(recommendation.rationale).toBe(rationale);
    expect((await store.load()).projects[0]!.tasks[0]!.runs[0]!.reviewerRecommendation?.rationale).toBe(rationale);
  });
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
    const recommendation: any = { id: 'recommendation-fixture', status: 'proposed', provenance: 'uhp_response', reviewerAssignmentId: 'reviewer-fixture', harnessId: 'fixture', model: 'model-fixture', responseId: 'resp-reviewer', sessionId: 'session-reviewer', reviewMode: 'read_only', mutationAttempted: false, verdict: 'request_changes', rationale: `Please make the requested edit. ${'Issue detail needs a concrete fix. '.repeat(130)} Final issue: downgrade every claim without captured evidence. FINAL MARKER beyond 3500 bytes.`, createdAt: recommendationAt };
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
    expect(Buffer.byteLength(recommendation.rationale, 'utf8')).toBeGreaterThan(2_000);
    expect(Buffer.byteLength(recommendation.rationale, 'utf8')).toBeGreaterThan(3_500);
    expect(resumedPrompts[0]).toContain('Final issue: downgrade every claim without captured evidence.');
    expect(resumedPrompts[0]).toContain('FINAL MARKER beyond 3500 bytes.');
    expect(resumedPrompts[0]).toContain('A URL, placeholder ID, or unsupported example is not proof of an observation.');
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

  it('resumes a saved valid Reviewer correction plan without another Orchestrator call', async () => {
    let calls = 0; const resumedPrompts: string[] = [];
    const { controller, store, run } = await setup({ submit: async input => { calls++; resumedPrompts.push(input.prompt); throw new Error('No model call expected'); } });
    controller.configureVerifiedWorkspace({ repoPath: '/fixture/repo', bridgeBaseUrl: 'http://127.0.0.1:1', allowedScope: ['docs/api-matrix.md'], commands: [{ name: 'fixture', command: 'true', args: [] }] });
    const before = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
    const reviewEvidence = (controller as any).reviewerEvidencePackage(before);
    const stamp = new Date().toISOString(), recommendationAt = new Date(Date.now() + 1_000).toISOString(), orchestratorAt = new Date(Date.now() + 2_000).toISOString();
    const rationale = `Please make the requested edit. ${'Review issue detail. '.repeat(260)} FINAL ISSUE MARKER beyond prior cutoff.`;
    const recommendation: any = { id: 'recommendation-saved-plan', status: 'proposed', provenance: 'uhp_response', reviewerAssignmentId: 'reviewer-saved-plan', harnessId: 'fixture', model: 'model-fixture', responseId: 'resp-reviewer', sessionId: 'session-reviewer', reviewMode: 'read_only', mutationAttempted: false, verdict: 'request_changes', rationale, createdAt: recommendationAt };
    await store.mutate(state => {
      const current = state.projects[0]!.tasks[0]!.runs[0]!;
      current.allowedScope = ['docs/api-matrix.md']; current.workerEvidence!.allowedScope = ['docs/api-matrix.md'];
      current.workerProposal = { id: 'proposal-original', status: 'dispatched', text: 'Original Worker task', orchestratorAssignmentId: 'orchestrator-original', createdAt: stamp, workerAssignmentId: 'worker-fixture' };
      current.assignments.push({ id: 'reviewer-saved-plan', roleId: 'reviewer', status: 'succeeded', requestedConfig: { harnessId: 'fixture', model: 'model-fixture' }, actualConfig: { harnessId: 'fixture', model: 'model-fixture' }, requestedModel: 'model-fixture', selectedHarnessId: 'fixture', reportedHarnessId: 'fixture', responseId: 'resp-reviewer', sessionId: 'session-reviewer', reviewerExecution: { mode: 'read_only', mutationAttempted: false, validation: reviewEvidence.controllerValidation }, prompt: 'review', submissionId: 'review-sub-saved-plan', idempotencyKey: 'review-key-saved-plan', createdAt: stamp } as any);
      current.reviewerRecommendation = recommendation;
      current.reviewerRecommendationHistory = [recommendation];
      current.assignments.push({ id: 'orchestrator-saved-plan', roleId: 'orchestrator', status: 'succeeded', requestedConfig: { harnessId: 'fixture', model: 'model-fixture' }, prompt: 'bounded correction', submissionId: 'orch-sub-saved-plan', idempotencyKey: 'orch-key-saved-plan', result: JSON.stringify({ workerTask: 'Use the /state/nba sample endpoint as context. Target file: docs/api-matrix.md. Update the coverage table.' }), createdAt: orchestratorAt } as any);
      current.orchestratorInbox = (controller as any).buildOrchestratorInbox(current.id, current); current.orchestratorInbox!.deliveredInAssignmentId = 'orchestrator-saved-plan';
      current.controller = { startedAt: stamp, active: false, phase: 'stopped', stoppedReason: 'Worker proposal references a path outside the allowed scope: supported/unsupported/unverified', budgets: { roleTurns: { planner: 2, orchestrator: 1, worker: 2, reviewer: 2 }, workerAttempts: 2 } };
      current.status = 'awaiting_approval';
      state.events.push({ id: 'saved-plan-retry-authorized', type: 'reviewer.retry_authorized', entityType: 'run', entityId: run.id, at: stamp, data: { previousRecommendationId: recommendation.id } });
    });
    (controller as any).retryWorkerProposal = async () => { throw new Error('fixture stopped before Worker dispatch'); };

    const validPlanState = await store.load();
    expect((controller as any).savedReviewerCorrectionPlan(validPlanState.projects[0]!.tasks[0]!.runs[0]!, validPlanState.events)?.id).toBe('orchestrator-saved-plan');

    const resumed = await controller.resumeReviewerCorrection(run.id);
    expect(resumed.controller).toMatchObject({ active: true, phase: 'orchestrating' });
    for (let i = 0; i < 200; i++) {
      const current = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
      if (!current.controller?.active) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const saved = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
    expect(calls).toBe(0);
    expect(saved.workerProposal?.text).toContain('/state/nba');
    expect(saved.workerProposal?.text).toContain('Target file: docs/api-matrix.md');
    expect(saved.workerProposal?.orchestratorAssignmentId).toBe('orchestrator-saved-plan');
    expect(saved.assignments.filter(item => item.roleId === 'orchestrator')).toHaveLength(1);
    expect(saved.reviewerRecommendation).toMatchObject({ id: recommendation.id, verdict: 'request_changes', rationale });
    expect(saved.controller).toMatchObject({ active: false, phase: 'stopped' });

    await store.mutate(state => {
      const current = state.projects[0]!.tasks[0]!.runs[0]!;
      current.assignments.find(item => item.id === 'orchestrator-saved-plan')!.result = JSON.stringify({ workerTask: 'Update docs/api-matrix.md.', targetFiles: ['/state/nba'] });
      current.controller = { ...current.controller!, active: false, phase: 'stopped' };
      current.status = 'awaiting_approval';
    });
    const invalidPlanState = await store.load();
    expect((controller as any).savedReviewerCorrectionPlan(invalidPlanState.projects[0]!.tasks[0]!.runs[0]!, invalidPlanState.events)).toBeUndefined();
    await expect(controller.resumeReviewerCorrection(run.id)).rejects.toMatchObject({ statusCode: 409 });
  });
});
