# Foundation decisions

| Decision | Reason | Current limit |
| --- | --- | --- |
| One Node service for REST, SSE, and the built React UI | Keeps local setup and identity boundaries simple. SSE carries one-way event updates; no demonstrated need for WebSockets. | No remote multi-user access design. |
| Serialized, atomically replaced JSON state | A small one-operator foundation can persist intent, IDs, hierarchy, and events without a database deployment. | Scale and power-loss durability need a later storage review. |
| UHP adapter with live capability and configured-model discovery | The controller must reject unavailable choices and gate idempotent retries on the server's advertised capability. | HarnessRouter runtime and its workspace export behavior are unverified locally. |
| Planner and Orchestrator session chains stay separate from Project identity | UHP sessions may expire or rotate while a project and its memory bank remain continuous. | Only returned UHP IDs, not local placeholders, prove a live session exists. |
| Hindsight is advisory | Memory may inform a role turn, but Git and observed checks decide acceptance. | A Hindsight outage appears as degraded and does not block workflow persistence. |
| Exact workspace bridge is a gate | Artifact lists do not prove deletions, modes, symlinks, ignored paths, or all edits. | Human code acceptance remains blocked until a complete snapshot tied to the pinned Git base is verified. |
