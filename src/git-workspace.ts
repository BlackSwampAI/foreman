import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { compareCompleteSnapshots, type SnapshotChange, type SnapshotEntry } from './workspace-snapshot.js';

export interface GitSnapshotLimits {
  commandTimeoutMs?: number;
  maxTreeBytes?: number;
  maxEntries?: number;
  maxBlobBytes?: number;
  maxTotalBlobBytes?: number;
}

export interface GitSnapshotResult {
  commit: string;
  entries: SnapshotEntry[];
  treeBytes: number;
}

export interface GitScopeVerification extends GitSnapshotResult {
  changes: SnapshotChange[];
  allowedScope: string[];
  scopeVerified: true;
}

/** The blob object id of every snapshot entry, in the same order as `entries`. */
export interface GitSnapshotObjectIds {
  objectIds: string[];
}

/** One blob to read from `git cat-file --batch`: its object id, the size `ls-tree -l` reported, and a path for error messages. */
export interface GitBlobRequest {
  objectId: string;
  size: number;
  path: string;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const decoder = new TextDecoder('utf-8', { fatal: true });
const DEFAULTS = {
  commandTimeoutMs: 15_000,
  maxTreeBytes: 32 * 1024 * 1024,
  maxEntries: 100_000,
  maxBlobBytes: 16 * 1024 * 1024,
  maxTotalBlobBytes: 256 * 1024 * 1024
};

/** Read every file and symlink from one immutable, full Git commit. */
export async function snapshotGitCommit(repoPath: string, fullCommitSha: string, limits: GitSnapshotLimits = {}): Promise<GitSnapshotResult> {
  const { commit, entries, treeBytes } = await snapshotGitCommitWithObjectIds(repoPath, fullCommitSha, limits);
  return { commit, entries, treeBytes };
}

/**
 * Like {@link snapshotGitCommit}, and also reports the blob object id of every entry so that a caller building a
 * child commit can reuse unchanged blobs. Git is spawned a constant number of times however large the tree is:
 * `ls-tree -l` lists every entry with its size, so every limit is enforced before any content is read, and one
 * `cat-file --batch` process then streams the distinct blobs.
 */
export async function snapshotGitCommitWithObjectIds(repoPath: string, fullCommitSha: string, limits: GitSnapshotLimits = {}): Promise<GitSnapshotResult & GitSnapshotObjectIds> {
  if (!SHA.test(fullCommitSha)) throw new Error('A full 40 or 64 character commit SHA is required');
  const bound = { ...DEFAULTS, ...limits };
  for (const [key, value] of Object.entries(bound)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid Git snapshot limit: ${key}`);
  const commit = fullCommitSha.toLowerCase();
  const resolved = (await git(repoPath, ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`], bound.commandTimeoutMs, 256)).toString('ascii').trim().toLowerCase();
  if (resolved !== commit) throw new Error('Git did not resolve the requested full commit SHA exactly');
  // `-l` adds a size column of at least 8 bytes per entry, which the maxTreeBytes output cap now also covers.
  const tree = await git(repoPath, ['ls-tree', '-rlz', '--full-tree', commit], bound.commandTimeoutMs, bound.maxTreeBytes);
  const records = parseTree(tree, bound.maxEntries);
  // Validate every record and enforce the size limits from the listing alone, before any content is read.
  // Identical blobs (for example many empty files) are requested once and shared between their paths.
  const requests: GitBlobRequest[] = [];
  const symlinkPaths: (string | undefined)[] = [];
  const requestByObject = new Map<string, number>();
  let totalBytes = 0;
  for (const record of records) {
    if (record.mode === '160000' || record.type === 'commit') throw new Error(`Submodules are not supported: ${record.path}`);
    if (record.mode !== '100644' && record.mode !== '100755' && record.mode !== '120000') throw new Error(`Unsupported Git tree mode ${record.mode}: ${record.path}`);
    if (record.type !== 'blob') throw new Error(`Unsupported Git object type ${record.type}: ${record.path}`);
    if (!/^\d+$/.test(record.size)) throw new Error(`Invalid Git blob size for ${record.path}`);
    const size = Number(record.size);
    if (!Number.isSafeInteger(size) || size > bound.maxBlobBytes || totalBytes + size > bound.maxTotalBlobBytes) throw new Error(`Git snapshot blob size limit exceeded: ${record.path}`);
    totalBytes += size;
    let request = requestByObject.get(record.objectId);
    if (request === undefined) {
      request = requests.push({ objectId: record.objectId, size, path: record.path }) - 1;
      requestByObject.set(record.objectId, request);
    } else if (requests[request]!.size !== size) throw new Error(`Git blob size changed or was truncated: ${record.path}`);
    if (record.mode === '120000' && symlinkPaths[request] === undefined) symlinkPaths[request] = record.path;
  }
  const contents: string[] = new Array(requests.length);
  if (requests.length) {
    await readBlobs(repoPath, requests, bound.commandTimeoutMs, (index, bytes) => {
      const symlinkPath = symlinkPaths[index];
      if (symlinkPath !== undefined) {
        try { decoder.decode(bytes); } catch { throw new Error(`Non-UTF-8 symlink target: ${symlinkPath}`); }
        if (!bytes.length) throw new Error(`Empty symlink target: ${symlinkPath}`);
      }
      contents[index] = bytes.toString('base64');
    });
  }
  const entries: SnapshotEntry[] = [];
  const objectIds: string[] = [];
  for (const record of records) {
    entries.push({
      path: record.path,
      kind: record.mode === '120000' ? 'symlink' : 'file',
      contentBase64: contents[requestByObject.get(record.objectId)!]!,
      executable: record.mode === '100755'
    });
    objectIds.push(record.objectId);
  }
  // Reuse the comparison validator to reject unsafe paths and malformed entries.
  compareCompleteSnapshots(entries, entries);
  return { commit, entries, treeBytes: totalBytes, objectIds };
}

/** Compare a complete result manifest to a pinned canonical commit and enforce every changed path. */
export async function verifyGitSnapshotScope(
  repoPath: string,
  fullBaseCommitSha: string,
  resultEntries: readonly SnapshotEntry[],
  allowedScope: readonly string[],
  limits: GitSnapshotLimits = {}
): Promise<GitScopeVerification> {
  const { objectIds: _objectIds, ...verification } = await verifyGitSnapshotScopeWithObjectIds(repoPath, fullBaseCommitSha, resultEntries, allowedScope, limits);
  return verification;
}

/** Like {@link verifyGitSnapshotScope}, and also reports the blob object id of every base entry (parallel to `entries`). */
export async function verifyGitSnapshotScopeWithObjectIds(
  repoPath: string,
  fullBaseCommitSha: string,
  resultEntries: readonly SnapshotEntry[],
  allowedScope: readonly string[],
  limits: GitSnapshotLimits = {}
): Promise<GitScopeVerification & GitSnapshotObjectIds> {
  if (!allowedScope.length) throw new Error('At least one explicitly allowed path or directory is required');
  const bound = { ...DEFAULTS, ...limits };
  for (const [key, value] of Object.entries(bound)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid Git snapshot limit: ${key}`);
  if (resultEntries.length > bound.maxEntries) throw new Error('Git result snapshot entry limit exceeded');
  let resultBytes = 0;
  for (const entry of resultEntries) {
    if (typeof entry.contentBase64 !== 'string' || entry.contentBase64.length > Math.ceil(bound.maxBlobBytes / 3) * 4) throw new Error(`Git result snapshot blob size limit exceeded: ${entry.path}`);
    const size = Buffer.from(entry.contentBase64, 'base64').length;
    if (size > bound.maxBlobBytes || resultBytes + size > bound.maxTotalBlobBytes) throw new Error(`Git result snapshot byte limit exceeded: ${entry.path}`);
    resultBytes += size;
  }
  // Validate unsafe paths, duplicate paths and canonical encodings before accepting a result manifest.
  compareCompleteSnapshots([], resultEntries);
  const normalizedScope = allowedScope.map(normalizeScopePath);
  const base = await snapshotGitCommitWithObjectIds(repoPath, fullBaseCommitSha, bound);
  const changes = compareCompleteSnapshots(base.entries, resultEntries);
  for (const change of changes) {
    const touched = change.previousPath ? [change.path, change.previousPath] : [change.path];
    for (const path of touched) {
      if (!normalizedScope.some(scope => scope.recursive ? path.startsWith(`${scope.path}/`) : path === scope.path)) {
        throw new Error(`Git change is outside the allowed scope: ${path}`);
      }
    }
  }
  return { ...base, changes, allowedScope: normalizedScope.map(scope => scope.original), scopeVerified: true };
}

/** One `ls-tree -rlz` record; `size` is the blob size in decimal, or `-` for objects that are not blobs. */
interface TreeRecord { mode: string; type: string; objectId: string; size: string; path: string }

function parseTree(bytes: Buffer, maxEntries: number): TreeRecord[] {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) throw new Error('Git tree output is incomplete');
  const records: TreeRecord[] = [];
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0, start);
    if (end < 0) throw new Error('Git tree output is incomplete');
    const tab = bytes.indexOf(9, start);
    if (tab < 0 || tab >= end) throw new Error('Malformed Git tree entry');
    // The size column is right-aligned with spaces, so split on runs of spaces.
    const header = bytes.toString('ascii', start, tab).split(/ +/);
    if (header.length !== 4) throw new Error('Malformed Git tree header');
    const [mode, type, objectId, size] = header as [string, string, string, string];
    if (!OBJECT_ID.test(objectId)) throw new Error('Malformed Git object ID in tree');
    let path: string;
    try { path = decoder.decode(bytes.subarray(tab + 1, end)); } catch { throw new Error('Git tree contains a non-UTF-8 path'); }
    records.push({ mode, type, objectId: objectId.toLowerCase(), size, path });
    if (records.length > maxEntries) throw new Error('Git snapshot entry limit exceeded');
    start = end + 1;
  }
  return records;
}

function normalizeScopePath(path: string): { path: string; recursive: boolean; original: string } {
  const recursive = path.endsWith('/');
  const normalized = recursive ? path.slice(0, -1) : path;
  if (!normalized || normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('\0') || normalized.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) {
    throw new Error(`Unsafe allowed scope path: ${path}`);
  }
  return { path: normalized, recursive, original: path };
}

const MAX_BATCH_HEADER_BYTES = 512;
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Incremental parser for `git cat-file --batch` output, which is one `<oid> <type> <size>\n<content>\n` response
 * per requested object (`<oid> missing\n` for an absent one), in request order. It is fed arbitrary chunks of the
 * byte stream, so content that looks like a header, or a chunk boundary anywhere, cannot confuse it: content
 * lengths come from the size announced in the header, which must equal the size in `requests`. `onBlob` receives
 * a buffer it must not keep. Any deviation throws, and so does `finish()` if the stream ended early.
 */
export function createGitBatchBlobParser(requests: readonly GitBlobRequest[], onBlob: (index: number, bytes: Buffer) => void): { push(chunk: Buffer): void; finish(): void } {
  let index = 0;
  let phase: 'header' | 'body' | 'terminator' = 'header';
  let header: Buffer[] = [];
  let headerLength = 0;
  let body = Buffer.alloc(0);
  let filled = 0;

  const startBlob = (line: string) => {
    const request = requests[index]!;
    const fields = line.split(' ');
    if (fields[0]?.toLowerCase() !== request.objectId) throw new Error(`Unexpected Git cat-file response for ${request.path}`);
    if (fields.length === 2 && fields[1] === 'missing') throw new Error(`Git blob is missing: ${request.path}`);
    if (fields.length !== 3) throw new Error(`Malformed Git cat-file response for ${request.path}`);
    const [, type, sizeText] = fields as [string, string, string];
    if (type !== 'blob') throw new Error(`Unsupported Git object type ${type}: ${request.path}`);
    if (!/^\d+$/.test(sizeText)) throw new Error(`Invalid Git blob size for ${request.path}`);
    if (Number(sizeText) !== request.size) throw new Error(`Git blob size changed or was truncated: ${request.path}`);
    body = Buffer.allocUnsafe(request.size);
    filled = 0;
    phase = request.size === 0 ? 'terminator' : 'body';
  };

  return {
    push(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        if (index >= requests.length) throw new Error('Git cat-file returned more output than was requested');
        if (phase === 'header') {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline;
          if (headerLength + end - offset > MAX_BATCH_HEADER_BYTES) throw new Error(`Malformed Git cat-file response for ${requests[index]!.path}`);
          if (newline < 0) {
            header.push(Buffer.from(chunk.subarray(offset)));
            headerLength += end - offset;
            break;
          }
          const line = header.length ? Buffer.concat([...header, chunk.subarray(offset, end)]).toString('ascii') : chunk.toString('ascii', offset, end);
          header = [];
          headerLength = 0;
          offset = newline + 1;
          startBlob(line);
        } else if (phase === 'body') {
          const take = Math.min(body.length - filled, chunk.length - offset);
          chunk.copy(body, filled, offset, offset + take);
          filled += take;
          offset += take;
          if (filled === body.length) phase = 'terminator';
        } else {
          if (chunk[offset] !== 10) throw new Error(`Malformed Git cat-file response for ${requests[index]!.path}`);
          offset += 1;
          const bytes = body;
          body = Buffer.alloc(0);
          onBlob(index, bytes);
          index += 1;
          phase = 'header';
        }
      }
    },
    finish() {
      if (index !== requests.length || phase !== 'header' || headerLength) throw new Error('Git cat-file output was truncated');
    }
  };
}

/**
 * Read the requested blobs through one long-lived `git cat-file --batch` process: every object id is written to
 * its stdin up front and the responses are parsed from stdout as they stream in, so memory holds one blob at a
 * time besides the result. `timeoutMs` bounds the whole batch, and the process is killed on any error.
 */
function readBlobs(repoPath: string, requests: readonly GitBlobRequest[], timeoutMs: number, onBlob: (index: number, bytes: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const parser = createGitBatchBlobParser(requests, onBlob);
    const stderr: Buffer[] = [];
    let stderrLength = 0;
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(() => settle(new Error(`Git command timed out after ${timeoutMs}ms`)), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      try { parser.push(chunk); } catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrLength >= MAX_STDERR_BYTES) return;
      stderr.push(chunk);
      stderrLength += chunk.length;
    });
    // If Git exits early the write fails with EPIPE; the exit code and stderr below carry the real reason.
    child.stdin.on('error', () => undefined);
    child.once('error', error => settle(error));
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) { settle(new Error(`git cat-file failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 1000)}`)); return; }
      try { parser.finish(); } catch (error) { settle(error instanceof Error ? error : new Error(String(error))); return; }
      settle();
    });
    child.stdin.end(Buffer.from(requests.map(request => `${request.objectId}\n`).join(''), 'ascii'));
  });
}

function git(repoPath: string, args: string[], timeoutMs: number, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let length = 0;
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      child.kill('SIGKILL');
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`Git command timed out after ${timeoutMs}ms`)), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxBytes) { fail(new Error(`Git command output limit exceeded (${maxBytes} bytes)`)); return; }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk.subarray(0, 64 * 1024));
    });
    child.once('error', error => fail(error));
    child.once('close', code => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 1000)}`));
      else resolve(Buffer.concat(stdout, length));
    });
  });
}
