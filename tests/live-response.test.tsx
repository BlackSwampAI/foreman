import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../src/controller.js';
import { stateForUi } from '../src/state-transform.js';
import { JsonStore } from '../src/store.js';
import { App, type State } from '../ui/main.js';

const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});

async function setup(submit:NonNullable<ConstructorParameters<typeof Controller>[1]['submit']>){
  const dir=await mkdtemp(join(tmpdir(),'foreman-live-response-'));dirs.push(dir);
  const store=new JsonStore(join(dir,'state.json'));
  await store.mutate(s=>{for(const role of s.roles){role.enabled=true;role.availableConfigs=[{harnessId:'fixture',model:'model-fixture'}];role.config={harnessId:'fixture',model:'model-fixture'};}});
  const controller=new Controller(store,{submit,cancel:async()=>({status:'cancelled'})});
  const project:any=await controller.createProject('Live response'),task:any=await controller.createTask(project.id,'Stream progress'),run:any=await controller.createRun(task.id);
  return {store,controller,runId:run.id as string};
}

describe('Live Response panel',()=>{
  it('still shows the persisted provider activity summary in the Live Response panel',async()=>{
    const summary=`Reading src/index.ts ${'x'.repeat(2000)}`;
    const {store,controller,runId}=await setup(async input=>{
      await input.onEvent?.({type:'response.created',responseId:'resp-1',sessionId:'sess-1',event:{type:'response.created',sequence_number:0,response:{id:'resp-1',status:'in_progress',metadata:{blob:'m'.repeat(5000)}}}});
      await input.onEvent?.({type:'response.activity',responseId:'resp-1',sessionId:'sess-1',event:{type:'response.activity',sequence_number:1,response:{id:'resp-1',status:'in_progress',activity:{kind:'tool',summary,extra:'a'.repeat(4000)},debug:'d'.repeat(5000)}}});
      await input.onEvent?.({type:'response.completed',responseId:'resp-1',sessionId:'sess-1',event:{type:'response.completed',sequence_number:2,response:{id:'resp-1',status:'completed',output_text:'o'.repeat(20_000)}}});
      return {externalId:'resp-1',responseId:'resp-1',sessionId:'sess-1',status:'completed',outputText:'done',actualModel:'model-fixture',requestedModel:'model-fixture',selectedHarnessId:'fixture'};
    });
    await controller.assign(runId,'planner','Plan the change');
    const state=await store.load();
    const html=renderToStaticMarkup(createElement(App,{initialState:stateForUi(state) as unknown as State}));
    expect(html).toContain('Live Response');expect(html).toContain('Tool · Reading src/index.ts');
  });
});
