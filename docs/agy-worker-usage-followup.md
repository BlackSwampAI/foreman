# AGY Flash Worker usage follow-up

On 2026-09-23, AGY CLI 1.2.9 completed four independently seeded Worker turns
through the existing UHP bridge. Every turn requested and reported
`gemini-3.8-flash-low`, started from disposable Git base
`f90af92ee2ef7261983215e77b66e2aeb4bf56b5`, received the same
[292-byte task](../investigations/worker-comparison/TASK.txt), and had the same
two allowed paths and Foreman `pnpm test` validation. Foreman verified the
complete snapshots and exact identical two-file diff on all four turns:
`formatLabel` returns `Welcome, ${name}!`, and its test expects
`Welcome, Ada!`. No other file changed.

| AGY Worker setting | Attempt | CLI-reported input | Output | Thinking | Cache read | Total | Distinct tool steps | Worker wall time | Foreman result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Existing default (no `--effort`) | [1](../investigations/worker-comparison/evidence/agy-attempt-001.json) | 25,033 | 931 | 476 | 0 | 25,964 | 4 | 39.8 s | Exact diff, scope and test passed |
| Existing default (no `--effort`) | [2](../investigations/worker-comparison/evidence/agy-attempt-002.json) | 23,603 | 521 | 0 | 0 | 24,124 | 4 | 24.0 s | Exact diff, scope and test passed |
| Explicit `--effort low` | [1](../investigations/worker-comparison/evidence/agy-low-effort-001.json) | 23,402 | 453 | 0 | 0 | 23,855 | 4 | 13.3 s | Exact diff, scope and test passed |
| Explicit `--effort low` | [2](../investigations/worker-comparison/evidence/agy-low-effort-002.json) | 23,382 | 427 | 0 | 0 | 23,809 | 4 | 32.3 s | Exact diff, scope and test passed |

The median reported total was 25,044 without an effort flag and 23,832 with
explicit low effort, a 1,212-token (4.8%) difference across two runs per
setting. Both low-effort runs reported zero thinking tokens and passed the same
test. This small sample supports offering `AGY_WORKER_EFFORT=low` as an opt-in
for bounded edits. It does not establish a general savings or justify changing
the default for harder tasks. The bridge applies that flag only to AGY Worker
turns; its tests cover the unchanged model argument and unchanged non-Worker
invocations. The evidence files record the requested model, actual reported
model, CLI version, response and session IDs, effort argument, tool lifecycle
updates, permission observations, reported usage, exact verified diff, and
validation result. Effort arguments and the renamed across-attempt task fields
were normalized from sanitized bridge invocation and preparation records after
capture; no raw CLI stream or credentials were copied into the repository.

## What the 109,676-token proof does and does not show

The earlier [automatic-path proof](automatic-path-smoke.md) reported 109,676
total tokens for a one-line README edit: 99,794 input, 9,882 output, 9,191
thinking, and zero cache read. It recorded 20 lifecycle updates representing
ten distinct file-tool steps, including one denied view. The older
[manual proof](three-harness-workflow.md) reported 18,726 total tokens, three
listed steps, and zero thinking. In the four new same-task runs, AGY took four
distinct file-tool steps with no permission denial and reported 23,809–25,964
total tokens. Its bridge reads the terminal CLI `result.usage`; collapsing
`ACTIVE`/terminal updates fixes the displayed tool-step count but cannot alter
that reported token total.

The high run's additional file actions, input, and thinking are observed, but
the old task and context differ from this trial. The records do not prove
whether extra tool turns, prompt context, CLI behavior, or another cause made
its input total high. AGY exposes neither an authoritative underlying provider
request count nor cost here. In these reports, total equals input plus output;
adding the separate thinking field again would double-count it.

## Reliability and bounds

Before the successful trials, a 60-second bridge turn reached CLI execution
but emitted no initialization event before SIGTERM. The bridge now reports a
missing initialization event accurately instead of calling it an unsafe tool
or wrong agent. A planned 110-second attempt failed before submission because
the comparison runner exceeded UHP's 120-second request-timeout bound; that
runner bug is fixed and covered by tests. Separate direct, read-only host CLI
diagnostics varied: one 3.8 Flash Low call returned `ERROR` with zero usage
after about 89 seconds, and a later call returned `SUCCESS` with zero usage
after about 107 seconds. These zero-usage replies were not accepted as Worker
results. They show startup/backend variability in this session, not a verified
provider fault. The successful Worker calls took 13–40 seconds, and the
comparison used a 110-second CLI limit.

**Recommendation:** retain AGY `gemini-3.8-flash-low` as the default Worker
harness and model. For bounded edits, operators can opt in to
`AGY_WORKER_EFFORT=low` and inspect Foreman's verified diff, validation,
reported usage, and tool trace. Keep the existing exact-path Worker policy and
110-second comparison bound; AGY `max_step` is ignored, so a CLI wall limit and
Foreman's independent verification remain the enforceable gates. Gemini CLI
was discarded for this investigation after its isolated attempts failed and
the operator's direct CLI greeting stalled for 2.5 minutes.
