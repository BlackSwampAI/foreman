# Three-harness workflow

This guide describes the local workflow wired through Foreman's UI and the
experimental host-side UHP CLI bridge. The bridge invokes the installed
Claude Code, Codex CLI, and Antigravity CLI (`agy`) as the current OS user. It
uses their existing host sign-ins. Do not configure provider API keys for this
workflow, and do not copy credentials into Foreman, a task workspace, or a
bridge workspace. The bridge keeps the configured auth directories read-only
and isolates each task workspace.

## Start the bridge and Foreman

Use Node 24 and pnpm 11. Confirm the three CLIs and the Linux isolation tool are
available, and confirm that AGY's model listing on this host includes the
explicit Worker model:

```sh
claude --version
codex --version
agy models
bwrap --version
```

Use a disposable Git repository for the Worker source.
The bridge and Foreman must point at the same repository. Set the validation
policy to checks that are safe to run against a disposable copy of that repo.
For example, for a JavaScript repository with a harmless `pnpm build` check:

```sh
export FOREMAN_WORKSPACE_SOURCE_REPO="/absolute/path/to/disposable-repo"
export FOREMAN_WORKSPACE_ALLOWED_SCOPE="README.md"
export FOREMAN_VALIDATION_COMMANDS='[{"name":"build","command":"pnpm","args":["build"]}]'
```

Replace the allowed paths and validation commands with those suited to the
fixture. The four workspace settings are a unit: Foreman rejects partial
configuration. Validation commands run in a disposable validation workspace
with bounded time and output. Only configured commands run. Do not use a
valuable checkout as the task repository.

Start the bridge in one terminal from the repository root:

```sh
cd investigations/local-cli-uhp
CLAUDE_CONFIG_DIR="$HOME/.claude" \
CLAUDE_MODEL="<explicit model supported by claude>" \
CODEX_HOME="$HOME/.codex" \
CODEX_MODEL="<explicit model supported by codex>" \
AGY_CONFIG_DIR="$HOME/.gemini/antigravity-cli" \
AGY_MODEL="gemini-3.8-flash-low" \
LOCAL_CLI_UHP_SOURCE_REPO="/absolute/path/to/disposable-repo" \
LOCAL_CLI_UHP_PORT=8787 \
node server.mjs
```

Use the actual existing auth-directory locations on this host if they differ.
The bridge advertises configured harnesses with discoverable models. Model
discovery alone does not prove an active sign-in. AGY discovery calls
`agy models`; the practical Worker default is `gemini-3.8-flash-low`, which was
listed on the proof host and completed the live Worker turn. If it is absent on
another host, configure an explicitly listed Flash model instead. Any
discovered AGY Flash model can be selected per role and per run in Foreman's
UI. Do not let the bridge silently substitute a model. The bridge listens on
loopback and has no authentication; keep it local.

In another terminal, configure the same repo and validation policy for Foreman,
then build and start the UI/API service:

```sh
cd /path/to/foreman
cp .env.example .env
```

Set these entries in `.env` (retain the loopback URL and adjust paths/checks):

```dotenv
UHP_BASE_URL=http://127.0.0.1:8787
FOREMAN_WORKSPACE_SOURCE_REPO=/absolute/path/to/disposable-repo
FOREMAN_WORKSPACE_BRIDGE_URL=http://127.0.0.1:8787
FOREMAN_WORKSPACE_ALLOWED_SCOPE=README.md
FOREMAN_VALIDATION_COMMANDS=[{"name":"build","command":"pnpm","args":["build"]}]
```

Then run:

```sh
pnpm install
pnpm build
pnpm start
```

Open `http://127.0.0.1:4399`. The bridge and Foreman have separate processes
and configuration; `.env` configures Foreman, while the shell variables above
configure the bridge. Hindsight is optional and advisory.

If AGY reports that it needs sign-in, use the interactive sign-in flow offered
by the installed `agy` CLI in a terminal as the same host user, then restart
the bridge. Do not paste sign-in material into Foreman or the bridge's
configuration. If authentication is still unavailable, leave the live proof
pending and record the exact CLI prompt/command needed from the installed AGY
version before making another attempt.

## Configure roles and create a run

Wait for UHP discovery to complete. In the UI's **Roles and harnesses**
section, select a discovered harness/model pair at Global, Project, or Run
scope. Choices are discovered from the bridge; unavailable combinations are
not guessed. Any of Claude Code, Codex CLI, or `antigravity-cli` can be chosen
for Planner, Orchestrator, Worker, or Reviewer when the bridge advertises that
pair. For ordinary use, leave Planner, Orchestrator, and Reviewer on Claude or
Codex, and set Worker to `antigravity-cli / gemini-3.8-flash-low`. Other
discovered AGY Flash models remain available as role and run overrides.
Selections can be changed for each role and each run; changing the Worker
draft alone does not dispatch work.

Create a disposable project, task, and run for a proof or small change. In the
run view, enter the source repository's full Git commit SHA and click **Pin
base & prepare Worker workspace**. Foreman pins the run to that commit and
prepares an isolated Worker workspace from it. The Worker request does not
accept an arbitrary host path. The allowed scope is enforced against Foreman's
own comparison of the complete returned snapshot with the pinned base.

## Run the workflow

1. **Human ↔ Planner.** Send a message in the Planner conversation surface.
   Foreman stores it as ordered guidance and submits a Planner assignment for
   each message. The Planner and Orchestrator have separate contexts. Planner
   replies and their assignment/session metadata appear in the run. Foreman
   keeps Planner and Orchestrator session identities separate for the run.
2. **Orchestrator proposal.** In **Orchestrator plan & state**, submit a
   separate instruction. Foreman sends it with the Planner context, guidance,
   pinned base, and allowed paths. The Orchestrator must return one strict JSON
   object containing `workerTask`. Foreman stores that text as a pending
   proposal only if it is bound to a successful Orchestrator assignment.
3. **Controller dispatch.** Inspect the stored proposal and click **Dispatch
   through Foreman**. Agent prose cannot dispatch a task. The controller
   checks proposal identity, status, pin, seeded workspace, and selected
   Worker configuration before submitting the Worker assignment.
4. **AGY Flash Worker.** The Worker edits only its isolated, pinned workspace.
   After it succeeds, click **Verify Worker result**. The bridge returns a
   complete snapshot; Foreman independently compares bytes, modes and paths
   with its pinned Git base and enforces the configured allowed scope. Foreman
   computes and displays the exact diff. Incomplete snapshots or out-of-scope
   paths fail closed.
5. **Foreman validation.** Foreman materializes the verified result in a
   disposable validation workspace and runs every configured command with
   time and output bounds. The UI records commands, exit status and captured
   output. Checks supplied by an agent are not treated as validation.
   The verified result also appears in the Orchestrator inbox with its exact
   diff, Worker response ID, pinned base, scope, and validation observations.
   A separate explicit follow-up turn can deliver that receipt to the same
   Orchestrator context before review. This follow-up never dispatches work.
6. **Independent Reviewer.** After verification and passing validation, click
   **Request read-only Reviewer**. Foreman sends the exact verified diff,
   pinned base, allowed scope and controller-observed validation evidence in a
   fresh context without the Worker checkout. A Reviewer recommendation is
   advisory and cannot edit the result or approve it. The UI records response
   and session IDs, requested and observed model when available, and reported
   usage fields: input, output, cached input, thinking, total tokens, runtime,
   and request count when provided by the CLI. Missing fields stay unavailable;
   the UI does not estimate usage. If the harness cannot establish the required
   read-only and identity evidence, Foreman rejects the Reviewer result.
7. **Human decision.** Inspect the diff, validation evidence, role calls, and
   Reviewer recommendation in **Evidence and approval**. Only the human's
   explicit approval or rejection records the final decision. Approval does
   not change Git. Git promotion is a separate explicit UI action after
   approval; do not click it when the desired endpoint is an unpromoted result.

Agent text alone cannot dispatch work, satisfy Foreman's Git verification,
pass controller validation, approve changes, or change Git. The controller
owns those transitions and binds the evidence to the run's pinned base.

## Proof record

Live proof is in progress on run `run_8931540b-d039-4f2d-a92b-e1a1b3658857`,
pinned to disposable base `14eb32bf56f584043d4466b6eacb0ae39f622576`. Three
successful workflow role calls are recorded: Codex Planner, Codex Orchestrator,
and AGY Worker. Earlier diagnostic CLI turns also occurred; they are separate
from these successful role calls, and their aggregate invocation count is not
included in the successful-role count. Aggregate live CLI invocations
(including diagnostics): **pending reconciliation**. The Claude Reviewer call
is pending because of the Claude quota limit; no Reviewer call or retry is
claimed. No provider request count is available.

| Role | Harness/model | Response ID | Session/conversation ID | Observed model | Reported usage |
| --- | --- | --- | --- | --- | --- |
| Planner | Codex CLI / `gpt-6-sol` | `resp_52dbeb3d-b3a3-4c07-a123-bb3788a7f61c` | `01a0cd11-ffe9-77d2-881f-40f42bdb3d25` | Unavailable | Input 56,420; output 515; cached input 53,248; other fields unavailable |
| Orchestrator | Codex CLI / `gpt-6-sol` | `resp_b58ecd52-8530-488b-8a8a-626a48c38f41` | `01a0cd12-6994-7ce1-ab09-14212af864ec` | Unavailable | Input 14,073; output 156; cached input 11,776; other fields unavailable |
| Worker | `antigravity-cli` / `gemini-3.8-flash-low` | `resp_f837db7f-95f2-4a79-ba44-78c3cff31c4a` | `fc97e7fb-24a9-4e52-8e83-536e75176e24` | `gemini-3.8-flash-low` | Input 18,442; output 284; thinking 0; cached input 0; total 18,726 |
| Reviewer | Claude Code / pending | Pending | Pending | Pending | Pending |

AGY used `view_file`, `replace_file_content`, and `view_file` in the isolated
Worker workspace. Foreman verified the complete one-entry snapshot against the
pinned base; the only allowed and changed path was `README.md`. The exact
addition was:

```diff
+
+AGY Flash made this disposable change.
```

The configured `grep -Fx` validation for `AGY Flash made this disposable
change.` passed with exit code 0. Orchestrator inbox digest:
`3c4459b99134a33057a147167988ff706d0d2e55cf1eb7e1c2fa028c7361deb5`.
Deterministic fixtures passed separately: Foreman 70/70 and bridge 36/36
outside the sandbox. Fixture results are not live model calls. Reviewer
evidence remains pending; human approval and Git promotion remain untouched.

## Current limitations

- The host-side bridge is experimental and is not Foreman core or a
  HarnessRouter backend. It requires Linux `bubblewrap` and the host CLIs.
- Planner and Orchestrator continuation requires bridge support for each CLI's
  native conversation/session mechanism. The bridge binds any prior response
  to the exact run, role, harness, model, and project before resuming it.
- Model observation and usage depend on what each CLI reports. Requested
  model is stored separately and must not be presented as an observed model.
- AGY usage may include input, output, thinking, cache-read input, and total
  token fields. Foreman records only fields reported by the CLI; unavailable
  fields remain unavailable. A CLI-level response is not an authoritative
  provider request count.
- The bridge cannot authoritatively report the number of underlying provider
  requests for a CLI call. Do not infer that count from Foreman's one
  assignment/submission.
- The bridge's workspace and read-only Reviewer extension is experimental.
  Foreman's independent snapshot verification and controller validation are
  the authority for the returned Worker result.
