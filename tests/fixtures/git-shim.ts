import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface GitShim {
  /** Arguments of every `git` process spawned since the shim was installed, one line each. */
  calls(): Promise<string[]>;
  /** Process id of the most recent `git cat-file --batch` process, if any was started. */
  batchPid(): Promise<number | undefined>;
  /** What was written to the stdin of `git cat-file --batch` (needs `recordBatchInput`). */
  batchInput(): Promise<string>;
  /** Restore PATH and remove the shim. */
  restore(): Promise<void>;
}

export interface GitShimOptions {
  /** Shell snippet that replaces `git cat-file --batch` once its pid is recorded; `$REAL` is the real Git. */
  onBatch?: string;
  /** Copy the stdin of `git cat-file --batch` to a file while still running the real Git. */
  recordBatchInput?: boolean;
}

/**
 * Put a `git` wrapper first on PATH: it logs its arguments and then runs the real Git. Options let a test replace
 * or observe `git cat-file --batch`, e.g. to make it hang, emit garbage or fail. Call `restore()` when done,
 * also when the test fails.
 */
export async function installGitShim(options: GitShimOptions = {}): Promise<GitShim> {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const directory = await mkdtemp(join(tmpdir(), 'foreman-git-shim-'));
  const log = join(directory, 'calls.log');
  const pidFile = join(directory, 'batch.pid');
  const inputFile = join(directory, 'batch.stdin');
  await writeFile(log, '');
  await writeFile(inputFile, '');
  const batch = options.onBatch ?? (options.recordBatchInput ? `tee '${inputFile}' | "$REAL" "$@"; exit $?` : '');
  await writeFile(join(directory, 'git'), [
    '#!/bin/sh',
    `REAL='${real}'`,
    `printf '%s\\n' "$*" >> '${log}'`,
    'case "$*" in',
    '  *"cat-file --batch"*)',
    `    echo $$ > '${pidFile}'`,
    ...(batch ? [`    ${batch}`] : []),
    '    ;;',
    'esac',
    'exec "$REAL" "$@"',
    ''
  ].join('\n'), { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${directory}:${previous ?? ''}`;
  return {
    calls: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean),
    batchPid: async () => {
      try { return Number((await readFile(pidFile, 'utf8')).trim()) || undefined; } catch { return undefined; }
    },
    batchInput: () => readFile(inputFile, 'utf8'),
    restore: async () => {
      if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
      await rm(directory, { recursive: true, force: true });
    }
  };
}

/** The Git subcommand of a logged call, e.g. `cat-file` for `-C /repo cat-file --batch`. */
export function gitSubcommand(call: string): string {
  return call.replace(/^-C \S+ /, '').replace(/^(?:-c \S+ )+/, '').split(' ')[0]!;
}

/** True once no process with this id exists any more (polls briefly, since a killed child is reaped asynchronously). */
export async function processIsGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
