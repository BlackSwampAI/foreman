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
  const project:any=await controller.createProject('Reviewer evidence'),task:any=await controller.createTask(project.id,'Task');
  await store.mutate(s=>{const t=s.projects[0]!.tasks.find(item=>item.id===task.id)!;t.goal='Implement the requested feature';t.validationCriteria=['Feature behavior is implemented','Add regression tests'];});
  const run:any=await controller.createRun(task.id);
  await store.mutate(s=>{const current=s.projects[0]!.tasks[0]!.runs[0]!;current.pinnedBaseCommit='a'.repeat(40);current.workspaceId='ws';
    const orchestrator:Assignment={id:'orch-1',roleId:'orchestrator',status:'succeeded',requestedConfig:cfg,responseId:'orch-response',externalId:'orch-response',sessionId:'orch-session',prompt:'Inspect the contract and propose a concrete implementation.',result:'Implement requested feature in src/example.ts.',submissionId:'sub-o',idempotencyKey:'idem-o',createdAt:new Date().toISOString()};
    const worker:Assignment={id:'worker-1',roleId:'worker',status:'succeeded',requestedConfig:cfg,responseId:'worker-response',externalId:'worker-response',sessionId:'worker-session',prompt:'Implement requested feature and tests.',result:'Implemented the feature.',submissionId:'sub-w',idempotencyKey:'idem-w',createdAt:new Date().toISOString()};
    current.assignments.push(orchestrator);
    current.assignments.push(worker);
    current.workerProposal={id:'proposal-1',status:'dispatched',text:'Implement requested feature and tests.',orchestratorAssignmentId:'orch-1',createdAt:new Date().toISOString(),targetFiles:['src/example.ts','tests/example.test.ts'],workerAssignmentId:'worker-1'};
    current.workerEvidence={provenance:'recorded_replay',workerAssignmentId:worker.id,responseId:worker.responseId!,pinnedBaseCommit:current.pinnedBaseCommit,completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:1},scopeVerified:true,allowedScope:['README.md'],entries:[],changes:[{path:'README.md',kind:'modified',summary:'note'}],reviewDiff:'diff --git a/README.md b/README.md\n+note',acceptance:'not_decided'} as any;
    current.validation={id:'v1',status:'passed',passed:true,reportedPassed:true,checks:[{name:'fixture check',passed:true}],observations:[{name:'fixture check',command:'true',args:[],exitCode:0,timedOut:false,output:'passed',outputTruncated:false,passed:true}],policy:{requireAllChecksPass:true,configuredCheckCount:1},gitEvidence:{status:'verified',commit:current.pinnedBaseCommit,changedPaths:['README.md'],submittedAt:new Date().toISOString()},createdAt:new Date().toISOString()} as any;});
  const evidence=(controller as any).reviewerEvidencePackage((await store.load()).projects[0]!.tasks[0]!.runs[0]!);
  return {store,controller,uhp,run,validation:evidence.controllerValidation,contextDigest:evidence.reviewContextDigest};
}
type Reply={terminal:string;sessionId?:string;responseId:string;mode:string;mutationAttempted:boolean;validation:unknown;contextDigest?:string;model:string};
const good=(validation:unknown,contextDigest?:string):Reply=>({terminal:'completed',sessionId:'reviewer-session',responseId:'rev-response',mode:'read_only',mutationAttempted:false,validation,contextDigest,model:'model-fixture'});
const cases:Array<{name:string;patch:(validation:unknown)=>Partial<Reply>}>=[
  {name:'wrong mode',patch:()=>({mode:'write'})},
  {name:'mutation attempted',patch:()=>({mutationAttempted:true})},
  {name:'same session as the Worker',patch:()=>({sessionId:'worker-session'})},
  {name:'same response as the Worker',patch:()=>({responseId:'worker-response'})},
  {name:'validation mismatch',patch:()=>({validation:{different:true}})},
  {name:'missing context digest',patch:()=>({contextDigest:undefined})},
  {name:'context digest mismatch',patch:()=>({contextDigest:'f'.repeat(64)})},
  {name:'model mismatch',patch:()=>({model:'other-model'})},
  {name:'non-succeeded terminal status',patch:()=>({terminal:'failed'})},
  {name:'missing session',patch:()=>({sessionId:undefined})},
];
const live=(o:Reply)=>({externalId:o.responseId,responseId:o.responseId,sessionId:o.sessionId,status:o.terminal,outputText:'review',actualModel:o.model,requestedModel:'model-fixture',selectedHarnessId:'fixture',reviewerExecution:{mode:o.mode,mutationAttempted:o.mutationAttempted,validation:o.validation,contextDigest:o.contextDigest}});
const retrieved=(o:Reply)=>({id:o.responseId,status:o.terminal,output_text:'review',model:o.model,requested_model:'model-fixture',session_id:o.sessionId,metadata:{harness_id:'fixture',foreman_review_mode:o.mode,reviewer_mutation_attempted:o.mutationAttempted,reviewer_validation:o.validation,reviewer_context_digest:o.contextDigest}});

describe('Reviewer read-only evidence rule',()=>{
  it('binds review context to the run-frozen contract, matching Worker attempt, and captured research instead of mutable task data',async()=>{
    const s=await seed();
    await s.store.mutate(state=>{
      const task=state.projects[0]!.tasks[0]!,run=task.runs[0]!;
      run.researchEvidence=[{id:'research-1',requestedByAssignmentId:'orch-1',requestedUrl:'https://docs.example.org/api',finalUrl:'https://docs.example.org/api',retrievedAt:'2026-10-03T00:00:00.000Z',outcome:'retrieved',statusCode:200,contentType:'application/json',bodyExcerpt:'API docs say GET /games/live',capturedBytes:40,bodyDigest:'d'.repeat(64),bodyDigestComplete:true,bodyTruncated:false,bodyExcerptComplete:false,excerptTruncated:true,searchTerms:['GET /games/live'],matchedSearchTerms:['GET /games/live'],unmatchedSearchTerms:[],excerptSegments:[{startChar:0,endChar:40,sourceStartChar:4_000,sourceEndChar:4_040,matchedTerms:['GET /games/live']}]}];
    });
    const run=(await s.store.load()).projects[0]!.tasks[0]!.runs[0]!;
    const original=(s.controller as any).reviewerEvidencePackage(run);
    expect(original.taskContract).toMatchObject({source:'captured',title:'Task',goal:'Implement the requested feature',acceptanceCriteria:['Feature behavior is implemented','Add regression tests']});
    expect(original.originatingWork).toMatchObject({source:'orchestrator_proposal',proposalId:'proposal-1',workerAssignmentId:'worker-1',workerResponseId:'worker-response',workerRequestPrompt:'Implement requested feature and tests.',workerContextBinding:'not_persisted_for_existing_assignment'});
    expect(original.originatingWork.workerRequestPrompt).toBe(run.assignments.find(a=>a.id==='worker-1')?.prompt);
    expect(original.researchEvidence[0]).toMatchObject({requestedUrl:'https://docs.example.org/api',bodyExcerptComplete:false,excerptTruncated:true});
    expect(original.reviewContextDigest).toMatch(/^[a-f0-9]{64}$/);
    await s.store.mutate(state=>{const task=state.projects[0]!.tasks[0]!;task.title='Changed after start';task.goal='New task goal';task.validationCriteria=['Different criteria'];});
    const after=(s.controller as any).reviewerEvidencePackage((await s.store.load()).projects[0]!.tasks[0]!.runs[0]!);
    expect(after.taskContract).toEqual(original.taskContract);
    expect(after.reviewContextDigest).toBe(original.reviewContextDigest);
  });

  it('links a retry review package to the Worker attempt that produced the reviewed evidence',async()=>{
    const s=await seed();
    await s.store.mutate(state=>{
      const run=state.projects[0]!.tasks[0]!.runs[0]!;
      run.assignments.push({id:'worker-2',roleId:'worker',status:'succeeded',requestedConfig:cfg,responseId:'worker-response-2',externalId:'worker-response-2',prompt:'Retry request: implement the missing route and tests.',result:'Implemented retry.',submissionId:'sub-w2',idempotencyKey:'idem-w2',createdAt:new Date().toISOString()});
      run.workerProposalHistory=[{id:'proposal-2',status:'dispatched',text:'Implement the missing route and tests.',orchestratorAssignmentId:'orch-1',createdAt:new Date().toISOString(),targetFiles:['src/example.ts'],workerAssignmentId:'worker-2'}];
      run.workerEvidence!.workerAssignmentId='worker-2';run.workerEvidence!.responseId='worker-response-2';
    });
    const run=(await s.store.load()).projects[0]!.tasks[0]!.runs[0]!;
    const evidence=(s.controller as any).reviewerEvidencePackage(run);
    expect(evidence.originatingWork).toMatchObject({proposalId:'proposal-2',workerAssignmentId:'worker-2',workerResponseId:'worker-response-2',workerRequestPrompt:'Retry request: implement the missing route and tests.'});
  });

  it('binds a direct Worker assignment explicitly when no Orchestrator proposal exists',async()=>{
    const s=await seed();
    await s.store.mutate(state=>{const run=state.projects[0]!.tasks[0]!.runs[0]!;delete run.workerProposal;delete run.workerProposalHistory;});
    const run=(await s.store.load()).projects[0]!.tasks[0]!.runs[0]!;
    const evidence=(s.controller as any).reviewerEvidencePackage(run);
    expect(evidence.originatingWork).toMatchObject({source:'manual_assignment',orchestratorProposalRecorded:false,workerAssignmentId:'worker-1',workerResponseId:'worker-response',workerRequestPrompt:'Implement requested feature and tests.',workerContextBinding:'not_persisted_for_existing_assignment'});
    expect(evidence.originatingWork).not.toHaveProperty('proposalId');
    expect(evidence.reviewContextDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  describe('live submit path',()=>{
    async function run(patch:(validation:unknown)=>Partial<Reply>){let response:any;const s=await seed({submit:async()=>response});response=live({...good(s.validation,s.contextDigest),...patch(s.validation)});const a=await s.controller.assign(s.run.id,'reviewer',(s.controller as any).reviewerPrompt());return {a,events:(await s.store.load()).events.filter(e=>e.type==='reviewer.execution_rejected')};}
    it('accepts a complete, distinct, read-only response',async()=>{const {a,events}=await run(()=>({}));expect(a.status).toBe('succeeded');expect(events).toHaveLength(0);});
    for(const c of cases)it(`rejects ${c.name}`,async()=>{const {a,events}=await run(c.patch);expect(a.status).toBe('failed');expect(a.error).toBe('Reviewer response did not prove a complete, distinct, read-only review of the controller evidence package');expect(events).toHaveLength(1);expect(events[0]!.data).toHaveProperty('actualModel');});
  });
  describe('reconciled path',()=>{
    async function run(patch:(validation:unknown)=>Partial<Reply>){const s=await seed();let response:any;(s.uhp as any).retrieve=async()=>response;response={...retrieved({...good(s.validation,s.contextDigest),...patch(s.validation)})};
      await s.store.mutate(st=>{st.projects[0]!.tasks[0]!.runs[0]!.assignments.push({id:'rev-1',roleId:'reviewer',status:'running',requestedConfig:cfg,responseId:'rev-response',externalId:'rev-response',prompt:'review',submissionId:'sub-r',idempotencyKey:'idem-r',createdAt:new Date().toISOString()});});
      const a:any=await s.controller.refreshAssignment('rev-1');return {a,events:(await s.store.load()).events.filter(e=>e.type==='reviewer.execution_rejected')};}
    it('accepts a complete, distinct, read-only response',async()=>{const {a,events}=await run(()=>({}));expect(a.status).toBe('succeeded');expect(a.error).toBeUndefined();expect(events).toHaveLength(0);});
    for(const c of cases)it(`rejects ${c.name}`,async()=>{const {a,events}=await run(c.patch);expect(a.status).toBe('failed');expect(a.error).toBe('Reconciled Reviewer response did not prove the complete read-only evidence package');expect(events).toHaveLength(1);expect(events[0]!.data).toMatchObject({source:'reconciled-response',actualModel:expect.anything()});});
  });
});
