import { createHash } from "node:crypto";

export interface HindsightOptions {
  baseUrl: string;
  token?: string;
  tenantId?: string;
  recallMaxTokens?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface HindsightMemory {
  id?: string;
  text: string;
  type?: string;
  context?: string;
  [key: string]: unknown;
}

export interface RecallResult {
  status: "ready" | "degraded";
  bankId: string;
  memories: HindsightMemory[];
  error?: string;
}

export interface RetainResult {
  status: "accepted" | "degraded" | "skipped";
  bankId: string;
  operationId?: string;
  error?: string;
}

export interface HindsightOutcome {
  projectId: string;
  submissionId: string;
  runId: string;
  roleId: string;
  taskId: string;
  outcome: string;
  summary?: string;
  completedAt?: string;
  /** Must be true only after a human has approved this result for retention. */
  humanApproved: boolean;
}

export class HindsightClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly tenantId: string;
  private readonly ensuredBanks = new Set<string>();

  constructor(private readonly options: HindsightOptions) {
    if (!options.baseUrl) throw new Error("Hindsight baseUrl must be configured");
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    this.fetchImpl = options.fetch ?? fetch;
    this.tenantId = options.tenantId ?? "default";
  }

  bankIdForProject(projectId: string): string {
    if (!projectId.trim()) throw new Error("projectId is required for project memory");
    return `foreman-project-${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}`;
  }

  /** Create/verify the project's isolated bank without making a model call. */
  async ensureBank(projectId: string): Promise<{ status: "ready" | "degraded"; bankId: string; error?: string }> {
    const bankId = this.bankIdForProject(projectId);
    if (this.ensuredBanks.has(bankId)) return { status: "ready", bankId };
    try {
      await this.request("PUT", this.bankPath(bankId, ""), {});
      this.ensuredBanks.add(bankId);
      return { status: "ready", bankId };
    } catch (error) {
      return { status: "degraded", bankId, error: safeError(error) };
    }
  }

  /**
   * Recall is deliberately non-blocking for task execution: service, auth, and
   * schema errors return a degraded empty context for the caller to record.
   */
  async recall(projectId: string, query: string): Promise<RecallResult> {
    const bankId = this.bankIdForProject(projectId);
    try {
      if (!query.trim()) return { status: "ready", bankId, memories: [] };
      const maxTokens = integerInRange(this.options.recallMaxTokens ?? 1200, 100, 4096, "recallMaxTokens");
      const ensured = await this.ensureBank(projectId);
      if (ensured.status === "degraded") return { status: "degraded", bankId, memories: [], error: ensured.error };
      const path = this.bankPath(bankId, "memories/recall");
      const response = await this.request("POST", path, { query: query.slice(0, 12_000), budget: "low", max_tokens: maxTokens });
      const items = Array.isArray(response.results) ? response.results : [];
      const memories = items.filter((item): item is HindsightMemory => !!item && typeof item === "object" && typeof (item as HindsightMemory).text === "string").slice(0, 20);
      return { status: "ready", bankId, memories };
    } catch (error) {
      return { status: "degraded", bankId, memories: [], error: safeError(error) };
    }
  }

  /**
   * Store a bounded outcome asynchronously. A stable document_id makes retries
   * idempotent without a separate provider call; Hindsight accepts async retains
   * with an operation_id which callers may monitor out of band.
   */
  async retainAcceptedOutcome(outcome: HindsightOutcome): Promise<RetainResult> {
    const bankId = this.bankIdForProject(outcome.projectId);
    if (outcome.humanApproved !== true) return { status: "skipped", bankId, error: "Outcome was not approved for retention" };
    try {
      const ensured = await this.ensureBank(outcome.projectId);
      if (ensured.status === "degraded") return { status: "degraded", bankId, error: ensured.error };
      const content = formatOutcome(outcome);
      const response = await this.request("POST", this.bankPath(bankId, "memories"), {
        async: true,
        items: [{
          content,
          context: "Foreman project task outcome",
          document_id: `foreman-submission-${safeDocumentPart(outcome.submissionId)}`,
          update_mode: "replace",
          tags: [`project:${tagPart(outcome.projectId)}`, `role:${tagPart(outcome.roleId)}`, `task:${tagPart(outcome.taskId)}`],
          metadata: { source: "foreman", submission_id: outcome.submissionId, run_id: outcome.runId, project_id: outcome.projectId, role_id: outcome.roleId, task_id: outcome.taskId },
        }],
      });
      const operationId = typeof response.operation_id === "string" ? response.operation_id : undefined;
      return { status: "accepted", bankId, ...(operationId ? { operationId } : {}) };
    } catch (error) {
      return { status: "degraded", bankId, error: safeError(error) };
    }
  }

  /** Controller-facing compatibility name; the approval guard remains mandatory. */
  async retainOutcome(outcome: HindsightOutcome & { humanApproved: true }): Promise<Omit<RetainResult, "status"> & { status: "accepted" | "degraded" }> {
    const result = await this.retainAcceptedOutcome(outcome);
    return { ...result, status: result.status === "accepted" ? "accepted" : "degraded" };
  }

  private async request(method: string, path: string, body: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method, headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(integerInRange(this.options.timeoutMs ?? 3_000, 200, 30_000, "timeoutMs")),
    });
    if (!response.ok) throw new Error(`Hindsight request failed (${response.status})`);
    return response.json() as Promise<Record<string, unknown>>;
  }

  private bankPath(bankId: string, suffix: string): string {
    const bankPath = `v1/${encodeURIComponent(this.tenantId)}/banks/${encodeURIComponent(bankId)}`;
    return suffix ? `${bankPath}/${suffix}` : bankPath;
  }
}

function formatOutcome(outcome: HindsightOutcome): string {
  const summary = outcome.summary?.trim().slice(0, 8_000);
  const outcomeText = outcome.outcome.trim().slice(0, 4_000);
  if (!outcomeText) throw new Error("Outcome text is required");
  return [
    `Foreman task outcome: ${outcomeText}`,
    `Role: ${outcome.roleId.slice(0, 160)}`,
    `Task: ${outcome.taskId.slice(0, 160)}`,
    `Run: ${outcome.runId.slice(0, 160)}`,
    summary ? `Summary: ${summary}` : undefined,
    outcome.completedAt ? `Completed at: ${outcome.completedAt.slice(0, 80)}` : undefined,
  ].filter((line): line is string => !!line).join("\n");
}

function safeDocumentPart(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
function tagPart(value: string): string { return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 80) || "unknown"; }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 240) : "Hindsight request failed"; }
function integerInRange(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
