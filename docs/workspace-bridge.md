# Workspace bridge investigation

Status: **runtime bridge is unproven**. HarnessRouter version used: **none; no local router available**. This checkout does not have a `harnessrouter` executable, local HarnessRouter source, or a reachable local HarnessRouter instance. The machine-level lookup (`command -v harnessrouter` / `command -v harness-router`) and a read-only search under `/home/chris` found none. The operator also checked that no HarnessRouter or Hindsight Docker container was running and that ports 8787, 3000, 8000, and 8888 had no listener; Gemini CLI is present. No task was sent to a provider. The results below separate the published HTTP contract from behavior that still needs an isolated live fixture or a locally installed router.

## What the available contracts expose

| Surface | Published behavior | Workspace change capture |
| --- | --- | --- |
| Portable UHP | Discover configured harnesses and per-harness models; submit Responses-compatible tasks; stream progress; retrieve responses, sessions, and session files; upload inputs; cancel tasks. | UHP's file surface returns every **artifact** of a session. It does not define checkout selection, a base commit, a complete workspace tree/snapshot, a changed-path manifest, or a diff. Treat returned artifacts as outputs, not as proof of all workspace edits. |
| HarnessRouter API | HarnessRouter documents its API at `/api/harness/v1` for CE and describes per-session workspaces, files and artifacts. Its standard UHP routes add the same response, session, streaming, file and cancel lifecycle. | Public docs inspected here describe files/artifacts and real workspaces, but no supported complete snapshot or diff endpoint. An implementation-private route or direct access to `/data/workspaces` is not an acceptable bridge contract. Runtime path, file visibility and completeness remain unverified on this machine. |
| Proposed UHP snapshot extension | No such endpoint or capability was found in the published UHP API map reviewed for this work. | A portable extension would need to be explicitly advertised, versioned, and contract tested. Suggested contract is a session-scoped base snapshot plus a post-run complete manifest. Every entry carries relative path, kind, mode, size, and content or a content-addressed download handle; symlinks carry their link target. The base reference is an immutable commit/tree ID. It must state how inaccessible or oversized entries are reported and fail closed if the snapshot is incomplete. |
| Complete snapshots diffed locally | Foreman's comparison can compare a complete before snapshot with a complete after snapshot, pinned to the same base. | The independent pure snapshot comparison fixture covers additions, modifications, deletions, identical-content renames, binary data, executable mode changes, symlinks, dotfiles, and `AGENTS.md`. This proves comparison behavior for fixture entries only. It does not prove a harness can export a complete snapshot, preserve metadata, or report all edits. |

## File-case evidence matrix

“No guarantee” means the API does not promise that case in a complete workspace snapshot. It is not a claim that HarnessRouter cannot perform the change internally.

| Case | Portable UHP artifacts | HarnessRouter documented artifact API | Complete snapshot comparison fixture |
| --- | --- | --- | --- |
| Added file | No complete-tree guarantee | Output artifact retrieval is documented; all added workspace paths are not promised | Covered |
| Modified file | No before/after content contract | No complete before/after snapshot contract | Covered |
| Deleted file | No deletion manifest | No deletion manifest documented | Covered |
| Renamed file | No old-path/new-path contract | No rename contract documented | Covered for identical content; heuristic remains local |
| Binary file | Artifact download can carry file bytes; no workspace-wide binary changeset | Artifact download is documented; complete changed binary set is not | Covered as bytes |
| Executable bit | No complete mode manifest | No complete mode manifest documented | Covered |
| Symlink | No symlink entry contract for a complete tree | No complete symlink manifest documented | Covered |
| Dotfile | No complete-tree visibility promise | No complete-tree visibility promise | Covered |
| `AGENTS.md` / instruction file | May be an artifact only if returned; no guarantee every changed instruction file is enumerated | No guarantee every changed instruction file is enumerated | Covered |

## Contract sources and next verification

- [UHP Harnesses](https://unifiedharnessprotocol.org/spec/2026-09-12/harnesses) defines scoped harness discovery and per-harness available model discovery.
- [UHP Tasks](https://unifiedharnessprotocol.org/spec/2026-09-12/tasks), [Streaming](https://unifiedharnessprotocol.org/spec/2026-09-12/streaming), and [Files](https://unifiedharnessprotocol.org/spec/2026-09-12/files) define task IDs/session IDs, terminal states, idempotency, event streams, uploads, and the session artifact list/archive. The Files chapter describes artifacts, not a full workspace tree.
- The [HarnessRouter Community Edition repository](https://github.com/HarnessRouter/harnessrouter) documents its `/api/harness/v1` Responses-compatible routes, session continuation, streaming, file upload/output retrieval and cancellation. The [workspace docs](https://www.harnessrouter.ai/docs/workspace) state that API keys, configured agents, sessions and returned files are scoped to a workspace. Neither source inspected here specifies a full workspace snapshot API.
- [Hindsight bank creation](https://docs.hindsight.vectorize.io/api-reference/create-or-update-bank/), [recall](https://docs.hindsight.vectorize.io/recall/), and [retain](https://docs.hindsight.vectorize.io/retain/) provide the project-bank provisioning and memory operations used by the adapter.

Before treating this bridge as established, install/pin a HarnessRouter build and run deterministic workspace tasks against a disposable fixture repository. Record the router image/version and prove both the returned manifest and bytes for every row above, including that a non-returned artifact cannot hide a workspace change. The tests in this repository are not that runtime proof.

## Proposed smallest sound bridge

For a router without a full snapshot contract, use an explicit runtime-side bridge that emits a complete, bounded manifest from the task's actual workspace before and after execution. Pin the start snapshot to a base commit; keep binary bytes and filesystem modes; represent symlinks without dereferencing them; include ignored/untracked paths, dotfiles, and instruction files. Return an explicit incomplete/error result when any path could not be read. Store and compare the returned snapshot in Foreman. Keep the manifest/diff contract behind a capability or adapter so portable UHP servers that do not implement it report “workspace comparison unavailable” instead of implying a clean diff.

This is a recommendation from the contract gap, not a verified HarnessRouter feature. Do not implement it by scraping the CE container's internal workspace paths: that would couple Foreman to one deployment's private layout and bypass the API's authorization boundary.
