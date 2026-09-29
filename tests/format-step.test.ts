import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, type UhpAdapter } from '../src/controller.js';
import { formatSetupCommands, formatWorkerSnapshot } from '../src/format-step.js';
import { snapshotGitCommit } from '../src/git-workspace.js';
import { JsonStore } from '../src/store.js';
import { fullSnapshotEntries, materializeVerifiedWorkspace, verifyWorkerSnapshot, type BridgeSnapshotEnvelope, type ValidationCommand } from '../src/verified-workspace.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A tiny formatter: strips trailing whitespace from every regular file below the workspace root, makes files non-executable, and drops a new file. It ignores symlinks. */
const FORMATTER = `
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--require-setup') && !existsSync('.setup-ran')) { console.error('setup did not run first'); process.exit(1); }
if (process.argv.includes('--fail')) { console.error('formatter exploded'); process.exit(3); }
const walk = dir => { for (const name of readdirSync(dir)) { if (name === '.git' || name === 'fmt.mjs') continue; const path = join(dir, name), stats = lstatSync(path); if (stats.isSymbolicLink()) continue; if (stats.isDirectory()) walk(path); else if (path.endsWith('.txt') || path.endsWith('.sh')) { writeFileSync(path, readFileSync(path, 'utf8').replace(/[ \\t]+$/gm, '')); chmodSync(path, 0o644); } } };
walk('.');
writeFileSync('created-by-formatter.txt', 'new\\n');
console.log('formatted');
`;
const CHECK = `
import { readFileSync } from 'node:fs';
process.exit(/[ \\t]+$/m.test(readFileSync('src/a.txt', 'utf8')) ? 1 : 0);
`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-format-'));
  dirs.push(dir);
  git(dir, 'init', '-q'); git(dir, 'config', 'user.name', 'Fixture'); git(dir, 'config', 'user.email', 'fixture@example.invalid');
  const files: Record<string, string> = { 'fmt.mjs': FORMATTER, 'check.mjs': CHECK, 'src/a.txt': 'alpha\n', 'src/other.txt': 'untouched   \n', 'src/tool.sh': 'echo base\n', 'docs/outside.txt': 'outside   \n' };
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), content); }
  await chmod(join(dir, 'src/tool.sh'), 0o755);
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
}

/** A bridge envelope for the base tree with these files replaced (and a symlink added), as the workspace bridge would report a Worker's result. */
async function workerEnvelope(dir: string, sha: string, edits: Record<string, string>): Promise<BridgeSnapshotEnvelope> {
  const base = await snapshotGitCommit(dir, sha);
  const entries = base.entries.map(entry => {
    const bytes = Buffer.from(edits[entry.path] ?? Buffer.from(entry.contentBase64, 'base64').toString('utf8'));
    return { path: entry.path, kind: 'file' as const, mode: (entry.executable ? '100755' : '100644') as '100755' | '100644', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') };
  });
  const target = Buffer.from('a.txt');
  entries.push({ path: 'src/link.txt', kind: 'symlink' as any, mode: '120000' as any, size: target.length, sha256: createHash('sha256').update(target).digest('hex'), target: 'a.txt' } as any);
  return { complete: true, base_commit: sha, entries, errors: [] };
}

const node = (name: string, ...args: string[]): ValidationCommand => ({ name, command: process.execPath, args, network: false });
const text = (entries: ReadonlyArray<{ path: string; contentBase64: string }> | undefined, path: string) => Buffer.from(entries!.find(entry => entry.path === path)!.contentBase64, 'base64').toString('utf8');

describe('format step', () => {
  it('rewrites only the files the Worker changed and keeps scope verification and file modes', async () => {
    const { dir, sha } = await fixture();
    const verified = await verifyWorkerSnapshot({ repoPath: dir, pinnedBaseCommit: sha, allowedScope: ['src/'], envelope: await workerEnvelope(dir, sha, { 'src/a.txt': 'alpha   \nbeta  \n', 'src/tool.sh': 'echo changed  \n' }) });
    expect(verified.changes.map(change => change.path)).toEqual(['src/a.txt', 'src/link.txt', 'src/tool.sh']);

    const result = await formatWorkerSnapshot({ repoPath: dir, verified, setupCommands: [], formatCommand: node('Format', 'fmt.mjs'), allowedScope: ['src/'], timeoutMs: 20_000 });
    expect(result.formatting).toMatchObject({ status: 'applied', command: process.execPath, args: ['fmt.mjs'], formattedPaths: ['src/a.txt', 'src/tool.sh'], observation: { exitCode: 0, output: 'formatted\n' } });

    const entries = result.verified.entries!;
    expect(text(entries, 'src/a.txt')).toBe('alpha\nbeta\n');
    expect(text(entries, 'src/tool.sh')).toBe('echo changed\n');
    // The formatter also reformatted a file the Worker never touched, a file outside the scope, and created a new one: none of that leaks in.
    expect(text(entries, 'src/other.txt')).toBe('untouched   \n');
    expect(text(entries, 'docs/outside.txt')).toBe('outside   \n');
    expect(entries.some(entry => entry.path === 'created-by-formatter.txt')).toBe(false);
    expect(entries).toHaveLength(verified.entries!.length);
    // The mode is the Worker's, not whatever the formatter left; symlinks are skipped.
    expect(entries.find(entry => entry.path === 'src/tool.sh')!.executable).toBe(true);
    expect(entries.find(entry => entry.path === 'src/link.txt')).toMatchObject({ kind: 'symlink', contentBase64: Buffer.from('a.txt').toString('base64') });
    // Changes and the review diff describe the formatted bytes; provenance is unchanged.
    expect(result.verified.changes.map(change => change.path)).toEqual(['src/a.txt', 'src/link.txt', 'src/tool.sh']);
    expect(result.verified.reviewDiff).toContain('+beta\n');
    expect(result.verified.reviewDiff).not.toContain('+beta  ');
    expect(result.verified).toMatchObject({ provenance: 'bridge_snapshot', pinnedBaseCommit: sha, scopeVerified: true, allowedScope: ['src/'] });
    // The result is itself a scope-verified workspace that validation can materialize.
    const workspace = await materializeVerifiedWorkspace(dir, result.verified);
    await workspace.cleanup();
  });

  it('runs setup commands before the formatter and reports an already formatted snapshot as unchanged', async () => {
    const { dir, sha } = await fixture();
    const verified = await verifyWorkerSnapshot({ repoPath: dir, pinnedBaseCommit: sha, allowedScope: ['src/'], envelope: await workerEnvelope(dir, sha, { 'src/a.txt': 'alpha\nbeta\n' }) });
    const setup = node('Install', '-e', "require('node:fs').writeFileSync('.setup-ran', '1')");
    const withoutSetup = await formatWorkerSnapshot({ repoPath: dir, verified, setupCommands: [], formatCommand: node('Format', 'fmt.mjs', '--require-setup'), allowedScope: ['src/'] });
    expect(withoutSetup.formatting).toMatchObject({ status: 'failed', observation: { exitCode: 1 } });
    const result = await formatWorkerSnapshot({ repoPath: dir, verified, setupCommands: [setup], formatCommand: node('Format', 'fmt.mjs', '--require-setup'), allowedScope: ['src/'] });
    expect(result.formatting).toMatchObject({ status: 'unchanged', formattedPaths: [] });
    expect(result.verified).toBe(verified);
  });

  it('returns the original snapshot when the formatter or a setup command fails', async () => {
    const { dir, sha } = await fixture();
    const verified = await verifyWorkerSnapshot({ repoPath: dir, pinnedBaseCommit: sha, allowedScope: ['src/'], envelope: await workerEnvelope(dir, sha, { 'src/a.txt': 'alpha   \n' }) });
    const failedFormatter = await formatWorkerSnapshot({ repoPath: dir, verified, setupCommands: [], formatCommand: node('Format', 'fmt.mjs', '--fail'), allowedScope: ['src/'] });
    expect(failedFormatter.verified).toBe(verified);
    expect(failedFormatter.formatting).toMatchObject({ status: 'failed', formattedPaths: [], observation: { exitCode: 3, output: 'formatter exploded\n' } });
    const failedSetup = await formatWorkerSnapshot({ repoPath: dir, verified, setupCommands: [node('Install', '-e', 'process.exit(7)')], formatCommand: node('Format', 'fmt.mjs'), allowedScope: ['src/'] });
    expect(failedSetup.verified).toBe(verified);
    expect(failedSetup.formatting).toMatchObject({ status: 'failed', observation: { name: 'Install', exitCode: 7 } });
    const timedOut = await formatWorkerSnapshot({ repoPath: dir, verified, setupCommands: [], formatCommand: node('Format', '-e', 'setTimeout(() => {}, 60000)'), allowedScope: ['src/'], timeoutMs: 300 });
    expect(timedOut.verified).toBe(verified);
    expect(timedOut.formatting).toMatchObject({ status: 'failed', observation: { timedOut: true } });
  });

  it('fails without changing anything when the formatted snapshot no longer verifies against the scope', async () => {
    const { dir, sha } = await fixture();
    const verified = await verifyWorkerSnapshot({ repoPath: dir, pinnedBaseCommit: sha, allowedScope: ['src/'], envelope: await workerEnvelope(dir, sha, { 'src/a.txt': 'alpha   \n' }) });
    const result = await formatWorkerSnapshot({ repoPath: dir, verified, setupCommands: [], formatCommand: node('Format', 'fmt.mjs'), allowedScope: ['docs/'] });
    expect(result.verified).toBe(verified);
    expect(result.formatting).toMatchObject({ status: 'failed', error: expect.stringContaining('outside the allowed scope') });
  });

  it('treats only install commands as setup', () => {
    const commands: ValidationCommand[] = [
      { name: 'Install', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
      { name: 'Explicit', command: 'tool', args: [], network: true },
      { name: 'Offline install', command: 'pnpm', args: ['install'], network: false },
      { name: 'Tests', command: 'pnpm', args: ['run', 'test'] },
      { name: 'Smoke: install', command: 'pnpm', args: ['run', 'smoke:install'], network: true },
    ];
    expect(formatSetupCommands(commands).map(command => command.name)).toEqual(['Install', 'Offline install']);
  });
});

describe('controller with a format step', () => {
  async function run(formatCommand: ValidationCommand | undefined) {
    const { dir: repo, sha } = await fixture();
    const dir = await mkdtemp(join(tmpdir(), 'foreman-format-state-'));
    dirs.push(dir);
    const store = new JsonStore(join(dir, 'state.json'));
    await store.mutate(s => { for (const role of s.roles) { role.enabled = true; role.availableConfigs = [{ harnessId: 'fixture', model: 'model-fixture' }]; role.config = { harnessId: 'fixture', model: 'model-fixture' }; } });
    const uhp: UhpAdapter = { submit: async () => ({ externalId: 'x', status: 'completed', result: {} }), cancel: async () => ({ status: 'cancelled' }) };
    const controller = new Controller(store, uhp);
    controller.configureVerifiedWorkspace({ repoPath: repo, allowedScope: ['src/'], commands: [node('Formatting is clean', 'check.mjs')], ...(formatCommand ? { formatCommand } : {}), timeoutMs: 20_000 });
    const project: any = await controller.createProject('Format'), task: any = await controller.createTask(project.id, 'Edit'), created: any = await controller.createRun(task.id);
    const stamp = new Date().toISOString();
    await store.mutate(s => {
      const r = s.projects[0]!.tasks[0]!.runs[0]!;
      r.pinnedBaseCommit = sha;
      r.assignments.push({ id: 'worker-format', roleId: 'worker', status: 'succeeded', requestedConfig: { harnessId: 'fixture', model: 'model-fixture' }, responseId: 'response-format', sessionId: 'session-format', prompt: 'Edit', submissionId: 'sub', idempotencyKey: 'idem', createdAt: stamp });
    });
    const envelope = await workerEnvelope(repo, sha, { 'src/a.txt': 'alpha   \nbeta  \n' });
    const result: any = await (controller as any).processWorkerOutput(created.id, 'worker-format', envelope, 'bridge_snapshot');
    return { repo, sha, store, result, envelope };
  }

  it('records the formatted snapshot as evidence and validates the formatted bytes', async () => {
    const { repo, sha, store, result, envelope } = await run(node('Format', 'fmt.mjs'));
    expect(result.validation).toMatchObject({ status: 'passed', passed: true });
    const evidence = result.workerEvidence;
    expect(evidence.formatting).toMatchObject({ status: 'applied', formattedPaths: ['src/a.txt'] });
    expect(evidence.reviewDiff).toContain('+beta\n');
    expect(evidence.reviewDiff).not.toContain('+beta  ');
    const entries = await fullSnapshotEntries(repo, evidence);
    expect(text(entries, 'src/a.txt')).toBe('alpha\nbeta\n');
    expect(entries.some(entry => entry.path === 'created-by-formatter.txt')).toBe(false);
    // What promotion re-verifies: the stored tree still verifies against the pinned base and reproduces the stored changes and diff.
    const reverified = await verifyWorkerSnapshot({ repoPath: repo, pinnedBaseCommit: sha, allowedScope: ['src/'], envelope: { complete: true, base_commit: sha, errors: [], entries: entries.map(entry => { const bytes = Buffer.from(entry.contentBase64, 'base64'); return { path: entry.path, kind: entry.kind, mode: (entry.kind === 'symlink' ? '120000' : entry.executable ? '100755' : '100644') as any, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...(entry.kind === 'symlink' ? { target: bytes.toString('utf8') } : { contentBase64: entry.contentBase64 }) }; }) } });
    expect(reverified.changes).toEqual(evidence.changes);
    expect(reverified.reviewDiff).toBe(evidence.reviewDiff);
    const state = await store.load();
    expect(state.projects[0]!.tasks[0]!.runs[0]!.workerEvidence?.formatting?.status).toBe('applied');
    expect(state.events.find(event => event.type === 'worker.evidence_verified')?.data.formatting).toMatchObject({ status: 'applied', formattedPaths: ['src/a.txt'] });
    expect(envelope.entries.find(entry => entry.path === 'src/a.txt')!.contentBase64).not.toBe(Buffer.from('alpha\nbeta\n').toString('base64'));
  });

  it('leaves the Worker bytes alone, and validation failing on them, when no format step is configured', async () => {
    const { result } = await run(undefined);
    expect(result.workerEvidence.formatting).toBeUndefined();
    expect(result.validation).toMatchObject({ status: 'failed', passed: false });
  });

  it('keeps the Worker snapshot and lets validation report the problem when the formatter fails', async () => {
    const { result } = await run(node('Format', 'fmt.mjs', '--fail'));
    expect(result.workerEvidence.formatting).toMatchObject({ status: 'failed', observation: { exitCode: 3 } });
    expect(result.validation).toMatchObject({ status: 'failed', passed: false });
  });
});
