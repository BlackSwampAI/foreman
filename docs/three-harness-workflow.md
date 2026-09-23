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
scope. The practical defaults use Claude Code or Codex CLI for Planner,
Orchestrator, and Reviewer, and `antigravity-cli / gemini-3.8-flash-low` for
Worker when that Flash model is available. Any discovered pair can be selected
for any role. Selections remain editable per role and per run.

Create a disposable project, task, and run for a small change. Start requires a
successful Planner turn and queued guidance. You may pin a full Git commit SHA
and prepare the Worker workspace in the run view first; otherwise **Start
work** pins the configured source repository's current HEAD and seeds an
isolated workspace. The Worker request does not accept an arbitrary host path.
The allowed scope is enforced against Foreman's own comparison of the complete
returned snapshot with the pinned Git base.

## Run the workflow

1. **Human ↔ Planner.** Send a message in the Planner conversation surface.
   Foreman stores ordered guidance and submits one Planner turn. Planner
   replies and assignment/session metadata appear in the run. Planner and
   Orchestrator use separate continuing contexts.
2. **Start the controller.** Click **Start work** and set the per-role turn
   budgets and Worker attempt limit. Defaults are Planner 3, Orchestrator 2,
   Worker 2, Reviewer 1, and two Worker attempts. The controller automatically
   sends the recorded Planner request and guidance to Orchestrator. Orchestrator
   must return a strict JSON object containing a bounded `workerTask`; only a
   successful, bound proposal can advance the run.
3. **Worker and evidence.** Foreman dispatches the proposal with the selected
   Worker harness/model. The Worker edits only its isolated workspace seeded
   from the pinned base. Foreman obtains and verifies the complete snapshot,
   compares bytes, modes, and paths against the pinned Git base, enforces the
   allowed scope, and computes the exact diff. Incomplete snapshots and
   out-of-scope paths stop the run.
4. **Validation and Reviewer.** Foreman runs every configured command in a
   disposable validation workspace with time and output bounds. After
   successful verification and validation, Foreman sends the exact verified
   diff and validation evidence to a read-only Reviewer. The Reviewer
   recommendation is advisory; it cannot edit the result or approve it. The
   UI records selected harness/model, response and session IDs, observed model
   when available, and usage fields reported by the CLI. Missing fields remain
   unavailable.
5. **Stop and recovery rules.** The controller enforces run budgets across
   automatic and manual role assignments. It does not retry failed CLI
   submissions, incomplete evidence, out-of-scope changes, or changed results
   that fail validation. One bounded follow-up Worker attempt is available
   only after a successful, complete, scope-verified Worker result fails
   configured validation and budget remains. Orchestrator must provide a
   distinct strict proposal; Foreman archives the prior proposal and evidence,
   then seeds a fresh workspace from the same pinned base. This creates a new
   Worker assignment and does not retry the prior proposal or Worker result. A
   second validation failure stops for a human.
   During automation, Planner messages queue as steering and the controller
   offers them to Orchestrator at the next safe checkpoint. Stop reasons and
   role budgets are visible in the run.
6. **Human decision.** Inspect the diff, validation evidence, role calls, and
   Reviewer recommendation in **Evidence and approval**. Only the human's
   explicit approval or rejection records the final decision. Approval does
   not change Git. Promotion remains a separate explicit UI action after
   approval.

Agent text alone cannot dispatch work, satisfy Foreman's Git verification,
pass controller validation, approve changes, or change Git. The controller
owns those transitions and binds the evidence to the run's pinned base.

## Live automatic-path proof

The automatic controller completed a live run on 2026-09-23 through all four
roles, with one successful turn per role. Planner and Orchestrator used Codex
CLI (`gpt-6-sol`); AGY Worker used `gemini-3.8-flash-low`; Claude Code Reviewer
used `sonnet` and observed `claude-sonnet-5`. Both Codex observed-model values
were unavailable. The run ended at `awaiting_approval`, with approval and
promotion unset.

Foreman verified the complete one-entry snapshot at pinned base
`12a4c2821c60a1173f7232312e91b483a49bd147`; `README.md` was the only allowed
and changed path. Foreman's exact `grep -Fx` validation passed. The Reviewer
recommended the change in read-only mode. The live AGY report records 99,794
input, 9,882 output, 109,676 total, and 9,191 thinking tokens. Cost and
underlying provider request count are unavailable. Full role IDs, usage,
diff, validation output, and receipt digest are in the
[live automatic-path smoke report](automatic-path-smoke.md) and
[machine-readable evidence](evidence/automatic-path-smoke-20260923.json).
Reported checks were Foreman 77/77, bridge 37/37, typecheck, and build.

## Historical manual live proof record

This separate proof predates **Start work** and exercised the manual Planner →
Orchestrator → Worker verification → Reviewer sequence. The live automatic
proof above has its own run, turn count, role assignments, and evidence. Keep
the following older IDs and usage scoped to this historical manual proof.


The four-role live proof is complete through Reviewer on run
`run_8931540b-d039-4f2d-a92b-e1a1b3658857`, pinned to disposable base
`14eb32bf56f584043d4466b6eacb0ae39f622576`. The proof summary records 12
session-confirmed live CLI turns including diagnostics: Codex CLI 4 (2
diagnostic), AGY 6 (5 diagnostic), and Claude Code 2 (one quota-limited failed
Planner turn and one successful Reviewer turn). One additional failed Claude
submission has an invocation record but no session ID or execution-stage
evidence, so whether the CLI process started is unconfirmed. These 12 turns
include diagnostics and are distinct from the four successful workflow role
calls. Underlying provider request counts are unavailable.

| Role | Harness/model | Response ID | Session/conversation ID | Observed model | Reported usage |
| --- | --- | --- | --- | --- | --- |
| Planner | Codex CLI / `gpt-6-sol` | `resp_52dbeb3d-b3a3-4c07-a123-bb3788a7f61c` | `01a0cd11-ffe9-77d2-881f-40f42bdb3d25` | Unavailable | Input 56,420; output 515; cached input 53,248; other fields unavailable |
| Orchestrator | Codex CLI / `gpt-6-sol` | `resp_b58ecd52-8530-488b-8a8a-626a48c38f41` | `01a0cd12-6994-7ce1-ab09-14212af864ec` | Unavailable | Input 14,073; output 156; cached input 11,776; other fields unavailable |
| Worker | `antigravity-cli` / `gemini-3.8-flash-low` | `resp_f837db7f-95f2-4a79-ba44-78c3cff31c4a` | `fc97e7fb-24a9-4e52-8e83-536e75176e24` | `gemini-3.8-flash-low` | Input 18,442; output 284; thinking 0; cached input 0; total 18,726 |
| Reviewer | Claude Code / `sonnet` | `resp_3ef89ac8-462a-4ca3-833e-1838228188ba` | `45b25219-a910-4b5f-91be-e518b437d818` | `claude-sonnet-5` | Input 2; output 391; cached input 3,397; runtime 5,305 ms; total tokens unavailable |

Reviewer recommendation `recommendation_789b30c8-05f0-4e85-a0f5-b2b5643f4c2b`
was `recommend`, with read-only mode and no mutation attempt. Aggregate usage
reported across all session-confirmed turns:

| Harness | Turns | Reported usage |
| --- | ---: | --- |
| Codex CLI | 4 | Input 141,780; output 1,339; cached input 128,640; total tokens unavailable |
| AGY | 6 (4 usage-bearing) | Input 60,023; output 1,403; total 61,426; thinking 785; cached input 0 |
| Claude Code | 2 | Input 2; output 391; cached input 3,397; total tokens unavailable (quota-limited turn reported zero input/output) |

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
Deterministic fixtures passed separately outside the sandbox: Foreman 72/72
and bridge 37/37. Fixture results are not live model calls. Human approval
remains null and Git promotion remains not started; both are reserved for the
operator's decision in the UI.

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
