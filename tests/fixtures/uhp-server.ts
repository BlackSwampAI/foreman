import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface UhpFixtureOptions {
  capabilityIdempotency?: boolean;
  capabilities?: Record<string, unknown>;
  omitCapabilities?: string[];
  terminalStatus?: "completed" | "failed" | "incomplete" | "cancelled";
  holdUntilCancel?: boolean;
  holdRole?: string;
  uniqueResponseIds?: boolean;
  protocol?: string;
  versions?: string[];
  omitResponseHarnessId?: boolean;
  codexCli?: boolean;
  antigravityCli?: boolean;
  omitHarnessTimeout?: boolean;
  missingActualModel?: boolean;
  codexFailure?: boolean;
  omitSessionId?: boolean;
}

export interface UhpFixture {
  baseUrl: string;
  server: Server;
  requests: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }>;
  readonly executionCount: number;
  close(): Promise<void>;
}

export async function startUhpFixture(options: UhpFixtureOptions = {}): Promise<UhpFixture> {
  const requests: UhpFixture["requests"] = [];
  const pending = new Map<string, ServerResponse[]>();
  const idempotency = new Map<string, { created: unknown; terminal?: unknown; terminalType?: string; response: Record<string, unknown> }>();
  const responses = new Map<string, Record<string, unknown>>();
  let executionCount = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (part: string) => { body += part; });
    req.on("end", () => {
      const path = req.url ?? "/";
      const requestVersion = typeof req.headers["uhp-version"] === "string" ? req.headers["uhp-version"] as string : (options.versions ?? ["2026-09-12", "2026-08-11"])[0] ?? "2026-09-12";
      requests.push({ method: req.method ?? "GET", path, headers: req.headers, body });
      if (path === "/v1/uhp") {
        const versions = options.versions ?? ["2026-09-12", "2026-08-11"];
        const defaultVersion = versions[0];
        res.writeHead(200, { "Content-Type": "application/json", "UHP-Version": defaultVersion ?? "2026-09-12" });
        const capabilities: Record<string, unknown> = { idempotency: options.capabilityIdempotency ?? true, streaming: true, cancellation: true, sessions: true, ...options.capabilities };
        for (const capability of options.omitCapabilities ?? []) delete capabilities[capability];
        res.end(JSON.stringify({ object: "uhp.discovery", protocol: options.protocol ?? "uhp", versions, default_version: defaultVersion, conformance_class: "core", capabilities, implementation: { name: "fixture-router", version: "test" } }));
      } else if (path === "/v1/harnesses") {
        json(res, 200, { harnesses: [{ id: options.codexCli ? "codex-cli" : options.antigravityCli ? "antigravity-cli" : "chrn_fixture", base: "codex", maxStep: 40, ...(options.omitHarnessTimeout ? {} : {timeoutSeconds: 180}) }, { id: "chrn_other", base: "hermes" }] }, requestVersion);
      } else if (path === "/v1/harnesses/chrn_fixture/models") {
        json(res, 200, { harness_id: "chrn_fixture", models: [{ id: "model-fixture", available: true }, { id: "model-offline", available: false }] }, requestVersion);
      } else if (path === "/v1/harnesses/codex-cli/models") {
        json(res, 200, { harness_id: "codex-cli", models: [{ id: "codex-available", available: true }] }, requestVersion);
      } else if (path === "/v1/harnesses/antigravity-cli/models") {
        json(res, 200, { harness_id: "antigravity-cli", models: [{ id: "gemini-3.8-flash-medium", available: true }] }, requestVersion);
      } else if (path === "/v1/harnesses/chrn_other/models") {
        json(res, 200, { harness_id: "chrn_other", models: [{ id: "model-other", available: true }] }, requestVersion);
      } else if (path.startsWith("/v1/responses/") && path.endsWith("/cancel") && req.method === "POST") {
        const responseId = decodeURIComponent(path.split("/")[3] ?? "");
        const active = pending.get(responseId);
        if (active) {
          const cancelled = { id: responseId, object: "response", status: "cancelled", model: "model-fixture", metadata: { session_id: `hsess_${responseId.slice(5)}`, harness_id: "chrn_fixture" }, usage: null, output_text: "partial fixture result", output: [] };
          responses.set(responseId, cancelled);
          const terminal = { type: "response.failed", sequence_number: 1, response: cancelled };
          const ledgerEntry = [...idempotency.values()].find((entry) => entry.response.id === responseId);
          if (ledgerEntry) { ledgerEntry.response = cancelled; ledgerEntry.terminal = terminal; ledgerEntry.terminalType = "response.failed"; }
          for (const stream of active) {
            stream.write(`event: response.failed\ndata: ${JSON.stringify(terminal)}\n\n`);
            stream.end();
          }
          pending.delete(responseId);
        }
        json(res, 200, { status: "cancelled" });
      } else if (path === "/v1/responses" && req.method === "POST") {
        const keyHeader = req.headers["idempotency-key"];
        const key = typeof keyHeader === "string" ? keyHeader : "";
        const existing = key ? idempotency.get(key) : undefined;
        if (existing) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "UHP-Version": requestVersion });
          res.write(`event: response.created\ndata: ${JSON.stringify(existing.created)}\n\n`);
          if (existing.terminal) res.end(`event: ${existing.terminalType}\ndata: ${JSON.stringify(existing.terminal)}\n\n`);
          else {
            const streams = pending.get(String(existing.response.id)) ?? [];
            streams.push(res);
            pending.set(String(existing.response.id), streams);
          }
          return;
        }
        executionCount++;
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "UHP-Version": requestVersion });
        const request = JSON.parse(body || "{}") as { metadata?: Record<string, any> };
        const suffix = options.uniqueResponseIds ? String(request.metadata?.foreman_assignment_id ?? request.metadata?.foreman_role_id ?? "fixture").replace(/[^a-zA-Z0-9_-]/g, "_") : "fixture";
        const responseId = `resp_${suffix}`;
        const sessionId = `hsess_${suffix}`;
        const metadata = request.metadata ?? {};
        const shouldHold = options.holdUntilCancel === true && (!options.holdRole || metadata.foreman_role_id === options.holdRole);
        const status = shouldHold ? "in_progress" : options.codexFailure ? "failed" : options.terminalStatus ?? "completed";
        const responseMetadata = { ...(!options.codexFailure && !options.omitSessionId ? { session_id: sessionId } : {}), ...(options.omitResponseHarnessId ? {} : { harness_id: options.codexCli ? "codex-cli" : options.antigravityCli ? "antigravity-cli" : "chrn_fixture" }), ...(options.codexCli || options.antigravityCli ? { actual_model_status: options.missingActualModel || options.codexFailure ? "unavailable" : "observed", cli_invocation: { executable: options.antigravityCli ? "/opt/agy" : "/opt/codex", host_executable: options.antigravityCli ? "/usr/bin/agy" : "/usr/bin/codex", args: options.antigravityCli ? ["-p", "prompt", "--output-format", "stream-json", "--model", "gemini-3.8-flash-medium"] : ["exec", "--model", "codex-available"] } } : {}), ...(metadata.foreman_review_mode === 'read_only' ? { foreman_review_mode: 'read_only', reviewer_mutation_attempted: false, reviewer_validation: metadata.review_evidence?.controllerValidation, ...(typeof metadata.review_evidence?.reviewContextDigest === 'string' ? { reviewer_context_digest: metadata.review_evidence.reviewContextDigest } : {}) } : {}) };
        const response = { id: responseId, object: "response", status, ...(options.codexFailure ? { error: { message: "Codex CLI exited before reporting a session id" } } : {}), ...(!options.missingActualModel && !options.codexFailure ? { model: options.codexCli ? "codex-actual" : options.antigravityCli ? "gemini-3.8-flash-medium" : "model-fixture" } : {}), ...(options.codexCli ? { requested_model: "codex-available" } : options.antigravityCli ? { requested_model: "gemini-3.8-flash-medium" } : {}), metadata: responseMetadata, usage: options.antigravityCli ? { input_tokens: 8, output_tokens: 5, total_tokens: 13, thinking_tokens: 2, cache_read_tokens: 3 } : { input_tokens: 7, output_tokens: 3, total_tokens: 10, input_tokens_details: { cached_tokens: 2 } }, output_text: "fixture result", output: [{ type: "message", content: [{ type: "output_text", text: "fixture result" }] }] };
        const created = { type: "response.created", sequence_number: 0, response: { id: responseId, status: "in_progress", metadata: options.omitSessionId ? {} : { session_id: sessionId } } };
        const terminalType = status === "cancelled" ? "response.failed" : `response.${status}`;
        const terminal = { type: terminalType, sequence_number: 1, response };
        responses.set(responseId, response);
        if (key) idempotency.set(key, { created, terminal: shouldHold ? undefined : terminal, terminalType: shouldHold ? undefined : terminalType, response });
        if (shouldHold) { res.write(`event: response.created\ndata: ${JSON.stringify(created)}\n\n`); pending.set(responseId, [res]); return; }
        res.end(`event: response.created\ndata: ${JSON.stringify(created)}\n\nevent: ${terminalType}\ndata: ${JSON.stringify(terminal)}\n\n`);
      } else if (/^\/v1\/responses\/[^/]+$/.test(path) && req.method === "GET") {
        const responseId = decodeURIComponent(path.split("/")[3] ?? "resp_fixture");
        const suffix = responseId === "resp_fixture" ? "fixture" : responseId.slice(5);
        const stored = responses.get(responseId);
        json(res, 200, stored ? { ...stored, output_text: stored.status === "in_progress" ? stored.output_text : "retrieved result" } : { id: responseId, status: "completed", model: "model-fixture", metadata: { session_id: `hsess_${suffix}`, harness_id: "chrn_fixture" }, output_text: "retrieved result" }, requestVersion);
      } else json(res, 404, { error: { code: "not_found" } }, requestVersion);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind a TCP port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, server, requests, get executionCount() { return executionCount; }, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }) };
}

function json(response: ServerResponse, status: number, data: unknown, version = "2026-09-12"): void {
  response.writeHead(status, { "Content-Type": "application/json", "UHP-Version": version });
  response.end(JSON.stringify(data));
}
