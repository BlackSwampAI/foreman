import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBridge } from '../src/local-bridge.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  kill(signal = 'SIGTERM') { this.killed = true; if (signal === 'SIGKILL' || signal === 'SIGTERM') { this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0, signal)); } return true; }
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); vi.restoreAllMocks(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'foreman-bridge-test-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const bridge = join(root, 'server.mjs');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(join(root, 'home', '.codex'), { recursive: true });
  await mkdir(join(root, 'home', '.claude'), { recursive: true });
  await mkdir(join(root, 'home', '.gemini', 'antigravity-cli'), { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(bridge, '// fake bridge fixture'));
  return { root, repo, bridge, home: join(root, 'home') };
}

describe('LocalBridge', () => {
  it('starts a local bridge with only safe environment, reports discovery, and stops it', async () => {
    const f = await fixture();
    const child = new FakeChild();
    const spawnFake = vi.fn(() => child as never);
    const fetchFake = vi.fn(async () => new Response(JSON.stringify({ protocol: 'uhp', implementation: { name: 'local-cli-uhp' } }), { status: 200 }));
    process.env.ANTHROPIC_API_KEY = 'must-not-forward';
    process.env.OPENAI_API_KEY = 'must-not-forward';
    process.env.GOOGLE_API_KEY = 'must-not-forward';
    try {
      const manager = new LocalBridge({ bridgeScript: f.bridge, dataDir: join(f.root, 'data'), homeDir: f.home, tempDir: join(f.root, 'tmp'), spawn: spawnFake as never, fetch: fetchFake, allocatePort: async () => 49121 });
      const status = await manager.start(f.repo);
      expect(status.repoPath).toBe(f.repo);
      expect(status.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const [command, args, options] = spawnFake.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
      expect(command).toBe(process.execPath);
      expect(args).toEqual([f.bridge]);
      expect(options.env).toMatchObject({
        LOCAL_CLI_UHP_SOURCE_REPO: f.repo,
        CLAUDE_CONFIG_DIR: join(f.home, '.claude'), CLAUDE_MODEL: 'opus',
        CODEX_HOME: join(f.home, '.codex'), CODEX_MODEL: 'gpt-6-sol',
        AGY_CONFIG_DIR: join(f.home, '.gemini', 'antigravity-cli'), AGY_MODEL: 'gemini-3.8-flash-low', AGY_WORKER_EFFORT: 'low',
      });
      expect(options.env.LOCAL_CLI_UHP_PORT).toMatch(/^\d+$/);
      expect(options.env.LOCAL_CLI_UHP_STATE).toMatch(/\/data\/[a-f0-9]{20}\/uhp-state\.json$/);
      expect(options.env.LOCAL_CLI_UHP_WORK).toContain(join('tmp', 'foreman-local-bridge-work'));
      for (const name of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY']) expect(options.env[name]).toBeUndefined();
      await manager.stop();
      expect(child.killed).toBe(true);
      expect(manager.status).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GOOGLE_API_KEY;
    }
  });

  it('restarts for a different selected repository and isolates persistent state', async () => {
    const f = await fixture();
    const second = join(f.root, 'other');
    await mkdir(join(second, '.git'), { recursive: true });
    const children = [new FakeChild(), new FakeChild()];
    let index = 0;
    const envs: NodeJS.ProcessEnv[] = [];
    const manager = new LocalBridge({ bridgeScript: f.bridge, dataDir: join(f.root, 'data'), homeDir: f.home, tempDir: join(f.root, 'tmp'), spawn: ((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => { envs.push(options.env ?? {}); return children[index++] as never; }) as never, fetch: async () => new Response(JSON.stringify({ protocol: 'uhp', implementation: { name: 'local-cli-uhp' } })), allocatePort: async () => 49121 + index });
    await manager.start(f.repo, 'project-one');
    await manager.start(second, 'project-two');
    expect(children[0]?.killed).toBe(true);
    expect(manager.status?.repoPath).toBe(second);
    expect(envs[0]?.LOCAL_CLI_UHP_STATE).not.toBe(envs[1]?.LOCAL_CLI_UHP_STATE);
    expect(envs[0]?.LOCAL_CLI_UHP_WORK).not.toBe(envs[1]?.LOCAL_CLI_UHP_WORK);
    await manager.stop();
  });

  it('rejects non Git directories before spawning', async () => {
    const f = await fixture();
    const spawnFake = vi.fn();
    const manager = new LocalBridge({ bridgeScript: f.bridge, homeDir: homedir(), spawn: spawnFake as never });
    await expect(manager.start(f.root)).rejects.toThrow('Select a local Git repository');
    expect(spawnFake).not.toHaveBeenCalled();
  });

  it('exposes stable bridge key, state dir, and work dir for a given repo and instanceId', async () => {
    const f = await fixture();
    const dataDir = join(f.root, 'data');
    const tempRoot = join(f.root, 'tmp');
    const manager = new LocalBridge({ bridgeScript: f.bridge, dataDir, homeDir: f.home, tempDir: tempRoot });
    const key = manager.bridgeKey(f.repo, 'proj-abc');
    expect(key).toMatch(/^[a-f0-9]{20}$/);
    // Same inputs produce the same key.
    expect(manager.bridgeKey(f.repo, 'proj-abc')).toBe(key);
    // Different instanceId produces a different key.
    expect(manager.bridgeKey(f.repo, 'proj-xyz')).not.toBe(key);
    // stateDir and workDir are inside their respective roots.
    const sd = manager.stateDirForInstance(f.repo, 'proj-abc');
    const wd = manager.workDirForInstance(f.repo, 'proj-abc');
    expect(sd).toBe(join(dataDir, key));
    expect(wd).toBe(join(tempRoot, 'foreman-local-bridge-work', key));
  });
});
