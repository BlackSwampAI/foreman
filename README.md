# Foreman

Foreman is a local, web-first engineering control plane for one operator. You describe work to a Planner, the Planner proposes tasks, an Orchestrator coordinates a bounded Worker and an independent Reviewer, and Foreman gates every result with scope verification, validation checks, and a human decision before anything touches Git. External CLIs (Claude Code, Codex CLI, Antigravity) do the agent work through the Unified Harness Protocol. Hindsight supplies advisory project memory.

## How a run flows

```
Human ↔ Planner  →  Orchestrator  →  Worker  →  checks  →  Reviewer  →  your decision  →  promote  →  GitHub
```

1. **Planner.** You talk to the Planner about the work. The Planner can read a read-only snapshot of the repository at the current HEAD (Claude Code or Codex) or receive a deterministic digest (Antigravity CLI or snapshot unavailable). It proposes structured tasks with scope and validation criteria.
2. **Orchestrator.** When you start a run, the Orchestrator receives the Planner's task and guidance. It returns a JSON object `{"workerTask":"...","targetFiles":["path",...]}` naming the exact files the Worker must touch. Scope is checked against `targetFiles`; the post-run snapshot diff is the authority.
3. **Worker.** The Worker edits an isolated workspace seeded from the pinned Git base. Foreman fetches the complete snapshot, byte-compares it against the pinned commit, enforces allowed scope, and computes the exact diff.
4. **Checks.** Foreman runs every configured validation command in a disposable workspace. Expand a check to see its command, live output, duration, and result. Failed validation automatically returns to the Orchestrator for a bounded Worker correction while budget remains. Turn off **Automatic correction** to pause on failure and request a correction manually. An empty result (no file changes) fails the result gate even if commands pass.
5. **Reviewer.** The Reviewer reads the verified diff and check results in read-only mode. Its recommendation is advisory; it cannot modify the result. A `request_changes` or `reject` verdict triggers a bounded Orchestrator → Worker → Reviewer correction while budget remains.
6. **Your decision.** The "Ready for your review" panel shows a checklist, the checks pipeline (local Foreman checks and remote GitHub CI), and an Approve / Reject pair. Approval records an immutable decision bound to the evidence digest you reviewed. It does not change Git.
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

No `.env` file or separate bridge command is needed for the standard local flow. Foreman starts its own per-project bridge process, protects it with a random token, logs it, and restarts it if it crashes; see [Local bridge](#local-bridge).

For the manual bridge workflow (custom CLIs, external UHP servers, or disposable-repo testing), see [the host CLI workflow guide](docs/three-harness-workflow.md).

`pnpm dev` starts the API in watch mode; `pnpm dev:ui` starts Vite for UI development.

The header's **Light / Dark** control switches themes and remembers your choice in this browser.

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

**Checks that also fail on the base commit.** When validation fails on a Worker snapshot that has changes, Foreman runs the configured commands up to the last failed check (so installs and builds a check depends on run too) once against the unchanged pinned base commit, in the same sandbox, and caches the result on the run (pinned base + command digest). Each failed check is marked `failsOnBase` and shown with a "Fails on base" badge. If every failed check also fails there (for example `pnpm run smoke:install` with no network), a Worker retry cannot fix it, so Foreman does not spend another Worker attempt: the run stops with "Checks also fail on the base commit, so a Worker retry cannot fix them: ...". Fix the check or its network setting, then use **Retry validation** (which also discards the cached baseline). If some failures are Worker-caused, the normal automatic follow-up runs, but its correction note lists only those and names the base-failing checks as not the Worker's to fix. This never relaxes promotion: every check must still pass. If the baseline cannot run, Foreman falls back to the ordinary follow-up.

**Format step (optional).** Antigravity and Claude Code Workers can only edit files, so they cannot run the repository's formatter, and a `prettier --check` validation command would fail on their output. When a `formatCommand` is configured (`{"name","command","args","cwd?","network?"}`; the open-repository dialog suggests `<runner> run format`, `format:write` or `prettier:write` from `package.json` with an on/off toggle, `FOREMAN_FORMAT_COMMAND` sets it for the single-repository configuration), Foreman runs it after it has verified the Worker snapshot and before validation. It materializes the verified snapshot in the same bubblewrap sandbox as validation, runs the dependency installs from the validation list (`pnpm`, `npm` or `yarn` install, `ci` or `add`), then the formatter (offline unless it sets `network: true`). Only the files the Worker added, modified or renamed are read back, keeping the Worker's file mode; anything else the formatter touched or created is ignored. The new snapshot is re-verified against the pinned base and allowed scope, and validation, the Reviewer, approval and promotion all use the formatted bytes. The run's evidence records `formatting` (status `applied`, `unchanged` or `failed`, the formatted paths and the formatter's bounded output) and the UI shows "Foreman formatted N files". A formatter failure never fails the run: the Worker's snapshot is kept and validation reports the real problem. The step applies to live Worker snapshots only, not to recorded replays.

The suggested allowed scope covers the top-level tracked paths except CI configuration (`.github/`, `.gitlab-ci.yml`, `.circleci/`, `.buildkite/`, `azure-pipelines.yml`, `Jenkinsfile`, `.travis.yml`), which runs with repository secrets once pushed. Add those paths by hand if a task really has to change them.

The checks pipeline in the review panel shows local Foreman results alongside remote GitHub CI status. CI failure excerpts are fetched from `GET /api/runs/:id/github/ci-failures`.

### Validation sandbox

The Worker's files are untrusted, and validation runs them (`pnpm install` lifecycle scripts, test files). Foreman therefore runs every validation command inside a [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) sandbox by default. On Linux, install it with `apt install bubblewrap` or `dnf install bubblewrap`. If `bwrap` is missing or cannot create a sandbox, validation fails with an error and does not run on the host.

- **Hidden from the command:** your home directory (`/home`, `/root`, `$HOME`), Foreman's data directory, the source repository checkout, `/tmp`, `/var/tmp`, `/run` (Docker and D-Bus sockets, the user runtime directory), `/mnt`, `/media` and `/srv` are replaced by empty temporary directories. The rest of the host is mounted read-only.
- **Provided:** the workspace, read-write at `/tmp/workspace`; a fresh `HOME`; and an environment of only `PATH`, `LANG`, `LC_ALL`, `HOME`, `TMPDIR` and the cache variables below. The command has its own PID, IPC, UTS and network namespaces and no capabilities. A timeout or output overflow kills its whole process tree.
- **Toolchains under a hidden directory** (nvm, pnpm in `~/.local`) are mounted back read-only: `PATH` entries, the install prefix of the command and of `node` (when it is at least two levels below the home directory), and the paths in `FOREMAN_VALIDATION_SANDBOX_RO_PATHS`. Version managers that keep state beside their shims (Volta `~/.volta`, asdf `~/.asdf`, rustup `~/.rustup`, Homebrew on Linux) need their directory listed there.
- **Package-manager cache:** `<data dir>/validation-cache` (owner-only) is mounted read-write at `/tmp/foreman-cache`, with `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `npm_config_cache`, `npm_config_store_dir` and `pnpm_config_store_dir` (pnpm 10 and 11), `YARN_CACHE_FOLDER` and `COREPACK_HOME` pointing into it, so installs do not download everything each time. It is shared by every validation and project. pnpm and npm verify package integrity against the lockfile, but a command that ran hostile code could still leave bad data behind, for example a swapped pnpm binary under `XDG_DATA_HOME`. Delete the directory if you suspect that.
- **Network policy: none, except commands that explicitly need it.** Every validation command runs in an empty network namespace (`bwrap --unshare-net`). It has no interface except a working loopback, so tests that bind and connect to `127.0.0.1` inside the sandbox still work, but it cannot reach Foreman's own API, the per-project bridge or any other service on the host's loopback, the host's abstract-namespace Unix sockets, the cloud instance metadata endpoint, the local network or the internet, and DNS lookups fail. A hostile test therefore cannot drive Foreman's API for another run or fetch instance credentials. If bubblewrap cannot create the network namespace on your host (some containers refuse), the sandbox probe fails and validation reports the sandbox as unavailable; it never falls back to the host network.
- **The `network` flag.** Every validation command takes an optional boolean `network`: in `FOREMAN_VALIDATION_COMMANDS` (`{"name","command","args","cwd?","network?"}`), in a saved workspace setup, in the task-start command overrides, and as the per-command **Network** checkbox in the open-repository dialog and the task's advanced options. Only `true` keeps the host network for that command; only the JSON values `true` and `false` are accepted, anything else is rejected. Each check records what it got as `network` (with `sandbox: none` every check is recorded as `network: true`, since nothing isolates it), and the checks pipeline shows a **Network** badge on checks that ran with network access.
- **Which commands get the network by default.** The open-repository dialog starts each command from the repository inspector's suggestion: the dependency install (`pnpm install --frozen-lockfile`, `npm ci`) has `network: true`, and so do `cargo test` and `go test ./...` because they download dependencies on first run. A package script also gets `network: true` when it is a smoke script (`smoke`, `smoke:install`, `smoke:load`, ...), is named for an install (`...:install`), or its body runs a package install, `pnpm dlx` or `npx`, since it would fail offline whatever the Worker changed. Every other suggestion (`pnpm run test`, `pnpm run typecheck`, `python -m pytest`, ...) is offline; the install step puts `node_modules` in the shared validation workspace, so the checks after it need no network. A command that fetches tooling implicitly (for example pnpm downloading the version pinned in `packageManager`) fails offline and needs the checkbox.
- **Older setups and configs.** A command with no `network` field, in a saved workspace setup, in `FOREMAN_VALIDATION_COMMANDS` or in a task-start override, is treated as `network: true` if it is a recognised package-manager install and `network: false` otherwise. Recognised means the executable is exactly `pnpm`, `npm` or `yarn` with first argument `install`, `i`, `ci` or `add`, or bare `yarn` with no arguments. An explicit `network` always wins, so `{"command":"pnpm","args":["install","--offline"],"network":false}` stays offline. Runs stored before the flag existed are not rewritten (their approval is bound to a digest of the stored command list); a stored command without the field gets the same default when it runs, and the check records the effective value.
- **Residual risk, network-enabled commands.** A command with `network: true` shares the host network namespace, including the host's loopback services and the metadata endpoint. Package lifecycle scripts (`preinstall`, `postinstall`, `prepare`) run during a network-enabled install, so a hostile dependency or Worker-edited manifest gets the network for the length of that install. Grant `network` only to the install step, and consider `--ignore-scripts` if your dependencies allow it. The offline default protects every other command, including the tests.
- Run Foreman as an unprivileged user. The sandbox hides paths but cannot stop a root process from reading root-only files that remain visible, such as `/etc/shadow`.

`FOREMAN_VALIDATION_SANDBOX=none` is an explicit, unsafe opt-out for hosts without bubblewrap (for example macOS). Worker-authored code then runs directly on your machine with your credentials and the host network, and the `network` flag has no effect. Foreman prints a warning at startup, marks each check with the mode it ran in, and reports `validationSandbox: {mode, available}` from `GET /api/status`. Foreman's own tests run validation through the sandbox, so `pnpm test` needs `bwrap` as well.

## Reviewing and approving results

When a run reaches `awaiting_approval`, the **Ready for your review** panel appears at the top of the run view. It shows:

- A checklist: files changed, scope verified, checks passed, Reviewer verdict.
- The checks pipeline with per-check details and failing test extraction.
- **Approve result** / **Reject** buttons.
- A stepper: Review → Approve → Promote → Push → PR → Merge.

**Approve result** records an immutable decision bound to the evidence digest you reviewed: the panel loads the digest for the evidence it displays (`GET /api/runs/:id/decision`) and sends it with Approve or Reject. If the evidence changed after that (a validation retry, a correction cycle, another tab), Foreman refuses the decision with a message asking you to review the current result. It does not change Git.

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
| `UHP_TOKEN` | — | Optional bearer credential for the external UHP server, sent on every request to `UHP_BASE_URL` including discovery. For a manual bridge started with `LOCAL_CLI_UHP_TOKEN`, use the same value. |
| `HINDSIGHT_BASE_URL` | — | Hindsight API base URL. Outages show degraded memory status and do not stop workflow. |
| `HINDSIGHT_TOKEN` | — | Optional credential for Hindsight. |
| `FOREMAN_REQUEST_TIMEOUT_MS` | `120000` | Initial HTTP connection timeout (max 120,000 ms). Does not limit turn duration. |
| `FOREMAN_TASK_TIMEOUT_MS` | `180000` | Turn timeout for Reviewer and other non-Worker, non-Planner/Orchestrator roles (max 900,000 ms). |
| `FOREMAN_WORKER_TIMEOUT_MS` | `600000` | Turn timeout for Worker roles (max 900,000 ms). |
| `FOREMAN_WORKSPACE_SOURCE_REPO` | — | Local Git repository for snapshot verification. Required with the manual bridge workflow. |
| `FOREMAN_WORKSPACE_BRIDGE_URL` | — | Loopback URL for an external workspace bridge. |
| `FOREMAN_WORKSPACE_BRIDGE_TOKEN` | — | Optional bearer token for that bridge, for a bridge started with `LOCAL_CLI_UHP_TOKEN` (use the same value). Requires `FOREMAN_WORKSPACE_BRIDGE_URL`; printable ASCII without spaces. It is only ever sent to that loopback URL and is never logged or returned by the API. |
| `FOREMAN_WORKSPACE_ALLOWED_SCOPE` | — | Comma-separated exact paths or directory prefixes ending in `/` allowed in Worker results. |
| `FOREMAN_VALIDATION_COMMANDS` | — | JSON array of `{"name","command","args","cwd?","network?"}` entries run in the disposable validation workspace. `network` is `true` or `false`; validation runs offline unless it is `true`, and a package-manager install without the field defaults to `true`. See [Validation sandbox](#validation-sandbox). |
| `FOREMAN_FORMAT_COMMAND` | — | Optional JSON object `{"name","command","args","cwd?","network?"}`: the formatter Foreman runs on the Worker's changed files before validation. Offline unless `network` is `true`. See the format step above. |
| `FOREMAN_VALIDATION_TIMEOUT_MS` | `120000` | Per-command time limit (max 600,000 ms). |
| `FOREMAN_VALIDATION_MAX_OUTPUT_BYTES` | `1048576` | Per-command output capture bound (max 16 MiB). |
| `FOREMAN_VALIDATION_SANDBOX` | `bwrap` | `bwrap` runs every validation command in a bubblewrap sandbox and fails if it is unavailable. `none` runs them directly on the host with your credentials, and is unsafe. See [Validation sandbox](#validation-sandbox). |
| `FOREMAN_VALIDATION_SANDBOX_RO_PATHS` | — | Comma-separated absolute paths mounted read-only in the sandbox, for toolchains under a hidden directory such as `$HOME/.volta`. Paths that do not exist are ignored. |

Planner and Orchestrator turn timeouts are fixed at 300 seconds and are not configurable via environment variable. The optional configuration shape is recorded in `config.schema.json`.

## Local bridge

In the standard flow Foreman runs one bridge per project, `investigations/local-cli-uhp/server.mjs`, on a random `127.0.0.1` port. The bridge drives your signed-in Claude Code, Codex and Antigravity CLIs and holds full copies of the repository, so Foreman protects and supervises it:

- **Authentication.** Each start gets a fresh random 32-byte bearer token, passed to the bridge in its environment and sent by Foreman on every call: UHP requests, workspace seed, overlay and snapshot, and usage. The bridge answers `401` to any request without it, before doing any work (`/v1/uhp` discovery included), and `403` to any request whose `Host` is not `127.0.0.1`, `localhost` or `[::1]` on its port, so neither another local process nor a web page using DNS rebinding can read the repository or use your subscriptions. The token is never logged and never appears in events or `/api/*` responses.
- **Log.** The bridge's stdout and stderr go to `<data dir>/local-bridges/<key>/bridge.log` (mode 0600). At every (re)start, a log over 5 MB is moved to `bridge.log.1`, replacing any older one, so at most one old file is kept.
- **Restart.** If the bridge exits unexpectedly, Foreman restarts it on the same port with the same token, so URLs and credentials already handed out stay valid, after 1 s, then 2 s, 4 s and so on up to 30 s. Anything the bridge was running is marked failed by the bridge, and Foreman's normal reconciliation shows it as failed; nothing is replayed. After 5 consecutive runs that each end within 60 s of starting, including restarts that cannot bind the port, Foreman gives up. A stopped project, such as a deleted one, is never restarted.
- **Status.** `GET /api/projects/:id/workspace-setup` reports `bridgeStatus` (`ready`, `restarting` or `unavailable`) and a `bridgeHealth` object with the last exit code or signal, the restart count and the log path. `GET /api/projects/:id/usage` reports the same `bridgeStatus` while the bridge is not ready. Foreman also prints each change to its own stderr. Reopening the repository starts a fresh bridge for a project that was given up on.

For a bridge you start yourself (`UHP_BASE_URL`), see [the host CLI workflow guide](docs/three-harness-workflow.md#bridge-authentication): set `LOCAL_CLI_UHP_TOKEN` on the bridge and the same value as `UHP_TOKEN` and `FOREMAN_WORKSPACE_BRIDGE_TOKEN` for Foreman. Without a token that bridge accepts any local process and warns at startup, and Foreman does not supervise it.

## Security

Foreman has no login; it relies on binding to `127.0.0.1` and on request checks that stop other web pages from driving it through your browser. Every request must carry a `Host` of `localhost`, `127.0.0.1` or `[::1]` (or the `FOREMAN_HOST` value) on `FOREMAN_PORT`, which blocks DNS rebinding. Every request other than `GET` and `HEAD` must also carry an `Origin` that matches `Host`, and a `Sec-Fetch-Site`, if sent, must be `same-origin`; otherwise it gets a 403. Scripts that call the API directly (for example with `curl`) must therefore send `-H 'Origin: http://127.0.0.1:4399'` on writes. `pnpm dev:ui` rewrites `Origin` on proxied requests to `http://127.0.0.1:4399`. GitHub write actions additionally require an explicit confirmation token. Binding to a non-loopback address with `FOREMAN_HOST` exposes an unauthenticated control plane to that network; don't. The per-project bridge behind it has its own token and `Host` checks; see [Local bridge](#local-bridge).

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
