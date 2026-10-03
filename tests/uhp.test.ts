import { afterEach, describe, expect, it } from "vitest";
import { UhpClient, UhpError } from "../src/uhp.js";
import { startUhpFixture, type UhpFixture } from "./fixtures/uhp-server.js";

const fixtures: UhpFixture[] = [];
async function fixture(options: Parameters<typeof startUhpFixture>[0] = {}): Promise<UhpFixture> {
  const server = await startUhpFixture(options); fixtures.push(server); return server;
}

describe("shared UTF-8 handoff limits", () => {
  it("accepts a prompt exactly at the configured byte limit and rejects a multibyte prompt over it", async () => {
    const server = await fixture();
    const client = new UhpClient({ baseUrl: server.baseUrl, harnessId: "chrn_fixture", model: "model-fixture" });
    const common = { submissionId: "limit-sub", assignmentId: "limit-as", runId: "limit-run", roleId: "planner", taskId: "task", projectId: "project", config: {}, idempotencyKey: "limit-key" };
    const exact = "é".repeat(65_536); // 131,072 UTF-8 bytes, but only 65,536 JS characters.
    await client.submit({ ...common, prompt: exact });
    expect(JSON.parse(server.requests.find((request) => request.path === "/v1/responses")?.body ?? "{}").input).toBe(exact);
    await expect(client.submit({ ...common, idempotencyKey: "over-limit-key", prompt: `${exact}é` })).rejects.toThrow(/131072-byte UTF-8 limit/);
    expect(server.requests.filter((request) => request.path === "/v1/responses")).toHaveLength(1);
  });
});
afterEach(async () => { await Promise.all(fixtures.splice(0).map((server) => server.close())); });

describe("UHP adapter", () => {
  it("uses the 120 second submission timeout when neither Foreman nor the harness specifies one", async () => {
    const server = await fixture({ omitHarnessTimeout: true });
    const client = new UhpClient({ baseUrl: server.baseUrl, harnessId: "chrn_fixture", model: "model-fixture" });
    await client.submit({ submissionId: "default-timeout-sub", assignmentId: "default-timeout-as", runId: "default-timeout-run", roleId: "planner", taskId: "task", projectId: "project", prompt: "bounded task", config: {}, idempotencyKey: "default-timeout-key" });
    const posted=server.requests.find(request=>request.method==='POST'&&request.path==='/v1/responses');
    expect(JSON.parse(posted!.body).timeout_seconds).toBe(120);
  });
  it("keeps requested Codex model separate when CLI supplies no authoritative actual model", async () => {
    const server = await fixture({ codexCli: true, missingActualModel: true });
    const client = new UhpClient({ baseUrl: server.baseUrl, harnessId: "codex-cli", model: "codex-available" });
    const result = await client.submit({ submissionId: "codex-sub", assignmentId: "codex-as", runId: "codex-run", roleId: "worker", taskId: "task", projectId: "project", prompt: "Make one small change", config: {}, idempotencyKey: "codex-key" });
    expect(result).toMatchObject({ status: "completed", requestedModel: "codex-available", actualModelStatus: "unavailable", selectedHarnessId: "codex-cli", sessionId: "hsess_fixture", cliInvocation: { executable: "/opt/codex", hostExecutable: "/usr/bin/codex", args: ["exec", "--model", "codex-available"] }, usage: { inputTokens: 7, outputTokens: 3 } });
    expect(result.actualModel).toBeUndefined();
    expect(result.modelFallback).toBe(false);
  });

  it("preserves separate AGY quota groups and canonical five-hour/weekly windows", async () => {
    const body = { harnesses: [{
      harnessId: "antigravity-cli",
      status: "ready",
      windows: {
        fiveHour: { status: "available", usedPercent: 28, remainingPercent: 72, resetsAt: "2030-03-17T08:00:00.000Z" },
        weekly: { status: "available", usedPercent: 59, remainingPercent: 41, resetsAt: "2030-03-21T00:00:00.000Z" },
      },
      groups: [
        { id: "gemini", label: "Gemini", windows: {
          fiveHour: { status: "available", usedPercent: 28, remainingPercent: 72, resetsAt: "2030-03-17T08:00:00.000Z" },
          weekly: { status: "available", usedPercent: 59, remainingPercent: 41, resetsAt: "2030-03-21T00:00:00.000Z" },
        } },
        { id: "claude", label: "Claude", windows: {
          fiveHour: { status: "available", usedPercent: 10, remainingPercent: 90, resetsAt: "2030-03-17T09:00:00.000Z" },
          weekly: { status: "available", usedPercent: 40, remainingPercent: 60, resetsAt: "2030-03-22T00:00:00.000Z" },
        } },
      ],
    }] };
    const fetcher: typeof fetch = async (input) => {
      expect(new URL(String(input)).pathname).toBe("/v1/usage");
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "UHP-Version": "2026-09-12" } });
    };
    const client = new UhpClient({ baseUrl: "http://usage-fixture", fetch: fetcher });
    const usage = await client.usage();
    const expected = body.harnesses[0]!;
    expect(usage.harnesses[0]?.windows).toEqual(expected.windows);
    expect(usage.harnesses[0]?.groups).toEqual(expected.groups);
    expect(usage.harnesses[0]?.groups?.map((group) => group.id)).toEqual(["gemini", "claude"]);
  });

  it("preserves only valid quota observation timestamps", async () => {
    const observedAt = "2026-09-24T12:34:56.000Z";
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ harnesses: [{
      harnessId: "claude-code", status: "ready", windows: {
        fiveHour: { status: "available", usedPercent: 23.5, remainingPercent: 76.5, observedAt },
        weekly: { status: "available", usedPercent: 41.2, remainingPercent: 58.8, observedAt: "not-a-timestamp" },
      },
    }] }), { status: 200, headers: { "content-type": "application/json", "UHP-Version": "2026-09-12" } });
    const usage = await new UhpClient({ baseUrl: "http://usage-fixture", fetch: fetcher }).usage();
    expect(usage.harnesses[0]?.windows.fiveHour.observedAt).toBe(observedAt);
    expect(usage.harnesses[0]?.windows.weekly.observedAt).toBeUndefined();
  });

  it("accepts a bound Antigravity unavailable-model report for every role and preserves reported usage", async () => {
    const server = await fixture({ antigravityCli: true, missingActualModel: true, capabilities: { readOnlyReviewer: true } });
    const client = new UhpClient({ baseUrl: server.baseUrl, harnessId: "antigravity-cli", model: "gemini-3.8-flash-medium" });
    const evidence = { reviewDiff: "bounded diff", controllerValidation: { passed: true } };
    const results = await Promise.all((['planner','orchestrator','worker','reviewer'] as const).map((roleId) => client.submit({
      submissionId: `${roleId}-sub`, assignmentId: `${roleId}-as`, runId: 'agy-run', roleId, taskId: 'task', projectId: 'project', prompt: 'bounded task',
      config: roleId === 'reviewer' ? { reviewMode: 'read_only', reviewEvidence: evidence } : {}, idempotencyKey: `${roleId}-key`,
    })));
    for (const result of results) {
      expect(result).toMatchObject({ status: 'completed', requestedModel: 'gemini-3.8-flash-medium', actualModelStatus: 'unavailable', selectedHarnessId: 'antigravity-cli', reportedHarnessId: 'antigravity-cli', cliInvocation: { executable: '/opt/agy', hostExecutable: '/usr/bin/agy', args: expect.arrayContaining(['--model', 'gemini-3.8-flash-medium']) }, usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13, thinkingTokens: 2, cachedInputTokens: 3 } });
      expect(result.actualModel).toBeUndefined();
    }
    expect(results[3]).toMatchObject({ reviewerExecution: { mode: 'read_only', mutationAttempted: false, validation: evidence.controllerValidation } });
  });

  it("records terminal Codex CLI failure without inventing model or session evidence", async () => {
    const server = await fixture({ codexCli: true, codexFailure: true });
    const client = new UhpClient({ baseUrl: server.baseUrl, harnessId: "codex-cli", model: "codex-available" });
    const result = await client.submit({ submissionId: "codex-failed-sub", assignmentId: "codex-failed-as", runId: "codex-run", roleId: "worker", taskId: "task", projectId: "project", prompt: "Make one small change", config: {}, idempotencyKey: "codex-failed-key" });
    expect(result).toMatchObject({ status: "failed", requestedModel: "codex-available", actualModelStatus: "unavailable", selectedHarnessId: "codex-cli", responseId: "resp_fixture" });
    expect(result.actualModel).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
    expect(result.result).toEqual({ message: "Codex CLI exited before reporting a session id" });
  });

  it("preserves a failed Orchestrator response when Codex exits before creating a session", async () => {
    const server = await fixture({ codexCli: true, codexFailure: true });
    const client = new UhpClient({ baseUrl: server.baseUrl, harnessId: "codex-cli", model: "codex-available" });
    const result = await client.submit({ submissionId: "orchestrator-failed-sub", assignmentId: "orchestrator-failed-as", runId: "orchestrator-failed-run", roleId: "orchestrator", taskId: "task", projectId: "project", prompt: "Plan a correction", config: {}, idempotencyKey: "orchestrator-failed-key" });
    expect(result).toMatchObject({ status: "failed", responseId: "resp_fixture", requestedModel: "codex-available", selectedHarnessId: "codex-cli", actualModelStatus: "unavailable", cliInvocation: { executable: "/opt/codex", hostExecutable: "/usr/bin/codex" }, result: { message: "Codex CLI exited before reporting a session id" } });
    expect(result.sessionId).toBeUndefined();
  });

  it("keeps completed Orchestrator identity checks strict", async () => {
    const server = await fixture({ codexCli: true, missingActualModel: true, omitSessionId: true });
    const client = new UhpClient({ baseUrl: server.baseUrl, harnessId: "codex-cli", model: "codex-available" });
    await expect(client.submit({ submissionId: "orchestrator-completed-sub", assignmentId: "orchestrator-completed-as", runId: "orchestrator-completed-run", roleId: "orchestrator", taskId: "task", projectId: "project", prompt: "Plan a correction", config: {}, idempotencyKey: "orchestrator-completed-key" })).rejects.toThrow("UHP response did not report its session id");
  });

  it("discovers configured harness/model, submits idempotently, streams terminal response and exposes session ID", async () => {
    const server = await fixture();
    const client = new UhpClient({ baseUrl: server.baseUrl, token: "test-token", harnessId: "chrn_fixture", model: "model-fixture" });
    const discovery = await client.discover();
    expect(discovery.version).toBe("2026-09-12");
    expect(discovery.defaultVersion).toBe("2026-09-12");
    expect(discovery.capabilities.idempotency).toBe(true);
    expect(discovery.implementation).toEqual({ name: "fixture-router", version: "test" });
    expect(discovery.selectedHarness?.id).toBe("chrn_fixture");
    expect(discovery.selectedModel?.id).toBe("model-fixture");
    const seen: Array<{ type?: string; responseId?: string; sessionId?: string }> = [];
    const submitted = await client.submit({ submissionId: "sub-1", assignmentId: "as-1", runId: "run-1", roleId: "role-1", taskId: "task-1", projectId: "project-1", prompt: "Do the work", config: {}, idempotencyKey: "idem-1", onEvent: (event) => { seen.push(event); } });
    expect(submitted).toMatchObject({ externalId: "resp_fixture", responseId: "resp_fixture", sessionId: "hsess_fixture", status: "completed", outputText: "fixture result", selectedHarnessId: "chrn_fixture", actualModel: "model-fixture", requestedModel: "model-fixture", boundsApplied: true, ignoredFields: [], usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, cachedInputTokens: 2 } });
    expect(submitted.runtimeMs).toEqual(expect.any(Number));
    const post = server.requests.find((request) => request.path === "/v1/responses");
    expect(post?.headers["idempotency-key"]).toBe("idem-1");
    expect(post?.headers["uhp-version"]).toBe("2026-09-12");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({ stream: true, store: true, model: "model-fixture", timeout_seconds: 180, max_step: 40, metadata: { harness_id: "chrn_fixture", foreman_submission_id: "sub-1", foreman_project_id: "project-1" } });
    expect(seen[0]).toMatchObject({ type: "response.created", responseId: "resp_fixture", sessionId: "hsess_fixture" });
    expect(server.requests.find((request) => request.path === "/v1/uhp")?.headers.authorization).toBeUndefined();
    expect(post?.headers.authorization).toBe("Bearer test-token");
  });

  it("maps non-success terminal states distinctly and retrieves the stored response", async () => {
    const server = await fixture({ terminalStatus: "incomplete" });
    const client = new UhpClient({ baseUrl: server.baseUrl, token: "token", harnessId: "chrn_fixture", model: "model-fixture" });
    const result = await client.submit({ submissionId: "s", assignmentId: "a", runId: "r", roleId: "role", taskId: "t", projectId: "p", prompt: "work", config: {}, idempotencyKey: "key" });
    expect(result.status).toBe("incomplete");
    expect(result.outputText).toBe("retrieved result");
    expect(server.requests.some((request) => request.path === "/v1/responses/resp_fixture" && request.method === "GET")).toBe(true);
  });

  it("requires the read-only Reviewer capability and persists the bounded evidence mode", async () => {
    const unsupported = await fixture();
    const unsupportedClient = new UhpClient({ baseUrl: unsupported.baseUrl, harnessId: "chrn_fixture", model: "model-fixture" });
    await expect(unsupportedClient.submit({ submissionId: "s", assignmentId: "a", runId: "r", roleId: "reviewer", taskId: "t", projectId: "p", prompt: "Review", config: { reviewMode: "read_only", reviewEvidence: { reviewDiff: "diff" } }, idempotencyKey: "key" })).rejects.toThrow("read-only Reviewer capability");
    expect(unsupported.executionCount).toBe(0);

    const evidence = { validation: "verified_by_foreman_git_comparison", scopeVerified: true, baseCommit: "a".repeat(40), allowedScope: ["README.md"], workerResponseId: "resp_worker", reviewDiff: "bounded diff", controllerValidation: { passed: true, observations: [{ name: "check", passed: true }] }, reviewContextDigest: "e".repeat(64) };
    const server = await fixture({ capabilities: { readOnlyReviewer: true } });
    const client = new UhpClient({ baseUrl: server.baseUrl, harnessId: "chrn_fixture", model: "model-fixture" });
    const result = await client.submit({ submissionId: "s", assignmentId: "a", runId: "r", roleId: "reviewer", taskId: "t", projectId: "p", prompt: "Read-only review", config: { reviewMode: "read_only", reviewEvidence: evidence }, idempotencyKey: "key" });
    expect(result).toMatchObject({ status: "completed", actualModel: "model-fixture", responseId: "resp_fixture", sessionId: "hsess_fixture", reviewerExecution: { mode: "read_only", mutationAttempted: false, validation: evidence.controllerValidation, contextDigest:evidence.reviewContextDigest } });
    expect(JSON.parse(server.requests.find((request) => request.path === "/v1/responses")?.body ?? "{}")).toMatchObject({ input: "Read-only review", metadata: { foreman_role_id: "reviewer", foreman_review_mode: "read_only", review_evidence: evidence } });
  });

  it("replays a duplicate idempotency key without executing the task again", async () => {
    const server = await fixture({ uniqueResponseIds: true });
    const client = new UhpClient({ baseUrl: server.baseUrl, harnessId: "chrn_fixture", model: "model-fixture" });
    const input = { submissionId: "sub-retry", assignmentId: "assignment-retry", runId: "run", roleId: "worker", taskId: "task", projectId: "project", prompt: "work", config: {}, idempotencyKey: "stable-submit-key" };
    const first = await client.submit(input);
    const replay = await client.submit({ ...input, submissionId: "sub-retry-after-restart" });
    expect(first.responseId).toBe("resp_assignment-retry");
    expect(replay.responseId).toBe(first.responseId);
    expect(replay.sessionId).toBe(first.sessionId);
    expect(server.executionCount).toBe(1);
    expect(server.requests.filter((request) => request.method === "POST" && request.path === "/v1/responses")).toHaveLength(2);
  });

  it("supports cancellation only when a persisted response ID is supplied", async () => {
    const server = await fixture();
    const client = new UhpClient({ baseUrl: server.baseUrl, token: "token", harnessId: "chrn_fixture", model: "model-fixture" });
    await expect(client.cancel({ submissionId: "s", idempotencyKey: "cancel-key" })).rejects.toThrow("before its response id has been persisted");
    await expect(client.cancel({ submissionId: "s", externalId: "resp_fixture", idempotencyKey: "cancel-key" })).resolves.toEqual({ status: "cancelled" });
    expect(server.requests.at(-1)?.headers["idempotency-key"]).toBe("cancel-key");
  });

  it("persists the created response ID before terminal completion and cancels the live stream", async () => {
    const server = await fixture({ holdUntilCancel: true, holdRole: "worker", uniqueResponseIds: true });
    const client = new UhpClient({ baseUrl: server.baseUrl, token: "token", harnessId: "chrn_fixture", model: "model-fixture" });
    let resolveCreated!: (event: { responseId?: string; sessionId?: string }) => void;
    const created = new Promise<{ responseId?: string; sessionId?: string }>((resolve) => { resolveCreated = resolve; });
    const running = client.submit({ submissionId: "sub-live", assignmentId: "assignment-live", runId: "run", roleId: "worker", taskId: "task", projectId: "project", prompt: "work", config: {}, idempotencyKey: "submit-key", onEvent: (event) => { if (event.type === "response.created") resolveCreated(event); } });
    const early = await created;
    expect(early).toMatchObject({ responseId: "resp_assignment-live", sessionId: "hsess_assignment-live" });
    await expect(client.submit({ submissionId: "sub-planner", assignmentId: "assignment-planner", runId: "run", roleId: "planner", taskId: "task", projectId: "project", prompt: "work", config: {}, idempotencyKey: "planner-key" })).resolves.toMatchObject({ status: "completed" });
    const inProgress = await client.retrieve(early.responseId!);
    expect(inProgress.status).toBe("in_progress");
    const cancelled = await client.cancel({ submissionId: "sub-live", externalId: early.responseId, idempotencyKey: "cancel-key" });
    expect(cancelled.status).toBe("cancelled");
    await expect(running).resolves.toMatchObject({ externalId: early.responseId, sessionId: early.sessionId, status: "cancelled" });
  });

  it("refuses servers without idempotency or configured model substitutions", async () => {
    const noIdempotency = await fixture({ capabilityIdempotency: false });
    const client = new UhpClient({ baseUrl: noIdempotency.baseUrl, token: "token", harnessId: "chrn_fixture", model: "model-fixture" });
    await expect(client.submit({ submissionId: "s", assignmentId: "a", runId: "r", roleId: "role", taskId: "t", projectId: "p", prompt: "work", config: {}, idempotencyKey: "key" })).rejects.toThrow(UhpError);
    const unavailable = new UhpClient({ baseUrl: noIdempotency.baseUrl, token: "token", harnessId: "chrn_fixture", model: "missing-model" });
    await expect(unavailable.discover()).rejects.toThrow("unavailable for harness");
  });

  it("requires advertised streaming, cancellation, and sessions capabilities when using each feature", async () => {
    const required = { submissionId: "s", assignmentId: "a", runId: "r", roleId: "role", taskId: "t", projectId: "p", prompt: "work", config: {}, idempotencyKey: "key" };
    const noStreaming = await fixture({ capabilities: { streaming: false } });
    const noStreamingClient = new UhpClient({ baseUrl: noStreaming.baseUrl, harnessId: "chrn_fixture", model: "model-fixture" });
    await expect(noStreamingClient.submit(required)).rejects.toThrow("does not advertise streaming");
    expect(noStreaming.executionCount).toBe(0);

    const noCancellation = await fixture({ capabilities: { cancellation: false } });
    const noCancellationClient = new UhpClient({ baseUrl: noCancellation.baseUrl, harnessId: "chrn_fixture", model: "model-fixture" });
    await expect(noCancellationClient.cancel({ submissionId: "s", externalId: "resp_fixture", idempotencyKey: "cancel" })).rejects.toThrow("does not advertise cancellation");

    const noSessions = await fixture({ omitCapabilities: ["sessions"] });
    const noSessionsClient = new UhpClient({ baseUrl: noSessions.baseUrl, harnessId: "chrn_fixture", model: "model-fixture" });
    await expect(noSessionsClient.submit({ ...required, config: { previousResponseId: "resp_prior" } })).rejects.toThrow("does not advertise sessions");
    expect((await noSessionsClient.discover()).capabilities.sessions).toBe(false);
  });

  it("requires UHP protocol/version identity and supports forced discovery refresh", async () => {
    const oldServer = await fixture({ versions: ["2026-08-11"], omitResponseHarnessId: true });
    const oldClient = new UhpClient({ baseUrl: oldServer.baseUrl, harnessId: "chrn_fixture", model: "model-fixture" });
    const oldDiscovery = await oldClient.discover();
    expect(oldDiscovery.version).toBe("2026-08-11");
    const oldResult = await oldClient.submit({ submissionId: "old-s", assignmentId: "old-a", runId: "old-r", roleId: "worker", taskId: "old-t", projectId: "old-p", prompt: "work", config: {}, idempotencyKey: "old-key" });
    expect(oldResult.selectedHarnessId).toBe("chrn_fixture");
    expect(oldServer.requests.filter((request) => request.path !== "/v1/uhp").every((request) => request.headers["uhp-version"] === "2026-08-11")).toBe(true);
    expect(oldServer.requests.find((request) => request.path === "/v1/responses")?.headers["uhp-version"]).toBe("2026-08-11");
    const unsupported = await fixture({ versions: ["2026-07-01"] });
    await expect(new UhpClient({ baseUrl: unsupported.baseUrl }).discover()).rejects.toThrow("does not advertise a supported protocol version");
    const wrongProtocol = await fixture({ protocol: "not-uhp" });
    await expect(new UhpClient({ baseUrl: wrongProtocol.baseUrl }).discover()).rejects.toThrow("protocol='uhp'");
    const current = await fixture();
    const client = new UhpClient({ baseUrl: current.baseUrl });
    await client.discover();
    await client.discover(true);
    expect(current.requests.filter((request) => request.path === "/v1/uhp")).toHaveLength(2);
  });

  it("discovers all harnesses without configured defaults and selects only the submission role config", async () => {
    const server = await fixture();
    const client = new UhpClient({ baseUrl: server.baseUrl });
    const discovery = await client.discover();
    expect(discovery.harnesses.map((harness) => harness.id)).toEqual(["chrn_fixture", "chrn_other"]);
    expect(discovery.harnessModels["chrn_fixture"]?.map((model) => model.id)).toEqual(["model-fixture", "model-offline"]);
    expect(discovery.harnessModels["chrn_other"]?.map((model) => model.id)).toEqual(["model-other"]);
    expect(discovery.selectedHarness).toBeUndefined();
    const session = client.continueSession("resp_prior");
    expect(session).toEqual({ previousResponseId: "resp_prior" });
    expect(client.rotateSession()).toEqual({});
    await client.submit({ submissionId: "s", assignmentId: "a", runId: "r", roleId: "role", taskId: "t", projectId: "p", prompt: "work", config: { harnessId: "chrn_fixture", model: "model-fixture", previousResponseId: session.previousResponseId }, idempotencyKey: "k" });
    expect(JSON.parse(server.requests.find((request) => request.path === "/v1/responses")?.body ?? "{}")).toMatchObject({ previous_response_id: "resp_prior" });
  });
});
