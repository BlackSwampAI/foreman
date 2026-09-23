import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteSnapshotToGit, verifyPromotionCommitTree } from '../src/git-promotion.js';
import { snapshotGitCommit } from '../src/git-workspace.js';
import { compareCompleteSnapshots, type SnapshotEntry } from '../src/workspace-snapshot.js';

const directories: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const entry = (path: string, bytes: string | Buffer, executable = false, kind: 'file' | 'symlink' = 'file'): SnapshotEntry => ({ path, kind, executable, contentBase64: Buffer.from(bytes).toString('base64') });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'foreman-git-promotion-fixture-'));
  directories.push(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'Fixture');
  git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(cwd, 'README.md'), 'before\n');
  await writeFile(join(cwd, 'obsolete.txt'), 'remove me\n');
  await writeFile(join(cwd, 'run.sh'), '#!/bin/sh\necho before\n');
  await chmod(join(cwd, 'run.sh'), 0o644);
  await symlink('old-target', join(cwd, 'link'));
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'pinned base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  const original = await snapshotGitCommit(cwd, base);
  const result = original.entries.filter(e => e.path !== 'obsolete.txt').map(e => ({ ...e }));
  const replace = (next: SnapshotEntry) => { const i = result.findIndex(e => e.path === next.path); result[i] = next; };
  replace(entry('README.md', 'after\n'));
  replace(entry('run.sh', '#!/bin/sh\necho before\n', true));
  replace(entry('link', '../outside-target', false, 'symlink'));
  result.push(entry('assets/blob.bin', Buffer.from([0, 255, 4, 0])));
  const allowedScope = ['README.md', 'obsolete.txt', 'run.sh', 'link', 'assets/'];
  return { cwd, base, result, allowedScope };
}

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('approved Git result promotion (disposable Git fixtures)', () => {
  it('commits exact bytes, modes, deletions and symlinks on the pinned parent without touching a dirty source checkout', async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, 'local-dirty.txt'), 'operator work\n');
    const destinationBranch = 'refs/heads/foreman/results/run-success';
    const result = await promoteSnapshotToGit({ repoPath: f.cwd, pinnedBaseCommit: f.base, entries: f.result, allowedScope: f.allowedScope, operationId: 'run-success-approval', destinationBranch });
    expect(result).toMatchObject({ status: 'applied', parent: f.base, destinationBranch });
    expect(git(f.cwd, 'rev-parse', destinationBranch)).toBe(result.commit);
    expect(git(f.cwd, 'rev-list', '--parents', '-n', '1', result.commit)).toBe(`${result.commit} ${f.base}`);
    expect(git(f.cwd, 'rev-parse', `${result.commit}^{tree}`)).toBe(result.tree);
    expect(compareCompleteSnapshots(f.result, (await snapshotGitCommit(f.cwd, result.commit)).entries)).toEqual([]);
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.base);
    expect(git(f.cwd, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(await readFile(join(f.cwd, 'local-dirty.txt'), 'utf8')).toBe('operator work\n');
    expect(await readFile(join(f.cwd, 'README.md'), 'utf8')).toBe('before\n');
  });

  it('retries the same operation after a result commit/ref exists without creating a second result', async () => {
    const f = await fixture();
    const input = { repoPath: f.cwd, pinnedBaseCommit: f.base, entries: f.result, allowedScope: f.allowedScope, operationId: 'run-retry-approval', destinationBranch: 'refs/heads/foreman/results/run-retry' };
    const first = await promoteSnapshotToGit(input);
    // Represents a crash after Git ref creation but before Foreman's JSON state recorded the OIDs.
    const second = await promoteSnapshotToGit(input);
    expect(second).toEqual(first);
    expect(git(f.cwd, 'rev-parse', input.destinationBranch)).toBe(first.commit);
  });

  it('rejects an existing divergent destination branch and source HEAD drift', async () => {
    const f = await fixture();
    const destinationBranch = 'refs/heads/foreman/results/run-conflict';
    git(f.cwd, 'update-ref', destinationBranch, f.base);
    await expect(promoteSnapshotToGit({ repoPath: f.cwd, pinnedBaseCommit: f.base, entries: f.result, allowedScope: f.allowedScope, operationId: 'run-conflict-approval', destinationBranch })).rejects.toThrow('points elsewhere');
    expect(git(f.cwd, 'rev-parse', destinationBranch)).toBe(f.base);
    await writeFile(join(f.cwd, 'drift.txt'), 'new head\n');
    git(f.cwd, 'add', 'drift.txt');
    git(f.cwd, 'commit', '-qm', 'source drift');
    await expect(promoteSnapshotToGit({ repoPath: f.cwd, pinnedBaseCommit: f.base, entries: f.result, allowedScope: f.allowedScope, operationId: 'run-drift-approval', destinationBranch: 'refs/heads/foreman/results/run-drift' })).rejects.toThrow('drifted');
  });

  it('rejects a commit with the right parent but the wrong complete tree before any result branch is created', async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, 'README.md'), 'wrong result\n');
    git(f.cwd, 'add', 'README.md');
    git(f.cwd, 'commit', '-qm', 'wrong result fixture');
    const wrongCommit = git(f.cwd, 'rev-parse', 'HEAD');
    const destination = 'refs/heads/foreman/results/run-wrong-tree';
    await expect(verifyPromotionCommitTree(f.cwd, wrongCommit, f.base, f.result)).rejects.toThrow('does not exactly match');
    expect(() => git(f.cwd, 'show-ref', '--verify', destination)).toThrow();
  });

  it('refuses a retry when Git resolves the result commit to a different tree', async () => {
    const f = await fixture();
    const input = { repoPath: f.cwd, pinnedBaseCommit: f.base, entries: f.result, allowedScope: f.allowedScope, operationId: 'run-replaced-tree-approval', destinationBranch: 'refs/heads/foreman/results/run-replaced-tree' };
    const first = await promoteSnapshotToGit(input);
    const baseTree = git(f.cwd, 'rev-parse', `${f.base}^{tree}`);
    const wrongCommit = git(f.cwd, 'commit-tree', baseTree, '-p', f.base, '-m', 'different fixture tree');
    git(f.cwd, 'replace', first.commit, wrongCommit);
    await expect(promoteSnapshotToGit(input)).rejects.toThrow(/unexpected tree|does not exactly match/);
    expect(git(f.cwd, 'rev-parse', input.destinationBranch)).toBe(first.commit);
  });

  it('fails closed when the pinned commit object is missing', async () => {
    const f = await fixture();
    const missing = 'f'.repeat(f.base.length);
    const destination = 'refs/heads/foreman/results/run-missing';
    await expect(promoteSnapshotToGit({ repoPath: f.cwd, pinnedBaseCommit: missing, entries: f.result, allowedScope: f.allowedScope, operationId: 'run-missing-approval', destinationBranch: destination })).rejects.toThrow();
    expect(() => git(f.cwd, 'show-ref', '--verify', destination)).toThrow();
  });
});
