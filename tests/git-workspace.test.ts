import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotGitCommit, verifyGitSnapshotScope } from '../src/git-workspace.js';
import type { SnapshotEntry } from '../src/workspace-snapshot.js';

const repos: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function repo() {
  const path = await mkdtemp(join(tmpdir(), 'foreman-git-snapshot-'));
  repos.push(path);
  git(path, 'init', '-q');
  git(path, 'config', 'user.name', 'Fixture');
  git(path, 'config', 'user.email', 'fixture@example.invalid');
  return path;
}
const entry = (path: string, content: Uint8Array | string, executable = false, kind: 'file' | 'symlink' = 'file'): SnapshotEntry => ({
  path, kind, contentBase64: Buffer.from(content).toString('base64'), executable
});
const commit = (cwd: string) => git(cwd, 'rev-parse', 'HEAD');
async function addBaseFiles(cwd: string) {
  await writeFile(join(cwd, 'modified.txt'), 'before');
  await writeFile(join(cwd, 'deleted.txt'), 'remove me');
  await writeFile(join(cwd, 'rename-before.txt'), 'same bytes');
  await writeFile(join(cwd, 'binary.bin'), Buffer.from([0, 255, 3, 0]));
  await writeFile(join(cwd, 'run.sh'), '#!/bin/sh\necho hi\n');
  await chmod(join(cwd, 'run.sh'), 0o644);
  await symlink('old-target', join(cwd, 'current-link'));
  await writeFile(join(cwd, '.env.example'), 'before env');
  await writeFile(join(cwd, 'AGENTS.md'), 'before instructions');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'base');
}

afterEach(async () => { await Promise.all(repos.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('canonical Git snapshots', () => {
  it('reads exact base blobs and verifies add, modify, delete, rename, binary, mode, symlink, dotfile and AGENTS changes', async () => {
    const cwd = await repo();
    await addBaseFiles(cwd);
    const base = await snapshotGitCommit(cwd, commit(cwd));
    expect(base.entries.map(e => e.path)).toEqual(['.env.example', 'AGENTS.md', 'binary.bin', 'current-link', 'deleted.txt', 'modified.txt', 'rename-before.txt', 'run.sh']);
    expect(base.entries.find(e => e.path === 'binary.bin')?.contentBase64).toBe(Buffer.from([0, 255, 3, 0]).toString('base64'));
    expect(base.entries.find(e => e.path === 'current-link')).toMatchObject({ kind: 'symlink', contentBase64: Buffer.from('old-target').toString('base64') });
    const result = base.entries.filter(e => e.path !== 'deleted.txt' && e.path !== 'rename-before.txt').map(e => ({ ...e }));
    result.push(entry('added.txt', 'new file'));
    result.push(entry('rename-after.txt', 'same bytes'));
    const replace = (path: string, next: SnapshotEntry) => { const i = result.findIndex(e => e.path === path); result[i] = next; };
    replace('modified.txt', entry('modified.txt', 'after'));
    replace('binary.bin', entry('binary.bin', Buffer.from([0, 1, 3, 0])));
    replace('run.sh', entry('run.sh', '#!/bin/sh\necho hi\n', true));
    replace('current-link', entry('current-link', 'new-target', false, 'symlink'));
    replace('.env.example', entry('.env.example', 'after env'));
    replace('AGENTS.md', entry('AGENTS.md', 'after instructions'));
    const verified = await verifyGitSnapshotScope(cwd, base.commit, result, ['.env.example', 'AGENTS.md', 'binary.bin', 'current-link', 'deleted.txt', 'modified.txt', 'rename-before.txt', 'rename-after.txt', 'run.sh', 'added.txt']);
    expect(verified.scopeVerified).toBe(true);
    expect(Object.fromEntries(verified.changes.map(c => [c.path, c.kind]))).toEqual({
      '.env.example': 'modify', 'AGENTS.md': 'modify', 'added.txt': 'add', 'binary.bin': 'modify', 'current-link': 'modify',
      'deleted.txt': 'delete', 'modified.txt': 'modify', 'rename-after.txt': 'rename', 'run.sh': 'modify'
    });
    expect(verified.changes.find(c => c.kind === 'rename')?.previousPath).toBe('rename-before.txt');
    expect(verified.changes.find(c => c.path === 'run.sh')?.after?.executable).toBe(true);
  });

  it('rejects any changed path outside explicit scope, including the source side of a rename', async () => {
    const cwd = await repo();
    await addBaseFiles(cwd);
    const base = await snapshotGitCommit(cwd, commit(cwd));
    const result = base.entries.map(e => ({ ...e }));
    result.push(entry('outside/new.txt', 'bad'));
    await expect(verifyGitSnapshotScope(cwd, base.commit, result, ['allowed'])).rejects.toThrow('outside the allowed scope: outside/new.txt');
    const rename = base.entries.filter(e => e.path !== 'rename-before.txt').map(e => ({ ...e }));
    rename.push(entry('allowed/rename-after.txt', 'same bytes'));
    await expect(verifyGitSnapshotScope(cwd, base.commit, rename, ['allowed/'])).rejects.toThrow('outside the allowed scope: rename-before.txt');
    await expect(verifyGitSnapshotScope(cwd, base.commit, [...base.entries, entry('allowed.txt/child', 'bad')], ['allowed.txt'])).rejects.toThrow('outside the allowed scope: allowed.txt/child');
  });

  it('bounds untrusted result manifests before comparing them', async () => {
    const cwd = await repo();
    await addBaseFiles(cwd);
    const base = await snapshotGitCommit(cwd, commit(cwd));
    await expect(verifyGitSnapshotScope(cwd, base.commit, base.entries, ['.'], { maxEntries: 2 })).rejects.toThrow('result snapshot entry limit');
    await expect(verifyGitSnapshotScope(cwd, base.commit, [entry('large.bin', 'a'.repeat(32))], ['large.bin'], { maxBlobBytes: 8 })).rejects.toThrow('result snapshot blob size limit');
    await expect(verifyGitSnapshotScope(cwd, base.commit, [entry('a', '1234'), entry('b', '5678')], ['.'], { maxTotalBlobBytes: 7 })).rejects.toThrow('result snapshot byte limit');
  });

  it('requires a full pinned commit SHA and fails closed on submodules and resource bounds', async () => {
    const cwd = await repo();
    await addBaseFiles(cwd);
    const sha = commit(cwd);
    await expect(snapshotGitCommit(cwd, sha.slice(0, 8))).rejects.toThrow('full 40 or 64');
    await expect(snapshotGitCommit(cwd, sha, { maxEntries: 2 })).rejects.toThrow('entry limit');
    const blob = git(cwd, 'rev-parse', 'HEAD:modified.txt');
    git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${blob},nested-module`);
    git(cwd, 'commit', '-qm', 'add gitlink');
    await expect(snapshotGitCommit(cwd, commit(cwd))).rejects.toThrow('Submodules are not supported');
  });
});
