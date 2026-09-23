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
Each task receives a fresh empty `/tmp` work directory; Claude gets no tools,
and Codex runs with the read-only sandbox and ephemeral mode. No repository
path is mounted or selected as cwd.

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

Run `pnpm build`, then use the one-task live smoke only when explicitly
authorized: `node smoke.mjs http://127.0.0.1:8787 claude-code`. It records a
unique idempotency key at `/tmp/local-cli-uhp-smoke-key.json` before submission;
retries reuse that key for the same URL, harness, and prompt. The script prints
only protocol status, requested/actual model, response/session IDs, event
types, and measured usage. `LOCAL_CLI_UHP_SMOKE_KEY_FILE` can select another
record path. Deterministic fake CLI tests: `node --import tsx --test test.mjs`.
They exercise the real Foreman `UhpClient` and never invoke authenticated CLIs
or a provider.
