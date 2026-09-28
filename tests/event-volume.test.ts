import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, type UhpAdapter } from '../src/controller.js';
import type { Assignment, Event, State as StoreState } from '../src/domain.js';
import { HIGH_VOL_RETAINED, HIGH_VOL_TYPES, pruneHighVolumeEvents } from '../src/state-transform.js';
import { JsonStore } from '../src/store.js';

const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
/** Counts full-state writes so a test can prove a no-op did not touch state.json. */
class CountingStore extends JsonStore{persists=0;protected override async persist(state:StoreState):Promise<void>{this.persists++;return super.persist(state);}}
async function setup(uhp:Partial<UhpAdapter>){
  const dir=await mkdtemp(join(tmpdir(),'foreman-event-volume-'));dirs.push(dir);
  const store=new CountingStore(join(dir,'state.json'));
  const adapter:UhpAdapter={submit:async()=>({externalId:'unused',status:'completed',outputText:'unused'}),cancel:async()=>({status:'cancelled'}),...uhp};
  await store.mutate(s=>{for(const role of s.roles){role.enabled=true;role.availableConfigs=[{harnessId:'fixture',model:'model-fixture'}];role.config={harnessId:'fixture',model:'model-fixture'};}});
  const controller=new Controller(store,adapter);
  const project:any=await controller.createProject('Event volume'),task:any=await controller.createTask(project.id,'Stream progress'),run:any=await controller.createRun(task.id);
  return {store,controller,runId:run.id as string};
}
const evt=(type:string,i:number,seq?:number):Event=>({id:`e_${type}_${i}`,type,entityType:'assignment',entityId:'a1',at:'2026-09-28T00:00:00.000Z',data:{i},...(seq===undefined?{}:{seq})});
const progressEvents=(state:{events:Event[]})=>state.events.filter(e=>e.type==='assignment.progress');

describe('streamed progress events',()=>{
  it('persist a bounded summary instead of the raw provider event',async()=>{
    const summary=`Reading src/index.ts ${'x'.repeat(2000)}`;
    const {store,controller,runId}=await setup({submit:async input=>{
      await input.onEvent?.({type:'response.created',responseId:'resp-1',sessionId:'sess-1',event:{type:'response.created',sequence_number:0,response:{id:'resp-1',status:'in_progress',metadata:{blob:'m'.repeat(5000)}}}});
      await input.onEvent?.({type:'response.activity',responseId:'resp-1',sessionId:'sess-1',event:{type:'response.activity',sequence_number:1,response:{id:'resp-1',status:'in_progress',activity:{kind:'tool',summary,extra:'a'.repeat(4000)},debug:'d'.repeat(5000)}}});
      await input.onEvent?.({type:'response.completed',responseId:'resp-1',sessionId:'sess-1',event:{type:'response.completed',sequence_number:2,response:{id:'resp-1',status:'completed',output_text:'o'.repeat(20_000)}}});
      return {externalId:'resp-1',responseId:'resp-1',sessionId:'sess-1',status:'completed',outputText:'done',actualModel:'model-fixture',requestedModel:'model-fixture',selectedHarnessId:'fixture'};
    }});
    await controller.assign(runId,'planner','Plan the change');
    const state=await store.load(),progress=progressEvents(state);
    expect(progress).toHaveLength(3);
    // Only identifiers and a few scalar response fields survive; provider metadata and payloads do not.
    expect(progress[0]!.data).toEqual({type:'response.created',responseId:'resp-1',sessionId:'sess-1',providerEvent:{response:{id:'resp-1',status:'in_progress'}}});
    // An activity keeps its kind and a summary cut to 300 characters, in the shape the UI reads (providerEvent.response.activity).
    expect(progress[1]!.data).toEqual({type:'response.activity',responseId:'resp-1',sessionId:'sess-1',providerEvent:{response:{id:'resp-1',status:'in_progress',activity:{kind:'tool',summary:summary.slice(0,300)}}}});
    expect((progress[1]!.data as any).providerEvent.response.activity.summary).toHaveLength(300);
    expect(progress[2]!.data).toEqual({type:'response.completed',responseId:'resp-1',sessionId:'sess-1',providerEvent:{response:{id:'resp-1',status:'completed'}}});
    const persisted=JSON.stringify(progress);
    expect(persisted).not.toContain('ooooo');expect(persisted).not.toContain('mmmmm');expect(persisted).not.toContain('ddddd');expect(persisted).not.toContain('aaaaa');
    expect(persisted.length).toBeLessThan(1500);
    // Identifiers still reach the assignment.
    const assignment=state.projects[0]!.tasks[0]!.runs[0]!.assignments[0]!;
    expect(assignment).toMatchObject({responseId:'resp-1',sessionId:'sess-1',status:'succeeded'});
  });

  it('keeps only the most recent high-volume events in persisted state without disturbing sequencing',async()=>{
    const total=HIGH_VOL_RETAINED+120;
    const {store,controller,runId}=await setup({submit:async input=>{
      for(let i=0;i<total;i++)await input.onEvent?.({type:'response.activity',responseId:'resp-cap',sessionId:'sess-cap',event:{type:'response.activity',response:{id:'resp-cap',activity:{kind:'tool',summary:`step ${i}`}}}});
      return {externalId:'resp-cap',responseId:'resp-cap',sessionId:'sess-cap',status:'completed',outputText:'done',actualModel:'model-fixture',requestedModel:'model-fixture',selectedHarnessId:'fixture'};
    }});
    const emitted:Event[]=[];store.on('mutation',(events:Event[])=>emitted.push(...events));
    await controller.assign(runId,'planner','Plan the change');
    const state=await store.load(),progress=progressEvents(state);
    expect(progress).toHaveLength(HIGH_VOL_RETAINED);
    expect((progress[0]!.data as any).providerEvent.response.activity.summary).toBe(`step ${total-HIGH_VOL_RETAINED}`);
    expect((progress.at(-1)!.data as any).providerEvent.response.activity.summary).toBe(`step ${total-1}`);
    // Other event types are never pruned, seq stays strictly increasing, and the counter never rewinds.
    expect(state.events.some(e=>e.type==='assignment.submission_intent')).toBe(true);
    const seqs=state.events.map(e=>e.seq!);expect(seqs).toEqual([...seqs].sort((a,b)=>a-b));expect(new Set(seqs).size).toBe(seqs.length);
    expect(progress[0]!.seq).toBeGreaterThan(1);expect(state.eventSeq).toBe(Math.max(...seqs));
    // Every event, including ones pruned later, was emitted (for SSE) with its own increasing seq.
    expect(emitted.filter(e=>e.type==='assignment.progress')).toHaveLength(total);
    const emittedSeqs=emitted.map(e=>e.seq!);expect(emittedSeqs).toEqual([...emittedSeqs].sort((a,b)=>a-b));
  },60_000);
});

describe('pruneHighVolumeEvents',()=>{
  it('keeps every high-volume type consistent with the UI trim and drops only the oldest ones in place',()=>{
    expect([...HIGH_VOL_TYPES].sort()).toEqual(['assignment.progress','assignment.reconciled']);
    const events:Event[]=[];let seq=0;
    for(let i=0;i<30;i++){events.push(evt('assignment.progress',i,++seq));if(i%5===0)events.push(evt('run.created',i,++seq));if(i%3===0)events.push(evt('assignment.reconciled',i,++seq));}
    const same=events;const others=events.filter(e=>!HIGH_VOL_TYPES.has(e.type));
    pruneHighVolumeEvents(events,10);
    expect(events).toBe(same);
    const kept=events.filter(e=>HIGH_VOL_TYPES.has(e.type));
    expect(kept).toHaveLength(10);
    expect(events.filter(e=>!HIGH_VOL_TYPES.has(e.type))).toEqual(others);
    expect(events.map(e=>e.seq)).toEqual([...events.map(e=>e.seq!)].sort((a,b)=>a-b));
    // The survivors are the newest ten high-volume events across both types.
    expect(kept.at(-1)!.id).toBe('e_assignment.progress_29');
  });

  it('is a no-op under the cap, never drops an event that has no seq yet, and trims a long legacy backlog in one pass',()=>{
    const few=Array.from({length:HIGH_VOL_RETAINED},(_,i)=>evt('assignment.progress',i,i+1));
    pruneHighVolumeEvents(few);expect(few).toHaveLength(HIGH_VOL_RETAINED);
    const fresh=[evt('assignment.progress',1,1),evt('assignment.progress',2),evt('assignment.reconciled',3)];
    pruneHighVolumeEvents(fresh,1);
    expect(fresh.map(e=>e.id)).toEqual(['e_assignment.progress_2','e_assignment.reconciled_3']);
    const backlog=Array.from({length:20_000},(_,i)=>evt(i%2?'assignment.progress':'assignment.reconciled',i,i+1));backlog.push(evt('run.created',0,20_001));
    pruneHighVolumeEvents(backlog);
    expect(backlog).toHaveLength(HIGH_VOL_RETAINED+1);expect(backlog.at(-1)!.type).toBe('run.created');expect(backlog[0]!.seq).toBe(20_000-HIGH_VOL_RETAINED+1);
  });
});

describe('reconcile of a running assignment',()=>{
  const assignment=(id:string,status:Assignment['status'],responseId:string):Assignment=>({id,roleId:'planner',status,requestedConfig:{harnessId:'fixture',model:'model-fixture'},responseId,externalId:responseId,prompt:'plan',submissionId:`sub-${id}`,idempotencyKey:`idem-${id}`,createdAt:new Date().toISOString()});
  async function seeded(retrieve:UhpAdapter['retrieve']){
    const fixture=await setup({retrieve});
    await fixture.store.mutate(s=>{s.projects[0]!.tasks[0]!.runs[0]!.assignments.push(assignment('a_running','running','resp_running'),assignment('a_cancel','cancel_requested','resp_cancel'),assignment('a_submitted','submitting','resp_submitted'));});
    return fixture;
  }
  const status=async(store:JsonStore,id:string)=>store.load().then(s=>s.projects[0]!.tasks[0]!.runs[0]!.assignments.find(a=>a.id===id)!.status);

  it('does not write state or emit events when nothing changed, and records a real status change exactly once',async()=>{
    const {store,controller}=await seeded(async responseId=>({id:responseId,status:'in_progress'}));
    const writes=store.persists,events=(await store.load()).events.length;
    for(let i=0;i<5;i++){await controller.refreshAssignment('a_running');await controller.refreshAssignment('a_cancel');}
    expect(store.persists).toBe(writes);expect((await store.load()).events).toHaveLength(events);
    expect(await status(store,'a_running')).toBe('running');expect(await status(store,'a_cancel')).toBe('cancel_requested');
    // A submitting assignment that the provider reports as in progress does change (submitting -> running).
    await controller.refreshAssignment('a_submitted');
    expect(await status(store,'a_submitted')).toBe('running');
    expect(store.persists).toBe(writes+1);
    const reconciled=(await store.load()).events.filter(e=>e.type==='assignment.reconciled');
    expect(reconciled).toHaveLength(1);expect(reconciled[0]).toMatchObject({entityId:'a_submitted',data:{responseId:'resp_submitted',status:'in_progress'}});
    // Polling it again is a no-op.
    for(let i=0;i<5;i++)await controller.refreshAssignment('a_submitted');
    expect(store.persists).toBe(writes+1);expect((await store.load()).events.filter(e=>e.type==='assignment.reconciled')).toHaveLength(1);
  });

  it('still records terminal responses and applies the persisted cap to reconcile events',async()=>{
    const {store,controller}=await seeded(async responseId=>({id:responseId,status:responseId==='resp_running'?'completed':'in_progress',output_text:'finished'}));
    await store.mutate(s=>{for(let i=0;i<HIGH_VOL_RETAINED+50;i++)s.events.push(evt('assignment.reconciled',i));});
    await controller.refreshAssignment('a_running');
    expect(await status(store,'a_running')).toBe('succeeded');
    const state=await store.load();
    expect(state.projects[0]!.tasks[0]!.runs[0]!.assignments.find(a=>a.id==='a_running')!.result).toBe('finished');
    const reconciled=state.events.filter(e=>e.type==='assignment.reconciled');
    expect(reconciled).toHaveLength(HIGH_VOL_RETAINED);expect(reconciled.at(-1)).toMatchObject({entityId:'a_running',data:{status:'succeeded'}});
  });
});
