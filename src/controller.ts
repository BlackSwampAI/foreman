import { id, now, validateRoleConfig, type Assignment, type Event, type Guidance, type RoleConfig, type State } from './domain.js';
import { JsonStore } from './store.js';

export interface UhpAdapter {
  submit(input: { submissionId: string; assignmentId: string; runId: string; roleId: string; taskId: string; projectId: string; prompt: string; config: Record<string, unknown>; idempotencyKey: string }): Promise<{ externalId: string; responseId?: string; sessionId?: string; status?: string; output?: unknown; outputText?: string; result?: unknown }>;
  cancel(input: { submissionId: string; externalId?: string; idempotencyKey: string }): Promise<{ status: string }>;
}
const event = (type: string, entityType: string, entityId: string, data: Record<string, unknown> = {}): Event => ({ id: id('evt'), type, entityType, entityId, at: now(), data });
const must = <T>(item: T | undefined, what: string): T => { if (!item) throw Object.assign(new Error(`${what} not found`), { statusCode: 404 }); return item; };

export class Controller {
  constructor(readonly store: JsonStore, readonly uhp: UhpAdapter) {}
  state(): Promise<State> { return this.store.load(); }

  async createProject(name: string): Promise<unknown> {
    const clean = name.trim(); if (!clean) throw new Error('Project name is required');
    return this.store.mutate(s => { const project = { id: id('prj'), name: clean, status: 'active' as const, defaultRoleConfigs: {}, createdAt: now(), tasks: [] }; s.projects.push(project); s.events.push(event('project.created','project',project.id,{name:clean})); return project; });
  }
  async createTask(projectId: string, title: string): Promise<unknown> {
    const clean = title.trim(); if (!clean) throw new Error('Task title is required');
    return this.store.mutate(s => { const p = must(s.projects.find(x=>x.id===projectId),'Project'); const task = { id:id('tsk'), title:clean, status:'ready' as const, createdAt:now(), runs:[] }; p.tasks.push(task); s.events.push(event('task.created','task',task.id,{projectId,title:clean})); return task; });
  }
  async createRun(taskId: string): Promise<unknown> {
    return this.store.mutate(s => { const {task}=this.findTask(s,taskId); const run = { id:id('run'), status:'planning' as const, createdAt:now(), plannerSessionId:id('planner-session'), orchestratorSessionId:id('orchestrator-session'), roleConfigs: structuredClone(this.findProject(s,taskId).defaultRoleConfigs), guidance:[] as Guidance[], assignments:[] as Assignment[] }; task.status='active'; task.runs.push(run); s.events.push(event('run.created','run',run.id,{taskId,plannerSessionId:run.plannerSessionId,orchestratorSessionId:run.orchestratorSessionId})); return run; });
  }
  async addGuidance(runId: string, text: string): Promise<unknown> {
    const clean=text.trim(); if(!clean) throw new Error('Guidance text is required');
    return this.store.mutate(s=>{ const run=this.findRun(s,runId); const g: Guidance={id:id('guide'),sequence:Math.max(0,...run.guidance.map(x=>x.sequence))+1,text:clean,status:run.assignments.some(a=>['submitted','running','cancel_requested'].includes(a.status))?'queued':'delivered',createdAt:now()}; run.guidance.push(g); if(g.status==='queued') run.status='waiting_guidance'; s.events.push(event('guidance.added','guidance',g.id,{runId,sequence:g.sequence,status:g.status,text:clean})); return g; });
  }
  async acknowledgeGuidance(guidanceId: string, acknowledgment: 'applied'|'replan'|'waiting'): Promise<unknown> {
    if(!['applied','replan','waiting'].includes(acknowledgment)) throw new Error('Invalid guidance acknowledgment');
    return this.store.mutate(s=>{ const g=must(s.projects.flatMap(p=>p.tasks).flatMap(t=>t.runs).flatMap(r=>r.guidance).find(x=>x.id===guidanceId),'Guidance'); g.status=acknowledgment; g.acknowledgment=acknowledgment; g.acknowledgedAt=now(); s.events.push(event('guidance.acknowledged','guidance',g.id,{acknowledgment})); return g; });
  }
  async assign(runId: string, roleId: string, prompt: string, config?: RoleConfig): Promise<unknown> {
    const submissionId=id('sub'), assignmentId=id('asgn'), key=id('idem');
    const prep = await this.store.mutate(s=>{ const {project,task,run}=this.findRunContext(s,runId); const role=must(s.roles.find(x=>x.id===roleId),'Role'); const requested=config ?? run.roleConfigs[roleId] ?? project.defaultRoleConfigs[roleId] ?? role.config; validateRoleConfig(role,requested); if(!prompt.trim()) throw new Error('Assignment prompt is required'); const a: Assignment={id:assignmentId,roleId,status:'submitting',requestedConfig:structuredClone(requested),prompt:prompt.trim(),submissionId,idempotencyKey:key,createdAt:now()}; run.assignments.push(a); run.status='running'; s.events.push(event('assignment.submission_intent','assignment',a.id,{runId,roleId,submissionId,idempotencyKey:key,requestedConfig:requested})); return {a,project,task,run}; });
    return this.submitExisting(prep.project.id,prep.task.id,prep.run.id,prep.a.id);
  }
  async recover(): Promise<void> {
    const s=await this.store.load();
    for (const p of s.projects) for(const t of p.tasks) for(const r of t.runs) for(const a of r.assignments) if(a.status==='submitting') await this.submitExisting(p.id,t.id,r.id,a.id).catch(()=>undefined);
  }
  private async submitExisting(projectId:string,taskId:string,runId:string,assignmentId:string): Promise<unknown> {
    const snapshot=await this.store.load(); const {a}=this.findAssignment(snapshot,assignmentId); if(a.status!=='submitting') return a;
    try {
      const response=await this.uhp.submit({submissionId:a.submissionId,assignmentId:a.id,runId,roleId:a.roleId,taskId,projectId,prompt:a.prompt,config:{...a.requestedConfig},idempotencyKey:a.idempotencyKey});
      return this.store.mutate(s=>{const {a:r,run}=this.findAssignment(s,assignmentId); r.externalId=response.externalId; r.responseId=response.responseId; r.sessionId=response.sessionId; r.actualConfig=structuredClone(r.requestedConfig); r.status=normalizeStatus(response.status); r.result=response.output ?? response.outputText ?? response.result; run.status=r.status==='failed'?'failed':r.status==='needs_revision'?'review':r.status==='succeeded'?'review':'running'; s.events.push(event('assignment.submitted','assignment',r.id,{submissionId:r.submissionId,externalId:r.externalId,responseId:r.responseId,sessionId:r.sessionId,status:r.status,actualConfig:r.actualConfig})); return r;});
    } catch(error) { await this.store.mutate(s=>{const {a:r}=this.findAssignment(s,assignmentId); r.error=error instanceof Error?error.message:String(error); s.events.push(event('assignment.submit_uncertain','assignment',r.id,{error:r.error,idempotencyKey:r.idempotencyKey}));}); throw error; }
  }
  async cancelAssignment(assignmentId:string): Promise<unknown> {
    const item=await this.store.mutate(s=>{const {a}=this.findAssignment(s,assignmentId); if(['cancelled','succeeded','failed'].includes(a.status)) return a; a.status='cancel_requested'; a.cancelIdempotencyKey ??= id('idem-cancel'); s.events.push(event('assignment.cancel_intent','assignment',a.id,{idempotencyKey:a.cancelIdempotencyKey})); return a;});
    if(item.status!=='cancel_requested') return item;
    const response=await this.uhp.cancel({submissionId:item.submissionId,externalId:item.externalId,idempotencyKey:item.cancelIdempotencyKey!});
    return this.store.mutate(s=>{const {a}=this.findAssignment(s,assignmentId); a.status=response.status==='cancelled'?'cancelled':'cancel_requested'; s.events.push(event('assignment.cancel_result','assignment',a.id,{status:response.status})); return a;});
  }
  private findTask(s:State,id:string) { for(const p of s.projects){const task=p.tasks.find(t=>t.id===id);if(task)return {project:p,task};} throw Object.assign(new Error('Task not found'),{statusCode:404}); }
  private findProject(s:State,taskId:string) { return this.findTask(s,taskId).project; }
  private findRun(s:State,id:string) { for(const p of s.projects)for(const t of p.tasks){const r=t.runs.find(r=>r.id===id);if(r)return r;} throw Object.assign(new Error('Run not found'),{statusCode:404}); }
  private findRunContext(s:State,id:string) { for(const p of s.projects)for(const t of p.tasks){const run=t.runs.find(r=>r.id===id);if(run)return {project:p,task:t,run};} throw Object.assign(new Error('Run not found'),{statusCode:404}); }
  private findAssignment(s:State,id:string) { for(const p of s.projects)for(const t of p.tasks)for(const run of t.runs){const a=run.assignments.find(a=>a.id===id);if(a)return {a,run};} throw Object.assign(new Error('Assignment not found'),{statusCode:404}); }
}
function normalizeStatus(status?:string): Assignment['status'] { if(status==='completed'||status==='succeeded') return 'succeeded'; if(status==='incomplete') return 'needs_revision'; if(status==='failed'||status==='running'||status==='cancelled'||status==='needs_revision') return status; return 'submitted'; }
