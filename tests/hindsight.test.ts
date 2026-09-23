import { describe, expect, it } from "vitest";
import { HindsightClient } from "../src/hindsight.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Hindsight adapter", () => {
  it("uses a stable project bank and makes bounded low-depth recall", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const client = new HindsightClient({ baseUrl: "http://hindsight.test", token: "token", recallMaxTokens: 700, fetch: async (input, init) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ url: String(input), method: init?.method ?? "GET", body });
      if (init?.method === "PUT") return jsonResponse(200, { bank_id: "created" });
      if (body?.query === "What package manager does this project use?") return jsonResponse(200, { results: [{ id: "mem-1", text: "Use pnpm" }] });
      return jsonResponse(200, { results: [] });
    } });
    const first = await client.recall("project alpha", "What package manager does this project use?");
    const second = await client.recall("project alpha", "What are the project conventions?");
    expect(first.status).toBe("ready");
    expect(first.memories).toEqual([{ id: "mem-1", text: "Use pnpm" }]);
    expect(first.bankId).toBe(second.bankId);
    expect(first.bankId).not.toContain("project alpha");
    const recall = calls.find((call) => call.url.includes("/memories/recall"));
    expect(calls[0]?.url).toContain(`/banks/${first.bankId}`);
    expect(recall?.body).toMatchObject({ budget: "low", max_tokens: 700 });
  });

  it("creates a project bank without provider work before recalling", async () => {
    const calls: string[] = [];
    const client = new HindsightClient({ baseUrl: "http://hindsight.test", fetch: async (input, init) => {
      const key = `${init?.method} ${new URL(String(input)).pathname}`; calls.push(key);
      return jsonResponse(200, calls.length === 1 ? { bank_id: "created" } : { results: [] });
    } });
    const result = await client.recall("p", "Find project conventions");
    expect(result.status).toBe("ready");
    expect(calls[0]).toContain("PUT /v1/default/banks/");
    expect(calls[1]).toContain("POST /v1/default/banks/");
    expect(calls[1]).toContain("/memories/recall");
  });

  it("accepts outcome retention asynchronously with stable document identity and bounded content", async () => {
    let posted: Record<string, unknown> | undefined;
    const client = new HindsightClient({ baseUrl: "http://hindsight.test", fetch: async (_input, init) => {
      posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(202, { async: true, operation_id: "op-1" });
    } });
    const outcome = { projectId: "p", submissionId: "sub", runId: "run", roleId: "worker", taskId: "task", outcome: "completed", summary: "diff-ready" };
    const first = await client.retainAcceptedOutcome({ ...outcome, humanApproved: true });
    const second = await client.retainAcceptedOutcome({ ...outcome, humanApproved: true });
    expect(first).toMatchObject({ status: "accepted", operationId: "op-1" });
    expect(second.bankId).toBe(first.bankId);
    expect(posted).toMatchObject({ async: true, items: [{ update_mode: "replace", tags: ["project:p", "role:worker", "task:task"] }] });
    const retained = (posted?.items as Array<{ content: string; document_id: string }>)[0];
    expect(retained?.document_id).toMatch(/^foreman-submission-[0-9a-f]{32}$/);
    expect(retained?.content).toContain("Foreman task outcome: completed");
  });

  it("returns degraded memory status without throwing when Hindsight is unavailable", async () => {
    const client = new HindsightClient({ baseUrl: "http://hindsight.test", fetch: async () => jsonResponse(503, {}) });
    const recalled = await client.recall("p", "question");
    const retained = await client.retainAcceptedOutcome({ projectId: "p", submissionId: "s", runId: "r", roleId: "worker", taskId: "t", outcome: "failed", humanApproved: true });
    expect(recalled).toMatchObject({ status: "degraded", memories: [] });
    expect(retained).toMatchObject({ status: "degraded" });
  });

  it("skips retention unless a human explicitly approved the outcome", async () => {
    let called = false;
    const client = new HindsightClient({ baseUrl: "http://hindsight.test", fetch: async () => { called = true; return jsonResponse(200, {}); } });
    const result = await client.retainAcceptedOutcome({ projectId: "p", submissionId: "s", runId: "r", roleId: "worker", taskId: "t", outcome: "completed", humanApproved: false });
    expect(result.status).toBe("skipped");
    expect(called).toBe(false);
  });
});
