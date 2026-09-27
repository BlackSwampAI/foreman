import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, type UhpAdapter } from '../src/controller.js';
import { initialState } from '../src/domain.js';
import { GitHubIntegration } from '../src/github.js';
import { JsonStore } from '../src/store.js';
import { saveWorkspaceSetup } from '../src/workspace-setup.js';

const dirs: string[] = [];
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, message: string) => {
  git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message); return git(cwd, 'rev-parse', 'HEAD');
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

/** Build a minimal store with a promoted run, optional validation checks and reviewer recommendation. */
async function makePromotedRun(options: {
  plannerOutput?: string;
  plannerFails?: boolean;
  withEvidence?: boolean;
  withReviewer?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'foreman-prdraft-'));
  dirs.push(root);
  const store = new JsonStore(join(root, 'state.json'));
  let uhpOutput = options.plannerOutput ?? JSON.stringify({
    title: 'Add feature X',
    body: '## Summary\n\n- Added feature X\n- Fixed edge case',
  });
  const uhp: UhpAdapter = {
    submit: async () => {
      if (options.plannerFails) throw new Error('UHP unavailable');
      return { externalId: 'ext-draft', status: 'completed', outputText: uhpOutput };
    },
    cancel: async () => ({ status: 'cancelled' }),
  };
  const state = initialState();
  const projectId = 'prj_pr-draft-project';
  const taskId = 'tsk_pr-draft-task';
  const runId = 'run_pr-draft';
  const baseCommit = 'a'.repeat(40);
  const resultCommit = 'b'.repeat(40);
  const now = new Date().toISOString();
  const stamp = now;
  const checks = options.withEvidence ? [
    { name: 'Install dependencies', command: 'pnpm', args: ['install', '--frozen-lockfile'], exitCode: 0, timedOut: false, output: 'Done', outputTruncated: false, startedAt: stamp, finishedAt: stamp, passed: true },
    { name: 'Tests', command: 'pnpm', args: ['run', 'test'], exitCode: 0, timedOut: false, output: 'All tests pass', outputTruncated: false, startedAt: stamp, finishedAt: stamp, passed: true },
  ] : [];
  const reviewer = options.withReviewer ? {
    id: 'rec_reviewer-1', status: 'proposed' as const, provenance: 'uhp_response' as const,
    reviewerAssignmentId: 'assign_reviewer-1', harnessId: 'claude-code', model: 'opus',
    responseId: 'resp_reviewer-1', reviewMode: 'read_only' as const, mutationAttempted: false as const,
    verdict: 'recommend' as const, rationale: 'Looks good. Well-scoped change.', createdAt: stamp,
  } : undefined;
  state.projects.push({
    id: projectId, name: 'PR Draft Project', status: 'active',
    defaultRoleConfigs: {}, createdAt: stamp, tasks: [{
      id: taskId, title: 'Add feature X', goal: 'Implement feature X to solve the problem',
      validationCriteria: ['Feature X works correctly'], status: 'completed', createdAt: stamp,
      runs: [{
        id: runId, status: 'awaiting_approval', createdAt: stamp,
        sessions: {} as any, sessionHistory: [], roleConfigs: {},
        guidance: [], assignments: [], reviews: [],
        pinnedBaseCommit: baseCommit,
        workerEvidence: options.withEvidence ? {
          provenance: 'bridge_snapshot', workerAssignmentId: 'assign_worker-1',
          responseId: 'resp_worker-1', pinnedBaseCommit: baseCommit,
          completeSnapshot: { reportedComplete: true, reportedErrors: 0, entryCount: 2 },
          scopeVerified: true, allowedScope: ['src/'], entries: [],
          changes: [{ path: 'src/feature.ts', kind: 'add' }, { path: 'src/index.ts', kind: 'modify' }],
          reviewDiff: 'diff --git a/src/feature.ts b/src/feature.ts\n+export function featureX() {}\n',
          acceptance: 'not_decided' as const,
        } : undefined,
        validation: checks.length ? {
          id: 'val_1', status: 'passed' as const, passed: true, reportedPassed: true,
          checks: checks.map(c => ({ name: c.name, passed: c.passed })),
          observations: checks,
          policy: { requireAllChecksPass: true as const, configuredCheckCount: checks.length },
          createdAt: stamp,
        } : undefined,
        reviewerRecommendation: reviewer,
        approval: { id: 'approval_1', approved: true, decision: 'approved' as const, createdAt: stamp },
        promotion: {
          status: 'applied' as const, destinationBranch: 'foreman/results/run_pr-draft',
          resultCommit, resultTree: 'c'.repeat(40), updatedAt: stamp,
        },
      }],
    }],
  });
  state.roles.forEach(r => {
    r.enabled = true;
    r.config = { harnessId: 'claude-code', model: 'opus' };
    r.availableConfigs = [{ harnessId: 'claude-code', model: 'opus' }];
  });
  await store.mutate(s => Object.assign(s, state));
  const controller = new Controller(store, uhp);
  return { store, controller, runId, resultCommit };
}

describe('PR draft generation', () => {
  it('generates title and body from planner output and appends deterministic Verification section', async () => {
    const { controller, runId, resultCommit } = await makePromotedRun({
      withEvidence: true,
      withReviewer: true,
      plannerOutput: JSON.stringify({
        title: 'Add feature X',
        body: '## Summary\n\n- Added feature X implementation\n- Cleaned up edge cases',
      }),
    });
    const draft = await controller.generatePrDraft(runId);
    expect(draft.title).toBe('Add feature X');
    expect(draft.body).toContain('## Summary');
    expect(draft.body).toContain('Added feature X implementation');
    expect(draft.body).toContain('## Verification');
    expect(draft.body).toContain('Install dependencies');
    expect(draft.body).toContain('PASS');
    expect(draft.body).toContain(`Foreman run ${runId}`);
    expect(draft.body).toContain(resultCommit.slice(0, 12));
    expect(draft.body).toContain('recommend');
    expect(draft.source).toBe('planner');
  });

  it('falls back to a deterministic template when model output is invalid', async () => {
    const { controller, runId } = await makePromotedRun({
      withEvidence: true,
      plannerOutput: 'not valid json at all',
    });
    const draft = await controller.generatePrDraft(runId);
    expect(draft.source).toBe('template');
    expect(draft.title).toBeTruthy();
    expect(draft.body).toContain('## Summary');
  });

  it('falls back to template when UHP fails', async () => {
    const { controller, runId } = await makePromotedRun({ plannerFails: true });
    const draft = await controller.generatePrDraft(runId);
    expect(draft.source).toBe('template');
    expect(draft.title).toBeTruthy();
  });

  it('clamps title to 72 characters', async () => {
    const longTitle = 'A'.repeat(200);
    const { controller, runId } = await makePromotedRun({
      plannerOutput: JSON.stringify({ title: longTitle, body: '## Summary\n\n- Something' }),
    });
    const draft = await controller.generatePrDraft(runId);
    expect(draft.title.length).toBeLessThanOrEqual(72);
  });

  it('returns 409 if promotion is not applied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'foreman-prdraft-nopromo-'));
    dirs.push(root);
    const store = new JsonStore(join(root, 'state.json'));
    const uhp: UhpAdapter = { submit: async () => ({ externalId: 'x', status: 'completed', outputText: '{}' }), cancel: async () => ({ status: 'cancelled' }) };
    await store.mutate(s => {
      s.roles.forEach(r => { r.enabled = true; r.config = { harnessId: 'claude-code', model: 'opus' }; r.availableConfigs = [{ harnessId: 'claude-code', model: 'opus' }]; });
    });
    const controller = new Controller(store, uhp);
    const project: any = await controller.createProject('P');
    const task: any = await controller.createTask(project.id, 'T');
    const run: any = await controller.createRun(task.id);
    // Run has no promotion — should get 409
    await expect(controller.generatePrDraft(run.id)).rejects.toThrow(/requires a promoted run/);
  });

  it('guards against concurrent generation', async () => {
    const { controller, runId } = await makePromotedRun({
      plannerOutput: JSON.stringify({ title: 'T', body: '## Summary\n\n- x' }),
    });
    // Kick off two concurrent calls
    const [r1, r2] = await Promise.allSettled([
      controller.generatePrDraft(runId),
      controller.generatePrDraft(runId),
    ]);
    const succeeded = [r1, r2].filter(r => r.status === 'fulfilled');
    const failed = [r1, r2].filter(r => r.status === 'rejected');
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect((failed[0] as PromiseRejectedResult).reason.message).toMatch(/in progress/);
  });

  it('stores draft in run and persists it', async () => {
    const { controller, store, runId } = await makePromotedRun({
      plannerOutput: JSON.stringify({ title: 'My PR', body: '## Summary\n\n- Did the thing' }),
    });
    await controller.generatePrDraft(runId);
    const state = await store.load();
    const run = state.projects[0]!.tasks[0]!.runs[0]!;
    expect(run.prDraft?.title).toBe('My PR');
    expect(run.prDraft?.source).toBe('planner');
  });

  it('allows human editing with updatePrDraft and stores source=edited', async () => {
    const { controller, store, runId } = await makePromotedRun({});
    await controller.generatePrDraft(runId);
    const edited = await controller.updatePrDraft(runId, {
      title: 'Hand-edited title',
      body: '## Summary\n\n- Manually reviewed',
    });
    expect(edited.source).toBe('edited');
    expect(edited.title).toBe('Hand-edited title');
    const state = await store.load();
    expect(state.projects[0]!.tasks[0]!.runs[0]!.prDraft?.source).toBe('edited');
  });

  it('rejects an empty or too-long title in updatePrDraft', async () => {
    const { controller, runId } = await makePromotedRun({});
    await expect(controller.updatePrDraft(runId, { title: '', body: '## Summary\n\n- x' })).rejects.toThrow(/non-empty and at most 72/);
    await expect(controller.updatePrDraft(runId, { title: 'A'.repeat(73), body: '## Summary\n\n- x' })).rejects.toThrow(/non-empty and at most 72/);
  });
});

describe('PR draft used by openPullRequest', () => {
  it('uses prDraft title and body when creating the PR', async () => {
    const root = await mkdtemp(join(tmpdir(), 'foreman-prdraft-gh-'));
    dirs.push(root);
    const repo = join(root, 'repo'), remote = join(root, 'remote.git'), data = join(root, 'data');
    const fake = join(root, 'fake-gh');
    await mkdir(repo);
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'T'); git(repo, 'config', 'user.email', 't@t.invalid');
    await writeFile(join(repo, 'README.md'), 'base\n'); const base = commit(repo, 'base');
    await writeFile(join(repo, 'README.md'), 'result\n'); const result = commit(repo, 'result');
    git(repo, 'branch', 'foreman/results/run_prdraft', result);
    await mkdir(remote); git(remote, 'init', '--bare', '-q');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/project.git');
    git(repo, 'config', `url.file://${remote}.insteadOf`, 'https://github.com/acme/project.git');
    const nodePath = process.execPath;
    const callsLog = join(root, 'gh-calls.json');
    const script = `#!${nodePath}\nconst fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(callsLog)},JSON.stringify(a)+'\\n');\nif(a[0]==='auth')process.exitCode=0;\nif(a[0]==='api'&&a.some(x=>x==='user')){process.stdout.write(JSON.stringify({login:'u'})+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&a.some(x=>x.includes('repos/acme/project'))&&!a.some(x=>x.includes('pulls'))){process.stdout.write(JSON.stringify({default_branch:'main'})+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&a.some(x=>x.includes('repos/acme/project/pulls'))&&a[1]==='--method'&&a[2]==='GET'){process.stdout.write(JSON.stringify([])+'\\n');process.exitCode=0;}\nif(a[0]==='pr'&&a[1]==='create'){process.stdout.write(JSON.stringify({number:99})+'\\n');process.exitCode=0;}\nif(process.exitCode===undefined){process.stderr.write('unhandled: '+a.join(' ')+'\\n');process.exitCode=1;}`;
    await writeFile(fake, script, { mode: 0o700 }); await chmod(fake, 0o700);
    await writeFile(callsLog, '');
    const state = initialState();
    const projectId = 'project_prdraft', runId = 'run_prdraft', taskId = 'task_prdraft';
    state.projects.push({ id: projectId, name: 'PD', status: 'active', defaultRoleConfigs: {}, createdAt: new Date().toISOString(), tasks: [{ id: taskId, title: 'PD task', status: 'completed', createdAt: new Date().toISOString(), runs: [{ id: runId, status: 'completed', createdAt: new Date().toISOString(), sessions: {} as any, sessionHistory: [], roleConfigs: {}, guidance: [], assignments: [], reviews: [], pinnedBaseCommit: base, approval: { id: 'a', approved: true, decision: 'approved', createdAt: new Date().toISOString() }, promotion: { status: 'applied', destinationBranch: 'foreman/results/run_prdraft', resultCommit: result, resultTree: git(repo, 'rev-parse', `${result}^{tree}`), updatedAt: new Date().toISOString() }, prDraft: { title: 'My custom PR title', body: '## Summary\n\n- Custom body text', source: 'planner', generatedAt: new Date().toISOString() } }] }] });
    const store = new JsonStore(join(data, 'state.json')); await store.mutate(s => Object.assign(s, state));
    await saveWorkspaceSetup(data, projectId, { repoPath: repo, allowedScope: ['README.md'], validationCommands: [{ name: 'T', command: 'true', args: [] }] });
    // Push the result branch to remote first so the check passes
    git(repo, 'push', 'origin', `${result}:refs/heads/foreman/results/run_prdraft`);
    const integration = new GitHubIntegration(store, data, { ghPath: fake });
    await integration.openPullRequest(runId);
    const callLines = (await import('node:fs/promises')).readFile(callsLog, 'utf8');
    const calls: string[][] = (await callLines).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const prCreate = calls.find(c => c.includes('pr') && c.includes('create'));
    expect(prCreate).toBeDefined();
    const titleIdx = prCreate!.indexOf('--title');
    expect(prCreate![titleIdx + 1]).toBe('My custom PR title');
    const bodyIdx = prCreate!.indexOf('--body');
    expect(prCreate![bodyIdx + 1]).toContain('Custom body text');
    // Should NOT contain the default placeholder
    expect(prCreate![bodyIdx + 1]).not.toContain('Foreman result run_');
  });

  it('falls back to default title/body when no prDraft is set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'foreman-prdraft-fallback-'));
    dirs.push(root);
    const repo = join(root, 'repo'), remote = join(root, 'remote.git'), data = join(root, 'data');
    const fake = join(root, 'fake-gh');
    await mkdir(repo);
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'T'); git(repo, 'config', 'user.email', 't@t.invalid');
    await writeFile(join(repo, 'README.md'), 'base\n'); const base = commit(repo, 'base');
    await writeFile(join(repo, 'README.md'), 'result\n'); const result = commit(repo, 'result');
    git(repo, 'branch', 'foreman/results/run_nodraft', result);
    await mkdir(remote); git(remote, 'init', '--bare', '-q');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/project.git');
    git(repo, 'config', `url.file://${remote}.insteadOf`, 'https://github.com/acme/project.git');
    const nodePath = process.execPath;
    const callsLog = join(root, 'gh-calls.json');
    const script = `#!${nodePath}\nconst fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(callsLog)},JSON.stringify(a)+'\\n');\nif(a[0]==='auth')process.exitCode=0;\nif(a[0]==='api'&&a.some(x=>x==='user')){process.stdout.write(JSON.stringify({login:'u'})+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&a.some(x=>x.includes('repos/acme/project'))&&!a.some(x=>x.includes('pulls'))){process.stdout.write(JSON.stringify({default_branch:'main'})+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&a.some(x=>x.includes('repos/acme/project/pulls'))&&a[1]==='--method'&&a[2]==='GET'){process.stdout.write(JSON.stringify([])+'\\n');process.exitCode=0;}\nif(a[0]==='pr'&&a[1]==='create'){process.stdout.write(JSON.stringify({number:99})+'\\n');process.exitCode=0;}\nif(process.exitCode===undefined){process.stderr.write('unhandled: '+a.join(' ')+'\\n');process.exitCode=1;}`;
    await writeFile(fake, script, { mode: 0o700 }); await chmod(fake, 0o700);
    await writeFile(callsLog, '');
    const state = initialState();
    const projectId = 'project_nodraft', runId = 'run_nodraft', taskId = 'task_nodraft';
    state.projects.push({ id: projectId, name: 'ND', status: 'active', defaultRoleConfigs: {}, createdAt: new Date().toISOString(), tasks: [{ id: taskId, title: 'ND task', status: 'completed', createdAt: new Date().toISOString(), runs: [{ id: runId, status: 'completed', createdAt: new Date().toISOString(), sessions: {} as any, sessionHistory: [], roleConfigs: {}, guidance: [], assignments: [], reviews: [], pinnedBaseCommit: base, approval: { id: 'a', approved: true, decision: 'approved', createdAt: new Date().toISOString() }, promotion: { status: 'applied', destinationBranch: 'foreman/results/run_nodraft', resultCommit: result, resultTree: git(repo, 'rev-parse', `${result}^{tree}`), updatedAt: new Date().toISOString() } }] }] });
    const store = new JsonStore(join(data, 'state.json')); await store.mutate(s => Object.assign(s, state));
    await saveWorkspaceSetup(data, projectId, { repoPath: repo, allowedScope: ['README.md'], validationCommands: [{ name: 'T', command: 'true', args: [] }] });
    git(repo, 'push', 'origin', `${result}:refs/heads/foreman/results/run_nodraft`);
    const integration = new GitHubIntegration(store, data, { ghPath: fake });
    await integration.openPullRequest(runId);
    const callLines = (await import('node:fs/promises')).readFile(callsLog, 'utf8');
    const calls: string[][] = (await callLines).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const prCreate = calls.find(c => c.includes('pr') && c.includes('create'));
    expect(prCreate).toBeDefined();
    const titleIdx = prCreate!.indexOf('--title');
    expect(prCreate![titleIdx + 1]).toContain('Foreman result');
  });
});
