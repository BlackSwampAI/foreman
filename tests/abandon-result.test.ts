import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, type UhpAdapter } from '../src/controller.js';
import { JsonStore } from '../src/store.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-abandon-result-'));
  dirs.push(dir);
  const store = new JsonStore(join(dir, 'state.json'));
  let modelCalls = 0;
  const uhp: UhpAdapter = {
    submit: async () => { modelCalls++; throw new Error('A model call is forbidden in this test'); },
    cancel: async () => ({ status: 'cancelled' }),
  };
  const controller = new Controller(store, uhp);
  const project = await controller.createProject('Recovery fixture') as { id: string };
  const task = await controller.createTask(project.id, 'Revise the result') as { id: string };
  const run = await controller.createRun(task.id) as { id: string };
  await store.mutate(state => {
    const current = state.projects[0]!.tasks[0]!.runs[0]!;
    current.status = 'completed';
    current.approval = { id: 'approval-fixture', approved: true, decision: 'approved', evidenceDigest: 'a'.repeat(64), createdAt: new Date().toISOString() };
    current.promotion = { status: 'not_started', evidenceDigest: 'a'.repeat(64), updatedAt: new Date().toISOString() };
  });
  return { controller, store, task, run, modelCalls: () => modelCalls };
}

describe('abandoning an approved result before Git promotion', () => {
  it('requires explicit confirmation and keeps the approval while opening a fresh task run', async () => {
    const { controller, store, task, run, modelCalls } = await fixture();
    await expect(controller.abandonApprovedResult(run.id, {})).rejects.toMatchObject({ statusCode: 400 });
    const before = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
    expect(before.promotion?.status).toBe('not_started');

    const abandoned = await controller.abandonApprovedResult(run.id, { confirm: true });
    expect(abandoned.status).toBe('abandoned');
    expect(abandoned.approval).toMatchObject({ id: 'approval-fixture', approved: true });
    expect(abandoned.promotion?.status).toBe('abandoned');
    const saved = await store.load();
    expect(saved.projects[0]!.tasks[0]!.status).toBe('ready');
    expect(saved.events.filter(event => event.type === 'run.approved_result_abandoned')).toHaveLength(1);
    const preview = await controller.taskStartPreview(task.id) as { reasons: string[] };
    expect(preview.reasons).not.toContain('the previous run is awaiting or has recorded a human decision without promotion');
    await expect(controller.abandonApprovedResult(run.id, { confirm: true })).resolves.toMatchObject({ status: 'abandoned' });
    expect((await store.load()).events.filter(event => event.type === 'run.approved_result_abandoned')).toHaveLength(1);
    expect(modelCalls()).toBe(0);
  });

  it('refuses abandonment once promotion has begun and refuses promotion after abandonment', async () => {
    const { controller, store, run } = await fixture();
    controller.configureVerifiedWorkspace({ repoPath: '/unused', allowedScope: ['README.md'], commands: [{ name: 'fixture', command: 'true', args: [] }] });
    await store.mutate(state => { state.projects[0]!.tasks[0]!.runs[0]!.promotion = { status: 'promoting', operationId: 'promotion-fixture', updatedAt: new Date().toISOString() }; });
    await expect(controller.abandonApprovedResult(run.id, { confirm: true })).rejects.toMatchObject({ statusCode: 409 });
    await store.mutate(state => { state.projects[0]!.tasks[0]!.runs[0]!.promotion = { status: 'not_started', updatedAt: new Date().toISOString() }; });
    await controller.abandonApprovedResult(run.id, { confirm: true });
    await expect(controller.promoteRun(run.id)).rejects.toThrow('abandoned');
  });
});
