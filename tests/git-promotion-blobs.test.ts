import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { promoteSnapshotToGit } from '../src/git-promotion.js';
import { snapshotGitCommit } from '../src/git-workspace.js';
import type { SnapshotEntry } from '../src/workspace-snapshot.js';
import { gitSubcommand, installGitShim } from './fixtures/git-shim.js';

const directories: string[] = [];
const FIXED_ENV = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2020-01-02T03:04:05Z',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_DATE: '2020-01-02T03:04:05Z'
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...FIXED_ENV } }).trim();
const entry = (path: string, bytes: string | Buffer, executable = false, kind: 'file' | 'symlink' = 'file'): SnapshotEntry => ({ path, kind, executable, contentBase64: Buffer.from(bytes).toString('base64') });

/** A deterministic base commit: the same Git objects on every machine, so result commit ids can be pinned. */
async function fixture(unchangedFiles = 40) {
  const cwd = await mkdtemp(join(tmpdir(), 'foreman-git-promotion-blobs-'));
  directories.push(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  const put = async (path: string, content: string | Buffer, executable = false) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
    await chmod(join(cwd, path), executable ? 0o755 : 0o644);
  };
  await put('README.md', 'before\n');
  await put('docs/guide.md', '# guide\n');
  await put('src/a.ts', 'export const a = 1;\n');
  await put('src/b.ts', 'export const b = 2;\n');
  await put('src/c.ts', 'export const c = 3;\n');
  await put('run.sh', '#!/bin/sh\necho run\n', true);
  await put('obsolete.txt', 'remove me\n');
  await put('empty.txt', '');
  await put('blob.bin', Buffer.from([0, 255, 254, 0, 10, 13]));
  await put('ünï/файл.txt', 'unicode before\n');
  await put('to-symlink.txt', 'README.md');
  await put('dup1.txt', 'same\n');
  await put('dup2.txt', 'same\n');
  await symlink('old-target', join(cwd, 'link'));
  await symlink('README.md', join(cwd, 'stable-link'));
  for (let i = 0; i < unchangedFiles; i++) await put(`many/file-${String(i).padStart(3, '0')}.txt`, `unchanged ${i}\n`, i % 9 === 0);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'pinned base');
  const base = git(cwd, 'rev-parse', 'HEAD');
  const original = (await snapshotGitCommit(cwd, base)).entries;
  return { cwd, base, original };
}

/** A worker result touching every reuse/hash case: unchanged, modified, mode-only, type change, add, delete, rename. */
function editedResult(original: readonly SnapshotEntry[], symlinkTarget = '/etc/hostname') {
  const result = original.filter(e => !['obsolete.txt', 'docs/guide.md'].includes(e.path)).map(e => ({ ...e }));
  const put = (next: SnapshotEntry) => { const i = result.findIndex(e => e.path === next.path); if (i < 0) result.push(next); else result[i] = next; };
  put(entry('src/a.ts', 'export const a = 100;\n'));
  put(entry('src/b.ts', 'export const b = 2;\n', true));
  put(entry('run.sh', '#!/bin/sh\necho run\n', false));
  put(entry('ünï/файл.txt', 'unicode after\n'));
  put(entry('link', 'new-target', false, 'symlink'));
  put(entry('to-symlink.txt', 'README.md', false, 'symlink'));
  put(entry('docs/guide-renamed.md', '# guide\n'));
  put(entry('assets/new.bin', Buffer.from([0, 1, 2, 255, 254, 0])));
  put(entry('assets/new-copy.bin', Buffer.from([0, 1, 2, 255, 254, 0])));
  put(entry('assets/copy-of-a.ts', 'export const a = 100;\n'));
  put(entry('assets/empty-new', ''));
  put(entry('assets/abs-link', symlinkTarget, false, 'symlink'));
  return result;
}
const SCOPE = ['src/', 'assets/', 'docs/', 'ünï/', 'run.sh', 'link', 'to-symlink.txt', 'obsolete.txt'];

/** The pre-optimisation algorithm, spelled out with plain Git plumbing: hash every entry, build a tree from a scratch index. */
async function referenceTree(cwd: string, entries: readonly SnapshotEntry[]): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'foreman-git-reference-'));
  directories.push(scratch);
  const indexFile = join(scratch, 'index');
  const records: Buffer[] = [];
  for (const e of entries) {
    const oid = execFileSync('git', ['-C', cwd, 'hash-object', '-w', '--no-filters', '--stdin'], { input: Buffer.from(e.contentBase64, 'base64') }).toString('ascii').trim();
    records.push(Buffer.from(`${e.kind === 'symlink' ? '120000' : e.executable ? '100755' : '100644'} ${oid}\t${e.path}\0`, 'utf8'));
  }
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  execFileSync('git', ['-C', cwd, 'update-index', '-z', '--index-info'], { input: Buffer.concat(records), env });
  return execFileSync('git', ['-C', cwd, 'write-tree'], { env }).toString('ascii').trim();
}

/** Run `fn` with every spawned `git` logged, so a test can count the Git processes Foreman starts. */
async function withGitLog<T>(fn: () => Promise<T>): Promise<{ value: T; calls: string[] }> {
  const shim = await installGitShim();
  try {
    const value = await fn();
    return { value, calls: await shim.calls() };
  } finally {
    await shim.restore();
  }
}
const subcommand = gitSubcommand;

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('promotion reuses base blobs and hashes only what changed', () => {
  // Produced by the implementation before the blob-reuse change (one `hash-object --stdin` per entry, every
  // file materialised in the worktree). Author, committer and dates are pinned, so any drift in the tree
  // (an oid, a mode, an ordering) or in the commit format changes this id.
  const GOLDEN_COMMIT = '374232c58445d2e48d3718d5b59c657b11de8f1e';
  const GOLDEN_TREE = '0d323c0a41e06274db4a7f176ca2cb3329b7eda4';

  it('produces exactly the commit and tree the per-entry-hashing implementation produced', async () => {
    const f = await fixture();
    expect(f.base).toBe('91687bf726957a325d634120f9bb43143c849e26');
    const result = editedResult(f.original);
    const promoted = await promoteSnapshotToGit({ repoPath: f.cwd, pinnedBaseCommit: f.base, entries: result, allowedScope: SCOPE, operationId: 'golden-operation' });
    expect(promoted).toMatchObject({ status: 'applied', parent: f.base });
    expect({ commit: promoted.commit, tree: promoted.tree }).toEqual({ commit: GOLDEN_COMMIT, tree: GOLDEN_TREE });
  });

  it('builds the same tree as hashing every entry and indexing it, and reproduces on retry', async () => {
    const f = await fixture(12);
    const result = editedResult(f.original);
    const input = { repoPath: f.cwd, pinnedBaseCommit: f.base, entries: result, allowedScope: SCOPE, operationId: 'reference-operation' };
    const first = await promoteSnapshotToGit(input);
    expect(first.tree).toBe(await referenceTree(f.cwd, result));
    expect(await promoteSnapshotToGit(input)).toEqual(first);
    // A different operation id only changes the message, never the tree.
    const other = await promoteSnapshotToGit({ ...input, operationId: 'another-operation' });
    expect(other.tree).toBe(first.tree);
    expect(other.commit).not.toBe(first.commit);
    const roundTrip = (await snapshotGitCommit(f.cwd, first.commit)).entries;
    expect(roundTrip.map(e => e.path).sort()).toEqual(result.map(e => e.path).sort());
    expect(git(f.cwd, 'rev-list', '--parents', '-n', '1', first.commit)).toBe(`${first.commit} ${f.base}`);
  });

  it('reuses the base blob ids of unchanged entries and stores changed symlinks as their literal target bytes', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'foreman-git-link-target-'));
    directories.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'bytes that must never be followed\n');
    const f = await fixture(8);
    for (const target of [join(outside, 'secret.txt'), outside, '../../missing/target', 'ünï/файл.txt']) {
      const result = editedResult(f.original, target);
      const promoted = await promoteSnapshotToGit({ repoPath: f.cwd, pinnedBaseCommit: f.base, entries: result, allowedScope: SCOPE, operationId: `symlink-${target}` });
      expect(git(f.cwd, 'ls-tree', promoted.commit, 'assets/abs-link').startsWith('120000 blob ')).toBe(true);
      expect(execFileSync('git', ['-C', f.cwd, 'cat-file', 'blob', `${promoted.commit}:assets/abs-link`]).toString('utf8')).toBe(target);
    }
    const promoted = await promoteSnapshotToGit({ repoPath: f.cwd, pinnedBaseCommit: f.base, entries: editedResult(f.original), allowedScope: SCOPE, operationId: 'unchanged-ids' });
    for (const path of ['README.md', 'src/c.ts', 'empty.txt', 'blob.bin', 'stable-link', 'dup1.txt', 'dup2.txt', 'many/file-000.txt', 'many/file-007.txt']) {
      expect(git(f.cwd, 'rev-parse', `${promoted.commit}:${path}`)).toBe(git(f.cwd, 'rev-parse', `${f.base}:${path}`));
    }
    // A mode-only change keeps the blob and changes only the tree entry mode.
    expect(git(f.cwd, 'rev-parse', `${promoted.commit}:src/b.ts`)).toBe(git(f.cwd, 'rev-parse', `${f.base}:src/b.ts`));
    expect(git(f.cwd, 'ls-tree', promoted.commit, 'src/b.ts')).toMatch(/^100755 blob /);
    expect(git(f.cwd, 'ls-tree', promoted.commit, 'run.sh')).toMatch(/^100644 blob /);
    // A regular file turned into a symlink with the same bytes shares the blob but not the mode.
    expect(git(f.cwd, 'rev-parse', `${promoted.commit}:to-symlink.txt`)).toBe(git(f.cwd, 'rev-parse', `${f.base}:to-symlink.txt`));
    expect(git(f.cwd, 'ls-tree', promoted.commit, 'to-symlink.txt')).toMatch(/^120000 blob /);
  }, 30_000);

  it('spawns a bounded number of Git processes regardless of how many files the repository has', async () => {
    const small = await fixture(4);
    const large = await fixture(160);
    const run = (f: Awaited<ReturnType<typeof fixture>>, operationId: string) => withGitLog(() => promoteSnapshotToGit({ repoPath: f.cwd, pinnedBaseCommit: f.base, entries: editedResult(f.original), allowedScope: SCOPE, operationId }));
    const a = await run(small, 'spawn-count-small');
    const b = await run(large, 'spawn-count-large');
    expect(b.calls.length).toBe(a.calls.length);
    expect(b.calls.filter(call => subcommand(call) === 'hash-object')).toHaveLength(1);
    // Two full snapshots (pinned base and the result commit) each use exactly one batch reader.
    expect(b.calls.filter(call => subcommand(call) === 'cat-file' && call.includes('--batch'))).toHaveLength(2);
    expect(b.calls.filter(call => subcommand(call) === 'cat-file' && / (?:-s|blob) /.test(call))).toHaveLength(0);
    expect(b.calls.length).toBeLessThan(30);

    // Nothing changed: no object needs hashing at all.
    const same = await withGitLog(() => promoteSnapshotToGit({ repoPath: large.cwd, pinnedBaseCommit: large.base, entries: large.original, allowedScope: ['README.md'], operationId: 'spawn-count-unchanged' }));
    expect(same.calls.filter(call => subcommand(call) === 'hash-object')).toHaveLength(0);
    expect(same.value.tree).toBe(git(large.cwd, 'rev-parse', `${large.base}^{tree}`));
  }, 60_000);
});

describe('promotion still validates the whole manifest before creating anything', () => {
  const rejected = async (f: Awaited<ReturnType<typeof fixture>>, entries: SnapshotEntry[], scope: string[], message: RegExp | string) => {
    await expect(promoteSnapshotToGit({ repoPath: f.cwd, pinnedBaseCommit: f.base, entries, allowedScope: scope, operationId: 'validation', destinationBranch: 'refs/heads/foreman/results/validation' })).rejects.toThrow(message);
    expect(() => git(f.cwd, 'show-ref', '--verify', 'refs/heads/foreman/results/validation')).toThrow();
    expect(git(f.cwd, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.base);
  };

  it('rejects file/directory path conflicts and unusable symlink targets', async () => {
    const f = await fixture(3);
    await rejected(f, [...f.original, entry('README.md/child', 'x')], ['README.md/child'], 'file/directory path conflict');
    await rejected(f, [...f.original, entry('stable-link/child', 'x')], ['stable-link/child'], 'file/directory path conflict');
    await rejected(f, [...f.original.filter(e => e.path !== 'link'), entry('link', 'bad\0target', false, 'symlink')], ['link'], 'Invalid symlink target: link');
  });

  it('rejects unsafe paths and out-of-scope changes', async () => {
    const f = await fixture(3);
    await rejected(f, [...f.original, entry('../escape.txt', 'x')], ['src/'], 'Unsafe snapshot path');
    await rejected(f, [...f.original, entry('src/../../escape.txt', 'x')], ['src/'], 'Unsafe snapshot path');
    await rejected(f, [...f.original, entry('.git/config', 'x')], ['src/'], 'Unsafe snapshot path');
    await rejected(f, [...f.original, entry('elsewhere/new.txt', 'x')], ['src/'], 'outside the allowed scope');
  });
});
