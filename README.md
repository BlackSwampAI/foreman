# Foreman v2

Foreman is a local, web-first engineering control plane for one operator. A Planner is the primary conversation surface; an Orchestrator coordinates bounded Workers and an independent Reviewer. Foreman records identities, guidance, events, checks, and approval state. External harnesses do the agent work through the Unified Harness Protocol (UHP). Hindsight supplies advisory project memory.

This repository began with a new Git root. No v1 code or Git history was migrated.

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
| `FOREMAN_REQUEST_TIMEOUT_MS`, `FOREMAN_TASK_TIMEOUT_MS` | Bounded service requests and task policy. |

The supported configuration shape is recorded in `config.schema.json`. Keep credentials in `.env`, which Git ignores. The API is bound to loopback by default; it is not a hosted account service.

## Foundation scope

The durable hierarchy is project → task → run → role → assignment → event/evidence. Projects outlive individual UHP sessions. Planner and Orchestrator have distinct session records. Session rotation starts a new UHP conversation while the project ID, accepted Git state, event history, and Hindsight bank remain stable. Guidance is ordered in the run log; the Orchestrator must acknowledge each handoff at a safe checkpoint. Conflicting active Worker work follows an explicit cancellation and revision path.

UHP metadata discovery supplies available configured harness/model pairs. A selection is rejected when that pair is unavailable; Foreman does not silently choose another model. Submission intent and an idempotency key are persisted before sending work. Retries depend on the server advertising idempotency. Actual response/session IDs, terminal status, and usage are recorded only when supplied by UHP.

The workspace bridge remains an explicit investigation. A task completing in UHP does not establish a Git changeset. Foreman can read an exact pinned Git base and compare a supplied complete result manifest with scope limits, including binary bytes and filesystem modes. HarnessRouter has not supplied a proven complete result snapshot, so the controller keeps review, validation, Git evidence, and human approval unverified. See [workspace bridge investigation](docs/workspace-bridge.md) for tested file cases, missing runtime evidence, and the next implementation step.

The [Planner dashboard](docs/screenshots/planner-dashboard.png) and [evidence and usage view](docs/screenshots/evidence-and-usage.png) show a real persisted project, task, run, and queued guidance. They intentionally show unavailable service and usage values where no harness has reported them.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm build
```

The deterministic UHP fixture tests do not call a model provider. The pinned local HarnessRouter probe and its observed protocol version are recorded in the [workspace report](docs/workspace-bridge.md). Gemini CLI had no active cached authentication. Claude Code and Codex CLI have host account logins, but the pinned router has no provider integration and does not inherit those logins. An [experimental host-side UHP bridge](docs/subscription-cli-uhp.md) completed one separately authorized Claude Code smoke task using the existing subscription login; it is not a HarnessRouter capability or a Worker-to-Git workspace bridge. The test suite never makes provider calls.
