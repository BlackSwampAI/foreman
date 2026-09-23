import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { compareCompleteSnapshots, type SnapshotEntry } from './workspace-snapshot.js';
import { snapshotGitCommit, verifyGitSnapshotScope } from './git-workspace.js';

export interface GitPromotionInput {
  repoPath: string;
  pinnedBaseCommit: string;
  entries: readonly SnapshotEntry[];
  allowedScope: readonly string[];
  /** Stable id for this approved snapshot, used to make the commit reproducible across retries. */
  operationId: string;
  /** Optional ref name, e.g. refs/heads/foreman/run-123. Existing divergent refs are never moved. */
  destinationBranch?: string;
  commitMessage?: string;
}

export interface GitPromotionResult {
  status: 'applied';
  commit: string;
  tree: string;
  parent: string;
  destinationBranch?: string;
}

/**
 * Create a reproducible result commit in a disposable detached worktree. The caller must
 * revalidate decision/review/validation bindings before calling this function. This function
 * independently rechecks the pinned base, full snapshot, and allowed path scope.
 */
export async function promoteSnapshotToGit(input: GitPromotionInput): Promise<GitPromotionResult> {
  if (!input.operationId || input.operationId.includes('\n') || input.operationId.includes('\0')) throw new Error('A stable promotion operation ID is required');
  const base = input.pinnedBaseCommit.toLowerCase();
  const verified = await verifyGitSnapshotScope(input.repoPath, base, input.entries, input.allowedScope);
  if (verified.commit !== base) throw new Error('Pinned base commit changed during promotion verification');
  const repoRoot = (await git(input.repoPath, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  const resolvedBase = (await git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).toString('ascii').trim().toLowerCase();
  if (resolvedBase !== base) throw new Error('Pinned base commit object is missing or did not resolve exactly');
  const currentHead = (await git(repoRoot, ['rev-parse', '--verify', 'HEAD'])).toString('ascii').trim().toLowerCase();
  if (currentHead !== base) throw new Error('Configured repository HEAD has drifted from the pinned base commit');
  const destination = input.destinationBranch ? normalizeRef(input.destinationBranch) : undefined;
  if (destination) await git(repoRoot, ['check-ref-format', destination]);
  const result = await git(input.repoPath, ['config', '--get', 'extensions.objectFormat']).then(x => x.toString('ascii').trim()).catch(() => 'sha1');
  if (result && result !== 'sha1' && result !== 'sha256') throw new Error('Unsupported Git object format');

  const tempRoot = await mkdtemp(join(tmpdir(), 'foreman-git-promotion-'));
  const worktreePath = join(tempRoot, 'worktree');
  let added = false;
  try {
    await git(repoRoot, ['worktree', 'add', '--detach', '--no-checkout', worktreePath, base]);
    added = true;
    // This is a newly created worktree. Clear every tree entry before applying the complete manifest.
    for (const name of await readdir(worktreePath)) if (name !== '.git') await rm(join(worktreePath, name), { recursive: true, force: true });
    await materializeEntries(worktreePath, input.entries);
    const indexPath = join(tempRoot, 'index');
    const env = { GIT_INDEX_FILE: indexPath };
    await git(worktreePath, ['read-tree', '--empty'], { env });
    const indexRecords: Buffer[] = [];
    for (const entry of input.entries) {
      const bytes = Buffer.from(entry.contentBase64, 'base64');
      const objectId = (await git(worktreePath, ['hash-object', '-w', '--no-filters', '--stdin'], { input: bytes })).toString('ascii').trim();
      const mode = entry.kind === 'symlink' ? '120000' : entry.executable ? '100755' : '100644';
      indexRecords.push(Buffer.from(`${mode} ${objectId}\t${entry.path}\0`, 'utf8'));
    }
    if (indexRecords.length) await git(worktreePath, ['update-index', '-z', '--index-info'], { input: Buffer.concat(indexRecords), env });
    const tree = (await git(worktreePath, ['write-tree'], { env })).toString('ascii').trim().toLowerCase();
    const stable = createHash('sha256').update(input.operationId).digest('hex');
    const message = (input.commitMessage ?? `Foreman approved result ${input.operationId}`).replace(/[\r\0]/g, '').trim() || `Foreman approved result ${stable}`;
    const commit = (await git(worktreePath, ['-c', `user.name=Foreman`, '-c', 'user.email=foreman@localhost', 'commit-tree', tree, '-p', base], {
      input: Buffer.from(`${message}\n`, 'utf8'),
      env: { GIT_AUTHOR_NAME: 'Foreman', GIT_AUTHOR_EMAIL: 'foreman@localhost', GIT_COMMITTER_NAME: 'Foreman', GIT_COMMITTER_EMAIL: 'foreman@localhost', GIT_AUTHOR_DATE: '@0 +0000', GIT_COMMITTER_DATE: '@0 +0000' }
    })).toString('ascii').trim().toLowerCase();

    const commitBody = (await git(repoRoot, ['cat-file', '-p', commit])).toString('utf8').split('\n\n', 1)[0]!;
    if (!commitBody.split('\n').includes(`tree ${tree}`) || !commitBody.split('\n').includes(`parent ${base}`)) throw new Error('Created Git result commit has an unexpected tree or parent');
    await verifyPromotionCommitTree(repoRoot, commit, base, input.entries);

    if (destination) {
      const existing = await git(repoRoot, ['show-ref', '--verify', '--hash', destination], { allowFailure: true });
      if (existing.code === 0) {
        const current = existing.stdout.toString('ascii').trim().toLowerCase();
        if (current !== commit) throw new Error(`Promotion destination already points elsewhere: ${destination}`);
        // Verify both refs in one Git ref transaction immediately before returning success.
        await verifyRefsAtomically(repoRoot, base, destination, commit);
      } else {
        // Lock and verify HEAD while atomically creating the destination. A concurrent source
        // branch movement or destination creation fails the same transaction.
        await git(repoRoot, ['update-ref', '--stdin'], { input: Buffer.from(`start\nverify HEAD ${base}\ncreate ${destination} ${commit}\nprepare\ncommit\n`, 'utf8') });
      }
      const finalRef = (await git(repoRoot, ['rev-parse', '--verify', '--end-of-options', destination])).toString('ascii').trim().toLowerCase();
      if (finalRef !== commit) throw new Error(`Promotion destination changed during application: ${destination}`);
    } else {
      const finalHead = (await git(repoRoot, ['rev-parse', '--verify', 'HEAD'])).toString('ascii').trim().toLowerCase();
      if (finalHead !== base) throw new Error('Configured repository HEAD drifted during promotion');
    }
    return { status: 'applied', commit, tree, parent: base, ...(destination ? { destinationBranch: destination } : {}) };
  } finally {
    try {
      if (added) await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

async function verifyRefsAtomically(repoPath: string, expectedHead: string, destination: string, expectedDestination: string): Promise<void> {
  const input = Buffer.from(`start\nverify HEAD ${expectedHead}\nverify ${destination} ${expectedDestination}\nprepare\ncommit\n`, 'utf8');
  await git(repoPath, ['update-ref', '--stdin'], { input });
}

/** Independently verify that a result commit has the required parent and exact complete tree. */
export async function verifyPromotionCommitTree(repoPath: string, commit: string, pinnedBaseCommit: string, expectedEntries: readonly SnapshotEntry[]): Promise<{ commit: string; tree: string; parent: string }> {
  const raw = (await git(repoPath, ['cat-file', '-p', commit])).toString('utf8');
  const header = raw.split('\n\n', 1)[0] ?? '';
  const tree = header.split('\n').find(line => line.startsWith('tree '))?.slice(5).toLowerCase();
  const parents = header.split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7).toLowerCase());
  const expectedBase = pinnedBaseCommit.toLowerCase();
  if (!tree || parents.length !== 1 || parents[0] !== expectedBase) throw new Error('Result commit must have exactly the pinned base as its sole parent');
  const snapshot = await snapshotGitCommit(repoPath, commit);
  if (compareCompleteSnapshots(expectedEntries, snapshot.entries).length !== 0) throw new Error('Result commit tree does not exactly match the approved snapshot');
  return { commit: snapshot.commit, tree, parent: parents[0] };
}

async function materializeEntries(root: string, entries: readonly SnapshotEntry[]): Promise<void> {
  compareCompleteSnapshots([], entries);
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const path of byPath.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (byPath.has(parts.slice(0, i).join('/'))) throw new Error(`Snapshot has a file/directory path conflict: ${path}`);
  }
  for (const entry of entries) {
    const full = resolve(root, entry.path);
    if (!full.startsWith(root + sep)) throw new Error(`Unsafe snapshot path: ${entry.path}`);
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i++) if (byPath.get(parts.slice(0, i).join('/'))?.kind === 'symlink') throw new Error(`Snapshot has a symlink path conflict: ${entry.path}`);
    if (entry.kind === 'symlink') {
      const target = Buffer.from(entry.contentBase64, 'base64').toString('utf8');
      if (!target || target.includes('\0')) throw new Error(`Invalid symlink target: ${entry.path}`);
    }
  }
  for (const entry of entries) {
    const full = resolve(root, entry.path);
    await mkdir(dirname(full), { recursive: true });
    if (entry.kind === 'symlink') await symlink(Buffer.from(entry.contentBase64, 'base64').toString('utf8'), full);
    else { await writeFile(full, Buffer.from(entry.contentBase64, 'base64'), { flag: 'wx' }); if (entry.executable) await chmod(full, 0o755); }
  }
}

function normalizeRef(ref: string): string {
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  if (!full.startsWith('refs/heads/') || full.includes('\0') || full.endsWith('/') || full.includes('..') || full.includes(' ')) throw new Error('Promotion destination must be a valid local branch ref');
  return full;
}

interface GitOptions { input?: Buffer; env?: NodeJS.ProcessEnv; allowFailure?: boolean }
async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<Buffer & { code?: number; stdout: Buffer }> {
  const output = await new Promise<{ stdout: Buffer; code: number }>((resolvePromise, rejectPromise) => {
    const child = spawn('git', ['-C', cwd, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...options.env, GIT_OPTIONAL_LOCKS: '0' } });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', rejectPromise);
    child.once('close', code => { const result = { stdout: Buffer.concat(stdout), code: code ?? 1 }; if (result.code !== 0 && !options.allowFailure) rejectPromise(new Error(`git ${args[0]} failed (${result.code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 1000)}`)); else resolvePromise(result); });
    if (options.input) child.stdin.end(options.input); else child.stdin.end();
  });
  return Object.assign(output.stdout, { code: output.code, stdout: output.stdout });
}
