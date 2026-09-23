export type ProjectStatus = 'active' | 'archived';
export type TaskStatus = 'ready' | 'active' | 'blocked' | 'completed' | 'cancelled';
export type RunStatus = 'planning' | 'running' | 'waiting_guidance' | 'review' | 'validation' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
export type RoleKind = 'planner' | 'orchestrator' | 'worker' | 'reviewer';
export type AssignmentStatus = 'queued' | 'submitting' | 'submitted' | 'running' | 'cancel_requested' | 'cancelled' | 'succeeded' | 'failed' | 'needs_revision';
export type GuidanceStatus = 'queued' | 'delivered' | 'applied' | 'replan' | 'waiting' | 'cancelled';

export interface RoleConfig { harnessId: string; model: string; options?: Record<string, unknown> }
export interface Usage { inputTokens?:number; outputTokens?:number; totalTokens?:number; cachedInputTokens?:number; runtimeMs?:number; requestCount?:number; measured?:true }
export interface Role { id: string; name: string; kind: RoleKind; enabled: boolean; config: RoleConfig; configSchema: Record<string, unknown>; availableConfigs: RoleConfig[]; usage?:Usage; usageByHarnessModel?:Record<string,Usage> }
export interface Project { id: string; name: string; status: ProjectStatus; defaultRoleConfigs: Record<string, RoleConfig>; createdAt: string; tasks: Task[]; usage?:Usage; usageByHarnessModel?:Record<string,Usage> }
export interface Task { id: string; title: string; status: TaskStatus; createdAt: string; runs: Run[] }
export interface RoleSession { localId: string; roleId: 'planner'|'orchestrator'; generation: number; status: 'new'|'active'|'rotated'; config: RoleConfig; uhpSessionId?: string; responseId?: string; startedAt: string; rotatedAt?: string }
export interface ReviewRecord { id: string; status:'proposed'|'verified'; reviewerAssignmentId: string; implementationAssignmentIds: string[]; verdict: 'clear'|'changes_requested'|'rejected'; scope: string[]; summary: string; createdAt: string }
export interface WorkerEvidence { provenance:'bridge_snapshot'|'recorded_replay'; workerAssignmentId:string; responseId:string; actualModel?:string; usage?:Usage; pinnedBaseCommit:string; completeSnapshot:{reportedComplete:true;reportedErrors:0;entryCount:number}; scopeVerified:true; allowedScope:string[]; entries:import('./workspace-snapshot.js').SnapshotEntry[]; changes:import('./workspace-snapshot.js').SnapshotChange[]; reviewDiff:string; acceptance:'not_decided'|'accepted'|'rejected' }
export interface GitEvidence { status: 'unverified'|'verified'; commit?: string; tree?: string; changedPaths?: string[]; submittedAt: string }
export interface ValidationCheck { name:string; command:string; args:string[]; exitCode:number|null; signal?:string; timedOut:boolean; output:string; outputTruncated:boolean; startedAt:string; finishedAt:string; passed:boolean }
export interface ValidationRecord { id: string; status:'unverified'|'passed'|'failed'; passed: boolean; reportedPassed:boolean; checks: Array<{name:string;passed:boolean;details?:string}>; observations?:ValidationCheck[]; policy?:{requireAllChecksPass:true;configuredCheckCount:number}; gitEvidence?: GitEvidence; createdAt: string }
export interface ReviewerRecommendation { id:string; status:'proposed'; provenance:'uhp_response'|'simulated_fixture'; reviewerAssignmentId:string; harnessId:string; model:string; actualModel?:string; responseId:string; verdict:'recommend'|'request_changes'|'reject'|'unparsed'; rationale:string; createdAt:string }
export interface ApprovalRecord { id: string; approved: boolean; decision:'approved'|'rejected'; evidenceCommit?:string; rationale?:string; createdAt: string }
export interface Run { id: string; status: RunStatus; createdAt: string; pinnedBaseCommit?:string; workspaceId?:string; reviewerRetryAuthorized?:boolean; reviewerRecommendationHistory?:ReviewerRecommendation[]; plannerSessionId?: string; orchestratorSessionId?: string; sessions: {planner:RoleSession;orchestrator:RoleSession}; sessionHistory:RoleSession[]; roleConfigs: Record<string, RoleConfig>; guidance: Guidance[]; assignments: Assignment[]; reviews:ReviewRecord[]; workerEvidence?:WorkerEvidence; validation?:ValidationRecord; reviewerRecommendation?:ReviewerRecommendation; approval?:ApprovalRecord; usage?:Usage; usageByRole?:Record<string,Usage>; usageByHarnessModel?:Record<string,Usage> }
export interface Guidance { id: string; sequence: number; text: string; status: GuidanceStatus; createdAt: string; plannerAssignmentId?:string; plannerReply?:string; checkpointHandoffAssignmentId?:string; acknowledgment?: 'applied'|'replan'|'waiting'; acknowledgedAt?: string }
export interface Assignment { id: string; roleId: string; status: AssignmentStatus; requestedConfig: RoleConfig; actualConfig?: RoleConfig; configOutcome?:'confirmed'|'substituted'|'unavailable'; configNotes?:{boundsApplied?:boolean;ignoredFields?:string[]}; usage?:Usage; prompt: string; submissionId: string; idempotencyKey: string; externalId?: string; sessionId?: string; responseId?: string; result?: unknown; error?: string; createdAt: string; cancelIdempotencyKey?: string }
export interface Event { id: string; type: string; entityType: string; entityId: string; at: string; data: Record<string, unknown> }
export interface State { version: 1; projects: Project[]; roles: Role[]; events: Event[] }
export const now = (): string => new Date().toISOString();
export const id = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

export function initialState(): State {
  return { version: 1, projects: [], events: [], roles: [
    { id: 'planner', name: 'Planner', kind: 'planner', enabled: false, config: { harnessId:'', model:'' }, availableConfigs: [], configSchema: { type: 'object', required: ['harnessId','model'] } },
    { id: 'orchestrator', name: 'Orchestrator', kind: 'orchestrator', enabled: false, config: { harnessId:'', model:'' }, availableConfigs: [], configSchema: { type: 'object', required: ['harnessId','model'] } },
    { id: 'worker', name: 'Worker', kind: 'worker', enabled: false, config: { harnessId:'', model:'' }, availableConfigs: [], configSchema: { type: 'object', required: ['harnessId','model'] } },
    { id: 'reviewer', name: 'Reviewer', kind: 'reviewer', enabled: false, config: { harnessId:'', model:'' }, availableConfigs: [], configSchema: { type: 'object', required: ['harnessId','model'] } },
  ] };
}

export function validateRoleConfig(role: Role, config: RoleConfig): void {
  if (!role.enabled) throw new Error(`Role ${role.id} is disabled`);
  if (!config || typeof config.harnessId !== 'string' || typeof config.model !== 'string') throw new Error('Role config requires harnessId and model');
  if (!role.availableConfigs.some(c => c.harnessId === config.harnessId && c.model === config.model)) throw new Error(`Unsupported ${role.id} config: ${config.harnessId}/${config.model}`);
}
