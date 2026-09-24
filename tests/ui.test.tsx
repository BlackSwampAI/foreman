import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, type State } from '../ui/main.js';

describe('project Planner UI',()=>{
  it('shows the continuing Planner, task tree, start controls, and named navigation with inline icons',()=>{
    const state:State={projects:[{id:'prj_fixture',name:'Opened repository',plannerSession:{localId:'planner-session-fixture',roleId:'planner',generation:1,status:'active',config:{harnessId:'fixture',model:'simulated'},startedAt:'2026-01-01T00:00:00.000Z'},plannerMessages:[{id:'pmsg_user',role:'user',text:'Update the node README and add a REST endpoint.',createdAt:'2026-01-01T00:00:00.000Z'},{id:'pmsg_planner',role:'planner',text:'I split this into two tasks.',createdAt:'2026-01-01T00:01:00.000Z'}],tasks:[{id:'tsk_readme_fixture',title:'Update README',goal:'Document the node behavior.',suggestedAllowedPaths:['README.md'],validationCriteria:['README check passes'],status:'ready',runs:[]},{id:'tsk_endpoint_fixture',title:'Add REST endpoint',goal:'Implement the requested API endpoint.',suggestedAllowedPaths:['src/http/'],validationCriteria:['Endpoint tests pass'],status:'ready',runs:[]}]}],roles:[...['planner','orchestrator','worker','reviewer'].map(id=>({id,name:id,enabled:true,config:{harnessId:'fixture',model:'simulated'},availableConfigs:[{harnessId:'fixture',model:'simulated'}]}))]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('Talk to the Planner');expect(html).toContain('One continuing conversation for this repository');expect(html).toContain('Update the node README and add a REST endpoint.');expect(html).toContain('Update README');expect(html).toContain('Add REST endpoint');expect(html).toContain('Start work');expect(html).toContain('Message project Planner');
    expect(html).toContain('aria-label="Main navigation"');for(const label of ['Projects','Runs','Roles','Events','Usage'])expect(html).toContain(`>${label}</button>`);
    expect(html).toContain('aria-label="Refresh state"');expect(html).toContain('<svg aria-hidden="true" focusable="false"');expect(html).not.toContain('objtext');
  });
  it('hides a legacy structured proposal payload and keeps the readable Planner reply',()=>{
    const state:State={projects:[{id:'prj_fixture',name:'Opened repository',plannerMessages:[{id:'pmsg_user',role:'user',text:'Add a health endpoint.',createdAt:'2026-01-01T00:00:00.000Z'},{id:'pmsg_planner',role:'planner',assignmentId:'asgn_fixture',text:'I prepared a task.\n{"reply":"See [the docs](https://example.com/docs) for context.","tasks":[{"title":"Add health endpoint"}]}',createdAt:'2026-01-01T00:01:00.000Z'}],tasks:[]}],roles:[]};
    const html=renderToStaticMarkup(createElement(App,{initialState:state}));
    expect(html).toContain('See ');expect(html).toContain('href="https://example.com/docs"');expect(html).not.toContain('I prepared a task.');expect(html).toContain('Earlier Planner proposal');expect(html).toContain('Create proposed tasks');expect(html).not.toContain('&quot;tasks&quot;');expect(html).toContain('Message project Planner');
  });
});
