import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, realpath, access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LocalBridgeOptions {
  bridgeScript?: string;
  nodePath?: string;
  dataDir?: string;
  homeDir?: string;
  tempDir?: string;
  startupTimeoutMs?: number;
  fetch?: typeof fetch;
  spawn?: typeof spawn;
  allocatePort?: () => Promise<number>;
}
export interface LocalBridgeStatus { repoPath: string; baseUrl: string; }

const SAFE_ENV = ['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TERM','TMPDIR','TMP','TEMP','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS'];

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Could not allocate a local bridge port')); return; }
      const { port } = address;
      server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

async function isGitRepo(path: string): Promise<string> {
  const repo = await realpath(path);
  const info = await stat(repo);
  if (!info.isDirectory()) throw new Error('Select a local Git repository');
  try { await access(join(repo, '.git'), fsConstants.F_OK); }
  catch { throw new Error('Select a local Git repository'); }
  return repo;
}

export class LocalBridge {
  private child?: ChildProcess;
  private active?: LocalBridgeStatus;
  private activeInstanceId?: string;
  private starting?: Promise<LocalBridgeStatus>;
  private readonly options: Required<Pick<LocalBridgeOptions, 'bridgeScript'|'nodePath'|'dataDir'|'homeDir'|'tempDir'|'startupTimeoutMs'|'fetch'|'spawn'>> & { allocatePort: () => Promise<number> };

  constructor(options: LocalBridgeOptions = {}) {
    const h = options.homeDir ?? homedir();
    this.options = {
      bridgeScript: options.bridgeScript ?? fileURLToPath(new URL('../investigations/local-cli-uhp/server.mjs', import.meta.url)),
      nodePath: options.nodePath ?? process.execPath,
      dataDir: options.dataDir ?? join(process.env.XDG_DATA_HOME ?? join(h, '.local', 'share'), 'foreman', 'local-bridge'),
      homeDir: h,
      tempDir: options.tempDir ?? tmpdir(),
      startupTimeoutMs: options.startupTimeoutMs ?? 8_000,
      fetch: options.fetch ?? globalThis.fetch,
      spawn: options.spawn ?? spawn,
      allocatePort: options.allocatePort ?? freePort,
    };
  }

  get status(): LocalBridgeStatus | undefined { return this.active; }

  /** Compute the key used for a given repoPath + instanceId pair. */
  bridgeKey(repoPath: string, instanceId: string): string {
    return createHash('sha256').update(`${repoPath}\0${instanceId}`).digest('hex').slice(0, 20);
  }
  /** Absolute path to the bridge state directory for a given repoPath + instanceId pair. */
  stateDirForInstance(repoPath: string, instanceId: string): string {
    return resolve(this.options.dataDir, this.bridgeKey(repoPath, instanceId));
  }
  /** Absolute path to the bridge work directory for a given repoPath + instanceId pair. */
  workDirForInstance(repoPath: string, instanceId: string): string {
    return join(this.options.tempDir, 'foreman-local-bridge-work', this.bridgeKey(repoPath, instanceId));
  }

  async start(repoPath: string, instanceId = repoPath): Promise<LocalBridgeStatus> {
    const repo = await isGitRepo(repoPath);
    if (this.active?.repoPath === repo && this.activeInstanceId === instanceId && this.child && this.child.exitCode === null) return this.active;
    if (this.starting) await this.starting.catch(() => undefined);
    if (this.active?.repoPath === repo && this.activeInstanceId === instanceId && this.child && this.child.exitCode === null) return this.active;
    this.starting = this.startInternal(repo, instanceId);
    try { return await this.starting; }
    finally { this.starting = undefined; }
  }

  private async startInternal(repo: string, instanceId: string): Promise<LocalBridgeStatus> {
    await this.stop();
    const script = await realpath(this.options.bridgeScript);
    const port = await this.options.allocatePort();
    const key = createHash('sha256').update(`${repo}\0${instanceId}`).digest('hex').slice(0, 20);
    const stateDir = resolve(this.options.dataDir, key);
    const statePath = join(stateDir, 'uhp-state.json');
    const workPath = join(this.options.tempDir, 'foreman-local-bridge-work', key);
    if (!resolve(workPath).startsWith(`${resolve(this.options.tempDir)}/`)) throw new Error('Bridge work directory must be inside the system temporary directory');
    await Promise.all([mkdir(stateDir, { recursive: true, mode: 0o700 }), mkdir(workPath, { recursive: true, mode: 0o700 })]);
    const env: NodeJS.ProcessEnv = {};
    for (const key of SAFE_ENV) if (typeof process.env[key] === 'string') env[key] = process.env[key];
    env.HOME = this.options.homeDir;
    env.LOCAL_CLI_UHP_PORT = String(port);
    env.LOCAL_CLI_UHP_STATE = statePath;
    env.LOCAL_CLI_UHP_WORK = workPath;
    env.LOCAL_CLI_UHP_SOURCE_REPO = repo;
    env.CLAUDE_CONFIG_DIR = join(this.options.homeDir, '.claude');
    env.CLAUDE_MODEL = 'opus';
    env.CODEX_HOME = join(this.options.homeDir, '.codex');
    env.CODEX_MODEL = 'gpt-6-sol';
    env.AGY_CONFIG_DIR = join(this.options.homeDir, '.gemini', 'antigravity-cli');
    env.AGY_MODEL = 'gemini-3.8-flash-low';
    env.AGY_WORKER_EFFORT = 'low';
    const child = this.options.spawn(this.options.nodePath, [script], { cwd: dirname(script), env, stdio: ['ignore','ignore','ignore'], shell: false, windowsHide: true });
    this.child = child;
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + this.options.startupTimeoutMs;
    let startupError: Error | undefined;
    const onError = (error: Error) => { startupError = error; };
    child.once('error', onError);
    try {
      while (Date.now() < deadline) {
        if (startupError) throw startupError;
        if (child.exitCode !== null) throw new Error(`Local bridge exited during startup (${child.exitCode})`);
        try {
          const response = await this.options.fetch(`${baseUrl}/v1/uhp`, { signal: AbortSignal.timeout(350) });
          if (response.ok) {
            const discovery = await response.json() as { protocol?: string; implementation?: { name?: string } };
            if (discovery.protocol === 'uhp' && discovery.implementation?.name === 'local-cli-uhp') {
              const status = { repoPath: repo, baseUrl };
              this.active = status;
              this.activeInstanceId = instanceId;
              return status;
            }
          }
        } catch { /* server is still starting */ }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
      }
      throw new Error('Local bridge did not become ready');
    } catch (error) {
      await this.stop();
      throw error;
    } finally { child.removeListener('error', onError); }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.active = undefined;
    this.activeInstanceId = undefined;
    if (!child || child.exitCode !== null || child.killed) return;
    const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
    child.kill('SIGTERM');
    const timeout = new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 1_500));
    await Promise.race([exited, timeout]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

export function createLocalBridge(options?: LocalBridgeOptions): LocalBridge { return new LocalBridge(options); }
