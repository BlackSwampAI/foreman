# Experimental local CLI UHP server

This is an external experiment, not part of Foreman core. It adapts installed
Claude Code and Codex CLI executables to the UHP 2026-09-12 discovery,
Responses, retrieval, idempotency, session, SSE, and cancellation routes used by
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
isolates task state with a unique working directory and CLI session ID. It
therefore demonstrates a host-side alternative that bypasses the router's
provider-connection gate. Supporting these logins inside HarnessRouter itself
would require an explicit opt-in host CLI backend which passes the already
authenticated host directory to the child, plus a policy exception in the
provider-connection preflight. It must not clone auth files into session
directories.

## Run

From this folder, with Node 24:

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude" LOCAL_CLI_UHP_PORT=8787 node server.mjs
```

Set `CODEX_HOME` similarly to expose Codex; override `CLAUDE_MODEL` or
`CODEX_MODEL` only with a model accepted by the local CLI. `default` is an
alias, not a claimed actual model. A response reports a concrete model/session
only when the CLI output includes one; usage is omitted unless the CLI reports
it. Do not set provider API keys for this experiment. State is stored at
`LOCAL_CLI_UHP_STATE` (default `/tmp/local-cli-uhp-state.json`, mode 0600) and
work directories under `LOCAL_CLI_UHP_WORK` (default `/tmp/local-cli-uhp-work`).
The HTTP listener binds loopback only and has no authentication; keep it local.

Requests are limited to 16,000 prompt characters, 120 seconds, 10 steps, and
64,000 output characters. The CLI is spawned without a shell. Before spawning,
the idempotency key and response intent are atomically persisted. A replay
returns that task and never starts a second CLI. After a crash, an unresolved
intent is marked failed on restart rather than repeated. An in-progress request
disconnect does not cancel the durable task; use the cancellation route.

Use the existing `UhpClient` with this server's loopback URL, explicit harness
ID (`claude-code` or `codex-cli`), and discovered model ID. Deterministic fake
CLI tests: `node --test test.mjs`. They do not invoke authenticated CLIs or a
provider.
