# Foundation decisions

| Decision | Reason | Current limit |
| --- | --- | --- |
| One Node service for REST, SSE, and the built React UI | Keeps local setup and identity boundaries simple. SSE carries one-way event updates; no demonstrated need for WebSockets. | No remote multi-user access design. |
| Serialized, atomically replaced JSON state | A small one-operator foundation can persist intent, IDs, hierarchy, and events without a database deployment. | Scale and power-loss durability need a later storage review. |
| UHP adapter with live capability and configured-model discovery | The controller must reject unavailable choices and gate idempotent retries on the server's advertised capability. | A pinned HarnessRouter CE probe is installed, but it has no configured harness. Its complete workspace export behavior is unverified. |
| Planner and Orchestrator session chains stay separate from Project identity | UHP sessions may expire or rotate while a project and its memory bank remain continuous. | Only returned UHP IDs, not local placeholders, prove a live session exists. |
| Hindsight is advisory | Memory may inform a role turn, but Git and observed checks decide acceptance. | A Hindsight outage appears as degraded and does not block workflow persistence. |
| Exact workspace bridge is a gate | Artifact lists do not prove deletions, modes, symlinks, ignored paths, or all edits. The local Git verifier reads a pinned commit and checks every changed path and byte in a supplied complete result. | The experimental host bridge proved a bounded local run, which the operator later approved. A portable UHP or HarnessRouter complete snapshot export tied to that base remains unverified. |
