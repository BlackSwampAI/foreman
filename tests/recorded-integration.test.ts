import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, type UhpAdapter } from '../src/controller.js';
import { JsonStore } from '../src/store.js';

const dirs:string[]=[];
const bundle=resolve('tests/fixtures/recorded-worker-base.bundle');
const evidencePath=resolve('investigations/local-cli-uhp/evidence/actual-workspace-smoke.json');
type RecordedEvidence={baseCommit:string;responseId:string;sessionId:string;actualModel:string;scopeVerified:true;completeSnapshot:{reportedComplete:boolean;reportedErrors:number;entryCount:number};reviewDiff:string;changes:Array<{kind:string;path:string;before?:any;after?:any}>};
async function setup(validationPass=true,reviewVerdict:'recommend'|'reject'='recommend') {
  const dir=await mkdtemp(join(tmpdir(),'foreman-recorded-fixture-'));dirs.push(dir);const repoPath=join(dir,'repo');
  execFileSync('git',['clone','--quiet',bundle,repoPath],{stdio:'pipe'});
  const recorded=JSON.parse(await readFile(evidencePath,'utf8')) as RecordedEvidence;
  const store=new JsonStore(join(dir,'state.json'));
  const uhpCalls:{role:string;prompt:string}[]=[];
  const uhp:UhpAdapter={submit:async input=>{uhpCalls.push({role:input.roleId,prompt:input.prompt});return {externalId:input.roleId==='worker'?recorded.responseId:`sim-${input.roleId}-response`,responseId:input.roleId==='worker'?recorded.responseId:`sim-${input.roleId}-response`,sessionId:input.roleId==='worker'?recorded.sessionId:undefined,status:'completed',actualModel:input.roleId==='worker'?recorded.actualModel:'simulated-reviewer-v1',selectedHarnessId:input.roleId==='worker'?'claude-code':'fixture-reviewer',usage:input.roleId==='worker'?{inputTokens:6,outputTokens:328,cachedInputTokens:9105}:undefined,outputText:input.roleId==='reviewer'?JSON.stringify({verdict:reviewVerdict,rationale:'Deterministic simulated Reviewer fixture; no model call was made.'}):'bounded fixture Worker completed'};},cancel:async()=>({status:'cancelled'})};
  const controller=new Controller(store,uhp);
  await store.mutate(s=>{for(const role of s.roles){const config={harnessId:role.id==='reviewer'?'fixture-reviewer':'claude-code',model:role.id==='reviewer'?'simulated-reviewer-v1':'opus'};role.enabled=true;role.config=config;role.availableConfigs=[config];}});
  for(const role of ['planner','orchestrator','worker','reviewer'])await controller.selectRoleConfig(role,{harnessId:role==='reviewer'?'fixture-reviewer':'claude-code',model:role==='reviewer'?'simulated-reviewer-v1':'opus'});
  const project:any=await controller.createProject('Recorded Worker evidence'),task:any=await controller.createTask(project.id,'Recorded integration proof'),run:any=await controller.createRun(task.id);
  controller.configureVerifiedWorkspace({repoPath,allowedScope:['README.md'],commands:[{name:'recorded README assertion',command:process.execPath,args:['-e',validationPass?"const fs=require('fs');if(!fs.readFileSync('README.md','utf8').includes('Bridge smoke'))process.exit(2);console.log('recorded README assertion passed')":"console.log('recorded validation failure');process.exit(7)"]}],timeoutMs:15000,maxOutputBytes:16384});
  await controller.pinWorkerBase(run.id,recorded.baseCommit);
  const worker:any=await controller.assign(run.id,'worker','Deterministic replay of the recorded Worker response; no provider call.');
  return {dir,repoPath,recorded,store,controller,runId:run.id,workerId:worker.id,uhpCalls};
}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});

describe('recorded Worker integration fixture (simulated Reviewer; no live model call)',()=>{
  it('persists pinned Worker provenance, validates in a disposable workspace, survives restart, and waits for explicit human decision',async()=>{
    const fixture=await setup(true,'reject');
    const result:any=await fixture.controller.replayRecordedWorkerOutput(fixture.runId,fixture.workerId,fixture.recorded);
    await expect(fixture.controller.assign(fixture.runId,'worker','second Worker attempt on a verified workspace')).rejects.toThrow('one Worker assignment per run');
    expect(result.workerEvidence).toMatchObject({provenance:'recorded_replay',responseId:fixture.recorded.responseId,actualModel:fixture.recorded.actualModel,usage:{inputTokens:6,outputTokens:328,cachedInputTokens:9105},pinnedBaseCommit:fixture.recorded.baseCommit,completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:4},scopeVerified:true,acceptance:'not_decided'});
    expect(result.validation).toMatchObject({status:'passed',passed:true,observations:[{exitCode:0,output:'recorded README assertion passed\n'}]});
    expect(fixture.uhpCalls.filter(x=>x.role==='worker')).toHaveLength(1);
    await fixture.store.mutate(s=>{const run=s.projects[0]!.tasks[0]!.runs[0]!;delete run.validation;run.status='validation';});
    const recovered=new Controller(new JsonStore(fixture.store.filePath),{submit:async input=>{if(input.roleId!=='reviewer')throw new Error('duplicate Worker submission during recovery');fixture.uhpCalls.push({role:input.roleId,prompt:input.prompt});return {externalId:'sim-review-response',responseId:'sim-review-response',status:'completed',actualModel:'simulated-reviewer-v1',selectedHarnessId:'fixture-reviewer',outputText:JSON.stringify({verdict:'reject',rationale:'Deterministic simulated Reviewer fixture; no model call was made.'})};},cancel:async()=>({status:'cancelled'})});
    recovered.configureVerifiedWorkspace({repoPath:fixture.repoPath,allowedScope:['README.md'],commands:[{name:'recorded README assertion',command:process.execPath,args:['-e',"const fs=require('fs');if(!fs.readFileSync('README.md','utf8').includes('Bridge smoke'))process.exit(2);console.log('recovered validation passed')"]}]});
    await recovered.recover();
    expect((await recovered.state()).projects[0]!.tasks[0]!.runs[0]!.validation).toMatchObject({status:'passed',passed:true});
    expect(fixture.uhpCalls.filter(x=>x.role==='worker')).toHaveLength(1);
    const review:any=await recovered.requestReviewer(fixture.runId,'simulated_fixture');
    expect(fixture.uhpCalls.filter(x=>x.role==='reviewer')).toHaveLength(1);
    expect(fixture.uhpCalls.find(x=>x.role==='reviewer')?.prompt).toContain(fixture.recorded.reviewDiff);
    expect(fixture.uhpCalls.find(x=>x.role==='reviewer')?.prompt).toContain('recovered validation passed');
    const recommendation=review;
    expect(recommendation).toMatchObject({provenance:'simulated_fixture',verdict:'reject',rationale:'Deterministic simulated Reviewer fixture; no model call was made.'});
    const afterReviewRestart=new Controller(new JsonStore(fixture.store.filePath),{submit:async()=>{throw new Error('duplicate reviewer submission');},cancel:async()=>({status:'cancelled'})});
    afterReviewRestart.configureVerifiedWorkspace({repoPath:fixture.repoPath,allowedScope:['README.md'],commands:[{name:'recorded README assertion',command:process.execPath,args:['-e',"process.exit(0)"]}]});
    await afterReviewRestart.recover();
    expect(fixture.uhpCalls.filter(x=>x.role==='worker')).toHaveLength(1);
    const replayed=await afterReviewRestart.replayRecordedWorkerOutput(fixture.runId,fixture.workerId,fixture.recorded);
    expect(replayed).toMatchObject({workerEvidence:{provenance:'recorded_replay',acceptance:'not_decided'},validation:{status:'passed'}});
    await expect(afterReviewRestart.requestReviewer(fixture.runId)).rejects.toThrow('already exists');
    const rejected=await afterReviewRestart.approveRun(fixture.runId,{approved:false,rationale:'Human rejected after inspecting simulated recommendation'});
    expect(rejected).toMatchObject({decision:'rejected',approved:false});
    await expect(afterReviewRestart.approveRun(fixture.runId,{approved:true,rationale:'Attempt to replace the recorded human rejection'})).rejects.toThrow('A human decision is final for this run');
    await expect(afterReviewRestart.assign(fixture.runId,'planner','new assignment after human rejection')).rejects.toThrow('No assignments are allowed after the human decision');
  });

  it('records failed controller validation and blocks Reviewer progression until retry passes',async()=>{
    const fixture=await setup(false,'recommend');
    const result:any=await fixture.controller.replayRecordedWorkerOutput(fixture.runId,fixture.workerId,fixture.recorded);
    expect(result.validation).toMatchObject({status:'failed',passed:false,observations:[{exitCode:7,output:'recorded validation failure\n'}]});
    await expect(fixture.controller.requestReviewer(fixture.runId)).rejects.toThrow('successful controller validation');
    fixture.controller.configureVerifiedWorkspace({repoPath:fixture.repoPath,allowedScope:['README.md'],commands:[{name:'retry assertion',command:process.execPath,args:['-e',"if(!require('fs').readFileSync('README.md','utf8').includes('Bridge smoke'))process.exit(1)"]}]});
    const retry:any=await fixture.controller.retryValidation(fixture.runId);
    expect(retry).toMatchObject({status:'passed',passed:true});
  });

  it('rejects incomplete and out-of-scope recorded snapshots before validation or Reviewer submission',async()=>{
    const incomplete=await setup();
    const badComplete=structuredClone(incomplete.recorded);badComplete.completeSnapshot.reportedComplete=false;
    await expect(incomplete.controller.replayRecordedWorkerOutput(incomplete.runId,incomplete.workerId,badComplete)).rejects.toThrow('completeness');
    expect((await incomplete.store.load()).projects[0]!.tasks[0]!.runs[0]!.workerEvidence).toBeUndefined();
    await expect(incomplete.controller.requestReviewer(incomplete.runId)).rejects.toThrow('successful controller validation');

    const outscope=await setup();
    const badScope=structuredClone(outscope.recorded);const bytes=Buffer.from('outside');
    badScope.changes.push({kind:'add',path:'private/secret.txt',after:{kind:'file',mode:'100644',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),contentBase64:bytes.toString('base64')}});
    badScope.completeSnapshot.entryCount++;
    await expect(outscope.controller.replayRecordedWorkerOutput(outscope.runId,outscope.workerId,badScope)).rejects.toThrow('outside the allowed scope');
    expect((await outscope.store.load()).projects[0]!.tasks[0]!.runs[0]!.workerEvidence).toBeUndefined();
    expect(outscope.uhpCalls.filter(x=>x.role==='reviewer')).toHaveLength(0);
  });
});
