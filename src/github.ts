import { spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import { loadWorkspaceSetup } from './workspace-setup.js';
import type { JsonStore } from './store.js';
import type { Project, Run } from './domain.js';
import { sameOriginFailure, type HostPolicy } from './http-guard.js';
import { conventionalTitle, stripAutomationAttribution } from './github-naming.js';

export type GitHubReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
export type GitHubQueueState = 'AWAITING_CHECKS'|'LOCKED'|'MERGEABLE'|'QUEUED'|'UNMERGEABLE'|'unavailable'|null;
export interface GitHubCheck { name:string; status:string; conclusion:string|null; detailsUrl:string|null; summary:string|null }
export interface GitHubReview { author:string; state:string; body:string; submittedAt:string|null }
export interface GitHubPullRequest {
  number:number; url:string; title:string; state:string; headSha:string; baseBranch:string;
  reviewDecision:string|null; mergeState:string|null; checks:GitHubCheck[];
  checksSummary:'none'|'pending'|'failed'|'passed'; diff:string; reviews:GitHubReview[];
  diffTruncated:boolean; diffAvailable:boolean; canApprove?:boolean; mergeQueue:boolean;
  queueRequired:boolean|null; queueState:GitHubQueueState;
  mergeCommitSha?:string;
}
export interface GitHubRunStatus {
  available:boolean; remoteUrl?:string; repository?:string; account?:string; taskBranch?:string; taskCommit?:string;
  remoteBranchSha?:string|null; remoteBranchStatus?:'matching'|'missing'|'different'|'unavailable';
  pullRequest?:GitHubPullRequest; message?:string; actionResult?:string;
  localReadiness?:{integrated:boolean;currentHead?:string;mergedCommit?:string;message?:string};
  allowedMergeMethods?:Array<'squash'|'rebase'|'merge'>;
}
export interface CiJobFailure { jobName:string; stepName:string; excerpt:string }
export interface CiFailures { runId:string; failures:CiJobFailure[]; source?:string }
export interface GitHubIntegrationOptions { ghPath?:string; timeoutMs?:number; outputLimitBytes?:number }

const SHA=/^[a-f0-9]{40}$/i;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH=/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,240}$/;
const MAX_DIFF=512_000;
const confirmTokens={push:'PUSH_RESULT_BRANCH',pr:'CREATE_PULL_REQUEST',review:'SUBMIT_REVIEW',merge:'MERGE_PULL_REQUEST',enqueue:'ENQUEUE_PULL_REQUEST',refresh:'REFRESH_LOCAL'} as const;
type Json=Record<string,any>;
interface RunContext { project:Project; run:Run; repoPath:string; repository:string; remoteName:string; remoteUrl:string; remoteBranch:string }

/** Server-owned GitHub access. All GitHub CLI calls use argv and pin OWNER/REPO explicitly. */
export class GitHubIntegration {
  private readonly ghPath:string;
  private readonly timeoutMs:number;
  private readonly outputLimitBytes:number;
  constructor(private readonly store:JsonStore,private readonly dataDir:string,options:GitHubIntegrationOptions={}){
    this.ghPath=options.ghPath??process.env.FOREMAN_GH_PATH??'gh';
    this.timeoutMs=Math.min(30_000,Math.max(1_000,options.timeoutMs??12_000));
    this.outputLimitBytes=Math.min(2_000_000,Math.max(16_384,options.outputLimitBytes??1_000_000));
  }

  async getRunStatus(runId:string):Promise<GitHubRunStatus>{
    let context:RunContext;
    try{context=await this.context(runId);}catch(error){return {available:false,message:errorMessage(error)};}
    const base:GitHubRunStatus={available:true,remoteUrl:`https://github.com/${context.repository}`,repository:context.repository,taskBranch:context.run.promotion?.destinationBranch,taskCommit:context.run.promotion?.resultCommit};
    const auth=await this.account();
    if(!auth.account)return {...base,message:auth.message??'GitHub authentication is unavailable. Run gh auth login on the Foreman host.'};
    base.account=auth.account;
    if(!context.run.approval?.approved||context.run.promotion?.status!=='applied'||!context.run.promotion.destinationBranch||!context.run.promotion.resultCommit){return {...base,message:'Approve and promote this result in Foreman before publishing it to GitHub.'};}
    const remote=await this.remoteBranchState(context);
    base.remoteBranchSha=remote.sha;
    base.remoteBranchStatus=remote.status;
    const pr=await this.findPullRequest(context);
    if(!pr){
      const message=remote.status==='matching'?'No pull request exists for this result branch. Open a PR when you are ready.':remote.status==='different'?'The remote result branch points to a different commit. Review its state before publishing again.':remote.status==='unavailable'?'The remote branch state could not be checked. Verify the GitHub remote connection before publishing.':'No pull request exists for this result branch. Push the result branch, then open a PR.';
      return {...base,message};
    }
    const details=await this.pullRequestDetails(context,pr,auth.account);
    const allowedMergeMethods=await this.allowedMergeMethods(context.repository);
    const readiness=details.state==='MERGED'?await this.mergedResultInHead(context.run.id,context.run.promotion?.resultCommit??''):undefined;
    return {...base,pullRequest:details,allowedMergeMethods,...(readiness?{localReadiness:readiness}:{})};
  }

  async pushResult(runId:string):Promise<GitHubRunStatus>{
    const context=await this.promotedContext(runId);
    const status=await this.getRunStatus(runId);
    if(!status.account)throw httpError(503,status.message??'GitHub authentication is unavailable');
    await this.git(context.repoPath,['push',context.remoteName,`${context.run.promotion!.resultCommit}:refs/heads/${context.run.promotion!.destinationBranch}`]);
    const after=await this.getRunStatus(runId);
    if(after.remoteBranchSha?.toLowerCase()===context.run.promotion!.resultCommit!.toLowerCase())return {...after,actionResult:`Pushed ${context.run.promotion!.destinationBranch} to ${context.repository}; GitHub reports the expected commit.`};
    return {...after,actionResult:`The push command completed, but GitHub reports ${after.remoteBranchSha??'no branch commit'} for ${context.run.promotion!.destinationBranch}; expected ${context.run.promotion!.resultCommit}.`};
  }

  async openPullRequest(runId:string):Promise<GitHubRunStatus>{
    const context=await this.promotedContext(runId);
    const status=await this.getRunStatus(runId);
    if(!status.account)throw httpError(503,status.message??'GitHub authentication is unavailable');
    const existing=await this.findPullRequest(context);
    if(existing)return {...await this.getRunStatus(runId),actionResult:`PR #${existing.number} already exists; opened no duplicate.`};
    if(status.remoteBranchStatus!=='matching'||status.remoteBranchSha?.toLowerCase()!==context.run.promotion!.resultCommit!.toLowerCase())throw httpError(409,'The remote result branch is not verified at Foreman’s promoted commit. Push the result branch and refresh status before opening a PR.');
    const branch=context.run.promotion!.destinationBranch!;
    const baseBranch=await this.defaultBranch(context);
    const draft=context.run.prDraft;
    const task=context.project.tasks.find(item=>item.runs.some(run=>run.id===runId));
    const generatedDraft=draft&&draft.source!=='edited';
    const title=draft?(generatedDraft?conventionalTitle(draft.title,task?.goal??''):draft.title):conventionalTitle(task?.title??'chore: update project',task?.goal??'');
    const checks=context.run.validation?.observations??[];
    const verification=checks.length?checks.map((check:Json)=>`- ${String(check.name??'Validation')}: \`${String(check.command??'')} ${(Array.isArray(check.args)?check.args:[]).join(' ')}\` — ${check.passed?'PASS':'FAIL'}`):['- (no validation checks recorded)'];
    const body=draft?(generatedDraft?stripAutomationAttribution(draft.body):draft.body):`## Summary\n\n- ${task?.goal??task?.title??'Apply the approved repository change.'}\n\n## Verification\n\n${verification.join('\n')}`;
    await this.gh(['pr','create','--repo',context.repository,'--head',branch,'--base',baseBranch,'--title',title,'--body',body]);
    return {...await this.getRunStatus(runId),actionResult:'Pull request created.'};
  }

  async submitReview(runId:string,input:{event:GitHubReviewEvent;body:string;reviewedHeadSha:string}):Promise<GitHubRunStatus>{
    if(!['APPROVE','REQUEST_CHANGES','COMMENT'].includes(input.event))throw httpError(400,'Unsupported GitHub review event');
    if(typeof input.body!=='string'||input.body.length>20_000)throw httpError(400,'Review comment must be at most 20,000 characters');
    if(typeof input.reviewedHeadSha!=='string'||!SHA.test(input.reviewedHeadSha))throw httpError(400,'A full reviewed PR head SHA is required');
    if(input.event==='REQUEST_CHANGES'&&!input.body.trim())throw httpError(400,'Add a comment explaining the requested changes.');
    const context=await this.context(runId),auth=await this.requireAccount();
    const pr=await this.requirePullRequest(context);
    if(pr.user?.login===auth.account&&input.event==='APPROVE')throw httpError(409,'You cannot approve your own pull request. Ask another repository collaborator to review it.');
    const details=await this.pullRequestDetails(context,pr,auth.account);
    if(details.state!=='OPEN')throw httpError(409,`This pull request is ${details.state.toLowerCase()} and cannot be reviewed.`);
    if(!details.diffAvailable||details.diffTruncated)throw httpError(409,'The complete PR diff is unavailable. Refresh the PR diff before submitting a review.');
    if(details.headSha.toLowerCase()!==input.reviewedHeadSha.toLowerCase())throw httpError(409,'The PR head changed since you reviewed it. Refresh the PR, inspect the new diff and reviews, then confirm your review again.');
    const args=['api','--method','POST',`repos/${context.repository}/pulls/${pr.number}/reviews`,'-f',`event=${input.event}`,'-f',`commit_id=${input.reviewedHeadSha}`];
    if(input.body.trim())args.push('-f',`body=${input.body}`);
    await this.gh(args);
    return {...await this.getRunStatus(runId),actionResult:`GitHub review submitted: ${input.event.toLowerCase().replace('_',' ')}.`};
  }

  async mergePullRequest(runId:string,input:{reviewedHeadSha:string;method?:'squash'|'rebase'|'merge'}):Promise<GitHubRunStatus>{
    if(typeof input.reviewedHeadSha!=='string'||!SHA.test(input.reviewedHeadSha))throw httpError(400,'A full reviewed PR head SHA is required');
    const context=await this.context(runId),auth=await this.requireAccount();
    const method=input.method??'squash';
    if(!['squash','rebase','merge'].includes(method))throw httpError(400,'Choose squash, rebase, or merge commit.');
    const allowed=await this.allowedMergeMethods(context.repository);
    if(!allowed.includes(method))throw httpError(409,`This repository does not allow ${method} merges. Choose one of: ${allowed.join(', ')||'none'}.`);
    const pr=await this.requirePullRequest(context);
    const details=await this.pullRequestDetails(context,pr,auth.account);
    if(details.headSha.toLowerCase()!==input.reviewedHeadSha.toLowerCase())throw httpError(409,'The PR head changed since you reviewed it. Refresh the PR, inspect the new diff and reviews, then confirm merge again.');
    if(details.headSha.toLowerCase()!==context.run.promotion?.resultCommit?.toLowerCase())throw httpError(409,'The PR head no longer matches this run’s promoted commit. Refresh and review the Foreman result before merging.');
    if(details.state!=='OPEN')throw httpError(409,`This pull request is ${details.state.toLowerCase()} and cannot be merged.`);
    if(!details.diffAvailable||details.diffTruncated)throw httpError(409,'The complete PR diff is unavailable. Refresh and inspect the full diff before merging.');
    if(details.mergeQueue||details.queueRequired===true)throw httpError(409,'This PR requires or is already in GitHub’s merge queue. Use Foreman’s explicit Enqueue pull request action to submit it to the queue.');
    if(details.queueRequired===null||details.queueState==='unavailable')throw httpError(503,'Foreman could not verify whether this base branch requires a merge queue. Refresh GitHub status before merging.');
    // GitHub's merge API refuses branch protection failures rather than bypassing policy or enabling auto-merge.
    try{const response=parseJson((await this.gh(['api','--method','PUT',`repos/${context.repository}/pulls/${pr.number}/merge`,'-f',`sha=${input.reviewedHeadSha}`,'-f',`merge_method=${method}`])).stdout);if(response.merged!==true)throw new Error(String(response.message??'GitHub did not confirm that the pull request was merged.'));}
    catch(error){throw httpError(409,`GitHub refused the merge (branch protection, required checks or reviews may still be pending): ${errorMessage(error)}`);}
    return {...await this.getRunStatus(runId),actionResult:`Merged PR #${pr.number} using ${method==='merge'?'a merge commit':method}.`};
  }

  async enqueuePullRequest(runId:string,input:{reviewedHeadSha:string}):Promise<GitHubRunStatus>{
    if(typeof input.reviewedHeadSha!=='string'||!SHA.test(input.reviewedHeadSha))throw httpError(400,'A full reviewed PR head SHA is required');
    const context=await this.context(runId),auth=await this.requireAccount(),listed=await this.requirePullRequest(context);
    const details=await this.pullRequestDetails(context,listed,auth.account);
    if(details.headSha.toLowerCase()!==input.reviewedHeadSha.toLowerCase())throw httpError(409,'The PR head changed since you reviewed it. Refresh the PR, inspect the new diff and reviews, then confirm queue submission again.');
    if(details.headSha.toLowerCase()!==context.run.promotion?.resultCommit?.toLowerCase())throw httpError(409,'The PR head no longer matches this run’s promoted commit. Refresh and review the Foreman result before queue submission.');
    if(details.state!=='OPEN')throw httpError(409,`This pull request is ${details.state.toLowerCase()} and cannot be queued.`);
    if(!details.diffAvailable||details.diffTruncated)throw httpError(409,'The complete PR diff is unavailable. Refresh the PR diff before submitting it to the merge queue.');
    if(details.checksSummary!=='passed')throw httpError(409,'All reported PR checks must pass before submitting this PR to the merge queue.');
    if(details.queueRequired===null)throw httpError(503,'Foreman could not verify the base branch merge-queue rule. Refresh status or check GitHub branch rules before queue submission.');
    if(!details.queueRequired)throw httpError(409,'This base branch does not require a merge queue. Use the explicit Merge action instead.');
    if(details.queueState&&details.queueState!=='unavailable')return {...await this.getRunStatus(runId),actionResult:`PR #${details.number} is already in GitHub’s merge queue (${details.queueState}).`};
    if(details.queueState==='unavailable')throw httpError(503,'Foreman could not read this PR’s merge-queue state. Refresh status before trying again.');
    if(typeof listed.node_id!=='string'||! /^[A-Za-z0-9_=-]{5,200}$/.test(listed.node_id))throw httpError(502,'GitHub did not return a usable pull request node ID.');
    const query='mutation($pullRequestId:ID!,$expectedHeadOid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$pullRequestId,expectedHeadOid:$expectedHeadOid}){mergeQueueEntry{state}}}';
    const result=parseJson((await this.gh(['api','graphql','-f',`query=${query}`,'-F',`pullRequestId=${listed.node_id}`,'-F',`expectedHeadOid=${input.reviewedHeadSha}`])).stdout);
    if(Array.isArray(result.errors)&&result.errors.length)throw httpError(409,`GitHub refused to enqueue this PR: ${boundedText(result.errors.map((entry:Json)=>entry.message).join('; '),1000)}`);
    if(!result.data?.enqueuePullRequest)throw httpError(502,'GitHub did not confirm the merge-queue request. Refresh PR status before retrying.');
    return {...await this.getRunStatus(runId),actionResult:`Submitted PR #${details.number} to GitHub’s merge queue. Foreman does not enable auto-merge; GitHub will merge after the queue’s required checks pass.`};
  }

  async refreshLocal(runId:string):Promise<GitHubRunStatus>{
    const context=await this.context(runId),status=await this.getRunStatus(runId);
    if(!status.account)throw httpError(503,status.message??'GitHub authentication is unavailable; the local checkout was not changed.');
    const working=await this.git(context.repoPath,['status','--porcelain=v1','--untracked-files=normal']);
    if(working.trim())throw httpError(409,'The local repository has uncommitted changes. Commit or safely move them before refreshing the base branch.');
    const current=(await this.git(context.repoPath,['branch','--show-current'])).trim();
    const baseBranch=status.pullRequest?.baseBranch||context.remoteBranch;
    if(current!==baseBranch)throw httpError(409,`Local checkout is on ${current||'detached HEAD'}, while the PR base is ${baseBranch}. Switch to the base branch explicitly, then refresh local Git state.`);
    const before=(await this.git(context.repoPath,['rev-parse','--verify','HEAD'])).trim().toLowerCase();
    try{
      await this.git(context.repoPath,['fetch','--no-tags',context.remoteName,`refs/heads/${baseBranch}`]);
      const fetched=(await this.git(context.repoPath,['rev-parse','--verify','FETCH_HEAD^{commit}'])).trim();
      await this.git(context.repoPath,['merge','--ff-only',fetched]);
    }catch(error){throw httpError(409,`Could not fast-forward the clean local ${baseBranch} checkout. Resolve local divergence explicitly, then retry. ${errorMessage(error)}`);}
    const after=(await this.git(context.repoPath,['rev-parse','--verify','HEAD'])).trim().toLowerCase();
    const updated=await this.getRunStatus(runId);
    return {...updated,actionResult:before===after?`Local ${baseBranch} checkout is already current at ${after}. No changes were needed.`:`Updated clean local ${baseBranch} checkout from ${before.slice(0,12)} to ${after.slice(0,12)} using fast-forward only.`};
  }

  /** Fetch per-job log excerpts for the failed CI runs on this PR. Read-only. */
  async getCiFailures(runId:string):Promise<CiFailures>{
    const context=await this.context(runId);
    const pr=await this.findPullRequest(context);
    if(!pr)return {runId,failures:[],source:'no_pr'};
    const details=await this.pullRequestDetails(context,pr,'').catch(()=>undefined);
    if(!details)return {runId,failures:[],source:'pr_unavailable'};
    const failedChecks=details.checks.filter(c=>['failure','timed_out','cancelled','action_required','startup_failure'].includes(c.conclusion??''));
    if(!failedChecks.length)return {runId,failures:[],source:'no_failures'};
    // Extract GitHub Actions run IDs from detailsUrl: .../actions/runs/RUN_ID/jobs/JOB_ID
    const ciRunIds=new Map<string,string>(); // runId -> jobName
    for(const check of failedChecks){
      if(!check.detailsUrl)continue;
      const m=check.detailsUrl.match(/\/actions\/runs\/(\d+)/);
      if(m&&m[1])ciRunIds.set(m[1]!,check.name);
    }
    if(!ciRunIds.size)return {runId,failures:[],source:'no_action_urls'};
    const failures:CiJobFailure[]=[];
    const MAX_LOG=32_768; // 32KB per run log
    for(const [ghRunId] of ciRunIds){
      let logText='';
      try{
        const result=await this.gh(['run','view',ghRunId,'--log-failed','--repo',context.repository]);
        logText=result.stdout;
      }catch{continue;}
      // Strip ANSI codes
      logText=logText.replace(/\u001b(?:\[[0-9;]*[mGKHFJA-Za-z]|\][^\u0007]*\u0007|[PX^_][^\u001b]*\u001b\\)/g,'');
      // Parse tab-separated log lines: JOB\tSTEP\tTIMESTAMP\tCONTENT (or JOB\tSTEP\tCONTENT)
      const jobStepLines=new Map<string,string[]>();
      for(const line of logText.slice(0,MAX_LOG).split('\n')){
        const parts=line.split('\t');
        if(parts.length>=3){
          const jobName=parts[0]!.trim();
          const stepName=parts[1]!.trim();
          // Content is the rest (may include timestamp as part[2] and actual content as part[3])
          const content=parts.length>=4?parts.slice(3).join('\t'):parts.slice(2).join('\t');
          const key=`${jobName}\x00${stepName}`;
          if(!jobStepLines.has(key))jobStepLines.set(key,[]);
          jobStepLines.get(key)!.push(content);
        }
      }
      for(const [key,lines] of jobStepLines){
        const [jobName,stepName]=key.split('\x00') as [string,string];
        // Keep last 40 lines, highlight relevant ones
        const relevant=lines.filter(l=>/\[warn\]|\berror\b|error TS\d|FAIL\b|AssertionError|Expected|✕|×/.test(l));
        const excerpt=(relevant.length?relevant:lines).slice(-40).join('\n').trim().slice(0,2000);
        if(excerpt)failures.push({jobName,stepName,excerpt});
      }
    }
    return {runId,failures};
  }

  private async promotedContext(runId:string):Promise<RunContext>{
    const context=await this.context(runId);
    const run=context.run;
    if(!run.approval?.approved||run.approval.decision!=='approved'||run.promotion?.status!=='applied'||!run.promotion.destinationBranch||!run.promotion.resultCommit||!SHA.test(run.promotion.resultCommit))throw httpError(409,'A human-approved and Git-promoted Foreman result is required before publishing to GitHub.');
    if(!BRANCH.test(run.promotion.destinationBranch))throw httpError(409,'The promoted branch name is invalid.');
    const current=await this.git(context.repoPath,['rev-parse',`refs/heads/${run.promotion.destinationBranch}^{commit}`]);
    if(current.trim().toLowerCase()!==run.promotion.resultCommit.toLowerCase())throw httpError(409,'The local promoted branch no longer points at Foreman’s recorded result commit.');
    return context;
  }

  private async remoteBranchState(context:RunContext):Promise<{sha:string|null;status:'matching'|'missing'|'different'|'unavailable'}>{
    const branch=context.run.promotion?.destinationBranch,expected=context.run.promotion?.resultCommit;
    if(!branch||!expected)return {sha:null,status:'missing'};
    try{
      const output=await this.git(context.repoPath,['ls-remote','--heads',context.remoteName,`refs/heads/${branch}`]);
      const match=output.trim().match(/^([a-f0-9]{40}|[a-f0-9]{64})\s+refs\/heads\/(.+)$/i);
      if(!match||match[2]!==branch)return {sha:null,status:'missing'};
      const sha=match[1]!.toLowerCase();
      return {sha,status:sha===expected.toLowerCase()?'matching':'different'};
    }catch{return {sha:null,status:'unavailable'};}
  }

  private async context(runId:string):Promise<RunContext>{
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(runId))throw httpError(400,'Invalid run ID');
    const state=await this.store.load();let found:{project:Project;run:Run}|undefined;
    for(const project of state.projects)for(const task of project.tasks){const run=task.runs.find(item=>item.id===runId);if(run){found={project,run};break;}}
    if(!found)throw httpError(404,'Run not found');
    const setup=await loadWorkspaceSetup(this.dataDir,found.project.id).catch(()=>undefined);
    if(!setup)throw httpError(503,'This project has no saved local Git repository.');
    const remotes=(await this.git(setup.repoPath,['remote'])).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    let selected:{name:string;url:string;repository:string}|undefined;
    for(const name of remotes){const url=(await this.git(setup.repoPath,['config','--get',`remote.${name}.url`])).trim();const repository=repositoryFromRemote(url);if(repository){selected={name,url,repository};if(name==='origin')break;}}
    if(!selected)throw httpError(503,'No GitHub remote is configured for this project.');
    const branch=found.run.promotion?.destinationBranch;
    if(branch&&!BRANCH.test(branch))throw httpError(409,'The promoted branch name is invalid.');
    const remoteBranch=branch?await this.defaultBranchRaw(selected.repository).catch(()=>this.git(setup.repoPath,['symbolic-ref',`refs/remotes/${selected.name}/HEAD`]).then(x=>x.trim().replace(new RegExp(`^refs/remotes/${escapeRegExp(selected!.name)}/`),''),()=>'')):'';
    return {project:found.project,run:found.run,repoPath:setup.repoPath,repository:selected.repository,remoteName:selected.name,remoteUrl:selected.url,remoteBranch};
  }

  private async account():Promise<{account?:string;message?:string}>{
    try{await this.gh(['auth','status','--hostname','github.com']);const response=await this.gh(['api','--method','GET','user']);const user=parseJson(response.stdout);if(typeof user.login!=='string'||!user.login)return {message:'gh authenticated, but could not identify the account.'};return {account:user.login};}
    catch{return {message:'GitHub authentication is unavailable. Run gh auth login on the Foreman host.'};}
  }
  private async requireAccount():Promise<{account:string}>{const result=await this.account();if(!result.account)throw httpError(503,result.message??'GitHub authentication unavailable');return {account:result.account};}
  private async findPullRequest(context:RunContext):Promise<Json|undefined>{
    const branch=context.run.promotion?.destinationBranch;if(!branch)return;
    const owner=context.repository.split('/')[0]!;
    const result=await this.gh(['api','--method','GET',`repos/${context.repository}/pulls`,'-f',`head=${owner}:${branch}`,'-f','state=all','-f','per_page=100']);
    const prs=parseJson(result.stdout);if(!Array.isArray(prs))throw new Error('Unexpected GitHub PR list response');
    const owned=prs.filter((item:Json)=>item.head?.repo?.full_name?.toLowerCase()===context.repository.toLowerCase()&&item.head?.ref===branch);
    return owned.find((item:Json)=>item.head?.sha?.toLowerCase()===context.run.promotion?.resultCommit?.toLowerCase())??owned[0];
  }
  private async requirePullRequest(context:RunContext):Promise<Json>{const pr=await this.findPullRequest(context);if(!pr||!Number.isSafeInteger(pr.number)||pr.number<1)throw httpError(404,'No pull request exists for this Foreman result branch.');return pr;}
  private async pullRequestDetails(context:RunContext,listed:Json,account:string):Promise<GitHubPullRequest>{
    const number=Number(listed.number);if(!Number.isSafeInteger(number)||number<1)throw httpError(502,'GitHub returned an invalid pull request number');
    const pr=parseJson((await this.gh(['api','--method','GET',`repos/${context.repository}/pulls/${number}`])).stdout);
    if(pr.head?.repo?.full_name?.toLowerCase()!==context.repository.toLowerCase()||pr.head?.ref!==context.run.promotion?.destinationBranch)throw httpError(409,'The pull request head repository or branch does not match this Foreman result.');
    const ghView=parseJson((await this.gh(['pr','view',String(number),'--repo',context.repository,'--json','reviewDecision,mergeStateStatus'])).stdout);
    const headSha=typeof pr.head?.sha==='string'?pr.head.sha:'';
    if(!SHA.test(headSha))throw httpError(502,'GitHub did not return a full PR head SHA');
    const [checksResult,reviewsResult,diffResult]=await Promise.all([
      this.gh(['api','--method','GET',`repos/${context.repository}/commits/${headSha}/check-runs?per_page=100`]),
      this.gh(['api','--method','GET',`repos/${context.repository}/pulls/${number}/reviews?per_page=100`]),
      this.gh(['pr','diff',String(number),'--repo',context.repository])
    ]);
    const checksPayload=parseJson(checksResult.stdout),checks:GitHubCheck[]=Array.isArray(checksPayload.check_runs)?checksPayload.check_runs.map((check:Json)=>({name:String(check.name??'Unnamed check'),status:String(check.status??'unknown'),conclusion:typeof check.conclusion==='string'?check.conclusion:null,detailsUrl:safeHttpsUrl(check.html_url),summary:boundedText(check.output?.summary??check.output?.text??check.conclusion??check.status,2000)})):[];
    const statuses=await this.gh(['api','--method','GET',`repos/${context.repository}/commits/${headSha}/status`]).then(x=>parseJson(x.stdout)).catch(()=>({statuses:[]}));
    if(Array.isArray(statuses.statuses))for(const item of statuses.statuses)checks.push({name:String(item.context??'Status check'),status:item.state==='pending'?'in_progress':'completed',conclusion:item.state==='success'?'success':item.state==='failure'||item.state==='error'?'failure':null,detailsUrl:safeHttpsUrl(item.target_url),summary:boundedText(item.description??item.state,2000)});
    const checksSummary=checks.length===0?'none':checks.some((item:GitHubCheck)=>['failure','timed_out','cancelled','action_required','startup_failure','stale'].includes(item.conclusion??''))?'failed':checks.some((item:GitHubCheck)=>item.status!=='completed'||!item.conclusion)?'pending':'passed';
    const reviews=Array.isArray(parseJson(reviewsResult.stdout))?parseJson(reviewsResult.stdout).map((review:Json)=>({author:String(review.user?.login??'unknown'),state:String(review.state??'COMMENTED'),body:boundedText(review.body??'',8_000),submittedAt:typeof review.submitted_at==='string'?review.submitted_at:null})):[];
    const diffTruncated=diffResult.stdout.length>MAX_DIFF;
    const diff=boundedText(diffResult.stdout,MAX_DIFF)??'';
    const state=pr.merged===true?'MERGED':String(pr.state??'OPEN').toUpperCase(),mergeState=typeof ghView.mergeStateStatus==='string'?ghView.mergeStateStatus:null;
    const baseBranch=String(pr.base?.ref??'');
    const [queueRequired,queueState]=await Promise.all([this.queueRequired(context.repository,baseBranch),this.queueEntryState(String(pr.node_id??''))]);
    const mergeQueue=queueRequired===true||queueState!==null&&queueState!=='unavailable'||mergeState==='QUEUED'||mergeState==='MERGE_QUEUE';
    return {number,url:`https://github.com/${context.repository}/pull/${number}`,title:String(pr.title??''),state,headSha,baseBranch,reviewDecision:typeof ghView.reviewDecision==='string'?ghView.reviewDecision:null,mergeState,checks,checksSummary,diff,reviews,diffTruncated,diffAvailable:diff.length>0&&!diffTruncated,canApprove:pr.user?.login!==account,mergeQueue,queueRequired,queueState,...(typeof pr.merge_commit_sha==='string'?{mergeCommitSha:pr.merge_commit_sha}:{})};
  }
  /** Proof used by dependent tasks: only GitHub-confirmed merged PRs whose exact reviewed head is the promoted result count. */
  async mergedResultInHead(runId:string,expectedCommit:string):Promise<{integrated:boolean;mergedCommit?:string;currentHead?:string;message:string}>{
    const context=await this.context(runId),head=(await this.git(context.repoPath,['rev-parse','--verify','HEAD'])).trim().toLowerCase();
    if(!context.run.approval?.approved||context.run.approval.decision!=='approved'||context.run.promotion?.status!=='applied')return {integrated:false,currentHead:head,message:'This Foreman result does not have an approved, applied promotion.'};
    if(context.run.promotion?.resultCommit?.toLowerCase()!==expectedCommit.toLowerCase())return {integrated:false,currentHead:head,message:'The promoted result changed; refresh the task dependency.'};
    const listed=await this.findPullRequest(context);if(!listed)return {integrated:false,currentHead:head,message:'No matching GitHub pull request confirms this promoted result.'};
    const raw=parseJson((await this.gh(['api','--method','GET',`repos/${context.repository}/pulls/${listed.number}`])).stdout);
    if(raw.merged!==true||String(raw.state).toLowerCase()!=='closed')return {integrated:false,currentHead:head,message:'The pull request is not confirmed merged on GitHub.'};
    if(raw.head?.repo?.full_name?.toLowerCase()!==context.repository.toLowerCase()||raw.head?.ref!==context.run.promotion?.destinationBranch||raw.head?.sha?.toLowerCase()!==expectedCommit.toLowerCase())return {integrated:false,currentHead:head,message:'The merged pull request head no longer matches the reviewed Foreman result.'};
    const mergedCommit=typeof raw.merge_commit_sha==='string'&&SHA.test(raw.merge_commit_sha)?raw.merge_commit_sha.toLowerCase():undefined;
    if(!mergedCommit)return {integrated:false,currentHead:head,message:'GitHub confirmed the merge but did not provide a usable merge commit SHA.'};
    const integrated=await this.isAncestor(context.repoPath,mergedCommit,head);
    return {integrated,mergedCommit,currentHead:head,message:integrated?'The GitHub-confirmed merged result is already in the local checkout.':`GitHub merged PR #${listed.number} as ${mergedCommit.slice(0,12)}, but local HEAD ${head.slice(0,12)} does not include it. Open the completed task and choose “Update local checkout” before starting this task.`};
  }
  private async allowedMergeMethods(repository:string):Promise<Array<'squash'|'rebase'|'merge'>>{
    const repo=parseJson((await this.gh(['api','--method','GET',`repos/${repository}`])).stdout);
    return (['squash','rebase','merge'] as const).filter(method=>repo[method==='merge'?'allow_merge_commit':`allow_${method}_merge`]===true);
  }
  private async isAncestor(repoPath:string,ancestor:string,descendant:string):Promise<boolean>{try{await this.git(repoPath,['cat-file','-e',`${ancestor}^{commit}`]);await this.git(repoPath,['merge-base','--is-ancestor',ancestor,descendant]);return true;}catch{return false;}}
  private async queueRequired(repository:string,baseBranch:string):Promise<boolean|null>{
    if(!BRANCH.test(baseBranch))return null;
    try{const rules=parseJson((await this.gh(['api','--method','GET',`repos/${repository}/rules/branches/${encodeURIComponent(baseBranch)}`])).stdout);if(!Array.isArray(rules))return null;return rules.some((rule:Json)=>rule.type==='merge_queue');}catch{return null;}
  }
  private async queueEntryState(nodeId:string):Promise<GitHubQueueState>{
    if(!/^[A-Za-z0-9_=-]{5,200}$/.test(nodeId))return 'unavailable';
    const query='query($id:ID!){node(id:$id){... on PullRequest{mergeQueueEntry{state}}}}';
    try{const result=parseJson((await this.gh(['api','graphql','-f',`query=${query}`,'-F',`id=${nodeId}`])).stdout);if(Array.isArray(result.errors)&&result.errors.length)return 'unavailable';const state=result.data?.node?.mergeQueueEntry?.state;if(state===null||state===undefined)return null;return ['AWAITING_CHECKS','LOCKED','MERGEABLE','QUEUED','UNMERGEABLE'].includes(state)?state:'unavailable';}catch{return 'unavailable';}
  }
  private async defaultBranch(context:RunContext):Promise<string>{const branch=await this.defaultBranchRaw(context.repository);if(!BRANCH.test(branch))throw httpError(502,'GitHub returned an invalid default branch');return branch;}
  private async defaultBranchRaw(repository:string):Promise<string>{const result=parseJson((await this.gh(['api','--method','GET',`repos/${repository}`])).stdout);if(typeof result.default_branch!=='string'||!BRANCH.test(result.default_branch))throw new Error('Could not determine repository default branch');return result.default_branch;}
  private async gh(args:string[]):Promise<{stdout:string;stderr:string}>{const authEnv:Record<string,string>={GH_PROMPT:'disabled',GH_NO_UPDATE_NOTIFIER:'1'};for(const name of ['GH_TOKEN','GH_HOST'])if(process.env[name])authEnv[name]=process.env[name]!;return run(this.ghPath,args,process.cwd(),this.timeoutMs,this.outputLimitBytes,authEnv);}
  private async git(cwd:string,args:string[]):Promise<string>{return (await run('git',['-C',cwd,...args],cwd,this.timeoutMs,this.outputLimitBytes,{GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1'})).stdout;}
}

export function confirmationToken(kind:keyof typeof confirmTokens):string{return confirmTokens[kind];}
export type WriteHostPolicy=HostPolicy;
export function requireSameOriginWrite(req:{headers:Pick<IncomingMessage['headers'],'host'|'origin'|'sec-fetch-site'>;socket:unknown},body:unknown,kind:keyof typeof confirmTokens,hostPolicy:WriteHostPolicy):void{
  const failure=sameOriginFailure(req,hostPolicy);
  if(failure==='host')throw httpError(403,'GitHub writes are allowed only through Foreman’s configured local host and port.');
  if(failure==='invalid-origin')throw httpError(403,'GitHub writes require a valid same-origin request.');
  if(failure)throw httpError(403,'GitHub writes require a same-origin browser request.');
  const confirmation=(body&&typeof body==='object'&&!Array.isArray(body)?(body as Json).confirm:undefined);
  if(confirmation!==confirmTokens[kind])throw httpError(400,`Explicit confirmation is required (${confirmTokens[kind]}).`);
}

function repositoryFromRemote(url:string):string|undefined{
  const value=url.trim();let match=value.match(/^(?:https?:\/\/|ssh:\/\/)(?:[^@/]+@)?github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if(!match)match=value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  const repository=match?.[1];return repository&&REPO.test(repository)?repository:undefined;
}
function parseJson(text:string):any{try{return JSON.parse(text);}catch{throw httpError(502,'GitHub CLI returned an invalid response. Verify the GitHub CLI connection and try again.');}}
function escapeRegExp(value:string):string{return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function errorMessage(error:unknown):string{return error instanceof Error?error.message:'GitHub integration unavailable';}
function httpError(statusCode:number,message:string):Error{return Object.assign(new Error(message),{statusCode});}
function boundedText(value:unknown,max:number):string|null{if(value===undefined||value===null||value==='')return null;const text=String(value);return text.length<=max?text:`${text.slice(0,max)}\n[truncated]`;}
function safeHttpsUrl(value:unknown):string|null{if(typeof value!=='string')return null;try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.toString():null;}catch{return null;}}
function run(command:string,args:string[],cwd:string,timeoutMs:number,maxBytes:number,extraEnv:Record<string,string>):Promise<{stdout:string;stderr:string}>{
  return new Promise((resolvePromise,reject)=>{
    const child=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe'],windowsHide:true,env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',...(process.env.XDG_CONFIG_HOME?{XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME}:{}),...extraEnv}});
    const out:Buffer[]=[],err:Buffer[]=[];let size=0,settled=false;
    const fail=(error:Error)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGKILL');reject(error);};
    const timer=setTimeout(()=>fail(httpError(504,`${command==='gh'?'GitHub CLI':'Git'} command timed out`)),timeoutMs);
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes)fail(httpError(502,`${command==='gh'?'GitHub CLI':'Git'} output exceeded the configured limit`));else out.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{if(err.reduce((n,b)=>n+b.length,0)<8192)err.push(chunk.subarray(0,8192));});
    child.once('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(httpError(503,command==='gh'?'GitHub CLI could not be started':'Git could not be started'));});
    child.once('close',(code,signal)=>{if(settled)return;settled=true;clearTimeout(timer);const stdout=Buffer.concat(out).toString('utf8'),stderr=Buffer.concat(err).toString('utf8').trim().slice(0,1000);if(code!==0)reject(httpError(502,stderr||`${command==='gh'?'GitHub CLI':'Git'} command failed${signal?` (${signal})`:''}`));else resolvePromise({stdout,stderr});});
  });
}
