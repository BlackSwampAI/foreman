import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Controller, type UhpAdapter } from '../src/controller.js';
import { buildRepoDigest } from '../src/repo-digest.js';
import { JsonStore } from '../src/store.js';

const LIMIT = 15_000;
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository big enough that an unbounded digest overflows the 15,000 byte prompt limit: many files plus a long README. */
async function makeBigRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'foreman-digest-budget-repo-')); dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 'test@test.com'); git(repo, 'config', 'user.name', 'Test');
  const baseFilePaths: string[] = [];
  for (let i = 0; i < 500; i++) {
    const dir = join('src', `module-with-a-long-name-${i % 20}`, `feature-area-${i % 7}`);
    await mkdir(join(repo, dir), { recursive: true });
    const path = join(dir, `component-with-a-descriptive-name-${i}.ts`);
    await writeFile(join(repo, path), `export function retryHandler${i}() { return 'bridge prompt_limit retry ${i}'; }\n`);
    baseFilePaths.push(path);
  }
  await writeFile(join(repo, 'README.md'), Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: ${'The controller retries bridge prompt_limit failures with a bounded backoff. '.repeat(3)}`).join('\n'));
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'big-repo', scripts: { build: 'tsc', test: 'vitest' }, dependencies: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`dependency-number-${i}`, '1.0.0'])) }));
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
  return { repo, head: git(repo, 'rev-parse', 'HEAD'), baseFilePaths };
}

async function setup(reply: string) {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-digest-budget-')); dirs.push(dir);
  const store = new JsonStore(join(dir, 'state.json'));
  await store.mutate(state => { for (const role of state.roles) { role.enabled = true; role.availableConfigs = [{ harnessId: 'antigravity-cli', model: 'agy-fixture' }]; role.config = { harnessId: 'antigravity-cli', model: 'agy-fixture' }; } });
  const submissions: any[] = [];
  const uhp: UhpAdapter = { submit: async input => { submissions.push(input); return { externalId: `ext-${submissions.length}`, responseId: `resp-${submissions.length}`, sessionId: 'session-fixture', status: 'completed', outputText: reply }; }, cancel: async () => ({ status: 'cancelled' }) };
  return { store, controller: new Controller(store, uhp), submissions };
}

// Each Planner/Orchestrator turn builds a real digest from a 500-file git fixture, which is slow on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

describe('repo digest is sized from the remaining prompt budget', () => {
  it('fixture: an unbounded digest alone overflows the prompt limit', async () => {
    const { repo, head } = await makeBigRepo();
    const digest = await buildRepoDigest({ repoPath: repo, commit: head, allowedScope: [], keywords: ['retry', 'bridge'] });
    expect(bytes(digest.text)).toBeGreaterThan(LIMIT);
    expect(bytes(digest.text)).toBeLessThanOrEqual(24 * 1024);
  });

  it('Antigravity Planner turn: includes a truncated digest instead of throwing 413', async () => {
    const { repo } = await makeBigRepo();
    const { store, controller, submissions } = await setup('{"reply":"ok"}');
    controller.configureVerifiedWorkspace({ repoPath: repo, allowedScope: ['src/', 'README.md', 'package.json'], commands: [{ name: 't', command: 'true', args: [] }] });
    const project: any = await controller.createProject('Digest budget');
    await controller.sendProjectPlannerMessage(project.id, 'Please add retry handling to the controller when the bridge returns prompt_limit');
    const prompt: string = submissions.find(s => s.roleId === 'planner').prompt;
    expect(bytes(prompt)).toBeLessThanOrEqual(LIMIT);
    expect(prompt).toContain('## Repository file tree');
    expect(prompt).not.toContain('Repository digest omitted');
    const assignment = (await store.load()).projects[0]!.plannerAssignments!.at(-1)!;
    expect(assignment.repoAccess).toMatchObject({ mode: 'digest' });
    expect(assignment.repoAccess!.reason).toContain('antigravity-cli');
    expect(assignment.repoAccess!.reason).not.toContain('omitted');
  });

  it('Planner keeps room for recent conversation next to the digest', async () => {
    const { repo } = await makeBigRepo();
    const { controller, submissions } = await setup('{"reply":"ok"}');
    controller.configureVerifiedWorkspace({ repoPath: repo, allowedScope: ['src/', 'README.md', 'package.json'], commands: [{ name: 't', command: 'true', args: [] }] });
    const project: any = await controller.createProject('Digest budget');
    for (let i = 1; i <= 4; i++) await controller.sendProjectPlannerMessage(project.id, `Message ${i}. ${'Discuss the retry design in detail. '.repeat(30)}`);
    const prompt: string = submissions.at(-1).prompt;
    expect(bytes(prompt)).toBeLessThanOrEqual(LIMIT);
    expect(prompt).toContain('## Repository file tree');
    const conversation = prompt.slice(prompt.indexOf('Recent bounded project conversation:'), prompt.indexOf('Current human message:'));
    expect(bytes(conversation)).toBeGreaterThanOrEqual(1_500);
    expect(conversation).toContain('Message 3.');
  });

  it('Planner omits the digest and says so when a near-maximum human message leaves no room for it', async () => {
    const { repo } = await makeBigRepo();
    const { store, controller, submissions } = await setup('{"reply":"ok"}');
    const scope = ['src/', 'README.md', 'package.json', ...Array.from({ length: 40 }, (_, i) => `docs/generated-section-number-${i}/`)];
    controller.configureVerifiedWorkspace({ repoPath: repo, allowedScope: scope, commands: [{ name: 't', command: 'true', args: [] }] });
    const project: any = await controller.createProject('Digest budget');
    await controller.sendProjectPlannerMessage(project.id, `Plan this. ${'x'.repeat(11_989)}`);
    const prompt: string = submissions.find(s => s.roleId === 'planner').prompt;
    expect(bytes(prompt)).toBeLessThanOrEqual(LIMIT);
    expect(prompt).toContain('Repository digest omitted: prompt budget exhausted');
    expect(prompt).not.toContain('## Repository file tree');
    const assignment = (await store.load()).projects[0]!.plannerAssignments!.at(-1)!;
    expect(assignment.repoAccess).toMatchObject({ mode: 'digest' });
    expect(assignment.repoAccess!.reason).toContain('Repository digest omitted: prompt budget exhausted');
  });

  async function orchestratorFixture(options: { note?: string; guidance?: string[] } = {}) {
    const { repo, head, baseFilePaths } = await makeBigRepo();
    const fixture = await setup(JSON.stringify({ workerTask: 'Update README.md', targetFiles: ['README.md'] }));
    const { store, controller } = fixture;
    controller.configureVerifiedWorkspace({ repoPath: repo, allowedScope: ['src/', 'README.md'], commands: [{ name: 't', command: 'true', args: [] }] });
    const project: any = await controller.createProject('Digest budget');
    const task: any = await controller.createTask(project.id, {
      title: 'Add retry handling', goal: `Goal. ${'Retry the bridge call when prompt_limit is returned. '.repeat(75)}`.slice(0, 4_000),
      suggestedAllowedPaths: ['src/'], validationCriteria: Array.from({ length: 30 }, (_, i) => `Criterion ${i}: ${'the behaviour is covered by a test '.repeat(5)}`.slice(0, 190)),
    });
    const run: any = await controller.createRun(task.id);
    await store.mutate(state => {
      const current = state.projects[0]!.tasks[0]!.runs[0]!;
      current.pinnedBaseCommit = head; current.workspaceId = 'workspace-fixture'; current.baseFilePaths = baseFilePaths;
      current.projectPlannerContext = `PLANNER-CONTEXT ${'The planner explained the retry design at length. '.repeat(400)}`;
      current.roleConfigs.worker = { harnessId: 'antigravity-cli', model: 'agy-fixture' };
    });
    for (const text of options.guidance ?? [`Guidance one. ${'g'.repeat(1_500)}`, `Guidance two. ${'h'.repeat(1_500)}`, `Guidance three. ${'i'.repeat(1_500)}`, `Guidance four. ${'j'.repeat(1_500)}`]) await controller.addGuidance(run.id, text);
    fixture.submissions.length = 0;
    return { ...fixture, run, note: options.note ?? 'Prepare a bounded Worker task for the retry handling.' };
  }

  it('Antigravity Orchestrator turn: trims Foreman context so a truncated digest still fits', async () => {
    const { store, controller, submissions, run, note } = await orchestratorFixture();
    const result: any = await controller.orchestrate(run.id, note);
    const prompt: string = submissions.find(s => s.roleId === 'orchestrator').prompt;
    expect(bytes(prompt)).toBeLessThanOrEqual(LIMIT);
    expect(prompt).toContain('## Repository file tree');
    expect(prompt).not.toContain('Repository digest omitted');
    expect(prompt).toContain(note);
    const current = (await store.load()).projects[0]!.tasks[0]!.runs[0]!;
    expect(current.assignments.find(a => a.id === result.assignment.id)!.repoAccess).toMatchObject({ mode: 'digest' });
    // Guidance that did not fit stays queued for a later turn; only guidance the model actually saw is marked delivered.
    for (const guidance of current.guidance) expect(prompt.includes(guidance.id)).toBe(guidance.status === 'delivered');
    expect(current.guidance.some(g => g.status === 'delivered')).toBe(true);
  });

  it('Orchestrator omits the digest and says so when the operator note leaves no room for it', async () => {
    const note = `Prepare a bounded task. ${'n'.repeat(11_976)}`;
    const { store, controller, submissions, run } = await orchestratorFixture({ note });
    const result: any = await controller.orchestrate(run.id, note);
    const prompt: string = submissions.find(s => s.roleId === 'orchestrator').prompt;
    expect(bytes(prompt)).toBeLessThanOrEqual(LIMIT);
    expect(prompt).toContain('Repository digest omitted: prompt budget exhausted');
    const assignment = (await store.load()).projects[0]!.tasks[0]!.runs[0]!.assignments.find(a => a.id === result.assignment.id)!;
    expect(assignment.repoAccess).toMatchObject({ mode: 'digest' });
    expect(assignment.repoAccess!.reason).toContain('Repository digest omitted: prompt budget exhausted');
  });
});
