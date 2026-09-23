# Codex Worker workspace proof

This proof routes one Worker task through the experimental external UHP bridge
to Codex CLI using the existing host ChatGPT login. The bridge receives the
configured `CODEX_HOME` by path and mounts it read-only; it does not copy
credentials. Do not set a provider API key for this proof.

Codex edits only the assigned workspace. Before starting the CLI, the bridge
runs a deterministic boundary probe that must show an outside sentinel cannot
be read or changed and the assigned workspace can be written. It then runs
Codex with workspace-write sandboxing inside the isolated workspace. The
bridge returns a complete snapshot. Foreman pins the local Git base, receives
that snapshot, independently compares exact bytes and modes to the base,
checks the allowed scope, materializes the verified result into a separate
validation workspace, and runs the configured validation command.

Codex's standard event stream may omit the actual model. Foreman records the
explicitly requested model and exact CLI invocation. When the CLI provides no
authoritative model signal, evidence and the UI say **actual model unavailable**;
they do not treat the requested model as observed. A completed Codex Worker
result can still pass snapshot, scope, and validation checks with that reporting
gap recorded. This proof starts only a Worker assignment. It does not submit a
Planner, Orchestrator, or Reviewer request and does not approve or promote the
result.

## Deterministic fixture

The no-provider fixture is part of `test.mjs`. It uses a disposable Git repo
and a fake Codex executable. The fake executable tries to read and overwrite
an outside sentinel, edits only its assigned README, and emits standard Codex
thread, message, and usage events without an actual-model field. Foreman must
record the requested model and invocation, mark actual model unavailable,
retrieve the complete snapshot, verify both changed paths against its pinned
base and allowed scope, and pass the configured README validation command.
The fixture also checks that the sentinel remains unchanged and the bridge
reports its workspace boundary as proven. It does not call a model provider.

Run it after building Foreman:

```sh
pnpm build
node --import tsx --test investigations/local-cli-uhp/test.mjs
```

The fixture starts the real local bridge with deterministic CLI executables and
uses Foreman's real `Controller`, `UhpClient`, snapshot verifier, and validation
runner. Process and child-pipe fixtures must be run outside the nested sandbox,
as described in `AGENTS.md`.

## One-call live procedure

First create a separate one-file disposable Git repository with `README.md` at
its pinned base, and capture its path and full base SHA:

```sh
node investigations/local-cli-uhp/codex-live-fixture.mjs
```

The helper prints `{ "repo": "...", "baseCommit": "..." }`; use those exact
values for the bridge source repository and both smoke commands below. Remove
the temporary repo after the smoke evidence is recorded.

Start the bridge with the already authenticated host Codex directory and an
explicit model that appears in bridge discovery. Preserve the host login in
place; do not copy auth files or add `OPENAI_API_KEY`:

```sh
CODEX_HOME="$HOME/.codex" CODEX_MODEL="gpt-6-sol" \
LOCAL_CLI_UHP_SOURCE_REPO="<fixture-repo>" LOCAL_CLI_UHP_PORT=8787 \
node investigations/local-cli-uhp/server.mjs
```

Run prepare mode first. It discovers the exact selected model, creates one
Foreman run, pins the full base, seeds its bridge workspace, and makes zero
model calls:

```sh
node investigations/local-cli-uhp/codex-worker-smoke.mjs --prepare-only \
  http://127.0.0.1:8787 "<fixture-repo>" "<full-base-sha>" gpt-6-sol
```

After reviewing the prepared run and ensuring the deterministic fixtures pass,
execute mode can consume that preparation once:

```sh
node investigations/local-cli-uhp/codex-worker-smoke.mjs --execute-once \
  http://127.0.0.1:8787 "<fixture-repo>" "<full-base-sha>" gpt-6-sol
```

The bridge applies a 30-second task timeout. Codex does not enforce UHP
`max_step`, so its internal step count is not claimed as bounded. The durable
`prepared.json.live-call.lock` is created before submission with exclusive
file creation. Its presence forbids another submission, including after a
crash or failure. The evidence file records success or failure and is created
once. It records response/session IDs and usage only when reported, requested
model, exact invocation, model-reporting status, bridge boundary evidence,
complete snapshot/scope result, and controller-observed validation. On failure
it distinguishes the UHP submission attempt from whether the CLI started; the
CLI does not provide an authoritative count of underlying provider requests.
Human approval, Reviewer work, and Git promotion are outside this proof. A
result commit is not claimed.

## Evidence status

- Deterministic fake-CLI bridge proof: **23/23 tests passed**, with no provider
  calls. It proves the assigned workspace edit, outside-sentinel boundary,
  complete snapshot, independent scope check, and configured validation.
- Live attempt: one UHP submission and one CLI invocation; **zero completed
  model turns**. Response ID: `resp_94f2495f-43f6-4d22-b401-463266d9e5db`.
  The bridge reported `CLI did not report an actual model and session id`.
  There is no session ID, measured usage, or CLI output, and the underlying
  provider request count is unavailable.
- The bridge response metadata says actual model unavailable; requested model
  was `gpt-6-sol`. The failed response predates a controller persistence fix,
  so the Foreman assignment itself has no persisted actual-model status.
  Evidence keeps those two observations distinct. Missing actual-model data is
  permitted for a completed result; this attempt failed because the CLI task
  had failed status and no session ID or usable response JSON.
- The bridge did prove the workspace boundary: the outside sentinel was
  unreadable and unmodifiable, and the assigned workspace was writable. The
  returned snapshot was incomplete (`complete:false`, one 87-byte README entry
  identical to the pinned base, and `task_status_failed` at `.`). Scope
  verification did not run because the snapshot was incomplete; this is not a
  finding that a change was out of scope. Foreman's configured validation did
  not run.
  The README remained unchanged.
- The durable one-call lock remains in place. There will be no retry for this
  proof. Human approval and Git promotion were not requested.
- Codex ignores UHP `max_step`. The live bridge timeout is 30 seconds, and the
  durable smoke lock permitted one CLI invocation.
- Validation: one configured README content check; this does not claim a
  broader project test suite.

The captured result is in
[`actual-codex-worker-smoke.json`](../investigations/local-cli-uhp/evidence/actual-codex-worker-smoke.json).
