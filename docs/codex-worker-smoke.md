# Codex Worker workspace proof

This proof routes one Worker task through the experimental external UHP bridge
to Codex CLI using the existing host ChatGPT login. For each response, the
bridge creates a fresh writable ephemeral `CODEX_HOME` and bind-mounts the
host's `auth.json` into it read-only. It does not copy credentials. Codex
runtime state stays in the ephemeral home. The bridge sets `PWD=/workspace`,
resolves the host CA bundle, mounts it read-only at the sandbox's standard CA
path, and sets `SSL_CERT_FILE` to that path. Do not set a provider API key for
this proof.

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
- Three live UHP submissions each invoked Codex once. Across the three
  attempts the underlying provider request count is unavailable. The first
  attempt, recorded in
  [`actual-codex-worker-smoke.json`](../investigations/local-cli-uhp/evidence/actual-codex-worker-smoke.json),
  failed immediately without a session ID or usable response JSON;
  the bridge's terminal error was `CLI did not report an actual model and
  session id`. It had no completed model turn. The partial snapshot was
  incomplete and unchanged from its pinned base; scope verification and
  validation did not run.
- The second attempt used the corrected per-response runtime and is
  recorded separately in
  [`actual-codex-worker-smoke-retry2.json`](../investigations/local-cli-uhp/evidence/actual-codex-worker-smoke-retry2.json).
  It passed the boundary probe and started a Codex session, but exited 1 in
  the CLI execution stage before completing a turn (`cliFailureCategory:
  network`). The response contained a session ID but no completed turn or agent
  message. A separate unauthenticated curl reproduction implicated the old
  runtime's missing host CA bundle. That is a
  diagnostic inference, not a TLS error reported by Codex. It
  reported session `01a0cc9f-da14-7920-b00d-e5dc5c730fcd`, response
  `resp_ec9c9d4c-fa0c-4600-8384-20b152ec2e8c`, no usage, and actual model
  unavailable. Its snapshot was incomplete; Foreman did not verify scope or
  run validation. It had zero completed model turns.
- The third attempt completed a turn and produced a verified result. Evidence
  is in
  [`actual-codex-worker-smoke-retry3.json`](../investigations/local-cli-uhp/evidence/actual-codex-worker-smoke-retry3.json).
  Response `resp_d6fb1919-b195-4589-afed-40f6b504f0d3`, session
  `01a0cca6-4ed6-7f12-9013-95fce4e6d5a9`; requested model `gpt-6-sol`, actual
  model unavailable. Measured usage: 57,325 input, 640 output, and 53,888
  cached input tokens. The bridge returned a complete one-entry snapshot;
  Foreman independently verified the single `README.md` modification within
  allowed scope. The edit appended “Codex Worker smoke: Foreman independently
  verified this change.” Configured validation passed with exit code 0.
  Acceptance remained `not_decided`; no Reviewer, human approval, or Git
  promotion was requested. `max_step: 1` is reported as ignored by Codex; the
  task timeout was 30 seconds. The measured CLI runtime was about 20.9 seconds.
- Missing actual-model data is permitted for a completed Codex Worker result;
  the third attempt demonstrates that this reporting gap does not block exact
  snapshot/scope verification or validation. The second attempt's failure was
  instead a network-category failure after session startup; its exact cause is
  not reported by Codex. Requested model and exact invocation are recorded per
  attempt and are not represented as observed actual model. No result was
  approved or promoted.
- Codex ignores UHP `max_step`; each task used the bridge's 30-second timeout.
- Validation: one configured README content check; this does not claim a
  broader project test suite.

The three attempt records above distinguish the initial CLI failure, the
session-started network-category failure, and the completed verified Worker
result.
