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

AGY reported 109,676 total tokens for its one Worker turn, despite the trivial
README edit. A sanitized bridge diagnostic showed repeated allowed file-tool
actions and one permission-denied initial `view_file` before a later successful
edit. The cause of the high usage is unproven; no provider cost is inferred.

A read-only Chrome UI check confirmed that the Planner conversation, controller
`awaiting_approval` state, Reviewer recommendation, and pending human decision
were visible in Foreman. This inspection did not approve the run or promote
Git.

The reported checks passed: Foreman 77/77, bridge 37/37, typecheck, and build.
These are separate from the four live CLI turns. The machine-readable role,
session, usage, diff, verification, validation, and decision record is
[automatic-path-smoke-20260923.json](evidence/automatic-path-smoke-20260923.json).
