import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, debounce, type State, type TaskStartPreview } from '../ui/main.js';
import { DecisionPanel, type DecisionPanelProps } from '../ui/decision-panel.js';
import { ChecksPipeline, type StationObservation, type GithubCheckEntry } from '../ui/checks-pipeline.js';
import { parseChecksSummary } from '../ui/check-output.js';
import { PrDraftPanel, type PrDraftData } from '../ui/pr-draft.js';

describe('debounce helper',()=>{
  beforeEach(()=>{ vi.useFakeTimers(); });
  afterEach(()=>{ vi.useRealTimers(); });

  it('delays execution until wait ms after the last call',()=>{
    const fn=vi.fn();
    const d=debounce(fn,200);
    d();d();d();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires at most once during rapid calls when maxWait elapses',()=>{
    const fn=vi.fn();
    const d=debounce(fn,200,500);
    // Simulate rapid calls over 600 ms (past maxWait).
    for(let i=0;i<6;i++){d();vi.advanceTimersByTime(100);}
    // maxWait (500 ms) elapsed during the loop → should have fired once.
    expect(fn).toHaveBeenCalledTimes(1);
    // After the burst stops, trailing call fires too.
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not fire again if debounced after maxWait already fired',()=>{
    const fn=vi.fn();
    const d=debounce(fn,200,500);
    d();
    vi.advanceTimersByTime(500); // maxWait fires
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200); // trailing timer should already be cleared
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('project Planner UI',()=>{
  it('shows the continuing Planner, task tree, start controls, and named navigation with inline icons',()=>{
    const state:State={projects:[{id:'prj_fixture',name:'Opened repository',plannerSession:{localId:'planner-session-fixture',roleId:'planner',generation:1,status:'active',config:{harnessId:'fixture',model:'simulated'},startedAt:'2026-01-01T00:00:00.000Z'},plannerMessages:[{id:'pmsg_user',role:'user',text:'Update the node README and add a REST endpoint.',createdAt:'2026-01-01T00:00:00.000Z'},{id:'pmsg_planner',role:'planner',text:'I split this into two tasks.',createdAt:'2026-01-01T00:01:00.000Z'}],tasks:[{id:'tsk_readme_fixture',title:'Update README',goal:'Document the node behavior.',suggestedAllowedPaths:['README.md'],validationCriteria:['README check passes'],status:'ready',runs:[]},{id:'tsk_endpoint_fixture',title:'Add REST endpoint',goal:'Implement the requested API endpoint.',suggestedAllowedPaths:['src/http/'],validationCriteria:['Endpoint tests pass'],status:'ready',runs:[]}]}],roles:[...['planner','orchestrator','worker','reviewer'].map(id=>({id,name:id,enabled:true,config:{harnessId:'fixture',model:'simulated'},availableConfigs:[{harnessId:'fixture',model:'simulated'}]}))]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('Talk to the Planner');expect(html).toContain('One continuing conversation for this repository');expect(html).toContain('Update the node README and add a REST endpoint.');expect(html).toContain('Update README');expect(html).toContain('Add REST endpoint');expect(html).toContain('Start work');expect(html).toContain('Message project Planner');
    expect(html).not.toContain('aria-label="Main navigation"');expect(html).toContain('Project tree');expect(html).toContain('class="node project selected" title="Opened repository"');expect(html).toContain('class="node task selected" title="Update README"');
    expect(html).toContain('aria-label="Refresh state"');expect(html).toContain('<svg aria-hidden="true" focusable="false"');expect(html).not.toContain('objtext');
  });
  it('hides a legacy structured proposal payload and keeps the readable Planner reply',()=>{
    const state:State={projects:[{id:'prj_fixture',name:'Opened repository',plannerAssignments:[{id:'asgn_fixture',roleId:'planner',status:'succeeded',result:{reply:'See [the docs](https://example.com/docs) for context.',tasks:[{title:'Add health endpoint'}]}}],plannerMessages:[{id:'pmsg_user',role:'user',text:'Add a health endpoint.',createdAt:'2026-01-01T00:00:00.000Z'},{id:'pmsg_planner',role:'planner',assignmentId:'asgn_fixture',text:'I prepared a task.',createdAt:'2026-01-01T00:01:00.000Z'}],tasks:[]}],roles:[]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('I prepared a task.');expect(html).not.toContain('See ');expect(html).not.toContain('href="https://example.com/docs"');expect(html).toContain('Saved Planner proposal · 1 task');expect(html).toContain('Create proposed tasks');expect(html).not.toContain('&quot;tasks&quot;');expect(html).toContain('Message project Planner');
  });
  it('offers recovery from saved task JSON when the Planner message only contains friendly text',()=>{
    const assignmentId='asgn_f32a6c25-24c0-4a22-bc4a-fd536b14fa3f';
    const proposals=[{title:'Add roster import',goal:'Import roster updates.',validationCriteria:['Import validation passes']},{title:'Add profile sync',goal:'Sync player profiles.',validationCriteria:['Sync test passes']},{title:'Document import',goal:'Document roster import.',validationCriteria:['Docs build passes']}];
    const state:State={projects:[{id:'prj_saved_proposal',name:'Saved proposal',plannerAssignments:[{id:assignmentId,roleId:'planner',status:'succeeded',result:JSON.stringify({reply:'I split the request into three tasks.',tasks:proposals})}],plannerMessages:[{id:'pmsg_planner',role:'planner',assignmentId,text:'I split the request into three tasks.',createdAt:'2026-09-23T12:00:00.000Z'}],tasks:[]}],roles:[]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('I split the request into three tasks.');expect(html).toContain('Saved Planner proposal · 3 tasks');expect(html).toContain('Create proposed tasks');expect(html).not.toContain('Add roster import');expect(html).not.toContain('"tasks"');
  });
  it('does not offer proposal recovery for a completed conversational Planner reply',()=>{
    const state:State={projects:[{id:'prj_conversation',name:'Conversation only',plannerAssignments:[{id:'asgn_chat',roleId:'planner',status:'succeeded',result:'I can help with that. What should happen when the endpoint receives an empty query?'}],plannerMessages:[{id:'pmsg_chat',role:'planner',assignmentId:'asgn_chat',text:'I can help with that. What should happen when the endpoint receives an empty query?',createdAt:'2026-09-23T12:00:00.000Z'}],tasks:[]}],roles:[]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('What should happen when the endpoint receives an empty query?');expect(html).not.toContain('Create proposed tasks');expect(html).not.toContain('Saved Planner proposal');
  });
  it('puts task plan approval first and keeps run settings collapsed under Advanced options',()=>{
    const state:State={projects:[{id:'prj_review',name:'Review project',tasks:[{id:'tsk_review',title:'Add search endpoint',goal:'Let clients search active records.',validationCriteria:['Returns matching records','Rejects invalid query'],suggestedAllowedPaths:['src/search/'],status:'ready'}]}],roles:['orchestrator','worker','reviewer'].map(id=>({id,name:id,enabled:true,config:{harnessId:'local',model:'safe-model'},availableConfigs:[{harnessId:'local',model:'safe-model'}]}))};
    const preview:TaskStartPreview={taskId:'tsk_review',scope:['src/search/'],roleConfigs:Object.fromEntries(['orchestrator','worker','reviewer'].map(id=>[id,{harnessId:'local',model:'safe-model'}])),validationCriteria:['Returns matching records','Rejects invalid query'],validationCommands:[{name:'Tests',command:'pnpm',args:['test']}],budgets:{roleTurns:{planner:3,orchestrator:2,worker:1,reviewer:1},workerAttempts:1},baseCommit:'a'.repeat(40),requiresExplicitBase:false,reasons:[],canStart:true};
    const html=renderToStaticMarkup(createElement(App,{initialState:state,initialTaskStartPreview:preview}));
    expect(html).toContain('Add search endpoint');expect(html).toContain('Let clients search active records.');expect(html).toContain('Returns matching records');expect(html).toContain('Rejects invalid query');expect(html).toContain('Approve task &amp; start work');expect(html).toContain('TASK PLAN APPROVAL');expect(html).toContain('Result approval remains a separate decision.');expect(html).toContain('Advanced options');expect(html).toContain('<details class="task-advanced">');expect(html).not.toContain('Start work</button>');
  });
  it('surfaces preview blockers in task review and prevents task plan approval',()=>{
    const state:State={projects:[{id:'prj_blocked',name:'Blocked project',tasks:[{id:'tsk_blocked',title:'Update report',goal:'Update the report.',validationCriteria:['Report lint passes'],status:'ready'}]}],roles:[]};
    const preview:TaskStartPreview={taskId:'tsk_blocked',scope:[],roleConfigs:{},validationCriteria:['Report lint passes'],validationCommands:[],requiresExplicitBase:true,reasons:['Choose at least one allowed path before starting this task','Dependency tsk_prior must be completed and promoted'],dependencyTaskIds:['tsk_prior'],canStart:false};
    const html=renderToStaticMarkup(createElement(App,{initialState:state,initialTaskStartPreview:preview}));
    expect(html).toContain('Resolve these blockers before starting');expect(html).toContain('Choose at least one allowed path before starting this task');expect(html).toContain('Dependency tsk_prior must be completed and promoted');expect(html).toContain('Related work must be integrated first');expect(html).toContain('pins the updated current HEAD automatically');expect(html).toContain('Approve task &amp; start work');expect(html).toMatch(/<button class="primary task-approve-button" disabled="">Approve task &amp; start work<\/button>/);
  });
  it('shows a persisted task plan approval separately from later result approval',()=>{
    const state:State={projects:[{id:'prj_approved',name:'Approved project',tasks:[{id:'tsk_approved',title:'Document API',goal:'Document the API.',validationCriteria:['Docs build passes'],status:'in progress',planApproval:{status:'approved',approvedAt:'2026-01-02T00:00:00.000Z',specDigest:'digest',runId:'run_approved'},runs:[]}]}],roles:[]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('Task plan approved');expect(html).toContain('<summary>Run ID</summary><code>run_approved</code>');expect(html).toContain('Result review and approval are still separate.');
  });
  it('keeps Planner first and shows a stopped validation phase with selectable role evidence',()=>{
    const state:State={projects:[{id:'prj_workflow',name:'Workflow project',plannerMessages:[{id:'pmsg_workflow',role:'user',text:'Add the roster import endpoint.',createdAt:'2026-09-24T12:00:00.000Z'}],tasks:[{id:'tsk_workflow',title:'Add roster import',goal:'Accept roster updates.',validationCriteria:['Import tests pass'],suggestedAllowedPaths:['src/import/'],status:'in progress',runs:[{id:'run_workflow',status:'failed',controller:{startedAt:'2026-09-24T12:01:00.000Z',phase:'stopped',stoppedReason:'Controller validation evidence exceeds the 16,000 byte inbox limit',active:false},assignments:[{id:'asgn_orchestrator',roleId:'orchestrator',status:'succeeded',result:'Worker result was ready for validation.'},{id:'asgn_worker',roleId:'worker',status:'succeeded',result:'Implemented roster import endpoint.'}],workerEvidence:{workerAssignmentId:'asgn_worker',responseId:'resp_worker',pinnedBaseCommit:'a'.repeat(40),completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:1},scopeVerified:true,allowedScope:['src/import/'],entries:[{path:'src/import/index.ts',kind:'file'}],changes:[{path:'src/import/index.ts',kind:'added',summary:'Adds the endpoint'}]},rejectedWorkerAttempts:[{id:'rejected_worker_snapshot',proposal:{id:'proposal_worker',status:'dispatched',text:'Implement the roster import endpoint.',orchestratorAssignmentId:'asgn_orchestrator',createdAt:'2026-09-24T12:02:00.000Z'},workerAssignmentId:'asgn_worker',reason:'An earlier reconciliation rejected this snapshot.',evidenceStatus:'rejected_untrusted',createdAt:'2026-09-24T12:03:00.000Z'}]}]}]}],roles:[...['planner','orchestrator','worker','reviewer'].map(id=>({id,name:id,enabled:true,config:{harnessId:'fixture',model:'simulated'},availableConfigs:[{harnessId:'fixture',model:'simulated'}]}))],events:[{id:'evt_worker_verified',type:'worker.evidence_verified',entityType:'run',entityId:'run_workflow',at:'2026-09-24T12:03:00.000Z',data:{workerAssignmentId:'asgn_worker',scopeVerified:true}},{id:'evt_worker_evidence_rejected',type:'worker.evidence_rejected',entityType:'run',entityId:'run_workflow',at:'2026-09-24T12:03:30.000Z',data:{workerAssignmentId:'asgn_worker',error:'Inbox too large'}},{id:'evt_worker_attempt_rejected',type:'worker.attempt_rejected',entityType:'run',entityId:'run_workflow',at:'2026-09-24T12:03:40.000Z',data:{workerAssignmentId:'asgn_worker',reason:'Snapshot previously rejected'}},{id:'evt_validation_stop',type:'controller.phase_changed',entityType:'run',entityId:'run_workflow',at:'2026-09-24T12:04:00.000Z',data:{phase:'validating'}}]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    const plannerIndex=html.indexOf('Talk to the Planner');
    const phasesIndex=html.indexOf('Run phase progress');
    expect(plannerIndex).toBeGreaterThanOrEqual(0);expect(phasesIndex).toBeGreaterThan(plannerIndex);
    expect(html).toContain('Validation blocked');expect(html).toContain('Controller validation evidence exceeds the 16,000 byte inbox limit');
    expect(html).toContain('Select workflow role');expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('phase-step done');expect(html).toContain('phase-step blocked');expect(html).toContain('phase-step waiting');
    expect(html).toContain('aria-label="Run phase progress"');
    expect(html).toMatch(/class="phase-step done[^\"]*"[^>]*><button[^>]*aria-label="Orchestrator phase, Done/);
    expect(html).toMatch(/class="phase-step done[^\"]*"[^>]*><button[^>]*aria-label="Verify phase, Done/);
    expect(html).toMatch(/class="phase-step blocked[^\"]*"[^>]*><button[^>]*aria-label="Validate phase, Blocked/);
    expect(html).toContain('aria-label="Validate phase, Blocked. Select for activity and evidence"');
    expect(html).toContain('aria-label="Reviewer phase, Waiting. Select for activity and evidence"');
    expect(html).toContain('Orchestrator activity and evidence');
    expect(html).toContain('aria-label="Worker, status Succeeded. Select for details"');
    expect(html).toContain('aria-label="Reviewer, status Unknown. Select for details"');
    expect(html).not.toContain('Reviewer complete');expect(html).not.toContain('Reviewer activity and evidence');
    expect(html).not.toContain('Foreman rejected this snapshot as untrusted');
    expect(html).toContain('Complete snapshot verified · 1 entries · Scope verified');
    expect(html).toContain('>History</button>');expect(html).not.toContain('Historical rejection superseded by verified evidence');expect(html).not.toContain('Worker assignment asgn_worker');
    expect(html).not.toContain('Worker Attempt Rejected');expect(html).not.toContain('Worker Evidence Rejected');
    expect(html).toContain('This run has verified Worker evidence');expect(html).toContain('Resolve its review, human decision, or promotion before starting another run');expect(html).toContain('Go to Evidence &amp; approval');expect(html).not.toContain('Approve task &amp; start work');
  });
  it('keeps the run view concise by default while leaving approval and details reachable',()=>{
    const longDiff='+++ b/src/endpoint.ts\n'+('line with implementation detail\n'.repeat(80));
    const state:State={projects:[{id:'prj_compact',name:'Compact project',plannerMessages:[{id:'pmsg_compact',role:'user',text:'Add the endpoint.',createdAt:'2026-09-24T12:00:00.000Z'}],tasks:[{id:'tsk_private_long_identifier',title:'Add endpoint',goal:'Accept roster updates.',validationCriteria:['Import tests pass'],suggestedAllowedPaths:['src/import/'],status:'in progress',runs:[{id:'run_private_long_identifier',status:'review',controller:{startedAt:'2026-09-24T12:01:00.000Z',phase:'stopped',active:false},assignments:[{id:'asgn_orchestrator_private',roleId:'orchestrator',status:'succeeded'},{id:'asgn_worker_private',roleId:'worker',status:'succeeded'},{id:'asgn_reviewer_private',roleId:'reviewer',status:'failed',error:'Reviewer submission returned HTTP 400'}],workerEvidence:{workerAssignmentId:'asgn_worker_private',responseId:'resp_worker_private',pinnedBaseCommit:'a'.repeat(40),completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:1},scopeVerified:true,allowedScope:['src/import/'],entries:[{path:'src/import/index.ts',kind:'file'}],changes:[{path:'src/import/index.ts',kind:'added',summary:'Adds the endpoint'}],reviewDiff:longDiff},validation:{status:'passed',observations:[{name:'Import tests',command:'pnpm',args:['test'],exitCode:0,signal:null,timedOut:false,output:'passed',outputTruncated:false,passed:true}]}}]}]}],roles:[...['planner','orchestrator','worker','reviewer'].map(id=>({id,name:id,enabled:true,config:{harnessId:'fixture',model:'simulated'},availableConfigs:[{harnessId:'fixture',model:'simulated'}]}))]};
    const preview:TaskStartPreview={taskId:'tsk_private_long_identifier',scope:['src/import/'],roleConfigs:Object.fromEntries(['orchestrator','worker','reviewer'].map(id=>[id,{harnessId:'fixture',model:'simulated'}])),validationCriteria:['Import tests pass'],validationCommands:[{name:'Tests',command:'pnpm',args:['test']}],budgets:{roleTurns:{planner:3,orchestrator:2,worker:1,reviewer:1},workerAttempts:1},baseCommit:'a'.repeat(40),requiresExplicitBase:false,reasons:[],canStart:true};
    const html=renderToStaticMarkup(createElement(App,{initialState:state,initialTaskStartPreview:preview}));
    const plannerIndex=html.indexOf('Talk to the Planner');const workflowIndex=html.indexOf('Run phase progress');const taskReviewIndex=html.indexOf('TASK REVIEW');
    expect(plannerIndex).toBeGreaterThanOrEqual(0);expect(workflowIndex).toBeGreaterThan(plannerIndex);expect(taskReviewIndex).toBeGreaterThan(workflowIndex);
    expect(html).toContain('<details class="workflow-more"><summary>Details</summary>');expect(html).toContain('<details class="run-meta-disclosure"><summary>Session and usage details</summary>');
    expect(html).toContain('<details class="evidence-block diff-block">');expect(html).not.toContain('<details class="evidence-block diff-block" open');expect(html).not.toContain('<details class="workflow-more" open');
    expect(html).toContain('This run has verified Worker evidence');expect(html).toContain('Go to Reviewer retry');expect(html).not.toContain('Go to Evidence &amp; approval');expect(html).not.toContain('Approve task &amp; start work');expect(html).toContain('Reviewer phase, Blocked. Select for activity and evidence');expect(html).toContain(longDiff);
  });
  it('keeps run selection explicit and makes durable history easy to reach',()=>{
    const state:State={projects:[{id:'prj_latest_run',name:'Latest run project',tasks:[{id:'tsk_latest_run',title:'Add endpoint',goal:'Add the endpoint.',status:'failed',runs:[
      {id:'run_old_failed',status:'failed',controller:{startedAt:'2026-09-24T11:00:00.000Z',phase:'stopped',active:false},assignments:[{id:'asgn_old_worker',roleId:'worker',status:'failed'}]},
      {id:'run_latest_failed',status:'failed',controller:{startedAt:'2026-09-24T12:00:00.000Z',phase:'stopped',stoppedReason:'Reviewer submission returned HTTP 400: review_evidence_invalid',active:false},assignments:[{id:'asgn_latest_worker',roleId:'worker',status:'succeeded'},{id:'asgn_latest_reviewer',roleId:'reviewer',status:'failed',error:'Reviewer submission returned HTTP 400: review_evidence_invalid'}],workerEvidence:{workerAssignmentId:'asgn_latest_worker',responseId:'resp_latest_worker',pinnedBaseCommit:'a'.repeat(40),completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:1},scopeVerified:true,allowedScope:['src/'],entries:[],changes:[],reviewDiff:'verified diff'},validation:{status:'passed',observations:[{name:'Tests',command:'pnpm',args:['test'],exitCode:0,timedOut:false,output:'passed',outputTruncated:false,passed:true}]}}
    ]}]}],roles:[...['orchestrator','worker','reviewer'].map(id=>({id,name:id,enabled:true,config:{harnessId:'fixture',model:'simulated'},availableConfigs:[{harnessId:'fixture',model:'simulated'}]}))]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('>History</button>');expect(html).toContain('>Usage</button>');expect(html).toContain('class="node run');
    expect(html).not.toContain('<div class="detail-row"><span>Run ID</span><code>run_latest_failed</code></div>');
    expect(html).toContain('Go to Reviewer retry');
    const recovered=structuredClone(state),recoveredRun=recovered.projects[0]!.tasks[0]!.runs![1]!;recoveredRun.status='review';recoveredRun.assignments![1]!.status='succeeded';delete recoveredRun.assignments![1]!.error;
    const recoveredHtml=renderToStaticMarkup(createElement(App,{initialState:recovered}));expect(recoveredHtml).not.toContain('Reviewer submission returned HTTP 400: review_evidence_invalid');
  });
  it('shows restored Reviewer evidence and human decision controls after prompt-limit recovery only in awaiting approval',()=>{
    const recommendation={id:'rec_recovered',status:'proposed' as const,provenance:'uhp_response' as const,reviewerAssignmentId:'asgn_recovered_reviewer',harnessId:'fixture',model:'model-fixture',responseId:'resp_recovered_reviewer',sessionId:'session_recovered_reviewer',reviewMode:'read_only' as const,mutationAttempted:false as const,verdict:'request_changes' as const,rationale:'The verified change needs one adjustment.',createdAt:'2026-09-25T12:00:00.000Z'};
    const state:State={projects:[{id:'prj_recovered',name:'Recovered project',tasks:[{id:'tsk_recovered',title:'Recovered task',status:'in progress',runs:[{id:'run_recovered',status:'awaiting_approval',controller:{startedAt:'2026-09-25T11:00:00.000Z',phase:'stopped',stoppedReason:'UHP request failed (400): prompt_limit',active:false,budgets:{roleTurns:{planner:2,orchestrator:3,worker:2,reviewer:2},workerAttempts:2}},reviewerRecommendation:recommendation,assignments:[{id:'asgn_recovered_worker',roleId:'worker',status:'succeeded',responseId:'resp_recovered_worker',sessionId:'session_recovered_worker'},{id:'asgn_recovered_reviewer',roleId:'reviewer',status:'succeeded',responseId:recommendation.responseId,sessionId:recommendation.sessionId,requestedConfig:{harnessId:'fixture',model:'model-fixture'}},{id:'asgn_recovered_orchestrator',roleId:'orchestrator',status:'failed',error:'UHP request failed (400): prompt_limit',requestedConfig:{harnessId:'fixture',model:'model-fixture'}}],workerEvidence:{workerAssignmentId:'asgn_recovered_worker',responseId:'resp_recovered_worker',pinnedBaseCommit:'a'.repeat(40),completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:1},scopeVerified:true,allowedScope:['README.md'],entries:[],changes:[{path:'README.md',kind:'modified',summary:'Verified README update'}],reviewDiff:'verified diff',acceptance:'not_decided'},validation:{status:'passed',passed:true,observations:[{name:'Fixture check',command:'true',args:[],exitCode:0,timedOut:false,output:'passed',outputTruncated:false,passed:true}]}}]}]}],roles:[...['orchestrator','worker','reviewer'].map(id=>({id,name:id,enabled:true,config:{harnessId:'fixture',model:'model-fixture'},availableConfigs:[{harnessId:'fixture',model:'model-fixture'}]}))]};
    const recoveredRun=state.projects[0]!.tasks[0]!.runs![0]!;recoveredRun.assignments![2]!.createdAt='2026-09-25T12:01:00.000Z';state.events=[{id:'retry-recovered',type:'reviewer.retry_authorized',entityType:'run',entityId:'run_recovered',at:'2026-09-25T12:00:30.000Z',data:{previousRecommendationId:'rec_recovered'}}];
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('Run stopped');expect(html).not.toContain('Recovered for human review');expect(html).toContain('UHP request failed (400): prompt_limit');expect(html).toContain('Awaiting explicit human approval or rejection');expect(html).toContain('Reviewer requested changes. Approving accepts this result as-is');expect(html).toContain('Approving accepts this result as-is, finalizes the run, and does not send changes back to Orchestrator.');expect(html).toContain('>Reject result</button>');expect(html).toContain('>Approve despite requested changes</button>');expect(html).toContain('Resume Reviewer correction');expect(html).toContain('Resume will make one bounded Orchestrator correction plan, dispatch a Worker retry, run configured local validation, and request a fresh read-only Reviewer response.');expect(html).toContain('This does not approve or promote the result.');
    const saved=structuredClone(state),savedRun=saved.projects[0]!.tasks[0]!.runs![0]!;savedRun.assignments![2]!.status='succeeded';savedRun.assignments![2]!.createdAt='2026-09-25T12:02:00.000Z';savedRun.assignments![2]!.result=JSON.stringify({workerTask:'Target docs/api-matrix.md. Correct the table and keep supported/unsupported/unverified labels.'});savedRun.controller!.stoppedReason='Worker proposal references a path outside the allowed scope: supported/unsupported/unverified';savedRun.orchestratorInbox={id:'inbox_saved_correction',status:'received',runId:'run_recovered',sessionLocalId:'orchestrator-session',workerAssignmentId:'asgn_recovered_worker',workerResponseId:'resp_recovered_worker',pinnedBaseCommit:'a'.repeat(40),allowedScope:['docs/'],reviewDiff:'verified diff',validation:{passed:true,observations:[]},evidenceDigest:'evidence-digest',receivedAt:'2026-09-25T11:59:00.000Z',deliveredInAssignmentId:'asgn_recovered_orchestrator'};
    savedRun.controller={startedAt:'2026-09-25T11:00:00.000Z',phase:'stopped',stoppedReason:'Worker proposal references a path outside the allowed scope: supported/unsupported/unverified',active:false,budgets:{roleTurns:{planner:2,orchestrator:1,worker:2,reviewer:2},workerAttempts:2}};
    const savedHtml=renderToStaticMarkup(createElement(App,{initialState:saved}));expect(savedHtml).toContain('>Resume saved correction</button>');expect(savedHtml).toContain('Resume will dispatch the saved Orchestrator correction proposal to a Worker');expect(savedHtml).toContain('It will not make another Orchestrator call, approve the result, or promote it.');expect(savedHtml).not.toContain('Correction cannot resume: Orchestrator role-turn budget is exhausted.');
    const exhausted=structuredClone(state);exhausted.projects[0]!.tasks[0]!.runs![0]!.controller!.budgets!.roleTurns.orchestrator=1;
    const exhaustedHtml=renderToStaticMarkup(createElement(App,{initialState:exhausted}));expect(exhaustedHtml).not.toContain('>Resume Reviewer correction</button>');expect(exhaustedHtml).toContain('Correction cannot resume: Orchestrator role-turn budget is exhausted.');
    const stale=structuredClone(state);stale.projects[0]!.tasks[0]!.runs![0]!.status='review';
    const staleHtml=renderToStaticMarkup(createElement(App,{initialState:stale}));expect(staleHtml).not.toContain('Recovered for human review');expect(staleHtml).not.toContain('UHP request failed (400): prompt_limit');
    const approved=structuredClone(state),approvedRun=approved.projects[0]!.tasks[0]!.runs![0]!;approvedRun.approval={id:'approval_recovered',approved:true,decision:'approved',evidenceDigest:'approved-digest',createdAt:'2026-09-25T13:00:00.000Z'};approvedRun.promotion={status:'not_started',evidenceDigest:'approved-digest'};approvedRun.status='completed';
    const approvedHtml=renderToStaticMarkup(createElement(App,{initialState:approved}));expect(approvedHtml).not.toContain('Recovered for human review');expect(approvedHtml).not.toContain('UHP request failed (400): prompt_limit');expect(approvedHtml).toContain('Approved despite the Reviewer’s request for changes. This finalized the current result; it did not send a correction to Orchestrator.');expect(approvedHtml).not.toContain('Approve despite requested changes');expect(approvedHtml).toContain('>Discard result and start a new run</button>');expect(approvedHtml).toContain('Reviewer still requests changes. Promotion would commit the current result as-is.');
    const abandoned=structuredClone(approved);abandoned.projects[0]!.tasks[0]!.status='ready';abandoned.projects[0]!.tasks[0]!.runs![0]!.status='abandoned';abandoned.projects[0]!.tasks[0]!.runs![0]!.promotion!.status='abandoned';
    const abandonedHtml=renderToStaticMarkup(createElement(App,{initialState:abandoned}));expect(abandonedHtml).toContain('Approved result abandoned; promotion is blocked');expect(abandonedHtml).toContain('The approval remains in this run’s History');expect(abandonedHtml).not.toContain('>Promote approved result</button>');expect(abandonedHtml).not.toContain('>Discard result and start a new run</button>');expect(abandonedHtml).not.toContain('This run has verified Worker evidence');expect(abandonedHtml).toContain('Approve task &amp; start work');
    const correctionFailed=structuredClone(state),correctionFailedRun=correctionFailed.projects[0]!.tasks[0]!.runs![0]!;correctionFailedRun.controller!.stoppedReason='UHP response did not report its session id';correctionFailedRun.assignments![2]!.error='UHP response did not report its session id';
    const correctionFailedHtml=renderToStaticMarkup(createElement(App,{initialState:correctionFailed}));expect(correctionFailedHtml).toContain('Run stopped');expect(correctionFailedHtml).not.toContain('Recovered for human review');expect(correctionFailedHtml).toContain('UHP response did not report its session id');
  });
  it('offers explicit reuse of a saved initial Worker proposal on a stopped run',()=>{
    const state:State={projects:[{id:'prj_saved_initial',name:'Saved proposal project',tasks:[{id:'tsk_saved_initial',title:'Map NBA coverage',status:'in progress',runs:[{id:'run_saved_initial',status:'failed',controller:{startedAt:'2026-09-25T12:00:00.000Z',phase:'stopped',active:false,stoppedReason:'Worker proposal references a path outside the allowed scope: LeagueDescription.ts',budgets:{roleTurns:{planner:2,orchestrator:1,worker:1,reviewer:1},workerAttempts:1}},assignments:[{id:'asgn_saved_initial',roleId:'orchestrator',status:'succeeded',createdAt:'2026-09-25T12:01:00.000Z',result:JSON.stringify({workerTask:'Target file: docs/api-matrix.md. Inspect nodes/Sleeper/Sleeper.node.ts, SportDescription.ts, and LeagueDescription.ts.'})}]}]}]}],roles:[],events:[{id:'saved_initial_invalid',type:'orchestrator.proposal_invalid',entityType:'run',entityId:'run_saved_initial',at:'2026-09-25T12:02:00.000Z',data:{assignmentId:'asgn_saved_initial',reason:'Worker proposal references a path outside the allowed scope: LeagueDescription.ts'}}]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('>Resume saved Worker proposal</button>');
    expect(html.match(/Worker proposal references a path outside the allowed scope: LeagueDescription\.ts/g)).toHaveLength(1);
    expect(html).not.toContain('Saved proposal rejection:');
    expect(html).toContain('It will not make another Orchestrator call, approve the result, or promote it.');
    expect(html).toContain('role="group" aria-label="Saved Worker proposal recovery"');
    expect(html).toContain('class="saved-proposal-actions"');
    expect(html).toContain('aria-describedby="saved-proposal-resume-description"');
    const unrelated=structuredClone(state);unrelated.events![0]!.data.assignmentId='another-assignment';
    expect(renderToStaticMarkup(createElement(App,{initialState:unrelated}))).not.toContain('>Resume saved Worker proposal</button>');
  });
  it('shows a correction cycle choice after a second Reviewer request for changes exhausts the run budget',()=>{
    const recommendation={id:'rec_second',status:'proposed' as const,provenance:'uhp_response' as const,reviewerAssignmentId:'reviewer_second',harnessId:'fixture',model:'model-fixture',responseId:'resp_reviewer_second',sessionId:'session_reviewer_second',reviewMode:'read_only' as const,mutationAttempted:false as const,verdict:'request_changes' as const,rationale:'The documentation still needs evidence.',createdAt:'2026-09-25T12:04:00.000Z'};
    const run:Run={id:'run_second_review',status:'awaiting_approval',controller:{startedAt:'2026-09-25T12:00:00.000Z',phase:'awaiting_approval',active:false,budgets:{roleTurns:{planner:3,orchestrator:3,worker:2,reviewer:2},workerAttempts:2}},assignments:[{id:'orchestrator_first',roleId:'orchestrator',status:'succeeded'},{id:'worker_first',roleId:'worker',status:'succeeded'},{id:'reviewer_first',roleId:'reviewer',status:'succeeded'},{id:'orchestrator_second',roleId:'orchestrator',status:'succeeded'},{id:'worker_second',roleId:'worker',status:'succeeded'},{id:'reviewer_second',roleId:'reviewer',status:'succeeded'}],reviewerRecommendation:recommendation,reviewerRecommendationHistory:[{...recommendation,id:'rec_first',reviewerAssignmentId:'reviewer_first',createdAt:'2026-09-25T12:02:00.000Z'},recommendation],workerEvidence:{workerAssignmentId:'worker_second',responseId:'resp_worker_second',pinnedBaseCommit:'a'.repeat(40),completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:1},scopeVerified:true,allowedScope:['docs/'],entries:[],changes:[{path:'docs/api-matrix.md',kind:'modified',summary:'NBA evidence'}],reviewDiff:'verified diff'},validation:{id:'validation_second',status:'passed',passed:true,checks:[],observations:[{name:'Fixture check',command:'true',args:[],exitCode:0,timedOut:false,output:'passed',outputTruncated:false,passed:true}]},orchestratorInbox:{id:'inbox_second',status:'received',runId:'run_second_review',sessionLocalId:'orch_session',workerAssignmentId:'worker_second',workerResponseId:'resp_worker_second',pinnedBaseCommit:'a'.repeat(40),allowedScope:['docs/'],reviewDiff:'verified diff',validation:{passed:true,observations:[]},evidenceDigest:'digest_second',receivedAt:'2026-09-25T12:03:00.000Z'}};
    const state:State={projects:[{id:'prj_second_review',name:'Second review',tasks:[{id:'tsk_second_review',title:'Map NBA coverage',status:'active',runs:[run]}]}],roles:[]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('Reviewer requested more changes');
    expect(html).toContain('Automatic correction stopped after 2 of 2 Worker attempts and 2 of 2 Reviewer turns.');
    expect(html).toContain('>Authorize another correction cycle</button>');
    expect(html).not.toContain('>Authorize Reviewer retry</button>');
    expect(html).toContain('>Reject result</button>');
    expect(html).toContain('>Approve despite requested changes</button>');
    const decided=structuredClone(state);decided.projects[0]!.tasks[0]!.runs![0]!.approval={id:'approval_second',approved:false,decision:'rejected',createdAt:'2026-09-25T12:05:00.000Z'};
    expect(renderToStaticMarkup(createElement(App,{initialState:decided}))).not.toContain('>Authorize another correction cycle</button>');
  });
  it('keeps project identity and repository switching in the compact header without a duplicate workspace card',()=>{
    const state:State={projects:[{id:'prj_scope',name:'Scope project',repoPath:'/repo/scope-project',tasks:[{id:'tsk_scope',title:'Add endpoint',goal:'Add the requested endpoint.',status:'ready'}]}],roles:[]};
    const workspace={repoPath:'/repo/scope-project',head:'a'.repeat(40),dirty:false,allowedScope:['nodes/','README.md'],validationCommands:[]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state,initialWorkspaceSetup:workspace}));
    expect(html).toContain('class="project-context" aria-label="Current project"');expect(html).toContain('class="project-name" title="Scope project">Scope project</span>');expect(html).toContain('/repo/scope-project');expect(html).toContain('Switch repo');
    expect(html).toContain('<summary>Repository details</summary>');expect(html).not.toContain('ACTIVE REPOSITORY');expect(html).not.toContain('class="repo-summary"');
    expect(html).not.toContain('class="rail"');expect(html).toContain('Project tree');expect(html).toContain('Add endpoint');expect(html).toContain('Add task');expect(html).toContain('Talk to the Planner');
  });
  it('offers per-project Reset Planner and deletion from row menus behind confirmation',()=>{
    const state:State={projects:[{id:'prj_admin',name:'Admin project',plannerMessages:[{id:'pmsg_admin',role:'user',text:'Keep the Planner history.',createdAt:'2026-09-24T12:00:00.000Z'}],tasks:[{id:'tsk_admin',title:'Admin task',goal:'Inspect task actions.',status:'ready'}]},{id:'prj_other_admin',name:'Other admin project',tasks:[]}],roles:[]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).not.toContain('class="rail"');expect(html).toContain('Project tree');expect(html).toContain('class="node project selected" title="Admin project"');expect(html).toContain('class="node task selected" title="Admin task"');expect(html).toContain('title="Other admin project"');
    expect(html).not.toContain('project-settings');expect(html).toContain('class="outline small" type="button"');expect(html).toContain('Reset Planner conversation');expect(html).toContain('Delete project');
    expect(html).toContain('aria-label="Actions for project Admin project"');expect(html).toContain('aria-label="Reset Planner conversation for Admin project"');expect(html).toContain('aria-label="Delete project Admin project"');expect(html).toContain('aria-label="Actions for project Other admin project"');expect(html).toContain('aria-label="Reset Planner conversation for Other admin project"');expect(html.match(/aria-label="Actions for project /g)).toHaveLength(2);
    expect(html).toContain('aria-label="Actions for task Admin task"');
    expect(html).not.toContain('class="admin-confirm"');expect(html).not.toContain('aria-labelledby="admin-action-title"');
  });
  it('offers task row actions without sending a request before confirmation',()=>{
    const state:State={projects:[{id:'prj_task_actions',name:'Task actions project',tasks:[{id:'tsk_approved_actions',title:'Approved task',goal:'Reset or delete this task.',status:'ready',planApproval:{status:'approved',approvedAt:'2026-09-24T12:00:00.000Z',specDigest:'fixture-digest'}}]}],roles:[]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('class="task-actions"><summary>Task actions</summary>');expect(html).not.toContain('<details class="task-actions" open');
    expect(html).toContain('Reset approved plan');expect(html).toContain('Delete task');expect(html).toContain('danger-action');
    expect(html).toContain('aria-label="Actions for task Approved task"');
    expect(html).not.toContain('class="admin-confirm"');expect(html).not.toContain('aria-labelledby="admin-action-title"');expect(html).not.toContain('/api/tasks/tsk_approved_actions/plan');expect(html).not.toContain('/api/tasks/tsk_approved_actions"');
  });
  it('shows live provider activity with role and model identity',()=>{
    const state:State={projects:[{id:'prj_live_activity',name:'Activity project',tasks:[{id:'tsk_live_activity',title:'Live task',runs:[{id:'run_live_activity',status:'running',assignments:[{id:'asgn_live_worker',roleId:'worker',status:'running',requestedConfig:{harnessId:'codex',model:'gpt-6-sol'}},{id:'asgn_live_reviewer',roleId:'reviewer',status:'running',requestedConfig:{harnessId:'anthropic',model:'claude-sonnet'}}]}]}]},{id:'prj_other',name:'Other project',plannerAssignments:[{id:'asgn_other_planner',roleId:'planner',status:'running'}]}],roles:[{id:'worker',name:'Worker',enabled:true},{id:'reviewer',name:'Reviewer',enabled:true},{id:'planner',name:'Planner',enabled:true}],events:[{id:'evt_provider_activity',type:'assignment.progress',entityType:'assignment',entityId:'asgn_live_worker',at:'2026-09-24T12:00:00.000Z',data:{assignmentId:'asgn_live_worker',providerEvent:{response:{activity:{kind:'tool',summary:'Reading src/index.ts'}}}}},{id:'evt_future_activity',type:'response.activity',entityType:'assignment',entityId:'asgn_live_reviewer',at:'2026-09-24T12:01:00.000Z',data:{assignmentId:'asgn_live_reviewer',roleId:'reviewer',model:'claude-sonnet',activity:{kind:'phase',summary:'Reviewing verified diff'}}},{id:'evt_other_project_activity',type:'assignment.progress',entityType:'assignment',entityId:'asgn_other_planner',at:'2026-09-24T12:02:00.000Z',data:{assignmentId:'asgn_other_planner',providerEvent:{response:{activity:{kind:'tool',summary:'SECRET unrelated project update'}}}}}]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state,initialCliUsage:{harnesses:[{harnessId:'codex',windows:{fiveHour:{status:'available',usedPercent:27,remainingPercent:73,resetsAt:'2026-09-24T18:00:00.000Z'},weekly:{status:'unsupported'}}}]}}));
    expect(html).toContain('Live Response');expect(html).toContain('Worker · gpt-6-sol');expect(html).toContain('Tool · Reading src/index.ts');expect(html).toContain('Reviewer · claude-sonnet');expect(html).toContain('Phase · Reviewing verified diff');expect(html).not.toContain('SECRET unrelated project update');expect(html).toContain('>Usage</button>');expect(html).not.toContain('73%');expect(html).not.toContain('Quota data is shown when the connected harness reports it.');
    const treeIndex=html.indexOf('class="tree card"'),treeContentIndex=html.indexOf('class="tree-content"',treeIndex),inspectorIndex=html.indexOf('aria-label="Inspector"'),liveIndex=html.indexOf('aria-label="Live Response"'),githubIndex=html.indexOf('aria-label="GitHub"');
    expect(treeIndex).toBeGreaterThan(-1);expect(treeContentIndex).toBeGreaterThan(treeIndex);expect(html).toContain('<summary>Repository details</summary>');expect(html).toContain('>History</button>');expect(html).toContain('>Usage</button>');
    expect(html).toContain('class="usage-dock" aria-label="Harness and measured usage"');expect(html).toContain('Project</span><b>No measured usage reported</b>');expect(html).toContain('Selected run</span><b>No measured usage reported</b>');expect(html).toContain('role="group" aria-label="Codex 5 hour usage"');expect(html).toContain('aria-valuenow="27"');expect(html).not.toContain('aria-label="Harness usage"');expect(html).not.toContain('Project details · usage &amp; activity');expect(inspectorIndex).toBeGreaterThan(treeContentIndex);expect(liveIndex).toBeGreaterThan(inspectorIndex);expect(githubIndex).toBeGreaterThan(liveIndex);expect(html.match(/aria-label="Live Response"/g)).toHaveLength(1);expect(html.match(/aria-label="GitHub"/g)).toHaveLength(1);expect(html).not.toContain('Hierarchy from local state');
    expect(html).toContain('role="separator" aria-orientation="vertical" aria-label="Resize project tree"');expect(html).toContain('aria-valuemin="180" aria-valuemax="360" aria-valuenow="220" tabindex="0"');expect(html).toContain('title="Live task"');expect(html).toContain('style="--tree-width:220px"');
  });
  it('keeps quotas in the sidebar and offers a dedicated Usage view',()=>{
    const state:State={projects:[{id:'prj_usage_groups',name:'Usage groups'}],roles:[]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state,initialCliUsage:{harnesses:[
      {harnessId:'antigravity-cli',groups:[{id:'gemini',label:'Gemini',windows:{fiveHour:{status:'available',usedPercent:22,remainingPercent:78,resetsAt:'2026-09-24T18:00:00.000Z'},weekly:{status:'unsupported'}}},{id:'claude',label:'Claude',windows:{weekly:{status:'available',usedPercent:41,remainingPercent:59}}}]},
      {harnessId:'antigravity-cli',windows:{fiveHour:{status:'available',usedPercent:45,remainingPercent:55}}},
      {harnessId:'claude-code',windows:{fiveHour:{status:'available',usedPercent:33,remainingPercent:67,observedAt:'2026-09-24T12:00:00.000Z'},weekly:{status:'unavailable'}}},
      {harnessId:'codex-cli',windows:{fiveHour:{status:'unavailable'},weekly:{status:'available',usedPercent:12,remainingPercent:88}}},
    ]}}));
    const inspectorIndex=html.indexOf('aria-label="Inspector"');
    expect(html).toContain('>Usage</button>');expect(html).toContain('>History</button>');expect(html).toContain('class="usage-dock" aria-label="Harness and measured usage"');expect(html).not.toContain('aria-label="Harness usage"');expect(inspectorIndex).toBeGreaterThan(html.indexOf('class="tree card"'));
    expect(html).toContain('Antigravity · Gemini');expect(html).toContain('Claude');expect(html).toContain('Codex');expect(html).not.toContain('Quota group');expect(html).not.toContain('CLI USAGE');expect(html).not.toContain('Hierarchy from local state');expect(html).toContain('aria-valuenow="22"');expect(html).toContain('aria-valuenow="45"');expect(html).toContain('aria-valuenow="33"');expect(html).toContain('aria-valuenow="12"');
  });
  it('defaults role configuration to an available scope when no run exists',()=>{
    const state:State={projects:[{id:'prj_no_run',name:'No run project',tasks:[{id:'tsk_no_run',title:'Ready task',runs:[]}]}],roles:[{id:'worker',name:'Worker',enabled:true,config:{harnessId:'codex',model:'gpt-6-sol'},availableConfigs:[{harnessId:'codex',model:'gpt-6-sol'}]}]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('class="outline small settings-button" type="button">Settings</button>');expect(html).not.toContain('aria-label="Configuration scope"');expect(html).not.toContain('id="roles"');expect(html).not.toContain('/api/runs/undefined/roles/worker/config');
  });
});
describe('antigravity-cli role warning',()=>{
  it('shows AGY warning in settings dialog when antigravity-cli is selected for orchestrator or planner',()=>{
    const agyCfg={harnessId:'antigravity-cli',model:'gemini-3.8-flash-high'};
    const state:State={projects:[{id:'prj_agy',name:'AGY project',tasks:[]}],roles:[
      {id:'planner',name:'Planner',enabled:true,config:agyCfg,availableConfigs:[agyCfg]},
      {id:'orchestrator',name:'Orchestrator',enabled:true,config:agyCfg,availableConfigs:[agyCfg]},
      {id:'worker',name:'Worker',enabled:true,config:{harnessId:'antigravity-cli',model:'gemini-3.8-flash-low'},availableConfigs:[{harnessId:'antigravity-cli',model:'gemini-3.8-flash-low'}]},
      {id:'reviewer',name:'Reviewer',enabled:true,config:{harnessId:'codex-cli',model:'gpt-6-sol'},availableConfigs:[{harnessId:'codex-cli',model:'gpt-6-sol'}]},
    ]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state,initialSettingsOpen:true}));
    // Warning should appear for planner and orchestrator, not for worker or reviewer
    const warningText='Antigravity is an agentic CLI; as';
    expect(html).toContain(warningText);
    // The warning text for the Planner and Orchestrator roles should mention the role names
    expect(html).toContain('as Planner it may try tools');
    expect(html).toContain('as Orchestrator it may try tools');
    // Worker with antigravity-cli should NOT have the warning (only planner/orchestrator)
    // Reviewer with codex-cli should NOT have the warning
    const reviewerIdx=html.indexOf('>Reviewer<');
    const reviewerSnippet=reviewerIdx>=0?html.slice(reviewerIdx,reviewerIdx+500):'';
    expect(reviewerSnippet).not.toContain('agy-role-warning');
  });
  it('shows AGY warning in task Advanced options when antigravity-cli is selected for orchestrator',()=>{
    const agyCfg={harnessId:'antigravity-cli',model:'gemini-3.8-flash-high'};
    const safeCfg={harnessId:'codex-cli',model:'gpt-6-sol'};
    const state:State={projects:[{id:'prj_agy_advanced',name:'AGY advanced',tasks:[{id:'tsk_agy',title:'Task with AGY orchestrator',runs:[]}]}],roles:[
      {id:'orchestrator',name:'Orchestrator',enabled:true,config:agyCfg,availableConfigs:[agyCfg,safeCfg]},
      {id:'worker',name:'Worker',enabled:true,config:safeCfg,availableConfigs:[safeCfg]},
      {id:'reviewer',name:'Reviewer',enabled:true,config:safeCfg,availableConfigs:[safeCfg]},
    ]};
    const preview:TaskStartPreview={taskId:'tsk_agy',scope:['README.md'],roleConfigs:{orchestrator:agyCfg,worker:safeCfg,reviewer:safeCfg},validationCriteria:[],validationCommands:[],budgets:{roleTurns:{planner:3,orchestrator:2,worker:1,reviewer:1},workerAttempts:1},baseCommit:'a'.repeat(40),requiresExplicitBase:false,reasons:[],canStart:true};
    const html=renderToStaticMarkup(createElement(App,{initialState:state,initialTaskStartPreview:preview}));
    expect(html).toContain('agy-role-warning');
    expect(html).toContain('Antigravity is an agentic CLI');
    expect(html).toContain('Claude Code or Codex is recommended for this role.');
  });
});

describe('task status pills',()=>{
  const makeState=(taskStatus:string,runStatus?:string,runExtra?:Record<string,unknown>):State=>({projects:[{id:'prj_pill',name:'Pill project',tasks:[{id:'tsk_pill',title:'Pill task',status:taskStatus,runs:runStatus?[{id:'run_pill',status:runStatus,...runExtra} as import('../ui/main.js').Task['runs'] extends Array<infer R>|undefined ? R : never]:[]}]}],roles:[]});
  it('renders tone-running pill for a running run',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeState('running','running')}));
    expect(html).toContain('class="status-pill tone-running"');
    expect(html).toContain('>Running<');
  });
  it('renders tone-running pill for an active task status',()=>{
    // task.status='active', no runs → taskRunDisplayStatus returns 'active'
    const html=renderToStaticMarkup(createElement(App,{initialState:makeState('active')}));
    expect(html).toContain('class="status-pill tone-running"');
    expect(html).toContain('>Active<');
  });
  it('renders tone-running pill for planning run status',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeState('active','planning')}));
    expect(html).toContain('class="status-pill tone-running"');
    expect(html).toContain('>Planning<');
  });
  it('renders tone-failed pill for a blocked task (failed run status)',()=>{
    // taskRunDisplayStatus returns 'blocked' when latest run status is 'failed'
    const html=renderToStaticMarkup(createElement(App,{initialState:makeState('active','failed')}));
    expect(html).toContain('class="status-pill tone-failed"');
    expect(html).toContain('>Blocked<');
  });
  it('renders tone-passed pill for a completed run',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeState('completed','completed')}));
    expect(html).toContain('class="status-pill tone-passed"');
    expect(html).toContain('>Completed<');
  });
  it('renders tone-passed pill for awaiting_approval when validation passed and reviewer recommended',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeState('active','awaiting_approval',{validation:{id:'v1',passed:true,status:'passed',checks:[]},reviewerRecommendation:{id:'rec1',provenance:'uhp_response',reviewerAssignmentId:'asgn1',verdict:'recommend',createdAt:'2026-01-01T00:00:00.000Z'}})}));
    expect(html).toContain('class="status-pill tone-passed"');
    expect(html).toContain('>Awaiting Approval<');
  });
  it('renders tone-neutral pill for awaiting_approval when validation not passed',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeState('active','awaiting_approval',{validation:{id:'v2',passed:false,status:'failed',checks:[]}})}));
    expect(html).toContain('class="status-pill tone-neutral"');
    expect(html).toContain('>Awaiting Approval<');
  });
  it('renders tone-neutral pill for awaiting_approval when reviewer requested changes',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeState('active','awaiting_approval',{validation:{id:'v3',passed:true,status:'passed',checks:[]},reviewerRecommendation:{id:'rec2',provenance:'uhp_response',reviewerAssignmentId:'asgn2',verdict:'request_changes',createdAt:'2026-01-01T00:00:00.000Z'}})}));
    expect(html).toContain('class="status-pill tone-neutral"');
  });
  it('renders tone-neutral pill for awaiting_approval when reviewer verdict is unparsed',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeState('active','awaiting_approval',{validation:{id:'v4',passed:true,status:'passed',checks:[]},reviewerRecommendation:{id:'rec3',provenance:'uhp_response',reviewerAssignmentId:'asgn3',verdict:'unparsed',createdAt:'2026-01-01T00:00:00.000Z'}})}));
    expect(html).toContain('class="status-pill tone-neutral"');
  });
  it('renders tone-neutral pill for a cancelled run',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeState('cancelled','cancelled')}));
    expect(html).toContain('class="status-pill tone-neutral"');
    expect(html).toContain('>Cancelled<');
  });
  it('renders tone-neutral pill for a ready task with no runs',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeState('ready')}));
    expect(html).toContain('class="status-pill tone-neutral"');
    expect(html).toContain('>Ready<');
  });
});

describe('validation check list and correction button',()=>{
  const ESC='\u001b';
  const ansiOutput=[
    `${ESC}[31mFAIL${ESC}[0m tests/routing.test.ts > routing hooks > rejects invalid values`,
    '',
    `${ESC}[31mAssertionError${ESC}[0m: expected 'error' to equal 'ok'`,
    `${ESC}[32m- Expected: "ok"${ESC}[0m`,
  ].join('\n');

  function makeValidationFailedState(workerCount:number,workerAttempts:number):State{
    const assignments:any[]=[{id:'asgn_orch_vf',roleId:'orchestrator',status:'succeeded'}];
    for(let i=0;i<workerCount;i++)assignments.push({id:`asgn_worker_vf_${i}`,roleId:'worker',status:'succeeded'});
    return {projects:[{id:'prj_vf',name:'Validation failed project',tasks:[{id:'tsk_vf',title:'Validation failed task',status:'in progress',runs:[{id:'run_vf',status:'failed',
      controller:{startedAt:'2026-09-26T10:00:00.000Z',phase:'stopped',active:false,stoppedReason:'Validation failed · 1 checks recorded.',budgets:{roleTurns:{planner:3,orchestrator:3,worker:workerAttempts,reviewer:2},workerAttempts}},
      assignments,
      workerEvidence:{workerAssignmentId:`asgn_worker_vf_${workerCount-1}`,responseId:'resp_vf',pinnedBaseCommit:'a'.repeat(40),completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:1},scopeVerified:true,allowedScope:['README.md'],entries:[],changes:[{path:'README.md',kind:'modified',summary:'Attempted fix'}]},
      validation:{status:'failed',observations:[{name:'tests',command:'pnpm',args:['test'],exitCode:1,timedOut:false,output:ansiOutput,outputTruncated:false,passed:false}]},
    }]}]}],roles:[]};
  }

  it('renders per-check list with tone-failed pill and extracts failing test name from ANSI output',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeValidationFailedState(1,2)}));
    expect(html).toContain('class="status-pill tone-failed"');
    expect(html).toContain('>Failed<');
    expect(html).toContain('>tests<');
    expect(html).toContain('$ pnpm test');
    expect(html).toContain('class="failing-test"');
    expect(html).toContain('tests/routing.test.ts &gt; routing hooks &gt; rejects invalid values');
    expect(html).toContain('class="full-output"');
    // ANSI stripped in validation-check-list section (failing-test/failure-line elements have plain text)
    const checkListStart=html.indexOf('class="validation-check-list"');
    const checkListEnd=html.indexOf('class="validation-correction-action"');
    const checkListSection=checkListStart>=0&&checkListEnd>checkListStart?html.slice(checkListStart,checkListEnd):'';
    expect(checkListSection).not.toContain('\u001b[');
  });

  it('shows Ask Orchestrator correction button when budget is available',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeValidationFailedState(1,2)}));
    expect(html).toContain('Ask Orchestrator for a correction');
    expect(html).toContain('class="validation-correction-action"');
  });

  it('does not show correction button when worker attempt budget is exhausted',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeValidationFailedState(2,2)}));
    expect(html).not.toContain('Ask Orchestrator for a correction');
  });
  it('renders exactly one correction button for a validation-blocked stopped run',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeValidationFailedState(1,2)}));
    const matches=html.match(/Ask Orchestrator for a correction/g);
    expect(matches).toHaveLength(1);
  });
});

describe('usage dock refresh stability',()=>{
  const baseState:State={projects:[{id:'prj_refresh',name:'Refresh project'}],roles:[]};
  const sampleUsage={harnesses:[{harnessId:'claude-code',windows:{fiveHour:{status:'available' as const,usedPercent:40,remainingPercent:60}}}]};
  it('with previous data and loading=true shows rows plus per-row spinners not a whole-element loading message',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:baseState,initialCliUsage:sampleUsage,initialCliUsageLoading:true}));
    expect(html).toContain('usage-provider');
    expect(html).toContain('class="usage-spinner"');
    expect(html).not.toContain('Loading quota reports');
  });
  it('on first load with no data shows the placeholder loading message',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:baseState,initialCliUsage:undefined,initialCliUsageLoading:true}));
    expect(html).toContain('Loading quota reports');
    expect(html).not.toContain('usage-provider');
  });
  it('with previous data and loading=false shows rows without spinners',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:baseState,initialCliUsage:sampleUsage,initialCliUsageLoading:false}));
    expect(html).toContain('usage-provider');
    expect(html).not.toContain('class="usage-spinner"');
  });
});

// ── Shared fixture helpers ─────────────────────────────────────────────────

const baseDecisionProps:DecisionPanelProps={
  filesChanged:3,allowedScope:['src/'],validationPassedCount:2,validationTotalCount:2,
  validationPassed:true,observations:[],reviewerVerdict:'recommend',
  reviewerRationaleSnippet:'Looks good.',approvable:true,reviewerRecommends:true,
  pending:false,onApprove:()=>{},onReject:()=>{},
  approved:false,promoted:false,branchPushed:false,prOpen:false,prMerged:false,
};

const sampleObservation=(name:string,passed:boolean,output?:string):StationObservation=>({
  name,command:'pnpm',args:['test'],exitCode:passed?0:1,timedOut:false,
  output:output??'',outputTruncated:false,passed,
});

// ── Decision panel ─────────────────────────────────────────────────────────

describe('decision panel',()=>{
  it('renders "Ready for your review" heading and checklist when awaiting approval',()=>{
    const html=renderToStaticMarkup(createElement(DecisionPanel,baseDecisionProps));
    expect(html).toContain('Ready for your review');
    expect(html).toContain('class="decision-checklist"');
    expect(html).toContain('>Changes<');
    expect(html).toContain('>Checks<');
    expect(html).toContain('>Reviewer<');
  });

  it('renders tone-passed pills for passed checks and recommend verdict',()=>{
    const html=renderToStaticMarkup(createElement(DecisionPanel,baseDecisionProps));
    // There should be tone-passed pills for files changed, checks passed, reviewer recommends
    const pillMatches=html.match(/class="status-pill tone-passed"/g);
    expect(pillMatches).not.toBeNull();
    expect(pillMatches!.length).toBeGreaterThanOrEqual(3);
  });

  it('renders primary Approve button when reviewer recommends',()=>{
    const html=renderToStaticMarkup(createElement(DecisionPanel,baseDecisionProps));
    expect(html).toContain('class="primary"');
    expect(html).toContain('>Approve result<');
  });

  it('renders outline Approve button and tone-failed Reviewer pill when request_changes',()=>{
    const props:DecisionPanelProps={...baseDecisionProps,reviewerVerdict:'request_changes',reviewerRecommends:false};
    const html=renderToStaticMarkup(createElement(DecisionPanel,props));
    expect(html).toContain('class="outline"');
    expect(html).toContain('>Approve result<');
    expect(html).toContain('class="status-pill tone-failed"');
    expect(html).toContain('Reviewer asks for changes');
  });

  it('renders tone-failed Reviewer pill when verdict is reject',()=>{
    const props:DecisionPanelProps={...baseDecisionProps,reviewerVerdict:'reject',reviewerRecommends:false};
    const html=renderToStaticMarkup(createElement(DecisionPanel,props));
    expect(html).toContain('Reviewer recommends rejecting');
    expect(html).toContain('class="status-pill tone-failed"');
  });

  it('shows disclaimer advisory text',()=>{
    const html=renderToStaticMarkup(createElement(DecisionPanel,baseDecisionProps));
    expect(html).toContain('The Reviewer only advises; you decide.');
  });

  it('shows Approve and Reject controls when not yet approved',()=>{
    const html=renderToStaticMarkup(createElement(DecisionPanel,baseDecisionProps));
    expect(html).toContain('>Approve result<');
    expect(html).toContain('>Reject result<');
  });

  it('hides approval controls when already approved',()=>{
    const props:DecisionPanelProps={...baseDecisionProps,approved:true,promoted:false};
    const html=renderToStaticMarkup(createElement(DecisionPanel,props));
    expect(html).not.toContain('>Approve result<');
    expect(html).not.toContain('>Reject result<');
  });
});

// ── Decision panel stepper ─────────────────────────────────────────────────

describe('decision panel stepper',()=>{
  it('shows Review as done and Approve as current when awaiting approval',()=>{
    const html=renderToStaticMarkup(createElement(DecisionPanel,baseDecisionProps));
    // Review step is always done
    expect(html).toContain('stepper-done');
    // Approve step is current
    expect(html).toContain('stepper-current');
    expect(html).toContain('>Approve<');
  });

  it('shows Approve as done and Promote as current after approval',()=>{
    const props:DecisionPanelProps={...baseDecisionProps,approved:true,promoted:false};
    const html=renderToStaticMarkup(createElement(DecisionPanel,props));
    // Promote should be current
    const currentIdx=html.indexOf('stepper-current');
    const promoteIdx=html.indexOf('>Promote<');
    expect(currentIdx).toBeGreaterThanOrEqual(0);
    // The "Promote" label appears near the current step class
    expect(Math.abs(currentIdx-promoteIdx)).toBeLessThan(500);
  });

  it('shows Promote and Push as done, PR as current after branch pushed',()=>{
    const props:DecisionPanelProps={...baseDecisionProps,approved:true,promoted:true,branchPushed:true,prOpen:false};
    const html=renderToStaticMarkup(createElement(DecisionPanel,props));
    expect(html).toContain('>Push<');
    // PR step should be current
    const prIdx=html.indexOf('>PR<');
    const currentIdx=html.indexOf('stepper-current');
    expect(prIdx).toBeGreaterThanOrEqual(0);
    expect(currentIdx).toBeGreaterThanOrEqual(0);
    expect(Math.abs(prIdx-currentIdx)).toBeLessThan(500);
  });

  it('shows next-step hint for Promote when approved but not promoted',()=>{
    const props:DecisionPanelProps={...baseDecisionProps,approved:true,promoted:false};
    const html=renderToStaticMarkup(createElement(DecisionPanel,props));
    expect(html).toContain('Promote approved result');
    expect(html).toContain('class="decision-next-step"');
  });

  it('shows PR open hint when PR is open',()=>{
    const props:DecisionPanelProps={...baseDecisionProps,approved:true,promoted:true,branchPushed:true,prOpen:true,prMerged:false,prUrl:'https://github.com/example/pr/1'};
    const html=renderToStaticMarkup(createElement(DecisionPanel,props));
    expect(html).toContain('is open');
    expect(html).toContain('href="https://github.com/example/pr/1"');
  });
});

// ── Checks pipeline ────────────────────────────────────────────────────────

describe('checks pipeline',()=>{
  it('renders passed and failed stations with correct tone classes',()=>{
    const obs=[sampleObservation('lint',true),sampleObservation('tests',false)];
    const html=renderToStaticMarkup(createElement(ChecksPipeline,{observations:obs}));
    expect(html).toContain('tone-passed');
    expect(html).toContain('tone-failed');
    expect(html).toContain('>lint<');
    expect(html).toContain('>tests<');
  });

  it('parses vitest output summary into "N passed · N failed of N" in station',()=>{
    const output='Tests  1 failed | 17 passed (18)\n';
    const obs=[sampleObservation('vitest',false,output)];
    const html=renderToStaticMarkup(createElement(ChecksPipeline,{observations:obs}));
    expect(html).toContain('17 passed · 1 failed of 18');
  });

  it('renders ciChecksNotConfigured note when provided',()=>{
    const obs=[sampleObservation('tests',true)];
    const html=renderToStaticMarkup(createElement(ChecksPipeline,{observations:obs,ciChecksNotConfigured:['format:check','lint']}));
    expect(html).toContain('class="checks-ci-unconfigured"');
    expect(html).toContain('format:check');
    expect(html).toContain('lint');
    expect(html).toContain('add them to this repository');
  });

  it('labels local vs remote check sections',()=>{
    const obs=[sampleObservation('tests',true)];
    const ci=[{name:'CI / build',status:'completed',conclusion:'success'}];
    const html=renderToStaticMarkup(createElement(ChecksPipeline,{observations:obs,ciChecks:ci}));
    expect(html).toContain('Foreman checks (local)');
    expect(html).toContain('GitHub CI (remote)');
    expect(html).toContain('CI / build');
  });

  it('returns null when observations empty and no CI',()=>{
    const el=createElement(ChecksPipeline,{observations:[]});
    const html=renderToStaticMarkup(el);
    expect(html).toBe('');
  });

  it('shows running placeholder when running=true and no observations yet',()=>{
    const html=renderToStaticMarkup(createElement(ChecksPipeline,{observations:[],running:true}));
    expect(html).toContain('tone-running');
    expect(html).toContain('Validating');
  });
});

// ── parseChecksSummary ─────────────────────────────────────────────────────

describe('parseChecksSummary',()=>{
  it('parses vitest "Tests N failed | N passed (total)"',()=>{
    expect(parseChecksSummary('Tests  1 failed | 17 passed (18)')).toBe('17 passed · 1 failed of 18');
  });
  it('parses vitest with only passed tests',()=>{
    expect(parseChecksSummary('Tests  42 passed (42)')).toBe('42 passed of 42');
  });
  it('parses node:test "# pass N / # fail N"',()=>{
    expect(parseChecksSummary('# pass 10\n# fail 2\n')).toBe('10 passed · 2 failed of 12');
  });
  it('strips ANSI codes before parsing',()=>{
    expect(parseChecksSummary('\u001b[32mTests  5 passed (5)\u001b[0m')).toBe('5 passed of 5');
  });
  it('returns undefined for unrecognised output',()=>{
    expect(parseChecksSummary('no summary here')).toBeUndefined();
  });
});

// ── Reviewer card UX ───────────────────────────────────────────────────────

describe('reviewer card UX',()=>{
  // Build a minimal awaiting_approval state with a reviewer recommendation
  const makeReviewerCardState=(verdict:'recommend'|'request_changes'):State=>({
    projects:[{id:'prj_reviewer_ux',name:'Reviewer UX project',tasks:[{
      id:'tsk_reviewer_ux',title:'Reviewer UX task',status:'in progress',runs:[{
        id:'run_reviewer_ux',status:'awaiting_approval',
        controller:{startedAt:'2026-09-26T10:00:00.000Z',phase:'awaiting_approval',active:false,budgets:{roleTurns:{planner:2,orchestrator:2,worker:2,reviewer:2},workerAttempts:2}},
        reviewerRecommendation:{
          id:'rec_ux',status:'proposed' as const,provenance:'uhp_response' as const,
          reviewerAssignmentId:'asgn_ux_reviewer',harnessId:'claude-code',model:'claude-opus-4',
          responseId:'resp_ux_reviewer',sessionId:'session_ux_reviewer',
          reviewMode:'read_only' as const,mutationAttempted:false as const,verdict,
          rationale:'The implementation looks solid and follows the patterns.',
          createdAt:'2026-09-26T10:05:00.000Z',
        },
        assignments:[
          {id:'asgn_ux_worker',roleId:'worker',status:'succeeded'},
          {id:'asgn_ux_reviewer',roleId:'reviewer',status:'succeeded'},
        ],
        workerEvidence:{
          workerAssignmentId:'asgn_ux_worker',responseId:'resp_ux_worker',
          pinnedBaseCommit:'a'.repeat(40),
          completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:1},
          scopeVerified:true,allowedScope:['src/'],entries:[],
          changes:[{path:'src/index.ts',kind:'modified',summary:'Added feature'}],
          reviewDiff:'verified diff',
        },
        validation:{status:'passed',passed:true,observations:[{
          name:'tests',command:'pnpm',args:['test'],exitCode:0,timedOut:false,
          output:'Tests  5 passed (5)',outputTruncated:false,passed:true,
        }]},
      }],
    }]}],
    roles:[...(['orchestrator','worker','reviewer'] as const).map(id=>({id,name:id,enabled:true,config:{harnessId:'claude-code',model:'claude-opus-4'},availableConfigs:[{harnessId:'claude-code',model:'claude-opus-4'}]}))],
  });

  it('does not contain "UHP" in the main reviewer card text (technical details collapsed)',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeReviewerCardState('recommend')}));
    // The visible summary label must be "Reviewer's answer", not "UHP Reviewer response"
    expect(html).toContain("Reviewer&#x27;s answer");
    // The tech-details collapse block is present and has a "Technical details" summary
    expect(html).toContain('class="reviewer-tech-details"');
    expect(html).toContain('Technical details');
    // The rationale text appears before the tech-details collapse
    const rationaleIdx=html.indexOf('The implementation looks solid');
    const techDetailsIdx=html.indexOf('class="reviewer-tech-details"');
    expect(rationaleIdx).toBeGreaterThanOrEqual(0);
    expect(techDetailsIdx).toBeGreaterThanOrEqual(0);
    expect(rationaleIdx).toBeLessThan(techDetailsIdx);
    // "UHP" in main card text: it should only appear in the service-strip or inside reviewer-tech-details
    // Everything before the tech-details block should not contain "UHP Reviewer response" or "UHP" as a label
    const textBeforeTech=html.slice(0,techDetailsIdx);
    // Confirm "UHP" does not appear as a standalone label or heading before the collapsed tech details
    expect(textBeforeTech).not.toContain('UHP Reviewer response');
  });

  it('shows "Reviewer recommends approving" verdict text prominently',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeReviewerCardState('recommend')}));
    expect(html).toContain('Reviewer recommends approving');
  });

  it('shows "Reviewer asks for changes" verdict text for request_changes',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeReviewerCardState('request_changes')}));
    expect(html).toContain('Reviewer asks for changes');
  });

  it('shows "The Reviewer only advises; you decide." advisory in reviewer card',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeReviewerCardState('recommend')}));
    expect(html).toContain('The Reviewer only advises; you decide.');
  });

  it('renders the decision panel when run is awaiting_approval with verified scope',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeReviewerCardState('recommend')}));
    expect(html).toContain('class="decision-panel card"');
    expect(html).toContain('Ready for your review');
    expect(html).toContain('aria-label="Delivery progress"');
  });

  it('shows checks pipeline stations inside the decision panel',()=>{
    const html=renderToStaticMarkup(createElement(App,{initialState:makeReviewerCardState('recommend')}));
    expect(html).toContain('class="checks-pipeline"');
    expect(html).toContain('>tests<');
  });
});

// ── Feature: ciChecksNotConfigured in task-start panel ──────────────────────

describe('ciChecksNotConfigured note in task-start panel',()=>{
  it('shows CI note when ciChecksNotConfigured is present in task start preview',()=>{
    const state:State={projects:[{id:'prj_ci_note',name:'CI note project',tasks:[{id:'tsk_ci_note',title:'CI note task',status:'ready'}]}],roles:[...['orchestrator','worker','reviewer'].map(id=>({id,name:id,enabled:true,config:{harnessId:'local',model:'model'},availableConfigs:[{harnessId:'local',model:'model'}]}))]};
    const preview:TaskStartPreview={taskId:'tsk_ci_note',scope:['src/'],roleConfigs:{orchestrator:{harnessId:'local',model:'model'},worker:{harnessId:'local',model:'model'},reviewer:{harnessId:'local',model:'model'}},validationCriteria:[],validationCommands:[{name:'Tests',command:'pnpm',args:['test']}],requiresExplicitBase:false,reasons:[],canStart:true,ciChecksNotConfigured:['format:check','lint']};
    const html=renderToStaticMarkup(createElement(App,{initialState:state,initialTaskStartPreview:preview}));
    expect(html).toContain('CI also runs');
    expect(html).toContain('format:check');
    expect(html).toContain('lint');
    expect(html).toContain('task-ci-note');
    expect(html).toContain('add them to this repository');
  });

  it('does not show CI note when ciChecksNotConfigured is empty',()=>{
    const state:State={projects:[{id:'prj_ci_empty',name:'CI empty project',tasks:[{id:'tsk_ci_empty',title:'CI empty task',status:'ready'}]}],roles:[...['orchestrator','worker','reviewer'].map(id=>({id,name:id,enabled:true,config:{harnessId:'local',model:'model'},availableConfigs:[{harnessId:'local',model:'model'}]}))]};
    const preview:TaskStartPreview={taskId:'tsk_ci_empty',scope:['src/'],roleConfigs:{orchestrator:{harnessId:'local',model:'model'},worker:{harnessId:'local',model:'model'},reviewer:{harnessId:'local',model:'model'}},validationCriteria:[],validationCommands:[{name:'Tests',command:'pnpm',args:['test']}],requiresExplicitBase:false,reasons:[],canStart:true,ciChecksNotConfigured:[]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state,initialTaskStartPreview:preview}));
    expect(html).not.toContain('class="task-ci-note"');
  });
});

// ── Feature: ChecksPipeline with CI failures ────────────────────────────────

describe('checks pipeline CI failures',()=>{
  it('renders CI failure details with job and step names',()=>{
    const ciChecks:GithubCheckEntry[]=[{
      name:'CI / build',status:'completed',conclusion:'failure',
      failures:[{jobName:'CI / build',stepName:'Run tests',excerpt:'Error: test failed\n  at expect'}],
    }];
    const html=renderToStaticMarkup(createElement(ChecksPipeline,{observations:[],ciChecks}));
    expect(html).toContain('Run tests');
    expect(html).toContain('Error: test failed');
    expect(html).toContain('class="ci-failure-item"');
  });

  it('shows uncovered-step hint when localCheckNames do not match failure step',()=>{
    const ciChecks:GithubCheckEntry[]=[{
      name:'CI / lint',status:'completed',conclusion:'failure',
      failures:[{jobName:'CI / lint',stepName:'eslint',excerpt:'ESLint: 2 problems'}],
    }];
    const html=renderToStaticMarkup(createElement(ChecksPipeline,{observations:[],ciChecks,localCheckNames:['Tests','Type check']}));
    expect(html).toContain('not in Foreman');
    expect(html).toContain('class="ci-failure-hint"');
  });

  it('does not show uncovered hint when localCheckNames match',()=>{
    const ciChecks:GithubCheckEntry[]=[{
      name:'CI / tests',status:'completed',conclusion:'failure',
      failures:[{jobName:'CI / tests',stepName:'tests',excerpt:'1 failed'}],
    }];
    const html=renderToStaticMarkup(createElement(ChecksPipeline,{observations:[],ciChecks,localCheckNames:['Tests','lint']}));
    expect(html).not.toContain('not in Foreman');
  });
});

// ── Feature: PR draft panel ─────────────────────────────────────────────────

describe('PR draft panel',()=>{
  it('shows "Draft PR description with Planner" button when no draft exists',()=>{
    const html=renderToStaticMarkup(createElement(PrDraftPanel,{runId:'run1',draft:undefined,onGenerate:()=>{},onSave:()=>{}}));
    expect(html).toContain('Draft PR description with Planner');
    expect(html).toContain('class="pr-draft-panel"');
  });

  it('shows draft title, body, and source badge when draft exists',()=>{
    const draft:PrDraftData={title:'Add feature X',body:'This PR adds feature X.',source:'planner',generatedAt:'2026-09-26T10:00:00.000Z'};
    const html=renderToStaticMarkup(createElement(PrDraftPanel,{runId:'run1',draft,onGenerate:()=>{},onSave:()=>{}}));
    expect(html).toContain('Add feature X');
    expect(html).toContain('This PR adds feature X.');
    expect(html).toContain('>Planner<');
    expect(html).toContain('Edit draft');
    expect(html).toContain('Regenerate with Planner');
  });

  it('shows "Template" source badge for template-sourced drafts',()=>{
    const draft:PrDraftData={title:'Fix bug Y',body:'Fixes Y.',source:'template',generatedAt:'2026-09-26T10:00:00.000Z'};
    const html=renderToStaticMarkup(createElement(PrDraftPanel,{runId:'run1',draft,onGenerate:()=>{},onSave:()=>{}}));
    expect(html).toContain('>Template<');
  });

  it('shows "Edited" source badge for user-edited drafts',()=>{
    const draft:PrDraftData={title:'My PR',body:'My description.',source:'edited',generatedAt:'2026-09-26T10:00:00.000Z'};
    const html=renderToStaticMarkup(createElement(PrDraftPanel,{runId:'run1',draft,onGenerate:()=>{},onSave:()=>{}}));
    expect(html).toContain('>Edited<');
  });

  it('shows error message when error prop provided',()=>{
    const html=renderToStaticMarkup(createElement(PrDraftPanel,{runId:'run1',draft:undefined,onGenerate:()=>{},onSave:()=>{},error:'Network error'}));
    expect(html).toContain('Network error');
    expect(html).toContain('class="pr-draft-error"');
  });
});
