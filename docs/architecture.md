# Foundation architecture

Foreman runs one local Node service. A durable JSON state file holds projects, tasks, runs, role configuration, assignments, guidance, validation, review, approval, and append-only event records. Each mutation is serialized and atomically renamed into place. The React UI reads that persisted state and receives events over SSE. UHP and Hindsight are adapters at the service boundary; neither owns Foreman's project identity or canonical Git truth.

## Control flow

1. The operator creates a persistent project, task, and run, then speaks to the Planner. The Planner is the only primary chat surface.
2. The Planner and Orchestrator use separate UHP session chains. Foreman records each response and session ID so a session may continue or rotate without replacing the project. A rotation changes the UHP conversation identity; project memory and accepted Git state remain attached to the project.
3. The Orchestrator proposes bounded Worker assignments. Foreman validates the requested harness/model against live discovery, persists the submission intent and idempotency key, then sends UHP work. Workers are inspectable but are not direct operator chat targets.
4. New operator guidance is assigned a monotonic sequence. While a Worker is active, it waits in the durable queue. At a defined checkpoint, the Orchestrator acknowledges whether it applied the guidance, needs to replan, or is waiting. Invalidated Worker work is cancelled and revised explicitly.
5. A Reviewer independently examines proposed changes and evidence. Foreman must independently verify the exact Git result and configured validation before a human approval can accept changes. A Reviewer response alone cannot mutate canonical Git state.

## Authority and failure behavior

Agent prose is evidence or a proposal, not a state transition by itself. Git commits, exact workspace snapshots, and controller-observed checks are authoritative for code acceptance. Hindsight recall is bounded and advisory. If Hindsight is unavailable, memory status degrades visibly while ordinary run state and validation remain available. Usage is represented as measured only when reported by UHP; missing token, cost, or quota fields remain unavailable.

The first foundation does not claim the Worker workspace to canonical Git acceptance bridge is complete. [The bridge report](workspace-bridge.md) records the file cases and the required complete snapshot contract.
