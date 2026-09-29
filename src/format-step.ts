import { lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { verifyGitSnapshotScope } from './git-workspace.js';
import { assertBwrapUsable, defaultNetworkAccess, ensureSandboxCache, type ValidationSandboxConfig } from './validation-sandbox.js';
import { formatReviewDiff, materializeVerifiedWorkspace, runOne, type ValidationCommand, type ValidationObservation, type VerifiedWorkerWorkspace } from './verified-workspace.js';
import type { SnapshotEntry } from './workspace-snapshot.js';

/** What the format step did to a Worker snapshot. `observation` is the format command's run (or the failing setup command's), with its output bounded. */
export interface WorkerFormatting { status: 'applied' | 'unchanged' | 'failed'; command: string; args: string[]; formattedPaths: string[]; observation?: ValidationObservation; /** Set when the step failed for a reason other than a command result (sandbox unavailable, unreadable workspace, re-verification refused). */ error?: string }

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_OBSERVATION_OUTPUT = 4000;

/** Dependency-install commands of the configured validation list, which prepare the workspace for the formatter. Other network-enabled checks (smoke scripts, `cargo test`) are not setup and do not run before formatting. */
export function formatSetupCommands(commands: readonly ValidationCommand[]): ValidationCommand[] {
  return commands.filter(command => defaultNetworkAccess(command.command, command.args));
}

const bounded = (observation: ValidationObservation): ValidationObservation => ({ ...observation, output: observation.output.length > MAX_OBSERVATION_OUTPUT ? `${observation.output.slice(0, MAX_OBSERVATION_OUTPUT)}\n[output truncated]` : observation.output });
const ranCleanly = (observation: ValidationObservation): boolean => observation.exitCode === 0 && !observation.timedOut && !observation.outputTruncated;

/**
 * Run the configured formatter over a verified Worker snapshot in a disposable sandboxed workspace and adopt the result for the files the Worker added, modified or renamed.
 * Foreman, not the Worker, produces the bytes that validation, the Reviewer and promotion then see: the new snapshot is re-verified against the pinned base and allowed scope.
 * Anything the formatter does to other files, new files, file modes or symlinks is ignored. Any failure returns the original snapshot with status `failed`; validation then reports the real problem.
 */
export async function formatWorkerSnapshot(input: {
  repoPath: string; verified: VerifiedWorkerWorkspace; setupCommands: readonly ValidationCommand[]; formatCommand: ValidationCommand; allowedScope: readonly string[];
  timeoutMs?: number; maxOutputBytes?: number; sandbox?: ValidationSandboxConfig;
}): Promise<{ verified: VerifiedWorkerWorkspace; formatting: WorkerFormatting }> {
  const { formatCommand, verified } = input;
  const formatting = (patch: Partial<WorkerFormatting> & Pick<WorkerFormatting, 'status'>): WorkerFormatting => ({ command: formatCommand.command, args: [...formatCommand.args], formattedPaths: [], ...patch });
  const failed = (error?: string, observation?: ValidationObservation) => ({ verified, formatting: formatting({ status: 'failed', ...(observation ? { observation: bounded(observation) } : {}), ...(error ? { error } : {}) }) });
  const sandbox = input.sandbox ?? {}, timeoutMs = input.timeoutMs ?? 120_000, maxBytes = input.maxOutputBytes ?? 1024 * 1024;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    if ((sandbox.mode ?? 'bwrap') === 'bwrap') { await assertBwrapUsable(sandbox.bwrapPath); if (sandbox.cacheDir) await ensureSandboxCache(sandbox.cacheDir); }
    if (!Array.isArray(verified.entries)) throw new Error('Only freshly verified snapshots with their complete entries can be formatted');
    const workspace = await materializeVerifiedWorkspace(input.repoPath, verified);
    cleanup = workspace.cleanup;
    const root = workspace.workspacePath;
    for (const setup of input.setupCommands) {
      const observation = await runOne(root, input.repoPath, setup, timeoutMs, maxBytes, sandbox);
      if (!ranCleanly(observation)) return failed(undefined, observation);
    }
    // The formatter is a repository script: it gets no network unless the configuration says so explicitly.
    const observation = await runOne(root, input.repoPath, { ...formatCommand, network: formatCommand.network === true }, timeoutMs, maxBytes, sandbox);
    if (!ranCleanly(observation)) return failed(undefined, observation);

    // Read back only paths the Worker added, modified or renamed to; never pick up files the formatter created or touched elsewhere.
    const realRoot = await realpath(root), replacements = new Map<string, SnapshotEntry>(), byPath = new Map(verified.entries.map(entry => [entry.path, entry]));
    for (const change of verified.changes) {
      if (change.kind === 'delete' || change.after?.kind !== 'file') continue;
      const original = byPath.get(change.path);
      if (!original || original.kind !== 'file') continue;
      const bytes = await readRegularFile(root, realRoot, change.path);
      if (!bytes || bytes.toString('base64') === original.contentBase64) continue;
      replacements.set(change.path, { path: original.path, kind: 'file', executable: original.executable, contentBase64: bytes.toString('base64') });
    }
    if (!replacements.size) return { verified, formatting: formatting({ status: 'unchanged', observation: bounded(observation) }) };

    const entries = verified.entries.map(entry => replacements.get(entry.path) ?? entry);
    const checked = await verifyGitSnapshotScope(input.repoPath, verified.pinnedBaseCommit, entries, input.allowedScope);
    const changes = checked.changes.map(c => ({ kind: c.kind, path: c.path, ...(c.previousPath ? { previousPath: c.previousPath } : {}), ...(c.before ? { before: c.before } : {}), ...(c.after ? { after: c.after } : {}) }));
    const formatted: VerifiedWorkerWorkspace = { ...verified, pinnedBaseCommit: checked.commit, completeSnapshot: { ...verified.completeSnapshot, entryCount: entries.length }, allowedScope: checked.allowedScope, entries, changes, reviewDiff: formatReviewDiff(changes) };
    return { verified: formatted, formatting: formatting({ status: 'applied', formattedPaths: [...replacements.keys()].sort(), observation: bounded(observation) }) };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  } finally { await cleanup?.(); }
}

/** File bytes when `path` is still a regular file (not a symlink) that resolves inside the workspace; undefined otherwise. */
async function readRegularFile(root: string, realRoot: string, path: string): Promise<Buffer | undefined> {
  const full = resolve(root, path);
  if (!full.startsWith(root + sep)) return undefined;
  try {
    const stats = await lstat(full);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return undefined;
    const real = await realpath(full);
    if (!real.startsWith(realRoot + sep)) return undefined;
    return await readFile(real);
  } catch { return undefined; }
}
