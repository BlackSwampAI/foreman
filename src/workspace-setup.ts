import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { defaultNetworkAccess } from './validation-sandbox.js';

export interface WorkspaceValidationCommand {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  /** Keep the host network for this command. Validation runs offline unless this is true; saved setups without the flag default by `defaultNetworkAccess`. */
  network?: boolean;
}

export interface WorkspaceSetupConfig {
  repoPath: string;
  allowedScope: string[];
  validationCommands: WorkspaceValidationCommand[];
  /** Optional formatter Foreman runs over the Worker's changed files before validation. */
  formatCommand?: WorkspaceValidationCommand;
}

export interface ValidatedWorkspace {
  repoPath: string;
  head: string;
  dirty: boolean;
  allowedScope: string[];
  validationCommands: WorkspaceValidationCommand[];
  formatCommand?: WorkspaceValidationCommand;
}

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const MAX_COMMANDS = 20;
const MAX_ARG_LENGTH = 4096;
const MAX_ARGS = 128;

/** Validate a server-selected repository and normalize its workspace policy. */
export async function validateWorkspaceSetup(input: unknown): Promise<ValidatedWorkspace> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Workspace setup must be an object');
  const value = input as Record<string, unknown>;
  if (typeof value.repoPath !== 'string' || !value.repoPath.trim() || !isAbsolute(value.repoPath)) {
    throw new Error('Choose an absolute repository folder');
  }
  const repoPath = resolve(value.repoPath);
  const allowedScope = validateAllowedScope(value.allowedScope);
  const validationCommands = validateCommands(value.validationCommands);
  const formatCommand = validateFormatCommand(value.formatCommand);
  const [inside, head, status] = await Promise.all([
    git(repoPath, ['rev-parse', '--show-toplevel']),
    git(repoPath, ['rev-parse', '--verify', 'HEAD^{commit}']),
    git(repoPath, ['status', '--porcelain=v1', '--untracked-files=normal'])
  ]);
  const top = resolve(inside.trim());
  // Allow a selected subdirectory, but pin the actual repository root.
  if (repoPath !== top && !repoPath.startsWith(top + sep)) throw new Error('Selected folder is not inside a Git repository');
  const commit = head.trim().toLowerCase();
  if (!SHA.test(commit)) throw new Error('Git did not return a full HEAD commit');
  return { repoPath: top, head: commit, dirty: status.length > 0, allowedScope, validationCommands, ...(formatCommand ? { formatCommand } : {}) };
}

/** Validate repository settings then atomically persist the sanitized form under dataDir. */
export async function saveWorkspaceSetup(dataDir: string, projectId: string, input: unknown): Promise<ValidatedWorkspace> {
  if (!isAbsolute(dataDir)) throw new Error('Workspace data directory must be absolute');
  validateProjectId(projectId);
  const config = await validateWorkspaceSetup(input);
  const directory = resolve(dataDir, 'workspaces');
  await mkdir(directory, { recursive: true });
  const target = resolve(directory, `${projectId}.json`);
  const temporary = resolve(directory, `.${projectId}-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    const { rm } = await import('node:fs/promises');
    await rm(temporary, { force: true });
    throw error;
  }
  return config;
}

/** Remove repository ownership when its Foreman project is deleted. */
export async function deleteWorkspaceSetup(dataDir:string,projectId:string):Promise<void>{
  if(!isAbsolute(dataDir))throw new Error('Workspace data directory must be absolute');
  validateProjectId(projectId);
  await rm(resolve(dataDir,'workspaces',`${projectId}.json`),{force:true});
}

/** Load persisted settings and revalidate the repository before exposing them. */
export async function loadWorkspaceSetup(dataDir: string, projectId: string): Promise<ValidatedWorkspace | undefined> {
  validateProjectId(projectId);
  const target = resolve(dataDir, 'workspaces', `${projectId}.json`);
  let text: string;
  try { text = await readFile(target, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new Error('Saved workspace setup is malformed'); }
  return validateWorkspaceSetup(input);
}

/** Find the newest saved project that already owns this canonical Git checkout. */
export async function findSavedProjectForRepository(dataDir:string,projects:ReadonlyArray<{id:string;createdAt:string}>,repoPath:string):Promise<string|undefined>{
  for(const project of [...projects].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))){
    const setup=await loadWorkspaceSetup(dataDir,project.id).catch(()=>undefined);
    if(setup?.repoPath===resolve(repoPath))return project.id;
  }
  return undefined;
}

function validateProjectId(projectId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw new Error('Invalid project ID for workspace setup');
}

function validateAllowedScope(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) throw new Error('Configure at least one allowed file or directory');
  const seen = new Set<string>();
  return value.map((item: unknown) => {
    if (typeof item !== 'string') throw new Error('Allowed paths must be relative paths');
    const recursive = item.endsWith('/');
    const path = recursive ? item.slice(0, -1) : item;
    if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
      throw new Error(`Unsafe allowed path: ${item}`);
    }
    const normalized = `${path}${recursive ? '/' : ''}`;
    if (seen.has(normalized)) throw new Error(`Duplicate allowed path: ${item}`);
    seen.add(normalized);
    return normalized;
  });
}

function validateCommands(value: unknown): WorkspaceValidationCommand[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_COMMANDS) throw new Error(`Configure between 1 and ${MAX_COMMANDS} validation commands`);
  const names = new Set<string>();
  return value.map((item: unknown) => {
    const command = validateCommand(item, names, undefined);
    names.add(command.name);
    return command;
  });
}

/** The optional format step is validated like a validation command, but runs offline unless it says `network: true`. */
function validateFormatCommand(value: unknown): WorkspaceValidationCommand | undefined {
  if (value === undefined || value === null) return undefined;
  return validateCommand(value, new Set(), false);
}

function validateCommand(item: unknown, names: Set<string>, defaultNetwork: boolean | undefined): WorkspaceValidationCommand {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each validation command must be an object');
  const command = item as Record<string, unknown>;
  if (typeof command.name !== 'string' || !command.name.trim() || command.name.length > 120 || names.has(command.name.trim())) throw new Error('Validation command names must be unique and non-empty');
  if (typeof command.command !== 'string' || !command.command.trim() || command.command.length > 1024 || command.command.includes('\0')) throw new Error('Validation commands require an executable name');
  if (!Array.isArray(command.args) || command.args.length > MAX_ARGS || command.args.some(arg => typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || arg.includes('\0'))) throw new Error(`Validation argv must contain at most ${MAX_ARGS} bounded string arguments`);
  if (command.network !== undefined && typeof command.network !== 'boolean') throw new Error('Validation command network must be true or false');
  let cwd: string | undefined;
  if (command.cwd !== undefined) {
    if (typeof command.cwd !== 'string' || !command.cwd || command.cwd.startsWith('/') || command.cwd.includes('\\') || command.cwd.includes('\0') || command.cwd.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Validation command cwd must be a safe relative directory');
    cwd = command.cwd;
  }
  const executable = command.command.trim(), args = [...command.args] as string[];
  return { name: command.name.trim(), command: executable, args, ...(cwd ? { cwd } : {}), network: (command.network as boolean | undefined) ?? defaultNetwork ?? defaultNetworkAccess(executable, args) };
}

function git(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Git repository validation timed out')); }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { child.kill('SIGKILL'); reject(new Error('Git repository validation output exceeded limit')); } else stdout.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { if (Buffer.concat(stderr).length < 4096) stderr.push(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Selected folder must be a Git repository with a committed HEAD (${Buffer.concat(stderr).toString('utf8').trim().slice(0, 300)})`));
      else resolvePromise(Buffer.concat(stdout).toString('utf8'));
    });
  });
}
