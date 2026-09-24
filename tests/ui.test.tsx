import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, type State, type TaskStartPreview } from '../ui/main.js';

describe('project Planner UI',()=>{
  it('shows the continuing Planner, task tree, start controls, and named navigation with inline icons',()=>{
    const state:State={projects:[{id:'prj_fixture',name:'Opened repository',plannerSession:{localId:'planner-session-fixture',roleId:'planner',generation:1,status:'active',config:{harnessId:'fixture',model:'simulated'},startedAt:'2026-01-01T00:00:00.000Z'},plannerMessages:[{id:'pmsg_user',role:'user',text:'Update the node README and add a REST endpoint.',createdAt:'2026-01-01T00:00:00.000Z'},{id:'pmsg_planner',role:'planner',text:'I split this into two tasks.',createdAt:'2026-01-01T00:01:00.000Z'}],tasks:[{id:'tsk_readme_fixture',title:'Update README',goal:'Document the node behavior.',suggestedAllowedPaths:['README.md'],validationCriteria:['README check passes'],status:'ready',runs:[]},{id:'tsk_endpoint_fixture',title:'Add REST endpoint',goal:'Implement the requested API endpoint.',suggestedAllowedPaths:['src/http/'],validationCriteria:['Endpoint tests pass'],status:'ready',runs:[]}]}],roles:[...['planner','orchestrator','worker','reviewer'].map(id=>({id,name:id,enabled:true,config:{harnessId:'fixture',model:'simulated'},availableConfigs:[{harnessId:'fixture',model:'simulated'}]}))]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('Talk to the Planner');expect(html).toContain('One continuing conversation for this repository');expect(html).toContain('Update the node README and add a REST endpoint.');expect(html).toContain('Update README');expect(html).toContain('Add REST endpoint');expect(html).toContain('Start work');expect(html).toContain('Message project Planner');
    expect(html).toContain('aria-label="Main navigation"');for(const label of ['Projects','Runs','Roles','Events','Usage'])expect(html).toContain(`>${label}</button>`);
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
    expect(html).toContain('Add search endpoint');expect(html).toContain('Let clients search active records.');expect(html).toContain('Returns matching records');expect(html).toContain('Rejects invalid query');expect(html).toContain('Approve task &amp; start work');expect(html).toContain('TASK PLAN APPROVAL');expect(html).toContain('review the verified result and approve or reject it separately');expect(html).toContain('Advanced options');expect(html).toContain('<details class="task-advanced">');expect(html).not.toContain('Start work</button>');
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
    expect(html).toContain('Task plan approved');expect(html).toContain('Run run_approved');expect(html).toContain('Result review and approval are still separate.');
  });
  it('keeps the active repository summary compact and makes its allowed path list optional',()=>{
    const state:State={projects:[{id:'prj_scope',name:'Scope project',tasks:[]}],roles:[]};
    const workspace={repoPath:'/repo/scope-project',head:'a'.repeat(40),dirty:false,allowedScope:['nodes/','README.md'],validationCommands:[]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state,initialWorkspaceSetup:workspace}));
    expect(html).toContain('ALLOWED FILES');expect(html).toContain('<b>2 allowed paths</b>');expect(html).toContain('<details class="repo-scope-list" aria-label="Allowed repository paths">');expect(html).toContain('Show all 2 paths');expect(html).toContain('nodes/, README.md');expect(html).not.toContain('<details class="repo-scope-list" aria-label="Allowed repository paths" open');
  });
});
