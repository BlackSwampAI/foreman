import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, type UhpAdapter } from '../src/controller.js';
import type { Project, Run } from '../src/domain.js';
import { JsonStore } from '../src/store.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function waitForRun(store: JsonStore, runId: string): Promise<Run> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const state = await store.load();
    const run = state.projects.flatMap(project => project.tasks.flatMap(task => task.runs)).find(item => item.id === runId);
    if (run?.controller && !run.controller.active) return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Simulated run ${runId} did not reach its expected terminal state`);
}

describe('Planner task approval and default Start work flow', () => {
  it('keeps task creation idle, then approves the default plan and records evidence on a distinct run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'foreman-task-approval-'));
    dirs.push(dir);
    const repoPath = '/fixture/repository';
    const head = 'a'.repeat(40);
    const seededBases: string[] = [];

    const store = new JsonStore(join(dir, 'state.json'));
    await store.mutate(state => {
      for (const role of state.roles) {
        role.enabled = true;
        role.availableConfigs = [{ harnessId: 'fixture', model: 'model-fixture' }];
        role.config = { harnessId: 'fixture', model: 'model-fixture' };
      }
    });
    const submitted: Array<{ roleId: string; taskId: string; runId: string }> = [];
    let controller!: Controller;
    const adapter: UhpAdapter = {
      submit: async input => {
        submitted.push({ roleId: input.roleId, taskId: input.taskId, runId: input.runId });
        const output = input.roleId === 'planner'
          ? JSON.stringify({ reply: 'I prepared one focused README task.', tasks: [{
            title: 'Clarify the quickstart',
            goal: 'Explain the Planner task approval flow in the README.',
            suggestedAllowedPaths: [],
            validationCriteria: ['The quickstart explains task and result approval separately.'],
          }] })
          : input.roleId === 'orchestrator'
            ? JSON.stringify({ workerTask: 'Update README.md with the approved quickstart wording.' })
            : input.roleId === 'reviewer'
              ? JSON.stringify({ verdict: 'recommend', rationale: 'The simulated evidence is complete and in scope.' })
              : 'Simulated Worker completed the approved README task.';
        const current = input.roleId === 'reviewer'
          ? (await store.load()).projects.flatMap(project => project.tasks.flatMap(task => task.runs)).find(run => run.id === input.runId)
          : undefined;
        const validation = current ? (controller as any).reviewerEvidencePackage(current).controllerValidation : undefined;
        return {
          externalId: `fixture-${input.roleId}-${submitted.length}`,
          responseId: `fixture-response-${input.roleId}-${submitted.length}`,
          sessionId: `fixture-session-${input.roleId}`,
          status: 'completed',
          outputText: output,
          actualModel: 'model-fixture',
          requestedModel: 'model-fixture',
          selectedHarnessId: 'fixture',
          ...(input.roleId === 'reviewer' ? { reviewerExecution: { mode: 'read_only', mutationAttempted: false, validation, contextDigest: (input.config.reviewEvidence as any)?.reviewContextDigest } } : {}),
        };
      },
      cancel: async () => ({ status: 'cancelled' }),
    };
    controller = new Controller(store, adapter);
    (controller as any).currentHead = async () => head;
    const validationCommands = [{ name: 'fixture validation', command: 'true', args: [] }];
    controller.configureVerifiedWorkspace({
      repoPath,
      allowedScope: ['README.md'],
      commands: validationCommands,
      bridgeBaseUrl: 'http://127.0.0.1:1',
    });

    const project = await controller.createProject('Task approval fixture') as Project;
    const planned = await controller.sendProjectPlannerMessage(project.id, 'Clarify the README quickstart.');
    const [task] = planned.createdTasks;
    expect(task).toBeTruthy();
    expect(submitted.map(item => item.roleId)).toEqual(['planner']);
    expect((await controller.state()).projects.find(item => item.id === project.id)?.tasks.flatMap(item => item.runs)).toHaveLength(0);

    const preview = await controller.taskStartPreview(task!.id) as {
      canStart: boolean;
      reasons: string[];
      scope: string[];
      roleConfigs: Record<string, { harnessId: string; model: string }>;
      validationCommands: Array<{ name: string; command: string; args: string[] }>;
      budgets: { roleTurns: Record<string, number>; workerAttempts: number };
      baseCommit: string;
    };
    expect(preview.canStart).toBe(true);
    expect(preview.reasons).toEqual([]);
    expect(task!.suggestedAllowedPaths).toEqual([]);
    expect(preview.scope).toEqual(['README.md']);
    expect(preview.validationCommands).toEqual(validationCommands);
    expect(preview.baseCommit).toBe(head);
    for (const roleId of ['orchestrator', 'worker', 'reviewer']) {
      expect(preview.roleConfigs[roleId]).toEqual({ harnessId: 'fixture', model: 'model-fixture' });
    }

    // Model the repository HEAD and bridge seed deterministically; all role turns use UHP fixtures.
    (controller as any).prepareWorkerWorkspace = async (runId: string, baseCommit: string) => {
      seededBases.push(baseCommit);
      await store.mutate(state => {
        const run = state.projects.flatMap(project => project.tasks.flatMap(item => item.runs)).find(item => item.id === runId)!;
        run.pinnedBaseCommit = baseCommit;
        run.workspaceId = `fixture-workspace-${runId}`;
      });
    };
    (controller as any).verifyWorkerOutput = async (runId: string, workerAssignmentId: string) => {
      let evidence: any;
      let validation: any;
      await store.mutate(state => {
        const run = state.projects.flatMap(project => project.tasks.flatMap(item => item.runs)).find(item => item.id === runId)!;
        const worker = run.assignments.find(item => item.id === workerAssignmentId)!;
        const stamp = new Date().toISOString();
        const commands = run.validationCommands!;
        const commandDigest = createHash('sha256').update(JSON.stringify(commands.map(command => ({
          args: command.args,
          command: command.command,
          name: command.name,
        })))).digest('hex');
        run.sessions.orchestrator.uhpSessionId = run.assignments.find(item => item.roleId === 'orchestrator')?.sessionId;
        run.workerEvidence = {
          provenance: 'bridge_snapshot',
          workerAssignmentId: worker.id,
          responseId: worker.responseId!,
          workspaceId: run.workspaceId,
          pinnedBaseCommit: run.pinnedBaseCommit!,
          completeSnapshot: { reportedComplete: true, reportedErrors: 0, entryCount: 1 },
          scopeVerified: true,
          allowedScope: run.allowedScope!,
          entries: [],
          changes: [{ path: 'README.md', kind: 'modify' }],
          reviewDiff: 'diff --git a/README.md b/README.md\n+Updated the quickstart flow',
          acceptance: 'not_decided',
        };
        run.validation = {
          id: 'fixture-validation',
          status: 'passed',
          passed: true,
          reportedPassed: true,
          checks: commands.map(command => ({ name: command.name, passed: true })),
          observations: commands.map(command => ({
            name: command.name,
            command: command.command,
            args: command.args,
            exitCode: 0,
            timedOut: false,
            output: 'passed',
            outputTruncated: false,
            startedAt: stamp,
            finishedAt: stamp,
            passed: true,
          })),
          policy: { requireAllChecksPass: true, configuredCheckCount: commands.length, commandDigest },
          gitEvidence: { status: 'verified', commit: run.pinnedBaseCommit!, changedPaths: ['README.md'], submittedAt: stamp },
          createdAt: stamp,
        };
        run.orchestratorInbox = (controller as any).buildOrchestratorInbox(runId, run);
        evidence = run.workerEvidence;
        validation = run.validation;
      });
      return { workerEvidence: evidence, validation };
    };

    const started = await controller.startTaskWork(task!.id);
    expect(started.id).not.toBe(task!.id);
    expect(started.id).toMatch(/^run_/);
    const approvedState = await store.load();
    const approvedProject = approvedState.projects.find(item => item.id === project.id)!;
    const approvedTask = approvedProject.tasks.find(item => item.id === task!.id)!;
    expect(approvedTask.planApproval).toMatchObject({
      status: 'approved',
      runId: started.id,
      plan: {
        scope: preview.scope,
        roleConfigs: preview.roleConfigs,
        validationCommands: preview.validationCommands,
        budgets: preview.budgets,
        baseCommit: preview.baseCommit,
      },
    });
    expect(approvedTask.runs).toHaveLength(1);
    expect(approvedTask.runs[0]?.id).toBe(started.id);
    expect(approvedTask.runs[0]?.projectPlannerContext).toContain(task!.goal);
    expect(approvedTask.runs[0]?.projectPlannerContext).toContain(task!.validationCriteria?.[0]);

    const completed = await waitForRun(store, started.id);
    expect(completed.workerEvidence).toMatchObject({
      workerAssignmentId: expect.any(String),
      responseId: expect.any(String),
      workspaceId: `fixture-workspace-${started.id}`,
      pinnedBaseCommit: head,
      allowedScope: ['README.md'],
      scopeVerified: true,
    });
    expect(completed.workerEvidence?.workerAssignmentId).toBe(completed.assignments.find(item => item.roleId === 'worker')?.id);
    expect(completed.validation).toMatchObject({ status: 'passed', policy: { configuredCheckCount: 1 } });
    expect(completed.reviewerRecommendation?.verdict).toBe('recommend');
    expect(completed.approval).toBeUndefined();
    expect(completed.promotion).toBeUndefined();
    expect(completed.controller).toMatchObject({ active: false, phase: 'awaiting_approval' });
    expect(seededBases).toEqual([head]);
    expect(submitted.map(item => item.roleId)).toEqual(['planner', 'orchestrator', 'worker', 'reviewer']);
    expect(new Set(submitted.slice(1).map(item => item.runId))).toEqual(new Set([started.id]));
    expect(submitted.filter(item => item.roleId === 'worker')).toHaveLength(1);

    const editedTask = await controller.updateTask(task!.id, { goal: 'Use the approved quickstart wording and explain the separate result review.' });
    expect(editedTask.planApproval).toBeUndefined();
    expect(editedTask.runs).toHaveLength(1);
    expect(editedTask.runs[0]?.projectPlannerContext).toContain(task!.goal);
    expect(editedTask.runs[0]?.workerEvidence).toEqual(completed.workerEvidence);
    expect(editedTask.runs[0]?.approval).toBeUndefined();
  });
});
