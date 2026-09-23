# Subscription-authenticated CLIs through UHP

## Pinned HarnessRouter CE 0.8.0 finding

The inspected image is `harnessrouter/harnessrouter:0.8.0` at digest `sha256:a9cbc45318e5d3e3da02686a46b0a16ed8bbe930005b66af5ff0f9f12f3a837f`. Its gateway and runner sources were copied from the stopped probe container for read-only inspection. This is evidence about that pinned image, not an assumption from a different source release.

The image can install Claude Code and Codex binaries when `HR_BACKENDS=claude,codex`. Binary installation does not make a task runnable with the host's Claude.ai or ChatGPT login:

| Boundary | Pinned-image behavior |
| --- | --- |
| Provider preflight | Gateway `app.py` rejects a response turn with no connection chain or mapped integration before starting the runner. Its execution loop gets the runner's auth from the chosen connection. |
| Claude Code | Runner `server.py` redirects `HOME` into the task workspace and sets `CLAUDE_CONFIG_DIR` beneath that home. The usual host Claude login is not read. The runner passes an API-style Anthropic auth value from the integration when configured. |
| Codex CLI | Runner sets `CODEX_HOME` beneath the task workspace and writes a custom `hr-*` provider configuration with a base URL and API-key environment variable. The usual host ChatGPT login is not read. |
| Recycle and restore | Checkpoint capture includes conversation state but explicitly excludes `.harness/home/.claude/.credentials.json` and `.harness/home/.codex/auth.json`. A login performed inside one disposable session would therefore not automatically survive restore. |

The relevant pinned-image source locations are `gateway/app.py` around `_auth_from_conn`, `_resp_execute`, and the response-turn preflight; `runner/server.py` around `CHECKPOINT_EXCLUDE`, `_build_claude`, `_codex_prepare_env`, and the turn's redirected `HOME`; and `entrypoint.sh` around `HR_BACKENDS`. The [HarnessRouter CE setup guide](https://github.com/HarnessRouter/harnessrouter/blob/main/docs/self-hosting-guide.md) documents a provider integration and distinguishes its provider credential from its UHP/API key. The source inspection and unchanged local setup establish that this image has no supported path from these existing host subscription logins to a UHP turn without a provider connection.

## Smallest change or alternative

A HarnessRouter change would add an explicit subscription-CLI auth mode for Claude and Codex. That mode must bypass provider-connection preflight only when selected, run each CLI with its native authenticated configuration rather than a generated API provider, and keep subscription auth in an isolated persistent store for the UHP principal while excluding it from task workspace snapshots. Login and token refresh must occur inside that boundary. A simple flag that skips preflight is insufficient because the runner changes `HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR` for each task.

For a bounded local probe, an external host-side UHP server is smaller. The [experimental bridge](../investigations/local-cli-uhp/README.md) runs as the same OS user as the already authenticated CLIs, uses their normal login stores in place, executes each request in an isolated disposable working directory, and translates CLI events into UHP responses. It requires no token copy or provider API key. It is an investigation artifact, not Foreman's native subprocess backend or a proof of the Worker-to-Git workspace bridge.

The [Codex `exec --json` event type](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs) reports a thread ID and turn usage but does not include the selected model in its standard `thread.started` or `turn.completed` event. The bridge therefore refuses to claim a Codex turn complete when no actual model can be observed. Its Codex invocation uses `--ignore-user-config` so host provider configuration cannot redirect the task to an API-key provider while `CODEX_HOME` still supplies login auth; `--skip-git-repo-check` permits the isolated empty work directory. A production Codex path needs a model identity from an authoritative CLI/app-server event or an explicit, verified model-selection contract; labeling a requested alias as the actual model would hide substitutions.

## Bounded demonstration

Eight deterministic fake-CLI tests passed outside the nested sandbox. They exercise Foreman's real `UhpClient`, discovery, SSE response mapping, session and response IDs, idempotent replay across a bridge restart, spawn and CLI error handling, measured usage mapping, explicit model discovery, and refusal to call a result complete when the actual model is unavailable or `undefined`. The bridge advertises `sessions: false` because response continuation is not implemented. It strips provider credentials and provider-selection overrides from child process environments.

The first authorized live UHP submission used the existing Claude.ai Pro login, a fresh empty temporary work directory, one turn, no tools, a 45-second limit, and a pre-persisted idempotency key. The loopback bridge advertised UHP `2026-09-12`, both configured harnesses, and Claude's `default` model alias. Foreman's `UhpClient` received `response.created` then `response.failed`. Response ID `resp_00d72daf-2abf-4501-8216-5d1db7d27c6d`, session ID `9bf1a985-ee20-4ee1-bf56-2a0b51a1b60a`. Claude reported selected model `undefined`, rejected that model before producing an answer, and reported **0 input, 0 output, 0 cached-read tokens**. The bridge persisted the failure; replaying its key cannot launch a duplicate task. This establishes that the authenticated CLI was invoked through UHP and that its failure returned through the protocol. It does not establish a successful role turn.

The host Claude settings name `opus` as the preferred model. A diagnostic `claude config get model` command was treated by this CLI as a prompt and returned conversational text. It was outside UHP and may have made a separate model request; it was not a safe read-only status command. No token files or provider API keys were copied or configured. The operator then authorized one retry.

The bridge was hardened to require an explicit model before advertising a harness and to pass that model with `--model`. The one authorized retry advertised Claude model `opus` and used the same one-turn, no-tools, 45-second bound in a new temporary workspace. Foreman's `UhpClient` received `response.created` then `response.completed`. The CLI reported **actual harness `claude-code`, model `claude-opus-5-5`**, response ID `resp_e89104a6-a445-44b7-9b4f-f12cae63e17a`, and session ID `c24bb4c5-48f0-48c2-b18e-1a5264375417`. Its answer was: “Deterministic tests produce the same result every run, so failures reliably signal real bugs rather than flakiness.” Measured CLI usage was **2 input tokens, 37 output tokens, and 531 cached-read input tokens**; no cost, quota, or remaining allowance was claimed. The bridge's persisted idempotency key maps to this response. Both temporary loopback servers were stopped after inspection.

This proves a subscription-authenticated Claude Code CLI can complete a bounded task through this external UHP bridge without a provider API key. That response alone did not prove workspace transport, isolation, or Git acceptance. It does not make pinned HarnessRouter support subscription login, establish a Codex actual-model signal, or implement role-session continuation.

## Worker workspace proof status

The external bridge now has a separately advertised, bridge-specific workspace
extension. It seeds from a full commit in the server-configured disposable Git
repository, binds the resulting workspace ID to the UHP task, checks an outside
filesystem sentinel under bubblewrap before tool execution, and exposes a
bounded complete snapshot with exact bytes, modes, symlink targets, and
explicit errors. Foreman's verifier independently reads its pinned Git base,
checks snapshot hashes/bytes/modes, detects additions, edits, deletions, and
identical-content renames, and enforces the allowed path scope. Standard UHP
session artifact APIs still do not mean “complete Git snapshot”.

The initial workspace attempt failed closed at `boundary_probe` before the CLI
launched: response `resp_af452680-6544-496f-b12e-23c89aa667ad` had no actual
model, session ID, or usage, and its incomplete snapshot was rejected. A
deterministic ELF-header check exposed and fixed the bubblewrap setup issue;
the sentinel check and a real-auth, no-provider preflight then passed.

The subsequent bounded Claude Worker task completed against pinned base
`ff2e868ae0360b706c57c3ef2d21741fe5f9dd9c`. Foreman received response
`resp_8f8f4014-ac96-4c8b-9dd9-f9b0fc10c64d`, session
`b33b15f7-32e5-46be-9946-908e76a6b52c`, requested model `opus`, and actual
model `claude-opus-5-5`. Measured usage was 6 input, 328 output, and 9,105
cached input tokens. The complete snapshot had four entries and no errors;
Foreman's local Git comparison verified only `README.md` changed and returned
`scopeVerified: true` for the allowed scope. At Worker evidence capture, acceptance was `not_decided`;
the bridge's claims did not accept the result. Sanitized
evidence and the readable diff are in
[`investigations/local-cli-uhp/evidence`](../investigations/local-cli-uhp/evidence/actual-workspace-smoke.json).

Session continuation remains unavailable, Codex still has no verified
actual-model signal, and the pinned HarnessRouter runtime has no verified
subscription-auth or full-workspace-snapshot proof.

## Read-only Reviewer mode

The external bridge now accepts an explicitly marked `role_id=reviewer`
response only when Foreman supplies `metadata.foreman_review_mode="read_only"`
and bounded `metadata.review_evidence` containing its verified base/scope,
exact diff, and controller-observed validation. Reviewer tasks do not carry the
Worker `workspace_id`; the bridge creates a fresh transient context with no
checkout. Claude runs with an empty tool allowlist. Codex uses
`--sandbox read-only`, which may permit read-only shell tools. It fails closed if the task fails, if the
CLI omits its actual model or session identity, or if its output reports a tool
or mutation attempt. This preserves the host subscription login boundary and
does not add subscription credentials or a CLI backend to Foreman core.

The one live Reviewer response is recorded in [actual-reviewer-smoke.json](../investigations/local-cli-uhp/evidence/actual-reviewer-smoke.json): requested `opus`, actual `claude-opus-5-5`, response `resp_2d3c9439-28df-460b-8537-7993f2b06540`, session `6cea9d31-a35f-480f-b50f-95cd4d94e665`, measured usage 2 input, 552 output, and 531 cached input tokens. It recommended the README-only change after observing that the diff stayed in scope and the sole configured SHA-256 validation passed; the rationale notes that the hash check verifies recorded bytes rather than content, so the diff was also inspected. The bridge proved the Claude boundary: no project workspace, empty tool allowlist, non-writable review workspace, and no mutation attempt. Exactly one bridge response was recorded. At Reviewer evidence capture, acceptance was `not_decided`, the run was `awaiting_approval`, and human approval was null. The operator later approved it in the UI; [the separate approval record](../investigations/local-cli-uhp/evidence/actual-reviewer-approval.json) shows the current accepted state. The deterministic controller fixture remains a separate simulated Reviewer test. The live policy used one README SHA-256 command, which verifies recorded bytes rather than providing broader project-test coverage. Codex read-only mode was fixture-tested only; verified Codex actual-model reporting, Claude session continuation, and equivalent HarnessRouter behavior are not claimed.
