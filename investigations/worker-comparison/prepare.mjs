#!/usr/bin/env node
// Prepare a fresh Git repository for the one-task Worker comparison. This script
// only copies local fixture files and initializes Git; it never reads auth data
// or contacts a model provider.
import { cp, mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const destinationArg = process.argv[2];
const repoPath = destinationArg
  ? resolve(destinationArg)
  : await mkdtemp(join(tmpdir(), 'foreman-worker-comparison-'));

if (destinationArg) {
  try {
    await stat(repoPath);
    throw new Error(`Destination already exists: ${repoPath}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(repoPath), { recursive: true });
  await mkdir(repoPath, { recursive: false });
}

for (const path of ['package.json', 'TASK.txt', 'src', 'test']) {
  await cp(join(fixtureRoot, path), join(repoPath, path), { recursive: true, errorOnExist: true });
}

await exec('git', ['init', '-q', repoPath]);
await exec('git', ['-C', repoPath, 'config', 'user.name', 'Foreman Comparison Fixture']);
await exec('git', ['-C', repoPath, 'config', 'user.email', 'foreman-comparison@example.invalid']);
await exec('git', ['-C', repoPath, 'add', '--all']);
await exec('git', ['-C', repoPath, 'commit', '-qm', 'bounded Worker comparison base']);
const { stdout: baseCommit } = await exec('git', ['-C', repoPath, 'rev-parse', 'HEAD']);
const { stdout: status } = await exec('git', ['-C', repoPath, 'status', '--porcelain']);
if (status.trim()) throw new Error('Prepared comparison repository is not clean');

const taskText = (await readFile(join(repoPath, 'TASK.txt'), 'utf8')).trim();
process.stdout.write(`${JSON.stringify({
  repoPath,
  baseCommit: baseCommit.trim(),
  allowedPaths: ['src/label.ts', 'test/label.check.ts'],
  taskText,
  preparationOnly: true,
  providerCalls: 0,
  credentialsRead: false,
}, null, 2)}\n`);
