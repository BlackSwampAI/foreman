import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Controller, type UhpAdapter } from '../src/controller.js';
import { JsonStore } from '../src/store.js';

vi.mock('../src/repo-digest.js', () => ({
  extractKeywords: () => ['Sleeper'],
  buildRepoDigest: async (opts: { commit: string; repoPath: string }) => ({
    text: `## Digest for ${opts.commit.slice(0, 10)}\nSleeper API integration`,
    commit: opts.commit,
  }),
}));

const dirs: string[] = [];
const bridgeServers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    ...bridgeServers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))),
    ...dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
  ]);
});

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

async function startBridge(
  handler: (method: string, url: string, body: string, res: import('node:http').ServerResponse) => void,
): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => handler(req.method!, req.url!, body, res));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  bridgeServers.push(server);
  const addr = server.address() as import('node:net').AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

function simpleBridge(workspaceIds: string[]): Parameters<typeof startBridge>[0] {
  return (method, url, body, res) => {
    res.setHeader('content-type', 'application/json');
    if (method === 'GET' && url === '/v1/uhp') {
      res.end(JSON.stringify({ capabilities: { extensions: { foreman_workspace_bridge_v1: { version: 1, seed: true, complete_snapshot: true, execution_boundary: 'bubblewrap' } } } }));
      return;
    }
    if (method === 'POST' && url === '/extensions/foreman-workspace/v1/workspaces') {
      const parsed = JSON.parse(body) as { base_commit: string };
      const wsId = `ws-${workspaceIds.length + 1}`;
      workspaceIds.push(wsId);
      res.end(JSON.stringify({ workspace_id: wsId, base_commit: parsed.base_commit }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  };
}

async function setup(harnessId = 'claude-code', submitFn?: (input: any) => Promise<any>) {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-ra-'));
  dirs.push(dir);
  const store = new JsonStore(join(dir, 'state.json'));
  const submissions: any[] = [];
  const uhp: UhpAdapter = {
    submit: async input => {
      submissions.push(input);
      return submitFn
        ? submitFn(input)
        : { externalId: 'ext-1', status: 'completed', outputText: 'ok', result: { ok: true } };
    },
    cancel: async () => ({ status: 'cancelled' }),
  };
  await store.mutate(s => {
    for (const role of s.roles) {
      role.enabled = true;
      role.availableConfigs = [
        { harnessId: 'claude-code', model: 'claude-fixture' },
        { harnessId: 'antigravity-cli', model: 'agt-fixture' },
        { harnessId: 'fixture', model: 'model-fixture' },
      ];
      role.config = {
        harnessId,
        model: harnessId === 'antigravity-cli' ? 'agt-fixture' : harnessId === 'claude-code' ? 'claude-fixture' : 'model-fixture',
      };
    }
  });
  return { dir, store, controller: new Controller(store, uhp), submissions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Planner: snapshot mode (claude-code)
// ─────────────────────────────────────────────────────────────────────────────
describe('Planner repo access — snapshot mode', () => {
  it('seeds a read-only workspace and records repoAccess {mode:snapshot, commit} on the assignment', async () => {
    const seeded: string[] = [];
    const bridgeBaseUrl = await startBridge(simpleBridge(seeded));
    const { controller, store } = await setup('claude-code');
    controller.configureVerifiedWorkspace({ repoPath: '/fixture/repo', bridgeBaseUrl, allowedScope: ['src/'], commands: [{ name: 'check', command: 'true', args: [] }] });
    vi.spyOn(controller as any, 'currentHead').mockResolvedValue(HEAD);
    const project: any = await controller.createProject('Snapshot test');
    await controller.sendProjectPlannerMessage(project.id, 'Plan some work.');
    const state = await store.load();
    const assignment = state.projects[0]!.plannerAssignments?.at(-1);
    expect(assignment?.repoAccess).toMatchObject({ mode: 'snapshot', commit: HEAD });
    expect(seeded.length).toBeGreaterThan(0);
  });

  it('includes foreman_read_only_workspace_id in the UHP submission config', async () => {
    const wsIds: string[] = [];
    const bridgeBaseUrl = await startBridge(simpleBridge(wsIds));
    const { controller, submissions } = await setup('claude-code');
    controller.configureVerifiedWorkspace({ repoPath: '/fixture/repo', bridgeBaseUrl, allowedScope: ['src/'], commands: [{ name: 'check', command: 'true', args: [] }] });
    vi.spyOn(controller as any, 'currentHead').mockResolvedValue(HEAD);
    const project: any = await controller.createProject('Metadata test');
    await controller.sendProjectPlannerMessage(project.id, 'Plan some work.');
    const sub = submissions.find(s => s.roleId === 'planner');
    expect(sub?.config.readOnlyWorkspaceId).toMatch(/^ws-/);
  });

  it('prompt contains snapshot wording and does NOT say "cannot read the repository filesystem"', async () => {
    const wsIds: string[] = [];
    const bridgeBaseUrl = await startBridge(simpleBridge(wsIds));
    const { controller, submissions } = await setup('claude-code');
    controller.configureVerifiedWorkspace({ repoPath: '/fixture/repo', bridgeBaseUrl, allowedScope: ['src/'], commands: [{ name: 'check', command: 'true', args: [] }] });
    vi.spyOn(controller as any, 'currentHead').mockResolvedValue(HEAD);
    const project: any = await controller.createProject('Prompt test');
    await controller.sendProjectPlannerMessage(project.id, 'Plan some work.');
    const sub = submissions.find(s => s.roleId === 'planner');
    expect(sub?.prompt).toContain('can read (not modify) a snapshot');
    expect(sub?.prompt).not.toContain('cannot read the repository filesystem directly');
  });

  it('caches the snapshot workspace so a second Planner turn re-uses the same ID without a new seed', async () => {
    const seeded: string[] = [];
    const bridgeBaseUrl = await startBridge(simpleBridge(seeded));
    const { controller, submissions } = await setup('claude-code');
    controller.configureVerifiedWorkspace({ repoPath: '/fixture/repo', bridgeBaseUrl, allowedScope: ['src/'], commands: [{ name: 'check', command: 'true', args: [] }] });
    vi.spyOn(controller as any, 'currentHead').mockResolvedValue(HEAD);
    const project: any = await controller.createProject('Cache test');
    await controller.sendProjectPlannerMessage(project.id, 'First message.');
    await controller.sendProjectPlannerMessage(project.id, 'Second message.');
    // Two planner turns, but only one seed call (cache hit on second)
    expect(seeded.length).toBe(1);
    const ids = submissions.filter(s => s.roleId === 'planner').map(s => s.config.readOnlyWorkspaceId);
    expect(ids[0]).toBe(ids[1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Planner: AGY → digest mode
// ─────────────────────────────────────────────────────────────────────────────
describe('Planner repo access — AGY digest mode', () => {
  it('records repoAccess {mode:digest, reason} and prompt contains "repository digest"', async () => {
    const { controller, store, submissions } = await setup('antigravity-cli');
    controller.configureVerifiedWorkspace({ repoPath: '/fixture/repo', bridgeBaseUrl: 'http://127.0.0.1:1', allowedScope: ['src/'], commands: [{ name: 'check', command: 'true', args: [] }] });
    vi.spyOn(controller as any, 'currentHead').mockResolvedValue(HEAD);
    const project: any = await controller.createProject('AGY test');
    await controller.sendProjectPlannerMessage(project.id, 'Plan NBA support.');
    const state = await store.load();
    const assignment = state.projects[0]!.plannerAssignments?.at(-1);
    expect(assignment?.repoAccess?.mode).toBe('digest');
    expect(assignment?.repoAccess?.reason).toContain('antigravity-cli');
    const sub = submissions.find(s => s.roleId === 'planner');
    expect(sub?.prompt).toContain('repository digest');
    expect(sub?.config.readOnlyWorkspaceId).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Planner: seeding failure → digest fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('Planner repo access — seeding failure fallback', () => {
  it('falls back to digest when the bridge workspace seeding call fails, recording the error as reason', async () => {
    const bridgeBaseUrl = await startBridge((method, url, _body, res) => {
      res.setHeader('content-type', 'application/json');
      if (method === 'GET' && url === '/v1/uhp') { res.end(JSON.stringify({ capabilities: { extensions: { foreman_workspace_bridge_v1: { version: 1, seed: true } } } })); return; }
      if (method === 'POST' && url === '/extensions/foreman-workspace/v1/workspaces') { res.statusCode = 503; res.end(JSON.stringify({ error: 'bridge unavailable' })); return; }
      res.statusCode = 404; res.end('{}');
    });
    const { controller, store } = await setup('claude-code');
    controller.configureVerifiedWorkspace({ repoPath: '/fixture/repo', bridgeBaseUrl, allowedScope: ['src/'], commands: [{ name: 'check', command: 'true', args: [] }] });
    vi.spyOn(controller as any, 'currentHead').mockResolvedValue(HEAD);
    const project: any = await controller.createProject('Fallback test');
    await controller.sendProjectPlannerMessage(project.id, 'Plan some work.');
    const state = await store.load();
    const assignment = state.projects[0]!.plannerAssignments?.at(-1);
    expect(assignment?.repoAccess?.mode).toBe('digest');
    expect(assignment?.repoAccess?.reason).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator: snapshot distinct from the mutable worker workspace
// ─────────────────────────────────────────────────────────────────────────────
describe('Orchestrator repo access — snapshot workspace distinct from worker workspace', () => {
  it('seeds a separate read-only workspace for the Orchestrator that differs from the mutable Worker workspace', async () => {
    const wsIds: string[] = [];
    const bridgeBaseUrl = await startBridge(simpleBridge(wsIds));
    const { controller, store, submissions } = await setup('claude-code', async input => {
      return { externalId: 'ext-1', status: 'completed', outputText: input.roleId === 'orchestrator' ? JSON.stringify({ workerTask: 'Update README.md.' }) : 'ok', result: { ok: true } };
    });
    controller.configureVerifiedWorkspace({ repoPath: '/fixture/repo', bridgeBaseUrl, allowedScope: ['README.md'], commands: [{ name: 'check', command: 'true', args: [] }] });
    const project: any = await controller.createProject('Orch test');
    const task: any = await controller.createTask(project.id, 'Task');
    const run: any = await controller.createRun(task.id);
    await store.mutate(s => { const r = s.projects[0]!.tasks[0]!.runs[0]!; r.pinnedBaseCommit = BASE; r.workspaceId = 'worker-mutable-workspace'; });
    await controller.addGuidance(run.id, 'Do the work.');
    const result: any = await controller.orchestrate(run.id, 'Prepare a bounded task.');
    // repoAccess is set on the assignment via a store.mutate after assign(); reload from store
    const state2 = await store.load();
    const orchAssignment = state2.projects[0]!.tasks[0]!.runs[0]!.assignments.find((a: any) => a.id === result.assignment?.id);
    expect(orchAssignment?.repoAccess).toMatchObject({ mode: 'snapshot', commit: BASE });
    // The read-only workspace ID in the UHP submission must differ from the worker's mutable workspace
    const orchSub = submissions.find((s: any) => s.roleId === 'orchestrator');
    expect(orchSub?.config?.readOnlyWorkspaceId).toBeTruthy();
    expect(orchSub?.config?.readOnlyWorkspaceId).not.toBe('worker-mutable-workspace');
  });
});
