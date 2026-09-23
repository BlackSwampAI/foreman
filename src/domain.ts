export type ProjectStatus = 'active' | 'archived';
export type TaskStatus = 'ready' | 'active' | 'blocked' | 'completed' | 'cancelled';
export type RunStatus = 'planning' | 'running' | 'waiting_guidance' | 'review' | 'validation' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
export type RoleKind = 'planner' | 'orchestrator' | 'worker' | 'reviewer';
export type AssignmentStatus = 'queued' | 'submitting' | 'submitted' | 'running' | 'cancel_requested' | 'cancelled' | 'succeeded' | 'failed' | 'needs_revision';
export type GuidanceStatus = 'queued' | 'delivered' | 'applied' | 'replan' | 'waiting' | 'cancelled';

export interface RoleConfig { provider: string; model: string; options?: Record<string, unknown> }
export interface Role { id: string; name: string; kind: RoleKind; enabled: boolean; config: RoleConfig; configSchema: Record<string, unknown>; availableConfigs: RoleConfig[] }
export interface Project { id: string; name: string; status: ProjectStatus; defaultRoleConfigs: Record<string, RoleConfig>; createdAt: string; tasks: Task[] }
export interface Task { id: string; title: string; status: TaskStatus; createdAt: string; runs: Run[] }
export interface Run { id: string; status: RunStatus; createdAt: string; plannerSessionId: string; orchestratorSessionId: string; roleConfigs: Record<string, RoleConfig>; guidance: Guidance[]; assignments: Assignment[] }
export interface Guidance { id: string; sequence: number; text: string; status: GuidanceStatus; createdAt: string; acknowledgment?: 'applied'|'replan'|'waiting'; acknowledgedAt?: string }
export interface Assignment { id: string; roleId: string; status: AssignmentStatus; requestedConfig: RoleConfig; actualConfig?: RoleConfig; prompt: string; submissionId: string; idempotencyKey: string; externalId?: string; sessionId?: string; responseId?: string; result?: unknown; error?: string; createdAt: string; cancelIdempotencyKey?: string }
export interface Event { id: string; type: string; entityType: string; entityId: string; at: string; data: Record<string, unknown> }
export interface State { version: 1; projects: Project[]; roles: Role[]; events: Event[] }
export const now = (): string => new Date().toISOString();
export const id = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

export function initialState(): State {
  const defaults: RoleConfig[] = [
    { provider: 'openai', model: 'codex' },
    { provider: 'anthropic', model: 'claude' },
  ];
  return { version: 1, projects: [], events: [], roles: [
    { id: 'planner', name: 'Planner', kind: 'planner', enabled: true, config: defaults[0]!, availableConfigs: defaults, configSchema: { type: 'object', required: ['provider','model'] } },
    { id: 'orchestrator', name: 'Orchestrator', kind: 'orchestrator', enabled: true, config: defaults[0]!, availableConfigs: defaults, configSchema: { type: 'object', required: ['provider','model'] } },
    { id: 'worker', name: 'Worker', kind: 'worker', enabled: true, config: defaults[0]!, availableConfigs: defaults, configSchema: { type: 'object', required: ['provider','model'] } },
    { id: 'reviewer', name: 'Reviewer', kind: 'reviewer', enabled: true, config: defaults[0]!, availableConfigs: defaults, configSchema: { type: 'object', required: ['provider','model'] } },
  ] };
}

export function validateRoleConfig(role: Role, config: RoleConfig): void {
  if (!role.enabled) throw new Error(`Role ${role.id} is disabled`);
  if (!config || typeof config.provider !== 'string' || typeof config.model !== 'string') throw new Error('Role config requires provider and model');
  if (!role.availableConfigs.some(c => c.provider === config.provider && c.model === config.model)) throw new Error(`Unsupported ${role.id} config: ${config.provider}/${config.model}`);
}
