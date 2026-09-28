import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBridge, bearerFetch, type LocalBridgeHealth, type LocalBridgeOptions } from '../src/local-bridge.js';

let nextPid = 40_000;
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  pid = nextPid++;
  /** Whether the fake bridge answers HTTP; a bridge that cannot bind its port never does. */
  listening = true;
  kill(signal = 'SIGTERM') { this.killed = true; if (signal === 'SIGKILL' || signal === 'SIGTERM') { this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0, signal)); } return true; }
  /** The process dies by itself, as after a crash or `kill -9`. */
  crash(code: number | null = 1, signal: string | null = null) { this.exitCode = signal ? null : code; this.signalCode = signal; this.listening = false; this.emit('exit', code, signal); }
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

const DISCOVERY = JSON.stringify({ protocol: 'uhp', implementation: { name: 'local-cli-uhp' } });

/** Poll with real time (setImmediate is never faked) until an asynchronous chain of real fs and timer work has landed. */
async function until(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs; // callers only use this with real timers
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`); await new Promise(resolveTick => setTimeout(resolveTick, 2)); }
}
/** Same, but for tests that fake timers: only setImmediate and a wall-clock deadline are used. */
async function untilFaked(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`); await new Promise(resolveTick => setImmediate(resolveTick)); }
}

/**
 * A LocalBridge wired to fake processes. `behavior` decides what each spawned process does: `ready` (default) answers
 * discovery, `exit` dies at once (as when its port cannot be rebound), `silent` stays alive but never answers.
 */
async function supervised(options: Partial<LocalBridgeOptions> & { behavior?: (spawnNumber: number) => 'ready' | 'exit' | 'silent' } = {}) {
  const f = await fixture();
  const children: FakeChild[] = [];
  const spawnOptions: Array<{ env: NodeJS.ProcessEnv; stdio: unknown[] }> = [];
  const fetchCalls: Array<{ url: string; authorization?: string }> = [];
  const health: LocalBridgeHealth[] = [];
  const allocatePort = vi.fn(async () => 49500);
  const spawnFake = vi.fn((_command: string, _args: readonly string[], spawnOpts: { env: NodeJS.ProcessEnv; stdio: unknown[] }) => {
    const child = new FakeChild();
    children.push(child); spawnOptions.push(spawnOpts);
    const behavior = options.behavior?.(children.length) ?? 'ready';
    if (behavior === 'exit') { child.listening = false; queueMicrotask(() => child.crash(1)); }
    else if (behavior === 'silent') child.listening = false;
    return child as never;
  });
  const fetchFake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), authorization: (init?.headers as Record<string, string> | undefined)?.authorization });
    const child = children.at(-1);
    if (!child || !child.listening || child.exitCode !== null || child.signalCode) throw new TypeError('fetch failed');
    return new Response(DISCOVERY, { status: 200 });
  });
  const { behavior: _behavior, ...bridgeOptions } = options;
  const manager = new LocalBridge({ bridgeScript: f.bridge, dataDir: join(f.root, 'data'), homeDir: f.home, tempDir: join(f.root, 'tmp'), spawn: spawnFake as never, fetch: fetchFake as never, allocatePort, startupPollMs: 2, onHealthChange: h => health.push(h), ...bridgeOptions });
  return { f, manager, children, spawnOptions, spawnFake, fetchCalls, health, allocatePort, logPath: () => join(manager.stateDirForInstance(f.repo, f.repo), 'bridge.log') };
}

describe('LocalBridge authentication', () => {
  it('generates a fresh 32-byte token per start, gives it only to the child, and polls readiness with it', async () => {
    process.env.LOCAL_CLI_UHP_TOKEN = 'ambient-token-that-must-not-be-forwarded';
    try {
      const a = await supervised();
      const first = await a.manager.start(a.f.repo);
      expect(first.token).toMatch(/^[a-f0-9]{64}$/);
      expect(a.spawnOptions[0]!.env.LOCAL_CLI_UHP_TOKEN).toBe(first.token);
      expect(a.spawnOptions[0]!.env.LOCAL_CLI_UHP_TOKEN).not.toBe(process.env.LOCAL_CLI_UHP_TOKEN);
      expect(a.fetchCalls.length).toBeGreaterThan(0);
      for (const call of a.fetchCalls) expect(call).toEqual({ url: `${first.baseUrl}/v1/uhp`, authorization: `Bearer ${first.token}` });
      // The token is readable but never enumerable: serialising or logging a status cannot leak it.
      expect(Object.keys(first)).toEqual(['repoPath', 'baseUrl']);
      expect(JSON.stringify(first)).not.toContain(first.token);
      expect(JSON.stringify(a.manager.health)).not.toContain(first.token);
      expect(a.manager.status?.token).toBe(first.token);
      await a.manager.stop();
      // A new start is a new credential.
      const restarted = await a.manager.start(a.f.repo);
      expect(restarted.token).toMatch(/^[a-f0-9]{64}$/);
      expect(restarted.token).not.toBe(first.token);
      expect(a.spawnOptions[1]!.env.LOCAL_CLI_UHP_TOKEN).toBe(restarted.token);
      await a.manager.stop();
      // Two managers never share one.
      const b = await supervised();
      expect((await b.manager.start(b.f.repo)).token).not.toBe(first.token);
      await b.manager.stop();
    } finally { delete process.env.LOCAL_CLI_UHP_TOKEN; }
  });

  it('fails fast, without echoing the token, when the port answers the authenticated readiness check with 401', async () => {
    const f = await fixture();
    const child = new FakeChild();
    const fetchFake = vi.fn(async () => new Response('{"error":{"code":"unauthorized"}}', { status: 401 }));
    const manager = new LocalBridge({ bridgeScript: f.bridge, dataDir: join(f.root, 'data'), homeDir: f.home, tempDir: join(f.root, 'tmp'), spawn: (() => child) as never, fetch: fetchFake as never, allocatePort: async () => 49501, startupTimeoutMs: 5_000 });
    const started = Date.now();
    const error = await manager.start(f.repo).catch(e => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/answered the readiness check with 401/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fetchFake).toHaveBeenCalledTimes(1);
    expect(child.killed).toBe(true);
    const sent = (fetchFake.mock.calls[0] as unknown as [string, { headers: { authorization: string } }])[1].headers.authorization.replace('Bearer ', '');
    expect((error as Error).message).not.toContain(sent);
  });
});

describe('bearerFetch', () => {
  it('adds the bearer token to every request, keeps what the caller sent, and never overrides an explicit Authorization', async () => {
    const seen: Array<{ url: string; headers: Headers; method?: string; body?: unknown }> = [];
    const base = (async (input: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(input), headers: new Headers(init?.headers), method: init?.method, body: init?.body }); return new Response('{}'); }) as typeof fetch;
    const authed = bearerFetch('secret-token', base);
    await authed(new URL('http://127.0.0.1:1/v1/uhp'), { signal: AbortSignal.timeout(1_000) });
    await authed('http://127.0.0.1:1/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k' }, body: '{"a":1}' });
    await authed('http://127.0.0.1:1/x', { headers: { Authorization: 'Bearer explicit' } });
    await authed(new Request('http://127.0.0.1:1/y', { headers: { 'UHP-Version': 'v' } }));
    expect(seen.map(call => call.headers.get('authorization'))).toEqual(['Bearer secret-token', 'Bearer secret-token', 'Bearer explicit', 'Bearer secret-token']);
    expect(seen[1]).toMatchObject({ method: 'POST', body: '{"a":1}' });
    expect(seen[1]!.headers.get('content-type')).toBe('application/json');
    expect(seen[1]!.headers.get('idempotency-key')).toBe('k');
    expect(seen[3]!.headers.get('uhp-version')).toBe('v');
  });
});

describe('LocalBridge supervision', () => {
  it('restarts a crashed bridge on the same port with the same token and reports its health', async () => {
    const s = await supervised({ supervision: { restartBaseDelayMs: 5, restartMaxDelayMs: 40 } });
    const status = await s.manager.start(s.f.repo);
    expect(s.manager.health).toMatchObject({ state: 'ready', restarts: 0 });
    s.children[0]!.crash(null, 'SIGKILL');
    // Readiness is cleared at once, so nobody is handed the dead process's status.
    expect(s.manager.status).toBeUndefined();
    expect(s.manager.health).toMatchObject({ state: 'restarting', restartDelayMs: 5, restarts: 0, lastExit: { code: null, signal: 'SIGKILL' } });
    expect(s.manager.health.message).toMatch(/signal SIGKILL.*restarting in 5 ms.*bridge\.log/);
    await until(() => s.manager.health.state === 'ready', 'the restarted bridge');
    expect(s.spawnFake).toHaveBeenCalledTimes(2);
    expect(s.allocatePort).toHaveBeenCalledTimes(1);
    for (const key of ['LOCAL_CLI_UHP_PORT', 'LOCAL_CLI_UHP_TOKEN', 'LOCAL_CLI_UHP_STATE', 'LOCAL_CLI_UHP_WORK', 'LOCAL_CLI_UHP_SOURCE_REPO'] as const) expect(s.spawnOptions[1]!.env[key]).toBe(s.spawnOptions[0]!.env[key]);
    // Controllers still hold the original URL and credential, and both keep working.
    expect(s.manager.status).toBe(status);
    expect(s.manager.status?.baseUrl).toBe(status.baseUrl);
    expect(s.manager.status?.token).toBe(status.token);
    expect(s.fetchCalls.at(-1)).toEqual({ url: `${status.baseUrl}/v1/uhp`, authorization: `Bearer ${status.token}` });
    expect(s.manager.health).toMatchObject({ state: 'ready', restarts: 1, lastExit: { code: null, signal: 'SIGKILL' } });
    expect(s.health.map(h => h.state)).toEqual(['restarting', 'ready']);
    expect(JSON.stringify(s.health)).not.toContain(status.token);
    await s.manager.stop();
  });

  it('backs off exponentially from 1 s and caps at 30 s (fake timers, default policy)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      // The first restart succeeds; every later one dies at once, so the delays keep growing.
      const s = await supervised({ behavior: n => n === 1 ? 'ready' : 'exit', supervision: { maxFastFailures: 8 } });
      await s.manager.start(s.f.repo);
      const crashedAt = Date.now();
      s.children[0]!.crash(1);
      expect(s.manager.health).toMatchObject({ state: 'restarting', restartDelayMs: 1_000 });
      expect(s.manager.health.nextRestartAt).toBe(new Date(crashedAt + 1_000).toISOString());
      // Each restart is scheduled after the previous failure: exactly `delay` ms later, never a millisecond sooner.
      let spawned = 1;
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        await new Promise(resolveTick => setImmediate(resolveTick));
        expect(s.spawnFake, `no restart before ${delay} ms`).toHaveBeenCalledTimes(spawned);
        await vi.advanceTimersByTimeAsync(1);
        spawned++;
        // The restarted process dies at once (its port cannot be rebound), which is reported and schedules the next restart.
        await untilFaked(() => s.spawnFake.mock.calls.length === spawned && s.health.length === spawned, `failure of spawn ${spawned}`);
      }
      expect(s.health.filter(h => h.state === 'restarting').map(h => h.restartDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
      // The eighth consecutive fast failure exhausts the policy.
      expect(s.manager.health.state).toBe('unavailable');
      expect(s.health.at(-1)?.state).toBe('unavailable');
      await s.manager.stop();
    } finally { vi.useRealTimers(); }
  });

  it('gives up after 5 consecutive fast failures, including restarts that cannot rebind the port, and reports why', async () => {
    const s = await supervised({ behavior: n => n === 1 ? 'ready' : 'exit', supervision: { restartBaseDelayMs: 1, restartMaxDelayMs: 4 } });
    const status = await s.manager.start(s.f.repo);
    s.children[0]!.crash(null, 'SIGKILL');
    await until(() => s.manager.health.state === 'unavailable', 'the bridge to be given up on');
    // The crash plus four failed restarts: five consecutive runs within 60 s of starting.
    expect(s.spawnFake).toHaveBeenCalledTimes(5);
    expect(s.manager.status).toBeUndefined();
    const health = s.manager.health;
    expect(health).toMatchObject({ state: 'unavailable', restarts: 4, lastExit: { code: 1, signal: null }, logPath: s.logPath() });
    expect(health.message).toMatch(/5 consecutive failures within 60 s of starting \(last exit: exit code 1\); see .*bridge\.log/);
    expect(JSON.stringify(health)).not.toContain(status.token);
    expect(s.health.at(-1)?.state).toBe('unavailable');
    await new Promise(resolveWait => setTimeout(resolveWait, 60));
    expect(s.spawnFake).toHaveBeenCalledTimes(5); // no further attempts
    await s.manager.stop();
  });

  it('stops a restarted bridge that never answers and counts it as a failed attempt', async () => {
    const s = await supervised({ behavior: n => n === 1 ? 'ready' : 'silent', startupTimeoutMs: 40, supervision: { restartBaseDelayMs: 1, maxFastFailures: 2 } });
    await s.manager.start(s.f.repo);
    s.children[0]!.crash(1);
    await until(() => s.manager.health.state === 'unavailable', 'the silent restart to be given up on');
    expect(s.children[1]!.killed).toBe(true);
    expect(s.manager.health.lastExit?.reason).toMatch(/did not become ready; see .*bridge\.log/);
    expect(s.spawnFake).toHaveBeenCalledTimes(2);
  });

  it('counts only runs that ended within the stability window: a long healthy run resets the failure count', async () => {
    // maxFastFailures 2. Without the reset the first crash (after 200 ms) would count, and the bridge would be given up after two crashes.
    const s = await supervised({ supervision: { restartBaseDelayMs: 1, stableAfterMs: 150, maxFastFailures: 2 } });
    await s.manager.start(s.f.repo);
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
    s.children[0]!.crash(1); // healthy for >= 150 ms: restarts the count
    await until(() => s.children.length === 2 && s.manager.health.state === 'ready', 'the first restart');
    s.children[1]!.crash(1); // fast failure 1 of 2
    await until(() => s.children.length === 3 && s.manager.health.state === 'ready', 'the second restart');
    expect(s.manager.health).toMatchObject({ state: 'ready', restarts: 2 });
    s.children[2]!.crash(1); // fast failure 2 of 2
    await until(() => s.manager.health.state === 'unavailable', 'the bridge to be given up on');
    expect(s.spawnFake).toHaveBeenCalledTimes(3);
    await s.manager.stop();
  });

  it('never restarts after a deliberate stop, whether the bridge is ready, waiting to restart, or mid-restart', async () => {
    // Ready.
    const ready = await supervised({ supervision: { restartBaseDelayMs: 5 } });
    await ready.manager.start(ready.f.repo);
    await ready.manager.stop();
    expect(ready.children[0]!.killed).toBe(true);
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
    expect(ready.spawnFake).toHaveBeenCalledTimes(1);
    expect(ready.manager.health.state).toBe('unavailable');
    expect(ready.health).toEqual([]); // a deliberate stop is not reported as a failure

    // Waiting for its restart timer.
    const waiting = await supervised({ supervision: { restartBaseDelayMs: 30 } });
    await waiting.manager.start(waiting.f.repo);
    waiting.children[0]!.crash(1);
    expect(waiting.manager.health.state).toBe('restarting');
    await waiting.manager.stop();
    await new Promise(resolveWait => setTimeout(resolveWait, 90));
    expect(waiting.spawnFake).toHaveBeenCalledTimes(1);
    expect(waiting.manager.health.state).toBe('unavailable');

    // In the middle of a restart whose bridge is not up yet.
    const mid = await supervised({ behavior: n => n === 1 ? 'ready' : 'silent', startupTimeoutMs: 5_000, supervision: { restartBaseDelayMs: 1 } });
    await mid.manager.start(mid.f.repo);
    mid.children[0]!.crash(1);
    await until(() => mid.children.length === 2, 'the restart to spawn');
    await mid.manager.stop();
    expect(mid.children[1]!.killed).toBe(true);
    await new Promise(resolveWait => setTimeout(resolveWait, 60));
    expect(mid.spawnFake).toHaveBeenCalledTimes(2);
    expect(mid.manager.health.state).toBe('unavailable');
  });

  it('does not treat the exit of a process it stopped for a new repository as a crash', async () => {
    const s = await supervised({ supervision: { restartBaseDelayMs: 1 } });
    const second = join(s.f.root, 'other');
    await mkdir(join(second, '.git'), { recursive: true });
    await s.manager.start(s.f.repo, 'one');
    await s.manager.start(second, 'two');
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
    expect(s.spawnFake).toHaveBeenCalledTimes(2);
    expect(s.manager.status?.repoPath).toBe(second);
    await s.manager.stop();
  });
});

describe('LocalBridge log file', () => {
  it('sends stdout and stderr of every run to a private log in the state directory', async () => {
    const s = await supervised({ supervision: { restartBaseDelayMs: 2 } });
    await s.manager.start(s.f.repo);
    const log = s.logPath();
    expect(log).toBe(join(s.manager.stateDirForInstance(s.f.repo, s.f.repo), 'bridge.log'));
    expect(s.manager.health.logPath).toBe(log);
    expect((await stat(log)).mode & 0o777).toBe(0o600);
    const [stdin, stdout, stderr] = s.spawnOptions[0]!.stdio;
    expect(stdin).toBe('ignore');
    expect(typeof stdout).toBe('number');
    expect(stderr).toBe(stdout);
    s.children[0]!.crash(null, 'SIGKILL');
    await until(() => s.manager.health.state === 'ready', 'the restart');
    await s.manager.stop();
    await until(() => /restarting in 2 ms/.test(readLog(log)) && (readLog(log).match(/bridge ready/g)?.length ?? 0) === 2, 'Foreman notes in the log');
    const text = readLog(log);
    expect(text).toMatch(/starting bridge on http:\/\/127\.0\.0\.1:49500/);
    expect(text).toMatch(/bridge ended \(signal SIGKILL\)/);
    expect(text).not.toContain(s.spawnOptions[0]!.env.LOCAL_CLI_UHP_TOKEN);
    expect((await stat(log)).mode & 0o777).toBe(0o600);
  });

  it('tightens the mode of an existing log and appends to it', async () => {
    const s = await supervised();
    const dir = s.manager.stateDirForInstance(s.f.repo, s.f.repo);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bridge.log'), 'earlier run\n');
    await chmod(join(dir, 'bridge.log'), 0o644);
    await s.manager.start(s.f.repo);
    expect((await stat(join(dir, 'bridge.log'))).mode & 0o777).toBe(0o600);
    expect(readLog(join(dir, 'bridge.log'))).toMatch(/^earlier run\n/);
    await s.manager.stop();
  });

  it('rotates a log over the limit to bridge.log.1 at start, keeping a single old file', async () => {
    const s = await supervised({ supervision: { logMaxBytes: 32 } });
    const dir = s.manager.stateDirForInstance(s.f.repo, s.f.repo);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bridge.log'), 'x'.repeat(100));
    await writeFile(join(dir, 'bridge.log.1'), 'an older rotation that must be discarded');
    await s.manager.start(s.f.repo);
    expect(readLog(join(dir, 'bridge.log.1'))).toBe('x'.repeat(100));
    expect(readLog(join(dir, 'bridge.log'))).not.toContain('xxxx');
    expect(readLog(join(dir, 'bridge.log'))).toMatch(/starting bridge/);
    expect((await stat(join(dir, 'bridge.log'))).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter(name => name.startsWith('bridge.log')).sort()).toEqual(['bridge.log', 'bridge.log.1']);
    await s.manager.stop();
  });

  it('leaves a log under the limit alone', async () => {
    const s = await supervised({ supervision: { logMaxBytes: 1_000 } });
    const dir = s.manager.stateDirForInstance(s.f.repo, s.f.repo);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bridge.log'), 'small\n');
    await s.manager.start(s.f.repo);
    expect((await readdir(dir)).filter(name => name.startsWith('bridge.log'))).toEqual(['bridge.log']);
    expect(readLog(join(dir, 'bridge.log'))).toMatch(/^small\n/);
    await s.manager.stop();
  });
});

function readLog(path: string): string { try { return readFileSync(path, 'utf8'); } catch { return ''; } }

describe('LocalBridge with a real child process', () => {
  it('logs both streams, answers only the token, and comes back on the same port and token after kill -9', async () => {
    const f = await fixture();
    const script = join(f.root, 'real-bridge.mjs');
    await writeFile(script, `
import { createServer } from 'node:http';
const token = process.env.LOCAL_CLI_UHP_TOKEN, port = Number(process.env.LOCAL_CLI_UHP_PORT);
console.log('bridge stdout pid=' + process.pid); console.error('bridge stderr pid=' + process.pid);
createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ protocol: 'uhp', implementation: { name: 'local-cli-uhp' }, pid: process.pid, token }));
}).listen(port, '127.0.0.1');
`);
    const health: LocalBridgeHealth[] = [];
    const manager = new LocalBridge({ bridgeScript: script, dataDir: join(f.root, 'data'), homeDir: f.home, tempDir: join(f.root, 'tmp'), supervision: { restartBaseDelayMs: 20 }, onHealthChange: h => health.push(h) });
    try {
      const status = await manager.start(f.repo);
      const ask = async (token?: string) => fetch(`${status.baseUrl}/v1/uhp`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      expect((await ask()).status).toBe(401);
      const before = await (await ask(status.token)).json() as { pid: number; token: string };
      expect(before.token).toBe(status.token);
      process.kill(before.pid, 'SIGKILL');
      await until(() => manager.health.state === 'restarting', 'the crash to be noticed');
      expect(manager.status).toBeUndefined();
      expect(manager.health.lastExit).toMatchObject({ code: null, signal: 'SIGKILL' });
      await until(() => manager.health.state === 'ready', 'the restart', 8_000);
      const after = await (await fetch(`${status.baseUrl}/v1/uhp`, { headers: { authorization: `Bearer ${status.token}` } })).json() as { pid: number; token: string };
      expect(after.pid).not.toBe(before.pid);
      expect(after.token).toBe(status.token);
      expect(manager.status?.baseUrl).toBe(status.baseUrl);
      const log = readLog(manager.health.logPath!);
      expect(log).toContain(`bridge stdout pid=${before.pid}`);
      expect(log).toContain(`bridge stderr pid=${before.pid}`);
      expect(log).toContain(`bridge stdout pid=${after.pid}`);
      expect(log).toContain('bridge ended (signal SIGKILL)');
      expect(log).not.toContain(status.token);
      expect(health.map(h => h.state)).toEqual(['restarting', 'ready']);
      await manager.stop();
      await new Promise(resolveWait => setTimeout(resolveWait, 150));
      expect(manager.health.state).toBe('unavailable');
      await expect(ask(status.token)).rejects.toThrow(); // the port is closed and nothing came back
    } finally { await manager.stop(); }
  });
});
