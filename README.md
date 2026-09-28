# Foreman

Foreman is a local, web-first engineering control plane for one operator. You describe work to a Planner, the Planner proposes tasks, an Orchestrator coordinates a bounded Worker and an independent Reviewer, and Foreman gates every result with scope verification, validation checks, and a human decision before anything touches Git. External CLIs (Claude Code, Codex CLI, Antigravity) do the agent work through the Unified Harness Protocol. Hindsight supplies advisory project memory.

## How a run flows

```
Human ↔ Planner  →  Orchestrator  →  Worker  →  checks  →  Reviewer  →  your decision  →  promote  →  GitHub
```

1. **Planner.** You talk to the Planner about the work. The Planner can read a read-only snapshot of the repository at the current HEAD (Claude Code or Codex) or receive a deterministic digest (Antigravity CLI or snapshot unavailable). It proposes structured tasks with scope and validation criteria.
2. **Orchestrator.** When you start a run, the Orchestrator receives the Planner's task and guidance. It returns a JSON object `{"workerTask":"...","targetFiles":["path",...]}` naming the exact files the Worker must touch. Scope is checked against `targetFiles`; the post-run snapshot diff is the authority.
3. **Worker.** The Worker edits an isolated workspace seeded from the pinned Git base. Foreman fetches the complete snapshot, byte-compares it against the pinned commit, enforces allowed scope, and computes the exact diff.
4. **Checks.** Foreman runs every configured validation command in a disposable workspace. An empty result (no file changes) fails the result gate even if commands pass.
5. **Reviewer.** The Reviewer reads the verified diff and check results in read-only mode. Its recommendation is advisory; it cannot modify the result. A `request_changes` or `reject` verdict triggers a bounded Orchestrator → Worker → Reviewer correction while budget remains.
6. **Your decision.** The "Ready for your review" panel shows a checklist, the checks pipeline (local Foreman checks and remote GitHub CI), and an Approve / Reject pair. Approval records an immutable decision bound to the evidence. It does not change Git.
7. **Promote → GitHub.** Approved results can be promoted to a local commit, pushed, opened as a PR, and merged, each as a separate confirmed action.

## Quick start

Use Node 24 and pnpm 11.

```sh
pnpm install
pnpm build
pnpm start
```

Open `http://127.0.0.1:4399` and choose **Open repository**. Pick a local Git repository and review its allowed file scope and validation checks. Foreman opens the project Planner.

The selected repository must have a committed HEAD. Uncommitted source changes are visible but runs start from the pinned commit. The folder browser shows folders on the server machine; if Foreman runs remotely, the paths are on that machine.

No `.env` file or separate bridge command is needed for the standard local flow. Foreman starts its own per-project bridge process.

For the manual bridge workflow (custom CLIs, external UHP servers, or disposable-repo testing), see [the host CLI workflow guide](docs/three-harness-workflow.md).

`pnpm dev` starts the API in watch mode; `pnpm dev:ui` starts Vite for UI development.

## Choosing models per role

Role selection follows three scopes: **Global → Project → Run**. A more specific scope overrides the less specific one. Project and run overrides store only the choices you set explicitly; unset roles inherit from the scope above. The settings panel opens on Project scope by default. A **Reset to inherited** button removes the override at the current scope.

Discovery does not overwrite a saved choice. An unavailable pair shows as stale and blocks start until you select a discovered one.

**Built-in defaults** (used for a role with no saved choice, when all three CLIs are available):

| Role | Default |
| --- | --- |
| Planner | Codex CLI / `gpt-6-sol` |
| Orchestrator | Codex CLI / `gpt-6-sol` |
| Worker | Antigravity CLI / `gemini-3.8-flash-low` |
| Reviewer | Codex CLI / `gpt-6-sol` |

Claude Code (`opus`, `sonnet`) and any discovered Codex or Antigravity model can be selected for any role. A setup that works well in practice is Claude Code `opus` for Planner and Reviewer, `sonnet` for Orchestrator, and Antigravity `gemini-3.8-flash-low` for Worker.

**AGY caveat.** Antigravity CLI is an agentic runtime. As Planner or Orchestrator it may invoke tools instead of returning a text reply, which produces an empty or soft-denied response. The UI shows a warning when AGY is selected for Planner or Orchestrator. Claude Code or Codex is recommended for those roles. AGY `manage_task` calls during a Worker turn are tolerated with a warning; the snapshot diff and `commandExecutionPolicy: "off"` remain the safety boundary.

## Checks and CI parity

When you open a repository, Foreman inspects `.github/workflows` and suggests matching `pnpm`/`npm`/`yarn` script names for your validation commands (source `ci`). Publish, release, deploy, and staging steps are excluded. A `ciChecksNotConfigured` warning in the task start preview lists GitHub CI checks that have no matching local Foreman command.

Validation commands run in a disposable copy of the Worker workspace. Every configured command must pass. Commands absent from the list are not run or inferred.

The checks pipeline in the review panel shows local Foreman results alongside remote GitHub CI status. CI failure excerpts are fetched from `GET /api/runs/:id/github/ci-failures`.

## Reviewing and approving results

When a run reaches `awaiting_approval`, the **Ready for your review** panel appears at the top of the run view. It shows:

- A checklist: files changed, scope verified, checks passed, Reviewer verdict.
- The checks pipeline with per-check details and failing test extraction.
- **Approve result** / **Reject** buttons.
- A stepper: Review → Approve → Promote → Push → PR → Merge.

**Approve result** records an immutable decision bound to the evidence digest. It does not change Git.

**Promote approved result** creates a local commit rooted at the pinned base and a result branch. Your checkout is unchanged.

If validation failed or the Reviewer requested changes, **Retry validation** reruns the configured checks against the stored snapshot. **Ask Orchestrator for a correction** (`POST /api/runs/:id/validation-correction`) resumes the controller for one more Orchestrator → Worker → Reviewer pass. The correction Worker's workspace is seeded from the pinned base and, for validation or Reviewer failures, the previous attempt's verified changes are overlaid so the Worker only needs to describe additional edits.

**Re-send same task to Worker** re-runs the Worker with the unchanged task, starting from the pinned base without overlay. Use **Ask Orchestrator for a correction** when the task itself needs to change.

## GitHub handoff

For a project whose local repository has a GitHub remote, Foreman uses the host's signed-in `gh` CLI to show the selected run's result branch and commit, linked pull request, CI checks, reviews, and merge state. The GitHub panel refreshes status without a model call. A missing remote or unavailable `gh` login appears as a recoverable status in the panel. GitHub credentials stay with the host; they are not put into a Worker workspace or shown in the interface.

The operator's handoff is explicit:

1. Inspect the verified result, validation, and Foreman Reviewer recommendation; choose **Approve result**. This approves the Foreman result only.
2. Choose **Promote approved result** to create the verified local result commit and branch.
3. In **GitHub**, confirm **Push result branch**. Wait for Foreman to report that the remote branch SHA matches the promoted result commit, then confirm **Open PR**. Foreman checks for an existing PR before creating one. If the remote SHA differs or cannot be checked, refresh status and resolve that state before opening or updating a PR.
4. Inspect the actual GitHub PR diff, reviews, and individual CI checks in Foreman. Confirm a GitHub review comment, request for changes, or approval if GitHub permits it. Foreman approval does not submit a GitHub review.
5. When GitHub requirements are met, confirm **Merge**. If branch rules require a merge queue, inspect the full diff and reviews, wait for all checks to pass, and confirm **Add to merge queue** instead. Foreman reports the queue state and does not merge immediately or submit a duplicate queue request. For direct merge, Foreman re-reads the PR head and refuses to merge if it differs from the commit reviewed in the UI. Branch protection applies; Foreman does not bypass it or enable auto-merge silently.
6. After merge, refresh the local checkout before starting a dependent task. The GitHub base branch has advanced, but the source checkout may still be behind. Use Foreman's local refresh action only on a clean checkout that can fast-forward, or update the repository yourself and then return to Foreman. Foreman does not overwrite uncommitted changes.

Push, PR creation, GitHub review, direct merge, and queue submission each require a separate UI confirmation. Planner, Orchestrator, Worker, and Reviewer messages cannot invoke those actions.

Foreman can generate a Planner-drafted PR title and body via `POST /api/runs/:id/github/pr-draft`. The draft includes a deterministic Verification section and is editable before you open the PR.

## Repository access for Planner and Orchestrator

When the workspace bridge is configured and the harness is Claude Code or Codex, Planner and Orchestrator receive a read-only snapshot of the repository in their working directory. They can use Read, Grep, and Glob to inspect code before proposing tasks or work. The snapshot is seeded via the same bridge used for Worker workspaces, with no write access granted.

If the snapshot cannot be seeded (bridge unavailable, or Antigravity CLI selected), Foreman falls back to a deterministic repository digest: the file tree at the relevant commit, a `package.json` summary, the first 60 lines of README, and rarity-weighted keyword hits from the task description. The digest is sized from the prompt budget that remains after the mandatory parts of the prompt (the instructions and your full message for the Planner; the instructions, operator note, and task title for the Orchestrator), capped at 12 KB. Foreman trims its own context to make room and truncates the file tree and other digest sections to fit. If less than about 1.5 KB remains, the digest is omitted, the prompt says so, and the `repoAccess` reason records it. The digest therefore never pushes a turn over the 15,000-byte prompt limit.

A `repoAccess` badge on each assignment shows whether the role used a live snapshot or a digest.

## Configuration

The standard local flow requires no environment variables. The following settings are available for custom setups.

| Setting | Default | Purpose |
| --- | --- | --- |
| `FOREMAN_HOST` | `127.0.0.1` | Bind address. |
| `FOREMAN_PORT` | `4399` | Bind port. |
| `FOREMAN_DATA_DIR` | `.foreman-data` | Durable state directory. |
| `UHP_BASE_URL` | — | External UHP server base URL. Without this, Foreman uses its own per-project bridge. |
| `UHP_HARNESS_ID`, `UHP_MODEL` | — | Optional explicit initial harness/model for the external UHP server. Must be set together. |
| `UHP_TOKEN` | — | Optional bearer credential for the external UHP server. |
| `HINDSIGHT_BASE_URL` | — | Hindsight API base URL. Outages show degraded memory status and do not stop workflow. |
| `HINDSIGHT_TOKEN` | — | Optional credential for Hindsight. |
| `FOREMAN_REQUEST_TIMEOUT_MS` | `120000` | Initial HTTP connection timeout (max 120,000 ms). Does not limit turn duration. |
| `FOREMAN_TASK_TIMEOUT_MS` | `180000` | Turn timeout for Reviewer and other non-Worker, non-Planner/Orchestrator roles (max 900,000 ms). |
| `FOREMAN_WORKER_TIMEOUT_MS` | `600000` | Turn timeout for Worker roles (max 900,000 ms). |
| `FOREMAN_WORKSPACE_SOURCE_REPO` | — | Local Git repository for snapshot verification. Required with the manual bridge workflow. |
| `FOREMAN_WORKSPACE_BRIDGE_URL` | — | Loopback URL for an external workspace bridge. |
| `FOREMAN_WORKSPACE_ALLOWED_SCOPE` | — | Comma-separated exact paths or directory prefixes ending in `/` allowed in Worker results. |
| `FOREMAN_VALIDATION_COMMANDS` | — | JSON array of `{"name","command","args","cwd?"}` entries run in the disposable validation workspace. |
| `FOREMAN_VALIDATION_TIMEOUT_MS` | `120000` | Per-command time limit (max 600,000 ms). |
| `FOREMAN_VALIDATION_MAX_OUTPUT_BYTES` | `1048576` | Per-command output capture bound (max 16 MiB). |

Planner and Orchestrator turn timeouts are fixed at 300 seconds and are not configurable via environment variable. The optional configuration shape is recorded in `config.schema.json`.

## Security

Foreman has no login; it relies on binding to `127.0.0.1` and on request checks that stop other web pages from driving it through your browser. Every request must carry a `Host` of `localhost`, `127.0.0.1` or `[::1]` (or the `FOREMAN_HOST` value) on `FOREMAN_PORT`, which blocks DNS rebinding. Every request other than `GET` and `HEAD` must also carry an `Origin` that matches `Host`, and a `Sec-Fetch-Site`, if sent, must be `same-origin`; otherwise it gets a 403. Scripts that call the API directly (for example with `curl`) must therefore send `-H 'Origin: http://127.0.0.1:4399'` on writes. `pnpm dev:ui` rewrites `Origin` on proxied requests to `http://127.0.0.1:4399`. GitHub write actions additionally require an explicit confirmation token. Binding to a non-loopback address with `FOREMAN_HOST` exposes an unauthenticated control plane to that network; don't.

## Data and cleanup

Foreman stores project state in `.foreman-data/`. Each project's workspace setup, bridge state, and work directories are stored under its project ID. **Deleting a project** from the UI removes its events, bridge state directory, bridge work directory, and saved workspace setup in addition to the project record itself. Promotion records a result commit but does not advance the repository checkout.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm build
```

The deterministic UHP fixture tests do not call a model provider. The test suite never makes provider calls.

## Evidence and history

Historical evidence reports and investigations are in the `docs/` and `investigations/` directories. Key documents:

- [Host CLI workflow guide](docs/three-harness-workflow.md) — manual bridge setup, live proof records.
- [Architecture](docs/architecture.md) — control flow and authority model.
- [Decisions](docs/decisions.md) — design decisions log.
- [Automatic-path smoke report](docs/automatic-path-smoke.md) and [machine-readable evidence](docs/evidence/automatic-path-smoke-20260923.json) — live run through all four roles.
- [Workspace bridge evidence](docs/workspace-bridge.md) — bridge protocol and remaining gaps.
- [AGY Worker usage follow-up](docs/agy-worker-usage-followup.md) — four verified same-task AGY runs.
- [Gemini CLI investigation](docs/gemini-cli-worker-investigation.md) — why Gemini CLI was not enabled.
