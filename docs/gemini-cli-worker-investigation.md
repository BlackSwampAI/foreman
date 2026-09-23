# Gemini CLI Worker investigation

## Result

The installed Gemini CLI is version **0.60.0** (`@google/gemini-cli` package;
`gemini --version`). It accepts a requested model with `--model`, and its
headless invocation supports `--prompt` and `--output-format stream-json`.
That makes the CLI technically usable as a Worker candidate. This host does
not have an eligible Google account login, however, and the task requires a
legitimate host login inside an isolated workspace without copying credentials
or requiring an API key. Gemini CLI is therefore not added as a selectable
Foreman harness. The bounded comparison attempt stopped before CLI execution;
no Gemini model call was made.

## Authentication findings

The installed CLI's help lists `--model`, `--prompt`, `--output-format`,
`--approval-mode`, `--sandbox`, `--session-id`, and `--resume`. It does not
provide a separate auth subcommand. The installed bundle implements
`oauth-personal` (Login with Google), `gemini-api-key`, Vertex AI, and
Application Default Credentials. The host's
`~/.gemini/settings.json` selects `gemini-api-key`. Its `google_accounts.json`
has `active: null` and only an old account entry; no
`~/.gemini/oauth_creds.json` exists. No secret values or account identifiers
are recorded here.

Gemini CLI 0.60.0 resolves OAuth credentials through its
`OAuthCredentialStorage` implementation. The implementation uses the OS
keychain service `gemini-cli-oauth`, account `main-account`, unless
`GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true` selects encrypted file token
storage. An older OAuth credential file path, `~/.gemini/oauth_creds.json`, is
also present in its migration and fallback logic. `google_accounts.json` is an
account-selection cache, not the credential itself. Setting
`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_ACCESS_TOKEN`, or an API key
would be a different authentication arrangement and is not accepted as proof
of a host Google-account login for this task.

These findings are reproducible from the installed package at
`/home/chris/.local/share/fnm/node-versions/v24.18.0/installation/lib/node_modules/@google/gemini-cli/`:

- `package.json` identifies `@google/gemini-cli` 0.60.0.
- `bundle/gemini.js` contains the CLI option parsing and headless output
  selection.
- `bundle/chunk-M6NSK26M.js` contains `Storage.getOAuthCredsPath`,
  `OAuthCredentialStorage`, keychain/encrypted-file token storage, and the
  Google account cache path.
- `bundle/gemini-ZTU7EMI3.js` contains the stream JSON event emission.

The current host configuration and account state are direct local observations
as of the investigation; they are not claims that Gemini CLI has removed
Google OAuth support. The task owner's report that no eligible Google login is
available here is consistent with those observations.

## Isolation gap

The Foreman bridge runs CLIs in bubblewrap with a fresh temporary home and a
read-only mount for the existing host auth directory. That works for auth
formats that can be narrowly mounted as ordinary files. Gemini CLI's OAuth
credential storage can use a host OS keychain, which is not a credential file
that can be mounted at `/auth`; exposing the host keychain socket would grant a
broader host credential interface and cannot establish a read-only,
Gemini-only view. Its encrypted-file mode also depends on host-local storage
handling and has no supported read-only credential directory contract shown
by this installation. The legacy `oauth_creds.json` fallback is a file path,
but none exists here, and the CLI may refresh credentials during use, so a
safe integration would need verified behavior for read-only auth plus
per-worker writable non-secret state.

Consequently, the bridge cannot currently prove that the installed CLI will
use only a narrowly mounted host Google login while keeping authentication
isolated. Do not weaken the filesystem boundary, mount a general host keychain,
copy OAuth credentials, or provide an API key to make it run.

## Output and usage limits

The CLI exposes JSON and JSON Lines `stream-json`. The inspected 0.60.0
stream formatter emits an `init` event with session ID and configured model,
assistant `message` events, `tool_use` and `tool_result` events, `error`
events, then a `result` event. The result's `stats` can include aggregate
`input_tokens`, `output_tokens`, `total_tokens`, `cached`, `duration_ms`,
`tool_calls`, and per-model token values. These are CLI-reported session
statistics; they are not a provider request count, invoice, cost, or guaranteed
model-side accounting. In particular, the stats schema does not expose a
separate thinking-token field in the inspected formatter, and cache accounting
is reported under Gemini's own `cached`/`input` fields. A comparison must retain
the raw reported fields and explain the accounting differences instead of
normalizing them into claims of exact equivalence with AGY.

The requested model passed to `--model` is not proof of the model actually
served. A future bridge adapter would need to record both separately, report
an observed model only from an authoritative CLI event, and never silently
substitute another model. Likewise, the CLI `tool_calls` statistic is not a
provider request count.

## Conditional comparison outcome

The [bounded comparison record](../investigations/worker-comparison/RESULT.md)
documents two workspaces seeded from one pinned base with identical task text,
allowed paths, and Foreman validation. The single Gemini UHP submission failed
in the bridge's outside-workspace sentinel probe before CLI spawn:
`runtime_path_unavailable`, exit 1. Its response ID was
`resp_64510ecd-21a2-43f4-b8a2-14cca62f8093`; there was no session ID,
observed model, tool trace, reported usage, verified diff, or validation
result. The durable one-call lock and stop rule prevented a repeat or AGY live
call. No provider call occurred. The existing AGY proofs remain separate
evidence and do not establish parity with Gemini CLI.

AGY remains the default Worker. The practical lower-usage Gemini Flash path is
still unmeasured. Production selection remains blocked until a legitimate host
login can be used without API-key requirements and a narrow credential mount
plus isolated writable CLI state can be proved.

## One-off configured CLI boundary

The temporary bridge was configured to invoke `gemini` as installed, with no
credential handling of its own. It would use the assigned workspace, explicit
model, `--approval-mode auto_edit`, `--skip-trust`, and a policy that denies
shell commands. The outer bubblewrap workspace was the intended filesystem
boundary. This one-off path mounted the existing session D-Bus socket with a
read-only filesystem bind, as the AGY adapter does, so the CLI could reach its
configured host keychain. A read-only socket bind does not make the D-Bus
protocol or keychain access read-only. It did not mount host HOME or copy,
inspect, extract, or inject a key. The failed pre-spawn boundary probe means
neither authentication nor Gemini's actual Worker behavior was tested. A
successful future one-off result
would still be labeled as coming from the host's API-key-configured CLI and
would not justify a selectable production path.
