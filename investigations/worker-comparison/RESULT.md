# Bounded Gemini CLI and AGY Worker comparison

This records the original one-off Gemini attempt. The operator later discarded
Gemini CLI for the Worker path. Four subsequent same-task AGY Worker turns
completed through Foreman; see the [AGY usage follow-up](../../docs/agy-worker-usage-followup.md).

## Outcome on 2026-09-23

The identical task was prepared, but the comparison produced **no model-side
measurement**. The one Gemini UHP submission failed in the temporary bridge's
outside-workspace sentinel probe, before the Gemini CLI process started. Its
sanitized boundary diagnostic was `runtime_path_unavailable` (exit 1). The
durable one-call lock prevented a retry. The AGY invocation was skipped under
the predeclared rule to stop after a failed Gemini attempt. No provider call,
model response, usage report, or verified diff came from this comparison.

| Item | Gemini CLI Flash | AGY Flash |
| --- | --- | --- |
| Requested model | `gemini-3.5-flash` | `gemini-3.8-flash-low` |
| Installed CLI version | 0.60.0 | 1.2.9 |
| Pinned base | `f90af92ee2ef7261983215e77b66e2aeb4bf56b5` | Same |
| UHP submissions / CLI invocations | 1 / 0 | 0 / 0 |
| Response / session | `resp_64510ecd-21a2-43f4-b8a2-14cca62f8093` / unavailable | unavailable |
| Boundary and permission outcome | Foreman sentinel probe failed before CLI spawn; no tool permissions reported | Not attempted |
| Observed model, tool steps, input/output/thinking/cache/total usage | Unavailable | Unavailable |
| Exact verified diff / validation | None; snapshot verification and `pnpm test` were not reached | Not attempted |

Both separately seeded workspaces had the same 292-byte [task](TASK.txt),
the same pinned base, the same allowed paths (`src/label.ts` and
`test/label.check.ts`), and the same configured Foreman `pnpm test` validation.
The task asks for a small TypeScript return-value change and a matching real
test assertion. The disposable fixture's baseline test passed. A model-call-free
Gemini 0.60.0 `--version` run inside an equivalent isolated package mount
passed, with the outside sentinel unchanged. That did not prove the complete
bridge runtime mount used for a Worker turn; the Worker submission's stricter
probe is the recorded failure. The [sanitized attempt record](evidence/gemini-cli.json)
contains the response, workspace, lock, and timing evidence; raw CLI output
and credentials are absent.

The host's Gemini CLI currently selects API-key authentication for testing.
The one-off permission to invoke that already configured CLI did not authorize
copying, probing, or injecting its key. The temporary bridge used an isolated
home and never reached CLI execution, so this attempt cannot establish whether
the configured authentication would work inside the required boundary.
The experimental adapter and a small UHP client compatibility patch lived only
in `/tmp` and ignored build output for this attempt. They are not included as
production code in this PR. The checked-in runner and fixture record the exact
bounded task and evidence shape; reproducing the attempt requires a compatible
temporary bridge plus fresh authorization for any live call.
Foreman's production bridge still has no proven narrow host-login path for
Gemini CLI; the [investigation](../../docs/gemini-cli-worker-investigation.md)
records the exact authentication and isolation gaps. It was not made a
selectable production Worker.

The historical AGY Worker proofs reported 18,726 and 109,676 total tokens on
different tasks. The 109,676-token run reported ten distinct tool steps and
9,191 thinking tokens; the 18,726-token proof summary listed three steps and
zero thinking tokens. These observations do not isolate the cause of the
larger report. No CLI comparison tokens are available here, and even a future
successful run would need to keep AGY and Gemini CLI accounting separate:
the requested Flash model IDs differ, their system prompts differ, and neither
CLI exposes an authoritative provider-request count or cost.

**Original recommendation:** keep AGY as the existing default Worker. The
operator later lifted the one-call rule and discarded Gemini CLI. Follow-up
AGY trials are recorded separately in the linked usage report; this original
Gemini attempt remains an unsuccessful comparison record.
