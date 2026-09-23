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
  if (!SHA.test(fullCommitSha)) throw new Error('A full 40 or 64 character commit SHA is required');
  const bound = { ...DEFAULTS, ...limits };
  for (const [key, value] of Object.entries(bound)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid Git snapshot limit: ${key}`);
  const commit = fullCommitSha.toLowerCase();
  const resolved = (await git(repoPath, ['rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`], bound.commandTimeoutMs, 256)).toString('ascii').trim().toLowerCase();
  if (resolved !== commit) throw new Error('Git did not resolve the requested full commit SHA exactly');
  const tree = await git(repoPath, ['ls-tree', '-rz', '--full-tree', commit], bound.commandTimeoutMs, bound.maxTreeBytes);
  const records = parseTree(tree, bound.maxEntries);
  const entries: SnapshotEntry[] = [];
  let totalBytes = 0;
  for (const record of records) {
    if (record.mode === '160000' || record.type === 'commit') throw new Error(`Submodules are not supported: ${record.path}`);
    if (record.mode !== '100644' && record.mode !== '100755' && record.mode !== '120000') throw new Error(`Unsupported Git tree mode ${record.mode}: ${record.path}`);
    if (record.type !== 'blob') throw new Error(`Unsupported Git object type ${record.type}: ${record.path}`);
    const sizeText = (await git(repoPath, ['cat-file', '-s', record.objectId], bound.commandTimeoutMs, 64)).toString('ascii').trim();
    if (!/^\d+$/.test(sizeText)) throw new Error(`Invalid Git blob size for ${record.path}`);
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size > bound.maxBlobBytes || totalBytes + size > bound.maxTotalBlobBytes) throw new Error(`Git snapshot blob size limit exceeded: ${record.path}`);
    const bytes = await git(repoPath, ['cat-file', 'blob', record.objectId], bound.commandTimeoutMs, Math.min(bound.maxBlobBytes, size + 1));
    if (bytes.length !== size) throw new Error(`Git blob size changed or was truncated: ${record.path}`);
    totalBytes += size;
    if (record.mode === '120000') {
      try { decoder.decode(bytes); } catch { throw new Error(`Non-UTF-8 symlink target: ${record.path}`); }
      if (!bytes.length) throw new Error(`Empty symlink target: ${record.path}`);
    }
    entries.push({
      path: record.path,
      kind: record.mode === '120000' ? 'symlink' : 'file',
      contentBase64: bytes.toString('base64'),
      executable: record.mode === '100755'
    });
  }
  // Reuse the comparison validator to reject unsafe paths and malformed entries.
  compareCompleteSnapshots(entries, entries);
  return { commit, entries, treeBytes: totalBytes };
}

/** Compare a complete result manifest to a pinned canonical commit and enforce every changed path. */
export async function verifyGitSnapshotScope(
  repoPath: string,
  fullBaseCommitSha: string,
  resultEntries: readonly SnapshotEntry[],
  allowedScope: readonly string[],
  limits: GitSnapshotLimits = {}
): Promise<GitScopeVerification> {
  if (!allowedScope.length) throw new Error('At least one explicitly allowed path or directory is required');
  const normalizedScope = allowedScope.map(normalizeScopePath);
  const base = await snapshotGitCommit(repoPath, fullBaseCommitSha, limits);
  const changes = compareCompleteSnapshots(base.entries, resultEntries);
  for (const change of changes) {
    const touched = change.previousPath ? [change.path, change.previousPath] : [change.path];
    for (const path of touched) {
      if (!normalizedScope.some(scope => path === scope || path.startsWith(`${scope}/`))) {
        throw new Error(`Git change is outside the allowed scope: ${path}`);
      }
    }
  }
  return { ...base, changes, allowedScope: normalizedScope, scopeVerified: true };
}

interface TreeRecord { mode: string; type: string; objectId: string; path: string }

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
    const header = bytes.toString('ascii', start, tab).split(' ');
    if (header.length !== 3) throw new Error('Malformed Git tree header');
    const [mode, type, objectId] = header as [string, string, string];
    if (!OBJECT_ID.test(objectId)) throw new Error('Malformed Git object ID in tree');
    let path: string;
    try { path = decoder.decode(bytes.subarray(tab + 1, end)); } catch { throw new Error('Git tree contains a non-UTF-8 path'); }
    records.push({ mode, type, objectId, path });
    if (records.length > maxEntries) throw new Error('Git snapshot entry limit exceeded');
    start = end + 1;
  }
  return records;
}

function normalizeScopePath(path: string): string {
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  if (!normalized || normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('\0') || normalized.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) {
    throw new Error(`Unsafe allowed scope path: ${path}`);
  }
  return normalized;
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
