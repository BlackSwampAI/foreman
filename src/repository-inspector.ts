import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { WorkspaceValidationCommand } from './workspace-setup.js';

const run = promisify(execFile);

/** Read bounded Git metadata for a repository picked in the local folder browser. */
export async function inspectRepository(selectedPath: string): Promise<{
  repoPath: string;
  head: string;
  dirty: boolean;
  trackedFiles: string[];
  trackedFilesTruncated: boolean;
  suggestedAllowedScope: string[];
  suggestedValidationCommands: WorkspaceValidationCommand[];
}> {
  const selected = resolve(selectedPath);
  const options = { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 };
  const { stdout: top } = await run('git', ['-C', selected, 'rev-parse', '--show-toplevel'], options);
  const repoPath = resolve(top.trim());
  const [{ stdout: head }, { stdout: status }, { stdout: tracked }] = await Promise.all([
    run('git', ['-C', repoPath, 'rev-parse', '--verify', 'HEAD^{commit}'], options),
    run('git', ['-C', repoPath, 'status', '--porcelain=v1', '--untracked-files=normal'], options),
    run('git', ['-C', repoPath, 'ls-files', '-z'], options),
  ]);
  const allFiles = tracked.split('\0').filter(Boolean);
  const topLevel = new Set<string>();
  for (const file of allFiles) {
    const slash = file.indexOf('/');
    topLevel.add(slash < 0 ? file : `${file.slice(0, slash)}/`);
  }
  const scope = [...topLevel].filter(path => path !== '.git/' && path !== '.git').slice(0, 256);
  const suggestedValidationCommands: WorkspaceValidationCommand[] = [];
  const packagePath = join(repoPath, 'package.json');
  const packageStat = await stat(packagePath).catch(() => undefined);
  if (packageStat?.isFile() && packageStat.size < 512_000) {
    try {
      const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as { packageManager?: string; scripts?: Record<string, string> };
      const runner = pkg.packageManager?.startsWith('pnpm@') || allFiles.includes('pnpm-lock.yaml') ? 'pnpm' : 'npm';
      const test = pkg.scripts?.test;
      if (typeof test === 'string' && test.trim() && !/no test specified/i.test(test)) {
        if (runner === 'pnpm' && allFiles.includes('pnpm-lock.yaml')) suggestedValidationCommands.push({ name: 'Install dependencies', command: 'pnpm', args: ['install', '--frozen-lockfile'] });
        else if (runner === 'npm' && allFiles.includes('package-lock.json')) suggestedValidationCommands.push({ name: 'Install dependencies', command: 'npm', args: ['ci'] });
        suggestedValidationCommands.push({ name: 'Tests', command: runner, args: ['test'] });
      } else if (typeof pkg.scripts?.typecheck === 'string') {
        if (runner === 'pnpm' && allFiles.includes('pnpm-lock.yaml')) suggestedValidationCommands.push({ name: 'Install dependencies', command: 'pnpm', args: ['install', '--frozen-lockfile'] });
        suggestedValidationCommands.push({ name: 'Typecheck', command: runner, args: ['run', 'typecheck'] });
      }
    } catch { /* malformed package metadata has no automatic validation suggestion */ }
  } else if (allFiles.includes('Cargo.toml')) suggestedValidationCommands.push({ name: 'Tests', command: 'cargo', args: ['test'] });
  else if (allFiles.includes('go.mod')) suggestedValidationCommands.push({ name: 'Tests', command: 'go', args: ['test', './...'] });
  else if (allFiles.includes('pyproject.toml')) suggestedValidationCommands.push({ name: 'Tests', command: 'python', args: ['-m', 'pytest'] });
  return {
    repoPath,
    head: head.trim().toLowerCase(),
    dirty: status.length > 0,
    trackedFiles: allFiles.slice(0, 300),
    trackedFilesTruncated: allFiles.length > 300,
    suggestedAllowedScope: scope,
    suggestedValidationCommands,
  };
}
