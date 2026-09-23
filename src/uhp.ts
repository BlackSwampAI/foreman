export const UHP_VERSION = "2026-09-12";

export type UhpTerminalStatus = "completed" | "failed" | "incomplete" | "cancelled";

export interface UhpSubmitInput {
  submissionId: string;
  assignmentId: string;
  runId: string;
  roleId: string;
  taskId: string;
  projectId: string;
  prompt: string;
  config: Record<string, unknown>;
  idempotencyKey: string;
  onEvent?: (event: UhpProgressEvent) => void | Promise<void>;
}

export interface UhpProgressEvent {
  type?: string;
  responseId?: string;
  sessionId?: string;
  event: Record<string, unknown>;
}

export interface UhpSubmitResult {
  externalId: string;
  status?: UhpTerminalStatus;
  result?: unknown;
  sessionId?: string;
  responseId?: string;
  outputText?: string;
  actualModel?: string;
  requestedModel?: string;
  modelFallback?: boolean;
  selectedHarnessId?: string;
  boundsApplied?: boolean;
  ignoredFields?: string[];
  usage?: UhpUsage | null;
  runtimeMs?: number;
  response?: UhpResponse;
}

export interface UhpUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; requestCount?: number }

export interface UhpAdapter {
  submit(input: UhpSubmitInput): Promise<UhpSubmitResult>;
  cancel(input: { submissionId: string; externalId?: string; idempotencyKey: string }): Promise<{ status: string }>;
}

/** UHP sessions are created implicitly; an empty reference starts a new one. */
export interface UhpSessionContext { previousResponseId?: string }

export interface UhpClientOptions {
  baseUrl: string;
  token?: string;
  harnessId?: string;
  model?: string;
  timeoutMs?: number;
  streamInactivityTimeoutMs?: number;
  maxStreamBytes?: number;
  discoveryTtlMs?: number;
  fetch?: typeof fetch;
}

export interface UhpDiscovery {
  version: string;
  defaultVersion: string;
  implementation?: unknown;
  capabilities: Record<string, boolean>;
  harnesses: UhpHarness[];
  models: UhpModel[];
  harnessModels: Record<string, UhpModel[]>;
  selectedHarness?: UhpHarness;
  selectedModel?: UhpModel;
}

export interface UhpHarness { id: string; [key: string]: unknown }
export interface UhpModel { id: string; available?: boolean; [key: string]: unknown }
export interface UhpResponse {
  id: string;
  object?: string;
  status: string;
  session_id?: string;
  sessionId?: string;
  output?: Array<Record<string, unknown>>;
  output_text?: string;
  error?: unknown;
  [key: string]: unknown;
}

export class UhpError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly code?: string) {
    super(message);
    this.name = "UhpError";
  }
}

export class UhpClient implements UhpAdapter {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private discoveryPromise?: Promise<UhpDiscovery>;
  private discoveryExpiresAt = 0;
  private discoveryResponseVersion?: string;

  constructor(private readonly options: UhpClientOptions) {
    if (!options.baseUrl) throw new Error("UHP baseUrl must be configured");
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async discover(refresh = false): Promise<UhpDiscovery> {
    if (refresh) { this.discoveryPromise = undefined; this.discoveryExpiresAt = 0; }
    if (this.discoveryPromise && Date.now() < this.discoveryExpiresAt) return this.discoveryPromise;
    const pending = this.doDiscover();
    this.discoveryPromise = pending;
    try { this.discoveryExpiresAt = Date.now() + boundedInteger(this.options.discoveryTtlMs ?? 30_000, 1_000, 300_000, "UHP discoveryTtlMs"); }
    catch (error) { this.discoveryPromise = undefined; throw error; }
    try {
      return await pending;
    } catch (error) { if (this.discoveryPromise === pending) { this.discoveryPromise = undefined; this.discoveryExpiresAt = 0; } throw error; }
  }

  createSessionContext(): UhpSessionContext { return {}; }

  continueSession(previousResponseId: string): UhpSessionContext {
    if (!previousResponseId.trim()) throw new Error("previousResponseId is required to continue a UHP session");
    return { previousResponseId };
  }

  rotateSession(): UhpSessionContext { return this.createSessionContext(); }

  private async doDiscover(): Promise<UhpDiscovery> {
    const info = await this.requestJson("GET", "v1/uhp", undefined, false);
    if (info.protocol !== "uhp") throw new UhpError("UHP discovery response did not identify protocol='uhp'");
    if (!Array.isArray(info.versions) || !info.versions.every((version) => typeof version === "string") || !info.versions.includes(UHP_VERSION)) {
      throw new UhpError(`UHP server does not advertise supported protocol version '${UHP_VERSION}'`);
    }
    const defaultVersion = stringAt(info, ["default_version"]);
    if (!defaultVersion || !info.versions.includes(defaultVersion)) throw new UhpError("UHP discovery response default_version was not in versions");
    if (this.discoveryResponseVersion !== defaultVersion) throw new UhpError(`UHP discovery header version '${this.discoveryResponseVersion ?? "missing"}' did not match default_version '${defaultVersion}'`);
    const version = UHP_VERSION;
    const capabilities = { idempotency: false, streaming: false, cancellation: false, sessions: false, ...Object.fromEntries(Object.entries(info.capabilities && typeof info.capabilities === "object" ? info.capabilities : {}).map(([key, value]) => [key, value === true])) };
    const harnessPayload = await this.requestJson("GET", "v1/harnesses", undefined, true, UHP_VERSION);
    const harnesses = requiredObjectList(harnessPayload, "harnesses", "UHP harness discovery").filter((item): item is UhpHarness => typeof item.id === "string");
    const harnessModels: Record<string, UhpModel[]> = {};
    for (const harness of harnesses) {
      const modelsPayload = await this.requestJson("GET", `v1/harnesses/${encodeURIComponent(harness.id)}/models`, undefined, true, UHP_VERSION);
      harnessModels[harness.id] = requiredObjectList(modelsPayload, "models", `UHP models for '${harness.id}'`).filter((item): item is UhpModel => typeof item.id === "string");
    }
    const models = Object.entries(harnessModels).flatMap(([harnessId, items]) => items.map((model) => ({ ...model, harnessId })));
    const selectedHarness = this.options.harnessId ? harnesses.find((h) => h.id === this.options.harnessId) : undefined;
    if (this.options.harnessId && !selectedHarness) throw new UhpError(`Configured UHP harness '${this.options.harnessId}' is unavailable`);
    const selectedModel = selectedHarness && this.options.model ? harnessModels[selectedHarness.id]?.find((m) => m.id === this.options.model && m.available !== false) : undefined;
    if (this.options.model && selectedHarness && !selectedModel) throw new UhpError(`Configured UHP model '${this.options.model}' is unavailable for harness '${selectedHarness.id}'`);
    return { version, defaultVersion, capabilities, harnesses, models, harnessModels, ...(info.implementation !== undefined ? { implementation: info.implementation } : {}), ...(selectedHarness ? { selectedHarness } : {}), ...(selectedModel ? { selectedModel } : {}) };
  }

  async submit(input: UhpSubmitInput): Promise<UhpSubmitResult> {
    const discovery = await this.discover();
    if (discovery.capabilities.idempotency !== true) throw new UhpError("UHP server does not advertise idempotency; refusing a non-idempotent task submission");
    if (discovery.capabilities.streaming !== true) throw new UhpError("UHP server does not advertise streaming; refusing a task submission that requires progress and live cancellation");
    if (!input.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
    const configHarness = input.config.harnessId ?? this.options.harnessId;
    const configModel = input.config.model ?? this.options.model;
    const harnessId = typeof configHarness === "string" ? configHarness : undefined;
    const modelId = typeof configModel === "string" ? configModel : undefined;
    const harness = harnessId ? discovery.harnesses.find((candidate) => candidate.id === harnessId) : undefined;
    if (!harness) throw new UhpError(harnessId ? `Configured UHP harness '${harnessId}' is unavailable` : "UHP harness must be explicitly configured for this submission");
    const model = modelId ? discovery.harnessModels[harness.id]?.find((candidate) => candidate.id === modelId && candidate.available !== false) : undefined;
    if (!model) throw new UhpError(modelId ? `Configured UHP model '${modelId}' is unavailable for harness '${harness.id}'` : "UHP model must be explicitly configured for this submission");

    const timeoutSeconds = boundedInteger(configNumber(input.config.timeoutSeconds, harness.timeoutSeconds, 300), 1, 600, "UHP timeoutSeconds");
    const timeoutMs = boundedInteger(this.options.timeoutMs ?? 10_000, 1_000, 120_000, "UHP request timeoutMs");
    const maxStep = optionalBounded(input.config.maxStep, harness.maxStep, 1000, "maxStep") ?? 100;
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(new Error("UHP request inactivity timeout")), timeoutMs);
    try {
      const previousResponseId = input.config.previousResponseId;
      if (previousResponseId !== undefined && (typeof previousResponseId !== "string" || !previousResponseId.trim())) throw new Error("config.previousResponseId must be a non-empty response id when provided");
      if (typeof previousResponseId === "string" && discovery.capabilities.sessions !== true) throw new UhpError("UHP server does not advertise sessions; refusing response continuation");
      const response = await this.fetchImpl(this.url("v1/responses"), {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json", Accept: "text/event-stream", "Idempotency-Key": input.idempotencyKey, "UHP-Version": discovery.version }),
        body: JSON.stringify({
          input: input.prompt,
          model: model.id,
          metadata: { harness_id: harness.id, foreman_submission_id: input.submissionId, foreman_assignment_id: input.assignmentId, foreman_run_id: input.runId, foreman_role_id: input.roleId, foreman_task_id: input.taskId, foreman_project_id: input.projectId },
          stream: true,
          store: true,
          timeout_seconds: timeoutSeconds,
          max_step: maxStep,
          ...(optionalBounded(input.config.maxOutputTokens, undefined, 32_768, "maxOutputTokens") !== undefined ? { max_output_tokens: optionalBounded(input.config.maxOutputTokens, undefined, 32_768, "maxOutputTokens") } : {}),
          ...(typeof previousResponseId === "string" ? { previous_response_id: previousResponseId } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) throw await this.httpError(response);
      const negotiated = response.headers.get("UHP-Version");
      if (negotiated !== UHP_VERSION) throw new UhpError(`UHP version changed or was missing during task submission (${UHP_VERSION} -> ${negotiated ?? "missing"})`);
      const contentType = response.headers.get("content-type") ?? "";
      let final: UhpResponse;
      if (contentType.includes("text/event-stream")) final = await this.readSse(response, controller, input.onEvent);
      else final = await this.parseResponse(response);
      const status = mapStatus(final.status);
      if (!status) throw new UhpError(`UHP returned unsupported terminal status '${final.status}'`);
      if (!final.id) throw new UhpError("UHP terminal response did not include a response id");
      const responseObject = status === "completed" ? final : await this.retrieve(final.id);
      const actualModel = typeof responseObject.model === "string" ? responseObject.model : undefined;
      const responseMetadata = responseObject.metadata && typeof responseObject.metadata === "object" ? responseObject.metadata as Record<string, unknown> : {};
      const modelFallback = responseMetadata.model_fallback === true || (typeof responseMetadata.requested_model === "string" && actualModel !== responseMetadata.requested_model);
      if (!actualModel) throw new UhpError("UHP response did not report the actual model");
      if (actualModel && actualModel !== model.id && !modelFallback) throw new UhpError(`UHP ran model '${actualModel}' although '${model.id}' was requested`);
      if (modelFallback && responseMetadata.requested_model !== model.id) throw new UhpError(`UHP reported a model substitution inconsistent with request '${model.id}'`);
      if (modelFallback && actualModel === model.id) throw new UhpError("UHP marked the requested model as substituted but returned that same model");
      const actualHarnessId = responseMetadata.harness_id;
      if (typeof actualHarnessId !== "string") throw new UhpError("UHP response did not report the selected harness");
      if (actualHarnessId !== harness.id) throw new UhpError(`UHP ran harness '${actualHarnessId}' although '${harness.id}' was requested`);
      const sessionId = getSessionId(final) ?? getSessionId(responseObject);
      if (!sessionId) throw new UhpError("UHP response did not report its session id");
      const ignoredFields = Array.isArray(responseMetadata.ignored_fields) ? responseMetadata.ignored_fields.filter((field): field is string => typeof field === "string") : [];
      return {
        externalId: final.id,
        responseId: final.id,
        sessionId,
        status,
        outputText: extractOutputText(responseObject),
        ...(actualModel ? { actualModel } : {}), requestedModel: model.id, modelFallback,
        selectedHarnessId: actualHarnessId,
        boundsApplied: !ignoredFields.includes("timeout_seconds") && !ignoredFields.includes("max_step"),
        ignoredFields,
        ...(Object.hasOwn(responseObject, "usage") ? { usage: normalizeUsage(responseObject.usage) } : {}),
        runtimeMs: Date.now() - startedAt,
        result: status === "completed" ? responseObject : responseObject.error ?? responseObject,
        response: responseObject,
      };
    } catch (error) {
      if (controller.signal.aborted) throw new UhpError("UHP request exceeded its inactivity timeout");
      throw error;
    } finally { clearTimeout(timer); }
  }

  async cancel(input: { submissionId: string; externalId?: string; idempotencyKey: string }): Promise<{ status: string }> {
    if (!input.externalId) throw new UhpError("Cannot cancel UHP task before its response id has been persisted");
    const discovery = await this.discover();
    if (discovery.capabilities.cancellation !== true) throw new UhpError("UHP server does not advertise cancellation");
    const response = await this.fetchImpl(this.url(`v1/responses/${encodeURIComponent(input.externalId)}/cancel`), {
      method: "POST",
      headers: this.headers({ "Idempotency-Key": input.idempotencyKey, "UHP-Version": UHP_VERSION }),
      body: "{}",
      signal: AbortSignal.timeout(this.timeoutMs()),
    });
    if (!response.ok) throw await this.httpError(response);
    if (response.headers.get("UHP-Version") !== UHP_VERSION) throw new UhpError("UHP cancellation response did not use the requested protocol version");
    const body = await response.json() as Record<string, unknown>;
    return { status: typeof body.status === "string" ? body.status : "cancelled" };
  }

  async retrieve(responseId: string): Promise<UhpResponse> {
    await this.discover();
    const response = await this.fetchImpl(this.url(`v1/responses/${encodeURIComponent(responseId)}`), { headers: this.headers({ "UHP-Version": UHP_VERSION }), signal: AbortSignal.timeout(this.timeoutMs()) });
    if (!response.ok) throw await this.httpError(response);
    if (response.headers.get("UHP-Version") !== UHP_VERSION) throw new UhpError("UHP retrieval response did not use the requested protocol version");
    return this.parseResponse(response);
  }

  private async readSse(response: Response, controller: AbortController, onEvent?: UhpSubmitInput["onEvent"]): Promise<UhpResponse> {
    if (!response.body) throw new UhpError("UHP stream had no response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const limit = this.options.maxStreamBytes ?? 4 * 1024 * 1024;
    const idleTimeoutMs = boundedInteger(this.options.streamInactivityTimeoutMs ?? 45_000, 1_000, 300_000, "UHP streamInactivityTimeoutMs");
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let byteCount = 0;
    let buffer = "";
    let dataLines: string[] = [];
    let final: UhpResponse | undefined;
    let terminalSeen = false;
    let lastSequence: number | undefined;
    const acceptBlock = async () => {
      if (!dataLines.length) return;
      const raw = dataLines.join("\n"); dataLines = [];
      if (raw === "[DONE]") return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(raw) as Record<string, unknown>; } catch { throw new UhpError("Malformed JSON in UHP SSE stream"); }
      const type = event.type;
      const sequence = event.sequence_number;
      if (typeof type !== "string") throw new UhpError("UHP SSE event did not include a type");
      if (lastSequence === undefined && (sequence !== 0 || type !== "response.created")) throw new UhpError("UHP SSE first event must be response.created with sequence_number 0");
      if (!Number.isInteger(sequence)) throw new UhpError("UHP SSE event did not include an integer sequence_number");
      if (lastSequence !== undefined && sequence !== lastSequence + 1) throw new UhpError("UHP SSE sequence_number was not contiguous");
      if (terminalSeen) throw new UhpError("UHP SSE included an event after its terminal event");
      lastSequence = sequence as number;
      const eventResponse = event.response && typeof event.response === "object" ? event.response as UhpResponse : undefined;
      const responseId = eventResponse?.id ?? (typeof event.response_id === "string" ? event.response_id : undefined);
      const metadata = eventResponse?.metadata && typeof eventResponse.metadata === "object" ? eventResponse.metadata as Record<string, unknown> : undefined;
      const sessionId = getSessionId(eventResponse ?? ({} as UhpResponse)) ?? (typeof metadata?.session_id === "string" ? metadata.session_id : undefined);
      if (onEvent) await onEvent({ ...(typeof type === "string" ? { type } : {}), ...(responseId ? { responseId } : {}), ...(sessionId ? { sessionId } : {}), event });
      if (typeof type === "string" && ["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(type)) {
        terminalSeen = true;
        if (eventResponse) final = eventResponse;
        else if (typeof event.id === "string") final = event as unknown as UhpResponse;
        if (final && !final.status) final.status = type.slice("response.".length);
      }
    };
    try {
      while (true) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(new Error("UHP stream inactivity timeout")), idleTimeoutMs);
        const { value, done } = await reader.read();
        if (idleTimer) clearTimeout(idleTimer);
        if (done) break;
        byteCount += value.byteLength;
        if (byteCount > limit) throw new UhpError(`UHP event stream exceeded ${limit} bytes`);
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
          if (line === "") await acceptBlock();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
      buffer += decoder.decode();
      if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
      await acceptBlock();
    } finally { if (idleTimer) clearTimeout(idleTimer); reader.releaseLock(); }
    if (!final) throw new UhpError("UHP SSE stream ended without a terminal response event");
    return final;
  }

  private async requestJson(method: string, path: string, body?: unknown, auth = true, version?: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(this.url(path), { method, headers: this.headers({ ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(version ? { "UHP-Version": version } : {}) }, auth), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs()) });
    if (!response.ok) throw await this.httpError(response);
    const negotiated = response.headers.get("UHP-Version");
    if (!negotiated) throw new UhpError("UHP response did not include the required UHP-Version header");
    if (version && negotiated !== version) throw new UhpError(`UHP version changed (${version} -> ${negotiated})`);
    if (!version) this.discoveryResponseVersion = negotiated;
    return response.json() as Promise<Record<string, unknown>>;
  }
  private async parseResponse(response: Response): Promise<UhpResponse> { return response.json() as Promise<UhpResponse>; }
  private async httpError(response: Response): Promise<UhpError> {
    const body = await response.text().catch(() => "");
    let code: string | undefined;
    try { const parsed = JSON.parse(body) as { error?: { code?: string } }; code = parsed.error?.code; } catch { /* retain only bounded server text */ }
    return new UhpError(`UHP request failed (${response.status})${code ? `: ${code}` : ""}`, response.status, code);
  }
  private headers(extra: Record<string, string> = {}, auth = true): HeadersInit { return { ...(auth && this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}), ...extra }; }
  private url(path: string): URL { return new URL(path.replace(/^\//, ""), this.baseUrl); }
  private timeoutMs(): number { return boundedInteger(this.options.timeoutMs ?? 120_000, 1_000, 600_000, "UHP timeoutMs"); }
}

function requiredObjectList(value: Record<string, unknown>, key: string, description: string): Record<string, unknown>[] {
  const list = value[key];
  if (!Array.isArray(list)) throw new UhpError(`${description} response did not include '${key}'`);
  return list.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object");
}
function stringAt(value: Record<string, unknown>, keys: string[]): string | undefined { for (const key of keys) if (typeof value[key] === "string") return value[key] as string; return undefined; }
function mapStatus(status: string): UhpTerminalStatus | undefined { return status === "completed" || status === "failed" || status === "incomplete" || status === "cancelled" ? status : undefined; }
function getSessionId(value: UhpResponse): string | undefined {
  if (typeof value.session_id === "string") return value.session_id;
  if (typeof value.sessionId === "string") return value.sessionId;
  const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : undefined;
  return typeof metadata?.session_id === "string" ? metadata.session_id : undefined;
}
function extractOutputText(response: UhpResponse): string {
  if (typeof response.output_text === "string") return response.output_text;
  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    const content = item.content;
    if (Array.isArray(content)) for (const part of content) if (part && typeof part === "object" && (part as Record<string, unknown>).type === "output_text" && typeof (part as Record<string, unknown>).text === "string") chunks.push((part as Record<string, unknown>).text as string);
  }
  return chunks.join("");
}
function normalizeUsage(value: unknown): UhpUsage | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new UhpError("UHP response usage was not an object or null");
  const usage = value as Record<string, unknown>;
  const details = usage.input_tokens_details && typeof usage.input_tokens_details === "object" ? usage.input_tokens_details as Record<string, unknown> : {};
  return {
    ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
    ...(typeof details.cached_tokens === "number" ? { cachedInputTokens: details.cached_tokens } : typeof usage.cached_input_tokens === "number" ? { cachedInputTokens: usage.cached_input_tokens } : {}),
    ...(typeof usage.request_count === "number" ? { requestCount: usage.request_count } : typeof usage.requests === "number" ? { requestCount: usage.requests } : {}),
  };
}
function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function configNumber(configValue: unknown, harnessValue: unknown, defaultValue: number): number {
  const value = configValue ?? harnessValue ?? defaultValue;
  if (typeof value !== "number") throw new Error("UHP timeoutSeconds must be numeric");
  return value;
}
function optionalBounded(configValue: unknown, harnessValue: unknown, max: number, name: string): number | undefined {
  const value = configValue ?? harnessValue;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number") throw new Error(`UHP ${name} must be numeric`);
  return boundedInteger(value, 1, max, `UHP ${name}`);
}
