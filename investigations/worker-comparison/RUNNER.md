# Repeated AGY Worker diagnostics

`prepare.mjs` creates a clean disposable task repository. Build Foreman, then
prepare a distinct task, run, and workspace for each AGY attempt. Preparation
does not submit a model task. Runs use only the Antigravity CLI Worker. The
model ID below is the AGY model ID reported by `agy models`.

```sh
node investigations/worker-comparison/prepare.mjs /tmp/foreman-comparison-repo
pnpm build
FOREMAN_WORKER_COMPARISON_ATTEMPTS=3 \
  node investigations/worker-comparison/compare.mjs --prepare-only \
  http://127.0.0.1:PORT /tmp/foreman-comparison-repo BASE_SHA \
  gemini-3.8-flash-low 1.2.9
```

Use the same attempt count and inputs for each explicit submission. Each
attempt ID can be submitted once. Select another prepared attempt ID after a
failed or inconclusive call; every attempt has its own workspace and durable
call lock.

```sh
FOREMAN_WORKER_COMPARISON_ATTEMPTS=3 \
  node investigations/worker-comparison/compare.mjs --execute-attempt \
  antigravity-cli attempt-001 http://127.0.0.1:PORT \
  /tmp/foreman-comparison-repo BASE_SHA gemini-3.8-flash-low 1.2.9
```

Each attempt requires a completed response bound to its prepared workspace, a
complete snapshot within the exact allowed scope, task acceptance, and the
configured Foreman `pnpm test` validation. Reports are written separately as
`evidence/antigravity-cli.attempt-NNN.json`; report creation is exclusive, so
an existing report is never overwritten.

`FOREMAN_WORKER_COMPARISON_TIMEOUT_SECONDS` sets the AGY CLI timeout from 1 to
110 seconds. The UHP response timeout remains within its 120 second bound.
`FOREMAN_WORKER_COMPARISON_STATE` can pin the state/evidence directory when
needed.
