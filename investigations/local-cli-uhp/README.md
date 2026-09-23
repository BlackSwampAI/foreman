# Experimental local CLI UHP server

This is an external experiment, not part of Foreman core. It adapts installed
Claude Code and Codex CLI executables to the UHP 2026-09-12 discovery,
Responses, retrieval, idempotency, SSE, and cancellation routes used by
`src/uhp.ts`.

The provider-connection preflight is satisfied by explicit local configuration:
set `CLAUDE_CONFIG_DIR` to an already authenticated Claude Code config
directory and/or `CODEX_HOME` to an already authenticated Codex home. The
server passes that existing directory to the CLI as-is. It never reads or
copies credentials. Harness discovery advertises only configured directories.
Claude is advertised only when its auth directory, explicit model, pinned
source repository, and bubblewrap executable are configured. Claude tasks
must use the bridge-specific pinned-workspace flow below; the older generic
no-tools smoke describes historical protocol evidence and is no longer a
supported Claude task path. Codex continues to use its read-only sandbox and
ephemeral mode. A UHP request cannot supply an arbitrary host cwd.

HarnessRouter's per-session `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are credential
stores; creating fresh empty per-session directories there would discard the
existing login. This adapter reuses the configured host auth directory and
isolates task state with a unique working directory. It advertises
`sessions: false` because CLI resume is not implemented; a CLI-reported session
ID is returned on the response and in its metadata for evidence only. It therefore demonstrates a
host-side alternative that bypasses the router's
provider-connection gate. Supporting these logins inside HarnessRouter itself
would require an explicit opt-in host CLI backend which passes the already
authenticated host directory to the child, plus a policy exception in the
provider-connection preflight. It must not clone auth files into session
directories.

## Run

From this folder, with Node 24, set an explicit model accepted by each
installed CLI. The model setting is required for discovery; a configured auth
directory alone does not advertise a harness:

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude" CLAUDE_MODEL="<supported Claude model>" LOCAL_CLI_UHP_PORT=8787 node server.mjs
```

Set `CODEX_HOME` and `CODEX_MODEL` similarly to expose Codex. The bridge passes
the explicit configured model using the CLI's `--model` argument. A successful
response requires the CLI output to report a concrete actual model and session
ID; literal `undefined` does not qualify. If the CLI reports a different model,
the response marks `metadata.model_fallback` and records the requested model.
Codex runs with `--ignore-user-config` to retain its existing authentication
while ignoring `config.toml` provider overrides, and `--skip-git-repo-check`
because each run starts in a fresh temporary directory.
Usage is omitted unless the CLI reports it; Claude cached input counts include
cache reads and exclude cache creation. The child gets only a small runtime
environment allowlist, including `PATH` and `HOME`; provider API keys and
provider-selection overrides are excluded. Do not set provider API keys for
this experiment. State is stored at
`LOCAL_CLI_UHP_STATE` (default `/tmp/local-cli-uhp-state.json`, mode 0600) and
work directories under `LOCAL_CLI_UHP_WORK` (default `/tmp/local-cli-uhp-work`).
The HTTP listener binds loopback only and has no authentication; keep it local.

Requests are limited to 16,000 prompt characters, 120 seconds, and 64,000
returned output characters. Claude's invocation also limits turns to at most
10. Codex's internal step count is not controllable through the selected CLI
invocation; its response reports `max_step` under `metadata.ignored_fields`.
The CLI is spawned without a shell. Before spawning,
the idempotency key and response intent are atomically persisted. A replay
returns that task and never starts a second CLI. After a crash, an unresolved
intent is marked failed on restart rather than repeated. An in-progress request
disconnect does not cancel the durable task; use the cancellation route.

The earlier no-tools UHP smoke remains in `smoke.mjs` as historical evidence
for the UHP transport behavior. Do not use it for a current Claude task: Claude
submissions now require a seeded workspace ID and otherwise return
`workspace_required`.

Deterministic fake CLI and boundary fixtures: `node --import tsx --test test.mjs`
and `node workspace-verifier.fixture.mjs`. The fake CLI tests exercise the
real Foreman `UhpClient` and never invoke authenticated CLIs or a provider.

## Bridge-specific Git workspace extension

This extension is experimental and is not part of portable UHP or Foreman's
core worker API. Set `LOCAL_CLI_UHP_SOURCE_REPO` to a disposable local Git
fixture before starting the server. Workspace selection is an explicit
operation over a full commit SHA; requests do not accept a host path:

- `POST /extensions/foreman-workspace/v1/workspaces` with
  `{"base_commit":"<full commit SHA>"}` seeds a fresh workspace from the
  configured source repository and returns its `workspace_id` and exact base.
- Submit the Worker request with that `workspace_id` in response metadata.
- `GET /extensions/foreman-workspace/v1/workspaces/{workspace_id}/snapshot`
  returns a complete tree, exact file bytes (base64) and SHA-256, Git mode,
  symlink target, and an explicit `errors` list. Dotfiles and instruction
  files are included. Any unreadable, special, or oversized entry makes
  `complete` false.

Discovery advertises this as
`capabilities.extensions.foreman_workspace_bridge_v1`, with version, seeding,
complete-snapshot, and `bubblewrap` boundary fields. Before Claude tools run,
the bridge checks that a temporary sentinel outside the assigned workspace is
unreadable and unmodifiable while the workspace is writable. The authenticated
Claude config directory is the explicit read-only filesystem exception needed
for subscription CLI authentication: bubblewrap mounts it at `/auth`, and
`CLAUDE_CONFIG_DIR=/auth`. It is not copied into or writable from the task
workspace. Claude runs with `--restricted`, `--strict-mcp-config`,
`--permission-mode acceptEdits`, and only the `Read,Edit,Write` tools. The child
receives a temporary home and the assigned workspace as cwd.

Foreman independently reads the pinned local Git commit, validates the
snapshot envelope and entry bytes/modes/targets, computes additions,
modifications, deletions, and identical-content renames, and enforces the
allowed path scope. It writes a review diff and JSON evidence record. The
bridge's `complete` flag is recorded as a bridge claim; it cannot by itself
mark a task accepted. Standard UHP artifact routes do not promise this exact
Git snapshot. Use `workspace-smoke.mjs` with the full fixture SHA and explicit
Claude model for the bounded live path, after deterministic boundary checks
pass:

```sh
pnpm build
CLAUDE_CONFIG_DIR="$HOME/.claude" \
CLAUDE_MODEL="<explicit Claude model>" \
LOCAL_CLI_UHP_SOURCE_REPO="<disposable fixture repository>" \
LOCAL_CLI_UHP_PORT=8787 node server.mjs
node workspace-smoke.mjs http://127.0.0.1:8787 \
  "<disposable fixture repository>" "<full base commit SHA>" \
  "<same explicit Claude model>"
```

The script allows up to three turns, a 90-second task limit, a pre-persisted
idempotency key, and a persisted workspace ID for replay.
`LOCAL_CLI_UHP_SMOKE_KEY_FILE`
and `LOCAL_CLI_UHP_EVIDENCE_FILE` select the key and evidence paths.

## Recorded live proof

The first workspace attempt failed closed at `boundary_probe` before CLI
launch. Response `resp_af452680-6544-496f-b12e-23c89aa667ad` had no actual
model, session ID, or usage, and its incomplete snapshot was rejected. A
deterministic ELF-header check exposed and fixed the bubblewrap setup issue;
the deterministic sentinel check and a real-auth, no-provider preflight then
passed.

The bounded Worker task then completed from pinned base
`ff2e868ae0360b706c57c3ef2d21741fe5f9dd9c`. It requested `opus`; the CLI
reported actual model `claude-opus-5-5`. UHP response ID:
`resp_8f8f4014-ac96-4c8b-9dd9-f9b0fc10c64d`. Session ID:
`b33b15f7-32e5-46be-9946-908e76a6b52c`. Measured usage: 6 input, 328 output,
9,105 cached input tokens. Foreman independently verified the four-entry
complete snapshot with no errors against its local pinned Git base. Only
`README.md` changed, and `scopeVerified` is true under the allowed scope.
The evidence record says `acceptance: not_decided`; this is a verified result
for review, not an automatic acceptance. Sanitized machine evidence and a
readable diff are in `evidence/actual-workspace-smoke.json` and
`evidence/actual-workspace-smoke.md`. The failed first attempt is recorded
in `evidence/initial-boundary-failure.json`.

Claude session continuation remains unimplemented. Codex has no verified
actual-model signal. The pinned HarnessRouter runtime still has no verified
subscription-auth or full-workspace-snapshot proof.
