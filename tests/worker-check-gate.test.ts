import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baselineCommandDigest } from '../src/baseline-validation.js';
import { snapshotGitCommit } from '../src/git-workspace.js';
import type { BridgeSnapshotEnvelope, ValidationCommand, ValidationObservation } from '../src/verified-workspace.js';
import { headTailExcerpt, runWorkerCheckRound, workerCheckFeedback } from '../src/worker-check-gate.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-check-gate-'));
  dirs.push(dir);
  git(dir, 'init', '-q'); git(dir, 'config', 'user.name', 'Fixture'); git(dir, 'config', 'user.email', 'fixture@example.invalid');
  const files: Record<string, string> = { 'src/a.txt': 'alpha\n', 'docs/outside.txt': 'outside\n' };
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), content); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
}
async function envelope(dir: string, sha: string, edits: Record<string, string>): Promise<BridgeSnapshotEnvelope> {
  const base = await snapshotGitCommit(dir, sha);
  const entries = base.entries.map(entry => {
    const bytes = Buffer.from(edits[entry.path] ?? Buffer.from(entry.contentBase64, 'base64').toString('utf8'));
    return { path: entry.path, kind: 'file' as const, mode: '100644' as const, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') };
  });
  return { complete: true, base_commit: sha, entries, errors: [] };
}
const node = (name: string, source: string): ValidationCommand => ({ name, command: process.execPath, args: ['-e', source], network: false });
const requireFixed = node('content check', `if(!require('node:fs').readFileSync('src/a.txt','utf8').includes('fixed')){console.log('src/a.txt: expected fixed');process.exit(1)}`);
const alwaysRed = node('red on base', `console.log('broken on base');process.exit(2)`);
const observation = (name: string, output: string, patch: Partial<ValidationObservation> = {}): ValidationObservation => ({ name, command: 'pnpm', args: ['run', name], exitCode: 1, timedOut: false, output, outputTruncated: false, startedAt: '', finishedAt: '', sandbox: 'none', network: false, ...patch });

describe('Worker check gate', () => {
  it('keeps the head and more of the tail when output is too long', () => {
    const text = `${'a'.repeat(500)}MIDDLE${'z'.repeat(500)}`;
    const excerpt = headTailExcerpt(text, 300);
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(300);
    expect(excerpt.startsWith('aaa')).toBe(true);
    expect(excerpt.endsWith('zzz')).toBe(true);
    expect(excerpt).toContain('[... output trimmed ...]');
    expect(excerpt).not.toContain('MIDDLE');
    expect(headTailExcerpt('short', 300)).toBe('short');
  });

  it('reports each failed check with its command, status and output without terminal colors', () => {
    const feedback = workerCheckFeedback([observation('lint', '\u001b[31merror\u001b[0m src/a.ts:3 no-unused-vars'), observation('test', '', { exitCode: null, timedOut: true })]);
    expect(feedback).toContain('## lint failed (exit 1)\n$ pnpm run lint\nerror src/a.ts:3 no-unused-vars');
    expect(feedback).toContain('## test failed (timed out)');
    expect(feedback).toContain('(no output)');
    expect(feedback).not.toContain('\u001b');
  });

  it('fails a round on a Worker-caused check failure, leaves out checks red on the base, and passes once fixed', async () => {
    const { dir, sha } = await fixture();
    const commands = [requireFixed, alwaysRed];
    const baseline = { pinnedBaseCommit: sha, commandDigest: baselineCommandDigest(commands), ranAt: '', checks: [{ name: 'red on base', passed: false, exitCode: 2, timedOut: false }] };
    const common = { repoPath: dir, pinnedBaseCommit: sha, allowedScope: ['src/'], commands, baseline, sandbox: { mode: 'none' as const } };
    const failed = await runWorkerCheckRound({ ...common, envelope: await envelope(dir, sha, { 'src/a.txt': 'first try\n' }) });
    expect(failed.status).toBe('failed');
    expect(failed.failedChecks).toEqual(['content check']);
    expect(failed.feedback).toContain('src/a.txt: expected fixed');
    expect(failed.feedback).not.toContain('broken on base');
    const passed = await runWorkerCheckRound({ ...common, envelope: await envelope(dir, sha, { 'src/a.txt': 'fixed\n' }) });
    expect(passed).toEqual({ status: 'passed', failedChecks: [] });
  });

  it('sends a scope violation back to the Worker but skips rounds it cannot fix', async () => {
    const { dir, sha } = await fixture();
    const common = { repoPath: dir, pinnedBaseCommit: sha, allowedScope: ['src/'], commands: [requireFixed], sandbox: { mode: 'none' as const } };
    const outside = await runWorkerCheckRound({ ...common, envelope: await envelope(dir, sha, { 'src/a.txt': 'fixed\n', 'docs/outside.txt': 'changed\n' }) });
    expect(outside.status).toBe('failed');
    expect(outside.failedChecks).toEqual(['allowed scope']);
    expect(outside.feedback).toContain('docs/outside.txt');
    const unchanged = await runWorkerCheckRound({ ...common, envelope: await envelope(dir, sha, {}) });
    expect(unchanged).toMatchObject({ status: 'skipped', reason: 'The Worker workspace has no changes to check' });
    const incomplete = await runWorkerCheckRound({ ...common, envelope: { ...(await envelope(dir, sha, { 'src/a.txt': 'x\n' })), complete: false } });
    expect(incomplete).toMatchObject({ status: 'skipped', reason: 'Bridge workspace snapshot is incomplete' });
  });
});
