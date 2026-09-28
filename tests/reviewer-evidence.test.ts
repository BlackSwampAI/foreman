import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, type UhpAdapter } from '../src/controller.js';
import type { Assignment } from '../src/domain.js';
import { JsonStore } from '../src/store.js';

const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
const cfg={harnessId:'fixture',model:'model-fixture'};

// Seeds a run holding verified Worker evidence and passed validation, so the controller can build the Reviewer evidence package.
async function seed(adapter:Partial<UhpAdapter>={}) {
  const dir=await mkdtemp(join(tmpdir(),'foreman-'));dirs.push(dir);const store=new JsonStore(join(dir,'state.json'));
  await store.mutate(s=>{for(const role of s.roles){role.enabled=true;role.availableConfigs=[cfg];role.config=cfg;}});
  const uhp:UhpAdapter={submit:async()=>({externalId:'x',status:'completed'}),cancel:async()=>({status:'cancelled'}),...adapter};
  const controller=new Controller(store,uhp);
  controller.configureVerifiedWorkspace({repoPath:'/fixture/repo',bridgeBaseUrl:'http://127.0.0.1:1',allowedScope:['README.md'],commands:[{name:'fixture check',command:'true',args:[]}]});
  const project:any=await controller.createProject('Reviewer evidence'),task:any=await controller.createTask(project.id,'Task'),run:any=await controller.createRun(task.id);
  await store.mutate(s=>{const current=s.projects[0]!.tasks[0]!.runs[0]!;current.pinnedBaseCommit='a'.repeat(40);current.workspaceId='ws';
    const worker:Assignment={id:'worker-1',roleId:'worker',status:'succeeded',requestedConfig:cfg,responseId:'worker-response',externalId:'worker-response',sessionId:'worker-session',prompt:'work',submissionId:'sub-w',idempotencyKey:'idem-w',createdAt:new Date().toISOString()};
    current.assignments.push(worker);
    current.workerEvidence={provenance:'recorded_replay',workerAssignmentId:worker.id,responseId:worker.responseId!,pinnedBaseCommit:current.pinnedBaseCommit,completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:1},scopeVerified:true,allowedScope:['README.md'],entries:[],changes:[{path:'README.md',kind:'modified',summary:'note'}],reviewDiff:'diff --git a/README.md b/README.md\n+note',acceptance:'not_decided'} as any;
    current.validation={id:'v1',status:'passed',passed:true,reportedPassed:true,checks:[{name:'fixture check',passed:true}],observations:[{name:'fixture check',command:'true',args:[],exitCode:0,timedOut:false,output:'passed',outputTruncated:false,passed:true}],policy:{requireAllChecksPass:true,configuredCheckCount:1},gitEvidence:{status:'verified',commit:current.pinnedBaseCommit,changedPaths:['README.md'],submittedAt:new Date().toISOString()},createdAt:new Date().toISOString()} as any;});
  const validation=(controller as any).reviewerEvidencePackage((await store.load()).projects[0]!.tasks[0]!.runs[0]!).controllerValidation;
  return {store,controller,uhp,run,validation};
}
type Reply={terminal:string;sessionId?:string;responseId:string;mode:string;mutationAttempted:boolean;validation:unknown;model:string};
const good=(validation:unknown):Reply=>({terminal:'completed',sessionId:'reviewer-session',responseId:'rev-response',mode:'read_only',mutationAttempted:false,validation,model:'model-fixture'});
const cases:Array<{name:string;patch:(validation:unknown)=>Partial<Reply>}>=[
  {name:'wrong mode',patch:()=>({mode:'write'})},
  {name:'mutation attempted',patch:()=>({mutationAttempted:true})},
  {name:'same session as the Worker',patch:()=>({sessionId:'worker-session'})},
  {name:'same response as the Worker',patch:()=>({responseId:'worker-response'})},
  {name:'validation mismatch',patch:()=>({validation:{different:true}})},
  {name:'model mismatch',patch:()=>({model:'other-model'})},
  {name:'non-succeeded terminal status',patch:()=>({terminal:'failed'})},
  {name:'missing session',patch:()=>({sessionId:undefined})},
];
const live=(o:Reply)=>({externalId:o.responseId,responseId:o.responseId,sessionId:o.sessionId,status:o.terminal,outputText:'review',actualModel:o.model,requestedModel:'model-fixture',selectedHarnessId:'fixture',reviewerExecution:{mode:o.mode,mutationAttempted:o.mutationAttempted,validation:o.validation}});
const retrieved=(o:Reply)=>({id:o.responseId,status:o.terminal,output_text:'review',model:o.model,requested_model:'model-fixture',session_id:o.sessionId,metadata:{harness_id:'fixture',foreman_review_mode:o.mode,reviewer_mutation_attempted:o.mutationAttempted,reviewer_validation:o.validation}});

describe('Reviewer read-only evidence rule',()=>{
  describe('live submit path',()=>{
    async function run(patch:(validation:unknown)=>Partial<Reply>){let response:any;const s=await seed({submit:async()=>response});response=live({...good(s.validation),...patch(s.validation)});const a=await s.controller.assign(s.run.id,'reviewer',(s.controller as any).reviewerPrompt());return {a,events:(await s.store.load()).events.filter(e=>e.type==='reviewer.execution_rejected')};}
    it('accepts a complete, distinct, read-only response',async()=>{const {a,events}=await run(()=>({}));expect(a.status).toBe('succeeded');expect(events).toHaveLength(0);});
    for(const c of cases)it(`rejects ${c.name}`,async()=>{const {a,events}=await run(c.patch);expect(a.status).toBe('failed');expect(a.error).toBe('Reviewer response did not prove a complete, distinct, read-only review of the controller evidence package');expect(events).toHaveLength(1);expect(events[0]!.data).toHaveProperty('actualModel');});
  });
  describe('reconciled path',()=>{
    async function run(patch:(validation:unknown)=>Partial<Reply>){const s=await seed();let response:any;(s.uhp as any).retrieve=async()=>response;response={...retrieved({...good(s.validation),...patch(s.validation)})};
      await s.store.mutate(st=>{st.projects[0]!.tasks[0]!.runs[0]!.assignments.push({id:'rev-1',roleId:'reviewer',status:'running',requestedConfig:cfg,responseId:'rev-response',externalId:'rev-response',prompt:'review',submissionId:'sub-r',idempotencyKey:'idem-r',createdAt:new Date().toISOString()});});
      const a:any=await s.controller.refreshAssignment('rev-1');return {a,events:(await s.store.load()).events.filter(e=>e.type==='reviewer.execution_rejected')};}
    it('accepts a complete, distinct, read-only response',async()=>{const {a,events}=await run(()=>({}));expect(a.status).toBe('succeeded');expect(a.error).toBeUndefined();expect(events).toHaveLength(0);});
    for(const c of cases)it(`rejects ${c.name}`,async()=>{const {a,events}=await run(c.patch);expect(a.status).toBe('failed');expect(a.error).toBe('Reconciled Reviewer response did not prove the complete read-only evidence package');expect(events).toHaveLength(1);expect(events[0]!.data).toMatchObject({source:'reconciled-response',actualModel:expect.anything()});});
  });
});
