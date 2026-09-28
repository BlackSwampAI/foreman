import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir, open, realpath, rename, access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Restart policy for a bridge that exits after it was ready. Every value has a production default; tests inject small ones. */
export interface LocalBridgeSupervision {
  /** Delay before the first restart; it doubles for each further consecutive restart. Default 1 s. */
  restartBaseDelayMs?: number;
  /** Upper bound of the restart delay. Default 30 s. */
  restartMaxDelayMs?: number;
  /** Give up after this many consecutive runs that each ended within `stableAfterMs` of starting. Default 5. */
  maxFastFailures?: number;
  /** A run that lasted at least this long was healthy: its crash restarts the failure count and the backoff. Default 60 s. */
  stableAfterMs?: number;
  /** Rotate bridge.log to bridge.log.1 (keeping one old file) at (re)start once it is larger than this. Default 5 MiB. */
  logMaxBytes?: number;
}
export interface LocalBridgeOptions {
  bridgeScript?: string;
  nodePath?: string;
  dataDir?: string;
  homeDir?: string;
  tempDir?: string;
  startupTimeoutMs?: number;
  /** Pause between readiness probes while the bridge is starting. Default 100 ms. */
  startupPollMs?: number;
  fetch?: typeof fetch;
  spawn?: typeof spawn;
  allocatePort?: () => Promise<number>;
  supervision?: LocalBridgeSupervision;
  /** Called when the bridge crashes, is being restarted, comes back, or is given up on. Never receives the token. */
  onHealthChange?: (health: LocalBridgeHealth) => void;
}
/** A ready bridge. `token` is the per-start bearer token; it is deliberately not enumerable, so serialising or logging a status can never leak it. */
export interface LocalBridgeStatus { repoPath: string; baseUrl: string; readonly token: string; }
export interface LocalBridgeExit {
  code: number | null;
  signal: string | null;
  at: string;
  /** How long that run lasted. */
  uptimeMs: number;
  /** Set when the run did not exit by itself, e.g. it never became ready and was stopped. */
  reason?: string;
}
export interface LocalBridgeHealth {
  /** `ready`: serving. `restarting`: crashed, a restart is scheduled or starting. `unavailable`: stopped, never started, or given up on. */
  state: 'ready' | 'restarting' | 'unavailable';
  /** Where the bridge's stdout and stderr go, once a bridge has been started. */
  logPath?: string;
  lastExit?: LocalBridgeExit;
  /** Restart attempts since the bridge was started. */
  restarts: number;
  nextRestartAt?: string;
  /** Delay chosen for the pending restart. */
  restartDelayMs?: number;
  message?: string;
}

const SAFE_ENV = ['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TERM','TMPDIR','TMP','TEMP','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS'];
const STOP_GRACE_MS = 1_500;

/** Everything a restart needs to bring the same bridge back: same port, same token, same state. */
interface Session {
  readonly repo: string;
  readonly instanceId: string;
  readonly script: string;
  readonly port: number;
  readonly token: string;
  readonly baseUrl: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logPath: string;
  readonly status: LocalBridgeStatus;
  /** Matches `LocalBridge.generation` while this session is current; any stop() or new start() invalidates it. */
  readonly generation: number;
}
interface Run { child: ChildProcess; startedAt: number; ready: boolean; exit?: { code: number | null; signal: string | null }; error?: Error; }

/**
 * A `fetch` that adds `Authorization: Bearer <token>` to every request it makes unless the caller already set one.
 * UhpClient deliberately sends no credential on UHP discovery (`GET /v1/uhp`), but the bridge protects that route
 * too, so Foreman's clients for a token-protected bridge use this as their `fetch`.
 */
export function bearerFetch(token: string, base: typeof fetch = globalThis.fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
    return base(input, { ...init, headers });
  };
}

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

/** Keep one old log: past `maxBytes` the current log becomes `<log>.1`, replacing any earlier one. */
async function rotateLog(path: string, maxBytes: number): Promise<void> {
  try { if ((await stat(path)).size > maxBytes) await rename(path, `${path}.1`); }
  catch { /* no log yet, or rotation is best effort */ }
}
function describeExit(exit: Pick<LocalBridgeExit, 'code' | 'signal' | 'reason'>): string {
  return exit.signal ? `signal ${exit.signal}` : exit.code !== null ? `exit code ${exit.code}` : exit.reason ?? 'unknown exit';
}
const alive = (child: ChildProcess): boolean => child.exitCode === null && (child.signalCode ?? null) === null;

export class LocalBridge {
  private child?: ChildProcess;
  private active?: LocalBridgeStatus;
  private activeInstanceId?: string;
  private starting?: Promise<LocalBridgeStatus>;
  private session?: Session;
  private generation = 0;
  private logWrites: Promise<void> = Promise.resolve();
  private restartTimer?: ReturnType<typeof setTimeout>;
  private fastFailures = 0;
  private backoffAttempts = 0;
  private restarts = 0;
  private lastExit?: LocalBridgeExit;
  private restartAt?: { at: number; delayMs: number };
  private givenUp?: string;
  private readonly options: Required<Pick<LocalBridgeOptions, 'bridgeScript'|'nodePath'|'dataDir'|'homeDir'|'tempDir'|'startupTimeoutMs'|'startupPollMs'|'fetch'|'spawn'>> & { allocatePort: () => Promise<number>; supervision: Required<LocalBridgeSupervision>; onHealthChange?: (health: LocalBridgeHealth) => void };

  constructor(options: LocalBridgeOptions = {}) {
    const h = options.homeDir ?? homedir();
    this.options = {
      bridgeScript: options.bridgeScript ?? fileURLToPath(new URL('../investigations/local-cli-uhp/server.mjs', import.meta.url)),
      nodePath: options.nodePath ?? process.execPath,
      dataDir: options.dataDir ?? join(process.env.XDG_DATA_HOME ?? join(h, '.local', 'share'), 'foreman', 'local-bridge'),
      homeDir: h,
      tempDir: options.tempDir ?? tmpdir(),
      startupTimeoutMs: options.startupTimeoutMs ?? 8_000,
      startupPollMs: options.startupPollMs ?? 100,
      fetch: options.fetch ?? globalThis.fetch,
      spawn: options.spawn ?? spawn,
      allocatePort: options.allocatePort ?? freePort,
      supervision: {
        restartBaseDelayMs: options.supervision?.restartBaseDelayMs ?? 1_000,
        restartMaxDelayMs: options.supervision?.restartMaxDelayMs ?? 30_000,
        maxFastFailures: options.supervision?.maxFastFailures ?? 5,
        stableAfterMs: options.supervision?.stableAfterMs ?? 60_000,
        logMaxBytes: options.supervision?.logMaxBytes ?? 5 * 1024 * 1024,
      },
      ...(options.onHealthChange ? { onHealthChange: options.onHealthChange } : {}),
    };
  }

  /** The bridge, only while it is ready to serve. During a restart or after giving up this is undefined; see `health`. */
  get status(): LocalBridgeStatus | undefined { return this.active; }

  get health(): LocalBridgeHealth {
    const state = this.active ? 'ready' : this.restartAt || this.restartTimer ? 'restarting' : 'unavailable';
    return {
      state,
      ...(this.session ? { logPath: this.session.logPath } : {}),
      ...(this.lastExit ? { lastExit: { ...this.lastExit } } : {}),
      restarts: this.restarts,
      ...(state === 'restarting' && this.restartAt ? { nextRestartAt: new Date(this.restartAt.at).toISOString(), restartDelayMs: this.restartAt.delayMs, message: `Local bridge ended (${this.lastExit ? describeExit(this.lastExit) : 'unknown exit'}); restarting in ${this.restartAt.delayMs} ms; see ${this.session?.logPath}` } : {}),
      ...(state === 'unavailable' && this.givenUp ? { message: this.givenUp } : {}),
    };
  }

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
    const token = randomBytes(32).toString('hex');
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
    env.LOCAL_CLI_UHP_TOKEN = token;
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
    const baseUrl = `http://127.0.0.1:${port}`;
    const status = Object.defineProperty({ repoPath: repo, baseUrl } as LocalBridgeStatus, 'token', { value: token, enumerable: false });
    this.fastFailures = 0; this.backoffAttempts = 0; this.restarts = 0; this.lastExit = undefined; this.givenUp = undefined;
    const session: Session = { repo, instanceId, script, port, token, baseUrl, env, logPath: join(stateDir, 'bridge.log'), status, generation: ++this.generation };
    this.session = session;
    try {
      await this.bringUp(session, {});
      return status;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** Spawn the bridge, wait until it answers authenticated discovery, then publish it as the active status. */
  private async bringUp(session: Session, attempt: { run?: Run }): Promise<void> {
    const run = attempt.run = await this.launch(session);
    await this.waitUntilReady(session, run);
    // Log before publishing, so the bridge turns ready and its health is reported with no await in between.
    await this.note(session, `bridge ready on ${session.baseUrl} (pid ${run.child.pid ?? 'unknown'})`);
    this.assertCurrent(session);
    if (run.exit) throw new Error(`Local bridge exited during startup (${describeExit(run.exit)}); see ${session.logPath}`);
    run.ready = true;
    this.active = session.status;
    this.activeInstanceId = session.instanceId;
  }

  private async launch(session: Session): Promise<Run> {
    // Let notes about the previous run land before rotation, so none can end up in the new log or be lost with the old one.
    await this.logWrites;
    await rotateLog(session.logPath, this.options.supervision.logMaxBytes);
    const log = await open(session.logPath, 'a', 0o600);
    try {
      await log.chmod(0o600);
      this.assertCurrent(session);
      const child = this.options.spawn(this.options.nodePath, [session.script], { cwd: dirname(session.script), env: session.env, stdio: ['ignore', log.fd, log.fd], shell: false, windowsHide: true });
      const run: Run = { child, startedAt: Date.now(), ready: false };
      this.child = child;
      child.once('exit', (code, signal) => { run.exit = { code, signal: signal ?? null }; this.onExit(session, run); });
      // A spawn failure reports only 'error'. Keep a listener for the child's whole life: an unhandled 'error' would crash Foreman.
      child.on('error', error => { if (child.pid === undefined && !run.exit) { run.error = error; run.exit = { code: null, signal: null }; this.onExit(session, run); } });
      await this.note(session, `starting bridge on ${session.baseUrl} (pid ${child.pid ?? 'unknown'})`);
      return run;
    } finally { await log.close().catch(() => undefined); }
  }

  private async waitUntilReady(session: Session, run: Run): Promise<void> {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    while (Date.now() < deadline) {
      this.assertCurrent(session);
      if (run.error) throw run.error;
      if (run.exit) throw new Error(`Local bridge exited during startup (${describeExit(run.exit)}); see ${session.logPath}`);
      let rejected: number | undefined;
      try {
        const response = await this.options.fetch(`${session.baseUrl}/v1/uhp`, { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(350) });
        if (response.status === 401 || response.status === 403) rejected = response.status;
        else if (response.ok) {
          const discovery = await response.json() as { protocol?: string; implementation?: { name?: string } };
          if (discovery.protocol === 'uhp' && discovery.implementation?.name === 'local-cli-uhp') return;
        }
      } catch { /* server is still starting */ }
      // The bridge was started with this token, so a rejection means something else owns the port.
      if (rejected !== undefined) throw new Error(`Local bridge port ${session.port} answered the readiness check with ${rejected}; another process may own it`);
      await new Promise(resolveDelay => setTimeout(resolveDelay, this.options.startupPollMs));
    }
    throw new Error(`Local bridge did not become ready; see ${session.logPath}`);
  }

  private assertCurrent(session: Session): void {
    if (session.generation !== this.generation) throw new Error('Local bridge was stopped during startup');
  }

  /** A child ended. Only an exit after readiness, of the current child, is an unexpected crash; startup failures are reported by the startup poll. */
  private onExit(session: Session, run: Run): void {
    if (session.generation !== this.generation || this.child !== run.child || !run.ready) return;
    this.child = undefined;
    this.active = undefined;
    this.afterFailure(session, { code: run.exit?.code ?? null, signal: run.exit?.signal ?? null, at: new Date().toISOString(), uptimeMs: Date.now() - run.startedAt }, false);
  }

  /** Count a finished run and either schedule the next restart or give up. */
  private afterFailure(session: Session, exit: LocalBridgeExit, startupFailure: boolean): void {
    const policy = this.options.supervision;
    this.lastExit = exit;
    if (!startupFailure && exit.uptimeMs >= policy.stableAfterMs) { this.fastFailures = 0; this.backoffAttempts = 0; }
    else this.fastFailures++;
    this.note(session, `bridge ended (${describeExit(exit)}) after ${exit.uptimeMs} ms`);
    if (this.fastFailures >= policy.maxFastFailures) {
      this.restartAt = undefined;
      this.givenUp = `Local bridge stopped after ${this.fastFailures} consecutive failures within ${Math.round(policy.stableAfterMs / 1000)} s of starting (last exit: ${describeExit(exit)}); see ${session.logPath}`;
      this.note(session, `giving up: ${this.givenUp}`);
      this.notify();
      return;
    }
    const delayMs = Math.min(policy.restartBaseDelayMs * 2 ** this.backoffAttempts, policy.restartMaxDelayMs);
    this.backoffAttempts++;
    this.restartAt = { at: Date.now() + delayMs, delayMs };
    this.note(session, `restarting in ${delayMs} ms`);
    this.restartTimer = setTimeout(() => { this.restartTimer = undefined; void this.restart(session).catch(() => undefined); }, delayMs);
    this.restartTimer.unref?.();
    this.notify();
  }

  /** Bring the same bridge back on the same port with the same token, so every URL and credential already handed out stays valid. */
  private async restart(session: Session): Promise<void> {
    if (session.generation !== this.generation) return;
    this.restarts++;
    const attempt: { run?: Run } = {};
    try {
      await this.bringUp(session, attempt);
    } catch (error) {
      if (session.generation !== this.generation) return; // a deliberate stop() owns the cleanup
      const run = attempt.run;
      const own = run && !run.error ? run.exit : undefined; // how it ended by itself, before we stop it below
      if (run) await this.terminate(run.child);
      if (session.generation !== this.generation) return;
      this.child = undefined;
      // An unbindable port makes the bridge exit at once; a bridge that never answers is stopped. Both are failed attempts.
      this.afterFailure(session, { code: own?.code ?? null, signal: own?.signal ?? null, at: new Date().toISOString(), uptimeMs: run ? Date.now() - run.startedAt : 0, ...(own ? {} : { reason: error instanceof Error ? error.message : 'restart failed' }) }, true);
      return;
    }
    this.restartAt = undefined;
    this.notify();
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.restartAt = undefined;
    const child = this.child;
    this.child = undefined;
    this.active = undefined;
    this.activeInstanceId = undefined;
    if (child) await this.terminate(child);
  }

  private async terminate(child: ChildProcess): Promise<void> {
    if (!alive(child)) return;
    const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolveTimeout => { timer = setTimeout(resolveTimeout, STOP_GRACE_MS); });
    await Promise.race([exited, timeout]);
    clearTimeout(timer);
    if (alive(child)) child.kill('SIGKILL');
  }

  /** Append a Foreman line to the bridge log. Writes are queued so lines keep their order; callers on the startup path await it. */
  private note(session: Session, message: string): Promise<void> {
    const line = `[foreman ${new Date().toISOString()}] ${message}\n`;
    this.logWrites = this.logWrites.then(() => appendFile(session.logPath, line, { mode: 0o600 })).catch(() => undefined);
    return this.logWrites;
  }
  private notify(): void {
    const health = this.health;
    if (health.state === 'unavailable' && !this.givenUp) return;
    try { this.options.onHealthChange?.(health); } catch { /* a listener must not break supervision */ }
  }
}

export function createLocalBridge(options?: LocalBridgeOptions): LocalBridge { return new LocalBridge(options); }
