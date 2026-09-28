# Working-tree structural review — 2026-09-27

Scope: user-requested independent review of the uncommitted automatic-tracking
patch, via `contour_review` against the working tree (13 changed source files).

- Report id: `1e4041ddc13cb1d49f29b1e13ff15d822a01111cefcf2765a806eaa72be10963`
- Baseline → snapshot: `2721e1aeec1c314b7cbdc249888fbfece46aedd1` → `12e074f9f9c29dd7c1d43608709a8aa4c6f36f62f29945f51e3476b293736de3`
- Initial result: 5 advisory findings, 0 policy violations.

## Findings and dispositions

| Finding | Disposition |
| --- | --- |
| `report.ts` `eachPart` exact-token clone (2 copies) | **Fixed.** One `reportDayVisitor` helper now owns calendar partitioning and since-day filtering for both report builders. |
| `buildWorkReport` / `buildAutomaticReport` decision load | **Inspected; two real total defects fixed, no restructure for the metric.** (a) The scoped all-dates agent union (`groups[allAgent]`) had been dropped by the patch — restored, so the notes line keeps its since-day-independent union. (b) The automatic summary mixed since-day-filtered windows from every timezone into one number — now computed per timezone. Remaining branching is receipt/calendar/evidence semantics and is retained. |
| `AutomaticClock.touch` decision load (0 → 20) | **Retained.** The branches enforce first-signal zero-length windows, client/task snapshot boundaries, the idle-cutoff, backward-clock rejection and checkpoint policy; `automatic.test.ts` covers each. |
| `createTimeTrackingExtension` decision load (4 → 12) | **Retained; two boundary defects fixed.** `session_before_switch` is cancellable by another extension (Pi's installed `agent-session-runtime.js` returns without shutdown or a new start on a veto), so teardown no longer happens there: a vetoed switch keeps capturing and confirmed teardown waits for `session_shutdown`. Terminal input now also enforces the explicit adapter/root boundary, not just the resolved workspace. Command registration and config-validation branching retained. |

## Reproduced failures (red → green)

New regressions in `report.test.ts` and `automatic-extension.test.ts` reproduced five defects before the fixes; all pass after:

1. All-dates agent union rendered `0.00 h` (lost `groups[allAgent]` fill).
2. Automatic summaries mixed timezone totals (UTC showed Manila's window).
3. Gap-only dates rendered a measured `0.00 h` instead of Unknown.
4. A cancelled session switch stopped all capture (teardown on a cancellable event).
5. Terminal input escaped an explicit adapter root when the session cwd moved to a sibling directory.

## Verification

- Baseline before review: `bun run check && bun run test` → 46 pass / 0 fail / 257 assertions / 12 files.
- Red probes before fixes: `bun test report.test.ts automatic-extension.test.ts` → 6 pass / 5 fail.
- After fixes, targeted: `bun run check` clean; `bun test report.test.ts automatic-extension.test.ts recovery.test.ts automatic.test.ts project-store.test.ts loader.test.ts` → 28 pass / 0 fail / 133 assertions.
- Full suite after fixes:  0 fail ·  276 expect() calls · Ran 52 tests across 13 files. [4.69s]
- `git diff --check` clean; no SQLite/JSONL data files in the patch; the loader test confirms `/work`, `/project` and `work_note` registrations.

## Limitations

- Contour models JS/TS syntax and exact-token clones only; it makes no type-checking,
  behavioral-equivalence or test-adequacy claim and does not certify correctness.
  Native Bend behavior rests on the native test suite, not on Contour.
- Coverage gaps at review time: `receipt-audit.test.ts:76` (computed import target not
  modeled); 72 unresolved imports were not modeled.
- This is not a live-session (herdr) verification; lifecycle evidence is the simulated
  harness plus Pi's installed runtime source.
- At this review checkpoint the tracker extension was not installed or reloaded. Live IDE verification below concerns the inspection tool, not tracker activation.

## Live Steroid file-level inspection — 2026-09-27 UTC

After the approved Jackson repair install/restart, Steroid `0.102.19999-SNAPSHOT-c68d8f1` executed successfully on IntelliJ `IU-263.5701.42`.

Execution: `eid_20260927T162623-666-pi-time-tracker-d-steroid-jackson-live-validation`. Inspected `automatic.ts`, `project-store.ts`, `extension.ts`, `report.ts`, `automatic.test.ts`, `project-store.test.ts`, `automatic-extension.test.ts`, and `report.test.ts`. All eight resolved as TypeScript and completed with empty `failedTools`. No quick fixes or source edits applied.

| Advisory | Disposition |
| --- | --- |
| `automatic.ts:21`, field `last` can be readonly | Valid low-priority immutability suggestion; deferred. It is assigned only in the constructor and this inspection request does not require a source cleanup. |
| `project-store.ts:42`, exception caught locally | Intentional: constructor catch closes the database and rethrows on initialization/version rejection (`:54`). Removing cleanup would leak the handle. |
| `automatic-extension.test.ts:16,19`, unused `getSessionId` / `onTerminalInput` | Rejected false positives: test-context callbacks are consumed by `extension.ts:114,132,150,179`, with runtime coverage from the harness. |

Coverage limitation: IntelliJ reports **no content roots**. These are file-level inspection results, not proof of complete cross-file indexing or project-wide cleanliness. Project-module configuration remains deferred; compiler/tests remain the type and behavioral gates.

Verification after restart: pre/post tracker file hashes identical before updating this record; `bun run check` passes; `bun test automatic.test.ts automatic-extension.test.ts project-store.test.ts report.test.ts` → **21 pass, 0 fail, 93 assertions**. Full suite was not rerun because no tracker source changed. The separate inspection-tool repair and its machine-local backup are outside this tracker patch.
