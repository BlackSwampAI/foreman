# Foundation decisions

| Decision | Reason | Current limit |
| --- | --- | --- |
| One Node service for REST, SSE, and the built React UI | Keeps local setup and identity boundaries simple. SSE carries one-way event updates; no demonstrated need for WebSockets. | No remote multi-user access design. |
| Serialized, atomically replaced JSON state | A small one-operator foundation can persist intent, IDs, hierarchy, and events without a database deployment. | Scale and power-loss durability need a later storage review. |
| UHP adapter with live capability and configured-model discovery | The controller must reject unavailable choices and gate idempotent retries on the server's advertised capability. | A pinned HarnessRouter CE probe is installed, but it has no configured harness. Its complete workspace export behavior is unverified. |
| Planner and Orchestrator session chains stay separate from Project identity | UHP sessions may expire or rotate while a project and its memory bank remain continuous. | Only returned UHP IDs, not local placeholders, prove a live session exists. |
| Hindsight is advisory | Memory may inform a role turn, but Git and observed checks decide acceptance. | A Hindsight outage appears as degraded and does not block workflow persistence. |
| Exact workspace bridge is a gate | Artifact lists do not prove deletions, modes, symlinks, ignored paths, or all edits. The local Git verifier reads a pinned commit and checks every changed path and byte in a supplied complete result. | The experimental host bridge proved a bounded local run, which the operator later approved. A portable UHP or HarnessRouter complete snapshot export tied to that base remains unverified. |

## Dated decisions (2026-09)

**2026-09: Overrides-only role configs.** Project and run role-config records store only the choices explicitly set at that scope. Unset roles inherit from the scope above (run → project → global). Discovery does not overwrite saved choices. This keeps config stable across rediscovery while allowing reset to inherited at any level.

**2026-09: `targetFiles` contract for Worker proposals.** The Orchestrator must return `{"workerTask":"...","targetFiles":["relative/path",...]}`. Scope is enforced against `targetFiles` before dispatch. This replaces prose path heuristics. The post-run snapshot diff remains the authority for what actually changed.

**2026-09: Incremental corrections overlay prior verified changes.** When a Worker correction is triggered by validation failure or Reviewer feedback, the new Worker workspace is seeded from the pinned base and the previous attempt's verified changes are overlaid. The correction Orchestrator prompt notes that the workspace already contains the prior changes so the Worker only needs to describe additional edits. Transport-failure retries start from the clean base instead.

**2026-09: Read-only repository access for Planner and Orchestrator.** Planner and Orchestrator receive a read-only snapshot of the repository in their working directory (Claude Code or Codex) or a deterministic digest (Antigravity CLI or snapshot unavailable). The digest includes the file tree, package.json summary, README excerpt, and rarity-weighted keyword hits, sized from the prompt budget left after the mandatory prompt parts and capped at 12 KB (the file tree is truncated to fit; below ~1.5 KB the digest is omitted and `repoAccess.reason` says so). A `repoAccess` badge records which mode was used. This replaces the earlier "You cannot access the repository filesystem" constraint.

**2026-09: CI-parity checks via repository inspection.** When a repository is opened, Foreman parses `.github/workflows` for `pnpm`/`npm`/`yarn` script invocations (excluding publish, release, deploy, staging steps) and suggests matching package scripts for the validation commands list (`source: 'ci'`). A `ciChecksNotConfigured` warning in the task start preview lists remote CI checks with no local equivalent.

**2026-09: State trimming and SSE push.** `/api/state` omits binary file contents from Worker evidence (full payload on demand via `/api/runs/:id/evidence`) and trims high-volume `assignment.progress` and `assignment.reconciled` events to the most recent 200. SSE pushes new events on each store mutation rather than polling. Project delete removes bridge state and work directories in addition to the project record and its events.
