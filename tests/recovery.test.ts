import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Controller, type UhpAdapter } from '../src/controller.js';
import type { Assignment } from '../src/domain.js';
import { JsonStore } from '../src/store.js';

const dirs:string[]=[];
const unhandled:unknown[]=[];
const onUnhandled=(reason:unknown)=>{unhandled.push(reason);};
process.on('unhandledRejection',onUnhandled);
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
const cfg={harnessId:'fixture',model:'model-fixture'};
const tick=(ms=20)=>new Promise(resolve=>setTimeout(resolve,ms));
const pending=async(p:Promise<unknown>)=>(await Promise.race([p.then(()=>'settled'),tick(60).then(()=>'pending')]))==='pending';
const assignment=(id:string,status:Assignment['status'],extra:Partial<Assignment>={}):Assignment=>({id,roleId:'worker',status,requestedConfig:cfg,prompt:'work',submissionId:`sub-${id}`,idempotencyKey:`idem-${id}`,createdAt:new Date().toISOString(),...extra});

/** A persisted store holding one run, plus a gate that releases every hung UHP call. */
async function seed(assignments:Assignment[]) {
  const dir=await mkdtemp(join(tmpdir(),'foreman-'));dirs.push(dir);const path=join(dir,'state.json'),store=new JsonStore(path);
  const first=new Controller(store,{submit:async()=>({externalId:'x',status:'completed'}),cancel:async()=>({status:'cancelled'})});
  const project:any=await first.createProject('Recovery'),task:any=await first.createTask(project.id,'Task'),run:any=await first.createRun(task.id);
  await store.mutate(s=>{s.projects[0]!.tasks[0]!.runs[0]!.assignments.push(...assignments);});
  let release:()=>void=()=>undefined;const gate=new Promise<void>(resolve=>{release=resolve;});
  const retrieved:string[]=[],submitted:string[]=[];
  const uhp:UhpAdapter={
    submit:async input=>{submitted.push(input.assignmentId);await gate;return {externalId:'ext',responseId:'resp',status:'completed'};},
    retrieve:async responseId=>{retrieved.push(responseId);await gate;return {id:responseId,status:'completed',output_text:'done'} as any;},
    cancel:async()=>({status:'cancelled'}),
  };
  const restarted=new Controller(new JsonStore(path),uhp);
  return {controller:restarted,store:restarted.store,run,release,retrieved,submitted,gate};
}
const stateOf=async(controller:Controller)=>(await controller.store.load());

describe('non-blocking recovery',()=>{
  it('reports running while a UHP retrieve hangs, and startRecovery returns immediately',async()=>{
    const {controller,retrieved,release}=await seed([assignment('a1','running',{responseId:'resp-1',externalId:'resp-1'})]);
    expect(controller.recoveryStatus()).toEqual({status:'idle'});
    const recovery=controller.startRecovery('test');await tick();
    expect(controller.recoveryStatus()).toMatchObject({status:'running',startedAt:expect.any(String)});
    expect(retrieved).toEqual(['resp-1']);expect(await pending(recovery)).toBe(true);
    expect((await controller.serviceStatus()).recovery.status).toBe('running');
    release();await recovery;
    expect(controller.recoveryStatus()).toMatchObject({status:'idle',finishedAt:expect.any(String)});
    expect((await stateOf(controller)).projects[0]!.tasks[0]!.runs[0]!.assignments[0]!.status).toBe('succeeded');
  });
  it('reports running while a UHP submit replay hangs',async()=>{
    const {controller,submitted,release}=await seed([assignment('a1','submitting')]);
    const recovery=controller.startRecovery();await tick();
    expect(submitted).toEqual(['a1']);expect(controller.recoveryStatus().status).toBe('running');expect(await pending(recovery)).toBe(true);
    release();await recovery;expect(controller.recoveryStatus().status).toBe('idle');
  });
  it('never runs twice concurrently for one controller',async()=>{
    const {controller,retrieved,release}=await seed([assignment('a1','running',{responseId:'resp-1',externalId:'resp-1'})]);
    const first=controller.startRecovery(),second=controller.startRecovery(),direct=controller.recover();direct.catch(()=>undefined);await tick();
    expect(controller.recover()).toBe(direct);expect(retrieved).toEqual(['resp-1']);
    release();await Promise.all([first,second,direct]);expect(retrieved).toEqual(['resp-1']);
    // Once settled a later call starts a fresh recovery.
    const fresh=controller.recover();expect(fresh).not.toBe(direct);await fresh;
  });
  it('records a rejected recovery as failed with a redacted event, logs to stderr, and never leaks an unhandled rejection',async()=>{
    const {controller}=await seed([]);const stderr=vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
    vi.spyOn(controller as any,'migrateProjectRoleConfigs').mockRejectedValue(new Error('boom Authorization: Bearer sk-abcdefghijklmnop1234 token=hunter2\nsecond line'));
    await controller.startRecovery('project-x');await tick(30);
    const status=controller.recoveryStatus();
    expect(status).toMatchObject({status:'failed',lastError:expect.stringContaining('boom'),lastErrorAt:expect.any(String),finishedAt:expect.any(String)});
    expect(JSON.stringify(status)).not.toMatch(/hunter2|abcdefghijklmnop|second line/);
    const events=(await stateOf(controller)).events.filter(e=>e.type==='recovery.failed');
    expect(events).toHaveLength(1);expect(JSON.stringify(events[0]!.data)).not.toMatch(/hunter2|abcdefghijklmnop/);
    const logged=stderr.mock.calls.map(c=>String(c[0])).join('');expect(logged).toContain('Recovery failed for project-x');expect(logged).not.toMatch(/hunter2|abcdefghijklmnop/);
    expect(unhandled).toEqual([]);
    // A later successful recovery clears the failure.
    (controller as any).migrateProjectRoleConfigs.mockRestore();await controller.startRecovery();
    expect(controller.recoveryStatus().status).toBe('idle');expect(controller.recoveryStatus().lastError).toBeUndefined();
  });
  it('recover() itself still rejects for direct callers',async()=>{
    const {controller}=await seed([]);vi.spyOn(controller as any,'resumePendingRetentions').mockRejectedValue(new Error('direct'));
    await expect(controller.recover()).rejects.toThrow('direct');expect(controller.recoveryStatus().status).toBe('failed');expect(unhandled).toEqual([]);
  });
  it('reconcileRunning skips assignments recovery still owns but reconciles new ones',async()=>{
    const {controller,store,retrieved,release}=await seed([assignment('a1','running',{responseId:'resp-1',externalId:'resp-1'})]);
    const recovery=controller.startRecovery();await tick();expect(retrieved).toEqual(['resp-1']);
    await store.mutate(s=>{s.projects[0]!.tasks[0]!.runs[0]!.assignments.push(assignment('a2','running',{responseId:'resp-2',externalId:'resp-2'}));});
    const reconciling=controller.reconcileRunning();await tick();
    // a1 is owned by recovery (no second retrieve); a2 was created after recovery started and is reconciled normally (its retrieve is gated too).
    expect(retrieved).toEqual(['resp-1','resp-2']);
    release();await Promise.all([recovery,reconciling]);
    const assignments=(await stateOf(controller)).projects[0]!.tasks[0]!.runs[0]!.assignments;
    expect(assignments.map(a=>a.status)).toEqual(['succeeded','succeeded']);
    expect((await stateOf(controller)).events.filter(e=>e.type==='assignment.reconciled'&&e.entityId==='a1')).toHaveLength(1);
    // After recovery settles the loop covers everything again.
    await store.mutate(s=>{const a=s.projects[0]!.tasks[0]!.runs[0]!.assignments[0]!;a.status='running';});await controller.reconcileRunning();expect(retrieved.filter(r=>r==='resp-1')).toHaveLength(2);
  });
  it('does not stop a run that became active after recovery began',async()=>{
    const {controller,store,run,release,retrieved}=await seed([assignment('a1','running',{responseId:'resp-1',externalId:'resp-1'})]);
    controller.configureVerifiedWorkspace({repoPath:'/fixture/repo',bridgeBaseUrl:'http://127.0.0.1:1',allowedScope:['README.md'],commands:[{name:'check',command:'true',args:[]}]});
    const other:any=await controller.createRun((await stateOf(controller)).projects[0]!.tasks[0]!.id);
    await store.mutate(s=>{const runs=s.projects[0]!.tasks[0]!.runs;runs.find(r=>r.id===run.id)!.controller={startedAt:new Date().toISOString(),active:true,phase:'working',budgets:{roleTurns:{planner:1,orchestrator:1,worker:1,reviewer:1},workerAttempts:1}} as any;});
    const recovery=controller.startRecovery();await tick();expect(retrieved).toEqual(['resp-1']);
    await store.mutate(s=>{s.projects[0]!.tasks[0]!.runs.find(r=>r.id===other.id)!.controller={startedAt:new Date().toISOString(),active:true,phase:'working',budgets:{roleTurns:{planner:1,orchestrator:1,worker:1,reviewer:1},workerAttempts:1}} as any;});
    release();await recovery;
    const runs=(await stateOf(controller)).projects[0]!.tasks[0]!.runs;
    expect(runs.find(r=>r.id===run.id)!.controller?.active).toBe(false);
    expect(runs.find(r=>r.id===other.id)!.controller?.active).toBe(true);
  });
  it('does not overwrite a terminal assignment with a stale running observation',async()=>{
    const {controller,store}=await seed([assignment('a1','submitting',{responseId:'resp-1',externalId:'resp-1'})]);
    (controller.uhp as any).retrieve=async()=>{await store.mutate(s=>{s.projects[0]!.tasks[0]!.runs[0]!.assignments[0]!.status='succeeded';});return {id:'resp-1',status:'in_progress'};};
    await controller.refreshAssignment('a1');
    expect((await stateOf(controller)).projects[0]!.tasks[0]!.runs[0]!.assignments[0]!.status).toBe('succeeded');
  });
});
