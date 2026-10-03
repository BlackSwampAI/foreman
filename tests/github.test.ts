import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initialState } from '../src/domain.js';
import { GitHubIntegration, confirmationToken, requireSameOriginWrite } from '../src/github.js';
import { JsonStore } from '../src/store.js';
import { saveWorkspaceSetup } from '../src/workspace-setup.js';

const dirs: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, message: string) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message); return git(cwd, 'rev-parse', 'HEAD'); };
const sha = (char: string) => char.repeat(40);

async function fixture(options: { auth?: boolean; pr?: boolean; ownPr?: boolean; checks?: 'none'|'pending'|'failed'|'passed'; changedHead?: boolean; mergeRefused?: boolean; queueRequired?: boolean; queueState?: string|null; emptyDiff?: boolean; mergeNotConfirmed?:boolean; allowSquash?:boolean; allowRebase?:boolean; allowMergeCommit?:boolean; merged?:boolean; closedUnmerged?:boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'foreman-github-fixture-')); dirs.push(root);
  const repo = join(root, 'repo'), remote = join(root, 'remote.git'), data = join(root, 'data');
  const fake = join(root, 'fake-gh');
  await mkdir(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(repo, 'README.md'), 'base\n'); const base = commit(repo, 'base');
  await writeFile(join(repo, 'README.md'), 'approved result\n'); const result = commit(repo, 'approved result');
  git(repo, 'branch', 'foreman/results/run_fixture', result);
  await mkdir(remote); git(remote, 'init', '--bare', '-q');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/project.git');
  git(repo, 'config', `url.file://${remote}.insteadOf`, 'https://github.com/acme/project.git');

  const projectId = 'project_fixture', runId = 'run_fixture', taskId = 'task_fixture';
  const state = initialState();
  state.projects.push({ id: projectId, name: 'Fixture', status: 'active', defaultRoleConfigs: {}, createdAt: new Date().toISOString(), tasks: [{ id: taskId, title: 'Fixture task', status: 'completed', createdAt: new Date().toISOString(), runs: [{ id: runId, status: 'completed', createdAt: new Date().toISOString(), sessions: {} as any, sessionHistory: [], roleConfigs: {}, guidance: [], assignments: [], reviews: [], pinnedBaseCommit: base, approval: { id: 'approval', approved: true, decision: 'approved', createdAt: new Date().toISOString() }, promotion: { status: 'applied', destinationBranch: 'foreman/results/run_fixture', resultCommit: result, resultTree: git(repo, 'rev-parse', `${result}^{tree}`), updatedAt: new Date().toISOString() } }] }] });
  const store = new JsonStore(join(data, 'state.json')); await store.mutate(s => Object.assign(s, state));
  await saveWorkspaceSetup(data, projectId, { repoPath: repo, allowedScope: ['README.md'], validationCommands: [{ name: 'fixture', command: 'true', args: [] }] });
  const config = { auth: options.auth ?? true, pr: options.pr ?? false, checks: options.checks ?? 'none', changedHead: options.changedHead ?? false, mergeRefused: options.mergeRefused ?? false, ownPr: options.ownPr ?? false, queueRequired: options.queueRequired ?? false, queueState: options.queueState ?? null, emptyDiff: options.emptyDiff ?? false, mergeNotConfirmed:options.mergeNotConfirmed??false, allowSquash:options.allowSquash??true, allowRebase:options.allowRebase??true, allowMergeCommit:options.allowMergeCommit??true, merged:options.merged??false, closedUnmerged:options.closedUnmerged??false };
  const nodePath = process.execPath;
  const script = `#!${nodePath}\nconst fs=require('fs');const config=JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'gh-config.json'))},'utf8'));const log=${JSON.stringify(join(root, 'gh-calls.json'))};const a=process.argv.slice(2),endpoint=a.find(x=>x.startsWith('repos/'));fs.appendFileSync(log,JSON.stringify(a)+'\\n');const out=x=>{fs.writeSync(1,JSON.stringify(x)+'\\n');process.exitCode=0};const fail=m=>{process.stderr.write(m+'\\n');process.exitCode=1};\nif(a[0]==='auth') {if(!config.auth) fail('not logged in');else process.exitCode=0}\nif(a[0]==='api'&&a.includes('user')){if(!config.auth)fail('not logged in');out({login:'fixture-user'})}\nif(a[0]==='api'&&a.some(x=>x==='repos/acme/project')&&!a.includes('user')&&!a.some(x=>x.includes('pulls'))){out({default_branch:'main',allow_squash_merge:config.allowSquash,allow_rebase_merge:config.allowRebase,allow_merge_commit:config.allowMergeCommit})}\nif(a[0]==='api'&&a.some(x=>x==='repos/acme/project/pulls')&&!a.includes('repos/acme/project/pulls/17')){const pr={number:17,html_url:'https://github.com/acme/project/pull/17',title:'Fixture PR',state:config.merged||config.closedUnmerged?'closed':'open',merged:config.merged,merge_commit_sha:config.merged?'${result}':null,node_id:'PR_kwDOFixture',head:{sha:config.changedHead?'${sha('c')}':'${result}',ref:'foreman/results/run_fixture',repo:{full_name:'acme/project'}},base:{ref:'main'},user:{login:config.ownPr?'fixture-user':'someone'}};out(config.pr?[pr]:[])}
if(a[0]==='api'&&a.some(x=>x==='repos/acme/project/pulls/17')){out({number:17,html_url:'https://github.com/acme/project/pull/17',title:'Fixture PR',state:config.merged||config.closedUnmerged?'closed':'open',merged:config.merged,merge_commit_sha:config.merged?'${result}':null,node_id:'PR_kwDOFixture',head:{sha:config.changedHead?'${sha('c')}':'${result}',ref:'foreman/results/run_fixture',repo:{full_name:'acme/project'}},base:{ref:'main'},user:{login:config.ownPr?'fixture-user':'someone'}});process.exitCode=0}
if(a[0]==='pr'&&a[1]==='view'){out({reviewDecision:null,mergeStateStatus:'CLEAN'});process.exitCode=0}
if(a[0]==='api'&&a.some(x=>x.includes('/rules/branches/'))){out(config.queueRequired?[{type:'merge_queue'}]:[])}
if(a[0]==='api'&&a[1]==='graphql'){
 const query=a.find(x=>x.startsWith('query='))||'';
 if(query.includes('mutation')){config.queueState='QUEUED';fs.writeFileSync(${JSON.stringify(join(root, 'gh-config.json'))},JSON.stringify(config));out({data:{enqueuePullRequest:{mergeQueueEntry:{state:'QUEUED'}}}})}
 else out({data:{node:{mergeQueueEntry:config.queueState?{state:config.queueState}:null}}})
}
if(a[0]==='api'&&a.some(x=>x.includes('/check-runs'))){const runs=config.checks==='none'?[]:[{name:'CI',status:config.checks==='pending'?'in_progress':'completed',conclusion:config.checks==='pending'?null:config.checks==='failed'?'failure':'success',html_url:'https://ci.example/check/1',output:{summary:config.checks==='pending'?'Waiting for runner':config.checks==='failed'?'Compilation failed':'All good'}}];out({check_runs:runs})}\nif(a[0]==='api'&&a.some(x=>x.includes('/status'))){out({statuses:[]})}\nif(a[0]==='api'&&a.some(x=>x.includes('/reviews?'))){out([])}\nif(a[0]==='pr'&&a[1]==='diff'){if(!config.emptyDiff)fs.writeSync(1,'diff --git a/README.md b/README.md\\n+approved result\\n');process.exitCode=0}\nif(a[0]==='api'&&a.some(x=>x.endsWith('/merge'))){if(config.mergeRefused)fail('protected branch update failed');else out({merged:!config.mergeNotConfirmed,message:config.mergeNotConfirmed?'Not mergeable':'Pull Request successfully merged'})}\nif(a[0]==='pr'&&a[1]==='create'){out({number:18})}\nif(a[0]==='api'&&a.some(x=>x.endsWith('/reviews'))){out({})}\nif(process.exitCode===undefined)fail('unhandled fake gh: '+a.join(' '));`;
  await writeFile(fake, script, { mode: 0o700 }); await chmod(fake, 0o700);
  const statePath = join(root, 'gh-calls.json'); await writeFile(join(root, 'gh-config.json'), JSON.stringify(config)); await writeFile(statePath, '');
  return { root, repo, remote, data, store, fake, statePath, base, result, integration: new GitHubIntegration(store, data, { ghPath: fake }) };
}
async function readCalls(f: Awaited<ReturnType<typeof fixture>>): Promise<string[]> { const text=await import('node:fs/promises').then(fs=>fs.readFile(f.statePath,'utf8'));return text.trim()?text.trim().split('\n').map(line=>JSON.parse(line).join(' ')):[]; }
afterEach(async () => { await Promise.all(dirs.map(path => rm(path, { recursive: true, force: true }))); });

describe('GitHub integration with fake gh and disposable repositories', () => {
  it('reports a linked result branch and no PR, while pinning every query to the configured repository', async () => {
    const f = await fixture(); const status = await f.integration.getRunStatus('run_fixture');
    expect(status.account).toBe('fixture-user'); expect(status).toMatchObject({ available: true, repository: 'acme/project', taskCommit: f.result, taskBranch: 'foreman/results/run_fixture' });
    expect(status.pullRequest).toBeUndefined(); expect(status.message).toMatch(/remote branch state could not be checked|No pull request/);
    expect((await readCalls(f)).filter(x => x.includes('repos/acme/project/pulls')).every(x => x.includes('head=acme:foreman/results/run_fixture'))).toBe(true);
  });
  it('distinguishes absent, pending, and failed checks and returns the PR diff and review list', async () => {
    const noChecks = await fixture({ pr: true, checks: 'none' });
    expect((await noChecks.integration.getRunStatus('run_fixture')).pullRequest).toMatchObject({ checksSummary: 'none', checks: [], diff: expect.stringContaining('README.md'), reviews: [] });
    const pending = await fixture({ pr: true, checks: 'pending' });
    expect((await pending.integration.getRunStatus('run_fixture')).pullRequest).toMatchObject({ checksSummary: 'pending', checks: [{ name: 'CI', summary: 'Waiting for runner', detailsUrl: 'https://ci.example/check/1' }] });
    const failed = await fixture({ pr: true, checks: 'failed' });
    expect((await failed.integration.getRunStatus('run_fixture')).pullRequest).toMatchObject({ checksSummary: 'failed', checks: [{ conclusion: 'failure', summary: 'Compilation failed' }] });
    const passed = await fixture({ pr: true, checks: 'passed' });
    expect((await passed.integration.getRunStatus('run_fixture')).pullRequest).toMatchObject({ checksSummary: 'passed', checks: [{ conclusion: 'success', summary: 'All good' }] });
  });
  it('treats a closed PR as merged only when GitHub sets merged=true and reports local readiness',async()=>{
    const merged=await fixture({pr:true,merged:true});
    expect(await merged.integration.getRunStatus('run_fixture')).toMatchObject({pullRequest:{state:'MERGED'},localReadiness:{integrated:true,currentHead:merged.result,mergedCommit:merged.result}});
    const closed=await fixture({pr:true,closedUnmerged:true});
    const closedStatus=await closed.integration.getRunStatus('run_fixture');
    expect(closedStatus.pullRequest?.state).toBe('CLOSED');expect(closedStatus.localReadiness).toBeUndefined();
  });
  it('detects an existing PR and does not create a duplicate', async () => {
    const f = await fixture({ pr: true });
    const result = await f.integration.openPullRequest('run_fixture');
    expect(result.actionResult).toMatch(/PR #17 already exists/);
    expect((await readCalls(f)).some(x => x.includes('pr create'))).toBe(false);
  });
  it('refuses to open a PR until the remote result branch matches the promoted commit', async () => {
    const missing = await fixture();
    await expect(missing.integration.openPullRequest('run_fixture')).rejects.toThrow(/remote result branch is not verified/);
    expect((await readCalls(missing)).some(x => x.includes('pr create'))).toBe(false);

    const different = await fixture();
    git(different.repo, 'push', 'origin', `${different.base}:refs/heads/foreman/results/run_fixture`);
    await expect(different.integration.openPullRequest('run_fixture')).rejects.toThrow(/remote result branch is not verified/);
    expect(git(different.remote, 'rev-parse', 'refs/heads/foreman/results/run_fixture')).toBe(different.base);
    expect((await readCalls(different)).some(x => x.includes('pr create'))).toBe(false);
  });
  it('pushes the exact promoted commit to a disposable bare remote and verifies its remote SHA', async () => {
    const f = await fixture();
    const pushed = await f.integration.pushResult('run_fixture');
    expect(pushed.remoteBranchSha).toBe(f.result);
    expect(pushed.remoteBranchStatus).toBe('matching');
    expect(git(f.remote, 'rev-parse', 'refs/heads/foreman/results/run_fixture')).toBe(f.result);
    const calls = await readCalls(f);
    expect(calls.some(x => x.includes('api --method GET user'))).toBe(true);
  });
  it('refuses to refresh a dirty local checkout before fetching or merging', async () => {
    const f = await fixture();
    await writeFile(join(f.repo, 'README.md'), 'operator edits\n');
    const head = git(f.repo, 'rev-parse', 'HEAD');
    await expect(f.integration.refreshLocal('run_fixture')).rejects.toThrow(/uncommitted changes/);
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(await import('node:fs/promises').then(fs=>fs.readFile(join(f.repo,'README.md'),'utf8'))).toBe('operator edits\n');
  });
  it('reports an unchanged local update and fast-forwards only the verified clean base branch', async()=>{
    const unchanged=await fixture();
    git(unchanged.repo,'branch','-M','main');git(unchanged.repo,'push','origin','main');
    const unchangedHead=git(unchanged.repo,'rev-parse','HEAD');
    const unchangedResult=await unchanged.integration.refreshLocal('run_fixture');
    expect(unchangedResult.actionResult).toMatch(/already current|No changes were needed/);
    expect(git(unchanged.repo,'rev-parse','HEAD')).toBe(unchangedHead);

    const advancing=await fixture();
    git(advancing.repo,'checkout','-q','--detach',advancing.base);
    git(advancing.repo,'branch','-f','main',advancing.base);
    const remoteHead=advancing.result;
    git(advancing.repo,'push','origin',`${remoteHead}:refs/heads/main`);
    git(advancing.repo,'checkout','-q','main');
    const updated=await advancing.integration.refreshLocal('run_fixture');
    expect(updated.actionResult).toMatch(/Updated clean local main checkout/);
    expect(git(advancing.repo,'rev-parse','HEAD')).toBe(remoteHead);
  });
  it('refuses to update from a different local branch',async()=>{
    const f=await fixture();git(f.repo,'branch','-M','operator-work');git(f.repo,'push','origin',`${f.base}:refs/heads/main`);
    await expect(f.integration.refreshLocal('run_fixture')).rejects.toThrow(/Local checkout is on operator-work/);
  });
  it('refuses a divergent update instead of creating a merge commit',async()=>{
    const f=await fixture();
    git(f.repo,'checkout','-q','--detach',f.base);git(f.repo,'branch','-f','main',f.base);
    git(f.repo,'push','origin',`${f.result}:refs/heads/main`);git(f.repo,'checkout','-q','main');
    await writeFile(join(f.repo,'README.md'),'local divergent change\n');const localHead=commit(f.repo,'local divergent change');
    await expect(f.integration.refreshLocal('run_fixture')).rejects.toThrow(/Could not fast-forward/);
    expect(git(f.repo,'rev-parse','HEAD')).toBe(localHead);
    expect(git(f.repo,'rev-parse','HEAD^')).toBe(f.base);
  });
  it('reports queue-required branch rules and explicitly enqueues only the reviewed, passing PR', async () => {
    const f = await fixture({ pr: true, checks: 'passed', queueRequired: true });
    const before = await f.integration.getRunStatus('run_fixture');
    expect(before.pullRequest).toMatchObject({ queueRequired: true, queueState: null, checksSummary: 'passed' });
    const queued = await f.integration.enqueuePullRequest('run_fixture', { reviewedHeadSha: f.result });
    expect(queued.actionResult).toMatch(/Submitted PR #17 to GitHub’s merge queue/);
    const calls = await readCalls(f);
    const mutation = calls.find(x => x.includes('api graphql') && x.includes('mutation'));
    expect(mutation).toContain(`expectedHeadOid=${f.result}`);
    expect(mutation).toContain('enqueuePullRequest');
    expect(mutation).not.toMatch(/jump|admin|auto-merge/i);
    expect(calls.some(x => x.includes('/rules/branches/main'))).toBe(true);
  });
  it('does not enqueue after the PR head changes or while checks are pending', async () => {
    const changed = await fixture({ pr: true, checks: 'passed', queueRequired: true, changedHead: true });
    await expect(changed.integration.enqueuePullRequest('run_fixture', { reviewedHeadSha: changed.result })).rejects.toThrow(/head changed/);
    expect((await readCalls(changed)).some(x => x.includes('mutation'))).toBe(false);
    const pending = await fixture({ pr: true, checks: 'pending', queueRequired: true });
    await expect(pending.integration.enqueuePullRequest('run_fixture', { reviewedHeadSha: pending.result })).rejects.toThrow(/checks must pass/);
    expect((await readCalls(pending)).some(x => x.includes('mutation'))).toBe(false);
  });
  it('handles missing gh authentication without exposing credential data', async () => {
    const f = await fixture({ auth: false }); const status = await f.integration.getRunStatus('run_fixture');
    expect(status.available).toBe(true); expect(status.account).toBeUndefined(); expect(status.message).toMatch(/authentication is unavailable/);
  });
  it('refuses review and direct merge when the PR diff is empty, without issuing GitHub writes', async () => {
    const f = await fixture({ pr: true, emptyDiff: true });
    await expect(f.integration.submitReview('run_fixture', { event: 'COMMENT', body: 'Review attempt', reviewedHeadSha: f.result })).rejects.toThrow(/complete PR diff is unavailable/);
    await expect(f.integration.mergePullRequest('run_fixture', { reviewedHeadSha: f.result })).rejects.toThrow(/complete PR diff is unavailable/);
    const calls = await readCalls(f);
    expect(calls.some(x => x.includes('--method POST') && x.includes('/reviews'))).toBe(false);
    expect(calls.some(x => x.endsWith('/merge'))).toBe(false);
  });
  it('rejects merge and queue submission when the reviewed current PR head is no longer Foreman’s promoted commit', async () => {
    const currentHead = sha('c');
    const merge = await fixture({ pr: true, changedHead: true });
    await expect(merge.integration.mergePullRequest('run_fixture', { reviewedHeadSha: currentHead })).rejects.toThrow(/no longer matches this run’s promoted commit/);
    expect((await readCalls(merge)).some(x => x.includes('/merge'))).toBe(false);

    const queue = await fixture({ pr: true, checks: 'passed', queueRequired: true, changedHead: true });
    await expect(queue.integration.enqueuePullRequest('run_fixture', { reviewedHeadSha: currentHead })).rejects.toThrow(/no longer matches this run’s promoted commit/);
    expect((await readCalls(queue)).some(x => x.includes('mutation'))).toBe(false);
  });
  it('refuses merge when the reviewed PR head changes and never sends a merge write', async () => {
    const f = await fixture({ pr: true, changedHead: true });
    await expect(f.integration.mergePullRequest('run_fixture', { reviewedHeadSha: f.result })).rejects.toThrow(/head changed|no longer matches/);
    expect((await readCalls(f)).some(x => x.includes('/merge'))).toBe(false);
  });
  it('defaults to squash, honors a selected merge method, and rejects repository-disabled methods', async () => {
    const squash=await fixture({pr:true});
    await squash.integration.mergePullRequest('run_fixture',{reviewedHeadSha:squash.result});
    expect((await readCalls(squash)).some(x=>x.includes('merge_method=squash'))).toBe(true);
    const rebase=await fixture({pr:true});
    await rebase.integration.mergePullRequest('run_fixture',{reviewedHeadSha:rebase.result,method:'rebase'});
    expect((await readCalls(rebase)).some(x=>x.includes('merge_method=rebase'))).toBe(true);
    const mergeCommit=await fixture({pr:true});
    await mergeCommit.integration.mergePullRequest('run_fixture',{reviewedHeadSha:mergeCommit.result,method:'merge'});
    expect((await readCalls(mergeCommit)).some(x=>x.includes('merge_method=merge'))).toBe(true);
    const disabled=await fixture({pr:true,allowRebase:false});
    await expect(disabled.integration.mergePullRequest('run_fixture',{reviewedHeadSha:disabled.result,method:'rebase'})).rejects.toThrow(/does not allow rebase/);
    expect((await readCalls(disabled)).some(x=>x.endsWith('/merge'))).toBe(false);
    const disabledCommit=await fixture({pr:true,allowMergeCommit:false});
    await expect(disabledCommit.integration.mergePullRequest('run_fixture',{reviewedHeadSha:disabledCommit.result,method:'merge'})).rejects.toThrow(/does not allow merge/);
  });
  it('does not report success when GitHub returns merged false',async()=>{
    const f=await fixture({pr:true,mergeNotConfirmed:true});
    await expect(f.integration.mergePullRequest('run_fixture',{reviewedHeadSha:f.result})).rejects.toThrow(/refused the merge|did not confirm/);
  });
  it('surfaces branch protection or merge queue refusal without bypassing it', async () => {
    const f = await fixture({ pr: true, mergeRefused: true });
    await expect(f.integration.mergePullRequest('run_fixture', { reviewedHeadSha: f.result })).rejects.toThrow(/refused the merge|protected branch update failed/);
    const calls = await readCalls(f); expect(calls.some(x => x.includes('/merge'))).toBe(true); expect(calls.some(x => /admin|auto-merge/i.test(x))).toBe(false);
  });
  it('requires explicit UI confirmations at write boundaries and blocks self approval', async () => {
    expect(confirmationToken('push')).toBe('PUSH_RESULT_BRANCH'); expect(confirmationToken('pr')).toBe('CREATE_PULL_REQUEST');
    expect(confirmationToken('review')).toBe('SUBMIT_REVIEW'); expect(confirmationToken('merge')).toBe('MERGE_PULL_REQUEST'); expect(confirmationToken('enqueue')).toBe('ENQUEUE_PULL_REQUEST');
    const f = await fixture({ pr: true });
    // The fixture PR author is different; the service still validates that approval is not self-authored.
    await f.integration.submitReview('run_fixture', { event: 'COMMENT', body: 'Looks good.', reviewedHeadSha: f.result });
    expect((await readCalls(f)).some(x => x.includes('/reviews'))).toBe(true);
    const own = await fixture({ pr: true, ownPr: true });
    await expect(own.integration.submitReview('run_fixture', { event: 'APPROVE', body: 'Approved', reviewedHeadSha: own.result })).rejects.toThrow(/cannot approve your own/);
    expect((await readCalls(own)).some(x => x.endsWith('/reviews'))).toBe(false);
    await f.store.mutate(s => { const r=s.projects[0]!.tasks[0]!.runs[0]!; r.approval!.approved=false; });
    await expect(f.integration.pushResult('run_fixture')).rejects.toThrow(/human-approved and Git-promoted/);
  });
  it('enforces same-origin confirmation on write routes', () => {
    const req = { headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }, socket: {} };
    const policy = { bindHost: '127.0.0.1', port: 3000 };
    expect(() => requireSameOriginWrite(req, { confirm: 'PUSH_RESULT_BRANCH' }, 'push', policy)).not.toThrow();
    const ipReq = { ...req, headers: { ...req.headers, host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' } };
    expect(() => requireSameOriginWrite(ipReq, { confirm: 'PUSH_RESULT_BRANCH' }, 'push', policy)).not.toThrow();
    expect(() => requireSameOriginWrite(req, {}, 'push', policy)).toThrow(/Explicit confirmation/);
    expect(() => requireSameOriginWrite({ ...req, headers: { ...req.headers, host: 'attacker.invalid:3000', origin: 'http://attacker.invalid:3000' } }, { confirm: 'PUSH_RESULT_BRANCH' }, 'push', policy)).toThrow(/configured local host and port|same-origin/);
    expect(() => requireSameOriginWrite({ ...req, headers: { ...req.headers, host: 'localhost:3001', origin: 'http://localhost:3001' } }, { confirm: 'PUSH_RESULT_BRANCH' }, 'push', policy)).toThrow(/configured local host and port|same-origin/);
  });
});

describe('CI failure log excerpts', () => {
  async function ciFailureFixture(options: { logLines?: string; checkUrl?: string } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'foreman-github-cifail-'));
    dirs.push(root);
    const repo = join(root, 'repo'), remote = join(root, 'remote.git'), data = join(root, 'data');
    const fake = join(root, 'fake-gh');
    await mkdir(repo);
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'F'); git(repo, 'config', 'user.email', 'f@f.invalid');
    await writeFile(join(repo, 'README.md'), 'base\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'README.md'), 'result\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'result');
    const result = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'branch', 'foreman/results/run_cifail', result);
    await mkdir(remote); git(remote, 'init', '--bare', '-q');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/project.git');
    git(repo, 'config', `url.file://${remote}.insteadOf`, 'https://github.com/acme/project.git');

    const checkUrl = options.checkUrl ?? 'https://github.com/acme/project/actions/runs/99999/jobs/12345';
    const logLines = options.logLines ?? [
      'check\tRun pnpm format:check\t2024-01-01T00:00:00Z\t[warn] docs/nba-support-audit.md',
      'check\tRun pnpm format:check\t2024-01-01T00:00:01Z\t[warn] some/other/file.md',
      'check\tRun pnpm format:check\t2024-01-01T00:00:02Z\tCode style issues found in the above file(s). Forgot to run Prettier?',
    ].join('\n');
    const callsLog = join(root, 'gh-calls.json');
    await writeFile(callsLog, '');
    const nodePath = process.execPath;
    const script = `#!${nodePath}\nconst fs=require('fs'),a=process.argv.slice(2),endpoint=a.find(x=>x.startsWith('repos/'));fs.appendFileSync(${JSON.stringify(callsLog)},JSON.stringify(a)+'\\n');\nif(a[0]==='auth')process.exitCode=0;\nif(a[0]==='api'&&a.some(x=>x==='user')){fs.writeSync(1,JSON.stringify({login:'u'})+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&a.some(x=>x.includes('repos/acme/project'))&&!a.some(x=>x.includes('pulls'))&&!a.some(x=>x.includes('check-runs'))&&!a.some(x=>x.includes('status'))&&!a.some(x=>x.includes('reviews'))){fs.writeSync(1,JSON.stringify({default_branch:'main'})+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&endpoint==='repos/acme/project/pulls'){fs.writeSync(1,JSON.stringify([{number:17,html_url:'https://github.com/acme/project/pull/17',title:'T',state:'open',node_id:'PR_x',head:{sha:'${result}',ref:'foreman/results/run_cifail',repo:{full_name:'acme/project'}},base:{ref:'main'},user:{login:'u'}}])+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&endpoint==='repos/acme/project/pulls/17'&&!a.some(x=>x.includes('/reviews'))&&!a.some(x=>x.includes('check-runs'))){fs.writeSync(1,JSON.stringify({number:17,html_url:'https://github.com/acme/project/pull/17',title:'T',state:'open',node_id:'PR_x',head:{sha:'${result}',ref:'foreman/results/run_cifail',repo:{full_name:'acme/project'}},base:{ref:'main'},user:{login:'u'}})+'\\n');process.exitCode=0;}\nif(a[0]==='pr'&&a[1]==='view'){fs.writeSync(1,JSON.stringify({reviewDecision:null,mergeStateStatus:'CLEAN'})+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&a.some(x=>x.includes('/check-runs'))){fs.writeSync(1,JSON.stringify({check_runs:[{name:'Check formatting',status:'completed',conclusion:'failure',html_url:${JSON.stringify(checkUrl)},output:{summary:'Code style issues'}}]})+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&a.some(x=>x.includes('/status'))){fs.writeSync(1,JSON.stringify({statuses:[]})+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&a.some(x=>x.includes('/reviews'))){fs.writeSync(1,JSON.stringify([])+'\\n');process.exitCode=0;}\nif(a[0]==='pr'&&a[1]==='diff'){fs.writeSync(1,'diff --git a/README.md b/README.md\\n+r\\n');process.exitCode=0;}\nif(a[0]==='api'&&a.some(x=>x.includes('/rules/branches/'))){fs.writeSync(1,JSON.stringify([])+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&a[1]==='graphql'){fs.writeSync(1,JSON.stringify({data:{node:{mergeQueueEntry:null}}})+'\\n');process.exitCode=0;}\nif(a[0]==='run'&&a[1]==='view'){fs.writeSync(1,${JSON.stringify(logLines)}+'\\n');process.exitCode=0;}\nif(process.exitCode===undefined){process.stderr.write('unhandled: '+a.join(' ')+'\\n');process.exitCode=1;}`;
    await writeFile(fake, script, { mode: 0o700 }); await chmod(fake, 0o700);

    const state = initialState();
    const projectId = 'project_cifail', runId = 'run_cifail', taskId = 'task_cifail';
    state.projects.push({ id: projectId, name: 'CIF', status: 'active', defaultRoleConfigs: {}, createdAt: new Date().toISOString(), tasks: [{ id: taskId, title: 'CIF task', status: 'completed', createdAt: new Date().toISOString(), runs: [{ id: runId, status: 'completed', createdAt: new Date().toISOString(), sessions: {} as any, sessionHistory: [], roleConfigs: {}, guidance: [], assignments: [], reviews: [], pinnedBaseCommit: base, approval: { id: 'a', approved: true, decision: 'approved', createdAt: new Date().toISOString() }, promotion: { status: 'applied', destinationBranch: 'foreman/results/run_cifail', resultCommit: result, resultTree: git(repo, 'rev-parse', `${result}^{tree}`), updatedAt: new Date().toISOString() } }] }] });
    const store = new JsonStore(join(data, 'state.json')); await store.mutate(s => Object.assign(s, state));
    await saveWorkspaceSetup(data, projectId, { repoPath: repo, allowedScope: ['README.md'], validationCommands: [{ name: 'T', command: 'true', args: [] }] });
    return { root, repo, data, store, fake, callsLog, base, result, integration: new GitHubIntegration(store, data, { ghPath: fake }) };
  }

  it('returns empty failures when no PR exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'foreman-cifail-nopr-'));
    dirs.push(root);
    const repo = join(root, 'repo'), data = join(root, 'data');
    await mkdir(repo);
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'T'); git(repo, 'config', 'user.email', 't@t.invalid');
    await writeFile(join(repo, 'README.md'), 'x'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'x');
    const base = git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'README.md'), 'y'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'y');
    const result = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'branch', 'foreman/results/run_nopr', result);
    git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/project.git');
    const fake = join(root, 'fake-gh');
    const nodePath = process.execPath;
    const script = `#!${nodePath}\nconst fs=require('fs'),a=process.argv.slice(2),endpoint=a.find(x=>x.startsWith('repos/'));\nif(a[0]==='auth')process.exitCode=0;\nif(a[0]==='api'&&a.some(x=>x==='user')){fs.writeSync(1,JSON.stringify({login:'u'})+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&a.some(x=>x.includes('repos/acme/project'))&&!a.some(x=>x.includes('pulls'))){fs.writeSync(1,JSON.stringify({default_branch:'main'})+'\\n');process.exitCode=0;}\nif(a[0]==='api'&&a.some(x=>x.includes('/pulls'))){fs.writeSync(1,JSON.stringify([])+'\\n');process.exitCode=0;}\nif(process.exitCode===undefined){process.stderr.write('unhandled: '+a.join(' '));process.exitCode=1;}`;
    await writeFile(fake, script, { mode: 0o700 }); await chmod(fake, 0o700);
    const state = initialState();
    state.projects.push({ id: 'project_nopr', name: 'NP', status: 'active', defaultRoleConfigs: {}, createdAt: new Date().toISOString(), tasks: [{ id: 'task_nopr', title: 'T', status: 'completed', createdAt: new Date().toISOString(), runs: [{ id: 'run_nopr', status: 'completed', createdAt: new Date().toISOString(), sessions: {} as any, sessionHistory: [], roleConfigs: {}, guidance: [], assignments: [], reviews: [], pinnedBaseCommit: base, approval: { id: 'a', approved: true, decision: 'approved', createdAt: new Date().toISOString() }, promotion: { status: 'applied', destinationBranch: 'foreman/results/run_nopr', resultCommit: result, resultTree: git(repo, 'rev-parse', `${result}^{tree}`), updatedAt: new Date().toISOString() } }] }] });
    const store = new JsonStore(join(data, 'state.json')); await store.mutate(s => Object.assign(s, state));
    await saveWorkspaceSetup(data, 'project_nopr', { repoPath: repo, allowedScope: ['README.md'], validationCommands: [{ name: 'T', command: 'true', args: [] }] });
    const integration = new GitHubIntegration(store, data, { ghPath: fake });
    const result2 = await integration.getCiFailures('run_nopr');
    expect(result2.failures).toHaveLength(0);
    expect(result2.source).toBe('no_pr');
  });

  it('fetches failed job logs and extracts prettier [warn] lines as excerpt', async () => {
    const f = await ciFailureFixture();
    const result = await f.integration.getCiFailures('run_cifail');
    expect(result.failures.length).toBeGreaterThan(0);
    const fail = result.failures[0]!;
    expect(fail.jobName).toBe('check');
    expect(fail.stepName).toBe('Run pnpm format:check');
    expect(fail.excerpt).toContain('[warn]');
    expect(fail.excerpt).toContain('nba-support-audit.md');
  });

  it('calls gh run view with --log-failed and passes the correct run ID', async () => {
    const f = await ciFailureFixture({ checkUrl: 'https://github.com/acme/project/actions/runs/77777/jobs/22222' });
    await f.integration.getCiFailures('run_cifail');
    const callText = await import('node:fs/promises').then(fs => fs.readFile(f.callsLog, 'utf8'));
    const calls: string[][] = callText.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const logCall = calls.find(c => c.includes('run') && c.includes('view') && c.includes('--log-failed'));
    expect(logCall).toBeDefined();
    expect(logCall).toContain('77777');
  });

  it('returns empty failures when check runs have no actions/runs URL', async () => {
    const f = await ciFailureFixture({ checkUrl: 'https://ci.external.example/build/123' });
    const result = await f.integration.getCiFailures('run_cifail');
    expect(result.failures).toHaveLength(0);
    expect(result.source).toBe('no_action_urls');
  });
});
