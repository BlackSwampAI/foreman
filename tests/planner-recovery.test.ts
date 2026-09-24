import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, type UhpAdapter } from '../src/controller.js';
import type { Project } from '../src/domain.js';
import { JsonStore } from '../src/store.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function fixture(adapter: UhpAdapter) {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-planner-recovery-'));
  dirs.push(dir);
  const store = new JsonStore(join(dir, 'state.json'));
  await store.mutate(state => {
    for (const role of state.roles) {
      role.enabled = true;
      role.availableConfigs = [{ harnessId: 'fixture', model: 'model-fixture' }];
      role.config = { harnessId: 'fixture', model: 'model-fixture' };
    }
  });
  const controller = new Controller(store, adapter);
  const project = await controller.createProject('Planner recovery fixture') as Project;
  return { controller, project, store };
}

const forecastTask = {
  title: 'Update FantasyPros node',
  goal: 'Update the node documentation and cover the behavior with tests.',
  suggestedAllowedPaths: ['nodes/FantasyPros/**', 'test/**', 'docs/**', 'README.md'],
  validationCriteria: ['The focused tests pass.', 'The README describes the node.'],
};

describe('saved project Planner proposal recovery', () => {
  it('extracts the friendly reply and creates every valid task from a prose-prefixed JSON proposal', async () => {
    const proposal = {
      reply: 'I split the documentation and implementation work into two bounded tasks.',
      tasks: [
        forecastTask,
        {
          title: 'Add node coverage',
          goal: 'Add tests for the FantasyPros node.',
          suggestedAllowedPaths: ['**/nodes/**', '**/test/**', '**/tests/**', 'docs/**', 'examples/**'],
          validationCriteria: ['FantasyPros node tests pass.'],
        },
      ],
    };
    const savedOutput = `I reviewed the request and prepared a task breakdown.\n\n${JSON.stringify(proposal)}`;
    const submitted: string[] = [];
    const adapter: UhpAdapter = {
      submit: async input => {
        submitted.push(input.roleId);
        return { externalId: 'planner-response', responseId: 'planner-response-id', status: 'completed', outputText: savedOutput };
      },
      cancel: async () => ({ status: 'cancelled' }),
    };
    const { controller, project } = await fixture(adapter);
    const allowedScope = ['nodes/', 'test/', 'tests/', 'docs/', 'examples/', 'README.md'];
    controller.configureVerifiedWorkspace({
      repoPath: '/fixture/repository',
      allowedScope,
      commands: [{ name: 'fixture validation', command: 'true', args: [] }],
    });

    const result = await controller.sendProjectPlannerMessage(project.id, 'Please plan the node documentation and tests.');

    expect(result.reply).toBe(proposal.reply);
    expect(result.createdTasks).toHaveLength(2);
    expect(result.createdTasks[0]).toMatchObject({
      ...forecastTask,
      suggestedAllowedPaths: expect.arrayContaining(['test/', 'docs/', 'README.md']),
    });
    expect(result.createdTasks[0]?.suggestedAllowedPaths?.every(path => allowedScope.some(root => path === root || path.startsWith(root)))).toBe(true);
    expect(result.createdTasks[1]?.suggestedAllowedPaths).toEqual(expect.arrayContaining(['nodes/', 'test/', 'tests/', 'docs/', 'examples/']));
    expect(result.createdTasks[1]?.suggestedAllowedPaths?.every(path => allowedScope.some(root => path === root || path.startsWith(root)))).toBe(true);
    expect(result.createdTasks.flatMap(task => task.suggestedAllowedPaths ?? []).some(path => path.includes('*'))).toBe(false);
    expect(result.project.plannerMessages?.at(-1)).toMatchObject({ role: 'planner', text: proposal.reply });
    expect(submitted).toEqual(['planner']);
    expect(result.project.tasks.flatMap(task => task.runs)).toHaveLength(0);
  });

  it('creates planning-only tasks from a prose-prefixed proposal with an empty first path list', async () => {
    const proposal = {
      reply: 'I found one task that still needs a repository scope.',
      tasks: [
        {
          title: 'Discover the target node',
          goal: 'Identify the files to change before implementation.',
          suggestedAllowedPaths: [],
          validationCriteria: ['The target files are identified.'],
        },
        {
          title: 'Implement the node update',
          goal: 'Update the FantasyPros node and its docs.',
          suggestedAllowedPaths: ['**/nodes/**', '**/test/**', '**/tests/**', 'docs/**', 'examples/**'],
          validationCriteria: ['The focused tests pass.'],
        },
      ],
    };
    const savedOutput = `Here is the structured proposal from Planner:\n${JSON.stringify(proposal)}`;
    const adapter: UhpAdapter = {
      submit: async () => ({ externalId: 'invalid-planner-response', status: 'completed', outputText: savedOutput }),
      cancel: async () => ({ status: 'cancelled' }),
    };
    const { controller, project } = await fixture(adapter);

    const result = await controller.sendProjectPlannerMessage(project.id, 'Plan the implementation.');

    expect(result.reply).toBe(proposal.reply);
    expect(result.proposalError).toBeUndefined();
    expect(result.createdTasks).toHaveLength(2);
    expect(result.createdTasks[0]?.suggestedAllowedPaths).toEqual([]);
    expect(result.createdTasks[1]?.suggestedAllowedPaths).toEqual(proposal.tasks[1]!.suggestedAllowedPaths);
    expect((await controller.state()).projects.find(value => value.id === project.id)?.tasks).toHaveLength(2);
    expect(result.project.tasks.flatMap(task => task.runs)).toHaveLength(0);
  });

  it('rejects an invalid proposal batch without creating earlier valid tasks', async () => {
    const proposal = {
      reply: 'The proposed dependency points to a task that does not exist.',
      tasks: [
        {
          title: 'Valid first task',
          goal: 'Prepare the node documentation.',
          suggestedAllowedPaths: ['docs/**'],
          validationCriteria: ['Documentation check passes.'],
        },
        {
          title: 'Invalid dependent task',
          goal: 'Add the node implementation.',
          suggestedAllowedPaths: ['nodes/FantasyPros/**'],
          validationCriteria: ['Node tests pass.'],
          dependsOn: ['missing-proposal-ref'],
        },
      ],
    };
    const savedOutput = `Planner response:\n${JSON.stringify(proposal)}`;
    const adapter: UhpAdapter = {
      submit: async () => ({ externalId: 'invalid-dependency-response', status: 'completed', outputText: savedOutput }),
      cancel: async () => ({ status: 'cancelled' }),
    };
    const { controller, project } = await fixture(adapter);

    const result = await controller.sendProjectPlannerMessage(project.id, 'Prepare the implementation tasks.');

    expect(result.reply).toBe(proposal.reply);
    expect(result.proposalError).toContain('Unknown task dependency missing-proposal-ref');
    expect(result.createdTasks).toHaveLength(0);
    expect((await controller.state()).projects.find(value => value.id === project.id)?.tasks).toHaveLength(0);
  });

  it('recovers persisted assignment output idempotently without another model call or Worker dispatch, including after restart', async () => {
    const proposal = {
      reply: 'I split the node update into a scoped implementation and verification task.',
      tasks: [
        forecastTask,
        {
          title: 'Verify the node update',
          goal: 'Run the focused tests and review the documentation.',
          suggestedAllowedPaths: ['**/nodes/**', '**/test/**', '**/tests/**', 'docs/**', 'examples/**'],
          validationCriteria: ['Focused tests pass.'],
        },
      ],
    };
    const savedOutput = `I have organized the work.\n\n${JSON.stringify(proposal)}`;
    let submitCalls = 0;
    const adapter: UhpAdapter = {
      submit: async () => {
        submitCalls += 1;
        throw new Error('Recovery must use the persisted Planner assignment, not call the model.');
      },
      cancel: async () => ({ status: 'cancelled' }),
    };
    const { controller, project, store } = await fixture(adapter);
    const userText = 'Update the node docs and tests.';
    const assignmentId = 'saved-planner-assignment';
    await store.mutate(state => {
      const savedProject = state.projects.find(value => value.id === project.id)!;
      savedProject.plannerMessages = [
        { id: 'saved-user-message', role: 'user', text: userText, createdAt: new Date(0).toISOString() },
      ];
      savedProject.plannerAssignments = [{
        id: assignmentId,
        roleId: 'planner',
        status: 'succeeded',
        requestedConfig: { harnessId: 'fixture', model: 'model-fixture' },
        prompt: 'Saved prompt fixture',
        submissionId: 'saved-submission',
        idempotencyKey: 'saved-idempotency-key',
        responseId: 'saved-response-id',
        result: savedOutput,
        createdAt: new Date(2).toISOString(),
      } as any];
    });

    const first = await controller.recoverProjectPlannerTasks(project.id, assignmentId);
    expect(first).toMatchObject({ reply: proposal.reply, alreadyRecovered: false });
    expect(first.createdTasks).toHaveLength(2);
    expect((await store.load()).projects[0]?.plannerMessages?.at(-1)?.text).toBe(proposal.reply);

    const restarted = new Controller(new JsonStore(store.filePath), adapter);
    const second = await restarted.recoverProjectPlannerTasks(project.id, assignmentId);
    expect(second).toMatchObject({ reply: proposal.reply, alreadyRecovered: true });
    expect(second.createdTasks.map((task: { id: string }) => task.id)).toEqual(first.createdTasks.map((task: { id: string }) => task.id));

    const saved = (await new JsonStore(store.filePath).load()).projects.find(value => value.id === project.id)!;
    expect(saved.tasks.map(task => task.title)).toEqual(['Update FantasyPros node', 'Verify the node update']);
    expect(saved.plannerAssignments?.[0]).toMatchObject({ createdTaskIds: first.createdTasks.map((task: { id: string }) => task.id) });
    expect(saved.plannerMessages?.filter(message => message.role === 'planner')).toHaveLength(1);
    expect(saved.plannerMessages?.find(message => message.assignmentId === assignmentId)).toMatchObject({
      text: proposal.reply,
      createdTaskIds: first.createdTasks.map((task: { id: string }) => task.id),
    });
    expect(saved.tasks.flatMap(task => task.runs)).toHaveLength(0);
    expect(submitCalls).toBe(0);
  });
});
