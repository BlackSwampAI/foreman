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

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, message: string) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message); return git(cwd, 'rev-parse', 'HEAD'); };
const fullSha = /^[a-f0-9]{40}$/;
const hasCommit = (cwd: string, sha: string) => { try { git(cwd, 'cat-file', '-e', `${sha}^{commit}`); return true; } catch { return false; } };

afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }))); });

/** A dependent task whose approved predecessor was integrated with a new commit SHA,
 * as GitHub creates for squash and rebase merges. Every GitHub response comes from a
 * disposable fake `gh` executable, while the local checkout is a real temporary repo.
 */
async function fixture(options: { method?: 'squash'|'rebase'; mergeState?: 'merged'|'open'|'closed-unmerged'; head?: 'promoted'|'changed'; detailHead?: 'promoted'|'changed'; prRepo?: string; prBranch?: string; mergeSha?: 'integrated'|'test-merge'|'missing'|'unfetched' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'foreman-github-dependency-')); roots.push(root);
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'), integrationRepo = join(root, 'integration-repo'), data = join(root, 'data'), configPath = join(root, 'gh.json'), fakeGh = join(root, 'fake-gh');
  await mkdir(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'README.md'), 'base\n'); await writeFile(join(repo, 'unrelated.txt'), 'base\n');
  const base = commit(repo, 'base');
  await writeFile(join(repo, 'README.md'), 'promoted result\n'); const promoted = commit(repo, 'Foreman promoted result');
  git(repo, 'branch', 'foreman/results/run_prior', promoted);
  await mkdir(remote); git(remote, 'init', '--bare', '-q');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/project.git');
  git(repo, 'config', `url.file://${remote}.insteadOf`, 'https://github.com/acme/project.git');
  git(repo, 'push', '-q', 'origin', `${base}:refs/heads/main`, `${promoted}:refs/heads/foreman/results/run_prior`);
  // GitHub merges in a separate repository. Keep the resulting commit on that remote
  // until the test explicitly fetches it into the Foreman checkout.
  git(repo, 'clone', '-q', remote, integrationRepo);
  git(integrationRepo, 'config', 'user.name', 'GitHub fixture'); git(integrationRepo, 'config', 'user.email', 'github-fixture@example.invalid');
  await writeFile(join(integrationRepo, 'unrelated.txt'), 'base branch advanced\n'); commit(integrationRepo, 'advance base branch');
  if (options.method === 'rebase') git(integrationRepo, 'cherry-pick', promoted);
  else { git(integrationRepo, 'cherry-pick', '--no-commit', promoted); commit(integrationRepo, 'GitHub squash result'); }
  const integrated = git(integrationRepo, 'rev-parse', 'HEAD');
  git(integrationRepo, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  git(repo, 'checkout', '-q', '-B', 'main', base);
  const head = options.head === 'changed' ? 'c'.repeat(40) : promoted;
  const detailHead = options.detailHead === 'changed' ? 'e'.repeat(40) : head;
  const mergeSha = options.mergeSha === 'test-merge' ? 'd'.repeat(40) : options.mergeSha === 'missing' ? undefined : integrated;
  const response = { state: options.mergeState ?? 'merged', head, detailHead, headRepo: options.prRepo ?? 'acme/project', prBranch: options.prBranch ?? 'foreman/results/run_prior', mergeSha };
  await writeFile(configPath, JSON.stringify(response));
  await writeFile(fakeGh, `#!${process.execPath}
const fs=require('fs');const c=JSON.parse(fs.readFileSync(${JSON.stringify(configPath)},'utf8'));const a=process.argv.slice(2);const endpoint=a.find(x=>x.startsWith('repos/'));const out=x=>{fs.writeSync(1,JSON.stringify(x)+'\\n');process.exitCode=0};
if(a[0]==='api'&&endpoint==='repos/acme/project')out({default_branch:'main'});
else if(a[0]==='api'&&endpoint==='repos/acme/project/pulls')out([{number:7,state:c.state==='merged'?'closed':c.state==='open'?'open':'closed',merged:c.state==='merged',head:{sha:c.head,ref:c.prBranch,repo:{full_name:c.headRepo}},base:{ref:'main'}}]);
else if(a[0]==='api'&&endpoint==='repos/acme/project/pulls/7')out({number:7,state:c.state==='merged'?'closed':c.state==='open'?'open':'closed',merged:c.state==='merged',merge_commit_sha:c.mergeSha,head:{sha:c.detailHead,ref:c.prBranch,repo:{full_name:c.headRepo}},base:{ref:'main'}});
else {process.stderr.write('unhandled fake gh: '+a.join(' '));process.exitCode=1;}
`, { mode: 0o700 }); await chmod(fakeGh, 0o700);
  const state = initialState();
  const store = new JsonStore(join(root, 'state.json'));
  await store.mutate(s => {
    for (const role of s.roles) { role.enabled = true; role.availableConfigs = [{ harnessId: 'fixture', model: 'fixture-model' }]; role.config = { harnessId: 'fixture', model: 'fixture-model' }; }
    const project: any = { id: 'project_fixture', name: 'Fixture', status: 'active', defaultRoleConfigs: {}, createdAt: new Date().toISOString(), tasks: [] };
    const prior: any = { id: 'task_prior', title: 'Prior result', goal: 'Promote a result', suggestedAllowedPaths: ['README.md'], validationCriteria: ['Pass'], status: 'completed', createdAt: new Date().toISOString(), runs: [{ id: 'run_prior', status: 'completed', createdAt: new Date().toISOString(), sessions: { planner: { localId:'p',roleId:'planner',generation:1,status:'new',config:{harnessId:'fixture',model:'fixture-model'},startedAt:new Date().toISOString() }, orchestrator: { localId:'o',roleId:'orchestrator',generation:1,status:'new',config:{harnessId:'fixture',model:'fixture-model'},startedAt:new Date().toISOString() } }, sessionHistory: [], roleConfigs: {}, guidance: [], assignments: [], reviews: [], pinnedBaseCommit: base, approval: { id: 'approval', approved: true, decision: 'approved', createdAt: new Date().toISOString() }, promotion: { status: 'applied', destinationBranch: 'foreman/results/run_prior', resultCommit: promoted, updatedAt: new Date().toISOString() } }] };
    const later: any = { id: 'task_later', title: 'Dependent result', goal: 'Continue the work', suggestedAllowedPaths: ['README.md'], validationCriteria: ['Pass'], dependsOn: ['task_prior'], status: 'ready', createdAt: new Date().toISOString(), runs: [] };
    project.tasks.push(prior, later); s.projects.push(project);
  });
  await saveWorkspaceSetup(data, 'project_fixture', { repoPath: repo, allowedScope: ['README.md'], validationCommands: [{ name: 'fixture', command: 'true', args: [] }] });
  const integration = new GitHubIntegration(store, data, { ghPath: fakeGh });
  const adapter: UhpAdapter = { submit: async input => ({ externalId: `fixture-${input.roleId}`, responseId: `fixture-response-${input.roleId}`, sessionId: `fixture-session-${input.roleId}`, status: 'failed', outputText: 'Stop before dispatch.' }), cancel: async () => ({ status: 'cancelled' }) };
  const controller = new Controller(store, adapter);
  controller.configureVerifiedWorkspace({ repoPath: repo, allowedScope: ['README.md'], commands: [{ name: 'fixture', command: 'true', args: [] }], bridgeBaseUrl: 'http://fixture.invalid' });
  controller.setMergedResultResolver((runId, expected) => integration.mergedResultInHead(runId, expected));
  // Start eligibility reaches the normal task-start path while workspace isolation stays local.
  (controller as any).prepareWorkerWorkspace = async (runId: string, pinned: string) => store.mutate(s => { const run = s.projects.flatMap(p => p.tasks.flatMap(t => t.runs)).find(r => r.id === runId)!; run.pinnedBaseCommit = pinned; run.workspaceId = `fixture-${runId}`; });
  return { repo, remote, store, controller, integration, promoted, integrated, base, mergeSha, setCheckout:(sha: string) => git(repo, 'reset', '--hard', sha), hasCommit:(sha:string) => hasCommit(repo, sha), fetchIntegrated:() => { git(repo, 'fetch', '-q', 'origin', 'refs/heads/main'); git(repo, 'reset', '--hard', 'FETCH_HEAD'); }, remoteHasCommit:(sha:string) => git(remote, 'cat-file', '-e', `${sha}^{commit}`) === '' };
}

describe('GitHub merged dependency proof', () => {
  it.each(['squash', 'rebase'] as const)('allows preview and actual task start after a %s result commit is integrated locally', async method => {
    const f = await fixture({ method }); f.fetchIntegrated();
    // This test uses real Git ancestry; the scenario's resulting SHA is deliberately distinct
    // from Foreman's promoted SHA, as it is after both GitHub squash and rebase merges.
    expect(f.integrated).not.toBe(f.promoted); expect(fullSha.test(f.mergeSha!)).toBe(true);
    expect(await f.integration.mergedResultInHead('run_prior', f.promoted)).toMatchObject({ integrated: true, mergedCommit: f.integrated });
    const preview = await f.controller.taskStartPreview('task_later');
    expect(preview.canStart, JSON.stringify(preview.reasons)).toBe(true); expect(preview.reasons as string[]).toEqual([]);
    const started = await f.controller.startTaskWork('task_later', { scope: ['README.md'], validationCommands: [{ name: 'fixture', command: 'true', args: [] }], budgets: { roleTurns: { planner: 1, orchestrator: 1, worker: 1, reviewer: 1 }, workerAttempts: 1 } });
    expect(started.pinnedBaseCommit).toBe(f.integrated);
    expect((await f.store.load()).projects[0]!.tasks[1]!.runs).toHaveLength(1);
    for (let attempt = 0; attempt < 100; attempt++) { const latest = (await f.store.load()).projects[0]!.tasks[1]!.runs[0]!; if (!latest.controller?.active) break; await new Promise(resolve => setTimeout(resolve, 5)); if (attempt === 99) throw new Error('Fixture run did not reach its terminal state'); }
  });

  it('keeps the dependency blocked when GitHub merged it but the local checkout is stale or lacks the merge commit', async () => {
    const stale = await fixture(); stale.fetchIntegrated(); stale.setCheckout(stale.base);
    expect(stale.hasCommit(stale.integrated)).toBe(true);
    const staleProof=await stale.integration.mergedResultInHead('run_prior',stale.promoted);
    expect(staleProof).toMatchObject({integrated:false,mergedCommit:stale.integrated,currentHead:stale.base});
    expect(staleProof.message).toContain(`PR #7 as ${stale.integrated.slice(0,12)}`);
    expect(staleProof.message).toContain(`local HEAD ${stale.base.slice(0,12)}`);
    expect(staleProof.message).toContain('Open the completed task and choose “Update local checkout”');
    const preview = await stale.controller.taskStartPreview('task_later');
    expect(preview.canStart).toBe(false); expect((preview.reasons as string[]).join(' ')).toContain('Update local checkout');
    await expect(stale.controller.startTaskWork('task_later', { scope: ['README.md'] })).rejects.toThrow(/Update local checkout/);
    const noMerge = await fixture({ mergeSha: 'missing' }); noMerge.fetchIntegrated();
    expect(await noMerge.integration.mergedResultInHead('run_prior', noMerge.promoted)).toMatchObject({ integrated: false, message: expect.stringMatching(/usable merge commit SHA/i) });
    const noMergePreview = await noMerge.controller.taskStartPreview('task_later');
    expect(noMergePreview.canStart).toBe(false); expect((noMergePreview.reasons as string[]).join(' ')).toMatch(/usable merge commit SHA/i);
    await expect(noMerge.controller.startTaskWork('task_later', { scope: ['README.md'] })).rejects.toThrow(/usable merge commit SHA/i);
    const unfetched = await fixture({ mergeSha: 'unfetched' });
    expect(unfetched.remoteHasCommit(unfetched.mergeSha!)).toBe(true);
    expect(unfetched.hasCommit(unfetched.mergeSha!)).toBe(false);
    const unfetchedProof=await unfetched.integration.mergedResultInHead('run_prior',unfetched.promoted);
    expect(unfetchedProof.message).toContain(`PR #7 as ${unfetched.mergeSha!.slice(0,12)}`);
    expect(unfetchedProof.message).toContain(`local HEAD ${unfetched.base.slice(0,12)}`);
    expect(unfetchedProof.message).toContain('Open the completed task and choose “Update local checkout”');
    const unfetchedPreview=await unfetched.controller.taskStartPreview('task_later');
    expect(unfetchedPreview.canStart).toBe(false); expect((unfetchedPreview.reasons as string[]).join(' ')).toMatch(/Update local checkout/i);
    await expect(unfetched.controller.startTaskWork('task_later', { scope: ['README.md'] })).rejects.toThrow(/Update local checkout/i);
  });

  it.each([
    ['changed PR head', { head: 'changed' as const }, /head no longer matches/i],
    ['changed detail head after PR selection', { detailHead: 'changed' as const }, /head no longer matches/i],
    ['unrelated PR', { prRepo: 'other/project' }, /no matching GitHub pull request/i],
    ['wrong branch PR', { prBranch: 'foreman/results/unrelated' }, /no matching GitHub pull request/i],
    ['open PR test merge SHA', { mergeState: 'open' as const, mergeSha: 'test-merge' as const }, /not confirmed merged/i],
    ['closed but unmerged PR', { mergeState: 'closed-unmerged' as const }, /not confirmed merged/i],
  ] as const)('does not accept %s as integration evidence', async (_label, options, expectedReason) => {
    const f = await fixture(options); f.fetchIntegrated();
    const proof = await f.integration.mergedResultInHead('run_prior', f.promoted);
    expect(proof.integrated).toBe(false); expect(proof.message).toMatch(expectedReason);
    const preview = await f.controller.taskStartPreview('task_later');
    expect(preview.canStart).toBe(false); expect((preview.reasons as string[]).join(' ')).toMatch(expectedReason);
    await expect(f.controller.startTaskWork('task_later', { scope: ['README.md'] })).rejects.toThrow(expectedReason);
    expect((await f.store.load()).projects[0]!.tasks[1]!.runs).toHaveLength(0);
  });

  it('does not accept an open PR even when its reported SHA is already in local HEAD', async () => {
    const f = await fixture({ mergeState: 'open', mergeSha: 'integrated' }); f.fetchIntegrated();
    expect(f.hasCommit(f.integrated)).toBe(true);
    expect(git(f.repo, 'merge-base', '--is-ancestor', f.integrated, 'HEAD')).toBe('');
    const proof = await f.integration.mergedResultInHead('run_prior', f.promoted);
    expect(proof.integrated).toBe(false); expect(proof.message).toMatch(/not confirmed merged/i);
    const preview=await f.controller.taskStartPreview('task_later');
    expect(preview.canStart).toBe(false); expect((preview.reasons as string[]).join(' ')).toMatch(/not confirmed merged/i);
    await expect(f.controller.startTaskWork('task_later', { scope: ['README.md'] })).rejects.toThrow(/not confirmed merged/i);
  });

  it('shows actionable GitHub verification failures in both preview and task start', async () => {
    const f = await fixture();
    f.controller.setMergedResultResolver(async () => { throw new Error('GitHub authentication is unavailable. Run gh auth login.'); });
    const preview = await f.controller.taskStartPreview('task_later');
    expect(preview.canStart).toBe(false);
    expect((preview.reasons as string[]).join(' ')).toContain('GitHub authentication is unavailable. Run gh auth login.');
    await expect(f.controller.startTaskWork('task_later', { scope: ['README.md'] })).rejects.toThrow(/GitHub authentication is unavailable.*gh auth login/);
    expect((await f.store.load()).projects[0]!.tasks[1]!.runs).toHaveLength(0);
  });
});
