import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  describe('network flag', () => {
    const networkOf = (setup: { validationCommands: Array<{ name: string; network?: boolean }> }) => Object.fromEntries(setup.validationCommands.map(check => [check.name, check.network]));

    it('gives a command with no flag network access only when it is a recognised package-manager install', async () => {
      const repoPath = await gitRepo();
      const commands = [
        { name: 'pnpm install', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
        { name: 'npm ci', command: 'npm', args: ['ci'] },
        { name: 'npm i', command: 'npm', args: ['i', '--no-audit'] },
        { name: 'pnpm add', command: 'pnpm', args: ['add', 'left-pad'] },
        { name: 'bare yarn', command: 'yarn', args: [] },
        { name: 'yarn install', command: 'yarn', args: ['install', '--immutable'] },
        { name: 'trimmed', command: ' npm ', args: ['ci'] },
        { name: 'pnpm test', command: 'pnpm', args: ['test'] },
        { name: 'npm run install', command: 'npm', args: ['run', 'install'] },
        { name: 'pnpm filter install', command: 'pnpm', args: ['--filter', 'app', 'install'] },
        { name: 'yarn flags only', command: 'yarn', args: ['--immutable'] },
        { name: 'cargo', command: 'cargo', args: ['test'] },
        { name: 'other install', command: 'bun', args: ['install'] },
        { name: 'shim path', command: '/usr/local/bin/pnpm', args: ['install'] },
      ];
      const setup = await validateWorkspaceSetup({ repoPath, allowedScope: ['src/'], validationCommands: commands });
      expect(networkOf(setup)).toEqual({
        'pnpm install': true, 'npm ci': true, 'npm i': true, 'pnpm add': true, 'bare yarn': true, 'yarn install': true, trimmed: true,
        'pnpm test': false, 'npm run install': false, 'pnpm filter install': false, 'yarn flags only': false, cargo: false, 'other install': false, 'shim path': false,
      });
    });

    it('keeps an explicit flag on every command, including an install that opts out and a test that opts in', async () => {
      const repoPath = await gitRepo();
      const setup = await validateWorkspaceSetup({ repoPath, allowedScope: ['src/'], validationCommands: [
        { name: 'Install offline', command: 'pnpm', args: ['install', '--offline'], network: false },
        { name: 'Cargo', command: 'cargo', args: ['test'], network: true },
        { name: 'Tests', command: 'pnpm', args: ['test'], network: false },
      ] });
      expect(networkOf(setup)).toEqual({ 'Install offline': false, Cargo: true, Tests: false });
    });

    it('persists the resolved flag and defaults a saved setup written before the flag existed', async () => {
      const repoPath = await gitRepo(), dataDir = join(await temp(), 'data');
      const saved = await saveWorkspaceSetup(dataDir, 'project-net', { repoPath, allowedScope: ['src/'], validationCommands: [{ name: 'Install', command: 'pnpm', args: ['install'] }, { name: 'Tests', command: 'pnpm', args: ['test'], network: true }] });
      expect(saved.validationCommands.map(check => check.network)).toEqual([true, true]);
      expect(JSON.parse(await readFile(join(dataDir, 'workspaces', 'project-net.json'), 'utf8')).validationCommands.map((check: { network: boolean }) => check.network)).toEqual([true, true]);
      // An older file: no network field anywhere.
      const legacy = { repoPath, head: saved.head, dirty: false, allowedScope: ['src/'], validationCommands: [{ name: 'Install', command: 'npm', args: ['ci'] }, { name: 'Tests', command: 'npm', args: ['test'] }] };
      await writeFile(join(dataDir, 'workspaces', 'project-legacy.json'), JSON.stringify(legacy));
      expect(networkOf((await loadWorkspaceSetup(dataDir, 'project-legacy'))!)).toEqual({ Install: true, Tests: false });
    });

    it('accepts only true or false', async () => {
      const base = { repoPath: '/path/that/does/not/exist', allowedScope: ['src/'] };
      for (const network of ['true', 'false', 1, 0, null, {}, []]) {
        await expect(validateWorkspaceSetup({ ...base, validationCommands: [{ name: 'Install', command: 'pnpm', args: ['install'], network }] }), JSON.stringify(network)).rejects.toThrow('network must be true or false');
      }
    });
  });

  describe('format command', () => {
    const validation = [{ name: 'Tests', command: 'pnpm', args: ['run', 'test'] }];

    it('is optional, validated like a validation command, and offline unless it says otherwise', async () => {
      const repoPath = await gitRepo();
      const base = { repoPath, allowedScope: ['src/'], validationCommands: validation };
      expect((await validateWorkspaceSetup(base)).formatCommand).toBeUndefined();
      expect((await validateWorkspaceSetup({ ...base, formatCommand: null })).formatCommand).toBeUndefined();
      expect((await validateWorkspaceSetup({ ...base, formatCommand: { name: ' Format ', command: 'pnpm', args: ['run', 'format'] } })).formatCommand).toEqual({ name: 'Format', command: 'pnpm', args: ['run', 'format'], network: false });
      // Even an install-shaped command gets no network unless the setup says so explicitly.
      expect((await validateWorkspaceSetup({ ...base, formatCommand: { name: 'Format', command: 'pnpm', args: ['install'] } })).formatCommand?.network).toBe(false);
      expect((await validateWorkspaceSetup({ ...base, formatCommand: { name: 'Format', command: 'x', args: [], network: true } })).formatCommand?.network).toBe(true);
    });

    it('rejects a malformed format command', async () => {
      const base = { repoPath: '/path/that/does/not/exist', allowedScope: ['src/'], validationCommands: validation };
      await expect(validateWorkspaceSetup({ ...base, formatCommand: 'pnpm run format' })).rejects.toThrow('must be an object');
      await expect(validateWorkspaceSetup({ ...base, formatCommand: { command: 'pnpm', args: [] } })).rejects.toThrow('names must be unique and non-empty');
      await expect(validateWorkspaceSetup({ ...base, formatCommand: { name: 'Format', command: 'pnpm', args: 'run format' } })).rejects.toThrow('argv');
      await expect(validateWorkspaceSetup({ ...base, formatCommand: { name: 'Format', command: 'pnpm', args: [], network: 'no' } })).rejects.toThrow('network must be true or false');
      await expect(validateWorkspaceSetup({ ...base, formatCommand: { name: 'Format', command: 'pnpm', args: [], cwd: '../x' } })).rejects.toThrow('safe relative directory');
    });

    it('is persisted with the saved setup and reloaded', async () => {
      const repoPath = await gitRepo();
      const dataDir = join(await temp(), 'data');
      const saved = await saveWorkspaceSetup(dataDir, 'project-format', { repoPath, allowedScope: ['src/'], validationCommands: validation, formatCommand: { name: 'Format', command: 'pnpm', args: ['run', 'format'] } });
      expect(JSON.parse(await readFile(join(dataDir, 'workspaces', 'project-format.json'), 'utf8')).formatCommand).toEqual({ name: 'Format', command: 'pnpm', args: ['run', 'format'], network: false });
      expect(await loadWorkspaceSetup(dataDir, 'project-format')).toEqual(saved);
    });
  });
});
