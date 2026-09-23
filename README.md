# Foreman v2

Foreman is a local, web-first engineering control plane for one operator. A Planner is the primary conversation surface; an Orchestrator coordinates bounded Workers and an independent Reviewer. Foreman records identities, guidance, events, checks, and approval state. External harnesses do the agent work through the Unified Harness Protocol (UHP). Hindsight supplies advisory project memory.

This repository began with a new Git root. No v1 code or Git history was migrated.

## Three-harness workflow

Foreman can use the host-side CLI bridge for Claude Code, Codex CLI, and
Antigravity CLI (`agy`). Each harness uses its existing host sign-in; Foreman
does not require a provider API key or copy credentials. The practical defaults
are Claude Code or Codex CLI for Planner, Orchestrator, and Reviewer, and the
explicit AGY model `gemini-3.8-flash-low` for Worker when `agy models` reports
it on the host. Every role can select any discovered harness/model pair,
including any discovered AGY Flash model, with global, project, and run-level
choices in the UI.

Follow [the three-harness workflow guide](docs/three-harness-workflow.md) to
start the local bridge, configure a pinned workspace and validation policy,
and use the Planner → Orchestrator → Worker → Reviewer evidence flow. Live
proof is in progress: Planner, Orchestrator, and Worker calls succeeded;
Reviewer evidence is pending. Deterministic bridge fixtures are not live
provider evidence. The guide records current results and outstanding proof.

## Run locally

Use Node 24 and pnpm 11.

```sh
pnpm install
cp .env.example .env
pnpm build
pnpm start
```

Open `http://127.0.0.1:4399`. The service serves the built React UI, local REST API, and SSE event stream. `pnpm dev` starts the API in watch mode and `pnpm dev:ui` starts Vite for UI development. State is stored under `.foreman-data/` by default and survives service restarts. The UI begins empty; create a project, task, and run to see real persisted records.

| Setting | Purpose |
| --- | --- |
| `FOREMAN_HOST`, `FOREMAN_PORT` | Bind address and port; defaults to loopback port 4399. |
| `FOREMAN_DATA_DIR` | Local durable state directory. |
| `UHP_BASE_URL`, `UHP_TOKEN`, `UHP_HARNESS_ID`, `UHP_MODEL` | UHP server, optional bearer credential, and optional explicit initial harness/model pair. Without a reachable server, harness/model options are unavailable. |
| `HINDSIGHT_BASE_URL`, `HINDSIGHT_TOKEN` | Hindsight API and optional credential. Outages show degraded memory status and do not stop workflow state changes. |
| `FOREMAN_REQUEST_TIMEOUT_MS`, `FOREMAN_TASK_TIMEOUT_MS` | Bounded service requests and task policy. Request timeout defaults to 120 seconds for CLI role turns. |
| `FOREMAN_WORKSPACE_SOURCE_REPO` | Local Git repository used to read the pinned base and verify the complete Worker snapshot. |
| `FOREMAN_WORKSPACE_BRIDGE_URL` | Optional loopback URL for the external workspace bridge; needed to seed and fetch a live Worker workspace, not to replay recorded evidence. |
| `FOREMAN_WORKSPACE_ALLOWED_SCOPE` | Comma-separated exact paths or directory prefixes ending in `/` allowed in the Worker result. |
| `FOREMAN_VALIDATION_COMMANDS` | Non-empty JSON array of `{ "name", "command", "args", "cwd?" }` entries run by Foreman in the disposable validation workspace. |
| `FOREMAN_VALIDATION_TIMEOUT_MS`, `FOREMAN_VALIDATION_MAX_OUTPUT_BYTES` | Per-command time limit and output capture bound. Defaults are 120,000 ms and 1 MiB. |

The supported configuration shape is recorded in `config.schema.json`. Keep credentials in `.env`, which Git ignores. The API is bound to loopback by default; it is not a hosted account service.

## Foundation scope

The durable hierarchy is project → task → run → role → assignment → event/evidence. Projects outlive individual UHP sessions. Planner and Orchestrator have distinct session records. Session rotation starts a new UHP conversation while the project ID, promotion state, event history, and Hindsight bank remain stable. Guidance is ordered in the run log; the Orchestrator must acknowledge each handoff at a safe checkpoint. Conflicting active Worker work follows an explicit cancellation and revision path.

UHP metadata discovery supplies available configured harness/model pairs. A selection is rejected when that pair is unavailable; Foreman does not silently choose another model. Submission intent and an idempotency key are persisted before sending work. Retries depend on the server advertising idempotency. Actual response/session IDs, terminal status, and usage are recorded only when supplied by UHP.

The controller records the external CLI bridge's Worker response and complete snapshot, verifies it against a pinned Git base and allowed scope, computes the diff, materializes that result in a disposable validation workspace, and runs configured checks itself with bounded time and captured output. Every command in the configured validation list must pass; commands absent from the list are not run or inferred. Reviewer feedback is stored as a separate recommendation; its prose cannot change the verified diff or mark it accepted, and Foreman does not apply Reviewer changes. Human approval is an immutable decision after snapshot, scope, validation, and recommendation evidence gates pass. It does not itself change Git. A separate explicit promotion rechecks the stored evidence and creates a commit rooted at the pinned base; Foreman verifies the resulting complete tree before recording promotion as applied. The approval record’s `evidenceCommit` is the pinned input base, never the result commit. The recorded Worker and Reviewer smoke evidence captures the state before the human decision. The separate live Reviewer response (`claude-opus-5-5`, `recommend`) is documented in [actual-reviewer-smoke.json](investigations/local-cli-uhp/evidence/actual-reviewer-smoke.json). The operator subsequently approved the run in the UI; [actual-reviewer-approval.json](investigations/local-cli-uhp/evidence/actual-reviewer-approval.json) records the immutable decision and its pinned input base (`ff2e868ae0360b706c57c3ef2d21741fe5f9dd9c`). This smoke run has not been promoted and has no accepted result commit. Its approval record predates the evidence-digest binding, so the current promotion endpoint rejects it; promotion remains disabled for that legacy approval unless a new bound decision or explicit migration is provided. Deterministic replay and simulated Reviewer fixtures exercise integration paths but are not live model runs. The configured live validation policy contained one README SHA-256 check; it verified the recorded bytes but is not a broader project test suite. Codex's deterministic bridge fixtures passed 23/23 with no provider calls. Three bounded live UHP submissions invoked Codex once each: the first failed before a session or usable JSON response, the second started a session but exited with a network-category error, and the third completed a turn with actual model unavailable. On the third attempt Foreman received a complete one-entry snapshot, independently verified the README-only change within scope, and passed configured validation (exit 0). The exact appended sentence, response/session IDs, measured usage (57,325 input, 640 output, 53,888 cached input tokens), and requested `gpt-6-sol` are in the [successful Codex evidence](investigations/local-cli-uhp/evidence/actual-codex-worker-smoke-retry3.json); its actual-model field remains unavailable. Acceptance remained `not_decided`; no Reviewer, approval, or Git promotion occurred. Provider request count is unavailable. The Codex runtime uses a per-response writable ephemeral home with host `auth.json` mounted read-only and a read-only host CA bundle. These results do not establish HarnessRouter subscription-login parity or full-snapshot behavior. No HarnessRouter equivalence or Claude session continuation is claimed. The host CLI bridge remains outside Foreman core and uses the existing subscription login boundary. See [workspace bridge evidence and remaining gaps](docs/workspace-bridge.md).

The [Planner dashboard](docs/screenshots/planner-dashboard.png) and [evidence and usage view](docs/screenshots/evidence-and-usage.png) show a real persisted project, task, run, and queued guidance. They intentionally show unavailable service and usage values where no harness has reported them.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm build
```

The deterministic UHP fixture tests do not call a model provider. The pinned local HarnessRouter probe and its observed protocol version are recorded in the [workspace report](docs/workspace-bridge.md). Gemini CLI had no active cached authentication. Claude Code and Codex CLI have host account logins, but the pinned router has no provider integration and does not inherit those logins. An [experimental host-side UHP bridge](docs/subscription-cli-uhp.md) completed one separately authorized Claude Code smoke task using the existing subscription login; it is not a HarnessRouter capability. The Codex workspace-write fixture and three-attempt live proof are described in the [Codex Worker smoke report](docs/codex-worker-smoke.md). The test suite never makes provider calls.
