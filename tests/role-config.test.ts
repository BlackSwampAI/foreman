import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, resolveRoleConfig, type UhpAdapter } from '../src/controller.js';
import { JsonStore } from '../src/store.js';
import type { RoleConfig } from '../src/domain.js';

const dirs: string[] = [];

async function setup(adapter?: Partial<UhpAdapter>) {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-roleconfig-'));
  dirs.push(dir);
  const store = new JsonStore(join(dir, 'state.json'));
  const uhp: UhpAdapter = {
    submit: async () => ({ externalId: 'ext-1', status: 'completed', result: { ok: true } }),
    cancel: async () => ({ status: 'cancelled' }),
    ...adapter,
  };
  const fixtureConfig: RoleConfig = { harnessId: 'fixture', model: 'model-fixture' };
  await store.mutate(s => {
    for (const role of s.roles) {
      role.enabled = true;
      role.availableConfigs = [fixtureConfig];
      role.config = structuredClone(fixtureConfig);
    }
  });
  return { dir, store, controller: new Controller(store, uhp), fixtureConfig };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

describe('resolveRoleConfig', () => {
  it('returns global when project and run have no override', () => {
    const globalConfig: RoleConfig = { harnessId: 'h1', model: 'm1' };
    const roles = [{ id: 'worker', name: 'Worker', kind: 'worker' as const, enabled: true, config: globalConfig, availableConfigs: [], configSchema: {} }];
    const project = { id: 'prj_1', name: 'P', status: 'active' as const, defaultRoleConfigs: {}, createdAt: '', tasks: [] };
    const result = resolveRoleConfig(roles, project, undefined, 'worker');
    expect(result).toEqual({ config: globalConfig, source: 'global' });
  });

  it('returns project override when set', () => {
    const globalConfig: RoleConfig = { harnessId: 'h1', model: 'm1' };
    const projectConfig: RoleConfig = { harnessId: 'h2', model: 'm2' };
    const roles = [{ id: 'worker', name: 'Worker', kind: 'worker' as const, enabled: true, config: globalConfig, availableConfigs: [], configSchema: {} }];
    const project = { id: 'prj_1', name: 'P', status: 'active' as const, defaultRoleConfigs: { worker: projectConfig }, createdAt: '', tasks: [] };
    const result = resolveRoleConfig(roles, project, undefined, 'worker');
    expect(result).toEqual({ config: projectConfig, source: 'project' });
  });

  it('returns run override above project override', () => {
    const globalConfig: RoleConfig = { harnessId: 'h1', model: 'm1' };
    const projectConfig: RoleConfig = { harnessId: 'h2', model: 'm2' };
    const runConfig: RoleConfig = { harnessId: 'h3', model: 'm3' };
    const roles = [{ id: 'worker', name: 'Worker', kind: 'worker' as const, enabled: true, config: globalConfig, availableConfigs: [], configSchema: {} }];
    const project = { id: 'prj_1', name: 'P', status: 'active' as const, defaultRoleConfigs: { worker: projectConfig }, createdAt: '', tasks: [] };
    const run = { id: 'run_1', status: 'running' as const, createdAt: '', sessions: {} as any, sessionHistory: [], roleConfigs: { worker: runConfig }, guidance: [], assignments: [], reviews: [] };
    const result = resolveRoleConfig(roles, project, run, 'worker');
    expect(result).toEqual({ config: runConfig, source: 'run' });
  });

  it('falls back from run to project when run has no override for that role', () => {
    const globalConfig: RoleConfig = { harnessId: 'h1', model: 'm1' };
    const projectConfig: RoleConfig = { harnessId: 'h2', model: 'm2' };
    const roles = [{ id: 'worker', name: 'Worker', kind: 'worker' as const, enabled: true, config: globalConfig, availableConfigs: [], configSchema: {} }];
    const project = { id: 'prj_1', name: 'P', status: 'active' as const, defaultRoleConfigs: { worker: projectConfig }, createdAt: '', tasks: [] };
    const run = { id: 'run_1', status: 'running' as const, createdAt: '', sessions: {} as any, sessionHistory: [], roleConfigs: {}, guidance: [], assignments: [], reviews: [] };
    const result = resolveRoleConfig(roles, project, run, 'worker');
    expect(result).toEqual({ config: projectConfig, source: 'project' });
  });
});

describe('createProject role config behavior', () => {
  it('creates a project with empty defaultRoleConfigs', async () => {
    const { controller } = await setup();
    const project = await controller.createProject('Empty overrides') as any;
    expect(project.defaultRoleConfigs).toEqual({});
  });

  it('new project inherits global; changing global after creation changes resolved config', async () => {
    const { controller, store, fixtureConfig } = await setup();
    const project = await controller.createProject('Inherits global') as any;
    const task = await controller.createTask(project.id, 'Task') as any;

    // Before changing global: resolved worker config is global fixture config
    const preview1 = await controller.taskStartPreview(task.id) as any;
    expect(preview1.roleConfigs.worker).toMatchObject(fixtureConfig);

    // Change global worker config to a new value
    const altConfig: RoleConfig = { harnessId: 'fixture', model: 'model-fixture' }; // same available model
    await controller.selectRoleConfig('worker', altConfig);

    // After change: resolved still uses global (project has no override)
    const state = await store.load();
    const proj = state.projects.find((p: any) => p.id === project.id)!;
    const { config } = resolveRoleConfig(state.roles, proj, undefined, 'worker');
    expect(config).toEqual(altConfig);
    expect(Object.keys(proj.defaultRoleConfigs)).toHaveLength(0);
  });

  it('project override beats global; clearing it restores inheritance', async () => {
    const { controller, store, fixtureConfig } = await setup();
    const project = await controller.createProject('Override test') as any;
    const task = await controller.createTask(project.id, 'Override task') as any;

    // Set a project override
    await controller.selectRoleConfig('worker', fixtureConfig, project.id);

    let state = await store.load();
    let proj = state.projects.find((p: any) => p.id === project.id)!;
    expect(proj.defaultRoleConfigs.worker).toMatchObject(fixtureConfig);
    expect(resolveRoleConfig(state.roles, proj, undefined, 'worker').source).toBe('project');

    // Clear the project override
    await controller.clearRoleConfig('worker', project.id);

    state = await store.load();
    proj = state.projects.find((p: any) => p.id === project.id)!;
    expect(proj.defaultRoleConfigs.worker).toBeUndefined();
    expect(resolveRoleConfig(state.roles, proj, undefined, 'worker').source).toBe('global');

    // clearRoleConfig with no existing override returns cleared: false
    const result = await controller.clearRoleConfig('worker', project.id) as any;
    expect(result.cleared).toBe(false);
  });

  it('run override and clear', async () => {
    const { controller, store, fixtureConfig } = await setup();
    const project = await controller.createProject('Run override') as any;
    const task = await controller.createTask(project.id, 'Run task') as any;
    const run = await controller.createRun(task.id) as any;

    // Add run-level override for reviewer
    await controller.selectRoleConfig('reviewer', fixtureConfig, undefined, run.id);

    let state = await store.load();
    const proj = state.projects.find((p: any) => p.id === project.id)!;
    const runObj = proj.tasks.flatMap((t: any) => t.runs).find((r: any) => r.id === run.id)!;
    expect(resolveRoleConfig(state.roles, proj, runObj, 'reviewer').source).toBe('run');

    // Clear run override
    await controller.clearRoleConfig('reviewer', undefined, run.id);

    state = await store.load();
    const runObjAfter = state.projects.flatMap((p: any) => p.tasks.flatMap((t: any) => t.runs)).find((r: any) => r.id === run.id)!;
    const projAfter = state.projects.find((p: any) => p.id === project.id)!;
    expect(resolveRoleConfig(state.roles, projAfter, runObjAfter, 'reviewer').source).toBe('global');
  });
});

describe('migrateProjectRoleConfigs on recover()', () => {
  it('drops project entries equal to global and marks migration done', async () => {
    const { store, controller, fixtureConfig } = await setup();

    // Manually seed an old-style project with defaultRoleConfigs matching global
    await store.mutate(s => {
      s.projects.push({
        id: 'prj_legacy',
        name: 'Legacy project',
        status: 'active',
        defaultRoleConfigs: {
          worker: structuredClone(fixtureConfig), // same as global — should be stripped
          reviewer: { harnessId: 'other', model: 'other-model' }, // different — should be kept
        },
        createdAt: new Date().toISOString(),
        tasks: [],
      });
    });

    // recover() triggers migration
    await controller.recover();

    const state = await store.load();
    const project = state.projects.find(p => p.id === 'prj_legacy')!;
    expect(project.defaultRoleConfigs.worker).toBeUndefined();
    expect(project.defaultRoleConfigs.reviewer).toMatchObject({ harnessId: 'other', model: 'other-model' });
    expect(project.roleConfigOverridesMigrated).toBe(true);
  });

  it('is idempotent: running recover twice does not alter already-migrated projects', async () => {
    const { store, controller, fixtureConfig } = await setup();

    await store.mutate(s => {
      s.projects.push({
        id: 'prj_idempotent',
        name: 'Idempotent',
        status: 'active',
        defaultRoleConfigs: { worker: structuredClone(fixtureConfig) },
        createdAt: new Date().toISOString(),
        tasks: [],
      });
    });

    await controller.recover();
    await controller.recover();

    const state = await store.load();
    const project = state.projects.find(p => p.id === 'prj_idempotent')!;
    // Already migrated — no double-strip
    expect(project.defaultRoleConfigs.worker).toBeUndefined();
    expect(project.roleConfigOverridesMigrated).toBe(true);
  });
});

describe('refreshDiscovery does not clobber user role config', () => {
  it('keeps a configured role.config when the model is temporarily absent from discovery', async () => {
    const fixtureConfig: RoleConfig = { harnessId: 'fixture', model: 'model-fixture' };
    const altAvailable: RoleConfig[] = [{ harnessId: 'fixture', model: 'model-alternative' }];
    const dir = await mkdtemp(join(tmpdir(), 'foreman-discovery-'));
    dirs.push(dir);
    const store = new JsonStore(join(dir, 'state.json'));
    // Seed store with fixture available
    await store.mutate(s => {
      for (const role of s.roles) { role.enabled = true; role.availableConfigs = [fixtureConfig]; role.config = structuredClone(fixtureConfig); }
    });
    // Create controller whose discover() returns only altAvailable (fixture model gone)
    const uhp: UhpAdapter = {
      discover: async () => ({ version: 'alt', capabilities: {}, harnesses: [{ id: 'fixture', models: [{ id: 'model-alternative', available: true }] }] }),
      submit: async () => ({ externalId: 'e', status: 'completed', result: {} }),
      cancel: async () => ({ status: 'cancelled' }),
    };
    // uhpConfigured=true (4th arg) is required for refreshDiscovery to run
    const ctrl = new Controller(store, uhp, false, true);
    await ctrl.refreshDiscovery();

    const state = await store.load();
    const workerRole = state.roles.find(r => r.id === 'worker')!;
    // User's choice should be preserved (not overwritten) because config was already set
    expect(workerRole.config).toMatchObject(fixtureConfig);
    // Available configs should reflect the new discovery
    expect(workerRole.availableConfigs).toEqual(altAvailable);
  });

  it('sets a default when role.config is empty/blank', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'foreman-blank-'));
    dirs.push(dir);
    const store = new JsonStore(join(dir, 'state.json'));
    // Clear all configs to blank
    await store.mutate(s => {
      for (const role of s.roles) { role.enabled = false; role.availableConfigs = []; role.config = { harnessId: '', model: '' }; }
    });
    // Discover claude-code models — defaultRoleConfig matches these for orchestrator/reviewer/planner
    const uhp: UhpAdapter = {
      discover: async () => ({ version: 'claude', capabilities: {}, harnesses: [{ id: 'claude-code', models: [{ id: 'opus', available: true }, { id: 'sonnet', available: true }] }] }),
      submit: async () => ({ externalId: 'e', status: 'completed', result: {} }),
      cancel: async () => ({ status: 'cancelled' }),
    };
    // uhpConfigured=true (4th arg) is required for refreshDiscovery to run
    const ctrl = new Controller(store, uhp, false, true);
    await ctrl.refreshDiscovery();

    const state = await store.load();
    // orchestrator has a blank config and claude-code is the fallback — defaultRoleConfig selects opus
    const orchestratorRole = state.roles.find(r => r.id === 'orchestrator')!;
    expect(orchestratorRole.config.harnessId).toBe('claude-code');
    expect(orchestratorRole.config.model).toBeTruthy();
  });
});
