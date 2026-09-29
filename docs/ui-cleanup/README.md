# UI cleanup browser evidence

The screenshots compare frozen baseline `b826f88` (served from `/tmp/foreman-ui-cleanup-baseline-b826f88`) with the final UI at `1655af6`. Each phase uses the same deterministic Atlas API fixture, viewport height (1050 px), opened usage dock, task data, run events, quota readings, and GitHub status. Screenshots use JPEG quality 80 with animation and transitions disabled. The app is served through Vite only; Playwright intercepts every `/api/**` request, including the event stream. No backend or live Planner, Worker, Reviewer, or provider is started.

The matrix covers four states (idle project, active validation, failed API contract validation, and awaiting human approval), three widths (1024, 1440, 1920), and dark/light themes. See [`checks.json`](./checks.json) for all 48 deduplicated page and scroll-container measurements, actual theme assertions, page errors, writes, focused keyboard probe results, and Open PR interaction checks. Intended center-panel vertical scrolling is allowed; the page and tested horizontal scroll containers have no horizontal overflow.

## 1440 px comparison

| State | Theme | Before | After |
|---|---|---|---|
| Idle project | Dark | [viewport](./before/idle-dark-1440-viewport.jpeg) | [viewport](./after/idle-dark-1440-viewport.jpeg) |
| Idle project | Light | [viewport](./before/idle-light-1440-viewport.jpeg) | [viewport](./after/idle-light-1440-viewport.jpeg) |
| Active run | Dark | [viewport](./before/active-dark-1440-viewport.jpeg) | [viewport](./after/active-dark-1440-viewport.jpeg) |
| Active run | Light | [viewport](./before/active-light-1440-viewport.jpeg) | [viewport](./after/active-light-1440-viewport.jpeg) |
| Failed validation | Dark | [failed check and output](./before/failed-dark-1440-center.jpeg) | [failed check and output](./after/failed-dark-1440-center.jpeg) |
| Failed validation | Light | [scrolled viewport](./before/failed-light-1440-viewport.jpeg) | [scrolled viewport](./after/failed-light-1440-viewport.jpeg) |
| Awaiting approval | Dark | [review controls](./before/approval-dark-1440-review.jpeg) | [review controls](./after/approval-dark-1440-review.jpeg) |
| Awaiting approval | Light | [review controls](./before/approval-light-1440-review.jpeg) | [review controls](./after/approval-light-1440-review.jpeg) |

The active fixture has one passed, one running, and one queued validation check plus Worker/Orchestrator progress events, so the Live Response activity and running phase are populated. The usage dock is open in each screenshot. The approval review images show the ready decision controls. Open PR is disabled in the default fixture, with a reason explaining that the result must first be promoted.

The complete 1024 and 1920 screenshot matrix is retained locally at `/tmp/foreman-ui-cleanup-width-matrix/{before,after}` for review; it is intentionally not part of the committed evidence to keep the docs compact. The linked 1440 viewport images show the same capture framing; the failed state also has a dedicated center-panel capture, and approval has dedicated center and GitHub panel captures.

## Interaction and accessibility checks

The browser interaction check exercises four promotion states. A matching but unpromoted task result is disabled; a promoted result with a missing remote branch is disabled; a different remote SHA is disabled; and a matching promoted remote branch enables Open PR and opens the existing confirmation dialog. The dialog was not submitted. All four checks recorded zero writes, and each matrix page independently recorded zero writes. The focus probe used Tab to focus the theme toggle in both themes and verified a visible solid 2 px `:focus-visible` outline. This is a targeted focus check, not a full keyboard traversal or accessibility audit.

Static token-pair contrast calculations supplied for the final stylesheet:

| Pair | Dark | Light |
|---|---:|---:|
| Text / surface | 14.87:1 | 12.63:1 |
| Dim / surface | 9.44:1 | 7.00:1 |
| Muted / surface | 6.33:1 | 4.76:1 |
| Semantic badge foreground / background (minimum) | 7.65:1 | 5.85:1 |
| Quota fill / rail | 6.33:1 | 4.76:1 |
| Focus ring / surface | 16.16:1 | 4.15:1 |

These are static token-pair calculations. They do not assess every rendered state, text size, overlay, or interaction and should not be read as a comprehensive WCAG audit.

## Reproduce

The harness is [`capture.mjs`](./capture.mjs), with fixture responses defined inline. It requires an external Playwright install and Chrome/Chromium; no project dependency or package file is changed. Set `PLAYWRIGHT_MODULE` to the external Playwright `index.mjs` path if it is not installed in this repository, and optionally set `CHROME_PATH` to a Chrome/Chromium executable. The harness uses `/usr/bin/google-chrome` when present, otherwise Playwright's installed browser.

Serve Vite from the baseline tree and working tree on separate ports, without starting the backend. Then capture either phase by setting `BASE_URL`, `SCREEN_DIR`, and `METRICS_PATH`; `THEMES`, `WIDTHS`, and `STATES` can filter the matrix. Set `RUN_INTERACTION_CHECKS=1` to additionally run the Open PR gate and focus probes. All API requests are stubbed by the harness. Example for the working tree:

```sh
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
BASE_URL=http://127.0.0.1:5174/ \
SCREEN_DIR="$PWD/docs/ui-cleanup/after" \
METRICS_PATH=/tmp/foreman-ui-cleanup/after.jsonl \
RUN_INTERACTION_CHECKS=1 node docs/ui-cleanup/capture.mjs
```
