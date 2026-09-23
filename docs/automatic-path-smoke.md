# Live automatic-path smoke

On 2026-09-23, Foreman completed one live bounded automatic run on disposable
run `run_f18b066c-a7f1-467c-a16b-05b294fb61c9`, pinned to
`12a4c2821c60a1173f7232312e91b483a49bd147`. The controller made exactly one
successful turn for each role, in order: Planner, Orchestrator, Worker, and
Reviewer. The run ended at `awaiting_approval`; approval and Git promotion are
null. No human decision or promotion was made.

| Role | Selected harness/model | Observed model | Response ID | Session ID | Reported usage |
| --- | --- | --- | --- | --- | --- |
| Planner | Codex CLI / `gpt-6-sol` | Unavailable | `resp_2f1db5fe-afde-4c04-a402-c53d5f4fa595` | `01a0ce3a-377d-7261-a1ca-c734ac771ca7` | Input 13,861; output 163; cached input 11,776 |
| Orchestrator | Codex CLI / `gpt-6-sol` | Unavailable | `resp_ca2074fd-ad04-42aa-9a90-4a606d29fa73` | `01a0ce3d-0046-76f3-9842-bb206fdc78ab` | Input 14,021; output 57; cached input 11,776 |
| Worker | AGY / `gemini-3.8-flash-low` | `gemini-3.8-flash-low` | `resp_e43983b7-dd56-47db-b0d0-8aa5b89d0a20` | `87f6e616-aadb-48fc-9dfa-5ee8edafa027` | Input 99,794; output 9,882; total 109,676; thinking 9,191; cached input 0 |
| Reviewer | Claude Code / `sonnet` | `claude-sonnet-5` | `resp_7ac8c26a-a8b4-4a0f-a1b7-170413e9db05` | `b3eacadf-0819-42fc-a4d2-ba838a7b0aa3` | Input 2; output 934; cached input 3,397 |

Foreman verified a complete one-entry Worker snapshot against the pinned base.
The only permitted and changed path was `README.md`. The exact addition was:

```diff
+AGY Flash completed this automatic-path smoke.
```

Foreman's configured `grep -Fx` check passed with exit code 0 and output the
expected line. The Orchestrator receipt is
`oinbox_ca6abacf-d08c-4dc4-b113-b57816693eff`; its evidence digest is
`34370b4b04653a2f1c0224208517c6a12fe9000d90c2713589907547197b855c`. Claude's
read-only Reviewer recommended the change and reported no mutation attempt.

The live call count was four successful role submissions: two Codex CLI, one
AGY, and one Claude Code. AGY's high reported usage is reproduced exactly
above. Codex's observed model was unavailable. Cost and underlying provider
request count were unavailable; neither is inferred from the Foreman call
count.

AGY reported 109,676 total tokens for the one Worker CLI invocation
(99,794 input; 9,882 output; 9,191 thinking; zero cached). This is much higher
than the earlier comparable AGY Worker proof, which reported 18,726 total
(18,442 input; 284 output). The earlier task and result are recorded in
[three-harness-workflow.md](three-harness-workflow.md). The current task was a
one-line `README.md` edit on `gemini-3.8-flash-low`.

The sanitized diagnostic contained 20 `step_update` records representing 10
distinct tool steps: six `view_file` steps (one denied), one
`replace_file_content`, and three `write_to_file` steps. AGY emits `ACTIVE` and
terminal updates for the same `step_index`. Before this correction Foreman
counted each update as an action; the bridge now collapses lifecycle updates by
sanitized step index and tool name, retaining the latest outcome. The earlier
proof's checked-in summary records three tool steps as `view_file`,
`replace_file_content`, and `view_file`; its raw tool metadata is not included
here. This explains the inflated diagnostic action count, but does not explain
the reported tokens. The latest diagnostic
also recorded an initial `view_file` step that was denied before a later
`view_file` succeeded; the denial's cause is unknown.
AGY documents execution mode (`--mode=accept-edits`) separately from tool
permission mode (`init.permission_mode=request-review`), so those values do not
establish a bridge policy mismatch. Its permissions documentation says
`read_file(/workspace)` grants recursive access to files beneath that path;
the observed denial therefore does not establish a mount defect. See the
[headless CLI event format](https://antigravity.google/docs/cli/headless/) and
[AGY permissions](https://antigravity.google/docs/permissions?tab=cli).

The bridge supplies a private `/workspace` mount and generated
`foreman-worker` profile with only the file tools needed for exact named paths;
host AGY credentials remain read-only. The task prompt also prohibits directory
enumeration and shell commands. The evidence establishes repeated tool
lifecycle events and one denied read, but does not establish whether the
remaining file actions were avoidable prompting, model/CLI behavior, or another
cause. AGY's terminal `result.usage` is the reported usage for this invocation;
one CLI invocation does not establish one provider request. The bridge has no
reliable AGY token or step limit: its timeout bounds wall time, while current
per-run limits count CLI turns and Worker attempts, and `max_step` is ignored.
Token totals do not establish monetary cost. The usage difference and its cause
remain unresolved.

A read-only Chrome UI check confirmed that the Planner conversation, controller
`awaiting_approval` state, Reviewer recommendation, and pending human decision
were visible in Foreman. This inspection did not approve the run or promote
Git.

The reported checks passed: Foreman 77/77, bridge 37/37, typecheck, and build.
These are separate from the four live CLI turns. The machine-readable role,
session, usage, diff, verification, validation, and decision record is
[automatic-path-smoke-20260923.json](evidence/automatic-path-smoke-20260923.json).
