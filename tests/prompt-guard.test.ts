import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, type HindsightAdapter, type UhpAdapter } from '../src/controller.js';
import { JsonStore } from '../src/store.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function setup(adapter: UhpAdapter, hindsight?: HindsightAdapter) {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-prompt-guard-'));
  dirs.push(dir);
  const store = new JsonStore(join(dir, 'state.json'));
  await store.mutate(state => {
    for (const role of state.roles) {
      role.enabled = true;
      role.availableConfigs = [{ harnessId: 'fixture', model: 'model-fixture' }];
      role.config = { harnessId: 'fixture', model: 'model-fixture' };
    }
  });
  return { store, controller: new Controller(store, adapter, !!hindsight, false, undefined, hindsight) };
}

const success = { externalId: 'fixture-response', responseId: 'fixture-response', status: 'completed' as const, outputText: 'Recorded.' };

describe('prompt size guard before UHP submission', () => {
  it('bounds prior Planner context before dropping any of the current human message', async () => {
    const prompts: string[] = [];
    const adapter: UhpAdapter = { submit: async input => { prompts.push(input.prompt); return success; }, cancel: async () => ({ status: 'cancelled' }) };
    const { controller, store } = await setup(adapter);
    const project = await controller.createProject('Large Planner context') as { id: string };
    const operatorMessage = `CURRENT_REQUEST_START ${'current detail '.repeat(300)} CURRENT_REQUEST_END`;

    // Model a large, valid historical project index without creating a large number
    // of unrelated setup operations in this regression test.
    await store.mutate(state => {
      const p = state.projects.find(item => item.id === project.id)!;
      p.tasks = Array.from({ length: 20 }, (_, index) => ({
        id: `tsk_${String(index).padStart(36, '0')}`,
        title: `Prior task ${index} ${'x'.repeat(90)}`,
        status: 'ready',
        createdAt: new Date(0).toISOString(),
        runs: [],
        dependsOn: [],
      })) as typeof p.tasks;
      p.plannerMessages = Array.from({ length: 12 }, (_, index) => ({
        id: `pmsg_${index}`,
        role: index % 2 ? 'planner' as const : 'user' as const,
        text: `Prior conversation ${index} ${'history '.repeat(300)}`,
        createdAt: new Date(0).toISOString(),
      }));
    });

    await controller.sendProjectPlannerMessage(project.id, operatorMessage);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.length).toBeLessThan(16_000);
    expect(Buffer.byteLength(prompts[0]!, 'utf8')).toBeLessThanOrEqual(15_000);
    expect(prompts[0]).toContain(operatorMessage);
    const saved = (await store.load()).projects.find(item => item.id === project.id)!;
    expect(saved.plannerMessages?.find(message => message.role === 'user' && message.text === operatorMessage)?.text).toBe(operatorMessage);
    expect(saved.plannerMessages?.slice(0, -1).some(message => message.text.includes('history '))).toBe(true);
  });

  it('bounds memory-enriched assignment context while preserving the complete current assignment', async () => {
    const prompts: string[] = [];
    const adapter: UhpAdapter = { submit: async input => { prompts.push(input.prompt); return success; }, cancel: async () => ({ status: 'cancelled' }) };
    const hindsight: HindsightAdapter = {
      recall: async () => ({ status: 'ready', bankId: 'fixture-bank', memories: Array.from({ length: 8 }, (_, index) => ({ text: `MEMORY_${index}_START ${'remembered context '.repeat(700)} MEMORY_${index}_END` })) }),
      retainOutcome: async () => ({ status: 'accepted', bankId: 'fixture-bank' }),
    };
    const { controller } = await setup(adapter, hindsight);
    const project = await controller.createProject('Memory context') as { id: string };
    const task = await controller.createTask(project.id, 'Inspect memory context') as { id: string };
    const run = await controller.createRun(task.id) as { id: string };
    const currentAssignment = `CURRENT_ASSIGNMENT_START ${'implementation detail '.repeat(450)} CURRENT_ASSIGNMENT_END`;

    await controller.assign(run.id, 'worker', currentAssignment);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.length).toBeLessThan(16_000);
    expect(Buffer.byteLength(prompts[0]!, 'utf8')).toBeLessThanOrEqual(15_000);
    expect(prompts[0]).toContain(currentAssignment);
    expect(prompts[0]).toContain('Relevant project memory (reference only):');
  });

  it('rejects an oversized current assignment locally with an actionable 413 and never calls UHP', async () => {
    const prompts: string[] = [];
    const adapter: UhpAdapter = { submit: async input => { prompts.push(input.prompt); return success; }, cancel: async () => ({ status: 'cancelled' }) };
    const { controller } = await setup(adapter);
    const project = await controller.createProject('Oversized assignment') as { id: string };
    const task = await controller.createTask(project.id, 'Inspect oversized assignment') as { id: string };
    const run = await controller.createRun(task.id) as { id: string };

    let rejection: unknown;
    try { await controller.assign(run.id, 'worker', 'x'.repeat(15_001)); } catch (error) { rejection = error; }
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({ statusCode: 413 });
    expect((rejection as Error).message).toMatch(/15,?000.*No provider request was sent/);
    expect(prompts).toHaveLength(0);
  });
});
