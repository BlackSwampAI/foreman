// Disposable Git repository used by the bridge workspace contract tests.
import { mkdtemp, writeFile, chmod, symlink, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function createWorkspaceFixture() {
  const repo = await mkdtemp(join(tmpdir(), 'foreman-uhp-git-fixture-'));
  await exec('git', ['init', '-q', repo]);
  await exec('git', ['-C', repo, 'config', 'user.name', 'Foreman Fixture']);
  await exec('git', ['-C', repo, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(repo, 'AGENTS.md'), 'Fixture instruction file\n');
  await writeFile(join(repo, '.gitattributes'), 'excluded-from-archive.txt export-ignore\n');
  await writeFile(join(repo, 'excluded-from-archive.txt'), 'still present in the Git tree\n');
  await writeFile(join(repo, '.fixture-dotfile'), 'dotfile before\n');
  await writeFile(join(repo, 'edit.txt'), 'edit before\n');
  await writeFile(join(repo, 'delete.txt'), 'delete me\n');
  await writeFile(join(repo, 'rename-before.txt'), 'identical rename payload\n');
  await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 255, 1, 2, 0, 128]));
  await writeFile(join(repo, 'run.sh'), '#!/bin/sh\nprintf fixture\n', { mode: 0o644 });
  await writeFile(join(repo, 'target-a.txt'), 'target a\n');
  await writeFile(join(repo, 'target-b.txt'), 'target b\n');
  await symlink('target-a.txt', join(repo, 'current-link'));
  await exec('git', ['-C', repo, 'add', '--all']);
  await exec('git', ['-C', repo, 'commit', '-qm', 'fixture base']);
  const baseCommit = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  return { repo, baseCommit, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

export async function applyAllFileCaseChanges(repo) {
  await writeFile(join(repo, 'edit.txt'), 'edit after\n');
  await rm(join(repo, 'delete.txt'));
  await rename(join(repo, 'rename-before.txt'), join(repo, 'rename-after.txt'));
  await writeFile(join(repo, 'added.txt'), 'new regular file\n');
  await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 254, 0, 127, 255]));
  await chmod(join(repo, 'run.sh'), 0o755);
  await rm(join(repo, 'current-link'));
  await symlink('target-b.txt', join(repo, 'current-link'));
  await writeFile(join(repo, '.fixture-dotfile'), 'dotfile after\n');
  await writeFile(join(repo, 'AGENTS.md'), 'Updated fixture instruction file\n');
}
