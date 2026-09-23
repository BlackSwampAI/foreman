import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWorkspaceSetup, saveWorkspaceSetup, validateWorkspaceSetup } from './workspace-setup.js';

const temporaryDirectories: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-workspace-setup-'));
  temporaryDirectories.push(dir);
  return dir;
}
async function command(cwd: string, ...args: string[]): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`git ${args[0]} failed`)));
  });
}
async function gitRepo(): Promise<string> {
  const dir = await temp();
  await mkdir(join(dir, 'src'));
  await command(dir, 'init', '-q');
  await command(dir, 'config', 'user.email', 'foreman@example.test');
  await command(dir, 'config', 'user.name', 'Foreman Test');
  await writeFile(join(dir, 'src', 'index.ts'), 'export {}\n');
  await command(dir, 'add', '.');
  await command(dir, 'commit', '-qm', 'initial');
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('workspace setup', () => {
  it('pins a committed HEAD, reports dirty source, and persists only validated settings', async () => {
    const repoPath = await gitRepo();
    await writeFile(join(repoPath, 'uncommitted.txt'), 'dirty');
    const dataDir = join(await temp(), 'data');
    const input = {
      repoPath,
      allowedScope: ['src/'],
      validationCommands: [{ name: 'Typecheck', command: 'npm', args: ['run', 'typecheck'], cwd: 'src' }]
    };
    const saved = await saveWorkspaceSetup(dataDir, 'project-1', input);
    expect(saved.head).toMatch(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
    expect(saved.dirty).toBe(true);
    expect(saved.allowedScope).toEqual(['src/']);
    expect(await loadWorkspaceSetup(dataDir, 'project-1')).toEqual(saved);
  });

  it('rejects unsafe scope paths and validation cwd before touching the repository', async () => {
    const base = { repoPath: '/path/that/does/not/exist', validationCommands: [{ name: 'Build', command: 'npm', args: ['run', 'build'] }] };
    await expect(validateWorkspaceSetup({ ...base, allowedScope: ['../outside'] })).rejects.toThrow('Unsafe allowed path');
    await expect(validateWorkspaceSetup({ ...base, allowedScope: ['src/'], validationCommands: [{ name: 'Build', command: 'npm', args: [], cwd: '../' }] })).rejects.toThrow('safe relative directory');
  });

  it('requires an absolute repository path and a validation command', async () => {
    await expect(validateWorkspaceSetup({ repoPath: '.', allowedScope: ['src/'], validationCommands: [{ name: 'Build', command: 'npm', args: [] }] })).rejects.toThrow('absolute repository folder');
    await expect(validateWorkspaceSetup({ repoPath: '/tmp', allowedScope: ['src/'], validationCommands: [] })).rejects.toThrow('validation commands');
  });
});
