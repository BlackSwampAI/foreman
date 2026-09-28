import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Controller, type UhpAdapter } from '../src/controller.js';
import { JsonStore } from '../src/store.js';
import { fetchBridgeSnapshot, overlayBridgeWorkspace, seedBridgeWorkspace } from '../src/verified-workspace.js';

vi.mock('../src/repo-digest.js', () => ({
  extractKeywords: () => ['Sleeper'],
  buildRepoDigest: async (opts: { commit: string }) => ({ text: `## Digest for ${opts.commit.slice(0, 10)}`, commit: opts.commit }),
}));

const TOKEN = 'f00dfeed'.repeat(8);
const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))), ...dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))]);
});

interface Seen { method: string; url: string; authorization: string | undefined }
/** A bridge that, like the real one with LOCAL_CLI_UHP_TOKEN set, answers 401 to any request without the bearer token. */
async function tokenBridge(token: string | null = TOKEN): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  let seeded = 0;
  const server = createServer((req: IncomingMessage, res) => {
    seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization });
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (token && req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end('{"error":{"code":"unauthorized"}}'); return; }
      if (req.method === 'GET' && req.url === '/v1/uhp') { res.end(JSON.stringify({ capabilities: { extensions: { foreman_workspace_bridge_v1: { version: 1, seed: true, complete_snapshot: true, execution_boundary: 'bubblewrap' } } } })); return; }
      if (req.method === 'POST' && req.url === '/extensions/foreman-workspace/v1/workspaces') { res.statusCode = 201; res.end(JSON.stringify({ workspace_id: `ws-${++seeded}`, base_commit: (JSON.parse(body) as { base_commit: string }).base_commit })); return; }
      if (req.method === 'POST' && /^\/extensions\/foreman-workspace\/v1\/workspaces\/ws-\d+\/overlay$/.test(req.url!)) { res.end(JSON.stringify({ workspace_id: 'ws-1', applied: (JSON.parse(body) as { entries: unknown[] }).entries.length })); return; }
      if (req.method === 'GET' && /^\/extensions\/foreman-workspace\/v1\/workspaces\/ws-\d+\/snapshot$/.test(req.url!)) { res.end(JSON.stringify({ complete: true, base_commit: SHA, entries: [], errors: [] })); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, seen };
}

describe('bridge helpers and the bearer token', () => {
  it('send the token on discovery, seed, overlay and snapshot requests', async () => {
    const { baseUrl, seen } = await tokenBridge();
    expect(await seedBridgeWorkspace(baseUrl, SHA, { token: TOKEN })).toEqual({ workspaceId: 'ws-1', baseCommit: SHA });
    expect(await overlayBridgeWorkspace(baseUrl, 'ws-1', [{ path: 'a.ts', contentBase64: '', mode: '100644' }], { token: TOKEN })).toEqual({ workspaceId: 'ws-1', applied: 1 });
    expect((await fetchBridgeSnapshot(baseUrl, 'ws-1', SHA, { token: TOKEN })).complete).toBe(true);
    expect(seen.map(request => `${request.method} ${request.url}`)).toEqual(['GET /v1/uhp', 'POST /extensions/foreman-workspace/v1/workspaces', 'POST /extensions/foreman-workspace/v1/workspaces/ws-1/overlay', 'GET /extensions/foreman-workspace/v1/workspaces/ws-1/snapshot']);
    for (const request of seen) expect(request.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('keep the numeric timeout arguments and send no credential when none is configured', async () => {
    const { baseUrl, seen } = await tokenBridge(null);
    await seedBridgeWorkspace(baseUrl, SHA, 5_000);
    await overlayBridgeWorkspace(baseUrl, 'ws-1', [], 5_000);
    await fetchBridgeSnapshot(baseUrl, 'ws-1', SHA, 5_000, 1024 * 1024);
    await seedBridgeWorkspace(baseUrl, SHA);
    expect(seen.length).toBe(6);
    for (const request of seen) expect(request.authorization).toBeUndefined();
    await expect(fetchBridgeSnapshot(baseUrl, 'ws-1', SHA, { maxResponseBytes: 8 })).rejects.toThrow('exceeds size limit');
  });

  it('report a rejected token as a 401 that says what to fix and never contains the token', async () => {
    const { baseUrl } = await tokenBridge();
    for (const options of [undefined, { token: 'not-the-token' }]) {
      const failures = await Promise.all([
        seedBridgeWorkspace(baseUrl, SHA, options).catch((error: Error) => error.message),
        overlayBridgeWorkspace(baseUrl, 'ws-1', [], options).catch((error: Error) => error.message),
        fetchBridgeSnapshot(baseUrl, 'ws-1', SHA, options).catch((error: Error) => error.message),
      ]);
      expect(failures).toEqual([
        'Workspace bridge discovery failed (401): the bridge requires a valid bearer token',
        'Workspace bridge overlay request failed (401): the bridge requires a valid bearer token',
        'Workspace bridge snapshot request failed (401): the bridge requires a valid bearer token',
      ]);
    }
  });

  it('never send the token to a bridge URL that is not loopback', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(seedBridgeWorkspace('https://example.com', SHA, { token: TOKEN })).rejects.toThrow('loopback-only');
    await expect(overlayBridgeWorkspace('https://example.com', 'ws-1', [], { token: TOKEN })).rejects.toThrow('loopback-only');
    await expect(fetchBridgeSnapshot('https://example.com', 'ws-1', SHA, { token: TOKEN })).rejects.toThrow('loopback-only');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('are given the token at every call site in the controller', async () => {
    const source = await readFile(new URL('../src/controller.ts', import.meta.url), 'utf8');
    const calls = [...source.matchAll(/\b(seedBridgeWorkspace|overlayBridgeWorkspace|fetchBridgeSnapshot)\(([^()]*)\)/g)];
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const [call] of calls) expect(call, 'a bridge helper call that does not pass the bridge token').toMatch(/\{token:[\w.]+\.bridgeToken\}\)$/);
  });
});

async function controllerFor(bridgeToken: string | undefined) {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-bridge-token-'));
  dirs.push(dir);
  const store = new JsonStore(join(dir, 'state.json'));
  const submissions: Array<{ roleId: string; config: Record<string, unknown> }> = [];
  const uhp: UhpAdapter = { submit: async input => { submissions.push(input as never); return { externalId: 'ext-1', status: 'completed', outputText: JSON.stringify({ workerTask: 'Update README.md.' }), result: { ok: true } }; }, cancel: async () => ({ status: 'cancelled' }) };
  await store.mutate(s => { for (const role of s.roles) { role.enabled = true; role.availableConfigs = [{ harnessId: 'claude-code', model: 'claude-fixture' }]; role.config = { harnessId: 'claude-code', model: 'claude-fixture' }; } });
  const controller = new Controller(store, uhp);
  const { baseUrl, seen } = await tokenBridge();
  controller.configureVerifiedWorkspace({ repoPath: '/fixture/repo', bridgeBaseUrl: baseUrl, allowedScope: ['README.md'], commands: [{ name: 'check', command: 'true', args: [] }], ...(bridgeToken ? { bridgeToken } : {}) });
  return { controller, store, submissions, seen };
}

describe('Controller with a token-protected bridge', () => {
  it('seeds the Planner and Orchestrator snapshots and prepares the Worker workspace with the configured token', async () => {
    const { controller, store, submissions, seen } = await controllerFor(TOKEN);
    vi.spyOn(controller as never, 'currentHead').mockResolvedValue(SHA as never);
    vi.spyOn(controller as never, 'pinWorkerBase').mockResolvedValue(undefined as never);
    const project: any = await controller.createProject('Token project');
    await controller.sendProjectPlannerMessage(project.id, 'Plan some work.');
    expect((await store.load()).projects[0]!.plannerAssignments?.at(-1)?.repoAccess).toMatchObject({ mode: 'snapshot', commit: SHA });
    const task: any = await controller.createTask(project.id, 'Task');
    const run: any = await controller.createRun(task.id);
    await controller.prepareWorkerWorkspace(run.id, BASE);
    await store.mutate(s => { s.projects[0]!.tasks[0]!.runs[0]!.pinnedBaseCommit = BASE; }); // pinWorkerBase is stubbed above
    const workerWorkspace = (await store.load()).projects[0]!.tasks[0]!.runs[0]!.workspaceId;
    expect(workerWorkspace).toMatch(/^ws-\d+$/);
    await controller.addGuidance(run.id, 'Do the work.');
    await controller.orchestrate(run.id, 'Prepare a bounded task.');
    const orchestratorWorkspace = submissions.find(s => s.roleId === 'orchestrator')?.config.readOnlyWorkspaceId;
    expect(orchestratorWorkspace).toMatch(/^ws-\d+$/);
    expect(orchestratorWorkspace).not.toBe(workerWorkspace);
    expect(seen.filter(request => request.method === 'POST').length).toBe(3); // planner snapshot, Worker workspace, Orchestrator snapshot
    for (const request of seen) expect(request.authorization, `${request.method} ${request.url}`).toBe(`Bearer ${TOKEN}`);
  });

  it('falls back to a digest, naming the missing credential but never a token, when the controller has none', async () => {
    const { controller, store, seen } = await controllerFor(undefined);
    vi.spyOn(controller as never, 'currentHead').mockResolvedValue(SHA as never);
    const project: any = await controller.createProject('No token project');
    await controller.sendProjectPlannerMessage(project.id, 'Plan some work.');
    const access = (await store.load()).projects[0]!.plannerAssignments?.at(-1)?.repoAccess;
    expect(access?.mode).toBe('digest');
    expect(access?.reason).toMatch(/401.*bearer token/);
    expect(JSON.stringify(await store.load())).not.toContain(TOKEN);
    for (const request of seen) expect(request.authorization).toBeUndefined();
  });
});
