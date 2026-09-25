# Foreman v2

Foreman is a local, web-first engineering control plane for one operator. A Planner is the primary conversation surface; an Orchestrator coordinates bounded Workers and an independent Reviewer. Foreman records identities, guidance, events, checks, and approval state. External harnesses do the agent work through the Unified Harness Protocol (UHP). Hindsight supplies advisory project memory.

This repository began with a new Git root. No v1 code or Git history was migrated.

## Host CLI workflow

Foreman can use the host-side CLI bridge for Claude Code, Codex CLI, and
Antigravity CLI (`agy`). Each harness uses its existing host sign-in; Foreman
does not require a provider API key or copy credentials. The practical defaults
are Claude Code or Codex CLI for Planner, Orchestrator, and Reviewer, and the
explicit AGY model `gemini-3.8-flash-low` for Worker when `agy models` reports
it on the host. Claude Code offers `opus` and `sonnet`, with `opus` as its
default. Every role can select any discovered harness/model pair,
including any discovered AGY Flash model, with global, project, and run-level
choices in the UI. Gemini CLI is not enabled in this checkout because the
available host profile uses API-key auth and no supported OAuth login is
available. The [Gemini investigation](docs/gemini-cli-worker-investigation.md)
records the host-login boundary; Gemini CLI was discarded for this Worker
path. The [AGY usage follow-up](docs/agy-worker-usage-followup.md) records four
verified same-task Worker turns and an optional low-effort setting. Foreman
does not copy credentials or require a provider API key.

Follow [the host CLI workflow guide](docs/three-harness-workflow.md) to
start the local bridge and configure a validation policy. Talk with the Planner
in the UI, then start the bounded controller run: Foreman carries the Planner
guidance through Orchestrator, Worker, complete-snapshot verification,
validation, and Reviewer. Human approval and Git promotion remain separate
operator actions. The guide retains the earlier live four-role proof as a
historical manual workflow record. A separate live automatic-path run completed
one successful turn per role and stopped at human approval; see the
[automatic-path smoke report](docs/automatic-path-smoke.md) and its
[machine-readable evidence](docs/evidence/automatic-path-smoke-20260923.json).
The smoke left approval and Git promotion for the operator. Earlier live-call
IDs and usage remain in the guide's historical record.

## Run locally

Use Node 24 and pnpm 11.

```sh
pnpm install
pnpm build
pnpm start
```

Open `http://127.0.0.1:4399` and choose **Open repository**. Pick a local Git repository and review its allowed files and validation checks. Foreman opens the project Planner, where you describe the work and discuss the proposed tasks. For a task, review its goal and validation criteria, and edit them if needed. Choose **Approve task & start work** to approve that task plan and start its isolated run. Foreman uses the task’s suggested scope when available, or the repository’s allowed scope when it is empty. Configured checks and role choices are defaults. Task creation alone never starts work.

An Antigravity proposal must name an exact target file; Foreman asks Orchestrator to correct a directory-only proposal before dispatch. A verified no-change result fails validation and can trigger a bounded automatic correction attempt. A Reviewer `request_changes` or `reject` verdict can also trigger a revised Worker pass and fresh review while the run budget permits. When the run finishes, review its verified diff, validation results, and Reviewer recommendation. **Approve result** is a separate decision after that review; approving the task plan does not approve the result or promote it to Git. Advanced options are available when you need to change scope, role harnesses or models, checks, run limits, or the Git base. Each task keeps its own runs and evidence. No `.env` file or separate bridge command is needed for this local flow. The selected repository must have a committed HEAD; uncommitted source changes are shown but runs start from the commit. Foreman stores project state in `.foreman-data/` and restores selected repositories on restart.

The Planner conversation belongs to the project and keeps its full visible history. Foreman sends bounded recent and relevant context with each Planner turn; it does not make hidden summary calls. Project Planner sessions are tied to the project and selected Planner harness/model. Existing run-level Planner assignments and their replies remain attached to their original runs and are shown as historical run conversations; Foreman does not merge them into the new project conversation or claim they shared one session. Existing tasks, runs, approvals, and evidence remain intact. Projects without Planner state start a new project conversation when first used. To continue independent tasks, start each explicitly. Promotion records a result commit but does not advance the repository checkout. Before starting a task that depends on earlier work or may change overlapping paths, integrate every applicable promoted result into the repository checkout. Foreman checks that each required promoted commit is in the current repository HEAD, then pins that HEAD automatically. Use the optional Git base control in Advanced options when you need an explicit base.

The folder browser reads the server computer's filesystem. If Foreman runs on another machine, the browser shows folders on that machine. Validation commands run in Foreman's disposable copy after Worker output is verified, so review the suggested commands before opening the repository. Host CLI logins must already be configured for the harnesses you select; unavailable harnesses are not selectable. With all three CLIs available, new projects default to Codex for Planner, Orchestrator, and Reviewer and AGY Flash Low for Worker; each role can be changed in the UI.

## GitHub handoff

For a project whose local repository has a GitHub remote, Foreman uses the host's
signed-in `gh` CLI to show the selected run's result branch and commit, linked
pull request, CI checks, reviews, and merge state. The GitHub panel refreshes
status without a model call. A missing remote or unavailable `gh` login appears
as a recoverable status in the panel. GitHub credentials stay with the host;
they are not put into a Worker workspace or shown in the interface.

The operator's handoff is explicit:

1. Inspect the verified result, validation, and Foreman Reviewer recommendation; choose **Approve result**. This approves the Foreman result only.
2. Choose **Promote approved result** to create its verified local result commit and branch.
3. In **GitHub**, confirm **Push result branch**. Wait for Foreman to report that the remote branch SHA matches the promoted result commit, then confirm **Open PR**. Foreman checks for an existing PR before creating one. If the remote SHA differs or cannot be checked, refresh status and resolve that state before opening or updating a PR.
4. Inspect the actual GitHub PR diff, reviews, and individual CI checks in Foreman. Confirm a GitHub review comment, request for changes, or approval if GitHub permits it. Foreman approval does not submit a GitHub review.
5. When GitHub requirements are met, confirm **Merge**. If branch rules require a merge queue, inspect the full diff and reviews, wait for all checks to pass, and confirm **Add to merge queue** instead. Foreman reports the queue state and does not merge immediately or submit a duplicate queue request. For direct merge, Foreman re-reads the PR head and refuses to merge if it differs from the commit reviewed in the UI. Branch protection applies; Foreman does not bypass it or enable auto-merge silently.
6. After merge, refresh the local checkout before starting a dependent task. The GitHub base branch has advanced, but the source checkout may still be behind. Use Foreman's local refresh action only on a clean checkout that can fast-forward, or update the repository yourself and then return to Foreman. Foreman does not overwrite uncommitted changes.

Push, PR creation, GitHub review, direct merge, and queue submission each require a separate UI confirmation. After a queued merge completes, refresh the local checkout as in step 6 before starting dependent work. Planner, Orchestrator, Worker, and Reviewer messages cannot invoke those actions.

`pnpm dev` starts the API in watch mode and `pnpm dev:ui` starts Vite for UI development. The settings below remain available for custom or legacy setups; the normal local repository flow does not require them.

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

The optional configuration shape is recorded in `config.schema.json`. The local project flow uses existing host CLI logins; no provider key is needed in Foreman. The API is bound to loopback by default.

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

The deterministic UHP fixture tests do not call a model provider. The pinned local HarnessRouter probe and its observed protocol version are recorded in the [workspace report](docs/workspace-bridge.md). Gemini CLI has no eligible cached Google-account login on this host; its current API-key configuration was limited to a one-off comparison attempt. Claude Code and Codex CLI have host account logins, but the pinned router has no provider integration and does not inherit those logins. An [experimental host-side UHP bridge](docs/subscription-cli-uhp.md) completed one separately authorized Claude Code smoke task using the existing subscription login; it is not a HarnessRouter capability. The Codex workspace-write fixture and three-attempt live proof are described in the [Codex Worker smoke report](docs/codex-worker-smoke.md). The test suite never makes provider calls.
