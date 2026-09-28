import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

export type ValidationSandboxMode = 'bwrap' | 'none';

export interface ValidationSandboxConfig {
  /** `bwrap` (default) confines every validation command; `none` runs them on the host, unsandboxed. */
  mode?: ValidationSandboxMode;
  /** Extra absolute paths re-exposed read-only inside the sandbox (toolchains under a hidden root). */
  roPaths?: readonly string[];
  /** Foreman data directory; hidden from validation commands. */
  dataDir?: string;
  /** Persistent read-write package-manager cache shared by all validations. */
  cacheDir?: string;
  /** bubblewrap executable, `bwrap` on PATH by default. */
  bwrapPath?: string;
}

export const SANDBOX_UNAVAILABLE_MESSAGE = 'Validation sandbox unavailable: install bubblewrap (bwrap) or set FOREMAN_VALIDATION_SANDBOX=none to accept unsandboxed validation';

/** Mount points must live on a writable tmpfs: the read-only host root cannot grow new top-level directories. */
export const SANDBOX_WORKSPACE = '/tmp/workspace';
export const SANDBOX_HOME = '/tmp/home';
export const SANDBOX_CACHE = '/tmp/foreman-cache';

/** Host trees replaced by an empty tmpfs: home directories, temp dirs, runtime sockets and attached storage. */
const HIDDEN_DIRS = ['/home', '/root', '/tmp', '/var/tmp', '/run', '/var/run', '/mnt', '/media', '/srv'];

export interface SandboxPlanInput {
  /** Materialized validation workspace on the host, mounted read-write. */
  workspacePath: string;
  /** Working directory relative to the workspace root. */
  cwd?: string;
  command: string;
  args: readonly string[];
  /** Keep the host network namespace. Only an explicit `true` does; anything else runs in an empty namespace with just a loopback. */
  network?: boolean;
  /** Host environment values that are carried into the sandbox. */
  env: { path: string; lang: string; lcAll: string };
  /** Operator home directory. */
  home: string;
  tmpDir: string;
  /** Source repository checkout. */
  repoPath: string;
  dataDir?: string;
  cacheDir?: string;
  roPaths?: readonly string[];
  /** Defaults to /etc/resolv.conf; re-exposed when it is a symlink into a hidden tree (systemd-resolved). */
  resolvConf?: string;
}

const real = (path: string): string | undefined => { try { return realpathSync(path); } catch { return undefined; } };
const isDirectory = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };
const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
const within = (path: string, root: string): boolean => path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

const INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'ci', 'add']);

/**
 * Network default for a validation command that carries no `network` flag (saved workspace setups, env configs, API clients written before the flag existed):
 * true for a package-manager install (`pnpm`, `npm` or `yarn` with first argument install, i, ci or add, and bare `yarn`), false for everything else.
 */
export function defaultNetworkAccess(command: string, args: readonly string[]): boolean {
  const name = command.trim();
  if (name === 'yarn' && args.length === 0) return true;
  return (name === 'pnpm' || name === 'npm' || name === 'yarn') && INSTALL_SUBCOMMANDS.has(args[0] ?? '');
}

/** Parse FOREMAN_VALIDATION_SANDBOX; empty means the default, anything unrecognised is undefined. */
export function parseSandboxMode(raw: string | undefined): ValidationSandboxMode | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'bwrap';
  return value === 'bwrap' || value === 'none' ? value : undefined;
}

/**
 * Existing directories to blank out with a tmpfs, symlinks resolved.
 * `roots` folds nested entries into their parent; `all` keeps every entry so nothing hidden can be re-exposed by accident.
 */
function hiddenRoots(input: Pick<SandboxPlanInput, 'home' | 'tmpDir' | 'repoPath' | 'dataDir'>): { roots: string[]; all: string[] } {
  const found = new Set<string>();
  for (const candidate of [...HIDDEN_DIRS, input.home, input.tmpDir, input.dataDir, input.repoPath]) {
    if (!candidate || !isAbsolute(candidate)) continue;
    const path = real(candidate);
    if (path && path !== '/' && isDirectory(path)) found.add(path);
  }
  const roots: string[] = [];
  for (const path of [...found].sort((a, b) => a.length - b.length)) if (!roots.some(root => within(path, root))) roots.push(path);
  return { roots, all: [...found] };
}

function findExecutable(command: string, path: string): string | undefined {
  if (command.includes('/')) return isAbsolute(command) ? command : undefined;
  for (const dir of path.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, command);
    try { accessSync(candidate, constants.X_OK); if (isFile(candidate)) return candidate; } catch { /* keep searching */ }
  }
  return undefined;
}

/**
 * Read-only binds that punch toolchains back through the hidden roots:
 * PATH entries, the install prefix of the command and of node, resolv.conf, and operator-listed paths.
 * Anything that would reveal a hidden root itself, the source repository or the data directory is refused.
 */
function reExposures(input: SandboxPlanInput, hidden: string[], everyHidden: string[]): Array<{ src: string; dest: string }> {
  const protectedRoots = [input.repoPath, input.dataDir].flatMap(path => path ? [real(path)] : []).filter((path): path is string => Boolean(path));
  const underHidden = (path: string) => hidden.some(root => within(path, root));
  const coversHidden = (path: string) => everyHidden.some(root => within(root, path));
  const touchesProtected = (path: string) => protectedRoots.some(root => within(path, root) || within(root, path));
  const permitted = (path: string) => !coversHidden(path) && !touchesProtected(path);
  const realHome = real(input.home);
  const userDirOf = (path: string): string | undefined => [realHome, '/root'].find(dir => dir && within(path, dir)) ?? /^\/home\/[^/]+/.exec(path)?.[0];
  const tooShallow = (path: string): boolean => { const userDir = userDirOf(path); return userDir !== undefined && (path === userDir || !relative(userDir, path).includes(sep)); };
  const binds = new Map<string, string>();
  const expose = (entry: string, accept: (real: string) => boolean): string | undefined => {
    const path = resolve(entry), target = real(path);
    if (!target || !accept(target)) return undefined;
    if (underHidden(target)) binds.set(target, target);
    if (target !== path && hidden.some(root => within(path, root))) binds.set(path, target);
    return target;
  };

  for (const entry of input.env.path.split(delimiter)) if (isAbsolute(entry)) expose(entry, target => isDirectory(target) && permitted(target));

  for (const exe of [findExecutable(input.command, input.env.path), findExecutable('node', input.env.path)]) {
    const target = exe && real(exe);
    if (!target) continue;
    const dir = dirname(target), prefix = ['bin', 'sbin'].includes(basename(dir)) ? dirname(dir) : dir;
    if (underHidden(prefix) && permitted(prefix) && !tooShallow(prefix)) binds.set(prefix, prefix);
  }

  const resolvConf = real(input.resolvConf ?? '/etc/resolv.conf');
  if (resolvConf && underHidden(resolvConf) && isFile(resolvConf)) binds.set(resolvConf, resolvConf);

  for (const entry of input.roPaths ?? []) {
    if (!isAbsolute(entry)) throw new Error(`FOREMAN_VALIDATION_SANDBOX_RO_PATHS entries must be absolute paths: ${entry}`);
    const target = real(entry);
    if (target && !permitted(target)) throw new Error(`FOREMAN_VALIDATION_SANDBOX_RO_PATHS entry would expose a path the sandbox hides: ${entry}`);
    expose(entry, () => true);
  }

  const ordered = [...binds].map(([dest, src]) => ({ src, dest })).sort((a, b) => a.dest.length - b.dest.length);
  return ordered.filter(bind => !(bind.src === bind.dest && ordered.some(other => other !== bind && other.src === other.dest && within(bind.dest, other.dest))));
}

/**
 * Build the bubblewrap argv (without the bwrap executable) that runs one validation command.
 * Order matters: the read-only root first, then the hiding tmpfs mounts, then everything that is mounted back in.
 */
export function buildSandboxArgs(input: SandboxPlanInput): string[] {
  const { roots: hidden, all } = hiddenRoots(input);
  if (!hidden.includes('/tmp')) hidden.unshift('/tmp');
  const cache = input.cacheDir && real(input.cacheDir);
  const env: Record<string, string> = {
    PATH: input.env.path, LANG: input.env.lang, LC_ALL: input.env.lcAll, HOME: SANDBOX_HOME, TMPDIR: '/tmp',
    ...(cache ? {
      // pnpm 10 reads npm_config_store_dir, pnpm 11 reads pnpm_config_store_dir; XDG_DATA_HOME also keeps pnpm's self-installed tool versions.
      XDG_CACHE_HOME: `${SANDBOX_CACHE}/xdg`, XDG_DATA_HOME: `${SANDBOX_CACHE}/xdg-data`, npm_config_cache: `${SANDBOX_CACHE}/npm`,
      npm_config_store_dir: `${SANDBOX_CACHE}/pnpm-store`, pnpm_config_store_dir: `${SANDBOX_CACHE}/pnpm-store`,
      YARN_CACHE_FOLDER: `${SANDBOX_CACHE}/yarn`, COREPACK_HOME: `${SANDBOX_CACHE}/corepack`,
    } : {}),
  };
  return [
    '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--cap-drop', 'ALL',
    // A private network namespace hides the host's loopback services (Foreman's own API, the bridge), cloud metadata and abstract Unix sockets; bwrap brings up its own lo.
    ...(input.network === true ? [] : ['--unshare-net']),
    '--ro-bind', '/', '/',
    ...hidden.flatMap(path => ['--tmpfs', path]),
    '--proc', '/proc', '--dev', '/dev',
    ...reExposures(input, hidden, all).flatMap(({ src, dest }) => ['--ro-bind', src, dest]),
    '--bind', input.workspacePath, SANDBOX_WORKSPACE,
    '--dir', SANDBOX_HOME,
    ...(cache ? ['--bind', cache, SANDBOX_CACHE] : []),
    '--chdir', input.cwd ? posix.join(SANDBOX_WORKSPACE, ...input.cwd.split(sep)) : SANDBOX_WORKSPACE,
    '--clearenv', ...Object.entries(env).flatMap(([name, value]) => ['--setenv', name, value]),
    '--', input.command, ...input.args,
  ];
}

/** Create the shared package-manager cache owner-only. */
export async function ensureSandboxCache(cacheDir: string): Promise<void> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await chmod(cacheDir, 0o700);
}

const usableBwrap = new Set<string>();

/** Run a trivial command through the same isolation flags (including the private network namespace) to prove bwrap can really create the sandbox here. */
export function probeBwrap(bwrapPath = 'bwrap'): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (usableBwrap.has(bwrapPath)) return Promise.resolve({ ok: true });
  return new Promise(resolvePromise => {
    let stderr = '', settled = false;
    const finish = (result: { ok: true } | { ok: false; detail: string }) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (result.ok) usableBwrap.add(bwrapPath);
      resolvePromise(result);
    };
    const child = spawn(bwrapPath, ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-net', '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev', '--', '/bin/sh', '-c', ':'], { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, detail: 'timed out' }); }, 10_000);
    child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk; });
    child.once('error', error => finish({ ok: false, detail: error.message }));
    child.once('close', code => finish(code === 0 ? { ok: true } : { ok: false, detail: stderr.trim().split('\n')[0] || `exit ${code}` }));
  });
}

/** Fail closed: a bwrap validation must never fall back to running on the host. */
export async function assertBwrapUsable(bwrapPath?: string): Promise<void> {
  const probe = await probeBwrap(bwrapPath);
  if (probe.ok) return;
  const missing = /ENOENT/.test(probe.detail);
  throw Object.assign(new Error(missing ? SANDBOX_UNAVAILABLE_MESSAGE : `${SANDBOX_UNAVAILABLE_MESSAGE} (bwrap: ${probe.detail})`), { statusCode: 503 });
}

/** Sandbox mode and whether bubblewrap works on this host, for the service status. Without a config it reports the environment's setting. */
export async function validationSandboxStatus(config?: ValidationSandboxConfig): Promise<{ mode: ValidationSandboxMode; available: boolean }> {
  return { mode: config?.mode ?? parseSandboxMode(process.env.FOREMAN_VALIDATION_SANDBOX) ?? 'bwrap', available: (await probeBwrap(config?.bwrapPath)).ok };
}
