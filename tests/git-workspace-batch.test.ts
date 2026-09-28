import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitBatchBlobParser, snapshotGitCommit, type GitBlobRequest } from '../src/git-workspace.js';
import type { SnapshotEntry } from '../src/workspace-snapshot.js';
import { gitSubcommand, installGitShim, processIsGone } from './fixtures/git-shim.js';

const directories: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitBytes = (cwd: string, args: string[], input?: Buffer) => execFileSync('git', ['-C', cwd, ...args], { input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const blobId = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

async function emptyRepo() {
  const cwd = await mkdtemp(join(tmpdir(), 'foreman-git-batch-'));
  directories.push(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'Fixture');
  git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  return cwd;
}

/** Deterministic, incompressible-looking bytes. */
function pseudoRandom(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; out[i] = state >>> 24; }
  return out;
}

const HELLO = Buffer.from('hello\n');
// Content that imitates `git cat-file --batch` framing: headers, `missing` lines and stray blank lines.
const LOOKALIKE = Buffer.concat([
  Buffer.from('first line\n'),
  Buffer.from(`${blobId(HELLO)} blob 6\nhello\n\n`),
  Buffer.from(`${'0'.repeat(40)} missing\n`),
  Buffer.from(`${'a'.repeat(40)} blob 999999999\n`),
  Buffer.from(`${blobId(HELLO)} tree 6\n`),
  Buffer.from('\n\n\r\n\r\n\n')
]);

/** A repository covering every kind of entry the snapshot has to reproduce exactly. */
async function richFixture() {
  const cwd = await emptyRepo();
  const put = async (path: string, content: Buffer | string, executable = false) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
    await chmod(join(cwd, path), executable ? 0o755 : 0o644);
  };
  const link = async (path: string, target: string) => { await mkdir(dirname(join(cwd, path)), { recursive: true }); await symlink(target, join(cwd, path)); };
  await put('README.md', '# Readme\n');
  await put('bin/run.sh', '#!/bin/sh\necho run\n', true);
  await put('bin/native', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0]), pseudoRandom(300, 7)]), true);
  await put('empty.txt', '');
  await put('docs/empty/.keep', '');
  await put('blob.bin', Buffer.from([0, 255, 254, 128, 0xc3, 0x28, 0xf0, 0x28, 0x8c, 0xbc, 0, 0, 10, 13, 10]));
  await put('crlf.txt', 'one\r\ntwo\r\n\r\n');
  await put('no-trailing-newline.txt', 'abc');
  await put('big.bin', pseudoRandom(1024 * 1024 + 4321, 99));
  await put('big-text.txt', 'a line of text that repeats\n'.repeat(60_000));
  await put('lookalike.txt', LOOKALIKE);
  await put('lookalike-tail.txt', Buffer.concat([Buffer.from('tail\n'), Buffer.from(`${blobId(HELLO)} blob 6\nhello\n`)]));
  await put('ünïcödé/файл.txt', 'unicode directory and file names\n');
  await put('日本語/ファイル.md', '# 日本語\n');
  await put('emoji-🚀.txt', 'rocket\n');
  await put('with space/inner file.txt', 'space\n');
  await put('-leading-dash.txt', 'dash\n');
  await put('tab\tname.txt', 'tab in the name\n');
  await put('new\nline.txt', 'newline in the name\n');
  await put('deep/a/b/c/d/e/f/leaf.txt', 'deep\n');
  // The same blob bytes appear under several paths and modes (deduplicated on read, but reported per path).
  await put('dup/one.txt', 'same bytes\n');
  await put('dup/two.txt', 'same bytes\n');
  await put('dup/exec.sh', 'same bytes\n', true);
  await put('dup/target-as-file.txt', 'bin/run.sh');
  await link('link-to-run', 'bin/run.sh');
  await link('dup/link-same-bytes', 'bin/run.sh');
  await link('docs/up-link', '../README.md');
  await link('dangling', 'does/not/exist');
  await link('unicode-link', 'ünïcödé/файл.txt');
  await link('absolute-link', '/etc/hostname');
  for (let i = 0; i < 150; i++) await put(`many/file-${String(i).padStart(3, '0')}.txt`, `small file ${i}\n${i % 7 === 0 ? '' : 'x'.repeat(i * 13)}`, i % 11 === 0);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'rich fixture');
  return { cwd, commit: git(cwd, 'rev-parse', 'HEAD') };
}

/** The slow, obviously-correct oracle: one `ls-tree` plus one `cat-file blob` process per entry. */
function referenceSnapshot(cwd: string, commit: string) {
  const listing = gitBytes(cwd, ['ls-tree', '-rz', '--full-tree', commit]);
  const entries: SnapshotEntry[] = [];
  const objectIds: string[] = [];
  let totalBytes = 0;
  for (const record of listing.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [mode, type, objectId] = record.slice(0, tab).split(' ') as [string, string, string];
    expect(type).toBe('blob');
    const bytes = gitBytes(cwd, ['cat-file', 'blob', objectId]);
    totalBytes += bytes.length;
    objectIds.push(objectId);
    entries.push({ path: record.slice(tab + 1), kind: mode === '120000' ? 'symlink' : 'file', contentBase64: bytes.toString('base64'), executable: mode === '100755' });
  }
  return { entries, objectIds, totalBytes };
}

/** Commit an arbitrary raw tree (bypassing fsck) to reach states that `git add` refuses to create. */
function craftedCommit(cwd: string, entries: { mode: string; name: Buffer; oid: string }[]): string {
  const raw = Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(`${e.mode} `), e.name, Buffer.from([0]), Buffer.from(e.oid, 'hex')])));
  const tree = gitBytes(cwd, ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], raw).toString('ascii').trim();
  return git(cwd, 'commit-tree', tree, '-m', 'crafted');
}
const writeBlob = (cwd: string, bytes: Buffer) => gitBytes(cwd, ['hash-object', '-w', '--stdin'], bytes).toString('ascii').trim();

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('snapshotGitCommit output parity with per-object Git queries', () => {
  it('returns byte-for-byte, order-for-order the entries obtained one object at a time', async () => {
    const { cwd, commit } = await richFixture();
    const expected = referenceSnapshot(cwd, commit);
    const actual = await snapshotGitCommit(cwd, commit);

    expect(actual.commit).toBe(commit);
    expect(actual.entries.length).toBe(expected.entries.length);
    expect(actual.entries.length).toBeGreaterThan(150);
    expect(actual.treeBytes).toBe(expected.totalBytes);
    // JSON equality also pins property order, so the serialized manifest is unchanged.
    expect(JSON.stringify(actual.entries)).toBe(JSON.stringify(expected.entries));
    expect(actual.entries).toEqual(expected.entries);
    expect(Object.keys(actual)).toEqual(['commit', 'entries', 'treeBytes']);

    // Spot-check the awkward entries against the bytes on disk as well as against Git.
    const byPath = new Map(actual.entries.map(e => [e.path, e]));
    const bytesOf = (path: string) => Buffer.from(byPath.get(path)!.contentBase64, 'base64');
    expect(bytesOf('big.bin')).toEqual(await readFile(join(cwd, 'big.bin')));
    expect(bytesOf('big.bin').length).toBeGreaterThan(1024 * 1024);
    expect(bytesOf('lookalike.txt')).toEqual(LOOKALIKE);
    expect(bytesOf('blob.bin')).toEqual(Buffer.from([0, 255, 254, 128, 0xc3, 0x28, 0xf0, 0x28, 0x8c, 0xbc, 0, 0, 10, 13, 10]));
    expect(bytesOf('empty.txt').length).toBe(0);
    expect(byPath.get('bin/run.sh')).toMatchObject({ kind: 'file', executable: true });
    expect(byPath.get('dup/exec.sh')).toMatchObject({ kind: 'file', executable: true });
    expect(byPath.get('dup/one.txt')).toMatchObject({ kind: 'file', executable: false });
    expect(byPath.get('dup/link-same-bytes')).toMatchObject({ kind: 'symlink', executable: false });
    expect(bytesOf('dup/link-same-bytes').toString()).toBe('bin/run.sh');
    expect(bytesOf('dup/target-as-file.txt').toString()).toBe('bin/run.sh');
    expect(byPath.get('dup/target-as-file.txt')!.contentBase64).toBe(byPath.get('dup/link-same-bytes')!.contentBase64);
    expect(byPath.has('tab\tname.txt')).toBe(true);
    expect(byPath.has('new\nline.txt')).toBe(true);
    expect(byPath.has('ünïcödé/файл.txt')).toBe(true);
    expect(byPath.has('日本語/ファイル.md')).toBe(true);
    expect(byPath.has('emoji-🚀.txt')).toBe(true);
    expect(byPath.get('unicode-link')).toMatchObject({ kind: 'symlink', contentBase64: Buffer.from('ünïcödé/файл.txt').toString('base64') });
  }, 120_000);

  it('accepts an upper-case commit SHA and an empty tree', async () => {
    const cwd = await emptyRepo();
    const emptyTree = git(cwd, 'hash-object', '-t', 'tree', '-w', '--stdin');
    const commit = git(cwd, 'commit-tree', emptyTree, '-m', 'empty');
    expect(await snapshotGitCommit(cwd, commit.toUpperCase())).toEqual({ commit, entries: [], treeBytes: 0 });
  });
});

describe('snapshotGitCommit keeps every fail-closed check', () => {
  it('rejects an oversized blob or total before reading any content', async () => {
    const { cwd, commit } = await richFixture();
    await expect(snapshotGitCommit(cwd, commit, { maxBlobBytes: 1024 * 1024 })).rejects.toThrow('Git snapshot blob size limit exceeded: big-text.txt');
    await expect(snapshotGitCommit(cwd, commit, { maxTotalBlobBytes: 2 * 1024 * 1024 })).rejects.toThrow('Git snapshot blob size limit exceeded');
    await expect(snapshotGitCommit(cwd, commit, { maxEntries: 10 })).rejects.toThrow('Git snapshot entry limit exceeded');
    await expect(snapshotGitCommit(cwd, commit, { maxTreeBytes: 64 })).rejects.toThrow('output limit exceeded');
    await expect(snapshotGitCommit(cwd, commit, { maxBlobBytes: 0 })).rejects.toThrow('Invalid Git snapshot limit: maxBlobBytes');
    await expect(snapshotGitCommit(cwd, 'f'.repeat(40))).rejects.toThrow();
  }, 60_000);

  it('rejects a non-UTF-8 symlink target and an empty symlink target', async () => {
    const cwd = await emptyRepo();
    const bad = craftedCommit(cwd, [{ mode: '120000', name: Buffer.from('bad-link'), oid: writeBlob(cwd, Buffer.from([0x66, 0xff, 0x6f])) }]);
    await expect(snapshotGitCommit(cwd, bad)).rejects.toThrow('Non-UTF-8 symlink target: bad-link');
    const empty = craftedCommit(cwd, [{ mode: '120000', name: Buffer.from('empty-link'), oid: writeBlob(cwd, Buffer.alloc(0)) }]);
    await expect(snapshotGitCommit(cwd, empty)).rejects.toThrow('Empty symlink target: empty-link');
    // The same bytes are fine as a regular file, so the check depends on the mode, not on the shared blob.
    const shared = writeBlob(cwd, Buffer.from([0x66, 0xff, 0x6f]));
    const both = craftedCommit(cwd, [{ mode: '100644', name: Buffer.from('a-file'), oid: shared }, { mode: '120000', name: Buffer.from('b-link'), oid: shared }]);
    await expect(snapshotGitCommit(cwd, both)).rejects.toThrow('Non-UTF-8 symlink target: b-link');
    const fileOnly = craftedCommit(cwd, [{ mode: '100644', name: Buffer.from('a-file'), oid: shared }]);
    expect((await snapshotGitCommit(cwd, fileOnly)).entries).toEqual([{ path: 'a-file', kind: 'file', contentBase64: Buffer.from([0x66, 0xff, 0x6f]).toString('base64'), executable: false }]);
  });

  it('rejects non-UTF-8 paths, unsafe paths, submodules and missing objects', async () => {
    const cwd = await emptyRepo();
    const blob = writeBlob(cwd, Buffer.from('x'));
    await expect(snapshotGitCommit(cwd, craftedCommit(cwd, [{ mode: '100644', name: Buffer.from([0x61, 0xff]), oid: blob }]))).rejects.toThrow('non-UTF-8 path');
    await expect(snapshotGitCommit(cwd, craftedCommit(cwd, [{ mode: '100644', name: Buffer.from('back\\slash'), oid: blob }]))).rejects.toThrow('Unsafe snapshot path: back\\slash');
    await expect(snapshotGitCommit(cwd, craftedCommit(cwd, [{ mode: '160000', name: Buffer.from('module'), oid: blob }]))).rejects.toThrow('Submodules are not supported: module');
    await expect(snapshotGitCommit(cwd, craftedCommit(cwd, [{ mode: '100644', name: Buffer.from('gone'), oid: 'ab'.repeat(20) }]))).rejects.toThrow();
  });

  it('rejects an object that is not a blob and reads legacy file modes the way Git canonicalises them', async () => {
    const cwd = await emptyRepo();
    const blob = writeBlob(cwd, Buffer.from('x'));
    const subtree = gitBytes(cwd, ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], Buffer.concat([Buffer.from('100644 inner\0'), Buffer.from(blob, 'hex')])).toString('ascii').trim();
    // A tree object listed with a regular-file mode: ls-tree reports a blob, cat-file knows better.
    await expect(snapshotGitCommit(cwd, craftedCommit(cwd, [{ mode: '100644', name: Buffer.from('fake-file'), oid: subtree }]))).rejects.toThrow();
    // `ls-tree` never prints a mode other than 100644, 100755, 120000 or 160000, so the mode allow-list is a
    // defence in depth. A legacy 100664 entry is reported by Git as an ordinary 100644 file.
    const legacy = craftedCommit(cwd, [{ mode: '100664', name: Buffer.from('legacy-mode'), oid: blob }]);
    expect(git(cwd, 'ls-tree', legacy)).toBe(`100644 blob ${blob}\tlegacy-mode`);
    expect((await snapshotGitCommit(cwd, legacy)).entries).toEqual([{ path: 'legacy-mode', kind: 'file', contentBase64: Buffer.from('x').toString('base64'), executable: false }]);
  });
});

describe('git cat-file --batch stream parser', () => {
  const OID = 'a'.repeat(40);
  const request = (objectId: string, size: number, path = 'file.txt'): GitBlobRequest => ({ objectId, size, path });
  function parse(requests: GitBlobRequest[], chunks: Buffer[]) {
    const blobs: Buffer[] = [];
    const parser = createGitBatchBlobParser(requests, (index, bytes) => { blobs[index] = Buffer.from(bytes); });
    for (const chunk of chunks) parser.push(chunk);
    parser.finish();
    return blobs;
  }
  const split = (stream: Buffer, sizeAt: (n: number) => number) => {
    const chunks: Buffer[] = [];
    for (let offset = 0, n = 0; offset < stream.length; n++) { const size = Math.max(1, sizeAt(n)); chunks.push(stream.subarray(offset, offset + size)); offset += size; }
    return chunks;
  };

  it('reassembles real Git output however the byte stream is chunked', async () => {
    const cwd = await emptyRepo();
    const contents = [HELLO, Buffer.alloc(0), LOOKALIKE, pseudoRandom(70_000, 5), Buffer.from('\n'), Buffer.from('\n\n'), Buffer.from([0x0a, 0x0d, 0x0a]), pseudoRandom(3, 1), Buffer.from(`${blobId(HELLO)} blob 6\nhello\n`)];
    const requests = contents.map((bytes, i) => request(writeBlob(cwd, bytes), bytes.length, `blob-${i}`));
    const stream = gitBytes(cwd, ['cat-file', '--batch'], Buffer.from(requests.map(r => `${r.objectId}\n`).join('')));
    let state = 12345;
    const random = () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state >>> 16; };
    const strategies: Array<[string, (n: number) => number]> = [
      ['one byte at a time', () => 1], ['two bytes', () => 2], ['three bytes', () => 3], ['seven bytes', () => 7], ['64 bytes', () => 64],
      ['4093 bytes', () => 4093], ['64 KiB', () => 65_536], ['whole stream', () => stream.length], ['random 1-200', () => 1 + (random() % 200)], ['random 1-5000', () => 1 + (random() % 5000)]
    ];
    for (const [name, sizeAt] of strategies) {
      const blobs = parse(requests, split(stream, sizeAt));
      expect(blobs.length, name).toBe(contents.length);
      contents.forEach((bytes, i) => expect(blobs[i]!.equals(bytes), `${name}: blob ${i}`).toBe(true));
    }
  });

  it('rejects missing objects, wrong objects, wrong types and wrong sizes', () => {
    const one = [request(OID, 3)];
    const expectRejected = (text: string, message: string | RegExp, requests = one) => expect(() => parse(requests, [Buffer.from(text)]), text).toThrow(message);
    expect(parse(one, [Buffer.from(`${OID} blob 3\nabc\n`)])[0]!.toString()).toBe('abc');
    expectRejected(`${OID} missing\n`, 'Git blob is missing: file.txt');
    expectRejected(`${'b'.repeat(40)} blob 3\nabc\n`, 'Unexpected Git cat-file response for file.txt');
    expectRejected(`${OID} tree 3\nabc\n`, 'Unsupported Git object type tree: file.txt');
    expectRejected(`${OID} commit 3\nabc\n`, 'Unsupported Git object type commit: file.txt');
    expectRejected(`${OID} blob 4\nabcd\n`, 'Git blob size changed or was truncated: file.txt');
    expectRejected(`${OID} blob 2\nab\n`, 'Git blob size changed or was truncated: file.txt');
    expectRejected(`${OID} blob x\n`, 'Invalid Git blob size for file.txt');
    expectRejected(`${OID} blob -3\n`, 'Invalid Git blob size for file.txt');
    expectRejected(`${OID} blob 3 extra\nabc\n`, 'Malformed Git cat-file response for file.txt');
    expectRejected(`${OID}\n`, 'Malformed Git cat-file response for file.txt');
    expectRejected(`${OID} blob 3\nabcX`, 'Malformed Git cat-file response for file.txt');
    expectRejected(`${OID} blob 3\nabc\r`, 'Malformed Git cat-file response for file.txt');
    expectRejected(`${OID} blob 3\nabc\nextra`, 'more output than was requested');
    expectRejected(`${OID} blob 3\nabc\n${OID} blob 3\nabc\n`, 'more output than was requested');
    expectRejected('x'.repeat(2000), 'Malformed Git cat-file response for file.txt');
    expectRejected(`${OID} blob 0\nX`, 'Malformed Git cat-file response for file.txt', [request(OID, 0)]);
    // A header split across chunks is still checked in full.
    expect(() => parse(one, [Buffer.from(`${OID} bl`), Buffer.from('ob 4\nabcd\n')])).toThrow('size changed');
  });

  it('reports a stream that ends early at every possible cut point and propagates consumer errors', () => {
    const second = 'c'.repeat(40);
    const requests = [request(OID, 3, 'a.txt'), request(second, 0, 'empty.txt'), request('d'.repeat(40), 2, 'b.txt')];
    const stream = Buffer.from(`${OID} blob 3\nabc\n${second} blob 0\n\n${'d'.repeat(40)} blob 2\nhi\n`);
    expect(parse(requests, [stream]).map(b => b.toString())).toEqual(['abc', '', 'hi']);
    for (let cut = 0; cut < stream.length; cut++) expect(() => parse(requests, [stream.subarray(0, cut)]), `cut at ${cut}`).toThrow('Git cat-file output was truncated');
    const failing = createGitBatchBlobParser(requests, () => { throw new Error('consumer refused'); });
    expect(() => failing.push(stream)).toThrow('consumer refused');
  });
});

describe('snapshotGitCommit process handling', () => {
  async function tenByteRepo() {
    const cwd = await emptyRepo();
    await writeFile(join(cwd, 'file.txt'), 'abcdefghij');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'one file');
    return { cwd, commit: git(cwd, 'rev-parse', 'HEAD') };
  }
  /** Run a snapshot while `git cat-file --batch` is replaced by `onBatch`, then check the process is gone. */
  async function withBatchBehaviour(onBatch: string, limits: { commandTimeoutMs?: number } = {}) {
    const { cwd, commit } = await tenByteRepo();
    const shim = await installGitShim({ onBatch });
    try {
      const outcome = await snapshotGitCommit(cwd, commit, limits).then(() => undefined, (error: Error) => error);
      const pid = await shim.batchPid();
      expect(pid, 'batch process was started').toBeGreaterThan(0);
      return { error: outcome, gone: await processIsGone(pid!) };
    } finally {
      await shim.restore();
    }
  }

  it('enforces commandTimeoutMs on the whole batch and kills a hung process', async () => {
    const started = Date.now();
    const { error, gone } = await withBatchBehaviour('exec sleep 30', { commandTimeoutMs: 400 });
    expect(error?.message).toBe('Git command timed out after 400ms');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(gone).toBe(true);
  });

  it('kills the process on a malformed, mismatched, missing or wrong-typed response', async () => {
    for (const [onBatch, message] of [
      ["printf 'garbage\\n'; exec sleep 30", 'Unexpected Git cat-file response for file.txt'],
      ['read -r oid; printf \'%s blob 11\\nabcdefghijk\\n\' "$oid"; exec sleep 30', 'Git blob size changed or was truncated: file.txt'],
      ['read -r oid; printf \'%s missing\\n\' "$oid"; exec sleep 30', 'Git blob is missing: file.txt'],
      ['read -r oid; printf \'%s tree 10\\n0123456789\\n\' "$oid"; exec sleep 30', 'Unsupported Git object type tree: file.txt'],
      ['read -r oid; printf \'%s blob 10\\nabcdefghijX\' "$oid"; exec sleep 30', 'Malformed Git cat-file response for file.txt']
    ] as const) {
      const { error, gone } = await withBatchBehaviour(onBatch);
      expect(error?.message, onBatch).toBe(message);
      expect(gone, `${onBatch}: process killed`).toBe(true);
    }
  }, 60_000);

  it('reports a crashing or truncating cat-file, including one that exits without reading its input', async () => {
    expect((await withBatchBehaviour("echo 'fatal: boom' >&2; exit 128")).error?.message).toBe('git cat-file failed (128): fatal: boom\n');
    expect((await withBatchBehaviour('read -r oid; printf \'%s blob 10\\nabc\' "$oid"; exit 0')).error?.message).toBe('Git cat-file output was truncated');
    expect((await withBatchBehaviour('exit 0')).error?.message).toBe('Git cat-file output was truncated');
  });

  it('uses a constant number of Git processes, and requests each distinct blob once', async () => {
    const cwd = await emptyRepo();
    for (let i = 0; i < 120; i++) await writeFile(join(cwd, `empty-${i}.txt`), '');
    for (let i = 0; i < 80; i++) await writeFile(join(cwd, `same-${i}.txt`), 'shared\n');
    for (let i = 0; i < 100; i++) await writeFile(join(cwd, `unique-${i}.txt`), `unique ${i}\n`);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-qm', 'three hundred files');
    const commit = git(cwd, 'rev-parse', 'HEAD');
    const shim = await installGitShim({ recordBatchInput: true });
    try {
      const snapshot = await snapshotGitCommit(cwd, commit);
      expect(snapshot.entries).toHaveLength(300);
      const calls = await shim.calls();
      expect(calls.map(gitSubcommand)).toEqual(['rev-parse', 'ls-tree', 'cat-file']);
      expect(calls[2]).toMatch(/cat-file --batch$/);
      // 100 unique blobs + one shared + one empty, not 300.
      expect((await shim.batchInput()).split('\n').filter(Boolean)).toHaveLength(102);
    } finally {
      await shim.restore();
    }
    const failing = await installGitShim();
    try {
      await expect(snapshotGitCommit(cwd, commit, { maxBlobBytes: 5 })).rejects.toThrow('Git snapshot blob size limit exceeded');
      // The size limit is enforced from the listing: no blob is ever requested.
      expect((await failing.calls()).map(gitSubcommand)).toEqual(['rev-parse', 'ls-tree']);
    } finally {
      await failing.restore();
    }
  });
});
