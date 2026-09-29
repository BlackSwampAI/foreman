import { createHash } from 'node:crypto';
import { snapshotGitCommit } from './git-workspace.js';
import { defaultNetworkAccess, type ValidationSandboxConfig } from './validation-sandbox.js';
import { validateWorkerOutput, type ValidationCommand, type VerifiedWorkerWorkspace } from './verified-workspace.js';
import type { BaselineValidation, ValidationCheck } from './domain.js';

/** Identity of a configured command list. Any change to a command's name, argv, cwd or network setting invalidates a cached baseline. */
export const baselineCommandDigest=(commands:readonly ValidationCommand[]):string=>createHash('sha256').update(JSON.stringify(commands.map(c=>[c.name,c.command,c.args,c.cwd??null,c.network??null]))).digest('hex');
/** A setup command (package-manager install or anything explicitly given network access) prepares the workspace for the checks that follow, so a baseline run always includes it. */
export const isSetupCommand=(c:ValidationCommand):boolean=>c.network??defaultNetworkAccess(c.command,c.args);
/** The commands a baseline run needs, in configured order: every setup command plus the named checks. */
export const baselineCommandsFor=(commands:readonly ValidationCommand[],names:ReadonlySet<string>):ValidationCommand[]=>commands.filter(c=>names.has(c.name)||isSetupCommand(c));
const passedCheck=(c:{exitCode:number|null;timedOut:boolean;outputTruncated:boolean})=>c.exitCode===0&&!c.timedOut&&!c.outputTruncated;

/** The unchanged pinned base as verified evidence with zero changes, so `validateWorkerOutput` materializes and sandboxes it exactly like a Worker snapshot. */
async function unchangedBaseEvidence(repoPath:string,pinnedBaseCommit:string,allowedScope:readonly string[]):Promise<VerifiedWorkerWorkspace>{
  const snapshot=await snapshotGitCommit(repoPath,pinnedBaseCommit);
  return {provenance:'recorded_replay',pinnedBaseCommit:snapshot.commit,completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:snapshot.entries.length},scopeVerified:true,allowedScope:[...allowedScope],entries:snapshot.entries,changes:[],reviewDiff:''};
}

/**
 * Run the setup commands plus the named failed checks once against the unchanged pinned base. The result is cached on the run by pinned base + command digest;
 * a check already in the cache is never run on the base again, so with an unchanged set of failing checks the baseline runs once per run.
 * Only a later failure of a check the cache has not seen extends it (setup commands rerun to prepare that workspace).
 */
export async function ensureBaseline(input:{repoPath:string;pinnedBaseCommit:string;allowedScope:readonly string[];commands:readonly ValidationCommand[];failedNames:readonly string[];cached?:BaselineValidation;timeoutMs?:number;maxOutputBytes?:number;sandbox?:ValidationSandboxConfig}):Promise<{baseline:BaselineValidation;ran:string[]}>{
  const commandDigest=baselineCommandDigest(input.commands),cached=input.cached&&input.cached.pinnedBaseCommit===input.pinnedBaseCommit&&input.cached.commandDigest===commandDigest?input.cached:undefined;
  const known=new Set((cached?.checks??[]).map(c=>c.name)),missing=new Set(input.failedNames.filter(n=>!known.has(n)));
  if(cached&&!missing.size)return {baseline:cached,ran:[]};
  const commands=baselineCommandsFor(input.commands,missing);
  const observed=await validateWorkerOutput({repoPath:input.repoPath,evidence:await unchangedBaseEvidence(input.repoPath,input.pinnedBaseCommit,input.allowedScope),commands,timeoutMs:input.timeoutMs,maxOutputBytes:input.maxOutputBytes,sandbox:input.sandbox});
  const checks=[...(cached?.checks??[])];
  for(const c of observed.checks)if(!checks.some(x=>x.name===c.name))checks.push({name:c.name,passed:passedCheck(c),exitCode:c.exitCode,timedOut:c.timedOut});
  return {baseline:{pinnedBaseCommit:input.pinnedBaseCommit,commandDigest,ranAt:new Date().toISOString(),checks},ran:commands.map(c=>c.name)};
}

/** Mark each failed check with whether it also failed on the base. A check the baseline never ran stays unmarked. */
export function markFailsOnBase(observations:ValidationCheck[],baseline:BaselineValidation):void{
  for(const o of observations){if(o.passed)continue;const base=baseline.checks.find(c=>c.name===o.name);if(base)o.failsOnBase=!base.passed;}
}
/** Failed checks the Worker's change can plausibly have caused: everything that does not also fail on the base. */
export const workerCausedFailures=(observations:readonly ValidationCheck[]):ValidationCheck[]=>observations.filter(o=>!o.passed&&o.failsOnBase!==true);
const baseFailingNames=(observations:readonly ValidationCheck[]):string[]=>observations.filter(o=>!o.passed&&o.failsOnBase===true).map(o=>o.name);
/** The operator-facing stop reason when every failed check also fails on the base, so a Worker retry cannot fix any of them. */
export function baseFailureStopReason(observations:readonly ValidationCheck[]):string|undefined{
  const base=baseFailingNames(observations);if(!base.length||workerCausedFailures(observations).length)return undefined;
  return `Checks also fail on the base commit, so a Worker retry cannot fix them: ${base.join(', ')}. Fix the check or its network setting, then retry validation.`;
}
/** Sentence for the Orchestrator correction note naming the base-failing checks that were left out of the failure excerpt. */
export function baseFailureNote(observations:readonly ValidationCheck[]):string{
  const base=baseFailingNames(observations);return base.length?`Also fails on base, not the Worker's to fix (ignore): ${base.join(', ')}. `:'';
}
